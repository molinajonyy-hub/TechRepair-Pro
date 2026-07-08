-- ============================================================
-- M6 (Fase 11) — Suite TRANSVERSAL de integridad
-- No repite la profundidad de las suites por-fase; verifica que M6 es coherente
-- como sistema: estructura (policies/RPCs/constraints), un escenario end-to-end
-- por todas las RPCs, ausencia de huérfanos, y vistas canónicas respondiendo.
-- RUN: supabase db reset && docker cp ... && psql -f (tx + ROLLBACK)
-- ============================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set biz   '00000000-0000-0000-0000-0000000fb101'
\set owner '00000000-0000-0000-0000-0000000fb109'
\set bizB  '00000000-0000-0000-0000-0000000fb201'
\set ownB  '00000000-0000-0000-0000-0000000fb209'
\set acct  '00000000-0000-0000-0000-0000000fba01'
\set sup   '00000000-0000-0000-0000-0000000fb501'
\set ord   '00000000-0000-0000-0000-0000000fbd01'
\set ordR  '00000000-0000-0000-0000-0000000fbd02'
\set cmp   '00000000-0000-0000-0000-0000000fbc01'
\set prod  '00000000-0000-0000-0000-0000000fbe01'

-- ═══════════════════════════════════════════════════════════════
-- PARTE A — Estructura (no requiere datos)
-- ═══════════════════════════════════════════════════════════════

-- A1: sin policies ALL en las 9 tablas económicas críticas
SELECT pg_temp.assert((SELECT count(*) FROM pg_policies WHERE schemaname='public'
  AND tablename IN ('financial_movements','business_finance_entries','comprobante_payments','account_movements',
                    'supplier_payments','supplier_account_movements','order_payments','expenses','cajas')
  AND cmd='ALL')=0, 'A1 sin policies ALL en tablas críticas');

-- A2/A3: RPCs económicas existen, SECURITY DEFINER y search_path=public
DO $$
DECLARE r record; v_missing text := ''; v_notdef text := ''; v_nopath text := '';
  v_fns text[] := ARRAY['create_manual_cash_movement_atomic','pay_supplier_free_atomic',
    'record_customer_account_payment_atomic','open_cash_session_atomic','close_cash_session_atomic',
    'reverse_operating_expense_atomic','create_order_payment_atomic','reverse_order_payment_atomic',
    'replace_comprobante_payment'];
  f text;
BEGIN
  FOREACH f IN ARRAY v_fns LOOP
    SELECT p.prosecdef AS secdef, array_to_string(p.proconfig,',') AS cfg INTO r
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=f LIMIT 1;
    IF NOT FOUND THEN v_missing := v_missing||f||' '; CONTINUE; END IF;
    IF NOT r.secdef THEN v_notdef := v_notdef||f||' '; END IF;
    IF COALESCE(r.cfg,'') NOT ILIKE '%search_path=public%' THEN v_nopath := v_nopath||f||' '; END IF;
  END LOOP;
  PERFORM pg_temp.assert(v_missing='', 'A2a todas las RPCs económicas existen (faltan: '||v_missing||')');
  PERFORM pg_temp.assert(v_notdef='', 'A2b todas SECURITY DEFINER (no def: '||v_notdef||')');
  PERFORM pg_temp.assert(v_nopath='', 'A3 todas con search_path=public (sin path: '||v_nopath||')');
END $$;

-- A4: request tables con UNIQUE(business_id, idempotency_key)
DO $$
DECLARE t text; v_bad text := '';
  v_reqs text[] := ARRAY['manual_cash_movement_requests','supplier_free_payment_requests',
    'account_payment_requests','cash_session_requests','order_payment_requests','comprobante_payment_replace_requests'];
BEGIN
  FOREACH t IN ARRAY v_reqs LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c JOIN pg_class cl ON cl.oid=c.conrelid
      WHERE cl.relname=t AND c.contype='u'
        AND (SELECT array_agg(att.attname::text ORDER BY att.attname::text)
             FROM unnest(c.conkey) k JOIN pg_attribute att ON att.attrelid=c.conrelid AND att.attnum=k)
            @> ARRAY['business_id','idempotency_key']
    ) THEN v_bad := v_bad||t||' '; END IF;
  END LOOP;
  PERFORM pg_temp.assert(v_bad='', 'A4 request tables con UNIQUE(business_id,idempotency_key) (faltan: '||v_bad||')');
