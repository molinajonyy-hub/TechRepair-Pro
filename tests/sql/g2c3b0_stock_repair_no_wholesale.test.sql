-- ============================================================================
-- G2-C.3B0 · StockRepairTool sin autoridad sobre pedidos mayoristas.
--
-- Contrato (migracion 20261007120000_g2c3b0_stock_repair_no_wholesale.sql):
--   · preview_missing_stock_movements y repair_missing_stock_movements NO
--     procesan wholesale_orders / wholesale_order_items: ningun candidato,
--     ningun movimiento reference_type='wholesale_order', ningun marcador stock_*
--     de items mayoristas escrito. PEDIDO MAYORISTA = ESTADO COMERCIAL.
--   · la rama de comprobantes solo reconstruye lo que el checkout canonico
--     habria descontado: COALESCE(tipo_linea, 'producto') IN ('producto','repuesto').
--   · igual que antes: autoridad owner/admin + inventory del tenant canonico,
--     lock canonico G2-C.2, p_allow_negative, marcadores de comprobante,
--     idempotencia y forma de la respuesta (pedidos_mayoristas_procesados = 0).
--
-- R1-R5: expectativas NUEVAS sobre lo que el discovery reprodujo como bug.
-- P1-P5: lo que la herramienta tiene que seguir haciendo.
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

-- Ejecuta SQL como `authenticated` (con RLS) y devuelve 'OK' o 'SQLSTATE mensaje'.
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

-- Igual pero devolviendo el jsonb del resultado.
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

CREATE OR REPLACE FUNCTION pg_temp.movs(p_id uuid) RETURNS bigint LANGUAGE sql AS
$$ SELECT count(*) FROM public.inventory_movements WHERE inventory_item_id = p_id $$;

-- Huella de todo lo que la herramienta podria tocar, en los dos negocios.
CREATE OR REPLACE FUNCTION pg_temp.huella() RETURNS text LANGUAGE sql AS $$
  SELECT md5(
    coalesce((SELECT string_agg(format('%s:%s:%s', id, stock_quantity, stock), ',' ORDER BY id)
                FROM public.inventory WHERE business_id IN ('00000000-0000-0000-0000-0000000b0001','00000000-0000-0000-0000-0000000b0002')), '') || '|' ||
    coalesce((SELECT string_agg(format('%s:%s:%s:%s', id, stock_processed, stock_processed_at, stock_movement_id), ',' ORDER BY id)
                FROM public.wholesale_order_items WHERE business_id IN ('00000000-0000-0000-0000-0000000b0001','00000000-0000-0000-0000-0000000b0002')), '') || '|' ||
    coalesce((SELECT string_agg(format('%s:%s:%s', id, stock_processed, stock_movement_id), ',' ORDER BY id)
                FROM public.comprobante_items WHERE business_id IN ('00000000-0000-0000-0000-0000000b0001','00000000-0000-0000-0000-0000000b0002')), '') || '|' ||
    (SELECT count(*)::text FROM public.inventory_movements
      WHERE business_id IN ('00000000-0000-0000-0000-0000000b0001','00000000-0000-0000-0000-0000000b0002')))
$$;

-- Venta POS real (checkout canonico) de UNA linea.
CREATE OR REPLACE FUNCTION pg_temp.venta(p_key text, p_inv uuid, p_qty int, p_tipo_linea text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  r := pg_temp.rpc('00000000-0000-0000-0000-0000000b0a01', format($q$
    SELECT create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000b0001', %L, %L,
      jsonb_build_object('tipo','remito','punto_venta','0001','condicion_fiscal','Consumidor Final',
        'customer_id','00000000-0000-0000-0000-0000000b0c01','cc_total',0,'emitir_en_arca',false,
        'items', jsonb_build_array(jsonb_build_object('inventory_id', %L, 'descripcion','g2c3b0',
          'tipo_linea', %L, 'cantidad', %s, 'precio_unitario', 1000)),
        'pagos', jsonb_build_array(jsonb_build_object('amount', %s, 'amount_ars', %s, 'payment_method','efectivo'))))$q$,
    p_key, 'h-' || p_key, p_inv, p_tipo_linea, p_qty, p_qty * 1000, p_qty * 1000));
  IF r->>'status' IS DISTINCT FROM 'created' THEN
    RAISE EXCEPTION 'fixture: el checkout % no creo el comprobante: %', p_key, r;
  END IF;
  RETURN (r->>'comprobante_id')::uuid;
