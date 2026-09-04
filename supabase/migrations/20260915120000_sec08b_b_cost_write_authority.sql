-- ─────────────────────────────────────────────────────────────────────────────
-- SEC-08B · Fase B — PRESERVACIÓN DEL COSTO y CONTENCIÓN DEL COGS CRUDO
-- ─────────────────────────────────────────────────────────────────────────────
--
-- La revisión independiente confirmó dos bloqueantes sobre 4a069fe.
--
-- ── BLOQUEANTE 1 · destrucción silenciosa del costo ─────────────────────────
-- La Fase A dejó de enviar `cost_price` en las lecturas operativas, pero los
-- flujos de edición seguían mandándolo de vuelta. Medido de punta a punta:
--
--     costo real 51101.00  →  el usuario edita el nombre  →  HTTP 200
--                          →  costo almacenado 0.00
--
-- Reproducido para owner, admin y sales. Y arranca con el DESPLIEGUE DEL
-- FRONTEND, antes del db push, porque la escritura del costo estaba abierta.
--
-- Arreglarlo sólo en el cliente no alcanza: la integridad de un dato financiero
-- no puede depender de que ningún caller se olvide. La ley se pone en la base:
--
--     un actor que NO puede LEER el costo tampoco puede REEMPLAZARLO
--
-- No se rechaza la operación —eso rompería la edición operativa legítima de
-- `sales`, que edita stock y ubicación—: se PRESERVA el costo anterior y se
-- ignora lo que el cliente haya mandado. Distingue «campo ausente» de «un
-- autorizado puso 0 a propósito», que son operaciones distintas.
--
-- ── BLOQUEANTE 2 · COGS crudo alcanzable ────────────────────────────────────
-- `v_comprobante_item_costs` estaba gateada por `inventory_view_costs OR
-- finance` y devolvía `inventory_id + costo_unitario` ENUMERABLE. Un cashier
-- por defecto, y un `sales` con override de `finance`, obtenían el costo de
-- adquisición exacto de cada producto vendido. La capacidad dedicada
-- «Ver precios de costo» quedaba sin efecto.
--
-- Acá se separan las dos clases de payload:
--
--     inventory_view_costs → costo CRUDO por línea / por producto
--     finance              → AGREGADO de período que el P&L necesita
--
-- El P&L no pierde nada: pasa a tomar su COGS de `v_finance_period_cogs`, que
-- agrega por negocio y fecha y NO tiene dimensión de producto, así que no se
-- puede filtrar hasta convertirse en un oráculo de costo unitario.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Autoridad de ESCRITURA del costo — la ley vive en la base
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_inventory_guard_cost_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
-- `pg_temp` explícito y AL FINAL: omitirlo no lo saca del path, lo pone PRIMERO.
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_business uuid := COALESCE(NEW.business_id, OLD.business_id);
  v_parent   public.inventory%ROWTYPE;
BEGIN
  -- Sin JWT no hay actor de navegador: service_role, migraciones, triggers y
  -- RPCs internas conservan su autoridad. Gatear acá rompería el checkout, el
  -- alta rápida de compra y cualquier camino canónico server-side.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Quien puede ver el costo puede escribirlo: incluido ponerlo en 0 a
  -- propósito, que es un valor de negocio válido y distinto de «no lo mandé».
  IF public.can_view_inventory_cost(v_business) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- El actor no autorizado NO puede reemplazar el costo. No se aborta: se
    -- conserva el valor anterior y se ignora el del payload. Abortar rompería
    -- la edición operativa legítima (nombre, stock, ubicación) de `sales`.
    NEW.cost_price     := OLD.cost_price;
    NEW.cost_price_usd := OLD.cost_price_usd;
    RETURN NEW;
  END IF;

  -- INSERT. Una VARIANTE hereda el costo del padre: el formulario lo
  -- pre-cargaba desde el padre, y desde la Fase A el navegador ya no lo
  -- recibe. Se resuelve server-side para no fabricar un cero ni revelarle el
  -- costo del padre a quien no puede verlo.
  IF NEW.parent_id IS NOT NULL AND COALESCE(NEW.cost_price, 0) = 0 THEN
    SELECT * INTO v_parent
      FROM public.inventory
     WHERE id = NEW.parent_id AND business_id = v_business;
    IF FOUND THEN
      NEW.cost_price     := v_parent.cost_price;
      NEW.cost_price_usd := v_parent.cost_price_usd;
    END IF;
  END IF;

  -- Producto NUEVO sin padre creado por alguien sin autoridad de costo: queda
  -- en 0, que en este modelo YA significa «sin costo cargado» —lo cuenta
  -- `v_finance_inventory_capital.products_missing_cost` y lo muestra
  -- `useInventoryFinance` como estado 'sin_costo'—. No se inventa un costo y no
  -- se destruye ninguno, porque no había ninguno.
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.tg_inventory_guard_cost_write() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.tg_inventory_guard_cost_write() FROM PUBLIC;

