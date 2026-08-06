-- ============================================================================
-- M8 - motor determinista de insights financieros.
--
-- Ejecuta con roles REALES (authenticated / anon) y claims JWT de tres sujetos
-- sobre DOS negocios. Un test que solo lee information_schema prueba que alguien
-- escribio un GRANT, no que el aislamiento funcione.
--
-- -a- PATRON OBLIGATORIO (bug de postgres:17.6.1.104, el mismo build que prod):
--    entrar a una SECURITY DEFINER con el rol cambiado DENTRO de un bloque DO
--    crashea el backend (signal 11) y tumba todas las conexiones. Por eso:
--      · el cambio de rol y la llamada a la funcion van SIEMPRE a nivel psql,
--        nunca dentro de un DO;
--      · el resultado se guarda en una temp table y se asevera despues, ya con
--        RESET ROLE hecho;
--      · el rechazo a `anon` sobre FUNCIONES se prueba con has_function_privilege
--        (que ademas es la fuente de verdad correcta), nunca invocandolas.
--    Sobre TABLAS si se puede invocar de verdad: ahi el rechazo es un 42501 limpio.
--
-- Cubre los 15 casos obligatorios del lote + el contrato de la tabla.
--
-- RUN: supabase db reset
--      docker cp supabase/tests/m8_finance_insights_test.sql <db>:/tmp/m8.sql
--      docker exec <db> psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -f /tmp/m8.sql
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set bizA  '00000000-0000-0000-0000-0000000a8001'
\set ownA  '00000000-0000-0000-0000-0000000a8009'
\set bizB  '00000000-0000-0000-0000-0000000b8001'
\set ownB  '00000000-0000-0000-0000-0000000b8009'
\set nomem '00000000-0000-0000-0000-0000000c8009'
\set supA  '00000000-0000-0000-0000-0000000a8031'
\set supB  '00000000-0000-0000-0000-0000000b8031'
\set custA '00000000-0000-0000-0000-0000000a8021'

CREATE TEMP TABLE m8_out(tag text primary key, j jsonb);
GRANT ALL ON m8_out TO PUBLIC;

-- -"-"- 0. La migracion no escribio nada -"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM finance_insights;
  PERFORM pg_temp.assert(n = 0, 'T29 cero DML historico: finance_insights arranca vacia ('||n||' filas)');
  SELECT count(*) INTO n FROM supplier_purchases WHERE due_date IS NOT NULL;
  PERFORM pg_temp.assert(n = 0, 'T11 ningun historico recibio due_date ('||n||' filas)');
END $$;

-- -"-"- 1. Contrato de tabla y constraints -"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-
DO $$
BEGIN
  PERFORM pg_temp.assert(
    (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='public.finance_insights'::regclass),
    'T01 finance_insights con RLS activa y forzada');

  PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='finance_insights_fingerprint_uidx'),
    'T17 existe el unique de fingerprint');

  -- rule_id fuera del catalogo cerrado: no entra (bloquea la "regla 11").
  BEGIN
    INSERT INTO finance_insights(business_id,rule_id,rule_version,period_start,period_end,
      severity,title,message,evidence,action,fingerprint)
    VALUES ('00000000-0000-0000-0000-000000000001','regla_inventada','v1',
            '2026-08-01','2026-08-31','warning','x','y','{}'::jsonb,'{}'::jsonb,'fp');
    PERFORM pg_temp.assert(false, 'T23b una regla fuera del catalogo NO deberia insertarse');
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    PERFORM pg_temp.assert(true, 'T23b rule_id fuera del catalogo rechazado');
  END;

  -- evidence incompleto tampoco entra.
  BEGIN
    INSERT INTO finance_insights(business_id,rule_id,rule_version,period_start,period_end,
      severity,title,message,evidence,action,fingerprint)
    VALUES ('00000000-0000-0000-0000-000000000001','dead_stock','v1',
            '2026-08-01','2026-08-31','warning','x','y','{"metric":"x"}'::jsonb,
            '{"label":"a","target_type":"none","target":""}'::jsonb,'fp2');
    PERFORM pg_temp.assert(false, 'T14 evidence incompleto NO deberia insertarse');
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    PERFORM pg_temp.assert(true, 'T14 evidence obligatorio: incompleto rechazado');
  END;

  -- action con ruta inexistente tampoco.
  BEGIN
    INSERT INTO finance_insights(business_id,rule_id,rule_version,period_start,period_end,
      severity,title,message,evidence,action,fingerprint)
    VALUES ('00000000-0000-0000-0000-000000000001','dead_stock','v1',
            '2026-08-01','2026-08-31','warning','x','y',
            '{"metric":"m","threshold":{},"source":"s","calculation_version":"v1","currency":"ARS","period_start":"2026-08-01","period_end":"2026-08-31"}'::jsonb,
            '{"label":"a","target_type":"route","target":"/finance/charts/waterfall"}'::jsonb,'fp3');
    PERFORM pg_temp.assert(false, 'T15 ruta inexistente NO deberia insertarse');
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    PERFORM pg_temp.assert(true, 'T15 action valida: ruta inexistente rechazada');
  END;
