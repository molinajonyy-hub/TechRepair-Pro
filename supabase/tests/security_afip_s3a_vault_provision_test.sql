-- ============================================================================
-- AFIP-S3A — Provisionamiento server-side hacia Vault.
-- Fixtures SINTÉTICOS (RSA 1024 generados con node-forge para estos tests; NO
-- son claves reales). tx + ROLLBACK. Corre DESPUÉS de 20260723120000.
-- RUN: psql -X -v ON_ERROR_STOP=1 -f
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

-- Fingerprints canónicos esperados, calculados INDEPENDIENTEMENTE en Deno/node-forge
-- (sha256 del módulo RSA en codificación DER INTEGER). Cross-validan la implementación SQL.
CREATE OR REPLACE FUNCTION pg_temp.fp_a() RETURNS text LANGUAGE sql IMMUTABLE AS
$$ SELECT 'a1e046a1d63dd9c3dc1a4374ce655774b2b44160186e17c4289995265e901c7b' $$;
CREATE OR REPLACE FUNCTION pg_temp.fp_b() RETURNS text LANGUAGE sql IMMUTABLE AS
$$ SELECT 'f4ca8332240e3d854c5cb98d427eb3a2f3050fb9f0617cffbde7552bc6e387e9' $$;

CREATE OR REPLACE FUNCTION pg_temp.key_a() RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT $pem$-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQDMxn7XxB5qQKGO5sRmTWX/75taLaeWGm2/7/cfRswPptsZ5v4r
xG/fBPaowaVCYYnQDW3YfXje3ZIGu/ThSb3yNaDN/VGvEfPbv5ZCY4SDQluIgwr0
NTvsGjxnDpXhUC1vdgBb43YktHkG78ccaVUFk0rd0uiJSfEZvnLFLkin6wIDAQAB
AoGASTyouuSCeD/bSC+SiIAf/dQlPLBdYprbK61YNdBtRR/I9s+dkeu0kw/EZAC1
6TLXRhi3c5kUdKjMBCqO31AvZV/sY90Nek9+Sdfj1VSvMl64pN9nmYZVG4q2P2W0
vW1XUlKycG50SMbiqFuBjmQlN1CrKirnnNvKHzRvit1FhSkCQQDYSwdoTOU/wEDU
wZVWtDHYc+z053XPihFnpZ2yHAdRXsoutihP2lmW7N/s4s4/w8RFu3nI9DEZkuxI
hxwZL0k/AkEA8l4tUfnXMJ2OM8KhZs4UE6oqQtkucv2kqF5MBW/0bPU/XYpd21B7
4reNuwmBtNZznynwO4VQeUAZOiAjIy8qVQJBAI9GA/4fEayNGWTVZqssaehLwibo
O63ic20I09DrqB1KgPs4RrO+m6HR/vLXum+aqiTW7vEicHPUUxgoB4DXRdkCQB9B
zg54biwy5Zf/Tdl4UlaG55RfdgIWfBnKr3s0CQ3UQyvJIHmcU53Vlk282CF+VsL8
IaNLeilo/tfkNSPgfVECQQCh2bc5rFh3+8Idwr/d7lgL50jrDcLWvg0lyc7bXpsJ
/+4Tl6hfZjBVTBj1wmJxHCnx7GXLpZjurU0QbDrtRq54
-----END RSA PRIVATE KEY-----$pem$ $fn$;

