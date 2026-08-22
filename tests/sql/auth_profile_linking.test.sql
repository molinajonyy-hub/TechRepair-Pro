-- ============================================================================
-- P0 AUTH — Identidad (get_my_profile) vs reparación (link_profile_to_auth_user)
--
-- Corre contra el stack LOCAL o una branch (NUNCA producción), con la migración
-- 20260822160000 aplicada:
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < tests/sql/auth_profile_linking.test.sql
--
--   A  legacy   : id = auth.uid, user_id NULL  -> get devuelve; link innecesario
--   B  canónico : user_id = auth.uid           -> get devuelve
--   C  huérfano : id <> auth.uid, user_id NULL, email match
--                 -> get = 0 filas  Y  link vincula el MISMO profile.id
--   D  post-link: get_my_profile devuelve ese mismo profile
--   E  post-link: current_user_business_id() resuelve
--   F  post-link: current_user_role() resuelve   (+ current_business_id())
--   G  post-link: permissions preservado
--   H  post-link: business_id preservado (y role, e id)
--   I  user_id ya apunta a OTRO uid + email match -> NO relink
--   J  dos huérfanos con el mismo email -> falla cerrado, ninguno modificado
--   K  el email no coincide -> no link
--   L  sin auth.uid -> no link
--   M  PUBLIC y anon no ejecutan
--   N  authenticated sí
--   O  no se crea ningún profile duplicado
--
-- Todo en una transacción que termina en ROLLBACK.
--
-- No se usa `SET LOCAL ROLE` (ver memoria security-gate-pre-m8a): estas
-- funciones son SECURITY DEFINER y corren como su owner igual; lo único que
-- decide qué devuelven es auth.uid(), que se controla con request.jwt.claims.
-- El ACL se verifica por catálogo con has_function_privilege, que además es la
-- fuente de verdad: `proacl IS NULL` significa "defaults de PostgreSQL", que
-- incluyen EXECUTE para PUBLIC, así que sería un falso negativo.
--
-- OJO con los fixtures: `public.profiles.id` es FK a `auth.users(id)`, y el
-- trigger `on_auth_user_created` -> `handle_new_user()` YA crea un profile por
-- cada auth.user. Por eso los perfiles se ACTUALIZAN, no se insertan.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- ── Fixtures ────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_biz      uuid := gen_random_uuid();
  v_legacy   uuid := gen_random_uuid();   -- A
  v_canon    uuid := gen_random_uuid();   -- B
  v_google   uuid := gen_random_uuid();   -- C: el auth user "nuevo"
  v_huerf    uuid := gen_random_uuid();   -- C: dueño del profile huérfano
  v_tomado   uuid := gen_random_uuid();   -- I: profile ya vinculado a otro
  v_otro     uuid := gen_random_uuid();   -- I: esa "otra" identidad
  v_dup_a    uuid := gen_random_uuid();   -- J
  v_dup_b    uuid := gen_random_uuid();   -- J
  v_dup_user uuid := gen_random_uuid();   -- J: quien intenta vincular
  v_sinmatch uuid := gen_random_uuid();   -- K
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (v_legacy,   'apl_legacy@invalid.test'),
    (v_canon,    'apl_canon@invalid.test'),
    (v_google,   'apl_google@invalid.test'),
    (v_huerf,    'apl_huerfano@invalid.test'),
    (v_tomado,   'apl_tomado@invalid.test'),
    (v_otro,     'apl_otro@invalid.test'),
    (v_dup_a,    'apl_dupa@invalid.test'),
    (v_dup_b,    'apl_dupb@invalid.test'),
    (v_dup_user, 'apl_dup@invalid.test'),
    (v_sinmatch, 'apl_sinmatch@invalid.test');

  INSERT INTO public.businesses (id, name, owner_user_id)
  VALUES (v_biz, 'TEST AUTH PROFILE LINKING', v_legacy);

  -- Los perfiles se UPSERTEAN a propósito: el trigger `on_auth_user_created`
  -- -> `handle_new_user()` existe en PRODUCCIÓN pero NO en el stack local (la
  -- función está en las dos, el trigger se creó a mano en prod, como los jobs
  -- de pg_cron). Con ON CONFLICT el fixture queda igual en ambos entornos, en
  -- vez de depender de si el trigger ya insertó la fila.
  INSERT INTO public.profiles (id, user_id, business_id, role, is_active, email, permissions) VALUES
    -- A · legacy: exactamente lo que deja handle_new_user (user_id NULL, id=uid)
    (v_legacy, NULL,    v_biz, 'owner',   true, NULL,                     NULL),
    -- B · canónico: user_id explícito
    (v_canon,  v_canon, v_biz, 'admin',   true, 'apl_canon@invalid.test', NULL),
    -- C · huérfano: lleva el email del auth user "google", con user_id NULL
    (v_huerf,  NULL,    v_biz, 'sales',   true, 'apl_google@invalid.test',
       '{"inventory_view_costs": true}'::jsonb),
    -- I · profile con el email de v_tomado pero user_id apuntando a v_otro
    (v_otro,   v_otro,  v_biz, 'cashier', true, 'apl_tomado@invalid.test', NULL),
    -- J · DOS huérfanos con el mismo email que v_dup_user
    (v_dup_a,  NULL,    v_biz, 'viewer',  true, 'apl_dup@invalid.test',    NULL),
    (v_dup_b,  NULL,    v_biz, 'viewer',  true, 'apl_dup@invalid.test',    NULL)
  ON CONFLICT (id) DO UPDATE SET
    user_id     = EXCLUDED.user_id,
    business_id = EXCLUDED.business_id,
    role        = EXCLUDED.role,
    is_active   = EXCLUDED.is_active,
    email       = EXCLUDED.email,
    permissions = EXCLUDED.permissions;

  -- Estos auth users NO deben tener profile propio: v_google es la identidad
  -- nueva que llega por OAuth, v_tomado y v_dup_user son los que intentan
  -- vincular, y v_sinmatch no tiene nada que le corresponda.
  DELETE FROM public.profiles WHERE id IN (v_google, v_tomado, v_dup_user, v_sinmatch);

  PERFORM set_config('test.biz',      v_biz::text,      false);
  PERFORM set_config('test.legacy',   v_legacy::text,   false);
  PERFORM set_config('test.canon',    v_canon::text,    false);
  PERFORM set_config('test.google',   v_google::text,   false);
  PERFORM set_config('test.huerf',    v_huerf::text,    false);
  PERFORM set_config('test.tomado',   v_tomado::text,   false);
  PERFORM set_config('test.otro',     v_otro::text,     false);
  PERFORM set_config('test.dup_user', v_dup_user::text, false);
  PERFORM set_config('test.sinmatch', v_sinmatch::text, false);
