-- ============================================================
-- M6 — Bloqueo de pagos proveedor (Fase 7, decisión: bloqueo)
-- DELETE/UPDATE directo de supplier_payments/supplier_account_movements
-- bloqueado por RLS; RPCs legítimas siguen funcionando; delete safe solo casos
-- seguros. RUN: supabase db reset && docker cp ... && psql -f (tx + ROLLBACK)
-- ============================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set biz   '00000000-0000-0000-0000-0000000f7101'
\set owner '00000000-0000-0000-0000-0000000f7109'
\set prod  '00000000-0000-0000-0000-0000000f7d01'
\set sup   '00000000-0000-0000-0000-0000000f7501'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'owner');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','SPL A',:'owner');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES (:'biz',:'owner','owner',true);
INSERT INTO inventory(id,business_id,name,code,category,stock_quantity,stock,cost_price,sale_price,base_currency,is_active)
  VALUES (:'prod',:'biz','Prod SPL','SPL-1','Rep',10,10,600,1000,'ARS',true);
INSERT INTO suppliers(id,business_id,name,active) VALUES (:'sup',:'biz','Prov SPL',true);
-- M7 6D.1a: un pago en efectivo exige caja abierta -> se abre una para el contado de SPL5.
INSERT INTO cajas(business_id,opened_by,status) VALUES (:'biz',:'owner','abierta');
SET LOCAL session_replication_role='origin';

-- Compra pagada (contado) → crea supplier_payment + supplier_account_movements
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f7109';
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000000f7101'::uuid,'00000000-0000-0000-0000-0000000f7501'::uuid,
        '00000000-0000-0000-0000-0000000f7109'::uuid,'Prov SPL','2026-06-20','FC-1',5000,5000,'efectivo','x',
        jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-0000000f7d01','product_name','Prod SPL','quantity',5,'unit_cost',1000)),'spk1');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'SPL5 RPC create_supplier_purchase_atomic sigue funcionando -> ok ('||COALESCE(r->>'error','')||')');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT count(*) FROM supplier_payments WHERE business_id=:'biz')=1, 'SPL5b pago proveedor creado por RPC');

-- Intentos de DELETE/UPDATE directo bajo authenticated (deben quedar bloqueados)
DO $$
DECLARE v_pay uuid; v_mov uuid; v_amt numeric;
BEGIN
  SELECT id INTO v_pay FROM supplier_payments WHERE business_id='00000000-0000-0000-0000-0000000f7101' LIMIT 1;
  SELECT id INTO v_mov FROM supplier_account_movements WHERE business_id='00000000-0000-0000-0000-0000000f7101' AND type='payment' LIMIT 1;
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f7109';
  DELETE FROM supplier_payments WHERE id=v_pay;                 -- RLS: sin policy DELETE → 0 filas
  UPDATE supplier_payments SET amount=99999 WHERE id=v_pay;     -- RLS: sin policy UPDATE → 0 filas
  DELETE FROM supplier_account_movements WHERE id=v_mov;
  UPDATE supplier_account_movements SET debit=99999 WHERE id=v_mov;
  RESET ROLE;
  PERFORM pg_temp.assert(EXISTS (SELECT 1 FROM supplier_payments WHERE id=v_pay), 'SPL1 DELETE supplier_payments bloqueado (fila sobrevive)');
  SELECT amount INTO v_amt FROM supplier_payments WHERE id=v_pay;
  PERFORM pg_temp.assert(v_amt=5000, 'SPL2 UPDATE supplier_payments bloqueado (monto sin cambios)');
  PERFORM pg_temp.assert(EXISTS (SELECT 1 FROM supplier_account_movements WHERE id=v_mov), 'SPL3 DELETE supplier_account_movements bloqueado');
  PERFORM pg_temp.assert((SELECT debit FROM supplier_account_movements WHERE id=v_mov)<>99999, 'SPL4 UPDATE supplier_account_movements bloqueado');
END $$;

-- delete_supplier_purchase_safe: compra CON pagos -> blocked_paid
DO $$
DECLARE r jsonb; v_pur uuid;
BEGIN
  SELECT id INTO v_pur FROM supplier_purchases WHERE business_id='00000000-0000-0000-0000-0000000f7101' LIMIT 1;
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f7109';
  r := delete_supplier_purchase_safe('00000000-0000-0000-0000-0000000f7101'::uuid, v_pur, '00000000-0000-0000-0000-0000000f7109'::uuid);
  PERFORM pg_temp.assert((r->>'ok')::boolean IS NOT TRUE AND r->>'error'='blocked_paid', 'SPL7 borrar compra CON pagos -> bloqueado (blocked_paid)');
  RESET ROLE;
END $$;

-- delete_supplier_purchase_safe: compra SIN pagos (a deuda) -> ok
DO $$
DECLARE r jsonb; v_pur uuid;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f7109';
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000000f7101'::uuid,'00000000-0000-0000-0000-0000000f7501'::uuid,
        '00000000-0000-0000-0000-0000000f7109'::uuid,'Prov SPL','2026-06-21','FC-2',3000,0,NULL,'a deuda',
        jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-0000000f7d01','product_name','Prod SPL','quantity',3,'unit_cost',1000)),'spk2');
  RESET ROLE;
  SELECT id INTO v_pur FROM supplier_purchases WHERE business_id='00000000-0000-0000-0000-0000000f7101' AND invoice_number='FC-2' LIMIT 1;
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f7109';
  r := delete_supplier_purchase_safe('00000000-0000-0000-0000-0000000f7101'::uuid, v_pur, '00000000-0000-0000-0000-0000000f7109'::uuid);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'SPL6 borrar compra SIN pagos (a deuda) -> ok ('||COALESCE(r->>'error','')||')');
  RESET ROLE;
END $$;

SELECT pg_temp.assert(true, '=== etapa6_supplier_payment_lockdown_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
