-- ============================================================================
-- ARCA SELF-SERVICE · PHASE 2A — rollback (manual, transaccional)
--
-- GENERADO por extracción byte a byte de las definiciones previas:
--   private.arca_selfservice_status        ← 20260929120000_arca_selfservice_phase1_status_read_model.sql
--   public.save_arca_config_legacy         ← 20260928120000_arca_selfservice_phase0_hardening.sql
--   public.arca_cancel_certificate_rotation ← 20260724120000_afip_s4a_certificate_rotation_prepare.sql
--
-- Orden recomendado (ver README):
--   1. frontend anterior (Phase 2B no desplegada todavía: nada que revertir en 2A);
--   2. borrar/retirar la Edge Function arca-selfservice-setup (deja de haber entrada);
--   3. este script (aborta si hay una configuración inicial VIVA: cancelarla primero);
--   4. supabase migration repair --status reverted 20260930120000.
--
-- Lo que CONSERVA a propósito (aditivo, sin pérdida de historia):
--   · columnas nuevas de private.arca_credential_rotations y sus datos (incluidas las esperas de
--     verificación de filas canceladas: sin las RPC del flujo inicial no hay quién emita un LoginCms);
--   · eventos de auditoría ya escritos (el CHECK ampliado se mantiene: achicarlo rompería filas);
--   · credenciales activadas por el flujo inicial: son credenciales normales que afip-wsaa usa;
--   · private_key_secret_id nullable si alguna fila cancelada ya lo tiene en NULL.
-- ============================================================================
BEGIN;

DO $pre$
BEGIN
  IF EXISTS (SELECT 1 FROM private.arca_credential_rotations
              WHERE setup_kind = 'initial' AND state = 'pending_rotation') THEN
    RAISE EXCEPTION 'rollback Phase 2A abortado: hay configuraciones iniciales vivas; cancelarlas primero (arca_selfservice_cancel)';
  END IF;
END
$pre$;

-- ── 1. Entradas del flujo inicial ───────────────────────────────────────────
DROP FUNCTION IF EXISTS public.arca_selfservice_prepare_initial(uuid,uuid,text,text,text,text,integer,text,text,text,text);
DROP FUNCTION IF EXISTS public.arca_selfservice_get_csr(uuid,uuid);
DROP FUNCTION IF EXISTS public.arca_selfservice_attach_certificate(uuid,uuid,text);
DROP FUNCTION IF EXISTS public.arca_selfservice_verification_material(uuid,uuid,uuid);
DROP FUNCTION IF EXISTS public.arca_selfservice_verification_material(uuid,uuid);
DROP FUNCTION IF EXISTS public.arca_selfservice_record_verification(uuid,uuid,text,text,text,text,timestamptz);
DROP FUNCTION IF EXISTS public.arca_selfservice_record_verification_failure(uuid,uuid,uuid,text,timestamptz);
DROP FUNCTION IF EXISTS public.arca_selfservice_record_verification_failure(uuid,uuid,text);
DROP FUNCTION IF EXISTS public.arca_selfservice_activate(uuid,uuid,text,text,text);
DROP FUNCTION IF EXISTS public.arca_selfservice_cancel(uuid,uuid);

DROP FUNCTION IF EXISTS private.arca_selfservice_reject(text,uuid,uuid,text,text);
DROP FUNCTION IF EXISTS private.arca_selfservice_is_configured(uuid);
DROP FUNCTION IF EXISTS private.arca_selfservice_validate_certificate(text,text,jsonb);
DROP FUNCTION IF EXISTS private.arca_der_to_certificate_pem(bytea);
DROP FUNCTION IF EXISTS private.arca_selfservice_issuer_ok(jsonb,text);
DROP FUNCTION IF EXISTS private.arca_cert_issuer(bytea);
DROP FUNCTION IF EXISTS private.arca_cuit_is_valid(text);
DROP FUNCTION IF EXISTS private.arca_selfservice_verification_hold(uuid,timestamptz);
DROP FUNCTION IF EXISTS private.arca_selfservice_hold_view(text,timestamptz,timestamptz,boolean,timestamptz);