END; $$;

\set A     '00000000-0000-0000-0000-0000000b0001'
\set B     '00000000-0000-0000-0000-0000000b0002'
\set OWN   '00000000-0000-0000-0000-0000000b0a01'
\set ADM   '00000000-0000-0000-0000-0000000b0a02'
\set MGR   '00000000-0000-0000-0000-0000000b0a03'
\set OWNB  '00000000-0000-0000-0000-0000000b0b01'

-- ── Semilla ─────────────────────────────────────────────────────────────────
SET LOCAL session_replication_role = 'replica';
INSERT INTO auth.users(id) VALUES (:'OWN'), (:'ADM'), (:'MGR'), (:'OWNB'),
  ('00000000-0000-0000-0000-0000000b0a0c');
INSERT INTO businesses(id, name, owner_user_id) VALUES (:'A', 'G2C3B0', :'OWN'), (:'B', 'G2C3B0 ajeno', :'OWNB');
INSERT INTO profiles(id, user_id, business_id, role, is_active) VALUES
  (:'OWN',  :'OWN',  :'A', 'owner',   true),
  (:'ADM',  :'ADM',  :'A', 'admin',   true),
  (:'MGR',  :'MGR',  :'A', 'manager', true),
  (:'OWNB', :'OWNB', :'B', 'owner',   true);
INSERT INTO customers(id, business_id, name, phone, customer_type) VALUES
  ('00000000-0000-0000-0000-0000000b0c01', :'A', 'Cliente B0', '+540091', 'minorista'),
  ('00000000-0000-0000-0000-0000000b0c02', :'B', 'Cliente ajeno', '+540092', 'minorista');
INSERT INTO cajas(id, business_id, opened_by, status) VALUES ('00000000-0000-0000-0000-0000000b0e01', :'A', :'OWN', 'abierta');
INSERT INTO wholesale_customers(id, business_id, auth_user_id, name, email, approved, suspended) VALUES
  ('00000000-0000-0000-0000-0000000b0f01', :'A', '00000000-0000-0000-0000-0000000b0a0c', 'Mayorista B0', 'b0@g2c3b0.test', true, false),
  ('00000000-0000-0000-0000-0000000b0f02', :'B', NULL, 'Mayorista ajeno', 'b0b@g2c3b0.test', true, false);

INSERT INTO inventory(id, business_id, name, code, category, stock_quantity, stock, cost_price, sale_price,
                      base_price, base_currency, auto_update_price, exchange_rate_used, is_active)
VALUES
  -- R: pedidos mayoristas y lineas que el checkout no descuenta
  ('00000000-0000-0000-0000-0000000b0d01', :'A', 'R1 pendiente',    'G2C3B0-R1',  'Rep', 10, 10, 600, 1000, 1000, 'ARS', false, 1, true),
  ('00000000-0000-0000-0000-0000000b0d02', :'A', 'R2 convertido',   'G2C3B0-R2',  'Rep', 10, 10, 600, 1000, 1000, 'ARS', false, 1, true),
  ('00000000-0000-0000-0000-0000000b0d03', :'A', 'R3 invoiced',     'G2C3B0-R3',  'Rep', 10, 10, 600, 1000, 1000, 'ARS', false, 1, true),
  ('00000000-0000-0000-0000-0000000b0d04', :'A', 'R4 cancelled',    'G2C3B0-R4',  'Rep', 10, 10, 600, 1000, 1000, 'ARS', false, 1, true),
  ('00000000-0000-0000-0000-0000000b0d14', :'A', 'R4 rejected',     'G2C3B0-R4B', 'Rep', 10, 10, 600, 1000, 1000, 'ARS', false, 1, true),
  ('00000000-0000-0000-0000-0000000b0d05', :'A', 'R5 otro',         'G2C3B0-R5',  'Rep', 10, 10, 600, 1000, 1000, 'ARS', false, 1, true),
  ('00000000-0000-0000-0000-0000000b0d15', :'A', 'R5 servicio',     'G2C3B0-R5B', 'Rep', 10, 10, 600, 1000, 1000, 'ARS', false, 1, true),
  -- P: legado de comprobantes que la herramienta SI repara
  ('00000000-0000-0000-0000-0000000b0d21', :'A', 'P1 producto',     'G2C3B0-P1',  'Rep', 10, 10, 600, 1000, 1000, 'ARS', false, 1, true),
  ('00000000-0000-0000-0000-0000000b0d22', :'A', 'P2 repuesto',     'G2C3B0-P2',  'Rep', 10, 10, 600, 1000, 1000, 'ARS', false, 1, true),
  ('00000000-0000-0000-0000-0000000b0d23', :'A', 'P1 tipo NULL',    'G2C3B0-P1N', 'Rep', 10, 10, 600, 1000, 1000, 'ARS', false, 1, true),
  ('00000000-0000-0000-0000-0000000b0d24', :'A', 'P3 insuficiente', 'G2C3B0-P3',  'Rep',  1,  1, 600, 1000, 1000, 'ARS', false, 1, true),
  -- tenant ajeno
  ('00000000-0000-0000-0000-0000000b0d91', :'B', 'Ajeno',           'G2C3B0-X',   'Rep', 40, 40, 600, 1000, 1000, 'ARS', false, 1, true);

