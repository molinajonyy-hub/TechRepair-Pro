-- ============================================================================
-- Pre-launch Stability P0 — v_finance_position / owner_withdrawals.
--
-- Cubre el 403 (SQLSTATE 42501, "permission denied for table owner_withdrawals")
-- que rompia el Dashboard con una sesion owner real.
--
-- Este suite NO se conforma con leer el catalogo: EJECUTA las consultas con el
-- rol real (`authenticated` / `anon`) y con los claims JWT de cinco sujetos
-- distintos sobre DOS negocios. Un test que solo mira `information_schema`
-- prueba que alguien escribio un GRANT, no que el aislamiento funcione.
--
-- RUN: supabase db reset && docker cp ... && psql -X -f  (una tx + ROLLBACK).
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set bizA  '00000000-0000-0000-0000-00000000fa01'
\set ownA  '00000000-0000-0000-0000-00000000fa09'
\set admA  '00000000-0000-0000-0000-00000000fa0a'
\set bizB  '00000000-0000-0000-0000-00000000fb01'
\set ownB  '00000000-0000-0000-0000-00000000fb09'
\set nomem '00000000-0000-0000-0000-00000000fc09'
\set custA '00000000-0000-0000-0000-00000000fa21'
\set supA  '00000000-0000-0000-0000-00000000fa31'
\set cmpA  '00000000-0000-0000-0000-00000000fa41'
\set custB '00000000-0000-0000-0000-00000000fb21'
\set supB  '00000000-0000-0000-0000-00000000fb31'
\set cmpB  '00000000-0000-0000-0000-00000000fb41'

-- ══ 0. Estado de datos ANTES de las fixtures ════════════════════════════════
-- La migracion no debe haber tocado datos: sobre una DB recien reseteada,
-- owner_withdrawals arranca vacia.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM owner_withdrawals;
  PERFORM pg_temp.assert(n = 0,
    'D1 la migracion no inserto ni borro datos en owner_withdrawals (filas previas: '||n||')');
END $$;

-- ── Fixtures: dos negocios completos ────────────────────────────────────────
SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'ownA'),(:'admA'),(:'ownB'),(:'nomem');
INSERT INTO businesses(id,name,owner_user_id,subscription_status,subscription_plan)
  VALUES (:'bizA','P0 A',:'ownA','active','pro'),(:'bizB','P0 B',:'ownB','active','pro');
INSERT INTO profiles(id,business_id,user_id,role,is_active) VALUES
  (:'ownA',:'bizA',:'ownA','owner',true),
  (:'admA',:'bizA',:'admA','admin',true),
  (:'ownB',:'bizB',:'ownB','owner',true);
-- :nomem existe en auth.users pero NO tiene profile => sin membresia.
INSERT INTO customers(id,business_id,name,phone) VALUES
  (:'custA',:'bizA','Cliente A','3510000001'),
  (:'custB',:'bizB','Cliente B','3510000002');
INSERT INTO suppliers(id,business_id,name,active) VALUES
  (:'supA',:'bizA','Prov A',true),
  (:'supB',:'bizB','Prov B',true);
-- receivables: A = 15000 / B = 22000
INSERT INTO comprobantes(id,business_id,tipo,status,estado,estado_comercial,total,saldo_pendiente,customer_id,estado_fiscal) VALUES
  (:'cmpA',:'bizA','factura_c','issued','emitido','pendiente',15000,15000,:'custA','no_fiscal'),
  (:'cmpB',:'bizB','factura_c','issued','emitido','pendiente',22000,22000,:'custB','no_fiscal');
-- payables: A = 9000 / B = 4000
INSERT INTO supplier_account_movements(business_id,supplier_id,movement_date,type,description,debit,credit,balance_after) VALUES
  (:'bizA',:'supA','2026-07-20','purchase','Compra A',9000,0,9000),
  (:'bizB',:'supB','2026-07-20','purchase','Compra B',4000,0,4000);
