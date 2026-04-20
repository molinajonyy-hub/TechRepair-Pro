-- ============================================
-- POLÍTICAS RLS PARA TODAS LAS TABLAS
-- Ejecutar DESPUÉS de verify_tables.sql
-- ============================================

-- Función helper para aplicar políticas solo si la tabla existe
DO $$
DECLARE
  tables_list text[] := ARRAY[
    'orders', 'customers', 'devices', 'inventory', 
    'order_payments', 'order_parts', 'status_history', 
    'notifications', 'order_checklists', 'documents', 'users'
  ];
  t text;
BEGIN
  FOREACH t IN ARRAY tables_list
  LOOP
    -- Verificar si tabla existe
    IF EXISTS (SELECT 1 FROM information_schema.tables 
               WHERE table_schema = 'public' AND table_name = t) THEN
      
      -- Habilitar RLS
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
      
      -- Crear políticas SELECT
      EXECUTE format(
        'DROP POLICY IF EXISTS "Allow authenticated users to view %1$s" ON %1$s;
         CREATE POLICY "Allow authenticated users to view %1$s" ON %1$s FOR SELECT TO authenticated USING (true);',
        t
      );
      
      -- Crear políticas INSERT (excepto users, status_history que son solo lectura o insert controlado)
      IF t NOT IN ('users') THEN
        EXECUTE format(
          'DROP POLICY IF EXISTS "Allow authenticated users to insert %1$s" ON %1$s;
           CREATE POLICY "Allow authenticated users to insert %1$s" ON %1$s FOR INSERT TO authenticated WITH CHECK (true);',
          t
        );
      END IF;
      
      -- Crear políticas UPDATE
      IF t NOT IN ('users', 'status_history') THEN
        EXECUTE format(
          'DROP POLICY IF EXISTS "Allow authenticated users to update %1$s" ON %1$s;
           CREATE POLICY "Allow authenticated users to update %1$s" ON %1$s FOR UPDATE TO authenticated USING (true);',
          t
        );
      END IF;
      
      -- Crear políticas DELETE (solo para algunas tablas)
      IF t IN ('orders', 'customers', 'devices', 'inventory', 'order_payments', 'order_parts', 'documents') THEN
        EXECUTE format(
          'DROP POLICY IF EXISTS "Allow authenticated users to delete %1$s" ON %1$s;
           CREATE POLICY "Allow authenticated users to delete %1$s" ON %1$s FOR DELETE TO authenticated USING (true);',
          t
        );
      END IF;
      
      RAISE NOTICE 'Políticas creadas para tabla: %', t;
    ELSE
      RAISE NOTICE 'Tabla no encontrada: %', t;
    END IF;
  END LOOP;
END $$;

-- ============================================
-- VERIFICACIÓN FINAL
-- ============================================
SELECT 
  tablename,
  policyname,
  cmd as command
FROM pg_policies 
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
