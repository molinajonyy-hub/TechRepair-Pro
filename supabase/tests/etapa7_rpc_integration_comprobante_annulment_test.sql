-- ============================================================================
-- M7 Lote 6F.4 -- annul_comprobante_atomic + fuente contable append-only.
--   Historia contable (v_finance_sales_ledger) vs estado actual
--   (v_finance_effective_comprobantes) · periodo original INTACTO · compensacion
--   en el periodo de la anulacion · acumulado 0 · pagos VIVOS unicamente ·
--   guard de periodo · idempotencia durable · locks · audit scope E1 + evento
--   unico · rollback · guard anti anulacion client-side.
-- Concurrencia real (misma key / keys distintas / annul vs replace): harness aparte.
-- RUN: docker cp ... && psql -X -f (BEGIN + ROLLBACK)
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;
-- P&L de un periodo (0 si no hay fila)
CREATE OR REPLACE FUNCTION pg_temp.pnl(b uuid, d date, col text) RETURNS numeric LANGUAGE plpgsql AS $$
DECLARE v numeric;
BEGIN
  EXECUTE format('SELECT COALESCE((SELECT %I FROM v_finance_pnl WHERE business_id=$1 AND period_date=$2),0)', col)
    INTO v USING b, d; RETURN v;
END; $$;
CREATE OR REPLACE FUNCTION pg_temp.ar(ts timestamptz) RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT (ts AT TIME ZONE 'America/Argentina/Cordoba')::date $$;
-- condicion canonica de anulado (6F.4a) — misma que usan RPC, guard y preflight
CREATE OR REPLACE FUNCTION pg_temp.is_ann(c uuid) RETURNS boolean LANGUAGE sql AS $$
  SELECT public.is_comprobante_annulled(c) $$;

\set biz  '00000000-0000-0000-0000-000000647101'
\set OA   '00000000-0000-0000-0000-000000647109'
\set biz2 '00000000-0000-0000-0000-000000647201'
\set OB   '00000000-0000-0000-0000-000000647209'
-- Negocio C: AISLADO, su UNICA venta es la de junio -> permite afirmar P&L por
-- periodo y ACUMULADO sin ruido de los demas casos (que caen todos en "hoy").
\set bizC '00000000-0000-0000-0000-000000647301'
\set PC   '00000000-0000-0000-0000-000000647d03'
\set CAJC '00000000-0000-0000-0000-000000647603'
\set P1   '00000000-0000-0000-0000-000000647d01'
\set P2   '00000000-0000-0000-0000-000000647d02'
\set CAJA '00000000-0000-0000-0000-000000647601'
\set CLI  '00000000-0000-0000-0000-000000647c01'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'OA'),(:'OB');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','6F4 A',:'OA'),(:'biz2','6F4 B',:'OB'),(:'bizC','6F4 C',:'OA');
-- profiles: un usuario tiene UNA sola fila (profiles_user_id_unique_idx). OA
-- accede a bizC por businesses.owner_user_id, que es la otra rama del ownership.
-- id = auth.uid() a proposito: current_business_id() (usada por la policy de
-- UPDATE de comprobantes) resuelve por profiles.id, no por user_id. Sin esto la
-- RLS descarta el UPDATE en silencio y el guard de anulacion nunca se ejercita.
INSERT INTO profiles(id,business_id,user_id,role,is_active) VALUES (:'OA',:'biz',:'OA','owner',true),(:'OB',:'biz2',:'OB','owner',true);
INSERT INTO inventory(id,business_id,name,code,category,stock_quantity,stock,cost_price,sale_price,base_price,base_currency,auto_update_price,exchange_rate_used,is_active)
  VALUES (:'P1',:'biz','P1','F4-1','Rep',100,100,600,1000,1000,'ARS',false,1,true),
         (:'P2',:'biz','P2','F4-2','Rep',100,100,300,500,500,'ARS',false,1,true),
         (:'PC',:'bizC','PC','F4-3','Rep',100,100,600,1000,1000,'ARS',false,1,true);
INSERT INTO cajas(id,business_id,opened_by,status) VALUES (:'CAJA',:'biz',:'OA','abierta'),(:'CAJC',:'bizC',:'OA','abierta');
INSERT INTO customers(id,business_id,name,phone) VALUES (:'CLI',:'biz','Cliente CC','555');
SET LOCAL session_replication_role='origin';

-- ============ Esquema =======================================================
SELECT pg_temp.assert(EXISTS(SELECT 1 FROM pg_views WHERE viewname='v_finance_sales_ledger'), 'SC1 v_finance_sales_ledger existe');
SELECT pg_temp.assert(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='comprobante_annulments' AND column_name='annulment_date'), 'SC2 comprobante_annulments.annulment_date existe');
SELECT pg_temp.assert(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='comprobante_annulments' AND column_name='op'), 'SC3 comprobante_annulments.op existe');
-- el P&L y el margen ya NO dependen de la vista de estado actual para ventas/COGS
SELECT pg_temp.assert(pg_get_viewdef('public.v_finance_pnl'::regclass,true) ~ 'v_finance_sales_ledger', 'SC4 v_finance_pnl lee el ledger append-only');
SELECT pg_temp.assert(pg_get_viewdef('public.v_finance_product_margin'::regclass,true) ~ 'v_finance_sales_ledger', 'SC5 v_finance_product_margin lee el ledger');
-- la vista de estado actual conserva el filtro operativo
SELECT pg_temp.assert(pg_get_viewdef('public.v_finance_effective_comprobantes'::regclass,true) ~ 'anulado', 'SC6 v_finance_effective_comprobantes conserva el filtro de anulados (estado actual)');
SELECT pg_temp.assert(pg_get_viewdef('public.v_finance_receivables_aging'::regclass,true) ~ 'v_finance_effective_comprobantes', 'SC7 aging sigue en estado actual (no migrado)');
-- el ledger NO usa now()/ar_today() para fechar filas historicas
SELECT pg_temp.assert(pg_get_viewdef('public.v_finance_sales_ledger'::regclass,true) !~ 'ar_today|now\(\)', 'SC8 el ledger no usa fechas volatiles');

-- ============ Helper de venta ==============================================
CREATE OR REPLACE FUNCTION pg_temp.venta(p_key text, p_items jsonb, p_pagos jsonb, p_cc numeric DEFAULT 0, p_cli uuid DEFAULT NULL,
                                         p_biz uuid DEFAULT '00000000-0000-0000-0000-000000647101')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r jsonb; v_id uuid;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  r := create_comprobante_checkout_atomic(p_biz, p_key, 'h',
       jsonb_build_object('tipo','factura_c','cc_total',p_cc,'customer_id',p_cli,'items',p_items,'pagos',p_pagos));
  RESET ROLE;
  IF r->>'status' NOT IN ('created') THEN RAISE EXCEPTION 'venta % fallo: %', p_key, r::text; END IF;
  v_id := (r->>'comprobante_id')::uuid;
  RETURN v_id;
END; $$;
CREATE OR REPLACE FUNCTION pg_temp.item(inv uuid, cant numeric, precio numeric, costo numeric, tipo text DEFAULT 'producto')
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('inventory_id',inv,'descripcion','x','tipo_linea',tipo,'cantidad',cant,'precio_unitario',precio,'costo_unitario',costo) $$;
CREATE OR REPLACE FUNCTION pg_temp.pago(m text, a numeric) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('amount',a,'amount_ars',a,'payment_method',m) $$;

CREATE TEMP TABLE pg_temp_c(kind text, id uuid);

