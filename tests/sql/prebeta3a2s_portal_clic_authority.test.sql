-- ============================================================================
-- PRE-BETA-3A-2S · Portal Clic: autoridad interna dedicada (matriz real).
--
--   SI  identidad exacta + negocio exacto + portal_clic activo.
--   NO  owner generico · negocio Full · capacidad wholesale · system_admin
--       distinto · identidad correcta en otro negocio · negocio correcto con
--       otro usuario · principal inactivo · principal que ya no es miembro.
--   La activacion del portal (wholesale_portal_enabled) NO decide quien lo
--   administra. La tabla del principal esta fuera de la API y su historial es
--   append-only. Se cubren datos privados (clic_wholesale_product_settings) y
--   storage (bucket clic-wholesale-products).
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

CREATE TEMP TABLE pc_ids(k text PRIMARY KEY, v uuid NOT NULL) ON COMMIT DROP;
CREATE OR REPLACE FUNCTION pg_temp.id(p_k text) RETURNS uuid LANGUAGE sql AS
$$ SELECT v FROM pc_ids WHERE k = p_k $$;

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

-- Acceso completo del actor a Portal Clic: helper + datos privados + storage.
CREATE OR REPLACE FUNCTION pg_temp.acceso(p_uid uuid, p_biz uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_inv uuid := pg_temp.id('INV_CLIC');
BEGIN
  RETURN jsonb_build_object(
    'helper',  pg_temp.v(p_uid, format('public.current_user_has_internal_tool_access(%L, %L)', 'portal_clic', p_biz)),
    'lee',     pg_temp.v(p_uid, format('(SELECT count(*) FROM public.clic_wholesale_product_settings WHERE business_id = %L)', p_biz)),
    'escribe', pg_temp.como(p_uid, format(
                 'INSERT INTO public.clic_wholesale_product_settings(business_id, inventory_id, is_featured) VALUES (%L, %L, true) '
                 || 'ON CONFLICT DO NOTHING', p_biz, v_inv)),
    'sube',    pg_temp.como(p_uid, format(
                 'INSERT INTO storage.objects(bucket_id, name) VALUES (%L, %L)',
                 'clic-wholesale-products', p_biz::text || '/' || v_inv::text || '/' || md5(random()::text) || '.jpg')));
END; $$;

CREATE OR REPLACE FUNCTION pg_temp.sin_acceso(p_uid uuid, p_biz uuid, p_label text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE a jsonb := pg_temp.acceso(p_uid, p_biz);
BEGIN
  PERFORM pg_temp.assert(a->>'helper' = 'false', p_label || ' · helper false (' || a::text || ')');
  PERFORM pg_temp.assert(a->>'lee' = '0', p_label || ' · no lee la configuracion privada');
  PERFORM pg_temp.assert(a->>'escribe' LIKE '42501%', p_label || ' · no escribe la configuracion privada');
  PERFORM pg_temp.assert(a->>'sube' LIKE '42501%', p_label || ' · no sube imagenes al bucket');
END; $$;

-- ── Fixture ────────────────────────────────────────────────────────────────
INSERT INTO pc_ids VALUES
  ('BIZ_CLIC',  '00000000-0000-0000-0000-0000000c0b01'), ('BIZ_OTRO', '00000000-0000-0000-0000-0000000c0b02'),
  ('BIZ_PRIN2', '00000000-0000-0000-0000-0000000c0b03'),  -- otro negocio cuyo owner registrado es el principal
  ('PRIN',      '00000000-0000-0000-0000-0000000c0c01'),  -- owner de Clic: el principal a bindear
  ('ADM_CLIC',  '00000000-0000-0000-0000-0000000c0c02'),  -- admin de Clic
  ('MGRW_CLIC', '00000000-0000-0000-0000-0000000c0c03'),  -- manager de Clic con wholesale
  ('SYS_CLIC',  '00000000-0000-0000-0000-0000000c0c04'),  -- system_admin super_admin, miembro de Clic
  ('OWN_OTRO',  '00000000-0000-0000-0000-0000000c0c05'),  -- owner de otro negocio Full con portal encendido
  ('AJENO',     '00000000-0000-0000-0000-0000000c0c06'),  -- sin perfil en Clic
  ('INV_CLIC',  '00000000-0000-0000-0000-0000000c0d01'), ('INV_OTRO', '00000000-0000-0000-0000-0000000c0d02');

SET LOCAL session_replication_role = 'replica';
INSERT INTO auth.users(id) SELECT v FROM pc_ids WHERE k IN ('PRIN','ADM_CLIC','MGRW_CLIC','SYS_CLIC','OWN_OTRO','AJENO');
INSERT INTO public.businesses(id, name, owner_user_id, subscription_plan, subscription_status,
                              wholesale_portal_enabled, wholesale_portal_slug) VALUES
  (pg_temp.id('BIZ_CLIC'), 'PC Clic', pg_temp.id('PRIN'),     'full', 'active', true, 'pc-clic'),
  (pg_temp.id('BIZ_OTRO'), 'PC Otro', pg_temp.id('OWN_OTRO'), 'full', 'active', true, 'pc-otro'),
  (pg_temp.id('BIZ_PRIN2'), 'PC Segundo del principal', pg_temp.id('PRIN'), 'full', 'active', true, 'pc-prin2');
INSERT INTO public.profiles(id, user_id, business_id, role, is_active, permissions, updated_at) VALUES
  (pg_temp.id('PRIN'),      pg_temp.id('PRIN'),      pg_temp.id('BIZ_CLIC'), 'owner',   true, NULL, now()),
  (pg_temp.id('ADM_CLIC'),  pg_temp.id('ADM_CLIC'),  pg_temp.id('BIZ_CLIC'), 'admin',   true, NULL, now()),
  (pg_temp.id('MGRW_CLIC'), pg_temp.id('MGRW_CLIC'), pg_temp.id('BIZ_CLIC'), 'manager', true, '{"wholesale": true}'::jsonb, now()),
  (pg_temp.id('SYS_CLIC'),  pg_temp.id('SYS_CLIC'),  pg_temp.id('BIZ_CLIC'), 'admin',   true, NULL, now()),
  (pg_temp.id('OWN_OTRO'),  pg_temp.id('OWN_OTRO'),  pg_temp.id('BIZ_OTRO'), 'owner',   true, NULL, now());
INSERT INTO public.system_admins(user_id, email, role, is_active)
VALUES (pg_temp.id('SYS_CLIC'), 'sys@pc.test', 'super_admin', true);
INSERT INTO public.inventory(id, business_id, name, code, category, stock_quantity, stock, cost_price, sale_price,
                             base_price, base_currency, auto_update_price, exchange_rate_used, is_active) VALUES
  (pg_temp.id('INV_CLIC'), pg_temp.id('BIZ_CLIC'), 'PC Prod', 'PC-1', 'Rep', 5, 5, 400, 1000, 1000, 'ARS', false, 1, true),
  (pg_temp.id('INV_OTRO'), pg_temp.id('BIZ_OTRO'), 'PC Otro', 'PC-2', 'Rep', 5, 5, 400, 1000, 1000, 'ARS', false, 1, true);
INSERT INTO public.clic_wholesale_product_settings(business_id, inventory_id, is_featured) VALUES
  (pg_temp.id('BIZ_CLIC'), pg_temp.id('INV_CLIC'), false),
  (pg_temp.id('BIZ_OTRO'), pg_temp.id('INV_OTRO'), false);
SET LOCAL session_replication_role = 'origin';

-- ============================================================================
-- 1 · Sin binding: NADIE entra (ni el owner de Clic)
-- ============================================================================
DO $$
BEGIN
  PERFORM pg_temp.assert((SELECT count(*) FROM private.internal_tool_principals) = 0, '1 · la migracion no bindeo a nadie');
  PERFORM pg_temp.sin_acceso(pg_temp.id('PRIN'), pg_temp.id('BIZ_CLIC'), '1 · owner de Clic SIN binding');
  PERFORM pg_temp.sin_acceso(pg_temp.id('SYS_CLIC'), pg_temp.id('BIZ_CLIC'), '1 · system_admin SIN binding');
END $$;

-- ============================================================================
-- 2 · Binding por el operador (postgres), como docs/prebeta3a2s/portal-clic-binding.sql
-- ============================================================================
INSERT INTO private.internal_tool_principals(tool_key, user_id, business_id, granted_reason)
VALUES ('portal_clic', pg_temp.id('PRIN'), pg_temp.id('BIZ_CLIC'), 'Test: herramienta interna de Clic');

DO $$
DECLARE a jsonb;
BEGIN
  a := pg_temp.acceso(pg_temp.id('PRIN'), pg_temp.id('BIZ_CLIC'));
  PERFORM pg_temp.assert(a->>'helper' = 'true', '2 · identidad exacta + negocio exacto + activo: SI (' || a::text || ')');
  PERFORM pg_temp.assert(a->>'lee' = '1', '2 · lee la configuracion privada de Clic');
  PERFORM pg_temp.assert(a->>'escribe' = 'OK', '2 · escribe la configuracion privada de Clic');
  PERFORM pg_temp.assert(a->>'sube' = 'OK', '2 · sube imagenes a la carpeta de Clic');
  -- Dos sentencias: la lectura tiene que tomar su snapshot DESPUES del UPDATE.
  PERFORM pg_temp.assert(pg_temp.como(pg_temp.id('PRIN'), format('UPDATE public.clic_wholesale_product_settings SET is_featured = true WHERE business_id = %L', pg_temp.id('BIZ_CLIC'))) = 'OK',
                         '2 · UPDATE permitido');
  PERFORM pg_temp.assert((SELECT is_featured FROM public.clic_wholesale_product_settings WHERE inventory_id = pg_temp.id('INV_CLIC')),
                         '2 · UPDATE efectivo');
  PERFORM pg_temp.assert(pg_temp.como(pg_temp.id('PRIN'), format('INSERT INTO storage.objects(bucket_id, name) VALUES (%L, %L)',
                           'clic-wholesale-products', pg_temp.id('BIZ_OTRO')::text || '/x/y.jpg')) LIKE '42501%',
                         '2 · no sube imagenes a la carpeta de OTRO negocio');
  PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('PRIN'), format('(SELECT count(*) FROM public.clic_wholesale_product_settings WHERE business_id = %L)', pg_temp.id('BIZ_OTRO'))) = '0',
                         '2 · no lee la configuracion de otro negocio');
