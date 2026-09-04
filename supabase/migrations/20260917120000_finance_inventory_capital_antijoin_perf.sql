-- ============================================================================
-- HOTFIX post-rollout — v_finance_inventory_capital: se elimina el anti-join
-- cuadrático que hacía expirar `get_finance_charts_l1` (57014).
-- ============================================================================
--
-- SÍNTOMA (producción, owner autenticado, /finance):
--   get_finance_charts_l1 → HTTP 500 · 57014 · canceling statement due to
--   statement timeout. `authenticated` tiene statement_timeout = 8s.
--   Medido: 31.891 ms para un período de 31 días.
--
-- CAUSA RAÍZ — y NO es SEC-08B.
--
-- El universo de la vista excluye los padres de variante por DOS convenciones.
-- La segunda no es indexable: compara una columna del lado interno contra una
-- CADENA CONSTRUIDA con el id del lado externo.
--
--     NOT EXISTS (SELECT 1 FROM inventory v
--                  WHERE v.business_id = i.business_id
--                    AND v.supplier_code = 'VPREF-' || i.id::text)
--
-- Como el término de comparación depende de la fila externa, el planner no
-- puede hashear el anti-join ni usar un índice: reescanea `inventory` ENTERO
-- una vez por cada producto. Con 611 productos vigentes sobre 721 filas
-- visibles eso da 440.531 comparaciones, y —lo caro de verdad— cada fila
-- interna reevalúa la policy RLS de `inventory`, que llama a
-- `current_user_can('inventory')`, una función plpgsql. Son ~440k invocaciones
-- de plpgsql por request.
--
--   Nested Loop Anti Join  (actual time=60.905..32780.188 rows=611 loops=1)
--     Join Filter: (v_1.supplier_code = ('VPREF-' || i.id::text))
--     Rows Removed by Join Filter: 440531
--     ->  Bitmap Heap Scan on inventory v_1  (actual time=0.136..53.034
--                                             rows=721 loops=611)
--           Heap Blocks: exact=51324
--
-- Es CUADRÁTICO en la cantidad de productos del negocio. Venía degradándose
-- solo, y cruzó los 8s por crecimiento del catálogo. La prueba de que SEC-08B
-- no lo causó se midió sobre los mismos datos y el mismo actor: la forma
-- ANTERIOR de la vista —leyendo `inventory.cost_price` directo, sin JOIN a
-- `v_inventory_costs`, sin un solo objeto de SEC-08B— tarda 32.063 ms contra
-- los 32.786 ms de la forma actual. La diferencia es 2%: ruido. El nodo caro
-- es idéntico en los dos planes, y el predicado `VPREF-` existe desde
-- 20260704120000, muy anterior al lote.
--
-- LA CORRECCIÓN
--
-- El conjunto de exclusión no depende de la fila externa: es un conjunto por
-- negocio. Se calcula UNA vez y se anti-joinea por igualdad, que sí hashea.
-- La aritmética, el universo y las diez columnas publicadas no cambian.
--
-- DOS cosas, y las dos hacen falta. Con sólo mover el `NOT EXISTS` a un
-- `LEFT JOIN ... IS NULL` el planner TODAVÍA elegía el plan cuadrático cuando
-- las estadísticas estaban desactualizadas —medido: 68 ms con stats frescas,
-- 2.749 ms con stats viejas sobre el mismo fixture—. Por eso además:
--   · el join es `uuid = uuid` entre columnas, no contra una cadena construida;
--   · las CTE de exclusión son `AS MATERIALIZED`, que fuerza UNA evaluación.
-- Un arreglo que depende de que el planner tenga suerte no es un arreglo.
--
--   antes  32.786 ms
--   ahora     150 ms   (219×, con `Heap Blocks: exact=84` y loops=1)
--
-- Equivalencia verificada en producción sobre TODOS los negocios y las diez
-- métricas: 0 filas divergentes.
--
-- No se agrega ningún índice. El escaneo que quedó es una sola pasada de 84
-- bloques; el problema era el orden de crecimiento, no la falta de un índice.
-- ============================================================================

CREATE OR REPLACE VIEW public.v_finance_inventory_capital
  WITH (security_invoker = true) AS
