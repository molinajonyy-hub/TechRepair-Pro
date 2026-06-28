-- ============================================
-- EMERGENCY FIX - Deshabilitar todo RLS
-- ============================================

-- 1. Crear tablas SI NO EXISTEN
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

CREATE TABLE IF NOT EXISTS order_parts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  inventory_part_id UUID REFERENCES inventory(id),
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

CREATE TABLE IF NOT EXISTS status_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  status VARCHAR(50) NOT NULL,
  note TEXT,
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

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

CREATE TABLE IF NOT EXISTS device_inspections (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL CHECK (type IN ('reception', 'final')),
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
  screen_condition VARCHAR(50) DEFAULT 'Perfecto',
  back_condition VARCHAR(50) DEFAULT 'Perfecto',
  frame_condition VARCHAR(50) DEFAULT 'Perfecto',
  camera_lens VARCHAR(50) DEFAULT 'Perfecto',
  accessories TEXT[] DEFAULT '{}',
  customer_notes TEXT,
  technician_notes TEXT,
  customer_signature TEXT,
  photos TEXT[] DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT unique_order_inspection UNIQUE (order_id, type)
);

-- 2. ELIMINAR TODAS LAS POLÍTICAS EXISTENTES
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN 
    SELECT schemaname, tablename, policyname 
    FROM pg_policies 
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "%I" ON %I.%I;', 
      pol.policyname, pol.schemaname, pol.tablename);
  END LOOP;
END $$;

-- 3. DESHABILITAR RLS EN TODAS LAS TABLAS
ALTER TABLE IF EXISTS orders DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS customers DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS devices DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS inventory DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS order_payments DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS order_parts DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS status_history DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS notifications DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS order_checklists DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS documents DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS device_inspections DISABLE ROW LEVEL SECURITY;

-- 4. CREAR POLÍTICAS PERMISIVAS PARA ANON Y AUTHENTICATED
DO $$
DECLARE
  tables_list text[] := ARRAY[
    'orders', 'customers', 'devices', 'inventory', 
    'order_payments', 'order_parts', 'status_history', 
    'notifications', 'order_checklists', 'documents', 
    'device_inspections'
  ];
  t text;
BEGIN
  FOREACH t IN ARRAY tables_list
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables 
               WHERE table_schema = 'public' AND table_name = t) THEN
      
      -- Habilitar RLS pero con política permisiva
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
      
      -- Política para anon (sin autenticar) - PERMITE TODO
      EXECUTE format(
        'CREATE POLICY "allow_all_%1$s" ON %1$s FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);',
        t
      );
      
    END IF;
  END LOOP;
END $$;

-- 5. VERIFICAR ESTADO
SELECT 
  relname as tabla,
  relrowsecurity as rls_activo,
  (SELECT COUNT(*) FROM pg_policies WHERE tablename = relname) as politicas
FROM pg_class
WHERE relname IN ('orders', 'customers', 'devices', 'inventory', 'order_payments', 'order_parts', 'status_history', 'notifications', 'order_checklists', 'documents', 'device_inspections')
AND relkind = 'r';
