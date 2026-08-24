-- ============================================================================
-- P0-P1 FASE B — La confirmación de identidad NO provisiona
--
-- Corre contra el stack LOCAL o una branch (NUNCA producción), con la
-- migración 20260823180000 aplicada:
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < tests/sql/provisioning_decoupled_from_auth.test.sql
--
--   A  INSERT sin confirmar          -> 0 business, 0 profile
--   B  INSERT ya confirmado (Google) -> 0 business, 0 profile
--   C  UPDATE de email_confirmed_at  -> 0 business, 0 profile, Y LA
--                                       CONFIRMACIÓN PERSISTE
--   D  metadata hostil               -> no impide confirmar, no crea rol
--                                       arbitrario, no crea business
--   E  catálogo: sin triggers de provisioning en auth.users
--   F  catálogo: handle_new_user y bootstrap_owner_profile retiradas
--   G  catálogo: una sola autoridad creadora de businesses
--   H  authenticated NO puede ejecutar bootstrap_owner_profile
--   I  el camino canónico SIGUE funcionando (si se rompiera, apagar el
--      trigger habría dejado a los owners nuevos sin salida)
--
-- El caso D es el que más importa: `handle_new_user` leía
-- `raw_user_meta_data->>'role'`, escrito por el navegador. Un valor fuera del
-- CHECK de `profiles.role` abortaba la transacción del UPDATE y el usuario
-- quedaba SIN PODER CONFIRMAR NUNCA MÁS. Acá se prueba que ese acoplamiento ya
-- no existe.
--
-- Todo en una transacción que termina en ROLLBACK.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- ── CASO A · INSERT sin confirmar ───────────────────────────────────────────
DO $$
DECLARE
  v_uid  uuid := gen_random_uuid();
  v_b0   integer;
  v_b1   integer;
  v_n    integer;
BEGIN
  SELECT count(*) INTO v_b0 FROM public.businesses;

  INSERT INTO auth.users (id, email, email_confirmed_at)
  VALUES (v_uid, 'pda_sin_confirmar@invalid.test', NULL);

  SELECT count(*) INTO v_n FROM public.profiles p WHERE p.id = v_uid OR p.user_id = v_uid;
  IF v_n <> 0 THEN RAISE EXCEPTION 'A: se creo un profile (n=%)', v_n; END IF;

  SELECT count(*) INTO v_b1 FROM public.businesses;
  IF v_b1 <> v_b0 THEN RAISE EXCEPTION 'A: se creo un business (% -> %)', v_b0, v_b1; END IF;

  RAISE NOTICE 'A OK · INSERT sin confirmar no provisiona';
END $$;

-- ── CASO B · INSERT YA confirmado (el camino de Google OAuth) ───────────────
DO $$
DECLARE
  v_uid  uuid := gen_random_uuid();
  v_b0   integer;
  v_b1   integer;
  v_n    integer;
BEGIN
  SELECT count(*) INTO v_b0 FROM public.businesses;

  -- Google llega con el timestamp ya poblado desde el INSERT. Antes esto
  -- disparaba provisioning inmediato; ahora no debe crear nada.
  INSERT INTO auth.users (id, email, email_confirmed_at)
  VALUES (v_uid, 'pda_google@invalid.test', now());

  SELECT count(*) INTO v_n FROM public.profiles p WHERE p.id = v_uid OR p.user_id = v_uid;
  IF v_n <> 0 THEN RAISE EXCEPTION 'B: un INSERT confirmado provisiono (n=%)', v_n; END IF;

  SELECT count(*) INTO v_b1 FROM public.businesses;
  IF v_b1 <> v_b0 THEN RAISE EXCEPTION 'B: se creo un business (% -> %)', v_b0, v_b1; END IF;

  RAISE NOTICE 'B OK · Google (INSERT confirmado) no provisiona';
END $$;

-- ── CASO C · UPDATE de email_confirmed_at: sin provisioning, CON confirmación ─
DO $$
DECLARE
  v_uid   uuid := gen_random_uuid();
  v_b0    integer;
  v_b1    integer;
  v_n     integer;
  v_conf  timestamptz;
BEGIN
  SELECT count(*) INTO v_b0 FROM public.businesses;

  INSERT INTO auth.users (id, email, email_confirmed_at)
  VALUES (v_uid, 'pda_confirma@invalid.test', NULL);

  UPDATE auth.users SET email_confirmed_at = now() WHERE id = v_uid;

  SELECT count(*) INTO v_n FROM public.profiles p WHERE p.id = v_uid OR p.user_id = v_uid;
  IF v_n <> 0 THEN RAISE EXCEPTION 'C: confirmar provisiono (n=%)', v_n; END IF;

  SELECT count(*) INTO v_b1 FROM public.businesses;
  IF v_b1 <> v_b0 THEN RAISE EXCEPTION 'C: confirmar creo un business'; END IF;

  -- Y lo más importante: la confirmación SÍ quedó escrita.
  SELECT u.email_confirmed_at INTO v_conf FROM auth.users u WHERE u.id = v_uid;
  IF v_conf IS NULL THEN
    RAISE EXCEPTION 'C: la confirmacion NO persistio';
  END IF;

  RAISE NOTICE 'C OK · confirmar no provisiona y la confirmacion persiste';
END $$;

-- ── CASO D · metadata hostil no puede trabar la confirmación ────────────────
DO $$
DECLARE
  v_uid   uuid := gen_random_uuid();
  v_conf  timestamptz;
  v_n     integer;
  v_b0    integer;
  v_b1    integer;
