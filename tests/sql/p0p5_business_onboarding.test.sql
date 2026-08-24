-- ============================================================================
-- P0-P5 — Contrato de configuración del business (onboarding server-side)
--
-- Corre contra el stack LOCAL o una branch (NUNCA producción), con la
-- migración 20260825120000 aplicada:
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < tests/sql/p0p5_business_onboarding.test.sql
--
-- Invariantes que se aseveran:
--   · el onboarding CONFIGURA un business existente y NUNCA crea uno
--   · el tenant se deriva server-side: la RPC no acepta business_id
--   · owner/admin sí; tech/sales no
--   · las columnas estructurales (owner, subscription, trial) son intocables
--   · onboarding_completed sólo se marca con los obligatorios ya persistidos
--   · `authenticated` sigue SIN UPDATE directo sobre businesses
--
-- Todo en UNA transacción que termina en ROLLBACK: no se commitea nada.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.como(p_uid uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_uid::text, 'role', 'authenticated')::text, true);
END $$;

CREATE OR REPLACE FUNCTION pg_temp.anonimo() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

-- ── Fixtures ────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_owner_a uuid := gen_random_uuid();
  v_admin_a uuid := gen_random_uuid();
  v_tech_a  uuid := gen_random_uuid();
  v_owner_b uuid := gen_random_uuid();
  v_biz_a   uuid;
  v_biz_b   uuid;
