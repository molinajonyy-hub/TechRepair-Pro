-- ============================================================================
-- M7 Lote 7C.1 — Hardening de funciones SECURITY DEFINER.
--   Inventario · search_path fijo · pg_temp al final · grants minimos ·
--   prueba de shadowing antes/despues · consumidores legitimos · helpers M7 ·
--   checks globales restringidos.
-- RUN: docker cp ... && psql -X -f (BEGIN + ROLLBACK)
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

-- ============ §1 INVENTARIO: ninguna SECURITY DEFINER sin search_path =======
SELECT pg_temp.assert((SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
  WHERE ns.nspname='public' AND p.prosecdef AND p.prokind='f'
    AND (p.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')))=0,
  'IN1 CERO funciones SECURITY DEFINER sin search_path fijo en public');

-- ============ §4 pg_temp AL FINAL — la correccion real ======================
-- La doc de PostgreSQL: el schema temporal, "si NO esta listado en el path, se
-- busca PRIMERO (incluso antes que pg_catalog)". Omitirlo NO lo excluye.
-- Toda SECURITY DEFINER que toque tablas debe listarlo, y al final.
SELECT pg_temp.assert((SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
  WHERE ns.nspname='public' AND p.prosecdef AND p.prokind='f'
    AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%' AND c LIKE '%pg_temp%')
    AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'
                  AND c ~ 'pg_temp\s*,')) = 0,
  'PT1 ninguna funcion pone pg_temp antes de otro schema');
-- Las 13 endurecidas: 7C.1 les puso `pg_catalog, public, pg_temp`; 7C.1a saco
-- `public` tras calificar todas sus referencias. El estado final es el minimo.
SELECT pg_temp.assert((SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
  WHERE ns.nspname='public' AND p.prosecdef
    AND p.proname IN ('business_has_feature','check_user_limit_before_invite','insert_personal_default_categories',
                      'pay_personal_debt','pay_recurring_expense','personal_savings_goal_operation',
                      'personal_update_balance','personal_update_currency_balance','preview_missing_stock_movements',
                      'process_mp_subscription_payment','repair_missing_stock_movements','sync_business_logo_url',
                      'update_inventory_dollar_prices')
    AND array_to_string(p.proconfig,',') = 'search_path=pg_catalog, pg_temp')=13,
  'PT2 las 13 funciones objetivo tienen search_path = pg_catalog, pg_temp (SIN public)');

-- ============ §3 PRUEBA DE SHADOWING (el exploit ya no funciona) ============
SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES ('00000000-0000-0000-0000-0000009e1009');
INSERT INTO businesses(id,name,owner_user_id,subscription_plan,subscription_status)
  VALUES ('00000000-0000-0000-0000-0000009e1001','VICTIMA','00000000-0000-0000-0000-0000009e1009','basico','active');
INSERT INTO profiles(id,business_id,user_id,role,is_active)
  VALUES ('00000000-0000-0000-0000-0000009e1009','00000000-0000-0000-0000-0000009e1001','00000000-0000-0000-0000-0000009e1009','owner',true);
SET LOCAL session_replication_role='origin';

DO $$
DECLARE v_antes boolean; v_despues boolean;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000009e1009',true);
  v_antes := business_has_feature('mayorista');
  PERFORM pg_temp.assert(v_antes = false, 'SH1 plan basico: mayorista=false (linea base)');
  -- EL ATAQUE: authenticated crea una tabla temporal que shadowea businesses.
  CREATE TEMP TABLE businesses (id uuid, subscription_status text, subscription_plan text);
  INSERT INTO pg_temp.businesses VALUES ('00000000-0000-0000-0000-0000009e1001','active','full');
  v_despues := business_has_feature('mayorista');
  RESET ROLE;
  PERFORM pg_temp.assert(v_despues = false,
    'SH2 con pg_temp.businesses creada por el atacante, la SECURITY DEFINER SIGUE leyendo la tabla real');
  PERFORM pg_temp.assert(v_antes = v_despues, 'SH3 el shadowing NO altera el resultado: paywall intacto');
END $$;
DROP TABLE IF EXISTS pg_temp.businesses;

-- ============ §5 GRANTS MINIMOS ============================================
-- anon NO ejecuta ninguna de las 13
SELECT pg_temp.assert((SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
  WHERE ns.nspname='public'
    AND p.proname IN ('business_has_feature','check_user_limit_before_invite','insert_personal_default_categories',
                      'pay_personal_debt','pay_recurring_expense','personal_savings_goal_operation',
                      'personal_update_balance','personal_update_currency_balance','preview_missing_stock_movements',
                      'process_mp_subscription_payment','repair_missing_stock_movements','sync_business_logo_url',
                      'update_inventory_dollar_prices')
    AND has_function_privilege('anon', p.oid, 'EXECUTE'))=0,
  'GR1 anon PERDIO EXECUTE en las 13 funciones');
-- PUBLIC tampoco
SELECT pg_temp.assert((SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
  WHERE ns.nspname='public'
    AND p.proname IN ('business_has_feature','pay_personal_debt','process_mp_subscription_payment',
                      'repair_missing_stock_movements','personal_update_balance','sync_business_logo_url')
    AND has_function_privilege('public', p.oid, 'EXECUTE'))=0,
  'GR2 PUBLIC perdio EXECUTE en las sensibles');

-- §6 Mercado Pago: caller legitimo = webhook/service_role. Ni anon ni authenticated.
SELECT pg_temp.assert(NOT has_function_privilege('anon','public.process_mp_subscription_payment(text,text,text,numeric,text,jsonb)','EXECUTE'),
  'MP1 anon NO puede procesar pagos de suscripcion');
SELECT pg_temp.assert(NOT has_function_privilege('authenticated','public.process_mp_subscription_payment(text,text,text,numeric,text,jsonb)','EXECUTE'),
  'MP2 authenticated NO puede procesar pagos de suscripcion');
SELECT pg_temp.assert(has_function_privilege('service_role','public.process_mp_subscription_payment(text,text,text,numeric,text,jsonb)','EXECUTE'),
  'MP3 service_role (webhook) SI puede: caller legitimo preservado');

-- §6 Stock repair: es herramienta del comercio -> authenticated se CONSERVA
SELECT pg_temp.assert(has_function_privilege('authenticated','public.repair_missing_stock_movements(uuid,boolean)','EXECUTE'),
  'ST1 repair_missing_stock_movements: consumidor legitimo (StockRepairTool.tsx) preservado');
SELECT pg_temp.assert(has_function_privilege('authenticated','public.preview_missing_stock_movements(uuid)','EXECUTE'),
  'ST2 preview_missing_stock_movements: consumidor preservado');
SELECT pg_temp.assert(NOT has_function_privilege('anon','public.repair_missing_stock_movements(uuid,boolean)','EXECUTE'),
  'ST3 anon NO puede reparar stock');

-- §6 Mi Guita: flujo legitimo preservado
SELECT pg_temp.assert(has_function_privilege('authenticated','public.pay_personal_debt(uuid,uuid,numeric,date,text)','EXECUTE'),
  'MG1 pay_personal_debt: consumidor legitimo (debtService.ts) preservado');
SELECT pg_temp.assert(has_function_privilege('authenticated','public.pay_recurring_expense(uuid,uuid,numeric,date,text)','EXECUTE'),
  'MG2 pay_recurring_expense preservado');
SELECT pg_temp.assert(has_function_privilege('authenticated','public.personal_savings_goal_operation(uuid,uuid,numeric,text,date,text)','EXECUTE'),
  'MG3 personal_savings_goal_operation preservado');
SELECT pg_temp.assert(has_function_privilege('authenticated','public.personal_update_currency_balance(uuid,text,numeric)','EXECUTE'),
  'MG4 personal_update_currency_balance preservado');
-- helper sin consumidor: cerrado
SELECT pg_temp.assert(NOT has_function_privilege('authenticated','public.personal_update_balance(uuid,numeric)','EXECUTE'),
  'MG5 personal_update_balance (sin consumidor en src/) cerrado a authenticated');

-- entitlements + invitaciones preservados
SELECT pg_temp.assert(has_function_privilege('authenticated','public.business_has_feature(text)','EXECUTE'),
  'EN1 business_has_feature: consumidor legitimo (entitlements.ts + RLS) preservado');
SELECT pg_temp.assert(has_function_privilege('authenticated','public.check_user_limit_before_invite(uuid)','EXECUTE'),
  'EN2 check_user_limit_before_invite: consumidor (UsersManagement.tsx) preservado');
SELECT pg_temp.assert(has_function_privilege('authenticated','public.update_inventory_dollar_prices(uuid,numeric)','EXECUTE'),
  'EN3 update_inventory_dollar_prices: consumidor (currencyService.ts) preservado');

-- ============ §7 HELPERS SENSIBLES DE M7 ===================================
SELECT pg_temp.assert((SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
  WHERE ns.nspname='public'
    AND p.proname IN ('finance_begin_audit_scope','finance_log_audit','assert_period_open',
                      'is_comprobante_annulled','comprobante_state_is_annulled',
                      'normalize_checkout_payment_method','normalize_supplier_payment_method',
                      'finance_hc_mk','finance_hc_can_see_global')
    AND p.prosecdef
    AND (p.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')))=0,
  'HM1 todo helper M7 SECURITY DEFINER tiene search_path fijo');
-- Los que setean GUCs sensibles NO son invocables por el cliente
SELECT pg_temp.assert(NOT has_function_privilege('authenticated','public.finance_begin_audit_scope()','EXECUTE'),
  'HM2 finance_begin_audit_scope (setea m7.audit_managed) NO invocable por authenticated');
SELECT pg_temp.assert(NOT has_function_privilege('anon','public.finance_begin_audit_scope()','EXECUTE'),
  'HM3 idem anon');
SELECT pg_temp.assert(NOT has_function_privilege('authenticated','public.finance_log_audit(uuid,text,text,uuid,text,text,text,date,text,uuid,jsonb,jsonb,uuid)','EXECUTE'),
  'HM4 finance_log_audit NO invocable directamente por authenticated');
SELECT pg_temp.assert(NOT has_function_privilege('authenticated','public.assert_period_open(uuid,date)','EXECUTE'),
  'HM4b assert_period_open (helper de periodo) NO invocable por authenticated');
-- La GUC de anulacion NO alcanza por si sola: el guard exige current_user=postgres.
DO $$
DECLARE e text; v_id uuid;
BEGIN
  SET LOCAL session_replication_role='replica';
  v_id := gen_random_uuid();
  INSERT INTO comprobantes(id,business_id,tipo,type,status,estado,estado_comercial,estado_fiscal,fecha,date,total,total_bruto,total_cobrado,saldo_pendiente,currency,exchange_rate)
    VALUES (v_id,'00000000-0000-0000-0000-0000009e1001','factura_c','factura_c','issued','emitido','pendiente','no_fiscal',now(),now(),100,100,0,0,'ARS',1);
  SET LOCAL session_replication_role='origin';
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000009e1009',true);
  PERFORM set_config('m7.annulment_scope','1',true);   -- el cliente SETEA la GUC a mano
  e:='';
  BEGIN UPDATE comprobantes SET estado='anulado' WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  RESET ROLE;
  PERFORM set_config('m7.annulment_scope','',true);
  PERFORM pg_temp.assert(e LIKE '%annul_comprobante_atomic%',
    'HM5 la GUC m7.annulment_scope NO alcanza como autorizacion: el guard exige current_user=postgres');
END $$;
-- is_comprobante_annulled es de solo lectura: invocable no es un riesgo
SELECT pg_temp.assert((SELECT provolatile FROM pg_proc WHERE proname='is_comprobante_annulled')='s',
  'HM6 is_comprobante_annulled es STABLE (solo lectura)');
SELECT pg_temp.assert((SELECT provolatile FROM pg_proc WHERE proname='comprobante_state_is_annulled')='i',
  'HM7 comprobante_state_is_annulled es IMMUTABLE (funcion pura)');

-- ============ §8 CHECKS GLOBALES RESTRINGIDOS ==============================
SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES ('00000000-0000-0000-0000-0000009e1109');
INSERT INTO profiles(id,business_id,user_id,role,is_active)
  VALUES ('00000000-0000-0000-0000-0000009e1109','00000000-0000-0000-0000-0000009e1001','00000000-0000-0000-0000-0000009e1109','cashier',true);
SET LOCAL session_replication_role='origin';
DO $$
DECLARE r jsonb;
BEGIN
  -- El OWNER si ve los checks globales
  SET LOCAL ROLE authenticated; PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000009e1009',true);
  r := finance_health_check_v2('00000000-0000-0000-0000-0000009e1001', true);
  RESET ROLE;
  PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM jsonb_array_elements(r->'checks') e WHERE e->>'check_id'='secdef_without_search_path'),
    'GC1 el OWNER si ve el diagnostico de plataforma');
  -- Un MIEMBRO no-owner NO los ve, y NO se rompe el contrato
  SET LOCAL ROLE authenticated; PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000009e1109',true);
  r := finance_health_check_v2('00000000-0000-0000-0000-0000009e1001', true);
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'ok'='true', 'GC2 el miembro no-owner obtiene ok=true; el contrato se preserva');
  PERFORM pg_temp.assert(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'checks') e WHERE e->>'check_id'='secdef_without_search_path'),
    'GC3 el miembro no-owner NO ve la configuracion de seguridad de la plataforma');
  PERFORM pg_temp.assert(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'checks') e WHERE e->>'check_id'='alternative_write_paths'),
    'GC4 tampoco las vias de escritura');
  PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM jsonb_array_elements(r->'checks') e WHERE e->>'check_id'='global_checks_restricted'),
    'GC5 se le informa que se omitieron, SIN detalles sensibles');
  PERFORM pg_temp.assert((SELECT e->>'result' FROM jsonb_array_elements(r->'checks') e WHERE e->>'check_id'='global_checks_restricted')='info',
    'GC6 la omision es info, no un fallo');
  -- y los 44 checks del negocio siguen ahi para el miembro autorizado
  PERFORM pg_temp.assert((r->>'checks_total')::int >= 40, 'GC7 los checks del negocio se conservan para el miembro');
