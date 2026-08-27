-- ============================================================================
-- P0-ONBOARDING-1 — Perfil del negocio canónico
--
-- Corre contra el stack LOCAL o una branch (NUNCA producción), con la
-- migración 20260904120000 aplicada:
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < tests/sql/p0onb1_canonical_business_profile.test.sql
--
-- Invariantes que se aseveran:
--   · `business_settings.nombre_comercial` es la AUTORIDAD y `businesses.name`
--     su espejo — nunca divergen por un writer normal;
--   · el WRAPPER LEGACY, con su firma intacta, escribe canónicamente: es lo que
--     hace que el frontend viejo se arregle sin redesplegarse;
--   · ciudad->localidad y whatsapp->telefono con espejo explícito;
--   · `condicion_iva` sólo admite slugs canónicos; las etiquetas legacy se
--     traducen; la basura se RECHAZA (no se borra el dato);
--   · clave ausente = no tocar / clave vacía = borrar;
--   · el nombre comercial NO se puede vaciar;
--   · el tenant se deriva server-side aunque el patch traiga business_id;
--   · crear la fila de settings NO borra el logo (trigger de sincro);
--   · la reparación histórica es idempotente, no pisa datos reales y excluye
--     el placeholder técnico 'Mi Negocio'.
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
  v_tech_a  uuid := gen_random_uuid();
  v_owner_b uuid := gen_random_uuid();
  v_biz_a   uuid;
  v_biz_b   uuid;
BEGIN
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    (v_owner_a, 'onb1_owner_a@invalid.test', now()),
    (v_tech_a,  'onb1_tech_a@invalid.test',  now()),
    (v_owner_b, 'onb1_owner_b@invalid.test', now());

  INSERT INTO public.businesses (name, owner_user_id) VALUES ('Taller A', v_owner_a)
    RETURNING id INTO v_biz_a;
  INSERT INTO public.businesses (name, owner_user_id) VALUES ('Taller B', v_owner_b)
    RETURNING id INTO v_biz_b;

  INSERT INTO public.profiles (id, business_id, role, is_active, email) VALUES
    (v_owner_a, v_biz_a, 'owner', true, 'onb1_owner_a@invalid.test'),
    (v_tech_a,  v_biz_a, 'tech',  true, 'onb1_tech_a@invalid.test'),
    (v_owner_b, v_biz_b, 'owner', true, 'onb1_owner_b@invalid.test');

  PERFORM set_config('test.owner_a', v_owner_a::text, false);
  PERFORM set_config('test.tech_a',  v_tech_a::text,  false);
  PERFORM set_config('test.owner_b', v_owner_b::text, false);
  PERFORM set_config('test.biz_a',   v_biz_a::text,   false);
  PERFORM set_config('test.biz_b',   v_biz_b::text,   false);
  RAISE NOTICE 'Fixtures OK · A=% · B=%', v_biz_a, v_biz_b;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1 · EL DEFECTO CENTRAL: el nombre llega a donde leen los documentos
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_res jsonb; v_nom text; v_name text;
BEGIN
  PERFORM pg_temp.como(current_setting('test.owner_a')::uuid);
  v_res := public.update_my_business_profile(
    jsonb_build_object('nombre_comercial', '  Tecno Reparaciones  ', 'rubro', 'celulares'));
  PERFORM pg_temp.anonimo();

  SELECT s.nombre_comercial INTO v_nom
    FROM public.business_settings s WHERE s.business_id = current_setting('test.biz_a')::uuid;
  SELECT b.name INTO v_name
    FROM public.businesses b WHERE b.id = current_setting('test.biz_a')::uuid;

  -- LA AUTORIDAD. Es la columna que imprimen ComprobanteDocumento,
  -- ComprobantePrintLayout, ServiceOrderPrint y WarrantyPrintLayout.
  IF v_nom IS DISTINCT FROM 'Tecno Reparaciones' THEN
    RAISE EXCEPTION '1 FAIL: nombre_comercial = % (esperado "Tecno Reparaciones", con trim)', quote_nullable(v_nom);
  END IF;
  -- EL ESPEJO, atómico. Si esto diverge, el shell y los documentos muestran
  -- nombres distintos — que es el defecto que este lote cierra.
  IF v_name IS DISTINCT FROM 'Tecno Reparaciones' THEN
    RAISE EXCEPTION '1 FAIL: businesses.name = % (espejo roto)', quote_nullable(v_name);
  END IF;
  IF v_res->>'nombre_comercial' <> 'Tecno Reparaciones' THEN
    RAISE EXCEPTION '1 FAIL: la RPC no devolvió el estado nuevo';
  END IF;
  RAISE NOTICE '1 OK · nombre_comercial es autoridad y businesses.name su espejo';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2 · EL WRAPPER LEGACY ESCRIBE CANÓNICAMENTE
