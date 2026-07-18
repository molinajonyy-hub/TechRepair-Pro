-- ============================================================================
-- M7 Bloque 6E.2a -- Idempotencia canonica SERVER-SIDE del checkout + normalizacion
-- de metodos de pago + referencias financieras compactas en la auditoria.
--   El servidor (compute_checkout_intent_hash) es la AUTORIDAD de idempotencia;
--   p_request_hash del cliente queda para compat/diagnostico. Contrato status intacto.
-- RUN: docker cp ... && psql -X -f (BEGIN + ROLLBACK)
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;
-- payload de un producto + un pago (metodo/cliente/obs parametrizables)
CREATE OR REPLACE FUNCTION pg_temp.plm(qty numeric, precio numeric, cash numeric, method text, cust text DEFAULT NULL, obs text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('tipo','factura_c','punto_venta','0001','condicion_fiscal','Consumidor Final',
    'customer_id', cust, 'observaciones', obs, 'cc_total', 0,
    'items', jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-000000377d01','descripcion','P','tipo_linea','producto','cantidad',qty,'precio_unitario',precio)),
    'pagos', CASE WHEN cash>0 THEN jsonb_build_array(jsonb_build_object('amount',cash,'amount_ars',cash,'payment_method',method)) ELSE '[]'::jsonb END) $$;

\set biz  '00000000-0000-0000-0000-000000377101'
\set OA   '00000000-0000-0000-0000-000000377109'
\set CUST '00000000-0000-0000-0000-000000377c01'
\set INV  '00000000-0000-0000-0000-000000377d01'
\set CAJA '00000000-0000-0000-0000-000000377601'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'OA');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','6E2a',:'OA');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES (:'biz',:'OA','owner',true);
INSERT INTO customers(id,business_id,name,phone,customer_type) VALUES (:'CUST',:'biz','Cli','+1','minorista');
INSERT INTO inventory(id,business_id,name,code,category,stock_quantity,stock,cost_price,sale_price,base_price,base_currency,auto_update_price,exchange_rate_used,is_active)
  VALUES (:'INV',:'biz','P','H-1','Rep',1000,1000,600,1000,1000,'ARS',false,1,true);
INSERT INTO cajas(id,business_id,opened_by,status) VALUES (:'CAJA',:'biz',:'OA','abierta');
SET LOCAL session_replication_role='origin';

-- ============ Hash server-side calculado + persistido + inmutable ===========
DO $$
DECLARE r jsonb; v_comp uuid;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000377109';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000377101'::uuid,'HK','CLIENT_HASH_1', pg_temp.plm(1,1000,1000,'efectivo'));
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status'='created', 'HS1 venta -> created ('||COALESCE(r->>'error','')||')');
  v_comp := (r->>'comprobante_id')::uuid;
  -- server hash persistido y = compute_checkout_intent_hash del payload
  PERFORM pg_temp.assert((SELECT server_request_hash FROM comprobante_checkout_requests WHERE business_id='00000000-0000-0000-0000-000000377101' AND idempotency_key='HK') IS NOT NULL, 'HS2 server_request_hash persistido');
  PERFORM pg_temp.assert((SELECT server_request_hash FROM comprobante_checkout_requests WHERE idempotency_key='HK')
    = public.compute_checkout_intent_hash('00000000-0000-0000-0000-000000377101'::uuid, pg_temp.plm(1,1000,1000,'efectivo')), 'HS3 server hash = compute_checkout_intent_hash(payload)');
  PERFORM pg_temp.assert((SELECT client_request_hash FROM comprobante_checkout_requests WHERE idempotency_key='HK')='CLIENT_HASH_1', 'HS4 client_request_hash conservado');
END $$;
-- server hash inmutable
DO $$
DECLARE v_id uuid; e text;
BEGIN
  SELECT id INTO v_id FROM comprobante_checkout_requests WHERE business_id='00000000-0000-0000-0000-000000377101' AND idempotency_key='HK';
  e:=''; BEGIN UPDATE comprobante_checkout_requests SET server_request_hash='x' WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%server_request_hash%inmutable%', 'HS5 server_request_hash inmutable');
END $$;
-- helpers revocados para anon/authenticated
SELECT pg_temp.assert(NOT has_function_privilege('authenticated','public.compute_checkout_intent_hash(uuid,jsonb)','EXECUTE') AND NOT has_function_privilege('anon','public.normalize_checkout_payment_method(text)','EXECUTE'), 'HS6 helpers revocados para anon/authenticated');

