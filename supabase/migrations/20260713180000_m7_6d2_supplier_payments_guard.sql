-- ============================================================================
-- M7 (Bloque 6D.2) — pay_supplier_purchase_atomic + pay_supplier_free_atomic
-- Ownership real, actor canonico (auth.uid), fecha economica del PAGO, guard de
-- periodo, idempotencia concurrente, serializacion del saldo, caja para efectivo,
-- auditoria explicita, contrato de error. Modelo contable M3-M6 preservado:
-- pagar deuda reduce pasivo, NO genera COGS ni gasto operativo, BFE clase
-- supplier_liability_payment (fuera del P&L), una sola salida de caja / credito.
--
-- Politica de sobrepago (pay_supplier_purchase): SE PRESERVA la de M6 (el pago no
-- puede superar el saldo pendiente) -> error_code OVERPAYMENT. Es PRE-EXISTENTE.
-- pay_supplier_free NO depende del saldo (solo acredita): el advisory lock del
-- trigger de balance serializa el saldo; no requiere FOR UPDATE adicional.
-- ============================================================================

-- ── Part A — request tables ─────────────────────────────────────────────────
-- Nueva: supplier_purchase_payment_requests (pay_supplier_purchase no tenia idempotencia)
CREATE TABLE IF NOT EXISTS "public"."supplier_purchase_payment_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id" uuid NOT NULL REFERENCES "public"."businesses"("id"),
  "user_id" uuid, "op" text, "idempotency_key" text NOT NULL, "request_hash" text NOT NULL,
  "supplier_payment_id" uuid, "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "supplier_purchase_payment_requests_key_uniq" UNIQUE ("business_id","idempotency_key")
);
ALTER TABLE "public"."supplier_purchase_payment_requests" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."supplier_purchase_payment_requests" FROM PUBLIC, "anon", "authenticated";
GRANT SELECT, INSERT ON "public"."supplier_purchase_payment_requests" TO "service_role";

-- Endurecer supplier_free_payment_requests (existente)
ALTER TABLE "public"."supplier_free_payment_requests" ADD COLUMN IF NOT EXISTS "op" text;
DROP POLICY IF EXISTS "sfp_req_select" ON "public"."supplier_free_payment_requests";
REVOKE ALL ON "public"."supplier_free_payment_requests" FROM PUBLIC, "anon", "authenticated";
REVOKE UPDATE, DELETE, TRUNCATE ON "public"."supplier_free_payment_requests" FROM "service_role";
GRANT SELECT, INSERT ON "public"."supplier_free_payment_requests" TO "service_role";

-- Trigger de inmutabilidad compartido (ambas linkean a supplier_payments del mismo negocio)
CREATE OR REPLACE FUNCTION "public"."supplier_payment_requests_immutable"() RETURNS "trigger"
    LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION '% es append-only: DELETE no permitido', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  IF OLD.supplier_payment_id IS NOT NULL THEN RAISE EXCEPTION '%: request completada es inmutable', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  IF NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.op IS DISTINCT FROM OLD.op THEN
    RAISE EXCEPTION '%: solo se puede completar supplier_payment_id', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  IF NEW.supplier_payment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM supplier_payments WHERE id=NEW.supplier_payment_id AND business_id=NEW.business_id) THEN
    RAISE EXCEPTION '%: la entidad enlazada no pertenece al negocio', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  RETURN NEW;
END; $$;
ALTER FUNCTION "public"."supplier_payment_requests_immutable"() OWNER TO "postgres";
DROP TRIGGER IF EXISTS "trg_spp_req_immutable" ON "public"."supplier_purchase_payment_requests";
CREATE TRIGGER "trg_spp_req_immutable" BEFORE UPDATE OR DELETE ON "public"."supplier_purchase_payment_requests"
  FOR EACH ROW EXECUTE FUNCTION "public"."supplier_payment_requests_immutable"();
DROP TRIGGER IF EXISTS "trg_sfp_req_immutable" ON "public"."supplier_free_payment_requests";
CREATE TRIGGER "trg_sfp_req_immutable" BEFORE UPDATE OR DELETE ON "public"."supplier_free_payment_requests"
  FOR EACH ROW EXECUTE FUNCTION "public"."supplier_payment_requests_immutable"();

