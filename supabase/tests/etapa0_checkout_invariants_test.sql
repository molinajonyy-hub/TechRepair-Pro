-- ============================================================
-- Test suite Etapa 0 — Invariantes del checkout
-- (supabase/migrations/20260702110000_checkout_invariants.sql)
--
-- HOW TO RUN (local stack, NUNCA prod):
--   supabase db reset
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f /dev/stdin < supabase/tests/etapa0_checkout_invariants_test.sql
--
-- Invariante: pagos de caja + cuenta corriente = total (tolerancia ±$1).
-- La concurrencia real entre DOS conexiones vive en
-- supabase/tests/run-checkout-idempotency-concurrency-test.ps1 (sin cambios:
-- el mecanismo de exclusión — UNIQUE(business_id, idempotency_key) — no se
-- tocó en esta etapa).
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

\set biz    '00000000-0000-0000-0000-0000000c0a01'
\set owner  '00000000-0000-0000-0000-0000000c0a09'
\set cust   '00000000-0000-0000-0000-0000000c0c01'
\set prod   '00000000-0000-0000-0000-0000000c0d01'

SET LOCAL session_replication_role = 'replica';
INSERT INTO auth.users(id) VALUES (:'owner');
INSERT INTO businesses(id, name, owner_user_id) VALUES (:'biz', 'Etapa0 Checkout', :'owner');
INSERT INTO profiles(business_id, user_id, role, is_active) VALUES (:'biz', :'owner', 'owner', true);
INSERT INTO customers(id, business_id, name, phone) VALUES (:'cust', :'biz', 'Cliente CC', '+540000000000');
INSERT INTO inventory(id, business_id, name, code, category, stock_quantity, stock, cost_price, sale_price, base_currency, is_active)
  VALUES (:'prod', :'biz', 'Producto Invariante', 'ETAPA0-CHK-001', 'Repuestos', 10, 10, 600, 1000, 'ARS', true);
INSERT INTO cajas (business_id, status, efectivo_inicial, transferencia_inicial, tarjeta_inicial, usd_inicial, usd_cotizacion_apertura)
  VALUES (:'biz', 'abierta', 0, 0, 0, 0, 1);
SET LOCAL session_replication_role = 'origin';

-- Helper de payload: 1 producto (qty x $1000, costo 600) + pagos parametrizables
CREATE OR REPLACE FUNCTION pg_temp.payload(p_qty numeric, p_pagos jsonb, p_cc numeric, p_customer text DEFAULT NULL, p_tipo text DEFAULT 'factura_c')
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'tipo', p_tipo, 'punto_venta', '0001', 'condicion_fiscal', 'Consumidor Final',
    'customer_id', p_customer, 'es_fiscal', false, 'emitir_en_arca', false,
    'skip_finance_entry', false, 'exchange_rate', 1, 'cc_total', p_cc,
    'total_comisiones', 0,
    'items', jsonb_build_array(jsonb_build_object(
      'descripcion', 'Producto Invariante', 'tipo_linea', 'producto',
      'cantidad', p_qty, 'precio_unitario', 1000, 'descuento_linea', 0,
      'costo_unitario', 600, 'currency', 'ARS', 'exchange_rate', 1,
      'inventory_id', '00000000-0000-0000-0000-0000000c0d01')),
    'pagos', p_pagos)
$$;

CREATE OR REPLACE FUNCTION pg_temp.pago(p_metodo text, p_monto numeric)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('payment_method', p_metodo, 'amount', p_monto,
    'currency', 'ARS', 'amount_ars', p_monto, 'exchange_rate', 1,
    'commission_rate', 0, 'commission_amount', 0, 'net_amount', p_monto)
$$;

-- ════════════════════════════════════════════════════════════
-- CH1: cobro completo → created; pagos/FM/BFE con fecha AR; COGS trazable
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_comp uuid;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c0a09';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000c0a01'::uuid,
    'ch1-key', 'ch1-hash',
    pg_temp.payload(2, jsonb_build_array(pg_temp.pago('efectivo', 2000)), 0));
  PERFORM pg_temp.assert(r->>'status' = 'created', 'CH1a cobro completo -> created (' || COALESCE(r->>'error','') || ')');
  v_comp := (r->>'comprobante_id')::uuid;
  RESET ROLE;

  PERFORM pg_temp.assert(
    (SELECT count(*) FROM comprobante_payments WHERE comprobante_id = v_comp) = 1,
    'CH1b un pago registrado');
  PERFORM pg_temp.assert(
    (SELECT date FROM comprobante_payments WHERE comprobante_id = v_comp) = public.ar_today(),
    'CH1c fecha del pago = día argentino');
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM financial_movements WHERE comprobante_id = v_comp AND type = 'income') = 1,
    'CH1d el trigger creó UN movimiento de caja');
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM business_finance_entries
      WHERE reference_comprobante_id = v_comp AND type = 'variable_cost'
        AND category = 'mercaderia' AND source = 'comprobante' AND amount_ars = 1200) = 1,
    'CH1e COGS (2 x 600) trazable: source=comprobante + reference_comprobante_id');
  PERFORM pg_temp.assert(
    (SELECT estado_comercial FROM comprobantes WHERE id = v_comp) = 'pagado',
    'CH1f estado_comercial = pagado');
  PERFORM pg_temp.assert(
    (SELECT stock_quantity FROM inventory WHERE id = '00000000-0000-0000-0000-0000000c0d01') = 8,
    'CH1g stock descontado 10 -> 8');
