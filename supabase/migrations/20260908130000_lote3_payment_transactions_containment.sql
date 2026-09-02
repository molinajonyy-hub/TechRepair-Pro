-- Lote 3B: MP POS Connect is disabled for Beta and no legitimate Beta caller
-- writes payment_transactions directly. Preserve history and trusted service
-- writers; close the authenticated browser path that can reach trig_pt_approved.

DROP POLICY IF EXISTS pt_write ON public.payment_transactions;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.payment_transactions
  FROM authenticated;

-- Make the intended matrix explicit instead of inheriting baseline accidents.
REVOKE ALL ON TABLE public.payment_transactions FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.payment_transactions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payment_transactions TO service_role;

COMMENT ON TABLE public.payment_transactions IS
  'Provider payment history. Beta browser contract is SELECT-only; writes are trusted-upstream only. trig_pt_approved remains protected by upstream write authority.';