-- ============ SEGURIDAD ====================================================
DO $$
DECLARE r jsonb; v_id uuid;
BEGIN
  v_id := pg_temp.venta('SEC1', jsonb_build_array(pg_temp.item('00000000-0000-0000-0000-000000647d01',1,1000,600)),
                        jsonb_build_array(pg_temp.pago('efectivo',1000)));
  INSERT INTO pg_temp_c VALUES ('sec', v_id);
  -- sin auth
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','',true);
  r := annul_comprobante_atomic(v_id,'refund_current_session','x',true,'K');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'error_code'='UNAUTHORIZED' AND r->>'error'='No autenticado', 'SE1 sin auth -> UNAUTHORIZED');
  -- cross-tenant: owner del negocio B anulando un comprobante de A
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647209',true);
  r := annul_comprobante_atomic(v_id,'refund_current_session','x',true,'K2');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'error_code'='FORBIDDEN' AND r->>'error'='Sin acceso a este negocio', 'SE2 cross-tenant -> FORBIDDEN');
  -- comprobante inexistente
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  r := annul_comprobante_atomic(gen_random_uuid(),'refund_current_session','x',true,'K3');
  PERFORM pg_temp.assert(r->>'error_code'='COMPROBANTE_NOT_FOUND', 'SE3 comprobante inexistente -> COMPROBANTE_NOT_FOUND');
  -- validaciones
  r := annul_comprobante_atomic(v_id,'modo_raro','x',true,'K4');
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR' AND r->>'error' LIKE 'Modo de anulación inválido%', 'SE4 modo invalido -> VALIDATION_ERROR');
  r := annul_comprobante_atomic(v_id,'refund_current_session','   ',true,'K5');
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR' AND r->>'error'='El motivo de la anulación es obligatorio', 'SE5 motivo vacio -> VALIDATION_ERROR (contrato exacto)');
  r := annul_comprobante_atomic(v_id,'refund_current_session','x',true,'  ');
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR' AND r->>'error'='idempotency_key requerida', 'SE6 key vacia -> VALIDATION_ERROR');
  r := annul_comprobante_atomic(v_id,'refund_current_session','x',true, repeat('k',201));
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'SE7 key > 200 -> VALIDATION_ERROR');
  RESET ROLE;
END $$;
-- actor falsificado: p_user_id no existe en la firma; el actor es auth.uid()
SELECT pg_temp.assert((SELECT count(*) FROM pg_proc WHERE proname='annul_comprobante_atomic')=1, 'SE8 sin overloads (una sola firma)');
SELECT pg_temp.assert(NOT has_function_privilege('anon','public.annul_comprobante_atomic(uuid,text,text,boolean,text)','EXECUTE'), 'SE9 anon NO EXECUTE');
SELECT pg_temp.assert(has_function_privilege('authenticated','public.annul_comprobante_atomic(uuid,text,text,boolean,text)','EXECUTE'), 'SE10 authenticated EXECUTE (rol preservado)');

-- ============ CASO CANONICO: venta junio, anulacion julio ==================
-- En bizC (aislado): su UNICA venta es esta, asi el P&L por periodo y el
-- acumulado se pueden afirmar en absoluto, sin ruido.
CREATE OR REPLACE FUNCTION public.ar_today() RETURNS date LANGUAGE sql STABLE AS $f$ SELECT '2026-06-10'::date $f$;
DO $$
DECLARE v_id uuid;
BEGIN
  v_id := pg_temp.venta('JUN', jsonb_build_array(pg_temp.item('00000000-0000-0000-0000-000000647d03',1,1000,600)),
                        jsonb_build_array(pg_temp.pago('efectivo',1000)), 0, NULL,
                        '00000000-0000-0000-0000-000000647301');
  INSERT INTO pg_temp_c VALUES ('jun', v_id);
  UPDATE comprobantes SET fecha='2026-06-10 12:00-03', date='2026-06-10 12:00-03' WHERE id=v_id;
END $$;

-- baseline del periodo original
CREATE TEMP TABLE pg_temp_base AS
  SELECT pg_temp.pnl(:'bizC','2026-06-10','gross_sales') AS ventas,
         pg_temp.pnl(:'bizC','2026-06-10','cogs') AS cogs,
         pg_temp.pnl(:'bizC','2026-06-10','gross_profit') AS gp;
SELECT pg_temp.assert((SELECT ventas FROM pg_temp_base)=1000 AND (SELECT cogs FROM pg_temp_base)=600 AND (SELECT gp FROM pg_temp_base)=400,
  'PN0 junio antes: ventas=1000 cogs=600 gp=400');

-- anulacion HOY (julio)
CREATE OR REPLACE FUNCTION public.ar_today() RETURNS date LANGUAGE sql STABLE AS $f$ SELECT '2026-07-16'::date $f$;
DO $$
DECLARE r jsonb; v_id uuid;
BEGIN
  SELECT id INTO v_id FROM pg_temp_c WHERE kind='jun';
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  r := annul_comprobante_atomic(v_id,'refund_current_session','venta de prueba',true,'AJUN');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'ok'='true' AND r->>'replay'='false', 'AN1 anulacion OK');
  PERFORM pg_temp.assert((r->>'reverted_cash_ars')::numeric=1000, 'AN2 reverted_cash_ars=1000');
  PERFORM pg_temp.assert((r->>'reverted_cogs_ars')::numeric=600, 'AN3 reverted_cogs_ars=600');
  PERFORM pg_temp.assert((r->>'stock_restored_count')::int=1, 'AN4 stock_restored_count=1');
END $$;

