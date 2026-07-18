-- ============================================================================
-- M7 Bloque 6F.2 -- reverse_order_payment_atomic (compensatoria append-only).
-- INVARIANTE CENTRAL: revertir HOY un cobro de un periodo CERRADO genera la
-- compensacion en el periodo ACTUAL y NUNCA cambia los numeros del periodo
-- original. El cobro original conserva fecha/monto/metodo/signo.
--   Actor canonico (ignora p_user_id) · guard SOLO de la fecha de la reversa ·
--   idempotencia DURABLE (sin fecha en el hash) · doble reversa serializada ·
--   audit scope + evento unico · rollback · error_code.
-- RUN: docker cp ... && psql -X -f (BEGIN + ROLLBACK)
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;
-- cashflow neto de un rango
CREATE OR REPLACE FUNCTION pg_temp.cf(d1 date, d2 date) RETURNS numeric LANGUAGE sql AS $$
  SELECT COALESCE(SUM(net_ars),0) FROM v_finance_cashflow
   WHERE business_id='00000000-0000-0000-0000-0000004a7101' AND movement_date_ar BETWEEN d1 AND d2 $$;

\set biz  '00000000-0000-0000-0000-0000004a7101'
\set OA   '00000000-0000-0000-0000-0000004a7109'
\set ADM  '00000000-0000-0000-0000-0000004a7108'
\set biz2 '00000000-0000-0000-0000-0000004a7201'
\set OB   '00000000-0000-0000-0000-0000004a7209'
\set ORD  '00000000-0000-0000-0000-0000004a7301'
\set ORD2 '00000000-0000-0000-0000-0000004a7302'
\set CAJA '00000000-0000-0000-0000-0000004a7601'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'OA'),(:'ADM'),(:'OB');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','6F2 A',:'OA'),(:'biz2','6F2 B',:'OB');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES (:'biz',:'OA','owner',true),(:'biz',:'ADM','admin',true),(:'biz2',:'OB','owner',true);
INSERT INTO orders(id,business_id) VALUES (:'ORD',:'biz'),(:'ORD2',:'biz2');
INSERT INTO cajas(id,business_id,opened_by,status) VALUES (:'CAJA',:'biz',:'OA','abierta');
SET LOCAL session_replication_role='origin';

-- Cobro de orden en el MES ANTERIOR (periodo aun abierto), efectivo 100
DO $$
DECLARE r jsonb; v_prev date := date_trunc('month', public.ar_today() - interval '1 month')::date + 5;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000004a7109';
  r := create_order_payment_atomic('00000000-0000-0000-0000-0000004a7101'::uuid,'00000000-0000-0000-0000-0000004a7301'::uuid,
    100,'cash','ARS',1,'00000000-0000-0000-0000-0000004a7109'::uuid,'cobro jun',v_prev,'pay-jun');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'SETUP cobro de orden mes anterior -> ok ('||COALESCE(r->>'error','')||')');
  RESET ROLE;
END $$;
-- CERRAR el mes anterior (periodo del cobro original inmutable)
DO $$ DECLARE v_p1 date := date_trunc('month', public.ar_today() - interval '1 month')::date;
BEGIN SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000004a7109';
  PERFORM close_period('00000000-0000-0000-0000-0000004a7101'::uuid, v_p1, 'cierre 6F2'); RESET ROLE; END $$;

-- Foto del periodo ORIGINAL + snapshot del cobro
CREATE TEMP TABLE pg_temp_snap AS
  SELECT pg_temp.cf(date_trunc('month', public.ar_today() - interval '1 month')::date,
                    (date_trunc('month', public.ar_today())::date - 1)) AS cf_prev_before,
         (SELECT to_jsonb(p) - 'reversed_at' - 'reversed_by' FROM order_payments p WHERE p.business_id='00000000-0000-0000-0000-0000004a7101') AS pay_before;
SELECT pg_temp.assert((SELECT cf_prev_before FROM pg_temp_snap)=100, 'INV0 el mes anterior arranca con cashflow +100');

