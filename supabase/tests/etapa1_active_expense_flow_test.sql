-- ============================================================
-- Conciliación del FLUJO ACTIVO real de NewExpenseModal (Expenses.tsx)
-- Reproduce exactamente lo que hace la UI productiva y demuestra que NO
-- duplica caja/BFE/compras/inventario.
--
-- Flujo factura/compra:  create_supplier_purchase_atomic  +  INSERT expenses(tipo='factura')
--   → el trigger trigger_expense_finance SALTA las facturas → sin FM/BFE extra.
-- Flujo gasto general:   create_expense_with_finance  (inserta expense con
--   finance_entry_id seteado → el trigger también salta) → 1 BFE + 1 FM.
--
-- RUN (local): supabase db reset && docker cp ... && psql -f
-- Corre en transacción con ROLLBACK. (Los :'var' de psql NO interpolan dentro
-- de bloques DO $$…$$, por eso los DO usan los UUID literales.)
-- ============================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set biz   '00000000-0000-0000-0000-0000000af101'
\set prod  '00000000-0000-0000-0000-0000000afd01'

SET LOCAL session_replication_role = 'replica';
INSERT INTO auth.users(id) VALUES ('00000000-0000-0000-0000-0000000af109');
INSERT INTO businesses(id, name, owner_user_id) VALUES ('00000000-0000-0000-0000-0000000af101','AE Flow','00000000-0000-0000-0000-0000000af109');
INSERT INTO profiles(business_id, user_id, role, is_active) VALUES ('00000000-0000-0000-0000-0000000af101','00000000-0000-0000-0000-0000000af109','owner',true);
INSERT INTO inventory(id, business_id, name, code, category, stock_quantity, stock, cost_price, sale_price, base_currency, is_active)
  VALUES ('00000000-0000-0000-0000-0000000afd01','00000000-0000-0000-0000-0000000af101','Prod AE','AE-001','Rep',10,10,600,1000,'ARS',true);
INSERT INTO suppliers(id, business_id, name, active) VALUES ('00000000-0000-0000-0000-0000000af501','00000000-0000-0000-0000-0000000af101','Prov AE',true);
INSERT INTO cajas(business_id, status, opened_by) VALUES ('00000000-0000-0000-0000-0000000af101','abierta','00000000-0000-0000-0000-0000000af109');
SET LOCAL session_replication_role = 'origin';

CREATE OR REPLACE FUNCTION pg_temp.item(qty numeric, cost numeric)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-0000000afd01','product_name','Prod AE','quantity',qty,'unit_cost',cost))
$$;

-- ════════════════════════════════════════════════════════════
-- AE1: compra factura AL CONTADO (paid=total) — flujo real completo
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_pid uuid;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000af109';
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000000af101'::uuid, '00000000-0000-0000-0000-0000000af501'::uuid,
        '00000000-0000-0000-0000-0000000af109'::uuid, 'Prov AE', '2026-06-20','FC-1', 5000, 5000, 'efectivo', 'nota', pg_temp.item(5,1000));
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'AE1a RPC compra contado ok ('||COALESCE(r->>'error','')||')');
  v_pid := (r->>'purchase_id')::uuid;
  RESET ROLE;
  -- El cliente (NewExpenseModal.handleSaveFactura) inserta el registro documental:
  INSERT INTO expenses (description, category, amount, amount_ars, date, business_id,
    payment_method, currency, exchange_rate, notes, created_by, tipo, proveedor_id, supplier_purchase_id, invoice_number)
  VALUES ('Factura Prov AE #FC-1','Proveedores',5000,5000,'2026-06-20','00000000-0000-0000-0000-0000000af101',
    'efectivo','ARS',1,NULL,'00000000-0000-0000-0000-0000000af109','factura','00000000-0000-0000-0000-0000000af501',v_pid,'FC-1');
END $$;

