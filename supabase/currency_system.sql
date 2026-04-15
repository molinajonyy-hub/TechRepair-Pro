-- =========================================================
-- SISTEMA DE PRECIOS MULTIMONEDA (BASE USD)
-- Versión limpia para Supabase / PostgreSQL
-- =========================================================

-- ---------------------------------------------------------
-- 1) TABLA DE TIPOS DE CAMBIO
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.exchange_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  base_currency TEXT NOT NULL DEFAULT 'USD',
  target_currency TEXT NOT NULL DEFAULT 'ARS',
  rate NUMERIC(12,4) NOT NULL,
  is_manual BOOLEAN NOT NULL DEFAULT TRUE,
  source TEXT DEFAULT 'manual',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT exchange_rates_rate_positive_check
    CHECK (rate > 0),

  CONSTRAINT exchange_rates_base_currency_check
    CHECK (base_currency IN ('USD', 'ARS')),

  CONSTRAINT exchange_rates_target_currency_check
    CHECK (target_currency IN ('USD', 'ARS'))
);

-- Índices
CREATE INDEX IF NOT EXISTS exchange_rates_business_id_idx
  ON public.exchange_rates(business_id);

CREATE INDEX IF NOT EXISTS exchange_rates_currency_pair_idx
  ON public.exchange_rates(business_id, base_currency, target_currency, updated_at DESC);

-- ---------------------------------------------------------
-- 2) TABLA DE CONFIGURACIÓN DEL NEGOCIO
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.business_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL UNIQUE REFERENCES public.businesses(id) ON DELETE CASCADE,
  default_currency TEXT NOT NULL DEFAULT 'ARS',
  show_usd_price BOOLEAN NOT NULL DEFAULT FALSE,
  auto_update_rate BOOLEAN NOT NULL DEFAULT FALSE,
  rate_api_url TEXT,
  rate_update_frequency_hours INT NOT NULL DEFAULT 24,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT business_settings_default_currency_check
    CHECK (default_currency IN ('USD', 'ARS')),

  CONSTRAINT business_settings_rate_update_frequency_positive_check
    CHECK (rate_update_frequency_hours > 0)
);

-- ---------------------------------------------------------
-- 3) ALTERS PARA COMPATIBILIDAD SI LAS TABLAS YA EXISTÍAN
-- ---------------------------------------------------------
ALTER TABLE public.exchange_rates
  ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS base_currency TEXT NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS target_currency TEXT NOT NULL DEFAULT 'ARS',
  ADD COLUMN IF NOT EXISTS rate NUMERIC(12,4),
  ADD COLUMN IF NOT EXISTS is_manual BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE public.business_settings
  ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS default_currency TEXT NOT NULL DEFAULT 'ARS',
  ADD COLUMN IF NOT EXISTS show_usd_price BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auto_update_rate BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS rate_api_url TEXT,
  ADD COLUMN IF NOT EXISTS rate_update_frequency_hours INT NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Forzar NOT NULL por si la tabla existía de antes
ALTER TABLE public.exchange_rates
  ALTER COLUMN business_id SET NOT NULL,
  ALTER COLUMN rate SET NOT NULL;

ALTER TABLE public.business_settings
  ALTER COLUMN business_id SET NOT NULL;

