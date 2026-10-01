-- ============================================================================
-- BETA-MP · la sesion de checkout es autoridad del servidor
--
-- Billing SaaS (mp-subscription + mp-webhook). No toca el POS ni Merchant Connect.
--
-- DISCOVERY (produccion read-only 2026-10-01 + baseline del repo):
--   subscription_checkout_sessions
--     filas        0 (el pipeline de Mercado Pago nunca corrio en produccion).
--     ACL          service_role: SELECT + UPDATE(status, updated_at).
--                  anon / authenticated: NADA.
--     policies     scs_insert  INSERT  WITH CHECK (business_id = current_user_business_id())
--                  scs_select  SELECT  USING      (business_id = current_user_business_id())
--                  scs_service ALL     USING      (auth.role() = 'service_role')
--     Consecuencia: el navegador intentaba insertar la sesion y fallaba con
--     42501 (sin GRANT); el backend tampoco podia insertar. La tabla estaba
--     vacia por construccion y nadie podia registrar una intencion de compra.
--   subscription_events
--     uq_subscription_events_dedupe UNIQUE (provider, event_type, external_id)
--     WHERE external_id IS NOT NULL. external_id es el RECURSO de Mercado Pago
--     (data.id). Un preapproval emite varias notificaciones con el mismo data.id
--     (created/pending, updated/authorized, updated/cancelled): con esa clave la
--     segunda chocaba contra la primera, ya procesada, y se descartaba. El
--     `authorized` posterior a un `pending` no se procesaba nunca.
--
-- QUE HACE
--   1. subscription_checkout_sessions pasa a ser SOLO del backend:
--        · columnas para la intencion y su resultado: mp_preapproval_plan_id
--          (plan de MP esperado), mp_preapproval_id (suscripcion confirmada),
--          payer_email, confirmed_at;
--        · service_role: SELECT, INSERT, UPDATE (sin DELETE ni TRUNCATE);
--        · anon / authenticated / PUBLIC: REVOKE ALL;
--        · DROP de scs_insert y scs_select: sin GRANT estaban muertas, y un
--          GRANT futuro no debe reabrir una escritura del navegador. RLS sigue
--          ON; el estado del checkout se lee por la Edge Function.
--   2. subscription_events deduplica por NOTIFICACION:
--        · columna notification_id (el `id` de la notificacion de MP);
--        · UNIQUE (provider, event_type, external_id, notification_id) cuando
--          ambos existen. La misma notificacion reenviada sigue chocando; otra
--          notificacion del mismo recurso, no.
--
--   3. payments (ledger de cobros SaaS) puede recibir un upsert:
--        · el unico indice unico era idx_payments_external_id, PARCIAL
--          (WHERE external_payment_id IS NOT NULL). PostgREST arma
--          `ON CONFLICT (provider, external_payment_id)` sin predicado, y
--          PostgreSQL no infiere un indice parcial desde ahi: 42P10. El upsert
--          del webhook (el desplegado tambien) fallaba en el PRIMER cobro. Medido
--          contra el stack local; en produccion nunca se llego a ejecutar.
--        · se agrega un indice unico NO parcial sobre las mismas columnas. Los
--          NULL siguen siendo distintos entre si, asi que la regla no cambia.
--
-- QUE NO HACE: cero DML. No toca businesses, sus grants ni sus triggers, los
-- grants de payments, ni process_mp_subscription_payment (sin consumidor; fuera
-- de alcance).
--
-- ORDEN DE ROLLOUT: esta migracion va ANTES que las Edge Functions de BETA-MP.
--   · Con la migracion y las funciones VIEJAS (mp-webhook v23): el insert viejo
--     no manda notification_id, asi que nunca choca y procesa todas las
--     notificaciones con sus upserts. No rompe nada.
--   · Con las funciones NUEVAS y sin la migracion: `create` no puede insertar
--     la sesion y responde 503 sin devolver un checkout (fail-closed).
--
-- IDEMPOTENTE: se puede re-ejecutar. FAIL-CLOSED: si una precondicion no
-- coincide con el discovery, RAISE y nada se aplica.
--
-- ROLLBACK (manual, sin perdida de datos de billing):
--   DROP INDEX public.uq_subscription_events_notification;
--   CREATE UNIQUE INDEX uq_subscription_events_dedupe ON public.subscription_events
--     (provider, event_type, external_id) WHERE external_id IS NOT NULL;   -- puede fallar si ya hay 2 notificaciones del mismo recurso
--   REVOKE INSERT, UPDATE ON public.subscription_checkout_sessions FROM service_role;
--   GRANT UPDATE (status, updated_at) ON public.subscription_checkout_sessions TO service_role;
--   (las columnas nuevas y las policies eliminadas no hace falta restaurarlas)
-- ============================================================================
BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- 0. PRECONDICIONES
-- ════════════════════════════════════════════════════════════════════════════
DO $pre$
DECLARE
  v_scs    oid := to_regclass('public.subscription_checkout_sessions');
  v_events oid := to_regclass('public.subscription_events');
  v_pays   oid := to_regclass('public.payments');
  v_role   text;
  v_missing text;
