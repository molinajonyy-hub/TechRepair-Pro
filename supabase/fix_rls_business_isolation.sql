-- =========================================================
-- CORRECCIÓN DE RLS PARA AISLAMIENTO POR BUSINESS_ID
-- Este script actualiza todas las políticas RLS para filtrar por business_id
-- Asegura que cada usuario solo vea sus propios datos
-- =========================================================

-- ============================================
-- 1. ORDERS - Órdenes de reparación
-- ============================================

ALTER TABLE IF EXISTS orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated users to view orders" ON orders;
DROP POLICY IF EXISTS "Allow authenticated users to insert orders" ON orders;
DROP POLICY IF EXISTS "Allow authenticated users to update orders" ON orders;
DROP POLICY IF EXISTS "Allow authenticated users to delete orders" ON orders;
DROP POLICY IF EXISTS "orders_select" ON orders;
DROP POLICY IF EXISTS "orders_insert" ON orders;
DROP POLICY IF EXISTS "orders_update" ON orders;
DROP POLICY IF EXISTS "orders_delete" ON orders;

CREATE POLICY "orders_select"
  ON orders FOR SELECT
  TO authenticated
  USING (business_id = public.current_user_business_id());

CREATE POLICY "orders_insert"
  ON orders FOR INSERT
  TO authenticated
  WITH CHECK (
    business_id = public.current_user_business_id()
    AND public.current_user_role() IN ('owner', 'admin', 'technician')
  );

CREATE POLICY "orders_update"
  ON orders FOR UPDATE
  TO authenticated
  USING (
    business_id = public.current_user_business_id()
    AND public.current_user_role() IN ('owner', 'admin', 'technician')
  )
  WITH CHECK (
    business_id = public.current_user_business_id()
    AND public.current_user_role() IN ('owner', 'admin', 'technician')
  );

CREATE POLICY "orders_delete"
  ON orders FOR DELETE
  TO authenticated
  USING (
    business_id = public.current_user_business_id()
    AND public.current_user_role() IN ('owner', 'admin')
  );

-- ============================================
-- 2. CUSTOMERS - Clientes
-- ============================================

ALTER TABLE IF EXISTS customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated users to view customers" ON customers;
DROP POLICY IF EXISTS "Allow authenticated users to insert customers" ON customers;
DROP POLICY IF EXISTS "Allow authenticated users to update customers" ON customers;
DROP POLICY IF EXISTS "Allow authenticated users to delete customers" ON customers;
DROP POLICY IF EXISTS "customers_select" ON customers;
DROP POLICY IF EXISTS "customers_insert" ON customers;
DROP POLICY IF EXISTS "customers_update" ON customers;
DROP POLICY IF EXISTS "customers_delete" ON customers;

CREATE POLICY "customers_select"
  ON customers FOR SELECT
  TO authenticated
  USING (business_id = public.current_user_business_id());

CREATE POLICY "customers_insert"
  ON customers FOR INSERT
  TO authenticated
  WITH CHECK (
    business_id = public.current_user_business_id()
    AND public.current_user_role() IN ('owner', 'admin', 'technician')
  );

CREATE POLICY "customers_update"
  ON customers FOR UPDATE
  TO authenticated
  USING (
    business_id = public.current_user_business_id()
    AND public.current_user_role() IN ('owner', 'admin', 'technician')
  )
  WITH CHECK (
    business_id = public.current_user_business_id()
    AND public.current_user_role() IN ('owner', 'admin', 'technician')
  );

CREATE POLICY "customers_delete"
  ON customers FOR DELETE
  TO authenticated
  USING (
    business_id = public.current_user_business_id()
    AND public.current_user_role() IN ('owner', 'admin')
  );

-- ============================================
-- 3. DEVICES - Dispositivos
-- ============================================

ALTER TABLE IF EXISTS devices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated users to view devices" ON devices;
DROP POLICY IF EXISTS "Allow authenticated users to insert devices" ON devices;
DROP POLICY IF EXISTS "Allow authenticated users to update devices" ON devices;
DROP POLICY IF EXISTS "Allow authenticated users to delete devices" ON devices;
DROP POLICY IF EXISTS "devices_select" ON devices;
DROP POLICY IF EXISTS "devices_insert" ON devices;
DROP POLICY IF EXISTS "devices_update" ON devices;
DROP POLICY IF EXISTS "devices_delete" ON devices;

