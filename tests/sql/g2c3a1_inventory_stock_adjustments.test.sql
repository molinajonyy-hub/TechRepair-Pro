-- ============================================================================
-- G2-C.3A1 · Autoridad atomica para ajustes de stock.
--
-- Contrato (migracion 20261008120000_g2c3a1_inventory_stock_adjustments.sql):
--   public.apply_inventory_stock_adjustments_atomic(p_business_id, p_items,
--     p_source, p_reason, p_idempotency_key) RETURNS jsonb
--   · items {inventory_id, delta} | {inventory_id, target, expected?}; la
--     cantidad del movimiento SIEMPRE la calcula el servidor.
--   · initial_stock -> delta (in/out); import -> target + expected (adjustment);
--     manual -> delta o target (+expected opcional) (adjustment).
--   · expected <> stock bajo lock -> fila 'stale' sin escritura; el resto aplica.
--   · delta 0 / target = actual -> 'noop' sin movimiento.
--   · stock negativo PERMITIDO; alias stock = stock_quantity.
--   · idempotencia server-side por (business_id, key); hash del servidor.
--   · autoridad: tenant canonico + capability inventory (D5: sales incluido).
--
-- A1-A22: los casos del lote. Corre dentro de BEGIN ... ROLLBACK: no deja rastro.
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
  ('A',     '00000000-0000-0000-0000-0000000a1b01'),
  ('B',     '00000000-0000-0000-0000-0000000a1b02'),
  ('OWN',   '00000000-0000-0000-0000-0000000a1a01'),
  ('ADM',   '00000000-0000-0000-0000-0000000a1a02'),
  ('MGR',   '00000000-0000-0000-0000-0000000a1a03'),
  ('SAL',   '00000000-0000-0000-0000-0000000a1a04'),
  ('TEC',   '00000000-0000-0000-0000-0000000a1a05'),
  ('SALNO', '00000000-0000-0000-0000-0000000a1a06'),
  ('CASH',  '00000000-0000-0000-0000-0000000a1a07'),
  ('OWNB',  '00000000-0000-0000-0000-0000000a1a11'),
  ('XB',    '00000000-0000-0000-0000-0000000a1e01'),
  ('NADA',  '00000000-0000-0000-0000-0000000a1f99');
INSERT INTO _id SELECT format('P%s', lpad(n::text, 2, '0')), format('00000000-0000-0000-0000-0000000a1d%s', lpad(n::text, 2, '0'))::uuid
  FROM generate_series(1, 26) AS n;

CREATE OR REPLACE FUNCTION pg_temp.id(p_k text) RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT v FROM _id WHERE k = p_k $$;

CREATE OR REPLACE FUNCTION pg_temp.stock(p_k text) RETURNS int LANGUAGE sql AS
$$ SELECT stock_quantity FROM public.inventory WHERE id = pg_temp.id(p_k) $$;

CREATE OR REPLACE FUNCTION pg_temp.alias(p_k text) RETURNS int LANGUAGE sql AS
$$ SELECT stock FROM public.inventory WHERE id = pg_temp.id(p_k) $$;

CREATE OR REPLACE FUNCTION pg_temp.movs(p_k text) RETURNS bigint LANGUAGE sql AS
$$ SELECT count(*) FROM public.inventory_movements WHERE inventory_item_id = pg_temp.id(p_k) $$;

CREATE OR REPLACE FUNCTION pg_temp.reqs() RETURNS bigint LANGUAGE sql AS
$$ SELECT count(*) FROM private.inventory_stock_adjustment_requests
    WHERE business_id IN (pg_temp.id('A'), pg_temp.id('B')) $$;

-- Huella de todo lo que un ajuste podria tocar en los dos negocios.
CREATE OR REPLACE FUNCTION pg_temp.huella() RETURNS text LANGUAGE sql AS $$
  SELECT md5(
    coalesce((SELECT string_agg(format('%s:%s:%s:%s', id, stock_quantity, stock, updated_at), ',' ORDER BY id)
                FROM public.inventory WHERE business_id IN (pg_temp.id('A'), pg_temp.id('B'))), '') || '|' ||
    (SELECT count(*)::text FROM public.inventory_movements WHERE business_id IN (pg_temp.id('A'), pg_temp.id('B'))) || '|' ||
    pg_temp.reqs()::text)
$$;

