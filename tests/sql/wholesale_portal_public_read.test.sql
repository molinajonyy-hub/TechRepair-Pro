-- ============================================================================
-- FASE 2 — Lockdown de la lectura publica de `public.businesses`
--
-- Corre contra una BRANCH de Supabase o el stack LOCAL (NUNCA produccion), con
-- 20260804130000_wholesale_portal_public_read_lockdown.sql ya aplicada:
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < tests/sql/wholesale_portal_public_read.test.sql
--
-- Complementa a tests/sql/wholesale_portal_public_rpc.test.sql (FASE 1), que es
-- agnostico al lockdown y prueba el CONTRATO de la RPC. Aca se prueba el CIERRE:
-- grants, policies y acceso directo a la tabla.
--
--   CASO  1  anon no puede hacer SELECT directo sobre businesses (42501, no 0 filas).
--   CASO  2  PUBLIC no tiene SELECT de tabla.
--   CASO  3  anon no tiene SELECT por columna en ninguna de las 34.
--   CASO  4  No hay policies FOR SELECT alcanzables por PUBLIC/anon.
--   CASO  5  No hay policies FOR ALL alcanzables por PUBLIC/anon.
--   CASO  6  authenticated miembro lee su propio negocio.
--   CASO  7  authenticated de otro tenant no obtiene la fila ajena.
--   CASO  8  authenticated de otro tenant no obtiene mp_payer_email ni mp_*.
--   CASO  9  subscriptionService conserva el acceso del owner a su propio negocio.
--   CASO 10  La RPC publica devuelve exactamente las 7 columnas allowlisted.
--   CASO 11  La RPC de features devuelve solo {active, mayorista}.
--   CASO 12  Portal deshabilitado -> cero filas / null.
--   CASO 13  Slug inexistente -> cero filas / null.
--   CASO 14  Slug parcial, comodin o vacio no enumeran.
--   CASO 15  anon no puede encadenar el business_id hacia RPC sensibles.
--   CASO 16  Una columna FUTURA de businesses no se vuelve publica.
--   CASO 17  NEGATIVO: una policy FOR ALL a anon hace fallar el detector.
--   CASO 18  NEGATIVO: una policy con TO anon explicito hace fallar el detector.
--   CASO 19  NEGATIVO: un GRANT SELECT(columna) a anon hace fallar el detector.
--   CASO 20  El miembro legitimo conserva el acceso interno completo.
--   CASO 21  PRE-LOCKDOWN: reconstruye el estado vulnerable y REPRODUCE el leak.
--
-- Los casos 17-21 modifican el catalogo a proposito, siempre dentro de la misma
-- transaccion, para demostrar que el detector no es cosmetico y que el estado
-- anterior era realmente explotable. Todo termina en ROLLBACK: no deja fixtures,
-- no deja policies, no deja grants.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- ── Detectores ──────────────────────────────────────────────────────────────
-- MISMOS predicados que las postcondiciones de la migracion. Viven en pg_temp,
-- asi que se van con el ROLLBACK. Que los casos 17-19 los hagan disparar es lo
-- que demuestra que la migracion habria abortado ante esos estados.

-- Policies PERMISIVAS de lectura (FOR SELECT 'r' o FOR ALL '*') alcanzables por
-- PUBLIC (OID 0), por `anon` explicito, o por una lista de roles que incluya un
-- rol del que anon sea miembro. NO mira polname: una policy nueva con cualquier
-- otro nombre cae igual.
CREATE FUNCTION pg_temp.policies_de_lectura_publicas() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT string_agg(format('%s(cmd=%s)', p.polname, p.polcmd), ', ' ORDER BY p.polname)
  FROM pg_catalog.pg_policy p
  WHERE p.polrelid = 'public.businesses'::regclass
    AND p.polpermissive
    AND p.polcmd IN ('r', '*')
    AND (
      0 = ANY (p.polroles)
      OR EXISTS (SELECT 1 FROM unnest(p.polroles) AS pr(oid)
                 WHERE pg_has_role('anon', pr.oid, 'USAGE'))
    );