END $$;

-- A5: reversal tables referencian el original
SELECT pg_temp.assert(
  (SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
    AND table_name='operating_expense_reversals' AND column_name IN ('expense_id','original_financial_movement_id','original_finance_entry_id'))=3
  AND (SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
    AND table_name='order_payment_reversals' AND column_name IN ('order_payment_id','original_financial_movement_id','original_finance_entry_id'))=3,
  'A5 reversal tables tienen referencia al original');

-- A6: reversed_at existe donde se usa
SELECT pg_temp.assert((SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
  AND column_name='reversed_at' AND table_name IN ('financial_movements','business_finance_entries','expenses','order_payments'))=4,
  'A6 reversed_at existe en FM/BFE/expenses/order_payments');

-- ═══════════════════════════════════════════════════════════════
-- PARTE B — Escenario end-to-end (todas las RPCs) + huérfanos + vistas
-- ═══════════════════════════════════════════════════════════════
SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'owner'),(:'ownB');
INSERT INTO businesses(id,name,owner_user_id,subscription_status,subscription_plan)
  VALUES (:'biz','INTEG A',:'owner','active','pro'),(:'bizB','INTEG B',:'ownB','active','pro');
INSERT INTO profiles(id,business_id,user_id,role,is_active) VALUES (:'owner',:'biz',:'owner','owner',true),(:'ownB',:'bizB',:'ownB','owner',true);
INSERT INTO accounts(id,business_id,type,entity_id,entity_name,balance) VALUES (:'acct',:'biz','cliente',:'owner','Cliente INTEG',0);
INSERT INTO suppliers(id,business_id,name,active) VALUES (:'sup',:'biz','Prov INTEG',true);
INSERT INTO inventory(id,business_id,name,code,category,stock_quantity,stock,cost_price,sale_price,base_currency,is_active)
  VALUES (:'prod',:'biz','Prod INTEG','INT-1','Rep',20,20,600,1000,'ARS',true);
INSERT INTO orders(id,business_id,status) VALUES (:'ord',:'biz','repair'),(:'ordR',:'biz','repair');
INSERT INTO comprobantes(id,business_id,tipo,total,estado_fiscal) VALUES (:'cmp',:'biz','factura_c',10000,'no_fiscal');
SET LOCAL session_replication_role='origin';
-- deuda inicial del cliente (venta a CC) para el cobro
INSERT INTO account_movements(business_id,account_id,date,type,description,debit,credit,balance_after)
  VALUES (:'biz',:'acct','2026-06-20','venta','Venta a crédito',8000,0,0);

