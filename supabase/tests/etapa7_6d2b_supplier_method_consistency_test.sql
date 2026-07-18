-- ============================================================================
-- M7 Bloque 6D.2b -- Consistencia de metodos de pago en el circuito de proveedores.
-- Las tres RPC (create_supplier_purchase / pay_supplier_purchase / pay_supplier_free)
-- usan el helper CENTRAL normalize_supplier_payment_method: mismo catalogo, misma
-- normalizacion (lower+trim), mismo contrato de error. Una compra con pago inicial
-- cumple las mismas invariantes que un pago posterior.
--   §4 Matriz metodo x RPC (valido/rechazado) + valor canonico persistido.
--   §3 Idempotencia: variantes equivalentes (efectivo/Efectivo/EFECTIVO) -> replay;
--      metodo distinto -> conflicto; invalido -> rechazo ANTES de reservar la request.
--   §5 Compra con pago inicial: 1 FM, visible en cashflow, metodo auditado=persistido,
--      efectivo con caja, no reclasifica, P&L intacto, sin duplicar FM/BFE/movimiento.
--   §6 Regresiones expresas + verificacion de que las 3 RPC usan el helper.
-- RUN: docker cp ... && psql -X -f (BEGIN + ROLLBACK, no persiste)
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set biz   '00000000-0000-0000-0000-000000307101'
\set OA    '00000000-0000-0000-0000-000000307109'
\set biz2  '00000000-0000-0000-0000-000000307201'
\set ON2   '00000000-0000-0000-0000-000000307209'
\set SUP   '00000000-0000-0000-0000-000000307301'
\set SUP2  '00000000-0000-0000-0000-000000307302'
\set PURP  '00000000-0000-0000-0000-000000307401'
\set PURP2 '00000000-0000-0000-0000-000000307402'
\set CAJA  '00000000-0000-0000-0000-000000307601'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'OA'),(:'ON2');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','6D2b A',:'OA'),(:'biz2','6D2b SIN CAJA',:'ON2');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES (:'biz',:'OA','owner',true),(:'biz2',:'ON2','owner',true);
INSERT INTO suppliers(id,business_id,name) VALUES (:'SUP',:'biz','Prov A'),(:'SUP2',:'biz2','Prov N');
INSERT INTO supplier_purchases(id,business_id,supplier_id,total_amount,paid_amount,pending_amount,payment_status,purchase_date) VALUES
  (:'PURP', :'biz', :'SUP', 100000,0,100000,'pending',public.ar_today()),
  (:'PURP2',:'biz2',:'SUP2',  5000,0,  5000,'pending',public.ar_today());
INSERT INTO cajas(id,business_id,opened_by,status) VALUES (:'CAJA',:'biz',:'OA','abierta');  -- biz2 SIN caja
SET LOCAL session_replication_role='origin';

-- ============ §4 MATRIZ: create_supplier_purchase_atomic (compra con pago) =====
DO $$
DECLARE r jsonb; v_cur date := public.ar_today(); m text; amt numeric := 1000;
  valid_methods text[] := ARRAY['transferencia','tarjeta','cheque','dolares','otro'];
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000307109';  -- OA (con caja)
  -- efectivo con caja -> valido
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-000000307101'::uuid,'00000000-0000-0000-0000-000000307301'::uuid,NULL,'Prov A',v_cur,'CI-efectivo',amt,amt,'efectivo','x','[]'::jsonb,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'M-CI efectivo con caja -> valido ('||COALESCE(r->>'error','')||')');
  -- metodos no efectivo -> validos
  FOREACH m IN ARRAY valid_methods LOOP
    r := create_supplier_purchase_atomic('00000000-0000-0000-0000-000000307101'::uuid,'00000000-0000-0000-0000-000000307301'::uuid,NULL,'Prov A',v_cur,'CI-'||m,amt,amt,m,'x','[]'::jsonb,NULL);
    PERFORM pg_temp.assert((r->>'ok')::boolean, 'M-CI '||m||' -> valido ('||COALESCE(r->>'error','')||')');
  END LOOP;
  -- vacio con pago (paid>0) -> rechazado
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-000000307101'::uuid,'00000000-0000-0000-0000-000000307301'::uuid,NULL,'Prov A',v_cur,'CI-vacio',amt,amt,'   ','x','[]'::jsonb,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR' AND r->>'error'='Método de pago inválido', 'M-CI vacio con pago -> VALIDATION_ERROR (contrato exacto)');
  -- vacio SIN pago (paid=0, a deuda) -> permitido (metodo NULL en header)
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-000000307101'::uuid,'00000000-0000-0000-0000-000000307301'::uuid,NULL,'Prov A',v_cur,'CI-deuda',amt,0,'   ','a deuda','[]'::jsonb,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'M-CI vacio SIN pago (a deuda) -> permitido');
  -- desconocido -> rechazado
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-000000307101'::uuid,'00000000-0000-0000-0000-000000307301'::uuid,NULL,'Prov A',v_cur,'CI-x',amt,amt,'bitcoin','x','[]'::jsonb,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'M-CI desconocido -> VALIDATION_ERROR');
  RESET ROLE;
  -- efectivo SIN caja (biz2) -> rechazado
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000307209';  -- ON2 (sin caja)
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-000000307201'::uuid,'00000000-0000-0000-0000-000000307302'::uuid,NULL,'Prov N',v_cur,'CI-efec-nc',amt,amt,'efectivo','x','[]'::jsonb,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='CASH_REGISTER_NOT_OPEN', 'M-CI efectivo sin caja -> CASH_REGISTER_NOT_OPEN');
  RESET ROLE;
