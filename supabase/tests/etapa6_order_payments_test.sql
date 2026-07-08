-- ============================================================
-- M6 — create/reverse_order_payment_atomic (pagos de orden)
-- USD correcto, mirror excluido del P&L, reverso append-only, idempotente.
-- RUN: supabase db reset && docker cp ... && psql -f (tx + ROLLBACK)
-- ============================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set biz   '00000000-0000-0000-0000-0000000d6101'
\set owner '00000000-0000-0000-0000-0000000d6109'
\set bizB  '00000000-0000-0000-0000-0000000d6201'
\set ownB  '00000000-0000-0000-0000-0000000d6209'
\set ord   '00000000-0000-0000-0000-0000000d6d01'
\set ordR  '00000000-0000-0000-0000-0000000d6d02'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'owner'),(:'ownB');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','OP A',:'owner'),(:'bizB','OP B',:'ownB');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES (:'biz',:'owner','owner',true),(:'bizB',:'ownB','owner',true);
INSERT INTO cajas(business_id,status,opened_by,usd_cotizacion_apertura) VALUES (:'biz','abierta',:'owner',1);
INSERT INTO orders(id,business_id,status) VALUES (:'ord',:'biz','repair'),(:'ordR',:'biz','repair');
SET LOCAL session_replication_role='origin';

-- ── OP1..OP10: creación ──
DO $$
DECLARE r jsonb; v_pay uuid;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000d6109';
  -- OP1 ARS efectivo con caja
  r := create_order_payment_atomic('00000000-0000-0000-0000-0000000d6101'::uuid,'00000000-0000-0000-0000-0000000d6d01'::uuid,5000,'cash','ARS',1,'00000000-0000-0000-0000-0000000d6109'::uuid,NULL,'2026-06-20','opk1');
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean IS FALSE, 'OP1 pago ARS efectivo -> ok ('||COALESCE(r->>'error','')||')');
  -- replay
  r := create_order_payment_atomic('00000000-0000-0000-0000-0000000d6101'::uuid,'00000000-0000-0000-0000-0000000d6d01'::uuid,5000,'cash','ARS',1,'00000000-0000-0000-0000-0000000d6109'::uuid,NULL,'2026-06-20','opk1');
  PERFORM pg_temp.assert((r->>'replay')::boolean, 'OP5 replay misma key');
  -- conflict
  r := create_order_payment_atomic('00000000-0000-0000-0000-0000000d6101'::uuid,'00000000-0000-0000-0000-0000000d6d01'::uuid,9999,'cash','ARS',1,'00000000-0000-0000-0000-0000000d6109'::uuid,NULL,'2026-06-20','opk1');
  PERFORM pg_temp.assert(r->>'error'='IDEMPOTENCY_CONFLICT', 'OP6 misma key payload distinto -> conflict');
  -- OP2 transferencia (sin caja necesaria)
  r := create_order_payment_atomic('00000000-0000-0000-0000-0000000d6101'::uuid,'00000000-0000-0000-0000-0000000d6d01'::uuid,3000,'transfer','ARS',1,'00000000-0000-0000-0000-0000000d6109'::uuid,NULL,'2026-06-20','opk2');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'OP2 pago transferencia -> ok');
  -- OP3 USD con TC 1500 amount 100
  r := create_order_payment_atomic('00000000-0000-0000-0000-0000000d6101'::uuid,'00000000-0000-0000-0000-0000000d6d01'::uuid,100,'cash','USD',1500,'00000000-0000-0000-0000-0000000d6109'::uuid,NULL,'2026-06-20','opk3');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'OP3 pago USD -> ok');
  RESET ROLE;
END $$;
-- OP4 a nivel top (postgres, sin RLS): USD amount_ars correcto (no 1:1)
SELECT pg_temp.assert((SELECT amount_ars FROM order_payments WHERE order_id=:'ord' AND currency='USD')=150000, 'OP4 USD amount_ars = 100*1500 = 150000');
SELECT pg_temp.assert((SELECT fm.amount_ars FROM order_payments op JOIN financial_movements fm ON fm.id=op.financial_movement_id WHERE op.order_id=:'ord' AND op.currency='USD')=150000, 'OP4b FM USD amount_ars = 150000 (no 1:1)');
SELECT pg_temp.assert((SELECT count(*) FROM order_payments WHERE order_id=:'ord')=3, 'OP7 replay/conflict no duplicó: 3 pagos (efectivo, transfer, usd)');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'biz' AND economic_class<>'revenue_collection_mirror')=0, 'OP26 BFE de pagos = revenue_collection_mirror (P&L no contaminado)');
SELECT pg_temp.assert(COALESCE((SELECT SUM(net_sales) FROM v_finance_pnl WHERE business_id=:'biz'),0)=0, 'OP26b net_sales sigue 0 (cobro no es venta nueva)');

