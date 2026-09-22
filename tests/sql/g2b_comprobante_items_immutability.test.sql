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

-- ============================================================================
-- BLOCKER 1 · REPARENTING — mover la linea a otro documento / otro negocio
-- ============================================================================
-- El bypass original: el guard evaluaba COALESCE(NEW..., OLD...) y en UPDATE
-- NEW gana. Con A impactado (inmutable) y B borrador limpio, un
-- `SET comprobante_id = B` hacia que el guard evaluara B —mutable— y dejara
-- pasar la operacion, retirando de hecho una linea de A.
\set B_LIMPIO '00000000-0000-0000-0000-00000000b2f2'

DO $$
DECLARE v_compA uuid := current_setting('g2b.comp')::uuid;
        v_item uuid; v_res text;
        a_items int; a_total numeric; b_items int;
BEGIN
  -- B: borrador limpio del MISMO negocio.
  INSERT INTO comprobantes(id, business_id, tipo, estado, estado_fiscal, estado_comercial,
                           numero, fecha, total, total_cobrado, saldo_pendiente)
    VALUES ('00000000-0000-0000-0000-00000000b2f2','00000000-0000-0000-0000-00000000b201',
            'remito','borrador','no_fiscal','pendiente','B-LIMPIO', now(), 0, 0, 0);

  SELECT id INTO v_item FROM comprobante_items WHERE comprobante_id = v_compA LIMIT 1;
  SELECT count(*), max(total) INTO a_items, a_total
    FROM comprobante_items ci JOIN comprobantes c ON c.id = ci.comprobante_id
   WHERE ci.comprobante_id = v_compA GROUP BY c.total;

  -- 4 · mover el item de A (impactado) a B (limpio)
  v_res := pg_temp.como_authenticated('00000000-0000-0000-0000-00000000b209'::uuid,
    format($f$UPDATE comprobante_items SET comprobante_id = '00000000-0000-0000-0000-00000000b2f2' WHERE id = %L$f$, v_item));
  RAISE NOTICE '   reparent A->B -> %', v_res;
  PERFORM pg_temp.assert(v_res LIKE '0A000%' AND v_res LIKE '%REPARENT_PROHIBIDO%',
    'B1 · mover un item de un comprobante impactado a otro limpio es RECHAZADO');

  -- 5 · cambiar el negocio de la linea
  v_res := pg_temp.como_authenticated('00000000-0000-0000-0000-00000000b209'::uuid,
    format($f$UPDATE comprobante_items SET business_id = '00000000-0000-0000-0000-00000000b301' WHERE id = %L$f$, v_item));
  RAISE NOTICE '   reparent business -> %', v_res;
  PERFORM pg_temp.assert(v_res LIKE '0A000%' AND v_res LIKE '%REPARENT_PROHIBIDO%',
    'B1 · cambiar el business_id de un item es RECHAZADO');

  -- 5 · A y B quedan exactamente iguales
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM comprobante_items WHERE comprobante_id = v_compA) = a_items,
    'B1 · A conserva todos sus items');
  SELECT count(*) INTO b_items FROM comprobante_items
   WHERE comprobante_id = '00000000-0000-0000-0000-00000000b2f2';
  PERFORM pg_temp.assert(b_items = 0, 'B1 · B no recibio ninguna linea ajena');
  PERFORM pg_temp.assert((SELECT total FROM comprobantes WHERE id = v_compA) = 1000,
    'B1 · el total de A sigue en 1000');
END $$;

-- 15 · el period lock del ORIGEN no se puede evadir moviendo la linea.
-- Con el reparenting cerrado la evasion es inexpresable; ademas se comprueba
-- que el period lock efectivamente aplica sobre `comprobante_items` (G2-P1-C).
DO $$
DECLARE v_res text; v_item uuid;
BEGIN
  -- Borrador limpio con fecha en un periodo que se cierra.
  INSERT INTO comprobantes(id, business_id, tipo, estado, estado_fiscal, estado_comercial,
                           numero, fecha, total, total_cobrado, saldo_pendiente)
    VALUES ('00000000-0000-0000-0000-00000000b2f3','00000000-0000-0000-0000-00000000b201',
            'remito','borrador','no_fiscal','pendiente','CERRADO-1',
            (public.ar_today() - 60)::timestamptz, 0, 0, 0);
  INSERT INTO comprobante_items(comprobante_id, business_id, descripcion, tipo_linea,
                                cantidad, precio_unitario, subtotal)
    VALUES ('00000000-0000-0000-0000-00000000b2f3','00000000-0000-0000-0000-00000000b201',
            'Linea vieja','producto',1,100,100)
    RETURNING id INTO v_item;

  PERFORM public.close_period('00000000-0000-0000-0000-00000000b201'::uuid,
                              (public.ar_today() - 60));

  v_res := pg_temp.como_authenticated('00000000-0000-0000-0000-00000000b209'::uuid,
    format('UPDATE comprobante_items SET cantidad = 9 WHERE id = %L', v_item));
  RAISE NOTICE '   UPDATE en periodo cerrado -> %', v_res;
  PERFORM pg_temp.assert(v_res <> 'OK',
    'G2-P1-C · el period lock aplica sobre comprobante_items (UPDATE en periodo cerrado rechazado)');
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE '   (close_period no disponible en este esquema; se omite el caso de periodo)';
END $$;

