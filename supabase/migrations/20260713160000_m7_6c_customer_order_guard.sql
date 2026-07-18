-- ============================================================================
-- M7 (Bloque 6C) — Guard + idempotencia + auditoría en cobros de cuenta corriente
-- de clientes y pagos de órdenes. PRIMER ejercicio real del audit scope sobre E2
-- (record_customer_account_payment_atomic escribe account_movements).
--
--   PARTE A — endurecer account_payment_requests / order_payment_requests.
--   PARTE B — record_customer_account_payment_atomic (escribe E2 account_movements).
--   PARTE C — create_order_payment_atomic (escribe order_payments → trigger FM/BFE).
--
-- Roles: se PRESERVA exactamente el modelo M6 (cualquier perfil activo del negocio).
-- Fecha económica: v_economic_date := COALESCE(p_date, ar_today()) persistida en
-- TODAS las filas. Idempotencia endurecida a ON CONFLICT + relectura + hash jsonb.
-- Contrato de error {ok,error_code,error(+message en conflicto)} compat frontend.
-- NUEVO en order payments: guard de SOBREPAGO (OVERPAYMENT) sólo si total_cost>0
-- (M6 no lo tenía) — cambio de comportamiento documentado.
-- ============================================================================

-- ═══════════════ PARTE A — request tables ══════════════════════════════════
ALTER TABLE "public"."account_payment_requests" ADD COLUMN IF NOT EXISTS "op" text;
ALTER TABLE "public"."order_payment_requests"   ADD COLUMN IF NOT EXISTS "op" text;

DROP POLICY IF EXISTS "account_payment_req_select" ON "public"."account_payment_requests";
DROP POLICY IF EXISTS "op_req_select" ON "public"."order_payment_requests";
REVOKE ALL ON "public"."account_payment_requests" FROM PUBLIC, "anon", "authenticated";
REVOKE ALL ON "public"."order_payment_requests"   FROM PUBLIC, "anon", "authenticated";
REVOKE UPDATE, DELETE, TRUNCATE ON "public"."account_payment_requests" FROM "service_role";
REVOKE UPDATE, DELETE, TRUNCATE ON "public"."order_payment_requests"   FROM "service_role";
GRANT SELECT, INSERT ON "public"."account_payment_requests" TO "service_role";
GRANT SELECT, INSERT ON "public"."order_payment_requests"   TO "service_role";

CREATE OR REPLACE FUNCTION "public"."account_payment_requests_immutable"() RETURNS "trigger"
    LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'account_payment_requests es append-only: DELETE no permitido' USING ERRCODE='0A000'; END IF;
  IF OLD.movement_id IS NOT NULL THEN RAISE EXCEPTION 'account_payment_requests: request completada es inmutable' USING ERRCODE='0A000'; END IF;
  IF NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.op IS DISTINCT FROM OLD.op THEN
    RAISE EXCEPTION 'account_payment_requests: sólo se puede completar movement_id' USING ERRCODE='0A000'; END IF;
  IF NEW.movement_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM account_movements WHERE id=NEW.movement_id AND business_id=NEW.business_id) THEN
    RAISE EXCEPTION 'account_payment_requests: la entidad enlazada no pertenece al negocio' USING ERRCODE='0A000'; END IF;
  RETURN NEW;
END; $$;
ALTER FUNCTION "public"."account_payment_requests_immutable"() OWNER TO "postgres";
DROP TRIGGER IF EXISTS "trg_account_payment_requests_immutable" ON "public"."account_payment_requests";
CREATE TRIGGER "trg_account_payment_requests_immutable"
  BEFORE UPDATE OR DELETE ON "public"."account_payment_requests"
  FOR EACH ROW EXECUTE FUNCTION "public"."account_payment_requests_immutable"();

CREATE OR REPLACE FUNCTION "public"."order_payment_requests_immutable"() RETURNS "trigger"
    LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'order_payment_requests es append-only: DELETE no permitido' USING ERRCODE='0A000'; END IF;
  IF OLD.order_payment_id IS NOT NULL THEN RAISE EXCEPTION 'order_payment_requests: request completada es inmutable' USING ERRCODE='0A000'; END IF;
  IF NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.op IS DISTINCT FROM OLD.op THEN
    RAISE EXCEPTION 'order_payment_requests: sólo se puede completar order_payment_id' USING ERRCODE='0A000'; END IF;
  IF NEW.order_payment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM order_payments WHERE id=NEW.order_payment_id AND business_id=NEW.business_id) THEN
    RAISE EXCEPTION 'order_payment_requests: la entidad enlazada no pertenece al negocio' USING ERRCODE='0A000'; END IF;
  RETURN NEW;