-- ============ Cliente malicioso / defectuoso ================================
DO $$
DECLARE r jsonb; v_comp uuid;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000377109';
  -- MAL1: mismo client hash H, mismo key, payload DISTINTO (qty1 -> qty2) -> conflicto
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000377101'::uuid,'MK','H', pg_temp.plm(1,1000,1000,'efectivo'));
  PERFORM pg_temp.assert(r->>'status'='created', 'MAL0 base -> created');
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000377101'::uuid,'MK','H', pg_temp.plm(2,1000,2000,'efectivo'));
  PERFORM pg_temp.assert(r->>'status'='idempotency_conflict', 'MAL1 mismo client hash + payload distinto -> idempotency_conflict');
  -- MAL2: client hash DISTINTO, mismo key, mismo payload -> existing
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000377101'::uuid,'YK','H1', pg_temp.plm(1,1000,1000,'efectivo'));
  v_comp := (r->>'comprobante_id')::uuid;
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000377101'::uuid,'YK','H2_DISTINTO', pg_temp.plm(1,1000,1000,'efectivo'));
  PERFORM pg_temp.assert(r->>'status'='existing' AND (r->>'comprobante_id')::uuid=v_comp, 'MAL2 client hash distinto + mismo payload -> existing');
  RESET ROLE;
END $$;

-- ============ Cambio en cada campo economico -> conflicto ===================
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000377109';
  PERFORM create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000377101'::uuid,'FK','HF', pg_temp.plm(1,1000,1000,'efectivo'));
  -- cantidad
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000377101'::uuid,'FK','HF', pg_temp.plm(2,1000,1000,'efectivo'));
  PERFORM pg_temp.assert(r->>'status'='idempotency_conflict', 'F-qty cantidad distinta -> conflicto');
  -- precio
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000377101'::uuid,'FK','HF', pg_temp.plm(1,1100,1000,'efectivo'));
  PERFORM pg_temp.assert(r->>'status'='idempotency_conflict', 'F-precio precio distinto -> conflicto');
  -- metodo
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000377101'::uuid,'FK','HF', pg_temp.plm(1,1000,1000,'transferencia'));
  PERFORM pg_temp.assert(r->>'status'='idempotency_conflict', 'F-metodo metodo distinto -> conflicto');
  -- cliente
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000377101'::uuid,'FK','HF', pg_temp.plm(1,1000,1000,'efectivo','00000000-0000-0000-0000-000000377c01'));
  PERFORM pg_temp.assert(r->>'status'='idempotency_conflict', 'F-cliente cliente distinto -> conflicto');
  -- observacion persistida
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000377101'::uuid,'FK','HF', pg_temp.plm(1,1000,1000,'efectivo',NULL,'nota'));
  PERFORM pg_temp.assert(r->>'status'='idempotency_conflict', 'F-obs observacion distinta -> conflicto');
  RESET ROLE;
END $$;

-- ============ Normalizacion de metodos ======================================
DO $$
DECLARE r jsonb; v_comp uuid;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000377109';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000377101'::uuid,'ZK','HZ', pg_temp.plm(1,1000,1000,'efectivo'));
  v_comp := (r->>'comprobante_id')::uuid;
  -- 'Efectivo' / 'EFECTIVO' -> mismo server hash -> existing
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000377101'::uuid,'ZK','HZ', pg_temp.plm(1,1000,1000,'Efectivo'));
  PERFORM pg_temp.assert(r->>'status'='existing' AND (r->>'comprobante_id')::uuid=v_comp, 'NM1 "Efectivo" -> existing (normalizado)');
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000377101'::uuid,'ZK','HZ', pg_temp.plm(1,1000,1000,'  EFECTIVO  '));
  PERFORM pg_temp.assert(r->>'status'='existing', 'NM2 "  EFECTIVO  " -> existing (trim+lower)');
  -- metodo canonico distinto -> conflicto
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000377101'::uuid,'ZK','HZ', pg_temp.plm(1,1000,1000,'transferencia'));
  PERFORM pg_temp.assert(r->>'status'='idempotency_conflict', 'NM3 metodo canonico distinto -> conflicto');
  -- metodo invalido -> failed_final VALIDATION_ERROR, sin request ni comprobante
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000377101'::uuid,'BADK','HB', pg_temp.plm(1,1000,1000,'bitcoin'));
  PERFORM pg_temp.assert(r->>'status'='failed_final' AND r->>'error_code'='VALIDATION_ERROR' AND r->>'error'='Método de pago inválido', 'NM4 metodo invalido -> failed_final VALIDATION_ERROR');
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000377101'::uuid,'EMPK','HE', pg_temp.plm(1,1000,1000,'  '));
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR', 'NM5 metodo vacio -> VALIDATION_ERROR');
  RESET ROLE;
END $$;
-- metodo invalido no reservo request ni creo comprobante
SELECT pg_temp.assert((SELECT count(*) FROM comprobante_checkout_requests WHERE business_id=:'biz' AND idempotency_key IN ('BADK','EMPK'))=0, 'NM4b metodo invalido: 0 requests reservadas');
-- persistencia canonica: el pago de ZK quedo 'efectivo' (minuscula)
SELECT pg_temp.assert((SELECT payment_method FROM comprobante_payments WHERE comprobante_id=(SELECT comprobante_id FROM comprobante_checkout_requests WHERE idempotency_key='ZK'))='efectivo', 'NM6 metodo persistido canonico "efectivo"');

