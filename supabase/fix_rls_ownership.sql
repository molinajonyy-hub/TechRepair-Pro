-- ============================================
-- POLÍTICAS RLS BASADAS EN OWNERSHIP
-- ============================================

-- 1. Eliminar todas las políticas existentes
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
      EXECUTE format('DROP POLICY IF EXISTS "%I" ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;
END $$;

-- 2. Agregar columna created_by si no existe (para tablas que no la tienen)
DO $$
BEGIN
  -- Orders
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'created_by') THEN
    ALTER TABLE orders ADD COLUMN created_by UUID REFERENCES auth.users(id);
  END IF;
  
  -- Customers
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'created_by') THEN
    ALTER TABLE customers ADD COLUMN created_by UUID REFERENCES auth.users(id);
  END IF;
  
  -- Devices
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'devices' AND column_name = 'created_by') THEN
    ALTER TABLE devices ADD COLUMN created_by UUID REFERENCES auth.users(id);
  END IF;
  
  -- Inventory
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'inventory' AND column_name = 'created_by') THEN
    ALTER TABLE inventory ADD COLUMN created_by UUID REFERENCES auth.users(id);
  END IF;
  
  -- Order Payments
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'order_payments' AND column_name = 'created_by') THEN
    ALTER TABLE order_payments ADD COLUMN created_by UUID REFERENCES auth.users(id);
  END IF;
  
  -- Order Parts
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'order_parts' AND column_name = 'created_by') THEN
    ALTER TABLE order_parts ADD COLUMN created_by UUID REFERENCES auth.users(id);
  END IF;
  
  -- Notifications
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'notifications' AND column_name = 'created_by') THEN
    ALTER TABLE notifications ADD COLUMN created_by UUID REFERENCES auth.users(id);
  END IF;
  
  -- Order Checklists
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'order_checklists' AND column_name = 'created_by') THEN
    ALTER TABLE order_checklists ADD COLUMN created_by UUID REFERENCES auth.users(id);
  END IF;
  
  -- Documents
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'created_by') THEN
    ALTER TABLE documents ADD COLUMN created_by UUID REFERENCES auth.users(id);
  END IF;
  
  -- Device Inspections
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'device_inspections' AND column_name = 'created_by') THEN
    ALTER TABLE device_inspections ADD COLUMN created_by UUID REFERENCES auth.users(id);
  END IF;
  
  -- Expenses
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'expenses' AND column_name = 'created_by') THEN
    ALTER TABLE expenses ADD COLUMN created_by UUID REFERENCES auth.users(id);
  END IF;
  
  -- Notes
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'notes' AND column_name = 'created_by') THEN
    ALTER TABLE notes ADD COLUMN created_by UUID REFERENCES auth.users(id);
  END IF;
  
  -- Parts Used
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'parts_used' AND column_name = 'created_by') THEN
    ALTER TABLE parts_used ADD COLUMN created_by UUID REFERENCES auth.users(id);
  END IF;
  
  -- Suppliers
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'suppliers' AND column_name = 'created_by') THEN
    ALTER TABLE suppliers ADD COLUMN created_by UUID REFERENCES auth.users(id);
  END IF;
  
  -- Users
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'created_by') THEN
    ALTER TABLE users ADD COLUMN created_by UUID REFERENCES auth.users(id);
  END IF;
  
  -- Status History
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'status_history' AND column_name = 'created_by') THEN
    ALTER TABLE status_history ADD COLUMN created_by UUID REFERENCES auth.users(id);
  END IF;
END $$;

-- 3. Crear políticas basadas en ownership

-- ORDERS
CREATE POLICY "orders_select" ON orders FOR SELECT TO authenticated USING (true);
CREATE POLICY "orders_insert" ON orders FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
CREATE POLICY "orders_update" ON orders FOR UPDATE TO authenticated USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());
CREATE POLICY "orders_delete" ON orders FOR DELETE TO authenticated USING (created_by = auth.uid());

-- CUSTOMERS
CREATE POLICY "customers_select" ON customers FOR SELECT TO authenticated USING (true);
CREATE POLICY "customers_insert" ON customers FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
CREATE POLICY "customers_update" ON customers FOR UPDATE TO authenticated USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());
CREATE POLICY "customers_delete" ON customers FOR DELETE TO authenticated USING (created_by = auth.uid());

-- DEVICES
CREATE POLICY "devices_select" ON devices FOR SELECT TO authenticated USING (true);
CREATE POLICY "devices_insert" ON devices FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
CREATE POLICY "devices_update" ON devices FOR UPDATE TO authenticated USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());
CREATE POLICY "devices_delete" ON devices FOR DELETE TO authenticated USING (created_by = auth.uid());

-- INVENTORY
CREATE POLICY "inventory_select" ON inventory FOR SELECT TO authenticated USING (true);
CREATE POLICY "inventory_insert" ON inventory FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
CREATE POLICY "inventory_update" ON inventory FOR UPDATE TO authenticated USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());
CREATE POLICY "inventory_delete" ON inventory FOR DELETE TO authenticated USING (created_by = auth.uid());

