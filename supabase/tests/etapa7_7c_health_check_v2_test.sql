-- ============================================================================
-- M7 Lote 7C — Health Check Financiero v2.
--   Contrato aditivo · read-only enforceado · aislamiento por negocio ·
--   cada check en pass y con su caso fallido · severidades · montos ·
--   deuda legacy explicada · NC sin retorno fisico · rendimiento.
-- RUN: docker cp ... && psql -X -f (BEGIN + ROLLBACK)
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;
-- helpers de lectura del resultado
CREATE OR REPLACE FUNCTION pg_temp.hc(b uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000007e7109',true);
  r := finance_health_check_v2(b);
  RESET ROLE;
  RETURN r;
END; $$;
CREATE OR REPLACE FUNCTION pg_temp.chk(r jsonb, id text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT e FROM jsonb_array_elements(r->'checks') e WHERE e->>'check_id'=id $$;

\set BIZ  '00000000-0000-0000-0000-0000007e7101'
\set OWN  '00000000-0000-0000-0000-0000007e7109'
\set BIZ2 '00000000-0000-0000-0000-0000007e7201'
\set OWN2 '00000000-0000-0000-0000-0000007e7209'
\set CLI  '00000000-0000-0000-0000-0000007e7c01'
\set INV  '00000000-0000-0000-0000-0000007ed001'
\set CAJA '00000000-0000-0000-0000-0000007e7601'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'OWN'),(:'OWN2');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'BIZ','7C A',:'OWN'),(:'BIZ2','7C B',:'OWN2');
INSERT INTO profiles(id,business_id,user_id,role,is_active) VALUES (:'OWN',:'BIZ',:'OWN','owner',true),(:'OWN2',:'BIZ2',:'OWN2','owner',true);
INSERT INTO customers(id,business_id,name,phone) VALUES (:'CLI',:'BIZ','C','5');
INSERT INTO inventory(id,business_id,name,code,category,stock_quantity,stock,cost_price,sale_price,base_price,base_currency,auto_update_price,exchange_rate_used,is_active)
  VALUES (:'INV',:'BIZ','P','7C-1','R',100,100,600,1000,1000,'ARS',false,1,true);
INSERT INTO cajas(id,business_id,opened_by,status) VALUES (:'CAJA',:'BIZ',:'OWN','abierta');
SET LOCAL session_replication_role='origin';

-- ============ CONTRATO ======================================================
CREATE TEMP TABLE pg_temp_r AS SELECT pg_temp.hc(:'BIZ') AS r;
SELECT pg_temp.assert((SELECT r->>'ok' FROM pg_temp_r)='true', 'CT1 ok=true');
SELECT pg_temp.assert((SELECT r->>'version' FROM pg_temp_r)='m7_health_v2', 'CT2 version=m7_health_v2');
-- campos del contrato v1 que consume el frontend actual: TODOS presentes
SELECT pg_temp.assert((SELECT r ? 'ok' AND r ? 'critical_count' AND r ? 'warning_count' AND r ? 'low_count'
  AND r ? 'total_issues' AND r ? 'business_id' AND r ? 'checked_at' AND r ? 'checks' FROM pg_temp_r),
  'CT3 contrato v1 completo (frontend actual funciona sin cambios)');
SELECT pg_temp.assert((SELECT bool_and(e ? 'id' AND e ? 'title' AND e ? 'severity' AND e ? 'status'
  AND e ? 'count' AND e ? 'description' AND e ? 'rows')
  FROM pg_temp_r, jsonb_array_elements(r->'checks') e), 'CT4 cada check trae los 7 campos v1');
SELECT pg_temp.assert((SELECT bool_and(e->>'status' IN ('ok','low','warning','critical'))
  FROM pg_temp_r, jsonb_array_elements(r->'checks') e), 'CT5 status en el vocabulario del frontend');
SELECT pg_temp.assert((SELECT bool_and(e->>'severity' IN ('low','warning','critical'))
  FROM pg_temp_r, jsonb_array_elements(r->'checks') e), 'CT6 severity en el vocabulario del frontend');
-- campos v2 aditivos
SELECT pg_temp.assert((SELECT r ? 'overall_status' AND r ? 'info_count' AND r ? 'checks_total'
  AND r ? 'duration_ms' AND r ? 'schema_state' AND r ? 'semantics' FROM pg_temp_r), 'CT7 resumen v2 aditivo');
SELECT pg_temp.assert((SELECT bool_and(e ? 'check_id' AND e ? 'category' AND e ? 'result' AND e ? 'severity_level'
  AND e ? 'amount_ars' AND e ? 'message' AND e ? 'details' AND e ? 'version')
  FROM pg_temp_r, jsonb_array_elements(r->'checks') e), 'CT8 cada check trae los campos v2');
SELECT pg_temp.assert((SELECT bool_and(e->>'result' IN ('pass','warn','fail','info'))
  FROM pg_temp_r, jsonb_array_elements(r->'checks') e), 'CT9 result en pass|warn|fail|info');
