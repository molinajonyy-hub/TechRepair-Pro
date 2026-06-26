-- ============================================================
-- Test suite: whatsapp_admin_provision (Camino C)
-- Covers the 18 mandated checks. FICTITIOUS values only.
--
-- HOW TO RUN (needs supabase_vault + superuser; NOT against prod):
--   · local stack:   supabase db reset && psql "$LOCAL_DB_URL" -f this_file
--   · isolated branch: apply the migration on a dev branch, then run this file.
--
-- The whole suite runs inside a single transaction and ROLLBACKs at the end,
-- so it persists nothing. Fixtures are inserted with FK checks disabled
-- (session_replication_role='replica'); RPC behaviour is then exercised with
-- triggers/indexes ACTIVE ('origin').
-- ============================================================
BEGIN;
SET LOCAL client_min_messages = notice;

-- ── assertion helpers (transaction-local) ───────────────────
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label;
  ELSE RAISE NOTICE 'PASS: %', label; END IF;
END; $$;

CREATE OR REPLACE FUNCTION pg_temp.assert_raises(sql text, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE sql;
  EXCEPTION
    WHEN others THEN
      IF sqlerrm LIKE 'FAIL:%' THEN RAISE; END IF;
      RAISE NOTICE 'PASS (raised as expected): % [%]', label, sqlerrm;
      RETURN;
  END;
  RAISE EXCEPTION 'FAIL (expected an error but none raised): %', label;
END; $$;

-- ── fictitious identifiers ──────────────────────────────────
\set bizA '00000000-0000-0000-0000-0000000000a1'
\set bizB '00000000-0000-0000-0000-0000000000b2'
\set userA '00000000-0000-0000-0000-0000000000a9'
\set userB '00000000-0000-0000-0000-0000000000b9'
\set connA '00000000-0000-0000-0000-00000000ac01'
\set connB '00000000-0000-0000-0000-00000000bc01'

-- ════════════════════════════════════════════════════════════
-- T1-T3 + T4a: privilege grants (catalog-level; no fixtures)
-- ════════════════════════════════════════════════════════════
SELECT pg_temp.assert(NOT has_function_privilege('anon',
  'public.whatsapp_admin_provision_connection(uuid,text,text,text,text,text,timestamptz,text)','EXECUTE'),
  'T1 anon cannot EXECUTE provision');
SELECT pg_temp.assert(NOT has_function_privilege('authenticated',
  'public.whatsapp_admin_provision_connection(uuid,text,text,text,text,text,timestamptz,text)','EXECUTE'),
  'T2 authenticated cannot EXECUTE provision');
-- T3: an owner using the frontend acts under the `authenticated` role → same denial.
SELECT pg_temp.assert(NOT has_function_privilege('authenticated',
  'public.whatsapp_admin_revoke_connection(uuid,text)','EXECUTE'),
  'T3 authenticated (owner via frontend) cannot EXECUTE revoke');
SELECT pg_temp.assert(has_function_privilege('service_role',
  'public.whatsapp_admin_provision_connection(uuid,text,text,text,text,text,timestamptz,text)','EXECUTE'),
  'T4a service_role HAS EXECUTE on provision');

-- ── fixtures (FK/triggers off) ──────────────────────────────
SET LOCAL session_replication_role = 'replica';
INSERT INTO public.businesses(id, name) VALUES (:'bizA','Test Biz A'), (:'bizB','Test Biz B');
INSERT INTO public.profiles(business_id, user_id, role, is_active)
  VALUES (:'bizA', :'userA', 'owner', true);
-- bizA starts with a partial/disconnected row (mirrors prod) → provision must REUSE it.
INSERT INTO public.whatsapp_connections(id, business_id, user_id, phone_number_id, status, metadata)
  VALUES (:'connA', :'bizA', :'userA', 'PARTIAL_PN', 'disconnected', '{}'::jsonb);
-- bizB has its own ACTIVE connection → isolation check.
INSERT INTO public.whatsapp_connections(id, business_id, user_id, phone_number_id, waba_id, status, metadata)
  VALUES (:'connB', :'bizB', :'userB', 'PN_B', 'WABA_B', 'connected', '{}'::jsonb);
SET LOCAL session_replication_role = 'origin';

-- ════════════════════════════════════════════════════════════
-- T4: service_role can provision (reuses the partial row)
-- ════════════════════════════════════════════════════════════
SET LOCAL ROLE service_role;
SELECT public.whatsapp_admin_provision_connection(
  :'bizA','PN_A','WABA_A','TESTTOKEN-A','t4 provision', NULL, NULL, '+540000000000');
RESET ROLE;
SELECT pg_temp.assert(
  (SELECT status FROM public.whatsapp_connections WHERE business_id=:'bizA')='connected',
  'T4 provisioned → status connected');

-- T14: reusing the partial row creates NO duplicate
SELECT pg_temp.assert(
  (SELECT count(*) FROM public.whatsapp_connections WHERE business_id=:'bizA')=1,
  'T14 single connection row for business (reused, not duplicated)');

-- T8: token stored in Vault, NOT in public tables
SELECT pg_temp.assert(
  EXISTS(SELECT 1 FROM public.whatsapp_connection_credentials cc
         JOIN public.whatsapp_connections c ON c.id=cc.connection_id
         WHERE c.business_id=:'bizA'),
  'T8a credential row exists for business');
SELECT pg_temp.assert(
  public.whatsapp_credential_get_token((SELECT id FROM public.whatsapp_connections WHERE business_id=:'bizA'))='TESTTOKEN-A',
  'T8b/T18 token retrievable via Vault RPC (whatsapp-send path)');
SELECT pg_temp.assert(
  (SELECT coalesce(metadata::text,'') FROM public.whatsapp_connections WHERE business_id=:'bizA') NOT LIKE '%TESTTOKEN%',
  'T8c token not present in whatsapp_connections');

-- T9: provision response carries NO token (rotate same row, inspect jsonb)
DO $$
DECLARE r jsonb;
BEGIN
  -- NOTE: psql :'var' is NOT interpolated inside dollar-quoted blocks → literal uuid.
  SET LOCAL ROLE service_role;
  r := public.whatsapp_admin_provision_connection('00000000-0000-0000-0000-0000000000a1','PN_A','WABA_A','TESTTOKEN-A2','t9 rotate',NULL,NULL,NULL);
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status'='connected' AND r::text NOT LIKE '%TESTTOKEN%', 'T9 response JSON has no token');
END $$;

-- T10: audit rows never contain the token
SELECT pg_temp.assert(
  (SELECT coalesce(string_agg(reason||' '||coalesce(metadata::text,''),' '),'')
     FROM public.whatsapp_connection_events WHERE business_id=:'bizA') NOT LIKE '%TESTTOKEN%',
  'T10 audit events contain no token');

-- T5: nonexistent business rejected
SELECT pg_temp.assert_raises(
  $q$ SET LOCAL ROLE service_role;
      SELECT public.whatsapp_admin_provision_connection('99999999-9999-9999-9999-999999999999','P','W','T','t5'); $q$,
  'T5 nonexistent business rejected');
RESET ROLE;

-- T6: missing required field (empty phone_number_id) rejected
SELECT pg_temp.assert_raises(
  $q$ SET LOCAL ROLE service_role;
      SELECT public.whatsapp_admin_provision_connection('00000000-0000-0000-0000-0000000000a1','','W','T','t6'); $q$,
  'T6 empty phone_number_id rejected');
RESET ROLE;

-- T7: empty reason rejected
SELECT pg_temp.assert_raises(
  $q$ SET LOCAL ROLE service_role;
      SELECT public.whatsapp_admin_provision_connection('00000000-0000-0000-0000-0000000000a1','P','W','T','   '); $q$,
  'T7 empty reason rejected');
RESET ROLE;

-- T13: a SECOND connected row for the same business is blocked by the partial unique index
SELECT pg_temp.assert_raises(
  $q$ INSERT INTO public.whatsapp_connections(business_id,user_id,phone_number_id,status,metadata)
      VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a9','PN_DUP','connected','{}'::jsonb); $q$,
  'T13 second connected connection blocked (unique partial index)');

-- T17: other tenant (bizB) is untouched by all of the above
SELECT pg_temp.assert(
  (SELECT status FROM public.whatsapp_connections WHERE business_id=:'bizB')='connected'
  AND (SELECT count(*) FROM public.whatsapp_connection_events WHERE business_id=:'bizB')=0,
  'T17 other business unchanged (no status change, no events)');

-- T12: if the AUDIT insert fails, the WHOLE provision rolls back (vault still works here)
CREATE OR REPLACE FUNCTION public._test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN RAISE EXCEPTION 'audit down (simulated)'; END; $f$;
CREATE TRIGGER _test_fail_audit BEFORE INSERT ON public.whatsapp_connection_events
  FOR EACH ROW EXECUTE FUNCTION public._test_fail_audit();
SELECT pg_temp.assert_raises(
  $q$ SET LOCAL ROLE service_role;
      SELECT public.whatsapp_admin_provision_connection('00000000-0000-0000-0000-0000000000a1','PN_A','WABA_A','TESTTOKEN-A3','t12'); $q$,
  'T12a provision raises when audit insert fails');
RESET ROLE;
DROP TRIGGER _test_fail_audit ON public.whatsapp_connection_events;
-- connection must remain as before the failed provision (still connected from T9), token unchanged
SELECT pg_temp.assert(
  public.whatsapp_credential_get_token((SELECT id FROM public.whatsapp_connections WHERE business_id=:'bizA'))='TESTTOKEN-A2',
  'T12b failed provision rolled back (credential unchanged)');

-- T15: revoke removes credential + sets disconnected (Vault purge trigger fires)
DO $$ BEGIN SET LOCAL ROLE service_role; PERFORM public.whatsapp_admin_revoke_connection('00000000-0000-0000-0000-0000000000a1','t15 revoke'); RESET ROLE; END $$;
SELECT pg_temp.assert(
  (SELECT status FROM public.whatsapp_connections WHERE business_id=:'bizA')='disconnected',
  'T15a status disconnected after revoke');
SELECT pg_temp.assert(
  NOT EXISTS(SELECT 1 FROM public.whatsapp_connection_credentials cc
             JOIN public.whatsapp_connections c ON c.id=cc.connection_id WHERE c.business_id=:'bizA'),
  'T15b credential row removed after revoke');

-- T16: repeated revoke is safe / idempotent
DO $$ BEGIN SET LOCAL ROLE service_role; PERFORM public.whatsapp_admin_revoke_connection('00000000-0000-0000-0000-0000000000a1','t16 revoke again'); RESET ROLE; END $$;
SELECT pg_temp.assert(
  (SELECT status FROM public.whatsapp_connections WHERE business_id=:'bizA')='disconnected',
  'T16 repeated revoke safe (still disconnected, no error)');

-- T11: if the Vault STORE step fails, the connection never becomes connected.
-- Fault-inject at public.whatsapp_credential_store (the function provision uses to
-- write the token to Vault). It is owned locally, so this needs no vault-schema DDL
-- / superuser. Restored automatically by the ROLLBACK below.
CREATE OR REPLACE FUNCTION public.whatsapp_credential_store(p_connection_id uuid, p_token text, p_expires_at timestamptz DEFAULT NULL)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, vault AS $f$
BEGIN RAISE EXCEPTION 'vault store down (simulated)'; END; $f$;
SELECT pg_temp.assert_raises(
  $q$ SET LOCAL ROLE service_role;
      SELECT public.whatsapp_admin_provision_connection('00000000-0000-0000-0000-0000000000a1','PN_A','WABA_A','TESTTOKEN-A4','t11'); $q$,
  'T11a provision raises when the Vault store step fails');
RESET ROLE;
SELECT pg_temp.assert(
  (SELECT status FROM public.whatsapp_connections WHERE business_id=:'bizA')='disconnected',
  'T11b connection NOT connected after Vault store failure');

SELECT 'ALL TESTS PASSED (rolled back)' AS result;
ROLLBACK;
