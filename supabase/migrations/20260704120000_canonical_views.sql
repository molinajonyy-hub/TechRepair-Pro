-- ============================================================================
-- M5 — canonical_views (Etapa 1)
--
-- Fuente ÚNICA de verdad financiera para toda la app. Ninguna métrica se
-- agrega en JS: se lee de estas vistas (vía RPC finance_dashboard_summary v2).
--
-- Seguridad: todas las vistas son WITH (security_invoker = true) → respetan la
-- RLS de las tablas subyacentes (comprobantes, comprobante_items, BFE, FM,
-- accounts, supplier_*). Un usuario nunca ve otro negocio. La RPC del
-- dashboard (SECURITY DEFINER) agrega ownership check explícito.
--
-- Tres ejes separados (contrato Etapa 1):
--   v_finance_pnl        — rentabilidad (devengado, por ítems)
--   v_finance_cashflow   — flujo de caja (percibido, por FM clasificado)
--   v_finance_position   — posición (caja, inventario, CxC, CxP, capital)
-- + aging CxC/CxP, margen por producto, flujos del propietario.
--
-- REGLA legacy_effective (Fase 6): un comprobante es comercialmente EFECTIVO si
-- no está anulado y (status='issued' OR tiene pagos OR tiene stock procesado OR
-- generó deuda de venta en CC). Esto incluye los drafts legacy con efectos
-- reales (Clic operó casi todo así) sin cambiar su status. Un draft VACÍO
-- (sin efectos) NO es venta y queda fuera; se expone como anomalía de calidad.
-- ============================================================================

-- ── Helper: comprobantes comercialmente efectivos ───────────────────────────
CREATE OR REPLACE VIEW "public"."v_finance_effective_comprobantes"
  WITH (security_invoker = true) AS
SELECT
  c.id, c.business_id,
  (COALESCE(c.fecha, c.date, c.created_at) AT TIME ZONE 'America/Argentina/Cordoba')::date AS period_date,
  COALESCE(c.tipo, c.type) AS tipo,
  (COALESCE(c.tipo, c.type) = 'nota_credito') AS is_credit_note,
  (COALESCE(c.status, c.estado) = 'draft' OR c.estado='borrador') AS is_legacy_draft,
  c.total, c.total_bruto, c.saldo_pendiente, c.total_cobrado, c.customer_id
FROM comprobantes c
WHERE c.estado NOT IN ('anulado')
  AND COALESCE(c.estado_comercial,'') <> 'anulado'
  AND (
    COALESCE(c.status, c.estado) IN ('issued','emitido')
    OR EXISTS (SELECT 1 FROM comprobante_payments p WHERE p.comprobante_id=c.id)
    OR EXISTS (SELECT 1 FROM comprobante_items ci WHERE ci.comprobante_id=c.id AND ci.stock_processed=true)
    OR EXISTS (SELECT 1 FROM account_movements am WHERE am.reference_type='comprobante' AND am.reference_id=c.id AND am.type='venta')
  );

GRANT SELECT ON "public"."v_finance_effective_comprobantes" TO "authenticated", "service_role";

-- ── v_finance_pnl — rentabilidad devengada por (negocio, día AR) ─────────────
CREATE OR REPLACE VIEW "public"."v_finance_pnl"
  WITH (security_invoker = true) AS
