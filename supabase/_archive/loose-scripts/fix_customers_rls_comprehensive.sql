-- =========================================================
-- DIAGNÓSTICO Y CORRECCIÓN DE RLS PARA CUSTOMERS
-- =========================================================

-- 1) Verificar si la tabla existe
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'customers' AND table_schema = 'public') THEN
    RAISE NOTICE 'Tabla customers existe';
  ELSE
    RAISE NOTICE 'Tabla customers NO existe - creando...';
  END IF;
END
$$;

-- 2) Asegurar que la tabla existe con la estructura correcta
CREATE TABLE IF NOT EXISTS public.customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  city TEXT,
  province TEXT,
  postal_code TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3) Habilitar RLS
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

-- 4) ELIMINAR políticas existentes (para evitar conflictos)
DROP POLICY IF EXISTS customers_select ON public.customers;
DROP POLICY IF EXISTS customers_insert ON public.customers;
DROP POLICY IF EXISTS customers_update ON public.customers;
DROP POLICY IF EXISTS customers_delete ON public.customers;

-- 5) Crear políticas RLS nuevas y correctas
DROP POLICY IF EXISTS customers_select ON public.customers;
CREATE POLICY customers_select
  ON public.customers
  FOR SELECT
  TO authenticated
  USING (business_id = public.current_user_business_id());

DROP POLICY IF EXISTS customers_insert ON public.customers;
CREATE POLICY customers_insert
  ON public.customers
  FOR INSERT
  TO authenticated
  WITH CHECK (
    business_id = public.current_user_business_id()
    AND public.current_user_role() IN ('owner', 'admin')
  );

DROP POLICY IF EXISTS customers_update ON public.customers;
CREATE POLICY customers_update
  ON public.customers
  FOR UPDATE
  TO authenticated
  USING (
    business_id = public.current_user_business_id()
    AND public.current_user_role() IN ('owner', 'admin')
  )
  WITH CHECK (
    business_id = public.current_user_business_id()
    AND public.current_user_role() IN ('owner', 'admin')
  );

DROP POLICY IF EXISTS customers_delete ON public.customers;
CREATE POLICY customers_delete
  ON public.customers
  FOR DELETE
  TO authenticated
  USING (
    business_id = public.current_user_business_id()
    AND public.current_user_role() IN ('owner', 'admin')
  );

-- 6) Verificar políticas creadas
DO $$
DECLARE
  policy_count INT;
BEGIN
  SELECT COUNT(*) INTO policy_count
  FROM pg_policies
  WHERE tablename = 'customers' AND schemaname = 'public';
  
  RAISE NOTICE 'Políticas RLS creadas para customers: %', policy_count;
END
$$;

-- 7) Grant explícito para authenticated (por seguridad)
GRANT SELECT ON public.customers TO authenticated;
GRANT INSERT ON public.customers TO authenticated;
GRANT UPDATE ON public.customers TO authenticated;
GRANT DELETE ON public.customers TO authenticated;
