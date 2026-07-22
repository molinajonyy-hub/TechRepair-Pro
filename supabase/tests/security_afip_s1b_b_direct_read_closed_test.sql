-- ============================================================================
-- AFIP-S1B-B — La lectura directa cliente de arca_config está CERRADA.
-- Datos SINTÉTICOS. tx + ROLLBACK. Corre DESPUÉS de aplicar 20260722170000.
-- RUN: psql -X -v ON_ERROR_STOP=1 -f
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

-- Fixtures sintéticos: owner + manager del negocio B1 (pro), owner del negocio B2.
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at, raw_user_meta_data, raw_app_meta_data)
VALUES ('00000000-0000-0000-0000-000000000000','00000000-0000-4000-8000-0000000b0001','authenticated','authenticated','ob@t.local','x',now(),now(),'{}','{}'),
       ('00000000-0000-0000-0000-000000000000','00000000-0000-4000-8000-0000000b0002','authenticated','authenticated','mb@t.local','x',now(),now(),'{}','{}'),
       ('00000000-0000-0000-0000-000000000000','00000000-0000-4000-8000-0000000b0003','authenticated','authenticated','xb@t.local','x',now(),now(),'{}','{}')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.businesses (id, name, owner_user_id, subscription_plan, subscription_status) VALUES
  ('00000000-0000-4000-8000-0000000bbb01','B1-S1BB','00000000-0000-4000-8000-0000000b0001','pro','active'),
  ('00000000-0000-4000-8000-0000000bbb02','B2-S1BB','00000000-0000-4000-8000-0000000b0003','pro','active')
ON CONFLICT (id) DO UPDATE SET subscription_plan='pro', subscription_status='active';
INSERT INTO public.profiles (id, user_id, business_id, role, is_active) VALUES
  ('00000000-0000-4000-8000-0000000b0001','00000000-0000-4000-8000-0000000b0001','00000000-0000-4000-8000-0000000bbb01','owner',true),
  ('00000000-0000-4000-8000-0000000b0002','00000000-0000-4000-8000-0000000b0002','00000000-0000-4000-8000-0000000bbb01','manager',true),
  ('00000000-0000-4000-8000-0000000b0003','00000000-0000-4000-8000-0000000b0003','00000000-0000-4000-8000-0000000bbb02','owner',true)
ON CONFLICT (id) DO UPDATE SET business_id=EXCLUDED.business_id, role=EXCLUDED.role, is_active=true;

INSERT INTO public.arca_config (business_id, cuit, cuit_emisor, ambiente, punto_venta, web_service, alias, cert_file, private_key, wsaa_token, wsaa_sign, estado_conexion)
VALUES ('00000000-0000-4000-8000-0000000bbb01','20111111112','20111111112','homologacion',1,'wsfe','b1',
        '-----BEGIN CERTIFICATE-----SYNCERTB-----END CERTIFICATE-----','-----BEGIN PRIVATE KEY-----SYNKEYB-----END PRIVATE KEY-----','tokB','sigB','conectado')
ON CONFLICT (business_id) DO NOTHING;

-- ══ Estado del catálogo ═════════════════════════════════════════════════════
-- C6. la policy histórica no existe
SELECT pg_temp.assert(NOT EXISTS (SELECT 1 FROM pg_policies
  WHERE schemaname='public' AND tablename='arca_config' AND policyname='arca_config_plan_read'),
  'C6 arca_config_plan_read eliminada');
-- C7. RLS sigue habilitada
SELECT pg_temp.assert((SELECT relrowsecurity FROM pg_class WHERE oid='public.arca_config'::regclass),
  'C7 RLS habilitada');
-- C5. ninguna columna legible para anon/authenticated (dinámico, todas)
SELECT pg_temp.assert(NOT EXISTS (
  SELECT 1 FROM pg_attribute a
  WHERE a.attrelid='public.arca_config'::regclass AND a.attnum>0 AND NOT a.attisdropped
    AND (has_column_privilege('anon','public.arca_config',a.attname,'SELECT')
      OR has_column_privilege('authenticated','public.arca_config',a.attname,'SELECT'))),
  'C5 cero columnas con SELECT efectivo para anon/authenticated');
-- C8. service_role conserva SELECT (y postgres intacto)
SELECT pg_temp.assert(has_table_privilege('service_role','public.arca_config','SELECT')
  AND has_table_privilege('postgres','public.arca_config','SELECT'),
  'C8 service_role/postgres conservan SELECT');

-- ══ Denegaciones directas ═══════════════════════════════════════════════════
-- C1. anon
SET LOCAL ROLE anon;
DO $$ BEGIN
  BEGIN PERFORM 1 FROM public.arca_config;
        PERFORM pg_temp.assert(false,'C1 anon debía ser denegado');
  EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.assert(true,'C1 anon sin SELECT directo'); END;
