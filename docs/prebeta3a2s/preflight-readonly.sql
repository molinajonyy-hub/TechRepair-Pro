-- ============================================================================
-- PRE-BETA-3A-2S · PREFLIGHT (SOLO LECTURA)
--
-- Correr ANTES de aplicar:
--   20261011120000_prebeta3a2s_wholesale_server_authority.sql
--   20261011130000_prebeta3a2s_portal_clic_internal_authority.sql
--
--   psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f docs/prebeta3a2s/preflight-readonly.sql
--
-- Todo corre en una transaccion READ ONLY. No escribe nada.
--
--   1. GATES      · todos tienen que dar ok = true. Si uno da false, NO aplicar:
--                   la migracion abortaria igual (mismas precondiciones), pero
--                   hay que entender la deriva primero.
--   2. IMPACTO    · informativo: quien gana o pierde acceso, que ventas cambian
--                   de precio, que datos hacen falta para el binding de Portal
--                   Clic. Revisarlo con producto ANTES de aplicar.
--   3. HUELLA     · guardar la salida: postdeploy-verify-readonly.sql la compara.
-- ============================================================================

BEGIN TRANSACTION READ ONLY;

-- ── 1. GATES ────────────────────────────────────────────────────────────────
WITH pins(firma, md5_esperado) AS (VALUES
    ('public.business_has_feature(text)',                                              '9a0767b84a5812ca3d91b3ce68adbb2c'),
    ('public.get_business_subscription_features(uuid)',                                '61405d1317b34f334db423854552e6e1'),
    ('public.get_wholesale_portal_features(text)',                                     '2e975d248a0efaa92b8fb25d0b3e62fc'),
    ('private.capability_resolve(text,jsonb,text)',                                    'aabb25e24b7a8f32f5ff1dda85ab5a17'),
    ('public.update_wholesale_order_status_atomic(uuid,uuid,text,text)',               '84b8327a7b610685f7cb20faf57cbc87'),
    ('public.update_wholesale_customer_status_atomic(uuid,uuid,boolean,boolean,text)', '6d6f1daa9a0611e286e698dd58763135'),
    ('public.can_manage_wholesale()',                                                  'b65efc4826fb50a6a95f12c9c44e4365'),
    ('private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)',               '8ef9e4a8e7d15df55d90eb0983996d1f')
), pin_estado AS (
  SELECT pins.firma, pins.md5_esperado,
         (SELECT md5(replace(p.prosrc, E'\r', '')) FROM pg_catalog.pg_proc p
           WHERE p.oid = to_regprocedure(pins.firma)) AS md5_actual
    FROM pins
), gates(n, gate, ok, detalle) AS (
  SELECT 1, 'tip = 20261010120000 (prebeta1 aplicada, 3A-2S no)',
         (SELECT max(version) FROM supabase_migrations.schema_migrations) = '20261010120000',
         (SELECT max(version) FROM supabase_migrations.schema_migrations)
  UNION ALL
  SELECT 2, '3A-2S no registrada',
         NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations
                      WHERE version IN ('20261011120000', '20261011130000')), NULL
  UNION ALL
  SELECT 3, 'objetos nuevos inexistentes',
         to_regprocedure('private.plan_feature_enabled(text,text,text)') IS NULL
     AND to_regprocedure('private.business_feature_enabled(uuid,text)') IS NULL
     AND to_regprocedure('private.wholesale_access_level(uuid)') IS NULL
     AND to_regprocedure('public.current_user_has_wholesale_access(uuid)') IS NULL
     AND to_regprocedure('public.current_user_can_manage_wholesale(uuid)') IS NULL
     AND to_regprocedure('private.enforce_customer_wholesale_authority()') IS NULL
     AND to_regprocedure('public.get_or_create_customer_from_wholesale_atomic(uuid,uuid)') IS NULL
     AND to_regprocedure('public.current_user_has_internal_tool_access(text,uuid)') IS NULL
     AND to_regclass('private.internal_tool_principals') IS NULL
     AND to_regclass('private.internal_tool_principal_audit') IS NULL
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
                      WHERE tgrelid = 'public.customers'::regclass
                        AND tgname = 'trig_customers_wholesale_authority'),
         NULL
  UNION ALL
  SELECT 4, 'md5 de las 8 funciones que se redefinen = relevado',
         bool_and(md5_actual IS NOT DISTINCT FROM md5_esperado),
         string_agg(CASE WHEN md5_actual IS DISTINCT FROM md5_esperado
                         THEN firma || ' = ' || COALESCE(md5_actual, 'FALTA') END, '; ')
    FROM pin_estado
  UNION ALL
  SELECT 5, 'helpers de tenant/entitlement presentes',
         to_regprocedure('public.current_user_business_id()') IS NOT NULL
     AND to_regprocedure('public.current_business_id()') IS NOT NULL
     AND to_regprocedure('public._feat_pro(text,text)') IS NOT NULL
     AND to_regprocedure('public.create_comprobante_checkout_atomic(uuid,text,text,jsonb)') IS NOT NULL,
         NULL
  UNION ALL
  SELECT 6, 'customers.customer_type y wholesale_customers.email NOT NULL',
         (SELECT count(*) FROM information_schema.columns
           WHERE table_schema = 'public'
             AND ((table_name = 'customers' AND column_name = 'customer_type')
               OR (table_name = 'wholesale_customers' AND column_name = 'email'))
             AND is_nullable = 'NO') = 2,
         NULL
  UNION ALL
  SELECT 7, 'customers sin trigger de autoridad previo (solo updated_at)',
         NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
                      WHERE tgrelid = 'public.customers'::regclass AND NOT tgisinternal
                        AND tgname <> 'update_customers_updated_at'),
         (SELECT string_agg(tgname, ', ') FROM pg_catalog.pg_trigger
           WHERE tgrelid = 'public.customers'::regclass AND NOT tgisinternal)
  UNION ALL
  SELECT 8, 'clic_wholesale_product_settings: unica policy = cwps_owner_manage',
         (SELECT array_agg(policyname::text ORDER BY policyname) FROM pg_catalog.pg_policies
           WHERE schemaname = 'public' AND tablename = 'clic_wholesale_product_settings')
           = ARRAY['cwps_owner_manage'],
         (SELECT string_agg(policyname, ', ') FROM pg_catalog.pg_policies
           WHERE schemaname = 'public' AND tablename = 'clic_wholesale_product_settings')
  UNION ALL
  SELECT 9, 'storage.objects: ninguna policy sobre clic-wholesale-products',
         NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies
                      WHERE schemaname = 'storage' AND tablename = 'objects'
                        AND (COALESCE(qual, '') || COALESCE(with_check, '')) LIKE '%clic-wholesale-products%'),
         (SELECT string_agg(policyname, ', ') FROM pg_catalog.pg_policies
           WHERE schemaname = 'storage' AND tablename = 'objects'
             AND (COALESCE(qual, '') || COALESCE(with_check, '')) LIKE '%clic-wholesale-products%')
  UNION ALL
  SELECT 10, 'bucket clic-wholesale-products existe',
         EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'clic-wholesale-products'), NULL
  UNION ALL
  SELECT 11, 'wholesale_* staff_read = definicion lote3 (capacidad cruda)',
         (SELECT count(*) FROM pg_catalog.pg_policies
           WHERE schemaname = 'public'
             AND tablename IN ('wholesale_customers', 'wholesale_orders', 'wholesale_order_items')
             AND policyname IN ('wc_staff_read', 'wo_staff_read', 'woi_staff_read')) = 3,
         NULL
)
SELECT n, gate, ok, detalle FROM gates
UNION ALL
SELECT 99, 'TODOS LOS GATES', bool_and(ok), NULL FROM gates
ORDER BY 1;

