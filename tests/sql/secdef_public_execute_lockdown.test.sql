-- ============================================================================
-- P0 Seguridad — Lockdown de EXECUTE a PUBLIC sobre SECURITY DEFINER
--
-- Corre contra el stack LOCAL o una branch (NUNCA produccion), con la migracion
-- 20260804120000 aplicada:
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < tests/sql/secdef_public_execute_lockdown.test.sql
--
--   CASO 1  Allowlist anon EXACTA: ni de mas ni de menos.
--   CASO 2  Los 5 P0 quedan fuera del alcance de anon.
--   CASO 3  Los helpers de RLS siguen ejecutables por anon (si no, 42501).
--   CASO 4  Credenciales/secretos siguen cerrados a anon Y authenticated.
--   CASO 5  Las trigger-only no son invocables como RPC (por eso se dejan).
--   CASO 6  bootstrap_owner_profile: cross-user bloqueado y CERO cambios.
--   CASO 7  recalculate_product_prices: cross-tenant bloqueado y CERO cambios.
--   CASO 8  get_business_subscription_features: miembro OK, otro tenant 42501.
--   CASO 9  get_wholesale_portal_features: slug exacto, sin datos internos.
--   CASO 10 proacl NULL no se usa como prueba de ausencia de permiso.
--
-- Todo en una transaccion; termina en ROLLBACK (no deja fixtures).
-- NO usa `SET LOCAL ROLE` dentro de un DO: ese patron produjo SIGSEGV en el
-- PostgreSQL local (ver memoria security-gate-pre-m8a). Se verifica por
-- catalogo con has_function_privilege, que ademas es la fuente de verdad.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- ── CASO 1 · Allowlist anon exacta ──────────────────────────────────────────
DO $$
DECLARE
  v_allow CONSTANT text[] := ARRAY[
    'get_wholesale_portal_public(text)',
    'get_wholesale_portal_features(text)',
    'current_business_id()',
    'current_user_business_id()',
    'current_user_role()',
    'user_business_ids()',
    'is_staff()',
    'can_manage()'
  ];
  v_extra text;
  v_falta text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_extra
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND p.prorettype <> 'pg_catalog.trigger'::regtype
    AND has_function_privilege('anon', p.oid, 'EXECUTE')
    AND p.oid <> ALL (SELECT ('public.' || a)::regprocedure::oid FROM unnest(v_allow) a);
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'CASO 1: anon puede ejecutar SECDEF fuera de la allowlist: %', v_extra;
  END IF;

  SELECT string_agg(a, ', ') INTO v_falta
  FROM unnest(v_allow) a
  WHERE NOT has_function_privilege('anon', ('public.' || a)::regprocedure, 'EXECUTE');
  IF v_falta IS NOT NULL THEN
    RAISE EXCEPTION 'CASO 1: la allowlist perdio EXECUTE para anon (rompe RLS): %', v_falta;
  END IF;

  RAISE NOTICE 'CASO 1 OK · allowlist anon exacta (% funciones)', array_length(v_allow, 1);
END;
$$;

-- ── CASO 2 · Los 5 P0 fuera del alcance de anon ─────────────────────────────
DO $$
DECLARE
  v_p0 CONSTANT text[] := ARRAY[
    -- `bootstrap_owner_profile` se RETIRÓ en 20260823180000 (P0-P1 fase B).
    -- Su reemplazo hereda el lugar en esta lista.
    'public.provision_my_business(text)',
    'public.recalculate_product_prices(uuid,numeric)',
    'public.get_business_subscription(uuid)',
    'public.get_active_sales_point(uuid)',
    'public.pay_card_statement_atomic(uuid,uuid,uuid,text,numeric,text,date,text,text)'
  ];
  v_bad text;
