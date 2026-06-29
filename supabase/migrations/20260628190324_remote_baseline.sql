


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";








ALTER SCHEMA "public" OWNER TO "postgres";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."_admin_role_weight"("p_role" "text") RETURNS integer
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  SELECT CASE p_role
    WHEN 'super_admin'      THEN 30
    WHEN 'billing_admin'    THEN 20
    WHEN 'support_readonly' THEN 10
    ELSE 0
  END;
$$;


ALTER FUNCTION "public"."_admin_role_weight"("p_role" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_biz_billing_state"("p_business_id" "uuid") RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  SELECT jsonb_build_object(
    'subscription_status', b.subscription_status, 'subscription_plan', b.subscription_plan,
    'access_source', b.access_source, 'current_period_start',b.current_period_start,
    'current_period_end', b.current_period_end, 'trial_ends_at', b.trial_ends_at,
    'grace_until', b.grace_until, 'override_expires_at', b.override_expires_at)
  FROM public.businesses b WHERE b.id = p_business_id;
$$;


ALTER FUNCTION "public"."_biz_billing_state"("p_business_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_feat_full"("p_status" "text", "p_plan" "text") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  SELECT CASE
    WHEN p_status IN ('suspended','canceled') THEN false
    WHEN p_plan   = 'full'                    THEN true
    ELSE false
  END;
$$;


ALTER FUNCTION "public"."_feat_full"("p_status" "text", "p_plan" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_feat_pro"("p_status" "text", "p_plan" "text") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  SELECT CASE
    WHEN p_status IN ('suspended','canceled') THEN false
    WHEN p_status = 'trialing'                THEN true
    WHEN p_plan   IN ('pro','full')           THEN true
    ELSE false
  END;
$$;


ALTER FUNCTION "public"."_feat_pro"("p_status" "text", "p_plan" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_require_platform_admin"("p_min_role" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF NOT public.is_platform_admin(v_actor, p_min_role) THEN
    RAISE EXCEPTION 'Forbidden: requires platform role %', p_min_role USING ERRCODE = '42501'; END IF;
  RETURN v_actor;
END; $$;


ALTER FUNCTION "public"."_require_platform_admin"("p_min_role" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_require_reason"("p_reason" "text") RETURNS "text"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 4 THEN
    RAISE EXCEPTION 'A reason (>= 4 chars) is required for this action' USING ERRCODE = '22023'; END IF;
  RETURN btrim(p_reason);
END; $$;


ALTER FUNCTION "public"."_require_reason"("p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_test_require_feature"("features" "jsonb", "feature" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT CASE
    WHEN (features->>'status') IN ('suspended','canceled') THEN 'SUBSCRIPTION_INACTIVE'
    WHEN NOT (features ? feature)                          THEN 'FEATURE_NOT_AVAILABLE'
    WHEN NOT (features->>feature)::boolean                 THEN 'UPGRADE_REQUIRED'
    ELSE 'ALLOW'
  END;
$$;


ALTER FUNCTION "public"."_test_require_feature"("features" "jsonb", "feature" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."accept_business_invitation"("p_token" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_invitation public.business_invitations%ROWTYPE;
  v_user_id UUID;
  v_email TEXT;
  v_full_name TEXT;
  v_profile_id UUID;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Tenés que iniciar sesión antes de aceptar la invitación';
  END IF;

  SELECT *
  INTO v_invitation
  FROM public.business_invitations
  WHERE token = trim(p_token)
    AND status = 'pending'
    AND expires_at > NOW()
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_invitation.id IS NULL THEN
    RAISE EXCEPTION 'Invitación inválida o expirada';
  END IF;

  SELECT
    lower(u.email),
    COALESCE(u.raw_user_meta_data ->> 'full_name', split_part(u.email, '@', 1))
  INTO v_email, v_full_name
  FROM auth.users u
  WHERE u.id = v_user_id;

  IF EXISTS (SELECT 1 FROM public.profiles WHERE COALESCE(user_id, id) = v_user_id) THEN
    UPDATE public.profiles
    SET business_id = v_invitation.business_id,
        user_id = COALESCE(user_id, v_user_id),
        role = v_invitation.role,
        is_active = TRUE,
        email = COALESCE(public.profiles.email, v_email),
        full_name = COALESCE(public.profiles.full_name, v_full_name),
        updated_at = NOW()
    WHERE COALESCE(user_id, id) = v_user_id
    RETURNING id INTO v_profile_id;
  ELSE
    INSERT INTO public.profiles (
      user_id,
      business_id,
      role,
      is_active,
      full_name,
      email
    )
    VALUES (
      v_user_id,
      v_invitation.business_id,
      v_invitation.role,
      TRUE,
      v_full_name,
      v_email
    )
    RETURNING id INTO v_profile_id;
  END IF;

  UPDATE public.business_invitations
  SET status = 'accepted',
      accepted_at = NOW()
  WHERE id = v_invitation.id;

  RETURN v_profile_id;
END;
$$;


ALTER FUNCTION "public"."accept_business_invitation"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."adjust_stock_on_order_item"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_prev_stock  INTEGER;
  v_new_stock   INTEGER;
  v_business_id UUID;
  v_qty_change  INTEGER;
BEGIN
  -- Resolver business_id desde la fila o, si no está, desde la orden padre
  v_business_id := COALESCE(
    CASE WHEN TG_OP = 'DELETE' THEN OLD.business_id ELSE NEW.business_id END,
    (SELECT business_id FROM public.orders
     WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.order_id ELSE NEW.order_id END)
  );

  -- ── INSERT: descontar stock ────────────────────────────────────────────────
  IF TG_OP = 'INSERT' AND NEW.tipo = 'repuesto' AND NEW.product_id IS NOT NULL THEN

    SELECT stock_quantity INTO v_prev_stock
    FROM public.inventory WHERE id = NEW.product_id;
    v_prev_stock := COALESCE(v_prev_stock, 0);
    v_new_stock  := GREATEST(v_prev_stock - NEW.cantidad, 0);

    UPDATE public.inventory
    SET stock_quantity = v_new_stock,
        stock          = v_new_stock,
        updated_at     = NOW()
    WHERE id = NEW.product_id;

    INSERT INTO public.inventory_movements (
      business_id, inventory_item_id, movement_type,
      quantity, previous_stock, new_stock,
      reference_type, reference_id, note
      -- created_by omitido: order_items no tiene esa columna (nullable en movements)
    ) VALUES (
      v_business_id, NEW.product_id, 'order_usage',
      -NEW.cantidad, v_prev_stock, v_new_stock,
      'order', NEW.order_id,
      'Repuesto usado en orden #' || LEFT(NEW.order_id::TEXT, 8)
    );

    RETURN NEW;

  -- ── DELETE: devolver stock ─────────────────────────────────────────────────
  ELSIF TG_OP = 'DELETE' AND OLD.tipo = 'repuesto' AND OLD.product_id IS NOT NULL THEN

    SELECT stock_quantity INTO v_prev_stock
    FROM public.inventory WHERE id = OLD.product_id;
    v_prev_stock := COALESCE(v_prev_stock, 0);
    v_new_stock  := v_prev_stock + OLD.cantidad;

    UPDATE public.inventory
    SET stock_quantity = v_new_stock,
        stock          = v_new_stock,
        updated_at     = NOW()
    WHERE id = OLD.product_id;

    INSERT INTO public.inventory_movements (
      business_id, inventory_item_id, movement_type,
      quantity, previous_stock, new_stock,
      reference_type, reference_id, note
    ) VALUES (
      v_business_id, OLD.product_id, 'return',
      OLD.cantidad, v_prev_stock, v_new_stock,
      'order', OLD.order_id,
      'Reverso: repuesto eliminado de orden #' || LEFT(OLD.order_id::TEXT, 8)
    );

    RETURN OLD;

  -- ── UPDATE: ajustar diferencia de cantidad ────────────────────────────────
  ELSIF TG_OP = 'UPDATE' AND NEW.tipo = 'repuesto' AND NEW.product_id IS NOT NULL THEN

    v_qty_change := NEW.cantidad - OLD.cantidad;
    IF v_qty_change = 0 THEN RETURN NEW; END IF;

    SELECT stock_quantity INTO v_prev_stock
    FROM public.inventory WHERE id = NEW.product_id;
    v_prev_stock := COALESCE(v_prev_stock, 0);
    v_new_stock  := GREATEST(v_prev_stock - v_qty_change, 0);

    UPDATE public.inventory
    SET stock_quantity = v_new_stock,
        stock          = v_new_stock,
        updated_at     = NOW()
    WHERE id = NEW.product_id;

    INSERT INTO public.inventory_movements (
      business_id, inventory_item_id, movement_type,
      quantity, previous_stock, new_stock,
      reference_type, reference_id, note
    ) VALUES (
      v_business_id, NEW.product_id,
      CASE WHEN v_qty_change > 0 THEN 'order_usage' ELSE 'return' END,
      -v_qty_change, v_prev_stock, v_new_stock,
      'order', NEW.order_id,
      'Ajuste cantidad en orden #' || LEFT(NEW.order_id::TEXT, 8)
    );

    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;


ALTER FUNCTION "public"."adjust_stock_on_order_item"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_activate_subscription"("p_business_id" "uuid", "p_plan" "text", "p_reason" "text", "p_period_end" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_request_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE v_actor uuid := public._require_platform_admin('billing_admin'); v_reason text := public._require_reason(p_reason); v_prev jsonb; v_new jsonb;
BEGIN
  IF p_plan NOT IN ('basico','pro','full') THEN RAISE EXCEPTION 'Invalid plan: %', p_plan USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.businesses WHERE id = p_business_id) THEN RAISE EXCEPTION 'Business not found' USING ERRCODE = 'P0002'; END IF;
  v_prev := public._biz_billing_state(p_business_id);
  UPDATE public.businesses SET subscription_status='active', subscription_plan=p_plan, subscription_provider='manual',
    access_source='admin_override', override_reason=v_reason, override_created_by=v_actor, override_created_at=NOW(),
    override_expires_at=p_period_end, current_period_start=NOW(), current_period_end=COALESCE(p_period_end, NOW()+INTERVAL '31 days'),
    grace_until=NULL, updated_at=NOW() WHERE id = p_business_id;
  v_new := public._biz_billing_state(p_business_id);
  INSERT INTO public.subscription_admin_actions(actor_user_id, business_id, action, previous_state, new_state, reason, request_id)
  VALUES (v_actor, p_business_id, 'activate', v_prev, v_new, v_reason, p_request_id);
  RETURN jsonb_build_object('ok', true, 'business_id', p_business_id, 'status', 'active', 'plan', p_plan);
END; $$;


ALTER FUNCTION "public"."admin_activate_subscription"("p_business_id" "uuid", "p_plan" "text", "p_reason" "text", "p_period_end" timestamp with time zone, "p_request_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_cancel_subscription"("p_business_id" "uuid", "p_reason" "text", "p_request_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE v_actor uuid := public._require_platform_admin('billing_admin'); v_reason text := public._require_reason(p_reason); v_prev jsonb; v_new jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.businesses WHERE id = p_business_id) THEN RAISE EXCEPTION 'Business not found' USING ERRCODE = 'P0002'; END IF;
  v_prev := public._biz_billing_state(p_business_id);
  UPDATE public.businesses SET subscription_status='canceled', updated_at=NOW() WHERE id = p_business_id;
  v_new := public._biz_billing_state(p_business_id);
  INSERT INTO public.subscription_admin_actions(actor_user_id, business_id, action, previous_state, new_state, reason, request_id)
  VALUES (v_actor, p_business_id, 'cancel', v_prev, v_new, v_reason, p_request_id);
  RETURN jsonb_build_object('ok', true, 'business_id', p_business_id, 'status', 'canceled');
END; $$;


ALTER FUNCTION "public"."admin_cancel_subscription"("p_business_id" "uuid", "p_reason" "text", "p_request_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_change_subscription_plan"("p_business_id" "uuid", "p_new_plan" "text", "p_reason" "text", "p_request_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE v_actor uuid := public._require_platform_admin('billing_admin'); v_reason text := public._require_reason(p_reason); v_prev jsonb; v_new jsonb;
BEGIN
  IF p_new_plan NOT IN ('basico','pro','full') THEN RAISE EXCEPTION 'Invalid plan: %', p_new_plan USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.businesses WHERE id = p_business_id) THEN RAISE EXCEPTION 'Business not found' USING ERRCODE = 'P0002'; END IF;
  v_prev := public._biz_billing_state(p_business_id);
  UPDATE public.businesses SET subscription_plan = p_new_plan, updated_at = NOW() WHERE id = p_business_id;
  v_new := public._biz_billing_state(p_business_id);
  INSERT INTO public.subscription_admin_actions(actor_user_id, business_id, action, previous_state, new_state, reason, request_id)
  VALUES (v_actor, p_business_id, 'change_plan', v_prev, v_new, v_reason, p_request_id);
  RETURN jsonb_build_object('ok', true, 'business_id', p_business_id, 'plan', p_new_plan);
END; $$;


ALTER FUNCTION "public"."admin_change_subscription_plan"("p_business_id" "uuid", "p_new_plan" "text", "p_reason" "text", "p_request_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_extend_trial"("p_business_id" "uuid", "p_extra_days" integer, "p_reason" "text", "p_request_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE v_actor uuid := public._require_platform_admin('billing_admin'); v_reason text := public._require_reason(p_reason); v_base timestamptz; v_new_end timestamptz; v_prev jsonb; v_new jsonb;
BEGIN
  IF p_extra_days IS NULL OR p_extra_days < 1 OR p_extra_days > 365 THEN RAISE EXCEPTION 'extra_days must be between 1 and 365' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.businesses WHERE id = p_business_id) THEN RAISE EXCEPTION 'Business not found' USING ERRCODE = 'P0002'; END IF;
  v_prev := public._biz_billing_state(p_business_id);
  SELECT GREATEST(COALESCE(trial_ends_at, NOW()), NOW()) INTO v_base FROM public.businesses WHERE id = p_business_id;
  v_new_end := v_base + make_interval(days => p_extra_days);
  UPDATE public.businesses SET subscription_status='trialing', trial_ends_at=v_new_end, updated_at=NOW() WHERE id = p_business_id;
  v_new := public._biz_billing_state(p_business_id);
  INSERT INTO public.subscription_admin_actions(actor_user_id, business_id, action, previous_state, new_state, reason, request_id)
  VALUES (v_actor, p_business_id, 'extend_trial', v_prev, v_new, v_reason, p_request_id);
  RETURN jsonb_build_object('ok', true, 'business_id', p_business_id, 'trial_ends_at', v_new_end);
END; $$;


ALTER FUNCTION "public"."admin_extend_trial"("p_business_id" "uuid", "p_extra_days" integer, "p_reason" "text", "p_request_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_grant_legacy_access"("p_business_id" "uuid", "p_plan" "text", "p_reason" "text", "p_expires_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_request_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE v_actor uuid := public._require_platform_admin('super_admin'); v_reason text := public._require_reason(p_reason); v_prev jsonb; v_new jsonb;
BEGIN
  IF p_plan NOT IN ('basico','pro','full') THEN RAISE EXCEPTION 'Invalid plan: %', p_plan USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.businesses WHERE id = p_business_id) THEN RAISE EXCEPTION 'Business not found' USING ERRCODE = 'P0002'; END IF;
  v_prev := public._biz_billing_state(p_business_id);
  UPDATE public.businesses SET subscription_status='active', subscription_plan=p_plan, subscription_provider='manual',
    access_source='manual_grandfathered', override_reason=v_reason, override_created_by=v_actor, override_created_at=NOW(),
    override_expires_at=p_expires_at, grace_until=NULL, updated_at=NOW() WHERE id = p_business_id;
  v_new := public._biz_billing_state(p_business_id);
  INSERT INTO public.subscription_admin_actions(actor_user_id, business_id, action, previous_state, new_state, reason, request_id)
  VALUES (v_actor, p_business_id, 'grant_legacy', v_prev, v_new, v_reason, p_request_id);
  RETURN jsonb_build_object('ok', true, 'business_id', p_business_id, 'access_source', 'manual_grandfathered');
END; $$;


ALTER FUNCTION "public"."admin_grant_legacy_access"("p_business_id" "uuid", "p_plan" "text", "p_reason" "text", "p_expires_at" timestamp with time zone, "p_request_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_grant_role"("p_user_id" "uuid", "p_role" "text", "p_reason" "text", "p_request_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE v_actor uuid := public._require_platform_admin('super_admin'); v_reason text := public._require_reason(p_reason); v_email text;
BEGIN
  IF p_role NOT IN ('super_admin','billing_admin','support_readonly') THEN RAISE EXCEPTION 'Invalid role: %', p_role USING ERRCODE = '22023'; END IF;
  SELECT email INTO v_email FROM auth.users WHERE id = p_user_id;
  IF v_email IS NULL THEN RAISE EXCEPTION 'No auth user for %', p_user_id USING ERRCODE = 'P0002'; END IF;
  INSERT INTO public.system_admins (user_id, email, role, is_active, created_by)
  VALUES (p_user_id, v_email, p_role, TRUE, v_actor)
  ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, is_active = TRUE, revoked_at = NULL, revoked_by = NULL;
  INSERT INTO public.subscription_admin_actions(actor_user_id, business_id, action, previous_state, new_state, reason, request_id)
  VALUES (v_actor, NULL, 'grant_role', NULL, jsonb_build_object('user_id', p_user_id, 'role', p_role), v_reason, p_request_id);
  RETURN jsonb_build_object('ok', true, 'user_id', p_user_id, 'role', p_role);
END; $$;


ALTER FUNCTION "public"."admin_grant_role"("p_user_id" "uuid", "p_role" "text", "p_reason" "text", "p_request_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_list_subscriptions"("p_query" "text" DEFAULT NULL::"text", "p_limit" integer DEFAULT 100) RETURNS SETOF "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE v_actor uuid := public._require_platform_admin('support_readonly');
BEGIN
  RETURN QUERY SELECT jsonb_build_object('business_id', b.id, 'business_name', b.name,
    'subscription_status', b.subscription_status, 'subscription_plan', b.subscription_plan, 'access_source', b.access_source,
    'mp_preapproval_id', b.mp_preapproval_id, 'mp_payer_email', b.mp_payer_email, 'current_period_end', b.current_period_end,
    'grace_until', b.grace_until, 'trial_ends_at', b.trial_ends_at, 'override_expires_at', b.override_expires_at,
    'last_payment_status', b.last_payment_status, 'last_webhook_at', b.last_webhook_at, 'created_at', b.created_at,
    'total_payments', (SELECT count(*) FROM public.payments p WHERE p.business_id = b.id),
    'total_revenue', COALESCE((SELECT sum(p.amount) FROM public.payments p WHERE p.business_id = b.id AND p.status='approved'),0))
  FROM public.businesses b WHERE p_query IS NULL OR b.name ILIKE '%'||p_query||'%'
  ORDER BY b.created_at DESC LIMIT GREATEST(1, LEAST(p_limit, 500));
END; $$;


ALTER FUNCTION "public"."admin_list_subscriptions"("p_query" "text", "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_revoke_legacy_access"("p_business_id" "uuid", "p_reason" "text", "p_request_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE v_actor uuid := public._require_platform_admin('super_admin'); v_reason text := public._require_reason(p_reason); v_prev jsonb; v_new jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.businesses WHERE id = p_business_id) THEN RAISE EXCEPTION 'Business not found' USING ERRCODE = 'P0002'; END IF;
  v_prev := public._biz_billing_state(p_business_id);
  UPDATE public.businesses SET subscription_status='suspended', access_source=NULL, override_reason=NULL,
    override_created_by=NULL, override_created_at=NULL, override_expires_at=NULL, updated_at=NOW() WHERE id = p_business_id;
  v_new := public._biz_billing_state(p_business_id);
  INSERT INTO public.subscription_admin_actions(actor_user_id, business_id, action, previous_state, new_state, reason, request_id)
  VALUES (v_actor, p_business_id, 'revoke_legacy', v_prev, v_new, v_reason, p_request_id);
  RETURN jsonb_build_object('ok', true, 'business_id', p_business_id, 'status', 'suspended');
END; $$;


ALTER FUNCTION "public"."admin_revoke_legacy_access"("p_business_id" "uuid", "p_reason" "text", "p_request_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_revoke_role"("p_user_id" "uuid", "p_reason" "text", "p_request_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE v_actor uuid := public._require_platform_admin('super_admin'); v_reason text := public._require_reason(p_reason);
BEGIN
  IF p_user_id = v_actor THEN RAISE EXCEPTION 'A super_admin cannot revoke their own access' USING ERRCODE = '22023'; END IF;
  UPDATE public.system_admins SET is_active = FALSE, revoked_at = NOW(), revoked_by = v_actor WHERE user_id = p_user_id;
  INSERT INTO public.subscription_admin_actions(actor_user_id, business_id, action, previous_state, new_state, reason, request_id)
  VALUES (v_actor, NULL, 'revoke_role', jsonb_build_object('user_id', p_user_id), NULL, v_reason, p_request_id);
  RETURN jsonb_build_object('ok', true, 'user_id', p_user_id, 'revoked', true);
END; $$;


ALTER FUNCTION "public"."admin_revoke_role"("p_user_id" "uuid", "p_reason" "text", "p_request_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_suspend_subscription"("p_business_id" "uuid", "p_reason" "text", "p_request_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE v_actor uuid := public._require_platform_admin('billing_admin'); v_reason text := public._require_reason(p_reason); v_prev jsonb; v_new jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.businesses WHERE id = p_business_id) THEN RAISE EXCEPTION 'Business not found' USING ERRCODE = 'P0002'; END IF;
  v_prev := public._biz_billing_state(p_business_id);
  UPDATE public.businesses SET subscription_status='suspended', updated_at=NOW() WHERE id = p_business_id;
  v_new := public._biz_billing_state(p_business_id);
  INSERT INTO public.subscription_admin_actions(actor_user_id, business_id, action, previous_state, new_state, reason, request_id)
  VALUES (v_actor, p_business_id, 'suspend', v_prev, v_new, v_reason, p_request_id);
  RETURN jsonb_build_object('ok', true, 'business_id', p_business_id, 'status', 'suspended');
END; $$;


ALTER FUNCTION "public"."admin_suspend_subscription"("p_business_id" "uuid", "p_reason" "text", "p_request_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."backfill_remito_fm"("p_remito_ids" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_rec       RECORD;
  v_created   INTEGER := 0;
  v_skipped   INTEGER := 0;
  v_errors    TEXT[]  := '{}';
BEGIN
  FOR v_rec IN
    SELECT
      c.id                                              AS comp_id,
      c.business_id,
      COALESCE(c.numero, c.id::TEXT)                   AS numero,
      cp.id                                             AS payment_id,
      cp.amount_ars,
      cp.payment_method,
      cp.date                                           AS payment_date,
      cp.created_by
    FROM comprobantes c
    JOIN comprobante_payments cp ON cp.comprobante_id = c.id
    WHERE c.id = ANY(p_remito_ids)
      AND c.tipo = 'remito'
      -- Guard idempotente: solo si NO hay FM para este comprobante
      AND NOT EXISTS (
        SELECT 1 FROM financial_movements fm
        WHERE fm.comprobante_id = c.id
      )
  LOOP
    -- Validar que el business_id del remito existe
    IF NOT EXISTS (SELECT 1 FROM businesses WHERE id = v_rec.business_id) THEN
      v_errors := v_errors || ('negocio no encontrado para ' || v_rec.comp_id::TEXT);
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    INSERT INTO financial_movements (
      business_id,
      date,
      type,
      currency,
      amount,
      exchange_rate,
      amount_ars,
      source,
      comprobante_id,
      description,
      created_by,
      sign,
      metodo_pago
    ) VALUES (
      v_rec.business_id,
      v_rec.payment_date,
      'income',
      'ARS',
      v_rec.amount_ars,
      1,
      v_rec.amount_ars,
      'comprobante',
      v_rec.comp_id,
      'Cobro remito #' || v_rec.numero,
      v_rec.created_by,
      1,
      CASE v_rec.payment_method
        WHEN 'transferencia'  THEN 'transferencia'
        WHEN 'tarjeta_debito' THEN 'tarjeta'
        WHEN 'tarjeta_credito'THEN 'tarjeta'
        WHEN 'qr'             THEN 'tarjeta'
        WHEN 'efectivo'       THEN 'efectivo'
        ELSE                       'efectivo'
      END
    );

    v_created := v_created + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'created', v_created,
    'skipped', v_skipped,
    'errors',  v_errors
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."backfill_remito_fm"("p_remito_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."bootstrap_owner_profile"("p_user_email" "text", "p_business_name" "text", "p_full_name" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user_id UUID;
  v_profile_id UUID;
  v_business_id UUID;
BEGIN
  SELECT id
  INTO v_user_id
  FROM auth.users u
  WHERE lower(u.email) = lower(trim(p_user_email))
  LIMIT 1;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No existe un usuario autenticado con ese email: %', p_user_email;
  END IF;

  SELECT
    p.id,
    p.business_id
  INTO v_profile_id, v_business_id
  FROM public.profiles p
  WHERE COALESCE(p.user_id, p.id) = v_user_id
     OR lower(COALESCE(p.email, '')) = lower(trim(p_user_email))
  ORDER BY
    (p.business_id IS NOT NULL) DESC,
    COALESCE(p.updated_at, p.created_at, NOW()) DESC
  LIMIT 1;

  IF v_business_id IS NULL THEN
    INSERT INTO public.businesses (name, owner_user_id)
    VALUES (trim(p_business_name), v_user_id)
    RETURNING id INTO v_business_id;
  END IF;

  IF v_profile_id IS NULL THEN
    INSERT INTO public.profiles (
      user_id,
      business_id,
      role,
      is_active,
      full_name,
      email
    )
    VALUES (
      v_user_id,
      v_business_id,
      'owner',
      TRUE,
      NULLIF(trim(p_full_name), ''),
      lower(trim(p_user_email))
    );
  ELSE
    UPDATE public.profiles
    SET user_id = COALESCE(user_id, v_user_id),
        business_id = v_business_id,
        role = 'owner',
        is_active = TRUE,
        full_name = COALESCE(NULLIF(trim(p_full_name), ''), full_name),
        email = lower(trim(p_user_email)),
        updated_at = NOW()
    WHERE id = v_profile_id;
  END IF;

  DELETE FROM public.profiles
  WHERE id <> v_profile_id
    AND (
      COALESCE(user_id, id) = v_user_id
      OR lower(COALESCE(email, '')) = lower(trim(p_user_email))
    );

  UPDATE public.businesses
  SET owner_user_id = COALESCE(owner_user_id, v_user_id),
      updated_at = NOW()
  WHERE id = v_business_id;

  RETURN v_business_id;
END;
$$;


ALTER FUNCTION "public"."bootstrap_owner_profile"("p_user_email" "text", "p_business_name" "text", "p_full_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."business_has_feature"("p_feature" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM businesses b
    WHERE b.id = current_user_business_id()
      AND b.subscription_status IN ('active', 'trialing')
      AND CASE p_feature
            WHEN 'arca'            THEN b.subscription_plan IN ('pro','full')
                                     OR b.subscription_status = 'trialing'
            WHEN 'currentAccounts' THEN b.subscription_plan IN ('pro','full')
                                     OR b.subscription_status = 'trialing'
            WHEN 'tasks'           THEN b.subscription_plan IN ('pro','full')
                                     OR b.subscription_status = 'trialing'
            WHEN 'advancedFinance' THEN b.subscription_plan IN ('pro','full')
                                     OR b.subscription_status = 'trialing'
            WHEN 'reports'         THEN b.subscription_plan IN ('pro','full')
                                     OR b.subscription_status = 'trialing'
            WHEN 'mayorista'       THEN b.subscription_plan = 'full'
            WHEN 'advancedRoles'   THEN b.subscription_plan = 'full'
            WHEN 'audit'           THEN b.subscription_plan = 'full'
            WHEN 'multisucursal'   THEN b.subscription_plan = 'full'
            ELSE true
          END
  );
$$;


ALTER FUNCTION "public"."business_has_feature"("p_feature" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."can_manage"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(
    public.current_user_role() in ('owner', 'admin', 'manager'),
    false
  )
$$;


ALTER FUNCTION "public"."can_manage"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."business_invitations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "role" "text" DEFAULT 'tech'::"text" NOT NULL,
    "invited_by" "uuid" NOT NULL,
    "token" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '7 days'::interval) NOT NULL,
    "accepted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "business_invitations_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'admin'::"text", 'manager'::"text", 'tech'::"text", 'sales'::"text", 'cashier'::"text", 'viewer'::"text"]))),
    CONSTRAINT "business_invitations_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'cancelled'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."business_invitations" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cancel_business_invitation"("p_invitation_id" "uuid") RETURNS "public"."business_invitations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_invite public.business_invitations;
begin
  if auth.uid() is null then
    raise exception 'Usuario no autenticado';
  end if;

  if not public.is_owner_or_admin() then
    raise exception 'No tenés permisos para cancelar invitaciones';
  end if;

  update public.business_invitations
  set
    status = 'cancelled',
    updated_at = now()
  where id = p_invitation_id
    and business_id = public.current_business_id()
  returning * into v_invite;

  if v_invite.id is null then
    raise exception 'Invitación no encontrada';
  end if;

  return v_invite;
end;
$$;


ALTER FUNCTION "public"."cancel_business_invitation"("p_invitation_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."change_user_role"("p_profile_id" "uuid", "p_new_role" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_business_id uuid;
  v_current_role text;
  v_target_user_id uuid;
begin
  select
    business_id,
    role,
    coalesce(user_id, id)
  into v_business_id, v_current_role, v_target_user_id
  from public.profiles
  where id = p_profile_id;

  if v_business_id is null then
    raise exception 'Perfil no encontrado';
  end if;

  if lower(trim(p_new_role)) = 'owner' then
    raise exception 'El rol owner solo se asigna al crear el negocio';
  end if;

  if v_current_role = 'owner' then
    raise exception 'No se puede cambiar el rol del owner';
  end if;

  if v_target_user_id = auth.uid() then
    raise exception 'No podes cambiar tu propio rol';
  end if;

  if not exists (
    select 1
    from public.profiles p
    where coalesce(p.user_id, p.id) = auth.uid()
      and p.business_id = v_business_id
      and p.is_active = true
      and p.role in ('owner', 'admin')
  ) then
    raise exception 'No tenes permisos para cambiar roles';
  end if;

  update public.profiles
  set role = lower(trim(p_new_role)),
      updated_at = now()
  where id = p_profile_id;
end;
$$;


ALTER FUNCTION "public"."change_user_role"("p_profile_id" "uuid", "p_new_role" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_user_limit_before_invite"("p_business_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_active_count int;
  v_max_users    int;
  v_plan         text;
  v_status       text;
BEGIN
  SELECT subscription_plan, subscription_status
  INTO   v_plan, v_status
  FROM   businesses WHERE id = p_business_id;

  v_max_users := CASE
    WHEN v_status = 'trialing'     THEN 3
    WHEN v_plan   = 'full'         THEN 10
    WHEN v_plan   = 'pro'          THEN 3
    ELSE 1
  END;

  SELECT COUNT(*) INTO v_active_count
  FROM   profiles
  WHERE  business_id = p_business_id AND is_active = true;

  IF v_active_count >= v_max_users THEN
    RETURN 'LIMIT_REACHED:' || v_active_count || ':' || v_max_users || ':' || COALESCE(v_plan,'basico');
  END IF;

  RETURN 'OK';
END;
$$;


ALTER FUNCTION "public"."check_user_limit_before_invite"("p_business_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_business_invitation"("p_email" "text", "p_role" "text" DEFAULT 'tech'::"text") RETURNS "public"."business_invitations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_business_id uuid;
  v_user_id uuid;
  v_existing public.business_invitations;
  v_token text;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  if not public.is_owner_or_admin() then
    raise exception 'No tenés permisos para invitar usuarios';
  end if;

  if p_role not in ('admin', 'manager', 'tech', 'sales', 'cashier', 'viewer') then
    raise exception 'Rol inválido';
  end if;

  v_business_id := public.current_business_id();

  if v_business_id is null then
    raise exception 'No se encontró business_id para el usuario actual';
  end if;

  select *
  into v_existing
  from public.business_invitations
  where business_id = v_business_id
    and lower(email) = lower(trim(p_email))
    and status = 'pending'
    and expires_at > now()
  order by created_at desc
  limit 1;

  if v_existing.id is not null then
    return v_existing;
  end if;

  v_token := encode(gen_random_bytes(24), 'hex');

  insert into public.business_invitations (
    business_id,
    email,
    role,
    invited_by,
    token,
    status
  )
  values (
    v_business_id,
    lower(trim(p_email)),
    p_role,
    v_user_id,
    v_token,
    'pending'
  )
  returning * into v_existing;

  return v_existing;
end;
$$;


ALTER FUNCTION "public"."create_business_invitation"("p_email" "text", "p_role" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_business_invitation"("p_email" "text", "p_role" "text", "p_business_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_token text;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  if lower(trim(p_role)) = 'owner' then
    raise exception 'No se pueden enviar invitaciones con rol owner';
  end if;

  if not exists (
    select 1
    from public.profiles p
    where coalesce(p.user_id, p.id) = auth.uid()
      and p.business_id = p_business_id
      and p.is_active = true
      and p.role in ('owner', 'admin')
  ) then
    raise exception 'No tenes permisos para invitar usuarios a este negocio';
  end if;

  v_token := encode(gen_random_bytes(24), 'hex');

  insert into public.business_invitations (
    business_id,
    email,
    role,
    token,
    invited_by
  )
  values (
    p_business_id,
    lower(trim(p_email)),
    lower(trim(p_role)),
    v_token,
    auth.uid()
  );

  return v_token;
end;
$$;


ALTER FUNCTION "public"."create_business_invitation"("p_email" "text", "p_role" "text", "p_business_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_credit_note_finance_reversal"("p_nc_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_nc              comprobantes%ROWTYPE;
  v_business_id     UUID;
  v_has_access      BOOLEAN := FALSE;
  v_total           NUMERIC;
  v_numero          TEXT;
  v_orig_numero     TEXT;
  v_today           DATE := CURRENT_DATE;
  v_existing_fm     UUID;
  v_existing_bfe    UUID;
BEGIN
  -- ── 1. Obtener datos de la NC ──────────────────────────────────────────────
  SELECT * INTO v_nc FROM comprobantes WHERE id = p_nc_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'NC no encontrada');
  END IF;
  v_business_id := v_nc.business_id;

  -- ── 2. Verificar acceso ────────────────────────────────────────────────────
  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id = v_business_id AND owner_user_id = auth.uid())
    OR
    EXISTS (SELECT 1 FROM profiles   WHERE business_id = v_business_id AND user_id = auth.uid())
  ) INTO v_has_access;
  IF NOT v_has_access THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al negocio');
  END IF;

  -- ── 3. Validar que la NC esté emitida ──────────────────────────────────────
  IF v_nc.estado_fiscal IS DISTINCT FROM 'emitido' THEN
    RETURN jsonb_build_object('success', false,
      'error', 'La NC debe estar emitida antes de crear la reversa financiera');
  END IF;

  IF v_nc.comprobante_original_id IS NULL THEN
    RETURN jsonb_build_object('success', false,
      'error', 'La NC no tiene comprobante original asociado');
  END IF;

  -- ── 4. Datos de la reversa ─────────────────────────────────────────────────
  v_total   := COALESCE(v_nc.total_bruto, v_nc.total_ars, v_nc.total, 0);
  v_numero  := COALESCE(v_nc.numero_fiscal, v_nc.numero, p_nc_id::TEXT);

  SELECT COALESCE(numero_fiscal, numero, id::TEXT)
  INTO v_orig_numero
  FROM comprobantes
  WHERE id = v_nc.comprobante_original_id;

  -- ── 5. Idempotencia: financial_movements ──────────────────────────────────
  SELECT id INTO v_existing_fm
  FROM financial_movements
  WHERE comprobante_id = p_nc_id
    AND business_id    = v_business_id
    AND sign           = -1
  LIMIT 1;

  IF v_existing_fm IS NULL THEN
    INSERT INTO financial_movements (
      business_id, date, type, currency, amount, exchange_rate, amount_ars,
      source, comprobante_id, description, created_by, sign, metodo_pago
    ) VALUES (
      v_business_id, v_today, 'expense',
      COALESCE(v_nc.currency, 'ARS'), v_total, COALESCE(v_nc.exchange_rate, 1), v_total,
      'comprobante', p_nc_id,
      'NOTA DE CRÉDITO #' || v_numero || ' — anula ' || COALESCE(v_orig_numero, ''),
      auth.uid(), -1, NULL
    );
  END IF;

  -- ── 6. Idempotencia: business_finance_entries ─────────────────────────────
  SELECT id INTO v_existing_bfe
  FROM business_finance_entries
  WHERE reference_comprobante_id = p_nc_id
    AND business_id              = v_business_id
    AND amount                   < 0
  LIMIT 1;

  IF v_existing_bfe IS NULL THEN
    INSERT INTO business_finance_entries (
      business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate,
      reference_comprobante_id, source, created_by
    ) VALUES (
      v_business_id, v_today, 'income', 'ventas_productos',
      'NOTA DE CRÉDITO #' || v_numero || ' — anula ' || COALESCE(v_orig_numero, ''),
      -v_total, COALESCE(v_nc.currency, 'ARS'), -v_total, COALESCE(v_nc.exchange_rate, 1),
      p_nc_id, 'comprobante', auth.uid()
    );
  END IF;

  RETURN jsonb_build_object(
    'success',      true,
    'fm_created',   v_existing_fm IS NULL,
    'bfe_created',  v_existing_bfe IS NULL
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."create_credit_note_finance_reversal"("p_nc_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_credit_note_from_comprobante"("p_comprobante_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_comp            comprobantes%ROWTYPE;
  v_business_id     UUID;
  v_has_access      BOOLEAN := FALSE;
  v_existing_nc_id  UUID;
  v_nc_tipo_fiscal  INTEGER;
  v_nc_id           UUID;
  v_today           DATE := CURRENT_DATE;
BEGIN
  -- ── 1. Obtener comprobante original ───────────────────────────────────────
  SELECT * INTO v_comp FROM comprobantes WHERE id = p_comprobante_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Comprobante no encontrado');
  END IF;
  v_business_id := v_comp.business_id;

  -- ── 2. Verificar acceso ────────────────────────────────────────────────────
  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id = v_business_id AND owner_user_id = auth.uid())
    OR
    EXISTS (SELECT 1 FROM profiles   WHERE business_id = v_business_id AND user_id = auth.uid())
  ) INTO v_has_access;
  IF NOT v_has_access THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al negocio');
  END IF;

  -- ── 3. Validar estado fiscal ───────────────────────────────────────────────
  IF v_comp.estado_fiscal IS DISTINCT FROM 'emitido' OR v_comp.cae IS NULL THEN
    RETURN jsonb_build_object('success', false,
      'error', 'Solo se puede generar NC sobre comprobantes emitidos en ARCA');
  END IF;

  -- ── 4. Bloquear doble anulación ────────────────────────────────────────────
  IF v_comp.estado IN ('anulado') OR v_comp.estado_comercial = 'anulado' THEN
    RETURN jsonb_build_object('success', false,
      'error', 'El comprobante ya fue anulado');
  END IF;

  -- ── 5. Verificar que no existe NC activa para este comprobante ─────────────
  SELECT id INTO v_existing_nc_id
  FROM comprobantes
  WHERE comprobante_original_id = p_comprobante_id
    AND estado_fiscal NOT IN ('anulado_fiscal', 'error_emision')
    AND estado NOT IN ('anulado')
  LIMIT 1;
  IF v_existing_nc_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Ya existe una Nota de Crédito para este comprobante',
      'nc_id', v_existing_nc_id
    );
  END IF;

  -- ── 6. Determinar tipo fiscal de la NC ─────────────────────────────────────
  -- Factura A (1) → NC-A (3)  |  Factura B (6) → NC-B (8)
  -- Factura C (11) → NC-C (13) — más común en TechRepair
  v_nc_tipo_fiscal := CASE COALESCE(v_comp.tipo_comprobante_fiscal, '11')::INTEGER
    WHEN  1 THEN  3
    WHEN  6 THEN  8
    WHEN 11 THEN 13
    ELSE         13   -- default NC-C
  END;

  -- ── 7. Crear NC en estado pendiente_emision ────────────────────────────────
  INSERT INTO comprobantes (
    id, business_id, customer_id, order_id,
    tipo, type, fecha, date,
    subtotal, impuestos, tax, total, total_ars, total_usd,
    currency, exchange_rate,
    estado, status, estado_comercial, estado_fiscal,
    es_fiscal, emitir_en_arca,
    tipo_comprobante_fiscal,
    condicion_fiscal, observaciones,
    descuento_total, recargo_total,
    total_bruto, saldo_pendiente, total_cobrado,
    comprobante_original_id,
    created_by
  ) VALUES (
    gen_random_uuid(),
    v_business_id, v_comp.customer_id, v_comp.order_id,
    'nota_credito', 'nota_credito',
    NOW(), NOW(),
    v_comp.subtotal, v_comp.impuestos, COALESCE(v_comp.tax, 0),
    v_comp.total,    v_comp.total_ars, v_comp.total_usd,
    COALESCE(v_comp.currency, 'ARS'), COALESCE(v_comp.exchange_rate, 1),
    'borrador', 'draft', 'pendiente', 'pendiente_emision',
    TRUE, TRUE,
    v_nc_tipo_fiscal::TEXT,
    v_comp.condicion_fiscal,
    'Nota de Crédito — anula comprobante #' || COALESCE(v_comp.numero_fiscal, v_comp.numero, v_comp.id::TEXT),
    COALESCE(v_comp.descuento_total, 0),
    COALESCE(v_comp.recargo_total, 0),
    COALESCE(v_comp.total_bruto, v_comp.total, 0),
    0, 0,
    p_comprobante_id,
    auth.uid()
  )
  RETURNING id INTO v_nc_id;

  -- ── 8. Copiar ítems del original (sin descuento de stock) ──────────────────
  INSERT INTO comprobante_items (
    id, comprobante_id, business_id, created_by,
    descripcion, tipo_linea,
    cantidad, precio_unitario, descuento_linea, subtotal,
    costo_unitario, costo_total,
    currency, exchange_rate, inventory_id, orden
  )
  SELECT
    gen_random_uuid(), v_nc_id, v_business_id, auth.uid(),
    'NC: ' || descripcion, tipo_linea,
    cantidad, precio_unitario, descuento_linea, subtotal,
    0, 0,                    -- NC no tiene costo de mercadería
    currency, exchange_rate,
    NULL,                    -- NC no descuenta stock
    orden
  FROM comprobante_items
  WHERE comprobante_id = p_comprobante_id;

  -- ── 9. Retornar NC creada ──────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'success',          true,
    'nc_id',            v_nc_id,
    'nc_tipo_fiscal',   v_nc_tipo_fiscal,
    'original_numero',  COALESCE(v_comp.numero_fiscal, v_comp.numero),
    'total',            v_comp.total
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."create_credit_note_from_comprobante"("p_comprobante_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_default_payment_buttons"("p_business_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO public.payment_method_buttons
    (business_id, name, code, payment_type, provider, channel, integration_kind,
     fee_percent, fee_fixed, color, icon, sort_order)
  VALUES
    (p_business_id, 'Efectivo',        'cash',           'cash',     'manual',      'manual', 'none', 0,      0,    '#34d399', 'banknote',    1),
    (p_business_id, 'Transferencia',   'transfer',       'transfer', 'manual',      'manual', 'none', 0,      0,    '#60a5fa', 'send',        2),
    (p_business_id, 'Débito (MP)',     'mp_debit',       'debit',    'mercadopago', 'manual', 'none', 0.0089, 0,    '#818cf8', 'credit-card', 3),
    (p_business_id, 'Crédito 1C (MP)','mp_credit_1',    'credit',   'mercadopago', 'manual', 'none', 0.0399, 0,    '#f59e0b', 'credit-card', 4),
    (p_business_id, 'QR (MP)',         'mp_qr',          'qr',       'mercadopago', 'manual', 'none', 0.0099, 0,    '#a78bfa', 'qr-code',     5),
    (p_business_id, 'Link de pago',    'mp_checkout',    'wallet',   'mercadopago', 'manual', 'none', 0.0399, 0,    '#6366f1', 'link',        6)
  ON CONFLICT (business_id, code) DO NOTHING;
END;
$$;


ALTER FUNCTION "public"."create_default_payment_buttons"("p_business_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_expense_with_finance"("p_business_id" "uuid", "p_user_id" "uuid", "p_description" "text", "p_category" "text", "p_category_key" "text", "p_finance_type" "text", "p_amount" numeric, "p_payment_method" "text", "p_date" "date", "p_is_recurring" boolean DEFAULT false, "p_frequency" "text" DEFAULT NULL::"text", "p_notes" "text" DEFAULT NULL::"text", "p_caja_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_bfe_id  uuid;
  v_exp_id  uuid;
  v_fm_id   uuid;
BEGIN
  -- Validaciones de entrada
  IF p_business_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'business_id requerido');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El monto debe ser mayor a 0');
  END IF;
  IF p_description IS NULL OR trim(p_description) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'La descripcion es obligatoria');
  END IF;

  -- 1. business_finance_entries — registro para el panel Finanzas
  INSERT INTO business_finance_entries (
    business_id, date, type, category, description,
    amount, currency, amount_ars, exchange_rate,
    payment_method, source, created_by
  ) VALUES (
    p_business_id, p_date, p_finance_type, p_category_key, p_description,
    p_amount, 'ARS', p_amount, 1,
    p_payment_method, 'expense', p_user_id
  ) RETURNING id INTO v_bfe_id;

  -- 2. expenses — registro para el módulo Gastos
  INSERT INTO expenses (
    description, category, amount, amount_ars, date,
    business_id, payment_method, currency, exchange_rate,
    is_recurring, frequency, notes, finance_entry_id,
    created_by, tipo
  ) VALUES (
    p_description, p_category, p_amount, p_amount, p_date,
    p_business_id, p_payment_method, 'ARS', 1,
    COALESCE(p_is_recurring, false), p_frequency, p_notes, v_bfe_id,
    p_user_id, 'general'
  ) RETURNING id INTO v_exp_id;

  -- 3. financial_movements — movimiento de caja
  INSERT INTO financial_movements (
    business_id, date, type, currency, amount, amount_ars,
    exchange_rate, description, source, reference_id,
    created_by, caja_id, metodo_pago
  ) VALUES (
    p_business_id, p_date, 'expense', 'ARS', p_amount, p_amount,
    1, p_description, 'expense', v_bfe_id,
    p_user_id, p_caja_id, p_payment_method
  ) RETURNING id INTO v_fm_id;

  RETURN jsonb_build_object(
    'ok',         true,
    'bfe_id',     v_bfe_id,
    'expense_id', v_exp_id,
    'fm_id',      v_fm_id
  );

EXCEPTION WHEN OTHERS THEN
  -- Cualquier fallo hace rollback automático de los 3 inserts
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."create_expense_with_finance"("p_business_id" "uuid", "p_user_id" "uuid", "p_description" "text", "p_category" "text", "p_category_key" "text", "p_finance_type" "text", "p_amount" numeric, "p_payment_method" "text", "p_date" "date", "p_is_recurring" boolean, "p_frequency" "text", "p_notes" "text", "p_caja_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_owner_withdrawal"("p_business_id" "uuid", "p_amount" numeric, "p_date" "date", "p_account_id" "uuid", "p_notes" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user_id       uuid := auth.uid();
  v_tx_id         uuid;
  v_fm_id         uuid;
  v_wd_id         uuid;
BEGIN
  -- Validaciones básicas
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'El monto debe ser mayor a cero';
  END IF;

  -- Verificar que la cuenta personal pertenece al usuario
  IF NOT EXISTS (
    SELECT 1 FROM personal_accounts
    WHERE id = p_account_id AND user_id = v_user_id AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Cuenta personal no encontrada o no activa';
  END IF;

  -- 1. Crear personal_transaction (ingreso)
  INSERT INTO personal_transactions (
    user_id, account_id, type, amount, currency,
    date, description, notes
  ) VALUES (
    v_user_id, p_account_id, 'income', p_amount, 'ARS',
    p_date, 'Retiro del negocio', p_notes
  ) RETURNING id INTO v_tx_id;

  -- 2. Actualizar saldo de la cuenta personal
  UPDATE personal_accounts
  SET current_balance = current_balance + p_amount,
      updated_at = now()
  WHERE id = p_account_id AND user_id = v_user_id;

  -- 3. Registrar egreso en finanzas del negocio
  INSERT INTO financial_movements (
    business_id, type, amount, amount_ars, currency, exchange_rate,
    source, source_id, description, date, created_by,
    reference_type, sign, movement_type
  ) VALUES (
    p_business_id, 'expense', p_amount, p_amount, 'ARS', 1,
    'owner_withdrawal', NULL,
    COALESCE('Retiro propietario' || CASE WHEN p_notes IS NOT NULL THEN ': ' || p_notes ELSE '' END, 'Retiro propietario'),
    p_date, v_user_id,
    'owner_withdrawal', 1, 'income'
  ) RETURNING id INTO v_fm_id;

  -- 4. Crear owner_withdrawals (vínculo)
  INSERT INTO owner_withdrawals (
    business_id, user_id, amount, currency, date,
    business_financial_movement_id, personal_transaction_id,
    destination_account_id, notes, status
  ) VALUES (
    p_business_id, v_user_id, p_amount, 'ARS', p_date,
    v_fm_id, v_tx_id,
    p_account_id, p_notes, 'completed'
  ) RETURNING id INTO v_wd_id;

  -- Actualizar source_id del financial_movement con el withdrawal id
  UPDATE financial_movements SET source_id = v_wd_id WHERE id = v_fm_id;

  RETURN jsonb_build_object(
    'ok', true,
    'withdrawal_id', v_wd_id,
    'personal_tx_id', v_tx_id,
    'business_fm_id', v_fm_id
  );

EXCEPTION WHEN OTHERS THEN
  -- La transacción se revierte automáticamente
  RETURN jsonb_build_object(
    'ok', false,
    'error', SQLERRM
  );
END;
$$;


ALTER FUNCTION "public"."create_owner_withdrawal"("p_business_id" "uuid", "p_amount" numeric, "p_date" "date", "p_account_id" "uuid", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_supplier_purchase_atomic"("p_business_id" "uuid", "p_supplier_id" "uuid", "p_user_id" "uuid", "p_supplier_name" "text", "p_purchase_date" "date", "p_invoice_number" "text", "p_total_amount" numeric, "p_paid_amount" numeric, "p_payment_method" "text", "p_notes" "text", "p_items" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_pending  numeric;
  v_status   text;
  v_purchase record;
  v_item     jsonb;
  v_payment  record;
  v_fm       record;
  v_prev_stk integer;
  v_new_stk  integer;
  v_inv_num  text;
  v_desc_sfx text;
BEGIN
  IF p_total_amount IS NULL OR p_total_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'total_amount debe ser mayor a 0');
  END IF;

  v_inv_num  := NULLIF(trim(COALESCE(p_invoice_number, '')), '');
  v_desc_sfx := COALESCE(' #' || v_inv_num, '');

  v_pending := GREATEST(0, p_total_amount - COALESCE(p_paid_amount, 0));
  IF COALESCE(p_paid_amount, 0) <= 0            THEN v_status := 'pending';
  ELSIF p_paid_amount >= p_total_amount - 0.01  THEN v_status := 'paid';
  ELSE v_status := 'partial';
  END IF;

  -- 1. Purchase header
  INSERT INTO public.supplier_purchases (
    business_id, supplier_id, purchase_date, invoice_number,
    total_amount, paid_amount, pending_amount, payment_status,
    payment_method, notes, created_by
  ) VALUES (
    p_business_id, p_supplier_id, p_purchase_date, v_inv_num,
    p_total_amount, COALESCE(p_paid_amount, 0), v_pending, v_status,
    NULLIF(trim(COALESCE(p_payment_method, '')), ''),
    NULLIF(trim(COALESCE(p_notes, '')), ''),
    p_user_id
  ) RETURNING * INTO v_purchase;

  -- 2. Items + stock
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    INSERT INTO public.supplier_purchase_items (
      business_id, purchase_id, supplier_id, inventory_id,
      product_name, quantity, unit_cost, subtotal
    ) VALUES (
      p_business_id, v_purchase.id, p_supplier_id,
      NULLIF(trim(COALESCE(v_item->>'inventory_id', '')), '')::uuid,
      v_item->>'product_name',
      (v_item->>'quantity')::numeric,
      (v_item->>'unit_cost')::numeric,
      (v_item->>'quantity')::numeric * (v_item->>'unit_cost')::numeric
    );

    IF (v_item->>'inventory_id') IS NOT NULL AND trim(COALESCE(v_item->>'inventory_id','')) <> '' THEN
      SELECT stock_quantity INTO v_prev_stk
      FROM public.inventory
      WHERE id = (v_item->>'inventory_id')::uuid AND business_id = p_business_id;

      IF FOUND THEN
        v_new_stk := COALESCE(v_prev_stk, 0) + FLOOR((v_item->>'quantity')::numeric)::integer;

        UPDATE public.inventory
           SET stock_quantity = v_new_stk,
               stock          = v_new_stk,
               cost_price     = (v_item->>'unit_cost')::numeric,
               updated_at     = now()
         WHERE id = (v_item->>'inventory_id')::uuid AND business_id = p_business_id;

        INSERT INTO public.inventory_movements (
          inventory_item_id, movement_type, quantity,
          previous_stock, new_stock, reference_type, reference_id,
          note, business_id, created_by, supplier_id,
          unit_cost, currency, exchange_rate
        ) VALUES (
          (v_item->>'inventory_id')::uuid, 'purchase',
          FLOOR((v_item->>'quantity')::numeric)::integer,
          COALESCE(v_prev_stk, 0), v_new_stk,
          'supplier_purchase', v_purchase.id,
          'Compra a ' || p_supplier_name || v_desc_sfx,
          p_business_id, p_user_id, p_supplier_id,
          (v_item->>'unit_cost')::numeric, 'ARS', 1
        );
      END IF;
    END IF;
  END LOOP;

  -- 3. CC debit
  INSERT INTO public.supplier_account_movements (
    business_id, supplier_id, purchase_id, payment_id,
    movement_date, type, description, debit, credit, balance_after
  ) VALUES (
    p_business_id, p_supplier_id, v_purchase.id, NULL,
    p_purchase_date, 'purchase',
    'Compra' || v_desc_sfx,
    p_total_amount, 0, 0
  );

  -- 4. Initial payment (only when paid_amount > 0)
  IF COALESCE(p_paid_amount, 0) > 0 THEN
    INSERT INTO public.financial_movements (
      business_id, date, type, currency, amount, amount_ars, exchange_rate,
      source, description, created_by, metodo_pago,
      sign, reference_id, reference_type
    ) VALUES (
      p_business_id, p_purchase_date, 'expense', 'ARS',
      p_paid_amount, p_paid_amount, 1,
      'pago_proveedor',
      'Compra a ' || p_supplier_name || v_desc_sfx,
      p_user_id,
      NULLIF(trim(COALESCE(p_payment_method, '')), ''),
      1, v_purchase.id, 'supplier_purchase'
    ) RETURNING * INTO v_fm;

    -- variable_cost is the correct type for supplier purchases in business_finance_entries
    INSERT INTO public.business_finance_entries (
      business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate,
      payment_method, created_by, source
    ) VALUES (
      p_business_id, p_purchase_date, 'variable_cost', 'compras_proveedor',
      'Compra a ' || p_supplier_name || v_desc_sfx,
      p_paid_amount, 'ARS', p_paid_amount, 1,
      NULLIF(trim(COALESCE(p_payment_method, '')), ''),
      p_user_id, 'pago_proveedor'
    );

    INSERT INTO public.supplier_payments (
      business_id, supplier_id, purchase_id, payment_date,
      amount, payment_method, notes, created_by, financial_movement_id
    ) VALUES (
      p_business_id, p_supplier_id, v_purchase.id, p_purchase_date,
      p_paid_amount,
      COALESCE(NULLIF(trim(COALESCE(p_payment_method,'')), ''), 'efectivo'),
      'Pago inicial al crear compra' || v_desc_sfx,
      p_user_id, v_fm.id
    ) RETURNING * INTO v_payment;

    INSERT INTO public.supplier_account_movements (
      business_id, supplier_id, purchase_id, payment_id,
      movement_date, type, description, debit, credit, balance_after
    ) VALUES (
      p_business_id, p_supplier_id, v_purchase.id, v_payment.id,
      p_purchase_date, 'payment',
      'Pago inicial compra' || v_desc_sfx,
      0, p_paid_amount, 0
    );
  END IF;

  RETURN jsonb_build_object('ok', true, 'purchase_id', v_purchase.id);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."create_supplier_purchase_atomic"("p_business_id" "uuid", "p_supplier_id" "uuid", "p_user_id" "uuid", "p_supplier_name" "text", "p_purchase_date" "date", "p_invoice_number" "text", "p_total_amount" numeric, "p_paid_amount" numeric, "p_payment_method" "text", "p_notes" "text", "p_items" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_business_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select business_id
  from public.profiles
  where id = auth.uid()
  limit 1
$$;


ALTER FUNCTION "public"."current_business_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_platform_admin_role"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  SELECT sa.role
  FROM public.system_admins sa
  WHERE sa.user_id = auth.uid() AND sa.is_active = TRUE
  LIMIT 1;
$$;


ALTER FUNCTION "public"."current_platform_admin_role"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_user_business_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT p.business_id
  FROM public.profiles p
  WHERE COALESCE(p.user_id, p.id) = auth.uid()
    AND COALESCE(p.is_active, TRUE) = TRUE
  ORDER BY
    (p.business_id IS NOT NULL) DESC,
    COALESCE(p.updated_at, p.created_at, NOW()) DESC
  LIMIT 1
$$;


ALTER FUNCTION "public"."current_user_business_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_user_role"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT p.role
  FROM public.profiles p
  WHERE COALESCE(p.user_id, p.id) = auth.uid()
    AND COALESCE(p.is_active, TRUE) = TRUE
  ORDER BY
    COALESCE(p.updated_at, p.created_at, NOW()) DESC
  LIMIT 1
$$;


ALTER FUNCTION "public"."current_user_role"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."customer_purchase_history"("p_customer_id" "uuid", "p_business_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_has_access  BOOLEAN := FALSE;
  v_customer    JSONB;
  v_summary     JSONB;
  v_purchases   JSONB;
BEGIN
  -- ── 1. Validar acceso al negocio ────────────────────────────────────────────
  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id = p_business_id AND owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id = p_business_id AND user_id = auth.uid())
  ) INTO v_has_access;
  IF NOT v_has_access THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso al negocio');
  END IF;

  -- ── 2. Validar que el cliente pertenece al negocio ──────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM customers WHERE id = p_customer_id AND business_id = p_business_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Cliente no encontrado en este negocio');
  END IF;

  -- ── 3. Datos del cliente ────────────────────────────────────────────────────
  SELECT jsonb_build_object(
    'id',    id,
    'name',  name,
    'phone', phone,
    'email', email
  ) INTO v_customer
  FROM customers
  WHERE id = p_customer_id AND business_id = p_business_id;

  -- ── 4. Resumen financiero ────────────────────────────────────────────────────
  SELECT jsonb_build_object(
    'total_purchases',    COUNT(*) FILTER (WHERE tipo != 'nota_credito'),
    'total_spent',        COALESCE(SUM(total) FILTER (WHERE tipo != 'nota_credito'), 0),
    'total_refunded',     COALESCE(SUM(total) FILTER (WHERE tipo = 'nota_credito'), 0),
    'net_spent',          COALESCE(SUM(total) FILTER (WHERE tipo != 'nota_credito'), 0)
                          - COALESCE(SUM(total) FILTER (WHERE tipo = 'nota_credito'), 0),
    'pending_balance',    COALESCE(SUM(saldo_pendiente) FILTER (WHERE tipo != 'nota_credito' AND estado NOT IN ('anulado')), 0),
    'last_purchase_at',   MAX(COALESCE(fecha, created_at)::date) FILTER (WHERE tipo != 'nota_credito')
  ) INTO v_summary
  FROM comprobantes
  WHERE customer_id = p_customer_id
    AND business_id = p_business_id
    AND estado NOT IN ('anulado', 'cancelled')
    AND COALESCE(estado_comercial, '') != 'anulado';

  -- ── 5. Lista de compras con ítems y métodos de pago ─────────────────────────
  SELECT COALESCE(jsonb_agg(purchase ORDER BY purchase_date DESC), '[]'::JSONB)
  INTO v_purchases
  FROM (
    SELECT jsonb_build_object(
      'id',                      c.id,
      'date',                    COALESCE(c.fecha, c.date, c.created_at)::date,
      'created_at',              c.created_at,
      'tipo',                    c.tipo,
      'numero',                  COALESCE(c.numero_fiscal, c.numero, c.number),
      'numero_local',            COALESCE(c.numero, c.number),
      'numero_fiscal',           c.numero_fiscal,
      'cae',                     c.cae,
      'estado',                  COALESCE(c.estado, c.status),
      'estado_fiscal',           c.estado_fiscal,
      'estado_comercial',        COALESCE(c.estado_comercial, 'pendiente'),
      'emitido_arca',            (c.cae IS NOT NULL AND c.estado_fiscal = 'emitido'),
      'total',                   c.total,
      'total_cobrado',           COALESCE(c.total_cobrado, 0),
      'saldo_pendiente',         COALESCE(c.saldo_pendiente, 0),
      'order_id',                c.order_id,
      'comprobante_original_id', c.comprobante_original_id,
      'is_credit_note',          (c.tipo = 'nota_credito'),
      'observaciones',           c.observaciones,
      -- Métodos de pago como array (hasta 3)
      'payment_methods',         COALESCE((
        SELECT jsonb_agg(DISTINCT cp.payment_method)
        FROM comprobante_payments cp
        WHERE cp.comprobante_id = c.id
        LIMIT 3
      ), '[]'::JSONB),
      -- Ítems resumidos (hasta 20 por comprobante)
      'items', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id',             ci.id,
            'descripcion',    ci.descripcion,
            'tipo_linea',     ci.tipo_linea,
            'cantidad',       ci.cantidad,
            'precio_unitario',ci.precio_unitario,
            'subtotal',       ci.subtotal
          )
          ORDER BY ci.orden NULLS LAST
        )
        FROM (
          SELECT * FROM comprobante_items
          WHERE comprobante_id = c.id
          ORDER BY COALESCE(orden, 0)
          LIMIT 20
        ) ci
      ), '[]'::JSONB)
    ) AS purchase,
    COALESCE(c.fecha, c.date, c.created_at) AS purchase_date
    FROM comprobantes c
    WHERE c.customer_id  = p_customer_id
      AND c.business_id  = p_business_id
      AND c.estado       NOT IN ('anulado', 'cancelled')
      AND COALESCE(c.estado_comercial, '') != 'anulado'
    ORDER BY COALESCE(c.fecha, c.date, c.created_at) DESC
    LIMIT 300
  ) t;

  RETURN jsonb_build_object(
    'ok',        true,
    'customer',  v_customer,
    'summary',   v_summary,
    'purchases', v_purchases
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."customer_purchase_history"("p_customer_id" "uuid", "p_business_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."decrypt_data"("encrypted_data" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  encrypted_bytes BYTEA;
  decrypted_text TEXT;
BEGIN
  encrypted_bytes := decode(encrypted_data, 'base64');
  decrypted_text := pgp_sym_decrypt(encrypted_bytes, 'techrepair_encryption_key_2024');
  RETURN decrypted_text;
END;
$$;


ALTER FUNCTION "public"."decrypt_data"("encrypted_data" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_comprobante_with_finance"("p_comprobante_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_business_id    UUID;
  v_estado_fiscal  TEXT;
  v_cae            TEXT;
  v_numero_fiscal  TEXT;
  v_has_access     BOOLEAN := FALSE;
  v_del_fm         INTEGER := 0;
  v_upd_fm         INTEGER := 0;
  v_del_bfe        INTEGER := 0;
  v_del_payments   INTEGER := 0;
  v_del_items      INTEGER := 0;
BEGIN
  -- ── 1. Obtener datos del comprobante ──────────────────────────────────────
  SELECT business_id, estado_fiscal, cae, numero_fiscal
  INTO   v_business_id, v_estado_fiscal, v_cae, v_numero_fiscal
  FROM   comprobantes
  WHERE  id = p_comprobante_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Comprobante no encontrado');
  END IF;

  -- ── 2. Verificar que el usuario tiene acceso al negocio ───────────────────
  -- Opción A: es owner del negocio
  SELECT EXISTS (
    SELECT 1 FROM businesses
    WHERE  id = v_business_id
      AND  owner_user_id = auth.uid()
  ) INTO v_has_access;

  -- Opción B: tiene perfil vinculado al negocio
  IF NOT v_has_access THEN
    SELECT EXISTS (
      SELECT 1 FROM profiles
      WHERE  business_id = v_business_id
        AND  user_id     = auth.uid()
    ) INTO v_has_access;
  END IF;

  IF NOT v_has_access THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a este negocio');
  END IF;

  -- ── 3. Bloquear si ya fue emitido fiscalmente ─────────────────────────────
  IF v_estado_fiscal = 'emitido'
     OR v_cae           IS NOT NULL
     OR v_numero_fiscal  IS NOT NULL
  THEN
    RETURN jsonb_build_object(
      'success',      false,
      'arca_blocked', true,
      'error',        'Este comprobante ya fue emitido fiscalmente. Para anularlo, generá una Nota de Crédito.'
    );
  END IF;

  -- ── 4. Eliminar movimientos financieros propios del comprobante ───────────
  -- source='comprobante' → creados por trig_comprobante_payment_finance
  DELETE FROM financial_movements
  WHERE  comprobante_id = p_comprobante_id
    AND  source         = 'comprobante'
    AND  business_id    = v_business_id;
  GET DIAGNOSTICS v_del_fm = ROW_COUNT;

  -- ── 5. Desvincular movimientos de órdenes que fueron vinculados al comprobante
  -- (source≠'comprobante' → creados por order_payments, solo se linkaron)
  UPDATE financial_movements
  SET    comprobante_id = NULL
  WHERE  comprobante_id = p_comprobante_id
    AND  source         != 'comprobante'
    AND  business_id    = v_business_id;
  GET DIAGNOSTICS v_upd_fm = ROW_COUNT;

  -- ── 6. Eliminar entradas de finanzas vinculadas al comprobante ────────────
  DELETE FROM business_finance_entries
  WHERE  reference_comprobante_id = p_comprobante_id
    AND  business_id              = v_business_id;
  GET DIAGNOSTICS v_del_bfe = ROW_COUNT;

  -- ── 7. Eliminar pagos del comprobante ─────────────────────────────────────
  -- trig_comprobante_payment_sync dispara al borrar y actualiza total_cobrado
  -- en el comprobante — es irrelevante porque lo borramos a continuación.
  DELETE FROM comprobante_payments
  WHERE  comprobante_id = p_comprobante_id;
  GET DIAGNOSTICS v_del_payments = ROW_COUNT;

  -- ── 8. Eliminar ítems del comprobante ─────────────────────────────────────
  DELETE FROM comprobante_items
  WHERE  comprobante_id = p_comprobante_id;
  GET DIAGNOSTICS v_del_items = ROW_COUNT;

  -- ── 9. Eliminar el comprobante ────────────────────────────────────────────
  DELETE FROM comprobantes
  WHERE  id          = p_comprobante_id
    AND  business_id = v_business_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'No se pudo eliminar el comprobante');
  END IF;

  -- ── 10. Retornar resultado ────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'success', true,
    'deleted', jsonb_build_object(
      'financial_movements',          v_del_fm,
      'financial_movements_unlinked', v_upd_fm,
      'business_finance_entries',     v_del_bfe,
      'payments',                     v_del_payments,
      'items',                        v_del_items
    )
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'success', false,
    'error',   SQLERRM
  );
END;
$$;


ALTER FUNCTION "public"."delete_comprobante_with_finance"("p_comprobante_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_supplier_purchase_safe"("p_business_id" "uuid", "p_purchase_id" "uuid", "p_user_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_purchase record;
  v_item     record;
  v_prev_stk integer;
  v_new_stk  integer;
BEGIN
  SELECT * INTO v_purchase
  FROM public.supplier_purchases
  WHERE id = p_purchase_id AND business_id = p_business_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Compra no encontrada');
  END IF;

  IF v_purchase.paid_amount > 0 THEN
    RETURN jsonb_build_object(
      'ok',     false,
      'error',  'blocked_paid',
      'message','No se puede eliminar una compra con pagos registrados.'
    );
  END IF;

  -- Revert stock for each inventoried item
  FOR v_item IN
    SELECT * FROM public.supplier_purchase_items
    WHERE purchase_id = p_purchase_id AND business_id = p_business_id
  LOOP
    IF v_item.inventory_id IS NOT NULL THEN
      SELECT stock_quantity INTO v_prev_stk
      FROM public.inventory
      WHERE id = v_item.inventory_id AND business_id = p_business_id;

      IF FOUND THEN
        v_new_stk := GREATEST(0, COALESCE(v_prev_stk, 0) - FLOOR(v_item.quantity)::integer);

        UPDATE public.inventory
           SET stock_quantity = v_new_stk,
               stock          = v_new_stk,
               updated_at     = now()
         WHERE id = v_item.inventory_id AND business_id = p_business_id;

        INSERT INTO public.inventory_movements (
          inventory_item_id, movement_type, quantity,
          previous_stock, new_stock, reference_type, reference_id,
          note, business_id, created_by
        ) VALUES (
          v_item.inventory_id, 'cancellation',
          -FLOOR(v_item.quantity)::integer,
          COALESCE(v_prev_stk, 0), v_new_stk,
          'supplier_purchase', p_purchase_id,
          'Reversión por eliminación de compra',
          p_business_id, p_user_id
        );
      END IF;
    END IF;
  END LOOP;

  -- Delete CC movements for this purchase
  DELETE FROM public.supplier_account_movements
   WHERE purchase_id = p_purchase_id AND business_id = p_business_id;

  -- Recalculate balance_after for remaining movements of this supplier
  WITH ordered AS (
    SELECT id,
           SUM(debit - credit) OVER (
             PARTITION BY supplier_id
             ORDER BY movement_date, created_at
             ROWS UNBOUNDED PRECEDING
           ) AS running_bal
    FROM public.supplier_account_movements
    WHERE supplier_id = v_purchase.supplier_id AND business_id = p_business_id
  )
  UPDATE public.supplier_account_movements m
     SET balance_after = o.running_bal
    FROM ordered o
   WHERE m.id = o.id;

  -- Delete items
  DELETE FROM public.supplier_purchase_items
   WHERE purchase_id = p_purchase_id AND business_id = p_business_id;

  -- Delete purchase
  DELETE FROM public.supplier_purchases
   WHERE id = p_purchase_id AND business_id = p_business_id;

  RETURN jsonb_build_object('ok', true);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."delete_supplier_purchase_safe"("p_business_id" "uuid", "p_purchase_id" "uuid", "p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."encrypt_data"("data_to_encrypt" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  encrypted_bytes BYTEA;
  encrypted_text TEXT;
BEGIN
  encrypted_bytes := pgp_sym_encrypt(data_to_encrypt, 'techrepair_encryption_key_2024');
  encrypted_text := encode(encrypted_bytes, 'base64');
  RETURN encrypted_text;
END;
$$;


ALTER FUNCTION "public"."encrypt_data"("data_to_encrypt" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_grace_period"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  UPDATE public.businesses
  SET subscription_status = 'suspended',
      updated_at = NOW()
  WHERE subscription_status = 'past_due'
    AND grace_until IS NOT NULL
    AND grace_until < NOW();
END;
$$;


ALTER FUNCTION "public"."enforce_grace_period"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ensure_brand_and_model"("p_brand_name" "text", "p_model_name" "text", "p_business_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_brand_id UUID;
  v_model_id UUID;
BEGIN
  v_brand_id := public.get_or_create_brand(p_brand_name, p_business_id);
  v_model_id := public.get_or_create_model(p_model_name, v_brand_id, p_business_id);
  RETURN jsonb_build_object('brand_id', v_brand_id, 'model_id', v_model_id);
END;
$$;


ALTER FUNCTION "public"."ensure_brand_and_model"("p_brand_name" "text", "p_model_name" "text", "p_business_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."expire_old_invitations"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_count integer;
begin
  update public.business_invitations
  set
    status = 'expired',
    updated_at = now()
  where status = 'pending'
    and expires_at <= now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


ALTER FUNCTION "public"."expire_old_invitations"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."expire_trials"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  UPDATE public.businesses
  SET subscription_status = 'suspended',
      updated_at = NOW()
  WHERE subscription_status = 'trialing'
    AND trial_ends_at IS NOT NULL
    AND trial_ends_at < NOW();
END;
$$;


ALTER FUNCTION "public"."expire_trials"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."finance_dashboard_summary"("p_business_id" "uuid", "p_date_from" "date", "p_date_to" "date") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_gross_income     numeric := 0;
  v_expenses         numeric := 0;
  v_nc_total         numeric := 0;
  v_supplier_pmts    numeric := 0;
  v_op_expenses      numeric := 0;
  v_sales_count      integer := 0;
  v_nc_count         integer := 0;
  v_local_count      integer := 0;
  v_arca_count       integer := 0;
  v_total_collected  numeric := 0;
  v_pending_total    numeric := 0;
  v_alert_critical   integer := 0;
  v_alert_warning    integer := 0;
  v_cash_method      jsonb;
  v_expenses_cat     jsonb;
  v_daily            jsonb;
  v_top_methods      jsonb;
BEGIN
  -- ── 1. Financial movements summary ─────────────────────────────────────────
  SELECT
    COALESCE(SUM(CASE WHEN type = 'income'  AND sign =  1 THEN amount_ars ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN type = 'expense'               THEN amount_ars ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN type = 'income'  AND sign = -1 THEN amount_ars ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN source = 'pago_proveedor'      THEN amount_ars ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN source IN ('expense', 'create_expense_with_finance')
                       THEN amount_ars ELSE 0 END), 0)
  INTO v_gross_income, v_expenses, v_nc_total, v_supplier_pmts, v_op_expenses
  FROM public.financial_movements
  WHERE business_id = p_business_id
    AND date BETWEEN p_date_from AND p_date_to;

  -- ── 2. Cash balance by payment method ──────────────────────────────────────
  SELECT COALESCE(
    jsonb_object_agg(
      metodo,
      ROUND(COALESCE(net_amount, 0)::numeric, 0)
    ), '{}'::jsonb
  )
  INTO v_cash_method
  FROM (
    SELECT
      COALESCE(NULLIF(trim(COALESCE(metodo_pago, '')), ''), 'otro') AS metodo,
      SUM(
        CASE
          WHEN type = 'income'  THEN amount_ars * sign
          WHEN type = 'expense' THEN -amount_ars
          ELSE 0
        END
      ) AS net_amount
    FROM public.financial_movements
    WHERE business_id = p_business_id
      AND date BETWEEN p_date_from AND p_date_to
    GROUP BY COALESCE(NULLIF(trim(COALESCE(metodo_pago, '')), ''), 'otro')
  ) sub;

  -- ── 3. Sales & credit notes from comprobantes ──────────────────────────────
  SELECT
    COUNT(*)    FILTER (WHERE tipo != 'nota_credito' AND comprobante_original_id IS NULL),
    COUNT(*)    FILTER (WHERE tipo =  'nota_credito' OR  comprobante_original_id IS NOT NULL),
    COUNT(*)    FILTER (WHERE tipo != 'nota_credito' AND comprobante_original_id IS NULL AND cae IS NULL),
    COUNT(*)    FILTER (WHERE tipo != 'nota_credito' AND comprobante_original_id IS NULL AND cae IS NOT NULL),
    COALESCE(SUM(total_cobrado)   FILTER (WHERE tipo != 'nota_credito'), 0),
    COALESCE(SUM(saldo_pendiente) FILTER (WHERE tipo != 'nota_credito'), 0)
  INTO v_sales_count, v_nc_count, v_local_count, v_arca_count, v_total_collected, v_pending_total
  FROM public.comprobantes
  WHERE business_id = p_business_id
    AND estado != 'anulado'
    AND fecha BETWEEN p_date_from AND p_date_to;

  -- ── 4. Expenses by category (BFE) ──────────────────────────────────────────
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object('category', category, 'total', ROUND(total::numeric, 0))
      ORDER BY total DESC
    ), '[]'::jsonb
  )
  INTO v_expenses_cat
  FROM (
    SELECT category, SUM(amount_ars) AS total
    FROM public.business_finance_entries
    WHERE business_id = p_business_id
      AND date BETWEEN p_date_from AND p_date_to
      AND type IN ('expense', 'variable_cost', 'fixed_cost_local', 'salary', 'fixed_cost_personal')
    GROUP BY category
    ORDER BY total DESC
    LIMIT 8
  ) cat;

  -- ── 5. Daily series (income + expense per day) ──────────────────────────────
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'date',    day,
        'income',  ROUND(income::numeric,  0),
        'expense', ROUND(expense::numeric, 0),
        'net',     ROUND((income - expense)::numeric, 0)
      ) ORDER BY day
    ), '[]'::jsonb
  )
  INTO v_daily
  FROM (
    SELECT
      date AS day,
      SUM(CASE WHEN type = 'income'  AND sign = 1 THEN amount_ars ELSE 0 END) AS income,
      SUM(CASE WHEN type = 'expense'              THEN amount_ars ELSE 0 END) AS expense
    FROM public.financial_movements
    WHERE business_id = p_business_id
      AND date BETWEEN p_date_from AND p_date_to
    GROUP BY date
  ) daily;

  -- ── 6. Top payment methods (by gross income) ───────────────────────────────
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object('method', metodo, 'total', ROUND(monto::numeric, 0))
      ORDER BY monto DESC
    ), '[]'::jsonb
  )
  INTO v_top_methods
  FROM (
    SELECT
      COALESCE(NULLIF(trim(COALESCE(metodo_pago, '')), ''), 'otro') AS metodo,
      SUM(amount_ars) AS monto
    FROM public.financial_movements
    WHERE business_id = p_business_id
      AND date BETWEEN p_date_from AND p_date_to
      AND type = 'income' AND sign = 1
    GROUP BY COALESCE(NULLIF(trim(COALESCE(metodo_pago, '')), ''), 'otro')
    HAVING SUM(amount_ars) > 0
    ORDER BY monto DESC
    LIMIT 5
  ) sub;

  -- ── 7. Quick integrity alerts ───────────────────────────────────────────────
  -- Critical: ARCA comprobantes in last 60 days without a financial_movement
  SELECT COALESCE(COUNT(*), 0) INTO v_alert_critical
  FROM public.comprobantes c
  WHERE c.business_id = p_business_id
    AND c.cae IS NOT NULL
    AND c.estado = 'emitido'
    AND c.created_at > now() - INTERVAL '60 days'
    AND NOT EXISTS (
      SELECT 1 FROM public.financial_movements fm
      WHERE fm.comprobante_id = c.id AND fm.business_id = p_business_id
    );

  -- Warning: any pending supplier invoice
  SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END INTO v_alert_warning
  FROM public.supplier_purchases
  WHERE business_id = p_business_id AND payment_status != 'paid';

  -- ── Build result ────────────────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'ok',      true,
    'period',  jsonb_build_object('from', p_date_from, 'to', p_date_to),
    'summary', jsonb_build_object(
      'gross_income',         ROUND(v_gross_income::numeric, 0),
      'expenses',             ROUND(v_expenses::numeric, 0),
      'net_result',           ROUND((v_gross_income - v_nc_total - v_expenses)::numeric, 0),
      'sales_total',          ROUND(v_total_collected::numeric, 0),
      'credit_notes_total',   ROUND(v_nc_total::numeric, 0),
      'supplier_payments',    ROUND(v_supplier_pmts::numeric, 0),
      'operational_expenses', ROUND(v_op_expenses::numeric, 0)
    ),
    'cash_by_method',       COALESCE(v_cash_method, '{}'::jsonb),
    'sales', jsonb_build_object(
      'count',           v_sales_count,
      'nc_count',        v_nc_count,
      'local_count',     v_local_count,
      'arca_count',      v_arca_count,
      'total_collected', ROUND(v_total_collected::numeric, 0),
      'pending_total',   ROUND(v_pending_total::numeric, 0)
    ),
    'expenses_by_category', COALESCE(v_expenses_cat, '[]'::jsonb),
    'top_payment_methods',  COALESCE(v_top_methods,  '[]'::jsonb),
    'daily_series',         COALESCE(v_daily,         '[]'::jsonb),
    'alerts', jsonb_build_object(
      'critical', v_alert_critical,
      'warning',  v_alert_warning,
      'low',      0
    )
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."finance_dashboard_summary"("p_business_id" "uuid", "p_date_from" "date", "p_date_to" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."finance_health_check"("p_business_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
DECLARE
  v_has_access  BOOLEAN := FALSE;
  v_checks      JSONB   := '[]'::JSONB;
  v_critical    INTEGER := 0;
  v_warning     INTEGER := 0;
  v_low         INTEGER := 0;
  v_cnt         INTEGER;
  v_rows        JSONB;
  v_sev         TEXT;
  v_status      TEXT;
BEGIN
  -- ── Validar acceso ──────────────────────────────────────────────────────────
  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id = p_business_id AND owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id = p_business_id AND user_id = auth.uid())
  ) INTO v_has_access;
  IF NOT v_has_access THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso al negocio');
  END IF;

  -- ── Macro helper: agrega un check a v_checks y acumula contadores ───────────
  -- Uso: establecer v_cnt, v_rows, v_sev antes de PERFORM add_check(...)
  -- (simulado con bloques inline ya que PG no soporta funciones anidadas)

  -- ═══ CHECK 1: CAE con estado_fiscal incorrecto ══════════════════════════════
  SELECT COUNT(*) INTO v_cnt
  FROM comprobantes
  WHERE business_id = p_business_id AND cae IS NOT NULL AND cae != ''
    AND estado_fiscal != 'emitido' AND estado != 'anulado';

  SELECT COALESCE(jsonb_agg(r),'[]') INTO v_rows FROM (
    SELECT jsonb_build_object('id',id,'numero',COALESCE(numero_fiscal,numero),
      'tipo',tipo,'estado_fiscal',estado_fiscal,'total',total::numeric) AS r
    FROM comprobantes WHERE business_id=p_business_id AND cae IS NOT NULL AND cae!=''
      AND estado_fiscal!='emitido' AND estado!='anulado'
    ORDER BY created_at DESC LIMIT 10
  ) x;

  v_sev    := 'critical';
  v_status := CASE WHEN v_cnt=0 THEN 'ok' ELSE 'critical' END;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'id','cae_estado_incorrecto','title','CAE con estado fiscal incorrecto',
    'severity',v_sev,'status',v_status,'count',v_cnt,'rows',v_rows,
    'description','Facturas con CAE en AFIP pero estado_fiscal distinto de emitido.'
  ));
  IF v_cnt > 0 THEN v_critical := v_critical + 1; END IF;

  -- ═══ CHECK 2: Emitidos sin numero_fiscal ════════════════════════════════════
  SELECT COUNT(*) INTO v_cnt
  FROM comprobantes WHERE business_id=p_business_id
    AND estado_fiscal='emitido' AND cae IS NOT NULL
    AND numero_fiscal IS NULL AND numero IS NOT NULL;

  SELECT COALESCE(jsonb_agg(r),'[]') INTO v_rows FROM (
    SELECT jsonb_build_object('id',id,'numero',numero,'cae',cae,'tipo',tipo,'total',total::numeric) AS r
    FROM comprobantes WHERE business_id=p_business_id
      AND estado_fiscal='emitido' AND cae IS NOT NULL
      AND numero_fiscal IS NULL AND numero IS NOT NULL
    ORDER BY created_at DESC LIMIT 10
  ) x;

  v_sev := 'critical'; v_status := CASE WHEN v_cnt=0 THEN 'ok' ELSE 'critical' END;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'id','emitido_sin_numero_fiscal','title','Emitidos con CAE pero sin numero_fiscal',
    'severity',v_sev,'status',v_status,'count',v_cnt,'rows',v_rows,
    'description','Estado emitido con CAE pero campo numero_fiscal vacío. La tabla muestra "-".'
  ));
  IF v_cnt > 0 THEN v_critical := v_critical + 1; END IF;

  -- ═══ CHECK 3: BFE huérfanas ═════════════════════════════════════════════════
  SELECT COUNT(*) INTO v_cnt
  FROM business_finance_entries bfe WHERE bfe.business_id=p_business_id
    AND bfe.reference_comprobante_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM comprobantes c WHERE c.id=bfe.reference_comprobante_id);

  SELECT COALESCE(jsonb_agg(r),'[]') INTO v_rows FROM (
    SELECT jsonb_build_object('id',bfe.id,'ref',bfe.reference_comprobante_id,
      'amount',bfe.amount::numeric,'type',bfe.type,'fecha',bfe.created_at::date) AS r
    FROM business_finance_entries bfe WHERE bfe.business_id=p_business_id
      AND bfe.reference_comprobante_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM comprobantes c WHERE c.id=bfe.reference_comprobante_id)
    ORDER BY bfe.created_at DESC LIMIT 10
  ) x;

  v_sev := CASE WHEN v_cnt>5 THEN 'critical' ELSE 'warning' END;
  v_status := CASE WHEN v_cnt=0 THEN 'ok' ELSE v_sev END;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'id','bfe_huerfanas','title','Entradas financieras huérfanas (BFE)',
    'severity',v_sev,'status',v_status,'count',v_cnt,'rows',v_rows,
    'description','BFE con reference_comprobante_id apuntando a comprobante inexistente.'
  ));
  IF v_cnt > 0 THEN IF v_sev='critical' THEN v_critical:=v_critical+1; ELSE v_warning:=v_warning+1; END IF; END IF;

  -- ═══ CHECK 4: FM huérfanos ══════════════════════════════════════════════════
  SELECT COUNT(*) INTO v_cnt
  FROM financial_movements fm WHERE fm.business_id=p_business_id
    AND fm.comprobante_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM comprobantes c WHERE c.id=fm.comprobante_id);

  SELECT COALESCE(jsonb_agg(r),'[]') INTO v_rows FROM (
    SELECT jsonb_build_object('id',fm.id,'comprobante_id',fm.comprobante_id,
      'amount',fm.amount::numeric,'type',fm.type,'sign',fm.sign) AS r
    FROM financial_movements fm WHERE fm.business_id=p_business_id
      AND fm.comprobante_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM comprobantes c WHERE c.id=fm.comprobante_id)
    LIMIT 10
  ) x;

  v_sev := CASE WHEN v_cnt>2 THEN 'critical' ELSE 'warning' END;
  v_status := CASE WHEN v_cnt=0 THEN 'ok' ELSE v_sev END;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'id','fm_huerfanos','title','Movimientos de caja huérfanos (FM)',
    'severity',v_sev,'status',v_status,'count',v_cnt,'rows',v_rows,
    'description','financial_movements con comprobante_id apuntando a comprobante inexistente.'
  ));
  IF v_cnt > 0 THEN IF v_sev='critical' THEN v_critical:=v_critical+1; ELSE v_warning:=v_warning+1; END IF; END IF;

  -- ═══ CHECK 5: Payments huérfanos ════════════════════════════════════════════
  SELECT COUNT(*) INTO v_cnt
  FROM comprobante_payments cp WHERE cp.business_id=p_business_id
    AND NOT EXISTS (SELECT 1 FROM comprobantes c WHERE c.id=cp.comprobante_id);

  SELECT COALESCE(jsonb_agg(r),'[]') INTO v_rows FROM (
    SELECT jsonb_build_object('id',cp.id,'comprobante_id',cp.comprobante_id,
      'amount',cp.amount_ars::numeric,'method',cp.payment_method) AS r
    FROM comprobante_payments cp WHERE cp.business_id=p_business_id
      AND NOT EXISTS (SELECT 1 FROM comprobantes c WHERE c.id=cp.comprobante_id)
    LIMIT 10
  ) x;

  v_sev:='low'; v_status:=CASE WHEN v_cnt=0 THEN 'ok' ELSE 'low' END;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'id','payments_huerfanos','title','Pagos huérfanos (comprobante_payments)',
    'severity',v_sev,'status',v_status,'count',v_cnt,'rows',v_rows,
    'description','comprobante_payments sin comprobante padre.'
  ));
  IF v_cnt > 0 THEN v_low := v_low + 1; END IF;

  -- ═══ CHECK 6: Items huérfanos ═══════════════════════════════════════════════
  SELECT COUNT(*) INTO v_cnt
  FROM comprobante_items ci WHERE ci.business_id=p_business_id
    AND NOT EXISTS (SELECT 1 FROM comprobantes c WHERE c.id=ci.comprobante_id);

  SELECT COALESCE(jsonb_agg(r),'[]') INTO v_rows FROM (
    SELECT jsonb_build_object('id',ci.id,'comprobante_id',ci.comprobante_id,
      'descripcion',LEFT(ci.descripcion,40),'subtotal',ci.subtotal::numeric) AS r
    FROM comprobante_items ci WHERE ci.business_id=p_business_id
      AND NOT EXISTS (SELECT 1 FROM comprobantes c WHERE c.id=ci.comprobante_id)
    LIMIT 10
  ) x;

  v_sev:='low'; v_status:=CASE WHEN v_cnt=0 THEN 'ok' ELSE 'low' END;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'id','items_huerfanos','title','Ítems huérfanos (comprobante_items)',
    'severity',v_sev,'status',v_status,'count',v_cnt,'rows',v_rows,
    'description','comprobante_items sin comprobante padre.'
  ));
  IF v_cnt > 0 THEN v_low := v_low + 1; END IF;

  -- ═══ CHECK 7: NC emitidas sin comprobante_original_id ═══════════════════════
  SELECT COUNT(*) INTO v_cnt
  FROM comprobantes WHERE business_id=p_business_id
    AND tipo='nota_credito' AND estado_fiscal='emitido' AND comprobante_original_id IS NULL;

  SELECT COALESCE(jsonb_agg(r),'[]') INTO v_rows FROM (
    SELECT jsonb_build_object('id',id,'numero_fiscal',numero_fiscal,
      'cae',cae,'total',total::numeric) AS r
    FROM comprobantes WHERE business_id=p_business_id
      AND tipo='nota_credito' AND estado_fiscal='emitido' AND comprobante_original_id IS NULL
    LIMIT 10
  ) x;

  v_sev:='critical'; v_status:=CASE WHEN v_cnt=0 THEN 'ok' ELSE 'critical' END;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'id','nc_sin_original','title','NC emitidas sin comprobante original',
    'severity',v_sev,'status',v_status,'count',v_cnt,'rows',v_rows,
    'description','Nota de Crédito emitida en ARCA sin vínculo al comprobante original. Sin trazabilidad fiscal.'
  ));
  IF v_cnt > 0 THEN v_critical := v_critical + 1; END IF;

  -- ═══ CHECK 8: Facturas anuladas sin NC ══════════════════════════════════════
  SELECT COUNT(*) INTO v_cnt
  FROM comprobantes c WHERE c.business_id=p_business_id
    AND c.tipo IN ('factura_a','factura_c') AND c.estado_fiscal='anulado_fiscal'
    AND NOT EXISTS (
      SELECT 1 FROM comprobantes nc
      WHERE nc.comprobante_original_id=c.id AND nc.tipo='nota_credito'
    );

  SELECT COALESCE(jsonb_agg(r),'[]') INTO v_rows FROM (
    SELECT jsonb_build_object('id',c.id,'numero_fiscal',c.numero_fiscal,
      'tipo',c.tipo,'total',c.total::numeric) AS r
    FROM comprobantes c WHERE c.business_id=p_business_id
      AND c.tipo IN ('factura_a','factura_c') AND c.estado_fiscal='anulado_fiscal'
      AND NOT EXISTS (SELECT 1 FROM comprobantes nc WHERE nc.comprobante_original_id=c.id AND nc.tipo='nota_credito')
    LIMIT 10
  ) x;

  v_sev:='warning'; v_status:=CASE WHEN v_cnt=0 THEN 'ok' ELSE 'warning' END;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'id','anulada_sin_nc','title','Facturas anuladas sin Nota de Crédito',
    'severity',v_sev,'status',v_status,'count',v_cnt,'rows',v_rows,
    'description','Facturas con estado anulado_fiscal sin NC vinculada. Anulación sin respaldo formal.'
  ));
  IF v_cnt > 0 THEN v_warning := v_warning + 1; END IF;

  -- ═══ CHECK 9: NC duplicadas ══════════════════════════════════════════════════
  SELECT COUNT(*) INTO v_cnt FROM (
    SELECT comprobante_original_id FROM comprobantes
    WHERE business_id=p_business_id AND tipo='nota_credito'
      AND comprobante_original_id IS NOT NULL
      AND estado_fiscal NOT IN ('anulado_fiscal','error_emision')
    GROUP BY comprobante_original_id HAVING COUNT(*) > 1
  ) t;

  SELECT COALESCE(jsonb_agg(r),'[]') INTO v_rows FROM (
    SELECT jsonb_build_object('original_id',comprobante_original_id,
      'nc_count',COUNT(*),'nc_ids',jsonb_agg(id)) AS r
    FROM comprobantes
    WHERE business_id=p_business_id AND tipo='nota_credito'
      AND comprobante_original_id IS NOT NULL
      AND estado_fiscal NOT IN ('anulado_fiscal','error_emision')
    GROUP BY comprobante_original_id HAVING COUNT(*) > 1
    LIMIT 10
  ) x;

  v_sev:='critical'; v_status:=CASE WHEN v_cnt=0 THEN 'ok' ELSE 'critical' END;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'id','nc_duplicadas','title','Notas de Crédito duplicadas por factura',
    'severity',v_sev,'status',v_status,'count',v_cnt,'rows',v_rows,
    'description','Más de una NC activa para el mismo comprobante original. Doble reversión financiera y fiscal.'
  ));
  IF v_cnt > 0 THEN v_critical := v_critical + 1; END IF;

  -- ═══ CHECK 10: NC emitida sin reversa financiera ═════════════════════════════
  SELECT COUNT(*) INTO v_cnt
  FROM comprobantes c WHERE c.business_id=p_business_id
    AND c.tipo='nota_credito' AND c.estado_fiscal='emitido'
    AND NOT EXISTS (SELECT 1 FROM financial_movements fm WHERE fm.comprobante_id=c.id AND fm.sign=-1)
    AND NOT EXISTS (SELECT 1 FROM business_finance_entries bfe WHERE bfe.reference_comprobante_id=c.id AND bfe.amount < 0);

  SELECT COALESCE(jsonb_agg(r),'[]') INTO v_rows FROM (
    SELECT jsonb_build_object('id',c.id,'numero_fiscal',c.numero_fiscal,
      'total',c.total::numeric,
      'tiene_fm_neg', EXISTS(SELECT 1 FROM financial_movements fm WHERE fm.comprobante_id=c.id AND fm.sign=-1),
      'tiene_bfe_neg', EXISTS(SELECT 1 FROM business_finance_entries b WHERE b.reference_comprobante_id=c.id AND b.amount<0)
    ) AS r
    FROM comprobantes c WHERE c.business_id=p_business_id
      AND c.tipo='nota_credito' AND c.estado_fiscal='emitido'
      AND NOT EXISTS (SELECT 1 FROM financial_movements fm WHERE fm.comprobante_id=c.id AND fm.sign=-1)
      AND NOT EXISTS (SELECT 1 FROM business_finance_entries bfe WHERE bfe.reference_comprobante_id=c.id AND bfe.amount<0)
    LIMIT 10
  ) x;

  v_sev:='critical'; v_status:=CASE WHEN v_cnt=0 THEN 'ok' ELSE 'critical' END;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'id','nc_sin_reversa','title','NC emitidas sin reversa financiera',
    'severity',v_sev,'status',v_status,'count',v_cnt,'rows',v_rows,
    'description','NC emitida en ARCA sin FM negativo ni BFE negativa. La emisión no corrigió la caja.'
  ));
  IF v_cnt > 0 THEN v_critical := v_critical + 1; END IF;

  -- ═══ CHECK 11: total_cobrado != suma de payments ══════════════════════════════
  SELECT COUNT(*) INTO v_cnt FROM (
    SELECT c.id FROM comprobantes c
    LEFT JOIN comprobante_payments cp ON cp.comprobante_id=c.id
    WHERE c.business_id=p_business_id AND c.estado NOT IN ('anulado','cancelled')
      AND c.total_cobrado IS NOT NULL
    GROUP BY c.id
    HAVING ABS(c.total_cobrado - COALESCE(SUM(cp.amount_ars),0)) > 1
  ) t;

  SELECT COALESCE(jsonb_agg(r),'[]') INTO v_rows FROM (
    SELECT jsonb_build_object(
      'id',c.id,'numero',COALESCE(c.numero_fiscal,c.numero),'tipo',c.tipo,
      'total_cobrado',c.total_cobrado::numeric,
      'sum_payments',COALESCE(SUM(cp.amount_ars),0)::numeric,
      'diferencia',ABS(c.total_cobrado - COALESCE(SUM(cp.amount_ars),0))::numeric
    ) AS r
    FROM comprobantes c
    LEFT JOIN comprobante_payments cp ON cp.comprobante_id=c.id
    WHERE c.business_id=p_business_id AND c.estado NOT IN ('anulado','cancelled')
      AND c.total_cobrado IS NOT NULL
    GROUP BY c.id
    HAVING ABS(c.total_cobrado - COALESCE(SUM(cp.amount_ars),0)) > 1
    ORDER BY ABS(c.total_cobrado - COALESCE(SUM(cp.amount_ars),0)) DESC
    LIMIT 10
  ) x;

  v_sev := CASE WHEN v_cnt>3 THEN 'critical' ELSE 'warning' END;
  v_status := CASE WHEN v_cnt=0 THEN 'ok' ELSE v_sev END;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'id','total_cobrado_incorrecto','title','total_cobrado != suma de pagos',
    'severity',v_sev,'status',v_status,'count',v_cnt,'rows',v_rows,
    'description','Header total_cobrado difiere >$1 de la suma real de comprobante_payments.'
  ));
  IF v_cnt > 0 THEN IF v_sev='critical' THEN v_critical:=v_critical+1; ELSE v_warning:=v_warning+1; END IF; END IF;

  -- ═══ CHECK 12: saldo_pendiente incorrecto ════════════════════════════════════
  SELECT COUNT(*) INTO v_cnt
  FROM comprobantes
  WHERE business_id=p_business_id AND estado NOT IN ('anulado','cancelled')
    AND saldo_pendiente IS NOT NULL AND total_cobrado IS NOT NULL
    AND tipo != 'nota_credito'
    AND ABS(saldo_pendiente - GREATEST(0, COALESCE(total_bruto,total,0) - COALESCE(total_cobrado,0))) > 1;

  SELECT COALESCE(jsonb_agg(r),'[]') INTO v_rows FROM (
    SELECT jsonb_build_object('id',id,'numero',COALESCE(numero_fiscal,numero),'tipo',tipo,
      'total_bruto',total_bruto::numeric,'total_cobrado',total_cobrado::numeric,
      'saldo_pendiente',saldo_pendiente::numeric,
      'saldo_calculado',GREATEST(0, COALESCE(total_bruto,total,0) - COALESCE(total_cobrado,0))::numeric
    ) AS r
    FROM comprobantes
    WHERE business_id=p_business_id AND estado NOT IN ('anulado','cancelled')
      AND saldo_pendiente IS NOT NULL AND total_cobrado IS NOT NULL
      AND tipo != 'nota_credito'
      AND ABS(saldo_pendiente - GREATEST(0, COALESCE(total_bruto,total,0) - COALESCE(total_cobrado,0))) > 1
    ORDER BY ABS(saldo_pendiente - GREATEST(0, COALESCE(total_bruto,total,0) - COALESCE(total_cobrado,0))) DESC
    LIMIT 10
  ) x;

  v_sev:='low'; v_status:=CASE WHEN v_cnt=0 THEN 'ok' ELSE 'low' END;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'id','saldo_pendiente_incorrecto','title','saldo_pendiente calculado incorrectamente',
    'severity',v_sev,'status',v_status,'count',v_cnt,'rows',v_rows,
    'description','saldo_pendiente difiere del cálculo esperado (total_bruto - total_cobrado).'
  ));
  IF v_cnt > 0 THEN v_low := v_low + 1; END IF;

  -- ═══ CHECK 13: Remitos con payments pero sin FM ═══════════════════════════════
  SELECT COUNT(*) INTO v_cnt
  FROM comprobantes c WHERE c.business_id=p_business_id
    AND c.tipo='remito' AND c.estado NOT IN ('anulado','cancelled')
    AND EXISTS    (SELECT 1 FROM comprobante_payments cp WHERE cp.comprobante_id=c.id)
    AND NOT EXISTS(SELECT 1 FROM financial_movements fm  WHERE fm.comprobante_id=c.id);

  SELECT COALESCE(jsonb_agg(r),'[]') INTO v_rows FROM (
    SELECT jsonb_build_object('id',c.id,'numero',c.numero,'fecha',c.created_at::date,
      'total',c.total::numeric,
      'metodo',(SELECT payment_method FROM comprobante_payments WHERE comprobante_id=c.id LIMIT 1)
    ) AS r
    FROM comprobantes c WHERE c.business_id=p_business_id
      AND c.tipo='remito' AND c.estado NOT IN ('anulado','cancelled')
      AND EXISTS    (SELECT 1 FROM comprobante_payments cp WHERE cp.comprobante_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM financial_movements fm  WHERE fm.comprobante_id=c.id)
    ORDER BY c.created_at DESC LIMIT 10
  ) x;

  v_sev:='warning'; v_status:=CASE WHEN v_cnt=0 THEN 'ok' ELSE 'warning' END;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'id','remito_payment_sin_fm','title','Remitos con pagos pero sin caja (FM)',
    'severity',v_sev,'status',v_status,'count',v_cnt,'rows',v_rows,
    'description','Remitos con comprobante_payments pero sin financial_movements. No aparecen en Caja Diaria.'
  ));
  IF v_cnt > 0 THEN v_warning := v_warning + 1; END IF;

  -- ═══ CHECK 14: Remitos con total_cobrado > 0 sin payments ════════════════════
  SELECT COUNT(*) INTO v_cnt
  FROM comprobantes WHERE business_id=p_business_id AND tipo='remito'
    AND COALESCE(total_cobrado,0) > 0
    AND NOT EXISTS (SELECT 1 FROM comprobante_payments cp WHERE cp.comprobante_id=id);

  SELECT COALESCE(jsonb_agg(r),'[]') INTO v_rows FROM (
    SELECT jsonb_build_object('id',id,'numero',numero,'fecha',created_at::date,
      'total_cobrado',total_cobrado::numeric,'estado',estado) AS r
    FROM comprobantes WHERE business_id=p_business_id AND tipo='remito'
      AND COALESCE(total_cobrado,0) > 0
      AND NOT EXISTS (SELECT 1 FROM comprobante_payments cp WHERE cp.comprobante_id=id)
    ORDER BY created_at DESC LIMIT 10
  ) x;

  v_sev:='warning'; v_status:=CASE WHEN v_cnt=0 THEN 'ok' ELSE 'warning' END;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'id','remito_cobrado_sin_payment','title','Remitos legacy con cobro sin normalizar',
    'severity',v_sev,'status',v_status,'count',v_cnt,'rows',v_rows,
    'description','total_cobrado > 0 pero sin comprobante_payments. Cobros legacy no migrados.'
  ));
  IF v_cnt > 0 THEN v_warning := v_warning + 1; END IF;

  -- ═══ CHECK 15: FM duplicados por comprobante ══════════════════════════════════
  SELECT COUNT(*) INTO v_cnt FROM (
    SELECT comprobante_id FROM financial_movements
    WHERE business_id=p_business_id AND comprobante_id IS NOT NULL
      AND type='income' AND sign=1
    GROUP BY comprobante_id HAVING COUNT(*) > 1
  ) t;

  SELECT COALESCE(jsonb_agg(r),'[]') INTO v_rows FROM (
    SELECT jsonb_build_object('comprobante_id',comprobante_id,
      'fm_count',COUNT(*),'total',SUM(amount*sign)::numeric) AS r
    FROM financial_movements
    WHERE business_id=p_business_id AND comprobante_id IS NOT NULL
      AND type='income' AND sign=1
    GROUP BY comprobante_id HAVING COUNT(*) > 1
    LIMIT 10
  ) x;

  v_sev:='critical'; v_status:=CASE WHEN v_cnt=0 THEN 'ok' ELSE 'critical' END;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'id','fm_duplicados','title','Movimientos de caja duplicados',
    'severity',v_sev,'status',v_status,'count',v_cnt,'rows',v_rows,
    'description','Mismo comprobante con más de un FM income positivo. Duplica ingreso en Caja Diaria.'
  ));
  IF v_cnt > 0 THEN v_critical := v_critical + 1; END IF;

  -- ═══ CHECK 16: BFE duplicadas ════════════════════════════════════════════════
  SELECT COUNT(*) INTO v_cnt FROM (
    SELECT reference_comprobante_id, type, amount
    FROM business_finance_entries
    WHERE business_id=p_business_id AND reference_comprobante_id IS NOT NULL
    GROUP BY reference_comprobante_id, type, amount HAVING COUNT(*) > 1
  ) t;

  SELECT COALESCE(jsonb_agg(r),'[]') INTO v_rows FROM (
    SELECT jsonb_build_object('ref',reference_comprobante_id,
      'type',type,'amount',amount::numeric,'count',COUNT(*)) AS r
    FROM business_finance_entries
    WHERE business_id=p_business_id AND reference_comprobante_id IS NOT NULL
    GROUP BY reference_comprobante_id, type, amount HAVING COUNT(*) > 1
    LIMIT 10
  ) x;

  v_sev := CASE WHEN v_cnt>3 THEN 'critical' ELSE 'warning' END;
  v_status := CASE WHEN v_cnt=0 THEN 'ok' ELSE v_sev END;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'id','bfe_duplicadas','title','Entradas financieras duplicadas (BFE)',
    'severity',v_sev,'status',v_status,'count',v_cnt,'rows',v_rows,
    'description','Mismo comprobante+tipo+monto aparece más de una vez en BFE.'
  ));
  IF v_cnt > 0 THEN IF v_sev='critical' THEN v_critical:=v_critical+1; ELSE v_warning:=v_warning+1; END IF; END IF;

  -- ── Resultado ──────────────────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'ok',             v_critical = 0 AND v_warning = 0,
    'critical_count', v_critical,
    'warning_count',  v_warning,
    'low_count',      v_low,
    'total_issues',   v_critical + v_warning + v_low,
    'business_id',    p_business_id,
    'checked_at',     NOW(),
    'checks',         v_checks
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$_$;


ALTER FUNCTION "public"."finance_health_check"("p_business_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generar_numero_comprobante"("p_tipo" "text", "p_business_id" "uuid" DEFAULT NULL::"uuid", "p_punto_venta" "text" DEFAULT '0001'::"text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
DECLARE
  ultimo_numero BIGINT;
  nuevo_numero  TEXT;
  v_biz_id      UUID;
BEGIN
  v_biz_id := COALESCE(p_business_id, public.current_user_business_id());

  SELECT COALESCE(
    MAX(
      CASE
        WHEN COALESCE(number, numero) ~ '^[0-9]+$'
          THEN CAST(COALESCE(number, numero) AS BIGINT)
        WHEN COALESCE(number, numero) ~ '^[0-9]{4}-[0-9]{8}$'
          THEN CAST(SPLIT_PART(COALESCE(number, numero), '-', 2) AS BIGINT)
        ELSE 0
      END
    ), 0)
  INTO ultimo_numero
  FROM public.comprobantes
  WHERE business_id = v_biz_id
    AND COALESCE(type, tipo) = p_tipo;

  ultimo_numero := ultimo_numero + 1;

  IF p_punto_venta IS NULL OR TRIM(p_punto_venta) = '' THEN
    nuevo_numero := LPAD(ultimo_numero::TEXT, 8, '0');
  ELSE
    nuevo_numero := LPAD(p_punto_venta, 4, '0') || '-' || LPAD(ultimo_numero::TEXT, 8, '0');
  END IF;

  RETURN nuevo_numero;
END;
$_$;


ALTER FUNCTION "public"."generar_numero_comprobante"("p_tipo" "text", "p_business_id" "uuid", "p_punto_venta" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generar_numero_garantia"("p_business_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
DECLARE
  ultimo_numero bigint;
  nuevo_numero text;
BEGIN
  SELECT COALESCE(
    MAX(
      CASE
        WHEN number ~ '^GAR-[0-9]+$' THEN SUBSTRING(number FROM 5)::bigint
        WHEN number ~ '^[0-9]+$'     THEN number::bigint
        ELSE NULL
      END
    ),
    0
  )
  INTO ultimo_numero
  FROM public.warranties
  WHERE business_id = p_business_id;

  ultimo_numero := ultimo_numero + 1;
  nuevo_numero := 'GAR-' || LPAD(ultimo_numero::text, 6, '0');
  RETURN nuevo_numero;
END;
$_$;


ALTER FUNCTION "public"."generar_numero_garantia"("p_business_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_active_sales_point"("p_business_id" "uuid") RETURNS TABLE("id" "uuid", "nombre" "text", "numero" integer, "mp_enabled" boolean, "mp_store_id" "text", "mp_pos_id" "text", "mp_terminal_id" "text", "mp_terminal_mode" "text", "mp_channel_qr" boolean, "mp_channel_point" boolean, "mp_fee_percent" numeric, "mp_fee_fixed" numeric, "mp_vat_percent" numeric)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT
    sp.id, sp.nombre, sp.numero,
    COALESCE(sp.mp_enabled, FALSE),
    sp.mp_store_id, sp.mp_pos_id, sp.mp_terminal_id,
    COALESCE(sp.mp_terminal_mode, 'PDV'),
    COALESCE(sp.mp_channel_qr, TRUE),
    COALESCE(sp.mp_channel_point, FALSE),
    COALESCE(sp.mp_fee_percent, 0.0099),
    COALESCE(sp.mp_fee_fixed, 0),
    COALESCE(sp.mp_vat_percent, 0.21)
  FROM public.sales_points sp
  WHERE sp.business_id = p_business_id
    AND sp.activo = TRUE
  ORDER BY sp.predeterminado DESC, sp.numero ASC
  LIMIT 1;
$$;


ALTER FUNCTION "public"."get_active_sales_point"("p_business_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_business_settings"() RETURNS TABLE("id" "uuid", "business_id" "uuid", "default_currency" "text", "show_usd_price" boolean, "auto_update_rate" boolean, "rate_api_url" "text", "rate_update_frequency_hours" integer, "updated_at" timestamp with time zone, "created_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT
    bs.id,
    bs.business_id,
    bs.default_currency,
    bs.show_usd_price,
    bs.auto_update_rate,
    bs.rate_api_url,
    bs.rate_update_frequency_hours,
    bs.updated_at,
    bs.created_at
  FROM public.business_settings bs
  WHERE bs.business_id = public.current_user_business_id();
$$;


ALTER FUNCTION "public"."get_business_settings"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_business_subscription"("p_business_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'subscription_status',   b.subscription_status,
    'subscription_plan',     b.subscription_plan,
    'mp_preapproval_id',     b.mp_preapproval_id,
    'mp_payer_email',        b.mp_payer_email,
    'current_period_start',  b.current_period_start,
    'current_period_end',    b.current_period_end,
    'grace_until',           b.grace_until,
    'last_payment_status',   b.last_payment_status,
    'trial_ends_at',         b.trial_ends_at
  )
  INTO result
  FROM public.businesses b
  WHERE b.id = p_business_id;

  RETURN result;
END;
$$;


ALTER FUNCTION "public"."get_business_subscription"("p_business_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_business_subscription_features"("p_business_id" "uuid") RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
    'arca',             public._feat_pro(b.subscription_status, b.subscription_plan),
    'currentAccounts',  public._feat_pro(b.subscription_status, b.subscription_plan),
    'reports',          public._feat_pro(b.subscription_status, b.subscription_plan),
    'advancedFinance',  public._feat_pro(b.subscription_status, b.subscription_plan),
    'tasks',            public._feat_pro(b.subscription_status, b.subscription_plan),
    'personal_finance', public._feat_pro(b.subscription_status, b.subscription_plan),
    'advancedRoles',    public._feat_full(b.subscription_status, b.subscription_plan),
    'audit',            public._feat_full(b.subscription_status, b.subscription_plan),
    'multisucursal',    public._feat_full(b.subscription_status, b.subscription_plan),
    'mayorista',        public._feat_full(b.subscription_status, b.subscription_plan)
  )
  FROM public.businesses b
  WHERE b.id = p_business_id;
$$;


ALTER FUNCTION "public"."get_business_subscription_features"("p_business_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_current_exchange_rate"("p_base_currency" "text" DEFAULT 'USD'::"text", "p_target_currency" "text" DEFAULT 'ARS'::"text") RETURNS numeric
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT rate
  FROM public.exchange_rates
  WHERE business_id = public.current_user_business_id()
    AND base_currency = p_base_currency
    AND target_currency = p_target_currency
  ORDER BY updated_at DESC
  LIMIT 1;
$$;


ALTER FUNCTION "public"."get_current_exchange_rate"("p_base_currency" "text", "p_target_currency" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_finance_summary"("p_business_id" "uuid", "p_from" "date" DEFAULT (CURRENT_DATE - '30 days'::interval), "p_to" "date" DEFAULT CURRENT_DATE) RETURNS TABLE("total_income" numeric, "income_today" numeric, "income_this_week" numeric, "income_this_month" numeric, "total_expenses" numeric, "net_result" numeric, "pending_balance" numeric)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT
    COALESCE(SUM(CASE WHEN type = 'income' THEN amount_ars ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN type = 'income' AND date = CURRENT_DATE THEN amount_ars ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN type = 'income' AND date >= CURRENT_DATE - INTERVAL '7 days' THEN amount_ars ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN type = 'income' AND date >= DATE_TRUNC('month', CURRENT_DATE) THEN amount_ars ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN type != 'income' THEN amount_ars ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN type = 'income' THEN amount_ars ELSE -amount_ars END), 0),
    (
      SELECT COALESCE(SUM(GREATEST(0, COALESCE(o.total_cost, 0) - COALESCE(o.amount_paid, 0))), 0)
      FROM public.orders o
      WHERE o.business_id = p_business_id
        AND o.status IN ('completed', 'ready_delivery', 'waiting_payment')
    )
  FROM public.business_finance_entries
  WHERE business_id = p_business_id
    AND date BETWEEN p_from AND p_to;
$$;


ALTER FUNCTION "public"."get_finance_summary"("p_business_id" "uuid", "p_from" "date", "p_to" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_my_profile"() RETURNS TABLE("id" "uuid", "user_id" "uuid", "business_id" "uuid", "role" "text", "is_active" boolean, "full_name" "text", "email" "text", "phone" "text", "created_at" timestamp with time zone, "updated_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_auth_user_id UUID;
  v_auth_email TEXT;
BEGIN
  v_auth_user_id := auth.uid();

  IF v_auth_user_id IS NULL THEN
    RETURN;
  END IF;

  SELECT lower(u.email)
  INTO v_auth_email
  FROM auth.users u
  WHERE u.id = v_auth_user_id;

  RETURN QUERY
  SELECT
    p.id,
    COALESCE(p.user_id, p.id) AS user_id,
    p.business_id,
    p.role,
    COALESCE(p.is_active, TRUE) AS is_active,
    p.full_name,
    p.email,
    p.phone,
    COALESCE(p.created_at, NOW()) AS created_at,
    COALESCE(p.updated_at, NOW()) AS updated_at
  FROM public.profiles p
  WHERE COALESCE(p.user_id, p.id) = v_auth_user_id
     OR (
       v_auth_email IS NOT NULL
       AND lower(COALESCE(p.email, '')) = v_auth_email
     )
  ORDER BY
    (p.business_id IS NOT NULL) DESC,
    COALESCE(p.updated_at, p.created_at, NOW()) DESC
  LIMIT 1;
END;
$$;


ALTER FUNCTION "public"."get_my_profile"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_or_create_brand"("p_name" "text", "p_business_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_normalized TEXT;
  v_id         UUID;
BEGIN
  v_normalized := lower(trim(p_name));

  IF v_normalized = '' THEN
    RAISE EXCEPTION 'Brand name cannot be empty';
  END IF;

  -- Try to find existing
  SELECT id INTO v_id
  FROM public.brands
  WHERE business_id = p_business_id
    AND normalized_name = v_normalized
  LIMIT 1;

  IF FOUND THEN
    RETURN v_id;
  END IF;

  -- Create new (handle concurrent inserts gracefully)
  INSERT INTO public.brands (business_id, name, normalized_name)
  VALUES (p_business_id, trim(p_name), v_normalized)
  ON CONFLICT (business_id, normalized_name) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    -- Was created by a concurrent request, fetch it
    SELECT id INTO v_id
    FROM public.brands
    WHERE business_id = p_business_id
      AND normalized_name = v_normalized
    LIMIT 1;
  END IF;

  RETURN v_id;
END;
$$;


ALTER FUNCTION "public"."get_or_create_brand"("p_name" "text", "p_business_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_or_create_model"("p_name" "text", "p_brand_id" "uuid", "p_business_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_normalized TEXT;
  v_id         UUID;
BEGIN
  v_normalized := lower(trim(p_name));

  IF v_normalized = '' THEN
    RAISE EXCEPTION 'Model name cannot be empty';
  END IF;

  -- Try to find existing
  SELECT id INTO v_id
  FROM public.device_models
  WHERE business_id = p_business_id
    AND brand_id    = p_brand_id
    AND normalized_name = v_normalized
  LIMIT 1;

  IF FOUND THEN
    RETURN v_id;
  END IF;

  -- Create new (handle concurrent inserts gracefully)
  INSERT INTO public.device_models (business_id, brand_id, name, normalized_name)
  VALUES (p_business_id, p_brand_id, trim(p_name), v_normalized)
  ON CONFLICT (business_id, brand_id, normalized_name) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id
    FROM public.device_models
    WHERE business_id = p_business_id
      AND brand_id    = p_brand_id
      AND normalized_name = v_normalized
    LIMIT 1;
  END IF;

  RETURN v_id;
END;
$$;


ALTER FUNCTION "public"."get_or_create_model"("p_name" "text", "p_brand_id" "uuid", "p_business_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  new_business_id uuid;
  new_full_name text;
  new_role text;
  new_business_name text;
begin
  new_full_name := coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1));
  new_role := coalesce(new.raw_user_meta_data->>'role', 'owner');
  new_business_name := coalesce(new.raw_user_meta_data->>'business_name', 'Mi Negocio');

  insert into public.businesses (name)
  values (new_business_name)
  returning id into new_business_id;

  insert into public.profiles (id, business_id, full_name, role, is_active)
  values (new.id, new_business_id, new_full_name, new_role, true);

  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."insert_personal_default_categories"("p_user_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  INSERT INTO personal_categories (user_id, name, type, icon, color, is_default, is_active)
  SELECT p_user_id, v.name, v.type, v.icon, v.color, true, true
  FROM (VALUES
    -- Gastos
    ('Comida',          'expense', 'utensils',      '#f59e0b'),
    ('Alquiler',        'expense', 'home',           '#ef4444'),
    ('Servicios',       'expense', 'zap',            '#6366f1'),
    ('Internet',        'expense', 'wifi',           '#8b5cf6'),
    ('Celular',         'expense', 'smartphone',     '#06b6d4'),
    ('Transporte',      'expense', 'car',            '#14b8a6'),
    ('Salud',           'expense', 'heart',          '#ec4899'),
    ('Mascotas',        'expense', 'paw-print',      '#f97316'),
    ('Salidas',         'expense', 'music',          '#a78bfa'),
    ('Ropa',            'expense', 'shopping-bag',   '#fb7185'),
    ('Suscripciones',   'expense', 'credit-card',    '#64748b'),
    ('Tarjetas',        'expense', 'credit-card',    '#dc2626'),
    ('Deudas',          'expense', 'trending-down',  '#f87171'),
    ('Ahorro',          'expense', 'piggy-bank',     '#34d399'),
    ('Otros gastos',    'expense', 'circle',         '#475569'),
    -- Ingresos
    ('Sueldo del negocio',  'income', 'building-2',     '#34d399'),
    ('Retiro de ganancia',  'income', 'trending-up',    '#10b981'),
    ('Trabajo extra',       'income', 'briefcase',      '#60a5fa'),
    ('Venta personal',      'income', 'package',        '#818cf8'),
    ('Regalo',              'income', 'gift',           '#f472b6'),
    ('Otro ingreso',        'income', 'circle',         '#94a3b8')
  ) AS v(name, type, icon, color)
  ON CONFLICT DO NOTHING;
END; $$;


ALTER FUNCTION "public"."insert_personal_default_categories"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."inventory_product_history"("p_business_id" "uuid", "p_inventory_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_inv        record;
  v_movs_json  jsonb;
  v_revenue    numeric;
  v_stock_calc integer;
  v_alerts     jsonb := '[]'::jsonb;
  v_total_in   integer;
  v_total_out  integer;
  v_sold_qty   integer;
  v_used_qty   integer;
  v_total_cost numeric;
  v_last_mov   timestamptz;
  v_mov_count  integer;
BEGIN
  -- ── Validate product belongs to business ─────────────────────────────────
  SELECT id, name, code, category, description, cost_price, sale_price, stock_quantity
  INTO v_inv
  FROM public.inventory
  WHERE id = p_inventory_id AND business_id = p_business_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Producto no encontrado');
  END IF;

  -- ── Build enriched movements list ─────────────────────────────────────────
  SELECT jsonb_agg(row_data ORDER BY mov_ts DESC)
  INTO v_movs_json
  FROM (
    SELECT
      jsonb_build_object(
        'id',             m.id,
        'date',           m.created_at,
        'movement_type',  m.movement_type,
        'source',         COALESCE(m.reference_type, 'manual'),
        'quantity',       m.quantity,
        'unit_cost',      COALESCE(m.unit_cost, v_inv.cost_price),
        'unit_price',     COALESCE(ci.precio_unitario, v_inv.sale_price),
        'previous_stock', m.previous_stock,
        'new_stock',      m.new_stock,
        'reference_id',   m.reference_id,
        'reference_type', m.reference_type,
        'note',           m.note,
        'tipo_linea',     ci.tipo_linea,
        'charged_to_customer', CASE
          WHEN m.reference_type = 'comprobante' THEN true
          WHEN m.reference_type = 'order' AND ci_ord.id IS NOT NULL THEN true
          ELSE false
        END,
        'is_internal_part', CASE
          WHEN m.movement_type = 'order_usage' AND m.reference_type = 'order'
               AND ci_ord.id IS NULL THEN true
          ELSE false
        END,
        'supplier', CASE
          WHEN sup.id IS NOT NULL
            THEN jsonb_build_object('id', sup.id, 'name', sup.name)
          ELSE NULL
        END,
        'customer', CASE
          WHEN cust.id IS NOT NULL
            THEN jsonb_build_object('id', cust.id, 'name', cust.name)
          WHEN ord_cust.id IS NOT NULL
            THEN jsonb_build_object('id', ord_cust.id, 'name', ord_cust.name)
          ELSE NULL
        END,
        'comprobante', CASE
          WHEN comp.id IS NOT NULL
            THEN jsonb_build_object(
              'id',    comp.id,
              'numero', comp.numero,
              'tipo',  comp.tipo,
              'fecha', comp.fecha
            )
          WHEN ord_comp.id IS NOT NULL
            THEN jsonb_build_object(
              'id',    ord_comp.id,
              'numero', ord_comp.numero,
              'tipo',  ord_comp.tipo,
              'fecha', ord_comp.fecha
            )
          ELSE NULL
        END,
        'order', CASE
          WHEN ord.id IS NOT NULL
            THEN jsonb_build_object('id', ord.id)
          ELSE NULL
        END
      ) AS row_data,
      m.created_at AS mov_ts
    FROM public.inventory_movements m
    -- Supplier directly on movement
    LEFT JOIN public.suppliers sup ON m.supplier_id = sup.id
    -- Comprobante for sales
    LEFT JOIN public.comprobantes comp
      ON m.reference_type = 'comprobante' AND m.reference_id = comp.id
    -- Comprobante item (price + tipo_linea) — LIMIT 1 prevents duplicates
    LEFT JOIN LATERAL (
      SELECT precio_unitario, tipo_linea, stock_processed, id
      FROM public.comprobante_items
      WHERE comprobante_id = comp.id AND inventory_id = p_inventory_id
      ORDER BY created_at
      LIMIT 1
    ) ci ON true
    -- Customer via comprobante
    LEFT JOIN public.customers cust ON comp.customer_id = cust.id
    -- Order for order_usage
    LEFT JOIN public.orders ord
      ON m.reference_type = 'order' AND m.reference_id = ord.id
    -- Customer via order
    LEFT JOIN public.customers ord_cust ON ord.customer_id = ord_cust.id
    -- Comprobante from order (to detect charged_to_customer)
    LEFT JOIN public.comprobantes ord_comp ON ord.comprobante_id = ord_comp.id
    -- Comprobante item from order's comprobante — used for charged_to_customer check
    LEFT JOIN LATERAL (
      SELECT id
      FROM public.comprobante_items
      WHERE comprobante_id = ord.comprobante_id AND inventory_id = p_inventory_id
      LIMIT 1
    ) ci_ord ON true
    WHERE m.inventory_item_id = p_inventory_id
      AND m.business_id = p_business_id
  ) sub;

  -- ── Summary stats ─────────────────────────────────────────────────────────
  SELECT
    COALESCE(SUM(CASE WHEN quantity > 0 THEN  quantity          ELSE 0 END), 0)::integer,
    COALESCE(SUM(CASE WHEN quantity < 0 THEN ABS(quantity)      ELSE 0 END), 0)::integer,
    COALESCE(SUM(CASE WHEN movement_type = 'sale'        THEN ABS(quantity) ELSE 0 END), 0)::integer,
    COALESCE(SUM(CASE WHEN movement_type = 'order_usage' THEN ABS(quantity) ELSE 0 END), 0)::integer,
    COALESCE(SUM(CASE WHEN quantity < 0 THEN ABS(quantity)::numeric * COALESCE(unit_cost, v_inv.cost_price) ELSE 0 END), 0),
    MAX(created_at),
    COUNT(*)::integer
  INTO v_total_in, v_total_out, v_sold_qty, v_used_qty, v_total_cost, v_last_mov, v_mov_count
  FROM public.inventory_movements
  WHERE inventory_item_id = p_inventory_id
    AND business_id = p_business_id;

  -- Total revenue from comprobante_items
  SELECT COALESCE(SUM(ci2.precio_unitario * ci2.cantidad), 0)
  INTO v_revenue
  FROM public.comprobante_items ci2
  JOIN public.comprobantes c2 ON ci2.comprobante_id = c2.id
  WHERE ci2.inventory_id = p_inventory_id
    AND c2.business_id = p_business_id
    AND c2.estado != 'anulado';

  -- Stock calculated from movements
  SELECT COALESCE(SUM(quantity), 0)::integer
  INTO v_stock_calc
  FROM public.inventory_movements
  WHERE inventory_item_id = p_inventory_id AND business_id = p_business_id;

  -- ── Integrity alerts ──────────────────────────────────────────────────────
  IF v_inv.stock_quantity < 0 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'severity',    'critical',
      'title',       'Stock negativo',
      'description', 'El producto tiene stock ' || v_inv.stock_quantity || '. Revisá las salidas registradas.'
    ));
  END IF;

  IF ABS(v_stock_calc - v_inv.stock_quantity) > 0 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'severity',    'warning',
      'title',       'Stock inconsistente',
      'description', 'Suma de movimientos: ' || v_stock_calc ||
                     ' — Stock actual: ' || v_inv.stock_quantity ||
                     '. Diferencia: ' || (v_inv.stock_quantity - v_stock_calc) || '.'
    ));
  END IF;

  -- Salidas without reference (unexpected manual out)
  DECLARE
    v_orphan_count integer;
  BEGIN
    SELECT COUNT(*)::integer INTO v_orphan_count
    FROM public.inventory_movements
    WHERE inventory_item_id = p_inventory_id
      AND business_id = p_business_id
      AND quantity < 0
      AND reference_type IS NULL
      AND movement_type NOT IN ('adjustment', 'out');

    IF v_orphan_count > 0 THEN
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
        'severity',    'low',
        'title',       'Salidas sin referencia',
        'description', v_orphan_count || ' salida(s) no tienen comprobante ni orden asociada.'
      ));
    END IF;
  END;

  RETURN jsonb_build_object(
    'ok',      true,
    'product', jsonb_build_object(
      'id',            v_inv.id,
      'name',          v_inv.name,
      'code',          v_inv.code,
      'category',      v_inv.category,
      'description',   v_inv.description,
      'current_stock', v_inv.stock_quantity,
      'cost_price',    v_inv.cost_price,
      'sale_price',    v_inv.sale_price
    ),
    'summary', jsonb_build_object(
      'total_in',                v_total_in,
      'total_out',               v_total_out,
      'sold_quantity',           v_sold_qty,
      'internal_used_quantity',  v_used_qty,
      'total_revenue',           v_revenue,
      'total_cost',              v_total_cost,
      'estimated_margin',        v_revenue - v_total_cost,
      'movement_count',          v_mov_count,
      'last_movement_at',        v_last_mov,
      'stock_from_movements',    v_stock_calc
    ),
    'movements', COALESCE(v_movs_json, '[]'::jsonb),
    'alerts',    v_alerts
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."inventory_product_history"("p_business_id" "uuid", "p_inventory_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_owner_or_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(
    public.current_user_role() in ('owner', 'admin'),
    false
  )
$$;


ALTER FUNCTION "public"."is_owner_or_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_platform_admin"("p_user_id" "uuid", "p_min_role" "text" DEFAULT NULL::"text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.system_admins sa
    WHERE sa.user_id = p_user_id
      AND sa.is_active = TRUE
      AND public._admin_role_weight(sa.role)
          >= public._admin_role_weight(COALESCE(p_min_role, 'support_readonly'))
  );
$$;


ALTER FUNCTION "public"."is_platform_admin"("p_user_id" "uuid", "p_min_role" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_staff"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(
    public.current_user_role() in ('owner', 'admin', 'manager', 'tech', 'sales', 'cashier', 'viewer'),
    false
  )
$$;


ALTER FUNCTION "public"."is_staff"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."link_profile_to_auth_user"() RETURNS TABLE("id" "uuid", "user_id" "uuid", "business_id" "uuid", "role" "text", "is_active" boolean, "full_name" "text", "email" "text", "phone" "text", "created_at" timestamp with time zone, "updated_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_auth_id    uuid;
  v_auth_email text;
  v_profile_id uuid;
BEGIN
  v_auth_id    := auth.uid();
  IF v_auth_id IS NULL THEN RETURN; END IF;

  SELECT lower(u.email) INTO v_auth_email
  FROM auth.users u WHERE u.id = v_auth_id;

  IF v_auth_email IS NULL THEN RETURN; END IF;

  -- Buscar profile por email que tenga un user_id distinto
  SELECT p.id INTO v_profile_id
  FROM profiles p
  WHERE lower(COALESCE(p.email, '')) = v_auth_email
    AND COALESCE(p.user_id, p.id) <> v_auth_id
  ORDER BY (p.business_id IS NOT NULL) DESC
  LIMIT 1;

  IF v_profile_id IS NULL THEN RETURN; END IF;

  -- Vincular el profile al auth user actual (sin perder business_id)
  UPDATE profiles
  SET user_id    = v_auth_id,
      updated_at = now()
  WHERE id = v_profile_id;

  -- Devolver el profile actualizado
  RETURN QUERY
  SELECT
    p.id,
    p.user_id,
    p.business_id,
    p.role::text,
    COALESCE(p.is_active, TRUE),
    p.full_name,
    p.email,
    p.phone,
    COALESCE(p.created_at, NOW()),
    COALESCE(p.updated_at, NOW())
  FROM profiles p
  WHERE p.id = v_profile_id;
END;
$$;


ALTER FUNCTION "public"."link_profile_to_auth_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pay_card_statement_atomic"("p_user_id" "uuid", "p_card_id" "uuid", "p_account_id" "uuid", "p_period" "text", "p_amount" numeric, "p_currency" "text", "p_date" "date", "p_card_name" "text", "p_notes" "text" DEFAULT ''::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_tx      record;
  v_payment record;
BEGIN
  -- Ownership / existence checks
  IF NOT EXISTS (
    SELECT 1 FROM public.personal_credit_cards
    WHERE id = p_card_id AND user_id = p_user_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'card_not_found', 'message', 'Tarjeta no encontrada');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.personal_accounts
    WHERE id = p_account_id AND user_id = p_user_id AND is_active = true
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_not_found', 'message', 'Cuenta no encontrada o inactiva');
  END IF;

  -- Duplicate period check (also caught by UNIQUE constraint below as safety net)
  IF EXISTS (
    SELECT 1 FROM public.personal_card_payments
    WHERE user_id = p_user_id AND credit_card_id = p_card_id AND period = p_period
  ) THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'already_paid',
      'message', 'Ya existe un pago registrado para el período ' || p_period
    );
  END IF;

  -- Create expense transaction
  INSERT INTO public.personal_transactions (
    user_id, account_id, category_id, type, amount, currency,
    date, description, notes, payment_method, linked_owner_withdrawal_id
  ) VALUES (
    p_user_id, p_account_id, NULL, 'expense', p_amount, p_currency,
    p_date,
    'Pago tarjeta ' || p_card_name || ' (' || p_period || ')',
    NULLIF(trim(COALESCE(p_notes, '')), ''),
    NULL, NULL
  ) RETURNING * INTO v_tx;

  -- Update multi-currency balance row
  UPDATE public.personal_account_balances
  SET current_balance = current_balance - p_amount,
      updated_at      = now()
  WHERE account_id = p_account_id AND currency = p_currency;

  -- Fallback: update personal_accounts.current_balance for legacy single-currency accounts
  UPDATE public.personal_accounts
  SET current_balance = current_balance - p_amount,
      updated_at      = now()
  WHERE id = p_account_id AND currency = p_currency
    AND NOT EXISTS (
      SELECT 1 FROM public.personal_account_balances
      WHERE account_id = p_account_id AND currency = p_currency
    );

  -- Record statement payment (UNIQUE constraint provides final duplicate guard)
  INSERT INTO public.personal_card_payments (
    user_id, credit_card_id, period, amount, currency,
    account_id, transaction_id, payment_date, notes
  ) VALUES (
    p_user_id, p_card_id, p_period, p_amount, p_currency,
    p_account_id, v_tx.id, p_date,
    NULLIF(trim(COALESCE(p_notes, '')), '')
  ) RETURNING * INTO v_payment;

  RETURN jsonb_build_object(
    'ok',            true,
    'payment_id',    v_payment.id,
    'transaction_id', v_tx.id
  );

EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_paid', 'message', 'Ya existe un pago para este período');
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."pay_card_statement_atomic"("p_user_id" "uuid", "p_card_id" "uuid", "p_account_id" "uuid", "p_period" "text", "p_amount" numeric, "p_currency" "text", "p_date" "date", "p_card_name" "text", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pay_personal_debt"("p_debt_id" "uuid", "p_account_id" "uuid", "p_amount" numeric, "p_date" "date", "p_notes" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_user_id    uuid := auth.uid();
  v_debt       personal_debts%rowtype;
  v_account    personal_accounts%rowtype;
  v_tx_id      uuid;
  v_payment_id uuid;
  v_new_bal    numeric;
  v_cat_id     uuid;
begin
  -- Validate debt ownership
  select * into v_debt from personal_debts
  where id = p_debt_id and user_id = v_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Deuda no encontrada');
  end if;
  if v_debt.status = 'paid' then
    return jsonb_build_object('ok', false, 'error', 'La deuda ya está pagada');
  end if;
  if p_amount > v_debt.current_balance then
    return jsonb_build_object('ok', false, 'error', 'El monto supera el saldo restante');
  end if;

  -- Validate account ownership
  select * into v_account from personal_accounts
  where id = p_account_id and user_id = v_user_id and is_active = true;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Cuenta no encontrada');
  end if;

  -- Find or skip debt category (graceful fallback to null)
  select id into v_cat_id from personal_categories
  where user_id = v_user_id and type = 'expense'
    and (lower(name) like '%deuda%' or lower(name) like '%pr%stamo%' or lower(name) like '%cuota%')
  limit 1;

  -- Create expense transaction
  insert into personal_transactions (
    user_id, account_id, category_id, type, amount, currency,
    date, description, notes, payment_method, linked_owner_withdrawal_id
  ) values (
    v_user_id, p_account_id, v_cat_id, 'expense', p_amount, v_debt.currency,
    p_date, 'Pago deuda: ' || v_debt.name, p_notes, null, null
  ) returning id into v_tx_id;

  -- Debit account balance
  perform personal_update_currency_balance(p_account_id, v_debt.currency, -p_amount);

  -- Reduce debt balance
  v_new_bal := v_debt.current_balance - p_amount;
  update personal_debts
  set current_balance = v_new_bal,
      status = case when v_new_bal <= 0 then 'paid' else status end
  where id = p_debt_id;

  -- Record payment
  insert into personal_debt_payments (
    user_id, debt_id, account_id, currency, amount,
    payment_date, notes, transaction_id
  ) values (
    v_user_id, p_debt_id, p_account_id, v_debt.currency, p_amount,
    p_date, p_notes, v_tx_id
  ) returning id into v_payment_id;

  return jsonb_build_object(
    'ok', true,
    'payment_id', v_payment_id,
    'transaction_id', v_tx_id,
    'new_balance', v_new_bal,
    'paid_off', v_new_bal <= 0
  );
exception when others then
  return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


ALTER FUNCTION "public"."pay_personal_debt"("p_debt_id" "uuid", "p_account_id" "uuid", "p_amount" numeric, "p_date" "date", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pay_recurring_expense"("p_expense_id" "uuid", "p_account_id" "uuid", "p_amount" numeric, "p_paid_date" "date", "p_notes" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $_$
declare
  v_user_id    uuid := auth.uid();
  v_expense    personal_recurring_expenses%rowtype;
  v_account    personal_accounts%rowtype;
  v_tx_id      uuid;
  v_payment_id uuid;
  v_period_y   int  := extract(year  from p_paid_date)::int;
  v_period_m   int  := extract(month from p_paid_date)::int;
  v_next_due   date;
  v_cat_id     uuid;
begin
  -- Validate ownership of expense
  select * into v_expense from personal_recurring_expenses
  where id = p_expense_id and user_id = v_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Gasto fijo no encontrado');
  end if;
  if v_expense.status = 'cancelled' then
    return jsonb_build_object('ok', false, 'error', 'El gasto fijo está cancelado');
  end if;
  if p_amount <= 0 then
    return jsonb_build_object('ok', false, 'error', 'El monto debe ser mayor a $0');
  end if;

  -- Validate ownership of account
  select * into v_account from personal_accounts
  where id = p_account_id and user_id = v_user_id and is_active = true;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Cuenta no encontrada');
  end if;

  -- Check for duplicate payment this month
  if exists (
    select 1 from personal_recurring_expense_payments
    where recurring_expense_id = p_expense_id
      and period_year = v_period_y and period_month = v_period_m
  ) then
    return jsonb_build_object('ok', false, 'error', 'Ya se registró un pago para este mes');
  end if;

  -- Resolve category: use expense's category_id or find expense-type category
  v_cat_id := v_expense.category_id;
  if v_cat_id is null then
    select id into v_cat_id from personal_categories
    where user_id = v_user_id and type = 'expense'
      and (lower(name) like '%servicio%' or lower(name) like '%fijo%'
           or lower(name) like '%gasto%' or lower(name) like '%hogar%')
    limit 1;
  end if;

  -- Create expense transaction
  insert into personal_transactions (
    user_id, account_id, category_id, type, amount, currency,
    date, description, notes, payment_method, linked_owner_withdrawal_id
  ) values (
    v_user_id, p_account_id, v_cat_id, 'expense', p_amount, v_expense.currency,
    p_paid_date, 'Gasto fijo: ' || v_expense.name, p_notes, null, null
  ) returning id into v_tx_id;

  -- Debit account
  perform personal_update_currency_balance(p_account_id, v_expense.currency, -p_amount);

  -- Record payment
  insert into personal_recurring_expense_payments (
    user_id, recurring_expense_id, account_id, transaction_id,
    currency, amount, paid_date, period_year, period_month, notes
  ) values (
    v_user_id, p_expense_id, p_account_id, v_tx_id,
    v_expense.currency, p_amount, p_paid_date, v_period_y, v_period_m, p_notes
  ) returning id into v_payment_id;

  -- Advance next_due_date to next cycle
  if v_expense.due_day is not null then
    v_next_due := (
      date_trunc('month', p_paid_date + interval '1 month')
      + (v_expense.due_day - 1) * interval '1 day'
    )::date;
    -- Clamp to end of month
    v_next_due := least(v_next_due,
      (date_trunc('month', p_paid_date + interval '1 month')
       + interval '1 month - 1 day')::date
    );
    update personal_recurring_expenses
    set next_due_date = v_next_due
    where id = p_expense_id;
  end if;

  return jsonb_build_object(
    'ok',            true,
    'payment_id',    v_payment_id,
    'transaction_id', v_tx_id,
    'next_due_date', v_next_due
  );
exception when others then
  return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$_$;


ALTER FUNCTION "public"."pay_recurring_expense"("p_expense_id" "uuid", "p_account_id" "uuid", "p_amount" numeric, "p_paid_date" "date", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pay_supplier_purchase_atomic"("p_business_id" "uuid", "p_supplier_id" "uuid", "p_user_id" "uuid", "p_supplier_name" "text", "p_purchase_id" "uuid", "p_payment_date" "date", "p_amount" numeric, "p_payment_method" "text", "p_notes" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_purchase   record;
  v_payment    record;
  v_fm         record;
  v_new_paid   numeric;
  v_new_pend   numeric;
  v_new_status text;
  v_note_sfx   text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El monto debe ser mayor a 0');
  END IF;

  SELECT * INTO v_purchase
  FROM public.supplier_purchases
  WHERE id = p_purchase_id AND business_id = p_business_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Compra no encontrada');
  END IF;

  IF v_purchase.pending_amount <= 0.01 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'La compra ya está completamente pagada');
  END IF;

  IF p_amount > v_purchase.pending_amount + 0.01 THEN
    RETURN jsonb_build_object('ok', false, 'error',
      'El pago (' || p_amount || ') supera el saldo pendiente (' || v_purchase.pending_amount || ')');
  END IF;

  v_note_sfx := CASE WHEN trim(COALESCE(p_notes,'')) <> '' THEN ' — ' || p_notes ELSE '' END;

  v_new_paid := v_purchase.paid_amount + p_amount;
  v_new_pend := GREATEST(0, v_purchase.total_amount - v_new_paid);
  IF v_new_paid <= 0                                 THEN v_new_status := 'pending';
  ELSIF v_new_paid >= v_purchase.total_amount - 0.01 THEN v_new_status := 'paid';
  ELSE v_new_status := 'partial';
  END IF;

  INSERT INTO public.financial_movements (
    business_id, date, type, currency, amount, amount_ars, exchange_rate,
    source, description, created_by, metodo_pago,
    sign, reference_id, reference_type
  ) VALUES (
    p_business_id, p_payment_date, 'expense', 'ARS',
    p_amount, p_amount, 1,
    'pago_proveedor',
    'Pago a ' || p_supplier_name || v_note_sfx,
    p_user_id,
    NULLIF(trim(COALESCE(p_payment_method, '')), ''),
    1, p_purchase_id, 'supplier_purchase'
  ) RETURNING * INTO v_fm;

  INSERT INTO public.business_finance_entries (
    business_id, date, type, category, description,
    amount, currency, amount_ars, exchange_rate,
    payment_method, created_by, source
  ) VALUES (
    p_business_id, p_payment_date, 'variable_cost', 'compras_proveedor',
    'Pago a ' || p_supplier_name || v_note_sfx,
    p_amount, 'ARS', p_amount, 1,
    NULLIF(trim(COALESCE(p_payment_method, '')), ''),
    p_user_id, 'pago_proveedor'
  );

  INSERT INTO public.supplier_payments (
    business_id, supplier_id, purchase_id, payment_date,
    amount, payment_method, notes, created_by, financial_movement_id
  ) VALUES (
    p_business_id, p_supplier_id, p_purchase_id, p_payment_date,
    p_amount,
    COALESCE(NULLIF(trim(COALESCE(p_payment_method,'')), ''), 'efectivo'),
    NULLIF(trim(COALESCE(p_notes,'')), ''),
    p_user_id, v_fm.id
  ) RETURNING * INTO v_payment;

  INSERT INTO public.supplier_account_movements (
    business_id, supplier_id, purchase_id, payment_id,
    movement_date, type, description, debit, credit, balance_after
  ) VALUES (
    p_business_id, p_supplier_id, p_purchase_id, v_payment.id,
    p_payment_date, 'payment',
    'Pago a ' || p_supplier_name || v_note_sfx,
    0, p_amount, 0
  );

  UPDATE public.supplier_purchases
     SET paid_amount    = v_new_paid,
         pending_amount = v_new_pend,
         payment_status = v_new_status,
         updated_at     = now()
   WHERE id = p_purchase_id AND business_id = p_business_id;

  RETURN jsonb_build_object('ok', true, 'payment_id', v_payment.id, 'new_status', v_new_status);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."pay_supplier_purchase_atomic"("p_business_id" "uuid", "p_supplier_id" "uuid", "p_user_id" "uuid", "p_supplier_name" "text", "p_purchase_id" "uuid", "p_payment_date" "date", "p_amount" numeric, "p_payment_method" "text", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."personal_savings_goal_operation"("p_goal_id" "uuid", "p_account_id" "uuid", "p_amount" numeric, "p_operation" "text", "p_date" "date", "p_notes" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_user_id    uuid := auth.uid();
  v_goal       personal_savings_goals%ROWTYPE;
  v_new_amount numeric;
  v_tx_type    text;
  v_description text;
  v_delta      numeric;
  v_tx_id      uuid;
BEGIN
  -- Auth
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No autenticado');
  END IF;

  -- Validate amount
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El monto debe ser mayor a 0');
  END IF;

  -- Lock & verify goal ownership
  SELECT * INTO v_goal
  FROM personal_savings_goals
  WHERE id = p_goal_id AND user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Objetivo no encontrado');
  END IF;

  IF v_goal.status = 'cancelled' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No se puede operar sobre un objetivo cancelado');
  END IF;

  -- Verify account ownership and active status
  IF NOT EXISTS (
    SELECT 1 FROM personal_accounts
    WHERE id = p_account_id AND user_id = v_user_id AND is_active = true
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Cuenta no encontrada o inactiva');
  END IF;

  -- Determine operation
  IF p_operation = 'contribute' THEN
    v_new_amount  := v_goal.current_amount + p_amount;
    v_tx_type     := 'expense';
    v_description := 'Aporte a ahorro: ' || v_goal.name;
    v_delta       := -p_amount;   -- debit account

  ELSIF p_operation = 'withdraw' THEN
    IF p_amount > v_goal.current_amount THEN
      RETURN jsonb_build_object('ok', false, 'error', 'No podés retirar más de lo ahorrado');
    END IF;
    v_new_amount  := v_goal.current_amount - p_amount;
    v_tx_type     := 'income';
    v_description := 'Retiro de ahorro: ' || v_goal.name;
    v_delta       := p_amount;    -- credit account

  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'Operación no válida');
  END IF;

  -- Update goal
  UPDATE personal_savings_goals
  SET current_amount = v_new_amount,
      updated_at     = now()
  WHERE id = p_goal_id AND user_id = v_user_id;

  -- Insert transaction
  INSERT INTO personal_transactions (
    user_id, account_id, type, amount, currency,
    date, description, notes, payment_method, linked_owner_withdrawal_id
  ) VALUES (
    v_user_id, p_account_id, v_tx_type, p_amount, v_goal.currency,
    p_date, v_description, p_notes, NULL, NULL
  ) RETURNING id INTO v_tx_id;

  -- Update account balance
  UPDATE personal_accounts
  SET current_balance = current_balance + v_delta,
      updated_at      = now()
  WHERE id = p_account_id AND user_id = v_user_id;

  RETURN jsonb_build_object(
    'ok',         true,
    'new_amount', v_new_amount,
    'tx_id',      v_tx_id
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."personal_savings_goal_operation"("p_goal_id" "uuid", "p_account_id" "uuid", "p_amount" numeric, "p_operation" "text", "p_date" "date", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."personal_update_balance"("p_account_id" "uuid", "p_delta" numeric) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_currency text;
BEGIN
  -- Obtener moneda primaria de la cuenta
  SELECT currency INTO v_currency
  FROM   personal_accounts
  WHERE  id = p_account_id AND user_id = auth.uid();

  -- Actualizar personal_accounts (comportamiento original)
  UPDATE personal_accounts
  SET    current_balance = current_balance + p_delta,
         updated_at      = now()
  WHERE  id = p_account_id AND user_id = auth.uid();

  -- Sincronizar personal_account_balances para la moneda primaria
  UPDATE personal_account_balances
  SET    current_balance = current_balance + p_delta,
         updated_at      = now()
  WHERE  account_id = p_account_id
    AND  user_id    = auth.uid()
    AND  currency   = v_currency;
END;
$$;


ALTER FUNCTION "public"."personal_update_balance"("p_account_id" "uuid", "p_delta" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."personal_update_currency_balance"("p_account_id" "uuid", "p_currency" "text", "p_delta" numeric) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_rows   int;
  v_prim   text;
BEGIN
  -- Obtener moneda primaria
  SELECT currency INTO v_prim
  FROM   personal_accounts
  WHERE  id = p_account_id AND user_id = auth.uid();

  -- Intentar actualizar entrada existente
  UPDATE personal_account_balances
  SET    current_balance = current_balance + p_delta,
         updated_at      = now()
  WHERE  account_id = p_account_id
    AND  user_id    = auth.uid()
    AND  currency   = p_currency;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    -- No existe la entrada: actualizar personal_accounts si moneda coincide
    UPDATE personal_accounts
    SET    current_balance = current_balance + p_delta,
           updated_at      = now()
    WHERE  id = p_account_id
      AND  user_id = auth.uid()
      AND  currency = p_currency;
  ELSIF v_prim = p_currency THEN
    -- Moneda primaria: también sincronizar personal_accounts
    UPDATE personal_accounts
    SET    current_balance = current_balance + p_delta,
           updated_at      = now()
    WHERE  id = p_account_id AND user_id = auth.uid();
  END IF;
END;
$$;


ALTER FUNCTION "public"."personal_update_currency_balance"("p_account_id" "uuid", "p_currency" "text", "p_delta" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."preview_missing_stock_movements"("p_business_id" "uuid") RETURNS TABLE("source" "text", "sale_id" "uuid", "item_id" "uuid", "inventory_id" "uuid", "product_name" "text", "quantity" numeric, "current_stock" integer, "can_deduct" boolean, "sale_date" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
  SELECT * FROM (
    SELECT
      'comprobante'::text,
      ci.comprobante_id,
      ci.id,
      ci.inventory_id,
      COALESCE(inv.name, '(sin nombre)'),
      ci.cantidad,
      COALESCE(inv.stock_quantity, 0),
      (COALESCE(inv.stock_quantity, 0) >= ci.cantidad::integer),
      c.created_at
    FROM comprobante_items ci
    JOIN comprobantes c   ON c.id  = ci.comprobante_id
    JOIN inventory    inv ON inv.id = ci.inventory_id
    WHERE ci.business_id   = p_business_id
      AND ci.inventory_id  IS NOT NULL
      AND ci.cantidad        > 0
      AND (ci.stock_processed = false OR ci.stock_processed IS NULL)
      AND c.estado          NOT IN ('anulado')
      AND c.status          NOT IN ('cancelled')
      AND c.estado_comercial NOT IN ('anulado')
      AND c.estado_comercial IS DISTINCT FROM NULL

    UNION ALL

    SELECT
      'wholesale_order'::text,
      woi.order_id,
      woi.id,
      woi.inventory_item_id,
      COALESCE(inv.name, '(sin nombre)'),
      woi.quantity::numeric,
      COALESCE(inv.stock_quantity, 0),
      (COALESCE(inv.stock_quantity, 0) >= woi.quantity),
      wo.created_at
    FROM wholesale_order_items woi
    JOIN wholesale_orders wo  ON wo.id  = woi.order_id
    JOIN inventory        inv ON inv.id = woi.inventory_item_id
    WHERE woi.business_id      = p_business_id
      AND woi.inventory_item_id IS NOT NULL
      AND woi.quantity           > 0
      AND (woi.stock_processed = false OR woi.stock_processed IS NULL)
      AND wo.status NOT IN ('cancelled', 'rejected')
  ) sub
  ORDER BY sub.created_at;
$$;


ALTER FUNCTION "public"."preview_missing_stock_movements"("p_business_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."process_mp_subscription_payment"("p_external_ref" "text", "p_mp_payment_id" "text", "p_mp_status" "text", "p_amount" numeric, "p_currency" "text" DEFAULT 'ARS'::"text", "p_raw_payload" "jsonb" DEFAULT NULL::"jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_session record;
  v_biz_id  uuid;
  v_result  text;
  v_msg     text;
BEGIN
  -- ── Idempotencia: payment_id ya registrado ────────────────────────────────
  IF EXISTS (SELECT 1 FROM subscription_payments WHERE provider_payment_id = p_mp_payment_id) THEN
    v_result := 'already_processed';
    v_msg    := 'Payment already registered: ' || p_mp_payment_id;
    INSERT INTO subscription_webhook_logs(business_id,event_type,mp_payment_id,mp_status,external_ref,result,error_msg,raw_payload)
    VALUES(NULL,'payment',p_mp_payment_id,p_mp_status,p_external_ref,v_result,v_msg,p_raw_payload);
    RETURN jsonb_build_object('result',v_result,'message',v_msg);
  END IF;

  -- ── Buscar sesión ─────────────────────────────────────────────────────────
  SELECT * INTO v_session
  FROM subscription_checkout_sessions
  WHERE external_reference = p_external_ref
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    v_result := 'not_found';
    v_msg    := 'Session not found: ' || COALESCE(p_external_ref,'null');
    INSERT INTO subscription_webhook_logs(business_id,event_type,mp_payment_id,mp_status,external_ref,result,error_msg,raw_payload)
    VALUES(NULL,'payment',p_mp_payment_id,p_mp_status,p_external_ref,v_result,v_msg,p_raw_payload);
    RETURN jsonb_build_object('result',v_result,'message',v_msg);
  END IF;

  v_biz_id := v_session.business_id;

  -- ── Sesión ya pagada ──────────────────────────────────────────────────────
  IF v_session.status = 'paid' THEN
    v_result := 'already_processed';
    v_msg    := 'Session already paid';
    INSERT INTO subscription_webhook_logs(business_id,event_type,mp_payment_id,mp_status,external_ref,result,error_msg,raw_payload)
    VALUES(v_biz_id,'payment',p_mp_payment_id,p_mp_status,p_external_ref,v_result,v_msg,p_raw_payload);
    RETURN jsonb_build_object('result',v_result,'message',v_msg);
  END IF;

  -- ── Pago no aprobado ──────────────────────────────────────────────────────
  IF p_mp_status != 'approved' THEN
    UPDATE subscription_checkout_sessions
    SET status = CASE p_mp_status
                   WHEN 'rejected'  THEN 'failed'
                   WHEN 'cancelled' THEN 'canceled'
                   ELSE 'pending'
                 END,
        updated_at = now()
    WHERE id = v_session.id;
    v_result := 'not_approved';
    v_msg    := 'MP status: ' || p_mp_status;
    INSERT INTO subscription_webhook_logs(business_id,event_type,mp_payment_id,mp_status,external_ref,result,error_msg,raw_payload)
    VALUES(v_biz_id,'payment',p_mp_payment_id,p_mp_status,p_external_ref,v_result,v_msg,p_raw_payload);
    RETURN jsonb_build_object('result',v_result,'mp_status',p_mp_status);
  END IF;

  -- ── Validar monto (±5%) ───────────────────────────────────────────────────
  IF v_session.amount > 0 AND ABS(p_amount - v_session.amount) / v_session.amount > 0.05 THEN
    v_result := 'amount_mismatch';
    v_msg    := 'Expected ' || v_session.amount || ' got ' || p_amount;
    INSERT INTO subscription_webhook_logs(business_id,event_type,mp_payment_id,mp_status,external_ref,result,error_msg,raw_payload)
    VALUES(v_biz_id,'payment',p_mp_payment_id,p_mp_status,p_external_ref,v_result,v_msg,p_raw_payload);
    RETURN jsonb_build_object('result',v_result,'expected',v_session.amount,'received',p_amount);
  END IF;

  -- ── Marcar sesión pagada ──────────────────────────────────────────────────
  UPDATE subscription_checkout_sessions
  SET status = 'paid', updated_at = now()
  WHERE id = v_session.id;

  -- ── Registrar pago ────────────────────────────────────────────────────────
  INSERT INTO subscription_payments(business_id,checkout_session_id,plan_id,billing_cycle,amount,currency,provider,provider_payment_id,status,paid_at)
  VALUES(v_biz_id,v_session.id,v_session.plan_id,v_session.billing_cycle,p_amount,p_currency,'mercadopago',p_mp_payment_id,'approved',now())
  ON CONFLICT(provider_payment_id) DO NOTHING;

  -- ── Activar suscripción ───────────────────────────────────────────────────
  UPDATE businesses SET
    subscription_status   = 'active',
    subscription_plan     = v_session.plan_id,
    subscription_provider = 'mercadopago',
    current_period_start  = now(),
    current_period_end    = CASE v_session.billing_cycle
                              WHEN 'annual'    THEN now() + INTERVAL '1 year'
                              WHEN 'quarterly' THEN now() + INTERVAL '3 months'
                              ELSE now() + INTERVAL '1 month' END,
    last_payment_status   = 'approved',
    last_payment_id       = p_mp_payment_id,
    updated_at            = now()
  WHERE id = v_biz_id;

  -- ── Log éxito ─────────────────────────────────────────────────────────────
  v_result := 'success';
  v_msg    := 'Activated plan=' || v_session.plan_id;
  INSERT INTO subscription_webhook_logs(business_id,event_type,mp_payment_id,mp_status,external_ref,result,error_msg,raw_payload)
  VALUES(v_biz_id,'payment',p_mp_payment_id,p_mp_status,p_external_ref,v_result,v_msg,p_raw_payload);

  RETURN jsonb_build_object(
    'result','success',
    'business_id',v_biz_id,
    'plan_id',v_session.plan_id,
    'billing_cycle',v_session.billing_cycle
  );
END;
$$;


ALTER FUNCTION "public"."process_mp_subscription_payment"("p_external_ref" "text", "p_mp_payment_id" "text", "p_mp_status" "text", "p_amount" numeric, "p_currency" "text", "p_raw_payload" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."protect_subscription_columns"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_role text := current_user;
  v_changed boolean;
BEGIN
  IF v_role NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  v_changed :=
       NEW.subscription_status     IS DISTINCT FROM OLD.subscription_status
    OR NEW.subscription_plan       IS DISTINCT FROM OLD.subscription_plan
    OR NEW.subscription_provider   IS DISTINCT FROM OLD.subscription_provider
    OR NEW.mp_preapproval_id       IS DISTINCT FROM OLD.mp_preapproval_id
    OR NEW.mp_preapproval_plan_id  IS DISTINCT FROM OLD.mp_preapproval_plan_id
    OR NEW.mp_payer_email          IS DISTINCT FROM OLD.mp_payer_email
    OR NEW.mp_last_modified         IS DISTINCT FROM OLD.mp_last_modified
    OR NEW.current_period_start    IS DISTINCT FROM OLD.current_period_start
    OR NEW.current_period_end      IS DISTINCT FROM OLD.current_period_end
    OR NEW.grace_until             IS DISTINCT FROM OLD.grace_until
    OR NEW.trial_ends_at           IS DISTINCT FROM OLD.trial_ends_at
    OR NEW.last_payment_id         IS DISTINCT FROM OLD.last_payment_id
    OR NEW.last_payment_status     IS DISTINCT FROM OLD.last_payment_status
    OR NEW.access_source           IS DISTINCT FROM OLD.access_source
    OR NEW.override_reason         IS DISTINCT FROM OLD.override_reason
    OR NEW.override_created_by     IS DISTINCT FROM OLD.override_created_by
    OR NEW.override_created_at     IS DISTINCT FROM OLD.override_created_at
    OR NEW.override_expires_at     IS DISTINCT FROM OLD.override_expires_at;
  IF v_changed THEN
    RAISE EXCEPTION
      'Direct modification of subscription/billing columns is not allowed. Use the billing RPCs (admin_*) or the verified backend (webhook).'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."protect_subscription_columns"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."recalcular_totales_comprobante"("p_comprobante_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_subtotal numeric := 0;
  v_impuestos numeric := 0;
  v_total numeric := 0;
  v_tipo text;
begin
  select tipo
  into v_tipo
  from public.comprobantes
  where id = p_comprobante_id;

  select
    coalesce(sum(subtotal), 0)
  into v_subtotal
  from public.comprobante_items
  where comprobante_id = p_comprobante_id;

  -- lógica básica de impuestos
  -- factura_a: IVA 21% separado
  -- factura_c / remito / nota_credito: sin discriminación automática
  if v_tipo = 'factura_a' then
    v_impuestos := round(v_subtotal * 0.21, 2);
  else
    v_impuestos := 0;
  end if;

  v_total := v_subtotal + v_impuestos;

  update public.comprobantes
  set
    subtotal = v_subtotal,
    impuestos = v_impuestos,
    total = v_total,
    updated_at = now()
  where id = p_comprobante_id;
end;
$$;


ALTER FUNCTION "public"."recalcular_totales_comprobante"("p_comprobante_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."recalculate_order_total"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_order_id UUID;
  v_total    NUMERIC(12,2);
  v_cost     NUMERIC(12,2);
BEGIN
  -- Determinar el order_id según operación
  IF TG_OP = 'DELETE' THEN
    v_order_id := OLD.order_id;
  ELSE
    v_order_id := NEW.order_id;
  END IF;

  -- Sumar precio total de ítems donde el cliente paga
  SELECT
    COALESCE(SUM(precio_unitario * cantidad), 0),
    COALESCE(SUM(costo_unitario  * cantidad), 0)
  INTO v_total, v_cost
  FROM order_items
  WHERE order_id = v_order_id;

  -- Actualizar la orden
  UPDATE orders
  SET
    estimated_total = v_total,
    total_cost      = v_cost,
    updated_at      = NOW()
  WHERE id = v_order_id;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;


ALTER FUNCTION "public"."recalculate_order_total"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."recalculate_product_prices"("p_business_id" "uuid", "p_new_rate" numeric) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  updated_count INT;
BEGIN
  -- Actualizar solo productos con auto_update_price = TRUE
  UPDATE public.inventory
  SET 
    sale_price = ROUND(base_price * p_new_rate, 2),
    cost_price = ROUND(cost_price * p_new_rate, 2), -- Asumiendo proporción similar
    exchange_rate_used = p_new_rate,
    updated_at = NOW()
  WHERE 
    business_id = p_business_id
    AND base_currency = 'USD'
    AND auto_update_price = TRUE
    AND exchange_rate_used IS NOT NULL;
  
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  
  RETURN updated_count;
END;
$$;


ALTER FUNCTION "public"."recalculate_product_prices"("p_business_id" "uuid", "p_new_rate" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."register_order_payment"("p_order_id" "uuid", "p_business_id" "uuid", "p_amount_paid" numeric DEFAULT NULL::numeric) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_total_ingresos NUMERIC(12,2);
  v_total_costos   NUMERIC(12,2);
BEGIN
  -- Obtener totales de ítems
  SELECT
    COALESCE(SUM(precio_unitario * cantidad), 0),
    COALESCE(SUM(costo_unitario  * cantidad), 0)
  INTO v_total_ingresos, v_total_costos
  FROM order_items
  WHERE order_id = p_order_id;

  -- Registrar ingreso en movimientos financieros
  INSERT INTO financial_movements (
    business_id, type, amount, description, reference_id, reference_type, created_at
  ) VALUES (
    p_business_id,
    'income',
    COALESCE(p_amount_paid, v_total_ingresos),
    'Cobro de orden #' || p_order_id,
    p_order_id,
    'order',
    NOW()
  );

  -- Registrar costo de repuestos (si los hay)
  IF v_total_costos > 0 THEN
    INSERT INTO financial_movements (
      business_id, type, amount, description, reference_id, reference_type, created_at
    ) VALUES (
      p_business_id,
      'expense',
      v_total_costos,
      'Costo de repuestos - orden #' || p_order_id,
      p_order_id,
      'order',
      NOW()
    );
  END IF;
END;
$$;


ALTER FUNCTION "public"."register_order_payment"("p_order_id" "uuid", "p_business_id" "uuid", "p_amount_paid" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."repair_missing_stock_movements"("p_business_id" "uuid", "p_allow_negative" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_comp_count     int     := 0;
  v_ws_count       int     := 0;
  v_skip_stock     int     := 0;
  v_skip_product   int     := 0;
  v_total_units    numeric := 0;
  v_movement_id    uuid;
  v_prev_stock     int;
  v_new_stock      int;
  r                record;
BEGIN

  FOR r IN
    SELECT ci.id, ci.comprobante_id, ci.inventory_id, ci.cantidad
    FROM   comprobante_items ci
    JOIN   comprobantes c ON c.id = ci.comprobante_id
    WHERE  ci.business_id   = p_business_id
      AND  ci.inventory_id  IS NOT NULL
      AND  ci.cantidad        > 0
      AND  (ci.stock_processed = false OR ci.stock_processed IS NULL)
      AND  c.estado          NOT IN ('anulado')
      AND  c.status          NOT IN ('cancelled')
      AND  c.estado_comercial NOT IN ('anulado')
      AND  c.estado_comercial IS DISTINCT FROM NULL
    FOR UPDATE OF ci SKIP LOCKED
  LOOP
    SELECT stock_quantity INTO v_prev_stock
    FROM inventory
    WHERE id = r.inventory_id AND business_id = p_business_id;

    IF NOT FOUND THEN v_skip_product := v_skip_product + 1; CONTINUE; END IF;

    IF v_prev_stock < r.cantidad::int AND NOT p_allow_negative THEN
      v_skip_stock := v_skip_stock + 1; CONTINUE;
    END IF;

    v_new_stock := v_prev_stock - r.cantidad::int;

    UPDATE inventory SET stock_quantity = v_new_stock, updated_at = now()
     WHERE id = r.inventory_id AND business_id = p_business_id;

    INSERT INTO inventory_movements
      (business_id, inventory_item_id, movement_type, quantity,
       previous_stock, new_stock, reference_type, reference_id, note)
    VALUES
      (p_business_id, r.inventory_id, 'sale', -r.cantidad::int,
       v_prev_stock, v_new_stock, 'comprobante', r.comprobante_id,
       'Reparación de stock — venta anterior')
    RETURNING id INTO v_movement_id;

    UPDATE comprobante_items
       SET stock_processed = true, stock_processed_at = now(), stock_movement_id = v_movement_id
     WHERE id = r.id;

    v_comp_count  := v_comp_count  + 1;
    v_total_units := v_total_units + r.cantidad;
  END LOOP;

  FOR r IN
    SELECT woi.id, woi.order_id, woi.inventory_item_id, woi.quantity
    FROM   wholesale_order_items woi
    JOIN   wholesale_orders wo ON wo.id = woi.order_id
    WHERE  woi.business_id       = p_business_id
      AND  woi.inventory_item_id IS NOT NULL
      AND  woi.quantity            > 0
      AND  (woi.stock_processed = false OR woi.stock_processed IS NULL)
      AND  wo.status NOT IN ('cancelled','rejected')
    FOR UPDATE OF woi SKIP LOCKED
  LOOP
    SELECT stock_quantity INTO v_prev_stock
    FROM inventory
    WHERE id = r.inventory_item_id AND business_id = p_business_id;

    IF NOT FOUND THEN v_skip_product := v_skip_product + 1; CONTINUE; END IF;

    IF v_prev_stock < r.quantity AND NOT p_allow_negative THEN
      v_skip_stock := v_skip_stock + 1; CONTINUE;
    END IF;

    v_new_stock := v_prev_stock - r.quantity;

    UPDATE inventory SET stock_quantity = v_new_stock, updated_at = now()
     WHERE id = r.inventory_item_id AND business_id = p_business_id;

    INSERT INTO inventory_movements
      (business_id, inventory_item_id, movement_type, quantity,
       previous_stock, new_stock, reference_type, reference_id, note)
    VALUES
      (p_business_id, r.inventory_item_id, 'sale', -r.quantity,
       v_prev_stock, v_new_stock, 'wholesale_order', r.order_id,
       'Reparación de stock — pedido mayorista anterior')
    RETURNING id INTO v_movement_id;

    UPDATE wholesale_order_items
       SET stock_processed = true, stock_processed_at = now(), stock_movement_id = v_movement_id
     WHERE id = r.id;

    v_ws_count    := v_ws_count    + 1;
    v_total_units := v_total_units + r.quantity;
  END LOOP;

  RETURN jsonb_build_object(
    'comprobantes_procesados',         v_comp_count,
    'pedidos_mayoristas_procesados',   v_ws_count,
    'items_sin_stock_suficiente',      v_skip_stock,
    'items_producto_no_encontrado',    v_skip_product,
    'total_unidades_descontadas',      v_total_units
  );
END;
$$;


ALTER FUNCTION "public"."repair_missing_stock_movements"("p_business_id" "uuid", "p_allow_negative" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."replace_comprobante_payment"("p_comprobante_id" "uuid", "p_business_id" "uuid", "p_payment_method" "text", "p_amount" numeric, "p_amount_ars" numeric, "p_currency" "text", "p_exchange_rate" numeric, "p_notes" "text", "p_user_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_tipo   TEXT;
BEGIN
  -- 1. Validar que el comprobante existe y pertenece al negocio
  SELECT tipo INTO v_tipo
  FROM comprobantes
  WHERE id = p_comprobante_id AND business_id = p_business_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Comprobante no encontrado');
  END IF;

  -- 2. Guardia: nota de crédito no tiene cobro editable
  IF v_tipo = 'nota_credito' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Las notas de credito no tienen cobro editable');
  END IF;

  -- 3. Guardia: cuenta corriente requiere flujo propio (cuentasService)
  IF p_payment_method = 'cuenta_corriente' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Para cuenta corriente usa el flujo de cobro normal');
  END IF;

  -- 4. Borrar TODOS los pagos existentes del comprobante.
  --    trig_comprobante_payment_sync (DELETE) recalcula: total_cobrado = 0,
  --    saldo_pendiente = total, estado_comercial = 'pendiente'.
  DELETE FROM comprobante_payments
  WHERE comprobante_id = p_comprobante_id
    AND business_id    = p_business_id;

  -- 5. Borrar financial_movements de ingresos generados por esos pagos.
  --    trig_comprobante_payment_finance solo dispara en INSERT, no limpia en DELETE.
  DELETE FROM financial_movements
  WHERE comprobante_id = p_comprobante_id
    AND business_id    = p_business_id
    AND type           = 'income'
    AND source         = 'comprobante';

  -- 6. Borrar business_finance_entries de ingresos generados por esos pagos.
  DELETE FROM business_finance_entries
  WHERE reference_comprobante_id = p_comprobante_id
    AND business_id = p_business_id
    AND type        = 'income'
    AND source      = 'comprobante';

  -- 7. Insertar el nuevo pago único.
  --    trig_comprobante_payment_sync (INSERT) recalcula total_cobrado = p_amount_ars.
  --    trig_comprobante_payment_finance (INSERT) crea financial_movements + BFE frescos.
  INSERT INTO comprobante_payments (
    comprobante_id, business_id,
    amount, currency, amount_ars, exchange_rate,
    payment_method, notes, date, created_by
  ) VALUES (
    p_comprobante_id, p_business_id,
    p_amount, p_currency, p_amount_ars, p_exchange_rate,
    p_payment_method, p_notes,
    CURRENT_DATE, p_user_id
  );

  RETURN jsonb_build_object('ok', true);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."replace_comprobante_payment"("p_comprobante_id" "uuid", "p_business_id" "uuid", "p_payment_method" "text", "p_amount" numeric, "p_amount_ars" numeric, "p_currency" "text", "p_exchange_rate" numeric, "p_notes" "text", "p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."seed_commission_defaults"("p_business_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE
  g_mp   UUID; g_visa UUID; g_nj UUID;
BEGIN
  -- Solo insertar si no existen grupos para este negocio
  IF EXISTS (SELECT 1 FROM public.payment_commission_groups WHERE business_id = p_business_id) THEN
    RETURN;
  END IF;

  -- MercadoPago
  INSERT INTO public.payment_commission_groups(business_id, name, slug, color, sort_order)
    VALUES (p_business_id, 'MercadoPago', 'mercadopago', '#009ee3', 1) RETURNING id INTO g_mp;
  INSERT INTO public.payment_commission_options(business_id, group_id, name, percentage, charge_mode, sort_order)
    VALUES (p_business_id, g_mp, 'Débito',    0.89,  'customer', 1),
           (p_business_id, g_mp, 'Crédito',   3.99,  'customer', 2),
           (p_business_id, g_mp, 'QR',        0.99,  'customer', 3);

  -- Visa / Mastercard
  INSERT INTO public.payment_commission_groups(business_id, name, slug, color, sort_order)
    VALUES (p_business_id, 'Visa / Mastercard', 'visa_mc', '#1a56db', 2) RETURNING id INTO g_visa;
  INSERT INTO public.payment_commission_options(business_id, group_id, name, percentage, charge_mode, sort_order)
    VALUES (p_business_id, g_visa, '1 cuota',   10.0,  'customer', 1),
           (p_business_id, g_visa, '3 cuotas',  22.1,  'customer', 2),
           (p_business_id, g_visa, '6 cuotas',  41.8,  'customer', 3),
           (p_business_id, g_visa, '12 cuotas', 95.3,  'customer', 4);

  -- Naranja X
  INSERT INTO public.payment_commission_groups(business_id, name, slug, color, sort_order)
    VALUES (p_business_id, 'Naranja X', 'naranja', '#f97316', 3) RETURNING id INTO g_nj;
  INSERT INTO public.payment_commission_options(business_id, group_id, name, percentage, charge_mode, sort_order)
    VALUES (p_business_id, g_nj, '1 cuota',   10.0,  'customer', 1),
           (p_business_id, g_nj, '3 cuotas',  22.8,  'customer', 2),
           (p_business_id, g_nj, '6 cuotas',  51.0,  'customer', 3),
           (p_business_id, g_nj, '12 cuotas', 87.0,  'customer', 4);
END;
$$;


ALTER FUNCTION "public"."seed_commission_defaults"("p_business_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."seed_expense_categories"("p_business_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.expense_categories WHERE business_id = p_business_id) THEN RETURN; END IF;
  INSERT INTO public.expense_categories(business_id, name, color, sort_order) VALUES
    (p_business_id, 'Inventario / Mercadería', '#6366f1', 1),
    (p_business_id, 'Operativos',              '#10b981', 2),
    (p_business_id, 'Equipamiento',            '#f59e0b', 3),
    (p_business_id, 'Marketing',               '#ec4899', 4),
    (p_business_id, 'Sueldos',                 '#06b6d4', 5),
    (p_business_id, 'Impuestos',               '#8b5cf6', 6),
    (p_business_id, 'Otros',                   '#64748b', 7);
END;
$$;


ALTER FUNCTION "public"."seed_expense_categories"("p_business_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_brands_normalized_name"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.normalized_name := lower(trim(NEW.name));
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_brands_normalized_name"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_device_models_normalized_name"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.normalized_name := lower(trim(NEW.name));
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_device_models_normalized_name"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_exchange_rate_on_product_save"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- Si es un producto USD y no tiene exchange_rate_used, obtener el actual
  IF NEW.base_currency = 'USD' AND (NEW.exchange_rate_used IS NULL OR NEW.exchange_rate_used = 0) THEN
    SELECT rate INTO NEW.exchange_rate_used
    FROM public.exchange_rates
    WHERE 
      business_id = NEW.business_id
      AND base_currency = 'USD'
      AND target_currency = 'ARS'
    ORDER BY updated_at DESC
    LIMIT 1;
    
    -- Si no hay cotización, usar 1.0 como fallback
    IF NEW.exchange_rate_used IS NULL OR NEW.exchange_rate_used = 0 THEN
      NEW.exchange_rate_used := 1.0;
    END IF;
  END IF;
  
  -- Si es USD y tiene base_price, calcular sale_price automáticamente
  IF NEW.base_currency = 'USD' AND NEW.base_price IS NOT NULL AND NEW.exchange_rate_used IS NOT NULL THEN
    NEW.sale_price := ROUND(NEW.base_price * NEW.exchange_rate_used, 2);
  END IF;
  
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_exchange_rate_on_product_save"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_user_active_status"("p_profile_id" "uuid", "p_is_active" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_business_id uuid;
  v_current_role text;
  v_target_user_id uuid;
begin
  select
    business_id,
    role,
    coalesce(user_id, id)
  into v_business_id, v_current_role, v_target_user_id
  from public.profiles
  where id = p_profile_id;

  if v_business_id is null then
    raise exception 'Perfil no encontrado';
  end if;

  if v_current_role = 'owner' then
    raise exception 'No se puede desactivar al owner';
  end if;

  if v_target_user_id = auth.uid() and p_is_active = false then
    raise exception 'No podes desactivarte a vos mismo';
  end if;

  if not exists (
    select 1
    from public.profiles p
    where coalesce(p.user_id, p.id) = auth.uid()
      and p.business_id = v_business_id
      and p.is_active = true
      and p.role in ('owner', 'admin')
  ) then
    raise exception 'No tenes permisos para cambiar el estado del usuario';
  end if;

  update public.profiles
  set is_active = p_is_active,
      updated_at = now()
  where id = p_profile_id;
end;
$$;


ALTER FUNCTION "public"."set_user_active_status"("p_profile_id" "uuid", "p_is_active" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_bfe_to_financial_movements"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- Tipos que impactan la caja directamente
  IF NEW.type NOT IN ('income', 'variable_cost', 'fixed_cost_local', 'fixed_cost_personal', 'salary') THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.financial_movements
    WHERE source_id = NEW.id AND source = 'bfe'
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.financial_movements (
    business_id, type, currency, amount, exchange_rate, amount_ars,
    source, source_id, description, date, created_by
  ) VALUES (
    NEW.business_id,
    -- income → income en caja; los costos → expense en caja
    CASE WHEN NEW.type = 'income' THEN 'income' ELSE 'expense' END,
    COALESCE(NEW.currency, 'ARS'),
    COALESCE(NEW.amount_ars, 0),
    COALESCE(NEW.exchange_rate, 1),
    COALESCE(NEW.amount_ars, 0),
    'bfe',
    NEW.id,
    NEW.description,
    NEW.date,
    NEW.created_by
  );

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."sync_bfe_to_financial_movements"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_business_logo_url"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  UPDATE businesses
  SET logo_url = NEW.logo_url
  WHERE id = NEW.business_id;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."sync_business_logo_url"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_inventory_stock_alias"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- Si alguien actualiza stock_quantity, sincronizar stock
  IF NEW.stock_quantity IS DISTINCT FROM OLD.stock_quantity THEN
    NEW.stock := NEW.stock_quantity;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."sync_inventory_stock_alias"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_account_movement_balance"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_prev NUMERIC;
BEGIN
  SELECT COALESCE(balance, 0) INTO v_prev
  FROM public.accounts WHERE id = NEW.account_id
  FOR UPDATE;  -- lock row to prevent concurrent balance corruption

  NEW.balance_after := v_prev + NEW.debit - NEW.credit;

  UPDATE public.accounts
  SET balance = NEW.balance_after, updated_at = NOW()
  WHERE id = NEW.account_id;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trigger_account_movement_balance"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_comprobante_finance"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_new_status TEXT;
  v_old_status TEXT;
  v_amount     NUMERIC;
  v_date       DATE;
  v_desc       TEXT;
BEGIN
  -- Leer status desde columna inglesa o española
  v_new_status := COALESCE(NEW.status, NEW.estado);
  v_old_status := COALESCE(OLD.status, OLD.estado);

  IF NEW.business_id IS NULL THEN RETURN NEW; END IF;

  v_amount := COALESCE(NEW.total_ars, NEW.total, 0);
  v_date   := COALESCE(
    CASE WHEN NEW.date IS NOT NULL THEN NEW.date::DATE END,
    NEW.fecha::DATE,
    CURRENT_DATE
  );

  -- Emitido: registrar ingreso (evitar duplicado)
  IF v_new_status IN ('issued', 'emitido')
     AND COALESCE(v_old_status, '') NOT IN ('issued', 'emitido') THEN

    IF NOT EXISTS (
      SELECT 1 FROM public.business_finance_entries
      WHERE reference_comprobante_id = NEW.id AND type = 'income' AND amount_ars > 0
    ) THEN
      v_desc := 'Comprobante #' || COALESCE(NEW.number, NEW.numero, '');
      INSERT INTO public.business_finance_entries (
        business_id, date, type, category, description,
        amount, currency, amount_ars, exchange_rate,
        reference_comprobante_id, source, created_by
      ) VALUES (
        NEW.business_id, v_date, 'income', 'ventas_productos',
        v_desc, v_amount,
        COALESCE(NEW.currency, 'ARS'), v_amount,
        COALESCE(NEW.exchange_rate, 1),
        NEW.id, 'comprobante', NEW.created_by
      );
    END IF;
  END IF;

  -- Anulado: registrar reverso
  IF v_new_status IN ('cancelled', 'anulado')
     AND COALESCE(v_old_status, '') NOT IN ('cancelled', 'anulado') THEN

    v_desc := 'ANULACIÓN Comprobante #' || COALESCE(NEW.number, NEW.numero, '');
    INSERT INTO public.business_finance_entries (
      business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate,
      reference_comprobante_id, source, created_by
    ) VALUES (
      NEW.business_id, CURRENT_DATE, 'income', 'ventas_productos',
      v_desc, -v_amount,
      COALESCE(NEW.currency, 'ARS'), -v_amount,
      COALESCE(NEW.exchange_rate, 1),
      NEW.id, 'comprobante', NEW.created_by
    );
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trigger_comprobante_finance"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_comprobante_payment_finance"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_comp_num        TEXT;
  v_order_id        UUID;
  v_existing_income NUMERIC;
  v_caja_method     TEXT;
BEGIN
  SELECT COALESCE(number, numero, id::TEXT), order_id
  INTO v_comp_num, v_order_id
  FROM public.comprobantes WHERE id = NEW.comprobante_id;

  -- ── GUARD ANTI-DUPLICADO ──────────────────────────────────────────────────
  -- Si la orden ya tiene ingresos en financial_movements (registrados por
  -- order_payments), vinculamos el comprobante al movimiento existente.
  IF v_order_id IS NOT NULL THEN
    SELECT COALESCE(SUM(amount_ars), 0) INTO v_existing_income
    FROM public.financial_movements
    WHERE type          = 'income'
      AND reference_type = 'order'
      AND reference_id   = v_order_id
      AND business_id    = NEW.business_id;

    IF v_existing_income > 0 THEN
      UPDATE public.financial_movements
      SET comprobante_id = COALESCE(comprobante_id, NEW.comprobante_id),
          description    = description || ' → comp #' || v_comp_num
      WHERE type          = 'income'
        AND reference_type = 'order'
        AND reference_id   = v_order_id
        AND business_id    = NEW.business_id
        AND comprobante_id IS NULL;

      IF NEW.commission_amount > 0 THEN
        INSERT INTO public.business_finance_entries (
          business_id, date, type, category, description,
          amount, currency, amount_ars, exchange_rate,
          payment_method, reference_comprobante_id, source, created_by
        ) VALUES (
          NEW.business_id, NEW.date, 'variable_cost', 'comisiones_cobro',
          'Comisión ' || COALESCE(NEW.payment_provider, NEW.payment_method)
            || ' - comprobante #' || v_comp_num,
          NEW.commission_amount, 'ARS', NEW.commission_amount, 1,
          NEW.payment_method, NEW.comprobante_id, 'comprobante', NEW.created_by
        );
      END IF;

      RETURN NEW;
    END IF;
  END IF;

  -- ── MAPEAR payment_method → metodo_pago (CajaMethod) ─────────────────────
  -- CajaMethod: efectivo | transferencia | tarjeta | usd
  v_caja_method := CASE
    WHEN NEW.currency        = 'USD'                                               THEN 'usd'
    WHEN NEW.payment_method  = 'efectivo'                                          THEN 'efectivo'
    WHEN NEW.payment_method  = 'transferencia'                                     THEN 'transferencia'
    WHEN NEW.payment_method IN ('tarjeta_debito','tarjeta_credito','qr',
                                'mercado_pago','otro','mixto')                     THEN 'tarjeta'
    ELSE 'efectivo'
  END;

  -- ── MOVIMIENTO DE CAJA ────────────────────────────────────────────────────
  -- Todos los métodos de pago EXCEPTO cuenta_corriente impactan caja.
  -- caja_id se auto-asigna via trigger_set_movement_caja si no se provee.
  IF NEW.payment_method != 'cuenta_corriente' THEN
    INSERT INTO public.financial_movements (
      business_id, date, type, currency, amount, exchange_rate, amount_ars,
      source, source_id, comprobante_id, description, created_by, metodo_pago
    ) VALUES (
      NEW.business_id, NEW.date, 'income',
      NEW.currency, NEW.amount, NEW.exchange_rate, NEW.amount_ars,
      'comprobante', NEW.id, NEW.comprobante_id,
      'Cobro comprobante #' || v_comp_num,
      NEW.created_by,
      v_caja_method
    );
  END IF;

  -- ── BFE INCOME ────────────────────────────────────────────────────────────
  -- No registrar BFE para cuenta_corriente (el cash llega cuando paga la CC).
  IF NEW.payment_method != 'cuenta_corriente' THEN
    INSERT INTO public.business_finance_entries (
      business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate,
      payment_method, reference_comprobante_id, source, created_by
    ) VALUES (
      NEW.business_id, NEW.date, 'income', 'ventas_productos',
      'Cobro comprobante #' || v_comp_num,
      NEW.amount_ars, NEW.currency, NEW.amount_ars, NEW.exchange_rate,
      NEW.payment_method, NEW.comprobante_id, 'comprobante', NEW.created_by
    );
  END IF;

  -- ── COMISIÓN ──────────────────────────────────────────────────────────────
  IF NEW.commission_amount > 0 THEN
    INSERT INTO public.business_finance_entries (
      business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate,
      payment_method, reference_comprobante_id, source, created_by
    ) VALUES (
      NEW.business_id, NEW.date, 'variable_cost', 'comisiones_cobro',
      'Comisión ' || COALESCE(NEW.payment_provider, NEW.payment_method)
        || ' - comprobante #' || v_comp_num,
      NEW.commission_amount, 'ARS', NEW.commission_amount, 1,
      NEW.payment_method, NEW.comprobante_id, 'comprobante', NEW.created_by
    );
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trigger_comprobante_payment_finance"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_comprobante_payment_sync"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_comp_id      UUID;
  v_total        NUMERIC;
  v_total_cobrado NUMERIC;
  v_saldo        NUMERIC;
  v_estado_com   TEXT;
BEGIN
  v_comp_id := COALESCE(NEW.comprobante_id, OLD.comprobante_id);

  SELECT
    COALESCE(total_bruto, total_ars, total, 0),
    COALESCE(
      (SELECT SUM(amount_ars) FROM public.comprobante_payments
       WHERE comprobante_id = v_comp_id), 0)
  INTO v_total, v_total_cobrado
  FROM public.comprobantes
  WHERE id = v_comp_id;

  v_saldo := GREATEST(0, v_total - v_total_cobrado);

  v_estado_com := CASE
    WHEN v_total_cobrado <= 0             THEN 'pendiente'
    WHEN v_saldo <= 0.01                  THEN 'pagado'
    ELSE 'parcial'
  END;

  UPDATE public.comprobantes
  SET total_cobrado    = v_total_cobrado,
      saldo_pendiente  = v_saldo,
      estado_comercial = v_estado_com,
      updated_at       = NOW()
  WHERE id = v_comp_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;


ALTER FUNCTION "public"."trigger_comprobante_payment_sync"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_expense_finance"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_amount     NUMERIC;
  v_pay_method TEXT;
  v_entry_type TEXT;
  v_category   TEXT;
  v_bfe_id     UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.finance_entry_id IS NOT NULL THEN
      INSERT INTO public.business_finance_entries (
        business_id, date, type, category, description,
        amount, currency, amount_ars, exchange_rate, payment_method, source
      )
      SELECT business_id, CURRENT_DATE, type, category,
        'REVERSO: ' || COALESCE(description, ''),
        -amount, currency, -amount_ars, exchange_rate, payment_method, 'system'
      FROM public.business_finance_entries WHERE id = OLD.finance_entry_id;
    END IF;
    RETURN OLD;
  END IF;

  -- Facturas de proveedor: el impacto ya fue registrado por suppliersService
  IF NEW.tipo = 'factura' THEN RETURN NEW; END IF;

  IF NEW.finance_entry_id IS NOT NULL THEN RETURN NEW; END IF;
  IF NEW.business_id IS NULL THEN RETURN NEW; END IF;

  v_amount     := COALESCE(NEW.amount_ars, NEW.amount, 0);
  v_pay_method := COALESCE(NEW.payment_method, 'efectivo');

  v_entry_type := CASE LOWER(COALESCE(NEW.category, ''))
    WHEN 'inventario' THEN 'variable_cost'
    ELSE 'fixed_cost_local'
  END;

  v_category := CASE LOWER(COALESCE(NEW.category, ''))
    WHEN 'inventario'   THEN 'mercaderia'
    WHEN 'operativos'   THEN 'otros_fijos_local'
    WHEN 'equipamiento' THEN 'mantenimiento'
    WHEN 'marketing'    THEN 'publicidad'
    ELSE 'otros_fijos_local'
  END;

  INSERT INTO public.business_finance_entries (
    business_id, date, type, category, description,
    amount, currency, amount_ars, exchange_rate,
    payment_method, source, created_by
  ) VALUES (
    NEW.business_id, COALESCE(NEW.date::DATE, CURRENT_DATE),
    v_entry_type, v_category,
    COALESCE(NEW.description, 'Gasto: ' || COALESCE(NEW.category, '')),
    v_amount, COALESCE(NEW.currency, 'ARS'), v_amount,
    COALESCE(NEW.exchange_rate, 1), v_pay_method, 'expense', NEW.created_by
  )
  RETURNING id INTO v_bfe_id;

  UPDATE public.expenses SET finance_entry_id = v_bfe_id WHERE id = NEW.id;

  -- Registrar movimiento para TODOS los métodos (no solo efectivo)
  -- El trigger trig_set_movement_caja asignará caja_id automáticamente
  INSERT INTO public.financial_movements (
    business_id, type, currency, amount, exchange_rate, amount_ars,
    source, source_id, description, date, created_by, metodo_pago
  ) VALUES (
    NEW.business_id, 'expense', 'ARS', v_amount, 1, v_amount,
    'expense', v_bfe_id,
    COALESCE(NEW.description, 'Gasto ' || COALESCE(NEW.category, '')),
    COALESCE(NEW.date::DATE, CURRENT_DATE),
    NEW.created_by,
    v_pay_method
  );

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trigger_expense_finance"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_payment_creates_movements"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_business_id UUID;
  v_date        DATE;
BEGIN
  -- Obtener business_id desde la orden si no viene en el pago
  IF NEW.business_id IS NULL THEN
    SELECT o.business_id INTO v_business_id
    FROM public.orders o WHERE o.id = NEW.order_id;
    NEW.business_id := v_business_id;
  ELSE
    v_business_id := NEW.business_id;
  END IF;

  IF v_business_id IS NULL THEN RETURN NEW; END IF;

  v_date := COALESCE(
    CASE WHEN NEW.payment_date IS NOT NULL THEN NEW.payment_date::DATE END,
    CURRENT_DATE
  );

  -- Movimiento de caja (solo medios que impactan efectivo/caja física)
  INSERT INTO public.financial_movements (
    business_id, type, currency, amount, exchange_rate, amount_ars,
    source, source_id, reference_id, reference_type,
    description, date, created_by
  ) VALUES (
    v_business_id,
    'income',
    COALESCE(NEW.currency, 'ARS'),
    NEW.amount,
    1,
    NEW.amount,
    'payment',
    NEW.id,
    NEW.order_id,
    'order',
    'Cobro orden #' || LEFT(NEW.order_id::TEXT, 8),
    v_date,
    NEW.created_by
  );

  -- Entrada en business_finance_entries
  INSERT INTO public.business_finance_entries (
    business_id, date, type, category, description,
    amount, currency, amount_ars, exchange_rate,
    payment_method, reference_order_id, source, created_by
  ) VALUES (
    v_business_id,
    v_date,
    'income',
    'servicios_tecnicos',
    'Cobro orden #' || LEFT(NEW.order_id::TEXT, 8),
    NEW.amount,
    COALESCE(NEW.currency, 'ARS'),
    NEW.amount,
    1,
    NEW.payment_method,
    NEW.order_id,
    'payment',
    NEW.created_by
  );

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trigger_payment_creates_movements"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_payment_transaction_approved"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_comp_num  TEXT;
  v_biz_id    UUID;
BEGIN
  -- Solo actuar cuando pasa a 'approved' y tiene comprobante
  IF NEW.status != 'approved'
     OR (OLD.status = 'approved' AND NEW.status = 'approved')
     OR NEW.comprobante_id IS NULL
  THEN
    RETURN NEW;
  END IF;

  v_biz_id := NEW.business_id;

  SELECT COALESCE(number, numero, id::TEXT)
  INTO v_comp_num
  FROM public.comprobantes
  WHERE id = NEW.comprobante_id;

  -- Movimiento: ingreso bruto
  INSERT INTO public.financial_movements (
    business_id, comprobante_id, payment_transaction_id,
    type, movement_type, currency, amount, exchange_rate, amount_ars,
    source, source_id, provider, channel, sign, description, date, created_by
  ) VALUES (
    v_biz_id, NEW.comprobante_id, NEW.id,
    'income', 'income', NEW.currency,
    NEW.transaction_amount, 1, NEW.transaction_amount,
    'comprobante', NEW.id,
    NEW.provider, NEW.channel, 1,
    'Cobro ' || COALESCE(NEW.provider,'') || ' #' || v_comp_num,
    COALESCE(NEW.approved_at::DATE, CURRENT_DATE), NULL
  );

  -- Movimiento: comisión (negativo)
  IF COALESCE(NEW.fee_amount_estimated, 0) > 0 THEN
    INSERT INTO public.financial_movements (
      business_id, comprobante_id, payment_transaction_id,
      type, movement_type, currency, amount, exchange_rate, amount_ars,
      source, source_id, provider, channel, sign, description, date
    ) VALUES (
      v_biz_id, NEW.comprobante_id, NEW.id,
      'expense', 'fee', NEW.currency,
      NEW.fee_amount_estimated, 1, NEW.fee_amount_estimated,
      'comprobante', NEW.id,
      NEW.provider, NEW.channel, -1,
      'Comisión ' || COALESCE(NEW.provider,'') || ' #' || v_comp_num,
      COALESCE(NEW.approved_at::DATE, CURRENT_DATE)
    );
  END IF;

  -- Registrar en business_finance_entries (ingreso neto)
  INSERT INTO public.business_finance_entries (
    business_id, date, type, category, description,
    amount, currency, amount_ars, exchange_rate,
    payment_method, reference_comprobante_id, source, created_by
  ) VALUES (
    v_biz_id,
    COALESCE(NEW.approved_at::DATE, CURRENT_DATE),
    'income', 'ventas_productos',
    'Cobro ' || COALESCE(NEW.provider,'manual') || ' — ' || v_comp_num,
    NEW.net_amount_estimated,
    NEW.currency, NEW.net_amount_estimated, 1,
    NEW.payment_method_type,
    NEW.comprobante_id, 'comprobante', NULL
  )
  ON CONFLICT DO NOTHING;

  -- Si hay comisión, registrarla como costo
  IF COALESCE(NEW.fee_amount_estimated, 0) > 0 THEN
    INSERT INTO public.business_finance_entries (
      business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate,
      payment_method, reference_comprobante_id, source
    ) VALUES (
      v_biz_id,
      COALESCE(NEW.approved_at::DATE, CURRENT_DATE),
      'variable_cost', 'comisiones_cobro',
      'Comisión ' || COALESCE(NEW.provider,'') || ' — ' || v_comp_num,
      NEW.fee_amount_estimated,
      NEW.currency, NEW.fee_amount_estimated, 1,
      NEW.payment_method_type,
      NEW.comprobante_id, 'comprobante'
    )
    ON CONFLICT DO NOTHING;
  END IF;

  -- Actualizar comprobante
  UPDATE public.comprobantes
  SET
    payment_status       = 'paid',
    payment_provider     = NEW.provider,
    payment_channel      = NEW.channel,
    payment_integration  = NEW.integration_kind,
    provider_payment_id  = NEW.provider_payment_id,
    gross_amount         = NEW.transaction_amount,
    fee_amount           = COALESCE(NEW.fee_amount_estimated, 0),
    net_amount           = NEW.net_amount_estimated,
    amount_paid          = NEW.transaction_amount,
    payment_approved_at  = NEW.approved_at,
    estado_comercial     = 'pagado',
    updated_at           = NOW()
  WHERE id = NEW.comprobante_id;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trigger_payment_transaction_approved"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_recalcular_totales"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if tg_op = 'DELETE' then
    perform public.recalcular_totales_comprobante(old.comprobante_id);
    return old;
  else
    perform public.recalcular_totales_comprobante(new.comprobante_id);
    return new;
  end if;
end;
$$;


ALTER FUNCTION "public"."trigger_recalcular_totales"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_set_movement_caja"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NEW.caja_id IS NULL AND NEW.business_id IS NOT NULL THEN
    SELECT id INTO NEW.caja_id
    FROM public.cajas
    WHERE business_id = NEW.business_id AND status = 'abierta'
    ORDER BY opened_at DESC LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trigger_set_movement_caja"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_supplier_account_movement_balance"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_prev     NUMERIC := 0;
  v_lock_key BIGINT;
BEGIN
  -- Advisory lock per (supplier_id, business_id): serialises concurrent inserts
  -- for the same supplier without blocking other suppliers.
  v_lock_key := ('x' || substr(
    md5(NEW.supplier_id::text || '|' || NEW.business_id::text), 1, 16
  ))::bit(64)::bigint;

  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Read the most-recent balance (protected against race conditions by the lock above)
  SELECT COALESCE(balance_after, 0)
  INTO   v_prev
  FROM   public.supplier_account_movements
  WHERE  supplier_id = NEW.supplier_id
    AND  business_id = NEW.business_id
  ORDER BY created_at DESC
  LIMIT 1;

  -- COALESCE guards against null debit/credit from any caller (JS runtime, legacy RPCs, etc.)
  NEW.balance_after := COALESCE(v_prev, 0)
                     + COALESCE(NEW.debit,  0)
                     - COALESCE(NEW.credit, 0);

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trigger_supplier_account_movement_balance"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_task_history"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.task_history(task_id, business_id, user_id, action, new_value)
    VALUES (NEW.id, COALESCE(NEW.business_id,'00000000-0000-0000-0000-000000000000'), NEW.created_by, 'created', NEW.title);

  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
      INSERT INTO public.task_history(task_id, business_id, user_id, action, old_value, new_value)
      VALUES (NEW.id, NEW.business_id, NEW.created_by, 'status_changed', OLD.status, NEW.status);
    END IF;
    IF OLD.assigned_to IS DISTINCT FROM NEW.assigned_to THEN
      INSERT INTO public.task_history(task_id, business_id, user_id, action, old_value, new_value)
      VALUES (NEW.id, NEW.business_id, NEW.created_by, 'reassigned',
              OLD.assigned_to::TEXT, NEW.assigned_to::TEXT);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trigger_task_history"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_arca_config_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_arca_config_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_business_settings_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_business_settings_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_inventory_dollar_prices"("p_business_id" "uuid", "p_new_rate" numeric) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_updated integer := 0;
  v_skipped integer := 0;
BEGIN
  -- Validar que el usuario autenticado pertenece al negocio
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE business_id = p_business_id
      AND user_id = auth.uid()
      AND is_active = true
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  IF p_new_rate <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'La cotización debe ser mayor a 0');
  END IF;

  -- Contar productos que no son elegibles (para el log)
  SELECT COUNT(*) INTO v_skipped
  FROM inventory
  WHERE business_id   = p_business_id
    AND auto_update_price = true
    AND (base_currency != 'USD' OR base_price IS NULL OR base_price <= 0);

  -- Actualizar en batch todos los productos elegibles
  -- sale_price = base_price * nueva_cotizacion (redondeado a entero para ARS)
  UPDATE inventory
  SET
    sale_price         = ROUND(base_price * p_new_rate),
    exchange_rate_used = p_new_rate,
    updated_at         = now()
  WHERE business_id      = p_business_id
    AND auto_update_price = true
    AND base_currency     = 'USD'
    AND base_price        IS NOT NULL
    AND base_price        > 0;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok',      true,
    'updated', v_updated,
    'skipped', v_skipped,
    'rate',    p_new_rate
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."update_inventory_dollar_prices"("p_business_id" "uuid", "p_new_rate" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_personal_debts_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin new.updated_at = now(); return new; end;
$$;


ALTER FUNCTION "public"."update_personal_debts_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_recurring_expenses_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin new.updated_at = now(); return new; end;
$$;


ALTER FUNCTION "public"."update_recurring_expenses_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_sales_points_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_sales_points_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_tasks_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_tasks_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_timestamp"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."update_timestamp"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;


ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_whatsapp_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_whatsapp_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_business_settings"("p_business_id" "uuid", "p_default_currency" "text" DEFAULT 'ARS'::"text", "p_show_usd_price" boolean DEFAULT false, "p_auto_update_rate" boolean DEFAULT false, "p_rate_api_url" "text" DEFAULT NULL::"text", "p_rate_update_frequency_hours" integer DEFAULT 24) RETURNS TABLE("id" "uuid", "business_id" "uuid", "default_currency" "text", "show_usd_price" boolean, "auto_update_rate" boolean, "rate_api_url" "text", "rate_update_frequency_hours" integer, "updated_at" timestamp with time zone, "created_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_business_id UUID;
BEGIN
  v_business_id := public.current_user_business_id();

  IF v_business_id IS NULL OR v_business_id <> p_business_id THEN
    RAISE EXCEPTION 'No tenes acceso a este negocio';
  END IF;

  IF public.current_user_role() NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'No tenes permisos para guardar configuracion de moneda';
  END IF;

  RETURN QUERY
  UPDATE public.business_settings AS bs
  SET default_currency = p_default_currency,
      show_usd_price = p_show_usd_price,
      auto_update_rate = p_auto_update_rate,
      rate_api_url = p_rate_api_url,
      rate_update_frequency_hours = p_rate_update_frequency_hours,
      updated_at = NOW()
  WHERE bs.business_id = p_business_id
  RETURNING
    bs.id,
    bs.business_id,
    bs.default_currency,
    bs.show_usd_price,
    bs.auto_update_rate,
    bs.rate_api_url,
    bs.rate_update_frequency_hours,
    bs.updated_at,
    bs.created_at;

  IF FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY
  INSERT INTO public.business_settings AS bs (
    business_id,
    default_currency,
    show_usd_price,
    auto_update_rate,
    rate_api_url,
    rate_update_frequency_hours
  )
  VALUES (
    p_business_id,
    p_default_currency,
    p_show_usd_price,
    p_auto_update_rate,
    p_rate_api_url,
    p_rate_update_frequency_hours
  )
  RETURNING
    bs.id,
    bs.business_id,
    bs.default_currency,
    bs.show_usd_price,
    bs.auto_update_rate,
    bs.rate_api_url,
    bs.rate_update_frequency_hours,
    bs.updated_at,
    bs.created_at;
END;
$$;


ALTER FUNCTION "public"."upsert_business_settings"("p_business_id" "uuid", "p_default_currency" "text", "p_show_usd_price" boolean, "p_auto_update_rate" boolean, "p_rate_api_url" "text", "p_rate_update_frequency_hours" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_exchange_rate"("p_business_id" "uuid", "p_base_currency" "text" DEFAULT 'USD'::"text", "p_target_currency" "text" DEFAULT 'ARS'::"text", "p_rate" numeric DEFAULT 1, "p_is_manual" boolean DEFAULT true, "p_source" "text" DEFAULT 'manual'::"text") RETURNS TABLE("id" "uuid", "business_id" "uuid", "base_currency" "text", "target_currency" "text", "rate" numeric, "is_manual" boolean, "source" "text", "updated_at" timestamp with time zone, "created_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_business_id UUID;
BEGIN
  v_business_id := public.current_user_business_id();

  IF v_business_id IS NULL OR v_business_id <> p_business_id THEN
    RAISE EXCEPTION 'No tenes acceso a este negocio';
  END IF;

  IF public.current_user_role() NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'No tenes permisos para guardar tipo de cambio';
  END IF;

  IF p_rate <= 0 THEN
    RAISE EXCEPTION 'El tipo de cambio debe ser mayor a 0';
  END IF;

  RETURN QUERY
  INSERT INTO public.exchange_rates AS er (
    business_id,
    base_currency,
    target_currency,
    rate,
    is_manual,
    source
  )
  VALUES (
    p_business_id,
    p_base_currency,
    p_target_currency,
    p_rate,
    p_is_manual,
    p_source
  )
  RETURNING
    er.id,
    er.business_id,
    er.base_currency,
    er.target_currency,
    er.rate,
    er.is_manual,
    er.source,
    er.updated_at,
    er.created_at;
END;
$$;


ALTER FUNCTION "public"."upsert_exchange_rate"("p_business_id" "uuid", "p_base_currency" "text", "p_target_currency" "text", "p_rate" numeric, "p_is_manual" boolean, "p_source" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."user_business_ids"() RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  SELECT business_id FROM public.profiles
  WHERE COALESCE(user_id, id) = auth.uid()
    AND is_active = TRUE;
$$;


ALTER FUNCTION "public"."user_business_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."warranties_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."warranties_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."whatsapp_admin_provision_connection"("p_business_id" "uuid", "p_phone_number_id" "text", "p_waba_id" "text", "p_access_token" "text", "p_reason" "text", "p_system_user_id" "text" DEFAULT NULL::"text", "p_token_expires_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_business_phone_number" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public', 'vault'
    AS $$
DECLARE
  v_conn_id uuid;
  v_prev    text;
  v_user_id uuid;
  v_other   uuid;
  v_event   text;
BEGIN
  IF p_business_id IS NULL THEN RAISE EXCEPTION 'business_id requerido'; END IF;
  IF p_phone_number_id IS NULL OR length(btrim(p_phone_number_id)) = 0 THEN RAISE EXCEPTION 'phone_number_id requerido'; END IF;
  IF p_waba_id         IS NULL OR length(btrim(p_waba_id))         = 0 THEN RAISE EXCEPTION 'waba_id requerido'; END IF;
  IF p_access_token    IS NULL OR length(btrim(p_access_token))    = 0 THEN RAISE EXCEPTION 'access_token requerido'; END IF;
  IF p_reason          IS NULL OR length(btrim(p_reason))          = 0 THEN RAISE EXCEPTION 'reason requerido'; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = p_business_id) THEN
    RAISE EXCEPTION 'negocio inexistente';
  END IF;

  SELECT c.id, c.status INTO v_conn_id, v_prev
  FROM public.whatsapp_connections c
  WHERE c.business_id = p_business_id
  ORDER BY c.created_at DESC
  LIMIT 1;

  SELECT c.id INTO v_other
  FROM public.whatsapp_connections c
  WHERE c.business_id = p_business_id AND c.status = 'connected'
  LIMIT 1;
  IF v_other IS NOT NULL AND (v_conn_id IS NULL OR v_other <> v_conn_id) THEN
    RAISE EXCEPTION 'el negocio ya tiene una conexión activa';
  END IF;

  IF v_conn_id IS NULL THEN
    SELECT p.user_id INTO v_user_id
    FROM public.profiles p
    WHERE p.business_id = p_business_id AND p.is_active AND p.role IN ('owner','admin')
    ORDER BY CASE p.role WHEN 'owner' THEN 0 ELSE 1 END
    LIMIT 1;
    IF v_user_id IS NULL THEN RAISE EXCEPTION 'no hay owner/admin activo para el negocio'; END IF;

    INSERT INTO public.whatsapp_connections
      (business_id, user_id, waba_id, phone_number_id, business_phone_number,
       system_user_id, status, metadata, created_at, updated_at)
    VALUES
      (p_business_id, v_user_id, p_waba_id, p_phone_number_id, p_business_phone_number,
       p_system_user_id, 'disconnected', '{}'::jsonb, now(), now())
    RETURNING id INTO v_conn_id;
    v_prev := NULL;
  ELSE
    UPDATE public.whatsapp_connections
    SET waba_id               = p_waba_id,
        phone_number_id       = p_phone_number_id,
        business_phone_number = coalesce(p_business_phone_number, business_phone_number),
        system_user_id        = coalesce(p_system_user_id, system_user_id),
        updated_at            = now()
    WHERE id = v_conn_id;
  END IF;

  PERFORM public.whatsapp_credential_store(v_conn_id, p_access_token, p_token_expires_at);

  UPDATE public.whatsapp_connections
  SET status = 'connected', token_expires_at = p_token_expires_at, updated_at = now()
  WHERE id = v_conn_id;

  v_event := CASE WHEN v_prev = 'connected' THEN 'reconnected' ELSE 'provisioned' END;
  INSERT INTO public.whatsapp_connection_events
    (business_id, connection_id, event_type, actor_type, previous_status, new_status, reason, metadata)
  VALUES
    (p_business_id, v_conn_id, v_event, 'service_role', v_prev, 'connected', left(p_reason, 500),
     jsonb_build_object(
       'has_system_user',  (p_system_user_id IS NOT NULL),
       'has_token_expiry', (p_token_expires_at IS NOT NULL),
       'phone_number_id_present', true,
       'waba_id_present', true));

  RETURN jsonb_build_object('connection_id', v_conn_id, 'status', 'connected', 'event', v_event);
END;
$$;


ALTER FUNCTION "public"."whatsapp_admin_provision_connection"("p_business_id" "uuid", "p_phone_number_id" "text", "p_waba_id" "text", "p_access_token" "text", "p_reason" "text", "p_system_user_id" "text", "p_token_expires_at" timestamp with time zone, "p_business_phone_number" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."whatsapp_admin_record_event"("p_business_id" "uuid", "p_event_type" "text", "p_reason" "text", "p_connection_id" "uuid" DEFAULT NULL::"uuid", "p_metadata" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE v_id uuid;
BEGIN
  IF p_business_id IS NULL THEN RAISE EXCEPTION 'business_id requerido'; END IF;
  IF p_event_type  IS NULL THEN RAISE EXCEPTION 'event_type requerido'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN RAISE EXCEPTION 'reason requerido'; END IF;

  INSERT INTO public.whatsapp_connection_events
    (business_id, connection_id, event_type, actor_type, reason, metadata)
  VALUES
    (p_business_id, p_connection_id, p_event_type, 'service_role', left(p_reason, 500),
     coalesce(p_metadata, '{}'::jsonb) - 'token' - 'access_token' - 'p_access_token' - 'secret')
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;


ALTER FUNCTION "public"."whatsapp_admin_record_event"("p_business_id" "uuid", "p_event_type" "text", "p_reason" "text", "p_connection_id" "uuid", "p_metadata" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."whatsapp_admin_revoke_connection"("p_business_id" "uuid", "p_reason" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public', 'vault'
    AS $$
DECLARE
  v_conn_id  uuid;
  v_prev     text;
  v_had_cred boolean;
BEGIN
  IF p_business_id IS NULL THEN RAISE EXCEPTION 'business_id requerido'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN RAISE EXCEPTION 'reason requerido'; END IF;

  SELECT c.id, c.status INTO v_conn_id, v_prev
  FROM public.whatsapp_connections c
  WHERE c.business_id = p_business_id
  ORDER BY (c.status = 'connected') DESC, c.created_at DESC
  LIMIT 1;

  IF v_conn_id IS NULL THEN
    RETURN jsonb_build_object('status', 'noop', 'reason', 'no_connection');
  END IF;

  v_had_cred := EXISTS (
    SELECT 1 FROM public.whatsapp_connection_credentials cc WHERE cc.connection_id = v_conn_id
  );

  IF v_had_cred THEN
    PERFORM public.whatsapp_credential_delete(v_conn_id);
  END IF;

  UPDATE public.whatsapp_connections
  SET status = 'disconnected', updated_at = now()
  WHERE id = v_conn_id AND status <> 'disconnected';

  IF v_prev = 'connected' OR v_had_cred THEN
    INSERT INTO public.whatsapp_connection_events
      (business_id, connection_id, event_type, actor_type, previous_status, new_status, reason, metadata)
    VALUES
      (p_business_id, v_conn_id, 'credential_revoked', 'service_role', v_prev, 'disconnected', left(p_reason, 500),
       jsonb_build_object('credential_removed', v_had_cred));
  END IF;

  RETURN jsonb_build_object('connection_id', v_conn_id, 'status', 'disconnected', 'credential_removed', v_had_cred);
END;
$$;


ALTER FUNCTION "public"."whatsapp_admin_revoke_connection"("p_business_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."whatsapp_connection_events_block_mutation"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
BEGIN
  RAISE EXCEPTION 'whatsapp_connection_events is append-only (% not allowed)', TG_OP;
END;
$$;


ALTER FUNCTION "public"."whatsapp_connection_events_block_mutation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."whatsapp_credential_delete"("p_connection_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public', 'vault'
    AS $$
BEGIN
  IF p_connection_id IS NULL THEN RAISE EXCEPTION 'connection_id requerido'; END IF;
  DELETE FROM public.whatsapp_connection_credentials WHERE connection_id = p_connection_id;
END;
$$;


ALTER FUNCTION "public"."whatsapp_credential_delete"("p_connection_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."whatsapp_credential_get_token"("p_connection_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public', 'vault'
    AS $$
DECLARE
  v_secret_id uuid;
  v_token     text;
BEGIN
  IF p_connection_id IS NULL THEN RAISE EXCEPTION 'connection_id requerido'; END IF;
  SELECT cred.vault_secret_id INTO v_secret_id
  FROM public.whatsapp_connection_credentials cred
  WHERE cred.connection_id = p_connection_id;
  IF v_secret_id IS NULL THEN RETURN NULL; END IF;
  SELECT ds.decrypted_secret INTO v_token
  FROM vault.decrypted_secrets ds
  WHERE ds.id = v_secret_id;
  RETURN v_token;
END;
$$;


ALTER FUNCTION "public"."whatsapp_credential_get_token"("p_connection_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."whatsapp_credential_purge_vault"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public', 'vault'
    AS $$
BEGIN
  IF OLD.vault_secret_id IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = OLD.vault_secret_id;
  END IF;
  RETURN OLD;
END;
$$;


ALTER FUNCTION "public"."whatsapp_credential_purge_vault"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."whatsapp_credential_store"("p_connection_id" "uuid", "p_token" "text", "p_expires_at" timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public', 'vault'
    AS $$
DECLARE
  v_existing  uuid;
  v_secret_id uuid;
  v_name      text;
BEGIN
  IF p_connection_id IS NULL THEN RAISE EXCEPTION 'connection_id requerido'; END IF;
  IF p_token IS NULL OR length(btrim(p_token)) = 0 THEN RAISE EXCEPTION 'token vacío'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.whatsapp_connections c WHERE c.id = p_connection_id) THEN
    RAISE EXCEPTION 'conexión inexistente';
  END IF;
  v_name := 'whatsapp_token_' || p_connection_id::text;
  SELECT cred.vault_secret_id INTO v_existing
  FROM public.whatsapp_connection_credentials cred
  WHERE cred.connection_id = p_connection_id;
  IF v_existing IS NULL THEN
    v_secret_id := vault.create_secret(p_token, v_name, 'WhatsApp Cloud API token');
    INSERT INTO public.whatsapp_connection_credentials
      (connection_id, vault_secret_id, token_expires_at, created_at, updated_at)
    VALUES (p_connection_id, v_secret_id, p_expires_at, now(), now());
  ELSE
    PERFORM vault.update_secret(v_existing, p_token, v_name, 'WhatsApp Cloud API token (rotated)');
    UPDATE public.whatsapp_connection_credentials
    SET token_expires_at = p_expires_at, rotated_at = now(), updated_at = now()
    WHERE connection_id = p_connection_id;
  END IF;
END;
$$;


ALTER FUNCTION "public"."whatsapp_credential_store"("p_connection_id" "uuid", "p_token" "text", "p_expires_at" timestamp with time zone) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."account_movements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "account_id" "uuid" NOT NULL,
    "date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "type" "text" NOT NULL,
    "reference_type" "text",
    "reference_id" "uuid",
    "description" "text" NOT NULL,
    "debit" numeric DEFAULT 0 NOT NULL,
    "credit" numeric DEFAULT 0 NOT NULL,
    "balance_after" numeric DEFAULT 0 NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "account_movements_credit_check" CHECK (("credit" >= (0)::numeric)),
    CONSTRAINT "account_movements_debit_check" CHECK (("debit" >= (0)::numeric)),
    CONSTRAINT "account_movements_type_check" CHECK (("type" = ANY (ARRAY['venta'::"text", 'compra'::"text", 'gasto'::"text", 'pago'::"text", 'ajuste'::"text", 'apertura'::"text"])))
);


ALTER TABLE "public"."account_movements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "entity_name" "text" NOT NULL,
    "entity_phone" "text",
    "balance" numeric DEFAULT 0 NOT NULL,
    "credit_limit" numeric,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "accounts_type_check" CHECK (("type" = ANY (ARRAY['cliente'::"text", 'proveedor'::"text"])))
);


ALTER TABLE "public"."accounts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."arca_config" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "cuit_emisor" "text" DEFAULT ''::"text" NOT NULL,
    "ambiente" "text" DEFAULT 'homologacion'::"text" NOT NULL,
    "punto_venta" integer DEFAULT 1 NOT NULL,
    "web_service" "text" DEFAULT 'wsfe'::"text" NOT NULL,
    "cert_file" "text",
    "private_key" "text",
    "pfx_file" "text",
    "certificate_password" "text",
    "alias" "text" DEFAULT ''::"text" NOT NULL,
    "expires_at" timestamp with time zone,
    "estado_conexion" "text" DEFAULT 'no_configurado'::"text" NOT NULL,
    "ultima_sincronizacion" timestamp with time zone,
    "ultimo_error" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "cuit" "text",
    "razon_social" "text",
    "pfx_password" "text",
    "wsaa_token" "text",
    "wsaa_sign" "text",
    "wsaa_token_expires" timestamp with time zone
);


ALTER TABLE "public"."arca_config" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."arca_parametros" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "tipo" "text" NOT NULL,
    "datos" "jsonb" NOT NULL,
    "actualizado" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."arca_parametros" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."blocked_feature_attempts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid",
    "user_id" "uuid",
    "feature" "text" NOT NULL,
    "action" "text",
    "current_plan" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."blocked_feature_attempts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."brands" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "normalized_name" "text" DEFAULT ''::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."brands" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."business_finance_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "date" "date" NOT NULL,
    "type" "text" NOT NULL,
    "category" "text" NOT NULL,
    "subcategory" "text",
    "description" "text",
    "amount" numeric(14,2) NOT NULL,
    "currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "amount_ars" numeric(14,2) NOT NULL,
    "exchange_rate" numeric(10,4) DEFAULT 1 NOT NULL,
    "payment_method" "text",
    "notes" "text",
    "reference_order_id" "text",
    "reference_employee" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reference_comprobante_id" "uuid",
    "source" "text" DEFAULT 'manual'::"text",
    "recurring_expense_id" "uuid",
    "sale_type" "text" DEFAULT 'minorista'::"text",
    CONSTRAINT "business_finance_entries_amount_nonzero" CHECK (("amount" <> (0)::numeric)),
    CONSTRAINT "business_finance_entries_currency_check" CHECK (("currency" = ANY (ARRAY['ARS'::"text", 'USD'::"text"]))),
    CONSTRAINT "business_finance_entries_sale_type_check" CHECK (("sale_type" = ANY (ARRAY['minorista'::"text", 'mayorista'::"text", 'manual'::"text"]))),
    CONSTRAINT "business_finance_entries_type_check" CHECK (("type" = ANY (ARRAY['income'::"text", 'variable_cost'::"text", 'fixed_cost_local'::"text", 'fixed_cost_personal'::"text", 'salary'::"text"])))
);


ALTER TABLE "public"."business_finance_entries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."business_settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "default_currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "show_usd_price" boolean DEFAULT false NOT NULL,
    "auto_update_rate" boolean DEFAULT false NOT NULL,
    "rate_api_url" "text",
    "rate_update_frequency_hours" integer DEFAULT 24 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "logo_url" "text",
    "orden_whatsapp" "text" DEFAULT ''::"text",
    "orden_instagram" "text" DEFAULT ''::"text",
    "orden_email_visible" "text" DEFAULT ''::"text",
    "orden_sitio_web" "text" DEFAULT ''::"text",
    "orden_mensaje_agradecimiento" "text" DEFAULT 'Gracias por confiar en nosotros'::"text",
    "orden_condiciones" "text" DEFAULT 'El cliente autoriza la revisión del equipo. El local no se responsabiliza por pérdida de datos o información almacenada en el dispositivo. El retiro se realiza con la presentación de este comprobante. Los equipos no retirados dentro de los 60 días corridos desde la fecha de ingreso serán considerados abandonados. El presupuesto aprobado tiene validez de 30 días.'::"text",
    "orden_condiciones_activo" boolean DEFAULT true,
    "orden_condiciones_en" "text" DEFAULT 'ambas'::"text",
    "orden_mostrar_logo" boolean DEFAULT true,
    "orden_mostrar_direccion" boolean DEFAULT true,
    "orden_mostrar_whatsapp" boolean DEFAULT true,
    "orden_mostrar_instagram" boolean DEFAULT true,
    "orden_mostrar_email" boolean DEFAULT false,
    "orden_mostrar_sitio_web" boolean DEFAULT false,
    "orden_mostrar_agradecimiento" boolean DEFAULT true,
    "orden_mostrar_condiciones" boolean DEFAULT true,
    "nombre_comercial" "text" DEFAULT ''::"text",
    "razon_social" "text" DEFAULT ''::"text",
    "cuit" "text" DEFAULT ''::"text",
    "condicion_iva" "text" DEFAULT 'Responsable Inscripto'::"text",
    "domicilio_fiscal" "text" DEFAULT ''::"text",
    "localidad" "text" DEFAULT ''::"text",
    "provincia" "text" DEFAULT ''::"text",
    "codigo_postal" "text" DEFAULT ''::"text",
    "telefono" "text" DEFAULT ''::"text",
    "email" "text" DEFAULT ''::"text",
    "moneda_predeterminada" "text" DEFAULT 'ARS'::"text",
    "formato_fecha" "text" DEFAULT 'DD/MM/YYYY'::"text",
    "iva_por_defecto" numeric(5,2) DEFAULT 21,
    "numeracion_comprobantes" "text" DEFAULT '0001-00000001'::"text",
    "observaciones_comprobantes" "text" DEFAULT ''::"text",
    "stock_negativo" boolean DEFAULT false,
    "alertas_bajo_stock" boolean DEFAULT true,
    "categoria_cliente_defecto" "text" DEFAULT 'General'::"text",
    "tipo_comprobante_defecto" "text" DEFAULT 'Factura A'::"text",
    "comp_mensaje_agradecimiento" "text" DEFAULT 'Gracias por su compra'::"text",
    "comp_notas" "text",
    "comp_mostrar_logo" boolean DEFAULT true,
    "comp_mostrar_direccion" boolean DEFAULT true,
    "comp_mostrar_whatsapp" boolean DEFAULT true,
    "comp_mostrar_instagram" boolean DEFAULT false,
    "comp_mostrar_email" boolean DEFAULT false,
    "comp_mostrar_agradecimiento" boolean DEFAULT true,
    "comp_mostrar_notas" boolean DEFAULT false,
    "dolar_source" character varying(20) DEFAULT 'nacional'::character varying NOT NULL,
    "commission_rates" "jsonb" DEFAULT '{}'::"jsonb",
    "mayorista_enabled" boolean DEFAULT true,
    "last_dollar_source" "text",
    "last_dollar_fetched_at" timestamp with time zone,
    CONSTRAINT "business_settings_default_currency_check" CHECK (("default_currency" = ANY (ARRAY['USD'::"text", 'ARS'::"text"]))),
    CONSTRAINT "business_settings_dolar_source_check" CHECK ((("dolar_source")::"text" = ANY ((ARRAY['nacional'::character varying, 'cordoba'::character varying])::"text"[]))),
    CONSTRAINT "business_settings_rate_update_frequency_positive_check" CHECK (("rate_update_frequency_hours" > 0))
);


ALTER TABLE "public"."business_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "full_name" "text",
    "role" "text" DEFAULT 'owner'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "user_id" "uuid",
    "email" "text",
    "phone" "text",
    "permissions" "jsonb",
    "active_sales_point_id" "uuid",
    CONSTRAINT "profiles_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'admin'::"text", 'manager'::"text", 'tech'::"text", 'sales'::"text", 'cashier'::"text", 'viewer'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


COMMENT ON COLUMN "public"."profiles"."permissions" IS 'Custom permission overrides. NULL means use role defaults. Partial JSON with keys: orders, orders_change_status, orders_view_financials, inventory, inventory_view_costs, customers, finance, comprobantes, reports, settings, settings_sensitive, subscription, users';



CREATE OR REPLACE VIEW "public"."business_users_view" WITH ("security_invoker"='true') AS
 SELECT "id",
    COALESCE("user_id", "id") AS "user_id",
    "business_id",
    "role",
    "is_active",
    "full_name",
    "email",
    "phone",
    "permissions",
    "created_at",
    "updated_at"
   FROM "public"."profiles" "p";


ALTER VIEW "public"."business_users_view" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."businesses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "owner_user_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "subscription_status" "text" DEFAULT 'trialing'::"text" NOT NULL,
    "subscription_plan" "text",
    "subscription_provider" "text" DEFAULT 'mercadopago'::"text",
    "mp_preapproval_id" "text",
    "mp_preapproval_plan_id" "text",
    "mp_payer_email" "text",
    "current_period_start" timestamp with time zone,
    "current_period_end" timestamp with time zone,
    "grace_until" timestamp with time zone,
    "last_payment_id" "text",
    "last_payment_status" "text",
    "last_webhook_at" timestamp with time zone,
    "trial_ends_at" timestamp with time zone DEFAULT ("now"() + '14 days'::interval),
    "wholesale_portal_enabled" boolean DEFAULT false NOT NULL,
    "wholesale_portal_slug" "text",
    "wholesale_whatsapp" "text",
    "wholesale_portal_theme" "jsonb",
    "logo_url" "text",
    "rubro" "text",
    "whatsapp_negocio" "text",
    "ciudad" "text",
    "onboarding_completed" boolean DEFAULT false,
    "onboarding_completed_at" timestamp with time zone,
    "access_source" "text",
    "override_reason" "text",
    "override_created_by" "uuid",
    "override_created_at" timestamp with time zone,
    "override_expires_at" timestamp with time zone,
    "mp_last_modified" timestamp with time zone,
    CONSTRAINT "businesses_subscription_plan_check" CHECK (("subscription_plan" = ANY (ARRAY['basico'::"text", 'pro'::"text", 'full'::"text"]))),
    CONSTRAINT "businesses_subscription_status_check" CHECK (("subscription_status" = ANY (ARRAY['trialing'::"text", 'active'::"text", 'past_due'::"text", 'suspended'::"text", 'canceled'::"text", 'pending_activation'::"text"])))
);


ALTER TABLE "public"."businesses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cajas" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "opened_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "closed_at" timestamp with time zone,
    "opened_by" "uuid",
    "closed_by" "uuid",
    "efectivo_inicial" numeric DEFAULT 0 NOT NULL,
    "transferencia_inicial" numeric DEFAULT 0 NOT NULL,
    "tarjeta_inicial" numeric DEFAULT 0 NOT NULL,
    "usd_inicial" numeric DEFAULT 0 NOT NULL,
    "usd_cotizacion_apertura" numeric DEFAULT 1 NOT NULL,
    "efectivo_cierre" numeric,
    "transferencia_cierre" numeric,
    "tarjeta_cierre" numeric,
    "usd_cierre" numeric,
    "notas" "text",
    "status" "text" DEFAULT 'abierta'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "difference" numeric,
    CONSTRAINT "cajas_status_check" CHECK (("status" = ANY (ARRAY['abierta'::"text", 'cerrada'::"text"])))
);


ALTER TABLE "public"."cajas" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cash_registers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "ars_opening" numeric(12,2) DEFAULT 0 NOT NULL,
    "ars_balance" numeric(12,2) DEFAULT 0 NOT NULL,
    "usd_opening" numeric(12,2) DEFAULT 0 NOT NULL,
    "usd_balance" numeric(12,2) DEFAULT 0 NOT NULL,
    "exchange_rate" numeric(12,4) DEFAULT 1 NOT NULL,
    "notes" "text",
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "closed_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "cash_registers_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'closed'::"text"])))
);


ALTER TABLE "public"."cash_registers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."clic_wholesale_product_settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "inventory_id" "uuid" NOT NULL,
    "main_image_url" "text",
    "gallery_images" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "short_description" "text",
    "description" "text",
    "features" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "is_visible" boolean DEFAULT false NOT NULL,
    "is_featured" boolean DEFAULT false NOT NULL,
    "badge" "text",
    "min_quantity" integer DEFAULT 1 NOT NULL,
    "display_order" integer DEFAULT 0 NOT NULL,
    "internal_notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "clic_wholesale_product_settings_badge_check" CHECK (("badge" = ANY (ARRAY['nuevo'::"text", 'oferta'::"text", 'mas_vendido'::"text", 'ultimas_unidades'::"text"])))
);


ALTER TABLE "public"."clic_wholesale_product_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."comprobante_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "comprobante_id" "uuid" NOT NULL,
    "descripcion" "text" NOT NULL,
    "cantidad" numeric(10,2) DEFAULT 1 NOT NULL,
    "precio_unitario" numeric(12,2) DEFAULT 0 NOT NULL,
    "subtotal" numeric(12,2) DEFAULT 0 NOT NULL,
    "inventory_id" "uuid",
    "orden" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "business_id" "uuid" NOT NULL,
    "created_by" "uuid",
    "currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "exchange_rate" numeric(12,4) DEFAULT 1 NOT NULL,
    "tipo_linea" "text" DEFAULT 'producto'::"text",
    "descuento_linea" numeric(5,2) DEFAULT 0,
    "costo_unitario" numeric(14,2) DEFAULT 0,
    "costo_total" numeric(14,2) DEFAULT 0,
    "applied_price_type" "text" DEFAULT 'minorista'::"text",
    "stock_processed" boolean DEFAULT false,
    "stock_processed_at" timestamp with time zone,
    "stock_movement_id" "uuid",
    CONSTRAINT "comprobante_items_applied_price_type_check" CHECK (("applied_price_type" = ANY (ARRAY['minorista'::"text", 'mayorista'::"text", 'manual'::"text", 'oferta'::"text"]))),
    CONSTRAINT "comprobante_items_tipo_linea_check" CHECK (("tipo_linea" = ANY (ARRAY['producto'::"text", 'servicio'::"text", 'repuesto'::"text", 'otro'::"text"])))
);


ALTER TABLE "public"."comprobante_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."comprobante_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "comprobante_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "amount" numeric(14,2) DEFAULT 0 NOT NULL,
    "currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "amount_ars" numeric(14,2) DEFAULT 0 NOT NULL,
    "exchange_rate" numeric(12,4) DEFAULT 1 NOT NULL,
    "payment_method" "text" DEFAULT 'efectivo'::"text" NOT NULL,
    "payment_provider" "text",
    "commission_rate" numeric(7,4) DEFAULT 0,
    "commission_amount" numeric(14,2) DEFAULT 0,
    "net_amount" numeric(14,2) DEFAULT 0,
    "date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "comprobante_payments_currency_check" CHECK (("currency" = ANY (ARRAY['ARS'::"text", 'USD'::"text"]))),
    CONSTRAINT "comprobante_payments_payment_method_check" CHECK (("payment_method" = ANY (ARRAY['efectivo'::"text", 'transferencia'::"text", 'tarjeta_debito'::"text", 'tarjeta_credito'::"text", 'qr'::"text", 'mixto'::"text", 'otro'::"text"])))
);


ALTER TABLE "public"."comprobante_payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."comprobantes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid",
    "customer_id" "uuid",
    "tipo" "text" NOT NULL,
    "numero" "text",
    "punto_venta" "text" DEFAULT '0001'::"text",
    "fecha" timestamp with time zone DEFAULT "now"(),
    "subtotal" numeric(12,2) DEFAULT 0 NOT NULL,
    "impuestos" numeric(12,2) DEFAULT 0 NOT NULL,
    "total" numeric(12,2) DEFAULT 0 NOT NULL,
    "estado" "text" DEFAULT 'borrador'::"text" NOT NULL,
    "cae" "text",
    "cae_vencimiento" timestamp with time zone,
    "afip_response" "jsonb",
    "condicion_fiscal" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "business_id" "uuid" NOT NULL,
    "created_by" "uuid",
    "estado_fiscal" "text" DEFAULT 'borrador'::"text",
    "tipo_comprobante_fiscal" "text",
    "numero_comprobante" "text",
    "resultado_fiscal" "text",
    "observaciones_fiscales" "text",
    "error_codigo" "text",
    "error_mensaje" "text",
    "request_data" "jsonb",
    "response_data" "jsonb",
    "fecha_emision_fiscal" timestamp with time zone,
    "currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "total_ars" numeric(12,2) DEFAULT 0 NOT NULL,
    "total_usd" numeric(12,2) DEFAULT 0 NOT NULL,
    "exchange_rate" numeric(12,4) DEFAULT 1 NOT NULL,
    "type" "text",
    "number" "text",
    "date" timestamp with time zone DEFAULT "now"(),
    "tax" numeric(12,2) DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "estado_comercial" "text" DEFAULT 'pendiente'::"text",
    "es_fiscal" boolean DEFAULT false,
    "emitir_en_arca" boolean DEFAULT false,
    "numero_fiscal" "text",
    "observaciones" "text",
    "descuento_total" numeric(14,2) DEFAULT 0,
    "recargo_total" numeric(14,2) DEFAULT 0,
    "total_bruto" numeric(14,2) DEFAULT 0,
    "total_cobrado" numeric(14,2) DEFAULT 0,
    "saldo_pendiente" numeric(14,2) DEFAULT 0,
    "total_comisiones" numeric(14,2) DEFAULT 0,
    "total_neto" numeric(14,2) DEFAULT 0,
    "payment_status" "text" DEFAULT 'pending'::"text",
    "payment_provider" "text",
    "payment_channel" "text",
    "payment_integration" "text" DEFAULT 'none'::"text",
    "external_reference" "text",
    "provider_order_id" "text",
    "provider_payment_id" "text",
    "gross_amount" numeric(14,2),
    "fee_amount" numeric(14,2) DEFAULT 0,
    "net_amount" numeric(14,2),
    "amount_paid" numeric(14,2) DEFAULT 0,
    "payment_approved_at" timestamp with time zone,
    "local_id" "uuid",
    "comprobante_original_id" "uuid",
    CONSTRAINT "comprobantes_estado_check" CHECK (("estado" = ANY (ARRAY['borrador'::"text", 'emitido'::"text", 'anulado'::"text"]))),
    CONSTRAINT "comprobantes_estado_comercial_check" CHECK (("estado_comercial" = ANY (ARRAY['pendiente'::"text", 'parcial'::"text", 'pagado'::"text", 'anulado'::"text"]))),
    CONSTRAINT "comprobantes_estado_fiscal_check" CHECK (("estado_fiscal" = ANY (ARRAY['no_fiscal'::"text", 'pendiente_emision'::"text", 'emitido'::"text", 'error_emision'::"text", 'anulado_fiscal'::"text"]))),
    CONSTRAINT "comprobantes_payment_status_check" CHECK (("payment_status" = ANY (ARRAY['pending'::"text", 'partial'::"text", 'paid'::"text", 'refunded'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "comprobantes_tipo_check" CHECK (("tipo" = ANY (ARRAY['remito'::"text", 'factura_a'::"text", 'factura_c'::"text", 'nota_credito'::"text"])))
);


ALTER TABLE "public"."comprobantes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contact_leads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "email" "text" NOT NULL,
    "business_name" "text",
    "message" "text",
    "source" "text" DEFAULT 'landing'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "text" DEFAULT 'nuevo'::"text" NOT NULL,
    "notes" "text",
    CONSTRAINT "contact_leads_status_check" CHECK (("status" = ANY (ARRAY['nuevo'::"text", 'contactado'::"text", 'convertido'::"text", 'descartado'::"text"])))
);


ALTER TABLE "public"."contact_leads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."customer_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid",
    "event_type" "text" NOT NULL,
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "customer_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['login'::"text", 'product_view'::"text", 'add_to_cart'::"text", 'abandoned_cart'::"text", 'whatsapp_order'::"text", 'purchase_completed'::"text", 'register'::"text"])))
);


ALTER TABLE "public"."customer_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."customers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "phone" "text" NOT NULL,
    "email" "text",
    "address" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "business_id" "uuid" NOT NULL,
    "notes" "text",
    "document" "text",
    "city" "text",
    "active" boolean DEFAULT true NOT NULL,
    "customer_type" "text" DEFAULT 'minorista'::"text" NOT NULL,
    CONSTRAINT "customers_customer_type_check" CHECK (("customer_type" = ANY (ARRAY['minorista'::"text", 'mayorista'::"text"])))
);


ALTER TABLE "public"."customers" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."dashboard_daily_summary" AS
 SELECT "business_id",
    "date",
    "sum"(
        CASE
            WHEN ("type" = 'income'::"text") THEN "amount_ars"
            ELSE (0)::numeric
        END) AS "income",
    "sum"(
        CASE
            WHEN ("type" <> 'income'::"text") THEN "amount_ars"
            ELSE (0)::numeric
        END) AS "expenses",
    "sum"(
        CASE
            WHEN ("type" = 'income'::"text") THEN "amount_ars"
            ELSE (- "amount_ars")
        END) AS "net",
    "count"(
        CASE
            WHEN ("type" = 'income'::"text") THEN 1
            ELSE NULL::integer
        END) AS "income_count",
    "count"(
        CASE
            WHEN ("type" <> 'income'::"text") THEN 1
            ELSE NULL::integer
        END) AS "expense_count"
   FROM "public"."business_finance_entries"
  GROUP BY "business_id", "date";


ALTER VIEW "public"."dashboard_daily_summary" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."device_inspections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid" NOT NULL,
    "type" character varying(20) NOT NULL,
    "face_id" boolean DEFAULT false,
    "touch_screen" boolean DEFAULT false,
    "display_image" boolean DEFAULT false,
    "front_camera" boolean DEFAULT false,
    "back_camera" boolean DEFAULT false,
    "microphone" boolean DEFAULT false,
    "speaker" boolean DEFAULT false,
    "wifi" boolean DEFAULT false,
    "bluetooth" boolean DEFAULT false,
    "charging" boolean DEFAULT false,
    "battery_health" boolean DEFAULT false,
    "sensors" boolean DEFAULT false,
    "buttons" boolean DEFAULT false,
    "vibration" boolean DEFAULT false,
    "screen_condition" character varying(50) DEFAULT 'Perfecto'::character varying,
    "back_condition" character varying(50) DEFAULT 'Perfecto'::character varying,
    "frame_condition" character varying(50) DEFAULT 'Perfecto'::character varying,
    "camera_lens" character varying(50) DEFAULT 'Perfecto'::character varying,
    "accessories" "text"[] DEFAULT '{}'::"text"[],
    "customer_notes" "text",
    "technician_notes" "text",
    "customer_signature" "text",
    "photos" "text"[] DEFAULT '{}'::"text"[],
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "business_id" "uuid" NOT NULL,
    CONSTRAINT "device_inspections_type_check" CHECK ((("type")::"text" = ANY (ARRAY[('reception'::character varying)::"text", ('final'::character varying)::"text"])))
);


ALTER TABLE "public"."device_inspections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."device_models" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "brand_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "normalized_name" "text" DEFAULT ''::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."device_models" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."devices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "customer_id" "uuid",
    "type" "text" NOT NULL,
    "brand" "text" NOT NULL,
    "model" "text" NOT NULL,
    "serial" "text",
    "imei" "text",
    "issue" "text" NOT NULL,
    "diagnosis" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "business_id" "uuid" NOT NULL,
    CONSTRAINT "devices_type_check" CHECK (("type" = ANY (ARRAY['smartphone'::"text", 'tablet'::"text", 'laptop'::"text", 'smartwatch'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."devices" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid",
    "file_name" "text" NOT NULL,
    "file_url" "text" NOT NULL,
    "file_type" "text" NOT NULL,
    "file_size" integer,
    "uploaded_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "business_id" "uuid" NOT NULL
);


ALTER TABLE "public"."documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dollar_rate_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid",
    "sell_price" numeric(12,2) NOT NULL,
    "buy_price" numeric(12,2),
    "source" "text" NOT NULL,
    "source_url" "text",
    "province" "text",
    "variation" numeric(6,2),
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."dollar_rate_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."electronic_invoice_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "comprobante_id" "uuid",
    "punto_venta" integer NOT NULL,
    "tipo_comprobante" "text" NOT NULL,
    "numero_comprobante" "text",
    "accion" "text" NOT NULL,
    "estado" "text" NOT NULL,
    "request_data" "jsonb",
    "response_data" "jsonb",
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."electronic_invoice_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."exchange_rates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "base_currency" "text" DEFAULT 'USD'::"text" NOT NULL,
    "target_currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "rate" numeric(12,4) NOT NULL,
    "is_manual" boolean DEFAULT true NOT NULL,
    "source" "text" DEFAULT 'manual'::"text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "exchange_rates_base_currency_check" CHECK (("base_currency" = ANY (ARRAY['USD'::"text", 'ARS'::"text"]))),
    CONSTRAINT "exchange_rates_rate_positive_check" CHECK (("rate" > (0)::numeric)),
    CONSTRAINT "exchange_rates_target_currency_check" CHECK (("target_currency" = ANY (ARRAY['USD'::"text", 'ARS'::"text"])))
);


ALTER TABLE "public"."exchange_rates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."expense_categories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "color" "text" DEFAULT '#6366f1'::"text",
    "monthly_limit" numeric(12,2),
    "is_active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."expense_categories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."expenses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "description" "text" NOT NULL,
    "category" "text" NOT NULL,
    "amount" numeric(10,2) NOT NULL,
    "supplier_id" "uuid",
    "date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "business_id" "uuid" NOT NULL,
    "currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "payment_method" "text" DEFAULT 'efectivo'::"text",
    "amount_ars" numeric(14,2) DEFAULT 0,
    "exchange_rate" numeric(12,4) DEFAULT 1,
    "finance_entry_id" "uuid",
    "is_recurring" boolean DEFAULT false,
    "frequency" "text",
    "tipo" "text" DEFAULT 'general'::"text",
    "proveedor_id" "uuid",
    "supplier_purchase_id" "uuid",
    "invoice_number" "text",
    CONSTRAINT "expenses_tipo_check" CHECK (("tipo" = ANY (ARRAY['general'::"text", 'factura'::"text"])))
);


ALTER TABLE "public"."expenses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."financial_movements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "currency" "text" NOT NULL,
    "amount" numeric(12,2) NOT NULL,
    "exchange_rate" numeric(12,4) DEFAULT 1 NOT NULL,
    "amount_ars" numeric(12,2) DEFAULT 0 NOT NULL,
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "source_id" "uuid",
    "description" "text",
    "date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reference_id" "uuid",
    "reference_type" "text",
    "comprobante_id" "uuid",
    "payment_transaction_id" "uuid",
    "movement_type" "text" DEFAULT 'income'::"text",
    "provider" "text",
    "channel" "text",
    "sign" smallint DEFAULT 1 NOT NULL,
    "local_id" "uuid",
    "caja_id" "uuid",
    "metodo_pago" "text",
    CONSTRAINT "financial_movements_amount_check" CHECK (("amount" > (0)::numeric)),
    CONSTRAINT "financial_movements_currency_check" CHECK (("currency" = ANY (ARRAY['ARS'::"text", 'USD'::"text"]))),
    CONSTRAINT "financial_movements_movement_type_check" CHECK (("movement_type" = ANY (ARRAY['income'::"text", 'fee'::"text", 'refund'::"text", 'chargeback'::"text", 'adjustment'::"text"]))),
    CONSTRAINT "financial_movements_sign_check" CHECK (("sign" = ANY (ARRAY['-1'::integer, 1]))),
    CONSTRAINT "financial_movements_type_check" CHECK (("type" = ANY (ARRAY['income'::"text", 'expense'::"text"])))
);


ALTER TABLE "public"."financial_movements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inventory" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "category" "text" NOT NULL,
    "description" "text",
    "stock" integer DEFAULT 0 NOT NULL,
    "min_stock" integer DEFAULT 5 NOT NULL,
    "cost_price" numeric(10,2) NOT NULL,
    "sale_price" numeric(10,2) NOT NULL,
    "supplier_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "stock_quantity" integer DEFAULT 0,
    "reserved_quantity" integer DEFAULT 0,
    "is_active" boolean DEFAULT true,
    "subcategory" "text",
    "max_stock" integer,
    "supplier_code" "text",
    "location" "text",
    "created_by" "uuid",
    "business_id" "uuid" NOT NULL,
    "price_usd" numeric(12,2),
    "currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "base_currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "base_price" numeric(12,2),
    "exchange_rate_used" numeric(12,4),
    "auto_update_price" boolean DEFAULT false NOT NULL,
    "cost_price_usd" numeric(12,2) DEFAULT 0,
    "linked_to_dolar" boolean DEFAULT false,
    "tipo" "text" DEFAULT 'product'::"text" NOT NULL,
    "precio_mayorista" numeric,
    "mayorista_enabled" boolean DEFAULT true,
    "variant_name" "text",
    "has_variants" boolean DEFAULT false,
    "visible_in_wholesale" boolean DEFAULT false NOT NULL,
    "portal_title" "text",
    "portal_description" "text",
    "portal_description_full" "text",
    "portal_compatibility" "text",
    "portal_tags" "text"[],
    "portal_featured" boolean DEFAULT false NOT NULL,
    "portal_is_new" boolean DEFAULT false NOT NULL,
    "portal_on_sale" boolean DEFAULT false NOT NULL,
    "portal_sort_order" integer DEFAULT 0 NOT NULL,
    "portal_condition" "text" DEFAULT 'nuevo'::"text" NOT NULL,
    "portal_warranty" "text",
    "portal_notes" "text",
    "portal_specs" "jsonb",
    "portal_min_qty" integer DEFAULT 1 NOT NULL,
    "portal_main_image" "text",
    "portal_images" "text"[],
    "brand" "text",
    "model" "text",
    "barcode" "text",
    "wholesale_price_ars" numeric(12,2),
    "wholesale_price_usd" numeric(12,2),
    "parent_id" "uuid",
    CONSTRAINT "inventory_base_currency_check" CHECK (("base_currency" = ANY (ARRAY['USD'::"text", 'ARS'::"text"]))),
    CONSTRAINT "inventory_currency_check" CHECK (("currency" = ANY (ARRAY['USD'::"text", 'ARS'::"text"]))),
    CONSTRAINT "inventory_tipo_check" CHECK (("tipo" = ANY (ARRAY['product'::"text", 'service'::"text"])))
);


ALTER TABLE "public"."inventory" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inventory_movements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "inventory_item_id" "uuid" NOT NULL,
    "movement_type" "text" NOT NULL,
    "quantity" integer NOT NULL,
    "previous_stock" integer NOT NULL,
    "new_stock" integer NOT NULL,
    "reference_type" "text",
    "reference_id" "uuid",
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "unit_cost" numeric(12,2),
    "currency" "text" DEFAULT 'ARS'::"text",
    "exchange_rate" numeric(12,4),
    "supplier_id" "uuid",
    "variant_id" "uuid",
    "product_id" "uuid",
    CONSTRAINT "inventory_movements_quantity_check" CHECK (("quantity" <> 0)),
    CONSTRAINT "inventory_movements_type_check" CHECK (("movement_type" = ANY (ARRAY['in'::"text", 'out'::"text", 'adjustment'::"text", 'order_usage'::"text", 'sale'::"text", 'purchase'::"text", 'return'::"text", 'credit_note'::"text", 'cancellation'::"text"])))
);


ALTER TABLE "public"."inventory_movements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inventory_valuation_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid",
    "fecha" "date" NOT NULL,
    "capital_invertido" numeric(12,2) DEFAULT 0,
    "valor_venta" numeric(12,2) DEFAULT 0,
    "ganancia_potencial" numeric(12,2) DEFAULT 0,
    "cantidad_total_items" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."inventory_valuation_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."mp_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "mp_user_id" "text",
    "app_id" "text",
    "client_id" "text",
    "access_token_encrypted" "text",
    "refresh_token_encrypted" "text",
    "token_expires_at" timestamp with time zone,
    "scope" "text",
    "is_active" boolean DEFAULT false NOT NULL,
    "country_id" "text" DEFAULT 'AR'::"text",
    "webhook_url" "text",
    "webhook_secret" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."mp_accounts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid",
    "author" "text" NOT NULL,
    "text" "text" NOT NULL,
    "is_internal" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "business_id" "uuid" NOT NULL
);


ALTER TABLE "public"."notes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "message" "text" NOT NULL,
    "is_read" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "business_id" "uuid" NOT NULL
);


ALTER TABLE "public"."notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."order_checklists" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid",
    "diagnosis_done" boolean DEFAULT false,
    "diagnosis_notes" "text",
    "repair_done" boolean DEFAULT false,
    "parts_replaced" "text"[],
    "final_test_passed" boolean DEFAULT false,
    "cleaning_done" boolean DEFAULT false,
    "quality_control" boolean DEFAULT false,
    "retirement_signature" "text",
    "retirement_signature_date" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "business_id" "uuid" NOT NULL
);


ALTER TABLE "public"."order_checklists" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."order_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid" NOT NULL,
    "product_id" "uuid",
    "business_id" "uuid" NOT NULL,
    "tipo" "text" NOT NULL,
    "descripcion" "text" NOT NULL,
    "cantidad" integer DEFAULT 1 NOT NULL,
    "precio_unitario" numeric(12,2) DEFAULT 0 NOT NULL,
    "costo_unitario" numeric(12,2) DEFAULT 0 NOT NULL,
    "cliente_paga_repuesto" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "order_items_cantidad_check" CHECK (("cantidad" > 0)),
    CONSTRAINT "order_items_costo_unitario_check" CHECK (("costo_unitario" >= (0)::numeric)),
    CONSTRAINT "order_items_precio_unitario_check" CHECK (("precio_unitario" >= (0)::numeric)),
    CONSTRAINT "order_items_tipo_check" CHECK (("tipo" = ANY (ARRAY['repuesto'::"text", 'servicio'::"text"])))
);


ALTER TABLE "public"."order_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."order_parts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid",
    "name" character varying(255) NOT NULL,
    "description" "text",
    "part_number" character varying(100),
    "internal_cost" numeric(10,2) DEFAULT 0,
    "sale_price" numeric(10,2) DEFAULT 0,
    "quantity" integer DEFAULT 1,
    "margin_amount" numeric(10,2) DEFAULT 0,
    "margin_percentage" numeric(5,2) DEFAULT 0,
    "status" character varying(50) DEFAULT 'pending'::character varying,
    "deduct_from_inventory" boolean DEFAULT true,
    "notes" "text",
    "added_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "business_id" "uuid" NOT NULL,
    "cliente_paga_repuesto" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."order_parts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."order_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid",
    "amount" numeric(10,2) NOT NULL,
    "payment_method" "text" NOT NULL,
    "payment_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "business_id" "uuid" NOT NULL,
    "currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    CONSTRAINT "order_payments_payment_method_check" CHECK (("payment_method" = ANY (ARRAY['cash'::"text", 'credit_card'::"text", 'debit_card'::"text", 'transfer'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."order_payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "customer_id" "uuid",
    "device_id" "uuid",
    "technician_id" "uuid",
    "status" "text" DEFAULT 'new'::"text" NOT NULL,
    "priority" "text" DEFAULT 'medium'::"text" NOT NULL,
    "estimated_total" numeric(10,2) DEFAULT 0,
    "labor_cost" numeric(10,2) DEFAULT 0,
    "total_cost" numeric(10,2) DEFAULT 0,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "amount_paid" numeric(10,2) DEFAULT 0,
    "created_by" "uuid",
    "comprobante_id" "uuid",
    "business_id" "uuid" NOT NULL,
    "device_password" "text",
    CONSTRAINT "orders_priority_check" CHECK (("priority" = ANY (ARRAY['urgent'::"text", 'high'::"text", 'medium'::"text", 'low'::"text"]))),
    CONSTRAINT "orders_status_check" CHECK (("status" = ANY (ARRAY['new'::"text", 'diagnosis'::"text", 'waiting_approval'::"text", 'repair'::"text", 'waiting_parts'::"text", 'ready_delivery'::"text", 'waiting_payment'::"text", 'completed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."orders" OWNER TO "postgres";


COMMENT ON COLUMN "public"."orders"."device_password" IS 'Contraseña/patrón del dispositivo. Solo uso interno. NO se imprime. Formato: pattern:0-4-8 | pin:1234 | text:abc';



CREATE TABLE IF NOT EXISTS "public"."owner_withdrawals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "amount" numeric(14,2) NOT NULL,
    "currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "business_financial_movement_id" "uuid",
    "personal_transaction_id" "uuid",
    "destination_account_id" "uuid",
    "notes" "text",
    "status" "text" DEFAULT 'completed'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "owner_withdrawals_amount_check" CHECK (("amount" > (0)::numeric)),
    CONSTRAINT "owner_withdrawals_status_check" CHECK (("status" = ANY (ARRAY['completed'::"text", 'reversed'::"text"])))
);


ALTER TABLE "public"."owner_withdrawals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."parts_used" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid",
    "code" "text" NOT NULL,
    "description" "text" NOT NULL,
    "quantity" integer DEFAULT 1 NOT NULL,
    "unit_price" numeric(10,2) NOT NULL,
    "subtotal" numeric(10,2) GENERATED ALWAYS AS ((("quantity")::numeric * "unit_price")) STORED,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "business_id" "uuid" NOT NULL
);


ALTER TABLE "public"."parts_used" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payment_commission_groups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text",
    "color" "text" DEFAULT '#6366f1'::"text",
    "is_active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."payment_commission_groups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payment_commission_options" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "group_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "percentage" numeric(8,4) DEFAULT 0 NOT NULL,
    "charge_mode" "text" DEFAULT 'customer'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "payment_commission_options_charge_mode_check" CHECK (("charge_mode" = ANY (ARRAY['none'::"text", 'customer'::"text", 'business'::"text"])))
);


ALTER TABLE "public"."payment_commission_options" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payment_method_buttons" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "code" "text" NOT NULL,
    "payment_type" "text" DEFAULT 'other'::"text" NOT NULL,
    "provider" "text" DEFAULT 'manual'::"text" NOT NULL,
    "channel" "text" DEFAULT 'manual'::"text" NOT NULL,
    "integration_kind" "text" DEFAULT 'none'::"text" NOT NULL,
    "installments" integer DEFAULT 1 NOT NULL,
    "fee_percent" numeric(7,4) DEFAULT 0 NOT NULL,
    "fee_fixed" numeric(14,2) DEFAULT 0 NOT NULL,
    "vat_percent" numeric(7,4) DEFAULT 0 NOT NULL,
    "installment_extra_percent" numeric(7,4) DEFAULT 0 NOT NULL,
    "absorbs_fee" boolean DEFAULT false NOT NULL,
    "color" "text" DEFAULT '#6366f1'::"text",
    "icon" "text" DEFAULT 'wallet'::"text",
    "sort_order" integer DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "payment_method_buttons_channel_check" CHECK (("channel" = ANY (ARRAY['manual'::"text", 'integrated'::"text"]))),
    CONSTRAINT "payment_method_buttons_integration_kind_check" CHECK (("integration_kind" = ANY (ARRAY['none'::"text", 'mp_qr'::"text", 'mp_point'::"text", 'mp_checkout'::"text", 'custom'::"text"]))),
    CONSTRAINT "payment_method_buttons_payment_type_check" CHECK (("payment_type" = ANY (ARRAY['cash'::"text", 'transfer'::"text", 'debit'::"text", 'credit'::"text", 'qr'::"text", 'wallet'::"text", 'check'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."payment_method_buttons" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payment_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "comprobante_id" "uuid",
    "payment_button_id" "uuid",
    "provider" "text" DEFAULT 'manual'::"text" NOT NULL,
    "channel" "text" DEFAULT 'manual'::"text" NOT NULL,
    "integration_kind" "text" DEFAULT 'none'::"text" NOT NULL,
    "external_reference" "text",
    "provider_order_id" "text",
    "provider_order_status" "text",
    "mp_qr_data" "text",
    "mp_deep_link" "text",
    "requested_amount" numeric(14,2) DEFAULT 0 NOT NULL,
    "target_net_amount" numeric(14,2),
    "estimated_fee_amount" numeric(14,2) DEFAULT 0 NOT NULL,
    "estimated_net_amount" numeric(14,2) DEFAULT 0 NOT NULL,
    "currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "expires_at" timestamp with time zone,
    "raw_response" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "local_id" "uuid",
    "store_id" "text",
    "pos_id" "text",
    "terminal_id" "text",
    CONSTRAINT "payment_orders_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'approved'::"text", 'rejected'::"text", 'expired'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."payment_orders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payment_transactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "comprobante_id" "uuid",
    "payment_order_id" "uuid",
    "payment_button_id" "uuid",
    "provider" "text" DEFAULT 'manual'::"text" NOT NULL,
    "channel" "text" DEFAULT 'manual'::"text" NOT NULL,
    "integration_kind" "text" DEFAULT 'none'::"text" NOT NULL,
    "provider_payment_id" "text",
    "provider_order_id" "text",
    "external_reference" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "status_detail" "text",
    "payment_method_type" "text",
    "payment_method_id" "text",
    "installments" integer DEFAULT 1,
    "transaction_amount" numeric(14,2) DEFAULT 0 NOT NULL,
    "fee_amount_estimated" numeric(14,2) DEFAULT 0 NOT NULL,
    "fee_amount_real" numeric(14,2),
    "net_amount_estimated" numeric(14,2) DEFAULT 0 NOT NULL,
    "net_amount_real" numeric(14,2),
    "currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "approved_at" timestamp with time zone,
    "released_at" timestamp with time zone,
    "is_manual" boolean DEFAULT false NOT NULL,
    "raw_payment" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "payment_transactions_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'in_process'::"text", 'rejected'::"text", 'refunded'::"text", 'cancelled'::"text", 'charged_back'::"text"])))
);


ALTER TABLE "public"."payment_transactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payment_webhook_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid",
    "provider" "text" DEFAULT 'mercadopago'::"text" NOT NULL,
    "topic" "text",
    "action" "text",
    "resource_id" "text",
    "live_mode" boolean DEFAULT true,
    "raw_payload" "jsonb",
    "processed" boolean DEFAULT false NOT NULL,
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "processed_at" timestamp with time zone
);


ALTER TABLE "public"."payment_webhook_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "provider" "text" DEFAULT 'mercadopago'::"text" NOT NULL,
    "external_payment_id" "text",
    "type" "text" DEFAULT 'recurring'::"text" NOT NULL,
    "amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "subscription_plan" "text",
    "paid_at" timestamp with time zone,
    "period_start" timestamp with time zone,
    "period_end" timestamp with time zone,
    "raw_payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "payments_status_check" CHECK (("status" = ANY (ARRAY['approved'::"text", 'pending'::"text", 'in_process'::"text", 'rejected'::"text", 'cancelled'::"text", 'refunded'::"text", 'charged_back'::"text"]))),
    CONSTRAINT "payments_type_check" CHECK (("type" = ANY (ARRAY['one_time'::"text", 'recurring'::"text", 'manual'::"text"])))
);


ALTER TABLE "public"."payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."personal_account_balances" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "account_id" "uuid" NOT NULL,
    "currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "initial_balance" numeric DEFAULT 0 NOT NULL,
    "current_balance" numeric DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."personal_account_balances" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."personal_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "business_id" "uuid",
    "name" "text" NOT NULL,
    "type" "text" DEFAULT 'cash'::"text" NOT NULL,
    "currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "initial_balance" numeric(14,2) DEFAULT 0 NOT NULL,
    "current_balance" numeric(14,2) DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "personal_accounts_type_check" CHECK (("type" = ANY (ARRAY['cash'::"text", 'bank'::"text", 'digital'::"text", 'savings'::"text", 'dollars'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."personal_accounts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."personal_budgets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "category_id" "uuid" NOT NULL,
    "amount" numeric(15,2) NOT NULL,
    "currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "period" "text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "personal_budgets_amount_check" CHECK (("amount" > (0)::numeric)),
    CONSTRAINT "personal_budgets_currency_check" CHECK (("currency" = ANY (ARRAY['ARS'::"text", 'USD'::"text"]))),
    CONSTRAINT "personal_budgets_period_check" CHECK (("period" ~ '^\d{4}-\d{2}$'::"text")),
    CONSTRAINT "personal_budgets_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'inactive'::"text"])))
);


ALTER TABLE "public"."personal_budgets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."personal_card_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "credit_card_id" "uuid" NOT NULL,
    "period" "text" NOT NULL,
    "amount" numeric NOT NULL,
    "currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "account_id" "uuid",
    "transaction_id" "uuid",
    "payment_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "personal_card_payments_amount_check" CHECK (("amount" > (0)::numeric)),
    CONSTRAINT "personal_card_payments_period_check" CHECK (("period" ~ '^\d{4}-\d{2}$'::"text"))
);


ALTER TABLE "public"."personal_card_payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."personal_card_purchases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "credit_card_id" "uuid" NOT NULL,
    "category_id" "uuid",
    "description" "text" NOT NULL,
    "total_amount" numeric(14,2) NOT NULL,
    "installments" integer DEFAULT 1 NOT NULL,
    "purchase_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "first_installment_month" "text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "personal_card_purchases_installments_check" CHECK (("installments" >= 1)),
    CONSTRAINT "personal_card_purchases_total_amount_check" CHECK (("total_amount" > (0)::numeric))
);


ALTER TABLE "public"."personal_card_purchases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."personal_categories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "business_id" "uuid",
    "name" "text" NOT NULL,
    "type" "text" NOT NULL,
    "icon" "text" DEFAULT 'circle'::"text" NOT NULL,
    "color" "text" DEFAULT '#6366f1'::"text" NOT NULL,
    "is_default" boolean DEFAULT false NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "personal_categories_type_check" CHECK (("type" = ANY (ARRAY['income'::"text", 'expense'::"text"])))
);


ALTER TABLE "public"."personal_categories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."personal_credit_cards" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "business_id" "uuid",
    "name" "text" NOT NULL,
    "issuer" "text",
    "closing_day" integer DEFAULT 20 NOT NULL,
    "due_day" integer DEFAULT 10 NOT NULL,
    "credit_limit" numeric(14,2),
    "currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "personal_credit_cards_closing_day_check" CHECK ((("closing_day" >= 1) AND ("closing_day" <= 31))),
    CONSTRAINT "personal_credit_cards_due_day_check" CHECK ((("due_day" >= 1) AND ("due_day" <= 31)))
);


ALTER TABLE "public"."personal_credit_cards" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."personal_debt_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "debt_id" "uuid" NOT NULL,
    "account_id" "uuid",
    "currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "amount" numeric(14,2) NOT NULL,
    "payment_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "notes" "text",
    "transaction_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "personal_debt_payments_amount_check" CHECK (("amount" > (0)::numeric))
);


ALTER TABLE "public"."personal_debt_payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."personal_debts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "lender_name" "text",
    "initial_amount" numeric(14,2) NOT NULL,
    "current_balance" numeric(14,2) NOT NULL,
    "currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "next_due_date" "date",
    "installment_amount" integer,
    "notes" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "type" "text" DEFAULT 'debt'::"text" NOT NULL,
    "description" "text",
    "due_day" integer,
    "start_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    CONSTRAINT "personal_debts_due_day_check" CHECK ((("due_day" >= 1) AND ("due_day" <= 31))),
    CONSTRAINT "personal_debts_initial_amount_check" CHECK (("initial_amount" > (0)::numeric)),
    CONSTRAINT "personal_debts_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'paid'::"text", 'paused'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "personal_debts_type_check" CHECK (("type" = ANY (ARRAY['debt'::"text", 'receivable'::"text"])))
);


ALTER TABLE "public"."personal_debts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."personal_recurring_expense_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "recurring_expense_id" "uuid" NOT NULL,
    "account_id" "uuid",
    "transaction_id" "uuid",
    "currency" "text" NOT NULL,
    "amount" numeric(14,2) NOT NULL,
    "paid_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "period_year" integer NOT NULL,
    "period_month" integer NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "personal_recurring_expense_payments_amount_check" CHECK (("amount" > (0)::numeric)),
    CONSTRAINT "personal_recurring_expense_payments_period_month_check" CHECK ((("period_month" >= 1) AND ("period_month" <= 12)))
);


ALTER TABLE "public"."personal_recurring_expense_payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."personal_recurring_expenses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "category_id" "uuid",
    "default_account_id" "uuid",
    "currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "amount" numeric(14,2) NOT NULL,
    "frequency" "text" DEFAULT 'monthly'::"text" NOT NULL,
    "due_day" integer,
    "next_due_date" "date",
    "auto_create_transaction" boolean DEFAULT false NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "personal_recurring_expenses_amount_check" CHECK (("amount" > (0)::numeric)),
    CONSTRAINT "personal_recurring_expenses_due_day_check" CHECK ((("due_day" >= 1) AND ("due_day" <= 31))),
    CONSTRAINT "personal_recurring_expenses_frequency_check" CHECK (("frequency" = ANY (ARRAY['monthly'::"text", 'weekly'::"text", 'yearly'::"text", 'custom'::"text"]))),
    CONSTRAINT "personal_recurring_expenses_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'paused'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."personal_recurring_expenses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."personal_savings_goals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "account_id" "uuid",
    "name" "text" NOT NULL,
    "target_amount" numeric(14,2) NOT NULL,
    "current_amount" numeric(14,2) DEFAULT 0 NOT NULL,
    "currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "target_date" "date",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "personal_savings_goals_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'completed'::"text", 'paused'::"text"]))),
    CONSTRAINT "personal_savings_goals_target_amount_check" CHECK (("target_amount" > (0)::numeric))
);


ALTER TABLE "public"."personal_savings_goals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."personal_transactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "business_id" "uuid",
    "account_id" "uuid" NOT NULL,
    "category_id" "uuid",
    "type" "text" NOT NULL,
    "amount" numeric(14,2) NOT NULL,
    "currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "description" "text" NOT NULL,
    "notes" "text",
    "payment_method" "text",
    "linked_business_movement_id" "uuid",
    "linked_owner_withdrawal_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "personal_transactions_amount_check" CHECK (("amount" > (0)::numeric)),
    CONSTRAINT "personal_transactions_type_check" CHECK (("type" = ANY (ARRAY['income'::"text", 'expense'::"text", 'transfer'::"text"])))
);


ALTER TABLE "public"."personal_transactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_offers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "normal_price" numeric(12,2) NOT NULL,
    "offer_price" numeric(12,2) NOT NULL,
    "discount_percent" numeric(5,2),
    "start_date" "date" NOT NULL,
    "end_date" "date" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."product_offers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_variants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "inventory_item_id" "uuid",
    "name" "text" NOT NULL,
    "sku" "text",
    "barcode" "text",
    "attributes" "jsonb" DEFAULT '{}'::"jsonb",
    "cost_price_ars" numeric(12,2) DEFAULT 0,
    "cost_price_usd" numeric(12,2),
    "cost_currency" "text" DEFAULT 'ARS'::"text",
    "sale_price_ars" numeric(12,2) DEFAULT 0,
    "sale_price_usd" numeric(12,2),
    "wholesale_price_ars" numeric(12,2),
    "wholesale_price_usd" numeric(12,2),
    "margin_percent" numeric(6,2),
    "exchange_rate_used" numeric(12,4),
    "stock" integer DEFAULT 0 NOT NULL,
    "min_stock" integer DEFAULT 0 NOT NULL,
    "location" "text",
    "active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_default" boolean DEFAULT false NOT NULL,
    "image_url" "text",
    CONSTRAINT "product_variants_cost_currency_check" CHECK (("cost_currency" = ANY (ARRAY['ARS'::"text", 'USD'::"text"])))
);


ALTER TABLE "public"."product_variants" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."purchase_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "purchase_id" "uuid" NOT NULL,
    "inventory_item_id" "uuid",
    "description" "text" NOT NULL,
    "quantity" integer NOT NULL,
    "unit_cost" numeric(12,2) NOT NULL,
    "subtotal" numeric(12,2) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    CONSTRAINT "purchase_items_quantity_check" CHECK (("quantity" > 0)),
    CONSTRAINT "purchase_items_subtotal_check" CHECK (("subtotal" >= (0)::numeric)),
    CONSTRAINT "purchase_items_unit_cost_check" CHECK (("unit_cost" >= (0)::numeric))
);


ALTER TABLE "public"."purchase_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."purchases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "supplier_id" "uuid",
    "invoice_number" "text",
    "purchase_date" "date" NOT NULL,
    "subtotal" numeric(12,2) DEFAULT 0 NOT NULL,
    "taxes" numeric(12,2) DEFAULT 0 NOT NULL,
    "total" numeric(12,2) DEFAULT 0 NOT NULL,
    "notes" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    CONSTRAINT "purchases_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'confirmed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."purchases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."recurring_expenses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "type" "text" NOT NULL,
    "category" "text" NOT NULL,
    "subcategory" "text",
    "amount" numeric DEFAULT 0 NOT NULL,
    "currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "day_of_month" integer DEFAULT 1 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "recurring_expenses_day_of_month_check" CHECK ((("day_of_month" >= 1) AND ("day_of_month" <= 28)))
);


ALTER TABLE "public"."recurring_expenses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sales_points" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "numero" integer DEFAULT 1 NOT NULL,
    "nombre" "text" DEFAULT ''::"text" NOT NULL,
    "sucursal" "text" DEFAULT ''::"text" NOT NULL,
    "domicilio" "text" DEFAULT ''::"text" NOT NULL,
    "condicion_fiscal" "text" DEFAULT 'Monotributo'::"text" NOT NULL,
    "activo" boolean DEFAULT true NOT NULL,
    "predeterminado" boolean DEFAULT false NOT NULL,
    "tipo_emision" "text" DEFAULT 'manual'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "mp_enabled" boolean DEFAULT false,
    "mp_store_id" "text",
    "mp_pos_id" "text",
    "mp_terminal_id" "text",
    "mp_terminal_mode" "text" DEFAULT 'PDV'::"text",
    "mp_channel_qr" boolean DEFAULT true,
    "mp_channel_point" boolean DEFAULT false,
    "mp_fee_percent" numeric(7,4) DEFAULT 0.0099,
    "mp_fee_fixed" numeric(14,2) DEFAULT 0,
    "mp_vat_percent" numeric(7,4) DEFAULT 0.21
);


ALTER TABLE "public"."sales_points" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."settings_audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "action" "text" NOT NULL,
    "table_name" "text" NOT NULL,
    "record_id" "uuid",
    "old_values" "jsonb",
    "new_values" "jsonb",
    "ip_address" "text",
    "user_agent" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."settings_audit_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."status_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid",
    "status" "text" NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "business_id" "uuid" NOT NULL
);


ALTER TABLE "public"."status_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subscription_admin_actions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "actor_user_id" "uuid" NOT NULL,
    "business_id" "uuid",
    "action" "text" NOT NULL,
    "previous_state" "jsonb",
    "new_state" "jsonb",
    "reason" "text",
    "request_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."subscription_admin_actions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subscription_checkout_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "plan_id" "text" NOT NULL,
    "billing_cycle" "text" DEFAULT 'monthly'::"text" NOT NULL,
    "amount" numeric NOT NULL,
    "currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "mp_preference_id" "text",
    "external_reference" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "subscription_checkout_sessions_plan_id_check" CHECK (("plan_id" = ANY (ARRAY['basico'::"text", 'pro'::"text", 'full'::"text"]))),
    CONSTRAINT "subscription_checkout_sessions_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'paid'::"text", 'failed'::"text", 'expired'::"text", 'canceled'::"text"])))
);


ALTER TABLE "public"."subscription_checkout_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subscription_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid",
    "provider" "text" DEFAULT 'mercadopago'::"text" NOT NULL,
    "event_type" "text" NOT NULL,
    "external_id" "text",
    "raw_payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "processed" boolean DEFAULT false NOT NULL,
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "processed_at" timestamp with time zone
);


ALTER TABLE "public"."subscription_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subscription_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "checkout_session_id" "uuid",
    "plan_id" "text" NOT NULL,
    "billing_cycle" "text" DEFAULT 'monthly'::"text" NOT NULL,
    "amount" numeric NOT NULL,
    "currency" "text" DEFAULT 'ARS'::"text" NOT NULL,
    "provider" "text" DEFAULT 'mercadopago'::"text" NOT NULL,
    "provider_payment_id" "text",
    "status" "text" DEFAULT 'approved'::"text" NOT NULL,
    "paid_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "subscription_payments_status_check" CHECK (("status" = ANY (ARRAY['approved'::"text", 'pending'::"text", 'rejected'::"text", 'refunded'::"text"])))
);


ALTER TABLE "public"."subscription_payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subscription_webhook_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid",
    "event_type" "text",
    "provider" "text" DEFAULT 'mercadopago'::"text",
    "mp_payment_id" "text",
    "mp_status" "text",
    "external_ref" "text",
    "result" "text",
    "error_msg" "text",
    "raw_payload" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."subscription_webhook_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."supplier_account_movements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "supplier_id" "uuid" NOT NULL,
    "purchase_id" "uuid",
    "payment_id" "uuid",
    "movement_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "type" "text" NOT NULL,
    "description" "text" NOT NULL,
    "debit" numeric(12,2) DEFAULT 0 NOT NULL,
    "credit" numeric(12,2) DEFAULT 0 NOT NULL,
    "balance_after" numeric(12,2) DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "supplier_account_movements_type_check" CHECK (("type" = ANY (ARRAY['purchase'::"text", 'payment'::"text", 'adjustment'::"text", 'credit_note'::"text"])))
);


ALTER TABLE "public"."supplier_account_movements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."supplier_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "supplier_id" "uuid" NOT NULL,
    "purchase_id" "uuid",
    "payment_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "amount" numeric(12,2) NOT NULL,
    "payment_method" "text" DEFAULT 'efectivo'::"text" NOT NULL,
    "notes" "text",
    "attachment_url" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "financial_movement_id" "uuid"
);


ALTER TABLE "public"."supplier_payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."supplier_purchase_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "purchase_id" "uuid" NOT NULL,
    "supplier_id" "uuid",
    "inventory_id" "uuid",
    "product_name" "text" NOT NULL,
    "quantity" numeric(10,2) DEFAULT 1 NOT NULL,
    "unit_cost" numeric(12,2) DEFAULT 0 NOT NULL,
    "subtotal" numeric(12,2) DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."supplier_purchase_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."supplier_purchases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "supplier_id" "uuid",
    "purchase_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "invoice_number" "text",
    "total_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "paid_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "pending_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "payment_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "payment_method" "text",
    "notes" "text",
    "attachment_url" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "supplier_purchases_payment_status_check" CHECK (("payment_status" = ANY (ARRAY['pending'::"text", 'partial'::"text", 'paid'::"text"])))
);


ALTER TABLE "public"."supplier_purchases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."suppliers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "contact_name" "text",
    "phone" "text",
    "email" "text",
    "address" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "business_id" "uuid" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "business_name" "text",
    "tax_id" "text",
    "fiscal_condition" "text",
    "whatsapp" "text",
    "city" "text",
    "province" "text",
    "country" "text" DEFAULT 'Argentina'::"text",
    "category" "text",
    "delivery_days" "text",
    "payment_method_preferred" "text",
    "bank_alias" "text",
    "bank_cbu" "text",
    "website" "text",
    "internal_notes" "text"
);


ALTER TABLE "public"."suppliers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."system_admins" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "email" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "text" DEFAULT 'super_admin'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "revoked_at" timestamp with time zone,
    "revoked_by" "uuid",
    CONSTRAINT "system_admins_role_chk" CHECK (("role" = ANY (ARRAY['super_admin'::"text", 'billing_admin'::"text", 'support_readonly'::"text"])))
);


ALTER TABLE "public"."system_admins" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."task_comments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "task_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "comment" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."task_comments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."task_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "task_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "action" "text" NOT NULL,
    "old_value" "text",
    "new_value" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."task_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."task_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "task_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "is_done" boolean DEFAULT false,
    "sort_order" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."task_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tasks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid",
    "user_id" "uuid",
    "title" "text" NOT NULL,
    "description" "text",
    "due_date" "date",
    "priority" "text" DEFAULT 'medium'::"text",
    "status" "text" DEFAULT 'pending'::"text",
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "assigned_to" "uuid",
    "created_by" "uuid",
    "started_at" timestamp with time zone,
    "is_recurring" boolean DEFAULT false,
    "recurrence_type" "text",
    CONSTRAINT "tasks_priority_check" CHECK (("priority" = ANY (ARRAY['low'::"text", 'medium'::"text", 'high'::"text", 'urgent'::"text"]))),
    CONSTRAINT "tasks_recurrence_type_check" CHECK (("recurrence_type" = ANY (ARRAY['daily'::"text", 'weekly'::"text", 'monthly'::"text"]))),
    CONSTRAINT "tasks_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'completed'::"text"])))
);


ALTER TABLE "public"."tasks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."users" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "email" "text" NOT NULL,
    "role" "text" NOT NULL,
    "phone" "text",
    "active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    CONSTRAINT "users_role_check" CHECK (("role" = ANY (ARRAY['admin'::"text", 'technician'::"text", 'receptionist'::"text"])))
);


ALTER TABLE "public"."users" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_comprobantes_full" AS
 SELECT "c"."id",
    "c"."order_id",
    "c"."customer_id",
    "c"."tipo",
    "c"."numero",
    "c"."punto_venta",
    "c"."fecha",
    "c"."subtotal",
    "c"."impuestos",
    "c"."total",
    "c"."estado",
    "c"."cae",
    "c"."cae_vencimiento",
    "c"."afip_response",
    "c"."condicion_fiscal",
    "c"."created_at",
    "c"."updated_at",
    "c"."business_id",
    "c"."created_by",
    "c"."estado_fiscal",
    "c"."tipo_comprobante_fiscal",
    "c"."numero_comprobante",
    "c"."resultado_fiscal",
    "c"."observaciones_fiscales",
    "c"."error_codigo",
    "c"."error_mensaje",
    "c"."request_data",
    "c"."response_data",
    "c"."fecha_emision_fiscal",
    "c"."currency",
    "c"."total_ars",
    "c"."total_usd",
    "c"."exchange_rate",
    "c"."type",
    "c"."number",
    "c"."date",
    "c"."tax",
    "c"."status",
    "c"."estado_comercial",
    "c"."es_fiscal",
    "c"."emitir_en_arca",
    "c"."numero_fiscal",
    "c"."observaciones",
    "c"."descuento_total",
    "c"."recargo_total",
    "c"."total_bruto",
    "c"."total_cobrado",
    "c"."saldo_pendiente",
    "c"."total_comisiones",
    "c"."total_neto",
    "cust"."name" AS "customer_name",
    "cust"."phone" AS "customer_phone",
    "cust"."email" AS "customer_email",
    COALESCE("pay"."total_pagado", (0)::numeric) AS "total_pagado_calc",
    GREATEST((0)::numeric, (COALESCE("c"."total_bruto", "c"."total_ars", "c"."total", (0)::numeric) - COALESCE("pay"."total_pagado", (0)::numeric))) AS "saldo_calc",
    "pay"."medios_de_pago"
   FROM (("public"."comprobantes" "c"
     LEFT JOIN "public"."customers" "cust" ON (("c"."customer_id" = "cust"."id")))
     LEFT JOIN ( SELECT "comprobante_payments"."comprobante_id",
            "sum"("comprobante_payments"."amount_ars") AS "total_pagado",
            "string_agg"(DISTINCT "comprobante_payments"."payment_method", ', '::"text") AS "medios_de_pago"
           FROM "public"."comprobante_payments"
          GROUP BY "comprobante_payments"."comprobante_id") "pay" ON (("c"."id" = "pay"."comprobante_id")));


ALTER VIEW "public"."v_comprobantes_full" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_payment_analytics" AS
 SELECT "business_id",
    "date_trunc"('month'::"text", "created_at") AS "month",
    "provider",
    "channel",
    "payment_method_type",
    "count"(*) AS "total_transactions",
    "sum"("transaction_amount") AS "gross_total",
    "sum"(COALESCE("fee_amount_real", "fee_amount_estimated")) AS "fee_total",
    "sum"(COALESCE("net_amount_real", "net_amount_estimated")) AS "net_total",
    "avg"(((COALESCE("fee_amount_real", "fee_amount_estimated") / NULLIF("transaction_amount", (0)::numeric)) * (100)::numeric)) AS "avg_fee_pct",
    "count"(*) FILTER (WHERE ("fee_amount_real" IS NOT NULL)) AS "reconciled_count"
   FROM "public"."payment_transactions" "pt"
  WHERE ("status" = 'approved'::"text")
  GROUP BY "business_id", ("date_trunc"('month'::"text", "created_at")), "provider", "channel", "payment_method_type";


ALTER VIEW "public"."v_payment_analytics" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_subscription_overview" AS
SELECT
    NULL::"uuid" AS "business_id",
    NULL::"text" AS "business_name",
    NULL::"text" AS "subscription_status",
    NULL::"text" AS "subscription_plan",
    NULL::"text" AS "mp_preapproval_id",
    NULL::"text" AS "mp_payer_email",
    NULL::timestamp with time zone AS "current_period_end",
    NULL::timestamp with time zone AS "grace_until",
    NULL::"text" AS "last_payment_status",
    NULL::timestamp with time zone AS "last_webhook_at",
    NULL::timestamp with time zone AS "trial_ends_at",
    NULL::timestamp with time zone AS "created_at",
    NULL::bigint AS "total_payments",
    NULL::timestamp with time zone AS "last_paid_at",
    NULL::numeric AS "total_revenue";


ALTER VIEW "public"."v_subscription_overview" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."vista_comprobantes_resumen" AS
 SELECT "c"."id",
    "c"."tipo",
    "c"."numero",
    "c"."punto_venta",
    "c"."fecha",
    "c"."estado",
    "c"."subtotal",
    "c"."impuestos",
    "c"."total",
    "c"."cae",
    "c"."order_id",
    "left"(("c"."order_id")::"text", 8) AS "orden_numero",
    "c"."customer_id",
    "cust"."name" AS "cliente_nombre",
    "cust"."phone" AS "cliente_contacto",
    "count"("ci"."id") AS "cantidad_items"
   FROM (("public"."comprobantes" "c"
     LEFT JOIN "public"."customers" "cust" ON (("c"."customer_id" = "cust"."id")))
     LEFT JOIN "public"."comprobante_items" "ci" ON (("c"."id" = "ci"."comprobante_id")))
  GROUP BY "c"."id", "c"."tipo", "c"."numero", "c"."punto_venta", "c"."fecha", "c"."estado", "c"."subtotal", "c"."impuestos", "c"."total", "c"."cae", "c"."order_id", "c"."customer_id", "cust"."name", "cust"."phone"
  ORDER BY "c"."fecha" DESC;


ALTER VIEW "public"."vista_comprobantes_resumen" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."warranties" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "number" "text" NOT NULL,
    "issue_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "customer_name" "text" NOT NULL,
    "customer_dni" "text",
    "customer_phone" "text",
    "phone_model" "text" NOT NULL,
    "imei" "text",
    "serial_number" "text",
    "supplier_id" "uuid",
    "warranty_days" integer DEFAULT 30 NOT NULL,
    "equipment_status" "text" DEFAULT 'new'::"text" NOT NULL,
    "purchase_date" "date",
    "checklist" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "observations" "text",
    "conditions" "text",
    "attended_by_user_id" "uuid",
    "attended_by_name" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "warranty_source" "text" DEFAULT 'sold_device'::"text",
    "warranty_type" "text" DEFAULT 'sold_device'::"text",
    "order_id" "uuid",
    "comprobante_id" "uuid",
    "comprobante_item_id" "uuid",
    "inventory_id" "uuid",
    "customer_id" "uuid",
    "item_description" "text",
    "warranty_status" "text" DEFAULT 'open'::"text",
    "claim_notes" "text",
    "void_reason" "text",
    "resolved_at" timestamp with time zone,
    CONSTRAINT "warranties_equipment_status_check" CHECK (("equipment_status" = ANY (ARRAY['new'::"text", 'used'::"text"]))),
    CONSTRAINT "warranties_warranty_days_check" CHECK (("warranty_days" > 0))
);


ALTER TABLE "public"."warranties" OWNER TO "postgres";


COMMENT ON TABLE "public"."warranties" IS 'Garantías de equipos vendidos. El proveedor (supplier_id) es solo interno y no aparece en la impresión al cliente.';



CREATE TABLE IF NOT EXISTS "public"."warranty_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "warranty_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."warranty_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."whatsapp_automation_settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "send_on_received" boolean DEFAULT true NOT NULL,
    "send_on_diagnosis" boolean DEFAULT false NOT NULL,
    "send_on_repair" boolean DEFAULT false NOT NULL,
    "send_on_ready" boolean DEFAULT true NOT NULL,
    "send_on_delivered" boolean DEFAULT false NOT NULL,
    "template_map" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."whatsapp_automation_settings" OWNER TO "postgres";


COMMENT ON TABLE "public"."whatsapp_automation_settings" IS 'Configuración de mensajes automáticos de WhatsApp por negocio';



COMMENT ON COLUMN "public"."whatsapp_automation_settings"."enabled" IS 'Si es false, no se envía ningún mensaje automático';



COMMENT ON COLUMN "public"."whatsapp_automation_settings"."template_map" IS 'JSON: mapeo de evento -> nombre de template en Meta Business Manager';



CREATE TABLE IF NOT EXISTS "public"."whatsapp_connection_credentials" (
    "connection_id" "uuid" NOT NULL,
    "vault_secret_id" "uuid" NOT NULL,
    "token_expires_at" timestamp with time zone,
    "rotated_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."whatsapp_connection_credentials" OWNER TO "postgres";


COMMENT ON TABLE "public"."whatsapp_connection_credentials" IS 'Vincula whatsapp_connections con su token cifrado en Vault. Sin grants a anon/authenticated. Solo service_role / Edge Functions vía RPC.';



CREATE TABLE IF NOT EXISTS "public"."whatsapp_connection_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "connection_id" "uuid",
    "event_type" "text" NOT NULL,
    "actor_type" "text" DEFAULT 'service_role'::"text" NOT NULL,
    "actor_user_id" "uuid",
    "previous_status" "text",
    "new_status" "text",
    "reason" "text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "whatsapp_connection_events_actor_type_check" CHECK (("actor_type" = ANY (ARRAY['service_role'::"text", 'system'::"text"]))),
    CONSTRAINT "whatsapp_connection_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['provisioned'::"text", 'reconnected'::"text", 'disconnected'::"text", 'credential_rotated'::"text", 'credential_revoked'::"text", 'provision_failed'::"text"])))
);


ALTER TABLE "public"."whatsapp_connection_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."whatsapp_connection_events" IS 'Append-only audit of WhatsApp connection lifecycle. Never stores tokens, secrets, full phone numbers or credentials. Written ONLY by service_role SECURITY DEFINER RPCs.';



CREATE TABLE IF NOT EXISTS "public"."whatsapp_connections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "waba_id" "text",
    "phone_number_id" "text",
    "business_phone_number" "text",
    "system_user_id" "text",
    "token_expires_at" timestamp with time zone,
    "connected_account_name" "text",
    "status" "text" DEFAULT 'connected'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."whatsapp_connections" OWNER TO "postgres";


COMMENT ON TABLE "public"."whatsapp_connections" IS 'Credenciales y datos de cuentas WABA conectadas por negocio';



COMMENT ON COLUMN "public"."whatsapp_connections"."waba_id" IS 'WhatsApp Business Account ID asignado por Meta';



COMMENT ON COLUMN "public"."whatsapp_connections"."phone_number_id" IS 'ID del número de teléfono registrado en la WABA';



COMMENT ON COLUMN "public"."whatsapp_connections"."status" IS 'Estado: connected | disconnected | error | pending';



CREATE TABLE IF NOT EXISTS "public"."whatsapp_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "order_id" "uuid",
    "customer_id" "uuid",
    "phone" "text",
    "status_key" "text",
    "message" "text" NOT NULL,
    "send_mode" "text" DEFAULT 'manual'::"text" NOT NULL,
    "send_result" "text" DEFAULT 'opened'::"text" NOT NULL,
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "whatsapp_logs_send_mode_check" CHECK (("send_mode" = ANY (ARRAY['manual'::"text", 'auto'::"text", 'api'::"text"]))),
    CONSTRAINT "whatsapp_logs_send_result_check" CHECK (("send_result" = ANY (ARRAY['opened'::"text", 'copied'::"text", 'failed'::"text", 'skipped'::"text", 'sent_api'::"text"])))
);


ALTER TABLE "public"."whatsapp_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."whatsapp_message_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "connection_id" "uuid",
    "customer_phone" "text" NOT NULL,
    "template_name" "text",
    "template_language" "text" DEFAULT 'es_AR'::"text" NOT NULL,
    "payload" "jsonb",
    "meta_message_id" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "direction" "text" DEFAULT 'outbound'::"text" NOT NULL,
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."whatsapp_message_logs" OWNER TO "postgres";


COMMENT ON TABLE "public"."whatsapp_message_logs" IS 'Log de todos los mensajes enviados y recibidos vía WhatsApp Cloud API';



COMMENT ON COLUMN "public"."whatsapp_message_logs"."meta_message_id" IS 'wamid devuelto por la Graph API de Meta al enviar el mensaje';



COMMENT ON COLUMN "public"."whatsapp_message_logs"."status" IS 'Estado del mensaje: pending | sent | delivered | read | failed';



COMMENT ON COLUMN "public"."whatsapp_message_logs"."direction" IS 'Dirección: outbound (enviado por el sistema) | inbound (recibido del cliente)';



CREATE TABLE IF NOT EXISTS "public"."whatsapp_settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "enabled" boolean DEFAULT false NOT NULL,
    "auto_send_enabled" boolean DEFAULT false NOT NULL,
    "business_name" "text",
    "business_address" "text",
    "business_whatsapp" "text",
    "business_instagram" "text",
    "business_hours" "text",
    "closing_message" "text" DEFAULT 'Saludos, {local}.
WhatsApp: {whatsapp}
Instagram: {instagram}'::"text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "api_mode" boolean DEFAULT false,
    "phone_number_id" "text"
);


ALTER TABLE "public"."whatsapp_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."whatsapp_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "status_key" "text" NOT NULL,
    "status_label" "text" NOT NULL,
    "message_template" "text" NOT NULL,
    "auto_send" boolean DEFAULT false NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."whatsapp_templates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."wholesale_customers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "auth_user_id" "uuid",
    "name" "text" NOT NULL,
    "business_name" "text",
    "email" "text" NOT NULL,
    "whatsapp" "text",
    "whatsapp_verified" boolean DEFAULT false NOT NULL,
    "whatsapp_code" "text",
    "whatsapp_code_expires_at" timestamp with time zone,
    "province" "text",
    "city" "text",
    "instagram" "text",
    "approved" boolean DEFAULT false NOT NULL,
    "suspended" boolean DEFAULT false NOT NULL,
    "notes" "text",
    "tags" "text"[],
    "last_login" timestamp with time zone,
    "last_order_at" timestamp with time zone,
    "total_orders" integer DEFAULT 0 NOT NULL,
    "total_spent" numeric DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."wholesale_customers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."wholesale_order_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "inventory_item_id" "uuid",
    "product_name" "text" NOT NULL,
    "product_code" "text",
    "quantity" integer NOT NULL,
    "unit_price" numeric NOT NULL,
    "subtotal" numeric NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "stock_processed" boolean DEFAULT false,
    "stock_processed_at" timestamp with time zone,
    "stock_movement_id" "uuid"
);


ALTER TABLE "public"."wholesale_order_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."wholesale_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "order_number" "text" NOT NULL,
    "status" "text" DEFAULT 'pending_whatsapp'::"text" NOT NULL,
    "subtotal" numeric DEFAULT 0 NOT NULL,
    "total" numeric DEFAULT 0 NOT NULL,
    "notes" "text",
    "admin_notes" "text",
    "whatsapp_sent_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "wholesale_orders_status_check" CHECK (("status" = ANY (ARRAY['pending_whatsapp'::"text", 'pending_review'::"text", 'approved'::"text", 'rejected'::"text", 'invoiced'::"text", 'delivered'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."wholesale_orders" OWNER TO "postgres";


ALTER TABLE ONLY "public"."account_movements"
    ADD CONSTRAINT "account_movements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."accounts"
    ADD CONSTRAINT "accounts_business_id_entity_id_key" UNIQUE ("business_id", "entity_id");



ALTER TABLE ONLY "public"."accounts"
    ADD CONSTRAINT "accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."arca_config"
    ADD CONSTRAINT "arca_config_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."arca_parametros"
    ADD CONSTRAINT "arca_parametros_business_id_tipo_key" UNIQUE ("business_id", "tipo");



ALTER TABLE ONLY "public"."arca_parametros"
    ADD CONSTRAINT "arca_parametros_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."blocked_feature_attempts"
    ADD CONSTRAINT "blocked_feature_attempts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."brands"
    ADD CONSTRAINT "brands_business_id_normalized_name_key" UNIQUE ("business_id", "normalized_name");



ALTER TABLE ONLY "public"."brands"
    ADD CONSTRAINT "brands_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."business_finance_entries"
    ADD CONSTRAINT "business_finance_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."business_invitations"
    ADD CONSTRAINT "business_invitations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."business_invitations"
    ADD CONSTRAINT "business_invitations_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."business_settings"
    ADD CONSTRAINT "business_settings_business_id_key" UNIQUE ("business_id");



ALTER TABLE ONLY "public"."business_settings"
    ADD CONSTRAINT "business_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE "public"."businesses"
    ADD CONSTRAINT "businesses_access_source_chk" CHECK ((("access_source" IS NULL) OR ("access_source" = ANY (ARRAY['mercado_pago'::"text", 'trial'::"text", 'manual_grandfathered'::"text", 'admin_override'::"text"])))) NOT VALID;



ALTER TABLE ONLY "public"."businesses"
    ADD CONSTRAINT "businesses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."businesses"
    ADD CONSTRAINT "businesses_wholesale_portal_slug_key" UNIQUE ("wholesale_portal_slug");



ALTER TABLE ONLY "public"."cajas"
    ADD CONSTRAINT "cajas_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cash_registers"
    ADD CONSTRAINT "cash_registers_business_id_date_key" UNIQUE ("business_id", "date");



ALTER TABLE ONLY "public"."cash_registers"
    ADD CONSTRAINT "cash_registers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clic_wholesale_product_settings"
    ADD CONSTRAINT "clic_wholesale_product_settings_business_id_inventory_id_key" UNIQUE ("business_id", "inventory_id");



ALTER TABLE ONLY "public"."clic_wholesale_product_settings"
    ADD CONSTRAINT "clic_wholesale_product_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."comprobante_items"
    ADD CONSTRAINT "comprobante_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."comprobante_payments"
    ADD CONSTRAINT "comprobante_payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."comprobantes"
    ADD CONSTRAINT "comprobantes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_leads"
    ADD CONSTRAINT "contact_leads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."customer_events"
    ADD CONSTRAINT "customer_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."device_inspections"
    ADD CONSTRAINT "device_inspections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."device_models"
    ADD CONSTRAINT "device_models_business_id_brand_id_normalized_name_key" UNIQUE ("business_id", "brand_id", "normalized_name");



ALTER TABLE ONLY "public"."device_models"
    ADD CONSTRAINT "device_models_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."devices"
    ADD CONSTRAINT "devices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dollar_rate_history"
    ADD CONSTRAINT "dollar_rate_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."electronic_invoice_log"
    ADD CONSTRAINT "electronic_invoice_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."exchange_rates"
    ADD CONSTRAINT "exchange_rates_business_currency_unique" UNIQUE ("business_id", "base_currency", "target_currency");



ALTER TABLE ONLY "public"."exchange_rates"
    ADD CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."expense_categories"
    ADD CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."financial_movements"
    ADD CONSTRAINT "financial_movements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inventory"
    ADD CONSTRAINT "inventory_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inventory"
    ADD CONSTRAINT "inventory_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inventory_valuation_history"
    ADD CONSTRAINT "inventory_valuation_history_business_id_fecha_key" UNIQUE ("business_id", "fecha");



ALTER TABLE ONLY "public"."inventory_valuation_history"
    ADD CONSTRAINT "inventory_valuation_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."mp_accounts"
    ADD CONSTRAINT "mp_accounts_business_id_key" UNIQUE ("business_id");



ALTER TABLE ONLY "public"."mp_accounts"
    ADD CONSTRAINT "mp_accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notes"
    ADD CONSTRAINT "notes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."order_checklists"
    ADD CONSTRAINT "order_checklists_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."order_parts"
    ADD CONSTRAINT "order_parts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."order_payments"
    ADD CONSTRAINT "order_payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."owner_withdrawals"
    ADD CONSTRAINT "owner_withdrawals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."parts_used"
    ADD CONSTRAINT "parts_used_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payment_commission_groups"
    ADD CONSTRAINT "payment_commission_groups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payment_commission_options"
    ADD CONSTRAINT "payment_commission_options_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payment_method_buttons"
    ADD CONSTRAINT "payment_method_buttons_business_id_code_key" UNIQUE ("business_id", "code");



ALTER TABLE ONLY "public"."payment_method_buttons"
    ADD CONSTRAINT "payment_method_buttons_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payment_orders"
    ADD CONSTRAINT "payment_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payment_transactions"
    ADD CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payment_webhook_events"
    ADD CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."personal_account_balances"
    ADD CONSTRAINT "personal_account_balances_account_id_currency_key" UNIQUE ("account_id", "currency");



ALTER TABLE ONLY "public"."personal_account_balances"
    ADD CONSTRAINT "personal_account_balances_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."personal_accounts"
    ADD CONSTRAINT "personal_accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."personal_budgets"
    ADD CONSTRAINT "personal_budgets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."personal_budgets"
    ADD CONSTRAINT "personal_budgets_unique" UNIQUE ("user_id", "category_id", "currency", "period");



ALTER TABLE ONLY "public"."personal_card_payments"
    ADD CONSTRAINT "personal_card_payments_no_dup_period" UNIQUE ("user_id", "credit_card_id", "period");



ALTER TABLE ONLY "public"."personal_card_payments"
    ADD CONSTRAINT "personal_card_payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."personal_card_purchases"
    ADD CONSTRAINT "personal_card_purchases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."personal_categories"
    ADD CONSTRAINT "personal_categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."personal_credit_cards"
    ADD CONSTRAINT "personal_credit_cards_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."personal_debt_payments"
    ADD CONSTRAINT "personal_debt_payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."personal_debts"
    ADD CONSTRAINT "personal_debts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."personal_recurring_expense_payments"
    ADD CONSTRAINT "personal_recurring_expense_pa_recurring_expense_id_period_y_key" UNIQUE ("recurring_expense_id", "period_year", "period_month");



ALTER TABLE ONLY "public"."personal_recurring_expense_payments"
    ADD CONSTRAINT "personal_recurring_expense_payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."personal_recurring_expenses"
    ADD CONSTRAINT "personal_recurring_expenses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."personal_savings_goals"
    ADD CONSTRAINT "personal_savings_goals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."personal_transactions"
    ADD CONSTRAINT "personal_transactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_offers"
    ADD CONSTRAINT "product_offers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_variants"
    ADD CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."purchase_items"
    ADD CONSTRAINT "purchase_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."purchases"
    ADD CONSTRAINT "purchases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."recurring_expenses"
    ADD CONSTRAINT "recurring_expenses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sales_points"
    ADD CONSTRAINT "sales_points_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."settings_audit_log"
    ADD CONSTRAINT "settings_audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."status_history"
    ADD CONSTRAINT "status_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscription_admin_actions"
    ADD CONSTRAINT "subscription_admin_actions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscription_checkout_sessions"
    ADD CONSTRAINT "subscription_checkout_sessions_external_reference_key" UNIQUE ("external_reference");



ALTER TABLE ONLY "public"."subscription_checkout_sessions"
    ADD CONSTRAINT "subscription_checkout_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscription_events"
    ADD CONSTRAINT "subscription_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscription_payments"
    ADD CONSTRAINT "subscription_payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscription_payments"
    ADD CONSTRAINT "subscription_payments_provider_payment_id_key" UNIQUE ("provider_payment_id");



ALTER TABLE ONLY "public"."subscription_webhook_logs"
    ADD CONSTRAINT "subscription_webhook_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."supplier_account_movements"
    ADD CONSTRAINT "supplier_account_movements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."supplier_payments"
    ADD CONSTRAINT "supplier_payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."supplier_purchase_items"
    ADD CONSTRAINT "supplier_purchase_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."supplier_purchases"
    ADD CONSTRAINT "supplier_purchases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."suppliers"
    ADD CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."system_admins"
    ADD CONSTRAINT "system_admins_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."system_admins"
    ADD CONSTRAINT "system_admins_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."system_admins"
    ADD CONSTRAINT "system_admins_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."task_comments"
    ADD CONSTRAINT "task_comments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."task_history"
    ADD CONSTRAINT "task_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."task_items"
    ADD CONSTRAINT "task_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."device_inspections"
    ADD CONSTRAINT "unique_order_inspection" UNIQUE ("order_id", "type");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."warranties"
    ADD CONSTRAINT "warranties_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."warranty_events"
    ADD CONSTRAINT "warranty_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."whatsapp_automation_settings"
    ADD CONSTRAINT "whatsapp_automation_settings_business_id_key" UNIQUE ("business_id");



ALTER TABLE ONLY "public"."whatsapp_automation_settings"
    ADD CONSTRAINT "whatsapp_automation_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."whatsapp_connection_credentials"
    ADD CONSTRAINT "whatsapp_connection_credentials_pkey" PRIMARY KEY ("connection_id");



ALTER TABLE ONLY "public"."whatsapp_connection_events"
    ADD CONSTRAINT "whatsapp_connection_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."whatsapp_connections"
    ADD CONSTRAINT "whatsapp_connections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."whatsapp_logs"
    ADD CONSTRAINT "whatsapp_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."whatsapp_message_logs"
    ADD CONSTRAINT "whatsapp_message_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."whatsapp_settings"
    ADD CONSTRAINT "whatsapp_settings_business_id_key" UNIQUE ("business_id");



ALTER TABLE ONLY "public"."whatsapp_settings"
    ADD CONSTRAINT "whatsapp_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."whatsapp_templates"
    ADD CONSTRAINT "whatsapp_templates_business_id_status_key_key" UNIQUE ("business_id", "status_key");



ALTER TABLE ONLY "public"."whatsapp_templates"
    ADD CONSTRAINT "whatsapp_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."wholesale_customers"
    ADD CONSTRAINT "wholesale_customers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."wholesale_order_items"
    ADD CONSTRAINT "wholesale_order_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."wholesale_orders"
    ADD CONSTRAINT "wholesale_orders_pkey" PRIMARY KEY ("id");



CREATE INDEX "comp_business_date_idx" ON "public"."comprobantes" USING "btree" ("business_id", "date" DESC);



CREATE INDEX "cp_business_date_idx" ON "public"."comprobante_payments" USING "btree" ("business_id", "date" DESC);



CREATE INDEX "cp_comprobante_idx" ON "public"."comprobante_payments" USING "btree" ("comprobante_id");



CREATE INDEX "customers_created_by_idx" ON "public"."customers" USING "btree" ("created_by");



CREATE INDEX "exchange_rates_business_id_idx" ON "public"."exchange_rates" USING "btree" ("business_id");



CREATE INDEX "exchange_rates_currency_pair_idx" ON "public"."exchange_rates" USING "btree" ("business_id", "base_currency", "target_currency", "updated_at" DESC);



CREATE INDEX "idx_accounts_balance" ON "public"."accounts" USING "btree" ("business_id", "balance");



CREATE INDEX "idx_accounts_business_type" ON "public"."accounts" USING "btree" ("business_id", "type");



CREATE INDEX "idx_acctmov_account" ON "public"."account_movements" USING "btree" ("account_id", "date" DESC);



CREATE INDEX "idx_acctmov_business" ON "public"."account_movements" USING "btree" ("business_id", "date" DESC);



CREATE INDEX "idx_acctmov_ref" ON "public"."account_movements" USING "btree" ("reference_id") WHERE ("reference_id" IS NOT NULL);



CREATE INDEX "idx_arca_parametros_actualizado" ON "public"."arca_parametros" USING "btree" ("actualizado");



CREATE INDEX "idx_arca_parametros_business_id" ON "public"."arca_parametros" USING "btree" ("business_id");



CREATE INDEX "idx_arca_parametros_tipo" ON "public"."arca_parametros" USING "btree" ("tipo");



CREATE INDEX "idx_bfa_business" ON "public"."blocked_feature_attempts" USING "btree" ("business_id", "created_at" DESC);



CREATE INDEX "idx_bfa_feature" ON "public"."blocked_feature_attempts" USING "btree" ("feature", "created_at" DESC);



CREATE INDEX "idx_bfa_plan" ON "public"."blocked_feature_attempts" USING "btree" ("current_plan", "created_at" DESC);



CREATE INDEX "idx_bfe_biz_date_type" ON "public"."business_finance_entries" USING "btree" ("business_id", "date" DESC, "type");



CREATE INDEX "idx_bfe_business_date" ON "public"."business_finance_entries" USING "btree" ("business_id", "date" DESC);



CREATE INDEX "idx_bfe_business_date_type" ON "public"."business_finance_entries" USING "btree" ("business_id", "date" DESC, "type");



CREATE INDEX "idx_bfe_recurring" ON "public"."business_finance_entries" USING "btree" ("recurring_expense_id") WHERE ("recurring_expense_id" IS NOT NULL);



CREATE INDEX "idx_bfe_sale_type" ON "public"."business_finance_entries" USING "btree" ("business_id", "sale_type") WHERE ("sale_type" IS NOT NULL);



CREATE INDEX "idx_brands_business_id" ON "public"."brands" USING "btree" ("business_id");



CREATE INDEX "idx_brands_normalized_name" ON "public"."brands" USING "btree" ("business_id", "normalized_name");



CREATE INDEX "idx_business_invitations_business_id" ON "public"."business_invitations" USING "btree" ("business_id");



CREATE INDEX "idx_business_invitations_email" ON "public"."business_invitations" USING "btree" ("email");



CREATE INDEX "idx_business_invitations_status" ON "public"."business_invitations" USING "btree" ("status");



CREATE INDEX "idx_business_settings_business_id" ON "public"."business_settings" USING "btree" ("business_id");



CREATE INDEX "idx_cajas_biz_status" ON "public"."cajas" USING "btree" ("business_id", "status", "opened_at" DESC);



CREATE INDEX "idx_cajas_business_opened" ON "public"."cajas" USING "btree" ("business_id", "opened_at" DESC);



CREATE INDEX "idx_cajas_business_status" ON "public"."cajas" USING "btree" ("business_id", "status");



CREATE INDEX "idx_ce_business" ON "public"."customer_events" USING "btree" ("business_id");



CREATE INDEX "idx_ce_customer" ON "public"."customer_events" USING "btree" ("customer_id");



CREATE INDEX "idx_ci_business_recent" ON "public"."comprobante_items" USING "btree" ("business_id", "created_at" DESC) WHERE ("inventory_id" IS NOT NULL);



CREATE INDEX "idx_ci_stock_pending" ON "public"."comprobante_items" USING "btree" ("business_id", "inventory_id", "stock_processed") WHERE ("inventory_id" IS NOT NULL);



CREATE INDEX "idx_comp_business_status" ON "public"."comprobantes" USING "btree" ("business_id", "status");



CREATE INDEX "idx_comp_customer_date" ON "public"."comprobantes" USING "btree" ("business_id", "customer_id", "created_at" DESC) WHERE ("customer_id" IS NOT NULL);



CREATE INDEX "idx_comprobante_items_business_id" ON "public"."comprobante_items" USING "btree" ("business_id");



CREATE INDEX "idx_comprobante_items_comprobante_id" ON "public"."comprobante_items" USING "btree" ("comprobante_id");



CREATE INDEX "idx_comprobante_items_inventory" ON "public"."comprobante_items" USING "btree" ("inventory_id") WHERE ("inventory_id" IS NOT NULL);



CREATE INDEX "idx_comprobante_items_inventory_id" ON "public"."comprobante_items" USING "btree" ("inventory_id");



CREATE INDEX "idx_comprobantes_business_created" ON "public"."comprobantes" USING "btree" ("business_id", "created_at" DESC);



CREATE INDEX "idx_comprobantes_business_id" ON "public"."comprobantes" USING "btree" ("business_id");



CREATE INDEX "idx_comprobantes_cae" ON "public"."comprobantes" USING "btree" ("cae");



CREATE INDEX "idx_comprobantes_customer_id" ON "public"."comprobantes" USING "btree" ("customer_id");



CREATE INDEX "idx_comprobantes_estado" ON "public"."comprobantes" USING "btree" ("estado");



CREATE INDEX "idx_comprobantes_estado_fiscal" ON "public"."comprobantes" USING "btree" ("estado_fiscal");



CREATE INDEX "idx_comprobantes_fecha" ON "public"."comprobantes" USING "btree" ("fecha");



CREATE INDEX "idx_comprobantes_fecha_emision_fiscal" ON "public"."comprobantes" USING "btree" ("fecha_emision_fiscal");



CREATE INDEX "idx_comprobantes_order_id" ON "public"."comprobantes" USING "btree" ("order_id");



CREATE INDEX "idx_comprobantes_original_id" ON "public"."comprobantes" USING "btree" ("comprobante_original_id") WHERE ("comprobante_original_id" IS NOT NULL);



CREATE INDEX "idx_comprobantes_punto_venta" ON "public"."comprobantes" USING "btree" ("punto_venta");



CREATE INDEX "idx_comprobantes_tipo" ON "public"."comprobantes" USING "btree" ("tipo");



CREATE INDEX "idx_contact_leads_email" ON "public"."contact_leads" USING "btree" ("email");



CREATE INDEX "idx_contact_leads_status" ON "public"."contact_leads" USING "btree" ("status");



CREATE INDEX "idx_cp_biz_date" ON "public"."comprobante_payments" USING "btree" ("business_id", "date" DESC);



CREATE INDEX "idx_customers_business_created" ON "public"."customers" USING "btree" ("business_id", "created_at" DESC);



CREATE INDEX "idx_customers_business_id" ON "public"."customers" USING "btree" ("business_id");



CREATE INDEX "idx_customers_business_name" ON "public"."customers" USING "btree" ("business_id", "name");



CREATE INDEX "idx_customers_email" ON "public"."customers" USING "btree" ("email");



CREATE INDEX "idx_customers_name_trgm" ON "public"."customers" USING "gin" ("name" "public"."gin_trgm_ops");



CREATE INDEX "idx_customers_phone" ON "public"."customers" USING "btree" ("phone");



CREATE INDEX "idx_customers_type" ON "public"."customers" USING "btree" ("business_id", "customer_type");



CREATE INDEX "idx_customers_updated" ON "public"."customers" USING "btree" ("business_id", "updated_at" DESC);



CREATE INDEX "idx_cwps_business" ON "public"."clic_wholesale_product_settings" USING "btree" ("business_id");



CREATE INDEX "idx_cwps_inventory" ON "public"."clic_wholesale_product_settings" USING "btree" ("inventory_id");



CREATE INDEX "idx_cwps_visible" ON "public"."clic_wholesale_product_settings" USING "btree" ("business_id", "is_visible", "display_order");



CREATE INDEX "idx_device_inspections_business_id" ON "public"."device_inspections" USING "btree" ("business_id");



CREATE INDEX "idx_device_models_brand_id" ON "public"."device_models" USING "btree" ("brand_id");



CREATE INDEX "idx_device_models_business" ON "public"."device_models" USING "btree" ("business_id");



CREATE INDEX "idx_devices_business_id" ON "public"."devices" USING "btree" ("business_id");



CREATE INDEX "idx_devices_customer_id" ON "public"."devices" USING "btree" ("customer_id");



CREATE INDEX "idx_documents_business_id" ON "public"."documents" USING "btree" ("business_id");



CREATE INDEX "idx_documents_order_id" ON "public"."documents" USING "btree" ("order_id");



CREATE INDEX "idx_drh_business_fetched" ON "public"."dollar_rate_history" USING "btree" ("business_id", "fetched_at" DESC);



CREATE INDEX "idx_drh_source" ON "public"."dollar_rate_history" USING "btree" ("source");



CREATE INDEX "idx_ec_business" ON "public"."expense_categories" USING "btree" ("business_id", "sort_order");



CREATE INDEX "idx_electronic_invoice_log_business_id" ON "public"."electronic_invoice_log" USING "btree" ("business_id");



CREATE INDEX "idx_electronic_invoice_log_comprobante_id" ON "public"."electronic_invoice_log" USING "btree" ("comprobante_id");



CREATE INDEX "idx_electronic_invoice_log_created_at" ON "public"."electronic_invoice_log" USING "btree" ("created_at");



CREATE INDEX "idx_exp_category" ON "public"."expenses" USING "btree" ("business_id", "category");



CREATE INDEX "idx_expenses_business_date" ON "public"."expenses" USING "btree" ("business_id", "date" DESC);



CREATE INDEX "idx_expenses_business_id" ON "public"."expenses" USING "btree" ("business_id");



CREATE INDEX "idx_expenses_proveedor" ON "public"."expenses" USING "btree" ("business_id", "proveedor_id") WHERE ("proveedor_id" IS NOT NULL);



CREATE INDEX "idx_expenses_supplier_purchase_id" ON "public"."expenses" USING "btree" ("supplier_purchase_id") WHERE ("supplier_purchase_id" IS NOT NULL);



CREATE INDEX "idx_expenses_tipo" ON "public"."expenses" USING "btree" ("business_id", "tipo");



CREATE INDEX "idx_financial_movements_comprobante" ON "public"."financial_movements" USING "btree" ("comprobante_id") WHERE ("comprobante_id" IS NOT NULL);



CREATE INDEX "idx_financial_movements_payment_transaction" ON "public"."financial_movements" USING "btree" ("payment_transaction_id") WHERE ("payment_transaction_id" IS NOT NULL);



CREATE INDEX "idx_fm_biz_caja" ON "public"."financial_movements" USING "btree" ("business_id", "caja_id", "created_at" DESC);



CREATE INDEX "idx_fm_business_date" ON "public"."financial_movements" USING "btree" ("business_id", "date" DESC);



CREATE INDEX "idx_fm_caja_id" ON "public"."financial_movements" USING "btree" ("caja_id") WHERE ("caja_id" IS NOT NULL);



CREATE INDEX "idx_fm_source" ON "public"."financial_movements" USING "btree" ("business_id", "source", "created_at" DESC);



CREATE INDEX "idx_inv_mov_item_biz" ON "public"."inventory_movements" USING "btree" ("inventory_item_id", "business_id", "created_at" DESC);



CREATE INDEX "idx_inv_mov_product" ON "public"."inventory_movements" USING "btree" ("product_id") WHERE ("product_id" IS NOT NULL);



CREATE INDEX "idx_inv_mov_ref" ON "public"."inventory_movements" USING "btree" ("reference_type", "reference_id");



CREATE INDEX "idx_inv_mov_variant" ON "public"."inventory_movements" USING "btree" ("variant_id") WHERE ("variant_id" IS NOT NULL);



CREATE INDEX "idx_inv_val_hist_business_fecha" ON "public"."inventory_valuation_history" USING "btree" ("business_id", "fecha");



CREATE INDEX "idx_inventory_active" ON "public"."inventory" USING "btree" ("business_id", "is_active", "stock_quantity");



CREATE INDEX "idx_inventory_barcode" ON "public"."inventory" USING "btree" ("business_id", "barcode") WHERE ("barcode" IS NOT NULL);



CREATE INDEX "idx_inventory_business_active" ON "public"."inventory" USING "btree" ("business_id", "is_active");



CREATE INDEX "idx_inventory_business_id" ON "public"."inventory" USING "btree" ("business_id");



CREATE INDEX "idx_inventory_business_name" ON "public"."inventory" USING "btree" ("business_id", "name");



CREATE INDEX "idx_inventory_category" ON "public"."inventory" USING "btree" ("business_id", "category");



CREATE INDEX "idx_inventory_code" ON "public"."inventory" USING "btree" ("business_id", "code");



CREATE INDEX "idx_inventory_linked_to_dolar" ON "public"."inventory" USING "btree" ("linked_to_dolar") WHERE ("linked_to_dolar" = true);



CREATE INDEX "idx_inventory_mayorista" ON "public"."inventory" USING "btree" ("business_id", "precio_mayorista") WHERE ("is_active" = true);



CREATE INDEX "idx_inventory_movements_business_id" ON "public"."inventory_movements" USING "btree" ("business_id");



CREATE INDEX "idx_inventory_movements_date" ON "public"."inventory_movements" USING "btree" ("created_at");



CREATE INDEX "idx_inventory_movements_item_id" ON "public"."inventory_movements" USING "btree" ("inventory_item_id");



CREATE INDEX "idx_inventory_movements_reference" ON "public"."inventory_movements" USING "btree" ("reference_type", "reference_id");



CREATE INDEX "idx_inventory_movements_type" ON "public"."inventory_movements" USING "btree" ("movement_type");



CREATE INDEX "idx_inventory_name_trgm" ON "public"."inventory" USING "gin" ("name" "public"."gin_trgm_ops");



CREATE INDEX "idx_inventory_parent_id" ON "public"."inventory" USING "btree" ("parent_id") WHERE ("parent_id" IS NOT NULL);



CREATE INDEX "idx_inventory_portal_catalog" ON "public"."inventory" USING "btree" ("business_id", "visible_in_wholesale", "portal_sort_order") WHERE ("is_active" = true);



CREATE INDEX "idx_inventory_stock_low" ON "public"."inventory" USING "btree" ("business_id", "stock_quantity") WHERE ("stock_quantity" <= "min_stock");



CREATE INDEX "idx_notes_business_id" ON "public"."notes" USING "btree" ("business_id");



CREATE INDEX "idx_notes_order_id" ON "public"."notes" USING "btree" ("order_id");



CREATE INDEX "idx_notifications_business_id" ON "public"."notifications" USING "btree" ("business_id");



CREATE INDEX "idx_offers_business" ON "public"."product_offers" USING "btree" ("business_id");



CREATE INDEX "idx_offers_dates" ON "public"."product_offers" USING "btree" ("start_date", "end_date");



CREATE INDEX "idx_offers_product" ON "public"."product_offers" USING "btree" ("product_id");



CREATE INDEX "idx_order_checklists_business_id" ON "public"."order_checklists" USING "btree" ("business_id");



CREATE INDEX "idx_order_checklists_order_id" ON "public"."order_checklists" USING "btree" ("order_id");



CREATE INDEX "idx_order_items_business_id" ON "public"."order_items" USING "btree" ("business_id");



CREATE INDEX "idx_order_items_order_id" ON "public"."order_items" USING "btree" ("order_id");



CREATE INDEX "idx_order_items_product_id" ON "public"."order_items" USING "btree" ("product_id");



CREATE INDEX "idx_order_parts_added_at" ON "public"."order_parts" USING "btree" ("business_id", "added_at" DESC);



CREATE INDEX "idx_order_parts_biz_status" ON "public"."order_parts" USING "btree" ("business_id", "status", "added_at" DESC);



CREATE INDEX "idx_order_parts_business_id" ON "public"."order_parts" USING "btree" ("business_id");



CREATE INDEX "idx_order_parts_order_status" ON "public"."order_parts" USING "btree" ("order_id", "status");



CREATE INDEX "idx_order_payments_business_id" ON "public"."order_payments" USING "btree" ("business_id");



CREATE INDEX "idx_order_payments_order_date" ON "public"."order_payments" USING "btree" ("order_id", "payment_date" DESC);



CREATE INDEX "idx_orders_business_created" ON "public"."orders" USING "btree" ("business_id", "created_at" DESC);



CREATE INDEX "idx_orders_business_id" ON "public"."orders" USING "btree" ("business_id");



CREATE INDEX "idx_orders_business_status" ON "public"."orders" USING "btree" ("business_id", "status");



CREATE INDEX "idx_orders_comprobante_id" ON "public"."orders" USING "btree" ("comprobante_id");



CREATE INDEX "idx_orders_created_at" ON "public"."orders" USING "btree" ("created_at");



CREATE INDEX "idx_orders_customer_id" ON "public"."orders" USING "btree" ("customer_id");



CREATE INDEX "idx_orders_device_id" ON "public"."orders" USING "btree" ("device_id");



CREATE INDEX "idx_orders_status" ON "public"."orders" USING "btree" ("status");



CREATE INDEX "idx_orders_technician_id" ON "public"."orders" USING "btree" ("technician_id");



CREATE INDEX "idx_orders_updated" ON "public"."orders" USING "btree" ("business_id", "updated_at" DESC);



CREATE INDEX "idx_owner_withdrawals_business" ON "public"."owner_withdrawals" USING "btree" ("business_id");



CREATE INDEX "idx_owner_withdrawals_user" ON "public"."owner_withdrawals" USING "btree" ("user_id");



CREATE INDEX "idx_parts_used_business_id" ON "public"."parts_used" USING "btree" ("business_id");



CREATE INDEX "idx_parts_used_order_id" ON "public"."parts_used" USING "btree" ("order_id");



CREATE INDEX "idx_payment_orders_payment_button" ON "public"."payment_orders" USING "btree" ("payment_button_id") WHERE ("payment_button_id" IS NOT NULL);



CREATE INDEX "idx_payment_transactions_payment_button" ON "public"."payment_transactions" USING "btree" ("payment_button_id") WHERE ("payment_button_id" IS NOT NULL);



CREATE INDEX "idx_payment_transactions_payment_order" ON "public"."payment_transactions" USING "btree" ("payment_order_id") WHERE ("payment_order_id" IS NOT NULL);



CREATE INDEX "idx_payments_business" ON "public"."payments" USING "btree" ("business_id");



CREATE UNIQUE INDEX "idx_payments_external_id" ON "public"."payments" USING "btree" ("provider", "external_payment_id") WHERE ("external_payment_id" IS NOT NULL);



CREATE INDEX "idx_payments_status" ON "public"."payments" USING "btree" ("status");



CREATE INDEX "idx_pcg_business" ON "public"."payment_commission_groups" USING "btree" ("business_id", "sort_order");



CREATE INDEX "idx_pco_business" ON "public"."payment_commission_options" USING "btree" ("business_id");



CREATE INDEX "idx_pco_group" ON "public"."payment_commission_options" USING "btree" ("group_id", "sort_order");



CREATE INDEX "idx_personal_accounts_user" ON "public"."personal_accounts" USING "btree" ("user_id");



CREATE INDEX "idx_personal_budgets_category" ON "public"."personal_budgets" USING "btree" ("category_id");



CREATE INDEX "idx_personal_budgets_user_period" ON "public"."personal_budgets" USING "btree" ("user_id", "period");



CREATE INDEX "idx_personal_budgets_user_status" ON "public"."personal_budgets" USING "btree" ("user_id", "status");



CREATE INDEX "idx_personal_card_purchases_card" ON "public"."personal_card_purchases" USING "btree" ("credit_card_id");



CREATE INDEX "idx_personal_card_purchases_user" ON "public"."personal_card_purchases" USING "btree" ("user_id");



CREATE INDEX "idx_personal_categories_user" ON "public"."personal_categories" USING "btree" ("user_id");



CREATE INDEX "idx_personal_credit_cards_user" ON "public"."personal_credit_cards" USING "btree" ("user_id");



CREATE INDEX "idx_personal_debt_payments_debt_id" ON "public"."personal_debt_payments" USING "btree" ("debt_id");



CREATE INDEX "idx_personal_debt_payments_user_id" ON "public"."personal_debt_payments" USING "btree" ("user_id");



CREATE INDEX "idx_personal_debts_next_due" ON "public"."personal_debts" USING "btree" ("next_due_date") WHERE ("next_due_date" IS NOT NULL);



CREATE INDEX "idx_personal_debts_user" ON "public"."personal_debts" USING "btree" ("user_id");



CREATE INDEX "idx_personal_debts_user_status" ON "public"."personal_debts" USING "btree" ("user_id", "status");



CREATE INDEX "idx_personal_debts_user_type" ON "public"."personal_debts" USING "btree" ("user_id", "type");



CREATE INDEX "idx_personal_savings_goals_user" ON "public"."personal_savings_goals" USING "btree" ("user_id");



CREATE INDEX "idx_personal_transactions_acct" ON "public"."personal_transactions" USING "btree" ("account_id");



CREATE INDEX "idx_personal_transactions_date" ON "public"."personal_transactions" USING "btree" ("date" DESC);



CREATE INDEX "idx_personal_transactions_user" ON "public"."personal_transactions" USING "btree" ("user_id");



CREATE INDEX "idx_product_variants_business" ON "public"."product_variants" USING "btree" ("business_id");



CREATE UNIQUE INDEX "idx_product_variants_default" ON "public"."product_variants" USING "btree" ("product_id") WHERE ("is_default" = true);



CREATE INDEX "idx_product_variants_inventory" ON "public"."product_variants" USING "btree" ("inventory_item_id") WHERE ("inventory_item_id" IS NOT NULL);



CREATE INDEX "idx_product_variants_product" ON "public"."product_variants" USING "btree" ("product_id");



CREATE INDEX "idx_profiles_business_id" ON "public"."profiles" USING "btree" ("business_id");



CREATE INDEX "idx_purchase_items_business_id" ON "public"."purchase_items" USING "btree" ("business_id");



CREATE INDEX "idx_purchase_items_inventory_item_id" ON "public"."purchase_items" USING "btree" ("inventory_item_id");



CREATE INDEX "idx_purchase_items_purchase_id" ON "public"."purchase_items" USING "btree" ("purchase_id");



CREATE INDEX "idx_purchases_business_id" ON "public"."purchases" USING "btree" ("business_id");



CREATE INDEX "idx_purchases_date" ON "public"."purchases" USING "btree" ("purchase_date");



CREATE INDEX "idx_purchases_status" ON "public"."purchases" USING "btree" ("status");



CREATE INDEX "idx_purchases_supplier_id" ON "public"."purchases" USING "btree" ("supplier_id");



CREATE INDEX "idx_re_business" ON "public"."recurring_expenses" USING "btree" ("business_id", "is_active");



CREATE INDEX "idx_saa_actor" ON "public"."subscription_admin_actions" USING "btree" ("actor_user_id");



CREATE INDEX "idx_saa_business" ON "public"."subscription_admin_actions" USING "btree" ("business_id");



CREATE INDEX "idx_sam_supplier" ON "public"."supplier_account_movements" USING "btree" ("supplier_id", "business_id");



CREATE INDEX "idx_sam_supplier_balance_lookup" ON "public"."supplier_account_movements" USING "btree" ("supplier_id", "business_id", "created_at" DESC);



CREATE INDEX "idx_scs_business" ON "public"."subscription_checkout_sessions" USING "btree" ("business_id", "created_at" DESC);



CREATE INDEX "idx_scs_ext_ref" ON "public"."subscription_checkout_sessions" USING "btree" ("external_reference") WHERE ("external_reference" IS NOT NULL);



CREATE INDEX "idx_scs_external" ON "public"."subscription_checkout_sessions" USING "btree" ("external_reference");



CREATE UNIQUE INDEX "idx_scs_pending_unique" ON "public"."subscription_checkout_sessions" USING "btree" ("business_id", "plan_id", "billing_cycle") WHERE ("status" = 'pending'::"text");



CREATE INDEX "idx_scs_status" ON "public"."subscription_checkout_sessions" USING "btree" ("status");



CREATE INDEX "idx_settings_audit_log_business_id" ON "public"."settings_audit_log" USING "btree" ("business_id");



CREATE INDEX "idx_settings_audit_log_created_at" ON "public"."settings_audit_log" USING "btree" ("created_at");



CREATE INDEX "idx_sp_business" ON "public"."subscription_payments" USING "btree" ("business_id", "created_at" DESC);



CREATE INDEX "idx_sp_date" ON "public"."supplier_purchases" USING "btree" ("purchase_date" DESC);



CREATE INDEX "idx_sp_supplier" ON "public"."supplier_purchases" USING "btree" ("supplier_id", "business_id");



CREATE INDEX "idx_spay_supplier" ON "public"."supplier_payments" USING "btree" ("supplier_id", "business_id");



CREATE INDEX "idx_spi_inventory" ON "public"."supplier_purchase_items" USING "btree" ("inventory_id");



CREATE INDEX "idx_spi_purchase" ON "public"."supplier_purchase_items" USING "btree" ("purchase_id");



CREATE INDEX "idx_status_history_business_id" ON "public"."status_history" USING "btree" ("business_id");



CREATE INDEX "idx_status_history_order_id" ON "public"."status_history" USING "btree" ("order_id");



CREATE INDEX "idx_sub_events_business" ON "public"."subscription_events" USING "btree" ("business_id");



CREATE INDEX "idx_sub_events_external" ON "public"."subscription_events" USING "btree" ("external_id");



CREATE INDEX "idx_sub_events_processed" ON "public"."subscription_events" USING "btree" ("processed");



CREATE INDEX "idx_supplier_acct_mov_payment" ON "public"."supplier_account_movements" USING "btree" ("payment_id") WHERE ("payment_id" IS NOT NULL);



CREATE INDEX "idx_supplier_acct_mov_purchase" ON "public"."supplier_account_movements" USING "btree" ("purchase_id") WHERE ("purchase_id" IS NOT NULL);



CREATE INDEX "idx_supplier_payments_purchase" ON "public"."supplier_payments" USING "btree" ("purchase_id") WHERE ("purchase_id" IS NOT NULL);



CREATE INDEX "idx_supplier_purchase_items_supplier" ON "public"."supplier_purchase_items" USING "btree" ("supplier_id");



CREATE INDEX "idx_supplier_purchases_created_by" ON "public"."supplier_purchases" USING "btree" ("created_by");



CREATE INDEX "idx_suppliers_business_id" ON "public"."suppliers" USING "btree" ("business_id");



CREATE INDEX "idx_swl_created" ON "public"."subscription_webhook_logs" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_task_comments_task" ON "public"."task_comments" USING "btree" ("task_id");



CREATE INDEX "idx_task_history_task" ON "public"."task_history" USING "btree" ("task_id");



CREATE INDEX "idx_task_items_task" ON "public"."task_items" USING "btree" ("task_id");



CREATE INDEX "idx_tasks_business_id" ON "public"."tasks" USING "btree" ("business_id");



CREATE INDEX "idx_tasks_due_date" ON "public"."tasks" USING "btree" ("due_date");



CREATE INDEX "idx_tasks_status" ON "public"."tasks" USING "btree" ("status");



CREATE INDEX "idx_tasks_user_id" ON "public"."tasks" USING "btree" ("user_id");



CREATE INDEX "idx_warranties_comprobante_id" ON "public"."warranties" USING "btree" ("comprobante_id") WHERE ("comprobante_id" IS NOT NULL);



CREATE INDEX "idx_warranties_customer_id" ON "public"."warranties" USING "btree" ("customer_id") WHERE ("customer_id" IS NOT NULL);



CREATE INDEX "idx_warranties_order_id" ON "public"."warranties" USING "btree" ("order_id") WHERE ("order_id" IS NOT NULL);



CREATE INDEX "idx_warranty_events_warranty_id" ON "public"."warranty_events" USING "btree" ("warranty_id");



CREATE INDEX "idx_wc_auth" ON "public"."wholesale_customers" USING "btree" ("auth_user_id");



CREATE INDEX "idx_wc_business" ON "public"."wholesale_customers" USING "btree" ("business_id");



CREATE UNIQUE INDEX "idx_wc_email" ON "public"."wholesale_customers" USING "btree" ("email", "business_id");



CREATE INDEX "idx_wce_business_id" ON "public"."whatsapp_connection_events" USING "btree" ("business_id");



CREATE INDEX "idx_wce_connection_id" ON "public"."whatsapp_connection_events" USING "btree" ("connection_id");



CREATE INDEX "idx_wce_created_at" ON "public"."whatsapp_connection_events" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_whatsapp_automation_settings_business_id" ON "public"."whatsapp_automation_settings" USING "btree" ("business_id");



CREATE INDEX "idx_whatsapp_connections_business_id" ON "public"."whatsapp_connections" USING "btree" ("business_id");



CREATE INDEX "idx_whatsapp_connections_status" ON "public"."whatsapp_connections" USING "btree" ("business_id", "status");



CREATE INDEX "idx_whatsapp_logs_business_id" ON "public"."whatsapp_logs" USING "btree" ("business_id");



CREATE INDEX "idx_whatsapp_logs_order_id" ON "public"."whatsapp_logs" USING "btree" ("order_id");



CREATE INDEX "idx_whatsapp_message_logs_business_id" ON "public"."whatsapp_message_logs" USING "btree" ("business_id");



CREATE INDEX "idx_whatsapp_message_logs_connection_id" ON "public"."whatsapp_message_logs" USING "btree" ("connection_id");



CREATE INDEX "idx_whatsapp_message_logs_customer_phone" ON "public"."whatsapp_message_logs" USING "btree" ("business_id", "customer_phone");



CREATE INDEX "idx_whatsapp_message_logs_status" ON "public"."whatsapp_message_logs" USING "btree" ("business_id", "status");



CREATE INDEX "idx_whatsapp_templates_business" ON "public"."whatsapp_templates" USING "btree" ("business_id");



CREATE INDEX "idx_wo_business" ON "public"."wholesale_orders" USING "btree" ("business_id");



CREATE INDEX "idx_wo_customer" ON "public"."wholesale_orders" USING "btree" ("customer_id");



CREATE INDEX "idx_woi_order" ON "public"."wholesale_order_items" USING "btree" ("order_id");



CREATE INDEX "idx_woi_stock_pending" ON "public"."wholesale_order_items" USING "btree" ("business_id", "inventory_item_id", "stock_processed") WHERE ("inventory_item_id" IS NOT NULL);



CREATE INDEX "inventory_auto_update_price_idx" ON "public"."inventory" USING "btree" ("auto_update_price") WHERE ("auto_update_price" = true);



CREATE INDEX "inventory_base_currency_idx" ON "public"."inventory" USING "btree" ("base_currency");



CREATE INDEX "mp_accounts_business_idx" ON "public"."mp_accounts" USING "btree" ("business_id");



CREATE INDEX "pmb_business_active_idx" ON "public"."payment_method_buttons" USING "btree" ("business_id", "is_active", "sort_order");



CREATE INDEX "po_business_status_idx" ON "public"."payment_orders" USING "btree" ("business_id", "status", "created_at" DESC);



CREATE INDEX "po_comprobante_idx" ON "public"."payment_orders" USING "btree" ("comprobante_id");



CREATE INDEX "po_external_ref_idx" ON "public"."payment_orders" USING "btree" ("external_reference");



CREATE UNIQUE INDEX "profiles_user_id_unique_idx" ON "public"."profiles" USING "btree" ("user_id") WHERE ("user_id" IS NOT NULL);



CREATE INDEX "pt_business_status_idx" ON "public"."payment_transactions" USING "btree" ("business_id", "status", "created_at" DESC);



CREATE INDEX "pt_comprobante_idx" ON "public"."payment_transactions" USING "btree" ("comprobante_id");



CREATE INDEX "pt_external_ref_idx" ON "public"."payment_transactions" USING "btree" ("external_reference");



CREATE INDEX "pt_provider_payment_idx" ON "public"."payment_transactions" USING "btree" ("provider_payment_id");



CREATE UNIQUE INDEX "pwe_idempotency_idx" ON "public"."payment_webhook_events" USING "btree" ("provider", "resource_id", "action") WHERE ("processed" = true);



CREATE INDEX "pwe_unprocessed_idx" ON "public"."payment_webhook_events" USING "btree" ("processed", "created_at") WHERE ("processed" = false);



CREATE UNIQUE INDEX "uniq_bfe_comprobante_reversal" ON "public"."business_finance_entries" USING "btree" ("reference_comprobante_id") WHERE (("amount_ars" < (0)::numeric) AND ("source" = 'comprobante'::"text") AND ("reference_comprobante_id" IS NOT NULL));



CREATE UNIQUE INDEX "uniq_supplier_am_payment" ON "public"."supplier_account_movements" USING "btree" ("payment_id") WHERE ("payment_id" IS NOT NULL);



CREATE UNIQUE INDEX "uniq_supplier_am_purchase_type" ON "public"."supplier_account_movements" USING "btree" ("business_id", "supplier_id", "purchase_id", "type") WHERE (("purchase_id" IS NOT NULL) AND ("type" = 'purchase'::"text"));



CREATE UNIQUE INDEX "uq_businesses_mp_preapproval_id" ON "public"."businesses" USING "btree" ("mp_preapproval_id") WHERE ("mp_preapproval_id" IS NOT NULL);



CREATE UNIQUE INDEX "uq_subscription_events_dedupe" ON "public"."subscription_events" USING "btree" ("provider", "event_type", "external_id") WHERE ("external_id" IS NOT NULL);



CREATE UNIQUE INDEX "uq_whatsapp_connections_one_active_per_business" ON "public"."whatsapp_connections" USING "btree" ("business_id") WHERE ("status" = 'connected'::"text");



CREATE INDEX "warranties_business_customer_idx" ON "public"."warranties" USING "btree" ("business_id", "customer_name");



CREATE INDEX "warranties_business_date_idx" ON "public"."warranties" USING "btree" ("business_id", "issue_date" DESC);



CREATE INDEX "warranties_business_id_idx" ON "public"."warranties" USING "btree" ("business_id");



CREATE INDEX "warranties_business_imei_idx" ON "public"."warranties" USING "btree" ("business_id", "imei");



CREATE UNIQUE INDEX "warranties_business_number_active_uidx" ON "public"."warranties" USING "btree" ("business_id", "number") WHERE "is_active";



CREATE INDEX "warranties_business_supplier_idx" ON "public"."warranties" USING "btree" ("business_id", "supplier_id");



CREATE OR REPLACE VIEW "public"."v_subscription_overview" WITH ("security_invoker"='true') AS
 SELECT "b"."id" AS "business_id",
    "b"."name" AS "business_name",
    "b"."subscription_status",
    "b"."subscription_plan",
    "b"."mp_preapproval_id",
    "b"."mp_payer_email",
    "b"."current_period_end",
    "b"."grace_until",
    "b"."last_payment_status",
    "b"."last_webhook_at",
    "b"."trial_ends_at",
    "b"."created_at",
    "count"("p"."id") AS "total_payments",
    "max"("p"."paid_at") AS "last_paid_at",
    COALESCE("sum"(
        CASE
            WHEN ("p"."status" = 'approved'::"text") THEN "p"."amount"
            ELSE (0)::numeric
        END), (0)::numeric) AS "total_revenue"
   FROM ("public"."businesses" "b"
     LEFT JOIN "public"."payments" "p" ON (("p"."business_id" = "b"."id")))
  GROUP BY "b"."id";



CREATE OR REPLACE TRIGGER "mp_accounts_updated_at" BEFORE UPDATE ON "public"."mp_accounts" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "pmb_updated_at" BEFORE UPDATE ON "public"."payment_method_buttons" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "po_updated_at" BEFORE UPDATE ON "public"."payment_orders" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "pt_updated_at" BEFORE UPDATE ON "public"."payment_transactions" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "set_exchange_rate_on_product_save_trigger" BEFORE INSERT OR UPDATE ON "public"."inventory" FOR EACH ROW EXECUTE FUNCTION "public"."set_exchange_rate_on_product_save"();



CREATE OR REPLACE TRIGGER "set_updated_at_owner_withdrawals" BEFORE UPDATE ON "public"."owner_withdrawals" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "set_updated_at_personal_accounts" BEFORE UPDATE ON "public"."personal_accounts" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "set_updated_at_personal_card_purchases" BEFORE UPDATE ON "public"."personal_card_purchases" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "set_updated_at_personal_categories" BEFORE UPDATE ON "public"."personal_categories" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "set_updated_at_personal_credit_cards" BEFORE UPDATE ON "public"."personal_credit_cards" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "set_updated_at_personal_debts" BEFORE UPDATE ON "public"."personal_debts" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "set_updated_at_personal_savings_goals" BEFORE UPDATE ON "public"."personal_savings_goals" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "set_updated_at_personal_transactions" BEFORE UPDATE ON "public"."personal_transactions" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "trg_adjust_stock_on_order_item" BEFORE INSERT OR DELETE OR UPDATE ON "public"."order_items" FOR EACH ROW EXECUTE FUNCTION "public"."adjust_stock_on_order_item"();



CREATE OR REPLACE TRIGGER "trg_brands_normalized_name" BEFORE INSERT OR UPDATE OF "name" ON "public"."brands" FOR EACH ROW EXECUTE FUNCTION "public"."set_brands_normalized_name"();



CREATE OR REPLACE TRIGGER "trg_device_models_normalized_name" BEFORE INSERT OR UPDATE OF "name" ON "public"."device_models" FOR EACH ROW EXECUTE FUNCTION "public"."set_device_models_normalized_name"();



CREATE OR REPLACE TRIGGER "trg_protect_subscription_columns" BEFORE UPDATE ON "public"."businesses" FOR EACH ROW EXECUTE FUNCTION "public"."protect_subscription_columns"();



CREATE OR REPLACE TRIGGER "trg_recalcular_totales_comprobante_items" AFTER INSERT OR DELETE OR UPDATE ON "public"."comprobante_items" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_recalcular_totales"();



CREATE OR REPLACE TRIGGER "trg_recalculate_order_total" AFTER INSERT OR DELETE OR UPDATE ON "public"."order_items" FOR EACH ROW EXECUTE FUNCTION "public"."recalculate_order_total"();



CREATE OR REPLACE TRIGGER "trg_sync_inventory_stock" BEFORE UPDATE OF "stock_quantity" ON "public"."inventory" FOR EACH ROW EXECUTE FUNCTION "public"."sync_inventory_stock_alias"();



CREATE OR REPLACE TRIGGER "trg_wce_block_mutation" BEFORE DELETE OR UPDATE ON "public"."whatsapp_connection_events" FOR EACH ROW EXECUTE FUNCTION "public"."whatsapp_connection_events_block_mutation"();



CREATE OR REPLACE TRIGGER "trg_whatsapp_automation_settings_updated_at" BEFORE UPDATE ON "public"."whatsapp_automation_settings" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "trg_whatsapp_connections_updated_at" BEFORE UPDATE ON "public"."whatsapp_connections" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "trg_whatsapp_credential_purge_vault" BEFORE DELETE ON "public"."whatsapp_connection_credentials" FOR EACH ROW EXECUTE FUNCTION "public"."whatsapp_credential_purge_vault"();



CREATE OR REPLACE TRIGGER "trg_whatsapp_settings_updated_at" BEFORE UPDATE ON "public"."whatsapp_settings" FOR EACH ROW EXECUTE FUNCTION "public"."update_whatsapp_updated_at"();



CREATE OR REPLACE TRIGGER "trg_whatsapp_templates_updated_at" BEFORE UPDATE ON "public"."whatsapp_templates" FOR EACH ROW EXECUTE FUNCTION "public"."update_whatsapp_updated_at"();



CREATE OR REPLACE TRIGGER "trig_account_movement_balance" BEFORE INSERT ON "public"."account_movements" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_account_movement_balance"();



CREATE OR REPLACE TRIGGER "trig_comprobante_payment_finance" AFTER INSERT ON "public"."comprobante_payments" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_comprobante_payment_finance"();



CREATE OR REPLACE TRIGGER "trig_comprobante_payment_sync" AFTER INSERT OR DELETE OR UPDATE ON "public"."comprobante_payments" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_comprobante_payment_sync"();



CREATE OR REPLACE TRIGGER "trig_expense_finance" AFTER INSERT OR DELETE ON "public"."expenses" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_expense_finance"();



CREATE OR REPLACE TRIGGER "trig_payment_movements" BEFORE INSERT ON "public"."order_payments" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_payment_creates_movements"();



CREATE OR REPLACE TRIGGER "trig_personal_debts_updated_at" BEFORE UPDATE ON "public"."personal_debts" FOR EACH ROW EXECUTE FUNCTION "public"."update_personal_debts_updated_at"();



CREATE OR REPLACE TRIGGER "trig_pt_approved" AFTER UPDATE OF "status" ON "public"."payment_transactions" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_payment_transaction_approved"();



CREATE OR REPLACE TRIGGER "trig_recurring_expenses_updated_at" BEFORE UPDATE ON "public"."personal_recurring_expenses" FOR EACH ROW EXECUTE FUNCTION "public"."update_recurring_expenses_updated_at"();



CREATE OR REPLACE TRIGGER "trig_set_movement_caja" BEFORE INSERT ON "public"."financial_movements" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_movement_caja"();



CREATE OR REPLACE TRIGGER "trig_supplier_account_movement_balance" BEFORE INSERT ON "public"."supplier_account_movements" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_supplier_account_movement_balance"();



CREATE OR REPLACE TRIGGER "trig_task_history" AFTER INSERT OR UPDATE ON "public"."tasks" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_task_history"();



CREATE OR REPLACE TRIGGER "trigger_sync_business_logo_url" AFTER INSERT OR UPDATE OF "logo_url" ON "public"."business_settings" FOR EACH ROW EXECUTE FUNCTION "public"."sync_business_logo_url"();



CREATE OR REPLACE TRIGGER "trigger_update_business_settings_updated_at" BEFORE UPDATE ON "public"."business_settings" FOR EACH ROW EXECUTE FUNCTION "public"."update_business_settings_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_update_tasks_updated_at" BEFORE UPDATE ON "public"."tasks" FOR EACH ROW EXECUTE FUNCTION "public"."update_tasks_updated_at"();



CREATE OR REPLACE TRIGGER "update_business_invitations_updated_at" BEFORE UPDATE ON "public"."business_invitations" FOR EACH ROW EXECUTE FUNCTION "public"."update_timestamp"();



CREATE OR REPLACE TRIGGER "update_businesses_updated_at" BEFORE UPDATE ON "public"."businesses" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_comprobantes_updated_at" BEFORE UPDATE ON "public"."comprobantes" FOR EACH ROW EXECUTE FUNCTION "public"."update_timestamp"();



CREATE OR REPLACE TRIGGER "update_customers_updated_at" BEFORE UPDATE ON "public"."customers" FOR EACH ROW EXECUTE FUNCTION "public"."update_timestamp"();



CREATE OR REPLACE TRIGGER "update_devices_updated_at" BEFORE UPDATE ON "public"."devices" FOR EACH ROW EXECUTE FUNCTION "public"."update_timestamp"();



CREATE OR REPLACE TRIGGER "update_exchange_rates_updated_at" BEFORE UPDATE ON "public"."exchange_rates" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_inventory_updated_at" BEFORE UPDATE ON "public"."inventory" FOR EACH ROW EXECUTE FUNCTION "public"."update_timestamp"();



CREATE OR REPLACE TRIGGER "update_orders_updated_at" BEFORE UPDATE ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."update_timestamp"();



CREATE OR REPLACE TRIGGER "update_profiles_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_purchases_updated_at" BEFORE UPDATE ON "public"."purchases" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_suppliers_updated_at" BEFORE UPDATE ON "public"."suppliers" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "warranties_updated_at" BEFORE UPDATE ON "public"."warranties" FOR EACH ROW EXECUTE FUNCTION "public"."warranties_set_updated_at"();



ALTER TABLE ONLY "public"."account_movements"
    ADD CONSTRAINT "account_movements_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."arca_parametros"
    ADD CONSTRAINT "arca_parametros_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."blocked_feature_attempts"
    ADD CONSTRAINT "blocked_feature_attempts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."brands"
    ADD CONSTRAINT "brands_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."brands"
    ADD CONSTRAINT "brands_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."business_finance_entries"
    ADD CONSTRAINT "business_finance_entries_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."business_finance_entries"
    ADD CONSTRAINT "business_finance_entries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."business_finance_entries"
    ADD CONSTRAINT "business_finance_entries_recurring_expense_id_fkey" FOREIGN KEY ("recurring_expense_id") REFERENCES "public"."recurring_expenses"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."business_invitations"
    ADD CONSTRAINT "business_invitations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."business_invitations"
    ADD CONSTRAINT "business_invitations_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."business_settings"
    ADD CONSTRAINT "business_settings_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."businesses"
    ADD CONSTRAINT "businesses_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cash_registers"
    ADD CONSTRAINT "cash_registers_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cash_registers"
    ADD CONSTRAINT "cash_registers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."clic_wholesale_product_settings"
    ADD CONSTRAINT "clic_wholesale_product_settings_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."clic_wholesale_product_settings"
    ADD CONSTRAINT "clic_wholesale_product_settings_inventory_id_fkey" FOREIGN KEY ("inventory_id") REFERENCES "public"."inventory"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."comprobante_items"
    ADD CONSTRAINT "comprobante_items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."comprobante_items"
    ADD CONSTRAINT "comprobante_items_comprobante_id_fkey" FOREIGN KEY ("comprobante_id") REFERENCES "public"."comprobantes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."comprobante_items"
    ADD CONSTRAINT "comprobante_items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."comprobante_items"
    ADD CONSTRAINT "comprobante_items_inventory_id_fkey" FOREIGN KEY ("inventory_id") REFERENCES "public"."inventory"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."comprobante_payments"
    ADD CONSTRAINT "comprobante_payments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."comprobante_payments"
    ADD CONSTRAINT "comprobante_payments_comprobante_id_fkey" FOREIGN KEY ("comprobante_id") REFERENCES "public"."comprobantes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."comprobante_payments"
    ADD CONSTRAINT "comprobante_payments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."comprobantes"
    ADD CONSTRAINT "comprobantes_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."comprobantes"
    ADD CONSTRAINT "comprobantes_comprobante_original_id_fkey" FOREIGN KEY ("comprobante_original_id") REFERENCES "public"."comprobantes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."comprobantes"
    ADD CONSTRAINT "comprobantes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."comprobantes"
    ADD CONSTRAINT "comprobantes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."comprobantes"
    ADD CONSTRAINT "comprobantes_local_id_fkey" FOREIGN KEY ("local_id") REFERENCES "public"."sales_points"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."comprobantes"
    ADD CONSTRAINT "comprobantes_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."customer_events"
    ADD CONSTRAINT "customer_events_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."wholesale_customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."device_inspections"
    ADD CONSTRAINT "device_inspections_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."device_inspections"
    ADD CONSTRAINT "device_inspections_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."device_inspections"
    ADD CONSTRAINT "device_inspections_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."device_models"
    ADD CONSTRAINT "device_models_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."device_models"
    ADD CONSTRAINT "device_models_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."device_models"
    ADD CONSTRAINT "device_models_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."devices"
    ADD CONSTRAINT "devices_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."devices"
    ADD CONSTRAINT "devices_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."devices"
    ADD CONSTRAINT "devices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dollar_rate_history"
    ADD CONSTRAINT "dollar_rate_history_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."electronic_invoice_log"
    ADD CONSTRAINT "electronic_invoice_log_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."electronic_invoice_log"
    ADD CONSTRAINT "electronic_invoice_log_comprobante_id_fkey" FOREIGN KEY ("comprobante_id") REFERENCES "public"."comprobantes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."exchange_rates"
    ADD CONSTRAINT "exchange_rates_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."expense_categories"
    ADD CONSTRAINT "expense_categories_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_proveedor_id_fkey" FOREIGN KEY ("proveedor_id") REFERENCES "public"."suppliers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_supplier_purchase_id_fkey" FOREIGN KEY ("supplier_purchase_id") REFERENCES "public"."supplier_purchases"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."financial_movements"
    ADD CONSTRAINT "financial_movements_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."financial_movements"
    ADD CONSTRAINT "financial_movements_caja_id_fkey" FOREIGN KEY ("caja_id") REFERENCES "public"."cajas"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."financial_movements"
    ADD CONSTRAINT "financial_movements_comprobante_id_fkey" FOREIGN KEY ("comprobante_id") REFERENCES "public"."comprobantes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."financial_movements"
    ADD CONSTRAINT "financial_movements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."financial_movements"
    ADD CONSTRAINT "financial_movements_local_id_fkey" FOREIGN KEY ("local_id") REFERENCES "public"."sales_points"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."financial_movements"
    ADD CONSTRAINT "financial_movements_payment_transaction_id_fkey" FOREIGN KEY ("payment_transaction_id") REFERENCES "public"."payment_transactions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inventory"
    ADD CONSTRAINT "inventory_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."inventory"
    ADD CONSTRAINT "inventory_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."inventory"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inventory"
    ADD CONSTRAINT "inventory_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."inventory"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."inventory_valuation_history"
    ADD CONSTRAINT "inventory_valuation_history_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."mp_accounts"
    ADD CONSTRAINT "mp_accounts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notes"
    ADD CONSTRAINT "notes_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notes"
    ADD CONSTRAINT "notes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."notes"
    ADD CONSTRAINT "notes_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."order_checklists"
    ADD CONSTRAINT "order_checklists_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."order_checklists"
    ADD CONSTRAINT "order_checklists_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."order_checklists"
    ADD CONSTRAINT "order_checklists_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."inventory"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."order_parts"
    ADD CONSTRAINT "order_parts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."order_parts"
    ADD CONSTRAINT "order_parts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."order_parts"
    ADD CONSTRAINT "order_parts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."order_payments"
    ADD CONSTRAINT "order_payments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."order_payments"
    ADD CONSTRAINT "order_payments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."order_payments"
    ADD CONSTRAINT "order_payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_comprobante_id_fkey" FOREIGN KEY ("comprobante_id") REFERENCES "public"."comprobantes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_technician_id_fkey" FOREIGN KEY ("technician_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."owner_withdrawals"
    ADD CONSTRAINT "owner_withdrawals_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."owner_withdrawals"
    ADD CONSTRAINT "owner_withdrawals_destination_account_id_fkey" FOREIGN KEY ("destination_account_id") REFERENCES "public"."personal_accounts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."owner_withdrawals"
    ADD CONSTRAINT "owner_withdrawals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."parts_used"
    ADD CONSTRAINT "parts_used_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."parts_used"
    ADD CONSTRAINT "parts_used_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."parts_used"
    ADD CONSTRAINT "parts_used_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payment_commission_groups"
    ADD CONSTRAINT "payment_commission_groups_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payment_commission_options"
    ADD CONSTRAINT "payment_commission_options_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payment_commission_options"
    ADD CONSTRAINT "payment_commission_options_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."payment_commission_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payment_method_buttons"
    ADD CONSTRAINT "payment_method_buttons_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payment_orders"
    ADD CONSTRAINT "payment_orders_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payment_orders"
    ADD CONSTRAINT "payment_orders_comprobante_id_fkey" FOREIGN KEY ("comprobante_id") REFERENCES "public"."comprobantes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payment_orders"
    ADD CONSTRAINT "payment_orders_local_id_fkey" FOREIGN KEY ("local_id") REFERENCES "public"."sales_points"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payment_orders"
    ADD CONSTRAINT "payment_orders_payment_button_id_fkey" FOREIGN KEY ("payment_button_id") REFERENCES "public"."payment_method_buttons"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payment_transactions"
    ADD CONSTRAINT "payment_transactions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payment_transactions"
    ADD CONSTRAINT "payment_transactions_comprobante_id_fkey" FOREIGN KEY ("comprobante_id") REFERENCES "public"."comprobantes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payment_transactions"
    ADD CONSTRAINT "payment_transactions_payment_button_id_fkey" FOREIGN KEY ("payment_button_id") REFERENCES "public"."payment_method_buttons"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payment_transactions"
    ADD CONSTRAINT "payment_transactions_payment_order_id_fkey" FOREIGN KEY ("payment_order_id") REFERENCES "public"."payment_orders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payment_webhook_events"
    ADD CONSTRAINT "payment_webhook_events_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."personal_account_balances"
    ADD CONSTRAINT "personal_account_balances_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."personal_accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."personal_account_balances"
    ADD CONSTRAINT "personal_account_balances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."personal_accounts"
    ADD CONSTRAINT "personal_accounts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."personal_accounts"
    ADD CONSTRAINT "personal_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."personal_budgets"
    ADD CONSTRAINT "personal_budgets_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."personal_categories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."personal_budgets"
    ADD CONSTRAINT "personal_budgets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."personal_card_payments"
    ADD CONSTRAINT "personal_card_payments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."personal_accounts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."personal_card_payments"
    ADD CONSTRAINT "personal_card_payments_credit_card_id_fkey" FOREIGN KEY ("credit_card_id") REFERENCES "public"."personal_credit_cards"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."personal_card_payments"
    ADD CONSTRAINT "personal_card_payments_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."personal_transactions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."personal_card_payments"
    ADD CONSTRAINT "personal_card_payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."personal_card_purchases"
    ADD CONSTRAINT "personal_card_purchases_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."personal_categories"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."personal_card_purchases"
    ADD CONSTRAINT "personal_card_purchases_credit_card_id_fkey" FOREIGN KEY ("credit_card_id") REFERENCES "public"."personal_credit_cards"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."personal_card_purchases"
    ADD CONSTRAINT "personal_card_purchases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."personal_categories"
    ADD CONSTRAINT "personal_categories_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."personal_categories"
    ADD CONSTRAINT "personal_categories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."personal_credit_cards"
    ADD CONSTRAINT "personal_credit_cards_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."personal_credit_cards"
    ADD CONSTRAINT "personal_credit_cards_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."personal_debt_payments"
    ADD CONSTRAINT "personal_debt_payments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."personal_accounts"("id");



ALTER TABLE ONLY "public"."personal_debt_payments"
    ADD CONSTRAINT "personal_debt_payments_debt_id_fkey" FOREIGN KEY ("debt_id") REFERENCES "public"."personal_debts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."personal_debt_payments"
    ADD CONSTRAINT "personal_debt_payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."personal_debts"
    ADD CONSTRAINT "personal_debts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."personal_recurring_expense_payments"
    ADD CONSTRAINT "personal_recurring_expense_payments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."personal_accounts"("id");



ALTER TABLE ONLY "public"."personal_recurring_expense_payments"
    ADD CONSTRAINT "personal_recurring_expense_payments_recurring_expense_id_fkey" FOREIGN KEY ("recurring_expense_id") REFERENCES "public"."personal_recurring_expenses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."personal_recurring_expense_payments"
    ADD CONSTRAINT "personal_recurring_expense_payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."personal_recurring_expenses"
    ADD CONSTRAINT "personal_recurring_expenses_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."personal_categories"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."personal_recurring_expenses"
    ADD CONSTRAINT "personal_recurring_expenses_default_account_id_fkey" FOREIGN KEY ("default_account_id") REFERENCES "public"."personal_accounts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."personal_recurring_expenses"
    ADD CONSTRAINT "personal_recurring_expenses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."personal_savings_goals"
    ADD CONSTRAINT "personal_savings_goals_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."personal_accounts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."personal_savings_goals"
    ADD CONSTRAINT "personal_savings_goals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."personal_transactions"
    ADD CONSTRAINT "personal_transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."personal_accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."personal_transactions"
    ADD CONSTRAINT "personal_transactions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."personal_transactions"
    ADD CONSTRAINT "personal_transactions_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."personal_categories"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."personal_transactions"
    ADD CONSTRAINT "personal_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."product_offers"
    ADD CONSTRAINT "product_offers_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."product_offers"
    ADD CONSTRAINT "product_offers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."product_offers"
    ADD CONSTRAINT "product_offers_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."inventory"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."product_variants"
    ADD CONSTRAINT "product_variants_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."product_variants"
    ADD CONSTRAINT "product_variants_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."product_variants"
    ADD CONSTRAINT "product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."inventory"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_active_sales_point_id_fkey" FOREIGN KEY ("active_sales_point_id") REFERENCES "public"."sales_points"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."purchase_items"
    ADD CONSTRAINT "purchase_items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."purchase_items"
    ADD CONSTRAINT "purchase_items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."purchase_items"
    ADD CONSTRAINT "purchase_items_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."purchase_items"
    ADD CONSTRAINT "purchase_items_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."purchases"
    ADD CONSTRAINT "purchases_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."purchases"
    ADD CONSTRAINT "purchases_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."purchases"
    ADD CONSTRAINT "purchases_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."settings_audit_log"
    ADD CONSTRAINT "settings_audit_log_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."settings_audit_log"
    ADD CONSTRAINT "settings_audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."status_history"
    ADD CONSTRAINT "status_history_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."status_history"
    ADD CONSTRAINT "status_history_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."status_history"
    ADD CONSTRAINT "status_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."subscription_checkout_sessions"
    ADD CONSTRAINT "subscription_checkout_sessions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."subscription_events"
    ADD CONSTRAINT "subscription_events_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."subscription_payments"
    ADD CONSTRAINT "subscription_payments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."subscription_payments"
    ADD CONSTRAINT "subscription_payments_checkout_session_id_fkey" FOREIGN KEY ("checkout_session_id") REFERENCES "public"."subscription_checkout_sessions"("id");



ALTER TABLE ONLY "public"."supplier_account_movements"
    ADD CONSTRAINT "supplier_account_movements_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."supplier_account_movements"
    ADD CONSTRAINT "supplier_account_movements_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."supplier_payments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."supplier_account_movements"
    ADD CONSTRAINT "supplier_account_movements_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "public"."supplier_purchases"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."supplier_account_movements"
    ADD CONSTRAINT "supplier_account_movements_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."supplier_payments"
    ADD CONSTRAINT "supplier_payments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."supplier_payments"
    ADD CONSTRAINT "supplier_payments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."supplier_payments"
    ADD CONSTRAINT "supplier_payments_financial_movement_id_fkey" FOREIGN KEY ("financial_movement_id") REFERENCES "public"."financial_movements"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."supplier_payments"
    ADD CONSTRAINT "supplier_payments_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "public"."supplier_purchases"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."supplier_payments"
    ADD CONSTRAINT "supplier_payments_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."supplier_purchase_items"
    ADD CONSTRAINT "supplier_purchase_items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."supplier_purchase_items"
    ADD CONSTRAINT "supplier_purchase_items_inventory_id_fkey" FOREIGN KEY ("inventory_id") REFERENCES "public"."inventory"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."supplier_purchase_items"
    ADD CONSTRAINT "supplier_purchase_items_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "public"."supplier_purchases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."supplier_purchase_items"
    ADD CONSTRAINT "supplier_purchase_items_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."supplier_purchases"
    ADD CONSTRAINT "supplier_purchases_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."supplier_purchases"
    ADD CONSTRAINT "supplier_purchases_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."supplier_purchases"
    ADD CONSTRAINT "supplier_purchases_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."suppliers"
    ADD CONSTRAINT "suppliers_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."suppliers"
    ADD CONSTRAINT "suppliers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."system_admins"
    ADD CONSTRAINT "system_admins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."task_comments"
    ADD CONSTRAINT "task_comments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."task_history"
    ADD CONSTRAINT "task_history_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."task_items"
    ADD CONSTRAINT "task_items_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."warranties"
    ADD CONSTRAINT "warranties_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."warranties"
    ADD CONSTRAINT "warranties_comprobante_id_fkey" FOREIGN KEY ("comprobante_id") REFERENCES "public"."comprobantes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."warranties"
    ADD CONSTRAINT "warranties_comprobante_item_id_fkey" FOREIGN KEY ("comprobante_item_id") REFERENCES "public"."comprobante_items"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."warranties"
    ADD CONSTRAINT "warranties_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."warranties"
    ADD CONSTRAINT "warranties_inventory_id_fkey" FOREIGN KEY ("inventory_id") REFERENCES "public"."inventory"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."warranties"
    ADD CONSTRAINT "warranties_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."warranties"
    ADD CONSTRAINT "warranties_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."warranty_events"
    ADD CONSTRAINT "warranty_events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."warranty_events"
    ADD CONSTRAINT "warranty_events_warranty_id_fkey" FOREIGN KEY ("warranty_id") REFERENCES "public"."warranties"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."whatsapp_connection_credentials"
    ADD CONSTRAINT "whatsapp_connection_credentials_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."whatsapp_connections"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."whatsapp_connection_events"
    ADD CONSTRAINT "whatsapp_connection_events_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."whatsapp_connection_events"
    ADD CONSTRAINT "whatsapp_connection_events_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."whatsapp_connections"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."whatsapp_logs"
    ADD CONSTRAINT "whatsapp_logs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."whatsapp_logs"
    ADD CONSTRAINT "whatsapp_logs_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."whatsapp_logs"
    ADD CONSTRAINT "whatsapp_logs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."whatsapp_message_logs"
    ADD CONSTRAINT "whatsapp_message_logs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."whatsapp_connections"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."whatsapp_settings"
    ADD CONSTRAINT "whatsapp_settings_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."whatsapp_templates"
    ADD CONSTRAINT "whatsapp_templates_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."wholesale_customers"
    ADD CONSTRAINT "wholesale_customers_auth_user_id_fkey" FOREIGN KEY ("auth_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."wholesale_customers"
    ADD CONSTRAINT "wholesale_customers_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."wholesale_order_items"
    ADD CONSTRAINT "wholesale_order_items_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."wholesale_order_items"
    ADD CONSTRAINT "wholesale_order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."wholesale_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."wholesale_orders"
    ADD CONSTRAINT "wholesale_orders_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."wholesale_orders"
    ADD CONSTRAINT "wholesale_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."wholesale_customers"("id") ON DELETE RESTRICT;



CREATE POLICY "Users can delete inventory valuation history for their business" ON "public"."inventory_valuation_history" FOR DELETE TO "authenticated" USING (("business_id" IN ( SELECT "public"."user_business_ids"() AS "user_business_ids")));



CREATE POLICY "Users can insert arca parameters for their business" ON "public"."arca_parametros" FOR INSERT WITH CHECK (("business_id" IN ( SELECT "public"."user_business_ids"() AS "user_business_ids")));



CREATE POLICY "Users can insert business settings for their business" ON "public"."business_settings" FOR INSERT WITH CHECK (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE (COALESCE("profiles"."user_id", "profiles"."id") = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "Users can insert electronic invoice logs for their business" ON "public"."electronic_invoice_log" FOR INSERT TO "authenticated" WITH CHECK (("business_id" IN ( SELECT "public"."user_business_ids"() AS "user_business_ids")));



CREATE POLICY "Users can insert inventory valuation history for their business" ON "public"."inventory_valuation_history" FOR INSERT TO "authenticated" WITH CHECK (("business_id" IN ( SELECT "public"."user_business_ids"() AS "user_business_ids")));



CREATE POLICY "Users can update arca parameters for their business" ON "public"."arca_parametros" FOR UPDATE USING (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE (COALESCE("profiles"."user_id", "profiles"."id") = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "Users can update business settings for their business" ON "public"."business_settings" FOR UPDATE USING (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE (COALESCE("profiles"."user_id", "profiles"."id") = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "Users can update inventory valuation history for their business" ON "public"."inventory_valuation_history" FOR UPDATE TO "authenticated" USING (("business_id" IN ( SELECT "public"."user_business_ids"() AS "user_business_ids"))) WITH CHECK (("business_id" IN ( SELECT "public"."user_business_ids"() AS "user_business_ids")));



CREATE POLICY "Users can view arca parameters for their business" ON "public"."arca_parametros" FOR SELECT USING (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE (COALESCE("profiles"."user_id", "profiles"."id") = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "Users can view business settings for their business" ON "public"."business_settings" FOR SELECT USING (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE (COALESCE("profiles"."user_id", "profiles"."id") = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "Users can view electronic invoice logs for their business" ON "public"."electronic_invoice_log" FOR SELECT USING (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE (COALESCE("profiles"."user_id", "profiles"."id") = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "Users can view inventory valuation history for their business" ON "public"."inventory_valuation_history" FOR SELECT TO "authenticated" USING (("business_id" IN ( SELECT "public"."user_business_ids"() AS "user_business_ids")));



ALTER TABLE "public"."account_movements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "account_movements_plan" ON "public"."account_movements" USING ((("public"."current_business_id"() = "business_id") AND "public"."is_staff"() AND "public"."business_has_feature"('currentAccounts'::"text"))) WITH CHECK ((("public"."current_business_id"() = "business_id") AND "public"."is_staff"() AND "public"."business_has_feature"('currentAccounts'::"text")));



ALTER TABLE "public"."accounts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "accounts_plan" ON "public"."accounts" USING ((("public"."current_business_id"() = "business_id") AND "public"."is_staff"() AND "public"."business_has_feature"('currentAccounts'::"text"))) WITH CHECK ((("public"."current_business_id"() = "business_id") AND "public"."is_staff"() AND "public"."business_has_feature"('currentAccounts'::"text")));



CREATE POLICY "anon_insert_leads" ON "public"."contact_leads" FOR INSERT TO "anon", "authenticated" WITH CHECK (true);



ALTER TABLE "public"."arca_config" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "arca_config_plan_read" ON "public"."arca_config" FOR SELECT USING ((("business_id" IN ( SELECT "public"."user_business_ids"() AS "user_business_ids")) AND "public"."business_has_feature"('arca'::"text")));



CREATE POLICY "arca_config_plan_write" ON "public"."arca_config" USING ((("business_id" IN ( SELECT "public"."user_business_ids"() AS "user_business_ids")) AND "public"."business_has_feature"('arca'::"text"))) WITH CHECK ((("business_id" IN ( SELECT "public"."user_business_ids"() AS "user_business_ids")) AND "public"."business_has_feature"('arca'::"text")));



CREATE POLICY "arca_config_service" ON "public"."arca_config" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "arca_config_service_role" ON "public"."arca_config" USING (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."arca_parametros" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "arca_parametros_service_role" ON "public"."arca_parametros" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "audit_log_plan_insert" ON "public"."settings_audit_log" FOR INSERT WITH CHECK (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE (COALESCE("profiles"."user_id", "profiles"."id") = "auth"."uid"()))));



CREATE POLICY "audit_log_plan_select" ON "public"."settings_audit_log" FOR SELECT USING ((("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE (COALESCE("profiles"."user_id", "profiles"."id") = "auth"."uid"()))) AND "public"."business_has_feature"('audit'::"text")));



CREATE POLICY "bfa_insert" ON "public"."blocked_feature_attempts" FOR INSERT WITH CHECK (("business_id" = "public"."current_user_business_id"()));



CREATE POLICY "bfa_select" ON "public"."blocked_feature_attempts" FOR SELECT USING (("business_id" = "public"."current_user_business_id"()));



CREATE POLICY "bfe_delete" ON "public"."business_finance_entries" FOR DELETE USING (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "bfe_insert" ON "public"."business_finance_entries" FOR INSERT WITH CHECK (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "bfe_select" ON "public"."business_finance_entries" FOR SELECT USING (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE (COALESCE("profiles"."user_id", "profiles"."id") = "auth"."uid"()))));



CREATE POLICY "bfe_update" ON "public"."business_finance_entries" FOR UPDATE USING (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")))));



ALTER TABLE "public"."blocked_feature_attempts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."brands" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "brands_delete" ON "public"."brands" FOR DELETE USING (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))));



CREATE POLICY "brands_insert" ON "public"."brands" FOR INSERT WITH CHECK (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))));



CREATE POLICY "brands_select" ON "public"."brands" FOR SELECT USING (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))));



CREATE POLICY "brands_update" ON "public"."brands" FOR UPDATE USING (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."business_finance_entries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."business_invitations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "business_invitations_delete" ON "public"."business_invitations" FOR DELETE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_owner_or_admin"()));



CREATE POLICY "business_invitations_insert" ON "public"."business_invitations" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE ((COALESCE("p"."user_id", "p"."id") = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."business_id" = "business_invitations"."business_id") AND ("p"."is_active" = true) AND ("p"."role" = ANY (ARRAY['owner'::"text", 'admin'::"text"]))))));



CREATE POLICY "business_invitations_select" ON "public"."business_invitations" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE ((COALESCE("p"."user_id", "p"."id") = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."business_id" = "business_invitations"."business_id") AND ("p"."is_active" = true) AND ("p"."role" = ANY (ARRAY['owner'::"text", 'admin'::"text"]))))));



CREATE POLICY "business_invitations_update" ON "public"."business_invitations" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE ((COALESCE("p"."user_id", "p"."id") = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."business_id" = "business_invitations"."business_id") AND ("p"."is_active" = true) AND ("p"."role" = ANY (ARRAY['owner'::"text", 'admin'::"text"])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE ((COALESCE("p"."user_id", "p"."id") = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."business_id" = "business_invitations"."business_id") AND ("p"."is_active" = true) AND ("p"."role" = ANY (ARRAY['owner'::"text", 'admin'::"text"]))))));



CREATE POLICY "business_members_manage_order_items" ON "public"."order_items" USING (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid"))))) WITH CHECK (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")))));



ALTER TABLE "public"."business_settings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "business_settings_delete" ON "public"."business_settings" FOR DELETE TO "authenticated" USING ((("business_id" = "public"."current_user_business_id"()) AND ("public"."current_user_role"() = ANY (ARRAY['owner'::"text", 'admin'::"text"]))));



CREATE POLICY "business_settings_insert" ON "public"."business_settings" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" = "public"."current_user_business_id"()) AND ("public"."current_user_role"() = ANY (ARRAY['owner'::"text", 'admin'::"text"]))));



CREATE POLICY "business_settings_select" ON "public"."business_settings" FOR SELECT TO "authenticated" USING (("business_id" = "public"."current_user_business_id"()));



CREATE POLICY "business_settings_update" ON "public"."business_settings" FOR UPDATE TO "authenticated" USING ((("business_id" = "public"."current_user_business_id"()) AND ("public"."current_user_role"() = ANY (ARRAY['owner'::"text", 'admin'::"text"])))) WITH CHECK ((("business_id" = "public"."current_user_business_id"()) AND ("public"."current_user_role"() = ANY (ARRAY['owner'::"text", 'admin'::"text"]))));



ALTER TABLE "public"."businesses" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "businesses_delete" ON "public"."businesses" FOR DELETE TO "authenticated" USING ((("id" = "public"."current_business_id"()) AND "public"."is_owner_or_admin"()));



CREATE POLICY "businesses_insert" ON "public"."businesses" FOR INSERT WITH CHECK (("owner_user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "businesses_portal_public_read" ON "public"."businesses" FOR SELECT USING (("wholesale_portal_enabled" = true));



CREATE POLICY "businesses_select" ON "public"."businesses" FOR SELECT TO "authenticated" USING (("id" = "public"."current_user_business_id"()));



CREATE POLICY "businesses_update" ON "public"."businesses" FOR UPDATE TO "authenticated" USING ((("id" = "public"."current_user_business_id"()) AND ("public"."current_user_role"() = ANY (ARRAY['owner'::"text", 'admin'::"text"])))) WITH CHECK ((("id" = "public"."current_user_business_id"()) AND ("public"."current_user_role"() = ANY (ARRAY['owner'::"text", 'admin'::"text"]))));



ALTER TABLE "public"."cajas" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cajas_staff" ON "public"."cajas" USING ((("public"."current_business_id"() = "business_id") AND "public"."is_staff"()));



ALTER TABLE "public"."cash_registers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cash_registers_business_insert" ON "public"."cash_registers" FOR INSERT WITH CHECK (("business_id" = ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "cash_registers_business_select" ON "public"."cash_registers" FOR SELECT USING (("business_id" = ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "cash_registers_business_update" ON "public"."cash_registers" FOR UPDATE USING (("business_id" = ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "ce_admin" ON "public"."customer_events" USING (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))));



CREATE POLICY "ce_insert" ON "public"."customer_events" FOR INSERT WITH CHECK (true);



ALTER TABLE "public"."clic_wholesale_product_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."comprobante_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "comprobante_items_delete" ON "public"."comprobante_items" FOR DELETE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."can_manage"()));



CREATE POLICY "comprobante_items_insert" ON "public"."comprobante_items" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "comprobante_items_select" ON "public"."comprobante_items" FOR SELECT USING (("business_id" = "public"."current_user_business_id"()));



CREATE POLICY "comprobante_items_update" ON "public"."comprobante_items" FOR UPDATE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



ALTER TABLE "public"."comprobante_payments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."comprobantes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "comprobantes_delete" ON "public"."comprobantes" FOR DELETE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."can_manage"()));



CREATE POLICY "comprobantes_insert" ON "public"."comprobantes" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "comprobantes_select" ON "public"."comprobantes" FOR SELECT USING (("business_id" = "public"."current_user_business_id"()));



CREATE POLICY "comprobantes_update" ON "public"."comprobantes" FOR UPDATE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



ALTER TABLE "public"."contact_leads" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cp_select" ON "public"."comprobante_payments" FOR SELECT USING (("business_id" = "public"."current_user_business_id"()));



CREATE POLICY "cp_write" ON "public"."comprobante_payments" TO "authenticated" USING (("business_id" = "public"."current_user_business_id"())) WITH CHECK (("business_id" = "public"."current_user_business_id"()));



CREATE POLICY "cr_write" ON "public"."cash_registers" TO "authenticated" USING (("business_id" = "public"."current_user_business_id"())) WITH CHECK (("business_id" = "public"."current_user_business_id"()));



ALTER TABLE "public"."customer_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."customers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "customers_delete" ON "public"."customers" FOR DELETE TO "authenticated" USING ((("business_id" = "public"."current_user_business_id"()) AND ("public"."current_user_role"() = ANY (ARRAY['owner'::"text", 'admin'::"text", 'manager'::"text"]))));



CREATE POLICY "customers_insert" ON "public"."customers" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" = "public"."current_user_business_id"()) AND ("public"."current_user_role"() = ANY (ARRAY['owner'::"text", 'admin'::"text", 'manager'::"text", 'tech'::"text", 'sales'::"text", 'cashier'::"text"]))));



CREATE POLICY "customers_select" ON "public"."customers" FOR SELECT TO "authenticated" USING (("business_id" = "public"."current_user_business_id"()));



CREATE POLICY "customers_update" ON "public"."customers" FOR UPDATE TO "authenticated" USING ((("business_id" = "public"."current_user_business_id"()) AND ("public"."current_user_role"() = ANY (ARRAY['owner'::"text", 'admin'::"text", 'manager'::"text", 'tech'::"text", 'sales'::"text", 'cashier'::"text"])))) WITH CHECK ((("business_id" = "public"."current_user_business_id"()) AND ("public"."current_user_role"() = ANY (ARRAY['owner'::"text", 'admin'::"text", 'manager'::"text", 'tech'::"text", 'sales'::"text", 'cashier'::"text"]))));



CREATE POLICY "cwps_admin" ON "public"."clic_wholesale_product_settings" USING (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."device_inspections" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "device_inspections_delete" ON "public"."device_inspections" FOR DELETE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."can_manage"()));



CREATE POLICY "device_inspections_insert" ON "public"."device_inspections" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "device_inspections_select" ON "public"."device_inspections" FOR SELECT TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "device_inspections_update" ON "public"."device_inspections" FOR UPDATE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



ALTER TABLE "public"."device_models" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "device_models_delete" ON "public"."device_models" FOR DELETE USING (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))));



CREATE POLICY "device_models_insert" ON "public"."device_models" FOR INSERT WITH CHECK (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))));



CREATE POLICY "device_models_select" ON "public"."device_models" FOR SELECT USING (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))));



CREATE POLICY "device_models_update" ON "public"."device_models" FOR UPDATE USING (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."devices" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "devices_delete" ON "public"."devices" FOR DELETE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."can_manage"()));



CREATE POLICY "devices_insert" ON "public"."devices" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "devices_select" ON "public"."devices" FOR SELECT TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "devices_update" ON "public"."devices" FOR UPDATE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



ALTER TABLE "public"."documents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "documents_delete" ON "public"."documents" FOR DELETE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."can_manage"()));



CREATE POLICY "documents_insert" ON "public"."documents" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "documents_select" ON "public"."documents" FOR SELECT TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "documents_update" ON "public"."documents" FOR UPDATE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



ALTER TABLE "public"."dollar_rate_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."electronic_invoice_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."exchange_rates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "exchange_rates_delete" ON "public"."exchange_rates" FOR DELETE TO "authenticated" USING ((("business_id" = "public"."current_user_business_id"()) AND ("public"."current_user_role"() = ANY (ARRAY['owner'::"text", 'admin'::"text"]))));



CREATE POLICY "exchange_rates_insert" ON "public"."exchange_rates" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" = "public"."current_user_business_id"()) AND ("public"."current_user_role"() = ANY (ARRAY['owner'::"text", 'admin'::"text"]))));



CREATE POLICY "exchange_rates_select" ON "public"."exchange_rates" FOR SELECT TO "authenticated" USING (("business_id" = "public"."current_user_business_id"()));



CREATE POLICY "exchange_rates_update" ON "public"."exchange_rates" FOR UPDATE TO "authenticated" USING ((("business_id" = "public"."current_user_business_id"()) AND ("public"."current_user_role"() = ANY (ARRAY['owner'::"text", 'admin'::"text"])))) WITH CHECK ((("business_id" = "public"."current_user_business_id"()) AND ("public"."current_user_role"() = ANY (ARRAY['owner'::"text", 'admin'::"text"]))));



ALTER TABLE "public"."expense_categories" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."expenses" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "expenses_delete" ON "public"."expenses" FOR DELETE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."can_manage"()));



CREATE POLICY "expenses_insert" ON "public"."expenses" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "expenses_select" ON "public"."expenses" FOR SELECT TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "expenses_update" ON "public"."expenses" FOR UPDATE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



ALTER TABLE "public"."financial_movements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "financial_movements_business_insert" ON "public"."financial_movements" FOR INSERT WITH CHECK (("business_id" = ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "financial_movements_business_select" ON "public"."financial_movements" FOR SELECT USING (("business_id" = ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "financial_movements_business_update" ON "public"."financial_movements" FOR UPDATE USING (("business_id" = ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "fm_write" ON "public"."financial_movements" TO "authenticated" USING (("business_id" = "public"."current_user_business_id"())) WITH CHECK (("business_id" = "public"."current_user_business_id"()));



ALTER TABLE "public"."inventory" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "inventory_delete" ON "public"."inventory" FOR DELETE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."can_manage"()));



CREATE POLICY "inventory_insert" ON "public"."inventory" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



ALTER TABLE "public"."inventory_movements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "inventory_movements_delete" ON "public"."inventory_movements" FOR DELETE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."can_manage"()));



CREATE POLICY "inventory_movements_insert" ON "public"."inventory_movements" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "inventory_movements_select" ON "public"."inventory_movements" FOR SELECT TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "inventory_movements_update" ON "public"."inventory_movements" FOR UPDATE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."can_manage"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."can_manage"()));



CREATE POLICY "inventory_select" ON "public"."inventory" FOR SELECT TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "inventory_update" ON "public"."inventory" FOR UPDATE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



ALTER TABLE "public"."inventory_valuation_history" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "inventory_wholesale_portal_read" ON "public"."inventory" FOR SELECT USING ((("is_active" = true) AND ("visible_in_wholesale" = true) AND ("stock_quantity" > 0) AND (EXISTS ( SELECT 1
   FROM "public"."wholesale_customers" "wc"
  WHERE (("wc"."auth_user_id" = "auth"."uid"()) AND ("wc"."business_id" = "inventory"."business_id") AND ("wc"."approved" = true) AND ("wc"."suspended" = false))))));



ALTER TABLE "public"."mp_accounts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "mp_accounts_select" ON "public"."mp_accounts" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "mp_accounts_write" ON "public"."mp_accounts" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."notes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notes_delete" ON "public"."notes" FOR DELETE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."can_manage"()));



CREATE POLICY "notes_insert" ON "public"."notes" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "notes_select" ON "public"."notes" FOR SELECT TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "notes_update" ON "public"."notes" FOR UPDATE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notifications_delete" ON "public"."notifications" FOR DELETE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."can_manage"()));



CREATE POLICY "notifications_insert" ON "public"."notifications" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "notifications_select" ON "public"."notifications" FOR SELECT USING (("business_id" = "public"."current_user_business_id"()));



CREATE POLICY "notifications_update" ON "public"."notifications" FOR UPDATE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



ALTER TABLE "public"."order_checklists" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "order_checklists_delete" ON "public"."order_checklists" FOR DELETE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."can_manage"()));



CREATE POLICY "order_checklists_insert" ON "public"."order_checklists" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "order_checklists_select" ON "public"."order_checklists" FOR SELECT TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "order_checklists_update" ON "public"."order_checklists" FOR UPDATE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



ALTER TABLE "public"."order_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."order_parts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "order_parts_delete" ON "public"."order_parts" FOR DELETE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."can_manage"()));



CREATE POLICY "order_parts_insert" ON "public"."order_parts" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "order_parts_select" ON "public"."order_parts" FOR SELECT TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "order_parts_update" ON "public"."order_parts" FOR UPDATE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



ALTER TABLE "public"."order_payments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "order_payments_delete" ON "public"."order_payments" FOR DELETE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."can_manage"()));



CREATE POLICY "order_payments_insert" ON "public"."order_payments" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "order_payments_select" ON "public"."order_payments" FOR SELECT TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "order_payments_update" ON "public"."order_payments" FOR UPDATE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "orders_delete" ON "public"."orders" FOR DELETE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."can_manage"()));



CREATE POLICY "orders_insert" ON "public"."orders" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "orders_select" ON "public"."orders" FOR SELECT TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "orders_update" ON "public"."orders" FOR UPDATE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



ALTER TABLE "public"."owner_withdrawals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "owner_withdrawals_own" ON "public"."owner_withdrawals" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."parts_used" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "parts_used_delete" ON "public"."parts_used" FOR DELETE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."can_manage"()));



CREATE POLICY "parts_used_insert" ON "public"."parts_used" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "parts_used_select" ON "public"."parts_used" FOR SELECT TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "parts_used_update" ON "public"."parts_used" FOR UPDATE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



ALTER TABLE "public"."payment_commission_groups" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payment_commission_options" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payment_method_buttons" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payment_orders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payment_transactions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payment_webhook_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payments_select" ON "public"."payments" FOR SELECT USING (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE (("profiles"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."is_active" = true)))));



ALTER TABLE "public"."personal_account_balances" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "personal_account_balances_own" ON "public"."personal_account_balances" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."personal_accounts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "personal_accounts_own" ON "public"."personal_accounts" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."personal_budgets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "personal_budgets_delete" ON "public"."personal_budgets" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "personal_budgets_insert" ON "public"."personal_budgets" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "personal_budgets_select" ON "public"."personal_budgets" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "personal_budgets_update" ON "public"."personal_budgets" FOR UPDATE USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."personal_card_payments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "personal_card_payments_user" ON "public"."personal_card_payments" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."personal_card_purchases" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "personal_card_purchases_own" ON "public"."personal_card_purchases" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."personal_categories" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "personal_categories_own" ON "public"."personal_categories" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."personal_credit_cards" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "personal_credit_cards_own" ON "public"."personal_credit_cards" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."personal_debt_payments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "personal_debt_payments_user" ON "public"."personal_debt_payments" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."personal_debts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "personal_debts_own" ON "public"."personal_debts" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."personal_recurring_expense_payments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."personal_recurring_expenses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."personal_savings_goals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "personal_savings_goals_own" ON "public"."personal_savings_goals" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."personal_transactions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "personal_transactions_own" ON "public"."personal_transactions" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "pmb_select" ON "public"."payment_method_buttons" FOR SELECT USING (("business_id" = "public"."current_user_business_id"()));



CREATE POLICY "pmb_write" ON "public"."payment_method_buttons" TO "authenticated" USING (("business_id" = "public"."current_user_business_id"())) WITH CHECK (("business_id" = "public"."current_user_business_id"()));



CREATE POLICY "po_select" ON "public"."payment_orders" FOR SELECT USING (("business_id" = "public"."current_user_business_id"()));



CREATE POLICY "po_write" ON "public"."payment_orders" TO "authenticated" USING (("business_id" = "public"."current_user_business_id"())) WITH CHECK (("business_id" = "public"."current_user_business_id"()));



ALTER TABLE "public"."product_offers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."product_variants" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_delete" ON "public"."profiles" FOR DELETE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_owner_or_admin"()));



CREATE POLICY "profiles_insert" ON "public"."profiles" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_owner_or_admin"()));



CREATE POLICY "profiles_select" ON "public"."profiles" FOR SELECT USING (((COALESCE("user_id", "id") = ( SELECT "auth"."uid"() AS "uid")) OR ("business_id" = "public"."current_user_business_id"())));



CREATE POLICY "profiles_update" ON "public"."profiles" FOR UPDATE USING (((COALESCE("user_id", "id") = ( SELECT "auth"."uid"() AS "uid")) OR (("business_id" = "public"."current_user_business_id"()) AND ("public"."current_user_role"() = ANY (ARRAY['owner'::"text", 'admin'::"text"]))))) WITH CHECK (((COALESCE("user_id", "id") = ( SELECT "auth"."uid"() AS "uid")) OR (("business_id" = "public"."current_user_business_id"()) AND ("public"."current_user_role"() = ANY (ARRAY['owner'::"text", 'admin'::"text"])))));



CREATE POLICY "pt_select" ON "public"."payment_transactions" FOR SELECT USING (("business_id" = "public"."current_user_business_id"()));



CREATE POLICY "pt_write" ON "public"."payment_transactions" TO "authenticated" USING (("business_id" = "public"."current_user_business_id"())) WITH CHECK (("business_id" = "public"."current_user_business_id"()));



ALTER TABLE "public"."purchase_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "purchase_items_delete" ON "public"."purchase_items" FOR DELETE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."can_manage"()));



CREATE POLICY "purchase_items_insert" ON "public"."purchase_items" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "purchase_items_select" ON "public"."purchase_items" FOR SELECT TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "purchase_items_update" ON "public"."purchase_items" FOR UPDATE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



ALTER TABLE "public"."purchases" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "purchases_delete" ON "public"."purchases" FOR DELETE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."can_manage"()));



CREATE POLICY "purchases_insert" ON "public"."purchases" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "purchases_select" ON "public"."purchases" FOR SELECT TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "purchases_update" ON "public"."purchases" FOR UPDATE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "pwe_service_only" ON "public"."payment_webhook_events" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "re_delete" ON "public"."personal_recurring_expenses" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "re_delete" ON "public"."recurring_expenses" FOR DELETE USING (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "re_insert" ON "public"."personal_recurring_expenses" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "re_insert" ON "public"."recurring_expenses" FOR INSERT WITH CHECK (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "re_select" ON "public"."personal_recurring_expenses" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "re_select" ON "public"."recurring_expenses" FOR SELECT USING (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE (COALESCE("profiles"."user_id", "profiles"."id") = "auth"."uid"()))));



CREATE POLICY "re_update" ON "public"."personal_recurring_expenses" FOR UPDATE USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "re_update" ON "public"."recurring_expenses" FOR UPDATE USING (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")))));



ALTER TABLE "public"."recurring_expenses" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "rep_delete" ON "public"."personal_recurring_expense_payments" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "rep_insert" ON "public"."personal_recurring_expense_payments" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "rep_select" ON "public"."personal_recurring_expense_payments" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "rep_update" ON "public"."personal_recurring_expense_payments" FOR UPDATE USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "rls_drh" ON "public"."dollar_rate_history" TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "rls_ec" ON "public"."expense_categories" TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "rls_pcg" ON "public"."payment_commission_groups" TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "rls_pco" ON "public"."payment_commission_options" TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "rls_product_offers_all" ON "public"."product_offers" TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "rls_supplier_account_movements" ON "public"."supplier_account_movements" TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "rls_supplier_payments" ON "public"."supplier_payments" TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "rls_supplier_purchase_items" ON "public"."supplier_purchase_items" TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "rls_supplier_purchases" ON "public"."supplier_purchases" TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "saa_select_admin" ON "public"."subscription_admin_actions" FOR SELECT TO "authenticated" USING ("public"."is_platform_admin"("auth"."uid"()));



ALTER TABLE "public"."sales_points" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sales_points_delete" ON "public"."sales_points" FOR DELETE USING (("business_id" IN ( SELECT "public"."user_business_ids"() AS "user_business_ids")));



CREATE POLICY "sales_points_insert" ON "public"."sales_points" FOR INSERT WITH CHECK (("business_id" IN ( SELECT "public"."user_business_ids"() AS "user_business_ids")));



CREATE POLICY "sales_points_select" ON "public"."sales_points" FOR SELECT USING (("business_id" IN ( SELECT "public"."user_business_ids"() AS "user_business_ids")));



CREATE POLICY "sales_points_service_role" ON "public"."sales_points" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "sales_points_update" ON "public"."sales_points" FOR UPDATE USING (("business_id" IN ( SELECT "public"."user_business_ids"() AS "user_business_ids")));



CREATE POLICY "scs_insert" ON "public"."subscription_checkout_sessions" FOR INSERT WITH CHECK (("business_id" = "public"."current_user_business_id"()));



CREATE POLICY "scs_select" ON "public"."subscription_checkout_sessions" FOR SELECT USING (("business_id" = "public"."current_user_business_id"()));



CREATE POLICY "scs_service" ON "public"."subscription_checkout_sessions" USING (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."settings_audit_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sp_select" ON "public"."sales_points" FOR SELECT TO "authenticated" USING (("business_id" = "public"."current_user_business_id"()));



CREATE POLICY "sp_select" ON "public"."subscription_payments" FOR SELECT USING (("business_id" = "public"."current_user_business_id"()));



CREATE POLICY "sp_service" ON "public"."subscription_payments" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "sp_write" ON "public"."sales_points" TO "authenticated" USING (("business_id" = "public"."current_user_business_id"())) WITH CHECK (("business_id" = "public"."current_user_business_id"()));



ALTER TABLE "public"."status_history" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "status_history_delete" ON "public"."status_history" FOR DELETE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."can_manage"()));



CREATE POLICY "status_history_insert" ON "public"."status_history" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "status_history_select" ON "public"."status_history" FOR SELECT TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "status_history_update" ON "public"."status_history" FOR UPDATE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "sub_events_select" ON "public"."subscription_events" FOR SELECT USING (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE (("profiles"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."is_active" = true)))));



ALTER TABLE "public"."subscription_admin_actions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."subscription_checkout_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."subscription_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."subscription_payments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."subscription_webhook_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."supplier_account_movements" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."supplier_payments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."supplier_purchase_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."supplier_purchases" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."suppliers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "suppliers_delete" ON "public"."suppliers" FOR DELETE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."can_manage"()));



CREATE POLICY "suppliers_insert" ON "public"."suppliers" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "suppliers_select" ON "public"."suppliers" FOR SELECT TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "suppliers_update" ON "public"."suppliers" FOR UPDATE TO "authenticated" USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "swl_admin_read" ON "public"."subscription_webhook_logs" FOR SELECT USING (("business_id" = "public"."current_user_business_id"()));



CREATE POLICY "swl_service" ON "public"."subscription_webhook_logs" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "system_admin_read_leads" ON "public"."contact_leads" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."system_admins" "sa"
  WHERE ("sa"."user_id" = "auth"."uid"()))));



CREATE POLICY "system_admin_update_leads" ON "public"."contact_leads" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."system_admins" "sa"
  WHERE ("sa"."user_id" = "auth"."uid"())))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."system_admins" "sa"
  WHERE ("sa"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."system_admins" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "system_admins_read_own" ON "public"."system_admins" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."task_comments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "task_comments_plan" ON "public"."task_comments" USING ((("business_id" = "public"."current_user_business_id"()) AND "public"."is_staff"() AND "public"."business_has_feature"('tasks'::"text"))) WITH CHECK ((("business_id" = "public"."current_user_business_id"()) AND "public"."is_staff"() AND "public"."business_has_feature"('tasks'::"text")));



ALTER TABLE "public"."task_history" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "task_history_plan" ON "public"."task_history" USING ((("business_id" = "public"."current_user_business_id"()) AND "public"."is_staff"() AND "public"."business_has_feature"('tasks'::"text"))) WITH CHECK ((("business_id" = "public"."current_user_business_id"()) AND "public"."is_staff"() AND "public"."business_has_feature"('tasks'::"text")));



ALTER TABLE "public"."task_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "task_items_plan" ON "public"."task_items" USING ((("business_id" = "public"."current_user_business_id"()) AND "public"."is_staff"() AND "public"."business_has_feature"('tasks'::"text"))) WITH CHECK ((("business_id" = "public"."current_user_business_id"()) AND "public"."is_staff"() AND "public"."business_has_feature"('tasks'::"text")));



ALTER TABLE "public"."tasks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tasks_plan_delete" ON "public"."tasks" FOR DELETE USING ((("business_id" = "public"."current_user_business_id"()) AND "public"."is_staff"() AND "public"."business_has_feature"('tasks'::"text")));



CREATE POLICY "tasks_plan_insert" ON "public"."tasks" FOR INSERT WITH CHECK ((("business_id" = "public"."current_user_business_id"()) AND "public"."is_staff"() AND "public"."business_has_feature"('tasks'::"text")));



CREATE POLICY "tasks_plan_select" ON "public"."tasks" FOR SELECT USING ((("business_id" = "public"."current_user_business_id"()) AND "public"."is_staff"() AND "public"."business_has_feature"('tasks'::"text")));



CREATE POLICY "tasks_plan_update" ON "public"."tasks" FOR UPDATE USING ((("business_id" = "public"."current_user_business_id"()) AND "public"."is_staff"() AND "public"."business_has_feature"('tasks'::"text")));



CREATE POLICY "tenant_isolation" ON "public"."inventory" USING (("business_id" = ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1)));



CREATE POLICY "tenant_isolation_variants" ON "public"."product_variants" USING (("business_id" = ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1)));



ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "users_delete" ON "public"."users" FOR DELETE TO "authenticated" USING (("public"."current_user_role"() = ANY (ARRAY['owner'::"text", 'admin'::"text"])));



CREATE POLICY "users_insert" ON "public"."users" FOR INSERT TO "authenticated" WITH CHECK (("public"."current_user_role"() = ANY (ARRAY['owner'::"text", 'admin'::"text"])));



CREATE POLICY "users_select" ON "public"."users" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "users_update" ON "public"."users" FOR UPDATE TO "authenticated" USING (("public"."current_user_role"() = ANY (ARRAY['owner'::"text", 'admin'::"text"]))) WITH CHECK (("public"."current_user_role"() = ANY (ARRAY['owner'::"text", 'admin'::"text"])));



ALTER TABLE "public"."warranties" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "warranties_delete" ON "public"."warranties" FOR DELETE USING ((("business_id" = "public"."current_business_id"()) AND "public"."can_manage"()));



CREATE POLICY "warranties_insert" ON "public"."warranties" FOR INSERT WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "warranties_select" ON "public"."warranties" FOR SELECT USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "warranties_update" ON "public"."warranties" FOR UPDATE USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



ALTER TABLE "public"."warranty_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "warranty_events_business_access" ON "public"."warranty_events" USING (("business_id" = ( SELECT "warranties"."business_id"
   FROM "public"."warranties"
  WHERE ("warranties"."id" = "warranty_events"."warranty_id")
 LIMIT 1)));



CREATE POLICY "wc_admin" ON "public"."wholesale_customers" USING (("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))));



CREATE POLICY "wc_own_insert" ON "public"."wholesale_customers" FOR INSERT WITH CHECK (("auth_user_id" = "auth"."uid"()));



CREATE POLICY "wc_own_read" ON "public"."wholesale_customers" FOR SELECT USING (("auth_user_id" = "auth"."uid"()));



CREATE POLICY "wc_own_update" ON "public"."wholesale_customers" FOR UPDATE USING (("auth_user_id" = "auth"."uid"()));



ALTER TABLE "public"."whatsapp_automation_settings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "whatsapp_automation_settings_delete" ON "public"."whatsapp_automation_settings" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."business_id" = "whatsapp_automation_settings"."business_id") AND ("profiles"."is_active" = true)))));



CREATE POLICY "whatsapp_automation_settings_insert" ON "public"."whatsapp_automation_settings" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."business_id" = "whatsapp_automation_settings"."business_id") AND ("profiles"."is_active" = true)))));



CREATE POLICY "whatsapp_automation_settings_select" ON "public"."whatsapp_automation_settings" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."business_id" = "whatsapp_automation_settings"."business_id") AND ("profiles"."is_active" = true)))));



CREATE POLICY "whatsapp_automation_settings_update" ON "public"."whatsapp_automation_settings" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."business_id" = "whatsapp_automation_settings"."business_id") AND ("profiles"."is_active" = true))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."business_id" = "whatsapp_automation_settings"."business_id") AND ("profiles"."is_active" = true)))));



ALTER TABLE "public"."whatsapp_connection_credentials" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "whatsapp_connection_credentials_deny_all" ON "public"."whatsapp_connection_credentials" USING (false) WITH CHECK (false);



ALTER TABLE "public"."whatsapp_connection_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "whatsapp_connection_events_select" ON "public"."whatsapp_connection_events" FOR SELECT USING (("business_id" IN ( SELECT "public"."user_business_ids"() AS "user_business_ids")));



ALTER TABLE "public"."whatsapp_connections" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "whatsapp_connections_delete" ON "public"."whatsapp_connections" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."business_id" = "whatsapp_connections"."business_id") AND ("profiles"."is_active" = true)))));



CREATE POLICY "whatsapp_connections_insert" ON "public"."whatsapp_connections" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."business_id" = "whatsapp_connections"."business_id") AND ("profiles"."is_active" = true)))));



CREATE POLICY "whatsapp_connections_select" ON "public"."whatsapp_connections" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."business_id" = "whatsapp_connections"."business_id") AND ("profiles"."is_active" = true)))));



CREATE POLICY "whatsapp_connections_update" ON "public"."whatsapp_connections" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."business_id" = "whatsapp_connections"."business_id") AND ("profiles"."is_active" = true))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."business_id" = "whatsapp_connections"."business_id") AND ("profiles"."is_active" = true)))));



ALTER TABLE "public"."whatsapp_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "whatsapp_logs_insert" ON "public"."whatsapp_logs" FOR INSERT WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "whatsapp_logs_select" ON "public"."whatsapp_logs" FOR SELECT USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



ALTER TABLE "public"."whatsapp_message_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "whatsapp_message_logs_insert" ON "public"."whatsapp_message_logs" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."business_id" = "whatsapp_message_logs"."business_id") AND ("profiles"."is_active" = true)))));



CREATE POLICY "whatsapp_message_logs_select" ON "public"."whatsapp_message_logs" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."business_id" = "whatsapp_message_logs"."business_id") AND ("profiles"."is_active" = true)))));



ALTER TABLE "public"."whatsapp_settings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "whatsapp_settings_delete" ON "public"."whatsapp_settings" FOR DELETE USING (("business_id" IN ( SELECT "public"."user_business_ids"() AS "user_business_ids")));



CREATE POLICY "whatsapp_settings_insert" ON "public"."whatsapp_settings" FOR INSERT WITH CHECK (("business_id" IN ( SELECT "public"."user_business_ids"() AS "user_business_ids")));



CREATE POLICY "whatsapp_settings_select" ON "public"."whatsapp_settings" FOR SELECT USING (("business_id" IN ( SELECT "public"."user_business_ids"() AS "user_business_ids")));



CREATE POLICY "whatsapp_settings_service_role" ON "public"."whatsapp_settings" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "whatsapp_settings_update" ON "public"."whatsapp_settings" FOR UPDATE USING (("business_id" IN ( SELECT "public"."user_business_ids"() AS "user_business_ids"))) WITH CHECK (("business_id" IN ( SELECT "public"."user_business_ids"() AS "user_business_ids")));



ALTER TABLE "public"."whatsapp_templates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "whatsapp_templates_delete" ON "public"."whatsapp_templates" FOR DELETE USING ((("business_id" = "public"."current_business_id"()) AND "public"."can_manage"()));



CREATE POLICY "whatsapp_templates_insert" ON "public"."whatsapp_templates" FOR INSERT WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "whatsapp_templates_select" ON "public"."whatsapp_templates" FOR SELECT USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



CREATE POLICY "whatsapp_templates_update" ON "public"."whatsapp_templates" FOR UPDATE USING ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"())) WITH CHECK ((("business_id" = "public"."current_business_id"()) AND "public"."is_staff"()));



ALTER TABLE "public"."wholesale_customers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."wholesale_order_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."wholesale_orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "wo_admin_plan" ON "public"."wholesale_orders" USING ((("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))) AND "public"."business_has_feature"('mayorista'::"text"))) WITH CHECK ((("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))) AND "public"."business_has_feature"('mayorista'::"text")));



CREATE POLICY "wo_customer_insert" ON "public"."wholesale_orders" FOR INSERT WITH CHECK (("customer_id" IN ( SELECT "wholesale_customers"."id"
   FROM "public"."wholesale_customers"
  WHERE ("wholesale_customers"."auth_user_id" = "auth"."uid"()))));



CREATE POLICY "wo_customer_select" ON "public"."wholesale_orders" FOR SELECT USING (("customer_id" IN ( SELECT "wholesale_customers"."id"
   FROM "public"."wholesale_customers"
  WHERE ("wholesale_customers"."auth_user_id" = "auth"."uid"()))));



CREATE POLICY "woi_admin_plan" ON "public"."wholesale_order_items" USING ((("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))) AND "public"."business_has_feature"('mayorista'::"text"))) WITH CHECK ((("business_id" IN ( SELECT "profiles"."business_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))) AND "public"."business_has_feature"('mayorista'::"text")));



CREATE POLICY "woi_customer_insert" ON "public"."wholesale_order_items" FOR INSERT WITH CHECK (("order_id" IN ( SELECT "o"."id"
   FROM ("public"."wholesale_orders" "o"
     JOIN "public"."wholesale_customers" "c" ON (("c"."id" = "o"."customer_id")))
  WHERE ("c"."auth_user_id" = "auth"."uid"()))));



CREATE POLICY "woi_customer_select" ON "public"."wholesale_order_items" FOR SELECT USING (("order_id" IN ( SELECT "o"."id"
   FROM ("public"."wholesale_orders" "o"
     JOIN "public"."wholesale_customers" "c" ON (("c"."id" = "o"."customer_id")))
  WHERE ("c"."auth_user_id" = "auth"."uid"()))));





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";









REVOKE USAGE ON SCHEMA "public" FROM PUBLIC;
GRANT ALL ON SCHEMA "public" TO PUBLIC;














































































































































































REVOKE ALL ON FUNCTION "public"."_admin_role_weight"("p_role" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."_biz_billing_state"("p_business_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."_feat_full"("p_status" "text", "p_plan" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."_feat_pro"("p_status" "text", "p_plan" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."_require_platform_admin"("p_min_role" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."_require_reason"("p_reason" "text") FROM PUBLIC;



GRANT ALL ON FUNCTION "public"."accept_business_invitation"("p_token" "text") TO "authenticated";



GRANT ALL ON FUNCTION "public"."admin_activate_subscription"("p_business_id" "uuid", "p_plan" "text", "p_reason" "text", "p_period_end" timestamp with time zone, "p_request_id" "text") TO "authenticated";



GRANT ALL ON FUNCTION "public"."admin_cancel_subscription"("p_business_id" "uuid", "p_reason" "text", "p_request_id" "text") TO "authenticated";



GRANT ALL ON FUNCTION "public"."admin_change_subscription_plan"("p_business_id" "uuid", "p_new_plan" "text", "p_reason" "text", "p_request_id" "text") TO "authenticated";



GRANT ALL ON FUNCTION "public"."admin_extend_trial"("p_business_id" "uuid", "p_extra_days" integer, "p_reason" "text", "p_request_id" "text") TO "authenticated";



GRANT ALL ON FUNCTION "public"."admin_grant_legacy_access"("p_business_id" "uuid", "p_plan" "text", "p_reason" "text", "p_expires_at" timestamp with time zone, "p_request_id" "text") TO "authenticated";



GRANT ALL ON FUNCTION "public"."admin_grant_role"("p_user_id" "uuid", "p_role" "text", "p_reason" "text", "p_request_id" "text") TO "authenticated";



GRANT ALL ON FUNCTION "public"."admin_list_subscriptions"("p_query" "text", "p_limit" integer) TO "authenticated";



GRANT ALL ON FUNCTION "public"."admin_revoke_legacy_access"("p_business_id" "uuid", "p_reason" "text", "p_request_id" "text") TO "authenticated";



GRANT ALL ON FUNCTION "public"."admin_revoke_role"("p_user_id" "uuid", "p_reason" "text", "p_request_id" "text") TO "authenticated";



GRANT ALL ON FUNCTION "public"."admin_suspend_subscription"("p_business_id" "uuid", "p_reason" "text", "p_request_id" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."backfill_remito_fm"("p_remito_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."backfill_remito_fm"("p_remito_ids" "uuid"[]) TO "authenticated";



GRANT ALL ON FUNCTION "public"."bootstrap_owner_profile"("p_user_email" "text", "p_business_name" "text", "p_full_name" "text") TO "authenticated";



GRANT ALL ON FUNCTION "public"."business_has_feature"("p_feature" "text") TO "authenticated";



GRANT SELECT ON TABLE "public"."business_invitations" TO "authenticated";



GRANT ALL ON FUNCTION "public"."change_user_role"("p_profile_id" "uuid", "p_new_role" "text") TO "authenticated";



GRANT ALL ON FUNCTION "public"."check_user_limit_before_invite"("p_business_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "public"."create_business_invitation"("p_email" "text", "p_role" "text", "p_business_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."create_credit_note_finance_reversal"("p_nc_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_credit_note_finance_reversal"("p_nc_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."create_credit_note_from_comprobante"("p_comprobante_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_credit_note_from_comprobante"("p_comprobante_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "public"."create_default_payment_buttons"("p_business_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "public"."current_platform_admin_role"() TO "authenticated";



GRANT ALL ON FUNCTION "public"."current_user_business_id"() TO "authenticated";



GRANT ALL ON FUNCTION "public"."current_user_role"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."customer_purchase_history"("p_customer_id" "uuid", "p_business_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."customer_purchase_history"("p_customer_id" "uuid", "p_business_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "public"."decrypt_data"("encrypted_data" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."delete_comprobante_with_finance"("p_comprobante_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_comprobante_with_finance"("p_comprobante_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "public"."encrypt_data"("data_to_encrypt" "text") TO "authenticated";



GRANT ALL ON FUNCTION "public"."ensure_brand_and_model"("p_brand_name" "text", "p_model_name" "text", "p_business_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."finance_health_check"("p_business_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."finance_health_check"("p_business_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "public"."generar_numero_comprobante"("p_tipo" "text", "p_business_id" "uuid", "p_punto_venta" "text") TO "authenticated";



GRANT ALL ON FUNCTION "public"."generar_numero_garantia"("p_business_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."generar_numero_garantia"("p_business_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_active_sales_point"("p_business_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "public"."get_business_settings"() TO "authenticated";



GRANT ALL ON FUNCTION "public"."get_business_subscription_features"("p_business_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "public"."get_current_exchange_rate"("p_base_currency" "text", "p_target_currency" "text") TO "authenticated";



GRANT ALL ON FUNCTION "public"."get_finance_summary"("p_business_id" "uuid", "p_from" "date", "p_to" "date") TO "authenticated";



GRANT ALL ON FUNCTION "public"."get_my_profile"() TO "authenticated";



GRANT ALL ON FUNCTION "public"."get_or_create_brand"("p_name" "text", "p_business_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "public"."get_or_create_model"("p_name" "text", "p_brand_id" "uuid", "p_business_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "public"."is_platform_admin"("p_user_id" "uuid", "p_min_role" "text") TO "authenticated";



GRANT ALL ON FUNCTION "public"."link_profile_to_auth_user"() TO "authenticated";



GRANT ALL ON FUNCTION "public"."preview_missing_stock_movements"("p_business_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "public"."process_mp_subscription_payment"("p_external_ref" "text", "p_mp_payment_id" "text", "p_mp_status" "text", "p_amount" numeric, "p_currency" "text", "p_raw_payload" "jsonb") TO "service_role";
GRANT ALL ON FUNCTION "public"."process_mp_subscription_payment"("p_external_ref" "text", "p_mp_payment_id" "text", "p_mp_status" "text", "p_amount" numeric, "p_currency" "text", "p_raw_payload" "jsonb") TO "authenticated";



GRANT ALL ON FUNCTION "public"."recalculate_product_prices"("p_business_id" "uuid", "p_new_rate" numeric) TO "authenticated";



GRANT ALL ON FUNCTION "public"."repair_missing_stock_movements"("p_business_id" "uuid", "p_allow_negative" boolean) TO "authenticated";



GRANT ALL ON FUNCTION "public"."set_user_active_status"("p_profile_id" "uuid", "p_is_active" boolean) TO "authenticated";



GRANT ALL ON FUNCTION "public"."sync_bfe_to_financial_movements"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_bfe_to_financial_movements"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";



GRANT ALL ON FUNCTION "public"."upsert_business_settings"("p_business_id" "uuid", "p_default_currency" "text", "p_show_usd_price" boolean, "p_auto_update_rate" boolean, "p_rate_api_url" "text", "p_rate_update_frequency_hours" integer) TO "authenticated";



GRANT ALL ON FUNCTION "public"."upsert_exchange_rate"("p_business_id" "uuid", "p_base_currency" "text", "p_target_currency" "text", "p_rate" numeric, "p_is_manual" boolean, "p_source" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."whatsapp_admin_provision_connection"("p_business_id" "uuid", "p_phone_number_id" "text", "p_waba_id" "text", "p_access_token" "text", "p_reason" "text", "p_system_user_id" "text", "p_token_expires_at" timestamp with time zone, "p_business_phone_number" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."whatsapp_admin_provision_connection"("p_business_id" "uuid", "p_phone_number_id" "text", "p_waba_id" "text", "p_access_token" "text", "p_reason" "text", "p_system_user_id" "text", "p_token_expires_at" timestamp with time zone, "p_business_phone_number" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."whatsapp_admin_record_event"("p_business_id" "uuid", "p_event_type" "text", "p_reason" "text", "p_connection_id" "uuid", "p_metadata" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."whatsapp_admin_record_event"("p_business_id" "uuid", "p_event_type" "text", "p_reason" "text", "p_connection_id" "uuid", "p_metadata" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."whatsapp_admin_revoke_connection"("p_business_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."whatsapp_admin_revoke_connection"("p_business_id" "uuid", "p_reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."whatsapp_connection_events_block_mutation"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."whatsapp_credential_delete"("p_connection_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."whatsapp_credential_delete"("p_connection_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."whatsapp_credential_get_token"("p_connection_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."whatsapp_credential_get_token"("p_connection_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."whatsapp_credential_purge_vault"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."whatsapp_credential_store"("p_connection_id" "uuid", "p_token" "text", "p_expires_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."whatsapp_credential_store"("p_connection_id" "uuid", "p_token" "text", "p_expires_at" timestamp with time zone) TO "service_role";
























GRANT ALL ON TABLE "public"."account_movements" TO "authenticated";



GRANT ALL ON TABLE "public"."accounts" TO "authenticated";



GRANT ALL ON TABLE "public"."arca_config" TO "authenticated";
GRANT ALL ON TABLE "public"."arca_config" TO "anon";
GRANT ALL ON TABLE "public"."arca_config" TO "service_role";



GRANT ALL ON TABLE "public"."arca_parametros" TO "authenticated";
GRANT ALL ON TABLE "public"."arca_parametros" TO "anon";
GRANT ALL ON TABLE "public"."arca_parametros" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."brands" TO "authenticated";
GRANT SELECT ON TABLE "public"."brands" TO "anon";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."business_finance_entries" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."business_settings" TO "authenticated";



GRANT SELECT ON TABLE "public"."profiles" TO "authenticated";
GRANT SELECT ON TABLE "public"."profiles" TO "service_role";
GRANT SELECT ON TABLE "public"."profiles" TO "anon";



GRANT SELECT ON TABLE "public"."business_users_view" TO "authenticated";
GRANT SELECT ON TABLE "public"."business_users_view" TO "service_role";



GRANT SELECT ON TABLE "public"."businesses" TO "authenticated";
GRANT SELECT ON TABLE "public"."businesses" TO "anon";
GRANT SELECT ON TABLE "public"."businesses" TO "service_role";



GRANT UPDATE("updated_at") ON TABLE "public"."businesses" TO "service_role";



GRANT UPDATE("subscription_status") ON TABLE "public"."businesses" TO "service_role";



GRANT UPDATE("subscription_plan") ON TABLE "public"."businesses" TO "service_role";



GRANT UPDATE("subscription_provider") ON TABLE "public"."businesses" TO "service_role";



GRANT UPDATE("mp_preapproval_id") ON TABLE "public"."businesses" TO "service_role";



GRANT UPDATE("mp_preapproval_plan_id") ON TABLE "public"."businesses" TO "service_role";



GRANT UPDATE("mp_payer_email") ON TABLE "public"."businesses" TO "service_role";



GRANT UPDATE("current_period_start") ON TABLE "public"."businesses" TO "service_role";



GRANT UPDATE("current_period_end") ON TABLE "public"."businesses" TO "service_role";



GRANT UPDATE("grace_until") ON TABLE "public"."businesses" TO "service_role";



GRANT UPDATE("last_payment_id") ON TABLE "public"."businesses" TO "service_role";



GRANT UPDATE("last_payment_status") ON TABLE "public"."businesses" TO "service_role";



GRANT UPDATE("last_webhook_at") ON TABLE "public"."businesses" TO "service_role";



GRANT UPDATE("access_source") ON TABLE "public"."businesses" TO "service_role";



GRANT UPDATE("mp_last_modified") ON TABLE "public"."businesses" TO "service_role";



GRANT ALL ON TABLE "public"."cajas" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."cash_registers" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."clic_wholesale_product_settings" TO "authenticated";
GRANT SELECT ON TABLE "public"."clic_wholesale_product_settings" TO "anon";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."comprobante_items" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."comprobante_payments" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."comprobantes" TO "authenticated";



GRANT SELECT,INSERT ON TABLE "public"."customer_events" TO "authenticated";



GRANT ALL ON TABLE "public"."customers" TO "anon";
GRANT ALL ON TABLE "public"."customers" TO "authenticated";



GRANT ALL ON TABLE "public"."device_inspections" TO "anon";
GRANT ALL ON TABLE "public"."device_inspections" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."device_models" TO "authenticated";
GRANT SELECT ON TABLE "public"."device_models" TO "anon";



GRANT ALL ON TABLE "public"."devices" TO "anon";
GRANT ALL ON TABLE "public"."devices" TO "authenticated";



GRANT ALL ON TABLE "public"."documents" TO "anon";
GRANT ALL ON TABLE "public"."documents" TO "authenticated";



GRANT SELECT,INSERT ON TABLE "public"."dollar_rate_history" TO "authenticated";
GRANT SELECT ON TABLE "public"."dollar_rate_history" TO "anon";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."exchange_rates" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."expense_categories" TO "authenticated";
GRANT SELECT ON TABLE "public"."expense_categories" TO "anon";



GRANT ALL ON TABLE "public"."expenses" TO "anon";
GRANT ALL ON TABLE "public"."expenses" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."financial_movements" TO "authenticated";



GRANT ALL ON TABLE "public"."inventory" TO "anon";
GRANT ALL ON TABLE "public"."inventory" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."inventory_movements" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."inventory_valuation_history" TO "authenticated";



GRANT ALL ON TABLE "public"."mp_accounts" TO "service_role";
GRANT ALL ON TABLE "public"."mp_accounts" TO "authenticated";



GRANT ALL ON TABLE "public"."notes" TO "anon";
GRANT ALL ON TABLE "public"."notes" TO "authenticated";



GRANT ALL ON TABLE "public"."notifications" TO "anon";
GRANT ALL ON TABLE "public"."notifications" TO "authenticated";



GRANT ALL ON TABLE "public"."order_checklists" TO "anon";
GRANT ALL ON TABLE "public"."order_checklists" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."order_items" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."order_items" TO "anon";



GRANT ALL ON TABLE "public"."order_parts" TO "anon";
GRANT ALL ON TABLE "public"."order_parts" TO "authenticated";



GRANT ALL ON TABLE "public"."order_payments" TO "anon";
GRANT ALL ON TABLE "public"."order_payments" TO "authenticated";



GRANT ALL ON TABLE "public"."orders" TO "anon";
GRANT ALL ON TABLE "public"."orders" TO "authenticated";



GRANT ALL ON TABLE "public"."parts_used" TO "anon";
GRANT ALL ON TABLE "public"."parts_used" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."payment_commission_groups" TO "authenticated";
GRANT SELECT ON TABLE "public"."payment_commission_groups" TO "anon";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."payment_commission_options" TO "authenticated";
GRANT SELECT ON TABLE "public"."payment_commission_options" TO "anon";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."payment_method_buttons" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."payment_method_buttons" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."payment_orders" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."payment_orders" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."payment_transactions" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."payment_transactions" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."payment_webhook_events" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."payment_webhook_events" TO "service_role";



GRANT SELECT ON TABLE "public"."payments" TO "authenticated";
GRANT ALL ON TABLE "public"."payments" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."personal_account_balances" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."personal_accounts" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."personal_budgets" TO "authenticated";



GRANT ALL ON TABLE "public"."personal_card_payments" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."personal_card_purchases" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."personal_categories" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."personal_credit_cards" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."personal_debt_payments" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."personal_debts" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."personal_recurring_expense_payments" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."personal_recurring_expenses" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."personal_savings_goals" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."personal_transactions" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."product_offers" TO "authenticated";
GRANT SELECT ON TABLE "public"."product_offers" TO "anon";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."purchase_items" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."purchases" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."recurring_expenses" TO "authenticated";
GRANT SELECT ON TABLE "public"."recurring_expenses" TO "anon";



GRANT ALL ON TABLE "public"."sales_points" TO "authenticated";
GRANT ALL ON TABLE "public"."sales_points" TO "anon";
GRANT ALL ON TABLE "public"."sales_points" TO "service_role";



GRANT ALL ON TABLE "public"."status_history" TO "anon";
GRANT ALL ON TABLE "public"."status_history" TO "authenticated";



GRANT SELECT ON TABLE "public"."subscription_checkout_sessions" TO "service_role";



GRANT UPDATE("status") ON TABLE "public"."subscription_checkout_sessions" TO "service_role";



GRANT UPDATE("updated_at") ON TABLE "public"."subscription_checkout_sessions" TO "service_role";



GRANT SELECT ON TABLE "public"."subscription_events" TO "authenticated";
GRANT ALL ON TABLE "public"."subscription_events" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."supplier_account_movements" TO "authenticated";
GRANT SELECT ON TABLE "public"."supplier_account_movements" TO "anon";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."supplier_payments" TO "authenticated";
GRANT SELECT ON TABLE "public"."supplier_payments" TO "anon";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."supplier_purchase_items" TO "authenticated";
GRANT SELECT ON TABLE "public"."supplier_purchase_items" TO "anon";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."supplier_purchases" TO "authenticated";
GRANT SELECT ON TABLE "public"."supplier_purchases" TO "anon";



GRANT ALL ON TABLE "public"."suppliers" TO "anon";
GRANT ALL ON TABLE "public"."suppliers" TO "authenticated";



GRANT SELECT ON TABLE "public"."system_admins" TO "authenticated";



GRANT ALL ON TABLE "public"."task_comments" TO "authenticated";



GRANT ALL ON TABLE "public"."task_history" TO "authenticated";



GRANT ALL ON TABLE "public"."task_items" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."tasks" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."tasks" TO "anon";



GRANT ALL ON TABLE "public"."users" TO "anon";
GRANT ALL ON TABLE "public"."users" TO "authenticated";



GRANT SELECT ON TABLE "public"."v_subscription_overview" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."warranties" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."warranties" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."warranties" TO "service_role";



GRANT SELECT ON TABLE "public"."whatsapp_connection_events" TO "authenticated";



GRANT SELECT,INSERT,UPDATE ON TABLE "public"."whatsapp_connections" TO "authenticated";



GRANT SELECT,INSERT,UPDATE ON TABLE "public"."whatsapp_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."whatsapp_logs" TO "service_role";



GRANT SELECT,INSERT ON TABLE "public"."whatsapp_message_logs" TO "authenticated";



GRANT ALL ON TABLE "public"."whatsapp_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."whatsapp_settings" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."whatsapp_templates" TO "authenticated";



GRANT SELECT,INSERT,UPDATE ON TABLE "public"."wholesale_customers" TO "authenticated";



GRANT SELECT,INSERT,UPDATE ON TABLE "public"."wholesale_order_items" TO "authenticated";



GRANT SELECT,INSERT,UPDATE ON TABLE "public"."wholesale_orders" TO "authenticated";








































-- ============================================================================
-- Managed application objects (appended 2026-06-28 to the remote baseline)
-- Purpose: reproduce PRODUCTION table/column ACLs, default privileges and Storage
-- EXACTLY so local/Preview branches are not broader than prod. No table data, no
-- secrets, no stored files.
-- ============================================================================

-- A. Table ACLs: reset app-role grants, then reapply production's exact set.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated, service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.account_movements TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.accounts TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.arca_config TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.arca_config TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.arca_config TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.arca_parametros TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.arca_parametros TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.arca_parametros TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.cajas TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.customers TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.customers TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.device_inspections TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.device_inspections TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.devices TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.devices TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.documents TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.documents TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.expenses TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.expenses TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.inventory TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.inventory TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.mp_accounts TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.mp_accounts TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.notes TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.notes TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.notifications TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.notifications TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.order_checklists TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.order_checklists TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.order_parts TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.order_parts TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.order_payments TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.order_payments TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.orders TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.orders TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.parts_used TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.parts_used TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.payments TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.personal_card_payments TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.sales_points TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.sales_points TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.sales_points TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.status_history TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.status_history TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.subscription_events TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.suppliers TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.suppliers TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.task_comments TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.task_history TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.task_items TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.users TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.users TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.whatsapp_logs TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.whatsapp_settings TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.whatsapp_settings TO service_role;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.brands TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.business_finance_entries TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.business_settings TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.cash_registers TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.clic_wholesale_product_settings TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.comprobante_items TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.comprobante_payments TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.comprobantes TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.device_models TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.exchange_rates TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.expense_categories TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.financial_movements TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.inventory_movements TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.inventory_valuation_history TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.order_items TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.order_items TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.payment_commission_groups TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.payment_commission_options TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.payment_method_buttons TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.payment_method_buttons TO service_role;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.payment_orders TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.payment_orders TO service_role;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.payment_transactions TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.payment_transactions TO service_role;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.payment_webhook_events TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.payment_webhook_events TO service_role;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.personal_account_balances TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.personal_accounts TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.personal_budgets TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.personal_card_purchases TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.personal_categories TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.personal_credit_cards TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.personal_debt_payments TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.personal_debts TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.personal_recurring_expense_payments TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.personal_recurring_expenses TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.personal_savings_goals TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.personal_transactions TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.product_offers TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.purchase_items TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.purchases TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.recurring_expenses TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.supplier_account_movements TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.supplier_payments TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.supplier_purchase_items TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.supplier_purchases TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.tasks TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.tasks TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.warranties TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.warranties TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.warranties TO service_role;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.whatsapp_templates TO authenticated;
GRANT INSERT, SELECT ON TABLE public.customer_events TO authenticated;
GRANT INSERT, SELECT ON TABLE public.dollar_rate_history TO authenticated;
GRANT INSERT, SELECT ON TABLE public.whatsapp_message_logs TO authenticated;
GRANT INSERT, SELECT, UPDATE ON TABLE public.whatsapp_connections TO authenticated;
GRANT INSERT, SELECT, UPDATE ON TABLE public.whatsapp_logs TO authenticated;
GRANT INSERT, SELECT, UPDATE ON TABLE public.wholesale_customers TO authenticated;
GRANT INSERT, SELECT, UPDATE ON TABLE public.wholesale_order_items TO authenticated;
GRANT INSERT, SELECT, UPDATE ON TABLE public.wholesale_orders TO authenticated;
GRANT SELECT ON TABLE public.brands TO anon;
GRANT SELECT ON TABLE public.business_invitations TO authenticated;
GRANT SELECT ON TABLE public.business_users_view TO authenticated;
GRANT SELECT ON TABLE public.business_users_view TO service_role;
GRANT SELECT ON TABLE public.businesses TO anon;
GRANT SELECT ON TABLE public.businesses TO authenticated;
GRANT SELECT ON TABLE public.businesses TO service_role;
GRANT SELECT ON TABLE public.clic_wholesale_product_settings TO anon;
GRANT SELECT ON TABLE public.device_models TO anon;
GRANT SELECT ON TABLE public.dollar_rate_history TO anon;
GRANT SELECT ON TABLE public.expense_categories TO anon;
GRANT SELECT ON TABLE public.payment_commission_groups TO anon;
GRANT SELECT ON TABLE public.payment_commission_options TO anon;
GRANT SELECT ON TABLE public.payments TO authenticated;
GRANT SELECT ON TABLE public.product_offers TO anon;
GRANT SELECT ON TABLE public.profiles TO anon;
GRANT SELECT ON TABLE public.profiles TO authenticated;
GRANT SELECT ON TABLE public.profiles TO service_role;
GRANT SELECT ON TABLE public.recurring_expenses TO anon;
GRANT SELECT ON TABLE public.subscription_checkout_sessions TO service_role;
GRANT SELECT ON TABLE public.subscription_events TO authenticated;
GRANT SELECT ON TABLE public.supplier_account_movements TO anon;
GRANT SELECT ON TABLE public.supplier_payments TO anon;
GRANT SELECT ON TABLE public.supplier_purchase_items TO anon;
GRANT SELECT ON TABLE public.supplier_purchases TO anon;
GRANT SELECT ON TABLE public.system_admins TO authenticated;
GRANT SELECT ON TABLE public.v_subscription_overview TO authenticated;
GRANT SELECT ON TABLE public.whatsapp_connection_events TO authenticated;

-- Column-level grants (production has these; REVOKE ALL above removes them, so reapply):
GRANT UPDATE (access_source, current_period_end, current_period_start, grace_until, last_payment_id, last_payment_status, last_webhook_at, mp_last_modified, mp_payer_email, mp_preapproval_id, mp_preapproval_plan_id, subscription_plan, subscription_provider, subscription_status, updated_at) ON TABLE public.businesses TO service_role;
GRANT UPDATE (status, updated_at) ON TABLE public.subscription_checkout_sessions TO service_role;

-- Function EXECUTE: the 20 sensitive RPCs (admin/billing/Vault/WhatsApp) already match
-- production exactly (PUBLIC revoked; postgres / authenticated / service_role only) and are
-- left untouched. The pg_trgm extension functions carry an extra explicit anon/authenticated/
-- service_role EXECUTE in the LOCAL stack image -- BUT those grants are owned by
-- supabase_admin (its default ACL at extension install), so the migration runner (postgres)
-- cannot revoke them without SET ROLE supabase_admin / GRANTED BY supabase_admin, which is
-- intentionally out of scope (do not touch the supabase_admin internal role). They are
-- PUBLIC-equivalent in production (PUBLIC also has EXECUTE), so there is no real privilege
-- escalation. Documented as a local-image platform artifact; not normalized here.

-- B. Default privileges: match production (which has NO default ACL on public). The local
-- image grants app roles on future objects created by postgres (the migration runner);
-- neutralize so future migrations do not silently widen access. supabase_admin's local-image
-- defaults are intentionally NOT modified (internal role; app migrations create tables as postgres).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;

-- C. Storage: bucket definitions + RLS policies (no files, no stored objects).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types, avif_autodetection, type) VALUES
  ('business-assets','business-assets', true, NULL, NULL, false, 'STANDARD'::storage.buckettype),
  ('clic-wholesale-products','clic-wholesale-products', true, 10485760, ARRAY['image/jpeg','image/png','image/webp'], false, 'STANDARD'::storage.buckettype),
  ('documents','documents', false, NULL, NULL, false, 'STANDARD'::storage.buckettype),
  ('portal-images','portal-images', true, 5242880, ARRAY['image/jpeg','image/png','image/webp','image/gif'], false, 'STANDARD'::storage.buckettype)
ON CONFLICT (id) DO UPDATE SET
  name               = EXCLUDED.name,
  public             = EXCLUDED.public,
  file_size_limit    = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types,
  avif_autodetection = EXCLUDED.avif_autodetection,
  type               = EXCLUDED.type;

-- Storage RLS policies (exact copy of production; PERMISSIVE; bucket business-assets only).
DROP POLICY IF EXISTS "Public read business assets" ON storage.objects;
CREATE POLICY "Public read business assets" ON storage.objects AS PERMISSIVE
  FOR SELECT TO public
  USING (bucket_id = 'business-assets');
DROP POLICY IF EXISTS "Authenticated users can upload business assets" ON storage.objects;
CREATE POLICY "Authenticated users can upload business assets" ON storage.objects AS PERMISSIVE
  FOR INSERT TO authenticated
  WITH CHECK ((bucket_id = 'business-assets') AND (auth.uid() IN (SELECT p.user_id FROM public.profiles p WHERE (COALESCE(p.user_id, p.id) = auth.uid()))));
DROP POLICY IF EXISTS "Authenticated users can update business assets" ON storage.objects;
CREATE POLICY "Authenticated users can update business assets" ON storage.objects AS PERMISSIVE
  FOR UPDATE TO authenticated
  USING ((bucket_id = 'business-assets') AND (auth.uid() IN (SELECT p.user_id FROM public.profiles p WHERE (COALESCE(p.user_id, p.id) = auth.uid()))));
DROP POLICY IF EXISTS "Authenticated users can delete business assets" ON storage.objects;
CREATE POLICY "Authenticated users can delete business assets" ON storage.objects AS PERMISSIVE
  FOR DELETE TO authenticated
  USING ((bucket_id = 'business-assets') AND (auth.uid() IN (SELECT p.user_id FROM public.profiles p WHERE (COALESCE(p.user_id, p.id) = auth.uid()))));

-- D. pg_cron jobs -- DOCUMENTED ONLY (NOT auto-created here). Production runs two daily
-- billing jobs; they are intentionally NOT scheduled by this baseline so local/Preview
-- branches never execute billing automatically. To enable them explicitly in a real
-- environment (idempotent; cron.schedule upserts by job name):
--   SELECT cron.schedule('billing-expire-trials', '0 3 * * *', $$SELECT public.expire_trials();$$);
--   SELECT cron.schedule('billing-enforce-grace', '5 3 * * *', $$SELECT public.enforce_grace_period();$$);
