-- ============================================================================
-- Fase 8 — finance_dashboard_summary v2 (Etapa 1)
--
-- Reescribe la RPC (misma firma, para compatibilidad) para que consuma las
-- vistas canónicas M5. Devuelve secciones SEPARADAS — nunca mezcla utilidad,
-- caja, retiros y deuda en un único net_result:
--   { ok, finance_model_version, generated_at, timezone, period,
--     profitability{}, cashflow{}, position{}, data_quality{}, comparison{} }
-- SECURITY DEFINER con ownership check (las vistas son security_invoker; la RPC
-- filtra por business_id validado). Solo lectura.
-- ============================================================================
CREATE OR REPLACE FUNCTION "public"."finance_dashboard_summary"(
  "p_business_id" uuid, "p_date_from" date, "p_date_to" date
) RETURNS jsonb
    LANGUAGE "plpgsql" SECURITY DEFINER STABLE
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_has_access boolean := false;
  v_prev_from  date;
  v_prev_to    date;
  v_span       integer;
  v_prof       jsonb;
  v_prof_prev  jsonb;
  v_cash       jsonb;
  v_pos        jsonb;
  v_quality    jsonb;
BEGIN
  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=auth.uid())
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND user_id=auth.uid())
  ) INTO v_has_access;
  IF NOT v_has_access THEN RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso al negocio'); END IF;

  v_span    := GREATEST(1, (p_date_to - p_date_from) + 1);
  v_prev_to := p_date_from - 1;
  v_prev_from := v_prev_to - (v_span - 1);

  -- ── Rentabilidad (devengado) ────────────────────────────────────────────
  SELECT jsonb_build_object(
    'gross_sales', COALESCE(SUM(gross_sales),0),
    'discounts', COALESCE(SUM(discounts),0),
    'sales_returns', COALESCE(SUM(sales_returns),0),
    'net_sales', COALESCE(SUM(net_sales),0),
    'cogs', COALESCE(SUM(cogs),0),
    'gross_profit', COALESCE(SUM(gross_profit),0),
    'gross_margin_pct', CASE WHEN COALESCE(SUM(net_sales),0)>0 THEN ROUND(SUM(gross_profit)/SUM(net_sales)*100,2) ELSE 0 END,
    'payment_fees', COALESCE(SUM(payment_fees),0),
    'operating_expenses', COALESCE(SUM(operating_expenses),0),
    'employee_salaries', COALESCE(SUM(employee_salaries),0),
    'operating_result', COALESCE(SUM(operating_result),0)
  ) INTO v_prof
  FROM v_finance_pnl WHERE business_id=p_business_id AND period_date BETWEEN p_date_from AND p_date_to;

  SELECT jsonb_build_object(
    'net_sales', COALESCE(SUM(net_sales),0),
    'gross_profit', COALESCE(SUM(gross_profit),0),
    'operating_result', COALESCE(SUM(operating_result),0)
  ) INTO v_prof_prev
  FROM v_finance_pnl WHERE business_id=p_business_id AND period_date BETWEEN v_prev_from AND v_prev_to;

  -- ── Flujo de caja (percibido) por clase ─────────────────────────────────
  SELECT jsonb_build_object(
    'net_ars', COALESCE(SUM(net_ars),0),
    'income_ars', COALESCE(SUM(income_ars),0),
    'expense_ars', COALESCE(SUM(expense_ars),0),
    'by_class', COALESCE((
      SELECT jsonb_object_agg(cashflow_class, cls_net) FROM (
        SELECT cashflow_class, ROUND(SUM(net_ars),2) cls_net FROM v_finance_cashflow
        WHERE business_id=p_business_id AND movement_date_ar BETWEEN p_date_from AND p_date_to GROUP BY 1
      ) x
    ), '{}'::jsonb),
    'by_method', COALESCE((
      SELECT jsonb_object_agg(COALESCE(payment_method,'otro'), m_net) FROM (
        SELECT payment_method, ROUND(SUM(net_ars),2) m_net FROM v_finance_cashflow
        WHERE business_id=p_business_id AND movement_date_ar BETWEEN p_date_from AND p_date_to GROUP BY 1
      ) y
    ), '{}'::jsonb)
  ) INTO v_cash
  FROM v_finance_cashflow WHERE business_id=p_business_id AND movement_date_ar BETWEEN p_date_from AND p_date_to;

  -- ── Posición (snapshot actual, no depende del período) ──────────────────
  SELECT to_jsonb(p) INTO v_pos FROM (
    SELECT cash_total, cash_by_method, inventory_at_cost, receivables, payables,
           owner_withdrawals_total, owner_contributions_total, owner_net_capital
    FROM v_finance_position WHERE business_id=p_business_id
  ) p;

  -- ── Calidad de datos ────────────────────────────────────────────────────
  SELECT jsonb_build_object(
    'unclassified_amount', COALESCE((SELECT (data_quality_flags->>'unclassified_amount')::numeric FROM v_finance_position WHERE business_id=p_business_id),0),
    'unclassified_count', COALESCE((SELECT (data_quality_flags->>'unclassified_count')::int FROM v_finance_position WHERE business_id=p_business_id),0),
    'missing_cost_items', COALESCE((SELECT SUM((data_quality_flags->>'missing_cost_items')::int) FROM v_finance_pnl WHERE business_id=p_business_id AND period_date BETWEEN p_date_from AND p_date_to),0),
    'fm_sin_caja', COALESCE((SELECT count(*) FROM financial_movements WHERE business_id=p_business_id AND caja_id IS NULL),0),
    'comprobantes_desincronizados', COALESCE((SELECT count(*) FROM comprobantes c WHERE c.business_id=p_business_id AND abs(COALESCE(c.total_cobrado,0)-(SELECT COALESCE(SUM(amount_ars),0) FROM comprobante_payments p WHERE p.comprobante_id=c.id))>1),0)
  ) INTO v_quality;

  RETURN jsonb_build_object(
    'ok', true,
    'finance_model_version', 2,
    'generated_at', now(),
    'timezone', 'America/Argentina/Cordoba',
    'period', jsonb_build_object('from', p_date_from, 'to', p_date_to),
    'profitability', v_prof,
    'cashflow', v_cash,
    'position', COALESCE(v_pos, '{}'::jsonb),
    'data_quality', v_quality,
    'comparison', jsonb_build_object('previous_period', jsonb_build_object('from', v_prev_from, 'to', v_prev_to), 'profitability', v_prof_prev)
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

ALTER FUNCTION "public"."finance_dashboard_summary"(uuid, date, date) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."finance_dashboard_summary"(uuid, date, date) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."finance_dashboard_summary"(uuid, date, date) TO "authenticated", "service_role";

-- ============================================================================
-- ROLLBACK: recrear finance_dashboard_summary con el cuerpo del baseline
-- 20260628190324 (versión BFE-based). No se borran las vistas acá.
-- ============================================================================
