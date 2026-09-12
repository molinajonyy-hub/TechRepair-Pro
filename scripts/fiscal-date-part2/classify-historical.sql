-- ============================================================================
-- FISCAL DATE Parte 2 — CLASIFICADOR HISTÓRICO (SÓLO LECTURA)
--
-- Un SELECT. Ni un INSERT, ni un UPDATE, ni DDL. Clasifica cada comprobante
-- AUTORIZADO (cae IS NOT NULL) según si su CbteFch real —la fecha fiscal que
-- ARCA aceptó— se puede probar con lo que hay guardado, sin preguntarle a ARCA.
--
-- POR QUÉ «UTC = AR» ALCANZA COMO PRUEBA
-- Antes de la Parte 1 el CbteFch salía de una fecha calculada en UTC: el
-- navegador mandaba `new Date().toISOString().slice(0,10)` y el Edge, si no
-- venía nada, usaba su propio `todayYYYYMMDD()`, también UTC. Desde la Parte 1
-- lo decide el día civil argentino. Entonces, para un instante de envío dado
-- hay tres fórmulas candidatas, y CUANDO EL DÍA UTC Y EL DÍA CIVIL ARGENTINO
-- COINCIDEN, las tres dan el MISMO valor. Ahí el CbteFch queda determinado sin
-- necesidad de saber qué build estaba desplegado: por eso es PROVABLE_LOCAL.
-- Cuando difieren (envío entre 21:00 y 23:59 ART), el valor depende de la
-- versión desplegada y hay que ir a ARCA.
--
-- CLASES
--   PROVABLE_LOCAL       hay sent_at y día UTC = día civil AR -> CbteFch probado.
--   REQUIRES_ARCA_LOOKUP no hay sent_at (histórico previo al ciclo de intentos),
--                        o día UTC <> día civil AR. Sólo FECompConsultar lo dice.
--   INCONSISTENT         el estado fiscal no se puede clasificar con seguridad:
--                        sin intento autorizado habiendo intentos, más de uno,
--                        o falta la clave de consulta (PV/Nro/tipo).
--
-- La clave de consulta se arma con `numero_fiscal`, NO con la columna
-- `punto_venta`: esa columna todavía tiene su default '0001' en parte del
-- histórico mientras el número fiscal dice '0010-…'. Manda numero_fiscal.
-- Y el CbteTipo se deriva de `tipo` cuando `tipo_comprobante_fiscal` es NULL
-- (46 de 50 en producción al 2026-09-12): sin CbteTipo, `numero_fiscal` es
-- ambiguo — hay un 0010-00000001 factura y otro nota de crédito.
-- ============================================================================
WITH att AS (
  SELECT a.comprobante_id,
         count(*)                                                                   AS intentos,
         count(*) FILTER (WHERE a.status IN ('authorized','authorized_reconciled')) AS intentos_ok,
         max(a.sent_at)                                                             AS ultimo_sent
    FROM arca_emission_attempts a
   GROUP BY a.comprobante_id
), base AS (
  SELECT
    c.id,
    c.business_id,
    c.numero_fiscal,
    c.fecha                                     AS fecha_venta,
    c.fecha_emision_fiscal,
    att.intentos,
    att.intentos_ok,
    att.ultimo_sent,
    -- Clave de consulta a ARCA, derivada localmente
    nullif(split_part(c.numero_fiscal, '-', 1), '')::int AS pv_fiscal,
    nullif(split_part(c.numero_fiscal, '-', 2), '')::int AS nro_fiscal,
    COALESCE(
      nullif(c.tipo_comprobante_fiscal, '')::int,
      CASE c.tipo
        WHEN 'factura_c'    THEN 11
        WHEN 'nota_credito' THEN 13
        WHEN 'factura_a'    THEN 1
      END
    ) AS cbte_tipo,
    (att.ultimo_sent AT TIME ZONE 'UTC')::date                                AS dia_utc,
    (att.ultimo_sent AT TIME ZONE 'America/Argentina/Buenos_Aires')::date     AS dia_ar
  FROM comprobantes c
  LEFT JOIN att ON att.comprobante_id = c.id
  WHERE c.cae IS NOT NULL
)
SELECT
  id::text,
  business_id::text,
  numero_fiscal,
  pv_fiscal,
  cbte_tipo,
  nro_fiscal,
  CASE
    WHEN pv_fiscal IS NULL OR nro_fiscal IS NULL OR cbte_tipo IS NULL THEN 'INCONSISTENT'
    WHEN intentos IS NOT NULL AND intentos_ok <> 1                    THEN 'INCONSISTENT'
    WHEN ultimo_sent IS NULL                                          THEN 'REQUIRES_ARCA_LOOKUP'
    WHEN dia_utc <> dia_ar                                            THEN 'REQUIRES_ARCA_LOOKUP'
    ELSE 'PROVABLE_LOCAL'
  END AS clase,
  CASE
    WHEN pv_fiscal IS NULL OR nro_fiscal IS NULL OR cbte_tipo IS NULL THEN 'clave de consulta incompleta'
    WHEN intentos IS NOT NULL AND intentos_ok = 0                     THEN 'CAE sin intento autorizado'
    WHEN intentos IS NOT NULL AND intentos_ok > 1                     THEN 'más de un intento autorizado'
    WHEN ultimo_sent IS NULL                                          THEN 'sin sent_at: no hay instante de envío guardado'
    WHEN dia_utc <> dia_ar                                            THEN 'envío en la ventana 21:00-23:59 ART: UTC y AR difieren'
    ELSE 'día UTC = día civil AR: toda fórmula candidata da el mismo CbteFch'
  END AS motivo,
  -- Sólo tiene valor cuando la clase es PROVABLE_LOCAL.
  CASE WHEN ultimo_sent IS NOT NULL AND dia_utc = dia_ar
       THEN to_char(dia_ar, 'YYYYMMDD') END AS cbte_fch_probado,
  to_char(ultimo_sent AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SSZ') AS sent_at_utc,
  to_char(dia_utc, 'YYYYMMDD')      AS dia_utc,
  to_char(dia_ar, 'YYYYMMDD')       AS dia_ar,
  to_char(fecha_venta AT TIME ZONE 'America/Argentina/Buenos_Aires', 'YYYYMMDD') AS dia_venta_ar,
  intentos,
  intentos_ok
FROM base
ORDER BY business_id, pv_fiscal, cbte_tipo, nro_fiscal;
