-- ============================================================================
-- G2-C.2 · Matriz de UNA sesion (contrato estructural de los locks de stock).
--
-- La concurrencia real (dos conexiones) la prueba
-- scripts/inventory/g2c2-concurrency-local.mjs. Esta matriz prueba lo que se
-- puede probar sin carrera:
--
--   · el helper: ACL, fail-closed sin tenant, conteo por negocio;
--   · W7: cross-tenant cerrado, identidad inmutable en UPDATE, cantidad legitima,
--     DELETE y ON DELETE CASCADE de la orden;
--   · W4/W5/W6: siguen funcionando igual (duplicados, tombstone, reparacion,
--     productos ajenos contados como no encontrados);
--   · el catalogo: todo writer de stock bloquea antes de leer.
--
-- Invariantes G2-C sobre cada movimiento: new_stock - previous_stock = quantity,
-- stock negativo permitido, operacion + reversa = stock inicial.
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

-- Ejecuta SQL como `authenticated` (con RLS) y devuelve 'OK' o el SQLSTATE.
CREATE OR REPLACE FUNCTION pg_temp.como(p_uid uuid, p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_state text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
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

-- Igual pero devolviendo el jsonb de una RPC.
CREATE OR REPLACE FUNCTION pg_temp.rpc(p_uid uuid, p_sql text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  EXECUTE p_sql INTO v;
  RESET ROLE;
  RETURN v;
END; $$;

CREATE OR REPLACE FUNCTION pg_temp.stock(p_id uuid) RETURNS int LANGUAGE sql AS
$$ SELECT stock_quantity FROM public.inventory WHERE id = p_id $$;

-- Cadena de movimientos de un producto: existe UN orden con previous(N+1) = new(N)
-- que arranca en el stock inicial y termina en el actual, y cada fila cumple
-- new - previous = quantity. Es el invariante que el lost update rompia.
CREATE OR REPLACE FUNCTION pg_temp.cadena_ok(p_id uuid, p_inicial int)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_n int; v_final int; v_ok boolean;
BEGIN
  SELECT count(*) INTO v_n FROM public.inventory_movements WHERE inventory_item_id = p_id;
  v_final := pg_temp.stock(p_id);
  IF EXISTS (SELECT 1 FROM public.inventory_movements
              WHERE inventory_item_id = p_id AND new_stock - previous_stock <> quantity) THEN
    RETURN false;
  END IF;
  IF v_n = 0 THEN RETURN v_final = p_inicial; END IF;
  WITH RECURSIVE m AS (
    SELECT id, previous_stock, new_stock FROM public.inventory_movements WHERE inventory_item_id = p_id
  ), walk AS (
    SELECT ARRAY[id] AS path, new_stock AS last_new FROM m WHERE previous_stock = p_inicial
    UNION ALL
    SELECT w.path || m.id, m.new_stock FROM walk w
      JOIN m ON m.previous_stock = w.last_new AND NOT m.id = ANY (w.path)
  )
  SELECT EXISTS (SELECT 1 FROM walk WHERE cardinality(path) = v_n AND last_new = v_final) INTO v_ok;
  RETURN v_ok AND v_final = p_inicial + (SELECT sum(quantity) FROM public.inventory_movements WHERE inventory_item_id = p_id);
END; $$;

\set biz   '00000000-0000-0000-0000-00000000c301'
\set biz2  '00000000-0000-0000-0000-00000000c302'
\set OWN   '00000000-0000-0000-0000-00000000c309'
\set OWN2  '00000000-0000-0000-0000-00000000c30a'

-- ── Semilla ─────────────────────────────────────────────────────────────────
SET LOCAL session_replication_role = 'replica';
INSERT INTO auth.users(id) VALUES (:'OWN'), (:'OWN2');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','G2C2',:'OWN'), (:'biz2','G2C2 ajeno',:'OWN2');
INSERT INTO profiles(id,user_id,business_id,role,is_active)
  VALUES (:'OWN',:'OWN',:'biz','owner',true), (:'OWN2',:'OWN2',:'biz2','owner',true);
INSERT INTO customers(id,business_id,name,phone,customer_type) VALUES
  ('00000000-0000-0000-0000-00000000c3c1',:'biz','Cliente G2C2','+540097','minorista'),
  ('00000000-0000-0000-0000-00000000c3c2',:'biz2','Cliente ajeno','+540096','minorista');
INSERT INTO cajas(id,business_id,opened_by,status) VALUES ('00000000-0000-0000-0000-00000000c361',:'biz',:'OWN','abierta');
INSERT INTO suppliers(id,business_id,name) VALUES ('00000000-0000-0000-0000-00000000c3f1',:'biz','Proveedor G2C2');
INSERT INTO orders(id,business_id,customer_id) VALUES
  ('00000000-0000-0000-0000-00000000c3e1',:'biz','00000000-0000-0000-0000-00000000c3c1'),
  ('00000000-0000-0000-0000-00000000c3e3',:'biz','00000000-0000-0000-0000-00000000c3c1'),
  ('00000000-0000-0000-0000-00000000c3e2',:'biz2','00000000-0000-0000-0000-00000000c3c2');
INSERT INTO inventory(id,business_id,name,code,category,stock_quantity,stock,cost_price,sale_price,
                      base_price,base_currency,auto_update_price,exchange_rate_used,is_active)
VALUES
  ('00000000-0000-0000-0000-00000000c3d1',:'biz','P A','G2C2-A','Rep',10,10,600,1000,1000,'ARS',false,1,true),
  ('00000000-0000-0000-0000-00000000c3d2',:'biz','P B','G2C2-B','Rep',10,10,600,1000,1000,'ARS',false,1,true),
  ('00000000-0000-0000-0000-00000000c3d3',:'biz','P C','G2C2-C','Rep',10,10,600,1000,1000,'ARS',false,1,true),
  ('00000000-0000-0000-0000-00000000c3d4',:'biz','P D','G2C2-D','Rep', 1, 1,600,1000,1000,'ARS',false,1,true),
  ('00000000-0000-0000-0000-00000000c3d5',:'biz','P E','G2C2-E','Rep',10,10,600,1000,1000,'ARS',false,1,true),
  ('00000000-0000-0000-0000-00000000c3d6',:'biz','P F','G2C2-F','Rep',10,10,600,1000,1000,'ARS',false,1,true),
  ('00000000-0000-0000-0000-00000000c3d7',:'biz','P G','G2C2-G','Rep',10,10,600,1000,1000,'ARS',false,1,true),
  ('00000000-0000-0000-0000-00000000c3d8',:'biz','P H','G2C2-H','Rep',10,10,600,1000,1000,'ARS',false,1,true),
  ('00000000-0000-0000-0000-00000000c3df',:'biz2','Ajeno','G2C2-X','Rep',7,7,600,1000,1000,'ARS',false,1,true);
SET LOCAL session_replication_role = 'origin';

-- ============================================================================
-- 1 · HELPER private.lock_inventory_rows
-- ============================================================================
DO $$
DECLARE v_h oid := to_regprocedure('private.lock_inventory_rows(uuid,uuid[])'); v_state text; v_ok boolean;
BEGIN
  PERFORM pg_temp.assert(v_h IS NOT NULL, '1.1 existe private.lock_inventory_rows(uuid,uuid[])');
  PERFORM pg_temp.assert(NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_h), '1.2 es SECURITY INVOKER');
  PERFORM pg_temp.assert((SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = v_h) = 'postgres', '1.3 owner postgres');
  PERFORM pg_temp.assert((SELECT proconfig FROM pg_proc WHERE oid = v_h) = ARRAY['search_path=pg_catalog, pg_temp'],
    '1.4 search_path = pg_catalog, pg_temp');
  PERFORM pg_temp.assert(NOT has_function_privilege('anon', v_h, 'EXECUTE'), '1.5 anon sin EXECUTE');
  PERFORM pg_temp.assert(NOT has_function_privilege('authenticated', v_h, 'EXECUTE'), '1.6 authenticated sin EXECUTE');
  PERFORM pg_temp.assert(NOT has_function_privilege('service_role', v_h, 'EXECUTE'), '1.7 service_role sin EXECUTE');
  PERFORM pg_temp.assert((SELECT proacl FROM pg_proc WHERE oid = v_h) IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_h AND a.grantee = 0),
    '1.8 PUBLIC sin EXECUTE (ACL materializada)');

  v_state := pg_temp.como('00000000-0000-0000-0000-00000000c309',
    $q$SELECT private.lock_inventory_rows('00000000-0000-0000-0000-00000000c301', ARRAY['00000000-0000-0000-0000-00000000c3d1']::uuid[])$q$);
  PERFORM pg_temp.assert(v_state LIKE '42501%', '1.9 authenticated NO puede invocarlo (' || v_state || ')');

  BEGIN
    PERFORM private.lock_inventory_rows(NULL, ARRAY['00000000-0000-0000-0000-00000000c3d1']::uuid[]);
    v_ok := false;
  EXCEPTION WHEN invalid_parameter_value THEN v_ok := SQLERRM LIKE 'INVENTORY_LOCK_TENANT_REQUIRED%';
  END;
  PERFORM pg_temp.assert(v_ok, '1.10 business_id NULL -> INVENTORY_LOCK_TENANT_REQUIRED / 22023');

  PERFORM pg_temp.assert(private.lock_inventory_rows('00000000-0000-0000-0000-00000000c301',
    ARRAY['00000000-0000-0000-0000-00000000c3d1','00000000-0000-0000-0000-00000000c3d2']::uuid[]) = 2,
    '1.11 bloquea y cuenta los productos propios (2)');
  PERFORM pg_temp.assert(private.lock_inventory_rows('00000000-0000-0000-0000-00000000c301',
    ARRAY['00000000-0000-0000-0000-00000000c3df']::uuid[]) = 0,
    '1.12 un producto de OTRO negocio no se bloquea ni se cuenta (0)');
  PERFORM pg_temp.assert(private.lock_inventory_rows('00000000-0000-0000-0000-00000000c301',
    ARRAY['00000000-0000-0000-0000-00000000c3d1','00000000-0000-0000-0000-00000000c3df']::uuid[]) = 1,
    '1.13 mezcla propio + ajeno: solo el propio (1)');
  PERFORM pg_temp.assert(private.lock_inventory_rows('00000000-0000-0000-0000-00000000c301',
    ARRAY['00000000-0000-0000-0000-00000000c3d1','00000000-0000-0000-0000-00000000c3d1']::uuid[]) = 1,
    '1.14 ids repetidos se bloquean una vez (1)');
  PERFORM pg_temp.assert(private.lock_inventory_rows('00000000-0000-0000-0000-00000000c301', NULL) = 0,
    '1.15 ids NULL -> 0');
  PERFORM pg_temp.assert(private.lock_inventory_rows('00000000-0000-0000-0000-00000000c301', '{}'::uuid[]) = 0,
    '1.16 ids vacios -> 0');
  PERFORM pg_temp.assert(
    (SELECT prosrc FROM pg_proc WHERE oid = v_h) ~* 'order\s+by\s+i\.id\s+for\s+no\s+key\s+update',
    '1.17 el lock es ORDER BY id FOR NO KEY UPDATE');
