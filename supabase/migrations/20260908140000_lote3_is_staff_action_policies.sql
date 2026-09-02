-- Lote 3C: is_staff remains a membership helper, never the sole action guard.
-- Generic operational reads stay intact. Sensitive reads and every direct write
-- that previously depended only on is_staff receive an existing capability.

CREATE TEMP TABLE lote3_insert_update_policy_map (
  table_name text PRIMARY KEY,
  insert_policy text,
  insert_capability text,
  update_policy text,
  update_capability text
) ON COMMIT DROP;

INSERT INTO lote3_insert_update_policy_map VALUES
('comprobante_items','comprobante_items_insert','comprobantes','comprobante_items_update','comprobantes'),
('comprobantes','comprobantes_insert','comprobantes','comprobantes_update','comprobantes'),
('device_inspections','device_inspections_insert','orders_create','device_inspections_update','orders_change_status'),
('devices','devices_insert','orders_create','devices_update','orders_change_status'),
('documents','documents_insert','orders_create','documents_update','orders_change_status'),
('expenses','expenses_insert','finance',NULL,NULL),
('inventory','inventory_insert','inventory','inventory_update','inventory'),
('inventory_movements','inventory_movements_insert','inventory',NULL,NULL),
('notes','notes_insert','orders_change_status','notes_update','orders_change_status'),
('notifications','notifications_insert','orders_change_status','notifications_update','orders'),
('order_checklists','order_checklists_insert','orders_change_status','order_checklists_update','orders_change_status'),
('order_parts','order_parts_insert','orders_change_status','order_parts_update','orders_change_status'),
('orders','orders_insert','orders_create','orders_update','orders_change_status'),
('parts_used','parts_used_insert','orders_change_status','parts_used_update','orders_change_status'),
('purchase_items','purchase_items_insert','inventory','purchase_items_update','inventory'),
('purchases','purchases_insert','inventory','purchases_update','inventory'),
('status_history','status_history_insert','orders_change_status','status_history_update','orders_change_status'),
('suppliers','suppliers_insert','inventory','suppliers_update','inventory'),
('warranties','warranties_insert','orders_change_status','warranties_update','orders_change_status');

-- This legacy ALL policy is permissive and would OR around inventory's
-- capability-specific SELECT/INSERT/UPDATE policies. The wholesale customer
-- read policy remains separate and unchanged.
DROP POLICY IF EXISTS tenant_isolation ON public.inventory;

DO $migration$
DECLARE
  r lote3_insert_update_policy_map%ROWTYPE;
BEGIN
  FOR r IN SELECT * FROM lote3_insert_update_policy_map ORDER BY table_name LOOP
    IF r.insert_policy IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.insert_policy, r.table_name);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (business_id = public.current_business_id() AND public.current_user_can(%L))',
        r.insert_policy, r.table_name, r.insert_capability
      );
    END IF;
    IF r.update_policy IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.update_policy, r.table_name);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (business_id = public.current_business_id() AND public.current_user_can(%L)) WITH CHECK (business_id = public.current_business_id() AND public.current_user_can(%L))',
        r.update_policy, r.table_name, r.update_capability, r.update_capability
      );
    END IF;
  END LOOP;
END;
$migration$;

-- Settings/finance/inventory tables whose baseline ALL policy made membership
-- equivalent to SELECT+INSERT+UPDATE+DELETE authority.
DROP POLICY IF EXISTS rls_drh ON public.dollar_rate_history;
CREATE POLICY rls_drh ON public.dollar_rate_history TO authenticated
  USING (business_id = public.current_business_id() AND public.current_user_can('settings_sensitive'))
  WITH CHECK (business_id = public.current_business_id() AND public.current_user_can('settings_sensitive'));

DROP POLICY IF EXISTS rls_ec ON public.expense_categories;
CREATE POLICY rls_ec ON public.expense_categories TO authenticated
  USING (business_id = public.current_business_id() AND public.current_user_can('finance'))
  WITH CHECK (business_id = public.current_business_id() AND public.current_user_can('finance'));

DROP POLICY IF EXISTS rls_product_offers_all ON public.product_offers;
CREATE POLICY rls_product_offers_all ON public.product_offers TO authenticated
  USING (business_id = public.current_business_id() AND public.current_user_can('inventory'))
  WITH CHECK (business_id = public.current_business_id() AND public.current_user_can('inventory'));

DROP POLICY IF EXISTS rls_supplier_purchase_items ON public.supplier_purchase_items;
CREATE POLICY rls_supplier_purchase_items ON public.supplier_purchase_items TO authenticated
  USING (business_id = public.current_business_id() AND public.current_user_can('inventory'))
  WITH CHECK (business_id = public.current_business_id() AND public.current_user_can('inventory'));

