-- ============================================================================
-- M7 Bloque 6C -- record_customer_account_payment_atomic / create_order_payment_atomic
-- Guard, idempotencia concurrente, auditoria explicita, y PRIMER ejercicio real
-- del audit scope sobre E2 (account_movements): (1) escritura directa -> backstop;
-- (2) RPC gestionada -> 0 backstop + 1 explicito; (3) fallo del log -> 0 escrituras.
-- RUN: docker cp && psql -X -f  (una tx + ROLLBACK). Concurrencia: harness aparte.
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set bizA '00000000-0000-0000-0000-0000002c7101'
\set OA   '00000000-0000-0000-0000-0000002c7109'
\set ADM  '00000000-0000-0000-0000-0000002c7108'
\set CSH  '00000000-0000-0000-0000-0000002c7107'
\set bizB '00000000-0000-0000-0000-0000002c7201'
\set OB   '00000000-0000-0000-0000-0000002c7209'
\set ACCA '00000000-0000-0000-0000-0000002c7301'
\set ACCB '00000000-0000-0000-0000-0000002c7302'
\set ORDA '00000000-0000-0000-0000-0000002c7401'
\set ORDB '00000000-0000-0000-0000-0000002c7402'
\set CUST '00000000-0000-0000-0000-0000002c7501'
\set CAJA '00000000-0000-0000-0000-0000002c7601'
\set AMB  '00000000-0000-0000-0000-0000002c7701'
\set OPB  '00000000-0000-0000-0000-0000002c7702'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'OA'),(:'ADM'),(:'CSH'),(:'OB');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'bizA','6C A',:'OA'),(:'bizB','6C B',:'OB');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES
  (:'bizA',:'OA','owner',true),(:'bizA',:'ADM','admin',true),(:'bizA',:'CSH','cashier',true),(:'bizB',:'OB','owner',true);
INSERT INTO customers(id,business_id,name,phone) VALUES (:'CUST',:'bizA','Cliente A','111');
INSERT INTO accounts(id,business_id,type,entity_id,entity_name) VALUES (:'ACCA',:'bizA','cliente',:'CUST','Cliente A'),(:'ACCB',:'bizB','cliente',:'OB','Cliente B');
-- deuda: venta 5000 en ACCA (bizA) y 3000 en ACCB (bizB)
INSERT INTO account_movements(id,business_id,account_id,date,type,description,debit,credit,balance_after)
  VALUES (:'AMB',:'bizB',:'ACCB','2026-07-01','venta','deuda B',3000,0,3000),
         ('00000000-0000-0000-0000-0000002c77a1',:'bizA',:'ACCA','2026-07-01','venta','deuda A',5000,0,5000);
INSERT INTO orders(id,business_id,customer_id,total_cost,status) VALUES (:'ORDA',:'bizA',:'CUST',10000,'completed'),(:'ORDB',:'bizB',NULL,5000,'completed');
INSERT INTO order_payments(id,business_id,order_id,amount,amount_ars,payment_method) VALUES (:'OPB',:'bizB',:'ORDB',100,100,'cash');
INSERT INTO cajas(id,business_id,opened_by,status) VALUES (:'CAJA',:'bizA',:'OA','abierta');
SET LOCAL session_replication_role='origin';

DO $$ DECLARE v_p1 date := date_trunc('month', public.ar_today() - interval '1 month')::date;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002c7109';
  PERFORM close_period('00000000-0000-0000-0000-0000002c7101'::uuid, v_p1, 'setup 6C'); RESET ROLE;
END $$;