-- ── 2. Definiciones previas (extraídas) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION private.arca_selfservice_status(
  p_business_id uuid,
  p_actor       uuid,
  p_now         timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_cfg            record;
  v_cfg_found      boolean;
  v_cred           record;
  v_cred_found     boolean;
  v_rot            record;
  v_rot_found      boolean;

  v_cert_present   boolean := false;
  v_pfx_present    boolean := false;
  v_der            bytea;
  v_not_after      timestamptz;
  v_cert_fp        text;
  v_cred_active    boolean := false;
  v_pair_matches   boolean := false;
  v_configured     boolean := false;

  v_renewal        text;
  v_days           integer;
  v_conn_state     text := 'unknown';
  v_conn_at        timestamptz;
  v_cred_since     timestamptz;

  v_setup_state    text := 'not_started';
  v_setup_kind     text;
  v_setup_step     text;
  v_setup_since    timestamptz;

  v_attention      text[] := '{}';
  v_status         text;
  v_next           text;
  v_can_manage     boolean;
  v_cuit           text;
BEGIN
  IF p_business_id IS NULL OR p_now IS NULL THEN
    RAISE EXCEPTION 'ARCA_STATUS_INVALID_INPUT' USING ERRCODE = '22023';
  END IF;

  SELECT c.ambiente, c.cuit, c.razon_social, c.punto_venta, c.alias,
         c.cert_file, c.pfx_file, c.estado_conexion, c.ultima_sincronizacion
    INTO v_cfg
    FROM public.arca_config c
   WHERE c.business_id = p_business_id;
  v_cfg_found := FOUND;

  SELECT k.credential_status, k.private_key_fingerprint, k.rotated_at, k.created_at,
         EXISTS (SELECT 1 FROM vault.secrets s WHERE s.id = k.private_key_secret_id) AS secret_present
    INTO v_cred
    FROM private.arca_private_key_credentials k
   WHERE k.business_id = p_business_id;
  v_cred_found := FOUND;

  -- Sólo estados GENUINAMENTE en curso. completed/rolled_back/cancelled/failed/
  -- activation_failed son historia (p.ej. la fila productiva completed/purged).
  SELECT r.state, r.created_at
    INTO v_rot
    FROM private.arca_credential_rotations r
   WHERE r.business_id = p_business_id
     AND r.state IN ('pending_rotation', 'activated_pending_verification')
   ORDER BY (r.state = 'activated_pending_verification') DESC, r.created_at DESC
   LIMIT 1;
  v_rot_found := FOUND;

  -- ── Certificado y credencial (hechos) ──
  IF v_cfg_found THEN
    v_cert_present := coalesce(btrim(v_cfg.cert_file), '') <> '';
    v_pfx_present  := coalesce(btrim(v_cfg.pfx_file), '') <> '';
  END IF;

  IF v_cert_present THEN
    v_der := private.arca_pem_to_der(v_cfg.cert_file);
    IF v_der IS NOT NULL THEN
      v_not_after := (private.arca_cert_validity(v_der)).not_after;
      v_cert_fp := private.arca_rsa_public_key_fingerprint_sha256(
                     (private.arca_rsa_pubkey_from_cert(v_der)).n,
                     (private.arca_rsa_pubkey_from_cert(v_der)).e);
    END IF;
  END IF;

  v_cred_active := v_cred_found
               AND v_cred.credential_status = 'active'
               AND v_cred.secret_present IS TRUE;

  v_pair_matches := v_cred_active AND v_cert_fp IS NOT NULL
                AND v_cert_fp = lower(btrim(v_cred.private_key_fingerprint));

  v_configured := v_cfg_found AND v_cred_active AND v_cert_present;

  -- ── Vigencia ──
  IF NOT v_cert_present THEN
    v_renewal := 'not_configured';
  ELSIF v_not_after IS NULL THEN
    v_renewal := 'unknown';
  ELSIF v_not_after <= p_now THEN
    v_renewal := 'expired';
    v_days := 0;
  ELSE
    v_days := floor(extract(epoch FROM (v_not_after - p_now)) / 86400)::integer;
    v_renewal := CASE
      WHEN v_not_after - p_now <= interval '15 days' THEN 'urgent'
      WHEN v_not_after - p_now <= interval '60 days' THEN 'expiring'
      ELSE 'healthy'
    END;
  END IF;

  -- ── Conexión: sólo evidencia server-side acotada ──
  -- afip-wsaa escribe estado_conexion='conectado' + ultima_sincronizacion al
  -- obtener un token, y 'error' ante un error autorizado. Cualquier otro valor
  -- (texto libre, 'desconectado', 'activation_pending_wsaa_verification', NULL)
  -- es 'unknown'. Una evidencia —éxito O error— ANTERIOR a la puesta en uso de
  -- la credencial vigente habla de otra clave: no cuenta. Sin timestamp no hay
  -- evidencia fechable: tampoco cuenta.
  IF v_configured THEN
    v_cred_since := coalesce(v_cred.rotated_at, v_cred.created_at);
    IF v_cfg.estado_conexion IN ('conectado', 'error')
       AND v_cfg.ultima_sincronizacion IS NOT NULL
       AND (v_cred_since IS NULL OR v_cfg.ultima_sincronizacion >= v_cred_since) THEN
      v_conn_state := CASE v_cfg.estado_conexion WHEN 'conectado' THEN 'connected' ELSE 'error' END;
      v_conn_at := v_cfg.ultima_sincronizacion;
    END IF;
  END IF;

  -- ── Configuración en curso ──
  IF v_rot_found THEN
    v_setup_state := 'in_progress';
    v_setup_kind  := CASE WHEN v_cred_active THEN 'renewal' ELSE 'initial' END;
    v_setup_step  := CASE v_rot.state
                       WHEN 'pending_rotation' THEN 'certificate'
                       WHEN 'activated_pending_verification' THEN 'verification'
                     END;
    v_setup_since := v_rot.created_at;
  ELSIF v_configured THEN
    v_setup_state := 'completed';
  END IF;

  -- ── Motivos de atención (enum acotado) ──
  IF v_cert_present AND NOT v_cred_active THEN
    v_attention := v_attention || 'credential_missing'::text;
  END IF;
  IF v_cred_active AND NOT v_cert_present THEN
    v_attention := v_attention || 'certificate_missing'::text;
  END IF;
  IF v_pfx_present AND NOT v_cert_present THEN
    v_attention := v_attention || 'legacy_pfx'::text;
  END IF;
  IF v_cert_present AND v_not_after IS NULL THEN
    v_attention := v_attention || 'certificate_unreadable'::text;
  END IF;
  IF v_configured AND v_not_after IS NOT NULL AND NOT v_pair_matches THEN
    v_attention := v_attention || 'credential_certificate_mismatch'::text;
  END IF;
  IF v_renewal = 'expired' THEN
    v_attention := v_attention || 'certificate_expired'::text;
  END IF;
  IF v_conn_state = 'error' THEN
    v_attention := v_attention || 'connection_error'::text;
  END IF;

  -- ── Resumen ──
  IF cardinality(v_attention) > 0 THEN
    v_status := 'attention';
  ELSIF v_setup_state = 'in_progress' AND NOT v_configured THEN
    v_status := 'setup_in_progress';
  ELSIF NOT v_configured THEN
    v_status := 'not_configured';
  ELSIF v_setup_step = 'verification' OR v_conn_state <> 'connected' THEN
    v_status := 'pending_verification';
  ELSE
    v_status := 'connected';
  END IF;

  -- ── Próxima acción segura (qué necesita el negocio; la UI decide si la ofrece) ──
  v_next := CASE
    WHEN v_setup_state = 'in_progress'                                  THEN 'continue_setup'
    WHEN NOT v_configured                                               THEN 'start_setup'
    WHEN v_renewal IN ('expired', 'urgent', 'expiring', 'unknown')
      OR 'credential_certificate_mismatch' = ANY (v_attention)          THEN 'renew_certificate'
    WHEN v_conn_state <> 'connected'                                    THEN 'verify_connection'
    ELSE 'none'
  END;

  v_can_manage := private.arca_actor_can_manage(p_business_id, p_actor) IS TRUE;

  IF v_cfg_found THEN
    v_cuit := private.arca_norm_cuit(v_cfg.cuit);
    IF v_cuit IS NOT NULL AND v_cuit !~ '^[0-9]{11}$' THEN
      v_cuit := NULL;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'contract_version', 1,
    'available',        true,
    'status',           v_status,
    'configured',       v_configured,
    'environment',      CASE WHEN v_cfg_found AND v_cfg.ambiente IN ('homologacion', 'produccion')
                             THEN v_cfg.ambiente END,
    'cuit',             v_cuit,
    'razon_social',     CASE WHEN v_cfg_found THEN nullif(left(btrim(v_cfg.razon_social), 200), '') END,
    'punto_venta',      CASE WHEN v_cfg_found AND v_cfg.punto_venta BETWEEN 1 AND 99998
                             THEN v_cfg.punto_venta END,
    'alias',            CASE WHEN v_cfg_found THEN nullif(left(btrim(v_cfg.alias), 120), '') END,
    'certificate', jsonb_build_object(
      'present',          v_cert_present,
      'expires_at',       v_not_after,
      'days_remaining',   v_days,
      'renewal_state',    v_renewal,
      'matches_credential', v_pair_matches),
    'credential', jsonb_build_object(
      'active',           v_cred_active),
    'connection', jsonb_build_object(
      'state',            v_conn_state,
      'last_verified_at', v_conn_at),
    'setup', jsonb_build_object(
      'state',            v_setup_state,
      'kind',             v_setup_kind,
      'step',             v_setup_step,
      'started_at',       v_setup_since),
    'attention',        to_jsonb(v_attention),
    'can_manage',       v_can_manage,
    'next_action',      v_next
  );
