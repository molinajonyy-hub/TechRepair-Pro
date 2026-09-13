-- ============================================================================
-- ARCA SELF-SERVICE · PHASE 2A — motor de configuración INICIAL
--
-- Un negocio SIN credencial ARCA configura su integración desde la app:
--
--   datos fiscales → clave RSA server-side (sólo Vault) → CSR PKCS#10 → el usuario
--   lo presenta en ARCA → sube el certificado emitido → validación estructural →
--   verificación NO fiscal contra WSAA con el par PENDIENTE → activación atómica.
--
--   PENDIENTE → VERIFICAR → ACTIVAR. Nunca "activar y esperar que funcione".
--
-- NO es renovación: cualquier negocio con credencial (en cualquier estado), con
-- certificado o PFX cargado, o con una rotación de renovación viva queda FUERA
-- (ARCA_ALREADY_CONFIGURED). Esto excluye a Clic por construcción.
--
-- Máquina de estados (sin estados nuevos; reutiliza private.arca_credential_rotations):
--
--   state            setup_kind  certificate_der_sha256  wsaa_verified_at   Phase 1 setup.step
--   ───────────────  ──────────  ──────────────────────  ─────────────────  ──────────────────
--   pending_rotation initial     NULL                    NULL               certificate
--   pending_rotation initial     set                     NULL               verification
--   pending_rotation initial     set                     set (ticket)       activation
--   completed        initial     set                     set                (setup completed)
--   cancelled        initial     —                       —                  (historia)
--
-- El índice único parcial existente "una pending_rotation por negocio" garantiza
-- una sola configuración viva.
--
-- Por qué el ticket WSAA se guarda ANTES de activar: WSAA rechaza un segundo
-- LoginCms para el mismo certificado+servicio mientras el ticket anterior siga
-- vigente (coe.alreadyAuthenticated, hasta 12 h). Descartarlo rompería el primer
-- login real de afip-wsaa; perderlo entre verificar y activar impediría reintentar.
-- Por eso: verificar → persistir ticket en la fila pendiente → activar (reintentable
-- sin WSAA) → el ticket pasa al cache activo.
--
-- Lo que NO toca: credenciales existentes, Vault ajeno a la configuración pendiente,
-- cert_file/token/sign de negocios configurados, afip-wsaa, afip-cae, emisión.
-- No hay DML sobre filas existentes.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE p2a_before ON COMMIT DROP AS
SELECT (SELECT count(*) FROM private.arca_private_key_credentials) AS creds,
       (SELECT count(*) FROM private.arca_credential_rotations)    AS rots,
       (SELECT count(*) FROM vault.secrets)                        AS secrets,
       md5(coalesce((SELECT string_agg(t::text, '|' ORDER BY t::text) FROM public.arca_config t), '')) AS cfg_md5;

-- ── 1. Esquema de la fila de rotación ───────────────────────────────────────
ALTER TABLE private.arca_credential_rotations
  ADD COLUMN IF NOT EXISTS setup_kind                  text,
  ADD COLUMN IF NOT EXISTS fiscal_snapshot             jsonb,
  ADD COLUMN IF NOT EXISTS certificate_der_sha256      text,
  ADD COLUMN IF NOT EXISTS certificate_issuer          jsonb,
  ADD COLUMN IF NOT EXISTS verification_started_at     timestamptz,
  ADD COLUMN IF NOT EXISTS verified_wsaa_token         text,
  ADD COLUMN IF NOT EXISTS verified_wsaa_sign          text,
  ADD COLUMN IF NOT EXISTS verified_wsaa_token_expires timestamptz;

ALTER TABLE private.arca_credential_rotations
  DROP CONSTRAINT IF EXISTS arca_credential_rotations_setup_kind_check;
ALTER TABLE private.arca_credential_rotations
  ADD CONSTRAINT arca_credential_rotations_setup_kind_check
  CHECK (setup_kind IS NULL OR setup_kind IN ('initial', 'renewal'));

-- La cancelación de una configuración inicial borra el secreto Vault y deja la
-- referencia en NULL: ninguna fila apunta a un secreto inexistente (el chequeo
-- #11 de la finalización de renovaciones escanea TODAS las filas del negocio).
ALTER TABLE private.arca_credential_rotations
  ALTER COLUMN private_key_secret_id DROP NOT NULL;
ALTER TABLE private.arca_credential_rotations
  DROP CONSTRAINT IF EXISTS arca_credential_rotations_pending_secret_check;
ALTER TABLE private.arca_credential_rotations
  ADD CONSTRAINT arca_credential_rotations_pending_secret_check
  CHECK (state <> 'pending_rotation' OR private_key_secret_id IS NOT NULL);

COMMENT ON COLUMN private.arca_credential_rotations.setup_kind IS
  'ARCA Phase 2A: initial (configuración inicial) | renewal. NULL = fila legacy de renovación (S4A).';
COMMENT ON COLUMN private.arca_credential_rotations.certificate_der_sha256 IS
  'ARCA Phase 2A: SHA-256 de los BYTES DER del certificado adjunto. Identifica el certificado exacto que '
  'WSAA verificó (certificate_fingerprint es el SPKI y coincide con la clave: no distingue certificados).';
COMMENT ON COLUMN private.arca_credential_rotations.verified_wsaa_token IS
  'ARCA Phase 2A: ticket WSAA obtenido con el par PENDIENTE. Se mueve al cache activo al activar y se purga al cancelar.';

-- ── 2. Auditoría: eventos de Phase 2A (lista S4C completa + nuevos) ─────────
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
  'arca_legacy_private_key_purged','arca_previous_secret_purged','arca_rollback_disabled',
  -- ARCA Phase 2A
  'arca_selfservice_setup_prepared','arca_selfservice_setup_replayed','arca_selfservice_setup_failed',
  'arca_selfservice_certificate_attached','arca_selfservice_certificate_rejected',
  'arca_selfservice_verification_started','arca_selfservice_verification_succeeded',
  'arca_selfservice_verification_failed',
  'arca_selfservice_activated','arca_selfservice_activation_failed','arca_selfservice_activation_replayed',
  'arca_selfservice_cancelled'));

-- ── 3. Helpers privados (sin EXECUTE para nadie) ────────────────────────────

