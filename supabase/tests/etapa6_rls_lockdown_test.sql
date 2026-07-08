-- ============================================================
-- M6 (Fase 9) — RLS/grants lockdown final
-- Verifica: (a) INSERT/UPDATE/DELETE directo bloqueado en tablas económicas
-- críticas; (b) las RPCs SECURITY DEFINER siguen funcionando post-lockdown;
-- (c) excepciones acotadas (comprobante_payments, account_movements) sólo
-- para el business propio; (d) sin policies ALL; (e) SELECT legítimo intacto.
-- RUN: supabase db reset && docker cp ... && psql -f (tx + ROLLBACK)
-- ============================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set biz   '00000000-0000-0000-0000-0000000f9101'
\set owner '00000000-0000-0000-0000-0000000f9109'
\set bizB  '00000000-0000-0000-0000-0000000f9201'
\set ownB  '00000000-0000-0000-0000-0000000f9209'
\set acct  '00000000-0000-0000-0000-0000000f9a01'
\set sup   '00000000-0000-0000-0000-0000000f9501'
\set ord   '00000000-0000-0000-0000-0000000f9d01'
\set cmp   '00000000-0000-0000-0000-0000000f9c01'
\set prod  '00000000-0000-0000-0000-0000000f9e01'

-- ── Fixtures (replica: bypass triggers/RLS para el setup) ──
SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'owner'),(:'ownB');
INSERT INTO businesses(id,name,owner_user_id,subscription_status,subscription_plan) VALUES (:'biz','LCK A',:'owner','active','pro'),(:'bizB','LCK B',:'ownB','active','pro');
-- profiles.id = user id: current_business_id() resuelve por profiles.id=auth.uid()
INSERT INTO profiles(id,business_id,user_id,role,is_active) VALUES (:'owner',:'biz',:'owner','owner',true),(:'ownB',:'bizB',:'ownB','owner',true);
INSERT INTO accounts(id,business_id,type,entity_id,entity_name,balance) VALUES (:'acct',:'biz','cliente',:'owner','Cliente LCK',0);
INSERT INTO suppliers(id,business_id,name,active) VALUES (:'sup',:'biz','Prov LCK',true);
INSERT INTO inventory(id,business_id,name,code,category,stock_quantity,stock,cost_price,sale_price,base_currency,is_active)
  VALUES (:'prod',:'biz','Prod LCK','LCK-1','Rep',20,20,600,1000,'ARS',true);
INSERT INTO orders(id,business_id,status) VALUES (:'ord',:'biz','repair');
INSERT INTO comprobantes(id,business_id,tipo,total,estado_fiscal) VALUES (:'cmp',:'biz','factura_c',10000,'no_fiscal');
SET LOCAL session_replication_role='origin';

-- Deuda inicial del cliente (venta a CC) — el trigger calcula balance_after.
INSERT INTO account_movements(business_id,account_id,date,type,description,debit,credit,balance_after)
  VALUES (:'biz',:'acct','2026-06-20','venta','Venta a crédito',10000,0,0);

