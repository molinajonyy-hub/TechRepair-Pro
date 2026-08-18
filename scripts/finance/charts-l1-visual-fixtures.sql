-- ============================================================================
-- Charts L1 — FIXTURES PARA EL GATE VISUAL (§42). SOLO ENTORNO LOCAL.
--
-- Puebla el negocio E2E con los escenarios que el gate necesita ver dibujados:
--   negocio rentable · facturacion alta con cobros bajos · pago mixto ·
--   cuenta corriente · anulacion · nota de credito · deuda de proveedor ·
--   proveedor con y sin due_date · inventario ARS y USD · producto sin costo ·
--   compra · consumo · ajuste · devolucion · reposicion < 100 % · dead stock.
--
-- NO es una migracion. NO se aplica a produccion. NO hace backfill de nada:
-- inserta filas nuevas en un negocio de prueba descartable.
--
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < scripts/finance/charts-l1-visual-fixtures.sql
--
-- FAIL-CLOSED: aborta si no encuentra el marker de entorno E2E local
-- (public.e2e_environment_marker con environment='e2e_local'). Ese marker no
-- existe en produccion y ninguna migracion lo crea, asi que este script no
-- puede correr contra la base viva ni por accidente.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.e2e_environment_marker') IS NULL THEN
    RAISE EXCEPTION 'ABORTA: no hay marker de entorno E2E. Este script es SOLO local.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.e2e_environment_marker
                  WHERE id = 1 AND environment = 'e2e_local') THEN
    RAISE EXCEPTION 'ABORTA: el marker no dice environment=e2e_local.';
  END IF;
END
$guard$;

DO $fx$
DECLARE
  v_biz  uuid := '00000000-0000-0000-0000-00000e2eb001';
  v_user uuid;
  v_cust uuid := '00000000-0000-0000-0000-00000e2ec001';
  -- Comprobantes
  v_c1 uuid := gen_random_uuid();   -- cobrado mixto
  v_c2 uuid := gen_random_uuid();   -- cuenta corriente, sin cobrar
  v_c3 uuid := gen_random_uuid();   -- cobro parcial
  v_c4 uuid := gen_random_uuid();   -- anulado
  v_c5 uuid := gen_random_uuid();   -- nota de credito
  v_c6 uuid := gen_random_uuid();   -- periodo anterior (da base de comparacion)
  -- Inventario
  v_p1 uuid := gen_random_uuid();   -- ARS con costo
  v_p2 uuid := gen_random_uuid();   -- base USD
  v_p3 uuid := gen_random_uuid();   -- SIN costo -> estado `incomplete`
  v_p4 uuid := gen_random_uuid();   -- dead stock (sin movimientos)
  -- ── Anclas temporales ──────────────────────────────────────────────────────
  --
  -- El dashboard filtra por MES CALENDARIO ("mes actual" / "mes anterior"), asi
  -- que un fixture que dice "mes anterior" con `d0 - N dias` solo acierta
  -- segun el dia en que se corra. Eso hacia que el gate pasara el 14 y fallara
  -- el 18 del mismo mes, sin un solo cambio de producto: con d0 = 2026-08-18,
  -- `d0-16` = 2026-08-02 seguia dentro de agosto y el mes anterior quedaba sin
  -- consumo devengado, asi que la reposicion mostraba "Sin consumo comparable"
  -- en vez del 0 % contextual.
  --
  -- Por eso hay DOS clases de fecha, y cada dato usa la que le corresponde:
  --
  --   * `mes_ant(k)`  - el dato pertenece al MES CALENDARIO ANTERIOR. Se ancla
  --     al dia (k+1) de ese mes. k <= 27 siempre cae dentro, incluso en febrero.
  --
  --   * `en_mes(n)`   - el dato es "hace n dias" PERO no puede salirse del mes
  --     actual: los primeros dias del mes, `d0 - n` se iria al mes anterior y
  --     contaminaria el periodo de comparacion (p. ej. metiendo entradas de
  --     inventario donde el test exige que no haya ninguna).
  --
  -- El aging de proveedores (30+/60+) NO usa ninguna de las dos: es antiguedad
  -- real en dias y se mide contra d0, no contra un mes.
  d0     date := public.ar_today();
  m_cur  date := date_trunc('month', d0)::date;
  m_ant  date := (date_trunc('month', d0) - interval '1 month')::date;
  -- Posicion canonica dentro del mes anterior (dia 15: existe en todo mes).
  d_ant  date := (date_trunc('month', d0) - interval '1 month')::date + 14;