END$$;

-- ── CASO A · legacy (user_id NULL, id = auth.uid) ───────────────────────────
DO $$
DECLARE v_uid text := current_setting('test.legacy'); v_n int; v_id uuid; v_link int;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role','authenticated')::text, true);

  SELECT count(*) INTO v_n FROM public.get_my_profile();
  SELECT g.id INTO v_id FROM public.get_my_profile() g;
  SELECT count(*) INTO v_link FROM public.link_profile_to_auth_user();

  IF v_n <> 1 THEN
    RAISE EXCEPTION 'CASO A: get_my_profile devolvió % filas para un profile legacy. El contrato COALESCE(user_id,id) se rompió.', v_n;
  END IF;
  IF v_id <> v_uid::uuid THEN RAISE EXCEPTION 'CASO A: devolvió otro profile (%)', v_id; END IF;
  IF v_link <> 0 THEN
    RAISE EXCEPTION 'CASO A: link actuó sobre un profile legacy que YA tenía identidad válida (% filas).', v_link;
  END IF;
  IF (SELECT user_id FROM public.profiles WHERE id = v_uid::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'CASO A: se le escribió user_id a un legacy que no lo necesitaba.';
  END IF;

  RAISE NOTICE 'CASO A OK · legacy (user_id NULL, id=uid): get devuelve, link no toca nada';
END$$;

-- ── CASO B · canónico (user_id = auth.uid) ──────────────────────────────────
DO $$
DECLARE v_uid text := current_setting('test.canon'); v_n int; v_role text;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role','authenticated')::text, true);
  SELECT count(*) INTO v_n FROM public.get_my_profile();
  SELECT g.role INTO v_role FROM public.get_my_profile() g;
  IF v_n <> 1 OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'CASO B: get devolvió % filas, role=%', v_n, v_role;
  END IF;
  RAISE NOTICE 'CASO B OK · canónico (user_id=uid): get devuelve el profile';
END$$;

-- ── CASOS C..H · huérfano, link y estado posterior ──────────────────────────
DO $$
DECLARE
  v_uid    text := current_setting('test.google');
  v_huerf  uuid := current_setting('test.huerf')::uuid;
  v_biz    uuid := current_setting('test.biz')::uuid;
  v_n      int;
  v_id     uuid;
  v_uidout uuid;
  v_bizout uuid;
  v_role   text;
  v_perm   jsonb;
  v_help_b uuid;
  v_help_r text;
  v_cbi    uuid;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role','authenticated')::text, true);

  -- C.1 · get_my_profile NO debe resolver por email
  SELECT count(*) INTO v_n FROM public.get_my_profile();
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'CASO C: get_my_profile devolvió % filas para un huérfano. Si resuelve por email, el fallback vuelve a ser INALCANZABLE.', v_n;
  END IF;

  -- Antes del link los helpers no resuelven: es el síntoma que se está cerrando.
  IF public.current_user_business_id() IS NOT NULL THEN
    RAISE EXCEPTION 'CASO C: current_user_business_id() resolvía ANTES del link.';
  END IF;

  -- C.2 · link vincula
  SELECT l.id, l.user_id, l.business_id, l.role, l.permissions
    INTO v_id, v_uidout, v_bizout, v_role, v_perm
  FROM public.link_profile_to_auth_user() l;

  IF v_id IS NULL THEN RAISE EXCEPTION 'CASO C: link no devolvió nada.'; END IF;
  IF v_id <> v_huerf THEN
    RAISE EXCEPTION 'CASO C: link devolvió otro profile.id (% en vez de %)', v_id, v_huerf;
  END IF;
  IF v_uidout <> v_uid::uuid THEN
    RAISE EXCEPTION 'CASO C: user_id quedó en % (se esperaba %)', v_uidout, v_uid;
  END IF;
  IF (SELECT p.user_id FROM public.profiles p WHERE p.id = v_huerf) <> v_uid::uuid THEN
    RAISE EXCEPTION 'CASO C: la fila no quedó vinculada en la tabla.';
  END IF;
  RAISE NOTICE 'CASO C OK · huérfano: get=0 filas y link vincula el MISMO profile.id';

  -- G/H · nada más se tocó
  IF v_bizout <> v_biz THEN RAISE EXCEPTION 'CASO H: cambió business_id (%)', v_bizout; END IF;
  IF v_role <> 'sales' THEN RAISE EXCEPTION 'CASO H: cambió role (%)', v_role; END IF;
  IF v_perm -> 'inventory_view_costs' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'CASO G: se perdieron los permissions (%)', v_perm;
  END IF;
  RAISE NOTICE 'CASO G OK · permissions preservado tras el link';
  RAISE NOTICE 'CASO H OK · business_id, role e id preservados';

  -- D · post-link, get_my_profile devuelve el mismo profile
  SELECT count(*) INTO v_n FROM public.get_my_profile();
  SELECT g.id, g.permissions INTO v_id, v_perm FROM public.get_my_profile() g;
  IF v_n <> 1 OR v_id <> v_huerf THEN
    RAISE EXCEPTION 'CASO D: post-link get devolvió % filas, id=%', v_n, v_id;
  END IF;
  IF v_perm -> 'inventory_view_costs' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'CASO D: post-link get no hidrata permissions.';
  END IF;
  RAISE NOTICE 'CASO D OK · post-link get_my_profile devuelve el mismo profile, con permissions';

  -- E/F · los helpers de RLS resuelven. ESTE es el test que faltaba: una fila
  -- devuelta por get_my_profile NO alcanza para declarar PASS.
  v_help_b := public.current_user_business_id();
  v_help_r := public.current_user_role();
  v_cbi    := public.current_business_id();

  IF v_help_b IS DISTINCT FROM v_biz THEN
    RAISE EXCEPTION 'CASO E: current_user_business_id() = % (se esperaba %)', v_help_b, v_biz;
  END IF;
  IF v_help_r IS DISTINCT FROM 'sales' THEN
    RAISE EXCEPTION 'CASO F: current_user_role() = % (se esperaba sales)', v_help_r;
  END IF;
  IF v_cbi IS DISTINCT FROM v_biz THEN
    RAISE EXCEPTION 'CASO F: current_business_id() = % (se esperaba %). Sin alinearla a COALESCE(user_id,id), la reparación queda a medias y las 96 policies que la usan siguen negando.', v_cbi, v_biz;
  END IF;
  RAISE NOTICE 'CASO E OK · current_user_business_id() resuelve post-link';
  RAISE NOTICE 'CASO F OK · current_user_role() y current_business_id() resuelven post-link';
END$$;

-- ── CASO I · user_id ya apunta a OTRO uid -> NO relink ──────────────────────
DO $$
DECLARE
  v_uid  text := current_setting('test.tomado');
  v_otro uuid := current_setting('test.otro')::uuid;
  v_n    int;
  v_antes uuid;
  v_desp  uuid;
BEGIN
  SELECT p.user_id INTO v_antes FROM public.profiles p WHERE p.id = v_otro;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role','authenticated')::text, true);

  SELECT count(*) INTO v_n FROM public.link_profile_to_auth_user();

  SELECT p.user_id INTO v_desp FROM public.profiles p WHERE p.id = v_otro;

  IF v_n <> 0 THEN
    RAISE EXCEPTION 'CASO I: link reasignó un profile YA vinculado a otra identidad (% filas). Un match de email no puede robar una identidad.', v_n;
  END IF;
  IF v_desp IS DISTINCT FROM v_antes THEN
    RAISE EXCEPTION 'CASO I: cambió el user_id ajeno de % a %', v_antes, v_desp;
  END IF;
  RAISE NOTICE 'CASO I OK · un profile ya vinculado a otro uid NO se reasigna por email';
END$$;

-- ── CASO J · dos huérfanos con el mismo email -> fail-closed ────────────────
DO $$
DECLARE
  v_uid   text := current_setting('test.dup_user');
  v_fallo boolean := false;
  v_state text;
  v_tocados int;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role','authenticated')::text, true);

  BEGIN
    PERFORM * FROM public.link_profile_to_auth_user();
  EXCEPTION WHEN OTHERS THEN
    v_fallo := true;
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
  END;

  IF NOT v_fallo THEN
    RAISE EXCEPTION 'CASO J: con DOS candidatos huérfanos el link no falló: eligió uno al azar.';
  END IF;
  IF v_state <> 'TRLNK' THEN
    RAISE EXCEPTION 'CASO J: falló con SQLSTATE % (se esperaba el controlado TRLNK)', v_state;
  END IF;

  -- Y ninguno de los dos quedó modificado.
  SELECT count(*) INTO v_tocados FROM public.profiles p
   WHERE lower(COALESCE(p.email,'')) = 'apl_dup@invalid.test' AND p.user_id IS NOT NULL;
  IF v_tocados <> 0 THEN
    RAISE EXCEPTION 'CASO J: se modificaron % perfiles pese al fail-closed.', v_tocados;
  END IF;

  RAISE NOTICE 'CASO J OK · dos candidatos -> falla cerrado (TRLNK) y no toca ninguno';
END$$;

-- ── CASOS K/L · sin match y sin sesión ──────────────────────────────────────
DO $$
DECLARE v_uid text := current_setting('test.sinmatch'); v_n int;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role','authenticated')::text, true);
  SELECT count(*) INTO v_n FROM public.link_profile_to_auth_user();
  IF v_n <> 0 THEN RAISE EXCEPTION 'CASO K: link vinculó algo sin email coincidente (% filas)', v_n; END IF;
  RAISE NOTICE 'CASO K OK · sin email coincidente no vincula nada';

  PERFORM set_config('request.jwt.claims', NULL, true);
  SELECT count(*) INTO v_n FROM public.get_my_profile();
  IF v_n <> 0 THEN RAISE EXCEPTION 'CASO L: get devolvió % filas sin auth.uid()', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.link_profile_to_auth_user();
  IF v_n <> 0 THEN RAISE EXCEPTION 'CASO L: link devolvió % filas sin auth.uid()', v_n; END IF;
  RAISE NOTICE 'CASO L OK · sin auth.uid() ninguna de las dos hace nada';
END$$;

-- ── CASOS M/N · ACL por catálogo ────────────────────────────────────────────
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
    IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'CASO M: PUBLIC puede ejecutar %', v_fn; END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'CASO M: anon puede ejecutar %', v_fn; END IF;
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'CASO N: authenticated NO puede ejecutar %', v_fn; END IF;
    IF has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'CASO N: service_role ganó EXECUTE sobre %', v_fn; END IF;
  END LOOP;
  -- current_business_id es helper de RLS: anon SÍ la necesita (si no, 42501).
  IF NOT has_function_privilege('anon', 'public.current_business_id()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'CASO N: anon perdió EXECUTE sobre current_business_id(); rompe las policies.';
  END IF;
  RAISE NOTICE 'CASOS M/N OK · PUBLIC=no anon=no authenticated=si service_role=no; helper de RLS intacta';
END$$;

-- ── CASO O · ningún profile duplicado ───────────────────────────────────────
DO $$
DECLARE v_dup int;
BEGIN
  SELECT count(*) INTO v_dup FROM (
    SELECT p.user_id FROM public.profiles p
     WHERE p.user_id IS NOT NULL
     GROUP BY p.user_id HAVING count(*) > 1
  ) s;
  IF v_dup <> 0 THEN
    RAISE EXCEPTION 'CASO O: hay % user_id con más de un profile.', v_dup;
  END IF;

  SELECT count(*) INTO v_dup FROM public.profiles p
   WHERE lower(COALESCE(p.email,'')) = 'apl_google@invalid.test';
  IF v_dup <> 1 THEN
    RAISE EXCEPTION 'CASO O: el link duplicó el profile del huérfano (% filas).', v_dup;
  END IF;
  RAISE NOTICE 'CASO O OK · sin profiles duplicados por user_id ni por el email vinculado';
END$$;

DO $$ BEGIN RAISE NOTICE 'AUTH PROFILE LINKING — TODOS LOS CASOS SQL OK'; END$$;

ROLLBACK;
