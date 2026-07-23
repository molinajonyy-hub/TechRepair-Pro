-- ============================================================================
-- AFIP-S4A — tests del contrato de preparación de rotación (LOCAL, transaccional).
-- Fixtures SINTÉTICOS embebidos (RSA 1024, generados con node-forge). NUNCA
-- material productivo. Todo corre dentro de BEGIN…ROLLBACK: no deja rastro.
--
-- Cubre: preparación OK, replay idempotente, conflicto de idempotencia, pending
-- conflict, CSR mismatch, clave inválida, owner permitido, actor no-owner denegado,
-- credencial active intacta, arca_config (cert/token/sign/private_key) intactos,
-- cancelación pending + replay, cero huérfanos, auditoría sin secretos, grants
-- service_role-only.
-- RUN: docker exec -i <db> psql -X -U postgres -d postgres -f este_archivo.sql
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL request.jwt.claims = '{"role":"service_role"}';

-- ── Fixtures de identidad (negocio + owner sintéticos) ───────────────────────
\set biz '00000000-0000-4000-8000-0000000054a1'
\set usr '00000000-0000-4000-8000-0000000054a2'

INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
VALUES (:'usr', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        's4a-owner@test.local', '', now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.businesses (id, name, owner_user_id, subscription_plan, subscription_status)
VALUES (:'biz', 'S4A-test', :'usr', 'pro', 'active')
ON CONFLICT (id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id;

-- arca_config con cert/token/sign dummy para verificar que NO se tocan.
INSERT INTO public.arca_config (business_id, cuit, ambiente, punto_venta, web_service, alias,
        cert_file, private_key, wsaa_token, wsaa_sign, estado_conexion)
VALUES (:'biz', '20111111112', 'homologacion', 1, 'wsfe', 'r',
        '-----BEGIN CERTIFICATE-----\nDUMMYCERT\n-----END CERTIFICATE-----',
        '-----BEGIN RSA PRIVATE KEY-----\nDUMMYLEGACYKEY\n-----END RSA PRIVATE KEY-----',
        'DUMMYTOKEN', 'DUMMYSIGN', 'conectado')
ON CONFLICT (business_id) DO NOTHING;

-- Una credencial ACTIVE existente (debe quedar intacta tras preparar la rotación).
SELECT private.arca_store_private_key_secret(:'biz', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQC54hq4PExnWCr/70pLL0Dy1S6OAN/pX78+1Vmxx5+vondTnKDn
0VvurZyys1v/7Qe0mxlkiGFKC3Gv8CRsP0PB4+/yrqzqVmQCs452jgdXd9cKoPkp
WLM204FHMHVfE5rWf8CRxNf5MVD0Bup+INThmEGoE6AkrfuHA4p/7i3YrwIDAQAB
AoGBAKaa1cATq5dlGwVSAJDqxZfhI1z7w7V0sAEtULtbZPES+UjjtgSRTYjb6vrw
b6EvXhyud0/4PNsU7sz2vG6ZNaxn/8NDO7asd+P+BcolZVWdtLJ7cG0MRTuI9k0l
QqKix8lW7F1mBhEZ7QJatXMQghHMddXOVICl2czRBdeZ1TeBAkEA1xqfLvwnrwZB
URUizhjzJAk6+zp29KF9fdrg/7JpFDP8zJ/wNm5ZwXkQjijTpYEd5TfLejjF+xWP
11acRFWM/wJBAN05RXhEwZJ4elIG7sPs8wTFbNaGybIJN7ZkztdZlJPHYAHdIUsJ
jgEQ/z5JtBQjRh7GSFDE1NSRVdZwe5vXxFECQFUnHM0k1TDccQ8AJv8fsWEapla+
FklRhLRF6bxPjHmK+xCmYBmsJawJmRwt3Vsvef470DlaMEXtizvb9ZC3rVECQCBt
z9A0jAezn4K8v217I5i0dCLyeUie70rOdj+9QvlyxZEgYEwGp4lie3gfB8XX8eR6
/ojQgb5zW5jmvkf3FjECQQDPxsa2Mr89cnZ0iP4cp34nKFQmGZvKNN90+xS9ubUq
HfVWPLaZG0m2gkkMBVVY1v6nm0gi0KPdRL7RwfrOVH3K
-----END RSA PRIVATE KEY-----$p$,
        '7df61873a03248fa393cd8fa459c07f9061701a5d38caa8f11db8e08055b170a', NULL, 'RSA', 1024, :'usr', false) AS active_secret \gset

-- Snapshot PRE de lo que NO debe cambiar.
CREATE TEMP TABLE s4a_pre AS
SELECT
  (SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id = :'biz') AS active_cnt,
  (SELECT private_key_fingerprint FROM private.arca_private_key_credentials WHERE business_id = :'biz') AS active_fp,
  (SELECT md5(cert_file||coalesce(wsaa_token,'')||coalesce(wsaa_sign,'')||private_key) FROM public.arca_config WHERE business_id = :'biz') AS cfg_digest;

-- ── Motor de asserts ─────────────────────────────────────────────────────────
CREATE TEMP TABLE s4a_results (n serial, label text, ok boolean);
CREATE OR REPLACE FUNCTION pg_temp.chk(p_label text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $f$ BEGIN INSERT INTO s4a_results(label, ok) VALUES (p_label, coalesce(p_ok,false)); END $f$;

DO $t$
DECLARE r jsonb; v_pending uuid; v_secret uuid;
BEGIN
  -- 1) Preparación exitosa (clave A + CSR A)
  r := public.arca_prepare_certificate_rotation(
        '00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQC54hq4PExnWCr/70pLL0Dy1S6OAN/pX78+1Vmxx5+vondTnKDn
0VvurZyys1v/7Qe0mxlkiGFKC3Gv8CRsP0PB4+/yrqzqVmQCs452jgdXd9cKoPkp
WLM204FHMHVfE5rWf8CRxNf5MVD0Bup+INThmEGoE6AkrfuHA4p/7i3YrwIDAQAB
AoGBAKaa1cATq5dlGwVSAJDqxZfhI1z7w7V0sAEtULtbZPES+UjjtgSRTYjb6vrw
b6EvXhyud0/4PNsU7sz2vG6ZNaxn/8NDO7asd+P+BcolZVWdtLJ7cG0MRTuI9k0l
QqKix8lW7F1mBhEZ7QJatXMQghHMddXOVICl2czRBdeZ1TeBAkEA1xqfLvwnrwZB
URUizhjzJAk6+zp29KF9fdrg/7JpFDP8zJ/wNm5ZwXkQjijTpYEd5TfLejjF+xWP
11acRFWM/wJBAN05RXhEwZJ4elIG7sPs8wTFbNaGybIJN7ZkztdZlJPHYAHdIUsJ
jgEQ/z5JtBQjRh7GSFDE1NSRVdZwe5vXxFECQFUnHM0k1TDccQ8AJv8fsWEapla+
FklRhLRF6bxPjHmK+xCmYBmsJawJmRwt3Vsvef470DlaMEXtizvb9ZC3rVECQCBt
z9A0jAezn4K8v217I5i0dCLyeUie70rOdj+9QvlyxZEgYEwGp4lie3gfB8XX8eR6
/ojQgb5zW5jmvkf3FjECQQDPxsa2Mr89cnZ0iP4cp34nKFQmGZvKNN90+xS9ubUq
HfVWPLaZG0m2gkkMBVVY1v6nm0gi0KPdRL7RwfrOVH3K
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg
VW5vMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMRcwFQYDVQQDEw5UYWxsZXIg
UzRBIFVubzCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAueIauDxMZ1gq/+9K
Sy9A8tUujgDf6V+/PtVZscefr6J3U5yg59Fb7q2csrNb/+0HtJsZZIhhSgtxr/Ak
bD9DwePv8q6s6lZkArOOdo4HV3fXCqD5KVizNtOBRzB1XxOa1n/AkcTX+TFQ9Abq
fiDU4ZhBqBOgJK37hwOKf+4t2K8CAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBACbR
IYMXSBhYfqmODl+bwFACtUxri0VxRiz+L4BNv5uTDJbsAZ+rdu60j2l6quLeP1xn
Ysxa2E+Ei6hxg+LCBFfPxeRUasDgiUNsiAEJoCcbcP7Wf9n10SPWA24xJpqnk4+R
Ocn1j3b9fNlxDys0HR1qOWIk0R7FPdPVfA2/cVbY
-----END CERTIFICATE REQUEST-----$p$, '7df61873a03248fa393cd8fa459c07f9061701a5d38caa8f11db8e08055b170a',
        'RSA', 1024, 65537, '{"cn":"Taller"}'::jsonb, 'idem-A', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('1 prepared', r->>'state' = 'ROTATION_PREPARED');
  PERFORM pg_temp.chk('1 returns csr', (r->>'csr_pem') like '%CERTIFICATE REQUEST%');
  PERFORM pg_temp.chk('1 no key in return', (r::text) !~ 'PRIVATE KEY');

  -- pending row + vault secret
  SELECT id, private_key_secret_id INTO v_pending, v_secret
    FROM private.arca_credential_rotations WHERE business_id='00000000-0000-4000-8000-0000000054a1' AND state='pending_rotation';
  PERFORM pg_temp.chk('1 pending row', v_pending IS NOT NULL);
  PERFORM pg_temp.chk('1 vault secret exists', EXISTS(SELECT 1 FROM vault.secrets WHERE id = v_secret));
  PERFORM pg_temp.chk('1 pending fp matches', (SELECT private_key_fingerprint FROM private.arca_credential_rotations WHERE id=v_pending) = '7df61873a03248fa393cd8fa459c07f9061701a5d38caa8f11db8e08055b170a');

  -- 2) Replay idempotente (misma key + fp)
  r := public.arca_prepare_certificate_rotation(
        '00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQC54hq4PExnWCr/70pLL0Dy1S6OAN/pX78+1Vmxx5+vondTnKDn
0VvurZyys1v/7Qe0mxlkiGFKC3Gv8CRsP0PB4+/yrqzqVmQCs452jgdXd9cKoPkp
WLM204FHMHVfE5rWf8CRxNf5MVD0Bup+INThmEGoE6AkrfuHA4p/7i3YrwIDAQAB
AoGBAKaa1cATq5dlGwVSAJDqxZfhI1z7w7V0sAEtULtbZPES+UjjtgSRTYjb6vrw
b6EvXhyud0/4PNsU7sz2vG6ZNaxn/8NDO7asd+P+BcolZVWdtLJ7cG0MRTuI9k0l
QqKix8lW7F1mBhEZ7QJatXMQghHMddXOVICl2czRBdeZ1TeBAkEA1xqfLvwnrwZB
URUizhjzJAk6+zp29KF9fdrg/7JpFDP8zJ/wNm5ZwXkQjijTpYEd5TfLejjF+xWP
11acRFWM/wJBAN05RXhEwZJ4elIG7sPs8wTFbNaGybIJN7ZkztdZlJPHYAHdIUsJ
jgEQ/z5JtBQjRh7GSFDE1NSRVdZwe5vXxFECQFUnHM0k1TDccQ8AJv8fsWEapla+
FklRhLRF6bxPjHmK+xCmYBmsJawJmRwt3Vsvef470DlaMEXtizvb9ZC3rVECQCBt
z9A0jAezn4K8v217I5i0dCLyeUie70rOdj+9QvlyxZEgYEwGp4lie3gfB8XX8eR6
/ojQgb5zW5jmvkf3FjECQQDPxsa2Mr89cnZ0iP4cp34nKFQmGZvKNN90+xS9ubUq
HfVWPLaZG0m2gkkMBVVY1v6nm0gi0KPdRL7RwfrOVH3K
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg
VW5vMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMRcwFQYDVQQDEw5UYWxsZXIg
UzRBIFVubzCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAueIauDxMZ1gq/+9K
Sy9A8tUujgDf6V+/PtVZscefr6J3U5yg59Fb7q2csrNb/+0HtJsZZIhhSgtxr/Ak
bD9DwePv8q6s6lZkArOOdo4HV3fXCqD5KVizNtOBRzB1XxOa1n/AkcTX+TFQ9Abq
fiDU4ZhBqBOgJK37hwOKf+4t2K8CAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBACbR
IYMXSBhYfqmODl+bwFACtUxri0VxRiz+L4BNv5uTDJbsAZ+rdu60j2l6quLeP1xn
Ysxa2E+Ei6hxg+LCBFfPxeRUasDgiUNsiAEJoCcbcP7Wf9n10SPWA24xJpqnk4+R
Ocn1j3b9fNlxDys0HR1qOWIk0R7FPdPVfA2/cVbY
-----END CERTIFICATE REQUEST-----$p$, '7df61873a03248fa393cd8fa459c07f9061701a5d38caa8f11db8e08055b170a',
        'RSA', 1024, 65537, '{}'::jsonb, 'idem-A', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('2 replay already_prepared', r->>'state' = 'ROTATION_ALREADY_PREPARED');

  -- 3) Conflicto de idempotencia (misma key, distinto fingerprint → B)
  r := public.arca_prepare_certificate_rotation(
        '00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXAIBAAKBgQCzXMnITg+nB8f+BAUENaZ49cpuWKQ1I+XlPtDmUXTc9xrr+uh1
hq6oUBGKC5EevB8eEqYhWBZjDYPlzISz+Bm8hJWZS3iUwSl/s99kKebHaVu0yS60
K65O0HmyMXc3dMc7S8O2hQJLkYdXDU+uDmDkyw2iYWL2QmtcXfGROTsn1wIDAQAB
AoGBAKSaUtPwT40KJw+GwNPMKKp5Zv09e/UIrMJlk3DK8GSYoaxO52Zz43WzhWUa
mGOMYUJH+w4+uMzOam1J8771wSclp9+L/+Q1rCO8hC1Adku6F54QSjlnJ9alSUlC
hAUxqAztFKBontQIbQ30j6RG+7wPnatVTWyS+OgyM1gni34BAkEA698Ny7cGDzke
QYGmi9uK3RVsMEsYwaOxp1pOivlPERHyURmq6Hj1jvNMkjA7ntCPChs8i7mTdfTB
UP3FFXpCBwJBAMKrN7cxymXdv5i+Ih4y9PhFoszieebNIEWFnk4a/TR0zB/GHVR8
i/wsBSl6MORtyy710w89XcHiTCPJMFdcN7ECQHhJonF3fyGYUXO6uMKuTZz95dSj
F5b48gqUpWV+SvI7osX1PxGbTi9+qFgNPPp7BddzmGbxVuBa15OEN1QCq1UCQBap
9GyhoVzGul3AFRzK9fZJtTCBVYvnadBuRAX34m7PAkzYteV2Mp4DSf6QOUz+817e
Q9pMXLQL8q1f6P7iv6ECQHYP7+tr45s0aI8LAM+Bk/dga/4iORggFdwl7iUfPKzL
oTzmMJkHkZkqi87TNuj+4RweiAq3cCCKGuU+4dpmI+4=
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg
RG9zMRkwFwYDVQQFExBDVUlUIDIwMjIyMjIyMjIzMRcwFQYDVQQDEw5UYWxsZXIg
UzRBIERvczCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAs1zJyE4PpwfH/gQF
BDWmePXKblikNSPl5T7Q5lF03Pca6/rodYauqFARiguRHrwfHhKmIVgWYw2D5cyE
s/gZvISVmUt4lMEpf7PfZCnmx2lbtMkutCuuTtB5sjF3N3THO0vDtoUCS5GHVw1P
rg5g5MsNomFi9kJrXF3xkTk7J9cCAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBAK4F
bOO7mZBCMW0/UFF1Tz7qvrOIhWylNZzNLnumPohja7qZr+heHmMm9Ae90u8CeAGL
aaMhbbJxYAtu4/TvA97BojNQH0be56oRIhdZg+is7pdROdcWB7GwTrclAD8tS2zP
jtQzLdx+bjCPb0shMI/IRWNR941bIjduHWieEYwR
-----END CERTIFICATE REQUEST-----$p$, '638626e6efa6c0034aed77a0db54217aebb9994ef218e7800869af04e037da65',
        'RSA', 1024, 65537, '{}'::jsonb, 'idem-A', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('3 idempotency_conflict', r->>'state' = 'IDEMPOTENCY_CONFLICT');

  -- 4) Pending conflict (otra key, otra idem, ya hay pending)
  r := public.arca_prepare_certificate_rotation(
        '00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXAIBAAKBgQCzXMnITg+nB8f+BAUENaZ49cpuWKQ1I+XlPtDmUXTc9xrr+uh1
hq6oUBGKC5EevB8eEqYhWBZjDYPlzISz+Bm8hJWZS3iUwSl/s99kKebHaVu0yS60
K65O0HmyMXc3dMc7S8O2hQJLkYdXDU+uDmDkyw2iYWL2QmtcXfGROTsn1wIDAQAB
AoGBAKSaUtPwT40KJw+GwNPMKKp5Zv09e/UIrMJlk3DK8GSYoaxO52Zz43WzhWUa
mGOMYUJH+w4+uMzOam1J8771wSclp9+L/+Q1rCO8hC1Adku6F54QSjlnJ9alSUlC
hAUxqAztFKBontQIbQ30j6RG+7wPnatVTWyS+OgyM1gni34BAkEA698Ny7cGDzke
QYGmi9uK3RVsMEsYwaOxp1pOivlPERHyURmq6Hj1jvNMkjA7ntCPChs8i7mTdfTB
UP3FFXpCBwJBAMKrN7cxymXdv5i+Ih4y9PhFoszieebNIEWFnk4a/TR0zB/GHVR8
i/wsBSl6MORtyy710w89XcHiTCPJMFdcN7ECQHhJonF3fyGYUXO6uMKuTZz95dSj
F5b48gqUpWV+SvI7osX1PxGbTi9+qFgNPPp7BddzmGbxVuBa15OEN1QCq1UCQBap
9GyhoVzGul3AFRzK9fZJtTCBVYvnadBuRAX34m7PAkzYteV2Mp4DSf6QOUz+817e
Q9pMXLQL8q1f6P7iv6ECQHYP7+tr45s0aI8LAM+Bk/dga/4iORggFdwl7iUfPKzL
oTzmMJkHkZkqi87TNuj+4RweiAq3cCCKGuU+4dpmI+4=
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg
RG9zMRkwFwYDVQQFExBDVUlUIDIwMjIyMjIyMjIzMRcwFQYDVQQDEw5UYWxsZXIg
UzRBIERvczCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAs1zJyE4PpwfH/gQF
BDWmePXKblikNSPl5T7Q5lF03Pca6/rodYauqFARiguRHrwfHhKmIVgWYw2D5cyE
s/gZvISVmUt4lMEpf7PfZCnmx2lbtMkutCuuTtB5sjF3N3THO0vDtoUCS5GHVw1P
rg5g5MsNomFi9kJrXF3xkTk7J9cCAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBAK4F
bOO7mZBCMW0/UFF1Tz7qvrOIhWylNZzNLnumPohja7qZr+heHmMm9Ae90u8CeAGL
aaMhbbJxYAtu4/TvA97BojNQH0be56oRIhdZg+is7pdROdcWB7GwTrclAD8tS2zP
jtQzLdx+bjCPb0shMI/IRWNR941bIjduHWieEYwR
-----END CERTIFICATE REQUEST-----$p$, '638626e6efa6c0034aed77a0db54217aebb9994ef218e7800869af04e037da65',
        'RSA', 1024, 65537, '{}'::jsonb, 'idem-B', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('4 pending_conflict', r->>'state' = 'ROTATION_PENDING_CONFLICT');

  -- 5) CSR mismatch (clave A, CSR B) con idem nueva → primero cancelamos el pending
  r := public.arca_cancel_certificate_rotation('00000000-0000-4000-8000-0000000054a1', 'idem-A', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('5a cancel pending', r->>'state' = 'ROTATION_CANCELLED');
  PERFORM pg_temp.chk('5a secret removed', NOT EXISTS(SELECT 1 FROM vault.secrets WHERE id = v_secret));
  r := public.arca_prepare_certificate_rotation(
        '00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQC54hq4PExnWCr/70pLL0Dy1S6OAN/pX78+1Vmxx5+vondTnKDn
0VvurZyys1v/7Qe0mxlkiGFKC3Gv8CRsP0PB4+/yrqzqVmQCs452jgdXd9cKoPkp
WLM204FHMHVfE5rWf8CRxNf5MVD0Bup+INThmEGoE6AkrfuHA4p/7i3YrwIDAQAB
AoGBAKaa1cATq5dlGwVSAJDqxZfhI1z7w7V0sAEtULtbZPES+UjjtgSRTYjb6vrw
b6EvXhyud0/4PNsU7sz2vG6ZNaxn/8NDO7asd+P+BcolZVWdtLJ7cG0MRTuI9k0l
QqKix8lW7F1mBhEZ7QJatXMQghHMddXOVICl2czRBdeZ1TeBAkEA1xqfLvwnrwZB
URUizhjzJAk6+zp29KF9fdrg/7JpFDP8zJ/wNm5ZwXkQjijTpYEd5TfLejjF+xWP
11acRFWM/wJBAN05RXhEwZJ4elIG7sPs8wTFbNaGybIJN7ZkztdZlJPHYAHdIUsJ
jgEQ/z5JtBQjRh7GSFDE1NSRVdZwe5vXxFECQFUnHM0k1TDccQ8AJv8fsWEapla+
FklRhLRF6bxPjHmK+xCmYBmsJawJmRwt3Vsvef470DlaMEXtizvb9ZC3rVECQCBt
z9A0jAezn4K8v217I5i0dCLyeUie70rOdj+9QvlyxZEgYEwGp4lie3gfB8XX8eR6
/ojQgb5zW5jmvkf3FjECQQDPxsa2Mr89cnZ0iP4cp34nKFQmGZvKNN90+xS9ubUq
HfVWPLaZG0m2gkkMBVVY1v6nm0gi0KPdRL7RwfrOVH3K
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg
RG9zMRkwFwYDVQQFExBDVUlUIDIwMjIyMjIyMjIzMRcwFQYDVQQDEw5UYWxsZXIg
UzRBIERvczCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAs1zJyE4PpwfH/gQF
BDWmePXKblikNSPl5T7Q5lF03Pca6/rodYauqFARiguRHrwfHhKmIVgWYw2D5cyE
s/gZvISVmUt4lMEpf7PfZCnmx2lbtMkutCuuTtB5sjF3N3THO0vDtoUCS5GHVw1P
rg5g5MsNomFi9kJrXF3xkTk7J9cCAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBAK4F
bOO7mZBCMW0/UFF1Tz7qvrOIhWylNZzNLnumPohja7qZr+heHmMm9Ae90u8CeAGL
aaMhbbJxYAtu4/TvA97BojNQH0be56oRIhdZg+is7pdROdcWB7GwTrclAD8tS2zP
jtQzLdx+bjCPb0shMI/IRWNR941bIjduHWieEYwR
-----END CERTIFICATE REQUEST-----$p$, '7df61873a03248fa393cd8fa459c07f9061701a5d38caa8f11db8e08055b170a',
        'RSA', 1024, 65537, '{}'::jsonb, 'idem-mix', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('5 csr_key_mismatch', r->>'state' = 'CSR_KEY_MISMATCH');

  -- 6) Clave inválida (basura)
  r := public.arca_prepare_certificate_rotation(
        '00000000-0000-4000-8000-0000000054a1', 'no-es-una-clave', $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg
VW5vMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMRcwFQYDVQQDEw5UYWxsZXIg
UzRBIFVubzCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAueIauDxMZ1gq/+9K
Sy9A8tUujgDf6V+/PtVZscefr6J3U5yg59Fb7q2csrNb/+0HtJsZZIhhSgtxr/Ak
bD9DwePv8q6s6lZkArOOdo4HV3fXCqD5KVizNtOBRzB1XxOa1n/AkcTX+TFQ9Abq
fiDU4ZhBqBOgJK37hwOKf+4t2K8CAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBACbR
IYMXSBhYfqmODl+bwFACtUxri0VxRiz+L4BNv5uTDJbsAZ+rdu60j2l6quLeP1xn
Ysxa2E+Ei6hxg+LCBFfPxeRUasDgiUNsiAEJoCcbcP7Wf9n10SPWA24xJpqnk4+R
Ocn1j3b9fNlxDys0HR1qOWIk0R7FPdPVfA2/cVbY
-----END CERTIFICATE REQUEST-----$p$, '7df61873a03248fa393cd8fa459c07f9061701a5d38caa8f11db8e08055b170a',
        'RSA', 1024, 65537, '{}'::jsonb, 'idem-bad', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('6 key_generation_failed', r->>'state' = 'KEY_GENERATION_FAILED');

  -- 7) Actor no-owner → UNAUTHORIZED
  r := public.arca_prepare_certificate_rotation(
        '00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQC54hq4PExnWCr/70pLL0Dy1S6OAN/pX78+1Vmxx5+vondTnKDn
0VvurZyys1v/7Qe0mxlkiGFKC3Gv8CRsP0PB4+/yrqzqVmQCs452jgdXd9cKoPkp
WLM204FHMHVfE5rWf8CRxNf5MVD0Bup+INThmEGoE6AkrfuHA4p/7i3YrwIDAQAB
AoGBAKaa1cATq5dlGwVSAJDqxZfhI1z7w7V0sAEtULtbZPES+UjjtgSRTYjb6vrw
b6EvXhyud0/4PNsU7sz2vG6ZNaxn/8NDO7asd+P+BcolZVWdtLJ7cG0MRTuI9k0l
QqKix8lW7F1mBhEZ7QJatXMQghHMddXOVICl2czRBdeZ1TeBAkEA1xqfLvwnrwZB
URUizhjzJAk6+zp29KF9fdrg/7JpFDP8zJ/wNm5ZwXkQjijTpYEd5TfLejjF+xWP
11acRFWM/wJBAN05RXhEwZJ4elIG7sPs8wTFbNaGybIJN7ZkztdZlJPHYAHdIUsJ
jgEQ/z5JtBQjRh7GSFDE1NSRVdZwe5vXxFECQFUnHM0k1TDccQ8AJv8fsWEapla+
FklRhLRF6bxPjHmK+xCmYBmsJawJmRwt3Vsvef470DlaMEXtizvb9ZC3rVECQCBt
z9A0jAezn4K8v217I5i0dCLyeUie70rOdj+9QvlyxZEgYEwGp4lie3gfB8XX8eR6
/ojQgb5zW5jmvkf3FjECQQDPxsa2Mr89cnZ0iP4cp34nKFQmGZvKNN90+xS9ubUq
HfVWPLaZG0m2gkkMBVVY1v6nm0gi0KPdRL7RwfrOVH3K
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg
VW5vMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMRcwFQYDVQQDEw5UYWxsZXIg
UzRBIFVubzCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAueIauDxMZ1gq/+9K
Sy9A8tUujgDf6V+/PtVZscefr6J3U5yg59Fb7q2csrNb/+0HtJsZZIhhSgtxr/Ak
bD9DwePv8q6s6lZkArOOdo4HV3fXCqD5KVizNtOBRzB1XxOa1n/AkcTX+TFQ9Abq
fiDU4ZhBqBOgJK37hwOKf+4t2K8CAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBACbR
IYMXSBhYfqmODl+bwFACtUxri0VxRiz+L4BNv5uTDJbsAZ+rdu60j2l6quLeP1xn
Ysxa2E+Ei6hxg+LCBFfPxeRUasDgiUNsiAEJoCcbcP7Wf9n10SPWA24xJpqnk4+R
Ocn1j3b9fNlxDys0HR1qOWIk0R7FPdPVfA2/cVbY
-----END CERTIFICATE REQUEST-----$p$, '7df61873a03248fa393cd8fa459c07f9061701a5d38caa8f11db8e08055b170a',
        'RSA', 1024, 65537, '{}'::jsonb, 'idem-unauth', '00000000-0000-4000-8000-00000000dead');
  PERFORM pg_temp.chk('7 unauthorized', r->>'state' = 'UNAUTHORIZED');

  -- 8) Cancel de algo inexistente → NO_PENDING_ROTATION
  r := public.arca_cancel_certificate_rotation('00000000-0000-4000-8000-0000000054a1', 'idem-nope', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('8 no_pending_rotation', r->>'state' = 'NO_PENDING_ROTATION');

  -- 9) Preparar de nuevo (idem-final) y cancelar dos veces (replay de cancel)
  r := public.arca_prepare_certificate_rotation(
        '00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQC54hq4PExnWCr/70pLL0Dy1S6OAN/pX78+1Vmxx5+vondTnKDn
0VvurZyys1v/7Qe0mxlkiGFKC3Gv8CRsP0PB4+/yrqzqVmQCs452jgdXd9cKoPkp
WLM204FHMHVfE5rWf8CRxNf5MVD0Bup+INThmEGoE6AkrfuHA4p/7i3YrwIDAQAB
AoGBAKaa1cATq5dlGwVSAJDqxZfhI1z7w7V0sAEtULtbZPES+UjjtgSRTYjb6vrw
b6EvXhyud0/4PNsU7sz2vG6ZNaxn/8NDO7asd+P+BcolZVWdtLJ7cG0MRTuI9k0l
QqKix8lW7F1mBhEZ7QJatXMQghHMddXOVICl2czRBdeZ1TeBAkEA1xqfLvwnrwZB
URUizhjzJAk6+zp29KF9fdrg/7JpFDP8zJ/wNm5ZwXkQjijTpYEd5TfLejjF+xWP
11acRFWM/wJBAN05RXhEwZJ4elIG7sPs8wTFbNaGybIJN7ZkztdZlJPHYAHdIUsJ
jgEQ/z5JtBQjRh7GSFDE1NSRVdZwe5vXxFECQFUnHM0k1TDccQ8AJv8fsWEapla+
FklRhLRF6bxPjHmK+xCmYBmsJawJmRwt3Vsvef470DlaMEXtizvb9ZC3rVECQCBt
z9A0jAezn4K8v217I5i0dCLyeUie70rOdj+9QvlyxZEgYEwGp4lie3gfB8XX8eR6
/ojQgb5zW5jmvkf3FjECQQDPxsa2Mr89cnZ0iP4cp34nKFQmGZvKNN90+xS9ubUq
HfVWPLaZG0m2gkkMBVVY1v6nm0gi0KPdRL7RwfrOVH3K
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg
VW5vMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMRcwFQYDVQQDEw5UYWxsZXIg
UzRBIFVubzCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAueIauDxMZ1gq/+9K
Sy9A8tUujgDf6V+/PtVZscefr6J3U5yg59Fb7q2csrNb/+0HtJsZZIhhSgtxr/Ak
bD9DwePv8q6s6lZkArOOdo4HV3fXCqD5KVizNtOBRzB1XxOa1n/AkcTX+TFQ9Abq
fiDU4ZhBqBOgJK37hwOKf+4t2K8CAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBACbR
IYMXSBhYfqmODl+bwFACtUxri0VxRiz+L4BNv5uTDJbsAZ+rdu60j2l6quLeP1xn
Ysxa2E+Ei6hxg+LCBFfPxeRUasDgiUNsiAEJoCcbcP7Wf9n10SPWA24xJpqnk4+R
Ocn1j3b9fNlxDys0HR1qOWIk0R7FPdPVfA2/cVbY
-----END CERTIFICATE REQUEST-----$p$, '7df61873a03248fa393cd8fa459c07f9061701a5d38caa8f11db8e08055b170a',
        'RSA', 1024, 65537, '{}'::jsonb, 'idem-final', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('9 reprepared', r->>'state' = 'ROTATION_PREPARED');
  r := public.arca_cancel_certificate_rotation('00000000-0000-4000-8000-0000000054a1', 'idem-final', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('9 cancel', r->>'state' = 'ROTATION_CANCELLED');
  r := public.arca_cancel_certificate_rotation('00000000-0000-4000-8000-0000000054a1', 'idem-final', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('9 cancel replay idempotent', r->>'state' = 'ROTATION_CANCELLED');
END $t$;

-- ── Invariantes de integridad y aislamiento ──────────────────────────────────
SELECT pg_temp.chk('10 active credential intacta (count)',
  (SELECT active_cnt FROM s4a_pre) = (SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-0000000054a1'));
SELECT pg_temp.chk('10 active credential intacta (fp)',
  (SELECT active_fp FROM s4a_pre) = (SELECT private_key_fingerprint FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-0000000054a1'));
SELECT pg_temp.chk('11 arca_config intacto (cert/token/sign/private_key)',
  (SELECT cfg_digest FROM s4a_pre) = (SELECT md5(cert_file||coalesce(wsaa_token,'')||coalesce(wsaa_sign,'')||private_key) FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000054a1'));

-- Cero huérfanos: todo secreto de rotación pendiente tiene fila pending y viceversa.
SELECT pg_temp.chk('12 cero secretos de rotación huérfanos',
  (SELECT count(*) FROM vault.secrets WHERE name LIKE 'arca-private-key-rotation:%')
   = (SELECT count(*) FROM private.arca_credential_rotations WHERE state='pending_rotation'));
-- El secreto ACTIVE (arca-private-key:) no se confunde con los de rotación.
SELECT pg_temp.chk('12 secreto active no matchea patrón rotación',
  (SELECT count(*) FROM vault.secrets WHERE name LIKE 'arca-private-key:%') = 1);

-- Auditoría sin secretos: fingerprint_trunc <= 16 hex; ningún evento con material.
SELECT pg_temp.chk('13 auditoría fingerprint truncado (<=16, hex o vacío, nunca PEM)',
  (SELECT bool_and(fingerprint_trunc IS NULL OR (length(fingerprint_trunc) <= 16 AND fingerprint_trunc ~ '^[0-9a-f]*$'))
     FROM private.arca_credential_audit WHERE event LIKE 'arca_certificate_rotation%'));
SELECT pg_temp.chk('13 eventos de rotación registrados',
  (SELECT count(*) FROM private.arca_credential_audit WHERE event='arca_certificate_rotation_prepared') >= 2
  AND (SELECT count(*) FROM private.arca_credential_audit WHERE event='arca_certificate_rotation_cancelled') >= 2);

-- Grants: service_role-only (anon/authenticated sin EXECUTE).
SELECT pg_temp.chk('14 prepare service_role-only',
  has_function_privilege('service_role','public.arca_prepare_certificate_rotation(uuid,text,text,text,text,integer,bigint,jsonb,text,uuid)','EXECUTE')
  AND NOT has_function_privilege('anon','public.arca_prepare_certificate_rotation(uuid,text,text,text,text,integer,bigint,jsonb,text,uuid)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.arca_prepare_certificate_rotation(uuid,text,text,text,text,integer,bigint,jsonb,text,uuid)','EXECUTE'));
SELECT pg_temp.chk('14 cancel service_role-only',
  has_function_privilege('service_role','public.arca_cancel_certificate_rotation(uuid,text,uuid)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.arca_cancel_certificate_rotation(uuid,text,uuid)','EXECUTE'));

-- ── Veredicto ────────────────────────────────────────────────────────────────
\echo '── AFIP-S4A resultados ──'
SELECT n, (CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END) AS r, label FROM s4a_results ORDER BY n;
DO $v$
DECLARE f int;
BEGIN
  SELECT count(*) INTO f FROM s4a_results WHERE NOT ok;
  IF f > 0 THEN RAISE EXCEPTION 'AFIP-S4A: % assert(s) fallaron', f;
  ELSE RAISE NOTICE 'AFIP-S4A: % asserts OK', (SELECT count(*) FROM s4a_results); END IF;
END $v$;
ROLLBACK;