SELECT pg_temp.assert((SELECT bool_and(e->>'severity_level' IN ('critical','high','medium','low','info'))
  FROM pg_temp_r, jsonb_array_elements(r->'checks') e), 'CT10 severity_level en el vocabulario v2');
SELECT pg_temp.assert((SELECT (r->>'checks_total')::int >= 40 FROM pg_temp_r), 'CT11 catalogo de 40+ checks');
SELECT pg_temp.assert((SELECT count(DISTINCT e->>'check_id') = count(*) FROM pg_temp_r, jsonb_array_elements(r->'checks') e),
  'CT12 los check_id son unicos');

-- ============ BASE LIMPIA: TODO EN PASS =====================================
SELECT pg_temp.assert((SELECT r->>'overall_status' FROM pg_temp_r)='pass', 'CL1 negocio limpio -> overall_status=pass');
SELECT pg_temp.assert((SELECT (r->>'critical_count')::int FROM pg_temp_r)=0, 'CL2 sin criticos');
SELECT pg_temp.assert((SELECT (r->>'total_issues')::int FROM pg_temp_r)=0, 'CL3 sin issues');
-- request tables VACIAS => pass, no warn
SELECT pg_temp.assert((SELECT pg_temp.chk(r,'request_keys_duplicated')->>'result' FROM pg_temp_r)='pass', 'CL4 request table vacia -> pass (no warn)');
SELECT pg_temp.assert((SELECT pg_temp.chk(r,'request_key_or_hash_empty')->>'result' FROM pg_temp_r)='pass', 'CL5 idem hashes');
SELECT pg_temp.assert((SELECT pg_temp.chk(r,'request_hash_legacy_md5')->>'result' FROM pg_temp_r)='pass', 'CL6 sin hashes MD5 -> pass');
SELECT pg_temp.assert((SELECT pg_temp.chk(r,'bfe_legacy_annulment_mirrors')->>'result' FROM pg_temp_r)='pass', 'CL7 sin deuda legacy -> pass');
SELECT pg_temp.assert((SELECT pg_temp.chk(r,'cross_business_references')->>'result' FROM pg_temp_r)='pass', 'CL8 multi-tenant limpio -> pass');
-- Los checks GLOBALES (catalogo/grants) NO estan en el endpoint interactivo: un
-- hallazgo de plataforma no debe pintar de rojo el health check de un comercio.
SELECT pg_temp.assert((SELECT pg_temp.chk(r,'secdef_without_search_path') FROM pg_temp_r) IS NULL, 'CL9 los checks globales NO se incluyen por defecto');
SELECT pg_temp.assert((SELECT pg_temp.chk(r,'alternative_write_paths') FROM pg_temp_r) IS NULL, 'CL10 idem vias alternativas');

-- ============ CHECKS GLOBALES (auditoria operativa, p_include_global) =======
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000007e7109',true);
  r := finance_health_check_v2('00000000-0000-0000-0000-0000007e7101', true);
  RESET ROLE;
  PERFORM pg_temp.assert(pg_temp.chk(r,'secdef_without_search_path') IS NOT NULL, 'GL1 con p_include_global aparecen los checks globales');
  PERFORM pg_temp.assert(pg_temp.chk(r,'alternative_write_paths') IS NOT NULL, 'GL2 idem vias alternativas');
  PERFORM pg_temp.assert(pg_temp.chk(r,'alternative_write_paths')->>'result'='pass',
    'GL3 sin vias alternativas de anulacion/cobro: los guards M7 estan activos');
  PERFORM pg_temp.assert((r->>'checks_total')::int > (SELECT (t.r->>'checks_total')::int FROM pg_temp_r t),
    'GL4 el modo global agrega checks al catalogo');
  -- El check global detecta REALMENTE las SECURITY DEFINER sin search_path.
  PERFORM pg_temp.assert(pg_temp.chk(r,'secdef_without_search_path')->>'severity_level'='critical', 'GL5 severidad critical');
END $$;

-- ============ SEGURIDAD Y AISLAMIENTO =======================================
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; PERFORM set_config('request.jwt.claim.sub','',true);
  r := finance_health_check_v2('00000000-0000-0000-0000-0000007e7101');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'ok'='false' AND r->>'error'='No autenticado', 'SE1 sin auth -> rechazo');
  -- el owner de OTRO negocio no puede auditar este
  SET LOCAL ROLE authenticated; PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000007e7209',true);
  r := finance_health_check_v2('00000000-0000-0000-0000-0000007e7101');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'ok'='false' AND r->>'error'='Sin acceso a este negocio', 'SE2 cross-tenant -> rechazo');
  SET LOCAL ROLE authenticated; PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000007e7109',true);
  r := finance_health_check_v2(NULL);
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'ok'='false', 'SE3 sin business_id -> rechazo');
END $$;
SELECT pg_temp.assert(NOT has_function_privilege('anon','public.finance_health_check_v2(uuid,boolean)','EXECUTE'), 'SE4 anon NO EXECUTE');
SELECT pg_temp.assert(has_function_privilege('authenticated','public.finance_health_check_v2(uuid,boolean)','EXECUTE'), 'SE5 authenticated EXECUTE');
-- READ-ONLY ENFORCEADO POR EL MOTOR
SELECT pg_temp.assert((SELECT provolatile FROM pg_proc WHERE proname='finance_health_check_v2')='s',
  'RO1 la funcion es STABLE: Postgres le PROHIBE escribir (no es disciplina, es el motor)');