END $$;

-- ============================================================================
-- 2 · W7 · CROSS-TENANT CERRADO
-- ============================================================================
DO $$
DECLARE v_state text; v_movs int;
BEGIN
  -- A no puede ni leer el producto de B...
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c309', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM pg_temp.assert((SELECT count(*) FROM inventory WHERE id = '00000000-0000-0000-0000-00000000c3df') = 0,
    '2.1 A no ve el producto de B por RLS');
  RESET ROLE;

  -- ...y ahora tampoco puede moverle el stock desde su propia orden.
  v_state := pg_temp.como('00000000-0000-0000-0000-00000000c309', $q$
    INSERT INTO order_items(order_id,business_id,tipo,descripcion,product_id,cantidad,precio_unitario)
    VALUES ('00000000-0000-0000-0000-00000000c3e1','00000000-0000-0000-0000-00000000c301','repuesto','cross-tenant',
            '00000000-0000-0000-0000-00000000c3df',3,1000)$q$);
  PERFORM pg_temp.assert(v_state LIKE '42501%INVENTORY_NOT_FOUND_OR_TENANT_MISMATCH%',
    '2.2 order_item con product_id de OTRO negocio -> 42501 (' || v_state || ')');
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-00000000c3df') = 7, '2.3 stock de B intacto (7)');
  SELECT count(*) INTO v_movs FROM inventory_movements WHERE inventory_item_id = '00000000-0000-0000-0000-00000000c3df';
  PERFORM pg_temp.assert(v_movs = 0, '2.4 cero inventory_movements sobre el producto de B');
  PERFORM pg_temp.assert((SELECT count(*) FROM inventory_movements WHERE business_id = '00000000-0000-0000-0000-00000000c301'
    AND inventory_item_id = '00000000-0000-0000-0000-00000000c3df') = 0, '2.5 nada filtra el stock de B como movimiento de A');
  PERFORM pg_temp.assert((SELECT count(*) FROM order_items WHERE descripcion = 'cross-tenant') = 0,
    '2.6 el order_item cross-tenant no quedo insertado');

  -- Item propio colgado de la orden de OTRO negocio: tambien fail-closed.
  v_state := pg_temp.como('00000000-0000-0000-0000-00000000c309', $q$
    INSERT INTO order_items(order_id,business_id,tipo,descripcion,product_id,cantidad,precio_unitario)
    VALUES ('00000000-0000-0000-0000-00000000c3e2','00000000-0000-0000-0000-00000000c301','repuesto','orden ajena',
            '00000000-0000-0000-0000-00000000c3d1',1,1000)$q$);
  PERFORM pg_temp.assert(v_state LIKE '42501%INVENTORY_NOT_FOUND_OR_TENANT_MISMATCH%',
    '2.7 repuesto propio sobre la orden de OTRO negocio -> 42501 (' || v_state || ')');
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-00000000c3d1') = 10, '2.8 stock propio intacto (10)');
END $$;

