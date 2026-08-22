-- ============================================================================
-- P0 AUTH — Separar IDENTIDAD de REPARACIÓN en el contrato de perfil
--
-- CAUSA RAÍZ
-- `public.get_my_profile()` resolvía el perfil con DOS predicados en OR:
--     COALESCE(p.user_id, p.id) = auth.uid()          <- identidad
--  OR lower(p.email) = <email del auth user>          <- email
--
-- y `AuthContext.loadProfile` sólo llama a `link_profile_to_auth_user()` cuando
-- `get_my_profile()` devuelve CERO filas. El predicado de `link` es
-- `email match AND NOT identity match`, o sea un SUBCONJUNTO ESTRICTO del
-- segundo disyuntor. Conclusión: si `link` fuese a encontrar algo,
-- `get_my_profile` ya lo devolvió y `link` no llega a llamarse nunca.
-- `link_profile_to_auth_user` era, en la práctica, CÓDIGO INALCANZABLE.
--
-- MEDIDO en producción (probe transaccional, escenario OAuth exacto):
--     get_my_profile()              -> 1 fila
--     link_profile_to_auth_user()   -> habría devuelto 1 fila
--     current_user_business_id()    -> NULL
--     current_user_role()           -> NULL
--     current_business_id()         -> NULL
--
-- O sea, el modo de falla NO era "el usuario no puede entrar". El usuario
-- ENTRA: el perfil hidrata por email. Lo que no ocurría era la REPARACIÓN de
-- `profiles.user_id`, y como los helpers de RLS se anclan a `auth.uid()`, la
-- sesión quedaba autenticada con el perfil visible y RLS negando todo: la app
-- carga vacía. Mucho más difícil de diagnosticar que un login bloqueado.
--
-- DECISIÓN DE PRODUCTO — separar responsabilidades:
--   · get_my_profile            = LECTURA de un perfil YA VINCULADO. No escribe.
--   · link_profile_to_auth_user = REPARACIÓN explícita de UN perfil HUÉRFANO.
--
-- ============================================================================
-- LO QUE CAMBIA
--
-- 1. get_my_profile: se le quita el disyuntor por email. Pasa a resolver SÓLO
--    `COALESCE(p.user_id, p.id) = auth.uid()`, que es el contrato canónico que
--    ya usan current_user_business_id() y current_user_role(). Sigue sin
--    escribir nada. Deja de leer auth.users (ya no necesita el email).
--
--    ⚠️ CONTRATO LEGACY PRESERVADO: `handle_new_user()` crea el perfil con
--    `id = new.id` y `user_id` NULL, así que el alta normal cae en
--    COALESCE(NULL, id) = auth.uid() y sigue resolviendo DIRECTAMENTE, sin
--    pasar por el fallback y sin que haga falta escribirle `user_id`.
--    Medido en prod: 10 de 17 perfiles están exactamente en ese estado.
--
-- 2. link_profile_to_auth_user: se endurece.
--    · Sólo actúa sobre perfiles HUÉRFANOS: `user_id IS NULL`. Un perfil con
--      `user_id` ya apuntando a OTRA identidad NO se reasigna aunque el email
--      coincida — un match de email no puede robar una identidad ya vinculada.
--    · Candidato ÚNICO: 0 -> no hace nada; 1 -> vincula; >1 -> falla cerrado
--      con error controlado. No hay `LIMIT 1` silencioso eligiendo por nosotros.
--    · UPDATE atómico: la condición `user_id IS NULL` viaja DENTRO del UPDATE,
--      no sólo en el SELECT previo, para cerrar el TOCTOU.
--    · No toca id, business_id, role, permissions ni created_at.
--
-- 3. current_business_id: se alinea a `COALESCE(user_id, id) = auth.uid()`.
--    Sin esto, la reparación quedaría a medias: tras vincular, `user_id` pasa a
--    ser auth.uid() pero `id` sigue siendo el de otra identidad, y esta función
--    filtraba por `WHERE id = auth.uid()` — habría seguido devolviendo NULL, y
--    con ella las 96 policies que la usan. Las otras dos helpers ya usaban
--    COALESCE, así que este cambio las hace consistentes entre sí.
--
--    ⚠️ ES UN NO-OP SOBRE LOS DATOS ACTUALES, y se verifica en una
--    postcondición: `id = X` y `COALESCE(user_id, id) = X` sólo pueden diferir
--    si existe alguna fila con `user_id IS NOT NULL AND user_id <> id`.
--    Medido en prod: 17 de 17 filas equivalentes, 0 divergentes.
--
-- LO QUE NO CAMBIA
--   · Las tres funciones conservan su FIRMA exacta, así que van por
--     `CREATE OR REPLACE` y NO por DROP+CREATE: el ACL no se resetea y no hay
--     ventana en la que `EXECUTE` vuelva a PUBLIC. Igual se aseveran los ACL
--     abajo, porque el contrato hay que probarlo, no suponerlo.
--   · `permissions jsonb` sigue en las 11 columnas de ambas RPC.
--   · El aislamiento por tenant: ninguna recibe parámetros; todas se anclan a
--     `auth.uid()`.
--   · No se tocan accept_business_invitation, handle_new_user ni
--     bootstrap_owner_profile.
--
-- Forward-only, dentro de BEGIN/COMMIT explícito: las migraciones de Supabase
-- corren en AUTOCOMMIT y sin esto las postcondiciones no revertirían nada.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '60s';

