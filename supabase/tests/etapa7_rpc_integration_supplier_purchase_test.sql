-- ============================================================================
-- M7 Bloque 6D.1 -- create_supplier_purchase_atomic
-- Ownership real, guard de periodo, fecha canonica, idempotencia endurecida,
-- auditoria explicita, contrato de error, invariantes contables M3-M6 (contado/
-- credito/parcial), sin duplicar FM/BFE/stock/deuda, rollback total.
-- RUN: docker cp && psql -X -f  (una tx + ROLLBACK). Concurrencia: harness aparte.
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set bizA '00000000-0000-0000-0000-0000002d7101'
\set OA   '00000000-0000-0000-0000-0000002d7109'
\set ADM  '00000000-0000-0000-0000-0000002d7108'
\set CSH  '00000000-0000-0000-0000-0000002d7107'
\set bizB '00000000-0000-0000-0000-0000002d7201'
\set OB   '00000000-0000-0000-0000-0000002d7209'
\set SUPA '00000000-0000-0000-0000-0000002d7301'
\set SUPB '00000000-0000-0000-0000-0000002d7302'
\set IA1  '00000000-0000-0000-0000-0000002d7401'
\set IA2  '00000000-0000-0000-0000-0000002d7402'
\set IB   '00000000-0000-0000-0000-0000002d7403'
\set CAJA '00000000-0000-0000-0000-0000002d7601'
\set PURB '00000000-0000-0000-0000-0000002d7701'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'OA'),(:'ADM'),(:'CSH'),(:'OB');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'bizA','6D A',:'OA'),(:'bizB','6D B',:'OB');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES
  (:'bizA',:'OA','owner',true),(:'bizA',:'ADM','admin',true),(:'bizA',:'CSH','cashier',true),(:'bizB',:'OB','owner',true);
INSERT INTO suppliers(id,business_id,name) VALUES (:'SUPA',:'bizA','Prov A'),(:'SUPB',:'bizB','Prov B');
INSERT INTO inventory(id,business_id,code,name,category,cost_price,sale_price,stock_quantity) VALUES
  (:'IA1',:'bizA','C-6D-A1','Prod A1','cat',100,200,10),
  (:'IA2',:'bizA','C-6D-A2','Prod A2','cat',100,200,10),
  (:'IB', :'bizB','C-6D-B1','Prod B','cat',100,200,10);
INSERT INTO supplier_purchases(id,business_id,supplier_id,total_amount) VALUES (:'PURB',:'bizB',:'SUPB',100);
INSERT INTO cajas(id,business_id,opened_by,status) VALUES (:'CAJA',:'bizA',:'OA','abierta');
SET LOCAL session_replication_role='origin';

DO $$ DECLARE v_p1 date := date_trunc('month', public.ar_today() - interval '1 month')::date;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002d7109';
  PERFORM close_period('00000000-0000-0000-0000-0000002d7101'::uuid, v_p1, 'setup 6D'); RESET ROLE;
END $$;

