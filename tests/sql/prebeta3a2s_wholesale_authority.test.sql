-- ============================================================================
-- PRE-BETA-3A-2S · Autoridad server-side de Mayorista (matriz real).
--
-- Contrato:
--   plan    Basico no · Pro si · Full si · trial = Pro.
--   actor   owner/admin automaticos (aunque tengan override wholesale=false);
--           el resto solo con la capacidad `wholesale` efectiva.
--   escribe owner/admin/manager/sales con acceso; tech/cashier/viewer leen.
--
--   A. Entitlement (regla de plan y las tres superficies de features).
--   B. Actor: acceso y gestion por rol, override y tenant.
--   C. wholesale_*: lectura y escritura (RPC).
--   D. customers: trigger central (bypass PostgREST, preservacion, downgrade).
--   E. Checkout: matriz completa de precio mayorista / minorista.
--   F. Conversion portal -> customers (RPC, sin bypass, idempotente).
--   G. Higiene SECDEF (EXECUTE, search_path, cross-tenant).
--
-- Corre dentro de BEGIN ... ROLLBACK: no deja rastro.
-- RUN: docker cp ... && psql -X -v ON_ERROR_STOP=1 -f
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;

CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label;
  ELSE RAISE NOTICE 'PASS: %', label; END IF;
END; $$;

CREATE TEMP TABLE p3s_ids(k text PRIMARY KEY, v uuid NOT NULL) ON COMMIT DROP;
CREATE OR REPLACE FUNCTION pg_temp.id(p_k text) RETURNS uuid LANGUAGE sql AS
$$ SELECT v FROM p3s_ids WHERE k = p_k $$;

-- Ejecuta SQL como `authenticated` con la identidad dada. 'OK' o SQLSTATE + mensaje.
CREATE OR REPLACE FUNCTION pg_temp.como(p_uid uuid, p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_state text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_uid::text, ''), true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    EXECUTE p_sql;
    v_state := 'OK';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE || ' ' || SQLERRM;
  END;
  RESET ROLE;
  RETURN v_state;
END; $$;

-- Evalua una expresion escalar como `authenticated`. Texto o 'ERR <sqlstate>'.
CREATE OR REPLACE FUNCTION pg_temp.v(p_uid uuid, p_expr text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_out text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_uid::text, ''), true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    EXECUTE format('SELECT (%s)::text', p_expr) INTO v_out;
  EXCEPTION WHEN OTHERS THEN
    v_out := 'ERR ' || SQLSTATE;
  END;
  RESET ROLE;
  RETURN v_out;
END; $$;

