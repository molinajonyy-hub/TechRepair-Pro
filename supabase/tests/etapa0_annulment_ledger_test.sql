-- ============================================================
-- Test suite Etapa 0 — annul_comprobante_atomic + delete guard + ledger lock
-- (migraciones 20260702120000 / 20260702130000 / 20260702140000)
--
-- HOW TO RUN (local stack, NUNCA prod):
--   supabase db reset
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f /dev/stdin < supabase/tests/etapa0_annulment_ledger_test.sql
--
-- La concurrencia real de anulación entre DOS conexiones queda cubierta por
-- diseño (SELECT ... FOR UPDATE del comprobante + UNIQUE(business_id,
-- idempotency_key) + UNIQUE parcial por comprobante): la segunda transacción
-- espera el lock y luego ve 'ya está anulado' o el replay. El patrón es el
-- mismo que valida run-checkout-idempotency-concurrency-test.ps1.
-- Runs inside a single transaction and ROLLBACKs at the end.
-- ============================================================
BEGIN;
SET LOCAL client_min_messages = notice;

CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label;
  ELSE RAISE NOTICE 'PASS: %', label; END IF;
END; $$;

\set biz    '00000000-0000-0000-0000-0000000a0a01'
\set owner  '00000000-0000-0000-0000-0000000a0a09'
\set cust   '00000000-0000-0000-0000-0000000a0c01'
\set prod   '00000000-0000-0000-0000-0000000a0d01'
\set manual1 '00000000-0000-0000-0000-0000000a0f01'
\set manual2 '00000000-0000-0000-0000-0000000a0f02'

SET LOCAL session_replication_role = 'replica';
INSERT INTO auth.users(id) VALUES (:'owner');
INSERT INTO businesses(id, name, owner_user_id) VALUES (:'biz', 'Etapa0 Anulación', :'owner');
INSERT INTO profiles(business_id, user_id, role, is_active) VALUES (:'biz', :'owner', 'owner', true);
INSERT INTO customers(id, business_id, name, phone) VALUES (:'cust', :'biz', 'Cliente CC', '+540000000001');
INSERT INTO inventory(id, business_id, name, code, category, stock_quantity, stock, cost_price, sale_price, base_currency, is_active)
  VALUES (:'prod', :'biz', 'Producto Anulable', 'ETAPA0-ANL-001', 'Repuestos', 50, 50, 600, 1000, 'ARS', true);
SET LOCAL session_replication_role = 'origin';

-- Caja 1 abierta (vía SQL normal — el índice único la protege)
DO $$ BEGIN
  INSERT INTO cajas (id, business_id, status, efectivo_inicial, transferencia_inicial, tarjeta_inicial, usd_inicial, usd_cotizacion_apertura)
    VALUES ('00000000-0000-0000-0000-0000000a0ca1', '00000000-0000-0000-0000-0000000a0a01', 'abierta', 0, 0, 0, 0, 1);
END $$;

-- Movimientos manuales para las pruebas de corrección (caja 1)
SET LOCAL session_replication_role = 'replica';
INSERT INTO financial_movements(id, business_id, caja_id, type, currency, amount, amount_ars, exchange_rate, source, description, date, metodo_pago, sign)
  VALUES
  (:'manual1', :'biz', '00000000-0000-0000-0000-0000000a0ca1', 'income', 'ARS', 5000, 5000, 1, 'manual', 'Ingreso manual test', public.ar_today(), 'efectivo', 1),
  (:'manual2', :'biz', '00000000-0000-0000-0000-0000000a0ca1', 'income', 'ARS', 7000, 7000, 1, 'manual', 'Ingreso manual test 2', public.ar_today(), 'efectivo', 1);
SET LOCAL session_replication_role = 'origin';