CREATE OR REPLACE FUNCTION pg_temp.cert_a() RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT $pem$-----BEGIN CERTIFICATE-----
MIIBpDCCAQ2gAwIBAgIBATANBgkqhkiG9w0BAQsFADAYMRYwFAYDVQQDEw1zM2Et
Zml4dHVyZS1BMB4XDTIwMDEwMTAzMDAwMFoXDTM1MDEwMTAzMDAwMFowGDEWMBQG
A1UEAxMNczNhLWZpeHR1cmUtQTCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEA
zMZ+18QeakChjubEZk1l/++bWi2nlhptv+/3H0bMD6bbGeb+K8Rv3wT2qMGlQmGJ
0A1t2H143t2SBrv04Um98jWgzf1RrxHz27+WQmOEg0JbiIMK9DU77Bo8Zw6V4VAt
b3YAW+N2JLR5Bu/HHGlVBZNK3dLoiUnxGb5yxS5Ip+sCAwEAATANBgkqhkiG9w0B
AQsFAAOBgQCH4pmVtz1iLJaN+9gaTMZ689GTacxLFVq7lRJrf6NQ3/vykVkJa3BX
sFE0aJgJJTsicEbXT0nT2cRnnsg8iDsnVcqAlbVD6uR447nGtT/JSWbun0DRcu3h
n1PcYZetBrj1kdmjLVBJbCrv85SruEVSMR0GzCqtUpTtwz7HRCqNTQ==
-----END CERTIFICATE-----$pem$ $fn$;

CREATE OR REPLACE FUNCTION pg_temp.key_b() RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT $pem$-----BEGIN RSA PRIVATE KEY-----
MIICXAIBAAKBgQDR9v/mLKMAxBlvwhfkpbe2NDF7mGhYgEH4tfhkHB7t8ISNrnJa
GYiuPA3VAzl222a0WtnOF3z8+q4L4dBt42a7Y3vTHLaFV44tQrHs8JNAmkTYyh3C
xfxYnXLtZiM1SkM86ylSBFqcs1z1jST5juAF3AdJOL6w6xVwmGs6SlWh7QIDAQAB
AoGAbSLXNrxC6fYERrv7kWS2DiYpBlZc/ouEPxPPDbI0PXeEXuSrGbwl+HLMuckY
SHiYdOy4Q9Cfrhta9mAk58mIrrJnAd9odEY1GGO5IbtoMh/2A7paGxsBLKPxtUux
veNKkQlpHwyRmnEFirJ+NsLs1W/uPe6q0/X3nA9TJsQpgyECQQD+OpdOWp/cu2kW
6p5Y2No0Aq4bjUYrGtB5cO2fafHosYajA+SgqVblZQ5+Phd4JUnJkd3Fq1Pd1zTW
JUh32MVJAkEA0213EQ1zAXHuMk4hiTO74cRls8niGjTPBYv1YUNFyw/dWF638tGx
R7COjaLil1wntFAGoNvtg9VvmSBzjVULhQJAF9Np5r/7h3ZQ7QLkADOij4lIw/BD
iTqkGx2IR45oS4SHt7Nfs+bq6+jCqPYswOfNuIRhImtiGsJWg1NPLVw1cQJASpPJ
NQWmdHMIj0wJ/kh2VGufaCylCZNpFs7IjjdZjggZjotSnV8kBmKb1hAHl1ZVVwAH
ZoRNInyN8diFievetQJBANfN0EuSF6JFJLhzIojm+bKUjxwBmQD9GbflY6fXSEkR
lihH9tOOtgxc8uCkKobUWeU7FRZB5XK8UN1SATGkIBg=
-----END RSA PRIVATE KEY-----$pem$ $fn$;

-- Negocios sintéticos
INSERT INTO public.businesses (id, name, owner_user_id, subscription_plan, subscription_status) VALUES
  ('00000000-0000-4000-8000-000000053a01','S3A-ok',   NULL,'pro','active'),
  ('00000000-0000-4000-8000-000000053a02','S3A-mism', NULL,'pro','active'),
  ('00000000-0000-4000-8000-000000053a03','S3A-nokey',NULL,'pro','active'),
  ('00000000-0000-4000-8000-000000053a04','S3A-bad',  NULL,'pro','active')
ON CONFLICT (id) DO UPDATE SET subscription_plan='pro';

