-- ============================================================================
-- M7 (Bloque 6E.1) — create_quick_inventory_purchase_atomic: ownership real,
-- actor canonico (auth.uid), fecha economica + guard de periodo, idempotencia
-- CONCURRENTE (UNIQUE + ON CONFLICT + request inmutable), serializacion de
-- inventario (SELECT ... FOR UPDATE, politica de ULTIMO costo — cost_price),
-- caja para efectivo, metodo via helper central (mismo catalogo de proveedores),
-- auditoria explicita (quick_inventory_purchase), contrato de error estable,
-- rollback total. Modelo contable M3-M6 INTACTO:
--   comprar inventario NO genera COGS ni gasto operativo (BFE economic_class
--   'inventory_purchase', fuera del P&L); credito = pasivo sin salida; pagada =
--   salida sin duplicar costo; inventario/deuda/caja una sola vez; ningun trigger
--   crea FM/BFE. La compra rapida SI crea una supplier_purchase trazable. Moneda
--   unica ARS (sin p_currency/p_exchange_rate) — se preserva.
-- ============================================================================

-- ── Part A — endurecer quick_purchase_requests ──────────────────────────────
-- (existia dormida: sin UNIQUE(business,key) -> idempotencia rota bajo concurrencia;
--  authenticated con SELECT; sin inmutabilidad. Se corrige aqui.)
ALTER TABLE "public"."quick_purchase_requests" ADD COLUMN IF NOT EXISTS "op" text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='quick_purchase_requests_key_uniq') THEN
    ALTER TABLE "public"."quick_purchase_requests" ADD CONSTRAINT "quick_purchase_requests_key_uniq" UNIQUE ("business_id","idempotency_key");
  END IF;
END $$;
DROP POLICY IF EXISTS "quick_purchase_req_select" ON "public"."quick_purchase_requests";
REVOKE ALL ON "public"."quick_purchase_requests" FROM PUBLIC, "anon", "authenticated";
REVOKE UPDATE, DELETE, TRUNCATE ON "public"."quick_purchase_requests" FROM "service_role";
GRANT SELECT, INSERT ON "public"."quick_purchase_requests" TO "service_role";

CREATE OR REPLACE FUNCTION "public"."quick_purchase_requests_immutable"() RETURNS "trigger"
    LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION '% es append-only: DELETE no permitido', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  IF OLD.purchase_id IS NOT NULL THEN RAISE EXCEPTION '%: request completada es inmutable', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  IF NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.op IS DISTINCT FROM OLD.op THEN
    RAISE EXCEPTION '%: solo se puede completar purchase_id', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  IF NEW.purchase_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM supplier_purchases WHERE id=NEW.purchase_id AND business_id=NEW.business_id) THEN
    RAISE EXCEPTION '%: la entidad enlazada no pertenece al negocio', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  RETURN NEW;
END; $$;
ALTER FUNCTION "public"."quick_purchase_requests_immutable"() OWNER TO "postgres";
DROP TRIGGER IF EXISTS "trg_quick_purchase_requests_immutable" ON "public"."quick_purchase_requests";
CREATE TRIGGER "trg_quick_purchase_requests_immutable"
  BEFORE UPDATE OR DELETE ON "public"."quick_purchase_requests"
  FOR EACH ROW EXECUTE FUNCTION "public"."quick_purchase_requests_immutable"();

