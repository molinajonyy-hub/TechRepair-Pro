-- ============================================================================
-- EMAIL VERIFICATION P0 × P0-P1 — La compuerta de la confirmación
--
-- ⚠️ ESTA SUITE CAMBIÓ DE CONTRATO EN 20260823180000 (P0-P1 fase B).
--    Antes verificaba que confirmar el correo DISPARARA el provisioning
--    (`on_auth_user_email_confirmed` -> `handle_new_user()`). Ese acoplamiento
--    se retiró: confirmar la identidad y fundar la empresa ya no son el mismo
--    acto. Los casos B..J de la versión anterior aseveraban justamente lo que
--    ahora está prohibido, así que se reescribieron en vez de borrarse.
--
--    El desacople en sí se prueba en tests/sql/provisioning_decoupled_from_auth
--    y el contrato de la RPC en tests/sql/canonical_owner_provisioning.
--    ACÁ se prueba la BISAGRA entre las dos features: en qué momento exacto
--    `email_confirmed_at` habilita la creación del negocio, y que confirmar
--    nunca pueda fallar por lógica de negocio.
--
-- Corre contra el stack LOCAL o una branch (NUNCA producción):
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < tests/sql/email_verification_provisioning.test.sql
--
--   A  sin confirmar            -> la compuerta está CERRADA (42501) y no
--                                  escribe nada
--   B  al confirmar             -> NO se provisiona solo, pero la confirmación
--                                  persiste
--   C  ya confirmado            -> la compuerta ABRE: el mismo usuario crea su
--                                  negocio
--   D  la compuerta es la señal canónica, no el proveedor: un usuario que nace
--      confirmado (Google) pasa por exactamente el mismo camino
--   E  confirmar no puede abortar por lógica de negocio (metadata hostil)
--
-- Todo en una transacción que termina en ROLLBACK.
--
-- OJO: `public.profiles.id` es FK a `auth.users(id)`. Los fixtures insertan
-- auth users de verdad.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- ── CASO A · sin confirmar la compuerta está cerrada ────────────────────────
DO $$
DECLARE
  v_uid  uuid := gen_random_uuid();
  v_b0   integer;
  v_b1   integer;
  v_n    integer;
  v_ok   boolean := false;
BEGIN
  SELECT count(*) INTO v_b0 FROM public.businesses;

  INSERT INTO auth.users (id, email, email_confirmed_at)
  VALUES (v_uid, 'evp_pendiente@invalid.test', NULL);

  -- Nada automático.
  SELECT count(*) INTO v_n FROM public.profiles p WHERE p.id = v_uid OR p.user_id = v_uid;
  IF v_n <> 0 THEN RAISE EXCEPTION 'A: un usuario sin confirmar recibio profile'; END IF;

  -- Y el camino explícito tampoco lo deja pasar: fail-closed server-side, no
  -- una comprobación del frontend.
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.provision_my_business('Antes De Confirmar');
  EXCEPTION WHEN insufficient_privilege THEN v_ok := true;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);

  IF NOT v_ok THEN
    RAISE EXCEPTION 'A: un usuario SIN confirmar pudo crear su negocio';
  END IF;

  SELECT count(*) INTO v_b1 FROM public.businesses;
  IF v_b1 <> v_b0 THEN RAISE EXCEPTION 'A: el rechazo dejo un business (% -> %)', v_b0, v_b1; END IF;

  PERFORM set_config('test.uid_a', v_uid::text, false);
  RAISE NOTICE 'A OK · sin confirmar: compuerta cerrada (42501) y cero escrituras';
END $$;

-- ── CASO B · confirmar persiste pero no provisiona ──────────────────────────
DO $$
DECLARE
  v_uid  uuid := current_setting('test.uid_a')::uuid;
  v_b0   integer;
  v_b1   integer;
  v_n    integer;
  v_conf timestamptz;
