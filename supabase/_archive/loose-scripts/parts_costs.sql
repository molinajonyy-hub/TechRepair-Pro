-- ============================================
-- SISTEMA COMPLETO DE COSTOS Y RENTABILIDAD
-- ============================================

-- 1. Tabla de repuestos usados en órdenes (con costos y estados)
CREATE TABLE IF NOT EXISTS order_parts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  
  -- Referencia al repuesto en inventario (opcional)
  inventory_part_id UUID REFERENCES inventory(id),
  
  -- Información del repuesto
  name VARCHAR(255) NOT NULL,
  description TEXT,
  part_number VARCHAR(100),
  
  -- Costos y precios
  internal_cost DECIMAL(10,2) NOT NULL DEFAULT 0,  -- Costo que paga el taller
  sale_price DECIMAL(10,2) NOT NULL DEFAULT 0,      -- Precio al cliente
  quantity INTEGER NOT NULL DEFAULT 1,
  
  -- Margen calculado
  margin_amount DECIMAL(10,2) GENERATED ALWAYS AS ((sale_price - internal_cost) * quantity) STORED,
  margin_percentage DECIMAL(5,2) GENERATED ALWAYS AS (
    CASE 
      WHEN internal_cost > 0 THEN ROUND(((sale_price - internal_cost) / internal_cost * 100), 2)
      ELSE 0 
    END
  ) STORED,
  
  -- Estado del repuesto en la orden
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'reserved', 'used', 'returned', 'sold')),
  
  -- Impacto en inventario
  deduct_from_inventory BOOLEAN DEFAULT true,
  inventory_deducted_at TIMESTAMP WITH TIME ZONE,
  
  -- Metadatos
  added_by UUID REFERENCES auth.users(id),
  added_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  notes TEXT
);

-- Índices
CREATE INDEX idx_order_parts_order_id ON order_parts(order_id);
CREATE INDEX idx_order_parts_inventory_id ON order_parts(inventory_part_id);
CREATE INDEX idx_order_parts_status ON order_parts(status);

-- 2. Función para actualizar stock al cambiar estado
CREATE OR REPLACE FUNCTION update_inventory_on_part_status()
RETURNS TRIGGER AS $$
BEGIN
  -- Si cambia a 'used' o 'sold' y tiene inventory_part_id, descontar del stock
  IF (NEW.status IN ('used', 'sold') AND NEW.deduct_from_inventory = true) THEN
    IF (OLD.status NOT IN ('used', 'sold') OR OLD.inventory_deducted_at IS NULL) THEN
      -- Descontar del inventario
      UPDATE inventory
      SET 
        stock_quantity = GREATEST(0, stock_quantity - NEW.quantity),
        reserved_quantity = GREATEST(0, reserved_quantity - CASE WHEN OLD.status = 'reserved' THEN NEW.quantity ELSE 0 END),
        updated_at = now()
      WHERE id = NEW.inventory_part_id;
      
      NEW.inventory_deducted_at = now();
    END IF;
  END IF;
  
  -- Si cambia a 'reserved', reservar en inventario
  IF (NEW.status = 'reserved' AND OLD.status != 'reserved') THEN
    UPDATE inventory
    SET 
      reserved_quantity = reserved_quantity + NEW.quantity,
      updated_at = now()
    WHERE id = NEW.inventory_part_id;
  END IF;
  
  -- Si cambia de 'reserved' a otro estado (no used/sold), liberar reserva
  IF (OLD.status = 'reserved' AND NEW.status NOT IN ('used', 'sold', 'reserved')) THEN
    UPDATE inventory
    SET 
      reserved_quantity = GREATEST(0, reserved_quantity - OLD.quantity),
      updated_at = now()
    WHERE id = NEW.inventory_part_id;
  END IF;
  
  -- Si es 'returned', devolver al stock
  IF (NEW.status = 'returned' AND OLD.status IN ('used', 'sold')) THEN
    UPDATE inventory
    SET 
      stock_quantity = stock_quantity + NEW.quantity,
      updated_at = now()
    WHERE id = NEW.inventory_part_id;
    
    NEW.inventory_deducted_at = NULL;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_inventory ON order_parts;
CREATE TRIGGER trigger_update_inventory
  AFTER INSERT OR UPDATE OF status ON order_parts
  FOR EACH ROW
  EXECUTE FUNCTION update_inventory_on_part_status();

-- 3. Actualizar tabla order_payments con más campos
ALTER TABLE order_payments 
ADD COLUMN IF NOT EXISTS is_down_payment BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS due_date DATE,
ADD COLUMN IF NOT EXISTS payment_status VARCHAR(50) DEFAULT 'completed' CHECK (payment_status IN ('pending', 'completed', 'failed', 'refunded')),
ADD COLUMN IF NOT EXISTS receipt_number VARCHAR(100),
ADD COLUMN IF NOT EXISTS receipt_url TEXT,
ADD COLUMN IF NOT EXISTS notes TEXT;