CREATE POLICY "devices_select"
  ON devices FOR SELECT
  TO authenticated
  USING (
    customer_id IN (
      SELECT id FROM customers 
      WHERE business_id = public.current_user_business_id()
    )
  );

CREATE POLICY "devices_insert"
  ON devices FOR INSERT
  TO authenticated
  WITH CHECK (
    customer_id IN (
      SELECT id FROM customers 
      WHERE business_id = public.current_user_business_id()
    )
    AND public.current_user_role() IN ('owner', 'admin', 'technician')
  );

CREATE POLICY "devices_update"
  ON devices FOR UPDATE
  TO authenticated
  USING (
    customer_id IN (
      SELECT id FROM customers 
      WHERE business_id = public.current_user_business_id()
    )
    AND public.current_user_role() IN ('owner', 'admin', 'technician')
  )
  WITH CHECK (
    customer_id IN (
      SELECT id FROM customers 
      WHERE business_id = public.current_user_business_id()
    )
    AND public.current_user_role() IN ('owner', 'admin', 'technician')
  );

CREATE POLICY "devices_delete"
  ON devices FOR DELETE
  TO authenticated
  USING (
    customer_id IN (
      SELECT id FROM customers 
      WHERE business_id = public.current_user_business_id()
    )
    AND public.current_user_role() IN ('owner', 'admin')
  );

-- ============================================
-- 4. INVENTORY - Inventario
-- ============================================

ALTER TABLE IF EXISTS inventory ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated users to view inventory" ON inventory;
DROP POLICY IF EXISTS "Allow authenticated users to insert inventory" ON inventory;
DROP POLICY IF EXISTS "Allow authenticated users to update inventory" ON inventory;
DROP POLICY IF EXISTS "Allow authenticated users to delete inventory" ON inventory;
DROP POLICY IF EXISTS "inventory_select" ON inventory;
DROP POLICY IF EXISTS "inventory_insert" ON inventory;
DROP POLICY IF EXISTS "inventory_update" ON inventory;
DROP POLICY IF EXISTS "inventory_delete" ON inventory;

CREATE POLICY "inventory_select"
  ON inventory FOR SELECT
  TO authenticated
  USING (true); -- Inventory puede ser compartido o ajustar según requerimiento

CREATE POLICY "inventory_insert"
  ON inventory FOR INSERT
  TO authenticated
  WITH CHECK (public.current_user_role() IN ('owner', 'admin'));

CREATE POLICY "inventory_update"
  ON inventory FOR UPDATE
  TO authenticated
  USING (public.current_user_role() IN ('owner', 'admin'))
  WITH CHECK (public.current_user_role() IN ('owner', 'admin'));

CREATE POLICY "inventory_delete"
  ON inventory FOR DELETE
  TO authenticated
  USING (public.current_user_role() IN ('owner', 'admin'));

-- ============================================
-- 5. ORDER_PAYMENTS - Pagos
-- ============================================

ALTER TABLE IF EXISTS order_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated users to view payments" ON order_payments;
DROP POLICY IF EXISTS "Allow authenticated users to insert payments" ON order_payments;
DROP POLICY IF EXISTS "Allow authenticated users to update payments" ON order_payments;
DROP POLICY IF EXISTS "Allow authenticated users to delete payments" ON order_payments;
DROP POLICY IF EXISTS "order_payments_select" ON order_payments;
DROP POLICY IF EXISTS "order_payments_insert" ON order_payments;
DROP POLICY IF EXISTS "order_payments_update" ON order_payments;
DROP POLICY IF EXISTS "order_payments_delete" ON order_payments;

CREATE POLICY "order_payments_select"
  ON order_payments FOR SELECT
  TO authenticated
  USING (
    order_id IN (
      SELECT id FROM orders 
      WHERE business_id = public.current_user_business_id()
    )
  );

CREATE POLICY "order_payments_insert"
  ON order_payments FOR INSERT
  TO authenticated
  WITH CHECK (
    order_id IN (
      SELECT id FROM orders 
      WHERE business_id = public.current_user_business_id()
    )
    AND public.current_user_role() IN ('owner', 'admin', 'technician')
  );

CREATE POLICY "order_payments_update"
  ON order_payments FOR UPDATE
  TO authenticated
  USING (
    order_id IN (
      SELECT id FROM orders 
      WHERE business_id = public.current_user_business_id()
    )
    AND public.current_user_role() IN ('owner', 'admin')
  )
  WITH CHECK (
    order_id IN (
      SELECT id FROM orders 
      WHERE business_id = public.current_user_business_id()
    )
    AND public.current_user_role() IN ('owner', 'admin')
  );

