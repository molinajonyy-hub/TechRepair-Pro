-- ============================================================================
-- G2-C · Regresion del P0 de stock asimetrico.
--
-- El bug: la SALIDA de stock clampaba a cero y la REVERSA era aritmetica, asi
-- que una venta con sobreventa seguida de su anulacion FABRICABA unidades:
--
--   stock 2, venta 5  ->  GREATEST(2-5, 0) = 0
--   reversa +5        ->  0 + 5            = 5     (el fisico era 2)
--
-- Contrato de producto: la sobreventa esta PERMITIDA y el stock puede quedar
-- NEGATIVO. La aritmetica manda:
--
--   new_stock - previous_stock == quantity        (por movimiento)
--   operacion + su reversa exacta => stock_final == stock_inicial
--
-- Esta matriz NO se conforma con mirar inventory.stock_quantity: el clamp
-- tambien dejaba la PROPIA FILA del movimiento internamente inconsistente
-- (quantity=-5 con previous=2/new=0), y eso solo se ve leyendo movimientos.
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

-- Ejecuta SQL como `authenticated` y devuelve SQLSTATE o 'OK'.
CREATE OR REPLACE FUNCTION pg_temp.como_authenticated(p_uid uuid, p_sql text)
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

-- Invariante por movimiento. Es EL contrato de G2-C.
CREATE OR REPLACE FUNCTION pg_temp.assert_movimiento(
  p_mov_id uuid, p_prev int, p_qty int, p_new int, p_label text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE m record;
BEGIN
  SELECT previous_stock, quantity, new_stock INTO m
    FROM inventory_movements WHERE id = p_mov_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: % (no existe el movimiento)', p_label; END IF;
  PERFORM pg_temp.assert(m.previous_stock = p_prev,
    p_label || ' · previous_stock=' || m.previous_stock || ' (esperado ' || p_prev || ')');
  PERFORM pg_temp.assert(m.quantity = p_qty,
    p_label || ' · quantity=' || m.quantity || ' (esperado ' || p_qty || ')');
  PERFORM pg_temp.assert(m.new_stock = p_new,
    p_label || ' · new_stock=' || m.new_stock || ' (esperado ' || p_new || ')');
  PERFORM pg_temp.assert(m.new_stock - m.previous_stock = m.quantity,
    p_label || ' · INVARIANTE new_stock - previous_stock = quantity');
END; $$;

\set biz   '00000000-0000-0000-0000-00000000c201'
\set biz2  '00000000-0000-0000-0000-00000000c202'
\set OWN   '00000000-0000-0000-0000-00000000c209'
\set OWN2  '00000000-0000-0000-0000-00000000c20a'
\set CUST  '00000000-0000-0000-0000-00000000c2c1'
\set CAJA  '00000000-0000-0000-0000-00000000c261'
\set INVA  '00000000-0000-0000-0000-00000000c2d1'
\set INVB  '00000000-0000-0000-0000-00000000c2d2'
\set INVC  '00000000-0000-0000-0000-00000000c2d3'
\set INVD  '00000000-0000-0000-0000-00000000c2d4'
\set INVE  '00000000-0000-0000-0000-00000000c2d5'
\set INVF  '00000000-0000-0000-0000-00000000c2d6'
\set INVG  '00000000-0000-0000-0000-00000000c2d7'
\set INVH  '00000000-0000-0000-0000-00000000c2d8'
\set INVI  '00000000-0000-0000-0000-00000000c2d9'
\set INVJ  '00000000-0000-0000-0000-00000000c2da'
\set INVX  '00000000-0000-0000-0000-00000000c2df'
\set ORD   '00000000-0000-0000-0000-00000000c2e1'
\set PROV  '00000000-0000-0000-0000-00000000c2f1'
\set PROV2 '00000000-0000-0000-0000-00000000c2f2'

-- ── Semilla ─────────────────────────────────────────────────────────────────
SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'OWN'), (:'OWN2');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','G2C',:'OWN'), (:'biz2','G2C ajeno',:'OWN2');
INSERT INTO profiles(id,business_id,role,is_active)
  VALUES (:'OWN',:'biz','owner',true), (:'OWN2',:'biz2','owner',true);
INSERT INTO customers(id,business_id,name,phone,customer_type)
  VALUES (:'CUST',:'biz','Cliente G2C','+540098','minorista');
INSERT INTO cajas(id,business_id,opened_by,status) VALUES (:'CAJA',:'biz',:'OWN','abierta');

-- A: stock 2 (sobreventa). B: 10 (suficiente). C: 5 (exacto).
-- D: 2 (orden). E/F: multi-item. G: 2 (reparacion historica).
INSERT INTO inventory(id,business_id,name,code,category,stock_quantity,stock,cost_price,sale_price,
                      base_price,base_currency,auto_update_price,exchange_rate_used,is_active)
