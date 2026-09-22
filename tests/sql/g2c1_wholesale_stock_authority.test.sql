-- ============================================================================
-- G2-C.1 · Autoridad del pedido mayorista (Opcion A).
--
--   PEDIDO MAYORISTA = ESTADO COMERCIAL.
--   COMPROBANTE      = MOVIMIENTO ECONOMICO Y DE STOCK.
--
-- Contrato que prueba esta matriz:
--   · NINGUN estado del pedido mueve inventario ni crea inventory_movements
--     (approved, rejected, cancelled, invoiced, delivered, pending_*).
--   · El unico escritor administrativo de status/admin_notes es la RPC
--     update_wholesale_order_status_atomic; el UPDATE directo esta cerrado.
--   · El cliente del portal solo puede crear pedidos en `pending_whatsapp` e
--     items con marcadores de stock neutros y quantity > 0.
--   · La salida de stock de un pedido mayorista ocurre al convertirlo en
--     comprobante por el checkout canonico, y una sola vez.
--
-- Ya NO se prueba "approved descuenta / cancel devuelve": bajo la Opcion A eso
-- seria incorrecto.
--
-- Corre dentro de BEGIN ... ROLLBACK: no deja rastro.
-- RUN: docker cp ... && psql -X -v ON_ERROR_STOP=1 -f
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;

CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label;
  ELSE RAISE NOTICE 'PASS: %', label; END IF;
END; $$;

-- ── Identificadores del fixture ─────────────────────────────────────────────
CREATE TEMP TABLE g2c1_ids(k text PRIMARY KEY, v uuid NOT NULL) ON COMMIT DROP;
INSERT INTO g2c1_ids VALUES
  ('BIZ_A',   '00000000-0000-0000-0000-00000000c301'),  -- plan full: tiene mayorista
  ('BIZ_B',   '00000000-0000-0000-0000-00000000c302'),  -- otro tenant, plan full
  ('BIZ_P',   '00000000-0000-0000-0000-00000000c303'),  -- plan pro: SIN mayorista
  ('OWN_A',   '00000000-0000-0000-0000-00000000c309'),
  ('OWN_B',   '00000000-0000-0000-0000-00000000c30a'),
  ('OWN_P',   '00000000-0000-0000-0000-00000000c30b'),
  ('ADMIN_A', '00000000-0000-0000-0000-00000000c311'),  -- admin: wholesale por default
  ('SALES_A', '00000000-0000-0000-0000-00000000c312'),  -- sales: wholesale por default
  ('TECH_A',  '00000000-0000-0000-0000-00000000c313'),  -- tech: SIN wholesale
  ('SALESX_A','00000000-0000-0000-0000-00000000c314'),  -- sales con override wholesale=false
  ('WCU_A',   '00000000-0000-0000-0000-00000000c321'),  -- auth user del cliente del portal de A
  ('WCU_B',   '00000000-0000-0000-0000-00000000c322'),  -- auth user del cliente del portal de B
  ('WC_A',    '00000000-0000-0000-0000-00000000c3a1'),  -- wholesale_customers de A
  ('WC_B',    '00000000-0000-0000-0000-00000000c3a2'),  -- wholesale_customers de B
  ('CUST_A',  '00000000-0000-0000-0000-00000000c3c1'),  -- customers (comprobante) de A
  ('CAJA_A',  '00000000-0000-0000-0000-00000000c361'),
  ('INV_A2',  '00000000-0000-0000-0000-00000000c3d1'),  -- A, stock 2 (sobreventa)
  ('INV_A10', '00000000-0000-0000-0000-00000000c3d2'),  -- A, stock 10
  ('INV_B7',  '00000000-0000-0000-0000-00000000c3df');  -- B, stock 7

CREATE OR REPLACE FUNCTION pg_temp.id(p_k text) RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT v FROM g2c1_ids WHERE k = p_k $$;

-- Ejecuta SQL como `authenticated` con la identidad dada. 'OK' o SQLSTATE.
CREATE OR REPLACE FUNCTION pg_temp.como(p_uid uuid, p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_state text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_uid::text, ''), true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    EXECUTE p_sql;
    v_state := 'OK';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE || ' ' || SQLERRM;
  END;
  RESET ROLE;
  RETURN v_state;
END; $$;