-- ── Part B — pay_supplier_purchase_atomic ───────────────────────────────────
DROP FUNCTION IF EXISTS "public"."pay_supplier_purchase_atomic"(uuid,uuid,uuid,text,uuid,date,numeric,text,text);
CREATE OR REPLACE FUNCTION "public"."pay_supplier_purchase_atomic"(
  p_business_id uuid, p_supplier_id uuid, p_user_id uuid, p_supplier_name text, p_purchase_id uuid,
  p_payment_date date, p_amount numeric, p_payment_method text, p_notes text, p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  c_key_max      constant int := 200;
  v_actor_user_id uuid := auth.uid();
  v_is_member    boolean := false;
  v_key          text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_method       text;
  v_notes        text := NULLIF(btrim(COALESCE(p_notes,'')), '');
  v_payment_date date;
  v_hash         text;
  v_existing     supplier_purchase_payment_requests%ROWTYPE;
  v_req          uuid;
  v_purchase     supplier_purchases%ROWTYPE;
  v_sup_name     text;
  v_desc_sfx     text;
  v_caja         uuid;
  v_paid_sum     numeric;
  v_pending      numeric;
  v_new_paid     numeric;
  v_new_pend     numeric;
  v_new_status   text;
  v_fm           uuid;
  v_bfe          uuid;
  v_pay          uuid;
  v_credit_id    uuid;
  v_stage        text := 'init';
BEGIN
  -- 1. Auth · 2. Ownership/pertenencia (miembro activo — modelo M6)
  IF v_actor_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','UNAUTHORIZED', 'error', 'No autenticado'); END IF;
  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_actor_user_id)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND COALESCE(user_id,id)=v_actor_user_id AND COALESCE(is_active,true))) INTO v_is_member;
  IF NOT v_is_member THEN RETURN jsonb_build_object('ok', false, 'error_code','FORBIDDEN', 'error', 'Sin acceso a este negocio'); END IF;
  -- 3. Validacion
  IF v_key IS NOT NULL AND length(v_key) > c_key_max THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La clave de idempotencia es demasiado larga'); END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El monto debe ser mayor a 0'); END IF;
  -- Metodo via helper CENTRAL (unico catalogo; sin comparar el parametro crudo).
  BEGIN
    v_method := public.normalize_supplier_payment_method(p_payment_method);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'INVALID_PAYMENT_METHOD%' THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Método de pago inválido'); ELSE RAISE; END IF;
  END;
  IF v_method IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Método de pago inválido'); END IF;
  -- Compra del MISMO negocio (identidad canonica del proveedor desde la compra)
  SELECT * INTO v_purchase FROM supplier_purchases WHERE id=p_purchase_id AND business_id=p_business_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error_code','PURCHASE_NOT_FOUND', 'error', 'Compra no encontrada'); END IF;
  IF p_supplier_id IS NOT NULL AND v_purchase.supplier_id IS DISTINCT FROM p_supplier_id THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El proveedor no coincide con la compra'); END IF;
  IF p_supplier_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM suppliers WHERE id=p_supplier_id AND business_id=p_business_id) THEN
    RETURN jsonb_build_object('ok', false, 'error_code','SUPPLIER_NOT_FOUND', 'error', 'Proveedor inexistente en este negocio'); END IF;
  SELECT COALESCE(name, p_supplier_name) INTO v_sup_name FROM suppliers WHERE id=v_purchase.supplier_id AND business_id=p_business_id;
  v_sup_name := COALESCE(v_sup_name, p_supplier_name, '');
  v_desc_sfx := COALESCE(' #' || NULLIF(btrim(v_purchase.invoice_number),''), '');

  -- 4. Fecha economica del PAGO (independiente de la compra) + metodo normalizado
  v_payment_date := COALESCE(p_payment_date, public.ar_today());

  -- 5. Replay (optimista, antes del lock)
  IF v_key IS NOT NULL THEN
    v_hash := encode(extensions.digest(jsonb_build_object('op','supplier_payment','business_id',p_business_id,
      'purchase_id',p_purchase_id,'supplier_id',v_purchase.supplier_id,'amount',round(p_amount,2),
      'payment_date',v_payment_date,'method',v_method,'notes',v_notes,'currency','ARS','exchange_rate',1)::text,'sha256'),'hex');
    SELECT * INTO v_existing FROM supplier_purchase_payment_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta clave ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'payment_id', v_existing.supplier_payment_id);
    END IF;
  END IF;

  -- 6. Guard de periodo (del PAGO nuevo, no de la compra original)
  BEGIN PERFORM public.assert_period_open(p_business_id, v_payment_date);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'PERIOD_CLOSED%' THEN RETURN jsonb_build_object('ok', false, 'error_code','PERIOD_CLOSED', 'error', SQLERRM);
    ELSIF SQLERRM LIKE 'INVALID_FINANCE_CONTEXT%' THEN RETURN jsonb_build_object('ok', false, 'error_code','INVALID_FINANCE_CONTEXT', 'error', SQLERRM);
    ELSE RAISE; END IF; END;

  -- 7. Caja para efectivo (misma empresa; persistida en el FM)
  SELECT id INTO v_caja FROM cajas WHERE business_id=p_business_id AND status='abierta' ORDER BY opened_at DESC LIMIT 1;
  IF v_method='efectivo' AND v_caja IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code','CASH_REGISTER_NOT_OPEN', 'error', 'Debes abrir una caja antes de registrar un pago en efectivo'); END IF;

  -- 8. LOCK del saldo: FOR UPDATE sobre la compra serializa pagos concurrentes.
  SELECT * INTO v_purchase FROM supplier_purchases WHERE id=p_purchase_id AND business_id=p_business_id FOR UPDATE;
  -- 8a. Re-chequeo de replay bajo lock (same-key que comiteo mientras esperabamos)
  IF v_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM supplier_purchase_payment_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta clave ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'payment_id', v_existing.supplier_payment_id);
    END IF;
  END IF;
  -- 8b. Saldo server-side desde pagos vivos + politica de sobrepago M6 (preservada)
  SELECT COALESCE(SUM(amount),0) INTO v_paid_sum FROM supplier_payments WHERE purchase_id=p_purchase_id AND business_id=p_business_id;
  v_pending := v_purchase.total_amount - v_paid_sum;
  IF v_pending <= 0.01 THEN RETURN jsonb_build_object('ok', false, 'error_code','OVERPAYMENT', 'error', 'La compra ya está completamente pagada'); END IF;
  IF p_amount > v_pending + 0.01 THEN RETURN jsonb_build_object('ok', false, 'error_code','OVERPAYMENT', 'error', 'El pago supera el saldo pendiente'); END IF;

  -- 9. Reserva idempotente (bajo lock: no habra otra con la misma key para esta compra)
  IF v_key IS NOT NULL THEN
    INSERT INTO supplier_purchase_payment_requests (business_id, user_id, op, idempotency_key, request_hash)
      VALUES (p_business_id, v_actor_user_id, 'supplier_payment', v_key, v_hash)
      ON CONFLICT (business_id, idempotency_key) DO NOTHING RETURNING id INTO v_req;
    IF v_req IS NULL THEN
      SELECT * INTO v_existing FROM supplier_purchase_payment_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta clave ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'payment_id', v_existing.supplier_payment_id);
    END IF;
  END IF;

  -- 10. Scope de auditoria
  PERFORM public.finance_begin_audit_scope();

  -- 11. Escrituras (una salida de caja, un credito de deuda; sin duplicar costo/COGS)
  v_stage := 'write';
  INSERT INTO public.financial_movements (business_id, caja_id, date, type, currency, amount, amount_ars, exchange_rate,
    source, description, created_by, metodo_pago, sign, reference_id, reference_type)
  VALUES (p_business_id, v_caja, v_payment_date, 'expense', 'ARS', p_amount, p_amount, 1, 'pago_proveedor',
    'Pago a ' || v_sup_name || v_desc_sfx, v_actor_user_id, v_method, 1, p_purchase_id, 'supplier_purchase') RETURNING id INTO v_fm;
  INSERT INTO public.business_finance_entries (business_id, date, type, category, description, amount, currency, amount_ars, exchange_rate, payment_method, created_by, source)
  VALUES (p_business_id, v_payment_date, 'variable_cost', 'compras_proveedor', 'Pago a ' || v_sup_name || v_desc_sfx, p_amount, 'ARS', p_amount, 1, v_method, v_actor_user_id, 'pago_proveedor') RETURNING id INTO v_bfe;
  INSERT INTO public.supplier_payments (business_id, supplier_id, purchase_id, payment_date, amount, payment_method, notes, created_by, financial_movement_id)
  VALUES (p_business_id, v_purchase.supplier_id, p_purchase_id, v_payment_date, p_amount, COALESCE(v_method,'efectivo'), COALESCE(v_notes,'Pago compra'||v_desc_sfx), v_actor_user_id, v_fm) RETURNING id INTO v_pay;
  INSERT INTO public.supplier_account_movements (business_id, supplier_id, purchase_id, payment_id, movement_date, type, description, debit, credit, balance_after)
  VALUES (p_business_id, v_purchase.supplier_id, p_purchase_id, v_pay, v_payment_date, 'payment', 'Pago' || v_desc_sfx, 0, p_amount, 0) RETURNING id INTO v_credit_id;

  -- 12. Actualizar saldo/estado de la compra (fuente vigente)
  v_new_paid := v_paid_sum + p_amount;
  v_new_pend := GREATEST(0, v_purchase.total_amount - v_new_paid);
  v_new_status := CASE WHEN v_new_paid >= v_purchase.total_amount - 0.01 THEN 'paid' WHEN v_new_paid <= 0 THEN 'pending' ELSE 'partial' END;
  UPDATE public.supplier_purchases SET paid_amount=v_new_paid, pending_amount=v_new_pend, payment_status=v_new_status, updated_at=now()
    WHERE id=p_purchase_id AND business_id=p_business_id;

  -- 13. Enlace del request
  IF v_key IS NOT NULL THEN UPDATE supplier_purchase_payment_requests SET supplier_payment_id=v_pay WHERE id=v_req; END IF;

  -- 14. Auditoria explicita (saldo anterior/posterior server-side)
  v_stage := 'audit';
  PERFORM finance_log_audit(p_business_id, 'supplier_payment', 'supplier_payments', v_pay, 'pay_supplier_purchase_atomic',
    v_key, p_notes, v_payment_date, 'supplier_purchase', p_purchase_id,
    NULL, jsonb_build_object('payment_id', v_pay, 'supplier_id', v_purchase.supplier_id, 'purchase_id', p_purchase_id,
      'amount', p_amount, 'method', v_method, 'caja_id', v_caja, 'currency','ARS', 'financial_movement_id', v_fm,
      'bfe_id', v_bfe, 'account_movement_id', v_credit_id, 'prev_pending', v_pending, 'new_pending', v_new_pend, 'new_status', v_new_status));

  RETURN jsonb_build_object('ok', true, 'replay', false, 'payment_id', v_pay, 'new_status', v_new_status);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false,
    'error_code', CASE WHEN v_stage='audit' THEN 'AUDIT_FAILED' ELSE 'INTERNAL_ERROR' END,
    'error', CASE WHEN v_stage='audit' THEN 'No se pudo registrar la auditoria de la operacion' ELSE 'No se pudo completar la operacion' END);
