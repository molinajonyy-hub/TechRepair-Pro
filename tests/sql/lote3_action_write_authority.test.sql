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
 ('orderPaymentA'),('wholesaleA');
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
    'supplier_account_movements','accounts','account_movements','payment_transactions'
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

CREATE FUNCTION pg_temp.is_denied(result jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(result->>'sqlstate' = '42501',false)
      OR COALESCE(result->>'error_code' = 'FORBIDDEN',false)
      OR COALESCE(result->>'code' = '42501',false)
      OR COALESCE(result->>'error' ILIKE 'Sin acceso%',false)
      OR COALESCE(result->>'error' ILIKE 'No autorizado%',false)
$$;

CREATE FUNCTION pg_temp.deny(actor text, dbrole text, query text, label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE before_hash jsonb := pg_temp.fingerprint(); result jsonb;
BEGIN
  result := pg_temp.call_as(actor,dbrole,query);
  PERFORM pg_temp.check_true(pg_temp.is_denied(result),label||' denied: '||result::text);
  PERFORM pg_temp.check_true(before_hash=pg_temp.fingerprint(),label||' ZERO EFFECTS');
END $$;

SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id,email,email_confirmed_at)
 SELECT id,name||'@lote3.invalid',now() FROM ids
 WHERE name IN ('owner','admin','manager','tech','sales','cashier','viewer','ownerB','ownerBasic','inactive','no_profile','admin_false','tech_true');
INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status) VALUES
 (pg_temp.id('A'),'Synthetic Lote3 A',pg_temp.id('owner'),'full','active'),
 (pg_temp.id('B'),'Synthetic Lote3 B',pg_temp.id('ownerB'),'full','active'),
 (pg_temp.id('Basic'),'Synthetic Lote3 Basic',pg_temp.id('ownerBasic'),'basico','active');
INSERT INTO public.profiles(id,user_id,business_id,role,is_active,email)
 SELECT id, id, pg_temp.id(CASE WHEN name='ownerB' THEN 'B' WHEN name='ownerBasic' THEN 'Basic' ELSE 'A' END),
   CASE WHEN name IN ('ownerB','ownerBasic','inactive') THEN 'owner' WHEN name='admin_false' THEN 'admin' WHEN name='tech_true' THEN 'tech' ELSE name END,
   name<>'inactive', name||'@lote3.invalid'
 FROM ids WHERE name IN ('owner','admin','manager','tech','sales','cashier','viewer','ownerB','ownerBasic','inactive','admin_false','tech_true');
UPDATE public.profiles SET permissions =
  '{"finance":false,"comprobantes":false,"inventory":false,"settings_sensitive":false,"customers":false,"orders_view_financials":false}'
 WHERE id=pg_temp.id('admin_false');
UPDATE public.profiles SET permissions =
  '{"finance":true,"comprobantes":true,"inventory":true,"settings_sensitive":true,"customers":true,"orders_view_financials":true}'
 WHERE id=pg_temp.id('tech_true');
INSERT INTO public.comprobantes(id,business_id,tipo,estado,status,estado_comercial,total,saldo_pendiente)
 VALUES
 (pg_temp.id('compA'),pg_temp.id('A'),'remito','emitido','completed','pendiente',100,100),
 (pg_temp.id('compPT'),pg_temp.id('A'),'remito','emitido','completed','pendiente',100,100);
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
    PERFORM pg_temp.deny(NULL,'anon',c.deny_sql,c.function_name||' anonymous');
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
      expected := pg_temp.call_as(actor,'authenticated',format(
        'SELECT to_jsonb(public.current_user_can(%L) AND (%L IS NULL OR public.current_user_can(%L)))',
        c.capability,c.additional_capability,c.additional_capability
      )) #>> '{}' = 'true';
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
    PERFORM pg_temp.check_true(position('require_action_authority' in pg_get_functiondef(p.oid))>0,c.function_name||' wrapper gate present');
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
SAVEPOINT old_comprobantes_policy;
DROP POLICY comprobantes_insert ON public.comprobantes;
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
GRANT INSERT, UPDATE, DELETE ON public.payment_transactions TO authenticated;
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