VALUES
  (:'INVA',:'biz','Prod A','G2C-A','Rep', 2, 2,600,1000,1000,'ARS',false,1,true),
  (:'INVB',:'biz','Prod B','G2C-B','Rep',10,10,600,1000,1000,'ARS',false,1,true),
  (:'INVC',:'biz','Prod C','G2C-C','Rep', 5, 5,600,1000,1000,'ARS',false,1,true),
  (:'INVD',:'biz','Prod D','G2C-D','Rep', 2, 2,600,1000,1000,'ARS',false,1,true),
  (:'INVE',:'biz','Prod E','G2C-E','Rep', 2, 2,600,1000,1000,'ARS',false,1,true),
  (:'INVF',:'biz','Prod F','G2C-F','Rep',100,100,300,500,500,'ARS',false,1,true),
  (:'INVG',:'biz','Prod G','G2C-G','Rep', 2, 2,600,1000,1000,'ARS',false,1,true),
  -- H: 0 (compra con deficit). I: 5 (compra sin deficit). J: 3 (compra pagada).
  (:'INVH',:'biz','Prod H','G2C-H','Rep', 0, 0,600,1000,1000,'ARS',false,1,true),
  (:'INVI',:'biz','Prod I','G2C-I','Rep', 5, 5,600,1000,1000,'ARS',false,1,true),
  (:'INVJ',:'biz','Prod J','G2C-J','Rep', 3, 3,600,1000,1000,'ARS',false,1,true),
  (:'INVX',:'biz2','Prod ajeno','G2C-X','Rep',7,7,600,1000,1000,'ARS',false,1,true);
INSERT INTO suppliers(id, business_id, name)
  VALUES (:'PROV',:'biz','Proveedor G2C'), (:'PROV2',:'biz2','Proveedor ajeno');
SET LOCAL session_replication_role='origin';

-- ============================================================================
-- CASO A · VENTA CON SOBREVENTA  (stock 2, vender 5 -> -3)
-- ============================================================================
DO $$
DECLARE r jsonb; v_comp uuid; v_mov uuid; v_stock int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000c209', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-00000000c201'::uuid,'G2C-A','hg2ca',
    jsonb_build_object('tipo','remito','punto_venta','0001','condicion_fiscal','Consumidor Final',
      'customer_id','00000000-0000-0000-0000-00000000c2c1','cc_total',0,'emitir_en_arca',false,
      'items', jsonb_build_array(jsonb_build_object(
        'inventory_id','00000000-0000-0000-0000-00000000c2d1','descripcion','Sobreventa',
        'tipo_linea','producto','cantidad',5,'precio_unitario',1000)),
      'pagos', jsonb_build_array(jsonb_build_object(
        'amount',5000,'amount_ars',5000,'payment_method','efectivo'))));
  RESET ROLE;
  v_comp := (r->>'comprobante_id')::uuid;
  PERFORM pg_temp.assert(r->>'status' = 'created', 'A · la venta con sobreventa NO se bloquea');
  PERFORM set_config('g2c.compA', v_comp::text, true);

  -- 3. sobreventa: 2 - 5 = -3
  SELECT stock_quantity INTO v_stock FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2d1';
  PERFORM pg_temp.assert(v_stock = -3, 'A · 3. sobreventa 2 - 5 = -3 (obtenido ' || v_stock || ')');

  -- El alias `stock` acompana al canonico, tambien en negativo.
  PERFORM pg_temp.assert(
    (SELECT stock FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2d1') = -3,
    'A · el alias `stock` tambien queda en -3');

  -- 5. invariante del movimiento de SALIDA
  SELECT id INTO v_mov FROM inventory_movements
   WHERE reference_id = v_comp AND inventory_item_id='00000000-0000-0000-0000-00000000c2d1'
     AND movement_type='sale';
  PERFORM set_config('g2c.movA', v_mov::text, true);
  PERFORM pg_temp.assert_movimiento(v_mov, 2, -5, -3, 'A · 5. movimiento de salida');
END $$;

-- ============================================================================
-- CASO A (cont.) · REVERSA EXACTA  (-3 + 5 = 2)
-- ============================================================================
DO $$
DECLARE a jsonb; v_comp uuid := current_setting('g2c.compA')::uuid; v_mov uuid; v_stock int; v_suma int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000c209', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  a := annul_comprobante_atomic(v_comp, 'refund_current_session', 'G2C reversa', true, 'ANLG2CA');
  RESET ROLE;
  PERFORM pg_temp.assert(COALESCE(a->>'ok','false')::boolean,
    'A · la anulacion canonica corre (error=' || COALESCE(a->>'error','-') || ')');

  -- 4. reversa de sobreventa: -3 + 5 = 2
  SELECT stock_quantity INTO v_stock FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2d1';
  PERFORM pg_temp.assert(v_stock = 2, 'A · 4. reversa -3 + 5 = 2 (obtenido ' || v_stock || ')');

  -- 7. venta + reversa => stock_final == stock_inicial
  PERFORM pg_temp.assert(v_stock = 2, 'A · 7. stock_final == stock_inicial (2)');

  -- 6. invariante del movimiento de REVERSA
  SELECT id INTO v_mov FROM inventory_movements
   WHERE reference_id = v_comp AND inventory_item_id='00000000-0000-0000-0000-00000000c2d1'
     AND movement_type='return';
  PERFORM pg_temp.assert_movimiento(v_mov, -3, 5, 2, 'A · 6. movimiento de reversa');

  -- 8. suma neta de la operacion + su reversa = 0
  SELECT SUM(quantity) INTO v_suma FROM inventory_movements
   WHERE reference_id = v_comp AND inventory_item_id='00000000-0000-0000-0000-00000000c2d1';
  PERFORM pg_temp.assert(v_suma = 0, 'A · 8. suma neta de movimientos = 0 (obtenido ' || v_suma || ')');
END $$;

-- ============================================================================
-- 9 · DOBLE REVERSA / RETRY  ·  no restaura stock dos veces
-- ============================================================================
DO $$
DECLARE a jsonb; v_comp uuid := current_setting('g2c.compA')::uuid;
        v_antes int; v_despues int; v_movs_antes int; v_movs_despues int;
BEGIN
  SELECT stock_quantity INTO v_antes FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2d1';
  SELECT count(*) INTO v_movs_antes FROM inventory_movements
    WHERE reference_id = v_comp AND movement_type='return';

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000c209', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    a := annul_comprobante_atomic(v_comp, 'refund_current_session', 'G2C doble', true, 'ANLG2CA2');
  EXCEPTION WHEN OTHERS THEN
    a := jsonb_build_object('ok', false, 'error', SQLERRM);
  END;
  RESET ROLE;

  SELECT stock_quantity INTO v_despues FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2d1';
  SELECT count(*) INTO v_movs_despues FROM inventory_movements
    WHERE reference_id = v_comp AND movement_type='return';

  RAISE NOTICE '   2da anulacion -> ok=% error=%', COALESCE(a->>'ok','?'), COALESCE(a->>'error','-');
  PERFORM pg_temp.assert(v_despues = v_antes,
    '9 · la 2da reversa NO restaura de nuevo (antes ' || v_antes || ', despues ' || v_despues || ')');
  PERFORM pg_temp.assert(v_movs_despues = v_movs_antes,
    '9 · la 2da reversa NO crea otro movimiento de devolucion');
END $$;

-- ============================================================================
-- 1 y 2 · stock SUFICIENTE (10-3=7) y stock EXACTO (5-5=0)
-- ============================================================================
DO $$
DECLARE r jsonb; v_mov uuid; v_stock int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000c209', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-00000000c201'::uuid,'G2C-B','hg2cb',
    jsonb_build_object('tipo','remito','punto_venta','0001','condicion_fiscal','Consumidor Final',
      'customer_id','00000000-0000-0000-0000-00000000c2c1','cc_total',0,'emitir_en_arca',false,
      'items', jsonb_build_array(
        jsonb_build_object('inventory_id','00000000-0000-0000-0000-00000000c2d2','descripcion','Suficiente',
          'tipo_linea','producto','cantidad',3,'precio_unitario',1000),
        jsonb_build_object('inventory_id','00000000-0000-0000-0000-00000000c2d3','descripcion','Exacto',
          'tipo_linea','producto','cantidad',5,'precio_unitario',1000)),
      'pagos', jsonb_build_array(jsonb_build_object(
        'amount',8000,'amount_ars',8000,'payment_method','efectivo'))));
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status' = 'created', '1/2 · venta creada');

  SELECT stock_quantity INTO v_stock FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2d2';
  PERFORM pg_temp.assert(v_stock = 7, '1 · stock suficiente 10 - 3 = 7 (obtenido ' || v_stock || ')');
  SELECT id INTO v_mov FROM inventory_movements
   WHERE reference_id=(r->>'comprobante_id')::uuid AND inventory_item_id='00000000-0000-0000-0000-00000000c2d2';
  PERFORM pg_temp.assert_movimiento(v_mov, 10, -3, 7, '1 · movimiento con stock suficiente');

  SELECT stock_quantity INTO v_stock FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2d3';
  PERFORM pg_temp.assert(v_stock = 0, '2 · stock exacto 5 - 5 = 0 (obtenido ' || v_stock || ')');
  SELECT id INTO v_mov FROM inventory_movements
   WHERE reference_id=(r->>'comprobante_id')::uuid AND inventory_item_id='00000000-0000-0000-0000-00000000c2d3';
  PERFORM pg_temp.assert_movimiento(v_mov, 5, -5, 0, '2 · movimiento con stock exacto');
