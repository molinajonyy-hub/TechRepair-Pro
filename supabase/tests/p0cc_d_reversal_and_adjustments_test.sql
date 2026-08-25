-- ============================================================================
-- P0-CC · CC-D — Reversa canónica del cobro + movimientos manuales auditados.
--
-- READ-ONLY: todo dentro de BEGIN … ROLLBACK.
--
-- El contrato del pedido, medido de punta a punta:
--   deuda 100.000 -> cobro 40.000 transferencia -> saldo 60.000, caja +40.000
--   reversa       -> saldo 100.000, caja neta 0, BFE neto 0, historial completo
--
-- Y los casos difíciles: doble reversa, reversa de una reversa, cobro imputado,
-- actor sin capacidad, otro tenant, y las tres patas neteando a cero.
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set biz  '00000000-0000-0000-0000-00000ccd1001'
\set biz2 '00000000-0000-0000-0000-00000ccd1002'
\set own  '00000000-0000-0000-0000-00000ccd10a1'
\set vwr  '00000000-0000-0000-0000-00000ccd10a7'
\set own2 '00000000-0000-0000-0000-00000ccd10b1'
\set cust '00000000-0000-0000-0000-00000ccd10c1'
\set caja '00000000-0000-0000-0000-00000ccd1061'
\set ord1 '00000000-0000-0000-0000-00000ccd10f1'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'own'),(:'vwr'),(:'own2');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','CC-D A',:'own'), (:'biz2','CC-D B',:'own2');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES
  (:'biz',:'own','owner',true), (:'biz',:'vwr','viewer',true), (:'biz2',:'own2','owner',true);
INSERT INTO customers(id,business_id,name,phone,customer_type) VALUES (:'cust',:'biz','Cliente','+540009','minorista');
INSERT INTO cajas(id,business_id,opened_by,status,efectivo_inicial,transferencia_inicial,tarjeta_inicial,usd_inicial)
  VALUES (:'caja',:'biz',:'own','abierta',0,0,0,0);
INSERT INTO orders(id,business_id,status,created_by) VALUES (:'ord1',:'biz','repair',:'own');
SET LOCAL session_replication_role='origin';

CREATE OR REPLACE FUNCTION pg_temp.arqueo(p_caja uuid)
RETURNS TABLE(efectivo numeric, transferencia numeric, tarjeta numeric, usd numeric, total_fm numeric)
LANGUAGE sql AS $$
  SELECT
    COALESCE((SELECT SUM(CASE WHEN type='income' THEN amount_ars ELSE -amount_ars END)
      FROM financial_movements WHERE caja_id=p_caja AND COALESCE(metodo_pago,'efectivo')='efectivo'),0),
    COALESCE((SELECT SUM(CASE WHEN type='income' THEN amount_ars ELSE -amount_ars END)
      FROM financial_movements WHERE caja_id=p_caja AND metodo_pago='transferencia'),0),
    COALESCE((SELECT SUM(CASE WHEN type='income' THEN amount_ars ELSE -amount_ars END)
      FROM financial_movements WHERE caja_id=p_caja AND metodo_pago='tarjeta'),0),
    COALESCE((SELECT SUM(CASE WHEN type='income' THEN amount ELSE -amount END)
      FROM financial_movements WHERE caja_id=p_caja AND metodo_pago='usd'),0),
    COALESCE((SELECT SUM(CASE WHEN type='income' THEN amount_ars ELSE -amount_ars END)
      FROM financial_movements WHERE caja_id=p_caja),0)
$$;
CREATE OR REPLACE FUNCTION pg_temp.bal(p_acc uuid) RETURNS numeric
LANGUAGE sql AS $$ SELECT balance FROM accounts WHERE id=p_acc $$;
-- Neto del espejo BFE de cobros de CC: tiene que volver a 0 tras la reversa.
CREATE OR REPLACE FUNCTION pg_temp.bfe_neto(p_biz uuid) RETURNS numeric
LANGUAGE sql AS $$ SELECT COALESCE(SUM(amount_ars),0) FROM business_finance_entries
  WHERE business_id=p_biz AND category='cobro_cuenta_corriente' $$;

