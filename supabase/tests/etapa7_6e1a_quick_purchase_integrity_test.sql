-- ============================================================================
-- M7 Bloque 6E.1a -- create_quick_inventory_purchase_atomic: integridad de
-- cantidades ENTERAS, productos duplicados y coherencia multi-item.
--   TechRepair maneja SOLO unidades enteras (1,2,3...). Sin fraccionarios.
--   §1 cantidad entera >=1 (sin FLOOR/truncado): 1/2/3 ok; 1.5/0.5/2.0001/0/-1/NULL/no-num rechazados.
--   §2 coherencia: item.qty = movement.qty = incremento de stock = auditoria.
--   §3 producto duplicado en el payload -> VALIDATION_ERROR (sin agrupar/sumar).
--   §4 N inventarios esperados = N encontrados (faltante/ajeno -> INVENTORY_NOT_FOUND).
--   §8 idempotencia order-independent ([A,B]==[B,A]); qty/costo distinto -> conflicto.
--   §10 rollback total (falla en 2do item revierte el 1ro).
-- Concurrencia orden inverso: harness aparte.
-- RUN: docker cp ... && psql -X -f (BEGIN + ROLLBACK)
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;
-- item con cantidad numerica (para casos validos y decimales)
CREATE OR REPLACE FUNCTION pg_temp.i1(inv text, qty numeric, cost numeric)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_array(jsonb_build_object('inventory_id',inv,'product_name','P','quantity',qty,'unit_cost_ars',cost)) $$;

\set biz  '00000000-0000-0000-0000-000000337101'
\set OA   '00000000-0000-0000-0000-000000337109'
\set SUP  '00000000-0000-0000-0000-000000337301'
\set INVA '00000000-0000-0000-0000-000000337d01'
\set INVB '00000000-0000-0000-0000-000000337d02'
\set INVX '00000000-0000-0000-0000-000000337d99'
\set CAJA '00000000-0000-0000-0000-000000337601'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'OA');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','6E1a',:'OA');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES (:'biz',:'OA','owner',true);
INSERT INTO suppliers(id,business_id,name) VALUES (:'SUP',:'biz','Prov');
INSERT INTO inventory(id,business_id,name,code,category,stock_quantity,stock,cost_price,sale_price,base_currency,is_active) VALUES
  (:'INVA',:'biz','A','A-1','Rep',100,100,500,900,'ARS',true),
  (:'INVB',:'biz','B','B-1','Rep',200,200,500,900,'ARS',true);
INSERT INTO cajas(id,business_id,opened_by,status) VALUES (:'CAJA',:'biz',:'OA','abierta');
SET LOCAL session_replication_role='origin';

-- ============ §1 Cantidades enteras =========================================
DO $$
DECLARE r jsonb; v_cur date := public.ar_today();
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000337109';
  -- validos 1,2,3 (a deuda para no depender de montos; efectivo con caja igual sirve)
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000337101'::uuid,'q1',NULL,NULL,'F1',v_cur,'transferencia',1000,1000,pg_temp.i1('00000000-0000-0000-0000-000000337d01',1,1000));
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'Q1 cantidad 1 -> ok ('||COALESCE(r->>'error','')||')');
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000337101'::uuid,'q2',NULL,NULL,'F2',v_cur,'transferencia',2000,2000,pg_temp.i1('00000000-0000-0000-0000-000000337d01',2,1000));
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'Q2 cantidad 2 -> ok');
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000337101'::uuid,'q3',NULL,NULL,'F3',v_cur,'transferencia',3000,3000,pg_temp.i1('00000000-0000-0000-0000-000000337d01',3,1000));
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'Q3 cantidad 3 -> ok');
  -- 2.0 (entero equivalente) -> aceptado
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000337101'::uuid,'q20',NULL,NULL,'F20',v_cur,'transferencia',2000,2000,pg_temp.i1('00000000-0000-0000-0000-000000337d01',2.0,1000));
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'Q2.0 cantidad 2.0 (entero equivalente) -> ok');
  -- invalidos (mensaje exacto)
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000337101'::uuid,'qbad1',NULL,NULL,'X',v_cur,'transferencia',1000,1000,pg_temp.i1('00000000-0000-0000-0000-000000337d01',1.5,1000));
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR' AND r->>'error'='La cantidad debe ser un número entero mayor o igual a 1', 'Q1.5 -> VALIDATION_ERROR (mensaje exacto)');
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000337101'::uuid,'qbad2',NULL,NULL,'X',v_cur,'transferencia',1000,1000,pg_temp.i1('00000000-0000-0000-0000-000000337d01',0.5,1000));
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'Q0.5 -> VALIDATION_ERROR');
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000337101'::uuid,'qbad3',NULL,NULL,'X',v_cur,'transferencia',1000,1000,pg_temp.i1('00000000-0000-0000-0000-000000337d01',2.0001,1000));
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'Q2.0001 -> VALIDATION_ERROR');
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000337101'::uuid,'qbad4',NULL,NULL,'X',v_cur,'transferencia',1000,1000,pg_temp.i1('00000000-0000-0000-0000-000000337d01',0,1000));
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'Q0 -> VALIDATION_ERROR');
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000337101'::uuid,'qbad5',NULL,NULL,'X',v_cur,'transferencia',1000,1000,pg_temp.i1('00000000-0000-0000-0000-000000337d01',-1,1000));
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'Q-1 -> VALIDATION_ERROR');
  -- NULL quantity
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000337101'::uuid,'qbad6',NULL,NULL,'X',v_cur,'transferencia',1000,1000,
    jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-000000337d01','product_name','P','quantity',NULL,'unit_cost_ars',1000)));
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'Qnull -> VALIDATION_ERROR');
  -- no numerica ("abc")
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000337101'::uuid,'qbad7',NULL,NULL,'X',v_cur,'transferencia',1000,1000,
    jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-000000337d01','product_name','P','quantity','abc','unit_cost_ars',1000)));
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'Qabc (no numerica) -> VALIDATION_ERROR');
  -- fuera de rango
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000337101'::uuid,'qbad8',NULL,NULL,'X',v_cur,'transferencia',1000,1000,pg_temp.i1('00000000-0000-0000-0000-000000337d01',2000000,1000));
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'Qrango (>1e6) -> VALIDATION_ERROR');
  RESET ROLE;
