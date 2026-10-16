-- CLIENTES-UX-1B · matriz SQL del contacto alternativo y el destinatario por orden.
-- Corre en el Postgres local del job E2E (npm run test:sql:clientes-ux-1b).
-- Todo se revierte: fixtures, filas y cambios de rol.
BEGIN;
CREATE FUNCTION pg_temp.assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %',label; END IF; RAISE NOTICE 'PASS: %',label; END $$;
CREATE FUNCTION pg_temp.denied(statement text,label text,expected_state text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual_state text;
BEGIN
  BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS actual_state=RETURNED_SQLSTATE; END;
  PERFORM pg_temp.assert(actual_state=expected_state,label || ' [' || coalesce(actual_state,'unexpected success') || ']');
END $$;

-- ── Fixtures (sin triggers) ──────────────────────────────────────────────────
-- A1 owner de A · A2 técnico de A sin orders_create ni orders_change_status · B1 owner de B
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) VALUES
 ('00000000-0000-0000-0000-0000000c1a01'),('00000000-0000-0000-0000-0000000c1a02'),('00000000-0000-0000-0000-0000000c1b01');
INSERT INTO public.businesses(id,name,owner_user_id) VALUES
 ('00000000-0000-0000-0000-00000000cb0a','CLIUX1B SQL A','00000000-0000-0000-0000-0000000c1a01'),
 ('00000000-0000-0000-0000-00000000cb0b','CLIUX1B SQL B','00000000-0000-0000-0000-0000000c1b01');
INSERT INTO public.profiles(id,user_id,business_id,role,is_active,permissions) VALUES
 ('00000000-0000-0000-0000-0000000c1a01','00000000-0000-0000-0000-0000000c1a01','00000000-0000-0000-0000-00000000cb0a','owner',true,NULL),
 ('00000000-0000-0000-0000-0000000c1a02','00000000-0000-0000-0000-0000000c1a02','00000000-0000-0000-0000-00000000cb0a','tech',true,
  '{"orders":true,"orders_create":false,"orders_change_status":false,"customers":true}'::jsonb),
 ('00000000-0000-0000-0000-0000000c1b01','00000000-0000-0000-0000-0000000c1b01','00000000-0000-0000-0000-00000000cb0b','owner',true,NULL);
INSERT INTO public.customers(id,business_id,name,phone,customer_type,business_name) VALUES
 ('00000000-0000-0000-0000-0000000cc0a1','00000000-0000-0000-0000-00000000cb0a','Juan Titular','3511234567','minorista',NULL),
 ('00000000-0000-0000-0000-0000000cc0a2','00000000-0000-0000-0000-00000000cb0a','Mayorista SQL','3517654321','mayorista','Demo SRL'),
 ('00000000-0000-0000-0000-0000000cc0b1','00000000-0000-0000-0000-00000000cb0b','Cliente de B','3510000000','minorista',NULL);
INSERT INTO public.orders(id,business_id,customer_id,status,priority) VALUES
 ('00000000-0000-0000-0000-0000000c0da1','00000000-0000-0000-0000-00000000cb0a','00000000-0000-0000-0000-0000000cc0a1','new','medium'),
 ('00000000-0000-0000-0000-0000000c0db1','00000000-0000-0000-0000-00000000cb0b','00000000-0000-0000-0000-0000000cc0b1','new','medium');
SET LOCAL session_replication_role=origin;

-- ── 1. Contrato de privilegios ───────────────────────────────────────────────
SELECT pg_temp.assert(has_table_privilege('authenticated','public.order_notification_recipients','SELECT'),'authenticated lee destinatarios (con RLS)');
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.order_notification_recipients','INSERT')
                  AND NOT has_table_privilege('authenticated','public.order_notification_recipients','UPDATE')
                  AND NOT has_table_privilege('authenticated','public.order_notification_recipients','DELETE'),'sin escritura directa de destinatarios');
SELECT pg_temp.assert(NOT has_table_privilege('anon','public.order_notification_recipients','SELECT'),'anon no lee destinatarios');
SELECT pg_temp.assert(NOT has_function_privilege('anon','public.set_order_notification_recipient(uuid,text)','EXECUTE'),'anon no ejecuta la RPC');
SELECT pg_temp.assert(has_column_privilege('authenticated','public.customers','notification_contact_phone','UPDATE'),'el contacto alternativo se edita como el resto del cliente');

-- ── 2. Owner de A ────────────────────────────────────────────────────────────
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000c1a01',true);
SET LOCAL ROLE authenticated;

-- Constraints del contacto alternativo
SELECT pg_temp.denied($q$UPDATE public.customers SET notification_contact_name='María' WHERE id='00000000-0000-0000-0000-0000000cc0a1'$q$,'nombre sin teléfono rechazado','23514');
SELECT pg_temp.denied($q$UPDATE public.customers SET notification_contact_name='María', notification_contact_phone='351-ABC-123' WHERE id='00000000-0000-0000-0000-0000000cc0a1'$q$,'teléfono con letras rechazado','23514');
SELECT pg_temp.denied($q$UPDATE public.customers SET notification_contact_name='María', notification_contact_phone='12345' WHERE id='00000000-0000-0000-0000-0000000cc0a1'$q$,'teléfono corto rechazado','23514');
SELECT pg_temp.denied($q$UPDATE public.customers SET notification_contact_name='   ', notification_contact_phone='3519998888' WHERE id='00000000-0000-0000-0000-0000000cc0a1'$q$,'nombre en blanco rechazado','23514');
UPDATE public.customers SET notification_contact_name='Contacto Intl', notification_contact_phone='+34 612 345 678' WHERE id='00000000-0000-0000-0000-0000000cc0a1';
SELECT pg_temp.assert((SELECT notification_contact_phone='+34 612 345 678' FROM public.customers WHERE id='00000000-0000-0000-0000-0000000cc0a1'),'teléfono internacional aceptado');

