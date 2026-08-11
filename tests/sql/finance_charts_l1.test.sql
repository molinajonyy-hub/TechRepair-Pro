-- ============================================================================
-- Charts L1 — contratos canonicos de las visualizaciones financieras.
--
-- Corre contra el stack LOCAL o una BRANCH (NUNCA produccion), con
-- 20260810120000_finance_charts_l1_contracts.sql ya aplicada:
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < tests/sql/finance_charts_l1.test.sql
--
-- Todo ocurre dentro de UNA transaccion que termina en ROLLBACK: no deja
-- fixtures, ni grants, ni filas.
--
-- ── RESULTADO (§32) ────────────────────────────────────────────────────────
--   C01  net_sales / cogs / gastos / margen bruto / resultado operativo.
--   C02  gross_profit = net_sales - cogs (identidad del waterfall).
--   C03  operating_profit = gross_profit - operating_expenses.
--   C04  la nota de credito RESTA de ventas.
--   C05  la anulacion compensa en SU periodo (no borra la venta original).
--   C06  periodo en perdida -> resultado negativo, no truncado a 0.
--   C07  periodo sin datos -> ceros reales, margin_pct NULL (no 0, no NaN).
--   C08  los retiros del dueno NO son gasto operativo.
--
-- ── VENTAS VS COBROS (§33) ─────────────────────────────────────────────────
--   C09  devengado != cobrado en el mismo periodo.
--   C10  venta en cuenta corriente NO suma a cobros.
--   C11  pago parcial suma solo lo pagado.
--   C12  pago mixto suma las dos patas.
--   C13  anulacion compensa el cobro en la fecha de anulacion.
--   C14  la serie billing_vs_collections cierra contra los totales.
--
-- ── MEDIOS DE COBRO (§34) ──────────────────────────────────────────────────
--   C15  solo pagos VIVOS (replaced_at IS NULL).
--   C16  un pago reemplazado no cuenta; el sustituto si.
--   C17  la suma del mix == summary.collections.
--   C18  no aparecen categorias en cero.
--   C19  cuenta corriente NO figura como medio de cobro.
--
-- ── CxC / CxP (§35) ────────────────────────────────────────────────────────
--   C20  CxC total y documentos; los buckets cierran contra el total.
--   C21  comprobante saldado NO esta en CxC.
--   C22  CxP total; los buckets cierran contra el total.
--   C23  compra pagada NO esta en CxP.
--   C24  aging y due_date son superficies SEPARADAS.
--   C25  sin due_date cargado -> has_due_dates=false (no es un error).
--
-- ── CAPITAL EN STOCK (§36) ─────────────────────────────────────────────────
--   C26  A) producto ARS  B) variante  C) producto USD -> suman al capital.
--   C27  E) producto sin costo NO se valua en silencio: cobertura explicita.
--   C28  F) stock cero fuera del universo valuado.
--   C29  G) stock negativo entra con signo y se cuenta aparte.
--   C30  padre de variante excluido por las DOS convenciones (no double-count).
--   C31  producto inactivo y servicio fuera del universo.
--   C32  Q) cross-business: A no ve el capital de B.
--   C33  D) cambio de costo/FX SIN movimiento mueve el capital
--        pero NO genera ninguna compra.
--   C34  no existe serie historica: history_available=false + motivo.
--   C35  el puente de inventario esta bloqueado: bridge_available=false.
--
-- ── REPOSICION (§37) ───────────────────────────────────────────────────────
--   C36  purchases=100 / consumption=100 -> 100 %.
--   C37  purchases= 50 / consumption=100 ->  50 %.
--   C38  purchases=150 / consumption=100 -> 150 %.
--   C39  consumption=0 -> NULL + motivo. NUNCA Infinity.
--   C40  los ajustes NO entran al numerador de compras.
--   C41  la restauracion por anulacion/devolucion NO es compra.
--   C42  el consumo se toma del COGS devengado, no de unit_cost de salidas.
--
-- ── COMPARACION (§38) ──────────────────────────────────────────────────────
--   C43  periodo anterior de IGUAL duracion, inmediatamente anterior.
--   C44  sin base -> available=false (y no una division por cero).
--   C45  granularidad: <=31 dia, 32..120 semana, >120 mes, y forzada.
--
-- ── SEGURIDAD ──────────────────────────────────────────────────────────────
--   C46  anon no ejecuta la RPC ni lee las vistas.
--   C47  NEGATIVO: reponerle SELECT a anon abre la lectura -> el detector lo ve.
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

-- Detector reutilizado por C46/C47.
CREATE FUNCTION pg_temp.acceso_anon_l1() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(string_agg(DISTINCT v, ', '), '')
  FROM (
    SELECT unnest(ARRAY[
      'public.v_finance_inventory_capital',
      'public.v_finance_inventory_flows',
      'public.v_finance_collections_ledger']) AS v
  ) t
  WHERE has_table_privilege('anon', t.v, 'SELECT');
$$;

