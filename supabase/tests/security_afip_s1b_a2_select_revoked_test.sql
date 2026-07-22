-- ============================================================================
-- AFIP-S1B-A2 — GATE PRINCIPAL: el conjunto de RPC que usa el frontend funciona
-- aunque `authenticated` NO tenga SELECT sobre arca_config, y el acceso directo
-- (SELECT/UPDATE) falla. Es el prerequisito para S1B-B (revocar SELECT).
-- Datos SINTÉTICOS. tx + ROLLBACK. RUN: psql -X -f
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at, raw_user_meta_data, raw_app_meta_data)
VALUES ('00000000-0000-0000-0000-000000000000','00000000-0000-4000-8000-0000000a2001','authenticated','authenticated','o2@t.local','x',now(),now(),'{}','{}')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.businesses (id, name, owner_user_id, subscription_plan, subscription_status) VALUES
  ('00000000-0000-4000-8000-0000000a2b01','B-A2','00000000-0000-4000-8000-0000000a2001','pro','active')
ON CONFLICT (id) DO UPDATE SET subscription_plan='pro', subscription_status='active';
INSERT INTO public.profiles (id, user_id, business_id, role, is_active) VALUES
  ('00000000-0000-4000-8000-0000000a2001','00000000-0000-4000-8000-0000000a2001','00000000-0000-4000-8000-0000000a2b01','owner',true)
ON CONFLICT (id) DO UPDATE SET business_id=EXCLUDED.business_id, role=EXCLUDED.role, is_active=true;

INSERT INTO public.arca_config (business_id, cuit, cuit_emisor, ambiente, punto_venta, web_service, alias, cert_file, private_key, wsaa_token, wsaa_sign, estado_conexion)
VALUES ('00000000-0000-4000-8000-0000000a2b01','20111111112','20111111112','homologacion',1,'wsfe','a2',
        '-----BEGIN CERTIFICATE-----SYNCERT2-----END CERTIFICATE-----','-----BEGIN PRIVATE KEY-----SYNKEY2-----END PRIVATE KEY-----','tok2','sig2','desconectado')
ON CONFLICT (business_id) DO NOTHING;

-- ══ Revocar SELECT (simula el estado post S1B-B) ════════════════════════════
REVOKE SELECT ON TABLE public.arca_config FROM authenticated;

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000a2001","role":"authenticated"}';
SET LOCAL ROLE authenticated;

-- 1. get_arca_config_safe funciona sin SELECT y NO devuelve secretos
SELECT pg_temp.assert(
  (public.get_arca_config_safe('00000000-0000-4000-8000-0000000a2b01') ? 'has_certificate'),
  'B1 get_arca_config_safe funciona con SELECT revocado');
-- No debe filtrar el MATERIAL de la clave (SYNKEY2 / header PEM). El flag de
-- presencia has_private_key_configured sí puede aparecer (es un booleano, no el secreto).
SELECT pg_temp.assert(
  (public.get_arca_config_safe('00000000-0000-4000-8000-0000000a2b01')::text NOT ILIKE '%SYNKEY2%'
   AND public.get_arca_config_safe('00000000-0000-4000-8000-0000000a2b01')::text NOT ILIKE '%BEGIN PRIVATE KEY%'),
  'B2 lectura segura no filtra el material de la clave privada');

-- 2. save_arca_config_legacy funciona sin SELECT
SELECT pg_temp.assert((public.save_arca_config_legacy('00000000-0000-4000-8000-0000000a2b01', p_punto_venta=>5)->>'success')='true',
  'B3 save_arca_config_legacy funciona con SELECT revocado');

-- 3. save_arca_certificate_legacy funciona sin SELECT
SELECT pg_temp.assert((public.save_arca_certificate_legacy('00000000-0000-4000-8000-0000000a2b01','-----BEGIN CERTIFICATE-----NUEVO2-----END CERTIFICATE-----')->>'success')='true',
  'B4 save_arca_certificate_legacy funciona con SELECT revocado');

-- 4. set_arca_estado_conexion funciona sin SELECT
SELECT pg_temp.assert((public.set_arca_estado_conexion('00000000-0000-4000-8000-0000000a2b01','conectado')->>'success')='true',
  'B5 set_arca_estado_conexion funciona con SELECT revocado');

-- 5. El acceso DIRECTO falla sin SELECT (SELECT y UPDATE por WHERE)
DO $$ BEGIN
  BEGIN PERFORM 1 FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000a2b01';
        PERFORM pg_temp.assert(false,'B6 SELECT directo debía fallar sin privilegio');
  EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.assert(true,'B6 SELECT directo denegado sin privilegio'); END;
END $$;
DO $$ BEGIN
  BEGIN UPDATE public.arca_config SET punto_venta=9 WHERE business_id='00000000-0000-4000-8000-0000000a2b01';
        PERFORM pg_temp.assert(false,'B7 UPDATE directo debía fallar sin SELECT');
  EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.assert(true,'B7 UPDATE directo denegado sin SELECT'); END;
END $$;

RESET ROLE;
-- 6. Preservación: la clave privada quedó intacta tras toda la operativa A2
SELECT pg_temp.assert((SELECT private_key LIKE '%SYNKEY2%' AND cert_file LIKE '%NUEVO2%'
                       FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000a2b01'),
  'B8 clave privada preservada; cert público reemplazado por la RPC');

ROLLBACK;