-- ============================================================================
-- 3 · W7 · INSERT / UPDATE cantidad / DELETE  (aritmetica G2-C intacta)
-- ============================================================================
DO $$
DECLARE v_state text; v_item uuid;
BEGIN
  v_state := pg_temp.como('00000000-0000-0000-0000-00000000c309', $q$
    INSERT INTO order_items(order_id,business_id,tipo,descripcion,product_id,cantidad,precio_unitario)
    VALUES ('00000000-0000-0000-0000-00000000c3e1','00000000-0000-0000-0000-00000000c301','repuesto','item A',
            '00000000-0000-0000-0000-00000000c3d1',2,1000)$q$);
  PERFORM pg_temp.assert(v_state = 'OK', '3.1 INSERT de repuesto propio (' || v_state || ')');
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-00000000c3d1') = 8, '3.2 10 - 2 = 8');
  SELECT id INTO v_item FROM order_items WHERE descripcion = 'item A';

  v_state := pg_temp.como('00000000-0000-0000-0000-00000000c309',
    format('UPDATE order_items SET cantidad = 5 WHERE id = %L', v_item));
  PERFORM pg_temp.assert(v_state = 'OK', '3.3 UPDATE de cantidad legitimo (' || v_state || ')');
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-00000000c3d1') = 5, '3.4 subir 2 -> 5 descuenta 3: 8 - 3 = 5');

  v_state := pg_temp.como('00000000-0000-0000-0000-00000000c309',
    format('UPDATE order_items SET cantidad = 1, descripcion = %L WHERE id = %L', 'item A editado', v_item));
  PERFORM pg_temp.assert(v_state = 'OK', '3.5 UPDATE de cantidad + dato no estructural (' || v_state || ')');
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-00000000c3d1') = 9, '3.6 bajar 5 -> 1 devuelve 4: 5 + 4 = 9');

  v_state := pg_temp.como('00000000-0000-0000-0000-00000000c309',
    format('DELETE FROM order_items WHERE id = %L', v_item));
  PERFORM pg_temp.assert(v_state = 'OK', '3.7 DELETE del repuesto (' || v_state || ')');
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-00000000c3d1') = 10, '3.8 reversa exacta: vuelve a 10');
  PERFORM pg_temp.assert(pg_temp.cadena_ok('00000000-0000-0000-0000-00000000c3d1', 10),
    '3.9 cadena continua e invariante por fila en P A');
  PERFORM pg_temp.assert((SELECT sum(quantity) FROM inventory_movements
    WHERE inventory_item_id = '00000000-0000-0000-0000-00000000c3d1') = 0, '3.10 suma neta de la operacion + reversa = 0');