COMMENT ON FUNCTION public.tg_inventory_guard_cost_write() IS
  'SEC-08B Fase B — quien no puede LEER el costo no puede REEMPLAZARLO. En '
  'UPDATE conserva el valor anterior en vez de abortar, para no romper la '
  'edición operativa. En INSERT de variante hereda el costo del padre '
  'server-side. auth.uid() NULL (service_role, RPCs canónicas) pasa intacto.';

DROP TRIGGER IF EXISTS trig_inventory_guard_cost_write ON public.inventory;
CREATE TRIGGER trig_inventory_guard_cost_write
  BEFORE INSERT OR UPDATE ON public.inventory
  FOR EACH ROW EXECUTE FUNCTION public.tg_inventory_guard_cost_write();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. El costo CRUDO de la línea vuelve a la capacidad dedicada
-- ─────────────────────────────────────────────────────────────────────────────
-- `finance` sale del gate. Se conserva íntegro el predicado de orden vinculada
-- de SEC-08A, que esta vista repone porque al ser DEFINER no lo hereda.
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
   AND public.can_view_inventory_cost(ci.business_id);

COMMENT ON VIEW public.v_comprobante_item_costs IS
  'SEC-08B Fase B — costo CRUDO de la línea de venta. Gate: inventory_view_costs '
  'ÚNICAMENTE. `finance` ya no alcanza: entregaba inventory_id + costo_unitario '
  'enumerable y dejaba sin efecto la capacidad dedicada «Ver precios de costo». '
  'El agregado que el P&L necesita vive en v_finance_period_cogs.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. El AGREGADO de período que sí corresponde a `finance`