-- §12 periodo original INTACTO
SELECT pg_temp.assert(pg_temp.pnl(:'bizC','2026-06-10','gross_sales')=(SELECT ventas FROM pg_temp_base), 'PN1 junio DESPUES: ventas identicas');
SELECT pg_temp.assert(pg_temp.pnl(:'bizC','2026-06-10','cogs')=(SELECT cogs FROM pg_temp_base), 'PN2 junio DESPUES: COGS identico');
SELECT pg_temp.assert(pg_temp.pnl(:'bizC','2026-06-10','gross_profit')=(SELECT gp FROM pg_temp_base), 'PN3 junio DESPUES: resultado identico');
SELECT pg_temp.assert(EXISTS(SELECT 1 FROM v_finance_pnl WHERE business_id=:'bizC' AND period_date='2026-06-10'), 'PN4 la fila de junio NO desaparece');
-- §12 periodo compensatorio
SELECT pg_temp.assert(pg_temp.pnl(:'bizC','2026-07-16','gross_sales')=-1000, 'PN5 julio: ventas -1000');
SELECT pg_temp.assert(pg_temp.pnl(:'bizC','2026-07-16','cogs')=-600, 'PN6 julio: COGS -600');
SELECT pg_temp.assert(pg_temp.pnl(:'bizC','2026-07-16','gross_profit')=-400, 'PN7 julio: resultado -400');
-- §12 acumulado (bizC solo tiene esta venta)
SELECT pg_temp.assert((SELECT COALESCE(SUM(gross_sales),0) FROM v_finance_pnl WHERE business_id=:'bizC')=0, 'PN8 ventas acumuladas = 0');
SELECT pg_temp.assert((SELECT COALESCE(SUM(cogs),0) FROM v_finance_pnl WHERE business_id=:'bizC')=0, 'PN9 COGS acumulado = 0');
SELECT pg_temp.assert((SELECT COALESCE(SUM(operating_result),0) FROM v_finance_pnl WHERE business_id=:'bizC')=0, 'PN10 resultado acumulado = 0');
-- el margen por producto tambien netea 0 y no depende del estado actual
SELECT pg_temp.assert((SELECT COALESCE(net_sales,0) FROM v_finance_product_margin WHERE inventory_id=:'PC')=0, 'PN11 product_margin: ventas netean 0');
SELECT pg_temp.assert((SELECT COALESCE(cogs,0) FROM v_finance_product_margin WHERE inventory_id=:'PC')=0, 'PN12 product_margin: COGS netea 0');
SELECT pg_temp.assert((SELECT COALESCE(units,0) FROM v_finance_product_margin WHERE inventory_id=:'PC')=0, 'PN13 product_margin: unidades netean 0');
-- ledger: dos eventos, fechas distintas, espejo exacto
SELECT pg_temp.assert((SELECT count(*) FROM v_finance_sales_ledger WHERE comprobante_id=(SELECT id FROM pg_temp_c WHERE kind='jun'))=2, 'LG1 dos eventos (sale + annulment)');
SELECT pg_temp.assert((SELECT period_date FROM v_finance_sales_ledger WHERE comprobante_id=(SELECT id FROM pg_temp_c WHERE kind='jun') AND event_type='sale')='2026-06-10', 'LG2 evento sale en la fecha ORIGINAL');
SELECT pg_temp.assert((SELECT period_date FROM v_finance_sales_ledger WHERE comprobante_id=(SELECT id FROM pg_temp_c WHERE kind='jun') AND event_type='annulment')='2026-07-16', 'LG3 evento annulment en la fecha de ANULACION');
SELECT pg_temp.assert((SELECT SUM(sales_amount_ars) FROM v_finance_sales_ledger WHERE comprobante_id=(SELECT id FROM pg_temp_c WHERE kind='jun'))=0, 'LG4 ventas del comprobante netean 0');
SELECT pg_temp.assert((SELECT SUM(cogs_amount_ars) FROM v_finance_sales_ledger WHERE comprobante_id=(SELECT id FROM pg_temp_c WHERE kind='jun'))=0, 'LG5 COGS del comprobante netea 0');
SELECT pg_temp.assert((SELECT annulment_id FROM v_finance_sales_ledger WHERE comprobante_id=(SELECT id FROM pg_temp_c WHERE kind='jun') AND event_type='annulment') IS NOT NULL, 'LG6 el evento de anulacion referencia su annulment_id');
-- fecha economica persistida
SELECT pg_temp.assert((SELECT annulment_date FROM comprobante_annulments WHERE comprobante_id=(SELECT id FROM pg_temp_c WHERE kind='jun'))='2026-07-16', 'LG7 annulment_date persistida = ar_today() de la anulacion');
-- §12 current state
SELECT pg_temp.assert(NOT EXISTS(SELECT 1 FROM v_finance_effective_comprobantes WHERE id=(SELECT id FROM pg_temp_c WHERE kind='jun')), 'CS1 anulado FUERA del estado actual');
SELECT pg_temp.assert((SELECT COALESCE(SUM(amount),0) FROM v_finance_receivables_aging WHERE business_id=:'bizC')=0, 'CS2 no aparece como deuda vigente en aging');
-- conserva documento
SELECT pg_temp.assert((SELECT count(*) FROM comprobante_items WHERE comprobante_id=(SELECT id FROM pg_temp_c WHERE kind='jun'))=1, 'CS3 conserva items');
SELECT pg_temp.assert((SELECT count(*) FROM comprobante_payments WHERE comprobante_id=(SELECT id FROM pg_temp_c WHERE kind='jun'))=1, 'CS4 conserva pagos (no se borran)');
SELECT pg_temp.assert((SELECT pg_temp.ar(fecha) FROM comprobantes WHERE id=(SELECT id FROM pg_temp_c WHERE kind='jun'))='2026-06-10', 'CS5 conserva la fecha original');
SELECT pg_temp.assert((SELECT estado FROM comprobantes WHERE id=(SELECT id FROM pg_temp_c WHERE kind='jun'))='anulado', 'CS6 identificable como anulado');
-- cashflow: original intacto, compensacion hoy
SELECT pg_temp.assert((SELECT COALESCE(SUM(net_ars),0) FROM v_finance_cashflow WHERE business_id=:'bizC' AND movement_date_ar='2026-06-09')=1000, 'CF1 cashflow del periodo original intacto');
SELECT pg_temp.assert((SELECT COALESCE(SUM(net_ars),0) FROM v_finance_cashflow WHERE business_id=:'bizC' AND movement_date_ar='2026-07-15')=-1000, 'CF2 devolucion en el periodo de la anulacion');
SELECT pg_temp.assert((SELECT COALESCE(SUM(net_ars),0) FROM v_finance_cashflow WHERE business_id=:'bizC')=0, 'CF3 cobros acumulados + anulaciones = 0');
-- inventario restaurado exactamente, costo intacto
SELECT pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id=:'PC')=100, 'IN1 stock restaurado exactamente');
SELECT pg_temp.assert((SELECT cost_price FROM inventory WHERE id=:'PC')=600, 'IN2 costo actual intacto');
SELECT pg_temp.assert((SELECT count(*) FROM inventory_movements WHERE reference_id=(SELECT id FROM pg_temp_c WHERE kind='jun') AND movement_type='return')=1, 'IN3 un movimiento de entrada (append-only)');
SELECT pg_temp.assert((SELECT count(*) FROM inventory_movements WHERE reference_id=(SELECT id FROM pg_temp_c WHERE kind='jun'))>=2, 'IN4 el movimiento de salida original se conserva');

-- ============ IDEMPOTENCIA DURABLE =========================================
DO $$
DECLARE r jsonb; v_id uuid; v_prev int;
BEGIN
  SELECT id INTO v_id FROM pg_temp_c WHERE kind='jun';
  SELECT count(*) INTO v_prev FROM financial_movements WHERE comprobante_id=v_id;
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  -- misma key / misma intencion -> replay
  r := annul_comprobante_atomic(v_id,'refund_current_session','venta de prueba',true,'AJUN');
  PERFORM pg_temp.assert(r->>'ok'='true' AND r->>'replay'='true', 'ID1 misma key/misma intencion -> replay');
  -- misma key / motivo distinto -> conflicto
  r := annul_comprobante_atomic(v_id,'refund_current_session','OTRO motivo',true,'AJUN');
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT', 'ID2 misma key/motivo distinto -> IDEMPOTENCY_CONFLICT');
  r := annul_comprobante_atomic(v_id,'commercial_annulment','venta de prueba',true,'AJUN');
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT', 'ID3 misma key/modo distinto -> IDEMPOTENCY_CONFLICT');
  RESET ROLE;
  PERFORM pg_temp.assert((SELECT count(*) FROM financial_movements WHERE comprobante_id=v_id)=v_prev, 'ID4 el replay no crea compensaciones nuevas');
  PERFORM pg_temp.assert((SELECT count(*) FROM comprobante_annulments WHERE comprobante_id=v_id)=1, 'ID5 una sola anulacion registrada');
END $$;
-- replay al DIA SIGUIENTE (idempotencia durable: la fecha no esta en el hash)
CREATE OR REPLACE FUNCTION public.ar_today() RETURNS date LANGUAGE sql STABLE AS $f$ SELECT '2026-07-17'::date $f$;
DO $$
DECLARE r jsonb; v_id uuid;
BEGIN
  SELECT id INTO v_id FROM pg_temp_c WHERE kind='jun';
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  r := annul_comprobante_atomic(v_id,'refund_current_session','venta de prueba',true,'AJUN');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'ok'='true' AND r->>'replay'='true', 'ID6 replay al DIA SIGUIENTE sigue siendo replay');
END $$;
-- replay con el periodo de la anulacion YA CERRADO
INSERT INTO finance_period_locks(business_id, period_start, period_end, status, closed_by, close_reason)
  VALUES (:'bizC','2026-07-01','2026-07-31','closed',:'OA','cierre de prueba');
