-- BETA-MP-RECOVERY verification. SELECT only; no reassociation or repair.
SELECT 'recovery migration recorded' AS check,
       EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261015120000') AS ok
UNION ALL
SELECT 'unique MP payment identity index',
       EXISTS (SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.uq_payments_mp_payment_id')
         AND indisunique AND indisvalid AND indpred IS NOT NULL)
UNION ALL
SELECT 'no payment identity duplicated',
       NOT EXISTS (SELECT 1 FROM public.payments WHERE provider='mercadopago' AND raw_payload->>'payment_id' IS NOT NULL
         GROUP BY provider,raw_payload->>'payment_id' HAVING count(*)>1)
UNION ALL
SELECT 'approved ledger rows carry invoice, subscription, payment and approval date',
       NOT EXISTS (SELECT 1 FROM public.payments WHERE provider='mercadopago' AND status='approved'
         AND (external_payment_id IS NULL OR paid_at IS NULL OR raw_payload->>'preapproval_id' IS NULL
           OR raw_payload->>'authorized_payment_id' IS DISTINCT FROM external_payment_id OR raw_payload->>'payment_id' IS NULL));

SELECT event_type, processed, error_message, count(*) AS events
  FROM public.subscription_events
 WHERE event_type IN ('preapproval_superseded','billing_state_applied')
 GROUP BY event_type,processed,error_message ORDER BY event_type,processed;

-- A paid label without the canonical ledger is an anomaly, never payment proof.
SELECT count(*) AS paid_sessions_without_approved_ledger
  FROM public.subscription_checkout_sessions s
 WHERE s.status='paid' AND NOT EXISTS (
   SELECT 1 FROM public.payments p WHERE p.business_id=s.business_id AND p.provider='mercadopago'
     AND p.status='approved' AND p.raw_payload->>'preapproval_id'=s.mp_preapproval_id
     AND p.raw_payload->>'payment_id' IS NOT NULL AND p.paid_at IS NOT NULL);
