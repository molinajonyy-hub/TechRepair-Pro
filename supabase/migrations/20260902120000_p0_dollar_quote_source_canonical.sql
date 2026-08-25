-- ============================================================================
-- P0-DÓLAR — Contrato canónico de la fuente de cotización.
--
-- CAUSA RAÍZ
-- ----------
-- `business_settings.dolar_source` existe, tiene CHECK ('nacional','cordoba') y
-- default 'nacional', pero NINGUNA de las dos RPC que el frontend usa para
-- leerla y escribirla la incluía:
--
--   · get_business_settings()    → RETURNS TABLE sin `dolar_source`
--   · upsert_business_settings() → no recibía ni escribía `dolar_source`
--
-- Consecuencias medidas:
--   1. La pantalla de Configuración de Moneda siempre renderizaba
--      "Blue Nacional" como seleccionada, sin importar lo persistido.
--   2. Cada guardado mandaba `dolar_source: undefined ?? 'nacional'` por el
--      upsert directo a la tabla → PISABA en silencio un 'cordoba' guardado.
--   3. `useAutoExchangeRate` leía la misma RPC → la actualización automática
--      consultaba SIEMPRE Bluelytics, ignorando la fuente configurada.
--
-- Esta migración hace de `dolar_source` un ciudadano de primera en ambas RPC y
-- cierra el bypass de RBAC que permitía escribir la configuración salteando el
-- gate owner/admin.
--
-- Forward-only. Aditiva sobre datos: NO toca ninguna fila.
-- Medición previa en producción (read-only): 10 filas de business_settings,
-- 9 'nacional' / 1 'cordoba', 0 NULL, 0 valores fuera del CHECK.
-- No hay aliases legacy en esta columna → no hay reparación histórica que hacer.
-- ============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Lectura canónica — get_business_settings() ahora devuelve dolar_source.
--
-- Cambia el tipo de retorno (RETURNS TABLE), así que CREATE OR REPLACE no
-- alcanza: hay que DROP + CREATE. Verificado que ninguna otra función la
-- referencia.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.get_business_settings();