--     Es la prueba que habilita el rollout DB-first: el frontend productivo,
--     sin redesplegarse, deja de escribir sólo en `businesses`.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_s record; v_b record;
BEGIN
  PERFORM pg_temp.como(current_setting('test.owner_b')::uuid);
  PERFORM public.update_my_business_onboarding(
    p_name    => 'Celu Express',
    p_rubro   => 'celulares',
    p_ciudad  => 'Villa María',
    p_whatsapp=> '353 111-2222',
    p_cuit    => '20-12345678-9',
    p_condicion_fiscal => 'monotributo'
  );
  PERFORM pg_temp.anonimo();

  SELECT nombre_comercial, localidad, telefono, cuit, condicion_iva INTO v_s
    FROM public.business_settings WHERE business_id = current_setting('test.biz_b')::uuid;
  SELECT name, ciudad, wholesale_whatsapp INTO v_b
    FROM public.businesses WHERE id = current_setting('test.biz_b')::uuid;

  -- LO NUEVO: la RPC vieja ahora puebla las columnas canónicas.
  IF v_s.nombre_comercial IS DISTINCT FROM 'Celu Express' THEN
    RAISE EXCEPTION '2 FAIL: el wrapper legacy NO escribió nombre_comercial (= %)', quote_nullable(v_s.nombre_comercial);
  END IF;
  IF v_s.localidad IS DISTINCT FROM 'Villa María' THEN
    RAISE EXCEPTION '2 FAIL: el wrapper legacy NO escribió localidad (= %)', quote_nullable(v_s.localidad);
  END IF;
  IF v_s.telefono IS DISTINCT FROM '3531112222' THEN
    RAISE EXCEPTION '2 FAIL: el wrapper legacy NO escribió telefono (= %)', quote_nullable(v_s.telefono);
  END IF;

  -- LO VIEJO sigue igual: los espejos que el frontend desplegado lee.
  IF v_b.name <> 'Celu Express'  THEN RAISE EXCEPTION '2 FAIL: espejo name'; END IF;
  IF v_b.ciudad <> 'Villa María' THEN RAISE EXCEPTION '2 FAIL: espejo ciudad'; END IF;
  IF v_b.wholesale_whatsapp <> '3531112222' THEN
    RAISE EXCEPTION '2 FAIL: no se sembró wholesale_whatsapp (= %)', quote_nullable(v_b.wholesale_whatsapp);
  END IF;
  IF v_s.cuit <> '20123456789' THEN RAISE EXCEPTION '2 FAIL: cuit sin normalizar: %', v_s.cuit; END IF;
  IF v_s.condicion_iva <> 'monotributo' THEN RAISE EXCEPTION '2 FAIL: condicion %', v_s.condicion_iva; END IF;

  RAISE NOTICE '2 OK · el wrapper legacy (firma intacta) escribe canónicamente';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3 · `wholesale_whatsapp` se SIEMBRA pero NUNCA se pisa
