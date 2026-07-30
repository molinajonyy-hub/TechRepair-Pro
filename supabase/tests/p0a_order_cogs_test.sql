-- ============================================================================
-- P0-A — Reconocimiento del COGS de repuestos consumidos en órdenes.
--
-- Reproduce la ORDEN DE CONTROL del P0 y fija los invariantes de la corrección:
--   · servicio 50.000 + batería absorbida con costo snapshot 12.200
--   · ingreso 50.000, COGS 12.200, resultado 37.800
--   · el stock se descuenta EXACTAMENTE UNA VEZ (al agregar el repuesto)
--   · el comprobante nace vinculado a la orden (order_id)
--   · el costo sale del snapshot de la orden, NO del inventario vivo
--   · ledger = v_finance_pnl = finance_dashboard_summary
--   · retry idempotente, pago mixto, cuenta corriente y anulación
--   · el detector canónico v_finance_order_cogs_gaps acusa el caso viejo
--
-- READ-ONLY sobre datos productivos: todo corre dentro de BEGIN … ROLLBACK.
-- RUN: docker cp supabase/tests/p0a_order_cogs_test.sql supabase_db_techrepair-vite:/tmp/ \
--      && docker exec supabase_db_techrepair-vite psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -f /tmp/p0a_order_cogs_test.sql
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set biz   '00000000-0000-0000-0000-0000000c0a01'
\set own   '00000000-0000-0000-0000-0000000c0a09'
\set cust  '00000000-0000-0000-0000-0000000c0ac1'
\set inv   '00000000-0000-0000-0000-0000000c0ad1'
\set caja  '00000000-0000-0000-0000-0000000c0a61'
\set ord   '00000000-0000-0000-0000-0000000c0af1'
\set ord2  '00000000-0000-0000-0000-0000000c0af2'
\set ord3  '00000000-0000-0000-0000-0000000c0af3'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'own');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','P0A Taller',:'own');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES (:'biz',:'own','owner',true);
INSERT INTO customers(id,business_id,name,phone,customer_type) VALUES (:'cust',:'biz','Cliente P0A','+540009','minorista');
-- OJO: cost_price del inventario = 99.999. Si el checkout resolviera el costo
-- del inventario VIVO en lugar del snapshot de la orden, el COGS daría 99.999.
INSERT INTO inventory(id,business_id,name,code,category,stock_quantity,stock,cost_price,sale_price,base_price,base_currency,auto_update_price,exchange_rate_used,is_active)
  VALUES (:'inv',:'biz','Bateria JK50','P0A-1','Repuestos',10,10,99999,17000,17000,'ARS',false,1,true);
INSERT INTO cajas(id,business_id,opened_by,status) VALUES (:'caja',:'biz',:'own','abierta');
INSERT INTO orders(id,business_id,status,created_by) VALUES
  (:'ord',:'biz','completed',:'own'), (:'ord2',:'biz','completed',:'own'), (:'ord3',:'biz','completed',:'own');
SET LOCAL session_replication_role='origin';

-- ── Consumo del repuesto en la orden (el trigger descuenta stock) ────────────
-- cliente_paga_repuesto = false: absorbido por el precio del servicio, tal como
-- el 100 % de los repuestos productivos.
INSERT INTO order_items(order_id,product_id,business_id,tipo,descripcion,cantidad,precio_unitario,costo_unitario,cliente_paga_repuesto)
  VALUES (:'ord',:'inv',:'biz','repuesto','Bateria JK50',1,17000,12200,false);
INSERT INTO order_items(order_id,product_id,business_id,tipo,descripcion,cantidad,precio_unitario,costo_unitario,cliente_paga_repuesto)
  VALUES (:'ord',NULL,:'biz','servicio','Cambio de bateria',1,50000,0,false);

SELECT pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id=:'inv')=9,
  'C0 el consumo del repuesto descontó stock 10 -> 9');