-- Ejecuta SQL como `anon`. 'OK' o SQLSTATE.
CREATE OR REPLACE FUNCTION pg_temp.como_anon(p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_state text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  EXECUTE 'SET LOCAL ROLE anon';
  BEGIN
    EXECUTE p_sql;
    v_state := 'OK';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE || ' ' || SQLERRM;
  END;
  RESET ROLE;
  RETURN v_state;
END; $$;

-- Llama a la RPC canonica como `authenticated`. Devuelve su jsonb o
-- {error_state, error}.
CREATE OR REPLACE FUNCTION pg_temp.rpc(p_uid uuid, p_biz uuid, p_order uuid,
                                       p_status text, p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_uid::text, ''), true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    r := public.update_wholesale_order_status_atomic(p_biz, p_order, p_status, p_notes);
  EXCEPTION WHEN OTHERS THEN
    r := jsonb_build_object('error_state', SQLSTATE, 'error', SQLERRM);
  END;
  RESET ROLE;
  RETURN r;
END; $$;

-- El cliente del portal crea un pedido EXACTAMENTE como portalService.createOrder:
-- mismas columnas, sin status, sin marcadores. Falla si algo lo rechaza.
CREATE OR REPLACE FUNCTION pg_temp.cliente_crea_pedido(
  p_uid uuid, p_biz uuid, p_cust uuid, p_num text, p_items jsonb)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO public.wholesale_orders(business_id, customer_id, order_number, subtotal, total, notes)
    VALUES (p_biz, p_cust, p_num, 0, 0, 'G2-C.1')
    RETURNING id INTO v_id;
  INSERT INTO public.wholesale_order_items(order_id, business_id, inventory_item_id, product_name,
                                           product_code, quantity, unit_price, subtotal)
    SELECT v_id, p_biz, x.inventory_item_id, x.product_name, NULL, x.quantity, x.unit_price,
           x.quantity * x.unit_price
      FROM jsonb_to_recordset(p_items) AS x(inventory_item_id uuid, product_name text,
                                            quantity int, unit_price numeric);
  RESET ROLE;
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION pg_temp.fila(p_order uuid) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object('status', o.status, 'admin_notes', o.admin_notes,
                            'updated_at', o.updated_at, 'ctid', o.ctid::text)
    FROM public.wholesale_orders o WHERE o.id = p_order
$$;

-- Ningun stock del fixture se movio y ningun movimiento de inventario existe.
CREATE OR REPLACE FUNCTION pg_temp.assert_stock_intacto(p_label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.assert(NOT EXISTS (
      SELECT 1 FROM public.inventory i JOIN g2c1_stock0 s ON s.id = i.id
       WHERE i.stock_quantity IS DISTINCT FROM s.stock_quantity
          OR i.stock          IS DISTINCT FROM s.stock),
    p_label || ' · stock_quantity y stock identicos al inicial');
  PERFORM pg_temp.assert(NOT EXISTS (
      SELECT 1 FROM public.inventory_movements m
       WHERE m.business_id IN (pg_temp.id('BIZ_A'), pg_temp.id('BIZ_B'))),
    p_label || ' · 0 inventory_movements');
  PERFORM pg_temp.assert(NOT EXISTS (
      SELECT 1 FROM public.wholesale_order_items w
       WHERE w.stock_processed IS TRUE OR w.stock_processed_at IS NOT NULL
          OR w.stock_movement_id IS NOT NULL),
    p_label || ' · marcadores de stock neutros');
END; $$;

-- ── Semilla ─────────────────────────────────────────────────────────────────
SET LOCAL session_replication_role = 'replica';
INSERT INTO auth.users(id) SELECT v FROM g2c1_ids
 WHERE k IN ('OWN_A','OWN_B','OWN_P','ADMIN_A','SALES_A','TECH_A','SALESX_A','WCU_A','WCU_B');
INSERT INTO public.businesses(id, name, owner_user_id, subscription_plan, subscription_status) VALUES
  (pg_temp.id('BIZ_A'), 'G2C1 A', pg_temp.id('OWN_A'), 'full', 'active'),
  (pg_temp.id('BIZ_B'), 'G2C1 B', pg_temp.id('OWN_B'), 'full', 'active'),
  (pg_temp.id('BIZ_P'), 'G2C1 P', pg_temp.id('OWN_P'), 'pro',  'active');
INSERT INTO public.profiles(id, business_id, role, is_active, permissions) VALUES
  (pg_temp.id('OWN_A'),    pg_temp.id('BIZ_A'), 'owner', true, NULL),
  (pg_temp.id('OWN_B'),    pg_temp.id('BIZ_B'), 'owner', true, NULL),
  (pg_temp.id('OWN_P'),    pg_temp.id('BIZ_P'), 'owner', true, NULL),
  (pg_temp.id('ADMIN_A'),  pg_temp.id('BIZ_A'), 'admin', true, NULL),
  (pg_temp.id('SALES_A'),  pg_temp.id('BIZ_A'), 'sales', true, NULL),
  (pg_temp.id('TECH_A'),   pg_temp.id('BIZ_A'), 'tech',  true, NULL),
  (pg_temp.id('SALESX_A'), pg_temp.id('BIZ_A'), 'sales', true, '{"wholesale": false}'::jsonb);
-- Los clientes del portal NO tienen perfil: son externos al negocio.
INSERT INTO public.wholesale_customers(id, business_id, auth_user_id, name, email, approved) VALUES
  (pg_temp.id('WC_A'), pg_temp.id('BIZ_A'), pg_temp.id('WCU_A'), 'Mayorista A', 'wca@g2c1.test', true),
  (pg_temp.id('WC_B'), pg_temp.id('BIZ_B'), pg_temp.id('WCU_B'), 'Mayorista B', 'wcb@g2c1.test', true);
INSERT INTO public.customers(id, business_id, name, phone, customer_type)
  VALUES (pg_temp.id('CUST_A'), pg_temp.id('BIZ_A'), 'Mayorista A (comprobante)', '+540311', 'mayorista');
INSERT INTO public.cajas(id, business_id, opened_by, status)
  VALUES (pg_temp.id('CAJA_A'), pg_temp.id('BIZ_A'), pg_temp.id('OWN_A'), 'abierta');
INSERT INTO public.inventory(id, business_id, name, code, category, stock_quantity, stock, cost_price,
                             sale_price, base_price, base_currency, auto_update_price,
                             exchange_rate_used, is_active, visible_in_wholesale)
VALUES
  (pg_temp.id('INV_A2'),  pg_temp.id('BIZ_A'), 'G2C1 A2',  'G2C1-A2',  'Rep',  2,  2, 600, 1000, 1000, 'ARS', false, 1, true, true),
  (pg_temp.id('INV_A10'), pg_temp.id('BIZ_A'), 'G2C1 A10', 'G2C1-A10', 'Rep', 10, 10, 600, 1000, 1000, 'ARS', false, 1, true, true),
  (pg_temp.id('INV_B7'),  pg_temp.id('BIZ_B'), 'G2C1 B7',  'G2C1-B7',  'Rep',  7,  7, 600, 1000, 1000, 'ARS', false, 1, true, true);
SET LOCAL session_replication_role = 'origin';

CREATE TEMP TABLE g2c1_stock0 ON COMMIT DROP AS
  SELECT id, stock_quantity, stock FROM public.inventory
   WHERE business_id IN (pg_temp.id('BIZ_A'), pg_temp.id('BIZ_B'));

-- ============================================================================
-- 0 · CATALOGO · la RPC y el cierre del bypass existen como se declaro
-- ============================================================================
DO $$
DECLARE v_fn oid := to_regprocedure('public.update_wholesale_order_status_atomic(uuid,uuid,text,text)');
        v_src text;
BEGIN
  PERFORM pg_temp.assert(v_fn IS NOT NULL, '0 · la RPC existe por firma exacta (uuid,uuid,text,text)');
  PERFORM pg_temp.assert((SELECT prosecdef FROM pg_proc WHERE oid = v_fn), '0 · la RPC es SECURITY DEFINER');
  PERFORM pg_temp.assert((SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = v_fn) = 'postgres',
    '0 · owner postgres');
  PERFORM pg_temp.assert((SELECT proconfig FROM pg_proc WHERE oid = v_fn) = ARRAY['search_path=pg_catalog, pg_temp'],
    '0 · search_path = pg_catalog, pg_temp');
  PERFORM pg_temp.assert(NOT has_function_privilege('anon', v_fn, 'EXECUTE'), '0 · anon sin EXECUTE');
  PERFORM pg_temp.assert(NOT has_function_privilege('public', v_fn, 'EXECUTE'), '0 · PUBLIC sin EXECUTE');
  PERFORM pg_temp.assert(NOT has_function_privilege('service_role', v_fn, 'EXECUTE'), '0 · service_role sin EXECUTE');
  PERFORM pg_temp.assert(has_function_privilege('authenticated', v_fn, 'EXECUTE'), '0 · authenticated con EXECUTE');

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_fn;
  PERFORM pg_temp.assert(v_src ~* 'FOR\s+UPDATE', '0 · la RPC bloquea el pedido (FOR UPDATE)');
  PERFORM pg_temp.assert(v_src LIKE '%current_user_can_in_business(p_business_id, ''wholesale'')%',
    '0 · autoridad tenant-bound con capability wholesale');
  PERFORM pg_temp.assert(v_src !~* '(inventory|stock_processed|stock_movement_id|stock_quantity)',
    '0 · la RPC NO toca inventario ni marcadores (no es un segundo writer de stock)');

  PERFORM pg_temp.assert(NOT has_table_privilege('authenticated', 'public.wholesale_orders', 'UPDATE'),
    '0 · authenticated sin UPDATE de tabla sobre wholesale_orders');
  PERFORM pg_temp.assert(NOT has_column_privilege('authenticated', 'public.wholesale_orders', 'status', 'UPDATE'),
    '0 · authenticated sin UPDATE de wholesale_orders.status');
  PERFORM pg_temp.assert(NOT has_column_privilege('authenticated', 'public.wholesale_orders', 'admin_notes', 'UPDATE'),
    '0 · authenticated sin UPDATE de wholesale_orders.admin_notes');
  PERFORM pg_temp.assert(NOT has_table_privilege('authenticated', 'public.wholesale_order_items', 'UPDATE'),
    '0 · authenticated sin UPDATE sobre wholesale_order_items');
  PERFORM pg_temp.assert(NOT has_column_privilege('authenticated', 'public.wholesale_orders', 'status', 'INSERT'),
    '0 · authenticated no puede nombrar status en un INSERT');
  PERFORM pg_temp.assert(NOT has_column_privilege('authenticated', 'public.wholesale_order_items', 'stock_processed', 'INSERT'),
    '0 · authenticated no puede nombrar stock_processed en un INSERT');
  PERFORM pg_temp.assert(
    (SELECT column_default FROM information_schema.columns
      WHERE table_schema='public' AND table_name='wholesale_orders' AND column_name='status')
      = '''pending_whatsapp''::text',
    '0 · el estado inicial canonico (DEFAULT) es pending_whatsapp');
  PERFORM pg_temp.assert(NOT EXISTS (
      SELECT 1 FROM pg_policy
       WHERE polrelid IN ('public.wholesale_orders'::regclass, 'public.wholesale_order_items'::regclass)
         AND polcmd IN ('w','*')),
    '0 · no queda ninguna policy de UPDATE sobre las tablas mayoristas');
END $$;

-- ============================================================================
-- 1 y 8 · el cliente crea un pedido normal  ·  pending_whatsapp, quantity > 0
-- ============================================================================
DO $$
DECLARE v_order uuid;
BEGIN
  v_order := pg_temp.cliente_crea_pedido(pg_temp.id('WCU_A'), pg_temp.id('BIZ_A'), pg_temp.id('WC_A'),
    'G2C1-1', jsonb_build_array(
      jsonb_build_object('inventory_item_id', pg_temp.id('INV_A2'),  'product_name', 'A2',  'quantity', 5, 'unit_price', 1000),
      jsonb_build_object('inventory_item_id', pg_temp.id('INV_A10'), 'product_name', 'A10', 'quantity', 4, 'unit_price', 1000),
      jsonb_build_object('inventory_item_id', NULL,                  'product_name', 'Sin inventario', 'quantity', 1, 'unit_price', 500)));
  PERFORM set_config('g2c1.o1', v_order::text, true);

  PERFORM pg_temp.assert((SELECT status FROM wholesale_orders WHERE id = v_order) = 'pending_whatsapp',
    '1 · el pedido del cliente nace en pending_whatsapp');
  PERFORM pg_temp.assert((SELECT admin_notes FROM wholesale_orders WHERE id = v_order) IS NULL,
    '1 · sin notas administrativas');
  PERFORM pg_temp.assert((SELECT count(*) FROM wholesale_order_items WHERE order_id = v_order) = 3,
    '8 · los 3 items con quantity > 0 se insertan (incluido uno sin inventory_item_id)');
  PERFORM pg_temp.assert((SELECT bool_and(stock_processed = false AND stock_processed_at IS NULL
                                          AND stock_movement_id IS NULL)
                            FROM wholesale_order_items WHERE order_id = v_order),
    '1 · los items nacen con marcadores neutros (false/NULL/NULL)');
  PERFORM pg_temp.assert_stock_intacto('1 · crear el pedido');
END $$;

-- El cliente sigue leyendo su pedido (la lectura no se toco).
DO $$
DECLARE v_n int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', pg_temp.id('WCU_A')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_n FROM public.wholesale_orders WHERE id = current_setting('g2c1.o1')::uuid;
  RESET ROLE;
  PERFORM pg_temp.assert(v_n = 1, '1 · el cliente lee su propio pedido');
END $$;

-- ============================================================================
-- 2 y 3 · el cliente NO puede crear un pedido con estado administrativo
-- ============================================================================
DO $$
DECLARE v_res text; v_st text;
BEGIN
  FOREACH v_st IN ARRAY ARRAY['approved', 'invoiced', 'delivered', 'pending_review'] LOOP
    v_res := pg_temp.como(pg_temp.id('WCU_A'), format(
      $q$INSERT INTO public.wholesale_orders(business_id, customer_id, order_number, subtotal, total, status)
         VALUES (%L, %L, %L, 0, 0, %L)$q$,
      pg_temp.id('BIZ_A'), pg_temp.id('WC_A'), 'G2C1-ST-' || v_st, v_st));
    RAISE NOTICE '   INSERT status=% -> %', v_st, v_res;
    PERFORM pg_temp.assert(v_res LIKE '42501%',
      '2/3 · el cliente NO puede crear un pedido en ' || v_st || ' (privilegio de columna)');
  END LOOP;

  v_res := pg_temp.como(pg_temp.id('WCU_A'), format(
    $q$INSERT INTO public.wholesale_orders(business_id, customer_id, order_number, subtotal, total, admin_notes)
       VALUES (%L, %L, 'G2C1-AN', 0, 0, 'forjada')$q$, pg_temp.id('BIZ_A'), pg_temp.id('WC_A')));
  PERFORM pg_temp.assert(v_res LIKE '42501%', '2 · el cliente NO puede escribir admin_notes al crear');

  PERFORM pg_temp.assert(NOT EXISTS (SELECT 1 FROM wholesale_orders WHERE order_number LIKE 'G2C1-ST-%'
                                                                       OR order_number = 'G2C1-AN'),
    '2/3 · ninguno de esos pedidos existe');
END $$;

-- Defensa en profundidad: aunque un GRANT futuro devolviera la columna, la
-- policy obliga igual al estado inicial. (Se concede SOLO dentro de esta
-- transaccion, que termina en ROLLBACK.)
GRANT INSERT (status, admin_notes) ON public.wholesale_orders TO authenticated;
DO $$
DECLARE v_res text;
BEGIN
  v_res := pg_temp.como(pg_temp.id('WCU_A'), format(
    $q$INSERT INTO public.wholesale_orders(business_id, customer_id, order_number, subtotal, total, status)
       VALUES (%L, %L, 'G2C1-POL-1', 0, 0, 'approved')$q$, pg_temp.id('BIZ_A'), pg_temp.id('WC_A')));
  RAISE NOTICE '   con GRANT(status) · INSERT approved -> %', v_res;
  PERFORM pg_temp.assert(v_res LIKE '42501%row-level security%',
    '2 · con la columna concedida, la POLICY sigue rechazando status=approved');

  v_res := pg_temp.como(pg_temp.id('WCU_A'), format(
    $q$INSERT INTO public.wholesale_orders(business_id, customer_id, order_number, subtotal, total, status)
       VALUES (%L, %L, 'G2C1-POL-2', 0, 0, 'pending_whatsapp')$q$, pg_temp.id('BIZ_A'), pg_temp.id('WC_A')));
  PERFORM pg_temp.assert(v_res = 'OK', '2 · y la policy admite el estado inicial explicito (control positivo)');

  v_res := pg_temp.como(pg_temp.id('SALES_A'), format(
    $q$INSERT INTO public.wholesale_orders(business_id, customer_id, order_number, subtotal, total, status)
       VALUES (%L, %L, 'G2C1-POL-3', 0, 0, 'invoiced')$q$, pg_temp.id('BIZ_A'), pg_temp.id('WC_A')));
  PERFORM pg_temp.assert(v_res LIKE '42501%row-level security%',
    '2 · la policy de alta de STAFF tambien obliga a pending_whatsapp (nadie gana permisos)');
END $$;
REVOKE INSERT (status, admin_notes) ON public.wholesale_orders FROM authenticated;

-- ============================================================================
-- 4 y 5 · el cliente NO puede fabricar marcadores de stock
-- ============================================================================
DO $$
DECLARE v_res text; v_order uuid := current_setting('g2c1.o1')::uuid;
BEGIN
  v_res := pg_temp.como(pg_temp.id('WCU_A'), format(
    $q$INSERT INTO public.wholesale_order_items(order_id, business_id, inventory_item_id, product_name,
         quantity, unit_price, subtotal, stock_processed)
       VALUES (%L, %L, %L, 'forjado', 1, 1, 1, true)$q$, v_order, pg_temp.id('BIZ_A'), pg_temp.id('INV_A2')));
  PERFORM pg_temp.assert(v_res LIKE '42501%', '4 · el cliente NO puede insertar stock_processed=true');

  v_res := pg_temp.como(pg_temp.id('WCU_A'), format(
    $q$INSERT INTO public.wholesale_order_items(order_id, business_id, inventory_item_id, product_name,
         quantity, unit_price, subtotal, stock_movement_id)
       VALUES (%L, %L, %L, 'forjado', 1, 1, 1, gen_random_uuid())$q$, v_order, pg_temp.id('BIZ_A'), pg_temp.id('INV_A2')));
  PERFORM pg_temp.assert(v_res LIKE '42501%', '5 · el cliente NO puede insertar un stock_movement_id arbitrario');

  v_res := pg_temp.como(pg_temp.id('WCU_A'), format(
    $q$INSERT INTO public.wholesale_order_items(order_id, business_id, inventory_item_id, product_name,
         quantity, unit_price, subtotal, stock_processed_at)
       VALUES (%L, %L, %L, 'forjado', 1, 1, 1, now())$q$, v_order, pg_temp.id('BIZ_A'), pg_temp.id('INV_A2')));
  PERFORM pg_temp.assert(v_res LIKE '42501%', '5 · el cliente NO puede insertar stock_processed_at');

  -- Ni modificarlos despues: no hay UPDATE sobre items para nadie del lado cliente.
  v_res := pg_temp.como(pg_temp.id('WCU_A'), format(
    $q$UPDATE public.wholesale_order_items SET stock_processed = true WHERE order_id = %L$q$, v_order));
  PERFORM pg_temp.assert(v_res LIKE '42501%', '4 · el cliente NO puede cambiar stock_processed');
  v_res := pg_temp.como(pg_temp.id('ADMIN_A'), format(
    $q$UPDATE public.wholesale_order_items SET stock_processed = true, stock_movement_id = gen_random_uuid()
        WHERE order_id = %L$q$, v_order));
  PERFORM pg_temp.assert(v_res LIKE '42501%', '4 · ni siquiera el staff puede escribir marcadores directo');
  v_res := pg_temp.como(pg_temp.id('ADMIN_A'), format(
    $q$UPDATE public.wholesale_order_items SET quantity = 50 WHERE order_id = %L$q$, v_order));
  PERFORM pg_temp.assert(v_res LIKE '42501%', '4 · ni editar la cantidad de un item existente');

  PERFORM pg_temp.assert((SELECT count(*) FROM wholesale_order_items WHERE order_id = v_order) = 3,
    '4/5 · no aparecio ningun item forjado');
  PERFORM pg_temp.assert_stock_intacto('4/5 · marcadores');
END $$;

-- Defensa en profundidad sobre marcadores: la policy los rechaza aunque la
-- columna se conceda.
GRANT INSERT (stock_processed, stock_movement_id) ON public.wholesale_order_items TO authenticated;
DO $$
DECLARE v_res text; v_order uuid := current_setting('g2c1.o1')::uuid;
BEGIN
  v_res := pg_temp.como(pg_temp.id('WCU_A'), format(
    $q$INSERT INTO public.wholesale_order_items(order_id, business_id, inventory_item_id, product_name,
         quantity, unit_price, subtotal, stock_processed, stock_movement_id)
       VALUES (%L, %L, %L, 'forjado', 1, 1, 1, true, gen_random_uuid())$q$,
    v_order, pg_temp.id('BIZ_A'), pg_temp.id('INV_A2')));
  RAISE NOTICE '   con GRANT(marcadores) · INSERT forjado -> %', v_res;
  PERFORM pg_temp.assert(v_res LIKE '42501%row-level security%',
    '4/5 · con la columna concedida, la POLICY sigue rechazando marcadores forjados');
END $$;
REVOKE INSERT (stock_processed, stock_movement_id) ON public.wholesale_order_items FROM authenticated;

-- ============================================================================
-- 6 y 7 · quantity estrictamente positiva
-- ============================================================================
DO $$
DECLARE v_res text; v_order uuid := current_setting('g2c1.o1')::uuid;
BEGIN
  v_res := pg_temp.como(pg_temp.id('WCU_A'), format(
    $q$INSERT INTO public.wholesale_order_items(order_id, business_id, inventory_item_id, product_name,
         quantity, unit_price, subtotal) VALUES (%L, %L, %L, 'cero', 0, 1, 0)$q$,
    v_order, pg_temp.id('BIZ_A'), pg_temp.id('INV_A2')));
  PERFORM pg_temp.assert(v_res LIKE '23514%', '6 · quantity = 0 rechazada (23514)');

  v_res := pg_temp.como(pg_temp.id('WCU_A'), format(
    $q$INSERT INTO public.wholesale_order_items(order_id, business_id, inventory_item_id, product_name,
         quantity, unit_price, subtotal) VALUES (%L, %L, %L, 'negativa', -5, 1, -5)$q$,
    v_order, pg_temp.id('BIZ_A'), pg_temp.id('INV_A2')));
  PERFORM pg_temp.assert(v_res LIKE '23514%', '7 · quantity < 0 rechazada (23514)');

  -- El CHECK aplica tambien a postgres: no es solo un privilegio.
  BEGIN
    INSERT INTO wholesale_order_items(order_id, business_id, product_name, quantity, unit_price, subtotal)
      VALUES (v_order, pg_temp.id('BIZ_A'), 'negativa-admin', -1, 1, -1);
    v_res := 'OK';
  EXCEPTION WHEN check_violation THEN v_res := '23514';
  END;
  PERFORM pg_temp.assert(v_res = '23514', '7 · el CHECK quantity > 0 rige incluso para postgres');

  v_res := pg_temp.como(pg_temp.id('WCU_A'), format(
    $q$INSERT INTO public.wholesale_order_items(order_id, business_id, inventory_item_id, product_name,
         quantity, unit_price, subtotal) VALUES (%L, %L, %L, 'uno', 1, 1, 1)$q$,
    v_order, pg_temp.id('BIZ_A'), pg_temp.id('INV_A10')));
  PERFORM pg_temp.assert(v_res = 'OK', '8 · quantity = 1 permitida');
  -- Se quita para no alterar las cantidades de los casos siguientes.
  DELETE FROM wholesale_order_items WHERE order_id = v_order AND product_name = 'uno';
END $$;

-- ============================================================================
-- 9 a 14 · el staff autorizado cambia estados y el stock NO se mueve nunca
-- ============================================================================
DO $$
DECLARE r jsonb; v_order uuid := current_setting('g2c1.o1')::uuid;
BEGIN
  -- 9. pending_whatsapp -> pending_review (sales, capability wholesale por default)
  r := pg_temp.rpc(pg_temp.id('SALES_A'), pg_temp.id('BIZ_A'), v_order, 'pending_review');
  RAISE NOTICE '   pending_whatsapp -> pending_review : %', r;
  PERFORM pg_temp.assert(r->>'ok' = 'true' AND r->>'status' = 'pending_review'
                         AND r->>'previous_status' = 'pending_whatsapp' AND r->>'changed' = 'true',
    '9 · pending_whatsapp -> pending_review lo hace la RPC (sales)');
  PERFORM pg_temp.assert((SELECT status FROM wholesale_orders WHERE id = v_order) = 'pending_review',
    '9 · el estado quedo persistido');
  PERFORM pg_temp.assert_stock_intacto('9 · pending_review');

  -- 10. -> approved (admin). Pedido con SOBREVENTA (stock 2, pide 5): igual no se toca.
  r := pg_temp.rpc(pg_temp.id('ADMIN_A'), pg_temp.id('BIZ_A'), v_order, 'approved');
  PERFORM pg_temp.assert(r->>'ok' = 'true' AND r->>'status' = 'approved',
    '10 · -> approved lo hace la RPC (admin)');
  PERFORM pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id = pg_temp.id('INV_A2')) = 2,
    '10 · approved NO descuenta: el producto con sobreventa sigue en 2');
  PERFORM pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id = pg_temp.id('INV_A10')) = 10,
    '10 · approved NO descuenta: el otro producto sigue en 10');
  PERFORM pg_temp.assert_stock_intacto('10 · approved');

  -- 11. approved -> cancelled: no hay devolucion (no hubo salida).
  r := pg_temp.rpc(pg_temp.id('OWN_A'), pg_temp.id('BIZ_A'), v_order, 'cancelled');
  PERFORM pg_temp.assert(r->>'ok' = 'true' AND r->>'previous_status' = 'approved' AND r->>'status' = 'cancelled',
    '11 · approved -> cancelled lo hace la RPC (owner)');
  PERFORM pg_temp.assert(NOT EXISTS (SELECT 1 FROM inventory_movements WHERE movement_type = 'return'
                                        AND business_id = pg_temp.id('BIZ_A')),
    '11 · cancelled NO crea un movimiento de devolucion');
  PERFORM pg_temp.assert_stock_intacto('11 · cancelled');

  -- El flujo de la UI permite cancelled -> pending_review -> approved de nuevo.
  r := pg_temp.rpc(pg_temp.id('SALES_A'), pg_temp.id('BIZ_A'), v_order, 'pending_review');
  PERFORM pg_temp.assert(r->>'ok' = 'true', '11 · cancelled -> pending_review (reapertura de la UI)');
  r := pg_temp.rpc(pg_temp.id('SALES_A'), pg_temp.id('BIZ_A'), v_order, 'approved');
  PERFORM pg_temp.assert(r->>'ok' = 'true', '11 · y se puede volver a aprobar');
  PERFORM pg_temp.assert_stock_intacto('11 · reaprobar');

  -- 12. approved -> rejected. La UI ofrece rejected desde pending_review; la
  --     base no impone el grafo (tampoco lo hacia antes) y ningun estado mueve
  --     stock, asi que se prueba el caso mas exigente.
  r := pg_temp.rpc(pg_temp.id('SALES_A'), pg_temp.id('BIZ_A'), v_order, 'rejected');
  PERFORM pg_temp.assert(r->>'ok' = 'true' AND r->>'status' = 'rejected', '12 · approved -> rejected');
  PERFORM pg_temp.assert_stock_intacto('12 · rejected');

  r := pg_temp.rpc(pg_temp.id('SALES_A'), pg_temp.id('BIZ_A'), v_order, 'pending_review');
  r := pg_temp.rpc(pg_temp.id('SALES_A'), pg_temp.id('BIZ_A'), v_order, 'approved');

  -- 13. -> invoiced: la RPC no mueve stock (el que lo mueve es el comprobante).
  r := pg_temp.rpc(pg_temp.id('SALES_A'), pg_temp.id('BIZ_A'), v_order, 'invoiced');
  PERFORM pg_temp.assert(r->>'ok' = 'true' AND r->>'status' = 'invoiced', '13 · approved -> invoiced');
  PERFORM pg_temp.assert_stock_intacto('13 · invoiced desde la RPC');

  -- 14. -> delivered
  r := pg_temp.rpc(pg_temp.id('SALES_A'), pg_temp.id('BIZ_A'), v_order, 'delivered');
  PERFORM pg_temp.assert(r->>'ok' = 'true' AND r->>'status' = 'delivered', '14 · invoiced -> delivered');
  PERFORM pg_temp.assert_stock_intacto('14 · delivered');
END $$;

-- ============================================================================
-- 12b · pending_review -> rejected (el camino exacto de la UI)
-- ============================================================================
DO $$
DECLARE r jsonb; v_order uuid;
BEGIN
  v_order := pg_temp.cliente_crea_pedido(pg_temp.id('WCU_A'), pg_temp.id('BIZ_A'), pg_temp.id('WC_A'),
    'G2C1-12b', jsonb_build_array(jsonb_build_object(
      'inventory_item_id', pg_temp.id('INV_A10'), 'product_name', 'A10', 'quantity', 3, 'unit_price', 1000)));
  r := pg_temp.rpc(pg_temp.id('SALES_A'), pg_temp.id('BIZ_A'), v_order, 'pending_review');
  r := pg_temp.rpc(pg_temp.id('SALES_A'), pg_temp.id('BIZ_A'), v_order, 'rejected');
  PERFORM pg_temp.assert(r->>'ok' = 'true' AND r->>'previous_status' = 'pending_review',
    '12b · pending_review -> rejected');
  PERFORM pg_temp.assert_stock_intacto('12b · rejected');
END $$;

-- ============================================================================
-- 15 · REPETIR el mismo estado no tiene efecto (y jamas mueve stock)
-- ============================================================================
DO $$
DECLARE r jsonb; v_order uuid := current_setting('g2c1.o1')::uuid; v_antes jsonb; v_despues jsonb;
BEGIN
  -- now() es constante dentro de la transaccion: para ver si la RPC escribio o
  -- no, se planta un updated_at centinela y se mira el ctid (un UPDATE crea
  -- una version nueva de la fila).
  UPDATE wholesale_orders SET updated_at = '2001-01-01T00:00:00Z' WHERE id = v_order;
  v_antes := pg_temp.fila(v_order);

  r := pg_temp.rpc(pg_temp.id('SALES_A'), pg_temp.id('BIZ_A'), v_order, 'delivered');
  PERFORM pg_temp.assert(r->>'ok' = 'true' AND r->>'changed' = 'false',
    '15 · repetir delivered devuelve ok con changed=false');
  v_despues := pg_temp.fila(v_order);
  PERFORM pg_temp.assert(v_despues = v_antes,
    '15 · la fila no se reescribio (mismo ctid, mismo updated_at centinela)');

  r := pg_temp.rpc(pg_temp.id('SALES_A'), pg_temp.id('BIZ_A'), v_order, 'delivered');
  PERFORM pg_temp.assert(r->>'changed' = 'false' AND pg_temp.fila(v_order) = v_antes,
    '15 · un tercer reintento tampoco escribe');
  PERFORM pg_temp.assert_stock_intacto('15 · reintentos');

  -- Notas: NULL conserva, texto actualiza, '' borra. Un cambio SI escribe.
  r := pg_temp.rpc(pg_temp.id('SALES_A'), pg_temp.id('BIZ_A'), v_order, 'delivered', 'Entregado en mano');
  PERFORM pg_temp.assert(r->>'changed' = 'true' AND r->>'admin_notes' = 'Entregado en mano',
    '15 · cambiar solo las notas es un cambio real');
  PERFORM pg_temp.assert((SELECT updated_at FROM wholesale_orders WHERE id = v_order) <> '2001-01-01T00:00:00Z',
    '15 · y ese cambio si actualiza updated_at');
  r := pg_temp.rpc(pg_temp.id('SALES_A'), pg_temp.id('BIZ_A'), v_order, 'delivered');
  PERFORM pg_temp.assert(r->>'changed' = 'false'
                         AND (SELECT admin_notes FROM wholesale_orders WHERE id = v_order) = 'Entregado en mano',
    '15 · p_admin_notes NULL conserva las notas');
  r := pg_temp.rpc(pg_temp.id('SALES_A'), pg_temp.id('BIZ_A'), v_order, 'delivered', '   ');
  PERFORM pg_temp.assert(r->>'changed' = 'true'
                         AND (SELECT admin_notes FROM wholesale_orders WHERE id = v_order) IS NULL,
    '15 · notas en blanco las borran');
END $$;

-- ============================================================================
-- 16, 17, 18 y RBAC · quien NO puede usar la RPC
-- ============================================================================
DO $$
DECLARE r jsonb; v_res text; v_order uuid; v_antes jsonb;
BEGIN
  v_order := pg_temp.cliente_crea_pedido(pg_temp.id('WCU_A'), pg_temp.id('BIZ_A'), pg_temp.id('WC_A'),
    'G2C1-RBAC', jsonb_build_array(jsonb_build_object(
      'inventory_item_id', pg_temp.id('INV_A2'), 'product_name', 'A2', 'quantity', 5, 'unit_price', 1000)));
  PERFORM set_config('g2c1.orbac', v_order::text, true);
  v_antes := pg_temp.fila(v_order);

  -- 16. Owner de B nombrando el negocio A.
  r := pg_temp.rpc(pg_temp.id('OWN_B'), pg_temp.id('BIZ_A'), v_order, 'approved');
  PERFORM pg_temp.assert(r->>'error_state' = '42501', '16 · usuario de B sobre el negocio A -> 42501 (' || r::text || ')');
  -- 16b. Owner de B nombrando SU negocio pero el pedido de A: indistinguible de inexistente.
  r := pg_temp.rpc(pg_temp.id('OWN_B'), pg_temp.id('BIZ_B'), v_order, 'approved');
  PERFORM pg_temp.assert(r->>'error_state' = 'P0002', '16 · pedido de A pedido desde B -> no encontrado (P0002)');
  PERFORM pg_temp.assert(pg_temp.fila(v_order) = v_antes, '16 · el pedido de A quedo intacto');

  -- 17. Cliente del portal (autenticado, sin perfil) intentando la RPC administrativa.
  r := pg_temp.rpc(pg_temp.id('WCU_A'), pg_temp.id('BIZ_A'), v_order, 'approved');
  PERFORM pg_temp.assert(r->>'error_state' = '42501', '17 · el cliente del portal NO puede usar la RPC (42501)');

  -- RBAC: tech no tiene la capability wholesale.
  r := pg_temp.rpc(pg_temp.id('TECH_A'), pg_temp.id('BIZ_A'), v_order, 'approved');
  PERFORM pg_temp.assert(r->>'error_state' = '42501', 'RBAC · tech (sin capability wholesale) -> 42501');
  -- RBAC: sales con override wholesale=false. can_manage_wholesale() (por rol)
  -- lo habria dejado pasar; la capability respeta el override.
  r := pg_temp.rpc(pg_temp.id('SALESX_A'), pg_temp.id('BIZ_A'), v_order, 'approved');
  PERFORM pg_temp.assert(r->>'error_state' = '42501', 'RBAC · sales con override wholesale=false -> 42501');
  -- Plan: negocio sin el modulo mayorista.
  r := pg_temp.rpc(pg_temp.id('OWN_P'), pg_temp.id('BIZ_P'), v_order, 'approved');
  PERFORM pg_temp.assert(r->>'error_state' = '42501' AND r->>'error' LIKE '%mayorista%',
    'RBAC · negocio sin feature mayorista -> 42501 (' || r::text || ')');
  -- Sin identidad aunque el rol sea authenticated.
  r := pg_temp.rpc(NULL, pg_temp.id('BIZ_A'), v_order, 'approved');
  PERFORM pg_temp.assert(r->>'error_state' = '42501' AND r->>'error' = 'Not authenticated',
    'RBAC · authenticated sin auth.uid() -> Not authenticated');

  -- 18. anon no tiene EXECUTE.
  v_res := pg_temp.como_anon(format(
    $q$SELECT public.update_wholesale_order_status_atomic(%L, %L, 'approved')$q$,
    pg_temp.id('BIZ_A'), v_order));
  RAISE NOTICE '   anon -> %', v_res;
  PERFORM pg_temp.assert(v_res LIKE '42501%permission denied%', '18 · anon no puede ejecutar la RPC');

  PERFORM pg_temp.assert(pg_temp.fila(v_order) = v_antes, '16-18 · ningun rechazo modifico el pedido');
  PERFORM pg_temp.assert_stock_intacto('16-18 · rechazos');
END $$;

-- ============================================================================
-- 19 y 20 · el UPDATE directo esta cerrado (incluso para staff autorizado)
-- ============================================================================
DO $$
DECLARE v_res text; v_order uuid := current_setting('g2c1.orbac')::uuid; v_antes jsonb;
BEGIN
  v_antes := pg_temp.fila(v_order);

  v_res := pg_temp.como(pg_temp.id('ADMIN_A'), format(
    $q$UPDATE public.wholesale_orders SET status = 'approved' WHERE id = %L$q$, v_order));
  RAISE NOTICE '   UPDATE directo status (admin) -> %', v_res;
  PERFORM pg_temp.assert(v_res LIKE '42501%', '19 · UPDATE directo de status por staff -> 42501');

  v_res := pg_temp.como(pg_temp.id('OWN_A'), format(
    $q$UPDATE public.wholesale_orders SET status = 'invoiced', updated_at = now() WHERE id = %L$q$, v_order));
  PERFORM pg_temp.assert(v_res LIKE '42501%', '19 · ni siquiera el owner puede hacer UPDATE directo de status');

  v_res := pg_temp.como(pg_temp.id('WCU_A'), format(
    $q$UPDATE public.wholesale_orders SET status = 'approved' WHERE id = %L$q$, v_order));
  PERFORM pg_temp.assert(v_res LIKE '42501%', '19 · el cliente del portal tampoco');

  v_res := pg_temp.como(pg_temp.id('ADMIN_A'), format(
    $q$UPDATE public.wholesale_orders SET admin_notes = 'directo' WHERE id = %L$q$, v_order));
  PERFORM pg_temp.assert(v_res LIKE '42501%', '20 · UPDATE directo de admin_notes -> 42501');

  v_res := pg_temp.como(pg_temp.id('ADMIN_A'), format(
    $q$UPDATE public.wholesale_orders SET updated_at = now() WHERE id = %L$q$, v_order));
  PERFORM pg_temp.assert(v_res LIKE '42501%', '20 · ninguna columna del pedido admite UPDATE directo');

  PERFORM pg_temp.assert(pg_temp.fila(v_order) = v_antes, '19/20 · el pedido quedo intacto');
  PERFORM pg_temp.assert((SELECT status FROM wholesale_orders WHERE id = v_order) = 'pending_whatsapp',
    '19/20 · sigue en pending_whatsapp');
END $$;

-- ============================================================================
-- 23 · ATOMICIDAD · una transicion invalida o fallida no deja nada a medias
-- ============================================================================
DO $$
DECLARE r jsonb; v_order uuid := current_setting('g2c1.orbac')::uuid; v_antes jsonb;
BEGIN
  v_antes := pg_temp.fila(v_order);

  r := pg_temp.rpc(pg_temp.id('ADMIN_A'), pg_temp.id('BIZ_A'), v_order, 'shipped');
  PERFORM pg_temp.assert(r->>'error_state' = '22023', '23 · estado inexistente -> 22023 INVALID_STATUS');
  r := pg_temp.rpc(pg_temp.id('ADMIN_A'), pg_temp.id('BIZ_A'), v_order, NULL);
  PERFORM pg_temp.assert(r->>'error_state' = '22023', '23 · estado NULL -> 22023');
  r := pg_temp.rpc(pg_temp.id('ADMIN_A'), pg_temp.id('BIZ_A'), gen_random_uuid(), 'approved');
  PERFORM pg_temp.assert(r->>'error_state' = 'P0002', '23 · pedido inexistente -> P0002');
  r := pg_temp.rpc(pg_temp.id('ADMIN_A'), NULL, v_order, 'approved');
  PERFORM pg_temp.assert(r->>'error_state' = '22023', '23 · sin business_id -> 22023 (' || r::text || ')');
  PERFORM pg_temp.assert(pg_temp.fila(v_order) = v_antes, '23 · los rechazos no tocaron el pedido');
END $$;

-- Fallo DESPUES de que la RPC ya escribio la fila: se instala un trigger que
-- aborta el UPDATE (solo en esta transaccion). La RPC tiene que fallar entera
-- y el pedido quedar exactamente como estaba.
CREATE FUNCTION public.g2c1_test_boom() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'G2C1_BOOM' USING ERRCODE = 'P0001'; END; $$;
CREATE TRIGGER g2c1_test_boom AFTER UPDATE ON public.wholesale_orders
  FOR EACH ROW EXECUTE FUNCTION public.g2c1_test_boom();
DO $$
DECLARE r jsonb; v_order uuid := current_setting('g2c1.orbac')::uuid; v_antes jsonb;
BEGIN
  v_antes := pg_temp.fila(v_order);
  r := pg_temp.rpc(pg_temp.id('ADMIN_A'), pg_temp.id('BIZ_A'), v_order, 'approved', 'no deberia quedar');
  PERFORM pg_temp.assert(r->>'error_state' = 'P0001' AND r->>'error' = 'G2C1_BOOM',
    '23 · el fallo posterior a la escritura se propaga al llamador (no se traga)');
  PERFORM pg_temp.assert(pg_temp.fila(v_order) = v_antes,
    '23 · rollback total: status, admin_notes, updated_at y la fila misma sin cambios');
  PERFORM pg_temp.assert_stock_intacto('23 · fallo a mitad');
END $$;
DROP TRIGGER g2c1_test_boom ON public.wholesale_orders;
DROP FUNCTION public.g2c1_test_boom();

-- ============================================================================
-- CONVERSION · el comprobante es la UNICA salida real de stock
--
-- Es el flujo de Mayorista.tsx: aprobar -> «Convertir en comprobante» (checkout
-- canonico con inventory_id) -> marcar invoiced con la RPC. El stock sale UNA
-- vez, en el checkout, con la aritmetica de G2-C (sobreventa permitida).
-- ============================================================================
DO $$
DECLARE r jsonb; c jsonb; v_order uuid; v_comp uuid; v_movs int; v_payload jsonb; v_biz uuid;
BEGIN
  v_order := pg_temp.cliente_crea_pedido(pg_temp.id('WCU_A'), pg_temp.id('BIZ_A'), pg_temp.id('WC_A'),
    'G2C1-CONV', jsonb_build_array(
      jsonb_build_object('inventory_item_id', pg_temp.id('INV_A10'), 'product_name', 'A10', 'quantity', 4, 'unit_price', 1000),
      jsonb_build_object('inventory_item_id', pg_temp.id('INV_A2'),  'product_name', 'A2',  'quantity', 5, 'unit_price', 1000)));
  r := pg_temp.rpc(pg_temp.id('SALES_A'), pg_temp.id('BIZ_A'), v_order, 'approved');
  PERFORM pg_temp.assert(r->>'ok' = 'true', 'CONV · pedido aprobado');
  PERFORM pg_temp.assert_stock_intacto('CONV · aprobar antes de convertir');

  -- Convertir en comprobante: exactamente lo que arma initialItems en Mayorista.tsx.
  -- El payload se arma ANTES de cambiar de rol (authenticated no lee pg_temp).
  v_payload := jsonb_build_object('tipo','remito','punto_venta','0001','condicion_fiscal','Consumidor Final',
      'customer_id', pg_temp.id('CUST_A'),'cc_total',0,'emitir_en_arca',false,
      'items', jsonb_build_array(
        jsonb_build_object('inventory_id', pg_temp.id('INV_A10'), 'descripcion','A10',
          'tipo_linea','producto','cantidad',4,'precio_unitario',1000),
        jsonb_build_object('inventory_id', pg_temp.id('INV_A2'),  'descripcion','A2',
          'tipo_linea','producto','cantidad',5,'precio_unitario',1000)),
      'pagos', jsonb_build_array(jsonb_build_object(
        'amount',9000,'amount_ars',9000,'payment_method','efectivo')));
  v_biz := pg_temp.id('BIZ_A');
  PERFORM set_config('request.jwt.claim.sub', pg_temp.id('OWN_A')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  c := create_comprobante_checkout_atomic(v_biz, 'G2C1-CONV', 'hg2c1conv', v_payload);
  RESET ROLE;
  v_comp := (c->>'comprobante_id')::uuid;
  PERFORM pg_temp.assert(c->>'status' = 'created', 'CONV · el checkout canonico crea el comprobante');

  PERFORM pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id = pg_temp.id('INV_A10')) = 6,
    'CONV · el comprobante descuenta: 10 - 4 = 6');
  PERFORM pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id = pg_temp.id('INV_A2')) = -3,
    'CONV · con sobreventa (G2-C): 2 - 5 = -3');

  -- Marcar invoiced con la RPC (el onCreado de Mayorista.tsx).
  r := pg_temp.rpc(pg_temp.id('SALES_A'), pg_temp.id('BIZ_A'), v_order, 'invoiced');
  PERFORM pg_temp.assert(r->>'ok' = 'true' AND r->>'status' = 'invoiced', 'CONV · el pedido queda invoiced');
  PERFORM pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id = pg_temp.id('INV_A10')) = 6
                         AND (SELECT stock_quantity FROM inventory WHERE id = pg_temp.id('INV_A2')) = -3,
    'CONV · invoiced NO vuelve a descontar (una sola salida)');

  SELECT count(*) INTO v_movs FROM inventory_movements WHERE business_id = pg_temp.id('BIZ_A');
  PERFORM pg_temp.assert(v_movs = 2, 'CONV · exactamente 2 movimientos, uno por linea (obtenido ' || v_movs || ')');
  PERFORM pg_temp.assert((SELECT bool_and(reference_type = 'comprobante' AND reference_id = v_comp
                                          AND movement_type = 'sale'
                                          AND new_stock - previous_stock = quantity)
                            FROM inventory_movements WHERE business_id = pg_temp.id('BIZ_A')),
    'CONV · ambos son salidas del COMPROBANTE y cumplen new - previous = quantity');

  -- Cancelar el pedido despues de facturado tampoco toca stock: revertir la
  -- venta es la anulacion canonica del comprobante, no el estado del pedido.
  r := pg_temp.rpc(pg_temp.id('SALES_A'), pg_temp.id('BIZ_A'), v_order, 'cancelled');
  PERFORM pg_temp.assert(r->>'ok' = 'true', 'CONV · invoiced -> cancelled (permitido por la UI)');
  PERFORM pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id = pg_temp.id('INV_A10')) = 6,
    'CONV · cancelar el pedido NO devuelve stock: el comprobante sigue vigente');
  PERFORM pg_temp.assert((SELECT count(*) FROM inventory_movements WHERE business_id = pg_temp.id('BIZ_A')) = 2,
    'CONV · y no crea movimientos nuevos');
END $$;

-- ============================================================================
-- 21 y 22 · cierre global
-- ============================================================================
DO $$
BEGIN
  PERFORM pg_temp.assert(NOT EXISTS (SELECT 1 FROM inventory_movements WHERE reference_type = 'wholesale_order'),
    '21 · no existe NINGUN inventory_movement con reference_type=wholesale_order');
  PERFORM pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id = pg_temp.id('INV_B7')) = 7,
    '22 · el inventario del otro tenant nunca se movio (7)');
  PERFORM pg_temp.assert(NOT EXISTS (
      SELECT 1 FROM inventory_movements m
       WHERE m.business_id = pg_temp.id('BIZ_A') AND m.reference_type IS DISTINCT FROM 'comprobante'),
    '22 · todo movimiento del negocio A vino del comprobante, ninguno de un estado de pedido');
  PERFORM pg_temp.assert(NOT EXISTS (
      SELECT 1 FROM wholesale_order_items WHERE stock_processed IS TRUE
         OR stock_processed_at IS NOT NULL OR stock_movement_id IS NOT NULL),
    '22 · ningun item mayorista quedo con marcadores de stock');
END $$;

SELECT 'G2-C.1: todas las aserciones pasaron' AS resultado;
ROLLBACK;