INSERT INTO public.arca_config (business_id, cuit, ambiente, punto_venta, web_service, alias, cert_file, private_key, wsaa_token, wsaa_sign, estado_conexion) VALUES
  ('00000000-0000-4000-8000-000000053a01','20111111112','homologacion',1,'wsfe','a', pg_temp.cert_a(), pg_temp.key_a(), 'tokA','sigA','conectado'),
  ('00000000-0000-4000-8000-000000053a02','20111111112','homologacion',1,'wsfe','b', pg_temp.cert_a(), pg_temp.key_b(), 'tokB','sigB','conectado'),
  ('00000000-0000-4000-8000-000000053a03','20111111112','homologacion',1,'wsfe','c', pg_temp.cert_a(), NULL,            'tokC','sigC','conectado'),
  ('00000000-0000-4000-8000-000000053a04','20111111112','homologacion',1,'wsfe','d', pg_temp.cert_a(), 'no-es-una-clave','tokD','sigD','conectado')
ON CONFLICT (business_id) DO NOTHING;

-- Contexto service_role (auth.role() lo lee del claim; el scaffolding corre como postgres)
SET LOCAL request.jwt.claims = '{"role":"service_role"}';

-- ══ Grants (12-15) ═════════════════════════════════════════════════════════
SELECT pg_temp.assert(has_function_privilege('service_role','public.arca_migrate_legacy_private_key_to_vault(uuid,text,text)','EXECUTE'),
  'T12 service_role puede ejecutar');
SELECT pg_temp.assert(NOT has_function_privilege('anon','public.arca_migrate_legacy_private_key_to_vault(uuid,text,text)','EXECUTE'),
  'T13 anon no puede');
SELECT pg_temp.assert(NOT has_function_privilege('authenticated','public.arca_migrate_legacy_private_key_to_vault(uuid,text,text)','EXECUTE'),
  'T14 authenticated no puede');
SELECT pg_temp.assert(NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
  WHERE p.oid='public.arca_migrate_legacy_private_key_to_vault(uuid,text,text)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE'),
  'T15 PUBLIC no puede');

-- ══ Fingerprint canónico (2) + estabilidad ═════════════════════════════════
SELECT pg_temp.assert(private.arca_key_fingerprint(pg_temp.key_a()) = pg_temp.fp_a(),
  'T2 fingerprint SQL == fingerprint calculado en Deno (cross-validación)');
SELECT pg_temp.assert(
  private.arca_key_fingerprint(replace(pg_temp.key_a(), E'\n', E'\r\n')) = pg_temp.fp_a()
  AND private.arca_key_fingerprint('  ' || pg_temp.key_a() || E'\n\n') = pg_temp.fp_a(),
  'T2b fingerprint estable ante CRLF y espacios');
SELECT pg_temp.assert(private.arca_key_matches_certificate(pg_temp.key_a(), pg_temp.cert_a()),
  'T2c correspondencia criptográfica clave↔cert (igualdad de módulo)');
SELECT pg_temp.assert(NOT private.arca_key_matches_certificate(pg_temp.key_b(), pg_temp.cert_a()),
  'T2d clave distinta NO corresponde al certificado');

-- ══ 1. Migración correcta ══════════════════════════════════════════════════
SELECT pg_temp.assert(
  (public.arca_migrate_legacy_private_key_to_vault('00000000-0000-4000-8000-000000053a01', pg_temp.fp_a(), 'idem-ok-1')->>'state')='MIGRATED',
  'T1 migración correcta → MIGRATED');