SELECT pg_temp.assert((SELECT count(*) FROM inventory_movements WHERE inventory_item_id=:'inv')=1,
  'C0b un solo inventory_movement (order_usage)');
SELECT pg_temp.assert((SELECT total_cost FROM orders WHERE id=:'ord')=12200,
  'C0c orders.total_cost es la suma de COSTOS (no de precios) — semántica vigente');

-- ── Payload EXACTO que produce el armado corregido (src/lib/orderBilling.ts) ─
-- Una sola línea de servicio: precio 50.000 (el total cotizado no cambia) y
-- costo_unitario 12.200 (el costo absorbido, plegado). inventory_id AUSENTE.
-- p_cc: la cuenta corriente NO es un método de pago de caja; viaja como cc_total
-- (mismo contrato que comprobanteService, que filtra 'cuenta_corriente' de los pagos).
CREATE OR REPLACE FUNCTION pg_temp.payload_p0a(p_order uuid, p_costo numeric, p_pagos jsonb, p_cc numeric DEFAULT 0)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'tipo','factura_c','punto_venta','0001','condicion_fiscal','Consumidor Final',
    'customer_id','00000000-0000-0000-0000-0000000c0ac1',
    'order_id', p_order, 'es_fiscal', false, 'cc_total', p_cc,
    'items', jsonb_build_array(jsonb_build_object(
      'descripcion','Cambio de bateria','tipo_linea','servicio','cantidad',1,
      'precio_unitario',50000,'descuento_linea',0,'costo_unitario',p_costo,
      'currency','ARS','exchange_rate',1,'inventory_id',NULL)),
    'pagos', p_pagos) $$;

CREATE OR REPLACE FUNCTION pg_temp.pago(metodo text, monto numeric)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('payment_method',metodo,'amount',monto,'currency','ARS',
                            'amount_ars',monto,'exchange_rate',1) $$;

-- ============ 1. Checkout de la orden de control ============================
DO $$
DECLARE r jsonb; v_comp uuid;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c0a09';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000c0a01'::uuid,'P0A-1','h1',
        pg_temp.payload_p0a('00000000-0000-0000-0000-0000000c0af1'::uuid, 12200,
          jsonb_build_array(pg_temp.pago('efectivo',50000))));
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status'='created', 'A1 checkout created ('||COALESCE(r->>'error','')||')');
  v_comp := (r->>'comprobante_id')::uuid;
  PERFORM set_config('p0a.comp', v_comp::text, true);
END $$;

-- ── Invariantes contables ───────────────────────────────────────────────────
SELECT pg_temp.assert((SELECT order_id FROM comprobantes WHERE id=current_setting('p0a.comp')::uuid)=:'ord',
  'A2 comprobante VINCULADO a la orden (order_id persistido)');
SELECT pg_temp.assert((SELECT ROUND(SUM(costo_total),2) FROM comprobante_items WHERE comprobante_id=current_setting('p0a.comp')::uuid)=12200.00,
  'A3 comprobante_items.costo_total = 12.200 (snapshot de la orden)');
SELECT pg_temp.assert((SELECT ROUND(SUM(subtotal),2) FROM comprobante_items WHERE comprobante_id=current_setting('p0a.comp')::uuid)=50000.00,
  'A4 el total cotizado al cliente NO cambió (50.000)');
SELECT pg_temp.assert((SELECT count(*) FROM comprobante_items WHERE comprobante_id=current_setting('p0a.comp')::uuid AND inventory_id IS NOT NULL)=0,
  'A5 ninguna línea con inventory_id');

-- ── EL invariante crítico: stock descontado exactamente UNA vez ─────────────
SELECT pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id=:'inv')=9,
  'A6 stock sigue en 9 tras facturar — NUNCA 8 (sin doble descuento)');
SELECT pg_temp.assert((SELECT count(*) FROM inventory_movements WHERE inventory_item_id=:'inv')=1,
  'A7 sigue habiendo UN solo inventory_movement (no se agregó uno de venta)');