-- ============ Seguridad / contrato de error ================================
DO $$
DECLARE r jsonb; v_pay uuid;
BEGIN
  SELECT id INTO v_pay FROM order_payments WHERE business_id='00000000-0000-0000-0000-0000004a7101' LIMIT 1;
  SET LOCAL "request.jwt.claim.sub" = '';
  r := reverse_order_payment_atomic('00000000-0000-0000-0000-0000004a7101'::uuid, v_pay, 'x', NULL, NULL);
  PERFORM pg_temp.assert(r->>'error_code'='UNAUTHORIZED', 'S1 sin auth -> UNAUTHORIZED');
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000004a7209';  -- OB
  r := reverse_order_payment_atomic('00000000-0000-0000-0000-0000004a7101'::uuid, v_pay, 'x', NULL, NULL);
  PERFORM pg_temp.assert(r->>'error_code'='FORBIDDEN', 'S2 cross-tenant -> FORBIDDEN');
  -- pago ajeno (bizB pide revertir un pago de bizA usando SU negocio)
  r := reverse_order_payment_atomic('00000000-0000-0000-0000-0000004a7201'::uuid, v_pay, 'x', NULL, NULL);
  PERFORM pg_temp.assert(r->>'error_code'='PAYMENT_NOT_FOUND', 'S3 pago de otro negocio -> PAYMENT_NOT_FOUND');
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000004a7109';
  r := reverse_order_payment_atomic('00000000-0000-0000-0000-0000004a7101'::uuid, v_pay, '   ', NULL, NULL);
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'S4 motivo vacio -> VALIDATION_ERROR');
  r := reverse_order_payment_atomic('00000000-0000-0000-0000-0000004a7101'::uuid,'00000000-0000-0000-0000-0000009999f1'::uuid,'x', NULL, NULL);
  PERFORM pg_temp.assert(r->>'error_code'='PAYMENT_NOT_FOUND', 'S5 pago inexistente -> PAYMENT_NOT_FOUND');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT reversed_at FROM order_payments WHERE business_id=:'biz' LIMIT 1) IS NULL, 'S6 ningun rechazo reverso el cobro');

-- ============ Reversa normal: cobro de periodo CERRADO, reversa HOY =========
DO $$
DECLARE r jsonb; v_pay uuid;
BEGIN
  SELECT id INTO v_pay FROM order_payments WHERE business_id='00000000-0000-0000-0000-0000004a7101' LIMIT 1;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000004a7109';  -- OA
  -- p_user_id APOCRIFO (ADM): la atribucion debe usar auth.uid() (OA)
  r := reverse_order_payment_atomic('00000000-0000-0000-0000-0000004a7101'::uuid, v_pay, 'Duplicado',
       '00000000-0000-0000-0000-0000004a7108'::uuid, 'RK1');
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean IS FALSE, 'R1 cobro de periodo CERRADO + reversa hoy -> permitido ('||COALESCE(r->>'error','')||')');
  PERFORM pg_temp.assert((r->>'reversal_financial_movement_id') IS NOT NULL, 'R2 devuelve reversal_financial_movement_id');
END $$;

-- ============ INVARIANTE: periodo original inmutable ========================
SELECT pg_temp.assert(
  pg_temp.cf(date_trunc('month', public.ar_today() - interval '1 month')::date, (date_trunc('month', public.ar_today())::date - 1))
  = (SELECT cf_prev_before FROM pg_temp_snap), 'INV1 cashflow del periodo ORIGINAL identico antes/despues');
SELECT pg_temp.assert(
  pg_temp.cf(date_trunc('month', public.ar_today() - interval '1 month')::date, (date_trunc('month', public.ar_today())::date - 1)) = 100,
  'INV2 el mes anterior SIGUE mostrando el cobro (+100)');
SELECT pg_temp.assert(
  pg_temp.cf(date_trunc('month', public.ar_today())::date, (date_trunc('month', public.ar_today()) + interval '1 month - 1 day')::date) = -100,
  'INV3 la compensacion (-100) aparece en el periodo ACTUAL');
SELECT pg_temp.assert(pg_temp.cf('1900-01-01','2999-12-31') = 0, 'INV4 cashflow acumulado neutralizado (cobro + reversa = 0)');
-- el cobro original NO cambio (snapshot completo salvo metadata de reversa)
SELECT pg_temp.assert(
  (SELECT to_jsonb(p) - 'reversed_at' - 'reversed_by' FROM order_payments p WHERE p.business_id=:'biz')
  = (SELECT pay_before FROM pg_temp_snap), 'INV5 order_payments original intacto (monto/fecha/metodo/moneda/refs)');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'biz' AND source<>'reversal' AND amount_ars=100 AND type='income')=1, 'INV6 FM original intacto (income +100, no borrado)');
