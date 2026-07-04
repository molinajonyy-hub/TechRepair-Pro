-- ============================================================
-- Test suite Etapa 1 — modelo contable canónico (M3 + M4 + M5)
-- migraciones 20260704100000..130000
--
-- HOW TO RUN (local, NUNCA prod):
--   supabase db reset
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/etapa1_canonical_model_test.sql
--
-- Fixtures controlados que reproducen los patrones de Clic. Corre en una
-- transacción y hace ROLLBACK al final.
-- ============================================================
BEGIN;
SET LOCAL client_min_messages = notice;

CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set bizA   '00000000-0000-0000-0000-0000000e1a01'
\set bizB   '00000000-0000-0000-0000-0000000e1b01'
\set ownerA '00000000-0000-0000-0000-0000000e1a09'
\set ownerB '00000000-0000-0000-0000-0000000e1b09'
\set prod   '00000000-0000-0000-0000-0000000e1d01'
\set custA  '00000000-0000-0000-0000-0000000e1c01'
\set sup    '00000000-0000-0000-0000-0000000e1501'

SET LOCAL session_replication_role = 'replica';
INSERT INTO auth.users(id) VALUES (:'ownerA'), (:'ownerB');
INSERT INTO businesses(id, name, owner_user_id) VALUES (:'bizA','Etapa1 A',:'ownerA'), (:'bizB','Etapa1 B',:'ownerB');
INSERT INTO profiles(business_id, user_id, role, is_active) VALUES (:'bizA',:'ownerA','owner',true), (:'bizB',:'ownerB','owner',true);
INSERT INTO customers(id, business_id, name, phone) VALUES (:'custA',:'bizA','Cliente A','+540000000009');
INSERT INTO inventory(id, business_id, name, code, category, stock_quantity, stock, cost_price, sale_price, base_currency, is_active)
  VALUES (:'prod',:'bizA','Prod E1','E1-001','Rep',100,100,600,1000,'ARS',true);
INSERT INTO suppliers(id, business_id, name, active) VALUES (:'sup',:'bizA','Prov E1',true);

-- ── Comprobante 1: ISSUED, 2 uds, cobrado (venta efectiva) ──────────────────
INSERT INTO comprobantes(id, business_id, tipo, type, estado, status, estado_comercial, estado_fiscal,
  fecha, date, total, total_ars, total_bruto, total_cobrado, saldo_pendiente, currency, exchange_rate, subtotal)
VALUES ('00000000-0000-0000-0000-0000000e1f01',:'bizA','factura_c','factura_c','emitido','issued','pagado','no_fiscal',
  '2026-06-15','2026-06-15',2000,2000,2000,2000,0,'ARS',1,2000);
INSERT INTO comprobante_items(comprobante_id, business_id, descripcion, tipo_linea, cantidad, precio_unitario, descuento_linea, subtotal, costo_unitario, costo_total, currency, exchange_rate, inventory_id, stock_processed)
VALUES ('00000000-0000-0000-0000-0000000e1f01',:'bizA','Prod E1','producto',2,1000,0,2000,600,1200,'ARS',1,:'prod',true);

-- ── Comprobante 2: DRAFT legacy con stock procesado + pago (venta efectiva) ──
INSERT INTO comprobantes(id, business_id, tipo, type, estado, status, estado_comercial, estado_fiscal,
  fecha, date, total, total_ars, total_bruto, total_cobrado, saldo_pendiente, currency, exchange_rate, subtotal, es_fiscal)
VALUES ('00000000-0000-0000-0000-0000000e1f02',:'bizA','factura_c','factura_c','borrador','draft','pagado','pendiente_emision',
  '2026-06-16','2026-06-16',1500,1500,1500,1500,0,'ARS',1,1500,true);
INSERT INTO comprobante_items(comprobante_id, business_id, descripcion, tipo_linea, cantidad, precio_unitario, descuento_linea, subtotal, costo_unitario, costo_total, currency, exchange_rate, inventory_id, stock_processed)
VALUES ('00000000-0000-0000-0000-0000000e1f02',:'bizA','Prod E1','producto',1.5,1000,0,1500,600,900,'ARS',1,:'prod',true);
INSERT INTO comprobante_payments(comprobante_id, business_id, amount, currency, amount_ars, exchange_rate, payment_method, date)
VALUES ('00000000-0000-0000-0000-0000000e1f02',:'bizA',1500,'ARS',1500,1,'efectivo','2026-06-16');

