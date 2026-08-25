-- ============================================================================
-- P0-CC — Caracterización de Cuenta Corriente, cobranzas y Caja.
--
-- NO es un test de regresión: DOCUMENTA el comportamiento ACTUAL (2026-08-25,
-- main c7b3899, DB 237). Varias aserciones fijan comportamiento que el informe
-- clasifica como BUG — están marcadas [BUG] y deben INVERTIRSE cuando se repare.
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
-- (misma expresión que la RPC: sólo 'efectivo'(+NULL), 'transferencia',
--  'tarjeta', 'usd'. Cualquier otro metodo_pago no entra en ningún bucket.)
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
-- La "otra" verdad del saldo: la derivada del ledger (la que usa la RPC).
CREATE OR REPLACE FUNCTION pg_temp.bal_ledger(p_acc uuid) RETURNS numeric
LANGUAGE sql AS $$ SELECT COALESCE(SUM(debit-credit),0) FROM account_movements WHERE account_id=p_acc $$;

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
-- La deuda SÍ nace imputable: lleva reference_type/reference_id del comprobante.
SELECT pg_temp.assert((SELECT reference_type FROM account_movements
  WHERE account_id=current_setting('t.acc')::uuid AND type='venta')='comprobante',
  'A3 la deuda nace con reference_type=comprobante (open-item)');

-- ════════════ B. Cobro 40 EFECTIVO por el camino LEGACY (pantalla /cuentas) ══
-- Reproduce EXACTAMENTE lo que hace CuentasCorrientes.tsx:72
--   cuentasService.registerPayment -> addMovement -> INSERT account_movements
-- Sin RPC, sin método de pago, sin caja_id, sin idempotency key.
DO $$
BEGIN
  -- ARTEFACTO DEL TEST: `finance_begin_audit_scope()` hace
  -- set_config('m7.audit_managed','1',true) — TRANSACCIONAL. Como este test
  -- entero es UNA transacción, el flag que puso el checkout de A seguiría
  -- activo y silenciaría el backstop. En producción cada request de PostgREST
  -- es su propia transacción, así que acá lo bajamos a mano para medir el
  -- comportamiento REAL del INSERT directo.
  PERFORM set_config('m7.audit_managed','0', true);
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000cc00009';
  INSERT INTO account_movements (business_id, account_id, date, type, description,
    debit, credit, balance_after, reference_type, reference_id, created_by)
  VALUES ('00000000-0000-0000-0000-00000cc00001'::uuid, current_setting('t.acc')::uuid,
    public.ar_today(), 'pago', 'Pago del cliente', 0, 40, 0, NULL, NULL,
    '00000000-0000-0000-0000-00000cc00009'::uuid);
  RESET ROLE;
END $$;

SELECT pg_temp.assert(pg_temp.bal(current_setting('t.acc')::uuid)=60,
  'B1 el saldo SÍ baja a 60 — el ledger se actualiza');
-- [BUG P0-CONTABLE-1] La plata entró al cajón pero la caja no la ve.
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE caja_id=:'caja')=0,
  '[BUG] B2 el cobro legacy NO crea financial_movement -> la CAJA NO SUBE');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries
  WHERE business_id=:'biz' AND category='cobro_cuenta_corriente')=0,
  '[BUG] B3 el cobro legacy NO crea BFE -> invisible para finanzas');
SELECT pg_temp.assert((SELECT efectivo FROM pg_temp.arqueo(:'caja'))=0,
  '[BUG] B4 arqueo efectivo esperado = 0 aunque se cobraron 40 en efectivo');
-- Sí queda rastro de auditoría (el backstop audita, pero NO bloquea).
SELECT pg_temp.assert((SELECT count(*) FROM finance_audit_log
  WHERE entity_table='account_movements' AND source_rpc='trigger_backstop')>=1,
  'B5 el backstop deja rastro en finance_audit_log (audita, no bloquea)');

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
  RESET ROLE;
END $$;

SELECT pg_temp.assert(pg_temp.bal(current_setting('t.acc')::uuid)=40, 'C1 saldo = 40');
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

SELECT pg_temp.assert(pg_temp.bal(current_setting('t.acc')::uuid)=30, 'D1 saldo = 30');
SELECT pg_temp.assert((SELECT efectivo FROM pg_temp.arqueo(:'caja'))=20,
  'D2 la transferencia NO infla el efectivo (sigue 20)');
SELECT pg_temp.assert((SELECT transferencia FROM pg_temp.arqueo(:'caja'))=10,
  'D3 la transferencia va a su propio bucket');