DO $$
DECLARE r jsonb; v_id uuid;
BEGIN
  SELECT id INTO v_id FROM pg_temp_c WHERE kind='jun';
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  r := annul_comprobante_atomic(v_id,'refund_current_session','venta de prueba',true,'AJUN');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'ok'='true' AND r->>'replay'='true', 'ID7 replay tras cerrar el periodo de la anulacion -> exito (retorna antes del guard)');
END $$;
DELETE FROM finance_period_locks WHERE business_id=:'bizC' AND period_start='2026-07-01';

-- ============ GUARD DE PERIODO =============================================
-- anulacion NUEVA con el periodo actual cerrado -> PERIOD_CLOSED
-- (la venta se registra ANTES del cierre; lo que se prueba es la ANULACION)
DO $$
DECLARE v_id uuid;
BEGIN
  v_id := pg_temp.venta('PC1', jsonb_build_array(pg_temp.item('00000000-0000-0000-0000-000000647d01',1,1000,600)),
                        jsonb_build_array(pg_temp.pago('efectivo',1000)));
  INSERT INTO pg_temp_c VALUES ('pc1', v_id);
END $$;
INSERT INTO finance_period_locks(business_id, period_start, period_end, status, closed_by, close_reason)
  VALUES (:'biz','2026-07-01','2026-07-31','closed',:'OA','julio cerrado');
DO $$
DECLARE r jsonb; v_id uuid; v_stock int;
BEGIN
  SELECT id INTO v_id FROM pg_temp_c WHERE kind='pc1';
  SELECT stock_quantity INTO v_stock FROM inventory WHERE id='00000000-0000-0000-0000-000000647d01';
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  r := annul_comprobante_atomic(v_id,'refund_current_session','x',true,'APC1');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'error_code'='PERIOD_CLOSED', 'PG1 anulacion nueva en periodo cerrado -> PERIOD_CLOSED');
  PERFORM pg_temp.assert((SELECT estado FROM comprobantes WHERE id=v_id) IS DISTINCT FROM 'anulado', 'PG2 el comprobante NO quedo anulado');
  PERFORM pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id='00000000-0000-0000-0000-000000647d01')=v_stock, 'PG3 stock intacto');
  PERFORM pg_temp.assert((SELECT count(*) FROM comprobante_annulments WHERE comprobante_id=v_id)=0, 'PG4 sin request huerfana');
END $$;
DELETE FROM finance_period_locks WHERE business_id=:'biz' AND period_start='2026-07-01';
-- el periodo ORIGINAL cerrado NO bloquea la anulacion de hoy
INSERT INTO finance_period_locks(business_id, period_start, period_end, status, closed_by, close_reason)
  VALUES (:'biz','2026-06-01','2026-06-30','closed',:'OA','junio cerrado');
DO $$
DECLARE r jsonb; v_id uuid;
BEGIN
  v_id := pg_temp.venta('PC2', jsonb_build_array(pg_temp.item('00000000-0000-0000-0000-000000647d01',1,1000,600)),
                        jsonb_build_array(pg_temp.pago('efectivo',1000)));
  UPDATE comprobantes SET fecha='2026-06-15 12:00-03', date='2026-06-15 12:00-03' WHERE id=v_id;
  INSERT INTO pg_temp_c VALUES ('jun_cerrado', v_id);
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  r := annul_comprobante_atomic(v_id,'refund_current_session','x',true,'APC2');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'ok'='true', 'PG5 original en periodo CERRADO + anulacion hoy -> permitido');
END $$;
SELECT pg_temp.assert(pg_temp.pnl(:'biz','2026-06-15','gross_sales')=1000, 'PG6 el periodo original cerrado conserva su venta');
SELECT pg_temp.assert(pg_temp.pnl(:'biz','2026-06-15','cogs')=600, 'PG7 el periodo original cerrado conserva su COGS');
DELETE FROM finance_period_locks WHERE business_id=:'biz' AND period_start='2026-06-01';

-- ============ PAGOS: solo los VIVOS se compensan ===========================
DO $$
DECLARE r jsonb; v_id uuid;
BEGIN
  -- venta cobrada en efectivo, luego el cobro se REEMPLAZA por transferencia
  v_id := pg_temp.venta('RP1', jsonb_build_array(pg_temp.item('00000000-0000-0000-0000-000000647d01',1,1000,600)),
                        jsonb_build_array(pg_temp.pago('efectivo',1000)));
  INSERT INTO pg_temp_c VALUES ('repl', v_id);
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  r := replace_comprobante_payment(v_id,'00000000-0000-0000-0000-000000647101'::uuid,'transferencia',1000,1000,'ARS',1,'x',
       '00000000-0000-0000-0000-000000647109'::uuid,0,NULL,'RPK1');
  PERFORM pg_temp.assert(r->>'ok'='true', 'PA0 reemplazo de cobro OK');
  r := annul_comprobante_atomic(v_id,'refund_current_session','x',true,'ARP1');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'ok'='true', 'PA1 anulacion tras reemplazo OK');
  -- SOLO el pago vivo (transferencia) se compensa; el efectivo reemplazado ya lo fue por 6F.3
  PERFORM pg_temp.assert((r->>'reverted_cash_ars')::numeric=1000, 'PA2 reverted_cash_ars=1000 (no 2000: no se compensa el pago reemplazado)');
  PERFORM pg_temp.assert((SELECT count(*) FROM financial_movements WHERE comprobante_id=v_id AND reference_type='annulment_reversal')=1,
    'PA3 exactamente UNA devolucion (solo el pago vivo)');
  PERFORM pg_temp.assert((SELECT metodo_pago FROM financial_movements WHERE comprobante_id=v_id AND reference_type='annulment_reversal')='transferencia',
    'PA4 la devolucion usa el metodo VIVO (transferencia)');
END $$;
SELECT pg_temp.assert((SELECT COALESCE(SUM(net_ars),0) FROM v_finance_cashflow WHERE business_id=:'biz' AND source_id IN (SELECT id FROM financial_movements WHERE comprobante_id=(SELECT id FROM pg_temp_c WHERE kind='repl')))=0,
  'PA5 cashflow acumulado del comprobante reemplazado+anulado = 0');
-- pago mixto: una devolucion por cada pago vivo
DO $$
DECLARE r jsonb; v_id uuid;
BEGIN
  v_id := pg_temp.venta('MX1', jsonb_build_array(pg_temp.item('00000000-0000-0000-0000-000000647d01',1,1000,600)),
                        jsonb_build_array(pg_temp.pago('efectivo',400), pg_temp.pago('tarjeta_debito',600)));
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  r := annul_comprobante_atomic(v_id,'refund_current_session','x',true,'AMX1');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'ok'='true' AND (r->>'reverted_cash_ars')::numeric=1000, 'PA6 pago mixto: reverted_cash_ars=1000');
  PERFORM pg_temp.assert((SELECT count(*) FROM financial_movements WHERE comprobante_id=v_id AND reference_type='annulment_reversal')=2,
    'PA7 pago mixto: una devolucion por cada pago vivo');
  PERFORM pg_temp.assert((SELECT COALESCE(SUM(net_ars),0) FROM v_finance_cashflow WHERE business_id='00000000-0000-0000-0000-000000647101'
     AND source_id IN (SELECT id FROM financial_movements WHERE comprobante_id=v_id))=0, 'PA8 pago mixto: cashflow neto 0');
END $$;