END $$;

-- -"-"- 2. Permisos (por catalogo - NUNCA invocando SECDEF con rol cambiado) -"-"-"-"-
DO $$
DECLARE s_tbl text := 'sin-error';
BEGIN
  -- Sobre TABLA si se invoca de verdad: el rechazo es un 42501 limpio.
  BEGIN SET LOCAL ROLE anon; PERFORM 1 FROM finance_insights;
  EXCEPTION WHEN OTHERS THEN s_tbl := SQLSTATE; END; RESET ROLE;
  PERFORM pg_temp.assert(s_tbl = '42501', 'T03 anon NO puede leer finance_insights (got '||s_tbl||')');

  PERFORM pg_temp.assert(
    NOT has_function_privilege('anon','public.generate_finance_insights(uuid,date,date)','EXECUTE'),
    'T03b anon sin EXECUTE sobre generate_finance_insights');
  PERFORM pg_temp.assert(
    NOT has_function_privilege('anon','public.finance_insights_read(uuid,date,date,text,integer)','EXECUTE'),
    'T03c anon sin EXECUTE sobre finance_insights_read');
  PERFORM pg_temp.assert(
    NOT has_function_privilege('anon','public.finance_insight_thresholds()','EXECUTE'),
    'T03d anon sin EXECUTE sobre finance_insight_thresholds');

  PERFORM pg_temp.assert(NOT has_table_privilege('anon','public.finance_insights','SELECT')
                     AND NOT has_table_privilege('anon','public.finance_insights','INSERT')
                     AND NOT has_table_privilege('anon','public.finance_insights','UPDATE')
                     AND NOT has_table_privilege('anon','public.finance_insights','DELETE')
                     AND NOT has_table_privilege('anon','public.finance_insights','TRUNCATE'),
    'T03e anon a cero en la tabla');

  PERFORM pg_temp.assert(NOT has_table_privilege('authenticated','public.finance_insights','INSERT')
                     AND NOT has_table_privilege('authenticated','public.finance_insights','UPDATE')
                     AND NOT has_table_privilege('authenticated','public.finance_insights','DELETE')
                     AND NOT has_table_privilege('authenticated','public.finance_insights','TRUNCATE'),
    'T09 authenticated no puede escribir contenido calculado');
  PERFORM pg_temp.assert(has_table_privilege('authenticated','public.finance_insights','SELECT'),
    'T09b authenticated si puede leer');

  PERFORM pg_temp.assert(
    NOT has_function_privilege('public','public.generate_finance_insights(uuid,date,date)','EXECUTE'),
    'T28 PUBLIC revocado sobre generate_finance_insights');

  PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM pg_proc
    WHERE oid='public.generate_finance_insights(uuid,date,date)'::regprocedure
      AND proconfig @> ARRAY['search_path=pg_catalog, pg_temp']),
    'T27 search_path endurecido con pg_temp AL FINAL');

  PERFORM pg_temp.assert(NOT (SELECT prosecdef FROM pg_proc
    WHERE oid='public.finance_insights_read(uuid,date,date,text,integer)'::regprocedure),
    'T26 la funcion de lectura NO es SECURITY DEFINER (no lo necesita)');

  PERFORM pg_temp.assert(
    (SELECT c.reloptions @> ARRAY['security_invoker=true'] FROM pg_class c
      WHERE c.oid='public.v_finance_payables_due'::regclass),
    'T26b v_finance_payables_due es security_invoker');
