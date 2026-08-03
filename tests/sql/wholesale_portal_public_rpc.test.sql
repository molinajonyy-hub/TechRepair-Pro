-- ============================================================================
-- FASE 1 — Contrato de la RPC publica del portal mayorista
--
-- Corre contra una BRANCH de Supabase o el stack LOCAL (NUNCA produccion), con
-- la migracion 20260803120000_wholesale_portal_public_rpc.sql aplicada:
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < tests/sql/wholesale_portal_public_rpc.test.sql
--
-- AGNOSTICO AL LOCKDOWN: todas las aserciones valen igual antes y despues de la
-- FASE 2. Por eso este archivo viaja en la rama de FASE 1 y puede correrse en
-- produccion apenas se aplica la RPC, sin esperar al lockdown. Las aserciones
-- sobre grants, policies y acceso directo a la tabla viven en
-- tests/sql/wholesale_portal_public_read.test.sql (FASE 2).
--
-- Verifica:
--   CASO 1  La RPC devuelve EXACTAMENTE las 7 columnas de PortalBusiness.
--   CASO 2  anon obtiene el negocio del portal por slug exacto.
--   CASO 3  No devuelve negocios con el portal apagado.
--   CASO 4  authenticated (miembro y de otro tenant) obtiene la misma allowlist.
--   CASO 5  Ninguna columna sensible es alcanzable desde la RPC.
--   CASO 6  Sin enumeracion: slug inexistente, parcial, comodin y vacio -> 0 filas.
--   CASO 7  Higiene: SECURITY DEFINER, search_path fijo con pg_temp ultimo,
--           sin EXECUTE a PUBLIC, EXECUTE para anon y authenticated.
--   CASO 8  Una columna NUEVA de businesses no se vuelve publica sola.
--
-- Todo en una transaccion; termina en ROLLBACK (no deja fixtures).
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_portal_owner   uuid := gen_random_uuid();
  v_other_owner    uuid := gen_random_uuid();
  v_portal_biz     uuid := gen_random_uuid();
  v_other_biz      uuid := gen_random_uuid();
  v_off_biz        uuid := gen_random_uuid();
  v_fn CONSTANT text := 'public.get_wholesale_portal_public(text)';
  v_cnt      int;
  v_blocked  boolean;
  v_txt      text;
  v_cols     text[];
  v_cfg      text[];
  v_secdef   boolean;
  v_acl      aclitem[];
  v_slug     text;