CREATE OR REPLACE FUNCTION pg_temp.como_anon(p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_state text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  EXECUTE 'SET LOCAL ROLE anon';
  BEGIN
    EXECUTE p_sql;
    v_state := 'OK';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE || ' ' || SQLERRM;
  END;
  RESET ROLE;
  RETURN v_state;
END; $$;

-- Venta por el checkout canonico como `authenticated`. Devuelve el jsonb del
-- checkout enriquecido con el item vendido, o {error_state, error}.
CREATE OR REPLACE FUNCTION pg_temp.venta(p_uid uuid, p_biz text, p_key text, p_cust text, p_inv text, p_precio numeric)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; it record;
  -- Los ids se resuelven ANTES de cambiar de rol: la tabla temporal es de postgres.
  v_biz uuid := pg_temp.id(p_biz); v_cust uuid := pg_temp.id(p_cust); v_inv uuid := pg_temp.id(p_inv);
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    r := public.create_comprobante_checkout_atomic(v_biz, p_key, 'h-' || p_key,
      jsonb_build_object('tipo','remito','punto_venta','0001','condicion_fiscal','Consumidor Final',
        'customer_id', v_cust, 'cc_total', 0, 'emitir_en_arca', false,
        'items', jsonb_build_array(jsonb_build_object(
          'inventory_id', v_inv, 'descripcion', 'Item ' || p_key,
          'tipo_linea','producto','cantidad',1,'precio_unitario', p_precio)),
        'pagos', jsonb_build_array(jsonb_build_object(
          'amount', p_precio, 'amount_ars', p_precio, 'payment_method','efectivo'))));
  EXCEPTION WHEN OTHERS THEN
    r := jsonb_build_object('error_state', SQLSTATE, 'error', SQLERRM);
  END;
  RESET ROLE;
  IF r ? 'comprobante_id' THEN
    SELECT ci.precio_unitario, ci.applied_price_source, ci.price_override INTO it
      FROM public.comprobante_items ci WHERE ci.comprobante_id = (r->>'comprobante_id')::uuid LIMIT 1;
    r := r || jsonb_build_object('precio', it.precio_unitario, 'fuente', it.applied_price_source, 'override', it.price_override);
  END IF;
  RETURN r;
END; $$;

-- ── Fixture ────────────────────────────────────────────────────────────────
INSERT INTO p3s_ids VALUES
  ('BIZ_BAS','00000000-0000-0000-0000-0000000a0b01'), ('BIZ_PRO','00000000-0000-0000-0000-0000000a0b02'),
  ('BIZ_FULL','00000000-0000-0000-0000-0000000a0b03'), ('BIZ_TRI','00000000-0000-0000-0000-0000000a0b04'),
  ('BIZ_X','00000000-0000-0000-0000-0000000a0b05'),
  ('OWN_B','00000000-0000-0000-0000-0000000a0c01'), ('OWN_P','00000000-0000-0000-0000-0000000a0c02'),
  ('OWN_F','00000000-0000-0000-0000-0000000a0c03'), ('OWN_T','00000000-0000-0000-0000-0000000a0c04'),
  ('OWN_X','00000000-0000-0000-0000-0000000a0c05'),
  ('ADM_P','00000000-0000-0000-0000-0000000a0d01'), ('ADMX_P','00000000-0000-0000-0000-0000000a0d02'),
  ('MGR_P','00000000-0000-0000-0000-0000000a0d03'), ('MGRW_P','00000000-0000-0000-0000-0000000a0d04'),
  ('SAL_P','00000000-0000-0000-0000-0000000a0d05'), ('SALW_P','00000000-0000-0000-0000-0000000a0d06'),
  ('TEC_P','00000000-0000-0000-0000-0000000a0d07'), ('TECW_P','00000000-0000-0000-0000-0000000a0d08'),
  ('CAS_P','00000000-0000-0000-0000-0000000a0d09'), ('VIE_P','00000000-0000-0000-0000-0000000a0d0a'),
  ('VIEW_P','00000000-0000-0000-0000-0000000a0d0b'), ('SALX_P','00000000-0000-0000-0000-0000000a0d0c'),
  ('SAL_F','00000000-0000-0000-0000-0000000a0d11'), ('INA_P','00000000-0000-0000-0000-0000000a0d12'),
  ('CMAY_P','00000000-0000-0000-0000-0000000a0e01'), ('CMIN_P','00000000-0000-0000-0000-0000000a0e02'),
  ('CMAY_F','00000000-0000-0000-0000-0000000a0e03'), ('CMAY_B','00000000-0000-0000-0000-0000000a0e04'),
  ('CDUP1_P','00000000-0000-0000-0000-0000000a0e05'), ('CDUP2_P','00000000-0000-0000-0000-0000000a0e06'),
  ('CEX_P','00000000-0000-0000-0000-0000000a0e07'),
  ('INV_P','00000000-0000-0000-0000-0000000a0f01'), ('INV_F','00000000-0000-0000-0000-0000000a0f02'),
  ('INV_B','00000000-0000-0000-0000-0000000a0f03'),
  ('CAJA_P','00000000-0000-0000-0000-0000000a1001'), ('CAJA_F','00000000-0000-0000-0000-0000000a1002'),
  ('CAJA_B','00000000-0000-0000-0000-0000000a1003'),
  ('WCU_P','00000000-0000-0000-0000-0000000a1101'), ('WCU_P2','00000000-0000-0000-0000-0000000a1102'),
  ('WCU_P3','00000000-0000-0000-0000-0000000a1103'), ('WCU_X','00000000-0000-0000-0000-0000000a1104'),
  ('WC_P','00000000-0000-0000-0000-0000000a1201'), ('WC_P2','00000000-0000-0000-0000-0000000a1202'),
  ('WC_P3','00000000-0000-0000-0000-0000000a1203'), ('WC_X','00000000-0000-0000-0000-0000000a1204'),
  ('WO_P','00000000-0000-0000-0000-0000000a1301');

SET LOCAL session_replication_role = 'replica';
INSERT INTO auth.users(id) SELECT v FROM p3s_ids
 WHERE k ~ '^(OWN_|ADM|MGR|SAL|TEC|CAS|VIE|INA_|WCU_)';
INSERT INTO public.businesses(id, name, owner_user_id, subscription_plan, subscription_status,
                              wholesale_portal_enabled, wholesale_portal_slug) VALUES
  (pg_temp.id('BIZ_BAS'),  'P3S Basico', pg_temp.id('OWN_B'), 'basico', 'active',   false, NULL),
  (pg_temp.id('BIZ_PRO'),  'P3S Pro',    pg_temp.id('OWN_P'), 'pro',    'active',   true,  'p3s-pro'),
  (pg_temp.id('BIZ_FULL'), 'P3S Full',   pg_temp.id('OWN_F'), 'full',   'active',   false, NULL),
  (pg_temp.id('BIZ_TRI'),  'P3S Trial',  pg_temp.id('OWN_T'), NULL,     'trialing', false, NULL),
  (pg_temp.id('BIZ_X'),    'P3S Otro',   pg_temp.id('OWN_X'), 'pro',    'active',   false, NULL);
INSERT INTO public.profiles(id, user_id, business_id, role, is_active, permissions) VALUES
  (pg_temp.id('OWN_B'),  pg_temp.id('OWN_B'),  pg_temp.id('BIZ_BAS'),  'owner',   true, NULL),
  (pg_temp.id('OWN_P'),  pg_temp.id('OWN_P'),  pg_temp.id('BIZ_PRO'),  'owner',   true, '{"wholesale": false}'::jsonb),
  (pg_temp.id('OWN_F'),  pg_temp.id('OWN_F'),  pg_temp.id('BIZ_FULL'), 'owner',   true, NULL),
  (pg_temp.id('OWN_T'),  pg_temp.id('OWN_T'),  pg_temp.id('BIZ_TRI'),  'owner',   true, NULL),
  (pg_temp.id('OWN_X'),  pg_temp.id('OWN_X'),  pg_temp.id('BIZ_X'),    'owner',   true, NULL),
  (pg_temp.id('ADM_P'),  pg_temp.id('ADM_P'),  pg_temp.id('BIZ_PRO'),  'admin',   true, NULL),
  (pg_temp.id('ADMX_P'), pg_temp.id('ADMX_P'), pg_temp.id('BIZ_PRO'),  'admin',   true, '{"wholesale": false}'::jsonb),
  (pg_temp.id('MGR_P'),  pg_temp.id('MGR_P'),  pg_temp.id('BIZ_PRO'),  'manager', true, NULL),
  (pg_temp.id('MGRW_P'), pg_temp.id('MGRW_P'), pg_temp.id('BIZ_PRO'),  'manager', true, '{"wholesale": true}'::jsonb),
  (pg_temp.id('SAL_P'),  pg_temp.id('SAL_P'),  pg_temp.id('BIZ_PRO'),  'sales',   true, NULL),
  (pg_temp.id('SALW_P'), pg_temp.id('SALW_P'), pg_temp.id('BIZ_PRO'),  'sales',   true, '{"wholesale": true}'::jsonb),
  (pg_temp.id('SALX_P'), pg_temp.id('SALX_P'), pg_temp.id('BIZ_PRO'),  'sales',   true, '{"wholesale": false}'::jsonb),
  (pg_temp.id('TEC_P'),  pg_temp.id('TEC_P'),  pg_temp.id('BIZ_PRO'),  'tech',    true, NULL),
  (pg_temp.id('TECW_P'), pg_temp.id('TECW_P'), pg_temp.id('BIZ_PRO'),  'tech',    true, '{"wholesale": true}'::jsonb),
  (pg_temp.id('CAS_P'),  pg_temp.id('CAS_P'),  pg_temp.id('BIZ_PRO'),  'cashier', true, NULL),
  (pg_temp.id('VIE_P'),  pg_temp.id('VIE_P'),  pg_temp.id('BIZ_PRO'),  'viewer',  true, NULL),
  (pg_temp.id('VIEW_P'), pg_temp.id('VIEW_P'), pg_temp.id('BIZ_PRO'),  'viewer',  true, '{"wholesale": true}'::jsonb),
  (pg_temp.id('INA_P'),  pg_temp.id('INA_P'),  pg_temp.id('BIZ_PRO'),  'admin',   false, NULL),
  (pg_temp.id('SAL_F'),  pg_temp.id('SAL_F'),  pg_temp.id('BIZ_FULL'), 'sales',   true, NULL);
INSERT INTO public.customers(id, business_id, name, phone, email, customer_type, business_name, contact_person) VALUES
  (pg_temp.id('CMAY_P'),  pg_temp.id('BIZ_PRO'),  'Mayorista Pro',  '351', NULL, 'mayorista', 'Hist SRL', 'Ana'),
  (pg_temp.id('CMIN_P'),  pg_temp.id('BIZ_PRO'),  'Minorista Pro',  '352', NULL, 'minorista', NULL, NULL),
  (pg_temp.id('CMAY_F'),  pg_temp.id('BIZ_FULL'), 'Mayorista Full', '353', NULL, 'mayorista', 'Full SRL', 'Bea'),
  (pg_temp.id('CMAY_B'),  pg_temp.id('BIZ_BAS'),  'Mayorista Hist', '354', NULL, 'mayorista', 'Viejo SRL', 'Cai'),
  (pg_temp.id('CDUP1_P'), pg_temp.id('BIZ_PRO'),  'Dup Uno',        '355', 'dup@p3s.test', 'minorista', NULL, NULL),
  (pg_temp.id('CDUP2_P'), pg_temp.id('BIZ_PRO'),  'Dup Dos',        '356', 'DUP@p3s.test ', 'minorista', NULL, NULL),
  (pg_temp.id('CEX_P'),   pg_temp.id('BIZ_PRO'),  'Existente',      '357', 'existe@p3s.test', 'minorista', NULL, NULL);
INSERT INTO public.inventory(id, business_id, name, code, category, stock_quantity, stock, cost_price, sale_price,
                             precio_mayorista, base_price, base_currency, auto_update_price, exchange_rate_used, is_active) VALUES
  (pg_temp.id('INV_P'), pg_temp.id('BIZ_PRO'),  'P3S Prod P', 'P3S-P', 'Rep', 100, 100, 400, 1000, 700, 1000, 'ARS', false, 1, true),
  (pg_temp.id('INV_F'), pg_temp.id('BIZ_FULL'), 'P3S Prod F', 'P3S-F', 'Rep', 100, 100, 400, 1000, 700, 1000, 'ARS', false, 1, true),
  (pg_temp.id('INV_B'), pg_temp.id('BIZ_BAS'),  'P3S Prod B', 'P3S-B', 'Rep', 100, 100, 400, 1000, 700, 1000, 'ARS', false, 1, true);
INSERT INTO public.cajas(id, business_id, opened_by, status) VALUES
  (pg_temp.id('CAJA_P'), pg_temp.id('BIZ_PRO'),  pg_temp.id('OWN_P'), 'abierta'),
  (pg_temp.id('CAJA_F'), pg_temp.id('BIZ_FULL'), pg_temp.id('OWN_F'), 'abierta'),
  (pg_temp.id('CAJA_B'), pg_temp.id('BIZ_BAS'),  pg_temp.id('OWN_B'), 'abierta');
INSERT INTO public.wholesale_customers(id, business_id, auth_user_id, name, business_name, email, whatsapp, approved, suspended) VALUES
  (pg_temp.id('WC_P'),  pg_temp.id('BIZ_PRO'), pg_temp.id('WCU_P'),  'Portal Uno',  'Portal SRL', 'nuevo@p3s.test',  '3511111111', true, false),
  (pg_temp.id('WC_P2'), pg_temp.id('BIZ_PRO'), pg_temp.id('WCU_P2'), 'Portal Dos',  NULL,         'existe@p3s.test', NULL,         true, false),
  (pg_temp.id('WC_P3'), pg_temp.id('BIZ_PRO'), pg_temp.id('WCU_P3'), 'Portal Tres', NULL,         'dup@p3s.test',    NULL,         true, false),
  (pg_temp.id('WC_X'),  pg_temp.id('BIZ_X'),   pg_temp.id('WCU_X'),  'Portal Ajeno', NULL,        'ajeno@p3s.test',  NULL,         true, false);
INSERT INTO public.wholesale_orders(id, business_id, customer_id, order_number, status, total) VALUES
  (pg_temp.id('WO_P'), pg_temp.id('BIZ_PRO'), pg_temp.id('WC_P'), 90001, 'pending_review', 700);
SET LOCAL session_replication_role = 'origin';

-- ============================================================================
-- A · ENTITLEMENT
-- ============================================================================
DO $$
BEGIN
  PERFORM pg_temp.assert(NOT private.plan_feature_enabled('active', 'basico', 'mayorista'), 'A · regla: Basico NO');
  PERFORM pg_temp.assert(private.plan_feature_enabled('active', 'pro', 'mayorista'),       'A · regla: Pro SI');
  PERFORM pg_temp.assert(private.plan_feature_enabled('active', 'full', 'mayorista'),      'A · regla: Full SI');
  PERFORM pg_temp.assert(private.plan_feature_enabled('trialing', NULL, 'mayorista'),      'A · regla: trial SI (hereda Pro)');
  PERFORM pg_temp.assert(NOT private.plan_feature_enabled('suspended', 'full', 'mayorista'), 'A · regla: Full suspendido NO');
  PERFORM pg_temp.assert(NOT private.plan_feature_enabled('active', 'pro', 'audit'),       'A · regla: el resto no cambia (audit sigue Full-only)');

  PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('OWN_B'), 'public.business_has_feature(''mayorista'')') = 'false', 'A · business_has_feature: Basico NO');
  PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('OWN_P'), 'public.business_has_feature(''mayorista'')') = 'true',  'A · business_has_feature: Pro SI');
  PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('OWN_F'), 'public.business_has_feature(''mayorista'')') = 'true',  'A · business_has_feature: Full SI');
  PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('OWN_T'), 'public.business_has_feature(''mayorista'')') = 'true',  'A · business_has_feature: trial SI');

  PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('OWN_B'), format('public.get_business_subscription_features(%L)->>''mayorista''', pg_temp.id('BIZ_BAS'))) = 'false', 'A · RPC features: Basico NO');
  PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('OWN_P'), format('public.get_business_subscription_features(%L)->>''mayorista''', pg_temp.id('BIZ_PRO'))) = 'true',  'A · RPC features: Pro SI');
  PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('OWN_F'), format('public.get_business_subscription_features(%L)->>''mayorista''', pg_temp.id('BIZ_FULL'))) = 'true', 'A · RPC features: Full SI');
  PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('OWN_T'), format('public.get_business_subscription_features(%L)->>''mayorista''', pg_temp.id('BIZ_TRI'))) = 'true',  'A · RPC features: trial SI');
  PERFORM pg_temp.assert((public.get_wholesale_portal_features('p3s-pro')->>'mayorista') = 'true', 'A · portal publico de un Pro encendido: mayorista SI');