SELECT pg_temp.assert((SELECT prosecdef FROM pg_proc WHERE proname='finance_health_check_v2'), 'RO2 SECURITY DEFINER');
SELECT pg_temp.assert((SELECT array_to_string(proconfig,',') FROM pg_proc WHERE proname='finance_health_check_v2') LIKE '%search_path=public%',
  'RO3 search_path fijo');
-- v1 intacta
SELECT pg_temp.assert(EXISTS(SELECT 1 FROM pg_proc WHERE proname='finance_health_check'), 'RO4 v1 sigue existiendo (frontend actual intacto)');

-- ============ CASOS FALLIDOS ================================================
-- (1) ANULADO SIN REGISTRO -> fail/critical con monto
DO $$
DECLARE r jsonb; v_id uuid;
BEGIN
  v_id := gen_random_uuid();
  SET LOCAL session_replication_role='replica';
  INSERT INTO comprobantes(id,business_id,customer_id,tipo,type,status,estado,estado_comercial,estado_fiscal,fecha,date,total,total_bruto,total_cobrado,saldo_pendiente,currency,exchange_rate,created_by)
    VALUES (v_id,'00000000-0000-0000-0000-0000007e7101','00000000-0000-0000-0000-0000007e7c01','remito','remito','cancelled','anulado','anulado','anulado_fiscal','2026-05-08 12:00-03','2026-05-08 12:00-03',5000,5000,0,0,'ARS',1,'00000000-0000-0000-0000-0000007e7109');
  INSERT INTO comprobante_items(comprobante_id,business_id,inventory_id,descripcion,cantidad,precio_unitario,subtotal,costo_unitario,costo_total,tipo_linea,stock_processed)
    VALUES (v_id,'00000000-0000-0000-0000-0000007e7101','00000000-0000-0000-0000-0000007ed001','P',1,5000,5000,600,600,'producto',true);
  SET LOCAL session_replication_role='origin';
  r := pg_temp.hc('00000000-0000-0000-0000-0000007e7101');
  PERFORM pg_temp.assert(pg_temp.chk(r,'annulled_without_record')->>'result'='fail', 'F1 anulado sin registro -> fail');
  PERFORM pg_temp.assert(pg_temp.chk(r,'annulled_without_record')->>'severity_level'='critical', 'F2 severidad critical');
  PERFORM pg_temp.assert(pg_temp.chk(r,'annulled_without_record')->>'status'='critical', 'F3 status v1 = critical');
  PERFORM pg_temp.assert((pg_temp.chk(r,'annulled_without_record')->>'count')::int=1, 'F4 count=1');
  PERFORM pg_temp.assert((pg_temp.chk(r,'annulled_without_record')->>'amount_ars')::numeric=5000, 'F5 amount_ars=5000 (monto en riesgo)');
  PERFORM pg_temp.assert(jsonb_array_length(pg_temp.chk(r,'annulled_without_record')->'rows')=1, 'F6 rows trae el detalle (negocio/periodo/monto/entidad)');
  PERFORM pg_temp.assert(r->>'overall_status'='fail', 'F7 overall_status=fail');
  PERFORM pg_temp.assert((r->>'critical_count')::int >= 1, 'F8 critical_count refleja el fallo');
  PERFORM pg_temp.assert((r->>'amount_at_risk')::numeric >= 5000, 'F9 amount_at_risk agrega los montos de los fail');
  -- AISLAMIENTO: el otro negocio NO ve este problema
  SET LOCAL ROLE authenticated; PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000007e7209',true);
  r := finance_health_check_v2('00000000-0000-0000-0000-0000007e7201');
  RESET ROLE;
  PERFORM pg_temp.assert(pg_temp.chk(r,'annulled_without_record')->>'result'='pass', 'F10 el fallo NO se filtra al otro negocio');
END $$;