CREATE FUNCTION public.get_business_settings()
RETURNS TABLE (
  id                          uuid,
  business_id                 uuid,
  default_currency            text,
  show_usd_price              boolean,
  auto_update_rate            boolean,
  rate_api_url                text,
  rate_update_frequency_hours integer,
  dolar_source                text,
  updated_at                  timestamptz,
  created_at                  timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    bs.id,
    bs.business_id,
    bs.default_currency,
    bs.show_usd_price,
    bs.auto_update_rate,
    bs.rate_api_url,
    bs.rate_update_frequency_hours,
    -- Normalización defensiva en el borde de lectura: lo desconocido cae en el
    -- default de la columna, nunca en la otra fuente.
    CASE
      WHEN bs.dolar_source IN ('nacional', 'cordoba') THEN bs.dolar_source::text
      ELSE 'nacional'
    END AS dolar_source,
    bs.updated_at,
    bs.created_at
  FROM public.business_settings bs
  WHERE bs.business_id = public.current_user_business_id();
$$;

REVOKE ALL ON FUNCTION public.get_business_settings() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_business_settings() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_business_settings() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Escritura canónica — upsert_business_settings() acepta dolar_source.
--
-- `p_dolar_source` es NULL-able con semántica "no cambiar". Ése es el seguro
-- anti-pisada: un cliente que no manda la fuente NO puede resetearla.
-- El valor se valida contra una allowlist cerrada (§ SSRF / fuentes arbitrarias).
--
-- La firma cambia, así que se dropea la anterior explícitamente para no dejar
-- un overload ambiguo vivo.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.upsert_business_settings(uuid, text, boolean, boolean, text, integer);

CREATE FUNCTION public.upsert_business_settings(
  p_business_id                 uuid,
  p_default_currency            text    DEFAULT 'ARS',
  p_show_usd_price              boolean DEFAULT false,
  p_auto_update_rate            boolean DEFAULT false,
  p_rate_api_url                text    DEFAULT NULL,
  p_rate_update_frequency_hours integer DEFAULT 24,
  p_dolar_source                text    DEFAULT NULL
)
RETURNS TABLE (
  id                          uuid,
  business_id                 uuid,
  default_currency            text,
  show_usd_price              boolean,
  auto_update_rate            boolean,
  rate_api_url                text,
  rate_update_frequency_hours integer,
  dolar_source                text,
  updated_at                  timestamptz,
  created_at                  timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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

  -- Allowlist cerrada. El cliente no elige proveedor ni URL: elige una fuente
  -- de un catálogo fijo. NULL = "dejar la que ya estaba".
  IF p_dolar_source IS NOT NULL AND p_dolar_source NOT IN ('nacional', 'cordoba') THEN
    RAISE EXCEPTION 'Fuente de cotizacion no soportada: %', p_dolar_source;
  END IF;

  -- Misma allowlist que business_settings_default_currency_check, para que el
  -- error salga con un mensaje legible en lugar de un 23514 crudo.
  IF p_default_currency IS NULL OR p_default_currency NOT IN ('ARS', 'USD') THEN
    RAISE EXCEPTION 'Moneda no soportada: %', COALESCE(p_default_currency, 'NULL');
  END IF;

  RETURN QUERY
  UPDATE public.business_settings AS bs
  SET default_currency            = p_default_currency,
      show_usd_price              = p_show_usd_price,
      auto_update_rate            = p_auto_update_rate,
      rate_api_url                = p_rate_api_url,
      rate_update_frequency_hours = p_rate_update_frequency_hours,
      dolar_source                = COALESCE(p_dolar_source, bs.dolar_source),
      updated_at                  = NOW()
  WHERE bs.business_id = p_business_id
  RETURNING
    bs.id,
    bs.business_id,
    bs.default_currency,
    bs.show_usd_price,
    bs.auto_update_rate,
    bs.rate_api_url,
    bs.rate_update_frequency_hours,
    bs.dolar_source::text,
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
    rate_update_frequency_hours,
    dolar_source
  )
  VALUES (
    p_business_id,
    p_default_currency,
    p_show_usd_price,
    p_auto_update_rate,
    p_rate_api_url,
    p_rate_update_frequency_hours,
    COALESCE(p_dolar_source, 'nacional')
  )
  RETURNING
    bs.id,
    bs.business_id,
    bs.default_currency,
    bs.show_usd_price,
    bs.auto_update_rate,
    bs.rate_api_url,
    bs.rate_update_frequency_hours,
    bs.dolar_source::text,
    bs.updated_at,
    bs.created_at;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_business_settings(uuid, text, boolean, boolean, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_business_settings(uuid, text, boolean, boolean, text, integer, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.upsert_business_settings(uuid, text, boolean, boolean, text, integer, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Cierre del bypass de RBAC.
--
-- `business_settings_insert` / `business_settings_update` exigen owner|admin,
-- pero convivían con dos policies PERMISSIVE heredadas que sólo exigían
-- pertenencia al negocio. Dos PERMISSIVE se OR-ean: cualquier miembro (tech,
-- sales, cashier, viewer) podía cambiar la configuración de cotización
-- escribiendo directo a la tabla, aunque el frontend le escondiera el botón.
--
-- Se retiran las heredadas. Las canónicas con gate de rol quedan como única
-- autoridad de escritura.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users can insert business settings for their business" ON public.business_settings;
DROP POLICY IF EXISTS "Users can update business settings for their business" ON public.business_settings;

-- La policy heredada de SELECT es equivalente a business_settings_select
-- (ambas: pertenencia al negocio) y la lectura no está restringida por rol.
-- Se retira igual para dejar una sola autoridad de lectura.
DROP POLICY IF EXISTS "Users can view business settings for their business" ON public.business_settings;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Postcondiciones — fallan la migración si el contrato no quedó como se dice.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_read_cols  text;
  v_write_args text;
  v_legacy     int;
BEGIN
  SELECT pg_get_function_result(p.oid) INTO v_read_cols
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_business_settings';

  IF v_read_cols IS NULL OR v_read_cols NOT ILIKE '%dolar_source%' THEN
    RAISE EXCEPTION 'POSTCONDICION: get_business_settings() no expone dolar_source';
  END IF;

  SELECT pg_get_function_identity_arguments(p.oid) INTO v_write_args
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'upsert_business_settings';

  IF v_write_args IS NULL OR v_write_args NOT ILIKE '%p_dolar_source%' THEN
    RAISE EXCEPTION 'POSTCONDICION: upsert_business_settings() no acepta p_dolar_source';
  END IF;

  SELECT count(*) INTO v_legacy
  FROM pg_policy
  WHERE polrelid = 'public.business_settings'::regclass
    AND polname LIKE 'Users can %business settings%';

  IF v_legacy <> 0 THEN
    RAISE EXCEPTION 'POSTCONDICION: quedaron % policies heredadas en business_settings', v_legacy;
  END IF;
END $$;

COMMIT;
