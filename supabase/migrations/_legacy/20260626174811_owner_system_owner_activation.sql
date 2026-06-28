-- ============================================================================
-- ⚠️ ARCHIVED — historical evidence only. NOT loaded by the Supabase CLI.
--   * Applied to PRODUCTION via MCP apply_migration; recorded remotely as
--     version 20260626174811 (this filename uses that REAL remote version, not
--     the original local 20260626160000).
--   * This is a DATA migration (already executed in prod). The schema baseline
--     does NOT contain it; do NOT re-apply. See supabase/MIGRATION_BASELINE_PLAN.md.
-- ============================================================================
-- Migration: owner_system_owner_activation
-- Date:      2026-06-26
-- Purpose:   Idempotent activation of the System Owner account
--            (molina.jonyy@gmail.com) and its business "Clic".
--
-- ROOT CAUSE this fixes:
--   The owner's business (resolved via the owner profile, NOT by name) was left
--   in subscription_status='pending_activation' by the 2026-06-23 billing
--   "grandfather" pass. The client maps pending_activation -> 'blocked'
--   (getAccessLevel) and the server `business_has_feature` requires status in
--   ('active','trialing'), so every module (incl. Mayorista/RLS) was blocked
--   even though the business is plan='full' with a permanent manual override.
--
-- WHAT IT DOES (all idempotent, scoped to the owner's own rows only):
--   1. Resolve the auth user by email (abort on 0 or >1 — never ambiguous).
--   2. Resolve the target business from the owner's profile (deterministic;
--      we NEVER match by the name "Clic" because a stale duplicate exists).
--   3. Activate the profile (is_active + role=owner).
--   4. Grant permanent Full via grandfathered override (mirrors the audited
--      admin_grant_legacy_access RPC): status=active, plan=full,
--      access_source=manual_grandfathered, override_expires_at=NULL.
--   5. Ensure the private Portal Clic flag (wholesale_portal_enabled + slug)
--      for THIS business only.
--   6. Register the user in system_admins as super_admin (idempotent).
--   7. Expire any stale pending invitations for this email (defensive).
--   8. Write an audit row in subscription_admin_actions (only when state changed).
--
-- SAFETY:
--   * Runs inside the migration transaction (atomic).
--   * The direct UPDATE on businesses is permitted because the migration runs
--     as a privileged role; protect_subscription_columns() only blocks the
--     'authenticated' and 'anon' roles.
--   * Touches no other business. Creates no fake payments / MP movements.
--   * Re-running is a no-op (no duplicate audit rows).
-- ============================================================================

DO $$
DECLARE
  v_email       text := 'molina.jonyy@gmail.com';
  v_user_id     uuid;
  v_user_count  int;
  v_owner_count int;
  v_business_id uuid;
  v_prev        jsonb;
  v_new         jsonb;
  v_reason      text := 'System Owner permanent Full grant — activation fix '
                     || '(pending_activation->active), 2026-06-26 auth/plan/permissions audit';
BEGIN
  -- 1) Resolve auth user (fail closed on 0 or >1) ---------------------------
  SELECT count(*) INTO v_user_count FROM auth.users WHERE lower(email) = v_email;
  IF v_user_count = 0 THEN
    RAISE EXCEPTION 'owner activation aborted: no auth.users row for %', v_email;
  ELSIF v_user_count > 1 THEN
    RAISE EXCEPTION 'owner activation aborted: % auth.users rows for % (ambiguous)',
      v_user_count, v_email;
  END IF;
  SELECT id INTO v_user_id FROM auth.users WHERE lower(email) = v_email;

  -- 2) Resolve target business from the OWNER PROFILE (never by name) -------
  SELECT count(*) INTO v_owner_count
  FROM public.profiles
  WHERE user_id = v_user_id AND role = 'owner';
  IF v_owner_count = 0 THEN
    RAISE EXCEPTION 'owner activation aborted: no owner profile for %', v_email;
  ELSIF v_owner_count > 1 THEN
    RAISE EXCEPTION 'owner activation aborted: % owner profiles for % (ambiguous business — resolve manually)',
      v_owner_count, v_email;
  END IF;
  SELECT business_id INTO v_business_id
  FROM public.profiles
  WHERE user_id = v_user_id AND role = 'owner';
  IF v_business_id IS NULL THEN
    RAISE EXCEPTION 'owner activation aborted: owner profile has NULL business_id';
  END IF;

  -- 3) Activate the membership/profile (idempotent) ------------------------
  UPDATE public.profiles
     SET is_active  = true,
         role       = 'owner',
         updated_at = now()
   WHERE user_id = v_user_id
     AND (is_active IS DISTINCT FROM true OR role IS DISTINCT FROM 'owner');

  -- 4) Snapshot previous billing state for audit ---------------------------
  v_prev := public._biz_billing_state(v_business_id);

  -- 5) Permanent Full grant + private portal flag (idempotent) -------------
  --    Mirrors admin_grant_legacy_access. current_period_end uses a fixed
  --    far-future date (not 'infinity') so the frontend date math stays sane.
  UPDATE public.businesses
     SET subscription_status      = 'active',
         subscription_plan        = 'full',
         subscription_provider    = 'manual',
         access_source            = 'manual_grandfathered',
         override_reason          = COALESCE(override_reason, v_reason),
         override_created_by      = COALESCE(override_created_by, v_user_id),
         override_created_at      = COALESCE(override_created_at, now()),
         override_expires_at      = NULL,                              -- permanent
         current_period_start     = COALESCE(current_period_start, now()),
         current_period_end       = TIMESTAMPTZ '2099-12-31 23:59:59+00',
         grace_until              = NULL,
         trial_ends_at            = NULL,
         wholesale_portal_enabled = true,
         wholesale_portal_slug    = COALESCE(wholesale_portal_slug, 'clic'),
         updated_at               = now()
   WHERE id = v_business_id;

  -- 6) System Owner registration (idempotent) ------------------------------
  INSERT INTO public.system_admins (user_id, email, role, is_active)
  VALUES (v_user_id, v_email, 'super_admin', true)
  ON CONFLICT (user_id) DO UPDATE
    SET is_active  = true,
        role       = 'super_admin',
        revoked_at = NULL,
        revoked_by = NULL;

  -- 7) Expire stale pending invitations for this email (defensive) ---------
  UPDATE public.business_invitations
     SET status = 'expired', updated_at = now()
   WHERE lower(email) = v_email AND status = 'pending';

  -- 8) Audit (only when the billing state actually changed) ----------------
  v_new := public._biz_billing_state(v_business_id);
  IF v_prev IS DISTINCT FROM v_new THEN
    INSERT INTO public.subscription_admin_actions
      (actor_user_id, business_id, action, previous_state, new_state, reason, request_id)
    VALUES
      (v_user_id, v_business_id, 'system_owner_activation', v_prev, v_new, v_reason,
       'owner_activation_20260626');
  END IF;

  RAISE NOTICE 'owner activation OK: user=% business=% prev_status=% new_status=%',
    v_user_id, v_business_id, v_prev->>'subscription_status', v_new->>'subscription_status';
END $$;
