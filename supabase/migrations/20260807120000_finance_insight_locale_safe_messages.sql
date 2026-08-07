-- ===========================================================================
-- M8 217 - mensajes de insight independientes del locale
--
-- CAUSA (medida en produccion, no inferida): lc_numeric = 'en_US.UTF-8', asi que
-- to_char(10823941.50, 'FM999G999G999D00') emite '10,823,941.50'. Ese texto
-- quedaba embebido en finance_insights.message, mientras React formatea el MISMO
-- numero desde evidence como '$ 10.823.941,50'. El mismo importe se veia de dos
-- formas en la misma tarjeta.
--
-- DECISION DE ARQUITECTURA
--   La DB es autoridad sobre metricas, formulas, thresholds, severity, evidence,
--   rule_id, rule_version, estado y fingerprint.
--   El FRONTEND es autoridad sobre separadores, moneda, porcentajes y fechas.
--   Por lo tanto `message` deja de incrustar valores localizados: queda como
--   fallback cualitativo determinista, y los numeros viven SOLO en `evidence`.
--
-- Lo que NO se hace, a proposito:
--   * No se toca lc_numeric (es configuracion del servidor, no del dominio).
--   * No se usa replace(',','.') ni trucos sobre to_char: producen basura en
--     cuanto el locale del servidor cambie.
--   * No se edita 20260806130000 (ya aplicada a produccion): editarla haria que
--     un db reset futuro construya otro esquema y que repo y produccion
--     divergan en semantica. Esta migracion es forward-only.
--   * CERO DML. Las 4 filas ya generadas son derivadas y se actualizan solas en
--     la proxima regeneracion del mismo periodo (mismo fingerprint).
--   * rule_version SIGUE siendo v1: el calculo no cambio, solo la redaccion.
--
-- COMPATIBILIDAD: el frontend nuevo renderiza desde rule_id + evidence, asi que
-- es correcto ANTES y DESPUES de que las filas viejas se regeneren.
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. PRECONDICIONES
-- ---------------------------------------------------------------------------
DO $pre$
BEGIN
  IF to_regproc('public.generate_finance_insights') IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION P0: falta generate_finance_insights (M8 216)';
  END IF;
  IF to_regclass('public.finance_insights') IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION P1: falta finance_insights';
  END IF;
  IF to_regproc('public.finance_insight_thresholds') IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION P2: falta finance_insight_thresholds';
  END IF;
END
$pre$;

-- Baseline de sesion: permite exigir cero DML y contrato intacto al final.
DROP TABLE IF EXISTS _m8c_baseline;
CREATE TEMP TABLE _m8c_baseline AS
SELECT
  (SELECT count(*) FROM public.finance_insights)                       AS insights_total,
  (SELECT count(*) FROM public.finance_insights WHERE status='active') AS insights_activos,
  (SELECT COALESCE(sum(impact_ars),0) FROM public.finance_insights)    AS suma_impacto,
  (SELECT md5(string_agg(fingerprint, '|' ORDER BY fingerprint))
     FROM public.finance_insights)                                     AS huella_fingerprints,
  (SELECT public.finance_insight_thresholds())                         AS thresholds,
  (SELECT count(*) FROM public.supplier_purchases WHERE due_date IS NOT NULL) AS sp_con_due_date,
  (SELECT count(*) FROM public.comprobantes)                           AS comprobantes,
  (SELECT count(*) FROM public.financial_movements)                    AS movimientos,
  (SELECT count(*) FROM public.business_finance_entries)               AS asientos;

