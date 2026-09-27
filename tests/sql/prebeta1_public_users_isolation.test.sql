-- ============================================================================
-- PRE-BETA-1 · public.users fuera de la API — contrato POST-fix.
--
-- Migracion: 20261010120000_prebeta1_public_users_api_retirement.sql.
-- Control negativo (el mismo fixture, ANTES del fix):
--   tests/sql/prebeta1_public_users_baseline.test.sql
--
-- Contrato:
--   · Tenant A y tenant B (owner, admin, tech, sales): no leen, no insertan, no
--     actualizan, no borran, no truncan public.users -> 42501 en el chequeo de
--     permisos, antes de tocar una fila. La tabla queda intacta.
--   · anon: idem. service_role: idem (contrato explicito: sin acceso).
--   · Ninguna policy; RLS sigue ON (deny-by-default aunque un GRANT futuro
--     reabriera la tabla).
--   · Los flujos vivos siguen: miembros por business_users_view (profiles,
--     aislados por negocio) y ordenes (sin embed de users), y la FK
--     orders.technician_id se sigue validando (corre como el owner).
--
-- Los accesos se ejecutan como la API: SET LOCAL ROLE authenticated|anon|
-- service_role + request.jwt.claim.sub (lo mismo que hace PostgREST).
-- Corre dentro de BEGIN ... ROLLBACK: no deja rastro.
-- RUN: npm run test:sql:prebeta1
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

CREATE OR REPLACE FUNCTION pg_temp.huella() RETURNS text LANGUAGE sql AS
$$ SELECT md5(coalesce(string_agg(u::text, ',' ORDER BY u.id), '')) FROM public.users u $$;

-- ── 0. La migracion esta aplicada (si no, cada 42501 seria por otra razon) ──
SELECT pg_temp.assert(
  (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.users'::regclass) = 0
  AND NOT EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
                   WHERE c.oid = 'public.users'::regclass AND a.grantee <> c.relowner)
  AND EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261010120000'),
  'PRE-BETA-1 aplicada: 0 policies, ACL solo del owner, registrada en el ledger');

-- ── Fixture: el mismo del control negativo ──────────────────────────────────
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
INSERT INTO public.users (id, name, email, role, phone, active, created_by) VALUES
  ('00000000-0000-0000-0000-00000b1a00aa', 'Tecnico de A', 'legacy-a@prebeta1.invalid', 'technician', '+54 11 0000-000A', true, '00000000-0000-0000-0000-00000b1a0001'),
  ('00000000-0000-0000-0000-00000b1b00bb', 'Tecnico de B', 'legacy-b@prebeta1.invalid', 'technician', '+54 11 0000-000B', true, '00000000-0000-0000-0000-00000b1b0001');
INSERT INTO public.customers (id, business_id, name, phone) VALUES
  ('00000000-0000-0000-0000-00000b1a00c1', '00000000-0000-0000-0000-00000b1a0000', 'Cliente A', '1'),
  ('00000000-0000-0000-0000-00000b1b00c1', '00000000-0000-0000-0000-00000b1b0000', 'Cliente B', '2');
INSERT INTO public.orders (id, business_id, customer_id, status, assigned_profile_id) VALUES
  ('00000000-0000-0000-0000-00000b1a00d1', '00000000-0000-0000-0000-00000b1a0000', '00000000-0000-0000-0000-00000b1a00c1', 'completed', '00000000-0000-0000-0000-00000b1a0003'),
  ('00000000-0000-0000-0000-00000b1b00d1', '00000000-0000-0000-0000-00000b1b0000', '00000000-0000-0000-0000-00000b1b00c1', 'completed', '00000000-0000-0000-0000-00000b1b0003');
SET LOCAL session_replication_role = origin;

CREATE TEMP TABLE _h ON COMMIT DROP AS SELECT pg_temp.huella() AS h;

-- ── 1. Matriz por actor: toda operacion -> 42501 ─────────────────────────────
-- (actor, rol, uid) x (lectura propia, lectura ajena, listado, INSERT, UPDATE
-- propia/ajena, DELETE propia/ajena, TRUNCATE). La "fila propia" es la que dio
-- de alta el owner de su negocio (created_by): tampoco se alcanza.
DO $matriz$
DECLARE
  a record; op record; v text; n int := 0;