END $$;

-- ============================================================================
-- B · ACTOR (acceso / gestion)
-- ============================================================================
DO $$
DECLARE
  c record;
  v_acc text; v_man text;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('OWN_P',  'BIZ_PRO',  true,  true,  'owner automatico (aunque su perfil tenga wholesale=false)'),
    ('ADM_P',  'BIZ_PRO',  true,  true,  'admin automatico'),
    ('ADMX_P', 'BIZ_PRO',  true,  true,  'admin con override wholesale=false sigue automatico'),
    ('MGR_P',  'BIZ_PRO',  false, false, 'manager sin permiso -> no'),
    ('MGRW_P', 'BIZ_PRO',  true,  true,  'manager con wholesale -> gestiona'),
    ('SAL_P',  'BIZ_PRO',  false, false, 'sales sin permiso -> no'),
    ('SALW_P', 'BIZ_PRO',  true,  true,  'sales con wholesale -> gestiona'),
    ('SALX_P', 'BIZ_PRO',  false, false, 'sales con wholesale=false -> no'),
    ('TEC_P',  'BIZ_PRO',  false, false, 'tech sin permiso -> no'),
    ('TECW_P', 'BIZ_PRO',  true,  false, 'tech con wholesale -> solo lectura'),
    ('CAS_P',  'BIZ_PRO',  false, false, 'cashier sin permiso -> no'),
    ('VIE_P',  'BIZ_PRO',  false, false, 'viewer sin permiso -> no'),
    ('VIEW_P', 'BIZ_PRO',  true,  false, 'viewer con wholesale -> solo lectura'),
    ('INA_P',  'BIZ_PRO',  false, false, 'admin INACTIVO -> no'),
    ('SAL_F',  'BIZ_FULL', false, false, 'Full: sales sin permiso -> no'),
    ('OWN_F',  'BIZ_FULL', true,  true,  'Full: owner -> si'),
    ('OWN_B',  'BIZ_BAS',  false, false, 'Basico: owner -> no (sin feature)'),
    ('OWN_T',  'BIZ_TRI',  true,  true,  'trial: owner -> si'),
    ('OWN_X',  'BIZ_PRO',  false, false, 'cross-tenant: owner de otro negocio -> no'),
    ('OWN_P',  'BIZ_FULL', false, false, 'cross-tenant: owner de Pro sobre Full -> no')
  ) AS t(actor, biz, acceso, gestion, label) LOOP
    v_acc := pg_temp.v(pg_temp.id(c.actor), format('public.current_user_has_wholesale_access(%L)', pg_temp.id(c.biz)));
    v_man := pg_temp.v(pg_temp.id(c.actor), format('public.current_user_can_manage_wholesale(%L)', pg_temp.id(c.biz)));
    PERFORM pg_temp.assert(v_acc = c.acceso::text AND v_man = c.gestion::text,
      format('B · %s (acceso %s/%s, gestion %s/%s)', c.label, v_acc, c.acceso, v_man, c.gestion));
  END LOOP;

  PERFORM pg_temp.assert(pg_temp.v(NULL, format('public.current_user_has_wholesale_access(%L)', pg_temp.id('BIZ_PRO'))) = 'false',
    'B · sin auth.uid() -> no');
  PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('OWN_P'), 'public.current_user_has_wholesale_access(NULL)') = 'false',
    'B · negocio NULL -> no');
  PERFORM pg_temp.assert(pg_temp.como_anon(format('SELECT public.current_user_has_wholesale_access(%L)', pg_temp.id('BIZ_PRO'))) LIKE '42501%',
    'B · anon no puede ejecutar el helper');
  -- El nucleo compartido: defaults del contrato.
  PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('MGR_P'), 'public.current_user_can(''wholesale'')') = 'false', 'B · current_user_can: manager default false');
  PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('SAL_P'), 'public.current_user_can(''wholesale'')') = 'false', 'B · current_user_can: sales default false');
  PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('ADM_P'), 'public.current_user_can(''wholesale'')') = 'true',  'B · current_user_can: admin default true');
  PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('MGR_P'), 'public.current_user_can(''customers'')') = 'true', 'B · capacidades no relacionadas intactas (manager customers)');
