-- Pre-beta cleanup · canonical profile identity for order amounts.
-- Run against the local stack after applying migration 20260828120000.
-- Every fixture and temporary mutation is rolled back.
\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert(p_condition boolean, p_label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_condition IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_label;
  END IF;
  RAISE NOTICE 'PASS: %', p_label;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.act_as(p_user_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_user_id IS NULL THEN
    PERFORM set_config('request.jwt.claims', '', true);
  ELSE
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object('sub', p_user_id::text, 'role', 'authenticated')::text,
      true
    );
  END IF;
END;
$$;

DO $$
DECLARE
  v_owner_a uuid := gen_random_uuid();
  v_owner_b uuid := gen_random_uuid();
  v_legacy_sales uuid := gen_random_uuid();
  v_new_cashier uuid := gen_random_uuid();
  v_tech uuid := gen_random_uuid();
  v_viewer uuid := gen_random_uuid();
  v_inactive_sales uuid := gen_random_uuid();
  v_business_a uuid;
  v_business_b uuid;
BEGIN
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    (v_owner_a, 'amount-owner-a@invalid.test', now()),
    (v_owner_b, 'amount-owner-b@invalid.test', now()),
    (v_legacy_sales, 'amount-legacy-sales@invalid.test', now()),
    (v_new_cashier, 'amount-new-cashier@invalid.test', now()),
    (v_tech, 'amount-tech@invalid.test', now()),
    (v_viewer, 'amount-viewer@invalid.test', now()),
    (v_inactive_sales, 'amount-inactive@invalid.test', now());

  INSERT INTO public.businesses (name, owner_user_id)
  VALUES ('Order amounts A', v_owner_a)
  RETURNING id INTO v_business_a;

  INSERT INTO public.businesses (name, owner_user_id)
  VALUES ('Order amounts B', v_owner_b)
  RETURNING id INTO v_business_b;

  -- Legacy profile: both identity columns populated.
  INSERT INTO public.profiles (id, business_id, user_id, role, is_active, email) VALUES
    (v_legacy_sales, v_business_a, v_legacy_sales, 'sales', true, 'amount-legacy-sales@invalid.test');

  -- Current invitation shape: id is canonical and user_id remains NULL.
  INSERT INTO public.profiles (id, business_id, role, is_active, email) VALUES
    (v_owner_a, v_business_a, 'owner', true, 'amount-owner-a@invalid.test'),
    (v_owner_b, v_business_b, 'owner', true, 'amount-owner-b@invalid.test'),
    (v_new_cashier, v_business_a, 'cashier', true, 'amount-new-cashier@invalid.test'),
    (v_tech, v_business_a, 'tech', true, 'amount-tech@invalid.test'),
    (v_viewer, v_business_a, 'viewer', true, 'amount-viewer@invalid.test'),
    (v_inactive_sales, v_business_a, 'sales', false, 'amount-inactive@invalid.test');

  PERFORM set_config('test.amount.owner_a', v_owner_a::text, false);
  PERFORM set_config('test.amount.owner_b', v_owner_b::text, false);
  PERFORM set_config('test.amount.legacy_sales', v_legacy_sales::text, false);
  PERFORM set_config('test.amount.new_cashier', v_new_cashier::text, false);
  PERFORM set_config('test.amount.tech', v_tech::text, false);
  PERFORM set_config('test.amount.viewer', v_viewer::text, false);
  PERFORM set_config('test.amount.inactive', v_inactive_sales::text, false);
  PERFORM set_config('test.amount.business_a', v_business_a::text, false);
  PERFORM set_config('test.amount.business_b', v_business_b::text, false);
END;
$$;

-- Legacy identity continues to work under authenticated auth context.
DO $$
DECLARE v_allowed boolean;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.act_as(current_setting('test.amount.legacy_sales')::uuid);
  SELECT public.user_can_view_order_amounts(
    current_setting('test.amount.business_a')::uuid, auth.uid()
  ) INTO v_allowed;
  RESET ROLE;
  PERFORM pg_temp.assert(v_allowed, 'legacy sales with id=user_id=auth.uid() remains allowed');
END;
$$;

-- Canonical invited identity is accepted by both the helper and its main caller.
DO $$
DECLARE v_allowed boolean; v_response jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.act_as(current_setting('test.amount.new_cashier')::uuid);
  SELECT public.user_can_view_order_amounts(
    current_setting('test.amount.business_a')::uuid, auth.uid()
  ) INTO v_allowed;
  v_response := public.get_order_financial_amounts(
    current_setting('test.amount.business_a')::uuid, ARRAY[]::uuid[]
  );
  RESET ROLE;

  PERFORM pg_temp.assert(v_allowed, 'cashier with user_id NULL and id=auth.uid() is allowed');
  PERFORM pg_temp.assert(
    (v_response->>'ok')::boolean
    AND (v_response->>'authorized')::boolean
    AND jsonb_array_length(v_response->'rows') = 0,
    'main amounts caller reaches authorized=true for canonical cashier identity'
  );
END;
$$;

-- Denied roles, inactive users and cross-tenant actors remain fail-closed.
DO $$
DECLARE
  v_tech boolean;
  v_viewer boolean;
  v_inactive boolean;
  v_owner boolean;
  v_cross boolean;
BEGIN
  SET LOCAL ROLE authenticated;

  PERFORM pg_temp.act_as(current_setting('test.amount.tech')::uuid);
  v_tech := public.user_can_view_order_amounts(
    current_setting('test.amount.business_a')::uuid, auth.uid());

  PERFORM pg_temp.act_as(current_setting('test.amount.viewer')::uuid);
  v_viewer := public.user_can_view_order_amounts(
    current_setting('test.amount.business_a')::uuid, auth.uid());

  PERFORM pg_temp.act_as(current_setting('test.amount.inactive')::uuid);
  v_inactive := public.user_can_view_order_amounts(
    current_setting('test.amount.business_a')::uuid, auth.uid());

  PERFORM pg_temp.act_as(current_setting('test.amount.owner_a')::uuid);
  v_owner := public.user_can_view_order_amounts(
    current_setting('test.amount.business_a')::uuid, auth.uid());

  PERFORM pg_temp.act_as(current_setting('test.amount.owner_b')::uuid);
  v_cross := public.user_can_view_order_amounts(
    current_setting('test.amount.business_a')::uuid, auth.uid());

  RESET ROLE;
  PERFORM pg_temp.assert(v_tech IS FALSE, 'tech remains denied');
  PERFORM pg_temp.assert(v_viewer IS FALSE, 'viewer remains denied');
  PERFORM pg_temp.assert(v_inactive IS FALSE, 'inactive sales remains denied');
  PERFORM pg_temp.assert(v_owner IS TRUE, 'owner remains allowed');
  PERFORM pg_temp.assert(v_cross IS FALSE, 'cross-tenant owner remains denied');
END;
$$;

-- No auth session means auth.uid() is NULL and the function returns false.
DO $$
DECLARE v_allowed boolean;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.act_as(NULL);
  SELECT public.user_can_view_order_amounts(
    current_setting('test.amount.business_a')::uuid, auth.uid()
  ) INTO v_allowed;
  RESET ROLE;
  PERFORM pg_temp.assert(v_allowed IS FALSE, 'missing auth session remains denied');
END;
$$;

-- Security contract is unchanged.
SELECT pg_temp.assert(
  p.prosecdef AND p.provolatile = 's'
  AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[],
  'helper remains STABLE SECURITY DEFINER with hardened search_path'
)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'user_can_view_order_amounts'
  AND pg_get_function_identity_arguments(p.oid) = 'p_business_id uuid, p_user_id uuid';

SELECT pg_temp.assert(
  has_function_privilege('authenticated', 'public.user_can_view_order_amounts(uuid,uuid)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.user_can_view_order_amounts(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.user_can_view_order_amounts(uuid,uuid)', 'EXECUTE'),
  'helper grants remain authenticated/service_role only'
);

-- Negative gate: temporarily restore the buggy raw user_id lookup. The new
-- profile must be denied, proving this suite detects the regression.
CREATE OR REPLACE FUNCTION public.user_can_view_order_amounts(
  p_business_id uuid,
  p_user_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT
    p_business_id IS NOT NULL AND p_user_id IS NOT NULL
    AND (
      EXISTS (SELECT 1 FROM public.businesses
               WHERE id = p_business_id AND owner_user_id = p_user_id)
      OR EXISTS (
        SELECT 1 FROM public.profiles
         WHERE business_id = p_business_id
           AND user_id = p_user_id
           AND COALESCE(is_active, true) = true
           AND role IN ('owner', 'admin', 'manager', 'cashier', 'sales')
      )
    );
$$;

SELECT pg_temp.assert(
  public.user_can_view_order_amounts(
    current_setting('test.amount.business_a')::uuid,
    current_setting('test.amount.new_cashier')::uuid
  ) IS FALSE,
  'negative gate catches raw user_id regression for canonical cashier profile'
);

-- Restore the fixed definition immediately; do not leave the mutation active.
CREATE OR REPLACE FUNCTION public.user_can_view_order_amounts(
  p_business_id uuid,
  p_user_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT
    p_business_id IS NOT NULL AND p_user_id IS NOT NULL
    AND (
      EXISTS (SELECT 1 FROM public.businesses
               WHERE id = p_business_id AND owner_user_id = p_user_id)
      OR EXISTS (
        SELECT 1 FROM public.profiles
         WHERE business_id = p_business_id
           AND COALESCE(user_id, id) = p_user_id
           AND COALESCE(is_active, true) = true
           AND role IN ('owner', 'admin', 'manager', 'cashier', 'sales')
      )
    );
$$;

SELECT pg_temp.assert(
  public.user_can_view_order_amounts(
    current_setting('test.amount.business_a')::uuid,
    current_setting('test.amount.new_cashier')::uuid
  ) IS TRUE,
  'fixed canonical identity is restored after negative gate'
);

ROLLBACK;
