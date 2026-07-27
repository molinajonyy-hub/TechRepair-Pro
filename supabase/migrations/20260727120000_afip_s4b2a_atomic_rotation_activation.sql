-- ============================================================================
-- AFIP-S4B-2A — Activación y rollback ATÓMICOS de la rotación (mecanismo DORMIDO)
--
-- Despliega el contrato que, en S4B-2B, permitirá activar en UNA transacción:
--   · la clave nueva ya provisionada en Vault como `pending_rotation`;
--   · el certificado público nuevo emitido por ARCA.
--
-- Este lote NO activa nada productivo: solo deja los contratos disponibles.
--
-- RESTRICCIÓN QUE DEFINE EL DISEÑO
--   `private.arca_private_key_credentials` tiene UNIQUE(business_id): no pueden
--   coexistir la credencial vieja y la nueva como dos filas. Por eso la
--   activación ACTUALIZA LA FILA EN SU LUGAR (swap de secret_id + fingerprints)
--   y el par anterior se preserva como CHECKPOINT en la fila de rotación:
--   referencia al secreto Vault anterior (que NO se borra), su fingerprint, el
--   certificado anterior y el cache WSAA anterior. Así se respeta la unicidad,
--   no se duplica ninguna clave privada y el rollback es un simple re-apunte.
--
-- La llamada a WSAA queda FUERA de la transacción y fuera de este lote: la
-- activación solo invalida el cache y deja el estado
-- `activation_pending_wsaa_verification` para que S4B-2B lo verifique.
-- ============================================================================

-- ── 1. Estados de rotación y auditoría ───────────────────────────────────────
ALTER TABLE private.arca_credential_rotations DROP CONSTRAINT IF EXISTS arca_credential_rotations_state_check;
ALTER TABLE private.arca_credential_rotations ADD CONSTRAINT arca_credential_rotations_state_check CHECK (state IN (
  'pending_rotation',                  -- clave nueva en Vault, sin certificado
  'activated_pending_verification',    -- activada; falta el refresh WSAA (S4B-2B)
  'completed',                         -- verificada end-to-end (S4B-2B/S4C)
  'rolled_back',                       -- revertida al par anterior
  'activation_failed',                 -- la activación falló y no se aplicó
  'cancelled',                         -- cancelada antes de activar
  'failed'));

ALTER TABLE private.arca_credential_audit DROP CONSTRAINT IF EXISTS arca_credential_audit_event_check;
ALTER TABLE private.arca_credential_audit ADD CONSTRAINT arca_credential_audit_event_check CHECK (event IN (
  'credential_validation_success','credential_validation_failure',
  'credential_store_success','credential_store_failure','credential_replaced','credential_deleted',
  'arca_config_legacy_saved','arca_certificate_legacy_saved','arca_estado_updated',
  'wsaa_private_key_resolved_vault','wsaa_private_key_resolved_legacy','wsaa_private_key_resolution_failed',
  'arca_private_key_vault_migration_started','arca_private_key_vault_migrated',
  'arca_private_key_vault_migration_failed','arca_private_key_vault_migration_replayed',
  'arca_certificate_rotation_prepared','arca_certificate_rotation_prepare_failed',
  'arca_certificate_rotation_replayed','arca_certificate_rotation_cancelled',
  -- AFIP-S4B-2A
  'arca_certificate_rotation_activation_started','arca_certificate_rotation_activated',
  'arca_certificate_rotation_activation_failed','arca_certificate_rotation_activation_replayed',
  'arca_certificate_rotation_rollback_started','arca_certificate_rotation_rolled_back',
  'arca_certificate_rotation_rollback_failed'));

