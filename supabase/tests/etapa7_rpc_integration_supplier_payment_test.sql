-- ============================================================================
-- M7 Bloque 6D.2 -- pay_supplier_purchase_atomic / pay_supplier_free_atomic
-- Ownership, actor canonico, fecha del pago, guard de periodo, idempotencia,
-- serializacion del saldo (FOR UPDATE), caja para efectivo, auditoria, invariantes
-- contables (paga pasivo: sin COGS, sin gasto operativo, BFE supplier_liability_payment),
-- contrato de error, rollback. Concurrencia por saldo: harness aparte.
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set bizA '00000000-0000-0000-0000-0000002e7101'
\set OA   '00000000-0000-0000-0000-0000002e7109'
\set ADM  '00000000-0000-0000-0000-0000002e7108'
\set CSH  '00000000-0000-0000-0000-0000002e7107'
\set bizB '00000000-0000-0000-0000-0000002e7201'
\set OB   '00000000-0000-0000-0000-0000002e7209'
\set SUPA '00000000-0000-0000-0000-0000002e7301'
\set SUPB '00000000-0000-0000-0000-0000002e7302'
\set PURA '00000000-0000-0000-0000-0000002e7401'
\set PCL  '00000000-0000-0000-0000-0000002e7402'
\set PPD  '00000000-0000-0000-0000-0000002e7403'
\set PURB '00000000-0000-0000-0000-0000002e7404'
\set CAJA '00000000-0000-0000-0000-0000002e7601'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'OA'),(:'ADM'),(:'CSH'),(:'OB');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'bizA','6D2 A',:'OA'),(:'bizB','6D2 B',:'OB');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES
  (:'bizA',:'OA','owner',true),(:'bizA',:'ADM','admin',true),(:'bizA',:'CSH','cashier',true),(:'bizB',:'OB','owner',true);
INSERT INTO suppliers(id,business_id,name) VALUES (:'SUPA',:'bizA','Prov A'),(:'SUPB',:'bizB','Prov B');
-- compras: PURA abierta (total 10000), PCL creada en periodo cerrado, PPD ya pagada, PURB de bizB
INSERT INTO supplier_purchases(id,business_id,supplier_id,total_amount,paid_amount,pending_amount,payment_status,purchase_date) VALUES
  (:'PURA',:'bizA',:'SUPA',10000,0,10000,'pending',public.ar_today()),
  (:'PCL', :'bizA',:'SUPA',5000,0,5000,'pending', date_trunc('month', public.ar_today() - interval '1 month')::date + 10),
  (:'PPD', :'bizA',:'SUPA',1000,1000,0,'paid',public.ar_today()),
  (:'PURB',:'bizB',:'SUPB',3000,0,3000,'pending',public.ar_today());
-- PPD ya pagada: su saldo se recalcula desde pagos vivos, asi que necesita un pago real
INSERT INTO supplier_payments(id,business_id,supplier_id,purchase_id,payment_date,amount,payment_method)
  VALUES ('00000000-0000-0000-0000-0000002e7501',:'bizA',:'SUPA',:'PPD',public.ar_today(),1000,'efectivo');
INSERT INTO cajas(id,business_id,opened_by,status) VALUES (:'CAJA',:'bizA',:'OA','abierta');
SET LOCAL session_replication_role='origin';

DO $$ DECLARE v_p1 date := date_trunc('month', public.ar_today() - interval '1 month')::date;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002e7109';
  PERFORM close_period('00000000-0000-0000-0000-0000002e7101'::uuid, v_p1, 'setup 6D2'); RESET ROLE;
END $$;

