-- Crear bucket business-assets para logos del negocio
INSERT INTO storage.buckets (id, name, public) 
VALUES ('business-assets', 'business-assets', true)
ON CONFLICT (id) DO NOTHING;

-- Habilitar RLS en storage.objects
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- Eliminar políticas existentes si existen
DROP POLICY IF EXISTS "Public read access for business assets" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload business assets" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update business assets" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can delete business assets" ON storage.objects;

-- Política para permitir lectura pública de los logos
CREATE POLICY "Public read access for business assets"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'business-assets');

-- Política para permitir upload a cualquier usuario autenticado
CREATE POLICY "Authenticated users can upload business assets"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'business-assets');

-- Política para permitir actualizar a cualquier usuario autenticado
CREATE POLICY "Authenticated users can update business assets"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'business-assets');

-- Política para permitir eliminar a cualquier usuario autenticado
CREATE POLICY "Authenticated users can delete business assets"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'business-assets');