-- Helpers de payload (idénticos al suite de invariantes)
CREATE OR REPLACE FUNCTION pg_temp.payload(p_qty numeric, p_pagos jsonb, p_cc numeric, p_customer text DEFAULT NULL, p_fiscal boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'tipo', 'factura_c', 'punto_venta', '0001', 'condicion_fiscal', 'Consumidor Final',
    'customer_id', p_customer, 'es_fiscal', p_fiscal, 'emitir_en_arca', false,
    'skip_finance_entry', false, 'exchange_rate', 1, 'cc_total', p_cc,
    'total_comisiones', 0,
    'items', jsonb_build_array(jsonb_build_object(
      'descripcion', 'Producto Anulable', 'tipo_linea', 'producto',
      'cantidad', p_qty, 'precio_unitario', 1000, 'descuento_linea', 0,
      'costo_unitario', 600, 'currency', 'ARS', 'exchange_rate', 1,
      'inventory_id', '00000000-0000-0000-0000-0000000a0d01')),
    'pagos', p_pagos)
$$;
CREATE OR REPLACE FUNCTION pg_temp.pago(p_metodo text, p_monto numeric)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('payment_method', p_metodo, 'amount', p_monto,
    'currency', 'ARS', 'amount_ars', p_monto, 'exchange_rate', 1,
    'commission_rate', 0, 'commission_amount', 0, 'net_amount', p_monto)
$$;
CREATE OR REPLACE FUNCTION pg_temp.venta(p_key text, p_qty numeric, p_pagos jsonb, p_cc numeric, p_customer text DEFAULT NULL, p_fiscal boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000a0a01'::uuid,
    p_key, p_key || '-hash', pg_temp.payload(p_qty, p_pagos, p_cc, p_customer, p_fiscal));
  IF r->>'status' NOT IN ('created') THEN
    RAISE EXCEPTION 'seed venta % fallo: %', p_key, r::text;
  END IF;
  RETURN (r->>'comprobante_id')::uuid;
END $$;

-- ════════════════════════════════════════════════════════════
-- L: PROTECCIÓN DE LEDGER (grants + policies) — antes de anular nada
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_comp uuid; v_denied boolean; v_rows integer; v_bfe_manual uuid;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a0a09';
  v_comp := pg_temp.venta('l0-key', 1, jsonb_build_array(pg_temp.pago('efectivo', 1000)), 0);
  RESET ROLE;

  -- BFE manual (source default 'manual', sin referencia)
  SET LOCAL session_replication_role = 'replica';
  INSERT INTO business_finance_entries(id, business_id, date, type, category, description, amount, currency, amount_ars, exchange_rate)
    VALUES ('00000000-0000-0000-0000-0000000a0be1', '00000000-0000-0000-0000-0000000a0a01',
            public.ar_today(), 'fixed_cost_local', 'alquiler', 'Asiento manual test', 100, 'ARS', 100, 1);
  SET LOCAL session_replication_role = 'origin';

  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a0a09';

  -- L1: UPDATE de FM automático → permission denied (grant revocado)
  v_denied := false;
  BEGIN
    UPDATE financial_movements SET description = 'hackeado' WHERE comprobante_id = v_comp;
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  PERFORM pg_temp.assert(v_denied, 'L1 UPDATE directo de financial_movements -> permission denied');

  -- L2: DELETE de FM → denied
  v_denied := false;
  BEGIN
    DELETE FROM financial_movements WHERE comprobante_id = v_comp;
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  PERFORM pg_temp.assert(v_denied, 'L2 DELETE directo de financial_movements -> permission denied');

  -- L3: DELETE/UPDATE de pagos procesados → denied
  v_denied := false;
  BEGIN
    DELETE FROM comprobante_payments WHERE comprobante_id = v_comp;
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  PERFORM pg_temp.assert(v_denied, 'L3a DELETE directo de comprobante_payments -> permission denied');
  v_denied := false;
  BEGIN
    UPDATE comprobante_payments SET amount_ars = 1 WHERE comprobante_id = v_comp;
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  PERFORM pg_temp.assert(v_denied, 'L3b UPDATE directo de comprobante_payments -> permission denied');

  -- L4: UPDATE/DELETE de account_movements → denied
  v_denied := false;
  BEGIN
    UPDATE account_movements SET debit = 0 WHERE business_id = '00000000-0000-0000-0000-0000000a0a01';
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  PERFORM pg_temp.assert(v_denied, 'L4a UPDATE directo de account_movements -> permission denied');
  v_denied := false;
  BEGIN
    DELETE FROM account_movements WHERE business_id = '00000000-0000-0000-0000-0000000a0a01';
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  PERFORM pg_temp.assert(v_denied, 'L4b DELETE directo de account_movements -> permission denied');

  -- L5: BFE — manual editable, automático inmutable (policy, no error: 0 filas)
  UPDATE business_finance_entries SET notes = 'corregido'
    WHERE id = '00000000-0000-0000-0000-0000000a0be1';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM pg_temp.assert(v_rows = 1, 'L5a BFE MANUAL sigue siendo corregible (1 fila)');

  UPDATE business_finance_entries SET amount_ars = 1
    WHERE reference_comprobante_id = v_comp AND type = 'income';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM pg_temp.assert(v_rows = 0, 'L5b BFE AUTOMÁTICO (income de venta) NO es editable (0 filas por policy)');

  DELETE FROM business_finance_entries WHERE reference_comprobante_id = v_comp;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM pg_temp.assert(v_rows = 0, 'L5c BFE AUTOMÁTICO no es borrable (0 filas por policy)');
  RESET ROLE;
