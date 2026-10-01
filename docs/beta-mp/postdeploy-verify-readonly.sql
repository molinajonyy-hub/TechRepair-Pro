-- ============================================================================
-- BETA-MP · VERIFICACION POST-MIGRACION de solo lectura
--
-- Se corre DESPUES de aplicar la migracion 20261012120000 y se repite durante el
-- smoke. No escribe nada (lo verifica `npm run guard:beta-mp:readonly-sql`).
--
-- Seccion 1: cada fila `check:*` tiene que dar `true`.
-- Secciones 2 a 5: reemplazar el uuid de ejemplo por el del negocio de prueba.
-- ============================================================================

-- ── 1. Contrato de la migracion ─────────────────────────────────────────────
SELECT 'check:migracion registrada' AS control,
       EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261012120000')::text AS valor
UNION ALL
SELECT 'check:anon y authenticated sin acceso a la tabla de checkout',
       (NOT has_table_privilege('authenticated', 'public.subscription_checkout_sessions', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
        AND NOT has_table_privilege('anon', 'public.subscription_checkout_sessions', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
        AND NOT has_any_column_privilege('authenticated', 'public.subscription_checkout_sessions', 'SELECT, INSERT, UPDATE'))::text
UNION ALL
SELECT 'check:service_role lee, crea y actualiza sesiones',
       (has_table_privilege('service_role', 'public.subscription_checkout_sessions', 'SELECT')
        AND has_table_privilege('service_role', 'public.subscription_checkout_sessions', 'INSERT')
        AND has_table_privilege('service_role', 'public.subscription_checkout_sessions', 'UPDATE'))::text
UNION ALL
SELECT 'check:service_role no borra sesiones',
       (NOT has_table_privilege('service_role', 'public.subscription_checkout_sessions', 'DELETE, TRUNCATE'))::text
UNION ALL
SELECT 'check:sin policies de cliente en la tabla de checkout',
       (NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.subscription_checkout_sessions'::regclass
                       AND polname IN ('scs_insert', 'scs_select')))::text
UNION ALL
SELECT 'check:RLS activo en la tabla de checkout',
       (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.subscription_checkout_sessions'::regclass)::text
UNION ALL
SELECT 'check:columnas nuevas de la sesion',
       ((SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.subscription_checkout_sessions'::regclass AND NOT attisdropped
           AND attname IN ('mp_preapproval_plan_id', 'mp_preapproval_id', 'payer_email', 'confirmed_at')) = 4)::text
UNION ALL
SELECT 'check:dedupe de eventos por notificacion',
       (to_regclass('public.uq_subscription_events_notification') IS NOT NULL
        AND to_regclass('public.uq_subscription_events_dedupe') IS NULL)::text
UNION ALL
SELECT 'check:payments admite upsert (indice unico no parcial)',
       EXISTS (SELECT 1 FROM pg_index i
                WHERE i.indrelid = 'public.payments'::regclass AND i.indisunique AND i.indisvalid AND i.indpred IS NULL
                  AND pg_get_indexdef(i.indexrelid) LIKE '%(provider, external_payment_id)%')::text
ORDER BY 1;

-- ── 2. El negocio de prueba (reemplazar el uuid) ────────────────────────────
SELECT id, subscription_status, subscription_plan, access_source, subscription_provider,
       mp_preapproval_id, mp_preapproval_plan_id,
       current_period_start, current_period_end, grace_until, trial_ends_at,
       last_payment_id, last_payment_status, mp_last_modified, last_webhook_at, updated_at
  FROM public.businesses
 WHERE id = '00000000-0000-0000-0000-000000000000';

-- ── 3. Sus checkouts ────────────────────────────────────────────────────────
SELECT id, status, plan_id, billing_cycle, amount, currency, mp_preapproval_plan_id, mp_preapproval_id,
       (external_reference LIKE 'trpcs\_%') AS referencia_del_servidor,
       created_at, updated_at, confirmed_at
  FROM public.subscription_checkout_sessions
 WHERE business_id = '00000000-0000-0000-0000-000000000000'
 ORDER BY created_at DESC;

-- ── 4. Eventos (webhook + auditoria) ────────────────────────────────────────
SELECT created_at, event_type, external_id, notification_id, processed, processed_at, error_message,
       raw_payload->>'source' AS origen,
       raw_payload->'to'->>'status' AS estado_resultante,
       raw_payload->'to'->>'plan' AS plan_resultante
  FROM public.subscription_events
 WHERE business_id = '00000000-0000-0000-0000-000000000000'
 ORDER BY created_at DESC
 LIMIT 50;

-- Notificaciones que no se pudieron atribuir a ningun negocio (referencia
-- ausente o desconocida) y las que quedaron sin procesar.
SELECT created_at, event_type, external_id, notification_id, processed, error_message
  FROM public.subscription_events
 WHERE created_at > now() - interval '2 days'
   AND (business_id IS NULL OR NOT processed)
 ORDER BY created_at DESC
 LIMIT 50;

-- ── 5. Ledger de cobros ─────────────────────────────────────────────────────
SELECT created_at, external_payment_id, type, amount, currency, status, subscription_plan, paid_at,
       raw_payload->>'preapproval_id' AS preapproval, raw_payload->>'payment_id' AS pago
  FROM public.payments
 WHERE business_id = '00000000-0000-0000-0000-000000000000'
 ORDER BY created_at DESC;
