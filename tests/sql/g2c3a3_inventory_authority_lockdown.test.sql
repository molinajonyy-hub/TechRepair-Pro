-- ============================================================================
-- G2-C.3A3 · Lockdown en base de datos de la autoridad de stock.
--
-- Contrato (migracion 20261009120000_g2c3a3_inventory_authority_lockdown.sql):
--   · La API (anon / authenticated) NO escribe inventory.stock ni
--     inventory.stock_quantity: ni UPDATE ni INSERT que los nombre (42501 en el
--     chequeo de permisos). La metadata se sigue creando (nace en 0) y editando.
--   · inventory_movements es append-only y solo server-side: la API no
--     INSERT/UPDATE/DELETE; ni siquiera postgres reescribe o borra un movimiento
--     (salvo las acciones referenciales SET NULL / purge del tenant).
--   · FK inventory_item_id ON DELETE RESTRICT: un producto con historial no se
--     borra en duro; soft-delete sigue.
--   · A1 y W1-W7 siguen escribiendo saldo y movimientos; negativos permitidos.
--
-- Los accesos "directos" se ejecutan de verdad como la API: SET LOCAL ROLE
-- authenticated|anon + request.jwt.claim.sub (lo mismo que hace PostgREST).
-- A1-A18: los casos del lote; M: matriz de privilegios; D: defensa en
-- profundidad ante un GRANT futuro; R: acciones referenciales.
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

CREATE TEMP TABLE _id (k text PRIMARY KEY, v uuid NOT NULL) ON COMMIT DROP;
INSERT INTO _id VALUES
  ('A',    '00000000-0000-0000-0000-0000000a3b01'),
  ('B',    '00000000-0000-0000-0000-0000000a3b02'),
  ('C',    '00000000-0000-0000-0000-0000000a3b03'),
  ('OWN',  '00000000-0000-0000-0000-0000000a3a01'),
  ('SAL',  '00000000-0000-0000-0000-0000000a3a02'),
  ('TEC',  '00000000-0000-0000-0000-0000000a3a03'),
  ('OWNB', '00000000-0000-0000-0000-0000000a3a11'),
  ('OWNC', '00000000-0000-0000-0000-0000000a3a21'),
  ('CUST', '00000000-0000-0000-0000-0000000a3c01'),
  ('CAJA', '00000000-0000-0000-0000-0000000a3c61'),
  ('PROV', '00000000-0000-0000-0000-0000000a3f01'),
  ('XB',   '00000000-0000-0000-0000-0000000a3e01'),
  ('XC',   '00000000-0000-0000-0000-0000000a3e11'),
  ('MOVC', '00000000-0000-0000-0000-0000000a3e12'),
  ('MOVP', '00000000-0000-0000-0000-0000000a3e21');
INSERT INTO _id SELECT format('P%s', lpad(n::text, 2, '0')), format('00000000-0000-0000-0000-0000000a3d%s', lpad(n::text, 2, '0'))::uuid
  FROM generate_series(1, 20) AS n;

CREATE OR REPLACE FUNCTION pg_temp.id(p_k text) RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT v FROM _id WHERE k = p_k $$;
CREATE OR REPLACE FUNCTION pg_temp.stock(p_k text) RETURNS int LANGUAGE sql AS
$$ SELECT stock_quantity FROM public.inventory WHERE id = pg_temp.id(p_k) $$;
CREATE OR REPLACE FUNCTION pg_temp.alias(p_k text) RETURNS int LANGUAGE sql AS
$$ SELECT stock FROM public.inventory WHERE id = pg_temp.id(p_k) $$;
CREATE OR REPLACE FUNCTION pg_temp.movs(p_k text) RETURNS bigint LANGUAGE sql AS
$$ SELECT count(*) FROM public.inventory_movements WHERE inventory_item_id = pg_temp.id(p_k) $$;