-- Constraints seguras para tablas existentes
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'exchange_rates_rate_positive_check'
  ) THEN
    ALTER TABLE public.exchange_rates
      ADD CONSTRAINT exchange_rates_rate_positive_check
      CHECK (rate > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'exchange_rates_base_currency_check'
  ) THEN
    ALTER TABLE public.exchange_rates
      ADD CONSTRAINT exchange_rates_base_currency_check
      CHECK (base_currency IN ('USD', 'ARS'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'exchange_rates_target_currency_check'
  ) THEN
    ALTER TABLE public.exchange_rates
      ADD CONSTRAINT exchange_rates_target_currency_check
      CHECK (target_currency IN ('USD', 'ARS'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'business_settings_default_currency_check'
  ) THEN
    ALTER TABLE public.business_settings
      ADD CONSTRAINT business_settings_default_currency_check
      CHECK (default_currency IN ('USD', 'ARS'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'business_settings_rate_update_frequency_positive_check'
  ) THEN
    ALTER TABLE public.business_settings
      ADD CONSTRAINT business_settings_rate_update_frequency_positive_check
      CHECK (rate_update_frequency_hours > 0);
  END IF;
END
$$;

-- ---------------------------------------------------------
-- 4) INVENTORY: AGREGAR PRECIO USD Y MONEDA
-- ---------------------------------------------------------
ALTER TABLE public.inventory
  ADD COLUMN IF NOT EXISTS price_usd NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'ARS';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'inventory_currency_check'
  ) THEN
    ALTER TABLE public.inventory
      ADD CONSTRAINT inventory_currency_check
      CHECK (currency IN ('USD', 'ARS'));
  END IF;
END
$$;

-- ---------------------------------------------------------
-- 5) TRIGGERS updated_at
-- Requiere que exista public.update_updated_at_column()
-- ---------------------------------------------------------
DROP TRIGGER IF EXISTS update_exchange_rates_updated_at ON public.exchange_rates;
CREATE TRIGGER update_exchange_rates_updated_at
  BEFORE UPDATE ON public.exchange_rates
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_business_settings_updated_at ON public.business_settings;
CREATE TRIGGER update_business_settings_updated_at
  BEFORE UPDATE ON public.business_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------
-- 6) RLS
-- ---------------------------------------------------------
ALTER TABLE public.exchange_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_settings ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------
-- 7) POLÍTICAS RLS: exchange_rates
-- ---------------------------------------------------------
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

-- ---------------------------------------------------------
-- 8) POLÍTICAS RLS: business_settings
-- ---------------------------------------------------------
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

-- ---------------------------------------------------------
-- 9) FUNCIÓN: OBTENER TIPO DE CAMBIO ACTUAL
-- Más segura: sólo permite consultar el business actual
-- ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_current_exchange_rate(
  p_base_currency TEXT DEFAULT 'USD',
  p_target_currency TEXT DEFAULT 'ARS'
)
RETURNS NUMERIC(12,4)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT rate
  FROM public.exchange_rates
  WHERE business_id = public.current_user_business_id()
    AND base_currency = p_base_currency
    AND target_currency = p_target_currency
  ORDER BY updated_at DESC
  LIMIT 1;
$$;

-- ---------------------------------------------------------
-- 10) FUNCIÓN: OBTENER CONFIGURACIÓN DEL NEGOCIO ACTUAL
-- ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_business_settings()
RETURNS TABLE (
  default_currency TEXT,
  show_usd_price BOOLEAN,
  auto_update_rate BOOLEAN,
  rate_api_url TEXT,
  rate_update_frequency_hours INT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT
    bs.default_currency,
    bs.show_usd_price,
    bs.auto_update_rate,
    bs.rate_api_url,
    bs.rate_update_frequency_hours
  FROM public.business_settings bs
  WHERE bs.business_id = public.current_user_business_id();
$$;

-- ---------------------------------------------------------
-- 11) PERMISOS
-- ---------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.get_current_exchange_rate(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_business_settings() TO authenticated;

-- ---------------------------------------------------------
-- 12) DATOS INICIALES OPCIONALES
-- Crea settings por negocio si no existen
-- ---------------------------------------------------------
INSERT INTO public.business_settings (
  business_id,
  default_currency,
  show_usd_price,
  auto_update_rate
)
SELECT
  b.id,
  'ARS',
  FALSE,
  FALSE
FROM public.businesses b
WHERE NOT EXISTS (
  SELECT 1
  FROM public.business_settings bs
  WHERE bs.business_id = b.id
);