END $$;

-- ════════════════════════════════════════════════════════════
-- L6: reverse_manual_cash_movement — corrección controlada
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_auto_fm uuid;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a0a09';

  r := reverse_manual_cash_movement('00000000-0000-0000-0000-0000000a0f01'::uuid, 'me equivoqué de monto');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'L6a corrección de movimiento MANUAL en caja abierta -> ok');

  r := reverse_manual_cash_movement('00000000-0000-0000-0000-0000000a0f01'::uuid, 'de nuevo');
  PERFORM pg_temp.assert((r->>'ok')::boolean IS NOT TRUE AND r->>'error' ILIKE '%ya fue corregido%',
    'L6b segunda corrección del mismo movimiento -> rechazada (no duplica)');

  SELECT id INTO v_auto_fm FROM financial_movements
    WHERE business_id = '00000000-0000-0000-0000-0000000a0a01' AND source = 'comprobante' LIMIT 1;
  r := reverse_manual_cash_movement(v_auto_fm, 'intento sobre automático');
  PERFORM pg_temp.assert((r->>'ok')::boolean IS NOT TRUE AND r->>'error' ILIKE '%manuales%',
    'L6c movimiento AUTOMÁTICO no se corrige desde el cliente');

  r := reverse_manual_cash_movement(NULL, 'x');
  PERFORM pg_temp.assert((r->>'ok')::boolean IS NOT TRUE, 'L6d movimiento inexistente -> error controlado');
  RESET ROLE;
END $$;

SELECT pg_temp.assert(
  (SELECT count(*) FROM financial_movements
    WHERE reference_type = 'manual_correction'
      AND reference_id = '00000000-0000-0000-0000-0000000a0f01'
      AND type = 'expense' AND amount_ars = 5000
      AND caja_id = '00000000-0000-0000-0000-0000000a0ca1') = 1,
  'L6e la reversa compensatoria existe: mismo importe, tipo opuesto, misma caja, vinculada al original');

