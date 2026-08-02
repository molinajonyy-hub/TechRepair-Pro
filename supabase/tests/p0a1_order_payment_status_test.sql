-- ============================================================================
-- P0-A.1 — Cierre automático de órdenes y estado de cobro derivado.
-- Reproduce el flujo completo de la especificación §19 y fija los invariantes.
-- READ-ONLY sobre datos reales: todo dentro de BEGIN … ROLLBACK.
-- RUN: docker cp supabase/tests/p0a1_order_payment_status_test.sql supabase_db_techrepair-vite:/tmp/ \
--      && docker exec supabase_db_techrepair-vite psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -f /tmp/p0a1_order_payment_status_test.sql
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set biz  '00000000-0000-0000-0000-0000000d0a01'
\set own  '00000000-0000-0000-0000-0000000d0a09'
\set biz2 '00000000-0000-0000-0000-0000000d0b01'
\set own2 '00000000-0000-0000-0000-0000000d0b09'
\set cust '00000000-0000-0000-0000-0000000d0ac1'
\set inv  '00000000-0000-0000-0000-0000000d0ad1'
\set caja '00000000-0000-0000-0000-0000000d0a61'
\set ordA '00000000-0000-0000-0000-0000000d0af1'
\set ordB '00000000-0000-0000-0000-0000000d0af2'
\set ordC '00000000-0000-0000-0000-0000000d0af3'
\set ordD '00000000-0000-0000-0000-0000000d0af4'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'own'), (:'own2');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','P0A1 A',:'own'), (:'biz2','P0A1 B',:'own2');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES (:'biz',:'own','owner',true), (:'biz2',:'own2','owner',true);
INSERT INTO customers(id,business_id,name,phone,customer_type) VALUES (:'cust',:'biz','Cliente','+540009','minorista');
INSERT INTO inventory(id,business_id,name,code,category,stock_quantity,stock,cost_price,sale_price,base_price,base_currency,auto_update_price,exchange_rate_used,is_active)
  VALUES (:'inv',:'biz','Bateria','D-1','Rep',10,10,99999,17000,17000,'ARS',false,1,true);
INSERT INTO cajas(id,business_id,opened_by,status) VALUES (:'caja',:'biz',:'own','abierta');
INSERT INTO orders(id,business_id,status,created_by) VALUES
  (:'ordA',:'biz','repair',:'own'), (:'ordB',:'biz','repair',:'own'),
  (:'ordC',:'biz','cancelled',:'own'), (:'ordD',:'biz','repair',:'own');
SET LOCAL session_replication_role='origin';

-- Repuesto absorbido en la orden A (P0-A: el costo se pliega en el servicio).
INSERT INTO order_items(order_id,product_id,business_id,tipo,descripcion,cantidad,precio_unitario,costo_unitario,cliente_paga_repuesto)
  VALUES (:'ordA',:'inv',:'biz','repuesto','Bateria',1,17000,12200,false),
         (:'ordA',NULL,:'biz','servicio','Cambio de bateria',1,50000,0,false);

CREATE OR REPLACE FUNCTION pg_temp.payload(p_order uuid, p_pagos jsonb, p_cc numeric DEFAULT 0)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'tipo','factura_c','punto_venta','0001','condicion_fiscal','Consumidor Final',
    'customer_id','00000000-0000-0000-0000-0000000d0ac1',
    'order_id', p_order, 'es_fiscal', false, 'cc_total', p_cc,
    'items', jsonb_build_array(jsonb_build_object(
      'descripcion','Cambio de bateria','tipo_linea','servicio','cantidad',1,
      'precio_unitario',50000,'descuento_linea',0,'costo_unitario',12200,
      'currency','ARS','exchange_rate',1,'inventory_id',NULL)),
    'pagos', p_pagos) $$;
CREATE OR REPLACE FUNCTION pg_temp.pago(monto numeric)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('payment_method','efectivo','amount',monto,'currency','ARS',
                            'amount_ars',monto,'exchange_rate',1) $$;
CREATE OR REPLACE FUNCTION pg_temp.st(p_order uuid)
RETURNS v_order_financial_status LANGUAGE sql AS $$
  SELECT * FROM v_order_financial_status WHERE order_id = p_order $$;