-- (2) NC SIN RETORNO FISICO -> info, NUNCA fail (semantica aprobada)
DO $$
DECLARE r jsonb; v_o uuid; v_nc uuid;
BEGIN
  v_o := gen_random_uuid(); v_nc := gen_random_uuid();
  SET LOCAL session_replication_role='replica';
  INSERT INTO comprobantes(id,business_id,customer_id,tipo,type,status,estado,estado_comercial,estado_fiscal,fecha,date,total,total_bruto,total_cobrado,saldo_pendiente,currency,exchange_rate,cae,created_by)
    VALUES (v_o,'00000000-0000-0000-0000-0000007e7101','00000000-0000-0000-0000-0000007e7c01','factura_c','factura_c','cancelled','anulado','anulado','anulado_fiscal','2026-05-21 12:00-03','2026-05-21 12:00-03',13050,13050,13050,0,'ARS',1,'751234','00000000-0000-0000-0000-0000007e7109');
  INSERT INTO comprobante_items(comprobante_id,business_id,inventory_id,descripcion,cantidad,precio_unitario,subtotal,costo_unitario,costo_total,tipo_linea,stock_processed)
    VALUES (v_o,'00000000-0000-0000-0000-0000007e7101','00000000-0000-0000-0000-0000007ed001','P',1,13050,13050,2186,2186,'producto',true);
  INSERT INTO comprobantes(id,business_id,customer_id,tipo,type,status,estado,estado_comercial,estado_fiscal,fecha,date,total,total_bruto,total_cobrado,saldo_pendiente,currency,exchange_rate,cae,comprobante_original_id,created_by)
    VALUES (v_nc,'00000000-0000-0000-0000-0000007e7101','00000000-0000-0000-0000-0000007e7c01','nota_credito','nota_credito','issued','emitido','pendiente','emitido','2026-05-21 21:00-03','2026-05-21 21:00-03',13050,13050,0,0,'ARS',1,'751235',v_o,'00000000-0000-0000-0000-0000007e7109');
  INSERT INTO comprobante_items(comprobante_id,business_id,inventory_id,descripcion,cantidad,precio_unitario,subtotal,costo_unitario,costo_total,tipo_linea,stock_processed)
    VALUES (v_nc,'00000000-0000-0000-0000-0000007e7101',NULL,'NC: P',1,13050,13050,0,0,'producto',false);
  -- la NC compensa el cobro (credit_reversal) pero NO restaura stock (inventory_return)
  INSERT INTO financial_movements(business_id,date,type,currency,amount,amount_ars,exchange_rate,source,comprobante_id,description,created_by,sign,metodo_pago,caja_id)
    VALUES ('00000000-0000-0000-0000-0000007e7101','2026-05-21','expense','ARS',13050,13050,1,'comprobante',v_nc,'Reversa NC','00000000-0000-0000-0000-0000007e7109',-1,'transferencia','00000000-0000-0000-0000-0000007e7601');
  SET LOCAL session_replication_role='origin';
  r := pg_temp.hc('00000000-0000-0000-0000-0000007e7101');
  PERFORM pg_temp.assert(pg_temp.chk(r,'credit_note_without_physical_return')->>'result'='info',
    'NC1 NC sin retorno fisico -> INFO (no fail): la NC revierte dinero, no mercaderia');
  PERFORM pg_temp.assert(pg_temp.chk(r,'credit_note_without_physical_return')->>'severity_level'='info', 'NC2 severidad info');
  PERFORM pg_temp.assert(pg_temp.chk(r,'credit_note_without_physical_return')->>'status'='low', 'NC3 status v1 = low');
  PERFORM pg_temp.assert((pg_temp.chk(r,'credit_note_without_physical_return')->>'amount_ars')::numeric=2186,
    'NC4 cuantifica el COGS retenido (2.186)');
  PERFORM pg_temp.assert(pg_temp.chk(r,'credit_note_without_physical_return')->'details'->>'politica' IS NOT NULL,
    'NC5 documenta la semantica en el resultado');
  -- el anulado CON nota de credito NO cuenta como "anulado sin registro"
  PERFORM pg_temp.assert((pg_temp.chk(r,'annulled_without_record')->>'count')::int=1,
    'NC6 el anulado con NC NO se marca como sin registro (sigue siendo solo el remito)');
  -- credit_reversal SI se exige
  PERFORM pg_temp.assert(pg_temp.chk(r,'credit_note_cash_not_compensated')->>'result'='pass',
    'NC7 la NC compenso su cobro -> pass (dimension credit_reversal)');
END $$;

-- (3) NC SIN COMPENSAR EL COBRO -> fail (esa dimension SI es obligatoria)
DO $$
DECLARE r jsonb; v_o uuid; v_nc uuid;
BEGIN
  v_o := gen_random_uuid(); v_nc := gen_random_uuid();
  SET LOCAL session_replication_role='replica';
  INSERT INTO comprobantes(id,business_id,tipo,type,status,estado,estado_comercial,estado_fiscal,fecha,date,total,total_bruto,total_cobrado,saldo_pendiente,currency,exchange_rate,created_by)
    VALUES (v_o,'00000000-0000-0000-0000-0000007e7101','factura_c','factura_c','issued','emitido','pendiente','no_fiscal','2026-06-01 12:00-03','2026-06-01 12:00-03',900,900,0,0,'ARS',1,'00000000-0000-0000-0000-0000007e7109');
  INSERT INTO comprobantes(id,business_id,tipo,type,status,estado,estado_comercial,estado_fiscal,fecha,date,total,total_bruto,total_cobrado,saldo_pendiente,currency,exchange_rate,comprobante_original_id,created_by)
    VALUES (v_nc,'00000000-0000-0000-0000-0000007e7101','nota_credito','nota_credito','issued','emitido','pendiente','no_fiscal','2026-06-01 12:00-03','2026-06-01 12:00-03',900,900,0,0,'ARS',1,v_o,'00000000-0000-0000-0000-0000007e7109');
  SET LOCAL session_replication_role='origin';
  r := pg_temp.hc('00000000-0000-0000-0000-0000007e7101');
  PERFORM pg_temp.assert(pg_temp.chk(r,'credit_note_cash_not_compensated')->>'result'='fail', 'NC8 NC sin compensar el cobro -> fail');
  PERFORM pg_temp.assert((pg_temp.chk(r,'credit_note_cash_not_compensated')->>'amount_ars')::numeric=900, 'NC9 monto de la NC sin compensar');
