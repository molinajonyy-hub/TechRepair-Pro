-- ============================================================================
-- M7 (Bloque 2 + 2.5) — finance_period_locks + finance_audit_log + reconciliación
-- Cierre/reapertura, guard fail-closed con advisory lock, auditoría append-only
-- real (incl. service_role), backstop sin swallow silencioso, dedup híbrido,
-- helpers internos no expuestos, grants efectivos por catálogo.
-- RUN: docker cp … && psql -X -f  (una tx + ROLLBACK — no deja datos).
-- La concurrencia (2 sesiones) va en un harness aparte (no cabe en 1 tx).
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set bizA  '00000000-0000-0000-0000-0000000e7101'
\set OA    '00000000-0000-0000-0000-0000000e7109'
\set ADM   '00000000-0000-0000-0000-0000000e7108'
\set STF   '00000000-0000-0000-0000-0000000e7107'
\set bizB  '00000000-0000-0000-0000-0000000e7201'
\set OB    '00000000-0000-0000-0000-0000000e7209'
\set ACC   '00000000-0000-0000-0000-0000000e7301'
\set CMP   '00000000-0000-0000-0000-0000000e7401'
\set FM1   '00000000-0000-0000-0000-0000000e7601'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'OA'),(:'ADM'),(:'STF'),(:'OB');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'bizA','M7 A',:'OA'),(:'bizB','M7 B',:'OB');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES
  (:'bizA',:'OA','owner',true),(:'bizA',:'ADM','admin',true),(:'bizA',:'STF','cashier',true),
  (:'bizB',:'OB','owner',true);
INSERT INTO accounts(id,business_id,type,entity_id,entity_name)
  VALUES (:'ACC',:'bizA','cliente',:'OA','Cliente Test');
INSERT INTO comprobantes(id,business_id,tipo,total_bruto,total,saldo_pendiente,total_cobrado,estado,status,estado_fiscal,estado_comercial)
  VALUES (:'CMP',:'bizA','remito',1000,1000,1000,0,'emitido','issued','no_fiscal','pendiente');
INSERT INTO financial_movements(id,business_id,type,currency,amount,amount_ars,exchange_rate,source,description,date,caja_id,created_by)
  VALUES (:'FM1',:'bizA','income','ARS',500,500,1,'manual','FM legacy sin caja','2026-05-20',NULL,:'OA');
SET LOCAL session_replication_role='origin';

-- ═══════════════ PERÍODOS: RPC públicas (rol authenticated) ═════════════════
DO $$
DECLARE r jsonb;
  v_cur date := date_trunc('month', public.ar_today())::date;
  v_fut date := date_trunc('month', public.ar_today() + interval '1 month')::date;
  v_p1  date := date_trunc('month', public.ar_today() - interval '1 month')::date;
  v_p2  date := date_trunc('month', public.ar_today() - interval '2 month')::date;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e7109';  -- OA owner
  r := close_period('00000000-0000-0000-0000-0000000e7101'::uuid, v_p1, 'cierre mes pasado');
  PERFORM pg_temp.assert((r->>'ok')::boolean AND r->>'status'='closed', 'P1 cierre exitoso ('||COALESCE(r->>'error','')||')');
  r := close_period('00000000-0000-0000-0000-0000000e7101'::uuid, v_p1, 'otra vez');
  PERFORM pg_temp.assert((r->>'replay')::boolean, 'P2 cierre idempotente -> replay');
  r := close_period('00000000-0000-0000-0000-0000000e7101'::uuid, v_cur, 'x');
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE AND r->>'error' LIKE '%en curso%', 'P3 no cerrar mes en curso');
  r := close_period('00000000-0000-0000-0000-0000000e7101'::uuid, v_fut, 'x');
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE AND r->>'error' LIKE '%futuro%', 'P4 no cerrar mes futuro');
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e7107';  -- cashier
  r := close_period('00000000-0000-0000-0000-0000000e7101'::uuid, v_p2, 'staff');
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE, 'P5 rol sin permiso -> cierre rechazado');
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e7209';  -- OB
  r := close_period('00000000-0000-0000-0000-0000000e7101'::uuid, v_p2, 'cross');
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE, 'P6 cierre cross-tenant -> rechazado');
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e7108';  -- admin
  r := close_period('00000000-0000-0000-0000-0000000e7101'::uuid, v_p2, 'admin cierra p2');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'P7 admin cierra período anterior -> ok');
  r := reopen_period('00000000-0000-0000-0000-0000000e7101'::uuid, v_p1, 'admin quiere');
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE, 'P8 reapertura por admin -> rechazada (sólo owner)');
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e7209';  -- OB
  r := reopen_period('00000000-0000-0000-0000-0000000e7101'::uuid, v_p1, 'ob');
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE, 'P9 reapertura cross-tenant -> rechazada');
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e7109';  -- OA owner
  r := reopen_period('00000000-0000-0000-0000-0000000e7101'::uuid, v_p1, '   ');
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE, 'P10 reapertura sin motivo -> rechazada');
  r := reopen_period('00000000-0000-0000-0000-0000000e7101'::uuid, v_p2, 'fuera de orden');
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE AND r->>'error' LIKE '%orden cronológico%', 'P11 no reabrir con posterior cerrado');
  r := reopen_period('00000000-0000-0000-0000-0000000e7101'::uuid, v_p1, 'error de carga');
  PERFORM pg_temp.assert((r->>'ok')::boolean AND r->>'status'='reopened', 'P12 reapertura válida (owner+motivo, más reciente)');
  r := reopen_period('00000000-0000-0000-0000-0000000e7101'::uuid, v_p2, 'ahora en orden');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'P13 reapertura en orden cronológico inverso -> ok');
  r := close_period('00000000-0000-0000-0000-0000000e7101'::uuid, v_p1, 'segundo cierre');
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean IS FALSE, 'P14 segundo cierre tras reapertura -> ok');
  RESET ROLE;