-- ── Deuda 100.000 y cobro 40.000 transferencia ──────────────────────────────
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000ccd10a1';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-00000ccd1001'::uuid,'CCDK1','h1',
    jsonb_build_object(
      'tipo','factura_c','punto_venta','0001','condicion_fiscal','Consumidor Final',
      'customer_id','00000000-0000-0000-0000-00000ccd10c1',
      'order_id','00000000-0000-0000-0000-00000ccd10f1','es_fiscal',false,'cc_total',100000,
      'items', jsonb_build_array(jsonb_build_object(
        'descripcion','Servicio','tipo_linea','servicio','cantidad',1,
        'precio_unitario',100000,'descuento_linea',0,'costo_unitario',0,
        'currency','ARS','exchange_rate',1,'inventory_id',NULL)),
      'pagos','[]'::jsonb));
  PERFORM pg_temp.assert(r->>'status'='created','D0 deuda 100.000 ('||COALESCE(r->>'error','')||')');
  RESET ROLE;
  PERFORM set_config('t.acc',(SELECT id::text FROM accounts
    WHERE business_id='00000000-0000-0000-0000-00000ccd1001'
      AND entity_id='00000000-0000-0000-0000-00000ccd10c1' LIMIT 1), true);
END $$;

DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000ccd10a1';
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-00000ccd1001'::uuid,
        current_setting('t.acc')::uuid, 40000, 'Cobro transferencia',
        '00000000-0000-0000-0000-00000ccd10a1'::uuid, 'transferencia', public.ar_today(),
        '00000000-0000-0000-0000-00000ccd1061'::uuid, 'CCD-PAY');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'D1 cobro 40.000 ok ('||COALESCE(r->>'error','')||')');
  PERFORM set_config('t.mov', r->>'account_movement_id', true);
  RESET ROLE;
END $$;

SELECT pg_temp.assert(pg_temp.bal(current_setting('t.acc')::uuid)=60000, 'D2 saldo = 60.000');
SELECT pg_temp.assert((SELECT transferencia FROM pg_temp.arqueo(:'caja'))=40000, 'D3 caja transferencia = +40.000');
SELECT pg_temp.assert(pg_temp.bfe_neto(:'biz')=40000, 'D4 BFE espejo = +40.000');

-- ════════════════ 1. Guards ANTES de permitir la reversa ════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000ccd10a7';
  r := reverse_customer_account_payment_atomic('00000000-0000-0000-0000-00000ccd1001'::uuid,
        current_setting('t.mov')::uuid, 'intento del viewer', 'CCD-VWR');
  PERFORM pg_temp.assert(r->>'error_code'='FORBIDDEN', 'D5 un viewer NO puede reversar');
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000ccd10b1';
  r := reverse_customer_account_payment_atomic('00000000-0000-0000-0000-00000ccd1001'::uuid,
        current_setting('t.mov')::uuid, 'intento cross-tenant', 'CCD-X');
  PERFORM pg_temp.assert(r->>'error_code'='FORBIDDEN', 'D6 otro tenant NO puede reversar');
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000ccd10a1';
  r := reverse_customer_account_payment_atomic('00000000-0000-0000-0000-00000ccd1001'::uuid,
        current_setting('t.mov')::uuid, NULL, 'CCD-NOREASON');
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'D7 el motivo es obligatorio');
  RESET ROLE;
END $$;

SELECT pg_temp.assert(pg_temp.bal(current_setting('t.acc')::uuid)=60000, 'D8 los intentos rechazados no movieron el saldo');
SELECT pg_temp.assert((SELECT transferencia FROM pg_temp.arqueo(:'caja'))=40000, 'D9 …ni la caja');