END $$;

-- ============================================================================
-- 3 · Negativos (con el principal bindeado)
-- ============================================================================
DO $$
BEGIN
  PERFORM pg_temp.sin_acceso(pg_temp.id('OWN_OTRO'),  pg_temp.id('BIZ_OTRO'), '3 · owner generico de un negocio Full con portal encendido');
  PERFORM pg_temp.sin_acceso(pg_temp.id('ADM_CLIC'),  pg_temp.id('BIZ_CLIC'), '3 · admin de Clic (negocio correcto, otro usuario)');
  PERFORM pg_temp.sin_acceso(pg_temp.id('MGRW_CLIC'), pg_temp.id('BIZ_CLIC'), '3 · manager de Clic con wholesale');
  PERFORM pg_temp.sin_acceso(pg_temp.id('SYS_CLIC'),  pg_temp.id('BIZ_CLIC'), '3 · system_admin super_admin distinto');
  PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('PRIN'), format('public.current_user_has_internal_tool_access(%L, %L)', 'portal_clic', pg_temp.id('BIZ_PRIN2'))) = 'false',
                         '3 · identidad correcta en OTRO negocio (del que tambien es owner): NO');
  PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('PRIN'), format('public.current_user_has_internal_tool_access(%L, %L)', 'portal_clic', pg_temp.id('BIZ_OTRO'))) = 'false',
                         '3 · identidad correcta en un negocio ajeno: NO');
  PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('PRIN'), format('public.current_user_has_internal_tool_access(%L, %L)', 'otra_herramienta', pg_temp.id('BIZ_CLIC'))) = 'false',
                         '3 · otra herramienta: NO');
  PERFORM pg_temp.assert(pg_temp.v(NULL, format('public.current_user_has_internal_tool_access(%L, %L)', 'portal_clic', pg_temp.id('BIZ_CLIC'))) = 'false',
                         '3 · sin auth.uid(): NO');