-- CUIT: 11 dígitos, prefijo de persona física/jurídica, dígito verificador módulo 11.
-- Un resultado crudo de 10 es inválido (ARCA reasigna el prefijo en ese caso).
CREATE OR REPLACE FUNCTION private.arca_cuit_is_valid(p_digits text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  w   int[] := ARRAY[5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  s   int := 0;
  raw int;
  i   int;
BEGIN
  IF p_digits IS NULL OR p_digits !~ '^[0-9]{11}$' THEN RETURN false; END IF;
  IF left(p_digits, 2) NOT IN ('20', '23', '24', '27', '30', '33', '34') THEN RETURN false; END IF;
  FOR i IN 1..10 LOOP
    s := s + substr(p_digits, i, 1)::int * w[i];
  END LOOP;
  raw := 11 - (s % 11);
  IF raw = 10 THEN RETURN false; END IF;
  RETURN (raw % 11) = substr(p_digits, 11, 1)::int;
END
$function$;

-- Issuer de un X.509 (mismo walker X.500 que el subject). Fail-closed: '{}'.
CREATE OR REPLACE FUNCTION private.arca_cert_issuer(p_der bytea)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE c0 int; ct int; i int;
BEGIN
  IF p_der IS NULL OR length(p_der) < 64 OR get_byte(p_der, 0) <> 48 THEN RETURN '{}'::jsonb; END IF;
  SELECT content_start INTO c0 FROM private.arca_der_len(p_der, 0);
  IF get_byte(p_der, c0) <> 48 THEN RETURN '{}'::jsonb; END IF;
  SELECT content_start INTO ct FROM private.arca_der_len(p_der, c0);
  i := ct;
  IF get_byte(p_der, i) = 160 THEN i := private.arca_der_next(p_der, i); END IF;  -- [0] version
  i := private.arca_der_next(p_der, i);   -- serialNumber
  i := private.arca_der_next(p_der, i);   -- signature
  RETURN private.arca_x500_name(p_der, i);
EXCEPTION WHEN others THEN
  RETURN '{}'::jsonb;
END
$function$;

-- Etiqueta del emisor esperada. Chequeo de ETIQUETAS, no de firma de la CA: la
-- autoridad criptográfica es WSAA, que se exige antes de activar.
--   produccion   : c=AR, o∈{AFIP,ARCA}, cn='Computadores'  (medido en el certificado productivo vigente)
--   homologacion : c=AR, o∈{AFIP,ARCA}, cn no vacío         (CN no medido: señal blanda)
-- Cualquier otro atributo del issuer se ignora.
CREATE OR REPLACE FUNCTION private.arca_selfservice_issuer_ok(p_issuer jsonb, p_ambiente text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT coalesce(p_issuer ->> 'c', '') = 'AR'
     AND coalesce(p_issuer ->> 'o', '') IN ('AFIP', 'ARCA')
     AND CASE p_ambiente
           WHEN 'produccion'   THEN coalesce(p_issuer ->> 'cn', '') = 'Computadores'
           WHEN 'homologacion' THEN coalesce(btrim(p_issuer ->> 'cn'), '') <> ''
           ELSE false
         END;
$function$;

-- DER → PEM canónico (líneas de 64). El certificado se guarda SIEMPRE re-codificado
-- desde los bytes validados, nunca con el formato que mandó el cliente.
CREATE OR REPLACE FUNCTION private.arca_der_to_certificate_pem(p_der bytea)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT '-----BEGIN CERTIFICATE-----' || E'\n'
      || rtrim(regexp_replace(translate(encode(p_der, 'base64'), E'\n', ''), '(.{64})', E'\\1\n', 'g'), E'\n')
      || E'\n-----END CERTIFICATE-----';
$function$;

-- Validación de certificado contra la configuración pendiente. Envuelve el validador
-- certificado de S4B-2A: cualquier error del parser DER se vuelve CERTIFICATE_INVALID
-- (acotado) en vez de abortar la transacción con un error crudo.
CREATE OR REPLACE FUNCTION private.arca_selfservice_validate_certificate(
  p_certificate_pem text, p_expected_fingerprint text, p_expected_subject jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE v jsonb; v_subj jsonb; v_expected_cuit text; v_expected_cn text;
BEGIN
  IF p_certificate_pem IS NULL OR length(p_certificate_pem) > 65536 THEN
    RETURN jsonb_build_object('ok', false, 'state', 'CERTIFICATE_INVALID');
  END IF;
  v := private.arca_validate_rotation_certificate(p_certificate_pem, p_expected_fingerprint, p_expected_subject, NULL);
  IF (v ->> 'state') = 'CERTIFICATE_SUBJECT_MISMATCH' THEN
    v_subj := private.arca_cert_subject(private.arca_pem_to_der(p_certificate_pem));
    v_expected_cuit := private.arca_norm_cuit(p_expected_subject ->> 'serialnumber');
    v_expected_cn := btrim(p_expected_subject ->> 'cn');
    IF private.arca_norm_cuit(v_subj ->> 'serialnumber') IS DISTINCT FROM v_expected_cuit THEN
      RETURN jsonb_build_object('ok', false, 'state', 'CERTIFICATE_CUIT_MISMATCH');
    ELSIF btrim(coalesce(v_subj ->> 'cn', '')) IS DISTINCT FROM v_expected_cn THEN
      RETURN jsonb_build_object('ok', false, 'state', 'CERTIFICATE_ALIAS_MISMATCH');
    END IF;
  END IF;
  RETURN v;
EXCEPTION WHEN others THEN
  RETURN jsonb_build_object('ok', false, 'state', 'CERTIFICATE_INVALID');
END
$function$;

-- ¿El negocio queda FUERA del flujo inicial? Credencial en cualquier estado,
-- certificado o PFX cargado, o una rotación de renovación viva.
CREATE OR REPLACE FUNCTION private.arca_selfservice_is_configured(p_business_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT EXISTS (SELECT 1 FROM private.arca_private_key_credentials k WHERE k.business_id = p_business_id)
      OR EXISTS (SELECT 1 FROM public.arca_config c
                  WHERE c.business_id = p_business_id
                    AND (coalesce(btrim(c.cert_file), '') <> '' OR coalesce(btrim(c.pfx_file), '') <> ''))
      OR EXISTS (SELECT 1 FROM private.arca_credential_rotations r
                  WHERE r.business_id = p_business_id
                    AND r.state IN ('pending_rotation', 'activated_pending_verification')
                    AND r.setup_kind IS DISTINCT FROM 'initial');
$function$;

-- Rechazo auditado y acotado (sin detalle SQL).
CREATE OR REPLACE FUNCTION private.arca_selfservice_reject(
  p_event text, p_business_id uuid, p_actor uuid, p_state text, p_fp text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  PERFORM private.arca_audit(p_event, p_business_id, p_actor, NULL, left(coalesce(p_fp, ''), 16), p_state, p_state);
  RETURN jsonb_build_object('ok', false, 'state', p_state);
END
$function$;

DO $own$
DECLARE v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
      'private.arca_cuit_is_valid(text)',
      'private.arca_cert_issuer(bytea)',
      'private.arca_selfservice_issuer_ok(jsonb,text)',
      'private.arca_der_to_certificate_pem(bytea)',
      'private.arca_selfservice_validate_certificate(text,text,jsonb)',
      'private.arca_selfservice_is_configured(uuid)',
      'private.arca_selfservice_reject(text,uuid,uuid,text,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', v_fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated, service_role', v_fn);
  END LOOP;
END
$own$;

-- ── 4. Phase 1: sólo cambia cómo se deriva setup.kind/setup.step ────────────
-- kind = setup_kind; una fila legacy (NULL) es renovación por construcción (S4A
-- sólo prepara sobre un certificado vigente). step de pending_rotation se deriva de
-- hechos de la fila: certificado adjunto (certificate_fingerprint) y ticket WSAA
-- verificado (wsaa_verified_at). Nunca lee certificate_pem ni el ticket.
-- Todo lo demás es idéntico a 20260929120000; contract_version sigue en 1.
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
  SELECT r.state, r.created_at, r.setup_kind,
         (r.certificate_fingerprint IS NOT NULL) AS certificate_attached,
         (r.wsaa_verified_at IS NOT NULL)        AS wsaa_verified
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
    v_setup_kind  := coalesce(v_rot.setup_kind, 'renewal');
    v_setup_step  := CASE
                       WHEN v_rot.state = 'activated_pending_verification' THEN 'verification'
                       WHEN v_rot.wsaa_verified                            THEN 'activation'
                       WHEN v_rot.certificate_attached                     THEN 'verification'
                       ELSE 'certificate'
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

COMMENT ON FUNCTION private.arca_selfservice_status(uuid, uuid, timestamptz) IS
  'ARCA Phase 1 (paso de configuración según Phase 2A): derivación pura del estado de autoservicio ARCA '
  '(reloj inyectable). Sin EXECUTE para roles cliente ni service_role. No devuelve PEM, secret_id, '
  'fingerprints, token/sign ni texto libre.';

-- ── 5. Phase 0: la identidad fiscal también se bloquea con una configuración viva ──
-- Idéntica a 20260928120000 salvo v_locked: CUIT/alias/ambiente no pueden divergir
-- del subject del CSR mientras exista una rotación viva (inicial o renovación).
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
                     OR coalesce(btrim(v_row.pfx_file), '') <> ''))
    -- ARCA Phase 2A: una configuración (o renovación) viva fija la identidad del CSR.
    OR EXISTS (
      SELECT 1 FROM private.arca_credential_rotations r
       WHERE r.business_id = p_business_id
         AND r.state IN ('pending_rotation', 'activated_pending_verification'));

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

-- ── 6. Renovación legacy: la cancelación S4A no toca configuraciones iniciales ──
-- y ya no deja una referencia a un secreto borrado.
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
    WHERE r.business_id = p_business_id AND r.idempotency_key = p_idempotency_key
      AND r.setup_kind IS DISTINCT FROM 'initial'
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'state', 'NO_PENDING_ROTATION');
  END IF;
  IF v_row.state = 'cancelled' THEN
    RETURN jsonb_build_object('ok', true, 'state', 'ROTATION_CANCELLED', 'rotation_ref', left(v_row.id::text,8));
  END IF;
  IF v_row.state <> 'pending_rotation' THEN
    RETURN jsonb_build_object('ok', false, 'state', 'NO_PENDING_ROTATION');
  END IF;

  DELETE FROM vault.secrets WHERE id = v_row.private_key_secret_id;
  UPDATE private.arca_credential_rotations
     SET state = 'cancelled', cancelled_at = now(), updated_at = now(),
         private_key_secret_id = NULL
   WHERE id = v_row.id;
  PERFORM private.arca_audit('arca_certificate_rotation_cancelled', p_business_id, p_actor, NULL, left(v_row.private_key_fingerprint,16), 'ROTATION_CANCELLED', NULL);

  RETURN jsonb_build_object('ok', true, 'state', 'ROTATION_CANCELLED', 'rotation_ref', left(v_row.id::text,8));
END $function$;

REVOKE ALL ON FUNCTION public.arca_cancel_certificate_rotation(uuid,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.arca_cancel_certificate_rotation(uuid,text,uuid) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.arca_cancel_certificate_rotation(uuid,text,uuid) TO service_role;

-- ── 7. RPC (a): preparar la configuración inicial ───────────────────────────
-- Probe: p_key_pem NULL → si no hay replay devuelve KEY_REQUIRED + el subject
-- AUTORIZADO (el Edge genera la clave recién entonces). Con clave: valida y persiste.
CREATE OR REPLACE FUNCTION public.arca_selfservice_prepare_initial(
  p_business_id     uuid,
  p_actor           uuid,
  p_idempotency_key text,
  p_cuit            text,
  p_razon_social    text,
  p_ambiente        text,
  p_punto_venta     integer,
  p_alias           text,
  p_key_pem         text DEFAULT NULL,
  p_csr_pem         text DEFAULT NULL,
  p_fingerprint     text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_cuit       text;
  v_alias      text := btrim(coalesce(p_alias, ''));
  v_razon      text := btrim(coalesce(p_razon_social, ''));
  v_tenant_cuit text;
  v_subject    jsonb;
  v_snapshot   jsonb;
  v_hash       text;
  v_prev       record;
  v_key_pub    record;
  v_csr_pub    record;
  v_fp         text;
  v_csr_fp     text;
  v_bits       int;
  v_exp        bigint;
  v_csr_bits   int;
  v_csr_subj   jsonb;
  v_rot_id     uuid;
  v_secret_id  uuid;
  v_readback   text;
  v_stage      text := 'VAULT_WRITE_FAILED';
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'solo service_role' USING ERRCODE = '42501';
  END IF;
  IF p_business_id IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'parámetros requeridos faltantes' USING ERRCODE = '22023';
  END IF;
  IF NOT public.is_business_owner_or_admin(p_business_id, p_actor) THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_setup_failed', p_business_id, p_actor, 'UNAUTHORIZED');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('arca_rotation:' || p_business_id::text));

  IF coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9._:-]{8,128}$' THEN
    RETURN jsonb_build_object('ok', false, 'state', 'INVALID_IDEMPOTENCY_KEY');
  END IF;

  -- Nunca un negocio configurado (Clic incluido).
  IF private.arca_selfservice_is_configured(p_business_id) THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_setup_failed', p_business_id, p_actor, 'ARCA_ALREADY_CONFIGURED');
  END IF;

  -- ── Datos fiscales (validación server-side) ──
  IF coalesce(p_cuit, '') !~ '^\s*[0-9]{2}-?[0-9]{8}-?[0-9]\s*$' THEN
    RETURN jsonb_build_object('ok', false, 'state', 'INVALID_CUIT');
  END IF;
  v_cuit := private.arca_norm_cuit(p_cuit);
  IF NOT private.arca_cuit_is_valid(v_cuit) THEN
    RETURN jsonb_build_object('ok', false, 'state', 'INVALID_CUIT');
  END IF;
  IF p_ambiente IS NULL OR p_ambiente NOT IN ('homologacion', 'produccion') THEN
    RETURN jsonb_build_object('ok', false, 'state', 'INVALID_AMBIENTE');
  END IF;
  IF p_punto_venta IS NULL OR p_punto_venta < 1 OR p_punto_venta > 99998 THEN
    RETURN jsonb_build_object('ok', false, 'state', 'INVALID_PUNTO_VENTA');
  END IF;
  -- Alias = CN del certificado. Sólo caracteres PrintableString (sin '_').
  IF v_alias !~ '^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$' THEN
    RETURN jsonb_build_object('ok', false, 'state', 'INVALID_ALIAS');
  END IF;
  IF length(v_razon) < 1 OR length(v_razon) > 200 THEN
    RETURN jsonb_build_object('ok', false, 'state', 'INVALID_RAZON_SOCIAL');
  END IF;

  -- El CUIT tiene que ser el del negocio si el perfil canónico ya declara uno.
  SELECT private.arca_norm_cuit(nullif(btrim(s.cuit), '')) INTO v_tenant_cuit
    FROM public.business_settings s WHERE s.business_id = p_business_id;
  IF v_tenant_cuit IS NOT NULL AND v_tenant_cuit IS DISTINCT FROM v_cuit THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_setup_failed', p_business_id, p_actor, 'CUIT_TENANT_MISMATCH');
  END IF;

  v_subject  := jsonb_build_object('cn', v_alias, 'serialnumber', 'CUIT ' || v_cuit);
  v_snapshot := jsonb_build_object('cuit', v_cuit, 'razon_social', v_razon, 'ambiente', p_ambiente,
                                   'punto_venta', p_punto_venta, 'alias', v_alias);
  v_hash := encode(extensions.digest(
              'arca_selfservice_prepare_initial|' || p_business_id::text || '|' || v_cuit || '|' || v_alias
              || '|' || p_ambiente || '|' || p_punto_venta::text || '|' || v_razon || '|RSA-2048-65537', 'sha256'), 'hex');

  -- ── Idempotencia ──
  SELECT * INTO v_prev FROM private.arca_credential_rotations r
   WHERE r.business_id = p_business_id AND r.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_prev.setup_kind IS DISTINCT FROM 'initial' OR v_prev.request_hash IS DISTINCT FROM v_hash THEN
      RETURN private.arca_selfservice_reject('arca_selfservice_setup_failed', p_business_id, p_actor, 'IDEMPOTENCY_CONFLICT');
    END IF;
    IF v_prev.state = 'pending_rotation' THEN
      PERFORM private.arca_audit('arca_selfservice_setup_replayed', p_business_id, p_actor, p_ambiente,
        left(v_prev.private_key_fingerprint, 16), 'replayed', NULL);
      RETURN jsonb_build_object('ok', true, 'state', 'SETUP_ALREADY_PREPARED',
        'csr_pem', v_prev.csr_pem, 'key_size', v_prev.key_size,
        'subject', jsonb_build_object('alias', v_alias, 'cuit', v_cuit), 'ambiente', p_ambiente);
    END IF;
    RETURN jsonb_build_object('ok', false, 'state', 'IDEMPOTENCY_KEY_CONSUMED');
  END IF;

  IF EXISTS (SELECT 1 FROM private.arca_credential_rotations r
              WHERE r.business_id = p_business_id AND r.state = 'pending_rotation') THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_setup_failed', p_business_id, p_actor, 'SETUP_IN_PROGRESS');
  END IF;

  -- ── Probe: la clave todavía no existe ──
  IF p_key_pem IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'state', 'KEY_REQUIRED',
      'subject', v_subject, 'key_algorithm', 'RSA', 'key_size', 2048, 'public_exponent', 65537);
  END IF;

  -- ── Clave + CSR: el Edge no es autoridad, la base re-deriva todo ──
  IF coalesce(btrim(p_csr_pem), '') = '' OR coalesce(btrim(p_fingerprint), '') = '' THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_setup_failed', p_business_id, p_actor, 'CSR_GENERATION_FAILED');
  END IF;
  IF p_key_pem ~ '-----BEGIN CERTIFICATE-----'
     OR p_key_pem ~ '-----BEGIN (RSA |EC )?PUBLIC KEY-----'
     OR (SELECT count(*) FROM regexp_matches(p_key_pem, '-----BEGIN (RSA |EC )?PRIVATE KEY-----', 'g')) <> 1 THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_setup_failed', p_business_id, p_actor, 'KEY_GENERATION_FAILED');
  END IF;

  BEGIN
    SELECT * INTO v_key_pub FROM private.arca_rsa_pubkey_from_private(private.arca_pem_to_der(p_key_pem));
    SELECT * INTO v_csr_pub FROM private.arca_rsa_pubkey_from_csr(private.arca_pem_to_der(p_csr_pem));
    v_csr_subj := private.arca_csr_subject(private.arca_pem_to_der(p_csr_pem));
  EXCEPTION WHEN others THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_setup_failed', p_business_id, p_actor, 'CSR_GENERATION_FAILED');
  END;
  IF v_key_pub.n IS NULL OR v_key_pub.e IS NULL THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_setup_failed', p_business_id, p_actor, 'KEY_GENERATION_FAILED');
  END IF;
  IF v_csr_pub.n IS NULL OR v_csr_pub.e IS NULL THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_setup_failed', p_business_id, p_actor, 'CSR_GENERATION_FAILED');
  END IF;

  v_bits := length(v_key_pub.n) * 8;
  v_exp  := ('x' || lpad(encode(v_key_pub.e, 'hex'), 16, '0'))::bit(64)::bigint;
  v_fp   := private.arca_rsa_public_key_fingerprint_sha256(v_key_pub.n, v_key_pub.e);
  v_csr_bits := length(v_csr_pub.n) * 8;
  v_csr_fp   := private.arca_rsa_public_key_fingerprint_sha256(v_csr_pub.n, v_csr_pub.e);

  IF v_bits <> 2048 OR v_exp <> 65537 OR lower(btrim(p_fingerprint)) IS DISTINCT FROM v_fp THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_setup_failed', p_business_id, p_actor, 'KEY_GENERATION_FAILED');
  END IF;
  IF v_csr_fp IS DISTINCT FROM v_fp OR v_csr_bits <> v_bits THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_setup_failed', p_business_id, p_actor, 'CSR_KEY_MISMATCH');
  END IF;
  -- Subject EXACTO: CN=alias, serialNumber=CUIT n. Cualquier atributo extra rechaza.
  IF private.arca_canonical_subject(v_csr_subj) IS DISTINCT FROM private.arca_canonical_subject(v_subject) THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_setup_failed', p_business_id, p_actor, 'CSR_SUBJECT_MISMATCH');
  END IF;

  v_rot_id := gen_random_uuid();

  -- Datos fiscales + Vault + readback + fila, en UN sub-bloque: si cualquier paso
  -- falla no queda ni secreto huérfano ni datos fiscales a medias.
  BEGIN
    INSERT INTO public.arca_config AS ac
      (business_id, cuit, cuit_emisor, razon_social, ambiente, punto_venta, alias, web_service, updated_at)
    VALUES
      (p_business_id, v_cuit, v_cuit, v_razon, p_ambiente, p_punto_venta, v_alias, 'wsfe', now())
    ON CONFLICT (business_id) DO UPDATE SET
      cuit         = EXCLUDED.cuit,
      cuit_emisor  = EXCLUDED.cuit_emisor,
      razon_social = EXCLUDED.razon_social,
      ambiente     = EXCLUDED.ambiente,
      punto_venta  = EXCLUDED.punto_venta,
      alias        = EXCLUDED.alias,
      web_service  = 'wsfe',
      updated_at   = now();

    v_secret_id := vault.create_secret(
      p_key_pem,
      'arca-private-key-setup:' || p_business_id::text || ':' || replace(v_rot_id::text, '-', ''),
      'ARCA WSAA private key (configuración inicial pendiente)');
    v_stage := 'VAULT_READBACK_FAILED';
    SELECT ds.decrypted_secret INTO v_readback FROM vault.decrypted_secrets ds WHERE ds.id = v_secret_id;
    IF private.arca_key_fingerprint(v_readback) IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'readback_fingerprint_mismatch';
    END IF;
    v_readback := NULL;

    v_stage := 'SETUP_PREPARE_FAILED';
    INSERT INTO private.arca_credential_rotations(
      id, business_id, private_key_secret_id, private_key_fingerprint, csr_fingerprint, csr_pem,
      key_algorithm, key_size, public_exponent, subject, state, idempotency_key, request_hash,
      created_by, setup_kind, fiscal_snapshot)
    VALUES (v_rot_id, p_business_id, v_secret_id, v_fp, v_csr_fp, p_csr_pem,
      'RSA', v_bits, v_exp, v_subject, 'pending_rotation', p_idempotency_key, v_hash,
      p_actor, 'initial', v_snapshot);
  EXCEPTION WHEN others THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_setup_failed', p_business_id, p_actor, v_stage, v_fp);
  END;

  PERFORM private.arca_audit('arca_selfservice_setup_prepared', p_business_id, p_actor, p_ambiente,
    left(v_fp, 16), 'SETUP_PREPARED', NULL);

  RETURN jsonb_build_object('ok', true, 'state', 'SETUP_PREPARED',
    'csr_pem', p_csr_pem, 'key_size', v_bits,
    'subject', jsonb_build_object('alias', v_alias, 'cuit', v_cuit), 'ambiente', p_ambiente);
END
$function$;

-- ── 8. RPC (b): recuperar el CSR de la configuración viva del negocio ───────
CREATE OR REPLACE FUNCTION public.arca_selfservice_get_csr(p_business_id uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE v_row record;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'solo service_role' USING ERRCODE = '42501';
  END IF;
  IF p_business_id IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'parámetros requeridos faltantes' USING ERRCODE = '22023';
  END IF;
  IF NOT public.is_business_owner_or_admin(p_business_id, p_actor) THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_setup_failed', p_business_id, p_actor, 'UNAUTHORIZED');
  END IF;
  IF private.arca_selfservice_is_configured(p_business_id) THEN
    RETURN jsonb_build_object('ok', false, 'state', 'ARCA_ALREADY_CONFIGURED');
  END IF;

  SELECT r.csr_pem, r.key_size, r.fiscal_snapshot, r.certificate_der_sha256, r.wsaa_verified_at
    INTO v_row
    FROM private.arca_credential_rotations r
   WHERE r.business_id = p_business_id AND r.state = 'pending_rotation' AND r.setup_kind = 'initial';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'state', 'NO_SETUP_IN_PROGRESS');
  END IF;

  RETURN jsonb_build_object('ok', true, 'state', 'CSR_AVAILABLE',
    'csr_pem', v_row.csr_pem, 'key_size', v_row.key_size,
    'subject', jsonb_build_object('alias', v_row.fiscal_snapshot ->> 'alias', 'cuit', v_row.fiscal_snapshot ->> 'cuit'),
    'ambiente', v_row.fiscal_snapshot ->> 'ambiente',
    'certificate_attached', v_row.certificate_der_sha256 IS NOT NULL,
    'verified', v_row.wsaa_verified_at IS NOT NULL);
END
$function$;

-- ── 9. RPC (c): adjuntar el certificado emitido por ARCA ────────────────────
CREATE OR REPLACE FUNCTION public.arca_selfservice_attach_certificate(
  p_business_id uuid, p_actor uuid, p_certificate_pem text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_row     record;
  v_val     jsonb;
  v_der     bytea;
  v_sha     text;
  v_issuer  jsonb;
  v_pem     text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'solo service_role' USING ERRCODE = '42501';
  END IF;
  IF p_business_id IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'parámetros requeridos faltantes' USING ERRCODE = '22023';
  END IF;
  IF NOT public.is_business_owner_or_admin(p_business_id, p_actor) THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_certificate_rejected', p_business_id, p_actor, 'UNAUTHORIZED');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('arca_rotation:' || p_business_id::text));

  IF private.arca_selfservice_is_configured(p_business_id) THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_certificate_rejected', p_business_id, p_actor, 'ARCA_ALREADY_CONFIGURED');
  END IF;

  SELECT r.* INTO v_row
    FROM private.arca_credential_rotations r
   WHERE r.business_id = p_business_id AND r.state = 'pending_rotation' AND r.setup_kind = 'initial'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'state', 'NO_SETUP_IN_PROGRESS');
  END IF;
  IF v_row.wsaa_verified_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'state', 'CERTIFICATE_LOCKED_VERIFIED');
  END IF;
  IF v_row.verification_started_at IS NOT NULL AND v_row.verification_started_at > now() - interval '2 minutes' THEN
    RETURN jsonb_build_object('ok', false, 'state', 'VERIFICATION_IN_PROGRESS');
  END IF;

  v_val := private.arca_selfservice_validate_certificate(p_certificate_pem, v_row.private_key_fingerprint, v_row.subject);
  IF (v_val ->> 'ok') IS DISTINCT FROM 'true' THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_certificate_rejected', p_business_id, p_actor,
      coalesce(v_val ->> 'state', 'CERTIFICATE_INVALID'), v_row.private_key_fingerprint);
  END IF;

  v_der := private.arca_pem_to_der(p_certificate_pem);
  v_issuer := private.arca_cert_issuer(v_der);
  IF NOT private.arca_selfservice_issuer_ok(v_issuer, v_row.fiscal_snapshot ->> 'ambiente') THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_certificate_rejected', p_business_id, p_actor,
      'CERTIFICATE_ISSUER_UNEXPECTED', v_row.private_key_fingerprint);
  END IF;

  v_sha := encode(extensions.digest(v_der, 'sha256'), 'hex');
  IF v_row.certificate_der_sha256 IS NOT DISTINCT FROM v_sha THEN
    RETURN jsonb_build_object('ok', true, 'state', 'CERTIFICATE_ALREADY_ATTACHED',
      'expires_at', v_row.certificate_not_after);
  END IF;

  v_pem := private.arca_der_to_certificate_pem(v_der);

  UPDATE private.arca_credential_rotations SET
    certificate_pem         = v_pem,
    certificate_fingerprint = v_val ->> 'fingerprint',
    certificate_der_sha256  = v_sha,
    certificate_not_after   = (v_val ->> 'not_after')::timestamptz,
    certificate_issuer      = jsonb_build_object('c', v_issuer ->> 'c', 'o', v_issuer ->> 'o', 'cn', v_issuer ->> 'cn'),
    verification_started_at = NULL,
    updated_at              = now()
  WHERE id = v_row.id;

  PERFORM private.arca_audit('arca_selfservice_certificate_attached', p_business_id, p_actor,
    v_row.fiscal_snapshot ->> 'ambiente', left(v_row.private_key_fingerprint, 16),
    CASE WHEN v_row.certificate_der_sha256 IS NULL THEN 'CERTIFICATE_ATTACHED' ELSE 'CERTIFICATE_REPLACED' END, NULL);

  RETURN jsonb_build_object('ok', true,
    'state', CASE WHEN v_row.certificate_der_sha256 IS NULL THEN 'CERTIFICATE_ATTACHED' ELSE 'CERTIFICATE_REPLACED' END,
    'expires_at', (v_val ->> 'not_after')::timestamptz);