-- ════════════════ 2. Cobro IMPUTADO: no se deshace en cascada ═══════════════
DO $$
DECLARE r jsonb; v_comp uuid;
BEGIN
  SELECT id INTO v_comp FROM comprobantes WHERE business_id='00000000-0000-0000-0000-00000ccd1001' LIMIT 1;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000ccd10a1';
  r := allocate_account_payment_atomic('00000000-0000-0000-0000-00000ccd1001'::uuid,
        current_setting('t.mov')::uuid,
        jsonb_build_array(jsonb_build_object('comprobante_id', v_comp, 'amount', 40000)),
        'imputación de prueba', 'CCD-ALLOC');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'D10 imputación ok ('||COALESCE(r->>'error','')||')');
  r := reverse_customer_account_payment_atomic('00000000-0000-0000-0000-00000ccd1001'::uuid,
        current_setting('t.mov')::uuid, 'reversa con imputación viva', 'CCD-REV-BLOCKED');
  PERFORM pg_temp.assert(r->>'error_code'='PAYMENT_ALLOCATED',
    'D11 un cobro IMPUTADO no se reversa: hay que desimputar primero');
  -- Desimputar con la RPC que ya existía: toma el id de la IMPUTACIÓN, no el del cobro.
  r := reverse_payment_allocation_atomic('00000000-0000-0000-0000-00000ccd1001'::uuid,
        (SELECT id FROM customer_account_payment_allocations
          WHERE payment_movement_id=current_setting('t.mov')::uuid AND status='active' LIMIT 1),
        40000, 'desimputar', 'CCD-UNALLOC');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'D12 desimputación ok ('||COALESCE(r->>'error','')||')');
  RESET ROLE;
END $$;

-- ════════════════ 3. LA REVERSA ═════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000ccd10a1';
  r := reverse_customer_account_payment_atomic('00000000-0000-0000-0000-00000ccd1001'::uuid,
        current_setting('t.mov')::uuid, 'cobro cargado por error', 'CCD-REV');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'D13 reversa ok ('||COALESCE(r->>'error','')||')');
  PERFORM set_config('t.rev', r->>'reversal_movement_id', true);
  RESET ROLE;
END $$;

-- El contrato exacto del pedido:
SELECT pg_temp.assert(pg_temp.bal(current_setting('t.acc')::uuid)=100000,
  'D14 el saldo vuelve a 100.000');
SELECT pg_temp.assert((SELECT transferencia FROM pg_temp.arqueo(:'caja'))=0,
  'D15 la caja NETEA a 0 en el bucket transferencia');
SELECT pg_temp.assert((SELECT total_fm FROM pg_temp.arqueo(:'caja'))=0,
  'D16 el total de la caja vuelve a 0');
SELECT pg_temp.assert(pg_temp.bfe_neto(:'biz')=0,
  'D17 el BFE espejo NETEA a 0 (no reconoce ingreso ni genera gasto)');

-- Historial completo: el cobro NO se borró.
SELECT pg_temp.assert(EXISTS (SELECT 1 FROM account_movements WHERE id=current_setting('t.mov')::uuid),
  'D18 el cobro original SIGUE en el ledger (append-only)');
SELECT pg_temp.assert((SELECT count(*) FROM account_movements
  WHERE account_id=current_setting('t.acc')::uuid AND reference_type='account_payment_reversal')=1,
  'D19 existe UN contra-movimiento enlazado');
SELECT pg_temp.assert((SELECT reference_id FROM account_movements WHERE id=current_setting('t.rev')::uuid)
  = current_setting('t.mov')::uuid,
  'D20 la reversa apunta inequívocamente al cobro original');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements
  WHERE reference_type='account_payment_reversal' AND reference_id=current_setting('t.mov')::uuid AND type='expense')=1,
  'D21 hay UN financial_movement compensatorio de tipo expense');
