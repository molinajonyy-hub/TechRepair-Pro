-- ============================================================================
-- P0-P1 — Contrato de `provision_my_business()`
--
-- Corre contra el stack LOCAL o una branch (NUNCA producción), con la
-- migración 20260823150000 aplicada:
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < tests/sql/canonical_owner_provisioning.test.sql
--
--   A  COMPAT FASE A: si el trigger viejo sigue vivo, la RPC devuelve el
--      negocio que él creó y NO fabrica un segundo tenant.
--   B  Sin sesión                      -> 42501
--   C  Correo sin confirmar            -> EMAIL_NOT_CONFIRMED, cero escrituras
--   D  Owner confirmado                -> 1 business, 1 profile, id = auth.uid(),
--                                         role owner, owner_user_id, email, trial
--   E  Segunda llamada                 -> mismo business, no duplica
--   F  Perfil no-owner existente       -> NO cambia role ni business_id
--   G  Invitación pending vigente      -> INVITATION_PENDING (TRINV)
--   H  Invitación vencida              -> NO bloquea
--   I  Invitación ya aceptada          -> NO bloquea
--   J  Metadata hostil (`role`)        -> sin efecto estructural
--   K  Nombre: se respeta el provisto y se acota; vacío -> 'Mi Negocio'
--   L  Catálogo: ACL, anon sin EXECUTE, cero DML estructural para el cliente
--
-- INDEPENDIENTE DE FASE. Los casos B..K necesitan que el provisioning
-- automático NO esté corriendo. Para poder medir el contrato real tanto antes
-- como después de la fase B, el test DESACTIVA los triggers de `auth.users`
-- dentro de la transacción (DDL transaccional en PostgreSQL) y el ROLLBACK
-- final los repone. En un stack donde la fase B ya se aplicó, simplemente no
-- hay nada que desactivar y el caso A se saltea.
--
-- Todo en una transacción que termina en ROLLBACK: no se commitea ninguna
-- mutación.
--
-- OJO: `public.profiles.id` es FK a `auth.users(id)`. Los fixtures insertan
-- auth users de verdad; es justamente la restricción que rompía a las RPC
-- viejas y la que este contrato respeta pasando `id` explícito.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- ── Detección de fase ───────────────────────────────────────────────────────
DO $$
DECLARE v_fase_a boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT t.tgisinternal AND n.nspname = 'auth' AND c.relname = 'users'
       AND t.tgname IN ('on_auth_user_created', 'on_auth_user_email_confirmed')
  ) INTO v_fase_a;
  PERFORM set_config('test.fase_a', v_fase_a::text, false);
  RAISE NOTICE 'Fase detectada: %', CASE WHEN v_fase_a THEN 'A (triggers vivos)' ELSE 'B (triggers retirados)' END;
END $$;

-- ── CASO A · COMPAT de la fase A ────────────────────────────────────────────
-- La propiedad que hace seguro el rollout: con el trigger todavía activo, la
-- RPC encuentra lo que él creó y lo devuelve sin duplicar.
DO $$
DECLARE
  v_uid       uuid := gen_random_uuid();
  v_biz_trig  uuid;
  v_res       jsonb;
  v_n         integer;
  v_rol       text;
BEGIN
  IF current_setting('test.fase_a')::boolean IS NOT TRUE THEN
    RAISE NOTICE 'A: salteado (fase B, no hay trigger que compatibilizar)';
    RETURN;
  END IF;

  INSERT INTO auth.users (id, email, email_confirmed_at)
  VALUES (v_uid, 'cop_compat@invalid.test', now());

  SELECT p.business_id, p.role INTO v_biz_trig, v_rol
    FROM public.profiles p WHERE p.id = v_uid;

  IF v_biz_trig IS NULL THEN
    RAISE EXCEPTION 'A(setup): el trigger de fase A no provisiono';
  END IF;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  v_res := public.provision_my_business('Otro Nombre Distinto');
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);

  IF (v_res->>'created')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'A: la RPC dijo created=true sobre un tenant que ya existia';
  END IF;
  IF (v_res->>'business_id')::uuid <> v_biz_trig THEN
    RAISE EXCEPTION 'A: la RPC devolvio otro business (% vs %)', v_res->>'business_id', v_biz_trig;
  END IF;

  SELECT count(*) INTO v_n FROM public.profiles p WHERE COALESCE(p.user_id, p.id) = v_uid;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'A: hay % perfiles para el mismo usuario', v_n;
  END IF;

  -- El nombre provisto NO debe pisar el del negocio existente: la RPC no
  -- reescribe un tenant ajeno a su acto de creación.
  SELECT count(*) INTO v_n FROM public.businesses b
   WHERE b.id = v_biz_trig AND b.name = 'Otro Nombre Distinto';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'A: la RPC renombro un negocio existente';
  END IF;

  RAISE NOTICE 'A OK · compat fase A: devuelve el existente, no duplica, no renombra';