-- Llama al wrapper como `authenticated` con el sub dado y devuelve el jsonb.
CREATE OR REPLACE FUNCTION pg_temp.ajuste(p_uid text, p_biz text, p_items jsonb, p_source text, p_reason text, p_key text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v jsonb; v_biz uuid := pg_temp.id(p_biz);
BEGIN
  PERFORM set_config('request.jwt.claim.sub', pg_temp.id(p_uid)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v := public.apply_inventory_stock_adjustments_atomic(v_biz, p_items, p_source, p_reason, p_key);
  RESET ROLE;
  RETURN v;
END; $$;

-- Igual pero devuelve 'OK' o 'SQLSTATE mensaje' (los errores se revierten solos).
CREATE OR REPLACE FUNCTION pg_temp.ajuste_err(p_uid text, p_biz uuid, p_items jsonb, p_source text, p_reason text, p_key text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_state text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', COALESCE(pg_temp.id(p_uid)::text, ''), true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    PERFORM public.apply_inventory_stock_adjustments_atomic(p_biz, p_items, p_source, p_reason, p_key);
    v_state := 'OK';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE || ' ' || SQLERRM;
  END;
  RESET ROLE;
  RETURN v_state;
END; $$;

-- Item helpers.
CREATE OR REPLACE FUNCTION pg_temp.d(p_k text, p_delta numeric) RETURNS jsonb LANGUAGE sql AS
$$ SELECT jsonb_build_object('inventory_id', pg_temp.id(p_k), 'delta', p_delta) $$;
CREATE OR REPLACE FUNCTION pg_temp.t(p_k text, p_target numeric) RETURNS jsonb LANGUAGE sql AS
$$ SELECT jsonb_build_object('inventory_id', pg_temp.id(p_k), 'target', p_target) $$;
CREATE OR REPLACE FUNCTION pg_temp.te(p_k text, p_target numeric, p_expected numeric) RETURNS jsonb LANGUAGE sql AS
$$ SELECT jsonb_build_object('inventory_id', pg_temp.id(p_k), 'target', p_target, 'expected', p_expected) $$;

-- Item del resultado por producto.
CREATE OR REPLACE FUNCTION pg_temp.item(r jsonb, p_k text) RETURNS jsonb LANGUAGE sql AS
$$ SELECT e FROM jsonb_array_elements(r -> 'items') e WHERE (e ->> 'inventory_id')::uuid = pg_temp.id(p_k) $$;

-- El movimiento de un item aplicado, verificado contra la respuesta.
CREATE OR REPLACE FUNCTION pg_temp.mov_ok(r jsonb, p_k text, p_type text, p_prev int, p_new int, p_qty int, p_actor text)
RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.inventory_movements m
     WHERE m.id = (pg_temp.item(r, p_k) ->> 'movement_id')::uuid
       AND m.inventory_item_id = pg_temp.id(p_k)
       AND m.business_id = pg_temp.id('A')
       AND m.movement_type = p_type
       AND m.previous_stock = p_prev AND m.new_stock = p_new AND m.quantity = p_qty
       AND m.new_stock - m.previous_stock = m.quantity
       AND m.reference_type = (r ->> 'source')
       AND m.reference_id = (r ->> 'request_id')::uuid
       AND m.created_by = pg_temp.id(p_actor)
       AND m.unit_cost IS NULL)
$$;

-- ── Semilla ─────────────────────────────────────────────────────────────────
SET LOCAL session_replication_role = 'replica';
INSERT INTO auth.users(id) SELECT v FROM _id WHERE k IN ('OWN','ADM','MGR','SAL','TEC','SALNO','CASH','OWNB');
INSERT INTO businesses(id, name, owner_user_id) VALUES
  (pg_temp.id('A'), 'G2C3A1', pg_temp.id('OWN')),
  (pg_temp.id('B'), 'G2C3A1 ajeno', pg_temp.id('OWNB'));
INSERT INTO profiles(id, user_id, business_id, role, is_active, permissions) VALUES
  (pg_temp.id('OWN'),   pg_temp.id('OWN'),   pg_temp.id('A'), 'owner',   true, NULL),
  (pg_temp.id('ADM'),   pg_temp.id('ADM'),   pg_temp.id('A'), 'admin',   true, NULL),
  (pg_temp.id('MGR'),   pg_temp.id('MGR'),   pg_temp.id('A'), 'manager', true, NULL),
  (pg_temp.id('SAL'),   pg_temp.id('SAL'),   pg_temp.id('A'), 'sales',   true, NULL),
  (pg_temp.id('TEC'),   pg_temp.id('TEC'),   pg_temp.id('A'), 'tech',    true, NULL),
  (pg_temp.id('SALNO'), pg_temp.id('SALNO'), pg_temp.id('A'), 'sales',   true, '{"inventory": false}'::jsonb),
  (pg_temp.id('CASH'),  pg_temp.id('CASH'),  pg_temp.id('A'), 'cashier', true, NULL),
  (pg_temp.id('OWNB'),  pg_temp.id('OWNB'),  pg_temp.id('B'), 'owner',   true, NULL);

INSERT INTO inventory(id, business_id, name, code, category, stock_quantity, stock, cost_price, sale_price,
                      base_price, base_currency, auto_update_price, exchange_rate_used, is_active)
SELECT pg_temp.id(p.k), pg_temp.id('A'), 'A1 ' || p.k, 'G2C3A1-' || p.k, 'Rep', p.st, p.al, 600, 1000, 1000, 'ARS', false, 1, true
  FROM (VALUES
    ('P01', 10, 10), ('P02', 0, 0),  ('P03', 2, 2),   ('P04', 3, 3),   ('P05', 10, 10), ('P06', 10, 10),
    ('P07', 10, 10), ('P08', 8, 8),  ('P09', 10, 10), ('P10', 10, 10), ('P11', 10, 10), ('P12', 8, 8),
    ('P13', 10, 10), ('P14', 10, 10), ('P15', 10, 10), ('P16', 10, 10), ('P17', 10, 10), ('P18', 10, 10),
    ('P19', 10, 10), ('P20', 10, 10), ('P21', 20, 20),
    ('P22', 10, 99),                          -- alias divergente de antes (dato legado)
    ('P23', 2147483647, 2147483647),          -- techo de int4
    ('P24', 10, 10), ('P25', 10, 10), ('P26', 10, 10)
  ) AS p(k, st, al);
INSERT INTO inventory(id, business_id, name, code, category, stock_quantity, stock, cost_price, sale_price,
                      base_price, base_currency, auto_update_price, exchange_rate_used, is_active)
VALUES (pg_temp.id('XB'), pg_temp.id('B'), 'Ajeno', 'G2C3A1-XB', 'Rep', 40, 40, 600, 1000, 1000, 'ARS', false, 1, true);
SET LOCAL session_replication_role = 'origin';

-- Stock sembrado: base de la cadena de movimientos (A19).
CREATE TEMP TABLE _seed ON COMMIT DROP AS
SELECT id, stock_quantity AS st FROM public.inventory WHERE business_id IN (pg_temp.id('A'), pg_temp.id('B'));

-- ============================================================================
-- A1 · DELTA POSITIVO (manual +5: 10 -> 15) e initial_stock +7 (0 -> 7, 'in')
-- ============================================================================
DO $$
DECLARE r jsonb; i jsonb;
BEGIN
  r := pg_temp.ajuste('OWN', 'A', jsonb_build_array(pg_temp.d('P01', 5)), 'manual', 'Conteo', 'a1-manual');
  RAISE NOTICE '   A1 -> %', r::text;
  i := pg_temp.item(r, 'P01');
  PERFORM pg_temp.assert(r ->> 'status' = 'created' AND (r ->> 'ok')::boolean, 'A1.1 status created');
  PERFORM pg_temp.assert(pg_temp.stock('P01') = 15, 'A1.2 stock 10 + 5 = 15');
  PERFORM pg_temp.assert(i ->> 'status' = 'applied' AND (i ->> 'previous_stock')::int = 10 AND (i ->> 'new_stock')::int = 15
                     AND (i ->> 'quantity')::int = 5 AND i ->> 'mode' = 'delta' AND (i ->> 'delta')::int = 5,
                     'A1.3 item applied: previous 10, new 15, quantity +5');
  PERFORM pg_temp.assert(pg_temp.mov_ok(r, 'P01', 'adjustment', 10, 15, 5, 'OWN'),
    'A1.4 movimiento adjustment 10 -> 15 (+5), reference manual + request_id, created_by = actor, sin costo');
  PERFORM pg_temp.assert(pg_temp.movs('P01') = 1, 'A1.5 un solo movimiento');

  r := pg_temp.ajuste('OWN', 'A', jsonb_build_array(pg_temp.d('P02', 7)), 'initial_stock', NULL, 'a1-inicial');
  PERFORM pg_temp.assert(pg_temp.stock('P02') = 7 AND pg_temp.mov_ok(r, 'P02', 'in', 0, 7, 7, 'OWN'),
    'A1.6 initial_stock +7: 0 -> 7 con movimiento in');
  PERFORM pg_temp.assert((SELECT note FROM public.inventory_movements WHERE id = (pg_temp.item(r, 'P02') ->> 'movement_id')::uuid) = 'Stock inicial',
    'A1.7 nota del stock inicial');
END $$;

-- ============================================================================
-- A2 · DELTA NEGATIVO con stock negativo (2 - 5 = -3), sin clamp ni error
-- ============================================================================
DO $$
DECLARE r jsonb;
BEGIN
  r := pg_temp.ajuste('OWN', 'A', jsonb_build_array(pg_temp.d('P03', -5)), 'manual', NULL, 'a2-negativo');
  PERFORM pg_temp.assert(pg_temp.stock('P03') = -3, 'A2.1 stock 2 - 5 = -3 (negativo permitido)');
  PERFORM pg_temp.assert(pg_temp.mov_ok(r, 'P03', 'adjustment', 2, -3, -5, 'OWN'), 'A2.2 movimiento quantity -5, 2 -> -3');
  r := pg_temp.ajuste('OWN', 'A', jsonb_build_array(pg_temp.d('P04', -4)), 'initial_stock', NULL, 'a2-inicial-negativo');
  PERFORM pg_temp.assert(pg_temp.stock('P04') = -1 AND pg_temp.mov_ok(r, 'P04', 'out', 3, -1, -4, 'OWN'),
    'A2.3 initial_stock negativo: 3 -> -1 con movimiento out');
END $$;

-- ============================================================================
-- A3 · TARGET (10 -> 25, quantity +15 calculada por el servidor)
-- A4 · TARGET NEGATIVO (10 -> -4, quantity -14)
-- ============================================================================
DO $$
DECLARE r jsonb;
BEGIN
  r := pg_temp.ajuste('OWN', 'A', jsonb_build_array(pg_temp.t('P05', 25)), 'manual', NULL, 'a3-target');
  PERFORM pg_temp.assert(pg_temp.stock('P05') = 25 AND pg_temp.mov_ok(r, 'P05', 'adjustment', 10, 25, 15, 'OWN'),
    'A3 target 25: 10 -> 25, quantity +15');
  PERFORM pg_temp.assert((pg_temp.item(r, 'P05') ->> 'target')::int = 25 AND pg_temp.item(r, 'P05') ->> 'mode' = 'target'
                     AND pg_temp.item(r, 'P05') -> 'delta' = 'null'::jsonb, 'A3.2 el item informa modo target');
  r := pg_temp.ajuste('OWN', 'A', jsonb_build_array(pg_temp.t('P06', -4)), 'manual', NULL, 'a4-target-negativo');
  PERFORM pg_temp.assert(pg_temp.stock('P06') = -4 AND pg_temp.mov_ok(r, 'P06', 'adjustment', 10, -4, -14, 'OWN'),
    'A4 target -4: 10 -> -4, quantity -14');
END $$;

-- ============================================================================
-- A5 · IMPORT con expected OK (10, expected 10, target 7 -> 7)
-- A6 · IMPORT STALE (actual 8, expected 10, target 5 -> NO se toca)
-- ============================================================================
DO $$
DECLARE r jsonb; i jsonb; v_h text;
BEGIN
  r := pg_temp.ajuste('OWN', 'A', jsonb_build_array(pg_temp.te('P07', 7, 10)), 'import', 'Excel 2026-09', 'a5-import');
  PERFORM pg_temp.assert(pg_temp.stock('P07') = 7 AND pg_temp.mov_ok(r, 'P07', 'adjustment', 10, 7, -3, 'OWN'),
    'A5.1 import aplicado: 10 -> 7 (adjustment -3, reference import)');
  PERFORM pg_temp.assert((r ->> 'applied_count')::int = 1 AND (r ->> 'stale_count')::int = 0, 'A5.2 conteos 1 aplicado / 0 stale');
  PERFORM pg_temp.assert((SELECT note FROM public.inventory_movements WHERE id = (pg_temp.item(r, 'P07') ->> 'movement_id')::uuid)
                         = 'Importación de stock (conteo): Excel 2026-09', 'A5.3 nota con el motivo');

  r := pg_temp.ajuste('OWN', 'A', jsonb_build_array(pg_temp.te('P08', 5, 10)), 'import', NULL, 'a6-stale');
  i := pg_temp.item(r, 'P08');
  RAISE NOTICE '   A6 -> %', i::text;
  PERFORM pg_temp.assert(r ->> 'status' = 'created' AND (r ->> 'stale_count')::int = 1 AND (r ->> 'applied_count')::int = 0,
    'A6.1 la solicitud se registra con 1 stale y 0 aplicados');
  PERFORM pg_temp.assert(i ->> 'status' = 'stale' AND (i ->> 'expected')::int = 10 AND (i ->> 'current_stock')::int = 8
                     AND (i ->> 'target')::int = 5 AND i -> 'movement_id' = 'null'::jsonb AND (i ->> 'quantity')::int = 0,
    'A6.2 item stale: expected 10, current_stock 8, target 5, sin movimiento');
  PERFORM pg_temp.assert(pg_temp.stock('P08') = 8 AND pg_temp.alias('P08') = 8 AND pg_temp.movs('P08') = 0,
    'A6.3 stock 8 intacto, cero movimientos (no se pisa la venta posterior)');
END $$;

-- ============================================================================
-- A7 · BATCH PARCIAL (applied + stale + noop + stale-con-target-igual)
-- ============================================================================
DO $$
DECLARE r jsonb;
BEGIN
  r := pg_temp.ajuste('OWN', 'A', jsonb_build_array(
         pg_temp.te('P09', 12, 10),   -- applied  10 -> 12
         pg_temp.te('P10', 3, 9),     -- stale    actual 10 <> 9
         pg_temp.te('P11', 10, 10),   -- noop     target = actual
         pg_temp.te('P12', 8, 10)),   -- stale    actual 8 <> 10 aunque target = actual (expected manda)
       'import', NULL, 'a7-parcial');
  RAISE NOTICE '   A7 -> %', r::text;
  PERFORM pg_temp.assert((r ->> 'item_count')::int = 4 AND (r ->> 'applied_count')::int = 1
                     AND (r ->> 'stale_count')::int = 2 AND (r ->> 'noop_count')::int = 1,
    'A7.1 conteos: 4 items, 1 applied, 2 stale, 1 noop');
  PERFORM pg_temp.assert(pg_temp.stock('P09') = 12 AND pg_temp.movs('P09') = 1 AND pg_temp.mov_ok(r, 'P09', 'adjustment', 10, 12, 2, 'OWN'),
    'A7.2 solo el applied tiene movimiento (10 -> 12)');
  PERFORM pg_temp.assert(pg_temp.stock('P10') = 10 AND pg_temp.movs('P10') = 0 AND pg_temp.item(r, 'P10') ->> 'status' = 'stale',
    'A7.3 stale intacto');
  PERFORM pg_temp.assert(pg_temp.stock('P11') = 10 AND pg_temp.movs('P11') = 0 AND pg_temp.item(r, 'P11') ->> 'status' = 'noop'
                     AND pg_temp.item(r, 'P11') -> 'movement_id' = 'null'::jsonb,
    'A7.4 noop sin movimiento');
  PERFORM pg_temp.assert(pg_temp.stock('P12') = 8 AND pg_temp.movs('P12') = 0 AND pg_temp.item(r, 'P12') ->> 'status' = 'stale',
    'A7.5 expected desfasado es stale aunque el target coincida con el actual');
  PERFORM pg_temp.assert((SELECT array_agg(e ->> 'inventory_id' ORDER BY o) FROM jsonb_array_elements(r -> 'items') WITH ORDINALITY x(e, o))
                         = (SELECT array_agg(v::text ORDER BY v) FROM _id WHERE k IN ('P09','P10','P11','P12')),
    'A7.6 items devueltos en orden canonico (inventory_id)');
END $$;

-- ============================================================================
-- A8 · NOOP (delta 0 y target = actual): 0 movimientos, 0 escrituras
-- ============================================================================
DO $$
DECLARE r jsonb; v_upd timestamptz;
BEGIN
  SELECT updated_at INTO v_upd FROM public.inventory WHERE id = pg_temp.id('P13');
  r := pg_temp.ajuste('OWN', 'A', jsonb_build_array(pg_temp.d('P13', 0)), 'manual', NULL, 'a8-delta0');
  PERFORM pg_temp.assert(pg_temp.item(r, 'P13') ->> 'status' = 'noop' AND (r ->> 'noop_count')::int = 1
                     AND (r ->> 'applied_count')::int = 0, 'A8.1 delta 0 -> noop');
  r := pg_temp.ajuste('OWN', 'A', jsonb_build_array(pg_temp.t('P13', 10)), 'manual', NULL, 'a8-target-igual');
  PERFORM pg_temp.assert(pg_temp.item(r, 'P13') ->> 'status' = 'noop', 'A8.2 target = actual -> noop');
  PERFORM pg_temp.assert(pg_temp.movs('P13') = 0 AND pg_temp.stock('P13') = 10, 'A8.3 cero movimientos, stock intacto');
  PERFORM pg_temp.assert((SELECT updated_at FROM public.inventory WHERE id = pg_temp.id('P13')) IS NOT DISTINCT FROM v_upd,
    'A8.4 un noop no escribe la fila del producto');
  r := pg_temp.ajuste('OWN', 'A', jsonb_build_array(pg_temp.d('P13', 0)), 'initial_stock', NULL, 'a8-inicial-0');
  PERFORM pg_temp.assert(pg_temp.item(r, 'P13') ->> 'status' = 'noop' AND pg_temp.movs('P13') = 0, 'A8.5 initial_stock 0 -> noop');
END $$;

-- ============================================================================
-- A9-A11 · PAYLOAD INVALIDO: rechazo total, cero efectos (ni request)
-- ============================================================================
DO $$
DECLARE v_h text := pg_temp.huella(); v text; c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('A9 duplicado inventory_id',          jsonb_build_array(pg_temp.d('P14', 1), pg_temp.d('P14', 2)), 'manual', 'DUPLICATE_ITEM'),
    ('A9b duplicado con otro caso/forma',  jsonb_build_array(pg_temp.d('P14', 1), jsonb_build_object('inventory_id', upper(pg_temp.id('P14')::text), 'delta', 1)), 'manual', 'DUPLICATE_ITEM'),
    ('A10 delta + target',                 jsonb_build_array(jsonb_build_object('inventory_id', pg_temp.id('P14'), 'delta', 1, 'target', 5)), 'manual', 'AMBIGUOUS_ITEM'),
    ('A10b ni delta ni target',            jsonb_build_array(jsonb_build_object('inventory_id', pg_temp.id('P14'))), 'manual', 'AMBIGUOUS_ITEM'),
    ('A10c expected con delta',            jsonb_build_array(jsonb_build_object('inventory_id', pg_temp.id('P14'), 'delta', 1, 'expected', 10)), 'manual', 'AMBIGUOUS_ITEM'),
    ('A11 import sin expected',            jsonb_build_array(pg_temp.t('P14', 5)), 'import', 'MODE_NOT_ALLOWED'),
    ('A11b import con delta',              jsonb_build_array(pg_temp.d('P14', 5)), 'import', 'MODE_NOT_ALLOWED'),
    ('A11c initial_stock con target',      jsonb_build_array(pg_temp.t('P14', 5)), 'initial_stock', 'MODE_NOT_ALLOWED'),
    ('A11d item con clave no permitida',   jsonb_build_array(jsonb_build_object('inventory_id', pg_temp.id('P14'), 'delta', 1, 'stock_quantity', 99)), 'manual', 'INVALID_ITEM'),
    ('A11e item que no es objeto',         '[5]'::jsonb, 'manual', 'INVALID_ITEM'),
    ('A11f inventory_id no UUID',          '[{"inventory_id": "P14", "delta": 1}]'::jsonb, 'manual', 'INVALID_ITEM'),
    ('A11g inventory_id numerico',         '[{"inventory_id": 14, "delta": 1}]'::jsonb, 'manual', 'INVALID_ITEM'),
    ('A11h delta decimal',                 jsonb_build_array(pg_temp.d('P14', 1.5)), 'manual', 'INVALID_QUANTITY'),
    ('A11i delta como string',             jsonb_build_array(jsonb_build_object('inventory_id', pg_temp.id('P14'), 'delta', '5')), 'manual', 'INVALID_QUANTITY'),
    ('A11j delta null',                    jsonb_build_array(jsonb_build_object('inventory_id', pg_temp.id('P14'), 'delta', NULL)), 'manual', 'INVALID_QUANTITY'),
    ('A11k delta fuera de int4',           jsonb_build_array(pg_temp.d('P14', 2147483648)), 'manual', 'INVALID_QUANTITY'),
    ('A11l target decimal',                jsonb_build_array(pg_temp.t('P14', 2.25)), 'manual', 'INVALID_QUANTITY'),
    ('A11m expected string',               jsonb_build_array(jsonb_build_object('inventory_id', pg_temp.id('P14'), 'target', 5, 'expected', '10')), 'import', 'INVALID_QUANTITY'),
    ('A11n p_items objeto',                '{"inventory_id": "x"}'::jsonb, 'manual', 'ITEMS_REQUIRED'),
    ('A11o p_items vacio',                 '[]'::jsonb, 'manual', 'ITEMS_REQUIRED'),
    ('A11p p_items NULL',                  NULL::jsonb, 'manual', 'ITEMS_REQUIRED'),
    ('A11q 5001 items',                    (SELECT jsonb_agg(jsonb_build_object('inventory_id', gen_random_uuid(), 'delta', 1)) FROM generate_series(1, 5001)), 'manual', 'TOO_MANY_ITEMS')
  ) AS x(label, items, source, code)
  LOOP
    v := pg_temp.ajuste_err('OWN', pg_temp.id('A'), c.items, c.source, NULL, 'a9-' || md5(c.label));
    PERFORM pg_temp.assert(v LIKE '22023 %' AND position(c.code IN v) > 0, c.label || ' -> 22023 ' || c.code || ' (' || left(v, 110) || ')');
  END LOOP;
  PERFORM pg_temp.assert(pg_temp.huella() = v_h AND pg_temp.stock('P14') = 10,
    'A9-A11 ningun rechazo tiene efecto (stock, movimientos, requests)');
END $$;

-- ============================================================================
-- A12 · PRODUCTO AJENO / INEXISTENTE / NEGOCIO AJENO -> 42501, cero efectos
-- A13 · ACTOR SIN inventory -> 42501, cero efectos
-- ============================================================================
DO $$
DECLARE v_h text := pg_temp.huella(); v text;
BEGIN
  -- Lote con un producto propio y uno de B: NO se aplica ni el propio.
  v := pg_temp.ajuste_err('OWN', pg_temp.id('A'), jsonb_build_array(pg_temp.d('P15', 1), pg_temp.d('XB', 1)), 'manual', NULL, 'a12-ajeno');
  PERFORM pg_temp.assert(v LIKE '42501 %' AND v LIKE '%INVENTORY_NOT_FOUND_OR_TENANT_MISMATCH%', 'A12.1 producto de B en un lote de A -> 42501 (' || v || ')');
  v := pg_temp.ajuste_err('OWN', pg_temp.id('A'), jsonb_build_array(pg_temp.d('NADA', 1)), 'manual', NULL, 'a12-inexistente');
  PERFORM pg_temp.assert(v LIKE '42501 %', 'A12.2 producto inexistente -> 42501 (' || v || ')');
  -- Owner de B apuntando al negocio A (y a un producto de A).
  v := pg_temp.ajuste_err('OWNB', pg_temp.id('A'), jsonb_build_array(pg_temp.d('P15', 1)), 'manual', NULL, 'a12-negocio-ajeno');
  PERFORM pg_temp.assert(v LIKE '42501 %', 'A12.3 owner de B sobre el negocio A -> 42501 (' || v || ')');
  -- Owner de B con SU negocio pero un producto de A.
  v := pg_temp.ajuste_err('OWNB', pg_temp.id('B'), jsonb_build_array(pg_temp.d('P15', 1)), 'manual', NULL, 'a12-producto-de-a');
  PERFORM pg_temp.assert(v LIKE '42501 %', 'A12.4 owner de B con producto de A -> 42501 (' || v || ')');

  v := pg_temp.ajuste_err('TEC', pg_temp.id('A'), jsonb_build_array(pg_temp.d('P15', 1)), 'manual', NULL, 'a13-tech');
  PERFORM pg_temp.assert(v LIKE '42501 %', 'A13.1 tech (sin inventory) -> 42501 (' || v || ')');
  v := pg_temp.ajuste_err('CASH', pg_temp.id('A'), jsonb_build_array(pg_temp.d('P15', 1)), 'manual', NULL, 'a13-cashier');
  PERFORM pg_temp.assert(v LIKE '42501 %', 'A13.2 cashier (sin inventory) -> 42501 (' || v || ')');
  v := pg_temp.ajuste_err('SALNO', pg_temp.id('A'), jsonb_build_array(pg_temp.d('P15', 1)), 'manual', NULL, 'a13-sales-override');
  PERFORM pg_temp.assert(v LIKE '42501 %', 'A13.3 sales con override inventory=false -> 42501 (' || v || ')');
  v := pg_temp.ajuste_err(NULL, pg_temp.id('A'), jsonb_build_array(pg_temp.d('P15', 1)), 'manual', NULL, 'a13-sin-sub');
  PERFORM pg_temp.assert(v LIKE '42501 %', 'A13.4 authenticated sin sub -> 42501 (' || v || ')');
  v := pg_temp.ajuste_err('OWN', NULL, jsonb_build_array(pg_temp.d('P15', 1)), 'manual', NULL, 'a13-sin-negocio');
  PERFORM pg_temp.assert(v LIKE '22023 %', 'A13.5 p_business_id NULL -> 22023 (' || v || ')');
  -- Autoridad ANTES que la validacion: un actor sin permiso no aprende nada del payload.
  v := pg_temp.ajuste_err('TEC', pg_temp.id('A'), '"basura"'::jsonb, 'x', NULL, '');
  PERFORM pg_temp.assert(v LIKE '42501 %', 'A13.6 sin autoridad, un payload invalido igual da 42501 (' || v || ')');

  PERFORM pg_temp.assert(pg_temp.huella() = v_h AND pg_temp.stock('P15') = 10 AND pg_temp.stock('XB') = 40,
    'A12/A13 cero efectos en A y en B (stock, movimientos, requests)');
END $$;

-- ============================================================================
-- A14 · SALES / MANAGER / ADMIN con inventory (D5) pueden ajustar
-- ============================================================================
DO $$
DECLARE r jsonb;
BEGIN
  r := pg_temp.ajuste('SAL', 'A', jsonb_build_array(pg_temp.d('P16', 2)), 'manual', NULL, 'a14-sales');
  PERFORM pg_temp.assert(pg_temp.stock('P16') = 12 AND pg_temp.mov_ok(r, 'P16', 'adjustment', 10, 12, 2, 'SAL'),
    'A14.1 sales (inventory por defecto) ajusta: 10 -> 12, created_by = sales');
  r := pg_temp.ajuste('MGR', 'A', jsonb_build_array(pg_temp.d('P17', -1)), 'manual', NULL, 'a14-manager');
  PERFORM pg_temp.assert(pg_temp.stock('P17') = 9 AND pg_temp.mov_ok(r, 'P17', 'adjustment', 10, 9, -1, 'MGR'), 'A14.2 manager ajusta');
  r := pg_temp.ajuste('ADM', 'A', jsonb_build_array(pg_temp.te('P17', 20, 9)), 'import', NULL, 'a14-admin');
  PERFORM pg_temp.assert(pg_temp.stock('P17') = 20 AND pg_temp.mov_ok(r, 'P17', 'adjustment', 9, 20, 11, 'ADM'), 'A14.3 admin importa');
END $$;

-- ============================================================================
-- A15 · IDEMPOTENCY REPLAY (misma key + mismo payload logico)
-- ============================================================================
DO $$
DECLARE r1 jsonb; r2 jsonb; r3 jsonb; r_key jsonb; v_h text; v_req record;
BEGIN
  r1 := pg_temp.ajuste('OWN', 'A', jsonb_build_array(pg_temp.d('P18', 5), pg_temp.te('P24', 11, 10)), 'manual', 'Conteo  de   cierre', 'a15-key');
  r_key := r1;
  PERFORM pg_temp.assert(r1 ->> 'status' = 'created' AND pg_temp.stock('P18') = 15 AND pg_temp.stock('P24') = 11, 'A15.1 primera llamada: created');
  v_h := pg_temp.huella();

  -- Mismo payload logico, otra representacion: orden invertido, UUID en
  -- mayusculas, 5.0 en vez de 5, motivo con otros espacios.
  r2 := pg_temp.ajuste('OWN', 'A', jsonb_build_array(
          jsonb_build_object('expected', 10, 'target', 11.0, 'inventory_id', upper(pg_temp.id('P24')::text)),
          jsonb_build_object('inventory_id', pg_temp.id('P18'), 'delta', 5.0)),
        'manual', '  Conteo de cierre ', '  a15-key ');
  PERFORM pg_temp.assert(r2 ->> 'status' = 'existing', 'A15.2 replay: status existing');
  PERFORM pg_temp.assert((r2 - 'status') = (r1 - 'status'), 'A15.3 replay devuelve EXACTAMENTE la respuesta persistida (items, ids, conteos)');
  PERFORM pg_temp.assert(pg_temp.huella() = v_h AND pg_temp.stock('P18') = 15 AND pg_temp.movs('P18') = 1 AND pg_temp.movs('P24') = 1,
    'A15.4 el replay no mueve stock ni crea movimientos ni requests');

  -- Replay de un STALE: la clave devuelve el resultado original aunque la base cambie.
  r1 := pg_temp.ajuste('OWN', 'A', jsonb_build_array(pg_temp.te('P26', 3, 9)), 'import', NULL, 'a15-stale');
  PERFORM pg_temp.assert(pg_temp.item(r1, 'P26') ->> 'status' = 'stale', 'A15.5 import stale (actual 10, expected 9)');
  r3 := pg_temp.ajuste('OWN', 'A', jsonb_build_array(pg_temp.d('P26', -1)), 'manual', NULL, 'a15-mueve');   -- ahora actual = 9
  r2 := pg_temp.ajuste('OWN', 'A', jsonb_build_array(pg_temp.te('P26', 3, 9)), 'import', NULL, 'a15-stale');
  PERFORM pg_temp.assert(r2 ->> 'status' = 'existing' AND pg_temp.item(r2, 'P26') ->> 'status' = 'stale'
                     AND pg_temp.stock('P26') = 9 AND pg_temp.movs('P26') = 1,
    'A15.6 el replay de un stale NO reevalua: sigue stale y no aplica (confirmar = clave nueva)');

  SELECT * INTO v_req FROM private.inventory_stock_adjustment_requests
   WHERE business_id = pg_temp.id('A') AND idempotency_key = 'a15-key';
  PERFORM pg_temp.assert(v_req.status = 'completed' AND v_req.completed_at IS NOT NULL AND v_req.created_by = pg_temp.id('OWN')
                     AND v_req.item_count = 2 AND v_req.source = 'manual' AND v_req.request_hash ~ '^[0-9a-f]{64}$'
                     AND v_req.response = r_key,
    'A15.7 request persistida completa: la respuesta guardada es exactamente la devuelta');
  PERFORM pg_temp.assert(v_req.response ->> 'idempotency_key' = 'a15-key' AND v_req.response ->> 'reason' = 'Conteo de cierre'
                     AND v_req.response ->> 'status' = 'created',
    'A15.8 la clave y el motivo se guardan normalizados; la respuesta persistida dice created');
END $$;

-- ============================================================================
-- A16 · IDEMPOTENCY CONFLICT (misma key + payload distinto): 23505, sin efecto
-- ============================================================================
DO $$
DECLARE r jsonb; v text; v_h text; c record;
BEGIN
  r := pg_temp.ajuste('OWN', 'A', jsonb_build_array(pg_temp.d('P19', 5)), 'manual', 'motivo', 'a16-key');
  PERFORM pg_temp.assert(pg_temp.stock('P19') = 15, 'A16.1 primera llamada aplica 10 -> 15');
  v_h := pg_temp.huella();
  FOR c IN SELECT * FROM (VALUES
    ('otra cantidad',  jsonb_build_array(pg_temp.d('P19', 6)), 'manual', 'motivo'),
    ('otro modo',      jsonb_build_array(pg_temp.t('P19', 5)), 'manual', 'motivo'),
    ('otro producto',  jsonb_build_array(pg_temp.d('P20', 5)), 'manual', 'motivo'),
    ('otro origen',    jsonb_build_array(pg_temp.d('P19', 5)), 'initial_stock', 'motivo'),
    ('otro motivo',    jsonb_build_array(pg_temp.d('P19', 5)), 'manual', 'otro motivo'),
    ('item agregado',  jsonb_build_array(pg_temp.d('P19', 5), pg_temp.d('P20', 1)), 'manual', 'motivo')
  ) AS x(label, items, source, reason)
  LOOP
    v := pg_temp.ajuste_err('OWN', pg_temp.id('A'), c.items, c.source, c.reason, 'a16-key');
    PERFORM pg_temp.assert(v LIKE '23505 %' AND v LIKE '%IDEMPOTENCY_CONFLICT%', 'A16.2 ' || c.label || ' -> 23505 IDEMPOTENCY_CONFLICT (' || left(v, 90) || ')');
  END LOOP;
  PERFORM pg_temp.assert(pg_temp.huella() = v_h AND pg_temp.stock('P19') = 15 AND pg_temp.movs('P19') = 1,
    'A16.3 ningun conflicto tiene un segundo efecto');
  -- La clave es por negocio: la misma clave en B es otra solicitud.
  r := pg_temp.ajuste('OWNB', 'B', jsonb_build_array(pg_temp.d('XB', 1)), 'manual', 'motivo', 'a16-key');
  PERFORM pg_temp.assert(r ->> 'status' = 'created' AND pg_temp.stock('XB') = 41, 'A16.4 la misma clave en otro negocio es independiente');
END $$;

-- ============================================================================
-- A17 · DOS PRODUCTOS EN UN LOTE (payload en orden inverso al de lock)
-- ============================================================================
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM pg_temp.assert(pg_temp.id('P20') < pg_temp.id('P21'), 'A17.0 fixture: P20 < P21 por id');
  r := pg_temp.ajuste('OWN', 'A', jsonb_build_array(pg_temp.d('P21', -3), pg_temp.t('P20', 4)), 'manual', NULL, 'a17-lote');
  PERFORM pg_temp.assert((r ->> 'applied_count')::int = 2, 'A17.1 dos aplicados');
  PERFORM pg_temp.assert(pg_temp.stock('P20') = 4 AND pg_temp.mov_ok(r, 'P20', 'adjustment', 10, 4, -6, 'OWN')
                     AND pg_temp.stock('P21') = 17 AND pg_temp.mov_ok(r, 'P21', 'adjustment', 20, 17, -3, 'OWN'),
    'A17.2 ambos productos exactos (10 -> 4, 20 -> 17)');
  PERFORM pg_temp.assert((r -> 'items' -> 0 ->> 'inventory_id')::uuid = pg_temp.id('P20'), 'A17.3 items en orden de lock (id), no del payload');
  PERFORM pg_temp.assert((SELECT count(DISTINCT reference_id) FROM public.inventory_movements
                           WHERE id IN ((pg_temp.item(r, 'P20') ->> 'movement_id')::uuid, (pg_temp.item(r, 'P21') ->> 'movement_id')::uuid)) = 1,
    'A17.4 los movimientos del lote comparten reference_id = request_id');
END $$;

-- ============================================================================
-- A18 · ALIAS stock = stock_quantity (incluso partiendo de un alias divergente)
-- ============================================================================
DO $$
DECLARE r jsonb; v_bad bigint;
BEGIN
  PERFORM pg_temp.assert(pg_temp.stock('P22') = 10 AND pg_temp.alias('P22') = 99, 'A18.0 fixture: alias legado divergente (10 vs 99)');
  r := pg_temp.ajuste('OWN', 'A', jsonb_build_array(pg_temp.d('P22', 1)), 'manual', NULL, 'a18-alias');
  PERFORM pg_temp.assert(pg_temp.stock('P22') = 11 AND pg_temp.alias('P22') = 11 AND pg_temp.mov_ok(r, 'P22', 'adjustment', 10, 11, 1, 'OWN'),
    'A18.1 la autoridad lee stock_quantity y deja el alias sincronizado (11/11)');
  SELECT count(*) INTO v_bad
    FROM public.inventory i
   WHERE i.business_id = pg_temp.id('A')
     AND EXISTS (SELECT 1 FROM public.inventory_movements m WHERE m.inventory_item_id = i.id)
     AND i.stock IS DISTINCT FROM i.stock_quantity;
  PERFORM pg_temp.assert(v_bad = 0, 'A18.2 todo producto ajustado por la RPC queda con stock = stock_quantity');
END $$;

-- ============================================================================
-- A20 · SOURCE fuera de la allowlist
-- A21 · LIMITES de key / reason / rango
-- ============================================================================
DO $$
DECLARE v_h text := pg_temp.huella(); v text; r jsonb; c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES ('IMPORT'), ('adjustment'), ('purchase'), (''), (' manual'), (NULL)) AS x(src) LOOP
    v := pg_temp.ajuste_err('OWN', pg_temp.id('A'), jsonb_build_array(pg_temp.d('P24', 1)), c.src, NULL, 'a20-' || COALESCE(c.src, 'null'));
    PERFORM pg_temp.assert(v LIKE '22023 %' AND v LIKE '%INVALID_SOURCE%', 'A20 source ' || COALESCE(quote_literal(c.src), 'NULL') || ' -> 22023');
  END LOOP;

  FOR c IN SELECT * FROM (VALUES
    ('key vacia', ''), ('key solo espacios', '   '), ('key NULL', NULL),
    ('key de 201', repeat('k', 201)), ('key con salto', 'a21' || chr(10) || 'x'), ('key con tab', 'a21' || chr(9) || 'x')
  ) AS x(label, k) LOOP
    v := pg_temp.ajuste_err('OWN', pg_temp.id('A'), jsonb_build_array(pg_temp.d('P24', 1)), 'manual', NULL, c.k);
    PERFORM pg_temp.assert(v LIKE '22023 %' AND v LIKE '%INVALID_IDEMPOTENCY_KEY%', 'A21 ' || c.label || ' -> 22023');
  END LOOP;
  FOR c IN SELECT * FROM (VALUES
    ('motivo de 501', repeat('m', 501)), ('motivo con control', 'motivo' || chr(7))
  ) AS x(label, m) LOOP
    v := pg_temp.ajuste_err('OWN', pg_temp.id('A'), jsonb_build_array(pg_temp.d('P24', 1)), 'manual', c.m, 'a21-' || md5(c.label));
    PERFORM pg_temp.assert(v LIKE '22023 %' AND v LIKE '%INVALID_REASON%', 'A21 ' || c.label || ' -> 22023');
  END LOOP;
  -- Overflow del stock resultante: rechazo total (22003), nada se escribe.
  v := pg_temp.ajuste_err('OWN', pg_temp.id('A'), jsonb_build_array(pg_temp.d('P24', 1), pg_temp.d('P23', 1)), 'manual', NULL, 'a21-overflow');
  PERFORM pg_temp.assert(v LIKE '22003 %' AND v LIKE '%OUT_OF_RANGE%', 'A21 stock resultante fuera de int4 -> 22003 (' || left(v, 80) || ')');
  -- 5000 items pasan la validacion (el tope es 5000): caen recien en el lock (42501).
  v := pg_temp.ajuste_err('OWN', pg_temp.id('A'),
         (SELECT jsonb_agg(jsonb_build_object('inventory_id', gen_random_uuid(), 'delta', 1)) FROM generate_series(1, 5000)),
         'manual', NULL, 'a21-5000');
  PERFORM pg_temp.assert(v LIKE '42501 %' AND v LIKE '%5000 de 5000%', 'A21 5000 items se aceptan como lote (fallan despues por tenant) (' || left(v, 90) || ')');
  PERFORM pg_temp.assert(pg_temp.huella() = v_h, 'A20/A21 ningun rechazo tiene efecto');

  -- Limites validos: key de 200 y motivo de 500; el motivo se normaliza.
  r := pg_temp.ajuste('OWN', 'A', jsonb_build_array(pg_temp.d('P24', 1)), 'manual',
         'linea 1' || chr(10) || chr(9) || 'linea   2 ' || repeat('x', 480), repeat('k', 200));
  PERFORM pg_temp.assert(r ->> 'status' = 'created' AND length(r ->> 'idempotency_key') = 200, 'A21 key de 200 aceptada');
  PERFORM pg_temp.assert(r ->> 'reason' = 'linea 1 linea 2 ' || repeat('x', 480)
                     AND (SELECT note FROM public.inventory_movements WHERE id = (pg_temp.item(r, 'P24') ->> 'movement_id')::uuid)
                         = 'Ajuste manual de stock: linea 1 linea 2 ' || repeat('x', 480),
    'A21 motivo normalizado (saltos/tabs/espacios -> un espacio) en respuesta y nota');
  r := pg_temp.ajuste('OWN', 'A', jsonb_build_array(pg_temp.d('P24', 1)), 'manual', repeat('m', 500), 'a21-motivo-500');
  PERFORM pg_temp.assert(r ->> 'status' = 'created', 'A21 motivo de 500 aceptado');
  r := pg_temp.ajuste('OWN', 'A', jsonb_build_array(pg_temp.d('P24', 1)), 'manual', '   ', 'a21-motivo-vacio');
  PERFORM pg_temp.assert(r -> 'reason' = 'null'::jsonb
                     AND (SELECT note FROM public.inventory_movements WHERE id = (pg_temp.item(r, 'P24') ->> 'movement_id')::uuid) = 'Ajuste manual de stock',
    'A21 motivo en blanco = NULL');