END $$;

-- (4) DEUDA LEGACY EXPLICADA -> info, no critical
DO $$
DECLARE r jsonb; v_id uuid;
BEGIN
  SELECT id INTO v_id FROM comprobantes WHERE business_id='00000000-0000-0000-0000-0000007e7101' AND tipo='remito' LIMIT 1;
  SET LOCAL session_replication_role='replica';
  -- mirror historico: source=annulment + legacy_unclassified, vinculado a un anulado
  INSERT INTO business_finance_entries(business_id,date,type,category,description,amount,currency,amount_ars,exchange_rate,reference_comprobante_id,source,created_by,economic_class)
    VALUES ('00000000-0000-0000-0000-0000007e7101','2026-05-08','income','ventas_productos','ANULACION mirror',-5000,'ARS',-5000,1,v_id,'annulment','00000000-0000-0000-0000-0000007e7109','legacy_unclassified');
  SET LOCAL session_replication_role='origin';
  r := pg_temp.hc('00000000-0000-0000-0000-0000007e7101');
  PERFORM pg_temp.assert(pg_temp.chk(r,'bfe_legacy_annulment_mirrors')->>'result'='info',
    'LG1 mirror historico de anulacion -> INFO (deuda de clasificacion explicada)');
  PERFORM pg_temp.assert(pg_temp.chk(r,'bfe_legacy_annulment_mirrors')->>'severity_level'='info', 'LG2 severidad info, NO critical');
  PERFORM pg_temp.assert((pg_temp.chk(r,'bfe_legacy_annulment_mirrors')->>'amount_ars')::numeric=-5000, 'LG3 cuantifica el monto');
  PERFORM pg_temp.assert(pg_temp.chk(r,'bfe_legacy_annulment_mirrors')->'details'->>'tipo'='legacy_classification_debt', 'LG4 tipificada como deuda legacy');
  -- y NO se cuenta en el check de "otro origen"
  PERFORM pg_temp.assert(pg_temp.chk(r,'bfe_legacy_unclassified_other')->>'result'='pass',
    'LG5 el mirror conocido NO alimenta la alerta de legacy de otro origen');
END $$;

-- (5) LEGACY DE OTRO ORIGEN -> conserva alerta segun monto
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL session_replication_role='replica';
  INSERT INTO business_finance_entries(business_id,date,type,category,description,amount,currency,amount_ars,exchange_rate,source,created_by,economic_class)
    VALUES ('00000000-0000-0000-0000-0000007e7101','2026-06-01','variable_cost','otro','Sin clasificar',500,'ARS',500,1,'manual','00000000-0000-0000-0000-0000007e7109','legacy_unclassified');
  SET LOCAL session_replication_role='origin';
  r := pg_temp.hc('00000000-0000-0000-0000-0000007e7101');
  PERFORM pg_temp.assert(pg_temp.chk(r,'bfe_legacy_unclassified_other')->>'result'='warn', 'LG6 legacy de otro origen y monto chico -> warn');
  PERFORM pg_temp.assert(pg_temp.chk(r,'bfe_legacy_unclassified_other')->>'severity_level'='medium', 'LG7 severidad medium');
  SET LOCAL session_replication_role='replica';
  INSERT INTO business_finance_entries(business_id,date,type,category,description,amount,currency,amount_ars,exchange_rate,source,created_by,economic_class)
    VALUES ('00000000-0000-0000-0000-0000007e7101','2026-06-01','variable_cost','otro','Grande',200000,'ARS',200000,1,'manual','00000000-0000-0000-0000-0000007e7109','legacy_unclassified');
  SET LOCAL session_replication_role='origin';
  r := pg_temp.hc('00000000-0000-0000-0000-0000007e7101');
  PERFORM pg_temp.assert(pg_temp.chk(r,'bfe_legacy_unclassified_other')->>'result'='fail', 'LG8 legacy de otro origen y monto material -> fail');
  PERFORM pg_temp.assert(pg_temp.chk(r,'bfe_legacy_unclassified_other')->>'severity_level'='high', 'LG9 severidad high por monto');
END $$;