END $$;

-- ── Retirar el provisioning automático para medir el contrato canónico ──────
-- DDL transaccional: el ROLLBACK final los repone. No se commitea nada.
--
-- Es DROP y no `ALTER TABLE ... DISABLE TRIGGER` porque DISABLE exige ser dueño
-- de la tabla y `auth.users` pertenece a `supabase_auth_admin`, no a `postgres`
-- (medido). DROP sí está permitido, que es además la prueba anticipada de que
-- la fase B va a poder retirarlos con el mismo rol con el que corren las
-- migraciones.
DO $$
BEGIN
  IF current_setting('test.fase_a')::boolean THEN
    EXECUTE 'DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users';
    EXECUTE 'DROP TRIGGER IF EXISTS on_auth_user_email_confirmed ON auth.users';
    RAISE NOTICE '(triggers retirados dentro de la transaccion; el ROLLBACK los repone)';
  END IF;
END $$;

-- ── CASO B · sin sesión -> 42501 ────────────────────────────────────────────
--
-- OJO con `set_config(..., is_local => true)`: es TRANSACTION-scoped, no
-- statement-scoped, y `RESET ROLE` no lo limpia. Sin este borrado explícito
-- este caso heredaría la identidad del caso A y pasaría en falso (medido: eso
-- es exactamente lo que hacía antes de aislarlo).
DO $$
DECLARE v_ok boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    PERFORM public.provision_my_business('Sin Sesion');
    RAISE EXCEPTION 'B: la RPC acepto una llamada SIN sesion';
  EXCEPTION WHEN insufficient_privilege THEN v_ok := true;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'B: no se obtuvo 42501'; END IF;
  RAISE NOTICE 'B OK · sin sesion -> 42501';
END $$;

-- ── CASO C · correo sin confirmar -> fail closed, cero escrituras ───────────
DO $$
DECLARE
  v_uid   uuid := gen_random_uuid();
  v_biz0  integer;
  v_biz1  integer;
  v_ok    boolean := false;
BEGIN
  INSERT INTO auth.users (id, email, email_confirmed_at)
  VALUES (v_uid, 'cop_sin_confirmar@invalid.test', NULL);

  SELECT count(*) INTO v_biz0 FROM public.businesses;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.provision_my_business('No Deberia Existir');
  EXCEPTION WHEN insufficient_privilege THEN v_ok := true;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);

  IF NOT v_ok THEN
    RAISE EXCEPTION 'C: se provisiono a un usuario con el correo SIN confirmar';
  END IF;

  SELECT count(*) INTO v_biz1 FROM public.businesses;
  IF v_biz1 <> v_biz0 THEN
    RAISE EXCEPTION 'C: cambio la cantidad de businesses (% -> %)', v_biz0, v_biz1;
  END IF;

  SELECT count(*) INTO v_biz1 FROM public.profiles p WHERE COALESCE(p.user_id, p.id) = v_uid;
  IF v_biz1 <> 0 THEN
    RAISE EXCEPTION 'C: quedo un profile para un usuario sin confirmar';
  END IF;

  RAISE NOTICE 'C OK · sin confirmar -> rechazo y cero escrituras';
END $$;

-- ── CASO D · owner confirmado -> provisioning completo y correcto ───────────
DO $$
DECLARE
  v_uid     uuid := gen_random_uuid();
  v_res     jsonb;
  v_biz     uuid;
  v_n       integer;
  v_role    text;
  v_owner   uuid;
  v_email   text;
  v_pid     uuid;
  v_status  text;
  v_trial   timestamptz;
  v_name    text;
