-- ============================================================================
-- AFIP-S4B-2C — Finalización AUDITADA de una rotación ya activada y verificada
--
--   activated_pending_verification  ──(validaciones server-side)──>  completed
--
-- Cierra formalmente la rotación que S4B-2B activó y verificó contra WSAA, y de
-- paso corrige la metadata de vencimiento: `arca_config.expires_at` quedaba con
-- el notAfter del certificado VIEJO porque la activación no toca esa columna.
--
-- Lo que este lote NO hace: no borra secretos, no borra checkpoints, no toca
-- `arca_config.private_key` (legacy en claro), no retira el fallback legacy, no
-- cambia `cert_file`, no cambia la credencial activa y no invoca WSAA ni AFIP.
-- Eso es materia de S4C.
--
-- EL ROLLBACK SIGUE DISPONIBLE DESPUÉS DE `completed`. Es deliberado: hasta que
-- S4C limpie el material anterior, revertir tiene que seguir siendo posible. El
-- gate natural es el propio Vault — si el secreto anterior ya no existe, el
-- rollback se rechaza fail-closed, sin necesidad de una bandera aparte que
-- pueda desincronizarse.
-- ============================================================================

-- ── 1. Eventos de auditoría de finalización ─────────────────────────────────
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
  'arca_certificate_rotation_activation_started','arca_certificate_rotation_activated',
  'arca_certificate_rotation_activation_failed','arca_certificate_rotation_activation_replayed',
  'arca_certificate_rotation_rollback_started','arca_certificate_rotation_rolled_back',
  'arca_certificate_rotation_rollback_failed',
  -- AFIP-S4B-2C
  'arca_certificate_rotation_finalization_started','arca_certificate_rotation_completed',
  'arca_certificate_rotation_finalization_failed','arca_certificate_rotation_finalization_replayed'));

-- Metadata sanitizada del evento. Sólo escalares: referencias truncadas,
-- estados y timestamps. NUNCA PEM, clave, secret_id, token, sign ni CUIT.
ALTER TABLE private.arca_credential_audit
  ADD COLUMN IF NOT EXISTS details jsonb;

COMMENT ON COLUMN private.arca_credential_audit.details IS
  'AFIP-S4B-2C: metadata SANITIZADA del evento (referencias truncadas, estados, timestamps). Prohibido guardar PEM, claves, secret_id, token/sign, JWT o CUIT completo.';

-- ── 2. Columnas de finalización y checkpoint del vencimiento ────────────────
ALTER TABLE private.arca_credential_rotations
  ADD COLUMN IF NOT EXISTS finalized_at                  timestamptz,
  ADD COLUMN IF NOT EXISTS finalized_by                  uuid,
  ADD COLUMN IF NOT EXISTS finalization_idempotency_key  text,
  ADD COLUMN IF NOT EXISTS finalization_request_hash     text,
  ADD COLUMN IF NOT EXISTS wsaa_verified_at              timestamptz,
  ADD COLUMN IF NOT EXISTS certificate_not_after         timestamptz,
  -- Vencimiento vigente ANTES de la finalización, para que el rollback pueda
  -- restaurarlo. La activación no lo capturó porque tampoco lo modificaba.
  ADD COLUMN IF NOT EXISTS prev_expires_at               timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS arca_credential_rotations_finalization_idem
  ON private.arca_credential_rotations (business_id, finalization_idempotency_key)
  WHERE finalization_idempotency_key IS NOT NULL;

-- ── 3. Evidencia DB de un WSAA exitoso POSTERIOR a la activación ────────────
-- Devuelve un veredicto jsonb sanitizado. Nunca token, sign ni XML.
--
-- SOBRE EL FINGERPRINT: el contrato productivo `public.arca_wsaa_audit` no
-- recibe fingerprint, así que los eventos `wsaa_private_key_resolved_vault`
-- existentes lo traen vacío. Cambiar eso exigiría redesplegar `afip-wsaa`, que
-- este lote tiene prohibido. La verificación NO se relaja: cuando el evento
-- trae fingerprint se compara literalmente, y cuando no lo trae se demuestra la
-- identidad de forma transitiva, que es igual de estricta:
--
--   · la credencial no cambió entre la activación y la evidencia
--     (updated_at = rotated_at = activated_at, y updated_at <= evidencia), y
--   · la credencial vigente tiene exactamente el fingerprint esperado, y
--   · no hubo rollback.
--
-- Bajo esas tres condiciones, la única clave que `afip-wsaa` pudo resolver
-- desde Vault en ese instante es la nueva. Ambas ramas comparan fingerprints;
-- ninguna acepta la evidencia "porque sí".
CREATE OR REPLACE FUNCTION private.arca_wsaa_verification_evidence(
  p_business_id uuid, p_activated_at timestamptz, p_expected_fp text)
RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE v_ev record; v_bad record; v_cred record;
BEGIN
  IF p_business_id IS NULL OR p_activated_at IS NULL OR coalesce(btrim(p_expected_fp),'') = '' THEN
    RETURN jsonb_build_object('ok', false, 'state', 'WSAA_VERIFICATION_NOT_FOUND');
  END IF;

  -- Cualquier resolución LEGACY o fallida posterior a la activación invalida la
  -- evidencia: significa que el camino de firma no quedó limpio sobre Vault.
  SELECT * INTO v_bad FROM private.arca_credential_audit a
    WHERE a.business_id = p_business_id
      AND a.created_at > p_activated_at
      AND a.event IN ('wsaa_private_key_resolved_legacy','wsaa_private_key_resolution_failed')
    ORDER BY a.created_at DESC LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', false, 'state', 'WSAA_VERIFICATION_STALE', 'reason', v_bad.event);
  END IF;

  SELECT * INTO v_ev FROM private.arca_credential_audit a
    WHERE a.business_id = p_business_id
      AND a.created_at > p_activated_at
      AND a.event = 'wsaa_private_key_resolved_vault'
    ORDER BY a.created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'state', 'WSAA_VERIFICATION_NOT_FOUND');
  END IF;
  IF v_ev.status IS DISTINCT FROM 'vault' THEN
    RETURN jsonb_build_object('ok', false, 'state', 'WSAA_VERIFICATION_STALE', 'reason', 'source');
  END IF;

  -- Rama A: el evento trae fingerprint → comparación literal.
  IF coalesce(btrim(coalesce(v_ev.fingerprint_trunc,'')),'') <> '' THEN
    IF v_ev.fingerprint_trunc IS DISTINCT FROM left(lower(btrim(p_expected_fp)),16) THEN
      RETURN jsonb_build_object('ok', false, 'state', 'WSAA_FINGERPRINT_MISMATCH');
    END IF;
    RETURN jsonb_build_object('ok', true, 'state', 'WSAA_VERIFIED',
      'verified_at', v_ev.created_at, 'proof', 'event_fingerprint');
  END IF;

  -- Rama B: prueba transitiva sobre la credencial vigente.
  SELECT * INTO v_cred FROM private.arca_private_key_credentials c WHERE c.business_id = p_business_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'state', 'ACTIVE_CREDENTIAL_MISMATCH');
  END IF;
  IF v_cred.private_key_fingerprint IS DISTINCT FROM lower(btrim(p_expected_fp)) THEN
    RETURN jsonb_build_object('ok', false, 'state', 'WSAA_FINGERPRINT_MISMATCH');
  END IF;
  IF v_cred.rotated_at IS DISTINCT FROM p_activated_at
     OR v_cred.updated_at IS DISTINCT FROM p_activated_at
     OR v_cred.updated_at > v_ev.created_at THEN
    RETURN jsonb_build_object('ok', false, 'state', 'WSAA_VERIFICATION_STALE', 'reason', 'credential_changed');
  END IF;

  RETURN jsonb_build_object('ok', true, 'state', 'WSAA_VERIFIED',
    'verified_at', v_ev.created_at, 'proof', 'credential_unchanged');
END $function$;

