-- ============================================================================
-- Charts L1 — contratos canonicos para las visualizaciones financieras.
--
-- Responde, server-side y con una sola llamada, las 9 preguntas del lote L1:
--   1. Estoy ganando?                  -> pnl_series / summary
--   2. Mas o menos que antes?          -> comparison
--   3. Que se come mi ganancia?        -> waterfall
--   4. Vendo pero no cobro?            -> billing_vs_collections
--   5. Como cobro?                     -> payment_mix
--   6. Cuanto me deben?                -> receivables_aging
--   7. Cuanto debo?                    -> payables_aging + payables_due
--   8. Cuanto capital hay en stock?    -> inventory_capital
--   9. Repongo lo que consumo?         -> inventory_flows
--
-- ── ALCANCE ────────────────────────────────────────────────────────────────
--   · 3 vistas nuevas (security_invoker, SOLO lectura).
--   · 1 RPC de lectura (SECURITY INVOKER) que arma el payload del periodo.
--
-- ── LO QUE NO HACE ─────────────────────────────────────────────────────────
--   · CERO DML. Ni un INSERT/UPDATE/DELETE. Ni backfill.
--   · No toca importes historicos ni periodos cerrados.
--   · No crea materialized views, triggers, cron ni Realtime.
--   · No modifica v_finance_pnl, v_finance_cashflow, v_finance_position,
--     v_finance_*_aging, v_finance_payables_due ni nada de M7/M8.
--   · No aplica tipo de cambio a nada (ver NOTA FX).
--
-- ── NOTA FX (regla dura) ───────────────────────────────────────────────────
-- No existe fuente de tipo de cambio server-side: `exchangeRateService` la
-- consulta en vivo desde el cliente. Por eso NINGUNA superficie de este archivo
-- convierte USD->ARS. `inventory.cost_price` ya esta en ARS (valor materializado
-- por el flujo de actualizacion de precios, con la tasa aplicada registrada en
-- `inventory.exchange_rate_used`). La tasa se expone SOLO como metadato de
-- calidad, jamas como factor de un calculo.
--
-- ── NOTA TZ ────────────────────────────────────────────────────────────────
-- Se usa 'America/Argentina/Cordoba', identica a Buenos_Aires (UTC-3 todo el
-- anio, sin DST) y ya usada por ar_today(), v_finance_cashflow y el ledger
-- devengado. Elegir otra etiqueta daria los mismos limites de dia pero
-- introduciria una divergencia gratuita con el P&L.
--
-- ── LO QUE QUEDA BLOQUEADO, A PROPOSITO ────────────────────────────────────
-- Ver docs/auditoria-finanzas/charts-l1/24-inventario-source-of-truth.md
--   · Serie historica de "Capital en stock": inventory_valuation_history tiene
--     3 snapshots de 1 negocio (2026-04-13..15) escritos oportunisticamente por
--     el frontend. No es una serie.
--   · Puente/waterfall de inventario: no hay costo historico por producto/dia.
--     Valuar stock pasado a costo de hoy es exactamente la cifra falsa que se
--     prohibe. Se exponen por separado capital actual y flujos del periodo.
-- ============================================================================

-- BEGIN/COMMIT EXPLICITOS: el CLI aplica cada archivo en AUTOCOMMIT. Sin este
-- bloque los SET LOCAL son no-op y una postcondicion fallida dejaria vistas a
-- medio crear en vez de abortar limpio.
BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

-- ============================================================================
-- 0. PRECONDICIONES
-- ============================================================================
DO $pre$
DECLARE
  v_missing text;
BEGIN
  FOREACH v_missing IN ARRAY ARRAY[
    'public.inventory', 'public.inventory_movements', 'public.comprobante_payments',
    'public.comprobante_annulments', 'public.v_finance_pnl', 'public.v_finance_cashflow',
    'public.v_finance_receivables_aging', 'public.v_finance_payables_aging',
    'public.v_finance_payables_due', 'public.v_owner_flows'
  ] LOOP
    IF to_regclass(v_missing) IS NULL THEN
      RAISE EXCEPTION 'PRECONDICION P0: falta %', v_missing;
    END IF;
  END LOOP;

  IF to_regproc('public.ar_today') IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION P1: falta public.ar_today()';
  END IF;

  -- El modelo de variantes admite DOS convenciones. Ambas deben existir para
  -- que la exclusion de padres sea completa.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                  WHERE attrelid='public.inventory'::regclass
                    AND attname='parent_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PRECONDICION P2: falta inventory.parent_id';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                  WHERE attrelid='public.inventory'::regclass
                    AND attname='supplier_code' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PRECONDICION P3: falta inventory.supplier_code';
  END IF;

  -- El costo snapshot del movimiento es la base de "compras del periodo".
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                  WHERE attrelid='public.inventory_movements'::regclass
                    AND attname='unit_cost' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PRECONDICION P4: falta inventory_movements.unit_cost';
  END IF;

  -- Sin replaced_at no se puede distinguir un pago vivo de uno reemplazado.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                  WHERE attrelid='public.comprobante_payments'::regclass
                    AND attname='replaced_at' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PRECONDICION P5: falta comprobante_payments.replaced_at (M7 6F.3)';
  END IF;
END
$pre$;

