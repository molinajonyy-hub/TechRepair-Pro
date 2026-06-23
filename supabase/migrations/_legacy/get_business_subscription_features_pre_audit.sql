-- ============================================================================
-- VERBATIM snapshot of public.get_business_subscription_features captured from
-- production (project vrdxxmjzxhfgqlnxmbwx) during the 2026-06-23 billing audit,
-- BEFORE migration 20260623_101 was authored.
--
-- This is the ROLLBACK target for that migration. It is NOT applied automatically.
-- Notes on why it was changed:
--   * It omitted the `personal_finance` (Mi Guita) key.
--   * `mayorista` granted access on trial but not on Pro (inconsistent).
--   * It was SECURITY DEFINER with NO `search_path` (injection risk).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_business_subscription_features(p_business_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT jsonb_build_object(
    'plan_id',         COALESCE(b.subscription_plan, 'basico'),
    'status',          COALESCE(b.subscription_status, 'trialing'),
    'max_users',       CASE
                         WHEN b.subscription_status = 'trialing'    THEN 3
                         WHEN b.subscription_plan   = 'full'        THEN 10
                         WHEN b.subscription_plan   = 'pro'         THEN 3
                         ELSE 1
                       END,
    'arca',            CASE
                         WHEN b.subscription_status IN ('suspended','canceled') THEN false
                         WHEN b.subscription_status = 'trialing'               THEN true
                         WHEN b.subscription_plan   IN ('pro','full')          THEN true
                         ELSE false
                       END,
    'currentAccounts', CASE
                         WHEN b.subscription_status IN ('suspended','canceled') THEN false
                         WHEN b.subscription_status = 'trialing'               THEN true
                         WHEN b.subscription_plan   IN ('pro','full')          THEN true
                         ELSE false
                       END,
    'reports',         CASE
                         WHEN b.subscription_status IN ('suspended','canceled') THEN false
                         WHEN b.subscription_status = 'trialing'               THEN true
                         WHEN b.subscription_plan   IN ('pro','full')          THEN true
                         ELSE false
                       END,
    'advancedFinance', CASE
                         WHEN b.subscription_status IN ('suspended','canceled') THEN false
                         WHEN b.subscription_status = 'trialing'               THEN true
                         WHEN b.subscription_plan   IN ('pro','full')          THEN true
                         ELSE false
                       END,
    'tasks',           CASE
                         WHEN b.subscription_status IN ('suspended','canceled') THEN false
                         WHEN b.subscription_status = 'trialing'               THEN true
                         WHEN b.subscription_plan   IN ('pro','full')          THEN true
                         ELSE false
                       END,
    'mayorista',       CASE
                         WHEN b.subscription_status IN ('suspended','canceled') THEN false
                         WHEN b.subscription_status = 'trialing'               THEN true
                         WHEN b.subscription_plan   = 'full'                   THEN true
                         ELSE false
                       END,
    'advancedRoles',   CASE
                         WHEN b.subscription_status IN ('suspended','canceled') THEN false
                         WHEN b.subscription_plan   = 'full'                   THEN true
                         ELSE false
                       END,
    'audit',           CASE
                         WHEN b.subscription_status IN ('suspended','canceled') THEN false
                         WHEN b.subscription_plan   = 'full'                   THEN true
                         ELSE false
                       END,
    'multisucursal',   CASE
                         WHEN b.subscription_status IN ('suspended','canceled') THEN false
                         WHEN b.subscription_plan   = 'full'                   THEN true
                         ELSE false
                       END
  )
  FROM businesses b
  WHERE b.id = p_business_id;
$function$;
