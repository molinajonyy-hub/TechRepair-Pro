-- LOCAL ONLY: Lote 3 SQL role/JWT-GUC authority matrix and negative controls.
BEGIN;
SET LOCAL statement_timeout = '60s';

CREATE TEMP TABLE ids (name text PRIMARY KEY, id uuid NOT NULL DEFAULT gen_random_uuid());
INSERT INTO ids(name) VALUES
 ('A'),('B'),('Basic'),('owner'),('admin'),('manager'),('tech'),('sales'),('cashier'),('viewer'),
 ('ownerB'),('ownerBasic'),('inactive'),('no_profile'),('admin_false'),('tech_true'),
 ('compA'),('compPT'),('movementA'),('cajaA'),('pt_old'),('pt_candidate'),
  ('oldWrite'),('orderA'),('supplierA'),('inventoryA'),('expenseCatA'),
  ('dollarA'),('commissionA'),('taskA'),('whatsappA'),('expenseA'),
  ('orderPaymentA'),('wholesaleA'),
  ('purchaseExploit'),('purchaseSafe'),('supplierPaymentExploit'),('supplierExpenseExploit'),
  ('compForge'),('compDraft'),('compCP'),('cpOld'),('legacyActor'),('legacyProfile');
GRANT SELECT ON ids TO anon, authenticated, service_role;

CREATE FUNCTION pg_temp.id(n text) RETURNS uuid LANGUAGE sql AS
$$ SELECT id FROM pg_temp.ids WHERE name=n $$;

CREATE TEMP TABLE checks(label text PRIMARY KEY, passed boolean NOT NULL);
CREATE FUNCTION pg_temp.check_true(cond boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', p_label; END IF;
  INSERT INTO pg_temp.checks VALUES(p_label,true) ON CONFLICT (label) DO NOTHING;
END $$;

CREATE FUNCTION pg_temp.fingerprint() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE t text; f text; result jsonb := '{}';
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'cajas','financial_movements','business_finance_entries','finance_audit_log','finance_insights',
    'comprobantes','comprobante_payments','orders','order_payments','expenses',
    'inventory','inventory_movements','supplier_purchases','supplier_purchase_items',
    'supplier_account_movements','supplier_payments','supplier_purchase_deletions',
    'accounts','account_movements','payment_transactions'
  ] LOOP
    EXECUTE format(
      'SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text)::text,''[]'')) FROM public.%I r', t
    ) INTO f;
    result := result || jsonb_build_object(t,f);
  END LOOP;
  RETURN result;
END $$;

