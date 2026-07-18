-- ============================================================
-- M6 — replace_comprobante_payment (compensación append-only + comisiones)
-- Sin comisiones huérfanas, sin doble caja, sin tocar COGS/venta ni caja cerrada.
-- RUN: supabase db reset && docker cp ... && psql -f (tx + ROLLBACK)
-- ============================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set biz   '00000000-0000-0000-0000-0000000c8101'
\set owner '00000000-0000-0000-0000-0000000c8109'
\set bizB  '00000000-0000-0000-0000-0000000c8201'
\set ownB  '00000000-0000-0000-0000-0000000c8209'
\set c1    '00000000-0000-0000-0000-0000000c8a01'
\set c2    '00000000-0000-0000-0000-0000000c8a02'
\set c3    '00000000-0000-0000-0000-0000000c8a03'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'owner'),(:'ownB');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','RC A',:'owner'),(:'bizB','RC B',:'ownB');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES (:'biz',:'owner','owner',true),(:'bizB',:'ownB','owner',true);
INSERT INTO cajas(business_id,status,opened_by,usd_cotizacion_apertura) VALUES (:'biz','abierta',:'owner',1);
INSERT INTO comprobantes(id,business_id,tipo,total,estado_fiscal) VALUES (:'c1',:'biz','factura_c',10000,'no_fiscal'),(:'c2',:'biz','factura_c',10000,'no_fiscal'),(:'c3',:'biz','factura_c',5000,'no_fiscal');
SET LOCAL session_replication_role='origin';

-- Pagos iniciales (trigger crea FM income + BFE mirror + BFE comisión)
INSERT INTO comprobante_payments(comprobante_id,business_id,amount,currency,amount_ars,exchange_rate,payment_method,commission_amount,date,created_by)
  VALUES (:'c1',:'biz',10000,'ARS',10000,1,'efectivo',0,'2026-06-20',:'owner'),
         (:'c2',:'biz',10000,'ARS',10000,1,'tarjeta_credito',500,'2026-06-20',:'owner');

SELECT pg_temp.assert((SELECT COALESCE(SUM(amount_ars),0) FROM business_finance_entries WHERE reference_comprobante_id=:'c2' AND economic_class='payment_fee')=500, 'RC0 comisión inicial C2 payment_fee = 500');

-- ── RC1: C1 efectivo sin comisión → reemplazar por transferencia ──
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c8109';
  r := replace_comprobante_payment('00000000-0000-0000-0000-0000000c8a01'::uuid,'00000000-0000-0000-0000-0000000c8101'::uuid,'transferencia',10000,10000,'ARS',1,NULL,'00000000-0000-0000-0000-0000000c8109'::uuid,0,NULL,'rck1');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'RC1 reemplazar efectivo->transferencia -> ok ('||COALESCE(r->>'error','')||')');
  RESET ROLE;
END $$;
-- M7 6F.3 (append-only): la fila original YA NO se borra -> se conserva marcada
-- como reemplazada. Solo cuenta el conjunto VIVO (replaced_at IS NULL).
SELECT pg_temp.assert((SELECT count(*) FROM comprobante_payments WHERE comprobante_id=:'c1' AND replaced_at IS NULL)=1, 'RC1b un solo pago vigente (transferencia)');
SELECT pg_temp.assert((SELECT payment_method FROM comprobante_payments WHERE comprobante_id=:'c1' AND replaced_at IS NULL)='transferencia', 'RC1c pago vigente = transferencia');
SELECT pg_temp.assert((SELECT count(*) FROM comprobante_payments WHERE comprobante_id=:'c1')=2, 'RC1b2 append-only: el pago original se conserva (2 filas: 1 reemplazada + 1 viva)');
SELECT pg_temp.assert((SELECT payment_method FROM comprobante_payments WHERE comprobante_id=:'c1' AND replaced_at IS NOT NULL)='efectivo', 'RC1b3 la fila reemplazada conserva su metodo original (efectivo)');
SELECT pg_temp.assert((SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount_ars ELSE -amount_ars END),0) FROM financial_movements WHERE comprobante_id=:'c1')=10000, 'RC1d caja neta C1 = 10000 (reverso + nuevo)');
SELECT pg_temp.assert((SELECT COALESCE(SUM(amount_ars),0) FROM business_finance_entries WHERE reference_comprobante_id=:'c1' AND economic_class='revenue_collection_mirror')=10000, 'RC1e income-mirror neto = 10000');

