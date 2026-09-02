\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.como(p_uid uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',json_build_object('sub',p_uid::text,'role','authenticated')::text,true);
END $$;

DO $$
DECLARE
  v_owner_a uuid:=gen_random_uuid();v_admin_a uuid:=gen_random_uuid();v_manager_a uuid:=gen_random_uuid();
  v_tech_a uuid:=gen_random_uuid();v_sales_a uuid:=gen_random_uuid();v_cashier_a uuid:=gen_random_uuid();
  v_viewer_a uuid:=gen_random_uuid();v_owner_b uuid:=gen_random_uuid();
  v_biz_a uuid;v_biz_b uuid;v_customer_a uuid;v_customer_b uuid;
  v_device_b uuid;v_order_b uuid;
BEGIN
  INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
    (v_owner_a,'m2a-owner-a@invalid.test',now()),(v_admin_a,'m2a-admin-a@invalid.test',now()),
    (v_manager_a,'m2a-manager-a@invalid.test',now()),(v_tech_a,'m2a-tech-a@invalid.test',now()),
    (v_sales_a,'m2a-sales-a@invalid.test',now()),(v_cashier_a,'m2a-cashier-a@invalid.test',now()),
    (v_viewer_a,'m2a-viewer-a@invalid.test',now()),(v_owner_b,'m2a-owner-b@invalid.test',now());
  INSERT INTO public.businesses(name,owner_user_id) VALUES('M2A Taller A',v_owner_a) RETURNING id INTO v_biz_a;
  INSERT INTO public.businesses(name,owner_user_id) VALUES('M2A Taller B',v_owner_b) RETURNING id INTO v_biz_b;
  INSERT INTO public.profiles(id,business_id,role,is_active,email) VALUES
    (v_owner_a,v_biz_a,'owner',true,'m2a-owner-a@invalid.test'),
    (v_admin_a,v_biz_a,'admin',true,'m2a-admin-a@invalid.test'),
    (v_manager_a,v_biz_a,'manager',true,'m2a-manager-a@invalid.test'),
    (v_tech_a,v_biz_a,'tech',true,'m2a-tech-a@invalid.test'),
    (v_sales_a,v_biz_a,'sales',true,'m2a-sales-a@invalid.test'),
    (v_cashier_a,v_biz_a,'cashier',true,'m2a-cashier-a@invalid.test'),
    (v_viewer_a,v_biz_a,'viewer',true,'m2a-viewer-a@invalid.test'),
    (v_owner_b,v_biz_b,'owner',true,'m2a-owner-b@invalid.test');
  INSERT INTO public.customers(name,phone,business_id,created_by) VALUES('Cliente A','111',v_biz_a,v_owner_a) RETURNING id INTO v_customer_a;
  INSERT INTO public.customers(name,phone,business_id,created_by) VALUES('Cliente B','222',v_biz_b,v_owner_b) RETURNING id INTO v_customer_b;
  INSERT INTO public.devices(customer_id,type,brand,model,issue,created_by,business_id)
  VALUES(v_customer_b,'smartphone','QA','Tenant B','QA only',v_owner_b,v_biz_b) RETURNING id INTO v_device_b;
  INSERT INTO public.orders(customer_id,device_id,status,priority,estimated_total,created_by,business_id)
  VALUES(v_customer_b,v_device_b,'new','medium',0,v_owner_b,v_biz_b) RETURNING id INTO v_order_b;
  PERFORM set_config('test.owner_a',v_owner_a::text,false);PERFORM set_config('test.admin_a',v_admin_a::text,false);
  PERFORM set_config('test.manager_a',v_manager_a::text,false);PERFORM set_config('test.tech_a',v_tech_a::text,false);
  PERFORM set_config('test.sales_a',v_sales_a::text,false);PERFORM set_config('test.cashier_a',v_cashier_a::text,false);
  PERFORM set_config('test.viewer_a',v_viewer_a::text,false);PERFORM set_config('test.owner_b',v_owner_b::text,false);
  PERFORM set_config('test.biz_a',v_biz_a::text,false);PERFORM set_config('test.biz_b',v_biz_b::text,false);
  PERFORM set_config('test.customer_a',v_customer_a::text,false);PERFORM set_config('test.customer_b',v_customer_b::text,false);
  PERFORM set_config('test.order_b',v_order_b::text,false);
  PERFORM set_config('test.secret_create',encode(gen_random_bytes(12),'hex'),false);
  PERFORM set_config('test.secret_replace',encode(gen_random_bytes(12),'hex'),false);
  PERFORM set_config('test.secret_legacy',encode(gen_random_bytes(12),'hex'),false);
  PERFORM set_config('test.fm_before',(SELECT count(*) FROM public.financial_movements)::text,false);
  PERFORM set_config('test.am_before',(SELECT count(*) FROM public.account_movements)::text,false);
  PERFORM set_config('test.comp_before',(SELECT count(*) FROM public.comprobantes)::text,false);
END $$;

SET LOCAL ROLE authenticated;
SELECT pg_temp.como(current_setting('test.owner_a')::uuid);
DO $$ BEGIN IF NOT public.current_user_can('orders_create') OR NOT public.current_user_can('device_access_secret') OR public.current_user_can('capability_that_does_not_exist') THEN RAISE EXCEPTION 'RBAC FAIL: owner';END IF;END $$;
SELECT pg_temp.como(current_setting('test.admin_a')::uuid);
DO $$ BEGIN IF NOT public.current_user_can('orders_create') OR NOT public.current_user_can('device_access_secret') THEN RAISE EXCEPTION 'RBAC FAIL: admin';END IF;END $$;
SELECT pg_temp.como(current_setting('test.manager_a')::uuid);
DO $$ BEGIN IF NOT public.current_user_can('orders_create') OR NOT public.current_user_can('device_access_secret') THEN RAISE EXCEPTION 'RBAC FAIL: manager';END IF;END $$;
SELECT pg_temp.como(current_setting('test.tech_a')::uuid);
DO $$ BEGIN IF NOT public.current_user_can('orders_create') OR NOT public.current_user_can('device_access_secret') THEN RAISE EXCEPTION 'RBAC FAIL: tech';END IF;END $$;
SELECT pg_temp.como(current_setting('test.sales_a')::uuid);
DO $$ BEGIN IF NOT public.current_user_can('orders_create') OR public.current_user_can('device_access_secret') THEN RAISE EXCEPTION 'RBAC FAIL: sales';END IF;END $$;
SELECT pg_temp.como(current_setting('test.cashier_a')::uuid);
DO $$ BEGIN IF NOT public.current_user_can('orders_create') OR public.current_user_can('device_access_secret') THEN RAISE EXCEPTION 'RBAC FAIL: cashier';END IF;END $$;
SELECT pg_temp.como(current_setting('test.viewer_a')::uuid);
DO $$ BEGIN IF public.current_user_can('orders_create') OR public.current_user_can('device_access_secret') THEN RAISE EXCEPTION 'RBAC FAIL: viewer';END IF;END $$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT pg_temp.como(current_setting('test.owner_a')::uuid);
SELECT set_config('test.order_id',(public.create_order_intake(
  '11111111-2222-4333-8444-555555555555'::uuid,
  jsonb_build_object(
    'customer_id',current_setting('test.customer_a'),'device',jsonb_build_object('type','smartphone','brand','Samsung','model','S24','serial','SN-1','imei','490154203237518'),
    'condition',jsonb_build_object('general','Bueno','physical',jsonb_build_array('Rayones'),'powers_on','yes'),
    'checklist',jsonb_build_object('display','ok','touch','not_tested'),'access_mode','pin','problem','No carga','observations','Con funda',
    'priority','medium','budget',jsonb_build_object('amount','100000.50','currency','ARS')),
  current_setting('test.secret_create')
)->>'order_id'),false);
RESET ROLE;

DO $$
DECLARE v_order uuid:=current_setting('test.order_id')::uuid;v_device uuid;v_secret_id uuid;v_plain text;v_n int;
BEGIN
  SELECT device_id INTO v_device FROM public.orders WHERE id=v_order AND business_id=current_setting('test.biz_a')::uuid;
  IF v_device IS NULL THEN RAISE EXCEPTION 'A FAIL: no se creó orden tenant-safe';END IF;
  IF (SELECT device_password FROM public.orders WHERE id=v_order)<>'pin:'||current_setting('test.secret_create') THEN RAISE EXCEPTION 'A FAIL: shadow legacy no sincronizado';END IF;
  IF (SELECT estimated_total_currency FROM public.orders WHERE id=v_order)<>'ARS' THEN RAISE EXCEPTION 'A FAIL: moneda';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.device_inspections WHERE order_id=v_order AND type='reception' AND intake_check_results->>'display'='ok') THEN RAISE EXCEPTION 'A FAIL: inspección';END IF;
  SELECT vault_secret_id INTO v_secret_id FROM private.order_device_access_secrets WHERE order_id=v_order;
  SELECT decrypted_secret INTO v_plain FROM vault.decrypted_secrets WHERE id=v_secret_id;
  IF v_plain<>current_setting('test.secret_create') THEN RAISE EXCEPTION 'A FAIL: Vault';END IF;
  SELECT count(*) INTO v_n FROM private.order_device_access_audit WHERE order_id=v_order AND action='stored';
  IF v_n<>1 THEN RAISE EXCEPTION 'A FAIL: auditoría store';END IF;
  IF EXISTS(SELECT 1 FROM private.order_device_access_audit WHERE order_id=v_order AND action='legacy_secret_write_mirrored') THEN RAISE EXCEPTION 'A FAIL: dual-write nuevo fue contado como legacy';END IF;
  IF (SELECT count(*) FROM public.financial_movements)<>current_setting('test.fm_before')::int OR
     (SELECT count(*) FROM public.account_movements)<>current_setting('test.am_before')::int OR
     (SELECT count(*) FROM public.comprobantes)<>current_setting('test.comp_before')::int THEN
    RAISE EXCEPTION 'A FAIL: el intake escribió finanzas/CC/comprobantes';END IF;
  RAISE NOTICE 'A OK · frontend nuevo: orden atómica, Vault, shadow legacy y cero writes financieros';
