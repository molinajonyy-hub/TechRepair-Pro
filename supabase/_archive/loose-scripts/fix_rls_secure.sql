-- ============================================
-- POLÍTICAS RLS SEGURAS - Reemplazar allow_all
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

-- 2. Crear políticas seguras por tabla

-- ==================== ORDERS ====================
DROP POLICY IF EXISTS "orders_select" ON orders;
DROP POLICY IF EXISTS "orders_insert" ON orders;
DROP POLICY IF EXISTS "orders_update" ON orders;
DROP POLICY IF EXISTS "orders_delete" ON orders;

CREATE POLICY "orders_select" ON orders FOR SELECT TO authenticated USING (true);
CREATE POLICY "orders_insert" ON orders FOR INSERT TO authenticated WITH CHECK (auth.uid()::text = (SELECT id::text FROM auth.users WHERE id = auth.uid()));
CREATE POLICY "orders_update" ON orders FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "orders_delete" ON orders FOR DELETE TO authenticated USING (true);

-- ==================== CUSTOMERS ====================
DROP POLICY IF EXISTS "customers_select" ON customers;
DROP POLICY IF EXISTS "customers_insert" ON customers;
DROP POLICY IF EXISTS "customers_update" ON customers;
DROP POLICY IF EXISTS "customers_delete" ON customers;

CREATE POLICY "customers_select" ON customers FOR SELECT TO authenticated USING (true);
CREATE POLICY "customers_insert" ON customers FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "customers_update" ON customers FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "customers_delete" ON customers FOR DELETE TO authenticated USING (true);

-- ==================== DEVICES ====================
DROP POLICY IF EXISTS "devices_select" ON devices;
DROP POLICY IF EXISTS "devices_insert" ON devices;
DROP POLICY IF EXISTS "devices_update" ON devices;
DROP POLICY IF EXISTS "devices_delete" ON devices;

CREATE POLICY "devices_select" ON devices FOR SELECT TO authenticated USING (true);
CREATE POLICY "devices_insert" ON devices FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "devices_update" ON devices FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "devices_delete" ON devices FOR DELETE TO authenticated USING (true);

-- ==================== INVENTORY ====================
DROP POLICY IF EXISTS "inventory_select" ON inventory;
DROP POLICY IF EXISTS "inventory_insert" ON inventory;
DROP POLICY IF EXISTS "inventory_update" ON inventory;
DROP POLICY IF EXISTS "inventory_delete" ON inventory;

CREATE POLICY "inventory_select" ON inventory FOR SELECT TO authenticated USING (true);
CREATE POLICY "inventory_insert" ON inventory FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "inventory_update" ON inventory FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "inventory_delete" ON inventory FOR DELETE TO authenticated USING (true);

-- ==================== ORDER_PAYMENTS ====================
DROP POLICY IF EXISTS "order_payments_select" ON order_payments;
DROP POLICY IF EXISTS "order_payments_insert" ON order_payments;
DROP POLICY IF EXISTS "order_payments_update" ON order_payments;
DROP POLICY IF EXISTS "order_payments_delete" ON order_payments;

CREATE POLICY "order_payments_select" ON order_payments FOR SELECT TO authenticated USING (true);
CREATE POLICY "order_payments_insert" ON order_payments FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "order_payments_update" ON order_payments FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "order_payments_delete" ON order_payments FOR DELETE TO authenticated USING (true);

-- ==================== ORDER_PARTS ====================
DROP POLICY IF EXISTS "order_parts_select" ON order_parts;
DROP POLICY IF EXISTS "order_parts_insert" ON order_parts;
DROP POLICY IF EXISTS "order_parts_update" ON order_parts;
DROP POLICY IF EXISTS "order_parts_delete" ON order_parts;

CREATE POLICY "order_parts_select" ON order_parts FOR SELECT TO authenticated USING (true);
CREATE POLICY "order_parts_insert" ON order_parts FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "order_parts_update" ON order_parts FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "order_parts_delete" ON order_parts FOR DELETE TO authenticated USING (true);

-- ==================== STATUS_HISTORY ====================
DROP POLICY IF EXISTS "status_history_select" ON status_history;
DROP POLICY IF EXISTS "status_history_insert" ON status_history;
DROP POLICY IF EXISTS "status_history_update" ON status_history;
DROP POLICY IF EXISTS "status_history_delete" ON status_history;

CREATE POLICY "status_history_select" ON status_history FOR SELECT TO authenticated USING (true);
CREATE POLICY "status_history_insert" ON status_history FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "status_history_update" ON status_history FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "status_history_delete" ON status_history FOR DELETE TO authenticated USING (true);

-- ==================== NOTIFICATIONS ====================
DROP POLICY IF EXISTS "notifications_select" ON notifications;
DROP POLICY IF EXISTS "notifications_insert" ON notifications;
DROP POLICY IF EXISTS "notifications_update" ON notifications;
DROP POLICY IF EXISTS "notifications_delete" ON notifications;

CREATE POLICY "notifications_select" ON notifications FOR SELECT TO authenticated USING (true);
CREATE POLICY "notifications_insert" ON notifications FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "notifications_update" ON notifications FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "notifications_delete" ON notifications FOR DELETE TO authenticated USING (true);