BEGIN
  SELECT count(*) INTO v_b0 FROM public.businesses;

  UPDATE auth.users SET email_confirmed_at = now() WHERE id = v_uid;

  SELECT u.email_confirmed_at INTO v_conf FROM auth.users u WHERE u.id = v_uid;
  IF v_conf IS NULL THEN RAISE EXCEPTION 'B: la confirmacion no persistio'; END IF;

  SELECT count(*) INTO v_n FROM public.profiles p WHERE p.id = v_uid OR p.user_id = v_uid;
  IF v_n <> 0 THEN RAISE EXCEPTION 'B: confirmar provisiono un profile'; END IF;

  SELECT count(*) INTO v_b1 FROM public.businesses;
  IF v_b1 <> v_b0 THEN RAISE EXCEPTION 'B: confirmar creo un business'; END IF;

  RAISE NOTICE 'B OK · confirmar persiste y NO provisiona';
END $$;

-- ── CASO C · confirmado, la compuerta abre ──────────────────────────────────
DO $$
DECLARE
  v_uid  uuid := current_setting('test.uid_a')::uuid;
  v_res  jsonb;
  v_role text;
  v_own  uuid;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  v_res := public.provision_my_business('Taller Ya Confirmado');
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);

  IF (v_res->>'created')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'C: el mismo usuario, ya confirmado, no pudo crear su negocio (%)', v_res;
  END IF;

  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = v_uid;
  IF v_role <> 'owner' THEN RAISE EXCEPTION 'C: rol % en vez de owner', v_role; END IF;

  SELECT b.owner_user_id INTO v_own FROM public.businesses b
   WHERE b.id = (v_res->>'business_id')::uuid;
  IF v_own <> v_uid THEN RAISE EXCEPTION 'C: owner_user_id incorrecto'; END IF;

  RAISE NOTICE 'C OK · la compuerta abre EXACTAMENTE al confirmar';
END $$;

-- ── CASO D · la señal es email_confirmed_at, no el proveedor ────────────────
-- Un usuario de Google nace confirmado. Tiene que recorrer el MISMO camino: sin
-- provisioning automático y con la compuerta ya abierta. Si en algún momento
-- apareciera una rama por proveedor, este caso y el C divergirían.
DO $$
DECLARE
  v_uid  uuid := gen_random_uuid();
  v_n    integer;
  v_res  jsonb;
BEGIN
  INSERT INTO auth.users (id, email, email_confirmed_at)
  VALUES (v_uid, 'evp_google@invalid.test', now());

  SELECT count(*) INTO v_n FROM public.profiles p WHERE p.id = v_uid OR p.user_id = v_uid;
  IF v_n <> 0 THEN RAISE EXCEPTION 'D: nacer confirmado provisiono automaticamente'; END IF;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  v_res := public.provision_my_business('Taller Google');
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);

  IF (v_res->>'created')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'D: un usuario que nace confirmado no pudo provisionar';
  END IF;

  RAISE NOTICE 'D OK · Google converge por la misma senal, sin rama propia';
END $$;

-- ── CASO E · confirmar no puede abortar por lógica de negocio ───────────────
-- El modo de falla más grave del contrato viejo: el provisioning corría DENTRO
-- de la transacción del UPDATE, así que una excepción suya revertía la
-- confirmación y el usuario quedaba trabado para siempre. `role` salía de
-- `raw_user_meta_data`, que escribe el navegador, y un valor fuera del CHECK
-- alcanzaba para provocarlo.
DO $$
DECLARE
  v_uid  uuid := gen_random_uuid();
  v_conf timestamptz;
BEGIN
  INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data)
  VALUES (v_uid, 'evp_hostil@invalid.test', NULL,
          '{"role":"superadmin","business_name":"Inyectado"}'::jsonb);

  UPDATE auth.users SET email_confirmed_at = now() WHERE id = v_uid;

  SELECT u.email_confirmed_at INTO v_conf FROM auth.users u WHERE u.id = v_uid;
  IF v_conf IS NULL THEN
    RAISE EXCEPTION 'E: metadata hostil impidio confirmar el correo';
  END IF;

  IF EXISTS (SELECT 1 FROM public.businesses b WHERE b.name = 'Inyectado') THEN
    RAISE EXCEPTION 'E: la metadata definio el nombre de un negocio';
  END IF;

  RAISE NOTICE 'E OK · confirmar es inmune a la logica de negocio';
END $$;

DO $$ BEGIN RAISE NOTICE 'email_verification_provisioning: TODOS LOS CASOS OK'; END $$;

ROLLBACK;