END $$;

-- ════════════════════════════════════════════════════════════
-- CH2: reintento idempotente / conflicto de payload
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r1 jsonb; r2 jsonb; r3 jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c0a09';
  r1 := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000c0a01'::uuid,
    'ch1-key', 'ch1-hash',
    pg_temp.payload(2, jsonb_build_array(pg_temp.pago('efectivo', 2000)), 0));
  PERFORM pg_temp.assert(r1->>'status' = 'existing', 'CH2a misma key + mismo hash -> existing (replay)');
  r2 := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000c0a01'::uuid,
    'ch1-key', 'OTRO-hash',
    pg_temp.payload(1, jsonb_build_array(pg_temp.pago('efectivo', 1000)), 0));
  PERFORM pg_temp.assert(r2->>'status' = 'idempotency_conflict', 'CH2b misma key + payload distinto -> idempotency_conflict');
  RESET ROLE;
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM comprobantes WHERE business_id = '00000000-0000-0000-0000-0000000c0a01') = 1,
    'CH2c sigue habiendo UN solo comprobante');
  PERFORM pg_temp.assert(
    (SELECT stock_quantity FROM inventory WHERE id = '00000000-0000-0000-0000-0000000c0d01') = 8,
    'CH2d el replay NO volvió a descontar stock');
END $$;

-- ════════════════════════════════════════════════════════════
-- CH3: total positivo SIN pagos y SIN CC → rechazado con importes
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c0a09';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000c0a01'::uuid,
    'ch3-key', 'ch3-hash', pg_temp.payload(1, '[]'::jsonb, 0));
  PERFORM pg_temp.assert(r->>'status' = 'failed_retryable' AND r->>'error' ILIKE '%no cubre el total%',
    'CH3a venta sin pago ni CC -> rechazada con error funcional');
  PERFORM pg_temp.assert(r->>'error' LIKE '%total=%' AND r->>'error' LIKE '%diferencia=%',
    'CH3b el error incluye total/pagos/cc/diferencia');
  RESET ROLE;
  PERFORM pg_temp.assert(
    (SELECT stock_quantity FROM inventory WHERE id = '00000000-0000-0000-0000-0000000c0d01') = 8,
    'CH3c rollback total: el stock NO se descontó');
  PERFORM pg_temp.assert(
    NOT EXISTS (SELECT 1 FROM business_finance_entries b JOIN comprobantes c ON c.id = b.reference_comprobante_id
      WHERE c.business_id = '00000000-0000-0000-0000-0000000c0a01' AND b.type = 'income'
        AND c.estado_comercial = 'pendiente'),
    'CH3d NO existe ingreso fantasma por venta sin cobro (rama P0-3 eliminada)');
END $$;

-- ════════════════════════════════════════════════════════════
-- CH4: parcial + CC / CC total / CC sin cliente
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_comp uuid;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c0a09';

  -- parcial: pago 400 + CC 600 = total 1000
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000c0a01'::uuid,
    'ch4a-key', 'ch4a-hash',
    pg_temp.payload(1, jsonb_build_array(pg_temp.pago('efectivo', 400)), 600, '00000000-0000-0000-0000-0000000c0c01'));
  PERFORM pg_temp.assert(r->>'status' = 'created', 'CH4a parcial + CC que cubre el total -> created (' || COALESCE(r->>'error','') || ')');
  v_comp := (r->>'comprobante_id')::uuid;

  -- CC total: 1000 en CC, sin pagos
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000c0a01'::uuid,
    'ch4b-key', 'ch4b-hash',
    pg_temp.payload(1, '[]'::jsonb, 1000, '00000000-0000-0000-0000-0000000c0c01'));
  PERFORM pg_temp.assert(r->>'status' = 'created', 'CH4b venta 100% en CC -> created');

  -- CC sin cliente: rechazado
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000c0a01'::uuid,
    'ch4c-key', 'ch4c-hash', pg_temp.payload(1, '[]'::jsonb, 1000, NULL));
  PERFORM pg_temp.assert(r->>'status' = 'failed_retryable' AND r->>'error' ILIKE '%cliente%',
    'CH4c CC sin customer_id -> rechazado explícito');
  RESET ROLE;

  PERFORM pg_temp.assert(
    (SELECT count(*) FROM account_movements am JOIN accounts a ON a.id = am.account_id
      WHERE a.business_id = '00000000-0000-0000-0000-0000000c0a01' AND am.debit = 600
        AND am.reference_id = v_comp) = 1,
    'CH4d la deuda CC del parcial quedó en el ledger (débito 600)');
  PERFORM pg_temp.assert(
    (SELECT balance FROM accounts
      WHERE business_id = '00000000-0000-0000-0000-0000000c0a01'
        AND entity_id = '00000000-0000-0000-0000-0000000c0c01') = 1600,
    'CH4e accounts.balance acumula 600 + 1000 (trigger de balance)');
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM financial_movements fm JOIN comprobantes c ON c.id = fm.comprobante_id
      WHERE c.business_id = '00000000-0000-0000-0000-0000000c0a01' AND fm.type = 'income') = 2,
    'CH4f la caja SOLO tiene los ingresos reales (2000 de CH1 + 400 del parcial), nada por CC');