-- 4. Vista de rentabilidad por orden
CREATE OR REPLACE VIEW order_profitability AS
SELECT 
  o.id as order_id,
  o.status,
  o.customer_id,
  c.name as customer_name,
  
  -- Costos
  COALESCE(o.labor_cost, 0) as labor_cost,
  COALESCE(parts_data.parts_internal_cost, 0) as parts_cost,
  COALESCE(o.labor_cost, 0) + COALESCE(parts_data.parts_internal_cost, 0) as total_cost,
  
  -- Ingresos
  COALESCE(o.total_cost, 0) as quoted_price,
  COALESCE(payments_data.total_paid, 0) as total_paid,
  COALESCE(o.total_cost, 0) - COALESCE(payments_data.total_paid, 0) as balance_pending,
  
  -- Rentabilidad
  COALESCE(o.total_cost, 0) - (COALESCE(o.labor_cost, 0) + COALESCE(parts_data.parts_internal_cost, 0)) as gross_profit,
  CASE 
    WHEN o.total_cost > 0 
    THEN ROUND(((o.total_cost - (COALESCE(o.labor_cost, 0) + COALESCE(parts_data.parts_internal_cost, 0))) / o.total_cost * 100), 2)
    ELSE 0 
  END as profit_margin_percentage,
  
  -- Desglose de repuestos
  parts_data.parts_count,
  parts_data.parts_sale_total,
  
  -- Pagos
  payments_data.payment_count,
  payments_data.last_payment_date,
  
  o.created_at,
  o.updated_at

FROM orders o
LEFT JOIN customers c ON o.customer_id = c.id
LEFT JOIN (
  SELECT 
    order_id,
    COUNT(*) as parts_count,
    SUM(internal_cost * quantity) as parts_internal_cost,
    SUM(sale_price * quantity) as parts_sale_total
  FROM order_parts
  WHERE status IN ('used', 'sold')
  GROUP BY order_id
) parts_data ON o.id = parts_data.order_id
LEFT JOIN (
  SELECT 
    order_id,
    COUNT(*) as payment_count,
    SUM(amount) as total_paid,
    MAX(payment_date) as last_payment_date
  FROM order_payments
  WHERE payment_status = 'completed'
  GROUP BY order_id
) payments_data ON o.id = payments_data.order_id;

-- 5. Función para obtener resumen financiero de orden
CREATE OR REPLACE FUNCTION get_order_financial_summary(p_order_id UUID)
RETURNS TABLE (
  labor_cost DECIMAL,
  parts_internal_cost DECIMAL,
  parts_sale_total DECIMAL,
  parts_profit DECIMAL,
  total_cost DECIMAL,
  quoted_price DECIMAL,
  total_paid DECIMAL,
  balance_pending DECIMAL,
  gross_profit DECIMAL,
  profit_margin DECIMAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    COALESCE(o.labor_cost, 0),
    COALESCE(parts_data.parts_internal_cost, 0),
    COALESCE(parts_data.parts_sale_total, 0),
    COALESCE(parts_data.parts_profit, 0),
    COALESCE(o.labor_cost, 0) + COALESCE(parts_data.parts_internal_cost, 0),
    COALESCE(o.total_cost, 0),
    COALESCE(payments_data.total_paid, 0),
    COALESCE(o.total_cost, 0) - COALESCE(payments_data.total_paid, 0),
    COALESCE(o.total_cost, 0) - (COALESCE(o.labor_cost, 0) + COALESCE(parts_data.parts_internal_cost, 0)),
    CASE 
      WHEN o.total_cost > 0 
      THEN ROUND(((o.total_cost - (COALESCE(o.labor_cost, 0) + COALESCE(parts_data.parts_internal_cost, 0))) / o.total_cost * 100), 2)
      ELSE 0 
    END
  FROM orders o
  LEFT JOIN (
    SELECT 
      order_id,
      SUM(internal_cost * quantity) as parts_internal_cost,
      SUM(sale_price * quantity) as parts_sale_total,
      SUM((sale_price - internal_cost) * quantity) as parts_profit
    FROM order_parts
    WHERE status IN ('used', 'sold')
    GROUP BY order_id
  ) parts_data ON o.id = parts_data.order_id
  LEFT JOIN (
    SELECT order_id, SUM(amount) as total_paid
    FROM order_payments
    WHERE payment_status = 'completed'
    GROUP BY order_id
  ) payments_data ON o.id = payments_data.order_id
  WHERE o.id = p_order_id;
END;
$$ LANGUAGE plpgsql;

-- 6. Trigger para actualizar timestamp
CREATE OR REPLACE FUNCTION update_order_parts_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_order_parts_timestamp ON order_parts;
CREATE TRIGGER update_order_parts_timestamp
  BEFORE UPDATE ON order_parts
  FOR EACH ROW
  EXECUTE FUNCTION update_order_parts_timestamp();

-- ============================================
-- POLÍTICAS RLS
-- ============================================

ALTER TABLE order_parts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow authenticated users to view order parts"
  ON order_parts FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to insert order parts"
  ON order_parts FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Allow authenticated users to update order parts"
  ON order_parts FOR UPDATE
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to delete order parts"
  ON order_parts FOR DELETE
  TO authenticated
  USING (true);