SELECT pg_temp.assert((SELECT count(*) FROM supplier_purchases WHERE business_id=:'biz')=1, 'AE1b 1 supplier_purchase');
SELECT pg_temp.assert((SELECT count(*) FROM supplier_purchase_items WHERE business_id=:'biz')=1, 'AE1c 1 item');
SELECT pg_temp.assert((SELECT count(*) FROM inventory_movements WHERE business_id=:'biz' AND movement_type='purchase')=1, 'AE1d 1 inventory_movement (sin duplicar)');
SELECT pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id=:'prod')=15, 'AE1e stock 10->15 una sola vez');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'biz')=1, 'AE1f EXACTAMENTE 1 financial_movement (el expenses tipo=factura NO agrego otro)');
SELECT pg_temp.assert((SELECT round(SUM(amount_ars)) FROM financial_movements WHERE business_id=:'biz')=5000, 'AE1g salida real de caja = paid_amount exacto (5000)');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'biz')=1, 'AE1h EXACTAMENTE 1 BFE (sin duplicar)');
SELECT pg_temp.assert((SELECT economic_class FROM business_finance_entries WHERE business_id=:'biz')='supplier_liability_payment', 'AE1i BFE clasificado supplier_liability_payment');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'biz' AND economic_class IN ('operating_expense','cogs','cogs_mirror'))=0, 'AE1j 0 operating_expense / 0 COGS');
SELECT pg_temp.assert((SELECT count(*) FROM expenses WHERE business_id=:'biz' AND tipo='factura')=1, 'AE1k 1 expenses documental (tipo=factura)');
SELECT pg_temp.assert((SELECT finance_entry_id FROM expenses WHERE business_id=:'biz' AND tipo='factura') IS NULL, 'AE1l expenses factura NO disparo BFE (finance_entry_id NULL)');
SELECT pg_temp.assert((SELECT count(*) FROM supplier_payments WHERE business_id=:'biz')=1, 'AE1m 1 supplier_payment');
SELECT pg_temp.assert((SELECT round(SUM(debit-credit)) FROM supplier_account_movements WHERE business_id=:'biz')=0, 'AE1n ledger: debito 5000 - credito 5000 = 0');

-- ════════════════════════════════════════════════════════════
-- AE2: compra factura A DEUDA (paid=0)
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_pid uuid;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000af109';
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000000af101'::uuid, '00000000-0000-0000-0000-0000000af501'::uuid,
        '00000000-0000-0000-0000-0000000af109'::uuid, 'Prov AE', '2026-06-21','FC-2', 4000, 0, NULL, 'deuda', pg_temp.item(4,1000));
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'AE2a RPC compra a deuda ok');
  v_pid := (r->>'purchase_id')::uuid;
  RESET ROLE;
  INSERT INTO expenses (description, category, amount, amount_ars, date, business_id,
    payment_method, currency, exchange_rate, created_by, tipo, proveedor_id, supplier_purchase_id, invoice_number)
  VALUES ('Factura Prov AE #FC-2','Proveedores',4000,4000,'2026-06-21','00000000-0000-0000-0000-0000000af101','efectivo','ARS',1,'00000000-0000-0000-0000-0000000af109','factura','00000000-0000-0000-0000-0000000af501',v_pid,'FC-2');
END $$;
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'biz')=1, 'AE2b a deuda: NO agrega salida de caja (sigue 1 de AE1)');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'biz')=1, 'AE2c a deuda: NO agrega BFE (sigue 1 de AE1)');
SELECT pg_temp.assert((SELECT count(*) FROM supplier_payments WHERE business_id=:'biz')=1, 'AE2d a deuda: 0 supplier_payment nuevo');
SELECT pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id=:'prod')=19, 'AE2e a deuda: inventario sube (15->19)');
SELECT pg_temp.assert((SELECT round(SUM(debit-credit)) FROM supplier_account_movements WHERE business_id=:'biz')=4000, 'AE2f ledger deuda +4000');

-- ════════════════════════════════════════════════════════════
-- AE3: compra factura PARCIAL (total 5000, paid 3000)
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_pid uuid;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000af109';
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000000af101'::uuid, '00000000-0000-0000-0000-0000000af501'::uuid,
        '00000000-0000-0000-0000-0000000af109'::uuid, 'Prov AE', '2026-06-22','FC-3', 5000, 3000, 'efectivo', NULL, pg_temp.item(5,1000));
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'AE3a RPC compra parcial ok');
  v_pid := (r->>'purchase_id')::uuid;
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT pending_amount FROM supplier_purchases WHERE business_id=:'biz' AND invoice_number='FC-3')=2000, 'AE3b saldo pendiente = total-paid = 2000');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'biz')=2, 'AE3c parcial: exactamente 1 salida de caja nueva (total 2)');
SELECT pg_temp.assert((SELECT round(SUM(amount_ars)) FROM financial_movements WHERE business_id=:'biz' AND date='2026-06-22')=3000, 'AE3d salida caja parcial = paid (3000)');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'biz' AND economic_class IN ('operating_expense','cogs'))=0, 'AE3e parcial: 0 operating_expense / 0 COGS');