-- ════════════════════════════════════════════════════════════
-- A1-A3: anulación con devolución (refund) + idempotencia + doble anulación
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_comp uuid; r jsonb; v_fm_orig integer; v_fm_rev integer;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a0a09';
  v_comp := pg_temp.venta('a1-key', 2, jsonb_build_array(pg_temp.pago('efectivo', 2000)), 0);

  r := annul_comprobante_atomic(v_comp, 'refund_current_session', 'cliente arrepentido', true, 'an1-key');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'A1a anulación refund -> ok (' || COALESCE(r->>'error','') || ')');
  PERFORM pg_temp.assert((r->>'reverted_cash_ars')::numeric = 2000, 'A1b revierte exactamente lo cobrado (2000)');
  PERFORM pg_temp.assert((r->>'stock_restored_count')::integer = 1, 'A1c stock restaurado (1 ítem)');
  RESET ROLE;

  PERFORM pg_temp.assert(
    (SELECT estado FROM comprobantes WHERE id = v_comp) = 'anulado',
    'A1d comprobante -> anulado');
  SELECT count(*) INTO v_fm_orig FROM financial_movements
    WHERE comprobante_id = v_comp AND type = 'income' AND COALESCE(sign,1) = 1;
  SELECT count(*) INTO v_fm_rev FROM financial_movements
    WHERE comprobante_id = v_comp AND sign = -1 AND reference_type = 'annulment_reversal';
  PERFORM pg_temp.assert(v_fm_orig = 1 AND v_fm_rev = 1,
    'A1e un FM compensatorio por CADA FM original (1:1), original intacto');
  PERFORM pg_temp.assert(
    (SELECT COALESCE(SUM(CASE WHEN COALESCE(sign,1) = 1 AND type='income' THEN amount_ars
                              WHEN sign = -1 THEN -amount_ars ELSE 0 END), 0)
       FROM financial_movements WHERE comprobante_id = v_comp) = 0,
    'A1f caja neteada: ingresos originales - reversas = 0');
  PERFORM pg_temp.assert(
    (SELECT COALESCE(SUM(amount_ars), 0) FROM business_finance_entries
      WHERE reference_comprobante_id = v_comp AND type = 'income') = 0,
    'A1g BFE income neteado a 0');
  PERFORM pg_temp.assert(
    (SELECT COALESCE(SUM(amount_ars), 0) FROM business_finance_entries
      WHERE reference_comprobante_id = v_comp AND category = 'mercaderia') = 0,
    'A1h COGS compensado a 0');
  -- Stock: 50 inicial − 1 (venta l0) − 2 (venta a1) + 2 (devolución a1) = 49
  PERFORM pg_temp.assert(
    (SELECT stock_quantity FROM inventory WHERE id = '00000000-0000-0000-0000-0000000a0d01') = 49,
    'A1i stock devuelto exactamente: 50 - 1(l0 activo) = 49');
END $$;

DO $$
DECLARE v_comp uuid; r jsonb; v_before integer; v_after integer;
BEGIN
  SELECT comprobante_id INTO v_comp FROM comprobante_annulments
    WHERE idempotency_key = 'an1-key';
  SELECT count(*) INTO v_before FROM financial_movements WHERE comprobante_id = v_comp;

  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a0a09';
  -- A2: replay con la MISMA key y el mismo payload
  r := annul_comprobante_atomic(v_comp, 'refund_current_session', 'cliente arrepentido', true, 'an1-key');
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean,
    'A2a reintento con la misma key -> replay del resultado original');
  -- A2b: misma key con payload DISTINTO
  r := annul_comprobante_atomic(v_comp, 'commercial_annulment', 'otro motivo', false, 'an1-key');
  PERFORM pg_temp.assert((r->>'ok')::boolean IS NOT TRUE AND r->>'error' ILIKE '%parámetros distintos%',
    'A2b misma key + payload distinto -> rechazada');
  -- A3: nueva key sobre comprobante ya anulado
  r := annul_comprobante_atomic(v_comp, 'refund_current_session', 'de nuevo', true, 'an3-key');
  PERFORM pg_temp.assert((r->>'ok')::boolean IS NOT TRUE AND r->>'error' ILIKE '%ya está anulado%',
    'A3 segunda anulación (key nueva) -> rechazada');
  RESET ROLE;

  SELECT count(*) INTO v_after FROM financial_movements WHERE comprobante_id = v_comp;
  PERFORM pg_temp.assert(v_before = v_after, 'A2c/A3b ni el replay ni el reintento duplicaron movimientos');
  PERFORM pg_temp.assert(
    (SELECT stock_quantity FROM inventory WHERE id = '00000000-0000-0000-0000-0000000a0d01') = 49,
    'A2d el stock se restauró EXACTAMENTE una vez');
END $$;