$$;

-- Columnas de businesses legibles por anon o por PUBLIC, sea por grant de tabla
-- o por grant de columna (has_column_privilege resuelve las dos vias).
CREATE FUNCTION pg_temp.columnas_legibles_publicas() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT string_agg(DISTINCT format('%s:%s', x.rol, a.attname), ', ')
  FROM pg_catalog.pg_attribute a
  CROSS JOIN (VALUES ('anon'), ('public')) AS x(rol)
  WHERE a.attrelid = 'public.businesses'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped
    AND has_column_privilege(x.rol, 'public.businesses', a.attname, 'SELECT');
$$;


DO $$
DECLARE
  v_own_portal  uuid := gen_random_uuid();   -- owner del negocio con portal
  v_own_otro    uuid := gen_random_uuid();   -- owner de OTRO tenant
  v_biz_portal  uuid := gen_random_uuid();
  v_biz_otro    uuid := gen_random_uuid();
  v_biz_off     uuid := gen_random_uuid();
  v_fn_pub  CONSTANT text := 'public.get_wholesale_portal_public(text)';
  v_fn_feat CONSTANT text := 'public.get_wholesale_portal_features(text)';
  v_cnt      int;
  v_txt      text;
  v_mail     text;
  v_denegado boolean;
  v_cols     text[];
  v_keys     text[];
  v_slug     text;
  v_fn       text;
  v_sub      record;