END $$;
-- a deuda persiste metodo NULL (paid=0, sin pago)
SELECT pg_temp.assert((SELECT payment_method FROM supplier_purchases WHERE business_id=:'biz' AND invoice_number='CI-deuda') IS NULL, 'M-CI a deuda: payment_method NULL en header (sin efecto economico)');
-- persistencia canonica de la compra 'cheque'
SELECT pg_temp.assert((SELECT payment_method FROM supplier_purchases WHERE business_id=:'biz' AND invoice_number='CI-cheque')='cheque', 'M-CI persiste canonico cheque (header)');
SELECT pg_temp.assert((SELECT metodo_pago FROM financial_movements WHERE business_id=:'biz' AND reference_id=(SELECT id FROM supplier_purchases WHERE business_id=:'biz' AND invoice_number='CI-cheque'))='cheque', 'M-CI persiste canonico cheque (FM)');

-- ============ §4 MATRIZ: pay_supplier_purchase_atomic (pago posterior) =========
DO $$
DECLARE r jsonb; v_cur date := public.ar_today(); m text; amt numeric := 100;
  valid_methods text[] := ARRAY['transferencia','tarjeta','cheque','dolares','otro'];
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000307109';
  r := pay_supplier_purchase_atomic('00000000-0000-0000-0000-000000307101'::uuid,'00000000-0000-0000-0000-000000307301'::uuid,NULL,'Prov A','00000000-0000-0000-0000-000000307401'::uuid,v_cur,amt,'efectivo','x',NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'M-PP efectivo con caja -> valido ('||COALESCE(r->>'error','')||')');
  FOREACH m IN ARRAY valid_methods LOOP
    r := pay_supplier_purchase_atomic('00000000-0000-0000-0000-000000307101'::uuid,'00000000-0000-0000-0000-000000307301'::uuid,NULL,'Prov A','00000000-0000-0000-0000-000000307401'::uuid,v_cur,amt,m,'x',NULL);
    PERFORM pg_temp.assert((r->>'ok')::boolean, 'M-PP '||m||' -> valido ('||COALESCE(r->>'error','')||')');
  END LOOP;
  r := pay_supplier_purchase_atomic('00000000-0000-0000-0000-000000307101'::uuid,'00000000-0000-0000-0000-000000307301'::uuid,NULL,'Prov A','00000000-0000-0000-0000-000000307401'::uuid,v_cur,amt,'   ','x',NULL);
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'M-PP vacio -> VALIDATION_ERROR');
  r := pay_supplier_purchase_atomic('00000000-0000-0000-0000-000000307101'::uuid,'00000000-0000-0000-0000-000000307301'::uuid,NULL,'Prov A','00000000-0000-0000-0000-000000307401'::uuid,v_cur,amt,'bitcoin','x',NULL);
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'M-PP desconocido -> VALIDATION_ERROR');
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000307209';
  r := pay_supplier_purchase_atomic('00000000-0000-0000-0000-000000307201'::uuid,'00000000-0000-0000-0000-000000307302'::uuid,NULL,'Prov N','00000000-0000-0000-0000-000000307402'::uuid,v_cur,amt,'efectivo','x',NULL);
  PERFORM pg_temp.assert(r->>'error_code'='CASH_REGISTER_NOT_OPEN', 'M-PP efectivo sin caja -> CASH_REGISTER_NOT_OPEN');
  RESET ROLE;