DO $main$
DECLARE
  -- Negocios
  v_a        uuid := gen_random_uuid();   -- negocio rentable, escenario rico
  v_b        uuid := gen_random_uuid();   -- control cross-tenant
  v_c        uuid := gen_random_uuid();   -- ratios de reposicion controlados
  v_d        uuid := gen_random_uuid();   -- negocio en perdida
  v_ua       uuid := gen_random_uuid();
  v_ub       uuid := gen_random_uuid();
  v_uc       uuid := gen_random_uuid();
  v_ud       uuid := gen_random_uuid();
  v_cust     uuid := gen_random_uuid();

  -- Comprobantes de A
  v_s1 uuid := gen_random_uuid();   -- cobrado mixto (efectivo + transferencia)
  v_s2 uuid := gen_random_uuid();   -- cuenta corriente, SIN cobro
  v_s3 uuid := gen_random_uuid();   -- cobro parcial
  v_s4 uuid := gen_random_uuid();   -- cobrado y luego ANULADO
  v_s5 uuid := gen_random_uuid();   -- nota de credito
  v_s6 uuid := gen_random_uuid();   -- periodo anterior
  v_s7 uuid := gen_random_uuid();   -- pago REEMPLAZADO
  v_pay_old uuid := gen_random_uuid();
  v_pay_new uuid := gen_random_uuid();

  -- Inventario de A
  v_p1 uuid := gen_random_uuid();   -- ARS con stock y costo
  v_p2 uuid := gen_random_uuid();   -- base USD
  v_p3 uuid := gen_random_uuid();   -- SIN costo
  v_p4 uuid := gen_random_uuid();   -- stock cero
  v_p5 uuid := gen_random_uuid();   -- PADRE de variante (parent_id)
  v_p5v uuid := gen_random_uuid();  -- variante
  v_p6 uuid := gen_random_uuid();   -- PADRE de variante (VPREF-)
  v_p6v uuid := gen_random_uuid();  -- variante VPREF
  v_p7 uuid := gen_random_uuid();   -- inactivo
  v_p8 uuid := gen_random_uuid();   -- servicio
  v_p9 uuid := gen_random_uuid();   -- stock NEGATIVO

  -- Resultados
  j     jsonb;
  j2    jsonb;
  v_num numeric;