END $$;

-- ============ CROSS-TENANT Y ACTOR FALSIFICADO =============================
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000009e1109',true);
  -- el gate resuelve por auth.uid(), no por un parametro del cliente
  PERFORM pg_temp.assert(finance_hc_can_see_global('00000000-0000-0000-0000-0000009e1001') = false,
    'XT1 el gate de operador resuelve por auth.uid(), no por un flag del cliente');
  RESET ROLE;
  SET LOCAL ROLE authenticated; PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000009e1009',true);
  PERFORM pg_temp.assert(finance_hc_can_see_global('00000000-0000-0000-0000-0000009e1001') = true, 'XT2 el owner si pasa el gate');
  RESET ROLE;
END $$;

-- ============ 7C.1a: public FUERA del path de las 13 =======================
SELECT pg_temp.assert((SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
  WHERE ns.nspname='public' AND p.prosecdef
    AND p.proname IN ('business_has_feature','check_user_limit_before_invite','insert_personal_default_categories',
                      'pay_personal_debt','pay_recurring_expense','personal_savings_goal_operation',
                      'personal_update_balance','personal_update_currency_balance','preview_missing_stock_movements',
                      'process_mp_subscription_payment','repair_missing_stock_movements','sync_business_logo_url',
                      'update_inventory_dollar_prices')
    AND array_to_string(p.proconfig,',') LIKE '%public%')=0,
  'PB1 NINGUNA de las 13 conserva public en su search_path');
