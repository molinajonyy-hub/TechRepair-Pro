-- ============================================================================
-- Billing hardening — STAGE E (data normalization)
-- Migration: 20260623_160_billing_stageE_data_normalization
--
-- Classifies the 7 currently-active accounts that have NO Mercado Pago link
-- (mp_preapproval_id IS NULL) as `manual_grandfathered` so the system stops
-- treating them as if they were paid MP subscriptions — WITHOUT removing their
-- access and WITHOUT fabricating any MP payment, preapproval id, or event.
--
-- ⚠️ RUN THE PREFLIGHT PREVIEW BELOW BEFORE APPLYING. The guarded UPDATE must
--    affect EXACTLY the 7 rows enumerated in the audit. If the count differs,
--    stop and investigate.
--
-- The 7 expected accounts (id prefixes only; confirm full set via the PREFLIGHT):
--   aa930802…  (full,  period_end 2099 — permanent override)
--   e7610990…  (basico)
--   f6262268…  (pro)
--   a69a72e4…  (full)
--   d93dfda8…  (pro,    provider=manual)
--   128209d4…  (full,   provider=manual)
--   7642f30c…  (basico, provider=manual)
--
-- PREFLIGHT (run manually, expect 7 rows):
--   SELECT id, subscription_plan, subscription_status, mp_preapproval_id, access_source
--   FROM public.businesses
--   WHERE subscription_status = 'active'
--     AND mp_preapproval_id IS NULL
--     AND access_source IS NULL;
--
-- Note: this migration is ordered AFTER the Stage D trigger (140 < 160); it runs
-- as the migration role (postgres), which the trigger permits.
-- ============================================================================

DO $$
DECLARE
  v_count int;
  v_ids   uuid[];
BEGIN
  SELECT count(*), array_agg(id)
    INTO v_count, v_ids
  FROM public.businesses
  WHERE subscription_status = 'active'
    AND mp_preapproval_id IS NULL
    AND access_source IS NULL;

  RAISE NOTICE 'Stage E grandfather: % active accounts without MP link will be classified', v_count;

  IF v_count = 0 THEN
    RAISE NOTICE 'Nothing to normalize (already classified or none match). Skipping.';
    RETURN;
  END IF;

  -- Safety rail: refuse to run if the set is unexpectedly large (data drift).
  IF v_count > 10 THEN
    RAISE EXCEPTION 'Refusing to grandfather % accounts (> 10). Re-check preflight before proceeding.', v_count;
  END IF;

  UPDATE public.businesses SET
    access_source       = 'manual_grandfathered',
    subscription_provider = 'manual',
    override_reason     = 'Legacy manual activation classified during 2026-06-23 billing audit',
    override_created_by  = NULL,          -- system migration, not attributed to an admin
    override_created_at  = NOW(),
    override_expires_at  = NULL,          -- managed legacy access; no auto-expiry
    updated_at           = NOW()
  WHERE subscription_status = 'active'
    AND mp_preapproval_id IS NULL
    AND access_source IS NULL;

  -- Audit the normalization as a MIGRATION event (not an admin action).
  INSERT INTO public.subscription_events(provider, event_type, external_id, raw_payload, processed, processed_at)
  VALUES (
    'migration',
    'grandfather_normalization',
    '20260623160000',
    jsonb_build_object(
      'classified_count', v_count,
      'business_ids',     to_jsonb(v_ids),
      'access_source',    'manual_grandfathered',
      'note',             'Legacy manual activations; no MP payment fabricated'
    ),
    TRUE,
    NOW()
  );
END$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Guard: any trialing business with a NULL trial_ends_at gets a bounded trial
-- (created_at + 14 days) so trials cannot be eternal. Affects 0 rows today
-- (the only NULL-trial row is an active account), but protects future inserts.
-- PREFLIGHT: SELECT id, created_at FROM public.businesses
--            WHERE subscription_status='trialing' AND trial_ends_at IS NULL;
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE public.businesses
  SET trial_ends_at = created_at + INTERVAL '14 days',
      updated_at    = NOW()
WHERE subscription_status = 'trialing'
  AND trial_ends_at IS NULL;

-- ============================================================================
-- POSTFLIGHT (run manually):
--   SELECT access_source, count(*) FROM public.businesses GROUP BY access_source;
--   -- expect 7 rows with access_source = 'manual_grandfathered'
--   SELECT * FROM public.subscription_events WHERE event_type='grandfather_normalization';
--
-- ROLLBACK (manual) — Stage E data:
--   UPDATE public.businesses
--     SET access_source = NULL, override_reason = NULL, override_created_at = NULL,
--         override_expires_at = NULL
--     WHERE access_source = 'manual_grandfathered'
--       AND override_reason = 'Legacy manual activation classified during 2026-06-23 billing audit';
--   DELETE FROM public.subscription_events WHERE event_type='grandfather_normalization' AND external_id='20260623160000';
-- ============================================================================