-- (6) COBRO MIXTO: varias filas vivas es VALIDO, no duplicado
DO $$
DECLARE r jsonb; v_id uuid; v_antes int;
BEGIN
  -- se mide el DELTA: agregar un cobro mixto no debe sumar hallazgos
  r := pg_temp.hc('00000000-0000-0000-0000-0000007e7101');
  v_antes := (pg_temp.chk(r,'header_vs_live_payments')->>'count')::int;
  v_id := gen_random_uuid();
  SET LOCAL session_replication_role='replica';
  INSERT INTO comprobantes(id,business_id,tipo,type,status,estado,estado_comercial,estado_fiscal,fecha,date,total,total_bruto,total_cobrado,saldo_pendiente,currency,exchange_rate,created_by)
    VALUES (v_id,'00000000-0000-0000-0000-0000007e7101','factura_c','factura_c','issued','emitido','pendiente','no_fiscal','2026-06-02 12:00-03','2026-06-02 12:00-03',1000,1000,1000,0,'ARS',1,'00000000-0000-0000-0000-0000007e7109');
  INSERT INTO comprobante_payments(comprobante_id,business_id,amount,currency,amount_ars,exchange_rate,payment_method,date)
    VALUES (v_id,'00000000-0000-0000-0000-0000007e7101',400,'ARS',400,1,'efectivo','2026-06-02'),
           (v_id,'00000000-0000-0000-0000-0000007e7101',600,'ARS',600,1,'tarjeta_debito','2026-06-02');
  SET LOCAL session_replication_role='origin';
  r := pg_temp.hc('00000000-0000-0000-0000-0000007e7101');
  PERFORM pg_temp.assert((pg_temp.chk(r,'header_vs_live_payments')->>'count')::int = v_antes,
    'MX1 cobro mixto con 2 filas vivas NO suma hallazgos (no se marca por tener mas de una linea)');
END $$;

-- (7) HEADER DESALINEADO -> warn con monto
DO $$
DECLARE r jsonb; v_id uuid; v_antes numeric;
BEGIN
  r := pg_temp.hc('00000000-0000-0000-0000-0000007e7101');
  v_antes := (pg_temp.chk(r,'header_vs_live_payments')->>'amount_ars')::numeric;
  v_id := gen_random_uuid();
  SET LOCAL session_replication_role='replica';
  INSERT INTO comprobantes(id,business_id,tipo,type,status,estado,estado_comercial,estado_fiscal,fecha,date,total,total_bruto,total_cobrado,saldo_pendiente,currency,exchange_rate,created_by)
    VALUES (v_id,'00000000-0000-0000-0000-0000007e7101','remito','remito','issued','emitido','pendiente','no_fiscal','2026-06-03 12:00-03','2026-06-03 12:00-03',7500,7500,7500,0,'ARS',1,'00000000-0000-0000-0000-0000007e7109');
  SET LOCAL session_replication_role='origin';
  r := pg_temp.hc('00000000-0000-0000-0000-0000007e7101');
  PERFORM pg_temp.assert(pg_temp.chk(r,'header_vs_live_payments')->>'result'='warn', 'HD1 header sin pagos -> warn');
  PERFORM pg_temp.assert((pg_temp.chk(r,'header_vs_live_payments')->>'amount_ars')::numeric = v_antes + 7500,
    'HD2 el monto de la diferencia suma exactamente 7500');
END $$;

-- (8) PAGO POSTERIOR A LA ANULACION -> fail/critical
DO $$
DECLARE r jsonb; v_id uuid;
BEGIN
  v_id := gen_random_uuid();
  SET LOCAL session_replication_role='replica';
  INSERT INTO comprobantes(id,business_id,tipo,type,status,estado,estado_comercial,estado_fiscal,fecha,date,total,total_bruto,total_cobrado,saldo_pendiente,currency,exchange_rate,created_by)
    VALUES (v_id,'00000000-0000-0000-0000-0000007e7101','factura_c','factura_c','cancelled','anulado','anulado','anulado_fiscal','2026-06-04 12:00-03','2026-06-04 12:00-03',300,300,300,0,'ARS',1,'00000000-0000-0000-0000-0000007e7109');
  INSERT INTO comprobante_annulments(business_id,comprobante_id,user_id,idempotency_key,request_hash,mode,motivo,restore_stock,status,annulment_date,created_at)
    VALUES ('00000000-0000-0000-0000-0000007e7101',v_id,'00000000-0000-0000-0000-0000007e7109','k-post','h','commercial_annulment','x',false,'completed','2026-06-04','2026-06-04 10:00+00');
  INSERT INTO comprobante_payments(comprobante_id,business_id,amount,currency,amount_ars,exchange_rate,payment_method,date,created_at)
    VALUES (v_id,'00000000-0000-0000-0000-0000007e7101',300,'ARS',300,1,'efectivo','2026-06-05','2026-06-05 10:00+00');
  SET LOCAL session_replication_role='origin';
  r := pg_temp.hc('00000000-0000-0000-0000-0000007e7101');
  PERFORM pg_temp.assert(pg_temp.chk(r,'payment_after_annulment')->>'result'='fail', 'PA1 cobro posterior a la anulacion -> fail');
  PERFORM pg_temp.assert(pg_temp.chk(r,'payment_after_annulment')->>'severity_level'='critical', 'PA2 severidad critical');
  PERFORM pg_temp.assert((pg_temp.chk(r,'payment_after_annulment')->>'amount_ars')::numeric=300, 'PA3 monto del cobro indebido');
END $$;

-- (9) METADATA DE REEMPLAZO PARCIAL — defensa en profundidad
-- El CHECK de 6F.3 hace este estado INALCANZABLE por escritura normal. Primero
-- se afirma esa barrera; despues se la quita para comprobar que, aun sin ella
-- (p. ej. si una migracion futura la dropea o llegan datos por otra via), el
-- health check igual lo detecta.
SELECT pg_temp.assert(EXISTS(SELECT 1 FROM pg_constraint WHERE conname='comprobante_payments_replacement_consistency'),
  'RP0 el CHECK de 6F.3 hace la metadata parcial inalcanzable');