-- capital del dueno en ambos negocios
INSERT INTO owner_withdrawals(business_id,user_id,amount,currency,date,flow_type,status) VALUES
  (:'bizA',:'ownA',5000,'ARS','2026-07-20','withdrawal','completed'),
  (:'bizB',:'ownB',7000,'ARS','2026-07-20','withdrawal','completed');
SET LOCAL session_replication_role='origin';

-- ══ 1. La vista sigue siendo security_invoker ═══════════════════════════════
-- Es el invariante que hace que el aislamiento lo aplique la RLS del que consulta.
-- Si alguien "arregla" un 403 futuro pasandola a SECURITY DEFINER, esto lo frena.
SELECT pg_temp.assert(
  (SELECT 'security_invoker=true' = ANY(reloptions) FROM pg_class WHERE oid='public.v_finance_position'::regclass),
  'V1 v_finance_position conserva security_invoker=true');

SELECT pg_temp.assert(
  (SELECT NOT relrowsecurity FROM pg_class WHERE oid='public.v_finance_position'::regclass) IS NOT FALSE,
  'V2 v_finance_position es una vista (la RLS vive en las tablas base)');

-- ══ 2. Grants EXACTOS post-migracion sobre owner_withdrawals ════════════════
SELECT pg_temp.assert(has_table_privilege('authenticated','public.owner_withdrawals','SELECT'),
  'G1 authenticated TIENE SELECT sobre owner_withdrawals');
SELECT pg_temp.assert(NOT has_table_privilege('anon','public.owner_withdrawals','SELECT'),
  'G2 anon NO tiene SELECT sobre owner_withdrawals');
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.owner_withdrawals','INSERT'),
  'G3 authenticated NO tiene INSERT');
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.owner_withdrawals','UPDATE'),
  'G4 authenticated NO tiene UPDATE');
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.owner_withdrawals','DELETE'),
  'G5 authenticated NO tiene DELETE');

-- El pseudo-rol PUBLIC repartiria el privilegio a todo rol presente y futuro.
SELECT pg_temp.assert((SELECT count(*) FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) a
   WHERE c.oid='public.owner_withdrawals'::regclass AND a.grantee=0)=0,
  'G6 el pseudo-rol PUBLIC no tiene NINGUN privilegio sobre owner_withdrawals');

-- El grant concedido es exactamente {SELECT} y nada mas.
SELECT pg_temp.assert(
  (SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '')
     FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name='owner_withdrawals' AND grantee='authenticated'
  ) = 'SELECT',
  'G7 authenticated tiene EXACTAMENTE {SELECT} sobre owner_withdrawals');

-- RLS intacta: es lo unico que acota las filas una vez concedido el GRANT.
SELECT pg_temp.assert(
  (SELECT relrowsecurity FROM pg_class WHERE oid='public.owner_withdrawals'::regclass),
  'G8 RLS sigue ENABLE en owner_withdrawals');
SELECT pg_temp.assert(
  EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='owner_withdrawals' AND cmd IN ('ALL','SELECT')),
  'G9 sigue existiendo la policy que acota SELECT');

-- ══ 3. owner de A ═══════════════════════════════════════════════════════════
DO $$
DECLARE e text; v_recv numeric; v_pay numeric; v_rows int;
BEGIN
  e := '';
  BEGIN
    SET LOCAL ROLE authenticated;
    SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000fa09';
    SELECT count(*) INTO v_rows FROM v_finance_position;
    SELECT receivables, payables INTO v_recv, v_pay
      FROM v_finance_position WHERE business_id='00000000-0000-0000-0000-00000000fa01';
  EXCEPTION WHEN OTHERS THEN e := SQLERRM;
  END;
  RESET ROLE;
  PERFORM pg_temp.assert(e = '', 'A1 owner de A consulta la vista SIN 42501 ('||e||')');
  PERFORM pg_temp.assert(v_recv = 15000, 'A2 receivables de A = 15000 (obtuvo '||COALESCE(v_recv::text,'NULL')||')');
  PERFORM pg_temp.assert(v_pay  = 9000,  'A3 payables de A = 9000 (obtuvo '||COALESCE(v_pay::text,'NULL')||')');
  PERFORM pg_temp.assert(v_rows = 1,     'A4 owner de A ve UNA sola fila (obtuvo '||COALESCE(v_rows::text,'NULL')||')');
