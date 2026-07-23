-- ============================================================================
-- AFIP-S3A — Provisionamiento server-side seguro de la clave legacy hacia Vault.
--
-- Crea el MECANISMO (dormido) para copiar public.arca_config.private_key hacia
-- Supabase Vault y vincularla en private.arca_private_key_credentials SIN que el
-- PEM salga jamás de PostgreSQL: el operador solo aporta business_id, el
-- fingerprint esperado y una idempotency_key. Nunca el PEM.
--
--   public.arca_config.private_key → (SECURITY DEFINER) → Vault → vínculo privado
--
-- ⚠️ Provisioning requires an explicit S3B operator invocation.
-- Esta migración NO ejecuta la función, NO crea secretos, NO inserta credenciales
-- y NO contiene DML productivo. Reutiliza íntegro el contrato S1A (no crea una
-- arquitectura paralela).
--
-- FINGERPRINT CANÓNICO: SHA-256 del *módulo RSA* (no del texto PEM). Es estable
-- ante CRLF/LF/espacios y ante re-codificación PKCS#1 ↔ PKCS#8, e identifica la
-- clave pública (equivalente en propósito a un fingerprint SPKI).
--
-- CORRESPONDENCIA CLAVE↔CERTIFICADO: criptográfica, no textual. Se extrae el
-- módulo del RSAPrivateKey y se exige que aparezca en el DER del certificado
-- (el SPKI del cert contiene ese mismo INTEGER). Es la misma igualdad de módulo
-- que verifica afip-wsaa (verifyCertKeyMatch: cert.publicKey.n === privateKey.n).
-- ============================================================================

-- ── 1. Auditoría: allowlist de eventos de provisión ─────────────────────────
ALTER TABLE private.arca_credential_audit DROP CONSTRAINT IF EXISTS arca_credential_audit_event_check;
ALTER TABLE private.arca_credential_audit ADD CONSTRAINT arca_credential_audit_event_check CHECK (event IN (
  'credential_validation_success','credential_validation_failure',
  'credential_store_success','credential_store_failure','credential_replaced','credential_deleted',
  'arca_config_legacy_saved','arca_certificate_legacy_saved','arca_estado_updated',
  'wsaa_private_key_resolved_vault','wsaa_private_key_resolved_legacy','wsaa_private_key_resolution_failed',
  'arca_private_key_vault_migration_started','arca_private_key_vault_migrated',
  'arca_private_key_vault_migration_failed','arca_private_key_vault_migration_replayed'));

-- ── 2. Tabla privada de solicitudes (idempotencia) ──────────────────────────
CREATE TABLE IF NOT EXISTS private.arca_credential_provision_requests (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id    uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_hash   text NOT NULL,
  operation      text NOT NULL DEFAULT 'migrate_legacy_private_key_to_vault',
  state          text NOT NULL,
  result         jsonb,                       -- SANITIZADO: nunca PEM ni secret_id
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  CONSTRAINT arca_provision_requests_key_uq UNIQUE (business_id, idempotency_key)
);
ALTER TABLE private.arca_credential_provision_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.arca_credential_provision_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.arca_credential_provision_requests FROM PUBLIC, anon, authenticated, service_role;

-- ── 3. Helpers DER/ASN.1 mínimos (privados) ─────────────────────────────────
-- Longitud DER (corta o larga) a partir del offset del tag (0-based).
CREATE OR REPLACE FUNCTION private.arca_der_len(p bytea, i integer, OUT len integer, OUT content_start integer)
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE b integer; n integer; k integer;
BEGIN
  b := get_byte(p, i+1);
  IF b < 128 THEN
    len := b; content_start := i + 2;
  ELSE
    n := b - 128; len := 0;
    FOR k IN 0..n-1 LOOP len := len*256 + get_byte(p, i+2+k); END LOOP;
    content_start := i + 2 + n;
  END IF;