END $$;

-- ============================================================================
-- 10, 11, 12 · multi-item independiente · linea sin inventory_id · marcadores
-- ============================================================================
DO $$
DECLARE r jsonb; v_comp uuid; v_stockE int; v_stockF int; v_movs int; v_marcados int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000c209', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-00000000c201'::uuid,'G2C-M','hg2cm',
    jsonb_build_object('tipo','remito','punto_venta','0001','condicion_fiscal','Consumidor Final',
      'customer_id','00000000-0000-0000-0000-00000000c2c1','cc_total',0,'emitir_en_arca',false,
      'items', jsonb_build_array(
        -- sobreventa
        jsonb_build_object('inventory_id','00000000-0000-0000-0000-00000000c2d5','descripcion','E sobreventa',
          'tipo_linea','producto','cantidad',5,'precio_unitario',1000),
        -- stock de sobra
        jsonb_build_object('inventory_id','00000000-0000-0000-0000-00000000c2d6','descripcion','F normal',
          'tipo_linea','producto','cantidad',4,'precio_unitario',500),
        -- SIN inventory_id: es un servicio, no mueve stock
        jsonb_build_object('descripcion','Mano de obra','tipo_linea','servicio',
          'cantidad',1,'precio_unitario',2000)),
      'pagos', jsonb_build_array(jsonb_build_object(
        'amount',9000,'amount_ars',9000,'payment_method','efectivo'))));
  RESET ROLE;
  v_comp := (r->>'comprobante_id')::uuid;
  PERFORM pg_temp.assert(r->>'status' = 'created', '10 · venta multi-item creada');
  PERFORM set_config('g2c.compM', v_comp::text, true);

  -- 10. cada item conserva su aritmetica de forma independiente
  SELECT stock_quantity INTO v_stockE FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2d5';
  SELECT stock_quantity INTO v_stockF FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2d6';
  PERFORM pg_temp.assert(v_stockE = -3, '10 · item con sobreventa: 2 - 5 = -3 (obtenido ' || v_stockE || ')');
  PERFORM pg_temp.assert(v_stockF = 96, '10 · item con stock: 100 - 4 = 96 (obtenido ' || v_stockF || ')');

  -- 11. la linea sin inventory_id no genera movimiento
  SELECT count(*) INTO v_movs FROM inventory_movements WHERE reference_id = v_comp;
  PERFORM pg_temp.assert(v_movs = 2,
    '11 · la linea de servicio (sin inventory_id) NO genera movimiento (movimientos=' || v_movs || ')');

  -- 12. G2-B: el checkout canonico sigue pudiendo marcar stock_processed
  SELECT count(*) INTO v_marcados FROM comprobante_items
   WHERE comprobante_id = v_comp AND stock_processed = true;
  PERFORM pg_temp.assert(v_marcados = 2,
    '12 · G2-B: el checkout marca stock_processed en las 2 lineas con inventario');
  PERFORM pg_temp.assert(
    (SELECT bool_and(stock_movement_id IS NOT NULL) FROM comprobante_items
      WHERE comprobante_id = v_comp AND stock_processed = true),
    '12 · G2-B: cada linea procesada referencia su movimiento');