-- ── 1 · get_my_profile: identidad y nada más ────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_my_profile()
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
BEGIN
  v_auth_user_id := auth.uid();

  IF v_auth_user_id IS NULL THEN
    RETURN;
  END IF;

  -- SOLO identidad. El match por email vivía acá y hacía inalcanzable al
  -- fallback de reparación; ahora un huérfano devuelve 0 filas a propósito,
  -- para que AuthContext entre a link_profile_to_auth_user().
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
  ORDER BY
    (p.business_id IS NOT NULL) DESC,
    COALESCE(p.updated_at, p.created_at, now()) DESC
  LIMIT 1;
END;
$$;

COMMENT ON FUNCTION public.get_my_profile() IS
  'LECTURA del perfil del usuario autenticado, resuelto SÓLO por identidad '
  '(COALESCE(user_id, id) = auth.uid()). No escribe y no resuelve por email: '
  'un perfil huérfano devuelve 0 filas a propósito, para que el llamador use '
  'link_profile_to_auth_user(). Incluye `permissions` crudo (NULL = defaults '
  'del rol); el merge es del cliente (src/config/permissions.ts).';

-- Re-aserción EXPLÍCITA del ACL. Sobre una función existente `CREATE OR
-- REPLACE` preserva el ACL, así que esto es un no-op medido; se escribe igual
-- porque sobre una base donde la función NO existiera se comportaría como
-- `CREATE` y nacería con EXECUTE para PUBLIC, que es el default de PostgreSQL.
REVOKE ALL     ON FUNCTION public.get_my_profile() FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.get_my_profile() FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_my_profile() TO authenticated;

-- ── 2 · link_profile_to_auth_user: reparación explícita y acotada ───────────
CREATE OR REPLACE FUNCTION public.link_profile_to_auth_user()
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
  v_auth_id      uuid;
  v_auth_email   text;
  v_profile_id   uuid;
  v_candidatos   integer;
  v_actualizadas integer;
BEGIN
  v_auth_id := auth.uid();
  IF v_auth_id IS NULL THEN RETURN; END IF;

  SELECT lower(btrim(u.email)) INTO v_auth_email
  FROM auth.users u WHERE u.id = v_auth_id;

  IF v_auth_email IS NULL OR v_auth_email = '' THEN RETURN; END IF;

  -- Si el usuario YA tiene identidad resuelta, no hay nada que reparar.
  -- Sin este corte, un usuario normal entraría al conteo de candidatos y un
  -- homónimo de email podría hacerlo fallar sin motivo.
  IF EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE COALESCE(p.user_id, p.id) = v_auth_id
  ) THEN
    RETURN;
  END IF;

  -- Candidatos HUÉRFANOS: user_id IS NULL y email normalizado coincidente.
  -- `user_id IS NULL` es el requisito fuerte: un perfil cuyo user_id ya apunta
  -- a otra identidad NO es candidato, aunque el email coincida.
  SELECT count(*) INTO v_candidatos
  FROM public.profiles p
  WHERE p.user_id IS NULL
    AND lower(btrim(COALESCE(p.email, ''))) = v_auth_email;

  IF v_candidatos = 0 THEN
    RETURN;
  END IF;

  IF v_candidatos > 1 THEN
    -- Fail-closed: `profiles.email` no es único, así que esto es alcanzable.
    -- Elegir uno con LIMIT 1 sería vincular una identidad al azar.
    RAISE EXCEPTION
      'Hay % perfiles huerfanos con ese email; no se vincula ninguno.', v_candidatos
      USING ERRCODE = 'TRLNK';
  END IF;

  SELECT p.id INTO v_profile_id
  FROM public.profiles p
  WHERE p.user_id IS NULL
    AND lower(btrim(COALESCE(p.email, ''))) = v_auth_email;

  -- UPDATE atómico. `user_id IS NULL` viaja DENTRO del UPDATE: entre el SELECT
  -- y el UPDATE otra sesión pudo haberlo vinculado (TOCTOU). Alias explícito
  -- porque `id`, `user_id` y `updated_at` son parámetros OUT del RETURNS TABLE
  -- y una referencia sin calificar sería ambigua para plpgsql.
  UPDATE public.profiles AS pr
     SET user_id    = v_auth_id,
         updated_at = now()
   WHERE pr.id = v_profile_id
     AND pr.user_id IS NULL;

  GET DIAGNOSTICS v_actualizadas = ROW_COUNT;

  IF v_actualizadas <> 1 THEN
    -- Se lo llevó otra sesión. No es un error: no hay nada que devolver.
    RETURN;
  END IF;

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