BEGIN
  -- ── Fixtures ──────────────────────────────────────────────────────────────
  INSERT INTO auth.users (id, email) VALUES
    (v_portal_owner, 'rpc_owner_t@example.com'),
    (v_other_owner,  'rpc_other_t@example.com')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.businesses
    (id, name, owner_user_id, subscription_status, subscription_plan,
     wholesale_portal_enabled, wholesale_portal_slug, wholesale_whatsapp,
     mp_preapproval_id, mp_preapproval_plan_id, mp_payer_email, mp_last_modified,
     last_payment_id, last_payment_status)
  VALUES
    (v_portal_biz, 'TEST RPC PORTAL', v_portal_owner, 'active', 'full',
     true, 'test-rpc-on', '5491100000000',
     'FAKE-PRE', 'FAKE-PLAN', 'fake_billing_t@example.invalid', now(),
     'FAKE-PAY', 'approved');

  INSERT INTO public.businesses
    (id, name, owner_user_id, subscription_status, subscription_plan, wholesale_portal_enabled)
  VALUES (v_other_biz, 'TEST RPC OTHER', v_other_owner, 'active', 'full', false);

  INSERT INTO public.businesses
    (id, name, subscription_status, wholesale_portal_enabled, wholesale_portal_slug)
  VALUES (v_off_biz, 'TEST RPC OFF', 'active', false, 'test-rpc-off');

  INSERT INTO public.profiles (id, user_id, business_id, role, is_active) VALUES
    (v_portal_owner, v_portal_owner, v_portal_biz, 'owner', true),
    (v_other_owner,  v_other_owner,  v_other_biz,  'owner', true);

  -- ── CASO 1 — contrato exacto de columnas ──────────────────────────────────
  SELECT array_agg(nm ORDER BY nm) INTO v_cols
  FROM (
    SELECT unnest(p.proargnames) AS nm, unnest(p.proargmodes) AS md
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_wholesale_portal_public'
  ) s
  WHERE s.md = 't';

  IF v_cols IS DISTINCT FROM ARRAY[
      'id','logo_url','name','wholesale_portal_enabled',
      'wholesale_portal_slug','wholesale_portal_theme','wholesale_whatsapp'
    ]::text[]
  THEN
    RAISE EXCEPTION 'CASO 1 FAIL: la RPC no devuelve las 7 columnas esperadas: %', v_cols;
  END IF;
  RAISE NOTICE 'CASO 1 OK — la RPC devuelve exactamente las 7 columnas de PortalBusiness.';

  -- ── CASO 2 — anon obtiene el portal ───────────────────────────────────────
  PERFORM set_config('role','anon',true);
  SELECT r.name INTO v_txt FROM public.get_wholesale_portal_public('test-rpc-on') r;
  IF v_txt IS DISTINCT FROM 'TEST RPC PORTAL' THEN
    RAISE EXCEPTION 'CASO 2 FAIL: anon no resuelve el portal por slug (%)', v_txt;
  END IF;
  PERFORM set_config('role','postgres',true);
  RAISE NOTICE 'CASO 2 OK — anon obtiene la proyeccion publica por slug exacto.';

  -- ── CASO 3 — portal apagado no sale ───────────────────────────────────────
  PERFORM set_config('role','anon',true);
  SELECT count(*) INTO v_cnt FROM public.get_wholesale_portal_public('test-rpc-off');
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'CASO 3 FAIL: la RPC expone un negocio con el portal apagado (%)', v_cnt;
  END IF;
  PERFORM set_config('role','postgres',true);
  RAISE NOTICE 'CASO 3 OK — el filtro wholesale_portal_enabled se respeta.';

  -- ── CASO 4 — authenticated: miembro y otro tenant, misma allowlist ────────
  -- getPortalBusiness corre en cada mount del portal, tambien con sesion: el
  -- lector puede ser anon O authenticated. Los dos tienen que poder resolverlo.
  PERFORM set_config('role','authenticated',true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub',v_portal_owner,'role','authenticated')::text, true);
  SELECT count(*) INTO v_cnt FROM public.get_wholesale_portal_public('test-rpc-on');
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'CASO 4 FAIL: el miembro no puede usar la RPC (%)', v_cnt;
  END IF;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub',v_other_owner,'role','authenticated')::text, true);
  SELECT count(*) INTO v_cnt FROM public.get_wholesale_portal_public('test-rpc-on');
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'CASO 4 FAIL: authenticated de otro tenant no puede usar la RPC (%)', v_cnt;
  END IF;
  PERFORM set_config('role','postgres',true);
  RAISE NOTICE 'CASO 4 OK — anon y authenticated reciben la misma allowlist.';

  -- ── CASO 5 — columnas sensibles inalcanzables desde la RPC ────────────────
  PERFORM set_config('role','anon',true);
  FOREACH v_txt IN ARRAY ARRAY[
    'mp_preapproval_id','mp_preapproval_plan_id','mp_payer_email','mp_last_modified',
    'last_payment_id','last_payment_status','owner_user_id','subscription_plan',
    'subscription_status','grace_until','trial_ends_at','access_source','override_reason'
  ] LOOP
    v_blocked := false;
    BEGIN
      EXECUTE format(
        'SELECT r.%I FROM public.get_wholesale_portal_public(''test-rpc-on'') r', v_txt);
    EXCEPTION WHEN undefined_column THEN v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'CASO 5 FAIL: la columna % es alcanzable desde la RPC', v_txt;
    END IF;
  END LOOP;
  PERFORM set_config('role','postgres',true);
  RAISE NOTICE 'CASO 5 OK — 13 columnas sensibles inalcanzables desde la RPC.';

  -- ── CASO 6 — sin enumeracion ──────────────────────────────────────────────
  -- La policy original permitia listar TODOS los portales activos sin conocer
  -- ningun slug. La RPC exige igualdad exacta: ni prefijo, ni comodin, ni vacio.
  PERFORM set_config('role','anon',true);
  FOREACH v_slug IN ARRAY ARRAY['no-existe','test-rpc','test-rpc%','%','','TEST-RPC-ON'] LOOP
    SELECT count(*) INTO v_cnt FROM public.get_wholesale_portal_public(v_slug);
    IF v_cnt <> 0 THEN
      RAISE EXCEPTION 'CASO 6 FAIL: el slug % devolvio % filas', quote_literal(v_slug), v_cnt;
    END IF;
  END LOOP;
  PERFORM set_config('role','postgres',true);
  RAISE NOTICE 'CASO 6 OK — igualdad exacta: sin prefijos, comodines ni case-insensitive.';

  -- ── CASO 7 — higiene de la RPC ────────────────────────────────────────────
  SELECT p.prosecdef, p.proconfig, p.proacl
    INTO v_secdef, v_cfg, v_acl
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_wholesale_portal_public';

  IF NOT v_secdef THEN
    RAISE EXCEPTION 'CASO 7 FAIL: la RPC dejo de ser SECURITY DEFINER';
  END IF;
  IF v_cfg IS NULL OR NOT (v_cfg @> ARRAY['search_path=pg_catalog, pg_temp']::text[]) THEN
    RAISE EXCEPTION 'CASO 7 FAIL: search_path no fijado como se espera (%)', v_cfg;
  END IF;
  -- proacl NULL = privilegios por defecto = EXECUTE a PUBLIC. Es un fallo.
  IF v_acl IS NULL THEN
    RAISE EXCEPTION 'CASO 7 FAIL: proacl NULL -> EXECUTE queda a PUBLIC por defecto';
  END IF;
  IF EXISTS (SELECT 1 FROM aclexplode(v_acl) a
             WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'CASO 7 FAIL: la RPC conserva EXECUTE a PUBLIC';
  END IF;
  IF NOT has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'CASO 7 FAIL: anon no puede ejecutar la RPC';
  END IF;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'CASO 7 FAIL: authenticated no puede ejecutar la RPC';
  END IF;
  RAISE NOTICE 'CASO 7 OK — SECURITY DEFINER, search_path fijo, sin EXECUTE a PUBLIC.';

  -- ── CASO 8 — una columna FUTURA no se vuelve publica ──────────────────────
  ALTER TABLE public.businesses ADD COLUMN test_secreto_futuro text;
  UPDATE public.businesses SET test_secreto_futuro = 'NO-DEBE-SALIR' WHERE id = v_portal_biz;

  SELECT count(*) INTO v_cnt
  FROM (
    SELECT unnest(p.proargmodes) AS md
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_wholesale_portal_public'
  ) s WHERE s.md = 't';
  IF v_cnt <> 7 THEN
    RAISE EXCEPTION 'CASO 8 FAIL: la RPC paso a devolver % columnas', v_cnt;
  END IF;

  PERFORM set_config('role','anon',true);
  v_blocked := false;
  BEGIN
    EXECUTE 'SELECT r.test_secreto_futuro FROM public.get_wholesale_portal_public(''test-rpc-on'') r';
  EXCEPTION WHEN undefined_column THEN v_blocked := true;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'CASO 8 FAIL: una columna nueva de businesses quedo publica';
  END IF;
  PERFORM set_config('role','postgres',true);
  RAISE NOTICE 'CASO 8 OK — una columna nueva de businesses no se publica sola.';

  RAISE NOTICE 'ALL WHOLESALE PORTAL PUBLIC RPC (FASE 1) TESTS PASSED';
END $$;

ROLLBACK;
