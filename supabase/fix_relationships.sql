-- Fix relationships in Supabase schema
-- Ejecutar esto en el SQL Editor de Supabase

-- Verificar si existe la foreign key entre orders y users
-- Si no existe, esta consulta la agregará

-- Primero, verificar que las tablas existen
DO $$
BEGIN
    -- Agregar foreign key de orders.technician_id a users.id si no existe
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'orders_technician_id_fkey'
        AND table_name = 'orders'
    ) THEN
        ALTER TABLE orders 
        ADD CONSTRAINT orders_technician_id_fkey 
        FOREIGN KEY (technician_id) 
        REFERENCES users(id) 
        ON DELETE SET NULL;
    END IF;
END $$;

-- Verificar foreign keys existentes
SELECT 
    tc.table_name, 
    kcu.column_name, 
    ccu.table_name AS foreign_table_name,
    ccu.column_name AS foreign_column_name 
FROM information_schema.table_constraints AS tc 
JOIN information_schema.key_column_usage AS kcu
    ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage AS ccu
    ON ccu.constraint_name = tc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY' 
AND tc.table_name = 'orders';
