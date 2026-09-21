-- ============================================================================
-- G2-B · Regresion del P0 G2-P0-1 — inmutabilidad de `comprobante_items`.
--
-- Reproduce el caso EXACTO del discovery de BETA-GATE-2: un comprobante de
-- 1 x 1000 con impacto economico real, atacado por el camino autenticado
-- (UPDATE directo por PostgREST) para llevarlo a 5 x 1000.
--
-- Antes de G2-B eso pasaba en silencio y dejaba total=5000, caja=1000 y el
-- ledger devengado reescrito. Ahora la DB lo rechaza y NADA deriva.
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

-- Ejecuta un SQL como `authenticated` (el camino del atacante) y devuelve el
-- SQLSTATE, o 'OK' si no hubo error. Es la unica forma honesta de afirmar que
-- el rechazo viene de la DB y no del cliente.
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

\set biz  '00000000-0000-0000-0000-00000000b201'
\set OWN  '00000000-0000-0000-0000-00000000b209'
\set CUST '00000000-0000-0000-0000-00000000b2c1'
\set INV  '00000000-0000-0000-0000-00000000b2d1'
\set CAJA '00000000-0000-0000-0000-00000000b261'
\set DRAFT '00000000-0000-0000-0000-00000000b2f1'

-- ── Semilla ─────────────────────────────────────────────────────────────────
SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'OWN');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','G2B',:'OWN');
-- profiles.id = auth.uid() es la forma canonica (provision_my_business).
INSERT INTO profiles(id,business_id,role,is_active) VALUES (:'OWN',:'biz','owner',true);
INSERT INTO customers(id,business_id,name,phone,customer_type)
  VALUES (:'CUST',:'biz','Cliente G2B','+540099','minorista');
INSERT INTO inventory(id,business_id,name,code,category,stock_quantity,stock,cost_price,sale_price,
                      base_price,base_currency,auto_update_price,exchange_rate_used,is_active)
  VALUES (:'INV',:'biz','Prod G2B','G2B-1','Rep',100,100,600,1000,1000,'ARS',false,1,true);
INSERT INTO cajas(id,business_id,opened_by,status) VALUES (:'CAJA',:'biz',:'OWN','abierta');
SET LOCAL session_replication_role='origin';

-- ============================================================================
-- A + B · Venta 1 x 1000 por el camino canonico (produce impacto economico)
-- ============================================================================
DO $$
DECLARE r jsonb; v_comp uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000b209', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-00000000b201'::uuid,'G2B1','hg2b1',
    jsonb_build_object('tipo','remito','punto_venta','0001','condicion_fiscal','Consumidor Final',
      'customer_id','00000000-0000-0000-0000-00000000b2c1','cc_total',0,'emitir_en_arca',false,
      'items', jsonb_build_array(jsonb_build_object(
        'inventory_id','00000000-0000-0000-0000-00000000b2d1','descripcion','Linea',
        'tipo_linea','producto','cantidad',1,'precio_unitario',1000)),
      'pagos', jsonb_build_array(jsonb_build_object(
        'amount',1000,'amount_ars',1000,'payment_method','efectivo'))));
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status' = 'created',
    'A · el checkout canonico crea la venta 1 x 1000 (status=' || COALESCE(r->>'status','?') || ')');
  v_comp := (r->>'comprobante_id')::uuid;
  PERFORM set_config('g2b.comp', v_comp::text, true);

  -- NEGATIVE CONTROL 1: el camino canonico NO fue bloqueado por el guard nuevo
  -- aunque inserte items y despues los marque con stock_processed.
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM comprobante_items WHERE comprobante_id = v_comp) = 1,
    'A · el guard NO rompio la creacion canonica de items');
  PERFORM pg_temp.assert(
    (SELECT bool_and(stock_processed) FROM comprobante_items WHERE comprobante_id = v_comp),
    'A · el guard NO rompio el UPDATE canonico de stock_processed');
END $$;

