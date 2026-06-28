-- ============================================
-- NUCLEAR OPTION - Deshabilitar TODO
-- ============================================

-- 1. Deshabilitar RLS en TODAS las tablas
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

-- 2. Eliminar TODAS las políticas existentes
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN 
    SELECT schemaname, tablename, policyname 
    FROM pg_policies 
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "%I" ON %I.%I;', 
      pol.policyname, pol.schemaname, pol.tablename);
  END LOOP;
END $$;

-- 3. Verificar que RLS está deshabilitado en todas
SELECT 
  relname as tabla,
  CASE WHEN relrowsecurity THEN '❌ RLS ACTIVO' ELSE '✅ RLS DESACTIVADO' END as estado
FROM pg_class
WHERE relname IN ('orders', 'customers', 'devices', 'inventory', 'order_payments', 'order_parts', 'status_history', 'notifications', 'order_checklists', 'documents', 'device_inspections')
AND relkind = 'r';
