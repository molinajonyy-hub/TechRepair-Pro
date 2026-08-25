-- ============================================================================
-- P0-CC · CC-A — Normalización del método de cobro: truth table + invariante de arqueo.
--
-- READ-ONLY: todo dentro de BEGIN … ROLLBACK.
--
-- Lo que prueba:
--   1. la truth table completa de los dos normalizadores;
--   2. que TODO alias aceptado cae en un bucket que el arqueo sabe leer;
--   3. que un método desconocido es FAIL-CLOSED en la RPC: 0 ledger, 0 FM, 0 BFE;
--   4. la INVARIANTE central: para una caja, la suma de los 4 buckets del arqueo
--      es IGUAL a la suma de sus financial_movements. Es el test que habría
--      atrapado CC-2 sin necesidad de saber que CC-2 existía.
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set biz  '00000000-0000-0000-0000-00000cca0001'
\set own  '00000000-0000-0000-0000-00000cca0009'
\set cust '00000000-0000-0000-0000-00000cca00c1'
\set caja '00000000-0000-0000-0000-00000cca0061'
\set ord1 '00000000-0000-0000-0000-00000cca00f1'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'own');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','CC-A',:'own');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES (:'biz',:'own','owner',true);
INSERT INTO customers(id,business_id,name,phone,customer_type) VALUES (:'cust',:'biz','Cliente','+540009','minorista');
INSERT INTO cajas(id,business_id,opened_by,status,efectivo_inicial,transferencia_inicial,tarjeta_inicial,usd_inicial)
  VALUES (:'caja',:'biz',:'own','abierta',0,0,0,0);
INSERT INTO orders(id,business_id,status,created_by) VALUES (:'ord1',:'biz','repair',:'own');
SET LOCAL session_replication_role='origin';

-- Réplica EXACTA de los buckets de close_cash_session_atomic.
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

-- ════════════════ 1. Truth table — bucket de CAJA ═══════════════════════════
SELECT pg_temp.assert(public.normalize_cc_payment_method('efectivo')        = 'efectivo',      'T1 efectivo -> efectivo');
SELECT pg_temp.assert(public.normalize_cc_payment_method('transferencia')   = 'transferencia', 'T2 transferencia -> transferencia');
SELECT pg_temp.assert(public.normalize_cc_payment_method('debito')          = 'tarjeta',       'T3 debito -> tarjeta');
SELECT pg_temp.assert(public.normalize_cc_payment_method('credito')         = 'tarjeta',       'T4 credito -> tarjeta');
SELECT pg_temp.assert(public.normalize_cc_payment_method('tarjeta_debito')  = 'tarjeta',       'T5 tarjeta_debito -> tarjeta');
SELECT pg_temp.assert(public.normalize_cc_payment_method('tarjeta_credito') = 'tarjeta',       'T6 tarjeta_credito -> tarjeta');
SELECT pg_temp.assert(public.normalize_cc_payment_method('tarjeta')         = 'tarjeta',       'T7 tarjeta -> tarjeta');
SELECT pg_temp.assert(public.normalize_cc_payment_method('qr')              = 'tarjeta',       'T8 qr -> tarjeta');
SELECT pg_temp.assert(public.normalize_cc_payment_method('mercado_pago')    = 'tarjeta',       'T9 mercado_pago -> tarjeta');
SELECT pg_temp.assert(public.normalize_cc_payment_method('otro')            = 'tarjeta',       'T10 otro -> tarjeta');

-- ════════════════ 2. Truth table — método de NEGOCIO ════════════════════════
SELECT pg_temp.assert(public.canonical_cc_payment_method('debito')  = 'tarjeta_debito',  'T11 biz: debito -> tarjeta_debito');
SELECT pg_temp.assert(public.canonical_cc_payment_method('credito') = 'tarjeta_credito', 'T12 biz: credito -> tarjeta_credito');
SELECT pg_temp.assert(public.canonical_cc_payment_method('efectivo')= 'efectivo',        'T13 biz: efectivo');
SELECT pg_temp.assert(public.canonical_cc_payment_method('mercado_pago')= 'qr',          'T14 biz: mercado_pago -> qr');

-- ════════════════ 3. FAIL-CLOSED — entradas inválidas ═══════════════════════
SELECT pg_temp.assert(public.normalize_cc_payment_method('')       IS NULL, 'T15 cadena vacía -> NULL');
SELECT pg_temp.assert(public.normalize_cc_payment_method('   ')    IS NULL, 'T16 sólo espacios -> NULL');
SELECT pg_temp.assert(public.normalize_cc_payment_method(NULL)     IS NULL, 'T17 NULL -> NULL');
SELECT pg_temp.assert(public.normalize_cc_payment_method('pepe')   IS NULL, 'T18 pepe -> NULL');
SELECT pg_temp.assert(public.normalize_cc_payment_method('crypto') IS NULL, 'T19 crypto -> NULL');
SELECT pg_temp.assert(public.normalize_cc_payment_method('bizum')  IS NULL, 'T20 bizum -> NULL');
SELECT pg_temp.assert(public.normalize_cc_payment_method('usd')    IS NULL, 'T21 usd -> NULL (la CC es ARS-only)');
SELECT pg_temp.assert(public.normalize_cc_payment_method('mixto')  IS NULL, 'T22 mixto -> NULL (un cobro, un método)');
SELECT pg_temp.assert(public.normalize_cc_payment_method('cuenta_corriente') IS NULL,
  'T23 cuenta_corriente -> NULL (no se cobra una CC con una CC)');