END $$;

-- ============================================================================
-- 13 · G2-B · la anulacion canonica restaura Y limpia marcadores (multi-item)
-- ============================================================================
DO $$
DECLARE a jsonb; v_comp uuid := current_setting('g2c.compM')::uuid; v_stockE int; v_stockF int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000c209', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  a := annul_comprobante_atomic(v_comp, 'refund_current_session', 'G2C multi', true, 'ANLG2CM');
  RESET ROLE;
  PERFORM pg_temp.assert(COALESCE(a->>'ok','false')::boolean,
    '13 · anulacion multi-item ok (error=' || COALESCE(a->>'error','-') || ')');

  SELECT stock_quantity INTO v_stockE FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2d5';
  SELECT stock_quantity INTO v_stockF FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2d6';
  PERFORM pg_temp.assert(v_stockE = 2,  '13 · multi-item: la linea con sobreventa vuelve a 2');
  PERFORM pg_temp.assert(v_stockF = 100,'13 · multi-item: la linea normal vuelve a 100');

  PERFORM pg_temp.assert(
    NOT COALESCE((SELECT bool_or(stock_processed) FROM comprobante_items WHERE comprobante_id=v_comp), false),
    '13 · G2-B: la anulacion limpia stock_processed');
  PERFORM pg_temp.assert(
    (SELECT SUM(quantity) FROM inventory_movements
      WHERE reference_id=v_comp AND inventory_item_id='00000000-0000-0000-0000-00000000c2d5') = 0,
    '13 · multi-item: suma neta de la linea con sobreventa = 0');
END $$;

-- ============================================================================
-- 16 · REPUESTO DE ORDEN  ·  2 -> -3 -> 2
-- ============================================================================
DO $$
DECLARE v_item uuid; v_mov uuid; v_stock int; v_suma int;
BEGIN
  INSERT INTO orders(id, business_id, customer_id)
    VALUES ('00000000-0000-0000-0000-00000000c2e1','00000000-0000-0000-0000-00000000c201',
            '00000000-0000-0000-0000-00000000c2c1');

  -- Agregar repuesto por 5 sobre stock 2.
  INSERT INTO order_items(order_id, business_id, tipo, descripcion, product_id, cantidad, precio_unitario)
    VALUES ('00000000-0000-0000-0000-00000000c2e1','00000000-0000-0000-0000-00000000c201',
            'repuesto','Repuesto sobreventa','00000000-0000-0000-0000-00000000c2d4', 5, 1000)
    RETURNING id INTO v_item;

  SELECT stock_quantity INTO v_stock FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2d4';
  PERFORM pg_temp.assert(v_stock = -3,
    '16 · repuesto de orden: 2 - 5 = -3 (obtenido ' || v_stock || ')');

  SELECT id INTO v_mov FROM inventory_movements
   WHERE reference_id='00000000-0000-0000-0000-00000000c2e1'
     AND inventory_item_id='00000000-0000-0000-0000-00000000c2d4' AND movement_type='order_usage';
  PERFORM pg_temp.assert_movimiento(v_mov, 2, -5, -3, '16 · movimiento de salida del repuesto');

  -- Quitar exactamente ese repuesto.
  DELETE FROM order_items WHERE id = v_item;

  SELECT stock_quantity INTO v_stock FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2d4';
  PERFORM pg_temp.assert(v_stock = 2,
    '16 · reversa del repuesto: -3 + 5 = 2 (obtenido ' || v_stock || ')');

  SELECT id INTO v_mov FROM inventory_movements
   WHERE reference_id='00000000-0000-0000-0000-00000000c2e1'
     AND inventory_item_id='00000000-0000-0000-0000-00000000c2d4' AND movement_type='return';
  PERFORM pg_temp.assert_movimiento(v_mov, -3, 5, 2, '16 · movimiento de reversa del repuesto');

  SELECT SUM(quantity) INTO v_suma FROM inventory_movements
   WHERE reference_id='00000000-0000-0000-0000-00000000c2e1'
     AND inventory_item_id='00000000-0000-0000-0000-00000000c2d4';
  PERFORM pg_temp.assert(v_suma = 0, '16 · suma neta repuesto + reversa = 0');