DROP POLICY IF EXISTS rls_supplier_purchases ON public.supplier_purchases;
CREATE POLICY rls_supplier_purchases ON public.supplier_purchases TO authenticated
  USING (business_id = public.current_business_id() AND public.current_user_can('inventory'))
  WITH CHECK (business_id = public.current_business_id() AND public.current_user_can('inventory'));

-- POS consumes commission options, while only sensitive-settings actors may
-- configure them. Separate commands avoid an ALL policy leaking write authority.
DROP POLICY IF EXISTS rls_pcg ON public.payment_commission_groups;
CREATE POLICY payment_commission_groups_select ON public.payment_commission_groups
  FOR SELECT TO authenticated
  USING (business_id = public.current_business_id() AND public.current_user_can('comprobantes'));
CREATE POLICY payment_commission_groups_insert ON public.payment_commission_groups
  FOR INSERT TO authenticated
  WITH CHECK (business_id = public.current_business_id() AND public.current_user_can('settings_sensitive'));
CREATE POLICY payment_commission_groups_update ON public.payment_commission_groups
  FOR UPDATE TO authenticated
  USING (business_id = public.current_business_id() AND public.current_user_can('settings_sensitive'))
  WITH CHECK (business_id = public.current_business_id() AND public.current_user_can('settings_sensitive'));
CREATE POLICY payment_commission_groups_delete ON public.payment_commission_groups
  FOR DELETE TO authenticated
  USING (business_id = public.current_business_id() AND public.current_user_can('settings_sensitive'));

DROP POLICY IF EXISTS rls_pco ON public.payment_commission_options;
CREATE POLICY payment_commission_options_select ON public.payment_commission_options
  FOR SELECT TO authenticated
  USING (business_id = public.current_business_id() AND public.current_user_can('comprobantes'));
CREATE POLICY payment_commission_options_insert ON public.payment_commission_options
  FOR INSERT TO authenticated
  WITH CHECK (business_id = public.current_business_id() AND public.current_user_can('settings_sensitive'));
CREATE POLICY payment_commission_options_update ON public.payment_commission_options
  FOR UPDATE TO authenticated
  USING (business_id = public.current_business_id() AND public.current_user_can('settings_sensitive'))
  WITH CHECK (business_id = public.current_business_id() AND public.current_user_can('settings_sensitive'));
CREATE POLICY payment_commission_options_delete ON public.payment_commission_options
  FOR DELETE TO authenticated
  USING (business_id = public.current_business_id() AND public.current_user_can('settings_sensitive'));

-- Tasks keep the plan entitlement and generic order read contract. Mutations
-- require workflow authority, and all policies become authenticated-only.
DROP POLICY IF EXISTS task_comments_plan ON public.task_comments;
DROP POLICY IF EXISTS task_history_plan ON public.task_history;
DROP POLICY IF EXISTS task_items_plan ON public.task_items;

DO $tasks$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['task_comments','task_history','task_items'] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (business_id = public.current_user_business_id() AND public.business_has_feature(''tasks'') AND public.current_user_can(''orders''))',
      v_table || '_plan_select', v_table
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (business_id = public.current_user_business_id() AND public.business_has_feature(''tasks'') AND public.current_user_can(''orders_change_status''))',
      v_table || '_plan_insert', v_table
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (business_id = public.current_user_business_id() AND public.business_has_feature(''tasks'') AND public.current_user_can(''orders_change_status'')) WITH CHECK (business_id = public.current_user_business_id() AND public.business_has_feature(''tasks'') AND public.current_user_can(''orders_change_status''))',
      v_table || '_plan_update', v_table
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (business_id = public.current_user_business_id() AND public.business_has_feature(''tasks'') AND public.current_user_can(''orders_change_status''))',
      v_table || '_plan_delete', v_table
    );
  END LOOP;
END;
$tasks$;

DROP POLICY IF EXISTS tasks_plan_delete ON public.tasks;
DROP POLICY IF EXISTS tasks_plan_insert ON public.tasks;
DROP POLICY IF EXISTS tasks_plan_select ON public.tasks;
DROP POLICY IF EXISTS tasks_plan_update ON public.tasks;
CREATE POLICY tasks_plan_select ON public.tasks FOR SELECT TO authenticated
  USING (business_id = public.current_user_business_id()
    AND public.business_has_feature('tasks') AND public.current_user_can('orders'));
CREATE POLICY tasks_plan_insert ON public.tasks FOR INSERT TO authenticated
  WITH CHECK (business_id = public.current_user_business_id()
    AND public.business_has_feature('tasks') AND public.current_user_can('orders_change_status'));
CREATE POLICY tasks_plan_update ON public.tasks FOR UPDATE TO authenticated
  USING (business_id = public.current_user_business_id()
    AND public.business_has_feature('tasks') AND public.current_user_can('orders_change_status'))
  WITH CHECK (business_id = public.current_user_business_id()
    AND public.business_has_feature('tasks') AND public.current_user_can('orders_change_status'));
