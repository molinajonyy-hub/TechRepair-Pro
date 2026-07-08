-- ============================================================
-- M6 — record_customer_account_payment_atomic (cobro CC cliente)
-- Cobrar deuda: sube caja, baja CxC, P&L intacto; atómico + idempotente.
-- RUN: supabase db reset && docker cp ... && psql -f  (tx + ROLLBACK)
-- (Los :'var' de psql NO interpolan dentro de DO $$…$$ → UUID literales ahí.)
-- ============================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set biz   '00000000-0000-0000-0000-0000000c6101'
\set owner '00000000-0000-0000-0000-0000000c6109'
\set bizB  '00000000-0000-0000-0000-0000000c6201'
\set ownB  '00000000-0000-0000-0000-0000000c6209'
\set acct  '00000000-0000-0000-0000-0000000c6d01'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'owner'),(:'ownB');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','AC A',:'owner'),(:'bizB','AC B',:'ownB');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES (:'biz',:'owner','owner',true),(:'bizB',:'ownB','owner',true);
INSERT INTO cajas(business_id,status,opened_by) VALUES (:'biz','abierta',:'owner');
INSERT INTO accounts(id,business_id,type,entity_id,entity_name,balance) VALUES (:'acct',:'biz','cliente',:'owner','Cliente X',0);
SET LOCAL session_replication_role='origin';

-- Deuda inicial 10000 (venta a CC) — el trigger calcula balance_after.
INSERT INTO account_movements(business_id,account_id,date,type,description,debit,credit,balance_after)
  VALUES (:'biz',:'acct','2026-06-20','venta','Venta a crédito',10000,0,0);
SELECT pg_temp.assert((SELECT COALESCE(SUM(debit-credit),0) FROM account_movements WHERE account_id=:'acct')=10000, 'AC0 deuda inicial = 10000');

-- ── AC1: cobro parcial efectivo con caja (key K1) ──
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c6109';
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-0000000c6101'::uuid,'00000000-0000-0000-0000-0000000c6d01'::uuid,
        4000,'Cobro parcial','00000000-0000-0000-0000-0000000c6109'::uuid,'efectivo','2026-06-21',NULL,'k1');
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean IS FALSE, 'AC1a cobro parcial -> ok ('||COALESCE(r->>'error','')||')');
  -- replay mismo payload
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-0000000c6101'::uuid,'00000000-0000-0000-0000-0000000c6d01'::uuid,
        4000,'Cobro parcial','00000000-0000-0000-0000-0000000c6109'::uuid,'efectivo','2026-06-21',NULL,'k1');
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean, 'AC1b mismo payload -> replay');
  -- conflicto payload distinto
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-0000000c6101'::uuid,'00000000-0000-0000-0000-0000000c6d01'::uuid,
        5000,'Cobro parcial','00000000-0000-0000-0000-0000000c6109'::uuid,'efectivo','2026-06-21',NULL,'k1');
  PERFORM pg_temp.assert(r->>'error'='IDEMPOTENCY_CONFLICT', 'AC1c payload distinto -> IDEMPOTENCY_CONFLICT');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT COALESCE(SUM(debit-credit),0) FROM account_movements WHERE account_id=:'acct')=6000, 'AC1d CxC baja 10000->6000 (una vez)');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'biz' AND type='income')=1, 'AC1e caja: exactamente 1 FM income (replay no duplica)');
SELECT pg_temp.assert((SELECT COALESCE(SUM(amount_ars),0) FROM financial_movements WHERE business_id=:'biz' AND type='income')=4000, 'AC1f caja sube = 4000 (cobrado)');
SELECT pg_temp.assert((SELECT economic_class FROM business_finance_entries WHERE business_id=:'biz')='revenue_collection_mirror', 'AC1g BFE clasificado revenue_collection_mirror');
SELECT pg_temp.assert(COALESCE((SELECT SUM(net_sales) FROM v_finance_pnl WHERE business_id=:'biz'),0)=0, 'AC1h P&L intacto: net_sales sigue 0 (no reconoce venta)');
SELECT pg_temp.assert(COALESCE((SELECT SUM(operating_result) FROM v_finance_pnl WHERE business_id=:'biz'),0)=0, 'AC1i P&L intacto: resultado operativo sigue 0');

-- ── AC2: cobro total del saldo (6000) ──
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c6109';
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-0000000c6101'::uuid,'00000000-0000-0000-0000-0000000c6d01'::uuid,
        6000,'Cobro total','00000000-0000-0000-0000-0000000c6109'::uuid,'transferencia','2026-06-22',NULL,'k2');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'AC2a cobro total (transferencia, sin exigir caja) -> ok');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT COALESCE(SUM(debit-credit),0) FROM account_movements WHERE account_id=:'acct')=0, 'AC2b CxC saldada (0)');

-- ── AC3: sobrepago rechazado (deuda ya 0) ──
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c6109';
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-0000000c6101'::uuid,'00000000-0000-0000-0000-0000000c6d01'::uuid,
        1000,'Sobrepago','00000000-0000-0000-0000-0000000c6109'::uuid,'efectivo','2026-06-23',NULL,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean IS NOT TRUE AND r->>'error' ILIKE '%supera la deuda%', 'AC3 sobrepago -> rechazado');
  RESET ROLE;
END $$;

-- ── AC4: cross-tenant rechazado ──
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c6209';
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-0000000c6101'::uuid,'00000000-0000-0000-0000-0000000c6d01'::uuid,
        100,'x','00000000-0000-0000-0000-0000000c6209'::uuid,'efectivo','2026-06-23',NULL,NULL);
  PERFORM pg_temp.assert(r->>'error' ILIKE '%Sin acceso%', 'AC4 cross-tenant -> Sin acceso');
  RESET ROLE;
END $$;

-- ── AC5: efectivo sin caja abierta -> rechazado ──
UPDATE cajas SET status='cerrada' WHERE business_id=:'biz';
-- nueva deuda para poder intentar cobrar
INSERT INTO account_movements(business_id,account_id,date,type,description,debit,credit,balance_after)
  VALUES (:'biz',:'acct','2026-06-24','venta','Otra venta',2000,0,0);
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c6109';
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-0000000c6101'::uuid,'00000000-0000-0000-0000-0000000c6d01'::uuid,
        500,'Cobro sin caja','00000000-0000-0000-0000-0000000c6109'::uuid,'efectivo','2026-06-24',NULL,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean IS NOT TRUE AND r->>'error' ILIKE '%caja abierta%', 'AC5 efectivo sin caja -> rechazado');
  -- misma deuda con transferencia SÍ permite (no requiere caja)
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-0000000c6101'::uuid,'00000000-0000-0000-0000-0000000c6d01'::uuid,
        500,'Cobro transferencia','00000000-0000-0000-0000-0000000c6109'::uuid,'transferencia','2026-06-24',NULL,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'AC5b transferencia sin caja -> ok');
  RESET ROLE;
END $$;

SELECT pg_temp.assert(true, '=== etapa6_account_payments_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
