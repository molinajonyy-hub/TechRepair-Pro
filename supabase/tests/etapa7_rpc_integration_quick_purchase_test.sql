-- ============================================================================
-- M7 Bloque 6E.1 -- create_quick_inventory_purchase_atomic
-- Ownership/actor canonico, contrato de error (error_code), fecha economica +
-- guard de periodo, caja para efectivo, metodo via helper central, idempotencia,
-- serializacion de inventario (ultimo costo), auditoria (quick_inventory_purchase),
-- invariantes contables M3-M6 (sin COGS/gasto operativo; inventory_purchase fuera
-- del P&L; inventario/deuda/caja una vez), rollback total. Concurrencia: harness aparte.
-- RUN: docker cp ... && psql -X -f (BEGIN + ROLLBACK)
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;
CREATE OR REPLACE FUNCTION pg_temp.item(inv text, qty numeric, cost numeric)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_array(jsonb_build_object('inventory_id',inv,'product_name','P','quantity',qty,'unit_cost_ars',cost)) $$;

\set biz  '00000000-0000-0000-0000-000000317101'
\set OA   '00000000-0000-0000-0000-000000317109'
\set biz2 '00000000-0000-0000-0000-000000317201'
\set ON2  '00000000-0000-0000-0000-000000317209'
\set SUP  '00000000-0000-0000-0000-000000317301'
\set SUP2 '00000000-0000-0000-0000-000000317302'
\set INV  '00000000-0000-0000-0000-000000317d01'
\set INV2 '00000000-0000-0000-0000-000000317d02'
\set CAJA '00000000-0000-0000-0000-000000317601'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'OA'),(:'ON2');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','6E1 A',:'OA'),(:'biz2','6E1 SIN CAJA',:'ON2');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES (:'biz',:'OA','owner',true),(:'biz2',:'ON2','owner',true);
INSERT INTO suppliers(id,business_id,name) VALUES (:'SUP',:'biz','Prov A'),(:'SUP2',:'biz2','Prov N');
INSERT INTO inventory(id,business_id,name,code,category,stock_quantity,stock,cost_price,sale_price,base_currency,is_active) VALUES
  (:'INV', :'biz', 'Prod','E1-1','Rep',100,100,500,900,'ARS',true),
  (:'INV2',:'biz2','ProdN','E1-2','Rep',10,10,500,900,'ARS',true);
INSERT INTO cajas(id,business_id,opened_by,status) VALUES (:'CAJA',:'biz',:'OA','abierta');  -- biz2 SIN caja
SET LOCAL session_replication_role='origin';

DO $$ DECLARE v_p1 date := date_trunc('month', public.ar_today() - interval '1 month')::date;
BEGIN SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000317109';
  PERFORM close_period('00000000-0000-0000-0000-000000317101'::uuid, v_p1, 'setup 6E1'); RESET ROLE; END $$;

-- ============ Auth / ownership / contrato de error ============================
DO $$
DECLARE r jsonb; v_cur date := public.ar_today();
  v_p1 date := date_trunc('month', public.ar_today() - interval '1 month')::date;