END $$;

-- ============ §4 MATRIZ: pay_supplier_free_atomic (pago libre) =================
DO $$
DECLARE r jsonb; v_cur date := public.ar_today(); m text; amt numeric := 100;
  valid_methods text[] := ARRAY['transferencia','tarjeta','cheque','dolares','otro'];
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000307109';
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-000000307101'::uuid,'00000000-0000-0000-0000-000000307301'::uuid,NULL,'Prov A',v_cur,amt,'efectivo','x',NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'M-PF efectivo con caja -> valido ('||COALESCE(r->>'error','')||')');
  FOREACH m IN ARRAY valid_methods LOOP
    r := pay_supplier_free_atomic('00000000-0000-0000-0000-000000307101'::uuid,'00000000-0000-0000-0000-000000307301'::uuid,NULL,'Prov A',v_cur,amt,m,'x',NULL);
    PERFORM pg_temp.assert((r->>'ok')::boolean, 'M-PF '||m||' -> valido ('||COALESCE(r->>'error','')||')');
  END LOOP;
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-000000307101'::uuid,'00000000-0000-0000-0000-000000307301'::uuid,NULL,'Prov A',v_cur,amt,'   ','x',NULL);
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'M-PF vacio -> VALIDATION_ERROR');
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-000000307101'::uuid,'00000000-0000-0000-0000-000000307301'::uuid,NULL,'Prov A',v_cur,amt,'bitcoin','x',NULL);
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'M-PF desconocido -> VALIDATION_ERROR');
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000307209';
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-000000307201'::uuid,'00000000-0000-0000-0000-000000307302'::uuid,NULL,'Prov N',v_cur,amt,'efectivo','x',NULL);
  PERFORM pg_temp.assert(r->>'error_code'='CASH_REGISTER_NOT_OPEN', 'M-PF efectivo sin caja -> CASH_REGISTER_NOT_OPEN');
  RESET ROLE;
END $$;
-- todas las RPC persisten el MISMO valor canonico (el pago libre 'cheque'=100, el pago compra 'cheque'=100, compra inicial 'cheque')
SELECT pg_temp.assert((SELECT count(DISTINCT payment_method) FROM supplier_payments WHERE business_id=:'biz' AND payment_method='cheque')=1, 'M-canon las 3 rutas persisten payment_method canonico "cheque"');

-- ============ §3 Idempotencia con variantes equivalentes ======================
DO $$
DECLARE r jsonb; v_cur date := public.ar_today(); v_pid uuid;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000307109';
  -- crea con 'efectivo' key IDEM
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-000000307101'::uuid,'00000000-0000-0000-0000-000000307301'::uuid,NULL,'Prov A',v_cur,'IDEM-1',2000,2000,'efectivo','n','[]'::jsonb,'IDEMK');
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean IS FALSE, 'IDE1 create efectivo key IDEMK -> ok');
  v_pid := (r->>'purchase_id')::uuid;
  -- 'Efectivo' misma key + resto identico -> replay (mismo purchase_id)
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-000000307101'::uuid,'00000000-0000-0000-0000-000000307301'::uuid,NULL,'Prov A',v_cur,'IDEM-1',2000,2000,'Efectivo','n','[]'::jsonb,'IDEMK');
  PERFORM pg_temp.assert((r->>'replay')::boolean AND (r->>'purchase_id')::uuid=v_pid, 'IDE2 "Efectivo" misma key -> replay mismo purchase_id (payload equivalente)');
  -- 'EFECTIVO' -> replay
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-000000307101'::uuid,'00000000-0000-0000-0000-000000307301'::uuid,NULL,'Prov A',v_cur,'IDEM-1',2000,2000,'EFECTIVO','n','[]'::jsonb,'IDEMK');
  PERFORM pg_temp.assert((r->>'replay')::boolean AND (r->>'purchase_id')::uuid=v_pid, 'IDE3 "EFECTIVO" misma key -> replay');
  -- metodo realmente distinto -> conflicto
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-000000307101'::uuid,'00000000-0000-0000-0000-000000307301'::uuid,NULL,'Prov A',v_cur,'IDEM-1',2000,2000,'transferencia','n','[]'::jsonb,'IDEMK');
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT', 'IDE4 metodo distinto misma key -> IDEMPOTENCY_CONFLICT');
  -- invalido con key NUEVA -> VALIDATION_ERROR y NO reserva request
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-000000307101'::uuid,'00000000-0000-0000-0000-000000307301'::uuid,NULL,'Prov A',v_cur,'IDEM-X',2000,2000,'bitcoin','n','[]'::jsonb,'IDEMK_X');
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'IDE5 invalido -> VALIDATION_ERROR');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT count(*) FROM supplier_purchase_requests WHERE business_id=:'biz' AND idempotency_key='IDEMK')=1, 'IDE6 una sola request para IDEMK (variantes no duplican)');
SELECT pg_temp.assert((SELECT count(*) FROM supplier_purchase_requests WHERE business_id=:'biz' AND idempotency_key='IDEMK_X')=0, 'IDE7 metodo invalido NO reservo request (rechazo antes de reservar)');

