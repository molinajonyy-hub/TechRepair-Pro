-- =========================================================
-- MIGRACION: SOPORTE MULTIMONEDA EN PRODUCTOS (INVENTORY)
-- =========================================================

ALTER TABLE public.inventory
  ADD COLUMN IF NOT EXISTS base_currency TEXT NOT NULL DEFAULT 'ARS',
  ADD COLUMN IF NOT EXISTS base_price NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS cost_price_usd NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS exchange_rate_used NUMERIC(12,4),
  ADD COLUMN IF NOT EXISTS auto_update_price BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'inventory_base_currency_check'
  ) THEN
    ALTER TABLE public.inventory
      ADD CONSTRAINT inventory_base_currency_check
      CHECK (base_currency IN ('USD', 'ARS'));
  END IF;
END
$$;

UPDATE public.inventory
SET
  base_currency = COALESCE(base_currency, 'ARS'),
  base_price = COALESCE(base_price, sale_price),
  cost_price_usd = COALESCE(cost_price_usd, 0),
  exchange_rate_used = COALESCE(exchange_rate_used, 1),
  auto_update_price = COALESCE(auto_update_price, FALSE)
WHERE base_price IS NULL
   OR exchange_rate_used IS NULL;

CREATE INDEX IF NOT EXISTS inventory_base_currency_idx
  ON public.inventory(base_currency);

CREATE INDEX IF NOT EXISTS inventory_auto_update_price_idx
  ON public.inventory(auto_update_price)
  WHERE auto_update_price = TRUE;

CREATE OR REPLACE FUNCTION public.recalculate_product_prices(
  p_business_id UUID,
  p_new_rate NUMERIC
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count INT;
BEGIN
  UPDATE public.inventory
  SET
    sale_price = ROUND(base_price * p_new_rate, 2),
    cost_price = CASE
      WHEN cost_price_usd IS NOT NULL AND cost_price_usd > 0
        THEN ROUND(cost_price_usd * p_new_rate, 2)
      ELSE cost_price
    END,
    exchange_rate_used = p_new_rate,
    updated_at = NOW()
  WHERE business_id = p_business_id
    AND base_currency = 'USD'
    AND auto_update_price = TRUE
    AND base_price IS NOT NULL;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.recalculate_product_prices(UUID, NUMERIC) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_exchange_rate_on_product_save()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.base_currency = 'USD' AND (NEW.exchange_rate_used IS NULL OR NEW.exchange_rate_used = 0) THEN
    SELECT rate
    INTO NEW.exchange_rate_used
    FROM public.exchange_rates
    WHERE business_id = NEW.business_id
      AND base_currency = 'USD'
      AND target_currency = 'ARS'
    ORDER BY updated_at DESC
    LIMIT 1;

    IF NEW.exchange_rate_used IS NULL OR NEW.exchange_rate_used = 0 THEN
      NEW.exchange_rate_used := 1;
    END IF;
  END IF;

  IF NEW.base_currency = 'USD'
    AND NEW.base_price IS NOT NULL
    AND NEW.exchange_rate_used IS NOT NULL THEN
    NEW.sale_price := ROUND(NEW.base_price * NEW.exchange_rate_used, 2);
  END IF;

  IF NEW.base_currency = 'USD'
    AND NEW.cost_price_usd IS NOT NULL
    AND NEW.cost_price_usd > 0
    AND NEW.exchange_rate_used IS NOT NULL THEN
    NEW.cost_price := ROUND(NEW.cost_price_usd * NEW.exchange_rate_used, 2);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_exchange_rate_on_product_save_trigger ON public.inventory;
CREATE TRIGGER set_exchange_rate_on_product_save_trigger
  BEFORE INSERT OR UPDATE ON public.inventory
  FOR EACH ROW
  EXECUTE FUNCTION public.set_exchange_rate_on_product_save();
