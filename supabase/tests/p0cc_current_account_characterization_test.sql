-- ============================================================================
-- P0-CC — Contrato de Cuenta Corriente, cobranzas y Caja.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- QUÉ ERA ESTE ARCHIVO Y EN QUÉ SE CONVIRTIÓ
-- ─────────────────────────────────────────────────────────────────────────────
-- Nació como test de CARACTERIZACIÓN: 39 aserciones que documentaban el
-- comportamiento REAL del sistema el 2026-08-25, catorce de ellas marcadas
-- `[BUG]` porque fijaban algo que estaba mal y había que reparar.
--
-- Con los lotes CC-A…CC-E aplicados, cada `[BUG]` se INVIRTIÓ. El archivo dejó
-- de describir defectos y pasó a ser la REGRESIÓN del contrato correcto. Se
-- conserva la numeración y el relato original para que se pueda leer qué
-- cambió y por qué: cada aserción invertida dice cuál era el comportamiento
-- viejo.
--
-- READ-ONLY: todo dentro de BEGIN … ROLLBACK. No toca datos reales.
-- Escala 1:1 con el escenario humano del pedido: deuda 100, cobro 40, cobro 20.
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set biz  '00000000-0000-0000-0000-00000cc00001'
\set own  '00000000-0000-0000-0000-00000cc00009'
\set vwr  '00000000-0000-0000-0000-00000cc00019'
\set cust '00000000-0000-0000-0000-00000cc000c1'
\set caja '00000000-0000-0000-0000-00000cc00061'
\set ord1 '00000000-0000-0000-0000-00000cc000f1'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'own'), (:'vwr');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','P0CC',:'own');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES
  (:'biz',:'own','owner',true), (:'biz',:'vwr','viewer',true);
INSERT INTO customers(id,business_id,name,phone,customer_type)
  VALUES (:'cust',:'biz','Cliente CC','+540009','minorista');
INSERT INTO cajas(id,business_id,opened_by,status,efectivo_inicial,transferencia_inicial,tarjeta_inicial,usd_inicial)
  VALUES (:'caja',:'biz',:'own','abierta',0,0,0,0);
INSERT INTO orders(id,business_id,status,created_by) VALUES (:'ord1',:'biz','repair',:'own');
SET LOCAL session_replication_role='origin';

-- ── Helper: réplica EXACTA de los 4 buckets de close_cash_session_atomic ─────
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
CREATE OR REPLACE FUNCTION pg_temp.bal_ledger(p_acc uuid) RETURNS numeric
LANGUAGE sql AS $$ SELECT COALESCE(SUM(debit-credit),0) FROM account_movements WHERE account_id=p_acc $$;

/**
 * Intenta el INSERT directo al ledger que hacía el camino legacy.
 * Devuelve 'ok' si lo logra, o el SQLSTATE. Después de CC-E debe ser 42501.
 */
CREATE OR REPLACE FUNCTION pg_temp.insert_legacy(p_uid text, p_debit numeric, p_credit numeric, p_desc text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text := 'ok';
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', p_uid, true);
  BEGIN
    INSERT INTO account_movements (business_id, account_id, date, type, description,
      debit, credit, balance_after, reference_type, reference_id, created_by)
    VALUES ('00000000-0000-0000-0000-00000cc00001'::uuid, current_setting('t.acc')::uuid,
      public.ar_today(), 'pago', p_desc, p_debit, p_credit, 0, NULL, NULL, p_uid::uuid);
  EXCEPTION WHEN OTHERS THEN v := SQLSTATE; END;
  RESET ROLE;
  RETURN v;
END $$;

-- ════════════════ A. El cliente queda debiendo 100 (venta a CC) ═════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000cc00009';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-00000cc00001'::uuid,'CCK1','h1',
    jsonb_build_object(
      'tipo','factura_c','punto_venta','0001','condicion_fiscal','Consumidor Final',
      'customer_id','00000000-0000-0000-0000-00000cc000c1',
      'order_id','00000000-0000-0000-0000-00000cc000f1','es_fiscal',false,'cc_total',100,
      'items', jsonb_build_array(jsonb_build_object(
        'descripcion','Servicio','tipo_linea','servicio','cantidad',1,
        'precio_unitario',100,'descuento_linea',0,'costo_unitario',0,
        'currency','ARS','exchange_rate',1,'inventory_id',NULL)),
      'pagos','[]'::jsonb));
  PERFORM pg_temp.assert(r->>'status'='created','A0 venta 100 a CC ('||COALESCE(r->>'error','')||')');
  RESET ROLE;
  PERFORM set_config('t.acc',(SELECT id::text FROM accounts
    WHERE business_id='00000000-0000-0000-0000-00000cc00001'
      AND entity_id='00000000-0000-0000-0000-00000cc000c1' LIMIT 1), true);
