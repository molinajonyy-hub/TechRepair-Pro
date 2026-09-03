-- SEC-08A — Orders data visibility.
--
-- Qué prueba: que los campos financieros de una orden (O1) y el secreto del
-- equipo (O2) NO son alcanzables por un actor sin la capacidad correspondiente,
-- y que sí lo son por la ruta canónica cuando la capacidad está.
--
-- Las aserciones negativas comprueban que el VALOR no llega, no que la UI no lo
-- dibuje. Todo el fixture y cualquier mutación temporal se revierten.
--
-- Nota de seguridad del propio test: NUNCA se entra a una función SECURITY
-- DEFINER con el rol cambiado dentro de un DO — ese patrón crashea el backend
-- (postgres 17.6.1.104, signal 11). El cambio de rol se usa SÓLO para tocar
-- tablas; las funciones se invocan como owner con `request.jwt.claims` puestos,
-- que es como lo hace tests/sql/prebeta_order_amounts_identity.test.sql.
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

/**
 * Lee una columna de `public.orders` COMO el rol dado. Devuelve el valor como
 * texto, o la etiqueta 'DENIED' si PostgreSQL rechaza por privilegio, o
 * 'NO_ROWS' si la RLS no deja ver la fila.
 *
 * Es una lectura de TABLA, no una llamada a función: seguro dentro de un DO.
 */