END $$;

-- ============================================================================
-- 16b · REPUESTO DE ORDEN · UPDATE de cantidad tambien es aritmetico
-- ============================================================================
DO $$
DECLARE v_item uuid; v_stock int; v_suma int;
BEGIN
  -- stock 2, se agrega 1 (queda 1), despues se sube a 6 (delta 5 -> queda -4)
  INSERT INTO order_items(order_id, business_id, tipo, descripcion, product_id, cantidad, precio_unitario)
    VALUES ('00000000-0000-0000-0000-00000000c2e1','00000000-0000-0000-0000-00000000c201',
            'repuesto','Repuesto ajustable','00000000-0000-0000-0000-00000000c2d4', 1, 1000)
    RETURNING id INTO v_item;
  SELECT stock_quantity INTO v_stock FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2d4';
  PERFORM pg_temp.assert(v_stock = 1, '16b · alta de 1: 2 - 1 = 1 (obtenido ' || v_stock || ')');

  UPDATE order_items SET cantidad = 6 WHERE id = v_item;
  SELECT stock_quantity INTO v_stock FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2d4';
  PERFORM pg_temp.assert(v_stock = -4,
    '16b · subir 1 -> 6 descuenta 5 mas: 1 - 5 = -4 (obtenido ' || v_stock || ')');

  -- Volver exactamente al estado anterior y despues quitarlo.
  UPDATE order_items SET cantidad = 1 WHERE id = v_item;
  SELECT stock_quantity INTO v_stock FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2d4';
  PERFORM pg_temp.assert(v_stock = 1, '16b · bajar 6 -> 1 devuelve 5: -4 + 5 = 1');

  DELETE FROM order_items WHERE id = v_item;
  SELECT stock_quantity INTO v_stock FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2d4';
  PERFORM pg_temp.assert(v_stock = 2, '16b · tras quitarlo, vuelve al stock inicial 2');

  SELECT SUM(quantity) INTO v_suma FROM inventory_movements
   WHERE reference_id='00000000-0000-0000-0000-00000000c2e1'
     AND inventory_item_id='00000000-0000-0000-0000-00000000c2d4';
  PERFORM pg_temp.assert(v_suma = 0, '16b · suma neta de TODO el ciclo de la orden = 0');
END $$;

-- ============================================================================
-- 15 · TENANT · no se puede afectar inventario de otro negocio
-- ============================================================================
DO $$
DECLARE v_res text; v_stock int;
BEGIN
  v_res := pg_temp.como_authenticated('00000000-0000-0000-0000-00000000c209',
    $q$UPDATE inventory SET stock_quantity = 999 WHERE id='00000000-0000-0000-0000-00000000c2df'$q$);
  SELECT stock_quantity INTO v_stock FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2df';
  RAISE NOTICE '   update cross-tenant -> %', v_res;
  PERFORM pg_temp.assert(v_stock = 7,
    '15 · el inventario del otro negocio NO cambia (sigue en ' || v_stock || ')');

  -- Y tampoco vendiendole: el checkout valida ownership del negocio.
  v_res := pg_temp.como_authenticated('00000000-0000-0000-0000-00000000c209',
    $q$SELECT create_comprobante_checkout_atomic('00000000-0000-0000-0000-00000000c202'::uuid,'G2C-X','hg2cx',
         jsonb_build_object('tipo','remito','punto_venta','0001','condicion_fiscal','Consumidor Final',
           'cc_total',0,'emitir_en_arca',false,
           'items', jsonb_build_array(jsonb_build_object(
             'inventory_id','00000000-0000-0000-0000-00000000c2df','descripcion','robo',
             'tipo_linea','producto','cantidad',5,'precio_unitario',1000)),
           'pagos', '[]'::jsonb))$q$);
  RAISE NOTICE '   checkout cross-tenant -> %', v_res;
  SELECT stock_quantity INTO v_stock FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2df';
  PERFORM pg_temp.assert(v_stock = 7,
    '15 · el checkout cross-tenant no movio stock ajeno (sigue en ' || v_stock || ')');
END $$;

-- ============================================================================
-- 17 · repair_missing_stock_movements · contrato explicito ante stock insuficiente
--
-- Decision documentada: NO se cambia. Su resta YA es aritmetica
-- (`v_new_stock := v_prev_stock - cantidad`), y su `p_allow_negative=false` no
-- es un clamp silencioso sino un SKIP deliberado que ademas se REPORTA en
-- `items_sin_stock_suficiente`. Es una herramienta manual conservadora: no
-- fabrica unidades ni rompe el invariante. Se prueban las DOS ramas.
-- ============================================================================
DO $$
DECLARE v_comp uuid := gen_random_uuid(); v_item uuid := gen_random_uuid();
        r jsonb; v_stock int; v_mov uuid;
