-- ============================================================================
-- AFIP-S3A.1 — Identidad canónica de la clave pública RSA + correspondencia
-- clave↔certificado por parseo ESTRUCTURADO del SubjectPublicKeyInfo.
--
-- Fingerprint = SHA-256 del SPKI DER (incluye modulus Y publicExponent), el
-- mismo que produce `openssl rsa -pubout -outform DER | sha256sum`. Los valores
-- esperados se calcularon INDEPENDIENTEMENTE en Deno/node-forge.
--
-- Fixtures SINTÉTICOS (RSA 1024, generados para estos tests). tx + ROLLBACK.
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

CREATE OR REPLACE FUNCTION pg_temp.key_a() RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT $pem$-----BEGIN RSA PRIVATE KEY-----
MIICWwIBAAKBgQCoBqLh2RvaHoLVzZcLlr/86gHEPrJkwCnveWz2x9Hr15dCpWQh
MCBakrHBrmyc1zYjbX6LTFR71W+6dSqlydA9qYRLTbojZjfUs4RIxkYE9tJUHCSY
2+ovkIzMRqqJypleK25ztNN5sNmVmf7/xAcMW7LFde+NFAIzdZ2Mk12MbQIDAQAB
AoGAFTspb7I4Q7phO9TLhipZPgLvkDV/4x0o71p/eztKeit2sHQnj839+JPapCd/
D95dt+JJAB73+eHBSWUuq14x0rRjn6F4RvWsnOEIVcoo8wT1NI/zOYgRdebTU49c
E4CsFObz5Hj9Abh7aylxWUKqxhp4EHIg/4IWTdlwUIdbGX0CQQDQ6TIZhf9SbN5d
s9zDOve5KyVUT3OkpL/ecG25E4uM8QCg/Jb/uD0C3oHVvy+jy2Mlre5N2bawahFb
3hDde2DTAkEAzeZAB3lIV1KQwyadtN6Pi/uIBmDksGShLjFw3SyPXA8jHKzNYLIr
OpraPVrnKA2jDTUB37uEfq5M9J1yocUVvwJAapE6bEitaMd+W0A/8hsneP6oaSyq
aidcdMTXQ9zTiA78aiLPiBzcipUkl/uR+rTqm7Lw6CeSCMXimwFZixG/3wJAVZV0
Xebqy+k05PkjKnAsSKpH0ybpR+y8FoBUgoqoGELufFfTknLchyKgvkoPtVVdxfqX
idDe9O0sba0YXeeW7wJAbf7OdE8SADZ5oTmlL3tqrxLwyp4ilvdrxIyijAPmvfZ9
cF6QzfCOLfBn53GcgzZnfaXMWer/loxMcqXShzk9Hw==
-----END RSA PRIVATE KEY-----$pem$ $fn$;

CREATE OR REPLACE FUNCTION pg_temp.key_a8() RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT $pem$-----BEGIN PRIVATE KEY-----
MIICdQIBADANBgkqhkiG9w0BAQEFAASCAl8wggJbAgEAAoGBAKgGouHZG9oegtXN
lwuWv/zqAcQ+smTAKe95bPbH0evXl0KlZCEwIFqSscGubJzXNiNtfotMVHvVb7p1
KqXJ0D2phEtNuiNmN9SzhEjGRgT20lQcJJjb6i+QjMxGqonKmV4rbnO003mw2ZWZ
/v/EBwxbssV1740UAjN1nYyTXYxtAgMBAAECgYAVOylvsjhDumE71MuGKlk+Au+Q
NX/jHSjvWn97O0p6K3awdCePzf34k9qkJ38P3l234kkAHvf54cFJZS6rXjHStGOf
oXhG9ayc4QhVyijzBPU0j/M5iBF15tNTj1wTgKwU5vPkeP0BuHtrKXFZQqrGGngQ
ciD/ghZN2XBQh1sZfQJBANDpMhmF/1Js3l2z3MM697krJVRPc6Skv95wbbkTi4zx
AKD8lv+4PQLegdW/L6PLYyWt7k3ZtrBqEVveEN17YNMCQQDN5kAHeUhXUpDDJp20
3o+L+4gGYOSwZKEuMXDdLI9cDyMcrM1gsis6mto9WucoDaMNNQHfu4R+rkz0nXKh
xRW/AkBqkTpsSK1ox35bQD/yGyd4/qhpLKpqJ1x0xNdD3NOIDvxqIs+IHNyKlSSX
+5H6tOqbsvDoJ5IIxeKbAVmLEb/fAkBVlXRd5urL6TTk+SMqcCxIqkfTJulH7LwW
gFSCiqgYQu58V9OSctyHIqC+Sg+1VV3F+peJ0N707SxtrRhd55bvAkBt/s50TxIA
NnmhOaUve2qvEvDKniKW92vEjKKMA+a99n1wXpDN8I4t8GfncZyDNmd9pcxZ6v+W
jExypdKHOT0f
-----END PRIVATE KEY-----$pem$ $fn$;