-- ═══════════════════════════════════════════════════════════════
-- PARTE A — Las RPCs SECURITY DEFINER siguen funcionando post-lockdown
-- ═══════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_caja uuid; v_pay uuid; v_exp uuid;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f9109';

  -- (16) open_cash_session_atomic
  r := open_cash_session_atomic('00000000-0000-0000-0000-0000000f9101'::uuid,'00000000-0000-0000-0000-0000000f9109'::uuid,10000,0,0,0,1,'ock_f9');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'F9-16 open_cash_session_atomic works ('||COALESCE(r->>'error','')||')');

  -- (NEW) create_manual_cash_movement_atomic + idempotencia
  r := create_manual_cash_movement_atomic('00000000-0000-0000-0000-0000000f9101'::uuid,'income','efectivo',5000,'mov test','00000000-0000-0000-0000-0000000f9109'::uuid,1,'mck_f9');
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean IS FALSE, 'F9-A1 create_manual_cash_movement_atomic works ('||COALESCE(r->>'error','')||')');
  r := create_manual_cash_movement_atomic('00000000-0000-0000-0000-0000000f9101'::uuid,'income','efectivo',5000,'mov test','00000000-0000-0000-0000-0000000f9109'::uuid,1,'mck_f9');
  PERFORM pg_temp.assert((r->>'replay')::boolean, 'F9-A2 manual cash replay misma key');
  r := create_manual_cash_movement_atomic('00000000-0000-0000-0000-0000000f9101'::uuid,'income','efectivo',9999,'mov test','00000000-0000-0000-0000-0000000f9109'::uuid,1,'mck_f9');
  PERFORM pg_temp.assert(r->>'error'='IDEMPOTENCY_CONFLICT', 'F9-A3 manual cash misma key payload distinto -> conflict');

  -- (7) record_customer_account_payment_atomic
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-0000000f9101'::uuid,'00000000-0000-0000-0000-0000000f9a01'::uuid,3000,'Cobro CC','00000000-0000-0000-0000-0000000f9109'::uuid,'efectivo','2026-06-20',NULL,'acpk_f9');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'F9-7 record_customer_account_payment_atomic works ('||COALESCE(r->>'error','')||')');

  -- (9) create_order_payment_atomic + (12) reverse_order_payment_atomic
  r := create_order_payment_atomic('00000000-0000-0000-0000-0000000f9101'::uuid,'00000000-0000-0000-0000-0000000f9d01'::uuid,7000,'cash','ARS',1,'00000000-0000-0000-0000-0000000f9109'::uuid,NULL,'2026-06-20','opk_f9');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'F9-9 create_order_payment_atomic works ('||COALESCE(r->>'error','')||')');

  -- (NEW) pay_supplier_free_atomic + idempotencia
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000000f9101'::uuid,'00000000-0000-0000-0000-0000000f9501'::uuid,'00000000-0000-0000-0000-0000000f9109'::uuid,'Prov LCK','2026-06-20',4000,'efectivo','anticipo','sfpk_f9');
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean IS FALSE, 'F9-A4 pay_supplier_free_atomic works ('||COALESCE(r->>'error','')||')');
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000000f9101'::uuid,'00000000-0000-0000-0000-0000000f9501'::uuid,'00000000-0000-0000-0000-0000000f9109'::uuid,'Prov LCK','2026-06-20',4000,'efectivo','anticipo','sfpk_f9');
  PERFORM pg_temp.assert((r->>'replay')::boolean, 'F9-A5 supplier free replay misma key');

  -- (22) create_supplier_purchase_atomic (RPC proveedor legítima)
  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000000f9101'::uuid,'00000000-0000-0000-0000-0000000f9501'::uuid,
        '00000000-0000-0000-0000-0000000f9109'::uuid,'Prov LCK','2026-06-21','FC-LCK',5000,5000,'efectivo','x',
        jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-0000000f9e01','product_name','Prod LCK','quantity',5,'unit_cost',1000)),'sppk_f9');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'F9-22 create_supplier_purchase_atomic works ('||COALESCE(r->>'error','')||')');

  -- (14) create_expense_with_finance + reverse_operating_expense_atomic
  SELECT id INTO v_caja FROM cajas WHERE business_id='00000000-0000-0000-0000-0000000f9101' AND status='abierta';
  r := create_expense_with_finance('00000000-0000-0000-0000-0000000f9101'::uuid,'00000000-0000-0000-0000-0000000f9109'::uuid,
        'Alquiler LCK','Alquiler','alquiler','fixed_cost_local',8000,'efectivo','2026-06-20',false,NULL,NULL,v_caja);
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'F9-14a create_expense_with_finance works ('||COALESCE(r->>'error','')||')');

  RESET ROLE;
END $$;

-- (10)(11)(12) order_payments: UPDATE/DELETE directo bloqueado + reverse por RPC
-- (v_pay + verificación resueltos como postgres; el monto vive en amount_ars)
DO $$
DECLARE r jsonb; v_pay uuid; v_ars numeric;
BEGIN
  SELECT id, amount_ars INTO v_pay, v_ars FROM order_payments
    WHERE order_id='00000000-0000-0000-0000-0000000f9d01' AND reversed_at IS NULL LIMIT 1;
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f9109';
  DELETE FROM order_payments WHERE id=v_pay;
  UPDATE order_payments SET amount_ars=1 WHERE id=v_pay;
  RESET ROLE;
  PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM order_payments WHERE id=v_pay AND amount_ars=v_ars), 'F9-10/11 order_payments UPDATE/DELETE directo bloqueado');
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f9109';
  r := reverse_order_payment_atomic('00000000-0000-0000-0000-0000000f9101'::uuid, v_pay, 'devolución','00000000-0000-0000-0000-0000000f9109'::uuid,'orvk_f9');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'F9-12 reverse_order_payment_atomic works ('||COALESCE(r->>'error','')||')');
  RESET ROLE;