-- El predicado reconoce el impacto.
DO $$
DECLARE v_comp uuid := current_setting('g2b.comp')::uuid; v_imp boolean;
BEGIN
  SELECT tiene_impacto INTO v_imp
    FROM public.comprobante_impacto_economico('00000000-0000-0000-0000-00000000b201'::uuid, v_comp);
  PERFORM pg_temp.assert(v_imp, 'B · el predicado detecta impacto economico');
END $$;

-- ── Snapshot ANTES de los ataques ───────────────────────────────────────────
CREATE TEMP TABLE g2b_antes AS
SELECT
  (SELECT total           FROM comprobantes WHERE id = current_setting('g2b.comp')::uuid) AS total,
  (SELECT total_cobrado   FROM comprobantes WHERE id = current_setting('g2b.comp')::uuid) AS cobrado,
  (SELECT saldo_pendiente FROM comprobantes WHERE id = current_setting('g2b.comp')::uuid) AS saldo,
  (SELECT estado_comercial FROM comprobantes WHERE id = current_setting('g2b.comp')::uuid) AS estado_com,
  (SELECT count(*)        FROM comprobante_items WHERE comprobante_id = current_setting('g2b.comp')::uuid) AS n_items,
  (SELECT sum(cantidad)   FROM comprobante_items WHERE comprobante_id = current_setting('g2b.comp')::uuid) AS cantidad,
  (SELECT sum(subtotal)   FROM comprobante_items WHERE comprobante_id = current_setting('g2b.comp')::uuid) AS subtotal,
  (SELECT sum(costo_total) FROM comprobante_items WHERE comprobante_id = current_setting('g2b.comp')::uuid) AS cogs,
  (SELECT COALESCE(sum(amount_ars),0) FROM financial_movements WHERE comprobante_id = current_setting('g2b.comp')::uuid) AS caja,
  (SELECT COALESCE(sum(debit-credit),0) FROM account_movements WHERE reference_type='comprobante' AND reference_id = current_setting('g2b.comp')::uuid) AS cc,
  (SELECT stock_quantity  FROM inventory WHERE id='00000000-0000-0000-0000-00000000b2d1') AS stock,
  (SELECT count(*)        FROM inventory_movements WHERE reference_type='comprobante' AND reference_id = current_setting('g2b.comp')::uuid) AS n_mov,
  (SELECT COALESCE(sum(amount_ars),0) FROM business_finance_entries WHERE reference_comprobante_id = current_setting('g2b.comp')::uuid) AS bfe,
  (SELECT COALESCE(sum(sales_amount_ars),0) FROM v_finance_sales_ledger WHERE comprobante_id = current_setting('g2b.comp')::uuid) AS ledger;

-- ============================================================================
-- C + D · EL ATAQUE — UPDATE 1x1000 -> 5x1000 por el camino autenticado
-- ============================================================================
DO $$
DECLARE v_comp uuid := current_setting('g2b.comp')::uuid; v_item uuid; v_res text;
BEGIN
  SELECT id INTO v_item FROM comprobante_items WHERE comprobante_id = v_comp LIMIT 1;

  v_res := pg_temp.como_authenticated('00000000-0000-0000-0000-00000000b209'::uuid,
    format('UPDATE comprobante_items SET cantidad = 5, subtotal = 5000 WHERE id = %L', v_item));
  RAISE NOTICE '   UPDATE -> %', v_res;
  PERFORM pg_temp.assert(v_res LIKE '0A000%' AND v_res LIKE '%COMPROBANTE_ITEMS_INMUTABLE%',
    'C · el UPDATE 1x1000 -> 5x1000 es RECHAZADO por la DB');

  v_res := pg_temp.como_authenticated('00000000-0000-0000-0000-00000000b209'::uuid,
    format($f$INSERT INTO comprobante_items
             (comprobante_id, business_id, descripcion, tipo_linea, cantidad, precio_unitario, subtotal)
             VALUES (%L, '00000000-0000-0000-0000-00000000b201', 'Linea inyectada', 'producto', 3, 1000, 3000)$f$, v_comp));
  RAISE NOTICE '   INSERT -> %', v_res;
  PERFORM pg_temp.assert(v_res LIKE '0A000%' AND v_res LIKE '%COMPROBANTE_ITEMS_INMUTABLE%',
    'D1 · el INSERT de un item posterior al impacto es RECHAZADO');

  v_res := pg_temp.como_authenticated('00000000-0000-0000-0000-00000000b209'::uuid,
    format('DELETE FROM comprobante_items WHERE id = %L', v_item));
  RAISE NOTICE '   DELETE -> %', v_res;
  PERFORM pg_temp.assert(v_res LIKE '0A000%' AND v_res LIKE '%COMPROBANTE_ITEMS_INMUTABLE%',
    'D2 · el DELETE de un item posterior al impacto es RECHAZADO');