-- ── Comprobante 3: ANULADO (NO debe contar en ventas) ───────────────────────
INSERT INTO comprobantes(id, business_id, tipo, type, estado, status, estado_comercial, estado_fiscal,
  fecha, date, total, total_ars, total_bruto, total_cobrado, saldo_pendiente, currency, exchange_rate, subtotal)
VALUES ('00000000-0000-0000-0000-0000000e1f03',:'bizA','factura_c','factura_c','anulado','cancelled','anulado','no_fiscal',
  '2026-06-17','2026-06-17',9999,9999,9999,0,9999,'ARS',1,9999);
INSERT INTO comprobante_items(comprobante_id, business_id, descripcion, tipo_linea, cantidad, precio_unitario, descuento_linea, subtotal, costo_unitario, costo_total, currency, exchange_rate, inventory_id, stock_processed)
VALUES ('00000000-0000-0000-0000-0000000e1f03',:'bizA','Prod E1','producto',9,1111,0,9999,600,5400,'ARS',1,:'prod',false);

-- ── Comprobante 4: DRAFT VACÍO (sin efectos → NO es venta) ───────────────────
INSERT INTO comprobantes(id, business_id, tipo, type, estado, status, estado_comercial, estado_fiscal,
  fecha, date, total, total_ars, total_bruto, total_cobrado, saldo_pendiente, currency, exchange_rate, subtotal, es_fiscal)
VALUES ('00000000-0000-0000-0000-0000000e1f04',:'bizA','factura_c','factura_c','borrador','draft','pendiente','pendiente_emision',
  '2026-06-18','2026-06-18',700,700,700,0,700,'ARS',1,700,true);
INSERT INTO comprobante_items(comprobante_id, business_id, descripcion, tipo_linea, cantidad, precio_unitario, descuento_linea, subtotal, costo_unitario, costo_total, currency, exchange_rate, inventory_id, stock_processed)
VALUES ('00000000-0000-0000-0000-0000000e1f04',:'bizA','Prod E1','producto',0.7,1000,0,700,600,420,'ARS',1,:'prod',false);

-- ── Venta en CC (comprobante 5: draft con account_movement venta) ───────────
INSERT INTO comprobantes(id, business_id, customer_id, tipo, type, estado, status, estado_comercial, estado_fiscal,
  fecha, date, total, total_ars, total_bruto, total_cobrado, saldo_pendiente, currency, exchange_rate, subtotal, es_fiscal)
VALUES ('00000000-0000-0000-0000-0000000e1f05',:'bizA',:'custA','factura_c','factura_c','borrador','draft','parcial','pendiente_emision',
  '2026-06-19','2026-06-19',1000,1000,1000,0,1000,'ARS',1,1000,true);
INSERT INTO comprobante_items(comprobante_id, business_id, descripcion, tipo_linea, cantidad, precio_unitario, descuento_linea, subtotal, costo_unitario, costo_total, currency, exchange_rate, inventory_id, stock_processed)
VALUES ('00000000-0000-0000-0000-0000000e1f05',:'bizA','Prod E1','producto',1,1000,0,1000,600,600,'ARS',1,:'prod',false);
INSERT INTO accounts(id, business_id, type, entity_id, entity_name, balance) VALUES ('00000000-0000-0000-0000-0000000e1a51',:'bizA','cliente',:'custA','Cliente A',1000);
INSERT INTO account_movements(business_id, account_id, date, type, description, debit, credit, balance_after, reference_type, reference_id)
VALUES (:'bizA','00000000-0000-0000-0000-0000000e1a51','2026-06-19','venta','Comp 5',1000,0,1000,'comprobante','00000000-0000-0000-0000-0000000e1f05');

SET LOCAL session_replication_role = 'origin';  -- fuera de replica para que el trigger de clasificación dispare

