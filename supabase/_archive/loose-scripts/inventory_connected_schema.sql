-- Tabla de Proveedores
CREATE TABLE IF NOT EXISTS suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  notes TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tabla de Compras a Proveedores
CREATE TABLE IF NOT EXISTS purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  invoice_number TEXT,
  purchase_date DATE NOT NULL,
  subtotal DECIMAL(10, 2) NOT NULL DEFAULT 0,
  taxes DECIMAL(10, 2) NOT NULL DEFAULT 0,
  total DECIMAL(10, 2) NOT NULL DEFAULT 0,
  notes TEXT,
  status TEXT DEFAULT 'pending' -- pending, confirmed, cancelled
);

-- Tabla de Items de Compra
CREATE TABLE IF NOT EXISTS purchase_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID REFERENCES purchases(id) ON DELETE CASCADE,
  inventory_item_id UUID REFERENCES inventory(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_cost DECIMAL(10, 2) NOT NULL,
  subtotal DECIMAL(10, 2) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tabla de Movimientos de Inventario
CREATE TABLE IF NOT EXISTS inventory_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id UUID REFERENCES inventory(id) ON DELETE CASCADE,
  movement_type TEXT NOT NULL, -- in, out, adjustment, order_usage, sale, purchase, return, credit_note, cancellation
  quantity INTEGER NOT NULL,
  previous_stock INTEGER NOT NULL,
  new_stock INTEGER NOT NULL,
  reference_type TEXT, -- order, comprobante, purchase, manual, adjustment, supplier_return, credit_note
  reference_id UUID,
  note TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Índices para mejor performance
CREATE INDEX IF NOT EXISTS idx_purchases_supplier_id ON purchases(supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(status);
CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(purchase_date);

CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase_id ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_inventory_item_id ON purchase_items(inventory_item_id);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_item_id ON inventory_movements(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_type ON inventory_movements(movement_type);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_reference ON inventory_movements(reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_date ON inventory_movements(created_at);

-- Triggers para updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_suppliers_updated_at
  BEFORE UPDATE ON suppliers
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- RLS (Row Level Security)
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;

-- Políticas RLS para suppliers
CREATE POLICY "Suppliers: Todos pueden ver"
  ON suppliers FOR SELECT
  USING (true);

CREATE POLICY "Suppliers: Solo authenticated puede crear"
  ON suppliers FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Suppliers: Solo authenticated puede actualizar"
  ON suppliers FOR UPDATE
  USING (auth.role() = 'authenticated');

CREATE POLICY "Suppliers: Solo authenticated puede eliminar"
  ON suppliers FOR DELETE
  USING (auth.role() = 'authenticated');

-- Políticas RLS para purchases
CREATE POLICY "Purchases: Todos pueden ver"
  ON purchases FOR SELECT
  USING (true);

CREATE POLICY "Purchases: Solo authenticated puede crear"
  ON purchases FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Purchases: Solo authenticated puede actualizar"
  ON purchases FOR UPDATE
  USING (auth.role() = 'authenticated');

CREATE POLICY "Purchases: Solo authenticated puede eliminar"
  ON purchases FOR DELETE
  USING (auth.role() = 'authenticated');

-- Políticas RLS para purchase_items
CREATE POLICY "PurchaseItems: Todos pueden ver"
  ON purchase_items FOR SELECT
  USING (true);

CREATE POLICY "PurchaseItems: Solo authenticated puede crear"
  ON purchase_items FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "PurchaseItems: Solo authenticated puede actualizar"
  ON purchase_items FOR UPDATE
  USING (auth.role() = 'authenticated');

CREATE POLICY "PurchaseItems: Solo authenticated puede eliminar"
  ON purchase_items FOR DELETE
  USING (auth.role() = 'authenticated');

-- Políticas RLS para inventory_movements
CREATE POLICY "InventoryMovements: Todos pueden ver"
  ON inventory_movements FOR SELECT
  USING (true);

CREATE POLICY "InventoryMovements: Solo authenticated puede crear"
  ON inventory_movements FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "InventoryMovements: Solo authenticated puede eliminar"
  ON inventory_movements FOR DELETE
  USING (auth.role() = 'authenticated');
