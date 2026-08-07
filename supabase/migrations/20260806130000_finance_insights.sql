-- ===========================================================================
-- M8 B - motor determinista de insights financieros
--
-- Traduce las vistas canonicas en alertas accionables. CERO LLM, cero llamadas
-- externas, cero heuristica opaca: cada insight persiste rule_id, rule_version,
-- evidence (los numeros con los que se decidio), umbral, severidad y accion.
-- La UI solo renderiza; no calcula nada financiero.
--
-- PIEZAS
--   * finance_insights                  - tabla canonica (RLS, append-idempotente)
--   * finance_insight_thresholds()      - umbrales v1 centralizados y versionados
--   * generate_finance_insights(...)    - evalua las 10 reglas y persiste
--   * finance_insights_read(...)        - superficie de lectura con orden estable
--
-- IDEMPOTENCIA
-- `fingerprint` = md5(business_id|rule_id|rule_version|period_start|period_end)
-- con UNIQUE. Regenerar el mismo periodo ACTUALIZA la fila; nunca duplica.
-- Una regla que deja de cumplirse pasa a status='resolved' (no se borra).
-- Una regla que vuelve a cumplirse revive la MISMA fila a 'active'.
-- Periodos distintos = fingerprints distintos = historia preservada.
--
-- LO QUE NO HACE
--   * Cero backfill de periodos historicos.
--   * Cero DML sobre datos financieros: solo escribe en finance_insights.
--   * No modifica importes, comprobantes, movimientos, caja ni periodos.
--   * No crea cron, scheduler ni Edge Function. Generacion on-demand.
--   * No implementa graficos ni instala librerias.
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. PRECONDICIONES - el motor no puede existir sin sus fuentes canonicas
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(v, ', ') INTO v_missing FROM (
    SELECT unnest(ARRAY[
      'public.v_finance_pnl','public.v_finance_cashflow','public.v_finance_position',
      'public.v_finance_receivables_aging','public.v_finance_payables_due',
      'public.v_finance_effective_comprobantes','public.v_owner_flows'
    ]) v
  ) t WHERE to_regclass(v) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDICION P0: faltan vistas canonicas: %', v_missing;
  END IF;

  IF to_regproc('public.ar_today') IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION P1: falta public.ar_today()';
  END IF;
  IF to_regproc('public.finance_health_check_v2') IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION P2: falta finance_health_check_v2 (M7 7C)';
  END IF;
  IF to_regclass('public.recurring_expenses') IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION P3: falta recurring_expenses (fuente de gasto fijo)';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. TABLA
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.finance_insights (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  rule_id        text NOT NULL,
  rule_version   text NOT NULL,
  period_start   date NOT NULL,
  period_end     date NOT NULL,
  severity       text NOT NULL,
  title          text NOT NULL,
  message        text NOT NULL,
  evidence       jsonb NOT NULL,
  action         jsonb NOT NULL,
  status         text NOT NULL DEFAULT 'active',
  -- Orden por impacto: monto en ARS que la regla pone en juego. 0 cuando la
  -- regla no es dimensionable en pesos (p. ej. breakeven_day).
  impact_ars     numeric(14,2) NOT NULL DEFAULT 0,
  fingerprint    text NOT NULL,
  generated_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT finance_insights_severity_check
    CHECK (severity IN ('critical','warning','info')),
  CONSTRAINT finance_insights_status_check
    CHECK (status IN ('active','resolved','superseded')),
  CONSTRAINT finance_insights_period_check
    CHECK (period_end >= period_start),
  -- Una regla desconocida no puede entrar: el catalogo es cerrado y es lo que
  -- impide que aparezca una "regla numero 11" sin documentacion.
  CONSTRAINT finance_insights_rule_check
    CHECK (rule_id IN (
      'margin_drop_cost','cash_down_sales_up','dead_stock','withdrawals_vs_profit',
      'fixed_coverage','breakeven_day','supplier_crunch','fx_stale_prices',
      'data_quality','cc_aging')),
  -- Evidence es obligatorio Y verificable: sin estas claves un insight no se
  -- puede auditar, que es justamente lo que M8 promete.
  CONSTRAINT finance_insights_evidence_check
    CHECK (jsonb_typeof(evidence) = 'object'
       AND evidence ? 'metric' AND evidence ? 'threshold'
       AND evidence ? 'source' AND evidence ? 'calculation_version'
       AND evidence ? 'currency' AND evidence ? 'period_start'
       AND evidence ? 'period_end'),
  -- Action tipada: sin esto un insight podria apuntar a una ruta inexistente.
  CONSTRAINT finance_insights_action_check
    CHECK (jsonb_typeof(action) = 'object'
       AND action ? 'label' AND action ? 'target_type' AND action ? 'target'
       AND action->>'target_type' IN ('route','drawer','none')
       AND (
         action->>'target_type' <> 'route'
         OR action->>'target' IN (
           '/finance','/finance/reports','/finance/health','/finance/dashboard',
           '/inventory','/suppliers','/cuentas','/caja','/expenses',
           '/comprobantes','/customers','/currency-settings')
       )
       AND (action->>'target_type' <> 'drawer' OR action->>'target' = 'calculation')),
  CONSTRAINT finance_insights_resolved_check
    CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);

-- Identidad canonica: una sola fila por (negocio, regla, periodo, version).
CREATE UNIQUE INDEX IF NOT EXISTS finance_insights_fingerprint_uidx
  ON public.finance_insights (fingerprint);

-- Lectura del panel: negocio + periodo + estado.
CREATE INDEX IF NOT EXISTS finance_insights_read_idx
  ON public.finance_insights (business_id, period_start, period_end, status);

COMMENT ON TABLE public.finance_insights IS
  'M8 - insights financieros deterministas. Generados server-side por '
  'generate_finance_insights(). El contenido NUNCA se escribe desde el cliente: '
  'authenticated solo tiene SELECT.';

-- ---------------------------------------------------------------------------
-- 2. RLS - anon a cero, authenticated solo lectura del propio negocio
-- ---------------------------------------------------------------------------
ALTER TABLE public.finance_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_insights FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.finance_insights FROM PUBLIC;
REVOKE ALL ON TABLE public.finance_insights FROM anon;
-- Solo SELECT. Sin INSERT/UPDATE/DELETE: el contenido es calculado, no
-- declarado. Sin TRUNCATE: TRUNCATE BYPASSEA RLS y vaciaria todos los negocios.
GRANT SELECT ON TABLE public.finance_insights TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.finance_insights TO service_role;

DROP POLICY IF EXISTS finance_insights_select ON public.finance_insights;
CREATE POLICY finance_insights_select ON public.finance_insights
  FOR SELECT TO authenticated
  USING (business_id = public.current_business_id());

