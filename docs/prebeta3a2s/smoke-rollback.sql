-- ============================================================================
-- PRE-BETA-3A-2S · SMOKE BAJO BEGIN ... ROLLBACK
--
-- Correr DESPUES de postdeploy-verify-readonly.sql (todo ok):
--
--   psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f docs/prebeta3a2s/smoke-rollback.sql
--
-- Crea fixtures SINTETICOS (ids 5e0c3a25-..., codigos SMOKE3A2S-*) dentro de una
-- transaccion que SIEMPRE termina en ROLLBACK: ante el primer FAIL psql corta y
-- la conexion descarta la transaccion; si todo pasa, la ultima sentencia es
-- ROLLBACK. No toca datos reales. Efectos no transaccionales: consume valores
-- de secuencias (numeracion interna) y toma locks breves sobre filas nuevas.
--
-- Requiere el rol `postgres` (SET LOCAL ROLE authenticated y
-- session_replication_role para cargar fixtures sin disparar triggers de alta).
--
-- Cubre lo que el postdeploy no puede ver sin ejecutar: el comportamiento REAL
-- de RLS, del trigger de customers, del checkout y de la conversion, con
-- identidades `authenticated`.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL client_min_messages = notice;

DO $gate$
BEGIN
  IF to_regprocedure('public.current_user_has_wholesale_access(uuid)') IS NULL
     OR to_regprocedure('public.get_or_create_customer_from_wholesale_atomic(uuid,uuid)') IS NULL
     OR to_regclass('private.internal_tool_principals') IS NULL THEN
    RAISE EXCEPTION 'SMOKE: las migraciones 3A-2S no estan aplicadas';
  END IF;
END
$gate$;