END $$;

-- (19) replace_comprobante_payment: insert inicial (excepción cp_insert propia) + replace
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f9109';
  -- INSERT directo de comprobante_payments PROPIO -> permitido (excepción documentada);
  -- el trigger crea FM income + BFE mirror.
  INSERT INTO comprobante_payments(comprobante_id,business_id,amount,currency,amount_ars,exchange_rate,payment_method,commission_amount,date,created_by)
    VALUES ('00000000-0000-0000-0000-0000000f9c01','00000000-0000-0000-0000-0000000f9101',10000,'ARS',10000,1,'transferencia',0,'2026-06-20','00000000-0000-0000-0000-0000000f9109');
  PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM comprobante_payments WHERE comprobante_id='00000000-0000-0000-0000-0000000f9c01'), 'F9-EX1 comprobante_payments INSERT propio permitido (excepción)');
  r := replace_comprobante_payment('00000000-0000-0000-0000-0000000f9c01'::uuid,'00000000-0000-0000-0000-0000000f9101'::uuid,'transferencia',6000,6000,'ARS',1,'reemplazo','00000000-0000-0000-0000-0000000f9109'::uuid,0,NULL,'cprk_f9');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'F9-19 replace_comprobante_payment works ('||COALESCE(r->>'error','')||')');
  RESET ROLE;
END $$;

-- (14b) reverse_operating_expense_atomic (v_exp resuelto como postgres antes del SET ROLE)
DO $$
DECLARE r jsonb; v_exp uuid;
BEGIN
  SELECT id INTO v_exp FROM expenses WHERE business_id='00000000-0000-0000-0000-0000000f9101' AND tipo='general' AND reversed_at IS NULL LIMIT 1;
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f9109';
  r := reverse_operating_expense_atomic('00000000-0000-0000-0000-0000000f9101'::uuid, v_exp, 'error carga','00000000-0000-0000-0000-0000000f9109'::uuid,'exrk_f9');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'F9-14b reverse_operating_expense_atomic works ('||COALESCE(r->>'error','')||')');
  RESET ROLE;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- PARTE B — Lockdown: INSERT/UPDATE/DELETE directo bloqueado
-- ═══════════════════════════════════════════════════════════════

-- (1) INSERT financial_movements directo -> RLS raise
DO $$
DECLARE v_blocked boolean := false;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f9109';
  BEGIN
    INSERT INTO financial_movements(business_id,date,type,currency,amount,amount_ars,exchange_rate,source,description,created_by,metodo_pago)
      VALUES ('00000000-0000-0000-0000-0000000f9101',public.ar_today(),'income','ARS',1,1,1,'manual','hack','00000000-0000-0000-0000-0000000f9109','efectivo');
  EXCEPTION WHEN OTHERS THEN v_blocked := true;
  END;
  RESET ROLE;
  PERFORM pg_temp.assert(v_blocked, 'F9-1 INSERT financial_movements directo bloqueado');
END $$;

-- (2)(3) UPDATE/DELETE financial_movements directo bloqueado (0 filas)
DO $$
DECLARE v_fm uuid; v_amt numeric;
BEGIN
  SELECT id, amount INTO v_fm, v_amt FROM financial_movements WHERE business_id='00000000-0000-0000-0000-0000000f9101' AND source='manual' LIMIT 1;
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f9109';
  BEGIN UPDATE financial_movements SET amount=99999 WHERE id=v_fm; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN DELETE FROM financial_movements WHERE id=v_fm; EXCEPTION WHEN OTHERS THEN NULL; END;
  RESET ROLE;
  PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM financial_movements WHERE id=v_fm AND amount=v_amt), 'F9-2/3 UPDATE/DELETE financial_movements directo bloqueado');
END $$;