-- ============ Funcional + modos contado/credito/parcial =====================
DO $$
DECLARE r jsonb; v_cur date := public.ar_today();
  v_p1 date := date_trunc('month', public.ar_today() - interval '1 month')::date;
  it1 jsonb := jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-0000002d7401','product_name','Prod A1','quantity',2,'unit_cost',500));
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002d7109';  -- OA
  -- SP1 contado (paid=total)
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,'00000000-0000-0000-0000-0000002d7109'::uuid,'Prov A',v_cur,'F1',1000,1000,'efectivo','',it1,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'SP1 contado -> ok ('||COALESCE(r->>'error','')||')');
  -- SP2 credito (paid=0)
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,'00000000-0000-0000-0000-0000002d7109'::uuid,'Prov A',v_cur,'F2',2000,0,'efectivo','',it1,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'SP2 credito -> ok');
  -- SP3 parcial (0<paid<total)
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,'00000000-0000-0000-0000-0000002d7109'::uuid,'Prov A',v_cur,'F3',3000,1200,'transferencia','',it1,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'SP3 parcial -> ok');
  -- SP4 multiples productos
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,'00000000-0000-0000-0000-0000002d7109'::uuid,'Prov A',v_cur,'F4',4000,0,'efectivo','',
    jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-0000002d7401','product_name','Prod A1','quantity',1,'unit_cost',300),
                      jsonb_build_object('inventory_id','00000000-0000-0000-0000-0000002d7402','product_name','Prod A2','quantity',3,'unit_cost',100)),NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'SP4 multiples productos -> ok');
  -- SP5 producto sin inventory_id
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,'00000000-0000-0000-0000-0000002d7109'::uuid,'Prov A',v_cur,'F5',5000,0,'efectivo','',
    jsonb_build_array(jsonb_build_object('inventory_id',NULL,'product_name','Servicio suelto','quantity',1,'unit_cost',5000)),NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'SP5 producto sin inventory -> ok');
  -- SP15 fecha NULL -> ar_today
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,'00000000-0000-0000-0000-0000002d7109'::uuid,'Prov A',NULL,'F15',700,0,'efectivo','',it1,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'SP15 fecha nula -> ok');
  -- SP14 periodo cerrado
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,'00000000-0000-0000-0000-0000002d7109'::uuid,'Prov A',v_p1+10,'F14',900,0,'efectivo','',it1,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='PERIOD_CLOSED', 'SP14 periodo cerrado -> PERIOD_CLOSED');
  -- SP7 proveedor de otro negocio
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7302'::uuid,'00000000-0000-0000-0000-0000002d7109'::uuid,'Prov B',v_cur,'F7',100,0,'efectivo','',it1,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='SUPPLIER_NOT_FOUND', 'SP7 proveedor de otro negocio -> SUPPLIER_NOT_FOUND');
  -- SP8 producto de otro negocio
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,'00000000-0000-0000-0000-0000002d7109'::uuid,'Prov A',v_cur,'F8',100,0,'efectivo','',
    jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-0000002d7403','product_name','Prod B','quantity',1,'unit_cost',100)),NULL);
  PERFORM pg_temp.assert(r->>'error_code'='PRODUCT_NOT_FOUND', 'SP8 producto de otro negocio -> PRODUCT_NOT_FOUND');
  -- SP9 cantidad invalida
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,'00000000-0000-0000-0000-0000002d7109'::uuid,'Prov A',v_cur,'F9',100,0,'efectivo','',
    jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-0000002d7401','product_name','Prod A1','quantity',0,'unit_cost',100)),NULL);
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'SP9 cantidad invalida -> VALIDATION_ERROR');
  -- SP10 total invalido
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,'00000000-0000-0000-0000-0000002d7109'::uuid,'Prov A',v_cur,'F10',0,0,'efectivo','',it1,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'SP10 total invalido -> VALIDATION_ERROR');
  -- roles miembros
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002d7108';  -- admin
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,NULL,'Prov A',v_cur,'F-ADM',150,0,'efectivo','',it1,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'SP-role admin (miembro) -> ok');
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002d7107';  -- cashier
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,NULL,'Prov A',v_cur,'F-CSH',160,0,'efectivo','',it1,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'SP-role cashier (miembro) -> ok (rol preservado)');
  RESET ROLE;
  -- SP11 cross-tenant actor
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002d7209';  -- OB
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,'00000000-0000-0000-0000-0000002d7209'::uuid,'Prov A',v_cur,'F11',100,0,'efectivo','',it1,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='FORBIDDEN', 'SP11 actor de otro negocio -> FORBIDDEN');
  RESET ROLE;
  -- SP6 efectivo PAGADO sin caja abierta (bizB no tiene caja) -> CASH_REGISTER_NOT_OPEN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002d7209';  -- OB en bizB
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7201'::uuid,'00000000-0000-0000-0000-0000002d7302'::uuid,'00000000-0000-0000-0000-0000002d7209'::uuid,'Prov B',v_cur,'F6',600,600,'efectivo','',
    jsonb_build_array(jsonb_build_object('inventory_id',NULL,'product_name','X','quantity',1,'unit_cost',600)),NULL);
  PERFORM pg_temp.assert(r->>'error_code'='CASH_REGISTER_NOT_OPEN', 'SP6 efectivo pagado sin caja -> CASH_REGISTER_NOT_OPEN');
  RESET ROLE;
  -- idempotencia
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002d7109';  -- OA
  PERFORM create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,NULL,'Prov A',v_cur,'FK',1234,0,'efectivo','',it1,'SPK');
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,NULL,'Prov A',v_cur,'FK',1234,0,'efectivo','',it1,'SPK');
  PERFORM pg_temp.assert((r->>'replay')::boolean, 'SP-ID1 replay mismo key+payload');
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,NULL,'Prov A',v_cur,'FK',9999,0,'efectivo','',it1,'SPK');
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT' AND r->>'error'='IDEMPOTENCY_CONFLICT', 'SP-ID2 conflict + error compat frontend');
  RESET ROLE;