-- ── RC2: C2 tarjeta con comisión → reemplazar por efectivo (sin comisión) ──
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c8109';
  r := replace_comprobante_payment('00000000-0000-0000-0000-0000000c8a02'::uuid,'00000000-0000-0000-0000-0000000c8101'::uuid,'efectivo',10000,10000,'ARS',1,NULL,'00000000-0000-0000-0000-0000000c8109'::uuid,0,NULL,'rck2');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'RC2 reemplazar tarjeta(comisión)->efectivo -> ok');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT COALESCE(SUM(amount_ars),0) FROM business_finance_entries WHERE reference_comprobante_id=:'c2' AND economic_class='payment_fee')=0, 'RC4 comisión anterior neteada a 0 (payment_fee net 0)');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE reference_comprobante_id=:'c2' AND category='comisiones_cobro' AND source='comprobante' AND reversed_at IS NULL)=0, 'RC20 sin comisión huérfana viva');
SELECT pg_temp.assert((SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount_ars ELSE -amount_ars END),0) FROM financial_movements WHERE comprobante_id=:'c2')=10000, 'RC6 caja neta C2 = 10000');

-- ── RC3: reemplazar C2 por tarjeta CON nueva comisión 300 → payment_fee neto 300 ──
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c8109';
  r := replace_comprobante_payment('00000000-0000-0000-0000-0000000c8a02'::uuid,'00000000-0000-0000-0000-0000000c8101'::uuid,'tarjeta_credito',10000,10000,'ARS',1,NULL,'00000000-0000-0000-0000-0000000c8109'::uuid,300,'visa','rck3');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'RC3 reemplazar por tarjeta con comisión 300 -> ok');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT COALESCE(SUM(amount_ars),0) FROM business_finance_entries WHERE reference_comprobante_id=:'c2' AND economic_class='payment_fee')=300, 'RC5 nueva comisión = 300 (creada una vez, neto 300)');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE reference_comprobante_id=:'c2' AND category='comisiones_cobro' AND source='comprobante' AND reversed_at IS NULL)=1, 'RC5b exactamente 1 comisión viva');
-- P&L: net_sales sin tocar (viene de items); payment_fee refleja 300
SELECT pg_temp.assert(COALESCE((SELECT SUM(net_sales) FROM v_finance_pnl WHERE business_id=:'biz'),0)=0, 'RC10 net_sales sigue 0 (venta devengada intacta)');
SELECT pg_temp.assert(ROUND(COALESCE((SELECT SUM(payment_fees) FROM v_finance_pnl WHERE business_id=:'biz'),0))=300, 'RC22 v_finance_pnl payment_fees neto = 300');

-- ── RC idempotencia + conflict + cross-tenant ──
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c8109';
  r := replace_comprobante_payment('00000000-0000-0000-0000-0000000c8a01'::uuid,'00000000-0000-0000-0000-0000000c8101'::uuid,'transferencia',10000,10000,'ARS',1,NULL,'00000000-0000-0000-0000-0000000c8109'::uuid,0,NULL,'rck1');
  PERFORM pg_temp.assert((r->>'replay')::boolean, 'RC15 replay misma key -> no duplica');
  r := replace_comprobante_payment('00000000-0000-0000-0000-0000000c8a01'::uuid,'00000000-0000-0000-0000-0000000c8101'::uuid,'efectivo',9999,9999,'ARS',1,NULL,'00000000-0000-0000-0000-0000000c8109'::uuid,0,NULL,'rck1');
  PERFORM pg_temp.assert(r->>'error'='IDEMPOTENCY_CONFLICT', 'RC16 misma key payload distinto -> conflict');
  RESET ROLE;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c8209';
  r := replace_comprobante_payment('00000000-0000-0000-0000-0000000c8a01'::uuid,'00000000-0000-0000-0000-0000000c8101'::uuid,'efectivo',10000,10000,'ARS',1,NULL,'00000000-0000-0000-0000-0000000c8209'::uuid,0,NULL,NULL);
  PERFORM pg_temp.assert(r->>'error' ILIKE '%Sin acceso%', 'RC17 cross-tenant -> rechazo');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT count(*) FROM comprobante_payments WHERE comprobante_id=:'c1' AND replaced_at IS NULL)=1, 'RC15b replay no duplicó pagos vigentes de C1');