END $$;

-- Estado tras el bloque anterior: p1 CERRADO (2º cierre), p2 REABIERTO.
SELECT pg_temp.assert((SELECT status FROM finance_period_locks WHERE business_id=:'bizA'
  AND period_start=date_trunc('month', public.ar_today() - interval '1 month')::date)='closed', 'P15 estado p1 = closed (por tabla)');
SELECT pg_temp.assert((SELECT status FROM finance_period_locks WHERE business_id=:'bizA'
  AND period_start=date_trunc('month', public.ar_today() - interval '2 month')::date)='reopened', 'P16 estado p2 = reopened (por tabla)');

-- ═══════════════ GUARD: lógica + fail-closed (rol postgres, interno) ════════
DO $$
DECLARE e text;
  v_cur date := date_trunc('month', public.ar_today())::date;
  v_p1  date := date_trunc('month', public.ar_today() - interval '1 month')::date;
  v_p2  date := date_trunc('month', public.ar_today() - interval '2 month')::date;
BEGIN
  e:=''; BEGIN PERFORM assert_period_open('00000000-0000-0000-0000-0000000e7101'::uuid, v_p1 + 15); EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE 'PERIOD_CLOSED%', 'G-P1 retroactivo en período cerrado -> bloqueado');
  PERFORM assert_period_open('00000000-0000-0000-0000-0000000e7101'::uuid, v_p2 + 15);  -- p2 reabierto -> ok
  PERFORM pg_temp.assert(true, 'G-P2 período reabierto -> permitido');
  PERFORM assert_period_open('00000000-0000-0000-0000-0000000e7101'::uuid, v_cur + 5);
  PERFORM pg_temp.assert(true, 'G-P3 período en curso (abierto) -> permitido');
  -- FAIL-CLOSED
  e:=''; BEGIN PERFORM assert_period_open(NULL::uuid, v_cur); EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE 'INVALID_FINANCE_CONTEXT%', 'G-P4 business_id NULL -> INVALID_FINANCE_CONTEXT');
  e:=''; BEGIN PERFORM assert_period_open('00000000-0000-0000-0000-0000000e7101'::uuid, NULL::date); EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE 'INVALID_FINANCE_CONTEXT%', 'G-P5 fecha NULL -> INVALID_FINANCE_CONTEXT');
END $$;

-- Bordes de mes AR + cambio de año (funciones puras)
SELECT pg_temp.assert((SELECT period_end FROM finance_period_bounds('2026-02-15'))='2026-02-28', 'B1 borde feb no bisiesto');
SELECT pg_temp.assert((SELECT period_end FROM finance_period_bounds('2028-02-10'))='2028-02-29', 'B2 borde feb bisiesto');
SELECT pg_temp.assert((SELECT period_start FROM finance_period_bounds('2026-12-15'))='2026-12-01'
                  AND (SELECT period_end FROM finance_period_bounds('2026-12-15'))='2026-12-31', 'B3 borde diciembre');
