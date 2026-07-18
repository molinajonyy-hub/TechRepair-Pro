-- ============================================================================
-- M7 Bloque 6B — create_expense_with_finance / create_manual_cash_movement_atomic
-- Guard de período, fecha económica persistida y auditada, cross-tenant, roles
-- (preservados), idempotencia (replay/conflicto), un evento de auditoría, rollback
-- si falla auditoría, request tables protegidas e inmutables (misma-empresa),
-- contrato de error {ok,error_code,error}. Concurrencia: harness aparte.
-- RUN: docker cp … && psql -X -f  (una tx + ROLLBACK).
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set bizA '00000000-0000-0000-0000-0000002b7101'
\set OA   '00000000-0000-0000-0000-0000002b7109'
\set ADM  '00000000-0000-0000-0000-0000002b7108'
\set CSH  '00000000-0000-0000-0000-0000002b7107'
\set bizB '00000000-0000-0000-0000-0000002b7201'
\set OB   '00000000-0000-0000-0000-0000002b7209'
\set CAJA '00000000-0000-0000-0000-0000002b7301'
\set EXPB '00000000-0000-0000-0000-0000002b7401'
\set FMB  '00000000-0000-0000-0000-0000002b7501'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'OA'),(:'ADM'),(:'CSH'),(:'OB');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'bizA','6B A',:'OA'),(:'bizB','6B B',:'OB');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES
  (:'bizA',:'OA','owner',true),(:'bizA',:'ADM','admin',true),(:'bizA',:'CSH','cashier',true),(:'bizB',:'OB','owner',true);
INSERT INTO cajas(id,business_id,opened_by,status) VALUES (:'CAJA',:'bizA',:'OA','abierta');
-- entidades de bizB para probar el enlace cross-empresa de requests
INSERT INTO business_finance_entries(id,business_id,date,type,category,description,amount,currency,amount_ars,exchange_rate)
  VALUES ('00000000-0000-0000-0000-0000002b74e1',:'bizB','2026-07-01','fixed_cost_local','x','bfe B',10,'ARS',10,1);
INSERT INTO expenses(id,description,category,amount,amount_ars,date,business_id,finance_entry_id)
  VALUES (:'EXPB','exp B','operativos',10,10,'2026-07-01',:'bizB','00000000-0000-0000-0000-0000002b74e1');
INSERT INTO financial_movements(id,business_id,type,currency,amount,amount_ars,exchange_rate,source,description,date,created_by)
  VALUES (:'FMB',:'bizB','income','ARS',10,10,1,'manual','fm B','2026-07-05',:'OB');
SET LOCAL session_replication_role='origin';

DO $$ DECLARE v_p1 date := date_trunc('month', public.ar_today() - interval '1 month')::date;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002b7109';
  PERFORM close_period('00000000-0000-0000-0000-0000002b7101'::uuid, v_p1, 'setup 6B'); RESET ROLE;
END $$;