END $$;

-- ============================================================================
-- E · NADA DERIVO tras los tres intentos rechazados
-- ============================================================================
DO $$
DECLARE a g2b_antes%ROWTYPE; v_comp uuid := current_setting('g2b.comp')::uuid;
BEGIN
  SELECT * INTO a FROM g2b_antes;
  PERFORM pg_temp.assert((SELECT total FROM comprobantes WHERE id=v_comp) = a.total
    AND a.total = 1000, 'E · comprobantes.total sigue en 1000');
  PERFORM pg_temp.assert((SELECT count(*) FROM comprobante_items WHERE comprobante_id=v_comp) = a.n_items
    AND a.n_items = 1, 'E · sigue habiendo exactamente 1 item');
  PERFORM pg_temp.assert((SELECT sum(cantidad) FROM comprobante_items WHERE comprobante_id=v_comp) = a.cantidad
    AND a.cantidad = 1, 'E · el item sigue siendo 1 unidad');
  PERFORM pg_temp.assert((SELECT sum(subtotal) FROM comprobante_items WHERE comprobante_id=v_comp) = a.subtotal
    AND a.subtotal = 1000, 'E · el subtotal del item sigue en 1000');
  PERFORM pg_temp.assert((SELECT total_cobrado FROM comprobantes WHERE id=v_comp) = a.cobrado,
    'E · total_cobrado no cambio');
  PERFORM pg_temp.assert((SELECT saldo_pendiente FROM comprobantes WHERE id=v_comp) = a.saldo,
    'E · saldo_pendiente no cambio');
  PERFORM pg_temp.assert((SELECT estado_comercial FROM comprobantes WHERE id=v_comp) = a.estado_com,
    'E · estado_comercial no cambio');
  PERFORM pg_temp.assert(
    (SELECT COALESCE(sum(amount_ars),0) FROM financial_movements WHERE comprobante_id=v_comp) = a.caja,
    'E · CAJA no cambio');
  PERFORM pg_temp.assert(
    (SELECT COALESCE(sum(debit-credit),0) FROM account_movements WHERE reference_type='comprobante' AND reference_id=v_comp) = a.cc,
    'E · cuenta corriente no cambio');
  PERFORM pg_temp.assert(
    (SELECT stock_quantity FROM inventory WHERE id='00000000-0000-0000-0000-00000000b2d1') = a.stock,
    'E · stock no cambio');
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM inventory_movements WHERE reference_type='comprobante' AND reference_id=v_comp) = a.n_mov,
    'E · inventory_movements no cambio');
  PERFORM pg_temp.assert(
    (SELECT COALESCE(sum(costo_total),0) FROM comprobante_items WHERE comprobante_id=v_comp) = a.cogs,
    'E · COGS no cambio');
  PERFORM pg_temp.assert(
    (SELECT COALESCE(sum(amount_ars),0) FROM business_finance_entries WHERE reference_comprobante_id=v_comp) = a.bfe,
    'E · business_finance_entries no cambio');
  PERFORM pg_temp.assert(
    (SELECT COALESCE(sum(sales_amount_ars),0) FROM v_finance_sales_ledger WHERE comprobante_id=v_comp) = a.ledger
    AND a.ledger = 1000, 'E · el ledger devengado sigue en 1000 (no fue reescrito)');