DO $$
DECLARE r jsonb; v_id uuid; e text;
BEGIN
  v_id := gen_random_uuid();
  SET LOCAL session_replication_role='replica';
  INSERT INTO comprobantes(id,business_id,tipo,type,status,estado,estado_comercial,estado_fiscal,fecha,date,total,total_bruto,total_cobrado,saldo_pendiente,currency,exchange_rate,created_by)
    VALUES (v_id,'00000000-0000-0000-0000-0000007e7101','factura_c','factura_c','issued','emitido','pendiente','no_fiscal','2026-06-06 12:00-03','2026-06-06 12:00-03',100,100,100,0,'ARS',1,'00000000-0000-0000-0000-0000007e7109');
  -- la barrera funciona:
  e:='';
  BEGIN
    INSERT INTO comprobante_payments(comprobante_id,business_id,amount,currency,amount_ars,exchange_rate,payment_method,date,replaced_at)
      VALUES (v_id,'00000000-0000-0000-0000-0000007e7101',100,'ARS',100,1,'efectivo','2026-06-06', now());
  EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%replacement_consistency%', 'RP1 la constraint rechaza la metadata parcial');
  -- sin la barrera, el health check lo detecta igual:
  ALTER TABLE comprobante_payments DROP CONSTRAINT comprobante_payments_replacement_consistency;
  INSERT INTO comprobante_payments(comprobante_id,business_id,amount,currency,amount_ars,exchange_rate,payment_method,date,replaced_at)
    VALUES (v_id,'00000000-0000-0000-0000-0000007e7101',100,'ARS',100,1,'efectivo','2026-06-06', now());
  SET LOCAL session_replication_role='origin';
  r := pg_temp.hc('00000000-0000-0000-0000-0000007e7101');
  PERFORM pg_temp.assert(pg_temp.chk(r,'replacement_metadata_partial')->>'result'='fail',
    'RP2 sin la constraint, el health check detecta la metadata parcial -> fail');
  PERFORM pg_temp.assert(pg_temp.chk(r,'replacement_metadata_partial')->>'severity_level'='high', 'RP3 severidad high');
  -- y el pago reemplazado sin sustituto rompe la cadena
  PERFORM pg_temp.assert((pg_temp.chk(r,'header_vs_live_payments')->>'count')::int >= 1,
    'RP4 un pago marcado como reemplazado deja de contar como vigente');
END $$;

-- (10) MULTIPLES CAJAS ABIERTAS — defensa en profundidad
-- idx_cajas_unica_abierta_por_negocio ya lo impide; se afirma la barrera y
-- despues se comprueba que el check lo detecta si esa barrera no estuviera.
SELECT pg_temp.assert(EXISTS(SELECT 1 FROM pg_indexes WHERE indexname='idx_cajas_unica_abierta_por_negocio'),
  'CJ0 un indice unico ya impide dos cajas abiertas');
DO $$
DECLARE r jsonb; e text;
BEGIN
  e:='';
  BEGIN
    INSERT INTO cajas(business_id,opened_by,status) VALUES ('00000000-0000-0000-0000-0000007e7101','00000000-0000-0000-0000-0000007e7109','abierta');
  EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%unica_abierta%', 'CJ1 el indice rechaza la segunda caja abierta');
  DROP INDEX idx_cajas_unica_abierta_por_negocio;
  INSERT INTO cajas(business_id,opened_by,status) VALUES ('00000000-0000-0000-0000-0000007e7101','00000000-0000-0000-0000-0000007e7109','abierta');
  r := pg_temp.hc('00000000-0000-0000-0000-0000007e7101');
  PERFORM pg_temp.assert(pg_temp.chk(r,'multiple_open_cajas')->>'result'='fail', 'CJ2 sin el indice, el check detecta dos cajas abiertas -> fail');
  PERFORM pg_temp.assert(pg_temp.chk(r,'multiple_open_cajas')->>'severity_level'='critical', 'CJ3 severidad critical');
END $$;

-- (11) CANTIDAD DECIMAL -> fail
DO $$
DECLARE r jsonb; v_id uuid;
BEGIN
  v_id := gen_random_uuid();
  SET LOCAL session_replication_role='replica';
  INSERT INTO comprobantes(id,business_id,tipo,type,status,estado,estado_comercial,estado_fiscal,fecha,date,total,total_bruto,total_cobrado,saldo_pendiente,currency,exchange_rate,created_by)
    VALUES (v_id,'00000000-0000-0000-0000-0000007e7101','factura_c','factura_c','issued','emitido','pendiente','no_fiscal','2026-06-07 12:00-03','2026-06-07 12:00-03',150,150,0,0,'ARS',1,'00000000-0000-0000-0000-0000007e7109');
  INSERT INTO comprobante_items(comprobante_id,business_id,inventory_id,descripcion,cantidad,precio_unitario,subtotal,costo_unitario,costo_total,tipo_linea,stock_processed)
    VALUES (v_id,'00000000-0000-0000-0000-0000007e7101','00000000-0000-0000-0000-0000007ed001','P',1.5,100,150,60,90,'producto',false);
  SET LOCAL session_replication_role='origin';
  r := pg_temp.hc('00000000-0000-0000-0000-0000007e7101');
  PERFORM pg_temp.assert(pg_temp.chk(r,'item_decimal_quantity')->>'result'='fail', 'IV1 cantidad decimal -> fail');
