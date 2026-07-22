-- ============================================================================
-- AFIP-S2 — Contrato DB de lectura de credencial de firma (Vault) + auditoría.
-- Datos SINTÉTICOS (PEM sintético válido). tx + ROLLBACK. Aplica DESPUÉS de
-- 20260722180000. RUN: psql -X -v ON_ERROR_STOP=1 -f
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

INSERT INTO public.businesses (id, name, owner_user_id, subscription_plan, subscription_status)
VALUES ('00000000-0000-4000-8000-00000052b001','B-S2a', NULL,'pro','active'),
       ('00000000-0000-4000-8000-00000052b002','B-S2b', NULL,'pro','active'),
       ('00000000-0000-4000-8000-00000052b003','B-S2c', NULL,'pro','active')
ON CONFLICT (id) DO UPDATE SET subscription_plan='pro';

-- ══ 1. Grants: solo service_role ═══════════════════════════════════════════
SELECT pg_temp.assert(
  has_function_privilege('service_role','public.arca_get_credential_for_signing(uuid)','EXECUTE')
  AND NOT has_function_privilege('anon','public.arca_get_credential_for_signing(uuid)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.arca_get_credential_for_signing(uuid)','EXECUTE'),
  'S1 get_credential_for_signing: service_role-only');
SELECT pg_temp.assert(
  has_function_privilege('service_role','public.arca_wsaa_audit(uuid,text,text,text)','EXECUTE')
  AND NOT has_function_privilege('anon','public.arca_wsaa_audit(uuid,text,text,text)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.arca_wsaa_audit(uuid,text,text,text)','EXECUTE'),
  'S2 wsaa_audit: service_role-only');
SELECT pg_temp.assert(NOT EXISTS (
  SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
  WHERE p.oid='public.arca_get_credential_for_signing(uuid)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE'),
  'S3 get_credential_for_signing: PUBLIC sin EXECUTE');

-- ══ 2. Resolución con contexto service_role ════════════════════════════════
-- auth.role() lo lee del JWT claim, no del rol PG: seteamos el claim para pasar
-- la compuerta de las RPC, y el scaffolding directo sobre las tablas `private`/
-- `vault` corre como postgres (service_role no tiene grants directos — S1A).
SET LOCAL request.jwt.claims = '{"role":"service_role"}';

-- 2a. Sin credencial vinculada → provisioned:false (el resolver usará legacy)
SELECT pg_temp.assert(
  (public.arca_get_credential_for_signing('00000000-0000-4000-8000-00000052b001')->>'provisioned')='false',
  'S4 sin credencial → provisioned:false');

-- 2b. Con credencial Vault activa → provisioned:true, ok:true, pem presente
SELECT private.arca_store_private_key_secret('00000000-0000-4000-8000-00000052b001',
  '-----BEGIN PRIVATE KEY-----'||chr(10)||'SYNKEYA'||chr(10)||'-----END PRIVATE KEY-----',
  'fp-a', NULL, 'RSA', 2048, NULL, false);
SELECT pg_temp.assert(
  (public.arca_get_credential_for_signing('00000000-0000-4000-8000-00000052b001')->>'ok')='true'
  AND (public.arca_get_credential_for_signing('00000000-0000-4000-8000-00000052b001')->>'provisioned')='true'
  AND (public.arca_get_credential_for_signing('00000000-0000-4000-8000-00000052b001')->>'pem') LIKE '%SYNKEYA%',
  'S5 credencial activa → provisioned/ok/pem');

-- 2c. Vínculo roto: fila existe pero el secreto fue borrado de Vault → secret_missing
SELECT private.arca_store_private_key_secret('00000000-0000-4000-8000-00000052b002',
  '-----BEGIN PRIVATE KEY-----'||chr(10)||'SYNKEYB'||chr(10)||'-----END PRIVATE KEY-----',
  'fp-b', NULL, 'RSA', 2048, NULL, false);