-- compensacion: signo contrario, fecha HOY, metodo real conservado
SELECT pg_temp.assert((SELECT type FROM financial_movements WHERE business_id=:'biz' AND source='reversal')='expense', 'INV7 FM compensatorio = expense (signo contrario)');
SELECT pg_temp.assert((SELECT date FROM financial_movements WHERE business_id=:'biz' AND source='reversal')=public.ar_today(), 'INV8 FM compensatorio fechado HOY');
SELECT pg_temp.assert((SELECT metodo_pago FROM financial_movements WHERE business_id=:'biz' AND source='reversal')='efectivo', 'INV9 metodo real conservado (no reclasificado)');
SELECT pg_temp.assert((SELECT reference_type FROM financial_movements WHERE business_id=:'biz' AND source='reversal')='order_payment_reversal', 'INV10 FM compensatorio referencia el pago original');
SELECT pg_temp.assert((SELECT economic_class FROM business_finance_entries WHERE business_id=:'biz' AND source='reversal')='revenue_collection_mirror', 'INV11 BFE compensatorio revenue_collection_mirror (fuera del P&L)');
SELECT pg_temp.assert((SELECT amount_ars FROM business_finance_entries WHERE business_id=:'biz' AND source='reversal')=-100, 'INV12 BFE compensatorio = -100');
-- P&L no cambia (ni el cobro ni la reversa entran al P&L)
SELECT pg_temp.assert(COALESCE((SELECT SUM(operating_result) FROM v_finance_pnl WHERE business_id=:'biz'),0)=0, 'INV13 P&L operativo sin cambios (0)');
-- sin COGS, sin stock, sin CC inventada
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'biz' AND category='mercaderia')=0, 'INV14 la reversa NO crea COGS');
SELECT pg_temp.assert((SELECT count(*) FROM inventory_movements WHERE business_id=:'biz')=0, 'INV15 la reversa NO toca stock');
SELECT pg_temp.assert((SELECT count(*) FROM account_movements WHERE business_id=:'biz')=0, 'INV16 el cobro no tocaba CC -> la reversa NO inventa account_movement');
-- actor canonico
SELECT pg_temp.assert((SELECT reversed_by FROM order_payments WHERE business_id=:'biz' LIMIT 1)=:'OA', 'AC1 reversed_by = auth.uid (OA), no el p_user_id apocrifo');
SELECT pg_temp.assert((SELECT created_by FROM financial_movements WHERE business_id=:'biz' AND source='reversal')=:'OA', 'AC2 FM compensatorio created_by = auth.uid');
SELECT pg_temp.assert((SELECT created_by FROM order_payment_reversals WHERE business_id=:'biz')=:'OA', 'AC3 reversal record created_by = auth.uid');

-- ============ Auditoria: exactamente UN evento (y cero backstop) ============
DO $$ DECLARE a finance_audit_log%ROWTYPE; v_pay uuid;
BEGIN
  SELECT id INTO v_pay FROM order_payments WHERE business_id='00000000-0000-0000-0000-0000004a7101' LIMIT 1;
  -- La reversa genera exactamente 1 evento propio; ningun backstop adicional
  -- (esta RPC no escribe account_movements ni comprobante_payments).
  PERFORM pg_temp.assert((SELECT count(*) FROM finance_audit_log WHERE business_id='00000000-0000-0000-0000-0000004a7101' AND source_rpc='reverse_order_payment_atomic')=1, 'AU1 la reversa genero exactamente 1 evento (cero backstop)');
  PERFORM pg_temp.assert((SELECT count(*) FROM finance_audit_log WHERE business_id='00000000-0000-0000-0000-0000004a7101' AND action='order_payment_reversal')=1, 'AU1b exactamente 1 order_payment_reversal');
  SELECT * INTO a FROM finance_audit_log WHERE business_id='00000000-0000-0000-0000-0000004a7101' AND action='order_payment_reversal';
  PERFORM pg_temp.assert(a.action='order_payment_reversal' AND a.entity_table='order_payments' AND a.entity_id=v_pay, 'AU2 action/entity correctos');
  PERFORM pg_temp.assert(a.actor_user_id='00000000-0000-0000-0000-0000004a7109', 'AU3 actor = auth.uid (OA)');
  PERFORM pg_temp.assert(a.economic_date=public.ar_today(), 'AU4 economic_date = fecha de la REVERSA');
  PERFORM pg_temp.assert((a.new_data->>'original_amount_ars')::numeric=100 AND (a.new_data->>'reversal_amount_ars')::numeric=-100, 'AU5 montos original/compensatorio');
  PERFORM pg_temp.assert((a.new_data->>'original_period')<>(a.new_data->>'reversal_period'), 'AU6 periodo original <> compensatorio');
  PERFORM pg_temp.assert((a.new_data->>'reversal_financial_movement_id') IS NOT NULL AND (a.new_data->>'order_id') IS NOT NULL, 'AU7 IDs de reversa/orden en la auditoria');
