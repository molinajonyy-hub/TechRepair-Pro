-- ============================================================================
-- FISCAL DATE Parte 2 — CLASIFICADOR HISTÓRICO (SÓLO LECTURA)
--
-- Un SELECT. Ni un INSERT, ni un UPDATE, ni DDL. Clasifica cada comprobante
-- AUTORIZADO (cae IS NOT NULL) según si su CbteFch real —la fecha fiscal que
-- ARCA aceptó— se puede PROBAR con lo persistido, sin preguntarle a ARCA.
--
-- ── EL INVARIANTE ───────────────────────────────────────────────────────────
-- PROVABLE_LOCAL significa: TODO algoritmo que realmente pudo haber producido
-- el CbteFch, sobre TODO instante que la evidencia persistida permite, da el
-- MISMO YYYYMMDD. Cualquier cosa más débil es REQUIRES_ARCA_LOOKUP.
--
-- ── POR QUÉ NO ALCANZA sent_at ──────────────────────────────────────────────
-- El orden real en afip-cae es:
--     markAttemptSent(...)  ->  resolveCbteFch(...)  ->  FECAESolicitar
-- así que `sent_at` es una COTA INFERIOR del cálculo de la fecha, no el
-- cálculo. La ventana del cálculo server-side es [sent_at, completed_at].
-- Usar `date(sent_at)` como autoridad sería asumir que el cálculo pasó en el
-- mismo instante en que se marcó el envío.
--
-- Tampoco se usa MAX(sent_at) sobre TODOS los intentos: un comprobante puede
-- tener un intento autorizado y otros no autorizados, y el máximo puede
-- pertenecer a un intento que no fue el que obtuvo el CAE. La evidencia se ata
-- al ÚNICO intento con status authorized/authorized_reconciled.
--
-- ── LOS TRES ALGORITMOS CANDIDATOS ──────────────────────────────────────────
--   A. servidor, Parte 1 en adelante : día civil argentino del instante del
--      cálculo (resolveCbteFch). Aplica sólo si el afip-cae desplegado ya era
--      v23; ignora por completo el fecha_cbte del navegador.
--   B. servidor, previo a la Parte 1  : día UTC del instante del cálculo
--      (todayYYYYMMDD()), usado cuando el navegador no mandaba fecha.
--   C. navegador, previo a la Parte 1 : día UTC del instante en que el NAVEGADOR
--      calculó la fecha, que viajaba en el body (`fecha_cbte || today...`).
--
-- El problema decisivo es C: el navegador calculó ANTES de que el request
-- llegara al Edge, así que su instante sólo tiene cota SUPERIOR (started_at) y
-- NINGUNA cota inferior en la evidencia. No se asume latencia ("habrán sido
-- segundos"): sin cota inferior, C puede caer en cualquier día UTC anterior.
--
-- Y no se puede descartar C fila por fila: `request_data` y `response_data`
-- están NULL en los 178 autorizados de producción (verificado 2026-09-12), o
-- sea que no hay registro de si el body traía `fecha_cbte`.
--
-- CONSECUENCIA: una fila previa al corte de la Parte 1 NO es probable
-- localmente. Va a REQUIRES_ARCA_LOOKUP, y la resuelve un FECompConsultar de
-- sólo lectura. Preferimos 177 consultas a inventar una certeza.
--
-- ── CLASES ──────────────────────────────────────────────────────────────────
--   PROVABLE_LOCAL       ventana de cálculo íntegramente posterior al corte de
--                        la Parte 1 (sólo aplica A) Y el día civil argentino es
--                        constante en toda la ventana.
--   REQUIRES_ARCA_LOOKUP sin intento (sin cota alguna), previa al corte (C sin
--                        cota inferior), o la ventana cruza un límite de día.
--   INCONSISTENT         el estado fiscal no se puede clasificar con seguridad:
--                        más de un intento autorizado, intentos existentes pero
--                        ninguno autorizado, falta sent_at/completed_at del
--                        autorizado, o clave de consulta incompleta.
--
-- La clave de consulta sale de `numero_fiscal`, NO de la columna `punto_venta`
-- (parte del histórico conserva su default '0001' mientras el número fiscal
-- dice '0010-…'), y el CbteTipo de `tipo` cuando `tipo_comprobante_fiscal` es
-- NULL. Sin CbteTipo `numero_fiscal` es AMBIGUO: hay un 0010-00000001 factura
-- y otro nota de crédito.
-- ============================================================================
WITH params AS (
  -- Despliegue de afip-cae v23 (Parte 1, fecha fiscal server-authoritative).
  -- Medido en el proyecto: functions.afip-cae.updated_at = 1789166162442 ms.
  -- Antes de este instante el CbteFch pudo venir del navegador; después, no.
  SELECT timestamptz '2026-09-11 22:36:02.442+00' AS part1_cutover
), aut AS (
  -- El/los intentos AUTORIZADOS, agrupados por comprobante. Se conserva el
  -- conteo para poder declarar INCONSISTENT en vez de elegir uno.
  SELECT a.comprobante_id,
         count(*)                                                         AS autorizados_n,
         (array_agg(a.id           ORDER BY a.completed_at NULLS LAST))[1] AS att_id,
         (array_agg(a.started_at   ORDER BY a.completed_at NULLS LAST))[1] AS att_started_at,
         (array_agg(a.sent_at      ORDER BY a.completed_at NULLS LAST))[1] AS att_sent_at,
         (array_agg(a.completed_at ORDER BY a.completed_at NULLS LAST))[1] AS att_completed_at
    FROM arca_emission_attempts a
   WHERE a.status IN ('authorized', 'authorized_reconciled')
   GROUP BY a.comprobante_id
), todos AS (
  SELECT comprobante_id, count(*) AS intentos_totales
    FROM arca_emission_attempts GROUP BY comprobante_id
), base AS (
  SELECT
    c.id, c.business_id, c.numero_fiscal, c.fecha AS fecha_venta, c.fecha_emision_fiscal,
    -- Testigos de IDENTIDAD fiscal, para que el runner pueda verificar que la
    -- respuesta de ARCA corresponde a ESTE comprobante y no a otro con el
    -- mismo número: `numero_fiscal` solo es ambiguo (hay un 0010-00000001
    -- factura y otro nota de crédito).
    c.cae AS cae_local, c.total AS importe_local,
    aut.att_id, aut.autorizados_n, aut.att_started_at, aut.att_sent_at, aut.att_completed_at,
    COALESCE(todos.intentos_totales, 0) AS intentos_totales,
    nullif(split_part(c.numero_fiscal, '-', 1), '')::int AS pv_fiscal,
    nullif(split_part(c.numero_fiscal, '-', 2), '')::int AS nro_fiscal,
    COALESCE(
      nullif(c.tipo_comprobante_fiscal, '')::int,
      CASE c.tipo WHEN 'factura_c' THEN 11 WHEN 'nota_credito' THEN 13 WHEN 'factura_a' THEN 1 END
    ) AS cbte_tipo,
    -- Ventana del cálculo server-side. Se ENSANCHA con fecha_emision_fiscal
    -- (que complete_arca_attempt fija con now()) por si completed_at fuera
    -- anterior: una ventana más ancha sólo puede volver la prueba más estricta.
    aut.att_sent_at AS ventana_desde,
    GREATEST(aut.att_completed_at, c.fecha_emision_fiscal) AS ventana_hasta,
    p.part1_cutover
  FROM comprobantes c
  CROSS JOIN params p
  LEFT JOIN aut   ON aut.comprobante_id   = c.id
  LEFT JOIN todos ON todos.comprobante_id = c.id
  WHERE c.cae IS NOT NULL
), evaluado AS (
  SELECT base.*,
    -- ¿La ventana entera es posterior al corte? Entonces sólo aplica A.
    (ventana_desde IS NOT NULL AND ventana_desde > part1_cutover) AS post_corte,
    -- ¿El día civil argentino es constante en toda la ventana?
    (ventana_desde IS NOT NULL AND ventana_hasta IS NOT NULL
     AND (ventana_desde AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
       = (ventana_hasta AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) AS ar_constante
  FROM base
)
SELECT
  id::text,
  business_id::text,
  numero_fiscal,
  pv_fiscal,
  cbte_tipo,
  nro_fiscal,
  att_id::text AS authorized_attempt_id,
  autorizados_n,
  intentos_totales,
  cae_local,
  importe_local,
  CASE
    WHEN pv_fiscal IS NULL OR nro_fiscal IS NULL OR cbte_tipo IS NULL      THEN 'INCONSISTENT'
    WHEN autorizados_n > 1                                                 THEN 'INCONSISTENT'
    WHEN autorizados_n IS NULL AND intentos_totales > 0                    THEN 'INCONSISTENT'
    WHEN autorizados_n = 1 AND (att_sent_at IS NULL OR ventana_hasta IS NULL) THEN 'INCONSISTENT'
    WHEN autorizados_n IS NULL                                             THEN 'REQUIRES_ARCA_LOOKUP'
    WHEN NOT post_corte                                                    THEN 'REQUIRES_ARCA_LOOKUP'
    WHEN NOT ar_constante                                                  THEN 'REQUIRES_ARCA_LOOKUP'
    ELSE 'PROVABLE_LOCAL'
  END AS clase,
  CASE
    WHEN pv_fiscal IS NULL OR nro_fiscal IS NULL OR cbte_tipo IS NULL      THEN 'clave de consulta incompleta (PV/nro/CbteTipo)'
    WHEN autorizados_n > 1                                                 THEN 'más de un intento autorizado: no hay UN instante de cálculo'
    WHEN autorizados_n IS NULL AND intentos_totales > 0                    THEN 'tiene CAE e intentos, pero ninguno autorizado'
    WHEN autorizados_n = 1 AND (att_sent_at IS NULL OR ventana_hasta IS NULL) THEN 'el intento autorizado no tiene sent_at/completed_at'
    WHEN autorizados_n IS NULL                                             THEN 'sin intento: no hay ninguna cota temporal persistida'
    WHEN NOT post_corte                                                    THEN 'previa al corte de la Parte 1: el CbteFch pudo calcularlo el navegador, y ese instante no tiene cota inferior'
    WHEN NOT ar_constante                                                  THEN 'la ventana [sent_at, completado] cruza un límite de día civil argentino'
    ELSE 'ventana íntegramente post-Parte 1 y día civil argentino constante: sólo aplica el algoritmo server-side y da un único valor'
  END AS motivo,
  -- Sólo se llena cuando la clase es PROVABLE_LOCAL.
  CASE
    WHEN autorizados_n = 1 AND post_corte AND ar_constante
     AND pv_fiscal IS NOT NULL AND nro_fiscal IS NOT NULL AND cbte_tipo IS NOT NULL
    THEN to_char((ventana_desde AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, 'YYYYMMDD')
  END AS cbte_fch_probado,
  to_char(att_started_at,   'YYYY-MM-DD"T"HH24:MI:SSZ') AS authorized_started_at,
  to_char(att_sent_at,      'YYYY-MM-DD"T"HH24:MI:SSZ') AS authorized_sent_at,
  to_char(att_completed_at, 'YYYY-MM-DD"T"HH24:MI:SSZ') AS authorized_completed_at,
  to_char(ventana_hasta,    'YYYY-MM-DD"T"HH24:MI:SSZ') AS ventana_hasta,
  post_corte,
  ar_constante,
  to_char(ventana_desde AT TIME ZONE 'America/Argentina/Buenos_Aires', 'YYYYMMDD') AS dia_ar_desde,
  to_char(ventana_hasta  AT TIME ZONE 'America/Argentina/Buenos_Aires', 'YYYYMMDD') AS dia_ar_hasta,
  to_char(ventana_desde AT TIME ZONE 'UTC', 'YYYYMMDD')                             AS dia_utc_desde,
  to_char(ventana_hasta  AT TIME ZONE 'UTC', 'YYYYMMDD')                            AS dia_utc_hasta,
  to_char(fecha_venta AT TIME ZONE 'America/Argentina/Buenos_Aires', 'YYYYMMDD')     AS dia_venta_ar
FROM evaluado
ORDER BY business_id, pv_fiscal, cbte_tipo, nro_fiscal;