END $$;

-- ============================================================================
-- MANUAL · target con expected opcional (stale por fila tambien en manual)
-- ============================================================================
DO $$
DECLARE r jsonb;
BEGIN
  r := pg_temp.ajuste('OWN', 'A', jsonb_build_array(pg_temp.te('P25', 30, 11)), 'manual', NULL, 'm-stale');
  PERFORM pg_temp.assert(pg_temp.item(r, 'P25') ->> 'status' = 'stale' AND pg_temp.stock('P25') = 10, 'M.1 manual con expected desfasado -> stale');
  r := pg_temp.ajuste('OWN', 'A', jsonb_build_array(pg_temp.te('P25', 30, 10)), 'manual', NULL, 'm-ok');
  PERFORM pg_temp.assert(pg_temp.stock('P25') = 30 AND pg_temp.mov_ok(r, 'P25', 'adjustment', 10, 30, 20, 'OWN'), 'M.2 manual con expected OK aplica');
END $$;

-- ============================================================================
-- FORMA ESTABLE DE LA RESPUESTA
-- ============================================================================
DO $$
DECLARE r jsonb;
BEGIN
  SELECT response INTO r FROM private.inventory_stock_adjustment_requests
   WHERE business_id = pg_temp.id('A') AND idempotency_key = 'a7-parcial';
  PERFORM pg_temp.assert((SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(r) k) =
    ARRAY['applied_count','business_id','idempotency_key','item_count','items','noop_count','ok','reason','request_id','source','stale_count','status'],
    'F.1 claves de la respuesta (12, estables)');
  PERFORM pg_temp.assert(NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(r -> 'items') e
       WHERE (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(e) k) IS DISTINCT FROM
             ARRAY['current_stock','delta','expected','inventory_id','mode','movement_id','movement_type','new_stock','previous_stock','quantity','status','target']),
    'F.2 cada item tiene las mismas 12 claves, cualquiera sea su status');
  PERFORM pg_temp.assert(r::text !~* '(cost|precio|price)', 'F.3 la respuesta no expone costos ni precios');
