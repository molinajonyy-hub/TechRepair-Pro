-- ============================================================================
-- P1-D — Contexto de compras a proveedores para la reposicion registrada.
--
-- ── EL PROBLEMA (de producto, no de calculo) ───────────────────────────────
-- La reposicion de Charts L1 es, y sigue siendo:
--
--     compras registradas como ENTRADAS DE INVENTARIO a costo snapshot
--     ------------------------------------------------------------------
--                      COGS devengado comparable
--
-- Esa formula NO se toca. El problema es de lectura: un negocio puede tener
-- compras a proveedores cargadas y ninguna entrada de inventario registrada. La
-- UI entonces dice 0 %, que es correcto respecto del inventario registrado pero
-- se lee como "no compre mercaderia".
--
-- Medido en produccion 2026-08-10, ultimos 30 dias: el negocio aa930802… tiene
-- COGS devengado 2.092.342,65 y CERO movimientos de inventario de tipo compra.
-- Hoy muestra 0 % sin ninguna explicacion.
--
-- ── POR QUE HACE FALTA EXTENDER EL CONTRATO ────────────────────────────────
-- Se reviso primero si el payload de 218 ya traia una senal suficiente. No la
-- trae:
--   · payables_aging  — lee supplier_purchases WHERE pending_amount > 0.01: solo
--     ve deuda VIVA, no compras. Una compra pagada al contado no aparece nunca.
--   · payables_due    — mismo filtro, ademas de payment_status <> 'paid'.
--   · Ninguna de las dos esta acotada al periodo: son estado ACTUAL por
--     definicion (§12 de L1). Usarlas diria "hay compras registradas" apoyandose
--     en una deuda que puede ser de hace meses.
-- Por eso se agrega la senal minima, acotada al periodo, y derivada server-side.
--
-- ── LO QUE ESTA EXTENSION NO HACE (reglas duras) ───────────────────────────
--   · NO cambia la formula de reposicion.
--   · NO suma supplier_purchases al numerador — ni al denominador.
--   · NO afirma que una compra a proveedor sea mercaderia recibida: una compra
--     puede ser un gasto, un servicio o un activo. Por eso los campos se llaman
--     supplier_purchases_* y NUNCA purchases_*, que en este contrato significa
--     ENTRADA DE INVENTARIO.
--   · NO infiere descapitalizacion ni genera alertas.
--   · NO toca M8, ni v_finance_pnl, ni el ledger devengado.
--   · CERO DML. Ni backfill.
--
-- ── ALCANCE ────────────────────────────────────────────────────────────────
--   · 1 vista nueva (security_invoker, solo lectura).
--   · CREATE OR REPLACE de get_finance_charts_l1: mismo cuerpo, mas 3 claves de
--     contexto dentro de inventory_flows. Ninguna clave existente cambia de
--     nombre, de tipo ni de valor.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

-- ============================================================================
-- 0. PRECONDICIONES
-- ============================================================================
DO $pre$
BEGIN
  IF to_regclass('public.supplier_purchases') IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION P0: falta public.supplier_purchases';
  END IF;
  IF to_regprocedure('public.get_finance_charts_l1(uuid,date,date,text)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION P1: falta get_finance_charts_l1 (Charts L1, migracion 20260810120000)';
  END IF;
  IF to_regclass('public.v_finance_inventory_flows') IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION P2: falta public.v_finance_inventory_flows';
  END IF;

  -- supplier_purchases DEBE estar bajo RLS: la vista es security_invoker y la
  -- RPC es SECURITY INVOKER, asi que el aislamiento multi-tenant lo da la RLS de
  -- la tabla base. Sin RLS, esta extension filtraria compras de otro negocio.
  IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class
           WHERE oid='public.supplier_purchases'::regclass) THEN
    RAISE EXCEPTION 'PRECONDICION P3: supplier_purchases no tiene RLS activa';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies
                  WHERE schemaname='public' AND tablename='supplier_purchases') THEN
    RAISE EXCEPTION 'PRECONDICION P4: supplier_purchases no tiene ninguna policy';
  END IF;

  -- Las columnas de las que depende la senal.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                  WHERE attrelid='public.supplier_purchases'::regclass
                    AND attname='purchase_date' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PRECONDICION P5: falta supplier_purchases.purchase_date';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                  WHERE attrelid='public.supplier_purchases'::regclass
                    AND attname='total_amount' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PRECONDICION P6: falta supplier_purchases.total_amount';
  END IF;
END
$pre$;

DROP TABLE IF EXISTS _p1d_baseline;
CREATE TEMP TABLE _p1d_baseline AS
SELECT
  (SELECT count(*) FROM public.supplier_purchases)                     AS sp_rows,
  (SELECT COALESCE(sum(total_amount),0) FROM public.supplier_purchases) AS sp_amount,
  (SELECT count(*) FROM public.inventory_movements)                    AS mov_rows,
  (SELECT count(*) FROM public.inventory)                              AS inv_rows;