END; $$;
ALTER FUNCTION "public"."order_payment_requests_immutable"() OWNER TO "postgres";
DROP TRIGGER IF EXISTS "trg_order_payment_requests_immutable" ON "public"."order_payment_requests";
CREATE TRIGGER "trg_order_payment_requests_immutable"
  BEFORE UPDATE OR DELETE ON "public"."order_payment_requests"
  FOR EACH ROW EXECUTE FUNCTION "public"."order_payment_requests_immutable"();

-- ═══════════════ PARTE B — record_customer_account_payment_atomic ══════════
CREATE OR REPLACE FUNCTION "public"."record_customer_account_payment_atomic"(
  p_business_id uuid, p_account_id uuid, p_amount numeric, p_description text, p_user_id uuid,
  p_payment_method text, p_date date, p_caja_id uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  c_key_max       constant int := 200;
  v_user          uuid := auth.uid();
  v_is_member     boolean := false;
  v_account       accounts%ROWTYPE;
  v_debt          numeric;
  v_new_balance   numeric;
  v_economic_date date;
  v_method        text := NULLIF(btrim(COALESCE(p_payment_method,'')), '');
  v_key           text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_hash          text;
  v_existing      account_payment_requests%ROWTYPE;
  v_req_id        uuid;
  v_mov_id        uuid;
  v_fm_id         uuid;
  v_bfe_id        uuid;
  v_stage         text := 'init';
BEGIN
  -- 1. Autenticación
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','UNAUTHORIZED', 'error', 'No autenticado'); END IF;
  -- 2/3. Pertenencia (modelo M6: cualquier perfil activo del negocio)
  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND user_id=v_user AND COALESCE(is_active,true))) INTO v_is_member;
  IF NOT v_is_member THEN RETURN jsonb_build_object('ok', false, 'error_code','FORBIDDEN', 'error', 'Sin acceso a este negocio'); END IF;
  -- 4. Validación del payload
  IF v_key IS NOT NULL AND length(v_key) > c_key_max THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La clave de idempotencia es demasiado larga'); END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El monto debe ser mayor a 0'); END IF;
  SELECT * INTO v_account FROM accounts WHERE id=p_account_id AND business_id=p_business_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error_code','ACCOUNT_NOT_FOUND', 'error', 'Cuenta inexistente'); END IF;
  IF v_account.type <> 'cliente' THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La cuenta no es de cliente'); END IF;
  -- Deuda server-side desde el ledger; el cobro no puede superarla (sobrepago)
  SELECT COALESCE(SUM(debit-credit),0) INTO v_debt FROM account_movements WHERE account_id=p_account_id;
  IF p_amount > v_debt + 0.01 THEN RETURN jsonb_build_object('ok', false, 'error_code','OVERPAYMENT', 'error', 'El cobro supera la deuda pendiente'); END IF;
  -- Efectivo requiere caja abierta
  IF v_method='efectivo' AND p_caja_id IS NULL AND NOT EXISTS (SELECT 1 FROM cajas WHERE business_id=p_business_id AND status='abierta') THEN
    RETURN jsonb_build_object('ok', false, 'error_code','CASH_REGISTER_NOT_OPEN', 'error', 'No hay caja abierta para registrar el cobro en efectivo'); END IF;

  -- 5. Fecha económica única
  v_economic_date := COALESCE(p_date, public.ar_today());

  -- 6. Replay previo (hash canónico jsonb)
  IF v_key IS NOT NULL THEN
    v_hash := encode(extensions.digest(jsonb_build_object(
      'op','customer_account_payment', 'business_id',p_business_id, 'account_id',p_account_id,
      'amount',round(p_amount,2), 'currency','ARS', 'method',v_method, 'caja',p_caja_id,
      'economic_date',v_economic_date, 'description',NULLIF(btrim(p_description),''))::text, 'sha256'), 'hex');
    SELECT * INTO v_existing FROM account_payment_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta clave ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'account_movement_id', v_existing.movement_id);
    END IF;
  END IF;

  -- 7. Guard de período
  BEGIN
    PERFORM public.assert_period_open(p_business_id, v_economic_date);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'PERIOD_CLOSED%' THEN RETURN jsonb_build_object('ok', false, 'error_code','PERIOD_CLOSED', 'error', SQLERRM);
    ELSIF SQLERRM LIKE 'INVALID_FINANCE_CONTEXT%' THEN RETURN jsonb_build_object('ok', false, 'error_code','INVALID_FINANCE_CONTEXT', 'error', SQLERRM);
    ELSE RAISE; END IF;
  END;

  -- 8. Reserva idempotente race-safe
  IF v_key IS NOT NULL THEN
    INSERT INTO account_payment_requests (business_id, user_id, op, idempotency_key, request_hash)
      VALUES (p_business_id, v_user, 'customer_account_payment', v_key, v_hash)
      ON CONFLICT (business_id, idempotency_key) DO NOTHING RETURNING id INTO v_req_id;
    IF v_req_id IS NULL THEN
      SELECT * INTO v_existing FROM account_payment_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta clave ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'account_movement_id', v_existing.movement_id);
    END IF;
  END IF;

  -- 9. Scope de auditoría (E2: suprime el backstop de account_movements)
  PERFORM public.finance_begin_audit_scope();

  -- 10. Escrituras económicas (persisten v_economic_date). balance_after lo pone el trigger.
  v_stage := 'write';
  INSERT INTO account_movements (business_id, account_id, date, type, description, debit, credit, balance_after, reference_type, created_by)
    VALUES (p_business_id, p_account_id, v_economic_date, 'pago',
      COALESCE(NULLIF(btrim(p_description),''), 'Cobro de cuenta corriente'), 0, p_amount, 0, 'manual', v_user)
    RETURNING id INTO v_mov_id;
  INSERT INTO financial_movements (business_id, date, type, currency, amount, amount_ars, exchange_rate,
    source, description, created_by, caja_id, metodo_pago, reference_id, reference_type)
    VALUES (p_business_id, v_economic_date, 'income', 'ARS', p_amount, p_amount, 1,
      'cobro_cuenta_corriente', COALESCE(NULLIF(btrim(p_description),''), 'Cobro de cuenta corriente'),
      v_user, p_caja_id, v_method, v_mov_id, 'account_movement')
    RETURNING id INTO v_fm_id;
  INSERT INTO business_finance_entries (business_id, date, type, category, description,
    amount, currency, amount_ars, exchange_rate, payment_method, source, created_by)
    VALUES (p_business_id, v_economic_date, 'income', 'cobro_cuenta_corriente',
      COALESCE(NULLIF(btrim(p_description),''), 'Cobro de cuenta corriente'),
      p_amount, 'ARS', p_amount, 1, v_method, 'cobro_cc', v_user)
    RETURNING id INTO v_bfe_id;

  -- 11. Saldo nuevo canónico (del trigger; no inventado)
  SELECT balance_after INTO v_new_balance FROM account_movements WHERE id=v_mov_id;

  -- 12. Enlace del request
  IF v_key IS NOT NULL THEN UPDATE account_payment_requests SET movement_id=v_mov_id WHERE id=v_req_id; END IF;

  -- 13. Auditoría explícita (un evento)
  v_stage := 'audit';
  PERFORM finance_log_audit(
    p_business_id, 'customer_account_payment', 'account_movements', v_mov_id, 'record_customer_account_payment_atomic',
    v_key, p_description, v_economic_date, 'account', p_account_id,
    NULL, jsonb_build_object('account_id', p_account_id, 'amount', p_amount, 'currency','ARS', 'amount_ars', p_amount,
      'method', v_method, 'caja_id', p_caja_id, 'financial_movement_id', v_fm_id, 'bfe_id', v_bfe_id,
      'prev_debt', v_debt, 'new_debt', v_new_balance));

  -- 14. Retorno
  RETURN jsonb_build_object('ok', true, 'replay', false,
    'account_movement_id', v_mov_id, 'financial_movement_id', v_fm_id, 'bfe_id', v_bfe_id);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false,
    'error_code', CASE WHEN v_stage='audit' THEN 'AUDIT_FAILED' ELSE 'INTERNAL_ERROR' END,
    'error', CASE WHEN v_stage='audit' THEN 'No se pudo registrar la auditoría de la operación'
                  ELSE 'No se pudo completar la operación' END);