SELECT pg_temp.assert((SELECT period_start FROM finance_period_bounds('2027-01-03'))='2027-01-01', 'B4 borde enero (cambio de año)');

DO $$
DECLARE e text := '';
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e7109';  -- OA
  PERFORM close_period('00000000-0000-0000-0000-0000000e7101'::uuid, '2025-12-01'::date, 'cierre dic 2025');
  RESET ROLE;
  BEGIN PERFORM assert_period_open('00000000-0000-0000-0000-0000000e7101'::uuid, '2025-12-31'::date); EXCEPTION WHEN OTHERS THEN e := SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE 'PERIOD_CLOSED%', 'B5 31-dic-2025 en período cerrado -> bloqueado');
  PERFORM assert_period_open('00000000-0000-0000-0000-0000000e7101'::uuid, '2026-01-01'::date);
  PERFORM pg_temp.assert(true, 'B6 01-ene-2026 (mes distinto) -> permitido (cambio de año)');
END $$;

-- ═══════════════ AUDITORÍA append-only ══════════════════════════════════════
DO $$
DECLARE e text;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e7109';  -- OA owner
  e:=''; BEGIN INSERT INTO finance_audit_log(business_id,action,entity_table) VALUES ('00000000-0000-0000-0000-0000000e7101','forjado','x'); EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e<>'', 'A1 owner NO INSERT directo en finance_audit_log');
  e:=''; BEGIN UPDATE finance_audit_log SET reason='hack' WHERE business_id='00000000-0000-0000-0000-0000000e7101'; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e<>'', 'A2 owner NO UPDATE');
  e:=''; BEGIN DELETE FROM finance_audit_log WHERE business_id='00000000-0000-0000-0000-0000000e7101'; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e<>'', 'A3 owner NO DELETE');
  RESET ROLE;
  -- service_role tampoco puede alterar/borrar
  SET LOCAL ROLE service_role;
  e:=''; BEGIN UPDATE finance_audit_log SET reason='hack' WHERE business_id='00000000-0000-0000-0000-0000000e7101'; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e<>'', 'A4 service_role NO UPDATE (revoke + trigger inmutabilidad)');
  e:=''; BEGIN DELETE FROM finance_audit_log WHERE business_id='00000000-0000-0000-0000-0000000e7101'; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e<>'', 'A5 service_role NO DELETE');
  RESET ROLE;
END $$;

-- Backstop + multi-entidad: flag desarmado NO suprime eventos distintos (2 am + 1 cp)
DO $$
DECLARE n0 int; n1 int;
BEGIN
  PERFORM set_config('m7.audit_managed','0',true);
  SELECT count(*) INTO n0 FROM finance_audit_log WHERE source_rpc='trigger_backstop';
  INSERT INTO account_movements(business_id,account_id,date,type,description,debit,credit,balance_after,reference_type,created_by)
    VALUES ('00000000-0000-0000-0000-0000000e7101','00000000-0000-0000-0000-0000000e7301','2026-07-10','ajuste','am1',100,0,0,'manual','00000000-0000-0000-0000-0000000e7109'),
           ('00000000-0000-0000-0000-0000000e7101','00000000-0000-0000-0000-0000000e7301','2026-07-10','ajuste','am2', 50,0,0,'manual','00000000-0000-0000-0000-0000000e7109');
  INSERT INTO comprobante_payments(comprobante_id,business_id,amount,amount_ars,payment_method,date,created_by)
    VALUES ('00000000-0000-0000-0000-0000000e7401','00000000-0000-0000-0000-0000000e7101',10,10,'transferencia','2026-07-10','00000000-0000-0000-0000-0000000e7109');
  SELECT count(*) INTO n1 FROM finance_audit_log WHERE source_rpc='trigger_backstop';
  PERFORM pg_temp.assert(n1 - n0 = 3, 'D1 backstop: 3 eventos distintos (2 am + 1 cp); flag desarmado no suprime ('||(n1-n0)||')');
END $$;