-- Ejecuta SQL como la API (rol + sub del JWT, igual que PostgREST) y devuelve
-- 'OK <filas>' o 'SQLSTATE mensaje'. El SQL llega con los UUID ya resueltos:
-- como authenticated no se pueden leer las tablas temporales de postgres.
CREATE OR REPLACE FUNCTION pg_temp.como_rol(p_role text, p_uid uuid, p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_state text; v_rows bigint;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_uid::text, ''), true);
  PERFORM set_config('request.jwt.claims',
    (jsonb_build_object('role', p_role)
       || CASE WHEN p_uid IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('sub', p_uid) END)::text, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_state := 'OK ' || v_rows;
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE || ' ' || SQLERRM;
  END;
  RESET ROLE;
  RETURN v_state;
END; $$;
CREATE OR REPLACE FUNCTION pg_temp.como(p_uid text, p_sql text) RETURNS text LANGUAGE sql AS
$$ SELECT pg_temp.como_rol('authenticated', pg_temp.id(p_uid), p_sql) $$;

-- Lo mismo como postgres (dueño de las tablas = contexto canonico).
CREATE OR REPLACE FUNCTION pg_temp.como_postgres(p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_state text; v_rows bigint;
BEGIN
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_state := 'OK ' || v_rows;
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE || ' ' || SQLERRM;
  END;
  RETURN v_state;
END; $$;

-- Llama a A1 como authenticated y devuelve el jsonb (o 'ERR SQLSTATE msg').
CREATE OR REPLACE FUNCTION pg_temp.ajuste(p_uid text, p_biz text, p_items jsonb, p_source text, p_key text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v jsonb; v_biz uuid := pg_temp.id(p_biz); v_uid uuid := pg_temp.id(p_uid);
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    v := public.apply_inventory_stock_adjustments_atomic(v_biz, p_items, p_source, NULL, p_key);
  EXCEPTION WHEN OTHERS THEN
    v := jsonb_build_object('error', SQLSTATE || ' ' || SQLERRM);
  END;
  RESET ROLE;
  RETURN v;
END; $$;
CREATE OR REPLACE FUNCTION pg_temp.d(p_k text, p_delta int) RETURNS jsonb LANGUAGE sql AS
$$ SELECT jsonb_build_array(jsonb_build_object('inventory_id', pg_temp.id(p_k), 'delta', p_delta)) $$;
CREATE OR REPLACE FUNCTION pg_temp.item(r jsonb, p_k text) RETURNS jsonb LANGUAGE sql AS
$$ SELECT e FROM jsonb_array_elements(r -> 'items') e WHERE (e ->> 'inventory_id')::uuid = pg_temp.id(p_k) $$;

-- Huella del saldo y del libro de los tres negocios.
CREATE OR REPLACE FUNCTION pg_temp.huella() RETURNS text LANGUAGE sql AS $$
  SELECT md5(
    coalesce((SELECT string_agg(format('%s:%s:%s', id, stock_quantity, stock), ',' ORDER BY id)
                FROM public.inventory WHERE business_id IN (pg_temp.id('A'), pg_temp.id('B'), pg_temp.id('C'))), '') || '|' ||
    coalesce((SELECT string_agg(format('%s:%s:%s:%s:%s:%s', id, inventory_item_id, quantity, previous_stock, new_stock, movement_type), ',' ORDER BY id)
                FROM public.inventory_movements WHERE business_id IN (pg_temp.id('A'), pg_temp.id('B'), pg_temp.id('C'))), ''))
$$;

-- ── Semilla (como postgres, triggers apagados: es fixture, no el contrato) ──
SET LOCAL session_replication_role = 'replica';
INSERT INTO auth.users(id) SELECT v FROM _id WHERE k IN ('OWN','SAL','TEC','OWNB','OWNC');
INSERT INTO businesses(id, name, owner_user_id) VALUES
  (pg_temp.id('A'), 'G2C3A3', pg_temp.id('OWN')),
  (pg_temp.id('B'), 'G2C3A3 ajeno', pg_temp.id('OWNB')),
  (pg_temp.id('C'), 'G2C3A3 purge', pg_temp.id('OWNC'));
INSERT INTO profiles(id, user_id, business_id, role, is_active, permissions) VALUES
  (pg_temp.id('OWN'),  pg_temp.id('OWN'),  pg_temp.id('A'), 'owner', true, NULL),
  (pg_temp.id('SAL'),  pg_temp.id('SAL'),  pg_temp.id('A'), 'sales', true, NULL),
  (pg_temp.id('TEC'),  pg_temp.id('TEC'),  pg_temp.id('A'), 'tech',  true, NULL),
  (pg_temp.id('OWNB'), pg_temp.id('OWNB'), pg_temp.id('B'), 'owner', true, NULL);
INSERT INTO customers(id, business_id, name, phone, customer_type)
  VALUES (pg_temp.id('CUST'), pg_temp.id('A'), 'Cliente A3', '+540093', 'minorista');
INSERT INTO cajas(id, business_id, opened_by, status) VALUES (pg_temp.id('CAJA'), pg_temp.id('A'), pg_temp.id('OWN'), 'abierta');
INSERT INTO suppliers(id, business_id, name) VALUES (pg_temp.id('PROV'), pg_temp.id('A'), 'Proveedor A3');

INSERT INTO inventory(id, business_id, name, code, category, stock_quantity, stock, cost_price, sale_price,
                      base_price, base_currency, auto_update_price, exchange_rate_used, is_active, parent_id)
SELECT pg_temp.id(p.k), pg_temp.id('A'), 'A3 ' || p.k, 'G2C3A3-' || p.k, 'Rep', p.st, p.st, 600, 1000, 1000, 'ARS', false, 1, true,
       CASE WHEN p.k = 'P17' THEN pg_temp.id('P16') END
  FROM (VALUES
    ('P01', 10), ('P02', 10), ('P03', 10), ('P04', 10), ('P05', 2),  ('P06', 10), ('P07', 10), ('P08', 2),
    ('P09', 10), ('P10', 0),  ('P11', 10), ('P12', 10), ('P13', 10), ('P14', 10), ('P15', 10), ('P16', 0),
    ('P17', 10), ('P18', 10), ('P19', 10), ('P20', 10)
  ) AS p(k, st);
INSERT INTO inventory(id, business_id, name, code, category, stock_quantity, stock, cost_price, sale_price,
                      base_price, base_currency, auto_update_price, exchange_rate_used, is_active)
VALUES (pg_temp.id('XB'), pg_temp.id('B'), 'Ajeno', 'G2C3A3-XB', 'Rep', 40, 40, 600, 1000, 1000, 'ARS', false, 1, true),
       (pg_temp.id('XC'), pg_temp.id('C'), 'Purge', 'G2C3A3-XC', 'Rep', 5, 5, 600, 1000, 1000, 'ARS', false, 1, true);
-- Historia legada sembrada: un movimiento del tenant a purgar y uno con proveedor.
INSERT INTO inventory_movements(id, business_id, inventory_item_id, movement_type, quantity, previous_stock, new_stock)
VALUES (pg_temp.id('MOVC'), pg_temp.id('C'), pg_temp.id('XC'), 'in', 5, 0, 5);
INSERT INTO inventory_movements(id, business_id, inventory_item_id, movement_type, quantity, previous_stock, new_stock, supplier_id, created_by)
VALUES (pg_temp.id('MOVP'), pg_temp.id('A'), pg_temp.id('P18'), 'purchase', 10, 0, 10, pg_temp.id('PROV'), pg_temp.id('OWN'));
SET LOCAL session_replication_role = 'origin';

-- ============================================================================
-- M · MATRIZ DE PRIVILEGIOS (has_table_privilege / has_column_privilege)
-- ============================================================================
DO $$
DECLARE r text; c text; p text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
    FOREACH c IN ARRAY ARRAY['stock', 'stock_quantity'] LOOP
      FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE'] LOOP
        PERFORM pg_temp.assert(NOT has_column_privilege(r, 'public.inventory', c, p),
          format('M.1 %s NO tiene %s sobre inventory.%s', r, p, c));
      END LOOP;
    END LOOP;
    PERFORM pg_temp.assert(NOT has_table_privilege(r, 'public.inventory', 'INSERT') AND NOT has_table_privilege(r, 'public.inventory', 'UPDATE'),
      format('M.2 %s NO tiene INSERT/UPDATE de TABLA sobre inventory', r));
    FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
      PERFORM pg_temp.assert(NOT has_table_privilege(r, 'public.inventory_movements', p),
        format('M.3 %s NO tiene %s sobre inventory_movements', r, p));
    END LOOP;
    PERFORM pg_temp.assert(NOT has_any_column_privilege(r, 'public.inventory_movements', 'INSERT')
                       AND NOT has_any_column_privilege(r, 'public.inventory_movements', 'UPDATE'),
      format('M.4 %s NO tiene INSERT/UPDATE de columna sobre inventory_movements', r));
  END LOOP;
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = 'public.inventory'::regclass AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attname NOT IN ('stock', 'stock_quantity')
        AND has_column_privilege('authenticated', 'public.inventory', a.attname, 'INSERT')
        AND has_column_privilege('authenticated', 'public.inventory', a.attname, 'UPDATE')) = 55,
    'M.5 authenticated conserva INSERT+UPDATE en las 55 columnas de metadata');
  PERFORM pg_temp.assert(NOT has_any_column_privilege('anon', 'public.inventory', 'INSERT')
                     AND NOT has_any_column_privilege('anon', 'public.inventory', 'UPDATE'),
    'M.6 anon no obtiene escrituras de metadata (no tiene policy de escritura)');
  PERFORM pg_temp.assert(has_column_privilege('authenticated', 'public.inventory', 'stock_quantity', 'SELECT')
                     AND has_column_privilege('anon', 'public.inventory', 'stock_quantity', 'SELECT')
                     AND has_column_privilege('authenticated', 'public.inventory_movements', 'quantity', 'SELECT'),
    'M.7 la LECTURA del saldo y del libro no cambio');
  PERFORM pg_temp.assert(has_table_privilege('authenticated', 'public.inventory', 'DELETE'),
    'M.8 authenticated conserva DELETE de inventory (lo gobierna can_manage + la FK)');
  PERFORM pg_temp.assert(NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                                        AND tablename = 'inventory_movements' AND cmd <> 'SELECT'),
    'M.9 inventory_movements no tiene policies de escritura');
END $$;