-- ── RC caja cerrada: C3 efectivo, cerrar caja, abrir nueva, reemplazar ──
INSERT INTO comprobante_payments(comprobante_id,business_id,amount,currency,amount_ars,exchange_rate,payment_method,commission_amount,date,created_by)
  VALUES (:'c3',:'biz',5000,'ARS',5000,1,'efectivo',0,'2026-06-21',:'owner');
DO $$
DECLARE r jsonb; v_caja1 uuid; v_amt1 numeric; v_newcaja uuid; v_rev_caja uuid;
BEGIN
  SELECT caja_id INTO v_caja1 FROM financial_movements WHERE comprobante_id='00000000-0000-0000-0000-0000000c8a03' AND type='income';
  SELECT SUM(amount_ars) INTO v_amt1 FROM financial_movements WHERE caja_id=v_caja1;
  -- cerrar todas las cajas
  UPDATE cajas SET status='cerrada' WHERE business_id='00000000-0000-0000-0000-0000000c8101';
  -- RC14: efectivo sin caja abierta -> rechazo
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c8109';
  r := replace_comprobante_payment('00000000-0000-0000-0000-0000000c8a03'::uuid,'00000000-0000-0000-0000-0000000c8101'::uuid,'efectivo',5000,5000,'ARS',1,NULL,'00000000-0000-0000-0000-0000000c8109'::uuid,0,NULL,NULL);
  PERFORM pg_temp.assert(r->>'error' ILIKE '%caja abierta%', 'RC14 reemplazo efectivo sin caja abierta -> rechazo');
  RESET ROLE;
  -- abrir caja nueva
  SET LOCAL session_replication_role='replica';
  INSERT INTO cajas(id,business_id,status,opened_by,usd_cotizacion_apertura) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-0000000c8101','abierta','00000000-0000-0000-0000-0000000c8109',1);
  SET LOCAL session_replication_role='origin';
  SELECT id INTO v_newcaja FROM cajas WHERE business_id='00000000-0000-0000-0000-0000000c8101' AND status='abierta';
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c8109';
  r := replace_comprobante_payment('00000000-0000-0000-0000-0000000c8a03'::uuid,'00000000-0000-0000-0000-0000000c8101'::uuid,'efectivo',5000,5000,'ARS',1,NULL,'00000000-0000-0000-0000-0000000c8109'::uuid,0,NULL,'rck9');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'RC13 reemplazo con caja actual abierta -> ok');
  RESET ROLE;
  -- caja cerrada original conserva su total (el reverso NO entró ahí)
  PERFORM pg_temp.assert((SELECT SUM(amount_ars) FROM financial_movements WHERE caja_id=v_caja1)=v_amt1, 'RC12 caja cerrada original NO modificada (total intacto)');
  SELECT caja_id INTO v_rev_caja FROM financial_movements WHERE comprobante_id='00000000-0000-0000-0000-0000000c8a03' AND source='reversal' LIMIT 1;
  PERFORM pg_temp.assert(v_rev_caja=v_newcaja, 'RC13b reverso entró en la caja ACTUAL (no la cerrada)');
END $$;

SELECT pg_temp.assert(true, '=== etapa6_replace_comprobante_payment_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