BEGIN
  -- ── Fixtures sinteticas ───────────────────────────────────────────────────
  INSERT INTO auth.users (id, email) VALUES
    (v_own_portal, 'f2_portal_owner@example.invalid'),
    (v_own_otro,   'f2_otro_owner@example.invalid')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.businesses
    (id, name, owner_user_id, subscription_status, subscription_plan,
     wholesale_portal_enabled, wholesale_portal_slug, wholesale_whatsapp,
     mp_preapproval_id, mp_preapproval_plan_id, mp_payer_email, mp_last_modified,
     last_payment_id, last_payment_status, access_source,
     current_period_start, current_period_end, grace_until, trial_ends_at)
  VALUES
    (v_biz_portal, 'F2 PORTAL', v_own_portal, 'active', 'full',
     true, 'f2-on', '5491100000000',
     'F2-FAKE-PRE', 'F2-FAKE-PLAN', 'f2_facturacion@example.invalid', now(),
     'F2-FAKE-PAY', 'approved', 'mercado_pago',
     now() - interval '1 day', now() + interval '29 days', NULL, NULL);

  INSERT INTO public.businesses
    (id, name, owner_user_id, subscription_status, subscription_plan,
     wholesale_portal_enabled, mp_payer_email)
  VALUES (v_biz_otro, 'F2 OTRO TENANT', v_own_otro, 'active', 'full', false,
          'f2_otro@example.invalid');

  INSERT INTO public.businesses
    (id, name, subscription_status, subscription_plan,
     wholesale_portal_enabled, wholesale_portal_slug)
  VALUES (v_biz_off, 'F2 PORTAL APAGADO', 'active', 'full', false, 'f2-off');

  INSERT INTO public.profiles (id, user_id, business_id, role, is_active) VALUES
    (v_own_portal, v_own_portal, v_biz_portal, 'owner', true),
    (v_own_otro,   v_own_otro,   v_biz_otro,   'owner', true);


  -- ══ CASO 1 — anon no puede hacer SELECT directo ═════════════════════════
  -- Exige 42501, no "0 filas": un rechazo tiene que ser distinguible de un
  -- resultado vacio. Si solo se hubiera dropeado la policy dejando el GRANT,
  -- esto devolveria 0 filas y el test pasaria por el motivo equivocado.
  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM set_config('role', 'anon', true);
  v_denegado := false;
  BEGIN
    EXECUTE 'SELECT count(*) FROM public.businesses' INTO v_cnt;
  EXCEPTION WHEN insufficient_privilege THEN v_denegado := true;
  END;
  PERFORM set_config('role', 'postgres', true);
  IF NOT v_denegado THEN
    RAISE EXCEPTION 'CASO 1 FAIL: anon todavia puede hacer SELECT sobre businesses (% filas)', v_cnt;
  END IF;
  RAISE NOTICE 'CASO 1 OK — anon -> 42501 sobre public.businesses (no "0 filas").';

  -- ══ CASO 2 — PUBLIC no tiene SELECT de tabla ════════════════════════════
  IF has_table_privilege('public', 'public.businesses', 'SELECT') THEN
    RAISE EXCEPTION 'CASO 2 FAIL: PUBLIC conserva SELECT de tabla sobre businesses';
  END IF;
  IF has_table_privilege('anon', 'public.businesses', 'SELECT') THEN
    RAISE EXCEPTION 'CASO 2 FAIL: anon conserva SELECT de tabla sobre businesses';
  END IF;
  RAISE NOTICE 'CASO 2 OK — ni PUBLIC ni anon tienen SELECT de tabla.';

  -- ══ CASO 3 — anon no tiene SELECT por columna ═══════════════════════════
  v_txt := pg_temp.columnas_legibles_publicas();
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION 'CASO 3 FAIL: anon/PUBLIC conservan columnas legibles: %', v_txt;
  END IF;
  RAISE NOTICE 'CASO 3 OK — ninguna de las 34 columnas es legible por anon ni por PUBLIC.';

  -- ══ CASO 4 y 5 — sin policies de lectura para PUBLIC/anon ═══════════════
  -- El mismo detector cubre 'r' (FOR SELECT) y '*' (FOR ALL): las dos habilitan
  -- lectura y ninguna se identifica por nombre.
  v_txt := pg_temp.policies_de_lectura_publicas();
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION 'CASO 4/5 FAIL: quedan policies de lectura publicas: %', v_txt;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policy
             WHERE polrelid = 'public.businesses'::regclass
               AND polname = 'businesses_portal_public_read') THEN
    RAISE EXCEPTION 'CASO 4 FAIL: businesses_portal_public_read sigue existiendo';
  END IF;
  RAISE NOTICE 'CASO 4/5 OK — sin policies FOR SELECT ni FOR ALL para PUBLIC/anon.';

  -- ══ CASO 6 — authenticated MIEMBRO lee su propio negocio ════════════════
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_own_portal, 'role', 'authenticated')::text, true);
  SELECT b.name INTO v_txt FROM public.businesses b WHERE b.id = v_biz_portal;
  IF v_txt IS DISTINCT FROM 'F2 PORTAL' THEN
    RAISE EXCEPTION 'CASO 6 FAIL: el miembro no puede leer su propio negocio (%)', v_txt;
  END IF;
  PERFORM set_config('role', 'postgres', true);
  RAISE NOTICE 'CASO 6 OK — el miembro conserva la lectura de su propio negocio.';

  -- ══ CASO 7 — cross-tenant no obtiene la fila ajena ══════════════════════
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_own_otro, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_cnt FROM public.businesses WHERE id = v_biz_portal;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'CASO 7 FAIL: authenticated de otro tenant obtiene la fila ajena (%)', v_cnt;
  END IF;
  -- Y tampoco puede ENUMERAR: solo ve el suyo.
  SELECT count(*) INTO v_cnt FROM public.businesses;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'CASO 7 FAIL: authenticated de otro tenant ve % negocios (esperado 1)', v_cnt;
  END IF;
  PERFORM set_config('role', 'postgres', true);
  RAISE NOTICE 'CASO 7 OK — cross-tenant no alcanza la fila ajena ni enumera.';

  -- ══ CASO 8 — cross-tenant no obtiene mp_payer_email ni mp_* ═════════════
  -- El vector mas grave del P0: no requiere ser cliente del portal, alcanza con
  -- estar logueado en CUALQUIER tenant.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_own_otro, 'role', 'authenticated')::text, true);
  FOREACH v_txt IN ARRAY ARRAY[
    'mp_payer_email','mp_preapproval_id','mp_preapproval_plan_id','mp_last_modified',
    'last_payment_id','last_payment_status','owner_user_id','access_source',
    'subscription_plan','subscription_status','grace_until','trial_ends_at',
    'current_period_start','current_period_end'
  ] LOOP
    EXECUTE format('SELECT count(*) FROM public.businesses b WHERE b.id = %L AND b.%I IS NOT NULL',
                   v_biz_portal, v_txt) INTO v_cnt;
    IF v_cnt <> 0 THEN
      RAISE EXCEPTION 'CASO 8 FAIL: cross-tenant alcanza la columna % del negocio ajeno', v_txt;
    END IF;
  END LOOP;
  PERFORM set_config('role', 'postgres', true);
  RAISE NOTICE 'CASO 8 OK — 14 columnas sensibles inalcanzables cross-tenant.';

  -- ══ CASO 9 — subscriptionService sigue funcionando para el owner ════════
  -- Exactamente el SELECT de src/services/subscriptionService.ts::getSubscription.
  -- Si el lockdown le hubiera tocado el grant a `authenticated`, esto rompe.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_own_portal, 'role', 'authenticated')::text, true);
  SELECT b.subscription_status, b.subscription_plan, b.access_source,
         b.mp_preapproval_id, b.mp_payer_email, b.current_period_start,
         b.current_period_end, b.grace_until, b.last_payment_status,
         b.trial_ends_at, b.override_expires_at
    INTO v_sub
  FROM public.businesses b WHERE b.id = v_biz_portal;
  IF v_sub.mp_payer_email IS DISTINCT FROM 'f2_facturacion@example.invalid' THEN
    RAISE EXCEPTION 'CASO 9 FAIL: el owner perdio acceso a mp_payer_email de SU negocio (%)',
      COALESCE(v_sub.mp_payer_email, '(null)');
  END IF;
  IF v_sub.subscription_plan IS DISTINCT FROM 'full' THEN
    RAISE EXCEPTION 'CASO 9 FAIL: el owner perdio acceso a subscription_plan de SU negocio';
  END IF;
  PERFORM set_config('role', 'postgres', true);
  RAISE NOTICE 'CASO 9 OK — subscriptionService conserva las 11 columnas del negocio propio.';

  -- ══ CASO 10 — la RPC publica devuelve exactamente 7 columnas ════════════
  SELECT array_agg(s.nm ORDER BY s.nm) INTO v_cols
  FROM (
    SELECT unnest(p.proargnames) AS nm, unnest(p.proargmodes) AS md
    FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_fn_pub)
  ) s WHERE s.md = 't';
  IF v_cols IS DISTINCT FROM ARRAY[
      'id','logo_url','name','wholesale_portal_enabled',
      'wholesale_portal_slug','wholesale_portal_theme','wholesale_whatsapp']::text[] THEN
    RAISE EXCEPTION 'CASO 10 FAIL: la RPC publica no devuelve la allowlist: %', v_cols;
  END IF;
  -- Y anon la puede usar: cerrar la tabla no puede haber cerrado la puerta buena.
  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM set_config('role', 'anon', true);
  SELECT r.name INTO v_txt FROM public.get_wholesale_portal_public('f2-on') r;
  PERFORM set_config('role', 'postgres', true);
  IF v_txt IS DISTINCT FROM 'F2 PORTAL' THEN
    RAISE EXCEPTION 'CASO 10 FAIL: anon ya no resuelve el portal por la RPC (%)', COALESCE(v_txt,'(null)');
  END IF;
  RAISE NOTICE 'CASO 10 OK — 7 columnas allowlisted y anon las obtiene por RPC.';

  -- ══ CASO 11 — la RPC de features devuelve solo {active, mayorista} ══════
  PERFORM set_config('role', 'anon', true);
  SELECT array_agg(k ORDER BY k) INTO v_keys
  FROM jsonb_object_keys(public.get_wholesale_portal_features('f2-on')) k;
  PERFORM set_config('role', 'postgres', true);
  IF v_keys IS DISTINCT FROM ARRAY['active','mayorista']::text[] THEN
    RAISE EXCEPTION 'CASO 11 FAIL: la RPC de features devuelve %', COALESCE(v_keys::text,'(null)');
  END IF;
  RAISE NOTICE 'CASO 11 OK — features = {active, mayorista}, sin plan ni estado crudo.';

  -- ══ CASO 12 — portal deshabilitado -> cero / null ═══════════════════════
  PERFORM set_config('role', 'anon', true);
  SELECT count(*) INTO v_cnt FROM public.get_wholesale_portal_public('f2-off');
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'CASO 12 FAIL: un portal apagado devolvio % filas', v_cnt;
  END IF;
  IF public.get_wholesale_portal_features('f2-off') IS NOT NULL THEN
    RAISE EXCEPTION 'CASO 12 FAIL: features respondio para un portal apagado';
  END IF;
  PERFORM set_config('role', 'postgres', true);
  RAISE NOTICE 'CASO 12 OK — portal deshabilitado: 0 filas y features null.';

  -- ══ CASO 13 — slug inexistente -> cero / null ═══════════════════════════
  PERFORM set_config('role', 'anon', true);
  SELECT count(*) INTO v_cnt FROM public.get_wholesale_portal_public('no-existe-jamas');
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'CASO 13 FAIL: un slug inexistente devolvio % filas', v_cnt;
  END IF;
  IF public.get_wholesale_portal_features('no-existe-jamas') IS NOT NULL THEN
    RAISE EXCEPTION 'CASO 13 FAIL: features respondio para un slug inexistente';
  END IF;
  PERFORM set_config('role', 'postgres', true);
  RAISE NOTICE 'CASO 13 OK — slug inexistente: 0 filas y features null.';

  -- ══ CASO 14 — sin enumeracion por slug parcial/comodin/vacio ════════════
  -- La policy vieja permitia listar TODOS los portales encendidos sin conocer
  -- ningun slug. La RPC exige igualdad exacta.
  PERFORM set_config('role', 'anon', true);
  FOREACH v_slug IN ARRAY ARRAY['f2','f2-','f2%','%','_','','F2-ON','f2-on '] LOOP
    SELECT count(*) INTO v_cnt FROM public.get_wholesale_portal_public(v_slug);
    IF v_cnt <> 0 THEN
      RAISE EXCEPTION 'CASO 14 FAIL: el slug %s devolvio % filas', quote_literal(v_slug), v_cnt;
    END IF;
    IF public.get_wholesale_portal_features(v_slug) IS NOT NULL THEN
      RAISE EXCEPTION 'CASO 14 FAIL: features respondio al slug %s', quote_literal(v_slug);
    END IF;
  END LOOP;
  PERFORM set_config('role', 'postgres', true);
  RAISE NOTICE 'CASO 14 OK — 8 variantes de slug no enumeran nada.';

  -- ══ CASO 15 — anon no encadena el business_id hacia RPC sensibles ═══════
  -- La RPC publica SI devuelve `id`. El aislamiento no depende de ocultarlo,
  -- sino de que ese id no abra ninguna otra puerta.
  --
  -- Se comprueba por CATALOGO y no invocando las funciones. No es comodidad:
  -- entrar a una SECURITY DEFINER con el rol cambiado por set_config() dentro
  -- de un bloque DO tumba el backend (SIGSEGV reproducido en este mismo stack
  -- local; PostgreSQL no soporta ese cambio de rol anidado). El CASO 1 si
  -- invoca de verdad porque ahi el rechazo lo emite el ejecutor sobre una tabla,
  -- sin entrar a ninguna funcion.
  --
  -- has_function_privilege es ademas la fuente de verdad correcta: `proacl NULL`
  -- NO significa "sin permisos", significa "default = EXECUTE a PUBLIC", y
  -- aclexplode(NULL) devuelve cero filas (falso negativo). Por eso se chequean
  -- las tres cosas: privilegio efectivo, proacl no nulo y ausencia de grantee 0.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.get_business_subscription(uuid)',
    'public.get_business_subscription_features(uuid)',
    'public.get_active_sales_point(uuid)',
    'public.recalculate_product_prices(uuid,numeric)'
  ] LOOP
    IF to_regprocedure(v_fn) IS NULL THEN
      RAISE EXCEPTION 'CASO 15 FAIL: no existe % (cambio de firma?)', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'CASO 15 FAIL: anon puede ejecutar %', v_fn;
    END IF;
    SELECT p.proacl IS NULL INTO v_denegado
    FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_fn);
    IF v_denegado THEN
      RAISE EXCEPTION 'CASO 15 FAIL: % tiene proacl NULL (default = EXECUTE a PUBLIC)', v_fn;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(p.proacl) a
      WHERE p.oid = to_regprocedure(v_fn)
        AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'CASO 15 FAIL: % conserva EXECUTE a PUBLIC', v_fn;
    END IF;
  END LOOP;

  -- La contraparte positiva: las DOS superficies publicas del portal si tienen
  -- que seguir siendo ejecutables por anon. Cerrar de mas tambien es un fallo.
  FOREACH v_fn IN ARRAY ARRAY[v_fn_pub, v_fn_feat] LOOP
    IF NOT has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'CASO 15 FAIL: anon perdio EXECUTE sobre %', v_fn;
    END IF;
  END LOOP;
  RAISE NOTICE 'CASO 15 OK — el business_id publico no abre ninguna RPC sensible.';

  -- ══ CASO 16 — una columna FUTURA no se vuelve publica ═══════════════════
  ALTER TABLE public.businesses ADD COLUMN f2_secreto_futuro text;
  UPDATE public.businesses SET f2_secreto_futuro = 'NO-DEBE-SALIR' WHERE id = v_biz_portal;

  -- (a) no aparece en la RPC
  SELECT count(*) INTO v_cnt
  FROM (
    SELECT unnest(p.proargmodes) AS md
    FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_fn_pub)
  ) s WHERE s.md = 't';
  IF v_cnt <> 7 THEN
    RAISE EXCEPTION 'CASO 16 FAIL: la RPC paso a devolver % columnas', v_cnt;
  END IF;

  -- (b) anon no la puede leer de la tabla: sin grant, sigue siendo 42501.
  --     Esta es la diferencia con la FASE 1: antes el GRANT de tabla incluia
  --     automaticamente toda columna nueva.
  IF has_column_privilege('anon', 'public.businesses', 'f2_secreto_futuro', 'SELECT') THEN
    RAISE EXCEPTION 'CASO 16 FAIL: anon puede leer la columna nueva';
  END IF;
  IF has_column_privilege('public', 'public.businesses', 'f2_secreto_futuro', 'SELECT') THEN
    RAISE EXCEPTION 'CASO 16 FAIL: PUBLIC puede leer la columna nueva';
  END IF;
  RAISE NOTICE 'CASO 16 OK — una columna nueva de businesses no se publica sola.';

  -- ══ CASO 17 — NEGATIVO: una policy FOR ALL a anon dispara el detector ═══
  -- Sin este caso, los CASOS 4/5 podrian estar pasando porque el detector no
  -- detecta NADA. Se inyecta el estado malo, se exige que salte, y se deshace.
  CREATE POLICY "f2_regresion_for_all" ON public.businesses
    FOR ALL TO anon USING (true);
  v_txt := pg_temp.policies_de_lectura_publicas();
  DROP POLICY "f2_regresion_for_all" ON public.businesses;
  IF v_txt IS NULL OR v_txt NOT LIKE '%f2_regresion_for_all%' THEN
    RAISE EXCEPTION 'CASO 17 FAIL: el detector NO vio una policy FOR ALL a anon (%)',
      COALESCE(v_txt, '(nada)');
  END IF;
  RAISE NOTICE 'CASO 17 OK — una policy FOR ALL a anon dispara el detector.';

  -- ══ CASO 18 — NEGATIVO: policy FOR SELECT con TO anon explicito ═════════
  -- Nombre distinto y rol explicito (no PUBLIC): comprueba que el detector no
  -- depende ni del nombre ni de polroles = '{0}'.
  CREATE POLICY "otro_nombre_cualquiera" ON public.businesses
    FOR SELECT TO anon USING (wholesale_portal_enabled = true);
  v_txt := pg_temp.policies_de_lectura_publicas();
  DROP POLICY "otro_nombre_cualquiera" ON public.businesses;
  IF v_txt IS NULL OR v_txt NOT LIKE '%otro_nombre_cualquiera%' THEN
    RAISE EXCEPTION 'CASO 18 FAIL: el detector NO vio una policy TO anon con otro nombre (%)',
      COALESCE(v_txt, '(nada)');
  END IF;

  -- Y una policy PUBLIC pero RESTRICTIVE NO debe disparar: no concede acceso,
  -- solo lo recorta. Marcarla seria un falso positivo que volveria inutil al guard.
  CREATE POLICY "f2_restrictiva" ON public.businesses
    AS RESTRICTIVE FOR SELECT USING (true);
  v_txt := pg_temp.policies_de_lectura_publicas();
  DROP POLICY "f2_restrictiva" ON public.businesses;
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION 'CASO 18 FAIL: una policy RESTRICTIVE dio falso positivo (%)', v_txt;
  END IF;
  RAISE NOTICE 'CASO 18 OK — detecta TO anon por nombre arbitrario y no marca RESTRICTIVE.';

  -- ══ CASO 19 — NEGATIVO: un GRANT SELECT(columna) a anon dispara ═════════
  -- Es el bypass exacto que sobrevive al REVOKE de tabla: una sola columna
  -- alcanza para volver a filtrar PII.
  GRANT SELECT (mp_payer_email) ON TABLE public.businesses TO anon;
  v_txt := pg_temp.columnas_legibles_publicas();
  REVOKE SELECT (mp_payer_email) ON TABLE public.businesses FROM anon;
  IF v_txt IS NULL OR v_txt NOT LIKE '%mp_payer_email%' THEN
    RAISE EXCEPTION 'CASO 19 FAIL: el detector NO vio un GRANT SELECT(columna) a anon (%)',
      COALESCE(v_txt, '(nada)');
  END IF;
  -- Y despues del REVOKE vuelve a estar limpio (el detector no se queda pegado).
  IF pg_temp.columnas_legibles_publicas() IS NOT NULL THEN
    RAISE EXCEPTION 'CASO 19 FAIL: el detector quedo sucio tras revocar la columna';
  END IF;
  RAISE NOTICE 'CASO 19 OK — un GRANT SELECT(columna) a anon dispara el detector.';

  -- ══ CASO 20 — el miembro conserva TODO su acceso interno ════════════════
  -- Configuracion, suscripcion, Mercado Pago y ARCA salen de la misma fila. Se
  -- verifica que el miembro llega a las 35 columnas (34 + la futura del CASO 16)
  -- de SU negocio: el lockdown no puede haberle recortado nada.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_own_portal, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_cnt
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid = 'public.businesses'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped
    AND NOT has_column_privilege('authenticated', 'public.businesses', a.attname, 'SELECT');
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'CASO 20 FAIL: authenticated perdio % columna(s) de businesses', v_cnt;
  END IF;
  SELECT b.f2_secreto_futuro INTO v_txt FROM public.businesses b WHERE b.id = v_biz_portal;
  IF v_txt IS DISTINCT FROM 'NO-DEBE-SALIR' THEN
    RAISE EXCEPTION 'CASO 20 FAIL: el miembro no lee una columna nueva de SU negocio';
  END IF;
  -- Y el miembro tambien puede usar la superficie publica del portal (hace F5 en
  -- /catalogo con sesion iniciada: ahi el lector es `authenticated`).
  SELECT count(*) INTO v_cnt FROM public.get_wholesale_portal_public('f2-on');
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'CASO 20 FAIL: el miembro no puede usar la RPC publica (%)', v_cnt;
  END IF;
  PERFORM set_config('role', 'postgres', true);
  RAISE NOTICE 'CASO 20 OK — el miembro conserva la fila completa de su negocio y la RPC publica.';

  -- ══ CASO 21 — PRE-LOCKDOWN: el estado anterior ERA explotable ═══════════
  -- Se reconstruye exactamente el estado del baseline 20260628190324 y se
  -- reproducen los tres vectores. Sin esto, la suite solo probaria que "hoy
  -- esta cerrado", no que el cierre haya servido para algo.
  CREATE POLICY "businesses_portal_public_read" ON public.businesses
    FOR SELECT USING (wholesale_portal_enabled = true);
  GRANT SELECT ON TABLE public.businesses TO anon;

  -- [1] anon lee PII de facturacion
  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM set_config('role', 'anon', true);
  SELECT b.mp_payer_email INTO v_mail FROM public.businesses b WHERE b.id = v_biz_portal;
  -- [2] anon ENUMERA sin conocer ningun slug
  SELECT count(*) INTO v_cnt FROM public.businesses;
  PERFORM set_config('role', 'postgres', true);

  IF v_mail IS DISTINCT FROM 'f2_facturacion@example.invalid' THEN
    RAISE EXCEPTION 'CASO 21 FAIL: no se pudo reproducir el estado vulnerable [1] (mail=%)',
      COALESCE(v_mail, '(null)');
  END IF;
  IF v_cnt < 1 THEN
    RAISE EXCEPTION 'CASO 21 FAIL: no se pudo reproducir la enumeracion [2]';
  END IF;

  -- [3] authenticated de OTRO tenant lee la fila ajena (policies con OR)
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_own_otro, 'role', 'authenticated')::text, true);
  SELECT b.mp_payer_email INTO v_mail FROM public.businesses b WHERE b.id = v_biz_portal;
  PERFORM set_config('role', 'postgres', true);
  IF v_mail IS DISTINCT FROM 'f2_facturacion@example.invalid' THEN
    RAISE EXCEPTION 'CASO 21 FAIL: no se pudo reproducir el vector cross-tenant [3]';
  END IF;

  -- Y el detector tiene que estar gritando en ese estado.
  IF pg_temp.policies_de_lectura_publicas() IS NULL THEN
    RAISE EXCEPTION 'CASO 21 FAIL: el detector no vio el estado vulnerable reconstruido';
  END IF;
  IF pg_temp.columnas_legibles_publicas() IS NULL THEN
    RAISE EXCEPTION 'CASO 21 FAIL: el detector de columnas no vio el GRANT reconstruido';
  END IF;

  -- Deshacer el estado vulnerable (ademas del ROLLBACK final, por si alguien
  -- corriera este archivo por partes).
  DROP POLICY "businesses_portal_public_read" ON public.businesses;
  REVOKE SELECT ON TABLE public.businesses FROM anon;

  IF pg_temp.policies_de_lectura_publicas() IS NOT NULL
     OR pg_temp.columnas_legibles_publicas() IS NOT NULL THEN
    RAISE EXCEPTION 'CASO 21 FAIL: no se restauro el estado cerrado';
  END IF;
  RAISE NOTICE 'CASO 21 OK — el estado pre-lockdown se reprodujo explotable y se volvio a cerrar.';

  RAISE NOTICE 'ALL WHOLESALE PORTAL PUBLIC READ (FASE 2) TESTS PASSED';
END $$;

ROLLBACK;