--     Es del portal mayorista: un número puesto a propósito gana sobre el
--     teléfono general del negocio.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_wa text; v_tel text;
BEGIN
  -- El negocio B ya tiene wholesale_whatsapp = '3531112222' del caso 2.
  PERFORM pg_temp.como(current_setting('test.owner_b')::uuid);
  PERFORM public.update_my_business_profile(jsonb_build_object('telefono', '351 999-8888'));
  PERFORM pg_temp.anonimo();

  SELECT b.wholesale_whatsapp INTO v_wa FROM public.businesses b
   WHERE b.id = current_setting('test.biz_b')::uuid;
  SELECT s.telefono INTO v_tel FROM public.business_settings s
   WHERE s.business_id = current_setting('test.biz_b')::uuid;

  IF v_tel <> '3519998888' THEN
    RAISE EXCEPTION '3 FAIL: telefono no se actualizó (= %)', quote_nullable(v_tel);
  END IF;
  IF v_wa <> '3531112222' THEN
    RAISE EXCEPTION '3 FAIL: se PISÓ el número del portal mayorista (= %)', quote_nullable(v_wa);
  END IF;
  RAISE NOTICE '3 OK · telefono es canónico; wholesale_whatsapp se siembra pero no se pisa';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4 · CONDICIÓN FISCAL — slugs, traducción de labels legacy, rechazo de basura
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_c text; v_err text;
BEGIN
  PERFORM pg_temp.como(current_setting('test.owner_a')::uuid);

  -- (a) La etiqueta legacy de Settings se TRADUCE al slug canónico. Sin esto,
  --     un guardado desde la pantalla vieja violaría el CHECK.
  PERFORM public.update_my_business_profile(jsonb_build_object('condicion_iva', 'Responsable Inscripto'));
  SELECT condicion_iva INTO v_c FROM public.business_settings
   WHERE business_id = current_setting('test.biz_a')::uuid;
  IF v_c <> 'responsable_inscripto' THEN
    RAISE EXCEPTION '4a FAIL: label legacy no traducida (= %)', quote_nullable(v_c); END IF;

  -- (b) 'Responsable Monotributo' y 'Monotributo' son LO MISMO.
  PERFORM public.update_my_business_profile(jsonb_build_object('condicion_iva', 'Responsable Monotributo'));
  SELECT condicion_iva INTO v_c FROM public.business_settings
   WHERE business_id = current_setting('test.biz_a')::uuid;
  IF v_c <> 'monotributo' THEN
    RAISE EXCEPTION '4b FAIL: Responsable Monotributo -> % ', quote_nullable(v_c); END IF;

  -- (c) 'Monotributista Social' NO se colapsa contra monotributo: en ARCA son
  --     códigos distintos (13 vs 6) y fusionarlos perdería semántica fiscal.
  PERFORM public.update_my_business_profile(jsonb_build_object('condicion_iva', 'Monotributista Social'));
  SELECT condicion_iva INTO v_c FROM public.business_settings
   WHERE business_id = current_setting('test.biz_a')::uuid;
  IF v_c <> 'monotributista_social' THEN
    RAISE EXCEPTION '4c FAIL: Monotributista Social perdió semántica (-> %)', quote_nullable(v_c); END IF;

  -- (d) Basura: se RECHAZA. Lo importante es que NO borre el dato anterior —
  --     un normalizador que devuelve NULL ante lo desconocido, sin este guard,
  --     convertiría un typo en un borrado silencioso.
  BEGIN
    PERFORM public.update_my_business_profile(jsonb_build_object('condicion_iva', 'Responsable Marciano'));
    RAISE EXCEPTION '4d FAIL: se aceptó una condición fiscal inexistente';
  EXCEPTION WHEN sqlstate 'TRIVF' THEN NULL;
  END;
  SELECT condicion_iva INTO v_c FROM public.business_settings
   WHERE business_id = current_setting('test.biz_a')::uuid;
  IF v_c <> 'monotributista_social' THEN
    RAISE EXCEPTION '4d FAIL: el rechazo BORRÓ el dato anterior (= %)', quote_nullable(v_c); END IF;

  -- (e) Vacío explícito SÍ borra: es el contrato de tres estados.
  PERFORM public.update_my_business_profile(jsonb_build_object('condicion_iva', ''));
  SELECT condicion_iva INTO v_c FROM public.business_settings
   WHERE business_id = current_setting('test.biz_a')::uuid;
  IF v_c IS NOT NULL THEN
    RAISE EXCEPTION '4e FAIL: cadena vacía no borró (= %)', quote_nullable(v_c); END IF;

  PERFORM pg_temp.anonimo();
  RAISE NOTICE '4 OK · slugs canónicos, labels traducidas, basura rechazada sin borrar';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5 · CONTRATO DE TRES ESTADOS: ausente / con valor / vacío
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_s record;
BEGIN
  PERFORM pg_temp.como(current_setting('test.owner_a')::uuid);
  PERFORM public.update_my_business_profile(jsonb_build_object(
    'razon_social', 'Tecno Reparaciones SRL', 'provincia', 'Córdoba', 'codigo_postal', '5000'));

  -- Un patch que NO menciona `provincia` no puede tocarla. Es lo que permite
  -- guardar paso por paso sin que un paso pise al anterior.
  PERFORM public.update_my_business_profile(jsonb_build_object('email', 'hola@invalid.test'));
  SELECT razon_social, provincia, codigo_postal, email INTO v_s
    FROM public.business_settings WHERE business_id = current_setting('test.biz_a')::uuid;
  IF v_s.provincia IS DISTINCT FROM 'Córdoba' THEN
    RAISE EXCEPTION '5 FAIL: clave ausente pisó provincia (= %)', quote_nullable(v_s.provincia); END IF;
  IF v_s.razon_social IS DISTINCT FROM 'Tecno Reparaciones SRL' THEN
    RAISE EXCEPTION '5 FAIL: clave ausente pisó razon_social'; END IF;
  IF v_s.email IS DISTINCT FROM 'hola@invalid.test' THEN
    RAISE EXCEPTION '5 FAIL: no se escribió email'; END IF;

  -- Clave presente vacía = borrar.
  PERFORM public.update_my_business_profile(jsonb_build_object('provincia', ''));
  SELECT provincia INTO v_s FROM public.business_settings
   WHERE business_id = current_setting('test.biz_a')::uuid;
  IF v_s.provincia IS NOT NULL THEN
    RAISE EXCEPTION '5 FAIL: vacío no borró provincia'; END IF;

  PERFORM pg_temp.anonimo();
  RAISE NOTICE '5 OK · ausente = no tocar, vacío = borrar';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6 · EL NOMBRE COMERCIAL NO SE PUEDE VACIAR