CREATE FUNCTION pg_temp.call_as(actor text, dbrole text, query text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb; uid uuid;
BEGIN
  uid := CASE WHEN actor IS NULL THEN NULL ELSE pg_temp.id(actor) END;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role',dbrole)::text,true);
  PERFORM set_config('request.jwt.claim.sub',coalesce(uid::text,''),true);
  EXECUTE format('SET LOCAL ROLE %I',dbrole);
  BEGIN
    EXECUTE query INTO result;
  EXCEPTION WHEN OTHERS THEN
    result := jsonb_build_object('sqlstate',SQLSTATE,'message',SQLERRM);
  END;
  RESET ROLE;
  RETURN result;
END $$;

CREATE FUNCTION pg_temp.call_with_claim(actor text, dbrole text, claim_role text, query text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb; uid uuid;
BEGIN
  uid := CASE WHEN actor IS NULL THEN NULL ELSE pg_temp.id(actor) END;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role',claim_role)::text,true);
  PERFORM set_config('request.jwt.claim.sub',coalesce(uid::text,''),true);
  EXECUTE format('SET LOCAL ROLE %I',dbrole);
  BEGIN
    EXECUTE query INTO result;
  EXCEPTION WHEN OTHERS THEN
    result := jsonb_build_object('sqlstate',SQLSTATE,'message',SQLERRM);
  END;
  RESET ROLE;
  RETURN result;
END $$;

CREATE FUNCTION pg_temp.is_denied(result jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(result->>'sqlstate' = '42501',false)
      OR COALESCE(result->>'error_code' = 'FORBIDDEN',false)
      OR COALESCE(result->>'code' = '42501',false)
      OR COALESCE(result->>'error' ILIKE 'Sin acceso%',false)
      OR COALESCE(result->>'error' ILIKE 'No autorizado%',false)
$$;

CREATE FUNCTION pg_temp.deny(actor text, dbrole text, query text, label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE before_hash jsonb; result jsonb;
BEGIN
  before_hash := pg_temp.fingerprint();
  result := pg_temp.call_as(actor,dbrole,query);
  PERFORM pg_temp.check_true(pg_temp.is_denied(result),label||' denied: '||result::text);
  PERFORM pg_temp.check_true(before_hash=pg_temp.fingerprint(),label||' ZERO EFFECTS');
END $$;

SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id,email,email_confirmed_at)
  SELECT id,name||'@lote3.invalid',now() FROM ids
  WHERE name IN ('owner','admin','manager','tech','sales','cashier','viewer','ownerB','ownerBasic','inactive','no_profile','admin_false','tech_true','legacyActor','legacyProfile');
INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status) VALUES
 (pg_temp.id('A'),'Synthetic Lote3 A',pg_temp.id('owner'),'full','active'),
 (pg_temp.id('B'),'Synthetic Lote3 B',pg_temp.id('ownerB'),'full','active'),
 (pg_temp.id('Basic'),'Synthetic Lote3 Basic',pg_temp.id('ownerBasic'),'basico','active');
INSERT INTO public.profiles(id,user_id,business_id,role,is_active,email)
 SELECT id, id, pg_temp.id(CASE WHEN name='ownerB' THEN 'B' WHEN name='ownerBasic' THEN 'Basic' ELSE 'A' END),
   CASE WHEN name IN ('ownerB','ownerBasic','inactive') THEN 'owner' WHEN name='admin_false' THEN 'admin' WHEN name='tech_true' THEN 'tech' ELSE name END,
   name<>'inactive', name||'@lote3.invalid'
  FROM ids WHERE name IN ('owner','admin','manager','tech','sales','cashier','viewer','ownerB','ownerBasic','inactive','admin_false','tech_true');
INSERT INTO public.profiles(id,user_id,business_id,role,is_active,email,created_at,updated_at) VALUES
 (pg_temp.id('legacyActor'),NULL,pg_temp.id('A'),'admin',true,'legacy-old@lote3.invalid',now()-interval '2 days',now()-interval '2 days'),
 (pg_temp.id('legacyProfile'),pg_temp.id('legacyActor'),pg_temp.id('B'),'admin',true,'legacy-new@lote3.invalid',now()-interval '1 day',now()-interval '1 day');
UPDATE public.profiles SET permissions =
  '{"finance":false,"comprobantes":false,"inventory":false,"settings_sensitive":false,"customers":false,"orders_view_financials":false}'
 WHERE id=pg_temp.id('admin_false');
UPDATE public.profiles SET permissions =
  '{"finance":true,"comprobantes":true,"inventory":true,"settings_sensitive":true,"customers":true,"orders_view_financials":true}'
 WHERE id=pg_temp.id('tech_true');
INSERT INTO public.comprobantes(id,business_id,tipo,estado,status,estado_comercial,total,saldo_pendiente)
 VALUES
 (pg_temp.id('compA'),pg_temp.id('A'),'remito','emitido','completed','pendiente',100,100),
 (pg_temp.id('compPT'),pg_temp.id('A'),'remito','emitido','completed','pendiente',100,100),
 (pg_temp.id('compForge'),pg_temp.id('A'),'remito','emitido','completed','pendiente',100,100),
 (pg_temp.id('compDraft'),pg_temp.id('A'),'remito','borrador','draft','pendiente',100,100),
 (pg_temp.id('compCP'),pg_temp.id('A'),'remito','emitido','completed','pendiente',100,100);
INSERT INTO public.financial_movements(id,business_id,date,type,currency,amount,exchange_rate,amount_ars,source,description,sign)
 VALUES(pg_temp.id('movementA'),pg_temp.id('A'),current_date,'income','ARS',10,1,10,'manual_cash','fixture',1);
INSERT INTO public.cajas(id,business_id,status,opened_by,opened_at)
 VALUES(pg_temp.id('cajaA'),pg_temp.id('A'),'abierta',pg_temp.id('owner'),now());
INSERT INTO public.payment_transactions(id,business_id,comprobante_id,status,transaction_amount,net_amount_estimated,currency)
 VALUES(pg_temp.id('pt_candidate'),pg_temp.id('A'),pg_temp.id('compPT'),'pending',100,100,'ARS');
INSERT INTO public.orders(id,business_id,status,notes)
 VALUES(pg_temp.id('orderA'),pg_temp.id('A'),'new','lote3 fixture');
INSERT INTO public.suppliers(id,business_id,name)
 VALUES(pg_temp.id('supplierA'),pg_temp.id('A'),'Lote3 supplier');
INSERT INTO public.inventory(id,business_id,code,name,category,cost_price,sale_price)
  VALUES(pg_temp.id('inventoryA'),pg_temp.id('A'),'L3-1','Lote3 item','fixture',1,2);
UPDATE public.inventory SET stock=10,stock_quantity=10 WHERE id=pg_temp.id('inventoryA');
INSERT INTO public.supplier_purchases(id,business_id,supplier_id,total_amount,paid_amount,pending_amount,payment_status,created_by) VALUES
 (pg_temp.id('purchaseExploit'),pg_temp.id('A'),pg_temp.id('supplierA'),100,25,75,'partial',pg_temp.id('owner')),
 (pg_temp.id('purchaseSafe'),pg_temp.id('A'),pg_temp.id('supplierA'),20,0,20,'pending',pg_temp.id('owner'));
INSERT INTO public.supplier_purchase_items(business_id,purchase_id,supplier_id,inventory_id,product_name,quantity,unit_cost,subtotal) VALUES
 (pg_temp.id('A'),pg_temp.id('purchaseExploit'),pg_temp.id('supplierA'),pg_temp.id('inventoryA'),'Exploit item',3,10,30),
 (pg_temp.id('A'),pg_temp.id('purchaseSafe'),pg_temp.id('supplierA'),pg_temp.id('inventoryA'),'Safe item',2,10,20);
INSERT INTO public.supplier_account_movements(business_id,supplier_id,purchase_id,type,description,debit,credit,balance_after) VALUES
 (pg_temp.id('A'),pg_temp.id('supplierA'),pg_temp.id('purchaseExploit'),'purchase','Exploit debt',100,0,75),
 (pg_temp.id('A'),pg_temp.id('supplierA'),pg_temp.id('purchaseSafe'),'purchase','Safe debt',20,0,20);
INSERT INTO public.supplier_payments(id,business_id,supplier_id,purchase_id,amount,payment_method,created_by) VALUES
 (pg_temp.id('supplierPaymentExploit'),pg_temp.id('A'),pg_temp.id('supplierA'),pg_temp.id('purchaseExploit'),25,'efectivo',pg_temp.id('owner'));
INSERT INTO public.expenses(id,business_id,description,category,amount,supplier_id,supplier_purchase_id) VALUES
 (pg_temp.id('supplierExpenseExploit'),pg_temp.id('A'),'Exploit linked expense','supplier_purchase',25,pg_temp.id('supplierA'),pg_temp.id('purchaseExploit'));
INSERT INTO public.expense_categories(id,business_id,name)
 VALUES(pg_temp.id('expenseCatA'),pg_temp.id('A'),'Lote3 category');
INSERT INTO public.dollar_rate_history(id,business_id,sell_price,source)
 VALUES(pg_temp.id('dollarA'),pg_temp.id('A'),1000,'lote3');
INSERT INTO public.payment_commission_groups(id,business_id,name)
 VALUES(pg_temp.id('commissionA'),pg_temp.id('A'),'Lote3 commission');
INSERT INTO public.tasks(id,business_id,title)
 VALUES(pg_temp.id('taskA'),pg_temp.id('A'),'Lote3 task');
INSERT INTO public.whatsapp_logs(id,business_id,message)
 VALUES(pg_temp.id('whatsappA'),pg_temp.id('A'),'Lote3 message');
INSERT INTO public.expenses(id,business_id,description,category,amount)
 VALUES(pg_temp.id('expenseA'),pg_temp.id('A'),'Lote3 expense','fixture',10);
INSERT INTO public.order_payments(id,business_id,order_id,amount,payment_method)
 VALUES(pg_temp.id('orderPaymentA'),pg_temp.id('A'),pg_temp.id('orderA'),10,'cash');
INSERT INTO public.wholesale_customers(id,business_id,name,email)
 VALUES(pg_temp.id('wholesaleA'),pg_temp.id('A'),'Lote3 wholesale','wholesale@lote3.invalid');
SET LOCAL session_replication_role=origin;

CREATE TEMP TABLE rpc_cases (
  function_name text PRIMARY KEY,
  capability text NOT NULL,
  additional_capability text,
  deny_sql text NOT NULL,
  positive_sql text NOT NULL
);

INSERT INTO rpc_cases VALUES
('close_cash_session_atomic','finance',NULL,
 format('SELECT public.close_cash_session_atomic(%L,%L,%L,0,0,0,0,NULL,NULL,''l3-close'')',pg_temp.id('A'),pg_temp.id('owner'),gen_random_uuid()),
 format('SELECT public.close_cash_session_atomic(%L,%L,%L,0,0,0,0,NULL,NULL,''l3-close-positive'')',pg_temp.id('A'),pg_temp.id('owner'),gen_random_uuid())),
('create_comprobante_checkout_atomic','comprobantes',NULL,
 format('SELECT public.create_comprobante_checkout_atomic(%L,''l3-checkout'',''hash'',''{}''::jsonb)',pg_temp.id('A')),
 format('SELECT public.create_comprobante_checkout_atomic(%L,''l3-checkout-positive'',''hash'',''{}''::jsonb)',pg_temp.id('A'))),
('create_credit_note_finance_reversal','comprobantes',NULL,
 format('SELECT public.create_credit_note_finance_reversal(%L)',pg_temp.id('compA')),
 format('SELECT public.create_credit_note_finance_reversal(%L)',gen_random_uuid())),
('create_credit_note_from_comprobante','comprobantes',NULL,
 format('SELECT public.create_credit_note_from_comprobante(%L)',pg_temp.id('compA')),
 format('SELECT public.create_credit_note_from_comprobante(%L)',gen_random_uuid())),
('create_expense_with_finance','finance',NULL,
 format('SELECT public.create_expense_with_finance(%L,%L,''x'',''x'',''x'',''fixed_cost_local'',0,''efectivo'',current_date,false,NULL,NULL,NULL,''l3-exp'')',pg_temp.id('A'),pg_temp.id('owner')),
 format('SELECT public.create_expense_with_finance(%L,%L,''x'',''x'',''x'',''fixed_cost_local'',0,''efectivo'',current_date,false,NULL,NULL,NULL,''l3-exp-positive'')',pg_temp.id('A'),pg_temp.id('owner'))),
('create_manual_cash_movement_atomic','finance',NULL,
 format('SELECT public.create_manual_cash_movement_atomic(%L,''income'',''efectivo'',0,''x'',%L,1,''l3-mcm'')',pg_temp.id('A'),pg_temp.id('owner')),
 format('SELECT public.create_manual_cash_movement_atomic(%L,''income'',''efectivo'',0,''x'',%L,1,''l3-mcm-positive'')',pg_temp.id('A'),pg_temp.id('owner'))),
('create_order_payment_atomic','comprobantes',NULL,
 format('SELECT public.create_order_payment_atomic(%L,%L,0,''efectivo'',''ARS'',1,%L,NULL,current_date,''l3-op'')',pg_temp.id('A'),gen_random_uuid(),pg_temp.id('owner')),
 format('SELECT public.create_order_payment_atomic(%L,%L,0,''efectivo'',''ARS'',1,%L,NULL,current_date,''l3-op-positive'')',pg_temp.id('A'),gen_random_uuid(),pg_temp.id('owner'))),
('create_quick_inventory_purchase_atomic','inventory',NULL,
 format('SELECT public.create_quick_inventory_purchase_atomic(%L,''l3-qip'',NULL,''x'',NULL,current_date,''efectivo'',0,0,''[]''::jsonb)',pg_temp.id('A')),
 format('SELECT public.create_quick_inventory_purchase_atomic(%L,''l3-qip-positive'',NULL,''x'',NULL,current_date,''efectivo'',0,0,''[]''::jsonb)',pg_temp.id('A'))),
('create_supplier_purchase_atomic','inventory',NULL,
 format('SELECT public.create_supplier_purchase_atomic(%L,NULL,%L,''x'',current_date,NULL,0,0,''efectivo'',NULL,''[]''::jsonb,''l3-sp'')',pg_temp.id('A'),pg_temp.id('owner')),
 format('SELECT public.create_supplier_purchase_atomic(%L,NULL,%L,''x'',current_date,NULL,0,0,''efectivo'',NULL,''[]''::jsonb,''l3-sp-positive'')',pg_temp.id('A'),pg_temp.id('owner'))),
('customer_purchase_history','customers','orders_view_financials',
 format('SELECT public.customer_purchase_history(%L,%L)',gen_random_uuid(),pg_temp.id('A')),
 format('SELECT public.customer_purchase_history(%L,%L)',gen_random_uuid(),pg_temp.id('A'))),
('delete_comprobante_with_finance','comprobantes',NULL,
 format('SELECT public.delete_comprobante_with_finance(%L)',pg_temp.id('compA')),
 format('SELECT public.delete_comprobante_with_finance(%L)',gen_random_uuid())),
('finance_dashboard_summary','finance',NULL,
 format('SELECT public.finance_dashboard_summary(%L,current_date,current_date)',pg_temp.id('A')),
 format('SELECT public.finance_dashboard_summary(%L,current_date,current_date)',pg_temp.id('A'))),
('finance_health_check','finance',NULL,
 format('SELECT public.finance_health_check(%L)',pg_temp.id('A')),
 format('SELECT public.finance_health_check(%L)',pg_temp.id('A'))),
('finance_health_check_v2','finance',NULL,
 format('SELECT public.finance_health_check_v2(%L,false)',pg_temp.id('A')),
 format('SELECT public.finance_health_check_v2(%L,false)',pg_temp.id('A'))),
('finance_pending_historicals','finance',NULL,
 format('SELECT public.finance_pending_historicals(%L)',pg_temp.id('A')),
 format('SELECT public.finance_pending_historicals(%L)',pg_temp.id('A'))),
('generate_finance_insights','finance',NULL,
 format('SELECT public.generate_finance_insights(%L,current_date,current_date-1)',pg_temp.id('A')),
 format('SELECT public.generate_finance_insights(%L,current_date,current_date-1)',pg_temp.id('A'))),
('get_checkout_request_status','comprobantes',NULL,
 format('SELECT public.get_checkout_request_status(%L,''missing-l3'')',pg_temp.id('A')),
 format('SELECT public.get_checkout_request_status(%L,''missing-l3-positive'')',pg_temp.id('A'))),
('open_cash_session_atomic','finance',NULL,
 format('SELECT public.open_cash_session_atomic(%L,%L,0,0,0,0,NULL,''l3-open'')',pg_temp.id('A'),pg_temp.id('owner')),
 format('SELECT public.open_cash_session_atomic(%L,%L,-1,0,0,0,NULL,''l3-open-positive'')',pg_temp.id('A'),pg_temp.id('owner'))),
('pay_supplier_free_atomic','inventory',NULL,
 format('SELECT public.pay_supplier_free_atomic(%L,%L,%L,''x'',current_date,0,''efectivo'',NULL,''l3-psf'')',pg_temp.id('A'),gen_random_uuid(),pg_temp.id('owner')),
 format('SELECT public.pay_supplier_free_atomic(%L,%L,%L,''x'',current_date,0,''efectivo'',NULL,''l3-psf-positive'')',pg_temp.id('A'),gen_random_uuid(),pg_temp.id('owner'))),
('pay_supplier_purchase_atomic','inventory',NULL,
 format('SELECT public.pay_supplier_purchase_atomic(%L,%L,%L,''x'',%L,current_date,0,''efectivo'',NULL,''l3-psp'')',pg_temp.id('A'),gen_random_uuid(),pg_temp.id('owner'),gen_random_uuid()),
 format('SELECT public.pay_supplier_purchase_atomic(%L,%L,%L,''x'',%L,current_date,0,''efectivo'',NULL,''l3-psp-positive'')',pg_temp.id('A'),gen_random_uuid(),pg_temp.id('owner'),gen_random_uuid())),
('replace_comprobante_payment','comprobantes',NULL,
 format('SELECT public.replace_comprobante_payment(%L,%L,''efectivo'',0,0,''ARS'',1,NULL,%L,0,NULL,''l3-rp'')',gen_random_uuid(),pg_temp.id('A'),pg_temp.id('owner')),
 format('SELECT public.replace_comprobante_payment(%L,%L,''efectivo'',0,0,''ARS'',1,NULL,%L,0,NULL,''l3-rp-positive'')',gen_random_uuid(),pg_temp.id('A'),pg_temp.id('owner'))),
('reverse_manual_cash_movement','finance',NULL,
 format('SELECT public.reverse_manual_cash_movement(%L,''l3'')',pg_temp.id('movementA')),
 format('SELECT public.reverse_manual_cash_movement(%L,''l3'')',gen_random_uuid())),
('reverse_operating_expense_atomic','finance',NULL,
 format('SELECT public.reverse_operating_expense_atomic(%L,%L,''l3'',%L,''l3-roe'')',pg_temp.id('A'),gen_random_uuid(),pg_temp.id('owner')),
 format('SELECT public.reverse_operating_expense_atomic(%L,%L,''l3'',%L,''l3-roe-positive'')',pg_temp.id('A'),gen_random_uuid(),pg_temp.id('owner'))),
('reverse_order_payment_atomic','comprobantes',NULL,
 format('SELECT public.reverse_order_payment_atomic(%L,%L,''l3'',%L,''l3-rop'')',pg_temp.id('A'),gen_random_uuid(),pg_temp.id('owner')),
 format('SELECT public.reverse_order_payment_atomic(%L,%L,''l3'',%L,''l3-rop-positive'')',pg_temp.id('A'),gen_random_uuid(),pg_temp.id('owner'))),
('update_inventory_dollar_prices','settings_sensitive',NULL,
 format('SELECT public.update_inventory_dollar_prices(%L,-1)',pg_temp.id('A')),
 format('SELECT public.update_inventory_dollar_prices(%L,-1)',pg_temp.id('A')));

DO $$
DECLARE c rpc_cases%ROWTYPE; actor text; result jsonb; expected boolean; before_hash jsonb;
BEGIN
  PERFORM pg_temp.check_true((SELECT count(*)=25 FROM rpc_cases),'exact 25 RPC cases');

  FOR c IN SELECT * FROM rpc_cases ORDER BY function_name LOOP
    before_hash := pg_temp.fingerprint();
    PERFORM pg_temp.check_true(NOT EXISTS(
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=c.function_name
        AND has_function_privilege('anon',p.oid,'EXECUTE')
    ),c.function_name||' anonymous execute revoked');
    PERFORM pg_temp.check_true(before_hash=pg_temp.fingerprint(),c.function_name||' anonymous ACL ZERO EFFECTS');
    PERFORM pg_temp.deny('inactive','authenticated',c.deny_sql,c.function_name||' inactive');
    PERFORM pg_temp.deny('no_profile','authenticated',c.deny_sql,c.function_name||' no profile');
    PERFORM pg_temp.deny('viewer','authenticated',c.deny_sql,c.function_name||' missing capability');
    PERFORM pg_temp.deny('admin_false','authenticated',c.deny_sql,c.function_name||' explicit false override');

    -- For p_business_id functions the wrapper denies here. Resource-id-only
    -- implementations retain the Lote 2 foreign NOT_FOUND/FORBIDDEN contract.
    PERFORM pg_temp.deny('ownerB','authenticated',c.deny_sql,c.function_name||' foreign tenant');

    before_hash := pg_temp.fingerprint();
    result := pg_temp.call_as('owner','authenticated',c.positive_sql);
    PERFORM pg_temp.check_true(NOT pg_temp.is_denied(result),c.function_name||' authorized owner reaches preserved contract');
    PERFORM pg_temp.check_true(before_hash=pg_temp.fingerprint(),c.function_name||' invalid positive probe has no effects');

    FOREACH actor IN ARRAY ARRAY['owner','admin','manager','tech','sales','cashier','viewer','tech_true'] LOOP
      IF c.function_name = 'finance_pending_historicals' THEN
        expected := actor IN ('owner','admin');
      ELSE
        expected := pg_temp.call_as(actor,'authenticated',format(
          'SELECT to_jsonb(public.current_user_can(%L) AND (%L IS NULL OR public.current_user_can(%L)))',
          c.capability,c.additional_capability,c.additional_capability
        )) #>> '{}' = 'true';
      END IF;
      before_hash := pg_temp.fingerprint();
      result := pg_temp.call_as(actor,'authenticated',c.positive_sql);
      PERFORM pg_temp.check_true(pg_temp.is_denied(result) = NOT expected,
        c.function_name||' role matrix '||actor||' expected='||expected);
      PERFORM pg_temp.check_true(before_hash=pg_temp.fingerprint(),c.function_name||' role probe '||actor||' no effects');
    END LOOP;
  END LOOP;
END $$;

SELECT pg_temp.deny(
  'ownerBasic','authenticated',
  format('SELECT public.generate_finance_insights(%L,current_date,current_date)',pg_temp.id('Basic')),
  'generate_finance_insights missing advancedFinance plan entitlement'
);

-- Structural SECDEF/grant/search_path contract.
DO $$
DECLARE c rpc_cases%ROWTYPE; p record;
BEGIN
  FOR c IN SELECT * FROM rpc_cases LOOP
    SELECT pr.* INTO p FROM pg_proc pr JOIN pg_namespace n ON n.oid=pr.pronamespace
     WHERE n.nspname='public' AND pr.proname=c.function_name;
    PERFORM pg_temp.check_true(p.prosecdef,c.function_name||' remains SECDEF');
    PERFORM pg_temp.check_true(p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'],c.function_name||' hardened search_path');
    PERFORM pg_temp.check_true(NOT has_function_privilege('anon',p.oid,'EXECUTE'),c.function_name||' anon execute revoked');
    PERFORM pg_temp.check_true(has_function_privilege('authenticated',p.oid,'EXECUTE'),c.function_name||' authenticated execute explicit');
    PERFORM pg_temp.check_true(
      position('require_action_authority' in pg_get_functiondef(p.oid))>0
      OR position('has_action_authority' in pg_get_functiondef(p.oid))>0,
      c.function_name||' wrapper gate present');
    IF c.function_name='generate_finance_insights' THEN
      PERFORM pg_temp.check_true(position('advancedFinance' in pg_get_functiondef(p.oid))>0,
        'generate_finance_insights plan entitlement present');
    END IF;
    PERFORM pg_temp.check_true(EXISTS(
      SELECT 1 FROM pg_proc q JOIN pg_namespace n2 ON n2.oid=q.pronamespace
       WHERE n2.nspname='private' AND q.proname=c.function_name
         AND NOT has_function_privilege('authenticated',q.oid,'EXECUTE')
         AND NOT has_function_privilege('service_role',q.oid,'EXECUTE')
    ),c.function_name||' private implementation not directly executable');
  END LOOP;
END $$;

-- is_staff policy negative controls. Each block temporarily restores a
-- representative baseline policy and proves that viewer regains access; the
-- savepoint rollback reinstates the candidate before its matching assertion.
-- Phase C removed the comprobantes INSERT grant and policy outright, so this
-- control restores both halves of the baseline contract before exercising it.
SAVEPOINT old_comprobantes_policy;
GRANT INSERT ON public.comprobantes TO authenticated;
CREATE POLICY comprobantes_insert ON public.comprobantes FOR INSERT TO authenticated
  WITH CHECK (business_id=public.current_business_id() AND public.is_staff());
DO $$ DECLARE r jsonb;
BEGIN
  r := pg_temp.call_as('viewer','authenticated',format(
    'WITH x AS (INSERT INTO public.comprobantes(id,business_id,tipo,estado,status,estado_comercial,total,saldo_pendiente) VALUES(%L,%L,''remito'',''emitido'',''completed'',''pendiente'',1,1) RETURNING id) SELECT to_jsonb(id) FROM x',
    pg_temp.id('oldWrite'),pg_temp.id('A')));
  IF r #>> '{}' <> pg_temp.id('oldWrite')::text THEN
    RAISE EXCEPTION 'negative control: old comprobantes is_staff policy did not restore viewer write: %',r;
  END IF;
END $$;
ROLLBACK TO SAVEPOINT old_comprobantes_policy;

SAVEPOINT old_finance_policy;
DROP POLICY rls_ec ON public.expense_categories;
CREATE POLICY rls_ec ON public.expense_categories TO authenticated
  USING (business_id=public.current_business_id() AND public.is_staff())
  WITH CHECK (business_id=public.current_business_id() AND public.is_staff());
DO $$ DECLARE r jsonb;
BEGIN
  r := pg_temp.call_as('viewer','authenticated',format(
    'WITH x AS (INSERT INTO public.expense_categories(id,business_id,name) VALUES(%L,%L,''old staff write'') RETURNING id) SELECT to_jsonb(id) FROM x',
    pg_temp.id('oldWrite'),pg_temp.id('A')));
  IF r #>> '{}' <> pg_temp.id('oldWrite')::text THEN
    RAISE EXCEPTION 'negative control: old finance is_staff policy did not restore viewer write: %',r;
  END IF;
END $$;
ROLLBACK TO SAVEPOINT old_finance_policy;

SAVEPOINT old_inventory_policy;
DROP POLICY inventory_insert ON public.inventory;
CREATE POLICY inventory_insert ON public.inventory FOR INSERT TO authenticated
  WITH CHECK (business_id=public.current_business_id() AND public.is_staff());
DROP POLICY inventory_select ON public.inventory;
CREATE POLICY inventory_select ON public.inventory FOR SELECT TO authenticated
  USING (business_id=public.current_business_id() AND public.is_staff());
DO $$ DECLARE r jsonb;
BEGIN
  r := pg_temp.call_as('viewer','authenticated',format(
    'WITH x AS (INSERT INTO public.inventory(id,business_id,code,name,category,cost_price,sale_price) VALUES(%L,%L,''OLD-L3'',''old staff write'',''fixture'',1,2) RETURNING id) SELECT to_jsonb(id) FROM x',
    pg_temp.id('oldWrite'),pg_temp.id('A')));
  IF r #>> '{}' <> pg_temp.id('oldWrite')::text THEN
    RAISE EXCEPTION 'negative control: old inventory is_staff policy did not restore viewer write: %',r;
  END IF;
END $$;
ROLLBACK TO SAVEPOINT old_inventory_policy;

SAVEPOINT old_settings_policy;
DROP POLICY rls_drh ON public.dollar_rate_history;
CREATE POLICY rls_drh ON public.dollar_rate_history TO authenticated
  USING (business_id=public.current_business_id() AND public.is_staff())
  WITH CHECK (business_id=public.current_business_id() AND public.is_staff());
DO $$ DECLARE r jsonb;
BEGIN
  r := pg_temp.call_as('viewer','authenticated',format(
    'WITH x AS (INSERT INTO public.dollar_rate_history(id,business_id,sell_price,source) VALUES(%L,%L,1,''old-staff'') RETURNING id) SELECT to_jsonb(id) FROM x',
    pg_temp.id('oldWrite'),pg_temp.id('A')));
  IF r #>> '{}' <> pg_temp.id('oldWrite')::text THEN
    RAISE EXCEPTION 'negative control: old settings is_staff policy did not restore viewer write: %',r;
  END IF;
END $$;
ROLLBACK TO SAVEPOINT old_settings_policy;

SAVEPOINT old_commission_policy;
DROP POLICY payment_commission_groups_select ON public.payment_commission_groups;
DROP POLICY payment_commission_groups_insert ON public.payment_commission_groups;
DROP POLICY payment_commission_groups_update ON public.payment_commission_groups;
DROP POLICY payment_commission_groups_delete ON public.payment_commission_groups;
CREATE POLICY rls_pcg ON public.payment_commission_groups TO authenticated
  USING (business_id=public.current_business_id() AND public.is_staff())
  WITH CHECK (business_id=public.current_business_id() AND public.is_staff());
DO $$ DECLARE r jsonb;
BEGIN
  r := pg_temp.call_as('viewer','authenticated',format(
    'WITH x AS (INSERT INTO public.payment_commission_groups(id,business_id,name) VALUES(%L,%L,''old staff write'') RETURNING id) SELECT to_jsonb(id) FROM x',
    pg_temp.id('oldWrite'),pg_temp.id('A')));
  IF r #>> '{}' <> pg_temp.id('oldWrite')::text THEN
    RAISE EXCEPTION 'negative control: old commission is_staff policy did not restore viewer write: %',r;
  END IF;
END $$;
ROLLBACK TO SAVEPOINT old_commission_policy;

SAVEPOINT old_order_create_policy;
DROP POLICY orders_insert ON public.orders;
CREATE POLICY orders_insert ON public.orders FOR INSERT TO authenticated
  WITH CHECK (business_id=public.current_business_id() AND public.is_staff());
DO $$ DECLARE r jsonb;
BEGIN
  r := pg_temp.call_as('viewer','authenticated',format(
    'WITH x AS (INSERT INTO public.orders(id,business_id,status) VALUES(%L,%L,''new'') RETURNING id) SELECT to_jsonb(id) FROM x',
    pg_temp.id('oldWrite'),pg_temp.id('A')));
  IF r #>> '{}' <> pg_temp.id('oldWrite')::text THEN
    RAISE EXCEPTION 'negative control: old order-create is_staff policy did not restore viewer write: %',r;
  END IF;
END $$;
ROLLBACK TO SAVEPOINT old_order_create_policy;

SAVEPOINT old_order_update_policy;
DROP POLICY orders_update ON public.orders;
CREATE POLICY orders_update ON public.orders FOR UPDATE TO authenticated
  USING (business_id=public.current_business_id() AND public.is_staff())
  WITH CHECK (business_id=public.current_business_id() AND public.is_staff());
DO $$ DECLARE r jsonb;
BEGIN
  r := pg_temp.call_as('viewer','authenticated',format(
    'WITH x AS (UPDATE public.orders SET notes=''old staff write'' WHERE id=%L RETURNING id) SELECT to_jsonb(id) FROM x',pg_temp.id('orderA')));
  IF r #>> '{}' <> pg_temp.id('orderA')::text THEN
    RAISE EXCEPTION 'negative control: old order-update is_staff policy did not restore viewer write: %',r;
  END IF;
END $$;
ROLLBACK TO SAVEPOINT old_order_update_policy;

SAVEPOINT old_tasks_policy;
DROP POLICY tasks_plan_insert ON public.tasks;
CREATE POLICY tasks_plan_insert ON public.tasks FOR INSERT TO PUBLIC
  WITH CHECK (business_id=public.current_user_business_id() AND public.is_staff()
    AND public.business_has_feature('tasks'));
DO $$ DECLARE r jsonb;
BEGIN
  r := pg_temp.call_as('viewer','authenticated',format(
    'WITH x AS (INSERT INTO public.tasks(id,business_id,title) VALUES(%L,%L,''old staff write'') RETURNING id) SELECT to_jsonb(id) FROM x',
    pg_temp.id('oldWrite'),pg_temp.id('A')));
  IF r #>> '{}' <> pg_temp.id('oldWrite')::text THEN
    RAISE EXCEPTION 'negative control: old task is_staff policy did not restore viewer write: %',r;
  END IF;
END $$;
ROLLBACK TO SAVEPOINT old_tasks_policy;

SAVEPOINT old_whatsapp_policy;
DROP POLICY whatsapp_logs_insert ON public.whatsapp_logs;
CREATE POLICY whatsapp_logs_insert ON public.whatsapp_logs FOR INSERT TO PUBLIC
  WITH CHECK (business_id=public.current_business_id() AND public.is_staff());
DROP POLICY whatsapp_logs_select ON public.whatsapp_logs;
CREATE POLICY whatsapp_logs_select ON public.whatsapp_logs FOR SELECT TO PUBLIC
  USING (business_id=public.current_business_id() AND public.is_staff());
DO $$ DECLARE r jsonb;
BEGIN
  r := pg_temp.call_as('viewer','authenticated',format(
    'WITH x AS (INSERT INTO public.whatsapp_logs(id,business_id,message) VALUES(%L,%L,''old staff write'') RETURNING id) SELECT to_jsonb(id) FROM x',
    pg_temp.id('oldWrite'),pg_temp.id('A')));
  IF r #>> '{}' <> pg_temp.id('oldWrite')::text THEN
    RAISE EXCEPTION 'negative control: old WhatsApp is_staff policy did not restore viewer write: %',r;
  END IF;
END $$;
ROLLBACK TO SAVEPOINT old_whatsapp_policy;

-- Sensitive-read negative controls restore all representative baseline reads
-- together, prove exposure, then prove candidate row invisibility.
SAVEPOINT old_sensitive_reads;
DROP POLICY expenses_select ON public.expenses;
CREATE POLICY expenses_select ON public.expenses FOR SELECT TO authenticated
  USING (business_id=public.current_business_id() AND public.is_staff());
DROP POLICY inventory_select ON public.inventory;
CREATE POLICY inventory_select ON public.inventory FOR SELECT TO authenticated
  USING (business_id=public.current_business_id() AND public.is_staff());
DROP POLICY order_payments_select ON public.order_payments;
CREATE POLICY order_payments_select ON public.order_payments FOR SELECT TO authenticated
  USING (business_id=public.current_business_id() AND public.is_staff());
DROP POLICY whatsapp_logs_select ON public.whatsapp_logs;
CREATE POLICY whatsapp_logs_select ON public.whatsapp_logs FOR SELECT TO PUBLIC
  USING (business_id=public.current_business_id() AND public.is_staff());
DROP POLICY wc_staff_read ON public.wholesale_customers;
CREATE POLICY wc_staff_read ON public.wholesale_customers FOR SELECT TO authenticated
  USING (business_id=public.current_user_business_id() AND public.is_staff()
    AND public.business_has_feature('mayorista'));
DO $$
DECLARE r jsonb; probe record;
BEGIN
  FOR probe IN SELECT * FROM (VALUES
    ('expenses',pg_temp.id('expenseA')),
    ('inventory',pg_temp.id('inventoryA')),
    ('order_payments',pg_temp.id('orderPaymentA')),
    ('whatsapp_logs',pg_temp.id('whatsappA')),
    ('wholesale_customers',pg_temp.id('wholesaleA'))
  ) AS v(table_name,row_id) LOOP
    r := pg_temp.call_as('viewer','authenticated',format(
      'SELECT to_jsonb(count(*)) FROM public.%I WHERE id=%L',probe.table_name,probe.row_id));
    IF r #>> '{}' <> '1' THEN
      RAISE EXCEPTION 'negative control: old % is_staff read did not expose viewer row: %',probe.table_name,r;
    END IF;
  END LOOP;
END $$;
ROLLBACK TO SAVEPOINT old_sensitive_reads;

DO $$
DECLARE r jsonb; before_hash jsonb; probe record;
BEGIN
  before_hash := pg_temp.fingerprint();
  FOR probe IN SELECT * FROM (VALUES
    ('expenses',pg_temp.id('expenseA')),
    ('inventory',pg_temp.id('inventoryA')),
    ('order_payments',pg_temp.id('orderPaymentA')),
    ('whatsapp_logs',pg_temp.id('whatsappA')),
    ('wholesale_customers',pg_temp.id('wholesaleA')),
    ('payment_commission_groups',pg_temp.id('commissionA'))
  ) AS v(table_name,row_id) LOOP
    r := pg_temp.call_as('viewer','authenticated',format(
      'SELECT to_jsonb(count(*)) FROM public.%I WHERE id=%L',probe.table_name,probe.row_id));
    PERFORM pg_temp.check_true(r #>> '{}' = '0','candidate '||probe.table_name||' sensitive read hidden from viewer');
  END LOOP;

  FOR probe IN SELECT * FROM (VALUES
    ('comprobantes','(id,business_id,tipo,estado,status,estado_comercial,total,saldo_pendiente)',
      format('(%L,%L,''remito'',''emitido'',''completed'',''pendiente'',1,1)',pg_temp.id('oldWrite'),pg_temp.id('A'))),
    ('expense_categories','(id,business_id,name)',format('(%L,%L,''candidate deny'')',pg_temp.id('oldWrite'),pg_temp.id('A'))),
    ('inventory','(id,business_id,code,name,category,cost_price,sale_price)',format('(%L,%L,''DENY-L3'',''candidate deny'',''fixture'',1,2)',pg_temp.id('oldWrite'),pg_temp.id('A'))),
    ('dollar_rate_history','(id,business_id,sell_price,source)',format('(%L,%L,1,''candidate-deny'')',pg_temp.id('oldWrite'),pg_temp.id('A'))),
    ('payment_commission_groups','(id,business_id,name)',format('(%L,%L,''candidate deny'')',pg_temp.id('oldWrite'),pg_temp.id('A'))),
    ('orders','(id,business_id,status)',format('(%L,%L,''new'')',pg_temp.id('oldWrite'),pg_temp.id('A'))),
    ('tasks','(id,business_id,title)',format('(%L,%L,''candidate deny'')',pg_temp.id('oldWrite'),pg_temp.id('A'))),
    ('whatsapp_logs','(id,business_id,message)',format('(%L,%L,''candidate deny'')',pg_temp.id('oldWrite'),pg_temp.id('A')))
  ) AS v(table_name,columns_sql,values_sql) LOOP
    r := pg_temp.call_as('viewer','authenticated',format(
      'WITH x AS (INSERT INTO public.%I %s VALUES %s RETURNING id) SELECT to_jsonb(id) FROM x',
      probe.table_name,probe.columns_sql,probe.values_sql));
    PERFORM pg_temp.check_true(r->>'sqlstate'='42501','candidate '||probe.table_name||' write denied to viewer');
  END LOOP;

  r := pg_temp.call_as('viewer','authenticated',format(
    'WITH x AS (UPDATE public.orders SET notes=''candidate deny'' WHERE id=%L RETURNING id) SELECT to_jsonb(id) FROM x',pg_temp.id('orderA')));
  PERFORM pg_temp.check_true(r IS NULL,'candidate orders update invisible to viewer');
  PERFORM pg_temp.check_true(before_hash=pg_temp.fingerprint(),'candidate is_staff policy probes ZERO EFFECTS');
END $$;

-- payment_transactions original-flaw negative control, entirely local and
-- rolled back to a savepoint before testing the candidate contract.
SAVEPOINT before_old_payment_contract;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payment_transactions TO authenticated;
CREATE POLICY pt_select_old_control ON public.payment_transactions FOR SELECT TO authenticated
  USING (business_id=public.current_user_business_id());
CREATE POLICY pt_write_old_control ON public.payment_transactions TO authenticated
  USING (business_id=public.current_user_business_id())
  WITH CHECK (business_id=public.current_user_business_id());

DO $$
DECLARE r jsonb;
BEGIN
  r := pg_temp.call_as('viewer','authenticated',format(
    'WITH x AS (INSERT INTO public.payment_transactions(id,business_id,comprobante_id,status,transaction_amount,net_amount_estimated,currency) VALUES(%L,%L,%L,''pending'',100,95,''ARS'') RETURNING id) SELECT jsonb_build_object(''id'',id) FROM x',
    pg_temp.id('pt_old'),pg_temp.id('A'),pg_temp.id('compPT')));
  PERFORM pg_temp.check_true(r->>'id'=pg_temp.id('pt_old')::text,'negative control old member INSERT succeeds');
  r := pg_temp.call_as('viewer','authenticated',format(
    'WITH x AS (UPDATE public.payment_transactions SET status=''approved'',approved_at=now(),fee_amount_estimated=5 WHERE id=%L RETURNING id) SELECT jsonb_build_object(''id'',id) FROM x',
    pg_temp.id('pt_old')));
  PERFORM pg_temp.check_true(r->>'id'=pg_temp.id('pt_old')::text,'negative control old approved UPDATE succeeds');
  PERFORM pg_temp.check_true((SELECT count(*)>0 FROM public.financial_movements WHERE payment_transaction_id=pg_temp.id('pt_old')),'negative control produces financial_movements');
  PERFORM pg_temp.check_true((SELECT count(*)>0 FROM public.business_finance_entries WHERE reference_comprobante_id=pg_temp.id('compPT')),'negative control produces business_finance_entries');
  PERFORM pg_temp.check_true((SELECT payment_status='paid' FROM public.comprobantes WHERE id=pg_temp.id('compPT')),'negative control marks comprobante paid');
END $$;

ROLLBACK TO SAVEPOINT before_old_payment_contract;

DO $$
DECLARE before_hash jsonb := pg_temp.fingerprint(); r jsonb;
BEGIN
  r := pg_temp.call_as('viewer','authenticated',format(
    'WITH x AS (INSERT INTO public.payment_transactions(id,business_id,status,transaction_amount,net_amount_estimated,currency) VALUES(%L,%L,''approved'',100,100,''ARS'') RETURNING id) SELECT to_jsonb(id) FROM x',
    pg_temp.id('pt_old'),pg_temp.id('A')));
  PERFORM pg_temp.check_true(r->>'sqlstate'='42501','candidate authenticated INSERT denied');
  r := pg_temp.call_as('viewer','authenticated',format(
    'WITH x AS (UPDATE public.payment_transactions SET status=''approved'' WHERE id=%L RETURNING id) SELECT to_jsonb(id) FROM x',
    pg_temp.id('pt_candidate')));
  PERFORM pg_temp.check_true(r->>'sqlstate'='42501','candidate authenticated UPDATE denied');
  PERFORM pg_temp.check_true(before_hash=pg_temp.fingerprint(),'candidate payment attempts ZERO EFFECTS');
  PERFORM pg_temp.check_true(NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.payment_transactions'::regclass AND polcmd<>'r'),'payment_transactions has no write policy');
  PERFORM pg_temp.check_true(NOT has_table_privilege('authenticated','public.payment_transactions','INSERT,UPDATE,DELETE'),'authenticated payment_transactions DML grants revoked');
END $$;

-- Phase B blocker 1: the old direct supplier DELETE bypasses stock/debt/audit.
SAVEPOINT before_old_supplier_delete;
GRANT DELETE ON public.supplier_purchases, public.supplier_purchase_items TO authenticated;
CREATE POLICY supplier_purchases_old_delete_control
  ON public.supplier_purchases FOR DELETE TO authenticated
  USING (business_id=public.current_business_id() AND public.current_user_can('inventory'));
CREATE POLICY supplier_purchase_items_old_delete_control
  ON public.supplier_purchase_items FOR DELETE TO authenticated
  USING (business_id=public.current_business_id() AND public.current_user_can('inventory'));

DO $$ DECLARE r jsonb;
BEGIN
  r:=pg_temp.call_as('sales','authenticated',format(
    'WITH x AS (DELETE FROM public.supplier_purchases WHERE id=%L RETURNING id) SELECT to_jsonb(id) FROM x',
    pg_temp.id('purchaseExploit')));
  PERFORM pg_temp.check_true(r#>>'{}'=pg_temp.id('purchaseExploit')::text,
    'negative control old supplier direct DELETE succeeds');
  PERFORM pg_temp.check_true(NOT EXISTS(SELECT 1 FROM public.supplier_purchases WHERE id=pg_temp.id('purchaseExploit')),
    'negative control deletes supplier purchase');
  PERFORM pg_temp.check_true(NOT EXISTS(SELECT 1 FROM public.supplier_purchase_items WHERE purchase_id=pg_temp.id('purchaseExploit')),
    'negative control cascades supplier items');
  PERFORM pg_temp.check_true(EXISTS(SELECT 1 FROM public.supplier_account_movements WHERE description='Exploit debt' AND purchase_id IS NULL)
    AND EXISTS(SELECT 1 FROM public.supplier_payments WHERE id=pg_temp.id('supplierPaymentExploit') AND purchase_id IS NULL)
    AND EXISTS(SELECT 1 FROM public.expenses WHERE id=pg_temp.id('supplierExpenseExploit') AND supplier_purchase_id IS NULL),
    'negative control detaches debt payment and expense');
  PERFORM pg_temp.check_true((SELECT stock_quantity=10 FROM public.inventory WHERE id=pg_temp.id('inventoryA'))
    AND NOT EXISTS(SELECT 1 FROM public.inventory_movements WHERE reference_id=pg_temp.id('purchaseExploit'))
    AND NOT EXISTS(SELECT 1 FROM public.supplier_purchase_deletions WHERE purchase_id=pg_temp.id('purchaseExploit')),
    'negative control skips stock reversal and deletion tombstone');
END $$;

ROLLBACK TO SAVEPOINT before_old_supplier_delete;

DO $$ DECLARE actor text; before_hash jsonb; r jsonb;
BEGIN
  FOREACH actor IN ARRAY ARRAY['owner','admin','manager','tech','sales','cashier','viewer','inactive','ownerB'] LOOP
    before_hash:=pg_temp.fingerprint();
    r:=pg_temp.call_as(actor,'authenticated',format(
      'WITH x AS (DELETE FROM public.supplier_purchases WHERE id=%L RETURNING id) SELECT to_jsonb(id) FROM x',
      pg_temp.id('purchaseExploit')));
    PERFORM pg_temp.check_true(pg_temp.is_denied(r),actor||' supplier purchase direct DELETE denied');
    PERFORM pg_temp.check_true(before_hash=pg_temp.fingerprint(),actor||' supplier purchase DELETE ZERO EFFECTS');

    r:=pg_temp.call_as(actor,'authenticated',format(
      'WITH x AS (DELETE FROM public.supplier_purchase_items WHERE purchase_id=%L RETURNING id) SELECT to_jsonb(id) FROM x',
      pg_temp.id('purchaseSafe')));
    PERFORM pg_temp.check_true(pg_temp.is_denied(r),actor||' supplier item direct DELETE denied');
    PERFORM pg_temp.check_true(before_hash=pg_temp.fingerprint(),actor||' supplier item DELETE ZERO EFFECTS');
  END LOOP;
  PERFORM pg_temp.deny(NULL,'anon',format(
    'WITH x AS (DELETE FROM public.supplier_purchases WHERE id=%L RETURNING id) SELECT to_jsonb(id) FROM x',
    pg_temp.id('purchaseExploit')),'anonymous supplier purchase DELETE');

  r:=pg_temp.call_as('manager','authenticated',format(
    'SELECT public.delete_supplier_purchase_safe(%L,%L,%L)',
    pg_temp.id('A'),pg_temp.id('purchaseSafe'),pg_temp.id('manager')));
  PERFORM pg_temp.check_true(r->>'ok'='true' AND r->>'replay'='false','canonical supplier safe delete succeeds');
  PERFORM pg_temp.check_true(NOT EXISTS(SELECT 1 FROM public.supplier_purchases WHERE id=pg_temp.id('purchaseSafe'))
    AND NOT EXISTS(SELECT 1 FROM public.supplier_purchase_items WHERE purchase_id=pg_temp.id('purchaseSafe'))
    AND NOT EXISTS(SELECT 1 FROM public.supplier_account_movements WHERE purchase_id=pg_temp.id('purchaseSafe')),
    'canonical supplier safe delete removes purchase items and debt');
  PERFORM pg_temp.check_true((SELECT stock_quantity=8 FROM public.inventory WHERE id=pg_temp.id('inventoryA'))
    AND EXISTS(SELECT 1 FROM public.inventory_movements WHERE reference_id=pg_temp.id('purchaseSafe'))
    AND EXISTS(SELECT 1 FROM public.supplier_purchase_deletions WHERE purchase_id=pg_temp.id('purchaseSafe') AND user_id=pg_temp.id('manager')),
    'canonical supplier safe delete reverses stock and writes tombstone');
END $$;

-- Phase B blocker 2: old table-level UPDATE forges canonical payment/fiscal truth.
SAVEPOINT before_old_comprobante_update;
GRANT UPDATE ON public.comprobantes TO authenticated;

DO $$ DECLARE actor text; r jsonb;
BEGIN
  FOREACH actor IN ARRAY ARRAY['sales','cashier'] LOOP
    r:=pg_temp.call_as(actor,'authenticated',format(
      'WITH x AS (UPDATE public.comprobantes SET total=1,total_cobrado=1000,saldo_pendiente=0,payment_status=''paid'',cae=''FORGED'',numero_fiscal=''X-1'' WHERE id=%L RETURNING id) SELECT to_jsonb(id) FROM x',
      pg_temp.id('compForge')));
    PERFORM pg_temp.check_true(r#>>'{}'=pg_temp.id('compForge')::text,
      'negative control old comprobantes UPDATE succeeds as '||actor);
    PERFORM pg_temp.check_true((SELECT total=1 AND total_cobrado=1000 AND saldo_pendiente=0
      AND payment_status='paid' AND cae='FORGED' AND numero_fiscal='X-1'
      FROM public.comprobantes WHERE id=pg_temp.id('compForge')),
      'negative control forges comprobante canonical fields as '||actor);
    PERFORM pg_temp.check_true(NOT EXISTS(SELECT 1 FROM public.comprobante_payments WHERE comprobante_id=pg_temp.id('compForge'))
      AND NOT EXISTS(SELECT 1 FROM public.financial_movements WHERE reference_id=pg_temp.id('compForge'))
      AND NOT EXISTS(SELECT 1 FROM public.business_finance_entries WHERE reference_comprobante_id=pg_temp.id('compForge')),
      'negative control forged state has no canonical ledger as '||actor);
    UPDATE public.comprobantes SET total=100,total_cobrado=0,saldo_pendiente=100,payment_status='pending',cae=NULL,numero_fiscal=NULL
      WHERE id=pg_temp.id('compForge');
  END LOOP;
END $$;

ROLLBACK TO SAVEPOINT before_old_comprobante_update;

DO $$ DECLARE actor text; before_hash jsonb; r jsonb;
BEGIN
  FOREACH actor IN ARRAY ARRAY['owner','admin','manager','tech','sales','cashier','viewer','inactive','ownerB'] LOOP
    before_hash:=pg_temp.fingerprint();
    r:=pg_temp.call_as(actor,'authenticated',format(
      'WITH x AS (UPDATE public.comprobantes SET total=1,total_cobrado=1000,saldo_pendiente=0,payment_status=''paid'',cae=''FORGED'',numero_fiscal=''X-1'' WHERE id=%L RETURNING id) SELECT to_jsonb(id) FROM x',
      pg_temp.id('compForge')));
    PERFORM pg_temp.check_true(pg_temp.is_denied(r),actor||' protected comprobantes UPDATE denied');
    PERFORM pg_temp.check_true(before_hash=pg_temp.fingerprint(),actor||' protected comprobantes UPDATE ZERO EFFECTS');
  END LOOP;
  PERFORM pg_temp.deny(NULL,'anon',format(
    'WITH x AS (UPDATE public.comprobantes SET total=1 WHERE id=%L RETURNING id) SELECT to_jsonb(id) FROM x',
    pg_temp.id('compForge')),'anonymous protected comprobantes UPDATE');

  r:=pg_temp.call_as('sales','authenticated',format(
    'WITH x AS (UPDATE public.comprobantes SET observaciones=''descriptive-safe'',updated_at=now() WHERE id=%L RETURNING observaciones) SELECT to_jsonb(observaciones) FROM x',
    pg_temp.id('compForge')));
  PERFORM pg_temp.check_true(r#>>'{}'='descriptive-safe','safe comprobante descriptive UPDATE remains');

  r:=pg_temp.call_as('cashier','authenticated',format(
    'SELECT public.issue_remito_atomic(%L,%L)',pg_temp.id('compDraft'),pg_temp.id('A')));
  PERFORM pg_temp.check_true(r->>'ok'='true' AND r->>'replay'='false','canonical remito issue succeeds');
  PERFORM pg_temp.check_true((SELECT estado='emitido' AND status='issued' AND estado_fiscal='no_fiscal'
    FROM public.comprobantes WHERE id=pg_temp.id('compDraft')),'canonical remito issue owns state transition');
END $$;

-- Phase B blocker 3: old cp_insert lets a viewer manufacture ledger state.
SAVEPOINT before_old_cp_insert;
GRANT INSERT ON public.comprobante_payments TO authenticated;
CREATE POLICY cp_insert_old_control ON public.comprobante_payments FOR INSERT TO authenticated
  WITH CHECK (business_id=public.current_user_business_id());

DO $$ DECLARE r jsonb;
BEGIN
  r:=pg_temp.call_as('viewer','authenticated',format(
    'INSERT INTO public.comprobante_payments(id,comprobante_id,business_id,amount,amount_ars,payment_method,created_by) VALUES(%L,%L,%L,100,100,''efectivo'',%L) RETURNING jsonb_build_object(''ok'',true)',
    pg_temp.id('cpOld'),pg_temp.id('compCP'),pg_temp.id('A'),pg_temp.id('viewer')));
  PERFORM pg_temp.check_true(EXISTS(SELECT 1 FROM public.comprobante_payments WHERE id=pg_temp.id('cpOld')),
    'negative control old cp_insert viewer succeeds');
  PERFORM pg_temp.check_true((SELECT estado_comercial='pagado' AND total_cobrado=100 AND saldo_pendiente=0
    FROM public.comprobantes WHERE id=pg_temp.id('compCP')),'negative control cp_insert marks comprobante paid');
  PERFORM pg_temp.check_true(EXISTS(SELECT 1 FROM public.financial_movements WHERE comprobante_id=pg_temp.id('compCP'))
    AND EXISTS(SELECT 1 FROM public.business_finance_entries WHERE reference_comprobante_id=pg_temp.id('compCP')),
    'negative control cp_insert creates canonical finance effects');
END $$;

ROLLBACK TO SAVEPOINT before_old_cp_insert;

DO $$ DECLARE actor text; before_hash jsonb; r jsonb;
BEGIN
  FOREACH actor IN ARRAY ARRAY['owner','admin','manager','tech','sales','cashier','viewer','inactive','ownerB'] LOOP
    before_hash:=pg_temp.fingerprint();
    r:=pg_temp.call_as(actor,'authenticated',format(
      'WITH x AS (INSERT INTO public.comprobante_payments(comprobante_id,business_id,amount,amount_ars,payment_method,created_by) VALUES(%L,%L,100,100,''efectivo'',%L) RETURNING id) SELECT to_jsonb(id) FROM x',
      pg_temp.id('compCP'),pg_temp.id('A'),pg_temp.id(actor)));
    PERFORM pg_temp.check_true(pg_temp.is_denied(r),actor||' direct comprobante payment INSERT denied');
    PERFORM pg_temp.check_true(before_hash=pg_temp.fingerprint(),actor||' direct comprobante payment INSERT ZERO EFFECTS');
  END LOOP;
  PERFORM pg_temp.deny(NULL,'anon',format(
    'WITH x AS (INSERT INTO public.comprobante_payments(comprobante_id,business_id,amount,amount_ars,payment_method) VALUES(%L,%L,100,100,''efectivo'') RETURNING id) SELECT to_jsonb(id) FROM x',
    pg_temp.id('compCP'),pg_temp.id('A')),'anonymous comprobante payment INSERT');

  r:=pg_temp.call_as('cashier','authenticated',format(
    'SELECT public.replace_comprobante_payment(%L,%L,''efectivo'',100,100,''ARS'',1,''canonical positive'',%L,0,NULL,''l3b-payment-positive'')',
    pg_temp.id('compCP'),pg_temp.id('A'),pg_temp.id('cashier')));
  PERFORM pg_temp.check_true(r->>'ok'='true','canonical comprobante payment replacement/creation succeeds');
  PERFORM pg_temp.check_true((SELECT count(*)=1 FROM public.comprobante_payments WHERE comprobante_id=pg_temp.id('compCP') AND replaced_at IS NULL)
    AND (SELECT estado_comercial='pagado' AND total_cobrado=100 AND saldo_pendiente=0 FROM public.comprobantes WHERE id=pg_temp.id('compCP')),
    'canonical payment produces reconciled comprobante state');
  PERFORM pg_temp.check_true(EXISTS(SELECT 1 FROM public.financial_movements WHERE comprobante_id=pg_temp.id('compCP'))
    AND EXISTS(SELECT 1 FROM public.business_finance_entries WHERE reference_comprobante_id=pg_temp.id('compCP')),
    'canonical payment produces ledger effects');
END $$;

-- Bounded corrections: owner/admin diagnostic, no transaction read surface,
-- canonical identity resolution, and non-spoofable service role bypass.
DO $$ DECLARE actor text; r jsonb; expected boolean; before_hash jsonb;
BEGIN
  FOREACH actor IN ARRAY ARRAY['owner','admin','manager','tech','sales','cashier','viewer'] LOOP
    before_hash:=pg_temp.fingerprint();
    r:=pg_temp.call_as(actor,'authenticated',format(
      'SELECT public.finance_pending_historicals(%L)',pg_temp.id('A')));
    expected:=actor IN ('owner','admin');
    PERFORM pg_temp.check_true(pg_temp.is_denied(r)=NOT expected,
      'finance_pending_historicals owner/admin matrix '||actor);
    PERFORM pg_temp.check_true(before_hash=pg_temp.fingerprint(),
      'finance_pending_historicals read-only '||actor);
  END LOOP;

  FOREACH actor IN ARRAY ARRAY['owner','admin','manager','tech','sales','cashier','viewer','inactive','ownerB'] LOOP
    r:=pg_temp.call_as(actor,'authenticated','SELECT coalesce(jsonb_agg(t),''[]''::jsonb) FROM public.payment_transactions t');
    PERFORM pg_temp.check_true(pg_temp.is_denied(r),actor||' payment_transactions direct SELECT denied');
  END LOOP;
  PERFORM pg_temp.deny(NULL,'anon','SELECT coalesce(jsonb_agg(t),''[]''::jsonb) FROM public.payment_transactions t',
    'anonymous payment_transactions SELECT');
  r:=pg_temp.call_with_claim(NULL,'service_role','service_role',
    'SELECT coalesce(jsonb_agg(t),''[]''::jsonb) FROM public.payment_transactions t');
  PERFORM pg_temp.check_true(jsonb_typeof(r)='array','service_role payment transaction history preserved');

  r:=pg_temp.call_with_claim('viewer','authenticated','service_role',format(
    'SELECT public.finance_dashboard_summary(%L,current_date,current_date)',pg_temp.id('A')));
  PERFORM pg_temp.check_true(pg_temp.is_denied(r),'authenticated DB role cannot forge service-role bypass');
  r:=pg_temp.call_with_claim(NULL,'service_role','service_role',format(
    'SELECT public.finance_dashboard_summary(%L,current_date,current_date)',pg_temp.id('A')));
  PERFORM pg_temp.check_true(COALESCE(r->>'sqlstate','')<>'42501'
    AND COALESCE(r->>'error_code','')<>'FORBIDDEN',
    'real service_role reaches preserved implementation contract');

  r:=pg_temp.call_as('legacyActor','authenticated',format(
    'SELECT public.finance_dashboard_summary(%L,current_date,current_date)',pg_temp.id('B')));
  PERFORM pg_temp.check_true(NOT pg_temp.is_denied(r),'canonical duplicate/legacy profile selects newest business B');
  r:=pg_temp.call_as('legacyActor','authenticated',format(
    'SELECT public.finance_dashboard_summary(%L,current_date,current_date)',pg_temp.id('A')));
  PERFORM pg_temp.check_true(pg_temp.is_denied(r),'canonical duplicate/legacy profile rejects stale business A');
END $$;

-- Exact grants/policies/column boundary after Phase B.
DO $$ DECLARE v_columns text[]; v_gate text; v_predicate text; v_pending text;
BEGIN
  PERFORM pg_temp.check_true(NOT has_table_privilege('authenticated','public.supplier_purchases','DELETE')
    AND NOT has_table_privilege('authenticated','public.supplier_purchase_items','DELETE'),
    'supplier purchase tables have no authenticated DELETE grant');
  PERFORM pg_temp.check_true(NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid IN
    ('public.supplier_purchases'::regclass,'public.supplier_purchase_items'::regclass) AND polcmd IN ('d','*')),
    'supplier purchase tables have no permissive DELETE policy');
  PERFORM pg_temp.check_true(NOT has_table_privilege('authenticated','public.comprobantes','UPDATE'),
    'comprobantes has no table-level authenticated UPDATE');
  SELECT array_agg(column_name ORDER BY column_name) INTO v_columns
    FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='comprobantes'
     AND grantee='authenticated' AND privilege_type='UPDATE';
  PERFORM pg_temp.check_true(v_columns=ARRAY['observaciones','updated_at'],
    'comprobantes exact safe UPDATE column allowlist');
  PERFORM pg_temp.check_true(NOT has_column_privilege('authenticated','public.comprobantes','total','UPDATE')
    AND NOT has_column_privilege('authenticated','public.comprobantes','total_cobrado','UPDATE')
    AND NOT has_column_privilege('authenticated','public.comprobantes','saldo_pendiente','UPDATE')
    AND NOT has_column_privilege('authenticated','public.comprobantes','payment_status','UPDATE')
    AND NOT has_column_privilege('authenticated','public.comprobantes','cae','UPDATE')
    AND NOT has_column_privilege('authenticated','public.comprobantes','numero_fiscal','UPDATE')
    AND NOT has_column_privilege('authenticated','public.comprobantes','estado','UPDATE')
    AND NOT has_column_privilege('authenticated','public.comprobantes','status','UPDATE'),
    'comprobantes canonical financial fiscal and state columns protected');
  PERFORM pg_temp.check_true(NOT has_table_privilege('authenticated','public.comprobante_payments','INSERT')
    AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.comprobante_payments'::regclass AND polcmd IN ('a','*')),
    'comprobante_payments has no authenticated INSERT path');
  PERFORM pg_temp.check_true(NOT has_table_privilege('authenticated','public.payment_transactions','SELECT')
    AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.payment_transactions'::regclass AND polcmd IN ('r','*')),
    'payment_transactions has no browser SELECT path');
  PERFORM pg_temp.check_true(has_table_privilege('service_role','public.payment_transactions','SELECT,INSERT,UPDATE,DELETE'),
    'payment_transactions service-role storage contract preserved');

  SELECT pg_get_functiondef('private.require_action_authority(uuid,text,text,text)'::regprocedure) INTO v_gate;
  SELECT pg_get_functiondef('private.has_action_authority(uuid,text,text,text)'::regprocedure) INTO v_predicate;
  PERFORM pg_temp.check_true(v_gate LIKE '%private.has_action_authority%'
    AND v_predicate LIKE '%get_my_profile()%'
    AND v_predicate LIKE '%current_setting(''role'', true)%'
    AND v_predicate NOT LIKE '%auth.role() = ''service_role''%',
    'authority gate uses canonical business and effective DB role');
  SELECT pg_get_functiondef('public.finance_pending_historicals(uuid)'::regprocedure) INTO v_pending;
  PERFORM pg_temp.check_true(v_pending LIKE '%v_role NOT IN (%'
    AND v_pending LIKE '%''owner''%' AND v_pending LIKE '%''admin''%',
    'finance pending historicals restores owner/admin authority');
  PERFORM pg_temp.check_true(has_function_privilege('authenticated','public.issue_remito_atomic(uuid,uuid)','EXECUTE')
    AND NOT has_function_privilege('anon','public.issue_remito_atomic(uuid,uuid)','EXECUTE'),
    'issue_remito_atomic exact browser execution grant');
END $$;

-- ===========================================================================
-- Phase C: comprobante creation and destruction are canonical-only.
-- ===========================================================================
INSERT INTO pg_temp.ids(name) VALUES ('compForgedOld'),('compForgedNew'),('compDeleteOk');

-- Phase C blocker 4: the old direct INSERT fabricated fiscal identity and
-- collection truth on a row that persists, with no canonical ledger behind it.
SAVEPOINT before_old_comprobante_insert;
GRANT INSERT ON public.comprobantes TO authenticated;
CREATE POLICY comprobantes_insert_old_control ON public.comprobantes FOR INSERT TO authenticated
  WITH CHECK (business_id=public.current_business_id() AND public.current_user_can('comprobantes'));

DO $$ DECLARE r jsonb;
BEGIN
  r:=pg_temp.call_as('sales','authenticated',format(
    'WITH x AS (INSERT INTO public.comprobantes(id,business_id,tipo,estado,status,estado_comercial,'
    ||'estado_fiscal,es_fiscal,cae,numero_fiscal,total,total_cobrado,saldo_pendiente,payment_status) '
    ||'VALUES(%L,%L,''factura_c'',''emitido'',''completed'',''pagado'',''emitido'',true,'
    ||'''75123456789012'',''00001-00099999'',999999,999999,0,''paid'') RETURNING id) SELECT to_jsonb(id) FROM x',
    pg_temp.id('compForgedOld'),pg_temp.id('A')));
  PERFORM pg_temp.check_true(r#>>'{}'=pg_temp.id('compForgedOld')::text,
    'negative control old comprobantes direct INSERT succeeds as sales');
  PERFORM pg_temp.check_true((SELECT cae='75123456789012' AND numero_fiscal='00001-00099999'
      AND estado_fiscal='emitido' AND es_fiscal AND total_cobrado=999999
      AND estado_comercial='pagado' AND payment_status='paid'
    FROM public.comprobantes WHERE id=pg_temp.id('compForgedOld')),
    'negative control forges fiscal identity and collection truth at creation');
  PERFORM pg_temp.check_true(NOT EXISTS(SELECT 1 FROM public.comprobante_payments WHERE comprobante_id=pg_temp.id('compForgedOld'))
    AND NOT EXISTS(SELECT 1 FROM public.financial_movements WHERE comprobante_id=pg_temp.id('compForgedOld'))
    AND NOT EXISTS(SELECT 1 FROM public.business_finance_entries WHERE reference_comprobante_id=pg_temp.id('compForgedOld')),
    'negative control forged document carries no canonical ledger');
END $$;

ROLLBACK TO SAVEPOINT before_old_comprobante_insert;

DO $$ DECLARE actor text; before_hash jsonb; r jsonb; stmt text;
BEGIN
  stmt:='WITH x AS (INSERT INTO public.comprobantes(id,business_id,tipo,estado,status,estado_comercial,'
    ||'estado_fiscal,es_fiscal,cae,numero_fiscal,total,total_cobrado,saldo_pendiente,payment_status) '
    ||'VALUES(%L,%L,''factura_c'',''emitido'',''completed'',''pagado'',''emitido'',true,'
    ||'''75123456789012'',''00001-00099999'',999999,999999,0,''paid'') RETURNING id) SELECT to_jsonb(id) FROM x';
  FOREACH actor IN ARRAY ARRAY['owner','admin','manager','tech','sales','cashier','viewer','inactive','ownerB'] LOOP
    before_hash:=pg_temp.fingerprint();
    r:=pg_temp.call_as(actor,'authenticated',format(stmt,pg_temp.id('compForgedNew'),pg_temp.id('A')));
    PERFORM pg_temp.check_true(pg_temp.is_denied(r),actor||' forged comprobante direct INSERT denied');
    PERFORM pg_temp.check_true(before_hash=pg_temp.fingerprint(),actor||' forged comprobante INSERT ZERO EFFECTS');
  END LOOP;
  PERFORM pg_temp.deny(NULL,'anon',format(stmt,pg_temp.id('compForgedNew'),pg_temp.id('A')),
    'anonymous forged comprobante INSERT');
  PERFORM pg_temp.check_true(NOT EXISTS(SELECT 1 FROM public.comprobantes WHERE id=pg_temp.id('compForgedNew')),
    'no forged comprobante row exists after the full actor matrix');
END $$;

-- Phase C blocker 5: the old direct DELETE destroyed a comprobante that the
-- canonical reversal explicitly refuses to touch.
SAVEPOINT before_old_comprobante_delete;
GRANT DELETE ON public.comprobantes TO authenticated;
CREATE POLICY comprobantes_delete_old_control ON public.comprobantes FOR DELETE TO authenticated
  USING (business_id=public.current_business_id() AND public.can_manage());

DO $$ DECLARE r jsonb;
BEGIN
  r:=pg_temp.call_as('manager','authenticated',format(
    'SELECT public.delete_comprobante_with_finance(%L)',pg_temp.id('compA')));
  PERFORM pg_temp.check_true(r->>'success'='false',
    'negative control canonical delete refuses this comprobante');
  PERFORM pg_temp.check_true(EXISTS(SELECT 1 FROM public.comprobantes WHERE id=pg_temp.id('compA')),
    'negative control canonical refusal leaves the row intact');

  r:=pg_temp.call_as('manager','authenticated',format(
    'WITH x AS (DELETE FROM public.comprobantes WHERE id=%L RETURNING id) SELECT to_jsonb(id) FROM x',
    pg_temp.id('compA')));
  PERFORM pg_temp.check_true(r#>>'{}'=pg_temp.id('compA')::text,
    'negative control old comprobantes direct DELETE succeeds as manager');
  PERFORM pg_temp.check_true(NOT EXISTS(SELECT 1 FROM public.comprobantes WHERE id=pg_temp.id('compA')),
    'negative control destroys a comprobante the canonical path protects');
END $$;

ROLLBACK TO SAVEPOINT before_old_comprobante_delete;

DO $$ DECLARE actor text; before_hash jsonb; r jsonb;
BEGIN
  FOREACH actor IN ARRAY ARRAY['owner','admin','manager','tech','sales','cashier','viewer','inactive','ownerB'] LOOP
    before_hash:=pg_temp.fingerprint();
    r:=pg_temp.call_as(actor,'authenticated',format(
      'WITH x AS (DELETE FROM public.comprobantes WHERE id=%L RETURNING id) SELECT to_jsonb(id) FROM x',
      pg_temp.id('compA')));
    PERFORM pg_temp.check_true(pg_temp.is_denied(r),actor||' comprobante direct DELETE denied');
    PERFORM pg_temp.check_true(before_hash=pg_temp.fingerprint(),actor||' comprobante direct DELETE ZERO EFFECTS');
  END LOOP;
  PERFORM pg_temp.deny(NULL,'anon',format(
    'WITH x AS (DELETE FROM public.comprobantes WHERE id=%L RETURNING id) SELECT to_jsonb(id) FROM x',
    pg_temp.id('compA')),'anonymous comprobante DELETE');
  PERFORM pg_temp.check_true(EXISTS(SELECT 1 FROM public.comprobantes WHERE id=pg_temp.id('compA')),
    'comprobante survives the full direct DELETE actor matrix');
END $$;

-- Canonical positive: an inert draft is still deletable through the RPC, and
-- the reversal keeps the surrounding financial state consistent.
INSERT INTO public.comprobantes(id,business_id,tipo,estado,status,estado_comercial,total,total_cobrado)
  VALUES(pg_temp.id('compDeleteOk'),pg_temp.id('A'),'remito','borrador','draft','pendiente',0,0);

DO $$ DECLARE r jsonb; fm_before int; bfe_before int;
BEGIN
  SELECT count(*) INTO fm_before FROM public.financial_movements WHERE business_id=pg_temp.id('A');
  SELECT count(*) INTO bfe_before FROM public.business_finance_entries WHERE business_id=pg_temp.id('A');

  r:=pg_temp.call_as('manager','authenticated',format(
    'SELECT public.delete_comprobante_with_finance(%L)',pg_temp.id('compDeleteOk')));
  PERFORM pg_temp.check_true(r->>'success'='true','canonical comprobante delete succeeds for an inert draft');
  PERFORM pg_temp.check_true(NOT EXISTS(SELECT 1 FROM public.comprobantes WHERE id=pg_temp.id('compDeleteOk')),
    'canonical comprobante delete removes the draft');
  PERFORM pg_temp.check_true(
    (SELECT count(*) FROM public.financial_movements WHERE business_id=pg_temp.id('A'))=fm_before
    AND (SELECT count(*) FROM public.business_finance_entries WHERE business_id=pg_temp.id('A'))=bfe_before,
    'canonical comprobante delete leaves the ledger consistent');

  r:=pg_temp.call_as('viewer','authenticated',format(
    'SELECT public.delete_comprobante_with_finance(%L)',pg_temp.id('compDraft')));
  PERFORM pg_temp.check_true(pg_temp.is_denied(r),'canonical comprobante delete denies a non-comprobantes actor');
END $$;

-- Exact Phase C boundary.
DO $$ DECLARE v_cols text[];
BEGIN
  PERFORM pg_temp.check_true(NOT has_table_privilege('authenticated','public.comprobantes','INSERT')
    AND NOT has_table_privilege('authenticated','public.comprobantes','DELETE'),
    'comprobantes has no authenticated INSERT or DELETE grant');
  SELECT array_agg(DISTINCT column_name) INTO v_cols
    FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='comprobantes'
     AND grantee='authenticated' AND privilege_type IN ('INSERT','DELETE');
  PERFORM pg_temp.check_true(v_cols IS NULL,'comprobantes has no per-column INSERT or DELETE grant');
  PERFORM pg_temp.check_true(NOT EXISTS(SELECT 1 FROM pg_policy
    WHERE polrelid='public.comprobantes'::regclass AND polcmd IN ('a','d','*')),
    'comprobantes has no permissive INSERT or DELETE policy');
  PERFORM pg_temp.check_true(NOT has_table_privilege('anon','public.comprobantes','INSERT')
    AND NOT has_table_privilege('anon','public.comprobantes','DELETE'),
    'anon has no comprobantes write surface');
  PERFORM pg_temp.check_true(
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.prosecdef
        AND pg_get_userbyid(p.proowner)='postgres'
        AND has_function_privilege('authenticated',p.oid,'EXECUTE')
        AND p.proname IN ('create_comprobante_checkout_atomic','create_credit_note_from_comprobante',
                          'delete_comprobante_with_finance','issue_remito_atomic','annul_comprobante_atomic'))=5,
    'canonical comprobante create/issue/annul/delete authority intact');
END $$;

-- No remaining write policy may use is_staff as its action authority.
SELECT pg_temp.check_true(NOT EXISTS(
  SELECT 1 FROM pg_policy p
   WHERE p.polcmd<>'r'
     AND (COALESCE(pg_get_expr(p.polqual,p.polrelid),'') ILIKE '%is_staff%'
       OR COALESCE(pg_get_expr(p.polwithcheck,p.polrelid),'') ILIKE '%is_staff%')
),'zero write policies depend on is_staff');

DO $$ DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_temp.checks WHERE passed;
  RAISE NOTICE 'PASS Lote 3 SQL authority suite: % assertions', n;
END $$;

ROLLBACK;