-- ── Part B — RPC ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "public"."create_quick_inventory_purchase_atomic"(
  p_business_id uuid, p_idempotency_key text, p_supplier_id uuid, p_supplier_name text,
  p_invoice text, p_date date, p_payment_method text, p_total_ars numeric, p_paid_ars numeric, p_items jsonb
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  c_key_max      constant int := 200;
  v_actor_user_id uuid := auth.uid();
  v_is_member    boolean := false;
  v_key          text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_method       text;
  v_paid         numeric := COALESCE(p_paid_ars, 0);
  v_date         date;
  v_pending      numeric;
  v_status       text;
  v_items_canon  jsonb;
  v_hash         text;
  v_existing     quick_purchase_requests%ROWTYPE;
  v_req_id       uuid;
  v_purchase     uuid;
  v_caja         uuid;
  v_item         jsonb;
  v_prev_stk     integer;
  v_new_stk      integer;
  v_qty          integer;
  v_prev_cost    numeric;
  v_mov_id       uuid;
  v_fm_id        uuid;
  v_bfe_id       uuid;
  v_payment_id   uuid;
  v_debit_id     uuid;
  v_credit_id    uuid;
  v_inv_audit    jsonb := '[]'::jsonb;
  v_inv_count    int := 0;
  v_stage        text := 'init';
BEGIN
  -- 1. Autenticacion
  IF v_actor_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','UNAUTHORIZED', 'error', 'No autenticado'); END IF;
  -- 2/3. Ownership/pertenencia + autorizacion (miembro activo; sin filtro de rol nuevo)
  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_actor_user_id)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND COALESCE(user_id,id)=v_actor_user_id AND COALESCE(is_active,true))) INTO v_is_member;
  IF NOT v_is_member THEN RETURN jsonb_build_object('ok', false, 'error_code','FORBIDDEN', 'error', 'Sin acceso a este negocio'); END IF;

  -- 4. Validacion
  IF v_key IS NOT NULL AND length(v_key) > c_key_max THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La clave de idempotencia es demasiado larga'); END IF;
  IF p_total_ars IS NULL OR p_total_ars <= 0 THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El total debe ser mayor a 0'); END IF;
  IF v_paid < 0 THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El pago no puede ser negativo'); END IF;
  -- 6E.1a: CANTIDADES ENTERAS obligatorias (TechRepair maneja solo unidades enteras).
  -- Sin redondeo ni truncado silencioso de la cantidad. Rechazo ANTES de reservar o escribir.
  -- (a) tipo numerico (rechaza NULL, string, no-numerico); (b) entero >=1 y en rango.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) it
             WHERE jsonb_typeof(it->'quantity') IS DISTINCT FROM 'number') THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La cantidad debe ser un número entero mayor o igual a 1'); END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) it
             WHERE (it->>'quantity')::numeric < 1
                OR (it->>'quantity')::numeric <> trunc((it->>'quantity')::numeric)
                OR (it->>'quantity')::numeric > 1000000) THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La cantidad debe ser un número entero mayor o igual a 1'); END IF;
  -- Costo unitario: numero >= 0
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) it
             WHERE jsonb_typeof(it->'unit_cost_ars') IS DISTINCT FROM 'number' OR (it->>'unit_cost_ars')::numeric < 0) THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El costo unitario debe ser un número mayor o igual a 0'); END IF;
  -- Producto DUPLICADO dentro del payload (mismo inventory_id > 1 vez) -> rechazo (sin agrupar ni sumar)
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) it
             WHERE NULLIF(btrim(it->>'inventory_id'),'') IS NOT NULL
             GROUP BY btrim(it->>'inventory_id') HAVING count(*) > 1) THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El mismo producto no puede aparecer más de una vez'); END IF;
  -- Proveedor del MISMO negocio (si viene)
  IF p_supplier_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM suppliers WHERE id=p_supplier_id AND business_id=p_business_id) THEN
    RETURN jsonb_build_object('ok', false, 'error_code','SUPPLIER_NOT_FOUND', 'error', 'Proveedor inexistente en este negocio'); END IF;
  -- Inventario: N distintos esperados = N encontrados en el negocio (todos existen y pertenecen)
  IF (SELECT count(DISTINCT btrim(it->>'inventory_id')) FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) it WHERE NULLIF(btrim(it->>'inventory_id'),'') IS NOT NULL)
     <> (SELECT count(*) FROM inventory i WHERE i.business_id=p_business_id
           AND i.id IN (SELECT (it2->>'inventory_id')::uuid FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) it2 WHERE NULLIF(btrim(it2->>'inventory_id'),'') IS NOT NULL)) THEN
    RETURN jsonb_build_object('ok', false, 'error_code','INVENTORY_NOT_FOUND', 'error', 'Uno o más productos no existen o no pertenecen al negocio'); END IF;

  -- 5. Normalizacion: fecha economica + metodo via helper CENTRAL de proveedores
  -- (la compra rapida ES una supplier_purchase; comparte exactamente el catalogo PROV_METHODS).
  v_date := COALESCE(p_date, public.ar_today());
  BEGIN
    v_method := public.normalize_supplier_payment_method(p_payment_method);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'INVALID_PAYMENT_METHOD%' THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Método de pago inválido'); ELSE RAISE; END IF;
  END;
  IF v_paid > 0 AND v_method IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Método de pago inválido'); END IF;

  -- 6. Replay (hash canonico jsonb con TODO campo persistido; items ordenados)
  IF v_key IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(elem ORDER BY elem->>'inventory_id', elem->>'product_name', elem->>'quantity', elem->>'unit_cost'), '[]'::jsonb) INTO v_items_canon
    FROM (
      SELECT jsonb_build_object(
        'inventory_id', NULLIF(btrim(it->>'inventory_id'),''),
        'product_name', NULLIF(btrim(it->>'product_name'),''),
        'quantity', (it->>'quantity')::numeric::integer,  -- entero canonico (2 y 2.0 -> mismo hash)
        'unit_cost', round(COALESCE((it->>'unit_cost_ars')::numeric,0),2)) AS elem
      FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) it
    ) s;
    v_hash := encode(extensions.digest(jsonb_build_object(
      'op','quick_inventory_purchase', 'business_id',p_business_id, 'supplier_id',p_supplier_id,
      'supplier_name',NULLIF(btrim(p_supplier_name),''), 'invoice',NULLIF(btrim(p_invoice),''),
      'date',v_date, 'method',v_method, 'total',round(p_total_ars,2), 'paid',round(v_paid,2),
      'currency','ARS', 'exchange_rate',1, 'items',v_items_canon)::text, 'sha256'), 'hex');
    SELECT * INTO v_existing FROM quick_purchase_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta solicitud ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'purchase_id', v_existing.purchase_id);
    END IF;
  END IF;

  -- 7. Guard de periodo (retroactiva en periodo cerrado -> rechazo ANTES de tocar stock)
  BEGIN PERFORM public.assert_period_open(p_business_id, v_date);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'PERIOD_CLOSED%' THEN RETURN jsonb_build_object('ok', false, 'error_code','PERIOD_CLOSED', 'error', SQLERRM);
    ELSIF SQLERRM LIKE 'INVALID_FINANCE_CONTEXT%' THEN RETURN jsonb_build_object('ok', false, 'error_code','INVALID_FINANCE_CONTEXT', 'error', SQLERRM);
    ELSE RAISE; END IF; END;

  -- 7.5 Caja para efectivo (misma empresa; persistida en el FM). No-efectivo: v_caja si hay.
  SELECT id INTO v_caja FROM cajas WHERE business_id=p_business_id AND status='abierta' ORDER BY opened_at DESC LIMIT 1;
  IF v_paid > 0 AND v_method = 'efectivo' AND v_caja IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code','CASH_REGISTER_NOT_OPEN', 'error', 'Debes abrir una caja antes de registrar un pago en efectivo'); END IF;

  -- 8. Reserva idempotente race-safe (UNIQUE + ON CONFLICT DO NOTHING)
  IF v_key IS NOT NULL THEN
    INSERT INTO quick_purchase_requests (business_id, user_id, op, idempotency_key, request_hash)
      VALUES (p_business_id, v_actor_user_id, 'quick_inventory_purchase', v_key, v_hash)
      ON CONFLICT (business_id, idempotency_key) DO NOTHING RETURNING id INTO v_req_id;
    IF v_req_id IS NULL THEN
      SELECT * INTO v_existing FROM quick_purchase_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta solicitud ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'purchase_id', v_existing.purchase_id);
    END IF;
  END IF;

  -- 9. Scope de auditoria
  PERFORM public.finance_begin_audit_scope();

  -- 10. Escrituras (todas con v_date; modelo M3-M6 intacto)
  v_stage := 'write';
  v_pending := GREATEST(0, p_total_ars - v_paid);
  v_status  := CASE WHEN v_paid<=0 THEN 'pending' WHEN v_paid >= p_total_ars - 0.01 THEN 'paid' ELSE 'partial' END;

  INSERT INTO supplier_purchases (business_id, supplier_id, purchase_date, invoice_number,
    total_amount, paid_amount, pending_amount, payment_status, payment_method, notes, created_by)
  VALUES (p_business_id, p_supplier_id, v_date, NULLIF(btrim(COALESCE(p_invoice,'')),''),
    p_total_ars, v_paid, v_pending, v_status, v_method, 'Compra rápida de inventario', v_actor_user_id)
  RETURNING id INTO v_purchase;

  -- Lock DETERMINISTA de TODAS las filas de inventario del payload, en orden global por id,
  -- ANTES de actualizar la primera. Evita deadlocks entre compras con productos en distinto
  -- orden (Sesion1 [A,B] vs Sesion2 [B,A]). Los locks se mantienen hasta el fin de la tx.
  --   PERFORM 1 FROM inventory WHERE business_id=... AND id IN (...ids...) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM inventory
    WHERE business_id=p_business_id
      AND id IN (SELECT (it->>'inventory_id')::uuid FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) it WHERE NULLIF(btrim(it->>'inventory_id'),'') IS NOT NULL)
    ORDER BY id
    FOR UPDATE;

  -- Items + entrada de inventario. Cantidad ENTERA validada (v_qty); stock y costo se
  -- calculan desde la fila ya BLOQUEADA arriba (no se releen valores sin lock).
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb))
  LOOP
    v_qty := (v_item->>'quantity')::numeric::integer;  -- entero validado (>=1, sin fraccion); ::numeric::int acepta "2.0"
    INSERT INTO supplier_purchase_items (business_id, purchase_id, supplier_id, inventory_id,
      product_name, quantity, unit_cost, subtotal)
    VALUES (p_business_id, v_purchase, p_supplier_id, NULLIF(btrim(v_item->>'inventory_id'),'')::uuid,
      v_item->>'product_name', v_qty, (v_item->>'unit_cost_ars')::numeric,
      v_qty * (v_item->>'unit_cost_ars')::numeric);

    IF NULLIF(btrim(v_item->>'inventory_id'),'') IS NOT NULL THEN
      SELECT stock_quantity, cost_price INTO v_prev_stk, v_prev_cost FROM inventory
        WHERE id=(v_item->>'inventory_id')::uuid AND business_id=p_business_id;  -- ya bloqueada arriba
      v_new_stk := COALESCE(v_prev_stk,0) + v_qty;
      UPDATE inventory SET stock_quantity=v_new_stk, stock=v_new_stk,
        cost_price=(v_item->>'unit_cost_ars')::numeric, updated_at=now()
        WHERE id=(v_item->>'inventory_id')::uuid AND business_id=p_business_id;
      INSERT INTO inventory_movements (business_id, inventory_item_id, movement_type, quantity,
        previous_stock, new_stock, reference_type, reference_id, note, created_by, supplier_id, unit_cost, currency, exchange_rate)
      VALUES (p_business_id, (v_item->>'inventory_id')::uuid, 'purchase',
        v_qty, COALESCE(v_prev_stk,0), v_new_stk,
        'supplier_purchase', v_purchase, 'Compra rápida', v_actor_user_id, p_supplier_id,
        (v_item->>'unit_cost_ars')::numeric, 'ARS', 1) RETURNING id INTO v_mov_id;
      v_inv_count := v_inv_count + 1;
      v_inv_audit := v_inv_audit || jsonb_build_object('inventory_id', v_item->>'inventory_id',
        'quantity', v_qty, 'prev_stock', COALESCE(v_prev_stk,0), 'new_stock', v_new_stk,
        'prev_cost', v_prev_cost, 'new_cost', round((v_item->>'unit_cost_ars')::numeric,2), 'inventory_movement_id', v_mov_id);
    END IF;
  END LOOP;

  -- Deuda a proveedor (si hay proveedor): debito por el total. UNA vez.
  IF p_supplier_id IS NOT NULL THEN
    INSERT INTO supplier_account_movements (business_id, supplier_id, purchase_id, payment_id,
      movement_date, type, description, debit, credit, balance_after)
    VALUES (p_business_id, p_supplier_id, v_purchase, NULL, v_date, 'purchase', 'Compra rápida', p_total_ars, 0, 0)
    RETURNING id INTO v_debit_id;
  END IF;

  -- Pago inicial (si v_paid>0): FM salida + BFE tecnica (inventory_purchase, fuera del P&L)
  -- + supplier_payment + credito. Sin duplicar costo (no COGS al comprar).
  IF v_paid > 0 THEN
    INSERT INTO financial_movements (business_id, caja_id, date, type, currency, amount, amount_ars, exchange_rate,
      source, description, created_by, metodo_pago, sign, reference_id, reference_type)
    VALUES (p_business_id, v_caja, v_date, 'expense', 'ARS', v_paid, v_paid, 1, 'pago_proveedor',
      'Compra rápida de inventario' || COALESCE(' — '||p_supplier_name,''), v_actor_user_id, v_method, 1, v_purchase, 'supplier_purchase')
    RETURNING id INTO v_fm_id;
    INSERT INTO business_finance_entries (business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate, payment_method, source, created_by, economic_class)
    VALUES (p_business_id, v_date, 'variable_cost', 'inventario', 'Compra de inventario' || COALESCE(' — '||p_supplier_name,''),
      v_paid, 'ARS', v_paid, 1, v_method, 'pago_proveedor', v_actor_user_id, 'inventory_purchase')
    RETURNING id INTO v_bfe_id;
    IF p_supplier_id IS NOT NULL THEN
      INSERT INTO supplier_payments (business_id, supplier_id, purchase_id, payment_date,
        amount, payment_method, notes, created_by, financial_movement_id)
      VALUES (p_business_id, p_supplier_id, v_purchase, v_date, v_paid, v_method, 'Compra rápida', v_actor_user_id, v_fm_id)
      RETURNING id INTO v_payment_id;
      INSERT INTO supplier_account_movements (business_id, supplier_id, purchase_id, payment_id,
        movement_date, type, description, debit, credit, balance_after)
      VALUES (p_business_id, p_supplier_id, v_purchase, v_payment_id, v_date, 'payment', 'Pago compra rápida', 0, v_paid, 0)
      RETURNING id INTO v_credit_id;
    END IF;
  END IF;

  -- 12. Enlace del request
  IF v_key IS NOT NULL THEN UPDATE quick_purchase_requests SET purchase_id=v_purchase WHERE id=v_req_id; END IF;

  -- 13. Auditoria explicita (evento de negocio: la compra rapida). Sin payloads enormes.
  v_stage := 'audit';
  PERFORM finance_log_audit(
    p_business_id, 'quick_inventory_purchase', 'supplier_purchases', v_purchase, 'create_quick_inventory_purchase_atomic',
    v_key, 'Compra rápida de inventario', v_date, 'supplier_purchase', v_purchase,
    NULL, jsonb_build_object('supplier_id', p_supplier_id, 'total', p_total_ars, 'paid_amount', v_paid,
      'pending_amount', v_pending, 'payment_status', v_status, 'method', v_method, 'caja_id', v_caja,
      'currency','ARS', 'exchange_rate',1, 'item_count', COALESCE(jsonb_array_length(p_items),0),
      'inventory_items', v_inv_count, 'inventory', v_inv_audit,
      'financial_movement_id', v_fm_id, 'bfe_id', v_bfe_id, 'supplier_payment_id', v_payment_id,
      'supplier_debit_movement_id', v_debit_id, 'supplier_credit_movement_id', v_credit_id));

  RETURN jsonb_build_object('ok', true, 'replay', false, 'purchase_id', v_purchase);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false,
    'error_code', CASE WHEN v_stage='audit' THEN 'AUDIT_FAILED' ELSE 'INTERNAL_ERROR' END,
    'error', CASE WHEN v_stage='audit' THEN 'No se pudo registrar la auditoria de la operacion'
                  ELSE 'No se pudo completar la operacion' END);
END;
$function$;
ALTER FUNCTION "public"."create_quick_inventory_purchase_atomic"(uuid,text,uuid,text,text,date,text,numeric,numeric,jsonb) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."create_quick_inventory_purchase_atomic"(uuid,text,uuid,text,text,date,text,numeric,numeric,jsonb) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."create_quick_inventory_purchase_atomic"(uuid,text,uuid,text,text,date,text,numeric,numeric,jsonb) TO "authenticated","service_role";

-- ============================================================================
-- ROLLBACK (documentado): recrear la version dormida (20260705100000) sin guard/
-- audit/error_code; DROP CONSTRAINT quick_purchase_requests_key_uniq; DROP trigger +
-- funcion quick_purchase_requests_immutable; ALTER quick_purchase_requests DROP COLUMN op;
-- restaurar policy/grant SELECT a authenticated.
-- ============================================================================
