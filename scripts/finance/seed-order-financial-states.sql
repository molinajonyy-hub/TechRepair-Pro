-- ============================================================================
-- P0-A.1U1V — Seed LOCAL para el recorrido visual. Nunca contra producción.
-- Cuatro órdenes completadas con los cuatro estados financieros e importes
-- deliberadamente distintos, para que un cruce o un fallback falso se vea.
--   1. sin_facturar  · sin comprobante
--   2. pendiente     · 111.111 · 100 % a cuenta corriente
--   3. parcial       · 222.222 · 22.222 en efectivo + resto a CC
--   4. cobrado       · 333.333 · todo en efectivo (importe grande a propósito)
-- Incluye un cliente y un equipo de nombre largo para probar truncamiento.
-- ============================================================================
SET client_min_messages = warning;

SET session_replication_role = 'replica';
DELETE FROM comprobante_payments WHERE business_id='00000000-0000-0000-0000-00000000d001';
DELETE FROM comprobante_items    WHERE business_id='00000000-0000-0000-0000-00000000d001';
DELETE FROM comprobante_checkout_requests WHERE business_id='00000000-0000-0000-0000-00000000d001';
DELETE FROM account_movements    WHERE business_id='00000000-0000-0000-0000-00000000d001';
DELETE FROM accounts             WHERE business_id='00000000-0000-0000-0000-00000000d001';
DELETE FROM financial_movements  WHERE business_id='00000000-0000-0000-0000-00000000d001';
DELETE FROM business_finance_entries WHERE business_id='00000000-0000-0000-0000-00000000d001';
UPDATE comprobantes SET order_id=NULL WHERE business_id='00000000-0000-0000-0000-00000000d001';
DELETE FROM comprobantes         WHERE business_id='00000000-0000-0000-0000-00000000d001';
DELETE FROM status_history       WHERE business_id='00000000-0000-0000-0000-00000000d001';
DELETE FROM order_items          WHERE business_id='00000000-0000-0000-0000-00000000d001';
DELETE FROM orders               WHERE business_id='00000000-0000-0000-0000-00000000d001';
DELETE FROM devices              WHERE business_id='00000000-0000-0000-0000-00000000d001';
DELETE FROM cajas                WHERE business_id='00000000-0000-0000-0000-00000000d001';
DELETE FROM customers            WHERE business_id='00000000-0000-0000-0000-00000000d001';
DELETE FROM profiles             WHERE business_id='00000000-0000-0000-0000-00000000d001';
DELETE FROM businesses           WHERE id='00000000-0000-0000-0000-00000000d001';
SET session_replication_role = 'origin';

-- Usuario local de prueba con contraseña conocida SOLO para el stack local.
-- No viaja a ningún bundle: vive en la base de Docker.
DELETE FROM auth.users WHERE email = 'visual@local.test';
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES (
  '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000d009',
  'authenticated', 'authenticated', 'visual@local.test',
  crypt('visual-local-1234', gen_salt('bf')), now(), now(), now(),
  '{"provider":"email","providers":["email"]}', '{}'
);
INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, created_at, updated_at)
VALUES (gen_random_uuid(), '00000000-0000-0000-0000-00000000d009',
  '{"sub":"00000000-0000-0000-0000-00000000d009","email":"visual@local.test"}',
  'email', '00000000-0000-0000-0000-00000000d009', now(), now());

SET session_replication_role = 'replica';
INSERT INTO businesses(id,name,owner_user_id) VALUES
  ('00000000-0000-0000-0000-00000000d001','Taller Visual Local','00000000-0000-0000-0000-00000000d009');
-- id = auth.uid(): current_business_id() resuelve por profiles.id, no por user_id.
INSERT INTO profiles(id,business_id,user_id,role,is_active,full_name,email) VALUES
  ('00000000-0000-0000-0000-00000000d009','00000000-0000-0000-0000-00000000d001',
   '00000000-0000-0000-0000-00000000d009','owner',true,'Dueño Local','visual@local.test');
INSERT INTO customers(id,business_id,name,phone,customer_type) VALUES
  ('00000000-0000-0000-0000-00000000dc01','00000000-0000-0000-0000-00000000d001','Ana Gómez','+5493510000001','minorista'),
  ('00000000-0000-0000-0000-00000000dc02','00000000-0000-0000-0000-00000000d001',
   'Distribuidora Tecnológica del Centro y Alrededores S.R.L.','+5493510000002','minorista');
INSERT INTO devices(id,business_id,customer_id,type,brand,model,issue) VALUES
  ('00000000-0000-0000-0000-00000000de01','00000000-0000-0000-0000-00000000d001','00000000-0000-0000-0000-00000000dc01','smartphone','Motorola','G54','No enciende'),
  ('00000000-0000-0000-0000-00000000de02','00000000-0000-0000-0000-00000000d001','00000000-0000-0000-0000-00000000dc02','laptop',
   'Lenovo','ThinkPad X1 Carbon Gen 11 Ultrabook Empresarial','Pantalla rota y bisagra floja');
