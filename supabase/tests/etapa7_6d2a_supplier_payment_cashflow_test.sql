-- ============================================================================
-- M7 Bloque 6D.2a -- Cashflow de pagos a proveedor, replay tras cierre,
-- normalizacion de metodos y consistencia header vs pagos vivos.
--   §1 Todo metodo valido genera exactamente UN financial_movement y aparece como
--      salida percibida en el cashflow canonico (v_finance_cashflow). Incluye cheque
--      (antes no generaba FM -> invisible). Pasivo reducido una vez, P&L intacto.
--   §2 Replay con misma key tras CERRAR el periodo del pago -> {ok:true,replay:true}
--      mismo payment_id, SIN re-ejecutar assert_period_open/escrituras/auditoria.
--      Misma key + payload distinto -> IDEMPOTENCY_CONFLICT. Sin duplicados.
--   §3 Normalizacion de metodo (Efectivo/EFECTIVO/espacios) -> canonico; invalidos
--      -> VALIDATION_ERROR (no caen en rama silenciosa). Efectivo exige caja.
--   §4 supplier_purchases.paid_amount vs SUM(supplier_payments.amount): diagnostico
--      (sin backfill) + auto-sanacion ante header legacy desincronizado.
-- RUN: docker cp ... && psql -X -f (BEGIN + ROLLBACK, no persiste)
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set biz  '00000000-0000-0000-0000-0000002f7101'
\set OA   '00000000-0000-0000-0000-0000002f7109'
\set bizN '00000000-0000-0000-0000-0000002f7201'
\set ON   '00000000-0000-0000-0000-0000002f7209'
\set SUP  '00000000-0000-0000-0000-0000002f7301'
\set SUPN '00000000-0000-0000-0000-0000002f7302'
\set PUR  '00000000-0000-0000-0000-0000002f7401'
\set PUR2 '00000000-0000-0000-0000-0000002f7402'
\set CAJA '00000000-0000-0000-0000-0000002f7601'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'OA'),(:'ON');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','6D2a A',:'OA'),(:'bizN','6D2a SIN CAJA',:'ON');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES (:'biz',:'OA','owner',true),(:'bizN',:'ON','owner',true);
INSERT INTO suppliers(id,business_id,name) VALUES (:'SUP',:'biz','Prov A'),(:'SUPN',:'bizN','Prov N');
INSERT INTO supplier_purchases(id,business_id,supplier_id,total_amount,paid_amount,pending_amount,payment_status,purchase_date) VALUES
  (:'PUR', :'biz',:'SUP',10000,0,10000,'pending',public.ar_today()),
  (:'PUR2',:'biz',:'SUP',5000,0,5000,'pending',public.ar_today());
INSERT INTO cajas(id,business_id,opened_by,status) VALUES (:'CAJA',:'biz',:'OA','abierta');  -- bizN SIN caja
SET LOCAL session_replication_role='origin';

-- ============ §1 Cashflow: todo metodo aparece como salida percibida ==========
DO $$
DECLARE r jsonb; v_cur date := public.ar_today();
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002f7109';
  -- CF1 transferencia (ya generaba FM en 6D.2; se reconfirma en el cashflow)
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000002f7101'::uuid,'00000000-0000-0000-0000-0000002f7301'::uuid,NULL,'Prov A',v_cur,1500,'transferencia','cf-transf',NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'CF1 pago libre transferencia -> ok ('||COALESCE(r->>'error','')||')');
  -- CF2 CHEQUE: antes NO generaba FM -> invisible. Ahora debe aparecer.
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000002f7101'::uuid,'00000000-0000-0000-0000-0000002f7301'::uuid,NULL,'Prov A',v_cur,2500,'cheque','cf-cheque',NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'CF2 pago libre cheque -> ok ('||COALESCE(r->>'error','')||')');
  -- CF3 dolares y otro: tambien generan FM
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000002f7101'::uuid,'00000000-0000-0000-0000-0000002f7301'::uuid,NULL,'Prov A',v_cur,300,'dolares','cf-usd',NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'CF3a pago libre dolares -> ok');
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000002f7101'::uuid,'00000000-0000-0000-0000-0000002f7301'::uuid,NULL,'Prov A',v_cur,400,'otro','cf-otro',NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'CF3b pago libre otro -> ok');
  RESET ROLE;