--     `businesses.name` es NOT NULL y el nombre es la autoridad: un negocio
--     sin nombre no es un estado válido.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_nom text;
BEGIN
  PERFORM pg_temp.como(current_setting('test.owner_a')::uuid);
  BEGIN
    PERFORM public.update_my_business_profile(jsonb_build_object('nombre_comercial', '   '));
    RAISE EXCEPTION '6 FAIL: se aceptó vaciar el nombre comercial';
  EXCEPTION WHEN sqlstate 'TRIVN' THEN NULL;
  END;
  SELECT nombre_comercial INTO v_nom FROM public.business_settings
   WHERE business_id = current_setting('test.biz_a')::uuid;
  IF v_nom IS DISTINCT FROM 'Tecno Reparaciones' THEN
    RAISE EXCEPTION '6 FAIL: el rechazo dejó el nombre en % ', quote_nullable(v_nom); END IF;
  PERFORM pg_temp.anonimo();
  RAISE NOTICE '6 OK · el nombre comercial no se puede vaciar';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7 · MULTITENANT — el tenant NO viaja en el patch
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_nom_a text; v_nom_b text; v_n int;
BEGIN
  -- (a) Ninguna RPC pública acepta business_id en la firma.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('get_my_business_onboarding','update_my_business_onboarding',
                       'get_my_business_profile','update_my_business_profile')
     AND pg_get_function_identity_arguments(p.oid) ILIKE '%business_id%';
  IF v_n > 0 THEN RAISE EXCEPTION '7a FAIL: % RPC acepta business_id', v_n; END IF;

  -- (b) Aunque el patch lo traiga, se ignora: el owner de A no puede renombrar B.
  PERFORM pg_temp.como(current_setting('test.owner_a')::uuid);
  PERFORM public.update_my_business_profile(jsonb_build_object(
    'business_id', current_setting('test.biz_b'),
    'nombre_comercial', 'SECUESTRADO'));
  PERFORM pg_temp.anonimo();

  SELECT nombre_comercial INTO v_nom_b FROM public.business_settings
   WHERE business_id = current_setting('test.biz_b')::uuid;
  SELECT nombre_comercial INTO v_nom_a FROM public.business_settings
   WHERE business_id = current_setting('test.biz_a')::uuid;

  IF v_nom_b = 'SECUESTRADO' THEN
    RAISE EXCEPTION '7b FAIL: CROSS-TENANT — el patch pudo elegir el negocio'; END IF;
  IF v_nom_b IS DISTINCT FROM 'Celu Express' THEN
    RAISE EXCEPTION '7b FAIL: el negocio B cambió (= %)', quote_nullable(v_nom_b); END IF;
  -- La otra mitad de la prueba: la escritura SÍ ocurrió, pero sobre el negocio
  -- del ACTOR. El `business_id` del patch no se rechaza, se ignora — que es lo
  -- que hace imposible el cross-tenant por construcción y no por chequeo.
  IF v_nom_a IS DISTINCT FROM 'SECUESTRADO' THEN
    RAISE EXCEPTION '7b FAIL: el patch no escribió sobre el negocio del actor (= %)', quote_nullable(v_nom_a);
  END IF;

  -- Se restaura para los casos siguientes.
  PERFORM pg_temp.como(current_setting('test.owner_a')::uuid);
  PERFORM public.update_my_business_profile(jsonb_build_object('nombre_comercial', 'Tecno Reparaciones'));
  PERFORM pg_temp.anonimo();

  -- (c) El esquema del writer canónico no es alcanzable desde el cliente.
  IF has_schema_privilege('authenticated','private','USAGE')
     OR has_schema_privilege('anon','private','USAGE') THEN
    RAISE EXCEPTION '7c FAIL: el esquema private quedó expuesto'; END IF;

  RAISE NOTICE '7 OK · tenant derivado server-side, patch.business_id ignorado';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8 · RBAC y fail-closed
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_nom text; v_p jsonb;
BEGIN
  -- tech LEE pero no escribe.
  PERFORM pg_temp.como(current_setting('test.tech_a')::uuid);
  v_p := public.get_my_business_profile();
  IF (v_p->>'can_edit')::boolean THEN RAISE EXCEPTION '8 FAIL: tech con can_edit=true'; END IF;
  BEGIN
    PERFORM public.update_my_business_profile(jsonb_build_object('nombre_comercial', 'Hackeado'));
    RAISE EXCEPTION '8 FAIL: tech pudo escribir el perfil';
  EXCEPTION WHEN sqlstate '42501' THEN NULL;
  END;

  -- Sin sesión: fail-closed en las cuatro.
  PERFORM pg_temp.anonimo();
  BEGIN
    PERFORM public.update_my_business_profile(jsonb_build_object('nombre_comercial', 'Anon'));
    RAISE EXCEPTION '8 FAIL: anónimo pudo escribir';
  EXCEPTION WHEN sqlstate '42501' THEN NULL;
  END;
  BEGIN
    PERFORM public.get_my_business_profile();
    RAISE EXCEPTION '8 FAIL: anónimo pudo leer';
  EXCEPTION WHEN sqlstate '42501' THEN NULL;
  END;

  SELECT nombre_comercial INTO v_nom FROM public.business_settings
   WHERE business_id = current_setting('test.biz_a')::uuid;
  IF v_nom <> 'Tecno Reparaciones' THEN RAISE EXCEPTION '8 FAIL: el perfil cambió'; END IF;
  RAISE NOTICE '8 OK · tech lee y no escribe; anónimo fail-closed';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 9 · EL TRIGGER DEL LOGO NO PUEDE BORRAR UN LOGO