-- ============ A. Checkout con saldo (§19 primer tramo) ======================
-- CONTRATO REAL DEL MODELO, verificado: el checkout NO admite un pago parcial
-- "suelto" — exige pagos + cuenta_corriente = total, o rechaza con
-- "el cobro no cubre el total del comprobante". Por lo tanto el ÚNICO modo de
-- que una orden quede con saldo es el pago mixto con la diferencia a cuenta
-- corriente. El caso "pago parcial puro" de la especificación §7.B no existe
-- en este ledger; se expresa como §7.F. Documentado en el informe.
SELECT pg_temp.assert((SELECT status FROM orders WHERE id=:'ordA')='repair', 'A0 la orden arranca en repair');
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000d0a09';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000d0a01'::uuid,'A1','h1',
        pg_temp.payload('00000000-0000-0000-0000-0000000d0af1'::uuid,
                        jsonb_build_array(pg_temp.pago(20000)), 30000));
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status'='created', 'A1 checkout mixto created ('||COALESCE(r->>'error','')||')');
  PERFORM set_config('t.compA', r->>'comprobante_id', true);
END $$;

SELECT pg_temp.assert((SELECT status FROM orders WHERE id=:'ordA')='completed',
  'A2 la orden se completó AUTOMÁTICAMENTE al facturar (dentro de la transacción)');
SELECT pg_temp.assert((SELECT completed_at IS NOT NULL FROM orders WHERE id=:'ordA'), 'A3 completed_at establecido');
SELECT pg_temp.assert((SELECT count(*) FROM status_history WHERE order_id=:'ordA' AND status='completed')=1,
  'A4 la transición quedó auditada en status_history');
SELECT pg_temp.assert((pg_temp.st(:'ordA')).payment_status='partial', 'A5 estado financiero = partial');
SELECT pg_temp.assert((pg_temp.st(:'ordA')).total_comprobado=50000.00, 'A6 total comprobado 50.000');
SELECT pg_temp.assert((pg_temp.st(:'ordA')).total_cobrado=20000.00,    'A7 total cobrado 20.000');
SELECT pg_temp.assert((pg_temp.st(:'ordA')).saldo_pendiente=30000.00,  'A8 saldo pendiente 30.000');
SELECT pg_temp.assert((SELECT paid_at IS NULL FROM orders WHERE id=:'ordA'), 'A9 paid_at NULL mientras hay saldo');
SELECT pg_temp.assert((pg_temp.st(:'ordA')).saldo_en_cc=30000.00,
  'A9b la parte a cuenta corriente se expone por separado: es deuda, no cobro');
-- Regresión P0-A dentro del mismo flujo (§14.24)
SELECT pg_temp.assert((SELECT ROUND(SUM(cogs),2) FROM v_finance_pnl WHERE business_id=:'biz' AND period_date=public.ar_today())=12200.00,
  'A10 COGS 12.200 (regresión P0-A)');
SELECT pg_temp.assert((SELECT ROUND(SUM(operating_result),2) FROM v_finance_pnl WHERE business_id=:'biz' AND period_date=public.ar_today())=37800.00,
  'A11 operating_result 37.800 (regresión P0-A)');
SELECT pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id=:'inv')=9, 'A12 stock descontado UNA sola vez');

-- ============ B. Pago posterior que completa el saldo (§7.E, §14.5) =========
DO $$
DECLARE v_prev timestamptz;
BEGIN
  SELECT completed_at INTO v_prev FROM orders WHERE id='00000000-0000-0000-0000-0000000d0af1';
  PERFORM set_config('t.completed_prev', v_prev::text, true);
  INSERT INTO comprobante_payments (comprobante_id, business_id, amount, currency, amount_ars,
    exchange_rate, payment_method, net_amount, date, created_by)
  VALUES (current_setting('t.compA')::uuid,'00000000-0000-0000-0000-0000000d0a01',30000,'ARS',30000,1,
    'efectivo',30000, public.ar_today(),'00000000-0000-0000-0000-0000000d0a09');
