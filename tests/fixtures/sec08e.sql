-- Synthetic data ONLY. Harness runs this in a schema-only disposable database.
SET session_replication_role = replica;
INSERT INTO auth.users(id,email,email_confirmed_at)
SELECT ('e0800000-0000-0000-0000-' || lpad(i::text,12,'0'))::uuid,
       'sec08e-'||i||'@test.invalid', now() FROM generate_series(1,10) i;
INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status)
VALUES ('e0800000-0000-0000-0000-000000000101','SEC08E A','e0800000-0000-0000-0000-000000000001','pro','active'),
       ('e0800000-0000-0000-0000-000000000102','SEC08E B','e0800000-0000-0000-0000-000000000005','pro','active');
INSERT INTO public.profiles(id,user_id,business_id,role,is_active,email,permissions)
SELECT u.id,u.id,
  CASE WHEN x.i=5 THEN 'e0800000-0000-0000-0000-000000000102' ELSE 'e0800000-0000-0000-0000-000000000101' END::uuid,
  (ARRAY['owner','tech','viewer','cashier','owner','admin','tech','sales','manager','admin'])[x.i],
  x.i<>6,u.email,
  CASE WHEN x.i IN (2,3) THEN '{"finance":false,"inventory_view_costs":false,"orders_view_financials":false}'::jsonb
       WHEN x.i=7 THEN '{"orders_view_financials":true}'::jsonb ELSE NULL END
FROM generate_series(1,10) x(i) JOIN auth.users u
  ON u.id=('e0800000-0000-0000-0000-'||lpad(x.i::text,12,'0'))::uuid;
-- Exercise canonical profile identity on an authorized financial actor too.
UPDATE public.profiles SET user_id=NULL WHERE id='e0800000-0000-0000-0000-000000000009';
INSERT INTO public.customers(id,business_id,name,phone)
VALUES ('e0800000-0000-0000-0000-000000000201','e0800000-0000-0000-0000-000000000101','Fixture customer','1');
INSERT INTO public.orders(id,business_id,customer_id,status)
VALUES ('e0800000-0000-0000-0000-000000000301','e0800000-0000-0000-0000-000000000101','e0800000-0000-0000-0000-000000000201','repair');
INSERT INTO public.parts_used(id,business_id,order_id,code,description,quantity,unit_price)
VALUES ('e0800000-0000-0000-0000-000000000401','e0800000-0000-0000-0000-000000000101','e0800000-0000-0000-0000-000000000301','SCREEN-E','Operational screen',3,7103.19);
INSERT INTO public.comprobantes(id,business_id,order_id,customer_id,tipo,estado,subtotal,impuestos,total,total_bruto,total_cobrado,saldo_pendiente,currency,total_ars,total_usd,exchange_rate,tax,status,fecha)
VALUES ('e0800000-0000-0000-0000-000000000501','e0800000-0000-0000-0000-000000000101','e0800000-0000-0000-0000-000000000301','e0800000-0000-0000-0000-000000000201','factura_c','emitido',9011,0,9011,9011,0,9011,'ARS',9011,0,1,0,'active',now()),
('e0800000-0000-0000-0000-000000000502','e0800000-0000-0000-0000-000000000101',NULL,'e0800000-0000-0000-0000-000000000201','factura_c','emitido',9012,0,9012,9012,0,9012,'ARS',9012,0,1,0,'active',now());
INSERT INTO public.comprobante_annulments(id,business_id,comprobante_id,user_id,idempotency_key,request_hash,mode,motivo,restore_stock,reverted_cash_ars,reverted_cc_ars,reverted_commissions_ars,reverted_cogs_ars)
SELECT ('e0800000-0000-0000-0000-'||lpad((600+i)::text,12,'0'))::uuid,
 'e0800000-0000-0000-0000-000000000101',
 ('e0800000-0000-0000-0000-'||lpad((500+i)::text,12,'0'))::uuid,
 'e0800000-0000-0000-0000-000000000001','sec08e-replay-'||i,
 encode(extensions.digest(jsonb_build_object('op','comprobante_annulment',
   'business_id','e0800000-0000-0000-0000-000000000101'::uuid,
   'comprobante_id',('e0800000-0000-0000-0000-'||lpad((500+i)::text,12,'0'))::uuid,
   'mode','commercial_annulment','restore_stock',false,'reason','Fixture replay')::text,'sha256'),'hex'),
 'commercial_annulment','Fixture replay',false,8317.13,4723.17,193.23,6197.29
FROM generate_series(1,2) i;
-- Parent FKs are deliberately outside the fixture; no triggers/business
-- workflows are bypassed outside this synthetic fixture setup transaction.
INSERT INTO public.customer_account_payment_allocations(id,business_id,customer_id,account_id,payment_movement_id,comprobante_id,amount,currency,status,idempotency_key,created_by)
VALUES ('e0800000-0000-0000-0000-000000000701','e0800000-0000-0000-0000-000000000101',
 'e0800000-0000-0000-0000-000000000201','e0800000-0000-0000-0000-000000000801',
 'e0800000-0000-0000-0000-000000000901','e0800000-0000-0000-0000-000000000501',
 3719.31,'ARS','active','sec08e-allocation','e0800000-0000-0000-0000-000000000001');
SET session_replication_role = origin;