-- ============ ESTADO: doble anulacion ======================================
DO $$
DECLARE r jsonb; v_id uuid;
BEGIN
  SELECT id INTO v_id FROM pg_temp_c WHERE kind='jun';
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  -- key DISTINTA sobre un comprobante ya anulado
  r := annul_comprobante_atomic(v_id,'refund_current_session','otra vez',true,'AOTRA');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'error_code'='ALREADY_ANNULLED' AND r->>'error'='El comprobante ya está anulado', 'ST1 key distinta sobre anulado -> ALREADY_ANNULLED (contrato exacto)');
  PERFORM pg_temp.assert((SELECT count(*) FROM comprobante_annulments WHERE comprobante_id=v_id)=1, 'ST2 no se registro una segunda anulacion');
  PERFORM pg_temp.assert((SELECT count(*) FROM comprobante_annulments WHERE business_id='00000000-0000-0000-0000-000000647101' AND idempotency_key='AOTRA')=0, 'ST3 sin request huerfana tras ALREADY_ANNULLED');
END $$;
-- fiscal con CAE -> nota de credito (politica PRESERVADA)
DO $$
DECLARE r jsonb; v_id uuid;
BEGIN
  v_id := pg_temp.venta('CAE1', jsonb_build_array(pg_temp.item('00000000-0000-0000-0000-000000647d01',1,1000,600)),
                        jsonb_build_array(pg_temp.pago('efectivo',1000)));
  UPDATE comprobantes SET cae='123', estado_fiscal='emitido' WHERE id=v_id;
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  r := annul_comprobante_atomic(v_id,'refund_current_session','x',true,'ACAE');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'requiere_nota_credito'='true', 'ST4 comprobante con CAE -> requiere_nota_credito (contrato frontend)');
  PERFORM pg_temp.assert(r->>'error'='Este comprobante fue autorizado por ARCA. Generá una Nota de Crédito desde el detalle del comprobante.', 'ST5 mensaje de NC exacto');
  PERFORM pg_temp.assert((SELECT cae FROM comprobantes WHERE id=v_id)='123', 'ST6 el CAE no se toca');
END $$;

-- ============ CUENTA CORRIENTE =============================================
DO $$
DECLARE r jsonb; v_id uuid; v_bal numeric; v_acc uuid;
BEGIN
  -- venta 100% a cuenta corriente
  v_id := pg_temp.venta('CC1', jsonb_build_array(pg_temp.item('00000000-0000-0000-0000-000000647d01',1,1000,600)),
                        '[]'::jsonb, 1000, '00000000-0000-0000-0000-000000647c01');
  INSERT INTO pg_temp_c VALUES ('cc', v_id);
  SELECT id, balance INTO v_acc, v_bal FROM accounts WHERE business_id='00000000-0000-0000-0000-000000647101' LIMIT 1;
  PERFORM pg_temp.assert(v_bal=1000, 'CC1 la venta a CC dejo saldo 1000');
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  r := annul_comprobante_atomic(v_id,'commercial_annulment','sin cobro',true,'ACC1');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'ok'='true' AND (r->>'reverted_cc_ars')::numeric=1000, 'CC2 anulacion comercial revierte 1000 de CC');
  PERFORM pg_temp.assert((SELECT balance FROM accounts WHERE id=v_acc)=0, 'CC3 saldo actual restaurado a 0');
  PERFORM pg_temp.assert((SELECT count(*) FROM account_movements WHERE reference_id=v_id)=2, 'CC4 movimiento original CONSERVADO + contrario (append-only)');
  PERFORM pg_temp.assert((SELECT credit FROM account_movements WHERE reference_id=v_id AND type='ajuste')=1000, 'CC5 el contrario es un credito de 1000');
  PERFORM pg_temp.assert((SELECT date FROM account_movements WHERE reference_id=v_id AND type='ajuste')='2026-07-17', 'CC6 el contrario se fecha HOY, no en el periodo original');
  PERFORM pg_temp.assert((SELECT count(*) FROM financial_movements WHERE comprobante_id=v_id AND reference_type='annulment_reversal')=0, 'CC7 venta a CC sin cobro: no inventa devolucion de caja');
END $$;
-- comprobante sin CC
SELECT pg_temp.assert((SELECT count(*) FROM account_movements WHERE reference_id=(SELECT id FROM pg_temp_c WHERE kind='jun'))=0, 'CC8 venta sin CC: no se creo movimiento de CC');
-- modo commercial_annulment con cobros -> rechazo (politica preservada)
DO $$
DECLARE r jsonb; v_id uuid;
BEGIN
  v_id := pg_temp.venta('CC9', jsonb_build_array(pg_temp.item('00000000-0000-0000-0000-000000647d01',1,1000,600)),
                        jsonb_build_array(pg_temp.pago('efectivo',1000)));
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  r := annul_comprobante_atomic(v_id,'commercial_annulment','x',true,'ACC9');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR' AND r->>'error' LIKE '%cobrados%', 'CC10 commercial_annulment con cobros -> rechazo (politica preservada)');
END $$;

-- ============ INVENTARIO ===================================================
DO $$
DECLARE r jsonb; v_id uuid; v_s1 int; v_s2 int;
BEGIN
  SELECT stock_quantity INTO v_s1 FROM inventory WHERE id='00000000-0000-0000-0000-000000647d01';
  SELECT stock_quantity INTO v_s2 FROM inventory WHERE id='00000000-0000-0000-0000-000000647d02';
  -- varios productos + LINEA REPETIDA del mismo inventory_id + servicio sin inventario
  v_id := pg_temp.venta('IV1', jsonb_build_array(
            pg_temp.item('00000000-0000-0000-0000-000000647d01',2,1000,600),
            pg_temp.item('00000000-0000-0000-0000-000000647d01',3,1000,600),
            pg_temp.item('00000000-0000-0000-0000-000000647d02',1,500,300),
            jsonb_build_object('descripcion','mano de obra','tipo_linea','servicio','cantidad',1,'precio_unitario',200,'costo_unitario',0)),
          jsonb_build_array(pg_temp.pago('efectivo',5700)));
  INSERT INTO pg_temp_c VALUES ('inv', v_id);
  PERFORM pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id='00000000-0000-0000-0000-000000647d01')=v_s1-5, 'IV1 la venta descuenta 5 (2+3 lineas repetidas)');
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  r := annul_comprobante_atomic(v_id,'refund_current_session','x',true,'AIV1');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'ok'='true', 'IV2 anulacion multiitem OK');
  PERFORM pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id='00000000-0000-0000-0000-000000647d01')=v_s1, 'IV3 lineas repetidas: restauracion agregada exacta (5)');
  PERFORM pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id='00000000-0000-0000-0000-000000647d02')=v_s2, 'IV4 segundo producto restaurado');
  -- una sola fila de movimiento por inventory_id (agrupado, no por linea)
  PERFORM pg_temp.assert((SELECT count(*) FROM inventory_movements WHERE reference_id=v_id AND movement_type='return' AND inventory_item_id='00000000-0000-0000-0000-000000647d01')=1,
    'IV5 UN movimiento de entrada por inventory_id (agrupado)');
  PERFORM pg_temp.assert((SELECT quantity FROM inventory_movements WHERE reference_id=v_id AND movement_type='return' AND inventory_item_id='00000000-0000-0000-0000-000000647d01')=5,
    'IV6 la cantidad del movimiento es la suma de las lineas');
  PERFORM pg_temp.assert((r->>'stock_restored_count')::int=2, 'IV7 stock_restored_count = inventarios distintos (2), no lineas');
  -- servicio: sin inventario, sin COGS inventado
  PERFORM pg_temp.assert((SELECT count(*) FROM inventory_movements WHERE reference_id=v_id AND movement_type='return')=2, 'IV8 el servicio no genera movimiento de stock');
  PERFORM pg_temp.assert((SELECT cost_price FROM inventory WHERE id='00000000-0000-0000-0000-000000647d01')=600, 'IV9 costo actual intacto');
