-- ============================================================================
-- M4 — owner_capital_flows (Etapa 1)
--
-- Saca del P&L los flujos de capital del propietario. La RECLASIFICACIÓN
-- histórica de los BFE (salary/sueldo_dueno, salary/retiros, fixed_cost_personal
-- → owner_withdrawal) ya la realizó el backfill determinístico de M3
-- (bfe_economic_class R6/R8/R9). Esta migración agrega:
--   1. owner_withdrawals.flow_type ('withdrawal' | 'contribution') — aditivo,
--      default 'withdrawal' para el histórico (todo lo existente son retiros).
--   2. create_owner_contribution — aporte del dueño (personal → negocio) con
--      ownership, idempotencia, dos patas vinculadas, moneda explícita y SIN
--      BFE de ingreso operativo (nunca aparece como venta).
--
-- El bloqueo de NUEVOS retiros/sueldo-dueño/gastos-personales como "gasto
-- operativo manual" en el Panel Financiero se implementa en el frontend
-- (financeService: se remueven esas categorías del catálogo de gasto y se
-- redirige al flujo de retiro). Ver Fase 9.
-- ============================================================================

-- ── 1. flow_type ─────────────────────────────────────────────────────────────
ALTER TABLE "public"."owner_withdrawals"
  ADD COLUMN IF NOT EXISTS "flow_type" text NOT NULL DEFAULT 'withdrawal';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='owner_withdrawals_flow_type_check') THEN
    ALTER TABLE "public"."owner_withdrawals"
      ADD CONSTRAINT "owner_withdrawals_flow_type_check" CHECK ("flow_type" IN ('withdrawal','contribution'));
  END IF;
END $$;

COMMENT ON COLUMN "public"."owner_withdrawals"."flow_type" IS
  'withdrawal = retiro (negocio→dueño, −capital). contribution = aporte '
  '(dueño→negocio, +capital). Ambos son movimientos de capital, nunca P&L.';

-- ── 2. create_owner_contribution ────────────────────────────────────────────
-- Espejo de create_owner_withdrawal (Etapa 0), dirección inversa:
--   personal_transaction EXPENSE (sale de la cuenta personal)
--   financial_movement INCOME al negocio, source='owner_contribution' (capital,
--     NO venta) — SIN BFE (jamás se muestra como ingreso operativo).
CREATE OR REPLACE FUNCTION "public"."create_owner_contribution"(
  "p_business_id" uuid, "p_amount" numeric, "p_date" date, "p_account_id" uuid, "p_notes" text DEFAULT NULL
) RETURNS jsonb
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user_id       uuid := auth.uid();
  v_date          date := COALESCE(p_date, public.ar_today());
  v_is_authorized boolean := false;
  v_acc           personal_accounts%ROWTYPE;
  v_has_ars_row   boolean := false;
  v_tx_id         uuid;
  v_fm_id         uuid;
  v_wd_id         uuid;
BEGIN
  IF v_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'No autenticado'); END IF;
  IF p_amount IS NULL OR p_amount::text IN ('NaN','Infinity','-Infinity') OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El monto debe ser mayor a cero'); END IF;

  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user_id)
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND COALESCE(user_id,id)=v_user_id AND COALESCE(is_active,true) AND role IN ('owner','admin'))
  ) INTO v_is_authorized;
  IF NOT v_is_authorized THEN RETURN jsonb_build_object('ok', false, 'error', 'Sin permiso para registrar aportes en este negocio'); END IF;

  SELECT * INTO v_acc FROM personal_accounts WHERE id=p_account_id AND user_id=v_user_id AND is_active=true FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'Cuenta personal no encontrada o no activa'); END IF;

  SELECT EXISTS (SELECT 1 FROM personal_account_balances WHERE account_id=p_account_id AND user_id=v_user_id AND currency='ARS') INTO v_has_ars_row;
  IF NOT v_has_ars_row AND COALESCE(v_acc.currency,'ARS')<>'ARS' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'La cuenta origen no opera en ARS.'); END IF;

  -- 1. Pata personal: EGRESO (sale del bolsillo del dueño)
  INSERT INTO personal_transactions (user_id, account_id, type, amount, currency, date, description, notes)
  VALUES (v_user_id, p_account_id, 'expense', p_amount, 'ARS', v_date, 'Aporte al negocio', p_notes)
  RETURNING id INTO v_tx_id;

  PERFORM personal_update_currency_balance(p_account_id, 'ARS', -p_amount);

  -- 2. Pata negocio: INGRESO de caja como CAPITAL (source='owner_contribution').
  --    SIN BFE → nunca aparece como venta/ingreso operativo.
  INSERT INTO financial_movements (business_id, type, amount, amount_ars, currency, exchange_rate,
    source, source_id, description, date, created_by, reference_type, sign, movement_type)
  VALUES (p_business_id, 'income', p_amount, p_amount, 'ARS', 1,
    'owner_contribution', NULL,
    'Aporte del propietario' || CASE WHEN p_notes IS NOT NULL THEN ': '||p_notes ELSE '' END,
    v_date, v_user_id, 'owner_contribution', 1, 'income')
  RETURNING id INTO v_fm_id;

  -- 3. Vínculo (dos patas), flow_type='contribution'
  INSERT INTO owner_withdrawals (business_id, user_id, amount, currency, date,
    business_financial_movement_id, personal_transaction_id, destination_account_id, notes, status, flow_type)
  VALUES (p_business_id, v_user_id, p_amount, 'ARS', v_date, v_fm_id, v_tx_id, p_account_id, p_notes, 'completed', 'contribution')
  RETURNING id INTO v_wd_id;

  UPDATE financial_movements SET source_id=v_wd_id WHERE id=v_fm_id;

  RETURN jsonb_build_object('ok', true, 'contribution_id', v_wd_id, 'personal_tx_id', v_tx_id, 'business_fm_id', v_fm_id);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

ALTER FUNCTION "public"."create_owner_contribution"(uuid, numeric, date, uuid, text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."create_owner_contribution"(uuid, numeric, date, uuid, text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."create_owner_contribution"(uuid, numeric, date, uuid, text) TO "authenticated", "service_role";

-- ============================================================================
-- ROLLBACK (documentado): DROP FUNCTION create_owner_contribution(...);
--   ALTER TABLE owner_withdrawals DROP CONSTRAINT owner_withdrawals_flow_type_check;
--   ALTER TABLE owner_withdrawals DROP COLUMN flow_type;
--   (la reclasificación de economic_class de M3 se revierte con el rollback de M3)
-- ============================================================================