DO $$
DECLARE r jsonb; v_caja uuid; v_pay uuid; v_exp uuid;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000fb109';

  r := open_cash_session_atomic('00000000-0000-0000-0000-0000000fb101'::uuid,'00000000-0000-0000-0000-0000000fb109'::uuid,10000,0,0,0,1,'ick1');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'B0 open cash session ('||COALESCE(r->>'error','')||')');

  r := create_manual_cash_movement_atomic('00000000-0000-0000-0000-0000000fb101'::uuid,'income','efectivo',2000,'mov','00000000-0000-0000-0000-0000000fb109'::uuid,1,'imk1');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'B1 manual cash movement');

  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-0000000fb101'::uuid,'00000000-0000-0000-0000-0000000fba01'::uuid,3000,'Cobro CC','00000000-0000-0000-0000-0000000fb109'::uuid,'efectivo','2026-06-21',NULL,'iak1');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'B2 cobro CC');

  r := create_order_payment_atomic('00000000-0000-0000-0000-0000000fb101'::uuid,'00000000-0000-0000-0000-0000000fbd01'::uuid,5000,'cash','ARS',1,'00000000-0000-0000-0000-0000000fb109'::uuid,NULL,'2026-06-21','iopk1');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'B3 order payment ARS');
  r := create_order_payment_atomic('00000000-0000-0000-0000-0000000fb101'::uuid,'00000000-0000-0000-0000-0000000fbd01'::uuid,100,'cash','USD',1500,'00000000-0000-0000-0000-0000000fb109'::uuid,NULL,'2026-06-21','iopk2');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'B4 order payment USD');
  -- pago en orden dedicada para reversar
  r := create_order_payment_atomic('00000000-0000-0000-0000-0000000fb101'::uuid,'00000000-0000-0000-0000-0000000fbd02'::uuid,4000,'cash','ARS',1,'00000000-0000-0000-0000-0000000fb109'::uuid,NULL,'2026-06-21','iopk3');
  v_pay := (r->>'order_payment_id')::uuid;
  r := reverse_order_payment_atomic('00000000-0000-0000-0000-0000000fb101'::uuid, v_pay, 'devolución','00000000-0000-0000-0000-0000000fb109'::uuid,'iorvk1');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'B5 order payment reverse');

  r := create_expense_with_finance('00000000-0000-0000-0000-0000000fb101'::uuid,'00000000-0000-0000-0000-0000000fb109'::uuid,
        'Alquiler INTEG','Alquiler','alquiler','fixed_cost_local',6000,'efectivo','2026-06-21',false,NULL,NULL,
        (SELECT id FROM cajas WHERE business_id='00000000-0000-0000-0000-0000000fb101' AND status='abierta'));
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'B6 gasto operativo');
  RESET ROLE;
  SELECT id INTO v_exp FROM expenses WHERE business_id='00000000-0000-0000-0000-0000000fb101' AND tipo='general' AND reversed_at IS NULL LIMIT 1;
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000fb109';
  r := reverse_operating_expense_atomic('00000000-0000-0000-0000-0000000fb101'::uuid, v_exp, 'error','00000000-0000-0000-0000-0000000fb109'::uuid,'iexrk1');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'B7 reverso gasto operativo');

  r := create_supplier_purchase_atomic('00000000-0000-0000-0000-0000000fb101'::uuid,'00000000-0000-0000-0000-0000000fb501'::uuid,
        '00000000-0000-0000-0000-0000000fb109'::uuid,'Prov INTEG','2026-06-21','FC-INT',5000,5000,'efectivo','x',
        jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-0000000fbe01','product_name','Prod INTEG','quantity',5,'unit_cost',1000)),'isppk1');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'B8 compra proveedor');
  r := pay_supplier_free_atomic('00000000-0000-0000-0000-0000000fb101'::uuid,'00000000-0000-0000-0000-0000000fb501'::uuid,'00000000-0000-0000-0000-0000000fb109'::uuid,'Prov INTEG','2026-06-21',2000,'efectivo','anticipo','isfpk1');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'B9 pago libre proveedor');

  -- comprobante: cobro inicial con comisión 200 (excepción E1) + replace con comisión 300
  INSERT INTO comprobante_payments(comprobante_id,business_id,amount,currency,amount_ars,exchange_rate,payment_method,commission_amount,date,created_by)
    VALUES ('00000000-0000-0000-0000-0000000fbc01','00000000-0000-0000-0000-0000000fb101',10000,'ARS',10000,1,'transferencia',200,'2026-06-21','00000000-0000-0000-0000-0000000fb109');
  r := replace_comprobante_payment('00000000-0000-0000-0000-0000000fbc01'::uuid,'00000000-0000-0000-0000-0000000fb101'::uuid,'transferencia',6000,6000,'ARS',1,'reemplazo','00000000-0000-0000-0000-0000000fb109'::uuid,300,NULL,'icprk1');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'B10 replace comprobante payment con comisión');
  RESET ROLE;
END $$;

-- ── Conciliación: comisión — anterior neutralizada, nueva una sola vez ──
SELECT pg_temp.assert(
  (SELECT COALESCE(SUM(amount_ars),0) FROM business_finance_entries WHERE business_id=:'biz' AND economic_class='payment_fee')=300,
  'B10b payment_fee neto = 300 (comisión previa 200 neteada, nueva 300 una sola vez)');

-- ── Conciliación: cobros (CC, orden, comprobante) NO inflan net_sales del P&L ──
-- El comprobante fixture no tiene comprobante_items → venta devengada = 0. Pese a
-- todos los cobros/mirror, net_sales sigue 0 (revenue_collection_mirror excluido del P&L).
SELECT pg_temp.assert(
  (SELECT COALESCE(SUM(net_sales),0) FROM v_finance_pnl WHERE business_id=:'biz')=0,
  'B11 net_sales=0: cobros CC/orden/comprobante no contaminan el P&L');