-- Helper nunca se auto-suprime: 3 acciones distintas -> 3 filas
DO $$
DECLARE n0 int; n1 int;
BEGIN
  SELECT count(*) INTO n0 FROM finance_audit_log WHERE source_rpc='unit_helper';
  PERFORM finance_log_audit('00000000-0000-0000-0000-0000000e7101','evt_a','financial_movements','00000000-0000-0000-0000-0000000e7601','unit_helper','ra',NULL,'2026-05-20',NULL,NULL,NULL,NULL);
  PERFORM finance_log_audit('00000000-0000-0000-0000-0000000e7101','evt_b','financial_movements','00000000-0000-0000-0000-0000000e7601','unit_helper','rb',NULL,'2026-05-20',NULL,NULL,NULL,NULL);
  PERFORM finance_log_audit('00000000-0000-0000-0000-0000000e7101','evt_c','business_finance_entries','00000000-0000-0000-0000-0000000e7601','unit_helper','rc',NULL,'2026-05-20',NULL,NULL,NULL,NULL);
  SELECT count(*) INTO n1 FROM finance_audit_log WHERE source_rpc='unit_helper';
  PERFORM pg_temp.assert(n1 - n0 = 3, 'D2 helper: 3 eventos distintos (no auto-suprime)');
END $$;

-- Dedup lógico: mismo (business, request_id, action, entity) -> 1 fila
DO $$
DECLARE n int;
BEGIN
  PERFORM finance_log_audit('00000000-0000-0000-0000-0000000e7101','dup_evt','financial_movements','00000000-0000-0000-0000-0000000e7601','unit_dedup','REQDUP','r',NULL,NULL,NULL,NULL,NULL);
  PERFORM finance_log_audit('00000000-0000-0000-0000-0000000e7101','dup_evt','financial_movements','00000000-0000-0000-0000-0000000e7601','unit_dedup','REQDUP','r',NULL,NULL,NULL,NULL,NULL);
  SELECT count(*) INTO n FROM finance_audit_log WHERE request_id='REQDUP' AND action='dup_evt';
  PERFORM pg_temp.assert(n = 1, 'D3 dedup por request_id+action+entity -> 1 fila ('||n||')');
END $$;

-- CHECK: request_id NO nulo exige entity_id
DO $$
DECLARE e text := '';
BEGIN
  BEGIN INSERT INTO finance_audit_log(business_id,action,entity_table,request_id,entity_id)
        VALUES ('00000000-0000-0000-0000-0000000e7101','x','financial_movements','R-NOENT',NULL);
  EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%finance_audit_log_reqid_entity_chk%' OR e LIKE '%check constraint%', 'D4 CHECK: request_id sin entity_id -> rechazado');
END $$;

-- Scope de auditoría: finance_begin_audit_scope() suprime el backstop; el helper
-- por sí solo NO (marcar scope != auditar, auditar != marcar scope).
DO $$
DECLARE n0 int; n1 int; n2 int; a0 int; a1 int;
BEGIN
  -- (a) helper solo NO suprime el backstop (semántica vieja m7.audited_tx eliminada)
  PERFORM set_config('m7.audit_managed','0',true);
  SELECT count(*) INTO n0 FROM finance_audit_log WHERE source_rpc='trigger_backstop';
  PERFORM finance_log_audit('00000000-0000-0000-0000-0000000e7101','biz_event','account_movements','00000000-0000-0000-0000-0000000e7601','unit_helper2','RH',NULL,'2026-07-11',NULL,NULL,NULL,NULL);
  INSERT INTO account_movements(business_id,account_id,date,type,description,debit,credit,balance_after,reference_type,created_by)
    VALUES ('00000000-0000-0000-0000-0000000e7101','00000000-0000-0000-0000-0000000e7301','2026-07-11','ajuste','am-nohelper',5,0,0,'manual','00000000-0000-0000-0000-0000000e7109');
  SELECT count(*) INTO n1 FROM finance_audit_log WHERE source_rpc='trigger_backstop';
  PERFORM pg_temp.assert(n1 = n0 + 1, 'D5a helper solo NO suprime el backstop (escritura no gestionada -> backstop registra)');

  -- (b) dentro de un scope gestionado, el backstop se suprime; marcar scope no audita
  PERFORM finance_begin_audit_scope();
  SELECT count(*) INTO a0 FROM finance_audit_log WHERE business_id='00000000-0000-0000-0000-0000000e7101';
  INSERT INTO account_movements(business_id,account_id,date,type,description,debit,credit,balance_after,reference_type,created_by)
    VALUES ('00000000-0000-0000-0000-0000000e7101','00000000-0000-0000-0000-0000000e7301','2026-07-11','ajuste','am-managed',7,0,0,'manual','00000000-0000-0000-0000-0000000e7109');
  SELECT count(*) INTO n2 FROM finance_audit_log WHERE source_rpc='trigger_backstop';
  PERFORM pg_temp.assert(n2 = n1, 'D5b scope gestionado -> backstop suprimido');
  SELECT count(*) INTO a1 FROM finance_audit_log WHERE business_id='00000000-0000-0000-0000-0000000e7101';
  PERFORM pg_temp.assert(a1 = a0, 'D5c marcar scope NO cuenta como auditoría (0 filas nuevas)');
  -- el evento explícito sí produce exactamente 1 fila
  PERFORM finance_log_audit('00000000-0000-0000-0000-0000000e7101','managed_event','financial_movements','00000000-0000-0000-0000-0000000e7601','unit_managed','RM',NULL,'2026-07-11',NULL,NULL,NULL,NULL);
  PERFORM pg_temp.assert((SELECT count(*) FROM finance_audit_log WHERE request_id='RM')=1, 'D5d log explícito -> exactamente un evento');
  PERFORM set_config('m7.audit_managed','0',true);
