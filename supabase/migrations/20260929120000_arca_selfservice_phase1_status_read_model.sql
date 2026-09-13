-- ============================================================================
-- ARCA SELF-SERVICE · PHASE 1 — read model canónico de estado (SOLO LECTURA)
--
-- Una sola respuesta server-side para "¿cómo está ARCA en este negocio?". El
-- navegador deja de reconstruir el estado desde flags sueltos y texto libre
-- (estado_conexion, ultimo_error, expires_at escrito por clientes viejos).
--
-- FUENTES (nada se duplica, nada se escribe):
--   public.arca_config                     ambiente, cuit, razon_social, punto_venta,
--                                          alias, cert_file (sólo para DERIVAR), pfx_file
--                                          (presencia), estado_conexion + ultima_sincronizacion
--                                          (evidencia escrita por afip-wsaa server-side)
--   private.arca_private_key_credentials   credential_status, private_key_fingerprint,
--                                          rotated_at/created_at; vault.secrets (EXISTENCIA)
--   private.arca_credential_rotations      state, created_at (sólo filas en curso)
--   private.arca_actor_can_manage          autoridad canónica de gestión (Phase 0)
--
-- DERIVACIONES CLAVE:
--   · vencimiento = notAfter del X.509 activo (private.arca_cert_validity sobre
--     cert_file). NUNCA arca_config.expires_at: antes de Phase 0 un cliente podía
--     escribirlo.
--   · correspondencia clave↔certificado = SPKI SHA-256 del certificado contra el
--     fingerprint de la credencial activa. No descifra Vault.
--   · conexión "connected" sólo con evidencia de WSAA exitoso POSTERIOR a la
--     puesta en uso de la credencial vigente.
--
-- Lo que NUNCA sale: PEM de certificado, CSR, clave, secret_id, fingerprints,
-- token/sign WSAA, ultimo_error (texto crudo) ni estados libres.
--
-- Lo que NO toca: filas, Vault, credenciales, rotaciones, get_arca_config_safe
-- (se conserva por compatibilidad), afip-wsaa, afip-cae, emisión fiscal.
-- ============================================================================

BEGIN;

-- ── 1. Derivación pura (privada, reloj inyectable para tests) ───────────────
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
  -- es 'unknown'. Una evidencia ANTERIOR a la puesta en uso de la credencial
  -- vigente habla de otra clave: tampoco cuenta.
  IF v_configured THEN
    v_cred_since := coalesce(v_cred.rotated_at, v_cred.created_at);
    IF v_cfg.estado_conexion = 'conectado'
       AND v_cfg.ultima_sincronizacion IS NOT NULL
       AND (v_cred_since IS NULL OR v_cfg.ultima_sincronizacion >= v_cred_since) THEN
      v_conn_state := 'connected';
      v_conn_at := v_cfg.ultima_sincronizacion;
    ELSIF v_cfg.estado_conexion = 'error' THEN
      v_conn_state := 'error';
      IF v_cred_since IS NULL OR v_cfg.ultima_sincronizacion >= v_cred_since THEN
        v_conn_at := v_cfg.ultima_sincronizacion;
      END IF;
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

COMMENT ON FUNCTION private.arca_selfservice_status(uuid, uuid, timestamptz) IS
  'ARCA Phase 1: derivación pura del estado de autoservicio ARCA (reloj inyectable). '
  'Sin EXECUTE para roles cliente ni service_role. No devuelve PEM, secret_id, '
  'fingerprints, token/sign ni texto libre.';