END $$;

-- ============================================================================
-- 4 · W7 · IDENTIDAD DE STOCK INMUTABLE EN UPDATE  (0A000)
-- ============================================================================
DO $$
DECLARE v_state text; v_item uuid; v_serv uuid; v_movs int;
BEGIN
  PERFORM pg_temp.como('00000000-0000-0000-0000-00000000c309', $q$
    INSERT INTO order_items(order_id,business_id,tipo,descripcion,product_id,cantidad,precio_unitario)
    VALUES ('00000000-0000-0000-0000-00000000c3e1','00000000-0000-0000-0000-00000000c301','repuesto','item B',
            '00000000-0000-0000-0000-00000000c3d2',2,1000),
           ('00000000-0000-0000-0000-00000000c3e1','00000000-0000-0000-0000-00000000c301','servicio','servicio X',
            NULL,1,500)$q$);
  SELECT id INTO v_item FROM order_items WHERE descripcion = 'item B';
  SELECT id INTO v_serv FROM order_items WHERE descripcion = 'servicio X';
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-00000000c3d2') = 8, '4.0 item B descuenta: 10 - 2 = 8');
  SELECT count(*) INTO v_movs FROM inventory_movements
   WHERE inventory_item_id IN ('00000000-0000-0000-0000-00000000c3d2','00000000-0000-0000-0000-00000000c3d3');

  v_state := pg_temp.como('00000000-0000-0000-0000-00000000c309',
    format('UPDATE order_items SET product_id = %L WHERE id = %L', '00000000-0000-0000-0000-00000000c3d3', v_item));
  PERFORM pg_temp.assert(v_state LIKE '0A000%ORDER_ITEM_STOCK_IDENTITY_IMMUTABLE%', '4.1 cambiar product_id -> 0A000 (' || v_state || ')');

  v_state := pg_temp.como('00000000-0000-0000-0000-00000000c309',
    format('UPDATE order_items SET tipo = %L WHERE id = %L', 'servicio', v_item));
  PERFORM pg_temp.assert(v_state LIKE '0A000%', '4.2 cambiar tipo repuesto -> servicio -> 0A000 (' || v_state || ')');

  v_state := pg_temp.como('00000000-0000-0000-0000-00000000c309',
    format('UPDATE order_items SET order_id = %L WHERE id = %L', '00000000-0000-0000-0000-00000000c3e3', v_item));
  PERFORM pg_temp.assert(v_state LIKE '0A000%', '4.3 cambiar order_id -> 0A000 (' || v_state || ')');

  -- business_id: como postgres (la RLS de A ni siquiera deja escribir otro negocio).
  BEGIN
    UPDATE order_items SET business_id = '00000000-0000-0000-0000-00000000c302' WHERE id = v_item;
    v_state := 'OK';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE || ' ' || SQLERRM;
  END;
  PERFORM pg_temp.assert(v_state LIKE '0A000%', '4.4 cambiar business_id (aun como postgres) -> 0A000 (' || v_state || ')');

  v_state := pg_temp.como('00000000-0000-0000-0000-00000000c309',
    format('UPDATE order_items SET product_id = %L, tipo = %L WHERE id = %L',
           '00000000-0000-0000-0000-00000000c3d3', 'repuesto', v_serv));
  PERFORM pg_temp.assert(v_state LIKE '0A000%', '4.5 convertir un servicio en repuesto -> 0A000 (' || v_state || ')');

  v_state := pg_temp.como('00000000-0000-0000-0000-00000000c309',
    format('UPDATE order_items SET product_id = NULL WHERE id = %L', v_item));
  PERFORM pg_temp.assert(v_state LIKE '0A000%', '4.6 soltar el product_id (-> NULL) -> 0A000 (' || v_state || ')');

  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-00000000c3d2') = 8, '4.7 stock de B intacto tras los rechazos (8)');
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-00000000c3d3') = 10, '4.8 stock de C intacto tras los rechazos (10)');
  PERFORM pg_temp.assert((SELECT count(*) FROM inventory_movements
    WHERE inventory_item_id IN ('00000000-0000-0000-0000-00000000c3d2','00000000-0000-0000-0000-00000000c3d3')) = v_movs,
    '4.9 ningun rechazo dejo movimientos');
  PERFORM pg_temp.assert((SELECT product_id FROM order_items WHERE id = v_item) = '00000000-0000-0000-0000-00000000c3d2',
    '4.10 el item conserva su producto');

  -- Consecuencia documentada: el SET NULL de la FK al borrar EN DURO un producto
  -- usado en una orden es un UPDATE de product_id -> tambien 0A000.
  BEGIN
    DELETE FROM inventory WHERE id = '00000000-0000-0000-0000-00000000c3d2';
    v_state := 'OK';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE || ' ' || SQLERRM;
  END;
  PERFORM pg_temp.assert(v_state LIKE '0A000%',
    '4.11 borrar en duro un producto usado en una orden falla (0A000) en vez de perder la referencia (' || left(v_state, 60) || ')');
  PERFORM pg_temp.assert(EXISTS (SELECT 1 FROM inventory WHERE id = '00000000-0000-0000-0000-00000000c3d2'),
    '4.12 el producto sigue existiendo');

  -- Un producto NO usado en ordenes se sigue pudiendo borrar en duro
  -- (rollback de productService al fallar un alta).
  BEGIN
    DELETE FROM inventory WHERE id = '00000000-0000-0000-0000-00000000c3d8';
    v_state := 'OK';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE || ' ' || SQLERRM;
  END;
  PERFORM pg_temp.assert(v_state = 'OK', '4.13 un producto sin ordenes se borra en duro igual que antes (' || v_state || ')');