END $$;

DO $$ BEGIN
  BEGIN
    PERFORM public.create_order_intake(
      '11111111-2222-4333-8444-555555555555'::uuid,
      jsonb_build_object('customer_id',current_setting('test.customer_a'),'device',jsonb_build_object('type','smartphone','brand','Samsung','model','S24'),'condition',jsonb_build_object('physical',jsonb_build_array()),'checklist','{}'::jsonb,'access_mode','none','problem','payload diferente','priority','medium','budget',jsonb_build_object('currency','ARS')));
    RAISE EXCEPTION 'B FAIL: aceptó misma clave con payload diferente';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  RAISE NOTICE 'B2 OK · misma clave con payload diferente falla cerrado';
END $$;

SET LOCAL ROLE authenticated;
SELECT pg_temp.como(current_setting('test.owner_a')::uuid);
INSERT INTO storage.objects(bucket_id,name,owner_id)
VALUES('documents','business/'||current_setting('test.biz_a')||'/orders/'||current_setting('test.order_id')||'/intake/evidence.png',current_setting('test.owner_a')::uuid);
SELECT public.register_order_intake_document(
  current_setting('test.order_id')::uuid,
  'business/'||current_setting('test.biz_a')||'/orders/'||current_setting('test.order_id')||'/intake/evidence.png',
  'evidence.png','image/png',8);