SELECT pg_temp.assert((SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
  WHERE ns.nspname='public' AND p.prosecdef
    AND p.proname IN ('business_has_feature','pay_personal_debt','process_mp_subscription_payment',
                      'repair_missing_stock_movements','update_inventory_dollar_prices')
    AND array_to_string(p.proconfig,',') = 'search_path=pg_catalog, pg_temp')=5,
  'PB2 search_path final = pg_catalog, pg_temp (minimo, sin public)');
SELECT pg_temp.assert((SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
  WHERE ns.nspname='public' AND p.prosecdef AND array_to_string(p.proconfig,',') LIKE '%$user%')=0,
  'PB3 ninguna SECURITY DEFINER usa "$user"');

-- ============ 7C.1a: barrera pg_temp en TODAS las SECURITY DEFINER =========
SELECT pg_temp.assert((SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
  WHERE ns.nspname='public' AND p.prosecdef AND p.prokind IN ('f','p')
    AND p.proconfig IS NOT NULL
    AND EXISTS(SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')
    AND NOT EXISTS(SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%pg_temp%'))=0,
  'PT3 CERO SECURITY DEFINER omiten pg_temp (omitirlo lo pondria PRIMERO)');

-- ============ 7C.1a: el helper M7 ya NO es explotable ======================
-- Hallazgo de este lote: is_comprobante_annulled tenia search_path=public sin
-- pg_temp -> un authenticated podia falsear la condicion canonica de anulado.
DO $$
DECLARE v_id uuid; v_antes boolean; v_despues boolean;
BEGIN
  v_id := gen_random_uuid();
  SET LOCAL session_replication_role='replica';
  INSERT INTO comprobantes(id,business_id,tipo,type,status,estado,estado_comercial,estado_fiscal,fecha,date,total,total_bruto,total_cobrado,saldo_pendiente,currency,exchange_rate)
    VALUES (v_id,'00000000-0000-0000-0000-0000009e1001','factura_c','factura_c','issued','emitido','pendiente','no_fiscal',now(),now(),100,100,0,0,'ARS',1);
  SET LOCAL session_replication_role='origin';
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000009e1009',true);
  v_antes := is_comprobante_annulled(v_id);
  CREATE TEMP TABLE comprobante_annulments (comprobante_id uuid, status text);
  INSERT INTO pg_temp.comprobante_annulments VALUES (v_id,'completed');
  v_despues := is_comprobante_annulled(v_id);
  RESET ROLE;
  PERFORM pg_temp.assert(v_antes=false, 'M7V1 comprobante vigente: is_comprobante_annulled=false');
  PERFORM pg_temp.assert(v_despues=false,
    'M7V2 con pg_temp.comprobante_annulments del atacante, la condicion canonica NO se falsea');
END $$;
DROP TABLE IF EXISTS pg_temp.comprobante_annulments;

-- ============ 7C.1a: el atacante no puede crear schemas ====================
DO $$
DECLARE e text;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000009e1009',true);
  e:=''; BEGIN EXECUTE 'CREATE SCHEMA evil_test'; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  RESET ROLE;
  PERFORM pg_temp.assert(e LIKE '%permission denied%',
    'SC1 authenticated NO puede crear schemas: el vector de anteponer un schema propio esta cerrado');
END $$;
-- ni crear NADA dentro de public
--
-- M7 7E.1 — ESTE ASSERT SE ENDURECIO. Antes esperaba 'already exists': el
-- atacante quedaba frenado por una COLISION DE NOMBRE, que es una defensa
-- incidental, no una decisión. Y sólo cubría el caso de un objeto que YA
-- existe: no decía nada del vector que de verdad importa —plantar un objeto
-- NUEVO (p. ej. un overload más específico) para secuestrar la resolución de
-- nombres dentro de una SECURITY DEFINER con `public` en el search_path—.
--
-- La migración 20260714100000 le sacó CREATE sobre public a los roles de
-- cliente, así que ahora el rechazo es 'permission denied' y cubre los dos
-- casos: los nombres ocupados y los libres.
DO $$
DECLARE e text;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000009e1009',true);
  e:=''; BEGIN EXECUTE 'CREATE TABLE public.businesses (id uuid)'; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  RESET ROLE;
  PERFORM pg_temp.assert(e LIKE '%permission denied%',
    'SC2 authenticated no puede crear en public NI con un nombre ocupado (obtuvo: '||COALESCE(NULLIF(e,''),'SIN ERROR')||')');

  -- El caso que el assert viejo no cubria: un nombre LIBRE.
  SET LOCAL ROLE authenticated;
  e:=''; BEGIN EXECUTE 'CREATE TABLE public.zz_nombre_libre_7e1 (id uuid)'; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  RESET ROLE;
  PERFORM pg_temp.assert(e LIKE '%permission denied%',
    'SC2b tampoco puede crear con un nombre LIBRE (era el vector real de plantado)');
END $$;

-- ============ 7C.1a: el search_path de la SESION no altera el resultado ====
DO $$
DECLARE v boolean;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000009e1009',true);
  PERFORM set_config('search_path','pg_temp, public',true);
  v := public.business_has_feature('mayorista');
  PERFORM pg_temp.assert(v=false, 'SP1 search_path de sesion con pg_temp primero: sin efecto');
  PERFORM set_config('search_path','',true);
  v := public.business_has_feature('mayorista');
  PERFORM pg_temp.assert(v=false, 'SP2 search_path de sesion VACIO: la funcion resuelve igual (todo calificado)');
  PERFORM set_config('search_path','public, extensions',true);
  RESET ROLE;
END $$;

-- ============ 7C.1a §9: el health check detecta el schema no confiable =====
SELECT pg_temp.assert(EXISTS(SELECT 1 FROM pg_proc WHERE proname='finance_health_check_v2'), 'HC1 health check v2 presente');
DO $$
DECLARE r jsonb; c jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000009e1009',true);
  r := finance_health_check_v2('00000000-0000-0000-0000-0000009e1001', true);
  RESET ROLE;
  SELECT e INTO c FROM jsonb_array_elements(r->'checks') e WHERE e->>'check_id'='secdef_untrusted_search_path';
  PERFORM pg_temp.assert(c IS NOT NULL, 'HC2 existe el check de schema no confiable en el path');
  PERFORM pg_temp.assert(c->>'severity_level'='critical', 'HC3 severidad critical');
  PERFORM pg_temp.assert(c->'details'->>'pg_temp' IS NOT NULL, 'HC4 documenta la regla de pg_temp');
  -- M7 7E.1 — ESTE ASSERT SE INVIRTIO, Y ES UNA BUENA NOTICIA.
  --
  -- Antes exigia count > 0: codificaba la DEUDA como expectativa. El check mide
  -- "funciones SECURITY DEFINER con un schema ESCRIBIBLE POR ROLES NO
  -- CONFIABLES en su search_path", y `public` lo era, asi que reportaba 128
  -- funciones en critical.
  --
  -- La migracion 20260714100000 le saco CREATE sobre public a los roles de
  -- cliente. `public` dejo de ser escribible por ellos y el check pasa a 0 sin
  -- haber tocado ni una de esas 128 funciones: lo que estaba mal no era el path
  -- de cada funcion, era el permiso del schema.
  --
  -- Medido en local: antes fail/128, despues pass/0.
  PERFORM pg_temp.assert((c->>'count')::int = 0,
    'HC5 ninguna SECDEF depende ya de un schema escribible por roles no confiables (obtuvo count='||COALESCE(c->>'count','?')||')');
  PERFORM pg_temp.assert(c->>'result'='pass',
    'HC5b el check de seguridad queda en pass');
END $$;

SELECT pg_temp.assert(true, '=== etapa7_7c1_security_definer_hardening_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