CREATE FUNCTION pg_temp.assert(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'SMOKE FAIL: %', label; END IF;
  RAISE NOTICE 'PASS: %', label;
END; $$;

CREATE TEMP TABLE smk_ids(k text PRIMARY KEY, v uuid NOT NULL) ON COMMIT DROP;
CREATE FUNCTION pg_temp.id(p_k text) RETURNS uuid LANGUAGE sql AS $$ SELECT v FROM smk_ids WHERE k = p_k $$;

-- Ejecuta SQL como `authenticated` con la identidad dada: 'OK' o SQLSTATE + mensaje.
CREATE FUNCTION pg_temp.como(p_uid uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
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
  PERFORM set_config('request.jwt.claim.sub', '', true);
  RETURN v_state;
END; $$;

-- Evalua una expresion escalar como `authenticated`: texto o 'ERR <sqlstate>'.
CREATE FUNCTION pg_temp.v(p_uid uuid, p_expr text) RETURNS text LANGUAGE plpgsql AS $$
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
  PERFORM set_config('request.jwt.claim.sub', '', true);
  RETURN v_out;
END; $$;

-- Venta por el checkout canonico como `authenticated`.
CREATE FUNCTION pg_temp.venta(p_uid uuid, p_biz text, p_key text, p_cust text, p_inv text, p_precio numeric)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; it record;
  v_biz uuid := pg_temp.id(p_biz); v_cust uuid := pg_temp.id(p_cust); v_inv uuid := pg_temp.id(p_inv);
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    r := public.create_comprobante_checkout_atomic(v_biz, p_key, 'h-' || p_key,
      jsonb_build_object('tipo','remito','punto_venta','0001','condicion_fiscal','Consumidor Final',
        'customer_id', v_cust, 'cc_total', 0, 'emitir_en_arca', false,
        'items', jsonb_build_array(jsonb_build_object(
          'inventory_id', v_inv, 'descripcion', 'Smoke ' || p_key,
          'tipo_linea','producto','cantidad',1,'precio_unitario', p_precio)),
        'pagos', jsonb_build_array(jsonb_build_object(
          'amount', p_precio, 'amount_ars', p_precio, 'payment_method','efectivo'))));
  EXCEPTION WHEN OTHERS THEN
    r := jsonb_build_object('error_state', SQLSTATE, 'error', SQLERRM);
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  IF r ? 'comprobante_id' THEN
    SELECT ci.precio_unitario, ci.applied_price_source INTO it
      FROM public.comprobante_items ci WHERE ci.comprobante_id = (r->>'comprobante_id')::uuid LIMIT 1;
    r := r || jsonb_build_object('precio', it.precio_unitario, 'fuente', it.applied_price_source);
  END IF;
  RETURN r;
END; $$;

-- ── Fixture sintetico ───────────────────────────────────────────────────────
INSERT INTO smk_ids VALUES
  ('BIZ_PRO', '5e0c3a25-0000-4000-8000-000000000b01'), ('BIZ_BAS', '5e0c3a25-0000-4000-8000-000000000b02'),
  ('BIZ_X',   '5e0c3a25-0000-4000-8000-000000000b03'),
  ('OWN_P',   '5e0c3a25-0000-4000-8000-000000000c01'), ('ADMX_P', '5e0c3a25-0000-4000-8000-000000000c02'),
  ('SAL_P',   '5e0c3a25-0000-4000-8000-000000000c03'), ('SALW_P', '5e0c3a25-0000-4000-8000-000000000c04'),
  ('TECW_P',  '5e0c3a25-0000-4000-8000-000000000c05'), ('CAS_P',  '5e0c3a25-0000-4000-8000-000000000c06'),
  ('SYS_P',   '5e0c3a25-0000-4000-8000-000000000c07'), ('OWN_B',  '5e0c3a25-0000-4000-8000-000000000c08'),
  ('OWN_X',   '5e0c3a25-0000-4000-8000-000000000c09'), ('WCU_P',  '5e0c3a25-0000-4000-8000-000000000c0a'),
  ('CMAY_P',  '5e0c3a25-0000-4000-8000-000000000d01'), ('CMIN_P', '5e0c3a25-0000-4000-8000-000000000d02'),
  ('CMAY_B',  '5e0c3a25-0000-4000-8000-000000000d03'),
  ('INV_P',   '5e0c3a25-0000-4000-8000-000000000e01'), ('INV_B',  '5e0c3a25-0000-4000-8000-000000000e02'),
  ('CAJA_P',  '5e0c3a25-0000-4000-8000-000000000f01'), ('CAJA_B', '5e0c3a25-0000-4000-8000-000000000f02'),
  ('WC_P',    '5e0c3a25-0000-4000-8000-000000001001');

DO $fx$
BEGIN
  IF EXISTS (SELECT 1 FROM public.businesses WHERE id IN (SELECT v FROM smk_ids))
     OR EXISTS (SELECT 1 FROM auth.users WHERE id IN (SELECT v FROM smk_ids)) THEN
    RAISE EXCEPTION 'SMOKE: los ids sinteticos ya existen; abortar';
  END IF;
END
$fx$;

SET LOCAL session_replication_role = 'replica';
INSERT INTO auth.users(id) SELECT v FROM smk_ids WHERE k ~ '^(OWN_|ADMX_|SAL|TECW_|CAS_|SYS_|WCU_)';
INSERT INTO public.businesses(id, name, owner_user_id, subscription_plan, subscription_status, wholesale_portal_enabled) VALUES
  (pg_temp.id('BIZ_PRO'), 'SMOKE3A2S Pro',    pg_temp.id('OWN_P'), 'pro',    'active', false),
  (pg_temp.id('BIZ_BAS'), 'SMOKE3A2S Basico', pg_temp.id('OWN_B'), 'basico', 'active', false),
  (pg_temp.id('BIZ_X'),   'SMOKE3A2S Otro',   pg_temp.id('OWN_X'), 'full',   'active', false);
INSERT INTO public.profiles(id, user_id, business_id, role, is_active, permissions) VALUES
  (pg_temp.id('OWN_P'),  pg_temp.id('OWN_P'),  pg_temp.id('BIZ_PRO'), 'owner',   true, '{"wholesale": false}'::jsonb),
  (pg_temp.id('ADMX_P'), pg_temp.id('ADMX_P'), pg_temp.id('BIZ_PRO'), 'admin',   true, '{"wholesale": false}'::jsonb),
  (pg_temp.id('SAL_P'),  pg_temp.id('SAL_P'),  pg_temp.id('BIZ_PRO'), 'sales',   true, NULL),
  (pg_temp.id('SALW_P'), pg_temp.id('SALW_P'), pg_temp.id('BIZ_PRO'), 'sales',   true, '{"wholesale": true}'::jsonb),
  (pg_temp.id('TECW_P'), pg_temp.id('TECW_P'), pg_temp.id('BIZ_PRO'), 'tech',    true, '{"wholesale": true}'::jsonb),
  (pg_temp.id('CAS_P'),  pg_temp.id('CAS_P'),  pg_temp.id('BIZ_PRO'), 'cashier', true, NULL),
  (pg_temp.id('SYS_P'),  pg_temp.id('SYS_P'),  pg_temp.id('BIZ_PRO'), 'manager', true, '{"wholesale": true}'::jsonb),
  (pg_temp.id('OWN_B'),  pg_temp.id('OWN_B'),  pg_temp.id('BIZ_BAS'), 'owner',   true, NULL),
  (pg_temp.id('OWN_X'),  pg_temp.id('OWN_X'),  pg_temp.id('BIZ_X'),   'owner',   true, NULL);
INSERT INTO public.system_admins(user_id, email, role, is_active)
VALUES (pg_temp.id('SYS_P'), 'smoke3a2s-sys@invalid.test', 'super_admin', true);
INSERT INTO public.customers(id, business_id, name, phone, customer_type, business_name, contact_person) VALUES
  (pg_temp.id('CMAY_P'), pg_temp.id('BIZ_PRO'), 'SMOKE3A2S Mayorista', '0', 'mayorista', 'Smoke SRL', 'Ana'),
  (pg_temp.id('CMIN_P'), pg_temp.id('BIZ_PRO'), 'SMOKE3A2S Minorista', '0', 'minorista', NULL, NULL),
  (pg_temp.id('CMAY_B'), pg_temp.id('BIZ_BAS'), 'SMOKE3A2S Historico', '0', 'mayorista', 'Viejo SRL', 'Cai');
INSERT INTO public.inventory(id, business_id, name, code, category, stock_quantity, stock, cost_price, sale_price,
                             precio_mayorista, base_price, base_currency, auto_update_price, exchange_rate_used, is_active) VALUES
  (pg_temp.id('INV_P'), pg_temp.id('BIZ_PRO'), 'SMOKE3A2S Prod P', 'SMOKE3A2S-5e0c-P', 'Rep', 100, 100, 400, 1000, 700, 1000, 'ARS', false, 1, true),
  (pg_temp.id('INV_B'), pg_temp.id('BIZ_BAS'), 'SMOKE3A2S Prod B', 'SMOKE3A2S-5e0c-B', 'Rep', 100, 100, 400, 1000, 700, 1000, 'ARS', false, 1, true);
INSERT INTO public.cajas(id, business_id, opened_by, status) VALUES
  (pg_temp.id('CAJA_P'), pg_temp.id('BIZ_PRO'), pg_temp.id('OWN_P'), 'abierta'),
  (pg_temp.id('CAJA_B'), pg_temp.id('BIZ_BAS'), pg_temp.id('OWN_B'), 'abierta');
INSERT INTO public.wholesale_customers(id, business_id, auth_user_id, name, business_name, email, whatsapp, approved, suspended) VALUES
  (pg_temp.id('WC_P'), pg_temp.id('BIZ_PRO'), pg_temp.id('WCU_P'), 'SMOKE3A2S Portal', 'Portal SRL',
   'smoke3a2s-portal@invalid.test', '0', true, false);
INSERT INTO public.clic_wholesale_product_settings(business_id, inventory_id, is_featured) VALUES
  (pg_temp.id('BIZ_PRO'), pg_temp.id('INV_P'), false);
INSERT INTO storage.objects(bucket_id, name)
VALUES ('clic-wholesale-products', pg_temp.id('BIZ_PRO')::text || '/smoke/1.png');
SET LOCAL session_replication_role = 'origin';

-- ── 1. Entitlement y actor ──────────────────────────────────────────────────
DO $s1$
DECLARE c record;
BEGIN
  PERFORM pg_temp.assert(private.business_feature_enabled(pg_temp.id('BIZ_PRO'), 'mayorista'), '1 · Pro tiene Mayorista');
  PERFORM pg_temp.assert(NOT private.business_feature_enabled(pg_temp.id('BIZ_BAS'), 'mayorista'), '1 · Basico NO tiene Mayorista');

  FOR c IN SELECT * FROM (VALUES
    ('OWN_P',  'BIZ_PRO', 'true',  'true',  'owner Pro con override false: acceso y gestion'),
    ('ADMX_P', 'BIZ_PRO', 'true',  'true',  'admin Pro con override false: acceso y gestion'),
    ('SAL_P',  'BIZ_PRO', 'false', 'false', 'sales Pro sin wholesale: sin acceso'),
    ('SALW_P', 'BIZ_PRO', 'true',  'true',  'sales Pro con wholesale: acceso y gestion'),
    ('TECW_P', 'BIZ_PRO', 'true',  'false', 'tech Pro con wholesale: solo lectura'),
    ('CAS_P',  'BIZ_PRO', 'false', 'false', 'cashier Pro sin wholesale: sin acceso'),
    ('OWN_B',  'BIZ_BAS', 'false', 'false', 'owner Basico: sin acceso (plan)'),
    ('OWN_P',  'BIZ_X',   'false', 'false', 'owner Pro sobre otro negocio: sin acceso (tenant)')
  ) AS t(actor, biz, acceso, gestion, label) LOOP
    PERFORM pg_temp.assert(
      pg_temp.v(pg_temp.id(c.actor), format('public.current_user_has_wholesale_access(%L)', pg_temp.id(c.biz))) = c.acceso
      AND pg_temp.v(pg_temp.id(c.actor), format('public.current_user_can_manage_wholesale(%L)', pg_temp.id(c.biz))) = c.gestion,
      '1 · ' || c.label);
  END LOOP;
END
$s1$;

-- ── 2. wholesale_*: lectura por acceso, escritura por gestion ───────────────
DO $s2$
DECLARE r text;
BEGIN
  PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('SAL_P'),
    format('(SELECT count(*) FROM public.wholesale_customers WHERE business_id = %L)', pg_temp.id('BIZ_PRO'))) = '0',
    '2 · sales sin wholesale no lee clientes del portal');
  PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('TECW_P'),
    format('(SELECT count(*) FROM public.wholesale_customers WHERE business_id = %L)', pg_temp.id('BIZ_PRO'))) = '1',
    '2 · tech con wholesale lee clientes del portal');
  r := pg_temp.como(pg_temp.id('TECW_P'), format('SELECT public.update_wholesale_customer_status_atomic(%L, %L, NULL, NULL, %L)',
         pg_temp.id('BIZ_PRO'), pg_temp.id('WC_P'), 'smoke'));
  PERFORM pg_temp.assert(r LIKE '42501%', '2 · tech con wholesale NO escribe (' || r || ')');
