-- ============================================================================
-- PRE-BETA-1 · public.users fuera de la API (aislamiento cross-tenant)
--
-- public.users es una tabla LEGACY y GLOBAL: no tiene business_id y guarda
-- datos personales (name, email, role, phone). La autoridad de identidad del
-- producto es profiles (+ business_members/capabilities); esta tabla quedo del
-- modelo previo y nadie la usa.
--
-- DISCOVERY (produccion read-only + replay local de main = f828899, catalogo real):
--   forma      8 columnas (id, name, email, role, phone, active, created_at,
--              created_by), PK id, UNIQUE email, CHECK role IN (admin,
--              technician, receptionist), FK created_by -> auth.users.
--              owner postgres, RLS ON, FORCE RLS OFF, sin triggers, sin
--              publicacion realtime, sin privilegios de columna.
--   FK entrante UNA: orders_technician_id_fkey (orders.technician_id ->
--              users.id ON DELETE SET NULL).
--   relacl     postgres=arwdDxt[m], anon=arwdDxt[m], authenticated=arwdDxt[m]
--              (m = MAINTAIN de PG17: produccion lo tiene, el replay no).
--              service_role y PUBLIC: nada.
--   policies   users_select  SELECT TO authenticated USING (true)
--              users_insert  INSERT TO authenticated WITH CHECK (current_user_role() IN (owner, admin))
--              users_update  UPDATE TO authenticated USING/CHECK (idem)
--              users_delete  DELETE TO authenticated USING (idem)
--              current_user_role() es el rol del perfil activo en CUALQUIER
--              negocio: ninguna policy relaciona la fila con un tenant.
--   datos      3 filas; 0 enlazan con auth.users ni con profiles (por id ni por
--              email); created_by NULL en las 3: no existe relacion derivable
--              con un negocio. orders.technician_id es NULL en el 100% de las
--              ordenes (0 referencian public.users).
--   consumidores DB: 0 funciones (public/private y cualquier schema de app),
--              0 vistas/reglas, 0 policies ajenas, 0 triggers, 0 jobs pg_cron.
--              Edge Functions: 0. Trafico API (edge_logs, 72 h): 0 requests a
--              /rest/v1/users y 0 embeds users(...).
--   Reproducido (tests/sql/prebeta1_public_users_baseline.test.sql y
--   scripts/security/prebeta1-users-postgrest.mjs --baseline):
--     · tech de A lee email/telefono de la fila de B (USING true).
--     · owner/admin de A hace UPDATE (incluido role) y DELETE de la fila de B.
--     · owner de A inserta filas arbitrarias; owner de B pisa la fila de A.
--     · anon/authenticated conservan TRUNCATE (latente: no lo expone PostgREST).
--
-- ESTRATEGIA (opcion A · retirar de la API, conservar la tabla):
--   · REVOKE ALL de anon, authenticated, service_role y PUBLIC (MAINTAIN de PG17
--     incluido). Sin privilegio, PostgREST y pg_graphql responden 42501 antes de
--     tocar una fila, y el embed technician:users(...) deja de ser una ruta.
--   · DROP de las 4 policies: sin GRANT quedarian muertas, y un GRANT futuro
--     que reabriera la tabla volveria a heredar USING (true). RLS sigue ON sin
--     policies (deny-by-default) como segunda barrera.
--   · No se crea una autoridad alternativa (vista/RPC): no hay relacion real
--     fila->tenant que la sostenga y ningun flujo vivo la necesita.
--
-- QUE NO HACE: no borra la tabla ni sus 3 filas (cero DML), no toca
-- orders.technician_id ni su FK (los chequeos de FK corren como el owner), no
-- toca assigned_profile_id ni el modelo de tecnicos (lote aparte), no toca
-- profiles, business_users_view, current_user_role() ni RBAC.
--
-- FAIL-CLOSED: si una precondicion no coincide con el discovery, RAISE y nada
-- se aplica. No hay adaptacion.
-- ============================================================================
BEGIN;
-- Las precondiciones comparan texto de catalogo (pg_get_constraintdef,
-- pg_get_expr, regclass::text), que se imprime relativo al search_path: se fija
-- para que el resultado no dependa de la sesion que aplica la migracion.
SET LOCAL search_path = public;

-- ════════════════════════════════════════════════════════════════════════════
-- 0. PRECONDICIONES
-- ════════════════════════════════════════════════════════════════════════════
DO $pre$
DECLARE
  v_users oid := to_regclass('public.users');
  v_orders oid := to_regclass('public.orders');
  v_src   text;
  v_n     bigint;
  v_role  text;
