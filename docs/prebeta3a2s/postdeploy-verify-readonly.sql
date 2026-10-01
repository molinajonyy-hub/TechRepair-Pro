-- ============================================================================
-- PRE-BETA-3A-2S · VERIFICACION POST-DEPLOY (SOLO LECTURA)
--
-- Correr DESPUES de aplicar las dos migraciones 3A-2S:
--
--   psql "$DB_URL" -X -v ON_ERROR_STOP=1 \
--        -v preflight_customers_huella=<customers_huella del preflight> \
--        -f docs/prebeta3a2s/postdeploy-verify-readonly.sql
--
-- (-v preflight_customers_huella es opcional: sin el, la huella se imprime para
--  compararla a mano.)
--
-- Todo corre en una transaccion READ ONLY. Todas las filas tienen que dar
-- ok = true. Solo llama funciones puras/de catalogo: no ejecuta el checkout, ni
-- la conversion, ni escribe fixtures (eso es smoke-rollback.sql).
-- ============================================================================

BEGIN TRANSACTION READ ONLY;

WITH pins(firma, md5_esperado) AS (VALUES
    -- redefinidas (OID preservado)
    ('public.business_has_feature(text)',                                              '783cabbbc2e0d1ccecf1781f1a046cae'),
    ('public.get_business_subscription_features(uuid)',                                '81e6953d9771dd6e787f5f2824eed54f'),
    ('public.get_wholesale_portal_features(text)',                                     '99b0a16e9611b5a28d39f9d43c92adec'),
    ('private.capability_resolve(text,jsonb,text)',                                    '0edaa4ad9dadcefc0a280ff909051b2a'),
    ('public.update_wholesale_order_status_atomic(uuid,uuid,text,text)',               '0875c4deb93e9d3d9467981c78898ab4'),
    ('public.update_wholesale_customer_status_atomic(uuid,uuid,boolean,boolean,text)', '8497f62535c546ccd462413b5659ae92'),
    ('public.can_manage_wholesale()',                                                  'f91bdbf4d928c8966f96742fb3d518bb'),
    ('private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)',               'd55e05e29bb8673f65914cbab4a45e92'),
    -- nuevas
    ('private.plan_feature_enabled(text,text,text)',                                   '6dbfb5dd72890b1031613463ca948f82'),
    ('private.business_feature_enabled(uuid,text)',                                    '61bd59aaea5633a5f0e7d05583bc7e54'),
    ('private.wholesale_access_level(uuid)',                                           '3ab62801347fcf83126e17357509c3fb'),
    ('public.current_user_has_wholesale_access(uuid)',                                 '81a70178f04ca11583a4ed7f8d855201'),
    ('public.current_user_can_manage_wholesale(uuid)',                                 'c12450af3426fb3011ce07c6e3500d9d'),
    ('private.enforce_customer_wholesale_authority()',                                 'fe03b58f69f398bb057b523b3b484737'),
    ('public.get_or_create_customer_from_wholesale_atomic(uuid,uuid)',                 '1193aeb387564b92a1e1cffd24c30bfb'),
    ('public.current_user_has_internal_tool_access(text,uuid)',                        '3db681a2566598d79fd36392f18c6f28')
), pin_estado AS (
  SELECT pins.firma, pins.md5_esperado,
         (SELECT md5(replace(p.prosrc, E'\r', '')) FROM pg_catalog.pg_proc p
           WHERE p.oid = to_regprocedure(pins.firma)) AS md5_actual
    FROM pins
), api(firma, authenticated, service_role) AS (VALUES
    -- helpers/RPC que la app llama como `authenticated`
    ('public.current_user_has_wholesale_access(uuid)',                                 true,  false),
    ('public.current_user_can_manage_wholesale(uuid)',                                 true,  false),
    ('public.get_or_create_customer_from_wholesale_atomic(uuid,uuid)',                 true,  false),
    ('public.current_user_has_internal_tool_access(text,uuid)',                        true,  false),
    ('public.update_wholesale_order_status_atomic(uuid,uuid,text,text)',               true,  false),
    ('public.update_wholesale_customer_status_atomic(uuid,uuid,boolean,boolean,text)', true,  false),
    -- privadas: nadie de la API
    ('private.plan_feature_enabled(text,text,text)',                                   false, false),
    ('private.business_feature_enabled(uuid,text)',                                    false, false),
    ('private.wholesale_access_level(uuid)',                                           false, false),
    ('private.enforce_customer_wholesale_authority()',                                 false, false),
    ('private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)',               false, false)
), api_estado AS (
  SELECT a.firma,
         to_regprocedure(a.firma) IS NOT NULL
         AND NOT has_function_privilege('public', a.firma, 'EXECUTE')
         AND NOT has_function_privilege('anon', a.firma, 'EXECUTE')
         AND has_function_privilege('authenticated', a.firma, 'EXECUTE') = a.authenticated
         AND has_function_privilege('service_role', a.firma, 'EXECUTE') = a.service_role AS ok
    FROM api a
), secdef(firma) AS (VALUES
    ('public.current_user_has_wholesale_access(uuid)'),
    ('public.current_user_can_manage_wholesale(uuid)'),
    ('public.get_or_create_customer_from_wholesale_atomic(uuid,uuid)'),
    ('public.current_user_has_internal_tool_access(text,uuid)'),
    ('public.update_wholesale_order_status_atomic(uuid,uuid,text,text)'),
    ('public.update_wholesale_customer_status_atomic(uuid,uuid,boolean,boolean,text)'),
    ('public.business_has_feature(text)')
), plan_matriz(status, plan, feature, esperado) AS (VALUES
    ('active',   'basico', 'mayorista',     false),
    ('active',   'pro',    'mayorista',     true),
    ('active',   'full',   'mayorista',     true),
    ('trialing', NULL,     'mayorista',     true),
    ('canceled', 'full',   'mayorista',     false),
    ('past_due', 'pro',    'mayorista',     false),
    ('active',   'pro',    'advancedRoles', false),
    ('active',   'full',   'advancedRoles', true),
    ('active',   'basico', 'arca',          false),
    ('active',   'pro',    'arca',          true)
), cap_matriz(rol, perms, esperado) AS (VALUES
    ('admin',   NULL::jsonb,                  true),
    ('manager', NULL::jsonb,                  false),
    ('sales',   NULL::jsonb,                  false),
    ('tech',    NULL::jsonb,                  false),
    ('cashier', NULL::jsonb,                  false),
    ('viewer',  NULL::jsonb,                  false),
    ('manager', '{"wholesale": true}'::jsonb, true),
    ('sales',   '{"wholesale": true}'::jsonb, true),
    ('admin',   '{"wholesale": false}'::jsonb, false),  -- la CAPACIDAD baja; el ACCESO de admin no (automatico)
    ('sales',   '{"wholesale": "si"}'::jsonb, false)
), checks(n, check_name, ok, detalle) AS (
  SELECT 1, 'tip = 20261011130000 y ambas 3A-2S registradas',
         (SELECT max(version) FROM supabase_migrations.schema_migrations) = '20261011130000'
     AND (SELECT count(*) FROM supabase_migrations.schema_migrations
           WHERE version IN ('20261011120000', '20261011130000')) = 2,
         (SELECT max(version) FROM supabase_migrations.schema_migrations)
  UNION ALL
  SELECT 2, 'md5 de las 16 funciones = version desplegada',
         bool_and(md5_actual IS NOT DISTINCT FROM md5_esperado),
         string_agg(CASE WHEN md5_actual IS DISTINCT FROM md5_esperado
                         THEN firma || ' = ' || COALESCE(md5_actual, 'FALTA') END, '; ')
    FROM pin_estado
  UNION ALL
  SELECT 3, 'EXECUTE: sin PUBLIC/anon; authenticated/service_role segun contrato',
         bool_and(ok), string_agg(CASE WHEN NOT ok THEN firma END, '; ')
    FROM api_estado
  UNION ALL
  SELECT 4, 'SECURITY DEFINER + search_path = pg_catalog, pg_temp',
         bool_and(p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']),
         string_agg(CASE WHEN NOT (p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp'])
                         THEN s.firma END, '; ')
    FROM secdef s JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure(s.firma)
  UNION ALL
  SELECT 5, 'regla de plan: mayorista Pro+ (trial = Pro), resto sin cambios',
         bool_and(private.plan_feature_enabled(m.status, m.plan, m.feature) = m.esperado),
         string_agg(CASE WHEN private.plan_feature_enabled(m.status, m.plan, m.feature) <> m.esperado
                         THEN concat_ws('/', m.status, m.plan, m.feature) END, '; ')
    FROM plan_matriz m
  UNION ALL
  SELECT 6, 'capacidad wholesale: default solo admin; override respetado',
         bool_and(private.capability_resolve(c.rol, c.perms, 'wholesale') = c.esperado),
         string_agg(CASE WHEN private.capability_resolve(c.rol, c.perms, 'wholesale') <> c.esperado
                         THEN c.rol || ' ' || COALESCE(c.perms::text, 'default') END, '; ')
    FROM cap_matriz c
  UNION ALL
  SELECT 7, 'wholesale_* staff_read = acceso Mayorista (sin capacidad cruda)',
         count(*) = 3
     AND bool_and(qual ~ 'current_user_has_wholesale_access\(business_id\)'
                  AND qual !~ 'current_user_can\(' AND qual !~ 'business_has_feature'),
         string_agg(tablename || '.' || policyname, ', ')
    FROM pg_catalog.pg_policies
   WHERE schemaname = 'public'
     AND policyname IN ('wc_staff_read', 'wo_staff_read', 'woi_staff_read')
  UNION ALL
  SELECT 8, 'customers: trigger de autoridad habilitado sobre las columnas mayoristas',
         EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                  WHERE t.tgrelid = 'public.customers'::regclass
                    AND t.tgname = 'trig_customers_wholesale_authority'
                    AND t.tgenabled = 'O'
                    AND t.tgfoid = 'private.enforce_customer_wholesale_authority()'::regprocedure
                    AND pg_get_triggerdef(t.oid) LIKE
                        '%BEFORE INSERT OR UPDATE OF customer_type, business_name, contact_person, business_id ON public.customers FOR EACH ROW%'),
         NULL
  UNION ALL
  SELECT 9, 'internal_tool_principals fuera de la API (tabla, auditoria, schema)',
         NOT has_table_privilege('anon', 'private.internal_tool_principals', 'SELECT')
     AND NOT has_table_privilege('authenticated', 'private.internal_tool_principals', 'SELECT,INSERT,UPDATE,DELETE')
     AND NOT has_table_privilege('service_role', 'private.internal_tool_principals', 'SELECT,INSERT,UPDATE,DELETE')
     AND NOT has_table_privilege('authenticated', 'private.internal_tool_principal_audit', 'SELECT,INSERT,UPDATE,DELETE')
     AND NOT has_schema_privilege('authenticated', 'private', 'USAGE')
     AND NOT has_schema_privilege('anon', 'private', 'USAGE')
     AND (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'private.internal_tool_principals'::regclass),
         NULL
  UNION ALL
  SELECT 10, 'internal_tool_principals: PK tool_key, sin UNIQUE en user_id, CHECK portal_clic',
         EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'private.internal_tool_principals'::regclass AND contype = 'p'
                    AND pg_get_constraintdef(oid) = 'PRIMARY KEY (tool_key)')
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index i
                      WHERE i.indrelid = 'private.internal_tool_principals'::regclass
                        AND i.indisunique AND NOT i.indisprimary)
     AND EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'private.internal_tool_principals'::regclass AND contype = 'c'
                    AND pg_get_constraintdef(oid) LIKE '%portal_clic%'),
         NULL
  UNION ALL
  SELECT 11, 'auditoria del principal: trigger de alta/cambio/baja + append-only',
         (SELECT count(*) FROM pg_catalog.pg_trigger
           WHERE NOT tgisinternal AND tgenabled = 'O'
             AND ((tgrelid = 'private.internal_tool_principals'::regclass
                   AND tgname = 'trig_internal_tool_principal_audit')
               OR (tgrelid = 'private.internal_tool_principal_audit'::regclass
                   AND tgname = 'trig_internal_tool_principal_audit_immutable'))) = 2,
         NULL
  UNION ALL
  SELECT 12, 'ninguna funcion expuesta escribe el principal (sin auto-asignacion)',
         NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                     WHERE p.prosrc ~* 'internal_tool_principals'
                       AND p.oid <> 'private.internal_tool_principal_audit_write()'::regprocedure
                       AND p.oid <> 'public.current_user_has_internal_tool_access(text,uuid)'::regprocedure),
         (SELECT string_agg(p.oid::regprocedure::text, ', ') FROM pg_catalog.pg_proc p
           WHERE p.prosrc ~* 'internal_tool_principals'
             AND p.oid <> 'private.internal_tool_principal_audit_write()'::regprocedure
             AND p.oid <> 'public.current_user_has_internal_tool_access(text,uuid)'::regprocedure)
  UNION ALL
  SELECT 13, 'principales: a lo sumo 1; si existe, es miembro activo u owner de su negocio',
         (SELECT count(*) FROM private.internal_tool_principals) <= 1
     AND NOT EXISTS (SELECT 1 FROM private.internal_tool_principals t
                      WHERE t.active
                        AND NOT EXISTS (SELECT 1 FROM public.businesses b
                                         WHERE b.id = t.business_id AND b.owner_user_id = t.user_id)
                        AND NOT EXISTS (SELECT 1 FROM public.profiles p
                                         WHERE p.business_id = t.business_id
                                           AND COALESCE(p.user_id, p.id) = t.user_id
                                           AND COALESCE(p.is_active, true))),
         (SELECT count(*)::text || ' principal(es); 0 = binding pendiente' FROM private.internal_tool_principals)
  UNION ALL
  SELECT 14, 'clic_wholesale_product_settings: solo cwps_internal_tool, sin owner/portal_enabled',
         count(*) = 1
     AND bool_and(policyname = 'cwps_internal_tool'
                  AND cmd = 'ALL' AND roles = '{authenticated}'::name[]
                  AND qual ~ 'current_user_has_internal_tool_access'
                  AND with_check ~ 'current_user_has_internal_tool_access'
                  AND (qual || with_check) !~ '(owner_user_id|wholesale_portal_enabled)'),
         string_agg(policyname, ', ')
    FROM pg_catalog.pg_policies
   WHERE schemaname = 'public' AND tablename = 'clic_wholesale_product_settings'
  UNION ALL
  SELECT 15, 'storage clic-wholesale-products: 4 policies, todas con la autoridad interna',
         count(*) = 4
     AND bool_and(policyname LIKE 'portal\_clic\_objects\_%'
                  AND roles = '{authenticated}'::name[]
                  AND (COALESCE(qual, '') || COALESCE(with_check, '')) ~ 'current_user_has_internal_tool_access'
                  AND (COALESCE(qual, '') || COALESCE(with_check, '')) ~ 'foldername'),
         string_agg(policyname || ':' || cmd, ', ' ORDER BY policyname)
    FROM pg_catalog.pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND (COALESCE(qual, '') || COALESCE(with_check, '')) LIKE '%clic-wholesale-products%'
  UNION ALL
  SELECT 16, 'checkout publico sigue delegando al privado (sin cambios de firma/ACL)',
         has_function_privilege('authenticated', 'public.create_comprobante_checkout_atomic(uuid,text,text,jsonb)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.create_comprobante_checkout_atomic(uuid,text,text,jsonb)', 'EXECUTE')
     AND (SELECT prosrc FROM pg_catalog.pg_proc
           WHERE oid = 'private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)'::regprocedure)
         LIKE '%v_is_wholesale := v_is_wholesale AND public.current_user_has_wholesale_access(p_business_id);%',
         NULL
)
SELECT n, check_name, ok, detalle FROM checks
UNION ALL
SELECT 99, 'TODOS LOS CHECKS', bool_and(ok), NULL FROM checks
ORDER BY 1;

-- Huella de customers (misma expresion que el preflight y la POSTCONDICION 9).
SELECT count(*) AS customers_n,
       count(*) FILTER (WHERE c.customer_type = 'mayorista') AS customers_mayoristas,
       md5(COALESCE(string_agg(concat_ws('|', c.id, c.customer_type, c.business_name, c.contact_person, c.updated_at),
                               ',' ORDER BY c.id), '')) AS customers_huella,
       (SELECT count(*) FROM public.clic_wholesale_product_settings) AS cwps_n,
       (SELECT count(*) FROM storage.objects WHERE bucket_id = 'clic-wholesale-products') AS clic_objects_n
  FROM public.customers c;

\if :{?preflight_customers_huella}
SELECT md5(COALESCE(string_agg(concat_ws('|', c.id, c.customer_type, c.business_name, c.contact_person, c.updated_at),
                               ',' ORDER BY c.id), '')) = :'preflight_customers_huella' AS customers_huella_igual_al_preflight
  FROM public.customers c;
\else
\echo 'Sin -v preflight_customers_huella: comparar customers_huella a mano con la salida del preflight.'
\endif

ROLLBACK;