END
$s2$;

-- ── 3. customers: trigger central ──────────────────────────────────────────
DO $s3$
DECLARE r text;
BEGIN
  r := pg_temp.como(pg_temp.id('SAL_P'), format(
         'INSERT INTO public.customers(business_id, name, phone, customer_type) VALUES (%L, %L, %L, %L)',
         pg_temp.id('BIZ_PRO'), 'SMOKE3A2S Nuevo', '0', 'mayorista'));
  PERFORM pg_temp.assert(r LIKE '42501%WHOLESALE_AUTHORITY_REQUIRED%', '3 · sales sin wholesale no crea mayoristas (' || r || ')');
  r := pg_temp.como(pg_temp.id('SAL_P'), format('UPDATE public.customers SET phone = %L WHERE id = %L', '1', pg_temp.id('CMAY_P')));
  PERFORM pg_temp.assert(r = 'OK', '3 · sales sin wholesale edita campos comunes de un mayorista historico (' || r || ')');
  r := pg_temp.como(pg_temp.id('SAL_P'), format('UPDATE public.customers SET customer_type = %L WHERE id = %L', 'mayorista', pg_temp.id('CMIN_P')));
  PERFORM pg_temp.assert(r LIKE '42501%', '3 · sales sin wholesale no convierte minorista -> mayorista (' || r || ')');
  r := pg_temp.como(pg_temp.id('SAL_P'), format('UPDATE public.customers SET business_name = %L WHERE id = %L', 'Otra SRL', pg_temp.id('CMAY_P')));
  PERFORM pg_temp.assert(r LIKE '42501%', '3 · sales sin wholesale no toca business_name de un mayorista (' || r || ')');
  r := pg_temp.como(pg_temp.id('OWN_B'), format('UPDATE public.customers SET customer_type = %L WHERE id = %L', 'minorista', pg_temp.id('CMAY_B')));
  PERFORM pg_temp.assert(r LIKE '42501%', '3 · Basico no reclasifica su mayorista historico (' || r || ')');
  PERFORM pg_temp.assert((SELECT customer_type = 'mayorista' FROM public.customers WHERE id = pg_temp.id('CMAY_B')),
    '3 · el mayorista historico de Basico sigue mayorista');
  r := pg_temp.como(pg_temp.id('ADMX_P'), format('UPDATE public.customers SET customer_type = %L WHERE id = %L', 'mayorista', pg_temp.id('CMIN_P')));
  PERFORM pg_temp.assert(r = 'OK', '3 · admin (override false) convierte minorista -> mayorista (' || r || ')');