BEGIN
  -- PRECONDICION 1 · la tabla existe, es una tabla comun, owner postgres, RLS
  -- activo y no forzado, sin herencia ni particiones.
  IF v_users IS NULL OR v_orders IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION 1: faltan public.users o public.orders';
  END IF;
  IF NOT (SELECT c.relkind = 'r' AND pg_get_userbyid(c.relowner) = 'postgres'
                 AND c.relrowsecurity AND NOT c.relforcerowsecurity AND NOT c.relispartition
            FROM pg_class c WHERE c.oid = v_users)
     OR EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = v_users OR inhparent = v_users) THEN
    RAISE EXCEPTION 'PRECONDICION 1: public.users cambio de tipo, owner, RLS/FORCE RLS o herencia';
  END IF;

  -- PRECONDICION 2 · orden de migraciones: A3 es la ultima aplicada y no hay un
  -- PRE-BETA-1 registrado (ni con otra version).
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION 2: falta supabase_migrations.schema_migrations';
  END IF;
  EXECUTE 'SELECT max(version) FROM supabase_migrations.schema_migrations' INTO v_src;
  IF v_src IS DISTINCT FROM '20261009120000' THEN
    RAISE EXCEPTION 'PRECONDICION 2: la ultima migracion aplicada es % (se esperaba G2-C.3A3 = 20261009120000)', v_src;
  END IF;
  EXECUTE 'SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name ~* ''prebeta1''' INTO v_n;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'PRECONDICION 2: ya hay una migracion prebeta1 registrada';
  END IF;

  -- PRECONDICION 3 · columnas = snapshot del discovery (nombre, tipo, NOT NULL).
  IF EXISTS (
    (SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), a.attnotnull
       FROM pg_attribute a WHERE a.attrelid = v_users AND a.attnum > 0 AND NOT a.attisdropped
     EXCEPT
     SELECT * FROM (VALUES
       ('id', 'uuid', true), ('name', 'text', true), ('email', 'text', true), ('role', 'text', true),
       ('phone', 'text', false), ('active', 'boolean', false),
       ('created_at', 'timestamp with time zone', false), ('created_by', 'uuid', false)) AS e(n, t, nn))
    UNION ALL
    (SELECT * FROM (VALUES
       ('id', 'uuid', true), ('name', 'text', true), ('email', 'text', true), ('role', 'text', true),
       ('phone', 'text', false), ('active', 'boolean', false),
       ('created_at', 'timestamp with time zone', false), ('created_by', 'uuid', false)) AS e(n, t, nn)
     EXCEPT
     SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), a.attnotnull
       FROM pg_attribute a WHERE a.attrelid = v_users AND a.attnum > 0 AND NOT a.attisdropped)) THEN
    RAISE EXCEPTION 'PRECONDICION 3: las columnas de public.users no son las del discovery';
  END IF;

  -- PRECONDICION 4 · constraints: las 4 propias y UNA sola FK entrante
  -- (orders.technician_id ON DELETE SET NULL). Ninguna otra tabla depende.
  IF EXISTS (
    (SELECT c.conname::text, c.contype::text, c.conrelid::regclass::text, pg_get_constraintdef(c.oid)
       FROM pg_constraint c WHERE c.conrelid = v_users OR c.confrelid = v_users
     EXCEPT
     SELECT * FROM (VALUES
       ('users_pkey', 'p', 'users', 'PRIMARY KEY (id)'),
       ('users_email_key', 'u', 'users', 'UNIQUE (email)'),
       ('users_role_check', 'c', 'users', 'CHECK ((role = ANY (ARRAY[''admin''::text, ''technician''::text, ''receptionist''::text])))'),
       ('users_created_by_fkey', 'f', 'users', 'FOREIGN KEY (created_by) REFERENCES auth.users(id)'),
       ('orders_technician_id_fkey', 'f', 'orders', 'FOREIGN KEY (technician_id) REFERENCES users(id) ON DELETE SET NULL')) AS e(n, t, r, d))
    UNION ALL
    (SELECT * FROM (VALUES
       ('users_pkey', 'p', 'users', 'PRIMARY KEY (id)'),
       ('users_email_key', 'u', 'users', 'UNIQUE (email)'),
       ('users_role_check', 'c', 'users', 'CHECK ((role = ANY (ARRAY[''admin''::text, ''technician''::text, ''receptionist''::text])))'),
       ('users_created_by_fkey', 'f', 'users', 'FOREIGN KEY (created_by) REFERENCES auth.users(id)'),
       ('orders_technician_id_fkey', 'f', 'orders', 'FOREIGN KEY (technician_id) REFERENCES users(id) ON DELETE SET NULL')) AS e(n, t, r, d)
     EXCEPT
     SELECT c.conname::text, c.contype::text, c.conrelid::regclass::text, pg_get_constraintdef(c.oid)
       FROM pg_constraint c WHERE c.conrelid = v_users OR c.confrelid = v_users)) THEN
    RAISE EXCEPTION 'PRECONDICION 4: los constraints / FKs entrantes de public.users no son los del discovery';
  END IF;

  -- PRECONDICION 5 · policies = las 4 del discovery, con su texto exacto
  -- (nombre, comando, roles, USING, WITH CHECK). Si falta alguna o cambio, hay
  -- un PRE-BETA-1 parcial o drift: abortar.
  IF EXISTS (
    (SELECT p.polname::text, p.polcmd::text, p.polpermissive,
            (SELECT string_agg(pg_get_userbyid(r), ',' ORDER BY 1) FROM unnest(p.polroles) r),
            coalesce(pg_get_expr(p.polqual, p.polrelid), '-'), coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '-')
       FROM pg_policy p WHERE p.polrelid = v_users
     EXCEPT
     SELECT * FROM (VALUES
       ('users_select', 'r', true, 'authenticated', 'true', '-'),
       ('users_insert', 'a', true, 'authenticated', '-', '(current_user_role() = ANY (ARRAY[''owner''::text, ''admin''::text]))'),
       ('users_update', 'w', true, 'authenticated', '(current_user_role() = ANY (ARRAY[''owner''::text, ''admin''::text]))',
                                                    '(current_user_role() = ANY (ARRAY[''owner''::text, ''admin''::text]))'),
       ('users_delete', 'd', true, 'authenticated', '(current_user_role() = ANY (ARRAY[''owner''::text, ''admin''::text]))', '-')
     ) AS e(n, c, pm, r, q, w))
    UNION ALL
    (SELECT * FROM (VALUES
       ('users_select', 'r', true, 'authenticated', 'true', '-'),
       ('users_insert', 'a', true, 'authenticated', '-', '(current_user_role() = ANY (ARRAY[''owner''::text, ''admin''::text]))'),
       ('users_update', 'w', true, 'authenticated', '(current_user_role() = ANY (ARRAY[''owner''::text, ''admin''::text]))',
                                                    '(current_user_role() = ANY (ARRAY[''owner''::text, ''admin''::text]))'),
       ('users_delete', 'd', true, 'authenticated', '(current_user_role() = ANY (ARRAY[''owner''::text, ''admin''::text]))', '-')
     ) AS e(n, c, pm, r, q, w)
     EXCEPT
     SELECT p.polname::text, p.polcmd::text, p.polpermissive,
            (SELECT string_agg(pg_get_userbyid(r), ',' ORDER BY 1) FROM unnest(p.polroles) r),
            coalesce(pg_get_expr(p.polqual, p.polrelid), '-'), coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '-')
       FROM pg_policy p WHERE p.polrelid = v_users)) THEN
    RAISE EXCEPTION 'PRECONDICION 5: las policies de public.users no son las 4 del discovery (PRE-BETA-1 parcial o drift)';
  END IF;

  -- PRECONDICION 6 · ACL de tabla exacto (comparado como conjunto). Baseline
  -- requerido: anon y authenticated con SELECT, INSERT, UPDATE, DELETE,
  -- TRUNCATE, REFERENCES, TRIGGER. Compatibilidad PG17: MAINTAIN de anon y
  -- authenticated es OPCIONAL (produccion lo tiene, el replay no) y el REVOKE
  -- ALL de abajo lo quita igual. Cualquier otro grantee (service_role, PUBLIC,
  -- otro rol) o privilegio, o un privilegio del baseline faltante -> RAISE.
  -- Sin privilegios de columna.
  IF EXISTS (
    (SELECT a.grantee::regrole::text, a.privilege_type
       FROM pg_class c, aclexplode(c.relacl) a
      WHERE c.oid = v_users AND a.grantee <> c.relowner
        AND NOT (a.privilege_type = 'MAINTAIN' AND a.grantee IN ('anon'::regrole, 'authenticated'::regrole))
     EXCEPT
     SELECT r, p FROM unnest(ARRAY['anon', 'authenticated']) r,
                      unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p)
    UNION ALL
    (SELECT r, p FROM unnest(ARRAY['anon', 'authenticated']) r,
                      unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
     EXCEPT
     SELECT a.grantee::regrole::text, a.privilege_type
       FROM pg_class c, aclexplode(c.relacl) a
      WHERE c.oid = v_users AND a.grantee <> c.relowner)) THEN
    RAISE EXCEPTION 'PRECONDICION 6: el ACL de public.users no es el del discovery';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute att WHERE att.attrelid = v_users AND att.attnum > 0
                AND NOT att.attisdropped AND att.attacl IS NOT NULL) THEN
    RAISE EXCEPTION 'PRECONDICION 6: public.users tiene privilegios de columna (drift)';
  END IF;
  -- Ningun rol de API hereda los privilegios del owner.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'authenticator'] LOOP
    IF pg_has_role(v_role, 'postgres', 'MEMBER') THEN
      RAISE EXCEPTION 'PRECONDICION 6: % es miembro de postgres (heredaria el acceso del owner)', v_role;
    END IF;
  END LOOP;

  -- PRECONDICION 7 · consumidores en base = 0: ni triggers propios, ni
  -- publicacion realtime, ni vistas/reglas, ni funciones de schemas de app que
  -- nombren la tabla (las menciones a auth.users y al literal de capability
  -- 'users' no cuentan), ni jobs de pg_cron.
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = v_users AND NOT tgisinternal)
     OR EXISTS (SELECT 1 FROM pg_publication_rel WHERE prrelid = v_users)
     OR EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_rewrite'::regclass
                   AND d.refclassid = 'pg_class'::regclass AND d.refobjid = v_users) THEN
    RAISE EXCEPTION 'PRECONDICION 7: public.users tiene triggers, publicacion o vistas/reglas dependientes';
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'auth', 'storage', 'realtime', '_realtime',
                           'extensions', 'graphql', 'graphql_public', 'vault', 'net', 'supabase_functions',
                           'pgbouncer', 'cron', 'supabase_migrations', 'pgsodium', 'pgsodium_masks')
     AND n.nspname NOT LIKE 'pg\_%'
     AND p.prosrc IS NOT NULL
     AND (SELECT count(*) FROM regexp_matches(p.prosrc, '\musers\M', 'gi'))
       > (SELECT count(*) FROM regexp_matches(p.prosrc, '(auth"?\s*\.\s*"?users\M|''users'')', 'gi'));
  IF v_src IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDICION 7: funciones que nombran public.users: %', v_src;
  END IF;
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM cron.job
                WHERE command ~* '\musers\M' AND command !~* 'auth"?\s*\.\s*"?users\M'$q$ INTO v_n;
    IF v_n > 0 THEN
      RAISE EXCEPTION 'PRECONDICION 7: hay % job(s) de pg_cron que nombran public.users', v_n;
    END IF;
  END IF;

  -- PRECONDICION 8 · el unico camino de lectura del frontend (el tecnico por
  -- orders.technician_id) esta sin uso: ninguna orden lo tiene seteado. Si
  -- alguien empezo a usarlo despues del discovery, retirar la tabla cambiaria
  -- lo que ve el usuario: abortar y rehacer el discovery.
  IF EXISTS (SELECT 1 FROM public.orders WHERE technician_id IS NOT NULL) THEN
    RAISE EXCEPTION 'PRECONDICION 8: hay ordenes con technician_id (el discovery lo midio 100%% NULL)';
  END IF;
