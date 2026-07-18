-- ============================================================================
-- M7 Bloque 6F.1 -- reverse_operating_expense_atomic (compensatoria append-only).
-- INVARIANTE CENTRAL: revertir HOY un gasto de un periodo CERRADO genera la
-- compensacion en el periodo ACTUAL y NUNCA cambia los numeros del periodo
-- original. El asiento original no cambia de fecha/monto/clase/signo.
--   Actor canonico (ignora p_user_id) · guard SOLO del periodo de la reversa ·
--   idempotencia + doble reversa · auditoria unica · rollback · error_code.
-- RUN: docker cp ... && psql -X -f (BEGIN + ROLLBACK)
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;
-- P&L operativo acumulado de un rango (suma operating_expenses)
CREATE OR REPLACE FUNCTION pg_temp.opex(d1 date, d2 date) RETURNS numeric LANGUAGE sql AS $$
  SELECT COALESCE(SUM(operating_expenses),0) FROM v_finance_pnl
   WHERE business_id='00000000-0000-0000-0000-000000387101' AND period_date BETWEEN d1 AND d2 $$;

\set biz  '00000000-0000-0000-0000-000000387101'
\set OA   '00000000-0000-0000-0000-000000387109'
\set ADM  '00000000-0000-0000-0000-000000387108'
\set biz2 '00000000-0000-0000-0000-000000387201'
\set OB   '00000000-0000-0000-0000-000000387209'
\set CAJA '00000000-0000-0000-0000-000000387601'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'OA'),(:'ADM'),(:'OB');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','6F1 A',:'OA'),(:'biz2','6F1 B',:'OB');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES (:'biz',:'OA','owner',true),(:'biz',:'ADM','admin',true),(:'biz2',:'OB','owner',true);
INSERT INTO cajas(id,business_id,opened_by,status) VALUES (:'CAJA',:'biz',:'OA','abierta');
SET LOCAL session_replication_role='origin';

-- Gasto operativo en el MES ANTERIOR (periodo aun abierto), efectivo 100
DO $$
DECLARE r jsonb; v_prev date := date_trunc('month', public.ar_today() - interval '1 month')::date + 5;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000387109';
  r := create_expense_with_finance('00000000-0000-0000-0000-000000387101'::uuid,'00000000-0000-0000-0000-000000387109'::uuid,
    'Alquiler','Local','fixed_cost_local','fixed_cost_local',100,'efectivo',v_prev,false,NULL,NULL,NULL,'exp-jun');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'SETUP gasto operativo mes anterior -> ok ('||COALESCE(r->>'error','')||')');
  RESET ROLE;
END $$;
-- CERRAR el mes anterior (el periodo del gasto original queda inmutable)
DO $$ DECLARE v_p1 date := date_trunc('month', public.ar_today() - interval '1 month')::date;
BEGIN SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000387109';
  PERFORM close_period('00000000-0000-0000-0000-000000387101'::uuid, v_p1, 'cierre 6F1'); RESET ROLE; END $$;

-- Foto del periodo ORIGINAL antes de revertir
CREATE TEMP TABLE pg_temp_snap AS
  SELECT pg_temp.opex(date_trunc('month', public.ar_today() - interval '1 month')::date,
                      (date_trunc('month', public.ar_today())::date - 1)) AS opex_prev_before;
SELECT pg_temp.assert((SELECT opex_prev_before FROM pg_temp_snap)=100, 'INV0 mes anterior arranca con opex=100');

