-- ============================================================================
-- P0-A.1U2 — Contrato server-side que consume la UI de imputación.
-- Sólo los casos nuevos: no se duplica la suite de concurrencia ya validada.
-- READ-ONLY: BEGIN … ROLLBACK.
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set biz  '00000000-0000-0000-0000-0000000b0a01'
\set own  '00000000-0000-0000-0000-0000000b0a09'
\set cash '00000000-0000-0000-0000-0000000b0a02'
\set tech '00000000-0000-0000-0000-0000000b0a03'
\set cust '00000000-0000-0000-0000-0000000b0ac1'
\set caja '00000000-0000-0000-0000-0000000b0a61'
\set ord  '00000000-0000-0000-0000-0000000b0af1'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'own'), (:'cash'), (:'tech');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','U2',:'own');
INSERT INTO profiles(id,business_id,user_id,role,is_active) VALUES
  (:'own',:'biz',:'own','owner',true), (:'cash',:'biz',:'cash','cashier',true), (:'tech',:'biz',:'tech','tech',true);
INSERT INTO customers(id,business_id,name,phone,customer_type) VALUES (:'cust',:'biz','Cli','+5400','minorista');
INSERT INTO cajas(id,business_id,opened_by,status) VALUES (:'caja',:'biz',:'own','abierta');
INSERT INTO orders(id,business_id,customer_id,status,created_by) VALUES (:'ord',:'biz',:'cust','repair',:'own');
SET LOCAL session_replication_role='origin';

-- Venta 100.000: 40.000 efectivo + 60.000 a cuenta corriente -> partial.
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000b0a09';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000b0a01'::uuid,'U2-1','h1',
    jsonb_build_object('tipo','factura_c','punto_venta','0001','condicion_fiscal','Consumidor Final',
      'customer_id','00000000-0000-0000-0000-0000000b0ac1','order_id','00000000-0000-0000-0000-0000000b0af1',
      'es_fiscal',false,'cc_total',60000,
      'items',jsonb_build_array(jsonb_build_object('descripcion','Serv','tipo_linea','servicio','cantidad',1,
        'precio_unitario',100000,'descuento_linea',0,'costo_unitario',0,'currency','ARS','exchange_rate',1,'inventory_id',NULL)),
      'pagos',jsonb_build_array(jsonb_build_object('payment_method','efectivo','amount',40000,'currency','ARS','amount_ars',40000,'exchange_rate',1))));
  PERFORM pg_temp.assert(r->>'status'='created', 'S1 checkout ('||COALESCE(r->>'error','')||')');
  PERFORM set_config('t.comp', r->>'comprobante_id', true);
  RESET ROLE;
  PERFORM set_config('t.acc', (SELECT id::text FROM accounts
    WHERE business_id='00000000-0000-0000-0000-0000000b0a01' LIMIT 1), true);
END $$;

-- Cobro genérico de 60.000 (crédito sin imputar).
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000b0a09';
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-0000000b0a01'::uuid,
        current_setting('t.acc')::uuid, 60000, 'Pago a cuenta',
        '00000000-0000-0000-0000-0000000b0a09'::uuid, 'efectivo', public.ar_today(),
        '00000000-0000-0000-0000-0000000b0a61'::uuid, 'U2-PAY');
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'S2 cobro genérico ('||COALESCE(r->>'error','')||')');
  PERFORM set_config('t.pay', r->>'account_movement_id', true);
END $$;

-- ============ A. Workspace del modal ======================================
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000b0a09';
  r := get_allocation_workspace('00000000-0000-0000-0000-0000000b0a01'::uuid,'00000000-0000-0000-0000-0000000b0ac1'::uuid);
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'authorized')::boolean, 'A1 owner autorizado');
  PERFORM pg_temp.assert((r->>'can_allocate')::boolean, 'A2 owner puede imputar');
  PERFORM pg_temp.assert((r->>'can_reverse')::boolean,  'A3 owner puede revertir');
  PERFORM pg_temp.assert(jsonb_array_length(r->'credits') = 1, 'A4 un cobro con crédito disponible');
  PERFORM pg_temp.assert((r->'credits'->0->>'unallocated_amount')::numeric = 60000, 'A5 crédito 60.000');
  PERFORM pg_temp.assert(jsonb_array_length(r->'documents') = 1, 'A6 un documento abierto');
  PERFORM pg_temp.assert((r->'documents'->0->>'saldo_imputable')::numeric = 60000, 'A7 saldo imputable 60.000');
END $$;

