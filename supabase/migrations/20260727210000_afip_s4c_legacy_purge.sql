-- ============================================================================
-- AFIP-S4C — Purga definitiva del material legacy en claro
--
-- Cierra el incidente que abrió toda la cadena AFIP-S1..S4B: la clave privada
-- fiscal vivía en claro en `public.arca_config.private_key`, legible por
-- cualquier usuario autenticado del mismo negocio.
--
-- Esta migración es IRREVERSIBLE por diseño. En orden:
--   1. verifica que ningún negocio quede sin poder firmar (fail-closed);
--   2. `get_arca_config_safe` deriva la presencia de clave desde Vault;
--   3. retira la RPC de migración legacy→Vault, que ya no tiene sentido;
--   4. ELIMINA la columna `arca_config.private_key` (y con ella el plaintext);
--   5. purga de Vault el secreto anterior de cada rotación ya `completed`;
--   6. cierra el checkpoint conservando la historia auditada;
--   7. deja el rollback deliberadamente deshabilitado.
--
-- El fallback legacy de `afip-wsaa` YA fue retirado y desplegado antes de esta
-- migración: la firma resuelve exclusivamente desde Vault. Ese orden importa —
-- primero se corta el consumo, después se destruye el material.
--
-- Lo que se CONSERVA: la credencial activa en Vault, el certificado público, el
-- cache WSAA, y toda la trazabilidad de la rotación (fingerprints truncados,
-- estados, timestamps, evidencia). Sólo desaparece el material recuperable.
-- ============================================================================

-- ── 0. Precondición fail-closed ─────────────────────────────────────────────
-- Ningún negocio puede quedar sin clave: si alguno todavía depende del
-- plaintext y no tiene credencial activa en Vault, la migración ABORTA.
DO $precheck$
DECLARE v_huerfanos int; v_rot_incompleta int;
BEGIN
  SELECT count(*) INTO v_huerfanos
  FROM public.arca_config c
  WHERE c.private_key IS NOT NULL AND btrim(c.private_key) <> ''
    AND c.pfx_file IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM private.arca_private_key_credentials k
      WHERE k.business_id = c.business_id AND k.credential_status = 'active'
        AND EXISTS (SELECT 1 FROM vault.secrets s WHERE s.id = k.private_key_secret_id));
  IF v_huerfanos > 0 THEN
    RAISE EXCEPTION 'AFIP-S4C ABORTA: % negocio(s) dependen de la clave en claro y no tienen credencial activa en Vault', v_huerfanos;
  END IF;

  -- Purgar el material anterior de una rotación a medio camino dejaría al
  -- negocio sin rollback justo cuando más lo necesita.
  SELECT count(*) INTO v_rot_incompleta FROM private.arca_credential_rotations
   WHERE state IN ('pending_rotation','activated_pending_verification');
  IF v_rot_incompleta > 0 THEN
    RAISE EXCEPTION 'AFIP-S4C ABORTA: % rotación(es) sin finalizar; purgar ahora dejaría al negocio sin rollback', v_rot_incompleta;
  END IF;
END $precheck$;

-- ── 1. Eventos de auditoría de la purga ─────────────────────────────────────
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
  'arca_certificate_rotation_finalization_started','arca_certificate_rotation_completed',
  'arca_certificate_rotation_finalization_failed','arca_certificate_rotation_finalization_replayed',
  -- AFIP-S4C
  'arca_legacy_private_key_purged','arca_previous_secret_purged','arca_rollback_disabled'));