END $$;

-- ============================================================================
-- A19 · INVARIANTE POR MOVIMIENTO: new_stock - previous_stock = quantity
-- ============================================================================
DO $$
DECLARE v_total bigint; v_bad bigint; v_chain bigint; v_sum bigint;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE new_stock - previous_stock <> quantity OR quantity = 0)
    INTO v_total, v_bad
    FROM public.inventory_movements WHERE business_id IN (pg_temp.id('A'), pg_temp.id('B'));
  PERFORM pg_temp.assert(v_total >= 20 AND v_bad = 0, 'A19.1 los ' || v_total || ' movimientos del test cumplen new - previous = quantity (<> 0)');
  -- Todo cambio de stock del test paso por la RPC: sembrado + SUM(quantity) = actual.
  SELECT count(*) INTO v_sum
    FROM public.inventory i JOIN _seed s ON s.id = i.id
   WHERE i.stock_quantity IS DISTINCT FROM s.st + COALESCE((SELECT sum(m.quantity) FROM public.inventory_movements m
                                                              WHERE m.inventory_item_id = i.id), 0);
  PERFORM pg_temp.assert(v_sum = 0, 'A19.2 cada producto: stock sembrado + SUM(quantity) = stock actual (' || v_sum || ' desvios)');
  -- Cadena continua (balance euleriano, O(n)): los movimientos son aristas
  -- previous -> new; serializados forman UN camino del sembrado al actual.
  WITH e AS (
    SELECT m.inventory_item_id AS item, m.previous_stock AS p, m.new_stock AS n
      FROM public.inventory_movements m JOIN _seed s ON s.id = m.inventory_item_id
  ), deg AS (
    SELECT item, v, sum(o) AS d FROM (SELECT item, p AS v, 1 AS o FROM e UNION ALL SELECT item, n, -1 FROM e) t GROUP BY item, v
  )
  SELECT count(*) INTO v_chain
    FROM deg JOIN _seed s ON s.id = deg.item JOIN public.inventory i ON i.id = deg.item
   WHERE deg.d <> (CASE WHEN deg.v = s.st THEN 1 ELSE 0 END) - (CASE WHEN deg.v = i.stock_quantity THEN 1 ELSE 0 END);
  PERFORM pg_temp.assert(v_chain = 0, 'A19.3 cadena continua por producto: previous(N+1) = new(N) desde el stock sembrado');
  PERFORM pg_temp.assert(NOT EXISTS (
      SELECT 1 FROM public.inventory_movements m
       WHERE m.business_id = pg_temp.id('A')
         AND (m.reference_type NOT IN ('initial_stock', 'import', 'manual')
              OR m.reference_id NOT IN (SELECT id FROM private.inventory_stock_adjustment_requests)
              OR m.created_by IS NULL)),
    'A19.4 todo movimiento del test es de la RPC: reference_type = source, reference_id = request, created_by');
  PERFORM pg_temp.assert(NOT EXISTS (
      SELECT 1 FROM public.inventory_movements m
       WHERE m.business_id = pg_temp.id('A')
         AND m.movement_type <> CASE WHEN m.reference_type = 'initial_stock' AND m.quantity > 0 THEN 'in'
                                     WHEN m.reference_type = 'initial_stock' THEN 'out'
                                     ELSE 'adjustment' END),
    'A19.5 mapping: initial_stock -> in/out; import/manual -> adjustment');
