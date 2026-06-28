-- ============================================
-- TABLA DE INSPECCIONES DE DISPOSITIVOS
-- ============================================

CREATE TABLE IF NOT EXISTS device_inspections (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL CHECK (type IN ('reception', 'final')),
  
  -- Funcionalidad
  face_id BOOLEAN DEFAULT false,
  touch_screen BOOLEAN DEFAULT false,
  display_image BOOLEAN DEFAULT false,
  front_camera BOOLEAN DEFAULT false,
  back_camera BOOLEAN DEFAULT false,
  microphone BOOLEAN DEFAULT false,
  speaker BOOLEAN DEFAULT false,
  wifi BOOLEAN DEFAULT false,
  bluetooth BOOLEAN DEFAULT false,
  charging BOOLEAN DEFAULT false,
  battery_health BOOLEAN DEFAULT false,
  sensors BOOLEAN DEFAULT false,
  buttons BOOLEAN DEFAULT false,
  vibration BOOLEAN DEFAULT false,
  
  -- Estado estético
  screen_condition VARCHAR(50) DEFAULT 'Perfecto',
  back_condition VARCHAR(50) DEFAULT 'Perfecto',
  frame_condition VARCHAR(50) DEFAULT 'Perfecto',
  camera_lens VARCHAR(50) DEFAULT 'Perfecto',
  
  -- Accesorios (array de IDs)
  accessories TEXT[] DEFAULT '{}',
  
  -- Notas
  customer_notes TEXT,
  technician_notes TEXT,
  
  -- Firma y evidencia
  customer_signature TEXT,
  photos TEXT[] DEFAULT '{}',
  
  -- Metadatos
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  
  CONSTRAINT unique_order_inspection UNIQUE (order_id, type)
);

-- Índices
CREATE INDEX idx_device_inspections_order_id ON device_inspections(order_id);
CREATE INDEX idx_device_inspections_type ON device_inspections(type);

-- Trigger para actualizar timestamp
CREATE OR REPLACE FUNCTION update_inspection_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_inspection_timestamp ON device_inspections;
CREATE TRIGGER update_inspection_timestamp
  BEFORE UPDATE ON device_inspections
  FOR EACH ROW
  EXECUTE FUNCTION update_inspection_timestamp();

-- ============================================
-- POLÍTICAS RLS
-- ============================================

ALTER TABLE device_inspections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow authenticated users to view inspections"
  ON device_inspections FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to insert inspections"
  ON device_inspections FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Allow authenticated users to update inspections"
  ON device_inspections FOR UPDATE
  TO authenticated
  USING (true);