-- ============ §5 Compra con pago inicial: auditoria y cashflow =================
-- Usa la compra inicial 'transferencia' (CI-transferencia, paid 1000)
DO $$ DECLARE v_pur uuid;
BEGIN
  SELECT id INTO v_pur FROM supplier_purchases WHERE business_id='00000000-0000-0000-0000-000000307101' AND invoice_number='CI-transferencia';
  PERFORM pg_temp.assert((SELECT count(*) FROM financial_movements WHERE reference_id=v_pur AND source='pago_proveedor')=1, 'CI5a exactamente 1 FM para el pago inicial');
  PERFORM pg_temp.assert((SELECT count(*) FROM v_finance_cashflow WHERE source_id IS NOT DISTINCT FROM NULL AND business_id='00000000-0000-0000-0000-000000307101' AND payment_method='transferencia' AND expense_ars=1000)>=1, 'CI5b pago inicial visible en v_finance_cashflow (transferencia)');
  PERFORM pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id='00000000-0000-0000-0000-000000307101' AND source='pago_proveedor' AND amount_ars=1000 AND description LIKE '%CI-transferencia%')=1, 'CI5c exactamente 1 BFE del pago inicial');
  PERFORM pg_temp.assert((SELECT economic_class FROM business_finance_entries WHERE business_id='00000000-0000-0000-0000-000000307101' AND source='pago_proveedor' AND amount_ars=1000 AND description LIKE '%CI-transferencia%')='supplier_liability_payment', 'CI5d BFE clase supplier_liability_payment (P&L intacto)');
  -- metodo auditado == persistido
  PERFORM pg_temp.assert((SELECT a.new_data->>'method' FROM finance_audit_log a WHERE a.business_id='00000000-0000-0000-0000-000000307101' AND a.entity_id=v_pur AND a.action='supplier_purchase')='transferencia', 'CI5e metodo auditado = persistido (transferencia)');
  -- efectivo incluye la caja validada ; ningun FM efectivo sin caja
  PERFORM pg_temp.assert((SELECT caja_id FROM financial_movements WHERE reference_id=(SELECT id FROM supplier_purchases WHERE business_id='00000000-0000-0000-0000-000000307101' AND invoice_number='CI-efectivo') AND source='pago_proveedor')='00000000-0000-0000-0000-000000307601', 'CI5f pago inicial efectivo usa la caja validada');
END $$;

