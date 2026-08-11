-- ============================================================================
-- Pre-beta P1 — cierre de P1-B, P1-C y P1-D.
--
-- Corre contra el stack LOCAL o una BRANCH (NUNCA produccion), con
-- 20260810130000 / 20260810140000 / 20260810150000 ya aplicadas:
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < tests/sql/prebeta_p1_closure.test.sql
--
-- Todo ocurre dentro de UNA transaccion que termina en ROLLBACK: no deja
-- fixtures, ni grants, ni filas.
--
-- ── P1-B · VALORACION DE VARIANTES (§4 y §11) ──────────────────────────────
--   B01  A) producto simple suma.
--   B02  B) padre de variante VPREF legacy NO suma.
--   B03  C) hijo VPREF SI suma.
--   B04  D) padre de variante por parent_id NO suma.   <- lo que estaba roto
--   B05  E) hijo por parent_id SI suma.
--   B06  F) padre declarado por AMBAS convenciones: se excluye una sola vez.
--   B07  G) supplier_code que PARECE VPREF pero no lo declara padre nadie:
--            es un hijo huerfano y SI suma (no se excluye por el texto).
--   B08  H) cross-business: un 'VPREF-<id ajeno>' en otro negocio NO excluye.
--   B09  I) stock cero aporta 0 y no rompe.
--   B10  J) stock positivo aporta stock x costo.
--   B11  K) producto sin costo aporta 0 y queda contado como sin valuar.
--   B12  inactivo y servicio fuera del universo.
--   B13  INVARIANTE: v_finance_position.inventory_at_cost
--                    = v_finance_inventory_capital.inventory_at_cost, por negocio.
--   B14  DIFERENCIA DOCUMENTADA: inventory_at_cost_valued NO es lo mismo
--        (excluye stock<=0 y costo<=0). Se testea la diferencia, no se fuerza.
--   B15  la regla vive en UN solo lugar: v_finance_position no tiene el
--        predicado copiado.
--   B16  las demas metricas de v_finance_position siguen respondiendo.
--
-- ── P1-C · estado_fiscal (§12) ─────────────────────────────────────────────
--   C01  el DEFAULT efectivo es 'no_fiscal'.
--   C02  INSERT MINIMO sin estado_fiscal: ya no falla, y queda 'no_fiscal'.
--   C03  los 6 estados validos se aceptan.
--   C04  'borrador' se rechaza; un valor inventado tambien.
--   C05  el CHECK conserva exactamente su dominio (y sigue sin 'borrador').
--   C06  el checkout canonico sigue escribiendo el estado inicial explicito.
--   C07  REGRESION: estado_fiscal no participa del modelo contable — un
--        comprobante que usa el default entra al devengado igual que antes.
--   C08  Factura C, NC y anulacion siguen funcionando con el default.
--
-- ── P1-D · CONTEXTO DE COMPRAS A PROVEEDORES (§13) ─────────────────────────
--   D01  A) compras>0 y consumo>0 -> porcentaje normal.
--   D02  B) sin entradas + consumo>0 + sin compras a proveedor -> 0 % y
--            supplier_purchases_count = 0.
--   D03  C) sin entradas + consumo>0 + CON compras a proveedor -> 0 % y
--            contexto con count/amount.
--   D04  D) sin consumo -> NULL y motivo. NUNCA Infinity.
--   D05  E) supplier_purchases NO entra al numerador: el porcentaje es
--            exactamente purchases_cost/consumption_cost.
--   D06  la vista cuenta compras PAGADAS (a diferencia del aging).
--   D07  cross-business: el contexto no filtra compras de otro negocio.
--   D08  anon no lee la vista nueva ni ejecuta la RPC.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- ── Helpers de asercion ────────────────────────────────────────────────────
CREATE FUNCTION pg_temp.eq(p_case text, p_got numeric, p_want numeric) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION '% FALLO: obtenido=% esperado=%', p_case, p_got, p_want;
  END IF;
END $$;