-- ════════════════════════════════════════════════════════════
-- AE4: GASTO OPERATIVO general (create_expense_with_finance)
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_bfe_before int; v_fm_before int;
BEGIN
  SELECT count(*) INTO v_bfe_before FROM business_finance_entries WHERE business_id='00000000-0000-0000-0000-0000000af101';
  SELECT count(*) INTO v_fm_before  FROM financial_movements WHERE business_id='00000000-0000-0000-0000-0000000af101';
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000af109';
  r := create_expense_with_finance('00000000-0000-0000-0000-0000000af101'::uuid, '00000000-0000-0000-0000-0000000af109'::uuid,
        'Alquiler junio', 'Alquiler', 'alquiler', 'fixed_cost_local', 200000, 'transferencia', '2026-06-23', false, NULL, NULL,
        (SELECT id FROM cajas WHERE business_id='00000000-0000-0000-0000-0000000af101' LIMIT 1));
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'AE4a gasto operativo ok ('||COALESCE(r->>'error','')||')');
  PERFORM pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id='00000000-0000-0000-0000-0000000af101')=v_bfe_before+1, 'AE4b exactamente 1 BFE nuevo (trigger NO duplico)');
  PERFORM pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id='00000000-0000-0000-0000-0000000af101')=v_fm_before+1, 'AE4c exactamente 1 FM nuevo (trigger NO duplico)');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT economic_class FROM business_finance_entries WHERE business_id=:'biz' AND category='alquiler')='operating_expense', 'AE4d gasto alquiler -> operating_expense (afecta P&L)');
SELECT pg_temp.assert((SELECT count(*) FROM expenses WHERE business_id=:'biz' AND tipo='general' AND description='Alquiler junio' AND finance_entry_id IS NOT NULL)=1, 'AE4e expenses general trae finance_entry_id (trigger salta, sin duplicar)');

-- ════════════════════════════════════════════════════════════
-- AE5: IDEMPOTENCIA de create_supplier_purchase_atomic (misma key)
--   mismo payload → replay; sin duplicar compra/caja/BFE/inventario
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_first uuid;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000af109';
  -- primer envío (key nueva)
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000000af101'::uuid,'00000000-0000-0000-0000-0000000af501'::uuid,
        '00000000-0000-0000-0000-0000000af109'::uuid,'Prov AE','2026-06-24','FC-5',3000,3000,'efectivo',NULL,pg_temp.item(3,1000),'sp-key-1');
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean IS FALSE, 'AE5a primer envío -> created (replay=false)');
  v_first := (r->>'purchase_id')::uuid;
  -- reintento (misma key + mismo payload) -> replay
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000000af101'::uuid,'00000000-0000-0000-0000-0000000af501'::uuid,
        '00000000-0000-0000-0000-0000000af109'::uuid,'Prov AE','2026-06-24','FC-5',3000,3000,'efectivo',NULL,pg_temp.item(3,1000),'sp-key-1');
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean AND (r->>'purchase_id')::uuid=v_first, 'AE5b mismo payload -> replay del mismo purchase_id');
  RESET ROLE;
END $$;
-- Asserts de NO-duplicación a nivel top (postgres, sin RLS), keyed por FC-5:
SELECT pg_temp.assert((SELECT count(*) FROM supplier_purchases WHERE business_id=:'biz' AND invoice_number='FC-5')=1, 'AE5c replay NO creó otra compra (1 FC-5)');
SELECT pg_temp.assert((SELECT count(*) FROM supplier_payments sp JOIN supplier_purchases s ON s.id=sp.purchase_id WHERE s.invoice_number='FC-5')=1, 'AE5d replay NO creó otro pago');
SELECT pg_temp.assert((SELECT count(*) FROM inventory_movements WHERE reference_id=(SELECT id FROM supplier_purchases WHERE business_id=:'biz' AND invoice_number='FC-5') AND movement_type='purchase')=1, 'AE5e replay NO creó otro inventory_movement');
SELECT pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id=:'prod')=27, 'AE5f replay NO volvió a subir stock (24->27 una vez)');