END $$;
-- SP12 unauthenticated
DO $$ DECLARE r jsonb; BEGIN
  RESET ROLE; SET LOCAL "request.jwt.claim.sub" = '';
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,NULL,'Prov A',public.ar_today(),'F12',100,0,'efectivo','','[]'::jsonb,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='UNAUTHORIZED', 'SP12 sin auth -> UNAUTHORIZED');
END $$;

-- ============ Invariantes contables + fecha + auditoria =====================
-- Fecha persistida en todas las patas (SP15, total 700, credito)
SELECT pg_temp.assert((SELECT purchase_date FROM supplier_purchases WHERE business_id=:'bizA' AND total_amount=700)=public.ar_today(), 'SP16a supplier_purchases.purchase_date = ar_today()');
SELECT pg_temp.assert((SELECT movement_date FROM supplier_account_movements WHERE business_id=:'bizA' AND purchase_id=(SELECT id FROM supplier_purchases WHERE business_id=:'bizA' AND total_amount=700) AND type='purchase')=public.ar_today(), 'SP16b supplier_account_movements.movement_date = ar_today()');
SELECT pg_temp.assert(
  (SELECT a.economic_date FROM supplier_purchases sp JOIN finance_audit_log a ON a.entity_id=sp.id AND a.action='supplier_purchase' WHERE sp.business_id=:'bizA' AND sp.total_amount=700)
  = (SELECT purchase_date FROM supplier_purchases WHERE business_id=:'bizA' AND total_amount=700), 'SP16c fecha auditada = persistida');