END $$;
-- servicio puro: revierte ingreso, no inventa COGS
DO $$
DECLARE r jsonb; v_id uuid;
BEGIN
  v_id := pg_temp.venta('SV1', jsonb_build_array(jsonb_build_object('descripcion','service','tipo_linea','servicio','cantidad',1,'precio_unitario',800,'costo_unitario',0)),
                        jsonb_build_array(pg_temp.pago('efectivo',800)));
  INSERT INTO pg_temp_c VALUES ('svc', v_id);
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  r := annul_comprobante_atomic(v_id,'refund_current_session','x',true,'ASV1');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'ok'='true' AND (r->>'reverted_cogs_ars')::numeric=0, 'IV10 servicio: no inventa COGS');
  PERFORM pg_temp.assert((SELECT SUM(sales_amount_ars) FROM v_finance_sales_ledger WHERE comprobante_id=v_id)=0, 'IV11 servicio: ingreso neutralizado');
  PERFORM pg_temp.assert((SELECT SUM(cogs_amount_ars) FROM v_finance_sales_ledger WHERE comprobante_id=v_id)=0, 'IV12 servicio: COGS 0 en ambos eventos');
END $$;

-- ============ AUDITORIA ====================================================
SELECT pg_temp.assert((SELECT count(*) FROM finance_audit_log WHERE business_id=:'bizC' AND source_rpc='annul_comprobante_atomic'
  AND entity_id=(SELECT id FROM pg_temp_c WHERE kind='jun'))=1, 'AU1 UN solo evento por anulacion');
SELECT pg_temp.assert((SELECT action FROM finance_audit_log WHERE business_id=:'bizC' AND source_rpc='annul_comprobante_atomic'
  AND entity_id=(SELECT id FROM pg_temp_c WHERE kind='jun'))='comprobante_annulment', 'AU2 action=comprobante_annulment');
SELECT pg_temp.assert((SELECT entity_table FROM finance_audit_log WHERE source_rpc='annul_comprobante_atomic'
  AND entity_id=(SELECT id FROM pg_temp_c WHERE kind='jun'))='comprobantes', 'AU3 entity_table=comprobantes');
-- multiitem: sigue siendo UN evento pese a 4 lineas / 2 inventarios
SELECT pg_temp.assert((SELECT count(*) FROM finance_audit_log WHERE source_rpc='annul_comprobante_atomic'
  AND entity_id=(SELECT id FROM pg_temp_c WHERE kind='inv'))=1, 'AU4 multiitem: sigue siendo UN evento');
-- cero eventos del backstop E1 (ni por comprobante_payments ni por account_movements)
SELECT pg_temp.assert((SELECT count(*) FROM finance_audit_log WHERE business_id=:'biz' AND source_rpc='finance_audit_backstop')=0, 'AU5 cero eventos del backstop E1');
-- new_data compacto con las referencias exigidas
SELECT pg_temp.assert((SELECT new_data ? 'annulment_id' AND new_data ? 'original_date' AND new_data ? 'annulment_date'
  AND new_data ? 'original_period' AND new_data ? 'annulment_period' AND new_data ? 'live_payment_ids'
  AND new_data ? 'fm_reversal_ids' AND new_data ? 'stock_restored' AND new_data ? 'request_hash'
  FROM finance_audit_log WHERE source_rpc='annul_comprobante_atomic' AND entity_id=(SELECT id FROM pg_temp_c WHERE kind='jun')), 'AU6 new_data lleva las referencias compactas');
SELECT pg_temp.assert((SELECT (new_data->>'annulment_date')::date FROM finance_audit_log WHERE source_rpc='annul_comprobante_atomic'
  AND entity_id=(SELECT id FROM pg_temp_c WHERE kind='jun'))='2026-07-16', 'AU7 la auditoria persiste la fecha economica de la anulacion');
SELECT pg_temp.assert((SELECT economic_date FROM finance_audit_log WHERE source_rpc='annul_comprobante_atomic'
  AND entity_id=(SELECT id FROM pg_temp_c WHERE kind='jun'))='2026-07-16', 'AU8 economic_date = fecha de la anulacion');

-- ============ GUARD ANTI ANULACION CLIENT-SIDE (§10) =======================
SELECT pg_temp.assert(EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_comprobante_annulment_transition'), 'GA1 trigger de transicion presente');
DO $$
DECLARE e text; v_id uuid; v_estado text;
BEGIN
  v_id := pg_temp.venta('GA1', jsonb_build_array(pg_temp.item('00000000-0000-0000-0000-000000647d01',1,1000,600)),
                        jsonb_build_array(pg_temp.pago('efectivo',1000)));
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  -- la via legacy: UPDATE comprobantes SET estado='anulado' como usuario autenticado
  e:=''; BEGIN UPDATE comprobantes SET estado='anulado' WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  RESET ROLE;
  PERFORM pg_temp.assert(e LIKE '%annul_comprobante_atomic%', 'GA2 UPDATE estado=anulado como authenticated FALLA');
  PERFORM pg_temp.assert((SELECT estado FROM comprobantes WHERE id=v_id) IS DISTINCT FROM 'anulado', 'GA3 la fila NO se modifico');
  -- tampoco por las columnas espejo
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  e:=''; BEGIN UPDATE comprobantes SET status='cancelled' WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e<>'', 'GA4 UPDATE status=cancelled tambien bloqueado');
  e:=''; BEGIN UPDATE comprobantes SET estado_comercial='anulado' WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e<>'', 'GA5 UPDATE estado_comercial=anulado tambien bloqueado');
  -- los UPDATE legitimos siguen permitidos
  e:=''; BEGIN UPDATE comprobantes SET observaciones='nota del cliente' WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  RESET ROLE;
  PERFORM pg_temp.assert(e='', 'GA6 los demas UPDATE del comprobante siguen permitidos');
  -- la GUC sola NO alcanza (un cliente autenticado puede setearla)
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  PERFORM set_config('m7.annulment_scope','1',true);
  e:=''; BEGIN UPDATE comprobantes SET estado='anulado' WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  RESET ROLE;
  PERFORM set_config('m7.annulment_scope','',true);
  PERFORM pg_temp.assert(e LIKE '%annul_comprobante_atomic%', 'GA7 con la GUC seteada a mano SIGUE bloqueado (no es la unica proteccion)');
  -- y la RPC canonica SI puede
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  PERFORM annul_comprobante_atomic(v_id,'refund_current_session','x',true,'AGA1');
  RESET ROLE;
  PERFORM pg_temp.assert((SELECT estado FROM comprobantes WHERE id=v_id)='anulado', 'GA8 la RPC canonica SI realiza la transicion');
END $$;

-- ============ REQUEST TABLE ================================================
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.comprobante_annulments','INSERT'), 'RT1 authenticated NO INSERT');
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.comprobante_annulments','UPDATE'), 'RT2 authenticated NO UPDATE');
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.comprobante_annulments','DELETE'), 'RT3 authenticated NO DELETE');
SELECT pg_temp.assert(NOT has_table_privilege('service_role','public.comprobante_annulments','DELETE'), 'RT4 service_role NO DELETE');
SELECT pg_temp.assert(has_table_privilege('authenticated','public.comprobante_annulments','SELECT'), 'RT5 SELECT de authenticated PRESERVADO (existia en M6)');
SELECT pg_temp.assert(EXISTS(SELECT 1 FROM pg_indexes WHERE tablename='comprobante_annulments' AND indexname='idx_comprobante_annulments_key'), 'RT6 UNIQUE(business_id, idempotency_key)');
SELECT pg_temp.assert(EXISTS(SELECT 1 FROM pg_indexes WHERE tablename='comprobante_annulments' AND indexname='idx_comprobante_annulments_comp'), 'RT7 UNIQUE parcial: una anulacion completed por comprobante');
DO $$
DECLARE v_id uuid; e text;
BEGIN
  SELECT id INTO v_id FROM comprobante_annulments LIMIT 1;
  e:=''; BEGIN DELETE FROM comprobante_annulments WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%append-only%', 'RT8 DELETE prohibido');
  e:=''; BEGIN UPDATE comprobante_annulments SET request_hash='x' WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%inmutable%', 'RT9 request_hash inmutable');
  e:=''; BEGIN UPDATE comprobante_annulments SET annulment_date='2020-01-01' WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%inmutable%', 'RT10 annulment_date inmutable (no se puede mover el periodo compensatorio)');
  e:=''; BEGIN UPDATE comprobante_annulments SET reverted_cash_ars=0 WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%inmutable%', 'RT11 importes revertidos inmutables');