DO $$ BEGIN
  BEGIN
    INSERT INTO storage.objects(bucket_id,name,owner_id)
    VALUES('documents','business/00000000-0000-0000-0000-000000000099/orders/'||current_setting('test.order_id')||'/intake/cross.png',current_setting('test.owner_a')::uuid);
    RAISE EXCEPTION 'PHOTO FAIL: aceptó storage cross-tenant';
  EXCEPTION WHEN insufficient_privilege THEN NULL;END;
  BEGIN
    INSERT INTO public.documents(order_id,file_name,file_type,file_size,created_by,business_id,storage_path,kind)
    VALUES(current_setting('test.order_id')::uuid,'bypass.png','image/png',8,current_setting('test.owner_a')::uuid,current_setting('test.biz_a')::uuid,'x','intake');
    RAISE EXCEPTION 'PHOTO FAIL: aceptó metadata intake directa';
  EXCEPTION WHEN insufficient_privilege THEN NULL;END;
END $$;
RESET ROLE;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.documents WHERE order_id=current_setting('test.order_id')::uuid AND kind='intake' AND file_url IS NULL) THEN RAISE EXCEPTION 'PHOTO FAIL: metadata privada no registrada';END IF;
  RAISE NOTICE 'PHOTO OK · objeto/metadata tenant-safe y bypass directo denegado';
