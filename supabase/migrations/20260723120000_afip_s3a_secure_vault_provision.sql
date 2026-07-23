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
-- FINGERPRINT CANÓNICO (S3A.1): SHA-256 del SubjectPublicKeyInfo DER completo,
-- que incluye modulus Y publicExponent — el mismo DER que emite
-- `openssl rsa -pubout -outform DER`. Es un identificador estándar de la CLAVE
-- PÚBLICA, estable ante CRLF/LF/espacios y ante re-codificación PKCS#1 ↔ PKCS#8.
-- NO es un hash del módulo suelto ni del texto PEM.
--
-- CORRESPONDENCIA CLAVE↔CERTIFICADO (S3A.1): criptográfica y ESTRUCTURAL. Se
-- extraen (n,e) del RSAPrivateKey y (n,e) del SubjectPublicKeyInfo del
-- certificado navegando tags/longitudes DER (validando OID rsaEncryption y el
-- BIT STRING con unused bits = 0), y se comparan ambos valores. NO se busca el
-- módulo como subcadena del DER: un módulo colocado en una extensión NO produce
-- match. Es la misma igualdad (n,e) que verifica afip-wsaa (verifyCertKeyMatch).
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
-- FAIL-CLOSED: si el contenido no es base64 válido devuelve NULL en vez de lanzar.
CREATE OR REPLACE FUNCTION private.arca_pem_to_der(p_pem text) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE b text;
BEGIN
  b := regexp_replace(regexp_replace(coalesce(p_pem,''), '-----(BEGIN|END)[^-]*-----', '', 'g'), '\s', '', 'g');
  IF b = '' THEN RETURN NULL; END IF;
  BEGIN
    RETURN decode(b, 'base64');
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
END $$;
ALTER FUNCTION private.arca_pem_to_der(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.arca_pem_to_der(text) FROM PUBLIC, anon, authenticated, service_role;

-- Offset del elemento SIGUIENTE (salta tag+longitud+contenido).
CREATE OR REPLACE FUNCTION private.arca_der_next(p bytea, i integer) RETURNS integer
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE l integer; c integer;
BEGIN
  SELECT len, content_start INTO l, c FROM private.arca_der_len(p, i);
  RETURN c + l;
END $$;
ALTER FUNCTION private.arca_der_next(bytea,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.arca_der_next(bytea,integer) FROM PUBLIC, anon, authenticated, service_role;

-- Entero sin signo canónico: quita los 0x00 de relleno a la izquierda.
CREATE OR REPLACE FUNCTION private.arca_uint_canon(v bytea) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE i integer := 0;
BEGIN
  IF v IS NULL OR length(v) = 0 THEN RETURN NULL; END IF;
  WHILE i < length(v) - 1 AND get_byte(v, i) = 0 LOOP i := i + 1; END LOOP;
  RETURN substring(v from i+1 for length(v)-i);
END $$;
ALTER FUNCTION private.arca_uint_canon(bytea) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.arca_uint_canon(bytea) FROM PUBLIC, anon, authenticated, service_role;

-- Codificación DER de una longitud (corta / larga 1-2 bytes).
CREATE OR REPLACE FUNCTION private.arca_der_enc_len(n integer) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF n < 0 THEN RAISE EXCEPTION 'longitud negativa'; END IF;
  IF n < 128 THEN RETURN decode(lpad(to_hex(n),2,'0'),'hex'); END IF;
  IF n < 256 THEN RETURN '\x81'::bytea || decode(lpad(to_hex(n),2,'0'),'hex'); END IF;
  IF n < 65536 THEN
    RETURN '\x82'::bytea || decode(lpad(to_hex(n/256),2,'0'),'hex') || decode(lpad(to_hex(n%256),2,'0'),'hex');
  END IF;
  RAISE EXCEPTION 'longitud DER no soportada';
END $$;
ALTER FUNCTION private.arca_der_enc_len(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.arca_der_enc_len(integer) FROM PUBLIC, anon, authenticated, service_role;

-- INTEGER DER a partir de un unsigned canónico (agrega 0x00 si el bit alto está en 1).
CREATE OR REPLACE FUNCTION private.arca_der_enc_int(v bytea) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE b bytea;
BEGIN
  b := private.arca_uint_canon(v);
  IF get_byte(b,0) >= 128 THEN b := '\x00'::bytea || b; END IF;
  RETURN '\x02'::bytea || private.arca_der_enc_len(length(b)) || b;
END $$;
ALTER FUNCTION private.arca_der_enc_int(bytea) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.arca_der_enc_int(bytea) FROM PUBLIC, anon, authenticated, service_role;

-- ── Identidad canónica de la clave pública RSA ──────────────────────────────
-- SubjectPublicKeyInfo DER a partir de (n, e):
--   SEQUENCE { SEQUENCE { OID rsaEncryption, NULL }, BIT STRING { SEQUENCE { INTEGER n, INTEGER e } } }
-- Es el MISMO DER que produce `openssl rsa -pubout -outform DER`, así que el
-- fingerprint identifica la CLAVE PÚBLICA (modulus Y exponent) de forma estándar.
CREATE OR REPLACE FUNCTION private.arca_rsa_spki_der(p_n bytea, p_e bytea) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_rsa bytea; v_bits bytea; v_alg bytea; v_body bytea;
BEGIN
  IF p_n IS NULL OR p_e IS NULL THEN RETURN NULL; END IF;
  v_rsa := private.arca_der_enc_int(p_n) || private.arca_der_enc_int(p_e);
  v_rsa := '\x30'::bytea || private.arca_der_enc_len(length(v_rsa)) || v_rsa;
  v_bits := '\x00'::bytea || v_rsa;                                   -- unused bits = 0
  v_bits := '\x03'::bytea || private.arca_der_enc_len(length(v_bits)) || v_bits;
  v_alg := '\x300d06092a864886f70d0101010500'::bytea;                 -- rsaEncryption + NULL
  v_body := v_alg || v_bits;
  RETURN '\x30'::bytea || private.arca_der_enc_len(length(v_body)) || v_body;
END $$;
ALTER FUNCTION private.arca_rsa_spki_der(bytea,bytea) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.arca_rsa_spki_der(bytea,bytea) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.arca_rsa_public_key_fingerprint_sha256(p_n bytea, p_e bytea) RETURNS text
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE d bytea;
BEGIN
  d := private.arca_rsa_spki_der(p_n, p_e);
  IF d IS NULL THEN RETURN NULL; END IF;
  RETURN encode(extensions.digest(d, 'sha256'), 'hex');
END $$;
ALTER FUNCTION private.arca_rsa_public_key_fingerprint_sha256(bytea,bytea) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.arca_rsa_public_key_fingerprint_sha256(bytea,bytea) FROM PUBLIC, anon, authenticated, service_role;

-- ── Extracción ESTRUCTURADA de (n,e) desde la clave privada ─────────────────
CREATE OR REPLACE FUNCTION private.arca_rsa_pubkey_from_private(
  p_der bytea, OUT n bytea, OUT e bytea)
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE l0 integer; c0 integer; i integer; ln integer; cn integer; le integer; ce integer;
        al integer; ac integer; ol integer; oc integer;
BEGIN
  n := NULL; e := NULL;
  IF p_der IS NULL OR length(p_der) < 32 THEN RETURN; END IF;
  IF get_byte(p_der,0) <> 48 THEN RETURN; END IF;
  SELECT len, content_start INTO l0, c0 FROM private.arca_der_len(p_der, 0);
  IF c0 + l0 <> length(p_der) THEN RETURN; END IF;                     -- datos sobrantes
  IF get_byte(p_der,c0) <> 2 THEN RETURN; END IF;                      -- INTEGER version
  i := private.arca_der_next(p_der, c0);

  -- PKCS#8: version, AlgorithmIdentifier(SEQUENCE), OCTET STRING{PKCS#1}
  IF get_byte(p_der, i) = 48 THEN
    SELECT len, content_start INTO al, ac FROM private.arca_der_len(p_der, i);
    IF substring(p_der from ac+1 for 11) <> '\x06092a864886f70d010101'::bytea THEN RETURN; END IF;
    i := ac + al;
    IF get_byte(p_der, i) <> 4 THEN RETURN; END IF;
    SELECT len, content_start INTO ol, oc FROM private.arca_der_len(p_der, i);
    SELECT (r).n, (r).e INTO n, e FROM (SELECT private.arca_rsa_pubkey_from_private(substring(p_der from oc+1 for ol)) AS r) s;
    RETURN;
  END IF;

  -- PKCS#1: version, modulus, publicExponent, ...
  IF get_byte(p_der, i) <> 2 THEN RETURN; END IF;
  SELECT len, content_start INTO ln, cn FROM private.arca_der_len(p_der, i);
  IF get_byte(p_der, cn) >= 128 THEN RETURN; END IF;                   -- INTEGER negativo
  i := cn + ln;
  IF get_byte(p_der, i) <> 2 THEN RETURN; END IF;
  SELECT len, content_start INTO le, ce FROM private.arca_der_len(p_der, i);
  IF get_byte(p_der, ce) >= 128 THEN RETURN; END IF;

  n := private.arca_uint_canon(substring(p_der from cn+1 for ln));
  e := private.arca_uint_canon(substring(p_der from ce+1 for le));
  IF length(n) < 128 THEN n := NULL; e := NULL; RETURN; END IF;        -- < 1024 bits
  IF length(e) = 0 OR (get_byte(e, length(e)-1) % 2) = 0 THEN n := NULL; e := NULL; RETURN; END IF;
  IF length(e) = 1 AND get_byte(e,0) <= 1 THEN n := NULL; e := NULL; RETURN; END IF;
END $$;
ALTER FUNCTION private.arca_rsa_pubkey_from_private(bytea) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.arca_rsa_pubkey_from_private(bytea) FROM PUBLIC, anon, authenticated, service_role;

-- ── Extracción ESTRUCTURADA de (n,e) desde el SubjectPublicKeyInfo del cert ──
-- Certificate → tbsCertificate → [0] version? → serial → sigAlg → issuer →
-- validity → subject → SPKI → alg(OID rsaEncryption) → BIT STRING(unused=0) →
-- RSAPublicKey → (modulus, publicExponent). Navega tags/longitudes; NO busca bytes.
CREATE OR REPLACE FUNCTION private.arca_rsa_pubkey_from_cert(
  p_der bytea, OUT n bytea, OUT e bytea)
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE l0 integer; c0 integer; lt integer; ct integer; i integer;
        ls integer; cs integer; la integer; ca integer; lb integer; cb integer;
        lr integer; cr integer; ln integer; cn integer; le integer; ce integer;
BEGIN
  n := NULL; e := NULL;
  IF p_der IS NULL OR length(p_der) < 64 THEN RETURN; END IF;
  IF get_byte(p_der,0) <> 48 THEN RETURN; END IF;                      -- Certificate
  SELECT len, content_start INTO l0, c0 FROM private.arca_der_len(p_der, 0);
  IF c0 + l0 <> length(p_der) THEN RETURN; END IF;                     -- truncado/sobrante
  IF get_byte(p_der,c0) <> 48 THEN RETURN; END IF;                     -- tbsCertificate
  SELECT len, content_start INTO lt, ct FROM private.arca_der_len(p_der, c0);
  IF ct + lt > length(p_der) THEN RETURN; END IF;

  i := ct;
  IF get_byte(p_der, i) = 160 THEN i := private.arca_der_next(p_der, i); END IF;  -- [0] version
  i := private.arca_der_next(p_der, i);   -- serialNumber
  i := private.arca_der_next(p_der, i);   -- signature
  i := private.arca_der_next(p_der, i);   -- issuer
  i := private.arca_der_next(p_der, i);   -- validity
  i := private.arca_der_next(p_der, i);   -- subject
  IF i >= ct + lt THEN RETURN; END IF;
  IF get_byte(p_der, i) <> 48 THEN RETURN; END IF;                     -- SubjectPublicKeyInfo
  SELECT len, content_start INTO ls, cs FROM private.arca_der_len(p_der, i);
  IF cs + ls > ct + lt THEN RETURN; END IF;

  IF get_byte(p_der, cs) <> 48 THEN RETURN; END IF;                    -- AlgorithmIdentifier
  SELECT len, content_start INTO la, ca FROM private.arca_der_len(p_der, cs);
  IF substring(p_der from ca+1 for 11) <> '\x06092a864886f70d010101'::bytea THEN RETURN; END IF;

  i := ca + la;
  IF get_byte(p_der, i) <> 3 THEN RETURN; END IF;                      -- BIT STRING
  SELECT len, content_start INTO lb, cb FROM private.arca_der_len(p_der, i);
  IF lb < 2 OR get_byte(p_der, cb) <> 0 THEN RETURN; END IF;           -- unused bits != 0

  i := cb + 1;
  IF get_byte(p_der, i) <> 48 THEN RETURN; END IF;                     -- RSAPublicKey
  SELECT len, content_start INTO lr, cr FROM private.arca_der_len(p_der, i);
  IF cr + lr > cb + lb THEN RETURN; END IF;
  IF get_byte(p_der, cr) <> 2 THEN RETURN; END IF;
  SELECT len, content_start INTO ln, cn FROM private.arca_der_len(p_der, cr);
  IF get_byte(p_der, cn) >= 128 THEN RETURN; END IF;
  i := cn + ln;
  IF get_byte(p_der, i) <> 2 THEN RETURN; END IF;
  SELECT len, content_start INTO le, ce FROM private.arca_der_len(p_der, i);
  IF get_byte(p_der, ce) >= 128 THEN RETURN; END IF;

  n := private.arca_uint_canon(substring(p_der from cn+1 for ln));
  e := private.arca_uint_canon(substring(p_der from ce+1 for le));
  IF length(n) < 128 THEN n := NULL; e := NULL; END IF;
END $$;
ALTER FUNCTION private.arca_rsa_pubkey_from_cert(bytea) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.arca_rsa_pubkey_from_cert(bytea) FROM PUBLIC, anon, authenticated, service_role;

-- Fingerprint canónico de la clave privada (identidad de su clave pública).
CREATE OR REPLACE FUNCTION private.arca_key_fingerprint(p_pem text) RETURNS text
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE k record;
BEGIN
  SELECT * INTO k FROM private.arca_rsa_pubkey_from_private(private.arca_pem_to_der(p_pem));
  IF k.n IS NULL OR k.e IS NULL THEN RETURN NULL; END IF;
  RETURN private.arca_rsa_public_key_fingerprint_sha256(k.n, k.e);
END $$;
ALTER FUNCTION private.arca_key_fingerprint(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.arca_key_fingerprint(text) FROM PUBLIC, anon, authenticated, service_role;

-- Correspondencia clave↔certificado: compara (n,e) extraídos ESTRUCTURALMENTE
-- del RSAPrivateKey y del SubjectPublicKeyInfo. Un módulo que aparezca en otra
-- parte del certificado (p.ej. una extensión) NO produce match.
CREATE OR REPLACE FUNCTION private.arca_key_matches_certificate(p_key_pem text, p_cert_pem text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE k record; c record;
BEGIN
  SELECT * INTO k FROM private.arca_rsa_pubkey_from_private(private.arca_pem_to_der(p_key_pem));
  SELECT * INTO c FROM private.arca_rsa_pubkey_from_cert(private.arca_pem_to_der(p_cert_pem));
  IF k.n IS NULL OR k.e IS NULL OR c.n IS NULL OR c.e IS NULL THEN RETURN false; END IF;
  RETURN k.n = c.n AND k.e = c.e;
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
  v_key_pem text; v_cert_pem text; v_fp text; v_cert_fp text; v_pub record;
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

  -- Extracción ESTRUCTURADA de (n,e) + fingerprint canónico de la clave pública
  -- (SPKI DER completo: incluye modulus Y publicExponent).
  SELECT * INTO v_pub FROM private.arca_rsa_pubkey_from_private(private.arca_pem_to_der(v_key_pem));
  IF v_pub.n IS NULL OR v_pub.e IS NULL THEN
    RETURN private.arca_provision_record(p_business_id, p_idempotency_key, v_req_hash, 'LEGACY_KEY_INVALID');
  END IF;
  v_bits := length(v_pub.n) * 8;
  v_fp := private.arca_rsa_public_key_fingerprint_sha256(v_pub.n, v_pub.e);

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
