-- ============================================
-- HABILITAR RLS + POLÍTICA PERMISIVA
-- ============================================

-- Habilitar RLS en todas las tablas
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

-- Eliminar políticas viejas y crear una sola permisiva
DROP POLICY IF EXISTS "allow_all_orders" ON orders;
DROP POLICY IF EXISTS "allow_all_customers" ON customers;
DROP POLICY IF EXISTS "allow_all_devices" ON devices;
DROP POLICY IF EXISTS "allow_all_inventory" ON inventory;
DROP POLICY IF EXISTS "allow_all_order_payments" ON order_payments;
DROP POLICY IF EXISTS "allow_all_order_parts" ON order_parts;
DROP POLICY IF EXISTS "allow_all_status_history" ON status_history;
DROP POLICY IF EXISTS "allow_all_notifications" ON notifications;
DROP POLICY IF EXISTS "allow_all_order_checklists" ON order_checklists;
DROP POLICY IF EXISTS "allow_all_documents" ON documents;
DROP POLICY IF EXISTS "allow_all_device_inspections" ON device_inspections;

-- Crear política única: permite todo a todos (anon + authenticated)
CREATE POLICY "allow_all_orders" ON orders FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_customers" ON customers FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_devices" ON devices FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_inventory" ON inventory FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_order_payments" ON order_payments FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_order_parts" ON order_parts FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_status_history" ON status_history FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_notifications" ON notifications FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_order_checklists" ON order_checklists FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_documents" ON documents FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_device_inspections" ON device_inspections FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- Verificar
SELECT tablename, policyname, roles::text, cmd 
FROM pg_policies 
WHERE schemaname = 'public' 
ORDER BY tablename;