SELECT pg_temp.assert((SELECT count(*) FROM inventory_movements WHERE inventory_item_id=:'inv' AND movement_type='sale')=0,
  'A8 el checkout no generó movimiento de venta para el repuesto ya consumido');

-- ── El costo NO viene del inventario vivo (cost_price = 99.999) ─────────────
SELECT pg_temp.assert((SELECT ROUND(SUM(costo_total),2) FROM comprobante_items WHERE comprobante_id=current_setting('p0a.comp')::uuid) <> 99999.00,
  'A9 el COGS es el snapshot histórico (12.200), no el costo actual del inventario (99.999)');

-- ── Ledger devengado y P&L ─────────────────────────────────────────────────
SELECT pg_temp.assert(
  (SELECT ROUND(SUM(cogs_amount_ars),2) FROM v_finance_sales_ledger
    WHERE business_id=:'biz' AND event_type='sale' AND comprobante_id=current_setting('p0a.comp')::uuid)=12200.00,
  'A10 v_finance_sales_ledger reconoce el COGS de 12.200');
SELECT pg_temp.assert(
  (SELECT ROUND(SUM(net_sales),2)=50000.00 AND ROUND(SUM(cogs),2)=12200.00
       AND ROUND(SUM(gross_profit),2)=37800.00 AND ROUND(SUM(operating_result),2)=37800.00
     FROM v_finance_pnl WHERE business_id=:'biz' AND period_date=public.ar_today()),
  'A11 v_finance_pnl: ventas 50.000 · COGS 12.200 · resultado 37.800');
-- Corte diario en zona horaria Argentina.
SELECT pg_temp.assert((SELECT count(*) FROM v_finance_pnl WHERE business_id=:'biz' AND period_date=public.ar_today())=1,
  'A12 el período se fecha con ar_today() (timezone del negocio)');

-- ── Dashboard = P&L = ledger ────────────────────────────────────────────────
DO $$
DECLARE d jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c0a09';
  d := finance_dashboard_summary('00000000-0000-0000-0000-0000000c0a01'::uuid, public.ar_today(), public.ar_today());
  RESET ROLE;
  PERFORM pg_temp.assert((d->'profitability'->>'cogs')::numeric = 12200,
    'A13 finance_dashboard_summary.cogs = 12.200 (misma fuente canónica)');
  PERFORM pg_temp.assert((d->'profitability'->>'operating_result')::numeric = 37800,
    'A14 finance_dashboard_summary.operating_result = 37.800 — el Dashboard muestra la ganancia real');
END $$;

-- ── El detector canónico no acusa nada para esta orden ──────────────────────
SELECT pg_temp.assert((SELECT count(*) FROM v_finance_order_cogs_gaps
    WHERE order_id=:'ord' AND gap_type IN ('cogs_incompleto','orden_sin_comprobante_vinculado'))=0,
  'A15 v_finance_order_cogs_gaps sin hueco para la orden corregida');
SELECT pg_temp.assert((SELECT count(*) FROM v_finance_order_cogs_gaps WHERE order_id=:'ord' AND gap_type='riesgo_doble_stock')=0,
  'A16 sin riesgo de doble descuento de stock');

-- ============ 2. Retry idempotente =========================================
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c0a09';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000c0a01'::uuid,'P0A-1','h1',
        pg_temp.payload_p0a('00000000-0000-0000-0000-0000000c0af1'::uuid, 12200,
          jsonb_build_array(pg_temp.pago('efectivo',50000))));
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status'='existing', 'B1 retry con la misma key -> existing');
  PERFORM pg_temp.assert((r->>'comprobante_id')::uuid = current_setting('p0a.comp')::uuid, 'B2 mismo comprobante');
