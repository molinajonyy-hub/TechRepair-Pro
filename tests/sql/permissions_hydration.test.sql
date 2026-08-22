-- ============================================================================
-- P0 PRE-BETA — Hidratación de permission overrides
--
-- Corre contra el stack LOCAL o una branch (NUNCA producción), con la migración
-- 20260822120000 aplicada:
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < tests/sql/permissions_hydration.test.sql
--
--   CASO A  Sin overrides, rol owner: el servidor entrega role+permissions NULL
--           y el espejo SQL de settings_sensitive (is_owner_or_admin) da TRUE.
--   CASO B  Ídem con rol viewer: espejo FALSE.
--   CASO C  Default del rol FALSE + override TRUE -> el servidor devuelve el
--           override (antes se perdía y el cliente caía al default).
--   CASO D  Default del rol TRUE + override FALSE -> el servidor devuelve el
--           override. Este es el caso peligroso: una RESTRICCIÓN ignorada.
--   CASO E  Aislamiento por tenant: el usuario del negocio B nunca ve el perfil
--           ni los overrides del negocio A.
--   CASO F  anon NO puede ejecutar ninguna de las dos RPC.
--   CASO G  PUBLIC NO puede ejecutar ninguna de las dos RPC.
--   CASO H  authenticated SÍ puede (si no, se cae el login de toda la app).
--   CASO I  link_profile_to_auth_user (fallback OAuth) también hidrata los
--           overrides: es la otra puerta de entrada al mismo contrato.
--   CASO J  Ambas devuelven a lo sumo UNA fila y siempre la del llamador.
--
-- Todo en una transacción; termina en ROLLBACK (no deja fixtures).
--
-- Los CASOS F/G/H se verifican por CATÁLOGO con has_function_privilege, que es
-- la fuente de verdad del ACL. No se usa `proacl IS NULL` como prueba de
-- ausencia de permiso: un proacl NULL significa "defaults de PostgreSQL", que
-- incluyen EXECUTE para PUBLIC — sería un falso negativo.
--
-- Los CASOS A/B NO reimplementan la matriz de permisos en SQL: la matriz
-- canónica vive en src/config/permissions.ts y duplicarla acá crearía dos
-- fuentes de verdad. Se verifica (a) que el servidor entregue los INSUMOS que
-- el cliente necesita (role + permissions crudo) y (b) el único espejo SQL que
-- el repo ya declara de `settings_sensitive`: public.is_owner_or_admin(), que
-- 20260819120000 documenta como el reflejo exacto de ese default. El booleano
-- resuelto se asevera en la suite de frontend (tests I..N de usePermissions).
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- ── Fixtures ────────────────────────────────────────────────────────────────
-- Dos negocios independientes. profiles.id es FK a auth.users(id), así que el
-- id del profile tiene que ser el del auth user.
DO $$
DECLARE
  v_biz_a      uuid := gen_random_uuid();
  v_biz_b      uuid := gen_random_uuid();
  v_owner_a    uuid := gen_random_uuid();
  v_viewer_a   uuid := gen_random_uuid();
  v_admin_a    uuid := gen_random_uuid();
  v_owner_b    uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (v_owner_a,  'ph_owner_a@example.test'),
    (v_viewer_a, 'ph_viewer_a@example.test'),
    (v_admin_a,  'ph_admin_a@example.test'),
    (v_owner_b,  'ph_owner_b@example.test');

  INSERT INTO public.businesses (id, name, owner_user_id) VALUES
    (v_biz_a, 'TEST PERM HYDRATION A', v_owner_a),
    (v_biz_b, 'TEST PERM HYDRATION B', v_owner_b);

  INSERT INTO public.profiles (id, user_id, business_id, role, is_active, email, permissions) VALUES
    -- A: owner sin overrides (CASO A)
    (v_owner_a,  v_owner_a,  v_biz_a, 'owner',  true, 'ph_owner_a@example.test',  NULL),
    -- A: viewer con un override que AMPLÍA sobre un default false (CASO C)
    --    viewer.finance = false por default; el override lo pone en true.
    (v_viewer_a, v_viewer_a, v_biz_a, 'viewer', true, 'ph_viewer_a@example.test',
       '{"finance": true}'::jsonb),
    -- A: admin con un override que RESTRINGE sobre un default true (CASO D)
    --    admin.settings_sensitive = true por default; el override lo apaga.
    (v_admin_a,  v_admin_a,  v_biz_a, 'admin',  true, 'ph_admin_a@example.test',
       '{"settings_sensitive": false}'::jsonb),
    -- B: owner de otro tenant, sin overrides (CASO E)
    (v_owner_b,  v_owner_b,  v_biz_b, 'owner',  true, 'ph_owner_b@example.test', NULL);

  PERFORM set_config('test.biz_a',    v_biz_a::text,    false);
  PERFORM set_config('test.biz_b',    v_biz_b::text,    false);
  PERFORM set_config('test.owner_a',  v_owner_a::text,  false);
  PERFORM set_config('test.viewer_a', v_viewer_a::text, false);
  PERFORM set_config('test.admin_a',  v_admin_a::text,  false);
  PERFORM set_config('test.owner_b',  v_owner_b::text,  false);