END
$s3$;

-- ── 4. Checkout: precio mayorista = cliente mayorista Y autoridad ───────────
DO $s4$
DECLARE r jsonb; c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('ADMX_P', 'BIZ_PRO', 'CMAY_P', 'INV_P', 700::numeric, 'resolved_mayorista', 'admin Pro + mayorista -> mayorista'),
    ('SAL_P',  'BIZ_PRO', 'CMAY_P', 'INV_P', 1000,         'resolved_minorista', 'sales sin wholesale + mayorista -> minorista, sin rechazo'),
    ('SALW_P', 'BIZ_PRO', 'CMAY_P', 'INV_P', 700,          'resolved_mayorista', 'sales con wholesale + mayorista -> mayorista'),
    ('OWN_B',  'BIZ_BAS', 'CMAY_B', 'INV_B', 1000,         'resolved_minorista', 'Basico + mayorista historico -> minorista')
  ) AS t(actor, biz, cust, inv, precio, fuente, label) LOOP
    r := pg_temp.venta(pg_temp.id(c.actor), c.biz, 'SMOKE3A2S-' || c.actor || '-' || c.cust, c.cust, c.inv, c.precio);
    PERFORM pg_temp.assert(r->>'status' = 'created' AND (r->>'precio')::numeric = c.precio AND r->>'fuente' = c.fuente,
      '4 · ' || c.label || ' (' || r::text || ')');
  END LOOP;
  -- El precio mayorista mandado desde el cliente por un actor sin autoridad ni
  -- permiso de override no se cuela.
  r := pg_temp.venta(pg_temp.id('CAS_P'), 'BIZ_PRO', 'SMOKE3A2S-CAS-FORCE', 'CMAY_P', 'INV_P', 700);
  PERFORM pg_temp.assert(r->>'status' IS DISTINCT FROM 'created', '4 · cashier sin wholesale no fuerza el precio mayorista (' || r::text || ')');