-- Baseline: permite exigir en la postcondicion que este lote NO escribio datos.
DROP TABLE IF EXISTS _l1_baseline;
CREATE TEMP TABLE _l1_baseline AS
SELECT
  (SELECT count(*) FROM public.inventory)                                  AS inv_rows,
  (SELECT COALESCE(sum(stock_quantity),0) FROM public.inventory)           AS inv_units,
  (SELECT COALESCE(sum(cost_price),0) FROM public.inventory)               AS inv_cost,
  (SELECT count(*) FROM public.inventory_movements)                        AS mov_rows,
  (SELECT count(*) FROM public.comprobante_payments)                       AS pay_rows,
  (SELECT COALESCE(sum(amount_ars),0) FROM public.comprobante_payments)    AS pay_amount,
  (SELECT count(*) FROM public.inventory_valuation_history)                AS ivh_rows;

-- ============================================================================
-- 1. v_finance_inventory_capital — CAPITAL EN STOCK (valor actual)
-- ============================================================================
-- Una fila por negocio. Responde "cuanto dinero tengo puesto HOY en mercaderia",
-- valuado al costo vigente registrado en cada producto.
--
-- NO es patrimonio. NO es capital total. NO incluye caja, CxC, CxP ni activos
-- fijos. Representa exclusivamente inventario.
--
-- Universo: activos, tipo='product', excluyendo padres de variante por las DOS
-- convenciones del modelo (parent_id y supplier_code='VPREF-<id>'). Medido en
-- produccion: ambas reglas dan hoy el mismo total, y usar las dos evita romperse
-- cuando aparezca la primera variante por parent_id.
--
-- Se publican DOS totales a proposito:
--   · inventory_at_cost        — universo con stock (incluye costo 0)
--   · inventory_at_cost_valued — universo stock>0 AND cost>0, que es EXACTAMENTE
--     el denominador de la regla `dead_stock` de M8. Sin esto, decir "de tu
--     capital, $X esta inmovilizado" mezclaria denominadores distintos.
CREATE OR REPLACE VIEW public.v_finance_inventory_capital
  WITH (security_invoker = true) AS
WITH base AS (
  SELECT
    i.business_id,
    i.stock_quantity,
    COALESCE(i.cost_price, 0)::numeric AS cost_price,
    i.base_currency,
    i.exchange_rate_used
  FROM public.inventory i
  WHERE i.is_active = true
    AND COALESCE(i.tipo, 'product') = 'product'
    AND NOT EXISTS (
      SELECT 1 FROM public.inventory v
       WHERE v.business_id = i.business_id AND v.parent_id = i.id)
    AND NOT EXISTS (
      SELECT 1 FROM public.inventory v
       WHERE v.business_id = i.business_id
         AND v.supplier_code = 'VPREF-' || i.id::text)
)
SELECT
  b.business_id,
  -- Capital en stock. Stock negativo (hoy 0 filas) entra con su signo: se ve,
  -- no se esconde.
  round(COALESCE(sum(b.stock_quantity * b.cost_price)
                 FILTER (WHERE b.stock_quantity <> 0), 0), 2)          AS inventory_at_cost,
  -- Universo comparable con dead_stock (M8).
  round(COALESCE(sum(b.stock_quantity * b.cost_price)
                 FILTER (WHERE b.stock_quantity > 0 AND b.cost_price > 0), 0), 2)
                                                                        AS inventory_at_cost_valued,
  -- ── Cobertura (§25): nunca valuar en silencio un producto sin costo ──
  count(*) FILTER (WHERE b.stock_quantity > 0)                          AS products_total,
  count(*) FILTER (WHERE b.stock_quantity > 0 AND b.cost_price > 0)     AS products_valued,
  count(*) FILTER (WHERE b.stock_quantity > 0 AND b.cost_price <= 0)    AS products_missing_cost,
  COALESCE(sum(b.stock_quantity)
           FILTER (WHERE b.stock_quantity > 0 AND b.cost_price <= 0), 0)::bigint
                                                                        AS units_missing_cost,
  count(*) FILTER (WHERE b.stock_quantity < 0)                          AS products_negative_stock,
  -- ── Metadato FX (§21). SOLO informativo: no multiplica nada ──
  count(*) FILTER (WHERE b.stock_quantity > 0 AND b.base_currency = 'USD')
                                                                        AS usd_based_products,
  round(min(b.exchange_rate_used) FILTER (
        WHERE b.stock_quantity > 0 AND b.base_currency = 'USD' AND b.exchange_rate_used > 0), 2)
                                                                        AS usd_rate_min_applied,
  round(max(b.exchange_rate_used) FILTER (
        WHERE b.stock_quantity > 0 AND b.base_currency = 'USD' AND b.exchange_rate_used > 0), 2)
                                                                        AS usd_rate_max_applied
FROM base b
GROUP BY b.business_id;

COMMENT ON VIEW public.v_finance_inventory_capital IS
  'Charts L1 — Capital en stock: mercaderia disponible valuada al costo vigente '
  'registrado (inventory.cost_price, ya en ARS). NO es patrimonio ni capital '
  'total: es exclusivamente inventario. No aplica tipo de cambio (no hay fuente '
  'FX server-side); usd_rate_* es metadato de calidad, no un factor. '
  'inventory_at_cost_valued comparte denominador con la regla dead_stock de M8.';