END $$;

-- ============================================================================
-- A22 · ACL de API y superficie
-- ============================================================================
DO $$
DECLARE v_wrap regprocedure := 'public.apply_inventory_stock_adjustments_atomic(uuid,jsonb,text,text,text)';
        v_impl regprocedure := 'private.apply_inventory_stock_adjustments_impl(uuid,jsonb,text,text,text)';
BEGIN
  PERFORM pg_temp.assert(has_function_privilege('authenticated', v_wrap, 'EXECUTE'), 'A22.1 authenticated SI ejecuta el wrapper');
  PERFORM pg_temp.assert(NOT has_function_privilege('anon', v_wrap, 'EXECUTE'), 'A22.2 anon NO ejecuta el wrapper');
  PERFORM pg_temp.assert(NOT has_function_privilege('service_role', v_wrap, 'EXECUTE'), 'A22.3 service_role NO ejecuta el wrapper');
  PERFORM pg_temp.assert(NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid IN (v_wrap, v_impl) AND a.grantee = 0),
    'A22.4 PUBLIC sin EXECUTE en wrapper ni impl');
  PERFORM pg_temp.assert(NOT has_function_privilege('anon', v_impl, 'EXECUTE') AND NOT has_function_privilege('authenticated', v_impl, 'EXECUTE')
                     AND NOT has_function_privilege('service_role', v_impl, 'EXECUTE'), 'A22.5 la API NO ejecuta el impl privado');
  PERFORM pg_temp.assert(NOT has_table_privilege('authenticated', 'private.inventory_stock_adjustment_requests', 'SELECT')
                     AND NOT has_table_privilege('authenticated', 'private.inventory_stock_adjustment_requests', 'INSERT')
                     AND NOT has_table_privilege('authenticated', 'private.inventory_stock_adjustment_requests', 'UPDATE')
                     AND NOT has_table_privilege('anon', 'private.inventory_stock_adjustment_requests', 'SELECT')
                     AND NOT has_table_privilege('service_role', 'private.inventory_stock_adjustment_requests', 'SELECT'),
    'A22.6 la tabla de requests no tiene privilegios de API');

  -- Se pregunta "¿puede?" con has_*_privilege y NO invocando: en postgres
  -- 17.6.1.x, SET LOCAL ROLE + llamada a una funcion SIN privilegio dentro de un
  -- bloque con EXCEPTION tumba el backend (SIGSEGV medido en el Security Gate).
  PERFORM pg_temp.assert(NOT has_schema_privilege('anon', 'private', 'USAGE')
                     AND NOT has_schema_privilege('authenticated', 'private', 'USAGE'),
    'A22.7 el schema private no es usable por anon/authenticated (ni el impl ni la tabla son alcanzables)');
  PERFORM pg_temp.assert(NOT EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
                                      WHERE c.oid = 'private.inventory_stock_adjustment_requests'::regclass AND a.grantee = 0),
    'A22.8 PUBLIC sin privilegios sobre la tabla de requests');
  PERFORM pg_temp.assert(NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'private.inventory_stock_adjustment_requests'::regclass)
                     AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'private.inventory_stock_adjustment_requests'::regclass),
    'A22.9 tabla de requests con RLS y sin policies: solo la RPC la escribe');
  PERFORM pg_temp.assert(NOT has_function_privilege('anon', v_wrap, 'EXECUTE') AND NOT has_function_privilege('public', v_wrap, 'EXECUTE'),
    'A22.10 ni anon ni PUBLIC pueden ejecutar el wrapper');