END $$;

-- ============ ROLLBACK TOTAL ===============================================
-- Falla forzada en la auditoria: NADA debe quedar
-- NOT VALID: solo se aplica a filas NUEVAS (ya existen eventos de anulacion de
-- los casos anteriores, que no se revalidan).
ALTER TABLE finance_audit_log ADD CONSTRAINT tmp_fail_an CHECK (action <> 'comprobante_annulment') NOT VALID;
DO $$
DECLARE r jsonb; v_id uuid; v_stock int; v_fm int; v_bfe int; v_bal numeric;
BEGIN
  v_id := pg_temp.venta('RB1', jsonb_build_array(pg_temp.item('00000000-0000-0000-0000-000000647d01',2,1000,600)),
                        jsonb_build_array(pg_temp.pago('efectivo',2000)));
  SELECT stock_quantity INTO v_stock FROM inventory WHERE id='00000000-0000-0000-0000-000000647d01';
  SELECT count(*) INTO v_fm FROM financial_movements WHERE business_id='00000000-0000-0000-0000-000000647101';
  SELECT count(*) INTO v_bfe FROM business_finance_entries WHERE business_id='00000000-0000-0000-0000-000000647101';
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  r := annul_comprobante_atomic(v_id,'refund_current_session','x',true,'ARB1');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'error_code'='AUDIT_FAILED', 'RB1 auditoria rota -> AUDIT_FAILED');
  PERFORM pg_temp.assert(r->>'error' NOT LIKE '%tmp_fail_an%' AND r->>'error' NOT LIKE '%constraint%', 'RB2 no expone SQLERRM');
  PERFORM pg_temp.assert((SELECT estado FROM comprobantes WHERE id=v_id) IS DISTINCT FROM 'anulado', 'RB3 el comprobante NO quedo anulado');
  PERFORM pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id='00000000-0000-0000-0000-000000647d01')=v_stock, 'RB4 stock sin restaurar');
  PERFORM pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id='00000000-0000-0000-0000-000000647101')=v_fm, 'RB5 sin compensaciones de caja parciales');
  PERFORM pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id='00000000-0000-0000-0000-000000647101')=v_bfe, 'RB6 sin BFE parciales');
  PERFORM pg_temp.assert((SELECT count(*) FROM comprobante_annulments WHERE comprobante_id=v_id)=0, 'RB7 sin request huerfana');
  PERFORM pg_temp.assert((SELECT count(*) FROM inventory_movements WHERE reference_id=v_id AND movement_type='return')=0, 'RB8 sin movimientos de inventario parciales');
  PERFORM pg_temp.assert((SELECT count(*) FROM comprobante_items WHERE comprobante_id=v_id AND stock_processed=true)=1, 'RB9 el marcador stock_processed no se consumio');
END $$;
ALTER TABLE finance_audit_log DROP CONSTRAINT tmp_fail_an;
-- tras quitar la falla, la MISMA key arranca limpia
DO $$
DECLARE r jsonb; v_id uuid;
BEGIN
  SELECT c.id INTO v_id FROM comprobantes c WHERE c.business_id='00000000-0000-0000-0000-000000647101'
    AND EXISTS(SELECT 1 FROM comprobante_items i WHERE i.comprobante_id=c.id AND i.cantidad=2 AND i.stock_processed=true)
    AND c.estado IS DISTINCT FROM 'anulado' ORDER BY c.created_at DESC LIMIT 1;
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  r := annul_comprobante_atomic(v_id,'refund_current_session','x',true,'ARB1');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'ok'='true' AND r->>'replay'='false', 'RB10 tras el rollback la misma key ejecuta limpio');
END $$;

-- ============ 6F.4a §2: condicion canonica de anulado ======================
SELECT pg_temp.assert(pg_temp.is_ann((SELECT id FROM pg_temp_c WHERE kind='jun')), 'CA1 is_comprobante_annulled = true para el anulado');
SELECT pg_temp.assert(NOT pg_temp.is_ann((SELECT id FROM pg_temp_c WHERE kind='pc1')), 'CA2 is_comprobante_annulled = false para el vigente');
-- el registro de anulacion ALCANZA por si solo, aunque las columnas mientan
DO $$
DECLARE v_id uuid;
BEGIN
  v_id := pg_temp.venta('CA3', jsonb_build_array(pg_temp.item('00000000-0000-0000-0000-000000647d01',1,1000,600)),
                        jsonb_build_array(pg_temp.pago('efectivo',1000)));
  -- se inyecta SOLO el registro canonico, sin tocar ninguna columna de estado
  INSERT INTO comprobante_annulments(business_id,comprobante_id,user_id,idempotency_key,request_hash,mode,motivo,restore_stock,status)
    VALUES ('00000000-0000-0000-0000-000000647101',v_id,'00000000-0000-0000-0000-000000647109','CA3K','h','commercial_annulment','x',false,'completed');
  PERFORM pg_temp.assert((SELECT estado FROM comprobantes WHERE id=v_id) IS DISTINCT FROM 'anulado', 'CA3 el comprobante tiene columnas ACTIVAS...');
  PERFORM pg_temp.assert(public.is_comprobante_annulled(v_id), 'CA4 ...pero el registro de anulacion ya lo hace canonicamente anulado');
  INSERT INTO pg_temp_c VALUES ('solo_registro', v_id);
END $$;
-- y las columnas ALCANZAN por si solas (defensa legacy: anulados sin registro)
SELECT pg_temp.assert(public.comprobante_state_is_annulled('anulado',NULL,NULL), 'CA5 estado=anulado -> anulado');
SELECT pg_temp.assert(public.comprobante_state_is_annulled(NULL,'anulado',NULL), 'CA6 estado_comercial=anulado -> anulado');
SELECT pg_temp.assert(public.comprobante_state_is_annulled(NULL,NULL,'cancelled'), 'CA7 status=cancelled -> anulado');
SELECT pg_temp.assert(NOT public.comprobante_state_is_annulled('emitido','pendiente','issued'), 'CA8 comprobante vigente -> no anulado');
SELECT pg_temp.assert(NOT public.comprobante_state_is_annulled(NULL,NULL,NULL), 'CA9 todo NULL -> no anulado (no NULL)');

-- ============ 6F.4a §5: consistencia de TODAS las señales ==================
-- Falla si el registro de anulacion existe pero alguna columna deja el
-- comprobante aparentemente activo.
SELECT pg_temp.assert((SELECT count(*) FROM comprobante_annulments a
  JOIN comprobantes c ON c.id=a.comprobante_id
  WHERE a.status='completed' AND a.business_id=:'biz'
    AND a.idempotency_key <> 'CA3K'   -- inyectado a mano a proposito en CA3
    AND (c.estado IS DISTINCT FROM 'anulado' OR c.estado_comercial IS DISTINCT FROM 'anulado'
         OR c.status IS DISTINCT FROM 'cancelled'))=0,
  'CN1 toda anulacion via RPC deja estado/estado_comercial/status alineados');