BEGIN
  -- Venta historica sin movimiento de stock (stock_processed = false).
  SET LOCAL session_replication_role='replica';
  INSERT INTO comprobantes(id, business_id, tipo, numero, punto_venta, fecha, date,
                           subtotal, total, estado, status, estado_comercial, estado_fiscal)
    VALUES (v_comp,'00000000-0000-0000-0000-00000000c201','remito','0001-00009999','0001',now(),now(),
            5000,5000,'emitido','issued','pendiente','no_fiscal');
  INSERT INTO comprobante_items(id, comprobante_id, business_id, descripcion, tipo_linea,
                                cantidad, precio_unitario, subtotal, inventory_id, stock_processed)
    VALUES (v_item, v_comp,'00000000-0000-0000-0000-00000000c201','Historico','producto',
            5,1000,5000,'00000000-0000-0000-0000-00000000c2d7', false);
  SET LOCAL session_replication_role='origin';

  -- Rama conservadora: stock 2 < cantidad 5 y p_allow_negative = false -> SKIP.
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000c209', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  r := repair_missing_stock_movements('00000000-0000-0000-0000-00000000c201'::uuid, false);
  RESET ROLE;
  RAISE NOTICE '   repair(allow_negative=false) -> %', r::text;

  SELECT stock_quantity INTO v_stock FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2d7';
  PERFORM pg_temp.assert(v_stock = 2,
    '17 · p_allow_negative=false NO toca el stock insuficiente (sigue en ' || v_stock || ')');
  PERFORM pg_temp.assert((r->>'items_sin_stock_suficiente')::int >= 1,
    '17 · y lo REPORTA en items_sin_stock_suficiente (no lo esconde)');
  PERFORM pg_temp.assert(
    NOT COALESCE((SELECT stock_processed FROM comprobante_items WHERE id=v_item), false),
    '17 · el item saltado NO queda marcado como procesado');

  -- Rama explicita: con p_allow_negative = true la aritmetica se respeta.
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000c209', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  r := repair_missing_stock_movements('00000000-0000-0000-0000-00000000c201'::uuid, true);
  RESET ROLE;
  RAISE NOTICE '   repair(allow_negative=true) -> %', r::text;

  SELECT stock_quantity INTO v_stock FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2d7';
  PERFORM pg_temp.assert(v_stock = -3,
    '17 · p_allow_negative=true reconstruye la venta: 2 - 5 = -3 (obtenido ' || v_stock || ')');
  SELECT id INTO v_mov FROM inventory_movements
   WHERE reference_id = v_comp AND inventory_item_id='00000000-0000-0000-0000-00000000c2d7';
  PERFORM pg_temp.assert_movimiento(v_mov, 2, -5, -3, '17 · movimiento reconstruido');
END $$;

-- ============================================================================
-- 19 · ELIMINAR UNA COMPRA YA CONSUMIDA  ·  0 -> +5 -> -5 (venta) -> -5 (delete)
--
-- BLOCKER 1 de la revision humana del PR #143. El discovery inicial habia
-- dejado este camino fuera de alcance por ser "reversion de una compra"; era
-- una lectura equivocada. Es el MISMO P0 y es un camino VIVO:
--   src/pages/Suppliers.tsx -> suppliersService.deletePurchaseSafe()
--                           -> rpc('delete_supplier_purchase_safe')
--
-- La secuencia economica completa: compro 5, vendo esas 5, y despues elimino
-- la compra. El stock DEBE quedar en -5: las 5 unidades salieron de verdad,
-- pero ya no hay una compra que las haya traido.
-- ============================================================================
DO $$
DECLARE r jsonb; d jsonb; v_purchase uuid; v_stock int; v_mov uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000c209', true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  -- B. Compra IMPAGA de 5 por el camino canonico: 0 -> 5.
  r := create_supplier_purchase_atomic(
        '00000000-0000-0000-0000-00000000c201'::uuid,
        '00000000-0000-0000-0000-00000000c2f1'::uuid,
        '00000000-0000-0000-0000-00000000c209'::uuid,
        -- paid=0 => compra a deuda; el metodo de pago admite NULL (no hay pago).
        'Proveedor G2C', current_date, 'FC-G2C-1', 3000, 0, NULL, 'G2C',
        jsonb_build_array(jsonb_build_object(
          'inventory_id','00000000-0000-0000-0000-00000000c2d8',
          'product_name','Prod H','quantity',5,'unit_cost',600)),
        'g2c-compra-1');
  RESET ROLE;
  RAISE NOTICE '   compra -> %', COALESCE(r->>'ok', r->>'success', r::text);

  SELECT stock_quantity INTO v_stock FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2d8';
  PERFORM pg_temp.assert(v_stock = 5, '19 · B. la compra de 5 deja el stock en 5 (obtenido ' || v_stock || ')');

  SELECT id INTO v_purchase FROM supplier_purchases
   WHERE business_id='00000000-0000-0000-0000-00000000c201' AND invoice_number='FC-G2C-1';
  PERFORM pg_temp.assert(v_purchase IS NOT NULL, '19 · B. la compra existe');

  -- C. Consumir esas 5 por el camino canonico de venta: 5 -> 0.
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000c209', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-00000000c201'::uuid,'G2C-H','hg2ch',
    jsonb_build_object('tipo','remito','punto_venta','0001','condicion_fiscal','Consumidor Final',
      'customer_id','00000000-0000-0000-0000-00000000c2c1','cc_total',0,'emitir_en_arca',false,
      'items', jsonb_build_array(jsonb_build_object(
        'inventory_id','00000000-0000-0000-0000-00000000c2d8','descripcion','Consumo',
        'tipo_linea','producto','cantidad',5,'precio_unitario',1000)),
      'pagos', jsonb_build_array(jsonb_build_object(
        'amount',5000,'amount_ars',5000,'payment_method','efectivo'))));
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status' = 'created', '19 · C. la venta de las 5 unidades se registra');

  SELECT stock_quantity INTO v_stock FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2d8';
  PERFORM pg_temp.assert(v_stock = 0, '19 · C. tras vender las 5, el stock queda en 0 (obtenido ' || v_stock || ')');

  -- D. Eliminar la compra. E. El stock tiene que quedar en -5.
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000c209', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  d := delete_supplier_purchase_safe('00000000-0000-0000-0000-00000000c201'::uuid, v_purchase,
                                     '00000000-0000-0000-0000-00000000c209'::uuid);
  RESET ROLE;
  RAISE NOTICE '   delete compra -> %', d::text;
  PERFORM pg_temp.assert(COALESCE((d->>'ok')::boolean, false),
    '19 · D. la eliminacion de la compra corre (error=' || COALESCE(d->>'error','-') || ')');

  SELECT stock_quantity INTO v_stock FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2d8';
  PERFORM pg_temp.assert(v_stock = -5,
    '19 · E. eliminar la compra ya consumida deja el stock en -5 (obtenido ' || v_stock || ')');

  -- El movimiento de cancelacion tiene que cerrar.
  SELECT id INTO v_mov FROM inventory_movements
   WHERE reference_id = v_purchase AND inventory_item_id='00000000-0000-0000-0000-00000000c2d8'
     AND movement_type='cancellation';
  PERFORM pg_temp.assert_movimiento(v_mov, 0, -5, -5, '19 · movimiento de cancelacion');