-- Pedidos mayoristas de A (uno por estado) y uno de B.
INSERT INTO wholesale_orders(id, business_id, customer_id, order_number, status) VALUES
  ('00000000-0000-0000-0000-0000000b0101', :'A', '00000000-0000-0000-0000-0000000b0f01', 'B0-R1',  'pending_whatsapp'),
  ('00000000-0000-0000-0000-0000000b0102', :'A', '00000000-0000-0000-0000-0000000b0f01', 'B0-R2',  'approved'),
  ('00000000-0000-0000-0000-0000000b0103', :'A', '00000000-0000-0000-0000-0000000b0f01', 'B0-R3',  'invoiced'),
  ('00000000-0000-0000-0000-0000000b0104', :'A', '00000000-0000-0000-0000-0000000b0f01', 'B0-R4',  'cancelled'),
  ('00000000-0000-0000-0000-0000000b0114', :'A', '00000000-0000-0000-0000-0000000b0f01', 'B0-R4B', 'rejected'),
  ('00000000-0000-0000-0000-0000000b0191', :'B', '00000000-0000-0000-0000-0000000b0f02', 'B0-X',   'approved');
INSERT INTO wholesale_order_items(id, order_id, business_id, inventory_item_id, product_name, quantity, unit_price, subtotal) VALUES
  ('00000000-0000-0000-0000-0000000b0201', '00000000-0000-0000-0000-0000000b0101', :'A', '00000000-0000-0000-0000-0000000b0d01', 'R1', 2, 1000, 2000),
  ('00000000-0000-0000-0000-0000000b0202', '00000000-0000-0000-0000-0000000b0102', :'A', '00000000-0000-0000-0000-0000000b0d02', 'R2', 3, 1000, 3000),
  ('00000000-0000-0000-0000-0000000b0203', '00000000-0000-0000-0000-0000000b0103', :'A', '00000000-0000-0000-0000-0000000b0d03', 'R3', 1, 1000, 1000),
  ('00000000-0000-0000-0000-0000000b0204', '00000000-0000-0000-0000-0000000b0104', :'A', '00000000-0000-0000-0000-0000000b0d04', 'R4', 4, 1000, 4000),
  ('00000000-0000-0000-0000-0000000b0214', '00000000-0000-0000-0000-0000000b0114', :'A', '00000000-0000-0000-0000-0000000b0d14', 'R4B', 5, 1000, 5000),
  ('00000000-0000-0000-0000-0000000b0291', '00000000-0000-0000-0000-0000000b0191', :'B', '00000000-0000-0000-0000-0000000b0d91', 'X', 6, 1000, 6000);

-- Legado: ventas historicas cuyas lineas nunca movieron stock (stock_processed = false).
INSERT INTO comprobantes(id, business_id, tipo, numero, punto_venta, fecha, date, subtotal, total,
                         estado, status, estado_comercial, estado_fiscal) VALUES
  ('00000000-0000-0000-0000-0000000b0301', :'A', 'remito', '0001-00900001', '0001', now(), now(), 9000, 9000,
   'emitido', 'issued', 'pendiente', 'no_fiscal');
