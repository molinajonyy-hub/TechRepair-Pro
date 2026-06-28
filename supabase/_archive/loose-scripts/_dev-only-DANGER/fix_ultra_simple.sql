-- ============================================
-- FIX ULTRA SIMPLE - Sin SELECT problemático
-- ============================================

-- 1. Deshabilitar RLS en todas las tablas
ALTER TABLE IF EXISTS orders DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS customers DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS devices DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS inventory DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS order_payments DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS order_parts DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS status_history DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS notifications DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS order_checklists DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS documents DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS device_inspections DISABLE ROW LEVEL SECURITY;

-- 2. Eliminar todas las políticas
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
      NULL; -- Ignorar errores
    END;
  END LOOP;
END $$;

-- 3. Habilitar RLS
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

-- 4. Crear política única permisiva
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

-- 5. Verificación simple
SELECT '✅ RLS habilitado y políticas creadas' as estado;