-- ============ Seguridad / contrato de error ================================
DO $$
DECLARE r jsonb; v_exp uuid;
BEGIN
  SELECT id INTO v_exp FROM expenses WHERE business_id='00000000-0000-0000-0000-000000387101' LIMIT 1;
  -- sin auth
  SET LOCAL "request.jwt.claim.sub" = '';
  r := reverse_operating_expense_atomic('00000000-0000-0000-0000-000000387101'::uuid, v_exp, 'x', NULL, NULL);
  PERFORM pg_temp.assert(r->>'error_code'='UNAUTHORIZED', 'S1 sin auth -> UNAUTHORIZED');
  -- cross-tenant
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000387209';  -- OB
  r := reverse_operating_expense_atomic('00000000-0000-0000-0000-000000387101'::uuid, v_exp, 'x', NULL, NULL);
  PERFORM pg_temp.assert(r->>'error_code'='FORBIDDEN', 'S2 cross-tenant -> FORBIDDEN');
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000387109';
  -- motivo obligatorio
  r := reverse_operating_expense_atomic('00000000-0000-0000-0000-000000387101'::uuid, v_exp, '   ', NULL, NULL);
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'S3 motivo vacio -> VALIDATION_ERROR');
  -- gasto inexistente
  r := reverse_operating_expense_atomic('00000000-0000-0000-0000-000000387101'::uuid,'00000000-0000-0000-0000-0000009999e1'::uuid,'x', NULL, NULL);
  PERFORM pg_temp.assert(r->>'error_code'='EXPENSE_NOT_FOUND', 'S4 gasto inexistente -> EXPENSE_NOT_FOUND');
  -- gasto de OTRO negocio (aislamiento)
  RESET ROLE; SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000387209';
  r := reverse_operating_expense_atomic('00000000-0000-0000-0000-000000387201'::uuid, v_exp, 'x', NULL, NULL);
  PERFORM pg_temp.assert(r->>'error_code'='EXPENSE_NOT_FOUND', 'S5 gasto de otro negocio -> EXPENSE_NOT_FOUND');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT reversed_at FROM expenses WHERE business_id=:'biz' LIMIT 1) IS NULL, 'S6 ningun rechazo reverso el gasto');

-- ============ Reversa normal: gasto de periodo CERRADO, reversa HOY =========
DO $$
DECLARE r jsonb; v_exp uuid;
BEGIN
  SELECT id INTO v_exp FROM expenses WHERE business_id='00000000-0000-0000-0000-000000387101' LIMIT 1;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000387109';  -- OA
  -- p_user_id APOCRIFO (ADM): la atribucion debe usar auth.uid() (OA), no p_user_id
  r := reverse_operating_expense_atomic('00000000-0000-0000-0000-000000387101'::uuid, v_exp, 'motivo test',
       '00000000-0000-0000-0000-000000387108'::uuid, 'RK1');
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean IS FALSE, 'R1 gasto de periodo CERRADO + reversa hoy -> permitido ('||COALESCE(r->>'error','')||')');
  PERFORM pg_temp.assert((r->>'reversal_finance_entry_id') IS NOT NULL, 'R2 devuelve reversal_finance_entry_id');
END $$;

-- ============ INVARIANTE: periodo original inmutable ========================
SELECT pg_temp.assert(
  pg_temp.opex(date_trunc('month', public.ar_today() - interval '1 month')::date, (date_trunc('month', public.ar_today())::date - 1))
  = (SELECT opex_prev_before FROM pg_temp_snap),
  'INV1 P&L del periodo ORIGINAL identico antes/despues de revertir');
SELECT pg_temp.assert(
  pg_temp.opex(date_trunc('month', public.ar_today() - interval '1 month')::date, (date_trunc('month', public.ar_today())::date - 1)) = 100,
  'INV2 el mes anterior SIGUE mostrando el gasto original (100)');
SELECT pg_temp.assert(
  pg_temp.opex(date_trunc('month', public.ar_today())::date, (date_trunc('month', public.ar_today()) + interval '1 month - 1 day')::date) = -100,
  'INV3 la compensacion (-100) aparece en el periodo ACTUAL');
SELECT pg_temp.assert(pg_temp.opex('1900-01-01','2999-12-31') = 0, 'INV4 acumulado original + reversa = 0 (neutralizado)');
-- asiento ORIGINAL intacto: fecha/monto/clase/signo
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'biz' AND source='expense'
  AND amount_ars=100 AND economic_class='operating_expense'
  AND date=date_trunc('month', public.ar_today() - interval '1 month')::date + 5)=1, 'INV5 BFE original intacto (fecha/monto/clase)');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'biz' AND source='expense' AND type='expense' AND amount_ars=100)=1, 'INV6 FM original intacto (no borrado ni modificado)');