END $$;

-- ============================================================================
-- 5 · W7 · DELETE multi-fila y ON DELETE CASCADE de la orden
-- ============================================================================
DO $$
DECLARE v_state text;
BEGIN
  v_state := pg_temp.como('00000000-0000-0000-0000-00000000c309', $q$
    INSERT INTO order_items(order_id,business_id,tipo,descripcion,product_id,cantidad,precio_unitario)
    VALUES ('00000000-0000-0000-0000-00000000c3e3','00000000-0000-0000-0000-00000000c301','repuesto','cascada C',
            '00000000-0000-0000-0000-00000000c3d3',3,1000),
           ('00000000-0000-0000-0000-00000000c3e3','00000000-0000-0000-0000-00000000c301','repuesto','cascada E',
            '00000000-0000-0000-0000-00000000c3d5',4,1000),
           ('00000000-0000-0000-0000-00000000c3e3','00000000-0000-0000-0000-00000000c301','repuesto','cascada C bis',
            '00000000-0000-0000-0000-00000000c3d3',1,1000)$q$);
  PERFORM pg_temp.assert(v_state = 'OK', '5.1 INSERT multi-fila de 3 repuestos (' || v_state || ')');
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-00000000c3d3') = 6, '5.2 C: 10 - 3 - 1 = 6');
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-00000000c3d5') = 6, '5.3 E: 10 - 4 = 6');

  -- Borrar la ORDEN: ON DELETE CASCADE dispara el trigger una vez por item.
  v_state := pg_temp.como('00000000-0000-0000-0000-00000000c309',
    $q$DELETE FROM orders WHERE id = '00000000-0000-0000-0000-00000000c3e3'$q$);
  PERFORM pg_temp.assert(v_state = 'OK', '5.3b el DELETE de la orden no falla (' || v_state || ')');
  IF EXISTS (SELECT 1 FROM orders WHERE id = '00000000-0000-0000-0000-00000000c3e3') THEN
    -- La RLS de orders puede filtrar el DELETE del owner (0 filas, sin error): lo
    -- que se prueba aca es la cascada sobre el trigger, no la policy de orders.
    RAISE NOTICE '   (la RLS de orders filtro el DELETE del owner; se borra como postgres)';
    DELETE FROM orders WHERE id = '00000000-0000-0000-0000-00000000c3e3';
  END IF;
  PERFORM pg_temp.assert(NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = '00000000-0000-0000-0000-00000000c3e3'),
    '5.4 la cascada borro los 3 items');
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-00000000c3d3') = 10, '5.5 C vuelve a 10 por la cascada');
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-00000000c3d5') = 10, '5.6 E vuelve a 10 por la cascada');
  PERFORM pg_temp.assert(pg_temp.cadena_ok('00000000-0000-0000-0000-00000000c3d3', 10), '5.7 cadena continua en C');
  PERFORM pg_temp.assert(pg_temp.cadena_ok('00000000-0000-0000-0000-00000000c3d5', 10), '5.8 cadena continua en E');
END $$;

-- ============================================================================
-- 6 · STOCK NEGATIVO PERMITIDO (G2-C)
-- ============================================================================
DO $$
DECLARE v_state text;
BEGIN
  v_state := pg_temp.como('00000000-0000-0000-0000-00000000c309', $q$
    INSERT INTO order_items(order_id,business_id,tipo,descripcion,product_id,cantidad,precio_unitario)
    VALUES ('00000000-0000-0000-0000-00000000c3e1','00000000-0000-0000-0000-00000000c301','repuesto','neg 1',
            '00000000-0000-0000-0000-00000000c3d4',2,1000)$q$);
  PERFORM pg_temp.assert(v_state = 'OK', '6.1 sobreventa permitida (' || v_state || ')');
  v_state := pg_temp.como('00000000-0000-0000-0000-00000000c309', $q$
    INSERT INTO order_items(order_id,business_id,tipo,descripcion,product_id,cantidad,precio_unitario)
    VALUES ('00000000-0000-0000-0000-00000000c3e1','00000000-0000-0000-0000-00000000c301','repuesto','neg 2',
            '00000000-0000-0000-0000-00000000c3d4',3,1000)$q$);
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-00000000c3d4') = -4, '6.2 stock 1: -2 -3 = -4 (sin clamp)');
  PERFORM pg_temp.assert(pg_temp.cadena_ok('00000000-0000-0000-0000-00000000c3d4', 1), '6.3 cadena continua en negativo');
END $$;