END
$function$;

ALTER FUNCTION private.arca_selfservice_status(uuid, uuid, timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.arca_selfservice_status(uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.arca_selfservice_status(uuid, uuid, timestamptz) FROM anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.save_arca_config_legacy(
  p_business_id  uuid,
  p_cuit         text        DEFAULT NULL,
  p_razon_social text        DEFAULT NULL,
  p_ambiente     text        DEFAULT NULL,
  p_punto_venta  integer     DEFAULT NULL,
  p_web_service  text        DEFAULT NULL,
  p_alias        text        DEFAULT NULL,
  p_expires_at   timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_actor  uuid := auth.uid();
  v_tenant uuid;
  v_row    public.arca_config%ROWTYPE;
  v_found  boolean;
  v_locked boolean;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  SELECT gp.business_id INTO v_tenant FROM public.get_my_profile() gp;
  IF p_business_id IS NULL OR v_tenant IS NULL OR p_business_id <> v_tenant
     OR NOT private.arca_actor_can_manage(p_business_id, v_actor) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF p_ambiente IS NOT NULL AND p_ambiente NOT IN ('homologacion', 'produccion') THEN
    RAISE EXCEPTION 'INVALID_AMBIENTE' USING ERRCODE = '22023';
  END IF;
  IF p_punto_venta IS NOT NULL AND (p_punto_venta < 1 OR p_punto_venta > 99998) THEN
    RAISE EXCEPTION 'INVALID_PUNTO_VENTA' USING ERRCODE = '22023';
  END IF;
  IF p_cuit IS NOT NULL AND length(coalesce(private.arca_norm_cuit(p_cuit), '')) <> 11 THEN
    RAISE EXCEPTION 'INVALID_CUIT' USING ERRCODE = '22023';
  END IF;

  -- Serializa con la rotación de credenciales del mismo negocio.
  PERFORM pg_advisory_xact_lock(hashtext('arca_rotation:' || p_business_id::text));

  SELECT * INTO v_row FROM public.arca_config WHERE business_id = p_business_id FOR UPDATE;
  v_found := FOUND;

  v_locked := EXISTS (
      SELECT 1 FROM private.arca_private_key_credentials k
       WHERE k.business_id = p_business_id AND k.credential_status = 'active')
    OR (v_found AND (coalesce(btrim(v_row.cert_file), '') <> ''
                     OR coalesce(btrim(v_row.pfx_file), '') <> ''));

  IF p_expires_at IS NOT NULL
     AND (NOT v_found OR p_expires_at IS DISTINCT FROM v_row.expires_at) THEN
    RAISE EXCEPTION 'ARCA_FIELD_LOCKED' USING ERRCODE = '42501', DETAIL = 'expires_at';
  END IF;
  IF p_web_service IS NOT NULL
     AND p_web_service IS DISTINCT FROM coalesce(v_row.web_service, 'wsfe') THEN
    RAISE EXCEPTION 'ARCA_FIELD_LOCKED' USING ERRCODE = '42501', DETAIL = 'web_service';
  END IF;

  IF v_locked THEN
    IF p_cuit IS NOT NULL
       AND private.arca_norm_cuit(p_cuit) IS DISTINCT FROM private.arca_norm_cuit(v_row.cuit) THEN
      RAISE EXCEPTION 'ARCA_FIELD_LOCKED' USING ERRCODE = '42501', DETAIL = 'cuit';
    END IF;
    IF p_ambiente IS NOT NULL AND p_ambiente IS DISTINCT FROM v_row.ambiente THEN
      RAISE EXCEPTION 'ARCA_FIELD_LOCKED' USING ERRCODE = '42501', DETAIL = 'ambiente';
    END IF;
    IF p_alias IS NOT NULL AND btrim(p_alias) IS DISTINCT FROM btrim(coalesce(v_row.alias, '')) THEN
      RAISE EXCEPTION 'ARCA_FIELD_LOCKED' USING ERRCODE = '42501', DETAIL = 'alias';
    END IF;
  END IF;

  INSERT INTO public.arca_config AS ac
    (business_id, cuit, razon_social, ambiente, punto_venta, web_service, alias, updated_at)
  VALUES
    (p_business_id, p_cuit, p_razon_social,
     COALESCE(p_ambiente, 'homologacion'), COALESCE(p_punto_venta, 1),
     'wsfe', COALESCE(p_alias, ''), now())
  ON CONFLICT (business_id) DO UPDATE SET
    cuit         = CASE WHEN v_locked THEN ac.cuit     ELSE COALESCE(p_cuit,     ac.cuit)     END,
    ambiente     = CASE WHEN v_locked THEN ac.ambiente ELSE COALESCE(p_ambiente, ac.ambiente) END,
    alias        = CASE WHEN v_locked THEN ac.alias    ELSE COALESCE(p_alias,    ac.alias)    END,
    razon_social = COALESCE(p_razon_social, ac.razon_social),
    punto_venta  = COALESCE(p_punto_venta,  ac.punto_venta),
    updated_at   = now();
  -- Nunca escribe: cert_file, pfx, passwords, wsaa cache, estado_conexion,
  -- cuit_emisor, web_service (salvo el default del alta) ni expires_at.

  PERFORM private.arca_audit('arca_config_legacy_saved', p_business_id, v_actor, p_ambiente, NULL, 'ok', NULL);
  RETURN jsonb_build_object('success', true, 'updated_at', now(), 'identity_locked', v_locked);
END
$function$;

ALTER FUNCTION public.save_arca_config_legacy(uuid, text, text, text, integer, text, text, timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.save_arca_config_legacy(uuid, text, text, text, integer, text, text, timestamptz) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.save_arca_config_legacy(uuid, text, text, text, integer, text, text, timestamptz) TO authenticated;

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

REVOKE ALL ON FUNCTION public.arca_cancel_certificate_rotation(uuid,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.arca_cancel_certificate_rotation(uuid,text,uuid) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.arca_cancel_certificate_rotation(uuid,text,uuid) TO service_role;

-- ── 3. Restricción de la fila pendiente ─────────────────────────────────────
ALTER TABLE private.arca_credential_rotations DROP CONSTRAINT IF EXISTS arca_credential_rotations_pending_secret_check;
ALTER TABLE private.arca_credential_rotations DROP CONSTRAINT IF EXISTS arca_credential_rotations_initial_verified_ticket_check;
ALTER TABLE private.arca_credential_rotations DROP CONSTRAINT IF EXISTS arca_credential_rotations_verification_hold_check;
DROP INDEX IF EXISTS private.arca_credential_rotations_verification_attempt_uidx;
DO $nn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM private.arca_credential_rotations WHERE private_key_secret_id IS NULL) THEN
    ALTER TABLE private.arca_credential_rotations ALTER COLUMN private_key_secret_id SET NOT NULL;
  END IF;
END
$nn$;

-- ── 4. Post-condiciones ─────────────────────────────────────────────────────
DO $post$
DECLARE v_src text;
BEGIN
  IF to_regprocedure('public.arca_selfservice_activate(uuid,uuid,text,text,text)') IS NOT NULL
     OR to_regprocedure('private.arca_selfservice_is_configured(uuid)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE (n.nspname = 'public' AND p.proname LIKE 'arca\_selfservice\_%' AND p.proname <> 'arca_selfservice_status')
                    OR (n.nspname = 'private' AND p.proname IN ('arca_selfservice_verification_hold', 'arca_selfservice_hold_view'))) THEN
    RAISE EXCEPTION 'rollback Phase 2A incompleto: quedan funciones del flujo inicial';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'private.arca_selfservice_status(uuid,uuid,timestamptz)'::regprocedure;
  IF position('certificate_attached' IN v_src) > 0 OR position('r.setup_kind' IN v_src) > 0
     OR position('verification_hold' IN v_src) > 0 THEN
    RAISE EXCEPTION 'rollback Phase 2A: la derivación de Phase 1 no volvió a su versión previa';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_arca_selfservice_status(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.save_arca_config_legacy(uuid,text,text,text,integer,text,text,timestamptz)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.arca_get_credential_for_signing(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'rollback Phase 2A: se perdió una entrada previa';
  END IF;
END
$post$;

COMMIT;

NOTIFY pgrst, 'reload schema';