-- ============================================================================
-- A1 · OWNER, UPDATE directo stock_quantity = 9999 (stock 10) -> 42501
-- ============================================================================
DO $$
DECLARE v text; h text := pg_temp.huella();
BEGIN
  v := pg_temp.como('OWN', format('UPDATE public.inventory SET stock_quantity = 9999 WHERE id = %L', pg_temp.id('P01')));
  RAISE NOTICE '   A1 owner UPDATE stock_quantity -> %', v;
  PERFORM pg_temp.assert(v LIKE '42501%', 'A1.1 owner UPDATE directo de stock_quantity -> 42501');
  PERFORM pg_temp.assert(pg_temp.stock('P01') = 10 AND pg_temp.alias('P01') = 10, 'A1.2 el stock sigue en 10 (y el alias)');
  PERFORM pg_temp.assert(pg_temp.movs('P01') = 0, 'A1.3 cero movimientos');
  -- Mezclar metadata con saldo no "cuela" el saldo: la sentencia entera se rechaza.
  v := pg_temp.como('OWN', format('UPDATE public.inventory SET name = %L, stock_quantity = 9999 WHERE id = %L', 'colado', pg_temp.id('P01')));
  PERFORM pg_temp.assert(v LIKE '42501%' AND (SELECT name FROM public.inventory WHERE id = pg_temp.id('P01')) = 'A3 P01',
    'A1.4 UPDATE metadata + stock en la misma sentencia -> 42501 y nada cambia');
  v := pg_temp.como('OWN', format('UPDATE public.inventory SET stock_quantity = stock_quantity + 1 WHERE id = %L', pg_temp.id('P01')));
  PERFORM pg_temp.assert(v LIKE '42501%', 'A1.5 UPDATE relativo (stock_quantity + 1) -> 42501');
  PERFORM pg_temp.assert(pg_temp.huella() = h, 'A1.6 huella de saldo y libro intacta');
END $$;

-- ============================================================================
-- A2 · SALES con capability inventory: MISMO resultado
-- ============================================================================
DO $$
DECLARE v text; h text := pg_temp.huella();
BEGIN
  PERFORM pg_temp.assert(private.capability_resolve('sales', NULL::jsonb, 'inventory') IS TRUE,
    'A2.0 sales TIENE la capability inventory (D5)');
  v := pg_temp.como('SAL', format('UPDATE public.inventory SET stock_quantity = 9999 WHERE id = %L', pg_temp.id('P02')));
  RAISE NOTICE '   A2 sales UPDATE stock_quantity -> %', v;
  PERFORM pg_temp.assert(v LIKE '42501%', 'A2.1 sales UPDATE directo de stock_quantity -> 42501 (capability no es autoridad DML)');
  PERFORM pg_temp.assert(pg_temp.stock('P02') = 10 AND pg_temp.movs('P02') = 0, 'A2.2 stock 10, cero movimientos');
  PERFORM pg_temp.assert(pg_temp.huella() = h, 'A2.3 huella intacta');
END $$;

-- ============================================================================
-- A3 · UPDATE directo del alias `stock` -> 42501
-- ============================================================================
DO $$
DECLARE v text; h text := pg_temp.huella();
BEGIN
  v := pg_temp.como('SAL', format('UPDATE public.inventory SET stock = 9999 WHERE id = %L', pg_temp.id('P03')));
  PERFORM pg_temp.assert(v LIKE '42501%', 'A3.1 UPDATE directo del alias stock -> 42501 (' || left(v, 60) || ')');
  v := pg_temp.como('OWN', format('UPDATE public.inventory SET stock = 9999, stock_quantity = 9999 WHERE id = %L', pg_temp.id('P03')));
  PERFORM pg_temp.assert(v LIKE '42501%', 'A3.2 UPDATE de stock + stock_quantity juntos -> 42501');
  v := pg_temp.como('OWN', format('UPDATE public.inventory SET stock_quantity = stock_quantity WHERE id = %L', pg_temp.id('P03')));
  PERFORM pg_temp.assert(v LIKE '42501%', 'A3.3 nombrar la columna del saldo, aunque no cambie, -> 42501 (el saldo no es parte del payload)');
  PERFORM pg_temp.assert(pg_temp.stock('P03') = 10 AND pg_temp.alias('P03') = 10 AND pg_temp.huella() = h,
    'A3.4 stock y alias intactos, huella intacta');
END $$;

-- ============================================================================
-- A4 · INSERT directo de producto CON saldo -> 42501
-- ============================================================================
DO $$
DECLARE v text; n0 bigint := (SELECT count(*) FROM public.inventory WHERE business_id = pg_temp.id('A'));
BEGIN
  v := pg_temp.como('SAL', format(
    'INSERT INTO public.inventory(business_id, name, code, category, cost_price, sale_price, stock_quantity) VALUES (%L, %L, %L, %L, 0, 100, 50)',
    pg_temp.id('A'), 'Con stock', 'G2C3A3-NEW-S50', 'Rep'));
  RAISE NOTICE '   A4 sales INSERT stock_quantity 50 -> %', v;
  PERFORM pg_temp.assert(v LIKE '42501%', 'A4.1 INSERT con stock_quantity = 50 -> 42501');
  v := pg_temp.como('OWN', format(
    'INSERT INTO public.inventory(business_id, name, code, category, cost_price, sale_price, stock) VALUES (%L, %L, %L, %L, 0, 100, 50)',
    pg_temp.id('A'), 'Con alias', 'G2C3A3-NEW-A50', 'Rep'));
  PERFORM pg_temp.assert(v LIKE '42501%', 'A4.2 INSERT con el alias stock = 50 -> 42501');
  v := pg_temp.como('OWN', format(
    'INSERT INTO public.inventory(business_id, name, code, category, cost_price, sale_price, stock_quantity) VALUES (%L, %L, %L, %L, 0, 100, -7)',
    pg_temp.id('A'), 'Negativo', 'G2C3A3-NEW-N7', 'Rep'));
  PERFORM pg_temp.assert(v LIKE '42501%', 'A4.3 INSERT con stock negativo -> 42501');
  v := pg_temp.como('OWN', format(
    'INSERT INTO public.inventory(business_id, name, code, category, cost_price, sale_price, stock_quantity, stock) VALUES (%L, %L, %L, %L, 0, 100, 0, 0)',
    pg_temp.id('A'), 'Cero explicito', 'G2C3A3-NEW-Z0', 'Rep'));
  PERFORM pg_temp.assert(v LIKE '42501%', 'A4.4 nombrar el saldo en el INSERT, aunque sea 0, -> 42501 (A2 no lo manda)');
  PERFORM pg_temp.assert((SELECT count(*) FROM public.inventory WHERE business_id = pg_temp.id('A')) = n0,
    'A4.5 ninguna fila creada');
END $$;