END $$;
SELECT pg_temp.assert((pg_temp.st(:'ordA')).payment_status='paid', 'B1 pago posterior -> paid');
SELECT pg_temp.assert((pg_temp.st(:'ordA')).saldo_pendiente=0.00,  'B2 saldo 0');
SELECT pg_temp.assert((SELECT paid_at IS NOT NULL FROM orders WHERE id=:'ordA'), 'B3 paid_at establecido');
SELECT pg_temp.assert((SELECT status FROM orders WHERE id=:'ordA')='completed',
  'B4 el estado TÉCNICO no cambió por cobrar (ejes separados)');
SELECT pg_temp.assert((SELECT completed_at FROM orders WHERE id=:'ordA')=current_setting('t.completed_prev')::timestamptz,
  'B5 completed_at NO se movió con el segundo pago (se establece una sola vez)');
SELECT pg_temp.assert((SELECT ROUND(SUM(cogs),2) FROM v_finance_pnl WHERE business_id=:'biz' AND period_date=public.ar_today())=12200.00,
  'B6 el COGS no se duplicó al cobrar');

-- ============ C. Reversa que vuelve a generar saldo (§8, §19 tercer tramo) ==
-- Se usa la RPC canónica de reemplazo (marcar replaced_at a mano viola el CHECK
-- comprobante_payments_replacement_consistency). Reemplaza los pagos vigentes
-- por uno solo de 20.000: el comprobante vuelve a tener 30.000 de saldo.
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000d0a09';
  r := replace_comprobante_payment(
        current_setting('t.compA')::uuid,'00000000-0000-0000-0000-0000000d0a01'::uuid,
        'efectivo', 20000, 20000, 'ARS', 1, 'reversa de prueba',
        '00000000-0000-0000-0000-0000000d0a09'::uuid, 0, NULL, 'REP-A1');
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean IS NOT FALSE, 'C0 reemplazo de pago ok ('||COALESCE(r->>'error','')||')');
END $$;
SELECT pg_temp.assert((pg_temp.st(:'ordA')).payment_status='partial', 'C1 reemplazo -> partial (paid → partial)');
SELECT pg_temp.assert((pg_temp.st(:'ordA')).saldo_pendiente=30000.00, 'C2 saldo reabierto 30.000');
SELECT pg_temp.assert((SELECT paid_at IS NULL FROM orders WHERE id=:'ordA'), 'C3 paid_at se limpió al reabrirse el saldo');
SELECT pg_temp.assert((SELECT status FROM orders WHERE id=:'ordA')='completed', 'C4 estado técnico intacto');

-- ============ D. Cuenta corriente sin pago (§7.C, §14.3) ====================
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000d0a09';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000d0a01'::uuid,'B1','h2',
        pg_temp.payload('00000000-0000-0000-0000-0000000d0af2'::uuid, '[]'::jsonb, 50000));
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status'='created', 'D1 checkout CC created ('||COALESCE(r->>'error','')||')');
END $$;
SELECT pg_temp.assert((SELECT status FROM orders WHERE id=:'ordB')='completed', 'D2 orden CC completada');
SELECT pg_temp.assert((pg_temp.st(:'ordB')).payment_status='pending',
  'D3 venta 100 % a cuenta corriente -> PENDING (la CC crea deuda, no cobro)');
SELECT pg_temp.assert((pg_temp.st(:'ordB')).total_cobrado=0.00,   'D4 total cobrado 0');
SELECT pg_temp.assert((pg_temp.st(:'ordB')).saldo_pendiente=50000.00, 'D5 saldo 50.000');
SELECT pg_temp.assert((pg_temp.st(:'ordB')).deuda_en_cc IS TRUE,
  'D6 la deuda en cuenta corriente se expone por separado (saldo_en_cc)');

-- ============ E. Orden cancelada: el checkout se rechaza (§5, §14.8) ========
DO $$
DECLARE r jsonb; v_err text;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000d0a09';
  BEGIN
    r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000d0a01'::uuid,'C1','h3',
          pg_temp.payload('00000000-0000-0000-0000-0000000d0af3'::uuid, jsonb_build_array(pg_temp.pago(50000))));
    v_err := COALESCE(r->>'error','');
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  RESET ROLE;
  PERFORM pg_temp.assert(v_err <> '', 'E1 facturar una orden cancelada es rechazado');
  PERFORM pg_temp.assert((SELECT status FROM orders WHERE id='00000000-0000-0000-0000-0000000d0af3')='cancelled',
    'E2 la orden cancelada sigue cancelada');