-- CONTADO (total 1000, paid 1000): 1 FM, 1 BFE compras_proveedor, 0 COGS/mercaderia, deuda debit+credit, FM.date correcto
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'bizA' AND reference_id=(SELECT id FROM supplier_purchases WHERE business_id=:'bizA' AND total_amount=1000) AND reference_type='supplier_purchase')=1, 'SP-INV1a contado: 1 FM (sin duplicar)');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'bizA' AND source='pago_proveedor' AND amount_ars=1000 AND category='compras_proveedor')=1, 'SP-INV1b contado: 1 BFE compras_proveedor');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'bizA' AND category='mercaderia' AND amount_ars=1000)=0, 'SP-INV1c contado: NO genera COGS/mercaderia al comprar');
SELECT pg_temp.assert((SELECT count(*) FROM supplier_account_movements WHERE purchase_id=(SELECT id FROM supplier_purchases WHERE business_id=:'bizA' AND total_amount=1000))=2, 'SP-INV1d contado: deuda debit + credit (2 movs)');
SELECT pg_temp.assert((SELECT fm.date FROM supplier_purchases sp JOIN financial_movements fm ON fm.reference_id=sp.id AND fm.reference_type='supplier_purchase' WHERE sp.business_id=:'bizA' AND sp.total_amount=1000)=public.ar_today(), 'SP-INV1e FM.date = ar_today()');
-- CREDITO (total 2000, paid 0): 0 FM, 0 BFE, solo debito de deuda (sin salida de caja)
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'bizA' AND reference_id=(SELECT id FROM supplier_purchases WHERE business_id=:'bizA' AND total_amount=2000))=0, 'SP-INV2a credito: 0 FM (sin salida de caja)');
SELECT pg_temp.assert((SELECT count(*) FROM supplier_account_movements WHERE purchase_id=(SELECT id FROM supplier_purchases WHERE business_id=:'bizA' AND total_amount=2000))=1, 'SP-INV2b credito: solo debito de deuda (pasivo)');
SELECT pg_temp.assert((SELECT payment_status FROM supplier_purchases WHERE business_id=:'bizA' AND total_amount=2000)='pending', 'SP-INV2c credito: status pending');
-- PARCIAL (total 3000, paid 1200): status partial, 1 FM, deuda debit+credit
SELECT pg_temp.assert((SELECT payment_status FROM supplier_purchases WHERE business_id=:'bizA' AND total_amount=3000)='partial', 'SP-INV3a parcial: status partial');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'bizA' AND reference_id=(SELECT id FROM supplier_purchases WHERE business_id=:'bizA' AND total_amount=3000))=1, 'SP-INV3b parcial: 1 FM');
-- MULTIPLE (total 4000): inventario actualizado una vez por item con inventory_id (2 movimientos)
SELECT pg_temp.assert((SELECT count(*) FROM inventory_movements WHERE reference_id=(SELECT id FROM supplier_purchases WHERE business_id=:'bizA' AND total_amount=4000))=2, 'SP-INV4a multiple: 2 inventory_movements (uno por item)');
-- Auditoria: un evento, campos clave
SELECT pg_temp.assert((SELECT count(*) FROM supplier_purchases sp JOIN finance_audit_log a ON a.entity_id=sp.id AND a.action='supplier_purchase' WHERE sp.business_id=:'bizA' AND sp.total_amount=1000)=1, 'SP-AU1 exactamente un evento supplier_purchase');
SELECT pg_temp.assert((SELECT (a.new_data->>'paid_amount')::numeric FROM supplier_purchases sp JOIN finance_audit_log a ON a.entity_id=sp.id WHERE sp.business_id=:'bizA' AND sp.total_amount=1000 LIMIT 1)=1000
                  AND (SELECT (a.new_data->>'item_count')::int FROM supplier_purchases sp JOIN finance_audit_log a ON a.entity_id=sp.id WHERE sp.business_id=:'bizA' AND sp.total_amount=1000 LIMIT 1)=1, 'SP-AU2 new_data: paid_amount + item_count');
-- Replay no duplica
SELECT pg_temp.assert((SELECT count(*) FROM supplier_purchases WHERE business_id=:'bizA' AND total_amount=1234)=1, 'SP-ID1b replay NO duplica compra');
SELECT pg_temp.assert((SELECT count(*) FROM finance_audit_log WHERE request_id='SPK' AND action='supplier_purchase')=1, 'SP-ID1c replay NO duplica auditoria');

-- ============ 6D.1a: Actor canonico (auth.uid, no p_user_id) ================
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002d7109';  -- OA
  -- AC: A (OA) manda p_user_id = ADM (otro usuario del negocio) -> NO se atribuye a ADM
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,'00000000-0000-0000-0000-0000002d7108'::uuid,'Prov A',public.ar_today(),'FAC',11000,11000,'efectivo','',
    jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-0000002d7401','product_name','Prod A1','quantity',1,'unit_cost',11000)),'ACK');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'AC1 A manda id de otro usuario -> op valida ('||COALESCE(r->>'error','')||')');
  RESET ROLE;