END
$function$;

-- ── 10. RPC (d): material de verificación (sólo servidor, con lease) ────────
-- Devuelve el certificado exacto y la clave pendiente descifrada al Edge (misma
-- frontera que arca_get_credential_for_signing). La clave SÓLO sale si todavía hay
-- que firmar: nunca para un setup ya verificado ni para uno configurado.
CREATE OR REPLACE FUNCTION public.arca_selfservice_verification_material(p_business_id uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_row      record;
  v_done     record;
  v_val      jsonb;
  v_pem      text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'solo service_role' USING ERRCODE = '42501';
  END IF;
  IF p_business_id IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'parámetros requeridos faltantes' USING ERRCODE = '22023';
  END IF;
  IF NOT public.is_business_owner_or_admin(p_business_id, p_actor) THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_verification_failed', p_business_id, p_actor, 'UNAUTHORIZED');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('arca_rotation:' || p_business_id::text));

  SELECT r.* INTO v_row
    FROM private.arca_credential_rotations r
   WHERE r.business_id = p_business_id AND r.state = 'pending_rotation' AND r.setup_kind = 'initial'
   FOR UPDATE;

  IF NOT FOUND THEN
    -- Reintento después de una activación que ya comprometió: respuesta acotada.
    SELECT r.id INTO v_done
      FROM private.arca_credential_rotations r
      JOIN private.arca_private_key_credentials k
        ON k.business_id = r.business_id AND k.private_key_fingerprint = r.private_key_fingerprint
     WHERE r.business_id = p_business_id AND r.setup_kind = 'initial' AND r.state = 'completed'
     ORDER BY r.finalized_at DESC NULLS LAST LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', true, 'state', 'SETUP_ALREADY_COMPLETED');
    END IF;
    IF private.arca_selfservice_is_configured(p_business_id) THEN
      RETURN jsonb_build_object('ok', false, 'state', 'ARCA_ALREADY_CONFIGURED');
    END IF;
    RETURN jsonb_build_object('ok', false, 'state', 'NO_SETUP_IN_PROGRESS');
  END IF;

  IF private.arca_selfservice_is_configured(p_business_id) THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_verification_failed', p_business_id, p_actor, 'ARCA_ALREADY_CONFIGURED');
  END IF;
  IF v_row.certificate_der_sha256 IS NULL OR v_row.certificate_pem IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'state', 'CERTIFICATE_REQUIRED');
  END IF;

  IF v_row.wsaa_verified_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'state', 'ALREADY_VERIFIED',
      'fingerprint', v_row.private_key_fingerprint,
      'certificate_sha256', v_row.certificate_der_sha256);
  END IF;

  IF v_row.verification_started_at IS NOT NULL AND v_row.verification_started_at > now() - interval '2 minutes' THEN
    RETURN jsonb_build_object('ok', false, 'state', 'VERIFICATION_IN_PROGRESS');
  END IF;

  -- El certificado puede haber vencido desde que se adjuntó.
  v_val := private.arca_selfservice_validate_certificate(v_row.certificate_pem, v_row.private_key_fingerprint, v_row.subject);
  IF (v_val ->> 'ok') IS DISTINCT FROM 'true' THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_verification_failed', p_business_id, p_actor,
      coalesce(v_val ->> 'state', 'CERTIFICATE_INVALID'), v_row.private_key_fingerprint);
  END IF;

  SELECT ds.decrypted_secret INTO v_pem FROM vault.decrypted_secrets ds WHERE ds.id = v_row.private_key_secret_id;
  IF v_pem IS NULL OR private.arca_key_fingerprint(v_pem) IS DISTINCT FROM v_row.private_key_fingerprint THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_verification_failed', p_business_id, p_actor,
      'VAULT_READBACK_FAILED', v_row.private_key_fingerprint);
  END IF;

  UPDATE private.arca_credential_rotations
     SET verification_started_at = now(), updated_at = now()
   WHERE id = v_row.id;
  PERFORM private.arca_audit('arca_selfservice_verification_started', p_business_id, p_actor,
    v_row.fiscal_snapshot ->> 'ambiente', left(v_row.private_key_fingerprint, 16), 'started', NULL);

  RETURN jsonb_build_object('ok', true, 'state', 'VERIFICATION_MATERIAL',
    'ambiente', v_row.fiscal_snapshot ->> 'ambiente',
    'service', 'wsfe',
    'fingerprint', v_row.private_key_fingerprint,
    'certificate_sha256', v_row.certificate_der_sha256,
    'certificate_pem', v_row.certificate_pem,
    'signing_key_pem', v_pem);