-- ── 2. IMPACTO (informativo) ────────────────────────────────────────────────

-- 2a. Feature `mayorista` por negocio: antes Full-only, despues Pro+ (trial = Pro).
--     `portal_publico_*`: el flag `mayorista` de get_wholesale_portal_features
--     (antes _feat_full, despues _feat_pro) para portales ACTIVADOS: un Pro con
--     el portal activado pasa a tener su portal publico operativo.
SELECT COALESCE(b.subscription_plan, '(null)')   AS plan,
       COALESCE(b.subscription_status, '(null)') AS status,
       count(*)                                  AS negocios,
       count(*) FILTER (WHERE b.subscription_status IN ('active', 'trialing')
                          AND b.subscription_plan = 'full')                              AS mayorista_antes,
       count(*) FILTER (WHERE b.subscription_status IN ('active', 'trialing')
                          AND (b.subscription_plan IN ('pro', 'full')
                               OR b.subscription_status = 'trialing'))                   AS mayorista_despues,
       count(*) FILTER (WHERE b.wholesale_portal_enabled)                                AS portal_activado,
       count(*) FILTER (WHERE b.wholesale_portal_enabled
                          AND public._feat_full(b.subscription_status, b.subscription_plan)) AS portal_publico_antes,
       count(*) FILTER (WHERE b.wholesale_portal_enabled
                          AND public._feat_pro(b.subscription_status, b.subscription_plan))  AS portal_publico_despues
  FROM public.businesses b
 GROUP BY 1, 2
 ORDER BY 1, 2;

