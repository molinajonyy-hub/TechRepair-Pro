-- ============================================================================
-- AFIP-S2 — Complemento DB para que afip-wsaa lea la clave privada desde Vault.
--
-- Las RPC de lectura viven en `private` (NO expuesto por PostgREST), así que
-- afip-wsaa (cliente service_role → PostgREST) no puede llamarlas. Este lote
-- agrega el MÍNIMO complemento en `public`, service_role-only, para:
--   1. leer la credencial de firma (estructurada: distingue "no provisionada"
--      de "provisionada pero rota", para que el resolver haga fallback a legacy
--      SOLO en el primer caso y FALLE visiblemente en el segundo);
--   2. auditar qué origen usó WSAA (vault | legacy) sin filtrar secretos.
--
-- NO migra la clave productiva, NO inserta secretos en Vault, NO elimina
-- private_key de arca_config, NO toca certificados, NO cambia frontend/afip-cae/
-- generate-csr, NO ejecuta DML productivo. Reutiliza el contrato S1A tal cual.
-- ============================================================================

-- ── 1. Auditoría: extender el allowlist de eventos (reusa la tabla S1A) ──────
-- Mantiene TODOS los eventos previos (S1A + S1B-A1) y agrega los 3 de WSAA.
ALTER TABLE private.arca_credential_audit DROP CONSTRAINT IF EXISTS arca_credential_audit_event_check;
ALTER TABLE private.arca_credential_audit ADD CONSTRAINT arca_credential_audit_event_check CHECK (event IN (
  'credential_validation_success','credential_validation_failure',
  'credential_store_success','credential_store_failure','credential_replaced','credential_deleted',
  'arca_config_legacy_saved','arca_certificate_legacy_saved','arca_estado_updated',
  'wsaa_private_key_resolved_vault','wsaa_private_key_resolved_legacy','wsaa_private_key_resolution_failed'));

-- ── 2. Lectura de credencial de firma (public wrapper, service_role-only) ────
-- Devuelve jsonb ESTRUCTURADO. El PEM viaja SOLO en el resultado server-side
-- (Edge service_role); nunca se audita ni se loguea. Estados:
--   { provisioned:false }                         → resolver usa legacy plaintext
--   { provisioned:true, ok:false, reason:'not_active' }     → FALLA (no legacy)
--   { provisioned:true, ok:false, reason:'secret_missing' } → FALLA (no legacy)
--   { provisioned:true, ok:true, pem:'<PEM>' }              → usa Vault
CREATE OR REPLACE FUNCTION public.arca_get_credential_for_signing(p_business_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_secret_id uuid; v_status text; v_pem text;
BEGIN
  -- Doble compuerta: EXECUTE ya restringido a service_role + validación de rol.
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'solo service_role' USING ERRCODE='42501';
  END IF;
  IF p_business_id IS NULL THEN
    RAISE EXCEPTION 'business_id requerido' USING ERRCODE='22023';
  END IF;

  SELECT c.private_key_secret_id, c.credential_status
    INTO v_secret_id, v_status
    FROM private.arca_private_key_credentials c
    WHERE c.business_id = p_business_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('provisioned', false);   -- aún sin migrar (S3)
  END IF;
  IF v_status IS DISTINCT FROM 'active' THEN
    -- provisionada pero no activa (rotating/revoked): rota/desactivada, NO legacy.
    RETURN jsonb_build_object('provisioned', true, 'ok', false, 'reason', 'not_active');
  END IF;

  SELECT ds.decrypted_secret INTO v_pem
    FROM vault.decrypted_secrets ds WHERE ds.id = v_secret_id;
  IF v_pem IS NULL OR btrim(v_pem) = '' THEN
    RETURN jsonb_build_object('provisioned', true, 'ok', false, 'reason', 'secret_missing');
  END IF;

  RETURN jsonb_build_object('provisioned', true, 'ok', true, 'pem', v_pem);
END; $$;
ALTER FUNCTION public.arca_get_credential_for_signing(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.arca_get_credential_for_signing(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arca_get_credential_for_signing(uuid) TO service_role;
COMMENT ON FUNCTION public.arca_get_credential_for_signing(uuid) IS
  'AFIP-S2: lectura de credencial de firma para afip-wsaa (service_role-only). Devuelve '
  'jsonb estructurado; el PEM solo en el resultado server-side. anon/authenticated: sin EXECUTE.';

-- ── 3. Auditoría de origen WSAA (public wrapper, service_role-only) ──────────
CREATE OR REPLACE FUNCTION public.arca_wsaa_audit(
  p_business_id uuid, p_event text, p_source text DEFAULT NULL, p_error_code text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'solo service_role' USING ERRCODE='42501';
  END IF;
  IF p_event NOT IN ('wsaa_private_key_resolved_vault','wsaa_private_key_resolved_legacy','wsaa_private_key_resolution_failed') THEN
    RAISE EXCEPTION 'evento WSAA no permitido' USING ERRCODE='22023';
  END IF;
  -- source→status, error_code sanitizado. Sin PEM/token/sign/secret_id/CUIT.
  PERFORM private.arca_audit(p_event, p_business_id, NULL, NULL, NULL, left(coalesce(p_source,''),16), left(coalesce(p_error_code,''),40));
END; $$;
ALTER FUNCTION public.arca_wsaa_audit(uuid,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.arca_wsaa_audit(uuid,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arca_wsaa_audit(uuid,text,text,text) TO service_role;

-- ── 4. Post-condiciones duras ───────────────────────────────────────────────
DO $$
DECLARE r record; v_oid oid; v_bad text[] := '{}';
BEGIN
  FOR r IN SELECT unnest(ARRAY[
      'public.arca_get_credential_for_signing(uuid)',
      'public.arca_wsaa_audit(uuid,text,text,text)']) AS sig
  LOOP
    v_oid := to_regprocedure(r.sig);
    IF v_oid IS NULL THEN RAISE EXCEPTION 'S2: falta %', r.sig; END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE')          THEN v_bad := v_bad || (r.sig||':anon'); END IF;
    IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN v_bad := v_bad || (r.sig||':authenticated'); END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid=v_oid AND a.grantee=0 AND a.privilege_type='EXECUTE') THEN
      v_bad := v_bad || (r.sig||':PUBLIC'); END IF;
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN v_bad := v_bad || (r.sig||':service_role_MISSING'); END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=v_oid) THEN v_bad := v_bad || (r.sig||':no_secdef'); END IF;
    IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=v_oid) <> 'postgres' THEN v_bad := v_bad || (r.sig||':owner'); END IF;
  END LOOP;
  -- El contrato S1A privado no se tocó: la lectura sigue siendo service_role-only.
  IF has_function_privilege('authenticated','private.arca_get_private_key_for_signing(uuid)','EXECUTE') THEN
    v_bad := v_bad || 'private_get_signing:authenticated';
  END IF;
  IF array_length(v_bad,1) IS NOT NULL THEN
    RAISE EXCEPTION 'S2 post-condición falló → %', array_to_string(v_bad, ', ');
  END IF;
  RAISE NOTICE 'AFIP-S2: complemento de lectura Vault OK (arca_get_credential_for_signing + arca_wsaa_audit, service_role-only).';
END $$;