END
$pre$;

-- Snapshot para las postcondiciones: forma y contenido (huella) de la tabla.
CREATE TEMP TABLE _prebeta1_snapshot ON COMMIT DROP AS
SELECT
  (SELECT string_agg(format('%s:%s:%s:%s', a.attnum, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull), ',' ORDER BY a.attnum)
     FROM pg_attribute a WHERE a.attrelid = 'public.users'::regclass AND a.attnum > 0 AND NOT a.attisdropped) AS columnas,
  (SELECT string_agg(format('%s:%s', c.conname, pg_get_constraintdef(c.oid)), ',' ORDER BY c.conname)
     FROM pg_constraint c WHERE c.conrelid = 'public.users'::regclass OR c.confrelid = 'public.users'::regclass) AS constraints,
  (SELECT string_agg(format('%s', pg_get_indexdef(i.indexrelid)), ',' ORDER BY 1)
     FROM pg_index i WHERE i.indrelid = 'public.users'::regclass) AS indices,
  (SELECT count(*) FROM public.users) AS filas,
  (SELECT md5(coalesce(string_agg(u::text, ',' ORDER BY u.id), '')) FROM public.users u) AS huella,
  (SELECT md5(pg_get_functiondef('public.current_user_role()'::regprocedure))) AS current_user_role_def;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. CIERRE: fuera de la API
