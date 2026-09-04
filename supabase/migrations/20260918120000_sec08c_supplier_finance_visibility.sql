-- ═══════════════════════════════════════════════════════════════════════════
-- SEC-08C — VISIBILIDAD DE LA VERDAD FINANCIERA DE PROVEEDORES
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Defectos reproducidos contra esta misma base antes de escribir una línea
-- (scripts/security/sec08c-baseline-leak.mjs, 22 hallazgos):
--
--   D — `sales` (inventory=true, finance=false, inventory_view_costs=false)
--       leía supplier_payments.amount, y lo infería además por ?amount=eq. y
--       por ORDER BY. Un actor puramente OPERATIVO veía cuánto se le pagó a
--       cada proveedor.
--   E — el mismo actor leía supplier_account_movements: debit, credit y
--       balance_after. Es decir, la DEUDA y su historial completo.
--   A — `cashier` (finance=true), que es el actor de finanzas del producto y
--       el que mira la tarjeta «Deuda proveedores», NO podía leer
--       supplier_purchases (SEC-08B la cerró con can_view_inventory_cost) y
--       el dashboard resolvía 0 con deuda real 82395. El mismo cero falso lo
--       fabricaba el SERVIDOR en v_finance_payables_aging, en
--       get_finance_charts_l1 (COALESCE → llega como número, no como
--       ausencia) y en v_finance_position.payables.
--   B/C — el listado y el detalle calculaban las stats financieras en el
--       browser sobre filas crudas.
--
-- ── AUTORIDAD ─────────────────────────────────────────────────────────────
-- NO se inventa una capability `supplier_finance`. No hace falta: la verdad
-- financiera de proveedores ya tiene dos dueños legítimos en el modelo actual
-- y lo único que faltaba era NOMBRAR la composición en un solo lugar
-- auditable.
--
--   `finance`               (admin, cashier) — es quien paga y quien concilia.
--   `inventory_view_costs`  (admin, manager) — es quien compra. Sin él, el
--                           `manager` —el rol de compras— perdería la deuda
--                           del proveedor al que le compra, que es una
--                           regresión de operación legítima, no una mejora
--                           de seguridad.
--
-- `sales` no tiene ninguna de las dos y queda cerrado: ése es el defecto.
-- Como la composición pasa por current_user_can_in_business →
-- capability_resolve, los OVERRIDES por perfil siguen valiendo en los dos
-- sentidos (un override a false deniega incluso a un admin).
--
-- ── LO QUE NO SE TOCA ─────────────────────────────────────────────────────
-- `supplier_purchase_items` queda EXACTAMENTE como la dejó SEC-08B: sólo
-- `inventory_view_costs`. El costo crudo por línea reconstruye el costo del
-- producto, y un actor de finanzas puede ver la deuda agregada del proveedor
-- SIN ver a cuánto se compró cada artículo. Son dos verdades distintas y este
-- lote no las colapsa (§22 del enunciado).
--
-- Tampoco se toca `suppliers_select`: la ruta /suppliers está gateada por la
-- permission `inventory`, y ninguna superficie de finanzas expone identidad de
-- proveedor (get_finance_charts_l1 devuelve sólo importes y conteos). Abrir el
-- listado a `finance` no cerraría ningún defecto reproducido y ampliaría
-- exposición (bank_cbu, bank_alias, internal_notes) sin motivo.
--
-- Tampoco se tocan las policies de INSERT/UPDATE: siguen en `inventory`, para
-- preservar el contrato ratificado de SEC-08B — un operador de compras crea
-- la compra canónica y establece el costo server-side sin poder leerlo.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Autoridad ───────────────────────────────────────────────────────────
-- INVOKER a propósito: no necesita elevación, sólo compone dos capabilities
-- que ya resuelven contra el perfil del llamador. `pg_temp` va AL FINAL: si se
-- omite, PostgreSQL lo pone PRIMERO y un esquema temporal del atacante podría
-- sombrear los objetos que la función resuelve.
CREATE OR REPLACE FUNCTION public.can_view_supplier_finance(p_business_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
  SELECT p_business_id IS NOT NULL
     AND ( public.current_user_can_in_business(p_business_id, 'finance')
        OR public.current_user_can_in_business(p_business_id, 'inventory_view_costs') );
$$;

COMMENT ON FUNCTION public.can_view_supplier_finance(uuid) IS
  'SEC-08C. Autoridad de lectura de la verdad financiera de proveedores '
  '(deuda, saldo, importes de compra y de pago). Composicion de dos '
  'capabilities EXISTENTES: finance OR inventory_view_costs. NO habilita el '
  'costo crudo por linea de compra, que sigue exigiendo inventory_view_costs '
  '(SEC-08B).';

-- OJO: `REVOKE ... FROM PUBLIC` NO alcanza. Este proyecto tiene ALTER DEFAULT
-- PRIVILEGES que otorga EXECUTE a `anon` sobre cada funcion nueva de `public`,
-- y eso es un GRANT explicito, no el default de PUBLIC. Sin el REVOKE a anon,
-- la funcion nace ejecutable por un no autenticado. Lo detecto el test de
-- catalogo, no la lectura del codigo.
REVOKE ALL ON FUNCTION public.can_view_supplier_finance(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_view_supplier_finance(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.can_view_supplier_finance(uuid) TO authenticated;

-- ── 2. Cierre de las lecturas crudas ───────────────────────────────────────
--
-- NOTA DE PLAN (medida, no supuesta). La autoridad se evalúa contra la columna
-- `business_id` DE LA FILA, igual que hace SEC-08B con can_view_inventory_cost.
-- Se probó la variante «constante» —pasarle current_user_business_id()— para
-- que el planner la redujera a un InitPlan, y NO valió la pena:
--
--   · no cambió el plan: PostgreSQL la dejó igual en el `Filter` del scan;
--   · no cambió el tiempo (350→395 ms y 206→261 ms, dentro del ruido de este
--     Docker);
--   · y era la forma MENOS defensiva, porque comprueba la autoridad contra un
--     valor derivado de la sesión en vez de contra el tenant real de la fila.
--
-- El costo medido sobre 400 proveedores y 4.000 compras es ~53 µs por fila:
-- procesamiento de filas, LINEAL. Si el helper se estuviera evaluando de nuevo
-- por cada fila el tiempo sería de decenas de segundos (una llamada plpgsql
-- cuesta ~9 ms en este contenedor), así que no hay evaluación repetida ni nada
-- parecido al anti-join cuadrático que hizo expirar a get_finance_charts_l1.
DROP POLICY IF EXISTS supplier_payments_select ON public.supplier_payments;
CREATE POLICY supplier_payments_select ON public.supplier_payments
  FOR SELECT TO authenticated
  USING (business_id = public.current_user_business_id()
         AND public.can_view_supplier_finance(business_id));

-- supplier_account_movements: debe, haber y saldo. Es la deuda misma.
DROP POLICY IF EXISTS supplier_account_movements_select ON public.supplier_account_movements;
CREATE POLICY supplier_account_movements_select ON public.supplier_account_movements
  FOR SELECT TO authenticated
  USING (business_id = public.current_user_business_id()
         AND public.can_view_supplier_finance(business_id));

-- supplier_purchases: la CABECERA (total/pagado/pendiente) es verdad
-- financiera del proveedor, no costo de producto. Pasa de exigir
-- inventory_view_costs a exigir la autoridad compuesta: cierra igual para
-- `sales` y ABRE para `finance`, que es quien tiene que ver la deuda.
DROP POLICY IF EXISTS supplier_purchases_inventory_select ON public.supplier_purchases;
CREATE POLICY supplier_purchases_inventory_select ON public.supplier_purchases
  FOR SELECT TO authenticated
  USING (business_id = public.current_user_business_id()
         AND public.can_view_supplier_finance(business_id));

-- supplier_purchase_items NO se toca. Queda en can_view_inventory_cost.

-- ── 3. GRANT residual a anon ───────────────────────────────────────────────
-- Hoy lo tapa la RLS (no hay policy para anon), pero el GRANT no debería
-- existir: es la única capa que quedaría si una policy futura se ampliara por
-- error. Defensa en profundidad, sin efecto funcional.
REVOKE ALL ON public.supplier_payments FROM anon;
REVOKE ALL ON public.supplier_account_movements FROM anon;
REVOKE ALL ON public.supplier_purchases FROM anon;
REVOKE ALL ON public.supplier_purchase_items FROM anon;
-- `suppliers` estaba peor: anon conservaba INSERT/SELECT/UPDATE/DELETE/
-- TRUNCATE/REFERENCES/TRIGGER. La RLS tapa las cuatro primeras (no hay policy
-- para anon), pero TRUNCATE NO PASA POR RLS: un GRANT de TRUNCATE a anon es
-- borrado de tabla sin policy que lo detenga. No hay ninguna policy `anon`
-- sobre suppliers, asi que no se pierde ningun acceso legitimo.
REVOKE ALL ON public.suppliers FROM anon;

-- ── 4. Agregado canónico de deuda ──────────────────────────────────────────
-- El FinanceDashboard sumaba pending_amount en el browser. Eso es cálculo
-- canónico de dinero en el cliente (prohibido) y, peor, convertía «no puedo
-- ver» en «no hay deuda».
--
-- Esta vista sigue el patrón YA establecido por v_finance_position para
-- inventory_at_cost: restringido → NULL, nunca 0. `is_authorized` viaja al
-- lado para que la UI no tenga que adivinar qué significa un NULL.
--
-- La tenencia la hereda de businesses (businesses_select filtra por
-- current_user_business_id) y del RLS de supplier_purchases: la vista es
-- security_invoker, así que NO agrega superficie propia.
CREATE OR REPLACE VIEW public.v_finance_supplier_debt
WITH (security_invoker = true) AS
  SELECT
    b.id AS business_id,
    CASE WHEN public.can_view_supplier_finance(b.id)
         THEN COALESCE(d.outstanding, 0)::numeric
         ELSE NULL::numeric END AS outstanding_ars,
    CASE WHEN public.can_view_supplier_finance(b.id)
         THEN COALESCE(d.documents, 0)::bigint
         ELSE NULL::bigint END AS documents,
    public.can_view_supplier_finance(b.id) AS is_authorized
  FROM public.businesses b
  LEFT JOIN (
    SELECT sp.business_id,
           round(sum(sp.pending_amount), 2) AS outstanding,
           count(*)                         AS documents
      FROM public.supplier_purchases sp
     WHERE sp.pending_amount > 0.01
       AND sp.payment_status <> 'paid'
     GROUP BY sp.business_id
  ) d ON d.business_id = b.id;

COMMENT ON VIEW public.v_finance_supplier_debt IS
  'SEC-08C. Deuda con proveedores, agregada server-side. Fuente canonica de la '
  'tarjeta "Deuda proveedores". outstanding_ars es NULL —nunca 0— cuando el '
  'actor no tiene autoridad financiera de proveedores; is_authorized lo dice '
  'explicitamente. No expone identidad de proveedor ni costo de linea.';

REVOKE ALL ON public.v_finance_supplier_debt FROM PUBLIC, anon;
GRANT SELECT ON public.v_finance_supplier_debt TO authenticated;

-- ── 5. Stats por proveedor ─────────────────────────────────────────────────
-- getSuppliersWithStats() traía supplier_purchases embebida y reducía en JS.
-- Mismo problema: cálculo canónico en el cliente y 0 cuando el embed venía
-- vacío por autoridad. La vista devuelve el operativo siempre y el financiero
-- sólo a quien corresponde; el resto recibe NULL, que la UI muestra como
-- restringido.
CREATE OR REPLACE VIEW public.v_finance_supplier_stats
WITH (security_invoker = true) AS
  SELECT
    s.business_id,
    s.id AS supplier_id,
    CASE WHEN public.can_view_supplier_finance(s.business_id)
         THEN COALESCE(a.total_purchases, 0)::numeric ELSE NULL::numeric END AS total_purchases,
    CASE WHEN public.can_view_supplier_finance(s.business_id)
         THEN COALESCE(a.total_paid, 0)::numeric      ELSE NULL::numeric END AS total_paid,
    CASE WHEN public.can_view_supplier_finance(s.business_id)
         THEN COALESCE(a.pending_amount, 0)::numeric  ELSE NULL::numeric END AS pending_amount,
    CASE WHEN public.can_view_supplier_finance(s.business_id)
         THEN COALESCE(a.purchases_count, 0)::bigint  ELSE NULL::bigint  END AS purchases_count,
    CASE WHEN public.can_view_supplier_finance(s.business_id)
         THEN a.last_purchase_date                    ELSE NULL::date    END AS last_purchase_date,
    public.can_view_supplier_finance(s.business_id) AS is_authorized
  FROM public.suppliers s
  LEFT JOIN (
    SELECT sp.supplier_id,
           round(sum(sp.total_amount), 2)   AS total_purchases,
           round(sum(sp.paid_amount), 2)    AS total_paid,
           round(sum(sp.pending_amount), 2) AS pending_amount,
           count(*)                         AS purchases_count,
           max(sp.purchase_date)            AS last_purchase_date
      FROM public.supplier_purchases sp
     GROUP BY sp.supplier_id
  ) a ON a.supplier_id = s.id;

COMMENT ON VIEW public.v_finance_supplier_stats IS
  'SEC-08C. Estadisticas financieras por proveedor, agregadas server-side. '
  'Reemplaza el reduce() del browser en getSuppliersWithStats. Los importes '
  'son NULL —nunca 0— sin autoridad financiera de proveedores.';

REVOKE ALL ON public.v_finance_supplier_stats FROM PUBLIC, anon;
GRANT SELECT ON public.v_finance_supplier_stats TO authenticated;

-- ── 6. v_finance_position.payables ─────────────────────────────────────────
-- Arrastraba las dos caras del defecto: le entregaba la deuda real a `sales`
-- (que ahora ya no lee la tabla) y le entregaba 0 al `cashier`. Con la policy
-- nueva, sin este CASE el cashier vería 0 igual —COALESCE sobre cero filas—,
-- así que el CASE es lo que convierte «no autorizado» en NULL.
--
-- Se reescribe COMPLETA y con WITH (security_invoker = true) explícito:
-- CREATE OR REPLACE VIEW resetea reloptions si no se las vuelve a declarar.
-- Ninguna otra columna cambia.
CREATE OR REPLACE VIEW public.v_finance_position
WITH (security_invoker = true) AS
 WITH cash AS (
         SELECT m.business_id,
            sum(m.method_net) AS cash_total,
            jsonb_object_agg(m.payment_method, m.method_net) AS cash_by_method
           FROM ( SELECT v_finance_cashflow.business_id,
                    COALESCE(v_finance_cashflow.payment_method, 'otro'::text) AS payment_method,
                    sum(v_finance_cashflow.net_ars) AS method_net
                   FROM v_finance_cashflow
                  GROUP BY v_finance_cashflow.business_id, (COALESCE(v_finance_cashflow.payment_method, 'otro'::text))) m
          GROUP BY m.business_id
        ), inv AS (
         SELECT c.business_id,
            c.inventory_at_cost
           FROM v_finance_inventory_capital c
        ), recv AS (
         SELECT c.business_id,
            round(sum(c.saldo_pendiente), 2) AS receivables
           FROM comprobantes c
             JOIN v_finance_effective_comprobantes e ON e.id = c.id AND e.is_credit_note = false
          WHERE c.saldo_pendiente > 0.01 AND c.customer_id IS NOT NULL
          GROUP BY c.business_id
        ), pay AS (
         SELECT supplier_account_movements.business_id,
            round(sum(supplier_account_movements.debit - supplier_account_movements.credit), 2) AS payables
           FROM supplier_account_movements
          GROUP BY supplier_account_movements.business_id
        ), owner AS (
         SELECT owner_withdrawals.business_id,
            round(sum(owner_withdrawals.amount) FILTER (WHERE owner_withdrawals.flow_type = 'withdrawal'::text AND owner_withdrawals.status = 'completed'::text), 2) AS withdrawals_total,
            round(sum(owner_withdrawals.amount) FILTER (WHERE owner_withdrawals.flow_type = 'contribution'::text AND owner_withdrawals.status = 'completed'::text), 2) AS contributions_total
           FROM owner_withdrawals
          GROUP BY owner_withdrawals.business_id
        ), quality AS (
         SELECT business_finance_entries.business_id,
            round(sum(business_finance_entries.amount_ars) FILTER (WHERE business_finance_entries.economic_class = 'legacy_unclassified'::text), 2) AS unclassified_amount,
            count(*) FILTER (WHERE business_finance_entries.economic_class = 'legacy_unclassified'::text) AS unclassified_count
           FROM business_finance_entries
          GROUP BY business_finance_entries.business_id
        ), bizs AS (
         SELECT businesses.id AS business_id
           FROM businesses
        )
 SELECT b.business_id,
    COALESCE(cash.cash_total, 0::numeric) AS cash_total,
    COALESCE(cash.cash_by_method, '{}'::jsonb) AS cash_by_method,
        CASE
            WHEN can_view_inventory_cost(b.business_id) THEN COALESCE(inv.inventory_at_cost, 0::numeric)
            ELSE NULL::numeric
        END AS inventory_at_cost,
    COALESCE(recv.receivables, 0::numeric) AS receivables,
        CASE
            WHEN public.can_view_supplier_finance(b.business_id) THEN COALESCE(pay.payables, 0::numeric)
            ELSE NULL::numeric
        END AS payables,
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
  WHERE cash.business_id IS NOT NULL OR inv.business_id IS NOT NULL OR recv.business_id IS NOT NULL OR pay.business_id IS NOT NULL OR owner.business_id IS NOT NULL;

-- ── 7. Postcondiciones de catálogo ─────────────────────────────────────────
-- Las reloptions de una vista se pierden en silencio con CREATE OR REPLACE si
-- no se vuelven a declarar. Un security_invoker perdido convertiría estas
-- vistas en un bypass de RLS con los privilegios del owner.
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO v_missing
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('v_finance_supplier_debt','v_finance_supplier_stats','v_finance_position')
     AND COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions)
                    WHERE option_name = 'security_invoker'), 'off') <> 'true';
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'SEC-08C: vistas sin security_invoker=true: %', v_missing;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND grantee = 'anon'
       AND table_name IN ('supplier_payments','supplier_account_movements',
                          'supplier_purchases','supplier_purchase_items','suppliers')
  ) THEN
    RAISE EXCEPTION 'SEC-08C: anon conserva grants sobre tablas de proveedor';
  END IF;

  -- El contrato con SEC-08B: la linea de compra NO puede haber quedado
  -- gobernada por la autoridad nueva.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'supplier_purchase_items'
       AND cmd = 'SELECT' AND qual LIKE '%can_view_supplier_finance%'
  ) THEN
    RAISE EXCEPTION 'SEC-08C: supplier_purchase_items no puede usar can_view_supplier_finance (rompe SEC-08B)';
  END IF;
END $$;

COMMIT;