-- ── 2. Checkpoint del par anterior (metadata privada de la rotación) ─────────
ALTER TABLE private.arca_credential_rotations
  ADD COLUMN IF NOT EXISTS certificate_fingerprint     text,        -- SPKI del cert nuevo
  ADD COLUMN IF NOT EXISTS certificate_pem             text,        -- cert PÚBLICO nuevo
  ADD COLUMN IF NOT EXISTS prev_secret_id              uuid,        -- secreto Vault anterior (NO se borra)
  ADD COLUMN IF NOT EXISTS prev_fingerprint            text,
  ADD COLUMN IF NOT EXISTS prev_certificate_pem        text,        -- cert PÚBLICO anterior
  ADD COLUMN IF NOT EXISTS prev_wsaa_token             text,
  ADD COLUMN IF NOT EXISTS prev_wsaa_sign              text,
  ADD COLUMN IF NOT EXISTS prev_wsaa_token_expires     timestamptz,
  ADD COLUMN IF NOT EXISTS prev_estado_conexion        text,
  ADD COLUMN IF NOT EXISTS prev_status                 text,        -- 'rollback_candidate' mientras esté activada
  ADD COLUMN IF NOT EXISTS activation_idempotency_key  text,
  ADD COLUMN IF NOT EXISTS activation_request_hash     text,
  ADD COLUMN IF NOT EXISTS activated_by                uuid,
  ADD COLUMN IF NOT EXISTS rolled_back_at              timestamptz;

-- Idempotencia de activación por negocio.
CREATE UNIQUE INDEX IF NOT EXISTS arca_credential_rotations_activation_idem
  ON private.arca_credential_rotations (business_id, activation_idempotency_key)
  WHERE activation_idempotency_key IS NOT NULL;

-- ── 3. Vigencia del certificado (notBefore / notAfter) ───────────────────────
-- Certificate → tbsCertificate → [0]version? → serial → sigAlg → issuer →
-- validity SEQUENCE { notBefore Time, notAfter Time }. Time = UTCTime (0x17,
-- 'YYMMDDHHMMSSZ') o GeneralizedTime (0x18, 'YYYYMMDDHHMMSSZ').
-- Fail-closed: ante desvío estructural devuelve (NULL, NULL).
CREATE OR REPLACE FUNCTION private.arca_cert_validity(p_der bytea, OUT not_before timestamptz, OUT not_after timestamptz)
RETURNS record LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE c0 int; ct int; i int; lv int; cv int; j int; tag int; lt int; cvt int; raw text; k int;
        v timestamptz;
BEGIN
  not_before := NULL; not_after := NULL;
  IF p_der IS NULL OR length(p_der) < 64 THEN RETURN; END IF;
  IF get_byte(p_der, 0) <> 48 THEN RETURN; END IF;
  SELECT content_start INTO c0 FROM private.arca_der_len(p_der, 0);
  IF get_byte(p_der, c0) <> 48 THEN RETURN; END IF;
  SELECT content_start INTO ct FROM private.arca_der_len(p_der, c0);
  i := ct;
  IF get_byte(p_der, i) = 160 THEN i := private.arca_der_next(p_der, i); END IF;  -- [0] version
  i := private.arca_der_next(p_der, i);   -- serialNumber
  i := private.arca_der_next(p_der, i);   -- signature
  i := private.arca_der_next(p_der, i);   -- issuer
  IF get_byte(p_der, i) <> 48 THEN RETURN; END IF;                                -- validity
  SELECT len, content_start INTO lv, cv FROM private.arca_der_len(p_der, i);
  j := cv;
  FOR k IN 1..2 LOOP
    tag := get_byte(p_der, j);
    IF tag <> 23 AND tag <> 24 THEN RETURN; END IF;
    SELECT len, content_start INTO lt, cvt FROM private.arca_der_len(p_der, j);
    BEGIN raw := convert_from(substring(p_der from cvt+1 for lt), 'UTF8');
    EXCEPTION WHEN others THEN RETURN; END;
    raw := btrim(raw);
    BEGIN
      IF tag = 23 THEN                                   -- UTCTime YYMMDDHHMMSSZ
        v := to_timestamp(
               (CASE WHEN substring(raw,1,2)::int >= 50 THEN '19' ELSE '20' END) || raw,
               'YYYYMMDDHH24MISS');
      ELSE                                               -- GeneralizedTime
        v := to_timestamp(raw, 'YYYYMMDDHH24MISS');
      END IF;
    EXCEPTION WHEN others THEN RETURN; END;
    IF k = 1 THEN not_before := v; ELSE not_after := v; END IF;
    j := private.arca_der_next(p_der, j);
  END LOOP;