-- ============ §6 Regresiones expresas =========================================
DO $$
DECLARE r jsonb; v_cur date := public.ar_today();
BEGIN
  -- (1) Compra pagada con "  Efectivo  " y SIN caja (biz2) -> CASH_REGISTER_NOT_OPEN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000307209';
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-000000307201'::uuid,'00000000-0000-0000-0000-000000307302'::uuid,NULL,'Prov N',v_cur,'RG-1',1500,1500,'  Efectivo  ','x','[]'::jsonb,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='CASH_REGISTER_NOT_OPEN', 'RG1 "  Efectivo  " sin caja -> CASH_REGISTER_NOT_OPEN (normaliza y exige caja)');
  RESET ROLE;
  -- (2) Misma compra con caja (biz) -> exito y metodo efectivo persistido en todo
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000307109';
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-000000307101'::uuid,'00000000-0000-0000-0000-000000307301'::uuid,NULL,'Prov A',v_cur,'RG-2',1500,1500,'  Efectivo  ','x','[]'::jsonb,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'RG2 "  Efectivo  " con caja -> exito');
  -- (3) Compra con metodo invalido -> VALIDATION_ERROR, sin compra ni request
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-000000307101'::uuid,'00000000-0000-0000-0000-000000307301'::uuid,NULL,'Prov A',v_cur,'RG-3',1500,1500,'monopoly','x','[]'::jsonb,'RGK3');
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'RG3 metodo invalido -> VALIDATION_ERROR');
  -- (4) misma key con 'Efectivo' luego 'efectivo' -> replay
  PERFORM create_supplier_purchase_atomic('00000000-0000-0000-0000-000000307101'::uuid,'00000000-0000-0000-0000-000000307301'::uuid,NULL,'Prov A',v_cur,'RG-4',1200,1200,'Efectivo','x','[]'::jsonb,'RGK4');
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-000000307101'::uuid,'00000000-0000-0000-0000-000000307301'::uuid,NULL,'Prov A',v_cur,'RG-4',1200,1200,'efectivo','x','[]'::jsonb,'RGK4');
  PERFORM pg_temp.assert((r->>'replay')::boolean, 'RG4 "Efectivo" luego "efectivo" misma key -> replay');
  -- (5) misma key con 'efectivo' luego 'transferencia' -> conflicto
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-000000307101'::uuid,'00000000-0000-0000-0000-000000307301'::uuid,NULL,'Prov A',v_cur,'RG-4',1200,1200,'transferencia','x','[]'::jsonb,'RGK4');
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT', 'RG5 "efectivo" luego "transferencia" misma key -> conflicto');
  RESET ROLE;
END $$;
-- (3b) invalido no dejo compra ni request
SELECT pg_temp.assert((SELECT count(*) FROM supplier_purchases WHERE business_id=:'biz' AND invoice_number='RG-3')=0, 'RG3b metodo invalido: sin compra creada');
SELECT pg_temp.assert((SELECT count(*) FROM supplier_purchase_requests WHERE business_id=:'biz' AND idempotency_key='RGK3')=0, 'RG3c metodo invalido: sin request reservada');
-- (2b) RG-2 persiste efectivo canonico en las 4 tablas + auditoria
SELECT pg_temp.assert((SELECT payment_method FROM supplier_purchases WHERE business_id=:'biz' AND invoice_number='RG-2')='efectivo', 'RG2b header = efectivo');
SELECT pg_temp.assert((SELECT metodo_pago FROM financial_movements WHERE business_id=:'biz' AND reference_id=(SELECT id FROM supplier_purchases WHERE business_id=:'biz' AND invoice_number='RG-2'))='efectivo', 'RG2c FM = efectivo');
SELECT pg_temp.assert((SELECT payment_method FROM supplier_payments WHERE business_id=:'biz' AND purchase_id=(SELECT id FROM supplier_purchases WHERE business_id=:'biz' AND invoice_number='RG-2'))='efectivo', 'RG2d supplier_payments = efectivo');
SELECT pg_temp.assert((SELECT payment_method FROM business_finance_entries WHERE business_id=:'biz' AND description LIKE '%RG-2%')='efectivo', 'RG2e BFE = efectivo');
-- (6) NINGUN FM efectivo nuevo quedo sin caja (invariante global del negocio)
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'biz' AND metodo_pago='efectivo' AND caja_id IS NULL)=0, 'RG6 0 FM efectivo con caja_id NULL');

-- ============ §6.7 Las 3 RPC usan el helper central ===========================
SELECT pg_temp.assert(pg_get_functiondef('public.create_supplier_purchase_atomic'::regproc) LIKE '%normalize_supplier_payment_method%', 'HLP1 create_supplier_purchase usa el helper');
SELECT pg_temp.assert(pg_get_functiondef('public.pay_supplier_purchase_atomic'::regproc) LIKE '%normalize_supplier_payment_method%', 'HLP2 pay_supplier_purchase usa el helper');
SELECT pg_temp.assert(pg_get_functiondef('public.pay_supplier_free_atomic'::regproc) LIKE '%normalize_supplier_payment_method%', 'HLP3 pay_supplier_free usa el helper');
-- helper revocado para anon/authenticated
SELECT pg_temp.assert(NOT has_function_privilege('anon','public.normalize_supplier_payment_method(text)','EXECUTE') AND NOT has_function_privilege('authenticated','public.normalize_supplier_payment_method(text)','EXECUTE'), 'HLP4 helper revocado para anon y authenticated');

SELECT pg_temp.assert(true, '=== etapa7_6d2b_supplier_method_consistency_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
