-- ============================================================================
-- BETA-MP · la sesion de checkout es autoridad del servidor.
--
-- Contrato de las migraciones 20261012120000 (BETA-MP) y 20261013120000 (Plan B)
-- medido en PostgreSQL real, ejecutando como los roles de la API
-- (SET LOCAL ROLE + request.jwt.claim.sub):
--
--   A  el navegador (authenticated / anon) no inserta, no lee y no se marca
--      `paid` una sesion de checkout: ni la propia ni la de otro negocio;
--   B  el backend (service_role) crea la sesion, la resuelve y no puede borrarla;
--   C  abrir un checkout no cambia la fila del negocio;
--   D  la referencia del checkout es unica y hay una sola sesion pending por
--      (negocio, plan, ciclo);
--   E  subscription_events deduplica por NOTIFICACION: dos notificaciones del
--      mismo recurso entran las dos; la misma notificacion dos veces, no;
--   F  payments admite el upsert del webhook;
--   G  Plan B: el preapproval que crea el backend pertenece a UNA sesion.
--
-- Requiere las dos migraciones aplicadas. Corre dentro de BEGIN ... ROLLBACK.
-- RUN: docker cp ... && psql -X -v ON_ERROR_STOP=1 -f
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;

CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label;
  ELSE RAISE NOTICE 'PASS: %', label; END IF;
END; $$;

-- Ejecuta un SQL como un rol de la API y devuelve el SQLSTATE, u 'OK'.
CREATE OR REPLACE FUNCTION pg_temp.como(p_role text, p_uid uuid, p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_state text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_uid::text, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql;
    v_state := 'OK';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
  END;
  RESET ROLE;
  RETURN v_state;
END; $$;

\set BIZ_A  '00000000-0000-4000-8000-0000000be7a1'
\set BIZ_B  '00000000-0000-4000-8000-0000000be7b1'
\set OWN_A  '00000000-0000-4000-8000-0000000be7a9'
\set OWN_B  '00000000-0000-4000-8000-0000000be7b9'
\set SES_A  '00000000-0000-4000-8000-0000000be7a5'
\set SES_B  '00000000-0000-4000-8000-0000000be7b5'

-- ── Semilla ─────────────────────────────────────────────────────────────────
SET LOCAL session_replication_role = 'replica';
INSERT INTO auth.users(id) VALUES (:'OWN_A'), (:'OWN_B');
INSERT INTO public.businesses(id, name, owner_user_id, subscription_status, subscription_plan, trial_ends_at)
  VALUES (:'BIZ_A', 'BETA-MP A', :'OWN_A', 'trialing', NULL, now() + interval '6 days'),
         (:'BIZ_B', 'BETA-MP B', :'OWN_B', 'active', 'pro', NULL);
INSERT INTO public.profiles(id, business_id, role, is_active)
  VALUES (:'OWN_A', :'BIZ_A', 'owner', true), (:'OWN_B', :'BIZ_B', 'owner', true);
SET LOCAL session_replication_role = 'origin';

-- Una sesion de cada negocio, creada por el backend (se usa como objetivo).
INSERT INTO public.subscription_checkout_sessions
  (id, business_id, user_id, plan_id, billing_cycle, amount, currency, external_reference, status,
   mp_preapproval_plan_id, payer_email)
VALUES
  (:'SES_A', :'BIZ_A', :'OWN_A', 'pro', 'monthly', 25000, 'ARS', 'trpcs_00000000-0000-4000-8000-0000000be7a5', 'pending', 'plan_pro_m', 'a@invalid.test'),
  (:'SES_B', :'BIZ_B', :'OWN_B', 'full', 'monthly', 45000, 'ARS', 'trpcs_00000000-0000-4000-8000-0000000be7b5', 'pending', 'plan_full_m', 'b@invalid.test');

-- ============================================================================
-- A · El navegador no es autoridad
-- ============================================================================
SELECT pg_temp.assert(
  pg_temp.como('authenticated', :'OWN_A',
    $$INSERT INTO public.subscription_checkout_sessions(business_id, plan_id, billing_cycle, amount, external_reference, status)
      VALUES ('00000000-0000-4000-8000-0000000be7a1', 'full', 'monthly', 1, 'cliente-1', 'pending')$$) = '42501',
  'A1 · authenticated NO inserta una sesion de checkout de su propio negocio');

SELECT pg_temp.assert(
  pg_temp.como('authenticated', :'OWN_A',
    $$INSERT INTO public.subscription_checkout_sessions(business_id, plan_id, billing_cycle, amount, external_reference, status)
      VALUES ('00000000-0000-4000-8000-0000000be7b1', 'full', 'monthly', 1, 'cliente-2', 'paid')$$) = '42501',
  'A2 · authenticated NO inserta una sesion (ni paid) para OTRO negocio');

SELECT pg_temp.assert(
  pg_temp.como('authenticated', :'OWN_A',
    $$UPDATE public.subscription_checkout_sessions SET status = 'paid' WHERE id = '00000000-0000-4000-8000-0000000be7a5'$$) = '42501',
  'A3 · authenticated NO se marca paid su propia sesion');

SELECT pg_temp.assert(
  pg_temp.como('authenticated', :'OWN_A',
    $$UPDATE public.subscription_checkout_sessions SET status = 'canceled' WHERE id = '00000000-0000-4000-8000-0000000be7b5'$$) = '42501',
  'A4 · authenticated NO modifica la sesion de otro negocio');

SELECT pg_temp.assert(
  pg_temp.como('authenticated', :'OWN_A',
    $$SELECT 1 FROM public.subscription_checkout_sessions LIMIT 1$$) = '42501',
  'A5 · authenticated NO lee la tabla (el estado se consulta por la Edge Function)');

SELECT pg_temp.assert(
  pg_temp.como('authenticated', :'OWN_A',
    $$DELETE FROM public.subscription_checkout_sessions WHERE id = '00000000-0000-4000-8000-0000000be7a5'$$) = '42501',
  'A6 · authenticated NO borra una sesion');

SELECT pg_temp.assert(
  pg_temp.como('anon', NULL,
    $$SELECT 1 FROM public.subscription_checkout_sessions LIMIT 1$$) = '42501'
  AND pg_temp.como('anon', NULL,
    $$INSERT INTO public.subscription_checkout_sessions(business_id, plan_id, billing_cycle, amount, external_reference)
      VALUES ('00000000-0000-4000-8000-0000000be7a1', 'pro', 'monthly', 1, 'anon-1')$$) = '42501',
  'A7 · anon no lee ni inserta');

SELECT pg_temp.assert(
  (SELECT status FROM public.subscription_checkout_sessions WHERE id = :'SES_A') = 'pending'
  AND (SELECT status FROM public.subscription_checkout_sessions WHERE id = :'SES_B') = 'pending'
  AND (SELECT count(*) FROM public.subscription_checkout_sessions WHERE business_id IN (:'BIZ_A', :'BIZ_B')) = 2,
  'A8 · despues de los intentos, las dos sesiones siguen intactas y no hay filas nuevas');

SELECT pg_temp.assert(
  NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.subscription_checkout_sessions'::regclass
                 AND polname IN ('scs_insert', 'scs_select')),
  'A9 · no quedan policies de cliente (scs_insert / scs_select)');