END $$;
-- §2 coherencia: A subio exactamente 1+2+3+2 = 8 -> 108 ; ningun rechazo altero stock
SELECT pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id=:'INVA')=108, 'C1 stock A = 100 + (1+2+3+2.0) = 108 (sin truncado)');
-- item.qty = movement.qty = incremento, para la compra de cantidad 3 (F3)
SELECT pg_temp.assert((SELECT quantity FROM supplier_purchase_items WHERE purchase_id=(SELECT id FROM supplier_purchases WHERE business_id=:'biz' AND invoice_number='F3'))=3, 'C2 supplier_purchase_items.quantity = 3');
SELECT pg_temp.assert((SELECT quantity FROM inventory_movements WHERE reference_id=(SELECT id FROM supplier_purchases WHERE business_id=:'biz' AND invoice_number='F3'))=3, 'C3 inventory_movements.quantity = 3 (= item)');
SELECT pg_temp.assert((SELECT (new_stock-previous_stock) FROM inventory_movements WHERE reference_id=(SELECT id FROM supplier_purchases WHERE business_id=:'biz' AND invoice_number='F3'))=3, 'C4 incremento real de stock = 3');
SELECT pg_temp.assert((SELECT (a.new_data->'inventory'->0->>'quantity')::int FROM finance_audit_log a WHERE a.business_id=:'biz' AND a.action='quick_inventory_purchase' AND a.entity_id=(SELECT id FROM supplier_purchases WHERE business_id=:'biz' AND invoice_number='F3'))=3, 'C5 auditoria.quantity = 3 (= persistida)');
-- ningun rechazo dejo request
SELECT pg_temp.assert((SELECT count(*) FROM quick_purchase_requests WHERE business_id=:'biz' AND idempotency_key LIKE 'qbad%')=0, 'C6 rechazos NO reservaron request');
SELECT pg_temp.assert((SELECT count(*) FROM supplier_purchases WHERE business_id=:'biz' AND invoice_number='X')=0, 'C7 rechazos NO crearon compra');