SELECT pg_temp.assert((SELECT metodo_pago FROM financial_movements
  WHERE reference_type='account_payment_reversal' AND reference_id=current_setting('t.mov')::uuid)='transferencia',
  'D22 la reversa conserva el método real (no lo reclasifica a efectivo)');

-- La fecha: la reversa es de HOY, el original conserva la suya.
SELECT pg_temp.assert((SELECT date FROM account_movements WHERE id=current_setting('t.rev')::uuid)=public.ar_today(),
  'D23 la reversa se fecha HOY');

-- ════════════════ 4. Idempotencia y doble reversa ═══════════════════════════
DO $$
DECLARE r jsonb; n_before int; n_after int;
BEGIN
  SELECT count(*) INTO n_before FROM account_movements WHERE account_id=current_setting('t.acc')::uuid;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000ccd10a1';
  -- MISMA key, MISMO payload -> replay.
  r := reverse_customer_account_payment_atomic('00000000-0000-0000-0000-00000ccd1001'::uuid,
        current_setting('t.mov')::uuid, 'cobro cargado por error', 'CCD-REV');
  PERFORM pg_temp.assert((r->>'replay')::boolean IS TRUE, 'D24 misma key -> replay, no una segunda reversa');
  -- MISMA key, motivo distinto -> conflicto explícito.
  r := reverse_customer_account_payment_atomic('00000000-0000-0000-0000-00000ccd1001'::uuid,
        current_setting('t.mov')::uuid, 'otro motivo', 'CCD-REV');
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT', 'D25 misma key + otro payload -> IDEMPOTENCY_CONFLICT');
  -- Key DISTINTA sobre el mismo cobro -> ALREADY_REVERSED. Esto NO lo garantiza
  -- el hash sino el UNIQUE sobre original_movement_id.
  r := reverse_customer_account_payment_atomic('00000000-0000-0000-0000-00000ccd1001'::uuid,
        current_setting('t.mov')::uuid, 'segundo intento', 'CCD-REV-2');
  PERFORM pg_temp.assert(r->>'error_code'='ALREADY_REVERSED',
    'D26 otra key sobre el mismo cobro -> ALREADY_REVERSED (lo garantiza el UNIQUE)');
  RESET ROLE;
  SELECT count(*) INTO n_after FROM account_movements WHERE account_id=current_setting('t.acc')::uuid;
  PERFORM pg_temp.assert(n_before=n_after, 'D27 ningún movimiento nuevo tras replay + conflicto + doble reversa');
END $$;

SELECT pg_temp.assert(pg_temp.bal(current_setting('t.acc')::uuid)=100000, 'D28 el saldo sigue en 100.000');
SELECT pg_temp.assert((SELECT total_fm FROM pg_temp.arqueo(:'caja'))=0,  'D29 la caja sigue en 0');
SELECT pg_temp.assert((SELECT count(*) FROM account_payment_reversals
  WHERE original_movement_id=current_setting('t.mov')::uuid)=1,
  'D30 existe exactamente UNA fila de reversa');

-- No se reversa una reversa.
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000ccd10a1';
  r := reverse_customer_account_payment_atomic('00000000-0000-0000-0000-00000ccd1001'::uuid,
        current_setting('t.rev')::uuid, 'reversar la reversa', 'CCD-REV-REV');
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'D31 no se puede reversar una reversa');
  RESET ROLE;
END $$;

-- ════════════════ 5. El store de reversas es inmutable ══════════════════════
DO $$
DECLARE v text := 'ok';
BEGIN
  BEGIN
    UPDATE account_payment_reversals SET reason='editado' WHERE original_movement_id=current_setting('t.mov')::uuid;
  EXCEPTION WHEN OTHERS THEN v := SQLSTATE; END;
  PERFORM pg_temp.assert(v='0A000', 'D32 el registro de reversa es inmutable incluso para postgres');
END $$;

