-- ============================================================================
-- AFIP-S4A — Preparar rotación segura de clave y CSR (mecanismo DORMIDO)
--
-- Construye el contrato server-side para preparar una rotación de certificado:
--   1) una NUEVA clave RSA se genera en el Edge (Postgres no genera RSA);
--   2) se almacena DIRECTAMENTE en Vault como secreto de rotación;
--   3) queda vinculada como credencial `pending_rotation` en una tabla dedicada;
--   4) se valida server-side que fp(clave en Vault) == fp(SPKI del CSR);
--   5) la credencial `active` vigente y arca_config NO se tocan.
--
-- La clave privada nunca se devuelve, ni se audita, ni se escribe en arca_config.
-- El CSR (público) sí puede devolverse/descargarse.
--
-- Coexistencia: credencial actual `active` (tabla arca_private_key_credentials,
-- intacta) + nueva `pending_rotation` (tabla arca_credential_rotations, nueva).
-- La activación atómica y el import del certificado nuevo pertenecen a S4B.
--
-- NADA en esta migración cambia active/cert_file/token/sign/private_key legacy,
-- ni invoca WSAA. Es aditiva y dormida hasta que S4B la use.
-- ============================================================================

-- ── 1. Allowlist de auditoría: +4 eventos de rotación (sin material sensible) ──
ALTER TABLE private.arca_credential_audit DROP CONSTRAINT IF EXISTS arca_credential_audit_event_check;
ALTER TABLE private.arca_credential_audit ADD CONSTRAINT arca_credential_audit_event_check CHECK (event IN (
  'credential_validation_success','credential_validation_failure',
  'credential_store_success','credential_store_failure','credential_replaced','credential_deleted',
  'arca_config_legacy_saved','arca_certificate_legacy_saved','arca_estado_updated',
  'wsaa_private_key_resolved_vault','wsaa_private_key_resolved_legacy','wsaa_private_key_resolution_failed',
  'arca_private_key_vault_migration_started','arca_private_key_vault_migrated',
  'arca_private_key_vault_migration_failed','arca_private_key_vault_migration_replayed',
  -- AFIP-S4A
  'arca_certificate_rotation_prepared','arca_certificate_rotation_prepare_failed',
  'arca_certificate_rotation_replayed','arca_certificate_rotation_cancelled'));

-- ── 2. Tabla de rotaciones pendientes (aislada de la credencial `active`) ─────
CREATE TABLE IF NOT EXISTS private.arca_credential_rotations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id              uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  private_key_secret_id    uuid NOT NULL,                 -- secreto Vault de la clave NUEVA
  private_key_fingerprint  text NOT NULL,                 -- SPKI SHA-256 (n+e) de la clave nueva
  csr_fingerprint          text NOT NULL,                 -- SPKI SHA-256 del CSR (== private_key_fingerprint)
  csr_pem                  text NOT NULL,                 -- CSR público (para subir a AFIP en S4B)
  key_algorithm            text NOT NULL DEFAULT 'RSA',
  key_size                 integer NOT NULL,
  public_exponent          bigint,
  subject                  jsonb NOT NULL DEFAULT '{}'::jsonb,  -- subject público del CSR
  state                    text NOT NULL DEFAULT 'pending_rotation'
                             CHECK (state IN ('pending_rotation','activated','cancelled','failed')),
  idempotency_key          text NOT NULL,
  request_hash             text NOT NULL,
  created_by               uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  activated_at             timestamptz,
  cancelled_at             timestamptz,
  CONSTRAINT arca_credential_rotations_idem_uq UNIQUE (business_id, idempotency_key)
);
ALTER TABLE private.arca_credential_rotations ENABLE ROW LEVEL SECURITY;
-- Sin policies: el schema `private` no está expuesto por PostgREST; solo se accede
-- vía funciones SECURITY DEFINER. RLS activo = fail-closed ante cualquier acceso directo.

-- A lo sumo UNA rotación pendiente por negocio (índice único parcial).
CREATE UNIQUE INDEX IF NOT EXISTS arca_credential_rotations_one_pending
  ON private.arca_credential_rotations (business_id) WHERE state = 'pending_rotation';
CREATE INDEX IF NOT EXISTS arca_credential_rotations_biz_idx
  ON private.arca_credential_rotations (business_id);