-- ════════════════════════════════════════════════════════════
-- A4: venta 100% CC → anulación comercial revierte la deuda, sin caja
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE v_comp uuid; r jsonb; v_fm_before integer; v_fm_after integer;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a0a09';
  v_comp := pg_temp.venta('a4-key', 1, '[]'::jsonb, 1000, '00000000-0000-0000-0000-0000000a0c01');
  RESET ROLE;

  PERFORM pg_temp.assert(
    (SELECT balance FROM accounts WHERE business_id = '00000000-0000-0000-0000-0000000a0a01'
      AND entity_id = '00000000-0000-0000-0000-0000000a0c01') = 1000,
    'A4a la venta CC generó deuda 1000');
  SELECT count(*) INTO v_fm_before FROM financial_movements
    WHERE business_id = '00000000-0000-0000-0000-0000000a0a01';

  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a0a09';
  r := annul_comprobante_atomic(v_comp, 'commercial_annulment', 'venta mal cargada', true, 'an4-key');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'A4b anulación comercial de venta CC -> ok');
  PERFORM pg_temp.assert((r->>'reverted_cc_ars')::numeric = 1000, 'A4c deuda revertida = 1000');
  RESET ROLE;

  PERFORM pg_temp.assert(
    (SELECT balance FROM accounts WHERE business_id = '00000000-0000-0000-0000-0000000a0a01'
      AND entity_id = '00000000-0000-0000-0000-0000000a0c01') = 0,
    'A4d el balance de la cuenta volvió a 0 (movimiento compensatorio, trigger de balance)');
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM account_movements am JOIN accounts a ON a.id = am.account_id
      WHERE a.entity_id = '00000000-0000-0000-0000-0000000a0c01' AND am.reference_id = v_comp) = 2,
    'A4e el histórico del ledger NO se borró: débito original + crédito compensatorio');
  SELECT count(*) INTO v_fm_after FROM financial_movements
    WHERE business_id = '00000000-0000-0000-0000-0000000a0a01';
  PERFORM pg_temp.assert(v_fm_before = v_fm_after,
    'A4f anulación comercial: CERO movimientos de caja nuevos');
END $$;

-- ════════════════════════════════════════════════════════════
-- A5: cobro parcial + CC → revierte SOLO lo cobrado por caja + la deuda
-- A6: commercial sobre venta cobrada → rechazada
-- A7: sin devolución física → stock intacto
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE v_comp uuid; r jsonb; v_stock_before integer;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a0a09';
  v_comp := pg_temp.venta('a5-key', 1, jsonb_build_array(pg_temp.pago('transferencia', 400)), 600, '00000000-0000-0000-0000-0000000a0c01');

  -- A6 primero: commercial sobre venta con cobros -> rechazada
  r := annul_comprobante_atomic(v_comp, 'commercial_annulment', 'sin plata de por medio', true, 'an6-key');
  PERFORM pg_temp.assert((r->>'ok')::boolean IS NOT TRUE AND r->>'error' ILIKE '%cobrado%',
    'A6 anulación comercial sobre venta cobrada -> rechazada');

  SELECT stock_quantity INTO v_stock_before FROM inventory WHERE id = '00000000-0000-0000-0000-0000000a0d01';
  -- A5+A7: refund SIN devolución física
  r := annul_comprobante_atomic(v_comp, 'refund_current_session', 'devuelve plata, no producto', false, 'an5-key');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'A5a refund parcial -> ok');
  PERFORM pg_temp.assert((r->>'reverted_cash_ars')::numeric = 400,
    'A5b caja revertida por lo COBRADO (400), nunca por el total (1000)');
  PERFORM pg_temp.assert((r->>'reverted_cc_ars')::numeric = 600, 'A5c deuda CC revertida (600)');
  PERFORM pg_temp.assert((r->>'stock_restored_count')::integer = 0, 'A7a sin devolución física -> 0 ítems restaurados');
  RESET ROLE;

  PERFORM pg_temp.assert(
    (SELECT stock_quantity FROM inventory WHERE id = '00000000-0000-0000-0000-0000000a0d01') = v_stock_before,
    'A7b el stock NO cambió');
  PERFORM pg_temp.assert(
    (SELECT restore_stock FROM comprobante_annulments WHERE idempotency_key = 'an5-key') = false,
    'A7c la auditoría registró que NO hubo devolución física');
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM financial_movements
      WHERE comprobante_id = v_comp AND sign = -1 AND amount_ars = 400 AND metodo_pago = 'transferencia') = 1,
    'A5d la reversa espeja método y monto del pago original');
END $$;

