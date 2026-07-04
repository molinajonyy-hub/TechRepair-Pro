-- ============================================================================
-- M3 companion — create_quick_inventory_purchase_atomic (Etapa 1)
--
-- Reemplaza la compra rápida client-side de ModalCrearGasto (6 escrituras sin
-- transacción: inventory, inventory_movements, purchases, purchase_items, BFE
-- variable_cost/repuestos, expenses → trigger → BFE mercaderia + FM). Ese
-- flujo generaba DUPLICACIÓN contable (2-3 BFE por compra) y no era atómico.
--
-- La RPC produce EXACTAMENTE, en una transacción:
--   - un registro de compra trazable (supplier_purchases + items; proveedor opcional);
--   - entrada de inventario (stock + inventory_movements + cost_price) por ítem;
--   - una salida de caja (FM expense) si se pagó;
--   - deuda de proveedor si corresponde (supplier_account_movements) — sin pago;
--   - UN solo BFE técnico clasificado inventory_purchase (excluido del P&L);
--   - CERO inserción en expenses (evita el trigger_expense_finance espejo);
--   - CERO gasto operativo, CERO COGS.
--
-- Ownership validado server-side. Idempotencia por p_idempotency_key. Los
-- productos nuevos se crean antes vía productService (el modal pasa inventory_id
-- ya resuelto) — unificar completamente purchases/supplier_purchases excede M3
-- (deuda técnica documentada).
-- ============================================================================

CREATE TABLE IF NOT EXISTS "public"."quick_purchase_requests" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id"     uuid NOT NULL REFERENCES "public"."businesses"("id"),
  "user_id"         uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "purchase_id"     uuid,
  "created_at"      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_quick_purchase_req_key"
  ON "public"."quick_purchase_requests" ("business_id", "idempotency_key");
ALTER TABLE "public"."quick_purchase_requests" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "quick_purchase_req_select" ON "public"."quick_purchase_requests";
CREATE POLICY "quick_purchase_req_select" ON "public"."quick_purchase_requests"
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM businesses WHERE id="quick_purchase_requests"."business_id" AND owner_user_id=auth.uid())
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id="quick_purchase_requests"."business_id" AND user_id=auth.uid())
  );
REVOKE ALL ON "public"."quick_purchase_requests" FROM PUBLIC, "anon";
GRANT SELECT ON "public"."quick_purchase_requests" TO "authenticated";
GRANT ALL ON "public"."quick_purchase_requests" TO "service_role";

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
  "p_items"           jsonb   -- [{inventory_id, product_name, quantity, unit_cost_ars}]
) RETURNS jsonb
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user_id    uuid := auth.uid();
  v_has_access boolean := false;
  v_existing   uuid;
  v_req_id     uuid;
  v_purchase   uuid;
  v_date       date := COALESCE(p_date, public.ar_today());
  v_pending    numeric := GREATEST(0, COALESCE(p_total_ars,0) - COALESCE(p_paid_ars,0));
  v_status     text;
  v_item       jsonb;
  v_prev_stk   integer;
  v_new_stk    integer;
  v_bfe_id     uuid;
  v_fm_id      uuid;
BEGIN
  IF v_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'No autenticado'); END IF;
  IF p_total_ars IS NULL OR p_total_ars <= 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'total debe ser mayor a 0'); END IF;
  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key))=0 THEN RETURN jsonb_build_object('ok', false, 'error', 'idempotency_key requerida'); END IF;

  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user_id)
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND user_id=v_user_id AND COALESCE(is_active,true))
  ) INTO v_has_access;
  IF NOT v_has_access THEN RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio'); END IF;

  -- Idempotencia
  SELECT purchase_id INTO v_existing FROM quick_purchase_requests
    WHERE business_id=p_business_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'purchase_id', v_existing); END IF;

  BEGIN
    INSERT INTO quick_purchase_requests (business_id, user_id, idempotency_key)
      VALUES (p_business_id, v_user_id, p_idempotency_key) RETURNING id INTO v_req_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT purchase_id INTO v_existing FROM quick_purchase_requests WHERE business_id=p_business_id AND idempotency_key=p_idempotency_key;
    RETURN jsonb_build_object('ok', true, 'replay', true, 'purchase_id', v_existing);
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

    -- BFE técnico: inventory_purchase (clasificado por el trigger, EXCLUIDO del P&L).
    -- Es la ÚNICA escritura BFE de este flujo (antes eran 2-3).
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
-- ROLLBACK (documentado): DROP FUNCTION create_quick_inventory_purchase_atomic(...);
--   DROP TABLE quick_purchase_requests;
-- ============================================================================