-- ---------------------------------------------------------------------------
-- 3. UMBRALES v1 - fuente unica, versionada, visible en evidence
-- ---------------------------------------------------------------------------
-- IMMUTABLE y sin parametros: los umbrales no son configurables por el usuario
-- en este lote. Cambiarlos exige una migracion nueva y un rule_version nuevo.
CREATE OR REPLACE FUNCTION public.finance_insight_thresholds()
RETURNS jsonb LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'version', 'v1',
    'margin_drop_cost',      jsonb_build_object('margin_drop_pp', 3.0, 'cogs_rise_pp', 1.0),
    'cash_down_sales_up',    jsonb_build_object('sales_up_pct', 10.0, 'cash_down_pct', -5.0),
    'dead_stock',            jsonb_build_object('days', 90, 'share', 0.20, 'min_products', 5),
    'withdrawals_vs_profit', jsonb_build_object('window_days', 90, 'share', 0.70),
    'fixed_coverage',        jsonb_build_object('months_warning', 1.0, 'months_critical', 0.5),
    'breakeven_day',         jsonb_build_object('min_days_observed', 10, 'max_projection_days', 120),
    'supplier_crunch',       jsonb_build_object('horizon_days', 14, 'min_material_ars', 50000.0,
                                                'coverage_warning', 1.5),
    'fx_stale_prices',       jsonb_build_object('rate_diff_pct', 2.0, 'share', 0.10,
                                                'max_rate_age_days', 7),
    'data_quality',          jsonb_build_object('critical_count_min', 1),
    'cc_aging',              jsonb_build_object('days', 30, 'share', 0.30, 'concentration_share', 0.60)
  );
$$;