-- ============ §3 Productos duplicados ========================================
DO $$
DECLARE r jsonb; v_cur date := public.ar_today(); v_stkA int; v_costA numeric; v_req int;
BEGIN
  SELECT stock_quantity, cost_price INTO v_stkA, v_costA FROM inventory WHERE id='00000000-0000-0000-0000-000000337d01';
  SELECT count(*) INTO v_req FROM quick_purchase_requests WHERE business_id='00000000-0000-0000-0000-000000337101';
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000337109';
  -- mismo inventory_id x2, mismo costo
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000337101'::uuid,'dup1',NULL,NULL,'D',v_cur,'transferencia',2000,2000,
    jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-000000337d01','product_name','P','quantity',1,'unit_cost_ars',1000),
                      jsonb_build_object('inventory_id','00000000-0000-0000-0000-000000337d01','product_name','P','quantity',1,'unit_cost_ars',1000)));
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR' AND r->>'error'='El mismo producto no puede aparecer más de una vez', 'D1 duplicado mismo costo -> VALIDATION_ERROR (mensaje exacto)');
  -- x2 costo distinto
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000337101'::uuid,'dup2',NULL,NULL,'D',v_cur,'transferencia',2000,2000,
    jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-000000337d01','product_name','P','quantity',1,'unit_cost_ars',1000),
                      jsonb_build_object('inventory_id','00000000-0000-0000-0000-000000337d01','product_name','P','quantity',1,'unit_cost_ars',1200)));
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'D2 duplicado costo distinto -> VALIDATION_ERROR');
  -- x2 cantidad distinta
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000337101'::uuid,'dup3',NULL,NULL,'D',v_cur,'transferencia',2000,2000,
    jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-000000337d01','product_name','P','quantity',1,'unit_cost_ars',1000),
                      jsonb_build_object('inventory_id','00000000-0000-0000-0000-000000337d01','product_name','P','quantity',3,'unit_cost_ars',1000)));
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'D3 duplicado cantidad distinta -> VALIDATION_ERROR');
  -- mismo nombre, inventory_id DISTINTOS -> valido
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000337101'::uuid,'dup4',NULL,NULL,'D-OK',v_cur,'transferencia',2000,2000,
    jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-000000337d01','product_name','MISMO','quantity',1,'unit_cost_ars',1000),
                      jsonb_build_object('inventory_id','00000000-0000-0000-0000-000000337d02','product_name','MISMO','quantity',1,'unit_cost_ars',1000)));
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'D4 mismo nombre pero inventory_id distintos -> valido');
  RESET ROLE;
  -- los duplicados invalidos no dejaron rastro
  PERFORM pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id='00000000-0000-0000-0000-000000337d01')=v_stkA+1, 'D5 solo D4 (valido, +1) toco stock A; duplicados invalidos no');
  PERFORM pg_temp.assert((SELECT cost_price FROM inventory WHERE id='00000000-0000-0000-0000-000000337d01')=v_costA, 'D6 duplicados invalidos no cambiaron costo A');
  PERFORM pg_temp.assert((SELECT count(*) FROM quick_purchase_requests WHERE business_id='00000000-0000-0000-0000-000000337101' AND idempotency_key IN ('dup1','dup2','dup3'))=0, 'D7 duplicados invalidos: 0 requests');
END $$;

-- ============ §4 Inventario faltante / ajeno =================================
DO $$
DECLARE r jsonb; v_cur date := public.ar_today();
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000337109';
  -- un id inexistente entre dos -> INVENTORY_NOT_FOUND (N esperados <> N encontrados)
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000337101'::uuid,'nf1',NULL,NULL,'NF',v_cur,'transferencia',2000,2000,
    jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-000000337d01','product_name','P','quantity',1,'unit_cost_ars',1000),
                      jsonb_build_object('inventory_id','00000000-0000-0000-0000-000000337d99','product_name','P','quantity',1,'unit_cost_ars',1000)));
  PERFORM pg_temp.assert(r->>'error_code'='INVENTORY_NOT_FOUND' AND r->>'error'='Uno o más productos no existen o no pertenecen al negocio', 'NF1 producto faltante -> INVENTORY_NOT_FOUND (mensaje exacto)');
  RESET ROLE;
END $$;

-- ============ §8 Idempotencia order-independent + conflictos ==================
DO $$
DECLARE r jsonb; v_cur date := public.ar_today(); v_pid uuid; v_stkA int; v_stkB int;
  ab jsonb; ba jsonb;