--     `trigger_sync_business_logo_url` dispara en TODO INSERT sobre
--     business_settings y replica logo_url -> businesses. Crear la fila sin
--     logo_url le escribiría NULL a `businesses` y BORRARÍA el logo.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_uid uuid := gen_random_uuid();
  v_biz uuid;
  v_logo_biz text; v_logo_set text;
BEGIN
  INSERT INTO auth.users (id, email, email_confirmed_at)
    VALUES (v_uid, 'onb1_logo@invalid.test', now());
  -- Negocio CON logo y SIN fila de business_settings: exactamente la forma que
  -- tienen 18 de los 30 negocios productivos.
  INSERT INTO public.businesses (name, owner_user_id, logo_url)
    VALUES ('Con Logo', v_uid, 'https://cdn.invalid/logo.png') RETURNING id INTO v_biz;
  INSERT INTO public.profiles (id, business_id, role, is_active, email)
    VALUES (v_uid, v_biz, 'owner', true, 'onb1_logo@invalid.test');

  PERFORM pg_temp.como(v_uid);
  -- Se guarda SÓLO el CUIT. El patch no menciona el logo.
  PERFORM public.update_my_business_profile(jsonb_build_object('cuit', '20-12345678-9'));
  PERFORM pg_temp.anonimo();

  SELECT b.logo_url INTO v_logo_biz FROM public.businesses b WHERE b.id = v_biz;
  SELECT s.logo_url INTO v_logo_set FROM public.business_settings s WHERE s.business_id = v_biz;

  IF v_logo_biz IS DISTINCT FROM 'https://cdn.invalid/logo.png' THEN
    RAISE EXCEPTION '9 FAIL: guardar el CUIT BORRÓ el logo del negocio (= %)', quote_nullable(v_logo_biz);
  END IF;
  IF v_logo_set IS DISTINCT FROM 'https://cdn.invalid/logo.png' THEN
    RAISE EXCEPTION '9 FAIL: la fila nueva de settings no heredó el logo (= %)', quote_nullable(v_logo_set);
  END IF;
  RAISE NOTICE '9 OK · crear la fila de settings no borra el logo';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 10 · REPARACIÓN HISTÓRICA — se re-ejecuta la lógica sobre fixtures nuevos
