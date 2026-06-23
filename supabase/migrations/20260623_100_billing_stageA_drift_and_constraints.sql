-- ============================================================================
-- Billing hardening — STAGE A (non-breaking)
-- Migration: 20260623_100_billing_stageA_drift_and_constraints
--
-- Purpose:
--   1. Capture in source control the three billing tables that exist in the
--      production DB but were never defined by a repo migration (schema drift):
--        - subscription_checkout_sessions
--        - subscription_payments
--        - blocked_feature_attempts
--   2. Add idempotency + integrity constraints needed by the hardened webhook.
--   3. Add the columns required to separate "paid via Mercado Pago" from
--      "manual / grandfathered / admin override" access (used in Stage C/E).
--
-- This migration is IDEMPOTENT and NON-BREAKING:
--   - Every object uses IF NOT EXISTS or an existence guard.
--   - It does NOT block any current write path.
--   - It does NOT modify any existing row.
--
-- Source of truth note:
--   `payments` is the canonical SaaS payment ledger written by the webhook.
--   `subscription_payments` is retained (drift capture) but is considered
--   DEPRECATED; the frontend now reads `payments`. Do not add new readers.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Drift capture — subscription_checkout_sessions
--    (faithful to production columns; created only if missing)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.subscription_checkout_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  user_id            UUID,
  plan_id            TEXT,
  billing_cycle      TEXT,
  amount             NUMERIC(12,2),
  currency           TEXT NOT NULL DEFAULT 'ARS',
  mp_preference_id   TEXT,
  external_reference TEXT,
  status             TEXT NOT NULL DEFAULT 'pending',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.subscription_checkout_sessions ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_scs_business    ON public.subscription_checkout_sessions(business_id);
CREATE INDEX IF NOT EXISTS idx_scs_status      ON public.subscription_checkout_sessions(status);
CREATE INDEX IF NOT EXISTS idx_scs_external    ON public.subscription_checkout_sessions(external_reference);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='subscription_checkout_sessions' AND policyname='scs_select') THEN
    CREATE POLICY scs_select ON public.subscription_checkout_sessions
      FOR SELECT USING (business_id = current_user_business_id());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='subscription_checkout_sessions' AND policyname='scs_insert') THEN
    CREATE POLICY scs_insert ON public.subscription_checkout_sessions
      FOR INSERT WITH CHECK (business_id = current_user_business_id());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='subscription_checkout_sessions' AND policyname='scs_service') THEN
    CREATE POLICY scs_service ON public.subscription_checkout_sessions
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Drift capture — subscription_payments (DEPRECATED; service_role-only write)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.subscription_payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  checkout_session_id UUID REFERENCES public.subscription_checkout_sessions(id) ON DELETE SET NULL,
  plan_id             TEXT NOT NULL,
  billing_cycle       TEXT NOT NULL,
  amount              NUMERIC(12,2) NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'ARS',
  provider            TEXT NOT NULL DEFAULT 'mercadopago',
  provider_payment_id TEXT,
  status              TEXT NOT NULL,
  paid_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.subscription_payments ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_sp_business ON public.subscription_payments(business_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='subscription_payments' AND policyname='sp_select') THEN
    CREATE POLICY sp_select ON public.subscription_payments
      FOR SELECT USING (business_id = current_user_business_id());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='subscription_payments' AND policyname='sp_service') THEN
    CREATE POLICY sp_service ON public.subscription_payments
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Drift capture — blocked_feature_attempts
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.blocked_feature_attempts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID REFERENCES public.businesses(id) ON DELETE CASCADE,
  user_id      UUID,
  feature      TEXT NOT NULL,
  action       TEXT,
  current_plan TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.blocked_feature_attempts ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_bfa_business ON public.blocked_feature_attempts(business_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='blocked_feature_attempts' AND policyname='bfa_select') THEN
    CREATE POLICY bfa_select ON public.blocked_feature_attempts
      FOR SELECT USING (business_id = current_user_business_id());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='blocked_feature_attempts' AND policyname='bfa_insert') THEN
    CREATE POLICY bfa_insert ON public.blocked_feature_attempts
      FOR INSERT WITH CHECK (business_id = current_user_business_id());
  END IF;
END$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Webhook idempotency — unique key on (provider, event_type, external_id)
--    Lets the webhook atomically "claim" an event via INSERT ... ON CONFLICT.
--    subscription_events is empty in production, so creation is safe.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.subscription_events
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_subscription_events_dedupe
  ON public.subscription_events(provider, event_type, external_id)
  WHERE external_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Prevent two businesses from sharing the same Mercado Pago preapproval.
--    All current rows have NULL mp_preapproval_id, so this is safe.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_businesses_mp_preapproval_id
  ON public.businesses(mp_preapproval_id)
  WHERE mp_preapproval_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Access-source columns — separate verifiable MP payment from manual access.
--    All nullable, no default behavior change. Populated in Stage C/E.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS access_source       TEXT,
  ADD COLUMN IF NOT EXISTS override_reason     TEXT,
  ADD COLUMN IF NOT EXISTS override_created_by UUID,
  ADD COLUMN IF NOT EXISTS override_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS override_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mp_last_modified    TIMESTAMPTZ;

-- access_source allowed values (NULL allowed = "unknown/legacy", classified in Stage E)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'businesses_access_source_chk'
  ) THEN
    ALTER TABLE public.businesses
      ADD CONSTRAINT businesses_access_source_chk
      CHECK (access_source IS NULL OR access_source IN
        ('mercado_pago','trial','manual_grandfathered','admin_override'))
      NOT VALID;  -- NOT VALID: do not scan/validate existing rows now
  END IF;
END$$;

-- ============================================================================
-- ROLLBACK (manual) — Stage A
--   DROP INDEX IF EXISTS public.uq_subscription_events_dedupe;
--   DROP INDEX IF EXISTS public.uq_businesses_mp_preapproval_id;
--   ALTER TABLE public.businesses DROP CONSTRAINT IF EXISTS businesses_access_source_chk;
--   ALTER TABLE public.businesses
--     DROP COLUMN IF EXISTS access_source, DROP COLUMN IF EXISTS override_reason,
--     DROP COLUMN IF EXISTS override_created_by, DROP COLUMN IF EXISTS override_created_at,
--     DROP COLUMN IF EXISTS override_expires_at, DROP COLUMN IF EXISTS mp_last_modified;
--   ALTER TABLE public.subscription_events DROP COLUMN IF EXISTS processed_at;
--   -- Do NOT drop the drift-captured tables on rollback (they predate this migration).
-- ============================================================================