-- ════════════════════════════════════════════════════════════
-- A8: caja cerrada intocable — la devolución vive en la caja NUEVA
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_comp uuid; r jsonb; v_caja2 uuid;
  v_caja1_rows_before integer; v_caja1_rows_after integer;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a0a09';
  v_comp := pg_temp.venta('a8-key', 1, jsonb_build_array(pg_temp.pago('efectivo', 1000)), 0);
  RESET ROLE;

  SELECT count(*) INTO v_caja1_rows_before FROM financial_movements
    WHERE caja_id = '00000000-0000-0000-0000-0000000a0ca1';

  -- Cerrar caja 1 y abrir caja 2
  UPDATE cajas SET status = 'cerrada', closed_at = now()
    WHERE id = '00000000-0000-0000-0000-0000000a0ca1';
  INSERT INTO cajas (business_id, status, efectivo_inicial, transferencia_inicial, tarjeta_inicial, usd_inicial, usd_cotizacion_apertura)
    VALUES ('00000000-0000-0000-0000-0000000a0a01', 'abierta', 0, 0, 0, 0, 1)
    RETURNING id INTO v_caja2;

  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a0a09';

  -- void_same_session sobre venta de la caja CERRADA -> rechazado
  r := annul_comprobante_atomic(v_comp, 'void_same_session', 'void tardío', true, 'an8v-key');
  PERFORM pg_temp.assert((r->>'ok')::boolean IS NOT TRUE AND r->>'error' ILIKE '%no pertenece a la caja abierta%',
    'A8a void_same_session sobre venta de caja cerrada -> rechazado');

  -- refund: OK, egreso en caja 2
  r := annul_comprobante_atomic(v_comp, 'refund_current_session', 'devolución al día siguiente', true, 'an8-key');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'A8b refund de venta de caja cerrada -> ok');
  PERFORM pg_temp.assert((r->>'refund_caja_id')::uuid = v_caja2, 'A8c la devolución quedó en la caja ACTUAL');
  RESET ROLE;

  SELECT count(*) INTO v_caja1_rows_after FROM financial_movements
    WHERE caja_id = '00000000-0000-0000-0000-0000000a0ca1';
  PERFORM pg_temp.assert(v_caja1_rows_before = v_caja1_rows_after,
    'A8d la caja CERRADA no ganó ni perdió movimientos');
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM financial_movements
      WHERE comprobante_id = v_comp AND sign = -1 AND caja_id = v_caja2) = 1,
    'A8e el egreso de devolución vive en la caja nueva, vinculado al comprobante');
  PERFORM pg_temp.assert(
    (SELECT description FROM financial_movements
      WHERE comprobante_id = v_comp AND sign = -1) ILIKE '%reversa de mov%',
    'A8f la descripción referencia el movimiento original');
END $$;

-- L6f (pendiente de arriba): corrección manual sobre caja CERRADA -> rechazada
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a0a09';
  r := reverse_manual_cash_movement('00000000-0000-0000-0000-0000000a0f02'::uuid, 'tarde');
  PERFORM pg_temp.assert((r->>'ok')::boolean IS NOT TRUE AND r->>'error' ILIKE '%cerrada%',
    'L6f corrección de movimiento manual en caja CERRADA -> rechazada');
  RESET ROLE;
END $$;

-- ════════════════════════════════════════════════════════════
-- A9: comprobante con CAE → anulación comercial imposible (requiere NC)
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE v_comp uuid := '00000000-0000-0000-0000-0000000a0e01'; r jsonb;
BEGIN
  SET LOCAL session_replication_role = 'replica';
  INSERT INTO comprobantes(id, business_id, tipo, type, estado, status, estado_comercial, estado_fiscal,
    es_fiscal, cae, numero_fiscal, numero, number, total, total_ars, total_bruto, total_cobrado, saldo_pendiente, currency, exchange_rate, subtotal, fecha, date)
  VALUES (v_comp, '00000000-0000-0000-0000-0000000a0a01', 'factura_c', 'factura_c', 'emitido', 'issued', 'pagado', 'emitido',
    true, '75123456789012', '0001-00000099', '0001-00000099', '0001-00000099', 1000, 1000, 1000, 1000, 0, 'ARS', 1, 1000, now(), now());
  SET LOCAL session_replication_role = 'origin';

  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a0a09';
  r := annul_comprobante_atomic(v_comp, 'refund_current_session', 'anular fiscal', true, 'an9-key');
  PERFORM pg_temp.assert((r->>'ok')::boolean IS NOT TRUE AND (r->>'requiere_nota_credito')::boolean,
    'A9 comprobante con CAE -> rechazado con requiere_nota_credito=true');
  RESET ROLE;