CREATE FUNCTION pg_temp.eqt(p_case text, p_got text, p_want text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION '% FALLO: obtenido=% esperado=%', p_case, p_got, p_want;
  END IF;
END $$;

CREATE FUNCTION pg_temp.assert(p_case text, p_cond boolean, p_msg text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_cond IS NOT TRUE THEN
    RAISE EXCEPTION '% FALLO: %', p_case, p_msg;
  END IF;
END $$;

/** Intenta un INSERT en comprobantes y devuelve el SQLSTATE, o 'OK'. */
CREATE FUNCTION pg_temp.intentar_estado_fiscal(p_biz uuid, p_valor text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_state text;
BEGIN
  BEGIN
    INSERT INTO public.comprobantes (business_id, tipo, estado_fiscal, total, total_bruto)
    VALUES (p_biz, 'factura_c', p_valor, 1, 1);
    RETURN 'OK';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    RETURN v_state;
  END;
END $$;

/**
 * Intenta anular un comprobante por UPDATE directo. Devuelve 'BLOQUEADO' si el
 * guard canonico de M7 lo rechaza (lo esperado) u 'OK' si lo dejo pasar.
 */
CREATE FUNCTION pg_temp.intentar_anular(p_id uuid) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    UPDATE public.comprobantes
       SET estado='anulado', status='cancelled', estado_comercial='anulado',
           estado_fiscal='anulado_fiscal'
     WHERE id = p_id;
    RETURN 'OK';
  EXCEPTION WHEN OTHERS THEN
    RETURN 'BLOQUEADO';
  END;
END $$;

DO $main$
DECLARE
  -- Negocios
  v_x   uuid := gen_random_uuid();   -- universo de valoracion P1-B
  v_y   uuid := gen_random_uuid();   -- control cross-business P1-B
  v_n   uuid := gen_random_uuid();   -- P1-D caso A (normal)
  v_z   uuid := gen_random_uuid();   -- P1-D caso B (sin entradas, sin proveedor)
  v_s   uuid := gen_random_uuid();   -- P1-D caso C (sin entradas, con proveedor)
  v_e   uuid := gen_random_uuid();   -- P1-D caso D (sin consumo)
  v_ux  uuid := gen_random_uuid();
  v_uy  uuid := gen_random_uuid();
  v_un  uuid := gen_random_uuid();
  v_uz  uuid := gen_random_uuid();
  v_us  uuid := gen_random_uuid();
  v_ue  uuid := gen_random_uuid();

  -- Inventario de X (P1-B). Un caso del §4 por fila.
  v_pa   uuid := gen_random_uuid();  -- A) simple
  v_pb   uuid := gen_random_uuid();  -- B) padre VPREF legacy
  v_pbv  uuid := gen_random_uuid();  -- C) hijo VPREF
  v_pd   uuid := gen_random_uuid();  -- D) padre por parent_id
  v_pdv  uuid := gen_random_uuid();  -- E) hijo por parent_id
  v_pf   uuid := gen_random_uuid();  -- F) padre por AMBAS convenciones
  v_pfv1 uuid := gen_random_uuid();  -- F) hijo parent_id
  v_pfv2 uuid := gen_random_uuid();  -- F) hijo VPREF
  v_pg   uuid := gen_random_uuid();  -- G) parece VPREF pero es hijo huerfano
  v_pi   uuid := gen_random_uuid();  -- I) stock cero
  v_pk   uuid := gen_random_uuid();  -- K) sin costo
  v_pneg uuid := gen_random_uuid();  -- stock negativo (para B14)
  v_pina uuid := gen_random_uuid();  -- inactivo
  v_psvc uuid := gen_random_uuid();  -- servicio
  v_py   uuid := gen_random_uuid();  -- Y) producto propio
  v_pyv  uuid := gen_random_uuid();  -- Y) 'VPREF-<id de X>' cross-business

  -- Comprobantes
  v_cn  uuid := gen_random_uuid();
  v_cz  uuid := gen_random_uuid();
  v_cs  uuid := gen_random_uuid();
  v_cmin uuid;
  v_cnc  uuid := gen_random_uuid();

  -- Resultados
  j      jsonb;
  v_num  numeric;
  v_txt  text;
  v_est  text;
