-- ============================================================================
-- AFIP-S3A — Concurrencia del provisionamiento.
--
-- El advisory lock por negocio + UNIQUE(business_id) en la tabla de credenciales
-- + UNIQUE(business_id, idempotency_key) garantizan que dos invocaciones
-- simultáneas NO puedan crear dos secretos ni dos credenciales activas.
--
-- Nota metodológica: psql es de una sola sesión, así que la carrera REAL entre
-- backends la ejecuta scripts/finance/arca-s3a-concurrency.mjs (N conexiones
-- simultáneas). Acá se verifican las INVARIANTES estructurales y el
-- comportamiento secuencial equivalente. Fixtures SINTÉTICOS. tx + ROLLBACK.
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

INSERT INTO public.businesses (id, name, owner_user_id, subscription_plan, subscription_status)
VALUES ('00000000-0000-4000-8000-0000000c0a01','S3A-conc', NULL,'pro','active')
ON CONFLICT (id) DO UPDATE SET subscription_plan='pro';
-- AFIP-S4C: `private_key` ya no existe; la clave vive sólo en Vault.
INSERT INTO public.arca_config (business_id, cuit, ambiente, punto_venta, web_service, alias, cert_file, estado_conexion)
VALUES ('00000000-0000-4000-8000-0000000c0a01','20111111112','homologacion',1,'wsfe','x', pg_temp.cert_a(),'conectado')
ON CONFLICT (business_id) DO NOTHING;

SET LOCAL request.jwt.claims = '{"role":"service_role"}';
\set fpa '638e22963693de906942de579cd84d999ec82fb3c5df8957bb010d6ab7c82bef'

-- ══ C1-C3. Invariantes que hacen imposible la doble credencial ═════════════
SELECT pg_temp.assert(EXISTS (
  SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
  WHERE n.nspname='private' AND t.relname='arca_private_key_credentials' AND c.contype='u'
    AND pg_get_constraintdef(c.oid) ILIKE '%business_id%'),
  'C1 UNIQUE(business_id) en arca_private_key_credentials');
SELECT pg_temp.assert(EXISTS (
  SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
  WHERE n.nspname='private' AND t.relname='arca_credential_provision_requests' AND c.contype='u'
    AND pg_get_constraintdef(c.oid) ILIKE '%business_id%idempotency_key%'),
  'C2 UNIQUE(business_id, idempotency_key) en las solicitudes');
-- ══ AFIP-S4C — el contrato retirado es INERTE bajo repetición ══════════════
-- Reemplaza a C3-C6, que probaban el advisory lock y la idempotencia
-- (MIGRATED / ALREADY_MIGRATED / conflictos) de una migración que ya no existe.
-- Serializar una operación que no hace nada no tiene sentido; lo que hay que
-- proteger es que repetirla siga sin efectos y con resultado determinista.
CREATE TEMP TABLE c0a_pre AS
SELECT (SELECT count(*) FROM vault.secrets) AS secretos,
       (SELECT count(*) FROM private.arca_private_key_credentials) AS credenciales,
       (SELECT count(*) FROM private.arca_credential_provision_requests) AS solicitudes,
       (SELECT md5(coalesce(cert_file,'')||coalesce(alias,'')||coalesce(estado_conexion,''))
          FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000c0a01') AS cfg_md5;

SELECT pg_temp.assert(
  (public.arca_migrate_legacy_private_key_to_vault('00000000-0000-4000-8000-0000000c0a01', :'fpa', 'k1')->>'state')='LEGACY_MIGRATION_RETIRED',
  'C3 el contrato retirado responde LEGACY_MIGRATION_RETIRED');
SELECT pg_temp.assert(
  (public.arca_migrate_legacy_private_key_to_vault('00000000-0000-4000-8000-0000000c0a01', :'fpa', 'k1')->>'state')
  = (public.arca_migrate_legacy_private_key_to_vault('00000000-0000-4000-8000-0000000c0a01','95025c22ec2d37789679747b956e5ce4c397158c50657d27cba3a07125db13c5','k3')->>'state'),
  'C4 resultado determinista con cualquier key y cualquier fingerprint');
SELECT pg_temp.assert((SELECT count(*) FROM vault.secrets) = (SELECT secretos FROM c0a_pre),
  'C5 cero secretos creados por invocaciones repetidas');
SELECT pg_temp.assert((SELECT count(*) FROM private.arca_private_key_credentials) = (SELECT credenciales FROM c0a_pre),
  'C6a cero credenciales creadas o modificadas');
SELECT pg_temp.assert((SELECT count(*) FROM private.arca_credential_provision_requests) = (SELECT solicitudes FROM c0a_pre),
  'C6b cero estados parciales de provisión');
SELECT pg_temp.assert(
  (SELECT md5(coalesce(cert_file,'')||coalesce(alias,'')||coalesce(estado_conexion,''))
     FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000c0a01') = (SELECT cfg_md5 FROM c0a_pre),
  'C6c cero cambios en arca_config');

-- ══ C7. Sin huérfanos ══════════════════════════════════════════════════════
SELECT pg_temp.assert(
  (SELECT count(*) FROM vault.secrets WHERE name LIKE 'arca-private-key:%')
  = (SELECT count(*) FROM private.arca_private_key_credentials),
  'C7 secretos == vínculos (ningún huérfano)');

DELETE FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-0000000c0a01';
ROLLBACK;
