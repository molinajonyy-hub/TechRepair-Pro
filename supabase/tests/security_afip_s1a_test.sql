-- ============================================================================
-- AFIP-S1A — Fundaciones seguras: RPC Vault, tabla privada, contrato seguro.
-- Datos SINTÉTICOS. Una tx + ROLLBACK. No deja nada. No usa el patrón
-- SET LOCAL ROLE + PERFORM (SIGSEGV): la authz se prueba por has_*_privilege.
-- RUN: psql -X -f
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

INSERT INTO public.businesses (id, name, owner_user_id)
VALUES ('00000000-0000-4000-8000-0000000000aa','SYN Biz S1A', NULL)
ON CONFLICT (id) DO NOTHING;

-- ══ 1. Roundtrip Vault por las RPC privadas (como owner postgres) ═══════════
DO $$
DECLARE v_biz uuid := '00000000-0000-4000-8000-0000000000aa';
        v_pem text := E'-----BEGIN PRIVATE KEY-----\nSYNTHETIC-S1A-TEST-ONLY\n-----END PRIVATE KEY-----';
        v_sid uuid; v_sid2 uuid;
BEGIN
  v_sid := private.arca_store_private_key_secret(v_biz, v_pem, 'fp_syn_1234567890', 'certfp', 'RSA', 2048, NULL, false);
  PERFORM pg_temp.assert(v_sid IS NOT NULL, 'A1 store devuelve secret_id');
  PERFORM pg_temp.assert((SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id=v_biz)=1, 'A2 fila creada');
  PERFORM pg_temp.assert((SELECT count(*) FROM vault.secrets WHERE id=v_sid)=1, 'A3 secreto en Vault');
  PERFORM pg_temp.assert(md5(private.arca_get_private_key_for_signing(v_biz))=md5(v_pem), 'A4 roundtrip get == pem');
  BEGIN PERFORM private.arca_store_private_key_secret(v_biz, v_pem, 'x', NULL,NULL,NULL,NULL,false);
        PERFORM pg_temp.assert(false, 'A5 store duplicado debía fallar');
  EXCEPTION WHEN unique_violation THEN PERFORM pg_temp.assert(true, 'A5 store duplicado rechazado'); END;
  v_sid2 := private.arca_replace_private_key_secret(v_biz, v_pem||E'\nv2', 'fp_v2_00000000', NULL,NULL,NULL,NULL);
  PERFORM pg_temp.assert(v_sid2 IS DISTINCT FROM v_sid, 'A6 replace rota el secreto');
  PERFORM pg_temp.assert((SELECT count(*) FROM vault.secrets WHERE id=v_sid)=0, 'A7 secreto viejo borrado');
  PERFORM pg_temp.assert(md5(private.arca_get_private_key_for_signing(v_biz))=md5(v_pem||E'\nv2'), 'A8 get devuelve el rotado');
  PERFORM private.arca_delete_private_key_secret(v_biz, NULL);
  PERFORM pg_temp.assert((SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id=v_biz)=0, 'A9 fila borrada');
  PERFORM pg_temp.assert((SELECT count(*) FROM vault.secrets WHERE id=v_sid2)=0, 'A10 secreto borrado');
  PERFORM private.arca_delete_private_key_secret(v_biz, NULL);
  PERFORM pg_temp.assert(true, 'A11 delete idempotente');
END $$;

-- ══ 2. Authz de catálogo (autoritativo para EXECUTE) ════════════════════════
SELECT pg_temp.assert(NOT has_function_privilege('anon','private.arca_get_private_key_for_signing(uuid)','EXECUTE')
   AND NOT has_function_privilege('authenticated','private.arca_get_private_key_for_signing(uuid)','EXECUTE'), 'B1 get privado: sin anon/auth');
SELECT pg_temp.assert(has_function_privilege('service_role','private.arca_get_private_key_for_signing(uuid)','EXECUTE'), 'B2 get privado: service_role sí');
SELECT pg_temp.assert(NOT has_function_privilege('anon','public.arca_store_credential(uuid,text,text,text,text,integer,uuid,boolean,boolean)','EXECUTE')
   AND NOT has_function_privilege('authenticated','public.arca_store_credential(uuid,text,text,text,text,integer,uuid,boolean,boolean)','EXECUTE'), 'B3 wrapper store: sin anon/auth');
SELECT pg_temp.assert(has_function_privilege('service_role','public.arca_store_credential(uuid,text,text,text,text,integer,uuid,boolean,boolean)','EXECUTE'), 'B4 wrapper store: service_role sí');
SELECT pg_temp.assert(has_function_privilege('authenticated','public.get_arca_config_safe(uuid)','EXECUTE')
   AND NOT has_function_privilege('anon','public.get_arca_config_safe(uuid)','EXECUTE'), 'B5 safe: authenticated sí, anon no');
SELECT pg_temp.assert(NOT has_table_privilege('anon','private.arca_private_key_credentials','SELECT')
   AND NOT has_table_privilege('authenticated','private.arca_private_key_credentials','SELECT')
   AND NOT has_table_privilege('service_role','private.arca_private_key_credentials','SELECT'), 'B6 tabla privada: sin SELECT client/service');

-- ══ 3. is_business_owner_or_admin (path negativo, sin FK a auth.users) ═══════
-- El path POSITIVO (owner/admin real) requiere un auth.users válido (FK) y se
-- valida en el smoke de integración de la Edge. Acá se prueba el fail-closed y,
-- por catálogo, que la lógica referencia owner_user_id y profiles.role.
DO $$
DECLARE v_biz uuid := '00000000-0000-4000-8000-0000000000aa';
        v_uid uuid := '00000000-0000-4000-8000-0000000000bb';
BEGIN
  PERFORM pg_temp.assert(public.is_business_owner_or_admin(v_biz, v_uid) = false, 'C1 no-miembro → false (fail-closed)');
  PERFORM pg_temp.assert(public.is_business_owner_or_admin(NULL, v_uid) = false, 'C2 business NULL → false');
END $$;
SELECT pg_temp.assert(
  (SELECT prosrc FROM pg_proc WHERE oid='public.is_business_owner_or_admin(uuid,uuid)'::regprocedure) ILIKE '%owner_user_id%'
  AND (SELECT prosrc FROM pg_proc WHERE oid='public.is_business_owner_or_admin(uuid,uuid)'::regprocedure) ILIKE '%role IN%',
  'C3 valida owner_user_id y profiles.role');

-- ══ 4. El contrato seguro no expone secretos en su definición ═══════════════
SELECT pg_temp.assert((SELECT prosrc FROM pg_proc WHERE oid='public.get_arca_config_safe(uuid)'::regprocedure) NOT ILIKE '%''private_key''%', 'D1 safe no arma private_key en el payload');
SELECT pg_temp.assert((SELECT prosrc FROM pg_proc WHERE oid='public.get_arca_config_safe(uuid)'::regprocedure) NOT ILIKE '%decrypted_secret%', 'D2 safe no toca Vault');

ROLLBACK;