WITH sales AS (  -- ventas y COGS desde ítems del conjunto efectivo (NO NC)
  SELECT e.business_id, e.period_date,
    SUM(ci.precio_unitario * ci.cantidad)                                    AS gross_sales,
    SUM(ci.precio_unitario * ci.cantidad * COALESCE(ci.descuento_linea,0)/100.0) AS discounts,
    SUM(ci.subtotal)                                                          AS net_line_sales,
    SUM(ci.costo_total)                                                       AS cogs,
    count(*) FILTER (WHERE ci.inventory_id IS NOT NULL AND COALESCE(ci.costo_unitario,0)=0 AND ci.tipo_linea IN ('producto','repuesto')) AS missing_cost_items
  FROM v_finance_effective_comprobantes e
  JOIN comprobante_items ci ON ci.comprobante_id = e.id
  WHERE e.is_credit_note = false
  GROUP BY 1,2
),
returns AS (  -- notas de crédito efectivas (restan de ventas)
  SELECT e.business_id, e.period_date, SUM(e.total) AS sales_returns
  FROM v_finance_effective_comprobantes e WHERE e.is_credit_note = true GROUP BY 1,2
),
expenses AS (  -- gastos del P&L desde BFE clasificado (SOLO las 3 clases P&L)
  SELECT b.business_id, b.date AS period_date,
    SUM(b.amount_ars) FILTER (WHERE b.economic_class='payment_fee')       AS payment_fees,
    SUM(b.amount_ars) FILTER (WHERE b.economic_class='operating_expense') AS operating_expenses,
    SUM(b.amount_ars) FILTER (WHERE b.economic_class='employee_salary')   AS employee_salaries,
    SUM(b.amount_ars) FILTER (WHERE b.economic_class='legacy_unclassified') AS unclassified_amount
  FROM business_finance_entries b GROUP BY 1,2
),
keys AS (
  SELECT business_id, period_date FROM sales
  UNION SELECT business_id, period_date FROM returns
  UNION SELECT business_id, period_date FROM expenses
)
SELECT
  k.business_id,
  k.period_date,
  to_char(k.period_date,'YYYY-MM') AS period_month,
  ROUND(COALESCE(s.gross_sales,0),2)      AS gross_sales,
  ROUND(COALESCE(s.discounts,0),2)        AS discounts,
  ROUND(COALESCE(r.sales_returns,0),2)    AS sales_returns,
  ROUND(COALESCE(s.net_line_sales,0) - COALESCE(r.sales_returns,0),2) AS net_sales,
  ROUND(COALESCE(s.cogs,0),2)             AS cogs,
  ROUND(COALESCE(s.net_line_sales,0) - COALESCE(r.sales_returns,0) - COALESCE(s.cogs,0),2) AS gross_profit,
  ROUND(COALESCE(e.payment_fees,0),2)     AS payment_fees,
  ROUND(COALESCE(e.operating_expenses,0),2) AS operating_expenses,
  ROUND(COALESCE(e.employee_salaries,0),2)  AS employee_salaries,
  ROUND(
    COALESCE(s.net_line_sales,0) - COALESCE(r.sales_returns,0) - COALESCE(s.cogs,0)
    - COALESCE(e.payment_fees,0) - COALESCE(e.operating_expenses,0) - COALESCE(e.employee_salaries,0)
  ,2) AS operating_result,
  jsonb_build_object(
    'missing_cost_items', COALESCE(s.missing_cost_items,0),
    'unclassified_amount', ROUND(COALESCE(e.unclassified_amount,0),2)
  ) AS data_quality_flags
FROM keys k
LEFT JOIN sales s   ON s.business_id=k.business_id AND s.period_date=k.period_date
LEFT JOIN returns r ON r.business_id=k.business_id AND r.period_date=k.period_date
LEFT JOIN expenses e ON e.business_id=k.business_id AND e.period_date=k.period_date;

GRANT SELECT ON "public"."v_finance_pnl" TO "authenticated", "service_role";

-- ── v_finance_cashflow — percibido, por FM clasificado ──────────────────────
CREATE OR REPLACE VIEW "public"."v_finance_cashflow"
  WITH (security_invoker = true) AS
SELECT
  fm.business_id,
  (COALESCE(fm.date::timestamp, fm.created_at) AT TIME ZONE 'America/Argentina/Cordoba')::date AS movement_date_ar,
  fm.source, fm.source_id,
  CASE
    WHEN fm.reference_type='annulment_reversal' OR COALESCE(fm.sign,1)=-1 THEN 'reversal'
    WHEN fm.source='owner_withdrawal'   THEN 'capital'
    WHEN fm.source='owner_contribution' THEN 'capital'
    WHEN fm.source='pago_proveedor'     THEN 'supplier'
    WHEN fm.reference_type='manual_correction' THEN 'adjustment'
    WHEN fm.source IN ('comprobante','payment','cobro_rapido') THEN 'operating'
    WHEN fm.source IN ('expense','create_expense_with_finance') THEN 'operating'
    WHEN fm.source='manual' THEN 'adjustment'
    ELSE 'operating'
  END AS cashflow_class,
  fm.metodo_pago AS payment_method,
  fm.currency,
  CASE WHEN fm.type='income'  AND COALESCE(fm.sign,1)=1 THEN fm.amount_ars ELSE 0 END AS income_ars,
  CASE WHEN fm.type='expense' OR COALESCE(fm.sign,1)=-1 THEN fm.amount_ars ELSE 0 END AS expense_ars,
  CASE WHEN fm.type='income' AND COALESCE(fm.sign,1)=1 THEN fm.amount_ars
       ELSE -fm.amount_ars END AS net_ars,
  (fm.reference_type='annulment_reversal' OR COALESCE(fm.sign,1)=-1) AS is_reversal,
  fm.caja_id