-- compensacion: misma clase, monto negativo, fecha HOY
SELECT pg_temp.assert((SELECT economic_class FROM business_finance_entries WHERE business_id=:'biz' AND source='reversal')='operating_expense', 'INV7 BFE compensatorio clase operating_expense (netea)');
SELECT pg_temp.assert((SELECT amount_ars FROM business_finance_entries WHERE business_id=:'biz' AND source='reversal')=-100, 'INV8 BFE compensatorio = -100');
SELECT pg_temp.assert((SELECT date FROM business_finance_entries WHERE business_id=:'biz' AND source='reversal')=public.ar_today(), 'INV9 BFE compensatorio fechado HOY');
-- cashflow: salida original + entrada compensatoria = 0
SELECT pg_temp.assert((SELECT COALESCE(SUM(net_ars),0) FROM v_finance_cashflow WHERE business_id=:'biz')=0, 'INV10 cashflow acumulado neutralizado (salida + entrada = 0)');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'biz' AND source='reversal' AND type='income' AND date=public.ar_today())=1, 'INV11 1 FM compensatorio income fechado hoy');
-- actor canonico: reversed_by = auth.uid (OA), NO el p_user_id apocrifo (ADM)
SELECT pg_temp.assert((SELECT reversed_by FROM expenses WHERE business_id=:'biz' LIMIT 1)=:'OA', 'AC1 reversed_by = auth.uid (OA), no el p_user_id apocrifo');
SELECT pg_temp.assert((SELECT created_by FROM business_finance_entries WHERE business_id=:'biz' AND source='reversal')=:'OA', 'AC2 BFE compensatorio created_by = auth.uid');
SELECT pg_temp.assert((SELECT created_by FROM operating_expense_reversals WHERE business_id=:'biz')=:'OA', 'AC3 reversal record created_by = auth.uid');
SELECT pg_temp.assert((SELECT reversed_at FROM expenses WHERE business_id=:'biz' LIMIT 1) IS NOT NULL, 'AC4 reversed_at seteado (metadata operativa)');

-- ============ Auditoria: exactamente UN evento ==============================
DO $$ DECLARE a finance_audit_log%ROWTYPE; v_exp uuid;
BEGIN
  SELECT id INTO v_exp FROM expenses WHERE business_id='00000000-0000-0000-0000-000000387101' LIMIT 1;
  PERFORM pg_temp.assert((SELECT count(*) FROM finance_audit_log WHERE business_id='00000000-0000-0000-0000-000000387101' AND action='operating_expense_reversal')=1, 'AU1 exactamente 1 evento operating_expense_reversal');
  SELECT * INTO a FROM finance_audit_log WHERE business_id='00000000-0000-0000-0000-000000387101' AND action='operating_expense_reversal';
  PERFORM pg_temp.assert(a.entity_table='expenses' AND a.entity_id=v_exp, 'AU2 entity = expenses / expense_id original');
  PERFORM pg_temp.assert(a.actor_user_id='00000000-0000-0000-0000-000000387109', 'AU3 actor = auth.uid (OA)');
  PERFORM pg_temp.assert(a.economic_date=public.ar_today(), 'AU4 economic_date = fecha de la REVERSA (hoy)');
  PERFORM pg_temp.assert((a.new_data->>'original_amount_ars')::numeric=100 AND (a.new_data->>'reversal_amount_ars')::numeric=-100, 'AU5 montos original/compensatorio');
  PERFORM pg_temp.assert((a.new_data->>'original_period')<>(a.new_data->>'reversal_period'), 'AU6 periodo original <> periodo compensatorio');
  PERFORM pg_temp.assert((a.new_data->>'reversal_id') IS NOT NULL AND (a.new_data->>'reversal_finance_entry_id') IS NOT NULL, 'AU7 IDs de reversa en la auditoria');
