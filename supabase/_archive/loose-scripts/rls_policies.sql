-- ============================================
-- POLÍTICAS RLS PARA TODAS LAS TABLAS
-- Ejecutar en Supabase SQL Editor
-- ============================================

-- ============================================
-- 1. ORDERS - Órdenes de reparación
-- ============================================

-- Asegurar que RLS está habilitado
ALTER TABLE IF EXISTS orders ENABLE ROW LEVEL SECURITY;

-- Eliminar políticas existentes
DROP POLICY IF EXISTS "Allow authenticated users to view orders" ON orders;
DROP POLICY IF EXISTS "Allow authenticated users to insert orders" ON orders;
DROP POLICY IF EXISTS "Allow authenticated users to update orders" ON orders;
DROP POLICY IF EXISTS "Allow authenticated users to delete orders" ON orders;

-- Crear políticas
CREATE POLICY "Allow authenticated users to view orders"
  ON orders FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to insert orders"
  ON orders FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Allow authenticated users to update orders"
  ON orders FOR UPDATE
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to delete orders"
  ON orders FOR DELETE
  TO authenticated
  USING (true);

-- ============================================
-- 2. CUSTOMERS - Clientes
-- ============================================

ALTER TABLE IF EXISTS customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated users to view customers" ON customers;
DROP POLICY IF EXISTS "Allow authenticated users to insert customers" ON customers;
DROP POLICY IF EXISTS "Allow authenticated users to update customers" ON customers;
DROP POLICY IF EXISTS "Allow authenticated users to delete customers" ON customers;

CREATE POLICY "Allow authenticated users to view customers"
  ON customers FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to insert customers"
  ON customers FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Allow authenticated users to update customers"
  ON customers FOR UPDATE
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to delete customers"
  ON customers FOR DELETE
  TO authenticated
  USING (true);

-- ============================================
-- 3. DEVICES - Dispositivos
-- ============================================

ALTER TABLE IF EXISTS devices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated users to view devices" ON devices;
DROP POLICY IF EXISTS "Allow authenticated users to insert devices" ON devices;
DROP POLICY IF EXISTS "Allow authenticated users to update devices" ON devices;
DROP POLICY IF EXISTS "Allow authenticated users to delete devices" ON devices;

CREATE POLICY "Allow authenticated users to view devices"
  ON devices FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to insert devices"
  ON devices FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Allow authenticated users to update devices"
  ON devices FOR UPDATE
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to delete devices"
  ON devices FOR DELETE
  TO authenticated
  USING (true);

-- ============================================
-- 4. INVENTORY - Inventario
-- ============================================

ALTER TABLE IF EXISTS inventory ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated users to view inventory" ON inventory;
DROP POLICY IF EXISTS "Allow authenticated users to insert inventory" ON inventory;
DROP POLICY IF EXISTS "Allow authenticated users to update inventory" ON inventory;
DROP POLICY IF EXISTS "Allow authenticated users to delete inventory" ON inventory;

CREATE POLICY "Allow authenticated users to view inventory"
  ON inventory FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to insert inventory"
  ON inventory FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Allow authenticated users to update inventory"
  ON inventory FOR UPDATE
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to delete inventory"
  ON inventory FOR DELETE
  TO authenticated
  USING (true);

-- ============================================
-- 5. ORDER_PAYMENTS - Pagos
-- ============================================

ALTER TABLE IF EXISTS order_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated users to view payments" ON order_payments;
DROP POLICY IF EXISTS "Allow authenticated users to insert payments" ON order_payments;
DROP POLICY IF EXISTS "Allow authenticated users to update payments" ON order_payments;
DROP POLICY IF EXISTS "Allow authenticated users to delete payments" ON order_payments;

CREATE POLICY "Allow authenticated users to view payments"
  ON order_payments FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to insert payments"
  ON order_payments FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Allow authenticated users to update payments"
  ON order_payments FOR UPDATE
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to delete payments"
  ON order_payments FOR DELETE
  TO authenticated
  USING (true);

-- ============================================
-- 6. ORDER_PARTS - Repuestos de órdenes
-- ============================================

ALTER TABLE IF EXISTS order_parts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated users to view order parts" ON order_parts;
DROP POLICY IF EXISTS "Allow authenticated users to insert order parts" ON order_parts;
DROP POLICY IF EXISTS "Allow authenticated users to update order parts" ON order_parts;
DROP POLICY IF EXISTS "Allow authenticated users to delete order parts" ON order_parts;

CREATE POLICY "Allow authenticated users to view order parts"
  ON order_parts FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to insert order parts"
  ON order_parts FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Allow authenticated users to update order parts"
  ON order_parts FOR UPDATE
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to delete order parts"
  ON order_parts FOR DELETE
  TO authenticated
  USING (true);

-- ============================================
-- 7. STATUS_HISTORY - Historial de estados
-- ============================================

ALTER TABLE IF EXISTS status_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated users to view status history" ON status_history;
DROP POLICY IF EXISTS "Allow authenticated users to insert status history" ON status_history;

CREATE POLICY "Allow authenticated users to view status history"
  ON status_history FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to insert status history"
  ON status_history FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- ============================================
-- 8. NOTIFICATIONS - Notificaciones
-- ============================================

ALTER TABLE IF EXISTS notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated users to view notifications" ON notifications;
DROP POLICY IF EXISTS "Allow authenticated users to insert notifications" ON notifications;
DROP POLICY IF EXISTS "Allow authenticated users to update notifications" ON notifications;

CREATE POLICY "Allow authenticated users to view notifications"
  ON notifications FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to insert notifications"
  ON notifications FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Allow authenticated users to update notifications"
  ON notifications FOR UPDATE
  TO authenticated
  USING (true);

-- ============================================
-- 9. ORDER_CHECKLISTS - Checklists
-- ============================================

ALTER TABLE IF EXISTS order_checklists ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated users to view checklists" ON order_checklists;
DROP POLICY IF EXISTS "Allow authenticated users to insert checklists" ON order_checklists;
DROP POLICY IF EXISTS "Allow authenticated users to update checklists" ON order_checklists;

CREATE POLICY "Allow authenticated users to view checklists"
  ON order_checklists FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to insert checklists"
  ON order_checklists FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Allow authenticated users to update checklists"
  ON order_checklists FOR UPDATE
  TO authenticated
  USING (true);

-- ============================================
-- 10. DOCUMENTS - Documentos
-- ============================================

ALTER TABLE IF EXISTS documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated users to view documents" ON documents;
DROP POLICY IF EXISTS "Allow authenticated users to insert documents" ON documents;
DROP POLICY IF EXISTS "Allow authenticated users to delete documents" ON documents;

CREATE POLICY "Allow authenticated users to view documents"
  ON documents FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to insert documents"
  ON documents FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Allow authenticated users to delete documents"
  ON documents FOR DELETE
  TO authenticated
  USING (true);

-- ============================================
-- 11. USERS - Usuarios (solo lectura para autenticados)
-- ============================================

ALTER TABLE IF EXISTS users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated users to view users" ON users;

CREATE POLICY "Allow authenticated users to view users"
  ON users FOR SELECT
  TO authenticated
  USING (true);

-- ============================================
-- VERIFICACIÓN
-- ============================================

-- Verificar que las políticas se crearon
SELECT 
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual
FROM pg_policies 
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