FROM financial_movements fm;

GRANT SELECT ON "public"."v_finance_cashflow" TO "authenticated", "service_role";

-- ── v_finance_payables_aging — CxP por antigüedad (ledger real) ─────────────
CREATE OR REPLACE VIEW "public"."v_finance_payables_aging"
  WITH (security_invoker = true) AS
SELECT sp.business_id,
  CASE
    WHEN public.ar_today() - sp.purchase_date <= 7  THEN '0-7'
    WHEN public.ar_today() - sp.purchase_date <= 30 THEN '8-30'
    WHEN public.ar_today() - sp.purchase_date <= 60 THEN '31-60'
    ELSE '60+'
  END AS bucket,
  ROUND(SUM(sp.pending_amount),2) AS amount,
  count(*) AS purchases
FROM supplier_purchases sp
WHERE sp.pending_amount > 0.01
GROUP BY 1,2;

GRANT SELECT ON "public"."v_finance_payables_aging" TO "authenticated", "service_role";

-- ── v_finance_receivables_aging — CxC por antigüedad ────────────────────────
-- CxC = saldo pendiente de VENTAS EFECTIVAS con deudor (customer). Un draft
-- vacío sin cliente no es una cuenta por cobrar.
CREATE OR REPLACE VIEW "public"."v_finance_receivables_aging"
  WITH (security_invoker = true) AS
SELECT c.business_id,
  CASE
    WHEN public.ar_today() - e.period_date <= 7  THEN '0-7'
    WHEN public.ar_today() - e.period_date <= 30 THEN '8-30'
    WHEN public.ar_today() - e.period_date <= 60 THEN '31-60'
    ELSE '60+'
  END AS bucket,
  ROUND(SUM(c.saldo_pendiente),2) AS amount,
  count(*) AS comprobantes
FROM comprobantes c
JOIN v_finance_effective_comprobantes e ON e.id = c.id AND e.is_credit_note = false
WHERE c.saldo_pendiente > 0.01 AND c.customer_id IS NOT NULL
GROUP BY 1,2;

GRANT SELECT ON "public"."v_finance_receivables_aging" TO "authenticated", "service_role";

-- ── v_finance_product_margin — margen por producto (snapshots) ──────────────
CREATE OR REPLACE VIEW "public"."v_finance_product_margin"
  WITH (security_invoker = true) AS
SELECT
  ci.business_id,
  ci.inventory_id,
  MAX(ci.descripcion) AS product_name,
  ROUND(SUM(ci.subtotal),2) AS net_sales,
  ROUND(SUM(ci.costo_total),2) AS cogs,
  ROUND(SUM(ci.subtotal) - SUM(ci.costo_total),2) AS gross_profit,  -- pérdidas NO truncadas
  CASE WHEN SUM(ci.subtotal) > 0 THEN ROUND((SUM(ci.subtotal)-SUM(ci.costo_total))/SUM(ci.subtotal)*100,2) ELSE NULL END AS margin_pct,
  ROUND(SUM(ci.cantidad),2) AS units,
  count(DISTINCT ci.comprobante_id) AS operations,
  count(*) FILTER (WHERE COALESCE(ci.costo_unitario,0)=0 AND ci.tipo_linea IN ('producto','repuesto')) AS missing_cost_count
FROM comprobante_items ci
JOIN v_finance_effective_comprobantes e ON e.id = ci.comprobante_id AND e.is_credit_note = false
WHERE ci.inventory_id IS NOT NULL
GROUP BY 1,2;

GRANT SELECT ON "public"."v_finance_product_margin" TO "authenticated", "service_role";

-- ── v_owner_flows — retiros y aportes (dos patas), una fila por operación ────
CREATE OR REPLACE VIEW "public"."v_owner_flows"
  WITH (security_invoker = true) AS
SELECT
  ow.business_id, ow.id AS flow_id, ow.flow_type, ow.date, ow.amount, ow.currency,
  ow.destination_account_id, ow.personal_transaction_id, ow.business_financial_movement_id,
  ow.status, ow.notes
FROM owner_withdrawals ow;

GRANT SELECT ON "public"."v_owner_flows" TO "authenticated", "service_role";