-- ============ B. Permisos por rol =========================================
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000b0a02';  -- cashier
  r := get_allocation_workspace('00000000-0000-0000-0000-0000000b0a01'::uuid,'00000000-0000-0000-0000-0000000b0ac1'::uuid);
  PERFORM pg_temp.assert((r->>'can_allocate')::boolean IS TRUE,  'B1 cashier PUEDE imputar');
  PERFORM pg_temp.assert((r->>'can_reverse')::boolean IS FALSE,  'B2 cashier NO puede revertir');
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000b0a03';  -- tech
  r := get_allocation_workspace('00000000-0000-0000-0000-0000000b0a01'::uuid,'00000000-0000-0000-0000-0000000b0ac1'::uuid);
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'authorized')::boolean IS FALSE, 'B3 tech no ve el workspace');
  PERFORM pg_temp.assert((r ? 'credits') IS FALSE, 'B4 a tech no le llega ningún importe');
END $$;

-- El agujero que se cierra: tech NO puede imputar aunque llame la RPC directo.
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000b0a03';
  r := allocate_account_payment_atomic('00000000-0000-0000-0000-0000000b0a01'::uuid,
        current_setting('t.pay')::uuid,
        jsonb_build_array(jsonb_build_object('comprobante_id', current_setting('t.comp'), 'amount', 1000)),
        'ataque', 'U2-TECH');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'error_code' = 'FORBIDDEN', 'B5 tech NO puede imputar por RPC directa');
  PERFORM pg_temp.assert((SELECT count(*) FROM customer_account_payment_allocations)=0, 'B6 no dejó asignación');
END $$;

-- ============ C. Readback de imputación (lo que la UI muestra) ============
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000b0a02';  -- cashier
  r := allocate_account_payment_atomic('00000000-0000-0000-0000-0000000b0a01'::uuid,
        current_setting('t.pay')::uuid,
        jsonb_build_array(jsonb_build_object('comprobante_id', current_setting('t.comp'), 'amount', 60000)),
        'desde la UI', 'U2-ALLOC');
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'C1 cashier imputa ('||COALESCE(r->>'error','')||')');
END $$;
SELECT pg_temp.assert((SELECT payment_status FROM v_order_payment_state WHERE order_id=:'ord')='paid',
  'C2 readback: la orden pasa a COBRADO');
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000b0a09';
  r := get_order_financial_amounts('00000000-0000-0000-0000-0000000b0a01'::uuid,
        ARRAY['00000000-0000-0000-0000-0000000b0af1']::uuid[]);
  PERFORM pg_temp.assert((r->'rows'->0->>'saldo_pendiente')::numeric = 0, 'C3 readback: saldo 0');
  r := get_allocation_workspace('00000000-0000-0000-0000-0000000b0a01'::uuid,'00000000-0000-0000-0000-0000000b0ac1'::uuid);
  RESET ROLE;
  PERFORM pg_temp.assert(jsonb_array_length(r->'credits') = 0, 'C4 ya no queda crédito sin imputar');
  PERFORM pg_temp.assert(jsonb_array_length(r->'documents') = 0, 'C5 ya no hay documentos con saldo');
END $$;

-- ============ D. Idempotency replay (doble submit de la UI) ===============
DO $$
DECLARE r jsonb; n int;
BEGIN
  SELECT count(*) INTO n FROM customer_account_payment_allocations WHERE status='active';
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000b0a02';
  r := allocate_account_payment_atomic('00000000-0000-0000-0000-0000000b0a01'::uuid,
        current_setting('t.pay')::uuid,
        jsonb_build_array(jsonb_build_object('comprobante_id', current_setting('t.comp'), 'amount', 60000)),
        'desde la UI', 'U2-ALLOC');
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'replay')::boolean, 'D1 misma key -> replay');
  PERFORM pg_temp.assert((SELECT count(*) FROM customer_account_payment_allocations WHERE status='active')=n,
    'D2 el replay no creó asignaciones nuevas');
END $$;

-- ============ E. Historial que consume la UI ==============================
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000b0a09';
  r := get_payment_allocations('00000000-0000-0000-0000-0000000b0a01'::uuid, current_setting('t.comp')::uuid, NULL);
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'authorized')::boolean, 'E1 historial autorizado');
  PERFORM pg_temp.assert(jsonb_array_length(r->'rows') = 1, 'E2 una imputación en el historial');
  PERFORM pg_temp.assert(r->'rows'->0->>'status' = 'active', 'E3 activa');
  PERFORM pg_temp.assert((r->'rows'->0->>'order_id') = '00000000-0000-0000-0000-0000000b0af1', 'E4 trae la orden vinculada');
  PERFORM pg_temp.assert((r->'rows'->0 ? 'operador'), 'E5 informa el operador');