-- ============ pay_supplier_purchase_atomic ==================================
DO $$
DECLARE r jsonb; v_cur date := public.ar_today();
  v_p1 date := date_trunc('month', public.ar_today() - interval '1 month')::date;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002e7109';  -- OA
  -- PP1 periodo abierto (paga 2000 de PURA)
  r := pay_supplier_purchase_atomic('00000000-0000-0000-0000-0000002e7101'::uuid,'00000000-0000-0000-0000-0000002e7301'::uuid,'00000000-0000-0000-0000-0000002e7108'::uuid,'Prov A','00000000-0000-0000-0000-0000002e7401'::uuid,v_cur,2000,'efectivo','',NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean AND r->>'new_status'='partial', 'PP1 periodo abierto -> ok, partial ('||COALESCE(r->>'error','')||')');
  -- PP2 periodo cerrado bloquea el pago nuevo
  r := pay_supplier_purchase_atomic('00000000-0000-0000-0000-0000002e7101'::uuid,'00000000-0000-0000-0000-0000002e7301'::uuid,NULL,'Prov A','00000000-0000-0000-0000-0000002e7401'::uuid,v_p1+5,100,'efectivo','',NULL);
  PERFORM pg_temp.assert(r->>'error_code'='PERIOD_CLOSED', 'PP2 pago con fecha en periodo cerrado -> PERIOD_CLOSED');
  -- PP3 compra creada en periodo cerrado + pago HOY (abierto) permite (valida periodo del pago)
  r := pay_supplier_purchase_atomic('00000000-0000-0000-0000-0000002e7101'::uuid,'00000000-0000-0000-0000-0000002e7301'::uuid,NULL,'Prov A','00000000-0000-0000-0000-0000002e7402'::uuid,v_cur,500,'efectivo','',NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'PP3 compra de periodo cerrado, pago hoy -> permitido');
  -- PP8 compra inexistente
  r := pay_supplier_purchase_atomic('00000000-0000-0000-0000-0000002e7101'::uuid,'00000000-0000-0000-0000-0000002e7301'::uuid,NULL,'Prov A','00000000-0000-0000-0000-000000999999'::uuid,v_cur,100,'efectivo','',NULL);
  PERFORM pg_temp.assert(r->>'error_code'='PURCHASE_NOT_FOUND', 'PP8 compra inexistente -> PURCHASE_NOT_FOUND');
  -- PP12 sobrepago
  r := pay_supplier_purchase_atomic('00000000-0000-0000-0000-0000002e7101'::uuid,'00000000-0000-0000-0000-0000002e7301'::uuid,NULL,'Prov A','00000000-0000-0000-0000-0000002e7401'::uuid,v_cur,999999,'efectivo','',NULL);
  PERFORM pg_temp.assert(r->>'error_code'='OVERPAYMENT', 'PP12 sobrepago -> OVERPAYMENT (politica M6 preservada)');
  -- PP13 compra ya pagada
  r := pay_supplier_purchase_atomic('00000000-0000-0000-0000-0000002e7101'::uuid,'00000000-0000-0000-0000-0000002e7301'::uuid,NULL,'Prov A','00000000-0000-0000-0000-0000002e7403'::uuid,v_cur,100,'efectivo','',NULL);
  PERFORM pg_temp.assert(r->>'error_code'='OVERPAYMENT', 'PP13 compra ya pagada -> OVERPAYMENT');
  RESET ROLE;
  -- PP7 cross-tenant
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002e7209';  -- OB
  r := pay_supplier_purchase_atomic('00000000-0000-0000-0000-0000002e7101'::uuid,'00000000-0000-0000-0000-0000002e7301'::uuid,NULL,'Prov A','00000000-0000-0000-0000-0000002e7401'::uuid,v_cur,100,'efectivo','',NULL);
  PERFORM pg_temp.assert(r->>'error_code'='FORBIDDEN', 'PP7 cross-tenant -> FORBIDDEN');
  -- PP9 efectivo sin caja (bizB purchase)
  r := pay_supplier_purchase_atomic('00000000-0000-0000-0000-0000002e7201'::uuid,'00000000-0000-0000-0000-0000002e7302'::uuid,NULL,'Prov B','00000000-0000-0000-0000-0000002e7404'::uuid,v_cur,100,'efectivo','',NULL);
  PERFORM pg_temp.assert(r->>'error_code'='CASH_REGISTER_NOT_OPEN', 'PP9 efectivo sin caja -> CASH_REGISTER_NOT_OPEN');
  -- PP11 transferencia sin caja (bizB) -> permitido
  r := pay_supplier_purchase_atomic('00000000-0000-0000-0000-0000002e7201'::uuid,'00000000-0000-0000-0000-0000002e7302'::uuid,NULL,'Prov B','00000000-0000-0000-0000-0000002e7404'::uuid,v_cur,300,'transferencia','',NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'PP11 transferencia sin caja -> permitida');
  RESET ROLE;
  -- roles miembros
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002e7107';  -- cashier
  r := pay_supplier_purchase_atomic('00000000-0000-0000-0000-0000002e7101'::uuid,'00000000-0000-0000-0000-0000002e7301'::uuid,NULL,'Prov A','00000000-0000-0000-0000-0000002e7401'::uuid,v_cur,50,'transferencia','',NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'PP-role cashier (miembro) -> ok');
  RESET ROLE;
  -- idempotencia
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002e7109';  -- OA
  PERFORM pay_supplier_purchase_atomic('00000000-0000-0000-0000-0000002e7101'::uuid,'00000000-0000-0000-0000-0000002e7301'::uuid,NULL,'Prov A','00000000-0000-0000-0000-0000002e7401'::uuid,v_cur,123,'transferencia','idem','PPK');
  r := pay_supplier_purchase_atomic('00000000-0000-0000-0000-0000002e7101'::uuid,'00000000-0000-0000-0000-0000002e7301'::uuid,NULL,'Prov A','00000000-0000-0000-0000-0000002e7401'::uuid,v_cur,123,'transferencia','idem','PPK');
  PERFORM pg_temp.assert((r->>'replay')::boolean, 'PP14 replay mismo key+payload');
  r := pay_supplier_purchase_atomic('00000000-0000-0000-0000-0000002e7101'::uuid,'00000000-0000-0000-0000-0000002e7301'::uuid,NULL,'Prov A','00000000-0000-0000-0000-0000002e7401'::uuid,v_cur,124,'transferencia','idem','PPK');
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT' AND r->>'error'='IDEMPOTENCY_CONFLICT', 'PP15 conflict + error compat frontend');
  RESET ROLE;