END $$;
-- Todas las filas creadas usan el actor canonico OA (no ADM que se paso en p_user_id)
SELECT pg_temp.assert((SELECT created_by FROM supplier_purchases WHERE business_id=:'bizA' AND total_amount=11000)=:'OA', 'AC2 supplier_purchases.created_by = auth.uid (OA)');
SELECT pg_temp.assert((SELECT created_by FROM financial_movements WHERE business_id=:'bizA' AND amount=11000 AND source='pago_proveedor')=:'OA', 'AC3 FM.created_by = OA');
SELECT pg_temp.assert((SELECT created_by FROM business_finance_entries WHERE business_id=:'bizA' AND amount_ars=11000 AND source='pago_proveedor')=:'OA', 'AC4 BFE.created_by = OA');
SELECT pg_temp.assert((SELECT created_by FROM supplier_payments WHERE business_id=:'bizA' AND amount=11000)=:'OA', 'AC5 supplier_payments.created_by = OA');
SELECT pg_temp.assert((SELECT created_by FROM inventory_movements WHERE reference_id=(SELECT id FROM supplier_purchases WHERE business_id=:'bizA' AND total_amount=11000) LIMIT 1)=:'OA', 'AC6 inventory_movements.created_by = OA');
SELECT pg_temp.assert((SELECT user_id FROM supplier_purchase_requests WHERE business_id=:'bizA' AND idempotency_key='ACK')=:'OA', 'AC7 supplier_purchase_requests.user_id = OA');
SELECT pg_temp.assert((SELECT actor_user_id FROM finance_audit_log WHERE business_id=:'bizA' AND request_id='ACK' AND action='supplier_purchase')=:'OA', 'AC8 finance_audit_log.actor_user_id = auth.uid (OA)');

-- ============ 6D.1a: Hash completo -- conflicto por campo antes omitido =====
DO $$
DECLARE r jsonb;
  base jsonb := jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-0000002d7401','product_name','Prod A1','quantity',2,'unit_cost',500));
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002d7109';  -- OA
  -- base credito (paid=0) con key HCK
  PERFORM create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,NULL,'Prov A',public.ar_today(),'INV1',1100,0,'efectivo','',base,'HCK');
  -- cambia solo invoice
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,NULL,'Prov A',public.ar_today(),'INV2',1100,0,'efectivo','',base,'HCK');
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT', 'HC1 cambia invoice_number -> conflict');
  -- cambia solo supplier_name (antes NO estaba en el hash)
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,NULL,'Prov OTRO',public.ar_today(),'INV1',1100,0,'efectivo','',base,'HCK');
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT', 'HC2 cambia supplier_name -> conflict');
  -- cambia solo notes
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,NULL,'Prov A',public.ar_today(),'INV1',1100,0,'efectivo','nota nueva',base,'HCK');
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT', 'HC3 cambia notes -> conflict');
  -- cambia solo paid (0 -> 1100, contado con caja abierta)
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,NULL,'Prov A',public.ar_today(),'INV1',1100,1100,'efectivo','',base,'HCK');
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT', 'HC4 cambia paid_amount -> conflict');
  -- cambia solo payment_method
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,NULL,'Prov A',public.ar_today(),'INV1',1100,0,'transferencia','',base,'HCK');
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT', 'HC5 cambia payment_method -> conflict');
  -- cambia solo un costo de item
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,NULL,'Prov A',public.ar_today(),'INV1',1100,0,'efectivo','',
    jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-0000002d7401','product_name','Prod A1','quantity',2,'unit_cost',999)),'HCK');
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT', 'HC6 cambia costo de item -> conflict');
  -- cambia solo una cantidad
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,NULL,'Prov A',public.ar_today(),'INV1',1100,0,'efectivo','',
    jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-0000002d7401','product_name','Prod A1','quantity',3,'unit_cost',500)),'HCK');
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT', 'HC7 cambia cantidad -> conflict');
  -- equivalente tras normalizar espacios -> REPLAY (supplier_name y notes con espacios)
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,NULL,'  Prov A  ',public.ar_today(),'  INV1  ',1100,0,'  efectivo  ','   ',base,'HCK');
  PERFORM pg_temp.assert((r->>'replay')::boolean, 'HC8 payload equivalente (espacios) -> replay');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT count(*) FROM supplier_purchases WHERE business_id=:'bizA' AND total_amount=1100)=1, 'HC9 solo 1 compra por key HCK (variaciones no escribieron)');

