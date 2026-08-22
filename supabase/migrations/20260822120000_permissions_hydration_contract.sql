-- ============================================================================
-- P0 PRE-BETA — Hidratación de permission overrides en el contrato de perfil
--
-- CAUSA RAÍZ
-- `public.profiles.permissions` (jsonb) guarda los overrides de permisos por
-- usuario. El comentario de la columna es explícito: NULL = usar los defaults
-- del rol; si no, un JSON PARCIAL con las claves conocidas. El escritor
-- (`usersService.updateUserPermissions`, alimentado por `buildOverrideDiff` en
-- src/pages/UsersManagement.tsx) guarda exactamente un DIFF contra los defaults
-- del rol, y `null` cuando no hay diferencia.
--
-- Pero las DOS funciones que hidratan el perfil del usuario autenticado
--     public.get_my_profile()
--     public.link_profile_to_auth_user()   (fallback OAuth por email)
-- declaran un `RETURNS TABLE(...)` que NO incluye esa columna:
--     (id, user_id, business_id, role, is_active, full_name, email, phone,
--      created_at, updated_at)
--
-- Consecuencia: el cliente recibe `profile.permissions === undefined`,
-- `sanitizePermissions()` devuelve "sin overrides" y `resolvePermissions()`
-- cae SIEMPRE a los defaults puros del rol. Los overrides se escriben, se
-- muestran en la matriz de Usuarios (que lee `business_users_view`, la cual sí
-- expone la columna) y nunca vuelven al perfil propio: el contrato quedaba
-- partido entre el escritor y el lector.
--
-- IMPACTO — los overrides eran ignorados POR COMPLETO, en las dos direcciones:
--   · default=false + override=true ignorado -> una capacidad concedida
--     explícitamente quedaba negada;
--   · default=true + override=false ignorado -> una capacidad revocada
--     explícitamente seguía habilitada en el frontend.
-- O sea: el efectivo era siempre el default del rol, que respecto de la
-- INTENCIÓN del administrador puede quedar corto o largo. La autorización
-- server-side seguía dependiendo de sus propios controles independientes (RLS y
-- predicados de las policies); este defecto no evidencia ningún bypass de esos
-- controles, y no se afirma ninguno. Lo que cierra esta migración es el
-- contrato, antes de la beta y antes de que existan overrides vivos.
--
-- POR QUÉ HAY QUE DROPEAR
-- Agregar una columna a un `RETURNS TABLE` cambia el tipo de retorno de la
-- función, y PostgreSQL rechaza eso en `CREATE OR REPLACE`
-- (42P13: "cannot change return type of existing function"). La única vía es
-- DROP + CREATE.
--
-- ⚠️ TRAMPA DEL DROP: `CREATE FUNCTION` nace con `EXECUTE` para `PUBLIC` — es
-- el DEFAULT de PostgreSQL, nunca se escribe en el SQL. El ACL anterior al DROP
-- NO se hereda. Sin re-REVOKE explícito, este archivo reabriría para las dos
-- funciones el vector que cerró la migración 20260804120000
-- (secdef_public_execute_lockdown). Por eso abajo se re-REVOKEa de PUBLIC y de
-- anon y se re-GRANTea SÓLO a `authenticated`.
--
-- CONTRATO DE ACL — se preserva EXACTAMENTE el vigente, medido por catálogo
-- antes de tocar nada:
--     proacl = {postgres=X/postgres, authenticated=X/postgres}
--     PUBLIC=false  anon=false  authenticated=true  service_role=FALSE
-- `service_role` NO tiene EXECUTE hoy y NO se le agrega: estas dos funciones
-- son superficie de sesión de usuario (se apoyan en auth.uid()), no superficie
-- de backend.
--
-- HALLAZGO COLATERAL — link_profile_to_auth_user estaba ROTO en producción
-- Su cuerpo hacía `UPDATE profiles ... WHERE id = v_profile_id`, sin calificar.
-- `id` es también un parámetro OUT del RETURNS TABLE, así que plpgsql
-- (variable_conflict = error, el default) aborta en tiempo de ejecución con
--     ERROR: column reference "id" is ambiguous
-- Medido: reproducido en el stack local y confirmado por catálogo que el cuerpo
-- desplegado en producción es idéntico. El fallo era INVISIBLE porque
-- AuthContext.loadProfile envuelve la llamada en un try/catch que descarta el
-- error y sigue con perfil nulo; el usuario sólo veía "No existe un perfil de
-- negocio para este usuario". O sea: el fallback OAuth por email nunca vinculó
-- nada. Al reescribir la función se calificó el UPDATE con un alias, y el CASO I
-- de tests/sql/permissions_hydration.test.sql asevera que ahora sí vincula.
--
-- LO QUE NO CAMBIA
--   · La semántica de búsqueda del perfil (auth.uid() + fallback por email),
--     el ORDER BY, el LIMIT 1 y el UPDATE de vinculación son idénticos.
--   · El aislamiento por tenant: ninguna de las dos recibe parámetros; ambas se
--     anclan a `auth.uid()` y devuelven a lo sumo UNA fila, la del llamador. No
--     hay forma de pedir el perfil (ni los overrides) de otro usuario o de otro
--     negocio.
--   · La columna `permissions` se devuelve TAL CUAL está guardada. No se
--     normaliza, ni se filtra por claves conocidas, ni se mergea contra los
--     defaults del rol acá: la matriz canónica de permisos vive en
--     src/config/permissions.ts y duplicarla en SQL crearía dos fuentes de
--     verdad que se pueden desincronizar. El servidor entrega el dato crudo; el
--     cliente sanitiza y mergea.
--
-- ENDURECIMIENTO APLICADO DE PASO (sin cambiar comportamiento):
--   · `search_path = pg_catalog, public, pg_temp` — pg_temp AL FINAL. Omitirlo
--     no lo excluye: lo pone PRIMERO (doc PG 5.9.3). El baseline traía
--     `search_path=public` y la barrera de 20260713310000 lo dejó en
--     `public, pg_temp`; acá queda ya en la forma endurecida del repo.
--   · Todas las referencias a relaciones quedan calificadas con schema
--     (`public.profiles`, `auth.users`), así el cuerpo no depende del path.
--
-- Forward-only. Corre dentro de BEGIN/COMMIT explícito: las migraciones de
-- Supabase se aplican en AUTOCOMMIT, así que sin esto el DROP no sería atómico
-- con el CREATE y las postcondiciones de abajo no revertirían nada al fallar.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '60s';