WITH variant_parents AS MATERIALIZED (
  -- Padres por `parent_id`. DISTINCT para que el anti-join no multiplique.
  SELECT DISTINCT v.business_id, v.parent_id
    FROM public.inventory v
   WHERE v.parent_id IS NOT NULL
),
vpref_parents AS MATERIALIZED (
  -- Padres por la convención `supplier_code = 'VPREF-<id>'`.
  --
  -- Se EXTRAE el uuid del código en vez de reconstruir el código a partir del
  -- id. La diferencia es la que importa: así el anti-join queda como una
  -- igualdad `uuid = uuid` entre dos columnas, que el planner puede hashear.
  -- Reconstruyendo la cadena, la comparación depende de la fila externa y el
  -- planner sigue habilitado a reescanear por fila (lo verificamos: con
  -- estadísticas desactualizadas volvía a elegir el plan cuadrático).
  --
  -- El regex acepta EXACTAMENTE la forma que produce `i.id::text` —36 chars,
  -- minúscula, con guiones—, así que el universo excluido es idéntico al de
  -- la comparación textual anterior: lo que aquélla no podía matchear (código
  -- en mayúscula, mal formado, con basura al final) tampoco entra acá. Y el
  -- cast a uuid es seguro justamente porque el regex ya lo garantizó.
  SELECT DISTINCT v.business_id,
         substring(v.supplier_code FROM 7)::uuid AS parent_id
    FROM public.inventory v
   WHERE v.supplier_code ~ '^VPREF-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
),
base AS (
  SELECT
    i.business_id,
    i.stock_quantity,
    COALESCE(c.cost_price, 0)::numeric AS cost_price,
    i.base_currency,
    i.exchange_rate_used
  FROM public.inventory i
  -- SEC-08B: el costo sigue llegando por la vista autorizada, y sigue siendo
  -- JOIN y no LEFT JOIN. Sin autoridad de costo la vista no devuelve filas,
  -- en vez de devolver un cero que se leería como «no hay capital».
  JOIN public.v_inventory_costs c ON c.inventory_id = i.id
  LEFT JOIN variant_parents p
         ON p.business_id = i.business_id AND p.parent_id = i.id
  LEFT JOIN vpref_parents vp
         ON vp.business_id = i.business_id AND vp.parent_id = i.id
  WHERE i.is_active = true
    AND COALESCE(i.tipo, 'product') = 'product'
    AND p.parent_id IS NULL
    AND vp.parent_id IS NULL
)
SELECT
  b.business_id,
  round(COALESCE(sum(b.stock_quantity::numeric * b.cost_price) FILTER (WHERE b.stock_quantity <> 0), 0), 2) AS inventory_at_cost,
  round(COALESCE(sum(b.stock_quantity::numeric * b.cost_price) FILTER (WHERE b.stock_quantity > 0 AND b.cost_price > 0), 0), 2) AS inventory_at_cost_valued,
  count(*) FILTER (WHERE b.stock_quantity > 0) AS products_total,
  count(*) FILTER (WHERE b.stock_quantity > 0 AND b.cost_price > 0) AS products_valued,
  count(*) FILTER (WHERE b.stock_quantity > 0 AND b.cost_price <= 0) AS products_missing_cost,
  COALESCE(sum(b.stock_quantity) FILTER (WHERE b.stock_quantity > 0 AND b.cost_price <= 0), 0) AS units_missing_cost,
  count(*) FILTER (WHERE b.stock_quantity < 0) AS products_negative_stock,
  count(*) FILTER (WHERE b.stock_quantity > 0 AND b.base_currency = 'USD') AS usd_based_products,
  round(min(b.exchange_rate_used) FILTER (WHERE b.stock_quantity > 0 AND b.base_currency = 'USD' AND b.exchange_rate_used > 0), 2) AS usd_rate_min_applied,
  round(max(b.exchange_rate_used) FILTER (WHERE b.stock_quantity > 0 AND b.base_currency = 'USD' AND b.exchange_rate_used > 0), 2) AS usd_rate_max_applied
FROM base b
GROUP BY b.business_id;

COMMENT ON VIEW public.v_finance_inventory_capital IS
  'Capital inmovilizado en inventario, al costo vigente. El costo llega por '
  'v_inventory_costs (SEC-08B): el JOIN es deliberado, sin autoridad no hay '
  'filas en vez de un cero enganoso. Los padres de variante se excluyen por '
  'las DOS convenciones (parent_id y supplier_code VPREF-<id>), calculadas '
  'como conjuntos una sola vez: hacerlo con NOT EXISTS correlacionado era '
  'cuadratico y hacia expirar get_finance_charts_l1.';

-- ============================================================================
-- POSTCONDICIONES
-- ============================================================================
DO $post$
DECLARE
  v_cols text;
  v_esperado text := 'business_id, inventory_at_cost, inventory_at_cost_valued, '
                  || 'products_total, products_valued, products_missing_cost, '
                  || 'units_missing_cost, products_negative_stock, '
                  || 'usd_based_products, usd_rate_min_applied, usd_rate_max_applied';
  v_div bigint;
  v_reloptions text;