END $$;

SELECT pg_temp.assert(pg_temp.bal(current_setting('t.acc')::uuid)=100, 'A1 saldo = 100');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE caja_id=:'caja')=0,
  'A2 la venta a CC NO genera movimiento de caja (correcto: no se cobró nada)');
SELECT pg_temp.assert((SELECT reference_type FROM account_movements
  WHERE account_id=current_setting('t.acc')::uuid AND type='venta')='comprobante',
  'A3 la deuda nace con reference_type=comprobante (open-item)');

-- ════════════ B. El camino LEGACY de /cuentas YA NO EXISTE ══════════════════
-- ANTES: `cuentasService.registerPayment` -> INSERT directo. Bajaba la deuda y
-- no creaba ni el movimiento de caja ni el asiento financiero. En producción
-- quedó un cobro así por ARS 500.000.
-- AHORA (CC-E): el cliente no tiene INSERT sobre el ledger.
SELECT pg_temp.assert(pg_temp.insert_legacy(:'own', 0, 40, 'Pago del cliente')='42501',
  'B1 [INVERTIDA] el INSERT directo al ledger es RECHAZADO con 42501');
SELECT pg_temp.assert(pg_temp.bal(current_setting('t.acc')::uuid)=100,
  'B2 [INVERTIDA] el saldo NO se movió: ya no hay forma de bajar una deuda sin tocar la caja');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE caja_id=:'caja')=0,
  'B3 el intento rechazado no dejó movimiento de caja');
-- El error es EXPLÍCITO, no un silencioso "0 filas": el cliente se entera.
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.account_movements','INSERT'),
  'B4 [INVERTIDA] authenticated no tiene INSERT sobre el ledger');
SELECT pg_temp.assert(NOT EXISTS (SELECT 1 FROM pg_policies
  WHERE schemaname='public' AND tablename='account_movements' AND cmd IN ('INSERT','UPDATE','DELETE','ALL')),
  'B5 [INVERTIDA] no queda NINGUNA policy de escritura sobre el ledger');

-- ════════════ C. Cobro 20 EFECTIVO por el camino CANÓNICO (RPC) ═════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000cc00009';
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-00000cc00001'::uuid,
    current_setting('t.acc')::uuid, 20, 'Cobro efectivo',
    '00000000-0000-0000-0000-00000cc00009'::uuid, 'efectivo', public.ar_today(),
    '00000000-0000-0000-0000-00000cc00061'::uuid, 'CC-EF-1');
  PERFORM pg_temp.assert((r->>'ok')::boolean,'C0 RPC efectivo ok ('||COALESCE(r->>'error','')||')');
  PERFORM set_config('t.mov_ef', r->>'account_movement_id', true);
  RESET ROLE;
END $$;

SELECT pg_temp.assert(pg_temp.bal(current_setting('t.acc')::uuid)=80, 'C1 saldo = 80');
SELECT pg_temp.assert((SELECT efectivo FROM pg_temp.arqueo(:'caja'))=20,
  'C2 arqueo efectivo = 20 — la caja SÍ sube por el camino canónico');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries
  WHERE business_id=:'biz' AND category='cobro_cuenta_corriente')=1,
  'C3 el camino canónico SÍ crea el BFE espejo');

