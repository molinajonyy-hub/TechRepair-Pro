-- ============================================================================
-- P0 PV FISCAL — MEDICIÓN READ-ONLY de la divergencia histórica.
--
-- Sólo SELECTs. No modifica ni una fila: sirve para dimensionar el backfill
-- ANTES de decidir si hace falta, tanto en local como en producción.
--
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -f - < docs/auditoria-fiscal/pv-divergencia-medicion.sql
--
-- Qué mide:
--   1. Universo: cuántos comprobantes hay por estado fiscal.
--   2. DIVERGENCIA REAL: emitidos donde el PV local != el PV que autorizó AFIP.
--      Son los que la impresión vieja mostraba mal. Con el fix de presentación
--      ya se ven bien SIN tocar datos.
--   3. Número local != número fiscal (esperable: numeraciones distintas).
--   4. CAE sin numero_fiscal — invariante roto; sería el único caso donde el
--      fallback de CbtesAsoc podía dispararse.
--   5. Fiscales sin emitir agrupados por PV local: lo que el contrato nuevo
--      deja de producir hacia adelante.
-- ============================================================================

SELECT '1. universo' AS medicion,
       es_fiscal::text AS es_fiscal,
       (cae IS NOT NULL)::text AS con_cae,
       (numero_fiscal IS NOT NULL)::text AS con_numero_fiscal,
       count(*)::text AS cantidad
FROM public.comprobantes
GROUP BY 1,2,3,4
ORDER BY 2,3,4;

SELECT '2. PV local != PV fiscal (emitidos)' AS medicion,
       count(*)::text AS cantidad
FROM public.comprobantes
WHERE numero_fiscal IS NOT NULL
  AND lpad(split_part(numero_fiscal, '-', 1), 4, '0')
      IS DISTINCT FROM lpad(COALESCE(punto_venta, ''), 4, '0');

SELECT '3. numero local != numero fiscal (emitidos)' AS medicion,
       count(*)::text AS cantidad
FROM public.comprobantes
WHERE numero_fiscal IS NOT NULL
  AND numero IS DISTINCT FROM numero_fiscal;

SELECT '4. CAE sin numero_fiscal (invariante roto)' AS medicion,
       count(*)::text AS cantidad
FROM public.comprobantes
WHERE cae IS NOT NULL AND numero_fiscal IS NULL;

SELECT '5. fiscales sin emitir por PV local' AS medicion,
       COALESCE(punto_venta, '(null)') AS punto_venta,
       count(*)::text AS cantidad
FROM public.comprobantes
WHERE tipo IN ('factura_a', 'factura_c', 'nota_credito')
  AND numero_fiscal IS NULL
GROUP BY 1,2
ORDER BY 3 DESC;
