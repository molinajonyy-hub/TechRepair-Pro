-- ============================================================================
-- AFIP-S1B-A1 — Contrato de escritura arca_config. Datos SINTÉTICOS. tx + ROLLBACK.
-- Prueba unicidad, autorización, preservación de secretos, mass-assignment y
-- compatibilidad con SELECT revocado (criterio principal). RUN: psql -X -f
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

-- Setup sintético (auth.users por FK; jwt claims para auth.uid()).
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at, raw_user_meta_data, raw_app_meta_data)
VALUES ('00000000-0000-0000-0000-000000000000','00000000-0000-4000-8000-00000000ee01','authenticated','authenticated','o@t.local','x',now(),now(),'{}','{}'),
       ('00000000-0000-0000-0000-000000000000','00000000-0000-4000-8000-00000000ee02','authenticated','authenticated','m@t.local','x',now(),now(),'{}','{}'),
       ('00000000-0000-0000-0000-000000000000','00000000-0000-4000-8000-00000000ee03','authenticated','authenticated','b2@t.local','x',now(),now(),'{}','{}')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.businesses (id, name, owner_user_id, subscription_plan, subscription_status) VALUES
  ('00000000-0000-4000-8000-00000000bb01','B1','00000000-0000-4000-8000-00000000ee01','pro','active'),
  ('00000000-0000-4000-8000-00000000bb02','B2','00000000-0000-4000-8000-00000000ee03','pro','active')
ON CONFLICT (id) DO UPDATE SET subscription_plan='pro', subscription_status='active';
INSERT INTO public.profiles (id, user_id, business_id, role, is_active) VALUES
  ('00000000-0000-4000-8000-00000000ee01','00000000-0000-4000-8000-00000000ee01','00000000-0000-4000-8000-00000000bb01','owner',true),
  ('00000000-0000-4000-8000-00000000ee02','00000000-0000-4000-8000-00000000ee02','00000000-0000-4000-8000-00000000bb01','manager',true),
  ('00000000-0000-4000-8000-00000000ee03','00000000-0000-4000-8000-00000000ee03','00000000-0000-4000-8000-00000000bb02','owner',true)
ON CONFLICT (id) DO UPDATE SET business_id=EXCLUDED.business_id, role=EXCLUDED.role, is_active=true;

-- Fila existente con SECRETOS sintéticos (para probar preservación).
INSERT INTO public.arca_config (business_id, cuit, cuit_emisor, ambiente, punto_venta, web_service, alias, cert_file, private_key, wsaa_token, wsaa_sign, estado_conexion)
VALUES ('00000000-0000-4000-8000-00000000bb01','20111111112','20111111112','homologacion',1,'wsfe','a',
        '-----BEGIN CERTIFICATE-----SYNCERT-----END CERTIFICATE-----','-----BEGIN PRIVATE KEY-----SYNKEY-----END PRIVATE KEY-----','tok','sig','conectado')
ON CONFLICT (business_id) DO NOTHING;

\set uid_owner '00000000-0000-4000-8000-00000000ee01'
\set biz1 '00000000-0000-4000-8000-00000000bb01'

