-- FIX: Agregar columna phone a tabla users si no existe
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'users' 
        AND column_name = 'phone'
    ) THEN
        ALTER TABLE users ADD COLUMN phone TEXT;
    END IF;
END $$;

-- Verificar que la columna se agregó
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'users';