END $$;

-- -"-"- 3. Fixtures -"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-
SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'ownA'),(:'ownB'),(:'nomem');
INSERT INTO businesses(id,name,owner_user_id,subscription_status,subscription_plan)
  VALUES (:'bizA','M8 A',:'ownA','active','pro'),(:'bizB','M8 B',:'ownB','active','pro');
INSERT INTO profiles(id,business_id,user_id,role,is_active) VALUES
  (:'ownA',:'bizA',:'ownA','owner',true),
  (:'ownB',:'bizB',:'ownB','owner',true);
INSERT INTO suppliers(id,business_id,name) VALUES (:'supA',:'bizA','Proveedor A'),(:'supB',:'bizB','Prov B');
INSERT INTO customers(id,business_id,name,phone) VALUES (:'custA',:'bizA','Cliente A','3510000001');
SET LOCAL session_replication_role='origin';

-- -"-"- 4. due_date - contrato de la columna -"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-
DO $$
DECLARE v_ok boolean;
BEGIN
  BEGIN
    INSERT INTO supplier_purchases(business_id,supplier_id,purchase_date,due_date,
      total_amount,paid_amount,pending_amount,payment_status)
    VALUES ('00000000-0000-0000-0000-0000000a8001','00000000-0000-0000-0000-0000000a8031',
            '2026-08-01','2026-07-01',1000,0,1000,'pending');
    PERFORM pg_temp.assert(false, 'T06 due_date < purchase_date NO deberia aceptarse');
  EXCEPTION WHEN check_violation THEN
    PERFORM pg_temp.assert(true, 'T06 due_date anterior a purchase_date rechazado');
  END;

  BEGIN
    INSERT INTO supplier_purchases(id,business_id,supplier_id,purchase_date,due_date,
      total_amount,paid_amount,pending_amount,payment_status)
    VALUES ('00000000-0000-0000-0000-0000000a80f0','00000000-0000-0000-0000-0000000a8001',
            '00000000-0000-0000-0000-0000000a8031','2026-08-01','2026-08-01',1,0,1,'pending');
    v_ok := true;
  EXCEPTION WHEN OTHERS THEN v_ok := false;
  END;
  PERFORM pg_temp.assert(v_ok, 'T06b due_date = purchase_date aceptado (pago contra entrega)');
  DELETE FROM supplier_purchases WHERE id='00000000-0000-0000-0000-0000000a80f0';
END $$;

-- Compras A: vencida / dentro de 14d / a 15d / pagada / SIN fecha.
INSERT INTO supplier_purchases(business_id,supplier_id,purchase_date,due_date,
  total_amount,paid_amount,pending_amount,payment_status) VALUES
  (:'bizA',:'supA', public.ar_today()-60, public.ar_today()-10, 200000,0,200000,'pending'),
  (:'bizA',:'supA', public.ar_today()-5,  public.ar_today()+7,  150000,0,150000,'pending'),
  (:'bizA',:'supA', public.ar_today()-5,  public.ar_today()+15, 900000,0,900000,'pending'),
  (:'bizA',:'supA', public.ar_today()-30, public.ar_today()-3,  500000,500000,0,'paid'),
  (:'bizA',:'supA', public.ar_today()-40, NULL,                 700000,0,700000,'pending');
-- Negocio B: SOLO deuda sin fecha acordada.
INSERT INTO supplier_purchases(business_id,supplier_id,purchase_date,due_date,
  total_amount,paid_amount,pending_amount,payment_status) VALUES
  (:'bizB',:'supB', public.ar_today()-40, NULL, 900000,0,900000,'pending');