-- ORDER_PAYMENTS
CREATE POLICY "order_payments_select" ON order_payments FOR SELECT TO authenticated USING (true);
CREATE POLICY "order_payments_insert" ON order_payments FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
CREATE POLICY "order_payments_update" ON order_payments FOR UPDATE TO authenticated USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());
CREATE POLICY "order_payments_delete" ON order_payments FOR DELETE TO authenticated USING (created_by = auth.uid());

-- ORDER_PARTS
CREATE POLICY "order_parts_select" ON order_parts FOR SELECT TO authenticated USING (true);
CREATE POLICY "order_parts_insert" ON order_parts FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
CREATE POLICY "order_parts_update" ON order_parts FOR UPDATE TO authenticated USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());
CREATE POLICY "order_parts_delete" ON order_parts FOR DELETE TO authenticated USING (created_by = auth.uid());

-- STATUS_HISTORY
CREATE POLICY "status_history_select" ON status_history FOR SELECT TO authenticated USING (true);
CREATE POLICY "status_history_insert" ON status_history FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
CREATE POLICY "status_history_update" ON status_history FOR UPDATE TO authenticated USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());
CREATE POLICY "status_history_delete" ON status_history FOR DELETE TO authenticated USING (created_by = auth.uid());

-- NOTIFICATIONS
CREATE POLICY "notifications_select" ON notifications FOR SELECT TO authenticated USING (true);
CREATE POLICY "notifications_insert" ON notifications FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
CREATE POLICY "notifications_update" ON notifications FOR UPDATE TO authenticated USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());
CREATE POLICY "notifications_delete" ON notifications FOR DELETE TO authenticated USING (created_by = auth.uid());

-- ORDER_CHECKLISTS
CREATE POLICY "order_checklists_select" ON order_checklists FOR SELECT TO authenticated USING (true);
CREATE POLICY "order_checklists_insert" ON order_checklists FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
CREATE POLICY "order_checklists_update" ON order_checklists FOR UPDATE TO authenticated USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());
CREATE POLICY "order_checklists_delete" ON order_checklists FOR DELETE TO authenticated USING (created_by = auth.uid());

-- DOCUMENTS
CREATE POLICY "documents_select" ON documents FOR SELECT TO authenticated USING (true);
CREATE POLICY "documents_insert" ON documents FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
CREATE POLICY "documents_update" ON documents FOR UPDATE TO authenticated USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());
CREATE POLICY "documents_delete" ON documents FOR DELETE TO authenticated USING (created_by = auth.uid());

-- DEVICE_INSPECTIONS
CREATE POLICY "device_inspections_select" ON device_inspections FOR SELECT TO authenticated USING (true);
CREATE POLICY "device_inspections_insert" ON device_inspections FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
CREATE POLICY "device_inspections_update" ON device_inspections FOR UPDATE TO authenticated USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());
CREATE POLICY "device_inspections_delete" ON device_inspections FOR DELETE TO authenticated USING (created_by = auth.uid());

-- EXPENSES
CREATE POLICY "expenses_select" ON expenses FOR SELECT TO authenticated USING (true);
CREATE POLICY "expenses_insert" ON expenses FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
CREATE POLICY "expenses_update" ON expenses FOR UPDATE TO authenticated USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());
CREATE POLICY "expenses_delete" ON expenses FOR DELETE TO authenticated USING (created_by = auth.uid());

-- NOTES
CREATE POLICY "notes_select" ON notes FOR SELECT TO authenticated USING (true);
CREATE POLICY "notes_insert" ON notes FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
CREATE POLICY "notes_update" ON notes FOR UPDATE TO authenticated USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());
CREATE POLICY "notes_delete" ON notes FOR DELETE TO authenticated USING (created_by = auth.uid());

-- PARTS_USED
CREATE POLICY "parts_used_select" ON parts_used FOR SELECT TO authenticated USING (true);
CREATE POLICY "parts_used_insert" ON parts_used FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
CREATE POLICY "parts_used_update" ON parts_used FOR UPDATE TO authenticated USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());
CREATE POLICY "parts_used_delete" ON parts_used FOR DELETE TO authenticated USING (created_by = auth.uid());

-- SUPPLIERS
CREATE POLICY "suppliers_select" ON suppliers FOR SELECT TO authenticated USING (true);
CREATE POLICY "suppliers_insert" ON suppliers FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
CREATE POLICY "suppliers_update" ON suppliers FOR UPDATE TO authenticated USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());
CREATE POLICY "suppliers_delete" ON suppliers FOR DELETE TO authenticated USING (created_by = auth.uid());

-- USERS
CREATE POLICY "users_select" ON users FOR SELECT TO authenticated USING (true);
CREATE POLICY "users_insert" ON users FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
CREATE POLICY "users_update" ON users FOR UPDATE TO authenticated USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());
CREATE POLICY "users_delete" ON users FOR DELETE TO authenticated USING (created_by = auth.uid());

-- Verificar políticas creadas
SELECT 
  tablename,
  COUNT(*) as politicas
FROM pg_policies 
WHERE schemaname = 'public'
GROUP BY tablename
ORDER BY tablename;
