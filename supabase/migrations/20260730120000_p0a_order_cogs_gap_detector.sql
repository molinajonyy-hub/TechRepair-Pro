-- ============================================================================
-- P0-A — Detector canónico de huecos de COGS de órdenes.
--
-- POR QUE EXISTE: el COGS del modelo canónico existe SOLO como snapshot en
-- comprobante_items.costo_total. El armado de ítems excluía del comprobante toda
-- línea de repuesto con cliente_paga_repuesto=false (el 100 % de los repuestos
-- productivos), así que el repuesto consumido no generaba costo alguno mientras
-- el ingreso se reconocía completo. El flag `missing_cost` de
-- v_finance_sales_ledger es CIEGO a ese caso porque exige inventory_id NOT NULL
-- y tipo_linea IN ('producto','repuesto'): las líneas que perdían el costo son
-- 'servicio' con inventory_id NULL.
--
-- Esta vista es el check canónico que faltaba. NO se toca `missing_cost`: su
-- semántica actual (ítem de inventario facturado sin costo resuelto) es correcta
-- y otros consumidores la usan. Se agrega una dimensión nueva en vez de
-- ensanchar una existente — mismo criterio que 6F.4 con el ledger devengado.
--
-- READ-ONLY: es una vista. No corrige, no reconcilia, no escribe.
-- AISLAMIENTO: security_invoker = true ⇒ respeta la RLS de orders, order_items,
-- order_parts, comprobantes y comprobante_items. Un negocio nunca ve otro.
--
-- CONSUMIDORES: Health Check / reconciliación, el dry-run de P0-B y los tests
-- supabase/tests/p0a_order_cogs_test.sql.
--
-- ROLLBACK: DROP VIEW IF EXISTS public.v_finance_order_cogs_gaps;
-- ============================================================================

CREATE OR REPLACE VIEW "public"."v_finance_order_cogs_gaps"
  WITH (security_invoker = true) AS
