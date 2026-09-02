-- SEC-08A Fase B — semántica de la autoridad tenant-aware y de la frontera de
-- columnas de línea.
--
-- Lo que prueba acá (lo que se prueba mejor en SQL puro):
--   · `current_user_can_in_business` deriva TODO —rol, estado activo, override—
--     del perfil que el actor tiene EN ESE negocio, y nunca de otro;
--   · su paridad con `current_user_can` para el caso normal de un solo perfil,
--     que es el 100 % del parque hoy;
--   · la frontera de columnas de `order_items` / `order_parts`, con su control
--     negativo (se reabre la columna dentro de la transacción, se comprueba que
--     entonces SÍ se lee, y se vuelve a cerrar).
--
-- La matriz de red (comprobantes, relaciones anidadas, reconstrucción exacta)
-- vive en scripts/security/sec08a-phase-b-postgrest.mjs: esas rutas sólo existen
-- en PostgREST.
--
-- Nota de seguridad del propio test: NUNCA se entra a una función SECURITY
-- DEFINER con el rol cambiado dentro de un DO — ese patrón crashea el backend.
-- El cambio de rol se usa SÓLO para tocar tablas.
\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert(p_condition boolean, p_label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_condition IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', p_label; END IF;
  RAISE NOTICE 'PASS: %', p_label;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.act_as(p_user_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_user_id IS NULL THEN PERFORM set_config('request.jwt.claims', '', true);
  ELSE PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_user_id::text, 'role', 'authenticated')::text, true);
  END IF;
END;
$$;