BEGIN
  FOR a IN SELECT * FROM (VALUES
      ('A owner',  'authenticated', '00000000-0000-0000-0000-00000b1a0001'::uuid, '00000000-0000-0000-0000-00000b1a00aa', '00000000-0000-0000-0000-00000b1b00bb'),
      ('A admin',  'authenticated', '00000000-0000-0000-0000-00000b1a0002'::uuid, '00000000-0000-0000-0000-00000b1a00aa', '00000000-0000-0000-0000-00000b1b00bb'),
      ('A tech',   'authenticated', '00000000-0000-0000-0000-00000b1a0003'::uuid, '00000000-0000-0000-0000-00000b1a00aa', '00000000-0000-0000-0000-00000b1b00bb'),
      ('A sales',  'authenticated', '00000000-0000-0000-0000-00000b1a0004'::uuid, '00000000-0000-0000-0000-00000b1a00aa', '00000000-0000-0000-0000-00000b1b00bb'),
      ('B owner',  'authenticated', '00000000-0000-0000-0000-00000b1b0001'::uuid, '00000000-0000-0000-0000-00000b1b00bb', '00000000-0000-0000-0000-00000b1a00aa'),
      ('B tech',   'authenticated', '00000000-0000-0000-0000-00000b1b0003'::uuid, '00000000-0000-0000-0000-00000b1b00bb', '00000000-0000-0000-0000-00000b1a00aa'),
      ('anon',     'anon',          NULL::uuid,                                   '00000000-0000-0000-0000-00000b1a00aa', '00000000-0000-0000-0000-00000b1b00bb'),
      ('service',  'service_role',  NULL::uuid,                                   '00000000-0000-0000-0000-00000b1a00aa', '00000000-0000-0000-0000-00000b1b00bb')
    ) AS t(actor, rol, uid, propia, ajena)
  LOOP
    FOR op IN SELECT * FROM (VALUES
        ('SELECT propia',  format($q$SELECT email FROM public.users WHERE id = %L$q$, a.propia)),
        ('SELECT ajena',   format($q$SELECT email || phone FROM public.users WHERE id = %L$q$, a.ajena)),
        ('SELECT listado', $q$SELECT count(*) FROM public.users$q$),
        ('SELECT name',    $q$SELECT name FROM public.users LIMIT 1$q$),
        ('INSERT',         $q$INSERT INTO public.users (name, email, role) VALUES ('x', 'x@prebeta1.invalid', 'admin')$q$),
        ('UPDATE propia',  format($q$UPDATE public.users SET phone = 'x' WHERE id = %L$q$, a.propia)),
        ('UPDATE ajena',   format($q$UPDATE public.users SET role = 'admin' WHERE id = %L$q$, a.ajena)),
        ('DELETE propia',  format($q$DELETE FROM public.users WHERE id = %L$q$, a.propia)),
        ('DELETE ajena',   format($q$DELETE FROM public.users WHERE id = %L$q$, a.ajena)),
        ('TRUNCATE',       $q$TRUNCATE public.users CASCADE$q$),
        ('embed via FK',   $q$SELECT count(*) FROM public.orders o JOIN public.users u ON u.id = o.technician_id$q$)
      ) AS o(nombre, sql)
    LOOP
      v := pg_temp.como_rol(a.rol, a.uid, op.sql);
      IF v NOT LIKE '42501 %' THEN
        RAISE EXCEPTION 'FAIL: % % -> % (se esperaba 42501)', a.actor, op.nombre, v;
      END IF;
      n := n + 1;
    END LOOP;
  END LOOP;
  RAISE NOTICE 'PASS: matriz % casos (6 actores de A/B + anon + service_role x 11 operaciones) -> 42501', n;
END
$matriz$;

SELECT pg_temp.assert(pg_temp.huella() = (SELECT h FROM _h)
  AND (SELECT count(*) FROM public.users WHERE email LIKE '%@prebeta1.invalid') = 2,
  'public.users intacta tras la matriz (huella md5 identica, 2 filas fixture)');

