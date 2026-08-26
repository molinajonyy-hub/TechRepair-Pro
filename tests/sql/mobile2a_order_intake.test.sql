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
  PERFORM set_config('test.owner_a',v_owner_a::text,false);PERFORM set_config('test.admin_a',v_admin_a::text,false);
  PERFORM set_config('test.manager_a',v_manager_a::text,false);PERFORM set_config('test.tech_a',v_tech_a::text,false);
  PERFORM set_config('test.sales_a',v_sales_a::text,false);PERFORM set_config('test.cashier_a',v_cashier_a::text,false);
  PERFORM set_config('test.viewer_a',v_viewer_a::text,false);PERFORM set_config('test.owner_b',v_owner_b::text,false);
  PERFORM set_config('test.biz_a',v_biz_a::text,false);PERFORM set_config('test.customer_a',v_customer_a::text,false);PERFORM set_config('test.customer_b',v_customer_b::text,false);
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
  '4826'
)->>'order_id'),false);
RESET ROLE;

DO $$
DECLARE v_order uuid:=current_setting('test.order_id')::uuid;v_device uuid;v_secret_id uuid;v_plain text;v_n int;
BEGIN
  SELECT device_id INTO v_device FROM public.orders WHERE id=v_order AND business_id=current_setting('test.biz_a')::uuid;
  IF v_device IS NULL THEN RAISE EXCEPTION 'A FAIL: no se creó orden tenant-safe';END IF;
  IF (SELECT device_password FROM public.orders WHERE id=v_order) IS NOT NULL THEN RAISE EXCEPTION 'A FAIL: plaintext en orders';END IF;
  IF (SELECT estimated_total_currency FROM public.orders WHERE id=v_order)<>'ARS' THEN RAISE EXCEPTION 'A FAIL: moneda';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.device_inspections WHERE order_id=v_order AND type='reception' AND intake_check_results->>'display'='ok') THEN RAISE EXCEPTION 'A FAIL: inspección';END IF;
  SELECT vault_secret_id INTO v_secret_id FROM private.order_device_access_secrets WHERE order_id=v_order;
  SELECT decrypted_secret INTO v_plain FROM vault.decrypted_secrets WHERE id=v_secret_id;
  IF v_plain<>'4826' THEN RAISE EXCEPTION 'A FAIL: Vault';END IF;
  SELECT count(*) INTO v_n FROM private.order_device_access_audit WHERE order_id=v_order AND action='stored';
  IF v_n<>1 THEN RAISE EXCEPTION 'A FAIL: auditoría store';END IF;
  IF (SELECT count(*) FROM public.financial_movements)<>current_setting('test.fm_before')::int OR
     (SELECT count(*) FROM public.account_movements)<>current_setting('test.am_before')::int OR
     (SELECT count(*) FROM public.comprobantes)<>current_setting('test.comp_before')::int THEN
    RAISE EXCEPTION 'A FAIL: el intake escribió finanzas/CC/comprobantes';END IF;
  RAISE NOTICE 'A OK · orden/dispositivo/inspección atómicos, Vault y cero writes financieros';
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
    '4826');
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
  IF v_value<>'4826' THEN RAISE EXCEPTION 'C FAIL: owner no reveló';END IF;
END $$;
RESET ROLE;
DO $$ BEGIN
  IF (SELECT count(*) FROM private.order_device_access_audit WHERE order_id=current_setting('test.order_id')::uuid AND action='revealed')<>1 THEN RAISE EXCEPTION 'C FAIL: reveal sin auditoría';END IF;
END $$;
SET LOCAL ROLE authenticated;
SELECT pg_temp.como(current_setting('test.owner_a')::uuid);
SELECT public.delete_order_device_access_secret(current_setting('test.order_id')::uuid);
RESET ROLE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM private.order_device_access_secrets WHERE order_id=current_setting('test.order_id')::uuid) THEN RAISE EXCEPTION 'C FAIL: delete conservó mapping';END IF;
  IF NOT EXISTS(SELECT 1 FROM private.order_device_access_audit WHERE order_id=current_setting('test.order_id')::uuid AND action='deleted') THEN RAISE EXCEPTION 'C FAIL: delete sin auditoría';END IF;
END $$;

DO $$ BEGIN
  IF has_table_privilege('authenticated','private.order_device_access_secrets','SELECT') THEN RAISE EXCEPTION 'D FAIL: tabla privada legible';END IF;
  IF has_function_privilege('anon','public.create_order_intake(uuid,jsonb,text)','EXECUTE') THEN RAISE EXCEPTION 'D FAIL: anon ejecuta create';END IF;
  RAISE NOTICE 'C/D OK · cross-tenant, capability y grants fail-closed';
END $$;

ROLLBACK;
