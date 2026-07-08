-- ============================================================================
-- M6 (Fase 5) — Reverso APPEND-ONLY de gasto operativo
--
-- ANTES: borrar/corregir un gasto podía hacer DELETE directo dejando FM/BFE
-- huérfanos o caja/P&L desbalanceados.
-- AHORA: reverse_operating_expense_atomic NO borra nada; crea asientos
-- COMPENSATORIOS trazables:
--   - BFE compensatorio (mismo type/category → misma economic_class
--     operating_expense, amount_ars NEGATIVO) → net P&L 0.
--   - FM compensatorio income (si el gasto afectó caja) → net caja 0, SIEMPRE en
--     la caja ABIERTA actual (nunca en la caja cerrada del gasto original).
--   - marca expenses.reversed_at (no borra la fila) + fila de auditoría.
-- Idempotente. No toca cajas cerradas. No contamina ventas/COGS.
-- ============================================================================

ALTER TABLE "public"."expenses" ADD COLUMN IF NOT EXISTS "reversed_at" timestamptz;
ALTER TABLE "public"."expenses" ADD COLUMN IF NOT EXISTS "reversed_by" uuid;

CREATE TABLE IF NOT EXISTS "public"."operating_expense_reversals" (
  "id"                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id"                   uuid NOT NULL REFERENCES "public"."businesses"("id"),
  "expense_id"                    uuid NOT NULL,
  "original_finance_entry_id"     uuid,
  "original_financial_movement_id" uuid,
  "reversal_finance_entry_id"     uuid,
  "reversal_financial_movement_id" uuid,
  "amount_ars"                    numeric NOT NULL,
  "reason"                        text NOT NULL,
  "created_by"                    uuid,
  "created_at"                    timestamptz NOT NULL DEFAULT now(),
  "idempotency_key"               text,
  "request_hash"                  text,
  "metadata"                      jsonb,
  CONSTRAINT "operating_expense_reversals_key_uniq" UNIQUE ("business_id", "idempotency_key")
);
ALTER TABLE "public"."operating_expense_reversals" ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='operating_expense_reversals' AND policyname='oe_reversals_select') THEN
    CREATE POLICY "oe_reversals_select" ON "public"."operating_expense_reversals"
      FOR SELECT USING (
        EXISTS (SELECT 1 FROM businesses WHERE id=operating_expense_reversals.business_id AND owner_user_id=auth.uid())
        OR EXISTS (SELECT 1 FROM profiles WHERE business_id=operating_expense_reversals.business_id AND user_id=auth.uid())
      );
  END IF;
END $$;
GRANT SELECT ON "public"."operating_expense_reversals" TO "authenticated";