-- ============================================================================
-- A5 · INSERT directo de METADATA sin saldo -> exito, nace en 0/0
-- ============================================================================
DO $$
DECLARE v text;
BEGIN
  -- Mismo shape que productService.createProduct (A2): metadata + cost_price, sin stock.
  v := pg_temp.como('SAL', format(
    'INSERT INTO public.inventory(business_id, created_by, name, code, category, tipo, base_currency, currency, base_price, cost_price, sale_price, min_stock, location, is_active) '
    'VALUES (%L, %L, %L, %L, %L, %L, %L, %L, 100, 60, 100, 2, %L, true)',
    pg_temp.id('A'), pg_temp.id('SAL'), 'Alta A2 sales', 'G2C3A3-NEW-SAL', 'Rep', 'product', 'ARS', 'ARS', 'Estante 1'));
  PERFORM pg_temp.assert(v = 'OK 1', 'A5.1 sales crea metadata sin stock (' || v || ')');
  v := pg_temp.como('OWN', format(
    'INSERT INTO public.inventory(business_id, name, code, category, cost_price, sale_price) VALUES (%L, %L, %L, %L, 0, 100)',
    pg_temp.id('A'), 'Alta A2 owner', 'G2C3A3-NEW-OWN', 'Rep'));
  PERFORM pg_temp.assert(v = 'OK 1', 'A5.2 owner crea metadata sin stock (' || v || ')');
  PERFORM pg_temp.assert((SELECT bool_and(stock_quantity = 0 AND stock = 0) FROM public.inventory
                           WHERE code IN ('G2C3A3-NEW-SAL', 'G2C3A3-NEW-OWN')) IS TRUE,
    'A5.3 los dos nacen con stock_quantity = 0 y stock = 0 (defaults)');
  PERFORM pg_temp.assert((SELECT count(*) FROM public.inventory_movements m JOIN public.inventory i ON i.id = m.inventory_item_id
                           WHERE i.code IN ('G2C3A3-NEW-SAL', 'G2C3A3-NEW-OWN')) = 0,
    'A5.4 sin movimientos (el alta no mueve stock)');
  -- La lectura de vuelta (return=representation de PostgREST) sigue funcionando.
  v := pg_temp.como('SAL', 'SELECT id, code, stock_quantity, stock FROM public.inventory WHERE code = ''G2C3A3-NEW-SAL''');
  PERFORM pg_temp.assert(v = 'OK 1', 'A5.5 sales lee la fila creada con sus columnas operativas (' || v || ')');
END $$;

-- ============================================================================
-- A6 · UPDATE de METADATA -> exito, saldo intacto
-- ============================================================================
DO $$
DECLARE v text; h text;
BEGIN
  h := (SELECT string_agg(format('%s:%s', stock_quantity, stock), ',') FROM public.inventory WHERE id = pg_temp.id('P07'));
  v := pg_temp.como('SAL', format(
    'UPDATE public.inventory SET name = %L, min_stock = 3, max_stock = 40, location = %L, category = %L, sale_price = 1234, '
    'barcode = %L, updated_at = now() WHERE id = %L AND business_id = %L',
    'P07 editado', 'Deposito B', 'Otra', '779000000001', pg_temp.id('P07'), pg_temp.id('A')));
  PERFORM pg_temp.assert(v = 'OK 1', 'A6.1 sales edita nombre/min_stock/location/categoria/precio/barcode (' || v || ')');
  PERFORM pg_temp.assert((SELECT name = 'P07 editado' AND min_stock = 3 AND location = 'Deposito B' AND category = 'Otra' AND sale_price = 1234
                            FROM public.inventory WHERE id = pg_temp.id('P07')),
    'A6.2 la metadata quedo escrita');
  PERFORM pg_temp.assert((SELECT string_agg(format('%s:%s', stock_quantity, stock), ',') FROM public.inventory WHERE id = pg_temp.id('P07')) = h
                     AND pg_temp.movs('P07') = 0, 'A6.3 saldo intacto (10/10) y cero movimientos');
  v := pg_temp.como('OWN', format('UPDATE public.inventory SET min_stock = 1, has_variants = false WHERE id = %L', pg_temp.id('P07')));
  PERFORM pg_temp.assert(v = 'OK 1', 'A6.4 owner edita metadata (' || v || ')');
END $$;

-- ============================================================================
-- A7 · A1 RPC: 10 + 5 = 15 con movimiento exacto (y replay idempotente)
-- ============================================================================
DO $$
DECLARE r jsonb; r2 jsonb; i jsonb; m record;
BEGIN
  r := pg_temp.ajuste('OWN', 'A', pg_temp.d('P04', 5), 'manual', 'a3-a7');
  RAISE NOTICE '   A7 -> %', r::text;
  i := pg_temp.item(r, 'P04');
  PERFORM pg_temp.assert(r ->> 'status' = 'created' AND i ->> 'status' = 'applied', 'A7.1 A1 aplica el ajuste');
  PERFORM pg_temp.assert(pg_temp.stock('P04') = 15 AND pg_temp.alias('P04') = 15, 'A7.2 stock 10 + 5 = 15 (y el alias)');
  SELECT * INTO m FROM public.inventory_movements WHERE id = (i ->> 'movement_id')::uuid;
  PERFORM pg_temp.assert(m.movement_type = 'adjustment' AND m.previous_stock = 10 AND m.new_stock = 15 AND m.quantity = 5
                     AND m.business_id = pg_temp.id('A') AND m.inventory_item_id = pg_temp.id('P04')
                     AND m.reference_type = 'manual' AND m.reference_id = (r ->> 'request_id')::uuid
                     AND m.created_by = pg_temp.id('OWN'),
    'A7.3 movimiento exacto: adjustment 10 -> 15 (+5), reference manual/request, created_by owner');
  PERFORM pg_temp.assert(pg_temp.movs('P04') = 1, 'A7.4 un solo movimiento');
  r2 := pg_temp.ajuste('OWN', 'A', pg_temp.d('P04', 5), 'manual', 'a3-a7');
  PERFORM pg_temp.assert(r2 ->> 'status' = 'existing' AND pg_temp.stock('P04') = 15 AND pg_temp.movs('P04') = 1,
    'A7.5 replay con la misma clave: existing, sin segundo movimiento (idempotencia A1 intacta)');
  -- sales (D5) tambien PIDE el cambio por la autoridad.
  r := pg_temp.ajuste('SAL', 'A', pg_temp.d('P19', -4), 'manual', 'a3-a7-sales');
  PERFORM pg_temp.assert(r ->> 'status' = 'created' AND pg_temp.stock('P19') = 6 AND pg_temp.movs('P19') = 1,
    'A7.6 sales pide el ajuste por A1: 10 - 4 = 6 con movimiento');
END $$;

-- ============================================================================
-- A8 · negativo por A1: 2 - 5 = -3
-- ============================================================================
DO $$
DECLARE r jsonb;
BEGIN
  r := pg_temp.ajuste('OWN', 'A', pg_temp.d('P05', -5), 'manual', 'a3-a8');
  PERFORM pg_temp.assert(pg_temp.stock('P05') = -3 AND pg_temp.alias('P05') = -3, 'A8.1 stock 2 - 5 = -3 (negativo permitido)');
  PERFORM pg_temp.assert((SELECT quantity = -5 AND previous_stock = 2 AND new_stock = -3 FROM public.inventory_movements
                           WHERE id = (pg_temp.item(r, 'P05') ->> 'movement_id')::uuid), 'A8.2 movimiento -5: 2 -> -3');
END $$;

