-- ============================================================================
-- Minimal-privilege grant tests for 20260623130000_grant_billing_service_role_privileges
--
-- Self-contained: replicates the production lockdown (service_role has nothing on
-- businesses), applies the EXACT grant statements from the migration, then proves
-- the column-level semantics. Column privileges are checked before row matching,
-- so a non-existent id is enough (no fixtures). Everything rolls back.
--
--   psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/sql/billing_grants.test.sql
-- ============================================================================
\set ON_ERROR_STOP on
\pset pager off
BEGIN;

-- Replicate the PRODUCTION grant state (the local baseline dump does not reproduce
-- the businesses grant lockdown): on businesses, authenticated/anon have SELECT only
-- and service_role has nothing; checkout_sessions has nothing for these roles.
REVOKE ALL ON public.businesses                     FROM service_role, authenticated, anon;
GRANT  SELECT ON public.businesses                  TO   authenticated, anon;
REVOKE ALL ON public.subscription_checkout_sessions FROM service_role, authenticated, anon;

-- Apply the EXACT grants from the migration.
GRANT SELECT ON public.businesses TO service_role;
GRANT UPDATE (
  subscription_status, subscription_plan, subscription_provider,
  mp_preapproval_id, mp_preapproval_plan_id, mp_payer_email, mp_last_modified,
  current_period_start, current_period_end, grace_until,
  last_payment_id, last_payment_status, last_webhook_at, access_source, updated_at
) ON public.businesses TO service_role;
GRANT SELECT ON public.subscription_checkout_sessions TO service_role;
GRANT UPDATE (status, updated_at) ON public.subscription_checkout_sessions TO service_role;

DO $$
DECLARE v_ok boolean; v_denied boolean;
        v_id uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
  -- T1: service_role CAN update an allowed billing column
  SET LOCAL ROLE service_role;
  BEGIN UPDATE public.businesses SET subscription_status='active' WHERE id=v_id; v_ok:=true;
  EXCEPTION WHEN insufficient_privilege THEN v_ok:=false; END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'GRANT-FAIL T1: service_role cannot update subscription_status'; END IF;
  RAISE NOTICE 'T1 ok: service_role can update an allowed billing column';

  -- T2: service_role CANNOT update a commercial column (name)
  v_denied:=false;
  SET LOCAL ROLE service_role;
  BEGIN UPDATE public.businesses SET name='hack' WHERE id=v_id;
  EXCEPTION WHEN insufficient_privilege THEN v_denied:=true; END;
  RESET ROLE;
  IF NOT v_denied THEN RAISE EXCEPTION 'GRANT-FAIL T2: service_role updated businesses.name (should be denied)'; END IF;
  RAISE NOTICE 'T2 ok: service_role cannot update a commercial column (name)';

  -- T3: service_role CANNOT update trial_ends_at (not in the webhook grant set)
  v_denied:=false;
  SET LOCAL ROLE service_role;
  BEGIN UPDATE public.businesses SET trial_ends_at=now() WHERE id=v_id;
  EXCEPTION WHEN insufficient_privilege THEN v_denied:=true; END;
  RESET ROLE;
  IF NOT v_denied THEN RAISE EXCEPTION 'GRANT-FAIL T3: service_role updated trial_ends_at (should be denied)'; END IF;
  RAISE NOTICE 'T3 ok: service_role cannot update trial_ends_at (admin/cron only)';

  -- T4: service_role CANNOT INSERT or DELETE businesses
  v_denied:=false;
  SET LOCAL ROLE service_role;
  BEGIN DELETE FROM public.businesses WHERE id=v_id;
  EXCEPTION WHEN insufficient_privilege THEN v_denied:=true; END;
  RESET ROLE;
  IF NOT v_denied THEN RAISE EXCEPTION 'GRANT-FAIL T4: service_role can DELETE businesses (should be denied)'; END IF;
  RAISE NOTICE 'T4 ok: service_role cannot DELETE businesses';

  -- T5: authenticated still has NO effective UPDATE on businesses
  IF has_table_privilege('authenticated','public.businesses','UPDATE') THEN
    RAISE EXCEPTION 'GRANT-FAIL T5: authenticated has UPDATE on businesses (should not)'; END IF;
  RAISE NOTICE 'T5 ok: authenticated still has no UPDATE on businesses';

  -- T6: service_role can update checkout_sessions.status (markCheckoutSession)
  SET LOCAL ROLE service_role;
  BEGIN UPDATE public.subscription_checkout_sessions SET status='paid' WHERE id=v_id; v_ok:=true;
  EXCEPTION WHEN insufficient_privilege THEN v_ok:=false; END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'GRANT-FAIL T6: service_role cannot update checkout_sessions.status'; END IF;
  RAISE NOTICE 'T6 ok: service_role can update checkout_sessions.status';

  -- T7: anon has NO write on businesses (UPDATE or INSERT)
  IF has_table_privilege('anon','public.businesses','UPDATE')
     OR has_table_privilege('anon','public.businesses','INSERT') THEN
    RAISE EXCEPTION 'GRANT-FAIL T7: anon can write businesses (should not)'; END IF;
  RAISE NOTICE 'T7 ok: anon still cannot write businesses';

  RAISE NOTICE 'ALL GRANT TESTS PASSED';
END$$;
ROLLBACK;
