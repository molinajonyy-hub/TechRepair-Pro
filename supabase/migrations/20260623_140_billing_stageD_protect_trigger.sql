-- ============================================================================
-- Billing hardening — STAGE D (lock down direct writes)
-- Migration: 20260623_140_billing_stageD_protect_trigger
--
-- Closes the CRITICAL self-activation hole: today any owner/admin can run
--   supabase.from('businesses').update({ subscription_status:'active',
--     subscription_plan:'full', trial_ends_at:'2099-01-01' })
-- from the browser, because businesses_update RLS has no column restriction.
--
-- This BEFORE UPDATE trigger blocks changes to billing/subscription columns when
-- the change originates from a browser session (DB role authenticated / anon).
--
-- Why role, not a GUC: a client can call set_config() itself, so a session GUC
-- is not a trust boundary. The trust boundary is the DB role. PostgREST executes
-- client requests as 'authenticated' or 'anon'. The legitimate writers run as a
-- different role:
--   * the webhook uses the service_role key  → current_user = 'service_role'
--   * the Stage C admin RPCs are SECURITY DEFINER owned by postgres
--                                            → current_user = 'postgres' inside them
--   * migrations / cron jobs run as postgres → current_user = 'postgres'
-- So blocking ONLY 'authenticated'/'anon' permits every verified path and denies
-- the browser. The admin RPCs still enforce platform-admin authorization on top.
--
-- IMPORTANT: this trigger does NOT modify or disable any existing row. The 7
-- currently-active accounts keep their access untouched. It only constrains
-- FUTURE direct client UPDATEs.
--
-- PREREQUISITE: apply Stage C first (admin RPCs) and switch the admin panel to
-- them, otherwise the panel's writes will start failing.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.protect_subscription_columns()
RETURNS trigger
LANGUAGE plpgsql
-- SECURITY INVOKER (default): current_user must reflect the real session role.
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text := current_user;
  v_changed boolean;
BEGIN
  -- Only constrain browser/client roles. Backend roles (service_role, postgres,
  -- supabase_admin) and SECURITY DEFINER admin RPCs (run as postgres) pass through.
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

DROP TRIGGER IF EXISTS trg_protect_subscription_columns ON public.businesses;
CREATE TRIGGER trg_protect_subscription_columns
  BEFORE UPDATE ON public.businesses
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_subscription_columns();

-- ============================================================================
-- ROLLBACK (manual) — Stage D
--   DROP TRIGGER IF EXISTS trg_protect_subscription_columns ON public.businesses;
--   DROP FUNCTION IF EXISTS public.protect_subscription_columns();
-- ============================================================================