CREATE OR REPLACE FUNCTION pg_temp.cert_a() RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT $pem$-----BEGIN CERTIFICATE-----
MIIBlTCB/6ADAgECAgEBMA0GCSqGSIb3DQEBCwUAMBExDzANBgNVBAMTBnMzYTEt
QTAeFw0yMDAxMDEwMzAwMDBaFw0zNTAxMDEwMzAwMDBaMBExDzANBgNVBAMTBnMz
YTEtQTCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAqAai4dkb2h6C1c2XC5a/
/OoBxD6yZMAp73ls9sfR69eXQqVkITAgWpKxwa5snNc2I21+i0xUe9VvunUqpcnQ
PamES026I2Y31LOESMZGBPbSVBwkmNvqL5CMzEaqicqZXituc7TTebDZlZn+/8QH
DFuyxXXvjRQCM3WdjJNdjG0CAwEAATANBgkqhkiG9w0BAQsFAAOBgQA+gm9zkCgO
PHgkclDpuWait/sJQMziHgTxsypKVmY85JtPzG/oS3bIXU1SC0OQZSiuj79RZ+yv
mkRd3thhNFD1co1UCLEXLtd25+13/cYmgOHiCKk0TW8e2qZ2VJGDDyUtGt+JdMPT
mvNVCWyyxwRiE5vLiq/hlkuulMhrQNclZw==
-----END CERTIFICATE-----$pem$ $fn$;

CREATE OR REPLACE FUNCTION pg_temp.key_b() RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT $pem$-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQC4U0OxVam6VDr71ptBQWV0nQ3/EajnDHgA0J7IJP62uv6C/YvA
rYMG029rpYe9JM9Ui7KCHCEjmtd96TQUKGWMdmBmAexazEhfRKhhrqvWO+ZHJ3VY
LuDAAsBK3R1qN4Zd8Sp0+ndUFqgvkVUF0HJF2hX86JFFkhhelT11B70erQIDAQAB
AoGAG2CSn1Y/3WMBV8JqUOjrrsRc/dObqKWbdVOHIecMxgtEHiSWi0m6OltRI0X0
wU0kVkRhgR24dldbRmJKz+uoGVI1yy0EU7nnWxuY1ArUo0ie/QDMctsF8DTdKzm/
5buRK/2CnAevwkUwfaI0FVs0YFaLvqr97mfmZ4ZqXccm1KkCQQDTLXRKRblomPBc
R5zVebHp1ihsiQqkd9SL5RVCcbiEPxv5xtxpfvLoVYGUmqHoxA4/DnReMk/yGI1R
blhl2hvPAkEA33LDWzHXPq38iDp8eyF3BqDvcvta96Mq0zye4i0MjZf01o0pT7ND
9qcvT2vfDu0wvlI+rATEje+8usqH15MQwwJBAMmIh4KaJ+d6jWiDr1jLWs8eYlWy
M0XiViVr6m4OuVj8IWauMYs8a/TuJUv8hqfs8uuaj9OVkFYquDMOa65ICGECQQDC
t2lR0O73KfrEY+MSEal9V0USd8NfxQqOpWb3RbaItQCg7sYvM9Jn4Gyz0xbAFSXC
1DzU/hqibWWTiOYzj26tAkA2gc7Z9LzGyp/EaPHNB4coUAeoNoaHIGiHBklqJfA/
ZaFEMDg0IPTyZkrMupnRFUkAHNcE4+uQbt5ixNtdIYQF
-----END RSA PRIVATE KEY-----$pem$ $fn$;

