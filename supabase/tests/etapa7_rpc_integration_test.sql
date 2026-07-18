-- ============================================================================
-- M7 Bloque 6A — Integración guard+auditoría en create_owner_withdrawal /
-- create_owner_contribution. Período abierto/cerrado, fecha nula normalizada y
-- persistida, fecha auditada = fecha almacenada, cross-tenant, rol, idempotencia
-- (movimiento y auditoría), un evento por operación, rollback si falla auditoría.
-- RUN: docker cp … && psql -X -f  (una tx + ROLLBACK). Concurrencia: harness aparte.
-- Patrón: las RPC se llaman con SET ROLE authenticated (asertos sobre el jsonb);
-- las verificaciones que LEEN tablas corren a nivel top (rol postgres).
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set bizA '00000000-0000-0000-0000-0000001a7101'
\set OA   '00000000-0000-0000-0000-0000001a7109'
\set ADM  '00000000-0000-0000-0000-0000001a7108'
\set CSH  '00000000-0000-0000-0000-0000001a7107'
\set bizB '00000000-0000-0000-0000-0000001a7201'
\set OB   '00000000-0000-0000-0000-0000001a7209'
\set PAOA '00000000-0000-0000-0000-0000001a7301'
\set PAAD '00000000-0000-0000-0000-0000001a7302'
\set PAOB '00000000-0000-0000-0000-0000001a7303'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'OA'),(:'ADM'),(:'CSH'),(:'OB');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'bizA','6A A',:'OA'),(:'bizB','6A B',:'OB');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES
  (:'bizA',:'OA','owner',true),(:'bizA',:'ADM','admin',true),(:'bizA',:'CSH','cashier',true),(:'bizB',:'OB','owner',true);
INSERT INTO personal_accounts(id,user_id,name,currency,is_active,current_balance) VALUES
  (:'PAOA',:'OA','Caja OA','ARS',true,0),(:'PAAD',:'ADM','Caja ADM','ARS',true,0),(:'PAOB',:'OB','Caja OB','ARS',true,0);
INSERT INTO personal_account_balances(user_id,account_id,currency,initial_balance,current_balance) VALUES
  (:'OA',:'PAOA','ARS',0,0),(:'ADM',:'PAAD','ARS',0,0),(:'OB',:'PAOB','ARS',0,0);
SET LOCAL session_replication_role='origin';

DO $$ DECLARE v_p1 date := date_trunc('month', public.ar_today() - interval '1 month')::date;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000001a7109';
  PERFORM close_period('00000000-0000-0000-0000-0000001a7101'::uuid, v_p1, 'setup 6A'); RESET ROLE;
END $$;

