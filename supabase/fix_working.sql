-- ============================================
-- FIX DEFINITIVO - Versión corregida
-- ============================================

-- 1. Deshabilitar RLS en TODAS las tablas (ignora errores)
DO $$
BEGIN
  EXECUTE 'ALTER TABLE IF EXISTS orders DISABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE IF EXISTS customers DISABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE IF EXISTS devices DISABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE IF EXISTS inventory DISABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE IF EXISTS order_payments DISABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE IF EXISTS order_parts DISABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE IF EXISTS status_history DISABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE IF EXISTS notifications DISABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE IF EXISTS order_checklists DISABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE IF EXISTS documents DISABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE IF EXISTS device_inspections DISABLE ROW LEVEL SECURITY';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Error deshabilitando RLS: %', SQLERRM;
END $$;

-- 2. Eliminar políticas individualmente por tabla
DO $$
BEGIN
  -- Customers
  DROP POLICY IF EXISTS "Enable all access for users" ON customers;
  DROP POLICY IF EXISTS "Allow authenticated users to view customers" ON customers;
  DROP POLICY IF EXISTS "Allow authenticated users to insert customers" ON customers;
  DROP POLICY IF EXISTS "Allow authenticated users to update customers" ON customers;
  DROP POLICY IF EXISTS "Allow authenticated users to delete customers" ON customers;
  DROP POLICY IF EXISTS "allow_anon_all_customers" ON customers;
  DROP POLICY IF EXISTS "allow_auth_all_customers" ON customers;
  DROP POLICY IF EXISTS "allow_all_customers" ON customers;
  DROP POLICY IF EXISTS "view_customers" ON customers;
  DROP POLICY IF EXISTS "insert_customers" ON customers;
  DROP POLICY IF EXISTS "update_customers" ON customers;
  DROP POLICY IF EXISTS "delete_customers" ON customers;
  
  -- Orders
  DROP POLICY IF EXISTS "allow_all_orders" ON orders;
  DROP POLICY IF EXISTS "view_orders" ON orders;
  DROP POLICY IF EXISTS "insert_orders" ON orders;
  DROP POLICY IF EXISTS "update_orders" ON orders;
  DROP POLICY IF EXISTS "delete_orders" ON orders;
  
  -- Devices
  DROP POLICY IF EXISTS "allow_all_devices" ON devices;
  
  -- Inventory
  DROP POLICY IF EXISTS "allow_all_inventory" ON inventory;
  
  -- Otros
  DROP POLICY IF EXISTS "allow_all_order_payments" ON order_payments;
  DROP POLICY IF EXISTS "allow_all_order_parts" ON order_parts;
  DROP POLICY IF EXISTS "allow_all_status_history" ON status_history;
  DROP POLICY IF EXISTS "allow_all_notifications" ON notifications;
  DROP POLICY IF EXISTS "allow_all_order_checklists" ON order_checklists;
  DROP POLICY IF EXISTS "allow_all_documents" ON documents;
  DROP POLICY IF EXISTS "allow_all_device_inspections" ON device_inspections;
  
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Error eliminando políticas: %', SQLERRM;
END $$;

-- 3. Ahora habilitar RLS y crear política simple
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_checklists ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_inspections ENABLE ROW LEVEL SECURITY;

-- 4. Crear política permisiva para TODOS (anon + authenticated)
CREATE POLICY "allow_all" ON orders FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON customers FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON devices FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON inventory FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON order_payments FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON order_parts FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON status_history FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON notifications FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON order_checklists FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON documents FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON device_inspections FOR ALL USING (true) WITH CHECK (true);

-- 5. Verificar
SELECT 
  tablename,
  (SELECT relrowsecurity FROM pg_class WHERE relname = tablename) as rls_enabled,
  COUNT(*) as politicas
FROM pg_policies 
WHERE schemaname = 'public'
GROUP BY tablename
ORDER BY tablename;
