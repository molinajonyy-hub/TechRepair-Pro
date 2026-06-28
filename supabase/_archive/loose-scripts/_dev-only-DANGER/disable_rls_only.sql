-- ============================================
-- DESHABILITAR RLS SOLAMENTE - Sin crear políticas
-- ============================================

ALTER TABLE orders DISABLE ROW LEVEL SECURITY;
ALTER TABLE customers DISABLE ROW LEVEL SECURITY;
ALTER TABLE devices DISABLE ROW LEVEL SECURITY;
ALTER TABLE inventory DISABLE ROW LEVEL SECURITY;
ALTER TABLE order_payments DISABLE ROW LEVEL SECURITY;
ALTER TABLE order_parts DISABLE ROW LEVEL SECURITY;
ALTER TABLE status_history DISABLE ROW LEVEL SECURITY;
ALTER TABLE notifications DISABLE ROW LEVEL SECURITY;
ALTER TABLE order_checklists DISABLE ROW LEVEL SECURITY;
ALTER TABLE documents DISABLE ROW LEVEL SECURITY;
ALTER TABLE device_inspections DISABLE ROW LEVEL SECURITY;

-- Verificar
SELECT 
  relname as tabla,
  CASE WHEN relrowsecurity THEN '❌ RLS ACTIVO' ELSE '✅ RLS DESACTIVADO' END as estado
FROM pg_class
WHERE relname IN ('orders', 'customers', 'devices', 'inventory', 'order_payments', 'order_parts', 'status_history', 'notifications', 'order_checklists', 'documents', 'device_inspections')
AND relkind = 'r';
