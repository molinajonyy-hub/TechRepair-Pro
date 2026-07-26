-- ============================================================================
-- AFIP-S4B-1b — Subject mínimo y fiel para el CSR de rotación
--
-- El certificado ARCA vigente de este negocio tiene un subject MÍNIMO:
--   CN = <alias fiscal>   ·   serialNumber = CUIT <11 dígitos>
-- y ningún otro atributo. El Edge de rotación (S4A), en cambio, exigía
-- `razon_social` (la usaba para CN y O) y rellenaba C=AR + ST/L='Buenos Aires'
-- por default. Con la configuración real (sin razón social) eso significaba
-- INVENTAR identidad fiscal y emitir un CN distinto al del certificado en uso.
--
-- Este lote hace que la identidad del CSR se derive SERVER-SIDE del certificado
-- vigente, y que la preparación falle de forma fail-closed si esa identidad no
-- es consistente con arca_config.
--
--   1) se extrae el walker X.500 a `private.arca_x500_name` (compartido: no se
--      duplican parsers DER — `arca_csr_subject` pasa a delegar en él y se suma
--      `arca_cert_subject`);
--   2) `public.arca_get_rotation_subject_safe` devuelve el subject AUTORIZADO
--      (mínimo, sanitizado) tras validar CN==alias y serialNumber==CUIT;
--   3) `public.arca_prepare_certificate_rotation` valida el CSR contra ESE
--      subject autorizado y rechaza cualquier atributo extra.
--
-- NO genera claves, NO crea secretos, NO prepara rotaciones, NO invoca WSAA.
-- NO toca la credencial activa, arca_config, token, sign ni el certificado.
-- ============================================================================

-- ── 1. Walker X.500 compartido ───────────────────────────────────────────────
-- Recorre un Name (SEQUENCE OF RelativeDistinguishedName(SET) OF
-- AttributeTypeAndValue{OID, value}) ubicado en p_offset y devuelve un jsonb
-- canónico (claves minúsculas, valores trim). Fail-closed: ante desvío
-- estructural devuelve lo acumulado.
CREATE OR REPLACE FUNCTION private.arca_x500_name(p_der bytea, p_offset integer)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE ls int; cs int; i int; lset int; cset int; latv int; catv int;
        loid int; coid int; lval int; cval int; oid bytea; val text; fld text;
        subj jsonb := '{}'::jsonb;
BEGIN
  IF p_der IS NULL OR p_offset IS NULL THEN RETURN subj; END IF;
  IF get_byte(p_der, p_offset) <> 48 THEN RETURN subj; END IF;          -- SEQUENCE
  SELECT len, content_start INTO ls, cs FROM private.arca_der_len(p_der, p_offset);
  IF cs + ls > length(p_der) THEN RETURN subj; END IF;
  i := cs;
  WHILE i < cs + ls LOOP
    IF get_byte(p_der, i) <> 49 THEN EXIT; END IF;                      -- SET (RDN)
    SELECT len, content_start INTO lset, cset FROM private.arca_der_len(p_der, i);
    catv := cset;
    WHILE catv < cset + lset LOOP
      IF get_byte(p_der, catv) <> 48 THEN EXIT; END IF;                 -- SEQUENCE (ATV)
      SELECT len, content_start INTO latv, coid FROM private.arca_der_len(p_der, catv);
      IF get_byte(p_der, coid) <> 6 THEN                                -- OID
        catv := private.arca_der_next(p_der, catv); CONTINUE;
      END IF;
      SELECT len, content_start INTO loid, cval FROM private.arca_der_len(p_der, coid);
      oid := substring(p_der from cval + 1 for loid);
      SELECT len, content_start INTO lval, cval FROM private.arca_der_len(p_der, cval + loid);
      BEGIN val := convert_from(substring(p_der from cval + 1 for lval), 'UTF8');
      EXCEPTION WHEN others THEN val := NULL; END;
      fld := CASE oid
        WHEN '\x550403'::bytea THEN 'cn'   WHEN '\x550405'::bytea THEN 'serialnumber'
        WHEN '\x55040a'::bytea THEN 'o'    WHEN '\x55040b'::bytea THEN 'ou'
        WHEN '\x550406'::bytea THEN 'c'    WHEN '\x550408'::bytea THEN 'st'
        WHEN '\x550407'::bytea THEN 'l'    WHEN '\x2a864886f70d010901'::bytea THEN 'email'
        ELSE 'unknown:' || encode(oid, 'hex') END;                      -- atributo NO esperado
      IF val IS NOT NULL THEN subj := subj || jsonb_build_object(fld, btrim(val)); END IF;
      catv := private.arca_der_next(p_der, catv);
    END LOOP;
    i := private.arca_der_next(p_der, i);
  END LOOP;
  RETURN subj;
