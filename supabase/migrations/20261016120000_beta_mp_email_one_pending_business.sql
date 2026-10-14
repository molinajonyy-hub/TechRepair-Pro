-- BETA-MP-EMAIL: one in-flight subscription checkout per business, across plans/cycles.
-- No cleanup: existing duplicates abort this migration and require explicit review.
-- Does not change access, payments, RLS, grants or any remote Mercado Pago resource.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE UNIQUE INDEX uq_scs_pending_business
  ON public.subscription_checkout_sessions (business_id)
  WHERE status = 'pending';
COMMIT;
