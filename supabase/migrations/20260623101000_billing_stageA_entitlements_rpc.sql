-- ============================================================================
-- Billing hardening — STAGE A (non-breaking)
-- Migration: 20260623_101_billing_stageA_entitlements_rpc
--
-- Fixes the server-side entitlements source of truth `get_business_subscription_features`:
--   1. Adds the missing `personal_finance` key (Mi Guita) so requireFeature() can
--      gate it server-side instead of relying only on the client.
--   2. Aligns `mayorista` to be Full-only and trial = Pro-equivalent (trial does
--      NOT grant mayorista, matching the canonical client matrix in planFeatures.ts).
--   3. Sets an explicit, safe search_path on this SECURITY DEFINER function
--      (was unset → search_path injection risk flagged by Supabase advisors).
--
-- NON-BREAKING for paid/trial access to core premium features: arca, reports,
-- currentAccounts, advancedFinance, tasks keep the same trial/pro/full mapping.
-- The only access deltas are:
--   * personal_finance now explicitly returned (pro/full/trial = true; basico = false).
--   * mayorista: trial no longer reports true (it was an inconsistency; mayorista is
--     not part of the current business plans per project conventions).
--
-- This function does NOT enforce trial expiry — that is handled in Stage E
-- (pg_cron + previewed normalization) to avoid silently revoking access.
-- ============================================================================

-- NOTE: the helper functions are defined FIRST. get_business_subscription_features
-- is a LANGUAGE sql function and Postgres validates its body at creation
-- (check_function_bodies = on by default), so _feat_pro/_feat_full must already
-- exist when the main function is (re)created.

-- Helper: Pro-tier (trial + pro + full) — false when suspended/canceled.
CREATE OR REPLACE FUNCTION public._feat_pro(p_status text, p_plan text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_status IN ('suspended','canceled') THEN false
    WHEN p_status = 'trialing'                THEN true
    WHEN p_plan   IN ('pro','full')           THEN true
    ELSE false
  END;
$$;

-- Helper: Full-only — false when suspended/canceled, false on trial (trial = Pro).
CREATE OR REPLACE FUNCTION public._feat_full(p_status text, p_plan text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_status IN ('suspended','canceled') THEN false
    WHEN p_plan   = 'full'                    THEN true
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION public.get_business_subscription_features(p_business_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT jsonb_build_object(
    'plan_id',         COALESCE(b.subscription_plan, 'basico'),
    'status',          COALESCE(b.subscription_status, 'trialing'),
    'access_source',   b.access_source,
    'max_users',       CASE
                         WHEN b.subscription_status = 'trialing' THEN 3
                         WHEN b.subscription_plan   = 'full'     THEN 10
                         WHEN b.subscription_plan   = 'pro'      THEN 3
                         ELSE 1
                       END,
    -- ── Pro-tier features (trial mirrors Pro) ──
    'arca',             public._feat_pro(b.subscription_status, b.subscription_plan),
    'currentAccounts',  public._feat_pro(b.subscription_status, b.subscription_plan),
    'reports',          public._feat_pro(b.subscription_status, b.subscription_plan),
    'advancedFinance',  public._feat_pro(b.subscription_status, b.subscription_plan),
    'tasks',            public._feat_pro(b.subscription_status, b.subscription_plan),
    'personal_finance', public._feat_pro(b.subscription_status, b.subscription_plan),
    -- ── Full-only features ──
    'advancedRoles',    public._feat_full(b.subscription_status, b.subscription_plan),
    'audit',            public._feat_full(b.subscription_status, b.subscription_plan),
    'multisucursal',    public._feat_full(b.subscription_status, b.subscription_plan),
    'mayorista',        public._feat_full(b.subscription_status, b.subscription_plan)
  )
  FROM public.businesses b
  WHERE b.id = p_business_id;
$function$;

-- Also harden the sibling SECURITY DEFINER helper that lacked nothing here but
-- keep its search_path explicit for consistency (idempotent no-op if already set).
ALTER FUNCTION public.get_business_subscription(uuid) SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public._feat_pro(text, text)  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public._feat_full(text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_business_subscription_features(uuid) TO authenticated;

-- ============================================================================
-- ROLLBACK (manual) — restore the previous body from
--   supabase/migrations/_legacy/get_business_subscription_features_pre_audit.sql
-- (a verbatim copy of the production definition captured during the audit).
-- ============================================================================