END $$;

-- Backstop NO silencia fallos inesperados: constraint temporal fuerza el error
-- NOT VALID: no revalida filas existentes (ya hay backstop de D1), sólo las nuevas.
ALTER TABLE finance_audit_log ADD CONSTRAINT tmp_force_fail CHECK (source_rpc IS NULL OR source_rpc <> 'trigger_backstop') NOT VALID;
DO $$
DECLARE e text := '';
BEGIN
  PERFORM set_config('m7.audit_managed','0',true);
  BEGIN
    INSERT INTO account_movements(business_id,account_id,date,type,description,debit,credit,balance_after,reference_type,created_by)
      VALUES ('00000000-0000-0000-0000-0000000e7101','00000000-0000-0000-0000-0000000e7301','2026-07-12','ajuste','am-fail',1,0,0,'manual','00000000-0000-0000-0000-0000000e7109');
  EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e<>'', 'D6 fallo del backstop NO se silencia -> aborta el INSERT de negocio');
END $$;
ALTER TABLE finance_audit_log DROP CONSTRAINT tmp_force_fail;

-- Sin recursión
SELECT pg_temp.assert(
  (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.finance_audit_log'::regclass AND NOT tgisinternal AND tgname <> 'trg_finance_audit_immutable')=0,
  'D7 finance_audit_log sin triggers de INSERT -> sin recursión');

-- Correctitud del evento de cierre/reapertura
SELECT pg_temp.assert(EXISTS(SELECT 1 FROM finance_audit_log WHERE business_id=:'bizA' AND action='period_close'
  AND entity_table='finance_period_locks' AND actor_user_id=:'OA' AND reference_type='finance_period'), 'A6 evento period_close correcto');
SELECT pg_temp.assert(EXISTS(SELECT 1 FROM finance_audit_log WHERE business_id=:'bizA' AND action='period_reopen' AND reason IS NOT NULL), 'A7 evento period_reopen con motivo');

-- Cross-tenant read (RLS)
DO $$
DECLARE n_b int; n_a int;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e7209';  -- OB
  SELECT count(*) INTO n_b FROM finance_audit_log WHERE business_id='00000000-0000-0000-0000-0000000e7101';
  PERFORM pg_temp.assert(n_b = 0, 'A8 OB no ve auditoría de A (RLS)');
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e7109';  -- OA
  SELECT count(*) INTO n_a FROM finance_audit_log WHERE business_id='00000000-0000-0000-0000-0000000e7101';
  PERFORM pg_temp.assert(n_a > 0, 'A9 OA sí ve su auditoría');
  RESET ROLE;
END $$;

-- ═══════════════ HISTÓRICOS (reconciliación) ════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e7109';  -- OA
  r := finance_pending_historicals('00000000-0000-0000-0000-0000000e7101'::uuid);
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'dry_run')::boolean, 'H1 dry-run ok/read-only');
  PERFORM pg_temp.assert(((r->'issues'->0->>'total')::int) >= 1, 'H2 detecta FM sin caja sembrado');
  r := reconcile_ledger_record('00000000-0000-0000-0000-0000000e7101'::uuid,'financial_movements','00000000-0000-0000-0000-0000000e7601','fm_sin_caja','legacy_accepted','pre-invariante',NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'H3 clasificar legacy -> ok');
  r := reconcile_ledger_record('00000000-0000-0000-0000-0000000e7101'::uuid,'financial_movements','00000000-0000-0000-0000-0000000e7601','fm_sin_caja','legacy_accepted','pre-invariante',NULL);
  PERFORM pg_temp.assert((r->>'replay')::boolean, 'H4 misma clasificación -> replay');
  r := reconcile_ledger_record('00000000-0000-0000-0000-0000000e7101'::uuid,'financial_movements','00000000-0000-0000-0000-0000000e7601','fm_sin_caja','corrected','   ',NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE, 'H5 sin motivo -> rechazada');
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e7209';  -- OB
  r := reconcile_ledger_record('00000000-0000-0000-0000-0000000e7101'::uuid,'financial_movements','00000000-0000-0000-0000-0000000e7601','fm_sin_caja','legacy_accepted','cross',NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE, 'H6 reconciliación cross-tenant -> rechazada');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT amount_ars FROM financial_movements WHERE id=:'FM1')=500
                  AND (SELECT date FROM financial_movements WHERE id=:'FM1')='2026-05-20', 'H7 ledger intacto (monto/fecha)');