-- ============================================================================
-- A9 · INSERT directo en inventory_movements -> 42501
-- ============================================================================
DO $$
DECLARE v text; h text := pg_temp.huella(); k text;
BEGIN
  FOREACH k IN ARRAY ARRAY['OWN', 'SAL'] LOOP
    v := pg_temp.como(k, format(
      'INSERT INTO public.inventory_movements(business_id, inventory_item_id, movement_type, quantity, previous_stock, new_stock) '
      'VALUES (%L, %L, %L, 5, 10, 15)', pg_temp.id('A'), pg_temp.id('P06'), 'in'));
    RAISE NOTICE '   A9 % INSERT movimiento -> %', k, v;
    PERFORM pg_temp.assert(v LIKE '42501%', 'A9.1 ' || k || ' INSERT directo de un movimiento -> 42501');
  END LOOP;
  PERFORM pg_temp.assert(pg_temp.movs('P06') = 0 AND pg_temp.huella() = h, 'A9.2 el libro no cambio');
END $$;

-- Movimiento canonico de P06 para A10/A11/A13 (A1: 10 -> 11).
DO $$
DECLARE r jsonb;
BEGIN
  r := pg_temp.ajuste('OWN', 'A', pg_temp.d('P06', 1), 'manual', 'a3-p06');
  PERFORM set_config('g2c3a3.mov_p06', pg_temp.item(r, 'P06') ->> 'movement_id', true);
  PERFORM pg_temp.assert(pg_temp.stock('P06') = 11 AND pg_temp.movs('P06') = 1, 'A10.0 P06 tiene historial canonico (10 -> 11)');
END $$;

-- ============================================================================
-- A10 · UPDATE de un movimiento -> rechazo (API y tambien postgres)
-- ============================================================================
DO $$
DECLARE v text; mov uuid := current_setting('g2c3a3.mov_p06')::uuid; h text := pg_temp.huella();
BEGIN
  v := pg_temp.como('OWN', format('UPDATE public.inventory_movements SET quantity = 77 WHERE id = %L', mov));
  RAISE NOTICE '   A10 owner UPDATE movimiento -> %', v;
  PERFORM pg_temp.assert(v LIKE '42501%', 'A10.1 owner UPDATE de un movimiento -> 42501');
  v := pg_temp.como('SAL', format('UPDATE public.inventory_movements SET note = %L WHERE id = %L', 'x', mov));
  PERFORM pg_temp.assert(v LIKE '42501%', 'A10.2 sales UPDATE de la nota -> 42501');
  -- Defensa append-only: ni el dueño de la tabla reescribe historia.
  v := pg_temp.como_postgres(format('UPDATE public.inventory_movements SET quantity = 77, new_stock = 87 WHERE id = %L', mov));
  RAISE NOTICE '   A10 postgres UPDATE movimiento -> %', v;
  PERFORM pg_temp.assert(v LIKE '42501%INVENTORY_MOVEMENTS_APPEND_ONLY%', 'A10.3 postgres UPDATE de cantidad -> 42501 append-only');
  v := pg_temp.como_postgres(format('UPDATE public.inventory_movements SET note = %L WHERE id = %L', 'reescrita', mov));
  PERFORM pg_temp.assert(v LIKE '42501%INVENTORY_MOVEMENTS_APPEND_ONLY%', 'A10.4 postgres UPDATE de la nota -> 42501 append-only');
  v := pg_temp.como_postgres(format('UPDATE public.inventory_movements SET created_by = %L WHERE id = %L', pg_temp.id('SAL'), mov));
  PERFORM pg_temp.assert(v LIKE '42501%INVENTORY_MOVEMENTS_APPEND_ONLY%', 'A10.5 postgres cambiar el autor (no es SET NULL) -> 42501');
  v := pg_temp.como_postgres(format('UPDATE public.inventory_movements SET note = note WHERE id = %L', mov));
  PERFORM pg_temp.assert(v LIKE '42501%INVENTORY_MOVEMENTS_APPEND_ONLY%', 'A10.6 postgres UPDATE sin cambios -> 42501 (solo pasa el SET NULL referencial)');
  PERFORM pg_temp.assert(pg_temp.huella() = h, 'A10.7 el libro no cambio');
END $$;

-- ============================================================================
-- A11 · DELETE de un movimiento -> rechazo (API y postgres); TRUNCATE tambien
-- ============================================================================
DO $$
DECLARE v text; mov uuid := current_setting('g2c3a3.mov_p06')::uuid; h text := pg_temp.huella();
BEGIN
  v := pg_temp.como('OWN', format('DELETE FROM public.inventory_movements WHERE id = %L', mov));
  RAISE NOTICE '   A11 owner DELETE movimiento -> %', v;
  PERFORM pg_temp.assert(v LIKE '42501%', 'A11.1 owner DELETE de un movimiento -> 42501');
  v := pg_temp.como_postgres(format('DELETE FROM public.inventory_movements WHERE id = %L', mov));
  RAISE NOTICE '   A11 postgres DELETE movimiento -> %', v;
  PERFORM pg_temp.assert(v LIKE '42501%INVENTORY_MOVEMENTS_APPEND_ONLY%', 'A11.2 postgres DELETE -> 42501 append-only');
  v := pg_temp.como_postgres('TRUNCATE public.inventory_movements');
  PERFORM pg_temp.assert(v LIKE '42501%INVENTORY_MOVEMENTS_APPEND_ONLY%', 'A11.3 postgres TRUNCATE -> 42501 append-only');
  PERFORM pg_temp.assert(pg_temp.huella() = h AND pg_temp.movs('P06') = 1, 'A11.4 el libro no cambio');
END $$;

-- ============================================================================
-- A12 · writers canonicos siguen insertando: A1 (A7) + documental W1 (checkout)
-- ============================================================================
DO $$
DECLARE r jsonb; v_comp uuid; m record; v_biz uuid := pg_temp.id('A'); v_p08 uuid := pg_temp.id('P08');
        v_cust uuid := pg_temp.id('CUST'); v_own uuid := pg_temp.id('OWN');
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_own::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  r := public.create_comprobante_checkout_atomic(v_biz, 'G2C3A3-W1', 'h-g2c3a3-w1',
    jsonb_build_object('tipo', 'remito', 'punto_venta', '0001', 'condicion_fiscal', 'Consumidor Final',
      'customer_id', v_cust, 'cc_total', 0, 'emitir_en_arca', false,
      'items', jsonb_build_array(jsonb_build_object('inventory_id', v_p08, 'descripcion', 'Sobreventa A3',
        'tipo_linea', 'producto', 'cantidad', 5, 'precio_unitario', 1000)),
      'pagos', jsonb_build_array(jsonb_build_object('amount', 5000, 'amount_ars', 5000, 'payment_method', 'efectivo'))));
  RESET ROLE;
  RAISE NOTICE '   A12 checkout -> %', left(r::text, 160);
  v_comp := (r ->> 'comprobante_id')::uuid;
  PERFORM pg_temp.assert(r ->> 'status' = 'created' AND v_comp IS NOT NULL, 'A12.1 el checkout canonico (W1) sigue funcionando');
  SELECT * INTO m FROM public.inventory_movements WHERE reference_id = v_comp AND inventory_item_id = v_p08;
  PERFORM pg_temp.assert(FOUND AND m.movement_type = 'sale' AND m.quantity = -5 AND m.previous_stock = 2 AND m.new_stock = -3,
    'A12.2 W1 inserto su movimiento: sale -5, 2 -> -3');
  PERFORM pg_temp.assert(pg_temp.stock('P08') = -3 AND pg_temp.alias('P08') = -3,
    'A12.3 sobreventa por W1: stock -3 (negativo permitido para writers canonicos)');
