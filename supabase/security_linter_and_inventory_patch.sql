-- =========================================================
-- SECURITY LINTER + INVENTORY PATCH
-- Ejecutar en Supabase SQL Editor.
-- =========================================================

-- 1) Fix del PATCH 400 en inventory:
-- La pantalla de inventario envia estos campos de multimodeda.
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
  auto_update_price = COALESCE(auto_update_price, FALSE);

-- 2) Fix Supabase linter: function_search_path_mutable.
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.generar_numero_comprobante(
  p_tipo TEXT,
  p_punto_venta TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_numero INTEGER;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(c.numero FROM 9) AS INTEGER)), 0) + 1
  INTO v_numero
  FROM public.comprobantes c
  WHERE c.tipo = p_tipo
    AND c.punto_venta = p_punto_venta
    AND c.numero IS NOT NULL;

  RETURN p_punto_venta || '-' || LPAD(v_numero::TEXT, 8, '0');
END;
$$;

-- 3) Fix Supabase linter: businesses_insert no debe ser WITH CHECK (true).
DROP POLICY IF EXISTS businesses_insert ON public.businesses;

CREATE POLICY businesses_insert
  ON public.businesses
  FOR INSERT
  TO authenticated
  WITH CHECK (
    owner_user_id = auth.uid()
  );

-- 4) Fix Supabase linter: public.users no debe tener INSERT/UPDATE/DELETE con true.
-- La app vieja usa public.users para tecnicos; dejamos escritura solo para owner/admin.
DROP POLICY IF EXISTS users_insert ON public.users;
DROP POLICY IF EXISTS users_update ON public.users;
DROP POLICY IF EXISTS users_delete ON public.users;

CREATE POLICY users_insert
  ON public.users
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.current_user_role() IN ('owner', 'admin')
  );

CREATE POLICY users_update
  ON public.users
  FOR UPDATE
  TO authenticated
  USING (
    public.current_user_role() IN ('owner', 'admin')
  )
  WITH CHECK (
    public.current_user_role() IN ('owner', 'admin')
  );

CREATE POLICY users_delete
  ON public.users
  FOR DELETE
  TO authenticated
  USING (
    public.current_user_role() IN ('owner', 'admin')
  );

-- 5) Verificacion rapida.
SELECT
  column_name,
  data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'inventory'
  AND column_name IN (
    'base_currency',
    'base_price',
    'cost_price_usd',
    'exchange_rate_used',
    'auto_update_price'
  )
ORDER BY column_name;
