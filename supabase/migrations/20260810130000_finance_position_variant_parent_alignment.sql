-- ============================================================================
-- P1-B — Una sola definicion de "cuanto vale mi inventario".
--
-- ── EL DEFECTO ─────────────────────────────────────────────────────────────
-- El modelo admite DOS convenciones para vincular una variante a su padre:
--
--   1. inventory.parent_id = <id del padre>            (estructural, actual)
--   2. inventory.supplier_code = 'VPREF-' || <id>      (legacy, textual)
--
-- v_finance_inventory_capital (Charts L1) excluye padres por LAS DOS.
-- v_finance_position.inventory_at_cost excluia por la convencion legacy
-- UNICAMENTE. Mientras no exista ninguna variante creada con parent_id las dos
-- reglas dan el mismo numero — medido en produccion 2026-08-10: delta = 0.00 en
-- los 5 negocios con inventario. El dia que alguien cree la primera variante por
-- parent_id, v_finance_position sumaria EL PADRE Y SU HIJO (double-count)
-- mientras Charts L1 suma solo el hijo: dos cifras de inventario distintas en la
-- misma app, sin que nada falle ni avise.
--
-- ── LA REGLA CANONICA ──────────────────────────────────────────────────────
-- Una fila de `inventory` aporta a la valuacion de inventario si, y solo si:
--
--   · esta activa (is_active = true), y
--   · es mercaderia (COALESCE(tipo,'product') = 'product'), y
--   · NO es un padre agrupador — es decir, no existe en SU MISMO negocio otra
--     fila que la declare padre, por cualquiera de las dos convenciones.
--
-- Un padre de variantes no es stock: es un agrupador cuyo valor economico ya
-- esta representado por sus hijos. Contarlo ademas de sus hijos duplica capital.
-- La pertenencia se exige dentro del mismo business_id en las dos ramas: un
-- `supplier_code` que casualmente diga 'VPREF-<uuid ajeno>' no puede excluir un
-- producto de otro negocio.
--
-- ── COMO SE ARREGLA (y por que asi) ────────────────────────────────────────
-- No se copia el predicado corregido a v_finance_position: copiarlo deja DOS
-- lugares que pueden volver a divergir, que es exactamente el defecto que se
-- esta cerrando. En su lugar, el CTE `inv` pasa a LEER
-- v_finance_inventory_capital, que ya es la superficie canonica de la valuacion.
-- Queda una sola definicion en todo el sistema y la divergencia se vuelve
-- estructuralmente imposible.
--
-- Ambas vistas son security_invoker: la RLS sigue resolviendose con el rol que
-- consulta, sin escalar privilegios ni cambiar quien ve que.
--
-- ── ALCANCE ────────────────────────────────────────────────────────────────
--   · CREATE OR REPLACE de UNA vista. Solo cambia el cuerpo del CTE `inv`.
--   · CERO DML. Ni un INSERT/UPDATE/DELETE. Ni backfill.
--   · No toca ninguna otra columna de v_finance_position.
--   · No crea triggers, Realtime, materialized views ni SECURITY DEFINER.
--   · No modifica 20260810120000 (Charts L1) ni ninguna migracion aplicada.
--
-- ── DIFERENCIA SEMANTICA QUE SE CONSERVA A PROPOSITO ───────────────────────
-- v_finance_inventory_capital publica DOS totales y NO son sinonimos:
--   · inventory_at_cost        — universo con stock (incluye costo 0 y stock
--                                negativo). Es el que consume v_finance_position.
--   · inventory_at_cost_valued — universo stock>0 AND costo>0; comparte
--                                denominador con la regla dead_stock de M8.
-- v_finance_position.inventory_at_cost se alinea con el PRIMERO, que es el que
-- tiene su misma definicion. Igualarlo al segundo escondería el stock sin costo.
-- ============================================================================

-- BEGIN/COMMIT EXPLICITOS: el CLI aplica cada archivo en AUTOCOMMIT. Sin este
-- bloque los SET LOCAL son no-op y una postcondicion fallida dejaria la vista
-- reemplazada a medias en vez de abortar limpio.
BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

-- ============================================================================
-- 0. PRECONDICIONES
-- ============================================================================
DO $pre$
BEGIN
  IF to_regclass('public.v_finance_position') IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION P0: falta public.v_finance_position';
  END IF;
  IF to_regclass('public.v_finance_inventory_capital') IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION P1: falta public.v_finance_inventory_capital (Charts L1, migracion 20260810120000)';
  END IF;

  -- La fuente canonica debe seguir siendo security_invoker: si alguien la
  -- convirtio en definer, apoyarse en ella cambiaria quien ve que.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class
                  WHERE oid = 'public.v_finance_inventory_capital'::regclass
                    AND reloptions @> ARRAY['security_invoker=true']) THEN
    RAISE EXCEPTION 'PRECONDICION P2: v_finance_inventory_capital no es security_invoker';
  END IF;

  -- Las dos convenciones deben existir; si una desaparecio, la regla canonica
  -- ya no es la que este archivo documenta.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                  WHERE attrelid='public.inventory'::regclass
                    AND attname='parent_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PRECONDICION P3: falta inventory.parent_id';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                  WHERE attrelid='public.inventory'::regclass
                    AND attname='supplier_code' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PRECONDICION P4: falta inventory.supplier_code';
  END IF;
