-- ============================================
-- TABLA DE INVENTARIO/PRODUCTOS
-- ============================================

CREATE TABLE IF NOT EXISTS inventory (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  
  -- Identificación
  code VARCHAR(100) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  
  -- Categoría
  category VARCHAR(100),
  subcategory VARCHAR(100),
  
  -- Stock
  stock_quantity INTEGER NOT NULL DEFAULT 0,
  reserved_quantity INTEGER NOT NULL DEFAULT 0,
  min_stock INTEGER NOT NULL DEFAULT 1,
  max_stock INTEGER,
  
  -- Precios
  cost_price DECIMAL(10,2) NOT NULL DEFAULT 0,      -- Precio de compra
  sale_price DECIMAL(10,2) NOT NULL DEFAULT 0,        -- Precio de venta
  
  -- Proveedor
  supplier_id UUID,
  supplier_code VARCHAR(100),
  
  -- Ubicación
  location VARCHAR(100),
  
  -- Estado
  is_active BOOLEAN DEFAULT true,
  
  -- Metadatos
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_by UUID REFERENCES auth.users(id),
  updated_by UUID REFERENCES auth.users(id)
);

-- Índices
CREATE INDEX idx_inventory_category ON inventory(category);
CREATE INDEX idx_inventory_code ON inventory(code);
CREATE INDEX idx_inventory_active ON inventory(is_active);

-- Trigger para actualizar timestamp
CREATE OR REPLACE FUNCTION update_inventory_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_inventory_timestamp ON inventory;
CREATE TRIGGER update_inventory_timestamp
  BEFORE UPDATE ON inventory
  FOR EACH ROW
  EXECUTE FUNCTION update_inventory_timestamp();

-- ============================================
-- POLÍTICAS RLS
-- ============================================

ALTER TABLE inventory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow authenticated users to view inventory"
  ON inventory FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to insert inventory"
  ON inventory FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Allow authenticated users to update inventory"
  ON inventory FOR UPDATE
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to delete inventory"
  ON inventory FOR DELETE
  TO authenticated
  USING (true);

-- ============================================
-- VISTA DE STOCK BAJO
-- ============================================

CREATE OR REPLACE VIEW low_stock_alert AS
SELECT 
  id,
  code,
  name,
  category,
  stock_quantity,
  reserved_quantity,
  (stock_quantity - reserved_quantity) as available_quantity,
  min_stock,
  CASE 
    WHEN stock_quantity = 0 THEN 'out_of_stock'
    WHEN stock_quantity > 0 AND stock_quantity <= min_stock THEN 'low_stock'
    ELSE 'ok'
  END as stock_status
FROM inventory
WHERE stock_quantity = 0 OR (stock_quantity > 0 AND stock_quantity <= min_stock)
ORDER BY stock_quantity ASC;

-- ============================================
-- FUNCIÓN PARA MOVIMIENTOS DE STOCK
-- ============================================

CREATE TABLE IF NOT EXISTS inventory_movements (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  inventory_id UUID NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL CHECK (type IN ('in', 'out', 'adjustment', 'return')),
  quantity INTEGER NOT NULL,
  previous_stock INTEGER NOT NULL,
  new_stock INTEGER NOT NULL,
  reference_type VARCHAR(50), -- 'order', 'purchase', 'adjustment'
  reference_id UUID,
  notes TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Trigger para registrar movimientos automáticamente
CREATE OR REPLACE FUNCTION log_inventory_movement()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.stock_quantity != NEW.stock_quantity THEN
    INSERT INTO inventory_movements (
      inventory_id,
      type,
      quantity,
      previous_stock,
      new_stock,
      notes
    ) VALUES (
      NEW.id,
      CASE 
        WHEN NEW.stock_quantity > OLD.stock_quantity THEN 'in'
        ELSE 'out'
      END,
      ABS(NEW.stock_quantity - OLD.stock_quantity),
      OLD.stock_quantity,
      NEW.stock_quantity,
      'Actualización automática'
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_log_inventory_movement ON inventory;
CREATE TRIGGER trigger_log_inventory_movement
  AFTER UPDATE OF stock_quantity ON inventory
  FOR EACH ROW
  EXECUTE FUNCTION log_inventory_movement();

-- Políticas para movimientos
ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow authenticated users to view movements"
  ON inventory_movements FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to insert movements"
  ON inventory_movements FOR INSERT
  TO authenticated
  WITH CHECK (true);