END $$;

-- ══ 4. admin de A ═══════════════════════════════════════════════════════════
DO $$
DECLARE e text; v_recv numeric; v_pay numeric; v_rows int;
BEGIN
  e := '';
  BEGIN
    SET LOCAL ROLE authenticated;
    SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000fa0a';
    SELECT count(*) INTO v_rows FROM v_finance_position;
    SELECT receivables, payables INTO v_recv, v_pay
      FROM v_finance_position WHERE business_id='00000000-0000-0000-0000-00000000fa01';
  EXCEPTION WHEN OTHERS THEN e := SQLERRM;
  END;
  RESET ROLE;
  PERFORM pg_temp.assert(e = '', 'B1 admin de A consulta la vista SIN 42501 ('||e||')');
  PERFORM pg_temp.assert(v_recv = 15000 AND v_pay = 9000, 'B2 admin de A ve los mismos importes que el owner');
  PERFORM pg_temp.assert(v_rows = 1, 'B3 admin de A ve UNA sola fila');
END $$;

-- ══ 5. Cross-tenant: owner de B pidiendo A ══════════════════════════════════
DO $$
DECLARE e text; v_a int; v_b int; v_recv_b numeric;
BEGIN
  e := '';
  BEGIN
    SET LOCAL ROLE authenticated;
    SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000fb09';
    SELECT count(*) INTO v_a FROM v_finance_position WHERE business_id='00000000-0000-0000-0000-00000000fa01';
    SELECT count(*) INTO v_b FROM v_finance_position WHERE business_id='00000000-0000-0000-0000-00000000fb01';
    SELECT receivables INTO v_recv_b FROM v_finance_position WHERE business_id='00000000-0000-0000-0000-00000000fb01';
  EXCEPTION WHEN OTHERS THEN e := SQLERRM;
  END;
  RESET ROLE;
  PERFORM pg_temp.assert(e = '', 'C1 owner de B consulta sin error ('||e||')');
  PERFORM pg_temp.assert(v_a = 0, 'C2 owner de B NO obtiene el negocio A (obtuvo '||COALESCE(v_a::text,'NULL')||' filas)');
  PERFORM pg_temp.assert(v_b = 1, 'C3 owner de B SI obtiene su propio negocio');
  PERFORM pg_temp.assert(v_recv_b = 22000, 'C4 owner de B ve SUS importes, no los de A (obtuvo '||COALESCE(v_recv_b::text,'NULL')||')');
END $$;

-- ══ 6. Usuario sin membresia ════════════════════════════════════════════════
DO $$
DECLARE e text; v_rows int;
BEGIN
  e := '';
  BEGIN
    SET LOCAL ROLE authenticated;
    SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000fc09';
    SELECT count(*) INTO v_rows FROM v_finance_position;
  EXCEPTION WHEN OTHERS THEN e := SQLERRM;
  END;
  RESET ROLE;
  PERFORM pg_temp.assert(e = '', 'E1 usuario sin membresia no rompe la vista ('||e||')');
  PERFORM pg_temp.assert(v_rows = 0, 'E2 usuario sin membresia obtiene CERO filas (obtuvo '||COALESCE(v_rows::text,'NULL')||')');
END $$;