END $$;

-- ============================================================================
-- C · wholesale_* (lectura por acceso, escritura por gestion)
-- ============================================================================
DO $$
DECLARE c record; v_n text; r text;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('OWN_P', true), ('ADMX_P', true), ('MGR_P', false), ('MGRW_P', true), ('SAL_P', false),
    ('SALW_P', true), ('TEC_P', false), ('TECW_P', true), ('VIEW_P', true), ('CAS_P', false), ('OWN_X', false)
  ) AS t(actor, lee) LOOP
    v_n := pg_temp.v(pg_temp.id(c.actor), format('(SELECT count(*) FROM public.wholesale_customers WHERE business_id = %L)', pg_temp.id('BIZ_PRO')));
    PERFORM pg_temp.assert((v_n::int > 0) = c.lee, format('C · %s lee wholesale_customers = %s (%s filas)', c.actor, c.lee, v_n));
    v_n := pg_temp.v(pg_temp.id(c.actor), format('(SELECT count(*) FROM public.wholesale_orders WHERE business_id = %L)', pg_temp.id('BIZ_PRO')));
    PERFORM pg_temp.assert((v_n::int > 0) = c.lee, format('C · %s lee wholesale_orders = %s (%s filas)', c.actor, c.lee, v_n));
  END LOOP;

  FOR c IN SELECT * FROM (VALUES
    ('OWN_P', true), ('ADMX_P', true), ('MGRW_P', true), ('SALW_P', true),
    ('MGR_P', false), ('SAL_P', false), ('TECW_P', false), ('VIEW_P', false), ('CAS_P', false), ('OWN_X', false)
  ) AS t(actor, escribe) LOOP
    r := pg_temp.como(pg_temp.id(c.actor), format(
      'SELECT public.update_wholesale_customer_status_atomic(%L, %L, NULL, NULL, %L)',
      pg_temp.id('BIZ_PRO'), pg_temp.id('WC_P'), 'nota ' || c.actor));
    PERFORM pg_temp.assert((r = 'OK') = c.escribe AND (c.escribe OR r LIKE '42501%'),
      format('C · %s gestiona clientes del portal = %s (%s)', c.actor, c.escribe, r));
    r := pg_temp.como(pg_temp.id(c.actor), format(
      'SELECT public.update_wholesale_order_status_atomic(%L, %L, %L, NULL)',
      pg_temp.id('BIZ_PRO'), pg_temp.id('WO_P'), 'approved'));
    PERFORM pg_temp.assert((r = 'OK') = c.escribe AND (c.escribe OR r LIKE '42501%'),
      format('C · %s cambia estado de pedidos = %s (%s)', c.actor, c.escribe, r));
  END LOOP;

  r := pg_temp.como(pg_temp.id('OWN_B'), format('SELECT public.update_wholesale_order_status_atomic(%L, %L, %L, NULL)',
    pg_temp.id('BIZ_BAS'), pg_temp.id('WO_P'), 'approved'));
  PERFORM pg_temp.assert(r LIKE '42501%mayorista%', 'C · Basico: la RPC rechaza por plan (' || r || ')');
  r := pg_temp.como(pg_temp.id('MGRW_P'), format('UPDATE public.wholesale_customers SET approved = false WHERE id = %L', pg_temp.id('WC_P')));
  PERFORM pg_temp.assert(r LIKE '42501%', 'C · escritura directa de wholesale_customers sigue cerrada (' || r || ')');