COMMENT ON FUNCTION public.link_profile_to_auth_user() IS
  'REPARACIÓN explícita: vincula al auth.uid() actual UN perfil HUÉRFANO '
  '(user_id IS NULL) cuyo email coincida. No reasigna perfiles ya vinculados a '
  'otra identidad. Con más de un candidato falla cerrado (SQLSTATE TRLNK) en '
  'vez de elegir al azar. Sólo escribe user_id y updated_at.';

REVOKE ALL     ON FUNCTION public.link_profile_to_auth_user() FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.link_profile_to_auth_user() FROM anon;
GRANT  EXECUTE ON FUNCTION public.link_profile_to_auth_user() TO authenticated;

-- ── 3 · current_business_id: alinear a la identidad canónica ────────────────
--
-- ⚠️ ACL DELIBERADAMENTE INTACTO. Esta función NO recibe REVOKE/GRANT, a
-- diferencia de las dos de arriba. Su `proacl` es NULL (defaults de PostgreSQL,
-- o sea EXECUTE para PUBLIC) y está en la ALLOWLIST_ANON del repo desde
-- 20260804120000: es un helper de RLS derivado de auth.uid(), inerte para quien
-- no tiene sesión, y lo invocan 96 policies.
--
-- MEDIDO en producción (probe transaccional, revertido): cerrarla a PUBLIC y
-- re-otorgarla a anon/authenticated/service_role le sacaría EXECUTE a 26 roles,
-- entre ellos `authenticator`, `supabase_realtime_admin`, `supabase_storage_admin`
-- y `supabase_auth_admin` — subsistemas que evalúan RLS. Eso excede el alcance
-- de este P0 y merece su propio lote, con verificación de realtime y storage.
-- Acá se cambia SÓLO EL CUERPO; `CREATE OR REPLACE` sobre una función existente
-- preserva el ACL, y la postcondición 6 lo asevera.
CREATE OR REPLACE FUNCTION public.current_business_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p.business_id
  FROM public.profiles p
  WHERE COALESCE(p.user_id, p.id) = auth.uid()
  LIMIT 1
$$;

COMMENT ON FUNCTION public.current_business_id() IS
  'business_id del usuario autenticado. Usa COALESCE(user_id, id) = auth.uid(), '
  'la misma identidad canónica que current_user_business_id() y '
  'current_user_role(): sin eso, un perfil reparado por '
  'link_profile_to_auth_user() (user_id = auth.uid() pero id de otra identidad) '
  'seguiría resolviendo NULL y con él las policies que dependen de esta helper.';

-- ============================================================================
-- POSTCONDICIONES — se leen del CATÁLOGO y de los datos, no del texto de arriba.
-- ============================================================================
DO $$
DECLARE
  v_fn        text;
  v_fns       CONSTANT text[] := ARRAY[
    'public.get_my_profile()',
    'public.link_profile_to_auth_user()'
  ];
  v_oid       oid;
  v_src       text;
  v_divergen  integer;
  v_cbi       oid := 'public.current_business_id()'::regprocedure::oid;