END $$;
-- PP4/PP5 fecha (PP3 pago 500 sobre PCL, fecha hoy)
SELECT pg_temp.assert((SELECT payment_date FROM supplier_payments WHERE business_id=:'bizA' AND amount=500)=public.ar_today(), 'PP4 supplier_payments.payment_date = ar_today()');
SELECT pg_temp.assert((SELECT movement_date FROM supplier_account_movements WHERE business_id=:'bizA' AND credit=500 AND type='payment')=public.ar_today(), 'PP5a supplier_account_movements.movement_date = ar_today()');
SELECT pg_temp.assert((SELECT fm.date FROM supplier_payments sp JOIN financial_movements fm ON fm.id=sp.financial_movement_id WHERE sp.business_id=:'bizA' AND sp.amount=500)=public.ar_today(), 'PP5b FM.date = ar_today()');
SELECT pg_temp.assert(
  (SELECT a.economic_date FROM supplier_payments sp JOIN finance_audit_log a ON a.entity_id=sp.id AND a.action='supplier_payment' WHERE sp.business_id=:'bizA' AND sp.amount=500)=public.ar_today(), 'PP5c fecha auditada = persistida');
-- PP6 actor = auth.uid (OA), aunque se paso ADM como p_user_id en PP1 (amount 2000)
SELECT pg_temp.assert((SELECT created_by FROM supplier_payments WHERE business_id=:'bizA' AND amount=2000)=:'OA', 'PP6a supplier_payments.created_by = auth.uid (OA, no ADM)');
SELECT pg_temp.assert((SELECT actor_user_id FROM finance_audit_log WHERE business_id=:'bizA' AND action='supplier_payment' AND (new_data->>'amount')='2000')=:'OA', 'PP6b audit actor = OA');
-- PP16 un solo FM/BFE/account_movement por pago (amount 2000)
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'bizA' AND reference_id=:'PURA' AND amount=2000)=1, 'PP16a 1 FM');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'bizA' AND source='pago_proveedor' AND amount_ars=2000)=1, 'PP16b 1 BFE');
SELECT pg_temp.assert((SELECT count(*) FROM supplier_account_movements WHERE purchase_id=:'PURA' AND credit=2000 AND type='payment')=1, 'PP16c 1 account_movement credito');
-- PP17 P&L no cambia: BFE del pago clase supplier_liability_payment; sin mercaderia/COGS
SELECT pg_temp.assert((SELECT economic_class FROM business_finance_entries WHERE business_id=:'bizA' AND source='pago_proveedor' AND amount_ars=2000)='supplier_liability_payment', 'PP17a BFE economic_class = supplier_liability_payment (fuera del P&L)');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'bizA' AND category='mercaderia' AND amount_ars=2000)=0, 'PP17b sin COGS/mercaderia');
-- PP18 saldo/estado final: PURA total 10000, pagos vivos = 2000+50+123 = 2173 -> pending 7827, partial
SELECT pg_temp.assert((SELECT pending_amount FROM supplier_purchases WHERE id=:'PURA')=(SELECT 10000 - COALESCE(SUM(amount),0) FROM supplier_payments WHERE purchase_id=:'PURA'), 'PP18a pending = total - sum(pagos)');
SELECT pg_temp.assert((SELECT payment_status FROM supplier_purchases WHERE id=:'PURA')='partial', 'PP18b status = partial');
-- PP14b replay no duplica
SELECT pg_temp.assert((SELECT count(*) FROM supplier_payments WHERE purchase_id=:'PURA' AND amount=123)=1, 'PP14b replay NO duplica pago');
SELECT pg_temp.assert((SELECT (new_data->>'prev_pending')::numeric > (new_data->>'new_pending')::numeric FROM finance_audit_log WHERE business_id=:'bizA' AND action='supplier_payment' AND (new_data->>'amount')='2000'), 'PP-AU prev_pending > new_pending en auditoria');