-- ═══════════════ create_expense_with_finance ═══════════════════════════════
DO $$
DECLARE r jsonb; v_cur date := public.ar_today();
  v_p1 date := date_trunc('month', public.ar_today() - interval '1 month')::date;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002b7109';  -- OA
  r := create_expense_with_finance('00000000-0000-0000-0000-0000002b7101'::uuid,'00000000-0000-0000-0000-0000002b7109'::uuid,'gasto abierto','operativos','otros_fijos_local','fixed_cost_local',1000,'efectivo',v_cur,false,NULL,NULL,NULL,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'E1 período abierto -> ok ('||COALESCE(r->>'error','')||')');
  r := create_expense_with_finance('00000000-0000-0000-0000-0000002b7101'::uuid,'00000000-0000-0000-0000-0000002b7109'::uuid,'gasto cerrado','operativos','otros_fijos_local','fixed_cost_local',500,'efectivo',v_p1+10,false,NULL,NULL,NULL,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='PERIOD_CLOSED', 'E2 período cerrado -> PERIOD_CLOSED');
  r := create_expense_with_finance('00000000-0000-0000-0000-0000002b7101'::uuid,'00000000-0000-0000-0000-0000002b7109'::uuid,'gasto null','operativos','otros_fijos_local','fixed_cost_local',700,'efectivo',NULL,false,NULL,NULL,NULL,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'E3 fecha nula -> ok');
  -- payload inválido
  r := create_expense_with_finance('00000000-0000-0000-0000-0000002b7101'::uuid,'00000000-0000-0000-0000-0000002b7109'::uuid,'','operativos','otros_fijos_local','fixed_cost_local',10,'efectivo',v_cur,false,NULL,NULL,NULL,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'E4 descripción vacía -> VALIDATION_ERROR');
  r := create_expense_with_finance('00000000-0000-0000-0000-0000002b7101'::uuid,'00000000-0000-0000-0000-0000002b7109'::uuid,'x','operativos','otros_fijos_local','fixed_cost_local',0,'efectivo',v_cur,false,NULL,NULL,NULL,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'E5 monto<=0 -> VALIDATION_ERROR');
  -- roles miembros (gasto no tenía restricción de rol; se preserva: todo miembro activo)
  r := create_expense_with_finance('00000000-0000-0000-0000-0000002b7101'::uuid,NULL,'admin gasto','operativos','otros_fijos_local','fixed_cost_local',300,'efectivo',v_cur,false,NULL,NULL,NULL,NULL);
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002b7108';  -- admin
  r := create_expense_with_finance('00000000-0000-0000-0000-0000002b7101'::uuid,NULL,'admin gasto','operativos','otros_fijos_local','fixed_cost_local',300,'efectivo',v_cur,false,NULL,NULL,NULL,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'E6 admin (miembro) -> ok');
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002b7107';  -- cashier (miembro)
  r := create_expense_with_finance('00000000-0000-0000-0000-0000002b7101'::uuid,NULL,'cashier gasto','operativos','otros_fijos_local','fixed_cost_local',250,'efectivo',v_cur,false,NULL,NULL,NULL,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'E7 cashier (miembro) -> ok (rol preservado, sin restricción previa)');
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002b7209';  -- OB (no miembro de A)
  r := create_expense_with_finance('00000000-0000-0000-0000-0000002b7101'::uuid,NULL,'cross','operativos','otros_fijos_local','fixed_cost_local',999,'efectivo',v_cur,false,NULL,NULL,NULL,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='FORBIDDEN', 'E8 cross-tenant (no miembro) -> FORBIDDEN');
  RESET ROLE;
  -- idempotencia
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002b7109';  -- OA
  PERFORM create_expense_with_finance('00000000-0000-0000-0000-0000002b7101'::uuid,NULL,'idem','operativos','otros_fijos_local','fixed_cost_local',1234,'efectivo',v_cur,false,NULL,NULL,NULL,'EK');
  r := create_expense_with_finance('00000000-0000-0000-0000-0000002b7101'::uuid,NULL,'idem','operativos','otros_fijos_local','fixed_cost_local',1234,'efectivo',v_cur,false,NULL,NULL,NULL,'EK');
  PERFORM pg_temp.assert((r->>'replay')::boolean, 'E9 replay mismo key+payload');
  PERFORM create_expense_with_finance('00000000-0000-0000-0000-0000002b7101'::uuid,NULL,'idem','operativos','otros_fijos_local','fixed_cost_local',100,'efectivo',v_cur,false,NULL,NULL,NULL,'EK2');
  r := create_expense_with_finance('00000000-0000-0000-0000-0000002b7101'::uuid,NULL,'idem','operativos','otros_fijos_local','fixed_cost_local',200,'efectivo',v_cur,false,NULL,NULL,NULL,'EK2');
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT', 'E10 mismo key payload distinto -> IDEMPOTENCY_CONFLICT');
  RESET ROLE;