-- ============================================================================
-- C · Abrir un checkout no cambia el negocio (se mide ANTES de B)
-- ============================================================================
CREATE TEMP TABLE _beta_mp_biz ON COMMIT DROP AS
  SELECT id, md5(b::text) AS huella FROM public.businesses b WHERE id IN (:'BIZ_A', :'BIZ_B');

-- ============================================================================
-- B · El backend es la autoridad
-- ============================================================================
SELECT pg_temp.assert(
  pg_temp.como('service_role', NULL,
    $$INSERT INTO public.subscription_checkout_sessions
        (business_id, user_id, plan_id, billing_cycle, amount, currency, external_reference, status, mp_preapproval_plan_id, payer_email)
      VALUES ('00000000-0000-4000-8000-0000000be7a1', '00000000-0000-4000-8000-0000000be7a9', 'full', 'annual', 432000, 'ARS',
              'trpcs_00000000-0000-4000-8000-0000000be7c5', 'pending', 'plan_full_a', 'a@invalid.test')$$) = 'OK',
  'B1 · service_role crea una sesion con plan esperado, pagador y referencia');

SELECT pg_temp.assert(
  pg_temp.como('service_role', NULL,
    $$UPDATE public.subscription_checkout_sessions
         SET status = 'paid', mp_preapproval_id = 'pre_test_1', confirmed_at = now(), updated_at = now()
       WHERE external_reference = 'trpcs_00000000-0000-4000-8000-0000000be7c5'$$) = 'OK',
  'B2 · service_role puede resolver la sesion');

-- En otra sentencia: la escritura hecha dentro de la funcion no es visible para
-- el snapshot de la sentencia que la llamo.
SELECT pg_temp.assert(
  (SELECT status = 'paid' AND mp_preapproval_id = 'pre_test_1' AND confirmed_at IS NOT NULL
     FROM public.subscription_checkout_sessions WHERE external_reference = 'trpcs_00000000-0000-4000-8000-0000000be7c5'),
  'B2 · la sesion queda paid, con el preapproval confirmado y confirmed_at');

SELECT pg_temp.assert(
  pg_temp.como('service_role', NULL,
    $$DELETE FROM public.subscription_checkout_sessions WHERE id = '00000000-0000-4000-8000-0000000be7a5'$$) = '42501',
  'B3 · service_role NO borra sesiones (el registro de la intencion se conserva)');