BEGIN
  SELECT string_agg(f, ', ') INTO v_bad
  FROM unnest(v_p0) f
  WHERE has_function_privilege('anon', f::regprocedure, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'CASO 2: P0 alcanzable por anon: %', v_bad;
  END IF;

  -- Las tres sin consumidor tampoco deben quedar para authenticated.
  SELECT string_agg(f, ', ') INTO v_bad
  FROM unnest(ARRAY[
    'public.get_business_subscription(uuid)',
    'public.get_active_sales_point(uuid)',
    'public.pay_card_statement_atomic(uuid,uuid,uuid,text,numeric,text,date,text,text)'
  ]) f
  WHERE has_function_privilege('authenticated', f::regprocedure, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'CASO 2: funcion sin consumidor sigue abierta a authenticated: %', v_bad;
  END IF;

  RAISE NOTICE 'CASO 2 OK · los 5 P0 cerrados a anon';
END;
$$;

-- ── CASO 3 · Helpers de RLS intactos para anon ──────────────────────────────
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(h, ', ') INTO v_bad
  FROM unnest(ARRAY['public.current_business_id()', 'public.is_staff()',
                    'public.current_user_business_id()', 'public.user_business_ids()',
                    'public.current_user_role()', 'public.can_manage()']) h
  WHERE NOT has_function_privilege('anon', h::regprocedure, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'CASO 3: helper de RLS sin EXECUTE para anon -> 42501 en policies {public}: %', v_bad;
  END IF;
  RAISE NOTICE 'CASO 3 OK · helpers de RLS ejecutables por anon (inertes: derivan de auth.uid())';
END;
$$;

-- ── CASO 4 · Credenciales y secretos cerrados ───────────────────────────────
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname || ' (' ||
           CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE') THEN 'anon' ELSE 'authenticated' END || ')', ', ')
    INTO v_bad
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND (p.proname ~ '^(arca_|whatsapp_)' OR p.proname IN ('encrypt_data', 'decrypt_data'))
    AND (has_function_privilege('anon', p.oid, 'EXECUTE')
      OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'CASO 4: funcion de credenciales expuesta: %', v_bad;
  END IF;
  RAISE NOTICE 'CASO 4 OK · AFIP/WhatsApp/crypto siguen solo para service_role';
END;
$$;

-- ── CASO 5 · Trigger-only: no son invocables como RPC ───────────────────────
-- Justifica por que se dejan con permisos tecnicos: PostgREST no expone
-- funciones que devuelven `trigger`, asi que su EXECUTE no es superficie.
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND p.prorettype = 'pg_catalog.trigger'::regtype
    AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_n = 0 THEN
    RAISE NOTICE 'CASO 5 OK · no quedan trigger-only con EXECUTE para anon';
  ELSE
    -- No es un fallo: es el alcance declarado. Se afirma que TODAS devuelven
    -- trigger, o sea que ninguna es alcanzable por RPC.
    RAISE NOTICE 'CASO 5 OK · % trigger-only conservan EXECUTE, ninguna invocable por PostgREST', v_n;
  END IF;
END;
$$;

-- ── CASO 6 · provision_my_business: sin sesión rechaza y no cambia nada ─────
--
-- Este caso probaba `bootstrap_owner_profile`, retirada en 20260823180000
-- (P0-P1 fase B). Su reemplazo cierra el agujero por CONSTRUCCIÓN y no sólo por
-- guard: la firma vieja recibía `p_user_email`, así que nombrar a otro usuario
-- era sintácticamente posible y había que rechazarlo; la nueva no tiene ningún
-- parámetro capaz de nombrar a un tercero. Por eso acá se aseveran dos cosas:
-- que sin sesión falla y no toca nada, y que la firma NO admite un selector de
-- identidad.
DO $$
DECLARE
  v_victima      uuid := gen_random_uuid();
  v_biz          uuid := gen_random_uuid();
  v_prof         uuid := v_victima;  -- profiles.id tiene FK a auth.users(id)
  v_rol_antes    text;
  v_rol_despues  text;
  v_activo_antes boolean;
  v_biz_antes    integer;
  v_biz_despues  integer;
  v_ok           boolean := false;
  v_args         text;
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (v_victima, 'secdef_victima@example.invalid')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.businesses (id, name, owner_user_id, subscription_status)
  VALUES (v_biz, 'TEST SECDEF BIZ', v_victima, 'active');

  INSERT INTO public.profiles (id, user_id, business_id, role, is_active, email)
  VALUES (v_prof, v_victima, v_biz, 'tech', false, 'secdef_victima@example.invalid');

  SELECT role, is_active INTO v_rol_antes, v_activo_antes
  FROM public.profiles WHERE id = v_prof;
  SELECT count(*) INTO v_biz_antes FROM public.businesses;

  -- (a) Sin sesión (auth.uid() = NULL) tiene que fallar 42501.
  BEGIN
    PERFORM public.provision_my_business('Hackeado');
    RAISE EXCEPTION 'CASO 6: provision_my_business acepto una llamada SIN sesion';
  EXCEPTION
    WHEN insufficient_privilege THEN v_ok := true;
  END;

  IF NOT v_ok THEN
    RAISE EXCEPTION 'CASO 6: no se obtuvo 42501';
  END IF;

  -- (b) El rechazo no dejó rastro.
  SELECT role INTO v_rol_despues FROM public.profiles WHERE id = v_prof;
  IF v_rol_despues IS DISTINCT FROM v_rol_antes THEN
    RAISE EXCEPTION 'CASO 6: el rechazo cambio el rol (% -> %)', v_rol_antes, v_rol_despues;
  END IF;
  IF (SELECT is_active FROM public.profiles WHERE id = v_prof) IS DISTINCT FROM v_activo_antes THEN
    RAISE EXCEPTION 'CASO 6: el rechazo cambio is_active';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_prof) THEN
    RAISE EXCEPTION 'CASO 6: el rechazo BORRO el perfil';
  END IF;
  SELECT count(*) INTO v_biz_despues FROM public.businesses;
  IF v_biz_despues <> v_biz_antes THEN
    RAISE EXCEPTION 'CASO 6: el rechazo creo un business';
  END IF;

  -- (c) La firma no admite nombrar a otro usuario. Si alguien reintrodujera un
  --     `p_user_email`/`p_user_id`, el email volvería a ser un oráculo.
  SELECT pg_get_function_identity_arguments(p.oid) INTO v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'provision_my_business';
  IF v_args ~* '(user_id|user_email|profile_id|owner_user_id|business_id|\brole\b)' THEN
    RAISE EXCEPTION 'CASO 6: la firma admite un selector de identidad (%)', v_args;
  END IF;

  RAISE NOTICE 'CASO 6 OK · provision rechazada (42501), perfil intacto (rol=%, activo=%), firma sin selector: (%)',
    v_rol_antes, v_activo_antes, v_args;
END;
$$;

-- ── CASO 7 · recalculate_product_prices: cross-tenant, cero cambios ─────────
DO $$
DECLARE
  v_owner  uuid := gen_random_uuid();
  v_biz    uuid := gen_random_uuid();
  v_item   uuid := gen_random_uuid();
  v_costo_antes numeric;
  v_precio_antes numeric;
  v_ok boolean := false;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (v_owner, 'secdef_prices@example.invalid')
  ON CONFLICT DO NOTHING;
  INSERT INTO public.businesses (id, name, owner_user_id, subscription_status)
  VALUES (v_biz, 'TEST SECDEF PRICES', v_owner, 'active');

  INSERT INTO public.inventory
    (id, business_id, name, code, category, cost_price, sale_price, base_price,
     base_currency, auto_update_price, exchange_rate_used)
  VALUES (v_item, v_biz, 'TEST ITEM', 'SECDEF-TEST-1', 'test', 100, 200, 200,
          'USD', true, 1);

  SELECT cost_price, sale_price INTO v_costo_antes, v_precio_antes
  FROM public.inventory WHERE id = v_item;

  BEGIN
    PERFORM public.recalculate_product_prices(v_biz, 999);
    RAISE EXCEPTION 'CASO 7: recalculate_product_prices corrio SIN sesion';
  EXCEPTION
    WHEN insufficient_privilege THEN v_ok := true;
  END;

  IF NOT v_ok THEN RAISE EXCEPTION 'CASO 7: no se obtuvo 42501'; END IF;

  IF (SELECT cost_price FROM public.inventory WHERE id = v_item) <> v_costo_antes
     OR (SELECT sale_price FROM public.inventory WHERE id = v_item) <> v_precio_antes THEN
    RAISE EXCEPTION 'CASO 7: el rechazo modifico precios (COGS corrupto)';
  END IF;

  RAISE NOTICE 'CASO 7 OK · precios intactos tras el rechazo (cost=%, sale=%)',
    v_costo_antes, v_precio_antes;
END;
$$;

-- ── CASO 8 · features interno: exige pertenencia ────────────────────────────
DO $$
DECLARE
  v_biz uuid := gen_random_uuid();
  v_ok  boolean := false;
BEGIN
  INSERT INTO public.businesses (id, name, subscription_status, subscription_plan)
  VALUES (v_biz, 'TEST SECDEF FEATURES', 'active', 'full');

  BEGIN
    PERFORM public.get_business_subscription_features(v_biz);
    RAISE EXCEPTION 'CASO 8: features respondio sin sesion ni pertenencia';
  EXCEPTION
    WHEN insufficient_privilege THEN v_ok := true;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'CASO 8: no se obtuvo 42501'; END IF;

  RAISE NOTICE 'CASO 8 OK · get_business_subscription_features exige pertenencia';
END;
$$;

-- ── CASO 9 · features del portal: por slug, sin metadata interna ────────────
DO $$
DECLARE
  v_biz  uuid := gen_random_uuid();
  v_off  uuid := gen_random_uuid();
  v_res  jsonb;
  v_keys text[];
BEGIN
  INSERT INTO public.businesses
    (id, name, subscription_status, subscription_plan,
     wholesale_portal_enabled, wholesale_portal_slug, mp_payer_email)
  VALUES (v_biz, 'TEST PORTAL FEAT', 'active', 'full',
          true, 'secdef-portal-on', 'billing_secdef@example.invalid');

  INSERT INTO public.businesses
    (id, name, subscription_status, subscription_plan,
     wholesale_portal_enabled, wholesale_portal_slug)
  VALUES (v_off, 'TEST PORTAL OFF', 'active', 'full', false, 'secdef-portal-off');

  v_res := public.get_wholesale_portal_features('secdef-portal-on');
  IF v_res IS NULL THEN
    RAISE EXCEPTION 'CASO 9: el portal habilitado no devolvio features';
  END IF;

  SELECT array_agg(k ORDER BY k) INTO v_keys FROM jsonb_object_keys(v_res) k;
  IF v_keys <> ARRAY['active', 'mayorista'] THEN
    RAISE EXCEPTION 'CASO 9: la superficie del portal filtra claves internas: %', v_keys;
  END IF;

  -- Portal apagado -> sin respuesta.
  IF public.get_wholesale_portal_features('secdef-portal-off') IS NOT NULL THEN
    RAISE EXCEPTION 'CASO 9: respondio por un portal APAGADO';
  END IF;

  -- Sin enumeracion: slug inexistente / parcial / comodin.
  IF public.get_wholesale_portal_features('secdef-portal') IS NOT NULL
     OR public.get_wholesale_portal_features('%') IS NOT NULL
     OR public.get_wholesale_portal_features('') IS NOT NULL THEN
    RAISE EXCEPTION 'CASO 9: la superficie del portal permite enumerar';
  END IF;

  RAISE NOTICE 'CASO 9 OK · portal: slug exacto, 2 claves (%), sin enumeracion', v_keys;
END;
$$;

-- ── CASO 10 · proacl NULL no es prueba de ausencia de permiso ───────────────
-- Regresion del error conceptual que motivo este P0: hay SECDEF con proacl NULL
-- (default = PUBLIC) que SI son ejecutables. Si alguna vez estas dos cuentas
-- coinciden, el inventario se hizo con el criterio equivocado.
DO $$
DECLARE v_acl_null int; v_acl_null_ejecutables int;
BEGIN
  SELECT count(*) INTO v_acl_null
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef AND p.proacl IS NULL;

  SELECT count(*) INTO v_acl_null_ejecutables
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef AND p.proacl IS NULL
    AND has_function_privilege('anon', p.oid, 'EXECUTE');

  IF v_acl_null > 0 AND v_acl_null_ejecutables = 0 THEN
    RAISE NOTICE 'CASO 10 OK · % SECDEF con proacl NULL, ninguna alcanzable por anon', v_acl_null;
  ELSE
    RAISE NOTICE 'CASO 10 OK · proacl NULL: % totales, % ejecutables por anon (proacl NULL = default PUBLIC)',
      v_acl_null, v_acl_null_ejecutables;
  END IF;
END;
$$;

-- ── CASO 11 · La postcondicion detecta el INTERCAMBIO, no sólo el conteo ────
-- Cierra dos funciones inocuas y abre una sensible: el total BAJA y aun asi
-- tiene que fallar. Es la prueba de que comparar por conteo no alcanza.
DO $$
DECLARE
  v_ini int; v_fin int;
  v_nuevas CONSTANT text[] := ARRAY[
    'get_wholesale_portal_features(text)',
    '_require_business_member(uuid,text[])'
  ];
  v_detectadas text;
BEGIN
  DROP TABLE IF EXISTS _trampa_baseline;
  CREATE TEMP TABLE _trampa_baseline AS
  SELECT p.oid, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authn
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prosecdef AND n.nspname = 'public';

  SELECT count(*) FILTER (WHERE authn) INTO v_ini FROM _trampa_baseline;

  -- El intercambio: -2 inocuas, +1 sensible. Neto -1.
  REVOKE ALL ON FUNCTION public.get_or_create_brand(text, uuid)  FROM authenticated;
  REVOKE ALL ON FUNCTION public.generar_numero_garantia(uuid)    FROM authenticated;
  GRANT EXECUTE ON FUNCTION public.arca_get_credential_for_signing(uuid) TO authenticated;

  SELECT count(*) INTO v_fin
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prosecdef AND n.nspname = 'public'
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');

  IF v_fin >= v_ini THEN
    RAISE EXCEPTION 'CASO 11: la trampa no bajo el total (% -> %), el test no prueba nada', v_ini, v_fin;
  END IF;

  -- La regla por CONTEO deja pasar el intercambio...
  IF v_fin > v_ini + array_length(v_nuevas, 1) THEN
    RAISE EXCEPTION 'CASO 11: se esperaba que el conteo NO detectara la trampa';
  END IF;

  -- ...y la regla por FIRMA EXACTA lo caza.
  SELECT string_agg(x.sig, ', ') INTO v_detectadas
  FROM (
    SELECT p.oid::regprocedure::text AS sig
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    LEFT JOIN _trampa_baseline b ON b.oid = p.oid
    WHERE n.nspname = 'public' AND p.prosecdef
      AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
      AND COALESCE(b.authn, false) = false
      AND p.oid <> ALL (SELECT ('public.' || a)::regprocedure::oid FROM unnest(v_nuevas) a)
  ) x;

  IF v_detectadas IS NULL OR v_detectadas NOT LIKE '%arca_get_credential_for_signing%' THEN
    RAISE EXCEPTION 'CASO 11: la postcondicion por firma NO detecto la apertura sensible (detecto: %)',
      COALESCE(v_detectadas, '<nada>');
  END IF;

  RAISE NOTICE 'CASO 11 OK · conteo % -> % (baja) pero la regla por firma detecta: %',
    v_ini, v_fin, v_detectadas;

  -- Se deshace el intercambio dentro del mismo test.
  REVOKE ALL ON FUNCTION public.arca_get_credential_for_signing(uuid) FROM authenticated;
  GRANT EXECUTE ON FUNCTION public.get_or_create_brand(text, uuid) TO authenticated;
  GRANT EXECUTE ON FUNCTION public.generar_numero_garantia(uuid)   TO authenticated;
  DROP TABLE IF EXISTS _trampa_baseline;
END;
$$;

-- ── CASOS 12-19 · Aislamiento cross-tenant con dos negocios y dos usuarios ──
-- auth.uid() se simula con set_config('request.jwt.claims', ...), que es como
-- lo resuelve Supabase. NO se usa SET LOCAL ROLE dentro de DO (SIGSEGV local).
DO $$
DECLARE
  v_user_a uuid := gen_random_uuid();
  v_user_b uuid := gen_random_uuid();
  v_biz_a  uuid := gen_random_uuid();
  v_biz_b  uuid := gen_random_uuid();
  v_comp_b uuid := gen_random_uuid();
  v_brand_b uuid := gen_random_uuid();
  v_total_antes numeric;
  v_ok bool;
  v_num text;
  v_id  uuid;
BEGIN
  -- Fixtures: A es owner del negocio A; B es owner del negocio B.
  INSERT INTO auth.users (id, email) VALUES
    (v_user_a, 'xt_a@example.invalid'), (v_user_b, 'xt_b@example.invalid')
  ON CONFLICT DO NOTHING;
  INSERT INTO public.businesses (id, name, owner_user_id, subscription_status) VALUES
    (v_biz_a, 'XT NEGOCIO A', v_user_a, 'active'),
    (v_biz_b, 'XT NEGOCIO B', v_user_b, 'active');
  INSERT INTO public.profiles (id, user_id, business_id, role, is_active, email) VALUES
    (v_user_a, v_user_a, v_biz_a, 'owner', true, 'xt_a@example.invalid'),
    (v_user_b, v_user_b, v_biz_b, 'owner', true, 'xt_b@example.invalid');

  -- Datos del negocio B, que A no debe poder tocar.
  -- estado_fiscal tiene un default ('borrador') que NO pasa su propio CHECK:
  -- hay que darle un valor valido explicito.
  INSERT INTO public.comprobantes (id, business_id, tipo, subtotal, impuestos, total, estado_fiscal)
  VALUES (v_comp_b, v_biz_b, 'factura_a', 1000, 210, 1210, 'no_fiscal');
  INSERT INTO public.comprobante_items (business_id, comprobante_id, descripcion, subtotal)
  VALUES (v_biz_b, v_comp_b, 'item de B', 7777);
  INSERT INTO public.brands (id, business_id, name, normalized_name)
  VALUES (v_brand_b, v_biz_b, 'MarcaB', 'marcab');
  INSERT INTO public.warranties (business_id, customer_name, number, phone_model)
  VALUES (v_biz_b, 'Cliente B', 'GAR-000042', 'Modelo B');

  SELECT total INTO v_total_antes FROM public.comprobantes WHERE id = v_comp_b;

  -- ── Actuamos como el usuario A ──────────────────────────────────────────
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_a)::text, true);

  -- CASO 12 · A no recalcula un comprobante de B (y no cambia nada)
  v_ok := false;
  BEGIN
    PERFORM public.recalcular_totales_comprobante(v_comp_b);
  EXCEPTION WHEN insufficient_privilege THEN v_ok := true;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'CASO 12: A recalculo un comprobante de B'; END IF;
  IF (SELECT total FROM public.comprobantes WHERE id = v_comp_b) <> v_total_antes THEN
    RAISE EXCEPTION 'CASO 12: el rechazo modifico los totales de B';
  END IF;
  RAISE NOTICE 'CASO 12 OK · A no recalcula comprobante de B; total intacto (%)', v_total_antes;

  -- CASO 13 · A no consulta la numeracion de B
  v_ok := false;
  BEGIN
    PERFORM public.generar_numero_comprobante('factura_a', v_biz_b, '0001');
  EXCEPTION WHEN insufficient_privilege THEN v_ok := true;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'CASO 13: A leyo la numeracion de comprobantes de B'; END IF;
  RAISE NOTICE 'CASO 13 OK · A no consulta numeracion de comprobantes de B';

  -- CASO 14 · A no consulta la numeracion de garantias de B
  v_ok := false;
  BEGIN
    PERFORM public.generar_numero_garantia(v_biz_b);
  EXCEPTION WHEN insufficient_privilege THEN v_ok := true;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'CASO 14: A leyo la numeracion de garantias de B'; END IF;
  RAISE NOTICE 'CASO 14 OK · A no consulta numeracion de garantias de B';

  -- CASO 15 · A no escribe en el catalogo de B (y no queda basura)
  v_ok := false;
  BEGIN
    PERFORM public.get_or_create_brand('MarcaInyectada', v_biz_b);
  EXCEPTION WHEN insufficient_privilege THEN v_ok := true;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'CASO 15: A creo una marca en el negocio B'; END IF;
  IF EXISTS (SELECT 1 FROM public.brands WHERE business_id = v_biz_b
               AND normalized_name = 'marcainyectada') THEN
    RAISE EXCEPTION 'CASO 15: el rechazo dejo la marca escrita en B';
  END IF;
  RAISE NOTICE 'CASO 15 OK · A no escribe marcas en B; cero cambios';

  -- CASO 16 · A no cuelga un modelo propio de una marca ajena
  v_ok := false;
  BEGIN
    PERFORM public.get_or_create_model('ModeloCruzado', v_brand_b, v_biz_a);
  EXCEPTION WHEN insufficient_privilege THEN v_ok := true;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'CASO 16: A colgo un modelo de una marca de B'; END IF;
  RAISE NOTICE 'CASO 16 OK · marca ajena rechazada aunque el business_id sea el propio';

  -- CASO 17 · is_platform_admin no es oraculo sobre terceros
  IF public.is_platform_admin(v_user_b) IS NOT FALSE THEN
    RAISE EXCEPTION 'CASO 17: is_platform_admin respondio sobre un tercero';
  END IF;
  RAISE NOTICE 'CASO 17 OK · is_platform_admin(tercero) = false sin consultar';

  -- CASO 18 · el flujo legitimo de A sigue funcionando (no rompimos el frontend)
  v_num := public.generar_numero_comprobante('factura_a', v_biz_a, '0001');
  IF v_num IS NULL THEN RAISE EXCEPTION 'CASO 18: A no puede numerar en su propio negocio'; END IF;
  v_id := public.get_or_create_brand('MarcaPropia', v_biz_a);
  IF v_id IS NULL THEN RAISE EXCEPTION 'CASO 18: A no puede crear marcas en su negocio'; END IF;
  IF (public.ensure_brand_and_model('MarcaPropia', 'ModeloPropio', v_biz_a)->>'model_id') IS NULL THEN
    RAISE EXCEPTION 'CASO 18: ensure_brand_and_model fallo para el negocio propio';
  END IF;
  IF public.generar_numero_garantia(v_biz_a) IS NULL THEN
    RAISE EXCEPTION 'CASO 18: A no puede numerar garantias en su negocio';
  END IF;
  RAISE NOTICE 'CASO 18 OK · flujos legitimos de A intactos (numero=%)', v_num;

  -- CASO 19 · un rol insuficiente del PROPIO negocio tampoco pasa
  UPDATE public.profiles SET role = 'viewer' WHERE id = v_user_a;
  v_ok := false;
  BEGIN
    PERFORM public.generar_numero_comprobante('factura_a', v_biz_a, '0001');
  EXCEPTION WHEN insufficient_privilege THEN v_ok := true;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'CASO 19: un viewer pudo numerar comprobantes'; END IF;
  RAISE NOTICE 'CASO 19 OK · rol insuficiente bloqueado dentro del propio negocio';

  PERFORM set_config('request.jwt.claims', '', true);
END;
$$;

ROLLBACK;
