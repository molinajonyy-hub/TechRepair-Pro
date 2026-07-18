-- ============================================================================
-- M7 Bloque 6E.2 -- create_comprobante_checkout_atomic (aditivos M7 sobre E1).
-- Contrato status preservado (created/existing/idempotency_conflict/
-- already_processing/failed_retryable/failed_final) + error_code aditivo.
--   Seguridad · idempotencia · cantidades enteras · audit scope (1 evento
--   sale_checkout, backstop E1 suprimido) · pagos/caja/CC · contabilidad (COGS
--   una vez, cashflow percibido, CC sin caja) · guard de periodo · rollback.
-- Concurrencia: harness aparte.
-- RUN: docker cp ... && psql -X -f (BEGIN + ROLLBACK)
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;
-- payload de venta de UN producto (qty, precio) al contado o CC
CREATE OR REPLACE FUNCTION pg_temp.pl(qty numeric, precio numeric, cash numeric, cc numeric, cust text, pagos jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'tipo','factura_c','punto_venta','0001','condicion_fiscal','Consumidor Final',
    'customer_id', cust, 'cc_total', cc, 'es_fiscal', false,
    'items', jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-000000357d01','descripcion','P','tipo_linea','producto','cantidad',qty,'precio_unitario',precio)),
    'pagos', COALESCE(pagos, CASE WHEN cash>0 THEN jsonb_build_array(jsonb_build_object('amount',cash,'amount_ars',cash,'payment_method','efectivo')) ELSE '[]'::jsonb END)) $$;

\set biz  '00000000-0000-0000-0000-000000357101'
\set OA   '00000000-0000-0000-0000-000000357109'
\set biz2 '00000000-0000-0000-0000-000000357201'
\set OB   '00000000-0000-0000-0000-000000357209'
\set CUST '00000000-0000-0000-0000-000000357c01'
\set CUS2 '00000000-0000-0000-0000-000000357c02'
\set INV  '00000000-0000-0000-0000-000000357d01'
\set CAJA '00000000-0000-0000-0000-000000357601'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'OA'),(:'OB');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','6E2 A',:'OA'),(:'biz2','6E2 B',:'OB');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES (:'biz',:'OA','owner',true),(:'biz2',:'OB','owner',true);
INSERT INTO customers(id,business_id,name,phone,customer_type) VALUES (:'CUST',:'biz','Cli A','+540001','minorista'),(:'CUS2',:'biz2','Cli B','+540002','minorista');
INSERT INTO inventory(id,business_id,name,code,category,stock_quantity,stock,cost_price,sale_price,base_price,base_currency,auto_update_price,exchange_rate_used,is_active)
  VALUES (:'INV',:'biz','Prod','E2-1','Rep',100,100,600,1000,1000,'ARS',false,1,true);
INSERT INTO cajas(id,business_id,opened_by,status) VALUES (:'CAJA',:'biz',:'OA','abierta');
SET LOCAL session_replication_role='origin';