DO $$
DECLARE v_over numeric; v_soon numeric; v_fut numeric; v_und numeric; v_paid int;
BEGIN
  SELECT COALESCE(SUM(pending_amount) FILTER (WHERE due_status='overdue'),0),
         COALESCE(SUM(pending_amount) FILTER (WHERE due_status='due_soon'),0),
         COALESCE(SUM(pending_amount) FILTER (WHERE due_status='future'),0),
         COALESCE(SUM(pending_amount) FILTER (WHERE due_status='undated'),0)
    INTO v_over, v_soon, v_fut, v_und
    FROM v_finance_payables_due WHERE business_id='00000000-0000-0000-0000-0000000a8001';

  PERFORM pg_temp.assert(v_over = 200000, 'T02 compra vencida entra como overdue ('||v_over||')');
  PERFORM pg_temp.assert(v_soon = 150000, 'T03f compra dentro de 14 dias entra como due_soon ('||v_soon||')');
  PERFORM pg_temp.assert(v_fut  = 900000, 'T04 compra a 15 dias NO entra al horizonte (queda future)');
  PERFORM pg_temp.assert(v_und  = 700000, 'T01b compra sin due_date queda undated ('||v_und||')');

  SELECT count(*) INTO v_paid FROM v_finance_payables_due
   WHERE business_id='00000000-0000-0000-0000-0000000a8001' AND payment_status='paid';
  PERFORM pg_temp.assert(v_paid = 0, 'T05 compra pagada no entra en la vista de vencimientos');
END $$;

-- -"-"- 5. Generacion - el rol se cambia a NIVEL PSQL, jamas dentro de un DO -"-"-"-"-
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a8009';

INSERT INTO m8_out VALUES ('inverted',
  public.generate_finance_insights('00000000-0000-0000-0000-0000000a8001','2026-08-31','2026-08-01'));
INSERT INTO m8_out VALUES ('too_long',
  public.generate_finance_insights('00000000-0000-0000-0000-0000000a8001','2020-01-01','2026-08-31'));
INSERT INTO m8_out VALUES ('cross_tenant',
  public.generate_finance_insights('00000000-0000-0000-0000-0000000b8001','2026-08-01','2026-08-31'));
INSERT INTO m8_out VALUES ('genA1',
  public.generate_finance_insights('00000000-0000-0000-0000-0000000a8001',
    date_trunc('month', public.ar_today())::date, public.ar_today()));

RESET ROLE;

DO $$
DECLARE j jsonb;
BEGIN
  SELECT m8_out.j INTO j FROM m8_out WHERE tag='inverted';
  PERFORM pg_temp.assert((j->>'ok')='false', 'T08 periodo invertido rechazado');

  SELECT m8_out.j INTO j FROM m8_out WHERE tag='too_long';
  PERFORM pg_temp.assert((j->>'ok')='false', 'T08b periodo demasiado largo rechazado');

  SELECT m8_out.j INTO j FROM m8_out WHERE tag='cross_tenant';
  PERFORM pg_temp.assert((j->>'ok')='false' AND (j->>'error') ILIKE '%acceso%',
    'T04b cross-tenant bloqueado: owner A no genera para negocio B');

  SELECT m8_out.j INTO j FROM m8_out WHERE tag='genA1';
  PERFORM pg_temp.assert((j->>'ok')='true', 'T05b owner legitimo puede generar');
END $$;