-- Sin contacto alternativo no se puede elegir.
UPDATE public.customers SET notification_contact_name=NULL, notification_contact_phone=NULL WHERE id='00000000-0000-0000-0000-0000000cc0a1';
SELECT pg_temp.denied($q$SELECT public.set_order_notification_recipient('00000000-0000-0000-0000-0000000c0da1','alternate')$q$,'alternativo sin contacto cargado','22023');
SELECT pg_temp.denied($q$SELECT public.set_order_notification_recipient('00000000-0000-0000-0000-0000000c0da1','vecino')$q$,'destinatario inválido','22023');

UPDATE public.customers SET notification_contact_name='María Hija', notification_contact_phone='351 15 555-1234' WHERE id='00000000-0000-0000-0000-0000000cc0a1';
SELECT pg_temp.assert((SELECT (public.set_order_notification_recipient('00000000-0000-0000-0000-0000000c0da1','alternate'))->>'contact_phone'='351 15 555-1234'),'elegir alternativo devuelve la copia');
SELECT pg_temp.assert((SELECT recipient='alternate' AND contact_name='María Hija' AND contact_phone='351 15 555-1234'
                         FROM public.order_notification_recipients WHERE order_id='00000000-0000-0000-0000-0000000c0da1'),'la orden guarda una copia del contacto');

-- La ficha cambia: la orden conserva a quien se eligió.
UPDATE public.customers SET notification_contact_name='Pedro Vecino', notification_contact_phone='3514443333' WHERE id='00000000-0000-0000-0000-0000000cc0a1';
SELECT pg_temp.assert((SELECT contact_name='María Hija' AND contact_phone='351 15 555-1234'
                         FROM public.order_notification_recipients WHERE order_id='00000000-0000-0000-0000-0000000c0da1'),'cambiar la ficha no cambia el destinatario elegido');
UPDATE public.customers SET notification_contact_name=NULL, notification_contact_phone=NULL WHERE id='00000000-0000-0000-0000-0000000cc0a1';
SELECT pg_temp.assert((SELECT contact_phone='351 15 555-1234' FROM public.order_notification_recipients WHERE order_id='00000000-0000-0000-0000-0000000c0da1'),'borrar el contacto de la ficha tampoco');

-- Volver al titular: sin copia.
SELECT public.set_order_notification_recipient('00000000-0000-0000-0000-0000000c0da1','customer');
SELECT public.set_order_notification_recipient('00000000-0000-0000-0000-0000000c0da1','customer');
SELECT pg_temp.assert((SELECT count(*)=1 AND bool_and(recipient='customer' AND contact_name IS NULL AND contact_phone IS NULL)
                         FROM public.order_notification_recipients WHERE order_id='00000000-0000-0000-0000-0000000c0da1'),'titular sin copia e idempotente');

-- Escritura directa cerrada.
SELECT pg_temp.denied($q$INSERT INTO public.order_notification_recipients(order_id,business_id,recipient) VALUES('00000000-0000-0000-0000-0000000c0da1','00000000-0000-0000-0000-00000000cb0a','customer')$q$,'insert directo cerrado','42501');
SELECT pg_temp.denied($q$UPDATE public.order_notification_recipients SET recipient='customer'$q$,'update directo cerrado','42501');

-- Nada de esto tocó la titularidad ni el teléfono principal.
SELECT pg_temp.assert((SELECT phone='3511234567' FROM public.customers WHERE id='00000000-0000-0000-0000-0000000cc0a1'),'teléfono principal intacto');
SELECT pg_temp.assert((SELECT customer_id='00000000-0000-0000-0000-0000000cc0a1' FROM public.orders WHERE id='00000000-0000-0000-0000-0000000c0da1'),'titularidad de la orden intacta');

-- Tenant: no ve ni escribe órdenes de B.
SELECT pg_temp.denied($q$SELECT public.set_order_notification_recipient('00000000-0000-0000-0000-0000000c0db1','customer')$q$,'orden de otro negocio','P0002');

-- ── 3. Técnico de A sin capacidad de recepción ni de seguimiento ─────────────
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000c1a02',true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.denied($q$SELECT public.set_order_notification_recipient('00000000-0000-0000-0000-0000000c0da1','customer')$q$,'sin orders_create ni orders_change_status','42501');
SELECT pg_temp.assert((SELECT count(*)=1 FROM public.order_notification_recipients),'con `orders` lee el destinatario de su negocio');
-- El contacto para avisos de un mayorista no dispara la autoridad Mayorista.
UPDATE public.customers SET notification_contact_name='Depósito', notification_contact_phone='3516667777' WHERE id='00000000-0000-0000-0000-0000000cc0a2';
SELECT pg_temp.assert((SELECT notification_contact_name='Depósito' AND customer_type='mayorista' AND business_name='Demo SRL'
                         FROM public.customers WHERE id='00000000-0000-0000-0000-0000000cc0a2'),'contacto para avisos de un mayorista editable sin acceso Mayorista');

-- ── 4. Owner de B ────────────────────────────────────────────────────────────
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000c1b01',true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert((SELECT count(*)=0 FROM public.order_notification_recipients),'B no ve los destinatarios de A');
SELECT public.set_order_notification_recipient('00000000-0000-0000-0000-0000000c0db1','customer');
SELECT pg_temp.assert((SELECT count(*)=1 AND bool_and(business_id='00000000-0000-0000-0000-00000000cb0b') FROM public.order_notification_recipients),'B escribe sólo en su negocio');

RESET ROLE;
ROLLBACK;
