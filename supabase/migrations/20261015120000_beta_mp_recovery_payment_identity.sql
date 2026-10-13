-- BETA-MP-RECOVERY: one Mercado Pago payment cannot be booked under two invoices.
-- DDL only. No backfill, tenant association, grants, policies or commercial data changes.
-- Apply to production ONLY with separate owner authorization. Duplicate precondition aborts.
BEGIN;
DO $$
BEGIN
  IF to_regclass('public.uq_payments_provider_external_payment') IS NULL THEN
    RAISE EXCEPTION 'BETA-MP base migration is required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.payments
    WHERE provider = 'mercadopago' AND raw_payload->>'payment_id' IS NOT NULL
    GROUP BY provider, raw_payload->>'payment_id' HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate payment identities: investigate without automatic reassociation';
  END IF;
END $$;
CREATE UNIQUE INDEX uq_payments_mp_payment_id
  ON public.payments (provider, (raw_payload->>'payment_id'))
  WHERE provider = 'mercadopago' AND raw_payload->>'payment_id' IS NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = 'public.uq_payments_mp_payment_id'::regclass
    AND indisunique AND indisvalid AND indpred IS NOT NULL) THEN
    RAISE EXCEPTION 'Payment identity index postcondition failed';
  END IF;
END $$;
COMMIT;
-- Rollback (separately authorized): DROP INDEX public.uq_payments_mp_payment_id;