CREATE POLICY "order_payments_delete"
  ON order_payments FOR DELETE
  TO authenticated
  USING (
    order_id IN (
      SELECT id FROM orders 
      WHERE business_id = public.current_user_business_id()
    )
    AND public.current_user_role() IN ('owner', 'admin')
  );

-- ============================================
-- 6. ORDER_PARTS - Repuestos de órdenes
-- ============================================

ALTER TABLE IF EXISTS order_parts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated users to view order parts" ON order_parts;
DROP POLICY IF EXISTS "Allow authenticated users to insert order parts" ON order_parts;
DROP POLICY IF EXISTS "Allow authenticated users to update order parts" ON order_parts;
DROP POLICY IF EXISTS "Allow authenticated users to delete order parts" ON order_parts;
DROP POLICY IF EXISTS "order_parts_select" ON order_parts;
DROP POLICY IF EXISTS "order_parts_insert" ON order_parts;
DROP POLICY IF EXISTS "order_parts_update" ON order_parts;
DROP POLICY IF EXISTS "order_parts_delete" ON order_parts;

CREATE POLICY "order_parts_select"
  ON order_parts FOR SELECT
  TO authenticated
  USING (
    order_id IN (
      SELECT id FROM orders 
      WHERE business_id = public.current_user_business_id()
    )
  );

CREATE POLICY "order_parts_insert"
  ON order_parts FOR INSERT
  TO authenticated
  WITH CHECK (
    order_id IN (
      SELECT id FROM orders 
      WHERE business_id = public.current_user_business_id()
    )
    AND public.current_user_role() IN ('owner', 'admin', 'technician')
  );

CREATE POLICY "order_parts_update"
  ON order_parts FOR UPDATE
  TO authenticated
  USING (
    order_id IN (
      SELECT id FROM orders 
      WHERE business_id = public.current_user_business_id()
    )
    AND public.current_user_role() IN ('owner', 'admin', 'technician')
  )
  WITH CHECK (
    order_id IN (
      SELECT id FROM orders 
      WHERE business_id = public.current_user_business_id()
    )
    AND public.current_user_role() IN ('owner', 'admin', 'technician')
  );

CREATE POLICY "order_parts_delete"
  ON order_parts FOR DELETE
  TO authenticated
  USING (
    order_id IN (
      SELECT id FROM orders 
      WHERE business_id = public.current_user_business_id()
    )
    AND public.current_user_role() IN ('owner', 'admin')
  );

-- ============================================
-- 7. STATUS_HISTORY - Historial de estados
-- ============================================

ALTER TABLE IF EXISTS status_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated users to view status history" ON status_history;
DROP POLICY IF EXISTS "Allow authenticated users to insert status history" ON status_history;
DROP POLICY IF EXISTS "status_history_select" ON status_history;
DROP POLICY IF EXISTS "status_history_insert" ON status_history;

CREATE POLICY "status_history_select"
  ON status_history FOR SELECT
  TO authenticated
  USING (
    order_id IN (
      SELECT id FROM orders 
      WHERE business_id = public.current_user_business_id()
    )
  );

CREATE POLICY "status_history_insert"
  ON status_history FOR INSERT
  TO authenticated
  WITH CHECK (
    order_id IN (
      SELECT id FROM orders 
      WHERE business_id = public.current_user_business_id()
    )
    AND public.current_user_role() IN ('owner', 'admin', 'technician')
  );

-- ============================================
-- 8. NOTIFICATIONS - Notificaciones
-- ============================================

ALTER TABLE IF EXISTS notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated users to view notifications" ON notifications;
DROP POLICY IF EXISTS "Allow authenticated users to insert notifications" ON notifications;
DROP POLICY IF EXISTS "Allow authenticated users to update notifications" ON notifications;
DROP POLICY IF EXISTS "notifications_select" ON notifications;
DROP POLICY IF EXISTS "notifications_insert" ON notifications;
DROP POLICY IF EXISTS "notifications_update" ON notifications;

CREATE POLICY "notifications_select"
  ON notifications FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR (business_id = public.current_user_business_id() AND public.current_user_role() IN ('owner', 'admin'))
  );

CREATE POLICY "notifications_insert"
  ON notifications FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    OR (business_id = public.current_user_business_id() AND public.current_user_role() IN ('owner', 'admin'))
  );