-- ============================================================================
-- 7 · W4 · COMPRA (duplicados, producto ajeno, idempotencia) — mismas respuestas
-- ============================================================================
DO $$
DECLARE r jsonb; r2 jsonb;
BEGIN
  r := pg_temp.rpc('00000000-0000-0000-0000-00000000c309', $q$
    SELECT create_supplier_purchase_atomic('00000000-0000-0000-0000-00000000c301','00000000-0000-0000-0000-00000000c3f1',
      '00000000-0000-0000-0000-00000000c309','Proveedor G2C2',current_date,'FC-G2C2-1',3000,0,NULL,'G2C2',
      jsonb_build_array(
        jsonb_build_object('inventory_id','00000000-0000-0000-0000-00000000c3d5','product_name','P E','quantity',2,'unit_cost',600),
        jsonb_build_object('inventory_id','00000000-0000-0000-0000-00000000c3d6','product_name','P F','quantity',1,'unit_cost',600),
        jsonb_build_object('inventory_id','00000000-0000-0000-0000-00000000c3d5','product_name','P E bis','quantity',2,'unit_cost',600)),
      'g2c2-compra-1')$q$);
  PERFORM pg_temp.assert(COALESCE((r->>'ok')::boolean,false), '7.1 compra multi-item con duplicado corre (' || r::text || ')');
  PERFORM set_config('g2c2.compra1', r->>'purchase_id', true);
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-00000000c3d5') = 14, '7.2 duplicado procesado como antes: E 10 + 2 + 2 = 14');
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-00000000c3d6') = 11, '7.3 F 10 + 1 = 11');
  PERFORM pg_temp.assert((SELECT count(*) FROM inventory_movements WHERE reference_id = (r->>'purchase_id')::uuid
    AND inventory_item_id = '00000000-0000-0000-0000-00000000c3d5') = 2, '7.4 dos movimientos para la linea duplicada');
  PERFORM pg_temp.assert(pg_temp.cadena_ok('00000000-0000-0000-0000-00000000c3d5', 10), '7.5 cadena continua en E (incluye la cascada previa)');

  r2 := pg_temp.rpc('00000000-0000-0000-0000-00000000c309', $q$
    SELECT create_supplier_purchase_atomic('00000000-0000-0000-0000-00000000c301','00000000-0000-0000-0000-00000000c3f1',
      '00000000-0000-0000-0000-00000000c309','Proveedor G2C2',current_date,'FC-G2C2-1',3000,0,NULL,'G2C2',
      jsonb_build_array(
        jsonb_build_object('inventory_id','00000000-0000-0000-0000-00000000c3d5','product_name','P E','quantity',2,'unit_cost',600),
        jsonb_build_object('inventory_id','00000000-0000-0000-0000-00000000c3d6','product_name','P F','quantity',1,'unit_cost',600),
        jsonb_build_object('inventory_id','00000000-0000-0000-0000-00000000c3d5','product_name','P E bis','quantity',2,'unit_cost',600)),
      'g2c2-compra-1')$q$);
  PERFORM pg_temp.assert(COALESCE((r2->>'replay')::boolean,false) AND r2->>'purchase_id' = r->>'purchase_id',
    '7.6 misma key + mismo payload = replay de la misma compra');
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-00000000c3d5') = 14, '7.7 el replay no vuelve a sumar stock');

  r := pg_temp.rpc('00000000-0000-0000-0000-00000000c309', $q$
    SELECT create_supplier_purchase_atomic('00000000-0000-0000-0000-00000000c301','00000000-0000-0000-0000-00000000c3f1',
      '00000000-0000-0000-0000-00000000c309','Proveedor G2C2',current_date,'FC-G2C2-X',600,0,NULL,'G2C2',
      jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-00000000c3df','product_name','Ajeno','quantity',1,'unit_cost',600)),
      'g2c2-compra-ajena')$q$);
  PERFORM pg_temp.assert(r->>'error_code' = 'PRODUCT_NOT_FOUND', '7.8 producto de otro negocio -> PRODUCT_NOT_FOUND (respuesta de siempre)');
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-00000000c3df') = 7, '7.9 stock ajeno intacto');
END $$;

-- ============================================================================
-- 8 · W5 · BORRAR COMPRA (reversa exacta, tombstone) — mismas respuestas
-- ============================================================================
DO $$
DECLARE d jsonb; v_pid uuid := current_setting('g2c2.compra1')::uuid;
BEGIN
  d := pg_temp.rpc('00000000-0000-0000-0000-00000000c309',
    format('SELECT delete_supplier_purchase_safe(%L, %L, %L)', '00000000-0000-0000-0000-00000000c301', v_pid,
           '00000000-0000-0000-0000-00000000c309'));
  PERFORM pg_temp.assert(COALESCE((d->>'ok')::boolean,false) AND NOT COALESCE((d->>'replay')::boolean,false),
    '8.1 borrar la compra corre (' || d::text || ')');
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-00000000c3d5') = 10, '8.2 reversa exacta: E 14 - 2 - 2 = 10');
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-00000000c3d6') = 10, '8.3 reversa exacta: F 11 - 1 = 10');
  PERFORM pg_temp.assert(pg_temp.cadena_ok('00000000-0000-0000-0000-00000000c3d5', 10), '8.4 cadena continua en E');
  PERFORM pg_temp.assert(pg_temp.cadena_ok('00000000-0000-0000-0000-00000000c3d6', 10), '8.5 cadena continua en F');

  d := pg_temp.rpc('00000000-0000-0000-0000-00000000c309',
    format('SELECT delete_supplier_purchase_safe(%L, %L, %L)', '00000000-0000-0000-0000-00000000c301', v_pid,
           '00000000-0000-0000-0000-00000000c309'));
  PERFORM pg_temp.assert(COALESCE((d->>'replay')::boolean,false) AND d->>'error_code' = 'ALREADY_DELETED',
    '8.6 segundo borrado = replay por tombstone (ALREADY_DELETED)');
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-00000000c3d5') = 10, '8.7 el replay no vuelve a restar');
END $$;

