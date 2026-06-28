-- =========================================================
-- SISTEMA DE MARCAS Y MODELOS DE DISPOSITIVOS
-- =========================================================

-- 1) Crear tabla de marcas
CREATE TABLE IF NOT EXISTS public.brands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES public.auth.users(id) ON DELETE SET NULL,
  UNIQUE(name, business_id)
);

-- 2) Crear índices para marcas
CREATE INDEX IF NOT EXISTS brands_business_id_idx ON public.brands(business_id);
CREATE INDEX IF NOT EXISTS brands_name_idx ON public.brands(name);

-- 3) Crear tabla de modelos
CREATE TABLE IF NOT EXISTS public.device_models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  brand_id UUID NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES public.auth.users(id) ON DELETE SET NULL,
  UNIQUE(name, brand_id, business_id)
);

-- 4) Crear índices para modelos
CREATE INDEX IF NOT EXISTS device_models_brand_id_idx ON public.device_models(brand_id);
CREATE INDEX IF NOT EXISTS device_models_business_id_idx ON public.device_models(business_id);
CREATE INDEX IF NOT EXISTS device_models_name_idx ON public.device_models(name);

-- 5) Habilitar RLS para marcas
ALTER TABLE public.brands ENABLE ROW LEVEL SECURITY;

-- 6) Políticas RLS para marcas
DROP POLICY IF EXISTS brands_select ON public.brands;
CREATE POLICY brands_select
  ON public.brands
  FOR SELECT
  TO authenticated
  USING (business_id = public.current_user_business_id());

DROP POLICY IF EXISTS brands_insert ON public.brands;
CREATE POLICY brands_insert
  ON public.brands
  FOR INSERT
  TO authenticated
  WITH CHECK (
    business_id = public.current_user_business_id()
    AND public.current_user_role() IN ('owner', 'admin', 'technician')
  );

DROP POLICY IF EXISTS brands_update ON public.brands;
CREATE POLICY brands_update
  ON public.brands
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

DROP POLICY IF EXISTS brands_delete ON public.brands;
CREATE POLICY brands_delete
  ON public.brands
  FOR DELETE
  TO authenticated
  USING (
    business_id = public.current_user_business_id()
    AND public.current_user_role() IN ('owner', 'admin')
  );

-- 7) Habilitar RLS para modelos
ALTER TABLE public.device_models ENABLE ROW LEVEL SECURITY;

-- 8) Políticas RLS para modelos
DROP POLICY IF EXISTS device_models_select ON public.device_models;
CREATE POLICY device_models_select
  ON public.device_models
  FOR SELECT
  TO authenticated
  USING (business_id = public.current_user_business_id());

DROP POLICY IF EXISTS device_models_insert ON public.device_models;
CREATE POLICY device_models_insert
  ON public.device_models
  FOR INSERT
  TO authenticated
  WITH CHECK (
    business_id = public.current_user_business_id()
    AND public.current_user_role() IN ('owner', 'admin', 'technician')
  );

DROP POLICY IF EXISTS device_models_update ON public.device_models;
CREATE POLICY device_models_update
  ON public.device_models
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

DROP POLICY IF EXISTS device_models_delete ON public.device_models;
CREATE POLICY device_models_delete
  ON public.device_models
  FOR DELETE
  TO authenticated
  USING (
    business_id = public.current_user_business_id()
    AND public.current_user_role() IN ('owner', 'admin')
  );

-- 9) Grant explícito para authenticated
GRANT SELECT ON public.brands TO authenticated;
GRANT INSERT ON public.brands TO authenticated;
GRANT UPDATE ON public.brands TO authenticated;
GRANT DELETE ON public.brands TO authenticated;

GRANT SELECT ON public.device_models TO authenticated;
GRANT INSERT ON public.device_models TO authenticated;
GRANT UPDATE ON public.device_models TO authenticated;
GRANT DELETE ON public.device_models TO authenticated;

-- 10) Función para obtener o crear marca
CREATE OR REPLACE FUNCTION public.get_or_create_brand(
  p_name TEXT,
  p_business_id UUID
) RETURNS UUID AS $$
DECLARE
  v_brand_id UUID;
BEGIN
  -- Intentar obtener marca existente
  SELECT id INTO v_brand_id
  FROM public.brands
  WHERE name = TRIM(p_name)
    AND business_id = p_business_id
  LIMIT 1;

  -- Si no existe, crearla
  IF v_brand_id IS NULL THEN
    INSERT INTO public.brands (name, business_id, created_by)
    VALUES (TRIM(p_name), p_business_id, auth.uid())
    RETURNING id INTO v_brand_id;
  END IF;

  RETURN v_brand_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 11) Función para obtener o crear modelo
CREATE OR REPLACE FUNCTION public.get_or_create_model(
  p_name TEXT,
  p_brand_id UUID,
  p_business_id UUID
) RETURNS UUID AS $$
DECLARE
  v_model_id UUID;
BEGIN
  -- Intentar obtener modelo existente
  SELECT id INTO v_model_id
  FROM public.device_models
  WHERE name = TRIM(p_name)
    AND brand_id = p_brand_id
    AND business_id = p_business_id
  LIMIT 1;

  -- Si no existe, crearlo
  IF v_model_id IS NULL THEN
    INSERT INTO public.device_models (name, brand_id, business_id, created_by)
    VALUES (TRIM(p_name), p_brand_id, p_business_id, auth.uid())
    RETURNING id INTO v_model_id;
  END IF;

  RETURN v_model_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 12) Grant para las funciones
GRANT EXECUTE ON FUNCTION public.get_or_create_brand(TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_or_create_model(TEXT, UUID, UUID) TO authenticated;