BEGIN
  -- QA1 sin auth (limpia el claim que dejo el bloque de setup: auth.uid() -> NULL)
  SET LOCAL "request.jwt.claim.sub" = '';
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000317101'::uuid,'k',NULL,NULL,NULL,v_cur,'efectivo',100,100,pg_temp.item('00000000-0000-0000-0000-000000317d01',1,100));
  PERFORM pg_temp.assert(r->>'error_code'='UNAUTHORIZED', 'QA1 sin auth -> UNAUTHORIZED');
  -- QA2 cross-tenant
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000317209';  -- ON2
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000317101'::uuid,'k2',NULL,NULL,NULL,v_cur,'efectivo',100,100,pg_temp.item('00000000-0000-0000-0000-000000317d01',1,100));
  PERFORM pg_temp.assert(r->>'error_code'='FORBIDDEN', 'QA2 cross-tenant -> FORBIDDEN');
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000317109';  -- OA
  -- QV1 total 0
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000317101'::uuid,'k3',NULL,NULL,NULL,v_cur,'efectivo',0,0,'[]'::jsonb);
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'QV1 total 0 -> VALIDATION_ERROR');
  -- QV2 paid negativo
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000317101'::uuid,'k4',NULL,NULL,NULL,v_cur,'efectivo',100,-5,pg_temp.item('00000000-0000-0000-0000-000000317d01',1,100));
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'QV2 paid negativo -> VALIDATION_ERROR');
  -- QV3 proveedor de otro negocio
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000317101'::uuid,'k5','00000000-0000-0000-0000-000000317302'::uuid,'X',NULL,v_cur,'efectivo',100,100,pg_temp.item('00000000-0000-0000-0000-000000317d01',1,100));
  PERFORM pg_temp.assert(r->>'error_code'='SUPPLIER_NOT_FOUND', 'QV3 proveedor de otro negocio -> SUPPLIER_NOT_FOUND');
  -- QV4 inventario de otro negocio
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000317101'::uuid,'k6',NULL,NULL,NULL,v_cur,'efectivo',100,100,pg_temp.item('00000000-0000-0000-0000-000000317d02',1,100));
  PERFORM pg_temp.assert(r->>'error_code'='INVENTORY_NOT_FOUND', 'QV4 inventario de otro negocio -> INVENTORY_NOT_FOUND');
  -- QV5 metodo invalido
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000317101'::uuid,'k7',NULL,NULL,NULL,v_cur,'bitcoin',100,100,pg_temp.item('00000000-0000-0000-0000-000000317d01',1,100));
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'QV5 metodo invalido -> VALIDATION_ERROR');
  -- QV6 efectivo con pago pero SIN caja (biz2)
  RESET ROLE; SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000317209';
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000317201'::uuid,'k8',NULL,NULL,NULL,v_cur,'efectivo',100,100,pg_temp.item('00000000-0000-0000-0000-000000317d02',1,100));
  PERFORM pg_temp.assert(r->>'error_code'='CASH_REGISTER_NOT_OPEN', 'QV6 efectivo sin caja -> CASH_REGISTER_NOT_OPEN');
  RESET ROLE; SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000317109';
  -- QV7 metodo vacio con pago
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000317101'::uuid,'k9',NULL,NULL,NULL,v_cur,'   ',100,100,pg_temp.item('00000000-0000-0000-0000-000000317d01',1,100));
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'QV7 metodo vacio con pago -> VALIDATION_ERROR');
  -- QV8 key demasiado larga
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000317101'::uuid,repeat('x',201),NULL,NULL,NULL,v_cur,'efectivo',100,100,pg_temp.item('00000000-0000-0000-0000-000000317d01',1,100));
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'QV8 key > 200 -> VALIDATION_ERROR');
  -- QP-CLOSE compra retroactiva en periodo cerrado -> PERIOD_CLOSED (antes de tocar stock)
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000317101'::uuid,'kc',NULL,NULL,NULL,v_p1+5,'efectivo',100,100,pg_temp.item('00000000-0000-0000-0000-000000317d01',1,100));
  PERFORM pg_temp.assert(r->>'error_code'='PERIOD_CLOSED', 'QPC periodo cerrado -> PERIOD_CLOSED');
  RESET ROLE;
END $$;
-- ningun rechazo toco el stock (sigue 100) ni dejo requests
SELECT pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id=:'INV')=100, 'QV-stock: ningun rechazo modifico stock (100)');
SELECT pg_temp.assert((SELECT count(*) FROM quick_purchase_requests WHERE business_id=:'biz')=0, 'QV-req: ningun rechazo reservo request');

