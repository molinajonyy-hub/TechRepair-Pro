-- ============================================
-- DESHABILITAR RLS PARA COMPROBANTES (DESARROLLO)
-- ============================================

-- Deshabilitar RLS temporalmente para desarrollo
ALTER TABLE comprobantes DISABLE ROW LEVEL SECURITY;
ALTER TABLE comprobante_items DISABLE ROW LEVEL SECURITY;

-- Verificar que RLS esté deshabilitado
SELECT 
  tablename, 
  rowsecurity 
FROM pg_tables 
WHERE schemaname = 'public' 
  AND tablename IN ('comprobantes', 'comprobante_items');