-- ═══════════════ GRANTS EFECTIVOS (catálogo) ════════════════════════════════
-- Helpers internos: NO ejecutables por frontend
SELECT pg_temp.assert(NOT has_function_privilege('authenticated','public.assert_period_open(uuid,date)','EXECUTE'), 'GR1 authenticated NO EXECUTE assert_period_open (interno)');
SELECT pg_temp.assert(NOT has_function_privilege('authenticated','public.is_period_closed(uuid,date)','EXECUTE'), 'GR2 authenticated NO EXECUTE is_period_closed (interno)');
SELECT pg_temp.assert(NOT has_function_privilege('authenticated','public.finance_period_bounds(date)','EXECUTE'), 'GR3 authenticated NO EXECUTE finance_period_bounds');
SELECT pg_temp.assert(NOT has_function_privilege('authenticated','public.finance_period_lock_key(uuid,date)','EXECUTE'), 'GR4 authenticated NO EXECUTE finance_period_lock_key');
SELECT pg_temp.assert(NOT has_function_privilege('authenticated','public.finance_log_audit(uuid,text,text,uuid,text,text,text,date,text,uuid,jsonb,jsonb,uuid)','EXECUTE'), 'GR5 authenticated NO EXECUTE finance_log_audit');
SELECT pg_temp.assert(NOT has_function_privilege('anon','public.finance_log_audit(uuid,text,text,uuid,text,text,text,date,text,uuid,jsonb,jsonb,uuid)','EXECUTE'), 'GR6 anon NO EXECUTE finance_log_audit');
-- RPC públicas: sí ejecutables por authenticated (hacen sus propios checks)
SELECT pg_temp.assert(has_function_privilege('authenticated','public.close_period(uuid,date,text)','EXECUTE'), 'GR7 authenticated EXECUTE close_period');
SELECT pg_temp.assert(has_function_privilege('authenticated','public.reopen_period(uuid,date,text)','EXECUTE'), 'GR8 authenticated EXECUTE reopen_period');
SELECT pg_temp.assert(has_function_privilege('authenticated','public.reconcile_ledger_record(uuid,text,uuid,text,text,text,jsonb)','EXECUTE'), 'GR9 authenticated EXECUTE reconcile_ledger_record');
SELECT pg_temp.assert(has_function_privilege('authenticated','public.finance_pending_historicals(uuid)','EXECUTE'), 'GR10 authenticated EXECUTE finance_pending_historicals');
SELECT pg_temp.assert(NOT has_function_privilege('anon','public.close_period(uuid,date,text)','EXECUTE'), 'GR11 anon NO EXECUTE close_period');
-- Tabla de auditoría: append-only incluso para service_role
SELECT pg_temp.assert(has_table_privilege('authenticated','public.finance_audit_log','SELECT'), 'GR12 authenticated SELECT audit_log');
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.finance_audit_log','INSERT'), 'GR13 authenticated NO INSERT audit_log');
SELECT pg_temp.assert(NOT has_table_privilege('service_role','public.finance_audit_log','UPDATE'), 'GR14 service_role NO UPDATE audit_log');
SELECT pg_temp.assert(NOT has_table_privilege('service_role','public.finance_audit_log','DELETE'), 'GR15 service_role NO DELETE audit_log');
SELECT pg_temp.assert(has_table_privilege('service_role','public.finance_audit_log','INSERT'), 'GR16 service_role INSERT audit_log (backstop/helper)');
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.finance_period_locks','INSERT'), 'GR17 authenticated NO INSERT directo period_locks');
SELECT pg_temp.assert(has_table_privilege('authenticated','public.finance_period_locks','SELECT'), 'GR18 authenticated SELECT period_locks (UI)');

ROLLBACK;