END $$;

-- ============================================================================
-- CATALOGO · contrato estructural sobre el estado final
-- ============================================================================
DO $$
DECLARE v_impl text; v_wrap text; v_n int; s record;
BEGIN
  SELECT prosrc INTO v_impl FROM pg_proc WHERE oid = 'private.apply_inventory_stock_adjustments_impl(uuid,jsonb,text,text,text)'::regprocedure;
  SELECT prosrc INTO v_wrap FROM pg_proc WHERE oid = 'public.apply_inventory_stock_adjustments_atomic(uuid,jsonb,text,text,text)'::regprocedure;
  PERFORM pg_temp.assert(position('private.lock_inventory_rows(p_business_id, v_ids)' IN v_impl) > 0
                     AND position('private.lock_inventory_rows(' IN v_impl) < position('UPDATE public.inventory' IN v_impl),
    'C.1 el impl toma el lock canonico G2-C.2 antes del UPDATE de stock');
  PERFORM pg_temp.assert(v_impl !~* 'from\s+(public\.)?inventory\y[^;]*\yfor\s+update\y', 'C.2 el impl no bloquea inventory FOR UPDATE');
  PERFORM pg_temp.assert(v_impl !~* '\y(greatest|least)\s*\(' AND v_impl !~* 'insuficiente', 'C.3 sin clamp ni "stock insuficiente"');
  PERFORM pg_temp.assert(v_impl !~* '(update|delete\s+from)\s+(public\.)?inventory_movements\y', 'C.4 sin UPDATE/DELETE de movimientos');
  PERFORM pg_temp.assert(position('private.has_action_authority(p_business_id, ''inventory''' IN v_wrap) > 0, 'C.5 el wrapper exige la autoridad inventory');
  PERFORM pg_temp.assert((SELECT prosecdef AND proconfig = ARRAY['search_path=pg_catalog, pg_temp'] AND pg_get_userbyid(proowner) = 'postgres'
                            FROM pg_proc WHERE oid = 'public.apply_inventory_stock_adjustments_atomic(uuid,jsonb,text,text,text)'::regprocedure)
                     AND (SELECT NOT prosecdef AND proconfig = ARRAY['search_path=pg_catalog, pg_temp'] AND pg_get_userbyid(proowner) = 'postgres'
                            FROM pg_proc WHERE oid = 'private.apply_inventory_stock_adjustments_impl(uuid,jsonb,text,text,text)'::regprocedure),
    'C.6 wrapper DEFINER / impl INVOKER, owner postgres, search_path pg_catalog, pg_temp');
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'private') AND p.prokind = 'f'
     AND p.prosrc ~* 'update\s+(public\.)?inventory\y[^;]*\yset\y[^;]*\ystock(_quantity)?\y\s*=';
  PERFORM pg_temp.assert(v_n = 8, 'C.7 writers de stock server-side = 7 documentales + G2-C.3A1 (' || v_n || ')');
  PERFORM pg_temp.assert(EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'private.inventory_stock_adjustment_requests'::regclass
                                   AND contype = 'u' AND conname = 'inventory_stock_adjustment_requests_key_uq'),
    'C.8 UNIQUE (business_id, idempotency_key) presente');
  -- A1 es aditivo; el cierre de la escritura directa lo hace G2-C.3A3
  -- (20261009120000), que ya forma parte del replay: A1 queda como la UNICA via
  -- del navegador hacia el saldo que no nace de un documento.
  PERFORM pg_temp.assert(NOT has_column_privilege('authenticated', 'public.inventory', 'stock_quantity', 'UPDATE')
                     AND NOT has_table_privilege('authenticated', 'public.inventory_movements', 'INSERT')
                     AND has_function_privilege('authenticated', 'public.apply_inventory_stock_adjustments_atomic(uuid,jsonb,text,text,text)', 'EXECUTE'),
    'C.9 tras G2-C.3A3 la escritura directa esta cerrada y A1 es la via (A1 sigue ejecutable por authenticated)');
END $$;

\echo 'G2-C.3A1 · matriz OK'
ROLLBACK;
