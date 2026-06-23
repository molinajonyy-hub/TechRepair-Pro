-- ============================================================================
-- Billing hardening — STAGE C (secure admin RPCs)
-- Migration: 20260623_121_billing_stageC_admin_rpcs
--
-- Minimal-scope, audited SECURITY DEFINER RPCs that replace ALL direct frontend
-- writes to billing columns on `businesses`. Each RPC:
--   * derives the actor from auth.uid() (NEVER from a client argument);
--   * verifies an active system_admins membership with the required role;
--   * validates its inputs;
--   * mutates ONLY the columns it is allowed to;
--   * writes a mandatory audit row (previous_state / new_state / reason);
--   * returns a minimal typed jsonb result.
--
-- Manual admin activation is recorded as access_source = 'admin_override' or
-- 'manual_grandfathered' and NEVER fabricates a Mercado Pago payment, preapproval
-- id, or payment event.
--
-- These run as the function owner (postgres), so current_user = 'postgres' inside
-- them; the Stage D trigger therefore permits their writes while blocking direct
-- authenticated/anon writes.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- Internal helpers
-- ─────────────────────────────────────────────────────────────────────────────

-- Snapshot of a business's billing-relevant columns (for audit diff).
CREATE OR REPLACE FUNCTION public._biz_billing_state(p_business_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'subscription_status', b.subscription_status,
    'subscription_plan',   b.subscription_plan,
    'access_source',       b.access_source,
    'current_period_start',b.current_period_start,
    'current_period_end',  b.current_period_end,
    'trial_ends_at',       b.trial_ends_at,
    'grace_until',         b.grace_until,
    'override_expires_at', b.override_expires_at
  )
  FROM public.businesses b WHERE b.id = p_business_id;
$$;

-- Authorize the current actor; raises 42501 if not an active admin of >= min role.
-- Returns the actor's auth.uid().
CREATE OR REPLACE FUNCTION public._require_platform_admin(p_min_role text)
RETURNS uuid
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_platform_admin(v_actor, p_min_role) THEN
    RAISE EXCEPTION 'Forbidden: requires platform role %', p_min_role USING ERRCODE = '42501';
  END IF;
  RETURN v_actor;
END;
$$;

