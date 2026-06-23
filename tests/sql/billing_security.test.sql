-- ============================================================================
-- Billing security tests — RLS / RPC / trigger
--
-- Run against a Supabase BRANCH or a local stack (NEVER production):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/sql/billing_security.test.sql
--
-- Requires migrations 20260623_100..161 applied. Each block RAISES on failure;
-- a clean run ending in "ALL BILLING SECURITY TESTS PASSED" means success.
--
-- Helper to impersonate a client: set the role + JWT claims like PostgREST does.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- Fixtures ────────────────────────────────────────────────────────────────────
-- A throwaway business + two auth users (a normal owner and a billing admin).
DO $$
DECLARE v_owner uuid := gen_random_uuid();
        v_admin uuid := gen_random_uuid();
        v_biz   uuid := gen_random_uuid();
BEGIN
  -- Minimal auth.users rows for FK targets.
  INSERT INTO auth.users (id, email) VALUES
    (v_owner, 'owner_test@example.com'),
    (v_admin, 'billing_admin_test@example.com')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.businesses (id, name, owner_user_id, subscription_status, subscription_plan)
  VALUES (v_biz, 'TEST BILLING BIZ', v_owner, 'trialing', NULL);

  -- The owner has an active owner profile on the business.
  INSERT INTO public.profiles (id, user_id, business_id, role, is_active)
  VALUES (gen_random_uuid(), v_owner, v_biz, 'owner', true);

  -- Grant the admin user a billing_admin platform role (system_admins).
  INSERT INTO public.system_admins (user_id, email, role, is_active, created_by)
  VALUES (v_admin, 'billing_admin_test@example.com', 'billing_admin', true, v_admin);

  -- Stash ids for later blocks.
  PERFORM set_config('test.owner', v_owner::text, false);
  PERFORM set_config('test.admin', v_admin::text, false);
  PERFORM set_config('test.biz',   v_biz::text,   false);
END$$;

-- TEST 1: a normal owner CANNOT self-activate via direct UPDATE ───────────────
DO $$
DECLARE v_biz uuid := current_setting('test.biz')::uuid;
        v_owner text := current_setting('test.owner');
        v_blocked boolean := false;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role','authenticated')::text, true);
  BEGIN
    UPDATE public.businesses SET subscription_status='active', subscription_plan='full' WHERE id = v_biz;
  EXCEPTION WHEN insufficient_privilege THEN v_blocked := true;
  END;
  RESET ROLE;
  IF NOT v_blocked THEN RAISE EXCEPTION 'TEST 1 FAILED: owner self-activation was NOT blocked'; END IF;
  RAISE NOTICE 'TEST 1 ok: direct self-activation blocked';
END$$;

-- TEST 2: a normal owner is NOT a platform admin ─────────────────────────────
DO $$
DECLARE v_owner uuid := current_setting('test.owner')::uuid;
BEGIN
  IF public.is_platform_admin(v_owner) THEN RAISE EXCEPTION 'TEST 2 FAILED: owner is platform admin'; END IF;
  RAISE NOTICE 'TEST 2 ok: business owner is not a platform admin';
END$$;

-- TEST 3: a normal user CANNOT insert themselves into system_admins ───────────
DO $$
DECLARE v_owner text := current_setting('test.owner');
        v_blocked boolean := false;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role','authenticated')::text, true);
  BEGIN
    INSERT INTO public.system_admins (user_id, email, role) VALUES (v_owner::uuid, 'self@example.com', 'super_admin');
  EXCEPTION WHEN insufficient_privilege THEN v_blocked := true;
  END;
  RESET ROLE;
  IF NOT v_blocked THEN RAISE EXCEPTION 'TEST 3 FAILED: user added self to system_admins'; END IF;
  RAISE NOTICE 'TEST 3 ok: self-promotion to system_admins blocked';
END$$;

-- TEST 4: billing_admin CAN activate via RPC, and it is audited ───────────────
DO $$
DECLARE v_admin text := current_setting('test.admin');
        v_biz uuid := current_setting('test.biz')::uuid;
        v_status text; v_source text; v_audit int;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);
  PERFORM public.admin_activate_subscription(v_biz, 'pro', 'unit test activation');
  RESET ROLE;

  SELECT subscription_status, access_source INTO v_status, v_source FROM public.businesses WHERE id = v_biz;
  IF v_status <> 'active'        THEN RAISE EXCEPTION 'TEST 4 FAILED: status=% (expected active)', v_status; END IF;
  IF v_source <> 'admin_override' THEN RAISE EXCEPTION 'TEST 4 FAILED: access_source=% (expected admin_override)', v_source; END IF;

  SELECT count(*) INTO v_audit FROM public.subscription_admin_actions WHERE business_id = v_biz AND action='activate';
  IF v_audit < 1 THEN RAISE EXCEPTION 'TEST 4 FAILED: no audit row recorded'; END IF;
  RAISE NOTICE 'TEST 4 ok: billing_admin activated via RPC + audited, no MP payment fabricated';