CREATE POLICY "notifications_update"
  ON notifications FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ============================================
-- 9. ORDER_CHECKLISTS - Checklists
-- ============================================

ALTER TABLE IF EXISTS order_checklists ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated users to view checklists" ON order_checklists;
DROP POLICY IF EXISTS "Allow authenticated users to insert checklists" ON order_checklists;
DROP POLICY IF EXISTS "Allow authenticated users to update checklists" ON order_checklists;
DROP POLICY IF EXISTS "order_checklists_select" ON order_checklists;
DROP POLICY IF EXISTS "order_checklists_insert" ON order_checklists;
DROP POLICY IF EXISTS "order_checklists_update" ON order_checklists;

CREATE POLICY "order_checklists_select"
  ON order_checklists FOR SELECT
  TO authenticated
  USING (
    order_id IN (
      SELECT id FROM orders 
      WHERE business_id = public.current_user_business_id()
    )
  );

CREATE POLICY "order_checklists_insert"
  ON order_checklists FOR INSERT
  TO authenticated
  WITH CHECK (
    order_id IN (
      SELECT id FROM orders 
      WHERE business_id = public.current_user_business_id()
    )
    AND public.current_user_role() IN ('owner', 'admin', 'technician')
  );

CREATE POLICY "order_checklists_update"
  ON order_checklists FOR UPDATE
  TO authenticated
  USING (
    order_id IN (
      SELECT id FROM orders 
      WHERE business_id = public.current_user_business_id()
    )
    AND public.current_user_role() IN ('owner', 'admin', 'technician')
  )
  WITH CHECK (
    order_id IN (
      SELECT id FROM orders 
      WHERE business_id = public.current_user_business_id()
    )
    AND public.current_user_role() IN ('owner', 'admin', 'technician')
  );

-- ============================================
-- 10. DOCUMENTS - Documentos
-- ============================================

ALTER TABLE IF EXISTS documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated users to view documents" ON documents;
DROP POLICY IF EXISTS "Allow authenticated users to insert documents" ON documents;
DROP POLICY IF EXISTS "Allow authenticated users to delete documents" ON documents;
DROP POLICY IF EXISTS "documents_select" ON documents;
DROP POLICY IF EXISTS "documents_insert" ON documents;
DROP POLICY IF EXISTS "documents_delete" ON documents;

CREATE POLICY "documents_select"
  ON documents FOR SELECT
  TO authenticated
  USING (
    order_id IN (
      SELECT id FROM orders 
      WHERE business_id = public.current_user_business_id()
    )
  );

CREATE POLICY "documents_insert"
  ON documents FOR INSERT
  TO authenticated
  WITH CHECK (
    order_id IN (
      SELECT id FROM orders 
      WHERE business_id = public.current_user_business_id()
    )
    AND public.current_user_role() IN ('owner', 'admin', 'technician')
  );

CREATE POLICY "documents_delete"
  ON documents FOR DELETE
  TO authenticated
  USING (
    order_id IN (
      SELECT id FROM orders 
      WHERE business_id = public.current_user_business_id()
    )
    AND public.current_user_role() IN ('owner', 'admin')
  );

-- ============================================
-- 11. USERS - Usuarios (solo lectura para autenticados)
-- ============================================

ALTER TABLE IF EXISTS users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated users to view users" ON users;
DROP POLICY IF EXISTS "users_select" ON users;

CREATE POLICY "users_select"
  ON users FOR SELECT
  TO authenticated
  USING (business_id = public.current_user_business_id());

-- ============================================
-- 12. SUPPLIERS - Proveedores
-- ============================================

ALTER TABLE IF EXISTS suppliers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "suppliers_select" ON suppliers;
DROP POLICY IF EXISTS "suppliers_insert" ON suppliers;
DROP POLICY IF EXISTS "suppliers_update" ON suppliers;
DROP POLICY IF EXISTS "suppliers_delete" ON suppliers;

CREATE POLICY "suppliers_select"
  ON suppliers FOR SELECT
  TO authenticated
  USING (true); -- Suppliers pueden ser globales o ajustar según requerimiento

CREATE POLICY "suppliers_insert"
  ON suppliers FOR INSERT
  TO authenticated
  WITH CHECK (public.current_user_role() IN ('owner', 'admin'));