END $$;

SET LOCAL ROLE authenticated;
SELECT pg_temp.como(current_setting('test.owner_a')::uuid);
RESET ROLE;

DO $$ DECLARE v_replay jsonb; BEGIN
  v_replay:=public.create_order_intake(
    '11111111-2222-4333-8444-555555555555'::uuid,
    jsonb_build_object('customer_id',current_setting('test.customer_a'),'device',jsonb_build_object('type','smartphone','brand','Samsung','model','S24','serial','SN-1','imei','490154203237518'),'condition',jsonb_build_object('general','Bueno','physical',jsonb_build_array('Rayones'),'powers_on','yes'),'checklist',jsonb_build_object('display','ok','touch','not_tested'),'access_mode','pin','problem','No carga','observations','Con funda','priority','medium','budget',jsonb_build_object('amount','100000.50','currency','ARS')),
    current_setting('test.secret_create'));
  IF (v_replay->>'order_id')::uuid<>current_setting('test.order_id')::uuid OR NOT (v_replay->>'replayed')::boolean THEN RAISE EXCEPTION 'B FAIL: replay';END IF;
  IF (SELECT count(*) FROM public.orders WHERE id=current_setting('test.order_id')::uuid)<>1 THEN RAISE EXCEPTION 'B FAIL: duplicó orden';END IF;
  RAISE NOTICE 'B OK · retry devuelve la misma orden';
END $$;

SET LOCAL ROLE authenticated;
SELECT pg_temp.como(current_setting('test.owner_a')::uuid);
DO $$ BEGIN
  BEGIN
    PERFORM public.create_order_intake('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',jsonb_build_object('customer_id',current_setting('test.customer_b'),'device',jsonb_build_object('type','smartphone','brand','X','model','Y'),'condition',jsonb_build_object('physical',jsonb_build_array()),'checklist','{}'::jsonb,'access_mode','none','problem','x','priority','medium','budget',jsonb_build_object('currency','ARS')));
    RAISE EXCEPTION 'C FAIL: aceptó customer cross-tenant';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;
SELECT pg_temp.como(current_setting('test.sales_a')::uuid);
DO $$ BEGIN
  BEGIN PERFORM public.reveal_order_device_access(current_setting('test.order_id')::uuid);RAISE EXCEPTION 'C FAIL: sales reveló secreto';
  EXCEPTION WHEN insufficient_privilege THEN NULL;END;
END $$;
SELECT pg_temp.como(current_setting('test.owner_b')::uuid);
DO $$ DECLARE v_value text;BEGIN
  v_value:=public.reveal_order_device_access(current_setting('test.order_id')::uuid);
  IF v_value IS NOT NULL THEN RAISE EXCEPTION 'C FAIL: cross-tenant reveló secreto';END IF;