END $$;

-- ============================================================================
-- A13 · DELETE en duro de un producto CON historial -> FK (23503)
-- ============================================================================
DO $$
DECLARE v text; h text := pg_temp.huella();
BEGIN
  v := pg_temp.como('OWN', format('DELETE FROM public.inventory WHERE id = %L', pg_temp.id('P06')));
  RAISE NOTICE '   A13 owner DELETE producto con historial -> %', v;
  PERFORM pg_temp.assert(v LIKE '23503%', 'A13.1 owner (can_manage) borra en duro un producto con movimientos -> 23503');
  v := pg_temp.como_postgres(format('DELETE FROM public.inventory WHERE id = %L', pg_temp.id('P06')));
  PERFORM pg_temp.assert(v LIKE '23503%', 'A13.2 ni postgres: la FK es RESTRICT (' || left(v, 50) || ')');
  PERFORM pg_temp.assert(EXISTS (SELECT 1 FROM public.inventory WHERE id = pg_temp.id('P06')) AND pg_temp.movs('P06') = 1
                     AND pg_temp.huella() = h, 'A13.3 el producto y su historial siguen ahi');
  -- Ni por el camino indirecto: borrar el PADRE cascadea a la variante con historial.
  PERFORM pg_temp.ajuste('OWN', 'A', pg_temp.d('P17', 2), 'manual', 'a3-a13-variante');
  v := pg_temp.como('OWN', format('DELETE FROM public.inventory WHERE id = %L', pg_temp.id('P16')));
  PERFORM pg_temp.assert(v LIKE '23503%' AND pg_temp.movs('P17') = 1,
    'A13.4 borrar el padre (CASCADE a la variante con historial) -> 23503, historial intacto');
  -- Un producto SIN movimientos se sigue borrando en duro (rollback de alta de A2).
  v := pg_temp.como('OWN', format('DELETE FROM public.inventory WHERE id = %L', pg_temp.id('P10')));
  PERFORM pg_temp.assert(v = 'OK 1', 'A13.5 producto sin movimientos: DELETE en duro igual que antes (' || v || ')');
  PERFORM pg_temp.assert((SELECT confdeltype FROM pg_constraint WHERE conname = 'inventory_movements_inventory_item_id_fkey') = 'r',
    'A13.6 la FK inventory_movements_inventory_item_id_fkey es ON DELETE RESTRICT');
END $$;

-- ============================================================================
-- A14 · soft-delete (is_active = false) -> exito, historial intacto
-- ============================================================================
DO $$
DECLARE v text; r jsonb;
BEGIN
  r := pg_temp.ajuste('OWN', 'A', pg_temp.d('P09', 3), 'manual', 'a3-a14');
  v := pg_temp.como('OWN', format('UPDATE public.inventory SET is_active = false WHERE id = %L AND business_id = %L',
                                  pg_temp.id('P09'), pg_temp.id('A')));
  PERFORM pg_temp.assert(v = 'OK 1', 'A14.1 owner soft-delete de un producto con historial (' || v || ')');
  PERFORM pg_temp.assert((SELECT NOT is_active FROM public.inventory WHERE id = pg_temp.id('P09'))
                     AND pg_temp.stock('P09') = 13 AND pg_temp.movs('P09') = 1,
    'A14.2 inactivo, saldo 13 y su movimiento intactos');
  v := pg_temp.como('SAL', format('UPDATE public.inventory SET is_active = false WHERE id = %L', pg_temp.id('P06')));
  PERFORM pg_temp.assert(v = 'OK 1' AND pg_temp.movs('P06') = 1, 'A14.3 sales (capability inventory) tambien da de baja logica');
END $$;

-- ============================================================================
-- A15 · aislamiento de tenant intacto
-- ============================================================================
DO $$
DECLARE v text; r jsonb; h text := pg_temp.huella();
BEGIN
  v := pg_temp.como('OWN', format('UPDATE public.inventory SET name = %L WHERE id = %L', 'robado', pg_temp.id('XB')));
  PERFORM pg_temp.assert(v = 'OK 0', 'A15.1 owner A no edita metadata de B (0 filas por RLS)');
  v := pg_temp.como('OWN', format('UPDATE public.inventory SET stock_quantity = 0 WHERE id = %L', pg_temp.id('XB')));
  PERFORM pg_temp.assert(v LIKE '42501%', 'A15.2 ni el saldo de B (42501)');
  v := pg_temp.como('OWN', format(
    'INSERT INTO public.inventory(business_id, name, code, category, cost_price, sale_price) VALUES (%L, %L, %L, %L, 0, 1)',
    pg_temp.id('B'), 'Intruso', 'G2C3A3-INTRUSO', 'Rep'));
  PERFORM pg_temp.assert(v LIKE '42501%', 'A15.3 owner A no inserta en B (RLS WITH CHECK -> 42501)');
  r := pg_temp.ajuste('OWN', 'A', jsonb_build_array(jsonb_build_object('inventory_id', pg_temp.id('XB'), 'delta', 5)), 'manual', 'a3-a15');
  PERFORM pg_temp.assert(r ->> 'error' LIKE '42501%', 'A15.4 A1 con un producto de B -> 42501');
  r := pg_temp.ajuste('OWN', 'B', pg_temp.d('P01', 5), 'manual', 'a3-a15-b');
  PERFORM pg_temp.assert(r ->> 'error' LIKE '42501%', 'A15.5 A1 con p_business_id = B -> 42501');
  v := pg_temp.como('OWN', format('SELECT 1 FROM public.inventory_movements WHERE business_id = %L', pg_temp.id('C')));
  PERFORM pg_temp.assert(v = 'OK 0', 'A15.6 owner A no lee movimientos de otro negocio');
  PERFORM pg_temp.assert(pg_temp.stock('XB') = 40 AND (SELECT name FROM public.inventory WHERE id = pg_temp.id('XB')) = 'Ajeno'
                     AND pg_temp.huella() = h, 'A15.7 B intacto');
END $$;

-- ============================================================================
-- A16 · actor SIN inventory (tech): A1 rechaza igual que antes
-- ============================================================================
DO $$
DECLARE v text; r jsonb; h text := pg_temp.huella();
BEGIN
  r := pg_temp.ajuste('TEC', 'A', pg_temp.d('P11', 5), 'manual', 'a3-a16');
  RAISE NOTICE '   A16 tech A1 -> %', r::text;
  PERFORM pg_temp.assert(r ->> 'error' LIKE '42501%FORBIDDEN%', 'A16.1 tech (sin inventory) -> A1 42501 FORBIDDEN');
  v := pg_temp.como('TEC', format('UPDATE public.inventory SET stock_quantity = 99 WHERE id = %L', pg_temp.id('P11')));
  PERFORM pg_temp.assert(v LIKE '42501%', 'A16.2 tech UPDATE directo de stock -> 42501');
  v := pg_temp.como('TEC', format('UPDATE public.inventory SET name = %L WHERE id = %L', 'tech', pg_temp.id('P11')));
  PERFORM pg_temp.assert(v = 'OK 0', 'A16.3 tech metadata -> 0 filas (policy inventory_update, sin cambios)');
  PERFORM pg_temp.assert(pg_temp.stock('P11') = 10 AND pg_temp.huella() = h, 'A16.4 nada cambio');