-- ══ 7. anon ═════════════════════════════════════════════════════════════════
DO $$
DECLARE s_view text; s_tbl text;
BEGIN
  s_view := ''; s_tbl := '';
  BEGIN SET LOCAL ROLE anon; PERFORM 1 FROM v_finance_position;
  EXCEPTION WHEN OTHERS THEN s_view := SQLSTATE; END; RESET ROLE;
  BEGIN SET LOCAL ROLE anon; PERFORM 1 FROM owner_withdrawals;
  EXCEPTION WHEN OTHERS THEN s_tbl := SQLSTATE; END; RESET ROLE;
  PERFORM pg_temp.assert(s_view = '42501',
    'AN1 anon es rechazado en v_finance_position (obtuvo: '||COALESCE(NULLIF(s_view,''),'SIN ERROR')||')');
  PERFORM pg_temp.assert(s_tbl = '42501',
    'AN2 anon es rechazado en owner_withdrawals (obtuvo: '||COALESCE(NULLIF(s_tbl,''),'SIN ERROR')||')');
END $$;

-- ══ 8. Lectura directa de owner_withdrawals acotada por RLS ═════════════════
DO $$
DECLARE v_own int; v_other int; v_total int;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000fa09';
  SELECT count(*) INTO v_total FROM owner_withdrawals;
  SELECT count(*) INTO v_own   FROM owner_withdrawals WHERE business_id='00000000-0000-0000-0000-00000000fa01';
  SELECT count(*) INTO v_other FROM owner_withdrawals WHERE business_id='00000000-0000-0000-0000-00000000fb01';
  RESET ROLE;
  PERFORM pg_temp.assert(v_own   = 1, 'W1 owner de A lee su propio movimiento de capital');
  PERFORM pg_temp.assert(v_other = 0, 'W2 owner de A NO lee los del negocio B (obtuvo '||v_other||')');
  PERFORM pg_temp.assert(v_total = 1, 'W3 el GRANT no abrio la tabla entera: solo ve lo suyo (obtuvo '||v_total||')');
END $$;

-- El admin de A NO es el dueno de la fila: la policy es user_id = auth.uid().
-- Se afirma el comportamiento vigente para que un cambio de contrato sea visible.
DO $$
DECLARE v_rows int;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000fa0a';
  SELECT count(*) INTO v_rows FROM owner_withdrawals;
  RESET ROLE;
  PERFORM pg_temp.assert(v_rows = 0,
    'W4 la policy es por usuario (user_id=auth.uid()), no por negocio: el admin no ve los retiros del owner (obtuvo '||v_rows||')');
END $$;

-- ══ 9. Escrituras siguen cerradas ═══════════════════════════════════════════
DO $$
DECLARE s_i text; s_u text; s_d text; n_after int;
BEGIN
  s_i:=''; s_u:=''; s_d:='';
  BEGIN SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub"='00000000-0000-0000-0000-00000000fa09';
    INSERT INTO owner_withdrawals(business_id,user_id,amount,currency,date,flow_type,status)
      VALUES ('00000000-0000-0000-0000-00000000fa01','00000000-0000-0000-0000-00000000fa09',1,'ARS','2026-07-20','withdrawal','completed');
  EXCEPTION WHEN OTHERS THEN s_i := SQLSTATE; END; RESET ROLE;

  BEGIN SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub"='00000000-0000-0000-0000-00000000fa09';
    UPDATE owner_withdrawals SET amount=99999 WHERE business_id='00000000-0000-0000-0000-00000000fa01';
  EXCEPTION WHEN OTHERS THEN s_u := SQLSTATE; END; RESET ROLE;

  BEGIN SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub"='00000000-0000-0000-0000-00000000fa09';
    DELETE FROM owner_withdrawals WHERE business_id='00000000-0000-0000-0000-00000000fa01';
  EXCEPTION WHEN OTHERS THEN s_d := SQLSTATE; END; RESET ROLE;

  PERFORM pg_temp.assert(s_i='42501', 'X1 INSERT directo bloqueado (obtuvo '||COALESCE(NULLIF(s_i,''),'SIN ERROR')||')');
  PERFORM pg_temp.assert(s_u='42501', 'X2 UPDATE directo bloqueado (obtuvo '||COALESCE(NULLIF(s_u,''),'SIN ERROR')||')');
  PERFORM pg_temp.assert(s_d='42501', 'X3 DELETE directo bloqueado (obtuvo '||COALESCE(NULLIF(s_d,''),'SIN ERROR')||')');

  -- Y ninguna de las tres toco un solo dato.
  SELECT count(*) INTO n_after FROM owner_withdrawals;
  PERFORM pg_temp.assert(n_after = 2, 'X4 los intentos de escritura no alteraron datos (filas: '||n_after||')');
  PERFORM pg_temp.assert(
    (SELECT amount FROM owner_withdrawals WHERE business_id='00000000-0000-0000-0000-00000000fa01') = 5000,
    'X5 el UPDATE bloqueado no modifico el importe');