END $$;
SELECT pg_temp.como(current_setting('test.owner_a')::uuid);
DO $$ DECLARE v_value text;BEGIN
  v_value:=public.reveal_order_device_access(current_setting('test.order_id')::uuid);
  IF v_value<>current_setting('test.secret_create') THEN RAISE EXCEPTION 'C FAIL: owner no reveló';END IF;
END $$;
RESET ROLE;
DO $$ BEGIN
  IF (SELECT count(*) FROM private.order_device_access_audit WHERE order_id=current_setting('test.order_id')::uuid AND action='revealed')<>1 THEN RAISE EXCEPTION 'C FAIL: reveal sin auditoría';END IF;
END $$;
SET LOCAL ROLE authenticated;
SELECT pg_temp.como(current_setting('test.owner_a')::uuid);
SELECT public.set_order_device_access_secret(
  current_setting('test.order_id')::uuid,'password',current_setting('test.secret_replace'));
RESET ROLE;
DO $$ DECLARE v_secret_id uuid;v_plain text;BEGIN
  IF (SELECT device_password FROM public.orders WHERE id=current_setting('test.order_id')::uuid)
     <>'text:'||current_setting('test.secret_replace') THEN RAISE EXCEPTION 'COEXIST FAIL: RPC nueva no actualizó shadow legacy';END IF;
  SELECT vault_secret_id INTO v_secret_id FROM private.order_device_access_secrets
   WHERE order_id=current_setting('test.order_id')::uuid;
  SELECT decrypted_secret INTO v_plain FROM vault.decrypted_secrets WHERE id=v_secret_id;
  IF v_plain<>current_setting('test.secret_replace') THEN RAISE EXCEPTION 'COEXIST FAIL: replace Vault';END IF;
  IF EXISTS(SELECT 1 FROM private.order_device_access_audit
             WHERE order_id=current_setting('test.order_id')::uuid
               AND action='legacy_secret_write_mirrored') THEN RAISE EXCEPTION 'NO-RECURSION FAIL: RPC nueva disparó mirror legacy';END IF;
END $$;

SET LOCAL ROLE authenticated;
SELECT pg_temp.como(current_setting('test.sales_a')::uuid);
DO $$ BEGIN
  BEGIN
    PERFORM public.set_order_device_access_secret(
      current_setting('test.order_id')::uuid,'pin',current_setting('test.secret_legacy'));
    RAISE EXCEPTION 'CAPABILITY FAIL: sales usó RPC nueva';
  EXCEPTION WHEN insufficient_privilege THEN NULL;END;
END $$;

-- Coexistencia legacy: un actor sin capability no puede escribir; para un actor
-- autorizado, device_password sigue escribible y el trigger refleja a Vault sin
-- recursión ni exposición del secreto en audit.
SELECT pg_temp.como(current_setting('test.owner_a')::uuid);
DO $$ DECLARE v_customer uuid;v_device uuid;v_order uuid;BEGIN
  INSERT INTO public.customers(name,phone,business_id,created_by)
  VALUES('E2E MOBILE2A LEGACY','000',current_setting('test.biz_a')::uuid,current_setting('test.owner_a')::uuid)
  RETURNING id INTO v_customer;
  INSERT INTO public.devices(customer_id,type,brand,model,issue,created_by,business_id)
  VALUES(v_customer,'smartphone','QA','LEGACY DEVICE','TEST ORDER',current_setting('test.owner_a')::uuid,current_setting('test.biz_a')::uuid)
  RETURNING id INTO v_device;
  INSERT INTO public.orders(customer_id,device_id,status,priority,estimated_total,notes,created_by,business_id)
  VALUES(v_customer,v_device,'new','medium',0,'QA legacy flow',current_setting('test.owner_a')::uuid,current_setting('test.biz_a')::uuid)
  RETURNING id INTO v_order;
  PERFORM set_config('test.legacy_order',v_order::text,false);