-- ── BFE de gasto/costo/capital (la clasificación la pone el trigger) ─────────
INSERT INTO business_finance_entries(business_id, date, type, category, description, amount, currency, amount_ars, exchange_rate, source) VALUES
  (:'bizA','2026-06-15','fixed_cost_local','alquiler','Alquiler', 5000,'ARS',5000,1,'manual'),        -- operating_expense
  (:'bizA','2026-06-15','variable_cost','comisiones_cobro','Comisión', 300,'ARS',300,1,'comprobante'),-- payment_fee
  (:'bizA','2026-06-15','variable_cost','mercaderia','COGS mirror', 1200,'ARS',1200,1,'manual'),      -- cogs_mirror (excluido)
  (:'bizA','2026-06-15','variable_cost','inventario','Compra stock', 8000,'ARS',8000,1,'expense'),    -- inventory_purchase (excluido)
  (:'bizA','2026-06-15','variable_cost','compras_proveedor','Pago prov', 4000,'ARS',4000,1,'pago_proveedor'), -- supplier_liability_payment (excluido)
  (:'bizA','2026-06-15','salary','sueldo_dueno','Mi sueldo', 10000,'ARS',10000,1,'manual'),           -- owner_withdrawal (excluido)
  (:'bizA','2026-06-15','salary','sueldo_empleados','Sueldo empleado', 2500,'ARS',2500,1,'manual');   -- employee_salary (P&L)

-- ════════════════════════════════════════════════════════════
-- C1: CLASIFICACIÓN — el trigger asignó la clase correcta
-- ════════════════════════════════════════════════════════════
SELECT pg_temp.assert((SELECT economic_class FROM business_finance_entries WHERE business_id=:'bizA' AND category='alquiler')='operating_expense', 'C1a alquiler → operating_expense');
SELECT pg_temp.assert((SELECT economic_class FROM business_finance_entries WHERE business_id=:'bizA' AND category='comisiones_cobro')='payment_fee', 'C1b comisiones → payment_fee');
SELECT pg_temp.assert((SELECT economic_class FROM business_finance_entries WHERE business_id=:'bizA' AND category='mercaderia')='cogs_mirror', 'C1c mercaderia → cogs_mirror');
SELECT pg_temp.assert((SELECT economic_class FROM business_finance_entries WHERE business_id=:'bizA' AND category='inventario')='inventory_purchase', 'C1d inventario → inventory_purchase');
SELECT pg_temp.assert((SELECT economic_class FROM business_finance_entries WHERE business_id=:'bizA' AND category='compras_proveedor')='supplier_liability_payment', 'C1e compras_proveedor → supplier_liability_payment');
SELECT pg_temp.assert((SELECT economic_class FROM business_finance_entries WHERE business_id=:'bizA' AND category='sueldo_dueno')='owner_withdrawal', 'C1f sueldo_dueno → owner_withdrawal');
SELECT pg_temp.assert((SELECT economic_class FROM business_finance_entries WHERE business_id=:'bizA' AND category='sueldo_empleados')='employee_salary', 'C1g sueldo_empleados → employee_salary');

-- ════════════════════════════════════════════════════════════
-- C2: CONJUNTO EFECTIVO — issued + draft-con-efectos, NO anulado, NO draft vacío
-- ════════════════════════════════════════════════════════════
SELECT pg_temp.assert((SELECT count(*) FROM v_finance_effective_comprobantes WHERE business_id=:'bizA')=3,
  'C2a conjunto efectivo = 3 (issued + draft con stock+pago + venta CC), excluye anulado y draft vacío');
SELECT pg_temp.assert(NOT EXISTS (SELECT 1 FROM v_finance_effective_comprobantes WHERE id='00000000-0000-0000-0000-0000000e1f03'), 'C2b anulado NO es efectivo');
SELECT pg_temp.assert(NOT EXISTS (SELECT 1 FROM v_finance_effective_comprobantes WHERE id='00000000-0000-0000-0000-0000000e1f04'), 'C2c draft vacío NO es efectivo');