BEGIN
  -- P1. El contrato publicado no se movio: mismas columnas, mismo orden.
  SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'v_finance_inventory_capital';
  IF v_cols IS DISTINCT FROM v_esperado THEN
    RAISE EXCEPTION 'POSTCONDICION P1: cambio el contrato de columnas. Esperado [%], obtenido [%]', v_esperado, v_cols;
  END IF;

  -- P2. Sigue siendo security_invoker. Un CREATE OR REPLACE VIEW sin WITH
  -- resetea reloptions, y perderlo convertiria la vista en un bypass de RLS.
  SELECT COALESCE(array_to_string(c.reloptions, ','), '') INTO v_reloptions
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'v_finance_inventory_capital';
  IF v_reloptions NOT LIKE '%security_invoker=true%' THEN
    RAISE EXCEPTION 'POSTCONDICION P2: la vista perdio security_invoker=true (reloptions=[%])', v_reloptions;
  END IF;

  -- P3. Solo lectura, y el navegador la conserva.
  IF NOT has_table_privilege('authenticated', 'public.v_finance_inventory_capital', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDICION P3a: authenticated perdio SELECT sobre v_finance_inventory_capital';
  END IF;
  IF has_table_privilege('authenticated', 'public.v_finance_inventory_capital', 'INSERT')
  OR has_table_privilege('authenticated', 'public.v_finance_inventory_capital', 'UPDATE')
  OR has_table_privilege('authenticated', 'public.v_finance_inventory_capital', 'DELETE') THEN
    RAISE EXCEPTION 'POSTCONDICION P3b: v_finance_inventory_capital dejo de ser de solo lectura';
  END IF;
  IF has_table_privilege('anon', 'public.v_finance_inventory_capital', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDICION P3c: anon gano SELECT sobre v_finance_inventory_capital';
  END IF;

  -- P4. SEC-08B intacto: el costo sigue viniendo de la vista autorizada y la
  -- vista NO lee inventory.cost_price crudo.
  IF pg_get_viewdef('public.v_finance_inventory_capital'::regclass, true) NOT LIKE '%v_inventory_costs%' THEN
    RAISE EXCEPTION 'POSTCONDICION P4a: la vista dejo de tomar el costo de v_inventory_costs';
  END IF;
  IF pg_get_viewdef('public.v_finance_inventory_capital'::regclass, true) LIKE '%i.cost_price%' THEN
    RAISE EXCEPTION 'POSTCONDICION P4b: la vista volvio a leer inventory.cost_price crudo';
  END IF;

  -- P5. EQUIVALENCIA. Se recalcula el universo con la forma ANTERIOR
  -- (NOT EXISTS correlacionado) y se compara metrica por metrica. Ambas
  -- consultas corren bajo el mismo rol, asi que la visibilidad es la misma y
  -- la comparacion es valida.
  WITH referencia AS (
    SELECT i.business_id, i.stock_quantity,
           COALESCE(c.cost_price, 0)::numeric AS cost_price,
           i.base_currency, i.exchange_rate_used
      FROM public.inventory i
      JOIN public.v_inventory_costs c ON c.inventory_id = i.id
     WHERE i.is_active = true
       AND COALESCE(i.tipo, 'product') = 'product'
       AND NOT EXISTS (SELECT 1 FROM public.inventory v
                        WHERE v.business_id = i.business_id AND v.parent_id = i.id)
       AND NOT EXISTS (SELECT 1 FROM public.inventory v
                        WHERE v.business_id = i.business_id
                          AND v.supplier_code = 'VPREF-' || i.id::text)
  ), esperado AS (
    SELECT business_id,
           round(COALESCE(sum(stock_quantity::numeric * cost_price) FILTER (WHERE stock_quantity <> 0), 0), 2) AS inventory_at_cost,
           round(COALESCE(sum(stock_quantity::numeric * cost_price) FILTER (WHERE stock_quantity > 0 AND cost_price > 0), 0), 2) AS inventory_at_cost_valued,
           count(*) FILTER (WHERE stock_quantity > 0) AS products_total,
           count(*) FILTER (WHERE stock_quantity > 0 AND cost_price > 0) AS products_valued,
           count(*) FILTER (WHERE stock_quantity > 0 AND cost_price <= 0) AS products_missing_cost,
           COALESCE(sum(stock_quantity) FILTER (WHERE stock_quantity > 0 AND cost_price <= 0), 0) AS units_missing_cost,
           count(*) FILTER (WHERE stock_quantity < 0) AS products_negative_stock,
           count(*) FILTER (WHERE stock_quantity > 0 AND base_currency = 'USD') AS usd_based_products,
           round(min(exchange_rate_used) FILTER (WHERE stock_quantity > 0 AND base_currency = 'USD' AND exchange_rate_used > 0), 2) AS usd_rate_min_applied,
           round(max(exchange_rate_used) FILTER (WHERE stock_quantity > 0 AND base_currency = 'USD' AND exchange_rate_used > 0), 2) AS usd_rate_max_applied
      FROM referencia GROUP BY business_id
  ), obtenido AS (
    SELECT * FROM public.v_finance_inventory_capital
  )
  SELECT count(*) INTO v_div
    FROM ((SELECT * FROM esperado EXCEPT ALL SELECT * FROM obtenido)
          UNION ALL
          (SELECT * FROM obtenido EXCEPT ALL SELECT * FROM esperado)) d;
  IF v_div <> 0 THEN
    RAISE EXCEPTION 'POSTCONDICION P5: la reescritura cambio % filas de capital en stock', v_div;
  END IF;

  RAISE NOTICE 'v_finance_inventory_capital: anti-join hoisted, contrato y valores intactos';
END $post$;