CREATE POLICY tasks_plan_delete ON public.tasks FOR DELETE TO authenticated
  USING (business_id = public.current_user_business_id()
    AND public.business_has_feature('tasks') AND public.current_user_can('orders_change_status'));

-- The browser genuinely logs manual/copy WhatsApp handoffs. It needs an action
-- capability, not bare staff membership. Service-role Edge inserts bypass RLS.
DROP POLICY IF EXISTS whatsapp_logs_insert ON public.whatsapp_logs;
CREATE POLICY whatsapp_logs_insert ON public.whatsapp_logs FOR INSERT TO authenticated
  WITH CHECK (business_id = public.current_business_id()
    AND (public.current_user_can('customers') OR public.current_user_can('orders_change_status')));

-- Sensitive reads that were previously available to every staff role.
DROP POLICY IF EXISTS expenses_select ON public.expenses;
CREATE POLICY expenses_select ON public.expenses FOR SELECT TO authenticated
  USING (business_id = public.current_business_id() AND public.current_user_can('finance'));

DROP POLICY IF EXISTS inventory_select ON public.inventory;
CREATE POLICY inventory_select ON public.inventory FOR SELECT TO authenticated
  USING (business_id = public.current_business_id() AND public.current_user_can('inventory'));

DROP POLICY IF EXISTS inventory_movements_select ON public.inventory_movements;
CREATE POLICY inventory_movements_select ON public.inventory_movements FOR SELECT TO authenticated
  USING (business_id = public.current_business_id() AND public.current_user_can('inventory'));

DROP POLICY IF EXISTS order_payments_select ON public.order_payments;
CREATE POLICY order_payments_select ON public.order_payments FOR SELECT TO authenticated
  USING (business_id = public.current_business_id() AND public.current_user_can('orders_view_financials'));

CREATE TEMP TABLE lote3_inventory_read_policy_map (
  table_name text PRIMARY KEY,
  policy_name text NOT NULL
) ON COMMIT DROP;
INSERT INTO lote3_inventory_read_policy_map VALUES
('purchase_items','purchase_items_select'),
('purchases','purchases_select'),
('supplier_account_movements','supplier_account_movements_select'),
('supplier_payments','supplier_payments_select'),
('suppliers','suppliers_select');

DO $reads$
DECLARE
  r lote3_inventory_read_policy_map%ROWTYPE;
BEGIN
  FOR r IN SELECT * FROM lote3_inventory_read_policy_map LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policy_name, r.table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (business_id = public.current_business_id() AND public.current_user_can(''inventory''))',
      r.policy_name, r.table_name
    );
  END LOOP;
END;
$reads$;

DROP POLICY IF EXISTS whatsapp_logs_select ON public.whatsapp_logs;
CREATE POLICY whatsapp_logs_select ON public.whatsapp_logs FOR SELECT TO authenticated
  USING (business_id = public.current_business_id()
    AND (public.current_user_can('customers') OR public.current_user_can('orders_change_status')));

DROP POLICY IF EXISTS wc_staff_read ON public.wholesale_customers;
CREATE POLICY wc_staff_read ON public.wholesale_customers FOR SELECT TO authenticated
  USING (business_id = public.current_business_id()
    AND public.business_has_feature('mayorista') AND public.current_user_can('wholesale'));
DROP POLICY IF EXISTS wo_staff_read ON public.wholesale_orders;
CREATE POLICY wo_staff_read ON public.wholesale_orders FOR SELECT TO authenticated
  USING (business_id = public.current_business_id()
    AND public.business_has_feature('mayorista') AND public.current_user_can('wholesale'));
DROP POLICY IF EXISTS woi_staff_read ON public.wholesale_order_items;
CREATE POLICY woi_staff_read ON public.wholesale_order_items FOR SELECT TO authenticated
  USING (business_id = public.current_business_id()
    AND public.business_has_feature('mayorista') AND public.current_user_can('wholesale'));

-- Baseline accidentally granted these user-facing tables to anon. RLS happened
-- to reject anon through is_staff, but grants must also express the contract.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.tasks FROM anon, PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.warranties FROM anon, PUBLIC;

DO $postconditions$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_policy p
      JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public'
       AND p.polcmd<>'r'
       AND (COALESCE(pg_catalog.pg_get_expr(p.polqual,p.polrelid),'') ILIKE '%is_staff%'
         OR COALESCE(pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid),'') ILIKE '%is_staff%')
  ) THEN
    RAISE EXCEPTION 'Lote 3C postcondition: an is_staff write policy remains';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy
     WHERE polrelid='public.inventory'::regclass AND polname='tenant_isolation'
  ) THEN
    RAISE EXCEPTION 'Lote 3C postcondition: inventory tenant-only bypass remains';
  END IF;

  IF pg_catalog.has_table_privilege('anon','public.tasks','INSERT,UPDATE,DELETE')
     OR pg_catalog.has_table_privilege('anon','public.warranties','INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'Lote 3C postcondition: anon DML grant remains';
  END IF;
END;
$postconditions$;