/** Lee una columna de una tabla COMO el rol dado. 'DENIED' si falta privilegio. */
CREATE OR REPLACE FUNCTION pg_temp.read_column(
  p_role text, p_actor uuid, p_table text, p_id uuid, p_column text
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_value text;
BEGIN
  PERFORM set_config('role', p_role, true);
  PERFORM pg_temp.act_as(p_actor);
  BEGIN
    EXECUTE format('SELECT %I::text FROM public.%I WHERE id = $1', p_column, p_table)
      INTO v_value USING p_id;
  EXCEPTION
    WHEN insufficient_privilege THEN
      PERFORM set_config('role', 'none', true);
      RETURN 'DENIED';
  END;
  PERFORM set_config('role', 'none', true);
  RETURN COALESCE(v_value, 'NO_ROWS');
END;
$$;

DO $fixture$
DECLARE
  v_a uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('sec08b.biz_a', v_a::text, true);
  PERFORM set_config('sec08b.biz_b', v_b::text, true);
END
$fixture$;

-- ── Fixture ─────────────────────────────────────────────────────────────────
CREATE TEMP TABLE ids AS
SELECT
  current_setting('sec08b.biz_a')::uuid AS biz_a,
  current_setting('sec08b.biz_b')::uuid AS biz_b,
  gen_random_uuid() AS multi,        -- perfil canónico en A (admin)
  gen_random_uuid() AS multi_spare,  -- segundo perfil, en B (tech)
  gen_random_uuid() AS solo,         -- un solo perfil, en A (manager)
  gen_random_uuid() AS owner_a,
  gen_random_uuid() AS customer,
  gen_random_uuid() AS device,
  gen_random_uuid() AS ord,
  gen_random_uuid() AS item,
  gen_random_uuid() AS part;

SET session_replication_role = replica;

INSERT INTO auth.users(id, email, email_confirmed_at)
SELECT x, 'sec08b-' || x || '@sql.invalid', now()
  FROM (SELECT unnest(ARRAY[multi, multi_spare, solo, owner_a]) AS x FROM ids) s;

INSERT INTO public.businesses(id, name, owner_user_id, subscription_plan, subscription_status)
SELECT biz_a, 'A', owner_a, 'pro', 'active' FROM ids
UNION ALL SELECT biz_b, 'B', owner_a, 'pro', 'active' FROM ids;

-- El MISMO usuario con dos perfiles: admin en A (más reciente) y tech en B.
INSERT INTO public.profiles(id, user_id, business_id, role, is_active, email, updated_at)
SELECT multi, NULL, biz_a, 'admin', true, 'multi@sql.invalid', now() FROM ids
UNION ALL SELECT multi_spare, multi, biz_b, 'tech', true, 'multi@sql.invalid', now() - interval '5 days' FROM ids
UNION ALL SELECT solo, NULL, biz_a, 'manager', true, 'solo@sql.invalid', now() FROM ids
UNION ALL SELECT owner_a, NULL, biz_a, 'owner', true, 'owner@sql.invalid', now() FROM ids;

INSERT INTO public.customers(id, business_id, name, phone) SELECT customer, biz_a, 'C', '1' FROM ids;
INSERT INTO public.devices(id, business_id, customer_id, brand, model, type, issue)
SELECT device, biz_a, customer, 'M', 'M', 'smartphone', 'x' FROM ids;
INSERT INTO public.orders(id, business_id, customer_id, device_id, status)
SELECT ord, biz_a, customer, device, 'repair' FROM ids;
INSERT INTO public.order_parts(id, order_id, business_id, name, internal_cost, sale_price, margin_amount, margin_percentage, quantity, status, cliente_paga_repuesto)
SELECT part, ord, biz_a, 'parte', 111.00, 222.00, 111.00, 100.00, 1, 'used', true FROM ids;

SET session_replication_role = origin;

-- Fuera de `replica` para que el trigger recalcule los importes de la orden.
INSERT INTO public.order_items(id, order_id, business_id, tipo, descripcion, cantidad, precio_unitario, costo_unitario)
SELECT item, ord, biz_a, 'servicio', 'linea', 2, 333.00, 44.00 FROM ids;

DO $trigger_check$
DECLARE v_est numeric; v_cost numeric;
BEGIN
  SELECT estimated_total, total_cost INTO v_est, v_cost
    FROM public.orders WHERE id = (SELECT ord FROM ids);
  PERFORM pg_temp.assert(v_est = 666.00 AND v_cost = 88.00,
    'fixture: recalculate_order_total define estimated_total/total_cost como suma de las líneas');
END
$trigger_check$;

-- ── P1-1 · la capacidad se resuelve EN el negocio ───────────────────────────
DO $tenant$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM ids;

  PERFORM pg_temp.act_as(r.multi);
  PERFORM pg_temp.assert(
    public.current_user_can_in_business(r.biz_a, 'orders_view_financials') IS TRUE,
    'multi es admin en A: SÍ ve importes de A');
  PERFORM pg_temp.assert(
    public.current_user_can_in_business(r.biz_b, 'orders_view_financials') IS FALSE,
    'multi es tech en B: NO ve importes de B (la autoridad de A no cruza)');

  -- Y la autoridad CIEGA, que es la que tenía la Fase A, dice lo contrario:
  -- ésta es exactamente la incoherencia que el lote cierra.
  PERFORM pg_temp.assert(
    public.current_user_can('orders_view_financials') IS TRUE,
    'current_user_can (ciega al tenant) responde por el perfil de A, sin saber de qué negocio se habla');

  -- Overrides, resueltos en el negocio correcto y en los dos sentidos.
  UPDATE public.profiles SET permissions = '{"orders_view_financials":true}'::jsonb WHERE id = r.multi_spare;
  PERFORM pg_temp.assert(
    public.current_user_can_in_business(r.biz_b, 'orders_view_financials') IS TRUE,
    'override true en el perfil de B habilita en B');
  PERFORM pg_temp.assert(
    public.current_user_can_in_business(r.biz_a, 'orders_view_financials') IS TRUE,
    'el override de B no altera la respuesta de A');

  UPDATE public.profiles SET permissions = '{"orders_view_financials":false}'::jsonb WHERE id = r.multi;
  PERFORM pg_temp.assert(
    public.current_user_can_in_business(r.biz_a, 'orders_view_financials') IS FALSE,
    'override false en el perfil de A deshabilita en A');
  UPDATE public.profiles SET permissions = NULL WHERE id IN (r.multi, r.multi_spare);

  -- Perfil inactivo en ese negocio.
  UPDATE public.profiles SET is_active = false WHERE id = r.multi_spare;
  PERFORM pg_temp.assert(
    public.current_user_can_in_business(r.biz_b, 'orders_view_financials') IS FALSE,
    'perfil inactivo en B: fail-closed');
  UPDATE public.profiles SET is_active = true WHERE id = r.multi_spare;

  -- Negocio ajeno / inexistente.
  PERFORM pg_temp.assert(
    public.current_user_can_in_business(gen_random_uuid(), 'orders_view_financials') IS FALSE,
    'negocio inexistente: fail-closed');
  PERFORM pg_temp.assert(
    public.current_user_can_in_business(NULL, 'orders_view_financials') IS FALSE,
    'business_id nulo: fail-closed');

  -- Clave desconocida: false incluso para el owner (mismo orden que current_user_can).
  PERFORM pg_temp.act_as(r.owner_a);
  PERFORM pg_temp.assert(
    public.current_user_can_in_business(r.biz_a, 'clave_que_no_existe') IS FALSE,
    'clave desconocida: false incluso para el owner');
  PERFORM pg_temp.assert(
    public.current_user_can_in_business(r.biz_a, 'orders_view_financials') IS TRUE,
    'el owner del negocio ve los importes de su negocio');
  PERFORM pg_temp.assert(
    public.current_user_can_in_business(r.biz_a, 'personal_finance') IS FALSE,
    'personal_finance sigue siendo false para todos');

  -- Anónimo.
  PERFORM pg_temp.act_as(NULL);
  PERFORM pg_temp.assert(
    public.current_user_can_in_business(r.biz_a, 'orders_view_financials') IS FALSE,
    'sin sesión: fail-closed');
END
$tenant$;

-- Paridad con la autoridad histórica para el caso de UN solo perfil, que es el
-- parque real: el lote no cambia lo que ve nadie con una sola membresía.
DO $parity$
DECLARE r record; k text;
BEGIN
  SELECT * INTO r FROM ids;
  PERFORM pg_temp.act_as(r.solo);
  FOREACH k IN ARRAY ARRAY['orders','orders_create','orders_view_financials','device_access_secret',
                           'inventory','inventory_view_costs','customers','finance','comprobantes',
                           'reports','settings','users','wholesale','subscription','personal_finance'] LOOP
    PERFORM pg_temp.assert(
      public.current_user_can_in_business(r.biz_a, k) IS NOT DISTINCT FROM public.current_user_can(k),
      'paridad con un solo perfil para la capacidad ' || k);
  END LOOP;
END
$parity$;

-- ── P1-3 · frontera de columnas de línea, con control negativo ──────────────
DO $columns$
DECLARE r record; v text;
BEGIN
  SELECT * INTO r FROM ids;

  v := pg_temp.read_column('authenticated', r.multi, 'order_items', r.item, 'precio_unitario');
  PERFORM pg_temp.assert(v = 'DENIED', 'order_items.precio_unitario denegado incluso para un admin');
  v := pg_temp.read_column('authenticated', r.multi, 'order_items', r.item, 'costo_unitario');
  PERFORM pg_temp.assert(v = 'DENIED', 'order_items.costo_unitario denegado');
  v := pg_temp.read_column('authenticated', r.multi, 'order_parts', r.part, 'internal_cost');
  PERFORM pg_temp.assert(v = 'DENIED', 'order_parts.internal_cost denegado');
  v := pg_temp.read_column('authenticated', r.multi, 'order_parts', r.part, 'sale_price');
  PERFORM pg_temp.assert(v = 'DENIED', 'order_parts.sale_price denegado');
  v := pg_temp.read_column('authenticated', r.multi, 'order_parts', r.part, 'margin_amount');
  PERFORM pg_temp.assert(v = 'DENIED', 'order_parts.margin_amount denegado');

  -- Lo operativo sigue vivo: sin esto el técnico no puede trabajar.
  v := pg_temp.read_column('authenticated', r.multi, 'order_items', r.item, 'cantidad');
  PERFORM pg_temp.assert(v = '2', 'order_items.cantidad sigue legible (dato operativo)');
  v := pg_temp.read_column('authenticated', r.multi, 'order_items', r.item, 'descripcion');
  PERFORM pg_temp.assert(v = 'linea', 'order_items.descripcion sigue legible');
  v := pg_temp.read_column('authenticated', r.multi, 'order_parts', r.part, 'name');
  PERFORM pg_temp.assert(v = 'parte', 'order_parts.name sigue legible');
  v := pg_temp.read_column('authenticated', r.multi, 'order_parts', r.part, 'quantity');
  PERFORM pg_temp.assert(v = '1', 'order_parts.quantity sigue legible');

  -- CONTROL NEGATIVO del propio test: si se reabre la columna, el valor SÍ se
  -- lee. Sin esto, un test que sólo ve DENIED no prueba que sepa mirar.
  GRANT SELECT (precio_unitario) ON public.order_items TO authenticated;
  v := pg_temp.read_column('authenticated', r.multi, 'order_items', r.item, 'precio_unitario');
  PERFORM pg_temp.assert(v = '333.00', 'control negativo: con la columna reabierta el precio SÍ se lee');
  REVOKE SELECT (precio_unitario) ON public.order_items FROM authenticated;
  v := pg_temp.read_column('authenticated', r.multi, 'order_items', r.item, 'precio_unitario');
  PERFORM pg_temp.assert(v = 'DENIED', 'control negativo revertido: vuelve a estar cerrada');

  -- Fase A intacta.
  v := pg_temp.read_column('authenticated', r.multi, 'orders', r.ord, 'total_cost');
  PERFORM pg_temp.assert(v = 'DENIED', 'FASE A: orders.total_cost sigue denegado');
  v := pg_temp.read_column('authenticated', r.multi, 'orders', r.ord, 'device_password');
  PERFORM pg_temp.assert(v = 'DENIED', 'FASE A: orders.device_password sigue denegado');
  v := pg_temp.read_column('authenticated', r.multi, 'orders', r.ord, 'status');
  PERFORM pg_temp.assert(v = 'repair', 'FASE A: la lectura operativa de orders sigue viva');
END
$columns$;

-- ── Vistas ──────────────────────────────────────────────────────────────────
DO $views$
BEGIN
  PERFORM pg_temp.assert(
    NOT has_table_privilege('authenticated', 'public.v_finance_order_cogs_gaps', 'SELECT'),
    'v_finance_order_cogs_gaps fuera del alcance del browser');
  PERFORM pg_temp.assert(
    NOT has_table_privilege('authenticated', 'public.v_order_financial_status', 'SELECT'),
    'v_order_financial_status sigue fuera del alcance del browser');
  PERFORM pg_temp.assert(
    pg_get_viewdef('public.v_order_payment_state'::regclass, true) LIKE '%current_user_can_in_business%',
    'v_order_payment_state exige la capacidad: no puede fabricar sin_facturar');
END
$views$;

-- ── Escritura intacta ───────────────────────────────────────────────────────
DO $writes$
BEGIN
  PERFORM pg_temp.assert(
    has_table_privilege('authenticated', 'public.order_items', 'INSERT')
    AND has_table_privilege('authenticated', 'public.order_items', 'UPDATE')
    AND has_table_privilege('authenticated', 'public.order_items', 'DELETE'),
    'la escritura de order_items no se tocó');
  PERFORM pg_temp.assert(
    has_table_privilege('authenticated', 'public.order_parts', 'INSERT')
    AND has_table_privilege('authenticated', 'public.order_parts', 'UPDATE')
    AND has_table_privilege('authenticated', 'public.order_parts', 'DELETE'),
    'la escritura de order_parts no se tocó');
  PERFORM pg_temp.assert(
    has_column_privilege('authenticated', 'public.orders', 'device_password', 'UPDATE'),
    'FASE A: el dual-write legacy de Mobile2A sigue vivo');
  PERFORM pg_temp.assert(
    NOT has_function_privilege('anon', 'public.current_user_can_in_business(uuid,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.get_order_line_amounts(uuid,uuid[])', 'EXECUTE'),
    'anon no alcanza las rutas canónicas nuevas');
END
$writes$;

DO $done$ BEGIN RAISE NOTICE 'SEC-08A Fase B SQL suite: todas las aserciones pasaron'; END $done$;

ROLLBACK;
