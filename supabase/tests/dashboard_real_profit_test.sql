-- ============================================================================
-- Bug "Ganancia Real Hoy" — reproducción del modelo de reconocimiento.
--
-- Escenario reportado: un usuario nuevo crea DOS órdenes de reparación, les
-- carga repuestos (presupuesto), NO finaliza / NO entrega / NO cobra / NO
-- factura, y el dashboard mostraba ~$67.000 de "Ganancia real hoy".
--
-- Este test prueba la FUENTE DE VERDAD (no la UI): el P&L canónico
-- (v_finance_pnl) y la RPC finance_dashboard_summary SOLO reconocen margen
-- desde comprobantes comercialmente efectivos. Una orden abierta con
-- order_parts (status='used', el default de orderPartsService al agregar el
-- repuesto) NO aporta ganancia. La recae una sola vez con el comprobante
-- efectivo, y se revierte al anular.
--
-- RUN (stack local): supabase db reset && aplicar migraciones && psql -f
-- Transacción con ROLLBACK — no deja datos.
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set biz    '00000000-0000-0000-0000-0000000da101'
\set owner  '00000000-0000-0000-0000-0000000da109'
\set biz2   '00000000-0000-0000-0000-0000000da201'
\set owner2 '00000000-0000-0000-0000-0000000da209'
\set ord1   '00000000-0000-0000-0000-0000000da301'
\set ord2   '00000000-0000-0000-0000-0000000da302'
\set comp1  '00000000-0000-0000-0000-0000000da401'

-- ── Setup: negocios, dueños, perfiles (bypass triggers/FK con replica) ──────
SET LOCAL session_replication_role = 'replica';
INSERT INTO auth.users(id) VALUES (:'owner'), (:'owner2');
INSERT INTO businesses(id, name, owner_user_id) VALUES
  (:'biz','Real Profit Repro',:'owner'),
  (:'biz2','Otro Negocio',:'owner2');
INSERT INTO profiles(business_id, user_id, role, is_active) VALUES
  (:'biz', :'owner', 'owner', true),
  (:'biz2',:'owner2','owner', true);

-- ── Dos órdenes ABIERTAS con repuestos cargados (presupuesto), sin cobrar ───
-- status intermedios reales del enum orders_status_check; NUNCA completed.
INSERT INTO orders(id, business_id, status, estimated_total, total_cost, created_by) VALUES
  (:'ord1', :'biz', 'repair',         40000, 40000, :'owner'),
  (:'ord2', :'biz', 'ready_delivery', 60000, 60000, :'owner');

-- order_parts con status='used' (el default de orderPartsService.addPartToOrder
-- al AGREGAR el repuesto) y added_at = hoy. Margen "prematuro" = 25000 + 42000
-- = 67000 (reproduce la cifra reportada).
INSERT INTO order_parts(order_id, business_id, name, internal_cost, sale_price, quantity, status, added_at, created_by) VALUES
  (:'ord1', :'biz', 'Pantalla', 15000, 40000, 1, 'used', now(), :'owner'),
  (:'ord2', :'biz', 'Batería',  18000, 60000, 1, 'used', now(), :'owner');
SET LOCAL session_replication_role = 'origin';

-- Sanidad: el margen "prematuro" que veía el cálculo viejo era 67000
SELECT pg_temp.assert(
  (SELECT COALESCE(SUM(GREATEST(0,(sale_price-internal_cost))*quantity),0)
     FROM order_parts WHERE business_id=:'biz')=67000,
  'D0 order_parts acumulan 67000 de margen a add-time (lo que el bug mostraba)');

-- ── D1: el P&L canónico NO ve ese margen — no hay comprobante efectivo ──────
SELECT pg_temp.assert(
  COALESCE((SELECT SUM(gross_profit) FROM v_finance_pnl WHERE business_id=:'biz'),0)=0,
  'D1 v_finance_pnl.gross_profit = 0 con órdenes abiertas (order_parts NO es venta)');
SELECT pg_temp.assert(
  COALESCE((SELECT SUM(net_sales) FROM v_finance_pnl WHERE business_id=:'biz'),0)=0,
  'D1b v_finance_pnl.net_sales = 0 (no hay comprobante_items efectivos)');

-- ── D2: la RPC del dashboard también devuelve 0 (misma fuente) ──────────────
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000da109';
  r := finance_dashboard_summary('00000000-0000-0000-0000-0000000da101'::uuid, '2026-06-01', '2026-06-30');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'D2a RPC ok:true');
  PERFORM pg_temp.assert((r->'profitability'->>'gross_profit')::numeric=0,
    'D2 finance_dashboard_summary.gross_profit = 0 con solo órdenes abiertas');
  RESET ROLE;
END $$;