-- ============ Seguridad / contrato de error =================================
DO $$
DECLARE r jsonb;
BEGIN
  -- sin auth
  SET LOCAL "request.jwt.claim.sub" = '';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000357101'::uuid,'k0','h0', pg_temp.pl(1,1000,1000,0,NULL));
  PERFORM pg_temp.assert(r->>'status'='failed_final' AND r->>'error_code'='FORBIDDEN', 'S1 sin auth -> failed_final FORBIDDEN');
  -- cross-tenant
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000357209';  -- OB
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000357101'::uuid,'k1','h1', pg_temp.pl(1,1000,1000,0,NULL));
  PERFORM pg_temp.assert(r->>'status'='failed_final' AND r->>'error_code'='FORBIDDEN', 'S2 cross-tenant -> FORBIDDEN');
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000357109';  -- OA
  -- cliente de otro negocio
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000357101'::uuid,'k2','h2', pg_temp.pl(1,1000,0,1000,'00000000-0000-0000-0000-000000357c02'));
  PERFORM pg_temp.assert(r->>'error_code'='CUSTOMER_NOT_FOUND', 'S3 cliente de otro negocio -> CUSTOMER_NOT_FOUND');
  -- producto de otro negocio
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000357101'::uuid,'k3','h3',
    jsonb_build_object('tipo','factura_c','cc_total',0,'items',jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-0000009999d1','descripcion','X','cantidad',1,'precio_unitario',1000)),'pagos',jsonb_build_array(jsonb_build_object('amount',1000,'amount_ars',1000,'payment_method','efectivo'))));
  PERFORM pg_temp.assert(r->>'error_code'='INVENTORY_NOT_FOUND', 'S4 producto de otro negocio -> INVENTORY_NOT_FOUND');
  -- orden de otro negocio
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000357101'::uuid,'k4','h4',
    (pg_temp.pl(1,1000,1000,0,NULL) || jsonb_build_object('order_id','00000000-0000-0000-0000-0000009999a1')));
  PERFORM pg_temp.assert(r->>'error_code'='ORDER_NOT_FOUND', 'S5 orden de otro negocio -> ORDER_NOT_FOUND');
  -- cantidad decimal -> VALIDATION_ERROR (mensaje entero)
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000357101'::uuid,'k5','h5', pg_temp.pl(1.5,1000,1500,0,NULL));
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR' AND r->>'error'='La cantidad debe ser un número entero mayor o igual a 1', 'S6 cantidad 1.5 -> VALIDATION_ERROR (mensaje entero)');
  -- sobrepago (excede total+tolerancia) -> se preserva rechazo (failed_retryable, VALIDATION_ERROR)
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000357101'::uuid,'k6','h6', pg_temp.pl(1,1000,5000,0,NULL));
  PERFORM pg_temp.assert(r->>'status'='failed_retryable' AND r->>'error_code'='VALIDATION_ERROR', 'S7 sobrepago -> rechazo preservado (VALIDATION_ERROR)');
  RESET ROLE;
END $$;
-- ningun rechazo dejo comprobante ni movio stock
SELECT pg_temp.assert((SELECT count(*) FROM comprobantes WHERE business_id=:'biz')=0, 'S-clean 0 comprobantes tras rechazos');
SELECT pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id=:'INV')=100, 'S-clean stock intacto (100)');

-- ============ Backstop E1 UNMANAGED (control) vs MANAGED (checkout) ==========
-- Control: primero una venta gestionada crea comp1; luego, fuera de scope, un
-- insert directo en comprobante_payments dispara el backstop (+1 evento).
DO $$
DECLARE r jsonb; v_comp uuid; v_before int; v_after int;
BEGIN
  SELECT count(*) INTO v_before FROM finance_audit_log WHERE business_id='00000000-0000-0000-0000-000000357101';  -- postgres
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000357109';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000357101'::uuid,'SALE1','hs1', pg_temp.pl(2,1000,2000,0,NULL));
  RESET ROLE;  -- conteos como postgres (bypass RLS)
  PERFORM pg_temp.assert(r->>'status'='created', 'A1 venta contado -> created ('||COALESCE(r->>'error','')||')');
  v_comp := (r->>'comprobante_id')::uuid;
  SELECT count(*) INTO v_after FROM finance_audit_log WHERE business_id='00000000-0000-0000-0000-000000357101';
  PERFORM pg_temp.assert(v_after - v_before = 1, 'A2 checkout gestionado -> exactamente 1 evento (backstop suprimido)');
  PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM finance_audit_log WHERE entity_id=v_comp AND action='sale_checkout'), 'A3 evento = sale_checkout');
  -- Control unmanaged: resetear la GUC y hacer un insert directo -> backstop dispara
  PERFORM set_config('m7.audit_managed','0',true);
  SELECT count(*) INTO v_before FROM finance_audit_log WHERE business_id='00000000-0000-0000-0000-000000357101';
  INSERT INTO comprobante_payments (comprobante_id, business_id, amount, currency, amount_ars, exchange_rate, payment_method, net_amount, date, created_by)
    VALUES (v_comp,'00000000-0000-0000-0000-000000357101',1,'ARS',1,1,'efectivo',1,public.ar_today(),'00000000-0000-0000-0000-000000357109');
  SELECT count(*) INTO v_after FROM finance_audit_log WHERE business_id='00000000-0000-0000-0000-000000357101';
  PERFORM pg_temp.assert(v_after - v_before >= 1, 'A4 insert directo NO gestionado -> backstop registra');