BEGIN
  INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data)
  VALUES (v_uid, 'cop_owner@invalid.test', now(), '{"full_name":"Taller Perez"}'::jsonb);

  -- Sin provisioning automático no debe existir NADA todavía.
  SELECT count(*) INTO v_n FROM public.profiles p WHERE COALESCE(p.user_id, p.id) = v_uid;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'D(setup): el INSERT de auth.users provisiono algo (n=%)', v_n;
  END IF;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  v_res := public.provision_my_business('Taller Del Centro');
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);

  IF (v_res->>'created')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'D: created no es true (%)', v_res;
  END IF;
  v_biz := (v_res->>'business_id')::uuid;

  -- Exactamente 1 business y 1 profile.
  SELECT count(*) INTO v_n FROM public.businesses b WHERE b.id = v_biz;
  IF v_n <> 1 THEN RAISE EXCEPTION 'D: se esperaba 1 business, hubo %', v_n; END IF;

  SELECT count(*) INTO v_n FROM public.profiles p WHERE p.business_id = v_biz;
  IF v_n <> 1 THEN RAISE EXCEPTION 'D: se esperaba 1 profile, hubo %', v_n; END IF;

  SELECT p.id, p.role, p.email INTO v_pid, v_role, v_email
    FROM public.profiles p WHERE p.business_id = v_biz;

  -- profiles.id = auth.uid(). Es la corrección estructural del lote.
  IF v_pid <> v_uid THEN
    RAISE EXCEPTION 'D: profiles.id (%) no es el auth user (%)', v_pid, v_uid;
  END IF;
  IF v_role <> 'owner' THEN
    RAISE EXCEPTION 'D: role esperado owner, fue %', v_role;
  END IF;
  IF lower(coalesce(v_email,'')) <> 'cop_owner@invalid.test' THEN
    RAISE EXCEPTION 'D: profiles.email no quedo poblado (%)', v_email;
  END IF;

  SELECT b.owner_user_id, b.subscription_status, b.trial_ends_at, b.name
    INTO v_owner, v_status, v_trial, v_name
    FROM public.businesses b WHERE b.id = v_biz;

  IF v_owner <> v_uid THEN
    RAISE EXCEPTION 'D: owner_user_id (%) no es el auth user (%)', v_owner, v_uid;
  END IF;

  -- Trial por DEFAULT de columna: nace con el negocio, no con el signup.
  IF v_status <> 'trialing' THEN
    RAISE EXCEPTION 'D: subscription_status esperado trialing, fue %', v_status;
  END IF;
  IF v_trial IS NULL OR v_trial <= now() THEN
    RAISE EXCEPTION 'D: trial_ends_at invalido (%)', v_trial;
  END IF;
  IF v_name <> 'Taller Del Centro' THEN
    RAISE EXCEPTION 'D: no se respeto el nombre provisto (%)', v_name;
  END IF;

  PERFORM set_config('test.uid_owner', v_uid::text, false);
  PERFORM set_config('test.biz_owner', v_biz::text, false);
  RAISE NOTICE 'D OK · 1 business + 1 profile, id/role/owner/email/trial correctos';
END $$;

-- ── CASO E · segunda llamada -> idempotente ─────────────────────────────────
DO $$
DECLARE
  v_uid  uuid := current_setting('test.uid_owner')::uuid;
  v_biz  uuid := current_setting('test.biz_owner')::uuid;
  v_res  jsonb;
  v_n    integer;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  v_res := public.provision_my_business('Intento De Segundo Taller');
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);

  IF (v_res->>'created')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'E: la segunda llamada dijo created=true';
  END IF;
  IF (v_res->>'business_id')::uuid <> v_biz THEN
    RAISE EXCEPTION 'E: devolvio otro business';
  END IF;

  SELECT count(*) INTO v_n FROM public.profiles p WHERE COALESCE(p.user_id, p.id) = v_uid;
  IF v_n <> 1 THEN RAISE EXCEPTION 'E: hay % perfiles', v_n; END IF;

  SELECT count(*) INTO v_n FROM public.businesses b WHERE b.owner_user_id = v_uid;
  IF v_n <> 1 THEN RAISE EXCEPTION 'E: hay % negocios para el mismo owner', v_n; END IF;

  RAISE NOTICE 'E OK · idempotente, un solo tenant';
END $$;

-- ── CASO F · perfil NO owner -> la RPC no escala privilegios ────────────────
-- Es el defecto que tiene hoy bootstrap_owner_profile: promovía a owner a
-- cualquiera que la invocara. La RPC canónica devuelve y no toca nada.
DO $$
DECLARE
  v_dueno  uuid := gen_random_uuid();
  v_tech   uuid := gen_random_uuid();
  v_biz    uuid := gen_random_uuid();
  v_res    jsonb;
  v_role   text;
  v_bid    uuid;
  v_owner  uuid;