END $$;
SELECT pg_temp.assert((SELECT count(*) FROM comprobantes WHERE business_id=:'biz')=1, 'B3 un solo comprobante');
SELECT pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id=:'inv')=9, 'B4 stock intacto en el retry (9)');
SELECT pg_temp.assert((SELECT ROUND(SUM(cogs),2) FROM v_finance_pnl WHERE business_id=:'biz' AND period_date=public.ar_today())=12200.00,
  'B5 el COGS no se duplicó por el retry');

-- ============ 3. Pago mixto y cuenta corriente =============================
-- El devengado NO depende de la forma de pago: mismas ventas y mismo COGS.
INSERT INTO order_items(order_id,product_id,business_id,tipo,descripcion,cantidad,precio_unitario,costo_unitario,cliente_paga_repuesto)
  VALUES (:'ord2',:'inv',:'biz','repuesto','Bateria JK50',1,17000,12200,false);
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c0a09';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000c0a01'::uuid,'P0A-MIX','h2',
        pg_temp.payload_p0a('00000000-0000-0000-0000-0000000c0af2'::uuid, 12200,
          jsonb_build_array(pg_temp.pago('efectivo',20000), pg_temp.pago('transferencia',30000))));
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status'='created', 'C1 pago mixto -> created ('||COALESCE(r->>'error','')||')');
  PERFORM pg_temp.assert(
    (SELECT ROUND(SUM(costo_total),2) FROM comprobante_items WHERE comprobante_id=(r->>'comprobante_id')::uuid)=12200.00,
    'C2 pago mixto reconoce el mismo COGS');
  PERFORM pg_temp.assert((SELECT order_id FROM comprobantes WHERE id=(r->>'comprobante_id')::uuid)
    ='00000000-0000-0000-0000-0000000c0af2'::uuid, 'C3 pago mixto conserva el vínculo con la orden');
END $$;

INSERT INTO order_items(order_id,product_id,business_id,tipo,descripcion,cantidad,precio_unitario,costo_unitario,cliente_paga_repuesto)
  VALUES (:'ord3',:'inv',:'biz','repuesto','Bateria JK50',1,17000,12200,false);
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c0a09';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000c0a01'::uuid,'P0A-CC','h3',
        pg_temp.payload_p0a('00000000-0000-0000-0000-0000000c0af3'::uuid, 12200, '[]'::jsonb, 50000));
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status'='created', 'D1 cuenta corriente -> created ('||COALESCE(r->>'error','')||')');
  PERFORM pg_temp.assert(
    (SELECT ROUND(SUM(costo_total),2) FROM comprobante_items WHERE comprobante_id=(r->>'comprobante_id')::uuid)=12200.00,
    'D2 cuenta corriente reconoce el mismo COGS (devengado, no percibido)');
END $$;
-- 3 ventas de 50.000 con 12.200 de costo cada una.
SELECT pg_temp.assert((SELECT ROUND(SUM(net_sales),2)=150000.00 AND ROUND(SUM(cogs),2)=36600.00
    AND ROUND(SUM(operating_result),2)=113400.00 FROM v_finance_pnl WHERE business_id=:'biz'),
  'D3 P&L acumulado: 150.000 − 36.600 = 113.400 (simple + mixto + CC)');
SELECT pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id=:'inv')=7,
  'D4 stock 10 − 3 consumos = 7 (una vez por repuesto, nunca por facturar)');

-- ============ 4. Anulación: revierte ingreso Y COGS ========================
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c0a09';
  r := annul_comprobante_atomic(current_setting('p0a.comp')::uuid, 'void_same_session',
        'test P0-A', true, 'P0A-ANN-1');
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'E1 anulación ok ('||COALESCE(r->>'error','')||')');
END $$;
-- El ledger compensa: el par (venta, anulación) netea 0 en ingreso y en COGS.
SELECT pg_temp.assert((SELECT ROUND(COALESCE(SUM(sales_amount_ars),0),2)=0.00 AND ROUND(COALESCE(SUM(cogs_amount_ars),0),2)=0.00
    FROM v_finance_sales_ledger WHERE comprobante_id=current_setting('p0a.comp')::uuid),
  'E2 la anulación revierte ingreso Y COGS (el par netea 0, append-only)');
