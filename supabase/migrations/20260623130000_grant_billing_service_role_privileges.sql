-- ============================================================================
-- Billing hardening — GRANT FIX (ordered between Stage C and Stage D)
-- Migration: 20260623130000_grant_billing_service_role_privileges
--
-- Root cause (found during the 2026-06-23 production rollout):
--   The `businesses` table grants were locked down — anon/authenticated have only
--   SELECT and `service_role` had NO privileges at all. So the billing Edge
--   Functions (which connect with the service-role key) could not UPDATE
--   `businesses`, i.e. the webhook could never activate a subscription. This was
--   ONE OF TWO independent webhook blocks (the other was mp-webhook deployed with
--   verify_jwt=true, corrected separately).
--
--   Note: because `authenticated` has NO effective UPDATE on `businesses`, the
--   previously-reported "self-activation via direct PostgREST UPDATE" was NOT
--   actually exploitable in the production state found. The permissive
--   businesses_update RLS policy is a latent risk only if UPDATE is ever granted;
--   the Stage D trigger remains as defense-in-depth.
--
-- This migration grants `service_role` the MINIMAL privileges the functions
-- actually execute (derived from code, not assumption):
--   * NO INSERT or DELETE on businesses, NO full-table UPDATE.
--   * Column-level UPDATE only on the billing columns the code writes.
--   * SELECT on businesses (the functions read state).
--   * SELECT + column UPDATE on subscription_checkout_sessions (markCheckoutSession).
--   * payments / subscription_events already have full service_role grants → untouched.
--   * profiles already has service_role SELECT → untouched.
--   * No sequences involved (UUID PKs) → no USAGE grants.
--   * authenticated / anon grants are NOT changed.
--
-- Idempotent (GRANT is a no-op if already present).
-- ============================================================================

-- ── businesses ──────────────────────────────────────────────────────────────
-- The webhook + mp-subscription read business state (SELECT) and update ONLY the
-- billing/subscription columns below. They never modify commercial columns
-- (name, owner_user_id, settings, logo, etc.) — those are not granted here.
GRANT SELECT ON public.businesses TO service_role;

GRANT UPDATE (
  subscription_status,
  subscription_plan,
  subscription_provider,
  mp_preapproval_id,
  mp_preapproval_plan_id,
  mp_payer_email,
  mp_last_modified,
  current_period_start,
  current_period_end,
  grace_until,
  last_payment_id,
  last_payment_status,
  last_webhook_at,
  access_source,
  updated_at
) ON public.businesses TO service_role;

-- ── subscription_checkout_sessions ──────────────────────────────────────────
-- mp-webhook.markCheckoutSession() selects the latest pending session and updates
-- its status (best-effort). The frontend (authenticated) inserts these rows; the
-- webhook never inserts/deletes them.
GRANT SELECT ON public.subscription_checkout_sessions TO service_role;
GRANT UPDATE (status, updated_at) ON public.subscription_checkout_sessions TO service_role;

-- ============================================================================
-- ROLLBACK (manual):
--   REVOKE UPDATE (subscription_status, subscription_plan, subscription_provider,
--     mp_preapproval_id, mp_preapproval_plan_id, mp_payer_email, mp_last_modified,
--     current_period_start, current_period_end, grace_until, last_payment_id,
--     last_payment_status, last_webhook_at, access_source, updated_at)
--     ON public.businesses FROM service_role;
--   REVOKE SELECT ON public.businesses FROM service_role;
--   REVOKE SELECT, UPDATE (status, updated_at)
--     ON public.subscription_checkout_sessions FROM service_role;
-- ============================================================================