END
$function$;

-- ── 11. RPC (e): registrar la verificación WSAA exitosa del par pendiente ───
CREATE OR REPLACE FUNCTION public.arca_selfservice_record_verification(
  p_business_id uuid, p_actor uuid, p_expected_fingerprint text, p_expected_certificate_sha256 text,
  p_token text, p_sign text, p_expires_at timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE v_row record;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'solo service_role' USING ERRCODE = '42501';
  END IF;
  IF p_business_id IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'parámetros requeridos faltantes' USING ERRCODE = '22023';
  END IF;
  IF NOT public.is_business_owner_or_admin(p_business_id, p_actor) THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_verification_failed', p_business_id, p_actor, 'UNAUTHORIZED');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('arca_rotation:' || p_business_id::text));

  IF private.arca_selfservice_is_configured(p_business_id) THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_verification_failed', p_business_id, p_actor, 'ARCA_ALREADY_CONFIGURED');
  END IF;

  SELECT r.* INTO v_row
    FROM private.arca_credential_rotations r
   WHERE r.business_id = p_business_id AND r.state = 'pending_rotation' AND r.setup_kind = 'initial'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'state', 'NO_SETUP_IN_PROGRESS');
  END IF;

  IF lower(btrim(coalesce(p_expected_fingerprint, ''))) IS DISTINCT FROM v_row.private_key_fingerprint
     OR lower(btrim(coalesce(p_expected_certificate_sha256, ''))) IS DISTINCT FROM v_row.certificate_der_sha256 THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_verification_failed', p_business_id, p_actor,
      'CERTIFICATE_CHANGED', v_row.private_key_fingerprint);
  END IF;

  IF v_row.wsaa_verified_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'state', 'ALREADY_VERIFIED');
  END IF;

  IF coalesce(btrim(p_token), '') = '' OR coalesce(btrim(p_sign), '') = ''
     OR length(p_token) > 16384 OR length(p_sign) > 4096
     OR p_expires_at IS NULL OR p_expires_at <= now() OR p_expires_at > now() + interval '12 hours 10 minutes' THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_verification_failed', p_business_id, p_actor,
      'WSAA_TICKET_INVALID', v_row.private_key_fingerprint);
  END IF;

  UPDATE private.arca_credential_rotations SET
    verified_wsaa_token         = p_token,
    verified_wsaa_sign          = p_sign,
    verified_wsaa_token_expires = p_expires_at,
    wsaa_verified_at            = now(),
    verification_started_at     = NULL,
    updated_at                  = now()
  WHERE id = v_row.id;

  PERFORM private.arca_audit('arca_selfservice_verification_succeeded', p_business_id, p_actor,
    v_row.fiscal_snapshot ->> 'ambiente', left(v_row.private_key_fingerprint, 16), 'VERIFIED', NULL);

  RETURN jsonb_build_object('ok', true, 'state', 'VERIFIED');