BEGIN
  -- ══════════════════════════════════════════════════════════════════════════
  -- FIXTURES
  -- ══════════════════════════════════════════════════════════════════════════
  INSERT INTO auth.users (id, email) VALUES
    (v_ux,'p1_x@example.com'), (v_uy,'p1_y@example.com'),
    (v_un,'p1_n@example.com'), (v_uz,'p1_z@example.com'),
    (v_us,'p1_s@example.com'), (v_ue,'p1_e@example.com')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.businesses (id, name, owner_user_id) VALUES
    (v_x,'P1 TEST X',v_ux), (v_y,'P1 TEST Y',v_uy), (v_n,'P1 TEST N',v_un),
    (v_z,'P1 TEST Z',v_uz), (v_s,'P1 TEST S',v_us), (v_e,'P1 TEST E',v_ue);

  INSERT INTO public.profiles (id, user_id, business_id, role, is_active) VALUES
    (v_ux,v_ux,v_x,'owner',true), (v_uy,v_uy,v_y,'owner',true),
    (v_un,v_un,v_n,'owner',true), (v_uz,v_uz,v_z,'owner',true),
    (v_us,v_us,v_s,'owner',true), (v_ue,v_ue,v_e,'owner',true);

  -- ── X: el universo completo de valoracion (§4, casos A..K) ───────────────
  INSERT INTO public.inventory
    (id, business_id, code, name, category, cost_price, sale_price, stock_quantity,
     is_active, tipo, base_currency, parent_id, supplier_code)
  VALUES
    (v_pa,   v_x,'P1B-A',  'A simple',        'c', 1000, 1500, 10, true, 'product','ARS', NULL, NULL),
    (v_pb,   v_x,'P1B-B',  'B padre vpref',   'c',  888, 1000, 99, true, 'product','ARS', NULL, NULL),
    (v_pbv,  v_x,'P1B-BV', 'C hijo vpref',    'c',  100,  200,  4, true, 'product','ARS', NULL, NULL),
    (v_pd,   v_x,'P1B-D',  'D padre parent',  'c',  700, 1000, 50, true, 'product','ARS', NULL, NULL),
    (v_pdv,  v_x,'P1B-DV', 'E hijo parent',   'c', 1500, 2000,  2, true, 'product','ARS', v_pd, NULL),
    (v_pf,   v_x,'P1B-F',  'F padre ambas',   'c',  600, 1000, 30, true, 'product','ARS', NULL, NULL),
    (v_pfv1, v_x,'P1B-FV1','F hijo parent',   'c',  200,  400,  3, true, 'product','ARS', v_pf, NULL),
    (v_pfv2, v_x,'P1B-FV2','F hijo vpref',    'c',  300,  600,  5, true, 'product','ARS', NULL, NULL),
    -- G) el supplier_code PARECE la convencion, pero no hay ningun producto con
    --    ese id: este producto es un hijo huerfano, no un padre. Debe sumar.
    (v_pg,   v_x,'P1B-G',  'G falso positivo','c',  400,  800,  7, true, 'product','ARS', NULL,
       'VPREF-00000000-0000-0000-0000-000000000000'),
    (v_pi,   v_x,'P1B-I',  'I stock cero',    'c',  500,  900,  0, true, 'product','ARS', NULL, NULL),
    (v_pk,   v_x,'P1B-K',  'K sin costo',     'c',    0, 1000,  3, true, 'product','ARS', NULL, NULL),
    (v_pneg, v_x,'P1B-NEG','stock negativo',  'c',  100,  200, -6, true, 'product','ARS', NULL, NULL),
    (v_pina, v_x,'P1B-INA','inactivo',        'c', 5000, 6000, 10, false,'product','ARS', NULL, NULL),
    (v_psvc, v_x,'P1B-SVC','servicio',        'c', 5000, 6000, 10, true, 'service','ARS', NULL, NULL);

  -- Las dos convenciones legacy se cablean despues: necesitan el id del padre.
  UPDATE public.inventory SET supplier_code = 'VPREF-' || v_pb::text WHERE id = v_pbv;
  UPDATE public.inventory SET supplier_code = 'VPREF-' || v_pf::text WHERE id = v_pfv2;

  -- ── Y: control cross-business ────────────────────────────────────────────
  -- v_pyv declara ser hijo de v_pa… pero v_pa es de OTRO negocio. Si el
  -- predicado no exigiera business_id, excluiria a v_pa y X perderia 10.000.
  INSERT INTO public.inventory
    (id, business_id, code, name, category, cost_price, sale_price, stock_quantity,
     is_active, tipo, base_currency, parent_id, supplier_code)
  VALUES
    (v_py,  v_y,'P1B-Y1','Y propio',    'c', 2000, 3000, 6, true,'product','ARS', NULL, NULL),
    (v_pyv, v_y,'P1B-Y2','Y falso hijo','c',   50,  100, 1, true,'product','ARS', NULL,
       'VPREF-' || v_pa::text);

  -- ── N / Z / S / E: escenarios de reposicion (P1-D) ───────────────────────
  -- Consumo = COGS devengado: sale de comprobante_items.costo_total.
  INSERT INTO public.comprobantes
    (id, business_id, tipo, status, estado, estado_fiscal, fecha, total, total_bruto, saldo_pendiente)
  VALUES
    (v_cn, v_n,'factura_c','issued','emitido','no_fiscal','2026-08-03 12:00-03', 50000, 50000, 50000),
    (v_cz, v_z,'factura_c','issued','emitido','no_fiscal','2026-08-03 12:00-03', 50000, 50000, 50000),
    (v_cs, v_s,'factura_c','issued','emitido','no_fiscal','2026-08-03 12:00-03', 50000, 50000, 50000);

  INSERT INTO public.comprobante_items
    (comprobante_id, business_id, descripcion, tipo_linea, cantidad, precio_unitario,
     subtotal, costo_unitario, costo_total)
  VALUES
    (v_cn, v_n,'Prod','producto', 1, 50000, 50000, 20000, 20000),
    (v_cz, v_z,'Prod','producto', 1, 50000, 50000, 20000, 20000),
    (v_cs, v_s,'Prod','producto', 1, 50000, 50000, 20000, 20000);

  -- Inventario minimo para colgar los movimientos.
  INSERT INTO public.inventory
    (business_id, code, name, category, cost_price, sale_price, stock_quantity, is_active, tipo, base_currency)
  VALUES
    (v_n,'P1D-N1','N prod','c', 1000, 2000, 10, true,'product','ARS'),
    (v_z,'P1D-Z1','Z prod','c', 1000, 2000, 10, true,'product','ARS'),
    (v_s,'P1D-S1','S prod','c', 1000, 2000, 10, true,'product','ARS'),
    (v_e,'P1D-E1','E prod','c', 1000, 2000, 10, true,'product','ARS');

  -- N: SI hay entradas de inventario -> 10 x 1000 = 10.000 sobre 20.000 = 50 %.
  INSERT INTO public.inventory_movements
    (business_id, inventory_item_id, movement_type, quantity, previous_stock, new_stock,
     unit_cost, reference_type, created_at)
  SELECT v_n, id,'purchase', 10, 0, 10, 1000,'supplier_purchase','2026-08-02 12:00-03'
    FROM public.inventory WHERE business_id = v_n LIMIT 1;

  -- E: entradas pero NINGUN consumo -> sin base comparable.
  INSERT INTO public.inventory_movements
    (business_id, inventory_item_id, movement_type, quantity, previous_stock, new_stock,
     unit_cost, reference_type, created_at)
  SELECT v_e, id,'purchase', 4, 0, 4, 2500,'supplier_purchase','2026-08-02 12:00-03'
    FROM public.inventory WHERE business_id = v_e LIMIT 1;

  -- Z: ni una sola entrada de inventario, y NINGUNA compra a proveedor.
  -- S: ni una sola entrada de inventario, pero SI compras a proveedor — una
  --    pendiente y una PAGADA (que el aging no ve y este contexto si).
  INSERT INTO public.supplier_purchases
    (business_id, purchase_date, total_amount, paid_amount, pending_amount, payment_status)
  VALUES
    (v_s,'2026-08-04', 45000,     0, 45000,'pending'),
    (v_s,'2026-08-05', 30000, 30000,     0,'paid'),
    -- Fuera del periodo: no debe contarse.
    (v_s,'2026-07-01', 99000,     0, 99000,'pending'),
    -- Cross-business (D07): compra de N, no puede aparecer en S.
    (v_n,'2026-08-04', 12345,     0, 12345,'pending');

  -- ══════════════════════════════════════════════════════════════════════════
  -- P1-B — VALORACION DE VARIANTES
  -- ══════════════════════════════════════════════════════════════════════════
  -- Universo esperado de X:
  --   A  10 x 1000 =  10000
  --   C   4 x  100 =    400   (hijo VPREF)
  --   E   2 x 1500 =   3000   (hijo parent_id)
  --   F1  3 x  200 =    600   (hijo parent_id del padre "ambas")
  --   F2  5 x  300 =   1500   (hijo VPREF del padre "ambas")
  --   G   7 x  400 =   2800   (falso positivo: SI suma)
  --   I   0 x  500 =      0
  --   K   3 x    0 =      0
  --   NEG -6 x 100 =   -600   (entra con signo)
  --   ---------------------------------
  --   inventory_at_cost        = 17700
  --   inventory_at_cost_valued = 18300  (sin el stock negativo)
  -- Excluidos: B (padre VPREF), D (padre parent_id), F (padre por ambas),
  --            inactivo, servicio.
  SELECT inventory_at_cost INTO v_num
    FROM public.v_finance_inventory_capital WHERE business_id = v_x;
  PERFORM pg_temp.eq('B01..B11 capital de X', v_num, 17700);

  -- B02 / B04 / B06 — ningun padre entro. Si B (99x888=87912), D (50x700=35000)
  -- o F (30x600=18000) se hubieran colado, el total no seria 17700.
  PERFORM pg_temp.assert('B02 padre VPREF excluido',
    v_num <> 17700 + 87912, 'el padre VPREF sumo');
  PERFORM pg_temp.assert('B04 padre parent_id excluido',
    v_num <> 17700 + 35000, 'el padre por parent_id sumo (este era el defecto)');
  PERFORM pg_temp.assert('B06 padre por ambas convenciones excluido una sola vez',
    v_num <> 17700 + 18000, 'el padre declarado por ambas convenciones sumo');

  -- B07 — el falso positivo textual SI suma: excluirlo seria un bug nuevo.
  PERFORM pg_temp.assert('B07 falso positivo VPREF no se excluye',
    v_num = 17700 AND v_num <> 17700 - 2800, 'se excluyo un producto por parecerse a VPREF');

  -- B08 — cross-business: Y no pudo excluir el producto A de X.
  PERFORM pg_temp.assert('B08 cross-business no excluye',
    v_num <> 17700 - 10000, 'un VPREF de otro negocio excluyo un producto propio');
  SELECT inventory_at_cost INTO v_num
    FROM public.v_finance_inventory_capital WHERE business_id = v_y;
  PERFORM pg_temp.eq('B08b capital de Y intacto', v_num, 6 * 2000 + 1 * 50);

  -- B11 / B12 — cobertura: el producto sin costo se cuenta como no valuado, y
  -- ni el inactivo ni el servicio entran al universo.
  PERFORM pg_temp.eq('B11 productos sin costo',
    (SELECT products_missing_cost FROM public.v_finance_inventory_capital WHERE business_id = v_x), 1);
  PERFORM pg_temp.eq('B12 universo con stock>0',
    (SELECT products_total FROM public.v_finance_inventory_capital WHERE business_id = v_x), 7);

  -- B13 — LA INVARIANTE. Es lo que impide que las dos cifras vuelvan a divergir.
  PERFORM pg_temp.assert('B13 invariante position = capital',
    NOT EXISTS (
      SELECT 1 FROM public.v_finance_position p
      JOIN public.v_finance_inventory_capital c ON c.business_id = p.business_id
      WHERE p.inventory_at_cost IS DISTINCT FROM c.inventory_at_cost),
    'v_finance_position.inventory_at_cost diverge de v_finance_inventory_capital');
  PERFORM pg_temp.eq('B13b position de X',
    (SELECT inventory_at_cost FROM public.v_finance_position WHERE business_id = v_x), 17700);

  -- B14 — DIFERENCIA DOCUMENTADA, no forzada a ser igual:
  -- inventory_at_cost_valued comparte denominador con dead_stock (M8) y por eso
  -- excluye stock<=0 y costo<=0. Aca la diferencia es exactamente el stock
  -- negativo. v_finance_position se alinea con at_cost, NO con valued.
  PERFORM pg_temp.eq('B14a valued excluye el stock negativo',
    (SELECT inventory_at_cost_valued FROM public.v_finance_inventory_capital WHERE business_id = v_x), 18300);
  PERFORM pg_temp.eq('B14b la diferencia es el stock negativo',
    (SELECT inventory_at_cost_valued - inventory_at_cost
       FROM public.v_finance_inventory_capital WHERE business_id = v_x), 600);
  PERFORM pg_temp.assert('B14c position sigue a at_cost, no a valued',
    (SELECT inventory_at_cost FROM public.v_finance_position WHERE business_id = v_x)
      <> (SELECT inventory_at_cost_valued FROM public.v_finance_inventory_capital WHERE business_id = v_x),
    'position quedo igualado a valued: eso escondria el stock sin costo/negativo');

  -- B15 — una sola definicion: el predicado no esta copiado en position.
  v_txt := pg_get_viewdef('public.v_finance_position'::regclass, true);
  PERFORM pg_temp.assert('B15a position lee la fuente canonica',
    v_txt LIKE '%v_finance_inventory_capital%', 'no delega en la vista canonica');
  PERFORM pg_temp.assert('B15b sin predicado duplicado',
    v_txt NOT LIKE '%VPREF-%', 'quedo una copia del predicado VPREF- en position');

  -- B16 — las demas metricas de la vista siguen respondiendo.
  PERFORM pg_temp.assert('B16 el resto de v_finance_position sigue vivo',
    EXISTS (SELECT 1 FROM public.v_finance_position
             WHERE business_id = v_x
               AND cash_total IS NOT NULL AND receivables IS NOT NULL
               AND payables IS NOT NULL AND owner_net_capital IS NOT NULL
               AND data_quality_flags ? 'unclassified_count'),
    'v_finance_position perdio columnas');

  -- ══════════════════════════════════════════════════════════════════════════
  -- P1-C — estado_fiscal
  -- ══════════════════════════════════════════════════════════════════════════
  -- C01 — el DEFAULT declarado.
  SELECT pg_get_expr(d.adbin, d.adrelid) INTO v_txt
  FROM pg_catalog.pg_attrdef d
  JOIN pg_catalog.pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
  WHERE d.adrelid='public.comprobantes'::regclass AND a.attname='estado_fiscal';
  PERFORM pg_temp.eqt('C01 default declarado', v_txt, '''no_fiscal''::text');

  -- C02 — el INSERT MINIMO. Este es EXACTAMENTE el que fallaba antes.
  INSERT INTO public.comprobantes (business_id, tipo, total, total_bruto)
  VALUES (v_x, 'remito', 1000, 1000)
  RETURNING id, estado_fiscal INTO v_cmin, v_est;
  PERFORM pg_temp.eqt('C02 el default efectivo es no_fiscal', v_est, 'no_fiscal');

  -- C03 — los 6 estados validos siguen aceptandose.
  FOREACH v_txt IN ARRAY ARRAY[
    'no_fiscal','pendiente_emision','pendiente_conciliacion',
    'emitido','error_emision','anulado_fiscal'
  ] LOOP
    PERFORM pg_temp.eqt('C03 acepta ' || v_txt,
      pg_temp.intentar_estado_fiscal(v_x, v_txt), 'OK');
  END LOOP;

  -- C04 — 'borrador' y un valor inventado se rechazan (23514 = check_violation).
  PERFORM pg_temp.eqt('C04a rechaza borrador',
    pg_temp.intentar_estado_fiscal(v_x, 'borrador'), '23514');
  PERFORM pg_temp.eqt('C04b rechaza un valor inventado',
    pg_temp.intentar_estado_fiscal(v_x, 'cualquier_cosa'), '23514');

  -- C05 — el dominio no se amplio para hacer pasar el default.
  SELECT pg_get_constraintdef(oid) INTO v_txt
  FROM pg_catalog.pg_constraint
  WHERE conrelid='public.comprobantes'::regclass
    AND conname='comprobantes_estado_fiscal_check';
  PERFORM pg_temp.assert('C05a el CHECK no admite borrador',
    v_txt NOT LIKE '%''borrador''%', 'se amplio el CHECK con un estado que no es fiscal');
  PERFORM pg_temp.assert('C05b el CHECK conserva los 6 validos',
    v_txt LIKE '%no_fiscal%' AND v_txt LIKE '%pendiente_emision%'
    AND v_txt LIKE '%pendiente_conciliacion%' AND v_txt LIKE '%emitido%'
    AND v_txt LIKE '%error_emision%' AND v_txt LIKE '%anulado_fiscal%',
    'el CHECK perdio algun estado valido');

  -- C06 — el camino canonico sigue decidiendo el estado inicial explicitamente.
  -- El DEFAULT es una red de seguridad, no reemplaza la intencion del checkout.
  SELECT prosrc INTO v_txt FROM pg_catalog.pg_proc
   WHERE oid = 'public.create_comprobante_checkout_atomic(uuid,text,text,jsonb)'::regprocedure;
  PERFORM pg_temp.assert('C06 el checkout escribe el estado inicial explicito',
    v_txt LIKE '%''pendiente_emision'' ELSE ''no_fiscal''%',
    'el checkout dejo de setear estado_fiscal explicitamente');

  -- C07 — REGRESION: estado_fiscal NO participa del modelo contable. Un
  -- comprobante que usa el default entra al devengado exactamente igual.
  PERFORM pg_temp.assert('C07a el modelo contable no mira estado_fiscal',
    pg_get_viewdef('public.v_finance_effective_comprobantes'::regclass, true)
      NOT LIKE '%estado_fiscal%',
    'v_finance_effective_comprobantes empezo a depender de estado_fiscal');
  UPDATE public.comprobantes SET status='issued', estado='emitido' WHERE id = v_cmin;
  PERFORM pg_temp.assert('C07b el comprobante con default es efectivo',
    EXISTS (SELECT 1 FROM public.v_finance_effective_comprobantes WHERE id = v_cmin),
    'un comprobante que usa el default quedo fuera del devengado');

  -- C08 — Factura C, NC y anulacion siguen comportandose igual con el default.
  INSERT INTO public.comprobantes
    (id, business_id, tipo, status, estado, fecha, total, total_bruto, saldo_pendiente,
     comprobante_original_id)
  VALUES (v_cnc, v_x, 'nota_credito','issued','emitido','2026-08-09 12:00-03', 500, 500, 0, v_cmin);
  PERFORM pg_temp.eqt('C08a la NC tambien toma el default',
    (SELECT estado_fiscal FROM public.comprobantes WHERE id = v_cnc), 'no_fiscal');

  -- C08b — la anulacion sigue BLINDADA: un comprobante nacido con el default
  -- nuevo no puede anularse por UPDATE directo. El guard de M7 no se aflojo.
  PERFORM pg_temp.eqt('C08b el guard de anulacion sigue vivo',
    pg_temp.intentar_anular(v_cmin), 'BLOQUEADO');
  PERFORM pg_temp.eqt('C08c el comprobante sigue sin anular',
    (SELECT estado FROM public.comprobantes WHERE id = v_cmin), 'emitido');

  -- C08d — la anulacion FISCAL (columna distinta del estado documental) sigue
  -- siendo un valor aceptado, que es lo unico que este lote podia afectar.
  PERFORM pg_temp.eqt('C08d anulado_fiscal sigue aceptandose',
    pg_temp.intentar_estado_fiscal(v_x, 'anulado_fiscal'), 'OK');

  -- ══════════════════════════════════════════════════════════════════════════
  -- P1-D — CONTEXTO DE COMPRAS A PROVEEDORES
  -- ══════════════════════════════════════════════════════════════════════════
  -- D01 — A) entradas 10.000 sobre consumo 20.000 -> 50 %.
  j := public.get_finance_charts_l1(v_n, '2026-08-01', '2026-08-10');
  PERFORM pg_temp.eq('D01a purchases_cost',
    (j->'inventory_flows'->>'purchases_cost')::numeric, 10000);
  PERFORM pg_temp.eq('D01b consumption_cost',
    (j->'inventory_flows'->>'consumption_cost')::numeric, 20000);
  PERFORM pg_temp.eq('D01c reposicion normal',
    (j->'inventory_flows'->>'replenishment_pct')::numeric, 50);
  PERFORM pg_temp.eqt('D01d basis comparable',
    j->'inventory_flows'->>'replenishment_basis', 'comparable');

  -- D02 — B) sin entradas, con consumo, SIN compras a proveedor.
  j := public.get_finance_charts_l1(v_z, '2026-08-01', '2026-08-10');
  PERFORM pg_temp.eq('D02a sin movimientos de entrada',
    (j->'inventory_flows'->>'purchases_movements')::numeric, 0);
  PERFORM pg_temp.eq('D02b purchases_cost 0',
    (j->'inventory_flows'->>'purchases_cost')::numeric, 0);
  PERFORM pg_temp.eq('D02c consumo real', (j->'inventory_flows'->>'consumption_cost')::numeric, 20000);
  PERFORM pg_temp.eq('D02d reposicion 0 (no NULL: hay base)',
    (j->'inventory_flows'->>'replenishment_pct')::numeric, 0);
  PERFORM pg_temp.eq('D02e sin compras a proveedor',
    (j->'inventory_flows'->>'supplier_purchases_count')::numeric, 0);
  PERFORM pg_temp.eq('D02f sin importe de compras',
    (j->'inventory_flows'->>'supplier_purchases_amount')::numeric, 0);

  -- D03 — C) sin entradas, con consumo, CON compras a proveedor del periodo.
  j := public.get_finance_charts_l1(v_s, '2026-08-01', '2026-08-10');
  PERFORM pg_temp.eq('D03a sin movimientos de entrada',
    (j->'inventory_flows'->>'purchases_movements')::numeric, 0);
  PERFORM pg_temp.eq('D03b reposicion 0',
    (j->'inventory_flows'->>'replenishment_pct')::numeric, 0);
  -- 2 compras DENTRO del periodo (45.000 pendiente + 30.000 pagada).
  -- La de julio queda afuera: es contexto DEL PERIODO.
  PERFORM pg_temp.eq('D03c compras a proveedor del periodo',
    (j->'inventory_flows'->>'supplier_purchases_count')::numeric, 2);
  PERFORM pg_temp.eq('D03d importe de compras del periodo',
    (j->'inventory_flows'->>'supplier_purchases_amount')::numeric, 75000);
  PERFORM pg_temp.eqt('D03e el origen queda declarado',
    j->'inventory_flows'->>'supplier_purchases_source', 'supplier_purchases_registered');

  -- D04 — D) sin consumo: NULL y motivo. NUNCA Infinity ni division por cero.
  j := public.get_finance_charts_l1(v_e, '2026-08-01', '2026-08-10');
  PERFORM pg_temp.assert('D04a sin consumo -> NULL',
    (j->'inventory_flows'->'replenishment_pct') = 'null'::jsonb,
    'deberia ser NULL sin consumo comparable');
  PERFORM pg_temp.eqt('D04b motivo declarado',
    j->'inventory_flows'->>'replenishment_basis', 'no_comparable_consumption');
  PERFORM pg_temp.assert('D04c hubo entradas igual',
    (j->'inventory_flows'->>'purchases_cost')::numeric = 10000,
    'la compra del negocio E no se registro');

  -- D05 — E) el contexto NO entra al numerador. Con 75.000 de compras a
  -- proveedor y 0 de entradas, la reposicion sigue siendo 0 %: si se hubiera
  -- sumado al numerador daria 375 %.
  j := public.get_finance_charts_l1(v_s, '2026-08-01', '2026-08-10');
  PERFORM pg_temp.eq('D05a la reposicion ignora las compras a proveedor',
    (j->'inventory_flows'->>'replenishment_pct')::numeric, 0);
  PERFORM pg_temp.assert('D05b la formula es purchases_cost / consumption_cost',
    (j->'inventory_flows'->>'replenishment_pct')::numeric =
      round((j->'inventory_flows'->>'purchases_cost')::numeric
            / NULLIF((j->'inventory_flows'->>'consumption_cost')::numeric,0) * 100, 2),
    'el porcentaje no se corresponde con la formula declarada');

  -- D06 — la vista ve las compras PAGADAS, que el aging descarta. Es la razon
  -- por la que el payload existente no alcanzaba como senal.
  PERFORM pg_temp.eq('D06a la vista cuenta la compra pagada',
    (SELECT sum(purchases) FROM public.v_finance_supplier_purchases_daily
      WHERE business_id = v_s AND purchase_date BETWEEN '2026-08-01' AND '2026-08-10'), 2);
  -- D06b — Y la prueba de que el aging NO servia como senal: mide otra cosa.
  -- Negocio S tiene 3 compras: 45.000 pendiente (en periodo), 30.000 PAGADA (en
  -- periodo) y 99.000 pendiente (julio, FUERA del periodo).
  --   aging   = 45.000 + 99.000 = 144.000  (solo pendientes, sin periodo)
  --   contexto=  45.000 + 30.000 =  75.000  (del periodo, pagadas incluidas)
  -- Ninguno de los dos numeros se puede derivar del otro.
  PERFORM pg_temp.eq('D06b el aging ignora el periodo y solo ve deuda viva',
    (j->'payables_aging'->>'total')::numeric, 144000);
  PERFORM pg_temp.assert('D06c contexto y aging miden cosas distintas',
    (j->'inventory_flows'->>'supplier_purchases_amount')::numeric
      <> (j->'payables_aging'->>'total')::numeric,
    'el contexto quedo igualado al aging: entonces no aporta nada nuevo');

  -- D07 — cross-business: la compra de N no aparece en el contexto de S.
  PERFORM pg_temp.assert('D07 sin fuga cross-business',
    (j->'inventory_flows'->>'supplier_purchases_amount')::numeric = 75000,
    'se colo una compra de otro negocio en el contexto');
  j := public.get_finance_charts_l1(v_n, '2026-08-01', '2026-08-10');
  PERFORM pg_temp.eq('D07b N ve solo lo suyo',
    (j->'inventory_flows'->>'supplier_purchases_amount')::numeric, 12345);

  -- D08 — la superficie nueva no se le abre a anon.
  PERFORM pg_temp.assert('D08a anon no lee la vista nueva',
    NOT has_table_privilege('anon','public.v_finance_supplier_purchases_daily','SELECT'),
    'anon puede leer v_finance_supplier_purchases_daily');
  PERFORM pg_temp.assert('D08b anon no ejecuta la RPC',
    NOT has_function_privilege('anon',
      'public.get_finance_charts_l1(uuid,date,date,text)','EXECUTE'),
    'anon puede ejecutar get_finance_charts_l1');
  PERFORM pg_temp.assert('D08c la vista nueva es security_invoker',
    EXISTS (SELECT 1 FROM pg_catalog.pg_class
             WHERE oid='public.v_finance_supplier_purchases_daily'::regclass
               AND reloptions @> ARRAY['security_invoker=true']),
    'la vista nueva no es security_invoker');

  RAISE NOTICE 'Pre-beta P1 — TODOS LOS CASOS OK (P1-B, P1-C, P1-D).';
END
$main$;

ROLLBACK;
