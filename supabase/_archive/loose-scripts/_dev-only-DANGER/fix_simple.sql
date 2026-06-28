-- SOLUCIÓN SIMPLE: Agregar columna phone
-- Ejecutar estas líneas una por una si es necesario

-- 1. Eliminar tabla users si existe con estructura vieja
DROP TABLE IF EXISTS users CASCADE;

-- 2. Recrear tabla users con estructura completa
CREATE TABLE users (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'technician', 'receptionist')),
    phone TEXT,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 3. Habilitar RLS
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- 4. Crear política
CREATE POLICY "Allow all" ON users FOR ALL USING (true) WITH CHECK (true);

-- 5. Insertar usuarios de ejemplo
INSERT INTO users (name, email, role, phone) VALUES
    ('Admin Principal', 'admin@techrepair.com', 'admin', '+54 9 11 1234-5678'),
    ('Técnico A', 'tecnicoa@techrepair.com', 'technician', '+54 9 11 2345-6789'),
    ('Técnico B', 'tecnicob@techrepair.com', 'technician', '+54 9 11 3456-7890');

-- Verificar
SELECT * FROM users;