-- ── 4. RPC de FINALIZACIÓN (service_role-only) ──────────────────────────────
CREATE OR REPLACE FUNCTION public.arca_finalize_certificate_rotation(
  p_business_id uuid, p_rotation_ref uuid, p_expected_fingerprint text,
  p_idempotency_key text, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_rot record; v_cred record; v_cfg record; v_fp text; v_canon text; v_hash text;
  v_val jsonb; v_ev jsonb; v_not_after timestamptz; v_prev_expires timestamptz;
  v_rb_state text; v_rb_expires timestamptz; v_details jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'solo service_role' USING ERRCODE = '42501';
  END IF;
  IF p_business_id IS NULL OR coalesce(btrim(p_idempotency_key),'') = ''
     OR coalesce(btrim(p_expected_fingerprint),'') = '' THEN
    RAISE EXCEPTION 'parámetros requeridos faltantes' USING ERRCODE = '22023';
  END IF;
  v_fp := lower(btrim(p_expected_fingerprint));
  IF v_fp !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'fingerprint mal formado' USING ERRCODE = '22023';
  END IF;
  IF p_actor IS NULL OR NOT public.is_business_owner_or_admin(p_business_id, p_actor) THEN
    PERFORM private.arca_audit('arca_certificate_rotation_finalization_failed', p_business_id, p_actor, NULL, NULL, 'UNAUTHORIZED', 'UNAUTHORIZED');
    RETURN jsonb_build_object('ok', false, 'state', 'UNAUTHORIZED');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('arca_rotation:' || p_business_id::text));

  -- ── Replay por idempotency key (antes de tocar nada) ──
  SELECT * INTO v_rot FROM private.arca_credential_rotations r
    WHERE r.business_id = p_business_id AND r.finalization_idempotency_key = p_idempotency_key;
  IF FOUND THEN
    v_canon := 'arca_finalize_certificate_rotation|' || p_business_id::text || '|' || v_rot.id::text || '|' || v_fp;
    v_hash  := encode(extensions.digest(v_canon, 'sha256'), 'hex');
    IF v_rot.finalization_request_hash IS DISTINCT FROM v_hash THEN
      PERFORM private.arca_audit('arca_certificate_rotation_finalization_failed', p_business_id, p_actor, NULL, NULL, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
      RETURN jsonb_build_object('ok', false, 'state', 'IDEMPOTENCY_CONFLICT');
    END IF;
    PERFORM private.arca_audit('arca_certificate_rotation_finalization_replayed', p_business_id, p_actor, NULL,
      left(v_rot.private_key_fingerprint,16), 'replayed', NULL);
    RETURN jsonb_build_object('ok', true, 'state', 'ROTATION_ALREADY_COMPLETED',
      'rotation_ref', left(v_rot.id::text,8),
      'previous_state', 'activated_pending_verification', 'current_state', v_rot.state,
      'active_fingerprint_trunc', left(v_rot.private_key_fingerprint,16),
      'expires_at', v_rot.certificate_not_after,
      'wsaa_verified_at', v_rot.wsaa_verified_at,
      'rollback_available', (v_rot.prev_secret_id IS NOT NULL
                             AND EXISTS (SELECT 1 FROM vault.secrets s WHERE s.id = v_rot.prev_secret_id)));
  END IF;

  -- ── 1. Localizar la rotación ──
  SELECT * INTO v_rot FROM private.arca_credential_rotations r
    WHERE r.business_id = p_business_id
      AND (p_rotation_ref IS NULL OR r.id = p_rotation_ref)
      AND r.state IN ('activated_pending_verification','completed')
    ORDER BY r.activated_at DESC NULLS LAST LIMIT 1
    FOR UPDATE;
  IF NOT FOUND THEN
    -- ¿existe pero en otro estado? entonces el problema es el estado, no la rotación
    IF EXISTS (SELECT 1 FROM private.arca_credential_rotations
                WHERE business_id = p_business_id AND (p_rotation_ref IS NULL OR id = p_rotation_ref)) THEN
      RETURN jsonb_build_object('ok', false, 'state', 'ROTATION_STATE_INVALID');
    END IF;
    RETURN jsonb_build_object('ok', false, 'state', 'ROTATION_NOT_FOUND');
  END IF;

  -- Ya completada con OTRA key: no se duplica la transición ni el evento terminal.
  IF v_rot.state = 'completed' THEN
    RETURN jsonb_build_object('ok', true, 'state', 'ROTATION_ALREADY_COMPLETED',
      'rotation_ref', left(v_rot.id::text,8),
      'previous_state', 'activated_pending_verification', 'current_state', 'completed',
      'active_fingerprint_trunc', left(v_rot.private_key_fingerprint,16),
      'expires_at', v_rot.certificate_not_after,
      'wsaa_verified_at', v_rot.wsaa_verified_at,
      'rollback_available', (v_rot.prev_secret_id IS NOT NULL
                             AND EXISTS (SELECT 1 FROM vault.secrets s WHERE s.id = v_rot.prev_secret_id)));
  END IF;

  -- ── 2. La rotación tiene que estar efectivamente activada ──
  IF v_rot.activated_at IS NULL OR v_rot.rolled_back_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'state', 'ROTATION_NOT_VERIFIED');
  END IF;

  PERFORM private.arca_audit('arca_certificate_rotation_finalization_started', p_business_id, p_actor, NULL,
    left(v_rot.private_key_fingerprint,16), 'started', NULL);

  -- ── 3./4. Credencial activa única y con el fingerprint esperado ──
  SELECT * INTO v_cred FROM private.arca_private_key_credentials c
    WHERE c.business_id = p_business_id FOR UPDATE;
  IF NOT FOUND OR v_cred.credential_status <> 'active'
     OR (SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id = p_business_id) <> 1 THEN
    RETURN private.arca_finalize_fail(p_business_id, p_actor, v_rot.private_key_fingerprint, 'ACTIVE_CREDENTIAL_MISMATCH');
  END IF;
  IF v_cred.private_key_fingerprint IS DISTINCT FROM v_fp
     OR v_rot.private_key_fingerprint IS DISTINCT FROM v_fp THEN
    RETURN private.arca_finalize_fail(p_business_id, p_actor, v_rot.private_key_fingerprint, 'ACTIVE_CREDENTIAL_MISMATCH');
  END IF;

  SELECT * INTO v_cfg FROM public.arca_config WHERE business_id = p_business_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN private.arca_finalize_fail(p_business_id, p_actor, v_fp, 'ACTIVE_CREDENTIAL_MISMATCH');
  END IF;

  -- ── 5./6./7. cert_file corresponde a la clave activa, subject autorizado, vigente ──
  v_val := private.arca_validate_rotation_certificate(v_cfg.cert_file, v_fp, v_rot.subject, NULL);
  IF (v_val ->> 'ok') IS DISTINCT FROM 'true' THEN
    RETURN private.arca_finalize_fail(p_business_id, p_actor, v_fp,
      CASE WHEN (v_val ->> 'state') = 'CERTIFICATE_EXPIRED' THEN 'CERTIFICATE_EXPIRED'
           ELSE 'ACTIVE_CERTIFICATE_MISMATCH' END);
  END IF;
  v_not_after := (v_val ->> 'not_after')::timestamptz;
  IF v_not_after IS NULL THEN
    RETURN private.arca_finalize_fail(p_business_id, p_actor, v_fp, 'ACTIVE_CERTIFICATE_MISMATCH');
  END IF;

  -- ── 8. Checkpoint anterior presente ──
  IF v_rot.prev_secret_id IS NULL OR v_rot.prev_fingerprint IS NULL OR v_rot.prev_certificate_pem IS NULL THEN
    RETURN private.arca_finalize_fail(p_business_id, p_actor, v_fp, 'PREVIOUS_CHECKPOINT_MISSING');
  END IF;
  -- ── 9. Secreto anterior vivo en Vault ──
  IF NOT EXISTS (SELECT 1 FROM vault.secrets s WHERE s.id = v_rot.prev_secret_id) THEN
    RETURN private.arca_finalize_fail(p_business_id, p_actor, v_fp, 'PREVIOUS_SECRET_MISSING');
  END IF;
  -- ── 10. Secreto activo nuevo vivo en Vault ──
  IF v_cred.private_key_secret_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM vault.secrets s WHERE s.id = v_cred.private_key_secret_id) THEN
    RETURN private.arca_finalize_fail(p_business_id, p_actor, v_fp, 'ACTIVE_SECRET_MISSING');
  END IF;
  -- ── 11. Ninguna referencia AFIP apunta a un secreto inexistente ──
  IF EXISTS (
      SELECT 1 FROM (
        SELECT c.private_key_secret_id AS sid FROM private.arca_private_key_credentials c WHERE c.business_id = p_business_id
        UNION ALL
        SELECT r.private_key_secret_id FROM private.arca_credential_rotations r WHERE r.business_id = p_business_id
        UNION ALL
        SELECT r.prev_secret_id FROM private.arca_credential_rotations r WHERE r.business_id = p_business_id
      ) q
      WHERE q.sid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vault.secrets s WHERE s.id = q.sid)) THEN
    RETURN private.arca_finalize_fail(p_business_id, p_actor, v_fp, 'ORPHAN_SECRET_DETECTED');
  END IF;

  -- ── 12. Evidencia DB de WSAA exitoso posterior a la activación ──
  v_ev := private.arca_wsaa_verification_evidence(p_business_id, v_rot.activated_at, v_fp);
  IF (v_ev ->> 'ok') IS DISTINCT FROM 'true' THEN
    RETURN private.arca_finalize_fail(p_business_id, p_actor, v_fp, v_ev ->> 'state');
  END IF;

  -- ── 13. El cache WSAA quedó efectivamente poblado y vigente ──
  IF v_cfg.wsaa_token IS NULL OR btrim(v_cfg.wsaa_token) = ''
     OR v_cfg.wsaa_sign IS NULL OR btrim(v_cfg.wsaa_sign) = ''
     OR v_cfg.wsaa_token_expires IS NULL OR v_cfg.wsaa_token_expires <= now()
     OR v_cfg.estado_conexion IS DISTINCT FROM 'conectado'
     OR coalesce(btrim(coalesce(v_cfg.ultimo_error,'')),'') <> '' THEN
    RETURN private.arca_finalize_fail(p_business_id, p_actor, v_fp, 'ROTATION_NOT_VERIFIED');
  END IF;

  v_canon := 'arca_finalize_certificate_rotation|' || p_business_id::text || '|' || v_rot.id::text || '|' || v_fp;
  v_hash  := encode(extensions.digest(v_canon, 'sha256'), 'hex');
  v_prev_expires := v_cfg.expires_at;

  -- ── ESCRITURA ATÓMICA (savepoint): expires_at → estado → readback ──────────
  BEGIN
    -- expires_at derivado del X.509 activo, NUNCA de un valor enviado por cliente.
    UPDATE public.arca_config SET expires_at = v_not_after, updated_at = now()
      WHERE business_id = p_business_id;

    UPDATE private.arca_credential_rotations SET
      state                        = 'completed',
      finalized_at                 = now(),
      finalized_by                 = p_actor,
      finalization_idempotency_key = p_idempotency_key,
      finalization_request_hash    = v_hash,
      wsaa_verified_at             = (v_ev ->> 'verified_at')::timestamptz,
      certificate_not_after        = v_not_after,
      prev_expires_at              = v_prev_expires,
      updated_at                   = now()
    WHERE id = v_rot.id;

    -- readback: estado, vencimiento y par activo intactos
    SELECT r.state, c.expires_at INTO v_rb_state, v_rb_expires
      FROM private.arca_credential_rotations r, public.arca_config c
      WHERE r.id = v_rot.id AND c.business_id = p_business_id;
    IF v_rb_state IS DISTINCT FROM 'completed' OR v_rb_expires IS DISTINCT FROM v_not_after THEN
      RAISE EXCEPTION 'finalize_readback_mismatch';
    END IF;
    IF (SELECT c.private_key_fingerprint FROM private.arca_private_key_credentials c
         WHERE c.business_id = p_business_id) IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'finalize_credential_drift';
    END IF;
    IF (SELECT c.cert_file FROM public.arca_config c WHERE c.business_id = p_business_id)
       IS DISTINCT FROM v_cfg.cert_file THEN
      RAISE EXCEPTION 'finalize_certificate_drift';
    END IF;
  EXCEPTION WHEN others THEN
    RETURN private.arca_finalize_fail(p_business_id, p_actor, v_fp, 'ROTATION_NOT_VERIFIED');
  END;

  v_details := jsonb_build_object(
    'rotation_ref', left(v_rot.id::text,8),
    'previous_state', 'activated_pending_verification',
    'current_state', 'completed',
    'fingerprint_trunc', left(v_fp,16),
    'activated_at', v_rot.activated_at,
    'wsaa_verified_at', (v_ev ->> 'verified_at')::timestamptz,
    'wsaa_proof', v_ev ->> 'proof',
    'certificate_not_after', v_not_after,
    'previous_expires_at', v_prev_expires,
    'idempotency_ref', left(p_idempotency_key,12));

  PERFORM private.arca_audit('arca_certificate_rotation_completed', p_business_id, p_actor, NULL,
    left(v_fp,16), 'ROTATION_COMPLETED', NULL);
  UPDATE private.arca_credential_audit SET details = v_details
    WHERE id = (SELECT id FROM private.arca_credential_audit
                 WHERE business_id = p_business_id AND event = 'arca_certificate_rotation_completed'
                 ORDER BY created_at DESC LIMIT 1);

  RETURN jsonb_build_object('ok', true, 'state', 'ROTATION_COMPLETED',
    'rotation_ref', left(v_rot.id::text,8),
    'previous_state', 'activated_pending_verification',
    'current_state', 'completed',
    'active_fingerprint_trunc', left(v_fp,16),
    'expires_at', v_not_after,
    'previous_expires_at', v_prev_expires,
    'wsaa_verified_at', (v_ev ->> 'verified_at')::timestamptz,
    'rollback_available', true);