SELECT pg_temp.assert(
  (SELECT bool_and(md5(b::text) = s.huella) FROM public.businesses b JOIN _beta_mp_biz s ON s.id = b.id),
  'C1 · crear y resolver sesiones de checkout no modifica la fila de ningun negocio (trial y plan intactos)');

-- ============================================================================
-- D · Unicidad de la intencion
-- ============================================================================
SELECT pg_temp.assert(
  pg_temp.como('service_role', NULL,
    $$INSERT INTO public.subscription_checkout_sessions(business_id, plan_id, billing_cycle, amount, external_reference, status)
      VALUES ('00000000-0000-4000-8000-0000000be7b1', 'basico', 'monthly', 15000, 'trpcs_00000000-0000-4000-8000-0000000be7a5', 'pending')$$) = '23505',
  'D1 · una referencia de checkout no se puede reutilizar para otro negocio');

SELECT pg_temp.assert(
  pg_temp.como('service_role', NULL,
    $$INSERT INTO public.subscription_checkout_sessions(business_id, plan_id, billing_cycle, amount, external_reference, status)
      VALUES ('00000000-0000-4000-8000-0000000be7a1', 'pro', 'monthly', 25000, 'trpcs_00000000-0000-4000-8000-0000000be7d5', 'pending')$$) = '23505',
  'D2 · una sola sesion pending por (negocio, plan, ciclo)');

-- ============================================================================
-- E · subscription_events deduplica por notificacion, no por recurso
-- ============================================================================
SELECT pg_temp.assert(
  pg_temp.como('service_role', NULL,
    $$INSERT INTO public.subscription_events(provider, event_type, external_id, notification_id, raw_payload)
      VALUES ('mercadopago', 'subscription_preapproval', 'pre_res_1', '1001', '{}')$$) = 'OK'
  AND pg_temp.como('service_role', NULL,
    $$INSERT INTO public.subscription_events(provider, event_type, external_id, notification_id, raw_payload)
      VALUES ('mercadopago', 'subscription_preapproval', 'pre_res_1', '1002', '{}')$$) = 'OK',
  'E1 · dos notificaciones DISTINTAS del mismo preapproval (pending y authorized) entran las dos');

SELECT pg_temp.assert(
  pg_temp.como('service_role', NULL,
    $$INSERT INTO public.subscription_events(provider, event_type, external_id, notification_id, raw_payload)
      VALUES ('mercadopago', 'subscription_preapproval', 'pre_res_1', '1002', '{}')$$) = '23505',
  'E2 · la MISMA notificacion reenviada choca contra el indice unico (claim idempotente)');

SELECT pg_temp.assert(
  pg_temp.como('service_role', NULL,
    $$INSERT INTO public.subscription_events(provider, event_type, external_id, raw_payload)
      VALUES ('mercadopago', 'billing_state_applied', 'pre_res_1', '{}'), ('mercadopago', 'billing_state_applied', 'pre_res_1', '{}')$$) = 'OK',
  'E3 · los eventos de auditoria (sin notification_id) no chocan entre si');

SELECT pg_temp.assert(
  to_regclass('public.uq_subscription_events_dedupe') IS NULL
  AND to_regclass('public.uq_subscription_events_notification') IS NOT NULL,
  'E4 · el dedupe por recurso ya no existe; el de notificacion si');

-- ============================================================================
-- F · payments admite el upsert del webhook
-- ============================================================================
-- Es la sentencia que arma PostgREST para `.upsert(..., { onConflict:
-- 'provider,external_payment_id' })`: ON CONFLICT sin predicado. Con el unico
-- indice parcial de antes daba 42P10 en el primer cobro.
SELECT pg_temp.assert(
  pg_temp.como('service_role', NULL,
    $$INSERT INTO public.payments(business_id, provider, external_payment_id, type, amount, currency, status, raw_payload)
      VALUES ('00000000-0000-4000-8000-0000000be7a1', 'mercadopago', 'inv_test_1', 'recurring', 25000, 'ARS', 'pending', '{}')
      ON CONFLICT (provider, external_payment_id) DO UPDATE SET status = EXCLUDED.status$$) = 'OK',
  'F1 · service_role registra un cobro con ON CONFLICT (provider, external_payment_id)');

SELECT pg_temp.assert(
  pg_temp.como('service_role', NULL,
    $$INSERT INTO public.payments(business_id, provider, external_payment_id, type, amount, currency, status, raw_payload)
      VALUES ('00000000-0000-4000-8000-0000000be7a1', 'mercadopago', 'inv_test_1', 'recurring', 25000, 'ARS', 'approved', '{}')
      ON CONFLICT (provider, external_payment_id) DO UPDATE SET status = EXCLUDED.status$$) = 'OK',
  'F2 · la segunda notificacion del mismo cobro actualiza la fila');