-- ============ 6D.1a: Efectivo y caja =======================================
DO $$
DECLARE r jsonb;
BEGIN
  -- CR1 credito sin caja (bizB paid=0) -> permitida
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002d7209';  -- OB (bizB sin caja)
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7201'::uuid,'00000000-0000-0000-0000-0000002d7302'::uuid,NULL,'Prov B',public.ar_today(),'CR1',1200,0,'efectivo','','[]'::jsonb,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'CR1 credito sin caja -> permitida');
  -- CR2 transferencia pagada sin caja (bizB) -> permitida (no-efectivo)
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7201'::uuid,'00000000-0000-0000-0000-0000002d7302'::uuid,NULL,'Prov B',public.ar_today(),'CR2',1300,500,'transferencia','','[]'::jsonb,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'CR2 transferencia pagada sin caja -> permitida');
  -- CR3 efectivo pagado sin caja (bizB) -> CASH_REGISTER_NOT_OPEN (no toma caja de otro negocio)
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7201'::uuid,'00000000-0000-0000-0000-0000002d7302'::uuid,NULL,'Prov B',public.ar_today(),'CR3',900,900,'efectivo','','[]'::jsonb,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='CASH_REGISTER_NOT_OPEN', 'CR3 efectivo pagado sin caja -> CASH_REGISTER_NOT_OPEN (no usa caja ajena)');
  RESET ROLE;
  -- CR4 efectivo con caja (bizA) -> permitida
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002d7109';  -- OA (bizA con caja)
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,NULL,'Prov A',public.ar_today(),'CR4',1400,1400,'efectivo','','[]'::jsonb,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'CR4 efectivo con caja abierta -> permitida');
  RESET ROLE;
END $$;
-- CR5 FM.caja_id = la caja validada de bizA
SELECT pg_temp.assert((SELECT caja_id FROM financial_movements WHERE business_id=:'bizA' AND amount=1400 AND source='pago_proveedor')=:'CAJA', 'CR5 FM.caja_id = caja validada');
-- CR6 nunca un FM en efectivo con caja_id NULL
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'bizA' AND source='pago_proveedor' AND metodo_pago='efectivo' AND caja_id IS NULL)=0, 'CR6 0 FM efectivo con caja_id NULL');
-- CR7 auditoria de CR4 lleva la caja utilizada + supplier_payment_id + ids de deuda
SELECT pg_temp.assert(
  (SELECT (a.new_data->>'caja_id')::uuid FROM supplier_purchases sp JOIN finance_audit_log a ON a.entity_id=sp.id AND a.action='supplier_purchase' WHERE sp.business_id=:'bizA' AND sp.total_amount=1400)=:'CAJA', 'AU-EXP1 new_data.caja_id = caja utilizada');
SELECT pg_temp.assert(
  (SELECT (a.new_data->>'supplier_payment_id') IS NOT NULL AND (a.new_data->>'supplier_debit_movement_id') IS NOT NULL AND (a.new_data->>'supplier_credit_movement_id') IS NOT NULL
   FROM supplier_purchases sp JOIN finance_audit_log a ON a.entity_id=sp.id WHERE sp.business_id=:'bizA' AND sp.total_amount=1400), 'AU-EXP2 new_data: supplier_payment_id + debit/credit movement ids');