-- ════════════════════════════════════════════════════════════
-- C3: v_finance_pnl — ventas y COGS devengados; exclusiones correctas
--   net_sales = 2000+1500+1000 = 4500 ; cogs = 1200+900+600 = 2700
--   gross_profit = 1800 ; payment_fees=300 ; opex=5000 ; empl_sal=2500
--   operating_result = 1800-300-5000-2500 = -6000
-- ════════════════════════════════════════════════════════════
SELECT pg_temp.assert((SELECT SUM(net_sales) FROM v_finance_pnl WHERE business_id=:'bizA')=4500, 'C3a net_sales=4500 (devengado, incluye drafts efectivos)');
SELECT pg_temp.assert((SELECT SUM(cogs) FROM v_finance_pnl WHERE business_id=:'bizA')=2700, 'C3b cogs=2700 (de items, una vez)');
SELECT pg_temp.assert((SELECT SUM(gross_profit) FROM v_finance_pnl WHERE business_id=:'bizA')=1800, 'C3c gross_profit=1800');
SELECT pg_temp.assert((SELECT SUM(payment_fees) FROM v_finance_pnl WHERE business_id=:'bizA')=300, 'C3d payment_fees=300');
SELECT pg_temp.assert((SELECT SUM(operating_expenses) FROM v_finance_pnl WHERE business_id=:'bizA')=5000, 'C3e operating_expenses=5000 (solo alquiler)');
SELECT pg_temp.assert((SELECT SUM(employee_salaries) FROM v_finance_pnl WHERE business_id=:'bizA')=2500, 'C3f employee_salaries=2500');
SELECT pg_temp.assert((SELECT SUM(operating_result) FROM v_finance_pnl WHERE business_id=:'bizA')=-6000, 'C3g operating_result=-6000');

-- ════════════════════════════════════════════════════════════
-- C4: INVARIANTES — pago proveedor / compra inventario / retiro / cogs-mirror
--   NO afectan el resultado operativo (están excluidos del P&L)
-- ════════════════════════════════════════════════════════════
-- Si se contaran, el opex incluiría 8000+4000+1200+10000 = 23200 más → resultado sería -29200.
SELECT pg_temp.assert((SELECT SUM(operating_result) FROM v_finance_pnl WHERE business_id=:'bizA') = -6000,
  'C4 pago proveedor + compra inventario + COGS-mirror + retiro NO afectan el resultado operativo');
SELECT pg_temp.assert(
  (SELECT count(*) FROM v_finance_pnl p WHERE business_id=:'bizA' AND (
     p.operating_expenses::text LIKE '%8000%' OR p.operating_expenses > 5000)) = 0,
  'C4b ningún BFE inventory_purchase/supplier/owner entró como operating_expense');

-- ════════════════════════════════════════════════════════════
-- C5: v_finance_position — CxP del LEDGER, no de accounts vacía
-- ════════════════════════════════════════════════════════════
INSERT INTO supplier_purchases(id, business_id, supplier_id, purchase_date, total_amount, paid_amount, pending_amount, payment_status)
  VALUES ('00000000-0000-0000-0000-0000000e1591',:'bizA',:'sup','2026-06-10',4000,0,4000,'pending');
INSERT INTO supplier_account_movements(business_id, supplier_id, purchase_id, movement_date, type, description, debit, credit, balance_after)
  VALUES (:'bizA',:'sup','00000000-0000-0000-0000-0000000e1591','2026-06-10','purchase','Compra',4000,0,4000);
SELECT pg_temp.assert((SELECT payables FROM v_finance_position WHERE business_id=:'bizA')=4000, 'C5a payables=4000 (ledger real)');
SELECT pg_temp.assert((SELECT receivables FROM v_finance_position WHERE business_id=:'bizA')=1000, 'C5b receivables=1000 (saldo_pendiente venta CC)');
SELECT pg_temp.assert((SELECT inventory_at_cost FROM v_finance_position WHERE business_id=:'bizA')=60000, 'C5c inventory_at_cost=100*600');

-- ════════════════════════════════════════════════════════════
-- C6: v_finance_product_margin — pérdidas NO truncadas, costo faltante contado
-- ════════════════════════════════════════════════════════════
SELECT pg_temp.assert((SELECT gross_profit FROM v_finance_product_margin WHERE business_id=:'bizA' AND inventory_id=:'prod')=1800, 'C6a gross_profit por producto=1800');
SELECT pg_temp.assert((SELECT units FROM v_finance_product_margin WHERE business_id=:'bizA' AND inventory_id=:'prod')=4.5, 'C6b units=4.5 (2+1.5+1, excluye anulado y draft vacío)');