END $$;
-- Verificaciones que leen tablas (postgres)
SELECT pg_temp.assert((SELECT date FROM expenses WHERE business_id=:'bizA' AND amount=700)=public.ar_today(), 'E3b expenses.date = ar_today()');
SELECT pg_temp.assert((SELECT b.date FROM expenses e JOIN business_finance_entries b ON b.id=e.finance_entry_id WHERE e.business_id=:'bizA' AND e.amount=700)=public.ar_today(), 'E3c BFE.date = ar_today()');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'bizA' AND amount=700 AND source='expense')=1, 'E3d FM del gasto creado');
SELECT pg_temp.assert(
  (SELECT a.economic_date FROM expenses e JOIN finance_audit_log a ON a.entity_id=e.id AND a.action='operating_expense_create' WHERE e.business_id=:'bizA' AND e.amount=700)
  = (SELECT date FROM expenses WHERE business_id=:'bizA' AND amount=700), 'E11 fecha auditada = persistida');
SELECT pg_temp.assert((SELECT count(*) FROM expenses e JOIN finance_audit_log a ON a.entity_id=e.id AND a.action='operating_expense_create' WHERE e.business_id=:'bizA' AND e.amount=700)=1, 'E12 exactamente un evento de auditoría');
SELECT pg_temp.assert((SELECT a.source_rpc FROM expenses e JOIN finance_audit_log a ON a.entity_id=e.id WHERE e.business_id=:'bizA' AND e.amount=700 LIMIT 1)='create_expense_with_finance', 'E12b source_rpc correcto');
SELECT pg_temp.assert((SELECT count(*) FROM expenses WHERE business_id=:'bizA' AND amount=1234)=1, 'E9b replay NO duplica movimiento');
SELECT pg_temp.assert((SELECT count(*) FROM finance_audit_log WHERE request_id='EK' AND action='operating_expense_create')=1, 'E9c replay NO duplica auditoría');
-- payload inválido no escribió
SELECT pg_temp.assert((SELECT count(*) FROM expenses WHERE business_id=:'bizA' AND amount=0)=0, 'E4b payload inválido -> sin escritura');

-- Rollback si falla la auditoría del gasto
ALTER TABLE finance_audit_log ADD CONSTRAINT tmp_fail_exp CHECK (action <> 'operating_expense_create') NOT VALID;
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002b7109';
  r := create_expense_with_finance('00000000-0000-0000-0000-0000002b7101'::uuid,NULL,'audit fail','operativos','otros_fijos_local','fixed_cost_local',9999,'efectivo',public.ar_today(),false,NULL,NULL,NULL,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE AND r->>'error_code'='AUDIT_FAILED', 'E13 auditoría rota -> AUDIT_FAILED');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT count(*) FROM expenses WHERE business_id=:'bizA' AND amount=9999)=0
                  AND (SELECT count(*) FROM business_finance_entries WHERE business_id=:'bizA' AND amount=9999)=0
                  AND (SELECT count(*) FROM financial_movements WHERE business_id=:'bizA' AND amount=9999)=0, 'E14 rollback total (sin escrituras parciales)');
ALTER TABLE finance_audit_log DROP CONSTRAINT tmp_fail_exp;

