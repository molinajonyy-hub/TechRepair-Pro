-- ============================================================
-- El P&L canónico (v_finance_pnl) NO se calcula desde clases excluidas.
-- Verifica que BFE clasificados supplier_liability_payment / inventory_purchase
-- / owner_withdrawal / revenue_collection_mirror NO contaminan el resultado
-- operativo, y que un gasto operativo real SÍ lo hace. (Fase 4 — item 6.)
-- También: finance_dashboard_summary v2 responde vacío sin romper (zeros).
--
-- RUN: supabase db reset && docker cp ... && psql -f
-- Transacción con ROLLBACK.
-- ============================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set biz   '00000000-0000-0000-0000-0000000be101'
\set owner '00000000-0000-0000-0000-0000000be109'

SET LOCAL session_replication_role = 'replica';
INSERT INTO auth.users(id) VALUES (:'owner');
INSERT INTO businesses(id, name, owner_user_id) VALUES (:'biz','PnL Excl',:'owner');
INSERT INTO profiles(business_id, user_id, role, is_active) VALUES (:'biz',:'owner','owner',true);
SET LOCAL session_replication_role = 'origin';

-- Inserta BFE en modo origin → el trigger trig_bfe_economic_class clasifica.
-- Cada fila representa una clase; sólo el gasto operativo debe entrar al P&L.
INSERT INTO business_finance_entries (business_id, date, type, category, description, amount, currency, amount_ars, exchange_rate, source, created_by) VALUES
  (:'biz','2026-06-10','income','ventas_productos','cobro',   100000,'ARS',100000,1,'comprobante',:'owner'),  -- revenue_collection_mirror
  (:'biz','2026-06-10','variable_cost','compras_proveedor','pago prov', 50000,'ARS', 50000,1,'pago_proveedor',:'owner'), -- supplier_liability_payment
  (:'biz','2026-06-10','variable_cost','inventario','compra stock',     40000,'ARS', 40000,1,'expense',:'owner'),        -- inventory_purchase
  (:'biz','2026-06-10','salary','retiros','retiro dueño',               30000,'ARS', 30000,1,'expense',:'owner'),        -- owner_withdrawal
  (:'biz','2026-06-10','fixed_cost_local','alquiler','alquiler local',  20000,'ARS', 20000,1,'expense',:'owner');        -- operating_expense (SÍ entra)

-- Sanidad: la clasificación quedó como se espera
SELECT pg_temp.assert((SELECT economic_class FROM business_finance_entries WHERE business_id=:'biz' AND source='comprobante')='revenue_collection_mirror', 'PX0a income comprobante -> revenue_collection_mirror');
SELECT pg_temp.assert((SELECT economic_class FROM business_finance_entries WHERE business_id=:'biz' AND category='compras_proveedor')='supplier_liability_payment', 'PX0b compras_proveedor -> supplier_liability_payment');
SELECT pg_temp.assert((SELECT economic_class FROM business_finance_entries WHERE business_id=:'biz' AND category='inventario')='inventory_purchase', 'PX0c inventario -> inventory_purchase');
SELECT pg_temp.assert((SELECT economic_class FROM business_finance_entries WHERE business_id=:'biz' AND category='retiros')='owner_withdrawal', 'PX0d retiros -> owner_withdrawal');
SELECT pg_temp.assert((SELECT economic_class FROM business_finance_entries WHERE business_id=:'biz' AND category='alquiler')='operating_expense', 'PX0e alquiler -> operating_expense');

-- P&L canónico: sólo el gasto operativo impacta. Ventas=0 (sin comprobante_items).
SELECT pg_temp.assert(COALESCE((SELECT SUM(net_sales) FROM v_finance_pnl WHERE business_id=:'biz'),0)=0, 'PX1 net_sales=0 (revenue_collection_mirror NO es venta)');
SELECT pg_temp.assert(COALESCE((SELECT SUM(cogs) FROM v_finance_pnl WHERE business_id=:'biz'),0)=0, 'PX2 cogs=0 (inventory_purchase NO es COGS)');
SELECT pg_temp.assert((SELECT COALESCE(SUM(operating_expenses),0) FROM v_finance_pnl WHERE business_id=:'biz')=20000, 'PX3 operating_expenses = SOLO el gasto operativo (20000)');
SELECT pg_temp.assert((SELECT COALESCE(SUM(operating_result),0) FROM v_finance_pnl WHERE business_id=:'biz')=-20000, 'PX4 operating_result = -20000 (excluidos NO contaminan)');
-- Las 3 clases de deuda/retiro/compra NO aparecen como gasto operativo ni salario
SELECT pg_temp.assert((SELECT COALESCE(SUM(employee_salaries),0) FROM v_finance_pnl WHERE business_id=:'biz')=0, 'PX5 owner_withdrawal NO es employee_salary en P&L');

-- finance_dashboard_summary v2 con período VACÍO no rompe (zeros, ok:true)
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000be109';
  r := finance_dashboard_summary('00000000-0000-0000-0000-0000000be101'::uuid, '2019-01-01', '2019-12-31'); -- período sin datos
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'PX6 v2 período vacío -> ok:true (no rompe)');
  PERFORM pg_temp.assert((r->>'finance_model_version')='2', 'PX7 v2 devuelve finance_model_version=2');
  PERFORM pg_temp.assert((r->'profitability'->>'net_sales')::numeric=0, 'PX8 v2 período vacío -> net_sales 0');
  RESET ROLE;
END $$;

SELECT pg_temp.assert(true, '=== etapa1_pnl_exclusions_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