END $$;

-- ============ Idempotencia + doble reversa ==================================
DO $$
DECLARE r jsonb; v_exp uuid;
BEGIN
  SELECT id INTO v_exp FROM expenses WHERE business_id='00000000-0000-0000-0000-000000387101' LIMIT 1;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000387109';
  -- misma key + mismo payload -> replay
  r := reverse_operating_expense_atomic('00000000-0000-0000-0000-000000387101'::uuid, v_exp, 'motivo test', NULL, 'RK1');
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean, 'ID1 misma key + mismo payload -> replay');
  -- misma key + payload distinto (motivo) -> conflicto
  r := reverse_operating_expense_atomic('00000000-0000-0000-0000-000000387101'::uuid, v_exp, 'OTRO motivo', NULL, 'RK1');
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT' AND r->>'error'='IDEMPOTENCY_CONFLICT', 'ID2 payload distinto -> IDEMPOTENCY_CONFLICT (contrato frontend)');
  -- key NUEVA sobre un gasto YA reversado -> ALREADY_REVERSED (anti doble reversa)
  r := reverse_operating_expense_atomic('00000000-0000-0000-0000-000000387101'::uuid, v_exp, 'otra vez', NULL, 'RK2');
  PERFORM pg_temp.assert(r->>'error_code'='ALREADY_REVERSED', 'ID3 key distinta sobre gasto ya reversado -> ALREADY_REVERSED');
  RESET ROLE;
END $$;
-- una sola compensacion pese a replay/conflicto/segunda key
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'biz' AND source='reversal')=1, 'ID4 UNA sola compensacion BFE');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'biz' AND source='reversal')=1, 'ID5 UN solo FM compensatorio');
SELECT pg_temp.assert((SELECT count(*) FROM operating_expense_reversals WHERE business_id=:'biz')=1, 'ID6 UN solo reversal record');
SELECT pg_temp.assert((SELECT count(*) FROM finance_audit_log WHERE business_id=:'biz' AND action='operating_expense_reversal')=1, 'ID7 UNA sola auditoria');
SELECT pg_temp.assert(pg_temp.opex('1900-01-01','2999-12-31') = 0, 'ID8 acumulado sigue neutralizado (sin doble compensacion)');

-- ============ Reversa cuya PROPIA fecha cae en periodo cerrado -> PERIOD_CLOSED
DO $$
DECLARE r jsonb; v_exp2 uuid; v_ps date := date_trunc('month', public.ar_today())::date; v_pe date := (date_trunc('month', public.ar_today())+interval '1 month - 1 day')::date;
BEGIN
  -- segundo gasto (mes actual) para revertir
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000387109';
  PERFORM create_expense_with_finance('00000000-0000-0000-0000-000000387101'::uuid,'00000000-0000-0000-0000-000000387109'::uuid,
    'Luz','Local','fixed_cost_local','fixed_cost_local',50,'transferencia',public.ar_today(),false,NULL,NULL,NULL,'exp-hoy');
  RESET ROLE;
  SELECT id INTO v_exp2 FROM expenses WHERE business_id='00000000-0000-0000-0000-000000387101' AND amount=50 LIMIT 1;
  -- cerrar el mes ACTUAL a mano (close_period lo prohibe) -> la reversa de HOY cae en periodo cerrado
  INSERT INTO finance_period_locks(business_id, period_start, period_end, status, closed_by, close_reason)
    VALUES ('00000000-0000-0000-0000-000000387101', v_ps, v_pe, 'closed','00000000-0000-0000-0000-000000387109','test guard');
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000387109';
  r := reverse_operating_expense_atomic('00000000-0000-0000-0000-000000387101'::uuid, v_exp2, 'motivo', NULL, 'RKC');
  PERFORM pg_temp.assert(r->>'error_code'='PERIOD_CLOSED', 'PC1 reversa con fecha en periodo cerrado -> PERIOD_CLOSED');
  RESET ROLE;
  PERFORM pg_temp.assert((SELECT reversed_at FROM expenses WHERE id=v_exp2) IS NULL, 'PC2 el gasto NO quedo reversado');
  DELETE FROM finance_period_locks WHERE business_id='00000000-0000-0000-0000-000000387101' AND period_start=v_ps;
