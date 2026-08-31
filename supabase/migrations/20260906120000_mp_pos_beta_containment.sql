-- MP POS / Merchant Connect is POST-BETA. Keep historical data and service access.
-- This table is not used by SaaS Billing or the current manual POS payment flow.
BEGIN;

ALTER TABLE public.mp_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.mp_accounts FROM PUBLIC, anon, authenticated;

-- Table REVOKE does not remove independent column grants.
DO $containment$
DECLARE col record;
BEGIN
  FOR col IN SELECT attname FROM pg_attribute
    WHERE attrelid = 'public.mp_accounts'::regclass AND attnum > 0 AND NOT attisdropped
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES (%I) ON TABLE public.mp_accounts FROM PUBLIC, anon, authenticated',
      col.attname
    );
  END LOOP;
END;
$containment$;

-- Defense against accidental future grants; does not affect service_role.
DROP POLICY IF EXISTS mp_accounts_select ON public.mp_accounts;
DROP POLICY IF EXISTS mp_accounts_beta_closed ON public.mp_accounts;
CREATE POLICY mp_accounts_beta_closed ON public.mp_accounts
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

COMMIT;
