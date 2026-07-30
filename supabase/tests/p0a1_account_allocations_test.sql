-- ============================================================================
-- P0-A.1 (cont.) — Imputación explícita de cobros de cuenta corriente.
-- Cubre los casos 1-13 del contrato (los 14-16 son de UI).
-- READ-ONLY: todo dentro de BEGIN … ROLLBACK.
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set biz  '00000000-0000-0000-0000-0000000f0a01'
\set own  '00000000-0000-0000-0000-0000000f0a09'
\set biz2 '00000000-0000-0000-0000-0000000f0b01'
\set own2 '00000000-0000-0000-0000-0000000f0b09'
\set cust '00000000-0000-0000-0000-0000000f0ac1'
\set caja '00000000-0000-0000-0000-0000000f0a61'
\set ord1 '00000000-0000-0000-0000-0000000f0af1'
\set ord2 '00000000-0000-0000-0000-0000000f0af2'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'own'), (:'own2');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','ALLOC A',:'own'), (:'biz2','ALLOC B',:'own2');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES (:'biz',:'own','owner',true), (:'biz2',:'own2','owner',true);
INSERT INTO customers(id,business_id,name,phone,customer_type) VALUES (:'cust',:'biz','Cliente CC','+540009','minorista');
INSERT INTO cajas(id,business_id,opened_by,status) VALUES (:'caja',:'biz',:'own','abierta');
INSERT INTO orders(id,business_id,status,created_by) VALUES (:'ord1',:'biz','repair',:'own'), (:'ord2',:'biz','repair',:'own');
SET LOCAL session_replication_role='origin';

CREATE OR REPLACE FUNCTION pg_temp.payload(p_order uuid, p_total numeric, p_cc numeric, p_cash numeric)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'tipo','factura_c','punto_venta','0001','condicion_fiscal','Consumidor Final',
    'customer_id','00000000-0000-0000-0000-0000000f0ac1',
    'order_id', p_order, 'es_fiscal', false, 'cc_total', p_cc,
    'items', jsonb_build_array(jsonb_build_object(
      'descripcion','Servicio','tipo_linea','servicio','cantidad',1,
      'precio_unitario',p_total,'descuento_linea',0,'costo_unitario',0,
      'currency','ARS','exchange_rate',1,'inventory_id',NULL)),
    'pagos', CASE WHEN p_cash > 0 THEN jsonb_build_array(jsonb_build_object(
        'payment_method','efectivo','amount',p_cash,'currency','ARS','amount_ars',p_cash,'exchange_rate',1))
      ELSE '[]'::jsonb END) $$;
CREATE OR REPLACE FUNCTION pg_temp.st(p uuid) RETURNS v_order_financial_status
LANGUAGE sql AS $$ SELECT * FROM v_order_financial_status WHERE order_id = p $$;

-- Orden 1: total 100.000 — 40.000 efectivo + 60.000 a cuenta corriente.
-- Orden 2: total 50.000 — 100 % a cuenta corriente.
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f0a09';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000f0a01'::uuid,'K1','h1',
        pg_temp.payload('00000000-0000-0000-0000-0000000f0af1'::uuid, 100000, 60000, 40000));
  PERFORM pg_temp.assert(r->>'status'='created', 'S1 checkout mixto ('||COALESCE(r->>'error','')||')');
  PERFORM set_config('t.c1', r->>'comprobante_id', true);
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000f0a01'::uuid,'K2','h2',
        pg_temp.payload('00000000-0000-0000-0000-0000000f0af2'::uuid, 50000, 50000, 0));
  PERFORM pg_temp.assert(r->>'status'='created', 'S2 checkout CC ('||COALESCE(r->>'error','')||')');
  PERFORM set_config('t.c2', r->>'comprobante_id', true);
  RESET ROLE;
  PERFORM set_config('t.acc', (SELECT id::text FROM accounts
    WHERE business_id='00000000-0000-0000-0000-0000000f0a01' AND entity_id='00000000-0000-0000-0000-0000000f0ac1' LIMIT 1), true);