END $$;

-- ============ Rollback ante fallo de auditoria ==============================
ALTER TABLE finance_audit_log ADD CONSTRAINT tmp_fail_rev CHECK (action <> 'operating_expense_reversal') NOT VALID;
DO $$
DECLARE r jsonb; v_exp2 uuid; n_bfe int;
BEGIN
  SELECT id INTO v_exp2 FROM expenses WHERE business_id='00000000-0000-0000-0000-000000387101' AND amount=50 LIMIT 1;
  SELECT count(*) INTO n_bfe FROM business_finance_entries WHERE business_id='00000000-0000-0000-0000-000000387101' AND source='reversal';
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000387109';
  r := reverse_operating_expense_atomic('00000000-0000-0000-0000-000000387101'::uuid, v_exp2, 'motivo rb', NULL, 'RKRB');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'error_code'='AUDIT_FAILED', 'RB1 auditoria rota -> AUDIT_FAILED');
  PERFORM pg_temp.assert((SELECT reversed_at FROM expenses WHERE id=v_exp2) IS NULL, 'RB2 gasto NO quedo reversado (rollback)');
  PERFORM pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id='00000000-0000-0000-0000-000000387101' AND source='reversal')=n_bfe, 'RB3 sin BFE compensatorio (rollback)');
  PERFORM pg_temp.assert((SELECT count(*) FROM operating_expense_reversals WHERE business_id='00000000-0000-0000-0000-000000387101' AND idempotency_key='RKRB')=0, 'RB4 sin reversal record (retry seguro)');
END $$;
ALTER TABLE finance_audit_log DROP CONSTRAINT tmp_fail_rev;

-- ============ Request/reversal table protegida ==============================
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.operating_expense_reversals','SELECT'), 'RT1 authenticated NO SELECT operating_expense_reversals');
SELECT pg_temp.assert(NOT has_table_privilege('service_role','public.operating_expense_reversals','DELETE'), 'RT2 service_role NO DELETE');
DO $$
DECLARE v_id uuid; e text;
BEGIN
  SELECT id INTO v_id FROM operating_expense_reversals WHERE business_id='00000000-0000-0000-0000-000000387101' LIMIT 1;
  e:=''; BEGIN DELETE FROM operating_expense_reversals WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e<>'', 'RT3 DELETE prohibido (append-only)');
  e:=''; BEGIN UPDATE operating_expense_reversals SET amount_ars=999 WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%inmutable%', 'RT4 registro de reversa inmutable');
END $$;

-- ============ 6F.1a: idempotencia DURABLE (retry al dia siguiente) ==========
-- El hash es SOLO la intencion del caller (op+negocio+gasto+motivo). Se simula
-- D+1 reemplazando ar_today() DENTRO de la transaccion (el ROLLBACK lo revierte).
-- Si el hash incluyera la fecha, el retry en D+1 daria IDEMPOTENCY_CONFLICT.
DO $$
DECLARE r jsonb; v_exp3 uuid;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000387109';
  PERFORM create_expense_with_finance('00000000-0000-0000-0000-000000387101'::uuid,'00000000-0000-0000-0000-000000387109'::uuid,
    'Internet','Local','fixed_cost_local','fixed_cost_local',70,'transferencia',public.ar_today(),false,NULL,NULL,NULL,'exp-dk');
  RESET ROLE;
  SELECT id INTO v_exp3 FROM expenses WHERE business_id='00000000-0000-0000-0000-000000387101' AND amount=70 LIMIT 1;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000387109';
  r := reverse_operating_expense_atomic('00000000-0000-0000-0000-000000387101'::uuid, v_exp3, 'Duplicado', NULL, 'DK');
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean IS FALSE, 'D1 reversa en el dia D -> created ('||COALESCE(r->>'error','')||')');
END $$;
-- foto de la reversa creada en D
CREATE TEMP TABLE pg_temp_dk AS SELECT reversal_finance_entry_id AS bfe, reversal_financial_movement_id AS fm,
  (SELECT date FROM business_finance_entries b WHERE b.id=r.reversal_finance_entry_id) AS rev_date
  FROM operating_expense_reversals r WHERE business_id='00000000-0000-0000-0000-000000387101' AND idempotency_key='DK';

