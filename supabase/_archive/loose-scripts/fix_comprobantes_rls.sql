-- ============================================
-- CORREGIR RLS PARA COMPROBANTES
-- ============================================

-- Eliminar políticas existentes de comprobantes
DROP POLICY IF EXISTS "comprobantes_select" ON comprobantes;
DROP POLICY IF EXISTS "comprobantes_insert" ON comprobantes;
DROP POLICY IF EXISTS "comprobantes_update" ON comprobantes;
DROP POLICY IF EXISTS "comprobantes_delete" ON comprobantes;

-- Eliminar políticas existentes de comprobante_items
DROP POLICY IF EXISTS "comprobante_items_select" ON comprobante_items;
DROP POLICY IF EXISTS "comprobante_items_insert" ON comprobante_items;
DROP POLICY IF EXISTS "comprobante_items_update" ON comprobante_items;
DROP POLICY IF EXISTS "comprobante_items_delete" ON comprobante_items;

-- Crear políticas permisivas para desarrollo
CREATE POLICY "comprobantes_select" ON comprobantes
    FOR SELECT TO authenticated
    USING (true);

CREATE POLICY "comprobantes_insert" ON comprobantes
    FOR INSERT TO authenticated
    WITH CHECK (true);

CREATE POLICY "comprobantes_update" ON comprobantes
    FOR UPDATE TO authenticated
    USING (true) WITH CHECK (true);

CREATE POLICY "comprobantes_delete" ON comprobantes
    FOR DELETE TO authenticated
    USING (true);

-- Políticas para comprobante_items
CREATE POLICY "comprobante_items_select" ON comprobante_items
    FOR SELECT TO authenticated
    USING (true);

CREATE POLICY "comprobante_items_insert" ON comprobante_items
    FOR INSERT TO authenticated
    WITH CHECK (true);

CREATE POLICY "comprobante_items_update" ON comprobante_items
    FOR UPDATE TO authenticated
    USING (true) WITH CHECK (true);

CREATE POLICY "comprobante_items_delete" ON comprobante_items
    FOR DELETE TO authenticated
    USING (true);

-- Asegurar que RLS esté habilitado
ALTER TABLE comprobantes ENABLE ROW LEVEL SECURITY;
ALTER TABLE comprobante_items ENABLE ROW LEVEL SECURITY;