INSERT INTO comprobante_items(id, comprobante_id, business_id, descripcion, tipo_linea, cantidad,
                              precio_unitario, subtotal, inventory_id, stock_processed) VALUES
  ('00000000-0000-0000-0000-0000000b0401', '00000000-0000-0000-0000-0000000b0301', :'A', 'P1', 'producto', 2, 1000, 2000, '00000000-0000-0000-0000-0000000b0d21', false),
  ('00000000-0000-0000-0000-0000000b0402', '00000000-0000-0000-0000-0000000b0301', :'A', 'P2', 'repuesto', 3, 1000, 3000, '00000000-0000-0000-0000-0000000b0d22', false),
  ('00000000-0000-0000-0000-0000000b0403', '00000000-0000-0000-0000-0000000b0301', :'A', 'P1 NULL', NULL,     1, 1000, 1000, '00000000-0000-0000-0000-0000000b0d23', false),
  ('00000000-0000-0000-0000-0000000b0404', '00000000-0000-0000-0000-0000000b0301', :'A', 'P3', 'producto', 3, 1000, 3000, '00000000-0000-0000-0000-0000000b0d24', false);
SET LOCAL session_replication_role = 'origin';

-- ============================================================================
-- 0 · ESCENARIOS REALES previos a la reparacion
-- ============================================================================
DO $$
DECLARE v_conv uuid; v_otro uuid; v_serv uuid;
BEGIN
  -- R2: el pedido se convierte por el checkout canonico: el stock sale UNA vez por el comprobante.
  v_conv := pg_temp.venta('B0-R2-CONV', '00000000-0000-0000-0000-0000000b0d02', 3, 'producto');
  SET LOCAL session_replication_role = 'replica';
  UPDATE public.wholesale_orders SET status = 'invoiced' WHERE id = '00000000-0000-0000-0000-0000000b0102';
  SET LOCAL session_replication_role = 'origin';
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-0000000b0d02') = 7, '0.1 R2: el checkout desconto 3 (10 -> 7)');

  -- R5: el POS deja pasar una linea con inventory_id a 'otro'/'servicio': el checkout no la descuenta.
  v_otro := pg_temp.venta('B0-R5-OTRO', '00000000-0000-0000-0000-0000000b0d05', 2, 'otro');
  v_serv := pg_temp.venta('B0-R5-SERV', '00000000-0000-0000-0000-0000000b0d15', 2, 'servicio');
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-0000000b0d05') = 10
                     AND pg_temp.stock('00000000-0000-0000-0000-0000000b0d15') = 10,
                     '0.2 R5: el checkout NO mueve stock de lineas otro/servicio');
  PERFORM pg_temp.assert((SELECT bool_and(NOT coalesce(stock_processed, false)) FROM public.comprobante_items
                          WHERE comprobante_id IN (v_otro, v_serv)),
                         '0.3 R5: esas lineas quedan con stock_processed = false');
END $$;

CREATE TEMP TABLE _woi_antes ON COMMIT DROP AS
SELECT id, stock_processed, stock_processed_at, stock_movement_id FROM public.wholesale_order_items;

