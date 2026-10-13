-- LOCAL ONLY. Runs in a rollback; cloned indexes exercise the real migration definition.
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('public.uq_payments_mp_payment_id')
    AND indisunique AND indisvalid) THEN RAISE EXCEPTION 'Recovery migration missing'; END IF;
END $$;
CREATE TEMP TABLE recovery_payments_probe (LIKE public.payments INCLUDING ALL);
INSERT INTO recovery_payments_probe (business_id,provider,external_payment_id,type,amount,currency,status,raw_payload)
VALUES ('11111111-1111-4111-8111-11111111aaaa','mercadopago','invoice-a','recurring',15000,'ARS','approved',
  '{"preapproval_id":"pre-a","payment_id":"payment-a"}');
DO $$
BEGIN
  BEGIN
    INSERT INTO recovery_payments_probe (business_id,provider,external_payment_id,type,amount,currency,status,raw_payload)
    VALUES ('22222222-2222-4222-8222-22222222bbbb','mercadopago','invoice-b','recurring',15000,'ARS','approved',
      '{"preapproval_id":"pre-b","payment_id":"payment-a"}');
    RAISE EXCEPTION 'Same payment incorrectly accepted under another invoice/tenant';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;
INSERT INTO recovery_payments_probe (business_id,provider,external_payment_id,type,amount,currency,status,raw_payload)
VALUES ('11111111-1111-4111-8111-11111111aaaa','mercadopago','pending-a','recurring',15000,'ARS','pending','{"payment_id":null}'),
       ('22222222-2222-4222-8222-22222222bbbb','mercadopago','pending-b','recurring',15000,'ARS','pending','{"payment_id":null}');
ROLLBACK;
