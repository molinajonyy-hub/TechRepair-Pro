-- ============================================================
-- M6 — open/close_cash_session_atomic (apertura/cierre de caja por RPC)
-- Cierre recomputado server-side; caja cerrada inmutable; idempotente.
-- RUN: supabase db reset && docker cp ... && psql -f  (tx + ROLLBACK)
-- (:'var' no interpola dentro de DO $$…$$ → UUID literales ahí.)
-- ============================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set biz   '00000000-0000-0000-0000-0000000c5101'
\set owner '00000000-0000-0000-0000-0000000c5109'
\set bizB  '00000000-0000-0000-0000-0000000c5201'
\set ownB  '00000000-0000-0000-0000-0000000c5209'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'owner'),(:'ownB');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','CS A',:'owner'),(:'bizB','CS B',:'ownB');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES (:'biz',:'owner','owner',true),(:'bizB',:'ownB','owner',true);
SET LOCAL session_replication_role='origin';

-- ── CS1: apertura + idempotencia + anti-doble-abierta + otro negocio ──
DO $$
DECLARE r jsonb; v_caja uuid;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c5109';
  r := open_cash_session_atomic('00000000-0000-0000-0000-0000000c5101'::uuid,'00000000-0000-0000-0000-0000000c5109'::uuid, 1000,0,0,0, NULL,'ko1');
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean IS FALSE, 'CS1 abrir caja -> ok ('||COALESCE(r->>'error','')||')');
  v_caja := (r->>'caja_id')::uuid;
  r := open_cash_session_atomic('00000000-0000-0000-0000-0000000c5101'::uuid,'00000000-0000-0000-0000-0000000c5109'::uuid, 1000,0,0,0, NULL,'ko1');
  PERFORM pg_temp.assert((r->>'replay')::boolean AND (r->>'caja_id')::uuid=v_caja, 'CS2 misma key -> replay misma caja');
  r := open_cash_session_atomic('00000000-0000-0000-0000-0000000c5101'::uuid,'00000000-0000-0000-0000-0000000c5109'::uuid, 9999,0,0,0, NULL,'ko1');
  PERFORM pg_temp.assert(r->>'error'='IDEMPOTENCY_CONFLICT', 'CS3 misma key payload distinto -> conflict');
  r := open_cash_session_atomic('00000000-0000-0000-0000-0000000c5101'::uuid,'00000000-0000-0000-0000-0000000c5109'::uuid, 500,0,0,0, NULL,'ko2');
  PERFORM pg_temp.assert(r->>'error' ILIKE '%Ya hay una caja abierta%', 'CS4 segunda apertura (key nueva) -> rechazada (una sola caja)');
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c5209';
  r := open_cash_session_atomic('00000000-0000-0000-0000-0000000c5201'::uuid,'00000000-0000-0000-0000-0000000c5209'::uuid, 0,0,0,0, NULL,'kob');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'CS5 otro negocio abre su propia caja -> ok');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT count(*) FROM cajas WHERE business_id=:'biz' AND status='abierta')=1, 'CS6 exactamente 1 caja abierta en A');

-- ── Movimientos en la caja abierta de A (para esperados) ──
-- efectivo: +5000 income, -1000 expense = 4000 neto; transferencia +2000; usd +10 nativo
INSERT INTO financial_movements(business_id,date,type,currency,amount,amount_ars,exchange_rate,source,description,metodo_pago,created_by)
 VALUES (:'biz','2026-06-20','income','ARS',5000,5000,1,'manual','a','efectivo',:'owner'),
        (:'biz','2026-06-20','expense','ARS',1000,1000,1,'manual','b','efectivo',:'owner'),
        (:'biz','2026-06-20','income','ARS',2000,2000,1,'manual','c','transferencia',:'owner'),
        (:'biz','2026-06-20','income','USD',10,15000,1500,'manual','d','usd',:'owner');

