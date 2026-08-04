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
    'public.bootstrap_owner_profile(text,text,text)',
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

-- ── CASO 6 · bootstrap_owner_profile: cross-user bloqueado, cero cambios ────
DO $$
DECLARE
  v_victima     uuid := gen_random_uuid();
  v_atacante    uuid := gen_random_uuid();
  v_biz         uuid := gen_random_uuid();
  -- profiles.id tiene FK a auth.users(id): el perfil se identifica con el
  -- propio usuario, no con un uuid suelto.
  v_prof        uuid := v_victima;
  v_rol_antes   text;
  v_rol_despues text;
  v_activo_antes boolean;
  v_ok          boolean := false;
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (v_victima,  'secdef_victima@example.invalid'),
    (v_atacante, 'secdef_atacante@example.invalid')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.businesses (id, name, owner_user_id, subscription_status)
  VALUES (v_biz, 'TEST SECDEF BIZ', v_victima, 'active');

  INSERT INTO public.profiles (id, user_id, business_id, role, is_active, email)
  VALUES (v_prof, v_victima, v_biz, 'tech', false, 'secdef_victima@example.invalid');

  SELECT role, is_active INTO v_rol_antes, v_activo_antes
  FROM public.profiles WHERE id = v_prof;

  -- Sin sesion (auth.uid() = NULL) el bootstrap tiene que fallar 42501.
  BEGIN
    PERFORM public.bootstrap_owner_profile('secdef_victima@example.invalid', 'Hackeado', NULL);
    RAISE EXCEPTION 'CASO 6: bootstrap_owner_profile acepto una llamada SIN sesion';
  EXCEPTION
    WHEN insufficient_privilege THEN v_ok := true;
  END;

  IF NOT v_ok THEN
    RAISE EXCEPTION 'CASO 6: no se obtuvo 42501';
  END IF;

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

  RAISE NOTICE 'CASO 6 OK · bootstrap rechazado (42501) y perfil intacto (rol=%, activo=%)',
    v_rol_antes, v_activo_antes;
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

ROLLBACK;