-- ════════════ D. Cobro 10 TRANSFERENCIA — no debe inventar efectivo ═════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000cc00009';
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-00000cc00001'::uuid,
    current_setting('t.acc')::uuid, 10, 'Cobro transferencia',
    '00000000-0000-0000-0000-00000cc00009'::uuid, 'transferencia', public.ar_today(),
    '00000000-0000-0000-0000-00000cc00061'::uuid, 'CC-TR-1');
  PERFORM pg_temp.assert((r->>'ok')::boolean,'D0 RPC transferencia ok ('||COALESCE(r->>'error','')||')');
  RESET ROLE;
END $$;

SELECT pg_temp.assert(pg_temp.bal(current_setting('t.acc')::uuid)=70, 'D1 saldo = 70');
SELECT pg_temp.assert((SELECT efectivo FROM pg_temp.arqueo(:'caja'))=20,
  'D2 la transferencia NO infla el efectivo (sigue 20)');
SELECT pg_temp.assert((SELECT transferencia FROM pg_temp.arqueo(:'caja'))=10,
  'D3 la transferencia va a su propio bucket');

-- ════════════ E. Cobro 10 con "debito" — el que rompía el arqueo ════════════
-- ANTES: la RPC persistía el string CRUDO en `financial_movements.metodo_pago`.
-- El arqueo sólo conoce efectivo/transferencia/tarjeta/usd, así que esos 10
-- pesos quedaban atados a la caja pero fuera de todos los buckets.
-- AHORA (CC-A): el normalizador server-side lo mapea a `tarjeta`.
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000cc00009';
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-00000cc00001'::uuid,
    current_setting('t.acc')::uuid, 10, 'Cobro debito',
    '00000000-0000-0000-0000-00000cc00009'::uuid, 'debito', public.ar_today(),
    '00000000-0000-0000-0000-00000cc00061'::uuid, 'CC-DB-1');
  PERFORM pg_temp.assert((r->>'ok')::boolean,'E0 RPC debito ok ('||COALESCE(r->>'error','')||')');
  RESET ROLE;
END $$;

SELECT pg_temp.assert(pg_temp.bal(current_setting('t.acc')::uuid)=60, 'E1 saldo = 60');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements
  WHERE caja_id=:'caja' AND metodo_pago='debito')=0,
  'E2 [INVERTIDA] ya NO se persiste el string crudo "debito"');
SELECT pg_temp.assert((SELECT tarjeta FROM pg_temp.arqueo(:'caja'))=10,
  'E3 [INVERTIDA] el cobro con "debito" cae en el bucket TARJETA');
SELECT pg_temp.assert((SELECT efectivo+transferencia+tarjeta+usd FROM pg_temp.arqueo(:'caja'))
  = (SELECT total_fm FROM pg_temp.arqueo(:'caja')),
  'E4 [INVERTIDA] INVARIANTE: los buckets suman EXACTAMENTE lo que entró a la caja');
-- Y un método que nadie reconoce ya no se guarda "por las dudas": se rechaza.
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000cc00009';
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-00000cc00001'::uuid,
    current_setting('t.acc')::uuid, 5, 'Cobro raro',
    '00000000-0000-0000-0000-00000cc00009'::uuid, 'pepe', public.ar_today(),
    '00000000-0000-0000-0000-00000cc00061'::uuid, 'CC-BAD');
  PERFORM pg_temp.assert(r->>'error_code'='INVALID_PAYMENT_METHOD',
    'E5 [NUEVA] un método desconocido es fail-closed, no un fallback a efectivo');
  RESET ROLE;
END $$;

