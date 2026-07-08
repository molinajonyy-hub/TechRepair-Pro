-- ============================================================
-- M6 — reverse_operating_expense_atomic (reverso append-only de gasto operativo)
-- Net P&L 0, net caja 0, no borra filas, no toca caja cerrada, idempotente.
-- RUN: supabase db reset && docker cp ... && psql -f (tx + ROLLBACK)
-- ============================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set biz   '00000000-0000-0000-0000-0000000e6101'
\set owner '00000000-0000-0000-0000-0000000e6109'
\set bizB  '00000000-0000-0000-0000-0000000e6201'
\set ownB  '00000000-0000-0000-0000-0000000e6209'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'owner'),(:'ownB');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','ER A',:'owner'),(:'bizB','ER B',:'ownB');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES (:'biz',:'owner','owner',true),(:'bizB',:'ownB','owner',true);
INSERT INTO cajas(business_id,status,opened_by,usd_cotizacion_apertura) VALUES (:'biz','abierta',:'owner',1);
SET LOCAL session_replication_role='origin';

-- ── ER1: crear gasto operativo (alquiler 10000, efectivo) ──
DO $$
DECLARE r jsonb; v_caja uuid; v_exp uuid;
BEGIN
  SELECT id INTO v_caja FROM cajas WHERE business_id='00000000-0000-0000-0000-0000000e6101' AND status='abierta';
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e6109';
  r := create_expense_with_finance('00000000-0000-0000-0000-0000000e6101'::uuid,'00000000-0000-0000-0000-0000000e6109'::uuid,
        'Alquiler junio','Alquiler','alquiler','fixed_cost_local',10000,'efectivo','2026-06-20',false,NULL,NULL,v_caja);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'ER1a gasto operativo creado -> ok ('||COALESCE(r->>'error','')||')');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT COALESCE(SUM(amount_ars),0) FROM business_finance_entries WHERE business_id=:'biz' AND economic_class='operating_expense')=10000, 'ER1b BFE operating_expense = +10000');
SELECT pg_temp.assert((SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount_ars ELSE -amount_ars END),0) FROM financial_movements WHERE business_id=:'biz')=-10000, 'ER1c caja neta = -10000 (salida)');
SELECT pg_temp.assert(ROUND(COALESCE((SELECT SUM(operating_result) FROM v_finance_pnl WHERE business_id=:'biz'),0))=-10000, 'ER1d P&L: resultado operativo = -10000');

-- ── ER2: reversar ──
DO $$
DECLARE r jsonb; v_exp uuid;
BEGIN
  SELECT id INTO v_exp FROM expenses WHERE business_id='00000000-0000-0000-0000-0000000e6101' AND tipo='general' AND reversed_at IS NULL LIMIT 1;
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e6109';
  r := reverse_operating_expense_atomic('00000000-0000-0000-0000-0000000e6101'::uuid, v_exp, 'Cargado por error','00000000-0000-0000-0000-0000000e6109'::uuid,'rk1');
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean IS FALSE, 'ER2a reverso -> ok ('||COALESCE(r->>'error','')||')');
  -- replay
  r := reverse_operating_expense_atomic('00000000-0000-0000-0000-0000000e6101'::uuid, v_exp, 'Cargado por error','00000000-0000-0000-0000-0000000e6109'::uuid,'rk1');
  PERFORM pg_temp.assert((r->>'replay')::boolean, 'ER2b misma key -> replay');
  -- ya reversado (key nueva)
  r := reverse_operating_expense_atomic('00000000-0000-0000-0000-0000000e6101'::uuid, v_exp, 'otra vez','00000000-0000-0000-0000-0000000e6109'::uuid,'rk2');
  PERFORM pg_temp.assert(r->>'error' ILIKE '%ya fue reversado%', 'ER2c segundo reverso (key nueva) -> ya reversado');
  -- misma key rk1 payload distinto -> conflict
  r := reverse_operating_expense_atomic('00000000-0000-0000-0000-0000000e6101'::uuid, v_exp, 'motivo distinto','00000000-0000-0000-0000-0000000e6109'::uuid,'rk1');
  PERFORM pg_temp.assert(r->>'error'='IDEMPOTENCY_CONFLICT', 'ER2d misma key payload distinto -> conflict');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT COALESCE(SUM(amount_ars),0) FROM business_finance_entries WHERE business_id=:'biz' AND economic_class='operating_expense')=0, 'ER3 BFE original+reversa = 0 (net P&L)');
SELECT pg_temp.assert((SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount_ars ELSE -amount_ars END),0) FROM financial_movements WHERE business_id=:'biz')=0, 'ER4 FM original+reversa = 0 (caja compensada)');
SELECT pg_temp.assert(ROUND(COALESCE((SELECT SUM(operating_result) FROM v_finance_pnl WHERE business_id=:'biz'),0))=0, 'ER5 P&L vuelve a 0 (neto)');
SELECT pg_temp.assert((SELECT reversed_at FROM expenses WHERE business_id=:'biz' AND tipo='general') IS NOT NULL, 'ER6 gasto marcado reversado (NO borrado)');
SELECT pg_temp.assert((SELECT count(*) FROM expenses WHERE business_id=:'biz' AND tipo='general')=1, 'ER7 expenses NO se borró (append-only)');
SELECT pg_temp.assert((SELECT count(*) FROM operating_expense_reversals WHERE business_id=:'biz')=1, 'ER8 auditoría de reverso registrada');