-- Validate a non-empty reason (required for every state-changing action).
CREATE OR REPLACE FUNCTION public._require_reason(p_reason text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 4 THEN
    RAISE EXCEPTION 'A reason (>= 4 chars) is required for this action' USING ERRCODE = '22023';
  END IF;
  RETURN btrim(p_reason);
END;
$$;

REVOKE EXECUTE ON FUNCTION public._biz_billing_state(uuid)     FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public._require_platform_admin(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public._require_reason(text)         FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────────
-- admin_activate_subscription — manual activation (admin_override)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_activate_subscription(
  p_business_id uuid,
  p_plan        text,
  p_reason      text,
  p_period_end  timestamptz DEFAULT NULL,
  p_request_id  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := public._require_platform_admin('billing_admin');
  v_reason text := public._require_reason(p_reason);
  v_prev jsonb;
  v_new  jsonb;
BEGIN
  IF p_plan NOT IN ('basico','pro','full') THEN
    RAISE EXCEPTION 'Invalid plan: %', p_plan USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.businesses WHERE id = p_business_id) THEN
    RAISE EXCEPTION 'Business not found' USING ERRCODE = 'P0002';
  END IF;

  v_prev := public._biz_billing_state(p_business_id);

  UPDATE public.businesses SET
    subscription_status  = 'active',
    subscription_plan    = p_plan,
    subscription_provider= 'manual',
    access_source        = 'admin_override',
    override_reason      = v_reason,
    override_created_by  = v_actor,
    override_created_at  = NOW(),
    override_expires_at  = p_period_end,
    current_period_start = NOW(),
    current_period_end   = COALESCE(p_period_end, NOW() + INTERVAL '31 days'),
    grace_until          = NULL,
    updated_at           = NOW()
  WHERE id = p_business_id;

  v_new := public._biz_billing_state(p_business_id);

  INSERT INTO public.subscription_admin_actions(actor_user_id, business_id, action, previous_state, new_state, reason, request_id)
  VALUES (v_actor, p_business_id, 'activate', v_prev, v_new, v_reason, p_request_id);

  RETURN jsonb_build_object('ok', true, 'business_id', p_business_id, 'status', 'active', 'plan', p_plan);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- admin_change_subscription_plan
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_change_subscription_plan(
  p_business_id uuid,
  p_new_plan    text,
  p_reason      text,
  p_request_id  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := public._require_platform_admin('billing_admin');
  v_reason text := public._require_reason(p_reason);
  v_prev jsonb; v_new jsonb;
BEGIN
  IF p_new_plan NOT IN ('basico','pro','full') THEN
    RAISE EXCEPTION 'Invalid plan: %', p_new_plan USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.businesses WHERE id = p_business_id) THEN
    RAISE EXCEPTION 'Business not found' USING ERRCODE = 'P0002';
  END IF;

  v_prev := public._biz_billing_state(p_business_id);
  UPDATE public.businesses
    SET subscription_plan = p_new_plan, updated_at = NOW()
  WHERE id = p_business_id;
  v_new := public._biz_billing_state(p_business_id);

  INSERT INTO public.subscription_admin_actions(actor_user_id, business_id, action, previous_state, new_state, reason, request_id)
  VALUES (v_actor, p_business_id, 'change_plan', v_prev, v_new, v_reason, p_request_id);

  RETURN jsonb_build_object('ok', true, 'business_id', p_business_id, 'plan', p_new_plan);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- admin_extend_trial
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_extend_trial(
  p_business_id uuid,
  p_extra_days  int,
  p_reason      text,
  p_request_id  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := public._require_platform_admin('billing_admin');
  v_reason text := public._require_reason(p_reason);
  v_base timestamptz; v_new_end timestamptz;
  v_prev jsonb; v_new jsonb;
BEGIN
  IF p_extra_days IS NULL OR p_extra_days < 1 OR p_extra_days > 365 THEN
    RAISE EXCEPTION 'extra_days must be between 1 and 365' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.businesses WHERE id = p_business_id) THEN
    RAISE EXCEPTION 'Business not found' USING ERRCODE = 'P0002';
  END IF;

  v_prev := public._biz_billing_state(p_business_id);
  SELECT GREATEST(COALESCE(trial_ends_at, NOW()), NOW()) INTO v_base
    FROM public.businesses WHERE id = p_business_id;
  v_new_end := v_base + make_interval(days => p_extra_days);

  UPDATE public.businesses SET
    subscription_status = 'trialing',
    trial_ends_at       = v_new_end,
    updated_at          = NOW()
  WHERE id = p_business_id;
  v_new := public._biz_billing_state(p_business_id);

  INSERT INTO public.subscription_admin_actions(actor_user_id, business_id, action, previous_state, new_state, reason, request_id)
  VALUES (v_actor, p_business_id, 'extend_trial', v_prev, v_new, v_reason, p_request_id);

  RETURN jsonb_build_object('ok', true, 'business_id', p_business_id, 'trial_ends_at', v_new_end);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- admin_suspend_subscription
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_suspend_subscription(
  p_business_id uuid,
  p_reason      text,
  p_request_id  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := public._require_platform_admin('billing_admin');
  v_reason text := public._require_reason(p_reason);
  v_prev jsonb; v_new jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.businesses WHERE id = p_business_id) THEN
    RAISE EXCEPTION 'Business not found' USING ERRCODE = 'P0002';
  END IF;
  v_prev := public._biz_billing_state(p_business_id);
  UPDATE public.businesses SET subscription_status = 'suspended', updated_at = NOW()
  WHERE id = p_business_id;
  v_new := public._biz_billing_state(p_business_id);
  INSERT INTO public.subscription_admin_actions(actor_user_id, business_id, action, previous_state, new_state, reason, request_id)
  VALUES (v_actor, p_business_id, 'suspend', v_prev, v_new, v_reason, p_request_id);
  RETURN jsonb_build_object('ok', true, 'business_id', p_business_id, 'status', 'suspended');
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- admin_cancel_subscription
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_cancel_subscription(
  p_business_id uuid,
  p_reason      text,
  p_request_id  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := public._require_platform_admin('billing_admin');
  v_reason text := public._require_reason(p_reason);
  v_prev jsonb; v_new jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.businesses WHERE id = p_business_id) THEN
    RAISE EXCEPTION 'Business not found' USING ERRCODE = 'P0002';
  END IF;
  v_prev := public._biz_billing_state(p_business_id);
  UPDATE public.businesses SET subscription_status = 'canceled', updated_at = NOW()
  WHERE id = p_business_id;
  v_new := public._biz_billing_state(p_business_id);
  INSERT INTO public.subscription_admin_actions(actor_user_id, business_id, action, previous_state, new_state, reason, request_id)
  VALUES (v_actor, p_business_id, 'cancel', v_prev, v_new, v_reason, p_request_id);
  RETURN jsonb_build_object('ok', true, 'business_id', p_business_id, 'status', 'canceled');
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- admin_grant_legacy_access — explicit grandfathered/manual access (super_admin)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_grant_legacy_access(
  p_business_id uuid,
  p_plan        text,
  p_reason      text,
  p_expires_at  timestamptz DEFAULT NULL,
  p_request_id  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := public._require_platform_admin('super_admin');
  v_reason text := public._require_reason(p_reason);
  v_prev jsonb; v_new jsonb;
BEGIN
  IF p_plan NOT IN ('basico','pro','full') THEN
    RAISE EXCEPTION 'Invalid plan: %', p_plan USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.businesses WHERE id = p_business_id) THEN
    RAISE EXCEPTION 'Business not found' USING ERRCODE = 'P0002';
  END IF;
  v_prev := public._biz_billing_state(p_business_id);
  UPDATE public.businesses SET
    subscription_status  = 'active',
    subscription_plan    = p_plan,
    subscription_provider= 'manual',
    access_source        = 'manual_grandfathered',
    override_reason      = v_reason,
    override_created_by  = v_actor,
    override_created_at  = NOW(),
    override_expires_at  = p_expires_at,
    grace_until          = NULL,
    updated_at           = NOW()
  WHERE id = p_business_id;
  v_new := public._biz_billing_state(p_business_id);
  INSERT INTO public.subscription_admin_actions(actor_user_id, business_id, action, previous_state, new_state, reason, request_id)
  VALUES (v_actor, p_business_id, 'grant_legacy', v_prev, v_new, v_reason, p_request_id);
  RETURN jsonb_build_object('ok', true, 'business_id', p_business_id, 'access_source', 'manual_grandfathered');
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- admin_revoke_legacy_access (super_admin)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_revoke_legacy_access(
  p_business_id uuid,
  p_reason      text,
  p_request_id  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := public._require_platform_admin('super_admin');
  v_reason text := public._require_reason(p_reason);
  v_prev jsonb; v_new jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.businesses WHERE id = p_business_id) THEN
    RAISE EXCEPTION 'Business not found' USING ERRCODE = 'P0002';
  END IF;
  v_prev := public._biz_billing_state(p_business_id);
  UPDATE public.businesses SET
    subscription_status  = 'suspended',
    access_source        = NULL,
    override_reason      = NULL,
    override_created_by  = NULL,
    override_created_at  = NULL,
    override_expires_at  = NULL,
    updated_at           = NOW()
  WHERE id = p_business_id;
  v_new := public._biz_billing_state(p_business_id);
  INSERT INTO public.subscription_admin_actions(actor_user_id, business_id, action, previous_state, new_state, reason, request_id)
  VALUES (v_actor, p_business_id, 'revoke_legacy', v_prev, v_new, v_reason, p_request_id);
  RETURN jsonb_build_object('ok', true, 'business_id', p_business_id, 'status', 'suspended');
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- admin_list_subscriptions — gated read (support_readonly+) bypassing per-tenant RLS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_list_subscriptions(
  p_query text DEFAULT NULL,
  p_limit int DEFAULT 100
)
RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_actor uuid := public._require_platform_admin('support_readonly');
BEGIN
  RETURN QUERY
    SELECT jsonb_build_object(
      'business_id', b.id,
      'business_name', b.name,
      'subscription_status', b.subscription_status,
      'subscription_plan', b.subscription_plan,
      'access_source', b.access_source,
      'mp_preapproval_id', b.mp_preapproval_id,
      'mp_payer_email', b.mp_payer_email,
      'current_period_end', b.current_period_end,
      'grace_until', b.grace_until,
      'trial_ends_at', b.trial_ends_at,
      'override_expires_at', b.override_expires_at,
      'last_payment_status', b.last_payment_status,
      'last_webhook_at', b.last_webhook_at,
      'created_at', b.created_at,
      'total_payments', (SELECT count(*) FROM public.payments p WHERE p.business_id = b.id),
      'total_revenue', COALESCE((SELECT sum(p.amount) FROM public.payments p WHERE p.business_id = b.id AND p.status='approved'),0)
    )
    FROM public.businesses b
    WHERE p_query IS NULL OR b.name ILIKE '%'||p_query||'%'
    ORDER BY b.created_at DESC
    LIMIT GREATEST(1, LEAST(p_limit, 500));
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- admin_grant_role / admin_revoke_role — manage platform-admin membership
-- (super_admin only). The actor is auth.uid(); nobody can self-promote because
-- only an existing super_admin can call these, and they are audited.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_grant_role(
  p_user_id uuid,
  p_role    text,
  p_reason  text,
  p_request_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := public._require_platform_admin('super_admin');
  v_reason text := public._require_reason(p_reason);
  v_email text;
BEGIN
  IF p_role NOT IN ('super_admin','billing_admin','support_readonly') THEN
    RAISE EXCEPTION 'Invalid role: %', p_role USING ERRCODE = '22023';
  END IF;
  SELECT email INTO v_email FROM auth.users WHERE id = p_user_id;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'No auth user for %', p_user_id USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.system_admins (user_id, email, role, is_active, created_by)
  VALUES (p_user_id, v_email, p_role, TRUE, v_actor)
  ON CONFLICT (user_id) DO UPDATE
    SET role = EXCLUDED.role, is_active = TRUE, revoked_at = NULL, revoked_by = NULL;

  INSERT INTO public.subscription_admin_actions(actor_user_id, business_id, action, previous_state, new_state, reason, request_id)
  VALUES (v_actor, NULL, 'grant_role', NULL, jsonb_build_object('user_id', p_user_id, 'role', p_role), v_reason, p_request_id);

  RETURN jsonb_build_object('ok', true, 'user_id', p_user_id, 'role', p_role);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_revoke_role(
  p_user_id uuid,
  p_reason  text,
  p_request_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := public._require_platform_admin('super_admin');
  v_reason text := public._require_reason(p_reason);
BEGIN
  IF p_user_id = v_actor THEN
    RAISE EXCEPTION 'A super_admin cannot revoke their own access' USING ERRCODE = '22023';
  END IF;
  UPDATE public.system_admins
    SET is_active = FALSE, revoked_at = NOW(), revoked_by = v_actor
  WHERE user_id = p_user_id;

  INSERT INTO public.subscription_admin_actions(actor_user_id, business_id, action, previous_state, new_state, reason, request_id)
  VALUES (v_actor, NULL, 'revoke_role', jsonb_build_object('user_id', p_user_id), NULL, v_reason, p_request_id);

  RETURN jsonb_build_object('ok', true, 'user_id', p_user_id, 'revoked', true);
END;
$$;

-- Grants: callable by authenticated; the internal system-admin check is the gate.
REVOKE EXECUTE ON FUNCTION
  public.admin_grant_role(uuid,text,text,text),
  public.admin_revoke_role(uuid,text,text)
  FROM anon;
GRANT EXECUTE ON FUNCTION
  public.admin_grant_role(uuid,text,text,text),
  public.admin_revoke_role(uuid,text,text)
  TO authenticated;

REVOKE EXECUTE ON FUNCTION
  public.admin_activate_subscription(uuid,text,text,timestamptz,text),
  public.admin_change_subscription_plan(uuid,text,text,text),
  public.admin_extend_trial(uuid,int,text,text),
  public.admin_suspend_subscription(uuid,text,text),
  public.admin_cancel_subscription(uuid,text,text),
  public.admin_grant_legacy_access(uuid,text,text,timestamptz,text),
  public.admin_revoke_legacy_access(uuid,text,text),
  public.admin_list_subscriptions(text,int)
  FROM anon;

GRANT EXECUTE ON FUNCTION
  public.admin_activate_subscription(uuid,text,text,timestamptz,text),
  public.admin_change_subscription_plan(uuid,text,text,text),
  public.admin_extend_trial(uuid,int,text,text),
  public.admin_suspend_subscription(uuid,text,text),
  public.admin_cancel_subscription(uuid,text,text),
  public.admin_grant_legacy_access(uuid,text,text,timestamptz,text),
  public.admin_revoke_legacy_access(uuid,text,text),
  public.admin_list_subscriptions(text,int)
  TO authenticated;

-- ============================================================================
-- ROLLBACK (manual) — Stage C RPCs: DROP FUNCTION IF EXISTS each of the above.
-- ============================================================================
