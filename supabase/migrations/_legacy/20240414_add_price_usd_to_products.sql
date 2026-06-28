-- Agregar campo price_usd a tabla inventory
ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS price_usd DECIMAL(10, 2);

-- Agregar campo para guardar el tipo de cambio usado
ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS exchange_rate_used DECIMAL(10, 2);

-- Agregar campo para saber si el precio está vinculado al dólar
ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS linked_to_dolar BOOLEAN DEFAULT false;

-- Crear índice para productos vinculados al dólar
CREATE INDEX IF NOT EXISTS idx_inventory_linked_to_dolar ON inventory(linked_to_dolar) WHERE linked_to_dolar = true;