-- ============ Pagos con referencias distintas NO se colapsan ================
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000377109';
  -- dos pagos 'otro' con provider distinto -> 2 comprobante_payments; server hash sensible al provider
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000377101'::uuid,'REFK','HR',
    jsonb_build_object('tipo','factura_c','cc_total',0,
      'items',jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-000000377d01','descripcion','P','tipo_linea','producto','cantidad',1,'precio_unitario',1000)),
      'pagos',jsonb_build_array(
        jsonb_build_object('amount',500,'amount_ars',500,'payment_method','otro','payment_provider','TerminalA'),
        jsonb_build_object('amount',500,'amount_ars',500,'payment_method','otro','payment_provider','TerminalB'))));
  PERFORM pg_temp.assert(r->>'status'='created', 'RF1 dos pagos otro con provider distinto -> created ('||COALESCE(r->>'error','')||')');
  PERFORM pg_temp.assert((SELECT count(*) FROM comprobante_payments WHERE comprobante_id=(r->>'comprobante_id')::uuid)=2, 'RF2 2 comprobante_payments (no colapsados)');
  -- mismo key, provider cambiado (A,A en vez de A,B) -> conflicto (referencia distinta)
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000377101'::uuid,'REFK','HR',
    jsonb_build_object('tipo','factura_c','cc_total',0,
      'items',jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-000000377d01','descripcion','P','tipo_linea','producto','cantidad',1,'precio_unitario',1000)),
      'pagos',jsonb_build_array(
        jsonb_build_object('amount',500,'amount_ars',500,'payment_method','otro','payment_provider','TerminalA'),
        jsonb_build_object('amount',500,'amount_ars',500,'payment_method','otro','payment_provider','TerminalA'))));
  PERFORM pg_temp.assert(r->>'status'='idempotency_conflict', 'RF3 provider distinto -> conflicto (no se colapsan referencias)');
  RESET ROLE;
END $$;

-- ============ Auditoria: ambos hashes + referencias financieras =============
DO $$
DECLARE a finance_audit_log%ROWTYPE; v_comp uuid;
BEGIN
  SELECT comprobante_id INTO v_comp FROM comprobante_checkout_requests WHERE business_id='00000000-0000-0000-0000-000000377101' AND idempotency_key='HK';
  SELECT * INTO a FROM finance_audit_log WHERE business_id='00000000-0000-0000-0000-000000377101' AND action='sale_checkout' AND entity_id=v_comp;
  PERFORM pg_temp.assert((a.new_data->>'hash_algorithm')='checkout_intent_v1', 'AU1 hash_algorithm = checkout_intent_v1');
  PERFORM pg_temp.assert((a.new_data->>'server_request_hash') IS NOT NULL AND (a.new_data->>'client_request_hash')='CLIENT_HASH_1', 'AU2 ambos hashes en la auditoria');
  PERFORM pg_temp.assert((a.new_data->>'hashes_match') IS NOT NULL, 'AU3 hashes_match presente');
  PERFORM pg_temp.assert(jsonb_array_length(a.new_data->'payment_methods')=1 AND (a.new_data->'payment_methods'->>0)='efectivo', 'AU4 payment_methods normalizados');
  PERFORM pg_temp.assert(jsonb_array_length(a.new_data->'comprobante_payment_ids')=1 AND jsonb_array_length(a.new_data->'financial_movement_ids')>=1, 'AU5 IDs de pagos + FM en la auditoria');
  PERFORM pg_temp.assert((a.new_data->>'cogs_bfe_id') IS NOT NULL, 'AU6 cogs_bfe_id en la auditoria');
END $$;

-- ============ Compatibilidad LEGACY (server hash NULL) ======================
DO $$
DECLARE r jsonb; v_comp uuid;
BEGIN
  -- comprobante existente para enlazar la request legacy
  SELECT comprobante_id INTO v_comp FROM comprobante_checkout_requests WHERE idempotency_key='HK';
  -- request legacy: server_request_hash NULL, completada, client hash 'LEGHASH'
  INSERT INTO comprobante_checkout_requests(business_id,user_id,op,idempotency_key,client_request_hash,server_request_hash,status,comprobante_id,completed_at)
    VALUES ('00000000-0000-0000-0000-000000377101','00000000-0000-0000-0000-000000377109','sale_checkout','LEGK','LEGHASH',NULL,'completed',v_comp,now());
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000377109';
  -- mismo client hash 'LEGHASH' -> fallback legacy -> existing
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000377101'::uuid,'LEGK','LEGHASH', pg_temp.plm(9,9999,0,'efectivo'));
  PERFORM pg_temp.assert(r->>'status'='existing' AND (r->>'comprobante_id')::uuid=v_comp, 'LEG1 legacy sin server hash + mismo client hash -> existing (fallback)');
  -- client hash distinto -> fallback legacy -> conflicto
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-000000377101'::uuid,'LEGK','OTRO_HASH', pg_temp.plm(9,9999,0,'efectivo'));
  PERFORM pg_temp.assert(r->>'status'='idempotency_conflict', 'LEG2 legacy + client hash distinto -> conflicto (fallback)');
  RESET ROLE;
END $$;

SELECT pg_temp.assert(true, '=== etapa7_6e2a_checkout_intent_hash_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