-- ── v_finance_position — posición financiera (una fila por negocio) ──────────
CREATE OR REPLACE VIEW "public"."v_finance_position"
  WITH (security_invoker = true) AS
WITH cash AS (
  SELECT business_id,
    SUM(method_net) AS cash_total,
    jsonb_object_agg(payment_method, method_net) AS cash_by_method
  FROM (
    SELECT business_id, COALESCE(payment_method,'otro') AS payment_method, SUM(net_ars) AS method_net
    FROM v_finance_cashflow GROUP BY 1,2
  ) m GROUP BY business_id
),
inv AS (  -- inventario a costo histórico, excluyendo productos-padre con variantes
  SELECT i.business_id, ROUND(SUM(i.stock_quantity * COALESCE(i.cost_price,0)),2) AS inventory_at_cost
  FROM inventory i
  WHERE i.is_active = true AND COALESCE(i.tipo,'product')='product'
    AND NOT EXISTS (
      SELECT 1 FROM inventory v
      WHERE v.business_id=i.business_id AND v.supplier_code = 'VPREF-' || i.id::text
    )
  GROUP BY 1
),
recv AS (  -- CxC de ventas efectivas con deudor (consistente con el aging)
  SELECT c.business_id, ROUND(SUM(c.saldo_pendiente),2) AS receivables
  FROM comprobantes c
  JOIN v_finance_effective_comprobantes e ON e.id=c.id AND e.is_credit_note=false
  WHERE c.saldo_pendiente>0.01 AND c.customer_id IS NOT NULL
  GROUP BY 1
),
pay AS (  -- CxP del LEDGER REAL (no de accounts vacía)
  SELECT business_id, ROUND(SUM(debit-credit),2) AS payables
  FROM supplier_account_movements GROUP BY 1
),
owner AS (
  SELECT business_id,
    ROUND(SUM(amount) FILTER (WHERE flow_type='withdrawal' AND status='completed'),2) AS withdrawals_total,
    ROUND(SUM(amount) FILTER (WHERE flow_type='contribution' AND status='completed'),2) AS contributions_total
  FROM owner_withdrawals GROUP BY 1
),
quality AS (
  SELECT business_id,
    ROUND(SUM(amount_ars) FILTER (WHERE economic_class='legacy_unclassified'),2) AS unclassified_amount,
    count(*) FILTER (WHERE economic_class='legacy_unclassified') AS unclassified_count
  FROM business_finance_entries GROUP BY 1
),
bizs AS (
  SELECT id AS business_id FROM businesses
)
SELECT b.business_id,
  COALESCE(cash.cash_total,0)          AS cash_total,
  COALESCE(cash.cash_by_method,'{}'::jsonb) AS cash_by_method,
  COALESCE(inv.inventory_at_cost,0)    AS inventory_at_cost,
  COALESCE(recv.receivables,0)         AS receivables,
  COALESCE(pay.payables,0)             AS payables,
  COALESCE(owner.withdrawals_total,0)  AS owner_withdrawals_total,
  COALESCE(owner.contributions_total,0) AS owner_contributions_total,
  COALESCE(owner.contributions_total,0) - COALESCE(owner.withdrawals_total,0) AS owner_net_capital,
  jsonb_build_object(
    'unclassified_amount', COALESCE(quality.unclassified_amount,0),
    'unclassified_count',  COALESCE(quality.unclassified_count,0)
  ) AS data_quality_flags
FROM bizs b
LEFT JOIN cash    ON cash.business_id=b.business_id
LEFT JOIN inv     ON inv.business_id=b.business_id
LEFT JOIN recv    ON recv.business_id=b.business_id
LEFT JOIN pay     ON pay.business_id=b.business_id
LEFT JOIN owner   ON owner.business_id=b.business_id
LEFT JOIN quality ON quality.business_id=b.business_id
WHERE cash.business_id IS NOT NULL OR inv.business_id IS NOT NULL
   OR recv.business_id IS NOT NULL OR pay.business_id IS NOT NULL OR owner.business_id IS NOT NULL;

GRANT SELECT ON "public"."v_finance_position" TO "authenticated", "service_role";

-- ============================================================================
-- ROLLBACK (documentado): DROP VIEW IF EXISTS de las 8 vistas en orden inverso
--   (v_finance_position, v_owner_flows, v_finance_product_margin,
--    v_finance_receivables_aging, v_finance_payables_aging, v_finance_cashflow,
--    v_finance_pnl, v_finance_effective_comprobantes).
-- ============================================================================