-- estado_fiscal: politica PRESERVADA — un no_fiscal sigue no_fiscal; el resto pasa
-- a anulado_fiscal. Nunca queda en un estado fiscal "activo".
SELECT pg_temp.assert((SELECT estado_fiscal FROM comprobantes WHERE id=(SELECT id FROM pg_temp_c WHERE kind='jun'))='no_fiscal', 'CN2 estado_fiscal de un no_fiscal se conserva (politica intacta)');
SELECT pg_temp.assert((SELECT count(*) FROM comprobante_annulments a JOIN comprobantes c ON c.id=a.comprobante_id
  WHERE a.status='completed' AND a.business_id=:'biz' AND a.idempotency_key <> 'CA3K'
    AND c.estado_fiscal NOT IN ('no_fiscal','anulado_fiscal'))=0, 'CN2b ningun anulado queda en estado fiscal activo');
SELECT pg_temp.assert((SELECT user_id FROM comprobante_annulments WHERE comprobante_id=(SELECT id FROM pg_temp_c WHERE kind='jun'))=:'OA', 'CN3 actor persistido');
SELECT pg_temp.assert((SELECT motivo FROM comprobante_annulments WHERE comprobante_id=(SELECT id FROM pg_temp_c WHERE kind='jun'))='venta de prueba', 'CN4 motivo persistido');
SELECT pg_temp.assert((SELECT annulment_date FROM comprobante_annulments WHERE comprobante_id=(SELECT id FROM pg_temp_c WHERE kind='jun')) IS NOT NULL, 'CN5 fecha persistida');
SELECT pg_temp.assert((SELECT afip_response->'anulacion'->>'motivo' FROM comprobantes WHERE id=(SELECT id FROM pg_temp_c WHERE kind='jun'))='venta de prueba', 'CN6 rastro de anulacion en el comprobante');

-- ============ 6F.4a §4: desanular / columnas alternativas ==================
DO $$
DECLARE e text; v_id uuid;
BEGIN
  -- 'repl' (no 'jun'): la policy de UPDATE resuelve por current_business_id(), que
  -- es el negocio del profile de OA (biz). Sobre un comprobante de bizC la RLS
  -- descartaria el UPDATE en silencio y el guard no se ejercitaria.
  SELECT id INTO v_id FROM pg_temp_c WHERE kind='repl';  -- anulado por la RPC, en biz
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  -- RESUCITAR por cada columna
  e:=''; BEGIN UPDATE comprobantes SET estado='emitido' WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%annul_comprobante_atomic%', 'DA1 desanular por estado -> BLOQUEADO');
  e:=''; BEGIN UPDATE comprobantes SET estado_comercial='pendiente' WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%annul_comprobante_atomic%', 'DA2 desanular por estado_comercial -> BLOQUEADO');
  e:=''; BEGIN UPDATE comprobantes SET status='issued' WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%annul_comprobante_atomic%', 'DA3 desanular por status -> BLOQUEADO (aunque estado siga anulado)');
  -- combinaciones
  e:=''; BEGIN UPDATE comprobantes SET estado='emitido', status='issued', estado_comercial='pendiente' WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%annul_comprobante_atomic%', 'DA4 desanular las tres a la vez -> BLOQUEADO');
  RESET ROLE;
  PERFORM pg_temp.assert((SELECT estado FROM comprobantes WHERE id=v_id)='anulado'
    AND (SELECT status FROM comprobantes WHERE id=v_id)='cancelled'
    AND (SELECT estado_comercial FROM comprobantes WHERE id=v_id)='anulado', 'DA5 ninguna señal se movio');
END $$;

-- ============ 6F.4a §3: pagos nuevos sobre anulado =========================
-- Evidencia de que el guard hace falta: authenticated TIENE grant de INSERT.
SELECT pg_temp.assert(has_table_privilege('authenticated','public.comprobante_payments','INSERT'), 'GP0 authenticated TIENE grant INSERT (por eso el guard central es necesario)');
SELECT pg_temp.assert(EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_cp_annulled_guard'), 'GP1 guard BEFORE INSERT presente');
DO $$
DECLARE e text; v_anulado uuid; v_vivo uuid; v_solo uuid; v_n int;
BEGIN
  -- pg_temp_c se lee ANTES de SET ROLE: authenticated no tiene permiso sobre la temp
  SELECT id INTO v_anulado FROM pg_temp_c WHERE kind='repl';  -- anulado, en biz
  SELECT id INTO v_vivo FROM pg_temp_c WHERE kind='pc1';      -- vigente, en biz
  SELECT id INTO v_solo FROM pg_temp_c WHERE kind='solo_registro';
  SELECT count(*) INTO v_n FROM comprobante_payments WHERE comprobante_id=v_anulado;
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  -- insercion DIRECTA de pago sobre anulado (la via que los grants permiten)
  e:='';
  BEGIN
    INSERT INTO comprobante_payments(comprobante_id,business_id,amount,currency,amount_ars,exchange_rate,payment_method,date)
      VALUES (v_anulado,'00000000-0000-0000-0000-000000647101',500,'ARS',500,1,'efectivo','2026-07-17');
  EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  RESET ROLE;
  PERFORM pg_temp.assert(e='El comprobante está anulado', 'GP2 pago directo sobre anulado -> rechazado (contrato exacto)');
  PERFORM pg_temp.assert((SELECT count(*) FROM comprobante_payments WHERE comprobante_id=v_anulado)=v_n, 'GP3 no se creo el pago');
  -- pero un comprobante VIGENTE si acepta pagos
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  e:='';
  BEGIN
    INSERT INTO comprobante_payments(comprobante_id,business_id,amount,currency,amount_ars,exchange_rate,payment_method,date)
      VALUES (v_vivo,'00000000-0000-0000-0000-000000647101',1,'ARS',1,1,'efectivo','2026-07-17');
  EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  RESET ROLE;
  PERFORM pg_temp.assert(e='', 'GP4 un comprobante VIGENTE sigue aceptando pagos');
  -- aislamiento de negocio
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  e:='';
  BEGIN
    INSERT INTO comprobante_payments(comprobante_id,business_id,amount,currency,amount_ars,exchange_rate,payment_method,date)
      VALUES (v_vivo,'00000000-0000-0000-0000-000000647201',1,'ARS',1,1,'efectivo','2026-07-17');
  EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  RESET ROLE;
  PERFORM pg_temp.assert(e<>'', 'GP5 pago con business_id distinto al del comprobante -> rechazado');
  -- el registro canonico solo (sin columnas) tambien bloquea
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000647109',true);
  e:='';
  BEGIN
    INSERT INTO comprobante_payments(comprobante_id,business_id,amount,currency,amount_ars,exchange_rate,payment_method,date)
      VALUES (v_solo,'00000000-0000-0000-0000-000000647101',1,'ARS',1,1,'efectivo','2026-07-17');
  EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  RESET ROLE;
  PERFORM pg_temp.assert(e='El comprobante está anulado', 'GP6 el registro canonico solo (columnas activas) tambien bloquea el pago');
END $$;
-- las filas historicas no se ven afectadas (el guard es BEFORE INSERT):
-- 'repl' conserva sus DOS pagos (el efectivo reemplazado + la transferencia viva)
SELECT pg_temp.assert((SELECT count(*) FROM comprobante_payments WHERE comprobante_id=(SELECT id FROM pg_temp_c WHERE kind='repl'))=2, 'GP7 los pagos historicos del anulado siguen intactos');

SELECT pg_temp.assert(true, '=== etapa7_rpc_integration_comprobante_annulment_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