-- CRÍTICO: certificado cuyo SPKI es la clave B, pero que lleva el MÓDULO DE A
-- dentro de una extensión. Una búsqueda libre de bytes daría falso positivo.
CREATE OR REPLACE FUNCTION pg_temp.cert_trap() RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT $pem$-----BEGIN CERTIFICATE-----
MIICNjCCAZ+gAwIBAgIBATANBgkqhkiG9w0BAQsFADAWMRQwEgYDVQQDEwtzM2Ex
LUItdHJhcDAeFw0yMDAxMDEwMzAwMDBaFw0zNTAxMDEwMzAwMDBaMBYxFDASBgNV
BAMTC3MzYTEtQi10cmFwMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC4U0Ox
Vam6VDr71ptBQWV0nQ3/EajnDHgA0J7IJP62uv6C/YvArYMG029rpYe9JM9Ui7KC
HCEjmtd96TQUKGWMdmBmAexazEhfRKhhrqvWO+ZHJ3VYLuDAAsBK3R1qN4Zd8Sp0
+ndUFqgvkVUF0HJF2hX86JFFkhhelT11B70erQIDAQABo4GTMIGQMIGNBggqAwQF
BgcIAQSBgKgGouHZG9oegtXNlwuWv/zqAcQ+smTAKe95bPbH0evXl0KlZCEwIFqS
scGubJzXNiNtfotMVHvVb7p1KqXJ0D2phEtNuiNmN9SzhEjGRgT20lQcJJjb6i+Q
jMxGqonKmV4rbnO003mw2ZWZ/v/EBwxbssV1740UAjN1nYyTXYxtMA0GCSqGSIb3
DQEBCwUAA4GBAAAtLQGCADAWVLPzr/Jo6JlZ88aYO6Y8nkN+Fgd/faRo/Rdg2buB
GuJ4i2iy7gJL/RxQn6tjCGZiDfxA5PslRiT1LDsCh1BjFEOQAvI1FJid/qKhQgSL
zFV1eOEwqlllL348/X4Ei1ISnev+C9WoLF7jeZKC21XVZs1SQ+PY1tMy
-----END CERTIFICATE-----$pem$ $fn$;

CREATE OR REPLACE FUNCTION pg_temp.fp_a() RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT '638e22963693de906942de579cd84d999ec82fb3c5df8957bb010d6ab7c82bef' $fn$;
CREATE OR REPLACE FUNCTION pg_temp.fp_b() RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT '95025c22ec2d37789679747b956e5ce4c397158c50657d27cba3a07125db13c5' $fn$;
CREATE OR REPLACE FUNCTION pg_temp.fp_a_e17() RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT '08aca743e4b8fd833576647a2bc5c947ea88ae14af723bfdd4f2caab6014c8c1' $fn$;

-- Negocios sintéticos
INSERT INTO public.businesses (id, name, owner_user_id, subscription_plan, subscription_status) VALUES
  ('00000000-0000-4000-8000-000000053a01','S3A-ok',   NULL,'pro','active'),
  ('00000000-0000-4000-8000-000000053a02','S3A-mism', NULL,'pro','active'),
  ('00000000-0000-4000-8000-000000053a03','S3A-nokey',NULL,'pro','active'),
  ('00000000-0000-4000-8000-000000053a04','S3A-bad',  NULL,'pro','active'),
  ('00000000-0000-4000-8000-000000053a05','S3A-trap', NULL,'pro','active')
ON CONFLICT (id) DO UPDATE SET subscription_plan='pro';

-- AFIP-S4C: `private_key` ya no existe. Los fixtures conservan el certificado y
-- el cache; la clave, cuando hace falta, va a Vault por el contrato vigente.
INSERT INTO public.arca_config (business_id, cuit, ambiente, punto_venta, web_service, alias, cert_file, wsaa_token, wsaa_sign, estado_conexion) VALUES
  ('00000000-0000-4000-8000-000000053a01','20111111112','homologacion',1,'wsfe','a', pg_temp.cert_a(), 'tokA','sigA','conectado'),
  ('00000000-0000-4000-8000-000000053a02','20111111112','homologacion',1,'wsfe','b', pg_temp.cert_a(), 'tokB','sigB','conectado'),
  ('00000000-0000-4000-8000-000000053a03','20111111112','homologacion',1,'wsfe','c', pg_temp.cert_a(), 'tokC','sigC','conectado'),
  ('00000000-0000-4000-8000-000000053a04','20111111112','homologacion',1,'wsfe','d', pg_temp.cert_a(), 'tokD','sigD','conectado'),
  ('00000000-0000-4000-8000-000000053a05','20111111112','homologacion',1,'wsfe','e', pg_temp.cert_trap(),'tokE','sigE','conectado')