-- ════════════ E. Cobro 10 con método "debito" — el que manda ModalPagarCC ═══
-- ModalPagarCC ofrece 'debito'/'credito'. La RPC persiste el string CRUDO en
-- financial_movements.metodo_pago (a diferencia del trigger de comprobantes,
-- que MAPEA al catálogo de caja: tarjeta_debito/tarjeta_credito -> 'tarjeta').
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

SELECT pg_temp.assert(pg_temp.bal(current_setting('t.acc')::uuid)=20, 'E1 saldo = 20');
-- [BUG P0-CONTABLE-2] el FM existe y está atado a la caja…
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements
  WHERE caja_id=:'caja' AND metodo_pago='debito')=1,
  'E2 el FM se crea con metodo_pago=debito, atado a la caja');
-- …pero NO entra en ninguno de los 4 buckets del arqueo.
SELECT pg_temp.assert((SELECT efectivo+transferencia+tarjeta+usd FROM pg_temp.arqueo(:'caja'))=30,
  '[BUG] E3 los 4 buckets suman 30, pero la caja recibió 40 -> 10 EVAPORADOS');
SELECT pg_temp.assert((SELECT total_fm FROM pg_temp.arqueo(:'caja'))=40,
  '[BUG] E4 el total real de FM de la caja es 40 -> el arqueo cierra con -10 fantasma');

-- ════════════ F. Idempotencia (doble click / retry / refresh) ═══════════════
DO $$
DECLARE r jsonb; n_before int; n_after int;
BEGIN
  SELECT count(*) INTO n_before FROM account_movements WHERE account_id=current_setting('t.acc')::uuid;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000cc00009';
  -- MISMA key, MISMO payload -> replay, no duplica
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-00000cc00001'::uuid,
    current_setting('t.acc')::uuid, 20, 'Cobro efectivo',
    '00000000-0000-0000-0000-00000cc00009'::uuid, 'efectivo', public.ar_today(),
    '00000000-0000-0000-0000-00000cc00061'::uuid, 'CC-EF-1');
  PERFORM pg_temp.assert((r->>'replay')::boolean IS TRUE, 'F1 misma key + mismo payload -> replay');
  -- MISMA key, payload DISTINTO -> conflicto explícito
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-00000cc00001'::uuid,
    current_setting('t.acc')::uuid, 5, 'Otra cosa',
    '00000000-0000-0000-0000-00000cc00009'::uuid, 'efectivo', public.ar_today(),
    '00000000-0000-0000-0000-00000cc00061'::uuid, 'CC-EF-1');
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT', 'F2 misma key + otro payload -> IDEMPOTENCY_CONFLICT');
  RESET ROLE;
  SELECT count(*) INTO n_after FROM account_movements WHERE account_id=current_setting('t.acc')::uuid;
  PERFORM pg_temp.assert(n_before=n_after, 'F3 ningún movimiento nuevo tras replay+conflicto');
END $$;

-- El camino LEGACY no tiene idempotencia: dos inserts = dos cobros.
DO $$
DECLARE n_before int; n_after int;
BEGIN
  SELECT count(*) INTO n_before FROM account_movements WHERE account_id=current_setting('t.acc')::uuid;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000cc00009';
  INSERT INTO account_movements (business_id, account_id, date, type, description, debit, credit, balance_after, created_by)
  VALUES ('00000000-0000-0000-0000-00000cc00001'::uuid, current_setting('t.acc')::uuid, public.ar_today(),
          'pago','Doble click',0,5,0,'00000000-0000-0000-0000-00000cc00009'::uuid);
  INSERT INTO account_movements (business_id, account_id, date, type, description, debit, credit, balance_after, created_by)
  VALUES ('00000000-0000-0000-0000-00000cc00001'::uuid, current_setting('t.acc')::uuid, public.ar_today(),
          'pago','Doble click',0,5,0,'00000000-0000-0000-0000-00000cc00009'::uuid);
  RESET ROLE;
  SELECT count(*) INTO n_after FROM account_movements WHERE account_id=current_setting('t.acc')::uuid;
  PERFORM pg_temp.assert(n_after-n_before=2, '[BUG] F4 el camino legacy duplica el cobro ante doble click');
END $$;
SELECT pg_temp.assert(pg_temp.bal(current_setting('t.acc')::uuid)=10, 'F5 saldo = 10 tras el doble cobro');

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
-- El legacy lo acepta y deja el saldo NEGATIVO sin control.
DO $$
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000cc00009';
  INSERT INTO account_movements (business_id, account_id, date, type, description, debit, credit, balance_after, created_by)
  VALUES ('00000000-0000-0000-0000-00000cc00001'::uuid, current_setting('t.acc')::uuid, public.ar_today(),
          'pago','Sobrepago legacy',0,999,0,'00000000-0000-0000-0000-00000cc00009'::uuid);
  RESET ROLE;
