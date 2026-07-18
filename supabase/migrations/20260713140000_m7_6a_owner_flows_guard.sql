-- ============================================================================
-- M7 (Bloque 6A) — Integración del guard de período + auditoría en los flujos
-- de capital del propietario: create_owner_withdrawal / create_owner_contribution
--
-- Cambios (idénticos en ambas, direcciones opuestas):
--   - Autorización SIN cambios: owner del negocio o perfil activo con
--     role IN ('owner','admin'). NINGÚN rol nuevo (technician/sales/cashier/viewer
--     siguen SIN permiso). Ownership/cross-tenant separado de la autorización.
--   - Fecha económica única: v_economic_date := COALESCE(p_date, ar_today());
--     se persiste en TODAS las patas (personal_tx, FM, owner_withdrawals) y es la
--     fecha que se audita. El parámetro nulo no se reutiliza tras normalizar.
--   - Guard de período: PERFORM assert_period_open(p_business_id, v_economic_date)
--     tras normalizar la fecha y antes de cualquier escritura económica.
--   - Idempotencia real (nueva): p_idempotency_key + owner_flow_requests
--     (patrón M6). Replay con misma key+payload → devuelve el resultado original
--     sin re-escribir NI re-auditar. Key+payload distinto → IDEMPOTENCY_CONFLICT.
--   - Auditoría: UN finance_log_audit al final del camino exitoso, con request_id
--     real, entidad+id reales, acción estable, fecha persistida, actor, negocio,
--     referencias y resumen financiero. Si la auditoría falla, el WHEN OTHERS
--     revierte TODAS las escrituras (rollback del bloque) y devuelve {ok:false}.
--
-- Orden por RPC: 1 auth · 2 ownership/rol · 3 payload · 4 fecha · 5 guard ·
--   6 escrituras · 7 verif · 8 audit · 9 retorno. (El short-circuit de replay va
--   entre 4 y 5 para no re-evaluar el guard sobre una operación ya confirmada.)
-- Aditiva y reversible.
-- ============================================================================

-- ── Requests compartida para idempotencia de ambos flujos ───────────────────
CREATE TABLE IF NOT EXISTS "public"."owner_flow_requests" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id"     uuid NOT NULL REFERENCES "public"."businesses"("id"),
  "user_id"         uuid,
  "op"              text NOT NULL CHECK ("op" IN ('withdrawal','contribution')),
  "idempotency_key" text NOT NULL,
  "request_hash"    text NOT NULL,
  "withdrawal_id"   uuid,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "owner_flow_requests_key_uniq" UNIQUE ("business_id","idempotency_key")
);
ALTER TABLE "public"."owner_flow_requests" ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='owner_flow_requests' AND policyname='owner_flow_req_select') THEN
    CREATE POLICY "owner_flow_req_select" ON "public"."owner_flow_requests" FOR SELECT USING (
      EXISTS (SELECT 1 FROM businesses WHERE id=owner_flow_requests.business_id AND owner_user_id=auth.uid())
      OR EXISTS (SELECT 1 FROM profiles WHERE business_id=owner_flow_requests.business_id AND user_id=auth.uid()
                 AND COALESCE(is_active,true) AND role IN ('owner','admin')));
  END IF;
END $$;
REVOKE ALL ON "public"."owner_flow_requests" FROM PUBLIC, "anon";
GRANT SELECT ON "public"."owner_flow_requests" TO "authenticated";
GRANT ALL ON "public"."owner_flow_requests" TO "service_role";