-- ══ 10. Secreto creado y legible por el contrato de firma ══════════════════
SELECT pg_temp.assert((SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-000000053a01')=1,
  'T10a credencial vinculada');
SELECT pg_temp.assert(private.arca_key_fingerprint(private.arca_get_private_key_for_signing('00000000-0000-4000-8000-000000053a01')) = pg_temp.fp_a(),
  'T10b readback por el contrato de firma coincide con el fingerprint');

-- ══ 16-17. El retorno no expone material ═══════════════════════════════════
SELECT pg_temp.assert(
  NOT (public.arca_migrate_legacy_private_key_to_vault('00000000-0000-4000-8000-000000053a01', pg_temp.fp_a(), 'idem-ok-1')::text ~* 'BEGIN|PRIVATE KEY|MII'),
  'T17 el retorno no contiene PEM');
SELECT pg_temp.assert(
  NOT (public.arca_migrate_legacy_private_key_to_vault('00000000-0000-4000-8000-000000053a01', pg_temp.fp_a(), 'idem-ok-1') ? 'secret_id'),
  'T16 el retorno no contiene secret_id');

-- ══ 8. Idempotencia: replay ════════════════════════════════════════════════
SELECT pg_temp.assert(
  (public.arca_migrate_legacy_private_key_to_vault('00000000-0000-4000-8000-000000053a01', pg_temp.fp_a(), 'idem-ok-1')->>'state') IN ('MIGRATED','ALREADY_MIGRATED'),
  'T8 replay con misma key+payload devuelve el mismo resultado');
SELECT pg_temp.assert((SELECT count(*) FROM vault.secrets WHERE name LIKE 'arca-private-key:00000000-0000-4000-8000-000000053a01%')=1,
  'T8b el replay NO creó un segundo secreto');

-- ══ 9. Idempotencia: conflicto ═════════════════════════════════════════════
SELECT pg_temp.assert(
  (public.arca_migrate_legacy_private_key_to_vault('00000000-0000-4000-8000-000000053a01', pg_temp.fp_b(), 'idem-ok-1')->>'state')='IDEMPOTENCY_CONFLICT',
  'T9 misma key + payload distinto → IDEMPOTENCY_CONFLICT');

-- ══ 7. Credencial activa conflictiva (otro fingerprint, otra key) ══════════
SELECT pg_temp.assert(
  (public.arca_migrate_legacy_private_key_to_vault('00000000-0000-4000-8000-000000053a01', pg_temp.fp_b(), 'idem-otra')->>'state')
    IN ('ACTIVE_CREDENTIAL_CONFLICT','FINGERPRINT_MISMATCH'),
  'T7 credencial activa con otro fingerprint → conflicto');

-- ══ 3. Fingerprint incorrecto → sin credencial ═════════════════════════════
SELECT pg_temp.assert(
  (public.arca_migrate_legacy_private_key_to_vault('00000000-0000-4000-8000-000000053a02', pg_temp.fp_a(), 'idem-fp')->>'state')='FINGERPRINT_MISMATCH',
  'T3 fingerprint incorrecto → FINGERPRINT_MISMATCH');
SELECT pg_temp.assert((SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-000000053a02')=0,
  'T3b sin credencial tras el fallo');

-- ══ 6. Certificado no corresponde ══════════════════════════════════════════
SELECT pg_temp.assert(
  (public.arca_migrate_legacy_private_key_to_vault('00000000-0000-4000-8000-000000053a02', pg_temp.fp_b(), 'idem-cert')->>'state')='CERTIFICATE_KEY_MISMATCH',
  'T6 clave que no corresponde al certificado → CERTIFICATE_KEY_MISMATCH');
SELECT pg_temp.assert((SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-000000053a02')=0,
  'T6b sin credencial tras el fallo de correspondencia');

-- ══ 4-5. Clave faltante / inválida ═════════════════════════════════════════
SELECT pg_temp.assert(
  (public.arca_migrate_legacy_private_key_to_vault('00000000-0000-4000-8000-000000053a03','deadbeef','idem-nokey')->>'state')='LEGACY_KEY_MISSING',
  'T4 clave faltante → LEGACY_KEY_MISSING');
SELECT pg_temp.assert(
  (public.arca_migrate_legacy_private_key_to_vault('00000000-0000-4000-8000-000000053a04','deadbeef','idem-bad')->>'state')='LEGACY_KEY_INVALID',
  'T5 clave inválida → LEGACY_KEY_INVALID');

-- ══ 11. Sin huérfanos: cada secreto ARCA tiene su vínculo ══════════════════
SELECT pg_temp.assert(
  (SELECT count(*) FROM vault.secrets s WHERE s.name LIKE 'arca-private-key:%')
  = (SELECT count(*) FROM private.arca_private_key_credentials),
  'T11 sin secretos huérfanos (secretos == vínculos)');

-- ══ 18-20. Los datos legacy quedan intactos ════════════════════════════════
SELECT pg_temp.assert((SELECT private_key = pg_temp.key_a() FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-000000053a01'),
  'T18 private_key legacy INTACTA tras migrar');
SELECT pg_temp.assert((SELECT cert_file = pg_temp.cert_a() FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-000000053a01'),
  'T19 cert_file intacto');
SELECT pg_temp.assert((SELECT wsaa_token='tokA' AND wsaa_sign='sigA' FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-000000053a01'),
  'T20 token/sign intactos');

-- ══ 21. Auditoría sin secretos ═════════════════════════════════════════════
SELECT pg_temp.assert((SELECT count(*) FROM private.arca_credential_audit WHERE event LIKE 'arca_private_key_vault_%')>=2,
  'T21a se auditaron eventos de provisión');
SELECT pg_temp.assert(NOT EXISTS (
  SELECT 1 FROM private.arca_credential_audit
   WHERE coalesce(fingerprint_trunc,'')||coalesce(status,'')||coalesce(error_code,'') ~* 'BEGIN|PRIVATE KEY|MII'),
  'T21b la auditoría no contiene material de clave');
SELECT pg_temp.assert(NOT EXISTS (
  SELECT 1 FROM private.arca_credential_provision_requests WHERE result::text ~* 'BEGIN|PRIVATE KEY|MII'),
  'T21c las solicitudes registradas no contienen material');

-- ══ Integración con el resolver S2 (16) ════════════════════════════════════
SELECT pg_temp.assert((public.arca_get_credential_for_signing('00000000-0000-4000-8000-000000053a01')->>'provisioned')='true'
  AND (public.arca_get_credential_for_signing('00000000-0000-4000-8000-000000053a01')->>'ok')='true',
  'T16a tras provisionar: provisioned=true, ok=true (el resolver usará vault)');
SELECT pg_temp.assert((public.arca_get_credential_for_signing('00000000-0000-4000-8000-000000053a02')->>'provisioned')='false',
  'T16b negocio sin provisionar: provisioned=false (legacy permitido)');
-- Romper el secreto vinculado → provisioned=true pero ok=false (sin fallback legacy)
DELETE FROM vault.secrets WHERE id=(SELECT private_key_secret_id FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-000000053a01');
SELECT pg_temp.assert((public.arca_get_credential_for_signing('00000000-0000-4000-8000-000000053a01')->>'provisioned')='true'
  AND (public.arca_get_credential_for_signing('00000000-0000-4000-8000-000000053a01')->>'reason')='secret_missing',
  'T16c secreto roto → provisioned=true + secret_missing (el resolver FALLA, no cae a legacy)');

-- ══ 22. Limpieza completa ══════════════════════════════════════════════════
DELETE FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-000000053a01';
SELECT pg_temp.assert((SELECT count(*) FROM private.arca_private_key_credentials
   WHERE business_id IN ('00000000-0000-4000-8000-000000053a01','00000000-0000-4000-8000-000000053a02',
                         '00000000-0000-4000-8000-000000053a03','00000000-0000-4000-8000-000000053a04'))=0,
  'T22 limpieza de credenciales sintéticas');
SELECT pg_temp.assert((SELECT count(*) FROM vault.secrets WHERE name LIKE 'arca-private-key:00000000-0000-4000-8000-000000053a%')=0,
  'T22b limpieza de secretos Vault sintéticos');

ROLLBACK;