WITH costo_items AS (
  -- order_items es la fuente AUTORITATIVA del costo consumido: su inserción es
  -- la que movió el stock (trigger adjust_stock_on_order_item).
  SELECT oi.order_id, oi.business_id,
    SUM(oi.costo_unitario * oi.cantidad) FILTER (WHERE oi.tipo = 'repuesto') AS costo_repuestos,
    SUM(oi.costo_unitario * oi.cantidad) FILTER (WHERE oi.tipo = 'servicio')  AS costo_servicios,
    count(*) FILTER (WHERE oi.tipo = 'repuesto' AND COALESCE(oi.costo_unitario, 0) = 0) AS repuestos_sin_snapshot,
    count(*) FILTER (WHERE oi.tipo = 'repuesto') AS repuestos
  FROM order_items oi
  GROUP BY 1, 2
),
costo_parts AS (
  -- order_parts SIN gemelo en order_items (repuestos cargados por
  -- orderPartsService sin vínculo a inventario). Solo estados consumidos:
  -- 'returned'/'pending' no son COGS.
  SELECT p.order_id, p.business_id,
    SUM(p.internal_cost * p.quantity) AS costo_parts_sueltos,
    count(*) FILTER (WHERE COALESCE(p.internal_cost, 0) = 0) AS parts_sin_snapshot
  FROM order_parts p
  WHERE COALESCE(p.status, 'used') IN ('used', 'sold')
    AND NOT EXISTS (
      SELECT 1 FROM order_items i
      WHERE i.order_id = p.order_id AND i.tipo = 'repuesto' AND i.descripcion = p.name
    )
  GROUP BY 1, 2
),
cogs_reconocido AS (
  -- COGS efectivamente devengado en los comprobantes VINCULADOS a la orden.
  -- Solo comprobantes comercialmente efectivos y sin contar notas de crédito.
  SELECT c.order_id, c.business_id,
    SUM(ci.costo_total) AS cogs_ars,
    count(DISTINCT c.id)  AS comprobantes
  FROM comprobantes c
  JOIN v_finance_effective_comprobantes e ON e.id = c.id AND e.is_credit_note = false
  JOIN comprobante_items ci ON ci.comprobante_id = c.id
  WHERE c.order_id IS NOT NULL
  GROUP BY 1, 2
),
base AS (
  SELECT o.id AS order_id, o.business_id, o.status AS order_status,
    (o.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date AS order_date,
    ROUND(COALESCE(ci.costo_repuestos, 0) + COALESCE(cp.costo_parts_sueltos, 0), 2) AS costo_repuestos_ars,
    ROUND(COALESCE(ci.costo_servicios, 0), 2) AS costo_servicios_ars,
    ROUND(COALESCE(ci.costo_repuestos, 0) + COALESCE(cp.costo_parts_sueltos, 0)
          + COALESCE(ci.costo_servicios, 0), 2) AS costo_atribuible_ars,
    COALESCE(ci.repuestos, 0) AS repuestos,
    COALESCE(ci.repuestos_sin_snapshot, 0) + COALESCE(cp.parts_sin_snapshot, 0) AS sin_snapshot,
    ROUND(COALESCE(cg.cogs_ars, 0), 2) AS cogs_reconocido_ars,
    COALESCE(cg.comprobantes, 0) AS comprobantes_vinculados
  FROM orders o
  LEFT JOIN costo_items     ci ON ci.order_id = o.id
  LEFT JOIN costo_parts     cp ON cp.order_id = o.id
  LEFT JOIN cogs_reconocido cg ON cg.order_id = o.id
)
-- ── 1. Orden con costo atribuible y SIN comprobante vinculado ───────────────
-- Cubre los dos casos históricos: la orden nunca se facturó (legítimo si sigue
-- abierta) y la orden se facturó con un comprobante que quedó sin order_id
-- (el defecto de trazabilidad: 3 de 277 comprobantes tenían el vínculo).
SELECT b.business_id, b.order_id, b.order_status, b.order_date,
  'orden_sin_comprobante_vinculado'::text AS gap_type,
  CASE WHEN b.order_status IN ('completed', 'ready_delivery') THEN 'critical' ELSE 'warning' END AS severity,
  b.costo_atribuible_ars AS gap_ars,
  b.costo_atribuible_ars, b.costo_repuestos_ars, b.costo_servicios_ars,
  b.cogs_reconocido_ars, b.comprobantes_vinculados, b.sin_snapshot,
  'Orden con costo atribuible y ningún comprobante efectivo vinculado (order_id NULL o sin facturar)'::text AS detalle
FROM base b
WHERE b.costo_atribuible_ars > 0.01 AND b.comprobantes_vinculados = 0
  AND b.order_status <> 'cancelled'

UNION ALL

-- ── 2. Orden facturada con COGS incompleto ─────────────────────────────────
-- El caso que este P0 corrige: hay comprobante vinculado y efectivo, pero el
-- costo atribuible de la orden no llegó entero a comprobante_items.
SELECT b.business_id, b.order_id, b.order_status, b.order_date,
  'cogs_incompleto'::text,
  'critical'::text,
  ROUND(b.costo_atribuible_ars - b.cogs_reconocido_ars, 2),
  b.costo_atribuible_ars, b.costo_repuestos_ars, b.costo_servicios_ars,
  b.cogs_reconocido_ars, b.comprobantes_vinculados, b.sin_snapshot,
  'Comprobante vinculado con COGS menor al costo atribuible de la orden'::text
FROM base b
WHERE b.comprobantes_vinculados > 0
  AND b.costo_atribuible_ars - b.cogs_reconocido_ars > 0.01

UNION ALL

-- ── 3. Snapshot de costo faltante ──────────────────────────────────────────
-- Un repuesto consumido con costo 0 puede ser legítimo, pero NUNCA debe pasar
-- silenciosamente: sin snapshot no hay COGS reconstruible y el backfill no
-- puede inventarlo con el costo actual del inventario.
SELECT b.business_id, b.order_id, b.order_status, b.order_date,
  'snapshot_de_costo_faltante'::text,
  'warning'::text,
  0::numeric,
  b.costo_atribuible_ars, b.costo_repuestos_ars, b.costo_servicios_ars,
  b.cogs_reconocido_ars, b.comprobantes_vinculados, b.sin_snapshot,
  'Repuestos consumidos sin costo snapshot (costo_unitario/internal_cost = 0)'::text
FROM base b
WHERE b.sin_snapshot > 0

UNION ALL

-- ── 4. Riesgo de doble descuento de stock ──────────────────────────────────
-- Una línea de comprobante con inventory_id, en un comprobante vinculado a una
-- orden que YA consumió ese mismo producto, descuenta stock por segunda vez
-- (order_items lo descontó al agregarlo). El armado corregido manda
-- inventory_id NULL en toda línea derivada de la orden; este check vigila que
-- no reaparezca por otra vía.
SELECT c.business_id, c.order_id, o.status, (c.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date,
  'riesgo_doble_stock'::text,
  'critical'::text,
  0::numeric,
  0::numeric, 0::numeric, 0::numeric, 0::numeric, 1, 0,
  ('Línea con inventory_id sobre un producto ya consumido por la orden: ' || ci.descripcion)::text
FROM comprobantes c
JOIN orders o ON o.id = c.order_id
JOIN comprobante_items ci ON ci.comprobante_id = c.id
WHERE c.order_id IS NOT NULL
  AND ci.inventory_id IS NOT NULL
  AND ci.stock_processed = true
  AND EXISTS (
    SELECT 1 FROM order_items oi
    WHERE oi.order_id = c.order_id AND oi.tipo = 'repuesto' AND oi.product_id = ci.inventory_id
  );

COMMENT ON VIEW "public"."v_finance_order_cogs_gaps" IS
  'P0-A — Detector canónico de COGS de órdenes no reconocido. Cuatro dimensiones: '
  'orden_sin_comprobante_vinculado (incluye el defecto histórico de order_id NULL), '
  'cogs_incompleto (costo atribuible que no llegó a comprobante_items), '
  'snapshot_de_costo_faltante (repuesto consumido con costo 0: nunca pasa como cero '
  'silencioso) y riesgo_doble_stock. Complementa —no reemplaza— el flag missing_cost '
  'de v_finance_sales_ledger, que es ciego a las líneas de servicio con inventory_id NULL. '
  'READ-ONLY y con security_invoker: respeta la RLS de todas sus tablas base.';

ALTER VIEW "public"."v_finance_order_cogs_gaps" OWNER TO "postgres";
GRANT SELECT ON "public"."v_finance_order_cogs_gaps" TO "authenticated";
GRANT SELECT ON "public"."v_finance_order_cogs_gaps" TO "service_role";