END $$;
ALTER FUNCTION private.arca_der_len(bytea,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.arca_der_len(bytea,integer) FROM PUBLIC, anon, authenticated, service_role;

-- PEM → DER canónico (ignora encabezados, saltos de línea y espacios).
CREATE OR REPLACE FUNCTION private.arca_pem_to_der(p_pem text) RETURNS bytea
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT decode(regexp_replace(regexp_replace(coalesce(p_pem,''), '-----(BEGIN|END)[^-]*-----', '', 'g'), '\s', '', 'g'), 'base64');
$$;
ALTER FUNCTION private.arca_pem_to_der(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.arca_pem_to_der(text) FROM PUBLIC, anon, authenticated, service_role;

-- Módulo RSA desde un DER de clave privada (PKCS#1 RSAPrivateKey o PKCS#8).
-- Devuelve NULL si no puede parsearse (fail-closed aguas arriba).
CREATE OR REPLACE FUNCTION private.arca_rsa_modulus(p_der bytea) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE c0 integer; l0 integer; i integer; ml integer; ms integer; inner_der bytea;
BEGIN
  IF p_der IS NULL OR length(p_der) < 16 THEN RETURN NULL; END IF;
  IF get_byte(p_der,0) <> 48 THEN RETURN NULL; END IF;                 -- SEQUENCE
  SELECT len, content_start INTO l0, c0 FROM private.arca_der_len(p_der, 0);
  IF get_byte(p_der,c0) <> 2 THEN RETURN NULL; END IF;                 -- INTEGER version
  i := c0 + 2 + get_byte(p_der, c0+1);                                 -- saltar version

  -- PKCS#8: tras version viene AlgorithmIdentifier (SEQUENCE) y luego el
  -- OCTET STRING con el PKCS#1 embebido → desenvolver y recursar.
  IF get_byte(p_der, i) = 48 THEN
    DECLARE al integer; asx integer; ol integer; os2 integer;
    BEGIN
      SELECT len, content_start INTO al, asx FROM private.arca_der_len(p_der, i);
      i := asx + al;                                                   -- fin del AlgorithmIdentifier
      IF get_byte(p_der, i) <> 4 THEN RETURN NULL; END IF;             -- OCTET STRING
      SELECT len, content_start INTO ol, os2 FROM private.arca_der_len(p_der, i);
      inner_der := substring(p_der from os2+1 for ol);
      RETURN private.arca_rsa_modulus(inner_der);
    END;
  END IF;

  IF get_byte(p_der, i) <> 2 THEN RETURN NULL; END IF;                 -- INTEGER modulus
  SELECT len, content_start INTO ml, ms FROM private.arca_der_len(p_der, i);
  IF ml IS NULL OR ml < 64 THEN RETURN NULL; END IF;                   -- < 512 bits: inaceptable
  RETURN substring(p_der from ms+1 for ml);
END $$;
ALTER FUNCTION private.arca_rsa_modulus(bytea) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.arca_rsa_modulus(bytea) FROM PUBLIC, anon, authenticated, service_role;

-- Fingerprint canónico de la clave: SHA-256 del módulo RSA (hex).
CREATE OR REPLACE FUNCTION private.arca_key_fingerprint(p_pem text) RETURNS text
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE m bytea;
BEGIN
  m := private.arca_rsa_modulus(private.arca_pem_to_der(p_pem));
  IF m IS NULL THEN RETURN NULL; END IF;
  RETURN encode(extensions.digest(m, 'sha256'), 'hex');
END $$;
ALTER FUNCTION private.arca_key_fingerprint(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.arca_key_fingerprint(text) FROM PUBLIC, anon, authenticated, service_role;

-- ¿El certificado contiene el módulo de esta clave? (correspondencia criptográfica)
CREATE OR REPLACE FUNCTION private.arca_key_matches_certificate(p_key_pem text, p_cert_pem text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE m bytea; c bytea;
BEGIN
  m := private.arca_rsa_modulus(private.arca_pem_to_der(p_key_pem));
  c := private.arca_pem_to_der(p_cert_pem);
  IF m IS NULL OR c IS NULL OR length(c) = 0 THEN RETURN false; END IF;
  -- El SPKI del certificado contiene el mismo INTEGER modulus (misma codificación DER).
  RETURN position(m in c) > 0;
END $$;
ALTER FUNCTION private.arca_key_matches_certificate(text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.arca_key_matches_certificate(text,text) FROM PUBLIC, anon, authenticated, service_role;

-- ── 4. RPC de provisionamiento (public wrapper, service_role-only) ──────────
-- NO acepta PEM. NO devuelve PEM ni secret_id. Atómica, idempotente, fail-closed.
CREATE OR REPLACE FUNCTION public.arca_migrate_legacy_private_key_to_vault(
  p_business_id uuid, p_expected_fingerprint text, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_key_pem text; v_cert_pem text; v_fp text; v_cert_fp text; v_modulus bytea;
  v_req_hash text; v_prev record; v_existing record; v_readback text; v_readback_fp text;
  v_result jsonb; v_bits integer;
BEGIN
  -- Doble compuerta de rol
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'solo service_role' USING ERRCODE='42501';
  END IF;
  IF p_business_id IS NULL
     OR coalesce(btrim(p_expected_fingerprint),'') = ''
     OR coalesce(btrim(p_idempotency_key),'') = '' THEN
    RAISE EXCEPTION 'business_id, fingerprint esperado e idempotency_key son requeridos' USING ERRCODE='22023';
  END IF;

  -- Serializa por negocio: impide dos secretos por reintentos concurrentes.
  PERFORM pg_advisory_xact_lock(hashtext('arca_provision:' || p_business_id::text));

  v_req_hash := encode(extensions.digest(p_business_id::text || '|' || lower(btrim(p_expected_fingerprint)), 'sha256'), 'hex');

  -- ── Idempotencia ──
  SELECT * INTO v_prev FROM private.arca_credential_provision_requests r
    WHERE r.business_id = p_business_id AND r.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_prev.request_hash IS DISTINCT FROM v_req_hash THEN
      PERFORM private.arca_audit('arca_private_key_vault_migration_failed', p_business_id, NULL, NULL, NULL, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
      RETURN jsonb_build_object('ok', false, 'state', 'IDEMPOTENCY_CONFLICT');
    END IF;
    IF v_prev.state IN ('MIGRATED','ALREADY_MIGRATED') THEN
      PERFORM private.arca_audit('arca_private_key_vault_migration_replayed', p_business_id, NULL, NULL, left(lower(btrim(p_expected_fingerprint)),16), v_prev.state, NULL);
      RETURN coalesce(v_prev.result, jsonb_build_object('ok', true, 'state', v_prev.state));
    END IF;
    -- estado fallido previo: se permite reintentar (se actualiza más abajo)
  END IF;

  PERFORM private.arca_audit('arca_private_key_vault_migration_started', p_business_id, NULL, NULL, left(lower(btrim(p_expected_fingerprint)),16), 'started', NULL);

  -- ── Precondiciones fail-closed ──
  IF NOT EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = p_business_id) THEN
    RETURN private.arca_provision_record(p_business_id, p_idempotency_key, v_req_hash, 'LEGACY_KEY_MISSING');
  END IF;

  SELECT c.private_key, c.cert_file INTO v_key_pem, v_cert_pem
    FROM public.arca_config c WHERE c.business_id = p_business_id;
  IF NOT FOUND OR v_key_pem IS NULL OR btrim(v_key_pem) = '' THEN
    RETURN private.arca_provision_record(p_business_id, p_idempotency_key, v_req_hash, 'LEGACY_KEY_MISSING');
  END IF;

  -- Debe ser exactamente un bloque de clave privada (ni cert ni pública)
  IF v_key_pem ~ '-----BEGIN CERTIFICATE-----'
     OR v_key_pem ~ '-----BEGIN (RSA |EC )?PUBLIC KEY-----'
     OR (SELECT count(*) FROM regexp_matches(v_key_pem, '-----BEGIN (RSA |EC )?PRIVATE KEY-----', 'g')) <> 1 THEN
    RETURN private.arca_provision_record(p_business_id, p_idempotency_key, v_req_hash, 'LEGACY_KEY_INVALID');
  END IF;

  v_modulus := private.arca_rsa_modulus(private.arca_pem_to_der(v_key_pem));
  IF v_modulus IS NULL THEN
    RETURN private.arca_provision_record(p_business_id, p_idempotency_key, v_req_hash, 'LEGACY_KEY_INVALID');
  END IF;
  v_bits := (length(v_modulus) - 1) * 8;
  v_fp := encode(extensions.digest(v_modulus, 'sha256'), 'hex');

  -- Fingerprint esperado (fail-closed ante clave inesperada)
  IF lower(btrim(p_expected_fingerprint)) IS DISTINCT FROM v_fp THEN
    RETURN private.arca_provision_record(p_business_id, p_idempotency_key, v_req_hash, 'FINGERPRINT_MISMATCH');
  END IF;

  -- Correspondencia criptográfica clave ↔ certificado (igualdad de módulo)
  IF v_cert_pem IS NULL OR btrim(v_cert_pem) = ''
     OR NOT private.arca_key_matches_certificate(v_key_pem, v_cert_pem) THEN
    RETURN private.arca_provision_record(p_business_id, p_idempotency_key, v_req_hash, 'CERTIFICATE_KEY_MISMATCH');
  END IF;
  v_cert_fp := encode(extensions.digest(private.arca_pem_to_der(v_cert_pem), 'sha256'), 'hex');

  -- ── Credencial existente ──
  SELECT * INTO v_existing FROM private.arca_private_key_credentials k WHERE k.business_id = p_business_id;
  IF FOUND THEN
    IF v_existing.private_key_fingerprint = v_fp AND v_existing.credential_status = 'active' THEN
      RETURN private.arca_provision_record(p_business_id, p_idempotency_key, v_req_hash, 'ALREADY_MIGRATED');
    END IF;
    RETURN private.arca_provision_record(p_business_id, p_idempotency_key, v_req_hash, 'ACTIVE_CREDENTIAL_CONFLICT');
  END IF;

  -- ── Escritura en Vault + readback OBLIGATORIO, bajo un mismo savepoint ─────
  -- El PEM nunca sale de PostgreSQL. Si el readback falla o no coincide, el
  -- bloque EXCEPTION revierte el savepoint: se deshacen el secreto Vault Y el
  -- vínculo → sin secretos huérfanos ni credenciales rotas.
  DECLARE v_stored boolean := false;
  BEGIN
    PERFORM private.arca_store_private_key_secret(
      p_business_id, v_key_pem, v_fp, v_cert_fp, 'RSA', v_bits, NULL, true);
    v_stored := true;
    v_readback := private.arca_get_private_key_for_signing(p_business_id);
    v_readback_fp := private.arca_key_fingerprint(v_readback);
    IF v_readback_fp IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'readback_fingerprint_mismatch';
    END IF;
  EXCEPTION WHEN others THEN
    RETURN private.arca_provision_record(p_business_id, p_idempotency_key, v_req_hash,
      CASE WHEN v_stored THEN 'VAULT_READBACK_FAILED' ELSE 'VAULT_WRITE_FAILED' END);
  END;

  PERFORM private.arca_audit('arca_private_key_vault_migrated', p_business_id, NULL, NULL, left(v_fp,16), 'MIGRATED', NULL);
  RETURN private.arca_provision_record(p_business_id, p_idempotency_key, v_req_hash, 'MIGRATED');
END $$;
ALTER FUNCTION public.arca_migrate_legacy_private_key_to_vault(uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.arca_migrate_legacy_private_key_to_vault(uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arca_migrate_legacy_private_key_to_vault(uuid,text,text) TO service_role;
COMMENT ON FUNCTION public.arca_migrate_legacy_private_key_to_vault(uuid,text,text) IS
  'AFIP-S3A: copia la clave legacy de arca_config a Vault SIN que el PEM salga de PostgreSQL. '
  'service_role-only. No acepta ni devuelve PEM/secret_id. Idempotente y fail-closed. '
  'Provisioning requires an explicit S3B operator invocation.';

-- Registro sanitizado de la solicitud + auditoría de fallo (helper privado).
CREATE OR REPLACE FUNCTION private.arca_provision_record(
  p_business_id uuid, p_key text, p_hash text, p_state text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_ok boolean; v_res jsonb;
BEGIN
  v_ok := p_state IN ('MIGRATED','ALREADY_MIGRATED');
  v_res := jsonb_build_object('ok', v_ok, 'state', p_state);
  INSERT INTO private.arca_credential_provision_requests(business_id, idempotency_key, request_hash, state, result, completed_at)
  VALUES (p_business_id, p_key, p_hash, p_state, v_res, now())
  ON CONFLICT (business_id, idempotency_key) DO UPDATE
    SET state = EXCLUDED.state, result = EXCLUDED.result, completed_at = now();
  IF NOT v_ok THEN
    PERFORM private.arca_audit('arca_private_key_vault_migration_failed', p_business_id, NULL, NULL, NULL, p_state, p_state);
  END IF;
  RETURN v_res;
END $$;
ALTER FUNCTION private.arca_provision_record(uuid,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.arca_provision_record(uuid,text,text,text) FROM PUBLIC, anon, authenticated, service_role;

-- ── 5. Post-condiciones duras ───────────────────────────────────────────────
DO $$
DECLARE v_oid oid; v_bad text[] := '{}';
BEGIN
  v_oid := to_regprocedure('public.arca_migrate_legacy_private_key_to_vault(uuid,text,text)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'S3A: falta la RPC de provisión'; END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE')          THEN v_bad := v_bad || 'anon'; END IF;
  IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN v_bad := v_bad || 'authenticated'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid=v_oid AND a.grantee=0 AND a.privilege_type='EXECUTE') THEN
    v_bad := v_bad || 'PUBLIC'; END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN v_bad := v_bad || 'service_role_MISSING'; END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=v_oid) THEN v_bad := v_bad || 'no_secdef'; END IF;
  IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=v_oid) <> 'postgres' THEN v_bad := v_bad || 'owner'; END IF;
  -- La firma NO debe aceptar un PEM
  IF pg_get_function_arguments(v_oid) ~* '(pem|private_key|cert)' THEN v_bad := v_bad || 'firma_acepta_material'; END IF;
  -- Nadie provisionó nada al migrar
  IF (SELECT count(*) FROM private.arca_private_key_credentials) <> 0 THEN v_bad := v_bad || 'credenciales_creadas_en_migracion'; END IF;
  IF array_length(v_bad,1) IS NOT NULL THEN
    RAISE EXCEPTION 'S3A post-condición falló → %', array_to_string(v_bad, ', ');
  END IF;
  RAISE NOTICE 'AFIP-S3A: mecanismo de provisión listo y DORMIDO (service_role-only, sin PEM en la firma, sin secretos creados).';
END $$;
