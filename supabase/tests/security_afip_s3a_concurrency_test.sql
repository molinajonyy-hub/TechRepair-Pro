-- ============================================================================
-- AFIP-S3A — Concurrencia del provisionamiento.
--
-- El advisory lock por negocio + UNIQUE(business_id) en la tabla de credenciales
-- + UNIQUE(business_id, idempotency_key) garantizan que dos invocaciones
-- simultáneas NO puedan crear dos secretos ni dos credenciales activas.
--
-- Nota metodológica: psql es de una sola sesión, así que la carrera REAL entre
-- backends se prueba con dos conexiones (ver harness abajo, sección B). En esta
-- suite se verifican las INVARIANTES estructurales y el comportamiento
-- secuencial equivalente; la sección B la ejecuta el runner de concurrencia.
-- Fixtures SINTÉTICOS. tx + ROLLBACK.
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

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

INSERT INTO public.businesses (id, name, owner_user_id, subscription_plan, subscription_status)
VALUES ('00000000-0000-4000-8000-0000000c0a01','S3A-conc', NULL,'pro','active')
ON CONFLICT (id) DO UPDATE SET subscription_plan='pro';
INSERT INTO public.arca_config (business_id, cuit, ambiente, punto_venta, web_service, alias, cert_file, private_key, estado_conexion)
VALUES ('00000000-0000-4000-8000-0000000c0a01','20111111112','homologacion',1,'wsfe','x', pg_temp.cert_a(), pg_temp.key_a(),'conectado')
ON CONFLICT (business_id) DO NOTHING;

SET LOCAL request.jwt.claims = '{"role":"service_role"}';
\set fpa 'a1e046a1d63dd9c3dc1a4374ce655774b2b44160186e17c4289995265e901c7b'

-- ══ C1. Invariantes estructurales que hacen imposible la doble credencial ══
SELECT pg_temp.assert(EXISTS (
  SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
  WHERE n.nspname='private' AND t.relname='arca_private_key_credentials' AND c.contype='u'
    AND pg_get_constraintdef(c.oid) ILIKE '%business_id%'),
  'C1 UNIQUE(business_id) en arca_private_key_credentials (una credencial por negocio)');
SELECT pg_temp.assert(EXISTS (
  SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
  WHERE n.nspname='private' AND t.relname='arca_credential_provision_requests' AND c.contype='u'
    AND pg_get_constraintdef(c.oid) ILIKE '%business_id%idempotency_key%'),
  'C2 UNIQUE(business_id, idempotency_key) en las solicitudes');
SELECT pg_temp.assert(
  (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='arca_migrate_legacy_private_key_to_vault') ~ 'pg_advisory_xact_lock',
  'C3 la RPC serializa por negocio con advisory lock transaccional');

-- ══ C4. Misma idempotency_key + mismo payload: una sola credencial ════════
SELECT pg_temp.assert(
  (public.arca_migrate_legacy_private_key_to_vault('00000000-0000-4000-8000-0000000c0a01', :'fpa', 'k1')->>'state')='MIGRATED',
  'C4a primera invocación → MIGRATED');
SELECT pg_temp.assert(
  (public.arca_migrate_legacy_private_key_to_vault('00000000-0000-4000-8000-0000000c0a01', :'fpa', 'k1')->>'state') IN ('MIGRATED','ALREADY_MIGRATED'),
  'C4b reintento con misma key → idempotente');
SELECT pg_temp.assert((SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-0000000c0a01')=1,
  'C4c exactamente UNA credencial activa');
SELECT pg_temp.assert((SELECT count(*) FROM vault.secrets WHERE name LIKE 'arca-private-key:00000000-0000-4000-8000-0000000c0a01%')=1,
  'C4d exactamente UN secreto Vault');

-- ══ C5. Distinta idempotency_key + mismo fingerprint → ALREADY_MIGRATED ═══
SELECT pg_temp.assert(
  (public.arca_migrate_legacy_private_key_to_vault('00000000-0000-4000-8000-0000000c0a01', :'fpa', 'k2')->>'state')='ALREADY_MIGRATED',
  'C5a otra key + mismo fingerprint → ALREADY_MIGRATED (éxito idempotente)');
SELECT pg_temp.assert((SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-0000000c0a01')=1
  AND (SELECT count(*) FROM vault.secrets WHERE name LIKE 'arca-private-key:00000000-0000-4000-8000-0000000c0a01%')=1,
  'C5b sigue habiendo UNA credencial y UN secreto');

-- ══ C6. Distinta key + fingerprint distinto → conflicto, sin segundo secreto ══
SELECT pg_temp.assert(
  (public.arca_migrate_legacy_private_key_to_vault('00000000-0000-4000-8000-0000000c0a01','f4ca8332240e3d854c5cb98d427eb3a2f3050fb9f0617cffbde7552bc6e387e9','k3')->>'state')
    IN ('FINGERPRINT_MISMATCH','ACTIVE_CREDENTIAL_CONFLICT'),
  'C6a otra key + otro fingerprint → conflicto explícito');
SELECT pg_temp.assert((SELECT count(*) FROM vault.secrets WHERE name LIKE 'arca-private-key:00000000-0000-4000-8000-0000000c0a01%')=1,
  'C6b NO se creó un segundo secreto');

-- ══ C7. Sin huérfanos ═════════════════════════════════════════════════════
SELECT pg_temp.assert(
  (SELECT count(*) FROM vault.secrets WHERE name LIKE 'arca-private-key:%')
  = (SELECT count(*) FROM private.arca_private_key_credentials),
  'C7 secretos == vínculos (ningún huérfano)');

-- Limpieza
DELETE FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-0000000c0a01';
ROLLBACK;
