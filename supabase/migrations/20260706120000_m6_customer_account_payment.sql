-- ============================================================================
-- M6 (Fase 3) — Cobro de cuenta corriente cliente por RPC atómica e idempotente
--
-- ANTES: cuentasService.registrarPagoCC hacía DOS inserts client-side sin
-- transacción (account_movements credit + business_finance_entries income) y
-- NO creaba financial_movements → la caja no subía ("cobros sin caja"), sin
-- idempotencia (doble-click duplicaba el cobro).
--
-- AHORA: record_customer_account_payment_atomic hace TODO en una transacción:
--   1. account_movements credit  → reduce la deuda (balance vía trigger).
--   2. financial_movements income → sube la CAJA (trig_set_movement_caja asigna
--      caja si no se pasa).
--   3. business_finance_entries income category='cobro_cuenta_corriente' →
--      economic_class revenue_collection_mirror → EXCLUIDO del P&L (no reconoce
--      venta nueva, no toca COGS ni resultado operativo).
-- Cobrar una deuda: sube caja, baja CxC, P&L intacto.
--
-- Idempotencia por request_hash server-side (mismo patrón que checkout / compra).
-- Append-only. Ownership + fecha AR. No recalcula históricos.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "public"."account_payment_requests" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id"     uuid NOT NULL REFERENCES "public"."businesses"("id"),
  "user_id"         uuid,
  "idempotency_key" text NOT NULL,
  "request_hash"    text NOT NULL,
  "movement_id"     uuid,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "account_payment_requests_key_uniq" UNIQUE ("business_id", "idempotency_key")
);
ALTER TABLE "public"."account_payment_requests" ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='account_payment_requests' AND policyname='account_payment_req_select') THEN
    CREATE POLICY "account_payment_req_select" ON "public"."account_payment_requests"
      FOR SELECT USING (
        EXISTS (SELECT 1 FROM businesses WHERE id=account_payment_requests.business_id AND owner_user_id=auth.uid())
        OR EXISTS (SELECT 1 FROM profiles WHERE business_id=account_payment_requests.business_id AND user_id=auth.uid())
      );
  END IF;
END $$;
GRANT SELECT ON "public"."account_payment_requests" TO "authenticated";