END $$;

-- ════════════════════════════════════════════════════════════
-- D: DELETE GUARD — solo borradores inocuos
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_vacio uuid := '00000000-0000-0000-0000-0000000a0e11';
  v_constock uuid; v_checkout_draft uuid; r jsonb;
BEGIN
  -- D1: borrador vacío (sin efectos, sin checkout request) -> borrable
  SET LOCAL session_replication_role = 'replica';
  INSERT INTO comprobantes(id, business_id, tipo, type, estado, status, estado_comercial, estado_fiscal,
    es_fiscal, total, total_ars, total_bruto, total_cobrado, saldo_pendiente, currency, exchange_rate, subtotal, fecha, date)
  VALUES (v_vacio, '00000000-0000-0000-0000-0000000a0a01', 'factura_c', 'factura_c', 'borrador', 'draft', 'pendiente', 'pendiente_emision',
    true, 500, 500, 500, 0, 500, 'ARS', 1, 500, now(), now());
  SET LOCAL session_replication_role = 'origin';

  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a0a09';
  r := delete_comprobante_with_finance(v_vacio);
  PERFORM pg_temp.assert((r->>'success')::boolean, 'D1 borrador vacío -> eliminado (' || COALESCE(r->>'error','') || ')');

  -- D2: borrador fiscal creado por checkout (tiene stock procesado + pagos + request)
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a0a09';
  v_checkout_draft := pg_temp.venta('d2-key', 1, jsonb_build_array(pg_temp.pago('efectivo', 1000)), 0, NULL, true);
  r := delete_comprobante_with_finance(v_checkout_draft);
  PERFORM pg_temp.assert((r->>'success')::boolean IS NOT TRUE AND (r->>'blocked')::boolean,
    'D2a borrador con efectos -> bloqueado');
  PERFORM pg_temp.assert(r->>'error' ILIKE '%stock%' AND r->>'error' ILIKE '%pagos%',
    'D2b el mensaje enumera los motivos (stock, pagos, ...)');
  PERFORM pg_temp.assert(r->>'error' ILIKE '%anulaci%',
    'D2c el mensaje recomienda ANULAR en vez de borrar');
  RESET ROLE;

  PERFORM pg_temp.assert(
    EXISTS (SELECT 1 FROM comprobantes WHERE id = v_checkout_draft),
    'D2d el comprobante sigue existiendo');

  -- D3: comprobante EMITIDO -> bloqueado
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a0a09';
  SELECT c.id INTO v_constock FROM comprobantes c
    WHERE c.business_id = '00000000-0000-0000-0000-0000000a0a01' AND c.status = 'issued'
      AND c.estado <> 'anulado' LIMIT 1;
  r := delete_comprobante_with_finance(v_constock);
  PERFORM pg_temp.assert((r->>'success')::boolean IS NOT TRUE,
    'D3 comprobante emitido -> bloqueado');

  -- D4: comprobante con CAE -> arca_blocked
  r := delete_comprobante_with_finance('00000000-0000-0000-0000-0000000a0e01'::uuid);
  PERFORM pg_temp.assert((r->>'success')::boolean IS NOT TRUE AND (r->>'arca_blocked')::boolean,
    'D4 comprobante con CAE -> arca_blocked');
  RESET ROLE;
END $$;

-- ════════════════════════════════════════════════════════════
-- CONC: conciliaciones por origen sobre TODO lo generado en este suite
-- ════════════════════════════════════════════════════════════
-- CONC1: cada pago POS (no CC) tiene EXACTAMENTE un FM income vinculado
SELECT pg_temp.assert(
  NOT EXISTS (
    SELECT cp.id FROM comprobante_payments cp
    WHERE cp.business_id = '00000000-0000-0000-0000-0000000a0a01'
      AND cp.payment_method <> 'cuenta_corriente'
    GROUP BY cp.id
    HAVING (SELECT count(*) FROM financial_movements fm
            WHERE fm.source = 'comprobante' AND fm.source_id = cp.id AND fm.type = 'income') <> 1
  ),
  'CONC1 pagos POS = FM income relacionados (1:1 por identificador, sin faltantes ni duplicados)');