END $$;

-- ============================================================================
-- 4 · Activacion != autorizacion; principal inactivo o fuera del negocio
-- ============================================================================
UPDATE public.businesses SET wholesale_portal_enabled = false WHERE id = pg_temp.id('BIZ_CLIC');
DO $$
BEGIN
  PERFORM pg_temp.assert(pg_temp.acceso(pg_temp.id('PRIN'), pg_temp.id('BIZ_CLIC'))->>'helper' = 'true',
    '4 · con el portal APAGADO el principal sigue administrando (activacion != autorizacion)');
END $$;
UPDATE public.businesses SET wholesale_portal_enabled = true WHERE id = pg_temp.id('BIZ_CLIC');

UPDATE private.internal_tool_principals SET active = false WHERE tool_key = 'portal_clic';
DO $$ BEGIN PERFORM pg_temp.sin_acceso(pg_temp.id('PRIN'), pg_temp.id('BIZ_CLIC'), '4 · principal INACTIVO'); END $$;
UPDATE private.internal_tool_principals SET active = true WHERE tool_key = 'portal_clic';

-- El principal apunta a alguien que no es miembro del negocio.
UPDATE private.internal_tool_principals SET user_id = pg_temp.id('AJENO') WHERE tool_key = 'portal_clic';
DO $$
BEGIN
  PERFORM pg_temp.assert(pg_temp.v(pg_temp.id('AJENO'), format('public.current_user_has_internal_tool_access(%L, %L)', 'portal_clic', pg_temp.id('BIZ_CLIC'))) = 'false',
    '4 · principal que NO es miembro activo del negocio: NO');
  PERFORM pg_temp.sin_acceso(pg_temp.id('PRIN'), pg_temp.id('BIZ_CLIC'), '4 · el owner de Clic deja de entrar si el principal es otro');
