-- SEC-08F: close the final three authenticated financial read paths found by
-- the current-main/current-production discovery.
--
-- recurring_expenses and cash_registers belong to the existing `finance`
-- authority already used by their live routes and adjacent ledgers.
-- payment_orders belongs to the retired MP POS Connect path. There is no Beta
-- browser reader; payment_transactions already follows the same closed-read
-- contract. Service-role history remains available.

BEGIN;

-- Recurring business costs are consumed only from the finance route. Replace
-- the legacy membership-only predicate, including its inactive-profile gap.
DROP POLICY IF EXISTS re_select ON public.recurring_expenses;
DROP POLICY IF EXISTS recurring_expenses_select_finance_capability ON public.recurring_expenses;

CREATE POLICY recurring_expenses_select_finance_capability
ON public.recurring_expenses
FOR SELECT
TO authenticated
USING (
  business_id = public.current_user_business_id()
  AND public.current_user_can_in_business(business_id, 'finance')
);

REVOKE SELECT ON TABLE public.recurring_expenses FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.recurring_expenses TO authenticated;

COMMENT ON TABLE public.recurring_expenses IS
  'SEC-08F. Business recurring-cost templates are readable only by an active '
  'same-tenant actor with the existing `finance` capability.';

-- cash_registers is a legacy financial register. Its authenticated ALL policy
-- also acted as a SELECT policy. Split that policy by DML command so the write
-- contract stays unchanged while reads require `finance`.
DROP POLICY IF EXISTS cash_registers_business_select ON public.cash_registers;
DROP POLICY IF EXISTS cr_write ON public.cash_registers;
DROP POLICY IF EXISTS cash_registers_select_finance_capability ON public.cash_registers;
DROP POLICY IF EXISTS cr_insert_same_tenant ON public.cash_registers;
DROP POLICY IF EXISTS cr_update_same_tenant ON public.cash_registers;
DROP POLICY IF EXISTS cr_delete_same_tenant ON public.cash_registers;

CREATE POLICY cash_registers_select_finance_capability
ON public.cash_registers
FOR SELECT
TO authenticated
USING (
  business_id = public.current_user_business_id()
  AND public.current_user_can_in_business(business_id, 'finance')
);

CREATE POLICY cr_insert_same_tenant
ON public.cash_registers
FOR INSERT
TO authenticated
WITH CHECK (business_id = public.current_user_business_id());

CREATE POLICY cr_update_same_tenant
ON public.cash_registers
FOR UPDATE
TO authenticated
USING (business_id = public.current_user_business_id())
WITH CHECK (business_id = public.current_user_business_id());

CREATE POLICY cr_delete_same_tenant
ON public.cash_registers
FOR DELETE
TO authenticated
USING (business_id = public.current_user_business_id());

COMMENT ON TABLE public.cash_registers IS
  'SEC-08F. Legacy cash balances require active same-tenant `finance` read '
  'authority. Existing same-tenant authenticated DML remains available.';

-- MP POS Connect is disabled for Beta, and no current frontend or browser RPC
-- reads payment_orders. Remove browser SELECT instead of inventing a new read
-- capability. Split po_write so it cannot silently remain a SELECT policy.
DROP POLICY IF EXISTS po_select ON public.payment_orders;
DROP POLICY IF EXISTS po_write ON public.payment_orders;
DROP POLICY IF EXISTS po_insert_same_tenant ON public.payment_orders;
DROP POLICY IF EXISTS po_update_same_tenant ON public.payment_orders;
DROP POLICY IF EXISTS po_delete_same_tenant ON public.payment_orders;

CREATE POLICY po_insert_same_tenant
ON public.payment_orders
FOR INSERT
TO authenticated
WITH CHECK (business_id = public.current_user_business_id());

CREATE POLICY po_update_same_tenant
ON public.payment_orders
FOR UPDATE
TO authenticated
USING (business_id = public.current_user_business_id())
WITH CHECK (business_id = public.current_user_business_id());

CREATE POLICY po_delete_same_tenant
ON public.payment_orders
FOR DELETE
TO authenticated
USING (business_id = public.current_user_business_id());

REVOKE SELECT ON TABLE public.payment_orders FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payment_orders TO service_role;

COMMENT ON TABLE public.payment_orders IS
  'SEC-08F. Retired MP POS payment-order history has no Beta browser reader. '
  'SELECT is service-role only; existing same-tenant authenticated DML remains.';

-- Migration-time proof. Fail closed if a parallel permissive read survives or
-- if the intentionally preserved DML/service contracts were lost.
DO $sec08f_postcondition$
DECLARE
  v_qual text;
  v_count integer;
BEGIN
  SELECT count(*), max(qual)
    INTO v_count, v_qual
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename = 'recurring_expenses'
     AND cmd = 'SELECT';
  IF v_count <> 1
     OR v_qual NOT LIKE '%current_user_business_id%'
     OR v_qual NOT LIKE '%current_user_can_in_business%'
     OR v_qual NOT LIKE '%''finance''%' THEN
    RAISE EXCEPTION 'SEC08F_POSTCONDITION: recurring_expenses read authority invalid';
  END IF;

  SELECT count(*), max(qual)
    INTO v_count, v_qual
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename = 'cash_registers'
     AND cmd = 'SELECT';
  IF v_count <> 1
     OR v_qual NOT LIKE '%current_user_business_id%'
     OR v_qual NOT LIKE '%current_user_can_in_business%'
     OR v_qual NOT LIKE '%''finance''%' THEN
    RAISE EXCEPTION 'SEC08F_POSTCONDITION: cash_registers read authority invalid';
  END IF;

  IF has_table_privilege('anon', 'public.recurring_expenses', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.recurring_expenses', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.cash_registers', 'SELECT') THEN
    RAISE EXCEPTION 'SEC08F_POSTCONDITION: finance table grants invalid';
  END IF;

  IF has_table_privilege('authenticated', 'public.payment_orders', 'SELECT')
     OR EXISTS (
       SELECT 1 FROM pg_policy
        WHERE polrelid = 'public.payment_orders'::regclass
          AND polcmd IN ('r', '*')
     ) THEN
    RAISE EXCEPTION 'SEC08F_POSTCONDITION: payment_orders browser SELECT remains';
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.cash_registers', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.cash_registers', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.cash_registers', 'DELETE')
     OR NOT has_table_privilege('authenticated', 'public.payment_orders', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.payment_orders', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.payment_orders', 'DELETE')
     OR NOT has_table_privilege('service_role', 'public.payment_orders', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.payment_orders', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.payment_orders', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.payment_orders', 'DELETE') THEN
    RAISE EXCEPTION 'SEC08F_POSTCONDITION: preserved DML/service grants invalid';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_policy
     WHERE polrelid IN ('public.cash_registers'::regclass,
                        'public.payment_orders'::regclass)
       AND polcmd = '*'
  ) THEN
    RAISE EXCEPTION 'SEC08F_POSTCONDITION: ALL policy still grants implicit read';
  END IF;
END;
$sec08f_postcondition$;

COMMIT;