-- ═══════════════════════════════════════════════════════════════
-- PARTE C — Huérfanos (0 en todos)
-- ═══════════════════════════════════════════════════════════════
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements fm
  WHERE fm.business_id=:'biz' AND fm.comprobante_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM comprobantes c WHERE c.id=fm.comprobante_id))=0,
  'C1 sin FM referenciando comprobante inexistente');

SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries bfe
  WHERE bfe.business_id=:'biz' AND bfe.reference_comprobante_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM comprobantes c WHERE c.id=bfe.reference_comprobante_id))=0,
  'C2 sin BFE referenciando comprobante inexistente');

SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries bfe
  WHERE bfe.business_id=:'biz' AND bfe.economic_class='payment_fee' AND bfe.reversed_at IS NULL
    AND bfe.reference_comprobante_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM comprobantes c WHERE c.id=bfe.reference_comprobante_id))=0,
  'C3 sin BFE payment_fee viva con comprobante inexistente');

SELECT pg_temp.assert((SELECT count(*) FROM order_payments op
  WHERE op.business_id=:'biz' AND op.reversed_at IS NULL
    AND (op.financial_movement_id IS NULL OR op.finance_entry_id IS NULL))=0,
  'C4 order_payments vivos con FM+BFE linkeados (sin huérfanos de link)');

SELECT pg_temp.assert((SELECT count(*) FROM supplier_payments sp
  WHERE sp.business_id=:'biz'
    AND NOT EXISTS(SELECT 1 FROM supplier_account_movements sam WHERE sam.payment_id=sp.id))=0,
  'C5 supplier_payments con movimiento de CC proveedor (sin huérfanos)');

SELECT pg_temp.assert((SELECT count(*) FROM expenses e
  WHERE e.business_id=:'biz' AND e.reversed_at IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM operating_expense_reversals r WHERE r.expense_id=e.id))=0,
  'C6 expenses reversadas tienen auditoría en operating_expense_reversals');

SELECT pg_temp.assert(
  (SELECT count(*) FROM operating_expense_reversals r WHERE r.business_id=:'biz'
     AND NOT EXISTS(SELECT 1 FROM expenses e WHERE e.id=r.expense_id))=0
  AND (SELECT count(*) FROM order_payment_reversals r WHERE r.business_id=:'biz'
     AND NOT EXISTS(SELECT 1 FROM order_payments op WHERE op.id=r.order_payment_id))=0,
  'C7 reversals no existen sin su original');

-- ═══════════════════════════════════════════════════════════════
-- PARTE D — Vistas canónicas responden + guard de caja cerrada
-- ═══════════════════════════════════════════════════════════════
SELECT pg_temp.assert((SELECT count(*) FROM v_finance_pnl WHERE business_id=:'biz') >= 0, 'D1 v_finance_pnl responde');
SELECT pg_temp.assert((SELECT count(*) FROM v_finance_cashflow WHERE business_id=:'biz') >= 0, 'D2 v_finance_cashflow responde');
SELECT pg_temp.assert((SELECT count(*) FROM v_finance_position WHERE business_id=:'biz') >= 0, 'D3 v_finance_position responde');
SELECT pg_temp.assert((SELECT finance_dashboard_summary(:'biz'::uuid,'2026-06-01','2026-06-30')) IS NOT NULL, 'D4 finance_dashboard_summary responde');

-- D5: guard de caja cerrada sigue activo (insert directo a caja cerrada -> excepción)
DO $$
DECLARE v_caja uuid; v_blocked boolean := false;
BEGIN
  SELECT id INTO v_caja FROM cajas WHERE business_id='00000000-0000-0000-0000-0000000fb101' AND status='abierta' LIMIT 1;
  UPDATE cajas SET status='cerrada' WHERE id=v_caja;  -- postgres: cierre directo para el fixture del guard
  BEGIN
    INSERT INTO financial_movements(business_id,caja_id,date,type,currency,amount,amount_ars,exchange_rate,source,created_by,metodo_pago)
      VALUES ('00000000-0000-0000-0000-0000000fb101',v_caja,public.ar_today(),'income','ARS',1,1,1,'manual','00000000-0000-0000-0000-0000000fb109','efectivo');
  EXCEPTION WHEN OTHERS THEN v_blocked := true;
  END;
  PERFORM pg_temp.assert(v_blocked, 'D5 guard de caja cerrada activo (FM a caja cerrada rechazado)');
END $$;

SELECT pg_temp.assert(true, '=== etapa6_m6_integrity_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