END $$;

-- ============================================================================
-- 20 · ELIMINAR UNA COMPRA SIN DEFICIT  ·  5 -> +5 -> 10 -> delete -> 5
-- ============================================================================
DO $$
DECLARE r jsonb; d jsonb; v_purchase uuid; v_stock int; v_mov uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000c209', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  r := create_supplier_purchase_atomic(
        '00000000-0000-0000-0000-00000000c201'::uuid,
        '00000000-0000-0000-0000-00000000c2f1'::uuid,
        '00000000-0000-0000-0000-00000000c209'::uuid,
        'Proveedor G2C', current_date, 'FC-G2C-2', 3000, 0, NULL, 'G2C',
        jsonb_build_array(jsonb_build_object(
          'inventory_id','00000000-0000-0000-0000-00000000c2d9',
          'product_name','Prod I','quantity',5,'unit_cost',600)),
        'g2c-compra-2');
  RESET ROLE;

  SELECT stock_quantity INTO v_stock FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2d9';
  PERFORM pg_temp.assert(v_stock = 10, '20 · la compra lleva el stock de 5 a 10 (obtenido ' || v_stock || ')');

  SELECT id INTO v_purchase FROM supplier_purchases
   WHERE business_id='00000000-0000-0000-0000-00000000c201' AND invoice_number='FC-G2C-2';

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000c209', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  d := delete_supplier_purchase_safe('00000000-0000-0000-0000-00000000c201'::uuid, v_purchase,
                                     '00000000-0000-0000-0000-00000000c209'::uuid);
  RESET ROLE;
  PERFORM pg_temp.assert(COALESCE((d->>'ok')::boolean, false),
    '20 · la eliminacion corre (error=' || COALESCE(d->>'error','-') || ')');

  SELECT stock_quantity INTO v_stock FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2d9';
  PERFORM pg_temp.assert(v_stock = 5,
    '20 · sin deficit, eliminar la compra devuelve 10 - 5 = 5 (obtenido ' || v_stock || ')');

  SELECT id INTO v_mov FROM inventory_movements
   WHERE reference_id = v_purchase AND inventory_item_id='00000000-0000-0000-0000-00000000c2d9'
     AND movement_type='cancellation';
  PERFORM pg_temp.assert_movimiento(v_mov, 10, -5, 5, '20 · movimiento de cancelacion sin deficit');

  -- Y el ciclo completo compra + eliminacion neteo en cero.
  PERFORM pg_temp.assert(
    (SELECT SUM(quantity) FROM inventory_movements
      WHERE inventory_item_id='00000000-0000-0000-0000-00000000c2d9') = 0,
    '20 · suma neta compra + eliminacion = 0');
END $$;