REVOKE ALL ON public.v_finance_inventory_capital FROM PUBLIC;
GRANT SELECT ON public.v_finance_inventory_capital TO authenticated, service_role;

-- ============================================================================
-- 2. v_finance_inventory_flows — FLUJOS FISICOS/ECONOMICOS DEL INVENTARIO
-- ============================================================================
-- Una fila por (negocio, dia AR, flow_kind). Clasifica por la referencia REAL
-- del movimiento: no todo `out` es COGS y no toda entrada es una compra.
--
-- flow_kind:
--   purchase        entrada por compra/ingreso        -> SI cuenta como reposicion
--   return_in       devolucion / restauracion fisica  -> NO es compra
--   cancellation_in reposicion por cancelacion        -> NO es compra
--   adjustment      correccion administrativa         -> NO es compra ni consumo
--   sale_out        salida por venta                  -> consumo comercial
--   order_out       repuesto consumido en una orden   -> consumo comercial
--   credit_note_out salida asociada a nota de credito
--   other_out       resto de salidas
--
-- IMPORTANTE — por que el costo del CONSUMO no sale de aca:
-- medido en produccion, `sale` (376 filas) y `order_usage` (26) tienen
-- unit_cost en el 0 % de los casos. Valuar salidas con esto daria $0. El costo
-- del consumo se toma del COGS del ledger devengado (ver la RPC). Aca se
-- publican las UNIDADES de salida y el contador de filas sin costo, para que la
-- limitacion sea visible.
CREATE OR REPLACE VIEW public.v_finance_inventory_flows
  WITH (security_invoker = true) AS