-- ── simular D+1 ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ar_today() RETURNS date LANGUAGE sql STABLE AS
$$ SELECT ((now() AT TIME ZONE 'America/Argentina/Cordoba')::date + 1) $$;
SELECT pg_temp.assert(public.ar_today() = ((now() AT TIME ZONE 'America/Argentina/Cordoba')::date + 1), 'D2 ar_today() mockeado a D+1');
DO $$
DECLARE r1 jsonb; r2 jsonb; r3 jsonb; v_exp3 uuid; v_bfe uuid; v_fm uuid;
BEGIN
  -- lecturas como postgres ANTES de cambiar de rol (temp table / RLS)
  SELECT id INTO v_exp3 FROM expenses WHERE business_id='00000000-0000-0000-0000-000000387101' AND amount=70 LIMIT 1;
  SELECT bfe, fm INTO v_bfe, v_fm FROM pg_temp_dk;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000387109';
  -- misma key + mismo gasto + mismo motivo, otro dia -> REPLAY (no conflicto)
  r1 := reverse_operating_expense_atomic('00000000-0000-0000-0000-000000387101'::uuid, v_exp3, 'Duplicado', NULL, 'DK');
  -- motivo con espacios laterales -> mismo motivo normalizado -> replay
  r2 := reverse_operating_expense_atomic('00000000-0000-0000-0000-000000387101'::uuid, v_exp3, '  Duplicado  ', NULL, 'DK');
  -- motivo realmente distinto -> conflicto (antes del guard, sin escrituras)
  r3 := reverse_operating_expense_atomic('00000000-0000-0000-0000-000000387101'::uuid, v_exp3, 'Otro motivo', NULL, 'DK');
  RESET ROLE;
  PERFORM pg_temp.assert((r1->>'ok')::boolean AND (r1->>'replay')::boolean, 'D3 retry en D+1 misma intencion -> replay (idempotencia durable)');
  PERFORM pg_temp.assert((r1->>'reversal_finance_entry_id')::uuid=v_bfe
                     AND (r1->>'reversal_financial_movement_id')::uuid IS NOT DISTINCT FROM v_fm, 'D4 replay devuelve los MISMOS reversal IDs');
  PERFORM pg_temp.assert((r2->>'replay')::boolean, 'D5 "  Duplicado  " == "Duplicado" (btrim) -> replay');
  PERFORM pg_temp.assert(r3->>'error_code'='IDEMPOTENCY_CONFLICT', 'D6 motivo distinto en D+1 -> IDEMPOTENCY_CONFLICT');
END $$;
-- el replay NO movio la fecha de la compensacion a D+1 ni duplico nada
SELECT pg_temp.assert((SELECT date FROM business_finance_entries WHERE id=(SELECT bfe FROM pg_temp_dk))=(SELECT rev_date FROM pg_temp_dk), 'D7 la compensacion conserva la fecha D (no se movio a D+1)');
SELECT pg_temp.assert((SELECT count(*) FROM operating_expense_reversals WHERE business_id=:'biz' AND expense_id=(SELECT id FROM expenses WHERE business_id=:'biz' AND amount=70 LIMIT 1))=1, 'D8 un solo reversal record');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'biz' AND source='reversal' AND amount_ars=-70)=1, 'D9 un solo BFE compensatorio (-70)');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'biz' AND source='reversal' AND amount_ars=70)=1, 'D10 un solo FM compensatorio');
SELECT pg_temp.assert((SELECT count(*) FROM finance_audit_log WHERE business_id=:'biz' AND action='operating_expense_reversal' AND (new_data->>'original_amount_ars')::numeric=70)=1, 'D11 una sola auditoria');