-- ── 2. Presencia de clave: derivada de Vault, no de la columna ──────────────
CREATE OR REPLACE FUNCTION public.get_arca_config_safe(p_business_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE v_row public.arca_config%ROWTYPE; v_has_key boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NULL;                                   -- anon denegado (fail-closed)
  END IF;
  -- Autorización interna: mismo contrato que la policy arca_config_plan_read
  -- (membresía activa en el negocio + feature 'arca'). No acepta un business_id
  -- ajeno: si no pertenece al usuario, devuelve NULL.
  IF p_business_id IS NULL
     OR p_business_id NOT IN (SELECT public.user_business_ids())
     OR NOT public.business_has_feature('arca') THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_row FROM public.arca_config WHERE business_id = p_business_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('business_id', p_business_id, 'configured', false);
  END IF;

  -- AFIP-S4C: la clave ya no vive en la tabla. La presencia se deriva de la
  -- credencial activa en Vault (o del PFX, que lleva su clave adentro).
  v_has_key := EXISTS (
      SELECT 1 FROM private.arca_private_key_credentials k
      WHERE k.business_id = p_business_id AND k.credential_status = 'active'
        AND EXISTS (SELECT 1 FROM vault.secrets s WHERE s.id = k.private_key_secret_id))
    OR (v_row.pfx_file IS NOT NULL AND btrim(v_row.pfx_file) <> '');

  RETURN jsonb_build_object(
    'business_id',              v_row.business_id,
    'configured',              true,
    'ambiente',                v_row.ambiente,
    'punto_venta',             v_row.punto_venta,
    'web_service',             v_row.web_service,
    'cuit_emisor',             v_row.cuit_emisor,
    'cuit',                    v_row.cuit,
    'razon_social',            v_row.razon_social,
    'alias',                   v_row.alias,
    'estado_conexion',         v_row.estado_conexion,
    'expires_at',              v_row.expires_at,
    'ultima_sincronizacion',   v_row.ultima_sincronizacion,
    'ultimo_error',            v_row.ultimo_error,
    'created_at',              v_row.created_at,
    'updated_at',              v_row.updated_at,
    -- indicadores booleanos: presencia, nunca el contenido
    'has_certificate',         (v_row.cert_file IS NOT NULL AND btrim(v_row.cert_file) <> '')
                               OR (v_row.pfx_file IS NOT NULL AND btrim(v_row.pfx_file) <> ''),
    'has_private_key_configured', v_has_key,
    'wsaa_token_valid',        (v_row.wsaa_token IS NOT NULL AND v_row.wsaa_token_expires IS NOT NULL
                                AND v_row.wsaa_token_expires > now())
  );
END; $function$;

-- ── 3. Purga del material recuperable, ANTES de perder la referencia ─────────
-- Se ejecuta sólo sobre rotaciones ya `completed`: su par anterior cumplió su
-- función y el rollback deja de tener sentido. El secreto de Vault se borra y el
-- checkpoint se cierra conservando fingerprints, estados y timestamps.
DO $purge$
DECLARE r record; v_borrados int := 0;
BEGIN
  FOR r IN
    SELECT id, business_id, prev_secret_id, prev_fingerprint
    FROM private.arca_credential_rotations
    WHERE state = 'completed' AND prev_secret_id IS NOT NULL
  LOOP
    DELETE FROM vault.secrets WHERE id = r.prev_secret_id;
    v_borrados := v_borrados + 1;

    UPDATE private.arca_credential_rotations SET
      prev_secret_id          = NULL,   -- ya no hay a qué apuntar
      prev_certificate_pem    = NULL,
      prev_wsaa_token         = NULL,
      prev_wsaa_sign          = NULL,
      prev_status             = 'purged',
      updated_at              = now()
    WHERE id = r.id;
    -- Se conservan a propósito: prev_fingerprint, prev_wsaa_token_expires,
    -- prev_estado_conexion, prev_expires_at, activated_at, finalized_at y toda
    -- la evidencia de la rotación. La historia sobrevive; el material no.

    PERFORM private.arca_audit('arca_previous_secret_purged', r.business_id, NULL, NULL,
      left(coalesce(r.prev_fingerprint,''),16), 'PURGED', NULL);
    PERFORM private.arca_audit('arca_rollback_disabled', r.business_id, NULL, NULL,
      left(coalesce(r.prev_fingerprint,''),16), 'ROLLBACK_PERMANENTLY_DISABLED', NULL);
  END LOOP;
  RAISE NOTICE 'AFIP-S4C: % secreto(s) anterior(es) purgado(s) de Vault', v_borrados;
END $purge$;

-- ── 4. Auditoría de la purga del plaintext, antes de que desaparezca ────────
DO $audit_legacy$
DECLARE r record; v_n int := 0;
BEGIN
  FOR r IN SELECT business_id, private_key FROM public.arca_config
            WHERE private_key IS NOT NULL AND btrim(private_key) <> ''
  LOOP
    PERFORM private.arca_audit('arca_legacy_private_key_purged', r.business_id, NULL, NULL,
      left(coalesce(private.arca_key_fingerprint(r.private_key),''),16), 'PURGED', NULL);
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'AFIP-S4C: % clave(s) en claro auditada(s) antes de eliminarlas', v_n;
END $audit_legacy$;

-- ── 5. Retiro de la RPC de migración legacy→Vault ───────────────────────────
-- Su único propósito era leer `arca_config.private_key`. Sin esa columna no
-- tiene nada que migrar. Queda como stub fail-closed en vez de desaparecer, para
-- que una llamada vieja reciba un estado explícito y no un 404 ambiguo.
CREATE OR REPLACE FUNCTION public.arca_migrate_legacy_private_key_to_vault(
  p_business_id uuid, p_expected_fingerprint text, p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  -- AFIP-S4C: no queda material legacy que migrar. La provisión de credenciales
  -- nuevas pasa por public.arca_store_credential / el Edge arca-credentials.
  RETURN jsonb_build_object('ok', false, 'state', 'LEGACY_MIGRATION_RETIRED',
    'info', 'La clave en claro fue eliminada en AFIP-S4C. Usá el contrato de provisión seguro.');
END $function$;

REVOKE ALL ON FUNCTION public.arca_migrate_legacy_private_key_to_vault(uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.arca_migrate_legacy_private_key_to_vault(uuid,text,text) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.arca_migrate_legacy_private_key_to_vault(uuid,text,text) TO service_role;

-- ── 6. ELIMINACIÓN de la columna legacy ─────────────────────────────────────
-- Punto de no retorno: el plaintext deja de existir y ninguna fila futura puede
-- volver a guardarlo. Los grants de columna (que todavía daban INSERT/UPDATE a
-- anon y authenticated) desaparecen con ella.
ALTER TABLE public.arca_config DROP COLUMN IF EXISTS private_key;

-- ── 7. Rollback deliberadamente deshabilitado ───────────────────────────────
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
      AND r.state IN ('activated_pending_verification','completed','rolled_back')
    ORDER BY r.activated_at DESC NULLS LAST LIMIT 1
    FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'state', 'ROTATION_NOT_FOUND'); END IF;

  IF v_rot.state = 'rolled_back' THEN
    RETURN jsonb_build_object('ok', true, 'state', 'ROLLBACK_ALREADY_APPLIED',
      'rotation_ref', left(v_rot.id::text,8),
      'restored_fingerprint_trunc', left(coalesce(v_rot.prev_fingerprint,''),16));
  END IF;

  -- AFIP-S4C: si el material anterior fue purgado, el rollback está cerrado de
  -- forma permanente y se dice explícitamente, en vez de fallar por "falta un
  -- checkpoint" como si fuera un accidente.
  IF v_rot.prev_status = 'purged' THEN
    RETURN jsonb_build_object('ok', false, 'state', 'ROLLBACK_PERMANENTLY_DISABLED',
      'rotation_ref', left(v_rot.id::text,8),
      'info', 'El par anterior fue purgado en AFIP-S4C. Para volver atrás hay que emitir una credencial nueva.');
  END IF;

  IF v_rot.prev_secret_id IS NULL OR v_rot.prev_fingerprint IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'state', 'PREVIOUS_CHECKPOINT_MISSING');
  END IF;
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

REVOKE ALL ON FUNCTION public.arca_rollback_certificate_rotation(uuid,uuid,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.arca_rollback_certificate_rotation(uuid,uuid,text,uuid) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.arca_rollback_certificate_rotation(uuid,uuid,text,uuid) TO service_role;

-- ── 8. Post-condiciones: la purga tiene que haber quedado completa ──────────
DO $post$
DECLARE v_col int; v_secretos_prev int; v_pendientes int;
BEGIN
  SELECT count(*) INTO v_col FROM information_schema.columns
   WHERE table_schema='public' AND table_name='arca_config' AND column_name='private_key';
  IF v_col <> 0 THEN RAISE EXCEPTION 'AFIP-S4C: la columna private_key sigue existiendo'; END IF;

  SELECT count(*) INTO v_secretos_prev FROM private.arca_credential_rotations
   WHERE state = 'completed' AND prev_secret_id IS NOT NULL;
  IF v_secretos_prev <> 0 THEN RAISE EXCEPTION 'AFIP-S4C: quedaron checkpoints sin cerrar'; END IF;

  SELECT count(*) INTO v_pendientes FROM (
      SELECT k.private_key_secret_id AS sid FROM private.arca_private_key_credentials k
      UNION ALL SELECT r.private_key_secret_id FROM private.arca_credential_rotations r
      UNION ALL SELECT r.prev_secret_id FROM private.arca_credential_rotations r) q
   WHERE q.sid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vault.secrets s WHERE s.id = q.sid);
  IF v_pendientes <> 0 THEN RAISE EXCEPTION 'AFIP-S4C: quedaron % referencias a secretos inexistentes', v_pendientes; END IF;
END $post$;

COMMENT ON FUNCTION public.arca_migrate_legacy_private_key_to_vault(uuid,text,text) IS
  'AFIP-S4C: RETIRADA. La clave en claro fue eliminada; no queda material legacy que migrar. Devuelve LEGACY_MIGRATION_RETIRED.';
COMMENT ON FUNCTION public.arca_rollback_certificate_rotation(uuid,uuid,text,uuid) IS
  'AFIP-S4C: el rollback queda PERMANENTEMENTE deshabilitado para las rotaciones cuyo par anterior fue purgado (prev_status=purged). Para volver atrás hay que emitir una credencial nueva.';

DO $$ BEGIN RAISE NOTICE 'AFIP-S4C: material legacy purgado; la firma fiscal resuelve exclusivamente desde Vault.'; END $$;