-- ---------------------------------------------------------------------------
-- 1. GENERACION - identica a 216 salvo los textos de `message`
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE con la MISMA firma preserva owner y privilegios; no se
-- re-otorga nada (el default a PUBLIC solo aplica al crear una firma nueva).
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

  PERFORM pg_advisory_xact_lock(
    hashtext('finance_insights:' || v_biz::text || ':' || p_period_start::text
             || ':' || p_period_end::text || ':' || v_ver));

  SELECT COALESCE(SUM(net_sales),0), COALESCE(SUM(gross_profit),0), COALESCE(SUM(cogs),0)
    INTO v_ns_cur, v_gp_cur, v_cogs_cur
    FROM public.v_finance_pnl
   WHERE business_id = v_biz AND period_date BETWEEN p_period_start AND p_period_end;

  SELECT COALESCE(SUM(net_sales),0), COALESCE(SUM(gross_profit),0), COALESCE(SUM(cogs),0)
    INTO v_ns_prev, v_gp_prev, v_cogs_prev
    FROM public.v_finance_pnl
   WHERE business_id = v_biz AND period_date BETWEEN v_cmp_start AND v_cmp_end;

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

  -- R1. margin_drop_cost
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
          'message','El margen bruto cayó respecto del período anterior y el costo de mercadería subió como proporción de cada venta. No se explica por vender menos.',
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

  -- R2. cash_down_sales_up
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
          'message','La facturación devengada aumentó mientras los cobros operativos disminuyeron. Parte de las ventas del período quedó sin cobrar.',
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

  -- R3. dead_stock
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
        'message','Hay stock sin ventas ni consumo registrados en el plazo observado. Representa una porción significativa de tu inventario valorizado.',
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

  -- R4. withdrawals_vs_profit
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
        'message','Los retiros del dueño representan una proporción elevada del resultado operativo de la ventana observada.',
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

  -- R5. fixed_coverage
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
          'message','Tu caja cubre menos de un mes de los gastos recurrentes que cargaste.',
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

    -- R6. breakeven_day
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
            'message','Estimación: según el ritmo de ventas observado, alcanzarías a cubrir los gastos recurrentes cargados dentro del mes en curso.',
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

  -- R7. supplier_crunch
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
      v_skipped := v_skipped || jsonb_build_object('rule_id','supplier_crunch','reason','insufficient_due_dates');
    ELSIF v_near < v_min THEN
      v_skipped := v_skipped || jsonb_build_object('rule_id','supplier_crunch','reason','below_materiality');
    ELSIF v_near > v_liquidity OR v_cov < (v_th->'supplier_crunch'->>'coverage_warning')::numeric THEN
      v_fired := v_fired || jsonb_build_object(
        'rule_id','supplier_crunch',
        'severity', CASE WHEN v_near > v_liquidity THEN 'critical' ELSE 'warning' END,
        'title','Compromisos con proveedores próximos',
        'message','Hay compromisos con proveedores vencidos o próximos a vencer en el horizonte definido que superan el nivel de cobertura esperado. La deuda sin fecha acordada no se cuenta como compromiso próximo.',
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

  -- R8. fx_stale_prices
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
          'message','Hay productos en dólares con precios calculados a una cotización anterior a la que tenés cargada hoy.',
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

  -- R9. data_quality
  DECLARE
    v_hc jsonb;
    v_crit bigint; v_risk numeric; v_warn bigint; v_low bigint;
  BEGIN
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
          'message','El chequeo de salud financiera encontró inconsistencias críticas. Mientras existan, los demás números de este panel pueden estar distorsionados.',
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

  -- R10. cc_aging
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
      SELECT COALESCE(MIN(rn), 0),
             COALESCE(ROUND(MIN(cum) / NULLIF(MIN(tot), 0), 4), 0)
        INTO v_top_n, v_top_share
        FROM ranked
       WHERE cum >= tot * (v_th->'cc_aging'->>'concentration_share')::numeric;

      v_fired := v_fired || jsonb_build_object(
        'rule_id','cc_aging','severity','warning',
        'title','Parte de tu cuenta corriente tiene mucha antigüedad',
        'message','Parte de los saldos de cuenta corriente supera el umbral de antigüedad definido sobre el total que te deben.',
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

  -- PERSISTENCIA - identica a 216
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
  WHEN OTHERS THEN
    RAISE WARNING 'generate_finance_insights fallo para business % : % (%)', v_biz, SQLERRM, SQLSTATE;
    RETURN jsonb_build_object('ok', false, 'error', 'No se pudo generar el análisis');
END
$fn$;

-- CREATE OR REPLACE con la MISMA firma preserva los privilegios, asi que estos
-- REVOKE/GRANT son redundantes por definicion. Se re-afirman igual: son
-- idempotentes, y dejar el cierre de anon/PUBLIC dependiendo de una sutileza
-- del motor es exactamente como se reabre un agujero sin que nadie lo note.
ALTER FUNCTION public.generate_finance_insights(uuid, date, date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.generate_finance_insights(uuid, date, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.generate_finance_insights(uuid, date, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.generate_finance_insights(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_finance_insights(uuid, date, date) TO service_role;

COMMENT ON FUNCTION public.generate_finance_insights(uuid, date, date) IS
  'M8 - evalua las 10 reglas deterministas y persiste en finance_insights. '
  'SECURITY DEFINER porque authenticated no tiene INSERT sobre la tabla. '
  '217: `message` es un fallback CUALITATIVO sin valores localizados; los '
  'numeros viven solo en `evidence` y los formatea el frontend en es-AR.';

-- ---------------------------------------------------------------------------
-- 2. POSTCONDICIONES
-- ---------------------------------------------------------------------------
DO $post$
DECLARE
  v_b   record;
  v_src text;
BEGIN
  SELECT * INTO v_b FROM _m8c_baseline;
  SELECT prosrc INTO v_src FROM pg_catalog.pg_proc
   WHERE oid = 'public.generate_finance_insights(uuid,date,date)'::regprocedure;

  -- R1. Cero to_char en el cuerpo: es lo que introducia el formato del locale.
  IF v_src ~* 'to_char' THEN
    RAISE EXCEPTION 'POSTCONDICION R1: el cuerpo todavia usa to_char para armar textos';
  END IF;

  -- R2. Ningun message concatena valores: `format(` desaparecio del cuerpo.
  IF v_src ~* '''message'',\s*format\(' THEN
    RAISE EXCEPTION 'POSTCONDICION R2: message sigue interpolando valores con format()';
  END IF;

  -- R3. Los 10 rule_id siguen presentes en el motor.
  IF NOT (v_src LIKE '%margin_drop_cost%' AND v_src LIKE '%cash_down_sales_up%'
      AND v_src LIKE '%dead_stock%'       AND v_src LIKE '%withdrawals_vs_profit%'
      AND v_src LIKE '%fixed_coverage%'   AND v_src LIKE '%breakeven_day%'
      AND v_src LIKE '%supplier_crunch%'  AND v_src LIKE '%fx_stale_prices%'
      AND v_src LIKE '%data_quality%'     AND v_src LIKE '%cc_aging%') THEN
    RAISE EXCEPTION 'POSTCONDICION R3: falta alguna de las 10 reglas';
  END IF;

  -- R4. rule_version sigue en v1: el calculo NO cambio.
  IF v_src !~ 'v_ver\s+text\s*:=\s*''v1''' THEN
    RAISE EXCEPTION 'POSTCONDICION R4: rule_version dejo de ser v1';
  END IF;

  -- R5. Thresholds byte-identicos a los de antes de esta migracion.
  IF public.finance_insight_thresholds() <> v_b.thresholds THEN
    RAISE EXCEPTION 'POSTCONDICION R5: cambiaron los thresholds';
  END IF;

  -- R6. Firma, modo de seguridad y search_path intactos.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = 'public.generate_finance_insights(uuid,date,date)'::regprocedure
       AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION R6: se perdio SECURITY DEFINER o el search_path';
  END IF;
  IF (SELECT prosecdef FROM pg_catalog.pg_proc
       WHERE oid = 'public.finance_insights_read(uuid,date,date,text,integer)'::regprocedure) THEN
    RAISE EXCEPTION 'POSTCONDICION R6b: la funcion de lectura quedo SECURITY DEFINER';
  END IF;

  -- R7. Grants intactos: anon y PUBLIC siguen fuera.
  IF has_function_privilege('anon','public.generate_finance_insights(uuid,date,date)','EXECUTE')
  OR has_function_privilege('public','public.generate_finance_insights(uuid,date,date)','EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION R7: anon o PUBLIC recuperaron EXECUTE';
  END IF;
  IF NOT has_function_privilege('authenticated','public.generate_finance_insights(uuid,date,date)','EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION R7b: authenticated perdio EXECUTE';
  END IF;

  -- R8. RLS de la tabla intacta.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class
                  WHERE oid='public.finance_insights'::regclass
                    AND relrowsecurity AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'POSTCONDICION R8: finance_insights perdio RLS forzada';
  END IF;

  -- R9. CERO DML: ni una fila creada, borrada, resuelta ni reescrita.
  IF (SELECT count(*) FROM public.finance_insights) <> v_b.insights_total THEN
    RAISE EXCEPTION 'POSTCONDICION R9a: cambio la cantidad de insights';
  END IF;
  IF (SELECT count(*) FROM public.finance_insights WHERE status='active') <> v_b.insights_activos THEN
    RAISE EXCEPTION 'POSTCONDICION R9b: cambiaron los insights activos';
  END IF;
  IF (SELECT COALESCE(sum(impact_ars),0) FROM public.finance_insights) <> v_b.suma_impacto THEN
    RAISE EXCEPTION 'POSTCONDICION R9c: cambio el impacto acumulado';
  END IF;

  -- R10. Fingerprints estables (la identidad de las filas no se toco).
  IF (SELECT md5(string_agg(fingerprint, '|' ORDER BY fingerprint))
        FROM public.finance_insights) IS DISTINCT FROM v_b.huella_fingerprints THEN
    RAISE EXCEPTION 'POSTCONDICION R10: cambiaron los fingerprints';
  END IF;

  -- R11. Cero cambios en datos financieros y en due_date.
  IF (SELECT count(*) FROM public.supplier_purchases WHERE due_date IS NOT NULL) <> v_b.sp_con_due_date
  OR (SELECT count(*) FROM public.comprobantes)            <> v_b.comprobantes
  OR (SELECT count(*) FROM public.financial_movements)     <> v_b.movimientos
  OR (SELECT count(*) FROM public.business_finance_entries) <> v_b.asientos THEN
    RAISE EXCEPTION 'POSTCONDICION R11: se tocaron datos financieros historicos';
  END IF;

  RAISE NOTICE 'M8-217 OK - mensajes sin locale, evidence intacta, v1, cero DML.';
END
$post$;

DROP TABLE IF EXISTS _m8c_baseline;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ===========================================================================
-- ROLLBACK (documentado): re-aplicar el cuerpo de 20260806130000. Es seguro:
-- solo cambia la redaccion del fallback; evidence, thresholds, fingerprints y
-- resultados de las reglas son identicos en ambas versiones.
-- ===========================================================================