END $$;

-- ============ Idempotencia durable + doble reversa ==========================
DO $$
DECLARE r1 jsonb; r2 jsonb; r3 jsonb; r4 jsonb; v_pay uuid;
BEGIN
  SELECT id INTO v_pay FROM order_payments WHERE business_id='00000000-0000-0000-0000-0000004a7101' LIMIT 1;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000004a7109';
  r1 := reverse_order_payment_atomic('00000000-0000-0000-0000-0000004a7101'::uuid, v_pay, 'Duplicado', NULL, 'RK1');
  r2 := reverse_order_payment_atomic('00000000-0000-0000-0000-0000004a7101'::uuid, v_pay, '  Duplicado  ', NULL, 'RK1');
  r3 := reverse_order_payment_atomic('00000000-0000-0000-0000-0000004a7101'::uuid, v_pay, 'OTRO motivo', NULL, 'RK1');
  r4 := reverse_order_payment_atomic('00000000-0000-0000-0000-0000004a7101'::uuid, v_pay, 'otra vez', NULL, 'RK2');
  RESET ROLE;
  PERFORM pg_temp.assert((r1->>'ok')::boolean AND (r1->>'replay')::boolean, 'ID1 misma key + mismo payload -> replay');
  PERFORM pg_temp.assert((r2->>'replay')::boolean, 'ID2 "  Duplicado  " == "Duplicado" (btrim) -> replay');
  PERFORM pg_temp.assert(r3->>'error_code'='IDEMPOTENCY_CONFLICT' AND r3->>'error'='IDEMPOTENCY_CONFLICT', 'ID3 motivo distinto -> IDEMPOTENCY_CONFLICT (contrato frontend)');
  PERFORM pg_temp.assert(r4->>'error_code'='ALREADY_REVERSED', 'ID4 key nueva sobre pago ya reversado -> ALREADY_REVERSED');
END $$;
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'biz' AND source='reversal')=1, 'ID5 UN solo FM compensatorio');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'biz' AND source='reversal')=1, 'ID6 UN solo BFE compensatorio');
SELECT pg_temp.assert((SELECT count(*) FROM order_payment_reversals WHERE business_id=:'biz')=1, 'ID7 UN solo reversal record');
SELECT pg_temp.assert((SELECT count(*) FROM finance_audit_log WHERE business_id=:'biz' AND action='order_payment_reversal')=1, 'ID8 UNA sola auditoria');
SELECT pg_temp.assert(pg_temp.cf('1900-01-01','2999-12-31') = 0, 'ID9 cashflow sigue neutralizado (sin doble compensacion)');

-- ============ Idempotencia DURABLE: retry al dia siguiente ==================
-- Se simula D+1 reemplazando ar_today() dentro de la transaccion (ROLLBACK lo revierte).
CREATE OR REPLACE FUNCTION public.ar_today() RETURNS date LANGUAGE sql STABLE AS
$$ SELECT ((now() AT TIME ZONE 'America/Argentina/Cordoba')::date + 1) $$;
DO $$
DECLARE r1 jsonb; r2 jsonb; v_pay uuid; v_fm uuid;
BEGIN
  SELECT id INTO v_pay FROM order_payments WHERE business_id='00000000-0000-0000-0000-0000004a7101' LIMIT 1;
  SELECT reversal_financial_movement_id INTO v_fm FROM order_payment_reversals WHERE business_id='00000000-0000-0000-0000-0000004a7101';
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000004a7109';
  r1 := reverse_order_payment_atomic('00000000-0000-0000-0000-0000004a7101'::uuid, v_pay, 'Duplicado', NULL, 'RK1');
  r2 := reverse_order_payment_atomic('00000000-0000-0000-0000-0000004a7101'::uuid, v_pay, 'OTRO motivo', NULL, 'RK1');
  RESET ROLE;
  PERFORM pg_temp.assert((r1->>'ok')::boolean AND (r1->>'replay')::boolean
    AND (r1->>'reversal_financial_movement_id')::uuid=v_fm, 'D1 retry en D+1 misma intencion -> replay con los MISMOS IDs (durable)');
  PERFORM pg_temp.assert(r2->>'error_code'='IDEMPOTENCY_CONFLICT', 'D2 motivo distinto en D+1 -> conflicto');