-- PP19 rollback si falla auditoria
ALTER TABLE finance_audit_log ADD CONSTRAINT tmp_fail_pp CHECK (action <> 'supplier_payment') NOT VALID;
DO $$
DECLARE r jsonb; n_pay int; n_paid numeric;
BEGIN
  SELECT count(*) INTO n_pay FROM supplier_payments WHERE purchase_id='00000000-0000-0000-0000-0000002e7401' AND amount=333;
  SELECT paid_amount INTO n_paid FROM supplier_purchases WHERE id='00000000-0000-0000-0000-0000002e7401';
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002e7109';
  r := pay_supplier_purchase_atomic('00000000-0000-0000-0000-0000002e7101'::uuid,'00000000-0000-0000-0000-0000002e7301'::uuid,NULL,'Prov A','00000000-0000-0000-0000-0000002e7401'::uuid,public.ar_today(),333,'transferencia','',NULL);
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE AND r->>'error_code'='AUDIT_FAILED', 'PP19a auditoria rota -> AUDIT_FAILED');
  PERFORM pg_temp.assert((SELECT count(*) FROM supplier_payments WHERE purchase_id='00000000-0000-0000-0000-0000002e7401' AND amount=333)=n_pay, 'PP19b sin pago nuevo (rollback)');
  PERFORM pg_temp.assert((SELECT paid_amount FROM supplier_purchases WHERE id='00000000-0000-0000-0000-0000002e7401')=n_paid, 'PP19c paid_amount sin cambios (rollback)');
END $$;
ALTER TABLE finance_audit_log DROP CONSTRAINT tmp_fail_pp;