-- ════════════ F. Idempotencia (doble click / retry / refresh) ═══════════════
DO $$
DECLARE r jsonb; n_before int; n_after int;
BEGIN
  SELECT count(*) INTO n_before FROM account_movements WHERE account_id=current_setting('t.acc')::uuid;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000cc00009';
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-00000cc00001'::uuid,
    current_setting('t.acc')::uuid, 20, 'Cobro efectivo',
    '00000000-0000-0000-0000-00000cc00009'::uuid, 'efectivo', public.ar_today(),
    '00000000-0000-0000-0000-00000cc00061'::uuid, 'CC-EF-1');
  PERFORM pg_temp.assert((r->>'replay')::boolean IS TRUE, 'F1 misma key + mismo payload -> replay');
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-00000cc00001'::uuid,
    current_setting('t.acc')::uuid, 5, 'Otra cosa',
    '00000000-0000-0000-0000-00000cc00009'::uuid, 'efectivo', public.ar_today(),
    '00000000-0000-0000-0000-00000cc00061'::uuid, 'CC-EF-1');
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT', 'F2 misma key + otro payload -> IDEMPOTENCY_CONFLICT');
  RESET ROLE;
  SELECT count(*) INTO n_after FROM account_movements WHERE account_id=current_setting('t.acc')::uuid;
  PERFORM pg_temp.assert(n_before=n_after, 'F3 ningún movimiento nuevo tras replay+conflicto');
END $$;

-- ANTES: el camino legacy no tenía idempotencia — dos inserts, dos cobros.
-- AHORA: ni siquiera se llega a insertar.
SELECT pg_temp.assert(pg_temp.insert_legacy(:'own', 0, 5, 'Doble click')='42501',
  'F4 [INVERTIDA] el doble cobro por INSERT directo es imposible: 42501');
SELECT pg_temp.assert(pg_temp.bal(current_setting('t.acc')::uuid)=60, 'F5 saldo intacto = 60');

-- ════════════ G. Sobrepago ══════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000cc00009';
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-00000cc00001'::uuid,
    current_setting('t.acc')::uuid, 999, 'Sobrepago', '00000000-0000-0000-0000-00000cc00009'::uuid,
    'efectivo', public.ar_today(), '00000000-0000-0000-0000-00000cc00061'::uuid, 'CC-OVER');
  PERFORM pg_temp.assert(r->>'error_code'='OVERPAYMENT', 'G1 el camino canónico RECHAZA el sobrepago');
  RESET ROLE;
END $$;
-- ANTES: el legacy lo aceptaba y dejaba el saldo negativo sin control.
SELECT pg_temp.assert(pg_temp.insert_legacy(:'own', 0, 999, 'Sobrepago legacy')='42501',
  'G2 [INVERTIDA] el sobrepago por INSERT directo tampoco existe ya');
SELECT pg_temp.assert(pg_temp.bal(current_setting('t.acc')::uuid)=60,
  'G3 el saldo nunca se puede volver negativo por esta vía');

-- ════════════ H. RBAC — qué puede hacer un viewer ═══════════════════════════
DO $$
DECLARE n int; v_bal numeric; v_upd text := 'ok';
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000cc00019', true);
  SELECT count(*) INTO n FROM accounts WHERE business_id='00000000-0000-0000-0000-00000cc00001';
  BEGIN
    UPDATE accounts SET balance = 0 WHERE id=current_setting('t.acc')::uuid;
  EXCEPTION WHEN OTHERS THEN v_upd := SQLSTATE; END;
  RESET ROLE;
  PERFORM pg_temp.assert(n=0, 'H1 [INVERTIDA] un VIEWER ya NO lee las cuentas corrientes');
  PERFORM pg_temp.assert(v_upd='42501', 'H3 [INVERTIDA] un VIEWER ya NO puede pisar accounts.balance');
END $$;

SELECT pg_temp.assert(pg_temp.insert_legacy(:'vwr', 5, 0, 'Ajuste de un viewer')='42501',
  'H2 [INVERTIDA] un VIEWER ya NO escribe en el ledger');

