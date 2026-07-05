-- ============================================================================
-- Fix — idempotencia de create_quick_inventory_purchase_atomic ligada al payload
--
-- PROBLEMA: quick_purchase_requests guardaba solo la idempotency_key, sin hash
-- del contenido. Una misma key con payload DISTINTO recibía el purchase_id
-- anterior (replay) como si fuera éxito, aunque sus datos nunca se procesaron.
--
-- CONTRATO CORRECTO:
--   misma key + mismo payload    → replay de la operación original
--   misma key + payload distinto → IDEMPOTENCY_CONFLICT (error funcional)
--
-- El hash se reconstruye SERVER-SIDE desde los argumentos recibidos (no se
-- confía en un hash del cliente), con el mismo patrón probado del checkout
-- (extensions.digest sha256 sobre una representación canónica). Canoniza:
-- business_id, supplier_id, supplier_name, invoice, date, payment_method,
-- total_ars, paid_ars e items (inventory_id, product_name, quantity,
-- unit_cost_ars) — ordenados de forma determinística, null/'' normalizados a un
-- centinela, números redondeados (money 2 / cantidad 4) para no depender del
-- formato textual del cliente. No incluye timestamps ni campos decorativos.
-- ============================================================================

-- ── 1. Columna de hash (tabla creada en 20260704101000, aún no desplegada) ──
ALTER TABLE "public"."quick_purchase_requests"
  ADD COLUMN IF NOT EXISTS "request_hash" text NOT NULL DEFAULT '';
-- El default '' sólo cubre filas preexistentes (no hay en un deploy limpio);
-- la RPC SIEMPRE escribe el hash real. Se quita el default para que un insert
-- futuro sin hash falle en vez de guardar '' silenciosamente.
ALTER TABLE "public"."quick_purchase_requests" ALTER COLUMN "request_hash" DROP DEFAULT;

-- ── 2. RPC con hash canónico + replay/conflict ──────────────────────────────
CREATE OR REPLACE FUNCTION "public"."create_quick_inventory_purchase_atomic"(
  "p_business_id"     uuid,
  "p_idempotency_key" text,
  "p_supplier_id"     uuid,
  "p_supplier_name"   text,
  "p_invoice"         text,
  "p_date"            date,
  "p_payment_method"  text,
  "p_total_ars"       numeric,
  "p_paid_ars"        numeric,
  "p_items"           jsonb
) RETURNS jsonb
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user_id    uuid := auth.uid();
  v_has_access boolean := false;
  v_existing   quick_purchase_requests%ROWTYPE;
  v_req_id     uuid;
  v_purchase   uuid;
  v_date       date := COALESCE(p_date, public.ar_today());
  v_pending    numeric := GREATEST(0, COALESCE(p_total_ars,0) - COALESCE(p_paid_ars,0));
  v_status     text;
  v_item       jsonb;
  v_prev_stk   integer;
  v_new_stk    integer;
  v_fm_id      uuid;
  v_items_canon text;
  v_request_hash text;