-- No hay ELSE efectivo: NINGÚN alias desconocido puede terminar en efectivo.
SELECT pg_temp.assert(NOT EXISTS (
  SELECT 1 FROM unnest(ARRAY['pepe','crypto','bizum','usd','mixto','','cash','tarjetas']) m
   WHERE public.normalize_cc_payment_method(m) IS NOT NULL),
  'T24 ningún método desconocido cae en un bucket (sin ELSE efectivo)');

-- Case / espacios: el cliente no puede colar variantes.
SELECT pg_temp.assert(public.normalize_cc_payment_method('  EFECTIVO ') = 'efectivo', 'T25 case-insensitive + trim');

-- ════════════════ 4. Contrato de la RPC ═════════════════════════════════════
-- Deuda inicial 100.000 vía checkout a CC.
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000cca0009';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-00000cca0001'::uuid,'CCAK1','h1',
    jsonb_build_object(
      'tipo','factura_c','punto_venta','0001','condicion_fiscal','Consumidor Final',
      'customer_id','00000000-0000-0000-0000-00000cca00c1',
      'order_id','00000000-0000-0000-0000-00000cca00f1','es_fiscal',false,'cc_total',100000,
      'items', jsonb_build_array(jsonb_build_object(
        'descripcion','Servicio','tipo_linea','servicio','cantidad',1,
        'precio_unitario',100000,'descuento_linea',0,'costo_unitario',0,
        'currency','ARS','exchange_rate',1,'inventory_id',NULL)),
      'pagos','[]'::jsonb));
  PERFORM pg_temp.assert(r->>'status'='created','T26 deuda 100.000 creada ('||COALESCE(r->>'error','')||')');
  RESET ROLE;
  PERFORM set_config('t.acc',(SELECT id::text FROM accounts
    WHERE business_id='00000000-0000-0000-0000-00000cca0001'
      AND entity_id='00000000-0000-0000-0000-00000cca00c1' LIMIT 1), true);
END $$;

-- 4.1 Método inválido -> INVALID_PAYMENT_METHOD y CERO escrituras.
DO $$
DECLARE r jsonb; n_am int; n_fm int; n_bfe int; n_am2 int; n_fm2 int; n_bfe2 int;
BEGIN
  SELECT count(*) INTO n_am  FROM account_movements WHERE account_id=current_setting('t.acc')::uuid;
  SELECT count(*) INTO n_fm  FROM financial_movements WHERE business_id='00000000-0000-0000-0000-00000cca0001';
  SELECT count(*) INTO n_bfe FROM business_finance_entries WHERE business_id='00000000-0000-0000-0000-00000cca0001';

  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000cca0009';
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-00000cca0001'::uuid,
        current_setting('t.acc')::uuid, 1000, 'Cobro raro',
        '00000000-0000-0000-0000-00000cca0009'::uuid, 'pepe', public.ar_today(),
        '00000000-0000-0000-0000-00000cca0061'::uuid, 'CCA-BAD-1');
  PERFORM pg_temp.assert(r->>'error_code'='INVALID_PAYMENT_METHOD', 'T27 método desconocido -> INVALID_PAYMENT_METHOD');

  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-00000cca0001'::uuid,
        current_setting('t.acc')::uuid, 1000, 'Cobro en dólares',
        '00000000-0000-0000-0000-00000cca0009'::uuid, 'usd', public.ar_today(),
        '00000000-0000-0000-0000-00000cca0061'::uuid, 'CCA-BAD-2');
  PERFORM pg_temp.assert(r->>'error_code'='INVALID_PAYMENT_METHOD', 'T28 usd rechazado (CC es ARS-only)');

  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-00000cca0001'::uuid,
        current_setting('t.acc')::uuid, 1000, 'Sin método',
        '00000000-0000-0000-0000-00000cca0009'::uuid, NULL, public.ar_today(),
        '00000000-0000-0000-0000-00000cca0061'::uuid, 'CCA-BAD-3');
  PERFORM pg_temp.assert(r->>'error_code'='INVALID_PAYMENT_METHOD', 'T29 método NULL rechazado (no hay default silencioso)');
  RESET ROLE;

  SELECT count(*) INTO n_am2  FROM account_movements WHERE account_id=current_setting('t.acc')::uuid;
  SELECT count(*) INTO n_fm2  FROM financial_movements WHERE business_id='00000000-0000-0000-0000-00000cca0001';
  SELECT count(*) INTO n_bfe2 FROM business_finance_entries WHERE business_id='00000000-0000-0000-0000-00000cca0001';
  PERFORM pg_temp.assert(n_am=n_am2,   'T30 rechazo -> 0 movimientos de ledger');
  PERFORM pg_temp.assert(n_fm=n_fm2,   'T31 rechazo -> 0 movimientos financieros');
  PERFORM pg_temp.assert(n_bfe=n_bfe2, 'T32 rechazo -> 0 asientos BFE');