END $$;
SELECT pg_temp.assert((SELECT date FROM financial_movements WHERE business_id=:'biz' AND source='reversal')=((now() AT TIME ZONE 'America/Argentina/Cordoba')::date), 'D3 la compensacion conserva la fecha D (no se movio a D+1)');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'biz' AND source='reversal')=1, 'D4 sin duplicados tras el replay en D+1');
-- restaurar ar_today real
CREATE OR REPLACE FUNCTION public.ar_today() RETURNS date LANGUAGE sql STABLE AS
$$ SELECT (now() AT TIME ZONE 'America/Argentina/Cordoba')::date $$;
SELECT pg_temp.assert(public.ar_today() = (now() AT TIME ZONE 'America/Argentina/Cordoba')::date, 'D5 ar_today() restaurado');

-- ============ Replay con periodo de la reversa POSTERIORMENTE cerrado =======
DO $$
DECLARE r jsonb; v_pay uuid; v_ps date := date_trunc('month', public.ar_today())::date;
  v_pe date := (date_trunc('month', public.ar_today())+interval '1 month - 1 day')::date;
BEGIN
  SELECT id INTO v_pay FROM order_payments WHERE business_id='00000000-0000-0000-0000-0000004a7101' LIMIT 1;
  INSERT INTO finance_period_locks(business_id, period_start, period_end, status, closed_by, close_reason)
    VALUES ('00000000-0000-0000-0000-0000004a7101', v_ps, v_pe, 'closed','00000000-0000-0000-0000-0000004a7109','cierre posterior');
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000004a7109';
  r := reverse_order_payment_atomic('00000000-0000-0000-0000-0000004a7101'::uuid, v_pay, 'Duplicado', NULL, 'RK1');
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean, 'PC1 replay con periodo YA cerrado -> replay (no PERIOD_CLOSED)');
  DELETE FROM finance_period_locks WHERE business_id='00000000-0000-0000-0000-0000004a7101' AND period_start=v_ps;
END $$;

-- ============ Operacion NUEVA con fecha en periodo cerrado -> PERIOD_CLOSED =
DO $$
DECLARE r jsonb; v_pay2 uuid; v_ps date := date_trunc('month', public.ar_today())::date;
  v_pe date := (date_trunc('month', public.ar_today())+interval '1 month - 1 day')::date;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000004a7109';
  PERFORM create_order_payment_atomic('00000000-0000-0000-0000-0000004a7101'::uuid,'00000000-0000-0000-0000-0000004a7301'::uuid,
    50,'transfer','ARS',1,'00000000-0000-0000-0000-0000004a7109'::uuid,'cobro hoy',public.ar_today(),'pay-hoy');
  RESET ROLE;
  SELECT id INTO v_pay2 FROM order_payments WHERE business_id='00000000-0000-0000-0000-0000004a7101' AND amount=50 LIMIT 1;
  INSERT INTO finance_period_locks(business_id, period_start, period_end, status, closed_by, close_reason)
    VALUES ('00000000-0000-0000-0000-0000004a7101', v_ps, v_pe, 'closed','00000000-0000-0000-0000-0000004a7109','test guard');
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000004a7109';
  r := reverse_order_payment_atomic('00000000-0000-0000-0000-0000004a7101'::uuid, v_pay2, 'motivo', NULL, 'RKC');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'error_code'='PERIOD_CLOSED', 'PC2 reversa NUEVA con fecha en periodo cerrado -> PERIOD_CLOSED');
  PERFORM pg_temp.assert((SELECT reversed_at FROM order_payments WHERE id=v_pay2) IS NULL, 'PC3 el cobro NO quedo reversado');
  DELETE FROM finance_period_locks WHERE business_id='00000000-0000-0000-0000-0000004a7101' AND period_start=v_ps;
END $$;