END$$;

-- ── CASO A · owner sin overrides ────────────────────────────────────────────
DO $$
DECLARE
  v_uid  text := current_setting('test.owner_a');
  v_role text;
  v_perm jsonb;
  v_sens boolean;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  SELECT g.role, g.permissions INTO v_role, v_perm FROM public.get_my_profile() g;
  v_sens := public.is_owner_or_admin();

  RESET ROLE;

  IF v_role <> 'owner' THEN
    RAISE EXCEPTION 'CASO A: el servidor devolvió role=% (se esperaba owner)', v_role;
  END IF;
  IF v_perm IS NOT NULL THEN
    RAISE EXCEPTION 'CASO A: sin overrides, permissions debía venir NULL. Vino: %', v_perm;
  END IF;
  IF NOT v_sens THEN
    RAISE EXCEPTION 'CASO A: el espejo SQL de settings_sensitive dio FALSE para owner.';
  END IF;

  RAISE NOTICE 'CASO A OK · owner sin overrides: role=owner, permissions NULL, settings_sensitive=true';
END$$;

-- ── CASO B · viewer y el default de settings_sensitive ──────────────────────
DO $$
DECLARE
  v_uid  text := current_setting('test.viewer_a');
  v_role text;
  v_sens boolean;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  SELECT g.role INTO v_role FROM public.get_my_profile() g;
  v_sens := public.is_owner_or_admin();

  RESET ROLE;

  IF v_role <> 'viewer' THEN
    RAISE EXCEPTION 'CASO B: el servidor devolvió role=% (se esperaba viewer)', v_role;
  END IF;
  IF v_sens THEN
    RAISE EXCEPTION 'CASO B: el espejo SQL de settings_sensitive dio TRUE para viewer.';
  END IF;

  RAISE NOTICE 'CASO B OK · viewer: settings_sensitive=false';
END$$;

-- ── CASO C · default FALSE + override TRUE ──────────────────────────────────
DO $$
DECLARE
  v_uid  text := current_setting('test.viewer_a');
  v_perm jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  SELECT g.permissions INTO v_perm FROM public.get_my_profile() g;

  RESET ROLE;

  IF v_perm IS NULL THEN
    RAISE EXCEPTION 'CASO C: el override se perdió — permissions vino NULL. Este es EXACTAMENTE el defecto que cierra 20260822120000.';
  END IF;
  IF v_perm -> 'finance' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'CASO C: se esperaba finance=true en el override. Vino: %', v_perm;
  END IF;
  -- El payload es un DIFF, no la matriz completa: no debe traer claves de más.
  IF (SELECT count(*) FROM jsonb_object_keys(v_perm)) <> 1 THEN
    RAISE EXCEPTION 'CASO C: el servidor devolvió algo distinto del diff guardado. Vino: %', v_perm;
  END IF;

  RAISE NOTICE 'CASO C OK · viewer + {finance:true}: el servidor entrega el override';