END $function$;

-- ── 4. Validación estructural del certificado contra la rotación pendiente ───
-- Devuelve un jsonb sanitizado con el veredicto. NO devuelve el certificado.
CREATE OR REPLACE FUNCTION private.arca_validate_rotation_certificate(
  p_cert_pem text, p_expected_fp text, p_expected_subject jsonb, p_active_fp text)
RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE v_der bytea; v_pub record; v_fp text; v_subj jsonb; v_val record; v_bits int; v_exp bigint;
BEGIN
  IF p_cert_pem IS NULL OR btrim(p_cert_pem) = ''
     OR (SELECT count(*) FROM regexp_matches(p_cert_pem, '-----BEGIN CERTIFICATE-----', 'g')) <> 1
     OR p_cert_pem ~ '-----BEGIN (RSA |EC )?PRIVATE KEY-----' THEN
    RETURN jsonb_build_object('ok', false, 'state', 'CERTIFICATE_INVALID');
  END IF;

  v_der := private.arca_pem_to_der(p_cert_pem);
  IF v_der IS NULL THEN RETURN jsonb_build_object('ok', false, 'state', 'CERTIFICATE_INVALID'); END IF;

  SELECT * INTO v_pub FROM private.arca_rsa_pubkey_from_cert(v_der);
  IF v_pub.n IS NULL OR v_pub.e IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'state', 'CERTIFICATE_INVALID');
  END IF;
  v_bits := length(v_pub.n) * 8;
  v_exp  := ('x'||lpad(encode(v_pub.e,'hex'),16,'0'))::bit(64)::bigint;
  IF v_bits < 2048 OR v_exp <> 65537 THEN
    RETURN jsonb_build_object('ok', false, 'state', 'CERTIFICATE_INVALID');
  END IF;

  -- Correspondencia ESTRUCTURAL por SPKI (modulus + exponent), nunca por bytes.
  v_fp := private.arca_rsa_public_key_fingerprint_sha256(v_pub.n, v_pub.e);
  IF v_fp IS DISTINCT FROM lower(btrim(p_expected_fp)) THEN
    -- Si además coincide con la credencial vigente, es el certificado VIEJO.
    RETURN jsonb_build_object('ok', false, 'state', 'CERTIFICATE_KEY_MISMATCH',
      'matches_active', (p_active_fp IS NOT NULL AND v_fp = p_active_fp));
  END IF;

  -- Subject EXACTO contra el autorizado en la rotación.
  v_subj := private.arca_cert_subject(v_der);
  IF private.arca_canonical_subject(v_subj) IS DISTINCT FROM private.arca_canonical_subject(p_expected_subject) THEN
    RETURN jsonb_build_object('ok', false, 'state', 'CERTIFICATE_SUBJECT_MISMATCH');
  END IF;

  -- Vigencia.
  SELECT * INTO v_val FROM private.arca_cert_validity(v_der);
  IF v_val.not_before IS NULL OR v_val.not_after IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'state', 'CERTIFICATE_INVALID');
  END IF;
  IF v_val.not_after < now()  THEN RETURN jsonb_build_object('ok', false, 'state', 'CERTIFICATE_EXPIRED'); END IF;
  IF v_val.not_before > now() THEN RETURN jsonb_build_object('ok', false, 'state', 'CERTIFICATE_NOT_YET_VALID'); END IF;

  RETURN jsonb_build_object('ok', true, 'state', 'CERTIFICATE_OK',
    'fingerprint', v_fp, 'key_size', v_bits, 'public_exponent', v_exp,
    'not_before', v_val.not_before, 'not_after', v_val.not_after);
END $function$;