-- OP8/OP9/OP10
UPDATE cajas SET status='cerrada' WHERE business_id=:'biz';
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000d6109';
  r := create_order_payment_atomic('00000000-0000-0000-0000-0000000d6101'::uuid,'00000000-0000-0000-0000-0000000d6d01'::uuid,1000,'cash','ARS',1,'00000000-0000-0000-0000-0000000d6109'::uuid,NULL,NULL,NULL);
  PERFORM pg_temp.assert(r->>'error' ILIKE '%caja abierta%', 'OP8 efectivo sin caja -> rechazo');
  r := create_order_payment_atomic('00000000-0000-0000-0000-0000000d6101'::uuid,'00000000-0000-0000-0000-0000000d6d01'::uuid,1000,'transfer','ARS',1,'00000000-0000-0000-0000-0000000d6109'::uuid,NULL,NULL,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'OP9 transferencia sin caja -> ok');
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000d6209';
  r := create_order_payment_atomic('00000000-0000-0000-0000-0000000d6101'::uuid,'00000000-0000-0000-0000-0000000d6d01'::uuid,1000,'transfer','ARS',1,'00000000-0000-0000-0000-0000000d6209'::uuid,NULL,NULL,NULL);
  PERFORM pg_temp.assert(r->>'error' ILIKE '%Sin acceso%', 'OP10 cross-tenant -> rechazo');
  RESET ROLE;
END $$;

-- ── OP11..OP20: reverso (orden dedicada, caja nueva) ──
INSERT INTO cajas(business_id,status,opened_by,usd_cotizacion_apertura) SELECT :'biz','abierta',:'owner',1;
DO $$
DECLARE r jsonb; v_pay uuid;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000d6109';
  r := create_order_payment_atomic('00000000-0000-0000-0000-0000000d6101'::uuid,'00000000-0000-0000-0000-0000000d6d02'::uuid,7000,'cash','ARS',1,'00000000-0000-0000-0000-0000000d6109'::uuid,NULL,NULL,'opk10');
  v_pay := (r->>'order_payment_id')::uuid;
  -- motivo vacío
  r := reverse_order_payment_atomic('00000000-0000-0000-0000-0000000d6101'::uuid, v_pay, '  ','00000000-0000-0000-0000-0000000d6109'::uuid,NULL);
  PERFORM pg_temp.assert(r->>'error' ILIKE '%motivo%', 'OP20 motivo vacío -> rechazo');
  -- reversar ok
  r := reverse_order_payment_atomic('00000000-0000-0000-0000-0000000d6101'::uuid, v_pay, 'devolución','00000000-0000-0000-0000-0000000d6109'::uuid,'rvk1');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'OP11 reverso -> ok ('||COALESCE(r->>'error','')||')');
  -- replay
  r := reverse_order_payment_atomic('00000000-0000-0000-0000-0000000d6101'::uuid, v_pay, 'devolución','00000000-0000-0000-0000-0000000d6109'::uuid,'rvk1');
  PERFORM pg_temp.assert((r->>'replay')::boolean, 'OP14 reverso replay misma key');
  -- ya reversado key nueva
  r := reverse_order_payment_atomic('00000000-0000-0000-0000-0000000d6101'::uuid, v_pay, 'otra','00000000-0000-0000-0000-0000000d6109'::uuid,'rvk2');
  PERFORM pg_temp.assert(r->>'error' ILIKE '%ya fue reversado%', 'OP15 segundo reverso (key nueva) -> ya reversado');
  -- misma key rvk1 payload distinto -> conflict
  r := reverse_order_payment_atomic('00000000-0000-0000-0000-0000000d6101'::uuid, v_pay, 'motivo x','00000000-0000-0000-0000-0000000d6109'::uuid,'rvk1');
  PERFORM pg_temp.assert(r->>'error'='IDEMPOTENCY_CONFLICT', 'OP16 misma key reverso payload distinto -> conflict');
  RESET ROLE;
END $$;
-- net 0 sobre la orden ordR (pago 7000 income + reverso 7000 expense)
SELECT pg_temp.assert((SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount_ars ELSE -amount_ars END),0) FROM financial_movements WHERE reference_id IN (SELECT id FROM order_payments WHERE order_id=:'ordR') OR reference_id=:'ordR')=0, 'OP12 FM neto de la orden reversada = 0');
SELECT pg_temp.assert((SELECT COALESCE(SUM(amount_ars),0) FROM business_finance_entries WHERE business_id=:'biz' AND reference_order_id=:'ordR')=0, 'OP13 BFE mirror de la orden reversada = 0');
SELECT pg_temp.assert((SELECT reversed_at FROM order_payments WHERE order_id=:'ordR') IS NOT NULL, 'OP23a pago marcado reversado (NO borrado)');
SELECT pg_temp.assert((SELECT count(*) FROM order_payments WHERE order_id=:'ordR')=1, 'OP23 order_payments NO borrado (append-only)');
SELECT pg_temp.assert((SELECT count(*) FROM order_payment_reversals WHERE business_id=:'biz')=1, 'OP-audit reverso registrado');
-- huérfanos: todo FM/BFE de reversa referencia algo
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'biz' AND source='reversal' AND reference_id IS NULL)=0, 'OP21 sin FM huérfanos');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'biz' AND source='reversal' AND reference_order_id IS NULL)=0, 'OP22 sin BFE huérfanos');

SELECT pg_temp.assert(true, '=== etapa6_order_payments_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