END $$;

-- Ejemplo 1 del contrato: 100.000 con 40.000 efectivo y 60.000 CC.
SELECT pg_temp.assert((pg_temp.st(:'ord1')).payment_status='partial', 'E1a orden 1 -> partial');
SELECT pg_temp.assert((pg_temp.st(:'ord1')).saldo_pendiente=60000.00, 'E1b saldo del documento 60.000');
SELECT pg_temp.assert((SELECT status FROM orders WHERE id=:'ord1')='completed', 'E1c orden 1 completed');
SELECT pg_temp.assert((pg_temp.st(:'ord2')).payment_status='pending', 'E1d orden 2 (100 % CC) -> pending');

-- ============ Caso 2 y 3: pago GENÉRICO, sin imputar =======================
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f0a09';
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-0000000f0a01'::uuid,
        current_setting('t.acc')::uuid, 60000, 'Pago a cuenta',
        '00000000-0000-0000-0000-0000000f0a09'::uuid, 'efectivo', public.ar_today(),
        '00000000-0000-0000-0000-0000000f0a61'::uuid, 'PAY-GEN-1');
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'C2a cobro genérico ok ('||COALESCE(r->>'error','')||')');
  PERFORM set_config('t.pay', r->>'account_movement_id', true);
END $$;
SELECT pg_temp.assert((pg_temp.st(:'ord1')).payment_status='partial',
  'C3a un pago NO imputado no cambia el estado de ninguna orden');
SELECT pg_temp.assert((pg_temp.st(:'ord1')).saldo_pendiente=60000.00, 'C3b el saldo del documento sigue 60.000');
SELECT pg_temp.assert((SELECT unallocated_amount FROM v_customer_unallocated_credit
   WHERE payment_movement_id=current_setting('t.pay')::uuid)=60000.00,
  'C2b el cobro queda 100 % como crédito NO imputado');

-- ============ Caso 12 y 13: sobreasignación y sobrepago ====================
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f0a09';
  -- Excede el importe del pago (60.000).
  r := allocate_account_payment_atomic('00000000-0000-0000-0000-0000000f0a01'::uuid,
        current_setting('t.pay')::uuid,
        jsonb_build_array(jsonb_build_object('comprobante_id', current_setting('t.c1'), 'amount', 90000)),
        'test', 'ALLOC-OVER-1');
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE AND r->>'error' LIKE '%EXCEEDS_PAYMENT%',
    'C12 no se puede imputar más que el importe del pago');
  -- Excede el saldo del documento 2 (50.000) usando el pago de 60.000.
  r := allocate_account_payment_atomic('00000000-0000-0000-0000-0000000f0a01'::uuid,
        current_setting('t.pay')::uuid,
        jsonb_build_array(jsonb_build_object('comprobante_id', current_setting('t.c2'), 'amount', 55000)),
        'test', 'ALLOC-OVER-2');
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE AND r->>'error' LIKE '%EXCEEDS_BALANCE%',
    'C13 no se puede imputar más que el saldo del documento');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT count(*) FROM customer_account_payment_allocations)=0,
  'C12b ningún rechazo dejó asignaciones a medias');

-- ============ Caso 5 y 6: imputación parcial y repartida ===================
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f0a09';
  -- Un mismo pago repartido entre DOS comprobantes: 20.000 y 30.000 (quedan 10.000 libres).
  r := allocate_account_payment_atomic('00000000-0000-0000-0000-0000000f0a01'::uuid,
        current_setting('t.pay')::uuid,
        jsonb_build_array(
          jsonb_build_object('comprobante_id', current_setting('t.c1'), 'amount', 20000),
          jsonb_build_object('comprobante_id', current_setting('t.c2'), 'amount', 30000)),
        'reparto', 'ALLOC-SPLIT');
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'C6a imputación repartida ok ('||COALESCE(r->>'error','')||')');
  PERFORM pg_temp.assert(jsonb_array_length(r->'allocation_ids')=2, 'C6b dos asignaciones');
