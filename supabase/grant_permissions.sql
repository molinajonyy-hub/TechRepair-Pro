-- ============================================
-- GRANT PERMISOS DIRECTOS A ANON Y AUTHENTICATED
-- ============================================

-- Deshabilitar RLS
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

-- Grant ALL permissions a anon y authenticated
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated;

-- Verificar permisos
SELECT 
  table_name,
  (SELECT COUNT(*) FROM information_schema.role_table_grants 
   WHERE table_name = t.table_name AND grantee IN ('anon', 'authenticated')) as permisos
FROM information_schema.tables t
WHERE table_schema = 'public'
AND table_name IN ('orders', 'customers', 'devices', 'inventory', 'order_payments', 'order_parts', 'status_history', 'notifications', 'order_checklists', 'documents', 'device_inspections')
ORDER BY table_name;