END $$;
UPDATE private.internal_tool_principals SET user_id = pg_temp.id('PRIN') WHERE tool_key = 'portal_clic';

-- ============================================================================
-- 5 · Tabla del principal: unicidad, dominio, fuera de la API, auditoria
-- ============================================================================
DO $$
DECLARE r text; v_n int;
BEGIN
  BEGIN
    INSERT INTO private.internal_tool_principals(tool_key, user_id, business_id, granted_reason)
    VALUES ('portal_clic', pg_temp.id('ADM_CLIC'), pg_temp.id('BIZ_CLIC'), 'Segundo principal indebido');
    r := 'OK';
  EXCEPTION WHEN unique_violation THEN r := '23505';
  END;
  PERFORM pg_temp.assert(r = '23505', '5 · a lo sumo UN principal por herramienta');
  BEGIN
    INSERT INTO private.internal_tool_principals(tool_key, user_id, business_id, granted_reason)
    VALUES ('superpoder', pg_temp.id('ADM_CLIC'), pg_temp.id('BIZ_CLIC'), 'Herramienta inexistente');
    r := 'OK';
  EXCEPTION WHEN check_violation THEN r := '23514';
  END;
  PERFORM pg_temp.assert(r = '23514', '5 · tool_key fuera del dominio');

  PERFORM pg_temp.assert(pg_temp.como(pg_temp.id('PRIN'), 'SELECT * FROM private.internal_tool_principals') LIKE '42501%',
                         '5 · la API no lee el principal (ni el propio)');
  PERFORM pg_temp.assert(pg_temp.como(pg_temp.id('PRIN'), format(
                           'INSERT INTO private.internal_tool_principals(tool_key, user_id, business_id, granted_reason) VALUES (%L, %L, %L, %L)',
                           'portal_clic', pg_temp.id('PRIN'), pg_temp.id('BIZ_CLIC'), 'autoasignacion')) LIKE '42501%',
                         '5 · la API no puede auto-asignarse la herramienta');
  PERFORM pg_temp.assert(NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                      WHERE n.nspname = 'public' AND p.prosrc ~* 'insert\s+into\s+private\.internal_tool_principals'),
                         '5 · no existe ninguna RPC publica que escriba el principal');

  SELECT count(*) INTO v_n FROM private.internal_tool_principal_audit WHERE tool_key = 'portal_clic';
  PERFORM pg_temp.assert(v_n >= 5, '5 · cada alta/cambio queda auditado (' || v_n || ' filas)');
  BEGIN
    UPDATE private.internal_tool_principal_audit SET db_user = 'x';
    r := 'OK';
  EXCEPTION WHEN insufficient_privilege THEN r := '42501';
  END;
  PERFORM pg_temp.assert(r = '42501', '5 · la auditoria es append-only');
END $$;

-- ============================================================================
-- 6 · SECDEF
-- ============================================================================
DO $$
BEGIN
  PERFORM pg_temp.assert((SELECT prosecdef AND proconfig::text ~ 'search_path=pg_catalog, pg_temp' FROM pg_proc
                           WHERE oid = 'public.current_user_has_internal_tool_access(text,uuid)'::regprocedure),
                         '6 · helper SECDEF con search_path endurecido');
  PERFORM pg_temp.assert(NOT has_function_privilege('anon', 'public.current_user_has_internal_tool_access(text,uuid)', 'EXECUTE')
                         AND NOT has_function_privilege('service_role', 'public.current_user_has_internal_tool_access(text,uuid)', 'EXECUTE'),
                         '6 · anon/service_role sin EXECUTE');
END $$;

ROLLBACK;
