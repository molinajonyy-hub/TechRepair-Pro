-- ============================================================================
-- AFIP-S4B-2A — activación y rollback ATÓMICOS de la rotación.
-- Fixtures SINTÉTICOS embebidos (RSA 1024 + certificados autofirmados generados
-- con node-forge). NUNCA se usa el certificado productivo emitido por ARCA.
-- Todo dentro de BEGIN…ROLLBACK.
-- RUN: docker exec -i <db> psql -X -U postgres -d postgres -f este.sql
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL request.jwt.claims = '{"role":"service_role"}';

INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-0000000054e2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        's4b2-owner@test.local', '', now(), now()) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.businesses (id, name, owner_user_id, subscription_plan, subscription_status)
VALUES ('00000000-0000-4000-8000-0000000054e1', 'S4B2-test', '00000000-0000-4000-8000-0000000054e2', 'pro', 'active')
ON CONFLICT (id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id;

-- Config con el par VIGENTE (certificado + alias + CUIT) y cache WSAA poblado.
-- AFIP-S4C: `private_key` ya no existe; la clave vive sólo en Vault.
INSERT INTO public.arca_config (business_id, cuit, alias, ambiente, punto_venta, web_service,
        cert_file, wsaa_token, wsaa_sign, wsaa_token_expires, estado_conexion)
VALUES ('00000000-0000-4000-8000-0000000054e1', '20111111112', 'fixture.alias', 'homologacion', 1, 'wsfe',
        $p$-----BEGIN CERTIFICATE-----
MIIC3zCCAcegAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBAMxrzuA62uymiUVg+J2S71mTV6J9mrYOC+udDgBMm8WTYfIYkqt/
8pJEWWpBwMvxJyzmfaIvg242csdBZ4aYuFkvfMtjxijwaUu9ayLo3dxJk9qs8o5u
7yrXBmeVxi/1I3O0gGs2tvPGqubXlEuTGGoriN9L2y0EX5eMY0SobRkaJQ1WrBmb
i990q70VUhFypoAq2rUUVyr5W/c0kz2z2RrVcom/bKiVknGZJxF36eivXQJ/uPT8
CsGBi/mjdpkHkQ1r2fuu87Vn20SLxPUhT12HTrEVZBNu6jfIkNqyfGZj1dHap/3a
jgcH/y8dyC3OwfOmDw3pvX9OEO0tFOPqh4cCAwEAATANBgkqhkiG9w0BAQsFAAOC
AQEAy3IM4Ch3zomXmSVrWJxdV82HiGGsTkp/buzC77LwM+RjQGGUj+glJwnEWAOQ
fAZBxHznL3mTaA9btN49VTnI8uDcGlpQT8Ln2JBk/wshFzJsbP13nPMhpWMGq7pr
jr83fJmKldeMmIWgYcgVJw3HDfifzadVBtlVzI+aVo9AdMHJYxrkX5KN30h89Rzn
iRINXRIlaL9Ps8PNrtZ2UxegPGmb0IwnK4XhrlRyj8EInaLPnS/w/Gv0sGQqLSKV
umg23sHBXkwxZDP9dmDfuiJI4duR6DGi1fkksrc+n/9UKdlqQz546WWf9btVC77S
Q2Ik8rRYIrxdCTu1leoP98kHQw==
-----END CERTIFICATE-----$p$,
        'TOKEN_VIEJO', 'SIGN_VIEJO', now() + interval '6 hours', 'conectado')
ON CONFLICT (business_id) DO NOTHING;

-- Credencial VIGENTE en Vault.
SELECT private.arca_store_private_key_secret('00000000-0000-4000-8000-0000000054e1', $p$-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAzGvO4Dra7KaJRWD4nZLvWZNXon2atg4L650OAEybxZNh8hiS
q3/ykkRZakHAy/EnLOZ9oi+DbjZyx0Fnhpi4WS98y2PGKPBpS71rIujd3EmT2qzy
jm7vKtcGZ5XGL/Ujc7SAaza288aq5teUS5MYaiuI30vbLQRfl4xjRKhtGRolDVas
GZuL33SrvRVSEXKmgCratRRXKvlb9zSTPbPZGtVyib9sqJWScZknEXfp6K9dAn+4
9PwKwYGL+aN2mQeRDWvZ+67ztWfbRIvE9SFPXYdOsRVkE27qN8iQ2rJ8ZmPV0dqn
/dqOBwf/Lx3ILc7B86YPDem9f04Q7S0U4+qHhwIDAQABAoIBAAGZom/s5gPONere
HHQXT1pTJe92rjxYlc1NWGu2Lc35Hl4nxRYklUCB2nVTeG/gPl9Cmp8nYg79zB41
K9tI3MCN95sb99QgNaLLI8iNLBdqWAbxLaDhy2t5bWpoKLn9YD6qngq4zevQlUvj
ShzhVOKX3qVo0ZljnF/yUGCcNOZqY2QPeFmFcPvScD4+1yXp2u76SkwrthC5o/Ny
0SNorwjO+y6oom4/3pxqIhedEd23YfIQ54mt8SrvRkjps8zhacw0iCsguGj5qZ6/
0uqAqFz50uJtLWsNnoBKKN7qmUuYIDrMoF7UvaSiBkkO3tW5JB+U+jNv0E7rawlB
SDrTBGkCgYEA74NsgtuS0maYvvTa112Ro1Uwjjx1Rji5qOL98dDyAFLrMArUD2pH
UbcB6JAulkpmoq3uWa6sU6iND79UKfzyNzI2OH2f69j29zcrY6sgseAx0sgt4JJg
R177U1hLYr08gdlfDEAck/MfVGZm6vp9I3xZiaALj0oq2FpUunT39xsCgYEA2n4B
6N9S08n9U701SutE5M+LYLOAggHdjZuQqUvpDG8UrncGxBm6HKhBKKye623BKWOd
DCUi4RO+eyLcqqJ20k/RI+hoFnwXxGh5/1EzlTBkBoOSQgRIPxZZ4qYZJYqAvc0j
sfgSkxeRYOMVu3gyQckWvB2Ee7CIi5MvcNYfXAUCgYEA5RnxUbp2VouM0BumuRrn
lDSInYV3KBRagxGdlxEmaujlzq6M6bHfRmqniK1h4qCITFPTCjXq4Jr5U3bQKtmp
VuLQunhv4ElI8m/zMQMf4wVwow6X05gwQBS6kp6CfZBFsG8cW7t3mo2UCkdpaprv
2GG5w8szQ3zOPuUo5rG7/sECgYEAlQLLGp70RizD8JBiAC5kVgiV7eV+ByxuhV1L
U6rJzgkT+ciDfMpu+4xko/DWkYnQ6wFc4iORnh9xEVm9VUJn9xcoc2zVUEBhlToL
ue0PWPgfv7GL1ipFe4Eq3ECbddb35no5le6x/E9efs1gzPI0lFkogDNBX3oOJeLD
wBjIWmECgYBhGaW8SQkTSBgvhtZ+H07KKHKWogiTZYLYWvCPj/ssU3X3ejR4wm12
JwjHajEqQbQze7Rp0h9sAvpCIP5eyAef+vBlqEuSy4m8FmgoE+bu/aeKApbFXzs6
0aqIANL9cUE29J+PxprrID8mavLBc9OSQC///seumhaMA2TMeVmgwg==
-----END RSA PRIVATE KEY-----$p$, '13861caf92ad1ae5c91cac27e49baca86328d7287ef642742cf3435b34a1366e', NULL, 'RSA', 2048, '00000000-0000-4000-8000-0000000054e2', false) AS s \gset

-- Rotación PENDIENTE (clave nueva + CSR) por el contrato real de S4A/S4B-1b.
\echo '── setup: preparando rotación pendiente ──'
SELECT public.arca_prepare_certificate_rotation('00000000-0000-4000-8000-0000000054e1', $p$-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAutdg4soIt1bB667K+wf732iNmUoBS2pQbUNHR02XWHPc0+CC
fw3b/1kATduWRX35mRObZHYxGVz2UOGu9IQPv8Sd9OyYf3buBezkxmcTu8Lb2Vv4
XEyqmlMLx7GeCvjAdLSyXEHLDQmnDvV0TaOuHCv12ej7VajR2u0PcL4mFRJsq13Q
25zc5ESqNSr4YYLOu8XWhX5rGMEwDvlYiEDxeQES1GKFMlXl7BgpVlL12OYEJcBM
EkfrRki/4zUhC5Rf+akNCijcc9MooZorTqqVE/Y97uw8h0MsEzNvImvK0SWa9te/
PcFYdWsl0EW5jzrKuSgYCTZrUqn9HlXEM74KSQIDAQABAoIBAQC1hjsjG5aMSUXu
bMvYSFF1JGct3rCTTJ8HCK5foArCbQ7G6wDd3+E1nIqnGghNS68MAfifChV5xs+o
lRsdhJCoh6XPJ26hqDJon1dFSy/o49AkxS3uvq2hcb2oLfCWSEbzG/uNln5oFFCy
P9bW94dY53zcUXaeKn54bIjryFHHdYtNacvaa8tiXhsl+Hbsw5nhOxzGjt2fzY1B
wSwUyw5V12uulMuXhH2Ig3L1qbNtcdHWInMPS2sVvvXfYWg/78KSZQr8gHqcc77z
oWnBuMBXW48OnB8eynDrYg6SfhVtyxF0ncejnWHCxhIvbYGmE152kThXLsKA6sTe
uyBbBJZhAoGBAPU68Py9joYKwGFSYc45JHUIZpIs/WGquthvHqTll0hT37/u4EnI
Teby/w+ryOz+Scq8eYvkil5/uBOdYsmX3r7MEmxBplljRy449TQ1p7KWg4ejJrRs
gIio2Kmv0gD6YEZDd52RghiGvSsDf9923sXWLnqyJGrZqSS6QdDqr2gvAoGBAMML
/GhIrQRrJzWqxbQPPNcPT7ULbCUhCqHMolNPU7xgQhf6gqx0zl5SWf61IoYTO0AJ
kZfu9fUdHMz1egzz6yRONIDvD8BZ22lhRvU4M3o+SvZ0xN2FzHMlDz2IbASnIff4
gDcGUhOkBpLq4WF2a+Po7USIB2FzcyLIPUDwU58HAoGAALvAZMEcYAJAOQpKCJfb
KA5yYBWKXHRqQqNycAPPxAOcM7K/MPlMYlhvsthMrYjFJ7oQkv6H+2heYJCj7v5p
SCDMHU7E9Jd7awP4l8NhUQNqOUmfoAKDD+WRYFCKTD5zc0JYZTw+K1ybzDkidMSi
Pe06DlviB//Gpbl44OsSwzkCgYA2wsa7AKyS8QKxLqETTLPoLYRTcEGMqxoxEyMA
AOWhneTwloTZpnHKSZS6zmBDBGM+N3GJFq43g1Tytnjt6g26w7o5+OSTPKc9jvI9
JupNB/BEAcTD7SzZpy4AOK0bIVGILVzSFhQ1L3gpB4j/tB/WfS8gbpCj66YHvfB0
qwTPQQKBgCFpM497imJSuj+c1raD/N8TebN/+OFKmGRNRGsjWBfuHp+U7FKvCSie
oyYrUH/8YXIgVL6PaUOKMGlVOrPINO5ZvNaLlgaehUvarx5gCO9Hp0eom4uvfDdm
yxpWoxJOZdgTlNNFgbQ8AKsfYq8H+vg0PJeyP66pT/toJ12U4Mip
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIICeDCCAWACAQAwMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZMBcGA1UEBRMQ
Q1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
ALrXYOLKCLdWweuuyvsH+99ojZlKAUtqUG1DR0dNl1hz3NPggn8N2/9ZAE3blkV9
+ZkTm2R2MRlc9lDhrvSED7/EnfTsmH927gXs5MZnE7vC29lb+FxMqppTC8exngr4
wHS0slxByw0Jpw71dE2jrhwr9dno+1Wo0drtD3C+JhUSbKtd0Nuc3OREqjUq+GGC
zrvF1oV+axjBMA75WIhA8XkBEtRihTJV5ewYKVZS9djmBCXATBJH60ZIv+M1IQuU
X/mpDQoo3HPTKKGaK06qlRP2Pe7sPIdDLBMzbyJrytElmvbXvz3BWHVrJdBFuY86
yrkoGAk2a1Kp/R5VxDO+CkkCAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4IBAQCHwQOB
ytwmU9YgzrLtokWQAc/zHn/p84fCX2saY/ZkBK6ktpcuhsRLta165HCiQwUuwR2K
LFlwep+ff6fzhqYIEe6FknzI6Pb2hTrRBIa5W1lkgnxUNJ49kb5T988zNZzj7jhC
VHlvOrH7xoiE5UWVj5AAK2XwnWwlphNIotDv5LXBjB/Lb4din3tuHLqt0HsMV1ID
ZJ/FjJ7XpJjt0sVoul02iYpdXA5/qy7DkytBlpdkd/gO/bL90vfuHlsoLn0+JgwU
v6S5yIdbnkFPHT/ss9hATh/h5Rs40yU+0btz08IjKKR3xLGBiXSsk03/32MMAr3u
86Uocxe/wymOu5Xu
-----END CERTIFICATE REQUEST-----$p$,
       'dd04bd34d4fe9b08fad856d1bed1ba8250b501a6aa1ae8077d2d515a514c11fb', 'RSA', 2048, 65537, NULL, 'idem-prep-1', '00000000-0000-4000-8000-0000000054e2')->>'state' AS setup_prepare_state;
SELECT count(*) AS pendings_creadas FROM private.arca_credential_rotations WHERE business_id='00000000-0000-4000-8000-0000000054e1';

CREATE TEMP TABLE s4b2_pre AS
SELECT (SELECT private_key_fingerprint FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-0000000054e1') AS active_fp,
       (SELECT private_key_secret_id   FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-0000000054e1') AS active_secret,
       (SELECT md5(cert_file) FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000054e1')            AS cert_md5,
       -- AFIP-S4C: ya no hay plaintext que fotografiar; el equivalente vigente es
       -- que la activación no reintroduzca ninguna columna de clave en claro.
       (SELECT count(*) FROM information_schema.columns
         WHERE table_schema='public' AND table_name='arca_config' AND column_name='private_key') AS cols_plaintext,
       (SELECT wsaa_token FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000054e1')                AS token,
       (SELECT estado_conexion FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000054e1')           AS estado;

CREATE TEMP TABLE s4b2_results (n serial, label text, ok boolean);
CREATE OR REPLACE FUNCTION pg_temp.chk(l text, ok boolean) RETURNS void
LANGUAGE plpgsql AS $f$ BEGIN INSERT INTO s4b2_results(label, ok) VALUES (l, coalesce(ok,false)); END $f$;
-- Invariante reutilizable: nada del par vigente cambió.
CREATE OR REPLACE FUNCTION pg_temp.sin_cambios() RETURNS boolean LANGUAGE sql AS $f$
  SELECT (SELECT active_fp FROM s4b2_pre) = (SELECT private_key_fingerprint FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-0000000054e1')
     AND (SELECT cert_md5 FROM s4b2_pre)  = (SELECT md5(cert_file) FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000054e1')
     AND (SELECT token FROM s4b2_pre)     IS NOT DISTINCT FROM (SELECT wsaa_token FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000054e1')
     AND (SELECT state FROM private.arca_credential_rotations WHERE business_id='00000000-0000-4000-8000-0000000054e1') = 'pending_rotation';
$f$;

DO $t$
DECLARE r jsonb; v_rot uuid; v_prev_secret uuid; v_new_secret uuid;
BEGIN
  SELECT id, private_key_secret_id INTO v_rot, v_new_secret
    FROM private.arca_credential_rotations WHERE business_id='00000000-0000-4000-8000-0000000054e1';
  SELECT private_key_secret_id INTO v_prev_secret
    FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-0000000054e1';

  -- ── 3: certificado de la clave ACTIVA vieja ──
  r := public.arca_activate_certificate_rotation('00000000-0000-4000-8000-0000000054e1', NULL, $p$-----BEGIN CERTIFICATE-----
MIIC3zCCAcegAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBAMxrzuA62uymiUVg+J2S71mTV6J9mrYOC+udDgBMm8WTYfIYkqt/
8pJEWWpBwMvxJyzmfaIvg242csdBZ4aYuFkvfMtjxijwaUu9ayLo3dxJk9qs8o5u
7yrXBmeVxi/1I3O0gGs2tvPGqubXlEuTGGoriN9L2y0EX5eMY0SobRkaJQ1WrBmb
i990q70VUhFypoAq2rUUVyr5W/c0kz2z2RrVcom/bKiVknGZJxF36eivXQJ/uPT8
CsGBi/mjdpkHkQ1r2fuu87Vn20SLxPUhT12HTrEVZBNu6jfIkNqyfGZj1dHap/3a
jgcH/y8dyC3OwfOmDw3pvX9OEO0tFOPqh4cCAwEAATANBgkqhkiG9w0BAQsFAAOC
AQEAy3IM4Ch3zomXmSVrWJxdV82HiGGsTkp/buzC77LwM+RjQGGUj+glJwnEWAOQ
fAZBxHznL3mTaA9btN49VTnI8uDcGlpQT8Ln2JBk/wshFzJsbP13nPMhpWMGq7pr
jr83fJmKldeMmIWgYcgVJw3HDfifzadVBtlVzI+aVo9AdMHJYxrkX5KN30h89Rzn
iRINXRIlaL9Ps8PNrtZ2UxegPGmb0IwnK4XhrlRyj8EInaLPnS/w/Gv0sGQqLSKV
umg23sHBXkwxZDP9dmDfuiJI4duR6DGi1fkksrc+n/9UKdlqQz546WWf9btVC77S
Q2Ik8rRYIrxdCTu1leoP98kHQw==
-----END CERTIFICATE-----$p$, 'dd04bd34d4fe9b08fad856d1bed1ba8250b501a6aa1ae8077d2d515a514c11fb', 'idem-oldkey', '00000000-0000-4000-8000-0000000054e2');
  PERFORM pg_temp.chk('3 cert de la clave activa vieja → CERTIFICATE_KEY_MISMATCH', r->>'state'='CERTIFICATE_KEY_MISMATCH');
  PERFORM pg_temp.chk('3 nada cambió', pg_temp.sin_cambios());

  -- ── 4: certificado de otra clave ──
  r := public.arca_activate_certificate_rotation('00000000-0000-4000-8000-0000000054e1', NULL, $p$-----BEGIN CERTIFICATE-----
MIIC3zCCAcegAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBAKTw2L7wiAGOe38FSrUl4lUOSw7Wv8hWF+Hr1aXT+EsPZKqdGgs6
eN7LoFw77hQFQqoBzZkta63SB3EpRt9mdcyyIbbRCHbvQuPcL0oZRy2Pm+24LM4a
Hiq/yp4mvmhR8Lo1gwCGlUXQ+bEjlyNCTC9Q7B83QPp89+BZq+BYYe/D+3AXNx8n
dLBWODPUgJiopEnLSHfUNdUv9M/u6ubIdeFavmpk3U2Igjgb0txnWK6Tsyha18yu
sj5PlQWQ4wIeX21LZ8u4VEhAQZ9VefP5KkAzBmU4tqMjyMhovUl/jqKouRXpa0Br
6a7XrWD0V9S75Y9ZoMeRwV3N9OuSQFpnrr0CAwEAATANBgkqhkiG9w0BAQsFAAOC
AQEADFO6Vta6Bv6HpJNRT8qeVlI2GoxnH7XE485PrFfNBSho1DjBYgBBD8t6KzZ/
QLczVbQTMEDrzGq421uSdaOi1avyZpSX5FEGs/8ml67L0vIhPw80ugdvNmt+Fwxo
MUEmO0zVL3OY01Ulzv+LfAkKan58Cxop0kCcN7W2Pwqia9h0HTnX86xhspSFZX8p
F4tIxNCYEhPArcwhKeahOuXJVMD8Ffvg+2VARJad/65kW9Gx+OJCsS8pAJG/uTfH
io3mfrXLY52Gzzvt6ZFn2rTSpQoiCk5WzePWHIYRHBgh1NQ/42LefO5uPFrT6G/R
vDM2AK4SDFTUTULgT5w/hsl06Q==
-----END CERTIFICATE-----$p$, 'dd04bd34d4fe9b08fad856d1bed1ba8250b501a6aa1ae8077d2d515a514c11fb', 'idem-otherkey', '00000000-0000-4000-8000-0000000054e2');
  PERFORM pg_temp.chk('4 cert de otra clave → CERTIFICATE_KEY_MISMATCH', r->>'state'='CERTIFICATE_KEY_MISMATCH');
  PERFORM pg_temp.chk('4 nada cambió', pg_temp.sin_cambios());

  -- ── 5/6/7: subject ──
  r := public.arca_activate_certificate_rotation('00000000-0000-4000-8000-0000000054e1', NULL, $p$-----BEGIN CERTIFICATE-----
MIIC2TCCAcGgAwIBAgIBATANBgkqhkiG9w0BAQsFADAwMRMwEQYDVQQDEwpvdHJv
LmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAzMDAw
MFoXDTM1MDEwMTAzMDAwMFowMDETMBEGA1UEAxMKb3Ryby5hbGlhczEZMBcGA1UE
BRMQQ1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC
ggEBALrXYOLKCLdWweuuyvsH+99ojZlKAUtqUG1DR0dNl1hz3NPggn8N2/9ZAE3b
lkV9+ZkTm2R2MRlc9lDhrvSED7/EnfTsmH927gXs5MZnE7vC29lb+FxMqppTC8ex
ngr4wHS0slxByw0Jpw71dE2jrhwr9dno+1Wo0drtD3C+JhUSbKtd0Nuc3OREqjUq
+GGCzrvF1oV+axjBMA75WIhA8XkBEtRihTJV5ewYKVZS9djmBCXATBJH60ZIv+M1
IQuUX/mpDQoo3HPTKKGaK06qlRP2Pe7sPIdDLBMzbyJrytElmvbXvz3BWHVrJdBF
uY86yrkoGAk2a1Kp/R5VxDO+CkkCAwEAATANBgkqhkiG9w0BAQsFAAOCAQEAYHlc
8PYjNImYYxQlQod67m6Wv+lWt0AdiXqazqQ/mBnSO7sLA2tnwgyl74MXiOCXhbpd
DkM1i0Mzy0kuuJiSQCPO76kl2H87EEpr7YBJqbolKNkCaERvNuwTCGmMNhYjbtU2
FHAP1z1u3o+Cj9C06O+o4wzc6lxIv30KR8b5ltpJgk/Bhw9oc6LjdQ8tQ7A//Hlw
8MiPuOA/JJRMEk3CGzXm6rbJpOahylvBE2XiZOUUErFH7/KI6SeuQ80OXTLcnOKL
OlcxDgC3IWNVTzGQ7JxSTQnpl2k9FuiiT38xEUZmIeeOvVcdK9fM5BmU9rXgWcqr
Kd9D7l/4notsvx0EoQ==
-----END CERTIFICATE-----$p$, 'dd04bd34d4fe9b08fad856d1bed1ba8250b501a6aa1ae8077d2d515a514c11fb', 'idem-badcn', '00000000-0000-4000-8000-0000000054e2');
  PERFORM pg_temp.chk('5 CN distinto → CERTIFICATE_SUBJECT_MISMATCH', r->>'state'='CERTIFICATE_SUBJECT_MISMATCH');
  r := public.arca_activate_certificate_rotation('00000000-0000-4000-8000-0000000054e1', NULL, $p$-----BEGIN CERTIFICATE-----
MIIC3zCCAcegAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwOTk5OTk5OTk1MB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDk5OTk5OTk5NTCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBALrXYOLKCLdWweuuyvsH+99ojZlKAUtqUG1DR0dNl1hz3NPggn8N
2/9ZAE3blkV9+ZkTm2R2MRlc9lDhrvSED7/EnfTsmH927gXs5MZnE7vC29lb+FxM
qppTC8exngr4wHS0slxByw0Jpw71dE2jrhwr9dno+1Wo0drtD3C+JhUSbKtd0Nuc
3OREqjUq+GGCzrvF1oV+axjBMA75WIhA8XkBEtRihTJV5ewYKVZS9djmBCXATBJH
60ZIv+M1IQuUX/mpDQoo3HPTKKGaK06qlRP2Pe7sPIdDLBMzbyJrytElmvbXvz3B
WHVrJdBFuY86yrkoGAk2a1Kp/R5VxDO+CkkCAwEAATANBgkqhkiG9w0BAQsFAAOC
AQEAbrSfiWHawOdD4DNuYG18PWMV3stPTgR9ncOkaH4W/MKEWr1qt8q9QwO5kdlU
IGR1HhpUWg1jhRyfTEwPcmIJQ/x3hdVLpO4y1TKNyM9pUrMiHYWVc173bfMUzm1p
f6CIYzV4aDnTiYGpfbX3jPrEMgp/O40B4FS+W6bBEcooVi+yDyiAdgnvyCWpUcGP
FEDZRwIVwUtaedY6F67y0D44956gd5ldkfgzvc3wsdALRExhr+t7jy6Ywa4MVezO
1oAPgcLD8vg1ZGkmIY7AQ7tobEKx7UXdPbENd6abVb6t05vzpbqHtEb8kHzM2+c/
O8nG8JMsQqbSAbihixaTVUWRMA==
-----END CERTIFICATE-----$p$, 'dd04bd34d4fe9b08fad856d1bed1ba8250b501a6aa1ae8077d2d515a514c11fb', 'idem-badserial', '00000000-0000-4000-8000-0000000054e2');
  PERFORM pg_temp.chk('6 serialNumber distinto → CERTIFICATE_SUBJECT_MISMATCH', r->>'state'='CERTIFICATE_SUBJECT_MISMATCH');
  r := public.arca_activate_certificate_rotation('00000000-0000-4000-8000-0000000054e1', NULL, $p$-----BEGIN CERTIFICATE-----
MIIC+TCCAeGgAwIBAgIBATANBgkqhkiG9w0BAQsFADBAMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMQswCQYDVQQGEwJB
UjAeFw0yMDAxMDEwMzAwMDBaFw0zNTAxMDEwMzAwMDBaMEAxFjAUBgNVBAMTDWZp
eHR1cmUuYWxpYXMxGTAXBgNVBAUTEENVSVQgMjAxMTExMTExMTIxCzAJBgNVBAYT
AkFSMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAutdg4soIt1bB667K
+wf732iNmUoBS2pQbUNHR02XWHPc0+CCfw3b/1kATduWRX35mRObZHYxGVz2UOGu
9IQPv8Sd9OyYf3buBezkxmcTu8Lb2Vv4XEyqmlMLx7GeCvjAdLSyXEHLDQmnDvV0
TaOuHCv12ej7VajR2u0PcL4mFRJsq13Q25zc5ESqNSr4YYLOu8XWhX5rGMEwDvlY
iEDxeQES1GKFMlXl7BgpVlL12OYEJcBMEkfrRki/4zUhC5Rf+akNCijcc9MooZor
TqqVE/Y97uw8h0MsEzNvImvK0SWa9te/PcFYdWsl0EW5jzrKuSgYCTZrUqn9HlXE
M74KSQIDAQABMA0GCSqGSIb3DQEBCwUAA4IBAQCU+k/N1EbCPBO4oSk9SiQzUKWo
M6fSVjisDtUQ8nNdDm6nFfDPVRxINdQCu4f69OpaCj/g65mGu5EaDpmHK9TDLI2D
QcU3KykiIhtrHfQoC7Tr77fjuoKmIlu11izUUthgrFHOu5iPq51eAp5iVVgnP5O2
8z3sPcGPPdSoycjoh+0HiY2fp9OMJajYbdg5YOtCnkSA72n32NStEXncCDGVMgKg
ZQIQvHKtY/4ofAgDTZno6TpIwguUFXRRCmVeE7N33B5lbEFXNgOdMrokhwoY6q3Q
965e8k8pKuwTVp/tCJzevG1aNIL/eyCIA0YFRM9QINzYuB0InqwGAENWz+T7
-----END CERTIFICATE-----$p$, 'dd04bd34d4fe9b08fad856d1bed1ba8250b501a6aa1ae8077d2d515a514c11fb', 'idem-extra', '00000000-0000-4000-8000-0000000054e2');
  PERFORM pg_temp.chk('7 atributo adicional → CERTIFICATE_SUBJECT_MISMATCH', r->>'state'='CERTIFICATE_SUBJECT_MISMATCH');
  PERFORM pg_temp.chk('5/6/7 nada cambió', pg_temp.sin_cambios());

  -- ── 8/9/10: vigencia y estructura ──
  r := public.arca_activate_certificate_rotation('00000000-0000-4000-8000-0000000054e1', NULL, $p$-----BEGIN CERTIFICATE-----
MIIC3zCCAcegAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTIxMDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBALrXYOLKCLdWweuuyvsH+99ojZlKAUtqUG1DR0dNl1hz3NPggn8N
2/9ZAE3blkV9+ZkTm2R2MRlc9lDhrvSED7/EnfTsmH927gXs5MZnE7vC29lb+FxM
qppTC8exngr4wHS0slxByw0Jpw71dE2jrhwr9dno+1Wo0drtD3C+JhUSbKtd0Nuc
3OREqjUq+GGCzrvF1oV+axjBMA75WIhA8XkBEtRihTJV5ewYKVZS9djmBCXATBJH
60ZIv+M1IQuUX/mpDQoo3HPTKKGaK06qlRP2Pe7sPIdDLBMzbyJrytElmvbXvz3B
WHVrJdBFuY86yrkoGAk2a1Kp/R5VxDO+CkkCAwEAATANBgkqhkiG9w0BAQsFAAOC
AQEAmu6Gyu8M5vMU3ZUM15h5DdppRhEZzZohjKkEmSuczW9tFpQOGOPmU7qR5bFc
WuBy/LCVx0SaTXEIkRkUf0rnIesheARGGwB1Zv9B4CiBNEIYRxKGg7eJtWO/qvyI
gKyG3KAx6va4OCwONVoJODNYNZjpHKvF2e0dqwdOJUmWYBIYwX2Es6z5utC5BRsi
CLO4zLocBsxU2TZ63Z21eG5P8OttJInL5rVpseyiyuUuCwH3SRAeExA0Gtozt8LW
1maWnpl5krcLqzpib7pc2XH+8JlYoYX9hxS+FJTkSR6deS681hq/fuOdFI6WptTo
cX4axew7WUhD7u7/3vIXQA9Vrw==
-----END CERTIFICATE-----$p$, 'dd04bd34d4fe9b08fad856d1bed1ba8250b501a6aa1ae8077d2d515a514c11fb', 'idem-expired', '00000000-0000-4000-8000-0000000054e2');
  PERFORM pg_temp.chk('8 certificado expirado → CERTIFICATE_EXPIRED', r->>'state'='CERTIFICATE_EXPIRED');
  r := public.arca_activate_certificate_rotation('00000000-0000-4000-8000-0000000054e1', NULL, $p$-----BEGIN CERTIFICATE-----
MIIC3zCCAcegAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTM1MDEwMTAz
MDAwMFoXDTQwMDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBALrXYOLKCLdWweuuyvsH+99ojZlKAUtqUG1DR0dNl1hz3NPggn8N
2/9ZAE3blkV9+ZkTm2R2MRlc9lDhrvSED7/EnfTsmH927gXs5MZnE7vC29lb+FxM
qppTC8exngr4wHS0slxByw0Jpw71dE2jrhwr9dno+1Wo0drtD3C+JhUSbKtd0Nuc
3OREqjUq+GGCzrvF1oV+axjBMA75WIhA8XkBEtRihTJV5ewYKVZS9djmBCXATBJH
60ZIv+M1IQuUX/mpDQoo3HPTKKGaK06qlRP2Pe7sPIdDLBMzbyJrytElmvbXvz3B
WHVrJdBFuY86yrkoGAk2a1Kp/R5VxDO+CkkCAwEAATANBgkqhkiG9w0BAQsFAAOC
AQEAJy4GQ2iWhkAVkqFxcNmhKvnCLI8hGW7/u5iLFIJLElu0ZIQmnTYD7zkJ9GEM
qSSlrXDk5NulxCTD/6mI/z06lOztV2ynGHRUYE7JzSNZdj5NcRIt6NaiJeGUtkJM
1ALGEBMalGNieEn9Lz5u7kwvmxn6PxMK7cQzluEyq8VHEd79rZVMD8eisgeBd5UX
vvV0PZgpe+FsZtlAe2fd86W6eU2OftU8v8uUWw//fAnQJPRRdiyTnSheh5BQV5nv
5JDb90dNnAO1Fp5xdBHj+h4Dwsje9m4E8B/6hdj6thQgQJPothWhJJjlFmQEyArl
F/XiOt2p55rund8RGxLNB+gJ5g==
-----END CERTIFICATE-----$p$, 'dd04bd34d4fe9b08fad856d1bed1ba8250b501a6aa1ae8077d2d515a514c11fb', 'idem-future', '00000000-0000-4000-8000-0000000054e2');
  PERFORM pg_temp.chk('9 certificado aún no vigente → CERTIFICATE_NOT_YET_VALID', r->>'state'='CERTIFICATE_NOT_YET_VALID');
  r := public.arca_activate_certificate_rotation('00000000-0000-4000-8000-0000000054e1', NULL, $p$-----BEGIN CERTIFICATE-----
esto-no-es-un-certificado
-----END CERTIFICATE-----$p$, 'dd04bd34d4fe9b08fad856d1bed1ba8250b501a6aa1ae8077d2d515a514c11fb', 'idem-garbage', '00000000-0000-4000-8000-0000000054e2');
  PERFORM pg_temp.chk('10 PEM inválido → CERTIFICATE_INVALID', r->>'state'='CERTIFICATE_INVALID');
  PERFORM pg_temp.chk('8/9/10 nada cambió', pg_temp.sin_cambios());

  -- ── 13: rotación inexistente ──
  r := public.arca_activate_certificate_rotation('00000000-0000-4000-8000-0000000054e1', '00000000-0000-4000-8000-00000000beef',
        $p$-----BEGIN CERTIFICATE-----
MIIC3zCCAcegAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBALrXYOLKCLdWweuuyvsH+99ojZlKAUtqUG1DR0dNl1hz3NPggn8N
2/9ZAE3blkV9+ZkTm2R2MRlc9lDhrvSED7/EnfTsmH927gXs5MZnE7vC29lb+FxM
qppTC8exngr4wHS0slxByw0Jpw71dE2jrhwr9dno+1Wo0drtD3C+JhUSbKtd0Nuc
3OREqjUq+GGCzrvF1oV+axjBMA75WIhA8XkBEtRihTJV5ewYKVZS9djmBCXATBJH
60ZIv+M1IQuUX/mpDQoo3HPTKKGaK06qlRP2Pe7sPIdDLBMzbyJrytElmvbXvz3B
WHVrJdBFuY86yrkoGAk2a1Kp/R5VxDO+CkkCAwEAATANBgkqhkiG9w0BAQsFAAOC
AQEAWC67EDh+j7uHexeXO/iH1QTerGF5sCmiAJj3TqYhR6dyxnm///cbgdF/kQ9W
xYVhYRVIFQVLENmlWWR4H/q8K0I24ku4WtGPGv+DDHhykkBtvgS6BnDsGAutj7HX
ycI0LB6zlIFlKogRQugtBXxAJUilP9W4s12eojYXjdi58c0pJrcbuHkPCAqMztAj
FL+twd2yy06I462AhBRlV3iqdRLFoesx3AheMGsR4L1YptEKKWBvNeV/NzT8qANj
bOnlnhsrzf9hczdN1LYK+Qsx8U6vyulkNFcnEn9X8FH1SE6csN5qw2r6l0BzXrMT
iz2Ex9UCSexFjMpkRhjsqVaD+Q==
-----END CERTIFICATE-----$p$, 'dd04bd34d4fe9b08fad856d1bed1ba8250b501a6aa1ae8077d2d515a514c11fb', 'idem-norot', '00000000-0000-4000-8000-0000000054e2');
  PERFORM pg_temp.chk('13 rotación inexistente → ROTATION_NOT_FOUND', r->>'state'='ROTATION_NOT_FOUND');

  -- fingerprint esperado incorrecto
  r := public.arca_activate_certificate_rotation('00000000-0000-4000-8000-0000000054e1', NULL, $p$-----BEGIN CERTIFICATE-----
MIIC3zCCAcegAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBALrXYOLKCLdWweuuyvsH+99ojZlKAUtqUG1DR0dNl1hz3NPggn8N
2/9ZAE3blkV9+ZkTm2R2MRlc9lDhrvSED7/EnfTsmH927gXs5MZnE7vC29lb+FxM
qppTC8exngr4wHS0slxByw0Jpw71dE2jrhwr9dno+1Wo0drtD3C+JhUSbKtd0Nuc
3OREqjUq+GGCzrvF1oV+axjBMA75WIhA8XkBEtRihTJV5ewYKVZS9djmBCXATBJH
60ZIv+M1IQuUX/mpDQoo3HPTKKGaK06qlRP2Pe7sPIdDLBMzbyJrytElmvbXvz3B
WHVrJdBFuY86yrkoGAk2a1Kp/R5VxDO+CkkCAwEAATANBgkqhkiG9w0BAQsFAAOC
AQEAWC67EDh+j7uHexeXO/iH1QTerGF5sCmiAJj3TqYhR6dyxnm///cbgdF/kQ9W
xYVhYRVIFQVLENmlWWR4H/q8K0I24ku4WtGPGv+DDHhykkBtvgS6BnDsGAutj7HX
ycI0LB6zlIFlKogRQugtBXxAJUilP9W4s12eojYXjdi58c0pJrcbuHkPCAqMztAj
FL+twd2yy06I462AhBRlV3iqdRLFoesx3AheMGsR4L1YptEKKWBvNeV/NzT8qANj
bOnlnhsrzf9hczdN1LYK+Qsx8U6vyulkNFcnEn9X8FH1SE6csN5qw2r6l0BzXrMT
iz2Ex9UCSexFjMpkRhjsqVaD+Q==
-----END CERTIFICATE-----$p$, '13861caf92ad1ae5c91cac27e49baca86328d7287ef642742cf3435b34a1366e', 'idem-badfp', '00000000-0000-4000-8000-0000000054e2');
  PERFORM pg_temp.chk('expected_fingerprint incorrecto → CERTIFICATE_KEY_MISMATCH', r->>'state'='CERTIFICATE_KEY_MISMATCH');

  -- actor no-owner
  r := public.arca_activate_certificate_rotation('00000000-0000-4000-8000-0000000054e1', NULL, $p$-----BEGIN CERTIFICATE-----
MIIC3zCCAcegAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBALrXYOLKCLdWweuuyvsH+99ojZlKAUtqUG1DR0dNl1hz3NPggn8N
2/9ZAE3blkV9+ZkTm2R2MRlc9lDhrvSED7/EnfTsmH927gXs5MZnE7vC29lb+FxM
qppTC8exngr4wHS0slxByw0Jpw71dE2jrhwr9dno+1Wo0drtD3C+JhUSbKtd0Nuc
3OREqjUq+GGCzrvF1oV+axjBMA75WIhA8XkBEtRihTJV5ewYKVZS9djmBCXATBJH
60ZIv+M1IQuUX/mpDQoo3HPTKKGaK06qlRP2Pe7sPIdDLBMzbyJrytElmvbXvz3B
WHVrJdBFuY86yrkoGAk2a1Kp/R5VxDO+CkkCAwEAATANBgkqhkiG9w0BAQsFAAOC
AQEAWC67EDh+j7uHexeXO/iH1QTerGF5sCmiAJj3TqYhR6dyxnm///cbgdF/kQ9W
xYVhYRVIFQVLENmlWWR4H/q8K0I24ku4WtGPGv+DDHhykkBtvgS6BnDsGAutj7HX
ycI0LB6zlIFlKogRQugtBXxAJUilP9W4s12eojYXjdi58c0pJrcbuHkPCAqMztAj
FL+twd2yy06I462AhBRlV3iqdRLFoesx3AheMGsR4L1YptEKKWBvNeV/NzT8qANj
bOnlnhsrzf9hczdN1LYK+Qsx8U6vyulkNFcnEn9X8FH1SE6csN5qw2r6l0BzXrMT
iz2Ex9UCSexFjMpkRhjsqVaD+Q==
-----END CERTIFICATE-----$p$, 'dd04bd34d4fe9b08fad856d1bed1ba8250b501a6aa1ae8077d2d515a514c11fb', 'idem-unauth', '00000000-0000-4000-8000-00000000dead');
  PERFORM pg_temp.chk('actor no-owner → UNAUTHORIZED', r->>'state'='UNAUTHORIZED');
  PERFORM pg_temp.chk('tras todos los rechazos: nada cambió', pg_temp.sin_cambios());

  -- ── 1/2: ACTIVACIÓN CORRECTA ──
  r := public.arca_activate_certificate_rotation('00000000-0000-4000-8000-0000000054e1', NULL, $p$-----BEGIN CERTIFICATE-----
MIIC3zCCAcegAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBALrXYOLKCLdWweuuyvsH+99ojZlKAUtqUG1DR0dNl1hz3NPggn8N
2/9ZAE3blkV9+ZkTm2R2MRlc9lDhrvSED7/EnfTsmH927gXs5MZnE7vC29lb+FxM
qppTC8exngr4wHS0slxByw0Jpw71dE2jrhwr9dno+1Wo0drtD3C+JhUSbKtd0Nuc
3OREqjUq+GGCzrvF1oV+axjBMA75WIhA8XkBEtRihTJV5ewYKVZS9djmBCXATBJH
60ZIv+M1IQuUX/mpDQoo3HPTKKGaK06qlRP2Pe7sPIdDLBMzbyJrytElmvbXvz3B
WHVrJdBFuY86yrkoGAk2a1Kp/R5VxDO+CkkCAwEAATANBgkqhkiG9w0BAQsFAAOC
AQEAWC67EDh+j7uHexeXO/iH1QTerGF5sCmiAJj3TqYhR6dyxnm///cbgdF/kQ9W
xYVhYRVIFQVLENmlWWR4H/q8K0I24ku4WtGPGv+DDHhykkBtvgS6BnDsGAutj7HX
ycI0LB6zlIFlKogRQugtBXxAJUilP9W4s12eojYXjdi58c0pJrcbuHkPCAqMztAj
FL+twd2yy06I462AhBRlV3iqdRLFoesx3AheMGsR4L1YptEKKWBvNeV/NzT8qANj
bOnlnhsrzf9hczdN1LYK+Qsx8U6vyulkNFcnEn9X8FH1SE6csN5qw2r6l0BzXrMT
iz2Ex9UCSexFjMpkRhjsqVaD+Q==
-----END CERTIFICATE-----$p$, 'dd04bd34d4fe9b08fad856d1bed1ba8250b501a6aa1ae8077d2d515a514c11fb', 'idem-act-1', '00000000-0000-4000-8000-0000000054e2');
  PERFORM pg_temp.chk('1 activación correcta → ROTATION_ACTIVATED', r->>'state'='ROTATION_ACTIVATED');
  PERFORM pg_temp.chk('2 devuelve fingerprints nuevo y anterior',
    (r->>'new_fingerprint_trunc') = left('dd04bd34d4fe9b08fad856d1bed1ba8250b501a6aa1ae8077d2d515a514c11fb',16)
    AND (r->>'previous_fingerprint_trunc') = left('13861caf92ad1ae5c91cac27e49baca86328d7287ef642742cf3435b34a1366e',16));
  PERFORM pg_temp.chk('1 sin certificado ni clave en el retorno', (r::text) !~ 'BEGIN CERTIFICATE|PRIVATE KEY');

  -- ── 16: cert_file y secreto cambian JUNTOS ──
  PERFORM pg_temp.chk('16 credencial usa la clave nueva',
    (SELECT private_key_fingerprint FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-0000000054e1') = 'dd04bd34d4fe9b08fad856d1bed1ba8250b501a6aa1ae8077d2d515a514c11fb');
  PERFORM pg_temp.chk('16 credencial apunta al secreto de la rotación',
    (SELECT private_key_secret_id FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-0000000054e1') = v_new_secret);
  PERFORM pg_temp.chk('16 cert_file es el certificado nuevo',
    (SELECT md5(cert_file) FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000054e1') = md5($p$-----BEGIN CERTIFICATE-----
MIIC3zCCAcegAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBALrXYOLKCLdWweuuyvsH+99ojZlKAUtqUG1DR0dNl1hz3NPggn8N
2/9ZAE3blkV9+ZkTm2R2MRlc9lDhrvSED7/EnfTsmH927gXs5MZnE7vC29lb+FxM
qppTC8exngr4wHS0slxByw0Jpw71dE2jrhwr9dno+1Wo0drtD3C+JhUSbKtd0Nuc
3OREqjUq+GGCzrvF1oV+axjBMA75WIhA8XkBEtRihTJV5ewYKVZS9djmBCXATBJH
60ZIv+M1IQuUX/mpDQoo3HPTKKGaK06qlRP2Pe7sPIdDLBMzbyJrytElmvbXvz3B
WHVrJdBFuY86yrkoGAk2a1Kp/R5VxDO+CkkCAwEAATANBgkqhkiG9w0BAQsFAAOC
AQEAWC67EDh+j7uHexeXO/iH1QTerGF5sCmiAJj3TqYhR6dyxnm///cbgdF/kQ9W
xYVhYRVIFQVLENmlWWR4H/q8K0I24ku4WtGPGv+DDHhykkBtvgS6BnDsGAutj7HX
ycI0LB6zlIFlKogRQugtBXxAJUilP9W4s12eojYXjdi58c0pJrcbuHkPCAqMztAj
FL+twd2yy06I462AhBRlV3iqdRLFoesx3AheMGsR4L1YptEKKWBvNeV/NzT8qANj
bOnlnhsrzf9hczdN1LYK+Qsx8U6vyulkNFcnEn9X8FH1SE6csN5qw2r6l0BzXrMT
iz2Ex9UCSexFjMpkRhjsqVaD+Q==
-----END CERTIFICATE-----$p$));

  -- ── 15: par anterior PRESERVADO en el checkpoint ──
  PERFORM pg_temp.chk('15 checkpoint conserva el secreto anterior',
    (SELECT prev_secret_id FROM private.arca_credential_rotations WHERE id=v_rot) = v_prev_secret);
  PERFORM pg_temp.chk('15 checkpoint conserva fingerprint anterior',
    (SELECT prev_fingerprint FROM private.arca_credential_rotations WHERE id=v_rot) = '13861caf92ad1ae5c91cac27e49baca86328d7287ef642742cf3435b34a1366e');
  PERFORM pg_temp.chk('15 checkpoint conserva certificado anterior',
    (SELECT md5(prev_certificate_pem) FROM private.arca_credential_rotations WHERE id=v_rot) = (SELECT cert_md5 FROM s4b2_pre));
  PERFORM pg_temp.chk('15 el secreto Vault anterior NO fue borrado',
    EXISTS (SELECT 1 FROM vault.secrets WHERE id = v_prev_secret));
  PERFORM pg_temp.chk('15 rotación en activated_pending_verification',
    (SELECT state FROM private.arca_credential_rotations WHERE id=v_rot) = 'activated_pending_verification');
  PERFORM pg_temp.chk('15 prev_status = rollback_candidate',
    (SELECT prev_status FROM private.arca_credential_rotations WHERE id=v_rot) = 'rollback_candidate');

  -- ── 19: cache WSAA invalidado ──
  PERFORM pg_temp.chk('19 cache WSAA invalidado (token/sign/expires NULL)',
    (SELECT wsaa_token IS NULL AND wsaa_sign IS NULL AND wsaa_token_expires IS NULL
       FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000054e1'));
  PERFORM pg_temp.chk('19 estado_conexion = activation_pending_wsaa_verification',
    (SELECT estado_conexion FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000054e1') = 'activation_pending_wsaa_verification');
  PERFORM pg_temp.chk('19 token anterior preservado en checkpoint',
    (SELECT prev_wsaa_token FROM private.arca_credential_rotations WHERE id=v_rot) = 'TOKEN_VIEJO');

  -- ── 18: readback final ──
  PERFORM pg_temp.chk('18 readback resuelve la clave nueva',
    private.arca_key_fingerprint(private.arca_get_private_key_for_signing('00000000-0000-4000-8000-0000000054e1')) = 'dd04bd34d4fe9b08fad856d1bed1ba8250b501a6aa1ae8077d2d515a514c11fb');
  PERFORM pg_temp.chk('18 la clave activa corresponde al certificado nuevo',
    private.arca_key_matches_certificate(private.arca_get_private_key_for_signing('00000000-0000-4000-8000-0000000054e1'), $p$-----BEGIN CERTIFICATE-----
MIIC3zCCAcegAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBALrXYOLKCLdWweuuyvsH+99ojZlKAUtqUG1DR0dNl1hz3NPggn8N
2/9ZAE3blkV9+ZkTm2R2MRlc9lDhrvSED7/EnfTsmH927gXs5MZnE7vC29lb+FxM
qppTC8exngr4wHS0slxByw0Jpw71dE2jrhwr9dno+1Wo0drtD3C+JhUSbKtd0Nuc
3OREqjUq+GGCzrvF1oV+axjBMA75WIhA8XkBEtRihTJV5ewYKVZS9djmBCXATBJH
60ZIv+M1IQuUX/mpDQoo3HPTKKGaK06qlRP2Pe7sPIdDLBMzbyJrytElmvbXvz3B
WHVrJdBFuY86yrkoGAk2a1Kp/R5VxDO+CkkCAwEAATANBgkqhkiG9w0BAQsFAAOC
AQEAWC67EDh+j7uHexeXO/iH1QTerGF5sCmiAJj3TqYhR6dyxnm///cbgdF/kQ9W
xYVhYRVIFQVLENmlWWR4H/q8K0I24ku4WtGPGv+DDHhykkBtvgS6BnDsGAutj7HX
ycI0LB6zlIFlKogRQugtBXxAJUilP9W4s12eojYXjdi58c0pJrcbuHkPCAqMztAj
FL+twd2yy06I462AhBRlV3iqdRLFoesx3AheMGsR4L1YptEKKWBvNeV/NzT8qANj
bOnlnhsrzf9hczdN1LYK+Qsx8U6vyulkNFcnEn9X8FH1SE6csN5qw2r6l0BzXrMT
iz2Ex9UCSexFjMpkRhjsqVaD+Q==
-----END CERTIFICATE-----$p$));

  -- ── 20 (AFIP-S4C): la activación NO reintroduce almacenamiento en claro ──
  -- Reemplaza al viejo '20 private_key legacy intacta': esa columna ya no existe,
  -- así que la invariante vigente es que nadie la recree al activar.
  PERFORM pg_temp.chk('20 la activación no crea ninguna columna de clave en claro',
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='arca_config' AND column_name='private_key') = 0
    AND (SELECT cols_plaintext FROM s4b2_pre) = 0);

  -- ── 11: replay idempotente ──
  r := public.arca_activate_certificate_rotation('00000000-0000-4000-8000-0000000054e1', NULL, $p$-----BEGIN CERTIFICATE-----
MIIC3zCCAcegAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBALrXYOLKCLdWweuuyvsH+99ojZlKAUtqUG1DR0dNl1hz3NPggn8N
2/9ZAE3blkV9+ZkTm2R2MRlc9lDhrvSED7/EnfTsmH927gXs5MZnE7vC29lb+FxM
qppTC8exngr4wHS0slxByw0Jpw71dE2jrhwr9dno+1Wo0drtD3C+JhUSbKtd0Nuc
3OREqjUq+GGCzrvF1oV+axjBMA75WIhA8XkBEtRihTJV5ewYKVZS9djmBCXATBJH
60ZIv+M1IQuUX/mpDQoo3HPTKKGaK06qlRP2Pe7sPIdDLBMzbyJrytElmvbXvz3B
WHVrJdBFuY86yrkoGAk2a1Kp/R5VxDO+CkkCAwEAATANBgkqhkiG9w0BAQsFAAOC
AQEAWC67EDh+j7uHexeXO/iH1QTerGF5sCmiAJj3TqYhR6dyxnm///cbgdF/kQ9W
xYVhYRVIFQVLENmlWWR4H/q8K0I24ku4WtGPGv+DDHhykkBtvgS6BnDsGAutj7HX
ycI0LB6zlIFlKogRQugtBXxAJUilP9W4s12eojYXjdi58c0pJrcbuHkPCAqMztAj
FL+twd2yy06I462AhBRlV3iqdRLFoesx3AheMGsR4L1YptEKKWBvNeV/NzT8qANj
bOnlnhsrzf9hczdN1LYK+Qsx8U6vyulkNFcnEn9X8FH1SE6csN5qw2r6l0BzXrMT
iz2Ex9UCSexFjMpkRhjsqVaD+Q==
-----END CERTIFICATE-----$p$, 'dd04bd34d4fe9b08fad856d1bed1ba8250b501a6aa1ae8077d2d515a514c11fb', 'idem-act-1', '00000000-0000-4000-8000-0000000054e2');
  PERFORM pg_temp.chk('11 replay idempotente → ACTIVATION_ALREADY_APPLIED', r->>'state'='ACTIVATION_ALREADY_APPLIED');
  PERFORM pg_temp.chk('11 el replay no repite la promoción',
    (SELECT count(*) FROM private.arca_credential_audit WHERE event='arca_certificate_rotation_activated') = 1);

  -- ── 12: conflicto de idempotencia (misma key, certificado distinto) ──
  r := public.arca_activate_certificate_rotation('00000000-0000-4000-8000-0000000054e1', NULL, $p$-----BEGIN CERTIFICATE-----
MIIC3zCCAcegAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBALUb7Zf6kvH2P11YI8Idic+AFcg7+JMBQi3rJnMzAmxxzgF/CQuB
ny7LpBJRX9sfrMGWsEVW0kGjqF822pCTfZlyRiRtWuqvJjNVCm6ZZ1VmPrwKPgNx
qK3OdhDPUVWK04iYoQcN/d+aBFT3dU6gXsyRdY8RlcDQjp/eeUYU66UFBWAbmSTX
vAGU1caSYPv5RuYOty+MVRpNup5MMI14A9ilQYQnnXmJNFIAS2CWBkv6mGCHEznX
uojbE17Rii+vhdKgo2cuPp1V5S6qIaZNsbV9AzxVXD38zff/1PQGqRTNIlH8wZ1i
Yth1lPrfesD3+5rfOGuKS4MX+GhkKXioL1cCAwEAATANBgkqhkiG9w0BAQsFAAOC
AQEAIlypD4z8RyXe/eBni9b7wLx+A4n1B5csrg8oO9mVb7A6qJCdKUo5C5TbSQ84
Mvwr/hntIO83KKvokmKQvwmL3GH0eOyzng3unEJm+cvv8NRAHnQkZnqfeaGNmL/U
h3eHaOp31mGxZ1DWjxezzFTUiQDgNAp9VCtV3LmcmyrcmXhqnaSDNUpaPG82rQXV
yo1OAqPtQ16K27gKVOgyBEBQT1C439XjOUzTTknc8Qg5zxSEqQAT2gPbha0/A4qh
Jao5NEK8ApZhG0MB1lYdN1gcMQsTAhkh2xuHZJhzigyNF3eBNiWKY1NXc8hJFygh
qhukrwfJj3bgShIZHmK1ouR2dA==
-----END CERTIFICATE-----$p$, 'dd04bd34d4fe9b08fad856d1bed1ba8250b501a6aa1ae8077d2d515a514c11fb', 'idem-act-1', '00000000-0000-4000-8000-0000000054e2');
  PERFORM pg_temp.chk('12 misma idem + certificado distinto → IDEMPOTENCY_CONFLICT', r->>'state'='IDEMPOTENCY_CONFLICT');

  -- ── 14: rotación no pending ──
  r := public.arca_activate_certificate_rotation('00000000-0000-4000-8000-0000000054e1', NULL, $p$-----BEGIN CERTIFICATE-----
MIIC3zCCAcegAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBALrXYOLKCLdWweuuyvsH+99ojZlKAUtqUG1DR0dNl1hz3NPggn8N
2/9ZAE3blkV9+ZkTm2R2MRlc9lDhrvSED7/EnfTsmH927gXs5MZnE7vC29lb+FxM
qppTC8exngr4wHS0slxByw0Jpw71dE2jrhwr9dno+1Wo0drtD3C+JhUSbKtd0Nuc
3OREqjUq+GGCzrvF1oV+axjBMA75WIhA8XkBEtRihTJV5ewYKVZS9djmBCXATBJH
60ZIv+M1IQuUX/mpDQoo3HPTKKGaK06qlRP2Pe7sPIdDLBMzbyJrytElmvbXvz3B
WHVrJdBFuY86yrkoGAk2a1Kp/R5VxDO+CkkCAwEAATANBgkqhkiG9w0BAQsFAAOC
AQEAWC67EDh+j7uHexeXO/iH1QTerGF5sCmiAJj3TqYhR6dyxnm///cbgdF/kQ9W
xYVhYRVIFQVLENmlWWR4H/q8K0I24ku4WtGPGv+DDHhykkBtvgS6BnDsGAutj7HX
ycI0LB6zlIFlKogRQugtBXxAJUilP9W4s12eojYXjdi58c0pJrcbuHkPCAqMztAj
FL+twd2yy06I462AhBRlV3iqdRLFoesx3AheMGsR4L1YptEKKWBvNeV/NzT8qANj
bOnlnhsrzf9hczdN1LYK+Qsx8U6vyulkNFcnEn9X8FH1SE6csN5qw2r6l0BzXrMT
iz2Ex9UCSexFjMpkRhjsqVaD+Q==
-----END CERTIFICATE-----$p$, 'dd04bd34d4fe9b08fad856d1bed1ba8250b501a6aa1ae8077d2d515a514c11fb', 'idem-act-2', '00000000-0000-4000-8000-0000000054e2');
  PERFORM pg_temp.chk('14 rotación ya activada → ROTATION_NOT_FOUND/NOT_PENDING',
    r->>'state' IN ('ROTATION_NOT_FOUND','ROTATION_NOT_PENDING'));

  -- ── 21: ROLLBACK restaura el par anterior ──
  r := public.arca_rollback_certificate_rotation('00000000-0000-4000-8000-0000000054e1', NULL, 'idem-rb-1', '00000000-0000-4000-8000-0000000054e2');
  PERFORM pg_temp.chk('21 rollback → ROTATION_ROLLED_BACK', r->>'state'='ROTATION_ROLLED_BACK');
  PERFORM pg_temp.chk('21 credencial restaurada a la clave anterior',
    (SELECT private_key_fingerprint FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-0000000054e1') = '13861caf92ad1ae5c91cac27e49baca86328d7287ef642742cf3435b34a1366e');
  PERFORM pg_temp.chk('21 cert_file restaurado',
    (SELECT md5(cert_file) FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000054e1') = (SELECT cert_md5 FROM s4b2_pre));
  PERFORM pg_temp.chk('21 readback resuelve la clave anterior',
    private.arca_key_fingerprint(private.arca_get_private_key_for_signing('00000000-0000-4000-8000-0000000054e1')) = '13861caf92ad1ae5c91cac27e49baca86328d7287ef642742cf3435b34a1366e');
  PERFORM pg_temp.chk('21 rotación en rolled_back',
    (SELECT state FROM private.arca_credential_rotations WHERE id=v_rot) = 'rolled_back');
  PERFORM pg_temp.chk('21 ningún secreto fue borrado',
    EXISTS (SELECT 1 FROM vault.secrets WHERE id=v_prev_secret)
    AND EXISTS (SELECT 1 FROM vault.secrets WHERE id=v_new_secret));

  -- ── 22: replay de rollback ──
  r := public.arca_rollback_certificate_rotation('00000000-0000-4000-8000-0000000054e1', NULL, 'idem-rb-1', '00000000-0000-4000-8000-0000000054e2');
  PERFORM pg_temp.chk('22 replay de rollback → ROLLBACK_ALREADY_APPLIED', r->>'state'='ROLLBACK_ALREADY_APPLIED');
END $t$;

-- ── 17: fallo intermedio (readback de Vault) → sin cambios parciales ────────
DO $t2$
DECLARE r jsonb; v_rot2 uuid; v_sec2 uuid; v_fp_antes text; v_cert_antes text;
BEGIN
  SELECT public.arca_prepare_certificate_rotation('00000000-0000-4000-8000-0000000054e1', $p$-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAtRvtl/qS8fY/XVgjwh2Jz4AVyDv4kwFCLesmczMCbHHOAX8J
C4GfLsukElFf2x+swZawRVbSQaOoXzbakJN9mXJGJG1a6q8mM1UKbplnVWY+vAo+
A3Gorc52EM9RVYrTiJihBw3935oEVPd1TqBezJF1jxGVwNCOn955RhTrpQUFYBuZ
JNe8AZTVxpJg+/lG5g63L4xVGk26nkwwjXgD2KVBhCedeYk0UgBLYJYGS/qYYIcT
Ode6iNsTXtGKL6+F0qCjZy4+nVXlLqohpk2xtX0DPFVcPfzN9//U9AapFM0iUfzB
nWJi2HWU+t96wPf7mt84a4pLgxf4aGQpeKgvVwIDAQABAoIBAB4f4BxYdJrEn/OR
1pjSOvsFzhm5R/aDzhM/Ou0Mfgm1wFNlYwbD78tj2g2l9XDISv8EZpuR/nUmmLoF
sMM9lTWx2VLz0ZyZt5vwOET/RT3iPOsgNQJzpGAMqHzRTzEQX3EoGhjHTgQkZTYQ
1zVV3Y7fXxOGFEe3KRIUek2a6ztOW9z2DiNZ5cGPU2ImhQwCfN7Qmd3eGe4rAEr+
h/16pcg/5YouCpLy1S1zakzCop8UX1CjsLeBLo+6ZamkVbZfX9o2dojHwhJNy9w6
tRTVzZXgOjcY6PhHDkV7C1ifERRkF86pBpHfpdUroohVn3KhGwtpCdAp6/ZN57wv
oOKemhECgYEA1U+acBILq8yjSj4ajX48C58BDk8rybEzQ2/Qte6ubr5YFqP9jvMl
SOrgMu4BQS473/7Pag3xPDiNL+UN3OaymsZIzmG12yoJnbjfPQciq9beDf3wh6hP
XAryMAv7mjbfxarQ8y1+Sob7eHvYTyzeDeXBGItt+cV8kCFsvVukgVkCgYEA2VqN
QJ5QsurTapLfsQ0Sz3R75sT+1QDb8KozXBc46hIQ6YqHFT3cpfQoKAlxxQ1seD8U
CfHfom8v0dyV3+ZyW1XXQz/8WVnMH2VLG933mzxls58fMtJoIW71t8ukKGgmhHzh
VTzy65vdFIkrY0bfY/APjyNmFHEfXQy3qU6Z8C8CgYA6dN416DwakLIPHoXYUMfT
x3danIe7djw+Nt5TfV2AK9moGrjZ+/gzy2o1itP9MNZnxETDI58Aid7nSTZLW02G
7N/27wAPV63a81b6OoJd5TxlSTopcw6MgtNsJ1yEHpWkbfNlMQpzEhrIIehdikYw
OM56E3vH/z7roL1UB1FFwQKBgEq0ScpE352vAj0mAAY9ZRKyiYdWe/O/2NhN11s2
jBQ/Y1qxhx4w5e6QDWE9ZcIBjB+EJqIIZQHST1BFDaon7XQg+9ycWGJpb7P2v6rz
TpAnYRksfq+cC7g6B/BE6MYOjfaJaXU/foqmRoUxZB06FbumneJnm0U5YDs+DL3/
Sv93AoGBALnRdYhH2+Ew4HHQtROyyO7wwdna5n4ca5+55FI/UMteq6DB+MyaofiV
nFt5aIlulnSytdHEIbNipAbzuziV3PBHpsjc6nl6p3kqpcl95islAymdhf/mxEfR
QwI2F8DzL6CoexpKhRfLXmVxHB2uTJVfDheBg04Qw7Dh6sSbZ9x6
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIICeDCCAWACAQAwMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZMBcGA1UEBRMQ
Q1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
ALUb7Zf6kvH2P11YI8Idic+AFcg7+JMBQi3rJnMzAmxxzgF/CQuBny7LpBJRX9sf
rMGWsEVW0kGjqF822pCTfZlyRiRtWuqvJjNVCm6ZZ1VmPrwKPgNxqK3OdhDPUVWK
04iYoQcN/d+aBFT3dU6gXsyRdY8RlcDQjp/eeUYU66UFBWAbmSTXvAGU1caSYPv5
RuYOty+MVRpNup5MMI14A9ilQYQnnXmJNFIAS2CWBkv6mGCHEznXuojbE17Rii+v
hdKgo2cuPp1V5S6qIaZNsbV9AzxVXD38zff/1PQGqRTNIlH8wZ1iYth1lPrfesD3
+5rfOGuKS4MX+GhkKXioL1cCAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4IBAQAwJZc1
J3vMHABoKeQCxEupWspyUAzWeukWsm5roN2ktwdyDNl+PCPKV8zIT6Cqfd04Wagg
2q1Pj9wFQeB11S8tcl/TQRt58W4nIoY95bE0TADU2MF/PdxC+98pQhk5K5eQ81xA
bs4UnT7qr9BzJAVrAXCukOni4PjoxaJ7zEefybX1NavmxK75Nk4E7plcfs6VS8X4
sQDAzuzDZjBIG/AQ0H0Ejv99CDdl/ApA4Vs5LUoUCU0BzWZEfybs+ngaU9zxCEIQ
k73APZmxTRrgkpRl7PA2AP25EZpp5353zdqdMwkLNx2lL+ZXCIsB7l6AalPT51Tq
0wKw+1RrJuNl+DyM
-----END CERTIFICATE REQUEST-----$p$,
         '3e9b7171077ef73a9bab264d280f52200600cd08a1f4e03eda069bc6da4695e4', 'RSA', 2048, 65537, NULL, 'idem-prep-2', '00000000-0000-4000-8000-0000000054e2') INTO r;
  PERFORM pg_temp.chk('17 segunda rotación preparada', r->>'state'='ROTATION_PREPARED');
  SELECT id, private_key_secret_id INTO v_rot2, v_sec2
    FROM private.arca_credential_rotations WHERE business_id='00000000-0000-4000-8000-0000000054e1' AND state='pending_rotation';

  SELECT private_key_fingerprint INTO v_fp_antes FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-0000000054e1';
  SELECT cert_file INTO v_cert_antes FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000054e1';

  -- Se rompe el secreto de la rotación ANTES de activar (fallo intermedio real).
  DELETE FROM vault.secrets WHERE id = v_sec2;

  r := public.arca_activate_certificate_rotation('00000000-0000-4000-8000-0000000054e1', v_rot2, $p$-----BEGIN CERTIFICATE-----
MIIC3zCCAcegAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBALUb7Zf6kvH2P11YI8Idic+AFcg7+JMBQi3rJnMzAmxxzgF/CQuB
ny7LpBJRX9sfrMGWsEVW0kGjqF822pCTfZlyRiRtWuqvJjNVCm6ZZ1VmPrwKPgNx
qK3OdhDPUVWK04iYoQcN/d+aBFT3dU6gXsyRdY8RlcDQjp/eeUYU66UFBWAbmSTX
vAGU1caSYPv5RuYOty+MVRpNup5MMI14A9ilQYQnnXmJNFIAS2CWBkv6mGCHEznX
uojbE17Rii+vhdKgo2cuPp1V5S6qIaZNsbV9AzxVXD38zff/1PQGqRTNIlH8wZ1i
Yth1lPrfesD3+5rfOGuKS4MX+GhkKXioL1cCAwEAATANBgkqhkiG9w0BAQsFAAOC
AQEAIlypD4z8RyXe/eBni9b7wLx+A4n1B5csrg8oO9mVb7A6qJCdKUo5C5TbSQ84
Mvwr/hntIO83KKvokmKQvwmL3GH0eOyzng3unEJm+cvv8NRAHnQkZnqfeaGNmL/U
h3eHaOp31mGxZ1DWjxezzFTUiQDgNAp9VCtV3LmcmyrcmXhqnaSDNUpaPG82rQXV
yo1OAqPtQ16K27gKVOgyBEBQT1C439XjOUzTTknc8Qg5zxSEqQAT2gPbha0/A4qh
Jao5NEK8ApZhG0MB1lYdN1gcMQsTAhkh2xuHZJhzigyNF3eBNiWKY1NXc8hJFygh
qhukrwfJj3bgShIZHmK1ouR2dA==
-----END CERTIFICATE-----$p$,
        '3e9b7171077ef73a9bab264d280f52200600cd08a1f4e03eda069bc6da4695e4', 'idem-act-broken', '00000000-0000-4000-8000-0000000054e2');
  PERFORM pg_temp.chk('17 fallo intermedio → VAULT_READBACK_FAILED', r->>'state'='VAULT_READBACK_FAILED');
  PERFORM pg_temp.chk('17 credencial sin cambios',
    (SELECT private_key_fingerprint FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-0000000054e1') = v_fp_antes);
  PERFORM pg_temp.chk('17 cert_file sin cambios',
    (SELECT cert_file FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000054e1') = v_cert_antes);
  PERFORM pg_temp.chk('17 la rotación sigue pending (no se activó parcialmente)',
    (SELECT state FROM private.arca_credential_rotations WHERE id=v_rot2) = 'pending_rotation');
END $t2$;

-- ── 23/24/25: huérfanos, auditoría, grants ─────────────────────────────────
SELECT pg_temp.chk('23 cero secretos de rotación huérfanos',
  (SELECT count(*) FROM vault.secrets WHERE name LIKE 'arca-private-key-rotation:%')
   = (SELECT count(*) FROM private.arca_credential_rotations
      WHERE private_key_secret_id IN (SELECT id FROM vault.secrets)));
SELECT pg_temp.chk('23 una sola credencial para el negocio',
  (SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-0000000054e1') = 1);
SELECT pg_temp.chk('24 auditoría de activación/rollback registrada',
  (SELECT count(*) FROM private.arca_credential_audit WHERE event LIKE 'arca_certificate_rotation_activ%') >= 2
  AND (SELECT count(*) FROM private.arca_credential_audit WHERE event='arca_certificate_rotation_rolled_back') = 1);
-- Se busca MATERIAL real (cabeceras PEM, cuerpo base64, CUIT completo), no los
-- nombres de estado — que legítimamente contienen la palabra CERTIFICATE.
SELECT pg_temp.chk('24 auditoría sin certificado, clave ni CUIT completo',
  NOT EXISTS (SELECT 1 FROM private.arca_credential_audit
    WHERE coalesce(fingerprint_trunc,'')||coalesce(status,'')||coalesce(error_code,'')
          ~ '(BEGIN CERTIFICATE|BEGIN [A-Z ]*PRIVATE KEY|MII[A-Za-z0-9+/]{8}|20111111112)'));
SELECT pg_temp.chk('24 fingerprint_trunc seguro (<=16 hex o vacío)',
  (SELECT bool_and(fingerprint_trunc IS NULL OR (length(fingerprint_trunc) <= 16 AND fingerprint_trunc ~ '^[0-9a-f]*$'))
     FROM private.arca_credential_audit WHERE event LIKE 'arca_certificate_rotation%'));
SELECT pg_temp.chk('25 activate service_role-only',
  has_function_privilege('service_role','public.arca_activate_certificate_rotation(uuid,uuid,text,text,text,uuid)','EXECUTE')
  AND NOT has_function_privilege('anon','public.arca_activate_certificate_rotation(uuid,uuid,text,text,text,uuid)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.arca_activate_certificate_rotation(uuid,uuid,text,text,text,uuid)','EXECUTE'));
SELECT pg_temp.chk('25 rollback service_role-only',
  has_function_privilege('service_role','public.arca_rollback_certificate_rotation(uuid,uuid,text,uuid)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.arca_rollback_certificate_rotation(uuid,uuid,text,uuid)','EXECUTE'));

\echo '── AFIP-S4B-2A resultados ──'
SELECT n, (CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END) AS r, label FROM s4b2_results ORDER BY n;
DO $v$
DECLARE f int;
BEGIN
  SELECT count(*) INTO f FROM s4b2_results WHERE NOT ok;
  IF f > 0 THEN RAISE EXCEPTION 'AFIP-S4B-2A: % assert(s) fallaron', f;
  ELSE RAISE NOTICE 'AFIP-S4B-2A: % asserts OK', (SELECT count(*) FROM s4b2_results); END IF;
END $v$;
ROLLBACK;
