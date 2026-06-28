-- ================================================================
-- CORRECCIÓN RLS: SELECT abierto para authenticated en todas las tablas
-- El filtro por business_id se aplica en el código (app-level security)
-- current_user_business_id() puede devolver NULL causando 403 silenciosos
-- ================================================================

-- purchases
DROP POLICY IF EXISTS pur_select ON public.purchases;
DROP POLICY IF EXISTS "Purchases: Todos pueden ver" ON public.purchases;
CREATE POLICY pur_select ON public.purchases
  FOR SELECT TO authenticated USING (true);

-- purchase_items
DROP POLICY IF EXISTS pur_items_select ON public.purchase_items;
DROP POLICY IF EXISTS "PurchaseItems: Todos pueden ver" ON public.purchase_items;
CREATE POLICY pur_items_select ON public.purchase_items
  FOR SELECT TO authenticated USING (true);

-- suppliers
DROP POLICY IF EXISTS sup_select ON public.suppliers;
DROP POLICY IF EXISTS "Suppliers: Todos pueden ver" ON public.suppliers;
CREATE POLICY sup_select ON public.suppliers
  FOR SELECT TO authenticated USING (true);

-- inventory_movements
DROP POLICY IF EXISTS inv_mov_select ON public.inventory_movements;
DROP POLICY IF EXISTS "InventoryMovements: Todos pueden ver" ON public.inventory_movements;
CREATE POLICY inv_mov_select ON public.inventory_movements
  FOR SELECT TO authenticated USING (true);

-- order_parts
DROP POLICY IF EXISTS opart_select ON public.order_parts;
DROP POLICY IF EXISTS "Allow authenticated users to view order parts" ON public.order_parts;
CREATE POLICY opart_select ON public.order_parts
  FOR SELECT TO authenticated USING (true);

-- inventory
DROP POLICY IF EXISTS inv_select ON public.inventory;
CREATE POLICY inv_select ON public.inventory
  FOR SELECT TO authenticated USING (true);

-- customers
DROP POLICY IF EXISTS cust_select ON public.customers;
CREATE POLICY cust_select ON public.customers
  FOR SELECT TO authenticated USING (true);

-- orders
DROP POLICY IF EXISTS ord_select ON public.orders;
CREATE POLICY ord_select ON public.orders
  FOR SELECT TO authenticated USING (true);

-- payment_orders
DROP POLICY IF EXISTS po_all ON public.payment_orders;
DROP POLICY IF EXISTS po_select ON public.payment_orders;
CREATE POLICY po_select ON public.payment_orders
  FOR SELECT TO authenticated USING (true);
CREATE POLICY po_write ON public.payment_orders
  FOR ALL TO authenticated
  USING (business_id = public.current_user_business_id())
  WITH CHECK (business_id = public.current_user_business_id());

-- payment_transactions
DROP POLICY IF EXISTS pt_all ON public.payment_transactions;
DROP POLICY IF EXISTS pt_select ON public.payment_transactions;
CREATE POLICY pt_select ON public.payment_transactions
  FOR SELECT TO authenticated USING (true);
CREATE POLICY pt_write ON public.payment_transactions
  FOR ALL TO authenticated
  USING (business_id = public.current_user_business_id())
  WITH CHECK (business_id = public.current_user_business_id());

-- warranties
ALTER TABLE IF EXISTS public.warranties ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS warranties_select ON public.warranties;
CREATE POLICY warranties_select ON public.warranties
  FOR SELECT TO authenticated USING (true);

-- tasks
ALTER TABLE IF EXISTS public.tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tasks_select ON public.tasks;
CREATE POLICY tasks_select ON public.tasks
  FOR SELECT TO authenticated USING (true);

-- notifications
ALTER TABLE IF EXISTS public.notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notifications_select ON public.notifications;
CREATE POLICY notifications_select ON public.notifications
  FOR SELECT TO authenticated USING (true);

-- exchange_rates (ya tiene RLS con current_user_business_id — dejamos igual)
-- business_settings (ya tiene RLS con current_user_business_id — dejamos igual)
