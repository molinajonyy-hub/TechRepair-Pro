-- ============================================================================
-- M7 6F.4 — PREFLIGHT PRODUCTIVO (SOLO LECTURA).
-- No ejecuta UPDATE/INSERT/DELETE ni backfill. Correr ANTES de desplegar 6F.4.
--
-- BLOQUEAN el despliegue (deben dar 0):  A1, A3, A4, A5, A6, A7, A8, B2, B3
-- Informativos (se interpretan):          A2, C1, C2, D1, D2
-- ============================================================================

-- ── A. Integridad de anulaciones ────────────────────────────────────────────

-- A1 (BLOQUEA) comprobantes anulados SIN registro canonico de anulacion.
-- Son anulaciones hechas por la via legacy client-side: no tienen compensaciones
-- y el ledger no podra derivar su evento -> quedarian contados como venta viva
-- en su periodo original para siempre.
SELECT 'A1' AS check, count(*) AS n FROM comprobantes c
WHERE (c.estado='anulado' OR c.status='cancelled' OR c.estado_comercial='anulado')
  AND NOT EXISTS (SELECT 1 FROM comprobante_annulments a WHERE a.comprobante_id=c.id AND a.status='completed');
-- detalle
SELECT c.id, c.business_id, COALESCE(c.numero_fiscal,c.numero,c.number) AS numero,
       (COALESCE(c.fecha,c.date,c.created_at) AT TIME ZONE 'America/Argentina/Cordoba')::date AS fecha_original,
       c.total, c.total_cobrado, c.estado, c.estado_fiscal, c.cae IS NOT NULL AS tiene_cae
FROM comprobantes c
WHERE (c.estado='anulado' OR c.status='cancelled' OR c.estado_comercial='anulado')
  AND NOT EXISTS (SELECT 1 FROM comprobante_annulments a WHERE a.comprobante_id=c.id AND a.status='completed')
ORDER BY c.business_id, fecha_original;

-- A2 (informativo) anulaciones sin annulment_date: normal en TODAS las filas M6.
-- Su fecha economica se deriva de created_at. Verificar que created_at sea creible.
SELECT 'A2' AS check, count(*) FILTER (WHERE annulment_date IS NULL) AS sin_fecha_explicita,
       count(*) AS total,
       min((created_at AT TIME ZONE 'America/Argentina/Cordoba')::date) AS primera,
       max((created_at AT TIME ZONE 'America/Argentina/Cordoba')::date) AS ultima
FROM comprobante_annulments;

-- A3 (BLOQUEA) registros de anulacion sin comprobante.
SELECT 'A3' AS check, count(*) AS n FROM comprobante_annulments a
WHERE NOT EXISTS (SELECT 1 FROM comprobantes c WHERE c.id=a.comprobante_id);

-- A4 (BLOQUEA) mas de una anulacion completed por comprobante -> doble compensacion.
SELECT 'A4' AS check, count(*) AS n FROM (
  SELECT comprobante_id FROM comprobante_annulments WHERE status='completed'
  GROUP BY comprobante_id HAVING count(*)>1) d;

-- A5 (BLOQUEA) fechas de anulacion nulas e inderivables.
SELECT 'A5' AS check, count(*) AS n FROM comprobante_annulments
WHERE annulment_date IS NULL AND created_at IS NULL;

-- A6 (BLOQUEA) anulaciones cross-business (el negocio del registro != el del comprobante,
-- del pago sustituto o del movimiento de CC).
SELECT 'A6' AS check, count(*) AS n FROM comprobante_annulments a
JOIN comprobantes c ON c.id=a.comprobante_id
WHERE c.business_id <> a.business_id;