-- ═══════ WITHDRAWAL — llamadas RPC (asertos sobre jsonb) ════════════════════
DO $$
DECLARE r jsonb; v_cur date := public.ar_today();
  v_p1 date := date_trunc('month', public.ar_today() - interval '1 month')::date;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000001a7109';  -- OA owner
  r := create_owner_withdrawal('00000000-0000-0000-0000-0000001a7101'::uuid, 1000, v_cur, '00000000-0000-0000-0000-0000001a7301'::uuid, 'w abierto', NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'W1 período abierto + owner -> ok ('||COALESCE(r->>'error','')||')');
  r := create_owner_withdrawal('00000000-0000-0000-0000-0000001a7101'::uuid, 500, v_p1 + 10, '00000000-0000-0000-0000-0000001a7301'::uuid, 'w cerrado', NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE AND r->>'error' LIKE 'PERIOD_CLOSED%', 'W2 período cerrado -> PERIOD_CLOSED');
  r := create_owner_withdrawal('00000000-0000-0000-0000-0000001a7101'::uuid, 700, NULL, '00000000-0000-0000-0000-0000001a7301'::uuid, 'w null date', NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'W3 fecha nula -> ok');
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000001a7209';  -- OB
  r := create_owner_withdrawal('00000000-0000-0000-0000-0000001a7101'::uuid, 111, v_cur, '00000000-0000-0000-0000-0000001a7303'::uuid, 'cross', NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE AND r->>'error' LIKE '%Sin permiso%', 'W5 cross-tenant -> rechazado');
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000001a7107';  -- cashier
  r := create_owner_withdrawal('00000000-0000-0000-0000-0000001a7101'::uuid, 112, v_cur, '00000000-0000-0000-0000-0000001a7301'::uuid, 'cashier', NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE AND r->>'error' LIKE '%Sin permiso%', 'W6 rol cashier -> rechazado (sin permiso nuevo)');
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000001a7108';  -- admin
  r := create_owner_withdrawal('00000000-0000-0000-0000-0000001a7101'::uuid, 300, v_cur, '00000000-0000-0000-0000-0000001a7302'::uuid, 'admin', NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'W8 admin autorizado -> ok');
  RESET ROLE;
  -- replay idempotente (misma key) — de vuelta como OA con su cuenta
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000001a7109';  -- OA
  r := create_owner_withdrawal('00000000-0000-0000-0000-0000001a7101'::uuid, 1234, v_cur, '00000000-0000-0000-0000-0000001a7301'::uuid, 'idem', 'KEY-W');
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean IS FALSE, 'W9a primer intento -> ok');
  r := create_owner_withdrawal('00000000-0000-0000-0000-0000001a7101'::uuid, 1234, v_cur, '00000000-0000-0000-0000-0000001a7301'::uuid, 'idem', 'KEY-W');
  PERFORM pg_temp.assert((r->>'replay')::boolean, 'W9b segundo intento -> replay');
  RESET ROLE;
END $$;

-- Verificaciones que LEEN tablas (rol postgres)
SELECT pg_temp.assert((SELECT date FROM owner_withdrawals WHERE business_id=:'bizA' AND amount=700)=public.ar_today(), 'W3b fecha persistida = ar_today()');
SELECT pg_temp.assert((SELECT pt.date FROM owner_withdrawals w JOIN personal_transactions pt ON pt.id=w.personal_transaction_id WHERE w.business_id=:'bizA' AND w.amount=700)=public.ar_today(), 'W3c personal_tx fecha = ar_today()');
SELECT pg_temp.assert((SELECT fm.date FROM owner_withdrawals w JOIN financial_movements fm ON fm.id=w.business_financial_movement_id WHERE w.business_id=:'bizA' AND w.amount=700)=public.ar_today(), 'W3d FM fecha = ar_today()');
SELECT pg_temp.assert(
  (SELECT a.economic_date FROM owner_withdrawals w JOIN finance_audit_log a ON a.entity_id=w.id AND a.action='owner_withdrawal' WHERE w.business_id=:'bizA' AND w.amount=700)
  = (SELECT date FROM owner_withdrawals WHERE business_id=:'bizA' AND amount=700), 'W4 fecha auditada = fecha persistida');
SELECT pg_temp.assert((SELECT count(*) FROM owner_withdrawals w JOIN finance_audit_log a ON a.entity_id=w.id AND a.action='owner_withdrawal' WHERE w.business_id=:'bizA' AND w.amount=700)=1, 'W11 un evento por operación');
SELECT pg_temp.assert((SELECT a.source_rpc FROM owner_withdrawals w JOIN finance_audit_log a ON a.entity_id=w.id WHERE w.business_id=:'bizA' AND w.amount=700 LIMIT 1)='create_owner_withdrawal', 'W11b source_rpc correcto');
SELECT pg_temp.assert((SELECT (a.new_data->>'amount')::numeric FROM owner_withdrawals w JOIN finance_audit_log a ON a.entity_id=w.id WHERE w.business_id=:'bizA' AND w.amount=700 LIMIT 1)=700, 'W11c resumen financiero en el evento');
SELECT pg_temp.assert((SELECT count(*) FROM owner_withdrawals WHERE business_id=:'bizA' AND amount=1234)=1, 'W9c replay NO duplica movimiento');
SELECT pg_temp.assert((SELECT count(*) FROM finance_audit_log WHERE request_id='KEY-W' AND action='owner_withdrawal')=1, 'W10 replay NO duplica auditoría');