ON CONFLICT (business_id) DO NOTHING;

SET LOCAL request.jwt.claims = '{"role":"service_role"}';

-- ══ Grants ═════════════════════════════════════════════════════════════════
SELECT pg_temp.assert(has_function_privilege('service_role','public.arca_migrate_legacy_private_key_to_vault(uuid,text,text)','EXECUTE'),
  'T12 service_role puede ejecutar');
SELECT pg_temp.assert(NOT has_function_privilege('anon','public.arca_migrate_legacy_private_key_to_vault(uuid,text,text)','EXECUTE'),
  'T13 anon no puede');
SELECT pg_temp.assert(NOT has_function_privilege('authenticated','public.arca_migrate_legacy_private_key_to_vault(uuid,text,text)','EXECUTE'),
  'T14 authenticated no puede');
SELECT pg_temp.assert(NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
  WHERE p.oid='public.arca_migrate_legacy_private_key_to_vault(uuid,text,text)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE'),
  'T15 PUBLIC no puede');

-- ══ S3A.1-1: el fingerprint incluye modulus Y exponent ═════════════════════
SELECT pg_temp.assert(private.arca_key_fingerprint(pg_temp.key_a()) = pg_temp.fp_a(),
  'N1 fingerprint SQL == SPKI SHA-256 calculado en Deno (cross-validación)');
SELECT pg_temp.assert(
  (SELECT private.arca_rsa_public_key_fingerprint_sha256(k.n, k.e) FROM private.arca_rsa_pubkey_from_private(private.arca_pem_to_der(pg_temp.key_a())) k)
   = pg_temp.fp_a(),
  'N1b el fingerprint se deriva de (n,e) extraídos estructuralmente');
-- Mismo n, exponente distinto (17) → fingerprint DISTINTO (prueba que e participa)
SELECT pg_temp.assert(
  (SELECT private.arca_rsa_public_key_fingerprint_sha256(k.n, '\x11'::bytea) FROM private.arca_rsa_pubkey_from_private(private.arca_pem_to_der(pg_temp.key_a())) k)
   = pg_temp.fp_a_e17(),
  'N2 mismo modulus con exponent=17 → fingerprint distinto y coincide con Deno');
SELECT pg_temp.assert(
  (SELECT private.arca_rsa_public_key_fingerprint_sha256(k.n, '\x11'::bytea) <> private.arca_rsa_public_key_fingerprint_sha256(k.n, k.e)
     FROM private.arca_rsa_pubkey_from_private(private.arca_pem_to_der(pg_temp.key_a())) k),
  'N3 el exponente cambia el fingerprint (no es SHA-256(modulus))');
-- Cambiar un byte del modulus → fingerprint distinto
SELECT pg_temp.assert(
  (SELECT private.arca_rsa_public_key_fingerprint_sha256(set_byte(k.n, 5, (get_byte(k.n,5)+1)%256), k.e) <> pg_temp.fp_a()
     FROM private.arca_rsa_pubkey_from_private(private.arca_pem_to_der(pg_temp.key_a())) k),
  'N4 alterar un byte del modulus cambia el fingerprint');

-- ══ S3A.1-2: PKCS#1 == PKCS#8, CRLF, espacios ══════════════════════════════
SELECT pg_temp.assert(private.arca_key_fingerprint(pg_temp.key_a8()) = pg_temp.fp_a(),
  'N5 misma clave en PKCS#8 → MISMO fingerprint');
SELECT pg_temp.assert(private.arca_key_fingerprint(replace(pg_temp.key_a(), E'\n', E'\r\n')) = pg_temp.fp_a()
  AND private.arca_key_fingerprint('  ' || pg_temp.key_a() || E'\n\n') = pg_temp.fp_a(),
  'N6 CRLF y espacios externos → MISMO fingerprint');