-- ============================================================================
-- 1 · PREVIEW
-- ============================================================================
DO $$
DECLARE r jsonb;
BEGIN
  r := pg_temp.rpc('00000000-0000-0000-0000-0000000b0a01',
    $q$SELECT coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) FROM public.preview_missing_stock_movements('00000000-0000-0000-0000-0000000b0001') p$q$);
  PERFORM pg_temp.assert(jsonb_array_length(r) = 4, '1.1 preview: exactamente las 4 lineas legado de comprobante (' || jsonb_array_length(r) || ')');
  PERFORM pg_temp.assert(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r) e WHERE e->>'source' <> 'comprobante'),
    '1.2 preview: ningun candidato con source distinto de comprobante');
  -- R1/R2/R3: ningun item mayorista (ni pendiente, ni convertido, ni invoiced).
  PERFORM pg_temp.assert(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r) e
                                      WHERE (e->>'item_id')::uuid IN (SELECT id FROM public.wholesale_order_items)
                                         OR (e->>'sale_id')::uuid IN (SELECT id FROM public.wholesale_orders)),
    '1.3 R1-R4: preview no devuelve pedidos ni items mayoristas');
  -- R5: las lineas otro/servicio no son candidatas.
  PERFORM pg_temp.assert(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r) e
                                      WHERE (e->>'inventory_id')::uuid IN ('00000000-0000-0000-0000-0000000b0d05','00000000-0000-0000-0000-0000000b0d15')),
    '1.4 R5: preview no devuelve lineas otro/servicio');
  -- P1/P2: producto, repuesto y tipo NULL (legado: el checkout lo trata como producto) si aparecen.
  PERFORM pg_temp.assert((SELECT count(*) FROM jsonb_array_elements(r) e
                           WHERE (e->>'item_id')::uuid IN ('00000000-0000-0000-0000-0000000b0401','00000000-0000-0000-0000-0000000b0402',
                                                           '00000000-0000-0000-0000-0000000b0403','00000000-0000-0000-0000-0000000b0404')) = 4,
    '1.5 P1/P2: producto, repuesto, tipo NULL y el insuficiente son candidatos');
  PERFORM pg_temp.assert((SELECT count(*) FROM jsonb_object_keys(r->0)) = 9, '1.6 preview conserva su forma de 9 columnas');
  PERFORM pg_temp.assert((SELECT (e->>'can_deduct')::boolean FROM jsonb_array_elements(r) e
                           WHERE (e->>'item_id')::uuid = '00000000-0000-0000-0000-0000000b0404') IS FALSE,
    '1.7 preview sigue marcando can_deduct = false cuando el stock no alcanza');
  -- P5: el tenant B ve solo lo suyo (no tiene legado: 0 filas; su pedido mayorista tampoco aparece).
  r := pg_temp.rpc('00000000-0000-0000-0000-0000000b0b01',
    $q$SELECT coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) FROM public.preview_missing_stock_movements('00000000-0000-0000-0000-0000000b0002') p$q$);
  PERFORM pg_temp.assert(r = '[]'::jsonb, '1.8 P5: el preview del tenant B no ve su pedido mayorista ni nada de A');
END $$;

-- ============================================================================
-- 2 · SEGURIDAD (P5) · comportamiento existente, CERO efectos
-- ============================================================================
DO $$
DECLARE v_h text := pg_temp.huella(); v text;
BEGIN
  v := pg_temp.como('00000000-0000-0000-0000-0000000b0b01',
    $q$SELECT public.repair_missing_stock_movements('00000000-0000-0000-0000-0000000b0001', true)$q$);
  PERFORM pg_temp.assert(v LIKE '42501%', '2.1 P5: owner de B no puede reparar A (' || v || ')');
  v := pg_temp.como('00000000-0000-0000-0000-0000000b0b01',
    $q$SELECT count(*) FROM public.preview_missing_stock_movements('00000000-0000-0000-0000-0000000b0001')$q$);
  PERFORM pg_temp.assert(v LIKE '42501%', '2.2 P5: owner de B no puede previsualizar A (' || v || ')');
  v := pg_temp.como('00000000-0000-0000-0000-0000000b0a03',
    $q$SELECT public.repair_missing_stock_movements('00000000-0000-0000-0000-0000000b0001', true)$q$);
  PERFORM pg_temp.assert(v LIKE '42501%', '2.3 P5: manager de A sigue sin poder reparar (owner/admin) (' || v || ')');
  PERFORM pg_temp.assert(NOT has_function_privilege('anon', 'public.repair_missing_stock_movements(uuid,boolean)', 'EXECUTE')
                     AND NOT has_function_privilege('anon', 'public.preview_missing_stock_movements(uuid)', 'EXECUTE'),
                     '2.4 P5: anon sigue sin EXECUTE');
  PERFORM pg_temp.assert(pg_temp.huella() = v_h, '2.5 P5: los rechazos no tienen ningun efecto');
END $$;