-- ============================================================================
-- BLOCKER 2 · AUTORIDAD DE TENANT EN LAS RPC SECDEF
-- ============================================================================
\set BIZ2  '00000000-0000-0000-0000-00000000b301'
\set OWN2  '00000000-0000-0000-0000-00000000b309'
\set COMP2 '00000000-0000-0000-0000-00000000b3f1'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'OWN2');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'BIZ2','G2B Vecino',:'OWN2');
INSERT INTO profiles(id,business_id,role,is_active) VALUES (:'OWN2',:'BIZ2','owner',true);
INSERT INTO comprobantes(id, business_id, tipo, estado, estado_fiscal, estado_comercial,
                         numero, fecha, total, total_cobrado, saldo_pendiente)
  VALUES (:'COMP2',:'BIZ2','remito','emitido','no_fiscal','pagado','VECINO-1', now(), 5000, 5000, 0);
SET LOCAL session_replication_role='origin';

CREATE OR REPLACE FUNCTION pg_temp.rpc_como(p_uid uuid, p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    EXECUTE p_sql INTO v;
    v := 'OK:' || COALESCE(v,'(null)');
  EXCEPTION WHEN OTHERS THEN
    v := SQLSTATE || ' ' || SQLERRM;
  END;
  RESET ROLE;
  RETURN v;
END; $$;

DO $$
DECLARE v_res text; v_comp uuid := current_setting('g2b.comp')::uuid;
BEGIN
  -- 8 · autorizado, mismo tenant -> funciona
  v_res := pg_temp.rpc_como('00000000-0000-0000-0000-00000000b209'::uuid,
    format($f$SELECT tiene_impacto::text FROM public.comprobante_impacto_economico(
              '00000000-0000-0000-0000-00000000b201'::uuid, %L::uuid)$f$, v_comp));
  RAISE NOTICE '   predicado mismo tenant -> %', v_res;
  PERFORM pg_temp.assert(v_res = 'OK:true',
    'B2 · el actor autorizado del tenant obtiene la respuesta');

  -- 6 · cross-tenant: negocio ajeno -> FORBIDDEN, sin revelar impacto
  v_res := pg_temp.rpc_como('00000000-0000-0000-0000-00000000b209'::uuid,
    $f$SELECT tiene_impacto::text FROM public.comprobante_impacto_economico(
       '00000000-0000-0000-0000-00000000b301'::uuid,
       '00000000-0000-0000-0000-00000000b3f1'::uuid)$f$);
  RAISE NOTICE '   predicado cross-tenant -> %', v_res;
  PERFORM pg_temp.assert(v_res LIKE '42501%' AND v_res NOT LIKE '%true%',
    'B2 · negocio ajeno -> FORBIDDEN y no revela impacto');

  -- 6b · negocio propio + comprobante ajeno -> no revela existencia
  v_res := pg_temp.rpc_como('00000000-0000-0000-0000-00000000b209'::uuid,
    $f$SELECT tiene_impacto::text FROM public.comprobante_impacto_economico(
       '00000000-0000-0000-0000-00000000b201'::uuid,
       '00000000-0000-0000-0000-00000000b3f1'::uuid)$f$);
  RAISE NOTICE '   predicado comp ajeno -> %', v_res;
  PERFORM pg_temp.assert(v_res LIKE '42501%',
    'B2 · comprobante de otro negocio -> no revela existencia ni impacto');

  -- 7 · la asercion tambien esta gateada
  v_res := pg_temp.rpc_como('00000000-0000-0000-0000-00000000b209'::uuid,
    $f$SELECT public.assert_comprobante_items_mutable(
       '00000000-0000-0000-0000-00000000b301'::uuid,
       '00000000-0000-0000-0000-00000000b3f1'::uuid, 'UPDATE')::text$f$);
  RAISE NOTICE '   assert cross-tenant -> %', v_res;
  PERFORM pg_temp.assert(v_res LIKE '42501%',
    'B2 · assert_comprobante_items_mutable cross-tenant -> FORBIDDEN');
END $$;

-- ============================================================================
-- 14 · MARCADORES SERVER-OWNED — el navegador no puede fabricarlos
-- ============================================================================
-- Sobre un borrador SIN impacto, donde el guard de inmutabilidad todavia no
-- aplica. Si el cliente pudiera encender `stock_processed`, el comprobante
-- entraria a `v_finance_effective_comprobantes` como venta efectiva sin venta.
DO $$
DECLARE v_res text; v_item uuid; v_efectivo boolean;
BEGIN
  INSERT INTO comprobantes(id, business_id, tipo, estado, estado_fiscal, estado_comercial,
                           numero, fecha, total, total_cobrado, saldo_pendiente)
    VALUES ('00000000-0000-0000-0000-00000000b2f4','00000000-0000-0000-0000-00000000b201',
            'remito','borrador','no_fiscal','pendiente','MARCADOR-1', now(), 0, 0, 0);
  INSERT INTO comprobante_items(comprobante_id, business_id, descripcion, tipo_linea,
                                cantidad, precio_unitario, subtotal)
    VALUES ('00000000-0000-0000-0000-00000000b2f4','00000000-0000-0000-0000-00000000b201',
            'Linea','producto',1,100,100)
    RETURNING id INTO v_item;

  v_res := pg_temp.como_authenticated('00000000-0000-0000-0000-00000000b209'::uuid,
    format('UPDATE comprobante_items SET stock_processed = true WHERE id = %L', v_item));
  RAISE NOTICE '   forjar stock_processed -> %', v_res;
  PERFORM pg_temp.assert(v_res LIKE '0A000%' AND v_res LIKE '%SERVER_OWNED%',
    '14 · el navegador NO puede encender stock_processed');

  v_res := pg_temp.como_authenticated('00000000-0000-0000-0000-00000000b209'::uuid,
    format('UPDATE comprobante_items SET stock_processed_at = now() WHERE id = %L', v_item));
  PERFORM pg_temp.assert(v_res LIKE '0A000%' AND v_res LIKE '%SERVER_OWNED%',
    '14 · tampoco stock_processed_at');

  v_res := pg_temp.como_authenticated('00000000-0000-0000-0000-00000000b209'::uuid,
    $f$INSERT INTO comprobante_items
       (comprobante_id, business_id, descripcion, tipo_linea, cantidad, precio_unitario,
        subtotal, stock_processed)
       VALUES ('00000000-0000-0000-0000-00000000b2f4','00000000-0000-0000-0000-00000000b201',
               'Declarada','producto',1,100,100,true)$f$);
  PERFORM pg_temp.assert(v_res LIKE '0A000%' AND v_res LIKE '%SERVER_OWNED%',
    '14 · tampoco se puede DECLARAR stock_processed en el INSERT');

  -- Y el borrador sigue fuera del conjunto de ventas efectivas.
  SELECT EXISTS (SELECT 1 FROM v_finance_effective_comprobantes
                  WHERE id = '00000000-0000-0000-0000-00000000b2f4') INTO v_efectivo;
  PERFORM pg_temp.assert(NOT v_efectivo,
    '14 · el borrador NO entro al conjunto de ventas efectivas');
END $$;

-- ============================================================================
-- 12 · La NOTA DE CREDITO canonica, que COPIA items, sigue funcionando
--
-- OJO con el falso verde: si el original no cumple TODAS las precondiciones de
-- `create_credit_note_from_comprobante` (factura_c + CbteTipo 11 + CAE +
-- numero_fiscal valido + arca_config), la RPC devuelve VALIDATION_ERROR y
-- retorna ANTES del `INSERT INTO comprobante_items`. El test pasaria sin haber
-- ejercitado nunca la copia de items — que es justamente lo que hay que probar.
-- Por eso aca se arma un original fiscal completo y se exige `success=true`.
-- ============================================================================

-- Segundo producto: con dos lineas la copia es una copia de verdad.
SET LOCAL session_replication_role='replica';
INSERT INTO inventory(id,business_id,name,code,category,stock_quantity,stock,cost_price,sale_price,
                      base_price,base_currency,auto_update_price,exchange_rate_used,is_active)
  VALUES ('00000000-0000-0000-0000-00000000b2d2',:'biz','Prod G2B 2','G2B-2','Rep',100,100,300,500,500,'ARS',false,1,true);
INSERT INTO arca_config(business_id, cuit_emisor, punto_venta, ambiente)
  VALUES (:'biz','20111111112',1,'homologacion');
SET LOCAL session_replication_role='origin';

DO $$
DECLARE
  r jsonb; v_res text; v_nc jsonb;
  v_src uuid; v_nc_id uuid; v_items_src int; v_items_nc int;
BEGIN
  -- Factura C real, con dos lineas y cobro (impacto economico -> items congelados).
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000b209', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-00000000b201'::uuid,'G2BNC','hg2bnc',
    jsonb_build_object('tipo','factura_c','punto_venta','0001','condicion_fiscal','Consumidor Final',
      'customer_id','00000000-0000-0000-0000-00000000b2c1','cc_total',0,'emitir_en_arca',true,
      'items', jsonb_build_array(
        jsonb_build_object('inventory_id','00000000-0000-0000-0000-00000000b2d1','descripcion','Linea A',
          'tipo_linea','producto','cantidad',1,'precio_unitario',1000),
        jsonb_build_object('inventory_id','00000000-0000-0000-0000-00000000b2d2','descripcion','Linea B',
          'tipo_linea','producto','cantidad',2,'precio_unitario',500)),
      'pagos', jsonb_build_array(jsonb_build_object(
        'amount',2000,'amount_ars',2000,'payment_method','efectivo'))));
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status' = 'created',
    '12 · la Factura C de origen se creo (status=' || COALESCE(r->>'status','?') || ')');
  v_src := (r->>'comprobante_id')::uuid;

  -- Emision fiscal simulada: es lo que haria `afip-cae` al volver con el CAE.
  -- Se escribe `comprobantes`, NO `comprobante_items`: el guard no interviene.
  UPDATE comprobantes
     SET estado = 'emitido', estado_fiscal = 'emitido',
         cae = '75000000000001', cae_vencimiento = current_date + 10,
         numero_fiscal = '0001-00000001', tipo_comprobante_fiscal = '11'
   WHERE id = v_src;

  SELECT count(*) INTO v_items_src FROM comprobante_items WHERE comprobante_id = v_src;
  PERFORM pg_temp.assert(v_items_src = 2, '12 · el original tiene las 2 lineas a copiar');

  -- El original YA esta congelado: la NC se emite sobre un comprobante inmutable.
  PERFORM pg_temp.assert(
    (SELECT tiene_impacto FROM public.comprobante_impacto_economico(
       '00000000-0000-0000-0000-00000000b201'::uuid, v_src)),
    '12 · el original esta congelado (tiene impacto economico) cuando se emite la NC');

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000b209', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    v_nc := public.create_credit_note_from_comprobante(v_src);
    v_res := 'OK';
  EXCEPTION WHEN OTHERS THEN
    v_res := SQLSTATE || ' ' || SQLERRM;
  END;
  RESET ROLE;
  RAISE NOTICE '   nota de credito -> % %', v_res, COALESCE(v_nc::text,'');

  PERFORM pg_temp.assert(v_res NOT LIKE '%COMPROBANTE_ITEMS_INMUTABLE%'
                     AND v_res NOT LIKE '%SERVER_OWNED%'
                     AND v_res NOT LIKE '%REPARENT%',
    '12 · la NC canonica NO es bloqueada por el guard');

  -- Esta es la asercion que impide el falso verde: la RPC tiene que haber
  -- llegado hasta el final, no haber retornado en una validacion.
  PERFORM pg_temp.assert(COALESCE((v_nc->>'success')::boolean, false),
    '12 · la NC se creo de verdad (success=true, error=' || COALESCE(v_nc->>'error','-') || ')');

  v_nc_id := (v_nc->>'nc_id')::uuid;
  PERFORM pg_temp.assert(v_nc_id IS NOT NULL, '12 · la NC devuelve su id (nc_id)');
  SELECT count(*) INTO v_items_nc FROM comprobante_items WHERE comprobante_id = v_nc_id;
  PERFORM pg_temp.assert(v_items_nc = v_items_src,
    '12 · la NC COPIO las ' || v_items_src || ' lineas del original (copiadas=' || v_items_nc || ')');

  -- Y el original no fue tocado por la copia.
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM comprobante_items WHERE comprobante_id = v_src) = v_items_src,
    '12 · el original conserva sus lineas tras la NC');
END $$;

SELECT 'G2-B: todas las aserciones pasaron' AS resultado;
ROLLBACK;