-- -"-"- 6. supplier_crunch -"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-
DO $$
DECLARE ev jsonb; n int;
BEGIN
  SELECT evidence INTO ev FROM finance_insights
   WHERE business_id='00000000-0000-0000-0000-0000000a8001' AND rule_id='supplier_crunch'
     AND status='active';

  PERFORM pg_temp.assert(ev IS NOT NULL, 'T08c supplier_crunch dispara con compromisos > liquidez');
  PERFORM pg_temp.assert((ev->>'overdue_amount')::numeric = 200000,
    'T02b evidence.overdue_amount = 200000 (got '||COALESCE(ev->>'overdue_amount','null')||')');
  PERFORM pg_temp.assert((ev->>'due_next_14_days')::numeric = 150000,
    'T03g evidence.due_next_14_days = 150000');
  PERFORM pg_temp.assert((ev->>'total_near_term_commitments')::numeric = 350000,
    'T04c la compra a 15 dias queda FUERA del total near-term');
  PERFORM pg_temp.assert((ev->>'undated_pending_amount')::numeric = 700000,
    'T10 undated_pending_amount es contexto (700000), NO se suma al compromiso');
  PERFORM pg_temp.assert((ev->>'dated_purchase_count')::bigint = 3,
    'T10b dated_purchase_count cuenta solo compras con fecha');
  PERFORM pg_temp.assert((ev->>'horizon_days')::int = 14, 'T07c horizon_days = 14');
  PERFORM pg_temp.assert((ev->>'source') = 'v_finance_payables_due', 'T07d source correcto');

  SELECT count(*) INTO n FROM finance_insights
   WHERE business_id='00000000-0000-0000-0000-0000000a8001' AND rule_id='supplier_crunch'
     AND severity='critical' AND status='active';
  PERFORM pg_temp.assert(n = 1, 'T08d deuda superior a liquidez dispara critical');
END $$;

-- T07: negocio B, deuda SIN fecha => skipped, nunca "todo sano"
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000b8009';
INSERT INTO m8_out VALUES ('genB',
  public.generate_finance_insights('00000000-0000-0000-0000-0000000b8001',
    date_trunc('month', public.ar_today())::date, public.ar_today()));
RESET ROLE;

DO $$
DECLARE j jsonb; n int;
BEGIN
  SELECT m8_out.j INTO j FROM m8_out WHERE tag='genB';
  PERFORM pg_temp.assert(
    EXISTS (SELECT 1 FROM jsonb_array_elements(j->'skipped') s
             WHERE s->>'rule_id'='supplier_crunch' AND s->>'reason'='insufficient_due_dates'),
    'T07 sin due_dates => reason_skipped = insufficient_due_dates');

  SELECT count(*) INTO n FROM finance_insights
   WHERE business_id='00000000-0000-0000-0000-0000000b8001' AND rule_id='supplier_crunch' AND status='active';
  PERFORM pg_temp.assert(n = 0, 'T07b sin due_dates NO se crea insight visible');
END $$;

-- -"-"- 7. data_quality / fixed_coverage / breakeven -"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-
DO $$
DECLARE j jsonb; n int;
BEGIN
  SELECT m8_out.j INTO j FROM m8_out WHERE tag='genA1';

  SELECT count(*) INTO n FROM finance_insights
   WHERE business_id='00000000-0000-0000-0000-0000000a8001' AND rule_id='data_quality'
     AND severity='critical' AND status='active';
  PERFORM pg_temp.assert(n = 0,
    'T14b/T19 data_quality NO dispara critical con critical_count=0');
  PERFORM pg_temp.assert(
    EXISTS (SELECT 1 FROM jsonb_array_elements(j->'skipped') s WHERE s->>'rule_id'='data_quality'),
    'T22 warnings legacy no se vuelven critical: la regla queda skipped');

  PERFORM pg_temp.assert(
    EXISTS (SELECT 1 FROM jsonb_array_elements(j->'skipped') s
             WHERE s->>'rule_id'='fixed_coverage' AND s->>'reason'='no_recurring_expenses'),
    'T13a fixed_coverage se omite sin recurring_expenses');
  PERFORM pg_temp.assert(
    EXISTS (SELECT 1 FROM jsonb_array_elements(j->'skipped') s
             WHERE s->>'rule_id'='breakeven_day' AND s->>'reason'='no_recurring_expenses'),
    'T13b breakeven_day se omite sin recurring_expenses');
END $$;