END $$;
SELECT pg_temp.como(current_setting('test.viewer_a')::uuid);
DO $$ DECLARE v_rows bigint;BEGIN
  UPDATE public.orders SET device_password='pin:'||current_setting('test.secret_legacy')
   WHERE id=current_setting('test.legacy_order')::uuid;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>0 THEN RAISE EXCEPTION 'ACTION AUTHORITY FAIL: viewer escribió device_password';END IF;
END $$;
RESET ROLE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM private.order_device_access_secrets
            WHERE order_id=current_setting('test.legacy_order')::uuid) THEN
    RAISE EXCEPTION 'ACTION AUTHORITY FAIL: viewer generó secreto Vault';END IF;
END $$;
SET LOCAL ROLE authenticated;
SELECT pg_temp.como(current_setting('test.owner_a')::uuid);
UPDATE public.orders SET device_password='pin:'||current_setting('test.secret_legacy')
 WHERE id=current_setting('test.legacy_order')::uuid;
RESET ROLE;
DO $$ DECLARE v_secret_id uuid;v_plain text;v_vault_rows int;BEGIN
  IF (SELECT device_password FROM public.orders WHERE id=current_setting('test.legacy_order')::uuid)
     <>'pin:'||current_setting('test.secret_legacy') THEN RAISE EXCEPTION 'LEGACY FAIL: plaintext no quedó disponible';END IF;
  IF (SELECT access_mode FROM public.orders WHERE id=current_setting('test.legacy_order')::uuid)<>'pin' THEN RAISE EXCEPTION 'LEGACY FAIL: access_mode';END IF;
  SELECT vault_secret_id INTO v_secret_id FROM private.order_device_access_secrets
   WHERE order_id=current_setting('test.legacy_order')::uuid;
  SELECT decrypted_secret INTO v_plain FROM vault.decrypted_secrets WHERE id=v_secret_id;
  IF v_plain<>current_setting('test.secret_legacy') THEN RAISE EXCEPTION 'LEGACY FAIL: mirror Vault';END IF;
  SELECT count(*) INTO v_vault_rows FROM vault.secrets
   WHERE name LIKE 'order-device-access:'||current_setting('test.legacy_order')||':%';
  IF v_vault_rows<>1 THEN RAISE EXCEPTION 'NO-RECURSION FAIL: cantidad de secretos Vault';END IF;
  IF (SELECT count(*) FROM private.order_device_access_audit
       WHERE order_id=current_setting('test.legacy_order')::uuid
         AND action='legacy_secret_write_mirrored' AND operation='set'
         AND actor_id=current_setting('test.owner_a')::uuid)<>1 THEN RAISE EXCEPTION 'LEGACY FAIL: audit metadata';END IF;
END $$;

SET LOCAL ROLE authenticated;
SELECT pg_temp.como(current_setting('test.owner_a')::uuid);
UPDATE public.orders SET device_password='pin:'||current_setting('test.secret_legacy')
 WHERE id=current_setting('test.legacy_order')::uuid;
RESET ROLE;
DO $$ BEGIN
  IF (SELECT count(*) FROM private.order_device_access_audit
       WHERE order_id=current_setting('test.legacy_order')::uuid
         AND action='legacy_secret_write_mirrored' AND operation='set')<>2 THEN
    RAISE EXCEPTION 'LEGACY FAIL: same-value write no fue auditado';END IF;
  IF (SELECT count(*) FROM vault.secrets
       WHERE name LIKE 'order-device-access:'||current_setting('test.legacy_order')||':%')<>1 THEN
    RAISE EXCEPTION 'NO-RECURSION FAIL: same-value write duplicó Vault';END IF;
END $$;