-- ── 2. RPC pública: tenant por identidad ────────────────────────────────────
-- Lectura: miembro ACTIVO del negocio (misma semántica que get_arca_config_safe).
-- Plan sin feature 'arca': forma estable con available=false y sin metadata.
-- p_business_id es sólo confirmación: distinto del tenant resuelto = FORBIDDEN.
CREATE OR REPLACE FUNCTION public.get_arca_selfservice_status(p_business_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_actor  uuid := auth.uid();
  v_tenant uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  SELECT gp.business_id INTO v_tenant FROM public.get_my_profile() gp;

  IF v_tenant IS NULL
     OR v_tenant NOT IN (SELECT public.user_business_ids())
     OR (p_business_id IS NOT NULL AND p_business_id <> v_tenant) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF NOT public.business_has_feature('arca') THEN
    RETURN jsonb_build_object(
      'contract_version', 1,
      'available',        false,
      'status',           'unavailable',
      'configured',       false,
      'environment',      NULL,
      'cuit',             NULL,
      'razon_social',     NULL,
      'punto_venta',      NULL,
      'alias',            NULL,
      'certificate', jsonb_build_object('present', false, 'expires_at', NULL, 'days_remaining', NULL,
                                        'renewal_state', 'not_configured', 'matches_credential', false),
      'credential',  jsonb_build_object('active', false),
      'connection',  jsonb_build_object('state', 'unknown', 'last_verified_at', NULL),
      'setup',       jsonb_build_object('state', 'not_started', 'kind', NULL, 'step', NULL, 'started_at', NULL),
      'attention',        '[]'::jsonb,
      'can_manage',       false,
      'next_action',      'none');
  END IF;

  RETURN private.arca_selfservice_status(v_tenant, v_actor, now());
END
$function$;

ALTER FUNCTION public.get_arca_selfservice_status(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_arca_selfservice_status(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_arca_selfservice_status(uuid) FROM anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_arca_selfservice_status(uuid) TO authenticated;

COMMENT ON FUNCTION public.get_arca_selfservice_status(uuid) IS
  'ARCA Phase 1: estado canónico de autoservicio ARCA para el negocio del actor '
  '(tenant por identidad; p_business_id sólo confirma). Solo lectura. can_manage = '
  'private.arca_actor_can_manage. authenticated-only.';

-- ── 3. Post-condiciones duras ───────────────────────────────────────────────
DO $postcheck$
DECLARE
  v_bad  text[] := '{}';
  v_role text;
  v_src  text;
  v_key  text;
BEGIN
  IF NOT has_function_privilege('authenticated', 'public.get_arca_selfservice_status(uuid)', 'EXECUTE') THEN
    v_bad := v_bad || 'authenticated_sin_execute'::text;
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
    IF has_function_privilege(v_role, 'public.get_arca_selfservice_status(uuid)', 'EXECUTE') THEN
      v_bad := v_bad || format('%s:get_arca_selfservice_status', v_role);
    END IF;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_role, 'private.arca_selfservice_status(uuid,uuid,timestamptz)', 'EXECUTE') THEN
      v_bad := v_bad || format('%s:arca_selfservice_status', v_role);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
              WHERE p.oid IN ('public.get_arca_selfservice_status(uuid)'::regprocedure,
                              'private.arca_selfservice_status(uuid,uuid,timestamptz)'::regprocedure)
                AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    v_bad := v_bad || 'PUBLIC_execute'::text;
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.get_arca_selfservice_status(uuid)'::regprocedure) THEN
    v_bad := v_bad || 'rpc_no_secdef'::text;
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'private.arca_selfservice_status(uuid,uuid,timestamptz)'::regprocedure) THEN
    v_bad := v_bad || 'derivacion_secdef'::text;
  END IF;

  -- La derivación no LEE material que no necesita.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'private.arca_selfservice_status(uuid,uuid,timestamptz)'::regprocedure;
  FOREACH v_key IN ARRAY ARRAY['wsaa_token', 'wsaa_sign', 'decrypted_secret', 'csr_pem', 'certificate_pem',
                               'prev_', 'pfx_password', 'ultimo_error', 'arca_get_private_key_for_signing'] LOOP
    IF position(v_key IN v_src) > 0 THEN
      v_bad := v_bad || format('derivacion_lee:%s', v_key);
    END IF;
  END LOOP;

  -- Compatibilidad: el read model anterior sigue disponible.
  IF NOT has_function_privilege('authenticated', 'public.get_arca_config_safe(uuid)', 'EXECUTE') THEN
    v_bad := v_bad || 'get_arca_config_safe_perdido'::text;
  END IF;

  IF array_length(v_bad, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'ARCA Phase 1 post-condición falló → %', array_to_string(v_bad, ', ');
  END IF;
  RAISE NOTICE 'ARCA Phase 1: read model de estado instalado (authenticated-only, derivación privada).';
END
$postcheck$;

COMMIT;

NOTIFY pgrst, 'reload schema';