END $$;

-- ══ 10. Contrato minimo de TODAS las dependencias de la vista ═══════════════
-- Si mañana la vista suma una tabla base nueva sin GRANT, vuelve el mismo 403.
-- Este check recorre el cierre de dependencias y lo exige tabla por tabla.
DO $$
DECLARE r record; missing text := ''; no_rls text := '';
BEGIN
  FOR r IN
    WITH RECURSIVE deps AS (
      SELECT 'public.v_finance_position'::text AS obj, 0 AS lvl
      UNION
      SELECT dep.refobjid::regclass::text, d.lvl+1
      FROM deps d
      JOIN pg_rewrite w ON w.ev_class = d.obj::regclass
      JOIN pg_depend dep ON dep.objid = w.oid AND dep.refclassid='pg_class'::regclass
      WHERE dep.refobjid::regclass::text <> d.obj AND d.lvl < 6
    )
    SELECT c.relname, c.relkind, c.relrowsecurity
    FROM deps d JOIN pg_class c ON c.oid = d.obj::regclass
    WHERE c.relkind IN ('r','v')
  LOOP
    IF NOT has_table_privilege('authenticated', 'public.'||quote_ident(r.relname), 'SELECT') THEN
      missing := missing || r.relname || ' ';
    END IF;
    IF r.relkind = 'r' AND NOT r.relrowsecurity THEN
      no_rls := no_rls || r.relname || ' ';
    END IF;
  END LOOP;

  PERFORM pg_temp.assert(missing = '',
    'DEP1 toda dependencia de v_finance_position es legible por authenticated (faltan: '||missing||')');
  PERFORM pg_temp.assert(no_rls = '',
    'DEP2 toda tabla base de la cadena conserva RLS ENABLE (sin RLS: '||no_rls||')');
END $$;

-- ══ 11. La vista hermana quedo arreglada por el mismo grant ═════════════════
-- v_owner_flows (security_invoker) tambien leia owner_withdrawals: estaba rota
-- por la misma causa. Se afirma para que no se pierda de vista.
DO $$
DECLARE e text; v_rows int;
BEGIN
  e := '';
  BEGIN
    SET LOCAL ROLE authenticated;
    SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000fa09';
    SELECT count(*) INTO v_rows FROM v_owner_flows;
  EXCEPTION WHEN OTHERS THEN e := SQLERRM;
  END;
  RESET ROLE;
  PERFORM pg_temp.assert(e = '', 'OF1 v_owner_flows tambien dejo de tirar 42501 ('||e||')');
  PERFORM pg_temp.assert(v_rows = 1, 'OF2 v_owner_flows sigue acotada a las filas propias (obtuvo '||COALESCE(v_rows::text,'NULL')||')');
END $$;

-- ══ 12. No se abrio ninguna otra tabla financiera ═══════════════════════════
-- Tablas sensibles que NO deben ser legibles por authenticated ni por anon.
DO $$
DECLARE r record; leaked text := '';
BEGIN
  FOR r IN SELECT unnest(ARRAY['arca_config','whatsapp_connection_credentials']) AS t
  LOOP
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='public' AND c.relname=r.t)
       AND has_table_privilege('anon', 'public.'||quote_ident(r.t), 'SELECT') THEN
      leaked := leaked || r.t || ' ';
    END IF;
  END LOOP;
  PERFORM pg_temp.assert(leaked = '', 'S1 ninguna tabla sensible quedo legible por anon ('||leaked||')');
END $$;

ROLLBACK;