-- ============ Rollback: fallo en un item revierte la compra completa ========
ALTER TABLE supplier_purchase_items ADD CONSTRAINT tmp_fail_item CHECK (product_name <> 'FAILME') NOT VALID;
DO $$
DECLARE r jsonb; n int; stk int;
BEGIN
  SELECT count(*) INTO n FROM supplier_purchases WHERE business_id='00000000-0000-0000-0000-0000002d7101' AND total_amount=7777;
  SELECT stock_quantity INTO stk FROM inventory WHERE id='00000000-0000-0000-0000-0000002d7401';
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002d7109';
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,NULL,'Prov A',public.ar_today(),'FRB',7777,0,'efectivo','',
    jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-0000002d7401','product_name','Prod A1','quantity',1,'unit_cost',100),
                      jsonb_build_object('inventory_id',NULL,'product_name','FAILME','quantity',1,'unit_cost',100)),NULL);
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE, 'SP-RB1a fallo en un item -> ok:false');
  PERFORM pg_temp.assert((SELECT count(*) FROM supplier_purchases WHERE business_id='00000000-0000-0000-0000-0000002d7101' AND total_amount=7777)=n, 'SP-RB1b compra completa revertida (0 nuevas)');
  PERFORM pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id='00000000-0000-0000-0000-0000002d7401')=stk, 'SP-RB1c inventario sin cambios (rollback)');
END $$;
ALTER TABLE supplier_purchase_items DROP CONSTRAINT tmp_fail_item;

-- ============ Rollback: fallo de auditoria revierte todo ====================
ALTER TABLE finance_audit_log ADD CONSTRAINT tmp_fail_sp CHECK (action <> 'supplier_purchase') NOT VALID;
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002d7109';
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000002d7101'::uuid,'00000000-0000-0000-0000-0000002d7301'::uuid,NULL,'Prov A',public.ar_today(),'FAF',8888,8888,'efectivo','',
    jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-0000002d7401','product_name','Prod A1','quantity',1,'unit_cost',8888)),NULL);
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE AND r->>'error_code'='AUDIT_FAILED', 'SP-RB2a auditoria rota -> AUDIT_FAILED');
END $$;
SELECT pg_temp.assert((SELECT count(*) FROM supplier_purchases WHERE business_id=:'bizA' AND total_amount=8888)=0
                  AND (SELECT count(*) FROM financial_movements WHERE business_id=:'bizA' AND amount=8888)=0
                  AND (SELECT count(*) FROM supplier_account_movements WHERE business_id=:'bizA' AND debit=8888)=0, 'SP-RB2b rollback total (compra/FM/deuda)');
ALTER TABLE finance_audit_log DROP CONSTRAINT tmp_fail_sp;

-- ============ Request table protegida + cross-business ======================
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.supplier_purchase_requests','SELECT'), 'SP-RT1 authenticated NO SELECT supplier_purchase_requests');
SELECT pg_temp.assert(NOT has_table_privilege('service_role','public.supplier_purchase_requests','UPDATE'), 'SP-RT2 service_role NO UPDATE');
SELECT pg_temp.assert(NOT has_table_privilege('service_role','public.supplier_purchase_requests','DELETE'), 'SP-RT3 service_role NO DELETE');
DO $$
DECLARE v_id uuid; e text;
BEGIN
  INSERT INTO supplier_purchase_requests(business_id,user_id,op,idempotency_key,request_hash)
    VALUES ('00000000-0000-0000-0000-0000002d7101','00000000-0000-0000-0000-0000002d7109','supplier_purchase','Z1','h') RETURNING id INTO v_id;
  e:=''; BEGIN UPDATE supplier_purchase_requests SET purchase_id='00000000-0000-0000-0000-0000002d7701' WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%no pertenece al negocio%', 'SP-RT4 enlace a compra de OTRO negocio -> rechazado');
  e:=''; BEGIN DELETE FROM supplier_purchase_requests WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e<>'', 'SP-RT5 DELETE prohibido');
END $$;

ROLLBACK;