-- ═══════════════ create_manual_cash_movement_atomic ════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002b7109';  -- OA
  r := create_manual_cash_movement_atomic('00000000-0000-0000-0000-0000002b7101'::uuid,'income','efectivo',500,'ingreso manual','00000000-0000-0000-0000-0000002b7109'::uuid,1,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'M1 income con caja abierta -> ok ('||COALESCE(r->>'error','')||')');
  r := create_manual_cash_movement_atomic('00000000-0000-0000-0000-0000002b7101'::uuid,'expense','efectivo',400,'egreso manual','00000000-0000-0000-0000-0000002b7109'::uuid,1,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'M2 expense con caja abierta -> ok');
  -- payload inválido
  r := create_manual_cash_movement_atomic('00000000-0000-0000-0000-0000002b7101'::uuid,'foo','efectivo',100,'x','00000000-0000-0000-0000-0000002b7109'::uuid,1,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'M3 tipo inválido -> VALIDATION_ERROR');
  r := create_manual_cash_movement_atomic('00000000-0000-0000-0000-0000002b7101'::uuid,'income','efectivo',0,'x','00000000-0000-0000-0000-0000002b7109'::uuid,1,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'M4 monto<=0 -> VALIDATION_ERROR');
  -- cross-tenant
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002b7209';  -- OB
  r := create_manual_cash_movement_atomic('00000000-0000-0000-0000-0000002b7101'::uuid,'income','efectivo',100,'cross','00000000-0000-0000-0000-0000002b7209'::uuid,1,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='FORBIDDEN', 'M5 cross-tenant -> FORBIDDEN');
  RESET ROLE;
  -- cashier miembro (rol preservado de M6: cualquier perfil activo)
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002b7107';  -- cashier
  r := create_manual_cash_movement_atomic('00000000-0000-0000-0000-0000002b7101'::uuid,'income','efectivo',60,'cashier','00000000-0000-0000-0000-0000002b7107'::uuid,1,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'M6 cashier (miembro) -> ok');
  RESET ROLE;
  -- idempotencia
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002b7109';  -- OA
  PERFORM create_manual_cash_movement_atomic('00000000-0000-0000-0000-0000002b7101'::uuid,'income','efectivo',1500,'idem','00000000-0000-0000-0000-0000002b7109'::uuid,1,'MK');
  r := create_manual_cash_movement_atomic('00000000-0000-0000-0000-0000002b7101'::uuid,'income','efectivo',1500,'idem','00000000-0000-0000-0000-0000002b7109'::uuid,1,'MK');
  PERFORM pg_temp.assert((r->>'replay')::boolean, 'M7 replay mismo key+payload');
  PERFORM create_manual_cash_movement_atomic('00000000-0000-0000-0000-0000002b7101'::uuid,'income','efectivo',111,'idem','00000000-0000-0000-0000-0000002b7109'::uuid,1,'MK2');
  r := create_manual_cash_movement_atomic('00000000-0000-0000-0000-0000002b7101'::uuid,'income','efectivo',222,'idem','00000000-0000-0000-0000-0000002b7109'::uuid,1,'MK2');
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT', 'M8 mismo key payload distinto -> IDEMPOTENCY_CONFLICT');
  RESET ROLE;
END $$;
-- fecha persistida = ar_today() + auditada; acciones por tipo; un evento
SELECT pg_temp.assert((SELECT date FROM financial_movements WHERE business_id=:'bizA' AND amount=500 AND source='manual')=public.ar_today(), 'M1b FM.date = ar_today()');
SELECT pg_temp.assert(
  (SELECT a.economic_date FROM financial_movements f JOIN finance_audit_log a ON a.entity_id=f.id AND a.action='manual_cash_income' WHERE f.business_id=:'bizA' AND f.amount=500)
  = (SELECT date FROM financial_movements WHERE business_id=:'bizA' AND amount=500 AND source='manual'), 'M9 fecha auditada = persistida');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements f JOIN finance_audit_log a ON a.entity_id=f.id AND a.action='manual_cash_income' WHERE f.business_id=:'bizA' AND f.amount=500)=1, 'M10 income -> un evento manual_cash_income');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements f JOIN finance_audit_log a ON a.entity_id=f.id AND a.action='manual_cash_expense' WHERE f.business_id=:'bizA' AND f.amount=400)=1, 'M11 expense -> un evento manual_cash_expense (tipo en la acción)');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'bizA' AND amount=1500 AND source='manual')=1, 'M7b replay NO duplica movimiento');
SELECT pg_temp.assert((SELECT count(*) FROM finance_audit_log WHERE request_id='MK' AND action='manual_cash_income')=1, 'M7c replay NO duplica auditoría');

-- CASH_REGISTER_NOT_OPEN (negocio sin caja abierta: bizB)
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002b7209';  -- OB (bizB sin caja)
  r := create_manual_cash_movement_atomic('00000000-0000-0000-0000-0000002b7201'::uuid,'income','efectivo',100,'sin caja','00000000-0000-0000-0000-0000002b7209'::uuid,1,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='CASH_REGISTER_NOT_OPEN', 'M12 sin caja abierta -> CASH_REGISTER_NOT_OPEN');
  RESET ROLE;
END $$;

-- Guard defensivo del período ACTUAL (se fuerza un lock del mes en curso directo)
DO $$
DECLARE r jsonb; v_start date := date_trunc('month', public.ar_today())::date;
  v_end date := (date_trunc('month', public.ar_today()) + interval '1 month - 1 day')::date;
