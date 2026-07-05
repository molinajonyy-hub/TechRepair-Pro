-- ============================================================
-- Test suite — create_quick_inventory_purchase_atomic (Etapa 1, deuda técnica)
-- migración 20260704101000_quick_inventory_purchase.sql
--
-- HOW TO RUN (local, NUNCA prod):
--   supabase db reset
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/etapa1_quick_purchase_test.sql
--
-- Corre en una transacción y hace ROLLBACK al final.
-- ============================================================
BEGIN;
SET LOCAL client_min_messages = notice;

CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set bizA   '00000000-0000-0000-0000-0000000e2a01'
\set bizB   '00000000-0000-0000-0000-0000000e2b01'
\set ownerA '00000000-0000-0000-0000-0000000e2a09'
\set ownerB '00000000-0000-0000-0000-0000000e2b09'
\set prod   '00000000-0000-0000-0000-0000000e2d01'
\set sup    '00000000-0000-0000-0000-0000000e2501'

SET LOCAL session_replication_role = 'replica';
INSERT INTO auth.users(id) VALUES (:'ownerA'), (:'ownerB');
INSERT INTO businesses(id, name, owner_user_id) VALUES (:'bizA','QP A',:'ownerA'), (:'bizB','QP B',:'ownerB');
INSERT INTO profiles(business_id, user_id, role, is_active) VALUES (:'bizA',:'ownerA','owner',true), (:'bizB',:'ownerB','owner',true);
INSERT INTO inventory(id, business_id, name, code, category, stock_quantity, stock, cost_price, sale_price, base_currency, is_active)
  VALUES (:'prod',:'bizA','Prod QP','QP-001','Rep',10,10,600,1000,'ARS',true);
INSERT INTO suppliers(id, business_id, name, active) VALUES (:'sup',:'bizA','Prov QP',true);
SET LOCAL session_replication_role = 'origin';

-- Helper: item jsonb
CREATE OR REPLACE FUNCTION pg_temp.item(qty numeric, cost numeric)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-0000000e2d01','product_name','Prod QP','quantity',qty,'unit_cost_ars',cost))
$$;

-- ════════════════════════════════════════════════════════════
-- QP1: compra al contado con proveedor → efectos exactos
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_pid uuid;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e2a09';
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-0000000e2a01'::uuid,'qp1-key',
    '00000000-0000-0000-0000-0000000e2501'::uuid,'Prov QP','FC-1','2026-06-20','efectivo',
    5000, 5000, pg_temp.item(5,1000));
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'QP1a compra contado con proveedor -> ok (' || COALESCE(r->>'error','') || ')');
  v_pid := (r->>'purchase_id')::uuid;
  PERFORM pg_temp.assert(v_pid IS NOT NULL, 'QP1b devuelve purchase_id');
  RESET ROLE;
END $$;

SELECT pg_temp.assert((SELECT count(*) FROM supplier_purchases WHERE business_id=:'bizA')=1, 'QP1c exactamente UNA compra');
SELECT pg_temp.assert((SELECT count(*) FROM supplier_purchase_items WHERE business_id=:'bizA')=1, 'QP1d un ítem de compra');
SELECT pg_temp.assert((SELECT count(*) FROM inventory_movements WHERE business_id=:'bizA' AND movement_type='purchase')=1, 'QP1e exactamente UN inventory_movement de compra');
SELECT pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id=:'prod')=15, 'QP1f stock 10 -> 15');
SELECT pg_temp.assert((SELECT cost_price FROM inventory WHERE id=:'prod')=1000, 'QP1g cost_price actualizado a 1000');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'bizA' AND type='expense' AND source='pago_proveedor')=1, 'QP1h una salida de caja (FM expense)');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'bizA' AND economic_class='inventory_purchase')=1, 'QP1i exactamente UNA BFE tecnica inventory_purchase');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'bizA' AND economic_class='operating_expense')=0, 'QP1j CERO gasto operativo (no contamina P&L)');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'bizA' AND economic_class IN ('cogs','cogs_mirror'))=0, 'QP1k CERO COGS');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'bizA')=1, 'QP1l una sola BFE en total (sin triple-escritura)');
SELECT pg_temp.assert((SELECT ROUND(SUM(debit-credit)) FROM supplier_account_movements WHERE business_id=:'bizA')=0, 'QP1m ledger proveedor: debito 5000 - credito 5000 = 0 (pagado)');

-- P&L canónico NO cambia por la compra
SELECT pg_temp.assert(COALESCE((SELECT SUM(operating_result) FROM v_finance_pnl WHERE business_id=:'bizA'),0)=0, 'QP1n resultado operativo sigue en 0 (compra no afecta P&L)');
-- Posición SÍ cambia (inventario subió)
SELECT pg_temp.assert((SELECT inventory_at_cost FROM v_finance_position WHERE business_id=:'bizA')=15000, 'QP1o posición: inventario a costo = 15*1000');