-- ============================================================================
-- 9 · W6 · REPARACION — misma semantica
-- ============================================================================
DO $$
DECLARE r jsonb; v_comp uuid; rep jsonb;
BEGIN
  r := pg_temp.rpc('00000000-0000-0000-0000-00000000c309', $q$
    SELECT create_comprobante_checkout_atomic('00000000-0000-0000-0000-00000000c301','G2C2-REP','hrep',
      jsonb_build_object('tipo','remito','punto_venta','0001','condicion_fiscal','Consumidor Final',
        'customer_id','00000000-0000-0000-0000-00000000c3c1','cc_total',0,'emitir_en_arca',false,
        'items', jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-00000000c3d7',
          'descripcion','rep','tipo_linea','producto','cantidad',2,'precio_unitario',1000)),
        'pagos', jsonb_build_array(jsonb_build_object('amount',2000,'amount_ars',2000,'payment_method','efectivo'))))$q$);
  v_comp := (r->>'comprobante_id')::uuid;
  PERFORM pg_temp.assert(v_comp IS NOT NULL, '9.0 venta de fixture creada (' || r::text || ')');

  -- Hueco historico: venta registrada, stock nunca movido. Mas una linea ajena
  -- (producto de otro negocio) que la reparacion debe contar como no encontrada.
  SET LOCAL session_replication_role = 'replica';
  UPDATE comprobante_items SET stock_processed = false, stock_processed_at = NULL, stock_movement_id = NULL
   WHERE comprobante_id = v_comp;
  DELETE FROM inventory_movements WHERE reference_id = v_comp;
  UPDATE inventory SET stock_quantity = 10, stock = 10 WHERE id = '00000000-0000-0000-0000-00000000c3d7';
  INSERT INTO comprobante_items(comprobante_id,business_id,descripcion,tipo_linea,cantidad,precio_unitario,subtotal,inventory_id)
  VALUES (v_comp,'00000000-0000-0000-0000-00000000c301','linea ajena','producto',1,1000,1000,'00000000-0000-0000-0000-00000000c3df');
  SET LOCAL session_replication_role = 'origin';

  rep := pg_temp.rpc('00000000-0000-0000-0000-00000000c309',
    $q$SELECT repair_missing_stock_movements('00000000-0000-0000-0000-00000000c301', false)$q$);
  PERFORM pg_temp.assert((rep->>'comprobantes_procesados')::int = 1, '9.1 procesa la linea pendiente (' || rep::text || ')');
  PERFORM pg_temp.assert((rep->>'items_producto_no_encontrado')::int = 1, '9.2 la linea con producto ajeno sigue contando como no encontrada');
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-00000000c3d7') = 8, '9.3 G: 10 - 2 = 8');
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-00000000c3df') = 7, '9.4 el producto ajeno no se toca');
  PERFORM pg_temp.assert(pg_temp.cadena_ok('00000000-0000-0000-0000-00000000c3d7', 10), '9.5 cadena continua en G');

  rep := pg_temp.rpc('00000000-0000-0000-0000-00000000c309',
    $q$SELECT repair_missing_stock_movements('00000000-0000-0000-0000-00000000c301', false)$q$);
  PERFORM pg_temp.assert((rep->>'comprobantes_procesados')::int = 0, '9.6 segunda reparacion: 0 procesados (idempotente)');
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-00000000c3d7') = 8, '9.7 sin doble impacto');
END $$;

-- ============================================================================
-- 10 · CATALOGO · todo writer de stock bloquea antes de leer
-- ============================================================================
DO $$
DECLARE s record; v_n int := 0;
BEGIN
  FOR s IN
    SELECT p.oid::regprocedure::text AS firma, p.prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('public','private') AND p.prokind = 'f'
       AND p.prosrc ~* 'update\s+(public\.)?inventory\y[^;]*\yset\y[^;]*\ystock(_quantity)?\y\s*='
  LOOP
    v_n := v_n + 1;
    PERFORM pg_temp.assert(position('private.lock_inventory_rows(' IN s.prosrc) > 0
      OR s.prosrc ~* 'order\s+by\s+(i\.)?id\s+for\s+no\s+key\s+update',
      '10.x ' || s.firma || ' bloquea inventario antes de escribir stock (FOR NO KEY UPDATE)');
    PERFORM pg_temp.assert(s.prosrc !~* 'from\s+(public\.)?inventory\y[^;]*\yfor\s+update\y',
      '10.y ' || s.firma || ' no bloquea inventory con FOR UPDATE (G2-C.2R)');
  END LOOP;
  PERFORM pg_temp.assert(v_n = 7, '10.1 hay exactamente 7 writers de stock server-side (' || v_n || ')');

  PERFORM pg_temp.assert(
    (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.adjust_stock_on_order_item()'))
      !~* 'where\s+id\s*=\s*(new|old)\.product_id\s*;',
    '10.2 W7 ya no accede a inventory solo por id');
  FOR s IN SELECT unnest(ARRAY[
      'private.create_supplier_purchase_atomic(uuid,uuid,uuid,text,date,text,numeric,numeric,text,text,jsonb,text)',
      'public.delete_supplier_purchase_safe(uuid,uuid,uuid)',
      'public.repair_missing_stock_movements(uuid,boolean)',
      'public.adjust_stock_on_order_item()']) AS firma LOOP
    PERFORM pg_temp.assert(position('private.lock_inventory_rows(' IN
      (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(s.firma))) > 0, '10.3 ' || s.firma || ' usa el helper');
    PERFORM pg_temp.assert((SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(s.firma)),
      '10.4 ' || s.firma || ' sigue SECURITY DEFINER');
  END LOOP;
  PERFORM pg_temp.assert(EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.order_items'::regclass AND tgname = 'trg_adjust_stock_on_order_item'
       AND tgenabled = 'O' AND tgfoid = to_regprocedure('public.adjust_stock_on_order_item()')),
    '10.5 trg_adjust_stock_on_order_item ligado y ENABLED');
  PERFORM pg_temp.assert(EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.comprobante_items'::regclass
       AND tgname = 'trg_comprobante_items_immutability'), '10.6 G2-B intacto (inmutabilidad de comprobante_items)');
  PERFORM pg_temp.assert(NOT has_function_privilege('authenticated',
    to_regprocedure('private.create_supplier_purchase_atomic(uuid,uuid,uuid,text,date,text,numeric,numeric,text,text,jsonb,text)'), 'EXECUTE'),
    '10.7 el impl privado de la compra sigue sin EXECUTE para authenticated');
  PERFORM pg_temp.assert(has_function_privilege('authenticated',
    to_regprocedure('public.delete_supplier_purchase_safe(uuid,uuid,uuid)'), 'EXECUTE')
    AND NOT has_function_privilege('anon', to_regprocedure('public.delete_supplier_purchase_safe(uuid,uuid,uuid)'), 'EXECUTE'),
    '10.8 ACL de delete_supplier_purchase_safe intacta');
