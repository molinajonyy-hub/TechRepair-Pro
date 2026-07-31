-- ============================================================================
-- P0-A.1U2 — Seed LOCAL del recorrido de imputación (§14). Nunca producción.
--   orden 100.000 · 40.000 efectivo · 60.000 a cuenta corriente
--   + cobro genérico de 60.000 SIN imputar
-- Estado esperado al entrar: orden PARCIAL con saldo 60.000 y crédito 60.000.
-- Reutiliza el negocio y el usuario local de seed-order-financial-states.sql.
-- ============================================================================
SET client_min_messages = warning;

SET session_replication_role = 'replica';
DELETE FROM customer_account_payment_allocations WHERE business_id='00000000-0000-0000-0000-00000000d001';
DELETE FROM account_payment_requests WHERE business_id='00000000-0000-0000-0000-00000000d001';
SET session_replication_role = 'origin';

SET session_replication_role = 'replica';
INSERT INTO orders(id,business_id,customer_id,device_id,status,created_by) VALUES
  ('00000000-0000-0000-0000-00000000df09','00000000-0000-0000-0000-00000000d001',
   '00000000-0000-0000-0000-00000000dc01','00000000-0000-0000-0000-00000000de01','completed',
   '00000000-0000-0000-0000-00000000d009')
ON CONFLICT (id) DO NOTHING;
SET session_replication_role = 'origin';

SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000d009';

-- Orden 100.000: 40.000 efectivo + 60.000 a cuenta corriente.
SELECT create_comprobante_checkout_atomic('00000000-0000-0000-0000-00000000d001'::uuid,'WALK-1','w1',
  jsonb_build_object('tipo','factura_c','punto_venta','0001','condicion_fiscal','Consumidor Final',
    'customer_id','00000000-0000-0000-0000-00000000dc01','order_id','00000000-0000-0000-0000-00000000df09',
    'es_fiscal',false,'cc_total',60000,
    'items',jsonb_build_array(jsonb_build_object('descripcion','Reparación completa','tipo_linea','servicio',
      'cantidad',1,'precio_unitario',100000,'descuento_linea',0,'costo_unitario',0,
      'currency','ARS','exchange_rate',1,'inventory_id',NULL)),
    'pagos',jsonb_build_array(jsonb_build_object('payment_method','efectivo','amount',40000,
      'currency','ARS','amount_ars',40000,'exchange_rate',1)))) AS w1 \gset
RESET ROLE;

SELECT id AS acc FROM accounts
 WHERE business_id='00000000-0000-0000-0000-00000000d001'
   AND entity_id='00000000-0000-0000-0000-00000000dc01' LIMIT 1 \gset

-- Cobro genérico de 60.000: queda SIN imputar a propósito.
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000d009';
SELECT record_customer_account_payment_atomic('00000000-0000-0000-0000-00000000d001'::uuid,
  :'acc'::uuid, 60000, 'Cobro a cuenta del cliente',
  '00000000-0000-0000-0000-00000000d009'::uuid, 'efectivo', public.ar_today(),
  '00000000-0000-0000-0000-00000000d061'::uuid, 'WALK-PAY') AS wp \gset
RESET ROLE;

SELECT left(order_id::text,8) AS orden, payment_status AS estado
FROM v_order_payment_state WHERE order_id='00000000-0000-0000-0000-00000000df09';