-- ── create_owner_withdrawal (negocio → dueño, −capital) ─────────────────────
DROP FUNCTION IF EXISTS "public"."create_owner_withdrawal"(uuid, numeric, date, uuid, text);
CREATE OR REPLACE FUNCTION "public"."create_owner_withdrawal"(
  "p_business_id" uuid, "p_amount" numeric, "p_date" date, "p_account_id" uuid,
  "p_notes" text DEFAULT NULL, "p_idempotency_key" text DEFAULT NULL
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_user_id       uuid := auth.uid();
  v_is_authorized boolean := false;
  v_acc           personal_accounts%ROWTYPE;
  v_has_ars_row   boolean := false;
  v_economic_date date;
  v_key           text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_hash          text;
  v_existing      owner_flow_requests%ROWTYPE;
  v_req_id        uuid;
  v_tx_id         uuid;
  v_fm_id         uuid;
  v_wd_id         uuid;
BEGIN
  -- 1. Autenticación
  IF v_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'No autenticado'); END IF;

  -- 2. Ownership + autorización por rol (SIN cambios: owner del negocio o owner/admin)
  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user_id)
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND COALESCE(user_id,id)=v_user_id
               AND COALESCE(is_active,true) AND role IN ('owner','admin'))
  ) INTO v_is_authorized;
  IF NOT v_is_authorized THEN RETURN jsonb_build_object('ok', false, 'error', 'Sin permiso para registrar retiros en este negocio'); END IF;

  -- 3. Validaciones del payload
  IF p_amount IS NULL OR p_amount::text IN ('NaN','Infinity','-Infinity') OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El monto debe ser mayor a cero'); END IF;
  SELECT * INTO v_acc FROM personal_accounts WHERE id=p_account_id AND user_id=v_user_id AND is_active=true FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'Cuenta personal no encontrada o no activa'); END IF;
  SELECT EXISTS (SELECT 1 FROM personal_account_balances WHERE account_id=p_account_id AND user_id=v_user_id AND currency='ARS') INTO v_has_ars_row;
  IF NOT v_has_ars_row AND COALESCE(v_acc.currency,'ARS')<>'ARS' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'La cuenta destino no opera en ARS. Agregá ARS a la cuenta o elegí otra.'); END IF;

  -- 4. Normalización de fecha económica (única; el parámetro nulo no se reutiliza)
  v_economic_date := COALESCE(p_date, public.ar_today());

  -- (4b) Short-circuit de replay ANTES del guard: una operación ya confirmada no
  -- se vuelve a evaluar contra el período (pudo cerrarse luego).
  IF v_key IS NOT NULL THEN
    v_hash := encode(extensions.digest('wd§'||p_business_id::text||'§'||round(p_amount,2)::text||'§'||v_economic_date::text||'§'||p_account_id::text, 'sha256'), 'hex');
    SELECT * INTO v_existing FROM owner_flow_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'withdrawal_id', v_existing.withdrawal_id);
    END IF;
  END IF;

  -- 5. Guard de período (tras normalizar la fecha, antes de escribir)
  PERFORM public.assert_period_open(p_business_id, v_economic_date);

  -- (5b) Reserva de la key (lock lógico de reintentos)
  IF v_key IS NOT NULL THEN
    BEGIN
      INSERT INTO owner_flow_requests (business_id, user_id, op, idempotency_key, request_hash)
        VALUES (p_business_id, v_user_id, 'withdrawal', v_key, v_hash) RETURNING id INTO v_req_id;
    EXCEPTION WHEN unique_violation THEN
      SELECT * INTO v_existing FROM owner_flow_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_CONFLICT'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'withdrawal_id', v_existing.withdrawal_id);
    END;
  END IF;

  -- 6. Escrituras económicas (persisten v_economic_date en TODAS las patas)
  INSERT INTO personal_transactions (user_id, account_id, type, amount, currency, date, description, notes)
    VALUES (v_user_id, p_account_id, 'income', p_amount, 'ARS', v_economic_date, 'Retiro del negocio', p_notes)
    RETURNING id INTO v_tx_id;
  PERFORM personal_update_currency_balance(p_account_id, 'ARS', p_amount);
  INSERT INTO financial_movements (business_id, type, amount, amount_ars, currency, exchange_rate,
    source, source_id, description, date, created_by, reference_type, sign, movement_type)
    VALUES (p_business_id, 'expense', p_amount, p_amount, 'ARS', 1, 'owner_withdrawal', NULL,
      'Retiro propietario' || CASE WHEN p_notes IS NOT NULL THEN ': '||p_notes ELSE '' END,
      v_economic_date, v_user_id, 'owner_withdrawal', 1, NULL)
    RETURNING id INTO v_fm_id;
  INSERT INTO owner_withdrawals (business_id, user_id, amount, currency, date,
    business_financial_movement_id, personal_transaction_id, destination_account_id, notes, status, flow_type)
    VALUES (p_business_id, v_user_id, p_amount, 'ARS', v_economic_date, v_fm_id, v_tx_id, p_account_id, p_notes, 'completed', 'withdrawal')
    RETURNING id INTO v_wd_id;
  UPDATE financial_movements SET source_id=v_wd_id WHERE id=v_fm_id;

  -- 7. Verificaciones finales + enlace de la request
  IF v_key IS NOT NULL THEN UPDATE owner_flow_requests SET withdrawal_id=v_wd_id WHERE id=v_req_id; END IF;

  -- 8. Auditoría (un evento; si falla, el WHEN OTHERS revierte TODO)
  PERFORM finance_log_audit(
    p_business_id, 'owner_withdrawal', 'owner_withdrawals', v_wd_id, 'create_owner_withdrawal',
    v_key, p_notes, v_economic_date, 'owner_flow', v_wd_id,
    NULL, jsonb_build_object('amount', p_amount, 'currency','ARS', 'flow_type','withdrawal',
      'business_fm_id', v_fm_id, 'personal_tx_id', v_tx_id));

  -- 9. Retorno
  RETURN jsonb_build_object('ok', true, 'replay', false, 'withdrawal_id', v_wd_id, 'personal_tx_id', v_tx_id, 'business_fm_id', v_fm_id);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;
