-- ============================================================================
-- M7 (Bloque 6D.1) — create_supplier_purchase_atomic: ownership real, guard de
-- periodo, idempotencia endurecida, auditoria explicita, contrato de error.
--
-- NO se altera el modelo contable M3-M6: la compra NO genera COGS al adquirir;
-- credito = pasivo sin salida de caja; pagada = salida de caja sin duplicar costo;
-- inventario y deuda se actualizan exactamente una vez (ningun trigger crea FM/BFE:
-- verificado — supplier_payments/supplier_account_movements/inventory_movements sin
-- triggers de finanzas; solo balance de CC + sync de stock).
--
-- Modelo actual (preservado): moneda ARS unica (sin p_currency/p_exchange_rate);
-- el pago a proveedor NO exige caja abierta (la caja la asigna trig_set_movement_caja
-- si existe) — NO se agrega CASH_REGISTER_NOT_OPEN (evitar politica nueva, cf. 6C.1).
-- Roles: se preserva "miembro activo" (rutas /suppliers y /expenses bajo
-- ProtectedRoute base, sin gate de rol). Backlog: restringir a owner/admin/manager.
-- ============================================================================

-- ── Endurecer supplier_purchase_requests ────────────────────────────────────
ALTER TABLE "public"."supplier_purchase_requests" ADD COLUMN IF NOT EXISTS "op" text;
DROP POLICY IF EXISTS "supplier_purchase_req_select" ON "public"."supplier_purchase_requests";
REVOKE ALL ON "public"."supplier_purchase_requests" FROM PUBLIC, "anon", "authenticated";
REVOKE UPDATE, DELETE, TRUNCATE ON "public"."supplier_purchase_requests" FROM "service_role";
GRANT SELECT, INSERT ON "public"."supplier_purchase_requests" TO "service_role";

CREATE OR REPLACE FUNCTION "public"."supplier_purchase_requests_immutable"() RETURNS "trigger"
    LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'supplier_purchase_requests es append-only: DELETE no permitido' USING ERRCODE='0A000'; END IF;
  IF OLD.purchase_id IS NOT NULL THEN RAISE EXCEPTION 'supplier_purchase_requests: request completada es inmutable' USING ERRCODE='0A000'; END IF;
  IF NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.op IS DISTINCT FROM OLD.op THEN
    RAISE EXCEPTION 'supplier_purchase_requests: solo se puede completar purchase_id' USING ERRCODE='0A000'; END IF;
  IF NEW.purchase_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM supplier_purchases WHERE id=NEW.purchase_id AND business_id=NEW.business_id) THEN
    RAISE EXCEPTION 'supplier_purchase_requests: la entidad enlazada no pertenece al negocio' USING ERRCODE='0A000'; END IF;
  RETURN NEW;
END; $$;
ALTER FUNCTION "public"."supplier_purchase_requests_immutable"() OWNER TO "postgres";
DROP TRIGGER IF EXISTS "trg_supplier_purchase_requests_immutable" ON "public"."supplier_purchase_requests";
CREATE TRIGGER "trg_supplier_purchase_requests_immutable"
  BEFORE UPDATE OR DELETE ON "public"."supplier_purchase_requests"
  FOR EACH ROW EXECUTE FUNCTION "public"."supplier_purchase_requests_immutable"();