SELECT pg_temp.assert(private.arca_key_fingerprint(pg_temp.key_b()) = pg_temp.fp_b(),
  'N7 clave B → su propio fingerprint (coincide con Deno)');

-- ══ S3A.1-3: correspondencia por SPKI estructurado ═════════════════════════
SELECT pg_temp.assert(private.arca_key_matches_certificate(pg_temp.key_a(), pg_temp.cert_a()),
  'N8 par correcto (n,e) → match');
SELECT pg_temp.assert(NOT private.arca_key_matches_certificate(pg_temp.key_b(), pg_temp.cert_a()),
  'N9 distinto n, mismo e → mismatch');
-- ⭐ El caso que demuestra que ya NO hay búsqueda libre de bytes:
SELECT pg_temp.assert(NOT private.arca_key_matches_certificate(pg_temp.key_a(), pg_temp.cert_trap()),
  'N10 ⭐ modulus de A presente en una EXTENSIÓN del cert (SPKI=B) → mismatch');
SELECT pg_temp.assert(position(private.arca_uint_canon(
    (SELECT k.n FROM private.arca_rsa_pubkey_from_private(private.arca_pem_to_der(pg_temp.key_a())) k))
  in private.arca_pem_to_der(pg_temp.cert_trap())) > 0,
  'N10b (control) el modulus de A SÍ está en los bytes del cert trampa — la búsqueda libre habría dado falso positivo');
SELECT pg_temp.assert(
  (SELECT c.n FROM private.arca_rsa_pubkey_from_cert(private.arca_pem_to_der(pg_temp.cert_trap())) c)
  = (SELECT k.n FROM private.arca_rsa_pubkey_from_private(private.arca_pem_to_der(pg_temp.key_b())) k),
  'N10c el SPKI del cert trampa es efectivamente la clave B');

-- ══ S3A.1-4: entradas malformadas → fail-closed ════════════════════════════
SELECT pg_temp.assert(
  (SELECT c.n IS NULL FROM private.arca_rsa_pubkey_from_cert(substring(private.arca_pem_to_der(pg_temp.cert_a()) from 1 for 80)) c),
  'N11 certificado truncado → sin clave (fail-closed)');
SELECT pg_temp.assert(
  (SELECT c.n IS NULL FROM private.arca_rsa_pubkey_from_cert(
     -- corrompe el byte de "unused bits" del BIT STRING poniéndolo en 1
     (SELECT set_byte(d, position('\x0030818902818100'::bytea in d)-1, 1)
        FROM private.arca_pem_to_der(pg_temp.cert_a()) d)) c),
  'N12 BIT STRING con unused bits != 0 → rechazado');
SELECT pg_temp.assert(
  (SELECT c.n IS NULL FROM private.arca_rsa_pubkey_from_cert(
     (SELECT set_byte(d, position('\x2a864886f70d010101'::bytea in d)+2, 99)
        FROM private.arca_pem_to_der(pg_temp.cert_a()) d)) c),
  'N13 OID distinto de rsaEncryption → rechazado');
SELECT pg_temp.assert(private.arca_key_fingerprint('no-es-pem') IS NULL
  AND private.arca_key_fingerprint(pg_temp.cert_a()) IS NULL,
  'N14 basura o certificado como "clave privada" → sin fingerprint');

-- ══ AFIP-S4C — el flujo de migración legacy→Vault está RETIRADO ════════════
-- Reemplaza al bloque T1/T3-T10/T16-T18/N15-N18, que probaba MIGRATED,
-- ALREADY_MIGRATED, idempotencia y conflictos de una migración que ya no existe:
-- la clave en claro fue eliminada, así que no hay nada que migrar. Lo que se
-- protege ahora es que el contrato quede INERTE y no reabra el camino legacy.
--
-- La provisión canónica vigente (arca_store_credential / contrato Vault) se
-- prueba más abajo, en su propio bloque.

CREATE TEMP TABLE s3a_pre_retiro AS
SELECT (SELECT count(*) FROM vault.secrets) AS secretos,
       (SELECT count(*) FROM private.arca_private_key_credentials) AS credenciales,
       (SELECT md5(string_agg(coalesce(cert_file,'')||coalesce(alias,'')||coalesce(estado_conexion,''), '|' ORDER BY business_id))
          FROM public.arca_config) AS cfg_md5;