END $$;
SELECT pg_temp.assert((pg_temp.st(:'ord1')).payment_status='partial', 'C5a orden 1 sigue partial');
SELECT pg_temp.assert((pg_temp.st(:'ord1')).saldo_pendiente=40000.00, 'C5b saldo 1 baja a 40.000');
SELECT pg_temp.assert((pg_temp.st(:'ord1')).imputado_cc=20000.00,     'C5c imputado 20.000');
SELECT pg_temp.assert((pg_temp.st(:'ord2')).payment_status='partial', 'C6c orden 2 pasa a partial');
SELECT pg_temp.assert((pg_temp.st(:'ord2')).saldo_pendiente=20000.00, 'C6d saldo 2 baja a 20.000');
SELECT pg_temp.assert((SELECT unallocated_amount FROM v_customer_unallocated_credit
   WHERE payment_movement_id=current_setting('t.pay')::uuid)=10000.00,
  'C7 el excedente queda como crédito no imputado (10.000)');

-- ============ Caso 10: idempotencia =======================================
DO $$
DECLARE r jsonb; v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM customer_account_payment_allocations WHERE status='active';
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f0a09';
  r := allocate_account_payment_atomic('00000000-0000-0000-0000-0000000f0a01'::uuid,
        current_setting('t.pay')::uuid,
        jsonb_build_array(jsonb_build_object('comprobante_id', current_setting('t.c1'), 'amount', 20000)),
        'reparto', 'ALLOC-SPLIT');
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean, 'C10a misma key -> replay');
  PERFORM pg_temp.assert((SELECT count(*) FROM customer_account_payment_allocations WHERE status='active')=v_n,
    'C10b el replay NO creó asignaciones nuevas');
END $$;

-- ============ Caso 4: imputación que completa la orden ====================
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f0a09';
  -- Cobro NUEVO de 40.000 imputado directamente al comprobante 1 (contrato A).
  r := pay_comprobante_from_account_atomic('00000000-0000-0000-0000-0000000f0a01'::uuid,
        current_setting('t.acc')::uuid, current_setting('t.c1')::uuid, 40000,
        'Cobro del saldo', 'efectivo', public.ar_today(),
        '00000000-0000-0000-0000-0000000f0a61'::uuid,
        '00000000-0000-0000-0000-0000000f0a09'::uuid, 'PAY-DOC-1');
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'C1a cobro desde el documento ok ('||COALESCE(r->>'error','')||')');
  PERFORM pg_temp.assert((r->>'allocated_amount')::numeric=40000, 'C1b se imputó automáticamente al comprobante');
  PERFORM pg_temp.assert((r->>'unallocated_amount')::numeric=0,   'C1c sin excedente');
END $$;
SELECT pg_temp.assert((pg_temp.st(:'ord1')).payment_status='paid', 'C4a orden 1 -> PAID');
SELECT pg_temp.assert((pg_temp.st(:'ord1')).saldo_pendiente=0.00,  'C4b saldo 0');
SELECT pg_temp.assert((SELECT paid_at IS NOT NULL FROM orders WHERE id=:'ord1'), 'C4c paid_at completado');
SELECT pg_temp.assert((SELECT status FROM orders WHERE id=:'ord1')='completed', 'C4d estado técnico intacto');

-- Contrato A sobre el documento 2. La deuda VIVA de la cuenta es 10.000
-- (110.000 facturados a CC − 100.000 ya cobrados): record_customer_account_payment_atomic
-- rechaza cobrar más que la deuda, así que el tope real lo pone la cuenta, no el documento.
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f0a09';
  r := pay_comprobante_from_account_atomic('00000000-0000-0000-0000-0000000f0a01'::uuid,
        current_setting('t.acc')::uuid, current_setting('t.c2')::uuid, 10000,
        'Cobro imputado al documento 2', 'efectivo', public.ar_today(),
        '00000000-0000-0000-0000-0000000f0a61'::uuid,
        '00000000-0000-0000-0000-0000000f0a09'::uuid, 'PAY-DOC-2');
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'C7b cobro imputado al documento ok ('||COALESCE(r->>'error','')||')');
  PERFORM pg_temp.assert((r->>'allocated_amount')::numeric=10000,   'C7c se imputan los 10.000 al documento 2');
  PERFORM pg_temp.assert((r->>'unallocated_amount')::numeric=0,     'C7d sin excedente en este cobro');
