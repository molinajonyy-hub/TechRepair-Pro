-- TechRepair Pro - Schema SQL para Supabase

-- Tabla de clientes
CREATE TABLE customers (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    address TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Tabla de dispositivos
CREATE TABLE devices (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('smartphone', 'tablet', 'laptop', 'smartwatch', 'other')),
    brand TEXT NOT NULL,
    model TEXT NOT NULL,
    serial TEXT,
    imei TEXT,
    issue TEXT NOT NULL,
    diagnosis TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Tabla de usuarios/técnicos
CREATE TABLE users (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'technician', 'receptionist')),
    phone TEXT,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Tabla de órdenes
CREATE TABLE orders (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    customer_id UUID REFERENCES customers(id) ON DELETE RESTRICT,
    device_id UUID REFERENCES devices(id) ON DELETE RESTRICT,
    technician_id UUID REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'diagnosis', 'waiting_approval', 'repair', 'waiting_parts', 'ready_delivery', 'waiting_payment', 'completed', 'cancelled')),
    priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('urgent', 'high', 'medium', 'low')),
    estimated_total DECIMAL(10,2) DEFAULT 0,
    labor_cost DECIMAL(10,2) DEFAULT 0,
    total_cost DECIMAL(10,2) DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Tabla de historial de estados
CREATE TABLE status_history (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    note TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Tabla de notas
CREATE TABLE notes (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    is_internal BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Tabla de repuestos usados
CREATE TABLE parts_used (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    description TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price DECIMAL(10,2) NOT NULL,
    subtotal DECIMAL(10,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Tabla de inventario
CREATE TABLE inventory (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT,
    stock INTEGER NOT NULL DEFAULT 0,
  min_stock INTEGER NOT NULL DEFAULT 1,
    cost_price DECIMAL(10,2) NOT NULL,
    sale_price DECIMAL(10,2) NOT NULL,
    supplier_id UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Tabla de proveedores
CREATE TABLE suppliers (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL,
    contact_name TEXT,
    phone TEXT,
    email TEXT,
    address TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Tabla de gastos
CREATE TABLE expenses (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Tabla de documentos/adjuntos
CREATE TABLE documents (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    file_url TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_size INTEGER,
    uploaded_by TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Índices para mejorar performance
CREATE INDEX idx_orders_customer_id ON orders(customer_id);
CREATE INDEX idx_orders_device_id ON orders(device_id);
CREATE INDEX idx_orders_technician_id ON orders(technician_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at);
CREATE INDEX idx_devices_customer_id ON devices(customer_id);
CREATE INDEX idx_status_history_order_id ON status_history(order_id);
CREATE INDEX idx_notes_order_id ON notes(order_id);
CREATE INDEX idx_parts_used_order_id ON parts_used(order_id);
CREATE INDEX idx_documents_order_id ON documents(order_id);

-- Función para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers para updated_at
CREATE TRIGGER update_customers_updated_at BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_devices_updated_at BEFORE UPDATE ON devices
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_inventory_updated_at BEFORE UPDATE ON inventory
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_suppliers_updated_at BEFORE UPDATE ON suppliers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insertar datos de ejemplo

-- Usuarios de ejemplo
INSERT INTO users (id, name, email, role, phone) VALUES
    (gen_random_uuid(), 'Admin Principal', 'admin@techrepair.com', 'admin', '+54 9 11 1234-5678'),
    (gen_random_uuid(), 'Técnico A', 'tecnicoa@techrepair.com', 'technician', '+54 9 11 2345-6789'),
    (gen_random_uuid(), 'Técnico B', 'tecnicob@techrepair.com', 'technician', '+54 9 11 3456-7890');

-- Clientes de ejemplo
INSERT INTO customers (name, phone, email, address) VALUES
    ('Juan Pérez', '+54 9 11 1234-5678', 'juan@email.com', 'Av. Corrientes 1234, CABA'),
    ('María García', '+54 9 11 8765-4321', 'maria@email.com', 'Av. Santa Fe 5678, CABA'),
    ('Carlos López', '+54 9 11 2468-1357', 'carlos@email.com', 'Av. Libertador 9876, CABA'),
    ('Ana Martínez', '+54 9 11 1357-2468', 'ana@email.com', 'Av. Cabildo 4567, CABA');

-- Inventario de ejemplo
INSERT INTO inventory (code, name, category, description, stock, min_stock, cost_price, sale_price) VALUES
    ('SCR-IPH13P', 'Pantalla iPhone 13 Pro OLED', 'Pantallas', 'Pantalla OLED original para iPhone 13 Pro', 5, 3, 200, 280),
    ('BAT-IPH13P', 'Batería iPhone 13 Pro', 'Baterías', 'Batería original 3095mAh', 12, 5, 30, 45),
    ('SCR-SAM21', 'Pantalla Samsung S21', 'Pantallas', 'Pantalla AMOLED Samsung Galaxy S21', 3, 3, 160, 220),
    ('BAT-SAM21', 'Batería Samsung S21', 'Baterías', 'Batería original 4000mAh', 8, 5, 25, 40),
    ('CHG-USB-C', 'Conector de Carga USB-C', 'Conectores', 'Conector de carga genérico USB-C', 25, 10, 8, 15),
    ('CHG-LIGHT', 'Conector de Carga Lightning', 'Conectores', 'Conector de carga para iPhone', 20, 10, 10, 18);

-- Proveedores de ejemplo
INSERT INTO suppliers (name, contact_name, phone, email, address) VALUES
    ('TecnoParts S.A.', 'Jorge Martínez', '+54 9 11 2345-6789', 'ventas@tecnoparts.com', 'Av. Rivadavia 7890, CABA'),
    ('DisplayMax', 'Laura Gómez', '+54 9 11 9876-5432', 'info@displaymax.com', 'Av. Belgrano 3456, CABA'),
    ('Cellular Solutions', 'Roberto Silva', '+54 9 11 4567-8901', 'contacto@cellularsol.com', 'Av. Córdoba 6789, CABA');

-- Gastos de ejemplo
INSERT INTO expenses (description, category, amount, date) VALUES
    ('Compra de pantallas iPhone', 'Inventario', 2800, '2024-01-15'),
    ('Alquiler local enero', 'Operativos', 1500, '2024-01-01'),
    ('Servicios públicos enero', 'Operativos', 320, '2024-01-10'),
    ('Herramientas de reparación', 'Equipamiento', 450, '2024-01-12');