-- Llamadas repetidas, con distintos negocios, fingerprints y keys: todas inertes.
DO $t$
DECLARE r jsonb; v_estados text[] := '{}';
BEGIN
  FOREACH r IN ARRAY ARRAY[
    public.arca_migrate_legacy_private_key_to_vault('00000000-0000-4000-8000-000000053a01', pg_temp.fp_a(), 'idem-ok-1'),
    public.arca_migrate_legacy_private_key_to_vault('00000000-0000-4000-8000-000000053a01', pg_temp.fp_a(), 'idem-ok-1'),
    public.arca_migrate_legacy_private_key_to_vault('00000000-0000-4000-8000-000000053a01', pg_temp.fp_b(), 'idem-ok-1'),
    public.arca_migrate_legacy_private_key_to_vault('00000000-0000-4000-8000-000000053a02', pg_temp.fp_a(), 'idem-fp'),
    public.arca_migrate_legacy_private_key_to_vault('00000000-0000-4000-8000-000000053a05', pg_temp.fp_a(), 'idem-trap'),
    public.arca_migrate_legacy_private_key_to_vault('00000000-0000-4000-8000-000000053a03', 'deadbeef', 'idem-nokey')
  ] LOOP
    v_estados := v_estados || (r->>'state');
    PERFORM pg_temp.assert(NOT (r::text ~* 'BEGIN|PRIVATE KEY|MII'), 'T17 el retorno no contiene PEM');
    PERFORM pg_temp.assert(NOT (r ? 'secret_id'), 'T16 el retorno no contiene secret_id');
  END LOOP;

  PERFORM pg_temp.assert(v_estados = ARRAY['LEGACY_MIGRATION_RETIRED','LEGACY_MIGRATION_RETIRED','LEGACY_MIGRATION_RETIRED',
                                           'LEGACY_MIGRATION_RETIRED','LEGACY_MIGRATION_RETIRED','LEGACY_MIGRATION_RETIRED'],
    'T1 toda invocación responde LEGACY_MIGRATION_RETIRED (determinista)');
  PERFORM pg_temp.assert(NOT (array_to_string(v_estados,',') ~ 'MIGRATED|ALREADY_MIGRATED'),
    'T1b el contrato retirado NO reactiva el flujo legacy');
END $t$;

SELECT pg_temp.assert((SELECT count(*) FROM vault.secrets) = (SELECT secretos FROM s3a_pre_retiro),
  'T2 cero secretos creados por el contrato retirado');
SELECT pg_temp.assert((SELECT count(*) FROM private.arca_private_key_credentials) = (SELECT credenciales FROM s3a_pre_retiro),
  'T3 cero credenciales modificadas');
SELECT pg_temp.assert(
  (SELECT md5(string_agg(coalesce(cert_file,'')||coalesce(alias,'')||coalesce(estado_conexion,''), '|' ORDER BY business_id))
     FROM public.arca_config) = (SELECT cfg_md5 FROM s3a_pre_retiro),
  'T4 cero cambios en arca_config');
SELECT pg_temp.assert(NOT EXISTS (SELECT 1 FROM private.arca_credential_provision_requests WHERE idempotency_key IN ('idem-ok-1','idem-fp','idem-trap','idem-nokey')),
  'T5 no deja estados parciales de provisión');
SELECT pg_temp.assert(
  NOT EXISTS (SELECT 1 FROM private.arca_private_key_credentials c
    WHERE c.private_key_secret_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM vault.secrets s WHERE s.id = c.private_key_secret_id)),
  'T6 no deja secretos huérfanos');
SELECT pg_temp.assert(
  regexp_replace((SELECT prosrc FROM pg_proc WHERE oid='public.arca_migrate_legacy_private_key_to_vault(uuid,text,text)'::regprocedure),
                 '--[^\n]*','','g') !~ '\marca_config\M',
  'T7 el stub retirado ni siquiera lee arca_config');

-- ══ Provisión CANÓNICA vigente (reemplaza la cobertura perdida) ════════════
-- El camino real de provisión hoy es el contrato Vault, no la migración legacy.
-- Devuelve la referencia del secreto: se comprueba que provisionó, sin imprimirla.
SELECT pg_temp.assert(
  public.arca_store_credential('00000000-0000-4000-8000-000000053a01', pg_temp.key_a(), pg_temp.fp_a(), NULL,
     'RSA', 2048, NULL, false, false) IS NOT NULL,
  'T8 la provisión canónica vigente pasa por arca_store_credential');