SELECT
  m.business_id,
  (m.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date AS movement_date_ar,
  CASE m.movement_type
    WHEN 'purchase'     THEN 'purchase'
    WHEN 'in'           THEN 'purchase'
    WHEN 'return'       THEN 'return_in'
    WHEN 'cancellation' THEN 'cancellation_in'
    WHEN 'adjustment'   THEN 'adjustment'
    WHEN 'sale'         THEN 'sale_out'
    WHEN 'order_usage'  THEN 'order_out'
    WHEN 'credit_note'  THEN 'credit_note_out'
    ELSE 'other_out'
  END AS flow_kind,
  -- Direccion economica real, tomada del signo de la cantidad (que es lo que
  -- efectivamente movio el stock), no del nombre del tipo.
  sum(m.quantity)::bigint                                            AS net_units,
  sum(abs(m.quantity))::bigint                                       AS gross_units,
  count(*)                                                           AS movements,
  count(*) FILTER (WHERE COALESCE(m.unit_cost, 0) > 0)               AS movements_costed,
  -- Importe SOLO sobre las filas que traen costo snapshot. Nunca se imputa un
  -- costo faltante.
  round(COALESCE(sum(abs(m.quantity) * m.unit_cost)
                 FILTER (WHERE COALESCE(m.unit_cost, 0) > 0), 0), 2) AS cost_amount_ars
FROM public.inventory_movements m
GROUP BY 1, 2, 3;

COMMENT ON VIEW public.v_finance_inventory_flows IS
  'Charts L1 — flujos de inventario por (negocio, dia AR, flow_kind) a costo '
  'SNAPSHOT del movimiento. Solo `purchase` cuenta como reposicion: '
  'devoluciones, cancelaciones y ajustes quedan en clases propias. El costo del '
  'consumo NO sale de aca (sale/order_usage no traen unit_cost): se toma del '
  'COGS devengado. movements vs movements_costed expone la cobertura real.';

REVOKE ALL ON public.v_finance_inventory_flows FROM PUBLIC;
GRANT SELECT ON public.v_finance_inventory_flows TO authenticated, service_role;

-- ============================================================================
-- 3. v_finance_collections_ledger — COBROS, APPEND-ONLY
-- ============================================================================
-- Espejo exacto de la filosofia de v_finance_sales_ledger (M7 6F.4): el cobro
-- NUNCA desaparece de su periodo; si el comprobante se anula, se emite un evento
-- compensatorio NEGATIVO en el periodo de la ANULACION.
--
-- Medido en produccion: anular NO borra comprobante_payments (hay 1 pago vivo
-- sobre un comprobante anulado). Filtrar por existencia habria dejado el cobro
-- contado para siempre.
--
-- Cuenta corriente NO participa: esta vista lee comprobante_payments, que es
-- dinero efectivamente recibido. Una venta en CC no genera fila aca hasta que
-- se cobra.
--
-- Pagos reemplazados (M7 6F.3): vive el que tiene replaced_at IS NULL.
CREATE OR REPLACE VIEW public.v_finance_collections_ledger
  WITH (security_invoker = true) AS
WITH live AS (
  SELECT
    cp.id,
    cp.business_id,
    cp.comprobante_id,
    cp.amount_ars,
    COALESCE(NULLIF(cp.payment_method, ''), 'otro') AS payment_method,
    -- cp.date ya ES el dia de la operacion (tipo `date`, sin zona): se usa tal
    -- cual. Pasarlo por AT TIME ZONE lo interpretaria como medianoche UTC y lo
    -- correria un dia hacia atras. Solo el fallback sobre created_at
    -- (timestamptz) necesita convertirse a dia AR.
    COALESCE(cp.date,
             (cp.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date) AS period_date
  FROM public.comprobante_payments cp
  WHERE cp.replaced_at IS NULL
), ann AS (
  SELECT
    a.comprobante_id,
    a.business_id,
    COALESCE(a.annulment_date,
             (a.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date) AS period_date
  FROM public.comprobante_annulments a
  WHERE a.status = 'completed'
)
SELECT
  l.business_id,
  'collection'::text AS event_type,
  l.period_date,
  l.comprobante_id,
  l.id                AS comprobante_payment_id,
  l.payment_method,
  l.amount_ars        AS amount_ars
FROM live l
UNION ALL
SELECT
  l.business_id,
  'annulment'::text,
  a.period_date,
  l.comprobante_id,
  l.id,
  l.payment_method,
  -l.amount_ars
FROM live l
JOIN ann a ON a.comprobante_id = l.comprobante_id AND a.business_id = l.business_id;

COMMENT ON VIEW public.v_finance_collections_ledger IS
  'Charts L1 — ledger APPEND-ONLY de cobros. event_type=collection en la fecha '
  'del pago con importe positivo; event_type=annulment en la fecha economica de '
  'la anulacion con importe negativo. Solo pagos VIVOS (replaced_at IS NULL). '
  'Cuenta corriente no participa: esto es dinero recibido, no deuda generada.';

REVOKE ALL ON public.v_finance_collections_ledger FROM PUBLIC;
GRANT SELECT ON public.v_finance_collections_ledger TO authenticated, service_role;

-- ============================================================================
-- 4. get_finance_charts_l1 — payload unico del periodo
-- ============================================================================
-- SECURITY INVOKER a proposito: todas las fuentes son security_invoker y estan
-- bajo RLS, asi que no hace falta escalar privilegios ni agregar un ownership
-- check propio (que ademas romperia a un usuario con mas de un negocio). Un
-- p_business_id ajeno devuelve payload vacio por RLS, no datos de otro.
--
-- Devuelve NUMEROS. El formato es responsabilidad del frontend (Intl es-AR):
-- no hay un solo to_char monetario en este archivo.
CREATE OR REPLACE FUNCTION public.get_finance_charts_l1(
  p_business_id  uuid,
  p_period_start date,
  p_period_end   date,
  p_granularity  text DEFAULT 'auto'
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_days      int;
  v_gran      text;
  v_cmp_start date;
  v_cmp_end   date;
  v_out       jsonb;
BEGIN
  IF p_business_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_params');
  END IF;
  IF p_period_end < p_period_start THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_period');
  END IF;

  v_days := (p_period_end - p_period_start) + 1;

  -- ── Granularidad (§5) ────────────────────────────────────────────────────
  v_gran := CASE
    WHEN p_granularity IN ('day', 'week', 'month') THEN p_granularity
    WHEN v_days <= 31  THEN 'day'
    WHEN v_days <= 120 THEN 'week'
    ELSE 'month'
  END;

  -- ── Periodo de comparacion: MISMA duracion, inmediatamente anterior (§4) ──
  v_cmp_end   := p_period_start - 1;
  v_cmp_start := v_cmp_end - (v_days - 1);

  WITH
  -- ══ P&L del periodo, por dia (fuente canonica devengada) ══
  pnl AS (
    SELECT
      p.period_date,
      p.net_sales,
      p.cogs,
      (p.payment_fees + p.operating_expenses + p.employee_salaries) AS operating_expenses,
      p.gross_profit,
      p.operating_result
    FROM public.v_finance_pnl p
    WHERE p.business_id = p_business_id
      AND p.period_date BETWEEN p_period_start AND p_period_end
  ),
  pnl_prev AS (
    SELECT
      p.net_sales, p.cogs,
      (p.payment_fees + p.operating_expenses + p.employee_salaries) AS operating_expenses,
      p.gross_profit, p.operating_result
    FROM public.v_finance_pnl p
    WHERE p.business_id = p_business_id
      AND p.period_date BETWEEN v_cmp_start AND v_cmp_end
  ),
  -- ══ Cobros del periodo (append-only, compensa anulaciones) ══
  coll AS (
    SELECT c.period_date, c.payment_method, c.amount_ars, c.comprobante_payment_id, c.event_type
    FROM public.v_finance_collections_ledger c
    WHERE c.business_id = p_business_id
      AND c.period_date BETWEEN p_period_start AND p_period_end
  ),
  coll_prev AS (
    SELECT round(COALESCE(sum(c.amount_ars), 0), 2) AS total
    FROM public.v_finance_collections_ledger c
    WHERE c.business_id = p_business_id
      AND c.period_date BETWEEN v_cmp_start AND v_cmp_end
  ),
  -- ══ Bucketizacion comun a las dos series temporales ══
  buckets AS (
    -- g.d es timestamptz; se castea a date para que el bucket viaje al frontend
    -- como '2026-08-01' y no como un instante con offset (que ademas se
    -- reinterpretaria en la zona del navegador).
    SELECT
      CASE v_gran
        WHEN 'day'   THEN g.d::date
        WHEN 'week'  THEN date_trunc('week',  g.d)::date
        ELSE              date_trunc('month', g.d)::date
      END AS bucket,
      g.d::date AS d
    FROM generate_series(p_period_start, p_period_end, interval '1 day') AS g(d)
  ),
  pnl_bucketed AS (
    SELECT
      b.bucket,
      round(COALESCE(sum(p.net_sales), 0), 2)          AS net_sales,
      round(COALESCE(sum(p.cogs), 0), 2)               AS cogs,
      round(COALESCE(sum(p.operating_expenses), 0), 2) AS operating_expenses,
      round(COALESCE(sum(p.operating_result), 0), 2)   AS operating_result
    FROM buckets b
    LEFT JOIN pnl p ON p.period_date = b.d
    GROUP BY b.bucket
  ),
  bvc_bucketed AS (
    SELECT
      b.bucket,
      round(COALESCE(sum(p.net_sales), 0), 2) AS billed,
      round(COALESCE(sum(c.amt), 0), 2)       AS collected
    FROM buckets b
    LEFT JOIN pnl p ON p.period_date = b.d
    LEFT JOIN (SELECT period_date, sum(amount_ars) AS amt FROM coll GROUP BY 1) c
           ON c.period_date = b.d
    GROUP BY b.bucket
  ),
  -- ══ Medios de cobro ══
  mix AS (
    SELECT
      c.payment_method AS method,
      round(sum(c.amount_ars), 2)                                              AS amount,
      count(DISTINCT c.comprobante_payment_id) FILTER (WHERE c.event_type = 'collection') AS operations
    FROM coll c
    GROUP BY c.payment_method
    HAVING round(sum(c.amount_ars), 2) <> 0
  ),
  -- ══ Aging: estado ACTUAL, no del periodo (por definicion) ══
  rec AS (
    SELECT r.bucket, r.amount, r.comprobantes AS documents
    FROM public.v_finance_receivables_aging r
    WHERE r.business_id = p_business_id
  ),
  pay AS (
    SELECT a.bucket, a.amount, a.purchases AS documents
    FROM public.v_finance_payables_aging a
    WHERE a.business_id = p_business_id
  ),
  -- ══ Vencimientos reales: NUNCA mezclados con el aging (§12) ══
  due AS (
    SELECT
      round(COALESCE(sum(d.pending_amount) FILTER (WHERE d.due_status = 'due_soon'), 0), 2) AS due_soon_amount,
      round(COALESCE(sum(d.pending_amount) FILTER (WHERE d.due_status = 'overdue'),  0), 2) AS overdue_amount,
      round(COALESCE(sum(d.pending_amount) FILTER (WHERE d.due_status = 'undated'),  0), 2) AS undated_amount,
      count(*) FILTER (WHERE d.due_status = 'undated')                                      AS undated_count,
      count(*) FILTER (WHERE d.due_date IS NOT NULL)                                        AS dated_count
    FROM public.v_finance_payables_due d
    WHERE d.business_id = p_business_id
  ),
  -- ══ Capital en stock (estado actual) ══
  cap AS (
    SELECT * FROM public.v_finance_inventory_capital c WHERE c.business_id = p_business_id
  ),
  -- ══ Flujos de inventario del periodo ══
  flows AS (
    SELECT
      f.flow_kind,
      sum(f.gross_units)      AS gross_units,
      sum(f.net_units)        AS net_units,
      sum(f.movements)        AS movements,
      sum(f.movements_costed) AS movements_costed,
      sum(f.cost_amount_ars)  AS cost_amount_ars
    FROM public.v_finance_inventory_flows f
    WHERE f.business_id = p_business_id
      AND f.movement_date_ar BETWEEN p_period_start AND p_period_end
    GROUP BY f.flow_kind
  ),
  -- ══ Retiros del propietario: FUERA del P&L, informados aparte (§9) ══
  own AS (
    SELECT round(COALESCE(sum(o.amount), 0), 2) AS withdrawals
    FROM public.v_owner_flows o
    WHERE o.business_id = p_business_id
      AND o.flow_type = 'withdrawal' AND o.status = 'completed'
      AND o.date BETWEEN p_period_start AND p_period_end
  ),
  -- ══ Totales ══
  tot AS (
    SELECT
      round(COALESCE(sum(net_sales), 0), 2)          AS net_sales,
      round(COALESCE(sum(cogs), 0), 2)               AS cogs,
      round(COALESCE(sum(operating_expenses), 0), 2) AS operating_expenses,
      round(COALESCE(sum(gross_profit), 0), 2)       AS gross_profit,
      round(COALESCE(sum(operating_result), 0), 2)   AS operating_result
    FROM pnl
  ),
  tot_prev AS (
    SELECT
      round(COALESCE(sum(net_sales), 0), 2)          AS net_sales,
      round(COALESCE(sum(cogs), 0), 2)               AS cogs,
      round(COALESCE(sum(operating_expenses), 0), 2) AS operating_expenses,
      round(COALESCE(sum(gross_profit), 0), 2)       AS gross_profit,
      round(COALESCE(sum(operating_result), 0), 2)   AS operating_result,
      count(*)                                       AS rows_found
    FROM pnl_prev
  )
  SELECT jsonb_build_object(
    'ok', true,
    'calculation_version', 'charts_l1_v1',
    'period', jsonb_build_object(
      'start', p_period_start, 'end', p_period_end,
      'days', v_days, 'granularity', v_gran,
      'timezone', 'America/Argentina/Cordoba'),
    'comparison_period', jsonb_build_object(
      'start', v_cmp_start, 'end', v_cmp_end, 'days', v_days),

    -- ── KPI del periodo ──
    'summary', (SELECT jsonb_build_object(
        'net_sales', t.net_sales,
        'cogs', t.cogs,
        'operating_expenses', t.operating_expenses,
        'gross_profit', t.gross_profit,
        'operating_result', t.operating_result,
        -- Margen sobre ventas netas. NULL (no 0) cuando no hay base.
        'margin_pct', CASE WHEN t.net_sales > 0
                           THEN round(t.operating_result / t.net_sales * 100, 2)
                           ELSE NULL END,
        'collections', (SELECT round(COALESCE(sum(amount_ars), 0), 2) FROM coll),
        'owner_withdrawals', (SELECT withdrawals FROM own)
      ) FROM tot t),

    -- ── Comparacion: mismo largo, inmediatamente anterior ──
    'comparison', (SELECT jsonb_build_object(
        'available', (tp.rows_found > 0),
        'net_sales', tp.net_sales,
        'cogs', tp.cogs,
        'operating_expenses', tp.operating_expenses,
        'gross_profit', tp.gross_profit,
        'operating_result', tp.operating_result,
        'margin_pct', CASE WHEN tp.net_sales > 0
                           THEN round(tp.operating_result / tp.net_sales * 100, 2)
                           ELSE NULL END,
        'collections', (SELECT total FROM coll_prev)
      ) FROM tot_prev tp),

    -- ── Series ──
    'pnl_series', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'bucket', bucket, 'net_sales', net_sales, 'cogs', cogs,
        'operating_expenses', operating_expenses, 'operating_result', operating_result)
        ORDER BY bucket) FROM pnl_bucketed), '[]'::jsonb),

    'billing_vs_collections', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'bucket', bucket, 'billed', billed, 'collected', collected)
        ORDER BY bucket) FROM bvc_bucketed), '[]'::jsonb),

    'payment_mix', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'method', method, 'amount', amount, 'operations', operations)
        ORDER BY amount DESC) FROM mix), '[]'::jsonb),

    -- ── Cartera (estado actual) ──
    'receivables_aging', jsonb_build_object(
      'total', (SELECT round(COALESCE(sum(amount), 0), 2) FROM rec),
      'documents', (SELECT COALESCE(sum(documents), 0) FROM rec),
      'buckets', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'bucket', bucket, 'amount', amount, 'documents', documents)
          ORDER BY bucket) FROM rec), '[]'::jsonb)),

    'payables_aging', jsonb_build_object(
      'total', (SELECT round(COALESCE(sum(amount), 0), 2) FROM pay),
      'documents', (SELECT COALESCE(sum(documents), 0) FROM pay),
      'buckets', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'bucket', bucket, 'amount', amount, 'documents', documents)
          ORDER BY bucket) FROM pay), '[]'::jsonb)),

    -- Vencimientos: superficie SEPARADA del aging, a proposito.
    'payables_due', (SELECT jsonb_build_object(
        'due_soon_amount', d.due_soon_amount,
        'overdue_amount', d.overdue_amount,
        'undated_amount', d.undated_amount,
        'undated_count', d.undated_count,
        'has_due_dates', (d.dated_count > 0)
      ) FROM due d),

    -- ── Capital en stock ──
    'inventory_capital', COALESCE((SELECT jsonb_build_object(
        'inventory_at_cost', c.inventory_at_cost,
        'inventory_at_cost_valued', c.inventory_at_cost_valued,
        'products_total', c.products_total,
        'products_valued', c.products_valued,
        'products_missing_cost', c.products_missing_cost,
        'units_missing_cost', c.units_missing_cost,
        'products_negative_stock', c.products_negative_stock,
        'coverage_pct', CASE WHEN c.products_total > 0
                             THEN round(c.products_valued::numeric / c.products_total * 100, 2)
                             ELSE NULL END,
        'usd_based_products', c.usd_based_products,
        'usd_rate_min_applied', c.usd_rate_min_applied,
        'usd_rate_max_applied', c.usd_rate_max_applied,
        -- Se declara explicitamente que NO hay serie historica legitima.
        'history_available', false,
        'history_blocked_reason', 'no_historical_cost_basis'
      ) FROM cap c), jsonb_build_object(
        'inventory_at_cost', 0, 'inventory_at_cost_valued', 0,
        'products_total', 0, 'products_valued', 0, 'products_missing_cost', 0,
        'units_missing_cost', 0, 'products_negative_stock', 0,
        'coverage_pct', NULL, 'usd_based_products', 0,
        'usd_rate_min_applied', NULL, 'usd_rate_max_applied', NULL,
        'history_available', false,
        'history_blocked_reason', 'no_historical_cost_basis')),

    -- ── Flujos de inventario del periodo + indice de reposicion ──
    'inventory_flows', (
      WITH agg AS (
        SELECT
          COALESCE((SELECT cost_amount_ars  FROM flows WHERE flow_kind = 'purchase'), 0)        AS purchases_cost,
          COALESCE((SELECT gross_units      FROM flows WHERE flow_kind = 'purchase'), 0)        AS purchases_units,
          COALESCE((SELECT movements        FROM flows WHERE flow_kind = 'purchase'), 0)        AS purchases_movements,
          COALESCE((SELECT movements_costed FROM flows WHERE flow_kind = 'purchase'), 0)        AS purchases_movements_costed,
          COALESCE((SELECT gross_units      FROM flows WHERE flow_kind = 'return_in'), 0)       AS returns_units,
          COALESCE((SELECT cost_amount_ars  FROM flows WHERE flow_kind = 'return_in'), 0)       AS returns_cost,
          COALESCE((SELECT gross_units      FROM flows WHERE flow_kind = 'adjustment'), 0)      AS adjustments_units,
          COALESCE((SELECT net_units        FROM flows WHERE flow_kind = 'adjustment'), 0)      AS adjustments_net_units,
          COALESCE((SELECT cost_amount_ars  FROM flows WHERE flow_kind = 'adjustment'), 0)      AS adjustments_cost,
          COALESCE((SELECT gross_units      FROM flows WHERE flow_kind = 'cancellation_in'), 0) AS cancellations_units,
          COALESCE((SELECT sum(gross_units) FROM flows
                     WHERE flow_kind IN ('sale_out','order_out','credit_note_out','other_out')), 0) AS consumption_units,
          COALESCE((SELECT sum(movements) FROM flows
                     WHERE flow_kind IN ('sale_out','order_out')), 0)                           AS consumption_movements,
          COALESCE((SELECT sum(movements_costed) FROM flows
                     WHERE flow_kind IN ('sale_out','order_out')), 0)                           AS consumption_movements_costed,
          -- CONSUMO A COSTO: viene del COGS devengado, no de los movimientos.
          (SELECT cogs FROM tot)                                                                AS consumption_cost
      )
      SELECT jsonb_build_object(
        'purchases_cost', a.purchases_cost,
        'purchases_units', a.purchases_units,
        'purchases_movements', a.purchases_movements,
        'purchases_movements_costed', a.purchases_movements_costed,
        'consumption_cost', a.consumption_cost,
        'consumption_units', a.consumption_units,
        'consumption_movements_uncosted', (a.consumption_movements - a.consumption_movements_costed),
        'returns_units', a.returns_units,
        'returns_cost', a.returns_cost,
        'adjustments_units', a.adjustments_units,
        'adjustments_net_units', a.adjustments_net_units,
        'adjustments_cost', a.adjustments_cost,
        'cancellations_units', a.cancellations_units,
        -- Indice de reposicion (§16). Sin consumo NO hay Infinity: hay NULL y
        -- un motivo. Ajustes, devoluciones, cancelaciones y FX NO entran en el
        -- numerador; correcciones administrativas NO entran en el denominador.
        'replenishment_pct', CASE WHEN a.consumption_cost > 0
                                  THEN round(a.purchases_cost / a.consumption_cost * 100, 2)
                                  ELSE NULL END,
        'replenishment_basis', CASE WHEN a.consumption_cost > 0 THEN 'comparable'
                                    ELSE 'no_comparable_consumption' END,
        'consumption_source', 'accrued_cogs',
        'purchases_source', 'inventory_movements_snapshot_cost',
        -- El puente contable queda bloqueado: las bases no son homogeneas.
        'bridge_available', false,
        'bridge_blocked_reason', 'heterogeneous_cost_basis'
      ) FROM agg a),

    -- ── Waterfall: ingresos -> COGS -> margen bruto -> gastos -> resultado ──
    -- Se emiten VALORES, no etiquetas: el idioma vive en React.
    'waterfall', (SELECT jsonb_build_array(
        jsonb_build_object('key', 'net_sales',          'value', t.net_sales,           'kind', 'start'),
        jsonb_build_object('key', 'cogs',               'value', -t.cogs,               'kind', 'delta'),
        jsonb_build_object('key', 'gross_profit',       'value', t.gross_profit,        'kind', 'subtotal'),
        jsonb_build_object('key', 'operating_expenses', 'value', -t.operating_expenses, 'kind', 'delta'),
        jsonb_build_object('key', 'operating_result',   'value', t.operating_result,    'kind', 'total')
      ) FROM tot t)
  ) INTO v_out;

  RETURN v_out;
