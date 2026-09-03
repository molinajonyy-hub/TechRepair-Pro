-- ─────────────────────────────────────────────────────────────────────────────
-- SEC-08B · Fase C — AUTORIDAD DE COSTO EN INSERT (y la exención que faltaba)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- La Fase B cerró el UPDATE pero dejó dos huecos, los dos MEDIDOS:
--
-- ── HUECO 1 · el INSERT acepta cualquier costo ──────────────────────────────
-- `sales` (inventory=true, inventory_view_costs=false) tiene autoridad de
-- INSERT — la policy `inventory_insert` pide `current_user_can('inventory')` —
-- así que por PostgREST directo:
--
--     POST /inventory {"cost_price": 999999}     → almacenado 999999
--     POST /inventory {"cost_price": 999999,
--                      "parent_id": <padre 51101>} → almacenado 999999
--
-- Sólo la variante que casualmente mandaba 0 heredaba del padre. Es decir: un
-- actor que NO puede LEER el costo podía ESCRIBIRLO a voluntad, y encima sin
-- poder verlo después — envenenamiento a ciegas del libro de costos.
--
-- ── HUECO 2 · la Fase B se pasó de largo con los caminos canónicos ──────────
-- `create_supplier_purchase_atomic` es SECURITY DEFINER, está gateada por la
-- capacidad `inventory` (no por `inventory_view_costs`) y actualiza
-- `inventory.cost_price` con el `unit_cost` de la línea de compra. Con la Fase B
-- aplicada, una compra registrada por `sales` devolvía `ok: true`, creaba el
-- comprobante de compra… y NO actualizaba el costo. Medido: costo 51101, compra
-- por 42424, costo después 51101. Una compra registrada que no mueve el costo es
-- una inconsistencia financiera, no una protección.
--
-- El discriminador correcto es `current_user`, no `auth.uid()`:
--
--     PostgREST directo      → current_user = 'authenticated'
--     dentro de una SECDEF   → current_user = 'postgres' (dueño de la función)
--
-- Se midió en este mismo stack. `auth.uid()` NO sirve para distinguirlos: dentro
-- de una SECDEF invocada por un usuario del navegador sigue devolviendo su sub.
--
-- ── Por qué el guardián deja de ser SECURITY DEFINER ────────────────────────
-- Dentro de una función SECURITY DEFINER, `current_user` es SIEMPRE su dueño,
-- así que un trigger DEFINER no puede ver el rol externo y el discriminador
-- queda inerte. El guardián pasa a INVOKER, y se midió que en ese modo:
--
--   · ve el rol real          → 'authenticated' directo, 'postgres' en la RPC;
--   · lee OLD.cost_price y NEW.cost_price igual, aunque la columna esté
--     revocada para `authenticated` — los registros OLD/NEW los entrega el
--     ejecutor y no son una referencia a columna sujeta a GRANT.
--
-- Lo único que un INVOKER no puede hacer es LEER el costo del producto padre.
-- Por eso la herencia de la variante se mueve a un segundo trigger AFTER que sí
-- es DEFINER y que NO DEVUELVE NADA: escribe el costo heredado en la fila y el
-- actor sigue sin poder leerlo. Un helper DEFINER que devolviera ese costo sería
-- un oráculo, porque PostgREST expone toda función de `public` ejecutable.
--
-- CONSECUENCIA EXPLÍCITA, para la revisión final: la compra a proveedor SIGUE
-- pudiendo establecer el costo aunque quien la registre no pueda verlo. No es un
-- escape: es el flujo canónico que ESTABLECE el costo, está gateado por
-- `inventory`, deja documento de compra y queda auditable. Lo que se cierra es
-- la escritura ARBITRARIA y silenciosa por la tabla.

BEGIN;