END $$;

-- ════════════════════════════════════════════════════════════
-- CH5: mixto (varios métodos) / sobrepago / operación $0
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_comp uuid;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c0a09';

  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000c0a01'::uuid,
    'ch5a-key', 'ch5a-hash',
    pg_temp.payload(1, jsonb_build_array(pg_temp.pago('efectivo', 300), pg_temp.pago('transferencia', 700)), 0));
  PERFORM pg_temp.assert(r->>'status' = 'created', 'CH5a pago mixto que cubre el total -> created');
  v_comp := (r->>'comprobante_id')::uuid;

  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000c0a01'::uuid,
    'ch5b-key', 'ch5b-hash',
    pg_temp.payload(1, jsonb_build_array(pg_temp.pago('efectivo', 1500)), 0));
  PERFORM pg_temp.assert(r->>'status' = 'failed_retryable' AND r->>'error' ILIKE '%exceden%',
    'CH5b pagos que exceden el total -> rechazado');

  -- Operación $0: servicio sin cargo, sin pagos → permitida, sin efectos financieros
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000c0a01'::uuid,
    'ch5c-key', 'ch5c-hash',
    jsonb_build_object('tipo', 'factura_c', 'punto_venta', '0001',
      'condicion_fiscal', 'Consumidor Final', 'customer_id', NULL, 'es_fiscal', false,
      'emitir_en_arca', false, 'skip_finance_entry', false, 'exchange_rate', 1,
      'cc_total', 0, 'total_comisiones', 0,
      'items', jsonb_build_array(jsonb_build_object(
        'descripcion', 'Chequeo sin cargo', 'tipo_linea', 'servicio', 'cantidad', 1,
        'precio_unitario', 0, 'descuento_linea', 0, 'costo_unitario', 0,
        'currency', 'ARS', 'exchange_rate', 1)),
      'pagos', '[]'::jsonb));
  PERFORM pg_temp.assert(r->>'status' = 'created', 'CH5c operación $0 -> permitida');
  RESET ROLE;

  PERFORM pg_temp.assert(
    (SELECT count(*) FROM comprobante_payments WHERE comprobante_id = v_comp) = 2,
    'CH5d el mixto registró DOS pagos');
  PERFORM pg_temp.assert(
    NOT EXISTS (
      SELECT 1 FROM comprobante_payments cp JOIN comprobantes c ON c.id = cp.comprobante_id
      WHERE c.business_id = '00000000-0000-0000-0000-0000000c0a01' AND cp.amount_ars <= 0),
    'CH5e no existe ningún pago de $0 en todo el negocio');
END $$;

SELECT pg_temp.assert(
  NOT EXISTS (
    SELECT 1 FROM financial_movements fm
    WHERE fm.business_id = '00000000-0000-0000-0000-0000000c0a01' AND fm.amount_ars = 0),
  'CH5f no existe ningún FM de $0');

-- ════════════════════════════════════════════════════════════
-- CH6: nota de crédito por checkout — exenta del invariante, sin efectos
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_nc uuid;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c0a09';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000c0a01'::uuid,
    'ch6a-key', 'ch6a-hash',
    pg_temp.payload(1, '[]'::jsonb, 0, NULL, 'nota_credito'));
  PERFORM pg_temp.assert(r->>'status' = 'created', 'CH6a NC sin pagos -> permitida (documento de reversión)');
  v_nc := (r->>'comprobante_id')::uuid;

  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000c0a01'::uuid,
    'ch6b-key', 'ch6b-hash',
    pg_temp.payload(1, jsonb_build_array(pg_temp.pago('efectivo', 1000)), 0, NULL, 'nota_credito'));
  PERFORM pg_temp.assert(r->>'status' = 'failed_retryable' AND r->>'error' ILIKE '%nota de credito%',
    'CH6b NC con pagos -> rechazada');
  RESET ROLE;

  PERFORM pg_temp.assert(
    NOT EXISTS (SELECT 1 FROM business_finance_entries WHERE reference_comprobante_id = v_nc),
    'CH6c la NC no generó BFE (ni income ni COGS)');
  PERFORM pg_temp.assert(
    NOT EXISTS (SELECT 1 FROM inventory_movements WHERE reference_id = v_nc),
    'CH6d la NC no tocó stock');
END $$;

SELECT pg_temp.assert(true, '=== etapa0_checkout_invariants_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