BEGIN
  SELECT count(*) INTO v_b0 FROM public.businesses;

  -- 'superadmin' NO está en el CHECK de profiles.role. Con el contrato viejo
  -- esto reventaba DENTRO de la transaccion del UPDATE y dejaba al usuario sin
  -- poder confirmar jamas.
  INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data)
  VALUES (v_uid, 'pda_hostil@invalid.test', NULL,
          '{"role":"superadmin","business_name":"Inyectado","full_name":"X"}'::jsonb);

  UPDATE auth.users SET email_confirmed_at = now() WHERE id = v_uid;

  SELECT u.email_confirmed_at INTO v_conf FROM auth.users u WHERE u.id = v_uid;
  IF v_conf IS NULL THEN
    RAISE EXCEPTION 'D: la metadata hostil impidio confirmar el correo';
  END IF;

  SELECT count(*) INTO v_n FROM public.profiles p WHERE p.id = v_uid OR p.user_id = v_uid;
  IF v_n <> 0 THEN RAISE EXCEPTION 'D: la metadata hostil creo un profile'; END IF;

  SELECT count(*) INTO v_b1 FROM public.businesses;
  IF v_b1 <> v_b0 THEN RAISE EXCEPTION 'D: la metadata hostil creo un business'; END IF;

  IF EXISTS (SELECT 1 FROM public.businesses b WHERE b.name = 'Inyectado') THEN
    RAISE EXCEPTION 'D: la metadata definio el nombre de un negocio';
  END IF;

  RAISE NOTICE 'D OK · metadata hostil: confirma igual, no crea nada, no define rol';
END $$;

-- ── CASO E/F/G · catálogo ───────────────────────────────────────────────────
DO $$
DECLARE v_n integer;
BEGIN
  -- E: ningun trigger de auth.users escribe profiles/businesses.
  SELECT count(*) INTO v_n
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE NOT t.tgisinternal AND n.nspname = 'auth' AND c.relname = 'users'
     AND p.prosrc ~* 'insert\s+into\s+("?public"?\.)?"?(profiles|businesses)"?';
  IF v_n <> 0 THEN RAISE EXCEPTION 'E: quedan % triggers que provisionan', v_n; END IF;
  RAISE NOTICE 'E OK · auth.users sin triggers de provisioning';

  -- F: las dos funciones retiradas.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('handle_new_user', 'bootstrap_owner_profile');
  IF v_n <> 0 THEN RAISE EXCEPTION 'F: sobreviven % funciones legacy', v_n; END IF;
  RAISE NOTICE 'F OK · handle_new_user y bootstrap_owner_profile retiradas';

  -- G: una sola autoridad creadora, contada por comportamiento.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosrc ~* 'insert\s+into\s+("?public"?\.)?"?businesses"?';
  IF v_n <> 1 THEN RAISE EXCEPTION 'G: hay % funciones que crean businesses, debe haber 1', v_n; END IF;
  RAISE NOTICE 'G OK · una sola autoridad creadora de businesses';
END $$;

-- ── CASO H · authenticated no alcanza la RPC legacy ─────────────────────────
DO $$
DECLARE v_ok boolean := false;
BEGIN
  -- Retirada: ni siquiera se puede resolver el nombre. Se prueba por el
  -- comportamiento REAL de un cliente, no sólo por catálogo.
  BEGIN
    EXECUTE $q$ SELECT public.bootstrap_owner_profile('x@y.z', 'Hackeado', NULL) $q$;
    RAISE EXCEPTION 'H: bootstrap_owner_profile todavia es invocable';
  EXCEPTION
    WHEN undefined_function THEN v_ok := true;
    WHEN insufficient_privilege THEN v_ok := true;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'H: no se obtuvo el rechazo esperado'; END IF;
  RAISE NOTICE 'H OK · bootstrap_owner_profile inalcanzable';
END $$;

-- ── CASO I · el camino canónico sigue vivo ──────────────────────────────────
-- Si esto fallara, apagar los triggers habría dejado a los owners nuevos sin
-- ninguna forma de crear su negocio. Es la contraparte imprescindible.
DO $$
DECLARE
  v_uid  uuid := gen_random_uuid();
  v_res  jsonb;
  v_role text;
  v_own  uuid;
  v_n    integer;
BEGIN
  INSERT INTO auth.users (id, email, email_confirmed_at)
  VALUES (v_uid, 'pda_owner_nuevo@invalid.test', now());

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  v_res := public.provision_my_business('Taller Post Fase B');
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);

  IF (v_res->>'created')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'I: la RPC no creo el negocio (%)', v_res;
  END IF;

  SELECT count(*) INTO v_n FROM public.profiles p WHERE p.id = v_uid;
  IF v_n <> 1 THEN RAISE EXCEPTION 'I: se esperaba 1 profile, hubo %', v_n; END IF;

  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = v_uid;
  IF v_role <> 'owner' THEN RAISE EXCEPTION 'I: rol % en vez de owner', v_role; END IF;

  SELECT b.owner_user_id INTO v_own FROM public.businesses b WHERE b.id = (v_res->>'business_id')::uuid;
  IF v_own <> v_uid THEN RAISE EXCEPTION 'I: owner_user_id incorrecto'; END IF;

  RAISE NOTICE 'I OK · un owner nuevo SI puede crear su negocio por el camino canonico';
END $$;

DO $$ BEGIN RAISE NOTICE 'provisioning_decoupled_from_auth: TODOS LOS CASOS OK'; END $$;

ROLLBACK;