-- ============================================================================
-- 3 · REPAIR (p_allow_negative = false)
-- ============================================================================
DO $$
DECLARE r jsonb; m record;
BEGIN
  r := pg_temp.rpc('00000000-0000-0000-0000-0000000b0a01',
    $q$SELECT public.repair_missing_stock_movements('00000000-0000-0000-0000-0000000b0001', false)$q$);
  RAISE NOTICE '   repair(false) -> %', r::text;
  -- P4: forma de la respuesta.
  PERFORM pg_temp.assert((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(r) k) =
    ARRAY['comprobantes_procesados','items_producto_no_encontrado','items_sin_stock_suficiente','pedidos_mayoristas_procesados','total_unidades_descontadas'],
    '3.1 P4: la respuesta conserva exactamente sus 5 claves');
  PERFORM pg_temp.assert((r->>'pedidos_mayoristas_procesados')::int = 0, '3.2 P4/R1-R4: pedidos_mayoristas_procesados = 0');
  PERFORM pg_temp.assert((r->>'comprobantes_procesados')::int = 3, '3.3 P1/P2: procesa producto, repuesto y tipo NULL (3)');
  PERFORM pg_temp.assert((r->>'items_sin_stock_suficiente')::int = 1, '3.4 P3: el insuficiente se saltea y se reporta');
  PERFORM pg_temp.assert((r->>'items_producto_no_encontrado')::int = 0, '3.5 ningun producto no encontrado');
  PERFORM pg_temp.assert((r->>'total_unidades_descontadas')::numeric = 6, '3.6 total descontado = 2 + 3 + 1');

  -- R1-R4: stock intacto, 0 movimientos wholesale_order, marcadores intactos.
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-0000000b0d01') = 10 AND pg_temp.movs('00000000-0000-0000-0000-0000000b0d01') = 0,
    '3.7 R1: el pedido pending_whatsapp no mueve stock (10) ni deja movimiento');
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-0000000b0d02') = 7 AND pg_temp.movs('00000000-0000-0000-0000-0000000b0d02') = 1,
    '3.8 R2: el pedido convertido queda donde lo dejo el checkout (7), un solo movimiento');
  PERFORM pg_temp.assert((SELECT reference_type FROM public.inventory_movements
                           WHERE inventory_item_id = '00000000-0000-0000-0000-0000000b0d02') = 'comprobante',
    '3.9 R2: la unica salida es la del comprobante');
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-0000000b0d03') = 10 AND pg_temp.movs('00000000-0000-0000-0000-0000000b0d03') = 0,
    '3.10 R3: el pedido invoiced SIN comprobante no mueve stock');
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-0000000b0d04') = 10 AND pg_temp.movs('00000000-0000-0000-0000-0000000b0d04') = 0
                     AND pg_temp.stock('00000000-0000-0000-0000-0000000b0d14') = 10 AND pg_temp.movs('00000000-0000-0000-0000-0000000b0d14') = 0,
    '3.11 R4: cancelled y rejected no mueven stock (sin reversa ni relleno)');
  PERFORM pg_temp.assert(NOT EXISTS (SELECT 1 FROM public.inventory_movements WHERE reference_type = 'wholesale_order'),
    '3.12 R1-R4: cero movimientos con reference_type = wholesale_order');
  PERFORM pg_temp.assert(NOT EXISTS (
      SELECT 1 FROM public.wholesale_order_items w JOIN _woi_antes a USING (id)
       WHERE w.stock_processed IS DISTINCT FROM a.stock_processed
          OR w.stock_processed_at IS DISTINCT FROM a.stock_processed_at
          OR w.stock_movement_id IS DISTINCT FROM a.stock_movement_id),
    '3.13 R1-R4: marcadores stock_* de wholesale_order_items intactos');

  -- R5: lineas otro/servicio intactas.
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-0000000b0d05') = 10 AND pg_temp.movs('00000000-0000-0000-0000-0000000b0d05') = 0
                     AND pg_temp.stock('00000000-0000-0000-0000-0000000b0d15') = 10 AND pg_temp.movs('00000000-0000-0000-0000-0000000b0d15') = 0,
    '3.14 R5: otro/servicio: stock intacto y sin movimiento');
  PERFORM pg_temp.assert((SELECT bool_and(NOT coalesce(stock_processed, false)) FROM public.comprobante_items
                           WHERE inventory_id IN ('00000000-0000-0000-0000-0000000b0d05','00000000-0000-0000-0000-0000000b0d15')),
    '3.15 R5: sus lineas no se marcan como procesadas');

  -- P1/P2: una salida exacta por linea, invariante por movimiento, marcador asociado.
  FOR m IN
    SELECT ci.id AS item, ci.inventory_id, ci.cantidad::int AS qty, 10 AS inicial
      FROM public.comprobante_items ci
     WHERE ci.id IN ('00000000-0000-0000-0000-0000000b0401','00000000-0000-0000-0000-0000000b0402','00000000-0000-0000-0000-0000000b0403')
  LOOP
    PERFORM pg_temp.assert(pg_temp.stock(m.inventory_id) = m.inicial - m.qty,
      '3.16 P1/P2: ' || m.item || ' desconto exactamente ' || m.qty);
    PERFORM pg_temp.assert(EXISTS (
        SELECT 1 FROM public.inventory_movements im JOIN public.comprobante_items ci ON ci.stock_movement_id = im.id
         WHERE ci.id = m.item AND ci.stock_processed IS TRUE AND ci.stock_processed_at IS NOT NULL
           AND im.inventory_item_id = m.inventory_id AND im.business_id = '00000000-0000-0000-0000-0000000b0001'
           AND im.movement_type = 'sale' AND im.quantity = -m.qty
           AND im.previous_stock = m.inicial AND im.new_stock = m.inicial - m.qty
           AND im.new_stock - im.previous_stock = im.quantity
           AND im.reference_type = 'comprobante' AND im.reference_id = '00000000-0000-0000-0000-0000000b0301'
           AND im.note LIKE 'Reparaci%venta anterior'),
      '3.17 P1/P2: ' || m.item || ' movimiento sale exacto (new - previous = quantity) y marcador asociado');
    PERFORM pg_temp.assert(pg_temp.movs(m.inventory_id) = 1, '3.18 P1/P2: ' || m.item || ' un solo movimiento');
  END LOOP;

  -- P3: con allow_negative = false el insuficiente queda como estaba.
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-0000000b0d24') = 1 AND pg_temp.movs('00000000-0000-0000-0000-0000000b0d24') = 0,
    '3.19 P3: allow_negative=false no toca el stock insuficiente');
  PERFORM pg_temp.assert(NOT coalesce((SELECT stock_processed FROM public.comprobante_items WHERE id = '00000000-0000-0000-0000-0000000b0404'), false),
    '3.20 P3: y no lo marca como procesado');

  -- P5: el tenant B no se toca.
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-0000000b0d91') = 40 AND pg_temp.movs('00000000-0000-0000-0000-0000000b0d91') = 0,
    '3.21 P5: el tenant B queda intacto');