END $$;
-- transferencia aparece en el cashflow canonico como salida (expense) clase supplier
SELECT pg_temp.assert((SELECT count(*) FROM v_finance_cashflow WHERE business_id=:'biz' AND payment_method='transferencia' AND expense_ars=1500 AND cashflow_class='supplier')=1, 'CF1b transferencia visible en v_finance_cashflow (1 salida supplier)');
SELECT pg_temp.assert((SELECT net_ars FROM v_finance_cashflow WHERE business_id=:'biz' AND payment_method='transferencia' AND expense_ars=1500)=-1500, 'CF1c net_ars = -1500 (salida)');
-- CHEQUE aparece (prueba central del fix 6D.2a)
SELECT pg_temp.assert((SELECT count(*) FROM v_finance_cashflow WHERE business_id=:'biz' AND payment_method='cheque' AND expense_ars=2500 AND cashflow_class='supplier')=1, 'CF2b CHEQUE visible en v_finance_cashflow (fix 6D.2a)');
-- dolares y otro tambien visibles
SELECT pg_temp.assert((SELECT count(*) FROM v_finance_cashflow WHERE business_id=:'biz' AND payment_method='dolares' AND expense_ars=300)=1, 'CF3c dolares visible en cashflow');
SELECT pg_temp.assert((SELECT count(*) FROM v_finance_cashflow WHERE business_id=:'biz' AND payment_method='otro' AND expense_ars=400)=1, 'CF3d otro visible en cashflow');
-- CF4 exactamente UN FM/BFE/account_movement por pago cheque (no duplica)
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'biz' AND metodo_pago='cheque' AND amount=2500 AND source='pago_proveedor')=1, 'CF4a 1 FM cheque');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'biz' AND source='pago_proveedor' AND amount_ars=2500)=1, 'CF4b 1 BFE cheque');
SELECT pg_temp.assert((SELECT count(*) FROM supplier_account_movements WHERE business_id=:'biz' AND credit=2500 AND type='payment')=1, 'CF4c 1 account_movement credito cheque');
-- CF5 pasivo reducido una vez ; P&L intacto (clase fuera del P&L, sin COGS/mercaderia)
SELECT pg_temp.assert((SELECT economic_class FROM business_finance_entries WHERE business_id=:'biz' AND source='pago_proveedor' AND amount_ars=2500)='supplier_liability_payment', 'CF5a BFE cheque clase supplier_liability_payment (fuera del P&L)');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'biz' AND category='mercaderia' AND amount_ars IN (1500,2500,300,400))=0, 'CF5b sin COGS/mercaderia por los pagos');
-- FM referencia el pago (reference_id -> supplier_payments.id) y linkeo bidireccional
SELECT pg_temp.assert((SELECT fm.reference_type FROM financial_movements fm WHERE fm.business_id=:'biz' AND fm.metodo_pago='cheque' AND fm.amount=2500)='supplier_payment', 'CF6a FM.reference_type = supplier_payment');
SELECT pg_temp.assert((SELECT sp.financial_movement_id FROM supplier_payments sp WHERE sp.business_id=:'biz' AND sp.amount=2500)=(SELECT id FROM financial_movements WHERE business_id=:'biz' AND metodo_pago='cheque' AND amount=2500), 'CF6b supplier_payments.financial_movement_id linkeado');

