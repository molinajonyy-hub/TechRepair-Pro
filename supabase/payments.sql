-- ============================================
-- TABLA DE PAGOS PARA CONTROL DE SALDOS
-- ============================================

CREATE TABLE IF NOT EXISTS order_payments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  
  -- Detalles del pago
  amount DECIMAL(10,2) NOT NULL,
  payment_method VARCHAR(50) NOT NULL, -- 'cash', 'credit_card', 'debit_card', 'transfer', 'mercadopago', etc.
  
  -- Referencia externa (si aplica)
  reference_number VARCHAR(100),
  
  -- Quién recibió el pago
  received_by UUID REFERENCES auth.users(id),
  
  -- Notas
  notes TEXT,
  
  -- Fechas
  payment_date TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  
  -- Validación: monto debe ser positivo
  CONSTRAINT positive_amount CHECK (amount > 0)
);

-- Índices
CREATE INDEX idx_order_payments_order_id ON order_payments(order_id);
CREATE INDEX idx_order_payments_date ON order_payments(payment_date);

-- ============================================
-- FUNCIÓN PARA CALCULAR SALDO PENDIENTE
-- ============================================

CREATE OR REPLACE FUNCTION get_order_balance(order_uuid UUID)
RETURNS DECIMAL(10,2) AS $$
DECLARE
  total_cost DECIMAL(10,2);
  total_paid DECIMAL(10,2);
  balance DECIMAL(10,2);
BEGIN
  -- Obtener costo total de la orden
  SELECT o.total_cost INTO total_cost
  FROM orders o
  WHERE o.id = order_uuid;
  
  -- Sumar todos los pagos
  SELECT COALESCE(SUM(p.amount), 0) INTO total_paid
  FROM order_payments p
  WHERE p.order_id = order_uuid;
  
  -- Calcular saldo
  balance := COALESCE(total_cost, 0) - total_paid;
  
  RETURN balance;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- VISTA CON SALDO CALCULADO
-- ============================================

CREATE OR REPLACE VIEW orders_with_balance AS
SELECT 
  o.*,
  COALESCE(o.total_cost, 0) as calculated_total,
  COALESCE(
    (SELECT SUM(p.amount) FROM order_payments p WHERE p.order_id = o.id), 
    0
  ) as total_paid,
  COALESCE(o.total_cost, 0) - COALESCE(
    (SELECT SUM(p.amount) FROM order_payments p WHERE p.order_id = o.id), 
    0
  ) as balance_pending
FROM orders o;

-- ============================================
-- POLÍTICAS RLS
-- ============================================

ALTER TABLE order_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow authenticated users to view payments"
  ON order_payments FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to insert payments"
  ON order_payments FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- ============================================
-- TRIGGER: Actualizar amount_paid en orders
-- ============================================

CREATE OR REPLACE FUNCTION update_order_amount_paid()
RETURNS TRIGGER AS $$
BEGIN
  -- Actualizar el monto pagado en la orden
  UPDATE orders
  SET amount_paid = (
    SELECT COALESCE(SUM(amount), 0)
    FROM order_payments
    WHERE order_id = COALESCE(NEW.order_id, OLD.order_id)
  )
  WHERE id = COALESCE(NEW.order_id, OLD.order_id);
  
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_order_paid_amount ON order_payments;
CREATE TRIGGER update_order_paid_amount
  AFTER INSERT OR UPDATE OR DELETE ON order_payments
  FOR EACH ROW
  EXECUTE FUNCTION update_order_amount_paid();