-- ════════════════════════════════════════════════════════════════════════════
DROP POLICY users_select ON public.users;
DROP POLICY users_insert ON public.users;
DROP POLICY users_update ON public.users;
DROP POLICY users_delete ON public.users;

REVOKE ALL ON TABLE public.users FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.users IS
  'LEGACY · PRE-BETA-1: tabla global sin tenant, fuera de la API (sin GRANT a anon/authenticated/service_role, '
  'RLS on sin policies). La identidad del equipo vive en profiles. No volver a exponer: si hace falta un dato, '
  'crear una autoridad tenant-scoped sobre profiles.';

-- ════════════════════════════════════════════════════════════════════════════
-- 2. POSTCONDICIONES
-- ════════════════════════════════════════════════════════════════════════════
DO $post$
DECLARE
  v_users oid := 'public.users'::regclass;
  v_role  text;
  s       record;
BEGIN
  SELECT * INTO s FROM _prebeta1_snapshot;

  -- POSTCONDICION 1 · sin policies y con RLS activo (deny-by-default).
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_users)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_users) THEN
    RAISE EXCEPTION 'POSTCONDICION 1: public.users conserva policies o perdio RLS';
  END IF;

  -- POSTCONDICION 2 · ningun grantee distinto del owner (MAINTAIN incluido) y
  -- ningun privilegio de columna.
  IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = v_users AND a.grantee <> c.relowner)
     OR EXISTS (SELECT 1 FROM pg_attribute att WHERE att.attrelid = v_users AND att.attnum > 0
                   AND NOT att.attisdropped AND att.attacl IS NOT NULL) THEN
    RAISE EXCEPTION 'POSTCONDICION 2: public.users conserva privilegios para roles distintos del owner';
  END IF;

  -- POSTCONDICION 3 · contrato por rol, medido con las funciones de privilegio
  -- (incluyen herencia de roles): ni anon, ni authenticated, ni service_role,
  -- ni authenticator pueden leer, escribir, truncar, referenciar ni disparar.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'authenticator'] LOOP
    IF has_table_privilege(v_role, v_users, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       OR has_any_column_privilege(v_role, v_users, 'SELECT, INSERT, UPDATE, REFERENCES') THEN
      RAISE EXCEPTION 'POSTCONDICION 3: % conserva acceso a public.users', v_role;
    END IF;
    IF pg_has_role(v_role, 'postgres', 'MEMBER') THEN
      RAISE EXCEPTION 'POSTCONDICION 3: % es miembro de postgres', v_role;
    END IF;
  END LOOP;

  -- POSTCONDICION 4 · cero DML y forma intacta: mismas columnas, constraints
  -- (FK orders.technician_id incluida), indices, filas y huella de contenido;
  -- current_user_role() sin cambios.
  IF s.columnas IS DISTINCT FROM (SELECT string_agg(format('%s:%s:%s:%s', a.attnum, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull), ',' ORDER BY a.attnum)
                                    FROM pg_attribute a WHERE a.attrelid = v_users AND a.attnum > 0 AND NOT a.attisdropped)
     OR s.constraints IS DISTINCT FROM (SELECT string_agg(format('%s:%s', c.conname, pg_get_constraintdef(c.oid)), ',' ORDER BY c.conname)
                                          FROM pg_constraint c WHERE c.conrelid = v_users OR c.confrelid = v_users)
     OR s.indices IS DISTINCT FROM (SELECT string_agg(format('%s', pg_get_indexdef(i.indexrelid)), ',' ORDER BY 1)
                                      FROM pg_index i WHERE i.indrelid = v_users)
     OR s.filas IS DISTINCT FROM (SELECT count(*) FROM public.users)
     OR s.huella IS DISTINCT FROM (SELECT md5(coalesce(string_agg(u::text, ',' ORDER BY u.id), '')) FROM public.users u)
     OR s.current_user_role_def IS DISTINCT FROM (SELECT md5(pg_get_functiondef('public.current_user_role()'::regprocedure))) THEN
    RAISE EXCEPTION 'POSTCONDICION 4: cambio la forma o el contenido de public.users (PRE-BETA-1 es cero DML)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_technician_id_fkey'
                    AND conrelid = 'public.orders'::regclass AND confrelid = v_users) THEN
    RAISE EXCEPTION 'POSTCONDICION 4: se perdio orders_technician_id_fkey';
  END IF;

  RAISE NOTICE 'PRE-BETA-1 OK · public.users fuera de la API: 4 policies eliminadas (RLS on, deny-by-default) '
    '· REVOKE ALL a PUBLIC/anon/authenticated/service_role (MAINTAIN incluido) · sin privilegios de columna '
    '· % filas intactas (huella identica), forma/constraints/FK orders.technician_id intactos · cero DML.', s.filas;
END
$post$;

COMMIT;