ALTER FUNCTION "public"."create_owner_withdrawal"(uuid, numeric, date, uuid, text, text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."create_owner_withdrawal"(uuid, numeric, date, uuid, text, text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."create_owner_withdrawal"(uuid, numeric, date, uuid, text, text) TO "authenticated", "service_role";

-- ── create_owner_contribution (dueño → negocio, +capital) ───────────────────
DROP FUNCTION IF EXISTS "public"."create_owner_contribution"(uuid, numeric, date, uuid, text);
CREATE OR REPLACE FUNCTION "public"."create_owner_contribution"(
  "p_business_id" uuid, "p_amount" numeric, "p_date" date, "p_account_id" uuid,
  "p_notes" text DEFAULT NULL, "p_idempotency_key" text DEFAULT NULL
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_user_id       uuid := auth.uid();
  v_is_authorized boolean := false;
  v_acc           personal_accounts%ROWTYPE;
  v_has_ars_row   boolean := false;
  v_economic_date date;
  v_key           text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_hash          text;
  v_existing      owner_flow_requests%ROWTYPE;
  v_req_id        uuid;
  v_tx_id         uuid;
  v_fm_id         uuid;
  v_wd_id         uuid;
BEGIN
  -- 1. Autenticación
  IF v_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'No autenticado'); END IF;

  -- 2. Ownership + autorización por rol (SIN cambios: owner o owner/admin)
  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user_id)
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND COALESCE(user_id,id)=v_user_id
               AND COALESCE(is_active,true) AND role IN ('owner','admin'))
  ) INTO v_is_authorized;
  IF NOT v_is_authorized THEN RETURN jsonb_build_object('ok', false, 'error', 'Sin permiso para registrar aportes en este negocio'); END IF;

  -- 3. Validaciones del payload
  IF p_amount IS NULL OR p_amount::text IN ('NaN','Infinity','-Infinity') OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El monto debe ser mayor a cero'); END IF;
  SELECT * INTO v_acc FROM personal_accounts WHERE id=p_account_id AND user_id=v_user_id AND is_active=true FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'Cuenta personal no encontrada o no activa'); END IF;
  SELECT EXISTS (SELECT 1 FROM personal_account_balances WHERE account_id=p_account_id AND user_id=v_user_id AND currency='ARS') INTO v_has_ars_row;
  IF NOT v_has_ars_row AND COALESCE(v_acc.currency,'ARS')<>'ARS' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'La cuenta origen no opera en ARS.'); END IF;

  -- 4. Normalización de fecha económica
  v_economic_date := COALESCE(p_date, public.ar_today());

  -- (4b) Short-circuit de replay
  IF v_key IS NOT NULL THEN
    v_hash := encode(extensions.digest('ct§'||p_business_id::text||'§'||round(p_amount,2)::text||'§'||v_economic_date::text||'§'||p_account_id::text, 'sha256'), 'hex');
    SELECT * INTO v_existing FROM owner_flow_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'contribution_id', v_existing.withdrawal_id);
    END IF;
  END IF;

  -- 5. Guard de período
  PERFORM public.assert_period_open(p_business_id, v_economic_date);

  -- (5b) Reserva de la key
  IF v_key IS NOT NULL THEN
    BEGIN
      INSERT INTO owner_flow_requests (business_id, user_id, op, idempotency_key, request_hash)
        VALUES (p_business_id, v_user_id, 'contribution', v_key, v_hash) RETURNING id INTO v_req_id;
    EXCEPTION WHEN unique_violation THEN
      SELECT * INTO v_existing FROM owner_flow_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_CONFLICT'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'contribution_id', v_existing.withdrawal_id);
    END;
  END IF;

  -- 6. Escrituras económicas (persisten v_economic_date)
  INSERT INTO personal_transactions (user_id, account_id, type, amount, currency, date, description, notes)
    VALUES (v_user_id, p_account_id, 'expense', p_amount, 'ARS', v_economic_date, 'Aporte al negocio', p_notes)
    RETURNING id INTO v_tx_id;
  PERFORM personal_update_currency_balance(p_account_id, 'ARS', -p_amount);
  INSERT INTO financial_movements (business_id, type, amount, amount_ars, currency, exchange_rate,
    source, source_id, description, date, created_by, reference_type, sign, movement_type)
    VALUES (p_business_id, 'income', p_amount, p_amount, 'ARS', 1, 'owner_contribution', NULL,
      'Aporte del propietario' || CASE WHEN p_notes IS NOT NULL THEN ': '||p_notes ELSE '' END,
      v_economic_date, v_user_id, 'owner_contribution', 1, 'income')
    RETURNING id INTO v_fm_id;
  INSERT INTO owner_withdrawals (business_id, user_id, amount, currency, date,
    business_financial_movement_id, personal_transaction_id, destination_account_id, notes, status, flow_type)
    VALUES (p_business_id, v_user_id, p_amount, 'ARS', v_economic_date, v_fm_id, v_tx_id, p_account_id, p_notes, 'completed', 'contribution')
    RETURNING id INTO v_wd_id;
  UPDATE financial_movements SET source_id=v_wd_id WHERE id=v_fm_id;

  -- 7. Enlace de la request
  IF v_key IS NOT NULL THEN UPDATE owner_flow_requests SET withdrawal_id=v_wd_id WHERE id=v_req_id; END IF;

  -- 8. Auditoría (un evento; si falla, revierte todo)
  PERFORM finance_log_audit(
    p_business_id, 'owner_contribution', 'owner_withdrawals', v_wd_id, 'create_owner_contribution',
    v_key, p_notes, v_economic_date, 'owner_flow', v_wd_id,
    NULL, jsonb_build_object('amount', p_amount, 'currency','ARS', 'flow_type','contribution',
      'business_fm_id', v_fm_id, 'personal_tx_id', v_tx_id));

  -- 9. Retorno
  RETURN jsonb_build_object('ok', true, 'replay', false, 'contribution_id', v_wd_id, 'personal_tx_id', v_tx_id, 'business_fm_id', v_fm_id);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;
ALTER FUNCTION "public"."create_owner_contribution"(uuid, numeric, date, uuid, text, text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."create_owner_contribution"(uuid, numeric, date, uuid, text, text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."create_owner_contribution"(uuid, numeric, date, uuid, text, text) TO "authenticated", "service_role";

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado):
--   DROP FUNCTION create_owner_withdrawal(uuid,numeric,date,uuid,text,text);
--   DROP FUNCTION create_owner_contribution(uuid,numeric,date,uuid,text,text);
--   -- recrear las firmas de 5 args (cuerpos de finance_hardening_base / owner_capital_flows)
--   DROP TABLE owner_flow_requests;
-- ============================================================================