END $$;

-- ============================================================================
-- D · customers (trigger central)
-- ============================================================================
DO $$
DECLARE r text; c record;
BEGIN
  -- Sin autoridad: alta mayorista, conversiones y datos mayoristas -> 42501.
  FOR c IN SELECT * FROM (VALUES ('MGR_P'), ('SAL_P'), ('SALX_P'), ('CAS_P'), ('TEC_P')) AS t(actor) LOOP
    r := pg_temp.como(pg_temp.id(c.actor), format(
      'INSERT INTO public.customers(business_id, name, phone, customer_type, business_name) VALUES (%L, %L, %L, %L, %L)',
      pg_temp.id('BIZ_PRO'), 'Bypass ' || c.actor, '399', 'mayorista', 'Bypass SRL'));
    PERFORM pg_temp.assert(r LIKE '42501%WHOLESALE_AUTHORITY_REQUIRED%', format('D · %s: INSERT mayorista directo bloqueado (%s)', c.actor, r));
    r := pg_temp.como(pg_temp.id(c.actor), format(
      'INSERT INTO public.customers(business_id, name, phone, customer_type) VALUES (%L, %L, %L, %L)',
      pg_temp.id('BIZ_PRO'), 'Minorista ' || c.actor, '398', 'minorista'));
    PERFORM pg_temp.assert(r = 'OK', format('D · %s: INSERT minorista normal (%s)', c.actor, r));
  END LOOP;

  r := pg_temp.como(pg_temp.id('MGR_P'), format('UPDATE public.customers SET customer_type = %L WHERE id = %L', 'mayorista', pg_temp.id('CMIN_P')));
  PERFORM pg_temp.assert(r LIKE '42501%', 'D · manager sin wholesale: minorista -> mayorista bloqueado (' || r || ')');
  r := pg_temp.como(pg_temp.id('SAL_P'), format('UPDATE public.customers SET customer_type = %L WHERE id = %L', 'minorista', pg_temp.id('CMAY_P')));
  PERFORM pg_temp.assert(r LIKE '42501%', 'D · sales sin wholesale: mayorista -> minorista bloqueado (' || r || ')');
  r := pg_temp.como(pg_temp.id('SAL_P'), format('UPDATE public.customers SET business_name = %L WHERE id = %L', 'Otra SRL', pg_temp.id('CMAY_P')));
  PERFORM pg_temp.assert(r LIKE '42501%', 'D · sales sin wholesale: business_name de un mayorista bloqueado');
  r := pg_temp.como(pg_temp.id('SAL_P'), format('UPDATE public.customers SET contact_person = NULL WHERE id = %L', pg_temp.id('CMAY_P')));
  PERFORM pg_temp.assert(r LIKE '42501%', 'D · sales sin wholesale: contact_person de un mayorista bloqueado');
  r := pg_temp.como(pg_temp.id('SAL_P'), format('UPDATE public.customers SET phone = %L, name = %L, business_name = %L, contact_person = %L WHERE id = %L',
    '3517777777', 'Mayorista Pro Editado', 'Hist SRL', 'Ana', pg_temp.id('CMAY_P')));
  PERFORM pg_temp.assert(r = 'OK', 'D · sales sin wholesale: edita campos comunes de un mayorista historico (' || r || ')');
  PERFORM pg_temp.assert((SELECT customer_type = 'mayorista' AND business_name = 'Hist SRL' AND contact_person = 'Ana' AND phone = '3517777777'
                            FROM public.customers WHERE id = pg_temp.id('CMAY_P')),
    'D · el mayorista historico queda preservado (tipo, razon social, contacto)');
  r := pg_temp.como(pg_temp.id('SAL_P'), format('UPDATE public.customers SET business_name = %L WHERE id = %L', 'Libre', pg_temp.id('CMIN_P')));
  PERFORM pg_temp.assert(r = 'OK', 'D · sin wholesale: los datos de un MINORISTA son campos comunes (' || r || ')');

  -- Con autoridad: transiciones normales.
  r := pg_temp.como(pg_temp.id('ADMX_P'), format(
    'INSERT INTO public.customers(business_id, name, phone, customer_type, business_name) VALUES (%L, %L, %L, %L, %L)',
    pg_temp.id('BIZ_PRO'), 'Alta admin', '397', 'mayorista', 'Admin SRL'));
  PERFORM pg_temp.assert(r = 'OK', 'D · admin con override false crea mayorista (' || r || ')');
  r := pg_temp.como(pg_temp.id('MGRW_P'), format('UPDATE public.customers SET customer_type = %L, business_name = %L WHERE id = %L', 'mayorista', 'Nueva SRL', pg_temp.id('CMIN_P')));
  PERFORM pg_temp.assert(r = 'OK', 'D · manager con wholesale: minorista -> mayorista (' || r || ')');
  r := pg_temp.como(pg_temp.id('TECW_P'), format('UPDATE public.customers SET customer_type = %L, business_name = NULL, contact_person = NULL WHERE id = %L', 'minorista', pg_temp.id('CMIN_P')));
  PERFORM pg_temp.assert(r = 'OK', 'D · tech con wholesale (lectura en Mayorista) clasifica clientes (' || r || ')');

  -- Downgrade: Basico con un mayorista historico.
  r := pg_temp.como(pg_temp.id('OWN_B'), format('UPDATE public.customers SET phone = %L WHERE id = %L', '3510000000', pg_temp.id('CMAY_B')));
  PERFORM pg_temp.assert(r = 'OK', 'D · downgrade: el owner edita campos comunes del mayorista historico');
  r := pg_temp.como(pg_temp.id('OWN_B'), format('UPDATE public.customers SET business_name = %L WHERE id = %L', 'Nuevo SRL', pg_temp.id('CMAY_B')));
  PERFORM pg_temp.assert(r LIKE '42501%', 'D · downgrade: no cambia la razon social');
  r := pg_temp.como(pg_temp.id('OWN_B'), format('UPDATE public.customers SET customer_type = %L WHERE id = %L', 'minorista', pg_temp.id('CMAY_B')));
  PERFORM pg_temp.assert(r LIKE '42501%', 'D · downgrade: no lo convierte a minorista');
  r := pg_temp.como(pg_temp.id('OWN_B'), format('INSERT INTO public.customers(business_id, name, phone, customer_type) VALUES (%L, %L, %L, %L)',
    pg_temp.id('BIZ_BAS'), 'Nuevo may', '396', 'mayorista'));
  PERFORM pg_temp.assert(r LIKE '42501%', 'D · downgrade: no crea mayoristas nuevos');
  PERFORM pg_temp.assert((SELECT customer_type = 'mayorista' AND business_name = 'Viejo SRL' FROM public.customers WHERE id = pg_temp.id('CMAY_B')),
    'D · downgrade: la clasificacion historica se preserva');

  -- Backend confiable sin identidad (SQL editor / migraciones): no hay actor.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  INSERT INTO public.customers(business_id, name, phone, customer_type) VALUES (pg_temp.id('BIZ_BAS'), 'Backend', '395', 'mayorista');
  PERFORM pg_temp.assert(true, 'D · postgres sin auth.uid() puede operar (backend confiable)');