SELECT pg_temp.assert(
  (SELECT count(*) = 1 AND bool_and(status = 'approved') FROM public.payments WHERE external_payment_id = 'inv_test_1'),
  'F3 · el ledger tiene UNA fila para ese cobro, aprobada (sin doble contabilizacion)');

SELECT pg_temp.assert(
  pg_temp.como('authenticated', :'OWN_A',
    $$INSERT INTO public.payments(business_id, provider, external_payment_id, type, amount, status)
      VALUES ('00000000-0000-4000-8000-0000000be7a1', 'mercadopago', 'inv_fabricado', 'recurring', 1, 'approved')$$) = '42501',
  'F4 · authenticated NO fabrica un pago en el ledger');

-- ============================================================================
-- G · Plan B: un preapproval pertenece a UNA sesion (migracion 20261013120000)
-- ============================================================================
-- El backend crea el preapproval en Mercado Pago y guarda su id en la sesion
-- antes de devolver el checkout. Ese id es la identidad del pago: no puede
-- quedar en dos sesiones (ni, por uq_businesses_mp_preapproval_id, en dos negocios).
SELECT pg_temp.assert(
  pg_temp.como('service_role', NULL,
    $$UPDATE public.subscription_checkout_sessions SET mp_preapproval_id = 'pre_plan_b_1', updated_at = now()
       WHERE id = '00000000-0000-4000-8000-0000000be7a5'$$) = 'OK',
  'G1 · service_role vincula a la sesion el preapproval que creo en Mercado Pago');

SELECT pg_temp.assert(
  pg_temp.como('service_role', NULL,
    $$UPDATE public.subscription_checkout_sessions SET mp_preapproval_id = 'pre_plan_b_1', updated_at = now()
       WHERE id = '00000000-0000-4000-8000-0000000be7b5'$$) = '23505',
  'G2 · el MISMO preapproval no se puede vincular a la sesion de otro negocio');

SELECT pg_temp.assert(
  pg_temp.como('service_role', NULL,
    $$INSERT INTO public.subscription_checkout_sessions(business_id, plan_id, billing_cycle, amount, external_reference, status, mp_preapproval_id)
      VALUES ('00000000-0000-4000-8000-0000000be7b1', 'basico', 'annual', 144000, 'trpcs_00000000-0000-4000-8000-0000000be7e5', 'pending', 'pre_plan_b_1')$$) = '23505',
  'G3 · ni entrar en una sesion nueva');

SELECT pg_temp.assert(
  (SELECT mp_preapproval_id IS NULL FROM public.subscription_checkout_sessions WHERE id = :'SES_B')
  AND (SELECT count(*) FROM public.subscription_checkout_sessions WHERE mp_preapproval_id = 'pre_plan_b_1') = 1,
  'G4 · tras los intentos el preapproval sigue en una sola sesion, la de su negocio');

SELECT pg_temp.assert(
  pg_temp.como('service_role', NULL,
    $$INSERT INTO public.subscription_checkout_sessions(business_id, plan_id, billing_cycle, amount, external_reference, status)
      VALUES ('00000000-0000-4000-8000-0000000be7b1', 'basico', 'annual', 144000, 'trpcs_00000000-0000-4000-8000-0000000be7f5', 'pending')$$) = 'OK',
  'G5 · las sesiones todavia sin preapproval (NULL) conviven: el indice es parcial');

SELECT pg_temp.assert(
  pg_temp.como('authenticated', :'OWN_A',
    $$UPDATE public.subscription_checkout_sessions SET mp_preapproval_id = 'pre_del_navegador' WHERE id = '00000000-0000-4000-8000-0000000be7a5'$$) = '42501',
  'G6 · authenticated NO vincula un preapproval a una sesion');

SELECT pg_temp.assert(
  to_regclass('public.idx_scs_mp_preapproval') IS NULL
  AND EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass('public.uq_scs_mp_preapproval')
                 AND i.indrelid = 'public.subscription_checkout_sessions'::regclass
                 AND i.indisunique AND i.indisvalid AND i.indpred IS NOT NULL),
  'G7 · uq_scs_mp_preapproval es unico, valido y parcial; el indice no unico ya no existe');

SELECT pg_temp.assert(
  EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = 'public.businesses'::regclass AND i.indisunique AND i.indisvalid
             AND pg_get_indexdef(i.indexrelid) LIKE '%(mp_preapproval_id)%'),
  'G8 · businesses conserva su indice unico sobre mp_preapproval_id: un preapproval, un negocio');

SELECT pg_temp.assert(
  EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261013120000'),
  'G9 · la migracion del Plan B esta registrada');

DO $$ BEGIN RAISE NOTICE 'ALL BETA-MP CHECKOUT AUTHORITY TESTS PASSED'; END $$;

ROLLBACK;