-- W12/W13 fallo de auditoría revierte TODO
ALTER TABLE finance_audit_log ADD CONSTRAINT tmp_fail_wd CHECK (action <> 'owner_withdrawal') NOT VALID;
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000001a7109';
  r := create_owner_withdrawal('00000000-0000-0000-0000-0000001a7101'::uuid, 9999, public.ar_today(), '00000000-0000-0000-0000-0000001a7301'::uuid, 'audit fail', NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE AND r->>'error_code'='AUDIT_FAILED', 'W12a auditoría rota -> ok:false + AUDIT_FAILED');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT count(*) FROM owner_withdrawals WHERE business_id=:'bizA' AND amount=9999)=0, 'W12b sin owner_withdrawals (rollback total)');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'bizA' AND amount=9999)=0
                  AND (SELECT count(*) FROM personal_transactions WHERE user_id=:'OA' AND amount=9999)=0, 'W13 sin FM ni personal_tx huérfanos');
ALTER TABLE finance_audit_log DROP CONSTRAINT tmp_fail_wd;

-- ═══════ CONTRIBUTION (subconjunto espejo) ══════════════════════════════════
DO $$
DECLARE r jsonb; v_cur date := public.ar_today();
  v_p1 date := date_trunc('month', public.ar_today() - interval '1 month')::date;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000001a7109';  -- OA
  r := create_owner_contribution('00000000-0000-0000-0000-0000001a7101'::uuid, 800, v_cur, '00000000-0000-0000-0000-0000001a7301'::uuid, 'c abierto', NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'C1 período abierto + owner -> ok ('||COALESCE(r->>'error','')||')');
  r := create_owner_contribution('00000000-0000-0000-0000-0000001a7101'::uuid, 400, v_p1 + 5, '00000000-0000-0000-0000-0000001a7301'::uuid, 'c cerrado', NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE AND r->>'error' LIKE 'PERIOD_CLOSED%', 'C4 período cerrado -> PERIOD_CLOSED');
  r := create_owner_contribution('00000000-0000-0000-0000-0000001a7101'::uuid, 600, NULL, '00000000-0000-0000-0000-0000001a7301'::uuid, 'c null', NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'C5 fecha nula -> ok');
  PERFORM create_owner_contribution('00000000-0000-0000-0000-0000001a7101'::uuid, 4321, v_cur, '00000000-0000-0000-0000-0000001a7301'::uuid, 'idem', 'KEY-C');
  r := create_owner_contribution('00000000-0000-0000-0000-0000001a7101'::uuid, 4321, v_cur, '00000000-0000-0000-0000-0000001a7301'::uuid, 'idem', 'KEY-C');
  PERFORM pg_temp.assert((r->>'replay')::boolean, 'C7 replay -> ok');
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000001a7107';  -- cashier
  r := create_owner_contribution('00000000-0000-0000-0000-0000001a7101'::uuid, 113, v_cur, '00000000-0000-0000-0000-0000001a7301'::uuid, 'cashier', NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE, 'C6 rol cashier -> rechazado');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT flow_type FROM owner_withdrawals WHERE business_id=:'bizA' AND amount=800)='contribution', 'C1b flow_type=contribution');
SELECT pg_temp.assert(
  (SELECT a.economic_date FROM owner_withdrawals w JOIN finance_audit_log a ON a.entity_id=w.id AND a.action='owner_contribution' WHERE w.business_id=:'bizA' AND w.amount=800)
  = (SELECT date FROM owner_withdrawals WHERE business_id=:'bizA' AND amount=800), 'C2 fecha auditada = persistida');