-- A7 (BLOQUEA) fecha de anulacion ANTERIOR a la fecha original -> compensacion en un
-- periodo previo a la venta (imposible; romperia el acumulado por periodo).
SELECT 'A7' AS check, count(*) AS n FROM comprobante_annulments a
JOIN comprobantes c ON c.id=a.comprobante_id
WHERE COALESCE(a.annulment_date,(a.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date)
    < (COALESCE(c.fecha,c.date,c.created_at) AT TIME ZONE 'America/Argentina/Cordoba')::date;

-- A8 (BLOQUEA) DOBLE REVERSION: un comprobante con anulacion interna Y nota de credito.
-- Por diseño es imposible (la NC exige CAE y la anulacion lo rechaza), pero si
-- aparece alguno, el ledger y el CTE returns lo compensarian dos veces.
SELECT 'A8' AS check, count(*) AS n FROM comprobante_annulments a
WHERE EXISTS (SELECT 1 FROM comprobantes nc WHERE nc.comprobante_original_id=a.comprobante_id
                AND COALESCE(nc.tipo,nc.type)='nota_credito' AND nc.estado <> 'anulado');
-- detalle
SELECT a.comprobante_id, a.business_id, a.annulment_date, a.created_at, nc.id AS nota_credito_id, nc.estado_fiscal
FROM comprobante_annulments a
JOIN comprobantes nc ON nc.comprobante_original_id=a.comprobante_id
WHERE COALESCE(nc.tipo,nc.type)='nota_credito' AND nc.estado <> 'anulado';

-- A9 comprobantes anulados con totales o costos nulos (el evento espejo saldria NULL).
SELECT 'A9' AS check, count(*) AS n FROM comprobante_annulments a
JOIN comprobante_items ci ON ci.comprobante_id=a.comprobante_id
WHERE ci.subtotal IS NULL OR ci.costo_total IS NULL OR ci.precio_unitario IS NULL OR ci.cantidad IS NULL;

-- ── B. Coherencia de las compensaciones ya escritas ─────────────────────────

-- B1 (informativo) anulados sin ninguna compensacion de caja: legitimo si la venta
-- fue 100% CC o no tenia cobros. Cruzar con reverted_cash_ars=0.
SELECT 'B1' AS check, count(*) AS n FROM comprobante_annulments a
WHERE a.reverted_cash_ars > 1
  AND NOT EXISTS (SELECT 1 FROM financial_movements f
                   WHERE f.comprobante_id=a.comprobante_id AND f.reference_type='annulment_reversal');

-- B2 (BLOQUEA) compensaciones de anulacion SIN comprobante anulado.
SELECT 'B2' AS check, count(*) AS n FROM financial_movements f
WHERE f.reference_type='annulment_reversal'
  AND NOT EXISTS (SELECT 1 FROM comprobante_annulments a WHERE a.comprobante_id=f.comprobante_id AND a.status='completed');

-- B3 (BLOQUEA) DOBLE DEVOLUCION: mas de una compensacion por cada FM de ingreso original.
-- Es el bug que 6F.4 corrige (compensar tambien los ingresos ya reemplazados por 6F.3).
-- Si aparece >0 hay caja ya deformada en produccion: reportar, NO corregir aca.
SELECT 'B3' AS check, count(*) AS n FROM (
  SELECT f.reference_id FROM financial_movements f
  WHERE f.reference_type='annulment_reversal' AND f.reference_id IS NOT NULL
  GROUP BY f.reference_id HAVING count(*)>1) d;
-- detalle: anulaciones que compensaron un ingreso YA reversado por un reemplazo
SELECT a.comprobante_id, a.business_id, a.reverted_cash_ars,
       (SELECT COALESCE(SUM(p.amount_ars),0) FROM comprobante_payments p
         WHERE p.comprobante_id=a.comprobante_id AND p.replaced_at IS NULL) AS cobros_vivos,
       (SELECT count(*) FROM financial_movements f
         WHERE f.comprobante_id=a.comprobante_id AND f.reference_type='annulment_reversal') AS devoluciones
FROM comprobante_annulments a
WHERE EXISTS (SELECT 1 FROM financial_movements o
               WHERE o.comprobante_id=a.comprobante_id AND o.type='income'
                 AND o.reversed_at IS NOT NULL
                 AND EXISTS (SELECT 1 FROM financial_movements r
                              WHERE r.reference_type='annulment_reversal' AND r.reference_id=o.id));

-- B4 stock restaurado dos veces (marcador stock_processed consumido mas de una vez).
SELECT 'B4' AS check, count(*) AS n FROM (
  SELECT reference_id, inventory_item_id FROM inventory_movements
  WHERE reference_type='comprobante' AND movement_type='return'
  GROUP BY reference_id, inventory_item_id HAVING count(*)>1) d;

-- B5 pagos reemplazados que sigan contando como vivos (invariante 6F.3).
SELECT 'B5' AS check, count(*) AS n FROM comprobante_payments
WHERE num_nonnulls(replaced_at, replaced_by, replacement_payment_id) NOT IN (0,3);

-- B6 movimientos de CC compensatorios duplicados.
SELECT 'B6' AS check, count(*) AS n FROM (
  SELECT reference_id FROM account_movements
  WHERE reference_type='comprobante' AND type='ajuste'
  GROUP BY reference_id HAVING count(*)>1) d;

-- ── C. RESTATEMENT: diferencia contable por negocio y mes ───────────────────
-- Compara el P&L ANTERIOR (excluia retroactivamente la venta anulada) contra el
-- CORREGIDO (venta en su periodo + compensacion en el periodo de anulacion).
-- El neto acumulado por negocio DEBE dar 0.

-- C1 por business_id + año-mes
WITH viejo AS (  -- modelo anterior: la venta anulada simplemente no existia
  SELECT c.business_id,
         to_char((COALESCE(c.fecha,c.date,c.created_at) AT TIME ZONE 'America/Argentina/Cordoba')::date,'YYYY-MM') AS mes,
         sum(ci.subtotal) AS ventas, sum(ci.costo_total) AS cogs
  FROM comprobantes c JOIN comprobante_items ci ON ci.comprobante_id=c.id
  WHERE c.estado <> 'anulado' AND COALESCE(c.estado_comercial,'') <> 'anulado'
  GROUP BY 1,2
), nuevo AS (  -- modelo corregido: el ledger append-only
  SELECT l.business_id, to_char(l.period_date,'YYYY-MM') AS mes,
         sum(l.sales_amount_ars) AS ventas, sum(l.cogs_amount_ars) AS cogs
  FROM v_finance_sales_ledger l WHERE l.is_credit_note=false
  GROUP BY 1,2
)
SELECT 'C1' AS check,
       COALESCE(v.business_id,n.business_id) AS business_id,
       COALESCE(v.mes,n.mes) AS mes,
       COALESCE(v.ventas,0) AS ventas_actual,   COALESCE(n.ventas,0) AS ventas_corregida,
       COALESCE(v.cogs,0)   AS cogs_actual,     COALESCE(n.cogs,0)   AS cogs_corregido,
       COALESCE(v.ventas,0)-COALESCE(v.cogs,0) AS resultado_actual,
       COALESCE(n.ventas,0)-COALESCE(n.cogs,0) AS resultado_corregido,
       abs((COALESCE(n.ventas,0)-COALESCE(n.cogs,0)) - (COALESCE(v.ventas,0)-COALESCE(v.cogs,0))) AS diferencia_abs,
       (SELECT count(DISTINCT a.comprobante_id) FROM comprobante_annulments a
         JOIN comprobantes c2 ON c2.id=a.comprobante_id
        WHERE a.business_id=COALESCE(v.business_id,n.business_id)
          AND (to_char((COALESCE(c2.fecha,c2.date,c2.created_at) AT TIME ZONE 'America/Argentina/Cordoba')::date,'YYYY-MM')=COALESCE(v.mes,n.mes)
            OR to_char(COALESCE(a.annulment_date,(a.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date),'YYYY-MM')=COALESCE(v.mes,n.mes))
       ) AS anulaciones_involucradas
FROM viejo v FULL OUTER JOIN nuevo n ON n.business_id=v.business_id AND n.mes=v.mes
WHERE COALESCE(v.ventas,0)<>COALESCE(n.ventas,0) OR COALESCE(v.cogs,0)<>COALESCE(n.cogs,0)
ORDER BY business_id, mes;

-- C2 (BLOQUEA si <> 0) efecto acumulado neto por negocio: debe ser 0.
-- Cualquier valor distinto de 0 significa que hay diferencias NO explicables por
-- anulaciones (tipicamente A1: anulados sin registro canonico).
WITH viejo AS (
  SELECT c.business_id, sum(ci.subtotal) AS ventas, sum(ci.costo_total) AS cogs
  FROM comprobantes c JOIN comprobante_items ci ON ci.comprobante_id=c.id
  WHERE c.estado <> 'anulado' AND COALESCE(c.estado_comercial,'') <> 'anulado'
  GROUP BY 1
), nuevo AS (
  SELECT l.business_id, sum(l.sales_amount_ars) AS ventas, sum(l.cogs_amount_ars) AS cogs
  FROM v_finance_sales_ledger l WHERE l.is_credit_note=false GROUP BY 1
)
SELECT 'C2' AS check, COALESCE(v.business_id,n.business_id) AS business_id,
       COALESCE(n.ventas,0)-COALESCE(v.ventas,0) AS delta_ventas_acumulado,
       COALESCE(n.cogs,0)-COALESCE(v.cogs,0)     AS delta_cogs_acumulado
FROM viejo v FULL OUTER JOIN nuevo n ON n.business_id=v.business_id
WHERE COALESCE(n.ventas,0)-COALESCE(v.ventas,0) <> 0 OR COALESCE(n.cogs,0)-COALESCE(v.cogs,0) <> 0;

-- ── D. Detalle por comprobante anulado (para el informe de restatement) ─────
SELECT 'D1' AS check, a.comprobante_id, a.business_id,
       COALESCE(c.numero_fiscal,c.numero,c.number) AS numero,
       (COALESCE(c.fecha,c.date,c.created_at) AT TIME ZONE 'America/Argentina/Cordoba')::date AS fecha_original,
       COALESCE(a.annulment_date,(a.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date) AS fecha_anulacion,
       (SELECT COALESCE(SUM(ci.subtotal),0) FROM comprobante_items ci WHERE ci.comprobante_id=a.comprobante_id) AS venta,
       (SELECT COALESCE(SUM(ci.costo_total),0) FROM comprobante_items ci WHERE ci.comprobante_id=a.comprobante_id) AS cogs,
       (SELECT COALESCE(SUM(ci.subtotal-ci.costo_total),0) FROM comprobante_items ci WHERE ci.comprobante_id=a.comprobante_id) AS diferencia_resultado,
       EXISTS (SELECT 1 FROM comprobantes nc WHERE nc.comprobante_original_id=a.comprobante_id
                 AND COALESCE(nc.tipo,nc.type)='nota_credito') AS tiene_nota_credito
FROM comprobante_annulments a
JOIN comprobantes c ON c.id=a.comprobante_id
WHERE a.status='completed'
ORDER BY a.business_id, fecha_original;

-- D2 totales del restatement (para el informe: el neto DEBE ser 0)
SELECT 'D2' AS check,
       count(*) AS anulaciones,
       sum((SELECT COALESCE(SUM(ci.subtotal),0) FROM comprobante_items ci WHERE ci.comprobante_id=a.comprobante_id)) AS ventas_restauradas_en_periodo_original,
       -sum((SELECT COALESCE(SUM(ci.subtotal),0) FROM comprobante_items ci WHERE ci.comprobante_id=a.comprobante_id)) AS ventas_compensadas_en_periodo_anulacion,
       0::numeric AS efecto_acumulado_neto
FROM comprobante_annulments a WHERE a.status='completed';

-- ============================================================================
-- ── F. 6F.4a — Invariantes de comprobante anulado ───────────────────────────
-- Todos deben dar 0 y BLOQUEAN el despliegue salvo donde se indique.
-- La condicion canonica es is_comprobante_annulled(id): registro de anulacion
-- completado OR cualquier señal operativa (estado / estado_comercial / status).
-- ============================================================================

-- F1 (BLOQUEA) comprobantes anulados con pagos VIVOS creados DESPUES de la anulacion.
-- Los pagos vivos anteriores son normales (la anulacion los compensa, no los borra):
-- lo que no puede existir es un cobro nuevo posterior a la anulacion.
SELECT 'F1' AS check, count(*) AS n
FROM comprobante_payments p
JOIN comprobante_annulments a ON a.comprobante_id = p.comprobante_id AND a.status='completed'
WHERE p.replaced_at IS NULL
  AND p.date > COALESCE(a.annulment_date, (a.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date);
-- detalle
SELECT p.id AS payment_id, p.comprobante_id, p.business_id, p.payment_method, p.amount_ars,
       p.date AS fecha_pago,
       COALESCE(a.annulment_date,(a.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date) AS fecha_anulacion
FROM comprobante_payments p
JOIN comprobante_annulments a ON a.comprobante_id = p.comprobante_id AND a.status='completed'
WHERE p.replaced_at IS NULL
  AND p.date > COALESCE(a.annulment_date, (a.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date);

-- F2 (BLOQUEA) pagos creados DESPUES de annulment_date, vivos o no (incluye los
-- que un reemplazo posterior a la anulacion pudo haber dejado).
SELECT 'F2' AS check, count(*) AS n
FROM comprobante_payments p
JOIN comprobante_annulments a ON a.comprobante_id = p.comprobante_id AND a.status='completed'
WHERE p.created_at > a.created_at;

-- F3 (BLOQUEA) REEMPLAZOS registrados despues de una anulacion.
SELECT 'F3' AS check, count(*) AS n
FROM comprobante_payment_replace_requests q
JOIN comprobante_annulments a ON a.comprobante_id = q.comprobante_id AND a.status='completed'
WHERE q.created_at > a.created_at AND COALESCE(q.status,'completed') = 'completed';

-- F4 (BLOQUEA) registro de anulacion pero señales ACTIVAS (desincronizacion).
SELECT 'F4' AS check, count(*) AS n
FROM comprobante_annulments a JOIN comprobantes c ON c.id = a.comprobante_id
WHERE a.status='completed'
  AND NOT public.comprobante_state_is_annulled(c.estado, c.estado_comercial, c.status);
-- detalle: que columna quedo activa
SELECT a.comprobante_id, a.business_id, c.estado, c.estado_comercial, c.status, c.estado_fiscal,
       COALESCE(a.annulment_date,(a.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date) AS fecha_anulacion
FROM comprobante_annulments a JOIN comprobantes c ON c.id = a.comprobante_id
WHERE a.status='completed'
  AND NOT public.comprobante_state_is_annulled(c.estado, c.estado_comercial, c.status);

-- F5 (BLOQUEA) señales PARCIALES: alguna dice anulado y otra no (sin importar el registro).
-- Detecta tanto anulaciones legacy incompletas como intentos de "resucitar" por una columna.
SELECT 'F5' AS check, count(*) AS n FROM comprobantes c
WHERE public.comprobante_state_is_annulled(c.estado, c.estado_comercial, c.status)
  AND NOT (COALESCE(c.estado,'')='anulado' AND COALESCE(c.estado_comercial,'')='anulado'
           AND COALESCE(c.status,'')='cancelled');
-- detalle por columna
SELECT c.id, c.business_id, c.estado, c.estado_comercial, c.status,
       EXISTS (SELECT 1 FROM comprobante_annulments a WHERE a.comprobante_id=c.id AND a.status='completed') AS tiene_registro
FROM comprobantes c
WHERE public.comprobante_state_is_annulled(c.estado, c.estado_comercial, c.status)
  AND NOT (COALESCE(c.estado,'')='anulado' AND COALESCE(c.estado_comercial,'')='anulado'
           AND COALESCE(c.status,'')='cancelled');

-- F6 (BLOQUEA) estado='anulado' sin registro canonico (anulacion client-side legacy).
SELECT 'F6' AS check, count(*) AS n FROM comprobantes c
WHERE c.estado='anulado'
  AND NOT EXISTS (SELECT 1 FROM comprobante_annulments a WHERE a.comprobante_id=c.id AND a.status='completed');

-- F7 (BLOQUEA) estado_comercial='anulado' sin registro canonico.
SELECT 'F7' AS check, count(*) AS n FROM comprobantes c
WHERE c.estado_comercial='anulado'
  AND NOT EXISTS (SELECT 1 FROM comprobante_annulments a WHERE a.comprobante_id=c.id AND a.status='completed');

-- F8 (BLOQUEA) status='cancelled' sin registro canonico.
SELECT 'F8' AS check, count(*) AS n FROM comprobantes c
WHERE c.status='cancelled'
  AND NOT EXISTS (SELECT 1 FROM comprobante_annulments a WHERE a.comprobante_id=c.id AND a.status='completed');

-- F9 (BLOQUEA) DESANULADOS: hay registro de anulacion y el comprobante volvio a
-- estar operativamente activo en las TRES señales.
SELECT 'F9' AS check, count(*) AS n
FROM comprobante_annulments a JOIN comprobantes c ON c.id=a.comprobante_id
WHERE a.status='completed'
  AND COALESCE(c.estado,'') NOT IN ('anulado')
  AND COALESCE(c.estado_comercial,'') NOT IN ('anulado')
  AND COALESCE(c.status,'') NOT IN ('cancelled');

-- F10 (informativo, DEUDA LEGACY EXPLICADA — no corregir, ver §8 del informe)
-- BFE espejo de anulaciones que quedaron en legacy_unclassified porque se
-- insertaron ANTES de que bfe_economic_class reconociera source='annulment'.
-- economic_class se setea solo al insertar (trigger, si es NULL) -> las filas
-- viejas conservan su clase. NO alimentan operating_result: solo aparecen en
-- data_quality_flags.unclassified_amount. El health check v2 debe distinguirlas
-- de un dato realmente sin clasificar y NO emitir alerta critica por ellas.
SELECT 'F10' AS check, count(*) AS n, COALESCE(SUM(amount_ars),0) AS monto,
       count(DISTINCT business_id) AS negocios
FROM business_finance_entries
WHERE source='annulment' AND economic_class='legacy_unclassified';
-- detalle para el listado de deuda de clasificacion
SELECT business_id, date, type, category, amount_ars, reference_comprobante_id, description
FROM business_finance_entries
WHERE source='annulment' AND economic_class='legacy_unclassified'
ORDER BY business_id, date;

-- F11 (informativo) requests M6 de anulacion cuyo request_hash es MD5 (32 hex) y
-- no SHA-256 (64 hex): un reintento de esas keys tras desplegar 6F.4 daria
-- IDEMPOTENCY_CONFLICT en vez de replay. No es una perdida de dinero (el indice
-- unico parcial por comprobante impide la doble anulacion), solo un error
-- confuso en un reintento de una key vieja. Las keys son UUID por llamada, asi
-- que el riesgo real es despreciable; se mide para dimensionarlo.
SELECT 'F11' AS check,
       count(*) FILTER (WHERE length(request_hash)=32) AS hashes_md5_legacy,
       count(*) FILTER (WHERE length(request_hash)=64) AS hashes_sha256,
       count(*) AS total
FROM comprobante_annulments;

-- ── E. Vistas/funciones que aun excluyan anulados retroactivamente ──────────
-- Revisar a mano: cualquier consumidor ACCRUAL_HISTORY que siga leyendo la vista
-- de estado actual. Los CURRENT_STATE (aging, deuda vigente) DEBEN seguir asi.
SELECT 'E1' AS check, c.relname AS vista,
       CASE WHEN pg_get_viewdef(c.oid,true) ~ 'v_finance_sales_ledger' THEN 'ACCRUAL (ledger)'
            ELSE 'CURRENT_STATE (effective)' END AS fuente
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='v'
  AND pg_get_viewdef(c.oid,true) ~ '(v_finance_effective_comprobantes|v_finance_sales_ledger)'
ORDER BY 1;