END $function$;

-- Helper de fallo: audita y devuelve el estado sanitizado, sin filtrar SQL.
CREATE OR REPLACE FUNCTION private.arca_finalize_fail(
  p_business_id uuid, p_actor uuid, p_fp text, p_state text)
RETURNS jsonb LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  PERFORM private.arca_audit('arca_certificate_rotation_finalization_failed', p_business_id, p_actor, NULL,
    left(coalesce(p_fp,''),16), p_state, p_state);
  RETURN jsonb_build_object('ok', false, 'state', p_state);
END $function$;

-- ── 5. ROLLBACK extendido: también desde `completed`, hasta S4C ─────────────
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

  -- AFIP-S4B-2C: `completed` se suma a los estados revertibles. Revertir tiene
  -- que seguir siendo posible hasta que S4C limpie el material anterior.
  SELECT * INTO v_rot FROM private.arca_credential_rotations r
    WHERE r.business_id = p_business_id
      AND (p_rotation_ref IS NULL OR r.id = p_rotation_ref)
      AND r.state IN ('activated_pending_verification','completed','rolled_back')
    ORDER BY r.activated_at DESC NULLS LAST LIMIT 1
    FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'state', 'ROTATION_NOT_FOUND'); END IF;

  IF v_rot.state = 'rolled_back' THEN
    RETURN jsonb_build_object('ok', true, 'state', 'ROLLBACK_ALREADY_APPLIED',
      'rotation_ref', left(v_rot.id::text,8),
      'restored_fingerprint_trunc', left(coalesce(v_rot.prev_fingerprint,''),16));
  END IF;
  IF v_rot.prev_secret_id IS NULL OR v_rot.prev_fingerprint IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'state', 'PREVIOUS_CHECKPOINT_MISSING');
  END IF;
  -- Gate de S4C: si el secreto anterior ya fue purgado, revertir es imposible y
  -- se rechaza fail-closed en vez de dejar la credencial apuntando a la nada.
  IF NOT EXISTS (SELECT 1 FROM vault.secrets s WHERE s.id = v_rot.prev_secret_id) THEN
    PERFORM private.arca_audit('arca_certificate_rotation_rollback_failed', p_business_id, p_actor, NULL,
      left(v_rot.prev_fingerprint,16), 'PREVIOUS_SECRET_MISSING', 'PREVIOUS_SECRET_MISSING');
    RETURN jsonb_build_object('ok', false, 'state', 'PREVIOUS_SECRET_MISSING');
  END IF;

  PERFORM private.arca_audit('arca_certificate_rotation_rollback_started', p_business_id, p_actor, NULL,
    left(v_rot.prev_fingerprint,16), 'started', NULL);

  BEGIN
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
      -- AFIP-S4B-2C: si la finalización ya había corregido el vencimiento, se
      -- restaura el anterior junto con el certificado anterior.
      expires_at         = coalesce(v_rot.prev_expires_at, expires_at),
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