END
$function$;

-- ── 12. RPC (f): registrar una verificación fallida (sólo auditoría + lease) ─
CREATE OR REPLACE FUNCTION public.arca_selfservice_record_verification_failure(
  p_business_id uuid, p_actor uuid, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE v_code text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'solo service_role' USING ERRCODE = '42501';
  END IF;
  IF p_business_id IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'parámetros requeridos faltantes' USING ERRCODE = '22023';
  END IF;
  IF NOT public.is_business_owner_or_admin(p_business_id, p_actor) THEN
    RETURN jsonb_build_object('ok', false, 'state', 'UNAUTHORIZED');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('arca_rotation:' || p_business_id::text));

  v_code := CASE WHEN p_code IN ('WSAA_TICKET_ALREADY_ISSUED', 'WSAA_SERVICE_NOT_AUTHORIZED',
                                 'WSAA_CERTIFICATE_REJECTED', 'WSAA_REJECTED', 'WSAA_UNAVAILABLE',
                                 'VERIFICATION_RECORD_FAILED', 'SIGNING_FAILED')
                 THEN p_code ELSE 'WSAA_REJECTED' END;

  UPDATE private.arca_credential_rotations
     SET verification_started_at = NULL, updated_at = now()
   WHERE business_id = p_business_id AND state = 'pending_rotation' AND setup_kind = 'initial'
     AND wsaa_verified_at IS NULL;

  PERFORM private.arca_audit('arca_selfservice_verification_failed', p_business_id, p_actor, NULL, NULL, v_code, v_code);
  RETURN jsonb_build_object('ok', true, 'state', 'FAILURE_RECORDED', 'code', v_code);