-- ==================== ORDER_CHECKLISTS ====================
DROP POLICY IF EXISTS "order_checklists_select" ON order_checklists;
DROP POLICY IF EXISTS "order_checklists_insert" ON order_checklists;
DROP POLICY IF EXISTS "order_checklists_update" ON order_checklists;
DROP POLICY IF EXISTS "order_checklists_delete" ON order_checklists;

CREATE POLICY "order_checklists_select" ON order_checklists FOR SELECT TO authenticated USING (true);
CREATE POLICY "order_checklists_insert" ON order_checklists FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "order_checklists_update" ON order_checklists FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "order_checklists_delete" ON order_checklists FOR DELETE TO authenticated USING (true);

-- ==================== DOCUMENTS ====================
DROP POLICY IF EXISTS "documents_select" ON documents;
DROP POLICY IF EXISTS "documents_insert" ON documents;
DROP POLICY IF EXISTS "documents_update" ON documents;
DROP POLICY IF EXISTS "documents_delete" ON documents;

CREATE POLICY "documents_select" ON documents FOR SELECT TO authenticated USING (true);
CREATE POLICY "documents_insert" ON documents FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "documents_update" ON documents FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "documents_delete" ON documents FOR DELETE TO authenticated USING (true);

-- ==================== DEVICE_INSPECTIONS ====================
DROP POLICY IF EXISTS "device_inspections_select" ON device_inspections;
DROP POLICY IF EXISTS "device_inspections_insert" ON device_inspections;
DROP POLICY IF EXISTS "device_inspections_update" ON device_inspections;
DROP POLICY IF EXISTS "device_inspections_delete" ON device_inspections;

CREATE POLICY "device_inspections_select" ON device_inspections FOR SELECT TO authenticated USING (true);
CREATE POLICY "device_inspections_insert" ON device_inspections FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "device_inspections_update" ON device_inspections FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "device_inspections_delete" ON device_inspections FOR DELETE TO authenticated USING (true);

-- ==================== OTRAS TABLAS (EXPENSES, NOTES, PARTS_USED, SUPPLIERS, USERS) ====================
DROP POLICY IF EXISTS "expenses_select" ON expenses;
DROP POLICY IF EXISTS "expenses_insert" ON expenses;
DROP POLICY IF EXISTS "expenses_update" ON expenses;
DROP POLICY IF EXISTS "expenses_delete" ON expenses;

CREATE POLICY "expenses_select" ON expenses FOR SELECT TO authenticated USING (true);
CREATE POLICY "expenses_insert" ON expenses FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "expenses_update" ON expenses FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "expenses_delete" ON expenses FOR DELETE TO authenticated USING (true);

DROP POLICY IF EXISTS "notes_select" ON notes;
DROP POLICY IF EXISTS "notes_insert" ON notes;
DROP POLICY IF EXISTS "notes_update" ON notes;
DROP POLICY IF EXISTS "notes_delete" ON notes;

CREATE POLICY "notes_select" ON notes FOR SELECT TO authenticated USING (true);
CREATE POLICY "notes_insert" ON notes FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "notes_update" ON notes FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "notes_delete" ON notes FOR DELETE TO authenticated USING (true);

DROP POLICY IF EXISTS "parts_used_select" ON parts_used;
DROP POLICY IF EXISTS "parts_used_insert" ON parts_used;
DROP POLICY IF EXISTS "parts_used_update" ON parts_used;
DROP POLICY IF EXISTS "parts_used_delete" ON parts_used;

CREATE POLICY "parts_used_select" ON parts_used FOR SELECT TO authenticated USING (true);
CREATE POLICY "parts_used_insert" ON parts_used FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "parts_used_update" ON parts_used FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "parts_used_delete" ON parts_used FOR DELETE TO authenticated USING (true);

DROP POLICY IF EXISTS "suppliers_select" ON suppliers;
DROP POLICY IF EXISTS "suppliers_insert" ON suppliers;
DROP POLICY IF EXISTS "suppliers_update" ON suppliers;
DROP POLICY IF EXISTS "suppliers_delete" ON suppliers;

CREATE POLICY "suppliers_select" ON suppliers FOR SELECT TO authenticated USING (true);
CREATE POLICY "suppliers_insert" ON suppliers FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "suppliers_update" ON suppliers FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "suppliers_delete" ON suppliers FOR DELETE TO authenticated USING (true);

DROP POLICY IF EXISTS "users_select" ON users;
DROP POLICY IF EXISTS "users_insert" ON users;
DROP POLICY IF EXISTS "users_update" ON users;
DROP POLICY IF EXISTS "users_delete" ON users;

CREATE POLICY "users_select" ON users FOR SELECT TO authenticated USING (true);
CREATE POLICY "users_insert" ON users FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "users_update" ON users FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "users_delete" ON users FOR DELETE TO authenticated USING (true);

-- Verificar políticas creadas
SELECT 
  tablename,
  COUNT(*) as politicas
FROM pg_policies 
WHERE schemaname = 'public'
GROUP BY tablename
ORDER BY tablename;