END $$;

-- ============================================================================
-- 11 · G2-C.2R · UN solo modo de lock de stock (FOR NO KEY UPDATE)
-- ============================================================================
-- Checkout, compra rapida y anulacion bloqueaban inventory FOR UPDATE: el unico
-- modo que choca con el FOR KEY SHARE que toma un INSERT que referencia el
-- producto (deadlock 3/3 contra el alta mayorista). Ahora comparten el contrato
-- del helper. La compatibilidad con KEY SHARE se prueba con dos conexiones en
-- scripts/inventory/g2c2-concurrency-local.mjs (escenarios K, WS y FK).
DO $$
DECLARE s record; v_src text; v_nk int; v_fu int;
BEGIN
  FOR s IN SELECT * FROM (VALUES
      ('private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)',                                         2, 0),
      ('private.create_quick_inventory_purchase_atomic(uuid,text,uuid,text,text,date,text,numeric,numeric,jsonb)', 2, 0),
      ('private.sec08e_annul_comprobante_impl(uuid,text,text,boolean,text)',                                       1, 3)
    ) AS e(firma, no_key, for_update)
  LOOP
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure(s.firma);
    v_nk := array_length(regexp_split_to_array(v_src, 'FOR NO KEY UPDATE'), 1) - 1;
    v_fu := array_length(regexp_split_to_array(v_src, 'FOR UPDATE'), 1) - 1;
    PERFORM pg_temp.assert(v_src !~* 'from\s+(public\.)?inventory\y[^;]*\yfor\s+update\y',
      '11.1 ' || s.firma || ': ningun lock de inventory es FOR UPDATE');
    PERFORM pg_temp.assert(v_src ~* 'from\s+(public\.)?inventory\y[^;]*order\s+by\s+id\s+for\s+no\s+key\s+update',
      '11.2 ' || s.firma || ': pre-lock de inventory ORDER BY id FOR NO KEY UPDATE');
    PERFORM pg_temp.assert(v_nk = s.no_key,
      '11.3 ' || s.firma || ': ' || v_nk || ' FOR NO KEY UPDATE (esperado ' || s.no_key || ')');
    PERFORM pg_temp.assert(v_fu = s.for_update,
      '11.4 ' || s.firma || ': ' || v_fu || ' FOR UPDATE de otras tablas conservados (esperado ' || s.for_update || ')');
    PERFORM pg_temp.assert((SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(s.firma)),
      '11.5 ' || s.firma || ': sigue SECURITY DEFINER');
    PERFORM pg_temp.assert(NOT has_function_privilege('authenticated', to_regprocedure(s.firma), 'EXECUTE'),
      '11.6 ' || s.firma || ': sigue sin EXECUTE para authenticated (se entra por el wrapper)');
  END LOOP;
  -- La anulacion conserva FOR UPDATE justo donde no es inventory.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure('private.sec08e_annul_comprobante_impl(uuid,text,text,boolean,text)');
  PERFORM pg_temp.assert(v_src ~* 'from\s+comprobantes\s+where\s+id\s*=\s*p_comprobante_id\s+for\s+update',
    '11.7 la anulacion sigue bloqueando el comprobante FOR UPDATE');
  PERFORM pg_temp.assert(v_src ~* 'from\s+comprobante_payments[^;]*order\s+by\s+id\s+for\s+update'
    AND v_src ~* 'from\s+account_movements[^;]*order\s+by\s+id\s+for\s+update',
    '11.8 la anulacion sigue bloqueando pagos y cuenta corriente FOR UPDATE');
  PERFORM pg_temp.assert(
    (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('private.lock_inventory_rows(uuid,uuid[])'))
      !~* '\yfor\s+update\y',
    '11.9 el helper no usa FOR UPDATE (mismo contrato que W1-W3)');
  PERFORM pg_temp.assert(
    (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)'))
      ~* 'from\s+inventory\s+where\s+id\s*=\s*\(v_item->>''inventory_id''\)::uuid\s+and\s+business_id\s*=\s*p_business_id\s+for\s+no\s+key\s+update',
    '11.10 el checkout relee el stock por linea con FOR NO KEY UPDATE (sin upgrade a FOR UPDATE)');
  -- G2-C.1 no se toca: el alta mayorista sigue bloqueando al CLIENTE (su tabla).
  PERFORM pg_temp.assert(
    (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.create_wholesale_order_atomic(text,jsonb,text)'))
      ~* 'from\s+public\.wholesale_customers\s+wc[^;]*for\s+update',
    '11.11 G2-C.1 intacto: el alta mayorista sigue bloqueando su cliente');
END $$;

DO $$ BEGIN RAISE NOTICE 'G2-C.2 matriz de una sesion: OK'; END $$;
ROLLBACK;