END $$;

-- ============================================================================
-- 4 · REPAIR (p_allow_negative = true) y segunda pasada
-- ============================================================================
DO $$
DECLARE r jsonb; v_h text;
BEGIN
  r := pg_temp.rpc('00000000-0000-0000-0000-0000000b0a02',
    $q$SELECT public.repair_missing_stock_movements('00000000-0000-0000-0000-0000000b0001', true)$q$);
  RAISE NOTICE '   repair(true) por admin -> %', r::text;
  PERFORM pg_temp.assert((r->>'comprobantes_procesados')::int = 1 AND (r->>'pedidos_mayoristas_procesados')::int = 0
                     AND (r->>'items_sin_stock_suficiente')::int = 0,
    '4.1 P3: allow_negative=true (admin) procesa solo el insuficiente; 0 mayoristas');
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-0000000b0d24') = -2, '4.2 P3: 1 - 3 = -2 (stock negativo permitido)');
  PERFORM pg_temp.assert(EXISTS (SELECT 1 FROM public.inventory_movements
                                  WHERE inventory_item_id = '00000000-0000-0000-0000-0000000b0d24'
                                    AND previous_stock = 1 AND new_stock = -2 AND quantity = -3),
    '4.3 P3: movimiento 1 -> -2, quantity -3');
  PERFORM pg_temp.assert(pg_temp.stock('00000000-0000-0000-0000-0000000b0d01') = 10 AND pg_temp.stock('00000000-0000-0000-0000-0000000b0d03') = 10
                     AND pg_temp.stock('00000000-0000-0000-0000-0000000b0d04') = 10 AND pg_temp.stock('00000000-0000-0000-0000-0000000b0d05') = 10,
    '4.4 R1-R5: tampoco con allow_negative=true se tocan pedidos ni lineas otro/servicio');

  v_h := pg_temp.huella();
  r := pg_temp.rpc('00000000-0000-0000-0000-0000000b0a01',
    $q$SELECT public.repair_missing_stock_movements('00000000-0000-0000-0000-0000000b0001', true)$q$);
  PERFORM pg_temp.assert((r->>'comprobantes_procesados')::int = 0 AND (r->>'pedidos_mayoristas_procesados')::int = 0
                     AND (r->>'total_unidades_descontadas')::numeric = 0,
    '4.5 P1: segunda pasada procesa 0 (idempotente)');
  PERFORM pg_temp.assert(pg_temp.huella() = v_h, '4.6 P1: la segunda pasada no tiene ningun efecto');
  r := pg_temp.rpc('00000000-0000-0000-0000-0000000b0a01',
    $q$SELECT coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) FROM public.preview_missing_stock_movements('00000000-0000-0000-0000-0000000b0001') p$q$);
  PERFORM pg_temp.assert(r = '[]'::jsonb, '4.7 preview queda vacio: los pedidos mayoristas nunca fueron candidatos');
