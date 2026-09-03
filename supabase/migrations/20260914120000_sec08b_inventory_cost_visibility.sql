-- ─────────────────────────────────────────────────────────────────────────────
-- SEC-08B — Visibilidad del COSTO INTERNO DE INVENTARIO
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Contrato a cerrar, medido contra `main` 2020a8d:
--
--     inventory            = true
--     inventory_view_costs = false
--       → el actor OPERA inventario (ve producto, stock, precio de venta)
--       → el actor NO recibe la verdad de costo interno
--
-- El rol `sales` es exactamente ese actor por defecto
-- (`private.capability_resolve`), y en el baseline recibía el costo por 14
-- rutas distintas: lectura directa, `select=*`, columna explícita, enumeración,
-- variante (`parent_id`), relación anidada, movimientos, compras, compras a
-- proveedor, historial de valuación, y —lo más difícil de ver— dos ORÁCULOS que
-- no devuelven la columna: `?cost_price=eq.<x>` y `?order=cost_price.desc`.
--
-- Un cliente del PORTAL MAYORISTA (authenticated, ajeno al negocio) también
-- leía `inventory.cost_price` de los productos publicados.
--
-- ── Por qué GRANT de columna y no RLS ───────────────────────────────────────
-- RLS es por FILA. Deja pasar `?cost_price=eq.81011&select=code`, que responde
-- la pregunta «¿cuánto cuesta?» sin devolver nunca la columna. Se midió que el
-- GRANT de columna cierra las tres puertas a la vez —proyección, filtro y
-- ORDER BY— con 42501. Es el único mecanismo server-side que las cubre.
--
-- Consecuencia asumida: `select('*')` sobre estas tablas pasa a 403 para TODOS,
-- incluido el owner. Por eso el frontend va PRIMERO (ver informe de rollout).
--
-- ── Por qué las vistas de finanzas cambian de fuente ────────────────────────
-- `v_finance_inventory_capital`, `v_finance_inventory_flows`,
-- `v_finance_sales_ledger` y `v_finance_order_cogs_gaps` son `security_invoker`
-- y leen justamente las columnas que acá se revocan: sin tocarlas se romperían
-- con 42501 para todo el mundo. Pasan a leer proyecciones DEFINER acotadas,
-- que reponen el privilegio y aplican explícitamente el mismo tenant y las
-- mismas capacidades que la RLS que dejan de heredar.
--
-- ── Por qué NO se usa el esquema `private` ──────────────────────────────────
-- Una vista `security_invoker` que leyera objetos de ese esquema obligaría a
-- concederle USAGE al rol del navegador. Se auditó el esquema: 14 funciones
-- `private.arca_*` conservan el ACL por defecto de PostgreSQL (EXECUTE a
-- PUBLIC) y hoy están a salvo SÓLO porque falta ese USAGE. Concederlo
-- entregaría, entre otras, `arca_finalize_fail` y `arca_rotation_record` a
-- cualquier usuario logueado. No se concede.
--
-- ── El gate de costo ────────────────────────────────────────────────────────
-- `private.capability_resolve` reparte así las dos capacidades relevantes:
--
--     inventory_view_costs → owner, admin, manager
--     finance              → owner, admin, cashier
--
-- Y hay DOS gates, no uno, porque «costo de inventario» y «COGS de una venta»
-- no tienen el mismo consumidor legítimo:
--
--   can_view_inventory_cost := inventory_view_costs
--       → producto, variante, movimiento, compra, valuación, capital
--       → owner, admin, manager
--
--   can_view_cogs := inventory_view_costs OR finance
--       → costo de la línea de venta, que es el insumo del COGS del P&L
--       → owner, admin, manager, cashier
--
-- Un solo gate con `OR finance` habría sido más corto y estaría MAL: admin y
-- cashier traen `finance` por defecto, así que un override explícito de
-- `inventory_view_costs = false` sobre ellos no habría denegado nada. Un solo
-- gate estricto también estaría mal por el otro lado: el cashier perdería el
-- COGS y el P&L le mostraría `gross_profit = net_sales`.
--
-- En los dos casos `sales`, `tech` y `viewer` quedan afuera —incluido el actor
-- del contrato SEC-08B—, y en los dos casos esto es un ENDURECIMIENTO estricto:
-- hoy `comprobante_items.costo_unitario` lo lee cualquier miembro del tenant.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Autoridad de costo — tenant-bound, sin helper nuevo ciego al tenant
-- ─────────────────────────────────────────────────────────────────────────────
-- Son DOS autoridades, y la diferencia es deliberada.
--
-- `can_view_inventory_cost` es el contrato literal de SEC-08B: el costo del
-- INVENTARIO se gobierna sólo con `inventory_view_costs`. Nada más lo habilita,
-- así que un override explícito a `false` deniega de verdad, incluso para un
-- admin. Si acá se sumara `finance` por comodidad, ese override quedaría muerto
-- para admin y cashier, que traen `finance` por defecto.
CREATE OR REPLACE FUNCTION public.can_view_inventory_cost(p_business_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
-- `pg_temp` explícito y AL FINAL: omitirlo no lo saca del path, lo pone PRIMERO.
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_business_id IS NOT NULL
     AND public.current_user_can_in_business(p_business_id, 'inventory_view_costs');
$$;

ALTER FUNCTION public.can_view_inventory_cost(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.can_view_inventory_cost(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.can_view_inventory_cost(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.can_view_inventory_cost(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_view_inventory_cost(uuid) TO service_role;

COMMENT ON FUNCTION public.can_view_inventory_cost(uuid) IS
  'SEC-08B — autoridad de COSTO DE INVENTARIO en un negocio concreto. Sólo '
  'inventory_view_costs, para que un override explícito a false deniegue de '
  'verdad. Tenant-bound: delega en current_user_can_in_business, nunca en '
  'current_user_can.';

-- `can_view_cogs` gobierna el costo de la LÍNEA DE VENTA, que no es lo mismo:
-- alimenta el COGS del P&L, y ese informe lo consume el cashier, que tiene
-- `finance` pero no `inventory_view_costs`. Negárselo dejaría
-- `gross_profit = net_sales` —un número falso, que es justo lo que este lote no
-- puede producir—. Sigue siendo un ENDURECIMIENTO: hoy `costo_unitario` lo lee
-- cualquier miembro del tenant, tech y viewer incluidos.
CREATE OR REPLACE FUNCTION public.can_view_cogs(p_business_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_business_id IS NOT NULL
     AND ( public.current_user_can_in_business(p_business_id, 'inventory_view_costs')
        OR public.current_user_can_in_business(p_business_id, 'finance') );
$$;

ALTER FUNCTION public.can_view_cogs(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.can_view_cogs(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.can_view_cogs(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.can_view_cogs(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_view_cogs(uuid) TO service_role;

COMMENT ON FUNCTION public.can_view_cogs(uuid) IS
  'SEC-08B — autoridad del COSTO DE LA LÍNEA DE VENTA (COGS). '
  'inventory_view_costs OR finance, porque el P&L es su consumidor legítimo.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Proyecciones DEFINER de costo — el ÚNICO camino autorizado de lectura
-- ─────────────────────────────────────────────────────────────────────────────
-- Son vistas DEFINER (sin `security_invoker`), así que no dependen del GRANT de
-- columna que se revoca abajo. Al perder la RLS de la tabla base reponen a mano
-- el MISMO predicado que esa RLS aplicaba, llamando a las MISMAS funciones.
-- Están expuestas por PostgREST a propósito: son la ruta que el frontend usa
-- cuando el actor sí puede ver costo.

-- 2.a Costo de producto y de variante. La variante de este esquema es una fila
--     de `inventory` con `parent_id`, así que queda cubierta por construcción.
CREATE OR REPLACE VIEW public.v_inventory_costs AS
SELECT i.id            AS inventory_id,
       i.business_id,
       i.parent_id,
       i.cost_price,
       i.cost_price_usd
  FROM public.inventory i
 WHERE i.business_id = public.current_user_business_id()
   -- Reposición explícita de `inventory_select`: tenant + capacidad de módulo…
   AND public.current_user_can_in_business(i.business_id, 'inventory')
   -- …y el gate de costo propio de SEC-08B.
   AND public.can_view_inventory_cost(i.business_id);

ALTER VIEW public.v_inventory_costs OWNER TO postgres;
REVOKE ALL ON public.v_inventory_costs FROM PUBLIC;
REVOKE ALL ON public.v_inventory_costs FROM anon;
GRANT SELECT ON public.v_inventory_costs TO authenticated;
GRANT SELECT ON public.v_inventory_costs TO service_role;

COMMENT ON VIEW public.v_inventory_costs IS
  'SEC-08B — costo de producto/variante para actores autorizados. Vista DEFINER: '
  'repone explícitamente el tenant y la capacidad `inventory` que la RLS de '
  'inventory ya no puede aplicarle, y suma el gate de costo.';

-- 2.b Costo de movimiento de stock.
CREATE OR REPLACE VIEW public.v_inventory_movement_costs AS
SELECT m.id            AS movement_id,
       m.business_id,
       m.inventory_item_id,
       m.unit_cost,
       m.currency,
       m.exchange_rate
  FROM public.inventory_movements m
 WHERE m.business_id = public.current_user_business_id()
   AND public.current_user_can_in_business(m.business_id, 'inventory')
   AND public.can_view_inventory_cost(m.business_id);

ALTER VIEW public.v_inventory_movement_costs OWNER TO postgres;
REVOKE ALL ON public.v_inventory_movement_costs FROM PUBLIC;
REVOKE ALL ON public.v_inventory_movement_costs FROM anon;
GRANT SELECT ON public.v_inventory_movement_costs TO authenticated;
GRANT SELECT ON public.v_inventory_movement_costs TO service_role;

COMMENT ON VIEW public.v_inventory_movement_costs IS
  'SEC-08B — costo unitario de movimientos de stock para actores autorizados.';

-- 2.c Costo de línea de comprobante. Repone TAMBIÉN el predicado de SEC-08A
--     (`comprobante_items_select`): un comprobante vinculado a una orden sigue
--     exigiendo `orders_view_financials`. Esto PRESERVA SEC-08A; no lo reabre.
CREATE OR REPLACE VIEW public.v_comprobante_item_costs AS
SELECT ci.id            AS comprobante_item_id,
       ci.comprobante_id,
       ci.business_id,
       ci.inventory_id,
       ci.cantidad,
       ci.costo_unitario,
       ci.costo_total
  FROM public.comprobante_items ci
 WHERE ci.business_id = public.current_user_business_id()
   AND ( NOT public.comprobante_is_order_linked(ci.comprobante_id)
         OR public.current_user_can_in_business(ci.business_id, 'orders_view_financials') )
   AND public.can_view_cogs(ci.business_id);

ALTER VIEW public.v_comprobante_item_costs OWNER TO postgres;
REVOKE ALL ON public.v_comprobante_item_costs FROM PUBLIC;
REVOKE ALL ON public.v_comprobante_item_costs FROM anon;
GRANT SELECT ON public.v_comprobante_item_costs TO authenticated;
GRANT SELECT ON public.v_comprobante_item_costs TO service_role;

COMMENT ON VIEW public.v_comprobante_item_costs IS
  'SEC-08B — costo de la línea de venta para actores autorizados. Repone el '
  'predicado de orden vinculada de SEC-08A además del gate de costo.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Fuente ININTELIGIBLE para el navegador — revocación de columnas de costo
-- ─────────────────────────────────────────────────────────────────────────────
-- `REVOKE SELECT` sobre la tabla y re-GRANT columna por columna, excepto las de
-- costo. Se enumera dinámicamente para no congelar el esquema: cualquier
-- columna nueva queda legible salvo que se agregue a la lista negra.
DO $cols$
DECLARE
  r record;
  v_cols text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('inventory',         ARRAY['cost_price','cost_price_usd']),
      ('inventory_movements', ARRAY['unit_cost']),
      ('comprobante_items', ARRAY['costo_unitario','costo_total'])
    ) AS t(tbl, blocked)
  LOOP
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum)
      INTO v_cols
      FROM pg_attribute a
     WHERE a.attrelid = format('public.%I', r.tbl)::regclass
       AND a.attnum > 0 AND NOT a.attisdropped
       AND NOT (a.attname = ANY (r.blocked));

    IF v_cols IS NULL THEN
      RAISE EXCEPTION 'SEC-08B: no quedan columnas legibles en public.%', r.tbl;
    END IF;

    EXECUTE format('REVOKE SELECT ON public.%I FROM authenticated', r.tbl);
    EXECUTE format('REVOKE SELECT ON public.%I FROM anon', r.tbl);
    EXECUTE format('GRANT SELECT (%s) ON public.%I TO authenticated', v_cols, r.tbl);

    -- `inventory` se expone al portal mayorista por la policy
    -- `inventory_wholesale_portal_read`, que es `TO public`. El cliente del
    -- portal llega como `authenticated`, así que el GRANT de columna de arriba
    -- ya le cierra el costo. `anon` recupera sólo las columnas que tenía.
    IF r.tbl = 'inventory' THEN
      EXECUTE format('GRANT SELECT (%s) ON public.%I TO anon', v_cols, r.tbl);
    END IF;
  END LOOP;
END
$cols$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Tablas cuya FILA ENTERA es verdad de costo — gate por RLS
-- ─────────────────────────────────────────────────────────────────────────────
-- Acá no hace falta cirugía de columnas: una línea de compra es costo de punta
-- a punta, y `subtotal / quantity` reconstruye `unit_cost` exactamente. Se
-- gatea la fila completa y se pasa de `current_user_can` (ciego al tenant) a la
-- autoridad tenant-bound.

DROP POLICY IF EXISTS purchases_select ON public.purchases;
CREATE POLICY purchases_select ON public.purchases
  FOR SELECT TO authenticated
  USING (business_id = public.current_user_business_id()
         AND public.can_view_inventory_cost(business_id));

DROP POLICY IF EXISTS purchase_items_select ON public.purchase_items;
CREATE POLICY purchase_items_select ON public.purchase_items
  FOR SELECT TO authenticated
  USING (business_id = public.current_user_business_id()
         AND public.can_view_inventory_cost(business_id));

-- Pivot de compras a proveedor (Fase 8). Se cierra SÓLO la proyección de costo
-- de inventario que exige SEC-08B. Saldos, pagos y deuda de proveedor NO se
-- tocan: son SEC-08C.
DROP POLICY IF EXISTS supplier_purchases_inventory_select ON public.supplier_purchases;
CREATE POLICY supplier_purchases_inventory_select ON public.supplier_purchases
  FOR SELECT TO authenticated
  USING (business_id = public.current_user_business_id()
         AND public.can_view_inventory_cost(business_id));

DROP POLICY IF EXISTS supplier_purchase_items_inventory_select ON public.supplier_purchase_items;
CREATE POLICY supplier_purchase_items_inventory_select ON public.supplier_purchase_items
  FOR SELECT TO authenticated
  USING (business_id = public.current_user_business_id()
         AND public.can_view_inventory_cost(business_id));

-- Historial de valuación: capital invertido y ganancia potencial son costo puro.
-- Su policy previa sólo pedía pertenencia al negocio — ni siquiera `inventory`.
DROP POLICY IF EXISTS "Users can view inventory valuation history for their business" ON public.inventory_valuation_history;
DROP POLICY IF EXISTS inventory_valuation_history_select ON public.inventory_valuation_history;
CREATE POLICY inventory_valuation_history_select ON public.inventory_valuation_history
  FOR SELECT TO authenticated
  USING (business_id = public.current_user_business_id()
         AND public.can_view_inventory_cost(business_id));

-- `supplier_purchases` / `supplier_purchase_items` conservaban un GRANT de tabla
-- a `anon` sin policy que lo acompañara (0 filas, pero superficie inútil).
REVOKE SELECT ON public.supplier_purchases FROM anon;
REVOKE SELECT ON public.supplier_purchase_items FROM anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Vistas de finanzas — misma aritmética, nueva fuente de costo
-- ─────────────────────────────────────────────────────────────────────────────
-- Ninguna fórmula cambia. Cambia de dónde sale el costo y quién lo recibe.

-- 5.a Capital inmovilizado en inventario.
CREATE OR REPLACE VIEW public.v_finance_inventory_capital
WITH (security_invoker = true) AS
 WITH base AS (
         SELECT i.business_id,
            i.stock_quantity,
            COALESCE(c.cost_price, 0::numeric) AS cost_price,
            i.base_currency,
            i.exchange_rate_used
           FROM inventory i
           JOIN public.v_inventory_costs c ON c.inventory_id = i.id
          WHERE i.is_active = true AND COALESCE(i.tipo, 'product'::text) = 'product'::text
            AND NOT (EXISTS ( SELECT 1 FROM inventory v
                  WHERE v.business_id = i.business_id AND v.parent_id = i.id))
            AND NOT (EXISTS ( SELECT 1 FROM inventory v
                  WHERE v.business_id = i.business_id AND v.supplier_code = ('VPREF-'::text || i.id::text)))
        )
 SELECT business_id,
    round(COALESCE(sum(stock_quantity::numeric * cost_price) FILTER (WHERE stock_quantity <> 0), 0::numeric), 2) AS inventory_at_cost,
    round(COALESCE(sum(stock_quantity::numeric * cost_price) FILTER (WHERE stock_quantity > 0 AND cost_price > 0::numeric), 0::numeric), 2) AS inventory_at_cost_valued,
    count(*) FILTER (WHERE stock_quantity > 0) AS products_total,
    count(*) FILTER (WHERE stock_quantity > 0 AND cost_price > 0::numeric) AS products_valued,
    count(*) FILTER (WHERE stock_quantity > 0 AND cost_price <= 0::numeric) AS products_missing_cost,
    COALESCE(sum(stock_quantity) FILTER (WHERE stock_quantity > 0 AND cost_price <= 0::numeric), 0::bigint) AS units_missing_cost,
    count(*) FILTER (WHERE stock_quantity < 0) AS products_negative_stock,
    count(*) FILTER (WHERE stock_quantity > 0 AND base_currency = 'USD'::text) AS usd_based_products,
    round(min(exchange_rate_used) FILTER (WHERE stock_quantity > 0 AND base_currency = 'USD'::text AND exchange_rate_used > 0::numeric), 2) AS usd_rate_min_applied,
    round(max(exchange_rate_used) FILTER (WHERE stock_quantity > 0 AND base_currency = 'USD'::text AND exchange_rate_used > 0::numeric), 2) AS usd_rate_max_applied
   FROM base b
  GROUP BY business_id;

COMMENT ON VIEW public.v_finance_inventory_capital IS
  'SEC-08B — misma aritmética; el costo llega por v_inventory_costs. El JOIN (no '
  'LEFT JOIN) es deliberado: sin autoridad de costo la vista no devuelve filas, '
  'en vez de devolver un cero que se leería como «no hay capital».';

-- 5.b Flujos de inventario valorizados.
CREATE OR REPLACE VIEW public.v_finance_inventory_flows
WITH (security_invoker = true) AS
 SELECT m.business_id,
    (m.created_at AT TIME ZONE 'America/Argentina/Cordoba'::text)::date AS movement_date_ar,
        CASE m.movement_type
            WHEN 'purchase'::text THEN 'purchase'::text
            WHEN 'in'::text THEN 'purchase'::text
            WHEN 'return'::text THEN 'return_in'::text
            WHEN 'cancellation'::text THEN 'cancellation_in'::text
            WHEN 'adjustment'::text THEN 'adjustment'::text
            WHEN 'sale'::text THEN 'sale_out'::text
            WHEN 'order_usage'::text THEN 'order_out'::text
            WHEN 'credit_note'::text THEN 'credit_note_out'::text
            ELSE 'other_out'::text
        END AS flow_kind,
    sum(m.quantity) AS net_units,
    sum(abs(m.quantity)) AS gross_units,
    count(*) AS movements,
    count(*) FILTER (WHERE COALESCE(mc.unit_cost, 0::numeric) > 0::numeric) AS movements_costed,
    round(COALESCE(sum(abs(m.quantity)::numeric * mc.unit_cost) FILTER (WHERE COALESCE(mc.unit_cost, 0::numeric) > 0::numeric), 0::numeric), 2) AS cost_amount_ars
   FROM inventory_movements m
   JOIN public.v_inventory_movement_costs mc ON mc.movement_id = m.id
  GROUP BY m.business_id, ((m.created_at AT TIME ZONE 'America/Argentina/Cordoba'::text)::date),
        (CASE m.movement_type
            WHEN 'purchase'::text THEN 'purchase'::text
            WHEN 'in'::text THEN 'purchase'::text
            WHEN 'return'::text THEN 'return_in'::text
            WHEN 'cancellation'::text THEN 'cancellation_in'::text
            WHEN 'adjustment'::text THEN 'adjustment'::text
            WHEN 'sale'::text THEN 'sale_out'::text
            WHEN 'order_usage'::text THEN 'order_out'::text
            WHEN 'credit_note'::text THEN 'credit_note_out'::text
            ELSE 'other_out'::text
        END);

COMMENT ON VIEW public.v_finance_inventory_flows IS
  'SEC-08B — misma aritmética; el costo unitario llega por '
  'v_inventory_movement_costs. Sin autoridad de costo no hay filas.';

-- 5.c Ledger devengado de ventas.
-- Acá el JOIN es LEFT a propósito, y es la diferencia importante con 5.a/5.b:
-- la VENTA no es costo. Un actor sin autoridad de costo debe seguir viendo la
-- línea y su importe de venta; lo único que pierde es `cogs_amount_ars` y
-- `missing_cost`, que pasan a NULL —nunca a cero—.
CREATE OR REPLACE VIEW public.v_finance_sales_ledger
WITH (security_invoker = true) AS
 WITH eff AS (
         SELECT c.id, c.business_id, c.customer_id, c.order_id, c.total,
            (COALESCE(c.fecha, c.date, c.created_at) AT TIME ZONE 'America/Argentina/Cordoba'::text)::date AS period_date,
            COALESCE(c.tipo, c.type) = 'nota_credito'::text AS is_credit_note
           FROM comprobantes c
          WHERE (COALESCE(c.status, c.estado) = ANY (ARRAY['issued'::text, 'emitido'::text]))
             OR (EXISTS ( SELECT 1 FROM comprobante_payments p WHERE p.comprobante_id = c.id))
             OR (EXISTS ( SELECT 1 FROM comprobante_items ci WHERE ci.comprobante_id = c.id AND ci.stock_processed = true))
             OR (EXISTS ( SELECT 1 FROM account_movements am WHERE am.reference_type = 'comprobante'::text AND am.reference_id = c.id AND am.type = 'venta'::text))
             OR (EXISTS ( SELECT 1 FROM comprobante_annulments a WHERE a.comprobante_id = c.id AND a.status = 'completed'::text))
        ), ann AS (
         SELECT a.comprobante_id, a.id AS annulment_id, a.business_id,
            COALESCE(a.annulment_date, (a.created_at AT TIME ZONE 'America/Argentina/Cordoba'::text)::date) AS period_date
           FROM comprobante_annulments a
          WHERE a.status = 'completed'::text
        )
 SELECT e.business_id, 'sale'::text AS event_type, e.period_date, e.id AS comprobante_id,
    NULL::uuid AS annulment_id, e.customer_id, e.order_id, e.is_credit_note,
    ci.id AS comprobante_item_id, ci.inventory_id, ci.tipo_linea, ci.descripcion,
    ci.cantidad AS quantity,
    ci.precio_unitario * ci.cantidad AS gross_amount_ars,
    ci.precio_unitario * ci.cantidad * COALESCE(ci.descuento_linea, 0::numeric) / 100.0 AS discount_amount_ars,
    ci.subtotal AS sales_amount_ars,
    cc.costo_total AS cogs_amount_ars,
    CASE WHEN cc.comprobante_item_id IS NULL THEN NULL::boolean
         ELSE ci.inventory_id IS NOT NULL
              AND COALESCE(cc.costo_unitario, 0::numeric) = 0::numeric
              AND (ci.tipo_linea = ANY (ARRAY['producto'::text, 'repuesto'::text]))
    END AS missing_cost,
    e.total AS comprobante_total
   FROM eff e
     JOIN comprobante_items ci ON ci.comprobante_id = e.id
     LEFT JOIN public.v_comprobante_item_costs cc ON cc.comprobante_item_id = ci.id
UNION ALL
 SELECT e.business_id, 'annulment'::text AS event_type, a.period_date, e.id AS comprobante_id,
    a.annulment_id, e.customer_id, e.order_id, e.is_credit_note,
    ci.id AS comprobante_item_id, ci.inventory_id, ci.tipo_linea, ci.descripcion,
    - ci.cantidad AS quantity,
    - (ci.precio_unitario * ci.cantidad) AS gross_amount_ars,
    - (ci.precio_unitario * ci.cantidad * COALESCE(ci.descuento_linea, 0::numeric) / 100.0) AS discount_amount_ars,
    - ci.subtotal AS sales_amount_ars,
    - cc.costo_total AS cogs_amount_ars,
    false AS missing_cost,
    - e.total AS comprobante_total
   FROM eff e
     JOIN ann a ON a.comprobante_id = e.id AND a.business_id = e.business_id
     JOIN comprobante_items ci ON ci.comprobante_id = e.id
     LEFT JOIN public.v_comprobante_item_costs cc ON cc.comprobante_item_id = ci.id;

COMMENT ON VIEW public.v_finance_sales_ledger IS
  'SEC-08B — misma aritmética de venta y de anulación. El COGS llega por '
  'v_comprobante_item_costs con LEFT JOIN: sin autoridad de costo la venta se '
  'sigue viendo y el COGS queda NULL, nunca 0.';

-- 5.d Detector de huecos de COGS de órdenes. Lee `comprobante_items.costo_total`
--     y es un reporte de costo de punta a punta, así que se gatea ENTERO: dejar
--     `cogs_reconocido_ars` en 0 por falta de autoridad haría que el detector
--     denunciara huecos inexistentes.
CREATE OR REPLACE VIEW public.v_finance_order_cogs_gaps
WITH (security_invoker = true) AS
 WITH costo_items AS (
         SELECT oi.order_id, oi.business_id,
            sum(oi.costo_unitario * oi.cantidad::numeric) FILTER (WHERE oi.tipo = 'repuesto'::text) AS costo_repuestos,
            sum(oi.costo_unitario * oi.cantidad::numeric) FILTER (WHERE oi.tipo = 'servicio'::text) AS costo_servicios,
            count(*) FILTER (WHERE oi.tipo = 'repuesto'::text AND COALESCE(oi.costo_unitario, 0::numeric) = 0::numeric) AS repuestos_sin_snapshot,
            count(*) FILTER (WHERE oi.tipo = 'repuesto'::text) AS repuestos
           FROM order_items oi GROUP BY oi.order_id, oi.business_id
        ), costo_parts AS (
         SELECT p.order_id, p.business_id,
            sum(p.internal_cost * p.quantity::numeric) AS costo_parts_sueltos,
            count(*) FILTER (WHERE COALESCE(p.internal_cost, 0::numeric) = 0::numeric) AS parts_sin_snapshot
           FROM order_parts p
          WHERE (COALESCE(p.status, 'used'::character varying)::text = ANY (ARRAY['used'::character varying, 'sold'::character varying]::text[]))
            AND NOT (EXISTS ( SELECT 1 FROM order_items i
                  WHERE i.order_id = p.order_id AND i.tipo = 'repuesto'::text AND i.descripcion = p.name::text))
          GROUP BY p.order_id, p.business_id
        ), cogs_reconocido AS (
         SELECT c.order_id, c.business_id,
            sum(cc.costo_total) AS cogs_ars,
            count(DISTINCT c.id) AS comprobantes
           FROM comprobantes c
             JOIN v_finance_effective_comprobantes e ON e.id = c.id AND e.is_credit_note = false
             JOIN public.v_comprobante_item_costs cc ON cc.comprobante_id = c.id
          WHERE c.order_id IS NOT NULL GROUP BY c.order_id, c.business_id
        ), base AS (
         SELECT o.id AS order_id, o.business_id, o.status AS order_status,
            (o.created_at AT TIME ZONE 'America/Argentina/Cordoba'::text)::date AS order_date,
            round(COALESCE(ci.costo_repuestos, 0::numeric) + COALESCE(cp.costo_parts_sueltos, 0::numeric), 2) AS costo_repuestos_ars,
            round(COALESCE(ci.costo_servicios, 0::numeric), 2) AS costo_servicios_ars,
            round(COALESCE(ci.costo_repuestos, 0::numeric) + COALESCE(cp.costo_parts_sueltos, 0::numeric) + COALESCE(ci.costo_servicios, 0::numeric), 2) AS costo_atribuible_ars,
            COALESCE(ci.repuestos, 0::bigint) AS repuestos,
            COALESCE(ci.repuestos_sin_snapshot, 0::bigint) + COALESCE(cp.parts_sin_snapshot, 0::bigint) AS sin_snapshot,
            round(COALESCE(cg.cogs_ars, 0::numeric), 2) AS cogs_reconocido_ars,
            COALESCE(cg.comprobantes, 0::bigint) AS comprobantes_vinculados
           FROM orders o
             LEFT JOIN costo_items ci ON ci.order_id = o.id
             LEFT JOIN costo_parts cp ON cp.order_id = o.id
             LEFT JOIN cogs_reconocido cg ON cg.order_id = o.id
          WHERE public.can_view_inventory_cost(o.business_id)
        )
 SELECT b.business_id, b.order_id, b.order_status, b.order_date,
    'orden_sin_comprobante_vinculado'::text AS gap_type,
    CASE WHEN b.order_status = ANY (ARRAY['completed'::text, 'ready_delivery'::text]) THEN 'critical'::text ELSE 'warning'::text END AS severity,
    b.costo_atribuible_ars AS gap_ars, b.costo_atribuible_ars, b.costo_repuestos_ars, b.costo_servicios_ars,
    b.cogs_reconocido_ars, b.comprobantes_vinculados, b.sin_snapshot,
    'Orden con costo atribuible y ningún comprobante efectivo vinculado (order_id NULL o sin facturar)'::text AS detalle
   FROM base b
  WHERE b.costo_atribuible_ars > 0.01 AND b.comprobantes_vinculados = 0 AND b.order_status <> 'cancelled'::text
UNION ALL
 SELECT b.business_id, b.order_id, b.order_status, b.order_date,
    'cogs_incompleto'::text AS gap_type, 'critical'::text AS severity,
    round(b.costo_atribuible_ars - b.cogs_reconocido_ars, 2) AS gap_ars,
    b.costo_atribuible_ars, b.costo_repuestos_ars, b.costo_servicios_ars,
    b.cogs_reconocido_ars, b.comprobantes_vinculados, b.sin_snapshot,
    'Comprobante vinculado con COGS menor al costo atribuible de la orden'::text AS detalle
   FROM base b
  WHERE b.comprobantes_vinculados > 0 AND (b.costo_atribuible_ars - b.cogs_reconocido_ars) > 0.01
UNION ALL
 SELECT b.business_id, b.order_id, b.order_status, b.order_date,
    'snapshot_de_costo_faltante'::text AS gap_type, 'warning'::text AS severity,
    0::numeric AS gap_ars, b.costo_atribuible_ars, b.costo_repuestos_ars, b.costo_servicios_ars,
    b.cogs_reconocido_ars, b.comprobantes_vinculados, b.sin_snapshot,
    'Repuestos consumidos sin costo snapshot (costo_unitario/internal_cost = 0)'::text AS detalle
   FROM base b
  WHERE b.sin_snapshot > 0
UNION ALL
 SELECT c.business_id, c.order_id, o.status AS order_status,
    (c.created_at AT TIME ZONE 'America/Argentina/Cordoba'::text)::date AS order_date,
    'riesgo_doble_stock'::text AS gap_type, 'critical'::text AS severity,
    0::numeric AS gap_ars, 0::numeric AS costo_atribuible_ars, 0::numeric AS costo_repuestos_ars,
    0::numeric AS costo_servicios_ars, 0::numeric AS cogs_reconocido_ars,
    1 AS comprobantes_vinculados, 0 AS sin_snapshot,
    'Línea con inventory_id sobre un producto ya consumido por la orden: '::text || ci.descripcion AS detalle
   FROM comprobantes c
     JOIN orders o ON o.id = c.order_id
     JOIN comprobante_items ci ON ci.comprobante_id = c.id
  WHERE c.order_id IS NOT NULL AND ci.inventory_id IS NOT NULL AND ci.stock_processed = true
    AND public.can_view_inventory_cost(c.business_id)
    AND (EXISTS ( SELECT 1 FROM order_items oi
           WHERE oi.order_id = c.order_id AND oi.tipo = 'repuesto'::text AND oi.product_id = ci.inventory_id));

-- 5.e P&L. `gross_profit` hace `COALESCE(cogs, 0)`: con el COGS en NULL un actor
--     sin autoridad de costo leería `gross_profit = net_sales`. Ese número falso
--     es exactamente lo que este lote no puede producir, así que la vista no le
--     devuelve NINGUNA fila. Para quien sí tiene autoridad, la aritmética es
--     idéntica a la de `main`.
CREATE OR REPLACE VIEW public.v_finance_pnl
WITH (security_invoker = true) AS
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
     LEFT JOIN expenses e ON e.business_id = k.business_id AND e.period_date = k.period_date
  WHERE public.can_view_cogs(k.business_id);

-- 5.f Margen por producto: I2 puro (costo derivado, por producto). Misma razón
--     que el P&L — sin autoridad, ninguna fila.
CREATE OR REPLACE VIEW public.v_finance_product_margin
WITH (security_invoker = true) AS
 SELECT business_id, inventory_id,
    max(descripcion) AS product_name,
    round(sum(sales_amount_ars), 2) AS net_sales,
    round(sum(cogs_amount_ars), 2) AS cogs,
    round(sum(sales_amount_ars) - sum(cogs_amount_ars), 2) AS gross_profit,
        CASE WHEN sum(sales_amount_ars) > 0::numeric
             THEN round((sum(sales_amount_ars) - sum(cogs_amount_ars)) / sum(sales_amount_ars) * 100::numeric, 2)
             ELSE NULL::numeric END AS margin_pct,
    round(sum(quantity), 2) AS units,
    count(DISTINCT comprobante_id) AS operations,
    count(*) FILTER (WHERE missing_cost) AS missing_cost_count
   FROM v_finance_sales_ledger l
  WHERE is_credit_note = false AND inventory_id IS NOT NULL
    AND public.can_view_inventory_cost(l.business_id)
  GROUP BY business_id, inventory_id;

-- 5.g Posición financiera. `inventory_at_cost` era `COALESCE(..., 0)`: al gatear
--     el capital, un actor sin autoridad leería 0, que se interpreta como «no
--     hay capital inmovilizado». Ahora se distingue el cero REAL (autorizado y
--     sin stock) del NULL (restringido), y el frontend muestra «—».
CREATE OR REPLACE VIEW public.v_finance_position
WITH (security_invoker = true) AS
 WITH cash AS (
         SELECT m.business_id, sum(m.method_net) AS cash_total,
            jsonb_object_agg(m.payment_method, m.method_net) AS cash_by_method
           FROM ( SELECT v_finance_cashflow.business_id,
                    COALESCE(v_finance_cashflow.payment_method, 'otro'::text) AS payment_method,
                    sum(v_finance_cashflow.net_ars) AS method_net
                   FROM v_finance_cashflow
                  GROUP BY v_finance_cashflow.business_id, (COALESCE(v_finance_cashflow.payment_method, 'otro'::text))) m
          GROUP BY m.business_id
        ), inv AS (
         SELECT c.business_id, c.inventory_at_cost FROM v_finance_inventory_capital c
        ), recv AS (
         SELECT c.business_id, round(sum(c.saldo_pendiente), 2) AS receivables
           FROM comprobantes c
             JOIN v_finance_effective_comprobantes e ON e.id = c.id AND e.is_credit_note = false
          WHERE c.saldo_pendiente > 0.01 AND c.customer_id IS NOT NULL
          GROUP BY c.business_id
        ), pay AS (
         SELECT supplier_account_movements.business_id,
            round(sum(supplier_account_movements.debit - supplier_account_movements.credit), 2) AS payables
           FROM supplier_account_movements GROUP BY supplier_account_movements.business_id
        ), owner AS (
         SELECT owner_withdrawals.business_id,
            round(sum(owner_withdrawals.amount) FILTER (WHERE owner_withdrawals.flow_type = 'withdrawal'::text AND owner_withdrawals.status = 'completed'::text), 2) AS withdrawals_total,
            round(sum(owner_withdrawals.amount) FILTER (WHERE owner_withdrawals.flow_type = 'contribution'::text AND owner_withdrawals.status = 'completed'::text), 2) AS contributions_total
           FROM owner_withdrawals GROUP BY owner_withdrawals.business_id
        ), quality AS (
         SELECT business_finance_entries.business_id,
            round(sum(business_finance_entries.amount_ars) FILTER (WHERE business_finance_entries.economic_class = 'legacy_unclassified'::text), 2) AS unclassified_amount,
            count(*) FILTER (WHERE business_finance_entries.economic_class = 'legacy_unclassified'::text) AS unclassified_count
           FROM business_finance_entries GROUP BY business_finance_entries.business_id
        ), bizs AS (
         SELECT businesses.id AS business_id FROM businesses
        )
 SELECT b.business_id,
    COALESCE(cash.cash_total, 0::numeric) AS cash_total,
    COALESCE(cash.cash_by_method, '{}'::jsonb) AS cash_by_method,
    CASE WHEN public.can_view_inventory_cost(b.business_id)
         THEN COALESCE(inv.inventory_at_cost, 0::numeric)
         ELSE NULL::numeric END AS inventory_at_cost,
    COALESCE(recv.receivables, 0::numeric) AS receivables,
    COALESCE(pay.payables, 0::numeric) AS payables,
    COALESCE(owner.withdrawals_total, 0::numeric) AS owner_withdrawals_total,
    COALESCE(owner.contributions_total, 0::numeric) AS owner_contributions_total,
    COALESCE(owner.contributions_total, 0::numeric) - COALESCE(owner.withdrawals_total, 0::numeric) AS owner_net_capital,
    jsonb_build_object('unclassified_amount', COALESCE(quality.unclassified_amount, 0::numeric), 'unclassified_count', COALESCE(quality.unclassified_count, 0::bigint)) AS data_quality_flags
   FROM bizs b
     LEFT JOIN cash ON cash.business_id = b.business_id
     LEFT JOIN inv ON inv.business_id = b.business_id
     LEFT JOIN recv ON recv.business_id = b.business_id
     LEFT JOIN pay ON pay.business_id = b.business_id
     LEFT JOIN owner ON owner.business_id = b.business_id
     LEFT JOIN quality ON quality.business_id = b.business_id
  WHERE cash.business_id IS NOT NULL OR inv.business_id IS NOT NULL OR recv.business_id IS NOT NULL
     OR pay.business_id IS NOT NULL OR owner.business_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Postcondiciones — la migración se cae si el contrato no quedó puesto
-- ─────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_bad text;
BEGIN
  -- Ninguna columna de costo puede seguir concedida a un rol del navegador.
  SELECT string_agg(format('%s.%s -> %s', table_name, column_name, grantee), ', ')
    INTO v_bad
    FROM information_schema.column_privileges
   WHERE table_schema = 'public' AND privilege_type = 'SELECT'
     AND grantee IN ('anon', 'authenticated')
     AND ( (table_name = 'inventory' AND column_name IN ('cost_price','cost_price_usd'))
        OR (table_name = 'inventory_movements' AND column_name = 'unit_cost')
        OR (table_name = 'comprobante_items' AND column_name IN ('costo_unitario','costo_total')) );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'SEC-08B: quedaron GRANT de columnas de costo: %', v_bad;
  END IF;

  -- Y las columnas operativas tienen que seguir concedidas, o la app se cae.
  IF NOT EXISTS (SELECT 1 FROM information_schema.column_privileges
                  WHERE table_schema='public' AND table_name='inventory'
                    AND column_name='sale_price' AND grantee='authenticated' AND privilege_type='SELECT') THEN
    RAISE EXCEPTION 'SEC-08B: se perdió el SELECT de inventory.sale_price';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.column_privileges
                  WHERE table_schema='public' AND table_name='inventory'
                    AND column_name='stock_quantity' AND grantee='authenticated' AND privilege_type='SELECT') THEN
    RAISE EXCEPTION 'SEC-08B: se perdió el SELECT de inventory.stock_quantity';
  END IF;

  -- `anon` no puede ejecutar la autoridad de costo.
  IF has_function_privilege('anon', 'public.can_view_inventory_cost(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SEC-08B: anon conserva EXECUTE sobre can_view_inventory_cost';
  END IF;

  -- Las proyecciones autorizadas tienen que ser DEFINER: si alguien las creara
  -- con security_invoker, volverían a depender del GRANT de columna revocado y
  -- responderían 42501 a todo el mundo.
  SELECT string_agg(c.relname, ', ') INTO v_bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'v'
     AND c.relname IN ('v_inventory_costs','v_inventory_movement_costs','v_comprobante_item_costs')
     AND COALESCE(array_to_string(c.reloptions, ','), '') ILIKE '%security_invoker=true%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'SEC-08B: proyección de costo con security_invoker: %', v_bad;
  END IF;
END
$post$;

COMMIT;

