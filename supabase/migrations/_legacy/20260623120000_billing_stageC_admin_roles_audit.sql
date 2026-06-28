-- ============================================================================
-- Billing hardening — STAGE C (secure admin foundation)
-- Migration: 20260623_120_billing_stageC_admin_roles_audit
--
-- Reuses the EXISTING `system_admins` allowlist (already wired into
-- /admin/subscriptions via useSystemOwner + ProtectedRouteBySystemOwner) as the
-- single source of truth for platform admins — instead of creating a parallel
-- table. It adds the role granularity + audit the billing RPCs need.
--
-- Security model:
--   * system_admins membership is managed ONLY via migration / service_role /
--     the super_admin-gated path. anon/authenticated have SELECT (read-own via
--     RLS) but NO INSERT/UPDATE/DELETE → nobody can self-promote.
--   * Existing rows are preserved and default to role='super_admin', is_active=true,
--     so current admins keep working with full access (no manual seed needed).
--   * subscription_admin_actions is append-only audit, readable only by admins.
--
-- Apply BEFORE the protective trigger (Stage D): a verified write path must exist
-- first.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Extend system_admins with role / lifecycle columns
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.system_admins
  ADD COLUMN IF NOT EXISTS role       TEXT    NOT NULL DEFAULT 'super_admin',
  ADD COLUMN IF NOT EXISTS is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS created_by UUID,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_by UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_admins_role_chk') THEN
    ALTER TABLE public.system_admins
      ADD CONSTRAINT system_admins_role_chk
      CHECK (role IN ('super_admin','billing_admin','support_readonly'));
  END IF;
  -- Needed for upsert by user_id in admin_grant_role (1 row today → safe).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_admins_user_id_key') THEN
    ALTER TABLE public.system_admins
      ADD CONSTRAINT system_admins_user_id_key UNIQUE (user_id);
  END IF;
END$$;

-- Membership is not client-writable. Keep the existing read-own SELECT grant
-- (useSystemOwner depends on it) but ensure no write privileges leak.
REVOKE INSERT, UPDATE, DELETE ON public.system_admins FROM anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. subscription_admin_actions — append-only audit (policy added after helpers)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.subscription_admin_actions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id  UUID NOT NULL,
  business_id    UUID,
  action         TEXT NOT NULL,
  previous_state JSONB,
  new_state      JSONB,
  reason         TEXT,
  request_id     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saa_business ON public.subscription_admin_actions(business_id);
CREATE INDEX IF NOT EXISTS idx_saa_actor    ON public.subscription_admin_actions(actor_user_id);

ALTER TABLE public.subscription_admin_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.subscription_admin_actions FROM anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Authorization helpers (SECURITY DEFINER, explicit search_path)
--    Defined BEFORE the audit RLS policy that references is_platform_admin().
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._admin_role_weight(p_role text)
RETURNS int
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE p_role
    WHEN 'super_admin'      THEN 30
    WHEN 'billing_admin'    THEN 20
    WHEN 'support_readonly' THEN 10
    ELSE 0
  END;
$$;

-- TRUE when p_user_id is an active system admin meeting p_min_role.
CREATE OR REPLACE FUNCTION public.is_platform_admin(p_user_id uuid, p_min_role text DEFAULT NULL)
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.system_admins sa
    WHERE sa.user_id = p_user_id
      AND sa.is_active = TRUE
      AND public._admin_role_weight(sa.role)
          >= public._admin_role_weight(COALESCE(p_min_role, 'support_readonly'))
  );
$$;

-- Active role for the current user (or NULL). Used by the frontend to render the
-- panel without exposing the admin list.
CREATE OR REPLACE FUNCTION public.current_platform_admin_role()
RETURNS text
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT sa.role
  FROM public.system_admins sa
  WHERE sa.user_id = auth.uid() AND sa.is_active = TRUE
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public._admin_role_weight(text)        FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.is_platform_admin(uuid, text)   TO authenticated;
GRANT  EXECUTE ON FUNCTION public.current_platform_admin_role()   TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3b. Audit read policy (now that is_platform_admin exists)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='subscription_admin_actions' AND policyname='saa_select_admin') THEN
    CREATE POLICY saa_select_admin ON public.subscription_admin_actions
      FOR SELECT TO authenticated
      USING (public.is_platform_admin(auth.uid()));
  END IF;
END$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Granting/revoking admin roles is MIGRATION / service_role / super_admin only.
--    Existing system_admins rows are already super_admin (default above), so the
--    current owner keeps full access. To add a billing_admin later, use a
--    migration or:  select public.admin_grant_role('<user_id>','billing_admin','reason');
--    (defined in the next migration, gated to super_admin).
-- ─────────────────────────────────────────────────────────────────────────────

-- ============================================================================
-- ROLLBACK (manual) — Stage C foundation
--   DROP FUNCTION IF EXISTS public.current_platform_admin_role();
--   DROP FUNCTION IF EXISTS public.is_platform_admin(uuid, text);
--   DROP FUNCTION IF EXISTS public._admin_role_weight(text);
--   DROP TABLE IF EXISTS public.subscription_admin_actions;
--   ALTER TABLE public.system_admins
--     DROP CONSTRAINT IF EXISTS system_admins_role_chk,
--     DROP COLUMN IF EXISTS role, DROP COLUMN IF EXISTS is_active,
--     DROP COLUMN IF EXISTS created_by, DROP COLUMN IF EXISTS revoked_at,
--     DROP COLUMN IF EXISTS revoked_by;
-- ============================================================================