CREATE OR REPLACE FUNCTION public.tg_inventory_guard_cost_write()
RETURNS trigger
LANGUAGE plpgsql
-- INVOKER a propósito: es la ÚNICA forma de ver el rol externo real. Ver la
-- cabecera. No hace falta privilegio extra — OLD/NEW los entrega el ejecutor.
-- `pg_temp` explícito y AL FINAL: omitirlo no lo saca del path, lo pone PRIMERO.
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_business uuid := COALESCE(NEW.business_id, OLD.business_id);
BEGIN
  -- ── 1. Contexto que NO es el navegador ────────────────────────────────────
  -- `current_user` deja de ser un rol de navegador en dos casos que hay que
  -- respetar: service_role / postgres (backend, migraciones, triggers) y el
  -- interior de una función SECURITY DEFINER canónica, donde pasa a ser su
  -- dueño. Ahí la autoridad ya la resolvió la RPC —Lote 3 la gatea por
  -- capacidad— y este trigger no tiene nada que agregar.
  IF auth.uid() IS NULL OR current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- ── 2. Actor autorizado ───────────────────────────────────────────────────
  -- Quien puede ver el costo lo escribe, incluido un 0 deliberado, que es un
  -- valor de negocio válido y distinto de «no mandé el campo».
  IF public.can_view_inventory_cost(v_business) THEN
    RETURN NEW;
  END IF;

  -- ── 3. Actor SIN autoridad ────────────────────────────────────────────────
  IF TG_OP = 'UPDATE' THEN
    -- Se conserva el valor anterior y se ignora el del payload. No se aborta:
    -- abortar rompería la edición operativa legítima (nombre, stock, ubicación).
    NEW.cost_price     := OLD.cost_price;
    NEW.cost_price_usd := OLD.cost_price_usd;
    RETURN NEW;
  END IF;

  -- INSERT. El cliente NO elige el costo, mande lo que mande. Queda en 0, que
  -- en este modelo YA significa «sin costo cargado» —lo cuenta
  -- `v_finance_inventory_capital.products_missing_cost` y lo muestra
  -- `useInventoryFinance` como estado 'sin_costo'—. No se destruye nada porque
  -- no había nada, y no se acepta el número que eligió el cliente.
  NEW.cost_price     := 0;
  NEW.cost_price_usd := 0;

  -- Si es una VARIANTE, el costo del padre lo repone el trigger AFTER, que sí
  -- tiene privilegio para leerlo. Se marca la fila en una variable de
  -- transacción en vez de resolverlo acá: como INVOKER no puede leer
  -- `inventory.cost_price` del padre.
  IF NEW.parent_id IS NOT NULL THEN
    PERFORM set_config('sec08b.inherit_variant_cost', NEW.id::text, true);
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.tg_inventory_guard_cost_write() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.tg_inventory_guard_cost_write() FROM PUBLIC;
-- Un trigger INVOKER lo ejecuta el actor: necesita EXECUTE. Llamarla a mano no
-- sirve de nada — PostgreSQL rechaza invocar una función de trigger fuera de un
-- trigger — así que concederla no abre ninguna superficie.
GRANT EXECUTE ON FUNCTION public.tg_inventory_guard_cost_write() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Herencia del costo del padre — AFTER, DEFINER, y sin devolver nada
-- ─────────────────────────────────────────────────────────────────────────────
-- Escribe el costo heredado directamente en la fila. El actor sigue sin poder
-- leerlo: la vista autorizada lo sigue filtrando por capacidad. Se hace acá y no
-- en un helper que devuelva el costo porque PostgREST expone cualquier función
-- de `public` que el rol pueda ejecutar, y esa función sería un oráculo.
CREATE OR REPLACE FUNCTION public.tg_inventory_inherit_variant_cost()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF COALESCE(current_setting('sec08b.inherit_variant_cost', true), '') <> NEW.id::text THEN
    RETURN NULL;
  END IF;
  -- Se consume la marca para que un UPDATE posterior en la misma transacción no
  -- vuelva a dispararla.
  PERFORM set_config('sec08b.inherit_variant_cost', '', true);

  -- El padre se busca acotado por `business_id`: un `parent_id` de otro tenant
  -- no encuentra fila y la variante se queda en 0. No hay herencia cruzada.
  UPDATE public.inventory v
     SET cost_price     = p.cost_price,
         cost_price_usd = p.cost_price_usd
    FROM public.inventory p
   WHERE v.id = NEW.id
     AND p.id = NEW.parent_id
     AND p.business_id = NEW.business_id;

  RETURN NULL;
END;
$$;

ALTER FUNCTION public.tg_inventory_inherit_variant_cost() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.tg_inventory_inherit_variant_cost() FROM PUBLIC;