-- ============ record_customer_account_payment_atomic ========================
DO $$
DECLARE r jsonb; v_cur date := public.ar_today();
  v_p1 date := date_trunc('month', public.ar_today() - interval '1 month')::date;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002c7109';  -- OA
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7301'::uuid,1000,'cobro','00000000-0000-0000-0000-0000002c7109'::uuid,'transferencia',v_cur,NULL,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'CC1 periodo abierto -> ok ('||COALESCE(r->>'error','')||')');
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7301'::uuid,500,'cobro','00000000-0000-0000-0000-0000002c7109'::uuid,'transferencia',v_p1+10,NULL,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='PERIOD_CLOSED', 'CC2 periodo cerrado -> PERIOD_CLOSED');
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7301'::uuid,700,'cobro null','00000000-0000-0000-0000-0000002c7109'::uuid,'transferencia',NULL,NULL,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'CC3 fecha nula -> ok');
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-000000999999'::uuid,100,'x','00000000-0000-0000-0000-0000002c7109'::uuid,'transferencia',v_cur,NULL,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='ACCOUNT_NOT_FOUND', 'CC7 cuenta inexistente -> ACCOUNT_NOT_FOUND');
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7301'::uuid,0,'x','00000000-0000-0000-0000-0000002c7109'::uuid,'transferencia',v_cur,NULL,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'CC8 monto<=0 -> VALIDATION_ERROR');
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7301'::uuid,99999,'x','00000000-0000-0000-0000-0000002c7109'::uuid,'transferencia',v_cur,NULL,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='OVERPAYMENT', 'CC9 cobro > deuda -> OVERPAYMENT');
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002c7209';  -- OB
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7301'::uuid,100,'x','00000000-0000-0000-0000-0000002c7209'::uuid,'transferencia',v_cur,NULL,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='FORBIDDEN', 'CC5 cross-tenant -> FORBIDDEN');
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002c7107';  -- cashier
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7301'::uuid,50,'x','00000000-0000-0000-0000-0000002c7107'::uuid,'transferencia',v_cur,NULL,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'CC6 cashier (miembro) -> ok');
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002c7109';  -- OA
  PERFORM record_customer_account_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7301'::uuid,123,'idem','00000000-0000-0000-0000-0000002c7109'::uuid,'transferencia',v_cur,NULL,'CCK');
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7301'::uuid,123,'idem','00000000-0000-0000-0000-0000002c7109'::uuid,'transferencia',v_cur,NULL,'CCK');
  PERFORM pg_temp.assert((r->>'replay')::boolean, 'CC11 replay mismo key+payload');
  PERFORM record_customer_account_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7301'::uuid,10,'idem','00000000-0000-0000-0000-0000002c7109'::uuid,'transferencia',v_cur,NULL,'CCK2');
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7301'::uuid,20,'idem','00000000-0000-0000-0000-0000002c7109'::uuid,'transferencia',v_cur,NULL,'CCK2');
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT' AND r->>'error'='IDEMPOTENCY_CONFLICT', 'CC12 conflict + error compat frontend');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT date FROM account_movements WHERE business_id=:'bizA' AND credit=700)=public.ar_today(), 'CC3b account_movements.date = ar_today()');
SELECT pg_temp.assert((SELECT fm.date FROM account_movements am JOIN financial_movements fm ON fm.reference_id=am.id WHERE am.business_id=:'bizA' AND am.credit=700)=public.ar_today(), 'CC3c FM.date = ar_today()');
SELECT pg_temp.assert(
  (SELECT a.economic_date FROM account_movements am JOIN finance_audit_log a ON a.entity_id=am.id AND a.action='customer_account_payment' WHERE am.business_id=:'bizA' AND am.credit=700)
  = (SELECT date FROM account_movements WHERE business_id=:'bizA' AND credit=700), 'CC4 fecha auditada = persistida');
SELECT pg_temp.assert((SELECT count(*) FROM account_movements am JOIN finance_audit_log a ON a.entity_id=am.id AND a.action='customer_account_payment' WHERE am.business_id=:'bizA' AND am.credit=700)=1, 'CC13 exactamente un evento');
SELECT pg_temp.assert((SELECT (a.new_data->>'prev_debt')::numeric FROM account_movements am JOIN finance_audit_log a ON a.entity_id=am.id WHERE am.business_id=:'bizA' AND am.credit=700 LIMIT 1) IS NOT NULL, 'CC13b saldo (prev/new) canonico en el evento');
SELECT pg_temp.assert((SELECT count(*) FROM account_movements WHERE business_id=:'bizA' AND credit=123)=1, 'CC11b replay NO duplica movimiento');
SELECT pg_temp.assert((SELECT count(*) FROM finance_audit_log WHERE request_id='CCK' AND action='customer_account_payment')=1, 'CC11c replay NO duplica auditoria');