-- ── 5. RPC de ACTIVACIÓN atómica (service_role-only, dormida) ────────────────
CREATE OR REPLACE FUNCTION public.arca_activate_certificate_rotation(
  p_business_id uuid, p_rotation_ref uuid, p_certificate_pem text,
  p_expected_fingerprint text, p_idempotency_key text, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_rot record; v_cred record; v_cfg record; v_val jsonb; v_canon text; v_hash text;
  v_prev record; v_readback text; v_readback_fp text; v_cert_fp text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'solo service_role' USING ERRCODE = '42501';
  END IF;
  IF p_business_id IS NULL OR coalesce(btrim(p_idempotency_key),'') = ''
     OR coalesce(btrim(p_certificate_pem),'') = '' OR coalesce(btrim(p_expected_fingerprint),'') = '' THEN
    RAISE EXCEPTION 'parámetros requeridos faltantes' USING ERRCODE = '22023';
  END IF;
  IF p_actor IS NULL OR NOT public.is_business_owner_or_admin(p_business_id, p_actor) THEN
    PERFORM private.arca_audit('arca_certificate_rotation_activation_failed', p_business_id, p_actor, NULL, NULL, 'UNAUTHORIZED', 'UNAUTHORIZED');
    RETURN jsonb_build_object('ok', false, 'state', 'UNAUTHORIZED');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('arca_rotation:' || p_business_id::text));

  -- ── Idempotencia (antes de tocar nada) ──
  SELECT * INTO v_rot FROM private.arca_credential_rotations r
    WHERE r.business_id = p_business_id AND r.activation_idempotency_key = p_idempotency_key;
  IF FOUND THEN
    v_cert_fp := private.arca_rsa_public_key_fingerprint_sha256(
                   (private.arca_rsa_pubkey_from_cert(private.arca_pem_to_der(p_certificate_pem))).n,
                   (private.arca_rsa_pubkey_from_cert(private.arca_pem_to_der(p_certificate_pem))).e);
    v_canon := 'arca_activate_certificate_rotation|' || p_business_id::text || '|' || v_rot.id::text
               || '|' || coalesce(v_cert_fp,'') || '|' || lower(btrim(p_expected_fingerprint));
    v_hash := encode(extensions.digest(v_canon, 'sha256'), 'hex');
    IF v_rot.activation_request_hash IS DISTINCT FROM v_hash THEN
      PERFORM private.arca_audit('arca_certificate_rotation_activation_failed', p_business_id, p_actor, NULL, NULL, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
      RETURN jsonb_build_object('ok', false, 'state', 'IDEMPOTENCY_CONFLICT');
    END IF;
    PERFORM private.arca_audit('arca_certificate_rotation_activation_replayed', p_business_id, p_actor, NULL, left(v_rot.private_key_fingerprint,16), 'replayed', NULL);
    RETURN jsonb_build_object('ok', true, 'state', 'ACTIVATION_ALREADY_APPLIED',
      'rotation_ref', left(v_rot.id::text,8),
      'new_fingerprint_trunc', left(v_rot.private_key_fingerprint,16),
      'previous_fingerprint_trunc', left(coalesce(v_rot.prev_fingerprint,''),16),
      'rotation_state', v_rot.state);
  END IF;

  -- ── Localizar EXACTAMENTE una pending del negocio ──
  SELECT * INTO v_rot FROM private.arca_credential_rotations r
    WHERE r.business_id = p_business_id AND r.state = 'pending_rotation'
      AND (p_rotation_ref IS NULL OR r.id = p_rotation_ref)
    FOR UPDATE;
  IF NOT FOUND THEN
    IF p_rotation_ref IS NOT NULL AND EXISTS (SELECT 1 FROM private.arca_credential_rotations
        WHERE id = p_rotation_ref AND business_id = p_business_id) THEN
      RETURN jsonb_build_object('ok', false, 'state', 'ROTATION_NOT_PENDING');
    END IF;
    RETURN jsonb_build_object('ok', false, 'state', 'ROTATION_NOT_FOUND');
  END IF;
  IF lower(btrim(p_expected_fingerprint)) IS DISTINCT FROM v_rot.private_key_fingerprint THEN
    PERFORM private.arca_audit('arca_certificate_rotation_activation_failed', p_business_id, p_actor, NULL, NULL, 'CERTIFICATE_KEY_MISMATCH', 'CERTIFICATE_KEY_MISMATCH');
    RETURN jsonb_build_object('ok', false, 'state', 'CERTIFICATE_KEY_MISMATCH');
  END IF;

  PERFORM private.arca_audit('arca_certificate_rotation_activation_started', p_business_id, p_actor, NULL, left(v_rot.private_key_fingerprint,16), 'started', NULL);

  -- ── Credencial vigente y configuración (checkpoint) ──
  SELECT * INTO v_cred FROM private.arca_private_key_credentials c
    WHERE c.business_id = p_business_id FOR UPDATE;
  IF NOT FOUND OR v_cred.credential_status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'state', 'ACTIVE_CREDENTIAL_CONFLICT');
  END IF;
  SELECT * INTO v_cfg FROM public.arca_config WHERE business_id = p_business_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'state', 'ACTIVE_CREDENTIAL_CONFLICT');
  END IF;

  -- ── Validación criptográfica COMPLETA antes de cualquier escritura ──
  v_val := private.arca_validate_rotation_certificate(
             p_certificate_pem, v_rot.private_key_fingerprint, v_rot.subject, v_cred.private_key_fingerprint);
  IF (v_val ->> 'ok') IS DISTINCT FROM 'true' THEN
    PERFORM private.arca_audit('arca_certificate_rotation_activation_failed', p_business_id, p_actor, NULL,
      left(v_rot.private_key_fingerprint,16), v_val ->> 'state', v_val ->> 'state');
    RETURN jsonb_build_object('ok', false, 'state', v_val ->> 'state');
  END IF;
  v_cert_fp := v_val ->> 'fingerprint';

  -- La clave pendiente debe seguir legible en Vault ANTES de promover.
  SELECT ds.decrypted_secret INTO v_readback FROM vault.decrypted_secrets ds WHERE ds.id = v_rot.private_key_secret_id;
  IF v_readback IS NULL OR private.arca_key_fingerprint(v_readback) IS DISTINCT FROM v_rot.private_key_fingerprint THEN
    PERFORM private.arca_audit('arca_certificate_rotation_activation_failed', p_business_id, p_actor, NULL, NULL, 'VAULT_READBACK_FAILED', 'VAULT_READBACK_FAILED');
    RETURN jsonb_build_object('ok', false, 'state', 'VAULT_READBACK_FAILED');
  END IF;

  v_canon := 'arca_activate_certificate_rotation|' || p_business_id::text || '|' || v_rot.id::text
             || '|' || v_cert_fp || '|' || lower(btrim(p_expected_fingerprint));
  v_hash := encode(extensions.digest(v_canon, 'sha256'), 'hex');

  -- ── ESCRITURA ATÓMICA (savepoint): checkpoint → swap → cache → readback ─────
  BEGIN
    -- 1) checkpoint del par anterior (el secreto Vault anterior NO se borra)
    UPDATE private.arca_credential_rotations SET
      certificate_pem            = p_certificate_pem,
      certificate_fingerprint    = v_cert_fp,
      prev_secret_id             = v_cred.private_key_secret_id,
      prev_fingerprint           = v_cred.private_key_fingerprint,
      prev_certificate_pem       = v_cfg.cert_file,
      prev_wsaa_token            = v_cfg.wsaa_token,
      prev_wsaa_sign             = v_cfg.wsaa_sign,
      prev_wsaa_token_expires    = v_cfg.wsaa_token_expires,
      prev_estado_conexion       = v_cfg.estado_conexion,
      prev_status                = 'rollback_candidate',
      state                      = 'activated_pending_verification',
      activation_idempotency_key = p_idempotency_key,
      activation_request_hash    = v_hash,
      activated_by               = p_actor,
      activated_at               = now(),
      updated_at                 = now()
    WHERE id = v_rot.id;

    -- 2) la credencial pasa a usar la clave nueva (misma fila: UNIQUE intacto)
    UPDATE private.arca_private_key_credentials SET
      private_key_secret_id   = v_rot.private_key_secret_id,
      private_key_fingerprint = v_rot.private_key_fingerprint,
      certificate_fingerprint = v_cert_fp,
      key_algorithm           = coalesce(v_rot.key_algorithm, key_algorithm),
      key_size                = coalesce(v_rot.key_size, key_size),
      credential_status       = 'active',
      rotated_at              = now(),
      updated_at              = now(),
      updated_by              = p_actor
    WHERE business_id = p_business_id;

    -- 3) certificado nuevo + invalidación ATÓMICA del cache WSAA
    UPDATE public.arca_config SET
      cert_file          = p_certificate_pem,
      wsaa_token         = NULL,
      wsaa_sign          = NULL,
      wsaa_token_expires = NULL,
      estado_conexion    = 'activation_pending_wsaa_verification',
      ultimo_error       = NULL,
      updated_at         = now()
    WHERE business_id = p_business_id;

    -- 4) readback FINAL: la credencial activa debe resolver la clave nueva
    v_readback := private.arca_get_private_key_for_signing(p_business_id);
    v_readback_fp := private.arca_key_fingerprint(v_readback);
    IF v_readback_fp IS DISTINCT FROM v_rot.private_key_fingerprint THEN
      RAISE EXCEPTION 'activation_readback_mismatch';
    END IF;
    -- 5) y el certificado guardado debe corresponder a esa clave
    IF NOT private.arca_key_matches_certificate(v_readback, p_certificate_pem) THEN
      RAISE EXCEPTION 'activation_pair_mismatch';
    END IF;
  EXCEPTION WHEN others THEN
    PERFORM private.arca_audit('arca_certificate_rotation_activation_failed', p_business_id, p_actor, NULL,
      left(v_rot.private_key_fingerprint,16), 'ACTIVATION_READBACK_FAILED', 'ACTIVATION_READBACK_FAILED');
    RETURN jsonb_build_object('ok', false, 'state', 'ACTIVATION_READBACK_FAILED');
  END;

  PERFORM private.arca_audit('arca_certificate_rotation_activated', p_business_id, p_actor, NULL,
    left(v_rot.private_key_fingerprint,16), 'ROTATION_ACTIVATED', NULL);

  RETURN jsonb_build_object('ok', true, 'state', 'ROTATION_ACTIVATED',
    'rotation_ref', left(v_rot.id::text,8),
    'new_fingerprint_trunc', left(v_rot.private_key_fingerprint,16),
    'previous_fingerprint_trunc', left(v_cred.private_key_fingerprint,16),
    'certificate_fingerprint_trunc', left(v_cert_fp,16),
    'key_size', v_rot.key_size, 'algorithm', v_rot.key_algorithm,
    'wsaa_cache_invalidated', true,
    'rotation_state', 'activated_pending_verification');