END $$;

-- ============================================================================
-- E · CHECKOUT (precio mayorista = cliente mayorista Y autoridad del actor)
-- ============================================================================
DO $$
DECLARE r jsonb; c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('OWN_P',  'BIZ_PRO',  'CMAY_P', 'INV_P', 700::numeric,  700::numeric,  'resolved_mayorista', 'owner Pro + mayorista -> mayorista'),
    ('ADMX_P', 'BIZ_PRO',  'CMAY_P', 'INV_P', 700,           700,           'resolved_mayorista', 'admin Pro con override false + mayorista -> mayorista'),
    ('MGR_P',  'BIZ_PRO',  'CMAY_P', 'INV_P', 1000,          1000,          NULL,                 'manager Pro sin wholesale + mayorista -> retail'),
    ('MGRW_P', 'BIZ_PRO',  'CMAY_P', 'INV_P', 700,           700,           'resolved_mayorista', 'manager Pro con wholesale + mayorista -> mayorista'),
    ('SAL_F',  'BIZ_FULL', 'CMAY_F', 'INV_F', 1000,          1000,          NULL,                 'actor Full sin wholesale + mayorista -> retail'),
    ('OWN_B',  'BIZ_BAS',  'CMAY_B', 'INV_B', 1000,          1000,          NULL,                 'Basico + mayorista historico -> retail'),
    ('OWN_P',  'BIZ_PRO',  'CMIN_P', 'INV_P', 1000,          1000,          NULL,                 'Pro + minorista -> retail'),
    ('CAS_P',  'BIZ_PRO',  'CMAY_P', 'INV_P', 1000,          1000,          NULL,                 'cashier sin wholesale + mayorista: la venta NO falla, retail')
  ) AS t(actor, biz, cust, inv, precio_cliente, precio_esperado, fuente_mayorista, label) LOOP
    r := pg_temp.venta(pg_temp.id(c.actor), c.biz, 'P3S-' || c.actor || '-' || c.cust || '-' || c.inv, c.cust, c.inv, c.precio_cliente);
    PERFORM pg_temp.assert(r->>'status' = 'created', format('E · %s: la venta sale (%s)', c.label, r));
    PERFORM pg_temp.assert((r->>'precio')::numeric = c.precio_esperado, format('E · %s: precio %s (esperado %s)', c.label, r->>'precio', c.precio_esperado));
    PERFORM pg_temp.assert((r->>'fuente' = 'resolved_mayorista') = (c.fuente_mayorista IS NOT NULL),
      format('E · %s: fuente %s', c.label, r->>'fuente'));
    PERFORM pg_temp.assert((r->>'override')::boolean IS NOT TRUE, format('E · %s: sin override manual', c.label));
  END LOOP;

  -- Un actor sin override que manda el precio mayorista sin tener autoridad:
  -- el servidor resolvio minorista y el precio del cliente es un override que
  -- el cashier no puede hacer. El precio mayorista NO se cuela.
  r := pg_temp.venta(pg_temp.id('CAS_P'), 'BIZ_PRO', 'P3S-CAS-FORCE', 'CMAY_P', 'INV_P', 700);
  PERFORM pg_temp.assert(r->>'status' IS DISTINCT FROM 'created' AND COALESCE(r->>'precio', '') <> '700',
    'E · cashier sin wholesale no obtiene precio mayorista mandandolo desde el cliente (' || r::text || ')');