BEGIN
  SELECT id INTO v_user FROM public.profiles WHERE business_id = v_biz LIMIT 1;

  -- Limpieza idempotente de corridas anteriores de ESTE script.
  --
  -- `comprobante_annulments` es APPEND-ONLY: el trigger
  -- comprobante_annulments_immutable() rechaza DELETE, que es exactamente lo que
  -- debe hacer en producción. Acá se lo desactiva por la duración de esta
  -- transacción para poder reconstruir el fixture; el marker de entorno de más
  -- arriba garantiza que esto sólo ocurre contra el stack local descartable.
  -- `comprobante_payments` necesita el mismo trato desde que este script corre
  -- dentro de `e2e:prepare`: comprobante_payments_replacement_guard() rechaza
  -- borrar un pago REEMPLAZADO, y los specs `replace-*` dejan varios. Sin esto,
  -- preparar el entorno falla en cualquier maquina donde la suite ya corrio
  -- (en un runner limpio no hay pagos reemplazados y el problema no se ve).
  ALTER TABLE public.comprobante_payments DISABLE TRIGGER USER;
  DELETE FROM public.comprobante_payments WHERE business_id = v_biz;
  ALTER TABLE public.comprobante_payments ENABLE TRIGGER USER;
  ALTER TABLE public.comprobante_annulments DISABLE TRIGGER USER;
  DELETE FROM public.comprobante_annulments WHERE business_id = v_biz;
  ALTER TABLE public.comprobante_annulments ENABLE TRIGGER USER;
  DELETE FROM public.comprobante_items WHERE business_id = v_biz;
  -- `comprobante_checkout_requests` tiene que irse ANTES que los comprobantes y
  -- también es APPEND-ONLY, así que va con el mismo trato que las dos de arriba.
  -- Su FK a comprobantes es ON DELETE SET NULL y el trigger rechaza que un
  -- comprobante_id ya fijado cambie: borrar el comprobante primero aborta la
  -- transacción entera con "comprobante_id ya fijado es inmutable".
  -- No se veía hasta ahora porque ningún spec cobraba por el POS real — los
  -- fixtures insertan comprobantes por SQL, y esos no crean checkout request.
  -- El primero que cobra de verdad es tests/e2e/m7/search-variantes.spec.ts.
  ALTER TABLE public.comprobante_checkout_requests DISABLE TRIGGER USER;
  DELETE FROM public.comprobante_checkout_requests WHERE business_id = v_biz;
  ALTER TABLE public.comprobante_checkout_requests ENABLE TRIGGER USER;
  DELETE FROM public.comprobantes WHERE business_id = v_biz;
  DELETE FROM public.inventory_movements WHERE business_id = v_biz;
  DELETE FROM public.business_finance_entries WHERE business_id = v_biz;
  DELETE FROM public.supplier_purchases WHERE business_id = v_biz;
  DELETE FROM public.owner_withdrawals WHERE business_id = v_biz;
  DELETE FROM public.inventory WHERE business_id = v_biz AND code LIKE 'L1V-%';

  INSERT INTO public.customers (id, business_id, name, phone)
  VALUES (v_cust, v_biz, 'Cliente Gate L1', '3510000000')
  ON CONFLICT (id) DO NOTHING;

  -- ── Comprobantes ─────────────────────────────────────────────────────────
  -- c1..c5 son del MES ACTUAL (GREATEST los sujeta al mes aunque hoy sea el 3).
  -- c6 es la base de comparacion y pertenece al MES ANTERIOR: su costo_total es
  -- el unico consumo devengado de ese periodo, que es lo que el test P1-D usa
  -- para exigir el 0 % contextual.
  --
  -- estado_fiscal explicito: un fixture no delega en el DEFAULT el estado inicial,
  -- que depende de si el comprobante es fiscal. (El DEFAULT invalido 'borrador'
  -- que ANTES obligaba a esto se corrigio en 20260810140000.)
  INSERT INTO public.comprobantes
    (id, business_id, tipo, status, estado, estado_fiscal, fecha, total, total_bruto, saldo_pendiente, customer_id)
  VALUES
    (v_c1, v_biz,'factura_c','issued','emitido','no_fiscal', GREATEST(d0-7, m_cur)::timestamptz + interval '12 h', 185000, 185000, 185000, NULL),
    (v_c2, v_biz,'factura_c','issued','emitido','no_fiscal', GREATEST(d0-5, m_cur)::timestamptz + interval '12 h', 240000, 240000, 240000, v_cust),
    (v_c3, v_biz,'factura_c','issued','emitido','no_fiscal', GREATEST(d0-4, m_cur)::timestamptz + interval '12 h', 96000,  96000,  96000,  v_cust),
    (v_c4, v_biz,'factura_c','issued','emitido','no_fiscal', GREATEST(d0-3, m_cur)::timestamptz + interval '12 h', 64000,  64000,  64000,  NULL),
    (v_c5, v_biz,'nota_credito','issued','emitido','no_fiscal', GREATEST(d0-2, m_cur)::timestamptz + interval '12 h', 38000, 38000, 0, NULL),
    (v_c6, v_biz,'factura_c','issued','emitido','no_fiscal', d_ant::timestamptz + interval '12 h', 150000, 150000, 150000, NULL);

  INSERT INTO public.comprobante_items
    (comprobante_id, business_id, descripcion, tipo_linea, cantidad, precio_unitario, subtotal, costo_unitario, costo_total)
  VALUES
    (v_c1, v_biz,'Modulo display','producto', 2,  92500, 185000, 41000,  82000),
    (v_c2, v_biz,'Bateria premium','producto',4,  60000, 240000, 27000, 108000),
    (v_c3, v_biz,'Servicio tecnico','servicio',1, 96000,  96000, 22000,  22000),
    (v_c4, v_biz,'Placa madre','producto',    1,  64000,  64000, 31000,  31000),
    (v_c6, v_biz,'Pantalla OLED','producto',  2,  75000, 150000, 33000,  66000);

  -- Cobros: mixto, parcial, y uno que despues se anula.
  INSERT INTO public.comprobante_payments
    (comprobante_id, business_id, amount, amount_ars, payment_method, date)
  VALUES
    (v_c1, v_biz, 120000, 120000,'efectivo',        GREATEST(d0-7, m_cur)),
    (v_c1, v_biz,  65000,  65000,'transferencia',   GREATEST(d0-7, m_cur)),
    (v_c3, v_biz,  40000,  40000,'tarjeta_credito', GREATEST(d0-4, m_cur)),
    (v_c4, v_biz,  64000,  64000,'efectivo',        GREATEST(d0-3, m_cur)),
    -- El cobro de c6 acompana a su comprobante: tambien va al mes anterior.
    (v_c6, v_biz, 150000, 150000,'transferencia',   d_ant);

  -- Anulacion del c4 DENTRO del periodo: compensa venta y cobro.
  INSERT INTO public.comprobante_annulments
    (business_id, comprobante_id, user_id, idempotency_key, request_hash, mode,
     motivo, restore_stock, status, annulment_date)
  VALUES (v_biz, v_c4, v_user, 'l1-visual-c4', 'l1-visual-hash-c4',
          'commercial_annulment','fixture gate visual', false,'completed', GREATEST(d0-1, m_cur));

  -- ── Gastos operativos del P&L ────────────────────────────────────────────
  INSERT INTO public.business_finance_entries
    (business_id, date, type, category, amount, amount_ars, economic_class)
  VALUES
    (v_biz, GREATEST(d0-8, m_cur),'fixed_cost_local','Alquiler',  70000, 70000,'operating_expense'),
    (v_biz, GREATEST(d0-6, m_cur),'salary',          'Sueldos',   95000, 95000,'employee_salary'),
    (v_biz, GREATEST(d0-4, m_cur),'variable_cost',   'Comisiones', 8400,  8400,'payment_fee'),
    -- El alquiler del mes anterior es la base de comparacion del P&L.
    (v_biz, d_ant,                'fixed_cost_local','Alquiler',  70000, 70000,'operating_expense');

  -- Retiro del dueno: se informa aparte, NUNCA como gasto operativo.
  INSERT INTO public.owner_withdrawals (business_id, user_id, amount, flow_type, status, date)
  VALUES (v_biz, v_user, 50000,'withdrawal','completed', GREATEST(d0-5, m_cur));

  -- ── Inventario: ARS, USD, sin costo y dead stock ─────────────────────────
  INSERT INTO public.inventory
    (id, business_id, code, name, category, cost_price, sale_price, stock_quantity,
     is_active, tipo, base_currency, cost_price_usd, exchange_rate_used)
  VALUES
    (v_p1, v_biz,'L1V-001','Bateria premium','Repuestos', 27000, 60000, 32, true,'product','ARS',   0,    0),
    (v_p2, v_biz,'L1V-002','Modulo display', 'Repuestos', 41000, 92500, 18, true,'product','USD', 28.5, 1438),
    (v_p3, v_biz,'L1V-003','Cable generico', 'Accesorios',    0,  4500, 25, true,'product','ARS',   0,    0),
    (v_p4, v_biz,'L1V-004','Placa legacy',   'Repuestos', 31000, 64000,  9, true,'product','ARS',   0,    0);

  -- Movimientos: compras (reponen) + salidas + ajuste + devolucion (no reponen).
  INSERT INTO public.inventory_movements
    (business_id, inventory_item_id, movement_type, quantity, previous_stock, new_stock,
     unit_cost, reference_type, created_at)
  VALUES
    -- Compras deliberadamente por DEBAJO del consumo del periodo: es el caso
    -- que describe §21 (reposicion < 100 %) y el que el gate tiene que mostrar.
    --
    -- TODOS van sujetos al mes actual: el mes anterior tiene que quedar SIN una
    -- sola entrada de inventario, que es la mitad del caso que prueba P1-D
    -- ("No se registraron entradas de mercaderia..."). Sin el GREATEST, correr
    -- el gate un dia 3 empujaba estas compras al mes anterior y lo invalidaba.
    (v_biz, v_p1,'purchase',   3,  29, 32, 27000,'supplier_purchase', GREATEST(d0-8, m_cur)::timestamptz + interval '12 h'),
    (v_biz, v_p2,'purchase',   1,  17, 18, 41000,'supplier_purchase', GREATEST(d0-6, m_cur)::timestamptz + interval '12 h'),
    (v_biz, v_p1,'sale',      -4,  32, 28, NULL, 'comprobante',       GREATEST(d0-5, m_cur)::timestamptz + interval '12 h'),
    (v_biz, v_p2,'sale',      -2,  18, 16, NULL, 'comprobante',       GREATEST(d0-7, m_cur)::timestamptz + interval '12 h'),
    (v_biz, v_p1,'order_usage',-1, 28, 27, NULL, 'order',             GREATEST(d0-4, m_cur)::timestamptz + interval '12 h'),
    (v_biz, v_p1,'adjustment',  3, 27, 30, NULL, 'adjustment',        GREATEST(d0-3, m_cur)::timestamptz + interval '12 h'),
    (v_biz, v_p2,'return',      2, 16, 18, NULL, 'comprobante',       GREATEST(d0-1, m_cur)::timestamptz + interval '12 h');

  -- ── Deuda con proveedores: una CON fecha, una SIN ────────────────────────
  INSERT INTO public.supplier_purchases
    (business_id, purchase_date, total_amount, paid_amount, pending_amount, payment_status, due_date)
  VALUES
    -- Los tramos de aging son ANTIGUEDAD REAL en dias contra d0, no pertenencia
    -- a un mes: por eso 40 y 75 se dejan relativos y no se anclan a un calendario.
    (v_biz, GREATEST(d0-6, m_cur), 310000,      0, 310000,'pending', d0+9),   -- vence pronto
    (v_biz, d0-40,                 145000,  45000, 100000,'partial', NULL),   -- sin fecha acordada
    (v_biz, d0-75,                  88000,      0,  88000,'pending', NULL),   -- tramo 60+
    (v_biz, GREATEST(d0-2, m_cur), 120000, 120000,      0,'paid',    NULL),   -- saldada: fuera de CxP
    -- Compra explicita EN el mes anterior. P1-D exige que, en ese periodo, haya
    -- compras a proveedores registradas para que aparezca el aviso condicional.
    -- No se puede depender de `d0-40` para esto: un dia 5, 40 dias atras cae DOS
    -- meses atras y el aviso desaparece.
    (v_biz, d_ant,                  96000,      0,  96000,'pending', NULL);

  RAISE NOTICE 'Charts L1 — fixtures del gate visual cargadas en el negocio E2E.';
END
$fx$;

COMMIT;