-- ============ AUDIT SCOPE E2 -- tres casos ==================================
-- (1) escritura DIRECTA no gestionada -> backstop registra
DO $$
DECLARE n0 int; n1 int;
BEGIN
  PERFORM set_config('m7.audit_managed','0',true);
  SELECT count(*) INTO n0 FROM finance_audit_log WHERE source_rpc='trigger_backstop' AND entity_table='account_movements';
  INSERT INTO account_movements(business_id,account_id,date,type,description,debit,credit,balance_after,reference_type,created_by)
    VALUES ('00000000-0000-0000-0000-0000002c7101','00000000-0000-0000-0000-0000002c7301','2026-07-10','pago','directo',0,10,0,'manual','00000000-0000-0000-0000-0000002c7109');
  SELECT count(*) INTO n1 FROM finance_audit_log WHERE source_rpc='trigger_backstop' AND entity_table='account_movements';
  PERFORM pg_temp.assert(n1 = n0 + 1, 'SC1 escritura directa en account_movements -> backstop registra 1');
END $$;
-- (2) RPC gestionada -> 0 backstop + 1 evento explicito
DO $$
DECLARE nb0 int; nb1 int; ne0 int; ne1 int;
BEGIN
  PERFORM set_config('m7.audit_managed','0',true);
  SELECT count(*) INTO nb0 FROM finance_audit_log WHERE source_rpc='trigger_backstop' AND entity_table='account_movements';
  SELECT count(*) INTO ne0 FROM finance_audit_log WHERE action='customer_account_payment';
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002c7109';
  PERFORM record_customer_account_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7301'::uuid,33,'scope','00000000-0000-0000-0000-0000002c7109'::uuid,'transferencia',public.ar_today(),NULL,NULL);
  RESET ROLE;
  SELECT count(*) INTO nb1 FROM finance_audit_log WHERE source_rpc='trigger_backstop' AND entity_table='account_movements';
  SELECT count(*) INTO ne1 FROM finance_audit_log WHERE action='customer_account_payment';
  PERFORM pg_temp.assert(nb1 = nb0, 'SC2a RPC gestionada -> 0 backstop sobre account_movements');
  PERFORM pg_temp.assert(ne1 = ne0 + 1, 'SC2b RPC gestionada -> exactamente 1 evento explicito');
END $$;
-- (3) RPC gestionada con fallo del log final -> 0 escrituras y 0 eventos
ALTER TABLE finance_audit_log ADD CONSTRAINT tmp_fail_cc CHECK (action <> 'customer_account_payment') NOT VALID;
DO $$
DECLARE r jsonb; n_am int;
BEGIN
  SELECT count(*) INTO n_am FROM account_movements WHERE business_id='00000000-0000-0000-0000-0000002c7101' AND credit=44;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002c7109';
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7301'::uuid,44,'audit fail','00000000-0000-0000-0000-0000002c7109'::uuid,'transferencia',public.ar_today(),NULL,NULL);
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE AND r->>'error_code'='AUDIT_FAILED', 'SC3a fallo del log -> AUDIT_FAILED');
  PERFORM pg_temp.assert((SELECT count(*) FROM account_movements WHERE business_id='00000000-0000-0000-0000-0000002c7101' AND credit=44)=n_am, 'SC3b 0 escrituras (rollback total)');
END $$;
SELECT pg_temp.assert((SELECT count(*) FROM finance_audit_log WHERE business_id=:'bizA' AND (new_data->>'amount')='44')=0, 'SC3c 0 eventos');
ALTER TABLE finance_audit_log DROP CONSTRAINT tmp_fail_cc;