-- ════════════════════════════════════════════════════════════
-- QP2: idempotencia LIGADA AL PAYLOAD (contrato correcto)
--   Caso A: misma key + mismo payload    → replay de la operación original
--   Caso B: misma key + payload distinto → IDEMPOTENCY_CONFLICT (no éxito)
-- El hash se reconstruye server-side desde los argumentos; una key reusada
-- con datos diferentes NO puede recibir la compra anterior como éxito.
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_first uuid;
BEGIN
  SELECT purchase_id INTO v_first FROM quick_purchase_requests WHERE idempotency_key='qp1-key';
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e2a09';

  -- ── Caso A: misma key + MISMO payload → replay del mismo purchase_id ──
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-0000000e2a01'::uuid,'qp1-key',
    '00000000-0000-0000-0000-0000000e2501'::uuid,'Prov QP','FC-1','2026-06-20','efectivo',5000,5000, pg_temp.item(5,1000));
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean AND (r->>'purchase_id')::uuid=v_first,
    'QP2a caso A: misma key + mismo payload -> replay del mismo purchase_id');

  -- ── Caso B: misma key + PAYLOAD distinto → IDEMPOTENCY_CONFLICT ──
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-0000000e2a01'::uuid,'qp1-key',
    NULL,NULL,NULL,'2026-06-21','transferencia',9999,9999, pg_temp.item(50,200));
  PERFORM pg_temp.assert((r->>'ok')::boolean IS NOT TRUE AND r->>'error'='IDEMPOTENCY_CONFLICT',
    'QP2b caso B: misma key + payload distinto -> IDEMPOTENCY_CONFLICT (no exito)');
  PERFORM pg_temp.assert(r->>'message' ILIKE '%datos diferentes%' AND r->>'message' NOT ILIKE '%SQLSTATE%',
    'QP2b2 conflicto: mensaje funcional claro, sin SQL crudo');
  PERFORM pg_temp.assert(r->>'purchase_id' IS NULL,
    'QP2b3 conflicto: NO devuelve la compra anterior como purchase_id');

  -- ── Variantes: cambia UN SOLO campo económico → cada una debe conflictuar ──
  -- cantidad
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-0000000e2a01'::uuid,'qp1-key',
    '00000000-0000-0000-0000-0000000e2501'::uuid,'Prov QP','FC-1','2026-06-20','efectivo',5000,5000, pg_temp.item(6,1000));
  PERFORM pg_temp.assert(r->>'error'='IDEMPOTENCY_CONFLICT', 'QP2v1 solo cambia cantidad -> conflicto');
  -- costo unitario
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-0000000e2a01'::uuid,'qp1-key',
    '00000000-0000-0000-0000-0000000e2501'::uuid,'Prov QP','FC-1','2026-06-20','efectivo',5000,5000, pg_temp.item(5,1100));
  PERFORM pg_temp.assert(r->>'error'='IDEMPOTENCY_CONFLICT', 'QP2v2 solo cambia costo -> conflicto');
  -- paid_ars (total igual, cambia lo pagado)
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-0000000e2a01'::uuid,'qp1-key',
    '00000000-0000-0000-0000-0000000e2501'::uuid,'Prov QP','FC-1','2026-06-20','efectivo',5000,4000, pg_temp.item(5,1000));
  PERFORM pg_temp.assert(r->>'error'='IDEMPOTENCY_CONFLICT', 'QP2v3 solo cambia paid_ars -> conflicto');
  -- proveedor (nombre)
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-0000000e2a01'::uuid,'qp1-key',
    '00000000-0000-0000-0000-0000000e2501'::uuid,'Prov CAMBIADO','FC-1','2026-06-20','efectivo',5000,5000, pg_temp.item(5,1000));
  PERFORM pg_temp.assert(r->>'error'='IDEMPOTENCY_CONFLICT', 'QP2v4 solo cambia proveedor -> conflicto');
  -- método de pago
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-0000000e2a01'::uuid,'qp1-key',
    '00000000-0000-0000-0000-0000000e2501'::uuid,'Prov QP','FC-1','2026-06-20','transferencia',5000,5000, pg_temp.item(5,1000));
  PERFORM pg_temp.assert(r->>'error'='IDEMPOTENCY_CONFLICT', 'QP2v5 solo cambia metodo de pago -> conflicto');
  -- fecha
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-0000000e2a01'::uuid,'qp1-key',
    '00000000-0000-0000-0000-0000000e2501'::uuid,'Prov QP','FC-1','2026-06-25','efectivo',5000,5000, pg_temp.item(5,1000));
  PERFORM pg_temp.assert(r->>'error'='IDEMPOTENCY_CONFLICT', 'QP2v6 solo cambia fecha -> conflicto');
  -- inventario (otro inventory_id en el ítem)
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-0000000e2a01'::uuid,'qp1-key',
    '00000000-0000-0000-0000-0000000e2501'::uuid,'Prov QP','FC-1','2026-06-20','efectivo',5000,5000,
    jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-0000000e2d99','product_name','Prod QP','quantity',5,'unit_cost_ars',1000)));
  PERFORM pg_temp.assert(r->>'error'='IDEMPOTENCY_CONFLICT', 'QP2v7 solo cambia inventario -> conflicto');

  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT count(*) FROM supplier_purchases WHERE business_id=:'bizA')=1, 'QP2c ningun conflicto creo compra: sigue habiendo UNA sola');