END
$function$;

-- ── 13. RPC (g): ACTIVACIÓN atómica de una configuración verificada ─────────
CREATE OR REPLACE FUNCTION public.arca_selfservice_activate(
  p_business_id uuid, p_actor uuid, p_expected_fingerprint text, p_expected_certificate_sha256 text,
  p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_fp        text := lower(btrim(coalesce(p_expected_fingerprint, '')));
  v_sha       text := lower(btrim(coalesce(p_expected_certificate_sha256, '')));
  v_prev      record;
  v_row       record;
  v_cfg       record;
  v_val       jsonb;
  v_cuit      text;
  v_hash      text;
  v_readback  text;
  v_ticket_ok boolean;
  v_not_after timestamptz;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'solo service_role' USING ERRCODE = '42501';
  END IF;
  IF p_business_id IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'parámetros requeridos faltantes' USING ERRCODE = '22023';
  END IF;
  IF NOT public.is_business_owner_or_admin(p_business_id, p_actor) THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_activation_failed', p_business_id, p_actor, 'UNAUTHORIZED');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('arca_rotation:' || p_business_id::text));

  IF coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9._:-]{8,128}$' OR v_fp !~ '^[0-9a-f]{64}$' OR v_sha !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'state', 'BAD_REQUEST');
  END IF;

  -- ── Replays (antes de cualquier otra decisión) ──
  SELECT r.* INTO v_prev FROM private.arca_credential_rotations r
   WHERE r.business_id = p_business_id AND r.activation_idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_prev.setup_kind IS DISTINCT FROM 'initial' OR v_prev.state <> 'completed'
       OR v_prev.activation_request_hash IS DISTINCT FROM encode(extensions.digest(
            'arca_selfservice_activate|' || p_business_id::text || '|' || v_prev.id::text || '|' || v_fp || '|' || v_sha, 'sha256'), 'hex') THEN
      RETURN private.arca_selfservice_reject('arca_selfservice_activation_failed', p_business_id, p_actor, 'IDEMPOTENCY_CONFLICT');
    END IF;
    PERFORM private.arca_audit('arca_selfservice_activation_replayed', p_business_id, p_actor, NULL, left(v_fp, 16), 'replayed', NULL);
    RETURN jsonb_build_object('ok', true, 'state', 'ALREADY_ACTIVATED', 'expires_at', v_prev.certificate_not_after);
  END IF;
  SELECT r.* INTO v_prev
    FROM private.arca_credential_rotations r
    JOIN private.arca_private_key_credentials k
      ON k.business_id = r.business_id AND k.private_key_fingerprint = r.private_key_fingerprint
   WHERE r.business_id = p_business_id AND r.setup_kind = 'initial' AND r.state = 'completed'
     AND r.private_key_fingerprint = v_fp AND r.certificate_der_sha256 = v_sha
   ORDER BY r.finalized_at DESC NULLS LAST LIMIT 1;
  IF FOUND THEN
    PERFORM private.arca_audit('arca_selfservice_activation_replayed', p_business_id, p_actor, NULL, left(v_fp, 16), 'replayed', NULL);
    RETURN jsonb_build_object('ok', true, 'state', 'ALREADY_ACTIVATED', 'expires_at', v_prev.certificate_not_after);
  END IF;

  IF private.arca_selfservice_is_configured(p_business_id) THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_activation_failed', p_business_id, p_actor, 'ARCA_ALREADY_CONFIGURED');
  END IF;

  SELECT r.* INTO v_row
    FROM private.arca_credential_rotations r
   WHERE r.business_id = p_business_id AND r.state = 'pending_rotation' AND r.setup_kind = 'initial'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'state', 'NO_SETUP_IN_PROGRESS');
  END IF;
  IF v_row.wsaa_verified_at IS NULL OR v_row.verified_wsaa_token IS NULL OR v_row.certificate_pem IS NULL THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_activation_failed', p_business_id, p_actor, 'NOT_VERIFIED', v_row.private_key_fingerprint);
  END IF;
  IF v_row.private_key_fingerprint IS DISTINCT FROM v_fp OR v_row.certificate_der_sha256 IS DISTINCT FROM v_sha
     OR encode(extensions.digest(private.arca_pem_to_der(v_row.certificate_pem), 'sha256'), 'hex') IS DISTINCT FROM v_sha THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_activation_failed', p_business_id, p_actor, 'CERTIFICATE_CHANGED', v_row.private_key_fingerprint);
  END IF;

  SELECT c.* INTO v_cfg FROM public.arca_config c WHERE c.business_id = p_business_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_activation_failed', p_business_id, p_actor, 'FISCAL_CONFIG_MISSING', v_fp);
  END IF;

  v_val := private.arca_selfservice_validate_certificate(v_row.certificate_pem, v_fp, v_row.subject);
  IF (v_val ->> 'ok') IS DISTINCT FROM 'true' THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_activation_failed', p_business_id, p_actor,
      coalesce(v_val ->> 'state', 'CERTIFICATE_INVALID'), v_fp);
  END IF;
  IF NOT private.arca_selfservice_issuer_ok(private.arca_cert_issuer(private.arca_pem_to_der(v_row.certificate_pem)),
                                            v_row.fiscal_snapshot ->> 'ambiente') THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_activation_failed', p_business_id, p_actor, 'CERTIFICATE_ISSUER_UNEXPECTED', v_fp);
  END IF;
  v_not_after := (v_val ->> 'not_after')::timestamptz;

  -- La identidad con la que se emitirá: el CUIT del certificado verificado.
  v_cuit := private.arca_norm_cuit(v_row.subject ->> 'serialnumber');
  IF v_cuit IS NULL OR v_cuit IS DISTINCT FROM private.arca_norm_cuit(v_cfg.cuit)
     OR (coalesce(v_cfg.cuit_emisor, '') <> '' AND private.arca_norm_cuit(v_cfg.cuit_emisor) IS DISTINCT FROM v_cuit)
     OR v_cfg.ambiente IS DISTINCT FROM (v_row.fiscal_snapshot ->> 'ambiente')
     OR btrim(coalesce(v_cfg.alias, '')) IS DISTINCT FROM btrim(v_row.subject ->> 'cn') THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_activation_failed', p_business_id, p_actor, 'FISCAL_IDENTITY_MISMATCH', v_fp);
  END IF;

  SELECT ds.decrypted_secret INTO v_readback FROM vault.decrypted_secrets ds WHERE ds.id = v_row.private_key_secret_id;
  IF v_readback IS NULL OR private.arca_key_fingerprint(v_readback) IS DISTINCT FROM v_fp THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_activation_failed', p_business_id, p_actor, 'VAULT_READBACK_FAILED', v_fp);
  END IF;
  v_readback := NULL;

  -- afip-wsaa usa el cache sólo con más de 30 min de vigencia; con menos, pediría un
  -- LoginCms nuevo mientras el ticket sigue vivo (coe.alreadyAuthenticated).
  v_ticket_ok := v_row.verified_wsaa_token_expires > now() + interval '30 minutes';
  v_hash := encode(extensions.digest(
              'arca_selfservice_activate|' || p_business_id::text || '|' || v_row.id::text || '|' || v_fp || '|' || v_sha, 'sha256'), 'hex');

  BEGIN
    INSERT INTO private.arca_private_key_credentials(
      business_id, private_key_secret_id, private_key_fingerprint, certificate_fingerprint,
      key_algorithm, key_size, credential_status, created_by, updated_by)
    VALUES (p_business_id, v_row.private_key_secret_id, v_fp, v_val ->> 'fingerprint',
      coalesce(v_row.key_algorithm, 'RSA'), v_row.key_size, 'active', p_actor, p_actor);

    UPDATE public.arca_config SET
      cert_file             = v_row.certificate_pem,
      expires_at            = v_not_after,
      web_service           = 'wsfe',
      cuit_emisor           = v_cuit,
      wsaa_token            = CASE WHEN v_ticket_ok THEN v_row.verified_wsaa_token END,
      wsaa_sign             = CASE WHEN v_ticket_ok THEN v_row.verified_wsaa_sign END,
      wsaa_token_expires    = CASE WHEN v_ticket_ok THEN v_row.verified_wsaa_token_expires END,
      estado_conexion       = CASE WHEN v_ticket_ok THEN 'conectado' ELSE 'desconectado' END,
      ultima_sincronizacion = CASE WHEN v_ticket_ok THEN now() END,
      ultimo_error          = NULL,
      updated_at            = now()
    WHERE business_id = p_business_id;

    UPDATE private.arca_credential_rotations SET
      state                       = 'completed',
      activated_at                = now(),
      activated_by                = p_actor,
      finalized_at                = now(),
      finalized_by                = p_actor,
      activation_idempotency_key  = p_idempotency_key,
      activation_request_hash     = v_hash,
      certificate_not_after       = v_not_after,
      verified_wsaa_token         = NULL,
      verified_wsaa_sign          = NULL,
      verified_wsaa_token_expires = NULL,
      verification_started_at     = NULL,
      updated_at                  = now()
    WHERE id = v_row.id;

    -- Readback: la firma resuelve la clave nueva y el certificado activo le corresponde.
    v_readback := private.arca_get_private_key_for_signing(p_business_id);
    IF private.arca_key_fingerprint(v_readback) IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'activation_readback_mismatch';
    END IF;
    IF NOT private.arca_key_matches_certificate(v_readback,
             (SELECT c.cert_file FROM public.arca_config c WHERE c.business_id = p_business_id)) THEN
      RAISE EXCEPTION 'activation_pair_mismatch';
    END IF;
    v_readback := NULL;
    IF (SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id = p_business_id) <> 1 THEN
      RAISE EXCEPTION 'activation_credential_count';
    END IF;
  EXCEPTION WHEN others THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_activation_failed', p_business_id, p_actor, 'ACTIVATION_FAILED', v_fp);
  END;

  PERFORM private.arca_audit('arca_selfservice_activated', p_business_id, p_actor,
    v_row.fiscal_snapshot ->> 'ambiente', left(v_fp, 16), 'ACTIVATED', NULL);
  UPDATE private.arca_credential_audit SET details = jsonb_build_object(
      'setup_ref', left(v_row.id::text, 8),
      'wsaa_verified_at', v_row.wsaa_verified_at,
      'ticket_installed', v_ticket_ok,
      'certificate_not_after', v_not_after,
      'issuer_cn', v_row.certificate_issuer ->> 'cn',
      'idempotency_ref', left(p_idempotency_key, 12))
   WHERE id = (SELECT id FROM private.arca_credential_audit
                WHERE business_id = p_business_id AND event = 'arca_selfservice_activated'
                ORDER BY id DESC LIMIT 1);

  RETURN jsonb_build_object('ok', true, 'state', 'ACTIVATED',
    'connection', CASE WHEN v_ticket_ok THEN 'connected' ELSE 'pending_verification' END,
    'expires_at', v_not_after);