CREATE OR REPLACE FUNCTION "public"."record_customer_account_payment_atomic"(
  p_business_id     uuid,
  p_account_id      uuid,
  p_amount          numeric,
  p_description     text,
  p_user_id         uuid,
  p_payment_method  text,
  p_date            date,
  p_caja_id         uuid    DEFAULT NULL,
  p_idempotency_key text    DEFAULT NULL
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_user      uuid := auth.uid();
  v_has_access boolean := false;
  v_account   accounts%ROWTYPE;
  v_debt      numeric;
  v_date      date := COALESCE(p_date, public.ar_today());
  v_method    text := NULLIF(btrim(COALESCE(p_payment_method,'')), '');
  v_key       text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_existing  account_payment_requests%ROWTYPE;
  v_req_id    uuid;
  v_request_hash text;
  v_mov_id    uuid;
  v_fm_id     uuid;
  v_bfe_id    uuid;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'No autenticado'); END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'El monto debe ser mayor a 0'); END IF;

  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user)
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND user_id=v_user AND COALESCE(is_active,true))
  ) INTO v_has_access;
  IF NOT v_has_access THEN RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio'); END IF;

  -- Cuenta: existe, pertenece al negocio, es cliente. Lock para serializar.
  SELECT * INTO v_account FROM accounts
    WHERE id=p_account_id AND business_id=p_business_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'Cuenta inexistente'); END IF;
  IF v_account.type <> 'cliente' THEN RETURN jsonb_build_object('ok', false, 'error', 'La cuenta no es de cliente'); END IF;

  -- Deuda pendiente real desde el ledger (no confiar en la columna cacheada).
  SELECT COALESCE(SUM(debit-credit),0) INTO v_debt FROM account_movements WHERE account_id=p_account_id;
  IF p_amount > v_debt + 0.01 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El cobro supera la deuda pendiente');
  END IF;

  -- Cobro en efectivo requiere caja abierta (el dinero entra a la caja).
  IF v_method = 'efectivo' AND p_caja_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM cajas WHERE business_id=p_business_id AND status='abierta') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No hay caja abierta para registrar el cobro en efectivo');
  END IF;

  -- ── Idempotencia ───────────────────────────────────────────────────────────
  IF v_key IS NOT NULL THEN
    v_request_hash := encode(extensions.digest(
      p_business_id::text || '§' || p_account_id::text || '§' ||
      round(p_amount,2)::text || '§' || COALESCE(v_method,'∅') || '§' ||
      v_date::text || '§' || COALESCE(NULLIF(btrim(p_description),''),'∅')
    , 'sha256'), 'hex');

    SELECT * INTO v_existing FROM account_payment_requests
      WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_request_hash THEN
        RETURN jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_CONFLICT',
          'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.');
      END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'account_movement_id', v_existing.movement_id);
    END IF;
    BEGIN
      INSERT INTO account_payment_requests (business_id, user_id, idempotency_key, request_hash)
        VALUES (p_business_id, v_user, v_key, v_request_hash) RETURNING id INTO v_req_id;
    EXCEPTION WHEN unique_violation THEN
      SELECT * INTO v_existing FROM account_payment_requests
        WHERE business_id=p_business_id AND idempotency_key=v_key;
      IF v_existing.request_hash IS DISTINCT FROM v_request_hash THEN
        RETURN jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_CONFLICT',
          'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.');
      END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'account_movement_id', v_existing.movement_id);
    END;
  END IF;

  -- 1. Ledger: crédito (reduce deuda). balance_after lo pone el trigger.
  INSERT INTO account_movements (business_id, account_id, date, type, description, debit, credit, balance_after, reference_type, created_by)
    VALUES (p_business_id, p_account_id, v_date, 'pago',
      COALESCE(NULLIF(btrim(p_description),''), 'Cobro de cuenta corriente'), 0, p_amount, 0, 'manual', p_user_id)
    RETURNING id INTO v_mov_id;

  -- 2. Caja: financial_movement income (trig_set_movement_caja asigna caja si null).
  INSERT INTO financial_movements (business_id, date, type, currency, amount, amount_ars, exchange_rate,
    source, description, created_by, caja_id, metodo_pago, reference_id, reference_type)
    VALUES (p_business_id, v_date, 'income', 'ARS', p_amount, p_amount, 1,
      'cobro_cuenta_corriente', COALESCE(NULLIF(btrim(p_description),''), 'Cobro de cuenta corriente'),
      p_user_id, p_caja_id, v_method, v_mov_id, 'account_movement')
    RETURNING id INTO v_fm_id;

  -- 3. Espejo BFE (revenue_collection_mirror → excluido del P&L; NO es venta nueva).
  -- (business_finance_entries no tiene caja_id: la caja se traza por el FM.)
  INSERT INTO business_finance_entries (business_id, date, type, category, description,
    amount, currency, amount_ars, exchange_rate, payment_method, source, created_by)
    VALUES (p_business_id, v_date, 'income', 'cobro_cuenta_corriente',
      COALESCE(NULLIF(btrim(p_description),''), 'Cobro de cuenta corriente'),
      p_amount, 'ARS', p_amount, 1, v_method, 'cobro_cc', p_user_id)
    RETURNING id INTO v_bfe_id;

  IF v_key IS NOT NULL THEN
    UPDATE account_payment_requests SET movement_id=v_mov_id WHERE id=v_req_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'replay', false,
    'account_movement_id', v_mov_id, 'financial_movement_id', v_fm_id, 'bfe_id', v_bfe_id);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

ALTER FUNCTION "public"."record_customer_account_payment_atomic"(uuid, uuid, numeric, text, uuid, text, date, uuid, text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."record_customer_account_payment_atomic"(uuid, uuid, numeric, text, uuid, text, date, uuid, text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."record_customer_account_payment_atomic"(uuid, uuid, numeric, text, uuid, text, date, uuid, text) TO "authenticated", "service_role";

-- ROLLBACK: DROP FUNCTION record_customer_account_payment_atomic(...); DROP TABLE account_payment_requests;
