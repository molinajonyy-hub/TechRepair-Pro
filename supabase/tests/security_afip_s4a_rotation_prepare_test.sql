-- ============================================================================
-- AFIP-S4A / S4B-1b — contrato de preparación de rotación con SUBJECT MÍNIMO.
-- Fixtures SINTÉTICOS embebidos (RSA 1024, node-forge). NUNCA material productivo.
-- Todo dentro de BEGIN…ROLLBACK.
--
-- Modelo S4B-1b: la identidad del CSR se deriva del CERTIFICADO VIGENTE
-- (CN=<alias> + serialNumber=CUIT) y debe replicarse EXACTAMENTE. Sin
-- razon_social obligatoria y sin defaults C/ST/L.
-- RUN: docker exec -i <db> psql -X -U postgres -d postgres -f este.sql
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL request.jwt.claims = '{"role":"service_role"}';

INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-0000000054a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        's4a-owner@test.local', '', now(), now()) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.businesses (id, name, owner_user_id, subscription_plan, subscription_status)
VALUES ('00000000-0000-4000-8000-0000000054a1', 'S4A-test', '00000000-0000-4000-8000-0000000054a2', 'pro', 'active')
ON CONFLICT (id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id;

-- arca_config REALISTA: certificado vigente con subject mínimo, alias, CUIT CON
-- GUIONES (para probar la normalización) y razon_social NULL (no debe bloquear).
-- AFIP-S4C: `private_key` ya no existe; la clave vive sólo en Vault.
INSERT INTO public.arca_config (business_id, cuit, razon_social, alias, ambiente, punto_venta,
        web_service, cert_file, wsaa_token, wsaa_sign, estado_conexion)
VALUES ('00000000-0000-4000-8000-0000000054a1', '20-11111111-2', NULL, 'fixture.alias', 'homologacion', 1, 'wsfe',
        $p$-----BEGIN CERTIFICATE-----
MIIB2jCCAUOgAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCBnzANBgkqhkiG9w0BAQEFAAOBjQAw
gYkCgYEAtdULzqwDVEeen9/aYHNqOty0uDnuno7WBskq9DIyKoh0fXbRpG5uqOXr
9u3g9OuvG4t040dV5yB2maKaRcRK05xc3Vw5f8nO1XjZEJcca484JlpbYP0R9amF
uKCaChr68EeUV55K3FBNmr6YxafS2FB9Sqm4D44jmekcJKkEJGsCAwEAATANBgkq
hkiG9w0BAQsFAAOBgQA7O44tjiUuaeQUab/wNcnkWh4sJqeNt70CGwTTNA2nyrSO
ic/msgA0P9de8+1gtJkDGQEvb4szJfoPWID5Klm8Sbu7c1qrDfyt8giukUpT9g5a
sZFjQHoaJUGB3BH4CSpmjX2ibQO22a31o9wDJGsgAdJlDYi+yHeehPIEzmONiw==
-----END CERTIFICATE-----$p$,
        'DUMMYTOKEN', 'DUMMYSIGN', 'conectado') ON CONFLICT (business_id) DO NOTHING;
-- NOTA: NO se inserta fila en business_settings → queda vacío a propósito.

SELECT private.arca_store_private_key_secret('00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXAIBAAKBgQCtIFCxXEEp328c2k7uQh9r0e9HuFAW6Jnwm76eqiwO+XmEbaO9
cJt8qsy/e2MKJ7xrYBkkexlBtPhTMOssKzi89fENee+Qt2nxgULRy0dEmxAH3MDP
p7sIRza/Cf+2aqkkHIKPLbu7BdyjOOPF50WCi1X1Sbu4Av+m94rhHFaqlQIDAQAB
AoGAUB5pWXsBKRieujKJXpe5JNOVsZIpdkCUpRXeZF0KYK+xPcjjgtLvEgWVFXRL
hDKZbvOdDxXsvUy7svwriVhDO+Q9TEVwmRCL6IFyZ2C5E41UF5jPpIafelFrJSrF
lYxSK2Up0W9a6KUcoIG5wnQbZ1FeogpRPXPvblmRwai+f+ECQQDGSLGFKcyMRxCM
yMidg53QHao2YS+O1cnrlt3XcrjfPZqt7enEE+ababCRIaklEu+bUied7Wp0jCJT
dEN0fpdNAkEA34T4oJ6DMLUW2KX0Y1nRonns1wHYerUBToVC0MziYg3jkW5HHpSc
MRMoJmA9eeL/0SFo/57M3fbYeYMg3x8MaQJBALSPd9A6WwEWqZR6Nm1xcCEXEmwI
ngUk24YEUSmjV4Q6lgNyliAuux2k5duTWnLfRoAbFOZ0Ty+oeI2kXtTTfjUCQAOk
exjC/IhSqyikq7Lix9PKAN4QHaMCSB8rdMdKT3Yhm8/G6EnLSjBSi5j0gIv38wtJ
bBieUeBcIXL5fBOmweECQGqLjcK4Rqcrae1Sq7uQWvO2lPd60Wqolzm3G/9dNQl3
rGItQ1mhrrCUgjsdc/OmSRGqeK6QafsVFbFOKBdbRqQ=
-----END RSA PRIVATE KEY-----$p$, 'af4ab2bc3bc0095c614c7ef2ebcd4795035545b26d8d01f1421df757da146238', NULL, 'RSA', 1024, '00000000-0000-4000-8000-0000000054a2', false) AS s \gset

CREATE TEMP TABLE s4a_pre AS
SELECT (SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-0000000054a1') AS active_cnt,
       (SELECT private_key_fingerprint FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-0000000054a1') AS active_fp,
       -- AFIP-S4C: la huella de configuración ya no incluye la clave en claro.
       (SELECT md5(cert_file||coalesce(wsaa_token,'')||coalesce(wsaa_sign,'')) FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000054a1') AS cfg;

CREATE TEMP TABLE s4a_results (n serial, label text, ok boolean);
CREATE OR REPLACE FUNCTION pg_temp.chk(l text, ok boolean) RETURNS void
LANGUAGE plpgsql AS $f$ BEGIN INSERT INTO s4a_results(label, ok) VALUES (l, coalesce(ok,false)); END $f$;
CREATE OR REPLACE FUNCTION pg_temp.rot_secrets() RETURNS bigint
LANGUAGE sql AS $f$ SELECT count(*) FROM vault.secrets WHERE name LIKE 'arca-private-key-rotation:%' $f$;

DO $t$
DECLARE r jsonb; v_pend uuid; v_sec uuid;
BEGIN
  -- ── T1: certificado con solo CN + serialNumber → subject autorizado mínimo ──
  r := public.arca_get_rotation_subject_safe('00000000-0000-4000-8000-0000000054a1');
  PERFORM pg_temp.chk('1 resolver ok', (r->>'ok')::boolean);
  PERFORM pg_temp.chk('1 CN = alias', r->'subject'->>'cn' = 'fixture.alias');
  PERFORM pg_temp.chk('1 serialNumber canónico del cert', r->'subject'->>'serialnumber' = 'CUIT 20111111112');
  PERFORM pg_temp.chk('4/5 sin C/ST/L/O/OU/email (solo 2 claves)',
    (SELECT count(*) FROM jsonb_object_keys(r->'subject') k) = 2);
  PERFORM pg_temp.chk('1 optional_attributes_count = 0', (r->>'optional_attributes_count')::int = 0);
  -- T11: arca_config.cuit tiene GUIONES y el cert no → comparación normalizada OK
  PERFORM pg_temp.chk('11 CUIT con guiones vs 11 dígitos: match normalizado',
    (r->>'alias_match')::boolean AND (r->>'cuit_match')::boolean);

  -- ── T7: CN del certificado ≠ alias → falla ANTES de generar nada ──
  UPDATE public.arca_config SET cert_file = $p$-----BEGIN CERTIFICATE-----
MIIB1DCCAT2gAwIBAgIBATANBgkqhkiG9w0BAQsFADAwMRMwEQYDVQQDEwpvdHJv
LmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAzMDAw
MFoXDTM1MDEwMTAzMDAwMFowMDETMBEGA1UEAxMKb3Ryby5hbGlhczEZMBcGA1UE
BRMQQ1VJVCAyMDExMTExMTExMjCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEA
pRCgzwvDWPCMkrjWaEgAqZM3uMV93wy5X9/1dok3ki8mnP72DEuqvqbpPyIOjfxb
ZtjttnMkk/N7FQSiKwgMxqjjk3HGoqxdvh8Il/0wEmb/i5bgKwUGeVMpjRGMbOTp
DJsqb3UOVJ6wmdrtndZ4IdsvYi334nj+ZPneWeqFNVsCAwEAATANBgkqhkiG9w0B
AQsFAAOBgQB8Wtva26WYLsrOf76/CMhWrI0cxBZl2YnM4DwWPy0+zYLiRxnbtK8l
2EudumuZYi0UNnZVE9nPum8ePBxvnDuF7WnxJ2iK1nzUQjekWiMJBlFmxUFNif8j
8ucEcud0pVhQNFQsSgevEs+zsem86l2C5UbJLKZ3slju377ix5cbog==
-----END CERTIFICATE-----$p$ WHERE business_id='00000000-0000-4000-8000-0000000054a1';
  r := public.arca_prepare_certificate_rotation('00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXAIBAAKBgQCtIFCxXEEp328c2k7uQh9r0e9HuFAW6Jnwm76eqiwO+XmEbaO9
cJt8qsy/e2MKJ7xrYBkkexlBtPhTMOssKzi89fENee+Qt2nxgULRy0dEmxAH3MDP
p7sIRza/Cf+2aqkkHIKPLbu7BdyjOOPF50WCi1X1Sbu4Av+m94rhHFaqlQIDAQAB
AoGAUB5pWXsBKRieujKJXpe5JNOVsZIpdkCUpRXeZF0KYK+xPcjjgtLvEgWVFXRL
hDKZbvOdDxXsvUy7svwriVhDO+Q9TEVwmRCL6IFyZ2C5E41UF5jPpIafelFrJSrF
lYxSK2Up0W9a6KUcoIG5wnQbZ1FeogpRPXPvblmRwai+f+ECQQDGSLGFKcyMRxCM
yMidg53QHao2YS+O1cnrlt3XcrjfPZqt7enEE+ababCRIaklEu+bUied7Wp0jCJT
dEN0fpdNAkEA34T4oJ6DMLUW2KX0Y1nRonns1wHYerUBToVC0MziYg3jkW5HHpSc
MRMoJmA9eeL/0SFo/57M3fbYeYMg3x8MaQJBALSPd9A6WwEWqZR6Nm1xcCEXEmwI
ngUk24YEUSmjV4Q6lgNyliAuux2k5duTWnLfRoAbFOZ0Ty+oeI2kXtTTfjUCQAOk
exjC/IhSqyikq7Lix9PKAN4QHaMCSB8rdMdKT3Yhm8/G6EnLSjBSi5j0gIv38wtJ
bBieUeBcIXL5fBOmweECQGqLjcK4Rqcrae1Sq7uQWvO2lPd60Wqolzm3G/9dNQl3
rGItQ1mhrrCUgjsdc/OmSRGqeK6QafsVFbFOKBdbRqQ=
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBcjCB3AIBADAzMRYwFAYDVQQDEw1maXh0dXJlLmFsaWFzMRkwFwYDVQQFExBD
VUlUIDIwMTExMTExMTEyMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCtIFCx
XEEp328c2k7uQh9r0e9HuFAW6Jnwm76eqiwO+XmEbaO9cJt8qsy/e2MKJ7xrYBkk
exlBtPhTMOssKzi89fENee+Qt2nxgULRy0dEmxAH3MDPp7sIRza/Cf+2aqkkHIKP
Lbu7BdyjOOPF50WCi1X1Sbu4Av+m94rhHFaqlQIDAQABoAAwDQYJKoZIhvcNAQEL
BQADgYEAE9HlqpIuu37s5581dlGDmPHjg3HsVizL8tHOuy8TgXmiWw/epD5j1AKa
fLojtRLnYBg0G++lGH36BwWWgNrPUuuW8mnyFWx/kZJrAmHtibhSRbWgWtIzanwQ
7YpX/i3GBHL3t5tkSBo54N7vIBa04zKuAG2xCko4VGzXyn2+V0k=
-----END CERTIFICATE REQUEST-----$p$, 'af4ab2bc3bc0095c614c7ef2ebcd4795035545b26d8d01f1421df757da146238',
     'RSA', 1024, 65537, $j${"cn":"fixture.alias","serialnumber":"CUIT 20111111112"}$j$::jsonb, 'idem-badcn', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('7 CN ≠ alias → CURRENT_CERTIFICATE_IDENTITY_MISMATCH',
    r->>'state' = 'CURRENT_CERTIFICATE_IDENTITY_MISMATCH');
  PERFORM pg_temp.chk('15 cero secretos ante mismatch de identidad (CN)', pg_temp.rot_secrets() = 0);

  -- ── T8: serialNumber del certificado ≠ CUIT → falla ──
  UPDATE public.arca_config SET cert_file = $p$-----BEGIN CERTIFICATE-----
MIIB2jCCAUOgAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwOTk5OTk5OTk1MB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDk5OTk5OTk5NTCBnzANBgkqhkiG9w0BAQEFAAOBjQAw
gYkCgYEAvAMNwruzxfDCYiyPGxIwoU6AjJy+lKDlouDQNtT1cv2KnJ6BFT8aWPBn
+bYTPYk0XG5uus4d8M+zKf2khrp4vXmoTnBcIKNypKzL/ua/ahwmV/ryOVGnp2YW
izB1KYEIeajgCvdIEDvTPtM6yLEsFC9aryyyhEZ/qPaznLSCVysCAwEAATANBgkq
hkiG9w0BAQsFAAOBgQA1ypgaXRrc4U7z4ihPRCufJauCbq/zotwU2w4yNJ7Jcqwl
Ji1ljV1QAt5MUvfK6KxLD0fo5Y4WRGB3Gi55fKfjNADWxZsaTKvplSUr0IdGbWVR
kRcpzq6EQiZcBZ8Vs196X9L/vT++H6mnrxPDWYFIA+J6NnWUm8wpT2LT7E5fcA==
-----END CERTIFICATE-----$p$ WHERE business_id='00000000-0000-4000-8000-0000000054a1';
  r := public.arca_prepare_certificate_rotation('00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXAIBAAKBgQCtIFCxXEEp328c2k7uQh9r0e9HuFAW6Jnwm76eqiwO+XmEbaO9
cJt8qsy/e2MKJ7xrYBkkexlBtPhTMOssKzi89fENee+Qt2nxgULRy0dEmxAH3MDP
p7sIRza/Cf+2aqkkHIKPLbu7BdyjOOPF50WCi1X1Sbu4Av+m94rhHFaqlQIDAQAB
AoGAUB5pWXsBKRieujKJXpe5JNOVsZIpdkCUpRXeZF0KYK+xPcjjgtLvEgWVFXRL
hDKZbvOdDxXsvUy7svwriVhDO+Q9TEVwmRCL6IFyZ2C5E41UF5jPpIafelFrJSrF
lYxSK2Up0W9a6KUcoIG5wnQbZ1FeogpRPXPvblmRwai+f+ECQQDGSLGFKcyMRxCM
yMidg53QHao2YS+O1cnrlt3XcrjfPZqt7enEE+ababCRIaklEu+bUied7Wp0jCJT
dEN0fpdNAkEA34T4oJ6DMLUW2KX0Y1nRonns1wHYerUBToVC0MziYg3jkW5HHpSc
MRMoJmA9eeL/0SFo/57M3fbYeYMg3x8MaQJBALSPd9A6WwEWqZR6Nm1xcCEXEmwI
ngUk24YEUSmjV4Q6lgNyliAuux2k5duTWnLfRoAbFOZ0Ty+oeI2kXtTTfjUCQAOk
exjC/IhSqyikq7Lix9PKAN4QHaMCSB8rdMdKT3Yhm8/G6EnLSjBSi5j0gIv38wtJ
bBieUeBcIXL5fBOmweECQGqLjcK4Rqcrae1Sq7uQWvO2lPd60Wqolzm3G/9dNQl3
rGItQ1mhrrCUgjsdc/OmSRGqeK6QafsVFbFOKBdbRqQ=
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBcjCB3AIBADAzMRYwFAYDVQQDEw1maXh0dXJlLmFsaWFzMRkwFwYDVQQFExBD
VUlUIDIwMTExMTExMTEyMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCtIFCx
XEEp328c2k7uQh9r0e9HuFAW6Jnwm76eqiwO+XmEbaO9cJt8qsy/e2MKJ7xrYBkk
exlBtPhTMOssKzi89fENee+Qt2nxgULRy0dEmxAH3MDPp7sIRza/Cf+2aqkkHIKP
Lbu7BdyjOOPF50WCi1X1Sbu4Av+m94rhHFaqlQIDAQABoAAwDQYJKoZIhvcNAQEL
BQADgYEAE9HlqpIuu37s5581dlGDmPHjg3HsVizL8tHOuy8TgXmiWw/epD5j1AKa
fLojtRLnYBg0G++lGH36BwWWgNrPUuuW8mnyFWx/kZJrAmHtibhSRbWgWtIzanwQ
7YpX/i3GBHL3t5tkSBo54N7vIBa04zKuAG2xCko4VGzXyn2+V0k=
-----END CERTIFICATE REQUEST-----$p$, 'af4ab2bc3bc0095c614c7ef2ebcd4795035545b26d8d01f1421df757da146238',
     'RSA', 1024, 65537, $j${"cn":"fixture.alias","serialnumber":"CUIT 20111111112"}$j$::jsonb, 'idem-badcuit', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('8 serialNumber ≠ CUIT → CURRENT_CERTIFICATE_IDENTITY_MISMATCH',
    r->>'state' = 'CURRENT_CERTIFICATE_IDENTITY_MISMATCH');
  PERFORM pg_temp.chk('15 cero secretos ante mismatch de identidad (CUIT)', pg_temp.rot_secrets() = 0);

  -- restaurar el certificado vigente correcto
  UPDATE public.arca_config SET cert_file = $p$-----BEGIN CERTIFICATE-----
MIIB2jCCAUOgAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCBnzANBgkqhkiG9w0BAQEFAAOBjQAw
gYkCgYEAtdULzqwDVEeen9/aYHNqOty0uDnuno7WBskq9DIyKoh0fXbRpG5uqOXr
9u3g9OuvG4t040dV5yB2maKaRcRK05xc3Vw5f8nO1XjZEJcca484JlpbYP0R9amF
uKCaChr68EeUV55K3FBNmr6YxafS2FB9Sqm4D44jmekcJKkEJGsCAwEAATANBgkq
hkiG9w0BAQsFAAOBgQA7O44tjiUuaeQUab/wNcnkWh4sJqeNt70CGwTTNA2nyrSO
ic/msgA0P9de8+1gtJkDGQEvb4szJfoPWID5Klm8Sbu7c1qrDfyt8giukUpT9g5a
sZFjQHoaJUGB3BH4CSpmjX2ibQO22a31o9wDJGsgAdJlDYi+yHeehPIEzmONiw==
-----END CERTIFICATE-----$p$ WHERE business_id='00000000-0000-4000-8000-0000000054a1';

  -- ── T9: CSR con C=AR agregado → rechazo ──
  r := public.arca_prepare_certificate_rotation('00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQC091VeLdcVgZx4BoRPdM5WwxlW0fmgqfdRgsIva67Q3/cTzdkI
ksR+JECQlqqw3PKMPIqPbNPinI1ec7GSKaBeItPbvF9EClnSSh1T0VJzswUe4lXl
sMUVGgE9YhBOk6cluWOXJEZ4lMWdYbkSJ+28S8flPp3m1DnRPgoZYcSxGQIDAQAB
AoGANC4RFnvfRds+k7lFU2fZy1isKMWY1gPMRVuPxH6nRKEfrD0xtHAlaj3nxAk9
pIvBAEDAr0RxACml9bMkY4HPNHjoXRmtEzXxVuSbX3p3JrqTqry9NRgQ2g/MZI1h
j1pzFAw204Jh+7eEk4SyDo2fcTSjpIBimLKHDqlscPvNUAECQQDD+E1rh3yYnH8E
PQyp/X1Ct7/yEu8wuhzgokvv/2oAD2AfRQ0Nh2gO5qgHH6/kL1U14Iw6jdUpgniz
Tz3reJMZAkEA7GZ0WG1JY1hVbXv5UGXyt4cTzPjZTWsA4q06K2qNJK08wjGCVkoL
CwkCGRrE4OP1JzSXbVYNZdiPk84aKx7OAQJAMvWUnEulGMJJPT7q1iF2uyyxGy/V
RyR+ceOCP6x5Uf6tjjQUitoVMxrDwuZ4hKvSSqpTjL5pGdw1qtsGTP8TsQJBAKQO
QgWv6jM4dSii1ZVW+sckxbgEpoFUleu5fdntewAN/VFjHGmXvuwslzkm26SabmKD
2+azxl58mL9hU8XC/gECQQCWo/LmKsIQc1ydT32QX3Ma1MZnb31UXKKKmdzq/M15
9YsICThAqJ14Ox3zTKkm1BJ8kTMwdEqMFNBvYnZnN1nZ
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBfzCB6QIBADBAMRYwFAYDVQQDEw1maXh0dXJlLmFsaWFzMRkwFwYDVQQFExBD
VUlUIDIwMTExMTExMTEyMQswCQYDVQQGEwJBUjCBnzANBgkqhkiG9w0BAQEFAAOB
jQAwgYkCgYEAtPdVXi3XFYGceAaET3TOVsMZVtH5oKn3UYLCL2uu0N/3E83ZCJLE
fiRAkJaqsNzyjDyKj2zT4pyNXnOxkimgXiLT27xfRApZ0kodU9FSc7MFHuJV5bDF
FRoBPWIQTpOnJbljlyRGeJTFnWG5EiftvEvH5T6d5tQ50T4KGWHEsRkCAwEAAaAA
MA0GCSqGSIb3DQEBCwUAA4GBAHkUhi+fBagXXipM/ujRzREhJxXHa6iQTaJcgWd8
jax1/7B2dnS8YDrTfG6HoJAzTv62ryoIdYCR7KkSSFziEXjXYjVxf2ZM1Mfyaa+4
LaiOnXbAQc4yqTrDvhMFeGFrc/IkIxVfT4eYwNI3HCKiTaYmgFeOb1KPq4LI93DE
tqKz
-----END CERTIFICATE REQUEST-----$p$, '2f36c13c45de95042ddcf51cad682e836c57a9026c45130290b23c8df94e1ee2',
     'RSA', 1024, 65537, $j${"cn":"fixture.alias","serialnumber":"CUIT 20111111112","c":"AR"}$j$::jsonb, 'idem-extrac', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('9 CSR con C=AR → CSR_SUBJECT_MISMATCH', r->>'state' = 'CSR_SUBJECT_MISMATCH');
  PERFORM pg_temp.chk('9 cero secretos', pg_temp.rot_secrets() = 0);

  -- ── T10: CSR con O=alias → rechazo ──
  r := public.arca_prepare_certificate_rotation('00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQC0khgezspzGZftUXG3GzAMs+R2+9dq7jITSgA2x6q6GOFXQozf
zw0ZXTE0r2lNZ82zdgPJU7twz/Kn/2Fbd45NbuahWsmu87Kxmu66xBc1d+ZzugaN
S4hNYrZQYUcugBP1seeaVe6g3Aj5f9WazhnyaBvbbiMweP+44BaR3XGKQwIDAQAB
AoGAO0r9wKAGumTdDoB/5rB2xrULgEaSJfqxVsQl7dcCqLkixZSEzbkfhASl87bl
zRUY5qUJ+UIVeqXN+HxTa8WGZDjNil5tCBDlM2bNhVkNfXCmP3XvaksHaK2TylEK
fRoKSwIxyaksVD2xap6g/kxj3+IMQfNKDJFGkSLEAsl4qAECQQDA3jZb8egLNxZA
brl8csnECWeR/1GmcNIH2ODl5LSGdAEWFMZJZb0k6DensDZ3NbilTipFWgN2+x17
eAT71a1BAkEA761mebYCsqaSQ9bX5ig+zkaujqHILYqXFaANyGm7NLsdAFu6aerx
TNqdfWid2gGU3FqusLt5MoQaPDUJ9gdigwJAL52s5f5PP5WWFMpBWQwt7Aw2WcEj
M2hfMjjFLXzNZPR24DC4054emGIMe4XxrHTC5Wzq2rxiZpmQqc7zzAjxAQJBAJ+u
aDqon82Emqgl6DuIDqgBgWS3tpVY42Xd97DReI8eJqlJc74DcHZipFCcNaa8LQBO
Tlqi3JFiX9RDBfrrWp8CQQChM20p+xZytPyDZf4CiJdla6TqfQsZyT5zrHqT2tdh
btjMY8OzjPxi7N6sAF/qBuieebUnbi84489PFe04IIJR
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBijCB9AIBADBLMRYwFAYDVQQDEw1maXh0dXJlLmFsaWFzMRkwFwYDVQQFExBD
VUlUIDIwMTExMTExMTEyMRYwFAYDVQQKEw1maXh0dXJlLmFsaWFzMIGfMA0GCSqG
SIb3DQEBAQUAA4GNADCBiQKBgQC0khgezspzGZftUXG3GzAMs+R2+9dq7jITSgA2
x6q6GOFXQozfzw0ZXTE0r2lNZ82zdgPJU7twz/Kn/2Fbd45NbuahWsmu87Kxmu66
xBc1d+ZzugaNS4hNYrZQYUcugBP1seeaVe6g3Aj5f9WazhnyaBvbbiMweP+44BaR
3XGKQwIDAQABoAAwDQYJKoZIhvcNAQELBQADgYEATVGrvv8FVOI2KtU0XtzM6eq8
NI2AX0U3sCmce/fOjAwNyL4JNRh0IWXhVAf2ZYrHSRuWD0iBtlks79Y76KLSZmZx
FFtABrLIUgrLZcSkmS9sOqecKv0OZWM+Fv/xzPXdVuGgNHXhxuii2bfeZoFppUCa
JT0Rf6QY2JvCqfs0wpg=
-----END CERTIFICATE REQUEST-----$p$, 'b11cc974dddd209c2abb992282bc1eecb346a2b7d909e449e0914ad9be904865',
     'RSA', 1024, 65537, $j${"cn":"fixture.alias","serialnumber":"CUIT 20111111112","o":"fixture.alias"}$j$::jsonb, 'idem-witho', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('10 CSR con O=alias → CSR_SUBJECT_MISMATCH', r->>'state' = 'CSR_SUBJECT_MISMATCH');
  PERFORM pg_temp.chk('10 cero secretos', pg_temp.rot_secrets() = 0);

  -- ── serialNumber NO canónico (con guiones) en el CSR → rechazo ──
  r := public.arca_prepare_certificate_rotation('00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXAIBAAKBgQDIKJlu0yrMChXYx4eIyKw9OdpBD+iHgAfso4Ju4rX8tXncFjyl
3uur8IyMRzEq2gAegquTzqDpVa9SSk8DbFdawl9cVRbQxQ0fQMxScbokFsGHM9PZ
gMN9nHTSEunA7qxzblmisnfPg5mieBR8fNtzLFoHm7z6eI2Jzc+MCNV5YQIDAQAB
AoGBAKFU2BcT7fL4ThOlAAGofev7rYezouFUuQ5r3L4zziwaulZDNi8cNykngqGu
4FqBzIbLHDDO47QvdFkHvBguQ1ldtrRYuzVrxU5MsVagn5skXHlUQzHxzko0c/do
kCfQleSUjguH+viw0qXQB88PqDGY1mrh/fPgnBzBFkWwCnNhAkEA+NAgFG4hkOrB
t9htwhagY9vBmVIk7gSxLVMzUL6K1ZbM4mMaHfJAwCt4LTyxlfboS4okEp3d9HjN
EiKUZJ6trwJBAM3wsZzlQKLFdjjQ++ZkEWx0L6zmjjSITpKTgimv/2O6egbQMHcG
WWWq7MBANI2vnXGySgDg+RY+sw3amxrjne8CQA0iz87EUblY64lNP94zW5xqCbqS
f6ihTslZzyfAJ4xHPeHl4YcbNxfuM5YP0kBcnL8AOA9TjlhN2GXQtYzqY7kCQCMw
I0kJqvelAcRHgSMmqgt79sF2S4oSWEqXRcBVwC+MJ1mOrRlJTnEeuYFH9zLWdPJ+
YkKwLh9s6y9M0P/RMKUCQA0tqKMt9gphEF2aKo0N658Lty/vB0bnr354YEeq2O85
J3DIBeIE4kKzUDnDGZmWYRpsN7ZWo9xkhpKdNfU0HdI=
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBdDCB3gIBADA1MRYwFAYDVQQDEw1maXh0dXJlLmFsaWFzMRswGQYDVQQFExJD
VUlUIDIwLTExMTExMTExLTIwgZ8wDQYJKoZIhvcNAQEBBQADgY0AMIGJAoGBAMgo
mW7TKswKFdjHh4jIrD052kEP6IeAB+yjgm7itfy1edwWPKXe66vwjIxHMSraAB6C
q5POoOlVr1JKTwNsV1rCX1xVFtDFDR9AzFJxuiQWwYcz09mAw32cdNIS6cDurHNu
WaKyd8+DmaJ4FHx823MsWgebvPp4jYnNz4wI1XlhAgMBAAGgADANBgkqhkiG9w0B
AQsFAAOBgQCVjpN7LbVbeCa5OUPI3Zluv/bKd9fNbrZWUKsL5ILKhP/zeEt2gonL
qT5n1H5w/sahzWKBll4eDvyDGUfDWw1Fwf8HVHMHnSSd259PMw92/uFgNleR4rgz
kwAFV4iaeWSnBhNdQ/Ouoh6dGaH857JoPuzfBjZmDgcuMptPGvHMhg==
-----END CERTIFICATE REQUEST-----$p$, 'b33493ba88a03be7d2e63c99cee80647fc5be83349a95cd14aa00f91f643c610',
     'RSA', 1024, 65537, $j${"cn":"fixture.alias","serialnumber":"CUIT 20-11111111-2"}$j$::jsonb, 'idem-dash', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('serialNumber no canónico en el CSR → CSR_SUBJECT_MISMATCH',
    r->>'state' = 'CSR_SUBJECT_MISMATCH');

  -- ── T2/T3/T6/T12: subject mínimo correcto → PREPARA (razon_social NULL y
  --    business_settings vacío NO bloquean) ──
  r := public.arca_prepare_certificate_rotation('00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXAIBAAKBgQCtIFCxXEEp328c2k7uQh9r0e9HuFAW6Jnwm76eqiwO+XmEbaO9
cJt8qsy/e2MKJ7xrYBkkexlBtPhTMOssKzi89fENee+Qt2nxgULRy0dEmxAH3MDP
p7sIRza/Cf+2aqkkHIKPLbu7BdyjOOPF50WCi1X1Sbu4Av+m94rhHFaqlQIDAQAB
AoGAUB5pWXsBKRieujKJXpe5JNOVsZIpdkCUpRXeZF0KYK+xPcjjgtLvEgWVFXRL
hDKZbvOdDxXsvUy7svwriVhDO+Q9TEVwmRCL6IFyZ2C5E41UF5jPpIafelFrJSrF
lYxSK2Up0W9a6KUcoIG5wnQbZ1FeogpRPXPvblmRwai+f+ECQQDGSLGFKcyMRxCM
yMidg53QHao2YS+O1cnrlt3XcrjfPZqt7enEE+ababCRIaklEu+bUied7Wp0jCJT
dEN0fpdNAkEA34T4oJ6DMLUW2KX0Y1nRonns1wHYerUBToVC0MziYg3jkW5HHpSc
MRMoJmA9eeL/0SFo/57M3fbYeYMg3x8MaQJBALSPd9A6WwEWqZR6Nm1xcCEXEmwI
ngUk24YEUSmjV4Q6lgNyliAuux2k5duTWnLfRoAbFOZ0Ty+oeI2kXtTTfjUCQAOk
exjC/IhSqyikq7Lix9PKAN4QHaMCSB8rdMdKT3Yhm8/G6EnLSjBSi5j0gIv38wtJ
bBieUeBcIXL5fBOmweECQGqLjcK4Rqcrae1Sq7uQWvO2lPd60Wqolzm3G/9dNQl3
rGItQ1mhrrCUgjsdc/OmSRGqeK6QafsVFbFOKBdbRqQ=
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBcjCB3AIBADAzMRYwFAYDVQQDEw1maXh0dXJlLmFsaWFzMRkwFwYDVQQFExBD
VUlUIDIwMTExMTExMTEyMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCtIFCx
XEEp328c2k7uQh9r0e9HuFAW6Jnwm76eqiwO+XmEbaO9cJt8qsy/e2MKJ7xrYBkk
exlBtPhTMOssKzi89fENee+Qt2nxgULRy0dEmxAH3MDPp7sIRza/Cf+2aqkkHIKP
Lbu7BdyjOOPF50WCi1X1Sbu4Av+m94rhHFaqlQIDAQABoAAwDQYJKoZIhvcNAQEL
BQADgYEAE9HlqpIuu37s5581dlGDmPHjg3HsVizL8tHOuy8TgXmiWw/epD5j1AKa
fLojtRLnYBg0G++lGH36BwWWgNrPUuuW8mnyFWx/kZJrAmHtibhSRbWgWtIzanwQ
7YpX/i3GBHL3t5tkSBo54N7vIBa04zKuAG2xCko4VGzXyn2+V0k=
-----END CERTIFICATE REQUEST-----$p$, 'af4ab2bc3bc0095c614c7ef2ebcd4795035545b26d8d01f1421df757da146238',
     'RSA', 1024, 65537, $j${"cn":"fixture.alias","serialnumber":"CUIT 20111111112"}$j$::jsonb, 'idem-A', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('2/3/6 razon_social NULL y business_settings vacío no bloquean → PREPARED',
    r->>'state' = 'ROTATION_PREPARED');
  PERFORM pg_temp.chk('12 CSR mínimo aceptado (firma y estructura válidas)',
    (r->>'csr_pem') like '%CERTIFICATE REQUEST%');
  PERFORM pg_temp.chk('2 sin clave en el retorno', (r::text) !~ 'PRIVATE KEY');
  SELECT id, private_key_secret_id INTO v_pend, v_sec FROM private.arca_credential_rotations
    WHERE business_id='00000000-0000-4000-8000-0000000054a1' AND state='pending_rotation';
  PERFORM pg_temp.chk('2 pending + secreto', v_pend IS NOT NULL AND pg_temp.rot_secrets() = 1);
  PERFORM pg_temp.chk('2 subject almacenado = mínimo',
    (SELECT (SELECT count(*) FROM jsonb_object_keys(subject) k) FROM private.arca_credential_rotations WHERE id=v_pend) = 2);

  -- ── T13: replay idempotente exacto ──
  r := public.arca_prepare_certificate_rotation('00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXAIBAAKBgQCtIFCxXEEp328c2k7uQh9r0e9HuFAW6Jnwm76eqiwO+XmEbaO9
cJt8qsy/e2MKJ7xrYBkkexlBtPhTMOssKzi89fENee+Qt2nxgULRy0dEmxAH3MDP
p7sIRza/Cf+2aqkkHIKPLbu7BdyjOOPF50WCi1X1Sbu4Av+m94rhHFaqlQIDAQAB
AoGAUB5pWXsBKRieujKJXpe5JNOVsZIpdkCUpRXeZF0KYK+xPcjjgtLvEgWVFXRL
hDKZbvOdDxXsvUy7svwriVhDO+Q9TEVwmRCL6IFyZ2C5E41UF5jPpIafelFrJSrF
lYxSK2Up0W9a6KUcoIG5wnQbZ1FeogpRPXPvblmRwai+f+ECQQDGSLGFKcyMRxCM
yMidg53QHao2YS+O1cnrlt3XcrjfPZqt7enEE+ababCRIaklEu+bUied7Wp0jCJT
dEN0fpdNAkEA34T4oJ6DMLUW2KX0Y1nRonns1wHYerUBToVC0MziYg3jkW5HHpSc
MRMoJmA9eeL/0SFo/57M3fbYeYMg3x8MaQJBALSPd9A6WwEWqZR6Nm1xcCEXEmwI
ngUk24YEUSmjV4Q6lgNyliAuux2k5duTWnLfRoAbFOZ0Ty+oeI2kXtTTfjUCQAOk
exjC/IhSqyikq7Lix9PKAN4QHaMCSB8rdMdKT3Yhm8/G6EnLSjBSi5j0gIv38wtJ
bBieUeBcIXL5fBOmweECQGqLjcK4Rqcrae1Sq7uQWvO2lPd60Wqolzm3G/9dNQl3
rGItQ1mhrrCUgjsdc/OmSRGqeK6QafsVFbFOKBdbRqQ=
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBcjCB3AIBADAzMRYwFAYDVQQDEw1maXh0dXJlLmFsaWFzMRkwFwYDVQQFExBD
VUlUIDIwMTExMTExMTEyMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCtIFCx
XEEp328c2k7uQh9r0e9HuFAW6Jnwm76eqiwO+XmEbaO9cJt8qsy/e2MKJ7xrYBkk
exlBtPhTMOssKzi89fENee+Qt2nxgULRy0dEmxAH3MDPp7sIRza/Cf+2aqkkHIKP
Lbu7BdyjOOPF50WCi1X1Sbu4Av+m94rhHFaqlQIDAQABoAAwDQYJKoZIhvcNAQEL
BQADgYEAE9HlqpIuu37s5581dlGDmPHjg3HsVizL8tHOuy8TgXmiWw/epD5j1AKa
fLojtRLnYBg0G++lGH36BwWWgNrPUuuW8mnyFWx/kZJrAmHtibhSRbWgWtIzanwQ
7YpX/i3GBHL3t5tkSBo54N7vIBa04zKuAG2xCko4VGzXyn2+V0k=
-----END CERTIFICATE REQUEST-----$p$, 'af4ab2bc3bc0095c614c7ef2ebcd4795035545b26d8d01f1421df757da146238',
     'RSA', 1024, 65537, $j${"cn":"fixture.alias","serialnumber":"CUIT 20111111112"}$j$::jsonb, 'idem-A', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('13 replay exacto → ALREADY_PREPARED', r->>'state' = 'ROTATION_ALREADY_PREPARED');
  PERFORM pg_temp.chk('13 devuelve el CSR original', (r->>'csr_pem') = $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBcjCB3AIBADAzMRYwFAYDVQQDEw1maXh0dXJlLmFsaWFzMRkwFwYDVQQFExBD
VUlUIDIwMTExMTExMTEyMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCtIFCx
XEEp328c2k7uQh9r0e9HuFAW6Jnwm76eqiwO+XmEbaO9cJt8qsy/e2MKJ7xrYBkk
exlBtPhTMOssKzi89fENee+Qt2nxgULRy0dEmxAH3MDPp7sIRza/Cf+2aqkkHIKP
Lbu7BdyjOOPF50WCi1X1Sbu4Av+m94rhHFaqlQIDAQABoAAwDQYJKoZIhvcNAQEL
BQADgYEAE9HlqpIuu37s5581dlGDmPHjg3HsVizL8tHOuy8TgXmiWw/epD5j1AKa
fLojtRLnYBg0G++lGH36BwWWgNrPUuuW8mnyFWx/kZJrAmHtibhSRbWgWtIzanwQ
7YpX/i3GBHL3t5tkSBo54N7vIBa04zKuAG2xCko4VGzXyn2+V0k=
-----END CERTIFICATE REQUEST-----$p$);

  -- ── T14: respuesta perdida — retry con OTRA clave, mismo subject y misma idem ──
  r := public.arca_prepare_certificate_rotation('00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXAIBAAKBgQDf9vVbYu31qGUzZBG5MCw0gpJzbHOI+mF7SpLquq7LCUmvsQnQ
ZXfpecBsr8smWRqOhimJ1ufsjs8tycIwb2F8h7U8rMz7H2iL2tk/iaeHWAm7zAmx
pgUluB18chjM1/XmTv8N3w0aAGlwLrqtBEYzh0WtgavPsBmQacJ9jQmKEQIDAQAB
AoGARmshzjAW3cyqtTPblrycyY3ceko5MXJ4QAm8k+1KlDBBaOpjSZD92P0dEY9c
cpxFi1aHrP1TQr/MSHtNgWkj3ysTc+ML4dEiKSDudvnow4vG1XlHd3MVaWotDzTB
hFA/Ctlnrgvx+ln9ldNSDDIfKVWLDkniceG3bCGBxnP/DjkCQQD7X9t4+IHUNaVY
vwnKs81/f80+kL29Mxs63yT9kwaH2lxndM1HnyMYu3pF/JbyvthdP6XCgYhDO1oi
l95odReXAkEA5BX7kk04WwbX3BQytbyr5l+501sT1MhxnCXAKcxaIabEtklVZKqj
MgXfPMCTsYcD17M94IA6Z0LeoW/yFeBglwJAIvYrFUEi9XvcmmI/n2SwkSoaRrhk
21qvT9nXUDlRsDVroqv5HRwCCp+QmwlNiUeH2jhO+qV/aTJpD+Sld0vJ0wJBANXj
z4EJLToflrnprwxCnClzx31uwZAfUHsP477Oxg8cpwgSiSPX6SZ13zzHkzk91dqn
WfV4CkzfpotZwXnGao0CQBuxJ69Agx/JDW9mnFvecMsZ4SKKVLSUUgps5UL0PnhX
sx9fzUkyQ8y8lG/zA+PJH85yUX4sMFguLz5mNX89KVc=
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBcjCB3AIBADAzMRYwFAYDVQQDEw1maXh0dXJlLmFsaWFzMRkwFwYDVQQFExBD
VUlUIDIwMTExMTExMTEyMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDf9vVb
Yu31qGUzZBG5MCw0gpJzbHOI+mF7SpLquq7LCUmvsQnQZXfpecBsr8smWRqOhimJ
1ufsjs8tycIwb2F8h7U8rMz7H2iL2tk/iaeHWAm7zAmxpgUluB18chjM1/XmTv8N
3w0aAGlwLrqtBEYzh0WtgavPsBmQacJ9jQmKEQIDAQABoAAwDQYJKoZIhvcNAQEL
BQADgYEAhuQChyIFlNGhx47WviZC4HQXRNSquIsn3LI23pLuPISOsTS21o7mpYve
Nbs8zTwNZsN9AbGdc1r3vQVxgI/mJIgfXnbaensySAG0HbYrMfFZvNcOiZ96nLxJ
GsXzoUaTM1v51ZbIL4wYVn2f7Oqs3GORt7Cqu10JZl8jIJMMs1g=
-----END CERTIFICATE REQUEST-----$p$, 'd828abfaa8d4de7229cfe987528c61517b701cdb5c79adaf0098bf3d6fe45d44',
     'RSA', 1024, 65537, $j${"cn":"fixture.alias","serialnumber":"CUIT 20111111112"}$j$::jsonb, 'idem-A', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('14 respuesta perdida → ALREADY_PREPARED', r->>'state' = 'ROTATION_ALREADY_PREPARED');
  PERFORM pg_temp.chk('14 devuelve CSR A (no A2)', (r->>'csr_pem') = $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBcjCB3AIBADAzMRYwFAYDVQQDEw1maXh0dXJlLmFsaWFzMRkwFwYDVQQFExBD
VUlUIDIwMTExMTExMTEyMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCtIFCx
XEEp328c2k7uQh9r0e9HuFAW6Jnwm76eqiwO+XmEbaO9cJt8qsy/e2MKJ7xrYBkk
exlBtPhTMOssKzi89fENee+Qt2nxgULRy0dEmxAH3MDPp7sIRza/Cf+2aqkkHIKP
Lbu7BdyjOOPF50WCi1X1Sbu4Av+m94rhHFaqlQIDAQABoAAwDQYJKoZIhvcNAQEL
BQADgYEAE9HlqpIuu37s5581dlGDmPHjg3HsVizL8tHOuy8TgXmiWw/epD5j1AKa
fLojtRLnYBg0G++lGH36BwWWgNrPUuuW8mnyFWx/kZJrAmHtibhSRbWgWtIzanwQ
7YpX/i3GBHL3t5tkSBo54N7vIBa04zKuAG2xCko4VGzXyn2+V0k=
-----END CERTIFICATE REQUEST-----$p$);
  PERFORM pg_temp.chk('14 fingerprint A conservado',
    (SELECT private_key_fingerprint FROM private.arca_credential_rotations WHERE id=v_pend) = 'af4ab2bc3bc0095c614c7ef2ebcd4795035545b26d8d01f1421df757da146238');
  PERFORM pg_temp.chk('14 sigue habiendo UN solo secreto', pg_temp.rot_secrets() = 1);

  -- ── pending conflict con otra idempotency key ──
  r := public.arca_prepare_certificate_rotation('00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXAIBAAKBgQDf9vVbYu31qGUzZBG5MCw0gpJzbHOI+mF7SpLquq7LCUmvsQnQ
ZXfpecBsr8smWRqOhimJ1ufsjs8tycIwb2F8h7U8rMz7H2iL2tk/iaeHWAm7zAmx
pgUluB18chjM1/XmTv8N3w0aAGlwLrqtBEYzh0WtgavPsBmQacJ9jQmKEQIDAQAB
AoGARmshzjAW3cyqtTPblrycyY3ceko5MXJ4QAm8k+1KlDBBaOpjSZD92P0dEY9c
cpxFi1aHrP1TQr/MSHtNgWkj3ysTc+ML4dEiKSDudvnow4vG1XlHd3MVaWotDzTB
hFA/Ctlnrgvx+ln9ldNSDDIfKVWLDkniceG3bCGBxnP/DjkCQQD7X9t4+IHUNaVY
vwnKs81/f80+kL29Mxs63yT9kwaH2lxndM1HnyMYu3pF/JbyvthdP6XCgYhDO1oi
l95odReXAkEA5BX7kk04WwbX3BQytbyr5l+501sT1MhxnCXAKcxaIabEtklVZKqj
MgXfPMCTsYcD17M94IA6Z0LeoW/yFeBglwJAIvYrFUEi9XvcmmI/n2SwkSoaRrhk
21qvT9nXUDlRsDVroqv5HRwCCp+QmwlNiUeH2jhO+qV/aTJpD+Sld0vJ0wJBANXj
z4EJLToflrnprwxCnClzx31uwZAfUHsP477Oxg8cpwgSiSPX6SZ13zzHkzk91dqn
WfV4CkzfpotZwXnGao0CQBuxJ69Agx/JDW9mnFvecMsZ4SKKVLSUUgps5UL0PnhX
sx9fzUkyQ8y8lG/zA+PJH85yUX4sMFguLz5mNX89KVc=
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBcjCB3AIBADAzMRYwFAYDVQQDEw1maXh0dXJlLmFsaWFzMRkwFwYDVQQFExBD
VUlUIDIwMTExMTExMTEyMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDf9vVb
Yu31qGUzZBG5MCw0gpJzbHOI+mF7SpLquq7LCUmvsQnQZXfpecBsr8smWRqOhimJ
1ufsjs8tycIwb2F8h7U8rMz7H2iL2tk/iaeHWAm7zAmxpgUluB18chjM1/XmTv8N
3w0aAGlwLrqtBEYzh0WtgavPsBmQacJ9jQmKEQIDAQABoAAwDQYJKoZIhvcNAQEL
BQADgYEAhuQChyIFlNGhx47WviZC4HQXRNSquIsn3LI23pLuPISOsTS21o7mpYve
Nbs8zTwNZsN9AbGdc1r3vQVxgI/mJIgfXnbaensySAG0HbYrMfFZvNcOiZ96nLxJ
GsXzoUaTM1v51ZbIL4wYVn2f7Oqs3GORt7Cqu10JZl8jIJMMs1g=
-----END CERTIFICATE REQUEST-----$p$, 'd828abfaa8d4de7229cfe987528c61517b701cdb5c79adaf0098bf3d6fe45d44',
     'RSA', 1024, 65537, $j${"cn":"fixture.alias","serialnumber":"CUIT 20111111112"}$j$::jsonb, 'idem-otro', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('pending_conflict', r->>'state' = 'ROTATION_PENDING_CONFLICT');

  -- ── actor no-owner ──
  r := public.arca_prepare_certificate_rotation('00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXAIBAAKBgQCtIFCxXEEp328c2k7uQh9r0e9HuFAW6Jnwm76eqiwO+XmEbaO9
cJt8qsy/e2MKJ7xrYBkkexlBtPhTMOssKzi89fENee+Qt2nxgULRy0dEmxAH3MDP
p7sIRza/Cf+2aqkkHIKPLbu7BdyjOOPF50WCi1X1Sbu4Av+m94rhHFaqlQIDAQAB
AoGAUB5pWXsBKRieujKJXpe5JNOVsZIpdkCUpRXeZF0KYK+xPcjjgtLvEgWVFXRL
hDKZbvOdDxXsvUy7svwriVhDO+Q9TEVwmRCL6IFyZ2C5E41UF5jPpIafelFrJSrF
lYxSK2Up0W9a6KUcoIG5wnQbZ1FeogpRPXPvblmRwai+f+ECQQDGSLGFKcyMRxCM
yMidg53QHao2YS+O1cnrlt3XcrjfPZqt7enEE+ababCRIaklEu+bUied7Wp0jCJT
dEN0fpdNAkEA34T4oJ6DMLUW2KX0Y1nRonns1wHYerUBToVC0MziYg3jkW5HHpSc
MRMoJmA9eeL/0SFo/57M3fbYeYMg3x8MaQJBALSPd9A6WwEWqZR6Nm1xcCEXEmwI
ngUk24YEUSmjV4Q6lgNyliAuux2k5duTWnLfRoAbFOZ0Ty+oeI2kXtTTfjUCQAOk
exjC/IhSqyikq7Lix9PKAN4QHaMCSB8rdMdKT3Yhm8/G6EnLSjBSi5j0gIv38wtJ
bBieUeBcIXL5fBOmweECQGqLjcK4Rqcrae1Sq7uQWvO2lPd60Wqolzm3G/9dNQl3
rGItQ1mhrrCUgjsdc/OmSRGqeK6QafsVFbFOKBdbRqQ=
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBcjCB3AIBADAzMRYwFAYDVQQDEw1maXh0dXJlLmFsaWFzMRkwFwYDVQQFExBD
VUlUIDIwMTExMTExMTEyMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCtIFCx
XEEp328c2k7uQh9r0e9HuFAW6Jnwm76eqiwO+XmEbaO9cJt8qsy/e2MKJ7xrYBkk
exlBtPhTMOssKzi89fENee+Qt2nxgULRy0dEmxAH3MDPp7sIRza/Cf+2aqkkHIKP
Lbu7BdyjOOPF50WCi1X1Sbu4Av+m94rhHFaqlQIDAQABoAAwDQYJKoZIhvcNAQEL
BQADgYEAE9HlqpIuu37s5581dlGDmPHjg3HsVizL8tHOuy8TgXmiWw/epD5j1AKa
fLojtRLnYBg0G++lGH36BwWWgNrPUuuW8mnyFWx/kZJrAmHtibhSRbWgWtIzanwQ
7YpX/i3GBHL3t5tkSBo54N7vIBa04zKuAG2xCko4VGzXyn2+V0k=
-----END CERTIFICATE REQUEST-----$p$, 'af4ab2bc3bc0095c614c7ef2ebcd4795035545b26d8d01f1421df757da146238',
        'RSA', 1024, 65537, $j${"cn":"fixture.alias","serialnumber":"CUIT 20111111112"}$j$::jsonb, 'idem-unauth', '00000000-0000-4000-8000-00000000dead');
  PERFORM pg_temp.chk('unauthorized', r->>'state' = 'UNAUTHORIZED');

  -- ── cancelación + replay ──
  r := public.arca_cancel_certificate_rotation('00000000-0000-4000-8000-0000000054a1', 'idem-A', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('cancel', r->>'state' = 'ROTATION_CANCELLED');
  PERFORM pg_temp.chk('cancel retira el secreto', pg_temp.rot_secrets() = 0);
  r := public.arca_cancel_certificate_rotation('00000000-0000-4000-8000-0000000054a1', 'idem-A', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('cancel replay idempotente', r->>'state' = 'ROTATION_CANCELLED');
END $t$;

-- ── Alias/CUIT ausentes → estados dedicados ─────────────────────────────────
DO $t2$
DECLARE r jsonb;
BEGIN
  UPDATE public.arca_config SET alias = '' WHERE business_id='00000000-0000-4000-8000-0000000054a1';
  r := public.arca_get_rotation_subject_safe('00000000-0000-4000-8000-0000000054a1');
  PERFORM pg_temp.chk('FISCAL_ALIAS_MISSING', r->>'state' = 'FISCAL_ALIAS_MISSING');
  UPDATE public.arca_config SET alias = 'fixture.alias', cuit = '' WHERE business_id='00000000-0000-4000-8000-0000000054a1';
  r := public.arca_get_rotation_subject_safe('00000000-0000-4000-8000-0000000054a1');
  PERFORM pg_temp.chk('FISCAL_CUIT_MISSING', r->>'state' = 'FISCAL_CUIT_MISSING');
  UPDATE public.arca_config SET cuit = '20-11111111-2', cert_file = 'no-es-un-certificado' WHERE business_id='00000000-0000-4000-8000-0000000054a1';
  r := public.arca_get_rotation_subject_safe('00000000-0000-4000-8000-0000000054a1');
  PERFORM pg_temp.chk('CURRENT_CERTIFICATE_SUBJECT_INVALID', r->>'state' = 'CURRENT_CERTIFICATE_SUBJECT_INVALID');
  UPDATE public.arca_config SET cert_file = $p$-----BEGIN CERTIFICATE-----
MIIB2jCCAUOgAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCBnzANBgkqhkiG9w0BAQEFAAOBjQAw
gYkCgYEAtdULzqwDVEeen9/aYHNqOty0uDnuno7WBskq9DIyKoh0fXbRpG5uqOXr
9u3g9OuvG4t040dV5yB2maKaRcRK05xc3Vw5f8nO1XjZEJcca484JlpbYP0R9amF
uKCaChr68EeUV55K3FBNmr6YxafS2FB9Sqm4D44jmekcJKkEJGsCAwEAATANBgkq
hkiG9w0BAQsFAAOBgQA7O44tjiUuaeQUab/wNcnkWh4sJqeNt70CGwTTNA2nyrSO
ic/msgA0P9de8+1gtJkDGQEvb4szJfoPWID5Klm8Sbu7c1qrDfyt8giukUpT9g5a
sZFjQHoaJUGB3BH4CSpmjX2ibQO22a31o9wDJGsgAdJlDYi+yHeehPIEzmONiw==
-----END CERTIFICATE-----$p$ WHERE business_id='00000000-0000-4000-8000-0000000054a1';
END $t2$;

-- ── Certificado con atributos extra → el subject autorizado los reporta ──────
DO $t3$
DECLARE r jsonb;
BEGIN
  UPDATE public.arca_config SET cert_file = $p$-----BEGIN CERTIFICATE-----
MIICHjCCAYegAwIBAgIBATANBgkqhkiG9w0BAQsFADBVMQswCQYDVQQGEwJBUjET
MBEGA1UEChMKRml4dHVyZSBTQTEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZMBcG
A1UEBRMQQ1VJVCAyMDExMTExMTExMjAeFw0yMDAxMDEwMzAwMDBaFw0zNTAxMDEw
MzAwMDBaMFUxCzAJBgNVBAYTAkFSMRMwEQYDVQQKEwpGaXh0dXJlIFNBMRYwFAYD
VQQDEw1maXh0dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMIGf
MA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC3jwtIjDopYCyGxczKJoKO0uJ54PJS
1sO28wyoQkTvsYxmHRpdLJRwog8PfsKy1pY+Q4cvbcogwT1BTQzPAQoVx9IpqOcR
wF3SVMCAPURbuowHNSM5Gg6jd+lPUMfqKbmFlK0jSs8PAidrs2tFRiQmAFeXaos4
PTel46XdMVsLdwIDAQABMA0GCSqGSIb3DQEBCwUAA4GBADzFCC1onS3SMIoGx5cX
iMl7z8EzCiA6Rd4rpb5awNLqHoK2ODg5/nAHyNIARfV6K1XkiirJz5RTr9E2l2o1
sLqcip27nHzOuGnFhINXDo9uNkemNPnPDA+/UH/5k+iB0djU7EaqIgcSbKdlKp0S
fa7Z3MndXqK3PX4Lt1lSE4pW
-----END CERTIFICATE-----$p$ WHERE business_id='00000000-0000-4000-8000-0000000054a1';
  r := public.arca_get_rotation_subject_safe('00000000-0000-4000-8000-0000000054a1');
  PERFORM pg_temp.chk('cert con extras: identidad válida', (r->>'ok')::boolean);
  PERFORM pg_temp.chk('cert con extras: optional_attributes_count > 0', (r->>'optional_attributes_count')::int > 0);
  UPDATE public.arca_config SET cert_file = $p$-----BEGIN CERTIFICATE-----
MIIB2jCCAUOgAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCBnzANBgkqhkiG9w0BAQEFAAOBjQAw
gYkCgYEAtdULzqwDVEeen9/aYHNqOty0uDnuno7WBskq9DIyKoh0fXbRpG5uqOXr
9u3g9OuvG4t040dV5yB2maKaRcRK05xc3Vw5f8nO1XjZEJcca484JlpbYP0R9amF
uKCaChr68EeUV55K3FBNmr6YxafS2FB9Sqm4D44jmekcJKkEJGsCAwEAATANBgkq
hkiG9w0BAQsFAAOBgQA7O44tjiUuaeQUab/wNcnkWh4sJqeNt70CGwTTNA2nyrSO
ic/msgA0P9de8+1gtJkDGQEvb4szJfoPWID5Klm8Sbu7c1qrDfyt8giukUpT9g5a
sZFjQHoaJUGB3BH4CSpmjX2ibQO22a31o9wDJGsgAdJlDYi+yHeehPIEzmONiw==
-----END CERTIFICATE-----$p$ WHERE business_id='00000000-0000-4000-8000-0000000054a1';
END $t3$;

-- ── Invariantes ─────────────────────────────────────────────────────────────
SELECT pg_temp.chk('credencial active intacta',
  (SELECT active_cnt FROM s4a_pre) = (SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-0000000054a1')
  AND (SELECT active_fp FROM s4a_pre) = (SELECT private_key_fingerprint FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-0000000054a1'));
SELECT pg_temp.chk('arca_config intacto (cert/token/sign)',
  (SELECT cfg FROM s4a_pre) = (SELECT md5(cert_file||coalesce(wsaa_token,'')||coalesce(wsaa_sign,'')) FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000054a1'));
-- AFIP-S4C: preparar una rotación tampoco puede reintroducir clave en claro.
SELECT pg_temp.chk('preparar la rotación no crea almacenamiento plaintext',
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema='public' AND table_name='arca_config' AND column_name='private_key') = 0);
SELECT pg_temp.chk('cero secretos de rotación huérfanos',
  (SELECT count(*) FROM vault.secrets WHERE name LIKE 'arca-private-key-rotation:%')
   = (SELECT count(*) FROM private.arca_credential_rotations WHERE state='pending_rotation'));
SELECT pg_temp.chk('secreto active intacto',
  (SELECT count(*) FROM vault.secrets WHERE name LIKE 'arca-private-key:%') = 1);
SELECT pg_temp.chk('auditoría fingerprint truncado (<=16, hex o vacío)',
  (SELECT bool_and(fingerprint_trunc IS NULL OR (length(fingerprint_trunc) <= 16 AND fingerprint_trunc ~ '^[0-9a-f]*$'))
     FROM private.arca_credential_audit WHERE event LIKE 'arca_certificate_rotation%'));
SELECT pg_temp.chk('auditoría sin CUIT completo',
  NOT EXISTS (SELECT 1 FROM private.arca_credential_audit
              WHERE coalesce(fingerprint_trunc,'')||coalesce(status,'')||coalesce(error_code,'') LIKE '%20111111112%'));
SELECT pg_temp.chk('resolver service_role-only',
  has_function_privilege('service_role','public.arca_get_rotation_subject_safe(uuid)','EXECUTE')
  AND NOT has_function_privilege('anon','public.arca_get_rotation_subject_safe(uuid)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.arca_get_rotation_subject_safe(uuid)','EXECUTE'));
SELECT pg_temp.chk('prepare service_role-only',
  has_function_privilege('service_role','public.arca_prepare_certificate_rotation(uuid,text,text,text,text,integer,bigint,jsonb,text,uuid)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.arca_prepare_certificate_rotation(uuid,text,text,text,text,integer,bigint,jsonb,text,uuid)','EXECUTE'));

\echo '── AFIP-S4A/S4B-1b resultados ──'
SELECT n, (CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END) AS r, label FROM s4a_results ORDER BY n;
DO $v$
DECLARE f int;
BEGIN
  SELECT count(*) INTO f FROM s4a_results WHERE NOT ok;
  IF f > 0 THEN RAISE EXCEPTION 'AFIP-S4A/S4B-1b: % assert(s) fallaron', f;
  ELSE RAISE NOTICE 'AFIP-S4A/S4B-1b: % asserts OK', (SELECT count(*) FROM s4a_results); END IF;
END $v$;
ROLLBACK;