-- ANTES: pisar `accounts.balance` hacía divergir las dos verdades del saldo, y
-- como el trigger ANCLA en la columna, la corrupción se propagaba para siempre.
-- AHORA la columna es inescribible, así que no pueden divergir.
SELECT pg_temp.assert(pg_temp.bal(current_setting('t.acc')::uuid)
                    = pg_temp.bal_ledger(current_setting('t.acc')::uuid),
  'H4 [INVERTIDA] accounts.balance y SUM(debit-credit) COINCIDEN');
SELECT pg_temp.assert(NOT has_column_privilege('authenticated','public.accounts','balance','UPDATE'),
  'H5 [INVERTIDA] la columna del saldo no es escribible: la corrupción no puede empezar');

-- ════════════ I. Reversas ═══════════════════════════════════════════════════
-- ANTES: no existía RPC para revertir un cobro de cuenta corriente.
SELECT pg_temp.assert(EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='reverse_customer_account_payment_atomic'),
  'I1 [INVERTIDA] EXISTE la RPC de reversa del cobro');
SELECT pg_temp.assert(EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='reverse_payment_allocation_atomic'),
  'I2 también existe la reversa de IMPUTACIÓN (son cosas distintas)');

-- Y funciona de punta a punta sobre el cobro en efectivo de C.
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000cc00009';
  r := reverse_customer_account_payment_atomic('00000000-0000-0000-0000-00000cc00001'::uuid,
        current_setting('t.mov_ef')::uuid, 'cobro cargado por error', 'CC-REV-1');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'I3 [NUEVA] la reversa se ejecuta ('||COALESCE(r->>'error','')||')');
  RESET ROLE;
END $$;
SELECT pg_temp.assert(pg_temp.bal(current_setting('t.acc')::uuid)=80,
  'I4 [NUEVA] la reversa devuelve la deuda (60 + 20 reversados)');
SELECT pg_temp.assert((SELECT efectivo FROM pg_temp.arqueo(:'caja'))=0,
  'I5 [NUEVA] y descuenta el ingreso de la caja: el bucket efectivo netea a 0');
SELECT pg_temp.assert(EXISTS (SELECT 1 FROM account_movements WHERE id=current_setting('t.mov_ef')::uuid),
  'I6 [NUEVA] el cobro original NO se borró: el ledger sigue siendo append-only');
-- El DELETE del cliente sigue prohibido, igual que antes.
DO $$
DECLARE v text := 'ok';
BEGIN
  SET LOCAL ROLE authenticated; PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000cc00009', true);
  BEGIN
    DELETE FROM account_movements WHERE account_id=current_setting('t.acc')::uuid;
  EXCEPTION WHEN OTHERS THEN v := SQLSTATE; END;
  RESET ROLE;
  PERFORM pg_temp.assert(v='42501', 'I7 el DELETE del ledger por el cliente sigue siendo 42501');
END $$;

-- ════════════ J. Moneda ═════════════════════════════════════════════════════
SELECT pg_temp.assert(NOT EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema='public' AND table_name='account_movements'
    AND column_name IN ('currency','exchange_rate','amount_ars')),
  'J1 account_movements NO tiene moneda ni cotización — la CC es ARS por construcción');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements
  WHERE caja_id=:'caja' AND currency<>'ARS')=0,
  'J2 la RPC de cobro CC fija ARS/rate=1 — no puede producir un cobro en USD');
-- Y ahora se rechaza EXPLÍCITAMENTE en vez de depender de que nadie lo intente.
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000cc00009';
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-00000cc00001'::uuid,
    current_setting('t.acc')::uuid, 5, 'Cobro USD', '00000000-0000-0000-0000-00000cc00009'::uuid,
    'usd', public.ar_today(), '00000000-0000-0000-0000-00000cc00061'::uuid, 'CC-USD');
  PERFORM pg_temp.assert(r->>'error_code'='INVALID_PAYMENT_METHOD',
    'J3 [NUEVA] "usd" se rechaza: la CC es ARS-only y no finge lo contrario');
  RESET ROLE;
END $$;

ROLLBACK;