SET LOCAL ROLE authenticated;
SELECT pg_temp.como(current_setting('test.owner_a')::uuid);
UPDATE public.orders SET device_password=NULL WHERE id=current_setting('test.legacy_order')::uuid;
RESET ROLE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM private.order_device_access_secrets
             WHERE order_id=current_setting('test.legacy_order')::uuid) THEN RAISE EXCEPTION 'LEGACY FAIL: clear conservó mapping';END IF;
  IF (SELECT count(*) FROM private.order_device_access_audit
       WHERE order_id=current_setting('test.legacy_order')::uuid
         AND action='legacy_secret_write_mirrored' AND operation='delete')<>1 THEN RAISE EXCEPTION 'LEGACY FAIL: clear audit';END IF;
END $$;

SET LOCAL ROLE authenticated;
SELECT pg_temp.como(current_setting('test.owner_a')::uuid);
DO $$ DECLARE v_rows bigint;BEGIN
  UPDATE public.orders SET device_password='pin:'||current_setting('test.secret_legacy')
   WHERE id=current_setting('test.order_b')::uuid;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>0 THEN RAISE EXCEPTION 'TENANT FAIL: legacy write cross-tenant';END IF;
END $$;

SELECT pg_temp.como(current_setting('test.owner_a')::uuid);
SELECT public.delete_order_device_access_secret(current_setting('test.order_id')::uuid);
RESET ROLE;
DO $$ BEGIN
  IF private.mobile2a_secret_from_legacy('pattern:0-4-8')<>'[0, 4, 8]' OR
     private.mobile2a_legacy_from_access('pattern','[0,4,8]')<>'pattern:0-4-8' THEN RAISE EXCEPTION 'LEGACY FAIL: codec pattern';END IF;
  IF EXISTS(SELECT 1 FROM private.order_device_access_secrets WHERE order_id=current_setting('test.order_id')::uuid) THEN RAISE EXCEPTION 'C FAIL: delete conservó mapping';END IF;
  IF (SELECT device_password FROM public.orders WHERE id=current_setting('test.order_id')::uuid) IS NOT NULL THEN RAISE EXCEPTION 'COEXIST FAIL: delete no limpió shadow legacy';END IF;
  IF NOT EXISTS(SELECT 1 FROM private.order_device_access_audit WHERE order_id=current_setting('test.order_id')::uuid AND action='deleted') THEN RAISE EXCEPTION 'C FAIL: delete sin auditoría';END IF;
  IF EXISTS(SELECT 1 FROM private.order_device_access_audit WHERE order_id=current_setting('test.order_b')::uuid AND action='legacy_secret_write_mirrored') THEN RAISE EXCEPTION 'TENANT FAIL: cross-tenant generó audit';END IF;
  IF EXISTS(SELECT 1 FROM information_schema.columns
             WHERE table_schema='private' AND table_name='order_device_access_audit'
               AND column_name LIKE '%secret%') THEN RAISE EXCEPTION 'SECRET SAFETY FAIL: audit contiene columna de secreto';END IF;
  IF EXISTS(SELECT 1 FROM public.orders
             WHERE notes IN (current_setting('test.secret_create'),current_setting('test.secret_replace'),current_setting('test.secret_legacy'))) OR
     EXISTS(SELECT 1 FROM public.documents
             WHERE file_name IN (current_setting('test.secret_create'),current_setting('test.secret_replace'),current_setting('test.secret_legacy'))) THEN
    RAISE EXCEPTION 'SECRET SAFETY FAIL: secreto fuera del contrato de acceso';END IF;
END $$;

DO $$ BEGIN
  IF has_table_privilege('authenticated','private.order_device_access_secrets','SELECT') THEN RAISE EXCEPTION 'D FAIL: tabla privada legible';END IF;
  IF has_function_privilege('anon','public.create_order_intake(uuid,jsonb,text)','EXECUTE') THEN RAISE EXCEPTION 'D FAIL: anon ejecuta create';END IF;
  RAISE NOTICE 'C/D OK · coexistencia, no-recursión, cross-tenant, capability y grants fail-closed';
END $$;

ROLLBACK;