SELECT pg_temp.assert((SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-000000053a01')=1,
  'T8b la provisión canónica vincula exactamente una credencial');
SELECT pg_temp.assert(private.arca_key_fingerprint(private.arca_get_private_key_for_signing('00000000-0000-4000-8000-000000053a01')) = pg_temp.fp_a(),
  'T8c readback: la clave provisionada es la esperada (fingerprint canónico)');

-- ══ Sin huérfanos ══════════════════════════════════════════════════════════
SELECT pg_temp.assert(
  (SELECT count(*) FROM vault.secrets s WHERE s.name LIKE 'arca-private-key:%')
  = (SELECT count(*) FROM private.arca_private_key_credentials),
  'T11 sin secretos huérfanos (secretos == vínculos)');
-- AFIP-S4C: reemplaza a 'T18 private_key legacy INTACTA tras migrar' — ya no hay
-- columna legacy que preservar; lo que se exige es que nadie la reintroduzca.
SELECT pg_temp.assert(
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema='public' AND table_name='arca_config' AND column_name='private_key') = 0,
  'T18 la provisión no reintroduce almacenamiento de clave en claro');
SELECT pg_temp.assert((SELECT cert_file = pg_temp.cert_a() FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-000000053a01'),
  'T19 cert_file intacto');
SELECT pg_temp.assert((SELECT wsaa_token='tokA' AND wsaa_sign='sigA' FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-000000053a01'),
  'T20 token/sign intactos');
-- AFIP-S4C: los eventos `arca_private_key_vault_*` eran de la migración legacy,
-- ya retirada. La provisión canónica audita `credential_store_success`.
SELECT pg_temp.assert((SELECT count(*) FROM private.arca_credential_audit WHERE event = 'credential_store_success')>=1,
  'T21a se auditó la provisión canónica (credential_store_success)');
SELECT pg_temp.assert((SELECT count(*) FROM private.arca_credential_audit WHERE event LIKE 'arca_private_key_vault_%')=0,
  'T21a2 el contrato retirado no emite eventos de migración');
SELECT pg_temp.assert(NOT EXISTS (
  SELECT 1 FROM private.arca_credential_audit
   WHERE coalesce(fingerprint_trunc,'')||coalesce(status,'')||coalesce(error_code,'') ~* 'BEGIN|PRIVATE KEY|MII'),
  'T21b la auditoría no contiene material de clave');
SELECT pg_temp.assert(NOT EXISTS (
  SELECT 1 FROM private.arca_credential_provision_requests WHERE result::text ~* 'BEGIN|PRIVATE KEY|MII'),
  'T21c las solicitudes registradas no contienen material');

-- ══ Integración con el resolver S2 ═════════════════════════════════════════
SELECT pg_temp.assert((public.arca_get_credential_for_signing('00000000-0000-4000-8000-000000053a01')->>'provisioned')='true'
  AND (public.arca_get_credential_for_signing('00000000-0000-4000-8000-000000053a01')->>'ok')='true',
  'T16a tras provisionar: provisioned=true, ok=true');
SELECT pg_temp.assert((public.arca_get_credential_for_signing('00000000-0000-4000-8000-000000053a02')->>'provisioned')='false',
  'T16b negocio sin provisionar: provisioned=false');
DELETE FROM vault.secrets WHERE id=(SELECT private_key_secret_id FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-000000053a01');
SELECT pg_temp.assert((public.arca_get_credential_for_signing('00000000-0000-4000-8000-000000053a01')->>'reason')='secret_missing',
  'T16c secreto roto → secret_missing (el resolver FALLA, no cae a legacy)');

-- ══ Limpieza ═══════════════════════════════════════════════════════════════
DELETE FROM private.arca_private_key_credentials WHERE business_id::text LIKE '00000000-0000-4000-8000-000000053a%';
SELECT pg_temp.assert((SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id::text LIKE '00000000-0000-4000-8000-000000053a%')=0,
  'T22 limpieza de credenciales sintéticas');

ROLLBACK;