END
$function$;

-- ── 14. RPC (h): cancelar/abandonar la configuración viva ───────────────────
CREATE OR REPLACE FUNCTION public.arca_selfservice_cancel(p_business_id uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE v_row record; v_last text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'solo service_role' USING ERRCODE = '42501';
  END IF;
  IF p_business_id IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'parámetros requeridos faltantes' USING ERRCODE = '22023';
  END IF;
  IF NOT public.is_business_owner_or_admin(p_business_id, p_actor) THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_setup_failed', p_business_id, p_actor, 'UNAUTHORIZED');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('arca_rotation:' || p_business_id::text));

  SELECT r.* INTO v_row
    FROM private.arca_credential_rotations r
   WHERE r.business_id = p_business_id AND r.state = 'pending_rotation' AND r.setup_kind = 'initial'
   FOR UPDATE;
  IF NOT FOUND THEN
    SELECT r.state INTO v_last FROM private.arca_credential_rotations r
     WHERE r.business_id = p_business_id AND r.setup_kind = 'initial'
     ORDER BY r.updated_at DESC LIMIT 1;
    IF v_last = 'completed' THEN
      RETURN jsonb_build_object('ok', false, 'state', 'SETUP_ALREADY_COMPLETED');
    END IF;
    RETURN jsonb_build_object('ok', true, 'state', 'SETUP_NOT_IN_PROGRESS');
  END IF;

  -- Defensa: nunca borrar un secreto que una credencial use.
  IF EXISTS (SELECT 1 FROM private.arca_private_key_credentials k
              WHERE k.private_key_secret_id = v_row.private_key_secret_id) THEN
    RETURN private.arca_selfservice_reject('arca_selfservice_setup_failed', p_business_id, p_actor, 'SETUP_STATE_INCONSISTENT');
  END IF;

  DELETE FROM vault.secrets WHERE id = v_row.private_key_secret_id;
  UPDATE private.arca_credential_rotations SET
    state                       = 'cancelled',
    cancelled_at                = now(),
    private_key_secret_id       = NULL,
    certificate_pem             = NULL,
    verified_wsaa_token         = NULL,
    verified_wsaa_sign          = NULL,
    verified_wsaa_token_expires = NULL,
    verification_started_at     = NULL,
    updated_at                  = now()
  WHERE id = v_row.id;

  PERFORM private.arca_audit('arca_selfservice_cancelled', p_business_id, p_actor,
    v_row.fiscal_snapshot ->> 'ambiente', left(v_row.private_key_fingerprint, 16), 'SETUP_CANCELLED', NULL);
  RETURN jsonb_build_object('ok', true, 'state', 'SETUP_CANCELLED');
END
$function$;

-- ── 15. Grants: las 8 RPC son service_role-only ─────────────────────────────
DO $grants$
DECLARE v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
      'public.arca_selfservice_prepare_initial(uuid,uuid,text,text,text,text,integer,text,text,text,text)',
      'public.arca_selfservice_get_csr(uuid,uuid)',
      'public.arca_selfservice_attach_certificate(uuid,uuid,text)',
      'public.arca_selfservice_verification_material(uuid,uuid)',
      'public.arca_selfservice_record_verification(uuid,uuid,text,text,text,text,timestamptz)',
      'public.arca_selfservice_record_verification_failure(uuid,uuid,text)',
      'public.arca_selfservice_activate(uuid,uuid,text,text,text)',
      'public.arca_selfservice_cancel(uuid,uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', v_fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END
$grants$;

COMMENT ON FUNCTION public.arca_selfservice_prepare_initial(uuid,uuid,text,text,text,text,integer,text,text,text,text) IS
  'ARCA Phase 2A: prepara la configuración INICIAL (datos fiscales + clave en Vault + CSR). service_role-only, '
  'idempotente, fail-closed para negocios configurados. Nunca devuelve la clave ni el secret_id.';
COMMENT ON FUNCTION public.arca_selfservice_verification_material(uuid,uuid) IS
  'ARCA Phase 2A: material de verificación para el Edge (certificado exacto + clave pendiente) con lease de 2 min. '
  'service_role-only. La clave sólo sale si el setup todavía no está verificado.';
COMMENT ON FUNCTION public.arca_selfservice_activate(uuid,uuid,text,text,text) IS
  'ARCA Phase 2A: activación atómica de una configuración inicial verificada contra WSAA. service_role-only.';

-- ── 16. Post-condiciones duras ──────────────────────────────────────────────
DO $postcheck$
DECLARE
  v_bad  text[] := '{}';
  v_fn   text;
  v_role text;
  v_src  text;
  v_key  text;
  b      record;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
      'public.arca_selfservice_prepare_initial(uuid,uuid,text,text,text,text,integer,text,text,text,text)',
      'public.arca_selfservice_get_csr(uuid,uuid)',
      'public.arca_selfservice_attach_certificate(uuid,uuid,text)',
      'public.arca_selfservice_verification_material(uuid,uuid)',
      'public.arca_selfservice_record_verification(uuid,uuid,text,text,text,text,timestamptz)',
      'public.arca_selfservice_record_verification_failure(uuid,uuid,text)',
      'public.arca_selfservice_activate(uuid,uuid,text,text,text)',
      'public.arca_selfservice_cancel(uuid,uuid)'] LOOP
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN v_bad := v_bad || format('sin_service_role:%s', v_fn); END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN v_bad := v_bad || format('%s:%s', v_role, v_fn); END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                WHERE p.oid = v_fn::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
      v_bad := v_bad || format('PUBLIC:%s', v_fn);
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn::regprocedure) THEN v_bad := v_bad || format('no_secdef:%s', v_fn); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn::regprocedure AND proconfig @> ARRAY['search_path=pg_catalog, pg_temp']) THEN
      v_bad := v_bad || format('search_path:%s', v_fn);
    END IF;
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_fn::regprocedure;
    IF position('is_business_owner_or_admin' IN v_src) = 0 OR position('auth.role()' IN v_src) = 0 THEN
      v_bad := v_bad || format('sin_autoridad:%s', v_fn);
    END IF;
  END LOOP;

  -- Helpers privados: nadie los ejecuta.
  FOR b IN SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'private' AND p.proname IN ('arca_cuit_is_valid', 'arca_cert_issuer', 'arca_selfservice_issuer_ok',
              'arca_der_to_certificate_pem', 'arca_selfservice_validate_certificate', 'arca_selfservice_is_configured',
              'arca_selfservice_reject', 'arca_selfservice_status') LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF has_function_privilege(v_role, b.sig, 'EXECUTE') THEN v_bad := v_bad || format('%s:%s', v_role, b.sig); END IF;
    END LOOP;
  END LOOP;

  -- Phase 1: la derivación sigue sin leer material (misma lista que 20260929120000 + ticket verificado).
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'private.arca_selfservice_status(uuid,uuid,timestamptz)'::regprocedure;
  FOREACH v_key IN ARRAY ARRAY['wsaa_token', 'wsaa_sign', 'decrypted_secret', 'csr_pem', 'certificate_pem',
                               'prev_', 'pfx_password', 'ultimo_error', 'arca_get_private_key_for_signing',
                               'verified_wsaa', 'fiscal_snapshot'] LOOP
    IF position(v_key IN v_src) > 0 THEN v_bad := v_bad || format('derivacion_lee:%s', v_key); END IF;
  END LOOP;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'private.arca_selfservice_status(uuid,uuid,timestamptz)'::regprocedure) THEN
    v_bad := v_bad || 'derivacion_secdef'::text;
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_arca_selfservice_status(uuid)', 'EXECUTE') THEN
    v_bad := v_bad || 'phase1_rpc_perdida'::text;
  END IF;

  -- CUIT: casos conocidos.
  IF NOT private.arca_cuit_is_valid('20111111112') OR NOT private.arca_cuit_is_valid('20000000060')
     OR private.arca_cuit_is_valid('20111111113') OR private.arca_cuit_is_valid('99111111112')
     OR private.arca_cuit_is_valid('2011111111') THEN
    v_bad := v_bad || 'cuit_checksum'::text;
  END IF;

  -- Sin DML sobre filas existentes.
  IF (SELECT count(*) FROM private.arca_private_key_credentials) <> (SELECT creds FROM p2a_before)
     OR (SELECT count(*) FROM private.arca_credential_rotations) <> (SELECT rots FROM p2a_before)
     OR (SELECT count(*) FROM vault.secrets) <> (SELECT secrets FROM p2a_before)
     OR md5(coalesce((SELECT string_agg(t::text, '|' ORDER BY t::text) FROM public.arca_config t), '')) <> (SELECT cfg_md5 FROM p2a_before) THEN
    v_bad := v_bad || 'dml_inesperado'::text;
  END IF;

  IF array_length(v_bad, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'ARCA Phase 2A post-condición falló → %', array_to_string(v_bad, ', ');
  END IF;
  RAISE NOTICE 'ARCA Phase 2A: motor de configuración inicial instalado (8 RPC service_role-only, sin DML).';
END
$postcheck$;

COMMIT;

NOTIFY pgrst, 'reload schema';