SELECT pg_temp.assert((SELECT count(*) FROM owner_withdrawals w JOIN finance_audit_log a ON a.entity_id=w.id AND a.action='owner_contribution' WHERE w.business_id=:'bizA' AND w.amount=800)=1, 'C3 un evento por operación');
SELECT pg_temp.assert((SELECT date FROM owner_withdrawals WHERE business_id=:'bizA' AND amount=600)=public.ar_today(), 'C5b fecha nula -> ar_today() persistida');
SELECT pg_temp.assert((SELECT count(*) FROM owner_withdrawals WHERE business_id=:'bizA' AND amount=4321)=1, 'C7b replay NO duplica movimiento');
SELECT pg_temp.assert((SELECT count(*) FROM finance_audit_log WHERE request_id='KEY-C' AND action='owner_contribution')=1, 'C8 replay NO duplica auditoría');

-- ═══════ 6A.1 — contrato de error + normalización de key + key compartida ═══
DO $$
DECLARE r jsonb; v_cur date := public.ar_today();
  v_p1 date := date_trunc('month', public.ar_today() - interval '1 month')::date;
BEGIN
  -- UNAUTHORIZED: sin auth.uid() (claim vacío -> auth.uid() NULL)
  RESET ROLE;
  SET LOCAL "request.jwt.claim.sub" = '';
  r := create_owner_withdrawal('00000000-0000-0000-0000-0000001a7101'::uuid, 100, v_cur, '00000000-0000-0000-0000-0000001a7301'::uuid, 'noauth', NULL);
  PERFORM pg_temp.assert(r->>'error_code'='UNAUTHORIZED', 'EC1 sin auth -> UNAUTHORIZED');

  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000001a7107';  -- cashier
  r := create_owner_withdrawal('00000000-0000-0000-0000-0000001a7101'::uuid, 100, v_cur, '00000000-0000-0000-0000-0000001a7301'::uuid, 'csh', NULL);
  PERFORM pg_temp.assert(r->>'error_code'='FORBIDDEN', 'EC2 rol no autorizado -> FORBIDDEN');
  RESET ROLE;

  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000001a7109';  -- OA
  r := create_owner_withdrawal('00000000-0000-0000-0000-0000001a7101'::uuid, 0, v_cur, '00000000-0000-0000-0000-0000001a7301'::uuid, 'zero', NULL);
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'EC3 monto<=0 -> VALIDATION_ERROR');
  r := create_owner_withdrawal('00000000-0000-0000-0000-0000001a7101'::uuid, 100, v_cur, '00000000-0000-0000-0000-0000001a7301'::uuid, 'longkey', repeat('x',201));
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'EC4 key demasiado larga -> VALIDATION_ERROR');
  r := create_owner_withdrawal('00000000-0000-0000-0000-0000001a7101'::uuid, 100, v_p1 + 3, '00000000-0000-0000-0000-0000001a7301'::uuid, 'closed', NULL);
  PERFORM pg_temp.assert(r->>'error_code'='PERIOD_CLOSED', 'EC5 período cerrado -> error_code PERIOD_CLOSED');

  -- IDEMPOTENCY_CONFLICT: misma key, payload distinto
  PERFORM create_owner_withdrawal('00000000-0000-0000-0000-0000001a7101'::uuid, 100, v_cur, '00000000-0000-0000-0000-0000001a7301'::uuid, 'k2', 'K2');
  r := create_owner_withdrawal('00000000-0000-0000-0000-0000001a7101'::uuid, 200, v_cur, '00000000-0000-0000-0000-0000001a7301'::uuid, 'k2', 'K2');
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT', 'EC6 misma key + payload distinto -> IDEMPOTENCY_CONFLICT');

  -- Clave compartida entre tipos: retiro con SHARED, luego aporte con SHARED -> conflict
  PERFORM create_owner_withdrawal('00000000-0000-0000-0000-0000001a7101'::uuid, 150, v_cur, '00000000-0000-0000-0000-0000001a7301'::uuid, 'shared', 'SHARED');
  r := create_owner_contribution('00000000-0000-0000-0000-0000001a7101'::uuid, 150, v_cur, '00000000-0000-0000-0000-0000001a7301'::uuid, 'shared', 'SHARED');
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT', 'EC7 misma key retiro/aporte -> IDEMPOTENCY_CONFLICT (key única por negocio)');

  -- Key vacía/espacios = sin idempotencia (dos operaciones distintas)
  PERFORM create_owner_withdrawal('00000000-0000-0000-0000-0000001a7101'::uuid, 777, v_cur, '00000000-0000-0000-0000-0000001a7301'::uuid, 'empty1', '   ');
  r := create_owner_withdrawal('00000000-0000-0000-0000-0000001a7101'::uuid, 777, v_cur, '00000000-0000-0000-0000-0000001a7301'::uuid, 'empty2', '   ');
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean IS FALSE, 'EC8 key vacía -> sin idempotencia (no replay)');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT count(*) FROM owner_withdrawals WHERE business_id=:'bizA' AND amount=777)=2, 'EC8b key vacía -> dos operaciones (no deduplicadas)');
SELECT pg_temp.assert((SELECT count(*) FROM owner_flow_requests WHERE business_id=:'bizA' AND idempotency_key='SHARED')=1, 'EC7b key SHARED -> una sola request (compartida por negocio)');