BEGIN
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    (v_dueno, 'cop_dueno@invalid.test', now()),
    (v_tech,  'cop_tech@invalid.test',  now());

  INSERT INTO public.businesses (id, name, owner_user_id) VALUES (v_biz, 'Taller Ajeno', v_dueno);
  INSERT INTO public.profiles (id, business_id, role, is_active) VALUES
    (v_dueno, v_biz, 'owner', true),
    (v_tech,  v_biz, 'tech',  true);

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_tech::text, 'role', 'authenticated')::text, true);
  v_res := public.provision_my_business('Taller Del Tecnico');
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);

  IF (v_res->>'created')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'F: la RPC creo un tenant para un miembro existente';
  END IF;

  SELECT p.role, p.business_id INTO v_role, v_bid FROM public.profiles p WHERE p.id = v_tech;
  IF v_role <> 'tech' THEN
    RAISE EXCEPTION 'F: ESCALADA — el rol paso de tech a %', v_role;
  END IF;
  IF v_bid <> v_biz THEN
    RAISE EXCEPTION 'F: se movio la membresia a otro negocio';
  END IF;

  SELECT b.owner_user_id INTO v_owner FROM public.businesses b WHERE b.id = v_biz;
  IF v_owner <> v_dueno THEN
    RAISE EXCEPTION 'F: el tecnico reclamo owner_user_id del negocio ajeno';
  END IF;

  RAISE NOTICE 'F OK · no escala rol, no mueve membresia, no reclama owner';
END $$;

-- ── CASO G/H/I · invitaciones ───────────────────────────────────────────────
DO $$
DECLARE
  v_dueno    uuid := gen_random_uuid();
  v_biz      uuid := gen_random_uuid();
  v_invitado uuid := gen_random_uuid();
  v_correo   text := 'cop_invitado@invalid.test';
  v_ok       boolean := false;
  v_res      jsonb;
  v_n        integer;
  v_sqlstate text;
BEGIN
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    (v_dueno,    'cop_invitante@invalid.test', now()),
    (v_invitado, v_correo,                     now());
  INSERT INTO public.businesses (id, name, owner_user_id) VALUES (v_biz, 'Taller Invitante', v_dueno);
  INSERT INTO public.profiles (id, business_id, role, is_active) VALUES (v_dueno, v_biz, 'owner', true);

  -- ══ G: invitación pending y vigente -> bloquea ═══════════════════════════
  -- Mayúsculas a propósito: la comparación debe ser case-insensitive de los
  -- dos lados, y el email del actor sale de auth.users, no del cliente.
  INSERT INTO public.business_invitations (business_id, email, role, invited_by, token, status, expires_at)
  VALUES (v_biz, 'COP_Invitado@Invalid.TEST', 'tech', v_dueno, 'cop-token-vigente', 'pending', now() + interval '7 days');

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_invitado::text, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.provision_my_business('Tenant Accidental');
  EXCEPTION WHEN OTHERS THEN
    v_sqlstate := SQLSTATE;
    IF SQLERRM LIKE '%INVITATION_PENDING%' THEN v_ok := true; END IF;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);

  IF NOT v_ok THEN
    RAISE EXCEPTION 'G: un invitado con invitacion vigente creo un tenant propio (sqlstate=%)', v_sqlstate;
  END IF;

  SELECT count(*) INTO v_n FROM public.profiles p WHERE COALESCE(p.user_id, p.id) = v_invitado;
  IF v_n <> 0 THEN RAISE EXCEPTION 'G: quedo un profile del invitado'; END IF;
  SELECT count(*) INTO v_n FROM public.businesses b WHERE b.owner_user_id = v_invitado;
  IF v_n <> 0 THEN RAISE EXCEPTION 'G: quedo un business del invitado'; END IF;
  RAISE NOTICE 'G OK · invitacion vigente bloquea la creacion (case-insensitive)';

  -- ══ H: invitación VENCIDA -> no bloquea ══════════════════════════════════
  UPDATE public.business_invitations
     SET expires_at = now() - interval '1 day'
   WHERE token = 'cop-token-vigente';

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_invitado::text, 'role', 'authenticated')::text, true);
  v_res := public.provision_my_business('Taller Tras Vencimiento');
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);

  IF (v_res->>'created')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'H: una invitacion VENCIDA bloqueo la creacion';
  END IF;
  RAISE NOTICE 'H OK · invitacion vencida no bloquea';

  -- ══ I: invitación ya ACEPTADA -> no bloquea ══════════════════════════════
  -- (se prueba sobre un usuario limpio: el de arriba ya está provisionado)
  DECLARE
    v_otro uuid := gen_random_uuid();
  BEGIN
    INSERT INTO auth.users (id, email, email_confirmed_at)
    VALUES (v_otro, 'cop_aceptada@invalid.test', now());
    INSERT INTO public.business_invitations (business_id, email, role, invited_by, token, status, expires_at)
    VALUES (v_biz, 'cop_aceptada@invalid.test', 'tech', v_dueno, 'cop-token-aceptado', 'accepted', now() + interval '7 days');

    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_otro::text, 'role', 'authenticated')::text, true);
    v_res := public.provision_my_business('Taller Tras Aceptacion');
    RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);

    IF (v_res->>'created')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'I: una invitacion ya aceptada bloqueo la creacion';
    END IF;
  END;
  RAISE NOTICE 'I OK · invitacion no-pending no bloquea';