END;
$function$;
ALTER FUNCTION "public"."pay_supplier_purchase_atomic"(uuid,uuid,uuid,text,uuid,date,numeric,text,text,text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."pay_supplier_purchase_atomic"(uuid,uuid,uuid,text,uuid,date,numeric,text,text,text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."pay_supplier_purchase_atomic"(uuid,uuid,uuid,text,uuid,date,numeric,text,text,text) TO "authenticated","service_role";

-- ── Part C — pay_supplier_free_atomic ───────────────────────────────────────
CREATE OR REPLACE FUNCTION "public"."pay_supplier_free_atomic"(
  p_business_id uuid, p_supplier_id uuid, p_user_id uuid, p_supplier_name text,
  p_payment_date date, p_amount numeric, p_payment_method text, p_notes text, p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  c_key_max      constant int := 200;
  v_actor_user_id uuid := auth.uid();
  v_is_member    boolean := false;
  v_key          text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_method       text;
  v_notes        text := NULLIF(btrim(COALESCE(p_notes,'')), '');
  v_payment_date date;
  v_sup_name     text;
  v_desc         text;
  v_caja         uuid;
  v_hash         text;
  v_existing     supplier_free_payment_requests%ROWTYPE;
  v_req          uuid;
  v_pay          uuid;
  v_fm           uuid;
  v_bfe          uuid;
  v_credit_id    uuid;
  v_stage        text := 'init';
BEGIN
  IF v_actor_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','UNAUTHORIZED', 'error', 'No autenticado'); END IF;
  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_actor_user_id)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND COALESCE(user_id,id)=v_actor_user_id AND COALESCE(is_active,true))) INTO v_is_member;
  IF NOT v_is_member THEN RETURN jsonb_build_object('ok', false, 'error_code','FORBIDDEN', 'error', 'Sin acceso a este negocio'); END IF;
  IF v_key IS NOT NULL AND length(v_key) > c_key_max THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La clave de idempotencia es demasiado larga'); END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El monto debe ser mayor a 0'); END IF;
  -- Metodo via helper CENTRAL (unico catalogo; sin comparar el parametro crudo).
  BEGIN
    v_method := public.normalize_supplier_payment_method(p_payment_method);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'INVALID_PAYMENT_METHOD%' THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Método de pago inválido'); ELSE RAISE; END IF;
  END;
  IF v_method IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Método de pago inválido'); END IF;
  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE id=p_supplier_id AND business_id=p_business_id) THEN
    RETURN jsonb_build_object('ok', false, 'error_code','SUPPLIER_NOT_FOUND', 'error', 'Proveedor no encontrado'); END IF;
  SELECT COALESCE(name, p_supplier_name, '') INTO v_sup_name FROM suppliers WHERE id=p_supplier_id AND business_id=p_business_id;
  v_desc := 'Pago a '||v_sup_name||CASE WHEN v_notes IS NOT NULL THEN ' — '||v_notes ELSE '' END;

  v_payment_date := COALESCE(p_payment_date, public.ar_today());

  IF v_key IS NOT NULL THEN
    v_hash := encode(extensions.digest(jsonb_build_object('op','supplier_free_payment','business_id',p_business_id,
      'supplier_id',p_supplier_id,'supplier_name',NULLIF(btrim(p_supplier_name),''),'amount',round(p_amount,2),
      'payment_date',v_payment_date,'method',v_method,'notes',v_notes,'currency','ARS','exchange_rate',1)::text,'sha256'),'hex');
    SELECT * INTO v_existing FROM supplier_free_payment_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta clave ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'payment_id', v_existing.supplier_payment_id);
    END IF;
  END IF;

  BEGIN PERFORM public.assert_period_open(p_business_id, v_payment_date);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'PERIOD_CLOSED%' THEN RETURN jsonb_build_object('ok', false, 'error_code','PERIOD_CLOSED', 'error', SQLERRM);
    ELSIF SQLERRM LIKE 'INVALID_FINANCE_CONTEXT%' THEN RETURN jsonb_build_object('ok', false, 'error_code','INVALID_FINANCE_CONTEXT', 'error', SQLERRM);
    ELSE RAISE; END IF; END;

  -- Caja SOLO obligatoria para efectivo (misma empresa). Los metodos no-efectivo
  -- (transferencia/tarjeta/cheque/dolares/otro) no exigen caja abierta.
  SELECT id INTO v_caja FROM cajas WHERE business_id=p_business_id AND status='abierta' ORDER BY opened_at DESC LIMIT 1;
  IF v_method='efectivo' AND v_caja IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code','CASH_REGISTER_NOT_OPEN', 'error', 'Debes abrir una caja antes de registrar un pago en efectivo'); END IF;

  IF v_key IS NOT NULL THEN
    INSERT INTO supplier_free_payment_requests (business_id, user_id, op, idempotency_key, request_hash)
      VALUES (p_business_id, v_actor_user_id, 'supplier_free_payment', v_key, v_hash)
      ON CONFLICT (business_id, idempotency_key) DO NOTHING RETURNING id INTO v_req;
    IF v_req IS NULL THEN
      SELECT * INTO v_existing FROM supplier_free_payment_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta clave ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'payment_id', v_existing.supplier_payment_id);
    END IF;
  END IF;

  PERFORM public.finance_begin_audit_scope();

  v_stage := 'write';
  -- supplier_payments (pago libre, sin compra). El saldo del proveedor lo serializa
  -- el advisory lock de trig_supplier_account_movement_balance (no depende del saldo).
  INSERT INTO supplier_payments (business_id, supplier_id, purchase_id, payment_date, amount, payment_method, notes, created_by)
    VALUES (p_business_id, p_supplier_id, NULL, v_payment_date, p_amount, v_method, v_notes, v_actor_user_id) RETURNING id INTO v_pay;
  INSERT INTO supplier_account_movements (business_id, supplier_id, purchase_id, payment_id, movement_date, type, description, debit, credit)
    VALUES (p_business_id, p_supplier_id, NULL, v_pay, v_payment_date, 'payment', v_desc, 0, p_amount) RETURNING id INTO v_credit_id;
  INSERT INTO business_finance_entries (business_id, date, type, category, description, amount, currency, amount_ars, exchange_rate, payment_method, created_by, source)
    VALUES (p_business_id, v_payment_date, 'variable_cost', 'compras_proveedor', v_desc||' ('||v_sup_name||')', p_amount, 'ARS', p_amount, 1, v_method, v_actor_user_id, 'pago_proveedor') RETURNING id INTO v_bfe;
  -- 6D.2a: TODO metodo valido genera exactamente UN financial_movement -> el pago aparece
  -- como salida percibida en el cashflow canonico (v_finance_cashflow lee todos los FM,
  -- sin filtrar por caja; el BFE supplier_liability_payment NO alcanza para el cashflow).
  -- caja_id se resuelve igual que en pay_supplier_purchase: efectivo usa la caja validada;
  -- no-efectivo pasa v_caja (trig_set_movement_caja asigna la caja abierta si existe, si no
  -- queda NULL). NO se reclasifica el metodo como efectivo ni se inventa una caja.
  INSERT INTO financial_movements (business_id, caja_id, date, type, currency, amount, amount_ars, exchange_rate,
    source, description, created_by, metodo_pago, sign, reference_id, reference_type)
    VALUES (p_business_id, v_caja, v_payment_date, 'expense', 'ARS', p_amount, p_amount, 1, 'pago_proveedor',
      v_desc, v_actor_user_id, v_method, 1, v_pay, 'supplier_payment') RETURNING id INTO v_fm;
  UPDATE supplier_payments SET financial_movement_id=v_fm WHERE id=v_pay;

  IF v_key IS NOT NULL THEN UPDATE supplier_free_payment_requests SET supplier_payment_id=v_pay WHERE id=v_req; END IF;

  v_stage := 'audit';
  PERFORM finance_log_audit(p_business_id, 'supplier_free_payment', 'supplier_payments', v_pay, 'pay_supplier_free_atomic',
    v_key, p_notes, v_payment_date, 'supplier', p_supplier_id,
    NULL, jsonb_build_object('payment_id', v_pay, 'supplier_id', p_supplier_id, 'amount', p_amount, 'method', v_method,
      'caja_id', v_caja, 'currency','ARS', 'financial_movement_id', v_fm, 'bfe_id', v_bfe, 'account_movement_id', v_credit_id));

  RETURN jsonb_build_object('ok', true, 'replay', false, 'payment_id', v_pay);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false,
    'error_code', CASE WHEN v_stage='audit' THEN 'AUDIT_FAILED' ELSE 'INTERNAL_ERROR' END,
    'error', CASE WHEN v_stage='audit' THEN 'No se pudo registrar la auditoria de la operacion' ELSE 'No se pudo completar la operacion' END);
END;
$function$;
ALTER FUNCTION "public"."pay_supplier_free_atomic"(uuid,uuid,uuid,text,date,numeric,text,text,text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."pay_supplier_free_atomic"(uuid,uuid,uuid,text,date,numeric,text,text,text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."pay_supplier_free_atomic"(uuid,uuid,uuid,text,date,numeric,text,text,text) TO "authenticated","service_role";

-- ============================================================================
-- ROLLBACK (documentado): recrear versiones M6 (pay_supplier_purchase 9 args sin
-- idempotencia/ownership/guard; pay_supplier_free version rls_lockdown); DROP tabla
-- supplier_purchase_payment_requests + triggers de inmutabilidad; ALTER
-- supplier_free_payment_requests DROP COLUMN op; restaurar grants.
-- ============================================================================