-- ── 2. Contrato de privilegios por rol (incluye herencia) ───────────────────
SELECT pg_temp.assert(
  NOT has_table_privilege(r, 'public.users', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
  AND NOT has_any_column_privilege(r, 'public.users', 'SELECT, INSERT, UPDATE, REFERENCES'),
  format('%s: ningun privilegio de tabla ni de columna sobre public.users', r))
FROM unnest(ARRAY['anon', 'authenticated', 'service_role', 'authenticator']) r;
SELECT pg_temp.assert(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.users'::regclass)
  AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.users'::regclass),
  'RLS sigue ON sin policies (deny-by-default ante un GRANT futuro)');

-- Defensa en profundidad: si un GRANT futuro reabriera SELECT, RLS sin policies
-- no devuelve ni una fila (se mide y se deshace dentro del test).
SAVEPOINT reabre;
GRANT SELECT, UPDATE, DELETE ON public.users TO authenticated;
SELECT pg_temp.assert(
  pg_temp.leer('authenticated', '00000000-0000-0000-0000-00000b1a0001', $q$SELECT count(*)::text FROM public.users$q$) = '0'
  AND pg_temp.como_rol('authenticated', '00000000-0000-0000-0000-00000b1a0001',
        $q$UPDATE public.users SET phone = 'x' WHERE id = '00000000-0000-0000-0000-00000b1b00bb'$q$) = 'OK 0'
  AND pg_temp.como_rol('authenticated', '00000000-0000-0000-0000-00000b1a0001',
        $q$DELETE FROM public.users WHERE id = '00000000-0000-0000-0000-00000b1b00bb'$q$) = 'OK 0',
  'D1: aun con un GRANT futuro, RLS sin policies no lee ni escribe ninguna fila');
ROLLBACK TO SAVEPOINT reabre;

-- ── 3. Flujos vivos intactos ────────────────────────────────────────────────
SELECT pg_temp.assert(
  pg_temp.leer('authenticated', '00000000-0000-0000-0000-00000b1a0001',
    $q$SELECT count(*)::text FROM public.business_users_view WHERE business_id = '00000000-0000-0000-0000-00000b1a0000'$q$) = '4'
  AND pg_temp.leer('authenticated', '00000000-0000-0000-0000-00000b1a0001',
    $q$SELECT count(*)::text FROM public.business_users_view WHERE business_id = '00000000-0000-0000-0000-00000b1b0000'$q$) = '0',
  'L1: owner de A lista los 4 miembros de A y 0 de B (business_users_view / profiles)');
SELECT pg_temp.assert(
  pg_temp.leer('authenticated', '00000000-0000-0000-0000-00000b1b0001',
    $q$SELECT count(*)::text FROM public.business_users_view WHERE business_id = '00000000-0000-0000-0000-00000b1b0000'$q$) = '2'
  AND pg_temp.leer('authenticated', '00000000-0000-0000-0000-00000b1b0001',
    $q$SELECT count(*)::text FROM public.business_users_view WHERE business_id = '00000000-0000-0000-0000-00000b1a0000'$q$) = '0',
  'L2: owner de B lista sus 2 miembros y 0 de A');
SELECT pg_temp.assert(
  pg_temp.leer('authenticated', '00000000-0000-0000-0000-00000b1a0003',
    $q$SELECT count(*)::text FROM public.business_users_view WHERE business_id = '00000000-0000-0000-0000-00000b1b0000'$q$) = '0'
  AND pg_temp.leer('authenticated', '00000000-0000-0000-0000-00000b1a0004',
    $q$SELECT count(*)::text FROM public.business_users_view WHERE business_id = '00000000-0000-0000-0000-00000b1b0000'$q$) = '0',
  'L3: tech y sales de A no ven miembros de B');
SELECT pg_temp.assert(
  pg_temp.leer('authenticated', '00000000-0000-0000-0000-00000b1a0001',
    $q$SELECT count(*)::text FROM public.orders WHERE status = 'completed' AND business_id = '00000000-0000-0000-0000-00000b1a0000'$q$) = '1'
  AND pg_temp.leer('authenticated', '00000000-0000-0000-0000-00000b1a0001',
    $q$SELECT count(*)::text FROM public.orders WHERE business_id = '00000000-0000-0000-0000-00000b1b0000'$q$) = '0',
  'L4: owner de A lee sus ordenes (sin embed de users) y no las de B');

-- La FK orders.technician_id se sigue validando (el chequeo corre como el owner
-- de public.users): una orden no puede apuntar a un id inexistente.
SELECT pg_temp.assert(
  pg_temp.como_rol('authenticated', '00000000-0000-0000-0000-00000b1a0001',
    $q$UPDATE public.orders SET technician_id = '00000000-0000-0000-0000-0000deadbeef' WHERE id = '00000000-0000-0000-0000-00000b1a00d1'$q$) LIKE '23503 %',
  'F1: la FK orders.technician_id sigue validando (23503 ante un id inexistente)');

ROLLBACK;
