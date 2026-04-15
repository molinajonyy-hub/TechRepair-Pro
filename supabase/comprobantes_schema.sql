-- ============================================
-- SCHEMA COMPROBANTES Y FACTURACIÓN
-- Preparado para integración AFIP (ARCA)
-- ============================================

-- ============================================
-- TABLA: COMPROBANTES
-- ============================================
CREATE TABLE IF NOT EXISTS comprobantes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    
    -- Tipo de comprobante
    tipo TEXT NOT NULL CHECK (tipo IN ('remito', 'factura_a', 'factura_c', 'nota_credito')),
    
    -- Numeración
    numero TEXT,
    punto_venta TEXT DEFAULT '0001',
    
    -- Fechas
    fecha TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Totales
    subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
    impuestos NUMERIC(12,2) NOT NULL DEFAULT 0,
    total NUMERIC(12,2) NOT NULL DEFAULT 0,
    
    -- Estado
    estado TEXT NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador', 'emitido', 'anulado')),
    
    -- Datos AFIP (ARCA)
    cae TEXT,
    cae_vencimiento TIMESTAMP WITH TIME ZONE,
    afip_response JSONB,
    
    -- Condición fiscal del cliente
    condicion_fiscal TEXT,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_comprobantes_order_id ON comprobantes(order_id);
CREATE INDEX IF NOT EXISTS idx_comprobantes_customer_id ON comprobantes(customer_id);
CREATE INDEX IF NOT EXISTS idx_comprobantes_tipo ON comprobantes(tipo);
CREATE INDEX IF NOT EXISTS idx_comprobantes_estado ON comprobantes(estado);
CREATE INDEX IF NOT EXISTS idx_comprobantes_fecha ON comprobantes(fecha);

-- Trigger para updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_comprobantes_updated_at
    BEFORE UPDATE ON comprobantes
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- TABLA: COMPROBANTE_ITEMS
-- ============================================
CREATE TABLE IF NOT EXISTS comprobante_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    comprobante_id UUID NOT NULL REFERENCES comprobantes(id) ON DELETE CASCADE,
    
    -- Datos del item
    descripcion TEXT NOT NULL,
    cantidad NUMERIC(10,2) NOT NULL DEFAULT 1,
    precio_unitario NUMERIC(12,2) NOT NULL DEFAULT 0,
    subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
    
    -- Opcional: vincular a inventory
    inventory_id UUID REFERENCES inventory(id) ON DELETE SET NULL,
    
    -- Orden para mostrar
    orden INTEGER DEFAULT 0,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_comprobante_items_comprobante_id ON comprobante_items(comprobante_id);
CREATE INDEX IF NOT EXISTS idx_comprobante_items_inventory_id ON comprobante_items(inventory_id);

-- ============================================
-- ACTUALIZAR TABLA ORDERS
-- ============================================
ALTER TABLE orders 
ADD COLUMN IF NOT EXISTS comprobante_id UUID REFERENCES comprobantes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_comprobante_id ON orders(comprobante_id);

-- ============================================
-- RLS POLICIES
-- ============================================
ALTER TABLE comprobantes ENABLE ROW LEVEL SECURITY;
ALTER TABLE comprobante_items ENABLE ROW LEVEL SECURITY;

-- Comprobantes
CREATE POLICY "comprobantes_select" ON comprobantes FOR SELECT TO authenticated USING (true);
CREATE POLICY "comprobantes_insert" ON comprobantes FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "comprobantes_update" ON comprobantes FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "comprobantes_delete" ON comprobantes FOR DELETE TO authenticated USING (true);

-- Comprobante Items
CREATE POLICY "comprobante_items_select" ON comprobante_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "comprobante_items_insert" ON comprobante_items FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "comprobante_items_update" ON comprobante_items FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "comprobante_items_delete" ON comprobante_items FOR DELETE TO authenticated USING (true);