DROP TRIGGER IF EXISTS trig_inventory_inherit_variant_cost ON public.inventory;
CREATE TRIGGER trig_inventory_inherit_variant_cost
  AFTER INSERT ON public.inventory
  FOR EACH ROW EXECUTE FUNCTION public.tg_inventory_inherit_variant_cost();

COMMENT ON FUNCTION public.tg_inventory_guard_cost_write() IS
  'SEC-08B Fase C — quien no puede LEER el costo no puede ESCRIBIRLO desde el '
  'navegador, ni en UPDATE (conserva OLD) ni en INSERT (variante hereda del '
  'padre del mismo negocio; producto suelto queda en 0). Exime los caminos '
  'no-navegador por `current_user`, que es lo único que distingue una llamada '
  'directa de PostgREST del interior de una SECDEF canónica.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Postcondiciones
-- ─────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_def text := pg_get_functiondef('public.tg_inventory_guard_cost_write()'::regprocedure);
BEGIN
  IF v_def !~ 'current_user NOT IN' THEN
    RAISE EXCEPTION 'SEC-08B/C: el trigger no distingue el contexto por current_user: las RPC canónicas volverían a no poder establecer el costo';
  END IF;
  IF v_def !~ 'NEW\.cost_price\s*:=\s*OLD\.cost_price' THEN
    RAISE EXCEPTION 'SEC-08B/C: el trigger perdió la preservación del costo en UPDATE';
  END IF;
  IF v_def !~ 'NEW\.cost_price\s*:=\s*0' THEN
    RAISE EXCEPTION 'SEC-08B/C: el trigger no fuerza 0 en el INSERT no autorizado';
  END IF;
  -- El guardián NO puede ser SECURITY DEFINER: ahí current_user es siempre su
  -- dueño y el discriminador de contexto queda inerte.
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.tg_inventory_guard_cost_write()'::regprocedure) THEN
    RAISE EXCEPTION 'SEC-08B/C: el guardián volvió a ser SECURITY DEFINER: current_user dejaría de ver el rol externo';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.tg_inventory_guard_cost_write()', 'EXECUTE') THEN
    RAISE EXCEPTION 'SEC-08B/C: authenticated no puede ejecutar el guardián INVOKER: toda escritura de inventario fallaría';
  END IF;

  -- La herencia de variante: DEFINER, acotada al mismo negocio, sin devolver.
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.tg_inventory_inherit_variant_cost()'::regprocedure) THEN
    RAISE EXCEPTION 'SEC-08B/C: la herencia de variante no es SECURITY DEFINER: no podría leer el costo del padre';
  END IF;
  IF pg_get_functiondef('public.tg_inventory_inherit_variant_cost()'::regprocedure) !~ 'p\.business_id = NEW\.business_id' THEN
    RAISE EXCEPTION 'SEC-08B/C: la herencia de la variante no está acotada al mismo negocio';
  END IF;

  FOR v_def IN SELECT unnest(ARRAY['trig_inventory_guard_cost_write','trig_inventory_inherit_variant_cost']) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'public' AND c.relname = 'inventory'
                     AND t.tgname = v_def AND NOT t.tgisinternal) THEN
      RAISE EXCEPTION 'SEC-08B/C: falta el trigger % sobre inventory', v_def;
    END IF;
  END LOOP;

  -- Las fronteras de las fases anteriores siguen en pie.
  IF EXISTS (SELECT 1 FROM information_schema.column_privileges
              WHERE table_schema = 'public' AND privilege_type = 'SELECT'
                AND grantee IN ('anon','authenticated')
                AND ((table_name = 'inventory' AND column_name IN ('cost_price','cost_price_usd'))
                  OR (table_name = 'comprobante_items' AND column_name IN ('costo_unitario','costo_total')))) THEN
    RAISE EXCEPTION 'SEC-08B/C: se reabrieron GRANT de columnas de costo';
  END IF;
  IF pg_get_viewdef('public.v_comprobante_item_costs'::regclass, true) ILIKE '%can_view_cogs%' THEN
    RAISE EXCEPTION 'SEC-08B/C: v_comprobante_item_costs volvió al gate can_view_cogs';
  END IF;
END
$post$;

COMMIT;
