-- ============================================================================
-- M7 Lote 6F.4 — FASE C: fuente contable devengada (vistas).
--
-- SEPARADO de 20260713250000 en el Lote 7B.1 para permitir un release por fases:
--   Fase A (…250000 + …260000): esquema, guards, helpers y RPC. NO cambian la
--                               interpretacion historica del P&L.
--   Fase B (docs/…/m7-7b-reconcile-legacy-annulment.sql): reconciliacion de la
--                               anulacion legacy del remito ac3b00ef…fbe1.
--   Fase C (ESTE archivo):      activa el ledger devengado y sus consumidores.
--
-- POR QUE ESTE ORDEN: activar el ledger ANTES de reconciliar el remito abriria
-- una ventana en la que el P&L de 2026-05 del negocio aa930802… muestra un
-- restatement de +138.574 sin compensacion. Con este orden no hay ninguna
-- ventana logica con P&L inconsistente.
--
-- Contenido funcional IDENTICO al original: solo se movio de archivo.
-- DEPENDE DE: comprobante_annulments.annulment_date y .status (Fase A, …250000).
--
-- ROLLBACK: recrear v_finance_pnl y v_finance_product_margin sobre
--   v_finance_effective_comprobantes (definiciones de 20260704120000) y
--   DROP VIEW v_finance_sales_ledger. Vuelve la exclusion retroactiva, que es
--   exactamente el comportamiento productivo previo a M7.
-- ============================================================================

