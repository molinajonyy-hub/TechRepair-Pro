-- SEC-08F rollback REVIEW MATERIAL. No production execution is authorized.
-- Restores the measured 2026-09-14 production policies and grants, including
-- the three authenticated read gaps that SEC-08F closes. It does not touch
-- migration history, the R2 client-contract gate, or any R3 object.

BEGIN;

DO $sec08f_rollback_preconditions$
DECLARE
  v_qual text;
  v_count integer;
BEGIN
  SELECT count(*), max(qual)
    INTO v_count, v_qual
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename = 'recurring_expenses'
     AND policyname = 'recurring_expenses_select_finance_capability'
     AND cmd = 'SELECT';
  IF v_count <> 1
     OR v_qual NOT LIKE '%current_user_can_in_business%'
     OR v_qual NOT LIKE '%''finance''%' THEN
    RAISE EXCEPTION 'SEC08F_ROLLBACK: candidate recurring_expenses policy missing or drifted';
  END IF;

  SELECT count(*)
    INTO v_count
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename = 'cash_registers'
     AND policyname IN (
       'cash_registers_select_finance_capability',
       'cr_insert_same_tenant',
       'cr_update_same_tenant',
       'cr_delete_same_tenant'
     );
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'SEC08F_ROLLBACK: candidate cash_registers policies incomplete';
  END IF;

  SELECT count(*)
    INTO v_count
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename = 'payment_orders'
     AND policyname IN (
       'po_insert_same_tenant',
       'po_update_same_tenant',
       'po_delete_same_tenant'
     );
  IF v_count <> 3
     OR has_table_privilege('authenticated', 'public.payment_orders', 'SELECT') THEN
    RAISE EXCEPTION 'SEC08F_ROLLBACK: candidate payment_orders state incomplete or drifted';
  END IF;

  IF (SELECT enforcement_state = 'enabled' AND minimum_contract = 1
        FROM private.client_contract_config
       WHERE singleton IS TRUE) IS NOT TRUE
     OR NOT EXISTS (
       SELECT 1
         FROM pg_db_role_setting s
         JOIN pg_roles r ON r.oid = s.setrole
         CROSS JOIN LATERAL unnest(s.setconfig) setting
        WHERE s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND r.rolname = 'authenticator'
          AND setting = 'pgrst.db_pre_request=public.check_client_contract'
     ) THEN
    RAISE EXCEPTION 'SEC08F_ROLLBACK: R2 client-contract state drifted';
  END IF;
END;
$sec08f_rollback_preconditions$;

DROP POLICY recurring_expenses_select_finance_capability ON public.recurring_expenses;
CREATE POLICY re_select
ON public.recurring_expenses
FOR SELECT
TO PUBLIC
USING (
  business_id IN (
    SELECT profiles.business_id
      FROM public.profiles
     WHERE COALESCE(profiles.user_id, profiles.id) = auth.uid()
  )
);
GRANT SELECT ON TABLE public.recurring_expenses TO anon, authenticated;

DROP POLICY cash_registers_select_finance_capability ON public.cash_registers;
DROP POLICY cr_insert_same_tenant ON public.cash_registers;
DROP POLICY cr_update_same_tenant ON public.cash_registers;
DROP POLICY cr_delete_same_tenant ON public.cash_registers;

CREATE POLICY cash_registers_business_select
ON public.cash_registers
FOR SELECT
TO PUBLIC
USING (
  business_id = (
    SELECT profiles.business_id
      FROM public.profiles
     WHERE profiles.id = auth.uid()
  )
);

CREATE POLICY cr_write
ON public.cash_registers
FOR ALL
TO authenticated
USING (business_id = public.current_user_business_id())
WITH CHECK (business_id = public.current_user_business_id());

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.cash_registers TO authenticated;

DROP POLICY po_insert_same_tenant ON public.payment_orders;
DROP POLICY po_update_same_tenant ON public.payment_orders;
DROP POLICY po_delete_same_tenant ON public.payment_orders;

CREATE POLICY po_select
ON public.payment_orders
FOR SELECT
TO PUBLIC
USING (business_id = public.current_user_business_id());

CREATE POLICY po_write
ON public.payment_orders
FOR ALL
TO authenticated
USING (business_id = public.current_user_business_id())
WITH CHECK (business_id = public.current_user_business_id());

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.payment_orders TO authenticated, service_role;

DO $sec08f_rollback_postconditions$
BEGIN
  IF NOT has_table_privilege('anon', 'public.recurring_expenses', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.payment_orders', 'SELECT')
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'cash_registers'
          AND policyname = 'cr_write'
          AND cmd = 'ALL'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'payment_orders'
          AND policyname = 'po_write'
          AND cmd = 'ALL'
     ) THEN
    RAISE EXCEPTION 'SEC08F_ROLLBACK: measured pre-SEC-08F authority was not restored';
  END IF;
END;
$sec08f_rollback_postconditions$;

NOTIFY pgrst, 'reload schema';
COMMIT;
