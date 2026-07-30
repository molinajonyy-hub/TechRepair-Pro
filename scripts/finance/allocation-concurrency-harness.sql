-- ============================================================================
-- P0-A.1C — Harness de CONCURRENCIA REAL para la imputación de cobros.
-- Se ejecuta con DOS conexiones psql independientes (ver el .mjs que lo maneja).
-- Este archivo sólo SIEMBRA el escenario y queda COMMITEADO; la limpieza va al final.
--   Caso 1: pago 60.000 · comprobante A saldo 60.000 · dos sesiones imputan lo mismo.
--   Caso 2: pago 100.000 · A saldo 60.000 · B saldo 40.000 · repartos incompatibles.
-- ============================================================================
\set biz  '00000000-0000-0000-0000-00000c0nc001'
SET client_min_messages = warning;

-- Limpieza previa (idempotente). Los triggers de inmutabilidad se desactivan
-- SOLO para la limpieza del escenario de prueba, nunca en el flujo real.
SET session_replication_role = 'replica';
DELETE FROM customer_account_payment_allocations WHERE business_id = '00000000-0000-0000-0000-0000000c0c01';
-- finance_audit_log es append-only por diseño: no se limpia, se deja crecer.
DELETE FROM business_finance_entries  WHERE business_id = '00000000-0000-0000-0000-0000000c0c01';
DELETE FROM financial_movements       WHERE business_id = '00000000-0000-0000-0000-0000000c0c01';
DELETE FROM account_movements         WHERE business_id = '00000000-0000-0000-0000-0000000c0c01';
DELETE FROM accounts                  WHERE business_id = '00000000-0000-0000-0000-0000000c0c01';
DELETE FROM comprobante_payments      WHERE business_id = '00000000-0000-0000-0000-0000000c0c01';
DELETE FROM comprobante_items         WHERE business_id = '00000000-0000-0000-0000-0000000c0c01';
DELETE FROM comprobante_checkout_requests WHERE business_id = '00000000-0000-0000-0000-0000000c0c01';
DELETE FROM account_payment_requests WHERE business_id = '00000000-0000-0000-0000-0000000c0c01';
UPDATE comprobantes SET order_id = NULL WHERE business_id = '00000000-0000-0000-0000-0000000c0c01';
DELETE FROM status_history            WHERE business_id = '00000000-0000-0000-0000-0000000c0c01';
DELETE FROM comprobantes              WHERE business_id = '00000000-0000-0000-0000-0000000c0c01';
DELETE FROM order_items               WHERE business_id = '00000000-0000-0000-0000-0000000c0c01';
DELETE FROM orders                    WHERE business_id = '00000000-0000-0000-0000-0000000c0c01';
DELETE FROM cajas                     WHERE business_id = '00000000-0000-0000-0000-0000000c0c01';
DELETE FROM customers                 WHERE business_id = '00000000-0000-0000-0000-0000000c0c01';
DELETE FROM profiles                  WHERE business_id = '00000000-0000-0000-0000-0000000c0c01';
DELETE FROM businesses                WHERE id          = '00000000-0000-0000-0000-0000000c0c01';
DELETE FROM auth.users                WHERE id          = '00000000-0000-0000-0000-0000000c0c09';

SET session_replication_role = 'replica';
INSERT INTO auth.users(id) VALUES ('00000000-0000-0000-0000-0000000c0c09');
INSERT INTO businesses(id,name,owner_user_id) VALUES ('00000000-0000-0000-0000-0000000c0c01','CONC','00000000-0000-0000-0000-0000000c0c09');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES ('00000000-0000-0000-0000-0000000c0c01','00000000-0000-0000-0000-0000000c0c09','owner',true);
INSERT INTO customers(id,business_id,name,phone,customer_type) VALUES ('00000000-0000-0000-0000-0000000c0cc1','00000000-0000-0000-0000-0000000c0c01','Cli','+5400','minorista');
INSERT INTO cajas(id,business_id,opened_by,status) VALUES ('00000000-0000-0000-0000-0000000c0c61','00000000-0000-0000-0000-0000000c0c01','00000000-0000-0000-0000-0000000c0c09','abierta');
INSERT INTO orders(id,business_id,status,created_by) VALUES
  ('00000000-0000-0000-0000-0000000c0cf1','00000000-0000-0000-0000-0000000c0c01','repair','00000000-0000-0000-0000-0000000c0c09'),
  ('00000000-0000-0000-0000-0000000c0cf2','00000000-0000-0000-0000-0000000c0c01','repair','00000000-0000-0000-0000-0000000c0c09');
SET session_replication_role = 'origin';

-- Dos ventas 100 % a cuenta corriente: A = 60.000, B = 40.000.
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c0c09';
SELECT create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000c0c01'::uuid,'CC-A','ha',
  jsonb_build_object('tipo','factura_c','punto_venta','0001','condicion_fiscal','Consumidor Final',
    'customer_id','00000000-0000-0000-0000-0000000c0cc1','order_id','00000000-0000-0000-0000-0000000c0cf1',
    'es_fiscal',false,'cc_total',60000,
    'items',jsonb_build_array(jsonb_build_object('descripcion','Serv A','tipo_linea','servicio','cantidad',1,
      'precio_unitario',60000,'descuento_linea',0,'costo_unitario',0,'currency','ARS','exchange_rate',1,'inventory_id',NULL)),
    'pagos','[]'::jsonb)) AS checkout_a \gset
SELECT create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000c0c01'::uuid,'CC-B','hb',
  jsonb_build_object('tipo','factura_c','punto_venta','0001','condicion_fiscal','Consumidor Final',
    'customer_id','00000000-0000-0000-0000-0000000c0cc1','order_id','00000000-0000-0000-0000-0000000c0cf2',
    'es_fiscal',false,'cc_total',40000,
    'items',jsonb_build_array(jsonb_build_object('descripcion','Serv B','tipo_linea','servicio','cantidad',1,
      'precio_unitario',40000,'descuento_linea',0,'costo_unitario',0,'currency','ARS','exchange_rate',1,'inventory_id',NULL)),
    'pagos','[]'::jsonb)) AS checkout_b \gset
RESET ROLE;
-- El id de la cuenta se resuelve como postgres: bajo el rol `authenticated` el
-- subselect queda filtrado por RLS y devolvería NULL (la RPC respondería
-- ACCOUNT_NOT_FOUND aunque la cuenta exista).
SELECT id AS acc_id FROM accounts WHERE business_id='00000000-0000-0000-0000-0000000c0c01' LIMIT 1 \gset

-- Cobro a cuenta por 100.000 (deuda total = 100.000).
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000c0c09';
SELECT record_customer_account_payment_atomic('00000000-0000-0000-0000-0000000c0c01'::uuid,
  :'acc_id'::uuid,
  100000,'Cobro a cuenta','00000000-0000-0000-0000-0000000c0c09'::uuid,'efectivo',public.ar_today(),
  '00000000-0000-0000-0000-0000000c0c61'::uuid,'CONC-PAY') AS pago \gset
RESET ROLE;

SELECT 'SEED_OK' AS estado,
  (SELECT id FROM account_movements WHERE business_id='00000000-0000-0000-0000-0000000c0c01' AND type='pago') AS payment_id,
  (SELECT id FROM comprobantes WHERE order_id='00000000-0000-0000-0000-0000000c0cf1') AS comp_a,
  (SELECT id FROM comprobantes WHERE order_id='00000000-0000-0000-0000-0000000c0cf2') AS comp_b;