-- ── Ahora SÍ: comprobante efectivo (issued) por la primera reparación ───────
-- Reconoce ingreso 40000 y costo 15000 → margen 25000, UNA vez.
SET LOCAL session_replication_role = 'replica';
INSERT INTO comprobantes(id, business_id, order_id, tipo, type, status, estado, estado_comercial, estado_fiscal,
                         fecha, date, total, total_bruto, saldo_pendiente, currency, exchange_rate)
VALUES (:'comp1', :'biz', :'ord1', 'factura_c', 'factura_c', 'issued', 'emitido', 'pendiente', 'no_fiscal',
        '2026-06-15 15:00:00+00', '2026-06-15 15:00:00+00', 40000, 40000, 40000, 'ARS', 1);
INSERT INTO comprobante_items(comprobante_id, business_id, descripcion, cantidad, precio_unitario,
                              subtotal, costo_unitario, costo_total, tipo_linea)
VALUES (:'comp1', :'biz', 'Reparación pantalla', 1, 40000, 40000, 15000, 15000, 'servicio');
SET LOCAL session_replication_role = 'origin';

-- ── D3: el margen se reconoce una sola vez, en la fecha del comprobante ─────
SELECT pg_temp.assert(
  (SELECT gross_profit FROM v_finance_pnl WHERE business_id=:'biz' AND period_date='2026-06-15')=25000,
  'D3 v_finance_pnl.gross_profit = 25000 el 2026-06-15 (una sola vez, con comprobante efectivo)');
SELECT pg_temp.assert(
  (SELECT net_sales FROM v_finance_pnl WHERE business_id=:'biz' AND period_date='2026-06-15')=40000
  AND (SELECT cogs FROM v_finance_pnl WHERE business_id=:'biz' AND period_date='2026-06-15')=15000,
  'D3b ingreso 40000 y costo 15000 reconocidos exactamente una vez');

-- ── D4: la RPC del día del comprobante lo refleja; el total del negocio no ──
-- se infla con los 67000 de order_parts (solo el margen devengado real).
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000da109';
  r := finance_dashboard_summary('00000000-0000-0000-0000-0000000da101'::uuid, '2026-06-15', '2026-06-15');
  PERFORM pg_temp.assert((r->'profitability'->>'gross_profit')::numeric=25000,
    'D4 finance_dashboard_summary(15-jun).gross_profit = 25000 (nunca 67000+)');
  RESET ROLE;
END $$;

-- ── D5: agregar OTRO repuesto a la orden abierta NO altera el P&L ───────────
SET LOCAL session_replication_role = 'replica';
INSERT INTO order_parts(order_id, business_id, name, internal_cost, sale_price, quantity, status, added_at, created_by)
VALUES (:'ord1', :'biz', 'Cable flex', 2000, 12000, 3, 'used', now(), :'owner');
SET LOCAL session_replication_role = 'origin';
SELECT pg_temp.assert(
  (SELECT gross_profit FROM v_finance_pnl WHERE business_id=:'biz' AND period_date='2026-06-15')=25000,
  'D5 agregar order_parts a la orden abierta NO cambia el margen devengado (sigue 25000)');

-- ── D6: anular el comprobante revierte el reconocimiento (acumulado vuelve a 0) ─
-- M7 6F.4: la anulacion pasa por la RPC canonica (un UPDATE directo lo rechaza el
-- guard trg_comprobante_annulment_transition) y la reversion es APPEND-ONLY: junio
-- CONSERVA su margen y la compensacion se registra en el periodo de la anulacion.
-- El acumulado sigue dando 0, que es lo que este caso siempre quiso comprobar.
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000da109';
  -- sin cobros registrados -> anulacion comercial (no hay dinero que devolver)
  r := annul_comprobante_atomic('00000000-0000-0000-0000-0000000da401'::uuid,
       'commercial_annulment', 'anulacion de prueba', false, 'D6KEY');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'ok'='true', 'D6a la anulacion via RPC canonica funciona');
END $$;
SELECT pg_temp.assert(
  (SELECT gross_profit FROM v_finance_pnl WHERE business_id=:'biz' AND period_date='2026-06-15')=25000,
  'D6b el periodo ORIGINAL conserva su margen devengado (append-only)');
SELECT pg_temp.assert(
  COALESCE((SELECT SUM(gross_profit) FROM v_finance_pnl WHERE business_id=:'biz'),0)=0,
  'D6 tras anular, el gross_profit ACUMULADO = 0 (reversión consistente)');

-- ── D7: aislamiento — el dueño del OTRO negocio no accede al P&L de biz1 ────
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000da209'; -- owner2
  r := finance_dashboard_summary('00000000-0000-0000-0000-0000000da101'::uuid, '2026-06-01', '2026-06-30');
  PERFORM pg_temp.assert((r->>'ok')::boolean IS NOT TRUE,
    'D7 owner2 NO puede leer el P&L de biz1 (ownership check de la RPC)');
  RESET ROLE;
END $$;

SELECT pg_temp.assert(true, '=== dashboard_real_profit_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