BEGIN
  INSERT INTO finance_period_locks(business_id,period_start,period_end,status,closed_at,closed_by)
    VALUES ('00000000-0000-0000-0000-0000002b7101',v_start,v_end,'closed',now(),'00000000-0000-0000-0000-0000002b7109');
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002b7109';
  r := create_manual_cash_movement_atomic('00000000-0000-0000-0000-0000002b7101'::uuid,'income','efectivo',77,'periodo actual cerrado','00000000-0000-0000-0000-0000002b7109'::uuid,1,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='PERIOD_CLOSED', 'M13 guard defensivo: mes en curso cerrado (forzado) -> PERIOD_CLOSED');
  RESET ROLE;
  DELETE FROM finance_period_locks WHERE business_id='00000000-0000-0000-0000-0000002b7101' AND period_start=v_start;
END $$;

-- Rollback si falla la auditoría del movimiento de caja
ALTER TABLE finance_audit_log ADD CONSTRAINT tmp_fail_mcm CHECK (action <> 'manual_cash_income') NOT VALID;
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000002b7109';
  r := create_manual_cash_movement_atomic('00000000-0000-0000-0000-0000002b7101'::uuid,'income','efectivo',8888,'audit fail','00000000-0000-0000-0000-0000002b7109'::uuid,1,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE AND r->>'error_code'='AUDIT_FAILED', 'M14 auditoría rota -> AUDIT_FAILED');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'bizA' AND amount=8888)=0, 'M15 rollback total (sin FM huérfano)');
ALTER TABLE finance_audit_log DROP CONSTRAINT tmp_fail_mcm;

-- ═══════════════ request tables protegidas + relación misma-empresa ════════
SELECT pg_temp.assert(NOT has_table_privilege('anon','public.expense_requests','SELECT'), 'RT1 anon NO SELECT expense_requests');
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.expense_requests','SELECT'), 'RT2 authenticated NO SELECT expense_requests');
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.expense_requests','INSERT'), 'RT3 authenticated NO INSERT expense_requests');
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.manual_cash_movement_requests','SELECT'), 'RT4 authenticated NO SELECT manual_cash_movement_requests');
SELECT pg_temp.assert(NOT has_table_privilege('service_role','public.expense_requests','UPDATE'), 'RT5 service_role NO UPDATE expense_requests');
SELECT pg_temp.assert(NOT has_table_privilege('service_role','public.manual_cash_movement_requests','DELETE'), 'RT6 service_role NO DELETE manual_cash_movement_requests');

-- Inmutabilidad + enlace debe ser del MISMO negocio
DO $$
DECLARE v_id uuid; e text;
BEGIN
  -- expense_requests: enlazar a un expense de bizB -> rechazado
  INSERT INTO expense_requests(business_id,user_id,op,idempotency_key,request_hash)
    VALUES ('00000000-0000-0000-0000-0000002b7101','00000000-0000-0000-0000-0000002b7109','operating_expense','X-LINK','h') RETURNING id INTO v_id;
  e:=''; BEGIN UPDATE expense_requests SET expense_id='00000000-0000-0000-0000-0000002b7401' WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%no pertenece al negocio%', 'RT7 expense_requests: enlace a entidad de OTRO negocio -> rechazado');
  e:=''; BEGIN DELETE FROM expense_requests WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e<>'', 'RT8 expense_requests: DELETE prohibido');

  -- manual_cash_movement_requests: enlazar a un FM de bizB -> rechazado
  INSERT INTO manual_cash_movement_requests(business_id,user_id,op,idempotency_key,request_hash)
    VALUES ('00000000-0000-0000-0000-0000002b7101','00000000-0000-0000-0000-0000002b7109','income','Y-LINK','h') RETURNING id INTO v_id;
  e:=''; BEGIN UPDATE manual_cash_movement_requests SET financial_movement_id='00000000-0000-0000-0000-0000002b7501' WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%no pertenece al negocio%' OR e LIKE '%tipo no coincide%', 'RT9 manual_cash req: enlace a FM de OTRO negocio -> rechazado');
END $$;

ROLLBACK;