-- ============ Camino feliz: contado con proveedor + efectivo ==================
DO $$
DECLARE r jsonb; v_cur date := public.ar_today();
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000317109';
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000317101'::uuid,'HAPPY','00000000-0000-0000-0000-000000317301'::uuid,'Prov A','FC-1',v_cur,'  Efectivo  ',5000,5000,pg_temp.item('00000000-0000-0000-0000-000000317d01',5,1000));
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean IS FALSE, 'H1 contado efectivo con caja -> ok ('||COALESCE(r->>'error','')||')');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id=:'INV')=105, 'H2 stock 100 -> 105');
SELECT pg_temp.assert((SELECT cost_price FROM inventory WHERE id=:'INV')=1000, 'H3 cost_price = 1000 (ULTIMO costo)');
SELECT pg_temp.assert((SELECT count(*) FROM inventory_movements WHERE reference_id=(SELECT id FROM supplier_purchases WHERE business_id=:'biz' AND invoice_number='FC-1'))=1, 'H4 exactamente 1 inventory_movement');
SELECT pg_temp.assert((SELECT payment_method FROM supplier_purchases WHERE business_id=:'biz' AND invoice_number='FC-1')='efectivo', 'H5 metodo canonico "efectivo" (normalizado desde "  Efectivo  ")');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'biz' AND metodo_pago='efectivo' AND caja_id IS NULL)=0, 'H6 0 FM efectivo con caja_id NULL');
SELECT pg_temp.assert((SELECT caja_id FROM financial_movements WHERE business_id=:'biz' AND source='pago_proveedor')=:'CAJA', 'H7 FM usa la caja validada');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'biz' AND economic_class='inventory_purchase')=1, 'H8 1 BFE inventory_purchase');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'biz' AND economic_class IN ('operating_expense','cogs','cogs_mirror'))=0, 'H9 0 gasto operativo / COGS');
SELECT pg_temp.assert((SELECT ROUND(SUM(debit-credit)) FROM supplier_account_movements WHERE business_id=:'biz')=0, 'H10 ledger proveedor saldado (deuda-pago=0)');
-- P&L intacto ; cashflow refleja la salida
SELECT pg_temp.assert(COALESCE((SELECT SUM(operating_result) FROM v_finance_pnl WHERE business_id=:'biz'),0)=0, 'H11 P&L operativo = 0 (comprar no afecta P&L)');
SELECT pg_temp.assert((SELECT count(*) FROM v_finance_cashflow WHERE business_id=:'biz' AND payment_method='efectivo' AND expense_ars=5000 AND cashflow_class='supplier')=1, 'H12 pago visible en v_finance_cashflow (salida supplier)');

-- ============ Auditoria: quick_inventory_purchase ============================
DO $$ DECLARE v_pur uuid; a finance_audit_log%ROWTYPE;
BEGIN
  SELECT id INTO v_pur FROM supplier_purchases WHERE business_id='00000000-0000-0000-0000-000000317101' AND invoice_number='FC-1';
  SELECT * INTO a FROM finance_audit_log WHERE business_id='00000000-0000-0000-0000-000000317101' AND action='quick_inventory_purchase' AND entity_id=v_pur;
  PERFORM pg_temp.assert(a.id IS NOT NULL, 'AU1 evento quick_inventory_purchase registrado');
  PERFORM pg_temp.assert(a.actor_user_id='00000000-0000-0000-0000-000000317109', 'AU2 actor = auth.uid (OA)');
  PERFORM pg_temp.assert(a.economic_date=public.ar_today(), 'AU3 economic_date = fecha del pago');
  PERFORM pg_temp.assert((a.new_data->>'method')='efectivo' AND (a.new_data->>'caja_id') IS NOT NULL, 'AU4 metodo auditado=persistido + caja');
  PERFORM pg_temp.assert((a.new_data->'inventory'->0->>'prev_stock')='100' AND (a.new_data->'inventory'->0->>'new_stock')='105', 'AU5 stock anterior/posterior en auditoria');
  PERFORM pg_temp.assert((a.new_data->'inventory'->0->>'new_cost')::numeric=1000, 'AU6 costo posterior en auditoria');
  PERFORM pg_temp.assert((a.new_data->>'financial_movement_id') IS NOT NULL AND (a.new_data->>'supplier_payment_id') IS NOT NULL, 'AU7 IDs FM + supplier_payment en auditoria');
END $$;