BEGIN
  ab := jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-000000337d01','product_name','P','quantity',2,'unit_cost_ars',1000),
                          jsonb_build_object('inventory_id','00000000-0000-0000-0000-000000337d02','product_name','P','quantity',3,'unit_cost_ars',1000));
  ba := jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-000000337d02','product_name','P','quantity',3,'unit_cost_ars',1000),
                          jsonb_build_object('inventory_id','00000000-0000-0000-0000-000000337d01','product_name','P','quantity',2,'unit_cost_ars',1000));
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000337109';
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000337101'::uuid,'ORD',NULL,NULL,'O1',v_cur,'transferencia',5000,5000,ab);
  v_pid := (r->>'purchase_id')::uuid;
  SELECT stock_quantity INTO v_stkA FROM inventory WHERE id='00000000-0000-0000-0000-000000337d01';
  SELECT stock_quantity INTO v_stkB FROM inventory WHERE id='00000000-0000-0000-0000-000000337d02';
  -- misma key, orden inverso [B,A] + resto identico -> replay (mismo purchase_id)
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000337101'::uuid,'ORD',NULL,NULL,'O1',v_cur,'transferencia',5000,5000,ba);
  PERFORM pg_temp.assert((r->>'replay')::boolean AND (r->>'purchase_id')::uuid=v_pid, 'ID-ORD [A,B] vs [B,A] -> replay mismo purchase_id (hash order-independent)');
  PERFORM pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id='00000000-0000-0000-0000-000000337d01')=v_stkA AND (SELECT stock_quantity FROM inventory WHERE id='00000000-0000-0000-0000-000000337d02')=v_stkB, 'ID-ORD replay NO volvio a mover stock');
  -- misma key, cantidad distinta -> conflicto
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000337101'::uuid,'ORD',NULL,NULL,'O1',v_cur,'transferencia',5000,5000,
    jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-000000337d01','product_name','P','quantity',9,'unit_cost_ars',1000),
                      jsonb_build_object('inventory_id','00000000-0000-0000-0000-000000337d02','product_name','P','quantity',3,'unit_cost_ars',1000)));
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT', 'ID-QTY cantidad distinta misma key -> IDEMPOTENCY_CONFLICT');
  -- misma key, costo distinto -> conflicto
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000337101'::uuid,'ORD',NULL,NULL,'O1',v_cur,'transferencia',5000,5000,
    jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-000000337d01','product_name','P','quantity',2,'unit_cost_ars',1111),
                      jsonb_build_object('inventory_id','00000000-0000-0000-0000-000000337d02','product_name','P','quantity',3,'unit_cost_ars',1000)));
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT', 'ID-COST costo distinto misma key -> IDEMPOTENCY_CONFLICT');
  RESET ROLE;
END $$;

-- ============ §10 Rollback: falla de auditoria en compra MULTI-item ==========
-- 2 items (A,B): tras escribir AMBOS, la auditoria falla -> AMBOS stocks revierten.
ALTER TABLE finance_audit_log ADD CONSTRAINT tmp_fail_qpi CHECK (action <> 'quick_inventory_purchase') NOT VALID;
DO $$
DECLARE r jsonb; sA int; sB int;
BEGIN
  SELECT stock_quantity INTO sA FROM inventory WHERE id='00000000-0000-0000-0000-000000337d01';
  SELECT stock_quantity INTO sB FROM inventory WHERE id='00000000-0000-0000-0000-000000337d02';
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000337109';
  r := create_quick_inventory_purchase_atomic('00000000-0000-0000-0000-000000337101'::uuid,'RBM',NULL,NULL,'RB',public.ar_today(),'transferencia',5000,5000,
    jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-000000337d01','product_name','P','quantity',4,'unit_cost_ars',1000),
                      jsonb_build_object('inventory_id','00000000-0000-0000-0000-000000337d02','product_name','P','quantity',5,'unit_cost_ars',1000)));
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'error_code'='AUDIT_FAILED', 'RB1 auditoria rota (multi-item) -> AUDIT_FAILED');
  PERFORM pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id='00000000-0000-0000-0000-000000337d01')=sA, 'RB2 stock A revertido (1er item)');
  PERFORM pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id='00000000-0000-0000-0000-000000337d02')=sB, 'RB3 stock B revertido (2do item -> revierte tambien el 1ro)');
  PERFORM pg_temp.assert((SELECT count(*) FROM supplier_purchases WHERE business_id='00000000-0000-0000-0000-000000337101' AND invoice_number='RB')=0, 'RB4 sin compra');
  PERFORM pg_temp.assert((SELECT count(*) FROM inventory_movements WHERE reference_id IN (SELECT id FROM supplier_purchases WHERE invoice_number='RB'))=0, 'RB5 sin movimientos');
  PERFORM pg_temp.assert((SELECT count(*) FROM quick_purchase_requests WHERE business_id='00000000-0000-0000-0000-000000337101' AND idempotency_key='RBM')=0, 'RB6 sin request (retry seguro)');
END $$;
ALTER TABLE finance_audit_log DROP CONSTRAINT tmp_fail_qpi;

-- §12 el cuerpo de la RPC NO usa FLOOR (sin truncado silencioso)
SELECT pg_temp.assert(pg_get_functiondef('public.create_quick_inventory_purchase_atomic(uuid,text,uuid,text,text,date,text,numeric,numeric,jsonb)'::regprocedure) NOT ILIKE '%floor(%', 'STATIC1 cuerpo de la RPC sin llamada a FLOOR()');
-- §5 el cuerpo adquiere locks en orden determinista (ORDER BY id ... FOR UPDATE)
SELECT pg_temp.assert(pg_get_functiondef('public.create_quick_inventory_purchase_atomic(uuid,text,uuid,text,text,date,text,numeric,numeric,jsonb)'::regprocedure) ILIKE '%ORDER BY id%FOR UPDATE%', 'STATIC2 lock determinista ORDER BY id ... FOR UPDATE presente');

SELECT pg_temp.assert(true, '=== etapa7_6e1a_quick_purchase_integrity_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