-- ── get_my_profile() ────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_my_profile();

CREATE FUNCTION public.get_my_profile()
RETURNS TABLE(
  id          uuid,
  user_id     uuid,
  business_id uuid,
  role        text,
  is_active   boolean,
  full_name   text,
  email       text,
  phone       text,
  permissions jsonb,
  created_at  timestamp with time zone,
  updated_at  timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_auth_user_id uuid;
  v_auth_email   text;
BEGIN
  v_auth_user_id := auth.uid();

  IF v_auth_user_id IS NULL THEN
    RETURN;
  END IF;

  SELECT lower(u.email)
  INTO v_auth_email
  FROM auth.users u
  WHERE u.id = v_auth_user_id;

  RETURN QUERY
  SELECT
    p.id,
    COALESCE(p.user_id, p.id) AS user_id,
    p.business_id,
    p.role,
    COALESCE(p.is_active, TRUE) AS is_active,
    p.full_name,
    p.email,
    p.phone,
    p.permissions,
    COALESCE(p.created_at, now()) AS created_at,
    COALESCE(p.updated_at, now()) AS updated_at
  FROM public.profiles p
  WHERE COALESCE(p.user_id, p.id) = v_auth_user_id
     OR (
       v_auth_email IS NOT NULL
       AND lower(COALESCE(p.email, '')) = v_auth_email
     )
  ORDER BY
    (p.business_id IS NOT NULL) DESC,
    COALESCE(p.updated_at, p.created_at, now()) DESC
  LIMIT 1;
END;
$$;

ALTER FUNCTION public.get_my_profile() OWNER TO postgres;

COMMENT ON FUNCTION public.get_my_profile() IS
  'Perfil del usuario autenticado (auth.uid(), con fallback por email). Incluye '
  '`permissions`: el JSON PARCIAL de overrides tal como está guardado en '
  'profiles.permissions (NULL = usar defaults del rol). El merge contra los '
  'defaults del rol es del cliente (src/config/permissions.ts), fuente única.';

-- El CREATE de arriba nació con EXECUTE para PUBLIC. Se cierra acá.
REVOKE ALL     ON FUNCTION public.get_my_profile() FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.get_my_profile() FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_my_profile() TO authenticated;

-- ── link_profile_to_auth_user() ─────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.link_profile_to_auth_user();

CREATE FUNCTION public.link_profile_to_auth_user()
RETURNS TABLE(
  id          uuid,
  user_id     uuid,
  business_id uuid,
  role        text,
  is_active   boolean,
  full_name   text,
  email       text,
  phone       text,
  permissions jsonb,
  created_at  timestamp with time zone,
  updated_at  timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_auth_id    uuid;
  v_auth_email text;
  v_profile_id uuid;
BEGIN
  v_auth_id := auth.uid();
  IF v_auth_id IS NULL THEN RETURN; END IF;

  SELECT lower(u.email) INTO v_auth_email
  FROM auth.users u WHERE u.id = v_auth_id;

  IF v_auth_email IS NULL THEN RETURN; END IF;

  -- Buscar profile por email que tenga un user_id distinto
  SELECT p.id INTO v_profile_id
  FROM public.profiles p
  WHERE lower(COALESCE(p.email, '')) = v_auth_email
    AND COALESCE(p.user_id, p.id) <> v_auth_id
  ORDER BY (p.business_id IS NOT NULL) DESC
  LIMIT 1;

  IF v_profile_id IS NULL THEN RETURN; END IF;

  -- Vincular el profile al auth user actual (sin perder business_id).
  -- Alias explícito: `id`, `user_id` y `updated_at` son parámetros OUT del
  -- RETURNS TABLE, así que una referencia sin calificar sería ambigua para
  -- plpgsql (variable_conflict = error por default).
  UPDATE public.profiles AS pr
  SET user_id    = v_auth_id,
      updated_at = now()
  WHERE pr.id = v_profile_id;

  -- Devolver el profile actualizado
  RETURN QUERY
  SELECT
    p.id,
    p.user_id,
    p.business_id,
    p.role::text,
    COALESCE(p.is_active, TRUE),
    p.full_name,
    p.email,
    p.phone,
    p.permissions,
    COALESCE(p.created_at, now()),
    COALESCE(p.updated_at, now())
  FROM public.profiles p
  WHERE p.id = v_profile_id;
END;
$$;

ALTER FUNCTION public.link_profile_to_auth_user() OWNER TO postgres;

COMMENT ON FUNCTION public.link_profile_to_auth_user() IS
  'Fallback OAuth: vincula por email un profile huérfano al auth.uid() actual y '
  'lo devuelve. Mismo contrato de columnas que get_my_profile(), `permissions` '
  'incluida (JSON parcial de overrides, crudo).';

REVOKE ALL     ON FUNCTION public.link_profile_to_auth_user() FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.link_profile_to_auth_user() FROM anon;
GRANT  EXECUTE ON FUNCTION public.link_profile_to_auth_user() TO authenticated;

-- ============================================================================
-- POSTCONDICIONES
--
-- Se leen del CATÁLOGO (pg_proc / has_function_privilege), o sea la función y
-- el ACL EFECTIVOS que quedaron instalados, no el texto que este archivo acaba
-- de mandar. `has_function_privilege` y no `proacl IS NULL`: un proacl NULL
-- significa "defaults de PostgreSQL", que incluyen EXECUTE para PUBLIC — usarlo
-- como prueba de ausencia de permiso es un falso negativo.
-- ============================================================================
DO $$
DECLARE
  v_fn        text;
  v_fns       CONSTANT text[] := ARRAY[
    'public.get_my_profile()',
    'public.link_profile_to_auth_user()'
  ];
  v_oid       oid;
  v_result    text;
  v_cfg       text[];
  v_secdef    boolean;
  v_owner     text;
BEGIN
  FOREACH v_fn IN ARRAY v_fns LOOP
    v_oid := v_fn::regprocedure::oid;

    -- 1. El contrato de columnas incluye `permissions jsonb`.
    v_result := pg_get_function_result(v_oid);
    IF v_result NOT LIKE '%permissions jsonb%' THEN
      RAISE EXCEPTION 'POSTCONDICION 1: % no devuelve `permissions jsonb`. Quedó: %', v_fn, v_result;
    END IF;

    -- 2. No se perdió ninguna columna del contrato anterior.
    IF v_result NOT LIKE '%id uuid%'          OR v_result NOT LIKE '%user_id uuid%'
    OR v_result NOT LIKE '%business_id uuid%' OR v_result NOT LIKE '%role text%'
    OR v_result NOT LIKE '%is_active boolean%' OR v_result NOT LIKE '%full_name text%'
    OR v_result NOT LIKE '%email text%'       OR v_result NOT LIKE '%phone text%'
    OR v_result NOT LIKE '%created_at timestamp with time zone%'
    OR v_result NOT LIKE '%updated_at timestamp with time zone%' THEN
      RAISE EXCEPTION 'POSTCONDICION 2: % perdió una columna del contrato previo. Quedó: %', v_fn, v_result;
    END IF;

    -- 3. Sigue siendo SECURITY DEFINER y propiedad de postgres.
    SELECT p.prosecdef, pg_get_userbyid(p.proowner), p.proconfig
      INTO v_secdef, v_owner, v_cfg
      FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;
    IF NOT v_secdef THEN
      RAISE EXCEPTION 'POSTCONDICION 3: % dejó de ser SECURITY DEFINER.', v_fn;
    END IF;
    IF v_owner <> 'postgres' THEN
      RAISE EXCEPTION 'POSTCONDICION 3: % quedó con owner % (se esperaba postgres).', v_fn, v_owner;
    END IF;

    -- 4. search_path fijo, con pg_temp presente y AL FINAL.
    IF v_cfg IS NULL OR NOT EXISTS (
      SELECT 1 FROM unnest(v_cfg) c WHERE c = 'search_path=pg_catalog, public, pg_temp'
    ) THEN
      RAISE EXCEPTION 'POSTCONDICION 4: % no quedó con search_path=pg_catalog, public, pg_temp. Quedó: %', v_fn, v_cfg;
    END IF;

    -- 5. ACL: el DROP+CREATE no reabrió PUBLIC ni anon.
    IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDICION 5: PUBLIC recuperó EXECUTE sobre % (el default de CREATE FUNCTION). Reabre el vector de 20260804120000.', v_fn;
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDICION 5: anon quedó con EXECUTE sobre %.', v_fn;
    END IF;

    -- 6. ACL: `authenticated` conserva el EXECUTE que ya tenía (si no, el login
    --    de toda la app se cae con 42501).
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDICION 6: authenticated perdió EXECUTE sobre %. Rompe la hidratación del perfil.', v_fn;
    END IF;

    -- 7. ACL: `service_role` NO tenía EXECUTE antes y no debe tenerlo ahora.
    IF has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDICION 7: service_role ganó EXECUTE sobre %, que antes no tenía.', v_fn;
    END IF;
  END LOOP;

  RAISE NOTICE 'Permissions hydration OK: get_my_profile y link_profile_to_auth_user devuelven `permissions`; ACL PUBLIC=no anon=no authenticated=si service_role=no.';
END $$;

COMMIT;

-- ============================================================================
-- ROLLBACK (manual, forward-only por convención del repo)
--   Reponer las dos funciones sin la columna `permissions` desde
--   20260628190324_remote_baseline.sql (líneas 3084 y 3574) y REPETIR los
--   REVOKE/GRANT de arriba: un CREATE de rollback también nace abierto a PUBLIC.
-- ============================================================================