-- ════════════════════════════════════════════════════════════
-- C7: RPC finance_dashboard_summary v2 — secciones separadas, version 2
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e1a09';
  r := finance_dashboard_summary('00000000-0000-0000-0000-0000000e1a01'::uuid, '2026-06-01', '2026-06-30');
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'finance_model_version')::int=2, 'C7a ok + finance_model_version=2');
  PERFORM pg_temp.assert((r->'profitability'->>'net_sales')::numeric=4500, 'C7b profitability.net_sales=4500');
  PERFORM pg_temp.assert((r->'profitability'->>'operating_result')::numeric=-6000, 'C7c profitability.operating_result=-6000');
  PERFORM pg_temp.assert((r->'position'->>'payables')::numeric=4000, 'C7d position.payables=4000');
  PERFORM pg_temp.assert(r ? 'cashflow' AND r ? 'data_quality' AND r ? 'comparison', 'C7e secciones cashflow/data_quality/comparison presentes');
  PERFORM pg_temp.assert(r->'profitability' IS NOT NULL AND NOT (r ? 'net_result'), 'C7f NO existe un net_result que mezcle todo');
  RESET ROLE;
END $$;

-- ════════════════════════════════════════════════════════════
-- C8: CROSS-TENANT — la RPC de otro negocio no ve datos de bizA
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e1b09';  -- ownerB
  r := finance_dashboard_summary('00000000-0000-0000-0000-0000000e1a01'::uuid, '2026-06-01', '2026-06-30');
  PERFORM pg_temp.assert((r->>'ok')::boolean IS NOT TRUE, 'C8 ownerB NO puede pedir el dashboard de bizA (ownership)');
  RESET ROLE;
END $$;

-- ════════════════════════════════════════════════════════════
-- C9: CONSERVACIÓN — el backfill no cambió cantidad/suma de BFE
--   (la clasificación solo pobló economic_class)
-- ════════════════════════════════════════════════════════════
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE economic_class IS NULL)=0, 'C9a todo BFE quedó clasificado (0 NULL)');
SELECT pg_temp.assert((SELECT ROUND(SUM(amount_ars)) FROM business_finance_entries WHERE business_id=:'bizA')=31000, 'C9b suma BFE bizA intacta = 5000+300+1200+8000+4000+10000+2500');

-- ════════════════════════════════════════════════════════════
-- C10: create_quick_inventory_purchase_atomic — UNA sola BFE técnica
--   (inventory_purchase, EXCLUIDA del P&L), sin duplicación
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_op_before numeric;
BEGIN
  SELECT COALESCE(SUM(operating_result),0) INTO v_op_before FROM v_finance_pnl WHERE business_id='00000000-0000-0000-0000-0000000e1a01';
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e1a09';
  r := create_quick_inventory_purchase_atomic(
    '00000000-0000-0000-0000-0000000e1a01'::uuid, 'qp-key-1',
    '00000000-0000-0000-0000-0000000e1501'::uuid, 'Prov E1', 'FC-1', '2026-06-20', 'efectivo',
    5000, 5000,
    jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-0000000e1d01','product_name','Prod E1','quantity',5,'unit_cost_ars',1000)));
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'C10a compra rápida atómica -> ok (' || COALESCE(r->>'error','') || ')');
  -- replay idempotente
  r := create_quick_inventory_purchase_atomic(
    '00000000-0000-0000-0000-0000000e1a01'::uuid, 'qp-key-1',
    '00000000-0000-0000-0000-0000000e1501'::uuid, 'Prov E1', 'FC-1', '2026-06-20', 'efectivo',
    5000, 5000, '[]'::jsonb);
  PERFORM pg_temp.assert((r->>'replay')::boolean, 'C10b reintento con misma key -> replay (no duplica)');
  RESET ROLE;
END $$;
SELECT pg_temp.assert(
  (SELECT count(*) FROM business_finance_entries WHERE business_id='00000000-0000-0000-0000-0000000e1a01' AND source='pago_proveedor' AND economic_class='inventory_purchase')=1,
  'C10c generó EXACTAMENTE una BFE técnica inventory_purchase (sin triple-escritura)');
SELECT pg_temp.assert(
  (SELECT SUM(operating_result) FROM v_finance_pnl WHERE business_id='00000000-0000-0000-0000-0000000e1a01')=-6000,
  'C10d la compra de inventario NO cambió el resultado operativo (sigue -6000)');
SELECT pg_temp.assert(
  (SELECT stock_quantity FROM inventory WHERE id='00000000-0000-0000-0000-0000000e1d01')=105,
  'C10e stock subió 100 -> 105 por la compra');

SELECT pg_temp.assert(true, '=== etapa1_canonical_model_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