BEGIN
  -- PRECONDICION 1 · las tres tablas existen, son tablas comunes y tienen RLS.
  IF v_scs IS NULL OR v_events IS NULL OR v_pays IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION 1: faltan subscription_checkout_sessions, subscription_events o payments';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c WHERE c.oid IN (v_scs, v_events, v_pays)
                AND NOT (c.relkind = 'r' AND c.relrowsecurity)) THEN
    RAISE EXCEPTION 'PRECONDICION 1: alguna de las tablas no es una tabla comun con RLS activo';
  END IF;

  -- PRECONDICION 2 · columnas del baseline que usa el backend.
  SELECT string_agg(e.col, ', ') INTO v_missing
    FROM unnest(ARRAY['id','business_id','user_id','plan_id','billing_cycle','amount','currency',
                      'external_reference','status','created_at','updated_at']) AS e(col)
   WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = v_scs AND a.attname = e.col
                        AND a.attnum > 0 AND NOT a.attisdropped);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDICION 2: subscription_checkout_sessions no tiene las columnas: %', v_missing;
  END IF;
  SELECT string_agg(e.col, ', ') INTO v_missing
    FROM unnest(ARRAY['id','business_id','provider','event_type','external_id','raw_payload',
                      'processed','error_message','processed_at']) AS e(col)
   WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = v_events AND a.attname = e.col
                        AND a.attnum > 0 AND NOT a.attisdropped);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDICION 2: subscription_events no tiene las columnas: %', v_missing;
  END IF;

  -- PRECONDICION 3 · el navegador NO escribe la tabla hoy. Si algun rol de
  -- cliente ya tuviera INSERT/UPDATE/DELETE, hay un consumidor que el discovery
  -- no vio: abortar en vez de cortarlo a ciegas.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(v_role, v_scs, 'INSERT, UPDATE, DELETE, TRUNCATE')
       OR has_any_column_privilege(v_role, v_scs, 'INSERT, UPDATE') THEN
      RAISE EXCEPTION 'PRECONDICION 3: % tiene escritura sobre subscription_checkout_sessions (el discovery midio que no)', v_role;
    END IF;
  END LOOP;

  -- PRECONDICION 4 · la referencia externa es unica (la sesion se resuelve por ella).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = v_scs AND c.contype = 'u'
                    AND pg_get_constraintdef(c.oid) = 'UNIQUE (external_reference)') THEN
    RAISE EXCEPTION 'PRECONDICION 4: falta UNIQUE (external_reference) en subscription_checkout_sessions';
  END IF;

  -- PRECONDICION 5 · el dedupe de eventos esta en uno de los dos estados
  -- conocidos: el viejo (por recurso) o el de esta migracion (por notificacion).
  IF to_regclass('public.uq_subscription_events_dedupe') IS NULL
     AND to_regclass('public.uq_subscription_events_notification') IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION 5: no existe ningun indice unico de dedupe en subscription_events (drift)';
  END IF;

  -- PRECONDICION 6 · el ledger no tiene cobros duplicados: el indice unico nuevo
  -- tiene que poder crearse sin tocar una fila.
  IF EXISTS (SELECT 1 FROM public.payments WHERE external_payment_id IS NOT NULL
              GROUP BY provider, external_payment_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'PRECONDICION 6: payments tiene (provider, external_payment_id) duplicados';
  END IF;
END
$pre$;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. subscription_checkout_sessions: intencion y resultado, solo del backend
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.subscription_checkout_sessions
  ADD COLUMN IF NOT EXISTS mp_preapproval_plan_id text,
  ADD COLUMN IF NOT EXISTS mp_preapproval_id      text,
  ADD COLUMN IF NOT EXISTS payer_email            text,
  ADD COLUMN IF NOT EXISTS confirmed_at           timestamp with time zone;

COMMENT ON COLUMN public.subscription_checkout_sessions.mp_preapproval_plan_id IS
  'BETA-MP: plan de Mercado Pago ESPERADO para este checkout (resuelto por secret en el servidor).';
COMMENT ON COLUMN public.subscription_checkout_sessions.mp_preapproval_id IS
  'BETA-MP: preapproval de Mercado Pago visto/confirmado para este checkout. Lo escribe solo el backend.';
COMMENT ON COLUMN public.subscription_checkout_sessions.payer_email IS
  'BETA-MP: email del usuario autenticado que abrio el checkout (del JWT, no del body).';
COMMENT ON COLUMN public.subscription_checkout_sessions.confirmed_at IS
  'BETA-MP: momento en que Mercado Pago confirmo la suscripcion de este checkout.';

CREATE INDEX IF NOT EXISTS idx_scs_mp_preapproval
  ON public.subscription_checkout_sessions (mp_preapproval_id)
  WHERE mp_preapproval_id IS NOT NULL;

DROP POLICY IF EXISTS scs_insert ON public.subscription_checkout_sessions;
DROP POLICY IF EXISTS scs_select ON public.subscription_checkout_sessions;

REVOKE ALL ON TABLE public.subscription_checkout_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.subscription_checkout_sessions TO service_role;

COMMENT ON TABLE public.subscription_checkout_sessions IS
  'BETA-MP: intencion de compra de una suscripcion SaaS y su resultado. Autoridad del servidor: la crea '
  'mp-subscription (service_role) y la resuelve el webhook / reconcile. Sin acceso para anon/authenticated: '
  'el navegador consulta el estado por la Edge Function. Abrir un checkout NO cambia businesses.';

-- ════════════════════════════════════════════════════════════════════════════
-- 2. subscription_events: idempotencia por notificacion
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.subscription_events
  ADD COLUMN IF NOT EXISTS notification_id text;

COMMENT ON COLUMN public.subscription_events.notification_id IS
  'BETA-MP: `id` de la notificacion de Mercado Pago. Con external_id (el recurso) forma la clave de idempotencia.';

DROP INDEX IF EXISTS public.uq_subscription_events_dedupe;

CREATE UNIQUE INDEX IF NOT EXISTS uq_subscription_events_notification
  ON public.subscription_events (provider, event_type, external_id, notification_id)
  WHERE external_id IS NOT NULL AND notification_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. payments: indice unico inferible por ON CONFLICT
-- ════════════════════════════════════════════════════════════════════════════
-- idx_payments_external_id (parcial) se conserva: ya garantiza que no hay
-- duplicados, asi que este indice se crea sin conflicto.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_provider_external_payment
  ON public.payments (provider, external_payment_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 4. POSTCONDICIONES
-- ════════════════════════════════════════════════════════════════════════════
DO $post$
DECLARE
  v_scs    oid := 'public.subscription_checkout_sessions'::regclass;
  v_events oid := 'public.subscription_events'::regclass;
  v_role   text;
  v_def    text;
BEGIN
  -- POSTCONDICION 1 · ningun rol de cliente toca la tabla de checkout.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(v_role, v_scs, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       OR has_any_column_privilege(v_role, v_scs, 'SELECT, INSERT, UPDATE, REFERENCES') THEN
      RAISE EXCEPTION 'POSTCONDICION 1: % conserva acceso a subscription_checkout_sessions', v_role;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
              WHERE c.oid = v_scs AND a.grantee = 0) THEN
    RAISE EXCEPTION 'POSTCONDICION 1: PUBLIC conserva privilegios sobre subscription_checkout_sessions';
  END IF;

  -- POSTCONDICION 2 · service_role lee, crea y actualiza; no borra ni trunca.
  IF NOT (has_table_privilege('service_role', v_scs, 'SELECT')
          AND has_table_privilege('service_role', v_scs, 'INSERT')
          AND has_table_privilege('service_role', v_scs, 'UPDATE')) THEN
    RAISE EXCEPTION 'POSTCONDICION 2: service_role no tiene SELECT/INSERT/UPDATE sobre subscription_checkout_sessions';
  END IF;
  IF has_table_privilege('service_role', v_scs, 'DELETE, TRUNCATE') THEN
    RAISE EXCEPTION 'POSTCONDICION 2: service_role puede borrar o truncar subscription_checkout_sessions';
  END IF;

  -- POSTCONDICION 3 · RLS activo y sin policies de cliente.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_scs) THEN
    RAISE EXCEPTION 'POSTCONDICION 3: subscription_checkout_sessions perdio RLS';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_scs AND polname IN ('scs_insert', 'scs_select')) THEN
    RAISE EXCEPTION 'POSTCONDICION 3: quedan policies de cliente sobre subscription_checkout_sessions';
  END IF;

  -- POSTCONDICION 4 · columnas nuevas presentes.
  IF (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = v_scs AND NOT a.attisdropped
         AND a.attname IN ('mp_preapproval_plan_id', 'mp_preapproval_id', 'payer_email', 'confirmed_at')) <> 4
     OR NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = v_events AND NOT a.attisdropped
                       AND a.attname = 'notification_id') THEN
    RAISE EXCEPTION 'POSTCONDICION 4: faltan columnas de BETA-MP';
  END IF;

  -- POSTCONDICION 5 · un unico indice de dedupe, y es el de notificacion.
  IF to_regclass('public.uq_subscription_events_dedupe') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDICION 5: sigue existiendo el dedupe por recurso';
  END IF;
  SELECT pg_get_indexdef(i.indexrelid) INTO v_def
    FROM pg_index i WHERE i.indexrelid = to_regclass('public.uq_subscription_events_notification')
     AND i.indrelid = v_events AND i.indisunique AND i.indisvalid;
  IF v_def IS NULL
     OR v_def NOT LIKE '%(provider, event_type, external_id, notification_id)%'
     OR v_def NOT LIKE '%external_id IS NOT NULL%' OR v_def NOT LIKE '%notification_id IS NOT NULL%' THEN
    RAISE EXCEPTION 'POSTCONDICION 5: uq_subscription_events_notification no tiene la forma esperada (%)', v_def;
  END IF;

  -- POSTCONDICION 6 · payments tiene un indice unico NO parcial sobre
  -- (provider, external_payment_id): el que necesita el upsert del webhook.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indrelid = 'public.payments'::regclass AND i.indisunique AND i.indisvalid AND i.indpred IS NULL
       AND pg_get_indexdef(i.indexrelid) LIKE '%(provider, external_payment_id)%') THEN
    RAISE EXCEPTION 'POSTCONDICION 6: payments no tiene un indice unico no parcial sobre (provider, external_payment_id)';
  END IF;

  RAISE NOTICE 'BETA-MP OK · subscription_checkout_sessions solo backend (service_role SELECT/INSERT/UPDATE, '
    'sin acceso de cliente, sin scs_insert/scs_select) · subscription_events deduplica por notificacion · '
    'payments admite upsert por (provider, external_payment_id) · cero DML.';
END
$post$;

COMMIT;