-- ════════════════ 6. Movimientos manuales por RPC ═══════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000ccd10a7';
  r := record_customer_account_adjustment_atomic('00000000-0000-0000-0000-00000ccd1001'::uuid,
        current_setting('t.acc')::uuid, 500, 'debit', 'viewer intentando', 'CCD-ADJ-VWR');
  PERFORM pg_temp.assert(r->>'error_code'='FORBIDDEN', 'D33 un viewer NO registra ajustes');
  RESET ROLE;

  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000ccd10a1';
  r := record_customer_account_adjustment_atomic('00000000-0000-0000-0000-00000ccd1001'::uuid,
        current_setting('t.acc')::uuid, 500, 'pepe', 'dirección inválida', 'CCD-ADJ-BAD');
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'D34 dirección inválida rechazada');
  r := record_customer_account_adjustment_atomic('00000000-0000-0000-0000-00000ccd1001'::uuid,
        current_setting('t.acc')::uuid, 500, 'debit', NULL, 'CCD-ADJ-NOREASON');
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'D35 el motivo es obligatorio');

  r := record_customer_account_adjustment_atomic('00000000-0000-0000-0000-00000ccd1001'::uuid,
        current_setting('t.acc')::uuid, 5000, 'debit', 'deuda manual', 'CCD-ADJ-D');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'D36 deuda manual ok');
  r := record_customer_account_adjustment_atomic('00000000-0000-0000-0000-00000ccd1001'::uuid,
        current_setting('t.acc')::uuid, 2000, 'credit', 'ajuste a favor', 'CCD-ADJ-C');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'D37 ajuste acreedor ok');
  -- Idempotencia también acá.
  r := record_customer_account_adjustment_atomic('00000000-0000-0000-0000-00000ccd1001'::uuid,
        current_setting('t.acc')::uuid, 5000, 'debit', 'deuda manual', 'CCD-ADJ-D');
  PERFORM pg_temp.assert((r->>'replay')::boolean IS TRUE, 'D38 el ajuste es idempotente');
  RESET ROLE;
END $$;

SELECT pg_temp.assert(pg_temp.bal(current_setting('t.acc')::uuid)=103000,
  'D39 saldo = 100.000 + 5.000 − 2.000');
-- Un ajuste corrige el saldo; NO mueve caja. Si moviera caja sería un cobro.
SELECT pg_temp.assert((SELECT total_fm FROM pg_temp.arqueo(:'caja'))=0,
  'D40 un ajuste NO toca la caja');
SELECT pg_temp.assert((SELECT count(*) FROM account_movements
  WHERE account_id=current_setting('t.acc')::uuid AND reference_type='manual_debt')=1,
  'D41 la deuda manual queda marcada como tal (semántica, no sólo signo)');
SELECT pg_temp.assert((SELECT count(*) FROM account_movements
  WHERE account_id=current_setting('t.acc')::uuid AND reference_type='manual_adjustment')=1,
  'D42 el ajuste acreedor también');

-- ════════════════ 7. La verdad del saldo sigue siendo una ═══════════════════
SELECT pg_temp.assert(
  (SELECT balance FROM accounts WHERE id=current_setting('t.acc')::uuid)
  = (SELECT COALESCE(SUM(debit-credit),0) FROM account_movements WHERE account_id=current_setting('t.acc')::uuid),
  'D43 accounts.balance == SUM(debit-credit) tras cobro, reversa y ajustes');

-- ════════════════ 8. Auditoría de todo el ciclo ═════════════════════════════
SELECT pg_temp.assert((SELECT count(*) FROM finance_audit_log
  WHERE business_id=:'biz' AND action='customer_account_payment_reversal')=1,
  'D44 la reversa dejó su evento de auditoría');
SELECT pg_temp.assert((SELECT count(*) FROM finance_audit_log
  WHERE business_id=:'biz' AND action='customer_account_adjustment')=2,
  'D45 los dos ajustes dejaron auditoría');

ROLLBACK;
