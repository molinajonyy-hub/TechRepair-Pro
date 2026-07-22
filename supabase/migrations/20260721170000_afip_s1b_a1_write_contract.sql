-- ============================================================================
-- AFIP-S1B-A1 — Contrato server-side de ESCRITURA de arca_config (aditivo, DB-only).
--
-- Prepara el terreno para revocar el SELECT directo (S1B-B): crea RPC SECURITY
-- DEFINER que escriben arca_config SIN que el cliente tenga SELECT (ON CONFLICT/
-- UPDATE ... WHERE requieren SELECT y hoy authenticated lo tiene; S1B-B lo revoca).
--
-- NO modifica el frontend, NO revoca SELECT, NO toca afip-wsaa/afip-cae/generate-csr/
-- arca-credentials, NO ejecuta DML sobre la fila productiva.
--
-- Allowlist de escritura NO secreta. Las RPC NUNCA aceptan ni devuelven private_key,
-- pfx, passwords, wsaa_token/sign; preservan esos campos y cuit_emisor. La carga de
-- certificado (público) va en una RPC TEMPORAL separada, a retirar en S3.
-- ============================================================================

-- ── 1. UNIQUE(business_id) — habilita upsert server-side ────────────────────
-- Preflight (prod): 1 fila, 0 business_id NULL, 0 duplicados, business_id NOT NULL.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='arca_config_business_id_key'
                   AND conrelid='public.arca_config'::regclass) THEN
    -- ALTER TABLE ADD CONSTRAINT UNIQUE toma un ACCESS EXCLUSIVE lock breve y
    -- construye el índice. Con la tabla actual (1 fila) es instantáneo; no se usa
    -- índice concurrente porque el volumen no lo justifica.
    ALTER TABLE public.arca_config ADD CONSTRAINT arca_config_business_id_key UNIQUE (business_id);
  END IF;
END $$;

-- ── 2. Auditoría: extender el allowlist de eventos (reusa la tabla de S1A) ───
ALTER TABLE private.arca_credential_audit DROP CONSTRAINT IF EXISTS arca_credential_audit_event_check;
ALTER TABLE private.arca_credential_audit ADD CONSTRAINT arca_credential_audit_event_check CHECK (event IN (
  'credential_validation_success','credential_validation_failure',
  'credential_store_success','credential_store_failure','credential_replaced','credential_deleted',
  'arca_config_legacy_saved','arca_certificate_legacy_saved','arca_estado_updated'));

-- ── 3. RPC principal: guardar configuración NO secreta ──────────────────────
-- Parámetros TIPADOS (sin jsonb libre): allowlist exacta de campos editables.
--
-- SEMÁNTICA DE NULL (verificada contra el formulario de Settings): NULL = "no
-- modificar / preservar" (COALESCE). NINGÚN campo editable requiere borrado-a-NULL:
--   · ambiente/punto_venta/web_service son NOT NULL y el form siempre los manda;
--   · alias es NOT NULL: "vaciar" es '' (string vacío, NO null) y COALESCE('',x)=''
--     lo aplica correctamente;
--   · cuit es requerido para emitir en ARCA → borrarlo no es una operación válida;
--   · razon_social/expires_at no son editables por el usuario (se cargan/derivan) →
--     se reenvían y se preservan.
-- Por eso NULL tiene UN solo significado (preservar) y no hacen falta flags de
-- clear. Si un campo futuro necesitara borrado explícito, agregar un p_clear_<campo>
-- boolean tipado (NUNCA reusar NULL con dos sentidos ni jsonb libre).
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
AS $$
DECLARE v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE='42501'; END IF;
  IF p_business_id IS NULL OR NOT public.is_business_owner_or_admin(p_business_id, v_actor) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF p_ambiente IS NOT NULL AND p_ambiente NOT IN ('homologacion','produccion') THEN
    RAISE EXCEPTION 'INVALID_AMBIENTE' USING ERRCODE='22023';
  END IF;

  INSERT INTO public.arca_config AS ac
    (business_id, cuit, razon_social, ambiente, punto_venta, web_service, alias, expires_at, updated_at)
  VALUES
    (p_business_id, p_cuit, p_razon_social,
     COALESCE(p_ambiente,'homologacion'), COALESCE(p_punto_venta,1),
     COALESCE(p_web_service,'wsfe'), COALESCE(p_alias,''), p_expires_at, now())
  ON CONFLICT (business_id) DO UPDATE SET
    cuit         = COALESCE(p_cuit,         ac.cuit),
    razon_social = COALESCE(p_razon_social, ac.razon_social),
    ambiente     = COALESCE(p_ambiente,     ac.ambiente),
    punto_venta  = COALESCE(p_punto_venta,  ac.punto_venta),
    web_service  = COALESCE(p_web_service,  ac.web_service),
    alias        = COALESCE(p_alias,        ac.alias),
    expires_at   = COALESCE(p_expires_at,   ac.expires_at),
    updated_at   = now();
  -- Nunca escribe columnas secretas ni de cache/fiscales fuera de la allowlist
  -- (clave, cert, pfx, passwords, wsaa cache, estado_conexion, cuit_emisor, created_by).

  PERFORM private.arca_audit('arca_config_legacy_saved', p_business_id, v_actor, p_ambiente, NULL, 'ok', NULL);
  RETURN jsonb_build_object('success', true, 'updated_at', now());  -- NO devuelve la fila