CREATE OR REPLACE FUNCTION "public"."reverse_operating_expense_atomic"(
  p_business_id uuid, p_expense_id uuid, p_reason text, p_user_id uuid,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_user uuid := auth.uid();
  v_access boolean := false;
  v_key text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_reason text := NULLIF(btrim(COALESCE(p_reason,'')), '');
  v_hash text;
  v_existing operating_expense_reversals%ROWTYPE;
  v_exp expenses%ROWTYPE;
  v_bfe business_finance_entries%ROWTYPE;
  v_fm financial_movements%ROWTYPE;
  v_method text;
  v_new_bfe uuid; v_new_fm uuid;
  v_date date := public.ar_today();
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'No autenticado'); END IF;
  IF v_reason IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'El motivo del reverso es obligatorio'); END IF;
  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND user_id=v_user AND COALESCE(is_active,true))) INTO v_access;
  IF NOT v_access THEN RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio'); END IF;

  -- Idempotencia por key (la tabla de reversos hace de store).
  IF v_key IS NOT NULL THEN
    v_hash := encode(extensions.digest('rev§'||p_business_id::text||'§'||p_expense_id::text||'§'||v_reason, 'sha256'), 'hex');
    SELECT * INTO v_existing FROM operating_expense_reversals WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.');
      END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'reversal_finance_entry_id', v_existing.reversal_finance_entry_id,
        'reversal_financial_movement_id', v_existing.reversal_financial_movement_id);
    END IF;
  END IF;

  SELECT * INTO v_exp FROM expenses WHERE id=p_expense_id AND business_id=p_business_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'Gasto inexistente'); END IF;
  IF v_exp.tipo = 'factura' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Esta factura pertenece a una compra/proveedor. Corregila desde Proveedores o mediante un reverso específico.');
  END IF;
  IF v_exp.reversed_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El gasto ya fue reversado');
  END IF;
  IF v_exp.finance_entry_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El gasto no tiene asiento financiero para reversar');
  END IF;

  SELECT * INTO v_bfe FROM business_finance_entries WHERE id=v_exp.finance_entry_id AND business_id=p_business_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'Asiento del gasto inexistente'); END IF;
  IF v_bfe.economic_class <> 'operating_expense' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Solo se pueden reversar gastos operativos por acá (clase: '||COALESCE(v_bfe.economic_class,'?')||')');
  END IF;

  -- FM original (lo creó create_expense_with_finance con reference_id = bfe_id).
  SELECT * INTO v_fm FROM financial_movements
    WHERE business_id=p_business_id AND reference_id=v_bfe.id AND source='expense' LIMIT 1;
  v_method := COALESCE(v_fm.metodo_pago, v_exp.payment_method, 'efectivo');

  -- Semántica de caja: si hubo FM y el método es efectivo, la reversa (income)
  -- necesita una caja ABIERTA actual (nunca la caja cerrada del original).
  IF v_fm.id IS NOT NULL AND v_method = 'efectivo'
     AND NOT EXISTS (SELECT 1 FROM cajas WHERE business_id=p_business_id AND status='abierta') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No hay caja abierta para registrar la reversa en efectivo');
  END IF;

  -- 1. BFE compensatorio (mismo type/category → misma clase; amount NEGATIVO → net 0).
  INSERT INTO business_finance_entries (business_id, date, type, category, description,
    amount, currency, amount_ars, exchange_rate, payment_method, source, created_by)
    VALUES (p_business_id, v_date, v_bfe.type, v_bfe.category,
      'REVERSO: '||COALESCE(v_bfe.description,'')||' — '||v_reason,
      -v_bfe.amount, v_bfe.currency, -v_bfe.amount_ars, v_bfe.exchange_rate, v_bfe.payment_method, 'reversal', p_user_id)
    RETURNING id INTO v_new_bfe;

  -- 2. FM compensatorio income (si el original afectó caja). caja_id NULL →
  --    trigger_set_movement_caja asigna la caja ABIERTA actual.
  IF v_fm.id IS NOT NULL THEN
    INSERT INTO financial_movements (business_id, date, type, currency, amount, amount_ars, exchange_rate,
      source, description, created_by, metodo_pago, reference_id, reference_type)
      VALUES (p_business_id, v_date, 'income', v_fm.currency, v_fm.amount, v_fm.amount_ars, v_fm.exchange_rate,
        'reversal', 'REVERSO gasto: '||COALESCE(v_fm.description,''), p_user_id, v_method, v_bfe.id, 'expense_reversal')
      RETURNING id INTO v_new_fm;
  END IF;

  -- 3. Marcar el gasto original como reversado (append-only: NO se borra la fila).
  UPDATE expenses SET reversed_at=now(), reversed_by=p_user_id WHERE id=p_expense_id;

  -- 4. Auditoría / idempotencia store.
  INSERT INTO operating_expense_reversals (business_id, expense_id, original_finance_entry_id, original_financial_movement_id,
    reversal_finance_entry_id, reversal_financial_movement_id, amount_ars, reason, created_by, idempotency_key, request_hash, metadata)
    VALUES (p_business_id, p_expense_id, v_bfe.id, v_fm.id, v_new_bfe, v_new_fm, v_bfe.amount_ars, v_reason, p_user_id, v_key, v_hash,
      jsonb_build_object('economic_class', v_bfe.economic_class, 'method', v_method));

  RETURN jsonb_build_object('ok', true, 'replay', false,
    'reversal_finance_entry_id', v_new_bfe, 'reversal_financial_movement_id', v_new_fm,
    'original_finance_entry_id', v_bfe.id, 'original_financial_movement_id', v_fm.id);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

ALTER FUNCTION "public"."reverse_operating_expense_atomic"(uuid, uuid, text, uuid, text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."reverse_operating_expense_atomic"(uuid, uuid, text, uuid, text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."reverse_operating_expense_atomic"(uuid, uuid, text, uuid, text) TO "authenticated","service_role";

-- ROLLBACK: DROP FUNCTION; DROP TABLE operating_expense_reversals;
--   ALTER TABLE expenses DROP COLUMN reversed_at, DROP COLUMN reversed_by;