-- -"-"- 8. Idempotencia y ciclo de vida -"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a8009';
INSERT INTO m8_out VALUES ('genA2',
  public.generate_finance_insights('00000000-0000-0000-0000-0000000a8001',
    date_trunc('month', public.ar_today())::date, public.ar_today()));
INSERT INTO m8_out VALUES ('genA3',
  public.generate_finance_insights('00000000-0000-0000-0000-0000000a8001',
    date_trunc('month', public.ar_today())::date, public.ar_today()));
RESET ROLE;

DO $$
DECLARE n int; fps int;
BEGIN
  SELECT count(*) INTO n FROM finance_insights WHERE business_id='00000000-0000-0000-0000-0000000a8001';
  SELECT count(DISTINCT fingerprint) INTO fps FROM finance_insights
   WHERE business_id='00000000-0000-0000-0000-0000000a8001';
  PERFORM pg_temp.assert(n = fps, 'T06c/T18 generacion idempotente: sin duplicados ('||n||' filas, '||fps||' fingerprints)');

  SELECT count(*) INTO n FROM finance_insights
   WHERE business_id='00000000-0000-0000-0000-0000000a8001' AND rule_id='supplier_crunch' AND status='active';
  PERFORM pg_temp.assert(n = 1, 'T16 maximo una fila activa por regla/periodo');
END $$;

-- T12/T13: deja de cumplirse -> resolved; vuelve -> active
UPDATE supplier_purchases SET pending_amount = 0, paid_amount = total_amount, payment_status='paid'
 WHERE business_id = '00000000-0000-0000-0000-0000000a8001';

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a8009';
INSERT INTO m8_out VALUES ('genA4',
  public.generate_finance_insights('00000000-0000-0000-0000-0000000a8001',
    date_trunc('month', public.ar_today())::date, public.ar_today()));
RESET ROLE;

DO $$
DECLARE st text; ra timestamptz;
BEGIN
  SELECT status, resolved_at INTO st, ra FROM finance_insights
   WHERE business_id='00000000-0000-0000-0000-0000000a8001' AND rule_id='supplier_crunch';
  PERFORM pg_temp.assert(st = 'resolved', 'T12 regla que deja de cumplirse pasa a resolved (got '||COALESCE(st,'null')||')');
  PERFORM pg_temp.assert(ra IS NOT NULL, 'T12b resolved_at se completa al resolver');
END $$;

UPDATE supplier_purchases SET pending_amount = 200000, paid_amount = 0, payment_status='pending'
 WHERE business_id='00000000-0000-0000-0000-0000000a8001' AND due_date < public.ar_today();

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a8009';
INSERT INTO m8_out VALUES ('genA5',
  public.generate_finance_insights('00000000-0000-0000-0000-0000000a8001',
    date_trunc('month', public.ar_today())::date, public.ar_today()));
RESET ROLE;

DO $$
DECLARE st text; ra timestamptz;
BEGIN
  SELECT status, resolved_at INTO st, ra FROM finance_insights
   WHERE business_id='00000000-0000-0000-0000-0000000a8001' AND rule_id='supplier_crunch';
  PERFORM pg_temp.assert(st = 'active', 'T13c regla que vuelve a cumplirse revive a active');
  PERFORM pg_temp.assert(ra IS NULL, 'T13d resolved_at se limpia al revivir');
END $$;

-- -"-"- 9. Evidence / action / privacidad -"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM finance_insights
   WHERE NOT (evidence ? 'metric' AND evidence ? 'threshold' AND evidence ? 'source'
              AND evidence ? 'calculation_version' AND evidence ? 'currency');
  PERFORM pg_temp.assert(bad = 0, 'T14c todo insight generado tiene evidence completo');

  SELECT count(*) INTO bad FROM finance_insights
   WHERE action->>'target_type' = 'route'
     AND action->>'target' NOT IN ('/finance','/finance/reports','/finance/health','/finance/dashboard',
       '/inventory','/suppliers','/cuentas','/caja','/expenses','/comprobantes','/customers','/currency-settings');
  PERFORM pg_temp.assert(bad = 0, 'T15b ninguna accion generada apunta a ruta inexistente');

  -- T25: nada de PII ni de otro negocio dentro de evidence.
  SELECT count(*) INTO bad FROM finance_insights
   WHERE evidence::text ILIKE '%Cliente A%' OR evidence::text ILIKE '%Proveedor A%'
      OR evidence::text ILIKE '%3510000001%' OR evidence::text ILIKE '%0b8001%';
  PERFORM pg_temp.assert(bad = 0, 'T25 evidence sin PII ni datos cross-business');

  -- Todo importe es numerico, nunca texto formateado.
  SELECT count(*) INTO bad FROM finance_insights
   WHERE jsonb_typeof(evidence->'threshold') <> 'object';
  PERFORM pg_temp.assert(bad = 0, 'T14d threshold siempre presente como objeto');