-- ── replay con el periodo de la reversa POSTERIORMENTE cerrado -> replay ────
DO $$
DECLARE r jsonb; v_exp3 uuid; v_ps date := date_trunc('month', (now() AT TIME ZONE 'America/Argentina/Cordoba')::date)::date;
  v_pe date := (date_trunc('month', (now() AT TIME ZONE 'America/Argentina/Cordoba')::date)+interval '1 month - 1 day')::date;
BEGIN
  SELECT id INTO v_exp3 FROM expenses WHERE business_id='00000000-0000-0000-0000-000000387101' AND amount=70 LIMIT 1;
  INSERT INTO finance_period_locks(business_id, period_start, period_end, status, closed_by, close_reason)
    VALUES ('00000000-0000-0000-0000-000000387101', v_ps, v_pe, 'closed','00000000-0000-0000-0000-000000387109','cierre posterior');
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000387109';
  r := reverse_operating_expense_atomic('00000000-0000-0000-0000-000000387101'::uuid, v_exp3, 'Duplicado', NULL, 'DK');
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean, 'D12 replay con periodo YA cerrado -> replay (no PERIOD_CLOSED)');
  DELETE FROM finance_period_locks WHERE business_id='00000000-0000-0000-0000-000000387101' AND period_start=v_ps;
END $$;

-- ── restaurar ar_today() real ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ar_today() RETURNS date LANGUAGE sql STABLE AS
$$ SELECT (now() AT TIME ZONE 'America/Argentina/Cordoba')::date $$;
SELECT pg_temp.assert(public.ar_today() = (now() AT TIME ZONE 'America/Argentina/Cordoba')::date, 'D13 ar_today() restaurado');

-- ============ §7 Verificaciones estaticas ==================================
SELECT pg_temp.assert(
  pg_get_functiondef('public.reverse_operating_expense_atomic(uuid,uuid,text,uuid,text)'::regprocedure)
  LIKE '%''reason'',v_reason)::text, ''sha256''%', 'ST1 el hash se compone SOLO hasta reason (sin fecha ni ar_today)');
SELECT pg_temp.assert(
  strpos(pg_get_functiondef('public.reverse_operating_expense_atomic(uuid,uuid,text,uuid,text)'::regprocedure), 'v_existing.reversal_finance_entry_id')
  < strpos(pg_get_functiondef('public.reverse_operating_expense_atomic(uuid,uuid,text,uuid,text)'::regprocedure), 'assert_period_open'),
  'ST2 el replay retorna ANTES de assert_period_open');
SELECT pg_temp.assert(
  strpos(pg_get_functiondef('public.reverse_operating_expense_atomic(uuid,uuid,text,uuid,text)'::regprocedure), 'v_date := public.ar_today();')
  > strpos(pg_get_functiondef('public.reverse_operating_expense_atomic(uuid,uuid,text,uuid,text)'::regprocedure), 'v_existing.reversal_finance_entry_id'),
  'ST3 v_date := ar_today() se calcula DESPUES del replay (solo key nueva)');
SELECT pg_temp.assert(
  pg_get_functiondef('public.reverse_operating_expense_atomic(uuid,uuid,text,uuid,text)'::regprocedure) ILIKE '%v_actor_user_id uuid := auth.uid()%',
  'ST4 actor canonico = auth.uid()');
SELECT pg_temp.assert(
  pg_get_functiondef('public.reverse_operating_expense_atomic(uuid,uuid,text,uuid,text)'::regprocedure) LIKE '%v_reason text := NULLIF(btrim(COALESCE(p_reason,''''))%',
  'ST5 motivo normalizado con btrim en una sola variable');

SELECT pg_temp.assert(true, '=== etapa7_rpc_integration_expense_reversal_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