-- (4) INSERT business_finance_entries directo -> RLS raise
DO $$
DECLARE v_blocked boolean := false;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f9109';
  BEGIN
    INSERT INTO business_finance_entries(business_id,date,type,category,description,amount,currency,amount_ars,exchange_rate)
      VALUES ('00000000-0000-0000-0000-0000000f9101',public.ar_today(),'variable_cost','x','hack',1,'ARS',1,1);
  EXCEPTION WHEN OTHERS THEN v_blocked := true;
  END;
  RESET ROLE;
  PERFORM pg_temp.assert(v_blocked, 'F9-4 INSERT business_finance_entries directo bloqueado');
END $$;

-- (5) UPDATE/DELETE business_finance_entries directo bloqueado (0 filas)
DO $$
DECLARE v_bfe uuid; v_amt numeric;
BEGIN
  SELECT id, amount INTO v_bfe, v_amt FROM business_finance_entries WHERE business_id='00000000-0000-0000-0000-0000000f9101' LIMIT 1;
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f9109';
  BEGIN UPDATE business_finance_entries SET amount=99999 WHERE id=v_bfe; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN DELETE FROM business_finance_entries WHERE id=v_bfe; EXCEPTION WHEN OTHERS THEN NULL; END;
  RESET ROLE;
  PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM business_finance_entries WHERE id=v_bfe AND amount=v_amt), 'F9-5 UPDATE/DELETE business_finance_entries directo bloqueado');
END $$;

-- (6 adaptado) account_movements: excepción INSERT acotada; UPDATE/DELETE bloqueados; cross-tenant falla
DO $$
DECLARE v_ok boolean := false; v_xtenant_blocked boolean := false; v_mov uuid; v_dbg numeric;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f9109';
  -- INSERT propio permitido (excepción documentada: CC manual; feature currentAccounts + is_staff)
  BEGIN
    INSERT INTO account_movements(business_id,account_id,date,type,description,debit,credit,balance_after)
      VALUES ('00000000-0000-0000-0000-0000000f9101','00000000-0000-0000-0000-0000000f9a01','2026-06-25','venta','ajuste manual',100,0,0);
    v_ok := true;
  EXCEPTION WHEN OTHERS THEN v_ok := false;
  END;
  -- INSERT cross-tenant (biz B) desde owner A -> bloqueado por WITH CHECK
  BEGIN
    INSERT INTO account_movements(business_id,account_id,date,type,description,debit,credit,balance_after)
      VALUES ('00000000-0000-0000-0000-0000000f9201','00000000-0000-0000-0000-0000000f9a01','2026-06-25','venta','cross',100,0,0);
  EXCEPTION WHEN OTHERS THEN v_xtenant_blocked := true;
  END;
  RESET ROLE;
  PERFORM pg_temp.assert(v_ok, 'F9-6a account_movements INSERT propio permitido (excepción acotada)');
  PERFORM pg_temp.assert(v_xtenant_blocked, 'F9-6b account_movements INSERT cross-tenant bloqueado');
  -- UPDATE/DELETE propio bloqueado
  SELECT id, debit INTO v_mov, v_dbg FROM account_movements WHERE business_id='00000000-0000-0000-0000-0000000f9101' AND description='ajuste manual' LIMIT 1;
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f9109';
  BEGIN UPDATE account_movements SET debit=99999 WHERE id=v_mov; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN DELETE FROM account_movements WHERE id=v_mov; EXCEPTION WHEN OTHERS THEN NULL; END;
  RESET ROLE;
  PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM account_movements WHERE id=v_mov AND debit=v_dbg), 'F9-6c account_movements UPDATE/DELETE directo bloqueado');
END $$;

-- (8) INSERT order_payments directo -> RLS raise
DO $$
DECLARE v_blocked boolean := false;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f9109';
  BEGIN
    INSERT INTO order_payments(order_id,business_id,amount,payment_method,currency,exchange_rate,amount_ars)
      VALUES ('00000000-0000-0000-0000-0000000f9d01','00000000-0000-0000-0000-0000000f9101',1,'cash','ARS',1,1);
  EXCEPTION WHEN OTHERS THEN v_blocked := true;
  END;
  RESET ROLE;
  PERFORM pg_temp.assert(v_blocked, 'F9-8 INSERT order_payments directo bloqueado');
END $$;