BEGIN
  IF v_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'No autenticado'); END IF;
  IF p_total_ars IS NULL OR p_total_ars <= 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'total debe ser mayor a 0'); END IF;
  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key))=0 THEN RETURN jsonb_build_object('ok', false, 'error', 'idempotency_key requerida'); END IF;

  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user_id)
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND user_id=v_user_id AND COALESCE(is_active,true))
  ) INTO v_has_access;
  IF NOT v_has_access THEN RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio'); END IF;

  -- ── Hash canónico del payload (server-side) ────────────────────────────────
  -- Items ordenados determinísticamente; null/'' → '∅'; money round 2 / qty 4.
  SELECT string_agg(line, '|' ORDER BY line) INTO v_items_canon
  FROM (
    SELECT COALESCE(NULLIF(it->>'inventory_id',''),'∅') || ':' ||
           COALESCE(NULLIF(btrim(it->>'product_name'),''),'∅') || ':' ||
           round(COALESCE((it->>'quantity')::numeric,0),4)::text || ':' ||
           round(COALESCE((it->>'unit_cost_ars')::numeric,0),2)::text AS line
    FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) it
  ) s;

  v_request_hash := encode(extensions.digest(
    p_business_id::text || '§' ||
    COALESCE(p_supplier_id::text,'∅') || '§' ||
    COALESCE(NULLIF(btrim(p_supplier_name),''),'∅') || '§' ||
    COALESCE(NULLIF(btrim(p_invoice),''),'∅') || '§' ||
    v_date::text || '§' ||
    COALESCE(NULLIF(btrim(p_payment_method),''),'∅') || '§' ||
    round(COALESCE(p_total_ars,0),2)::text || '§' ||
    round(COALESCE(p_paid_ars,0),2)::text || '§' ||
    COALESCE(v_items_canon,'∅')
  , 'sha256'), 'hex');

  -- ── Idempotencia: replay si mismo hash, conflicto si distinto ──────────────
  SELECT * INTO v_existing FROM quick_purchase_requests
    WHERE business_id=p_business_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_hash IS DISTINCT FROM v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_CONFLICT',
        'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.');
    END IF;
    RETURN jsonb_build_object('ok', true, 'replay', true, 'purchase_id', v_existing.purchase_id);
  END IF;

  -- El INSERT es el lock: dos conexiones con la misma key se serializan acá.
  BEGIN
    INSERT INTO quick_purchase_requests (business_id, user_id, idempotency_key, request_hash)
      VALUES (p_business_id, v_user_id, p_idempotency_key, v_request_hash) RETURNING id INTO v_req_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_existing FROM quick_purchase_requests
      WHERE business_id=p_business_id AND idempotency_key=p_idempotency_key;
    IF v_existing.request_hash IS DISTINCT FROM v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_CONFLICT',
        'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.');
    END IF;
    RETURN jsonb_build_object('ok', true, 'replay', true, 'purchase_id', v_existing.purchase_id);
  END;

  v_status := CASE WHEN COALESCE(p_paid_ars,0)<=0 THEN 'pending'
                   WHEN p_paid_ars >= p_total_ars - 0.01 THEN 'paid' ELSE 'partial' END;

  -- 1. Compra trazable
  INSERT INTO supplier_purchases (business_id, supplier_id, purchase_date, invoice_number,
    total_amount, paid_amount, pending_amount, payment_status, payment_method, notes, created_by)
  VALUES (p_business_id, p_supplier_id, v_date, NULLIF(trim(COALESCE(p_invoice,'')),''),
    p_total_ars, COALESCE(p_paid_ars,0), v_pending, v_status,
    NULLIF(trim(COALESCE(p_payment_method,'')),''), 'Compra rápida de inventario', v_user_id)
  RETURNING id INTO v_purchase;

  -- 2. Ítems + entrada de inventario
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb))
  LOOP
    INSERT INTO supplier_purchase_items (business_id, purchase_id, supplier_id, inventory_id,
      product_name, quantity, unit_cost, subtotal)
    VALUES (p_business_id, v_purchase, p_supplier_id, NULLIF(v_item->>'inventory_id','')::uuid,
      v_item->>'product_name', (v_item->>'quantity')::numeric, (v_item->>'unit_cost_ars')::numeric,
      (v_item->>'quantity')::numeric * (v_item->>'unit_cost_ars')::numeric);

    IF NULLIF(v_item->>'inventory_id','') IS NOT NULL THEN
      SELECT stock_quantity INTO v_prev_stk FROM inventory
        WHERE id=(v_item->>'inventory_id')::uuid AND business_id=p_business_id FOR UPDATE;
      IF FOUND THEN
        v_new_stk := COALESCE(v_prev_stk,0) + FLOOR((v_item->>'quantity')::numeric)::integer;
        UPDATE inventory SET stock_quantity=v_new_stk, stock=v_new_stk,
          cost_price=(v_item->>'unit_cost_ars')::numeric, updated_at=now()
          WHERE id=(v_item->>'inventory_id')::uuid AND business_id=p_business_id;
        INSERT INTO inventory_movements (business_id, inventory_item_id, movement_type, quantity,
          previous_stock, new_stock, reference_type, reference_id, note, created_by, supplier_id, unit_cost, currency, exchange_rate)
        VALUES (p_business_id, (v_item->>'inventory_id')::uuid, 'purchase',
          FLOOR((v_item->>'quantity')::numeric)::integer, COALESCE(v_prev_stk,0), v_new_stk,
          'supplier_purchase', v_purchase, 'Compra rápida', v_user_id, p_supplier_id,
          (v_item->>'unit_cost_ars')::numeric, 'ARS', 1);
      END IF;
    END IF;
  END LOOP;

  -- 3. Deuda a proveedor (si hay proveedor): débito por total
  IF p_supplier_id IS NOT NULL THEN
    INSERT INTO supplier_account_movements (business_id, supplier_id, purchase_id, payment_id,
      movement_date, type, description, debit, credit, balance_after)
    VALUES (p_business_id, p_supplier_id, v_purchase, NULL, v_date, 'purchase',
      'Compra rápida', p_total_ars, 0, 0);
  END IF;

  -- 4. Si se pagó: FM salida + supplier_payment + crédito ledger + UN BFE técnico
  IF COALESCE(p_paid_ars,0) > 0 THEN
    INSERT INTO financial_movements (business_id, date, type, currency, amount, amount_ars, exchange_rate,
      source, description, created_by, metodo_pago, sign, reference_id, reference_type)
    VALUES (p_business_id, v_date, 'expense', 'ARS', p_paid_ars, p_paid_ars, 1,
      'pago_proveedor', 'Compra rápida de inventario' || COALESCE(' — '||p_supplier_name,''), v_user_id,
      NULLIF(trim(COALESCE(p_payment_method,'')),''), 1, v_purchase, 'supplier_purchase')
    RETURNING id INTO v_fm_id;

    INSERT INTO business_finance_entries (business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate, payment_method, source, created_by, economic_class)
    VALUES (p_business_id, v_date, 'variable_cost', 'inventario',
      'Compra de inventario' || COALESCE(' — '||p_supplier_name,''),
      p_paid_ars, 'ARS', p_paid_ars, 1, NULLIF(trim(COALESCE(p_payment_method,'')),''),
      'pago_proveedor', v_user_id, 'inventory_purchase');

    IF p_supplier_id IS NOT NULL THEN
      INSERT INTO supplier_payments (business_id, supplier_id, purchase_id, payment_date,
        amount, payment_method, notes, created_by, financial_movement_id)
      VALUES (p_business_id, p_supplier_id, v_purchase, v_date, p_paid_ars,
        COALESCE(NULLIF(trim(COALESCE(p_payment_method,'')),''),'efectivo'), 'Compra rápida', v_user_id, v_fm_id);
      INSERT INTO supplier_account_movements (business_id, supplier_id, purchase_id, payment_id,
        movement_date, type, description, debit, credit, balance_after)
      VALUES (p_business_id, p_supplier_id, v_purchase, NULL, v_date, 'payment',
        'Pago compra rápida', 0, p_paid_ars, 0);
    END IF;
  END IF;

  UPDATE quick_purchase_requests SET purchase_id=v_purchase WHERE id=v_req_id;
  RETURN jsonb_build_object('ok', true, 'replay', false, 'purchase_id', v_purchase);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

ALTER FUNCTION "public"."create_quick_inventory_purchase_atomic"(uuid, text, uuid, text, text, date, text, numeric, numeric, jsonb) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."create_quick_inventory_purchase_atomic"(uuid, text, uuid, text, text, date, text, numeric, numeric, jsonb) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."create_quick_inventory_purchase_atomic"(uuid, text, uuid, text, text, date, text, numeric, numeric, jsonb) TO "authenticated", "service_role";

-- ============================================================================
-- ROLLBACK (documentado): CREATE OR REPLACE con el cuerpo de 20260704101000
--   (sin comparación de hash) + ALTER TABLE quick_purchase_requests DROP COLUMN request_hash;
-- ============================================================================