-- ============ create_order_payment_atomic ===================================
DO $$
DECLARE r jsonb; v_cur date := public.ar_today();
  v_p1 date := date_trunc('month', public.ar_today() - interval '1 month')::date;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002c7109';  -- OA
  r := create_order_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7401'::uuid,2000,'transfer','ARS',1,'00000000-0000-0000-0000-0000002c7109'::uuid,NULL,v_cur,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'OP1 periodo abierto -> ok ('||COALESCE(r->>'error','')||')');
  r := create_order_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7401'::uuid,500,'transfer','ARS',1,'00000000-0000-0000-0000-0000002c7109'::uuid,NULL,v_p1+10,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='PERIOD_CLOSED', 'OP2 periodo cerrado -> PERIOD_CLOSED');
  r := create_order_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7401'::uuid,700,'transfer','ARS',1,'00000000-0000-0000-0000-0000002c7109'::uuid,NULL,NULL,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'OP3 fecha nula -> ok');
  r := create_order_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-000000999999'::uuid,100,'transfer','ARS',1,'00000000-0000-0000-0000-0000002c7109'::uuid,NULL,v_cur,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='ORDER_NOT_FOUND', 'OP7 orden inexistente -> ORDER_NOT_FOUND');
  r := create_order_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7401'::uuid,0,'transfer','ARS',1,'00000000-0000-0000-0000-0000002c7109'::uuid,NULL,v_cur,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'OP8 monto<=0 -> VALIDATION_ERROR');
  r := create_order_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7401'::uuid,999999,'transfer','ARS',1,'00000000-0000-0000-0000-0000002c7109'::uuid,NULL,v_cur,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'OP9 sobrepago ACEPTADO (6C.1: sin nueva politica de OVERPAYMENT)');
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002c7209';  -- OB
  r := create_order_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7401'::uuid,100,'transfer','ARS',1,'00000000-0000-0000-0000-0000002c7209'::uuid,NULL,v_cur,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='FORBIDDEN', 'OP5 cross-tenant -> FORBIDDEN');
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002c7107';  -- cashier
  r := create_order_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7401'::uuid,60,'transfer','ARS',1,'00000000-0000-0000-0000-0000002c7107'::uuid,NULL,v_cur,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'OP6 cashier (miembro) -> ok');
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002c7209';  -- OB en bizB (sin caja)
  r := create_order_payment_atomic('00000000-0000-0000-0000-0000002c7201'::uuid,'00000000-0000-0000-0000-0000002c7402'::uuid,100,'cash','ARS',1,'00000000-0000-0000-0000-0000002c7209'::uuid,NULL,v_cur,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='CASH_REGISTER_NOT_OPEN', 'OP10 cash sin caja abierta -> CASH_REGISTER_NOT_OPEN');
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002c7109';  -- OA
  PERFORM create_order_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7401'::uuid,321,'transfer','ARS',1,'00000000-0000-0000-0000-0000002c7109'::uuid,NULL,v_cur,'OPK');
  r := create_order_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7401'::uuid,321,'transfer','ARS',1,'00000000-0000-0000-0000-0000002c7109'::uuid,NULL,v_cur,'OPK');
  PERFORM pg_temp.assert((r->>'replay')::boolean, 'OP11 replay mismo key+payload');
  PERFORM create_order_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7401'::uuid,15,'transfer','ARS',1,'00000000-0000-0000-0000-0000002c7109'::uuid,NULL,v_cur,'OPK2');
  r := create_order_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7401'::uuid,25,'transfer','ARS',1,'00000000-0000-0000-0000-0000002c7109'::uuid,NULL,v_cur,'OPK2');
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT', 'OP12 conflict -> IDEMPOTENCY_CONFLICT');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT payment_date FROM order_payments WHERE business_id=:'bizA' AND amount=700)=public.ar_today(), 'OP3b order_payments.payment_date = ar_today()');
SELECT pg_temp.assert((SELECT fm.date FROM order_payments op JOIN financial_movements fm ON fm.id=op.financial_movement_id WHERE op.business_id=:'bizA' AND op.amount=700)=public.ar_today(), 'OP3c FM.date = ar_today()');
SELECT pg_temp.assert(
  (SELECT a.economic_date FROM order_payments op JOIN finance_audit_log a ON a.entity_id=op.id AND a.action='order_payment' WHERE op.business_id=:'bizA' AND op.amount=700)
  = (SELECT payment_date FROM order_payments WHERE business_id=:'bizA' AND amount=700), 'OP4 fecha auditada = persistida');
SELECT pg_temp.assert((SELECT count(*) FROM order_payments op JOIN finance_audit_log a ON a.entity_id=op.id AND a.action='order_payment' WHERE op.business_id=:'bizA' AND op.amount=700)=1, 'OP13 exactamente un evento');
SELECT pg_temp.assert((SELECT count(*) FROM order_payments WHERE business_id=:'bizA' AND amount=321 AND reversed_at IS NULL)=1, 'OP11b replay NO duplica pago');