-- ════════════════════════════════════════════════════════════
-- AE6: misma key + payload DISTINTO → IDEMPOTENCY_CONFLICT
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_pur_before int;
BEGIN
  SELECT count(*) INTO v_pur_before FROM supplier_purchases WHERE business_id='00000000-0000-0000-0000-0000000af101';
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000af109';
  -- cambia monto
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000000af101'::uuid,'00000000-0000-0000-0000-0000000af501'::uuid,
        '00000000-0000-0000-0000-0000000af109'::uuid,'Prov AE','2026-06-24','FC-5',9999,9999,'efectivo',NULL,pg_temp.item(3,1000),'sp-key-1');
  PERFORM pg_temp.assert((r->>'ok')::boolean IS NOT TRUE AND r->>'error'='IDEMPOTENCY_CONFLICT', 'AE6a payload distinto (monto) -> IDEMPOTENCY_CONFLICT');
  PERFORM pg_temp.assert(r->>'purchase_id' IS NULL, 'AE6b conflicto no devuelve purchase_id');
  -- cambia cantidad de ítem
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000000af101'::uuid,'00000000-0000-0000-0000-0000000af501'::uuid,
        '00000000-0000-0000-0000-0000000af109'::uuid,'Prov AE','2026-06-24','FC-5',3000,3000,'efectivo',NULL,pg_temp.item(4,1000),'sp-key-1');
  PERFORM pg_temp.assert(r->>'error'='IDEMPOTENCY_CONFLICT', 'AE6c payload distinto (cantidad) -> conflicto');
  -- cambia fecha
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000000af101'::uuid,'00000000-0000-0000-0000-0000000af501'::uuid,
        '00000000-0000-0000-0000-0000000af109'::uuid,'Prov AE','2026-06-25','FC-5',3000,3000,'efectivo',NULL,pg_temp.item(3,1000),'sp-key-1');
  PERFORM pg_temp.assert(r->>'error'='IDEMPOTENCY_CONFLICT', 'AE6d payload distinto (fecha) -> conflicto');
  RESET ROLE;
END $$;
-- top-level (postgres): tras 3 compras (FC-1/2/3) + 1 idempotente (FC-5), y 3 conflictos, siguen 4.
SELECT pg_temp.assert((SELECT count(*) FROM supplier_purchases WHERE business_id=:'biz')=4, 'AE6e ningún conflicto creó compra (siguen 4)');
SELECT pg_temp.assert((SELECT count(*) FROM supplier_purchase_requests WHERE business_id=:'biz' AND idempotency_key='sp-key-1')=1, 'AE6f una sola request row para la key');

-- ════════════════════════════════════════════════════════════
-- AE7: sin idempotency key (NULL) → comportamiento legacy (crea siempre)
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r1 jsonb; r2 jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000af109';
  r1 := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000000af101'::uuid,'00000000-0000-0000-0000-0000000af501'::uuid,
        '00000000-0000-0000-0000-0000000af109'::uuid,'Prov AE','2026-06-26','FC-7',1000,0,NULL,NULL,pg_temp.item(1,1000));
  r2 := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000000af101'::uuid,'00000000-0000-0000-0000-0000000af501'::uuid,
        '00000000-0000-0000-0000-0000000af109'::uuid,'Prov AE','2026-06-26','FC-7',1000,0,NULL,NULL,pg_temp.item(1,1000));
  PERFORM pg_temp.assert((r1->>'ok')::boolean AND (r2->>'ok')::boolean AND (r1->>'purchase_id')<>(r2->>'purchase_id'), 'AE7 sin key: dos llamadas crean dos compras (compat legacy)');
  RESET ROLE;
END $$;

-- ════════════════════════════════════════════════════════════
-- AE8: clasificación fixed_cost_local es catch-all operating_expense
-- ════════════════════════════════════════════════════════════
SELECT pg_temp.assert(bfe_economic_class('fixed_cost_local','operativos','expense',NULL)='operating_expense', 'AE8a fixed_cost_local + operativos -> operating_expense');
SELECT pg_temp.assert(bfe_economic_class('fixed_cost_local','','expense',NULL)='operating_expense', 'AE8b fixed_cost_local + categoria vacia -> operating_expense');
SELECT pg_temp.assert(bfe_economic_class('fixed_cost_local','alquiler','expense',NULL)='operating_expense', 'AE8c fixed_cost_local + alquiler -> operating_expense (no regresiona)');
SELECT pg_temp.assert(bfe_economic_class('fixed_cost_personal','luz','expense',NULL)='owner_withdrawal', 'AE8d fixed_cost_personal sigue owner_withdrawal (no afectado)');

SELECT pg_temp.assert(true, '=== etapa1_active_expense_flow_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