-- ============ §3 Normalizacion de metodos ====================================
DO $$
DECLARE r jsonb; v_cur date := public.ar_today();
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002f7109';  -- OA (con caja)
  -- MN1 'Efectivo' (mayuscula) -> ok, exige caja (hay), persiste canonico 'efectivo'
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000002f7101'::uuid,'00000000-0000-0000-0000-0000002f7301'::uuid,NULL,'Prov A',v_cur,111,'Efectivo','mn1',NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'MN1 Efectivo (mayus) -> ok ('||COALESCE(r->>'error','')||')');
  -- MN2 'EFECTIVO'
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000002f7101'::uuid,'00000000-0000-0000-0000-0000002f7301'::uuid,NULL,'Prov A',v_cur,112,'EFECTIVO','mn2',NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'MN2 EFECTIVO -> ok');
  -- MN3 '  Transferencia  ' (espacios + case)
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000002f7101'::uuid,'00000000-0000-0000-0000-0000002f7301'::uuid,NULL,'Prov A',v_cur,113,'  Transferencia  ','mn3',NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'MN3 "  Transferencia  " -> ok');
  -- MN4 invalido 'bitcoin' -> VALIDATION_ERROR (no silencioso)
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000002f7101'::uuid,'00000000-0000-0000-0000-0000002f7301'::uuid,NULL,'Prov A',v_cur,114,'bitcoin','mn4',NULL);
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'MN4 metodo invalido -> VALIDATION_ERROR');
  -- MN5 vacio -> VALIDATION_ERROR
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000002f7101'::uuid,'00000000-0000-0000-0000-0000002f7301'::uuid,NULL,'Prov A',v_cur,115,'   ','mn5',NULL);
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'MN5 metodo vacio -> VALIDATION_ERROR');
  -- MN6 pay_supplier_purchase invalido -> VALIDATION_ERROR
  r := pay_supplier_purchase_atomic('00000000-0000-0000-0000-0000002f7101'::uuid,'00000000-0000-0000-0000-0000002f7301'::uuid,NULL,'Prov A','00000000-0000-0000-0000-0000002f7401'::uuid,v_cur,100,'bitcoin','mn6',NULL);
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'MN6 pay_purchase metodo invalido -> VALIDATION_ERROR');
  RESET ROLE;
  -- MN7 variante de efectivo SIN caja (bizN) -> CASH_REGISTER_NOT_OPEN (no cae en otro metodo)
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002f7209';  -- ON (sin caja)
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000002f7201'::uuid,'00000000-0000-0000-0000-0000002f7302'::uuid,NULL,'Prov N',v_cur,50,'EFECTIVO','mn7',NULL);
  PERFORM pg_temp.assert(r->>'error_code'='CASH_REGISTER_NOT_OPEN', 'MN7 variante efectivo sin caja -> CASH_REGISTER_NOT_OPEN');
  RESET ROLE;
END $$;
-- MN persistencia canonica: metodo guardado en minuscula sin espacios
SELECT pg_temp.assert((SELECT payment_method FROM supplier_payments WHERE business_id=:'biz' AND amount=111)='efectivo', 'MN1b persiste canonico "efectivo"');
SELECT pg_temp.assert((SELECT payment_method FROM supplier_payments WHERE business_id=:'biz' AND amount=113)='transferencia', 'MN3b persiste canonico "transferencia" (trim+lower)');
-- variante de efectivo usa la caja validada
SELECT pg_temp.assert((SELECT caja_id FROM financial_movements WHERE business_id=:'biz' AND metodo_pago='efectivo' AND amount=111)=:'CAJA', 'MN1c efectivo usa la caja validada');
-- invalidos NO crearon ningun rastro (ni pago ni FM)
SELECT pg_temp.assert((SELECT count(*) FROM supplier_payments WHERE business_id=:'biz' AND amount IN (114,115))=0, 'MN4b/5b metodo invalido no creo pago (sin efecto)');

-- ============ §4 header vs pagos vivos + auto-sanacion legacy =================
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002f7109';
  -- HV2 pagos parciales sobre PUR (transferencia, sin caja requerida)
  r := pay_supplier_purchase_atomic('00000000-0000-0000-0000-0000002f7101'::uuid,'00000000-0000-0000-0000-0000002f7301'::uuid,NULL,'Prov A','00000000-0000-0000-0000-0000002f7401'::uuid,public.ar_today(),3000,'transferencia','hv-a',NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'HV2a pago parcial 3000 -> ok');
  r := pay_supplier_purchase_atomic('00000000-0000-0000-0000-0000002f7101'::uuid,'00000000-0000-0000-0000-0000002f7301'::uuid,NULL,'Prov A','00000000-0000-0000-0000-0000002f7401'::uuid,public.ar_today(),2000,'transferencia','hv-b',NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'HV2b pago parcial 2000 -> ok');
  RESET ROLE;
