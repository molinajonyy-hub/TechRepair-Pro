-- ============================================
-- VERIFICAR Y CREAR TABLAS NECESARIAS
-- ============================================

-- 1. Tabla customers (si no existe)
CREATE TABLE IF NOT EXISTS customers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  email VARCHAR(255),
  address TEXT,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 2. Tabla devices (si no existe)
CREATE TABLE IF NOT EXISTS devices (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  brand VARCHAR(100) NOT NULL,
  model VARCHAR(100) NOT NULL,
  serial_number VARCHAR(100),
  issue TEXT,
  password VARCHAR(100),
  condition TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 3. Tabla orders (si no existe)
CREATE TABLE IF NOT EXISTS orders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id UUID REFERENCES customers(id),
  device_id UUID REFERENCES devices(id),
  technician_id UUID,
  status VARCHAR(50) DEFAULT 'new',
  priority VARCHAR(20) DEFAULT 'normal',
  issue_description TEXT,
  diagnosis TEXT,
  solution TEXT,
  labor_cost DECIMAL(10,2) DEFAULT 0,
  parts_cost DECIMAL(10,2) DEFAULT 0,
  total_cost DECIMAL(10,2) DEFAULT 0,
  amount_paid DECIMAL(10,2) DEFAULT 0,
  balance_pending DECIMAL(10,2) DEFAULT 0,
  estimated_total DECIMAL(10,2),
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 4. Tabla inventory (si no existe)
CREATE TABLE IF NOT EXISTS inventory (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  code VARCHAR(100) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(100),
  stock_quantity INTEGER DEFAULT 0,
  reserved_quantity INTEGER DEFAULT 0,
  min_stock INTEGER DEFAULT 1,
  cost_price DECIMAL(10,2) DEFAULT 0,
  sale_price DECIMAL(10,2) DEFAULT 0,
  location VARCHAR(100),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 5. Tabla order_payments (si no existe)
CREATE TABLE IF NOT EXISTS order_payments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  amount DECIMAL(10,2) NOT NULL,
  payment_method VARCHAR(50),
  payment_date TIMESTAMP WITH TIME ZONE DEFAULT now(),
  is_down_payment BOOLEAN DEFAULT false,
  payment_status VARCHAR(50) DEFAULT 'completed',
  receipt_number VARCHAR(100),
  due_date DATE,
  notes TEXT
);

-- 6. Tabla order_parts (si no existe)
CREATE TABLE IF NOT EXISTS order_parts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  part_number VARCHAR(100),
  internal_cost DECIMAL(10,2) DEFAULT 0,
  sale_price DECIMAL(10,2) DEFAULT 0,
  quantity INTEGER DEFAULT 1,
  margin_amount DECIMAL(10,2) DEFAULT 0,
  margin_percentage DECIMAL(5,2) DEFAULT 0,
  status VARCHAR(50) DEFAULT 'pending',
  deduct_from_inventory BOOLEAN DEFAULT true,
  notes TEXT,
  added_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 7. Tabla status_history (si no existe)
CREATE TABLE IF NOT EXISTS status_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  status VARCHAR(50) NOT NULL,
  note TEXT,
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 8. Tabla notifications (si no existe)
CREATE TABLE IF NOT EXISTS notifications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 9. Tabla order_checklists (si no existe)
CREATE TABLE IF NOT EXISTS order_checklists (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  diagnosis_done BOOLEAN DEFAULT false,
  diagnosis_notes TEXT,
  repair_done BOOLEAN DEFAULT false,
  parts_replaced TEXT[],
  final_test_passed BOOLEAN DEFAULT false,
  cleaning_done BOOLEAN DEFAULT false,
  quality_control BOOLEAN DEFAULT false,
  retirement_signature TEXT,
  retirement_signature_date TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 10. Tabla documents (si no existe)
CREATE TABLE IF NOT EXISTS documents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  file_name VARCHAR(255) NOT NULL,
  file_url TEXT NOT NULL,
  file_type VARCHAR(100),
  file_size INTEGER,
  storage_path TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Verificar tablas creadas
SELECT 
  table_name,
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = t.table_name) as column_count
FROM information_schema.tables t
WHERE table_schema = 'public'
AND table_type = 'BASE TABLE'
ORDER BY table_name;