-- ── RPC ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "public"."create_supplier_purchase_atomic"(
  p_business_id uuid, p_supplier_id uuid, p_user_id uuid, p_supplier_name text,
  p_purchase_date date, p_invoice_number text, p_total_amount numeric, p_paid_amount numeric,
  p_payment_method text, p_notes text, p_items jsonb, p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  c_key_max      constant int := 200;
  v_actor_user_id         uuid := auth.uid();
  v_is_member    boolean := false;
  v_purchase_date date;
  v_paid         numeric := COALESCE(p_paid_amount, 0);
  v_pending      numeric;
  v_status       text;
  v_method       text;
  v_key          text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_hash         text;
  v_items_canon  jsonb;
  v_existing     supplier_purchase_requests%ROWTYPE;
  v_req_id       uuid;
  v_purchase     record;
  v_item         jsonb;
  v_payment      record;
  v_fm           record;
  v_fm_id        uuid;
  v_bfe_id       uuid;
  v_payment_id   uuid;
  v_debit_id     uuid;
  v_credit_id    uuid;
  v_caja         uuid;
  v_prev_stk     integer;
  v_new_stk      integer;
  v_inv_num      text;
  v_desc_sfx     text;
  v_item_count   int := COALESCE(jsonb_array_length(p_items), 0);
  v_inv_items    int := 0;
  v_stage        text := 'init';
BEGIN
  -- 1. Autenticacion
  IF v_actor_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','UNAUTHORIZED', 'error', 'No autenticado'); END IF;
  -- 2. Ownership/pertenencia (miembro activo; sin filtro de rol — comportamiento previo)
  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_actor_user_id)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND COALESCE(user_id,id)=v_actor_user_id AND COALESCE(is_active,true))) INTO v_is_member;
  IF NOT v_is_member THEN RETURN jsonb_build_object('ok', false, 'error_code','FORBIDDEN', 'error', 'Sin acceso a este negocio'); END IF;
  -- 3. Validacion del payload
  IF v_key IS NOT NULL AND length(v_key) > c_key_max THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La clave de idempotencia es demasiado larga'); END IF;
  IF p_total_amount IS NULL OR p_total_amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'total_amount debe ser mayor a 0'); END IF;
  IF v_paid < 0 THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El pago no puede ser negativo'); END IF;
  -- Proveedor del MISMO negocio (aislamiento real)
  IF p_supplier_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM suppliers WHERE id=p_supplier_id AND business_id=p_business_id) THEN
    RETURN jsonb_build_object('ok', false, 'error_code','SUPPLIER_NOT_FOUND', 'error', 'Proveedor inexistente en este negocio'); END IF;
  -- Cantidad valida por item
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) it WHERE COALESCE((it->>'quantity')::numeric,0) <= 0) THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Cantidad invalida en un item'); END IF;
  -- Productos del MISMO negocio (los que traen inventory_id)
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) it
             WHERE NULLIF(btrim(it->>'inventory_id'),'') IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM inventory i WHERE i.id=(it->>'inventory_id')::uuid AND i.business_id=p_business_id)) THEN
    RETURN jsonb_build_object('ok', false, 'error_code','PRODUCT_NOT_FOUND', 'error', 'Producto inexistente en este negocio'); END IF;

  -- 3.5 Metodo de pago via helper CENTRAL (mismo catalogo que las RPC de pago; sin
  -- comparar el parametro crudo). Con pago inicial (paid>0) el metodo es obligatorio;
  -- a deuda (paid=0) admite NULL (no hay pago). El valor canonico se usa para hash,
  -- decision de caja, persistencia y auditoria.
  BEGIN
    v_method := public.normalize_supplier_payment_method(p_payment_method);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'INVALID_PAYMENT_METHOD%' THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Método de pago inválido'); ELSE RAISE; END IF;
  END;
  IF v_paid > 0 AND v_method IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Método de pago inválido'); END IF;

  -- 4. Fecha economica unica
  v_purchase_date := COALESCE(p_purchase_date, public.ar_today());

  -- 5. Replay previo (hash canonico jsonb; items ordenados canonicamente)
  IF v_key IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(elem ORDER BY elem->>'inventory_id', elem->>'product_name', elem->>'quantity', elem->>'unit_cost'), '[]'::jsonb) INTO v_items_canon
    FROM (
      SELECT jsonb_build_object(
        'inventory_id', NULLIF(btrim(it->>'inventory_id'),''),
        'product_name', NULLIF(btrim(it->>'product_name'),''),
        'quantity', round(COALESCE((it->>'quantity')::numeric,0),4),
        'unit_cost', round(COALESCE((it->>'unit_cost')::numeric,0),2)) AS elem
      FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) it
    ) s;
    v_hash := encode(extensions.digest(jsonb_build_object(
      'op','supplier_purchase', 'business_id',p_business_id, 'supplier_id',p_supplier_id,
      'supplier_name',NULLIF(btrim(p_supplier_name),''),
      'purchase_date',v_purchase_date, 'invoice',NULLIF(btrim(p_invoice_number),''),
      'total',round(p_total_amount,2), 'paid',round(v_paid,2), 'currency','ARS', 'exchange_rate',1,
      'method',v_method, 'notes',NULLIF(btrim(p_notes),''),
      'items',v_items_canon)::text, 'sha256'), 'hex');
    SELECT * INTO v_existing FROM supplier_purchase_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta clave ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'purchase_id', v_existing.purchase_id);
    END IF;
  END IF;

  -- 6. Guard de periodo
  BEGIN
    PERFORM public.assert_period_open(p_business_id, v_purchase_date);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'PERIOD_CLOSED%' THEN RETURN jsonb_build_object('ok', false, 'error_code','PERIOD_CLOSED', 'error', SQLERRM);
    ELSIF SQLERRM LIKE 'INVALID_FINANCE_CONTEXT%' THEN RETURN jsonb_build_object('ok', false, 'error_code','INVALID_FINANCE_CONTEXT', 'error', SQLERRM);
    ELSE RAISE; END IF;
  END;

  -- 6.5 Caja para efectivo (ANTES de reservar/escribir). Un pago en efectivo exige
  -- una caja abierta del MISMO negocio (WHERE business_id=p_business_id). Transferencia
  -- y metodos no-efectivo conservan el comportamiento M6 (usan la caja abierta si hay,
  -- o quedan sin caja). El FM persiste esta misma caja validada.
  SELECT id INTO v_caja FROM cajas WHERE business_id=p_business_id AND status='abierta' ORDER BY opened_at DESC LIMIT 1;
  IF v_paid > 0 AND v_method = 'efectivo' AND v_caja IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code','CASH_REGISTER_NOT_OPEN', 'error', 'Debes abrir una caja antes de registrar un pago en efectivo');
  END IF;

  -- 7. Reserva idempotente race-safe
  IF v_key IS NOT NULL THEN
    INSERT INTO supplier_purchase_requests (business_id, user_id, op, idempotency_key, request_hash)
      VALUES (p_business_id, v_actor_user_id, 'supplier_purchase', v_key, v_hash)
      ON CONFLICT (business_id, idempotency_key) DO NOTHING RETURNING id INTO v_req_id;
    IF v_req_id IS NULL THEN
      SELECT * INTO v_existing FROM supplier_purchase_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta clave ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'purchase_id', v_existing.purchase_id);
    END IF;
  END IF;

  -- 8. Scope de auditoria
  PERFORM public.finance_begin_audit_scope();

  -- 9. Escrituras economicas (todas con v_purchase_date; modelo M3-M6 intacto)
  v_stage := 'write';
  v_inv_num  := NULLIF(trim(COALESCE(p_invoice_number, '')), '');
  v_desc_sfx := COALESCE(' #' || v_inv_num, '');
  v_pending  := GREATEST(0, p_total_amount - v_paid);
  IF v_paid <= 0                          THEN v_status := 'pending';
  ELSIF v_paid >= p_total_amount - 0.01   THEN v_status := 'paid';
  ELSE v_status := 'partial'; END IF;

  INSERT INTO public.supplier_purchases (business_id, supplier_id, purchase_date, invoice_number,
    total_amount, paid_amount, pending_amount, payment_status, payment_method, notes, created_by)
  VALUES (p_business_id, p_supplier_id, v_purchase_date, v_inv_num, p_total_amount, v_paid, v_pending, v_status,
    v_method, NULLIF(trim(COALESCE(p_notes, '')), ''), v_actor_user_id)
  RETURNING * INTO v_purchase;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    INSERT INTO public.supplier_purchase_items (business_id, purchase_id, supplier_id, inventory_id,
      product_name, quantity, unit_cost, subtotal)
    VALUES (p_business_id, v_purchase.id, p_supplier_id, NULLIF(trim(COALESCE(v_item->>'inventory_id', '')), '')::uuid,
      v_item->>'product_name', (v_item->>'quantity')::numeric, (v_item->>'unit_cost')::numeric,
      (v_item->>'quantity')::numeric * (v_item->>'unit_cost')::numeric);

    IF NULLIF(trim(COALESCE(v_item->>'inventory_id','')),'') IS NOT NULL THEN
      SELECT stock_quantity INTO v_prev_stk FROM public.inventory WHERE id=(v_item->>'inventory_id')::uuid AND business_id=p_business_id;
      IF FOUND THEN
        v_inv_items := v_inv_items + 1;
        v_new_stk := COALESCE(v_prev_stk, 0) + FLOOR((v_item->>'quantity')::numeric)::integer;
        UPDATE public.inventory SET stock_quantity=v_new_stk, stock=v_new_stk, cost_price=(v_item->>'unit_cost')::numeric, updated_at=now()
          WHERE id=(v_item->>'inventory_id')::uuid AND business_id=p_business_id;
        INSERT INTO public.inventory_movements (inventory_item_id, movement_type, quantity, previous_stock, new_stock,
          reference_type, reference_id, note, business_id, created_by, supplier_id, unit_cost, currency, exchange_rate)
        VALUES ((v_item->>'inventory_id')::uuid, 'purchase', FLOOR((v_item->>'quantity')::numeric)::integer,
          COALESCE(v_prev_stk, 0), v_new_stk, 'supplier_purchase', v_purchase.id,
          'Compra a ' || COALESCE(p_supplier_name,'') || v_desc_sfx, p_business_id, v_actor_user_id, p_supplier_id,
          (v_item->>'unit_cost')::numeric, 'ARS', 1);
      END IF;
    END IF;
  END LOOP;

  -- Deuda con proveedor (pasivo): debito por el total. UNA vez.
  INSERT INTO public.supplier_account_movements (business_id, supplier_id, purchase_id, payment_id,
    movement_date, type, description, debit, credit, balance_after)
  VALUES (p_business_id, p_supplier_id, v_purchase.id, NULL, v_purchase_date, 'purchase', 'Compra' || v_desc_sfx, p_total_amount, 0, 0)
  RETURNING id INTO v_debit_id;

  -- Pago inicial (solo si v_paid>0): salida de caja + credito de deuda. Sin duplicar costo.
  IF v_paid > 0 THEN
    INSERT INTO public.financial_movements (business_id, caja_id, date, type, currency, amount, amount_ars, exchange_rate,
      source, description, created_by, metodo_pago, sign, reference_id, reference_type)
    VALUES (p_business_id, v_caja, v_purchase_date, 'expense', 'ARS', v_paid, v_paid, 1, 'pago_proveedor',
      'Compra a ' || COALESCE(p_supplier_name,'') || v_desc_sfx, v_actor_user_id, v_method,
      1, v_purchase.id, 'supplier_purchase') RETURNING * INTO v_fm;
    v_fm_id := v_fm.id;
    INSERT INTO public.business_finance_entries (business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate, payment_method, created_by, source)
    VALUES (p_business_id, v_purchase_date, 'variable_cost', 'compras_proveedor',
      'Compra a ' || COALESCE(p_supplier_name,'') || v_desc_sfx, v_paid, 'ARS', v_paid, 1,
      v_method, v_actor_user_id, 'pago_proveedor') RETURNING id INTO v_bfe_id;
    INSERT INTO public.supplier_payments (business_id, supplier_id, purchase_id, payment_date,
      amount, payment_method, notes, created_by, financial_movement_id)
    VALUES (p_business_id, p_supplier_id, v_purchase.id, v_purchase_date, v_paid,
      v_method, 'Pago inicial al crear compra' || v_desc_sfx, v_actor_user_id, v_fm.id)
    RETURNING * INTO v_payment;
    v_payment_id := v_payment.id;
    INSERT INTO public.supplier_account_movements (business_id, supplier_id, purchase_id, payment_id,
      movement_date, type, description, debit, credit, balance_after)
    VALUES (p_business_id, p_supplier_id, v_purchase.id, v_payment.id, v_purchase_date, 'payment', 'Pago inicial compra' || v_desc_sfx, 0, v_paid, 0)
    RETURNING id INTO v_credit_id;
  END IF;

  -- 10/11. Enlace del request
  IF v_key IS NOT NULL THEN UPDATE supplier_purchase_requests SET purchase_id=v_purchase.id WHERE id=v_req_id; END IF;

  -- 12. Auditoria explicita (un evento agregado de negocio: la compra)
  v_stage := 'audit';
  PERFORM finance_log_audit(
    p_business_id, 'supplier_purchase', 'supplier_purchases', v_purchase.id, 'create_supplier_purchase_atomic',
    v_key, p_notes, v_purchase_date, 'supplier_purchase', v_purchase.id,
    NULL, jsonb_build_object('supplier_id', p_supplier_id, 'total', p_total_amount, 'currency','ARS', 'exchange_rate',1,
      'total_ars', p_total_amount, 'paid_amount', v_paid, 'pending_amount', v_pending, 'payment_status', v_status,
      'method', v_method, 'item_count', v_item_count, 'inventory_items', v_inv_items,
      'financial_movement_id', v_fm_id, 'bfe_id', v_bfe_id, 'supplier_payment_id', v_payment_id,
      'supplier_debit_movement_id', v_debit_id, 'supplier_credit_movement_id', v_credit_id, 'caja_id', v_caja));

  -- 13. Retorno
  RETURN jsonb_build_object('ok', true, 'replay', false, 'purchase_id', v_purchase.id);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false,
    'error_code', CASE WHEN v_stage='audit' THEN 'AUDIT_FAILED' ELSE 'INTERNAL_ERROR' END,
    'error', CASE WHEN v_stage='audit' THEN 'No se pudo registrar la auditoria de la operacion'
                  ELSE 'No se pudo completar la operacion' END);
END;
$function$;
ALTER FUNCTION "public"."create_supplier_purchase_atomic"(uuid,uuid,uuid,text,date,text,numeric,numeric,text,text,jsonb,text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."create_supplier_purchase_atomic"(uuid,uuid,uuid,text,date,text,numeric,numeric,text,text,jsonb,text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."create_supplier_purchase_atomic"(uuid,uuid,uuid,text,date,text,numeric,numeric,text,text,jsonb,text) TO "authenticated","service_role";

-- ============================================================================
-- ROLLBACK (documentado): recrear la version M6 (sin ownership/guard/audit);
-- DROP trigger + funcion de inmutabilidad; ALTER supplier_purchase_requests DROP
-- COLUMN op; restaurar policy/grants M6.
-- ============================================================================