BEGIN
  -- ══════════════════════════════════════════════════════════════════════════
  -- FIXTURES
  -- ══════════════════════════════════════════════════════════════════════════
  -- Filas minimas de auth.users: profiles.id apunta ahi por FK.
  INSERT INTO auth.users (id, email) VALUES
    (v_ua,'l1_a@example.com'), (v_ub,'l1_b@example.com'),
    (v_uc,'l1_c@example.com'), (v_ud,'l1_d@example.com')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.businesses (id, name, owner_user_id) VALUES
    (v_a,'L1 TEST A',v_ua), (v_b,'L1 TEST B',v_ub),
    (v_c,'L1 TEST C',v_uc), (v_d,'L1 TEST D',v_ud);

  INSERT INTO public.profiles (id, user_id, business_id, role, is_active) VALUES
    (v_ua,v_ua,v_a,'owner',true), (v_ub,v_ub,v_b,'owner',true),
    (v_uc,v_uc,v_c,'owner',true), (v_ud,v_ud,v_d,'owner',true);

  INSERT INTO public.customers (id, business_id, name, phone)
  VALUES (v_cust, v_a, 'L1 Cliente', '0000000000');

  -- ── A: comprobantes ──────────────────────────────────────────────────────
  -- estado_fiscal va explicito a proposito: el estado inicial de un comprobante
  -- depende de si es fiscal, y un fixture no debe delegar esa decision en el
  -- DEFAULT. (El DEFAULT invalido 'borrador' que obligaba a esto se corrigio en
  -- 20260810140000; ver tests/sql/prebeta_p1_closure.test.sql C01..C08.)
  -- `fecha` es timestamptz: se fija al mediodia AR para que el dia economico
  -- (AT TIME ZONE Cordoba) sea el esperado y no el anterior.
  -- `total_bruto` se setea igual a `total`: trig_comprobante_payment_sync
  -- recalcula saldo_pendiente a partir de el, y dejarlo en 0 saldaria todo.
  INSERT INTO public.comprobantes
    (id, business_id, tipo, status, estado, estado_fiscal, fecha, total, total_bruto, saldo_pendiente, customer_id)
  VALUES
    (v_s1, v_a, 'factura_c','issued','emitido','no_fiscal','2026-08-03 12:00-03', 20000, 20000, 20000, NULL),
    (v_s2, v_a, 'factura_c','issued','emitido','no_fiscal','2026-08-05 12:00-03', 30000, 30000, 30000, v_cust),
    (v_s3, v_a, 'factura_c','issued','emitido','no_fiscal','2026-08-06 12:00-03', 10000, 10000, 10000, v_cust),
    (v_s4, v_a, 'factura_c','issued','emitido','no_fiscal','2026-08-07 12:00-03',  8000,  8000,  8000, NULL),
    (v_s5, v_a, 'nota_credito','issued','emitido','no_fiscal','2026-08-08 12:00-03', 5000, 5000, 0,    NULL),
    (v_s6, v_a, 'factura_c','issued','emitido','no_fiscal','2026-07-25 12:00-03', 15000, 15000, 15000, NULL),
    (v_s7, v_a, 'factura_c','issued','emitido','no_fiscal','2026-08-04 12:00-03',  7000,  7000,  7000, NULL);

  INSERT INTO public.comprobante_items
    (comprobante_id, business_id, descripcion, tipo_linea, cantidad, precio_unitario, subtotal, costo_unitario, costo_total)
  VALUES
    (v_s1, v_a, 'Producto 1','producto', 2, 10000, 20000, 3000,  6000),
    (v_s2, v_a, 'Producto 2','producto', 1, 30000, 30000, 12000, 12000),
    (v_s3, v_a, 'Producto 3','producto', 1, 10000, 10000, 4000,  4000),
    (v_s4, v_a, 'Producto 4','producto', 1,  8000,  8000, 3000,  3000),
    (v_s6, v_a, 'Producto 6','producto', 1, 15000, 15000, 5000,  5000),
    (v_s7, v_a, 'Producto 7','producto', 1,  7000,  7000, 2000,  2000);

  -- Cobros. Ojo: trig_comprobante_payment_sync recalcula total_cobrado /
  -- saldo_pendiente, asi que los saldos se fijan DESPUES.
  INSERT INTO public.comprobante_payments
    (id, comprobante_id, business_id, amount, amount_ars, payment_method, date)
  VALUES
    (gen_random_uuid(), v_s1, v_a, 12000, 12000, 'efectivo',      '2026-08-03'),
    (gen_random_uuid(), v_s1, v_a,  8000,  8000, 'transferencia', '2026-08-04'),
    (gen_random_uuid(), v_s3, v_a,  5000,  5000, 'efectivo',      '2026-08-06'),
    (gen_random_uuid(), v_s4, v_a,  8000,  8000, 'efectivo',      '2026-08-07'),
    (gen_random_uuid(), v_s6, v_a, 15000, 15000, 'efectivo',      '2026-07-25');

  -- Cadena de reemplazo (M7 6F.3): el viejo queda marcado, vive el nuevo.
  INSERT INTO public.comprobante_payments
    (id, comprobante_id, business_id, amount, amount_ars, payment_method, date)
  VALUES (v_pay_new, v_s7, v_a, 7000, 7000, 'transferencia', '2026-08-04');
  INSERT INTO public.comprobante_payments
    (id, comprobante_id, business_id, amount, amount_ars, payment_method, date,
     replaced_at, replaced_by, replacement_payment_id)
  VALUES (v_pay_old, v_s7, v_a, 7000, 7000, 'efectivo', '2026-08-04',
          now(), v_ua, v_pay_new);

  -- Anulacion de S4, fechada 2026-08-09 (DENTRO del periodo).
  INSERT INTO public.comprobante_annulments
    (business_id, comprobante_id, user_id, idempotency_key, request_hash, mode,
     motivo, restore_stock, status, annulment_date)
  VALUES (v_a, v_s4, v_ua, 'l1-test-key-s4', 'l1-test-hash-s4', 'commercial_annulment',
          'test L1', false, 'completed', '2026-08-09');

  -- Gastos del P&L (las 3 clases que bajan del margen bruto).
  INSERT INTO public.business_finance_entries
    (business_id, date, type, category, amount, amount_ars, economic_class)
  VALUES
    (v_a,'2026-08-02','fixed_cost_local','alquiler', 4000, 4000,'operating_expense'),
    (v_a,'2026-08-02','variable_cost',   'comision',  500,  500,'payment_fee'),
    (v_a,'2026-08-02','salary',          'sueldos',  2000, 2000,'employee_salary');

  -- Retiro del dueno: NUNCA es gasto operativo.
  INSERT INTO public.owner_withdrawals
    (business_id, user_id, amount, flow_type, status, date)
  VALUES (v_a, v_ua, 9999, 'withdrawal','completed','2026-08-05');

  -- ── A: inventario ────────────────────────────────────────────────────────
  INSERT INTO public.inventory
    (id, business_id, code, name, category, cost_price, sale_price, stock_quantity,
     is_active, tipo, base_currency, cost_price_usd, exchange_rate_used, parent_id, supplier_code)
  VALUES
    (v_p1,  v_a,'L1-P1','ARS con costo','cat', 1000, 1500, 10, true,'product','ARS',   0,    0, NULL, NULL),
    (v_p2,  v_a,'L1-P2','USD base',     'cat', 2000, 3000,  5, true,'product','USD', 1.4, 1430, NULL, NULL),
    (v_p3,  v_a,'L1-P3','SIN costo',    'cat',    0, 1000,  3, true,'product','ARS',   0,    0, NULL, NULL),
    (v_p4,  v_a,'L1-P4','stock cero',   'cat',  500,  900,  0, true,'product','ARS',   0,    0, NULL, NULL),
    (v_p5,  v_a,'L1-P5','padre parent', 'cat',  777, 1000, 99, true,'product','ARS',   0,    0, NULL, NULL),
    (v_p5v, v_a,'L1-P5V','variante',    'cat', 1500, 2000,  2, true,'product','ARS',   0,    0, v_p5, NULL),
    (v_p6,  v_a,'L1-P6','padre vpref',  'cat',  888, 1000, 99, true,'product','ARS',   0,    0, NULL, NULL),
    (v_p6v, v_a,'L1-P6V','variante v',  'cat',  100,  200,  4, true,'product','ARS',   0,    0, NULL, NULL),
    (v_p7,  v_a,'L1-P7','inactivo',     'cat', 5000, 6000, 10, false,'product','ARS',  0,    0, NULL, NULL),
    (v_p8,  v_a,'L1-P8','servicio',     'cat', 5000, 6000, 10, true,'service','ARS',   0,    0, NULL, NULL),
    (v_p9,  v_a,'L1-P9','stock negativo','cat', 100,  200, -6, true,'product','ARS',   0,    0, NULL, NULL);
  UPDATE public.inventory SET supplier_code = 'VPREF-' || v_p6::text WHERE id = v_p6v;

  -- ── A: movimientos de inventario del periodo ─────────────────────────────
  INSERT INTO public.inventory_movements
    (business_id, inventory_item_id, movement_type, quantity, previous_stock, new_stock,
     unit_cost, reference_type, created_at)
  VALUES
    -- compras (SI reponen)
    (v_a, v_p1,'purchase',  10,  0, 10, 1000,'supplier_purchase','2026-08-02 12:00-03'),
    (v_a, v_p1,'in',         5, 10, 15,  400,'manual',           '2026-08-04 12:00-03'),
    -- salidas (sin unit_cost, tal como en produccion)
    (v_a, v_p1,'sale',      -2, 15, 13, NULL,'comprobante',      '2026-08-03 12:00-03'),
    (v_a, v_p1,'order_usage',-1,13, 12, NULL,'order',            '2026-08-05 12:00-03'),
    -- devolucion / restauracion: NO es compra
    (v_a, v_p1,'return',     2, 12, 14,  999,'comprobante',      '2026-08-09 12:00-03'),
    -- ajuste: NO es compra ni consumo comercial
    (v_a, v_p1,'adjustment', 5, 14, 19,  999,'adjustment',       '2026-08-06 12:00-03');

  -- ── A: CxP ───────────────────────────────────────────────────────────────
  INSERT INTO public.supplier_purchases
    (business_id, purchase_date, total_amount, paid_amount, pending_amount, payment_status, due_date)
  VALUES
    (v_a,'2026-08-05', 50000,     0, 50000,'pending', NULL),
    (v_a,'2026-08-06', 20000, 20000,     0,'paid',    NULL);

  -- ── B: control cross-tenant (numeros distintos y grandes) ────────────────
  INSERT INTO public.inventory
    (business_id, code, name, category, cost_price, sale_price, stock_quantity, is_active, tipo, base_currency)
  VALUES (v_b,'L1-B1','ajeno','cat', 7777, 9999, 100, true,'product','ARS');
  INSERT INTO public.inventory_movements
    (business_id, inventory_item_id, movement_type, quantity, previous_stock, new_stock, unit_cost, created_at)
  SELECT v_b, id,'purchase', 100, 0, 100, 7777,'2026-08-02 12:00-03'
    FROM public.inventory WHERE business_id = v_b LIMIT 1;

  -- ── D: negocio en perdida ────────────────────────────────────────────────
  INSERT INTO public.business_finance_entries
    (business_id, date, type, category, amount, amount_ars, economic_class)
  VALUES (v_d,'2026-08-03','fixed_cost_local','alquiler', 50000, 50000,'operating_expense');

  -- ══════════════════════════════════════════════════════════════════════════
  -- §32 — RESULTADO
  -- ══════════════════════════════════════════════════════════════════════════
  j := public.get_finance_charts_l1(v_a, '2026-08-01', '2026-08-10');

  -- net_line_sales = 20000+30000+10000+8000+7000 = 75000
  -- anulacion de S4 el 08-09 compensa -8000 -> 67000
  -- NC del 08-08 resta 5000 -> net_sales = 62000
  PERFORM pg_temp.eq('C01a net_sales', (j->'summary'->>'net_sales')::numeric, 62000);
  -- cogs = 6000+12000+4000+3000+2000 = 27000, menos 3000 de la anulacion = 24000
  PERFORM pg_temp.eq('C01b cogs',      (j->'summary'->>'cogs')::numeric, 24000);
  PERFORM pg_temp.eq('C01c gastos',    (j->'summary'->>'operating_expenses')::numeric, 6500);

  PERFORM pg_temp.eq('C02 gross_profit = net_sales - cogs',
    (j->'summary'->>'gross_profit')::numeric,
    (j->'summary'->>'net_sales')::numeric - (j->'summary'->>'cogs')::numeric);

  PERFORM pg_temp.eq('C03 operating = gross - opex',
    (j->'summary'->>'operating_result')::numeric,
    (j->'summary'->>'gross_profit')::numeric - (j->'summary'->>'operating_expenses')::numeric);

  -- C04 — sin la NC, net_sales seria 67000.
  PERFORM pg_temp.assert('C04 la NC resta',
    (j->'summary'->>'net_sales')::numeric = 62000, 'la nota de credito no resto');

  -- C05 — la venta original sigue viva en su dia; la compensacion vive el 09.
  PERFORM pg_temp.eq('C05a venta original intacta el 07',
    (SELECT (e->>'net_sales')::numeric FROM jsonb_array_elements(j->'pnl_series') e
      WHERE e->>'bucket' = '2026-08-07'), 8000);
  PERFORM pg_temp.eq('C05b compensacion el 09',
    (SELECT (e->>'net_sales')::numeric FROM jsonb_array_elements(j->'pnl_series') e
      WHERE e->>'bucket' = '2026-08-09'), -8000);

  -- C06 — periodo en perdida.
  j2 := public.get_finance_charts_l1(v_d, '2026-08-01', '2026-08-10');
  PERFORM pg_temp.eq('C06 resultado negativo', (j2->'summary'->>'operating_result')::numeric, -50000);

  -- C07 — sin datos: ceros reales y margin_pct NULL.
  j2 := public.get_finance_charts_l1(v_a, '2025-01-01', '2025-01-10');
  PERFORM pg_temp.eq('C07a net_sales 0', (j2->'summary'->>'net_sales')::numeric, 0);
  PERFORM pg_temp.assert('C07b margin_pct NULL',
    (j2->'summary'->'margin_pct') = 'null'::jsonb, 'margin_pct deberia ser NULL sin base');

  -- C08 — el retiro se informa aparte y NO esta dentro de los gastos.
  PERFORM pg_temp.eq('C08a retiro informado', (j->'summary'->>'owner_withdrawals')::numeric, 9999);
  PERFORM pg_temp.assert('C08b retiro fuera del P&L',
    (j->'summary'->>'operating_expenses')::numeric = 6500, 'el retiro se colo en gastos operativos');

  -- ══════════════════════════════════════════════════════════════════════════
  -- §33 — VENTAS VS COBROS
  -- ══════════════════════════════════════════════════════════════════════════
  -- cobros = 12000+8000 (S1) + 5000 (S3) + 8000 (S4) - 8000 (anulacion) + 7000 (S7 vivo)
  PERFORM pg_temp.eq('C09 cobros del periodo', (j->'summary'->>'collections')::numeric, 32000);
  PERFORM pg_temp.assert('C09b devengado != cobrado',
    (j->'summary'->>'net_sales')::numeric <> (j->'summary'->>'collections')::numeric,
    'el escenario deberia tener devengado distinto de cobrado');

  -- C10 — S2 (30000 en cuenta corriente) no aparece en ningun cobro.
  PERFORM pg_temp.eq('C10 CC no es cobro',
    (SELECT COALESCE(sum(amount_ars),0) FROM public.v_finance_collections_ledger
      WHERE business_id = v_a AND comprobante_id = v_s2), 0);

  -- C11 — S3 devengo 10000 y solo cobro 5000.
  PERFORM pg_temp.eq('C11 pago parcial',
    (SELECT sum(amount_ars) FROM public.v_finance_collections_ledger
      WHERE business_id = v_a AND comprobante_id = v_s3), 5000);

  -- C12 — S1 con dos medios.
  PERFORM pg_temp.eq('C12 pago mixto',
    (SELECT sum(amount_ars) FROM public.v_finance_collections_ledger
      WHERE business_id = v_a AND comprobante_id = v_s1), 20000);

  -- C13 — S4 netea 0: cobrado el 07, compensado el 09.
  PERFORM pg_temp.eq('C13a anulacion netea 0',
    (SELECT sum(amount_ars) FROM public.v_finance_collections_ledger
      WHERE business_id = v_a AND comprobante_id = v_s4), 0);
  PERFORM pg_temp.eq('C13b compensacion fechada el 09',
    (SELECT amount_ars FROM public.v_finance_collections_ledger
      WHERE business_id = v_a AND comprobante_id = v_s4 AND event_type='annulment'), -8000);

  -- C14 — la serie cierra contra los totales.
  PERFORM pg_temp.eq('C14a serie billed cierra',
    (SELECT sum((e->>'billed')::numeric) FROM jsonb_array_elements(j->'billing_vs_collections') e),
    (j->'summary'->>'net_sales')::numeric);
  PERFORM pg_temp.eq('C14b serie collected cierra',
    (SELECT sum((e->>'collected')::numeric) FROM jsonb_array_elements(j->'billing_vs_collections') e),
    (j->'summary'->>'collections')::numeric);

  -- ══════════════════════════════════════════════════════════════════════════
  -- §34 — MEDIOS DE COBRO
  -- ══════════════════════════════════════════════════════════════════════════
  -- efectivo: 12000 (S1) + 5000 (S3) + 8000 (S4) - 8000 (anulacion) = 17000
  PERFORM pg_temp.eq('C15 efectivo neto',
    (SELECT (e->>'amount')::numeric FROM jsonb_array_elements(j->'payment_mix') e
      WHERE e->>'method' = 'efectivo'), 17000);
  -- transferencia: 8000 (S1) + 7000 (S7 sustituto) = 15000
  PERFORM pg_temp.eq('C16a transferencia incluye el sustituto',
    (SELECT (e->>'amount')::numeric FROM jsonb_array_elements(j->'payment_mix') e
      WHERE e->>'method' = 'transferencia'), 15000);
  PERFORM pg_temp.eq('C16b el pago reemplazado no esta en el ledger',
    (SELECT count(*) FROM public.v_finance_collections_ledger
      WHERE comprobante_payment_id = v_pay_old), 0);

  PERFORM pg_temp.eq('C17 el mix cierra contra collections',
    (SELECT sum((e->>'amount')::numeric) FROM jsonb_array_elements(j->'payment_mix') e),
    (j->'summary'->>'collections')::numeric);

  PERFORM pg_temp.eq('C18 sin categorias en cero',
    (SELECT count(*) FROM jsonb_array_elements(j->'payment_mix') e
      WHERE (e->>'amount')::numeric = 0), 0);

  PERFORM pg_temp.eq('C19 la CC no es un medio de cobro',
    (SELECT count(*) FROM jsonb_array_elements(j->'payment_mix') e
      WHERE e->>'method' ILIKE '%cuenta%'), 0);

  -- ══════════════════════════════════════════════════════════════════════════
  -- §35 — CxC / CxP
  -- ══════════════════════════════════════════════════════════════════════════
  -- CxC = S2 (30000) + S3 (5000). S1/S4/S7 estan saldados.
  PERFORM pg_temp.eq('C20a CxC total', (j->'receivables_aging'->>'total')::numeric, 35000);
  PERFORM pg_temp.eq('C20b CxC documentos', (j->'receivables_aging'->>'documents')::numeric, 2);
  PERFORM pg_temp.eq('C20c los buckets cierran',
    (SELECT sum((e->>'amount')::numeric) FROM jsonb_array_elements(j->'receivables_aging'->'buckets') e),
    (j->'receivables_aging'->>'total')::numeric);

  PERFORM pg_temp.assert('C21 comprobante saldado fuera de CxC',
    (j->'receivables_aging'->>'total')::numeric = 35000, 'un comprobante saldado entro a CxC');

  PERFORM pg_temp.eq('C22a CxP total', (j->'payables_aging'->>'total')::numeric, 50000);
  PERFORM pg_temp.eq('C22b los buckets cierran',
    (SELECT sum((e->>'amount')::numeric) FROM jsonb_array_elements(j->'payables_aging'->'buckets') e),
    (j->'payables_aging'->>'total')::numeric);

  PERFORM pg_temp.assert('C23 compra pagada fuera de CxP',
    (j->'payables_aging'->>'documents')::numeric = 1, 'la compra pagada entro a CxP');

  -- C24/C25 — aging y vencimientos son superficies distintas.
  PERFORM pg_temp.eqt('C25 sin due_date cargado',
    (j->'payables_due'->>'has_due_dates'), 'false');
  PERFORM pg_temp.eq('C24a due_soon vacio', (j->'payables_due'->>'due_soon_amount')::numeric, 0);
  PERFORM pg_temp.eq('C24b todo undated',   (j->'payables_due'->>'undated_amount')::numeric, 50000);
  PERFORM pg_temp.assert('C24c aging NO se derivo de due_date',
    (j->'payables_aging'->>'total')::numeric = 50000
    AND (j->'payables_due'->>'due_soon_amount')::numeric = 0,
    'aging y due_date se mezclaron');

  -- Con una fecha real cargada, la superficie de vencimientos se enciende sola.
  UPDATE public.supplier_purchases SET due_date = public.ar_today() + 5
    WHERE business_id = v_a AND pending_amount > 0;
  j2 := public.get_finance_charts_l1(v_a, '2026-08-01', '2026-08-10');
  PERFORM pg_temp.eqt('C24d ahora hay vencimientos', (j2->'payables_due'->>'has_due_dates'), 'true');
  PERFORM pg_temp.eq('C24e due_soon se llena', (j2->'payables_due'->>'due_soon_amount')::numeric, 50000);
  PERFORM pg_temp.eq('C24f el aging NO cambio',
    (j2->'payables_aging'->>'total')::numeric, (j->'payables_aging'->>'total')::numeric);
  UPDATE public.supplier_purchases SET due_date = NULL WHERE business_id = v_a;

  -- ══════════════════════════════════════════════════════════════════════════
  -- §36 — CAPITAL EN STOCK
  -- ══════════════════════════════════════════════════════════════════════════
  -- P1 10x1000=10000 | P2(USD) 5x2000=10000 | P3 3x0=0 | P5V 2x1500=3000
  -- P6V 4x100=400 | P9 -6x100=-600 | P4 stock 0 | P5,P6 padres | P7 inactivo | P8 servicio
  PERFORM pg_temp.eq('C26 capital en stock',
    (j->'inventory_capital'->>'inventory_at_cost')::numeric, 22800);
  -- universo valuado (stock>0 AND cost>0), comparable con dead_stock de M8
  PERFORM pg_temp.eq('C26b capital valuado',
    (j->'inventory_capital'->>'inventory_at_cost_valued')::numeric, 23400);

  -- C27 — cobertura explicita: P1,P2,P3,P5V,P6V tienen stock>0 => 5; con costo => 4
  PERFORM pg_temp.eq('C27a products_total',        (j->'inventory_capital'->>'products_total')::numeric, 5);
  PERFORM pg_temp.eq('C27b products_valued',       (j->'inventory_capital'->>'products_valued')::numeric, 4);
  PERFORM pg_temp.eq('C27c products_missing_cost', (j->'inventory_capital'->>'products_missing_cost')::numeric, 1);
  PERFORM pg_temp.eq('C27d units_missing_cost',    (j->'inventory_capital'->>'units_missing_cost')::numeric, 3);
  PERFORM pg_temp.eq('C27e coverage_pct',          (j->'inventory_capital'->>'coverage_pct')::numeric, 80.00);

  PERFORM pg_temp.assert('C28 stock cero fuera del universo',
    (j->'inventory_capital'->>'products_total')::numeric = 5, 'el stock 0 entro al universo');

  PERFORM pg_temp.eq('C29 stock negativo contado aparte',
    (j->'inventory_capital'->>'products_negative_stock')::numeric, 1);

  -- C30 — ningun padre de variante suma (ni por parent_id ni por VPREF-).
  PERFORM pg_temp.assert('C30 padres excluidos por las dos convenciones',
    (j->'inventory_capital'->>'inventory_at_cost')::numeric = 22800,
    'un padre de variante entro al capital (double-count)');

  PERFORM pg_temp.eq('C31 USD contado como producto base USD',
    (j->'inventory_capital'->>'usd_based_products')::numeric, 1);

  -- C32 — cross-business.
  j2 := public.get_finance_charts_l1(v_b, '2026-08-01', '2026-08-10');
  PERFORM pg_temp.eq('C32a B tiene su propio capital',
    (j2->'inventory_capital'->>'inventory_at_cost')::numeric, 777700);
  PERFORM pg_temp.assert('C32b A no ve el capital de B',
    (j->'inventory_capital'->>'inventory_at_cost')::numeric = 22800,
    'se filtro capital de otro negocio');

  -- C32c — aislamiento REAL por RLS, no solo por el parametro: el dueno de A
  -- pide explicitamente el business_id de B y no recibe nada. Como la RPC es
  -- SECURITY INVOKER, esto se apoya en la RLS de las tablas base.
  PERFORM set_config('role','authenticated',true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub',v_ua,'role','authenticated')::text, true);
  j2 := public.get_finance_charts_l1(v_b, '2026-08-01', '2026-08-10');
  PERFORM set_config('role','postgres',true);
  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM pg_temp.eq('C32c RLS: A pidiendo B no recibe capital ajeno',
    (j2->'inventory_capital'->>'inventory_at_cost')::numeric, 0);
  PERFORM pg_temp.eq('C32d RLS: tampoco compras ajenas',
    (j2->'inventory_flows'->>'purchases_cost')::numeric, 0);

  -- C33 — revaluacion SIN movimiento: mueve el capital, NO genera compras.
  v_num := (j->'inventory_flows'->>'purchases_cost')::numeric;
  UPDATE public.inventory SET cost_price = 3000, exchange_rate_used = 1546 WHERE id = v_p2;
  j2 := public.get_finance_charts_l1(v_a, '2026-08-01', '2026-08-10');
  PERFORM pg_temp.eq('C33a el capital sube por revaluacion',
    (j2->'inventory_capital'->>'inventory_at_cost')::numeric, 27800);
  PERFORM pg_temp.eq('C33b la revaluacion NO es una compra',
    (j2->'inventory_flows'->>'purchases_cost')::numeric, v_num);
  PERFORM pg_temp.eq('C33c la revaluacion NO mueve el consumo',
    (j2->'inventory_flows'->>'consumption_cost')::numeric,
    (j ->'inventory_flows'->>'consumption_cost')::numeric);
  UPDATE public.inventory SET cost_price = 2000, exchange_rate_used = 1430 WHERE id = v_p2;

  -- C34/C35 — lo bloqueado se declara, no se inventa.
  PERFORM pg_temp.eqt('C34a sin serie historica',
    (j->'inventory_capital'->>'history_available'), 'false');
  PERFORM pg_temp.eqt('C34b con motivo',
    (j->'inventory_capital'->>'history_blocked_reason'), 'no_historical_cost_basis');
  PERFORM pg_temp.eqt('C35a puente bloqueado',
    (j->'inventory_flows'->>'bridge_available'), 'false');
  PERFORM pg_temp.eqt('C35b con motivo',
    (j->'inventory_flows'->>'bridge_blocked_reason'), 'heterogeneous_cost_basis');

  -- ══════════════════════════════════════════════════════════════════════════
  -- §37 — REPOSICION
  -- ══════════════════════════════════════════════════════════════════════════
  -- En A: compras = 10x1000 + 5x400 = 12000 ; consumo (COGS) = 24000 -> 50 %
  PERFORM pg_temp.eq('C40a compras del periodo',
    (j->'inventory_flows'->>'purchases_cost')::numeric, 12000);
  PERFORM pg_temp.eq('C42 el consumo sale del COGS devengado',
    (j->'inventory_flows'->>'consumption_cost')::numeric,
    (j->'summary'->>'cogs')::numeric);
  PERFORM pg_temp.eq('C37 reposicion 50 %',
    (j->'inventory_flows'->>'replenishment_pct')::numeric, 50.00);

  -- C40 — el ajuste (qty 5, unit_cost 999) NO entro al numerador.
  PERFORM pg_temp.assert('C40b el ajuste no es compra',
    (j->'inventory_flows'->>'purchases_cost')::numeric = 12000,
    'un ajuste se conto como compra');
  PERFORM pg_temp.eq('C40c el ajuste se reporta aparte',
    (j->'inventory_flows'->>'adjustments_units')::numeric, 5);

  -- C41 — la devolucion (qty 2) NO es compra.
  PERFORM pg_temp.eq('C41 la devolucion se reporta aparte',
    (j->'inventory_flows'->>'returns_units')::numeric, 2);

  -- C42b — las salidas no tienen costo y eso se declara.
  PERFORM pg_temp.eq('C42b salidas sin costo declaradas',
    (j->'inventory_flows'->>'consumption_movements_uncosted')::numeric, 2);

  -- Ratios controlados en C: mismo consumo, distintas compras.
  INSERT INTO public.comprobantes
    (id, business_id, tipo, status, estado, estado_fiscal, fecha, total, saldo_pendiente)
  VALUES (gen_random_uuid(), v_c,'factura_c','issued','emitido','no_fiscal','2026-08-03 12:00-03', 50000, 0);
  INSERT INTO public.comprobante_items
    (comprobante_id, business_id, descripcion, tipo_linea, cantidad, precio_unitario, subtotal, costo_unitario, costo_total)
  SELECT id, v_c,'X','producto',1,50000,50000,10000,10000 FROM public.comprobantes WHERE business_id = v_c;
  INSERT INTO public.inventory
    (id, business_id, code, name, category, cost_price, sale_price, stock_quantity, is_active, tipo)
  VALUES (gen_random_uuid(), v_c,'L1-C1','c','cat',1,1,1,true,'product');

  -- 100 %
  INSERT INTO public.inventory_movements
    (business_id, inventory_item_id, movement_type, quantity, previous_stock, new_stock, unit_cost, created_at)
  SELECT v_c, id,'purchase', 10, 0, 10, 1000,'2026-08-02 12:00-03'
    FROM public.inventory WHERE business_id = v_c;
  j2 := public.get_finance_charts_l1(v_c, '2026-08-01', '2026-08-10');
  PERFORM pg_temp.eq('C36 reposicion 100 %', (j2->'inventory_flows'->>'replenishment_pct')::numeric, 100.00);

  -- 150 %
  INSERT INTO public.inventory_movements
    (business_id, inventory_item_id, movement_type, quantity, previous_stock, new_stock, unit_cost, created_at)
  SELECT v_c, id,'purchase', 5, 10, 15, 1000,'2026-08-02 12:00-03'
    FROM public.inventory WHERE business_id = v_c;
  j2 := public.get_finance_charts_l1(v_c, '2026-08-01', '2026-08-10');
  PERFORM pg_temp.eq('C38 reposicion 150 %', (j2->'inventory_flows'->>'replenishment_pct')::numeric, 150.00);

  -- C39 — sin consumo comparable: NULL y motivo, jamas Infinity.
  j2 := public.get_finance_charts_l1(v_c, '2026-09-01', '2026-09-10');
  PERFORM pg_temp.assert('C39a sin consumo -> NULL',
    (j2->'inventory_flows'->'replenishment_pct') = 'null'::jsonb,
    'deberia ser NULL sin consumo comparable');
  PERFORM pg_temp.eqt('C39b con motivo',
    (j2->'inventory_flows'->>'replenishment_basis'), 'no_comparable_consumption');

  -- ══════════════════════════════════════════════════════════════════════════
  -- §38 — COMPARACION
  -- ══════════════════════════════════════════════════════════════════════════
  PERFORM pg_temp.eqt('C43a inicio de la comparacion',
    (j->'comparison_period'->>'start'), '2026-07-22');
  PERFORM pg_temp.eqt('C43b fin de la comparacion',
    (j->'comparison_period'->>'end'), '2026-07-31');
  PERFORM pg_temp.eq('C43c misma duracion',
    (j->'comparison_period'->>'days')::numeric, (j->'period'->>'days')::numeric);
  PERFORM pg_temp.eq('C43d ventas del periodo anterior',
    (j->'comparison'->>'net_sales')::numeric, 15000);
  PERFORM pg_temp.eq('C43e cobros del periodo anterior',
    (j->'comparison'->>'collections')::numeric, 15000);
  PERFORM pg_temp.eqt('C43f hay base de comparacion',
    (j->'comparison'->>'available'), 'true');

  -- C44 — sin base.
  j2 := public.get_finance_charts_l1(v_a, '2025-06-01', '2025-06-10');
  PERFORM pg_temp.eqt('C44a available=false', (j2->'comparison'->>'available'), 'false');
  PERFORM pg_temp.assert('C44b margen sin base es NULL',
    (j2->'comparison'->'margin_pct') = 'null'::jsonb, 'deberia ser NULL sin base');

  -- C45 — granularidad.
  PERFORM pg_temp.eqt('C45a 10 dias -> dia',
    (public.get_finance_charts_l1(v_a,'2026-08-01','2026-08-10')->'period'->>'granularity'),'day');
  PERFORM pg_temp.eqt('C45b 31 dias -> dia',
    (public.get_finance_charts_l1(v_a,'2026-07-01','2026-07-31')->'period'->>'granularity'),'day');
  PERFORM pg_temp.eqt('C45c 61 dias -> semana',
    (public.get_finance_charts_l1(v_a,'2026-06-01','2026-07-31')->'period'->>'granularity'),'week');
  PERFORM pg_temp.eqt('C45d 212 dias -> mes',
    (public.get_finance_charts_l1(v_a,'2026-01-01','2026-07-31')->'period'->>'granularity'),'month');
  PERFORM pg_temp.eqt('C45e forzada',
    (public.get_finance_charts_l1(v_a,'2026-08-01','2026-08-10','week')->'period'->>'granularity'),'week');

  RAISE NOTICE 'Charts L1 — C01..C45 OK';
END
$main$;

-- ══════════════════════════════════════════════════════════════════════════
-- C46 / C47 — SEGURIDAD
-- ══════════════════════════════════════════════════════════════════════════
DO $sec$
BEGIN
  IF pg_temp.acceso_anon_l1() <> '' THEN
    RAISE EXCEPTION 'C46a FALLO: anon lee %', pg_temp.acceso_anon_l1();
  END IF;

  IF has_function_privilege('anon',
       'public.get_finance_charts_l1(uuid,date,date,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'C46b FALLO: anon puede ejecutar la RPC';
  END IF;
  IF has_function_privilege('public',
       'public.get_finance_charts_l1(uuid,date,date,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'C46c FALLO: PUBLIC puede ejecutar la RPC';
  END IF;

  -- C47 NEGATIVO: si el cierre fuera cosmetico, esto no cambiaria nada.
  GRANT SELECT ON public.v_finance_inventory_capital TO anon;
  IF pg_temp.acceso_anon_l1() = '' THEN
    RAISE EXCEPTION 'C47 FALLO: el detector no ve una apertura real';
  END IF;
  REVOKE SELECT ON public.v_finance_inventory_capital FROM anon;
  IF pg_temp.acceso_anon_l1() <> '' THEN
    RAISE EXCEPTION 'C47b FALLO: no se pudo cerrar de nuevo';
  END IF;

  RAISE NOTICE 'Charts L1 — C46..C47 OK';
END
$sec$;

ROLLBACK;