-- ============================================================================
-- 1. v_finance_supplier_purchases_daily — COMPRAS REGISTRADAS A PROVEEDORES
-- ============================================================================
-- Una fila por (negocio, dia de compra). Es el REGISTRO ADMINISTRATIVO de la
-- compra, no un movimiento de stock.
--
-- DIFERENCIA QUE ESTA VISTA EXISTE PARA MANTENER EXPLICITA:
--   v_finance_inventory_flows(flow_kind='purchase')  = mercaderia que ENTRO al
--     inventario. Es lo unico que puede reponer stock.
--   v_finance_supplier_purchases_daily               = comprobantes de compra
--     cargados. Pueden ser mercaderia, un servicio, un gasto o un activo. El
--     sistema no distingue, y esta vista NO lo adivina.
--
-- A diferencia de v_finance_payables_aging / _due, NO filtra por saldo
-- pendiente: una compra pagada al contado es una compra igual. Ese filtro es
-- justamente lo que hacia inservible al payload existente como senal.
--
-- purchase_date es `date` (sin zona): se usa tal cual. Pasarlo por AT TIME ZONE
-- lo interpretaria como medianoche UTC y lo correria un dia hacia atras, el
-- mismo error que ya se evito en v_finance_collections_ledger.
CREATE OR REPLACE VIEW public.v_finance_supplier_purchases_daily
  WITH (security_invoker = true) AS
SELECT
  sp.business_id,
  sp.purchase_date,
  count(*)                                        AS purchases,
  round(COALESCE(sum(sp.total_amount), 0), 2)     AS amount_ars
FROM public.supplier_purchases sp
GROUP BY sp.business_id, sp.purchase_date;

COMMENT ON VIEW public.v_finance_supplier_purchases_daily IS
  'Charts L1 / P1-D — compras a proveedores REGISTRADAS por (negocio, dia). Es '
  'el comprobante de compra cargado, NO una entrada de inventario: puede '
  'corresponder a mercaderia, a un servicio o a un gasto, y el sistema no lo '
  'distingue. Se usa EXCLUSIVAMENTE como contexto de la reposicion registrada; '
  'jamas como numerador ni denominador de esa metrica. A diferencia de '
  'v_finance_payables_aging no filtra por saldo pendiente: una compra pagada al '
  'contado tambien cuenta.';

REVOKE ALL ON public.v_finance_supplier_purchases_daily FROM PUBLIC;
GRANT SELECT ON public.v_finance_supplier_purchases_daily TO authenticated, service_role;