-- ── CS cierre correcto (conteo exacto → diferencia 0) ──
DO $$
DECLARE r jsonb; v_caja uuid;
BEGIN
  SELECT id INTO v_caja FROM cajas WHERE business_id='00000000-0000-0000-0000-0000000c5101' AND status='abierta';
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c5109';
  -- esperado: efectivo 1000+5000-1000=5000; transf 2000; tarjeta 0; usd 10
  r := close_cash_session_atomic('00000000-0000-0000-0000-0000000c5101'::uuid,'00000000-0000-0000-0000-0000000c5109'::uuid, v_caja,
        5000,2000,0,10, NULL,'cierre ok','kc1');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'CS7 cierre correcto -> ok ('||COALESCE(r->>'error','')||')');
  PERFORM pg_temp.assert((r->'expected'->>'efectivo')::numeric=5000, 'CS8 expected efectivo server-side = 5000 (sign correcto: 1000+5000-1000)');
  PERFORM pg_temp.assert((r->'expected'->>'transferencia')::numeric=2000, 'CS9 transferencia NO contamina efectivo (=2000)');
  PERFORM pg_temp.assert((r->'expected'->>'usd')::numeric=10, 'CS10 USD contado nativo (=10)');
  PERFORM pg_temp.assert((r->>'total_difference')::numeric=0, 'CS11 conteo exacto -> diferencia 0');
  -- replay
  r := close_cash_session_atomic('00000000-0000-0000-0000-0000000c5101'::uuid,'00000000-0000-0000-0000-0000000c5109'::uuid, v_caja,
        5000,2000,0,10, NULL,'cierre ok','kc1');
  PERFORM pg_temp.assert((r->>'replay')::boolean, 'CS12 doble cierre misma key -> replay');
  -- segundo cierre key nueva -> ya cerrada
  r := close_cash_session_atomic('00000000-0000-0000-0000-0000000c5101'::uuid,'00000000-0000-0000-0000-0000000c5109'::uuid, v_caja,
        1,0,0,0, NULL,NULL,'kc2');
  PERFORM pg_temp.assert(r->>'error' ILIKE '%ya está cerrada%', 'CS13 cerrar caja ya cerrada -> rechazo');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT status FROM cajas WHERE business_id=:'biz' AND efectivo_cierre=5000)='cerrada', 'CS14 caja marcada cerrada con snapshot (efectivo_cierre=5000)');

-- ── CS12: movimiento posterior a caja cerrada -> rechazo (guard) ──
DO $$
DECLARE v_caja uuid; v_err text := '';
BEGIN
  SELECT id INTO v_caja FROM cajas WHERE business_id='00000000-0000-0000-0000-0000000c5101' AND status='cerrada' LIMIT 1;
  BEGIN
    INSERT INTO financial_movements(business_id,date,type,currency,amount,amount_ars,exchange_rate,source,description,metodo_pago,caja_id,created_by)
      VALUES ('00000000-0000-0000-0000-0000000c5101','2026-06-25','income','ARS',100,100,1,'manual','tarde','efectivo',v_caja,'00000000-0000-0000-0000-0000000c5109');
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.assert(v_err ILIKE '%caja cerrada%', 'CS15 movimiento en caja cerrada -> rechazado por guard');
END $$;

-- ── CS cross-tenant close + caja cerrada conserva totales ──
DO $$
DECLARE r jsonb; v_cajaA uuid; v_cierreA numeric;
BEGIN
  SELECT id, efectivo_cierre INTO v_cajaA, v_cierreA FROM cajas WHERE business_id='00000000-0000-0000-0000-0000000c5101' AND status='cerrada' LIMIT 1;
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c5209';  -- owner B intenta cerrar caja de A
  r := close_cash_session_atomic('00000000-0000-0000-0000-0000000c5101'::uuid,'00000000-0000-0000-0000-0000000c5209'::uuid, v_cajaA, 0,0,0,0, NULL,NULL,'kx');
  PERFORM pg_temp.assert(r->>'error' ILIKE '%Sin acceso%', 'CS16 cerrar caja de otro negocio -> rechazo');
  RESET ROLE;
  -- abrir nueva caja en A y verificar que la caja cerrada conserva su snapshot
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c5109';
  r := open_cash_session_atomic('00000000-0000-0000-0000-0000000c5101'::uuid,'00000000-0000-0000-0000-0000000c5109'::uuid, 500,0,0,0, NULL,'ko3');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'CS17 reabrir caja en A tras cierre -> ok');
  RESET ROLE;
  PERFORM pg_temp.assert((SELECT efectivo_cierre FROM cajas WHERE id=v_cajaA)=v_cierreA, 'CS18 caja cerrada conserva su snapshot pese a nueva caja');
END $$;

-- ── CS diferencia: cierre con conteo distinto ──
INSERT INTO financial_movements(business_id,date,type,currency,amount,amount_ars,exchange_rate,source,description,metodo_pago,created_by)
 VALUES (:'biz','2026-06-26','income','ARS',3000,3000,1,'manual','e','efectivo',:'owner');
DO $$
DECLARE r jsonb; v_caja uuid;
BEGIN
  SELECT id INTO v_caja FROM cajas WHERE business_id='00000000-0000-0000-0000-0000000c5101' AND status='abierta';
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c5109';
  -- esperado efectivo = 500 + 3000 = 3500; conteo 3400 -> diff -100
  r := close_cash_session_atomic('00000000-0000-0000-0000-0000000c5101'::uuid,'00000000-0000-0000-0000-0000000c5109'::uuid, v_caja,
        3400,0,0,0, NULL,'con faltante','kc3');
  PERFORM pg_temp.assert((r->'expected'->>'efectivo')::numeric=3500, 'CS19 expected efectivo (500+3000) = 3500');
  PERFORM pg_temp.assert((r->>'total_difference')::numeric=-100, 'CS20 cierre con diferencia -> -100');
  RESET ROLE;
END $$;

SELECT pg_temp.assert(true, '=== etapa6_cash_sessions_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