END$$;

-- ── CASO D · default TRUE + override FALSE (restricción) ────────────────────
DO $$
DECLARE
  v_uid  text := current_setting('test.admin_a');
  v_role text;
  v_perm jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  SELECT g.role, g.permissions INTO v_role, v_perm FROM public.get_my_profile() g;

  RESET ROLE;

  IF v_role <> 'admin' THEN
    RAISE EXCEPTION 'CASO D: role=% (se esperaba admin)', v_role;
  END IF;
  IF v_perm IS NULL THEN
    RAISE EXCEPTION 'CASO D: la RESTRICCIÓN se perdió — permissions vino NULL. Un admin seguiría viendo settings_sensitive.';
  END IF;
  IF v_perm -> 'settings_sensitive' IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'CASO D: se esperaba settings_sensitive=false. Vino: %', v_perm;
  END IF;

  RAISE NOTICE 'CASO D OK · admin + {settings_sensitive:false}: el servidor entrega la restricción';
END$$;

-- ── CASO E · aislamiento por tenant ─────────────────────────────────────────
DO $$
DECLARE
  v_uid    text := current_setting('test.owner_b');
  v_biz_b  uuid := current_setting('test.biz_b')::uuid;
  v_id     uuid;
  v_biz    uuid;
  v_perm   jsonb;
  v_filas  int;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  SELECT count(*) INTO v_filas FROM public.get_my_profile();
  SELECT g.id, g.business_id, g.permissions INTO v_id, v_biz, v_perm FROM public.get_my_profile() g;

  RESET ROLE;

  IF v_filas <> 1 THEN
    RAISE EXCEPTION 'CASO E: get_my_profile devolvió % filas para el usuario del tenant B', v_filas;
  END IF;
  IF v_biz <> v_biz_b THEN
    RAISE EXCEPTION 'CASO E: el usuario de B recibió el perfil del negocio % (se esperaba %)', v_biz, v_biz_b;
  END IF;
  IF v_id <> v_uid::uuid THEN
    RAISE EXCEPTION 'CASO E: el usuario de B recibió el perfil ajeno %', v_id;
  END IF;
  IF v_perm IS NOT NULL THEN
    RAISE EXCEPTION 'CASO E: el usuario de B (sin overrides) recibió overrides: %. Fuga desde el tenant A.', v_perm;
  END IF;

  RAISE NOTICE 'CASO E OK · tenant B no ve el perfil ni los overrides del tenant A';
END$$;

-- ── CASOS F/G/H · ACL por catálogo ──────────────────────────────────────────
DO $$
DECLARE
  v_fn  text;
  v_fns CONSTANT text[] := ARRAY[
    'public.get_my_profile()',
    'public.link_profile_to_auth_user()'
  ];
  v_oid oid;
BEGIN
  FOREACH v_fn IN ARRAY v_fns LOOP
    v_oid := v_fn::regprocedure::oid;

    -- CASO F
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'CASO F: anon puede ejecutar %', v_fn;
    END IF;

    -- CASO G · el DROP+CREATE de la migración nace con EXECUTE a PUBLIC;
    -- si el REVOKE se cayera del archivo, esta línea lo caza.
    IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'CASO G: PUBLIC puede ejecutar % (default de CREATE FUNCTION sin REVOKE)', v_fn;
    END IF;

    -- CASO H
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'CASO H: authenticated NO puede ejecutar %. Rompe el login.', v_fn;
    END IF;

    -- El contrato vigente NO incluye service_role; que no se cuele.
    IF has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'CASO H: service_role ganó EXECUTE sobre %, que no tenía.', v_fn;
    END IF;
  END LOOP;

  RAISE NOTICE 'CASOS F/G/H OK · PUBLIC=no anon=no authenticated=si service_role=no';