-- ============ pay_supplier_free_atomic ======================================
DO $$
DECLARE r jsonb; v_cur date := public.ar_today();
  v_p1 date := date_trunc('month', public.ar_today() - interval '1 month')::date;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002e7109';  -- OA
  -- PF1 periodo abierto, efectivo con caja
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000002e7101'::uuid,'00000000-0000-0000-0000-0000002e7301'::uuid,'00000000-0000-0000-0000-0000002e7108'::uuid,'Prov A',v_cur,4000,'efectivo','libre',NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'PF1 efectivo con caja -> ok ('||COALESCE(r->>'error','')||')');
  -- PF2 periodo cerrado
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000002e7101'::uuid,'00000000-0000-0000-0000-0000002e7301'::uuid,NULL,'Prov A',v_p1+5,100,'efectivo','',NULL);
  PERFORM pg_temp.assert(r->>'error_code'='PERIOD_CLOSED', 'PF2 periodo cerrado -> PERIOD_CLOSED');
  -- PF3 fecha NULL
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000002e7101'::uuid,'00000000-0000-0000-0000-0000002e7301'::uuid,NULL,'Prov A',NULL,600,'transferencia','',NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'PF3 fecha nula -> ok');
  -- PF5 proveedor inexistente
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000002e7101'::uuid,'00000000-0000-0000-0000-000000999999'::uuid,NULL,'X',v_cur,100,'efectivo','',NULL);
  PERFORM pg_temp.assert(r->>'error_code'='SUPPLIER_NOT_FOUND', 'PF5 proveedor inexistente -> SUPPLIER_NOT_FOUND');
  RESET ROLE;
  -- PF4 cross-tenant
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002e7209';  -- OB
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000002e7101'::uuid,'00000000-0000-0000-0000-0000002e7301'::uuid,NULL,'Prov A',v_cur,100,'efectivo','',NULL);
  PERFORM pg_temp.assert(r->>'error_code'='FORBIDDEN', 'PF4 cross-tenant -> FORBIDDEN');
  -- PF6 efectivo sin caja (bizB)
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000002e7201'::uuid,'00000000-0000-0000-0000-0000002e7302'::uuid,NULL,'Prov B',v_cur,100,'efectivo','',NULL);
  PERFORM pg_temp.assert(r->>'error_code'='CASH_REGISTER_NOT_OPEN', 'PF6 efectivo sin caja -> CASH_REGISTER_NOT_OPEN');
  -- PF8 transferencia sin caja (bizB) -> ok
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000002e7201'::uuid,'00000000-0000-0000-0000-0000002e7302'::uuid,NULL,'Prov B',v_cur,200,'transferencia','',NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'PF8 transferencia sin caja -> ok');
  RESET ROLE;
  -- idempotencia
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002e7109';  -- OA
  PERFORM pay_supplier_free_atomic('00000000-0000-0000-0000-0000002e7101'::uuid,'00000000-0000-0000-0000-0000002e7301'::uuid,NULL,'Prov A',v_cur,777,'transferencia','idem','PFK');
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000002e7101'::uuid,'00000000-0000-0000-0000-0000002e7301'::uuid,NULL,'Prov A',v_cur,777,'transferencia','idem','PFK');
  PERFORM pg_temp.assert((r->>'replay')::boolean, 'PF9 replay mismo key+payload');
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000002e7101'::uuid,'00000000-0000-0000-0000-0000002e7301'::uuid,NULL,'Prov A',v_cur,888,'transferencia','idem','PFK');
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT', 'PF9b conflict');
  RESET ROLE;
END $$;
-- PF7 FM efectivo con caja fijada + metodo (fix gap M6) ; PF10 actor ; PF11 un solo mov ; PF13 sin compra
SELECT pg_temp.assert((SELECT caja_id FROM financial_movements WHERE business_id=:'bizA' AND amount=4000 AND source='pago_proveedor')=:'CAJA', 'PF7a FM.caja_id = caja validada');
SELECT pg_temp.assert((SELECT metodo_pago FROM financial_movements WHERE business_id=:'bizA' AND amount=4000 AND source='pago_proveedor')='efectivo', 'PF7b FM.metodo_pago = efectivo (fix gap M6)');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'bizA' AND source='pago_proveedor' AND metodo_pago='efectivo' AND caja_id IS NULL)=0, 'PF7c 0 FM efectivo con caja_id NULL');
SELECT pg_temp.assert((SELECT created_by FROM supplier_payments WHERE business_id=:'bizA' AND amount=4000)=:'OA', 'PF10 supplier_payments.created_by = auth.uid (OA)');
SELECT pg_temp.assert((SELECT count(*) FROM supplier_payments WHERE business_id=:'bizA' AND amount=4000)=1 AND (SELECT count(*) FROM supplier_account_movements WHERE business_id=:'bizA' AND credit=4000)=1, 'PF11 un pago + un account_movement');
SELECT pg_temp.assert((SELECT purchase_id FROM supplier_payments WHERE business_id=:'bizA' AND amount=4000) IS NULL
                  AND (SELECT purchase_id FROM supplier_account_movements WHERE business_id=:'bizA' AND credit=4000) IS NULL, 'PF13 pago libre sin compra (purchase_id NULL)');