-- ═══════ 6A.1 — seguridad de owner_flow_requests ════════════════════════════
-- Catálogo
SELECT pg_temp.assert(NOT has_table_privilege('anon','public.owner_flow_requests','SELECT'), 'SR1 anon NO SELECT');
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.owner_flow_requests','SELECT'), 'SR2 authenticated NO SELECT');
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.owner_flow_requests','INSERT'), 'SR3 authenticated NO INSERT');
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.owner_flow_requests','UPDATE'), 'SR4 authenticated NO UPDATE');
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.owner_flow_requests','DELETE'), 'SR5 authenticated NO DELETE');
SELECT pg_temp.assert(NOT has_table_privilege('service_role','public.owner_flow_requests','UPDATE'), 'SR6 service_role NO UPDATE');
SELECT pg_temp.assert(NOT has_table_privilege('service_role','public.owner_flow_requests','DELETE'), 'SR7 service_role NO DELETE');
-- Prueba directa con rol authenticated
DO $$
DECLARE e text;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000001a7109';  -- OA owner
  e:=''; BEGIN PERFORM 1 FROM owner_flow_requests WHERE business_id='00000000-0000-0000-0000-0000001a7101'; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e<>'', 'SR8 owner (authenticated) NO puede leer owner_flow_requests directo');
  RESET ROLE;
END $$;
-- Inmutabilidad (rol postgres): completar withdrawal_id NULL->valor OK; luego inmutable; DELETE prohibido
DO $$
DECLARE v_id uuid; e text;
BEGIN
  INSERT INTO owner_flow_requests(business_id,user_id,op,idempotency_key,request_hash)
    VALUES ('00000000-0000-0000-0000-0000001a7101','00000000-0000-0000-0000-0000001a7109','withdrawal','IMMUT','h') RETURNING id INTO v_id;
  UPDATE owner_flow_requests SET withdrawal_id='00000000-0000-0000-0000-0000001a7101' WHERE id=v_id;  -- enlace NULL->valor OK
  PERFORM pg_temp.assert(true, 'SR9 enlace withdrawal_id NULL->valor permitido');
  e:=''; BEGIN UPDATE owner_flow_requests SET request_hash='hacked' WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e<>'', 'SR10 request completada inmutable (UPDATE bloqueado)');
  e:=''; BEGIN DELETE FROM owner_flow_requests WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e<>'', 'SR11 DELETE de request prohibido');
END $$;

ROLLBACK;