END $$;

-- ============================================================================
-- NEGATIVE CONTROL 2 · un borrador SIN impacto economico sigue siendo editable
-- ============================================================================
DO $$
DECLARE v_res text; v_item uuid;
BEGIN
  -- Borrador genuino: documento sin pagos, sin stock, sin caja, sin CC.
  INSERT INTO comprobantes(id, business_id, tipo, estado, estado_fiscal, estado_comercial,
                           numero, fecha, total, total_cobrado, saldo_pendiente)
    VALUES ('00000000-0000-0000-0000-00000000b2f1','00000000-0000-0000-0000-00000000b201',
            'remito','borrador','no_fiscal','pendiente','BORRADOR-1', now(), 0, 0, 0);

  v_res := pg_temp.como_authenticated('00000000-0000-0000-0000-00000000b209'::uuid,
    $f$INSERT INTO comprobante_items
       (comprobante_id, business_id, descripcion, tipo_linea, cantidad, precio_unitario, subtotal)
       VALUES ('00000000-0000-0000-0000-00000000b2f1','00000000-0000-0000-0000-00000000b201',
               'Linea legitima','producto',2,500,1000)$f$);
  RAISE NOTICE '   INSERT en borrador -> %', v_res;
  PERFORM pg_temp.assert(v_res = 'OK',
    'NC2 · ANTES del impacto economico, el INSERT legitimo de items FUNCIONA');

  SELECT id INTO v_item FROM comprobante_items
   WHERE comprobante_id='00000000-0000-0000-0000-00000000b2f1' LIMIT 1;

  v_res := pg_temp.como_authenticated('00000000-0000-0000-0000-00000000b209'::uuid,
    format('UPDATE comprobante_items SET cantidad = 4, subtotal = 2000 WHERE id = %L', v_item));
  PERFORM pg_temp.assert(v_res = 'OK',
    'NC2 · ANTES del impacto economico, el UPDATE legitimo FUNCIONA');

  v_res := pg_temp.como_authenticated('00000000-0000-0000-0000-00000000b209'::uuid,
    format('DELETE FROM comprobante_items WHERE id = %L', v_item));
  PERFORM pg_temp.assert(v_res = 'OK',
    'NC2 · ANTES del impacto economico, el DELETE legitimo FUNCIONA');
END $$;

-- ============================================================================
-- NEGATIVE CONTROL 3 · el guard no se apoya en `estado`
-- ============================================================================
-- Un borrador SIN efectos sigue editable aunque se lo marque `emitido`: lo que
-- bloquea es el impacto REAL, no la etiqueta. (Al reves de lo que hacia el
-- frontend, que gateaba por `estado === 'borrador'`.)
DO $$
DECLARE v_res text;
BEGIN
  UPDATE comprobantes SET estado='emitido' WHERE id='00000000-0000-0000-0000-00000000b2f1';
  v_res := pg_temp.como_authenticated('00000000-0000-0000-0000-00000000b209'::uuid,
    $f$INSERT INTO comprobante_items
       (comprobante_id, business_id, descripcion, tipo_linea, cantidad, precio_unitario, subtotal)
       VALUES ('00000000-0000-0000-0000-00000000b2f1','00000000-0000-0000-0000-00000000b201',
               'Otra linea','producto',1,100,100)$f$);
  PERFORM pg_temp.assert(v_res = 'OK',
    'NC3 · `estado=emitido` sin efectos reales NO bloquea (el gate mira efectos, no etiquetas)');
END $$;