-- ── 6. Grants: la finalización es service_role-only ─────────────────────────
REVOKE ALL ON FUNCTION public.arca_finalize_certificate_rotation(uuid,uuid,text,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.arca_finalize_certificate_rotation(uuid,uuid,text,text,uuid) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.arca_finalize_certificate_rotation(uuid,uuid,text,text,uuid) TO service_role;

REVOKE ALL ON FUNCTION public.arca_rollback_certificate_rotation(uuid,uuid,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.arca_rollback_certificate_rotation(uuid,uuid,text,uuid) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.arca_rollback_certificate_rotation(uuid,uuid,text,uuid) TO service_role;

COMMENT ON FUNCTION public.arca_finalize_certificate_rotation(uuid,uuid,text,text,uuid) IS
  'AFIP-S4B-2C: cierra una rotación activada y verificada (activated_pending_verification -> completed). Exige evidencia DB de un WSAA exitoso posterior a la activación resuelto desde Vault, revalida el par activo contra el X.509 y actualiza expires_at con el notAfter real. service_role-only, idempotente. No recibe ni devuelve certificado, clave, secret_id ni token. No invoca WSAA.';
COMMENT ON FUNCTION private.arca_wsaa_verification_evidence(uuid, timestamptz, text) IS
  'AFIP-S4B-2C: verifica en la auditoría que hubo una resolución de clave desde Vault posterior a la activación, sin resoluciones legacy ni fallidas, y que corresponde al fingerprint esperado (por fingerprint del evento o por prueba transitiva sobre la credencial).';

DO $$ BEGIN RAISE NOTICE 'AFIP-S4B-2C: finalización auditada lista; rollback disponible también desde completed.'; END $$;