END $$;

-- ============================================================================
-- A17 · SEC-08B intacto: costo oculto, guard de costo vigente, sin SELECT nuevo
-- ============================================================================
DO $$
DECLARE v text;
BEGIN
  PERFORM pg_temp.assert(NOT has_column_privilege('authenticated', 'public.inventory', 'cost_price', 'SELECT')
                     AND NOT has_column_privilege('anon', 'public.inventory', 'cost_price', 'SELECT')
                     AND NOT has_column_privilege('authenticated', 'public.inventory', 'cost_price_usd', 'SELECT')
                     AND NOT has_column_privilege('authenticated', 'public.inventory_movements', 'unit_cost', 'SELECT'),
    'A17.1 la API sigue sin SELECT de cost_price / cost_price_usd / unit_cost');
  v := pg_temp.como('SAL', format('SELECT cost_price FROM public.inventory WHERE id = %L', pg_temp.id('P15')));
  PERFORM pg_temp.assert(v LIKE '42501%', 'A17.2 sales SELECT cost_price -> 42501');
  v := pg_temp.como('SAL', format('SELECT 1 FROM public.v_inventory_costs WHERE inventory_id = %L', pg_temp.id('P15')));
  PERFORM pg_temp.assert(v = 'OK 0', 'A17.3 sales no ve el costo por la vista autorizada (' || v || ')');
  v := pg_temp.como('OWN', format('SELECT 1 FROM public.v_inventory_costs WHERE inventory_id = %L', pg_temp.id('P15')));
  PERFORM pg_temp.assert(v = 'OK 1', 'A17.4 owner si (' || v || ')');
  -- Escritura de costo: el guard de SEC-08B sigue decidiendo (A3 conserva INSERT/UPDATE de cost_price).
  v := pg_temp.como('SAL', format('UPDATE public.inventory SET cost_price = 1 WHERE id = %L', pg_temp.id('P15')));
  PERFORM pg_temp.assert(v = 'OK 1' AND (SELECT cost_price FROM public.inventory WHERE id = pg_temp.id('P15')) = 600,
    'A17.5 sales UPDATE cost_price: la sentencia pasa y el guard conserva 600');
  v := pg_temp.como('SAL', format(
    'INSERT INTO public.inventory(business_id, name, code, category, cost_price, cost_price_usd, sale_price) VALUES (%L, %L, %L, %L, 999999, 888, 1)',
    pg_temp.id('A'), 'Costo malicioso', 'G2C3A3-COSTO', 'Rep'));
  PERFORM pg_temp.assert(v = 'OK 1' AND (SELECT cost_price = 0 AND cost_price_usd = 0 FROM public.inventory WHERE code = 'G2C3A3-COSTO'),
    'A17.6 sales INSERT con costo arbitrario -> almacenado 0 (SEC-08B Fase C)');
  v := pg_temp.como('OWN', format('UPDATE public.inventory SET cost_price = 700 WHERE id = %L', pg_temp.id('P15')));
  PERFORM pg_temp.assert(v = 'OK 1' AND (SELECT cost_price FROM public.inventory WHERE id = pg_temp.id('P15')) = 700,
    'A17.7 owner (inventory_view_costs) sigue fijando el costo');
END $$;

-- ============================================================================
-- A18 · alias stock = stock_quantity sigue sincronizado
-- ============================================================================
DO $$
DECLARE r jsonb;
BEGIN
  r := pg_temp.ajuste('OWN', 'A', jsonb_build_array(jsonb_build_object('inventory_id', pg_temp.id('P12'), 'target', 42)), 'manual', 'a3-a18');
  PERFORM pg_temp.assert(pg_temp.stock('P12') = 42 AND pg_temp.alias('P12') = 42, 'A18.1 A1 target 42: stock_quantity = stock = 42');
  PERFORM pg_temp.assert((SELECT count(*) FROM public.inventory WHERE business_id = pg_temp.id('A') AND stock IS DISTINCT FROM stock_quantity) = 0,
    'A18.2 ningun producto de A quedo con el alias divergente (A1, W1, altas de metadata)');
  -- El trigger de alias sigue reaccionando a los writers canonicos (UPDATE OF stock_quantity como postgres).
  PERFORM pg_temp.como_postgres(format('UPDATE public.inventory SET stock_quantity = 43 WHERE id = %L', pg_temp.id('P12')));
  PERFORM pg_temp.assert(pg_temp.alias('P12') = 43, 'A18.3 trg_sync_inventory_stock sigue activo (43/43)');
END $$;

-- ============================================================================
-- ANON · la API sin sesion tampoco escribe
-- ============================================================================
DO $$
DECLARE v text; h text := pg_temp.huella();
BEGIN
  v := pg_temp.como_rol('anon', NULL, format('UPDATE public.inventory SET stock_quantity = 1 WHERE id = %L', pg_temp.id('P13')));
  RAISE NOTICE '   AN anon UPDATE stock -> %', v;
  PERFORM pg_temp.assert(v LIKE '42501%', 'AN.1 anon UPDATE stock -> 42501');
  v := pg_temp.como_rol('anon', NULL, format('UPDATE public.inventory SET name = %L WHERE id = %L', 'anon', pg_temp.id('P13')));
  PERFORM pg_temp.assert(v LIKE '42501%', 'AN.2 anon UPDATE metadata -> 42501 (ya no tiene UPDATE)');
  v := pg_temp.como_rol('anon', NULL, format(
    'INSERT INTO public.inventory(business_id, name, code, category, cost_price, sale_price) VALUES (%L, %L, %L, %L, 0, 1)',
    pg_temp.id('A'), 'anon', 'G2C3A3-ANON', 'Rep'));
  PERFORM pg_temp.assert(v LIKE '42501%', 'AN.3 anon INSERT -> 42501');
  v := pg_temp.como_rol('anon', NULL, format(
    'INSERT INTO public.inventory_movements(business_id, inventory_item_id, movement_type, quantity, previous_stock, new_stock) VALUES (%L, %L, %L, 1, 0, 1)',
    pg_temp.id('A'), pg_temp.id('P13'), 'in'));
  PERFORM pg_temp.assert(v LIKE '42501%', 'AN.4 anon INSERT movimiento -> 42501');
  PERFORM pg_temp.assert(pg_temp.huella() = h, 'AN.5 nada cambio');
END $$;