END $$;
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000b0a03';  -- tech
  r := get_payment_allocations('00000000-0000-0000-0000-0000000b0a01'::uuid, current_setting('t.comp')::uuid, NULL);
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'authorized')::boolean IS FALSE AND (r ? 'rows') IS FALSE,
    'E6 tech no recibe el historial ni como campo');
END $$;

-- ============ F. Reversa parcial ==========================================
DO $$
DECLARE r jsonb; v_al uuid;
BEGIN
  SELECT id INTO v_al FROM customer_account_payment_allocations WHERE status='active' LIMIT 1;
  -- cashier NO puede revertir (contrato de producto).
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000b0a02';
  r := reverse_payment_allocation_atomic('00000000-0000-0000-0000-0000000b0a01'::uuid, v_al, 10000, 'motivo', 'U2-REV-CASH');
  PERFORM pg_temp.assert(r->>'error_code'='FORBIDDEN', 'F1 cashier NO puede revertir');
  RESET ROLE;
  -- owner sí.
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000b0a09';
  r := reverse_payment_allocation_atomic('00000000-0000-0000-0000-0000000b0a01'::uuid, v_al, 10000, 'devolución parcial', 'U2-REV');
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'F2 owner revierte ('||COALESCE(r->>'error','')||')');
  PERFORM pg_temp.assert((r->>'reversed_amount')::numeric = 10000, 'F3 revirtió 10.000');
  PERFORM pg_temp.assert((r->>'remaining_amount')::numeric = 50000, 'F4 queda un remanente de 50.000');
END $$;
SELECT pg_temp.assert((SELECT payment_status FROM v_order_payment_state WHERE order_id=:'ord')='partial',
  'F5 readback: la orden vuelve a PARCIAL');
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000b0a09';
  r := get_allocation_workspace('00000000-0000-0000-0000-0000000b0a01'::uuid,'00000000-0000-0000-0000-0000000b0ac1'::uuid);
  RESET ROLE;
  PERFORM pg_temp.assert((r->'credits'->0->>'unallocated_amount')::numeric = 10000,
    'F6 los 10.000 revertidos vuelven a quedar como crédito disponible');
  PERFORM pg_temp.assert((r->'documents'->0->>'saldo_imputable')::numeric = 10000,
    'F7 el documento vuelve a tener 10.000 imputables');
END $$;

-- ============ G. Bordes que la UI debe respetar ===========================
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000b0a09';
  -- Sin saldo disponible en el pago.
  r := allocate_account_payment_atomic('00000000-0000-0000-0000-0000000b0a01'::uuid,
        current_setting('t.pay')::uuid,
        jsonb_build_array(jsonb_build_object('comprobante_id', current_setting('t.comp'), 'amount', 99000)),
        'x', 'U2-OVER');
  PERFORM pg_temp.assert(r->>'error' LIKE '%EXCEEDS%', 'G1 no se puede imputar más de lo disponible');
  -- Comprobante anulado: no admite imputación.
  r := annul_comprobante_atomic(current_setting('t.comp')::uuid,'void_same_session','test',false,'U2-ANN');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'G2 anulación ok ('||COALESCE(r->>'error','')||')');
  r := allocate_account_payment_atomic('00000000-0000-0000-0000-0000000b0a01'::uuid,
        current_setting('t.pay')::uuid,
        jsonb_build_array(jsonb_build_object('comprobante_id', current_setting('t.comp'), 'amount', 1000)),
        'x', 'U2-ANN-ALLOC');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'error' LIKE '%ANNULLED%', 'G3 un comprobante anulado no admite imputación');
END $$;
SELECT pg_temp.assert((SELECT payment_status FROM v_order_payment_state WHERE order_id=:'ord')='sin_facturar',
  'G4 anulado el comprobante, la orden queda SIN FACTURAR (no cobrada)');

-- ============ H. Moneda ===================================================
SELECT pg_temp.assert(
  (SELECT count(*) FROM information_schema.check_constraints cc
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = cc.constraint_name
   WHERE ccu.table_name = 'customer_account_payment_allocations' AND cc.check_clause LIKE '%ARS%') >= 1,
  'H1 la asignación sólo admite ARS: no hay conversión de moneda silenciosa');

ROLLBACK;