END
$pre$;

-- Baseline: permite exigir que NINGUNA otra metrica de la vista se movio, y
-- que el lote no escribio una sola fila.
DROP TABLE IF EXISTS _p1b_before;
CREATE TEMP TABLE _p1b_before AS SELECT * FROM public.v_finance_position;

DROP TABLE IF EXISTS _p1b_baseline;
CREATE TEMP TABLE _p1b_baseline AS
SELECT
  (SELECT count(*) FROM public.inventory)                        AS inv_rows,
  (SELECT COALESCE(sum(stock_quantity),0) FROM public.inventory) AS inv_units,
  (SELECT COALESCE(sum(cost_price),0) FROM public.inventory)     AS inv_cost,
  (SELECT count(*) FROM public.comprobantes)                     AS cmp_rows,
  (SELECT count(*) FROM public.supplier_account_movements)       AS sam_rows;

-- ============================================================================
-- 1. v_finance_position — mismo cuerpo, con `inv` delegado a la fuente canonica
-- ============================================================================
-- CREATE OR REPLACE VIEW *sin* la clausula WITH RESETEA las reloptions y la
-- vista perderia security_invoker en silencio. Va explicita, y la postcondicion
-- R1 lo verifica.
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
inv AS (
  -- P1-B: FUENTE UNICA de la valuacion de inventario. El predicado de exclusion
  -- de padres de variante (parent_id + VPREF- legacy) vive en
  -- v_finance_inventory_capital y en ningun otro lado. Duplicarlo aca es lo que
  -- produjo la divergencia que esta migracion cierra.
  SELECT c.business_id, c.inventory_at_cost
  FROM v_finance_inventory_capital c
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

COMMENT ON VIEW "public"."v_finance_position" IS
  'Posicion financiera por negocio (caja, inventario, CxC, CxP, flujos del '
  'propietario). inventory_at_cost se TOMA de v_finance_inventory_capital: la '
  'exclusion de padres de variante (parent_id y supplier_code VPREF- legacy) '
  'tiene una sola definicion en el sistema y no puede volver a divergir.';

-- Los GRANT no se pierden en un CREATE OR REPLACE (el objeto no se recrea),
-- pero se reafirman para que el estado deseado quede escrito en la migracion.
-- anon NO figura, y la postcondicion R2 lo exige.
GRANT SELECT ON "public"."v_finance_position" TO "authenticated", "service_role";

-- ============================================================================
-- 2. POSTCONDICIONES
-- ============================================================================
DO $post$
DECLARE
  v_b        record;
  v_delta    numeric;
  v_def      text;
  v_rows_now bigint;
  v_rows_pre bigint;
BEGIN
  SELECT * INTO v_b FROM _p1b_baseline;

  -- R1. Sigue siendo security_invoker (CREATE OR REPLACE sin WITH lo resetea).
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class
                  WHERE oid = 'public.v_finance_position'::regclass
                    AND reloptions @> ARRAY['security_invoker=true']) THEN
    RAISE EXCEPTION 'POSTCONDICION R1: v_finance_position perdio security_invoker';
  END IF;

  -- R2. anon no lee la vista.
  IF has_table_privilege('anon', 'public.v_finance_position', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDICION R2: anon puede leer v_finance_position';
  END IF;

  -- R3. authenticated conserva SELECT y sigue sin poder escribir.
  IF NOT has_table_privilege('authenticated', 'public.v_finance_position', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDICION R3a: authenticated perdio SELECT sobre v_finance_position';
  END IF;
  IF has_table_privilege('authenticated', 'public.v_finance_position', 'INSERT')
  OR has_table_privilege('authenticated', 'public.v_finance_position', 'UPDATE')
  OR has_table_privilege('authenticated', 'public.v_finance_position', 'DELETE') THEN
    RAISE EXCEPTION 'POSTCONDICION R3b: v_finance_position dejo de ser de solo lectura';
  END IF;

  -- R4. El predicado duplicado ya no existe en esta vista, y la fuente canonica
  -- si esta referenciada. Es lo que impide que la divergencia vuelva.
  v_def := pg_get_viewdef('public.v_finance_position'::regclass, true);
  IF v_def NOT LIKE '%v_finance_inventory_capital%' THEN
    RAISE EXCEPTION 'POSTCONDICION R4a: v_finance_position no lee la fuente canonica de inventario';
  END IF;
  IF v_def LIKE '%VPREF-%' THEN
    RAISE EXCEPTION 'POSTCONDICION R4b: quedo una copia del predicado VPREF- dentro de v_finance_position';
  END IF;

  -- R5. INVARIANTE: para todo negocio, la posicion y el capital en stock
  -- informan exactamente el mismo inventario.
  IF EXISTS (
    SELECT 1
    FROM public.v_finance_position p
    JOIN public.v_finance_inventory_capital c ON c.business_id = p.business_id
    WHERE p.inventory_at_cost IS DISTINCT FROM c.inventory_at_cost
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION R5: v_finance_position.inventory_at_cost no coincide con v_finance_inventory_capital.inventory_at_cost';
  END IF;

  -- R6. NINGUNA otra metrica de la vista se movio. inventory_at_cost queda
  -- fuera de la comparacion a proposito: es la unica que esta migracion puede
  -- corregir (y hoy, con 0 variantes por parent_id, tampoco se mueve).
  SELECT count(*) INTO v_rows_pre FROM _p1b_before;
  SELECT count(*) INTO v_rows_now FROM public.v_finance_position;
  IF v_rows_pre <> v_rows_now THEN
    RAISE EXCEPTION 'POSTCONDICION R6a: cambio la cantidad de filas de v_finance_position (% -> %)',
      v_rows_pre, v_rows_now;
  END IF;
  IF EXISTS (
    SELECT business_id, cash_total, cash_by_method, receivables, payables,
           owner_withdrawals_total, owner_contributions_total, owner_net_capital,
           data_quality_flags FROM _p1b_before
    EXCEPT ALL
    SELECT business_id, cash_total, cash_by_method, receivables, payables,
           owner_withdrawals_total, owner_contributions_total, owner_net_capital,
           data_quality_flags FROM public.v_finance_position
  ) OR EXISTS (
    SELECT business_id, cash_total, cash_by_method, receivables, payables,
           owner_withdrawals_total, owner_contributions_total, owner_net_capital,
           data_quality_flags FROM public.v_finance_position
    EXCEPT ALL
    SELECT business_id, cash_total, cash_by_method, receivables, payables,
           owner_withdrawals_total, owner_contributions_total, owner_net_capital,
           data_quality_flags FROM _p1b_before
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION R6b: se movio alguna metrica de v_finance_position distinta de inventory_at_cost';
  END IF;

  -- R7. CERO DML.
  IF (SELECT count(*) FROM public.inventory) <> v_b.inv_rows
  OR (SELECT COALESCE(sum(stock_quantity),0) FROM public.inventory) <> v_b.inv_units
  OR (SELECT COALESCE(sum(cost_price),0) FROM public.inventory) <> v_b.inv_cost THEN
    RAISE EXCEPTION 'POSTCONDICION R7a: cambio inventory';
  END IF;
  IF (SELECT count(*) FROM public.comprobantes) <> v_b.cmp_rows
  OR (SELECT count(*) FROM public.supplier_account_movements) <> v_b.sam_rows THEN
    RAISE EXCEPTION 'POSTCONDICION R7b: cambiaron filas fuera de alcance';
  END IF;

  -- Traza: cuanto capital deja de contarse dos veces AL APLICAR. Es NOTICE y no
  -- EXCEPTION a proposito — un delta distinto de 0 significa que ya existia una
  -- variante por parent_id y que el double-count era real, que es exactamente lo
  -- que esta migracion viene a corregir.
  SELECT COALESCE(sum(x.legacy - x.canonico), 0) INTO v_delta
  FROM (
    SELECT
      (SELECT round(COALESCE(sum(i.stock_quantity::numeric * COALESCE(i.cost_price,0)),0),2)
         FROM public.inventory i
        WHERE i.business_id = b.id
          AND i.is_active = true AND COALESCE(i.tipo,'product')='product'
          AND NOT EXISTS (SELECT 1 FROM public.inventory v
                           WHERE v.business_id=i.business_id
                             AND v.supplier_code='VPREF-'||i.id::text)) AS legacy,
      COALESCE((SELECT c.inventory_at_cost FROM public.v_finance_inventory_capital c
                 WHERE c.business_id = b.id), 0)                        AS canonico
    FROM public.businesses b
  ) x;
  RAISE NOTICE 'P1-B OK — v_finance_position.inventory_at_cost delegado a v_finance_inventory_capital. Capital que dejaba de duplicarse al aplicar: %', v_delta;
END
$post$;

DROP TABLE IF EXISTS _p1b_before;
DROP TABLE IF EXISTS _p1b_baseline;

COMMIT;

-- PostgREST cachea el esquema; la vista cambio de cuerpo.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado)
--   CREATE OR REPLACE VIEW public.v_finance_position WITH (security_invoker=true)
--   ... con el CTE `inv` original:
--     inv AS (
--       SELECT i.business_id,
--              ROUND(SUM(i.stock_quantity * COALESCE(i.cost_price,0)),2) AS inventory_at_cost
--       FROM inventory i
--       WHERE i.is_active = true AND COALESCE(i.tipo,'product')='product'
--         AND NOT EXISTS (SELECT 1 FROM inventory v
--                          WHERE v.business_id=i.business_id
--                            AND v.supplier_code = 'VPREF-' || i.id::text)
--       GROUP BY 1
--     )
--   NO OLVIDAR la clausula WITH: sin ella la vista pierde security_invoker.
--   Volver atras REABRE el double-count por parent_id.
-- ============================================================================