REVOKE ALL ON FUNCTION public.finance_insight_thresholds() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finance_insight_thresholds() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. GENERACION
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER es NECESARIO: authenticated no tiene (ni debe tener) INSERT
-- sobre finance_insights - si lo tuviera podria fabricar un insight con
-- evidence inventada. Al ser DEFINER, la RLS del llamador NO aplica, asi que
-- CADA consulta filtra explicitamente por v_biz. No se confia en RLS aca.
--
-- search_path SIN 'public': todas las referencias van calificadas. pg_temp va
-- ULTIMO a proposito: si se omite, Postgres lo busca PRIMERO y una tabla
-- temporal puede secuestrar una referencia.
CREATE OR REPLACE FUNCTION public.generate_finance_insights(
  p_business_id uuid,
  p_period_start date,
  p_period_end date
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_t0        timestamptz := clock_timestamp();
  v_actor     uuid := auth.uid();
  v_biz       uuid := p_business_id;
  v_access    boolean := false;
  v_ver       text := 'v1';
  v_th        jsonb := public.finance_insight_thresholds();
  v_today     date := public.ar_today();
  v_len       integer;
  v_cmp_start date;
  v_cmp_end   date;
  v_fired     jsonb := '[]'::jsonb;
  v_skipped   jsonb := '[]'::jsonb;
  v_keep      text[] := ARRAY[]::text[];

  v_ns_cur numeric; v_ns_prev numeric; v_gp_cur numeric; v_gp_prev numeric;
  v_cogs_cur numeric; v_cogs_prev numeric;
  v_cash_cur numeric; v_cash_prev numeric; v_ar_delta numeric;
  v_liquidity numeric;
BEGIN
  -- Autenticacion y pertenencia (no delegable a RLS: somos DEFINER)
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No autenticado');
  END IF;
  IF v_biz IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'business_id requerido');
  END IF;
  SELECT (EXISTS (SELECT 1 FROM public.businesses WHERE id = v_biz AND owner_user_id = v_actor)
       OR EXISTS (SELECT 1 FROM public.profiles WHERE business_id = v_biz
                    AND COALESCE(user_id, id) = v_actor AND COALESCE(is_active, true)))
    INTO v_access;
  IF NOT v_access THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio');
  END IF;

  -- Validacion de periodo
  IF p_period_start IS NULL OR p_period_end IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Periodo requerido');
  END IF;
  IF p_period_end < p_period_start THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Periodo invalido');
  END IF;
  v_len := (p_period_end - p_period_start) + 1;
  IF v_len > 366 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Periodo demasiado largo (max 366 dias)');
  END IF;
  IF p_period_start > v_today THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Periodo en el futuro');
  END IF;

  v_cmp_end   := p_period_start - 1;
  v_cmp_start := v_cmp_end - (v_len - 1);

  -- Serializacion: dos pestanias generando el mismo periodo no pueden pisarse.
  -- El lock se libera solo al terminar la transaccion.
  PERFORM pg_advisory_xact_lock(
    hashtext('finance_insights:' || v_biz::text || ':' || p_period_start::text
             || ':' || p_period_end::text || ':' || v_ver));

  -- =========================================================================
  -- METRICAS BASE (una sola pasada por fuente; sin N+1)
  -- =========================================================================
  SELECT COALESCE(SUM(net_sales),0), COALESCE(SUM(gross_profit),0), COALESCE(SUM(cogs),0)
    INTO v_ns_cur, v_gp_cur, v_cogs_cur
    FROM public.v_finance_pnl
   WHERE business_id = v_biz AND period_date BETWEEN p_period_start AND p_period_end;

  SELECT COALESCE(SUM(net_sales),0), COALESCE(SUM(gross_profit),0), COALESCE(SUM(cogs),0)
    INTO v_ns_prev, v_gp_prev, v_cogs_prev
    FROM public.v_finance_pnl
   WHERE business_id = v_biz AND period_date BETWEEN v_cmp_start AND v_cmp_end;

  -- Caja OPERATIVA: se excluyen capital (retiros/aportes del duenio), supplier,
  -- adjustment y reversal. Incluirlos haria que un retiro se leyera como "cayo
  -- la caja", que es falso.
  SELECT COALESCE(SUM(net_ars),0) INTO v_cash_cur
    FROM public.v_finance_cashflow
   WHERE business_id = v_biz AND cashflow_class = 'operating' AND is_reversal = false
     AND movement_date_ar BETWEEN p_period_start AND p_period_end;

  SELECT COALESCE(SUM(net_ars),0) INTO v_cash_prev
    FROM public.v_finance_cashflow
   WHERE business_id = v_biz AND cashflow_class = 'operating' AND is_reversal = false
     AND movement_date_ar BETWEEN v_cmp_start AND v_cmp_end;

  SELECT COALESCE(SUM(c.saldo_pendiente),0) INTO v_ar_delta
    FROM public.comprobantes c
    JOIN public.v_finance_effective_comprobantes e
      ON e.id = c.id AND e.is_credit_note = false
   WHERE c.business_id = v_biz AND e.period_date BETWEEN p_period_start AND p_period_end
     AND c.saldo_pendiente > 0.01 AND c.customer_id IS NOT NULL;

  SELECT COALESCE(cash_total,0) INTO v_liquidity
    FROM public.v_finance_position WHERE business_id = v_biz;
  v_liquidity := COALESCE(v_liquidity, 0);

  -- =========================================================================
  -- R1. margin_drop_cost
  -- =========================================================================
  IF v_ns_cur <= 0 OR v_ns_prev <= 0 THEN
    v_skipped := v_skipped || jsonb_build_object('rule_id','margin_drop_cost','reason','no_sales_in_one_period');
  ELSE
    DECLARE
      m_cur numeric := ROUND(v_gp_cur / NULLIF(v_ns_cur,0) * 100, 2);
      m_prv numeric := ROUND(v_gp_prev / NULLIF(v_ns_prev,0) * 100, 2);
      c_cur numeric := ROUND(v_cogs_cur / NULLIF(v_ns_cur,0) * 100, 2);
      c_prv numeric := ROUND(v_cogs_prev / NULLIF(v_ns_prev,0) * 100, 2);
    BEGIN
      IF (m_cur - m_prv) <= -(v_th->'margin_drop_cost'->>'margin_drop_pp')::numeric
         AND (c_cur - c_prv) >= (v_th->'margin_drop_cost'->>'cogs_rise_pp')::numeric THEN
        v_fired := v_fired || jsonb_build_object(
          'rule_id','margin_drop_cost','severity','warning',
          'title','El margen bajó por aumento de costo',
          'message', format('Tu margen bruto pasó de %s%% a %s%%. No es por vender menos: el costo de mercadería subió de %s%% a %s%% de cada venta.',
                            m_prv, m_cur, c_prv, c_cur),
          'impact_ars', ROUND(ABS(m_cur - m_prv) / 100 * v_ns_cur, 2),
          'evidence', jsonb_build_object(
            'metric','gross_margin_pct','current_value',m_cur,'comparison_value',m_prv,
            'delta', ROUND(m_cur - m_prv, 2), 'delta_percent', NULL,
            'cogs_ratio_current', c_cur, 'cogs_ratio_previous', c_prv,
            'net_sales_current', v_ns_cur, 'net_sales_previous', v_ns_prev,
            'threshold', v_th->'margin_drop_cost',
            'period_start', p_period_start, 'period_end', p_period_end,
            'comparison_period_start', v_cmp_start, 'comparison_period_end', v_cmp_end,
            'sample_size', v_len, 'currency','ARS','source','v_finance_pnl',
            'calculation_version', v_ver),
          'action', jsonb_build_object('label','Ver cálculo','target_type','drawer','target','calculation','params', jsonb_build_object()));
      END IF;
    END;
  END IF;

  -- =========================================================================
  -- R2. cash_down_sales_up
  -- =========================================================================
  IF v_ns_prev <= 0 OR v_cash_prev = 0 THEN
    v_skipped := v_skipped || jsonb_build_object('rule_id','cash_down_sales_up','reason','no_comparison_base');
  ELSE
    DECLARE
      s_delta numeric := ROUND((v_ns_cur - v_ns_prev) / NULLIF(ABS(v_ns_prev),0) * 100, 2);
      c_delta numeric := ROUND((v_cash_cur - v_cash_prev) / NULLIF(ABS(v_cash_prev),0) * 100, 2);
    BEGIN
      IF s_delta >= (v_th->'cash_down_sales_up'->>'sales_up_pct')::numeric
         AND c_delta <= (v_th->'cash_down_sales_up'->>'cash_down_pct')::numeric THEN
        v_fired := v_fired || jsonb_build_object(
          'rule_id','cash_down_sales_up','severity','warning',
          'title','La facturación devengada subió, pero los cobros bajaron',
          'message', format('Facturaste %s%% más que el período anterior, pero entró %s%% menos plata. Quedaron %s sin cobrar de las ventas de este período.',
                            s_delta, ABS(c_delta), to_char(v_ar_delta,'FM999G999G999D00')),
          'impact_ars', ROUND(v_ar_delta, 2),
          'evidence', jsonb_build_object(
            'metric','accrued_vs_collected',
            'accrued_revenue', v_ns_cur, 'collected_cash', v_cash_cur,
            'accounts_receivable_delta', v_ar_delta,
            'current_value', v_cash_cur, 'comparison_value', v_cash_prev,
            'delta', ROUND(v_cash_cur - v_cash_prev, 2), 'delta_percent', c_delta,
            'sales_delta_percent', s_delta,
            'accrued_revenue_previous', v_ns_prev,
            'threshold', v_th->'cash_down_sales_up',
            'period_start', p_period_start, 'period_end', p_period_end,
            'comparison_period_start', v_cmp_start, 'comparison_period_end', v_cmp_end,
            'sample_size', v_len, 'currency','ARS',
            'source','v_finance_pnl + v_finance_cashflow',
            'calculation_version', v_ver),
          'action', jsonb_build_object('label','Ver cuentas corrientes','target_type','route','target','/cuentas','params', jsonb_build_object()));
      END IF;
    END;
  END IF;

  -- =========================================================================
  -- R3. dead_stock
  -- Tres fuentes unidas. inventory_movements SOLO no alcanza: existe
  -- repair_missing_stock_movements() porque hubo ventas con
  -- stock_processed=false que nunca escribieron movimiento -> daria falsos
  -- "muertos". Y las lineas de orden nunca llevan inventory_id (P0-A), asi que
  -- el consumo de repuestos solo se ve como movement_type='order_usage'.
  -- =========================================================================
  DECLARE
    v_dead_val numeric := 0; v_tot_val numeric := 0;
    v_dead_cnt bigint := 0;  v_tot_cnt bigint := 0;
    v_days int := (v_th->'dead_stock'->>'days')::int;
  BEGIN
    WITH universe AS (
      SELECT i.id, (i.stock_quantity * COALESCE(i.cost_price,0))::numeric AS val
        FROM public.inventory i
       WHERE i.business_id = v_biz AND i.is_active = true
         AND COALESCE(i.tipo,'product') = 'product'
         AND i.stock_quantity > 0 AND COALESCE(i.cost_price,0) > 0
         AND NOT EXISTS (SELECT 1 FROM public.inventory v
                          WHERE v.business_id = i.business_id
                            AND v.supplier_code = 'VPREF-' || i.id::text)
    ),
    last_sale AS (
      SELECT ci.inventory_id AS iid, MAX(e.period_date) AS d
        FROM public.comprobante_items ci
        JOIN public.v_finance_effective_comprobantes e
          ON e.id = ci.comprobante_id AND e.is_credit_note = false
       WHERE ci.business_id = v_biz AND ci.inventory_id IS NOT NULL
       GROUP BY 1
    ),
    last_mov AS (
      SELECT im.inventory_item_id AS iid,
             MAX((im.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date) AS d
        FROM public.inventory_movements im
       WHERE im.business_id = v_biz
         AND im.movement_type IN ('sale','out','order_usage')
       GROUP BY 1
    )
    SELECT
      COALESCE(SUM(u.val) FILTER (WHERE GREATEST(COALESCE(ls.d,'-infinity'::date),
                                                 COALESCE(lm.d,'-infinity'::date))
                                       < v_today - v_days), 0),
      COALESCE(SUM(u.val), 0),
      COUNT(*) FILTER (WHERE GREATEST(COALESCE(ls.d,'-infinity'::date),
                                      COALESCE(lm.d,'-infinity'::date))
                            < v_today - v_days),
      COUNT(*)
      INTO v_dead_val, v_tot_val, v_dead_cnt, v_tot_cnt
      FROM universe u
      LEFT JOIN last_sale ls ON ls.iid = u.id
      LEFT JOIN last_mov  lm ON lm.iid = u.id;

    IF v_tot_cnt < (v_th->'dead_stock'->>'min_products')::int OR v_tot_val <= 0 THEN
      v_skipped := v_skipped || jsonb_build_object('rule_id','dead_stock','reason','insufficient_inventory');
    ELSIF (v_dead_val / NULLIF(v_tot_val,0)) > (v_th->'dead_stock'->>'share')::numeric THEN
      v_fired := v_fired || jsonb_build_object(
        'rule_id','dead_stock','severity','warning',
        'title','Tenés capital inmovilizado',
        'message', format('%s productos (%s) no registran ventas ni consumo en los últimos %s días. Es el %s%% de tu inventario valorizado.',
                          v_dead_cnt, to_char(v_dead_val,'FM999G999G999D00'), v_days,
                          ROUND(v_dead_val / NULLIF(v_tot_val,0) * 100, 1)),
        'impact_ars', ROUND(v_dead_val, 2),
        'evidence', jsonb_build_object(
          'metric','dead_stock_share',
          'current_value', ROUND(v_dead_val / NULLIF(v_tot_val,0), 4),
          'comparison_value', NULL, 'delta', NULL, 'delta_percent', NULL,
          'dead_value', ROUND(v_dead_val,2), 'inventory_at_cost', ROUND(v_tot_val,2),
          'dead_product_count', v_dead_cnt, 'total_product_count', v_tot_cnt,
          'days_threshold', v_days,
          'threshold', v_th->'dead_stock',
          'period_start', p_period_start, 'period_end', p_period_end,
          'comparison_period_start', NULL, 'comparison_period_end', NULL,
          'sample_size', v_tot_cnt, 'currency','ARS',
          'source','inventory + comprobante_items + inventory_movements',
          'calculation_version', v_ver),
        'action', jsonb_build_object('label','Ver inventario','target_type','route','target','/inventory','params', jsonb_build_object()));
    END IF;
  END;

  -- =========================================================================
  -- R4. withdrawals_vs_profit
  -- =========================================================================
  DECLARE
    v_win int := (v_th->'withdrawals_vs_profit'->>'window_days')::int;
    v_w_start date := p_period_end - (v_win - 1);
    v_res numeric; v_wd numeric;
  BEGIN
    SELECT COALESCE(SUM(operating_result),0) INTO v_res FROM public.v_finance_pnl
     WHERE business_id = v_biz AND period_date BETWEEN v_w_start AND p_period_end;
    SELECT COALESCE(SUM(amount),0) INTO v_wd FROM public.v_owner_flows
     WHERE business_id = v_biz AND flow_type = 'withdrawal' AND status = 'completed'
       AND date BETWEEN v_w_start AND p_period_end;

    IF v_res <= 0 THEN
      v_skipped := v_skipped || jsonb_build_object('rule_id','withdrawals_vs_profit','reason','non_positive_result');
    ELSIF (v_wd / NULLIF(v_res,0)) > (v_th->'withdrawals_vs_profit'->>'share')::numeric THEN
      v_fired := v_fired || jsonb_build_object(
        'rule_id','withdrawals_vs_profit','severity','warning',
        'title','Los retiros superaron la ganancia',
        'message', format('En los últimos %s días retiraste %s, el %s%% del resultado operativo (%s).',
                          v_win, to_char(v_wd,'FM999G999G999D00'),
                          ROUND(v_wd / NULLIF(v_res,0) * 100, 1),
                          to_char(v_res,'FM999G999G999D00')),
        'impact_ars', ROUND(v_wd, 2),
        'evidence', jsonb_build_object(
          'metric','withdrawals_over_result',
          'current_value', ROUND(v_wd / NULLIF(v_res,0), 4),
          'comparison_value', NULL, 'delta', NULL, 'delta_percent', NULL,
          'withdrawals_total', ROUND(v_wd,2), 'operating_result', ROUND(v_res,2),
          'window_days', v_win,
          'threshold', v_th->'withdrawals_vs_profit',
          'period_start', v_w_start, 'period_end', p_period_end,
          'comparison_period_start', NULL, 'comparison_period_end', NULL,
          'sample_size', v_win, 'currency','ARS',
          'source','v_owner_flows + v_finance_pnl',
          'calculation_version', v_ver),
        'action', jsonb_build_object('label','Ver cálculo','target_type','drawer','target','calculation','params', jsonb_build_object()));
    END IF;
  END;

  -- =========================================================================
  -- R5. fixed_coverage
  -- Gasto fijo = recurring_expenses activos. economic_class='operating_expense'
  -- NO sirve: mezcla fijo y variable. Sin recurrentes cargados NO se estima.
  -- =========================================================================
  DECLARE
    v_fixed numeric := 0; v_rec_n bigint := 0; v_unconv bigint := 0;
    v_cov numeric;
  BEGIN
    SELECT COUNT(*),
           COALESCE(SUM(CASE
             WHEN COALESCE(re.currency,'ARS') = 'ARS' THEN re.amount
             ELSE re.amount * COALESCE((SELECT er.rate FROM public.exchange_rates er
                                         WHERE er.business_id = v_biz
                                           AND er.base_currency = 'USD'
                                           AND er.target_currency = 'ARS'
                                         ORDER BY er.updated_at DESC LIMIT 1), 0)
           END), 0),
           COUNT(*) FILTER (WHERE COALESCE(re.currency,'ARS') <> 'ARS'
             AND NOT EXISTS (SELECT 1 FROM public.exchange_rates er
                              WHERE er.business_id = v_biz AND er.base_currency='USD'
                                AND er.target_currency='ARS'))
      INTO v_rec_n, v_fixed, v_unconv
      FROM public.recurring_expenses re
     WHERE re.business_id = v_biz AND re.is_active = true;

    IF v_rec_n = 0 THEN
      v_skipped := v_skipped || jsonb_build_object('rule_id','fixed_coverage','reason','no_recurring_expenses');
    ELSIF v_unconv > 0 OR v_fixed <= 0 THEN
      v_skipped := v_skipped || jsonb_build_object('rule_id','fixed_coverage','reason','missing_exchange_rate');
    ELSE
      v_cov := ROUND(v_liquidity / NULLIF(v_fixed,0), 2);
      IF v_cov < (v_th->'fixed_coverage'->>'months_warning')::numeric THEN
        v_fired := v_fired || jsonb_build_object(
          'rule_id','fixed_coverage',
          'severity', CASE WHEN v_cov < (v_th->'fixed_coverage'->>'months_critical')::numeric
                           THEN 'critical' ELSE 'warning' END,
          'title','Tu caja cubre poco de los gastos recurrentes',
          'message', format('Tu caja cubre %s meses de los gastos recurrentes que cargaste (%s por mes, %s conceptos).',
                            v_cov, to_char(v_fixed,'FM999G999G999D00'), v_rec_n),
          'impact_ars', ROUND(v_fixed, 2),
          'evidence', jsonb_build_object(
            'metric','fixed_coverage_months','current_value', v_cov,
            'comparison_value', NULL, 'delta', NULL, 'delta_percent', NULL,
            'cash_total', ROUND(v_liquidity,2), 'fixed_monthly', ROUND(v_fixed,2),
            'recurring_count', v_rec_n,
            'threshold', v_th->'fixed_coverage',
            'period_start', p_period_start, 'period_end', p_period_end,
            'comparison_period_start', NULL, 'comparison_period_end', NULL,
            'sample_size', v_rec_n, 'currency','ARS',
            'source','recurring_expenses + v_finance_position',
            'calculation_version', v_ver),
          'action', jsonb_build_object('label','Ver gastos','target_type','route','target','/expenses','params', jsonb_build_object()));
      END IF;
    END IF;

    -- =======================================================================
    -- R6. breakeven_day (comparte la definicion de fijo de R5)
    -- =======================================================================
    DECLARE
      v_ms date := date_trunc('month', p_period_end)::date;
      v_obs int := (p_period_end - date_trunc('month', p_period_end)::date) + 1;
      v_cm numeric; v_be_sales numeric; v_be_day date; v_daily numeric;
      v_mtd_sales numeric; v_mtd_gp numeric;
    BEGIN
      SELECT COALESCE(SUM(net_sales),0), COALESCE(SUM(gross_profit),0)
        INTO v_mtd_sales, v_mtd_gp
        FROM public.v_finance_pnl
       WHERE business_id = v_biz AND period_date BETWEEN v_ms AND p_period_end;

      v_cm := CASE WHEN v_mtd_sales > 0 THEN v_mtd_gp / v_mtd_sales ELSE NULL END;

      IF v_rec_n = 0 OR v_fixed <= 0 THEN
        v_skipped := v_skipped || jsonb_build_object('rule_id','breakeven_day','reason','no_recurring_expenses');
      ELSIF v_obs < (v_th->'breakeven_day'->>'min_days_observed')::int THEN
        v_skipped := v_skipped || jsonb_build_object('rule_id','breakeven_day','reason','insufficient_days_observed');
      ELSIF v_cm IS NULL OR v_cm <= 0 THEN
        v_skipped := v_skipped || jsonb_build_object('rule_id','breakeven_day','reason','non_positive_contribution_margin');
      ELSE
        v_be_sales := v_fixed / NULLIF(v_cm,0);
        SELECT MIN(d) INTO v_be_day FROM (
          SELECT period_date AS d,
                 SUM(net_sales) OVER (ORDER BY period_date
                                      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum
            FROM public.v_finance_pnl
           WHERE business_id = v_biz AND period_date BETWEEN v_ms AND p_period_end
        ) s WHERE s.cum >= v_be_sales;

        v_daily := v_mtd_sales / NULLIF(v_obs,0);
        IF v_be_day IS NULL THEN
          IF COALESCE(v_daily,0) <= 0 THEN
            v_be_day := NULL;
          ELSE
            v_be_day := v_ms + LEAST(CEIL(v_be_sales / v_daily)::int - 1,
                                     (v_th->'breakeven_day'->>'max_projection_days')::int);
          END IF;
        END IF;

        IF v_be_day IS NULL
           OR (v_be_day - v_ms) > (v_th->'breakeven_day'->>'max_projection_days')::int THEN
          v_skipped := v_skipped || jsonb_build_object('rule_id','breakeven_day','reason','projection_out_of_range');
        ELSE
          v_fired := v_fired || jsonb_build_object(
            'rule_id','breakeven_day','severity','info',
            'title','Punto de equilibrio (estimación)',
            'message', format('Estimación: según el ritmo actual, alcanzarías a cubrir los gastos recurrentes cargados alrededor del %s. Basado en %s días observados, %s de gastos recurrentes y %s de venta diaria promedio.',
                              to_char(v_be_day,'DD/MM/YYYY'), v_obs,
                              to_char(v_fixed,'FM999G999G999D00'),
                              to_char(COALESCE(v_daily,0),'FM999G999G999D00')),
            'impact_ars', 0,
            'evidence', jsonb_build_object(
              'metric','breakeven_day','current_value', v_be_day,
              'comparison_value', NULL, 'delta', NULL, 'delta_percent', NULL,
              'is_estimate', true,
              'days_observed', v_obs, 'fixed_monthly', ROUND(v_fixed,2),
              'contribution_margin_pct', ROUND(v_cm * 100, 2),
              'breakeven_sales', ROUND(v_be_sales,2),
              'daily_avg_sales', ROUND(COALESCE(v_daily,0),2),
              'month_to_date_sales', ROUND(v_mtd_sales,2),
              'already_reached', (v_be_day <= p_period_end),
              'threshold', v_th->'breakeven_day',
              'period_start', v_ms, 'period_end', p_period_end,
              'comparison_period_start', NULL, 'comparison_period_end', NULL,
              'sample_size', v_obs, 'currency','ARS',
              'source','v_finance_pnl + recurring_expenses',
              'calculation_version', v_ver),
            'action', jsonb_build_object('label','Ver cálculo','target_type','drawer','target','calculation','params', jsonb_build_object()));
        END IF;
      END IF;
    END;
  END;

  -- =========================================================================
  -- R7. supplier_crunch
  -- =========================================================================
  DECLARE
    v_overdue numeric := 0; v_due14 numeric := 0; v_undated numeric := 0;
    v_dated_cnt bigint := 0; v_purch_cnt bigint := 0;
    v_near numeric; v_cov numeric; v_min numeric := (v_th->'supplier_crunch'->>'min_material_ars')::numeric;
  BEGIN
    SELECT
      COALESCE(SUM(pending_amount) FILTER (WHERE due_status = 'overdue'), 0),
      COALESCE(SUM(pending_amount) FILTER (WHERE due_status = 'due_soon'), 0),
      COALESCE(SUM(pending_amount) FILTER (WHERE due_status = 'undated'), 0),
      COUNT(*) FILTER (WHERE due_date IS NOT NULL),
      COUNT(*)
      INTO v_overdue, v_due14, v_undated, v_dated_cnt, v_purch_cnt
      FROM public.v_finance_payables_due WHERE business_id = v_biz;

    v_near := v_overdue + v_due14;
    v_cov  := CASE WHEN v_near > 0 THEN ROUND(v_liquidity / v_near, 4) ELSE NULL END;

    IF v_dated_cnt = 0 THEN
      -- Sin fechas cargadas no hay compromiso datado. NO se asume que la deuda
      -- sin fecha vence pronto, y NO se emite insight visible.
      v_skipped := v_skipped || jsonb_build_object('rule_id','supplier_crunch','reason','insufficient_due_dates');
    ELSIF v_near < v_min THEN
      v_skipped := v_skipped || jsonb_build_object('rule_id','supplier_crunch','reason','below_materiality');
    ELSIF v_near > v_liquidity OR v_cov < (v_th->'supplier_crunch'->>'coverage_warning')::numeric THEN
      v_fired := v_fired || jsonb_build_object(
        'rule_id','supplier_crunch',
        'severity', CASE WHEN v_near > v_liquidity THEN 'critical' ELSE 'warning' END,
        'title','Compromisos con proveedores próximos',
        'message', format('Tenés %s en compromisos con proveedores vencidos o próximos a vencer durante los próximos %s días. La liquidez disponible cubre %s%%.',
                          to_char(v_near,'FM999G999G999D00'),
                          (v_th->'supplier_crunch'->>'horizon_days'),
                          ROUND(COALESCE(v_cov,0) * 100, 1)),
        'impact_ars', ROUND(v_near, 2),
        'evidence', jsonb_build_object(
          'metric','near_term_commitments_coverage',
          'current_value', v_cov, 'comparison_value', NULL, 'delta', NULL, 'delta_percent', NULL,
          'overdue_amount', ROUND(v_overdue,2),
          'due_next_14_days', ROUND(v_due14,2),
          'total_near_term_commitments', ROUND(v_near,2),
          'available_liquidity', ROUND(v_liquidity,2),
          'coverage_ratio', v_cov,
          'purchases_count', v_purch_cnt,
          'dated_purchase_count', v_dated_cnt,
          'dated_pending_amount', ROUND(v_overdue + v_due14, 2),
          'undated_pending_amount', ROUND(v_undated,2),
          'horizon_days', (v_th->'supplier_crunch'->>'horizon_days')::int,
          'threshold', v_th->'supplier_crunch',
          'period_start', v_today, 'period_end', v_today + (v_th->'supplier_crunch'->>'horizon_days')::int,
          'comparison_period_start', NULL, 'comparison_period_end', NULL,
          'sample_size', v_purch_cnt, 'currency','ARS',
          'source','v_finance_payables_due',
          'calculation_version', v_ver),
        'action', jsonb_build_object('label','Ver proveedores','target_type','route','target','/suppliers','params', jsonb_build_object()));
    END IF;
  END;

  -- =========================================================================
  -- R8. fx_stale_prices
  -- La cotizacion de comparacion sale de exchange_rates (fila ALMACENADA). El
  -- motor nunca llama a una API externa.
  -- =========================================================================
  DECLARE
    v_rate numeric; v_rate_at timestamptz;
    v_stale bigint := 0; v_usd_tot bigint := 0; v_avg_used numeric;
  BEGIN
    SELECT er.rate, er.updated_at INTO v_rate, v_rate_at
      FROM public.exchange_rates er
     WHERE er.business_id = v_biz AND er.base_currency = 'USD' AND er.target_currency = 'ARS'
     ORDER BY er.updated_at DESC LIMIT 1;

    IF v_rate IS NULL OR v_rate <= 0 THEN
      v_skipped := v_skipped || jsonb_build_object('rule_id','fx_stale_prices','reason','no_reference_rate');
    ELSIF v_rate_at < now() - ((v_th->'fx_stale_prices'->>'max_rate_age_days')::int || ' days')::interval THEN
      v_skipped := v_skipped || jsonb_build_object('rule_id','fx_stale_prices','reason','stale_reference_rate');
    ELSE
      SELECT COUNT(*),
             COUNT(*) FILTER (WHERE i.exchange_rate_used IS NOT NULL
               AND i.exchange_rate_used < v_rate * (1 - (v_th->'fx_stale_prices'->>'rate_diff_pct')::numeric / 100)),
             AVG(i.exchange_rate_used)
        INTO v_usd_tot, v_stale, v_avg_used
        FROM public.inventory i
       WHERE i.business_id = v_biz AND i.is_active = true
         AND i.base_currency = 'USD' AND COALESCE(i.base_price,0) > 0;

      IF v_usd_tot = 0 THEN
        v_skipped := v_skipped || jsonb_build_object('rule_id','fx_stale_prices','reason','no_usd_products');
      ELSIF v_stale >= 1
            AND (v_stale::numeric / NULLIF(v_usd_tot,0)) >= (v_th->'fx_stale_prices'->>'share')::numeric THEN
        v_fired := v_fired || jsonb_build_object(
          'rule_id','fx_stale_prices','severity','warning',
          'title','Precios en dólares desactualizados',
          'message', format('%s de %s productos en dólares tienen precios calculados a una cotización promedio de %s, y hoy la cotización cargada es %s.',
                            v_stale, v_usd_tot,
                            to_char(COALESCE(v_avg_used,0),'FM999G999G999D00'),
                            to_char(v_rate,'FM999G999G999D00')),
          'impact_ars', 0,
          'evidence', jsonb_build_object(
            'metric','stale_usd_price_share',
            'current_value', ROUND(v_stale::numeric / NULLIF(v_usd_tot,0), 4),
            'comparison_value', NULL, 'delta', NULL,
            'delta_percent', ROUND((v_rate - COALESCE(v_avg_used,0)) / NULLIF(v_rate,0) * 100, 2),
            'stale_count', v_stale, 'total_usd_products', v_usd_tot,
            'avg_rate_used', ROUND(COALESCE(v_avg_used,0),4),
            'current_rate', v_rate, 'rate_updated_at', v_rate_at,
            'threshold', v_th->'fx_stale_prices',
            'period_start', p_period_start, 'period_end', p_period_end,
            'comparison_period_start', NULL, 'comparison_period_end', NULL,
            'sample_size', v_usd_tot, 'currency','ARS',
            'source','inventory + exchange_rates',
            'calculation_version', v_ver),
          'action', jsonb_build_object('label','Ver cotización','target_type','route','target','/currency-settings','params', jsonb_build_object()));
      END IF;
    END IF;
  END;

  -- =========================================================================
  -- R9. data_quality
  -- Dispara SOLO por critical_count. NUNCA por overall_status, que en produccion
  -- ya vale 'warn' por los warnings legacy aceptados: usarlo convertiria
  -- historico explicado en alerta permanente.
  -- =========================================================================
  DECLARE
    v_hc jsonb;
    v_crit bigint; v_risk numeric; v_warn bigint; v_low bigint;
  BEGIN
    -- p_include_global = false a proposito: los checks globales exigen ser owner
    -- y exponen configuracion de plataforma.
    v_hc := public.finance_health_check_v2(v_biz, false);

    IF COALESCE(v_hc->>'ok','false') <> 'true' THEN
      v_skipped := v_skipped || jsonb_build_object('rule_id','data_quality','reason','health_check_unavailable');
    ELSE
      v_crit := COALESCE((v_hc->>'critical_count')::bigint, 0);
      v_risk := COALESCE((v_hc->>'amount_at_risk')::numeric, 0);
      v_warn := COALESCE((v_hc->>'warning_count')::bigint, 0);
      v_low  := COALESCE((v_hc->>'low_count')::bigint, 0);

      IF v_crit < (v_th->'data_quality'->>'critical_count_min')::bigint THEN
        v_skipped := v_skipped || jsonb_build_object('rule_id','data_quality','reason','no_critical_issues');
      ELSE
        v_fired := v_fired || jsonb_build_object(
          'rule_id','data_quality',
          'severity', CASE WHEN v_risk > 0 THEN 'critical' ELSE 'warning' END,
          'title','Hay inconsistencias que pueden distorsionar estos números',
          'message', format('El chequeo de salud encontró %s inconsistencia(s) crítica(s)%s. Mientras existan, los demás números de este panel pueden estar distorsionados.',
                            v_crit,
                            CASE WHEN v_risk > 0
                                 THEN ' que comprometen ' || to_char(v_risk,'FM999G999G999D00')
                                 ELSE '' END),
          'impact_ars', ROUND(v_risk, 2),
          'evidence', jsonb_build_object(
            'metric','health_critical_count','current_value', v_crit,
            'comparison_value', NULL, 'delta', NULL, 'delta_percent', NULL,
            'critical_count', v_crit, 'amount_at_risk', ROUND(v_risk,2),
            'warning_count', v_warn, 'low_count', v_low,
            'checks_total', COALESCE((v_hc->>'checks_total')::bigint, 0),
            'pass_count', COALESCE((v_hc->>'pass_count')::bigint, 0),
            'overall_status', v_hc->>'overall_status',
            'health_version', v_hc->>'version',
            'threshold', v_th->'data_quality',
            'period_start', p_period_start, 'period_end', p_period_end,
            'comparison_period_start', NULL, 'comparison_period_end', NULL,
            'sample_size', COALESCE((v_hc->>'checks_total')::bigint, 0),
            'currency','ARS','source','finance_health_check_v2',
            'calculation_version', v_ver),
          'action', jsonb_build_object('label','Ver auditoría','target_type','route','target','/finance/health','params', jsonb_build_object()));
      END IF;
    END IF;
  END;

  -- =========================================================================
  -- R10. cc_aging
  -- "antiguedad", NUNCA "vencido": no existe due_date contractual para CxC.
  -- =========================================================================
  DECLARE
    v_recv numeric := 0; v_old numeric := 0; v_b3160 numeric := 0; v_b60 numeric := 0;
    v_top_n bigint := 0; v_top_share numeric; v_days int := (v_th->'cc_aging'->>'days')::int;
  BEGIN
    SELECT COALESCE(SUM(amount),0),
           COALESCE(SUM(amount) FILTER (WHERE bucket IN ('31-60','60+')),0),
           COALESCE(SUM(amount) FILTER (WHERE bucket = '31-60'),0),
           COALESCE(SUM(amount) FILTER (WHERE bucket = '60+'),0)
      INTO v_recv, v_old, v_b3160, v_b60
      FROM public.v_finance_receivables_aging WHERE business_id = v_biz;

    IF v_recv <= 0 THEN
      v_skipped := v_skipped || jsonb_build_object('rule_id','cc_aging','reason','no_receivables');
    ELSIF v_old > 0 AND (v_old / NULLIF(v_recv,0)) >= (v_th->'cc_aging'->>'share')::numeric THEN
      -- Concentracion: cuantos deudores concentran el 60% de la deuda antigua.
      -- NO se guardan nombres ni ids de clientes: solo el conteo y la proporcion.
      WITH per_customer AS (
        SELECT c.customer_id, SUM(c.saldo_pendiente) AS amt
          FROM public.comprobantes c
          JOIN public.v_finance_effective_comprobantes e
            ON e.id = c.id AND e.is_credit_note = false
         WHERE c.business_id = v_biz AND c.saldo_pendiente > 0.01
           AND c.customer_id IS NOT NULL
           AND (v_today - e.period_date) > v_days
         GROUP BY 1
      ), ranked AS (
        SELECT SUM(amt) OVER (ORDER BY amt DESC
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum,
               SUM(amt) OVER () AS tot,
               ROW_NUMBER() OVER (ORDER BY amt DESC) AS rn
          FROM per_customer
      )
      -- El primer rn cuyo acumulado cruza el umbral de concentracion.
      SELECT COALESCE(MIN(rn), 0),
             COALESCE(ROUND(MIN(cum) / NULLIF(MIN(tot), 0), 4), 0)
        INTO v_top_n, v_top_share
        FROM ranked
       WHERE cum >= tot * (v_th->'cc_aging'->>'concentration_share')::numeric;

      v_fired := v_fired || jsonb_build_object(
        'rule_id','cc_aging','severity','warning',
        'title','Parte de tu cuenta corriente tiene mucha antigüedad',
        'message', format('Tenés %s en saldos de cuenta corriente con más de %s días de antigüedad. Es el %s%% de lo que te deben.',
                          to_char(v_old,'FM999G999G999D00'), v_days,
                          ROUND(v_old / NULLIF(v_recv,0) * 100, 1)),
        'impact_ars', ROUND(v_old, 2),
        'evidence', jsonb_build_object(
          'metric','receivables_aged_share',
          'current_value', ROUND(v_old / NULLIF(v_recv,0), 4),
          'comparison_value', NULL, 'delta', NULL, 'delta_percent', NULL,
          'overdue_30plus', ROUND(v_old,2), 'receivables_total', ROUND(v_recv,2),
          'bucket_31_60', ROUND(v_b3160,2), 'bucket_60plus', ROUND(v_b60,2),
          'top_debtor_count', v_top_n, 'top_debtor_share', v_top_share,
          'days_threshold', v_days,
          'threshold', v_th->'cc_aging',
          'period_start', p_period_start, 'period_end', p_period_end,
          'comparison_period_start', NULL, 'comparison_period_end', NULL,
          'sample_size', v_top_n, 'currency','ARS',
          'source','v_finance_receivables_aging + comprobantes',
          'calculation_version', v_ver),
        'action', jsonb_build_object('label','Ver cuentas corrientes','target_type','route','target','/cuentas','params', jsonb_build_object()));
    ELSE
      v_skipped := v_skipped || jsonb_build_object('rule_id','cc_aging','reason','below_threshold');
    END IF;
  END;

  -- =========================================================================
  -- PERSISTENCIA - una sola pasada, idempotente
  -- =========================================================================
  INSERT INTO public.finance_insights AS fi (
    business_id, rule_id, rule_version, period_start, period_end,
    severity, title, message, evidence, action, status, impact_ars, fingerprint,
    generated_at, resolved_at, updated_at)
  SELECT
    v_biz, r->>'rule_id', v_ver, p_period_start, p_period_end,
    r->>'severity', r->>'title', r->>'message', r->'evidence', r->'action',
    'active', COALESCE((r->>'impact_ars')::numeric, 0),
    md5(v_biz::text || '|' || (r->>'rule_id') || '|' || v_ver || '|'
        || p_period_start::text || '|' || p_period_end::text),
    now(), NULL, now()
  FROM jsonb_array_elements(v_fired) r
  ON CONFLICT (fingerprint) DO UPDATE SET
    severity     = EXCLUDED.severity,
    title        = EXCLUDED.title,
    message      = EXCLUDED.message,
    evidence     = EXCLUDED.evidence,
    action       = EXCLUDED.action,
    impact_ars   = EXCLUDED.impact_ars,
    status       = 'active',
    resolved_at  = NULL,
    generated_at = now(),
    updated_at   = now();

  SELECT COALESCE(array_agg(r->>'rule_id'), ARRAY[]::text[]) INTO v_keep
    FROM jsonb_array_elements(v_fired) r;

  -- Una regla que dejo de cumplirse se RESUELVE, no se borra: la historia del
  -- periodo queda auditable.
  UPDATE public.finance_insights
     SET status = 'resolved', resolved_at = now(), updated_at = now()
   WHERE business_id = v_biz AND rule_version = v_ver
     AND period_start = p_period_start AND period_end = p_period_end
     AND status = 'active' AND NOT (rule_id = ANY (v_keep));

  RETURN jsonb_build_object(
    'ok', true,
    'business_id', v_biz,
    'period_start', p_period_start,
    'period_end', p_period_end,
    'comparison_period_start', v_cmp_start,
    'comparison_period_end', v_cmp_end,
    'rule_version', v_ver,
    'generated_at', now(),
    'fired_count', jsonb_array_length(v_fired),
    'fired', (SELECT COALESCE(jsonb_agg(r->>'rule_id'), '[]'::jsonb) FROM jsonb_array_elements(v_fired) r),
    'skipped', v_skipped,
    'thresholds', v_th,
    'duration_ms', round(EXTRACT(epoch FROM (clock_timestamp() - v_t0)) * 1000)::int
  );

EXCEPTION
  -- Errores sanitizados: nunca se filtra SQLERRM al cliente (puede contener
  -- nombres de tabla, valores de fila y estructura interna).
  WHEN OTHERS THEN
    RAISE WARNING 'generate_finance_insights fallo para business % : % (%)', v_biz, SQLERRM, SQLSTATE;
    RETURN jsonb_build_object('ok', false, 'error', 'No se pudo generar el análisis');
END
$fn$;

ALTER FUNCTION public.generate_finance_insights(uuid, date, date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.generate_finance_insights(uuid, date, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.generate_finance_insights(uuid, date, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.generate_finance_insights(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_finance_insights(uuid, date, date) TO service_role;

COMMENT ON FUNCTION public.generate_finance_insights(uuid, date, date) IS
  'M8 - evalua las 10 reglas deterministas y persiste en finance_insights. '
  'SECURITY DEFINER porque authenticated no tiene INSERT sobre la tabla (si lo '
  'tuviera podria fabricar evidence). Verifica pertenencia explicitamente y '
  'filtra por business_id en cada consulta: no delega en RLS.';

-- ---------------------------------------------------------------------------
-- 5. LECTURA - orden estable server-side
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER: aca alcanza con la RLS de la tabla, asi que no se usa
-- DEFINER. Es la opcion mas restrictiva que cumple la funcion.
CREATE OR REPLACE FUNCTION public.finance_insights_read(
  p_business_id uuid,
  p_period_start date,
  p_period_end date,
  p_status text DEFAULT 'active',
  p_max integer DEFAULT 20
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'ok', true,
    'business_id', p_business_id,
    'period_start', p_period_start,
    'period_end', p_period_end,
    'status', COALESCE(p_status,'active'),
    'insights', COALESCE(jsonb_agg(x ORDER BY x_sev, x_impact DESC, x_gen DESC, x_rule), '[]'::jsonb)
  )
  FROM (
    SELECT jsonb_build_object(
             'id', fi.id, 'rule_id', fi.rule_id, 'rule_version', fi.rule_version,
             'period_start', fi.period_start, 'period_end', fi.period_end,
             'severity', fi.severity, 'title', fi.title, 'message', fi.message,
             'evidence', fi.evidence, 'action', fi.action, 'status', fi.status,
             'impact_ars', fi.impact_ars, 'generated_at', fi.generated_at,
             'resolved_at', fi.resolved_at) AS x,
           CASE fi.severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END AS x_sev,
           fi.impact_ars AS x_impact, fi.generated_at AS x_gen, fi.rule_id AS x_rule
      FROM public.finance_insights fi
     WHERE fi.business_id = p_business_id
       AND fi.period_start = p_period_start
       AND fi.period_end   = p_period_end
       AND fi.status = COALESCE(p_status,'active')
     ORDER BY 2, 3 DESC, 4 DESC, 5
     LIMIT GREATEST(COALESCE(p_max,20), 1)
  ) t;
$$;

REVOKE ALL ON FUNCTION public.finance_insights_read(uuid, date, date, text, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.finance_insights_read(uuid, date, date, text, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.finance_insights_read(uuid, date, date, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finance_insights_read(uuid, date, date, text, integer) TO service_role;

COMMENT ON FUNCTION public.finance_insights_read(uuid, date, date, text, integer) IS
  'M8 - lectura con orden estable (severidad, impacto, generated_at, rule_id). '
  'SECURITY INVOKER: la RLS de finance_insights alcanza. La UI muestra 3; la DB '
  'no trunca la historia.';

-- ---------------------------------------------------------------------------
-- 6. POSTCONDICIONES
-- ---------------------------------------------------------------------------
DO $post$
BEGIN
  -- R1. RLS activa y forzada.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class
                  WHERE oid = 'public.finance_insights'::regclass
                    AND relrowsecurity AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'POSTCONDICION R1: finance_insights sin RLS forzada';
  END IF;

  -- R2. anon a cero en la tabla.
  IF has_table_privilege('anon','public.finance_insights','SELECT')
  OR has_table_privilege('anon','public.finance_insights','INSERT')
  OR has_table_privilege('anon','public.finance_insights','UPDATE')
  OR has_table_privilege('anon','public.finance_insights','DELETE')
  OR has_table_privilege('anon','public.finance_insights','TRUNCATE') THEN
    RAISE EXCEPTION 'POSTCONDICION R2: anon tiene privilegios sobre finance_insights';
  END IF;

  -- R3. authenticated NO puede escribir contenido calculado.
  IF has_table_privilege('authenticated','public.finance_insights','INSERT')
  OR has_table_privilege('authenticated','public.finance_insights','UPDATE')
  OR has_table_privilege('authenticated','public.finance_insights','DELETE')
  OR has_table_privilege('authenticated','public.finance_insights','TRUNCATE') THEN
    RAISE EXCEPTION 'POSTCONDICION R3: authenticated puede escribir finance_insights';
  END IF;
  IF NOT has_table_privilege('authenticated','public.finance_insights','SELECT') THEN
    RAISE EXCEPTION 'POSTCONDICION R3b: authenticated no puede leer finance_insights';
  END IF;

  -- R4. anon no ejecuta ninguna de las funciones nuevas.
  IF has_function_privilege('anon','public.generate_finance_insights(uuid,date,date)','EXECUTE')
  OR has_function_privilege('anon','public.finance_insights_read(uuid,date,date,text,integer)','EXECUTE')
  OR has_function_privilege('anon','public.finance_insight_thresholds()','EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION R4: anon puede ejecutar funciones de M8';
  END IF;

  -- R5. PUBLIC revocado (EXECUTE a PUBLIC es el DEFAULT de Postgres).
  IF has_function_privilege('public','public.generate_finance_insights(uuid,date,date)','EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION R5: PUBLIC conserva EXECUTE sobre generate_finance_insights';
  END IF;

  -- R6. search_path endurecido con pg_temp AL FINAL (si se omite, Postgres lo
  --     pone PRIMERO y una tabla temporal puede secuestrar una referencia).
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = 'public.generate_finance_insights(uuid,date,date)'::regprocedure
       AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION R6: search_path de generate_finance_insights no endurecido';
  END IF;

  -- R7. La de lectura NO es SECURITY DEFINER (no lo necesita).
  IF (SELECT prosecdef FROM pg_catalog.pg_proc
       WHERE oid = 'public.finance_insights_read(uuid,date,date,text,integer)'::regprocedure) THEN
    RAISE EXCEPTION 'POSTCONDICION R7: finance_insights_read quedo SECURITY DEFINER sin necesidad';
  END IF;

  -- R8. Unicidad por fingerprint (lo que impide duplicados).
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_indexes
                  WHERE schemaname='public' AND indexname='finance_insights_fingerprint_uidx') THEN
    RAISE EXCEPTION 'POSTCONDICION R8: falta el unique de fingerprint';
  END IF;

  -- R9. Cero filas: esta migracion NO genera insights (nada de backfill).
  IF (SELECT count(*) FROM public.finance_insights) <> 0 THEN
    RAISE EXCEPTION 'POSTCONDICION R9: la migracion escribio insights (backfill prohibido)';
  END IF;

  -- R10. Las fuentes canonicas siguen intactas.
  IF to_regclass('public.v_finance_pnl') IS NULL
  OR to_regclass('public.v_finance_payables_aging') IS NULL
  OR to_regproc('public.finance_health_check_v2') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICION R10: se perdio una fuente canonica';
  END IF;

  RAISE NOTICE 'M8-B OK - motor de 10 reglas, RLS cerrada, anon a cero, cero backfill.';
END
$post$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ===========================================================================
-- ROLLBACK (documentado)
--   DROP FUNCTION IF EXISTS public.finance_insights_read(uuid,date,date,text,integer);
--   DROP FUNCTION IF EXISTS public.generate_finance_insights(uuid,date,date);
--   DROP FUNCTION IF EXISTS public.finance_insight_thresholds();
--   DROP TABLE IF EXISTS public.finance_insights;
-- Seguro: la tabla es puramente derivada. Borrarla no pierde ningun dato
-- financiero - se regenera corriendo la funcion de nuevo.
-- ===========================================================================