END $$;

-- -"-"- 10. Lectura y aislamiento -"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a8009';
INSERT INTO m8_out VALUES ('readA',
  public.finance_insights_read('00000000-0000-0000-0000-0000000a8001',
    date_trunc('month', public.ar_today())::date, public.ar_today(), 'active', 3));
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000b8009';
INSERT INTO m8_out VALUES ('readB_of_A',
  public.finance_insights_read('00000000-0000-0000-0000-0000000a8001',
    date_trunc('month', public.ar_today())::date, public.ar_today(), 'active', 10));
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c8009';
INSERT INTO m8_out VALUES ('genNoMem',
  public.generate_finance_insights('00000000-0000-0000-0000-0000000a8001',
    date_trunc('month', public.ar_today())::date, public.ar_today()));
RESET ROLE;

DO $$
DECLARE j jsonb;
BEGIN
  SELECT m8_out.j INTO j FROM m8_out WHERE tag='readA';
  PERFORM pg_temp.assert((j->>'ok')='true', 'T08e lectura responde ok');
  PERFORM pg_temp.assert(jsonb_array_length(j->'insights') <= 3, 'T08f la lectura respeta el maximo');

  SELECT m8_out.j INTO j FROM m8_out WHERE tag='readB_of_A';
  PERFORM pg_temp.assert(jsonb_array_length(COALESCE(j->'insights','[]'::jsonb)) = 0,
    'T04d owner B no lee insights del negocio A (RLS)');

  SELECT m8_out.j INTO j FROM m8_out WHERE tag='genNoMem';
  PERFORM pg_temp.assert((j->>'ok')='false', 'T05c usuario sin membresia no puede generar');
END $$;

-- -"-"- 11. Textos -"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM finance_insights
   WHERE rule_id='cc_aging' AND (message ILIKE '%vencid%' OR title ILIKE '%vencid%');
  PERFORM pg_temp.assert(bad = 0, 'T12c cc_aging nunca usa la palabra "vencido"');

  SELECT count(*) INTO bad FROM finance_insights
   WHERE rule_id='breakeven_day' AND message NOT ILIKE '%stimaci%';
  PERFORM pg_temp.assert(bad = 0, 'T06e breakeven_day siempre rotulado como estimacion');

  SELECT count(*) INTO bad FROM finance_insights WHERE message ILIKE '%NaN%' OR message ILIKE '%undefined%';
  PERFORM pg_temp.assert(bad = 0, 'T20 ningun mensaje contiene NaN ni undefined');
END $$;

-- -"-"- 12. Cero mutacion de datos financieros -"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-"-
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM comprobantes;
  PERFORM pg_temp.assert(n = 0, 'T29b el motor no creo comprobantes');
  SELECT count(*) INTO n FROM financial_movements;
  PERFORM pg_temp.assert(n = 0, 'T29c el motor no creo movimientos financieros');
  SELECT count(*) INTO n FROM business_finance_entries;
  PERFORM pg_temp.assert(n = 0, 'T29d el motor no creo asientos contables');
END $$;

DO $$ BEGIN RAISE NOTICE '-"-"-"-"-"-"-"-"- M8 SUITE COMPLETA -"-"-"-"-"-"-"-"-'; END $$;

ROLLBACK;