-- ============================================================================
-- 21 · UNA COMPRA CON PAGOS SIGUE BLOQUEADA  ·  el parche no aflojo el guard
-- ============================================================================
DO $$
DECLARE r jsonb; d jsonb; v_purchase uuid; v_stock int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000c209', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  r := create_supplier_purchase_atomic(
        '00000000-0000-0000-0000-00000000c201'::uuid,
        '00000000-0000-0000-0000-00000000c2f1'::uuid,
        '00000000-0000-0000-0000-00000000c209'::uuid,
        'Proveedor G2C', current_date, 'FC-G2C-3', 3000, 3000, 'efectivo', 'G2C pagada',
        jsonb_build_array(jsonb_build_object(
          'inventory_id','00000000-0000-0000-0000-00000000c2da',
          'product_name','Prod J','quantity',5,'unit_cost',600)),
        'g2c-compra-3');
  RESET ROLE;

  SELECT id INTO v_purchase FROM supplier_purchases
   WHERE business_id='00000000-0000-0000-0000-00000000c201' AND invoice_number='FC-G2C-3';
  SELECT stock_quantity INTO v_stock FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2da';
  PERFORM pg_temp.assert(v_stock = 8, '21 · la compra pagada deja el stock en 8 (obtenido ' || v_stock || ')');

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000c209', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  d := delete_supplier_purchase_safe('00000000-0000-0000-0000-00000000c201'::uuid, v_purchase,
                                     '00000000-0000-0000-0000-00000000c209'::uuid);
  RESET ROLE;
  RAISE NOTICE '   delete compra pagada -> %', d::text;

  PERFORM pg_temp.assert(d->>'error_code' = 'BLOCKED_PAID',
    '21 · eliminar una compra con pagos sigue BLOQUEADO (obtenido ' || COALESCE(d->>'error_code','-') || ')');

  SELECT stock_quantity INTO v_stock FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2da';
  PERFORM pg_temp.assert(v_stock = 8,
    '21 · y el stock no se toco (sigue en ' || v_stock || ')');
  PERFORM pg_temp.assert(
    NOT EXISTS (SELECT 1 FROM inventory_movements
                 WHERE reference_id = v_purchase AND movement_type='cancellation'),
    '21 · tampoco se escribio un movimiento de cancelacion');
END $$;

-- ============================================================================
-- 22 · TENANT · no se puede eliminar la compra de otro negocio
-- ============================================================================
DO $$
DECLARE v_purchase uuid := gen_random_uuid(); v_res text; v_stock int;
BEGIN
  SET LOCAL session_replication_role='replica';
  INSERT INTO supplier_purchases(id, business_id, supplier_id, invoice_number, total_amount, paid_amount)
    VALUES (v_purchase,'00000000-0000-0000-0000-00000000c202',
            '00000000-0000-0000-0000-00000000c2f2','FC-AJENA',3000,0);
  INSERT INTO supplier_purchase_items(business_id, purchase_id, supplier_id, inventory_id,
                                      product_name, quantity, unit_cost)
    VALUES ('00000000-0000-0000-0000-00000000c202', v_purchase,
            '00000000-0000-0000-0000-00000000c2f2','00000000-0000-0000-0000-00000000c2df',
            'Prod ajeno',5,600);
  SET LOCAL session_replication_role='origin';

  v_res := pg_temp.como_authenticated('00000000-0000-0000-0000-00000000c209',
    format($q$SELECT delete_supplier_purchase_safe(
               '00000000-0000-0000-0000-00000000c202'::uuid, %L::uuid,
               '00000000-0000-0000-0000-00000000c209'::uuid)$q$, v_purchase));
  RAISE NOTICE '   delete compra cross-tenant -> %', v_res;
  PERFORM pg_temp.assert(v_res LIKE '42501%',
    '22 · eliminar una compra ajena es FORBIDDEN (obtenido ' || v_res || ')');

  SELECT stock_quantity INTO v_stock FROM inventory WHERE id='00000000-0000-0000-0000-00000000c2df';
  PERFORM pg_temp.assert(v_stock = 7,
    '22 · el inventario del otro negocio no se movio (sigue en ' || v_stock || ')');
  PERFORM pg_temp.assert(
    EXISTS (SELECT 1 FROM supplier_purchases WHERE id = v_purchase),
    '22 · y la compra ajena sigue existiendo');
END $$;

-- ============================================================================
-- 18 · CATALOGO · ningun writer ACTIVO de salida reversible clampa a cero
--
-- Es la prueba que impide que el clamp vuelva por un `CREATE OR REPLACE`
-- posterior. Se mira el catalogo VIVO, no el archivo: lo que corre es lo que
-- esta en pg_proc. Acotado a los dos caminos del contrato G2-C; no es un grep
-- global que prohiba GREATEST en todo inventario (hay usos legitimos).
-- ============================================================================
DO $$
DECLARE f text; v_oid oid; v_src text; v_n int := 0;
BEGIN
  -- Por FIRMA EXACTA, no por nombre: hay dos `create_comprobante_checkout_atomic`
  -- (la publica envoltorio y la privada que corre), y buscar por nombre
  -- inspeccionaria la equivocada.
  FOREACH f IN ARRAY ARRAY[
    'private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)',
    'public.adjust_stock_on_order_item()',
    'public.delete_supplier_purchase_safe(uuid,uuid,uuid)'
  ] LOOP
    v_oid := to_regprocedure(f);
    PERFORM pg_temp.assert(v_oid IS NOT NULL, '18 · la firma exacta ' || f || ' existe');
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_oid;
    v_n := v_n + 1;
    PERFORM pg_temp.assert(
      v_src !~* 'GREATEST\s*\([^;]{0,90}?(v_prev_stock|v_prev_stk|v_new_stock|stock_quantity)',
      '18 · ' || f || ' no clampa la salida de stock a cero');
  END LOOP;
  PERFORM pg_temp.assert(v_n = 3, '18 · se inspeccionaron los 3 writers del contrato (vistos ' || v_n || ')');
END $$;

SELECT 'G2-C: todas las aserciones pasaron' AS resultado;
ROLLBACK;