END $$;

-- ============================================================================
-- F · CONVERSION portal -> customers
-- ============================================================================
DO $$
DECLARE r text; j jsonb; v_id uuid; v_n int;
BEGIN
  r := pg_temp.como(pg_temp.id('MGR_P'), format('SELECT public.get_or_create_customer_from_wholesale_atomic(%L, %L)', pg_temp.id('BIZ_PRO'), pg_temp.id('WC_P')));
  PERFORM pg_temp.assert(r LIKE '42501%', 'F · manager sin wholesale no convierte (' || r || ')');
  r := pg_temp.como(pg_temp.id('TECW_P'), format('SELECT public.get_or_create_customer_from_wholesale_atomic(%L, %L)', pg_temp.id('BIZ_PRO'), pg_temp.id('WC_P')));
  PERFORM pg_temp.assert(r LIKE '42501%', 'F · tech con wholesale (lectura) no convierte (' || r || ')');
  r := pg_temp.como(pg_temp.id('OWN_B'), format('SELECT public.get_or_create_customer_from_wholesale_atomic(%L, %L)', pg_temp.id('BIZ_BAS'), pg_temp.id('WC_P')));
  PERFORM pg_temp.assert(r LIKE '42501%mayorista%', 'F · Basico: rechazo por plan (' || r || ')');
  r := pg_temp.como(pg_temp.id('OWN_P'), format('SELECT public.get_or_create_customer_from_wholesale_atomic(%L, %L)', pg_temp.id('BIZ_X'), pg_temp.id('WC_X')));
  PERFORM pg_temp.assert(r LIKE '42501%', 'F · cross-tenant por business_id: Forbidden (' || r || ')');
  r := pg_temp.como(pg_temp.id('OWN_P'), format('SELECT public.get_or_create_customer_from_wholesale_atomic(%L, %L)', pg_temp.id('BIZ_PRO'), pg_temp.id('WC_X')));
  PERFORM pg_temp.assert(r LIKE 'P0002%', 'F · cliente del portal de otro tenant: no existe (' || r || ')');
  PERFORM pg_temp.assert(pg_temp.como_anon(format('SELECT public.get_or_create_customer_from_wholesale_atomic(%L, %L)', pg_temp.id('BIZ_PRO'), pg_temp.id('WC_P'))) LIKE '42501%',
    'F · anon no puede ejecutar la conversion');

  -- Alta: crea el mayorista con los datos del portal.
  j := pg_temp.v(pg_temp.id('SALW_P'), format('public.get_or_create_customer_from_wholesale_atomic(%L, %L)', pg_temp.id('BIZ_PRO'), pg_temp.id('WC_P')))::jsonb;
  v_id := (j->>'customer_id')::uuid;
  PERFORM pg_temp.assert((j->>'created')::boolean, 'F · sales con wholesale crea el cliente (' || j::text || ')');
  PERFORM pg_temp.assert((SELECT customer_type = 'mayorista' AND business_name = 'Portal SRL' AND email = 'nuevo@p3s.test' AND phone = '3511111111'
                            FROM public.customers WHERE id = v_id), 'F · el cliente creado es mayorista con los datos del portal');
  -- Idempotente.
  j := pg_temp.v(pg_temp.id('OWN_P'), format('public.get_or_create_customer_from_wholesale_atomic(%L, %L)', pg_temp.id('BIZ_PRO'), pg_temp.id('WC_P')))::jsonb;
  PERFORM pg_temp.assert((j->>'customer_id')::uuid = v_id AND NOT (j->>'created')::boolean, 'F · repetir la conversion devuelve el mismo cliente');
  SELECT count(*) INTO v_n FROM public.customers WHERE lower(email) = 'nuevo@p3s.test';
  PERFORM pg_temp.assert(v_n = 1, 'F · sin duplicados');
  -- Existente: se devuelve sin reclasificar.
  j := pg_temp.v(pg_temp.id('OWN_P'), format('public.get_or_create_customer_from_wholesale_atomic(%L, %L)', pg_temp.id('BIZ_PRO'), pg_temp.id('WC_P2')))::jsonb;
  PERFORM pg_temp.assert((j->>'customer_id')::uuid = pg_temp.id('CEX_P') AND NOT (j->>'created')::boolean, 'F · email existente: devuelve ese cliente');
  PERFORM pg_temp.assert((SELECT customer_type = 'minorista' FROM public.customers WHERE id = pg_temp.id('CEX_P')), 'F · no reclasifica al cliente existente');
  -- Ambiguo: no adivina.
  r := pg_temp.como(pg_temp.id('OWN_P'), format('SELECT public.get_or_create_customer_from_wholesale_atomic(%L, %L)', pg_temp.id('BIZ_PRO'), pg_temp.id('WC_P3')));
  PERFORM pg_temp.assert(r LIKE '%CUSTOMER_MATCH_AMBIGUOUS%', 'F · dos clientes con el mismo email -> ambiguo (' || r || ')');
