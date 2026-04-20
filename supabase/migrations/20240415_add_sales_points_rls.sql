-- Agregar políticas RLS para la tabla sales_points
-- Permite a usuarios autenticados crear, leer, actualizar y eliminar puntos de venta

-- Habilitar RLS en la tabla sales_points
ALTER TABLE sales_points ENABLE ROW LEVEL SECURITY;

-- Eliminar políticas existentes si las hay
DROP POLICY IF EXISTS "Allow authenticated users to view sales_points" ON sales_points;
DROP POLICY IF EXISTS "Allow authenticated users to insert sales_points" ON sales_points;
DROP POLICY IF EXISTS "Allow authenticated users to update sales_points" ON sales_points;
DROP POLICY IF EXISTS "Allow authenticated users to delete sales_points" ON sales_points;

-- Crear políticas para usuarios autenticados
CREATE POLICY "Allow authenticated users to view sales_points"
  ON sales_points FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to insert sales_points"
  ON sales_points FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Allow authenticated users to update sales_points"
  ON sales_points FOR UPDATE
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to delete sales_points"
  ON sales_points FOR DELETE
  TO authenticated
  USING (true);