END $$;

SELECT pg_temp.assert((SELECT balance FROM accounts WHERE id=current_setting('t.acc')::uuid)=100000,
  'T33 el saldo quedó intacto tras los rechazos');

-- 4.2 Cobros válidos: cada uno en su bucket.
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000cca0009';
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-00000cca0001'::uuid,
        current_setting('t.acc')::uuid, 40000, 'Cobro efectivo',
        '00000000-0000-0000-0000-00000cca0009'::uuid, 'efectivo', public.ar_today(),
        '00000000-0000-0000-0000-00000cca0061'::uuid, 'CCA-EF');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'T34 cobro efectivo ok');
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-00000cca0001'::uuid,
        current_setting('t.acc')::uuid, 20000, 'Cobro transferencia',
        '00000000-0000-0000-0000-00000cca0009'::uuid, 'transferencia', public.ar_today(),
        '00000000-0000-0000-0000-00000cca0061'::uuid, 'CCA-TR');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'T35 cobro transferencia ok');
  -- El alias legacy que rompía el arqueo:
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-00000cca0001'::uuid,
        current_setting('t.acc')::uuid, 10000, 'Cobro debito',
        '00000000-0000-0000-0000-00000cca0009'::uuid, 'debito', public.ar_today(),
        '00000000-0000-0000-0000-00000cca0061'::uuid, 'CCA-DB');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'T36 cobro debito ok');
  RESET ROLE;
END $$;

SELECT pg_temp.assert((SELECT efectivo      FROM pg_temp.arqueo(:'caja'))=40000, 'T37 bucket efectivo = 40.000');
SELECT pg_temp.assert((SELECT transferencia FROM pg_temp.arqueo(:'caja'))=20000, 'T38 bucket transferencia = 20.000');
SELECT pg_temp.assert((SELECT tarjeta       FROM pg_temp.arqueo(:'caja'))=10000,
  'T39 el cobro con "debito" cae en TARJETA (antes se evaporaba)');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements
  WHERE caja_id=:'caja' AND metodo_pago='debito')=0,
  'T40 ya NO se persiste el string crudo "debito" en metodo_pago');

-- El BFE conserva el método fino de negocio (débito ≠ crédito ≠ tarjeta genérica).
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries
  WHERE business_id=:'biz' AND category='cobro_cuenta_corriente' AND payment_method='tarjeta_debito')=1,
  'T41 el BFE guarda tarjeta_debito: no se pierde información de negocio');

-- ════════════════ 5. LA INVARIANTE ══════════════════════════════════════════
-- Ningún peso atado a la caja puede quedar fuera de los buckets del arqueo.
SELECT pg_temp.assert(
  (SELECT efectivo+transferencia+tarjeta FROM pg_temp.arqueo(:'caja'))
  = (SELECT total_fm FROM pg_temp.arqueo(:'caja')),
  'T42 INVARIANTE: suma de buckets == suma de financial_movements de la caja');
SELECT pg_temp.assert((SELECT usd FROM pg_temp.arqueo(:'caja'))=0,
  'T43 la CC nunca alimenta el bucket USD');
SELECT pg_temp.assert(NOT EXISTS (
  SELECT 1 FROM financial_movements
   WHERE caja_id=:'caja'
     AND COALESCE(metodo_pago,'efectivo') NOT IN ('efectivo','transferencia','tarjeta','usd')),
  'T44 ningún financial_movement de la caja tiene método fuera de catálogo');

-- ════════════════ 6. Saldo consistente ══════════════════════════════════════
SELECT pg_temp.assert(
  (SELECT balance FROM accounts WHERE id=current_setting('t.acc')::uuid) = 30000,
  'T45 saldo = 30.000 tras cobrar 70.000 de 100.000');
SELECT pg_temp.assert(
  (SELECT balance FROM accounts WHERE id=current_setting('t.acc')::uuid)
  = (SELECT COALESCE(SUM(debit-credit),0) FROM account_movements WHERE account_id=current_setting('t.acc')::uuid),
  'T46 accounts.balance == SUM(debit-credit)');

ROLLBACK;