-- ============================================================================
-- §B — v_finance_sales_ledger: fuente canonica de eventos DEVENGADOS
-- ============================================================================
-- Granularidad: UNA FILA POR (item, evento).
--   Desvio documentado respecto del boceto "una fila por comprobante": el
--   consumidor v_finance_product_margin necesita inventory_id, y el P&L necesita
--   gross/discount/net/cogs por linea. Agregando por comprobante_id se obtiene
--   exactamente la forma comprobante-level del boceto.
--
-- event_type='sale'      -> fecha ORIGINAL, importes POSITIVOS.
-- event_type='annulment' -> fecha de ANULACION, importes NEGATIVOS (espejo).
--
-- El comprobante sigue emitiendo su evento de venta aunque despues haya sido
-- anulado: la historia contable no se reescribe, se compensa.
CREATE OR REPLACE VIEW "public"."v_finance_sales_ledger" AS
WITH eff AS (
  -- Mismo predicado de "comprobante efectivo" que v_finance_effective_comprobantes,
  -- SIN el filtro de anulados (esa vista conserva la semantica de estado actual).
  SELECT c.id, c.business_id, c.customer_id, c.order_id, c.total,
         (COALESCE(c.fecha, c.date, c.created_at) AT TIME ZONE 'America/Argentina/Cordoba')::date AS period_date,
         COALESCE(c.tipo, c.type) = 'nota_credito' AS is_credit_note
  FROM comprobantes c
  WHERE (
        (COALESCE(c.status, c.estado) = ANY (ARRAY['issued'::text, 'emitido'::text]))
     OR EXISTS (SELECT 1 FROM comprobante_payments p WHERE p.comprobante_id = c.id)
     OR EXISTS (SELECT 1 FROM comprobante_items ci WHERE ci.comprobante_id = c.id AND ci.stock_processed = true)
     OR EXISTS (SELECT 1 FROM account_movements am
                 WHERE am.reference_type = 'comprobante' AND am.reference_id = c.id AND am.type = 'venta')
     -- Un registro de anulacion PRUEBA que la venta fue efectiva cuando se anulo.
     -- Sin esto la venta se caeria del ledger igual: la RPC pone status='cancelled'
     -- y resetea stock_processed=false, con lo que un comprobante que solo
     -- calificaba por stock dejaria de calificar DESPUES de anularse (segunda via
     -- de reescritura retroactiva, cerrada aca).
     OR EXISTS (SELECT 1 FROM comprobante_annulments a
                 WHERE a.comprobante_id = c.id AND a.status = 'completed')
  )
), ann AS (
  SELECT a.comprobante_id, a.id AS annulment_id, a.business_id,
         -- Fecha economica canonica; para filas M6 (annulment_date NULL) se deriva
         -- de created_at. Nunca now()/ar_today() dentro de la vista.
         COALESCE(a.annulment_date,
                  (a.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date) AS period_date
  FROM comprobante_annulments a
  WHERE a.status = 'completed'
)
SELECT e.business_id, 'sale'::text AS event_type, e.period_date,
       e.id AS comprobante_id, NULL::uuid AS annulment_id,
       e.customer_id, e.order_id, e.is_credit_note,
       ci.id AS comprobante_item_id, ci.inventory_id, ci.tipo_linea, ci.descripcion,
       ci.cantidad AS quantity,
       ci.precio_unitario * ci.cantidad AS gross_amount_ars,
       ci.precio_unitario * ci.cantidad * COALESCE(ci.descuento_linea, 0::numeric) / 100.0 AS discount_amount_ars,
       ci.subtotal AS sales_amount_ars,
       ci.costo_total AS cogs_amount_ars,
       (ci.inventory_id IS NOT NULL AND COALESCE(ci.costo_unitario, 0::numeric) = 0::numeric
        AND (ci.tipo_linea = ANY (ARRAY['producto'::text, 'repuesto'::text]))) AS missing_cost,
       e.total AS comprobante_total
FROM eff e
  JOIN comprobante_items ci ON ci.comprobante_id = e.id
UNION ALL
SELECT e.business_id, 'annulment'::text, a.period_date,
       e.id, a.annulment_id,
       e.customer_id, e.order_id, e.is_credit_note,
       ci.id, ci.inventory_id, ci.tipo_linea, ci.descripcion,
       -ci.cantidad,
       -(ci.precio_unitario * ci.cantidad),
       -(ci.precio_unitario * ci.cantidad * COALESCE(ci.descuento_linea, 0::numeric) / 100.0),
       -ci.subtotal,
       -ci.costo_total,
       false,
       -e.total
FROM eff e
  JOIN ann a ON a.comprobante_id = e.id AND a.business_id = e.business_id
  JOIN comprobante_items ci ON ci.comprobante_id = e.id;

COMMENT ON VIEW "public"."v_finance_sales_ledger" IS
  'M7 6F.4 — Fuente canonica APPEND-ONLY de eventos devengados de venta. Una fila '
  'por (item, evento). event_type=sale en la fecha original con importes '
  'positivos; event_type=annulment en la fecha economica de la anulacion con '
  'importes negativos. La venta original NUNCA desaparece de su periodo: la '
  'anulacion se registra como compensacion en SU periodo. Usar esta vista para '
  'P&L/COGS/margen/historia; usar v_finance_effective_comprobantes para estado '
  'operativo actual (deuda vigente, aging, acciones).';

ALTER VIEW "public"."v_finance_sales_ledger" OWNER TO "postgres";
GRANT SELECT ON "public"."v_finance_sales_ledger" TO "authenticated";
GRANT SELECT ON "public"."v_finance_sales_ledger" TO "service_role";

-- ============================================================================
-- §C — Consumidores ACCRUAL_HISTORY migrados al ledger
-- ============================================================================
-- v_finance_pnl: los CTE sales pasan a leer el ledger. El CTE returns (notas de
-- credito) NO se toca: la semantica fiscal de NC queda exactamente como estaba
-- (§5 — no hay doble reversion posible, ver informe).
CREATE OR REPLACE VIEW "public"."v_finance_pnl" AS
WITH sales AS (
  SELECT l.business_id, l.period_date,
         sum(l.gross_amount_ars) AS gross_sales,
         sum(l.discount_amount_ars) AS discounts,
         sum(l.sales_amount_ars) AS net_line_sales,
         sum(l.cogs_amount_ars) AS cogs,
         count(*) FILTER (WHERE l.missing_cost) AS missing_cost_items
  FROM v_finance_sales_ledger l
  WHERE l.is_credit_note = false
  GROUP BY l.business_id, l.period_date
), returns AS (
  SELECT e_1.business_id, e_1.period_date, sum(e_1.total) AS sales_returns
  FROM v_finance_effective_comprobantes e_1
  WHERE e_1.is_credit_note = true
  GROUP BY e_1.business_id, e_1.period_date
), expenses AS (
  SELECT b.business_id, b.date AS period_date,
         sum(b.amount_ars) FILTER (WHERE b.economic_class = 'payment_fee'::text) AS payment_fees,
         sum(b.amount_ars) FILTER (WHERE b.economic_class = 'operating_expense'::text) AS operating_expenses,
         sum(b.amount_ars) FILTER (WHERE b.economic_class = 'employee_salary'::text) AS employee_salaries,
         sum(b.amount_ars) FILTER (WHERE b.economic_class = 'legacy_unclassified'::text) AS unclassified_amount
  FROM business_finance_entries b
  GROUP BY b.business_id, b.date
), keys AS (
  SELECT sales.business_id, sales.period_date FROM sales
  UNION
  SELECT returns.business_id, returns.period_date FROM returns
  UNION
  SELECT expenses.business_id, expenses.period_date FROM expenses
)
SELECT k.business_id, k.period_date,
   to_char(k.period_date::timestamp with time zone, 'YYYY-MM'::text) AS period_month,
   round(COALESCE(s.gross_sales, 0::numeric), 2) AS gross_sales,
   round(COALESCE(s.discounts, 0::numeric), 2) AS discounts,
   round(COALESCE(r.sales_returns, 0::numeric), 2) AS sales_returns,
   round(COALESCE(s.net_line_sales, 0::numeric) - COALESCE(r.sales_returns, 0::numeric), 2) AS net_sales,
   round(COALESCE(s.cogs, 0::numeric), 2) AS cogs,
   round(COALESCE(s.net_line_sales, 0::numeric) - COALESCE(r.sales_returns, 0::numeric) - COALESCE(s.cogs, 0::numeric), 2) AS gross_profit,
   round(COALESCE(e.payment_fees, 0::numeric), 2) AS payment_fees,
   round(COALESCE(e.operating_expenses, 0::numeric), 2) AS operating_expenses,
   round(COALESCE(e.employee_salaries, 0::numeric), 2) AS employee_salaries,
   round(COALESCE(s.net_line_sales, 0::numeric) - COALESCE(r.sales_returns, 0::numeric) - COALESCE(s.cogs, 0::numeric) - COALESCE(e.payment_fees, 0::numeric) - COALESCE(e.operating_expenses, 0::numeric) - COALESCE(e.employee_salaries, 0::numeric), 2) AS operating_result,
   jsonb_build_object('missing_cost_items', COALESCE(s.missing_cost_items, 0::bigint), 'unclassified_amount', round(COALESCE(e.unclassified_amount, 0::numeric), 2)) AS data_quality_flags
FROM keys k
  LEFT JOIN sales s ON s.business_id = k.business_id AND s.period_date = k.period_date
  LEFT JOIN returns r ON r.business_id = k.business_id AND r.period_date = k.period_date
  LEFT JOIN expenses e ON e.business_id = k.business_id AND e.period_date = k.period_date;

-- v_finance_product_margin: mismo cambio de fuente. Un producto vendido y luego
-- anulado neteaba 0 antes (por exclusion) y netea 0 ahora (por compensacion),
-- pero ahora el hecho economico queda visible en cada periodo.
CREATE OR REPLACE VIEW "public"."v_finance_product_margin" AS
SELECT l.business_id, l.inventory_id,
   max(l.descripcion) AS product_name,
   round(sum(l.sales_amount_ars), 2) AS net_sales,
   round(sum(l.cogs_amount_ars), 2) AS cogs,
   round(sum(l.sales_amount_ars) - sum(l.cogs_amount_ars), 2) AS gross_profit,
   CASE WHEN sum(l.sales_amount_ars) > 0::numeric
        THEN round((sum(l.sales_amount_ars) - sum(l.cogs_amount_ars)) / sum(l.sales_amount_ars) * 100::numeric, 2)
        ELSE NULL::numeric END AS margin_pct,
   round(sum(l.quantity), 2) AS units,
   count(DISTINCT l.comprobante_id) AS operations,
   count(*) FILTER (WHERE l.missing_cost) AS missing_cost_count
FROM v_finance_sales_ledger l
WHERE l.is_credit_note = false AND l.inventory_id IS NOT NULL
GROUP BY l.business_id, l.inventory_id;