END
$s4$;

-- ── 5. Conversion portal -> customers ──────────────────────────────────────
DO $s5$
DECLARE r text; j jsonb; v_id uuid;
BEGIN
  r := pg_temp.como(pg_temp.id('SAL_P'), format('SELECT public.get_or_create_customer_from_wholesale_atomic(%L, %L)',
         pg_temp.id('BIZ_PRO'), pg_temp.id('WC_P')));
  PERFORM pg_temp.assert(r LIKE '42501%', '5 · sales sin wholesale no convierte (' || r || ')');
  j := pg_temp.v(pg_temp.id('ADMX_P'), format('public.get_or_create_customer_from_wholesale_atomic(%L, %L)',
         pg_temp.id('BIZ_PRO'), pg_temp.id('WC_P')))::jsonb;
  v_id := (j->>'customer_id')::uuid;
  PERFORM pg_temp.assert((j->>'created')::boolean
    AND (SELECT customer_type = 'mayorista' FROM public.customers WHERE id = v_id), '5 · admin convierte: crea el mayorista');
  j := pg_temp.v(pg_temp.id('ADMX_P'), format('public.get_or_create_customer_from_wholesale_atomic(%L, %L)',
         pg_temp.id('BIZ_PRO'), pg_temp.id('WC_P')))::jsonb;
  PERFORM pg_temp.assert((j->>'customer_id')::uuid = v_id AND NOT (j->>'created')::boolean, '5 · repetir es idempotente');
END
$s5$;