SELECT pg_temp.assert((SELECT economic_class FROM business_finance_entries WHERE business_id=:'bizA' AND source='pago_proveedor' AND amount_ars=4000)='supplier_liability_payment', 'PF12 P&L: BFE clase supplier_liability_payment');
-- PF14 no payment sin account_movement (todo pago libre tiene su movimiento)
SELECT pg_temp.assert((SELECT count(*) FROM supplier_payments sp WHERE sp.business_id=:'bizA' AND sp.purchase_id IS NULL AND NOT EXISTS (SELECT 1 FROM supplier_account_movements am WHERE am.payment_id=sp.id))=0, 'PF14 ningun pago libre sin account_movement');

-- PF15 rollback si falla auditoria
ALTER TABLE finance_audit_log ADD CONSTRAINT tmp_fail_pf CHECK (action <> 'supplier_free_payment') NOT VALID;
DO $$
DECLARE r jsonb; n int;
BEGIN
  SELECT count(*) INTO n FROM supplier_payments WHERE business_id='00000000-0000-0000-0000-0000002e7101' AND amount=1717;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002e7109';
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000002e7101'::uuid,'00000000-0000-0000-0000-0000002e7301'::uuid,NULL,'Prov A',public.ar_today(),1717,'transferencia','',NULL);
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE AND r->>'error_code'='AUDIT_FAILED', 'PF15a auditoria rota -> AUDIT_FAILED');
  PERFORM pg_temp.assert((SELECT count(*) FROM supplier_payments WHERE business_id='00000000-0000-0000-0000-0000002e7101' AND amount=1717)=n, 'PF15b rollback total (sin pago ni account_movement)');
END $$;
ALTER TABLE finance_audit_log DROP CONSTRAINT tmp_fail_pf;

-- ============ Request tables protegidas + cross-business ====================
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.supplier_purchase_payment_requests','SELECT'), 'RT1 authenticated NO SELECT supplier_purchase_payment_requests');
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.supplier_free_payment_requests','SELECT'), 'RT2 authenticated NO SELECT supplier_free_payment_requests');
SELECT pg_temp.assert(NOT has_table_privilege('service_role','public.supplier_purchase_payment_requests','UPDATE'), 'RT3 service_role NO UPDATE');
SELECT pg_temp.assert(NOT has_table_privilege('service_role','public.supplier_free_payment_requests','DELETE'), 'RT4 service_role NO DELETE');
DO $$
DECLARE v_id uuid; v_pb uuid; e text;
BEGIN
  -- pago de bizB para intentar enlace cross-business
  SELECT id INTO v_pb FROM supplier_payments WHERE business_id='00000000-0000-0000-0000-0000002e7201' LIMIT 1;
  INSERT INTO supplier_purchase_payment_requests(business_id,user_id,op,idempotency_key,request_hash)
    VALUES ('00000000-0000-0000-0000-0000002e7101','00000000-0000-0000-0000-0000002e7109','supplier_payment','Z1','h') RETURNING id INTO v_id;
  e:=''; BEGIN UPDATE supplier_purchase_payment_requests SET supplier_payment_id=v_pb WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%no pertenece al negocio%', 'RT5 enlace a pago de OTRO negocio -> rechazado');
  e:=''; BEGIN DELETE FROM supplier_purchase_payment_requests WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e<>'', 'RT6 DELETE prohibido');
END $$;

ROLLBACK;