END $$;
RESET ROLE;
-- C2. authenticated OWNER (el caso históricamente permitido por la policy)
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000b0001","role":"authenticated"}';
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  BEGIN PERFORM 1 FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000bbb01';
        PERFORM pg_temp.assert(false,'C2 owner debía ser denegado');
  EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.assert(true,'C2 owner sin SELECT directo'); END;
END $$;
RESET ROLE;
-- C3. manager
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000b0002","role":"authenticated"}';
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  BEGIN PERFORM 1 FROM public.arca_config;
        PERFORM pg_temp.assert(false,'C3 manager debía ser denegado');
  EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.assert(true,'C3 manager sin SELECT directo'); END;
END $$;
RESET ROLE;
-- C4. cross-tenant
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000b0003","role":"authenticated"}';
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  BEGIN PERFORM 1 FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000bbb01';
        PERFORM pg_temp.assert(false,'C4 cross-tenant debía ser denegado');
  EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.assert(true,'C4 cross-tenant sin SELECT directo'); END;
END $$;
RESET ROLE;

-- ══ Server-side preservado ══════════════════════════════════════════════════
-- C9. service_role: SELECT y el write de cache WSAA siguen funcionando
SET LOCAL ROLE service_role;
SELECT pg_temp.assert((SELECT count(*) FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000bbb01')=1,
  'C9a service_role puede SELECT');
UPDATE public.arca_config SET wsaa_token='tokB2', wsaa_sign='sigB2' WHERE business_id='00000000-0000-4000-8000-0000000bbb01';
SELECT pg_temp.assert((SELECT wsaa_token='tokB2' FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000bbb01'),
  'C9b service_role puede UPDATE (cache WSAA)');
RESET ROLE;

-- ══ RPC seguras operativas sin SELECT cliente ═══════════════════════════════
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000b0001","role":"authenticated"}';
SET LOCAL ROLE authenticated;
-- C10-C12. lectura segura funciona y no filtra secretos
SELECT pg_temp.assert((public.get_arca_config_safe('00000000-0000-4000-8000-0000000bbb01') ? 'has_certificate'),
  'C10 get_arca_config_safe funciona para owner');
SELECT pg_temp.assert((public.get_arca_config_safe('00000000-0000-4000-8000-0000000bbb01')::text NOT ILIKE '%SYNKEYB%'
  AND public.get_arca_config_safe('00000000-0000-4000-8000-0000000bbb01')::text NOT ILIKE '%BEGIN PRIVATE KEY%'),
  'C11 lectura segura no filtra la clave privada');
SELECT pg_temp.assert((public.get_arca_config_safe('00000000-0000-4000-8000-0000000bbb01')::text NOT ILIKE '%SYNCERTB%'),
  'C12 lectura segura no filtra el PEM del certificado');
-- C13-C15. las 3 RPC de escritura funcionan
SELECT pg_temp.assert((public.save_arca_config_legacy('00000000-0000-4000-8000-0000000bbb01', p_punto_venta=>4)->>'success')='true',
  'C13 save_arca_config_legacy funciona sin SELECT');
SELECT pg_temp.assert((public.save_arca_certificate_legacy('00000000-0000-4000-8000-0000000bbb01','-----BEGIN CERTIFICATE-----NUEVOB-----END CERTIFICATE-----')->>'success')='true',
  'C14 save_arca_certificate_legacy funciona sin SELECT');
SELECT pg_temp.assert((public.set_arca_estado_conexion('00000000-0000-4000-8000-0000000bbb01','error','fallo sintetico')->>'success')='true',
  'C15 set_arca_estado_conexion funciona sin SELECT');
RESET ROLE;
-- C16. manager NO puede escribir por RPC
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000b0002","role":"authenticated"}';
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  BEGIN PERFORM public.save_arca_config_legacy('00000000-0000-4000-8000-0000000bbb01', p_punto_venta=>9);
        PERFORM pg_temp.assert(false,'C16 manager debía ser denegado en la RPC');
  EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.assert(true,'C16 manager denegado en la RPC de escritura'); END;
END $$;
RESET ROLE;

-- ══ Integridad de datos tras toda la operativa ══════════════════════════════
-- C17. la clave privada quedó preservada (ninguna RPC la toca)
SELECT pg_temp.assert((SELECT private_key LIKE '%SYNKEYB%' FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000bbb01'),
  'C17 private_key preservada');
-- C18. el cert solo cambió por el reemplazo EXPLÍCITO de C14
SELECT pg_temp.assert((SELECT cert_file LIKE '%NUEVOB%' FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000bbb01'),
  'C18 cert_file = el reemplazo explícito (sin borrados implícitos)');
-- C19. las escrituras RPC no duplicaron business_id
SELECT pg_temp.assert((SELECT count(*) FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000bbb01')=1,
  'C19 sin duplicados de business_id tras las RPC');
-- C20. (estructural) todo corrió sobre fixtures sintéticos y termina en ROLLBACK
SELECT pg_temp.assert(true, 'C20 suite sintética con rollback');

ROLLBACK;