END; $$;
ALTER FUNCTION public.save_arca_config_legacy(uuid,text,text,text,integer,text,text,timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.save_arca_config_legacy(uuid,text,text,text,integer,text,text,timestamptz) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.save_arca_config_legacy(uuid,text,text,text,integer,text,text,timestamptz) TO authenticated;
COMMENT ON FUNCTION public.save_arca_config_legacy(uuid,text,text,text,integer,text,text,timestamptz) IS
  'AFIP-S1B-A1: escritura de configuración NO secreta (owner/admin). No acepta ni '
  'devuelve secretos; preserva cert/clave/cache. Reemplaza el DML directo del frontend.';

-- ── 4. RPC TEMPORAL: carga del certificado PÚBLICO (a retirar en S3) ────────
-- El textarea del cert en Settings escribe cert_file (público). NO acepta private_key
-- (la clave la maneja generate-csr server-side). TEMPORAL: se retira en S3 cuando la
-- carga pase por Vault/Edge.
CREATE OR REPLACE FUNCTION public.save_arca_certificate_legacy(
  p_business_id uuid, p_cert_file text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_actor uuid := auth.uid();
BEGIN  -- TEMPORAL_RETIRAR_EN_S3
  IF v_actor IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE='42501'; END IF;
  IF p_business_id IS NULL OR NOT public.is_business_owner_or_admin(p_business_id, v_actor) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF p_cert_file IS NULL OR btrim(p_cert_file) = '' THEN
    RAISE EXCEPTION 'CERT_REQUIRED' USING ERRCODE='22023';
  END IF;
  IF p_cert_file NOT LIKE '-----BEGIN CERTIFICATE-----%' THEN
    RAISE EXCEPTION 'INVALID_CERT_PEM' USING ERRCODE='22023';
  END IF;

  UPDATE public.arca_config
     SET cert_file = p_cert_file, updated_at = now()
   WHERE business_id = p_business_id;
  IF NOT FOUND THEN
    INSERT INTO public.arca_config (business_id, cert_file, updated_at) VALUES (p_business_id, p_cert_file, now());
  END IF;
  -- Solo cert_file. No toca la clave, pfx, passwords, wsaa ni estado. No devuelve el cert.

  PERFORM private.arca_audit('arca_certificate_legacy_saved', p_business_id, v_actor, NULL, NULL, 'ok', NULL);
  RETURN jsonb_build_object('success', true, 'updated_at', now());
END; $$;
ALTER FUNCTION public.save_arca_certificate_legacy(uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.save_arca_certificate_legacy(uuid,text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.save_arca_certificate_legacy(uuid,text) TO authenticated;
COMMENT ON FUNCTION public.save_arca_certificate_legacy(uuid,text) IS
  'AFIP-S1B-A1 TEMPORAL (retirar en S3): carga del certificado PÚBLICO (owner/admin). '
  'No acepta private_key ni devuelve secretos. Cuando la carga pase por Vault/Edge se elimina.';

-- ── 5. RPC: estado de conexión (lo escribe testConnection) ──────────────────
CREATE OR REPLACE FUNCTION public.set_arca_estado_conexion(
  p_business_id uuid, p_estado text, p_error text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE='42501'; END IF;
  IF p_business_id IS NULL OR NOT public.is_business_owner_or_admin(p_business_id, v_actor) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF p_estado IS NULL OR p_estado NOT IN ('conectado','desconectado','error','csr_generado','no_configurado') THEN
    RAISE EXCEPTION 'INVALID_ESTADO' USING ERRCODE='22023';
  END IF;
  UPDATE public.arca_config
     SET estado_conexion = p_estado,
         ultimo_error = CASE WHEN p_estado='error' THEN left(coalesce(p_error,''),500) ELSE NULL END,
         ultima_sincronizacion = now(), updated_at = now()
   WHERE business_id = p_business_id;
  PERFORM private.arca_audit('arca_estado_updated', p_business_id, v_actor, NULL, NULL, p_estado, NULL);
  RETURN jsonb_build_object('success', true);
END; $$;
ALTER FUNCTION public.set_arca_estado_conexion(uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_arca_estado_conexion(uuid,text,text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.set_arca_estado_conexion(uuid,text,text) TO authenticated;

-- ── 6. Post-condiciones duras ───────────────────────────────────────────────
DO $$
DECLARE r record; v_oid oid; v_bad text[] := '{}';
BEGIN
  -- unique(business_id)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='arca_config_business_id_key'
                   AND conrelid='public.arca_config'::regclass AND contype='u') THEN
    v_bad := v_bad || 'falta_unique_business_id';
  END IF;
  -- las 3 RPC: authenticated sí; PUBLIC/anon/service_role no; SECDEF; owner postgres
  FOR r IN SELECT unnest(ARRAY[
      'public.save_arca_config_legacy(uuid,text,text,text,integer,text,text,timestamptz)',
      'public.save_arca_certificate_legacy(uuid,text)',
      'public.set_arca_estado_conexion(uuid,text,text)']) AS sig
  LOOP
    v_oid := to_regprocedure(r.sig);
    IF v_oid IS NULL THEN RAISE EXCEPTION 'S1B-A1: falta %', r.sig; END IF;
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN v_bad := v_bad || (r.sig||':auth_sin_execute'); END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE')         THEN v_bad := v_bad || (r.sig||':anon'); END IF;
    IF has_function_privilege('service_role', v_oid, 'EXECUTE') THEN v_bad := v_bad || (r.sig||':service_role'); END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid=v_oid AND a.grantee=0 AND a.privilege_type='EXECUTE') THEN
      v_bad := v_bad || (r.sig||':PUBLIC'); END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=v_oid) THEN v_bad := v_bad || (r.sig||':no_secdef'); END IF;
    IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=v_oid) <> 'postgres' THEN v_bad := v_bad || (r.sig||':owner'); END IF;
    -- ninguna toca private_key en su cuerpo
    IF (SELECT prosrc FROM pg_proc WHERE oid=v_oid) ~* '\mprivate_key\M' THEN v_bad := v_bad || (r.sig||':toca_private_key'); END IF;
  END LOOP;

  IF array_length(v_bad,1) IS NOT NULL THEN
    RAISE EXCEPTION 'S1B-A1 post-condición falló → %', array_to_string(v_bad, ', ');
  END IF;
  RAISE NOTICE 'AFIP-S1B-A1: contrato de escritura OK (unique + 3 RPC authenticated/owner-admin, sin secretos).';
END $$;