-- ============================================================================
-- R · acciones referenciales que el append-only respeta
-- ============================================================================
DO $$
DECLARE v text;
BEGIN
  -- Borrar un proveedor (suppliersService lo hace en duro): ON DELETE SET NULL
  -- de inventory_movements.supplier_id corre como postgres y solo desprende la
  -- referencia; cantidad, saldos, tipo y producto no cambian.
  v := pg_temp.como('OWN', format('DELETE FROM public.suppliers WHERE id = %L', pg_temp.id('PROV')));
  PERFORM pg_temp.assert(v = 'OK 1', 'R.1 owner borra un proveedor con movimientos (' || v || ')');
  PERFORM pg_temp.assert((SELECT supplier_id IS NULL AND created_by = pg_temp.id('OWN') AND quantity = 10 AND previous_stock = 0
                                 AND new_stock = 10 AND movement_type = 'purchase' AND inventory_item_id = pg_temp.id('P18')
                            FROM public.inventory_movements WHERE id = pg_temp.id('MOVP')),
    'R.2 el movimiento solo perdio supplier_id (SET NULL); el resto intacto');
  -- Purge del tenant (postgres): el CASCADE del negocio se lleva inventario y libro.
  v := pg_temp.como_postgres(format('DELETE FROM public.businesses WHERE id = %L', pg_temp.id('C')));
  PERFORM pg_temp.assert(v = 'OK 1', 'R.3 purge del tenant con historial sigue posible (' || v || ')');
  PERFORM pg_temp.assert(NOT EXISTS (SELECT 1 FROM public.inventory_movements WHERE id = pg_temp.id('MOVC'))
                     AND NOT EXISTS (SELECT 1 FROM public.inventory WHERE id = pg_temp.id('XC')),
    'R.4 el purge borro el inventario y el libro del tenant (y nada mas)');
END $$;

-- ============================================================================
-- D · DEFENSA EN PROFUNDIDAD: un GRANT futuro reabre las tablas -> los guards
--     siguen cerrando el saldo y el libro. (Se revierte al savepoint.)
-- ============================================================================
SAVEPOINT drift;
GRANT INSERT, UPDATE ON TABLE public.inventory TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.inventory_movements TO authenticated;
CREATE POLICY g2c3a3_drift_all ON public.inventory_movements FOR ALL TO authenticated USING (true) WITH CHECK (true);
DO $$
DECLARE v text; h text := pg_temp.huella(); mov uuid := current_setting('g2c3a3.mov_p06')::uuid;
BEGIN
  PERFORM pg_temp.assert(has_table_privilege('authenticated', 'public.inventory', 'UPDATE'), 'D.0 el GRANT de tabla reabrio el UPDATE (simulacion)');
  v := pg_temp.como('SAL', format('UPDATE public.inventory SET stock_quantity = 9999 WHERE id = %L', pg_temp.id('P13')));
  RAISE NOTICE '   D.1 -> %', v;
  PERFORM pg_temp.assert(v LIKE '42501%INVENTORY_STOCK_DIRECT_WRITE_FORBIDDEN%', 'D.1 con GRANT de tabla, el guard rechaza el UPDATE de saldo');
  v := pg_temp.como('OWN', format('UPDATE public.inventory SET stock = 1 WHERE id = %L', pg_temp.id('P13')));
  PERFORM pg_temp.assert(v LIKE '42501%INVENTORY_STOCK_DIRECT_WRITE_FORBIDDEN%', 'D.2 y el del alias');
  v := pg_temp.como('OWN', format(
    'INSERT INTO public.inventory(business_id, name, code, category, cost_price, sale_price, stock_quantity) VALUES (%L, %L, %L, %L, 0, 1, 50)',
    pg_temp.id('A'), 'drift', 'G2C3A3-DRIFT-50', 'Rep'));
  PERFORM pg_temp.assert(v LIKE '42501%INVENTORY_STOCK_DIRECT_WRITE_FORBIDDEN%', 'D.3 y el INSERT con saldo 50');
  v := pg_temp.como('OWN', format(
    'INSERT INTO public.inventory(business_id, name, code, category, cost_price, sale_price, stock_quantity, stock) VALUES (%L, %L, %L, %L, 0, 1, 0, 0)',
    pg_temp.id('A'), 'drift 0', 'G2C3A3-DRIFT-0', 'Rep'));
  PERFORM pg_temp.assert(v = 'OK 1', 'D.4 el guard deja pasar un alta en 0 (metadata)');
  v := pg_temp.como('OWN', format('UPDATE public.inventory SET stock_quantity = stock_quantity, name = %L WHERE id = %L', 'drift', pg_temp.id('P13')));
  PERFORM pg_temp.assert(v = 'OK 1', 'D.5 el guard deja pasar metadata con el saldo sin cambios');
  v := pg_temp.como('OWN', format(
    'INSERT INTO public.inventory_movements(business_id, inventory_item_id, movement_type, quantity, previous_stock, new_stock) VALUES (%L, %L, %L, 5, 10, 15)',
    pg_temp.id('A'), pg_temp.id('P13'), 'in'));
  PERFORM pg_temp.assert(v LIKE '42501%INVENTORY_MOVEMENTS_DIRECT_WRITE_FORBIDDEN%', 'D.6 con GRANT + policy, el INSERT de un movimiento sigue rechazado');
  v := pg_temp.como('OWN', format('UPDATE public.inventory_movements SET quantity = 77 WHERE id = %L', mov));
  PERFORM pg_temp.assert(v LIKE '42501%INVENTORY_MOVEMENTS_APPEND_ONLY%', 'D.7 y el UPDATE');
  v := pg_temp.como('OWN', format('UPDATE public.inventory_movements SET created_by = NULL WHERE id = %L', mov));
  PERFORM pg_temp.assert(v LIKE '42501%INVENTORY_MOVEMENTS_APPEND_ONLY%', 'D.8 y hasta el "SET NULL" hecho a mano por la API (no es contexto canonico)');
  v := pg_temp.como('OWN', format('DELETE FROM public.inventory_movements WHERE id = %L', mov));
  PERFORM pg_temp.assert(v LIKE '42501%INVENTORY_MOVEMENTS_APPEND_ONLY%', 'D.9 y el DELETE');
  PERFORM pg_temp.assert(pg_temp.stock('P13') = 10 AND pg_temp.movs('P13') = 0, 'D.10 saldo y libro de P13 intactos');
END $$;
ROLLBACK TO SAVEPOINT drift;

-- ============================================================================
-- Cierre · W1-W7 y A1 no cambiaron; A1 sigue EXECUTE solo authenticated.
-- ============================================================================
DO $$
BEGIN
  PERFORM pg_temp.assert(has_function_privilege('authenticated', 'public.apply_inventory_stock_adjustments_atomic(uuid,jsonb,text,text,text)', 'EXECUTE')
                     AND NOT has_function_privilege('anon', 'public.apply_inventory_stock_adjustments_atomic(uuid,jsonb,text,text,text)', 'EXECUTE')
                     AND NOT has_function_privilege('service_role', 'public.apply_inventory_stock_adjustments_atomic(uuid,jsonb,text,text,text)', 'EXECUTE'),
    'Z.1 A1: EXECUTE solo authenticated');
  PERFORM pg_temp.assert((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                           WHERE n.nspname IN ('public', 'private') AND p.prokind = 'f'
                             AND p.prosrc ~* 'update\s+(public\.)?inventory\y[^;]*\yset\y[^;]*\ystock(_quantity)?\y\s*=') = 8,
    'Z.2 siguen siendo 8 writers de stock (W1-W7 + A1); A3 no agrega ninguno');
  PERFORM pg_temp.assert(NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.inventory'::regclass AND c.contype = 'c'
                                        AND pg_get_constraintdef(c.oid) ~* '\ystock'),
    'Z.3 sin CHECK stock >= 0');
  PERFORM pg_temp.assert(NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.product_variants'::regclass
                                        AND t.tgname ~* 'g2c3a3|stock_authority|append_only'),
    'Z.4 product_variants fuera de alcance');
END $$;

ROLLBACK;