-- ============ Idempotencia + a deuda + sin proveedor =========================
DO $$
DECLARE r jsonb; v_cur date := public.ar_today(); v_pid uuid;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000317109';
  -- replay
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000317101'::uuid,'IK','00000000-0000-0000-0000-000000317301'::uuid,'Prov A','FC-2',v_cur,'transferencia',3000,3000,pg_temp.item('00000000-0000-0000-0000-000000317d01',3,1000));
  v_pid := (r->>'purchase_id')::uuid;
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000317101'::uuid,'IK','00000000-0000-0000-0000-000000317301'::uuid,'Prov A','FC-2',v_cur,'transferencia',3000,3000,pg_temp.item('00000000-0000-0000-0000-000000317d01',3,1000));
  PERFORM pg_temp.assert((r->>'replay')::boolean AND (r->>'purchase_id')::uuid=v_pid, 'ID1 replay mismo key+payload -> mismo purchase_id');
  -- conflicto payload distinto
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000317101'::uuid,'IK','00000000-0000-0000-0000-000000317301'::uuid,'Prov A','FC-2',v_cur,'transferencia',3001,3001,pg_temp.item('00000000-0000-0000-0000-000000317d01',3,1000));
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT', 'ID2 payload distinto misma key -> IDEMPOTENCY_CONFLICT');
  -- a deuda (paid=0, sin metodo) sin proveedor
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000317101'::uuid,'IK3',NULL,NULL,NULL,v_cur,NULL,2000,0,pg_temp.item('00000000-0000-0000-0000-000000317d01',2,1000));
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'ID3 a deuda sin proveedor -> ok');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id=:'INV')=110, 'ID1b replay NO volvio a subir stock (105 + FC-2 3 = 108? -> ver)');
-- FC-1:+5(105), FC-2:+3(108), IK3 a deuda:+2(110). replay/conflicto no suman.
SELECT pg_temp.assert((SELECT count(*) FROM supplier_purchases WHERE business_id=:'biz' AND invoice_number='FC-2')=1, 'ID2b conflicto no creo segunda compra FC-2');
-- a deuda: sin FM/BFE por IK3
SELECT pg_temp.assert((SELECT payment_status FROM supplier_purchases WHERE business_id=:'biz' AND paid_amount=0 AND total_amount=2000)='pending', 'ID3b a deuda -> pending');

-- ============ Rollback ante fallo de auditoria ===============================
ALTER TABLE finance_audit_log ADD CONSTRAINT tmp_fail_qp CHECK (action <> 'quick_inventory_purchase') NOT VALID;
DO $$
DECLARE r jsonb; v_stk int;
BEGIN
  SELECT stock_quantity INTO v_stk FROM inventory WHERE id='00000000-0000-0000-0000-000000317d01';
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000317109';
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000317101'::uuid,'RBK','00000000-0000-0000-0000-000000317301'::uuid,'Prov A','FC-RB',public.ar_today(),'efectivo',9000,9000,pg_temp.item('00000000-0000-0000-0000-000000317d01',9,1000));
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'error_code'='AUDIT_FAILED', 'RB1 auditoria rota -> AUDIT_FAILED');
  PERFORM pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id='00000000-0000-0000-0000-000000317d01')=v_stk, 'RB2 stock revertido (sin cambios)');
  PERFORM pg_temp.assert((SELECT count(*) FROM supplier_purchases WHERE business_id='00000000-0000-0000-0000-000000317101' AND invoice_number='FC-RB')=0, 'RB3 sin compra');
  PERFORM pg_temp.assert((SELECT count(*) FROM quick_purchase_requests WHERE business_id='00000000-0000-0000-0000-000000317101' AND idempotency_key='RBK')=0, 'RB4 sin request (retry seguro)');
  PERFORM pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id='00000000-0000-0000-0000-000000317101' AND amount=9000)=0, 'RB5 sin FM');
END $$;
ALTER TABLE finance_audit_log DROP CONSTRAINT tmp_fail_qp;

-- ============ Request table protegida + inmutabilidad ========================
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.quick_purchase_requests','SELECT'), 'RT1 authenticated NO SELECT quick_purchase_requests');
SELECT pg_temp.assert(NOT has_table_privilege('service_role','public.quick_purchase_requests','UPDATE') AND NOT has_table_privilege('service_role','public.quick_purchase_requests','DELETE'), 'RT2 service_role NO UPDATE/DELETE');
SELECT pg_temp.assert(EXISTS (SELECT 1 FROM pg_constraint WHERE conname='quick_purchase_requests_key_uniq'), 'RT3 UNIQUE(business_id, idempotency_key) presente');
DO $$
DECLARE v_id uuid; e text;
BEGIN
  INSERT INTO quick_purchase_requests(business_id,user_id,op,idempotency_key,request_hash)
    VALUES ('00000000-0000-0000-0000-000000317101','00000000-0000-0000-0000-000000317109','quick_inventory_purchase','ZK','h') RETURNING id INTO v_id;
  e:=''; BEGIN DELETE FROM quick_purchase_requests WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e<>'', 'RT4 DELETE prohibido (append-only)');
  e:=''; BEGIN UPDATE quick_purchase_requests SET request_hash='x' WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%solo se puede completar%', 'RT5 hash inmutable');
END $$;

SELECT pg_temp.assert(true, '=== etapa7_rpc_integration_quick_purchase_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