-- ─────────────────────────────────────────────────────────────────────────────
-- Granularidad negocio + fecha, SIN dimensión de producto ni de línea: no se
-- puede filtrar por `inventory_id` ni por comprobante, así que no degenera en
-- un oráculo de costo unitario.
--
-- Replica EXACTAMENTE los dos ramos del ledger (venta y anulación) para que la
-- aritmética del P&L no cambie ni un centavo; hay un test que compara este
-- agregado contra la suma del ledger autorizado, período por período.
CREATE OR REPLACE VIEW public.v_finance_period_cogs AS
 WITH eff AS (
         SELECT c.id, c.business_id, c.total,
            (COALESCE(c.fecha, c.date, c.created_at) AT TIME ZONE 'America/Argentina/Cordoba'::text)::date AS period_date,
            COALESCE(c.tipo, c.type) = 'nota_credito'::text AS is_credit_note
           FROM public.comprobantes c
          WHERE (COALESCE(c.status, c.estado) = ANY (ARRAY['issued'::text, 'emitido'::text]))
             OR (EXISTS ( SELECT 1 FROM public.comprobante_payments p WHERE p.comprobante_id = c.id))
             OR (EXISTS ( SELECT 1 FROM public.comprobante_items ci WHERE ci.comprobante_id = c.id AND ci.stock_processed = true))
             OR (EXISTS ( SELECT 1 FROM public.account_movements am WHERE am.reference_type = 'comprobante'::text AND am.reference_id = c.id AND am.type = 'venta'::text))
             OR (EXISTS ( SELECT 1 FROM public.comprobante_annulments a WHERE a.comprobante_id = c.id AND a.status = 'completed'::text))
        ), ann AS (
         SELECT a.comprobante_id, a.business_id,
            COALESCE(a.annulment_date, (a.created_at AT TIME ZONE 'America/Argentina/Cordoba'::text)::date) AS period_date
           FROM public.comprobante_annulments a
          WHERE a.status = 'completed'::text
        ), filas AS (
         SELECT e.business_id, e.period_date,
                ci.costo_total AS cogs,
                (ci.inventory_id IS NOT NULL
                 AND COALESCE(ci.costo_unitario, 0::numeric) = 0::numeric
                 AND (ci.tipo_linea = ANY (ARRAY['producto'::text, 'repuesto'::text]))) AS missing_cost
           FROM eff e
           JOIN public.comprobante_items ci ON ci.comprobante_id = e.id
          WHERE e.is_credit_note = false
        UNION ALL
         SELECT e.business_id, a.period_date,
                - ci.costo_total AS cogs,
                false AS missing_cost
           FROM eff e
           JOIN ann a ON a.comprobante_id = e.id AND a.business_id = e.business_id
           JOIN public.comprobante_items ci ON ci.comprobante_id = e.id
          WHERE e.is_credit_note = false
        )
 SELECT business_id,
        period_date,
        sum(cogs)                                AS cogs_amount_ars,
        count(*) FILTER (WHERE missing_cost)     AS missing_cost_items
   FROM filas
  WHERE business_id = public.current_user_business_id()
    AND public.can_view_cogs(business_id)
  GROUP BY business_id, period_date;

ALTER VIEW public.v_finance_period_cogs OWNER TO postgres;
REVOKE ALL ON public.v_finance_period_cogs FROM PUBLIC;
REVOKE ALL ON public.v_finance_period_cogs FROM anon;
GRANT SELECT ON public.v_finance_period_cogs TO authenticated;
GRANT SELECT ON public.v_finance_period_cogs TO service_role;

COMMENT ON VIEW public.v_finance_period_cogs IS
  'SEC-08B Fase B — COGS agregado por negocio y período. Es el insumo del P&L '
  'para quien tiene `finance` sin `inventory_view_costs`. No expone producto ni '
  'línea, así que no se puede estrechar hasta obtener un costo unitario.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. El P&L toma el COGS del agregado, no de la línea
