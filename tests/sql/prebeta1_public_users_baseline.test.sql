-- ============================================================================
-- PRE-BETA-1 · public.users — CONTROL NEGATIVO (estado ANTES del fix).
--
-- Reproduce el bypass cross-tenant sobre current main SIN la migracion
-- 20261010120000_prebeta1_public_users_api_retirement.sql. Cada PASS de este
-- archivo es un hueco demostrado; si alguno FALLA es porque el hueco ya no
-- existe (p. ej. la migracion ya esta aplicada) y el control deja de ser un
-- control: por eso el primer chequeo exige el estado pre-fix.
--
-- public.users es legacy y GLOBAL: no tiene business_id, ninguna fila se puede
-- atribuir a un tenant por catalogo. Las filas fixture LA/LB representan "el
-- tecnico que dio de alta el negocio A/B" (created_by = su owner): pertenencia
-- CONCEPTUAL, que es justamente la que la base no puede hacer cumplir.
--
-- Los accesos se ejecutan como la API: SET LOCAL ROLE authenticated|anon +
-- request.jwt.claim.sub (lo mismo que hace PostgREST).
-- Corre dentro de BEGIN ... ROLLBACK: no deja rastro.
-- RUN: npm run test:sql:prebeta1:baseline
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;

CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label;
  ELSE RAISE NOTICE 'PASS: %', label; END IF;
END; $$;