-- 2b. Portales publicos que se ENCIENDEN con el cambio (revisar uno por uno).
SELECT b.id AS business_id, b.wholesale_portal_slug, b.subscription_plan, b.subscription_status
  FROM public.businesses b
 WHERE b.wholesale_portal_enabled
   AND public._feat_pro(b.subscription_status, b.subscription_plan)
   AND NOT public._feat_full(b.subscription_status, b.subscription_plan)
 ORDER BY b.id;

-- 2c. Miembros por rol y `wholesale` efectivo, en negocios con la feature
--     DESPUES del cambio. antes = default viejo (admin/manager/sales) + override;
--     despues = owner/admin automaticos, resto solo con override true.
--     Solo se cuentan overrides booleanos (capability_resolve ignora los rotos).
WITH m AS (
  SELECT p.role,
         CASE jsonb_typeof(p.permissions -> 'wholesale')
           WHEN 'boolean' THEN (p.permissions ->> 'wholesale')::boolean END AS ov
    FROM public.profiles p
    JOIN public.businesses b ON b.id = p.business_id
   WHERE COALESCE(p.is_active, true)
     AND b.subscription_status IN ('active', 'trialing')
     AND (b.subscription_plan IN ('pro', 'full') OR b.subscription_status = 'trialing')
)
SELECT role,
       count(*)                                                                  AS miembros,
       count(*) FILTER (WHERE ov IS NULL)                                        AS sin_override,
       count(*) FILTER (WHERE ov)                                                AS override_true,
       count(*) FILTER (WHERE ov = false)                                        AS override_false,
       count(*) FILTER (WHERE role = 'owner' OR COALESCE(ov, role IN ('admin', 'manager', 'sales'))) AS capacidad_antes,
       count(*) FILTER (WHERE role IN ('owner', 'admin') OR ov IS TRUE)          AS acceso_despues,
       count(*) FILTER (WHERE role IN ('owner', 'admin', 'manager', 'sales')
                          AND (role IN ('owner', 'admin') OR ov IS TRUE))        AS gestion_despues
  FROM m
 GROUP BY role
 ORDER BY role;

-- 2d. Clientes mayoristas historicos por plan: no se convierten ni se tocan.
--     En Basico, desde el deploy el checkout los cotiza MINORISTA.
SELECT COALESCE(b.subscription_plan, '(null)') AS plan,
       count(*) FILTER (WHERE c.customer_type = 'mayorista') AS clientes_mayoristas,
       count(*)                                              AS clientes
  FROM public.customers c
  JOIN public.businesses b ON b.id = c.business_id
 GROUP BY 1
 ORDER BY 1;