END $$;

-- ============================================================================
-- G · HIGIENE SECDEF
-- ============================================================================
DO $$
DECLARE f text; v_def boolean; v_cfg text[];
BEGIN
  FOREACH f IN ARRAY ARRAY['public.current_user_has_wholesale_access(uuid)', 'public.current_user_can_manage_wholesale(uuid)',
                           'public.get_or_create_customer_from_wholesale_atomic(uuid,uuid)', 'public.business_has_feature(text)',
                           'public.update_wholesale_order_status_atomic(uuid,uuid,text,text)',
                           'public.update_wholesale_customer_status_atomic(uuid,uuid,boolean,boolean,text)'] LOOP
    SELECT p.prosecdef, p.proconfig INTO v_def, v_cfg FROM pg_proc p WHERE p.oid = f::regprocedure;
    PERFORM pg_temp.assert(v_def AND v_cfg::text ~ 'search_path=pg_catalog, pg_temp', 'G · ' || f || ' SECDEF con search_path endurecido');
    PERFORM pg_temp.assert(NOT has_function_privilege('anon', f::regprocedure, 'EXECUTE'), 'G · anon sin EXECUTE: ' || f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['private.plan_feature_enabled(text,text,text)', 'private.business_feature_enabled(uuid,text)',
                           'private.wholesale_access_level(uuid)', 'private.enforce_customer_wholesale_authority()'] LOOP
    PERFORM pg_temp.assert(NOT has_function_privilege('authenticated', f::regprocedure, 'EXECUTE')
                           AND NOT has_function_privilege('anon', f::regprocedure, 'EXECUTE'), 'G · la API no ejecuta ' || f);
  END LOOP;
  PERFORM pg_temp.assert(pg_temp.como(pg_temp.id('OWN_P'), format('SELECT private.wholesale_access_level(%L)', pg_temp.id('BIZ_PRO'))) LIKE '42501%',
    'G · authenticated no llama al nucleo privado');
END $$;

ROLLBACK;