CREATE OR REPLACE FUNCTION pg_temp.read_order_column(
  p_role text, p_actor uuid, p_order uuid, p_column text
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_value text;
BEGIN
  PERFORM set_config('role', p_role, true);
  PERFORM pg_temp.act_as(p_actor);
  BEGIN
    EXECUTE format('SELECT %I::text FROM public.orders WHERE id = $1', p_column)
      INTO v_value USING p_order;
  EXCEPTION
    WHEN insufficient_privilege THEN
      PERFORM set_config('role', 'none', true);
      RETURN 'DENIED';
  END;
  PERFORM set_config('role', 'none', true);
  RETURN COALESCE(v_value, 'NO_ROWS');
END;
$$;

DO $suite$
DECLARE
  v_a            uuid := gen_random_uuid();
  v_b            uuid := gen_random_uuid();
  v_owner        uuid := gen_random_uuid();
  v_admin        uuid := gen_random_uuid();
  v_manager      uuid := gen_random_uuid();
  v_tech         uuid := gen_random_uuid();
  v_sales        uuid := gen_random_uuid();
  v_cashier      uuid := gen_random_uuid();
  v_viewer       uuid := gen_random_uuid();
  v_inactive     uuid := gen_random_uuid();
  v_owner_b      uuid := gen_random_uuid();
  v_customer     uuid := gen_random_uuid();
  v_order        uuid := gen_random_uuid();
  v_secret       text := 'pin:'||substr(replace(gen_random_uuid()::text,'-',''),1,6);
  v_column       text;
  v_response     jsonb;
  v_read         text;
  v_revealed     text;
  v_denied       text[] := ARRAY['estimated_total','estimated_total_currency','labor_cost',
                                 'total_cost','amount_paid','paid_at','device_password'];
  v_allowed      text[] := ARRAY['id','business_id','customer_id','device_id','technician_id',
                                 'assigned_profile_id','created_by','comprobante_id','status',
                                 'priority','notes','access_mode','created_at','updated_at',
                                 'completed_at'];
BEGIN
  -- ── Fixture sintético ─────────────────────────────────────────────────────
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
    (v_owner,'owner@sec08a.invalid',now()),(v_admin,'admin@sec08a.invalid',now()),
    (v_manager,'manager@sec08a.invalid',now()),(v_tech,'tech@sec08a.invalid',now()),
    (v_sales,'sales@sec08a.invalid',now()),(v_cashier,'cashier@sec08a.invalid',now()),
    (v_viewer,'viewer@sec08a.invalid',now()),(v_inactive,'inactive@sec08a.invalid',now()),
    (v_owner_b,'ownerb@sec08a.invalid',now());
  INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status) VALUES
    (v_a,'SEC08A tenant A',v_owner,'full','active'),
    (v_b,'SEC08A tenant B',v_owner_b,'full','active');
  INSERT INTO public.profiles(id,user_id,business_id,role,is_active,email) VALUES
    (v_owner,v_owner,v_a,'owner',true,'owner@sec08a.invalid'),
    (v_admin,v_admin,v_a,'admin',true,'admin@sec08a.invalid'),
    (v_manager,v_manager,v_a,'manager',true,'manager@sec08a.invalid'),
    (v_tech,v_tech,v_a,'tech',true,'tech@sec08a.invalid'),
    (v_sales,v_sales,v_a,'sales',true,'sales@sec08a.invalid'),
    (v_cashier,v_cashier,v_a,'cashier',true,'cashier@sec08a.invalid'),
    (v_viewer,v_viewer,v_a,'viewer',true,'viewer@sec08a.invalid'),
    (v_inactive,v_inactive,v_a,'admin',false,'inactive@sec08a.invalid'),
    (v_owner_b,v_owner_b,v_b,'owner',true,'ownerb@sec08a.invalid');
  INSERT INTO public.customers(id,business_id,name,phone) VALUES
    (v_customer,v_a,'SEC08A customer','1100000000');
  INSERT INTO public.orders(id,business_id,customer_id,status,priority,estimated_total,
                            labor_cost,total_cost,amount_paid,paid_at,device_password,
                            access_mode,created_by)
    VALUES(v_order,v_a,v_customer,'repair','medium',123456,7777,99999,5555,now(),
           v_secret,'pin',v_owner);
  SET LOCAL session_replication_role = origin;

  -- ── A. Contrato de columnas (catálogo) ────────────────────────────────────
  FOREACH v_column IN ARRAY v_denied LOOP
    PERFORM pg_temp.assert(
      NOT has_column_privilege('authenticated','public.orders',v_column,'SELECT'),
      format('authenticated no puede seleccionar orders.%s', v_column));
    PERFORM pg_temp.assert(
      NOT has_column_privilege('anon','public.orders',v_column,'SELECT'),
      format('anon no puede seleccionar orders.%s', v_column));
  END LOOP;
  FOREACH v_column IN ARRAY v_allowed LOOP
    PERFORM pg_temp.assert(
      has_column_privilege('authenticated','public.orders',v_column,'SELECT'),
      format('authenticated conserva la columna operativa orders.%s', v_column));
  END LOOP;
  PERFORM pg_temp.assert(NOT has_table_privilege('anon','public.orders','SELECT'),
    'anon no conserva SELECT de tabla sobre orders');
  -- El shadow legacy de Mobile2A sigue siendo ESCRIBIBLE: este lote cierra la
  -- lectura, no el dual-write.
  PERFORM pg_temp.assert(
    has_column_privilege('authenticated','public.orders','device_password','UPDATE'),
    'el dual-write legacy de Mobile2A sobre device_password sigue vivo');

  -- ── B. baseline financial leak control ────────────────────────────────────
  -- Control negativo del propio test: si la columna se reabriera, el valor SÍ
  -- llegaría. Sin esto, un test que sólo ve 'DENIED' no prueba que sepa mirar.
  GRANT SELECT (total_cost) ON public.orders TO authenticated;
  v_read := pg_temp.read_order_column('authenticated', v_tech, v_order, 'total_cost');
  PERFORM pg_temp.assert(v_read = '99999.00',
    format('baseline financial leak control: reabierta la columna, el valor llega (%s)', v_read));
  REVOKE SELECT (total_cost) ON public.orders FROM authenticated;
  v_read := pg_temp.read_order_column('authenticated', v_tech, v_order, 'total_cost');
  PERFORM pg_temp.assert(v_read = 'DENIED',
    'baseline financial leak control: cerrada de nuevo, el valor no llega');

  -- ── C. baseline device-secret leak control ────────────────────────────────
  GRANT SELECT (device_password) ON public.orders TO authenticated;
  v_read := pg_temp.read_order_column('authenticated', v_sales, v_order, 'device_password');
  PERFORM pg_temp.assert(v_read = v_secret,
    'baseline device-secret leak control: reabierta la columna, el secreto llega');
  REVOKE SELECT (device_password) ON public.orders FROM authenticated;
  v_read := pg_temp.read_order_column('authenticated', v_sales, v_order, 'device_password');
  PERFORM pg_temp.assert(v_read = 'DENIED',
    'baseline device-secret leak control: cerrada de nuevo, el secreto no llega');

  -- ── D. safe operational positive ──────────────────────────────────────────
  PERFORM pg_temp.assert(
    pg_temp.read_order_column('authenticated', v_tech, v_order, 'status') = 'repair',
    'safe operational positive: un tech sigue viendo el estado de la orden');
  PERFORM pg_temp.assert(
    pg_temp.read_order_column('authenticated', v_viewer, v_order, 'access_mode') = 'pin',
    'safe operational positive: un viewer sigue viendo el MODO de acceso (no el secreto)');

  -- ── E. financial unauthorized negative (el valor nunca llega) ─────────────
  FOREACH v_column IN ARRAY ARRAY['total_cost','estimated_total','labor_cost','amount_paid','paid_at','estimated_total_currency'] LOOP
    PERFORM pg_temp.assert(
      pg_temp.read_order_column('authenticated', v_tech, v_order, v_column) = 'DENIED',
      format('financial unauthorized: tech no obtiene orders.%s', v_column));
    PERFORM pg_temp.assert(
      pg_temp.read_order_column('authenticated', v_viewer, v_order, v_column) = 'DENIED',
      format('financial unauthorized: viewer no obtiene orders.%s', v_column));
  END LOOP;
  -- Un rol AUTORIZADO tampoco lee la tabla cruda: la autoridad es la ruta, no
  -- el privilegio de columna.
  PERFORM pg_temp.assert(
    pg_temp.read_order_column('authenticated', v_owner, v_order, 'total_cost') = 'DENIED',
    'la tabla cruda deja de ser un bypass incluso para el owner');

  -- ── F. secret unauthorized negative ───────────────────────────────────────
  PERFORM pg_temp.assert(
    pg_temp.read_order_column('authenticated', v_sales, v_order, 'device_password') = 'DENIED',
    'secret unauthorized: sales no obtiene orders.device_password');
  PERFORM pg_temp.assert(
    pg_temp.read_order_column('authenticated', v_cashier, v_order, 'device_password') = 'DENIED',
    'secret unauthorized: cashier no obtiene orders.device_password');
  PERFORM pg_temp.assert(
    pg_temp.read_order_column('authenticated', v_viewer, v_order, 'device_password') = 'DENIED',
    'secret unauthorized: viewer no obtiene orders.device_password');

  -- ── G. Matriz de capacidades (sin cambiar de rol) ─────────────────────────
  PERFORM pg_temp.act_as(v_owner);
  PERFORM pg_temp.assert(public.current_user_can('orders_view_financials'), 'matriz: owner ve importes');
  PERFORM pg_temp.act_as(v_admin);
  PERFORM pg_temp.assert(public.current_user_can('orders_view_financials'), 'matriz: admin ve importes');
  PERFORM pg_temp.act_as(v_manager);
  PERFORM pg_temp.assert(public.current_user_can('orders_view_financials'), 'matriz: manager ve importes');
  PERFORM pg_temp.act_as(v_sales);
  PERFORM pg_temp.assert(public.current_user_can('orders_view_financials'), 'matriz: sales ve importes');
  PERFORM pg_temp.act_as(v_cashier);
  PERFORM pg_temp.assert(public.current_user_can('orders_view_financials'), 'matriz: cashier ve importes');
  PERFORM pg_temp.act_as(v_tech);
  PERFORM pg_temp.assert(NOT public.current_user_can('orders_view_financials'), 'matriz: tech NO ve importes');
  PERFORM pg_temp.assert(public.current_user_can('device_access_secret'), 'matriz: tech SÍ ve el secreto');
  PERFORM pg_temp.act_as(v_viewer);
  PERFORM pg_temp.assert(NOT public.current_user_can('orders_view_financials'), 'matriz: viewer NO ve importes');
  PERFORM pg_temp.assert(NOT public.current_user_can('device_access_secret'), 'matriz: viewer NO ve el secreto');
  PERFORM pg_temp.act_as(v_sales);
  PERFORM pg_temp.assert(NOT public.current_user_can('device_access_secret'), 'matriz: sales NO ve el secreto');
  PERFORM pg_temp.act_as(v_cashier);
  PERFORM pg_temp.assert(NOT public.current_user_can('device_access_secret'), 'matriz: cashier NO ve el secreto');
  PERFORM pg_temp.act_as(v_inactive);
  PERFORM pg_temp.assert(NOT public.current_user_can('orders_view_financials'), 'inactive: sin capacidades');

  -- ── H. financial authorized positive (ruta canónica) ──────────────────────
  PERFORM pg_temp.act_as(v_owner);
  v_response := public.get_order_financial_amounts(v_a, ARRAY[v_order]);
  PERFORM pg_temp.assert((v_response->>'authorized')::boolean,
    'financial authorized: el owner recibe authorized=true');
  PERFORM pg_temp.assert((v_response->'rows'->0->>'total_cost')::numeric = 99999,
    'financial authorized: total_cost llega por la ruta canónica');
  PERFORM pg_temp.assert((v_response->'rows'->0->>'estimated_total')::numeric = 123456,
    'financial authorized: estimated_total llega por la ruta canónica');
  PERFORM pg_temp.assert((v_response->'rows'->0->>'labor_cost')::numeric = 7777,
    'financial authorized: labor_cost llega por la ruta canónica');
  PERFORM pg_temp.assert((v_response->'rows'->0->>'amount_paid')::numeric = 5555,
    'financial authorized: amount_paid llega por la ruta canónica');
  PERFORM pg_temp.assert(v_response->'rows'->0->>'estimated_total_currency' = 'ARS',
    'financial authorized: la moneda del presupuesto llega por la ruta canónica');
  PERFORM pg_temp.assert(v_response->'rows'->0 ? 'saldo_pendiente',
    'financial authorized: los derivados canónicos siguen presentes');

  -- ── I. financial unauthorized por la ruta canónica ────────────────────────
  PERFORM pg_temp.act_as(v_tech);
  v_response := public.get_order_financial_amounts(v_a, ARRAY[v_order]);
  PERFORM pg_temp.assert((v_response->>'ok')::boolean, 'tech: la ruta responde ok');
  PERFORM pg_temp.assert(NOT (v_response->>'authorized')::boolean,
    'financial unauthorized: tech recibe authorized=false');
  PERFORM pg_temp.assert(jsonb_array_length(v_response->'rows') = 0,
    'financial unauthorized: cero filas; ningún importe sale del servidor');
  PERFORM pg_temp.assert(v_response::text NOT LIKE '%99999%',
    'financial unauthorized: el VALOR no aparece en ninguna parte de la respuesta');

  -- ── J. override behavior (los dos sentidos) ───────────────────────────────
  UPDATE public.profiles SET permissions = '{"orders_view_financials": true}'::jsonb WHERE id = v_tech;
  PERFORM pg_temp.act_as(v_tech);
  PERFORM pg_temp.assert(public.current_user_can('orders_view_financials'),
    'override: default false + override true habilita al tech');
  v_response := public.get_order_financial_amounts(v_a, ARRAY[v_order]);
  PERFORM pg_temp.assert((v_response->>'authorized')::boolean,
    'override: el tech habilitado recibe importes por la ruta canónica');
  PERFORM pg_temp.assert(
    pg_temp.read_order_column('authenticated', v_tech, v_order, 'total_cost') = 'DENIED',
    'override: ni siquiera habilitado puede leer la tabla cruda');

  UPDATE public.profiles SET permissions = '{"orders_view_financials": false}'::jsonb WHERE id = v_manager;
  PERFORM pg_temp.act_as(v_manager);
  PERFORM pg_temp.assert(NOT public.current_user_can('orders_view_financials'),
    'override: default true + override false deshabilita al manager');
  v_response := public.get_order_financial_amounts(v_a, ARRAY[v_order]);
  PERFORM pg_temp.assert(NOT (v_response->>'authorized')::boolean,
    'override: el manager deshabilitado ya no recibe importes');
  PERFORM pg_temp.assert(v_response::text NOT LIKE '%99999%',
    'override: el valor tampoco viaja para el manager deshabilitado');

  UPDATE public.profiles SET permissions = NULL WHERE id IN (v_tech, v_manager);

  -- ── K. secreto del equipo por la ruta canónica ────────────────────────────
  PERFORM pg_temp.act_as(v_admin);
  PERFORM public.set_order_device_access_secret(v_order, 'pin', '4417');
  PERFORM pg_temp.act_as(v_tech);
  v_revealed := public.reveal_order_device_access(v_order);
  PERFORM pg_temp.assert(v_revealed = '4417',
    'secret authorized: el tech revela el secreto por la ruta canónica on-demand');

  PERFORM pg_temp.act_as(v_sales);
  BEGIN
    v_revealed := public.reveal_order_device_access(v_order);
    PERFORM pg_temp.assert(false, 'secret unauthorized: sales NO debe poder revelar');
  EXCEPTION WHEN insufficient_privilege THEN
    PERFORM pg_temp.assert(true, 'secret unauthorized: sales recibe 42501 en la ruta canónica');
  END;

  PERFORM pg_temp.act_as(v_viewer);
  BEGIN
    v_revealed := public.reveal_order_device_access(v_order);
    PERFORM pg_temp.assert(false, 'secret unauthorized: viewer NO debe poder revelar');
  EXCEPTION WHEN insufficient_privilege THEN
    PERFORM pg_temp.assert(true, 'secret unauthorized: viewer recibe 42501 en la ruta canónica');
  END;

  -- ── L. foreign tenant ─────────────────────────────────────────────────────
  PERFORM pg_temp.assert(
    pg_temp.read_order_column('authenticated', v_owner_b, v_order, 'status') = 'NO_ROWS',
    'foreign tenant: el owner de B no ve ni el estado de una orden de A');
  PERFORM pg_temp.act_as(v_owner_b);
  v_response := public.get_order_financial_amounts(v_a, ARRAY[v_order]);
  PERFORM pg_temp.assert(v_response->>'error_code' = 'FORBIDDEN',
    'foreign tenant: la ruta de importes lo rechaza');
  BEGIN
    v_revealed := public.reveal_order_device_access(v_order);
    PERFORM pg_temp.assert(v_revealed IS NULL,
      'foreign tenant: la ruta del secreto no devuelve nada de otro tenant');
  EXCEPTION WHEN insufficient_privilege THEN
    PERFORM pg_temp.assert(true, 'foreign tenant: la ruta del secreto lo rechaza');
  END;

  -- ── M. inactive ───────────────────────────────────────────────────────────
  PERFORM pg_temp.assert(
    pg_temp.read_order_column('authenticated', v_inactive, v_order, 'status') = 'NO_ROWS',
    'inactive: un perfil desactivado no ve la orden');

  -- ── N. anon ───────────────────────────────────────────────────────────────
  PERFORM pg_temp.assert(
    pg_temp.read_order_column('anon', NULL, v_order, 'status') = 'DENIED',
    'anon: sin SELECT sobre orders, ni siquiera operativo');
  PERFORM pg_temp.assert(
    NOT has_function_privilege('anon','public.get_order_financial_amounts(uuid,uuid[])','EXECUTE'),
    'anon: sin EXECUTE sobre la ruta de importes');
  PERFORM pg_temp.assert(
    NOT has_function_privilege('anon','public.reveal_order_device_access(uuid)','EXECUTE'),
    'anon: sin EXECUTE sobre la ruta del secreto');

  RAISE NOTICE 'SEC-08A SQL suite: todas las aserciones pasaron';
END
$suite$;

ROLLBACK;
