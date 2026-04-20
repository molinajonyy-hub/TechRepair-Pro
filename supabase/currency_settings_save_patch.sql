-- =========================================================
-- CURRENCY SETTINGS SAVE PATCH
-- Corrige 403 Forbidden al guardar business_settings/exchange_rates.
-- =========================================================

DROP FUNCTION IF EXISTS public.get_business_settings();
DROP FUNCTION IF EXISTS public.upsert_business_settings(UUID, TEXT, BOOLEAN, BOOLEAN, TEXT, INT);
DROP FUNCTION IF EXISTS public.upsert_exchange_rate(UUID, TEXT, TEXT, NUMERIC, BOOLEAN, TEXT);

CREATE OR REPLACE FUNCTION public.get_business_settings()
RETURNS TABLE (
  id UUID,
  business_id UUID,
  default_currency TEXT,
  show_usd_price BOOLEAN,
  auto_update_rate BOOLEAN,
  rate_api_url TEXT,
  rate_update_frequency_hours INT,
  updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT
    bs.id,
    bs.business_id,
    bs.default_currency,
    bs.show_usd_price,
    bs.auto_update_rate,
    bs.rate_api_url,
    bs.rate_update_frequency_hours,
    bs.updated_at,
    bs.created_at
  FROM public.business_settings bs
  WHERE bs.business_id = public.current_user_business_id();
$$;

CREATE OR REPLACE FUNCTION public.upsert_business_settings(
  p_business_id UUID,
  p_default_currency TEXT DEFAULT 'ARS',
  p_show_usd_price BOOLEAN DEFAULT FALSE,
  p_auto_update_rate BOOLEAN DEFAULT FALSE,
  p_rate_api_url TEXT DEFAULT NULL,
  p_rate_update_frequency_hours INT DEFAULT 24
)
RETURNS TABLE (
  id UUID,
  business_id UUID,
  default_currency TEXT,
  show_usd_price BOOLEAN,
  auto_update_rate BOOLEAN,
  rate_api_url TEXT,
  rate_update_frequency_hours INT,
  updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id UUID;
BEGIN
  v_business_id := public.current_user_business_id();

  IF v_business_id IS NULL OR v_business_id <> p_business_id THEN
    RAISE EXCEPTION 'No tenes acceso a este negocio';
  END IF;

  IF public.current_user_role() NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'No tenes permisos para guardar configuracion de moneda';
  END IF;

  RETURN QUERY
  UPDATE public.business_settings AS bs
  SET default_currency = p_default_currency,
      show_usd_price = p_show_usd_price,
      auto_update_rate = p_auto_update_rate,
      rate_api_url = p_rate_api_url,
      rate_update_frequency_hours = p_rate_update_frequency_hours,
      updated_at = NOW()
  WHERE bs.business_id = p_business_id
  RETURNING
    bs.id,
    bs.business_id,
    bs.default_currency,
    bs.show_usd_price,
    bs.auto_update_rate,
    bs.rate_api_url,
    bs.rate_update_frequency_hours,
    bs.updated_at,
    bs.created_at;

  IF FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY
  INSERT INTO public.business_settings AS bs (
    business_id,
    default_currency,
    show_usd_price,
    auto_update_rate,
    rate_api_url,
    rate_update_frequency_hours
  )
  VALUES (
    p_business_id,
    p_default_currency,
    p_show_usd_price,
    p_auto_update_rate,
    p_rate_api_url,
    p_rate_update_frequency_hours
  )
  RETURNING
    bs.id,
    bs.business_id,
    bs.default_currency,
    bs.show_usd_price,
    bs.auto_update_rate,
    bs.rate_api_url,
    bs.rate_update_frequency_hours,
    bs.updated_at,
    bs.created_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_exchange_rate(
  p_business_id UUID,
  p_base_currency TEXT DEFAULT 'USD',
  p_target_currency TEXT DEFAULT 'ARS',
  p_rate NUMERIC DEFAULT 1,
  p_is_manual BOOLEAN DEFAULT TRUE,
  p_source TEXT DEFAULT 'manual'
)
RETURNS TABLE (
  id UUID,
  business_id UUID,
  base_currency TEXT,
  target_currency TEXT,
  rate NUMERIC,
  is_manual BOOLEAN,
  source TEXT,
  updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id UUID;
BEGIN
  v_business_id := public.current_user_business_id();

  IF v_business_id IS NULL OR v_business_id <> p_business_id THEN
    RAISE EXCEPTION 'No tenes acceso a este negocio';
  END IF;

  IF public.current_user_role() NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'No tenes permisos para guardar tipo de cambio';
  END IF;

  IF p_rate <= 0 THEN
    RAISE EXCEPTION 'El tipo de cambio debe ser mayor a 0';
  END IF;

  RETURN QUERY
  INSERT INTO public.exchange_rates AS er (
    business_id,
    base_currency,
    target_currency,
    rate,
    is_manual,
    source
  )
  VALUES (
    p_business_id,
    p_base_currency,
    p_target_currency,
    p_rate,
    p_is_manual,
    p_source
  )
  RETURNING
    er.id,
    er.business_id,
    er.base_currency,
    er.target_currency,
    er.rate,
    er.is_manual,
    er.source,
    er.updated_at,
    er.created_at;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_business_settings() TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_business_settings(UUID, TEXT, BOOLEAN, BOOLEAN, TEXT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_exchange_rate(UUID, TEXT, TEXT, NUMERIC, BOOLEAN, TEXT) TO authenticated;