END $$;

-- ── CASO J · metadata hostil -> sin efecto estructural ──────────────────────
DO $$
DECLARE
  v_uid  uuid := gen_random_uuid();
  v_res  jsonb;
  v_role text;
BEGIN
  -- 'superadmin' NO está en el CHECK de profiles.role. Si la RPC lo leyera de
  -- la metadata, esto reventaria con 23514 en vez de crear un owner.
  INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data)
  VALUES (v_uid, 'cop_hostil@invalid.test', now(),
          '{"role":"superadmin","business_name":"Inyectado","full_name":"X"}'::jsonb);

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  v_res := public.provision_my_business(NULL);
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);

  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = v_uid;
  IF v_role <> 'owner' THEN
    RAISE EXCEPTION 'J: la metadata definio el rol (%)', v_role;
  END IF;

  -- `business_name` de la metadata tampoco debe tener efecto.
  IF EXISTS (SELECT 1 FROM public.businesses b
              WHERE b.id = (v_res->>'business_id')::uuid AND b.name = 'Inyectado') THEN
    RAISE EXCEPTION 'J: la metadata definio el nombre del negocio';
  END IF;

  RAISE NOTICE 'J OK · metadata hostil sin efecto estructural';
END $$;

-- ── CASO K · nombre: default y acotado ──────────────────────────────────────
DO $$
DECLARE
  v_uid  uuid := gen_random_uuid();
  v_uid2 uuid := gen_random_uuid();
  v_res  jsonb;
  v_name text;
BEGIN
  INSERT INTO auth.users (id, email, email_confirmed_at)
  VALUES (v_uid, 'cop_nombre_vacio@invalid.test', now());

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  v_res := public.provision_my_business('   ');
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);

  SELECT b.name INTO v_name FROM public.businesses b WHERE b.id = (v_res->>'business_id')::uuid;
  IF v_name <> 'Mi Negocio' THEN
    RAISE EXCEPTION 'K: nombre en blanco no cayo al default (%)', v_name;
  END IF;

  INSERT INTO auth.users (id, email, email_confirmed_at)
  VALUES (v_uid2, 'cop_nombre_largo@invalid.test', now());

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid2::text, 'role', 'authenticated')::text, true);
  v_res := public.provision_my_business(repeat('N', 400));
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);

  SELECT b.name INTO v_name FROM public.businesses b WHERE b.id = (v_res->>'business_id')::uuid;
  IF length(v_name) <> 120 THEN
    RAISE EXCEPTION 'K: el nombre no quedo acotado a 120 (len=%)', length(v_name);
  END IF;

  RAISE NOTICE 'K OK · default y cota de nombre';
END $$;

-- ── CASO L · catálogo: ACL y ausencia de DML estructural ────────────────────
DO $$
DECLARE
  v_oid oid := 'public.provision_my_business(text)'::regprocedure::oid;
  v_t   text;
BEGIN
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'L: anon puede ejecutar provision_my_business';
  END IF;
  IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'L: PUBLIC puede ejecutar provision_my_business';
  END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'L: authenticated NO puede ejecutar provision_my_business';
  END IF;

  FOREACH v_t IN ARRAY ARRAY['public.profiles', 'public.businesses'] LOOP
    IF has_table_privilege('authenticated', v_t, 'INSERT')
       OR has_table_privilege('authenticated', v_t, 'UPDATE')
       OR has_table_privilege('authenticated', v_t, 'DELETE')
       OR has_table_privilege('anon', v_t, 'INSERT')
       OR has_table_privilege('anon', v_t, 'UPDATE')
       OR has_table_privilege('anon', v_t, 'DELETE') THEN
      RAISE EXCEPTION 'L: hay DML estructural directo del cliente sobre %', v_t;
    END IF;
  END LOOP;

  RAISE NOTICE 'L OK · ACL minima y cero DML estructural para el cliente';
END $$;

DO $$ BEGIN RAISE NOTICE 'canonical_owner_provisioning: TODOS LOS CASOS OK'; END $$;

ROLLBACK;