-- CONC2: espejo BFE por comprobante: count(BFE income +) = count(pagos no-CC)
SELECT pg_temp.assert(
  NOT EXISTS (
    SELECT c.id FROM comprobantes c
    WHERE c.business_id = '00000000-0000-0000-0000-0000000a0a01'
    GROUP BY c.id
    HAVING (SELECT count(*) FROM business_finance_entries b
            WHERE b.reference_comprobante_id = c.id AND b.type = 'income' AND b.amount_ars > 0)
        <> (SELECT count(*) FROM comprobante_payments cp
            WHERE cp.comprobante_id = c.id AND cp.payment_method <> 'cuenta_corriente')
  ),
  'CONC2 BFE income espejo = pagos POS por comprobante');

-- CONC3: todo comprobante ANULADO quedó neto en cero (caja, BFE income, COGS, CC)
SELECT pg_temp.assert(
  NOT EXISTS (
    SELECT c.id FROM comprobantes c
    WHERE c.business_id = '00000000-0000-0000-0000-0000000a0a01' AND c.estado = 'anulado'
    GROUP BY c.id
    HAVING
      abs((SELECT COALESCE(SUM(CASE WHEN COALESCE(fm.sign,1) = 1 AND fm.type='income' THEN fm.amount_ars
                                    WHEN fm.sign = -1 THEN -fm.amount_ars ELSE 0 END), 0)
           FROM financial_movements fm WHERE fm.comprobante_id = c.id)) > 0.01
      OR abs((SELECT COALESCE(SUM(b.amount_ars), 0) FROM business_finance_entries b
              WHERE b.reference_comprobante_id = c.id AND b.type = 'income')) > 0.01
      OR abs((SELECT COALESCE(SUM(b.amount_ars), 0) FROM business_finance_entries b
              WHERE b.reference_comprobante_id = c.id AND b.category = 'mercaderia')) > 0.01
      OR abs((SELECT COALESCE(SUM(am.debit - am.credit), 0) FROM account_movements am
              WHERE am.reference_type = 'comprobante' AND am.reference_id = c.id)) > 0.01
  ),
  'CONC3 anulados: caja + BFE income + COGS + CC = 0 por comprobante');

-- CONC4: una sola anulación por comprobante
SELECT pg_temp.assert(
  NOT EXISTS (SELECT comprobante_id FROM comprobante_annulments GROUP BY comprobante_id HAVING count(*) > 1),
  'CONC4 una única anulación por comprobante');

-- CONC5: caja por sesión (caja 1, ya CERRADA) — neteo por método con sign.
-- Efectivo: manual1 +5000, corrección manual1 −5000, manual2 +7000,
--           venta l0 +1000, venta a1 +2000, reversa a1 −2000, venta a8 +1000 = 9000
--           (la reversa de a8 fue a caja 2 — la sesión cerrada quedó intacta)
-- Transferencia: venta a5 +400, reversa a5 −400 = 0
SELECT pg_temp.assert(
  (SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount_ars ELSE -amount_ars END), 0)
     FROM financial_movements
     WHERE caja_id = '00000000-0000-0000-0000-0000000a0ca1'
       AND COALESCE(metodo_pago, 'efectivo') = 'efectivo') = 9000,
  'CONC5a caja 1 (cerrada) neto EFECTIVO = 9000, intacta tras las anulaciones');
SELECT pg_temp.assert(
  (SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount_ars ELSE -amount_ars END), 0)
     FROM financial_movements
     WHERE caja_id = '00000000-0000-0000-0000-0000000a0ca1'
       AND metodo_pago = 'transferencia') = 0,
  'CONC5b caja 1 neto TRANSFERENCIA = 0 (venta + reversa en la misma sesión)');

SELECT pg_temp.assert(true, '=== etapa0_annulment_ledger_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
