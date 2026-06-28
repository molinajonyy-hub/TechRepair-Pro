-- ============================================================
-- TechRepair Pro — Mercado Pago Subscription Integration
-- Migration: 20260416_mercadopago_subscriptions
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. Extend businesses table with subscription columns
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS subscription_status TEXT
    NOT NULL DEFAULT 'trialing'
    CHECK (subscription_status IN ('trialing','active','past_due','suspended','canceled','pending_activation')),
  ADD COLUMN IF NOT EXISTS subscription_plan TEXT
    CHECK (subscription_plan IN ('basico','pro','full')),
  ADD COLUMN IF NOT EXISTS subscription_provider TEXT DEFAULT 'mercadopago',
  ADD COLUMN IF NOT EXISTS mp_preapproval_id TEXT,
  ADD COLUMN IF NOT EXISTS mp_preapproval_plan_id TEXT,
  ADD COLUMN IF NOT EXISTS mp_payer_email TEXT,
  ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS grace_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_payment_id TEXT,
  ADD COLUMN IF NOT EXISTS last_payment_status TEXT,
  ADD COLUMN IF NOT EXISTS last_webhook_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '14 days');

-- ─────────────────────────────────────────────────────────────
-- 2. subscription_events — raw webhook log
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.subscription_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  provider       TEXT NOT NULL DEFAULT 'mercadopago',
  event_type     TEXT NOT NULL,
  external_id    TEXT,
  raw_payload    JSONB NOT NULL DEFAULT '{}',
  processed      BOOLEAN NOT NULL DEFAULT FALSE,
  error_message  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sub_events_business ON public.subscription_events(business_id);
CREATE INDEX IF NOT EXISTS idx_sub_events_external ON public.subscription_events(external_id);
CREATE INDEX IF NOT EXISTS idx_sub_events_processed ON public.subscription_events(processed);

-- ─────────────────────────────────────────────────────────────
-- 3. payments — payment ledger per business
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL DEFAULT 'mercadopago',
  external_payment_id TEXT,
  type                TEXT NOT NULL DEFAULT 'recurring'
    CHECK (type IN ('one_time','recurring','manual')),
  amount              NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency            TEXT NOT NULL DEFAULT 'ARS',
  status              TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('approved','pending','in_process','rejected','cancelled','refunded','charged_back')),
  subscription_plan   TEXT,
  paid_at             TIMESTAMPTZ,
  period_start        TIMESTAMPTZ,
  period_end          TIMESTAMPTZ,
  raw_payload         JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_external_id
  ON public.payments(provider, external_payment_id)
  WHERE external_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payments_business ON public.payments(business_id);
CREATE INDEX IF NOT EXISTS idx_payments_status   ON public.payments(status);

-- ─────────────────────────────────────────────────────────────
-- 4. RLS policies
-- ─────────────────────────────────────────────────────────────

-- subscription_events: read-only for business members
ALTER TABLE public.subscription_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sub_events_select ON public.subscription_events;
CREATE POLICY sub_events_select ON public.subscription_events
  FOR SELECT USING (
    business_id IN (
      SELECT business_id FROM public.profiles
      WHERE user_id = auth.uid() AND is_active = TRUE
    )
  );

-- Service role (webhook) can insert/update freely — bypasses RLS
-- No INSERT policy needed for anon/authenticated — only service_role writes

-- payments: business members can read, service_role writes
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payments_select ON public.payments;
CREATE POLICY payments_select ON public.payments
  FOR SELECT USING (
    business_id IN (
      SELECT business_id FROM public.profiles
      WHERE user_id = auth.uid() AND is_active = TRUE
    )
  );

-- ─────────────────────────────────────────────────────────────
-- 5. Helper function — get business subscription status
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_business_subscription(p_business_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
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

-- ─────────────────────────────────────────────────────────────
-- 6. Trigger: auto-expire trialing businesses past trial_ends_at
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.expire_trials()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
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

-- ─────────────────────────────────────────────────────────────
-- 7. Trigger: auto-suspend past_due businesses past grace_until
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_grace_period()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
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

-- ─────────────────────────────────────────────────────────────
-- 8. View for admin subscription overview
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_subscription_overview AS
SELECT
  b.id                     AS business_id,
  b.name                   AS business_name,
  b.subscription_status,
  b.subscription_plan,
  b.mp_preapproval_id,
  b.mp_payer_email,
  b.current_period_end,
  b.grace_until,
  b.last_payment_status,
  b.last_webhook_at,
  b.trial_ends_at,
  b.created_at,
  COUNT(p.id)              AS total_payments,
  MAX(p.paid_at)           AS last_paid_at,
  COALESCE(SUM(CASE WHEN p.status = 'approved' THEN p.amount ELSE 0 END), 0) AS total_revenue
FROM public.businesses b
LEFT JOIN public.payments p ON p.business_id = b.id
GROUP BY b.id;