END $$;

-- ============ Venta contado: contabilidad =================================
-- (usa la venta SALE1: qty 2 @ 1000 = 2000, efectivo 2000)
SELECT pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id=:'INV')=98, 'V1 stock 100 -> 98 (venta 2)');
SELECT pg_temp.assert((SELECT count(*) FROM inventory_movements WHERE inventory_item_id=:'INV' AND movement_type='sale')=1, 'V2 1 inventory_movement de venta');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'biz' AND category='mercaderia' AND amount_ars=1200)=1, 'V3 COGS mercaderia = 600*2 = 1200 (una vez)');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'biz' AND category='mercaderia')=1, 'V4 COGS una sola vez (sin duplicar por triggers)');
-- cashflow percibido: el pago efectivo aparece como ingreso
SELECT pg_temp.assert((SELECT COALESCE(SUM(income_ars),0) FROM v_finance_cashflow WHERE business_id=:'biz')>=2000, 'V5 cashflow percibido incluye el cobro (>=2000)');

-- ============ Pago MIXTO -> sigue siendo UN evento ==========================
DO $$
DECLARE r jsonb; v_before int; v_after int; v_comp uuid;
BEGIN
  SELECT count(*) INTO v_before FROM finance_audit_log WHERE business_id='00000000-0000-0000-0000-000000357101' AND action='sale_checkout';  -- postgres
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000357109';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000357101'::uuid,'MIX1','hm1',
    pg_temp.pl(1,1000,0,0,NULL, jsonb_build_array(
      jsonb_build_object('amount',500,'amount_ars',500,'payment_method','efectivo'),
      jsonb_build_object('amount',500,'amount_ars',500,'payment_method','transferencia'))));
  RESET ROLE;  -- conteos como postgres
  PERFORM pg_temp.assert(r->>'status'='created', 'MX1 pago mixto -> created ('||COALESCE(r->>'error','')||')');
  v_comp := (r->>'comprobante_id')::uuid;
  SELECT count(*) INTO v_after FROM finance_audit_log WHERE business_id='00000000-0000-0000-0000-000000357101' AND action='sale_checkout';
  PERFORM pg_temp.assert(v_after - v_before = 1, 'MX2 pago mixto (2 pagos) -> UN solo evento sale_checkout');
  PERFORM pg_temp.assert((SELECT count(*) FROM comprobante_payments WHERE comprobante_id=v_comp)=2, 'MX3 2 comprobante_payments creados');
  PERFORM pg_temp.assert((SELECT (new_data->>'payment_count')::int FROM finance_audit_log WHERE entity_id=v_comp AND action='sale_checkout')=2, 'MX4 auditoria resume 2 pagos en 1 evento');
END $$;