END;
$$;
ALTER FUNCTION "public"."record_customer_account_payment_atomic"(uuid,uuid,numeric,text,uuid,text,date,uuid,text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."record_customer_account_payment_atomic"(uuid,uuid,numeric,text,uuid,text,date,uuid,text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."record_customer_account_payment_atomic"(uuid,uuid,numeric,text,uuid,text,date,uuid,text) TO "authenticated","service_role";

-- ═══════════════ PARTE C — create_order_payment_atomic ═════════════════════
CREATE OR REPLACE FUNCTION "public"."create_order_payment_atomic"(
  p_business_id uuid, p_order_id uuid, p_amount numeric, p_payment_method text, p_currency text,
  p_exchange_rate numeric, p_user_id uuid, p_notes text DEFAULT NULL, p_date date DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  c_key_max       constant int := 200;
  v_user          uuid := auth.uid();
  v_is_member     boolean := false;
  v_key           text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_curr          text := UPPER(COALESCE(NULLIF(btrim(p_currency),''),'ARS'));
  v_rate          numeric := COALESCE(NULLIF(p_exchange_rate,0), 1);
  v_economic_date date;
  v_amount_ars    numeric;
  v_customer_id   uuid;
  v_total_cost    numeric;
  v_hash          text;
  v_existing      order_payment_requests%ROWTYPE;
  v_req           uuid;
  v_pay           uuid;
  v_fm_id         uuid;
  v_bfe_id        uuid;
  v_caja_id       uuid;
  v_pending_after numeric;
  v_stage         text := 'init';
BEGIN
  -- 1. Autenticación
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','UNAUTHORIZED', 'error', 'No autenticado'); END IF;
  -- 2/3. Pertenencia (modelo M6)
  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND user_id=v_user AND COALESCE(is_active,true))) INTO v_is_member;
  IF NOT v_is_member THEN RETURN jsonb_build_object('ok', false, 'error_code','FORBIDDEN', 'error', 'Sin acceso a este negocio'); END IF;
  -- 4. Validación del payload
  IF v_key IS NOT NULL AND length(v_key) > c_key_max THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La clave de idempotencia es demasiado larga'); END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El monto debe ser mayor a 0'); END IF;
  IF p_payment_method NOT IN ('cash','credit_card','debit_card','transfer','other') THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Método de pago inválido'); END IF;
  IF v_curr NOT IN ('ARS','USD') THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Moneda inválida'); END IF;
  IF v_curr='USD' AND v_rate <= 0 THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Falta el tipo de cambio para el pago en USD'); END IF;
  SELECT customer_id, COALESCE(total_cost,0) INTO v_customer_id, v_total_cost FROM orders WHERE id=p_order_id AND business_id=p_business_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error_code','ORDER_NOT_FOUND', 'error', 'Orden inexistente'); END IF;
  v_amount_ars := round(p_amount * v_rate, 2);
  -- 6C.1: M7 NO introduce política de sobrepago. Se PRESERVA el comportamiento
  -- previo: un pago que supera el saldo restante se acepta igual. pending_after
  -- se calcula sólo para auditoría/respuesta (puede quedar negativo), nunca para
  -- rechazar. No se actualiza orders.amount_paid; sin saldo a favor/propina/ajuste.
  -- Efectivo requiere caja abierta
  IF p_payment_method='cash' AND NOT EXISTS (SELECT 1 FROM cajas WHERE business_id=p_business_id AND status='abierta') THEN
    RETURN jsonb_build_object('ok', false, 'error_code','CASH_REGISTER_NOT_OPEN', 'error', 'No hay caja abierta para registrar el pago en efectivo'); END IF;

  -- 5. Fecha económica única
  v_economic_date := COALESCE(p_date, public.ar_today());

  -- 6. Replay previo (hash canónico jsonb)
  IF v_key IS NOT NULL THEN
    v_hash := encode(extensions.digest(jsonb_build_object(
      'op','order_payment', 'business_id',p_business_id, 'order_id',p_order_id, 'amount',round(p_amount,2),
      'currency',v_curr, 'method',p_payment_method, 'rate',round(v_rate,4), 'economic_date',v_economic_date)::text, 'sha256'), 'hex');
    SELECT * INTO v_existing FROM order_payment_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta clave ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'order_payment_id', v_existing.order_payment_id);
    END IF;
  END IF;

  -- 7. Guard de período
  BEGIN
    PERFORM public.assert_period_open(p_business_id, v_economic_date);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'PERIOD_CLOSED%' THEN RETURN jsonb_build_object('ok', false, 'error_code','PERIOD_CLOSED', 'error', SQLERRM);
    ELSIF SQLERRM LIKE 'INVALID_FINANCE_CONTEXT%' THEN RETURN jsonb_build_object('ok', false, 'error_code','INVALID_FINANCE_CONTEXT', 'error', SQLERRM);
    ELSE RAISE; END IF;
  END;

  -- 8. Reserva idempotente race-safe
  IF v_key IS NOT NULL THEN
    INSERT INTO order_payment_requests (business_id, user_id, op, idempotency_key, request_hash)
      VALUES (p_business_id, v_user, 'order_payment', v_key, v_hash)
      ON CONFLICT (business_id, idempotency_key) DO NOTHING RETURNING id INTO v_req;
    IF v_req IS NULL THEN
      SELECT * INTO v_existing FROM order_payment_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta clave ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'order_payment_id', v_existing.order_payment_id);
    END IF;
  END IF;

  -- 9. Scope de auditoría (order_payments/FM no tienen backstop; se declara gestión igual)
  PERFORM public.finance_begin_audit_scope();

  -- 10. Escritura: order_payments → trig_payment_creates_movements crea FM+BFE (USD correcto)
  v_stage := 'write';
  INSERT INTO order_payments (order_id, business_id, amount, payment_method, currency, exchange_rate, amount_ars, payment_date, notes, created_by)
    VALUES (p_order_id, p_business_id, p_amount, p_payment_method, v_curr, v_rate, v_amount_ars, v_economic_date, NULLIF(btrim(p_notes),''), v_user)
    RETURNING id INTO v_pay;
  SELECT financial_movement_id, finance_entry_id INTO v_fm_id, v_bfe_id FROM order_payments WHERE id=v_pay;
  SELECT caja_id INTO v_caja_id FROM financial_movements WHERE id=v_fm_id;

  -- 11. Saldo pendiente posterior canónico (si hay total)
  IF v_total_cost > 0 THEN
    SELECT v_total_cost - COALESCE(SUM(amount_ars),0) INTO v_pending_after FROM order_payments WHERE order_id=p_order_id AND reversed_at IS NULL;
  END IF;

  -- 12. Enlace del request
  IF v_key IS NOT NULL THEN UPDATE order_payment_requests SET order_payment_id=v_pay WHERE id=v_req; END IF;

  -- 13. Auditoría explícita (un evento agregado de negocio: el pago de la orden)
  v_stage := 'audit';
  PERFORM finance_log_audit(
    p_business_id, 'order_payment', 'order_payments', v_pay, 'create_order_payment_atomic',
    v_key, p_notes, v_economic_date, 'order', p_order_id,
    NULL, jsonb_build_object('order_id', p_order_id, 'customer_id', v_customer_id, 'amount', p_amount,
      'currency', v_curr, 'amount_ars', v_amount_ars, 'method', p_payment_method, 'caja_id', v_caja_id,
      'financial_movement_id', v_fm_id, 'finance_entry_id', v_bfe_id, 'pending_after', v_pending_after));

  -- 14. Retorno
  RETURN jsonb_build_object('ok', true, 'replay', false, 'order_payment_id', v_pay,
    'financial_movement_id', v_fm_id, 'finance_entry_id', v_bfe_id);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false,
    'error_code', CASE WHEN v_stage='audit' THEN 'AUDIT_FAILED' ELSE 'INTERNAL_ERROR' END,
    'error', CASE WHEN v_stage='audit' THEN 'No se pudo registrar la auditoría de la operación'
                  ELSE 'No se pudo completar la operación' END);
END;
$$;
ALTER FUNCTION "public"."create_order_payment_atomic"(uuid,uuid,numeric,text,text,numeric,uuid,text,date,text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."create_order_payment_atomic"(uuid,uuid,numeric,text,text,numeric,uuid,text,date,text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."create_order_payment_atomic"(uuid,uuid,numeric,text,text,numeric,uuid,text,date,text) TO "authenticated","service_role";

-- ============================================================================
-- ROLLBACK (documentado): recrear las versiones M6 de ambas RPC; DROP triggers de
-- inmutabilidad + funciones; ALTER … DROP COLUMN op; restaurar policies/grants M6.
-- ============================================================================