END$$;

-- TEST 5: manual activation did NOT fabricate a Mercado Pago payment/preapproval
DO $$
DECLARE v_biz uuid := current_setting('test.biz')::uuid; v_pre text; v_pays int;
BEGIN
  SELECT mp_preapproval_id INTO v_pre FROM public.businesses WHERE id = v_biz;
  IF v_pre IS NOT NULL THEN RAISE EXCEPTION 'TEST 5 FAILED: mp_preapproval_id was fabricated'; END IF;
  SELECT count(*) INTO v_pays FROM public.payments WHERE business_id = v_biz;
  IF v_pays <> 0 THEN RAISE EXCEPTION 'TEST 5 FAILED: a payment row was created for a manual activation'; END IF;
  RAISE NOTICE 'TEST 5 ok: manual activation has no MP payment/preapproval';
END$$;

-- TEST 6: RPC rejects an invalid plan ────────────────────────────────────────
DO $$
DECLARE v_admin text := current_setting('test.admin');
        v_biz uuid := current_setting('test.biz')::uuid; v_failed boolean := false;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);
  BEGIN PERFORM public.admin_change_subscription_plan(v_biz, 'enterprise', 'bad plan'); EXCEPTION WHEN OTHERS THEN v_failed := true; END;
  RESET ROLE;
  IF NOT v_failed THEN RAISE EXCEPTION 'TEST 6 FAILED: invalid plan accepted'; END IF;
  RAISE NOTICE 'TEST 6 ok: invalid plan rejected';
END$$;

-- TEST 7: RPC requires a reason ───────────────────────────────────────────────
DO $$
DECLARE v_admin text := current_setting('test.admin');
        v_biz uuid := current_setting('test.biz')::uuid; v_failed boolean := false;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);
  BEGIN PERFORM public.admin_suspend_subscription(v_biz, ''); EXCEPTION WHEN OTHERS THEN v_failed := true; END;
  RESET ROLE;
  IF NOT v_failed THEN RAISE EXCEPTION 'TEST 7 FAILED: empty reason accepted'; END IF;
  RAISE NOTICE 'TEST 7 ok: empty reason rejected';
END$$;

-- TEST 8: a non-admin user cannot call an admin RPC ───────────────────────────
DO $$
DECLARE v_owner text := current_setting('test.owner');
        v_biz uuid := current_setting('test.biz')::uuid; v_blocked boolean := false;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role','authenticated')::text, true);
  BEGIN PERFORM public.admin_activate_subscription(v_biz, 'full', 'should not work'); EXCEPTION WHEN insufficient_privilege THEN v_blocked := true; END;
  RESET ROLE;
  IF NOT v_blocked THEN RAISE EXCEPTION 'TEST 8 FAILED: non-admin called admin RPC'; END IF;
  RAISE NOTICE 'TEST 8 ok: non-admin blocked from admin RPC';
END$$;

-- TEST 9: an inactive admin is blocked ───────────────────────────────────────
DO $$
DECLARE v_admin text := current_setting('test.admin');
        v_biz uuid := current_setting('test.biz')::uuid; v_blocked boolean := false;
BEGIN
  UPDATE public.system_admins SET is_active = false WHERE user_id = v_admin::uuid;
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);
  BEGIN PERFORM public.admin_suspend_subscription(v_biz, 'inactive admin test'); EXCEPTION WHEN insufficient_privilege THEN v_blocked := true; END;
  RESET ROLE;
  UPDATE public.system_admins SET is_active = true WHERE user_id = v_admin::uuid;
  IF NOT v_blocked THEN RAISE EXCEPTION 'TEST 9 FAILED: inactive admin not blocked'; END IF;
  RAISE NOTICE 'TEST 9 ok: inactive admin blocked';
END$$;

DO $$ BEGIN RAISE NOTICE '✅ ALL BILLING SECURITY TESTS PASSED'; END$$;

ROLLBACK;  -- never persist test fixtures