--      La migración ya corrió sobre los datos que existían al aplicarla. Acá se
--      verifica el COMPORTAMIENTO de la reparación con casos construidos.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_u1 uuid := gen_random_uuid(); v_u2 uuid := gen_random_uuid();
  v_u3 uuid := gen_random_uuid(); v_u4 uuid := gen_random_uuid();
  v_b1 uuid; v_b2 uuid; v_b3 uuid; v_b4 uuid;
  v_r  record;
  v_n  int;
BEGIN
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    (v_u1,'onb1_r1@invalid.test',now()), (v_u2,'onb1_r2@invalid.test',now()),
    (v_u3,'onb1_r3@invalid.test',now()), (v_u4,'onb1_r4@invalid.test',now());

  -- b1: nombre real, SIN fila de settings          -> se repara (INSERT)
  INSERT INTO public.businesses (name, owner_user_id, ciudad, wholesale_whatsapp)
    VALUES ('Reparame', v_u1, 'Río Cuarto', '3584445555') RETURNING id INTO v_b1;
  -- b2: PLACEHOLDER técnico                        -> NO se repara
  INSERT INTO public.businesses (name, owner_user_id) VALUES ('Mi Negocio', v_u2)
    RETURNING id INTO v_b2;
  -- b3: ya tiene nombre_comercial REAL             -> NO se pisa
  INSERT INTO public.businesses (name, owner_user_id) VALUES ('Nombre Viejo', v_u3)
    RETURNING id INTO v_b3;
  INSERT INTO public.business_settings (business_id, nombre_comercial)
    VALUES (v_b3, 'Nombre Canónico Real');
  -- b4: logo sólo en businesses                    -> se repara la divergencia
  INSERT INTO public.businesses (name, owner_user_id, logo_url)
    VALUES ('Con Logo Divergente', v_u4, 'https://cdn.invalid/x.png') RETURNING id INTO v_b4;
  INSERT INTO public.business_settings (business_id, nombre_comercial, logo_url)
    VALUES (v_b4, 'Con Logo Divergente', NULL);
  -- El INSERT de arriba disparó el trigger de sincro y le borró el logo a
  -- `businesses`. Se repone para construir la divergencia que se quiere probar.
  UPDATE public.businesses SET logo_url = 'https://cdn.invalid/x.png' WHERE id = v_b4;

  -- ── La MISMA lógica de la migración ────────────────────────────────────────
  INSERT INTO public.business_settings AS s (business_id, nombre_comercial, localidad, telefono, logo_url)
  SELECT b.id,
         CASE WHEN btrim(b.name) <> 'Mi Negocio' THEN nullif(btrim(b.name), '') END,
         nullif(btrim(coalesce(b.ciudad, '')), ''),
         nullif(regexp_replace(coalesce(b.wholesale_whatsapp, ''), '[^0-9]', '', 'g'), ''),
         nullif(btrim(coalesce(b.logo_url, '')), '')
    FROM public.businesses b
   WHERE NOT EXISTS (SELECT 1 FROM public.business_settings x WHERE x.business_id = b.id)
     AND ( (nullif(btrim(b.name),'') IS NOT NULL AND btrim(b.name) <> 'Mi Negocio')
        OR nullif(btrim(coalesce(b.ciudad,'')),'') IS NOT NULL
        OR nullif(btrim(coalesce(b.wholesale_whatsapp,'')),'') IS NOT NULL )
  ON CONFLICT (business_id) DO NOTHING;

  UPDATE public.business_settings s
     SET nombre_comercial = CASE WHEN nullif(btrim(coalesce(s.nombre_comercial,'')),'') IS NULL
                                  AND nullif(btrim(b.name),'') IS NOT NULL
                                  AND btrim(b.name) <> 'Mi Negocio'
                                 THEN btrim(b.name) ELSE s.nombre_comercial END,
         localidad        = CASE WHEN nullif(btrim(coalesce(s.localidad,'')),'') IS NULL
                                  AND nullif(btrim(coalesce(b.ciudad,'')),'') IS NOT NULL
                                 THEN btrim(b.ciudad) ELSE s.localidad END,
         telefono         = CASE WHEN nullif(btrim(coalesce(s.telefono,'')),'') IS NULL
                                  AND nullif(btrim(coalesce(b.wholesale_whatsapp,'')),'') IS NOT NULL
                                 THEN regexp_replace(b.wholesale_whatsapp,'[^0-9]','','g') ELSE s.telefono END,
         logo_url         = CASE WHEN nullif(btrim(coalesce(s.logo_url,'')),'') IS NULL
                                  AND nullif(btrim(coalesce(b.logo_url,'')),'') IS NOT NULL
                                 THEN btrim(b.logo_url) ELSE s.logo_url END
    FROM public.businesses b
   WHERE b.id = s.business_id;

  -- ── Aserciones ────────────────────────────────────────────────────────────
  SELECT nombre_comercial, localidad, telefono INTO v_r
    FROM public.business_settings WHERE business_id = v_b1;
  IF v_r.nombre_comercial IS DISTINCT FROM 'Reparame' THEN
    RAISE EXCEPTION '10a FAIL: no se reparó el nombre (= %)', quote_nullable(v_r.nombre_comercial); END IF;
  IF v_r.localidad IS DISTINCT FROM 'Río Cuarto' THEN
    RAISE EXCEPTION '10a FAIL: no se reparó la localidad'; END IF;
  IF v_r.telefono IS DISTINCT FROM '3584445555' THEN
    RAISE EXCEPTION '10a FAIL: no se reparó el teléfono'; END IF;

  -- LA EXCLUSIÓN CRÍTICA. Copiar el placeholder lo convertiría en un nombre
  -- «real» y lo imprimiría en comprobantes — el daño exacto que se viene a
  -- cerrar. El negocio queda SIN nombre comercial, que es la verdad.
  SELECT nombre_comercial INTO v_r.nombre_comercial
    FROM public.business_settings WHERE business_id = v_b2;
  IF v_r.nombre_comercial IS NOT NULL THEN
    RAISE EXCEPTION '10b FAIL: se copió el placeholder "Mi Negocio" (= %)', quote_nullable(v_r.nombre_comercial); END IF;

  -- NUNCA se pisa un dato canónico existente.
  SELECT nombre_comercial INTO v_r.nombre_comercial
    FROM public.business_settings WHERE business_id = v_b3;
  IF v_r.nombre_comercial IS DISTINCT FROM 'Nombre Canónico Real' THEN
    RAISE EXCEPTION '10c FAIL: la reparación PISÓ un nombre real (= %)', quote_nullable(v_r.nombre_comercial); END IF;

  SELECT logo_url INTO v_r.nombre_comercial
    FROM public.business_settings WHERE business_id = v_b4;
  IF v_r.nombre_comercial IS DISTINCT FROM 'https://cdn.invalid/x.png' THEN
    RAISE EXCEPTION '10d FAIL: no se reparó el logo divergente (= %)', quote_nullable(v_r.nombre_comercial); END IF;

  -- IDEMPOTENCIA: segunda pasada, 0 filas.
  WITH segunda AS (
    UPDATE public.business_settings s SET nombre_comercial = btrim(b.name)
      FROM public.businesses b
     WHERE b.id = s.business_id
       AND nullif(btrim(coalesce(s.nombre_comercial,'')),'') IS NULL
       AND nullif(btrim(b.name),'') IS NOT NULL
       AND btrim(b.name) <> 'Mi Negocio'
    RETURNING 1)
  SELECT count(*) INTO v_n FROM segunda;
  IF v_n <> 0 THEN RAISE EXCEPTION '10e FAIL: la reparación NO es idempotente (% filas)', v_n; END IF;

  -- Cero placeholders como nombre comercial en toda la tabla.
  SELECT count(*) INTO v_n FROM public.business_settings
   WHERE btrim(coalesce(nombre_comercial,'')) = 'Mi Negocio';
  IF v_n > 0 THEN RAISE EXCEPTION '10f FAIL: % filas con el placeholder como nombre', v_n; END IF;

  RAISE NOTICE '10 OK · reparación: repara, excluye el placeholder, no pisa, idempotente';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 11 · CHECK de condicion_iva y ausencia de DEFAULT
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_n int; v_biz uuid := current_setting('test.biz_a')::uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid='public.business_settings'::regclass
                    AND conname='business_settings_condicion_iva_check') THEN
    RAISE EXCEPTION '11 FAIL: falta el CHECK de condicion_iva'; END IF;

  -- El CHECK es la última línea: aunque alguien escribiera por fuera del writer,
  -- una etiqueta de UI no puede entrar a la columna.
  BEGIN
    UPDATE public.business_settings SET condicion_iva = 'Responsable Inscripto' WHERE business_id = v_biz;
    RAISE EXCEPTION '11 FAIL: el CHECK aceptó una etiqueta de UI';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='business_settings'
                AND column_name='condicion_iva' AND column_default IS NOT NULL) THEN
    RAISE EXCEPTION '11 FAIL: condicion_iva conserva un DEFAULT (declaraba RI a todo el mundo)'; END IF;

  SELECT count(*) INTO v_n FROM public.business_settings
   WHERE condicion_iva IS NOT NULL
     AND condicion_iva NOT IN ('responsable_inscripto','monotributo','monotributista_social','exento','consumidor_final');
  IF v_n > 0 THEN RAISE EXCEPTION '11 FAIL: % filas fuera de la allowlist', v_n; END IF;

  RAISE NOTICE '11 OK · CHECK instalado, sin DEFAULT, historia normalizada';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 12 · CONTRATO LEGACY DE LECTURA — aditivo, ninguna clave desaparece
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_o jsonb; k text;
BEGIN
  PERFORM pg_temp.como(current_setting('test.owner_a')::uuid);
  -- Se carga una localidad para poder aseverar el mapeo legacy `ciudad`.
  PERFORM public.update_my_business_profile(jsonb_build_object('localidad', 'Alta Gracia'));
  v_o := public.get_my_business_onboarding();
  PERFORM pg_temp.anonimo();

  -- Son exactamente las claves que mapea businessSetupService.mapear() en el
  -- frontend DESPLEGADO. Si alguna faltara, el wizard viejo rompería.
  FOREACH k IN ARRAY ARRAY['business_id','name','rubro','ciudad','whatsapp','logo_url',
                           'onboarding_completed','cuit','condicion_fiscal','role','can_edit']
  LOOP
    IF NOT (v_o ? k) THEN
      RAISE EXCEPTION '12 FAIL: el contrato legacy perdió la clave "%"', k; END IF;
  END LOOP;

  -- `name` resuelve por la AUTORIDAD, no por el espejo.
  IF v_o->>'name' <> 'Tecno Reparaciones' THEN
    RAISE EXCEPTION '12 FAIL: name legacy = %', v_o->>'name'; END IF;
  -- `ciudad` legacy sale de `localidad`, que es donde ahora vive el dato. El
  -- frontend desplegado lee esta clave y no sabe que la columna cambió.
  IF v_o->>'ciudad' IS DISTINCT FROM 'Alta Gracia' THEN
    RAISE EXCEPTION '12 FAIL: ciudad legacy = % (esperado "Alta Gracia" desde localidad)', quote_nullable(v_o->>'ciudad'); END IF;

  RAISE NOTICE '12 OK · el contrato legacy de lectura es aditivo';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 13 · NO HAY OVERLOAD — la trampa de PGRST203
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='update_my_business_onboarding';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '13 FAIL: hay % update_my_business_onboarding — PostgREST no puede desambiguar', v_n; END IF;

  -- La firma desplegada, byte a byte. Es lo que llama el frontend productivo.
  IF to_regprocedure('public.update_my_business_onboarding(text,text,text,text,text,text,text,boolean)') IS NULL THEN
    RAISE EXCEPTION '13 FAIL: cambió la firma legacy — el frontend viejo recibiría PGRST202'; END IF;

  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='update_my_business_profile';
  IF v_n <> 1 THEN RAISE EXCEPTION '13 FAIL: hay % update_my_business_profile', v_n; END IF;

  RAISE NOTICE '13 OK · sin overloads, firma legacy intacta';
END $$;

ROLLBACK;