-- (13) DELETE expenses directo bloqueado (0 filas)
DO $$
DECLARE v_exp uuid;
BEGIN
  SELECT id INTO v_exp FROM expenses WHERE business_id='00000000-0000-0000-0000-0000000f9101' LIMIT 1;
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f9109';
  BEGIN DELETE FROM expenses WHERE id=v_exp; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN UPDATE expenses SET amount=99999 WHERE id=v_exp; EXCEPTION WHEN OTHERS THEN NULL; END;
  RESET ROLE;
  PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM expenses WHERE id=v_exp), 'F9-13 DELETE/UPDATE expenses directo bloqueado');
END $$;

-- (20)(21) supplier_payments / supplier_account_movements: INSERT/UPDATE/DELETE bloqueados
DO $$
DECLARE v_ins_p boolean := false; v_ins_m boolean := false; v_pay uuid; v_mov uuid; v_amt numeric;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f9109';
  BEGIN
    INSERT INTO supplier_payments(business_id,supplier_id,purchase_id,payment_date,amount,payment_method,created_by)
      VALUES ('00000000-0000-0000-0000-0000000f9101','00000000-0000-0000-0000-0000000f9501',NULL,'2026-06-20',1,'efectivo','00000000-0000-0000-0000-0000000f9109');
  EXCEPTION WHEN OTHERS THEN v_ins_p := true; END;
  BEGIN
    INSERT INTO supplier_account_movements(business_id,supplier_id,movement_date,type,description,debit,credit)
      VALUES ('00000000-0000-0000-0000-0000000f9101','00000000-0000-0000-0000-0000000f9501','2026-06-20','payment','hack',0,1);
  EXCEPTION WHEN OTHERS THEN v_ins_m := true; END;
  RESET ROLE;
  PERFORM pg_temp.assert(v_ins_p, 'F9-20a INSERT supplier_payments directo bloqueado');
  PERFORM pg_temp.assert(v_ins_m, 'F9-21a INSERT supplier_account_movements directo bloqueado');
  -- UPDATE/DELETE bloqueado
  SELECT id, amount INTO v_pay, v_amt FROM supplier_payments WHERE business_id='00000000-0000-0000-0000-0000000f9101' LIMIT 1;
  SELECT id INTO v_mov FROM supplier_account_movements WHERE business_id='00000000-0000-0000-0000-0000000f9101' LIMIT 1;
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f9109';
  BEGIN UPDATE supplier_payments SET amount=99999 WHERE id=v_pay; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN DELETE FROM supplier_payments WHERE id=v_pay; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN DELETE FROM supplier_account_movements WHERE id=v_mov; EXCEPTION WHEN OTHERS THEN NULL; END;
  RESET ROLE;
  PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM supplier_payments WHERE id=v_pay AND amount=v_amt), 'F9-20b UPDATE/DELETE supplier_payments bloqueado');
  PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM supplier_account_movements WHERE id=v_mov), 'F9-21b DELETE supplier_account_movements bloqueado');
END $$;

-- comprobante_payments: cross-tenant INSERT bloqueado + UPDATE/DELETE propio bloqueado
DO $$
DECLARE v_xt boolean := false; v_cp uuid; v_amt numeric;
BEGIN
  -- owner B intenta insertar cobro en comprobante de A
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f9209';
  BEGIN
    INSERT INTO comprobante_payments(comprobante_id,business_id,amount,currency,amount_ars,exchange_rate,payment_method,commission_amount,date,created_by)
      VALUES ('00000000-0000-0000-0000-0000000f9c01','00000000-0000-0000-0000-0000000f9101',1,'ARS',1,1,'transferencia',0,'2026-06-20','00000000-0000-0000-0000-0000000f9209');
  EXCEPTION WHEN OTHERS THEN v_xt := true; END;
  RESET ROLE;
  PERFORM pg_temp.assert(v_xt, 'F9-EX2 comprobante_payments INSERT cross-tenant bloqueado');
  -- UPDATE/DELETE propio bloqueado
  SELECT id, amount INTO v_cp, v_amt FROM comprobante_payments WHERE business_id='00000000-0000-0000-0000-0000000f9101' LIMIT 1;
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f9109';
  BEGIN UPDATE comprobante_payments SET amount=99999 WHERE id=v_cp; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN DELETE FROM comprobante_payments WHERE id=v_cp; EXCEPTION WHEN OTHERS THEN NULL; END;
  RESET ROLE;
  PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM comprobante_payments WHERE id=v_cp AND amount=v_amt), 'F9-EX3 comprobante_payments UPDATE/DELETE directo bloqueado');