END$$;

-- ── CASO I · el fallback OAuth también hidrata overrides ────────────────────
-- link_profile_to_auth_user vincula por email un profile cuyo user_id NO es el
-- del auth user actual. Se fabrica esa situación: un profile con overrides y
-- user_id desapareado, y un auth user nuevo con el mismo email.
DO $$
DECLARE
  v_biz_a    uuid := current_setting('test.biz_a')::uuid;
  v_huerfano uuid := gen_random_uuid();
  v_nuevo    uuid := gen_random_uuid();
  v_perm     jsonb;
  v_uid_out  uuid;
BEGIN
  -- auth.users tiene un índice único parcial por email, así que los dos auth
  -- users llevan emails distintos. El match del fallback NO es contra
  -- auth.users: es entre el email del auth user actual y `profiles.email`.
  INSERT INTO auth.users (id, email) VALUES
    (v_huerfano, 'ph_oauth_huerfano@example.test'),
    (v_nuevo,    'ph_oauth@example.test');

  -- Perfil HUÉRFANO: `user_id IS NULL` (desde 20260822160000 ése es el
  -- requisito fuerte del fallback — un perfil ya vinculado a otra identidad no
  -- se reasigna aunque coincida el email). `profiles.email` es el del auth user
  -- NUEVO, que es por donde engancha la vinculación.
  INSERT INTO public.profiles (id, user_id, business_id, role, is_active, email, permissions)
  VALUES (v_huerfano, NULL, v_biz_a, 'sales', true, 'ph_oauth@example.test',
          '{"inventory_view_costs": true}'::jsonb);

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_nuevo::text, 'role', 'authenticated')::text, true);

  SELECT l.permissions, l.user_id INTO v_perm, v_uid_out
  FROM public.link_profile_to_auth_user() l;

  RESET ROLE;

  IF v_uid_out IS DISTINCT FROM v_nuevo THEN
    RAISE EXCEPTION 'CASO I: link_profile_to_auth_user no vinculó el profile al auth user actual. user_id=%', v_uid_out;
  END IF;
  IF v_perm IS NULL THEN
    RAISE EXCEPTION 'CASO I: el fallback OAuth perdió los overrides (permissions NULL).';
  END IF;
  IF v_perm -> 'inventory_view_costs' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'CASO I: overrides inesperados en el fallback OAuth: %', v_perm;
  END IF;

  RAISE NOTICE 'CASO I OK · link_profile_to_auth_user hidrata overrides y vincula el user_id';
END$$;

-- ── CASO J · sin sesión, ninguna de las dos devuelve nada ───────────────────
-- Ambas se anclan a auth.uid(); sin claims no hay perfil que hidratar. Es la
-- otra mitad del aislamiento: no existe forma de pedir "el perfil de otro".
DO $$
DECLARE
  v_a int;
  v_b int;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', NULL, true);

  SELECT count(*) INTO v_a FROM public.get_my_profile();
  SELECT count(*) INTO v_b FROM public.link_profile_to_auth_user();

  RESET ROLE;

  IF v_a <> 0 THEN
    RAISE EXCEPTION 'CASO J: get_my_profile devolvió % filas sin auth.uid()', v_a;
  END IF;
  IF v_b <> 0 THEN
    RAISE EXCEPTION 'CASO J: link_profile_to_auth_user devolvió % filas sin auth.uid()', v_b;
  END IF;

  RAISE NOTICE 'CASO J OK · sin auth.uid() ninguna de las dos hidrata nada';
END$$;

DO $$ BEGIN RAISE NOTICE 'PERMISSIONS HYDRATION — TODOS LOS CASOS SQL OK'; END$$;

ROLLBACK;