END $function$;

-- ── 6. RPC de ROLLBACK atómico (service_role-only) ──────────────────────────
CREATE OR REPLACE FUNCTION public.arca_rollback_certificate_rotation(
  p_business_id uuid, p_rotation_ref uuid, p_idempotency_key text, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE v_rot record; v_readback text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'solo service_role' USING ERRCODE = '42501';
  END IF;
  IF p_business_id IS NULL OR coalesce(btrim(p_idempotency_key),'') = '' THEN
    RAISE EXCEPTION 'parámetros requeridos faltantes' USING ERRCODE = '22023';
  END IF;
  IF p_actor IS NULL OR NOT public.is_business_owner_or_admin(p_business_id, p_actor) THEN
    RETURN jsonb_build_object('ok', false, 'state', 'UNAUTHORIZED');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('arca_rotation:' || p_business_id::text));

  SELECT * INTO v_rot FROM private.arca_credential_rotations r
    WHERE r.business_id = p_business_id
      AND (p_rotation_ref IS NULL OR r.id = p_rotation_ref)
      AND r.state IN ('activated_pending_verification','rolled_back')
    ORDER BY r.activated_at DESC NULLS LAST LIMIT 1
    FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'state', 'ROTATION_NOT_FOUND'); END IF;

  IF v_rot.state = 'rolled_back' THEN
    RETURN jsonb_build_object('ok', true, 'state', 'ROLLBACK_ALREADY_APPLIED',
      'rotation_ref', left(v_rot.id::text,8),
      'restored_fingerprint_trunc', left(coalesce(v_rot.prev_fingerprint,''),16));
  END IF;
  IF v_rot.prev_secret_id IS NULL OR v_rot.prev_fingerprint IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'state', 'ROTATION_NOT_PENDING');
  END IF;

  PERFORM private.arca_audit('arca_certificate_rotation_rollback_started', p_business_id, p_actor, NULL,
    left(v_rot.prev_fingerprint,16), 'started', NULL);

  BEGIN
    -- Restaurar el par anterior (re-apunte: ningún secreto se borró nunca).
    UPDATE private.arca_private_key_credentials SET
      private_key_secret_id   = v_rot.prev_secret_id,
      private_key_fingerprint = v_rot.prev_fingerprint,
      credential_status       = 'active',
      updated_at              = now(),
      updated_by              = p_actor
    WHERE business_id = p_business_id;

    UPDATE public.arca_config SET
      cert_file          = v_rot.prev_certificate_pem,
      wsaa_token         = NULL,          -- se fuerza refresh posterior
      wsaa_sign          = NULL,
      wsaa_token_expires = NULL,
      estado_conexion    = coalesce(v_rot.prev_estado_conexion, 'conectado'),
      updated_at         = now()
    WHERE business_id = p_business_id;

    UPDATE private.arca_credential_rotations SET
      state          = 'rolled_back',
      prev_status    = 'restored',
      rolled_back_at = now(),
      updated_at     = now()
    WHERE id = v_rot.id;

    v_readback := private.arca_get_private_key_for_signing(p_business_id);
    IF private.arca_key_fingerprint(v_readback) IS DISTINCT FROM v_rot.prev_fingerprint THEN
      RAISE EXCEPTION 'rollback_readback_mismatch';
    END IF;
  EXCEPTION WHEN others THEN
    PERFORM private.arca_audit('arca_certificate_rotation_rollback_failed', p_business_id, p_actor, NULL,
      left(v_rot.prev_fingerprint,16), 'ROLLBACK_FAILED', 'ROLLBACK_FAILED');
    RETURN jsonb_build_object('ok', false, 'state', 'ROLLBACK_FAILED');
  END;

  PERFORM private.arca_audit('arca_certificate_rotation_rolled_back', p_business_id, p_actor, NULL,
    left(v_rot.prev_fingerprint,16), 'ROTATION_ROLLED_BACK', NULL);

  RETURN jsonb_build_object('ok', true, 'state', 'ROTATION_ROLLED_BACK',
    'rotation_ref', left(v_rot.id::text,8),
    'restored_fingerprint_trunc', left(v_rot.prev_fingerprint,16),
    'wsaa_cache_invalidated', true);
