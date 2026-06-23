-- ============================================================================
-- Billing hardening — STAGE E (scheduled expiry)
-- Migration: 20260623_161_billing_stageE_scheduling
--
-- Schedules the trial/grace expiry functions so they actually run. Today pg_cron
-- is NOT installed and expire_trials()/enforce_grace_period() never execute, so
-- trials and grace periods are effectively eternal.
--
-- ⚠️ APPLY THIS ONLY AFTER deciding how to handle the 9 already-expired trials.
--    Once scheduled, the next run of expire_trials() will move every trialing
--    business whose trial_ends_at < now() to 'suspended'. As of the audit that is
--    9 accounts. If you want to keep any of them, first run admin_extend_trial()
--    or admin_grant_legacy_access() for those businesses.
--
-- PREFLIGHT (rows that WILL be suspended on first run):
--   SELECT id, subscription_plan, trial_ends_at
--   FROM public.businesses
--   WHERE subscription_status = 'trialing' AND trial_ends_at < now()
--   ORDER BY trial_ends_at;
--
-- expire_trials() and enforce_grace_period() are SECURITY DEFINER owned by
-- postgres, so they run as postgres and the Stage D trigger permits their writes.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Idempotent (re)scheduling: drop existing jobs with these names, then recreate.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'billing-expire-trials') THEN
    PERFORM cron.unschedule('billing-expire-trials');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'billing-enforce-grace') THEN
    PERFORM cron.unschedule('billing-enforce-grace');
  END IF;

  -- 03:00 and 03:05 UTC daily.
  PERFORM cron.schedule('billing-expire-trials', '0 3 * * *',  $cron$ SELECT public.expire_trials(); $cron$);
  PERFORM cron.schedule('billing-enforce-grace', '5 3 * * *',  $cron$ SELECT public.enforce_grace_period(); $cron$);
END$$;

-- ============================================================================
-- ALTERNATIVE (if pg_cron cannot be enabled on this plan):
--   Schedule a daily call to a small Edge Function via Supabase scheduled
--   functions, or invoke expire_trials()/enforce_grace_period() from an external
--   cron (GitHub Actions / Vercel Cron) using a service-role authenticated RPC.
--
-- ROLLBACK (manual) — Stage E scheduling:
--   SELECT cron.unschedule('billing-expire-trials');
--   SELECT cron.unschedule('billing-enforce-grace');
-- ============================================================================