-- ============================================================================
-- NEGATIVE CONTROL 4 · el guard SI distingue cada senal de impacto por separado
-- ============================================================================
DO $$
DECLARE v_res text;
BEGIN
  -- Basta un movimiento de caja imputado al borrador para congelarlo.
  INSERT INTO financial_movements(business_id, type, amount, amount_ars, currency, exchange_rate,
                                  description, date, comprobante_id, caja_id)
    VALUES ('00000000-0000-0000-0000-00000000b201','income',1,1,'ARS',1,'probe G2B',
            public.ar_today(),'00000000-0000-0000-0000-00000000b2f1',
            '00000000-0000-0000-0000-00000000b261');

  v_res := pg_temp.como_authenticated('00000000-0000-0000-0000-00000000b209'::uuid,
    $f$INSERT INTO comprobante_items
       (comprobante_id, business_id, descripcion, tipo_linea, cantidad, precio_unitario, subtotal)
       VALUES ('00000000-0000-0000-0000-00000000b2f1','00000000-0000-0000-0000-00000000b201',
               'Tardia','producto',1,100,100)$f$);
  RAISE NOTICE '   INSERT tras movimiento de caja -> %', v_res;
  PERFORM pg_temp.assert(v_res LIKE '0A000%',
    'NC4 · un movimiento de CAJA por si solo ya congela los items');
END $$;

-- ============================================================================
-- NEGATIVE CONTROL 5 · la ANULACION CANONICA sigue funcionando
-- ============================================================================
-- Requisito explicito del contrato: el guard no puede romper las rutas
-- canonicas de anulacion/reversa. `annul_comprobante_atomic` con devolucion de
-- stock hace `UPDATE comprobante_items SET stock_processed = false` sobre un
-- comprobante que —por definicion— YA tiene impacto economico. Si el guard no
-- estuviera exento dentro de la SECDEF, la anulacion moriria con 0A000 y el
-- unico camino de correccion que este lote deja abierto quedaria cerrado.
-- Se prueba de verdad, no se asume.
DO $$
DECLARE r jsonb; a jsonb; v_comp uuid; v_stock_pre int; v_stock_post int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000b209', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-00000000b201'::uuid,'G2B-ANL','hg2banl',
    jsonb_build_object('tipo','remito','punto_venta','0001','condicion_fiscal','Consumidor Final',
      'customer_id','00000000-0000-0000-0000-00000000b2c1','cc_total',0,'emitir_en_arca',false,
      'items', jsonb_build_array(jsonb_build_object(
        'inventory_id','00000000-0000-0000-0000-00000000b2d1','descripcion','Para anular',
        'tipo_linea','producto','cantidad',2,'precio_unitario',1000)),
      'pagos', jsonb_build_array(jsonb_build_object(
        'amount',2000,'amount_ars',2000,'payment_method','efectivo'))));
  RESET ROLE;
  v_comp := (r->>'comprobante_id')::uuid;
  PERFORM pg_temp.assert(v_comp IS NOT NULL, 'NC5 · venta previa a la anulacion creada');

  SELECT stock_quantity INTO v_stock_pre FROM inventory WHERE id='00000000-0000-0000-0000-00000000b2d1';

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000b209', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  a := annul_comprobante_atomic(v_comp, 'refund_current_session', 'NC5 G2-B', true, 'ANLG2B');
  RESET ROLE;

  RAISE NOTICE '   anulacion -> ok=% error=%', COALESCE(a->>'ok','?'), COALESCE(a->>'error','-');
  PERFORM pg_temp.assert(COALESCE(a->>'ok','false')::boolean,
    'NC5 · la anulacion canonica NO es bloqueada por el guard');

  -- Y efectivamente toco los items (limpio el marcador de stock procesado).
  PERFORM pg_temp.assert(
    NOT COALESCE((SELECT bool_or(stock_processed) FROM comprobante_items WHERE comprobante_id=v_comp), false),
    'NC5 · la anulacion pudo escribir comprobante_items (stock_processed = false)');

  SELECT stock_quantity INTO v_stock_post FROM inventory WHERE id='00000000-0000-0000-0000-00000000b2d1';
  PERFORM pg_temp.assert(v_stock_post > v_stock_pre,
    'NC5 · la devolucion de stock de la anulacion se aplico');
END $$;

SELECT 'G2-B: todas las aserciones pasaron' AS resultado;
ROLLBACK;