-- ============ 6C.1: sobrepago ACEPTADO (se preserva comportamiento previo) ===
DO $$
DECLARE r1 jsonb; r2 jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002c7109';  -- OA
  -- ORDA total_cost=10000, ya muy pagada; 20000 supera el saldo restante -> se ACEPTA
  r1 := create_order_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7401'::uuid,20000,'transfer','ARS',1,'00000000-0000-0000-0000-0000002c7109'::uuid,NULL,public.ar_today(),'OVK');
  PERFORM pg_temp.assert((r1->>'ok')::boolean AND (r1->>'replay')::boolean IS FALSE, 'OV1 pago > saldo restante ACEPTADO (comportamiento previo a M7)');
  r2 := create_order_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7401'::uuid,20000,'transfer','ARS',1,'00000000-0000-0000-0000-0000002c7109'::uuid,NULL,public.ar_today(),'OVK');
  PERFORM pg_temp.assert((r2->>'replay')::boolean, 'OV2 sobrepago sigue idempotente -> replay');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT count(*) FROM order_payments WHERE business_id=:'bizA' AND amount=20000 AND reversed_at IS NULL)=1, 'OV3 replay NO duplica el sobrepago');
SELECT pg_temp.assert((SELECT (a.new_data->>'amount')::numeric FROM order_payments op JOIN finance_audit_log a ON a.entity_id=op.id AND a.action='order_payment' WHERE op.business_id=:'bizA' AND op.amount=20000)=20000, 'OV4a auditoria registra el monto');
SELECT pg_temp.assert((SELECT (a.new_data->>'pending_after')::numeric FROM order_payments op JOIN finance_audit_log a ON a.entity_id=op.id AND a.action='order_payment' WHERE op.business_id=:'bizA' AND op.amount=20000) < 0, 'OV4b pending_after registrado (negativo, NO bloquea)');

ALTER TABLE finance_audit_log ADD CONSTRAINT tmp_fail_op CHECK (action <> 'order_payment') NOT VALID;
DO $$
DECLARE r jsonb; n int;
BEGIN
  SELECT count(*) INTO n FROM order_payments WHERE business_id='00000000-0000-0000-0000-0000002c7101' AND amount=888;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002c7109';
  r := create_order_payment_atomic('00000000-0000-0000-0000-0000002c7101'::uuid,'00000000-0000-0000-0000-0000002c7401'::uuid,888,'transfer','ARS',1,'00000000-0000-0000-0000-0000002c7109'::uuid,NULL,public.ar_today(),NULL);
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE AND r->>'error_code'='AUDIT_FAILED', 'OP14 auditoria rota -> AUDIT_FAILED');
  PERFORM pg_temp.assert((SELECT count(*) FROM order_payments WHERE business_id='00000000-0000-0000-0000-0000002c7101' AND amount=888)=n, 'OP15 rollback total (sin order_payment ni FM)');
END $$;
ALTER TABLE finance_audit_log DROP CONSTRAINT tmp_fail_op;

-- ============ request tables protegidas + cross-business ====================
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.account_payment_requests','SELECT'), 'RT1 authenticated NO SELECT account_payment_requests');
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.order_payment_requests','SELECT'), 'RT2 authenticated NO SELECT order_payment_requests');
SELECT pg_temp.assert(NOT has_table_privilege('service_role','public.account_payment_requests','UPDATE'), 'RT3 service_role NO UPDATE account_payment_requests');
SELECT pg_temp.assert(NOT has_table_privilege('service_role','public.order_payment_requests','DELETE'), 'RT4 service_role NO DELETE order_payment_requests');
DO $$
DECLARE v_id uuid; e text;
BEGIN
  INSERT INTO account_payment_requests(business_id,user_id,op,idempotency_key,request_hash)
    VALUES ('00000000-0000-0000-0000-0000002c7101','00000000-0000-0000-0000-0000002c7109','customer_account_payment','X1','h') RETURNING id INTO v_id;
  e:=''; BEGIN UPDATE account_payment_requests SET movement_id='00000000-0000-0000-0000-0000002c7701' WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%no pertenece al negocio%', 'RT5 account req: enlace a movimiento de OTRO negocio -> rechazado');
  e:=''; BEGIN DELETE FROM account_payment_requests WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e<>'', 'RT6 account req: DELETE prohibido');
  INSERT INTO order_payment_requests(business_id,user_id,op,idempotency_key,request_hash)
    VALUES ('00000000-0000-0000-0000-0000002c7101','00000000-0000-0000-0000-0000002c7109','order_payment','Y1','h') RETURNING id INTO v_id;
  e:=''; BEGIN UPDATE order_payment_requests SET order_payment_id='00000000-0000-0000-0000-0000002c7702' WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%no pertenece al negocio%', 'RT7 order req: enlace a pago de OTRO negocio -> rechazado');
END $$;

ROLLBACK;
