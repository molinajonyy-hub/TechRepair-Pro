-- ============================================
-- CORREGIR SEARCH PATH MUTABLE EN FUNCIÓN
-- ============================================

-- Recrear la función con search_path fijo (sin DROP para evitar errores de dependencias)
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

-- Verificar que la función se actualizó correctamente
SELECT 
  routine_name,
  routine_type,
  security_type
FROM information_schema.routines
WHERE routine_name = 'update_updated_at_column' 
AND routine_schema = 'public';