END $$;

-- (15) authenticated NO puede cerrar caja por UPDATE directo (caja sigue abierta)
DO $$
DECLARE v_caja uuid; v_status text;
BEGIN
  SELECT id INTO v_caja FROM cajas WHERE business_id='00000000-0000-0000-0000-0000000f9101' AND status='abierta';
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f9109';
  BEGIN UPDATE cajas SET status='cerrada' WHERE id=v_caja; EXCEPTION WHEN OTHERS THEN NULL; END;
  RESET ROLE;
  SELECT status INTO v_status FROM cajas WHERE id=v_caja;
  PERFORM pg_temp.assert(v_status='abierta', 'F9-15 cerrar caja por UPDATE directo bloqueado (sigue abierta)');
END $$;

-- (NEW) manual cash en negocio SIN caja abierta -> rechazo (guard de caja)
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f9209';
  r := create_manual_cash_movement_atomic('00000000-0000-0000-0000-0000000f9201'::uuid,'income','efectivo',1000,'x','00000000-0000-0000-0000-0000000f9209'::uuid,1,NULL);
  PERFORM pg_temp.assert(r->>'error' ILIKE '%caja abierta%', 'F9-A6 manual cash sin caja abierta -> rechazo');
  RESET ROLE;
END $$;

-- (17) close_cash_session_atomic + (18) caja cerrada inmutable
DO $$
DECLARE r jsonb; v_caja uuid; v_status text;
BEGIN
  SELECT id INTO v_caja FROM cajas WHERE business_id='00000000-0000-0000-0000-0000000f9101' AND status='abierta';
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f9109';
  r := close_cash_session_atomic('00000000-0000-0000-0000-0000000f9101'::uuid,'00000000-0000-0000-0000-0000000f9109'::uuid,v_caja,NULL,NULL,NULL,NULL,1,NULL,'clk_f9');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'F9-17 close_cash_session_atomic works ('||COALESCE(r->>'error','')||')');
  -- (18) intentar reabrir/modificar caja cerrada por UPDATE directo -> bloqueado
  BEGIN UPDATE cajas SET status='abierta' WHERE id=v_caja; EXCEPTION WHEN OTHERS THEN NULL; END;
  RESET ROLE;
  SELECT status INTO v_status FROM cajas WHERE id=v_caja;
  PERFORM pg_temp.assert(v_status='cerrada', 'F9-18 caja cerrada inmutable (UPDATE directo bloqueado)');
END $$;

-- (23) cross-tenant en RPC: owner A opera sobre biz B -> rechazo
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f9109';
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000000f9201'::uuid,'00000000-0000-0000-0000-0000000f9501'::uuid,'00000000-0000-0000-0000-0000000f9109'::uuid,'x','2026-06-20',1000,'efectivo',NULL,NULL);
  PERFORM pg_temp.assert(r->>'error' ILIKE '%acceso%', 'F9-23 cross-tenant en RPC -> rechazo');
  RESET ROLE;
END $$;

-- (24) sin policies ALL en tablas económicas críticas
SELECT pg_temp.assert((SELECT count(*) FROM pg_policies WHERE schemaname='public'
  AND tablename IN ('financial_movements','business_finance_entries','comprobante_payments','account_movements',
                    'supplier_payments','supplier_account_movements','order_payments','expenses','cajas')
  AND cmd='ALL')=0, 'F9-24 sin policies ALL en tablas económicas críticas');

-- (25) SELECT legítimo del negocio propio intacto; cross-tenant no ve nada
DO $$
DECLARE v_own int; v_xt int;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f9109';
  SELECT count(*) INTO v_own FROM financial_movements WHERE business_id='00000000-0000-0000-0000-0000000f9101';
  SELECT count(*) INTO v_xt  FROM financial_movements WHERE business_id='00000000-0000-0000-0000-0000000f9201';
  RESET ROLE;
  PERFORM pg_temp.assert(v_own > 0, 'F9-25a SELECT financial_movements propio funciona');
  PERFORM pg_temp.assert(v_xt = 0, 'F9-25b SELECT cross-tenant no filtra datos ajenos');
END $$;

SELECT pg_temp.assert(true, '=== etapa6_rls_lockdown_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