END $$;
-- HV1 compra nueva PUR2 (sin pagos): header = SUM = 0
SELECT pg_temp.assert((SELECT paid_amount FROM supplier_purchases WHERE id=:'PUR2')=(SELECT COALESCE(SUM(amount),0) FROM supplier_payments WHERE purchase_id=:'PUR2'), 'HV1 compra nueva: paid_amount = SUM(pagos) = 0');
-- HV2c tras parciales: header = SUM (5000)
SELECT pg_temp.assert((SELECT paid_amount FROM supplier_purchases WHERE id=:'PUR')=(SELECT SUM(amount) FROM supplier_payments WHERE purchase_id=:'PUR'), 'HV2c paid_amount = SUM(pagos vivos)');
SELECT pg_temp.assert((SELECT paid_amount FROM supplier_purchases WHERE id=:'PUR')=5000, 'HV2d paid_amount = 5000');

-- HV-LEGACY: header desincronizado a mano -> la RPC recalcula desde pagos vivos y auto-sana
-- (sin backfill externo). Simula un registro legacy: paid_amount inflado sin pagos vivos.
SET LOCAL session_replication_role='replica';
UPDATE supplier_purchases SET paid_amount=99999, pending_amount=-89999 WHERE id=:'PUR2';  -- estado corrupto legacy
SET LOCAL session_replication_role='origin';
SELECT pg_temp.assert((SELECT paid_amount FROM supplier_purchases WHERE id=:'PUR2')<>(SELECT COALESCE(SUM(amount),0) FROM supplier_payments WHERE purchase_id=:'PUR2'), 'HV-L1 diagnostico: header legacy DESINCRONIZADO detectado');
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002f7109';
  -- La RPC ignora el header corrupto: v_pending = total(5000) - SUM(vivos=0) = 5000 -> 500 permitido
  r := pay_supplier_purchase_atomic('00000000-0000-0000-0000-0000002f7101'::uuid,'00000000-0000-0000-0000-0000002f7301'::uuid,NULL,'Prov A','00000000-0000-0000-0000-0000002f7402'::uuid,public.ar_today(),500,'transferencia','hv-legacy',NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'HV-L2 pago sobre compra legacy -> ok (recalcula desde pagos vivos, ignora header corrupto)');
  RESET ROLE;
END $$;
-- tras el pago, el header se auto-sana a SUM(pagos vivos) = 500 (no arrastra el 99999)
SELECT pg_temp.assert((SELECT paid_amount FROM supplier_purchases WHERE id=:'PUR2')=(SELECT SUM(amount) FROM supplier_payments WHERE purchase_id=:'PUR2'), 'HV-L3 auto-sanacion: paid_amount = SUM(pagos vivos) tras el pago');
SELECT pg_temp.assert((SELECT paid_amount FROM supplier_purchases WHERE id=:'PUR2')=500, 'HV-L4 paid_amount = 500 (no arrastra el 99999 legacy)');

-- ============ §2 Replay tras CERRAR el periodo del pago =======================
-- Pagos con fecha en el mes ANTERIOR, luego se cierra ese mes; el replay debe
-- retornar sin volver a pasar por assert_period_open (que ya bloquearia).
DO $$
DECLARE r jsonb; v_prev date := date_trunc('month', public.ar_today() - interval '1 month')::date + 5;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002f7109';
  -- RC1 pago libre en mes anterior (periodo aun abierto), key RKF
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000002f7101'::uuid,'00000000-0000-0000-0000-0000002f7301'::uuid,NULL,'Prov A',v_prev,700,'transferencia','rc-free','RKF');
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean IS FALSE, 'RC1 pago libre mes anterior -> ok ('||COALESCE(r->>'error','')||')');
  -- RC2 pago de compra en mes anterior (PUR), key RKP
  r := pay_supplier_purchase_atomic('00000000-0000-0000-0000-0000002f7101'::uuid,'00000000-0000-0000-0000-0000002f7301'::uuid,NULL,'Prov A','00000000-0000-0000-0000-0000002f7401'::uuid,v_prev,800,'transferencia','rc-pur','RKP');
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean IS FALSE, 'RC2 pago compra mes anterior -> ok');
  RESET ROLE;