-- ============================================
-- VISTA: RESUMEN DE COMPROBANTES
-- ============================================
CREATE OR REPLACE VIEW vista_comprobantes_resumen AS
SELECT 
    c.id,
    c.tipo,
    c.numero,
    c.punto_venta,
    c.fecha,
    c.estado,
    c.subtotal,
    c.impuestos,
    c.total,
    c.cae,
    c.order_id,
    LEFT(c.order_id::text, 8) as orden_numero,
    c.customer_id,
    cust.name as cliente_nombre,
    cust.phone as cliente_contacto,
    COUNT(ci.id) as cantidad_items
FROM comprobantes c
LEFT JOIN customers cust ON c.customer_id = cust.id
LEFT JOIN comprobante_items ci ON c.id = ci.comprobante_id
GROUP BY c.id, c.tipo, c.numero, c.punto_venta, c.fecha, c.estado, 
         c.subtotal, c.impuestos, c.total, c.cae, c.order_id, 
         c.customer_id, cust.name, cust.phone
ORDER BY c.fecha DESC;

-- ============================================
-- FUNCIÓN: GENERAR NÚMERO DE COMPROBANTE
-- ============================================
CREATE OR REPLACE FUNCTION generar_numero_comprobante(
    p_tipo TEXT,
    p_punto_venta TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_numero INTEGER;
    v_prefijo TEXT;
BEGIN
    -- Obtener el último número para este tipo y punto de venta
    SELECT COALESCE(MAX(CAST(SUBSTRING(numero FROM 9) AS INTEGER)), 0) + 1
    INTO v_numero
    FROM comprobantes
    WHERE tipo = p_tipo 
    AND punto_venta = p_punto_venta
    AND numero IS NOT NULL;
    
    -- Formato: PV-0001-00000001
    RETURN p_punto_venta || '-' || LPAD(v_numero::TEXT, 8, '0');
END;
$$;

-- ============================================
-- FUNCIÓN: RECALCULAR TOTALES
-- ============================================
CREATE OR REPLACE FUNCTION recalcular_totales_comprobante(
    p_comprobante_id UUID
)
RETURNS VOID AS $$
DECLARE
    v_subtotal NUMERIC(12,2);
    v_tipo TEXT;
    v_impuestos NUMERIC(12,2);
    v_total NUMERIC(12,2);
BEGIN
    -- Obtener tipo de comprobante
    SELECT tipo INTO v_tipo FROM comprobantes WHERE id = p_comprobante_id;
    
    -- Calcular subtotal
    SELECT COALESCE(SUM(subtotal), 0)
    INTO v_subtotal
    FROM comprobante_items
    WHERE comprobante_id = p_comprobante_id;
    
    -- Calcular impuestos según tipo
    IF v_tipo = 'factura_a' THEN
        v_impuestos = v_subtotal * 0.21; -- IVA 21%
    ELSE
        v_impuestos = 0;
    END IF;
    
    v_total = v_subtotal + v_impuestos;
    
    -- Actualizar comprobante
    UPDATE comprobantes 
    SET subtotal = v_subtotal,
        impuestos = v_impuestos,
        total = v_total,
        updated_at = NOW()
    WHERE id = p_comprobante_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- TRIGGER: RECALCULAR AL MODIFICAR ITEMS
-- ============================================
CREATE OR REPLACE FUNCTION trigger_recalcular_totales()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM recalcular_totales_comprobante(OLD.comprobante_id);
        RETURN OLD;
    ELSE
        PERFORM recalcular_totales_comprobante(NEW.comprobante_id);
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_recalcular_totales_items
    AFTER INSERT OR UPDATE OR DELETE ON comprobante_items
    FOR EACH ROW
    EXECUTE FUNCTION trigger_recalcular_totales();

-- ============================================
-- DATOS DE PRUEBA (Opcional)
-- ============================================
-- Descomentar si se necesitan datos de prueba
/*
INSERT INTO comprobantes (tipo, numero, punto_venta, fecha, estado, subtotal, impuestos, total, condicion_fiscal)
VALUES 
    ('factura_a', '0001-00000001', '0001', NOW(), 'emitido', 1000.00, 210.00, 1210.00, 'Responsable Inscripto'),
    ('factura_c', '0001-00000002', '0001', NOW(), 'borrador', 500.00, 0, 500.00, 'Consumidor Final');
*/