CREATE POLICY "suppliers_update"
  ON suppliers FOR UPDATE
  TO authenticated
  USING (public.current_user_role() IN ('owner', 'admin'))
  WITH CHECK (public.current_user_role() IN ('owner', 'admin'));

CREATE POLICY "suppliers_delete"
  ON suppliers FOR DELETE
  TO authenticated
  USING (public.current_user_role() IN ('owner', 'admin'));

-- ============================================
-- 13. EXPENSES - Gastos
-- ============================================

ALTER TABLE IF EXISTS expenses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "expenses_select" ON expenses;
DROP POLICY IF EXISTS "expenses_insert" ON expenses;
DROP POLICY IF EXISTS "expenses_update" ON expenses;
DROP POLICY IF EXISTS "expenses_delete" ON expenses;

CREATE POLICY "expenses_select"
  ON expenses FOR SELECT
  TO authenticated
  USING (true); -- Expenses pueden ser globales o ajustar según requerimiento

CREATE POLICY "expenses_insert"
  ON expenses FOR INSERT
  TO authenticated
  WITH CHECK (public.current_user_role() IN ('owner', 'admin'));

CREATE POLICY "expenses_update"
  ON expenses FOR UPDATE
  TO authenticated
  USING (public.current_user_role() IN ('owner', 'admin'))
  WITH CHECK (public.current_user_role() IN ('owner', 'admin'));

CREATE POLICY "expenses_delete"
  ON expenses FOR DELETE
  TO authenticated
  USING (public.current_user_role() IN ('owner', 'admin'));

-- ============================================
-- 14. COMPROBANTES - Comprobantes
-- ============================================

ALTER TABLE IF EXISTS comprobantes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "comprobantes_select" ON comprobantes;
DROP POLICY IF EXISTS "comprobantes_insert" ON comprobantes;
DROP POLICY IF EXISTS "comprobantes_update" ON comprobantes;
DROP POLICY IF EXISTS "comprobantes_delete" ON comprobantes;

CREATE POLICY "comprobantes_select"
  ON comprobantes FOR SELECT
  TO authenticated
  USING (
    order_id IN (
      SELECT id FROM orders 
      WHERE business_id = public.current_user_business_id()
    )
  );

CREATE POLICY "comprobantes_insert"
  ON comprobantes FOR INSERT
  TO authenticated
  WITH CHECK (
    order_id IN (
      SELECT id FROM orders 
      WHERE business_id = public.current_user_business_id()
    )
    AND public.current_user_role() IN ('owner', 'admin')
  );

CREATE POLICY "comprobantes_update"
  ON comprobantes FOR UPDATE
  TO authenticated
  USING (
    order_id IN (
      SELECT id FROM orders 
      WHERE business_id = public.current_user_business_id()
    )
    AND public.current_user_role() IN ('owner', 'admin')
  )
  WITH CHECK (
    order_id IN (
      SELECT id FROM orders 
      WHERE business_id = public.current_user_business_id()
    )
    AND public.current_user_role() IN ('owner', 'admin')
  );

CREATE POLICY "comprobantes_delete"
  ON comprobantes FOR DELETE
  TO authenticated
  USING (
    order_id IN (
      SELECT id FROM orders 
      WHERE business_id = public.current_user_business_id()
    )
    AND public.current_user_role() IN ('owner', 'admin')
  );

-- ============================================
-- 15. EXCHANGE_RATES - Tipos de cambio
-- ============================================

ALTER TABLE IF EXISTS exchange_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "exchange_rates_select" ON exchange_rates;
DROP POLICY IF EXISTS "exchange_rates_insert" ON exchange_rates;
DROP POLICY IF EXISTS "exchange_rates_update" ON exchange_rates;

CREATE POLICY "exchange_rates_select"
  ON exchange_rates FOR SELECT
  TO authenticated
  USING (true); -- Exchange rates son globales

CREATE POLICY "exchange_rates_insert"
  ON exchange_rates FOR INSERT
  TO authenticated
  WITH CHECK (public.current_user_role() IN ('owner', 'admin'));

CREATE POLICY "exchange_rates_update"
  ON exchange_rates FOR UPDATE
  TO authenticated
  USING (public.current_user_role() IN ('owner', 'admin'))
  WITH CHECK (public.current_user_role() IN ('owner', 'admin'));

-- ============================================
-- VERIFICACIÓN
-- ============================================

-- Verificar que las políticas se crearon correctamente
SELECT 
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd
FROM pg_policies 
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
