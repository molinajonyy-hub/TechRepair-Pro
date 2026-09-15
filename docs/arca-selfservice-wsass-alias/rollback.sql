-- ============================================================================
-- ROLLBACK REVISADO · 20261002120000_arca_selfservice_wsass_homologacion_alias
--
-- Restaura public.arca_selfservice_prepare_initial EXACTAMENTE como la dejó 20260930120000
-- (alias ^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$ en ambos ambientes). Misma firma: owner, ACL y
-- comentario se conservan. No toca el historial de migraciones ni datos.
--
-- Ojo: volver atrás reabre el hallazgo del smoke (homologación acepta alias que WSASS no puede
-- emitir). Sólo usar si la regla nueva rompe algo que no se anticipó.
-- ============================================================================

BEGIN;

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

COMMIT;

NOTIFY pgrst, 'reload schema';