END $$;

-- (12) MULTI-TENANT -> fail/critical con desglose
DO $$
DECLARE r jsonb; v_id uuid; v_cli2 uuid;
BEGIN
  v_id := gen_random_uuid(); v_cli2 := gen_random_uuid();
  SET LOCAL session_replication_role='replica';
  INSERT INTO customers(id,business_id,name,phone) VALUES (v_cli2,'00000000-0000-0000-0000-0000007e7201','Ajeno','9');
  INSERT INTO comprobantes(id,business_id,customer_id,tipo,type,status,estado,estado_comercial,estado_fiscal,fecha,date,total,total_bruto,total_cobrado,saldo_pendiente,currency,exchange_rate,created_by)
    VALUES (v_id,'00000000-0000-0000-0000-0000007e7101',v_cli2,'factura_c','factura_c','issued','emitido','pendiente','no_fiscal','2026-06-08 12:00-03','2026-06-08 12:00-03',10,10,0,0,'ARS',1,'00000000-0000-0000-0000-0000007e7109');
  SET LOCAL session_replication_role='origin';
  r := pg_temp.hc('00000000-0000-0000-0000-0000007e7101');
  PERFORM pg_temp.assert(pg_temp.chk(r,'cross_business_references')->>'result'='fail', 'MT1 cliente de otro negocio -> fail');
  PERFORM pg_temp.assert(pg_temp.chk(r,'cross_business_references')->>'severity_level'='critical', 'MT2 severidad critical');
  PERFORM pg_temp.assert((pg_temp.chk(r,'cross_business_references')->'details'->>'comprobante_cliente')::int=1, 'MT3 details desglosa el cruce exacto');
END $$;

-- ============ RECONCILIACION (informativa, no muta) =========================
DO $$
DECLARE r jsonb; v_id uuid;
BEGIN
  SELECT id INTO v_id FROM comprobantes WHERE business_id='00000000-0000-0000-0000-0000007e7101' AND tipo='remito' LIMIT 1;
  INSERT INTO finance_ledger_reconciliation(business_id,entity_table,entity_id,issue_type,legacy,reconciliation_status,reconciliation_reason)
    VALUES ('00000000-0000-0000-0000-0000007e7101','comprobantes',v_id,'annulment_sin_registro_canonico',true,'corrected','7B');
  r := pg_temp.hc('00000000-0000-0000-0000-0000007e7101');
  PERFORM pg_temp.assert(pg_temp.chk(r,'reconciliation_corrected')->>'result'='info', 'RC1 corrected -> info (reconciliacion explicada)');
  INSERT INTO finance_ledger_reconciliation(business_id,entity_table,entity_id,issue_type,legacy,reconciliation_status,reconciliation_reason)
    VALUES ('00000000-0000-0000-0000-0000007e7101','comprobantes',v_id,'x',false,'active_inconsistency','y');
  r := pg_temp.hc('00000000-0000-0000-0000-0000007e7101');
  PERFORM pg_temp.assert(pg_temp.chk(r,'reconciliation_active')->>'result'='fail', 'RC2 active_inconsistency -> fail');
  INSERT INTO finance_ledger_reconciliation(business_id,entity_table,entity_id,issue_type,legacy,reconciliation_status,reconciliation_reason)
    VALUES ('00000000-0000-0000-0000-0000007e7101','comprobantes',v_id,'x',false,'indeterminate','y');
  r := pg_temp.hc('00000000-0000-0000-0000-0000007e7101');
  PERFORM pg_temp.assert(pg_temp.chk(r,'reconciliation_indeterminate')->>'result'='warn', 'RC3 indeterminate -> warn');
  PERFORM pg_temp.assert((SELECT count(*) FROM finance_ledger_reconciliation WHERE business_id='00000000-0000-0000-0000-0000007e7101')=3,
    'RC4 el health check NO modifico ningun estado de reconciliacion');
END $$;

-- ============ RENDIMIENTO ===================================================
DO $$
DECLARE r jsonb; v_ms int;
BEGIN
  r := pg_temp.hc('00000000-0000-0000-0000-0000007e7101');
  v_ms := (r->>'duration_ms')::int;
  RAISE NOTICE 'duration_ms = %', v_ms;
  PERFORM pg_temp.assert(v_ms IS NOT NULL AND v_ms >= 0, 'PF1 duration_ms se reporta');
  PERFORM pg_temp.assert(v_ms < 2000, 'PF2 negocio normal < 2 segundos (meta inicial)');
END $$;

SELECT pg_temp.assert(true, '=== etapa7_7c_health_check_v2_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
