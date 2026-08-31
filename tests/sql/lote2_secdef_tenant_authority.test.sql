-- LOCAL ONLY. Role + JWT GUC boundary equivalent to PostgREST, not postgres RPCs.
-- All business/stock/finance effects are fingerprinted, not merely error-checked.
BEGIN;
SET LOCAL statement_timeout = '30s';
CREATE TEMP TABLE ids (name text PRIMARY KEY, id uuid NOT NULL DEFAULT gen_random_uuid());
INSERT INTO ids(name) VALUES ('A'),('B'),('owner'),('admin'),('manager'),('tech'),('sales'),('cashier'),('viewer'),('ownerB'),('inactive'),('outsider'),('denied_admin'),('override_tech'),('profile_linked'),('linked_actor'),('customerA'),('customerB'),('invA'),('invB'),('invLow'),('supplierA'),('supplierB'),('purchaseA'),('purchaseB'),('purchasePaid'),('compA'),('compB'),('compLow'),('remitoA'),('remitoB'),('wholesaleA'),('accountA'),('accountB');
GRANT SELECT ON ids TO anon, authenticated, service_role;
CREATE FUNCTION pg_temp.id(n text) RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM pg_temp.ids WHERE name=n $$;
CREATE TEMP TABLE checks(label text, passed boolean);
CREATE FUNCTION pg_temp.check_true(cond boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %',label; END IF; INSERT INTO pg_temp.checks VALUES(label,true); END $$;
CREATE FUNCTION pg_temp.fingerprint() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE t text; f text; result jsonb:='{}';
BEGIN
  FOREACH t IN ARRAY ARRAY['inventory','inventory_movements','supplier_purchases','supplier_purchase_items','supplier_account_movements','supplier_purchase_deletions','financial_movements','business_finance_entries','comprobantes','comprobante_items','comprobante_payments','wholesale_orders','wholesale_order_items','accounts','account_movements','customer_account_payment_allocations','finance_audit_log'] LOOP
    EXECUTE format('SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text)::text,''[]'')) FROM public.%I r',t) INTO f;
    result:=result||jsonb_build_object(t,f);
  END LOOP;
  RETURN result;
END $$;
-- SECURITY INVOKER: roles and auth.uid are exercised in the real database.
CREATE FUNCTION pg_temp.call_as(actor text, dbrole text, query text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb; uid uuid:=pg_temp.id(actor);
BEGIN
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role',dbrole)::text,true);
  PERFORM set_config('request.jwt.claim.sub',coalesce(uid::text,''),true);
  EXECUTE format('SET LOCAL ROLE %I',dbrole);
  IF current_user<>dbrole OR auth.uid() IS DISTINCT FROM uid THEN RAISE EXCEPTION 'Boundary mismatch'; END IF;
  BEGIN EXECUTE query INTO result;
  EXCEPTION WHEN OTHERS THEN result:=jsonb_build_object('sqlstate',SQLSTATE,'message',SQLERRM); END;
  RESET ROLE;
  RETURN result;
END $$;
CREATE FUNCTION pg_temp.deny(actor text, dbrole text, query text, label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE before_hash jsonb:=pg_temp.fingerprint(); result jsonb;
BEGIN
  result:=pg_temp.call_as(actor,dbrole,query);
  PERFORM pg_temp.check_true(result->>'sqlstate'='42501' OR result->>'error_code' IN ('FORBIDDEN','NOT_FOUND','COMPROBANTE_NOT_FOUND'),label||' denied: '||result::text);
  PERFORM pg_temp.check_true(before_hash=pg_temp.fingerprint(),label||' ZERO EFFECTS');
END $$;

-- Historical unprocessed sales require fixture-only trigger suppression.
-- All calls and fingerprint assertions below run with triggers ENABLED.
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id,email,email_confirmed_at)
 SELECT id,name||'@lote2.invalid',now() FROM ids WHERE name IN ('owner','admin','manager','tech','sales','cashier','viewer','ownerB','inactive','outsider','denied_admin','override_tech','linked_actor');
INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status) VALUES
 (pg_temp.id('A'),'Synthetic Lote2 A',pg_temp.id('owner'),'full','active'),
 (pg_temp.id('B'),'Synthetic Lote2 B',pg_temp.id('ownerB'),'basico','active');
INSERT INTO public.profiles(id,business_id,role,is_active,email)
 SELECT id,pg_temp.id(CASE WHEN name='ownerB' THEN 'B' ELSE 'A' END),
 CASE WHEN name IN ('ownerB','inactive') THEN 'owner' WHEN name='denied_admin' THEN 'admin' WHEN name='override_tech' THEN 'tech' ELSE name END,
 name<>'inactive', name||'@lote2.invalid'
 FROM ids WHERE name IN ('owner','admin','manager','tech','sales','cashier','viewer','ownerB','inactive','denied_admin','override_tech');
INSERT INTO public.profiles(id,user_id,business_id,role,is_active,email)
 VALUES(pg_temp.id('profile_linked'),pg_temp.id('linked_actor'),pg_temp.id('A'),'admin',true,'linked_actor@lote2.invalid');
UPDATE public.profiles SET permissions='{"inventory":false,"users":false,"finance":false}' WHERE id=pg_temp.id('denied_admin');
UPDATE public.profiles SET permissions='{"inventory":true}' WHERE id=pg_temp.id('override_tech');
INSERT INTO public.customers(id,name,phone,business_id) VALUES (pg_temp.id('customerA'),'A','111',pg_temp.id('A')),(pg_temp.id('customerB'),'B','222',pg_temp.id('B'));
INSERT INTO public.inventory(id,business_id,code,name,category,cost_price,sale_price,stock,stock_quantity) VALUES
 (pg_temp.id('invA'),pg_temp.id('A'),'L2-A','A','test',10,20,20,20),
 (pg_temp.id('invB'),pg_temp.id('B'),'L2-B','B','test',10,20,40,40),
 (pg_temp.id('invLow'),pg_temp.id('A'),'L2-L','Low','test',10,20,1,1);
INSERT INTO public.suppliers(id,business_id,name) VALUES(pg_temp.id('supplierA'),pg_temp.id('A'),'A'),(pg_temp.id('supplierB'),pg_temp.id('B'),'B');
INSERT INTO public.supplier_purchases(id,business_id,supplier_id,total_amount,paid_amount) VALUES
 (pg_temp.id('purchaseA'),pg_temp.id('A'),pg_temp.id('supplierA'),50,0),
 (pg_temp.id('purchasePaid'),pg_temp.id('A'),pg_temp.id('supplierA'),50,20),
 (pg_temp.id('purchaseB'),pg_temp.id('B'),pg_temp.id('supplierB'),50,0);
INSERT INTO public.supplier_purchase_items(business_id,purchase_id,supplier_id,inventory_id,product_name,quantity,unit_cost,subtotal) VALUES
 (pg_temp.id('A'),pg_temp.id('purchaseA'),pg_temp.id('supplierA'),pg_temp.id('invA'),'A',3,10,30),
 (pg_temp.id('B'),pg_temp.id('purchaseB'),pg_temp.id('supplierB'),pg_temp.id('invB'),'B',3,10,30);
INSERT INTO public.supplier_account_movements(business_id,supplier_id,purchase_id,type,description,debit) VALUES
 (pg_temp.id('A'),pg_temp.id('supplierA'),pg_temp.id('purchaseA'),'purchase','A',50),
 (pg_temp.id('B'),pg_temp.id('supplierB'),pg_temp.id('purchaseB'),'purchase','B',50);
INSERT INTO public.comprobantes(id,business_id,customer_id,tipo,estado,status,estado_comercial,total,saldo_pendiente) SELECT
 id,pg_temp.id(CASE WHEN name IN ('compB','remitoB') THEN 'B' ELSE 'A' END),pg_temp.id(CASE WHEN name IN ('compB','remitoB') THEN 'customerB' ELSE 'customerA' END),'remito','emitido','completed','pendiente',100,100
 FROM ids WHERE name IN ('compA','compB','compLow','remitoA','remitoB');
INSERT INTO public.comprobante_items(comprobante_id,business_id,inventory_id,descripcion,cantidad,precio_unitario,subtotal,stock_processed) VALUES
 (pg_temp.id('compA'),pg_temp.id('A'),pg_temp.id('invA'),'A',2,20,40,false),
 (pg_temp.id('compLow'),pg_temp.id('A'),pg_temp.id('invLow'),'Low',3,20,60,false),
 (pg_temp.id('compB'),pg_temp.id('B'),pg_temp.id('invB'),'B',2,20,40,false);
INSERT INTO public.wholesale_orders(id,business_id,customer_id,order_number,status) VALUES(pg_temp.id('wholesaleA'),pg_temp.id('A'),pg_temp.id('customerA'),'L2-1','approved');
INSERT INTO public.wholesale_order_items(order_id,business_id,inventory_item_id,product_name,quantity,unit_price,subtotal,stock_processed) VALUES(pg_temp.id('wholesaleA'),pg_temp.id('A'),pg_temp.id('invA'),'A',1,20,20,false);
INSERT INTO public.comprobante_payments(comprobante_id,business_id,amount,amount_ars,payment_method,created_by) VALUES
 (pg_temp.id('remitoA'),pg_temp.id('A'),30,30,'transferencia',pg_temp.id('owner')),
 (pg_temp.id('remitoB'),pg_temp.id('B'),30,30,'transferencia',pg_temp.id('ownerB'));
INSERT INTO public.accounts(id,business_id,type,entity_id,entity_name,balance) VALUES
 (pg_temp.id('accountA'),pg_temp.id('A'),'cliente',pg_temp.id('customerA'),'A',100),
 (pg_temp.id('accountB'),pg_temp.id('B'),'cliente',pg_temp.id('customerB'),'B',100);
INSERT INTO public.account_movements(business_id,account_id,type,description,debit,credit,balance_after,reference_type,reference_id) VALUES
 (pg_temp.id('A'),pg_temp.id('accountA'),'venta','A',100,0,100,'comprobante',pg_temp.id('compA')),
 (pg_temp.id('B'),pg_temp.id('accountB'),'venta','B',100,0,100,'comprobante',pg_temp.id('compB'));
SET LOCAL session_replication_role=origin;

CREATE FUNCTION pg_temp.rpc_queries(biz text) RETURNS SETOF text LANGUAGE sql AS $$
 SELECT format('SELECT public.repair_missing_stock_movements(%L,false)',pg_temp.id(biz)) UNION ALL
 SELECT format('SELECT coalesce(jsonb_agg(r),''[]'') FROM public.preview_missing_stock_movements(%L) r',pg_temp.id(biz)) UNION ALL
 SELECT format('SELECT public.delete_supplier_purchase_safe(%L,%L,%L)',pg_temp.id(biz),pg_temp.id('purchaseB'),pg_temp.id('ownerB')) UNION ALL
 SELECT format('SELECT public.backfill_remito_fm(ARRAY[%L::uuid])',pg_temp.id('remitoB')) UNION ALL
 SELECT format('SELECT to_jsonb(public.check_user_limit_before_invite(%L))',pg_temp.id(biz)) UNION ALL
 SELECT format('SELECT public.pay_comprobante_from_account_atomic(%L,%L,%L,10,''L2'',''transferencia'',current_date,NULL,%L,''deny-key'')',pg_temp.id(biz),pg_temp.id('accountB'),pg_temp.id('compB'),pg_temp.id('ownerB')) UNION ALL
 SELECT format('SELECT to_jsonb(public.user_can_allocate_payments(%L,%L))',pg_temp.id(biz),pg_temp.id('ownerB')) UNION ALL
 SELECT format('SELECT to_jsonb(public.user_can_reverse_allocations(%L,%L))',pg_temp.id(biz),pg_temp.id('ownerB')) UNION ALL
 SELECT format('SELECT to_jsonb(public.user_can_view_order_amounts(%L,%L))',pg_temp.id(biz),pg_temp.id('ownerB'))
$$;

DO $$ DECLARE f record; internal_only boolean;
BEGIN
 FOR f IN SELECT * FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('repair_missing_stock_movements','preview_missing_stock_movements','delete_supplier_purchase_safe','backfill_remito_fm','check_user_limit_before_invite','pay_comprobante_from_account_atomic','user_can_allocate_payments','user_can_reverse_allocations','user_can_view_order_amounts') LOOP
   internal_only:=f.proname IN ('backfill_remito_fm','user_can_allocate_payments','user_can_reverse_allocations','user_can_view_order_amounts');
   PERFORM pg_temp.check_true(NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE'),f.proname||' PUBLIC revoked');
   PERFORM pg_temp.check_true(NOT has_function_privilege('anon',f.oid,'EXECUTE'),f.proname||' anon revoked');
   PERFORM pg_temp.check_true(has_function_privilege('authenticated',f.oid,'EXECUTE')=NOT internal_only,f.proname||' exact authenticated grant');
   PERFORM pg_temp.check_true(has_function_privilege('service_role',f.oid,'EXECUTE')=(f.proname NOT IN ('backfill_remito_fm','delete_supplier_purchase_safe','check_user_limit_before_invite')),f.proname||' exact service grant');
   PERFORM pg_temp.check_true(f.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'],f.proname||' hardened search path');
 END LOOP;
END $$;

DO $$ DECLARE q text; actor text; i integer:=0;
BEGIN
 FOR q IN SELECT * FROM pg_temp.rpc_queries('B') LOOP
   i:=i+1;
   PERFORM pg_temp.deny(NULL,'anon',q,'anon RPC '||i);
   FOREACH actor IN ARRAY ARRAY['owner','admin','manager','tech','sales','cashier','viewer','inactive','outsider','denied_admin','override_tech','linked_actor'] LOOP
     PERFORM pg_temp.deny(actor,'authenticated',q,actor||' A->B RPC '||i);
   END LOOP;
 END LOOP;
 FOR q IN SELECT * FROM pg_temp.rpc_queries('A') LOOP
   PERFORM pg_temp.deny('inactive','authenticated',q,'inactive same tenant');
   PERFORM pg_temp.deny('outsider','authenticated',q,'no membership');
   PERFORM pg_temp.deny('denied_admin','authenticated',q,'explicit false overrides');
 END LOOP;
 -- Same-tenant role matrix and independently denied action capabilities.
 FOREACH actor IN ARRAY ARRAY['manager','tech','sales','cashier','viewer','override_tech'] LOOP
   PERFORM pg_temp.deny(actor,'authenticated',format('SELECT public.repair_missing_stock_movements(%L,false)',pg_temp.id('A')),actor||' repair owner/admin only');
   PERFORM pg_temp.deny(actor,'authenticated',format('SELECT coalesce(jsonb_agg(r),''[]'') FROM public.preview_missing_stock_movements(%L) r',pg_temp.id('A')),actor||' preview owner/admin only');
   PERFORM pg_temp.deny(actor,'authenticated',format('SELECT to_jsonb(public.check_user_limit_before_invite(%L))',pg_temp.id('A')),actor||' invite users authority');
 END LOOP;
 FOREACH actor IN ARRAY ARRAY['tech','cashier','viewer'] LOOP
   PERFORM pg_temp.deny(actor,'authenticated',format('SELECT public.delete_supplier_purchase_safe(%L,%L,%L)',pg_temp.id('A'),pg_temp.id('purchaseA'),pg_temp.id(actor)),actor||' no inventory capability');
 END LOOP;
 FOREACH actor IN ARRAY ARRAY['owner','admin','manager','sales','override_tech','linked_actor'] LOOP
   PERFORM pg_temp.deny(actor,'authenticated',format('SELECT public.delete_supplier_purchase_safe(%L,%L,%L)',pg_temp.id('A'),pg_temp.id('purchaseB'),pg_temp.id(actor)),actor||' A business / B purchase');
 END LOOP;
 FOREACH actor IN ARRAY ARRAY['manager','tech','sales','viewer'] LOOP
   PERFORM pg_temp.deny(actor,'authenticated',format('SELECT public.pay_comprobante_from_account_atomic(%L,%L,%L,10,''L2'',''transferencia'',current_date,NULL,%L,''cap-deny'')',pg_temp.id('A'),pg_temp.id('accountA'),pg_temp.id('compA'),pg_temp.id(actor)),actor||' no finance capability');
 END LOOP;
 PERFORM pg_temp.deny('owner','authenticated',format('SELECT public.pay_comprobante_from_account_atomic(%L,%L,%L,10,''L2'',''transferencia'',current_date,NULL,%L,''entity-deny'')',pg_temp.id('A'),pg_temp.id('accountA'),pg_temp.id('compB'),pg_temp.id('owner')),'A business / B document');
END $$;

DO $$ DECLARE existing_result jsonb; missing_result jsonb; before_hash jsonb:=pg_temp.fingerprint();
BEGIN
 existing_result:=pg_temp.call_as('owner','authenticated',format('SELECT public.pay_comprobante_from_account_atomic(%L,%L,%L,10,''L2'',''transferencia'',current_date,NULL,%L,''oracle-key'')',pg_temp.id('B'),pg_temp.id('accountB'),pg_temp.id('compB'),pg_temp.id('owner')));
 missing_result:=pg_temp.call_as('owner','authenticated',format('SELECT public.pay_comprobante_from_account_atomic(%L,%L,%L,10,''L2'',''transferencia'',current_date,NULL,%L,''oracle-key'')',pg_temp.id('B'),pg_temp.id('accountB'),gen_random_uuid(),pg_temp.id('owner')));
 PERFORM pg_temp.check_true(existing_result->>'sqlstate'='42501' AND existing_result=missing_result,'foreign payment document has no existence oracle; deny BEFORE read');
 PERFORM pg_temp.check_true(before_hash=pg_temp.fingerprint(),'existence oracle probes ZERO EFFECTS');
END $$;

DO $$ DECLARE r jsonb; before_hash jsonb; actor text;
BEGIN
 FOREACH actor IN ARRAY ARRAY['owner','admin','linked_actor'] LOOP
   r:=pg_temp.call_as(actor,'authenticated',format('SELECT coalesce(jsonb_agg(r),''[]'') FROM public.preview_missing_stock_movements(%L) r',pg_temp.id('A')));
   PERFORM pg_temp.check_true(jsonb_array_length(r)=3,actor||' own preview 3 rows');
   PERFORM pg_temp.check_true((SELECT count(*)=9 FROM jsonb_object_keys(r->0)),'preview same 9-column shape');
   r:=pg_temp.call_as(actor,'authenticated',format('SELECT to_jsonb(public.check_user_limit_before_invite(%L))',pg_temp.id('A')));
   PERFORM pg_temp.check_true(r#>>'{}' LIKE 'LIMIT_REACHED:%:10:full',actor||' invite preflight same text contract');
 END LOOP;
 before_hash:=pg_temp.fingerprint();
 r:=pg_temp.call_as('admin','authenticated',format('SELECT public.delete_supplier_purchase_safe(%L,%L,%L)',pg_temp.id('A'),pg_temp.id('purchasePaid'),pg_temp.id('admin')));
 PERFORM pg_temp.check_true(r->>'error_code'='BLOCKED_PAID','paid purchase blocked');
 PERFORM pg_temp.check_true(before_hash=pg_temp.fingerprint(),'BLOCKED_PAID ZERO EFFECTS');
 FOREACH actor IN ARRAY ARRAY['manager','sales','override_tech','linked_actor'] LOOP
   r:=pg_temp.call_as(actor,'authenticated',format('SELECT public.delete_supplier_purchase_safe(%L,%L,%L)',pg_temp.id('A'),pg_temp.id('purchasePaid'),pg_temp.id(actor)));
   PERFORM pg_temp.check_true(r->>'error_code'='BLOCKED_PAID',actor||' inventory capability reaches legitimate business-rule result');
 END LOOP;
 r:=pg_temp.call_as('ownerB','authenticated',format('SELECT coalesce(jsonb_agg(r),''[]'') FROM public.preview_missing_stock_movements(%L) r',pg_temp.id('B')));
 PERFORM pg_temp.check_true(jsonb_array_length(r)=1,'owner B can preview own tenant');
 -- Forged p_user_id is ignored: compatibility signature, canonical audit actor.
 r:=pg_temp.call_as('admin','authenticated',format('SELECT public.delete_supplier_purchase_safe(%L,%L,%L)',pg_temp.id('A'),pg_temp.id('purchaseA'),pg_temp.id('ownerB')));
 PERFORM pg_temp.check_true(r->>'ok'='true' AND r->>'replay'='false','successful delete');
 PERFORM pg_temp.check_true((SELECT stock_quantity=17 AND stock=17 FROM public.inventory WHERE id=pg_temp.id('invA')),'purchase stock reversal 20->17');
 PERFORM pg_temp.check_true((SELECT count(*)=1 AND bool_and(created_by=pg_temp.id('admin')) FROM public.inventory_movements WHERE reference_id=pg_temp.id('purchaseA')),'inventory audit uses auth.uid');
 PERFORM pg_temp.check_true((SELECT count(*)=1 AND bool_and(user_id=pg_temp.id('admin')) FROM public.supplier_purchase_deletions WHERE purchase_id=pg_temp.id('purchaseA')),'one tombstone with auth.uid');
 PERFORM pg_temp.check_true(NOT EXISTS(SELECT 1 FROM public.supplier_purchase_items WHERE purchase_id=pg_temp.id('purchaseA')) AND NOT EXISTS(SELECT 1 FROM public.supplier_account_movements WHERE purchase_id=pg_temp.id('purchaseA')),'items and account movements removed');
 before_hash:=pg_temp.fingerprint();
 r:=pg_temp.call_as('owner','authenticated',format('SELECT public.delete_supplier_purchase_safe(%L,%L,%L)',pg_temp.id('A'),pg_temp.id('purchaseA'),pg_temp.id('ownerB')));
 PERFORM pg_temp.check_true(r->>'replay'='true' AND r->>'error_code'='ALREADY_DELETED','same tenant replay preserved');
 PERFORM pg_temp.check_true(before_hash=pg_temp.fingerprint(),'replay ZERO EFFECTS');
 r:=pg_temp.call_as('owner','authenticated',format('SELECT public.repair_missing_stock_movements(%L,false)',pg_temp.id('A')));
 PERFORM pg_temp.check_true(r->>'comprobantes_procesados'='1' AND r->>'pedidos_mayoristas_procesados'='1' AND r->>'items_sin_stock_suficiente'='1','normal repair + wholesale + insufficient stock');
 PERFORM pg_temp.check_true((SELECT stock_quantity=14 FROM public.inventory WHERE id=pg_temp.id('invA')),'repair subtracts 3 units once');
 r:=pg_temp.call_as('admin','authenticated',format('SELECT public.repair_missing_stock_movements(%L,true)',pg_temp.id('A')));
 PERFORM pg_temp.check_true(r->>'comprobantes_procesados'='1' AND (SELECT stock_quantity=-2 FROM public.inventory WHERE id=pg_temp.id('invLow')),'allow_negative preserved');
 before_hash:=pg_temp.fingerprint();
 r:=pg_temp.call_as('owner','authenticated',format('SELECT public.repair_missing_stock_movements(%L,true)',pg_temp.id('A')));
 PERFORM pg_temp.check_true(r->>'total_unidades_descontadas'='0' AND before_hash=pg_temp.fingerprint(),'repair idempotency');
 PERFORM pg_temp.check_true((SELECT stock_quantity=40 FROM public.inventory WHERE id=pg_temp.id('invB')),'tenant B stock intact');
 -- Inconsistent legacy child foreign keys cannot be used as a tenant bridge.
 SET LOCAL session_replication_role=replica;
 INSERT INTO public.comprobante_items(comprobante_id,business_id,inventory_id,descripcion,cantidad,stock_processed) VALUES
   (pg_temp.id('compA'),pg_temp.id('A'),pg_temp.id('invB'),'foreign inventory',1,false),
   (pg_temp.id('compB'),pg_temp.id('A'),pg_temp.id('invA'),'foreign parent',1,false);
 INSERT INTO public.supplier_purchase_items(business_id,purchase_id,inventory_id,product_name,quantity) VALUES
   (pg_temp.id('A'),pg_temp.id('purchasePaid'),pg_temp.id('invB'),'foreign inventory',1);
 SET LOCAL session_replication_role=origin;
 before_hash:=pg_temp.fingerprint();
 r:=pg_temp.call_as('owner','authenticated',format('SELECT coalesce(jsonb_agg(r),''[]'') FROM public.preview_missing_stock_movements(%L) r',pg_temp.id('A')));
 PERFORM pg_temp.check_true(r='[]'::jsonb,'preview excludes foreign parent/inventory even with A child');
 r:=pg_temp.call_as('owner','authenticated',format('SELECT public.repair_missing_stock_movements(%L,true)',pg_temp.id('A')));
 PERFORM pg_temp.check_true(r->>'total_unidades_descontadas'='0' AND before_hash=pg_temp.fingerprint(),'repair foreign parent/inventory ZERO EFFECTS');
 PERFORM pg_temp.deny('owner','authenticated',format('SELECT public.delete_supplier_purchase_safe(%L,%L,%L)',pg_temp.id('A'),pg_temp.id('purchasePaid'),pg_temp.id('owner')),'purchase foreign inventory reference');
 -- Existing service ACL retained for stock tools but no actor bypass exists.
 PERFORM pg_temp.deny(NULL,'service_role',format('SELECT public.repair_missing_stock_movements(%L,false)',pg_temp.id('A')),'service stock needs human actor');
 -- Backfill never had a service grant. postgres is the actual maintenance owner.
 PERFORM pg_temp.deny(NULL,'service_role',format('SELECT public.backfill_remito_fm(ARRAY[%L::uuid])',pg_temp.id('remitoA')),'service cannot backfill');
 r:=pg_temp.call_as(NULL,'postgres',format('SELECT public.backfill_remito_fm(ARRAY[%L::uuid,%L::uuid])',pg_temp.id('remitoA'),pg_temp.id('remitoB')));
 PERFORM pg_temp.check_true(r->>'success'='true' AND r->>'created'='2','internal backfill two tenants');
 PERFORM pg_temp.check_true((SELECT count(*)=2 AND bool_and(type='income' AND currency='ARS' AND amount_ars=30 AND source='comprobante' AND metodo_pago='transferencia') FROM public.financial_movements WHERE comprobante_id IN(pg_temp.id('remitoA'),pg_temp.id('remitoB'))),'backfill financial shape');
 before_hash:=pg_temp.fingerprint();
 r:=pg_temp.call_as(NULL,'postgres',format('SELECT public.backfill_remito_fm(ARRAY[%L::uuid,%L::uuid])',pg_temp.id('remitoA'),pg_temp.id('remitoB')));
 PERFORM pg_temp.check_true(r->>'created'='0' AND before_hash=pg_temp.fingerprint(),'backfill idempotency no duplicates');
 r:=pg_temp.call_as('owner','authenticated',format('SELECT public.pay_comprobante_from_account_atomic(%L,%L,%L,10,''L2'',''transferencia'',current_date,NULL,%L,''success-pay'')',pg_temp.id('A'),pg_temp.id('accountA'),pg_temp.id('compA'),pg_temp.id('ownerB')));
 PERFORM pg_temp.check_true(r->>'ok'='true' AND r->>'allocated_amount'='10.00','authorized wrapper payment: '||r::text);
 r:=pg_temp.call_as('owner','authenticated',format('SELECT public.get_allocation_workspace(%L,%L)',pg_temp.id('A'),pg_temp.id('accountA')));
 PERFORM pg_temp.check_true(r->>'sqlstate' IS NULL AND r->>'ok' IS DISTINCT FROM 'false','guarded allocation parent retains private helpers: '||r::text);
 r:=pg_temp.call_as('owner','authenticated',format('SELECT to_jsonb(public.get_order_financial_amounts(%L,ARRAY[]::uuid[]))',pg_temp.id('A')));
 PERFORM pg_temp.check_true(r->>'sqlstate' IS NULL,'guarded order amounts parent retains helper');
END $$;

SELECT 'PASS LOTE2: '||count(*)||' assertions; JWT + role boundary; fingerprinted denies; all fixtures rolled back' FROM checks;
ROLLBACK;