INSERT INTO cajas(id,business_id,opened_by,status) VALUES
  ('00000000-0000-0000-0000-00000000d061','00000000-0000-0000-0000-00000000d001','00000000-0000-0000-0000-00000000d009','abierta');
INSERT INTO orders(id,business_id,customer_id,device_id,status,created_by) VALUES
  ('00000000-0000-0000-0000-00000000df01','00000000-0000-0000-0000-00000000d001','00000000-0000-0000-0000-00000000dc01','00000000-0000-0000-0000-00000000de01','completed','00000000-0000-0000-0000-00000000d009'),
  ('00000000-0000-0000-0000-00000000df02','00000000-0000-0000-0000-00000000d001','00000000-0000-0000-0000-00000000dc01','00000000-0000-0000-0000-00000000de01','completed','00000000-0000-0000-0000-00000000d009'),
  ('00000000-0000-0000-0000-00000000df03','00000000-0000-0000-0000-00000000d001','00000000-0000-0000-0000-00000000dc02','00000000-0000-0000-0000-00000000de02','completed','00000000-0000-0000-0000-00000000d009'),
  ('00000000-0000-0000-0000-00000000df04','00000000-0000-0000-0000-00000000d001','00000000-0000-0000-0000-00000000dc02','00000000-0000-0000-0000-00000000de02','completed','00000000-0000-0000-0000-00000000d009');
SET session_replication_role = 'origin';

-- Orden 1: queda SIN FACTURAR (no se emite comprobante).
INSERT INTO order_items(order_id,business_id,tipo,descripcion,cantidad,precio_unitario,costo_unitario,cliente_paga_repuesto)
  VALUES ('00000000-0000-0000-0000-00000000df01','00000000-0000-0000-0000-00000000d001','servicio','Diagnóstico sin cargo',1,44444,0,false);

SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000d009';

-- Orden 2 -> PENDIENTE (100 % cuenta corriente).
SELECT create_comprobante_checkout_atomic('00000000-0000-0000-0000-00000000d001'::uuid,'VIS-2','v2',
  jsonb_build_object('tipo','factura_c','punto_venta','0001','condicion_fiscal','Consumidor Final',
    'customer_id','00000000-0000-0000-0000-00000000dc01','order_id','00000000-0000-0000-0000-00000000df02',
    'es_fiscal',false,'cc_total',111111,
    'items',jsonb_build_array(jsonb_build_object('descripcion','Cambio de pantalla','tipo_linea','servicio',
      'cantidad',1,'precio_unitario',111111,'descuento_linea',0,'costo_unitario',0,'currency','ARS','exchange_rate',1,'inventory_id',NULL)),
    'pagos','[]'::jsonb)) AS r2 \gset

-- Orden 3 -> PARCIAL (22.222 en efectivo + 200.000 a cuenta corriente).
SELECT create_comprobante_checkout_atomic('00000000-0000-0000-0000-00000000d001'::uuid,'VIS-3','v3',
  jsonb_build_object('tipo','factura_c','punto_venta','0001','condicion_fiscal','Consumidor Final',
    'customer_id','00000000-0000-0000-0000-00000000dc02','order_id','00000000-0000-0000-0000-00000000df03',
    'es_fiscal',false,'cc_total',200000,
    'items',jsonb_build_array(jsonb_build_object('descripcion','Reparación de bisagra y pantalla','tipo_linea','servicio',
      'cantidad',1,'precio_unitario',222222,'descuento_linea',0,'costo_unitario',0,'currency','ARS','exchange_rate',1,'inventory_id',NULL)),
    'pagos',jsonb_build_array(jsonb_build_object('payment_method','efectivo','amount',22222,'currency','ARS','amount_ars',22222,'exchange_rate',1)))) AS r3 \gset

-- Orden 4 -> COBRADO (importe grande, todo en efectivo).
SELECT create_comprobante_checkout_atomic('00000000-0000-0000-0000-00000000d001'::uuid,'VIS-4','v4',
  jsonb_build_object('tipo','factura_c','punto_venta','0001','condicion_fiscal','Consumidor Final',
    'customer_id','00000000-0000-0000-0000-00000000dc02','order_id','00000000-0000-0000-0000-00000000df04',
    'es_fiscal',false,'cc_total',0,
    'items',jsonb_build_array(jsonb_build_object('descripcion','Reemplazo de placa madre completa','tipo_linea','servicio',
      'cantidad',1,'precio_unitario',333333,'descuento_linea',0,'costo_unitario',0,'currency','ARS','exchange_rate',1,'inventory_id',NULL)),
    'pagos',jsonb_build_array(jsonb_build_object('payment_method','efectivo','amount',333333,'currency','ARS','amount_ars',333333,'exchange_rate',1)))) AS r4 \gset
RESET ROLE;

SELECT left(order_id::text,8) AS orden, estado_tecnico, payment_status
FROM v_order_payment_state
WHERE business_id='00000000-0000-0000-0000-00000000d001'
ORDER BY payment_status;