BEGIN
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    (v_owner_a, 'p0p5_owner_a@invalid.test', now()),
    (v_admin_a, 'p0p5_admin_a@invalid.test', now()),
    (v_tech_a,  'p0p5_tech_a@invalid.test',  now()),
    (v_owner_b, 'p0p5_owner_b@invalid.test', now());

  INSERT INTO public.businesses (name, owner_user_id) VALUES ('Taller A', v_owner_a)
    RETURNING id INTO v_biz_a;
  INSERT INTO public.businesses (name, owner_user_id) VALUES ('Taller B', v_owner_b)
    RETURNING id INTO v_biz_b;

  -- `id = auth.uid()` y `user_id` NULL: es EXACTAMENTE la forma que produce
  -- `provision_my_business`, y la que rompía la policy de Storage.
  INSERT INTO public.profiles (id, business_id, role, is_active, email) VALUES
    (v_owner_a, v_biz_a, 'owner', true, 'p0p5_owner_a@invalid.test'),
    (v_admin_a, v_biz_a, 'admin', true, 'p0p5_admin_a@invalid.test'),
    (v_tech_a,  v_biz_a, 'tech',  true, 'p0p5_tech_a@invalid.test'),
    (v_owner_b, v_biz_b, 'owner', true, 'p0p5_owner_b@invalid.test');

  PERFORM set_config('test.owner_a', v_owner_a::text, false);
  PERFORM set_config('test.admin_a', v_admin_a::text, false);
  PERFORM set_config('test.tech_a',  v_tech_a::text,  false);
  PERFORM set_config('test.owner_b', v_owner_b::text, false);
  PERFORM set_config('test.biz_a',   v_biz_a::text,   false);
  PERFORM set_config('test.biz_b',   v_biz_b::text,   false);
  PERFORM set_config('test.n_biz', (SELECT count(*) FROM public.businesses)::text, false);
  RAISE NOTICE 'Fixtures OK · A=% · B=%', v_biz_a, v_biz_b;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 1 · owner/admin actualizan los campos permitidos de SU negocio
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_res jsonb; v_b record; v_s record;
BEGIN
  PERFORM pg_temp.como(current_setting('test.owner_a')::uuid);
  v_res := public.update_my_business_onboarding(
    p_name    => '  Tecno Reparaciones  ',
    p_rubro   => 'celulares',
    p_ciudad  => 'Córdoba',
    p_whatsapp=> '351 234-5678',
    p_cuit    => '20-12345678-9',
    p_condicion_fiscal => 'monotributo'
  );
  PERFORM pg_temp.anonimo();

  SELECT name, rubro, ciudad, wholesale_whatsapp INTO v_b
    FROM public.businesses WHERE id = current_setting('test.biz_a')::uuid;

  IF v_b.name <> 'Tecno Reparaciones' THEN RAISE EXCEPTION '1 FAIL: name "%" (sin trim?)', v_b.name; END IF;
  IF v_b.rubro <> 'celulares' THEN RAISE EXCEPTION '1 FAIL: rubro %', v_b.rubro; END IF;
  IF v_b.ciudad <> 'Córdoba' THEN RAISE EXCEPTION '1 FAIL: ciudad %', v_b.ciudad; END IF;
  -- El WhatsApp se normaliza a dígitos.
  IF v_b.wholesale_whatsapp <> '3512345678' THEN
    RAISE EXCEPTION '1 FAIL: whatsapp sin normalizar: %', v_b.wholesale_whatsapp; END IF;

  -- Los datos fiscales van a business_settings, y la fila se CREA si no existía
  -- (18 de 26 negocios productivos no tienen fila: un UPDATE suelto perdería
  -- el dato en silencio).
  SELECT cuit, condicion_iva INTO v_s
    FROM public.business_settings WHERE business_id = current_setting('test.biz_a')::uuid;
  IF v_s.cuit IS NULL THEN RAISE EXCEPTION '1 FAIL: no se creó la fila de business_settings'; END IF;
  IF v_s.cuit <> '20123456789' THEN RAISE EXCEPTION '1 FAIL: cuit sin normalizar: %', v_s.cuit; END IF;
  IF v_s.condicion_iva <> 'monotributo' THEN RAISE EXCEPTION '1 FAIL: condicion %', v_s.condicion_iva; END IF;

  IF v_res->>'name' <> 'Tecno Reparaciones' THEN RAISE EXCEPTION '1 FAIL: la RPC no devolvió el estado nuevo'; END IF;

  -- admin también puede
  PERFORM pg_temp.como(current_setting('test.admin_a')::uuid);
  PERFORM public.update_my_business_onboarding(p_ciudad => 'Rosario');
  PERFORM pg_temp.anonimo();
  IF (SELECT ciudad FROM public.businesses WHERE id = current_setting('test.biz_a')::uuid) <> 'Rosario' THEN
    RAISE EXCEPTION '1 FAIL: admin no pudo actualizar'; END IF;

  RAISE NOTICE '1 OK · owner y admin configuran; normalización y upsert de settings';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 2 · NO se puede elegir business_id — no existe el parámetro
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_args text; v_n int;
BEGIN
  SELECT pg_get_function_identity_arguments(
           to_regprocedure('public.update_my_business_onboarding(text,text,text,text,text,text,text,boolean)'))
    INTO v_args;
  IF v_args ILIKE '%business_id%' THEN
    RAISE EXCEPTION '2 FAIL: la RPC acepta business_id: %', v_args; END IF;

  -- Y no hay ningún overload que lo acepte por la puerta de atrás.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='update_my_business_onboarding';
  IF v_n <> 1 THEN RAISE EXCEPTION '2 FAIL: hay % overloads', v_n; END IF;

  RAISE NOTICE '2 OK · el tenant no es un parámetro';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 3 · tech no puede cambiar la configuración
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_ok boolean := false; v_nombre text;
BEGIN
  PERFORM pg_temp.como(current_setting('test.tech_a')::uuid);
  BEGIN
    PERFORM public.update_my_business_onboarding(p_name => 'Secuestrado por el tecnico');
  EXCEPTION WHEN insufficient_privilege THEN v_ok := true;
  END;
  PERFORM pg_temp.anonimo();

  IF NOT v_ok THEN RAISE EXCEPTION '3 FAIL: un tech configuró el negocio'; END IF;
  SELECT name INTO v_nombre FROM public.businesses WHERE id = current_setting('test.biz_a')::uuid;
  IF v_nombre = 'Secuestrado por el tecnico' THEN RAISE EXCEPTION '3 FAIL: el nombre cambió igual'; END IF;

  -- Pero SÍ puede leer: el wizard se le muestra en modo lectura en vez de
  -- explotar con un 42501.
  PERFORM pg_temp.como(current_setting('test.tech_a')::uuid);
  IF (public.get_my_business_onboarding()->>'can_edit')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION '3 FAIL: can_edit deberia ser false para tech'; END IF;
  PERFORM pg_temp.anonimo();

  RAISE NOTICE '3 OK · tech no configura, pero lee con can_edit=false';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 4 · el negocio A no puede tocar el B
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_nombre_b text;
BEGIN
  SELECT name INTO v_nombre_b FROM public.businesses WHERE id = current_setting('test.biz_b')::uuid;

  PERFORM pg_temp.como(current_setting('test.owner_a')::uuid);
  PERFORM public.update_my_business_onboarding(p_name => 'Intento cross-tenant');
  PERFORM pg_temp.anonimo();

  -- El negocio B quedó intacto: el owner de A sólo pudo tocar el suyo.
  IF (SELECT name FROM public.businesses WHERE id = current_setting('test.biz_b')::uuid) <> v_nombre_b THEN
    RAISE EXCEPTION '4 FAIL: se modificó el negocio B'; END IF;
  IF (SELECT name FROM public.businesses WHERE id = current_setting('test.biz_a')::uuid) <> 'Intento cross-tenant' THEN
    RAISE EXCEPTION '4 FAIL: no se modificó el propio'; END IF;

  RAISE NOTICE '4 OK · cross-tenant imposible por construcción';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 5 y 6 · owner_user_id y los campos de suscripción son intocables
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_antes record; v_despues record;
BEGIN
  SELECT owner_user_id, subscription_plan, subscription_status, trial_ends_at
    INTO v_antes FROM public.businesses WHERE id = current_setting('test.biz_a')::uuid;

  PERFORM pg_temp.como(current_setting('test.owner_a')::uuid);
  PERFORM public.update_my_business_onboarding(
    p_name => 'Taller A', p_rubro => 'redes', p_ciudad => 'Mendoza');
  PERFORM pg_temp.anonimo();

  SELECT owner_user_id, subscription_plan, subscription_status, trial_ends_at
    INTO v_despues FROM public.businesses WHERE id = current_setting('test.biz_a')::uuid;

  IF v_despues.owner_user_id IS DISTINCT FROM v_antes.owner_user_id THEN
    RAISE EXCEPTION '5 FAIL: cambió owner_user_id'; END IF;
  IF v_despues.subscription_plan IS DISTINCT FROM v_antes.subscription_plan
     OR v_despues.subscription_status IS DISTINCT FROM v_antes.subscription_status
     OR v_despues.trial_ends_at IS DISTINCT FROM v_antes.trial_ends_at THEN
    RAISE EXCEPTION '6 FAIL: cambió algún campo de suscripción'; END IF;

  -- Y la allowlist es estructural, no de buena fe: la RPC ni siquiera nombra
  -- esas columnas en su código.
  IF regexp_replace(
       pg_get_functiondef(to_regprocedure('public.update_my_business_onboarding(text,text,text,text,text,text,text,boolean)')),
       '--[^\n]*', '', 'g') ~* 'owner_user_id|subscription_|trial_ends_at' THEN
    RAISE EXCEPTION '5/6 FAIL: la RPC menciona columnas estructurales'; END IF;

  RAISE NOTICE '5,6 OK · owner y suscripción fuera de la allowlist';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 7 · onboarding_completed sólo con los obligatorios ya persistidos
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_ok boolean := false; v_res jsonb;
BEGIN
  -- Negocio B: tiene nombre pero NO rubro -> completar debe fallar.
  PERFORM pg_temp.como(current_setting('test.owner_b')::uuid);
  BEGIN
    PERFORM public.update_my_business_onboarding(p_complete => true);
  EXCEPTION WHEN sqlstate 'TRONB' THEN v_ok := true;
  END;
  PERFORM pg_temp.anonimo();

  IF NOT v_ok THEN RAISE EXCEPTION '7 FAIL: se completó sin rubro'; END IF;
  IF (SELECT coalesce(onboarding_completed,false) FROM public.businesses
       WHERE id = current_setting('test.biz_b')::uuid) THEN
    RAISE EXCEPTION '7 FAIL: quedó marcado completo igual'; END IF;

  -- Con el rubro cargado sí completa.
  PERFORM pg_temp.como(current_setting('test.owner_b')::uuid);
  PERFORM public.update_my_business_onboarding(p_rubro => 'otro');
  v_res := public.update_my_business_onboarding(p_complete => true);
  PERFORM pg_temp.anonimo();

  IF (v_res->>'onboarding_completed')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION '7 FAIL: no completó con los obligatorios cargados'; END IF;
  IF (SELECT onboarding_completed_at FROM public.businesses
       WHERE id = current_setting('test.biz_b')::uuid) IS NULL THEN
    RAISE EXCEPTION '7 FAIL: falta onboarding_completed_at'; END IF;

  RAISE NOTICE '7 OK · completed exige los obligatorios REALMENTE persistidos';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 8 · retry idempotente
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_fecha1 timestamptz; v_fecha2 timestamptz; v_n int;
BEGIN
  SELECT onboarding_completed_at INTO v_fecha1
    FROM public.businesses WHERE id = current_setting('test.biz_b')::uuid;

  PERFORM pg_temp.como(current_setting('test.owner_b')::uuid);
  PERFORM public.update_my_business_onboarding(p_complete => true);
  PERFORM public.update_my_business_onboarding(p_complete => true);
  PERFORM pg_temp.anonimo();

  SELECT onboarding_completed_at INTO v_fecha2
    FROM public.businesses WHERE id = current_setting('test.biz_b')::uuid;

  -- La fecha original NO se pisa: un retry no reescribe cuándo terminó.
  IF v_fecha2 IS DISTINCT FROM v_fecha1 THEN
    RAISE EXCEPTION '8 FAIL: el retry movió onboarding_completed_at'; END IF;

  -- Y no se duplicó la fila de settings.
  SELECT count(*) INTO v_n FROM public.business_settings
   WHERE business_id = current_setting('test.biz_b')::uuid;
  IF v_n > 1 THEN RAISE EXCEPTION '8 FAIL: % filas de business_settings', v_n; END IF;

  RAISE NOTICE '8 OK · retry idempotente, fecha estable';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 8b · NUNCA se crea un business (la invariante central del lote)
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.businesses;
  IF v_n <> current_setting('test.n_biz')::int THEN
    RAISE EXCEPTION '8b FAIL: cambió la cantidad de businesses (% -> %)',
      current_setting('test.n_biz'), v_n; END IF;
  RAISE NOTICE '8b OK · configurar no crea tenants';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 9, 10, 11 · seguridad
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_n int;
BEGIN
  -- 9 · `authenticated` sigue SIN UPDATE directo sobre businesses. Es lo que
  --     obliga a que todo pase por la RPC.
  SELECT count(*) INTO v_n
    FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name IN ('businesses','profiles')
     AND grantee IN ('anon','authenticated')
     AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE');
  IF v_n <> 0 THEN RAISE EXCEPTION '9 FAIL: % grants de DML repuestos', v_n; END IF;

  -- 10 · PUBLIC / anon no ejecutan la RPC privada.
  IF has_function_privilege('public','public.update_my_business_onboarding(text,text,text,text,text,text,text,boolean)','EXECUTE')
     OR has_function_privilege('anon','public.update_my_business_onboarding(text,text,text,text,text,text,text,boolean)','EXECUTE')
     OR has_function_privilege('anon','public.get_my_business_onboarding()','EXECUTE') THEN
    RAISE EXCEPTION '10 FAIL: PUBLIC/anon pueden ejecutar la RPC de onboarding';
  END IF;

  -- 11 · search_path endurecido con pg_temp al final.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.proname IN ('get_my_business_onboarding','update_my_business_onboarding')
     AND (p.prosecdef = false OR p.proconfig IS NULL
          OR NOT (p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']));
  IF v_n > 0 THEN RAISE EXCEPTION '11 FAIL: % RPC mal configuradas', v_n; END IF;

  RAISE NOTICE '9,10,11 OK · sin DML de cliente, ACL cerrada, search_path endurecido';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 12 · la autoridad de provisioning no se tocó
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_def text; v_n int;
BEGIN
  IF to_regprocedure('public.provision_my_business(text)') IS NULL THEN
    RAISE EXCEPTION '12 FAIL: desapareció provision_my_business'; END IF;

  v_def := pg_get_functiondef(to_regprocedure('public.provision_my_business(text)'));
  IF v_def NOT LIKE '%INVITATION_PENDING%' THEN
    RAISE EXCEPTION '12 FAIL: perdió la defensa INVITATION_PENDING'; END IF;
  IF v_def NOT LIKE '%INSERT INTO public.profiles (id,%' THEN
    RAISE EXCEPTION '12 FAIL: perdió el id explícito del INSERT de profiles'; END IF;

  -- Sigue siendo la ÚNICA que inserta en businesses.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.prokind='f'
     AND regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g')
         ~* 'insert[[:space:]]+into[[:space:]]+(public\.)?businesses[[:space:]]*\(';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '12 FAIL: % funciones insertan en businesses, se esperaba solo provision_my_business', v_n;
  END IF;

  -- Y los triggers de auth.users siguen retirados (P0-P1 fase B).
  SELECT count(*) INTO v_n FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE NOT t.tgisinternal AND n.nspname='auth' AND c.relname='users';
  IF v_n <> 0 THEN RAISE EXCEPTION '12 FAIL: reaparecieron % triggers en auth.users', v_n; END IF;

  RAISE NOTICE '12 OK · provisioning intacto, una sola creadora de businesses';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 13 · STORAGE — la causa raíz del logo, medida
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_pol text; v_n int;
BEGIN
  -- La policy vieja proyectaba la columna CRUDA `user_id` mientras filtraba con
  -- COALESCE. Un perfil creado por provision_my_business tiene `user_id` NULL,
  -- así que la subconsulta devolvía NULL y `auth.uid() IN (NULL)` es NULL.
  -- Se reproduce el predicado viejo sobre los fixtures (que tienen user_id NULL
  -- a propósito) y se verifica que efectivamente denegaba.
  SELECT count(*) INTO v_n
    FROM public.profiles p
   WHERE p.id IN (SELECT q.user_id FROM public.profiles q
                   WHERE COALESCE(q.user_id, q.id) = p.id)
     AND p.email LIKE 'p0p5_%';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '13 FAIL: el predicado viejo no reproduce la denegación'; END IF;

  -- Con COALESCE los 4 fixtures pasan.
  SELECT count(*) INTO v_n
    FROM public.profiles p
   WHERE p.id IN (SELECT COALESCE(q.user_id, q.id) FROM public.profiles q
                   WHERE COALESCE(q.user_id, q.id) = p.id)
     AND p.email LIKE 'p0p5_%';
  IF v_n <> 4 THEN
    RAISE EXCEPTION '13 FAIL: con COALESCE pasan % de 4', v_n; END IF;

  -- Las policies nuevas existen, son tenant-scoped y ninguna proyecta user_id.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname='storage' AND tablename='objects'
     AND policyname IN ('business_assets_insert_own_tenant',
                        'business_assets_update_own_tenant',
                        'business_assets_delete_own_tenant');
  IF v_n <> 3 THEN RAISE EXCEPTION '13 FAIL: hay % policies nuevas', v_n; END IF;

  SELECT string_agg(coalesce(qual,'')||coalesce(with_check,''), ' ') INTO v_pol
    FROM pg_policies WHERE schemaname='storage' AND tablename='objects'
     AND policyname LIKE 'business_assets_%_own_tenant';

  IF v_pol NOT LIKE '%current_user_business_id%' THEN
    RAISE EXCEPTION '13 FAIL: las policies nuevas no derivan el tenant server-side'; END IF;
  IF v_pol NOT LIKE '%foldername%' THEN
    RAISE EXCEPTION '13 FAIL: las policies nuevas no validan la carpeta'; END IF;
  IF v_pol LIKE '%profiles.user_id%' THEN
    RAISE EXCEPTION '13 FAIL: sobrevive la proyección de user_id crudo'; END IF;

  -- Y las viejas se fueron.
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects'
              AND policyname LIKE 'Authenticated users can % business assets') THEN
    RAISE EXCEPTION '13 FAIL: sobrevive una policy vieja'; END IF;

  RAISE NOTICE '13 OK · causa raiz del logo reproducida y cerrada, policies tenant-scoped';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 14 · validaciones de entrada
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_vacio boolean := false; v_rubro boolean := false;
        v_cuit boolean := false; v_cond boolean := false;
BEGIN
  PERFORM pg_temp.como(current_setting('test.owner_a')::uuid);

  BEGIN PERFORM public.update_my_business_onboarding(p_name => '   ');
  EXCEPTION WHEN sqlstate 'TRIVN' THEN v_vacio := true; END;

  BEGIN PERFORM public.update_my_business_onboarding(p_rubro => 'inventado');
  EXCEPTION WHEN sqlstate 'TRIVU' THEN v_rubro := true; END;

  BEGIN PERFORM public.update_my_business_onboarding(p_cuit => '123');
  EXCEPTION WHEN sqlstate 'TRIVC' THEN v_cuit := true; END;

  BEGIN PERFORM public.update_my_business_onboarding(p_condicion_fiscal => 'inventada');
  EXCEPTION WHEN sqlstate 'TRIVF' THEN v_cond := true; END;

  PERFORM pg_temp.anonimo();

  IF NOT v_vacio THEN RAISE EXCEPTION '14 FAIL: aceptó nombre vacío'; END IF;
  IF NOT v_rubro THEN RAISE EXCEPTION '14 FAIL: aceptó rubro fuera de la allowlist'; END IF;
  IF NOT v_cuit  THEN RAISE EXCEPTION '14 FAIL: aceptó un CUIT de 3 dígitos'; END IF;
  IF NOT v_cond  THEN RAISE EXCEPTION '14 FAIL: aceptó una condición fiscal inventada'; END IF;

  RAISE NOTICE '14 OK · nombre, rubro, CUIT y condición fiscal validados';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 15 · NULL = «no tocar» (guardado por pasos sin pisar lo anterior)
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_b record;
BEGIN
  PERFORM pg_temp.como(current_setting('test.owner_a')::uuid);
  PERFORM public.update_my_business_onboarding(p_name => 'Paso Uno', p_rubro => 'computadoras');
  -- Un paso posterior que sólo manda ciudad NO puede borrar nombre ni rubro.
  PERFORM public.update_my_business_onboarding(p_ciudad => 'La Plata');
  PERFORM pg_temp.anonimo();

  SELECT name, rubro, ciudad INTO v_b
    FROM public.businesses WHERE id = current_setting('test.biz_a')::uuid;

  IF v_b.name <> 'Paso Uno' THEN RAISE EXCEPTION '15 FAIL: se perdió el nombre: %', v_b.name; END IF;
  IF v_b.rubro <> 'computadoras' THEN RAISE EXCEPTION '15 FAIL: se perdió el rubro: %', v_b.rubro; END IF;
  IF v_b.ciudad <> 'La Plata' THEN RAISE EXCEPTION '15 FAIL: no se guardó la ciudad'; END IF;

  RAISE NOTICE '15 OK · guardado incremental sin pisar pasos anteriores';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 16 · sin sesión no se puede nada
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_w boolean := false; v_r boolean := false;
BEGIN
  PERFORM pg_temp.anonimo();
  BEGIN PERFORM public.update_my_business_onboarding(p_name => 'Anonimo');
  EXCEPTION WHEN insufficient_privilege THEN v_w := true; END;
  BEGIN PERFORM public.get_my_business_onboarding();
  EXCEPTION WHEN insufficient_privilege THEN v_r := true; END;

  IF NOT v_w THEN RAISE EXCEPTION '16 FAIL: se pudo escribir sin sesión'; END IF;
  IF NOT v_r THEN RAISE EXCEPTION '16 FAIL: se pudo leer sin sesión'; END IF;
  RAISE NOTICE '16 OK · sin sesión, fail-closed';
END $$;

ROLLBACK;