-- ============================================================================
-- 2. get_finance_charts_l1 — mismo contrato, 3 claves de contexto mas
-- ============================================================================
-- Cambios respecto de 20260810120000, y NADA mas:
--   · CTE `sp` nuevo (compras registradas del periodo).
--   · inventory_flows suma supplier_purchases_count / _amount / _source.
-- Ninguna clave preexistente cambia de nombre, tipo ni valor.
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
  -- ══ P1-D: compras a proveedores REGISTRADAS en el periodo ══
  -- CONTEXTO, no insumo. No entra en ningun calculo de reposicion: solo
  -- permite decir "hay compras cargadas" sin afirmar que fueran mercaderia.
  sp AS (
    SELECT
      COALESCE(sum(s.purchases), 0)::bigint     AS purchases_count,
      round(COALESCE(sum(s.amount_ars), 0), 2)  AS purchases_amount
    FROM public.v_finance_supplier_purchases_daily s
    WHERE s.business_id = p_business_id
      AND s.purchase_date BETWEEN p_period_start AND p_period_end
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
          (SELECT cogs FROM tot)                                                                AS consumption_cost,
          -- P1-D: contexto. NO participa de ningun calculo de abajo.
          (SELECT purchases_count  FROM sp)                                                     AS supplier_purchases_count,
          (SELECT purchases_amount FROM sp)                                                     AS supplier_purchases_amount
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
        -- P1-D: supplier_purchases_* TAMPOCO. La formula es identica a la de
        -- 20260810120000 y este archivo no la modifica.
        'replenishment_pct', CASE WHEN a.consumption_cost > 0
                                  THEN round(a.purchases_cost / a.consumption_cost * 100, 2)
                                  ELSE NULL END,
        'replenishment_basis', CASE WHEN a.consumption_cost > 0 THEN 'comparable'
                                    ELSE 'no_comparable_consumption' END,
        'consumption_source', 'accrued_cogs',
        'purchases_source', 'inventory_movements_snapshot_cost',
        -- ── P1-D: contexto de compras registradas a proveedores ──
        -- Existe para explicar un 0 % sin acusar al usuario de no haber
        -- comprado. NO es reposicion y NO es mercaderia recibida: es el
        -- comprobante de compra cargado, que puede ser un gasto o un servicio.
        'supplier_purchases_count', a.supplier_purchases_count,
        'supplier_purchases_amount', a.supplier_purchases_amount,
        'supplier_purchases_source', 'supplier_purchases_registered',
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
  'historica homogenea (ver docs/auditoria-finanzas/charts-l1/). '
  'inventory_flows.supplier_purchases_* (P1-D) es CONTEXTO: compras a '
  'proveedores registradas en el periodo, que NO son entradas de inventario y '
  'NO participan del indice de reposicion.';

REVOKE ALL     ON FUNCTION public.get_finance_charts_l1(uuid, date, date, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_finance_charts_l1(uuid, date, date, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_finance_charts_l1(uuid, date, date, text) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.get_finance_charts_l1(uuid, date, date, text) TO service_role;

-- ============================================================================
-- 3. POSTCONDICIONES
-- ============================================================================
DO $post$
DECLARE
  v_b    record;
  v_src  text;
  v_clave text;
BEGIN
  SELECT * INTO v_b FROM _p1d_baseline;

  -- R1. La vista nueva existe, es security_invoker y de solo lectura.
  IF to_regclass('public.v_finance_supplier_purchases_daily') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICION R1a: no se creo v_finance_supplier_purchases_daily';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class
                  WHERE oid='public.v_finance_supplier_purchases_daily'::regclass
                    AND reloptions @> ARRAY['security_invoker=true']) THEN
    RAISE EXCEPTION 'POSTCONDICION R1b: la vista nueva no quedo security_invoker';
  END IF;
  IF has_table_privilege('anon', 'public.v_finance_supplier_purchases_daily', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDICION R1c: anon puede leer v_finance_supplier_purchases_daily';
  END IF;
  IF has_table_privilege('authenticated', 'public.v_finance_supplier_purchases_daily', 'INSERT')
  OR has_table_privilege('authenticated', 'public.v_finance_supplier_purchases_daily', 'UPDATE')
  OR has_table_privilege('authenticated', 'public.v_finance_supplier_purchases_daily', 'DELETE') THEN
    RAISE EXCEPTION 'POSTCONDICION R1d: la vista nueva no quedo de solo lectura';
  END IF;

  -- R2. La RPC sigue SECURITY INVOKER y anon/PUBLIC no la ejecutan.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc
              WHERE oid = 'public.get_finance_charts_l1(uuid,date,date,text)'::regprocedure
                AND prosecdef) THEN
    RAISE EXCEPTION 'POSTCONDICION R2a: get_finance_charts_l1 quedo SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon',
       'public.get_finance_charts_l1(uuid,date,date,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION R2b: anon puede ejecutar get_finance_charts_l1';
  END IF;
  IF has_function_privilege('public',
       'public.get_finance_charts_l1(uuid,date,date,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION R2c: PUBLIC puede ejecutar get_finance_charts_l1';
  END IF;

  -- R3. La FORMULA de reposicion es la misma: purchases_cost / consumption_cost.
  -- Y supplier_purchases NO aparece en el numerador ni en el denominador.
  v_src := (SELECT prosrc FROM pg_catalog.pg_proc
             WHERE oid='public.get_finance_charts_l1(uuid,date,date,text)'::regprocedure);
  IF v_src NOT LIKE '%a.purchases_cost / a.consumption_cost%' THEN
    RAISE EXCEPTION 'POSTCONDICION R3a: cambio la formula del indice de reposicion';
  END IF;
  IF v_src ~ 'supplier_purchases_(count|amount)\s*(\+|/|\*)'
  OR v_src ~ '(\+|/|\*)\s*a\.supplier_purchases_(count|amount)' THEN
    RAISE EXCEPTION 'POSTCONDICION R3b: supplier_purchases entro en una operacion aritmetica de la reposicion';
  END IF;

  -- R4. Las claves de contexto existen y son las tres esperadas.
  FOREACH v_clave IN ARRAY ARRAY[
    'supplier_purchases_count', 'supplier_purchases_amount', 'supplier_purchases_source'
  ] LOOP
    IF v_src NOT LIKE '%' || v_clave || '%' THEN
      RAISE EXCEPTION 'POSTCONDICION R4: falta la clave de contexto %', v_clave;
    END IF;
  END LOOP;

  -- R5. CERO DML.
  IF (SELECT count(*) FROM public.supplier_purchases) <> v_b.sp_rows
  OR (SELECT COALESCE(sum(total_amount),0) FROM public.supplier_purchases) <> v_b.sp_amount THEN
    RAISE EXCEPTION 'POSTCONDICION R5a: cambio supplier_purchases';
  END IF;
  IF (SELECT count(*) FROM public.inventory_movements) <> v_b.mov_rows
  OR (SELECT count(*) FROM public.inventory) <> v_b.inv_rows THEN
    RAISE EXCEPTION 'POSTCONDICION R5b: cambio el inventario';
  END IF;

  RAISE NOTICE 'P1-D OK — contexto de compras a proveedores agregado. Formula de reposicion intacta, cero DML.';
END
$post$;

DROP TABLE IF EXISTS _p1d_baseline;

COMMIT;

-- PostgREST cachea el esquema: la RPC cambio de firma logica (claves nuevas).
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado)
--   Reaplicar el cuerpo de get_finance_charts_l1 de
--   20260810120000_finance_charts_l1_contracts.sql (sin el CTE `sp` ni las tres
--   claves supplier_purchases_*), y despues:
--     DROP VIEW IF EXISTS public.v_finance_supplier_purchases_daily;
--   Es seguro: todo el lote es aditivo y de solo lectura. El frontend tolera la
--   ausencia de las claves nuevas (ver financeChartsService: son opcionales).
-- ============================================================================
