-- ============================================================================
-- BETA-MP · PREFLIGHT de solo lectura
--
-- Se corre ANTES de aplicar la migracion del Plan B (20261013120000) y de
-- desplegar las Edge Functions. No escribe nada (lo verifica
-- `npm run guard:beta-mp:readonly-sql`).
-- Guardar la salida: es la linea de base contra la que se compara el smoke.
--
-- Cada fila `gate:*` tiene que dar `true`. Si alguna da `false`, NO seguir.
-- ============================================================================

-- ── 1. Gates: lo que la migracion da por cierto ─────────────────────────────
SELECT 'gate:la tabla de checkout no tiene escritura de cliente' AS control,
       (NOT has_table_privilege('authenticated', 'public.subscription_checkout_sessions', 'INSERT, UPDATE, DELETE, TRUNCATE')
        AND NOT has_table_privilege('anon', 'public.subscription_checkout_sessions', 'INSERT, UPDATE, DELETE, TRUNCATE'))::text AS valor
UNION ALL
SELECT 'gate:external_reference es unica',
       EXISTS (SELECT 1 FROM pg_constraint c
                WHERE c.conrelid = 'public.subscription_checkout_sessions'::regclass AND c.contype = 'u'
                  AND pg_get_constraintdef(c.oid) = 'UNIQUE (external_reference)')::text
UNION ALL
SELECT 'gate:hay un indice de dedupe de eventos (viejo o nuevo)',
       (to_regclass('public.uq_subscription_events_dedupe') IS NOT NULL
        OR to_regclass('public.uq_subscription_events_notification') IS NOT NULL)::text
UNION ALL
SELECT 'gate:payments sin cobros duplicados',
       (NOT EXISTS (SELECT 1 FROM public.payments WHERE external_payment_id IS NOT NULL
                     GROUP BY provider, external_payment_id HAVING count(*) > 1))::text
UNION ALL
SELECT 'gate:ningun negocio quedo en pending_activation',
       (NOT EXISTS (SELECT 1 FROM public.businesses WHERE subscription_status = 'pending_activation'))::text
UNION ALL
SELECT 'gate:existe la autoridad de capacidad',
       (to_regprocedure('public.current_user_can_in_business(uuid, text)') IS NOT NULL
        AND has_function_privilege('authenticated', 'public.current_user_can_in_business(uuid, text)', 'EXECUTE'))::text
UNION ALL
SELECT 'gate:plan B: la migracion BETA-MP (20261012120000) esta aplicada',
       (EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261012120000')
        AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.subscription_checkout_sessions'::regclass
                       AND attname = 'mp_preapproval_id' AND NOT attisdropped))::text
UNION ALL
SELECT 'gate:plan B: ningun preapproval figura en dos sesiones',
       (NOT EXISTS (SELECT 1 FROM public.subscription_checkout_sessions WHERE mp_preapproval_id IS NOT NULL
                     GROUP BY mp_preapproval_id HAVING count(*) > 1))::text
UNION ALL
SELECT 'gate:plan B: la tabla de checkout sigue sin lectura de cliente',
       (NOT has_table_privilege('authenticated', 'public.subscription_checkout_sessions', 'SELECT')
        AND NOT has_table_privilege('anon', 'public.subscription_checkout_sessions', 'SELECT'))::text
UNION ALL
SELECT 'gate:service_role escribe las columnas de billing de businesses',
       (has_column_privilege('service_role', 'public.businesses', 'subscription_status', 'UPDATE')
        AND has_column_privilege('service_role', 'public.businesses', 'subscription_plan', 'UPDATE')
        AND has_column_privilege('service_role', 'public.businesses', 'mp_preapproval_id', 'UPDATE')
        AND has_column_privilege('service_role', 'public.businesses', 'access_source', 'UPDATE'))::text
ORDER BY 1;

-- ── 2. Linea de base de datos ───────────────────────────────────────────────
SELECT 'payments' AS dato, count(*)::text AS valor FROM public.payments
UNION ALL SELECT 'subscription_events (total)', count(*)::text FROM public.subscription_events
UNION ALL SELECT 'subscription_events (mercadopago)', count(*)::text FROM public.subscription_events
           WHERE event_type IN ('payment', 'subscription_preapproval', 'subscription_authorized_payment')
UNION ALL SELECT 'subscription_events sin procesar', count(*)::text FROM public.subscription_events WHERE NOT processed
UNION ALL SELECT 'subscription_checkout_sessions', count(*)::text FROM public.subscription_checkout_sessions
UNION ALL SELECT 'subscription_checkout_sessions pending sin preapproval (checkouts del Plan A)', count(*)::text
           FROM public.subscription_checkout_sessions WHERE status = 'pending' AND mp_preapproval_id IS NULL
UNION ALL SELECT 'negocios con mp_preapproval_id', count(*)::text FROM public.businesses WHERE mp_preapproval_id IS NOT NULL
UNION ALL SELECT 'negocios con access_source = mercado_pago', count(*)::text FROM public.businesses WHERE access_source = 'mercado_pago'
UNION ALL SELECT 'negocios con plan de MP anotado y sin suscripcion (restos del create viejo)', count(*)::text
           FROM public.businesses WHERE mp_preapproval_plan_id IS NOT NULL AND mp_preapproval_id IS NULL
UNION ALL SELECT 'ultima migracion aplicada', max(version) FROM supabase_migrations.schema_migrations
ORDER BY 1;

-- ── 3. Negocios por estado y origen del acceso ──────────────────────────────
SELECT subscription_status, coalesce(access_source, '(null)') AS access_source,
       coalesce(subscription_plan, '(null)') AS subscription_plan, count(*) AS negocios
  FROM public.businesses
 GROUP BY 1, 2, 3
 ORDER BY 1, 2, 3;

-- ── 4. Privilegios y policies de las tablas de billing ──────────────────────
SELECT table_name, grantee, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privilegios
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public'
   AND table_name IN ('subscription_checkout_sessions', 'subscription_events', 'payments')
   AND grantee IN ('anon', 'authenticated', 'service_role')
 GROUP BY 1, 2
 ORDER BY 1, 2;

SELECT tablename, policyname, cmd, array_to_string(roles, ',') AS roles
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('subscription_checkout_sessions', 'subscription_events', 'payments')
 ORDER BY 1, 2;

SELECT tablename, indexname, indexdef
  FROM pg_indexes
 WHERE schemaname = 'public'
   AND tablename IN ('subscription_checkout_sessions', 'subscription_events', 'payments')
 ORDER BY 1, 2;

-- ── 5. Cron de billing ──────────────────────────────────────────────────────
SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'billing-%' ORDER BY 1;
