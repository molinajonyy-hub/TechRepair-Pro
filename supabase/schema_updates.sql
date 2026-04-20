-- ============================================
-- ACTUALIZACIÓN DE ESQUEMA PARA SISTEMA DE ESTADOS
-- ============================================

-- 1. Tabla de historial de estados
CREATE TABLE IF NOT EXISTS status_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status VARCHAR(50) NOT NULL,
  to_status VARCHAR(50) NOT NULL,
  changed_by UUID REFERENCES auth.users(id),
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Índices para consultas rápidas
CREATE INDEX idx_status_history_order_id ON status_history(order_id);
CREATE INDEX idx_status_history_created_at ON status_history(created_at);

-- 2. Tabla de checklist para validaciones
CREATE TABLE IF NOT EXISTS order_checklists (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  
  -- Checklist de diagnóstico
  diagnosis_done BOOLEAN DEFAULT false,
  diagnosis_notes TEXT,
  
  -- Checklist de reparación
  repair_done BOOLEAN DEFAULT false,
  parts_replaced TEXT[], -- array de repuestos usados
  
  -- Checklist final de calidad
  final_test_passed BOOLEAN DEFAULT false,
  cleaning_done BOOLEAN DEFAULT false,
  quality_control BOOLEAN DEFAULT false,
  
  -- Firma de retiro
  retirement_signature TEXT, -- URL o base64 de la firma
  retirement_signature_date TIMESTAMP WITH TIME ZONE,
  
  -- Metadatos
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  
  CONSTRAINT unique_order_checklist UNIQUE (order_id)
);

CREATE INDEX idx_order_checklists_order_id ON order_checklists(order_id);

-- 3. Actualizar tabla orders con campos adicionales
-- (Si no existen, los agregamos)
DO $$
BEGIN
  -- Agregar amount_paid si no existe
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'orders' AND column_name = 'amount_paid') THEN
    ALTER TABLE orders ADD COLUMN amount_paid DECIMAL(10,2) DEFAULT 0;
  END IF;
  
  -- Agregar checklist_id si no existe
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'orders' AND column_name = 'checklist_id') THEN
    ALTER TABLE orders ADD COLUMN checklist_id UUID REFERENCES order_checklists(id);
  END IF;
END $$;

-- 4. Función para actualizar timestamp de checklist
CREATE OR REPLACE FUNCTION update_checklist_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger para actualizar timestamp automáticamente
DROP TRIGGER IF EXISTS update_checklist_timestamp ON order_checklists;
CREATE TRIGGER update_checklist_timestamp
  BEFORE UPDATE ON order_checklists
  FOR EACH ROW
  EXECUTE FUNCTION update_checklist_timestamp();

-- ============================================
-- POLÍTICAS RLS (ROW LEVEL SECURITY)
-- ============================================

-- Habilitar RLS en las nuevas tablas
ALTER TABLE status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_checklists ENABLE ROW LEVEL SECURITY;

-- Política: usuarios autenticados pueden ver todo
CREATE POLICY "Allow authenticated users to view status history"
  ON status_history FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to insert status history"
  ON status_history FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Allow authenticated users to view checklists"
  ON order_checklists FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to modify checklists"
  ON order_checklists FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- ============================================
-- DATOS INICIALES (Opcional)
-- ============================================

-- Insertar algunos registros de ejemplo para testing
-- (Descomentar si se quiere datos de prueba)

/*
-- Para una orden existente, crear checklist vacío
INSERT INTO order_checklists (order_id)
SELECT id FROM orders LIMIT 1
ON CONFLICT (order_id) DO NOTHING;

-- Registrar un cambio de estado de ejemplo
INSERT INTO status_history (order_id, from_status, to_status, changed_by, notes)
SELECT 
  o.id, 
  'new', 
  o.status, 
  null, 
  'Estado inicial'
FROM orders o
LIMIT 1;
*/