END $$;
SELECT pg_temp.assert(pg_temp.bal(current_setting('t.acc')::uuid)=-989,
  '[BUG] G2 el camino legacy ACEPTA el sobrepago (saldo -989, sin guard)');

-- ════════════ H. RBAC — ¿qué puede hacer un viewer? ═════════════════════════
DO $$
DECLARE n_before int; n_after int; v_bal numeric;
BEGIN
  SELECT count(*) INTO n_before FROM account_movements WHERE account_id=current_setting('t.acc')::uuid;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000cc00019';
  -- H1: ¿puede LEER la deuda de todos los clientes?
  PERFORM pg_temp.assert((SELECT count(*) FROM accounts WHERE business_id='00000000-0000-0000-0000-00000cc00001')=1,
    '[BUG] H1 un VIEWER lee las cuentas corrientes (is_staff incluye viewer)');
  -- H2: ¿puede ESCRIBIR en el ledger?
  INSERT INTO account_movements (business_id, account_id, date, type, description, debit, credit, balance_after, created_by)
  VALUES ('00000000-0000-0000-0000-00000cc00001'::uuid, current_setting('t.acc')::uuid, public.ar_today(),
          'ajuste','Ajuste hecho por un viewer',0,5,0,'00000000-0000-0000-0000-00000cc00019'::uuid);
  -- H3: ¿puede PISAR el saldo directamente, sin ledger ni auditoría?
  UPDATE accounts SET balance = 0 WHERE id=current_setting('t.acc')::uuid;
  SELECT balance INTO v_bal FROM accounts WHERE id=current_setting('t.acc')::uuid;
  RESET ROLE;
  SELECT count(*) INTO n_after FROM account_movements WHERE account_id=current_setting('t.acc')::uuid;
  PERFORM pg_temp.assert(n_after-n_before=1, '[BUG] H2 un VIEWER escribe en el ledger de cuenta corriente');
  PERFORM pg_temp.assert(v_bal=0, '[BUG] H3 un VIEWER pisa accounts.balance directamente — sin ledger ni auditoría');
END $$;

-- H4: tras pisar el saldo, las DOS verdades divergen para siempre.
SELECT pg_temp.assert(pg_temp.bal(current_setting('t.acc')::uuid)
                   <> pg_temp.bal_ledger(current_setting('t.acc')::uuid),
  '[BUG] H4 accounts.balance y SUM(debit-credit) DIVERGEN — dos verdades del saldo');

-- H5: y la divergencia se PROPAGA: el trigger ancla en accounts.balance.
DO $$
DECLARE v_after numeric;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000cc00009';
  INSERT INTO account_movements (business_id, account_id, date, type, description, debit, credit, balance_after, created_by)
  VALUES ('00000000-0000-0000-0000-00000cc00001'::uuid, current_setting('t.acc')::uuid, public.ar_today(),
          'ajuste','Movimiento posterior',10,0,0,'00000000-0000-0000-0000-00000cc00009'::uuid)
  RETURNING balance_after INTO v_after;
  RESET ROLE;
  PERFORM pg_temp.assert(v_after=10,
    '[BUG] H5 el siguiente movimiento ancla en el saldo PISADO (10, no el real) — corrupción permanente');
END $$;

-- ════════════ I. Reversas ═══════════════════════════════════════════════════
SELECT pg_temp.assert(NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='reverse_customer_account_payment_atomic'),
  '[BUG] I1 NO existe RPC para revertir un cobro de cuenta corriente');
SELECT pg_temp.assert(EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='reverse_payment_allocation_atomic'),
  'I2 sí existe reversa de IMPUTACIÓN (no del cobro)');
-- El ledger es append-only para el cliente: no se puede borrar un cobro mal hecho.
DO $$
DECLARE v_err text := 'sin error';
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000cc00009';
  BEGIN
    DELETE FROM account_movements WHERE account_id=current_setting('t.acc')::uuid AND description='Doble click';
    IF NOT FOUND THEN v_err := 'sin permiso (0 filas)'; END IF;
  EXCEPTION WHEN OTHERS THEN v_err := SQLSTATE; END;
  RESET ROLE;
  RAISE NOTICE 'INFO I3 DELETE de un cobro por el cliente -> %', v_err;
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

ROLLBACK;