END $$;
-- cerrar el mes anterior
DO $$ DECLARE v_p1 date := date_trunc('month', public.ar_today() - interval '1 month')::date;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002f7109';
  PERFORM close_period('00000000-0000-0000-0000-0000002f7101'::uuid, v_p1, 'cierre 6D2a'); RESET ROLE;
END $$;
-- guard: un pago NUEVO con fecha en el mes cerrado se bloquea (confirma que el periodo esta cerrado)
DO $$
DECLARE r jsonb; v_prev date := date_trunc('month', public.ar_today() - interval '1 month')::date + 6;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002f7109';
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000002f7101'::uuid,'00000000-0000-0000-0000-0000002f7301'::uuid,NULL,'Prov A',v_prev,1,'transferencia','rc-blocked',NULL);
  PERFORM pg_temp.assert(r->>'error_code'='PERIOD_CLOSED', 'RC3 pago NUEVO en periodo cerrado -> PERIOD_CLOSED (guard activo)');
  -- RC4 replay pago libre misma key+payload tras cierre -> replay true (NO pasa por el guard)
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000002f7101'::uuid,'00000000-0000-0000-0000-0000002f7301'::uuid,NULL,'Prov A',(date_trunc('month', public.ar_today() - interval '1 month')::date + 5),700,'transferencia','rc-free','RKF');
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean, 'RC4 replay pago libre tras cierre -> ok,replay (sin re-ejecutar guard)');
  -- RC5 replay pago compra misma key+payload tras cierre -> replay true
  r := pay_supplier_purchase_atomic('00000000-0000-0000-0000-0000002f7101'::uuid,'00000000-0000-0000-0000-0000002f7301'::uuid,NULL,'Prov A','00000000-0000-0000-0000-0000002f7401'::uuid,(date_trunc('month', public.ar_today() - interval '1 month')::date + 5),800,'transferencia','rc-pur','RKP');
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean, 'RC5 replay pago compra tras cierre -> ok,replay');
  -- RC6 misma key + payload DISTINTO tras cierre -> IDEMPOTENCY_CONFLICT (no PERIOD_CLOSED)
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000002f7101'::uuid,'00000000-0000-0000-0000-0000002f7301'::uuid,NULL,'Prov A',(date_trunc('month', public.ar_today() - interval '1 month')::date + 5),701,'transferencia','rc-free','RKF');
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT', 'RC6 misma key payload distinto tras cierre -> IDEMPOTENCY_CONFLICT');
  RESET ROLE;
END $$;
-- RC7 replay no duplico ni pagos ni movimientos
SELECT pg_temp.assert((SELECT count(*) FROM supplier_payments WHERE business_id=:'biz' AND amount=700 AND purchase_id IS NULL)=1, 'RC7a replay libre no duplica pago');
SELECT pg_temp.assert((SELECT count(*) FROM supplier_payments WHERE purchase_id=:'PUR' AND amount=800)=1, 'RC7b replay compra no duplica pago');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'biz' AND amount=700 AND metodo_pago='transferencia')=1, 'RC7c replay libre no duplica FM');
-- RC8 el replay del pago de compra NO altero el header de la compra
SELECT pg_temp.assert((SELECT paid_amount FROM supplier_purchases WHERE id=:'PUR')=(SELECT SUM(amount) FROM supplier_payments WHERE purchase_id=:'PUR'), 'RC8 header compra = SUM pagos vivos tras replay (sin cambios espurios)');

SELECT pg_temp.assert(true, '=== etapa7_6d2a_supplier_payment_cashflow_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