-- ============ Rollback ante fallo de auditoria ==============================
ALTER TABLE finance_audit_log ADD CONSTRAINT tmp_fail_opr CHECK (action <> 'order_payment_reversal') NOT VALID;
DO $$
DECLARE r jsonb; v_pay2 uuid; n_fm int;
BEGIN
  SELECT id INTO v_pay2 FROM order_payments WHERE business_id='00000000-0000-0000-0000-0000004a7101' AND amount=50 LIMIT 1;
  SELECT count(*) INTO n_fm FROM financial_movements WHERE business_id='00000000-0000-0000-0000-0000004a7101' AND source='reversal';
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000004a7109';
  r := reverse_order_payment_atomic('00000000-0000-0000-0000-0000004a7101'::uuid, v_pay2, 'motivo rb', NULL, 'RKRB');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'error_code'='AUDIT_FAILED', 'RB1 auditoria rota -> AUDIT_FAILED');
  PERFORM pg_temp.assert((SELECT reversed_at FROM order_payments WHERE id=v_pay2) IS NULL, 'RB2 cobro NO quedo reversado (rollback)');
  PERFORM pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id='00000000-0000-0000-0000-0000004a7101' AND source='reversal')=n_fm, 'RB3 sin FM compensatorio (rollback)');
  PERFORM pg_temp.assert((SELECT count(*) FROM order_payment_reversals WHERE business_id='00000000-0000-0000-0000-0000004a7101' AND idempotency_key='RKRB')=0, 'RB4 sin reversal record (retry seguro)');
END $$;
ALTER TABLE finance_audit_log DROP CONSTRAINT tmp_fail_opr;

-- ============ Reversal table protegida =====================================
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.order_payment_reversals','SELECT'), 'RT1 authenticated NO SELECT order_payment_reversals');
SELECT pg_temp.assert(NOT has_table_privilege('service_role','public.order_payment_reversals','DELETE'), 'RT2 service_role NO DELETE');
DO $$
DECLARE v_id uuid; e text;
BEGIN
  SELECT id INTO v_id FROM order_payment_reversals WHERE business_id='00000000-0000-0000-0000-0000004a7101' LIMIT 1;
  e:=''; BEGIN DELETE FROM order_payment_reversals WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e<>'', 'RT3 DELETE prohibido (append-only)');
  e:=''; BEGIN UPDATE order_payment_reversals SET amount_ars=999 WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%inmutable%', 'RT4 registro de reversa inmutable');
END $$;

-- ============ Estatico: aditivos M7 =========================================
SELECT pg_temp.assert(pg_get_functiondef('public.reverse_order_payment_atomic(uuid,uuid,text,uuid,text)'::regprocedure)
  LIKE '%''reason'',v_reason)::text, ''sha256''%', 'ST1 el hash se compone SOLO hasta reason (sin fecha ni ar_today)');
SELECT pg_temp.assert(
  strpos(pg_get_functiondef('public.reverse_order_payment_atomic(uuid,uuid,text,uuid,text)'::regprocedure), 'v_existing.reversal_financial_movement_id')
  < strpos(pg_get_functiondef('public.reverse_order_payment_atomic(uuid,uuid,text,uuid,text)'::regprocedure), 'assert_period_open'),
  'ST2 el replay retorna ANTES de assert_period_open');
SELECT pg_temp.assert(
  strpos(pg_get_functiondef('public.reverse_order_payment_atomic(uuid,uuid,text,uuid,text)'::regprocedure), 'v_date := public.ar_today();')
  > strpos(pg_get_functiondef('public.reverse_order_payment_atomic(uuid,uuid,text,uuid,text)'::regprocedure), 'v_existing.reversal_financial_movement_id'),
  'ST3 v_date := ar_today() se calcula DESPUES del replay');
SELECT pg_temp.assert(pg_get_functiondef('public.reverse_order_payment_atomic(uuid,uuid,text,uuid,text)'::regprocedure) ILIKE '%v_actor_user_id uuid := auth.uid()%', 'ST4 actor canonico = auth.uid()');
SELECT pg_temp.assert(pg_get_functiondef('public.reverse_order_payment_atomic(uuid,uuid,text,uuid,text)'::regprocedure) ILIKE '%finance_begin_audit_scope%', 'ST5 audit scope presente');

SELECT pg_temp.assert(true, '=== etapa7_rpc_integration_order_payment_reversal_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