-- ============ Cuenta corriente: deuda sin caja ficticia =====================
DO $$
DECLARE r jsonb; v_comp uuid; v_fm_before int;
BEGIN
  -- baseline como postgres (sin RLS) para comparar consistentemente
  SELECT count(*) INTO v_fm_before FROM financial_movements WHERE business_id='00000000-0000-0000-0000-000000357101';
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000357109';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000357101'::uuid,'CC1','hc1', pg_temp.pl(1,1000,0,1000,'00000000-0000-0000-0000-000000357c01'));
  RESET ROLE;  -- asserts leen datos como postgres (bypass RLS)
  PERFORM pg_temp.assert(r->>'status'='created', 'CC1 venta total a CC -> created ('||COALESCE(r->>'error','')||')');
  v_comp := (r->>'comprobante_id')::uuid;
  PERFORM pg_temp.assert((SELECT count(*) FROM account_movements am JOIN accounts a ON a.id=am.account_id WHERE a.entity_id='00000000-0000-0000-0000-000000357c01' AND am.type='venta' AND am.debit=1000)=1, 'CC2 1 movimiento de deuda (debit 1000)');
  PERFORM pg_temp.assert((SELECT count(*) FROM comprobante_payments WHERE comprobante_id=v_comp)=0, 'CC3 sin comprobante_payments (nada percibido)');
  PERFORM pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id='00000000-0000-0000-0000-000000357101')=v_fm_before, 'CC4 CC NO crea FM (sin caja ficticia)');
END $$;

-- ============ Idempotencia + replay + request protegida =====================
DO $$
DECLARE r jsonb; v_comp uuid;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000357109';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000357101'::uuid,'IDK','HID', pg_temp.pl(1,1000,1000,0,NULL));
  v_comp := (r->>'comprobante_id')::uuid;
  PERFORM pg_temp.assert(r->>'status'='created', 'ID1 primera venta -> created');
  -- replay: misma key + mismo hash -> existing, mismo comprobante_id
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000357101'::uuid,'IDK','HID', pg_temp.pl(1,1000,1000,0,NULL));
  PERFORM pg_temp.assert(r->>'status'='existing' AND (r->>'comprobante_id')::uuid=v_comp, 'ID2 replay -> existing mismo comprobante_id');
  -- 6E.2a: misma key + client hash DISTINTO + MISMO payload -> existing (server hash es autoridad)
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000357101'::uuid,'IDK','HID_OTRO', pg_temp.pl(1,1000,1000,0,NULL));
  PERFORM pg_temp.assert(r->>'status'='existing' AND (r->>'comprobante_id')::uuid=v_comp, 'ID3 client hash distinto + mismo payload -> existing (server hash autoridad)');
  -- misma key + PAYLOAD distinto -> idempotency_conflict (aunque el client hash coincida)
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000357101'::uuid,'IDK','HID', pg_temp.pl(2,1000,2000,0,NULL));
  PERFORM pg_temp.assert(r->>'status'='idempotency_conflict', 'ID3b payload distinto -> idempotency_conflict');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT count(*) FROM comprobantes WHERE business_id=:'biz' AND created_by=:'OA' AND total=1000 AND estado_comercial='pagado')>=1, 'ID4 replay no duplico comprobante');
-- request table protegida
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.comprobante_checkout_requests','SELECT'), 'RT1 authenticated NO SELECT checkout_requests');
SELECT pg_temp.assert(NOT has_table_privilege('service_role','public.comprobante_checkout_requests','DELETE'), 'RT2 service_role NO DELETE');
DO $$
DECLARE v_id uuid; e text;
BEGIN
  SELECT id INTO v_id FROM comprobante_checkout_requests WHERE business_id='00000000-0000-0000-0000-000000357101' AND idempotency_key='IDK';
  e:=''; BEGIN DELETE FROM comprobante_checkout_requests WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e<>'', 'RT3 DELETE prohibido (append-only)');
  e:=''; BEGIN UPDATE comprobante_checkout_requests SET client_request_hash='x' WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%inmutable%', 'RT4 client_request_hash inmutable');
END $$;

-- ============ Servicio sin inventario: sin stock ni COGS ====================
DO $$
DECLARE r jsonb; v_cogs_before int;
BEGIN
  SELECT count(*) INTO v_cogs_before FROM business_finance_entries WHERE business_id='00000000-0000-0000-0000-000000357101' AND category='mercaderia';  -- postgres
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000357109';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000357101'::uuid,'SVC1','hv1',
    jsonb_build_object('tipo','factura_c','cc_total',0,
      'items',jsonb_build_array(jsonb_build_object('descripcion','Mano de obra','tipo_linea','servicio','cantidad',1,'precio_unitario',500,'costo_unitario',0)),
      'pagos',jsonb_build_array(jsonb_build_object('amount',500,'amount_ars',500,'payment_method','efectivo'))));
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status'='created', 'SV1 venta de servicio -> created ('||COALESCE(r->>'error','')||')');
  PERFORM pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id='00000000-0000-0000-0000-000000357101' AND category='mercaderia')=v_cogs_before, 'SV2 servicio NO genera COGS');