END $$;
SELECT pg_temp.assert((pg_temp.st(:'ord2')).payment_status='partial', 'C7e orden 2 sigue partial');
SELECT pg_temp.assert((pg_temp.st(:'ord2')).saldo_pendiente=10000.00, 'C7f saldo 2 baja a 10.000');

-- ============ Caso 8: reversa de imputación (parcial) =====================
DO $$
DECLARE r jsonb; v_al uuid;
BEGIN
  SELECT id INTO v_al FROM customer_account_payment_allocations
   WHERE comprobante_id=current_setting('t.c1')::uuid AND status='active' AND amount=40000 LIMIT 1;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f0a09';
  r := reverse_payment_allocation_atomic('00000000-0000-0000-0000-0000000f0a01'::uuid, v_al, 10000,
        'reversa parcial de prueba', 'REV-1');
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'C8a reversa ok ('||COALESCE(r->>'error','')||')');
  PERFORM pg_temp.assert((r->>'reversed_amount')::numeric=10000, 'C8b se revirtieron 10.000');
  PERFORM pg_temp.assert((r->>'remaining_amount')::numeric=30000, 'C8c queda un remanente de 30.000');
END $$;
SELECT pg_temp.assert((pg_temp.st(:'ord1')).payment_status='partial', 'C8d la orden vuelve a partial');
SELECT pg_temp.assert((pg_temp.st(:'ord1')).saldo_pendiente=10000.00, 'C8e saldo 10.000');
SELECT pg_temp.assert((SELECT paid_at IS NULL FROM orders WHERE id=:'ord1'), 'C8f paid_at se limpió');
SELECT pg_temp.assert((SELECT count(*) FROM customer_account_payment_allocations WHERE status='reversed')>=1,
  'C8g la asignación revertida queda registrada (append-only, sin DELETE)');

-- No hay DELETE financiero posible.
DO $$
DECLARE v_err text := '';
BEGIN
  BEGIN
    DELETE FROM customer_account_payment_allocations WHERE status='reversed';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.assert(v_err LIKE '%append-only%', 'C8h DELETE sobre asignaciones está prohibido');
END $$;

-- ============ Caso 9: aislamiento multi-tenant ============================
DO $$
DECLARE r jsonb; v_n int;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f0b09';  -- owner B
  r := allocate_account_payment_atomic('00000000-0000-0000-0000-0000000f0a01'::uuid,
        current_setting('t.pay')::uuid,
        jsonb_build_array(jsonb_build_object('comprobante_id', current_setting('t.c1'), 'amount', 1000)),
        'ataque', 'ALLOC-XT');
  PERFORM pg_temp.assert(r->>'error_code'='FORBIDDEN', 'C9a otro negocio no puede imputar');
  SELECT count(*) INTO v_n FROM customer_account_payment_allocations;
  RESET ROLE;
  PERFORM pg_temp.assert(v_n = 0, 'C9b otro negocio no ve las asignaciones (RLS)');
END $$;

-- El comprobante anulado no admite imputación.
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f0a09';
  -- El comprobante 2 no tiene comprobante_payments (fue 100 % cuenta corriente),
  -- así que corresponde la anulación COMERCIAL, no la devolución de dinero.
  r := annul_comprobante_atomic(current_setting('t.c2')::uuid,'commercial_annulment','test',false,'ANN-C2');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'C11a anulación ok ('||COALESCE(r->>'error','')||')');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((pg_temp.st(:'ord2')).payment_status='sin_facturar',
  'C11b orden con comprobante anulado NO queda cobrada');

ROLLBACK;