-- ── 3. Parser estructural del CSR (PKCS#10): extrae (n,e) del SubjectPublicKeyInfo
-- CertificationRequest ::= SEQ { CertificationRequestInfo SEQ { version INT,
--   subject SEQ, subjectPKInfo SEQ(SPKI), [0] attrs }, sigAlg SEQ, sig BIT STRING }
-- Reutiliza los mismos helpers DER que el parser de certificado (S3A). Fail-closed:
-- cualquier desvío estructural → (NULL, NULL).
CREATE OR REPLACE FUNCTION private.arca_rsa_pubkey_from_csr(p_der bytea, OUT n bytea, OUT e bytea)
RETURNS record LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $function$
DECLARE l0 integer; c0 integer; li integer; ci integer; i integer;
        ls integer; cs integer; la integer; ca integer; lb integer; cb integer;
        lr integer; cr integer; ln integer; cn integer; le integer; ce integer;
BEGIN
  n := NULL; e := NULL;
  IF p_der IS NULL OR length(p_der) < 64 THEN RETURN; END IF;
  IF get_byte(p_der,0) <> 48 THEN RETURN; END IF;                       -- CertificationRequest
  SELECT len, content_start INTO l0, c0 FROM private.arca_der_len(p_der, 0);
  IF c0 + l0 <> length(p_der) THEN RETURN; END IF;                      -- truncado/sobrante
  IF get_byte(p_der,c0) <> 48 THEN RETURN; END IF;                      -- CertificationRequestInfo
  SELECT len, content_start INTO li, ci FROM private.arca_der_len(p_der, c0);
  IF ci + li > length(p_der) THEN RETURN; END IF;

  i := ci;
  IF get_byte(p_der, i) <> 2 THEN RETURN; END IF;                       -- version INTEGER
  i := private.arca_der_next(p_der, i);
  IF get_byte(p_der, i) <> 48 THEN RETURN; END IF;                      -- subject Name (SEQUENCE)
  i := private.arca_der_next(p_der, i);
  IF i >= ci + li THEN RETURN; END IF;
  IF get_byte(p_der, i) <> 48 THEN RETURN; END IF;                      -- SubjectPublicKeyInfo
  SELECT len, content_start INTO ls, cs FROM private.arca_der_len(p_der, i);
  IF cs + ls > ci + li THEN RETURN; END IF;

  IF get_byte(p_der, cs) <> 48 THEN RETURN; END IF;                     -- AlgorithmIdentifier
  SELECT len, content_start INTO la, ca FROM private.arca_der_len(p_der, cs);
  IF substring(p_der from ca+1 for 11) <> '\x06092a864886f70d010101'::bytea THEN RETURN; END IF;  -- rsaEncryption

  i := ca + la;
  IF get_byte(p_der, i) <> 3 THEN RETURN; END IF;                       -- BIT STRING
  SELECT len, content_start INTO lb, cb FROM private.arca_der_len(p_der, i);
  IF lb < 2 OR get_byte(p_der, cb) <> 0 THEN RETURN; END IF;            -- unused bits != 0

  i := cb + 1;
  IF get_byte(p_der, i) <> 48 THEN RETURN; END IF;                      -- RSAPublicKey
  SELECT len, content_start INTO lr, cr FROM private.arca_der_len(p_der, i);
  IF cr + lr > cb + lb THEN RETURN; END IF;
  IF get_byte(p_der, cr) <> 2 THEN RETURN; END IF;                      -- modulus INTEGER
  SELECT len, content_start INTO ln, cn FROM private.arca_der_len(p_der, cr);
  IF get_byte(p_der, cn) >= 128 THEN RETURN; END IF;                    -- positivo
  i := cn + ln;
  IF get_byte(p_der, i) <> 2 THEN RETURN; END IF;                       -- exponent INTEGER
  SELECT len, content_start INTO le, ce FROM private.arca_der_len(p_der, i);
  IF get_byte(p_der, ce) >= 128 THEN RETURN; END IF;

  n := private.arca_uint_canon(substring(p_der from cn+1 for ln));
  e := private.arca_uint_canon(substring(p_der from ce+1 for le));
  IF length(n) < 128 THEN n := NULL; e := NULL; END IF;                 -- >= 1024 bits
END $function$;

-- Fingerprint SPKI canónico de la clave pública contenida en un CSR PEM.
CREATE OR REPLACE FUNCTION private.arca_csr_public_key_fingerprint(p_csr_pem text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $function$
DECLARE v record;
BEGIN
  SELECT * INTO v FROM private.arca_rsa_pubkey_from_csr(private.arca_pem_to_der(p_csr_pem));
  IF v.n IS NULL OR v.e IS NULL THEN RETURN NULL; END IF;
  RETURN private.arca_rsa_public_key_fingerprint_sha256(v.n, v.e);
END $function$;

-- ── S4A.1: extracción ESTRUCTURADA del subject del CSR (Name PKCS#10) ─────────
-- Navega CSR→CRI→subject (SEQUENCE OF RDN(SET) OF AttributeTypeAndValue{OID,value})
-- y mapea los OID X.500 admitidos a un jsonb canónico (claves minúsculas, valores
-- trim). Fail-closed: ante desvío estructural devuelve lo acumulado (o '{}').
-- Es la fuente AUTORITATIVA del subject: no se confía en lo que declara el Edge.
CREATE OR REPLACE FUNCTION private.arca_csr_subject(p_der bytea)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $function$
DECLARE l0 int; c0 int; li int; ci int; i int; ls int; cs int;
        lset int; cset int; latv int; catv int; loid int; coid int;
        lval int; cval int; oid bytea; val text; fld text; subj jsonb := '{}'::jsonb;
BEGIN
  IF p_der IS NULL OR length(p_der) < 32 THEN RETURN subj; END IF;
  IF get_byte(p_der,0) <> 48 THEN RETURN subj; END IF;
  SELECT len, content_start INTO l0, c0 FROM private.arca_der_len(p_der, 0);
  IF get_byte(p_der,c0) <> 48 THEN RETURN subj; END IF;                 -- CertificationRequestInfo
  SELECT len, content_start INTO li, ci FROM private.arca_der_len(p_der, c0);
  i := ci;
  IF get_byte(p_der,i) <> 2 THEN RETURN subj; END IF;                   -- version
  i := private.arca_der_next(p_der, i);
  IF get_byte(p_der,i) <> 48 THEN RETURN subj; END IF;                  -- subject SEQUENCE
  SELECT len, content_start INTO ls, cs FROM private.arca_der_len(p_der, i);
  IF cs + ls > ci + li THEN RETURN subj; END IF;
  i := cs;
  WHILE i < cs + ls LOOP
    IF get_byte(p_der,i) <> 49 THEN EXIT; END IF;                       -- RelativeDistinguishedName (SET)
    SELECT len, content_start INTO lset, cset FROM private.arca_der_len(p_der, i);
    catv := cset;
    WHILE catv < cset + lset LOOP
      IF get_byte(p_der,catv) <> 48 THEN EXIT; END IF;                  -- AttributeTypeAndValue (SEQ)
      SELECT len, content_start INTO latv, coid FROM private.arca_der_len(p_der, catv);
      IF get_byte(p_der,coid) <> 6 THEN catv := private.arca_der_next(p_der, catv); CONTINUE; END IF;  -- OID
      SELECT len, content_start INTO loid, cval FROM private.arca_der_len(p_der, coid);  -- reuse loid/cval for OID
      oid := substring(p_der from cval+1 for loid);
      -- valor: TLV inmediatamente después del OID
      SELECT len, content_start INTO lval, cval FROM private.arca_der_len(p_der, cval + loid);
      BEGIN val := convert_from(substring(p_der from cval+1 for lval), 'UTF8');
      EXCEPTION WHEN others THEN val := NULL; END;
      fld := CASE oid
        WHEN '\x550403'::bytea THEN 'cn'   WHEN '\x550405'::bytea THEN 'serialnumber'
        WHEN '\x55040a'::bytea THEN 'o'    WHEN '\x55040b'::bytea THEN 'ou'
        WHEN '\x550406'::bytea THEN 'c'    WHEN '\x550408'::bytea THEN 'st'
        WHEN '\x550407'::bytea THEN 'l'    WHEN '\x2a864886f70d010901'::bytea THEN 'email'
        ELSE NULL END;
      IF fld IS NOT NULL AND val IS NOT NULL THEN
        subj := subj || jsonb_build_object(fld, btrim(val));
      END IF;
      catv := private.arca_der_next(p_der, catv);
    END LOOP;
    i := private.arca_der_next(p_der, i);
  END LOOP;
  RETURN subj;
END $function$;

-- Representación canónica e inequívoca de un subject (para el request_hash y la
-- comparación declarado↔CSR): claves minúsculas, valores trim, orden fijo por clave.
CREATE OR REPLACE FUNCTION private.arca_canonical_subject(p_subject jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $function$
  SELECT coalesce(string_agg(lower(key) || '=' || btrim(value), '|' ORDER BY lower(key)), '')
  FROM jsonb_each_text(coalesce(p_subject, '{}'::jsonb));
$function$;

-- ── 4. Helper de retorno sanitizado + registro de estado ──────────────────────
CREATE OR REPLACE FUNCTION private.arca_rotation_record(
  p_business_id uuid, p_idempotency_key text, p_request_hash text, p_state text,
  p_result jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE v_ok boolean := p_state IN ('ROTATION_PREPARED','ROTATION_ALREADY_PREPARED','ROTATION_CANCELLED');
BEGIN
  RETURN coalesce(p_result, jsonb_build_object('ok', v_ok, 'state', p_state));
END $function$;

-- ── 5. RPC principal: preparar rotación (service_role-only, dormida) ───────────
-- Recibe la clave NUEVA + el CSR generados por el Edge. Nunca los devuelve/audita
-- en claro; la clave va SOLO a Vault. Valida fp(clave)==fp(SPKI del CSR).
CREATE OR REPLACE FUNCTION public.arca_prepare_certificate_rotation(
  p_business_id uuid, p_key_pem text, p_csr_pem text, p_fingerprint text,
  p_algorithm text, p_key_size integer, p_public_exponent bigint,
  p_subject jsonb, p_idempotency_key text, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_key_pub record; v_csr_pub record; v_fp text; v_csr_fp text; v_bits integer;
  v_exp bigint; v_csr_bits integer; v_csr_subj jsonb; v_canon text; v_req_hash text;
  v_prev record; v_secret_id uuid; v_readback text; v_readback_fp text; v_rot_id uuid;
BEGIN
  -- Compuerta de rol (igual que S3A): solo service_role puede invocar.
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'solo service_role' USING ERRCODE='42501';
  END IF;
  IF p_business_id IS NULL OR coalesce(btrim(p_idempotency_key),'')=''
     OR coalesce(btrim(p_fingerprint),'')='' OR coalesce(btrim(p_key_pem),'')=''
     OR coalesce(btrim(p_csr_pem),'')='' THEN
    RAISE EXCEPTION 'parámetros requeridos faltantes' USING ERRCODE='22023';
  END IF;

  -- Pertenencia al negocio (defensa en profundidad; el Edge ya validó al owner).
  IF p_actor IS NULL OR NOT public.is_business_owner_or_admin(p_business_id, p_actor) THEN
    PERFORM private.arca_audit('arca_certificate_rotation_prepare_failed', p_business_id, p_actor, NULL, NULL, 'UNAUTHORIZED', 'UNAUTHORIZED');
    RETURN jsonb_build_object('ok', false, 'state', 'UNAUTHORIZED');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('arca_rotation:' || p_business_id::text));

  -- ── La clave debe ser exactamente UN bloque de clave privada (ni cert ni pública).
  IF p_key_pem ~ '-----BEGIN CERTIFICATE-----'
     OR p_key_pem ~ '-----BEGIN (RSA |EC )?PUBLIC KEY-----'
     OR (SELECT count(*) FROM regexp_matches(p_key_pem, '-----BEGIN (RSA |EC )?PRIVATE KEY-----', 'g')) <> 1 THEN
    PERFORM private.arca_audit('arca_certificate_rotation_prepare_failed', p_business_id, p_actor, NULL, NULL, 'KEY_GENERATION_FAILED', 'KEY_GENERATION_FAILED');
    RETURN jsonb_build_object('ok', false, 'state', 'KEY_GENERATION_FAILED');
  END IF;

  -- (n,e) estructural de la clave + fingerprint canónico; debe coincidir con lo declarado.
  SELECT * INTO v_key_pub FROM private.arca_rsa_pubkey_from_private(private.arca_pem_to_der(p_key_pem));
  IF v_key_pub.n IS NULL OR v_key_pub.e IS NULL THEN
    PERFORM private.arca_audit('arca_certificate_rotation_prepare_failed', p_business_id, p_actor, NULL, NULL, 'KEY_GENERATION_FAILED', 'KEY_GENERATION_FAILED');
    RETURN jsonb_build_object('ok', false, 'state', 'KEY_GENERATION_FAILED');
  END IF;
  v_bits := length(v_key_pub.n) * 8;
  v_exp  := ('x'||lpad(encode(v_key_pub.e,'hex'),16,'0'))::bit(64)::bigint;
  v_fp   := private.arca_rsa_public_key_fingerprint_sha256(v_key_pub.n, v_key_pub.e);
  IF lower(btrim(p_fingerprint)) IS DISTINCT FROM v_fp THEN
    PERFORM private.arca_audit('arca_certificate_rotation_prepare_failed', p_business_id, p_actor, NULL, NULL, 'KEY_GENERATION_FAILED', 'KEY_GENERATION_FAILED');
    RETURN jsonb_build_object('ok', false, 'state', 'KEY_GENERATION_FAILED');
  END IF;

  -- ── CSR AUTORITATIVO: (n,e) + fingerprint + subject extraídos por la DB. No se
  --    confía en los valores calculados por el Edge. (Sección 2)
  SELECT * INTO v_csr_pub FROM private.arca_rsa_pubkey_from_csr(private.arca_pem_to_der(p_csr_pem));
  IF v_csr_pub.n IS NULL OR v_csr_pub.e IS NULL THEN
    PERFORM private.arca_audit('arca_certificate_rotation_prepare_failed', p_business_id, p_actor, NULL, NULL, 'CSR_GENERATION_FAILED', 'CSR_GENERATION_FAILED');
    RETURN jsonb_build_object('ok', false, 'state', 'CSR_GENERATION_FAILED');
  END IF;
  v_csr_fp   := private.arca_rsa_public_key_fingerprint_sha256(v_csr_pub.n, v_csr_pub.e);
  v_csr_bits := length(v_csr_pub.n) * 8;
  v_csr_subj := private.arca_csr_subject(private.arca_pem_to_der(p_csr_pem));

  -- fp(SPKI del CSR) == fp(clave). (Sección 4)
  IF v_csr_fp IS DISTINCT FROM v_fp THEN
    PERFORM private.arca_audit('arca_certificate_rotation_prepare_failed', p_business_id, p_actor, NULL, NULL, 'CSR_KEY_MISMATCH', 'CSR_KEY_MISMATCH');
    RETURN jsonb_build_object('ok', false, 'state', 'CSR_KEY_MISMATCH');
  END IF;

  -- El CSR debe contener EXACTAMENTE los parámetros y el subject DECLARADOS. Si el
  -- Edge declara algo distinto de lo que realmente lleva el CSR → CSR_KEY_MISMATCH.
  IF (p_key_size IS NOT NULL AND p_key_size <> v_csr_bits)
     OR (p_public_exponent IS NOT NULL AND p_public_exponent <> v_exp)
     OR v_csr_bits <> v_bits
     OR private.arca_canonical_subject(v_csr_subj) IS DISTINCT FROM private.arca_canonical_subject(p_subject) THEN
    PERFORM private.arca_audit('arca_certificate_rotation_prepare_failed', p_business_id, p_actor, NULL, NULL, 'CSR_KEY_MISMATCH', 'CSR_KEY_MISMATCH');
    RETURN jsonb_build_object('ok', false, 'state', 'CSR_KEY_MISMATCH');
  END IF;

  -- ── request_hash SEMÁNTICO: SOLO la intención del pedido (operación, negocio,
  --    subject canónico del CSR, algoritmo, tamaño, exponente). NO incluye la
  --    clave, el fingerprint, el CSR crudo, el secret_id, el rotation id ni fechas.
  --    Así un retry que regenera OTRA clave con el mismo pedido produce el MISMO
  --    hash → replay correcto. (Sección 1)
  v_canon := 'arca_prepare_certificate_rotation|' || p_business_id::text || '|'
             || private.arca_canonical_subject(v_csr_subj) || '|RSA|'
             || v_csr_bits::text || '|' || v_exp::text;
  v_req_hash := encode(extensions.digest(v_canon, 'sha256'), 'hex');

  -- ── Idempotencia (end-to-end: mismo pedido semántico → misma rotación) ──
  SELECT * INTO v_prev FROM private.arca_credential_rotations r
    WHERE r.business_id = p_business_id AND r.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_prev.request_hash IS DISTINCT FROM v_req_hash THEN
      PERFORM private.arca_audit('arca_certificate_rotation_prepare_failed', p_business_id, p_actor, NULL, NULL, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
      RETURN jsonb_build_object('ok', false, 'state', 'IDEMPOTENCY_CONFLICT');
    END IF;
    IF v_prev.state IN ('pending_rotation','activated') THEN
      -- Replay: NO se escribe la clave nueva, NO se crea secreto, NO se crea otra
      -- rotación. Se devuelve el CSR/fingerprint YA almacenados. La clave del retry
      -- queda descartada en memoria por el Edge.
      PERFORM private.arca_audit('arca_certificate_rotation_replayed', p_business_id, p_actor, NULL, left(v_prev.private_key_fingerprint,16), 'replayed', NULL);
      RETURN jsonb_build_object('ok', true, 'state', 'ROTATION_ALREADY_PREPARED',
        'csr_pem', v_prev.csr_pem, 'fingerprint_trunc', left(v_prev.private_key_fingerprint,16),
        'algorithm', v_prev.key_algorithm, 'key_size', v_prev.key_size,
        'rotation_ref', left(v_prev.id::text,8));
    END IF;
    -- estado cancelled/failed previo con misma key → se permite re-preparar (cae abajo)
  END IF;

  -- A lo sumo una rotación pendiente por negocio.
  IF EXISTS (SELECT 1 FROM private.arca_credential_rotations r
             WHERE r.business_id = p_business_id AND r.state = 'pending_rotation'
               AND r.idempotency_key <> p_idempotency_key) THEN
    PERFORM private.arca_audit('arca_certificate_rotation_prepare_failed', p_business_id, p_actor, NULL, NULL, 'ROTATION_PENDING_CONFLICT', 'ROTATION_PENDING_CONFLICT');
    RETURN jsonb_build_object('ok', false, 'state', 'ROTATION_PENDING_CONFLICT');
  END IF;

  v_rot_id := gen_random_uuid();

  -- Vault + readback OBLIGATORIO bajo un mismo savepoint: si el readback falla o no
  -- coincide, se revierten el secreto Vault Y (no hay fila aún) → sin huérfanos.
  DECLARE v_stored boolean := false;
  BEGIN
    v_secret_id := vault.create_secret(
      p_key_pem,
      'arca-private-key-rotation:'||p_business_id::text||':'||replace(v_rot_id::text,'-',''),
      'ARCA WSAA private key (rotación pendiente S4A)');
    v_stored := true;
    SELECT ds.decrypted_secret INTO v_readback FROM vault.decrypted_secrets ds WHERE ds.id = v_secret_id;
    v_readback_fp := private.arca_key_fingerprint(v_readback);
    IF v_readback_fp IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'readback_fingerprint_mismatch';
    END IF;
  EXCEPTION WHEN others THEN
    PERFORM private.arca_audit('arca_certificate_rotation_prepare_failed', p_business_id, p_actor, NULL, left(v_fp,16),
      CASE WHEN v_stored THEN 'VAULT_READBACK_FAILED' ELSE 'VAULT_WRITE_FAILED' END,
      CASE WHEN v_stored THEN 'VAULT_READBACK_FAILED' ELSE 'VAULT_WRITE_FAILED' END);
    RETURN jsonb_build_object('ok', false, 'state',
      CASE WHEN v_stored THEN 'VAULT_READBACK_FAILED' ELSE 'VAULT_WRITE_FAILED' END);
  END;

  INSERT INTO private.arca_credential_rotations(
    id, business_id, private_key_secret_id, private_key_fingerprint, csr_fingerprint, csr_pem,
    key_algorithm, key_size, public_exponent, subject, state, idempotency_key, request_hash, created_by)
  VALUES (v_rot_id, p_business_id, v_secret_id, v_fp, v_csr_fp, p_csr_pem,
    coalesce(p_algorithm,'RSA'), v_bits, v_exp, v_csr_subj,
    'pending_rotation', p_idempotency_key, v_req_hash, p_actor);

  PERFORM private.arca_audit('arca_certificate_rotation_prepared', p_business_id, p_actor, NULL, left(v_fp,16), 'ROTATION_PREPARED', NULL);

  RETURN jsonb_build_object('ok', true, 'state', 'ROTATION_PREPARED',
    'csr_pem', p_csr_pem, 'fingerprint_trunc', left(v_fp,16),
    'algorithm', coalesce(p_algorithm,'RSA'), 'key_size', v_bits,
    'rotation_ref', left(v_rot_id::text,8));
END $function$;

-- ── 6. RPC de cancelación segura (solo pending, nunca active) ─────────────────
CREATE OR REPLACE FUNCTION public.arca_cancel_certificate_rotation(
  p_business_id uuid, p_idempotency_key text, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE v_row record;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'solo service_role' USING ERRCODE='42501';
  END IF;
  IF p_business_id IS NULL OR coalesce(btrim(p_idempotency_key),'')='' THEN
    RAISE EXCEPTION 'parámetros requeridos faltantes' USING ERRCODE='22023';
  END IF;
  IF p_actor IS NULL OR NOT public.is_business_owner_or_admin(p_business_id, p_actor) THEN
    RETURN jsonb_build_object('ok', false, 'state', 'UNAUTHORIZED');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('arca_rotation:' || p_business_id::text));

  SELECT * INTO v_row FROM private.arca_credential_rotations r
    WHERE r.business_id = p_business_id AND r.idempotency_key = p_idempotency_key FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'state', 'NO_PENDING_ROTATION');
  END IF;
  IF v_row.state = 'cancelled' THEN
    RETURN jsonb_build_object('ok', true, 'state', 'ROTATION_CANCELLED', 'rotation_ref', left(v_row.id::text,8));
  END IF;
  IF v_row.state <> 'pending_rotation' THEN
    -- nunca cancelar una rotación ya activada/fallida por esta vía
    RETURN jsonb_build_object('ok', false, 'state', 'NO_PENDING_ROTATION');
  END IF;

  -- Retira el secreto Vault pendiente y marca cancelado. NO toca la credencial active.
  DELETE FROM vault.secrets WHERE id = v_row.private_key_secret_id;
  UPDATE private.arca_credential_rotations
     SET state = 'cancelled', cancelled_at = now(), updated_at = now()
   WHERE id = v_row.id;
  PERFORM private.arca_audit('arca_certificate_rotation_cancelled', p_business_id, p_actor, NULL, left(v_row.private_key_fingerprint,16), 'ROTATION_CANCELLED', NULL);

  RETURN jsonb_build_object('ok', true, 'state', 'ROTATION_CANCELLED', 'rotation_ref', left(v_row.id::text,8));
END $function$;

-- ── 7. Grants: ambas RPC son service_role-only (paridad con S3A) ──────────────
REVOKE ALL ON FUNCTION public.arca_prepare_certificate_rotation(uuid,text,text,text,text,integer,bigint,jsonb,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.arca_prepare_certificate_rotation(uuid,text,text,text,text,integer,bigint,jsonb,text,uuid) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.arca_prepare_certificate_rotation(uuid,text,text,text,text,integer,bigint,jsonb,text,uuid) TO service_role;

REVOKE ALL ON FUNCTION public.arca_cancel_certificate_rotation(uuid,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.arca_cancel_certificate_rotation(uuid,text,uuid) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.arca_cancel_certificate_rotation(uuid,text,uuid) TO service_role;

COMMENT ON FUNCTION public.arca_prepare_certificate_rotation(uuid,text,text,text,text,integer,bigint,jsonb,text,uuid) IS
  'AFIP-S4A: prepara rotación (clave nueva→Vault pending_rotation + CSR). service_role-only, idempotente, fail-closed. No toca active/cert/token/private_key legacy. No devuelve la clave.';
COMMENT ON FUNCTION public.arca_cancel_certificate_rotation(uuid,text,uuid) IS
  'AFIP-S4A: cancela una rotación pendiente (retira el secreto Vault pendiente). Solo pending_rotation, nunca active. Idempotente.';

DO $$ BEGIN RAISE NOTICE 'AFIP-S4A: contrato de rotación listo y DORMIDO (sin rotación productiva).'; END $$;