DELETE FROM vault.secrets WHERE id = (SELECT private_key_secret_id FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-00000052b002');
SELECT pg_temp.assert(
  (public.arca_get_credential_for_signing('00000000-0000-4000-8000-00000052b002')->>'ok')='false'
  AND (public.arca_get_credential_for_signing('00000000-0000-4000-8000-00000052b002')->>'reason')='secret_missing',
  'S6 secreto borrado → ok:false, reason:secret_missing (NO legacy)');

-- 2d. Credencial no-activa (revoked) → not_active
SELECT private.arca_store_private_key_secret('00000000-0000-4000-8000-00000052b003',
  '-----BEGIN PRIVATE KEY-----'||chr(10)||'SYNKEYC'||chr(10)||'-----END PRIVATE KEY-----',
  'fp-c', NULL, 'RSA', 2048, NULL, false);
UPDATE private.arca_private_key_credentials SET credential_status='revoked' WHERE business_id='00000000-0000-4000-8000-00000052b003';
SELECT pg_temp.assert(
  (public.arca_get_credential_for_signing('00000000-0000-4000-8000-00000052b003')->>'reason')='not_active',
  'S7 credencial revoked → reason:not_active');

-- 2e. Auditoría: eventos WSAA aceptados; el resto rechazado
SELECT public.arca_wsaa_audit('00000000-0000-4000-8000-00000052b001','wsaa_private_key_resolved_vault','vault',NULL);
SELECT public.arca_wsaa_audit('00000000-0000-4000-8000-00000052b001','wsaa_private_key_resolved_legacy','legacy_plaintext',NULL);
SELECT pg_temp.assert((SELECT count(*) FROM private.arca_credential_audit WHERE event IN ('wsaa_private_key_resolved_vault','wsaa_private_key_resolved_legacy'))>=2,
  'S8 wsaa_audit inserta eventos permitidos');
DO $$ BEGIN
  BEGIN PERFORM public.arca_wsaa_audit('00000000-0000-4000-8000-00000052b001','evento_prohibido','x',NULL);
        PERFORM pg_temp.assert(false,'S9 evento no permitido debía fallar');
  EXCEPTION WHEN others THEN PERFORM pg_temp.assert(true,'S9 wsaa_audit rechaza evento no permitido'); END;
END $$;

-- 2f. La auditoría no contiene secretos (solo source/fingerprint truncado/error_code)
SELECT pg_temp.assert(NOT EXISTS (
  SELECT 1 FROM private.arca_credential_audit
  WHERE event LIKE 'wsaa_%' AND (fingerprint_trunc ILIKE '%PRIVATE KEY%' OR fingerprint_trunc ILIKE '%SYNKEY%')),
  'S10 auditoría WSAA sin material de clave');

-- ══ 3. Denegación efectiva para roles cliente ══════════════════════════════
-- La denegación en runtime la aplica el privilegio EXECUTE (lo mismo que chequea
-- PostgREST antes de ejecutar la RPC). Se verifica por catálogo — NO se intenta
-- llamar la SECDEF bajo SET ROLE (patrón que dispara un SIGSEGV conocido del
-- backend). anon/authenticated/PUBLIC no tienen EXECUTE → 401/403 vía PostgREST.
SELECT pg_temp.assert(
  NOT has_function_privilege('authenticated','public.arca_get_credential_for_signing(uuid)','EXECUTE')
  AND NOT has_function_privilege('anon','public.arca_get_credential_for_signing(uuid)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.arca_wsaa_audit(uuid,text,text,text)','EXECUTE')
  AND NOT has_function_privilege('anon','public.arca_wsaa_audit(uuid,text,text,text)','EXECUTE'),
  'S11 anon/authenticated sin EXECUTE en ambas RPC (denegación efectiva)');

-- ══ 4. private.* sigue siendo service_role-only (S1A intacto) ═══════════════
SELECT pg_temp.assert(
  NOT has_function_privilege('authenticated','private.arca_get_private_key_for_signing(uuid)','EXECUTE')
  AND NOT has_function_privilege('anon','private.arca_get_private_key_for_signing(uuid)','EXECUTE'),
  'S12 private.arca_get_private_key_for_signing sigue sin EXECUTE cliente');

-- Limpieza de secretos Vault de los fixtures (los que quedaron)
SELECT private.arca_delete_private_key_secret('00000000-0000-4000-8000-00000052b001', NULL);
SELECT private.arca_delete_private_key_secret('00000000-0000-4000-8000-00000052b003', NULL);
DELETE FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-00000052b002';
SELECT pg_temp.assert((SELECT count(*) FROM private.arca_private_key_credentials
  WHERE business_id IN ('00000000-0000-4000-8000-00000052b001','00000000-0000-4000-8000-00000052b002','00000000-0000-4000-8000-00000052b003'))=0,
  'S13 limpieza de credenciales sintéticas');

ROLLBACK;