-- Ejecuta SQL como la API y devuelve 'OK <filas>' o 'SQLSTATE mensaje'.
CREATE OR REPLACE FUNCTION pg_temp.como_rol(p_role text, p_uid uuid, p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_state text; v_rows bigint;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_uid::text, ''), true);
  PERFORM set_config('request.jwt.claims',
    (jsonb_build_object('role', p_role)
       || CASE WHEN p_uid IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('sub', p_uid) END)::text, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_state := 'OK ' || v_rows;
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE || ' ' || SQLERRM;
  END;
  RESET ROLE;
  RETURN v_state;
END; $$;

-- Igual que como_rol, pero devuelve el valor escalar de un SELECT (o el error).
CREATE OR REPLACE FUNCTION pg_temp.leer(p_role text, p_uid uuid, p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_uid::text, ''), true);
  PERFORM set_config('request.jwt.claims',
    (jsonb_build_object('role', p_role)
       || CASE WHEN p_uid IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('sub', p_uid) END)::text, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql INTO v;
  EXCEPTION WHEN OTHERS THEN
    v := SQLSTATE || ' ' || SQLERRM;
  END;
  RESET ROLE;
  RETURN v;
END; $$;

-- ── 0. El control solo vale sobre el estado PRE-fix ─────────────────────────
SELECT pg_temp.assert(
  (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.users'::regclass) = 4
  AND has_table_privilege('authenticated', 'public.users', 'SELECT'),
  'estado pre-fix: public.users conserva sus 4 policies y el SELECT de authenticated');

-- ── Fixture: dos tenants, un owner/admin/tech/sales en A, owner/tech en B ───
SET LOCAL session_replication_role = replica;
INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('00000000-0000-0000-0000-00000b1a0001', 'owner-a@prebeta1.invalid', now()),
  ('00000000-0000-0000-0000-00000b1a0002', 'admin-a@prebeta1.invalid', now()),
  ('00000000-0000-0000-0000-00000b1a0003', 'tech-a@prebeta1.invalid',  now()),
  ('00000000-0000-0000-0000-00000b1a0004', 'sales-a@prebeta1.invalid', now()),
  ('00000000-0000-0000-0000-00000b1b0001', 'owner-b@prebeta1.invalid', now()),
  ('00000000-0000-0000-0000-00000b1b0003', 'tech-b@prebeta1.invalid',  now());
INSERT INTO public.businesses (id, name, owner_user_id, subscription_plan, subscription_status) VALUES
  ('00000000-0000-0000-0000-00000b1a0000', 'PRE-BETA-1 A', '00000000-0000-0000-0000-00000b1a0001', 'pro', 'active'),
  ('00000000-0000-0000-0000-00000b1b0000', 'PRE-BETA-1 B', '00000000-0000-0000-0000-00000b1b0001', 'pro', 'active');
INSERT INTO public.profiles (id, business_id, role, is_active, email) VALUES
  ('00000000-0000-0000-0000-00000b1a0001', '00000000-0000-0000-0000-00000b1a0000', 'owner', true, 'owner-a@prebeta1.invalid'),
  ('00000000-0000-0000-0000-00000b1a0002', '00000000-0000-0000-0000-00000b1a0000', 'admin', true, 'admin-a@prebeta1.invalid'),
  ('00000000-0000-0000-0000-00000b1a0003', '00000000-0000-0000-0000-00000b1a0000', 'tech',  true, 'tech-a@prebeta1.invalid'),
  ('00000000-0000-0000-0000-00000b1a0004', '00000000-0000-0000-0000-00000b1a0000', 'sales', true, 'sales-a@prebeta1.invalid'),
  ('00000000-0000-0000-0000-00000b1b0001', '00000000-0000-0000-0000-00000b1b0000', 'owner', true, 'owner-b@prebeta1.invalid'),
  ('00000000-0000-0000-0000-00000b1b0003', '00000000-0000-0000-0000-00000b1b0000', 'tech',  true, 'tech-b@prebeta1.invalid');
-- Filas legacy: LA la dio de alta el owner de A, LB el owner de B.
INSERT INTO public.users (id, name, email, role, phone, active, created_by) VALUES
  ('00000000-0000-0000-0000-00000b1a00aa', 'Tecnico de A', 'legacy-a@prebeta1.invalid', 'technician', '+54 11 0000-000A', true, '00000000-0000-0000-0000-00000b1a0001'),
  ('00000000-0000-0000-0000-00000b1b00bb', 'Tecnico de B', 'legacy-b@prebeta1.invalid', 'technician', '+54 11 0000-000B', true, '00000000-0000-0000-0000-00000b1b0001');
SET LOCAL session_replication_role = origin;

-- ── 1. LECTURA cross-tenant ─────────────────────────────────────────────────
SELECT pg_temp.assert(
  pg_temp.leer('authenticated', '00000000-0000-0000-0000-00000b1a0001',
    $q$SELECT email || ' | ' || phone FROM public.users WHERE id = '00000000-0000-0000-0000-00000b1b00bb'$q$)
  = 'legacy-b@prebeta1.invalid | +54 11 0000-000B',
  'BYPASS L1: owner de A lee email y telefono de la fila de B');
SELECT pg_temp.assert(
  pg_temp.leer('authenticated', '00000000-0000-0000-0000-00000b1a0003',
    $q$SELECT email FROM public.users WHERE id = '00000000-0000-0000-0000-00000b1b00bb'$q$)
  = 'legacy-b@prebeta1.invalid',
  'BYPASS L2: tech de A (sin capability users) tambien lee la fila de B (USING true)');
SELECT pg_temp.assert(
  pg_temp.leer('authenticated', '00000000-0000-0000-0000-00000b1b0003',
    $q$SELECT count(*)::text FROM public.users WHERE id IN ('00000000-0000-0000-0000-00000b1a00aa','00000000-0000-0000-0000-00000b1b00bb')$q$)
  = '2',
  'BYPASS L3: tech de B ve las filas de A y de B (tabla global)');

-- ── 2. ESCRITURA cross-tenant (owner/admin de A sobre la fila de B) ─────────
SELECT pg_temp.assert(
  pg_temp.como_rol('authenticated', '00000000-0000-0000-0000-00000b1a0001',
    $q$UPDATE public.users SET phone = 'pisado-por-A' WHERE id = '00000000-0000-0000-0000-00000b1b00bb'$q$) = 'OK 1',
  'BYPASS W1: owner de A hace UPDATE de la fila de B');
-- La verificacion va en su propia sentencia: dentro de un AND el planner puede
-- evaluar la subconsulta ANTES de la llamada que escribe.
SELECT pg_temp.assert(
  (SELECT phone FROM public.users WHERE id = '00000000-0000-0000-0000-00000b1b00bb') = 'pisado-por-A',
  'BYPASS W1b: el telefono de B quedo pisado por A');
SELECT pg_temp.assert(
  pg_temp.como_rol('authenticated', '00000000-0000-0000-0000-00000b1a0002',
    $q$UPDATE public.users SET name = 'renombrado-por-admin-A', role = 'admin' WHERE id = '00000000-0000-0000-0000-00000b1b00bb'$q$) = 'OK 1',
  'BYPASS W2: admin de A hace UPDATE (incluso de role) de la fila de B');
SELECT pg_temp.assert(
  pg_temp.como_rol('authenticated', '00000000-0000-0000-0000-00000b1b0001',
    $q$UPDATE public.users SET active = false WHERE id = '00000000-0000-0000-0000-00000b1a00aa'$q$) = 'OK 1',
  'BYPASS W3: owner de B hace UPDATE de la fila de A (simetrico)');
SELECT pg_temp.assert(
  pg_temp.como_rol('authenticated', '00000000-0000-0000-0000-00000b1a0001',
    $q$INSERT INTO public.users (name, email, role) VALUES ('arbitrario', 'arbitrario@prebeta1.invalid', 'admin')$q$) = 'OK 1',
  'BYPASS W4: owner de A inserta una fila arbitraria en la tabla global');
SELECT pg_temp.assert(
  pg_temp.como_rol('authenticated', '00000000-0000-0000-0000-00000b1a0001',
    $q$DELETE FROM public.users WHERE id = '00000000-0000-0000-0000-00000b1b00bb'$q$) = 'OK 1',
  'BYPASS W5: owner de A hace DELETE de la fila de B');
SELECT pg_temp.assert(
  NOT EXISTS (SELECT 1 FROM public.users WHERE id = '00000000-0000-0000-0000-00000b1b00bb'),
  'BYPASS W5b: la fila de B desaparecio');

-- La unica "autoridad" de las policies es el rol global: tech de A no escribe,
-- pero no por tenant sino porque no es owner/admin EN NINGUN negocio.
SELECT pg_temp.assert(
  pg_temp.como_rol('authenticated', '00000000-0000-0000-0000-00000b1a0003',
    $q$UPDATE public.users SET phone = 'x' WHERE id = '00000000-0000-0000-0000-00000b1a00aa'$q$) = 'OK 0',
  'contexto: tech de A no escribe ni su propia fila (la policy mira solo el rol)');

-- ── 3. Privilegios latentes (no alcanzables por PostgREST, si por SQL) ──────
SELECT pg_temp.assert(
  has_table_privilege('anon', 'public.users', 'SELECT, INSERT, UPDATE, DELETE')
  AND has_table_privilege('anon', 'public.users', 'TRUNCATE')
  AND has_table_privilege('authenticated', 'public.users', 'TRUNCATE'),
  'LATENTE: anon y authenticated conservan SELECT/INSERT/UPDATE/DELETE/TRUNCATE de tabla');
SELECT pg_temp.assert(
  pg_temp.leer('anon', NULL, $q$SELECT count(*)::text FROM public.users$q$) = '0',
  'contexto: anon lee 0 filas hoy solo porque no hay policy TO anon (el GRANT existe)');
SELECT pg_temp.assert(
  NOT has_table_privilege('service_role', 'public.users', 'SELECT'),
  'contexto: service_role ya no tiene ningun privilegio sobre public.users');

ROLLBACK;