END $$;

-- ============================================================================
-- 5 · CATALOGO · contrato estructural sobre el estado final
-- ============================================================================
DO $$
DECLARE v_prev text; v_rep text; v_n int;
        v_filt constant text := $r$COALESCE(ci.tipo_linea, 'producto') IN ('producto', 'repuesto')$r$;
BEGIN
  SELECT prosrc INTO v_prev FROM pg_proc WHERE oid = 'public.preview_missing_stock_movements(uuid)'::regprocedure;
  SELECT prosrc INTO v_rep  FROM pg_proc WHERE oid = 'public.repair_missing_stock_movements(uuid,boolean)'::regprocedure;
  PERFORM pg_temp.assert(v_prev !~* 'wholesale' AND v_rep !~* 'wholesale', '5.1 ni preview ni repair mencionan pedidos mayoristas');
  PERFORM pg_temp.assert((length(v_prev) - length(replace(v_prev, v_filt, ''))) / length(v_filt) = 1
                     AND (length(v_rep) - length(replace(v_rep, v_filt, ''))) / length(v_filt) = 2,
    '5.2 filtro producto/repuesto: 1 vez en preview, 2 en repair (conjunto + loop)');
  PERFORM pg_temp.assert(position('private.lock_inventory_rows(p_business_id, v_inv_ids)' IN v_rep) > 0
                     AND position('private.lock_inventory_rows(p_business_id, v_inv_ids)' IN v_rep)
                         < position('SELECT stock_quantity INTO v_prev_stock' IN v_rep),
    '5.3 W6 toma el lock canonico G2-C.2 antes de leer stock');
  PERFORM pg_temp.assert(v_rep !~* 'from\s+(public\.)?inventory\y[^;]*\yfor\s+update\y', '5.4 W6 no bloquea inventory con FOR UPDATE');
  PERFORM pg_temp.assert((SELECT prosecdef AND provolatile = 'v' AND proconfig = ARRAY['search_path=pg_catalog, pg_temp']
                            AND pg_get_userbyid(proowner) = 'postgres'
                            FROM pg_proc WHERE oid = 'public.repair_missing_stock_movements(uuid,boolean)'::regprocedure)
                     AND (SELECT prosecdef AND provolatile = 's' AND proconfig = ARRAY['search_path=pg_catalog, pg_temp']
                            AND pg_get_userbyid(proowner) = 'postgres'
                            FROM pg_proc WHERE oid = 'public.preview_missing_stock_movements(uuid)'::regprocedure),
    '5.5 owner / SECURITY DEFINER / volatilidad / search_path preservados');
  PERFORM pg_temp.assert(has_function_privilege('authenticated', 'public.repair_missing_stock_movements(uuid,boolean)', 'EXECUTE')
                     AND has_function_privilege('service_role', 'public.repair_missing_stock_movements(uuid,boolean)', 'EXECUTE')
                     AND has_function_privilege('authenticated', 'public.preview_missing_stock_movements(uuid)', 'EXECUTE')
                     AND has_function_privilege('service_role', 'public.preview_missing_stock_movements(uuid)', 'EXECUTE'),
    '5.6 ACL de API preservada (authenticated + service_role)');
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'private') AND p.prokind = 'f'
     AND p.prosrc ~* 'update\s+(public\.)?inventory\y[^;]*\yset\y[^;]*\ystock(_quantity)?\y\s*=';
  PERFORM pg_temp.assert(v_n = 7, '5.7 siguen siendo exactamente 7 writers de stock server-side (' || v_n || ')');
  PERFORM pg_temp.assert(pg_get_function_result('public.preview_missing_stock_movements(uuid)'::regprocedure) =
    'TABLE(source text, sale_id uuid, item_id uuid, inventory_id uuid, product_name text, quantity numeric, current_stock integer, can_deduct boolean, sale_date timestamp with time zone)',
    '5.8 preview conserva exactamente su forma de retorno');
END $$;

\echo 'G2-C.3B0 · matriz OK'
ROLLBACK;
