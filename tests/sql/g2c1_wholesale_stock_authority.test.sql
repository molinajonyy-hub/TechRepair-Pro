-- ============================================================================
-- G2-C.1 · Autoridad del pedido mayorista (Opcion A + revision humana #144).
--
--   PEDIDO MAYORISTA = ESTADO COMERCIAL.
--   COMPROBANTE      = MOVIMIENTO ECONOMICO Y DE STOCK.
--
-- Contrato que prueba esta matriz:
--   · NINGUN estado del pedido mueve inventario ni crea inventory_movements.
--   · status/admin_notes: unico escritor la RPC update_wholesale_order_status_atomic;
--     el UPDATE directo esta cerrado.
--   · ALTA: unico camino la RPC create_wholesale_order_atomic. La base decide el
--     tenant (por slug), el cliente (el del actor, aprobado y no suspendido), los
--     productos (mismo negocio, activos, visibles), el PRECIO
--     (precio_mayorista > 0 ? precio_mayorista : sale_price), nombre, codigo,
--     subtotales, total y numero; pedido + items en una transaccion. El INSERT
--     directo esta cerrado.
--   · wholesale_customers: el cliente solo escribe last_login y su alta neutra;
--     approved/suspended/notes los administra el staff por RPC.
--   · La salida de stock de un pedido mayorista ocurre al convertirlo en
--     comprobante por el checkout canonico, y una sola vez.
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
  ('BIZ_A',   '00000000-0000-0000-0000-00000000c301'),  -- plan full, portal g2c1-a
  ('BIZ_B',   '00000000-0000-0000-0000-00000000c302'),  -- otro tenant, portal g2c1-b
  ('BIZ_P',   '00000000-0000-0000-0000-00000000c303'),  -- plan pro: SIN mayorista, portal g2c1-p
  ('BIZ_D',   '00000000-0000-0000-0000-00000000c304'),  -- plan full, portal APAGADO g2c1-off
  ('OWN_A',   '00000000-0000-0000-0000-00000000c309'),
  ('OWN_B',   '00000000-0000-0000-0000-00000000c30a'),
  ('OWN_P',   '00000000-0000-0000-0000-00000000c30b'),
  ('OWN_D',   '00000000-0000-0000-0000-00000000c30c'),
  ('ADMIN_A', '00000000-0000-0000-0000-00000000c311'),  -- admin: wholesale por default
  ('SALES_A', '00000000-0000-0000-0000-00000000c312'),  -- sales: wholesale por default
  ('TECH_A',  '00000000-0000-0000-0000-00000000c313'),  -- tech: SIN wholesale
  ('SALESX_A','00000000-0000-0000-0000-00000000c314'),  -- sales con override wholesale=false
  ('WCU_A',   '00000000-0000-0000-0000-00000000c321'),  -- cliente de A, aprobado
  ('WCU_B',   '00000000-0000-0000-0000-00000000c322'),  -- cliente de B, aprobado
  ('WCU_PEN', '00000000-0000-0000-0000-00000000c323'),  -- cliente de A, NO aprobado
  ('WCU_SUS', '00000000-0000-0000-0000-00000000c324'),  -- cliente de A, suspendido
  ('WCU_NEW', '00000000-0000-0000-0000-00000000c325'),  -- se registra durante la prueba
  ('WCU_D',   '00000000-0000-0000-0000-00000000c326'),  -- cliente del portal apagado
  ('WCU_P',   '00000000-0000-0000-0000-00000000c327'),  -- cliente del negocio sin plan
  ('WC_A',    '00000000-0000-0000-0000-00000000c3a1'),
  ('WC_B',    '00000000-0000-0000-0000-00000000c3a2'),
  ('WC_PEN',  '00000000-0000-0000-0000-00000000c3a3'),
  ('WC_SUS',  '00000000-0000-0000-0000-00000000c3a4'),
  ('WC_D',    '00000000-0000-0000-0000-00000000c3a6'),
  ('WC_P',    '00000000-0000-0000-0000-00000000c3a7'),
  ('CUST_A',  '00000000-0000-0000-0000-00000000c3c1'),  -- customers (comprobante) de A
  ('CAJA_A',  '00000000-0000-0000-0000-00000000c361'),
  ('INV_A2',  '00000000-0000-0000-0000-00000000c3d1'),  -- A, stock 2, precio_mayorista 700
  ('INV_A10', '00000000-0000-0000-0000-00000000c3d2'),  -- A, stock 10, SIN precio_mayorista -> 1000
  ('INV_A0',  '00000000-0000-0000-0000-00000000c3d3'),  -- A, precio_mayorista 0 -> sale_price 450
  ('INV_AHID','00000000-0000-0000-0000-00000000c3d4'),  -- A, NO visible en mayorista
  ('INV_AOFF','00000000-0000-0000-0000-00000000c3d5'),  -- A, inactivo
  ('INV_B7',  '00000000-0000-0000-0000-00000000c3df'),  -- B, stock 7
  ('INV_P1',  '00000000-0000-0000-0000-00000000c3e1'),  -- P
  ('INV_D1',  '00000000-0000-0000-0000-00000000c3e2');  -- D

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

-- RPC de estado del pedido como `authenticated`. Su jsonb o {error_state, error}.
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

-- RPC de alta como `authenticated`. Su jsonb o {error_state, error}.
CREATE OR REPLACE FUNCTION pg_temp.alta(p_uid uuid, p_slug text, p_items jsonb, p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_uid::text, ''), true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    r := public.create_wholesale_order_atomic(p_slug, p_items, p_notes);
  EXCEPTION WHEN OTHERS THEN
    r := jsonb_build_object('error_state', SQLSTATE, 'error', SQLERRM);
  END;
  RESET ROLE;
  RETURN r;
END; $$;

-- Alta que TIENE que funcionar: devuelve el id del pedido o aborta la matriz.
CREATE OR REPLACE FUNCTION pg_temp.pedido(p_uid uuid, p_slug text, p_items jsonb)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  r := pg_temp.alta(p_uid, p_slug, p_items);
  IF r ? 'error_state' THEN RAISE EXCEPTION 'FAIL: alta esperada OK y dio %', r; END IF;
  RETURN (r->>'order_id')::uuid;
END; $$;

-- RPC de administracion de clientes como `authenticated`.
CREATE OR REPLACE FUNCTION pg_temp.cli(p_uid uuid, p_biz uuid, p_customer uuid,
                                       p_approved boolean, p_suspended boolean, p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_uid::text, ''), true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    r := public.update_wholesale_customer_status_atomic(p_biz, p_customer, p_approved, p_suspended, p_notes);
  EXCEPTION WHEN OTHERS THEN
    r := jsonb_build_object('error_state', SQLSTATE, 'error', SQLERRM);
  END;
  RESET ROLE;
  RETURN r;
END; $$;

CREATE OR REPLACE FUNCTION pg_temp.item(p_inv text, p_qty numeric) RETURNS jsonb
LANGUAGE sql AS $$ SELECT jsonb_build_object('inventory_item_id', pg_temp.id(p_inv), 'quantity', p_qty) $$;

CREATE OR REPLACE FUNCTION pg_temp.fila(p_order uuid) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object('status', o.status, 'admin_notes', o.admin_notes,
                            'updated_at', o.updated_at, 'ctid', o.ctid::text)
    FROM public.wholesale_orders o WHERE o.id = p_order
$$;

CREATE OR REPLACE FUNCTION pg_temp.cliente(p_wc uuid) RETURNS jsonb
LANGUAGE sql AS $$ SELECT to_jsonb(c) - 'last_login' FROM public.wholesale_customers c WHERE c.id = p_wc $$;

CREATE OR REPLACE FUNCTION pg_temp.pedidos(p_biz uuid) RETURNS bigint
LANGUAGE sql AS $$ SELECT count(*) FROM public.wholesale_orders WHERE business_id = p_biz $$;

CREATE OR REPLACE FUNCTION pg_temp.items() RETURNS bigint
LANGUAGE sql AS $$ SELECT count(*) FROM public.wholesale_order_items $$;

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
 WHERE k IN ('OWN_A','OWN_B','OWN_P','OWN_D','ADMIN_A','SALES_A','TECH_A','SALESX_A',
             'WCU_A','WCU_B','WCU_PEN','WCU_SUS','WCU_NEW','WCU_D','WCU_P');
INSERT INTO public.businesses(id, name, owner_user_id, subscription_plan, subscription_status,
                              wholesale_portal_enabled, wholesale_portal_slug) VALUES
  (pg_temp.id('BIZ_A'), 'G2C1 A', pg_temp.id('OWN_A'), 'full', 'active', true,  'g2c1-a'),
  (pg_temp.id('BIZ_B'), 'G2C1 B', pg_temp.id('OWN_B'), 'full', 'active', true,  'g2c1-b'),
  (pg_temp.id('BIZ_P'), 'G2C1 P', pg_temp.id('OWN_P'), 'pro',  'active', true,  'g2c1-p'),
  (pg_temp.id('BIZ_D'), 'G2C1 D', pg_temp.id('OWN_D'), 'full', 'active', false, 'g2c1-off');
INSERT INTO public.profiles(id, business_id, role, is_active, permissions) VALUES
  (pg_temp.id('OWN_A'),    pg_temp.id('BIZ_A'), 'owner', true, NULL),
  (pg_temp.id('OWN_B'),    pg_temp.id('BIZ_B'), 'owner', true, NULL),
  (pg_temp.id('OWN_P'),    pg_temp.id('BIZ_P'), 'owner', true, NULL),
  (pg_temp.id('OWN_D'),    pg_temp.id('BIZ_D'), 'owner', true, NULL),
  (pg_temp.id('ADMIN_A'),  pg_temp.id('BIZ_A'), 'admin', true, NULL),
  (pg_temp.id('SALES_A'),  pg_temp.id('BIZ_A'), 'sales', true, NULL),
  (pg_temp.id('TECH_A'),   pg_temp.id('BIZ_A'), 'tech',  true, NULL),
  (pg_temp.id('SALESX_A'), pg_temp.id('BIZ_A'), 'sales', true, '{"wholesale": false}'::jsonb);
-- Los clientes del portal NO tienen perfil: son externos al negocio.
INSERT INTO public.wholesale_customers(id, business_id, auth_user_id, name, email, approved, suspended) VALUES
  (pg_temp.id('WC_A'),   pg_temp.id('BIZ_A'), pg_temp.id('WCU_A'),   'Mayorista A',  'wca@g2c1.test',  true,  false),
  (pg_temp.id('WC_B'),   pg_temp.id('BIZ_B'), pg_temp.id('WCU_B'),   'Mayorista B',  'wcb@g2c1.test',  true,  false),
  (pg_temp.id('WC_PEN'), pg_temp.id('BIZ_A'), pg_temp.id('WCU_PEN'), 'Pendiente A',  'pen@g2c1.test',  false, false),
  (pg_temp.id('WC_SUS'), pg_temp.id('BIZ_A'), pg_temp.id('WCU_SUS'), 'Suspendido A', 'sus@g2c1.test',  true,  true),
  (pg_temp.id('WC_D'),   pg_temp.id('BIZ_D'), pg_temp.id('WCU_D'),   'Cliente D',    'wcd@g2c1.test',  true,  false),
  (pg_temp.id('WC_P'),   pg_temp.id('BIZ_P'), pg_temp.id('WCU_P'),   'Cliente P',    'wcp@g2c1.test',  true,  false);
INSERT INTO public.customers(id, business_id, name, phone, customer_type)
  VALUES (pg_temp.id('CUST_A'), pg_temp.id('BIZ_A'), 'Mayorista A (comprobante)', '+540311', 'mayorista');
INSERT INTO public.cajas(id, business_id, opened_by, status)
  VALUES (pg_temp.id('CAJA_A'), pg_temp.id('BIZ_A'), pg_temp.id('OWN_A'), 'abierta');
INSERT INTO public.inventory(id, business_id, name, code, category, stock_quantity, stock, cost_price,
                             sale_price, precio_mayorista, base_price, base_currency, auto_update_price,
                             exchange_rate_used, is_active, visible_in_wholesale)
VALUES
  (pg_temp.id('INV_A2'),   pg_temp.id('BIZ_A'), 'G2C1 A2',   'G2C1-A2',   'Rep',  2,  2, 400, 1000,  700, 1000, 'ARS', false, 1, true,  true),
  (pg_temp.id('INV_A10'),  pg_temp.id('BIZ_A'), 'G2C1 A10',  'G2C1-A10',  'Rep', 10, 10, 600, 1000, NULL, 1000, 'ARS', false, 1, true,  true),
  (pg_temp.id('INV_A0'),   pg_temp.id('BIZ_A'), 'G2C1 A0',   'G2C1-A0',   'Rep',  4,  4, 200,  450,    0,  450, 'ARS', false, 1, true,  true),
  (pg_temp.id('INV_AHID'), pg_temp.id('BIZ_A'), 'G2C1 AHID', 'G2C1-AHID', 'Rep',  5,  5, 200,  450,  300,  450, 'ARS', false, 1, true,  false),
  (pg_temp.id('INV_AOFF'), pg_temp.id('BIZ_A'), 'G2C1 AOFF', 'G2C1-AOFF', 'Rep',  5,  5, 200,  450,  300,  450, 'ARS', false, 1, false, true),
  (pg_temp.id('INV_B7'),   pg_temp.id('BIZ_B'), 'G2C1 B7',   'G2C1-B7',   'Rep',  7,  7, 600, 1000,  800, 1000, 'ARS', false, 1, true,  true),
  (pg_temp.id('INV_P1'),   pg_temp.id('BIZ_P'), 'G2C1 P1',   'G2C1-P1',   'Rep',  3,  3, 600, 1000,  800, 1000, 'ARS', false, 1, true,  true),
  (pg_temp.id('INV_D1'),   pg_temp.id('BIZ_D'), 'G2C1 D1',   'G2C1-D1',   'Rep',  3,  3, 600, 1000,  800, 1000, 'ARS', false, 1, true,  true);
SET LOCAL session_replication_role = 'origin';

CREATE TEMP TABLE g2c1_stock0 ON COMMIT DROP AS
  SELECT id, stock_quantity, stock FROM public.inventory
   WHERE business_id IN (pg_temp.id('BIZ_A'), pg_temp.id('BIZ_B'));

-- ============================================================================
-- 0 · CATALOGO · las tres RPC y los cierres existen como se declaro
-- ============================================================================
DO $$
DECLARE v_fn oid; v_src text; v_col text; r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.update_wholesale_order_status_atomic(uuid,uuid,text,text)'),
      ('public.create_wholesale_order_atomic(text,jsonb,text)'),
      ('public.update_wholesale_customer_status_atomic(uuid,uuid,boolean,boolean,text)')) AS x(firma)
  LOOP
    v_fn := to_regprocedure(r.firma);
    PERFORM pg_temp.assert(v_fn IS NOT NULL, '0 · existe ' || r.firma);
    PERFORM pg_temp.assert((SELECT prosecdef FROM pg_proc WHERE oid = v_fn), '0 · SECURITY DEFINER · ' || r.firma);
    PERFORM pg_temp.assert((SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = v_fn) = 'postgres',
      '0 · owner postgres · ' || r.firma);
    PERFORM pg_temp.assert((SELECT proconfig FROM pg_proc WHERE oid = v_fn) = ARRAY['search_path=pg_catalog, pg_temp'],
      '0 · search_path = pg_catalog, pg_temp · ' || r.firma);
    PERFORM pg_temp.assert(NOT has_function_privilege('anon', v_fn, 'EXECUTE'), '0 · anon sin EXECUTE · ' || r.firma);
    PERFORM pg_temp.assert(NOT has_function_privilege('public', v_fn, 'EXECUTE'), '0 · PUBLIC sin EXECUTE · ' || r.firma);
    PERFORM pg_temp.assert(NOT has_function_privilege('service_role', v_fn, 'EXECUTE'), '0 · service_role sin EXECUTE · ' || r.firma);
    PERFORM pg_temp.assert(has_function_privilege('authenticated', v_fn, 'EXECUTE'), '0 · authenticated con EXECUTE · ' || r.firma);
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_fn;
    PERFORM pg_temp.assert(v_src ~* 'FOR\s+UPDATE', '0 · bloquea su fila (FOR UPDATE) · ' || r.firma);
    PERFORM pg_temp.assert(v_src !~* '(inventory_movements|stock_processed|stock_movement_id|stock_quantity|UPDATE\s+public\.inventory\M)',
      '0 · no escribe inventario ni marcadores · ' || r.firma);
  END LOOP;

  PERFORM pg_temp.assert(
    (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.update_wholesale_order_status_atomic(uuid,uuid,text,text)'))
      !~* 'inventory',
    '0 · la RPC de estado ni siquiera lee inventario');

  -- Pedidos e items: ni UPDATE ni INSERT directo, en ninguna columna.
  FOR v_col IN SELECT attname FROM pg_attribute WHERE attrelid = 'public.wholesale_orders'::regclass AND attnum > 0 AND NOT attisdropped LOOP
    PERFORM pg_temp.assert(NOT has_column_privilege('authenticated', 'public.wholesale_orders', v_col, 'INSERT')
                           AND NOT has_column_privilege('authenticated', 'public.wholesale_orders', v_col, 'UPDATE'),
      '0 · sin INSERT/UPDATE directo de wholesale_orders.' || v_col);
  END LOOP;
  PERFORM pg_temp.assert(NOT has_table_privilege('authenticated', 'public.wholesale_order_items', 'INSERT')
                         AND NOT has_table_privilege('authenticated', 'public.wholesale_order_items', 'UPDATE')
                         AND NOT has_column_privilege('authenticated', 'public.wholesale_order_items', 'unit_price', 'INSERT'),
    '0 · sin INSERT/UPDATE directo de wholesale_order_items');
  PERFORM pg_temp.assert(NOT EXISTS (
      SELECT 1 FROM pg_policy
       WHERE polrelid IN ('public.wholesale_orders'::regclass, 'public.wholesale_order_items'::regclass)
         AND polcmd IN ('a','w','*')),
    '0 · no queda ninguna policy de INSERT/UPDATE sobre pedidos o items');

  -- Clientes: UPDATE solo de last_login; INSERT solo de las columnas del alta.
  FOR v_col IN SELECT attname FROM pg_attribute WHERE attrelid = 'public.wholesale_customers'::regclass AND attnum > 0 AND NOT attisdropped LOOP
    PERFORM pg_temp.assert(has_column_privilege('authenticated', 'public.wholesale_customers', v_col, 'UPDATE') = (v_col = 'last_login'),
      '0 · UPDATE de wholesale_customers.' || v_col || ' = ' || (v_col = 'last_login')::text);
  END LOOP;
  FOREACH v_col IN ARRAY ARRAY['approved','suspended','notes','tags','total_orders','total_spent',
                               'whatsapp_verified','whatsapp_code','last_order_at','id'] LOOP
    PERFORM pg_temp.assert(NOT has_column_privilege('authenticated', 'public.wholesale_customers', v_col, 'INSERT'),
      '0 · el alta de clientes NO puede nombrar ' || v_col);
  END LOOP;
  PERFORM pg_temp.assert(NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.wholesale_customers'::regclass
                                        AND polname IN ('wc_staff_update','wc_staff_insert')),
    '0 · sin policies de escritura directa del staff sobre clientes');
  PERFORM pg_temp.assert(
    (SELECT column_default FROM information_schema.columns
      WHERE table_schema='public' AND table_name='wholesale_orders' AND column_name='status')
      = '''pending_whatsapp''::text',
    '0 · el estado inicial canonico (DEFAULT) es pending_whatsapp');
END $$;

-- ============================================================================
-- A-E · wholesale_customers: el cliente NO se administra a si mismo
-- ============================================================================
DO $$
DECLARE v_res text; v_antes jsonb; v_login timestamptz;
BEGIN
  v_antes := pg_temp.cliente(pg_temp.id('WC_PEN'));

  v_res := pg_temp.como(pg_temp.id('WCU_PEN'), format(
    $q$UPDATE public.wholesale_customers SET approved = true WHERE id = %L$q$, pg_temp.id('WC_PEN')));
  RAISE NOTICE '   cliente se autoaprueba -> %', v_res;
  PERFORM pg_temp.assert(v_res LIKE '42501%', 'A · el cliente NO puede autoaprobarse');

  v_res := pg_temp.como(pg_temp.id('WCU_SUS'), format(
    $q$UPDATE public.wholesale_customers SET suspended = false WHERE id = %L$q$, pg_temp.id('WC_SUS')));
  PERFORM pg_temp.assert(v_res LIKE '42501%', 'B · el cliente suspendido NO puede quitarse la suspension');

  v_res := pg_temp.como(pg_temp.id('WCU_A'), format(
    $q$UPDATE public.wholesale_customers SET business_id = %L WHERE id = %L$q$, pg_temp.id('BIZ_B'), pg_temp.id('WC_A')));
  PERFORM pg_temp.assert(v_res LIKE '42501%', 'C · el cliente NO puede mudar su fila a otro negocio');

  v_res := pg_temp.como(pg_temp.id('WCU_A'), format(
    $q$UPDATE public.wholesale_customers SET auth_user_id = %L WHERE id = %L$q$, pg_temp.id('WCU_B'), pg_temp.id('WC_A')));
  PERFORM pg_temp.assert(v_res LIKE '42501%', 'D · el cliente NO puede cambiar auth_user_id');

  v_res := pg_temp.como(pg_temp.id('WCU_A'), format(
    $q$UPDATE public.wholesale_customers SET total_orders = 999, total_spent = 999999 WHERE id = %L$q$, pg_temp.id('WC_A')));
  PERFORM pg_temp.assert(v_res LIKE '42501%', 'E · el cliente NO puede adulterar total_orders/total_spent');

  v_res := pg_temp.como(pg_temp.id('WCU_A'), format(
    $q$UPDATE public.wholesale_customers SET notes = 'VIP', tags = ARRAY['vip'] WHERE id = %L$q$, pg_temp.id('WC_A')));
  PERFORM pg_temp.assert(v_res LIKE '42501%', 'E · ni notas ni tags administrativos');

  v_res := pg_temp.como(pg_temp.id('WCU_A'), format(
    $q$UPDATE public.wholesale_customers SET whatsapp_verified = true, whatsapp_code = NULL WHERE id = %L$q$, pg_temp.id('WC_A')));
  PERFORM pg_temp.assert(v_res LIKE '42501%', 'E · ni la verificacion de WhatsApp (el OTP no se decide en el navegador)');

  v_res := pg_temp.como(pg_temp.id('WCU_A'), format(
    $q$UPDATE public.wholesale_customers SET last_order_at = now() WHERE id = %L$q$, pg_temp.id('WC_A')));
  PERFORM pg_temp.assert(v_res LIKE '42501%', 'E · ni last_order_at (lo escribe la RPC de alta)');

  PERFORM pg_temp.assert(pg_temp.cliente(pg_temp.id('WC_PEN')) = v_antes, 'A-E · la fila del cliente pendiente no cambio');
  PERFORM pg_temp.assert((SELECT business_id FROM wholesale_customers WHERE id = pg_temp.id('WC_A')) = pg_temp.id('BIZ_A')
                         AND (SELECT total_orders FROM wholesale_customers WHERE id = pg_temp.id('WC_A')) = 0,
    'A-E · el cliente aprobado sigue en su negocio y sin estadisticas fabricadas');

  -- Control positivo: loginCustomer sigue funcionando (last_login de la fila propia).
  v_res := pg_temp.como(pg_temp.id('WCU_A'), format(
    $q$UPDATE public.wholesale_customers SET last_login = '2026-09-23T10:00:00Z' WHERE id = %L$q$, pg_temp.id('WC_A')));
  SELECT last_login INTO v_login FROM wholesale_customers WHERE id = pg_temp.id('WC_A');
  PERFORM pg_temp.assert(v_res = 'OK' AND v_login = '2026-09-23T10:00:00Z',
    'A-E · el cliente SI actualiza su last_login (loginCustomer)');

  -- ...pero no el last_login de OTRO cliente.
  v_res := pg_temp.como(pg_temp.id('WCU_A'), format(
    $q$UPDATE public.wholesale_customers SET last_login = '2001-01-01T00:00:00Z' WHERE id = %L$q$, pg_temp.id('WC_PEN')));
  PERFORM pg_temp.assert((SELECT last_login FROM wholesale_customers WHERE id = pg_temp.id('WC_PEN')) IS DISTINCT FROM '2001-01-01T00:00:00Z',
    'A-E · y no el de otro cliente (RLS de fila propia)');

  -- El staff tampoco escribe approved directo: va por la RPC.
  v_res := pg_temp.como(pg_temp.id('SALES_A'), format(
    $q$UPDATE public.wholesale_customers SET approved = true WHERE id = %L$q$, pg_temp.id('WC_PEN')));
  PERFORM pg_temp.assert(v_res LIKE '42501%', 'A · el staff tampoco aprueba por UPDATE directo');
END $$;

-- El alta del cliente nace NEUTRA.
DO $$
DECLARE v_res text; c record;
BEGIN
  v_res := pg_temp.como(pg_temp.id('WCU_NEW'), format(
    $q$INSERT INTO public.wholesale_customers(business_id, auth_user_id, name, email, approved)
       VALUES (%L, %L, 'Nuevo', 'nuevo@g2c1.test', true)$q$, pg_temp.id('BIZ_A'), pg_temp.id('WCU_NEW')));
  PERFORM pg_temp.assert(v_res LIKE '42501%', 'A · el alta NO puede nacer approved=true');

  v_res := pg_temp.como(pg_temp.id('WCU_NEW'), format(
    $q$INSERT INTO public.wholesale_customers(business_id, auth_user_id, name, email, total_spent)
       VALUES (%L, %L, 'Nuevo', 'nuevo@g2c1.test', 1)$q$, pg_temp.id('BIZ_A'), pg_temp.id('WCU_NEW')));
  PERFORM pg_temp.assert(v_res LIKE '42501%', 'E · el alta NO puede traer estadisticas');

  v_res := pg_temp.como(pg_temp.id('WCU_NEW'), format(
    $q$INSERT INTO public.wholesale_customers(business_id, auth_user_id, name, email)
       VALUES (%L, %L, 'Impostor', 'imp@g2c1.test')$q$, pg_temp.id('BIZ_A'), pg_temp.id('WCU_A')));
  PERFORM pg_temp.assert(v_res LIKE '42501%', 'D · el alta NO puede usar el auth_user_id de otro');

  -- Control positivo: el alta real (insertWholesaleCustomer) funciona y nace neutra.
  v_res := pg_temp.como(pg_temp.id('WCU_NEW'), format(
    $q$INSERT INTO public.wholesale_customers(business_id, auth_user_id, name, business_name, email,
                                              whatsapp, province, city, instagram)
       VALUES (%L, %L, 'Nuevo', 'Kiosco', 'nuevo@g2c1.test', '5493510000000', 'Cordoba', 'Cordoba', 'kiosco')$q$,
    pg_temp.id('BIZ_A'), pg_temp.id('WCU_NEW')));
  SELECT * INTO c FROM wholesale_customers WHERE auth_user_id = pg_temp.id('WCU_NEW');
  PERFORM pg_temp.assert(v_res = 'OK', 'A · el registro del cliente sigue funcionando (' || v_res || ')');
  PERFORM pg_temp.assert(c.approved = false AND c.suspended = false AND c.whatsapp_verified = false
                         AND c.total_orders = 0 AND c.total_spent = 0 AND c.notes IS NULL AND c.tags IS NULL,
    'A · el cliente nuevo nace NO aprobado, sin suspension, sin estadisticas ni notas');
END $$;

-- Defensa en profundidad: aunque un GRANT futuro devolviera `approved`, la
-- policy de alta exige el estado neutro. (Solo en esta transaccion.)
GRANT INSERT (approved) ON public.wholesale_customers TO authenticated;
DO $$
DECLARE v_res text;
BEGIN
  v_res := pg_temp.como(pg_temp.id('WCU_NEW'), format(
    $q$INSERT INTO public.wholesale_customers(business_id, auth_user_id, name, email, approved)
       VALUES (%L, %L, 'Nuevo B', 'nuevob@g2c1.test', true)$q$, pg_temp.id('BIZ_B'), pg_temp.id('WCU_NEW')));
  RAISE NOTICE '   con GRANT(approved) · alta aprobada -> %', v_res;
  PERFORM pg_temp.assert(v_res LIKE '42501%row-level security%',
    'A · con la columna concedida, la POLICY sigue rechazando un alta aprobada');
END $$;
REVOKE INSERT (approved) ON public.wholesale_customers FROM authenticated;

-- ============================================================================
-- Administracion de clientes por el staff: solo por la RPC, con autoridad
-- ============================================================================
DO $$
DECLARE r jsonb; v_antes jsonb;
BEGIN
  v_antes := pg_temp.cliente(pg_temp.id('WC_PEN'));

  r := pg_temp.cli(pg_temp.id('WCU_PEN'), pg_temp.id('BIZ_A'), pg_temp.id('WC_PEN'), true, NULL);
  PERFORM pg_temp.assert(r->>'error_state' = '42501', 'A · el cliente NO puede usar la RPC de administracion');
  r := pg_temp.cli(pg_temp.id('TECH_A'), pg_temp.id('BIZ_A'), pg_temp.id('WC_PEN'), true, NULL);
  PERFORM pg_temp.assert(r->>'error_state' = '42501', 'CLI · tech (sin capability wholesale) -> 42501');
  r := pg_temp.cli(pg_temp.id('SALESX_A'), pg_temp.id('BIZ_A'), pg_temp.id('WC_PEN'), true, NULL);
  PERFORM pg_temp.assert(r->>'error_state' = '42501', 'CLI · sales con override wholesale=false -> 42501');
  r := pg_temp.cli(pg_temp.id('OWN_B'), pg_temp.id('BIZ_A'), pg_temp.id('WC_PEN'), true, NULL);
  PERFORM pg_temp.assert(r->>'error_state' = '42501', 'CLI · owner de B sobre el negocio A -> 42501');
  r := pg_temp.cli(pg_temp.id('OWN_B'), pg_temp.id('BIZ_B'), pg_temp.id('WC_PEN'), true, NULL);
  PERFORM pg_temp.assert(r->>'error_state' = 'P0002', 'CLI · cliente de A pedido desde B -> no encontrado (P0002)');
  PERFORM pg_temp.assert(pg_temp.cliente(pg_temp.id('WC_PEN')) = v_antes, 'CLI · los rechazos no tocaron al cliente');
END $$;

-- ============================================================================
-- F, G, H · el ALTA exige tenant correcto y cliente habilitado
-- ============================================================================
DO $$
DECLARE r jsonb; v_res text; v_b bigint; v_a bigint; v_items bigint;
BEGIN
  v_b := pg_temp.pedidos(pg_temp.id('BIZ_B'));
  v_a := pg_temp.pedidos(pg_temp.id('BIZ_A'));
  v_items := pg_temp.items();

  -- F. Cliente de A pidiendo en el portal de B, con un producto de B.
  r := pg_temp.alta(pg_temp.id('WCU_A'), 'g2c1-b', jsonb_build_array(pg_temp.item('INV_B7', 1)));
  RAISE NOTICE '   cliente A en el portal B -> %', r;
  PERFORM pg_temp.assert(r->>'error_state' = '42501', 'F · el cliente de A NO puede pedir en el negocio B');

  -- F (directo). Ni siquiera un INSERT a mano: no hay privilegio.
  v_res := pg_temp.como(pg_temp.id('WCU_A'), format(
    $q$INSERT INTO public.wholesale_orders(business_id, customer_id, order_number, subtotal, total)
       VALUES (%L, %L, 'PW-CROSS', 1, 1)$q$, pg_temp.id('BIZ_B'), pg_temp.id('WC_A')));
  PERFORM pg_temp.assert(v_res LIKE '42501%', 'F · INSERT directo de un pedido en B -> 42501');
  PERFORM pg_temp.assert(pg_temp.pedidos(pg_temp.id('BIZ_B')) = v_b, 'F · 0 pedidos nuevos en B');

  -- G. Cliente no aprobado.
  r := pg_temp.alta(pg_temp.id('WCU_PEN'), 'g2c1-a', jsonb_build_array(pg_temp.item('INV_A10', 1)));
  PERFORM pg_temp.assert(r->>'error_state' = '42501' AND r->>'error' = 'CUSTOMER_NOT_APPROVED',
    'G · cliente NO aprobado no puede pedir (' || COALESCE(r->>'error', '-') || ')');

  -- H. Cliente suspendido.
  r := pg_temp.alta(pg_temp.id('WCU_SUS'), 'g2c1-a', jsonb_build_array(pg_temp.item('INV_A10', 1)));
  PERFORM pg_temp.assert(r->>'error_state' = '42501' AND r->>'error' = 'CUSTOMER_SUSPENDED',
    'H · cliente suspendido no puede pedir (' || COALESCE(r->>'error', '-') || ')');

  -- Staff del negocio que no es cliente del portal.
  r := pg_temp.alta(pg_temp.id('SALES_A'), 'g2c1-a', jsonb_build_array(pg_temp.item('INV_A10', 1)));
  PERFORM pg_temp.assert(r->>'error_state' = '42501', 'F · el staff no es cliente: no crea pedidos por el portal');

  -- Portal apagado / plan sin mayorista / slug inexistente.
  r := pg_temp.alta(pg_temp.id('WCU_D'), 'g2c1-off', jsonb_build_array(pg_temp.item('INV_D1', 1)));
  PERFORM pg_temp.assert(r->>'error' = 'PORTAL_NOT_ACCEPTING_ORDERS', 'F · portal apagado -> no toma pedidos');
  r := pg_temp.alta(pg_temp.id('WCU_P'), 'g2c1-p', jsonb_build_array(pg_temp.item('INV_P1', 1)));
  PERFORM pg_temp.assert(r->>'error' = 'PORTAL_NOT_ACCEPTING_ORDERS', 'F · negocio sin plan mayorista -> no toma pedidos');
  r := pg_temp.alta(pg_temp.id('WCU_A'), 'no-existe', jsonb_build_array(pg_temp.item('INV_A10', 1)));
  PERFORM pg_temp.assert(r->>'error' = 'PORTAL_NOT_ACCEPTING_ORDERS', 'F · slug inexistente -> no toma pedidos');

  -- Sin identidad; anon.
  r := pg_temp.alta(NULL, 'g2c1-a', jsonb_build_array(pg_temp.item('INV_A10', 1)));
  PERFORM pg_temp.assert(r->>'error' = 'Not authenticated', 'F · authenticated sin auth.uid() -> Not authenticated');
  v_res := pg_temp.como_anon(format(
    $q$SELECT public.create_wholesale_order_atomic('g2c1-a', %L::jsonb)$q$,
    jsonb_build_array(pg_temp.item('INV_A10', 1))::text));
  PERFORM pg_temp.assert(v_res LIKE '42501%permission denied%', 'F · anon no puede ejecutar el alta');

  PERFORM pg_temp.assert(pg_temp.pedidos(pg_temp.id('BIZ_A')) = v_a AND pg_temp.items() = v_items,
    'F-H · ningun rechazo dejo pedidos ni items');
  PERFORM pg_temp.assert_stock_intacto('F-H · rechazos del alta');
END $$;

-- ============================================================================
-- I, J, N · items atados al tenant; un item malo revierte TODO el alta
-- ============================================================================
DO $$
DECLARE r jsonb; v_res text; v_a bigint; v_items bigint;
BEGIN
  v_a := pg_temp.pedidos(pg_temp.id('BIZ_A'));
  v_items := pg_temp.items();

  -- J + N. (La cantidad valida de cada linea se prueba en K/M.) Pedido de A con dos items validos y uno de inventario de B al final.
  r := pg_temp.alta(pg_temp.id('WCU_A'), 'g2c1-a', jsonb_build_array(
         pg_temp.item('INV_A2', 1), pg_temp.item('INV_A10', 1), pg_temp.item('INV_B7', 1)));
  PERFORM pg_temp.assert(r->>'error_state' = 'P0002' AND r->>'error' LIKE 'PRODUCT_NOT_AVAILABLE%',
    'J · un pedido de A NO puede usar inventario de B (' || COALESCE(r->>'error', '-') || ')');
  PERFORM pg_temp.assert(pg_temp.pedidos(pg_temp.id('BIZ_A')) = v_a,
    'N · el fallo del tercer item NO dejo un pedido huerfano');
  PERFORM pg_temp.assert(pg_temp.items() = v_items, 'N · ni items parciales de los dos primeros');

  -- Productos de A que el catalogo no ofrece.
  r := pg_temp.alta(pg_temp.id('WCU_A'), 'g2c1-a', jsonb_build_array(pg_temp.item('INV_AHID', 1)));
  PERFORM pg_temp.assert(r->>'error_state' = 'P0002', 'J · producto NO visible en mayorista -> rechazado');
  r := pg_temp.alta(pg_temp.id('WCU_A'), 'g2c1-a', jsonb_build_array(pg_temp.item('INV_AOFF', 1)));
  PERFORM pg_temp.assert(r->>'error_state' = 'P0002', 'J · producto inactivo -> rechazado');
  r := pg_temp.alta(pg_temp.id('WCU_A'), 'g2c1-a',
         jsonb_build_array(jsonb_build_object('inventory_item_id', gen_random_uuid(), 'quantity', 1)));
  PERFORM pg_temp.assert(r->>'error_state' = 'P0002', 'J · producto inexistente -> rechazado');

  -- I. El item no puede declarar otro negocio: la clave se ignora y el item
  --    nace en el negocio del pedido. (Se prueba con un alta valida abajo.)
  -- I (directo). Ni un INSERT de item a mano.
  v_res := pg_temp.como(pg_temp.id('WCU_A'), format(
    $q$INSERT INTO public.wholesale_order_items(order_id, business_id, inventory_item_id, product_name,
         quantity, unit_price, subtotal)
       VALUES (gen_random_uuid(), %L, %L, 'x', 1, 1, 1)$q$, pg_temp.id('BIZ_B'), pg_temp.id('INV_B7')));
  PERFORM pg_temp.assert(v_res LIKE '42501%', 'I · INSERT directo de un item -> 42501');

  -- Entradas malformadas.
  r := pg_temp.alta(pg_temp.id('WCU_A'), 'g2c1-a', '[]'::jsonb);
  PERFORM pg_temp.assert(r->>'error_state' = '22023' AND r->>'error' = 'EMPTY_ORDER', 'N · pedido sin items -> EMPTY_ORDER');
  r := pg_temp.alta(pg_temp.id('WCU_A'), 'g2c1-a', NULL);
  PERFORM pg_temp.assert(r->>'error_state' = '22023', 'N · items NULL -> 22023');
  r := pg_temp.alta(pg_temp.id('WCU_A'), 'g2c1-a', jsonb_build_array(pg_temp.item('INV_A10', 0)));
  PERFORM pg_temp.assert(r->>'error_state' = '22023', '6 · quantity = 0 -> 22023');
  r := pg_temp.alta(pg_temp.id('WCU_A'), 'g2c1-a', jsonb_build_array(pg_temp.item('INV_A10', -3)));
  PERFORM pg_temp.assert(r->>'error_state' = '22023', '7 · quantity < 0 -> 22023');
  r := pg_temp.alta(pg_temp.id('WCU_A'), 'g2c1-a', jsonb_build_array(pg_temp.item('INV_A10', 1.5)));
  PERFORM pg_temp.assert(r->>'error_state' = '22023', '7 · quantity fraccionaria -> 22023');
  r := pg_temp.alta(pg_temp.id('WCU_A'), 'g2c1-a',
         jsonb_build_array(jsonb_build_object('inventory_item_id', pg_temp.id('INV_A10'), 'quantity', '3')));
  PERFORM pg_temp.assert(r->>'error_state' = '22023', 'N · quantity como texto -> 22023');
  r := pg_temp.alta(pg_temp.id('WCU_A'), 'g2c1-a',
         jsonb_build_array(jsonb_build_object('product_name', 'libre', 'quantity', 1, 'unit_price', 1)));
  PERFORM pg_temp.assert(r->>'error_state' = '22023', 'N · linea libre sin inventory_item_id -> 22023');
  r := pg_temp.alta(pg_temp.id('WCU_A'), 'g2c1-a',
         jsonb_build_array(pg_temp.item('INV_A10', 1), pg_temp.item('INV_A10', 2)));
  PERFORM pg_temp.assert(r->>'error_state' = '22023', 'N · item repetido -> 22023');

  PERFORM pg_temp.assert(pg_temp.pedidos(pg_temp.id('BIZ_A')) = v_a AND pg_temp.items() = v_items,
    'N · ningun alta fallida dejo filas');
END $$;

-- El CHECK de cantidad sigue como ultima barrera, y rige incluso para postgres
-- (que no pasa por grants ni RLS). Se prueba contra un pedido real.
DO $$
DECLARE v_order uuid; v_res text;
BEGIN
  v_order := pg_temp.pedido(pg_temp.id('WCU_A'), 'g2c1-a', jsonb_build_array(pg_temp.item('INV_A0', 1)));
  BEGIN
    INSERT INTO wholesale_order_items(order_id, business_id, product_name, quantity, unit_price, subtotal)
      VALUES (v_order, pg_temp.id('BIZ_A'), 'cero-admin', 0, 1, 0);
    v_res := 'OK';
  EXCEPTION WHEN check_violation THEN v_res := '23514';
  END;
  PERFORM pg_temp.assert(v_res = '23514', '6 · quantity = 0 rechazada por el CHECK incluso para postgres');
  BEGIN
    INSERT INTO wholesale_order_items(order_id, business_id, product_name, quantity, unit_price, subtotal)
      VALUES (v_order, pg_temp.id('BIZ_A'), 'negativa-admin', -1, 1, -1);
    v_res := 'OK';
  EXCEPTION WHEN check_violation THEN v_res := '23514';
  END;
  PERFORM pg_temp.assert(v_res = '23514', '7 · quantity < 0 rechazada por el CHECK incluso para postgres');
  DELETE FROM wholesale_order_items WHERE order_id = v_order;
  DELETE FROM wholesale_orders WHERE id = v_order;
END $$;

-- ============================================================================
-- K, L, M, O, P, Q · alta correcta: la base decide precio, nombre y totales
-- ============================================================================
DO $$
DECLARE r jsonb; v_order uuid; v_items bigint; o record; i record;
BEGIN
  v_items := pg_temp.items();

  -- El navegador manda precio $1, nombre y codigo falsos, otro business_id,
  -- estado y marcadores: todo eso tiene que IGNORARSE.
  r := pg_temp.alta(pg_temp.id('WCU_A'), 'g2c1-a', jsonb_build_array(
         jsonb_build_object('inventory_item_id', pg_temp.id('INV_A2'), 'quantity', 5,
                            'unit_price', 1, 'subtotal', 5, 'product_name', 'REGALO',
                            'product_code', 'FAKE', 'business_id', pg_temp.id('BIZ_B'),
                            'stock_processed', true),
         jsonb_build_object('inventory_item_id', pg_temp.id('INV_A10'), 'quantity', 4,
                            'unit_price', 1),
         jsonb_build_object('inventory_item_id', pg_temp.id('INV_A0'), 'quantity', 2)),
       '  Entregar el martes  ');
  RAISE NOTICE '   alta valida -> %', r;
  PERFORM pg_temp.assert(r->>'ok' = 'true', 'O · el alta valida funciona');
  v_order := (r->>'order_id')::uuid;
  PERFORM set_config('g2c1.o1', v_order::text, true);

  SELECT * INTO o FROM wholesale_orders WHERE id = v_order;

  -- K. Precio canonico, no el del navegador.
  SELECT * INTO i FROM wholesale_order_items WHERE order_id = v_order AND inventory_item_id = pg_temp.id('INV_A2');
  PERFORM pg_temp.assert(i.unit_price = 700, 'K · precio adulterado $1 -> la base guarda precio_mayorista 700 (' || i.unit_price || ')');
  PERFORM pg_temp.assert(i.subtotal = 3500, 'K · subtotal de linea 5 x 700 = 3500 (' || i.subtotal || ')');
  SELECT * INTO i FROM wholesale_order_items WHERE order_id = v_order AND inventory_item_id = pg_temp.id('INV_A10');
  PERFORM pg_temp.assert(i.unit_price = 1000, 'K · sin precio_mayorista -> sale_price 1000 (' || i.unit_price || ')');
  SELECT * INTO i FROM wholesale_order_items WHERE order_id = v_order AND inventory_item_id = pg_temp.id('INV_A0');
  PERFORM pg_temp.assert(i.unit_price = 450, 'K · precio_mayorista 0 -> sale_price 450 (' || i.unit_price || ')');

  -- L. Nombre y codigo canonicos; tenant del pedido.
  SELECT * INTO i FROM wholesale_order_items WHERE order_id = v_order AND inventory_item_id = pg_temp.id('INV_A2');
  PERFORM pg_temp.assert(i.product_name = 'G2C1 A2' AND i.product_code = 'G2C1-A2',
    'L · product_name/product_code adulterados -> los de inventory (' || i.product_name || ' / ' || i.product_code || ')');
  PERFORM pg_temp.assert(NOT EXISTS (SELECT 1 FROM wholesale_order_items WHERE order_id = v_order
                                       AND business_id IS DISTINCT FROM pg_temp.id('BIZ_A')),
    'I · el item NO pudo declarar el negocio B: todos nacen en el negocio del pedido');

  -- M. Totales calculados por la base: 3500 + 4000 + 900 = 8400.
  PERFORM pg_temp.assert(o.subtotal = 8400 AND o.total = 8400,
    'M · subtotal/total del pedido los calcula la base = 8400 (' || o.subtotal || ' / ' || o.total || ')');
  PERFORM pg_temp.assert((r->>'total')::numeric = 8400 AND jsonb_array_length(r->'items') = 3,
    'M · la respuesta devuelve el total y las lineas canonicas');
  PERFORM pg_temp.assert((SELECT sum(subtotal) FROM wholesale_order_items WHERE order_id = v_order) = o.total,
    'M · la suma de las lineas cierra con el total');

  -- O. Pedido e items juntos.
  PERFORM pg_temp.assert(pg_temp.items() = v_items + 3, 'O · pedido + sus 3 items se crearon juntos');
  PERFORM pg_temp.assert(o.business_id = pg_temp.id('BIZ_A') AND o.customer_id = pg_temp.id('WC_A'),
    'O · tenant y cliente los resolvio la base (negocio A, cliente del actor)');
  PERFORM pg_temp.assert(o.order_number ~ '^PW-[0-9A-F]{10}$', 'O · order_number generado por la base (' || o.order_number || ')');
  PERFORM pg_temp.assert(o.notes = 'Entregar el martes', 'O · notas del cliente recortadas');

  -- P, Q. Estado inicial y marcadores.
  PERFORM pg_temp.assert(o.status = 'pending_whatsapp' AND r->>'status' = 'pending_whatsapp',
    'P · el pedido nace en pending_whatsapp');
  PERFORM pg_temp.assert(o.admin_notes IS NULL, 'P · sin notas administrativas');
  PERFORM pg_temp.assert((SELECT bool_and(stock_processed = false AND stock_processed_at IS NULL AND stock_movement_id IS NULL)
                            FROM wholesale_order_items WHERE order_id = v_order),
    'Q · marcadores de stock neutros (false/NULL/NULL)');

  -- El alta NO mueve stock.
  PERFORM pg_temp.assert_stock_intacto('O · crear el pedido');

  -- last_order_at lo escribe la base; las estadisticas no se inventan.
  PERFORM pg_temp.assert((SELECT last_order_at IS NOT NULL AND total_orders = 0 AND total_spent = 0
                            FROM wholesale_customers WHERE id = pg_temp.id('WC_A')),
    'O · last_order_at lo escribe la RPC; total_orders/total_spent no se tocan');

  -- El cliente lee su propio pedido (la lectura no se toco).
  PERFORM set_config('request.jwt.claim.sub', pg_temp.id('WCU_A')::text, true);
END $$;

DO $$
DECLARE v_n int;
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_n FROM public.wholesale_orders WHERE id = current_setting('g2c1.o1')::uuid;
  RESET ROLE;
  PERFORM pg_temp.assert(v_n = 1, 'O · el cliente lee su propio pedido');
END $$;

-- Defensa en profundidad: aun concediendo INSERT de tabla, sin policy de
-- INSERT la RLS niega todo alta directa. (Solo en esta transaccion.)
GRANT INSERT ON public.wholesale_orders TO authenticated;
DO $$
DECLARE v_res text;
BEGIN
  v_res := pg_temp.como(pg_temp.id('WCU_A'), format(
    $q$INSERT INTO public.wholesale_orders(business_id, customer_id, order_number, subtotal, total, status)
       VALUES (%L, %L, 'PW-POL', 0, 0, 'approved')$q$, pg_temp.id('BIZ_A'), pg_temp.id('WC_A')));
  RAISE NOTICE '   con GRANT de tabla · alta directa -> %', v_res;
  PERFORM pg_temp.assert(v_res LIKE '42501%row-level security%',
    '2/3 · con el GRANT devuelto, la RLS sin policy de INSERT sigue negando el alta directa');
END $$;
REVOKE INSERT ON public.wholesale_orders FROM authenticated;

-- Aprobar al pendiente por la RPC habilita su alta (control positivo de G).
DO $$
DECLARE r jsonb; v_antes timestamptz;
BEGIN
  r := pg_temp.cli(pg_temp.id('SALES_A'), pg_temp.id('BIZ_A'), pg_temp.id('WC_PEN'), true, NULL);
  PERFORM pg_temp.assert(r->>'ok' = 'true' AND r->>'approved' = 'true' AND r->>'changed' = 'true',
    'CLI · el staff (sales) aprueba al cliente por la RPC');
  UPDATE wholesale_customers SET updated_at = '2001-01-01T00:00:00Z' WHERE id = pg_temp.id('WC_PEN');
  r := pg_temp.cli(pg_temp.id('SALES_A'), pg_temp.id('BIZ_A'), pg_temp.id('WC_PEN'), true, NULL);
  PERFORM pg_temp.assert(r->>'changed' = 'false'
                         AND (SELECT updated_at FROM wholesale_customers WHERE id = pg_temp.id('WC_PEN')) = '2001-01-01T00:00:00Z',
    'CLI · repetir la aprobacion no escribe la fila');

  r := pg_temp.alta(pg_temp.id('WCU_PEN'), 'g2c1-a', jsonb_build_array(pg_temp.item('INV_A10', 1)));
  PERFORM pg_temp.assert(r->>'ok' = 'true', 'G · ya aprobado, el cliente puede pedir');

  r := pg_temp.cli(pg_temp.id('ADMIN_A'), pg_temp.id('BIZ_A'), pg_temp.id('WC_PEN'), NULL, true, 'deuda');
  PERFORM pg_temp.assert(r->>'suspended' = 'true' AND r->>'approved' = 'true' AND r->>'notes' = 'deuda',
    'CLI · suspender conserva la aprobacion y guarda la nota');
  r := pg_temp.alta(pg_temp.id('WCU_PEN'), 'g2c1-a', jsonb_build_array(pg_temp.item('INV_A10', 1)));
  PERFORM pg_temp.assert(r->>'error' = 'CUSTOMER_SUSPENDED', 'H · suspendido por la RPC, ya no puede pedir');
  r := pg_temp.cli(pg_temp.id('ADMIN_A'), pg_temp.id('BIZ_A'), pg_temp.id('WC_PEN'), NULL, false, '');
  PERFORM pg_temp.assert(r->>'suspended' = 'false' AND r->'notes' = 'null'::jsonb,
    'CLI · reactivar y borrar la nota (texto vacio)');
  PERFORM pg_temp.assert_stock_intacto('CLI · administracion de clientes');
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

  -- 12. approved -> rejected. La base no impone el grafo (tampoco lo hacia
  --     antes) y ningun estado mueve stock: se prueba el caso mas exigente.
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
  v_order := pg_temp.pedido(pg_temp.id('WCU_A'), 'g2c1-a', jsonb_build_array(pg_temp.item('INV_A10', 3)));
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
-- 16, 17, 18 y RBAC · quien NO puede usar la RPC de estado
-- ============================================================================
DO $$
DECLARE r jsonb; v_res text; v_order uuid; v_antes jsonb;
BEGIN
  v_order := pg_temp.pedido(pg_temp.id('WCU_A'), 'g2c1-a', jsonb_build_array(pg_temp.item('INV_A2', 5)));
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
    $q$UPDATE public.wholesale_orders SET total = 1 WHERE id = %L$q$, v_order));
  PERFORM pg_temp.assert(v_res LIKE '42501%', '20 · ni el total del pedido');

  v_res := pg_temp.como(pg_temp.id('ADMIN_A'), format(
    $q$UPDATE public.wholesale_order_items SET unit_price = 1, quantity = 50 WHERE order_id = %L$q$, v_order));
  PERFORM pg_temp.assert(v_res LIKE '42501%', '20 · ni precio ni cantidad de sus items');

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

-- N (alta): fallo DESPUES de insertar el encabezado y los items. Un trigger
-- sobre el UPDATE de last_order_at (el ultimo paso de la RPC) aborta: no puede
-- quedar el pedido, ni sus items, ni el last_order_at.
CREATE TRIGGER g2c1_test_boom_wc AFTER UPDATE ON public.wholesale_customers
  FOR EACH ROW EXECUTE FUNCTION public.g2c1_test_boom();
DO $$
DECLARE r jsonb; v_a bigint; v_items bigint; v_last timestamptz;
BEGIN
  v_a := pg_temp.pedidos(pg_temp.id('BIZ_A'));
  v_items := pg_temp.items();
  SELECT last_order_at INTO v_last FROM wholesale_customers WHERE id = pg_temp.id('WC_A');
  r := pg_temp.alta(pg_temp.id('WCU_A'), 'g2c1-a',
         jsonb_build_array(pg_temp.item('INV_A2', 1), pg_temp.item('INV_A10', 2)));
  PERFORM pg_temp.assert(r->>'error' = 'G2C1_BOOM', 'N · el alta falla en su ultimo paso y lo informa');
  PERFORM pg_temp.assert(pg_temp.pedidos(pg_temp.id('BIZ_A')) = v_a, 'N · rollback total: sin encabezado huerfano');
  PERFORM pg_temp.assert(pg_temp.items() = v_items, 'N · rollback total: sin items');
  PERFORM pg_temp.assert((SELECT last_order_at FROM wholesale_customers WHERE id = pg_temp.id('WC_A')) IS NOT DISTINCT FROM v_last,
    'N · rollback total: last_order_at sin cambios');
END $$;
DROP TRIGGER g2c1_test_boom_wc ON public.wholesale_customers;
DROP FUNCTION public.g2c1_test_boom();

-- ============================================================================
-- R · CONVERSION · el comprobante es la UNICA salida real de stock
--
-- El flujo completo: el cliente CREA el pedido por la RPC -> el staff lo aprueba
-- -> «Convertir en comprobante» (checkout canonico con inventory_id) -> invoiced
-- por la RPC. El stock sale UNA vez, en el checkout, con la aritmetica de G2-C.
-- ============================================================================
DO $$
DECLARE r jsonb; c jsonb; v_order uuid; v_comp uuid; v_movs int; v_payload jsonb; v_biz uuid;
BEGIN
  v_order := pg_temp.pedido(pg_temp.id('WCU_A'), 'g2c1-a', jsonb_build_array(
    pg_temp.item('INV_A10', 4), pg_temp.item('INV_A2', 5)));
  r := pg_temp.rpc(pg_temp.id('SALES_A'), pg_temp.id('BIZ_A'), v_order, 'approved');
  PERFORM pg_temp.assert(r->>'ok' = 'true', 'R · pedido creado por la RPC y aprobado');
  PERFORM pg_temp.assert_stock_intacto('R · crear y aprobar antes de convertir');

  -- Convertir en comprobante: exactamente lo que arma initialItems en Mayorista.tsx
  -- (las lineas del pedido, con su inventory_id y su precio).
  -- El payload se arma ANTES de cambiar de rol (authenticated no lee pg_temp).
  SELECT jsonb_build_object('tipo','remito','punto_venta','0001','condicion_fiscal','Consumidor Final',
      'customer_id', pg_temp.id('CUST_A'),'cc_total',0,'emitir_en_arca',false,
      'items', jsonb_agg(jsonb_build_object('inventory_id', w.inventory_item_id, 'descripcion', w.product_name,
                         'tipo_linea','producto','cantidad', w.quantity,'precio_unitario', w.unit_price)),
      'pagos', jsonb_build_array(jsonb_build_object(
        'amount', sum(w.subtotal),'amount_ars', sum(w.subtotal),'payment_method','efectivo')))
    INTO v_payload
    FROM wholesale_order_items w WHERE w.order_id = v_order;
  v_biz := pg_temp.id('BIZ_A');
  PERFORM set_config('request.jwt.claim.sub', pg_temp.id('OWN_A')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  c := create_comprobante_checkout_atomic(v_biz, 'G2C1-CONV', 'hg2c1conv', v_payload);
  RESET ROLE;
  v_comp := (c->>'comprobante_id')::uuid;
  PERFORM pg_temp.assert(c->>'status' = 'created', 'R · el checkout canonico crea el comprobante');

  PERFORM pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id = pg_temp.id('INV_A10')) = 6,
    'R · el comprobante descuenta: 10 - 4 = 6');
  PERFORM pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id = pg_temp.id('INV_A2')) = -3,
    'R · con sobreventa (G2-C): 2 - 5 = -3');

  -- Marcar invoiced con la RPC (el onCreado de Mayorista.tsx).
  r := pg_temp.rpc(pg_temp.id('SALES_A'), pg_temp.id('BIZ_A'), v_order, 'invoiced');
  PERFORM pg_temp.assert(r->>'ok' = 'true' AND r->>'status' = 'invoiced', 'R · el pedido queda invoiced');
  PERFORM pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id = pg_temp.id('INV_A10')) = 6
                         AND (SELECT stock_quantity FROM inventory WHERE id = pg_temp.id('INV_A2')) = -3,
    'R · invoiced NO vuelve a descontar (una sola salida)');

  SELECT count(*) INTO v_movs FROM inventory_movements WHERE business_id = pg_temp.id('BIZ_A');
  PERFORM pg_temp.assert(v_movs = 2, 'R · exactamente 2 movimientos, uno por linea (obtenido ' || v_movs || ')');
  PERFORM pg_temp.assert((SELECT bool_and(reference_type = 'comprobante' AND reference_id = v_comp
                                          AND movement_type = 'sale'
                                          AND new_stock - previous_stock = quantity)
                            FROM inventory_movements WHERE business_id = pg_temp.id('BIZ_A')),
    'R · ambos son salidas del COMPROBANTE y cumplen new - previous = quantity');

  -- Cancelar el pedido despues de facturado tampoco toca stock: revertir la
  -- venta es la anulacion canonica del comprobante, no el estado del pedido.
  r := pg_temp.rpc(pg_temp.id('SALES_A'), pg_temp.id('BIZ_A'), v_order, 'cancelled');
  PERFORM pg_temp.assert(r->>'ok' = 'true', 'R · invoiced -> cancelled (permitido por la UI)');
  PERFORM pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id = pg_temp.id('INV_A10')) = 6,
    'R · cancelar el pedido NO devuelve stock: el comprobante sigue vigente');
  PERFORM pg_temp.assert((SELECT count(*) FROM inventory_movements WHERE business_id = pg_temp.id('BIZ_A')) = 2,
    'R · y no crea movimientos nuevos');
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
    '22 · todo movimiento del negocio A vino del comprobante, ninguno de un pedido');
  PERFORM pg_temp.assert(NOT EXISTS (
      SELECT 1 FROM wholesale_order_items WHERE stock_processed IS TRUE
         OR stock_processed_at IS NOT NULL OR stock_movement_id IS NOT NULL),
    '22 · ningun item mayorista quedo con marcadores de stock');
  PERFORM pg_temp.assert(pg_temp.pedidos(pg_temp.id('BIZ_B')) = 0,
    '22 · el negocio B no recibio ningun pedido en toda la matriz');
END $$;

SELECT 'G2-C.1: todas las aserciones pasaron' AS resultado;
ROLLBACK;
