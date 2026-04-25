-- ================================================================
-- FIX: generar_numero_comprobante — eliminar overloads ambiguos
-- Error: "Could not choose the best candidate function between..."
-- Causa: dos versiones con los mismos 3 params en distinto orden
-- Solución: DROP de todas las variantes + recrear una sola canónica
-- ================================================================

-- 1) Eliminar TODAS las variantes existentes (por tipo de args)
DROP FUNCTION IF EXISTS public.generar_numero_comprobante(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.generar_numero_comprobante(TEXT, UUID, TEXT);
DROP FUNCTION IF EXISTS public.generar_numero_comprobante(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.generar_numero_comprobante(TEXT, UUID);
DROP FUNCTION IF EXISTS generar_numero_comprobante(TEXT, TEXT);

-- 2) Recrear UNA SOLA versión canónica
--    Firma: (p_tipo TEXT, p_business_id UUID, p_punto_venta TEXT)
--    Coincide exactamente con la llamada del servicio TS:
--      supabase.rpc('generar_numero_comprobante', { p_tipo, p_business_id, p_punto_venta })
CREATE OR REPLACE FUNCTION public.generar_numero_comprobante(
  p_tipo        TEXT,
  p_business_id UUID    DEFAULT NULL,
  p_punto_venta TEXT    DEFAULT '0001'
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ultimo_numero BIGINT;
  nuevo_numero  TEXT;
  v_biz_id      UUID;
BEGIN
  v_biz_id := COALESCE(p_business_id, public.current_user_business_id());

  SELECT COALESCE(
    MAX(
      CASE
        WHEN COALESCE(number, numero) ~ '^[0-9]+$'
          THEN CAST(COALESCE(number, numero) AS BIGINT)
        WHEN COALESCE(number, numero) ~ '^[0-9]{4}-[0-9]{8}$'
          THEN CAST(SPLIT_PART(COALESCE(number, numero), '-', 2) AS BIGINT)
        ELSE 0
      END
    ), 0)
  INTO ultimo_numero
  FROM public.comprobantes
  WHERE business_id = v_biz_id
    AND COALESCE(type, tipo) = p_tipo;

  ultimo_numero := ultimo_numero + 1;

  IF p_punto_venta IS NULL OR TRIM(p_punto_venta) = '' THEN
    nuevo_numero := LPAD(ultimo_numero::TEXT, 8, '0');
  ELSE
    nuevo_numero := LPAD(p_punto_venta, 4, '0') || '-' || LPAD(ultimo_numero::TEXT, 8, '0');
  END IF;

  RETURN nuevo_numero;
END;
$$;

GRANT EXECUTE ON FUNCTION public.generar_numero_comprobante(TEXT, UUID, TEXT) TO authenticated;