END $$;

-- ============ F. Replay idempotente (§14.9, §14.20) =========================
DO $$
DECLARE r jsonb; v_before timestamptz; v_after timestamptz; v_n int;
BEGIN
  SELECT completed_at INTO v_before FROM orders WHERE id='00000000-0000-0000-0000-0000000d0af1';
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000d0a09';
  -- MISMO payload y MISMA key que el checkout original: es un replay, no una venta nueva.
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000d0a01'::uuid,'A1','h1',
        pg_temp.payload('00000000-0000-0000-0000-0000000d0af1'::uuid,
                        jsonb_build_array(pg_temp.pago(20000)), 30000));
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status'='existing', 'F1 replay -> existing (fue '||COALESCE(r->>'status','?')||')');
  SELECT completed_at INTO v_after FROM orders WHERE id='00000000-0000-0000-0000-0000000d0af1';
  PERFORM pg_temp.assert(v_before = v_after, 'F2 el replay NO movió completed_at');
  SELECT count(*) INTO v_n FROM status_history WHERE order_id='00000000-0000-0000-0000-0000000d0af1' AND status='completed';
  PERFORM pg_temp.assert(v_n = 1, 'F3 el replay NO duplicó la transición auditada');
END $$;

-- ============ G. Anulación del comprobante (§8, §14.7) ======================
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000d0a09';
  r := annul_comprobante_atomic(current_setting('t.compA')::uuid,'void_same_session','test',false,'ANN-A1');
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'G1 anulación ok ('||COALESCE(r->>'error','')||')');
END $$;
SELECT pg_temp.assert((pg_temp.st(:'ordA')).payment_status='sin_facturar',
  'G2 anulado el único comprobante, la orden queda SIN FACTURAR (no "cobrada")');
SELECT pg_temp.assert((pg_temp.st(:'ordA')).comprobantes_vigentes=0, 'G3 sin comprobantes vigentes');
SELECT pg_temp.assert((SELECT status FROM orders WHERE id=:'ordA')='completed',
  'G4 el estado técnico permanece completed (el trabajo se hizo)');
SELECT pg_temp.assert((SELECT completed_at IS NOT NULL FROM orders WHERE id=:'ordA'),
  'G5 completed_at sobrevive a la anulación');
SELECT pg_temp.assert((SELECT paid_at IS NULL FROM orders WHERE id=:'ordA'), 'G6 paid_at limpio');

-- ============ H. Aislamiento multi-negocio (§14.14) =========================
DO $$
DECLARE v_n int;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000d0b09';  -- owner B
  SELECT count(*) INTO v_n FROM v_order_financial_status WHERE business_id='00000000-0000-0000-0000-0000000d0a01';
  RESET ROLE;
  PERFORM pg_temp.assert(v_n = 0, 'H1 la vista no expone órdenes de otro negocio (security_invoker + RLS)');
END $$;

-- El frontend NO puede recomputar el estado: la función no está otorgada.
DO $$
DECLARE v_ok boolean;
BEGIN
  SELECT has_function_privilege('authenticated','public.recompute_order_payment_status(uuid)','EXECUTE') INTO v_ok;
  PERFORM pg_temp.assert(v_ok = false, 'H2 authenticated NO puede ejecutar recompute_order_payment_status');
END $$;

-- ============ I. Orden sin facturar (§14, estado base) ======================
SELECT pg_temp.assert((pg_temp.st(:'ordD')).payment_status='sin_facturar', 'I1 orden sin comprobante -> sin_facturar');
SELECT pg_temp.assert((pg_temp.st(:'ordD')).saldo_pendiente=0.00, 'I2 sin comprobante no hay saldo');
SELECT pg_temp.assert((SELECT status FROM orders WHERE id=:'ordD')='repair', 'I3 su estado técnico no se tocó');

ROLLBACK;