SELECT pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id=:'prod')=15, 'QP2d ningun conflicto/replay volvio a subir stock');
SELECT pg_temp.assert((SELECT count(*) FROM inventory_movements WHERE business_id=:'bizA' AND movement_type='purchase')=1, 'QP2e ningun conflicto/replay creo movimiento de inventario');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'bizA')=1, 'QP2f ningun conflicto/replay creo BFE');
SELECT pg_temp.assert((SELECT ROUND(SUM(debit-credit)) FROM supplier_account_movements WHERE business_id=:'bizA')=0, 'QP2g ledger proveedor intacto tras conflictos/replays');

-- ════════════════════════════════════════════════════════════
-- QP3: monto inválido
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e2a09';
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-0000000e2a01'::uuid,'qp3-key',NULL,NULL,NULL,'2026-06-20','efectivo',0,0,'[]'::jsonb);
  PERFORM pg_temp.assert((r->>'ok')::boolean IS NOT TRUE AND r->>'error' ILIKE '%mayor a 0%', 'QP3 total 0 -> rechazado funcional');
  RESET ROLE;
END $$;

-- ════════════════════════════════════════════════════════════
-- QP4: cross-tenant — ownerB no puede comprar para bizA
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e2b09';
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-0000000e2a01'::uuid,'qp4-key',NULL,NULL,NULL,'2026-06-20','efectivo',1000,1000, pg_temp.item(1,1000));
  PERFORM pg_temp.assert((r->>'ok')::boolean IS NOT TRUE AND r->>'error' ILIKE '%acceso%', 'QP4 cross-tenant -> rechazado');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT count(*) FROM supplier_purchases WHERE business_id=:'bizA')=1, 'QP4b el cross-tenant no creó compra');

-- ════════════════════════════════════════════════════════════
-- QP5: proveedor inexistente → rollback TOTAL (FK), sin datos parciales
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e2a09';
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-0000000e2a01'::uuid,'qp5-key',
    '00000000-0000-0000-0000-00000000dead'::uuid,'Fantasma','FC-9','2026-06-20','efectivo',3000,3000, pg_temp.item(3,1000));
  PERFORM pg_temp.assert((r->>'ok')::boolean IS NOT TRUE, 'QP5a proveedor inexistente -> ok:false (FK)');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT count(*) FROM supplier_purchases WHERE business_id=:'bizA')=1, 'QP5b rollback total: sigue habiendo 1 compra (la de QP1)');
SELECT pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id=:'prod')=15, 'QP5c rollback total: el stock no cambió');
SELECT pg_temp.assert(NOT EXISTS (SELECT 1 FROM quick_purchase_requests WHERE idempotency_key='qp5-key'), 'QP5d rollback total: no quedó request fantasma (retry seguro)');

-- ════════════════════════════════════════════════════════════
-- QP6: sin proveedor → ok, sin ledger de proveedor, una BFE técnica
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e2a09';
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-0000000e2a01'::uuid,'qp6-key',
    NULL,NULL,NULL,'2026-06-22','efectivo',2000,2000, pg_temp.item(2,1000));
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'QP6a compra sin proveedor -> ok');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'bizA' AND economic_class='inventory_purchase')=2, 'QP6b ahora hay 2 BFE inventory_purchase (una por compra), ninguna operating_expense');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'bizA' AND economic_class='operating_expense')=0, 'QP6c sigue en 0 operating_expense');

-- ════════════════════════════════════════════════════════════
-- QP7: a deuda (paid=0) → sin FM, sin BFE; solo débito de proveedor
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_fm_before int; v_bfe_before int;
BEGIN
  SELECT count(*) INTO v_fm_before  FROM financial_movements WHERE business_id='00000000-0000-0000-0000-0000000e2a01';
  SELECT count(*) INTO v_bfe_before FROM business_finance_entries WHERE business_id='00000000-0000-0000-0000-0000000e2a01';
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e2a09';
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-0000000e2a01'::uuid,'qp7-key',
    '00000000-0000-0000-0000-0000000e2501'::uuid,'Prov QP','FC-7','2026-06-23',NULL,4000,0, pg_temp.item(4,1000));
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'QP7a compra a deuda (paid=0) -> ok');
  PERFORM pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id='00000000-0000-0000-0000-0000000e2a01')=v_fm_before, 'QP7b a deuda: NO crea salida de caja');
  PERFORM pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id='00000000-0000-0000-0000-0000000e2a01')=v_bfe_before, 'QP7c a deuda: NO crea BFE');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT ROUND(SUM(debit-credit)) FROM supplier_account_movements WHERE business_id=:'bizA')=4000, 'QP7d a deuda: ledger proveedor = +4000 (debito sin credito)');

SELECT pg_temp.assert(true, '=== etapa1_quick_purchase_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