SELECT pg_temp.assert((SELECT count(*) FROM v_finance_sales_ledger
    WHERE comprobante_id=current_setting('p0a.comp')::uuid AND event_type='annulment')=1,
  'E3 se registró el evento de anulación (no se borró la venta)');
-- El repuesto está DENTRO del equipo reparado: anular la factura no lo devuelve.
SELECT pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id=:'inv')=7,
  'E4 la anulación NO repone stock del repuesto consumido (no hubo salida por venta)');

-- ============ 5. Control de regresión: el armado VIEJO deja el hueco =======
-- Mismo escenario, pero con el payload anterior (costo_unitario = 0): el
-- detector canónico tiene que acusarlo. Si este assert falla, el detector es
-- ciego y el bug podría volver sin alarma.
SET LOCAL session_replication_role='replica';
INSERT INTO orders(id,business_id,status,created_by) VALUES ('00000000-0000-0000-0000-0000000c0b01',:'biz','completed',:'own');
SET LOCAL session_replication_role='origin';
INSERT INTO order_items(order_id,product_id,business_id,tipo,descripcion,cantidad,precio_unitario,costo_unitario,cliente_paga_repuesto)
  VALUES ('00000000-0000-0000-0000-0000000c0b01',:'inv',:'biz','repuesto','Bateria JK50',1,17000,12200,false);
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c0a09';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000c0a01'::uuid,'P0A-OLD','h9',
        pg_temp.payload_p0a('00000000-0000-0000-0000-0000000c0b01'::uuid, 0,
          jsonb_build_array(pg_temp.pago('efectivo',50000))));
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status'='created', 'F1 checkout legacy (costo 0) created');
END $$;
SELECT pg_temp.assert((SELECT ROUND(gap_ars,2) FROM v_finance_order_cogs_gaps
    WHERE order_id='00000000-0000-0000-0000-0000000c0b01' AND gap_type='cogs_incompleto')=12200.00,
  'F2 el detector acusa cogs_incompleto por 12.200 en el armado viejo');
SELECT pg_temp.assert((SELECT severity FROM v_finance_order_cogs_gaps
    WHERE order_id='00000000-0000-0000-0000-0000000c0b01' AND gap_type='cogs_incompleto')='critical',
  'F3 el hueco de COGS es critical');

-- ============ 6. Snapshot faltante: nunca pasa como cero silencioso ========
SET LOCAL session_replication_role='replica';
INSERT INTO orders(id,business_id,status,created_by) VALUES ('00000000-0000-0000-0000-0000000c0b02',:'biz','completed',:'own');
SET LOCAL session_replication_role='origin';
INSERT INTO order_items(order_id,product_id,business_id,tipo,descripcion,cantidad,precio_unitario,costo_unitario,cliente_paga_repuesto)
  VALUES ('00000000-0000-0000-0000-0000000c0b02',:'inv',:'biz','repuesto','Bateria sin costo',1,17000,0,false);
SELECT pg_temp.assert((SELECT count(*) FROM v_finance_order_cogs_gaps
    WHERE order_id='00000000-0000-0000-0000-0000000c0b02' AND gap_type='snapshot_de_costo_faltante')=1,
  'G1 repuesto consumido sin snapshot de costo queda expuesto (no pasa como cero)');

-- ============ 7. Aislamiento por negocio de la vista =======================
DO $$
DECLARE v_n int;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c0a09';
  SELECT count(*) INTO v_n FROM v_finance_order_cogs_gaps WHERE business_id <> '00000000-0000-0000-0000-0000000c0a01';
  RESET ROLE;
  PERFORM pg_temp.assert(v_n = 0, 'H1 la vista no expone huecos de otros negocios (security_invoker + RLS)');
END $$;

ROLLBACK;