-- 2e. Ventas de los ultimos 90 dias cotizadas mayorista por el checkout
--     (applied_price_source = 'resolved_mayorista'), por plan y por si el
--     vendedor TENDRIA autoridad Mayorista con el contrato nuevo. Las que dan
--     `sin_autoridad_despues` se habrian cotizado minorista.
WITH v AS (
  SELECT b.subscription_plan AS plan,
         COALESCE(b.subscription_status IN ('active', 'trialing')
          AND (b.subscription_plan IN ('pro', 'full') OR b.subscription_status = 'trialing')
          AND (c.created_by = b.owner_user_id
               OR pr.role IN ('owner', 'admin')
               OR (jsonb_typeof(pr.permissions -> 'wholesale') = 'boolean'
                   AND (pr.permissions ->> 'wholesale')::boolean)), false) AS con_autoridad
    FROM public.comprobante_items ci
    JOIN public.comprobantes c ON c.id = ci.comprobante_id
    JOIN public.businesses b   ON b.id = c.business_id
    LEFT JOIN public.profiles pr ON pr.business_id = c.business_id
                                AND COALESCE(pr.user_id, pr.id) = c.created_by
   WHERE ci.applied_price_source = 'resolved_mayorista'
     AND ci.created_at >= now() - interval '90 days'
)
SELECT COALESCE(plan, '(null)')                        AS plan,
       count(*)                                        AS items_mayoristas_90d,
       count(*) FILTER (WHERE con_autoridad)           AS con_autoridad_despues,
       count(*) FILTER (WHERE NOT con_autoridad)       AS sin_autoridad_despues
  FROM v
 GROUP BY 1
 ORDER BY 1;

-- 2f. Portal Clic HOY (cwps_owner_manage: owner + portal activado) y datos para
--     el binding. Despues del deploy NADIE entra hasta el binding.
SELECT s.business_id,
       count(*)                                  AS productos_configurados,
       bool_or(b.wholesale_portal_enabled)       AS portal_activado,
       max(b.wholesale_portal_slug)              AS slug
  FROM public.clic_wholesale_product_settings s
  JOIN public.businesses b ON b.id = s.business_id
 GROUP BY s.business_id
 ORDER BY 2 DESC;

SELECT (storage.foldername(o.name))[1] AS carpeta_negocio, count(*) AS objetos
  FROM storage.objects o
 WHERE o.bucket_id = 'clic-wholesale-products'
 GROUP BY 1
 ORDER BY 2 DESC;

-- 2g. system_admins por rol: NINGUNO obtiene Portal Clic por serlo.
SELECT role, is_active, count(*) AS cuentas
  FROM public.system_admins
 GROUP BY 1, 2
 ORDER BY 1, 2;

-- ── 3. HUELLA (guardar; la compara postdeploy-verify-readonly.sql) ──────────
-- Misma expresion que la POSTCONDICION 9 de la migracion. En un sistema vivo
-- puede moverse por trafico normal: la verificacion autoritativa es la
-- postcondicion (dentro de la transaccion de la migracion).
SELECT count(*) AS customers_n,
       count(*) FILTER (WHERE c.customer_type = 'mayorista') AS customers_mayoristas,
       md5(COALESCE(string_agg(concat_ws('|', c.id, c.customer_type, c.business_name, c.contact_person, c.updated_at),
                               ',' ORDER BY c.id), '')) AS customers_huella,
       (SELECT count(*) FROM public.clic_wholesale_product_settings) AS cwps_n,
       (SELECT count(*) FROM storage.objects WHERE bucket_id = 'clic-wholesale-products') AS clic_objects_n
  FROM public.customers c;

ROLLBACK;