-- ══ 1. Autorización + escritura como OWNER ══════════════════════════════════
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000ee01","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert((public.save_arca_config_legacy('00000000-0000-4000-8000-00000000bb01', p_punto_venta=>7)->>'success')='true', 'A1 owner puede guardar config');
RESET ROLE;
SELECT pg_temp.assert((SELECT punto_venta FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-00000000bb01')=7, 'A2 punto_venta actualizado');
-- PRESERVACIÓN: secretos y cache intactos
SELECT pg_temp.assert((SELECT cert_file IS NOT NULL AND private_key IS NOT NULL AND wsaa_token='tok' AND wsaa_sign='sig' AND estado_conexion='conectado'
                        FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-00000000bb01'), 'A3 cert/clave/wsaa/estado PRESERVADOS');

-- ══ 2. Autorización negativa ════════════════════════════════════════════════
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000ee02","role":"authenticated"}';
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  BEGIN PERFORM public.save_arca_config_legacy('00000000-0000-4000-8000-00000000bb01', p_punto_venta=>9);
        PERFORM pg_temp.assert(false,'A4 manager debía ser denegado');
  EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.assert(true,'A4 manager denegado (FORBIDDEN)'); END;
END $$;
RESET ROLE;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000ee03","role":"authenticated"}';
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  BEGIN PERFORM public.save_arca_config_legacy('00000000-0000-4000-8000-00000000bb01', p_punto_venta=>9);
        PERFORM pg_temp.assert(false,'A5 cross-tenant debía ser denegado');
  EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.assert(true,'A5 cross-tenant denegado'); END;
END $$;
RESET ROLE;
SELECT pg_temp.assert((SELECT punto_venta FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-00000000bb01')=7, 'A6 sin cambios tras intentos denegados');

-- ══ 3. Compatibilidad con SELECT revocado (criterio principal S1B-A1) ═══════
REVOKE SELECT ON TABLE public.arca_config FROM authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000ee01","role":"authenticated"}';
SET LOCAL ROLE authenticated;
-- La RPC (SECDEF) funciona aunque authenticated no tenga SELECT
SELECT pg_temp.assert((public.save_arca_config_legacy('00000000-0000-4000-8000-00000000bb01', p_alias=>'nuevo')->>'success')='true', 'A7 RPC funciona con SELECT revocado');
-- El UPDATE directo falla (necesita SELECT para el WHERE)
DO $$ BEGIN
  BEGIN UPDATE public.arca_config SET punto_venta=1 WHERE business_id='00000000-0000-4000-8000-00000000bb01';
        PERFORM pg_temp.assert(false,'A8 UPDATE directo debía fallar sin SELECT');
  EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.assert(true,'A8 UPDATE directo denegado sin SELECT'); END;
END $$;
RESET ROLE;

-- ══ 4. Certificado (público) por su RPC; estado por la suya ═════════════════
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000ee01","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert((public.save_arca_certificate_legacy('00000000-0000-4000-8000-00000000bb01','-----BEGIN CERTIFICATE-----NEW-----END CERTIFICATE-----')->>'success')='true','A9 cert RPC ok');
SELECT pg_temp.assert((public.set_arca_estado_conexion('00000000-0000-4000-8000-00000000bb01','error','boom')->>'success')='true','A10 estado RPC ok');
RESET ROLE;
SELECT pg_temp.assert((SELECT private_key LIKE '%SYNKEY%' FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-00000000bb01'),'A11 cert/estado RPC no tocaron private_key');

-- ══ 5. Retornos sin secretos + contrato tipado (no mass-assignment) ═════════
SELECT pg_temp.assert(pg_get_function_result('public.save_arca_config_legacy(uuid,text,text,text,integer,text,text,timestamptz)'::regprocedure)='jsonb'
  AND (SELECT prosrc FROM pg_proc WHERE oid='public.save_arca_config_legacy(uuid,text,text,text,integer,text,text,timestamptz)'::regprocedure) NOT ILIKE '%private_key%',
  'A12 config RPC tipada, sin private_key en el cuerpo');
SELECT pg_temp.assert(NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='save_arca_config_legacy' AND pg_get_function_arguments(p.oid) ILIKE '%private_key%'),
  'A13 config RPC no tiene parámetro private_key/cert (allowlist tipada)');

-- ══ 6. Semántica de NULL: omitir preserva; '' (no-null) sí aplica ═══════════
-- Restaura el cuit/alias conocidos como OWNER (SELECT sigue revocado desde §3;
-- la RPC funciona igual). Verificamos leyendo como postgres (RESET ROLE).
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000ee01","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT public.save_arca_config_legacy('00000000-0000-4000-8000-00000000bb01', p_cuit=>'20111111112', p_alias=>'base');
-- Omitir p_cuit (NULL) en un save posterior NO debe borrar el cuit existente.
SELECT public.save_arca_config_legacy('00000000-0000-4000-8000-00000000bb01', p_punto_venta=>3);
RESET ROLE;
SELECT pg_temp.assert((SELECT cuit FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-00000000bb01')='20111111112',
  'A14 omitir p_cuit (NULL) PRESERVA el cuit existente');
-- alias es NOT NULL: "vaciar" es '' (string vacío, no NULL) y COALESCE('',x)='' lo aplica.
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000ee01","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT public.save_arca_config_legacy('00000000-0000-4000-8000-00000000bb01', p_alias=>'');
RESET ROLE;
SELECT pg_temp.assert((SELECT alias FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-00000000bb01')='',
  'A15 alias='''' (no-null) se aplica: vaciado vía string vacío');
-- El vaciado de alias NO tocó secretos.
SELECT pg_temp.assert((SELECT private_key LIKE '%SYNKEY%' AND cert_file IS NOT NULL FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-00000000bb01'),
  'A16 vaciar alias no afecta secretos');

ROLLBACK;