BEGIN
  FOREACH v_fn IN ARRAY v_fns LOOP
    v_oid := v_fn::regprocedure::oid;

    -- 1. Sigue devolviendo las 11 columnas, `permissions` incluida.
    IF pg_get_function_result(v_oid) NOT LIKE '%permissions jsonb%' THEN
      RAISE EXCEPTION 'POSTCONDICION 1: % perdió `permissions jsonb`.', v_fn;
    END IF;

    -- 2. SECURITY DEFINER, owner postgres, search_path endurecido.
    IF NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = v_oid) THEN
      RAISE EXCEPTION 'POSTCONDICION 2: % dejó de ser SECURITY DEFINER.', v_fn;
    END IF;
    IF (SELECT pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = v_oid) <> 'postgres' THEN
      RAISE EXCEPTION 'POSTCONDICION 2: % cambió de owner.', v_fn;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p, unnest(p.proconfig) c
      WHERE p.oid = v_oid AND c = 'search_path=pg_catalog, public, pg_temp'
    ) THEN
      RAISE EXCEPTION 'POSTCONDICION 2: % no quedó con el search_path endurecido.', v_fn;
    END IF;

    -- 3. ACL intacto (no hubo DROP, pero el contrato se prueba igual).
    IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDICION 3: PUBLIC puede ejecutar %.', v_fn;
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDICION 3: anon puede ejecutar %.', v_fn;
    END IF;
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDICION 3: authenticated perdió EXECUTE sobre %.', v_fn;
    END IF;
    IF has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDICION 3: service_role ganó EXECUTE sobre %.', v_fn;
    END IF;
  END LOOP;

  -- 4. get_my_profile ya NO resuelve por email ni escribe.
  SELECT p.prosrc INTO v_src FROM pg_catalog.pg_proc p
   WHERE p.oid = 'public.get_my_profile()'::regprocedure::oid;
  IF v_src ~* '\mauth\.users\M' OR v_src ~* '\memail\M\s*=' THEN
    RAISE EXCEPTION 'POSTCONDICION 4: get_my_profile todavía resuelve por email.';
  END IF;
  IF v_src ~* '\m(UPDATE|INSERT|DELETE)\M' THEN
    RAISE EXCEPTION 'POSTCONDICION 4: get_my_profile escribe. Debe ser sólo lectura.';
  END IF;

  -- 5. link exige user_id IS NULL y no elige con LIMIT 1 entre varios.
  SELECT p.prosrc INTO v_src FROM pg_catalog.pg_proc p
   WHERE p.oid = 'public.link_profile_to_auth_user()'::regprocedure::oid;
  IF v_src !~* 'user_id IS NULL' THEN
    RAISE EXCEPTION 'POSTCONDICION 5: link no exige user_id IS NULL.';
  END IF;
  IF v_src !~* 'TRLNK' THEN
    RAISE EXCEPTION 'POSTCONDICION 5: link perdió el fail-closed por candidato múltiple.';
  END IF;

  -- 6. current_business_id sigue ejecutable por anon: 96 policies la invocan y
  --    revocársela devolvería 42501 en vez de 0 filas.
  IF NOT has_function_privilege('anon', v_cbi, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION 6: anon perdió EXECUTE sobre current_business_id(); rompe RLS.';
  END IF;
  IF NOT has_function_privilege('authenticated', v_cbi, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION 6: authenticated perdió EXECUTE sobre current_business_id().';
  END IF;

  -- 7. El cambio de current_business_id es un NO-OP sobre los datos vivos.
  --    `id = X` y `COALESCE(user_id, id) = X` sólo difieren si hay filas con
  --    user_id no nulo distinto de id. Si aparecen, el cambio dejó de ser
  --    inocuo y esta migración NO debe pasar en silencio.
  SELECT count(*) INTO v_divergen
  FROM public.profiles p
  WHERE p.user_id IS NOT NULL AND p.user_id <> p.id;
  IF v_divergen > 0 THEN
    RAISE EXCEPTION
      'POSTCONDICION 7: hay % perfiles con user_id <> id. El cambio de current_business_id deja de ser un no-op: revisar caso por caso antes de aplicar.',
      v_divergen;
  END IF;

  RAISE NOTICE 'Auth profile linking OK: get_my_profile sólo identidad, link acotado a huérfanos con candidato único, current_business_id alineado (no-op sobre % perfiles).',
    (SELECT count(*) FROM public.profiles);
END $$;

COMMIT;

-- ============================================================================
-- ROLLBACK (manual, forward-only por convención del repo)
--   Reponer los tres cuerpos previos desde
--   20260822120000_permissions_hydration_contract.sql (get_my_profile y
--   link_profile_to_auth_user) y desde el baseline 20260628190324
--   (current_business_id). Al ser CREATE OR REPLACE, el ACL no se toca.
--   OJO: volver atrás reintroduce la inalcanzabilidad del fallback.
-- ============================================================================