END $function$;

-- ── 7. Grants: ambas RPC service_role-only ──────────────────────────────────
REVOKE ALL ON FUNCTION public.arca_activate_certificate_rotation(uuid,uuid,text,text,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.arca_activate_certificate_rotation(uuid,uuid,text,text,text,uuid) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.arca_activate_certificate_rotation(uuid,uuid,text,text,text,uuid) TO service_role;

REVOKE ALL ON FUNCTION public.arca_rollback_certificate_rotation(uuid,uuid,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.arca_rollback_certificate_rotation(uuid,uuid,text,uuid) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.arca_rollback_certificate_rotation(uuid,uuid,text,uuid) TO service_role;

COMMENT ON FUNCTION public.arca_activate_certificate_rotation(uuid,uuid,text,text,text,uuid) IS
  'AFIP-S4B-2A: activa atómicamente la rotación pendiente (clave nueva de Vault + certificado nuevo). Valida SPKI y subject ANTES de escribir, guarda checkpoint del par anterior, invalida el cache WSAA y hace readback. service_role-only, idempotente. No acepta ni devuelve claves privadas. No invoca WSAA.';
COMMENT ON FUNCTION public.arca_rollback_certificate_rotation(uuid,uuid,text,uuid) IS
  'AFIP-S4B-2A: revierte atómicamente una activación en activated_pending_verification restaurando el par anterior desde el checkpoint. No borra secretos. service_role-only, idempotente.';

DO $$ BEGIN RAISE NOTICE 'AFIP-S4B-2A: activación y rollback atómicos listos y DORMIDOS (sin rotación productiva activada).'; END $$;