-- ─────────────────────────────────────────────────────────────────────────────
-- Misma aritmética que en `main` y que en la Fase A. Lo único que cambia es de
-- dónde sale `cogs`: antes del ledger por línea (que ahora se cierra a
-- `inventory_view_costs`), ahora del agregado de período.
CREATE OR REPLACE VIEW public.v_finance_pnl
WITH (security_invoker = true) AS
 WITH sales AS (
         SELECT l.business_id, l.period_date,
            sum(l.gross_amount_ars) AS gross_sales,
            sum(l.discount_amount_ars) AS discounts,
            sum(l.sales_amount_ars) AS net_line_sales
           FROM v_finance_sales_ledger l
          WHERE l.is_credit_note = false
          GROUP BY l.business_id, l.period_date
        ), cogs AS (
         SELECT c.business_id, c.period_date, c.cogs_amount_ars, c.missing_cost_items
           FROM public.v_finance_period_cogs c
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
    round(COALESCE(g.cogs_amount_ars, 0::numeric), 2) AS cogs,
    round(COALESCE(s.net_line_sales, 0::numeric) - COALESCE(r.sales_returns, 0::numeric) - COALESCE(g.cogs_amount_ars, 0::numeric), 2) AS gross_profit,
    round(COALESCE(e.payment_fees, 0::numeric), 2) AS payment_fees,
    round(COALESCE(e.operating_expenses, 0::numeric), 2) AS operating_expenses,
    round(COALESCE(e.employee_salaries, 0::numeric), 2) AS employee_salaries,
    round(COALESCE(s.net_line_sales, 0::numeric) - COALESCE(r.sales_returns, 0::numeric) - COALESCE(g.cogs_amount_ars, 0::numeric) - COALESCE(e.payment_fees, 0::numeric) - COALESCE(e.operating_expenses, 0::numeric) - COALESCE(e.employee_salaries, 0::numeric), 2) AS operating_result,
    jsonb_build_object('missing_cost_items', COALESCE(g.missing_cost_items, 0::bigint), 'unclassified_amount', round(COALESCE(e.unclassified_amount, 0::numeric), 2)) AS data_quality_flags
   FROM keys k
     LEFT JOIN sales s ON s.business_id = k.business_id AND s.period_date = k.period_date
     LEFT JOIN cogs g ON g.business_id = k.business_id AND g.period_date = k.period_date
     LEFT JOIN returns r ON r.business_id = k.business_id AND r.period_date = k.period_date
     LEFT JOIN expenses e ON e.business_id = k.business_id AND e.period_date = k.period_date
  WHERE public.can_view_cogs(k.business_id);

COMMENT ON VIEW public.v_finance_pnl IS
  'SEC-08B Fase B — misma aritmética; el COGS entra por v_finance_period_cogs '
  '(agregado) en vez del ledger por línea, que quedó cerrado a '
  'inventory_view_costs. `finance` conserva el P&L exacto sin recibir costo '
  'crudo por producto.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Postcondiciones
-- ─────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_def text;
BEGIN
  -- El gate del costo crudo por línea NO puede volver a aceptar `finance`.
  SELECT pg_get_viewdef('public.v_comprobante_item_costs'::regclass, true) INTO v_def;
  IF v_def ILIKE '%can_view_cogs%' THEN
    RAISE EXCEPTION 'SEC-08B/B: v_comprobante_item_costs volvió a gatearse con can_view_cogs';
  END IF;
  IF v_def NOT ILIKE '%can_view_inventory_cost%' THEN
    RAISE EXCEPTION 'SEC-08B/B: v_comprobante_item_costs perdió el gate de inventory_view_costs';
  END IF;
  IF v_def NOT ILIKE '%comprobante_is_order_linked%' THEN
    RAISE EXCEPTION 'SEC-08B/B: v_comprobante_item_costs perdió el predicado de orden de SEC-08A';
  END IF;

  -- El agregado no puede exponer dimensión de producto ni de línea.
  SELECT string_agg(column_name, ', ') INTO v_def FROM information_schema.columns
   WHERE table_schema='public' AND table_name='v_finance_period_cogs'
     AND column_name IN ('inventory_id','comprobante_id','comprobante_item_id','descripcion');
  IF v_def IS NOT NULL THEN
    RAISE EXCEPTION 'SEC-08B/B: v_finance_period_cogs expone dimensión de producto/línea: %', v_def;
  END IF;

  -- El trigger de preservación tiene que estar montado.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                  JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='public' AND c.relname='inventory'
                   AND t.tgname='trig_inventory_guard_cost_write' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'SEC-08B/B: falta el trigger de preservación del costo';
  END IF;

  -- anon sigue sin poder ejecutar la autoridad ni leer el agregado.
  IF has_function_privilege('anon', 'public.can_view_inventory_cost(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SEC-08B/B: anon recuperó EXECUTE sobre can_view_inventory_cost';
  END IF;
  IF has_table_privilege('anon', 'public.v_finance_period_cogs', 'SELECT') THEN
    RAISE EXCEPTION 'SEC-08B/B: anon puede leer v_finance_period_cogs';
  END IF;

  -- Y las columnas de costo siguen revocadas para el navegador (Fase A).
  IF EXISTS (SELECT 1 FROM information_schema.column_privileges
              WHERE table_schema='public' AND privilege_type='SELECT'
                AND grantee IN ('anon','authenticated')
                AND ((table_name='inventory' AND column_name IN ('cost_price','cost_price_usd'))
                  OR (table_name='comprobante_items' AND column_name IN ('costo_unitario','costo_total')))) THEN
    RAISE EXCEPTION 'SEC-08B/B: se reabrieron GRANT de columnas de costo';
  END IF;
END
$post$;

COMMIT;
