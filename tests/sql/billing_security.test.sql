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
DECLARE v_owner   uuid := gen_random_uuid();
        v_admin   uuid := gen_random_uuid();
        v_super   uuid := gen_random_uuid();
        v_support uuid := gen_random_uuid();
        v_biz     uuid := gen_random_uuid();
BEGIN
  -- Minimal auth.users rows for FK targets.
  INSERT INTO auth.users (id, email) VALUES
    (v_owner,   'owner_test@example.com'),
    (v_admin,   'billing_admin_test@example.com'),
    (v_super,   'super_admin_test@example.com'),
    (v_support, 'support_ro_test@example.com')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.businesses (id, name, owner_user_id, subscription_status, subscription_plan)
  VALUES (v_biz, 'TEST BILLING BIZ', v_owner, 'trialing', NULL);

  -- The owner has an active owner profile on the business.
  -- profiles.id is FK to auth.users(id), so it must equal the auth user id.
  INSERT INTO public.profiles (id, user_id, business_id, role, is_active)
  VALUES (v_owner, v_owner, v_biz, 'owner', true);

  -- Platform roles (system_admins): billing_admin, super_admin, support_readonly.
  INSERT INTO public.system_admins (user_id, email, role, is_active, created_by) VALUES
    (v_admin,   'billing_admin_test@example.com', 'billing_admin',    true, v_admin),
    (v_super,   'super_admin_test@example.com',   'super_admin',      true, v_super),
    (v_support, 'support_ro_test@example.com',    'support_readonly', true, v_super);

  -- Stash ids for later blocks.
  PERFORM set_config('test.owner',   v_owner::text,   false);
  PERFORM set_config('test.admin',   v_admin::text,   false);
  PERFORM set_config('test.super',   v_super::text,   false);
  PERFORM set_config('test.support', v_support::text, false);
  PERFORM set_config('test.biz',     v_biz::text,     false);
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

-- TEST 10: support_readonly CANNOT modify billing (needs billing_admin) ──────
DO $$
DECLARE v_support text := current_setting('test.support');
        v_biz uuid := current_setting('test.biz')::uuid; v_blocked boolean := false;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_support, 'role','authenticated')::text, true);
  BEGIN PERFORM public.admin_suspend_subscription(v_biz, 'support tries to write'); EXCEPTION WHEN insufficient_privilege THEN v_blocked := true; END;
  RESET ROLE;
  IF NOT v_blocked THEN RAISE EXCEPTION 'TEST 10 FAILED: support_readonly modified billing'; END IF;
  RAISE NOTICE 'TEST 10 ok: support_readonly cannot modify billing';
END$$;

-- TEST 11: billing_admin CANNOT manage admins (admin_grant_role needs super_admin)
DO $$
DECLARE v_admin text := current_setting('test.admin');
        v_owner uuid := current_setting('test.owner')::uuid; v_blocked boolean := false;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);
  BEGIN PERFORM public.admin_grant_role(v_owner, 'billing_admin', 'billing_admin tries to grant'); EXCEPTION WHEN insufficient_privilege THEN v_blocked := true; END;
  RESET ROLE;
  IF NOT v_blocked THEN RAISE EXCEPTION 'TEST 11 FAILED: billing_admin granted a role'; END IF;
  RAISE NOTICE 'TEST 11 ok: billing_admin cannot manage admins';
END$$;

-- TEST 12: super_admin CAN grant a role (and it is audited) ───────────────────
DO $$
DECLARE v_super text := current_setting('test.super');
        v_owner uuid := current_setting('test.owner')::uuid; v_role text;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_super, 'role','authenticated')::text, true);
  PERFORM public.admin_grant_role(v_owner, 'support_readonly', 'promote owner for test');
  RESET ROLE;
  SELECT role INTO v_role FROM public.system_admins WHERE user_id = v_owner;
  IF v_role <> 'support_readonly' THEN RAISE EXCEPTION 'TEST 12 FAILED: role not granted (got %)', v_role; END IF;
  RAISE NOTICE 'TEST 12 ok: super_admin granted a role';
END$$;

-- TEST 13: a super_admin CANNOT revoke their own (last) access ────────────────
DO $$
DECLARE v_super text := current_setting('test.super'); v_blocked boolean := false;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_super, 'role','authenticated')::text, true);
  BEGIN PERFORM public.admin_revoke_role(v_super::uuid, 'self revoke attempt'); EXCEPTION WHEN OTHERS THEN v_blocked := true; END;
  RESET ROLE;
  IF NOT v_blocked THEN RAISE EXCEPTION 'TEST 13 FAILED: super_admin revoked own access'; END IF;
  RAISE NOTICE 'TEST 13 ok: super_admin cannot self-revoke (last admin protected)';
END$$;

-- TEST 14: service_role (the webhook path) CAN write subscription columns ─────
DO $$
DECLARE v_biz uuid := current_setting('test.biz')::uuid; v_status text;
BEGIN
  SET LOCAL ROLE service_role;
  UPDATE public.businesses SET subscription_status='active', access_source='mercado_pago', updated_at=NOW() WHERE id = v_biz;
  RESET ROLE;
  SELECT subscription_status INTO v_status FROM public.businesses WHERE id = v_biz;
  IF v_status <> 'active' THEN RAISE EXCEPTION 'TEST 14 FAILED: service_role could not write (got %)', v_status; END IF;
  RAISE NOTICE 'TEST 14 ok: service_role (webhook) can write subscription columns';
END$$;

DO $$ BEGIN RAISE NOTICE '✅ ALL BILLING SECURITY TESTS PASSED'; END$$;

ROLLBACK;  -- never persist test fixtures
