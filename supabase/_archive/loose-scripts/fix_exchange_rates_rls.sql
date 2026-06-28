-- =========================================================
-- DIAGNÓSTICO Y CORRECCIÓN DE RLS PARA EXCHANGE_RATES
-- =========================================================

-- 1) Verificar si la tabla existe
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'exchange_rates' AND table_schema = 'public') THEN
    RAISE NOTICE 'Tabla exchange_rates existe';
  ELSE
    RAISE NOTICE 'Tabla exchange_rates NO existe - creando...';
  END IF;
END
$$;

-- 2) Asegurar que la tabla existe
CREATE TABLE IF NOT EXISTS public.exchange_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  base_currency TEXT NOT NULL DEFAULT 'USD',
  target_currency TEXT NOT NULL DEFAULT 'ARS',
  rate NUMERIC(12,4) NOT NULL,
  is_manual BOOLEAN NOT NULL DEFAULT TRUE,
  source TEXT DEFAULT 'manual',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3) Habilitar RLS
ALTER TABLE public.exchange_rates ENABLE ROW LEVEL SECURITY;

-- 4) ELIMINAR políticas existentes (para evitar conflictos)
DROP POLICY IF EXISTS exchange_rates_select ON public.exchange_rates;
DROP POLICY IF EXISTS exchange_rates_insert ON public.exchange_rates;
DROP POLICY IF EXISTS exchange_rates_update ON public.exchange_rates;
DROP POLICY IF EXISTS exchange_rates_delete ON public.exchange_rates;

-- 5) Crear políticas RLS nuevas y correctas
DROP POLICY IF EXISTS exchange_rates_select ON public.exchange_rates;
CREATE POLICY exchange_rates_select
  ON public.exchange_rates
  FOR SELECT
  TO authenticated
  USING (business_id = public.current_user_business_id());

DROP POLICY IF EXISTS exchange_rates_insert ON public.exchange_rates;
CREATE POLICY exchange_rates_insert
  ON public.exchange_rates
  FOR INSERT
  TO authenticated
  WITH CHECK (
    business_id = public.current_user_business_id()
    AND public.current_user_role() IN ('owner', 'admin')
  );

DROP POLICY IF EXISTS exchange_rates_update ON public.exchange_rates;
CREATE POLICY exchange_rates_update
  ON public.exchange_rates
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

DROP POLICY IF EXISTS exchange_rates_delete ON public.exchange_rates;
CREATE POLICY exchange_rates_delete
  ON public.exchange_rates
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
  WHERE tablename = 'exchange_rates' AND schemaname = 'public';
  
  RAISE NOTICE 'Políticas RLS creadas para exchange_rates: %', policy_count;
END
$$;

-- 7) Lo mismo para business_settings
ALTER TABLE public.business_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS business_settings_select ON public.business_settings;
CREATE POLICY business_settings_select
  ON public.business_settings
  FOR SELECT
  TO authenticated
  USING (business_id = public.current_user_business_id());

DROP POLICY IF EXISTS business_settings_insert ON public.business_settings;
CREATE POLICY business_settings_insert
  ON public.business_settings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    business_id = public.current_user_business_id()
    AND public.current_user_role() IN ('owner', 'admin')
  );

DROP POLICY IF EXISTS business_settings_update ON public.business_settings;
CREATE POLICY business_settings_update
  ON public.business_settings
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

DROP POLICY IF EXISTS business_settings_delete ON public.business_settings;
CREATE POLICY business_settings_delete
  ON public.business_settings
  FOR DELETE
  TO authenticated
  USING (
    business_id = public.current_user_business_id()
    AND public.current_user_role() IN ('owner', 'admin')
  );

-- 8) Grant explícito para authenticated (por seguridad)
GRANT SELECT ON public.exchange_rates TO authenticated;
GRANT INSERT ON public.exchange_rates TO authenticated;
GRANT UPDATE ON public.exchange_rates TO authenticated;
GRANT DELETE ON public.exchange_rates TO authenticated;

GRANT SELECT ON public.business_settings TO authenticated;
GRANT INSERT ON public.business_settings TO authenticated;
GRANT UPDATE ON public.business_settings TO authenticated;
GRANT DELETE ON public.business_settings TO authenticated;