END $function$;

-- ── 2. Subject de un CSR (PKCS#10) — ahora delega en el walker compartido ─────
-- CertificationRequest ::= SEQ { CertificationRequestInfo SEQ { version INT,
--   subject Name, subjectPKInfo, [0] attrs }, sigAlg, sig }
CREATE OR REPLACE FUNCTION private.arca_csr_subject(p_der bytea)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE c0 int; ci int; i int;
BEGIN
  IF p_der IS NULL OR length(p_der) < 32 THEN RETURN '{}'::jsonb; END IF;
  IF get_byte(p_der, 0) <> 48 THEN RETURN '{}'::jsonb; END IF;
  SELECT content_start INTO c0 FROM private.arca_der_len(p_der, 0);
  IF get_byte(p_der, c0) <> 48 THEN RETURN '{}'::jsonb; END IF;         -- CertificationRequestInfo
  SELECT content_start INTO ci FROM private.arca_der_len(p_der, c0);
  i := ci;
  IF get_byte(p_der, i) <> 2 THEN RETURN '{}'::jsonb; END IF;           -- version INTEGER
  i := private.arca_der_next(p_der, i);
  RETURN private.arca_x500_name(p_der, i);                              -- subject
END $function$;

-- ── 3. Subject de un CERTIFICADO X.509 (mismo walker) ────────────────────────
-- Certificate ::= SEQ { tbsCertificate SEQ { [0] version?, serialNumber INT,
--   signature SEQ, issuer Name, validity SEQ, subject Name, SPKI, ... }, ... }
CREATE OR REPLACE FUNCTION private.arca_cert_subject(p_der bytea)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE c0 int; ct int; i int;
BEGIN
  IF p_der IS NULL OR length(p_der) < 64 THEN RETURN '{}'::jsonb; END IF;
  IF get_byte(p_der, 0) <> 48 THEN RETURN '{}'::jsonb; END IF;
  SELECT content_start INTO c0 FROM private.arca_der_len(p_der, 0);
  IF get_byte(p_der, c0) <> 48 THEN RETURN '{}'::jsonb; END IF;         -- tbsCertificate
  SELECT content_start INTO ct FROM private.arca_der_len(p_der, c0);
  i := ct;
  IF get_byte(p_der, i) = 160 THEN i := private.arca_der_next(p_der, i); END IF;  -- [0] version
  i := private.arca_der_next(p_der, i);   -- serialNumber
  i := private.arca_der_next(p_der, i);   -- signature (AlgorithmIdentifier)
  i := private.arca_der_next(p_der, i);   -- issuer
  i := private.arca_der_next(p_der, i);   -- validity
  RETURN private.arca_x500_name(p_der, i);                              -- subject
END $function$;

-- ── 4. Normalización (SOLO para comparar) ────────────────────────────────────
-- CUIT/serialNumber: acepta el prefijo canónico 'CUIT ', quita guiones/espacios
-- y deja los dígitos. CN: solo trim (no cambia casing ni caracteres).
CREATE OR REPLACE FUNCTION private.arca_norm_cuit(p_value text)
RETURNS text LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT nullif(regexp_replace(coalesce(p_value, ''), '[^0-9]', '', 'g'), '');
$function$;

-- ── 5. Subject AUTORIZADO de rotación (service_role-only, read-only) ─────────
-- Deriva la identidad del CERTIFICADO VIGENTE y exige consistencia con
-- arca_config. Nunca devuelve cert_file, private_key, token ni sign.
CREATE OR REPLACE FUNCTION public.arca_get_rotation_subject_safe(p_business_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE v_cert text; v_alias text; v_cuit text; v_subj jsonb;
        v_cn text; v_sn text; v_extra int;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'solo service_role' USING ERRCODE = '42501';
  END IF;
  IF p_business_id IS NULL THEN
    RAISE EXCEPTION 'business_id requerido' USING ERRCODE = '22023';
  END IF;

  SELECT c.cert_file, btrim(coalesce(c.alias, '')), private.arca_norm_cuit(c.cuit)
    INTO v_cert, v_alias, v_cuit
    FROM public.arca_config c WHERE c.business_id = p_business_id;

  IF v_alias IS NULL OR v_alias = '' THEN
    RETURN jsonb_build_object('ok', false, 'state', 'FISCAL_ALIAS_MISSING');
  END IF;
  IF v_cuit IS NULL OR length(v_cuit) <> 11 THEN
    RETURN jsonb_build_object('ok', false, 'state', 'FISCAL_CUIT_MISSING');
  END IF;
  IF v_cert IS NULL OR btrim(v_cert) = '' THEN
    RETURN jsonb_build_object('ok', false, 'state', 'CURRENT_CERTIFICATE_SUBJECT_INVALID');
  END IF;

  v_subj := private.arca_cert_subject(private.arca_pem_to_der(v_cert));
  v_cn := btrim(coalesce(v_subj ->> 'cn', ''));
  v_sn := private.arca_norm_cuit(v_subj ->> 'serialnumber');
  IF v_cn = '' OR v_sn IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'state', 'CURRENT_CERTIFICATE_SUBJECT_INVALID');
  END IF;

  -- No se elige silenciosamente entre certificado y configuración: deben coincidir.
  IF v_cn IS DISTINCT FROM v_alias OR v_sn IS DISTINCT FROM v_cuit THEN
    PERFORM private.arca_audit('arca_certificate_rotation_prepare_failed', p_business_id, NULL, NULL,
      NULL, 'CURRENT_CERTIFICATE_IDENTITY_MISMATCH', 'CURRENT_CERTIFICATE_IDENTITY_MISMATCH');
    RETURN jsonb_build_object('ok', false, 'state', 'CURRENT_CERTIFICATE_IDENTITY_MISMATCH');
  END IF;

  -- Subject MÍNIMO y FIEL: exactamente los atributos presentes en el certificado
  -- vigente. Si el certificado solo tiene CN + serialNumber, el CSR también.
  v_extra := (SELECT count(*) FROM jsonb_object_keys(v_subj) k WHERE k NOT IN ('cn','serialnumber'));
  RETURN jsonb_build_object(
    'ok', true, 'state', 'ROTATION_SUBJECT_RESOLVED',
    'subject', jsonb_build_object('cn', v_cn, 'serialnumber', v_subj ->> 'serialnumber'),
    'optional_attributes_count', v_extra,
    'alias_match', true, 'cuit_match', true);
END $function$;

REVOKE ALL ON FUNCTION public.arca_get_rotation_subject_safe(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.arca_get_rotation_subject_safe(uuid) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.arca_get_rotation_subject_safe(uuid) TO service_role;

COMMENT ON FUNCTION public.arca_get_rotation_subject_safe(uuid) IS
  'AFIP-S4B-1b: subject AUTORIZADO de rotación derivado del certificado vigente (CN+serialNumber), validado contra alias/CUIT. service_role-only, read-only, sanitizado: no devuelve cert, clave, token ni sign.';

-- ── 6. Preparación: el CSR debe replicar EXACTAMENTE el subject autorizado ────
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
  v_auth jsonb; v_auth_subj jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'solo service_role' USING ERRCODE='42501';
  END IF;
  IF p_business_id IS NULL OR coalesce(btrim(p_idempotency_key),'')=''
     OR coalesce(btrim(p_fingerprint),'')='' OR coalesce(btrim(p_key_pem),'')=''
     OR coalesce(btrim(p_csr_pem),'')='' THEN
    RAISE EXCEPTION 'parámetros requeridos faltantes' USING ERRCODE='22023';
  END IF;

  IF p_actor IS NULL OR NOT public.is_business_owner_or_admin(p_business_id, p_actor) THEN
    PERFORM private.arca_audit('arca_certificate_rotation_prepare_failed', p_business_id, p_actor, NULL, NULL, 'UNAUTHORIZED', 'UNAUTHORIZED');
    RETURN jsonb_build_object('ok', false, 'state', 'UNAUTHORIZED');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('arca_rotation:' || p_business_id::text));

  -- ── S4B-1b: identidad AUTORIZADA desde el certificado vigente. Si no es
  --    consistente, se corta ANTES de generar/almacenar nada.
  v_auth := public.arca_get_rotation_subject_safe(p_business_id);
  IF (v_auth ->> 'ok') IS DISTINCT FROM 'true' THEN
    RETURN jsonb_build_object('ok', false, 'state', v_auth ->> 'state');
  END IF;
  v_auth_subj := v_auth -> 'subject';

  IF p_key_pem ~ '-----BEGIN CERTIFICATE-----'
     OR p_key_pem ~ '-----BEGIN (RSA |EC )?PUBLIC KEY-----'
     OR (SELECT count(*) FROM regexp_matches(p_key_pem, '-----BEGIN (RSA |EC )?PRIVATE KEY-----', 'g')) <> 1 THEN
    PERFORM private.arca_audit('arca_certificate_rotation_prepare_failed', p_business_id, p_actor, NULL, NULL, 'KEY_GENERATION_FAILED', 'KEY_GENERATION_FAILED');
    RETURN jsonb_build_object('ok', false, 'state', 'KEY_GENERATION_FAILED');
  END IF;

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

  SELECT * INTO v_csr_pub FROM private.arca_rsa_pubkey_from_csr(private.arca_pem_to_der(p_csr_pem));
  IF v_csr_pub.n IS NULL OR v_csr_pub.e IS NULL THEN
    PERFORM private.arca_audit('arca_certificate_rotation_prepare_failed', p_business_id, p_actor, NULL, NULL, 'CSR_GENERATION_FAILED', 'CSR_GENERATION_FAILED');
    RETURN jsonb_build_object('ok', false, 'state', 'CSR_GENERATION_FAILED');
  END IF;
  v_csr_fp   := private.arca_rsa_public_key_fingerprint_sha256(v_csr_pub.n, v_csr_pub.e);
  v_csr_bits := length(v_csr_pub.n) * 8;
  v_csr_subj := private.arca_csr_subject(private.arca_pem_to_der(p_csr_pem));

  IF v_csr_fp IS DISTINCT FROM v_fp THEN
    PERFORM private.arca_audit('arca_certificate_rotation_prepare_failed', p_business_id, p_actor, NULL, NULL, 'CSR_KEY_MISMATCH', 'CSR_KEY_MISMATCH');
    RETURN jsonb_build_object('ok', false, 'state', 'CSR_KEY_MISMATCH');
  END IF;

  -- Parámetros criptográficos declarados vs CSR real.
  IF (p_key_size IS NOT NULL AND p_key_size <> v_csr_bits)
     OR (p_public_exponent IS NOT NULL AND p_public_exponent <> v_exp)
     OR v_csr_bits <> v_bits THEN
    PERFORM private.arca_audit('arca_certificate_rotation_prepare_failed', p_business_id, p_actor, NULL, NULL, 'CSR_KEY_MISMATCH', 'CSR_KEY_MISMATCH');
    RETURN jsonb_build_object('ok', false, 'state', 'CSR_KEY_MISMATCH');
  END IF;

  -- ── S4B-1b: el subject del CSR debe ser EXACTAMENTE el autorizado. Cualquier
  --    atributo extra (C/ST/L/O/OU/email/desconocido) → CSR_SUBJECT_MISMATCH.
  --    También se rechaza un p_subject declarado que no coincida (Edge mentiroso).
  IF private.arca_canonical_subject(v_csr_subj) IS DISTINCT FROM private.arca_canonical_subject(v_auth_subj)
     OR (p_subject IS NOT NULL AND p_subject <> '{}'::jsonb
         AND private.arca_canonical_subject(p_subject) IS DISTINCT FROM private.arca_canonical_subject(v_auth_subj)) THEN
    PERFORM private.arca_audit('arca_certificate_rotation_prepare_failed', p_business_id, p_actor, NULL, NULL, 'CSR_SUBJECT_MISMATCH', 'CSR_SUBJECT_MISMATCH');
    RETURN jsonb_build_object('ok', false, 'state', 'CSR_SUBJECT_MISMATCH');
  END IF;

  -- request_hash SEMÁNTICO (S4A.1): intención del pedido, sin clave ni fingerprint.
  v_canon := 'arca_prepare_certificate_rotation|' || p_business_id::text || '|'
             || private.arca_canonical_subject(v_csr_subj) || '|RSA|'
             || v_csr_bits::text || '|' || v_exp::text;
  v_req_hash := encode(extensions.digest(v_canon, 'sha256'), 'hex');

  SELECT * INTO v_prev FROM private.arca_credential_rotations r
    WHERE r.business_id = p_business_id AND r.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_prev.request_hash IS DISTINCT FROM v_req_hash THEN
      PERFORM private.arca_audit('arca_certificate_rotation_prepare_failed', p_business_id, p_actor, NULL, NULL, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
      RETURN jsonb_build_object('ok', false, 'state', 'IDEMPOTENCY_CONFLICT');
    END IF;
    IF v_prev.state IN ('pending_rotation','activated') THEN
      PERFORM private.arca_audit('arca_certificate_rotation_replayed', p_business_id, p_actor, NULL, left(v_prev.private_key_fingerprint,16), 'replayed', NULL);
      RETURN jsonb_build_object('ok', true, 'state', 'ROTATION_ALREADY_PREPARED',
        'csr_pem', v_prev.csr_pem, 'fingerprint_trunc', left(v_prev.private_key_fingerprint,16),
        'algorithm', v_prev.key_algorithm, 'key_size', v_prev.key_size,
        'rotation_ref', left(v_prev.id::text,8));
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM private.arca_credential_rotations r
             WHERE r.business_id = p_business_id AND r.state = 'pending_rotation'
               AND r.idempotency_key <> p_idempotency_key) THEN
    PERFORM private.arca_audit('arca_certificate_rotation_prepare_failed', p_business_id, p_actor, NULL, NULL, 'ROTATION_PENDING_CONFLICT', 'ROTATION_PENDING_CONFLICT');
    RETURN jsonb_build_object('ok', false, 'state', 'ROTATION_PENDING_CONFLICT');
  END IF;

  v_rot_id := gen_random_uuid();

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

REVOKE ALL ON FUNCTION public.arca_prepare_certificate_rotation(uuid,text,text,text,text,integer,bigint,jsonb,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.arca_prepare_certificate_rotation(uuid,text,text,text,text,integer,bigint,jsonb,text,uuid) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.arca_prepare_certificate_rotation(uuid,text,text,text,text,integer,bigint,jsonb,text,uuid) TO service_role;

COMMENT ON FUNCTION public.arca_prepare_certificate_rotation(uuid,text,text,text,text,integer,bigint,jsonb,text,uuid) IS
  'AFIP-S4A/S4B-1b: prepara rotación (clave nueva→Vault pending_rotation + CSR). El subject se deriva del certificado vigente y el CSR debe replicarlo EXACTAMENTE (sin C/ST/L/O). service_role-only, idempotente, fail-closed. No toca active/cert/token/private_key legacy. No devuelve la clave.';

DO $$ BEGIN RAISE NOTICE 'AFIP-S4B-1b: subject mínimo y fiel aplicado (identidad derivada del certificado vigente).'; END $$;