END
$fn$;

COMMENT ON FUNCTION public.get_finance_charts_l1(uuid, date, date, text) IS
  'Charts L1 — payload unico de las visualizaciones financieras de un periodo. '
  'SECURITY INVOKER: la RLS de las vistas canonicas alcanza. Devuelve NUMEROS; '
  'el formato es-AR es responsabilidad del frontend. No aplica tipo de cambio. '
  'inventory_capital.history_available=false e inventory_flows.bridge_available=false '
  'declaran de forma explicita las dos metricas bloqueadas por falta de base '
  'historica homogenea (ver docs/auditoria-finanzas/charts-l1/).';

REVOKE ALL     ON FUNCTION public.get_finance_charts_l1(uuid, date, date, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_finance_charts_l1(uuid, date, date, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_finance_charts_l1(uuid, date, date, text) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.get_finance_charts_l1(uuid, date, date, text) TO service_role;

-- ============================================================================
-- 5. POSTCONDICIONES
-- ============================================================================
DO $post$
DECLARE
  v_b    record;
  v_view text;
BEGIN
  SELECT * INTO v_b FROM _l1_baseline;

  -- R1. Las 3 vistas existen y son security_invoker.
  FOREACH v_view IN ARRAY ARRAY[
    'public.v_finance_inventory_capital',
    'public.v_finance_inventory_flows',
    'public.v_finance_collections_ledger'
  ] LOOP
    IF to_regclass(v_view) IS NULL THEN
      RAISE EXCEPTION 'POSTCONDICION R1a: no se creo %', v_view;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                    WHERE c.oid = v_view::regclass
                      AND c.reloptions @> ARRAY['security_invoker=true']) THEN
      RAISE EXCEPTION 'POSTCONDICION R1b: % no quedo security_invoker', v_view;
    END IF;
    -- R2. anon no lee ninguna.
    IF has_table_privilege('anon', v_view, 'SELECT') THEN
      RAISE EXCEPTION 'POSTCONDICION R2: anon puede leer %', v_view;
    END IF;
    -- R3. Son de SOLO lectura para authenticated.
    IF has_table_privilege('authenticated', v_view, 'INSERT')
    OR has_table_privilege('authenticated', v_view, 'UPDATE')
    OR has_table_privilege('authenticated', v_view, 'DELETE') THEN
      RAISE EXCEPTION 'POSTCONDICION R3: % no quedo de solo lectura', v_view;
    END IF;
  END LOOP;

  -- R4. La RPC existe, NO es SECURITY DEFINER y anon no la ejecuta.
  IF to_regprocedure('public.get_finance_charts_l1(uuid,date,date,text)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICION R4a: no se creo get_finance_charts_l1';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc
              WHERE oid = 'public.get_finance_charts_l1(uuid,date,date,text)'::regprocedure
                AND prosecdef) THEN
    RAISE EXCEPTION 'POSTCONDICION R4b: get_finance_charts_l1 quedo SECURITY DEFINER sin necesidad';
  END IF;
  IF has_function_privilege('anon',
       'public.get_finance_charts_l1(uuid,date,date,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION R4c: anon puede ejecutar get_finance_charts_l1';
  END IF;
  IF has_function_privilege('public',
       'public.get_finance_charts_l1(uuid,date,date,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION R4d: PUBLIC puede ejecutar get_finance_charts_l1';
  END IF;

  -- R5. CERO DML. Ni una fila tocada por este lote.
  IF (SELECT count(*) FROM public.inventory) <> v_b.inv_rows
  OR (SELECT COALESCE(sum(stock_quantity),0) FROM public.inventory) <> v_b.inv_units
  OR (SELECT COALESCE(sum(cost_price),0) FROM public.inventory) <> v_b.inv_cost THEN
    RAISE EXCEPTION 'POSTCONDICION R5a: cambio inventory';
  END IF;
  IF (SELECT count(*) FROM public.inventory_movements) <> v_b.mov_rows THEN
    RAISE EXCEPTION 'POSTCONDICION R5b: cambio inventory_movements';
  END IF;
  IF (SELECT count(*) FROM public.comprobante_payments) <> v_b.pay_rows
  OR (SELECT COALESCE(sum(amount_ars),0) FROM public.comprobante_payments) <> v_b.pay_amount THEN
    RAISE EXCEPTION 'POSTCONDICION R5c: cambiaron importes de cobros';
  END IF;
  IF (SELECT count(*) FROM public.inventory_valuation_history) <> v_b.ivh_rows THEN
    RAISE EXCEPTION 'POSTCONDICION R5d: se escribio inventory_valuation_history (backfill prohibido)';
  END IF;

  -- R6. Las superficies canonicas preexistentes siguen intactas.
  FOREACH v_view IN ARRAY ARRAY[
    'public.v_finance_pnl', 'public.v_finance_cashflow', 'public.v_finance_position',
    'public.v_finance_receivables_aging', 'public.v_finance_payables_aging',
    'public.v_finance_payables_due', 'public.v_finance_sales_ledger'
  ] LOOP
    IF to_regclass(v_view) IS NULL THEN
      RAISE EXCEPTION 'POSTCONDICION R6: se perdio %', v_view;
    END IF;
  END LOOP;

  -- R7. No se creo ninguna materialized view en este lote.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_matviews
              WHERE schemaname = 'public' AND matviewname LIKE '%charts_l1%') THEN
    RAISE EXCEPTION 'POSTCONDICION R7: aparecio una materialized view';
  END IF;

  RAISE NOTICE 'Charts L1 OK — 3 vistas + 1 RPC de lectura, cero DML, anon sin acceso.';
END
$post$;

DROP TABLE IF EXISTS _l1_baseline;

COMMIT;

-- PostgREST cachea el esquema: sin recarga, la RPC nueva responde 404 PGRST202.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- ROLLBACK (documentado)
--   DROP FUNCTION IF EXISTS public.get_finance_charts_l1(uuid,date,date,text);
--   DROP VIEW IF EXISTS public.v_finance_collections_ledger;
--   DROP VIEW IF EXISTS public.v_finance_inventory_flows;
--   DROP VIEW IF EXISTS public.v_finance_inventory_capital;
-- Es seguro: todo el lote es aditivo y de solo lectura. Nadie fuera de Charts L1
-- depende de estas superficies, y ninguna fila de datos fue creada ni alterada.
-- ============================================================================
