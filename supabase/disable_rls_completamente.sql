-- =====================================================
-- DESHABILITAR RLS COMPLETAMENTE PARA DESARROLLO
-- Ejecutar esto en Supabase SQL Editor para solucionar errores 403
-- =====================================================

-- Tablas de comprobantes
ALTER TABLE comprobantes DISABLE ROW LEVEL SECURITY;
ALTER TABLE comprobante_items DISABLE ROW LEVEL SECURITY;

-- Tablas de órdenes (si también tienen problemas)
ALTER TABLE orders DISABLE ROW LEVEL SECURITY;
ALTER TABLE order_checklists DISABLE ROW LEVEL SECURITY;
ALTER TABLE order_history DISABLE ROW LEVEL SECURITY;
ALTER TABLE order_payments DISABLE ROW LEVEL SECURITY;
ALTER TABLE order_parts DISABLE ROW LEVEL SECURITY;

-- Tablas de inventario (por las dudas)
ALTER TABLE inventory DISABLE ROW LEVEL SECURITY;

-- Tablas de clientes
ALTER TABLE customers DISABLE ROW LEVEL SECURITY;

-- Confirmación
SELECT 'RLS deshabilitado en todas las tablas' as resultado;