END $$;

-- ============ Guard de periodo (inyeccion directa de cierre) ================
DO $$
DECLARE r jsonb; v_ps date := date_trunc('month', public.ar_today())::date; v_pe date := (date_trunc('month', public.ar_today())+interval '1 month - 1 day')::date;
BEGIN
  -- cerrar el mes ACTUAL directamente (close_period lo prohibe; se inyecta para probar el guard)
  INSERT INTO finance_period_locks(business_id, period_start, period_end, status, closed_by, close_reason)
    VALUES ('00000000-0000-0000-0000-000000357101', v_ps, v_pe, 'closed','00000000-0000-0000-0000-000000357109','test guard');
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000357109';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000357101'::uuid,'PC1','hpc1', pg_temp.pl(1,1000,1000,0,NULL));
  PERFORM pg_temp.assert(r->>'error_code'='PERIOD_CLOSED', 'PC1 periodo cerrado -> error_code PERIOD_CLOSED');
  RESET ROLE;
  DELETE FROM finance_period_locks WHERE business_id='00000000-0000-0000-0000-000000357101' AND period_start=v_ps;
END $$;

-- ============ Rollback ante fallo de auditoria ==============================
ALTER TABLE finance_audit_log ADD CONSTRAINT tmp_fail_sc CHECK (action <> 'sale_checkout') NOT VALID;
DO $$
DECLARE r jsonb; v_stk int;
BEGIN
  SELECT stock_quantity INTO v_stk FROM inventory WHERE id='00000000-0000-0000-0000-000000357d01';
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000357109';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000357101'::uuid,'RBK','hrb', pg_temp.pl(3,1000,3000,0,NULL));
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status'='failed_retryable' AND r->>'error_code'='AUDIT_FAILED', 'RB1 auditoria rota -> failed_retryable AUDIT_FAILED');
  PERFORM pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id='00000000-0000-0000-0000-000000357d01')=v_stk, 'RB2 stock revertido');
  PERFORM pg_temp.assert(NOT EXISTS(SELECT 1 FROM comprobantes c WHERE c.business_id='00000000-0000-0000-0000-000000357101' AND c.id=(SELECT comprobante_id FROM comprobante_checkout_requests WHERE idempotency_key='RBK')), 'RB3 sin comprobante (rollback)');
END $$;
ALTER TABLE finance_audit_log DROP CONSTRAINT tmp_fail_sc;

-- ============ Estatico: aditivos M7 presentes ===============================
SELECT pg_temp.assert(pg_get_functiondef('public.create_comprobante_checkout_atomic(uuid,text,text,jsonb)'::regprocedure) ILIKE '%assert_period_open%', 'ST1 guard de periodo presente');
SELECT pg_temp.assert(pg_get_functiondef('public.create_comprobante_checkout_atomic(uuid,text,text,jsonb)'::regprocedure) ILIKE '%finance_begin_audit_scope%', 'ST2 audit scope presente');
SELECT pg_temp.assert(pg_get_functiondef('public.create_comprobante_checkout_atomic(uuid,text,text,jsonb)'::regprocedure) ILIKE '%ORDER BY id%FOR UPDATE%', 'ST3 lock determinista presente');
SELECT pg_temp.assert(pg_get_functiondef('public.create_comprobante_checkout_atomic(uuid,text,text,jsonb)'::regprocedure) ILIKE '%finance_log_audit%sale_checkout%', 'ST4 evento sale_checkout presente');

SELECT pg_temp.assert(true, '=== etapa7_rpc_integration_checkout_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
