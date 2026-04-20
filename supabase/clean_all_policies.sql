-- ============================================
-- HABILITAR RLS CON POLÍTICAS PERMISIVAS PARA DESARROLLO
-- ============================================

-- Eliminar todas las políticas primero
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN 
    SELECT schemaname, tablename, policyname 
    FROM pg_policies 
    WHERE schemaname = 'public'
  LOOP
    BEGIN
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Error dropping policy % on %.%: %', pol.policyname, pol.schemaname, pol.tablename, SQLERRM;
    END;
  END LOOP;
END $$;

-- Habilitar RLS y crear políticas permisivas para todas las tablas

-- ORDERS
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "orders_select" ON orders FOR SELECT TO authenticated USING (true);
CREATE POLICY "orders_insert" ON orders FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "orders_update" ON orders FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "orders_delete" ON orders FOR DELETE TO authenticated USING (true);

-- CUSTOMERS
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "customers_select" ON customers FOR SELECT TO authenticated USING (true);
CREATE POLICY "customers_insert" ON customers FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "customers_update" ON customers FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "customers_delete" ON customers FOR DELETE TO authenticated USING (true);

-- DEVICES
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "devices_select" ON devices FOR SELECT TO authenticated USING (true);
CREATE POLICY "devices_insert" ON devices FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "devices_update" ON devices FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "devices_delete" ON devices FOR DELETE TO authenticated USING (true);

-- INVENTORY
ALTER TABLE inventory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "inventory_select" ON inventory FOR SELECT TO authenticated USING (true);
CREATE POLICY "inventory_insert" ON inventory FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "inventory_update" ON inventory FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "inventory_delete" ON inventory FOR DELETE TO authenticated USING (true);

-- ORDER_PAYMENTS
ALTER TABLE order_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "order_payments_select" ON order_payments FOR SELECT TO authenticated USING (true);
CREATE POLICY "order_payments_insert" ON order_payments FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "order_payments_update" ON order_payments FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "order_payments_delete" ON order_payments FOR DELETE TO authenticated USING (true);

-- ORDER_PARTS
ALTER TABLE order_parts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "order_parts_select" ON order_parts FOR SELECT TO authenticated USING (true);
CREATE POLICY "order_parts_insert" ON order_parts FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "order_parts_update" ON order_parts FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "order_parts_delete" ON order_parts FOR DELETE TO authenticated USING (true);

-- STATUS_HISTORY
ALTER TABLE status_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "status_history_select" ON status_history FOR SELECT TO authenticated USING (true);
CREATE POLICY "status_history_insert" ON status_history FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "status_history_update" ON status_history FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "status_history_delete" ON status_history FOR DELETE TO authenticated USING (true);

-- NOTIFICATIONS
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notifications_select" ON notifications FOR SELECT TO authenticated USING (true);
CREATE POLICY "notifications_insert" ON notifications FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "notifications_update" ON notifications FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "notifications_delete" ON notifications FOR DELETE TO authenticated USING (true);

-- ORDER_CHECKLISTS
ALTER TABLE order_checklists ENABLE ROW LEVEL SECURITY;
CREATE POLICY "order_checklists_select" ON order_checklists FOR SELECT TO authenticated USING (true);
CREATE POLICY "order_checklists_insert" ON order_checklists FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "order_checklists_update" ON order_checklists FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "order_checklists_delete" ON order_checklists FOR DELETE TO authenticated USING (true);

-- DOCUMENTS
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "documents_select" ON documents FOR SELECT TO authenticated USING (true);
CREATE POLICY "documents_insert" ON documents FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "documents_update" ON documents FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "documents_delete" ON documents FOR DELETE TO authenticated USING (true);

-- DEVICE_INSPECTIONS
ALTER TABLE device_inspections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "device_inspections_select" ON device_inspections FOR SELECT TO authenticated USING (true);
CREATE POLICY "device_inspections_insert" ON device_inspections FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "device_inspections_update" ON device_inspections FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "device_inspections_delete" ON device_inspections FOR DELETE TO authenticated USING (true);

-- EXPENSES
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "expenses_select" ON expenses FOR SELECT TO authenticated USING (true);
CREATE POLICY "expenses_insert" ON expenses FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "expenses_update" ON expenses FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "expenses_delete" ON expenses FOR DELETE TO authenticated USING (true);

-- NOTES
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notes_select" ON notes FOR SELECT TO authenticated USING (true);
CREATE POLICY "notes_insert" ON notes FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "notes_update" ON notes FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "notes_delete" ON notes FOR DELETE TO authenticated USING (true);

-- PARTS_USED
ALTER TABLE parts_used ENABLE ROW LEVEL SECURITY;
CREATE POLICY "parts_used_select" ON parts_used FOR SELECT TO authenticated USING (true);
CREATE POLICY "parts_used_insert" ON parts_used FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "parts_used_update" ON parts_used FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "parts_used_delete" ON parts_used FOR DELETE TO authenticated USING (true);

-- SUPPLIERS
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "suppliers_select" ON suppliers FOR SELECT TO authenticated USING (true);
CREATE POLICY "suppliers_insert" ON suppliers FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "suppliers_update" ON suppliers FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "suppliers_delete" ON suppliers FOR DELETE TO authenticated USING (true);

-- USERS
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_select" ON users FOR SELECT TO authenticated USING (true);
CREATE POLICY "users_insert" ON users FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "users_update" ON users FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "users_delete" ON users FOR DELETE TO authenticated USING (true);

-- Verificar
SELECT 
  relname as tabla,
  CASE WHEN relrowsecurity THEN '✅ RLS ACTIVO' ELSE '❌ RLS DESACTIVADO' END as estado
FROM pg_class
WHERE relname IN ('orders', 'customers', 'devices', 'inventory', 'order_payments', 'order_parts', 'status_history', 'notifications', 'order_checklists', 'documents', 'device_inspections', 'expenses', 'notes', 'parts_used', 'suppliers', 'users')
AND relkind = 'r';