-- ── ER9: motivo vacío + factura documental + cross-tenant ──
DO $$
DECLARE r jsonb; v_exp uuid; v_caja uuid;
BEGIN
  SELECT id INTO v_caja FROM cajas WHERE business_id='00000000-0000-0000-0000-0000000e6101' AND status='abierta';
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e6109';
  r := create_expense_with_finance('00000000-0000-0000-0000-0000000e6101'::uuid,'00000000-0000-0000-0000-0000000e6109'::uuid,
        'Luz','Operativos','otros','fixed_cost_local',3000,'efectivo','2026-06-21',false,NULL,NULL,v_caja);
  SELECT id INTO v_exp FROM expenses WHERE business_id='00000000-0000-0000-0000-0000000e6101' AND description='Luz' LIMIT 1;
  r := reverse_operating_expense_atomic('00000000-0000-0000-0000-0000000e6101'::uuid, v_exp, '  ','00000000-0000-0000-0000-0000000e6109'::uuid,NULL);
  PERFORM pg_temp.assert(r->>'error' ILIKE '%motivo%', 'ER9 motivo vacío -> rechazo');
  RESET ROLE;
END $$;

-- factura documental
SET LOCAL session_replication_role='replica';
INSERT INTO business_finance_entries(id,business_id,date,type,category,description,amount,currency,amount_ars,exchange_rate,source,economic_class)
  VALUES ('00000000-0000-0000-0000-0000000e6bfe',:'biz','2026-06-22','variable_cost','compras_proveedor','Factura X',5000,'ARS',5000,1,'pago_proveedor','supplier_liability_payment');
INSERT INTO expenses(id,business_id,description,category,amount,amount_ars,date,payment_method,currency,exchange_rate,created_by,tipo,finance_entry_id)
  VALUES ('00000000-0000-0000-0000-0000000e6fac',:'biz','Factura X','Proveedores',5000,5000,'2026-06-22','efectivo','ARS',1,:'owner','factura','00000000-0000-0000-0000-0000000e6bfe');
SET LOCAL session_replication_role='origin';
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e6109';
  r := reverse_operating_expense_atomic('00000000-0000-0000-0000-0000000e6101'::uuid, '00000000-0000-0000-0000-0000000e6fac'::uuid, 'x','00000000-0000-0000-0000-0000000e6109'::uuid,NULL);
  PERFORM pg_temp.assert(r->>'error' ILIKE '%factura pertenece a una compra/proveedor%', 'ER10 gasto documental factura -> bloqueado con mensaje');
  RESET ROLE;
  -- cross-tenant
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e6209';
  r := reverse_operating_expense_atomic('00000000-0000-0000-0000-0000000e6101'::uuid, '00000000-0000-0000-0000-0000000e6fac'::uuid, 'x','00000000-0000-0000-0000-0000000e6209'::uuid,NULL);
  PERFORM pg_temp.assert(r->>'error' ILIKE '%Sin acceso%', 'ER11 cross-tenant -> rechazo');
  RESET ROLE;
END $$;

-- ── ER12: gasto en caja cerrada — sin caja actual (efectivo) rechazo; con caja actual entra en la actual ──
DO $$
DECLARE r jsonb; v_caja uuid; v_exp uuid; v_newcaja uuid; v_revfm_caja uuid;
BEGIN
  SELECT id INTO v_caja FROM cajas WHERE business_id='00000000-0000-0000-0000-0000000e6101' AND status='abierta';
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e6109';
  r := create_expense_with_finance('00000000-0000-0000-0000-0000000e6101'::uuid,'00000000-0000-0000-0000-0000000e6109'::uuid,
        'Internet','Operativos','otros','fixed_cost_local',2000,'efectivo','2026-06-23',false,NULL,NULL,v_caja);
  RESET ROLE;
  -- resolver el id como postgres (la RLS de expenses usa current_business_id()/is_staff())
  SELECT id INTO v_exp FROM expenses WHERE business_id='00000000-0000-0000-0000-0000000e6101' AND description='Internet' LIMIT 1;
  -- cerrar la caja (directo, fixture)
  UPDATE cajas SET status='cerrada', closed_at=now() WHERE id=v_caja;
  -- sin caja abierta + efectivo -> rechazo
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e6109';
  r := reverse_operating_expense_atomic('00000000-0000-0000-0000-0000000e6101'::uuid, v_exp, 'reverso internet','00000000-0000-0000-0000-0000000e6109'::uuid,NULL);
  PERFORM pg_temp.assert(r->>'error' ILIKE '%caja abierta%', 'ER12 gasto en caja cerrada sin caja actual (efectivo) -> rechazo');
  RESET ROLE;
  -- abrir caja nueva
  SET LOCAL session_replication_role='replica';
  INSERT INTO cajas(id,business_id,status,opened_by,usd_cotizacion_apertura) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-0000000e6101','abierta','00000000-0000-0000-0000-0000000e6109',1);
  SET LOCAL session_replication_role='origin';
  SELECT id INTO v_newcaja FROM cajas WHERE business_id='00000000-0000-0000-0000-0000000e6101' AND status='abierta';
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e6109';
  r := reverse_operating_expense_atomic('00000000-0000-0000-0000-0000000e6101'::uuid, v_exp, 'reverso internet','00000000-0000-0000-0000-0000000e6109'::uuid,NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'ER13 caja cerrada + caja actual abierta -> reverso ok');
  RESET ROLE;
  SELECT caja_id INTO v_revfm_caja FROM financial_movements WHERE id=(r->>'reversal_financial_movement_id')::uuid;
  PERFORM pg_temp.assert(v_revfm_caja=v_newcaja, 'ER14 reversa entró en la caja ACTUAL abierta (no la cerrada)');
  PERFORM pg_temp.assert((SELECT status FROM cajas WHERE id=v_caja)='cerrada', 'ER15 la caja cerrada del gasto original quedó intacta');
END $$;

SELECT pg_temp.assert(true, '=== etapa6_expense_reversal_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