-- ── 6. Portal Clic: autoridad interna ──────────────────────────────────────
DO $s6$
DECLARE r text; v_bind boolean;
BEGIN
  -- Negativos con el principal que haya (o ninguno): owner, admin, wholesale y
  -- system_admin del negocio sintetico NO entran.
  PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('OWN_P'),  format('public.current_user_has_internal_tool_access(%L, %L)', 'portal_clic', pg_temp.id('BIZ_PRO'))) = 'false', '6 · owner Pro NO entra');
  PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('SALW_P'), format('public.current_user_has_internal_tool_access(%L, %L)', 'portal_clic', pg_temp.id('BIZ_PRO'))) = 'false', '6 · capacidad wholesale NO entra');
  PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('SYS_P'),  format('public.current_user_has_internal_tool_access(%L, %L)', 'portal_clic', pg_temp.id('BIZ_PRO'))) = 'false', '6 · system_admin super_admin NO entra');
  PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('OWN_X'),  format('public.current_user_has_internal_tool_access(%L, %L)', 'portal_clic', pg_temp.id('BIZ_X'))) = 'false', '6 · owner Full NO entra');
  PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('OWN_P'), format('(SELECT count(*) FROM public.clic_wholesale_product_settings WHERE business_id = %L)', pg_temp.id('BIZ_PRO'))) = '0', '6 · owner no lee la configuracion privada');
  PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('OWN_P'), '(SELECT count(*) FROM storage.objects WHERE bucket_id = ''clic-wholesale-products'')') = '0', '6 · owner no lista objetos de Portal Clic');
  r := pg_temp.como(pg_temp.id('OWN_P'), format('INSERT INTO public.clic_wholesale_product_settings(business_id, inventory_id, is_featured) VALUES (%L, %L, true)',
         pg_temp.id('BIZ_PRO'), pg_temp.id('INV_P')));
  PERFORM pg_temp.assert(r LIKE '42501%', '6 · owner no escribe la configuracion privada (' || r || ')');

  -- Positivo solo si todavia NO hay binding real (no se pisa el principal real).
  v_bind := NOT EXISTS (SELECT 1 FROM private.internal_tool_principals WHERE tool_key = 'portal_clic');
  IF v_bind THEN
    INSERT INTO private.internal_tool_principals(tool_key, user_id, business_id, granted_reason)
    VALUES ('portal_clic', pg_temp.id('ADMX_P'), pg_temp.id('BIZ_PRO'), 'smoke 3A-2S (rollback)');
    PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('ADMX_P'), format('public.current_user_has_internal_tool_access(%L, %L)', 'portal_clic', pg_temp.id('BIZ_PRO'))) = 'true', '6 · principal exacto (identidad + negocio + activo) entra');
    PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('ADMX_P'), format('(SELECT count(*) FROM public.clic_wholesale_product_settings WHERE business_id = %L)', pg_temp.id('BIZ_PRO'))) = '1', '6 · principal lee la configuracion privada');
    PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('ADMX_P'), '(SELECT count(*) FROM storage.objects WHERE bucket_id = ''clic-wholesale-products'')') = '1', '6 · principal lista los objetos de su negocio');
    PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('ADMX_P'), format('public.current_user_has_internal_tool_access(%L, %L)', 'portal_clic', pg_temp.id('BIZ_X'))) = 'false', '6 · principal sobre otro negocio NO entra');
    PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('OWN_P'),  format('public.current_user_has_internal_tool_access(%L, %L)', 'portal_clic', pg_temp.id('BIZ_PRO'))) = 'false', '6 · otro usuario del negocio correcto NO entra');
    UPDATE private.internal_tool_principals SET active = false WHERE tool_key = 'portal_clic';
    PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('ADMX_P'), format('public.current_user_has_internal_tool_access(%L, %L)', 'portal_clic', pg_temp.id('BIZ_PRO'))) = 'false', '6 · principal inactivo NO entra');
  ELSE
    RAISE NOTICE 'SKIP: 6 · ya hay un principal portal_clic real: no se crea uno sintetico (solo negativos)';
  END IF;
  PERFORM pg_temp.assert(pg_temp.como(pg_temp.id('ADMX_P'), 'SELECT count(*) FROM private.internal_tool_principals') LIKE '42501%',
    '6 · authenticated no lee el principal');
END
$s6$;

DO $fin$ BEGIN RAISE NOTICE 'SMOKE 3A-2S OK · se revierte todo'; END $fin$;

ROLLBACK;
