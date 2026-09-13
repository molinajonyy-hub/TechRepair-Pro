-- ============================================================================
-- ARCA SELF-SERVICE · PHASE 0 — cierre de escrituras legacy + autoridad canónica
--
-- Antes de exponer autoservicio ARCA a owner/admin hay que cerrar los caminos
-- legacy que saltean la arquitectura Vault/rotación (discovery 2026-09-12):
--
--   1. save_arca_certificate_legacy reemplazaba arca_config.cert_file SIN probar
--      la correspondencia con la clave, el CUIT ni la vigencia. Un owner/admin
--      podía dejar la facturación productiva rota con un solo textarea.
--   2. save_arca_config_legacy permitía cambiar CUIT, alias, ambiente y
--      expires_at sobre una configuración con credencial activa.
--   3. anon y authenticated conservaban INSERT/UPDATE/DELETE/TRUNCATE de tabla
--      sobre arca_config, más la policy arca_config_plan_write (ALL, cualquier
--      miembro del negocio con feature 'arca', cualquier rol). El INSERT de una
--      fila inexistente era alcanzable sin SELECT. NO se probó con una escritura
--      productiva: se cierra por catálogo.
--   4. set_arca_estado_conexion dejaba al navegador escribir estado_conexion.
--
-- AUTORIDAD CANÓNICA de gestión ARCA (una sola, sin segundo motor de permisos):
--
--   perfil ACTIVO del actor EN ese negocio
--   AND rol IN ('owner','admin')
--   AND private.capability_resolve(rol, permisos, 'settings_sensitive') = true
--
-- El rol solo NO alcanza (un admin con settings_sensitive=false no pasa) y la
-- capacidad sola NO alcanza (un manager con override settings_sensitive=true no
-- pasa). Un override malformado falla cerrado, igual que authorizeArcaCaller.
--
-- `public.is_business_owner_or_admin` pasa a delegar en esa autoridad. Todos sus
-- consumidores son ARCA (rotación prepare/cancel/activate/finalize/rollback y los
-- RPC legacy): se endurecen juntos sin copiar sus cuerpos.
--
-- Lo que NO toca: la credencial activa ni Vault, private.arca_private_key_credentials,
-- private.arca_credential_rotations, cert_file/token/sign de la fila productiva,
-- get_arca_config_safe, afip-wsaa, afip-cae, la emisión fiscal, service_role.
-- No hay DML sobre filas: sólo funciones, grants y una policy.
-- ============================================================================

BEGIN;

-- ── 1. Autoridad canónica ───────────────────────────────────────────────────
-- No es SECURITY DEFINER: sólo la invocan funciones SECURITY DEFINER de
-- `postgres` (que ya leen profiles bajo su autoridad). Ningún rol cliente ni
-- service_role la ejecuta directo.
CREATE OR REPLACE FUNCTION private.arca_actor_can_manage(p_business_id uuid, p_actor uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_n     integer;
  v_role  text;
  v_perms jsonb;
BEGIN
  IF p_business_id IS NULL OR p_actor IS NULL THEN
    RETURN false;
  END IF;

  -- Perfil ACTIVO (is_active estrictamente true, como authorizeArcaCaller) del
  -- actor DENTRO de ese negocio. La propiedad del negocio por
  -- businesses.owner_user_id NO sustituye a un perfil activo.
  SELECT count(*), min(p.role), (array_agg(p.permissions))[1]
    INTO v_n, v_role, v_perms
    FROM public.profiles p
   WHERE p.business_id = p_business_id
     AND COALESCE(p.user_id, p.id) = p_actor
     AND p.is_active IS TRUE;

  -- Ambigüedad (más de un perfil activo para la misma identidad) = fail-closed.
  IF v_n IS DISTINCT FROM 1 THEN
    RETURN false;
  END IF;

  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RETURN false;
  END IF;

  -- Override ilegible: no se puede saber si restringía. Mismo contrato que
  -- _shared/arcaAuthorization.ts (el owner ignora overrides por contrato).
  IF v_role <> 'owner' AND v_perms IS NOT NULL THEN
    IF jsonb_typeof(v_perms) <> 'object' THEN
      RETURN false;
    END IF;
    IF v_perms ? 'settings_sensitive'
       AND jsonb_typeof(v_perms -> 'settings_sensitive') <> 'boolean' THEN
      RETURN false;
    END IF;
  END IF;

  RETURN private.capability_resolve(v_role, v_perms, 'settings_sensitive') IS TRUE;
END
$function$;

ALTER FUNCTION private.arca_actor_can_manage(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.arca_actor_can_manage(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.arca_actor_can_manage(uuid, uuid) FROM anon, authenticated, service_role;

COMMENT ON FUNCTION private.arca_actor_can_manage(uuid, uuid) IS
  'ARCA Phase 0: autoridad canónica de gestión ARCA. Perfil activo del actor en el '
  'negocio AND rol owner/admin AND capability_resolve(settings_sensitive). Override '
  'malformado = false. Sin EXECUTE para roles cliente ni service_role.';

-- ── 2. El helper histórico delega en la autoridad canónica ──────────────────
-- Misma firma y mismo grant (service_role-only): los consumidores (Edge de
-- rotación y RPC SECURITY DEFINER) no cambian, su decisión sí.
CREATE OR REPLACE FUNCTION public.is_business_owner_or_admin(p_business_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT private.arca_actor_can_manage(p_business_id, p_user_id);
$function$;

ALTER FUNCTION public.is_business_owner_or_admin(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_business_owner_or_admin(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_business_owner_or_admin(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.is_business_owner_or_admin(uuid, uuid) IS
  'ARCA Phase 0: delega en private.arca_actor_can_manage (perfil activo + owner/admin + '
  'settings_sensitive). Nombre histórico conservado por compatibilidad de firma. '
  'service_role-only.';

-- ── 3. RETIRO: carga legacy del certificado ─────────────────────────────────
-- Stub fail-closed (patrón generate-csr). No lee argumentos, no toca la tabla,
-- no es SECURITY DEFINER y nadie puede ejecutarlo. Se conserva la firma para que
-- una pestaña vieja reciba un error acotado en vez de un 404 ambiguo.
-- Reemplaza la RPC temporal de AFIP-S1B-A1 (TEMPORAL_RETIRAR_EN_S3).
CREATE OR REPLACE FUNCTION public.save_arca_certificate_legacy(p_business_id uuid, p_cert_file text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'ARCA_LEGACY_CERTIFICATE_WRITE_RETIRED'
    USING ERRCODE = '42501',
          HINT = 'El certificado ARCA solo se reemplaza por el flujo seguro de rotación.';
END
$function$;

ALTER FUNCTION public.save_arca_certificate_legacy(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.save_arca_certificate_legacy(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_arca_certificate_legacy(uuid, text) FROM anon, authenticated, service_role;

COMMENT ON FUNCTION public.save_arca_certificate_legacy(uuid, text) IS
  'ARCA Phase 0: RETIRADA. Reemplazaba cert_file sin validar clave/CUIT/vigencia. '
  'Stub fail-closed (ARCA_LEGACY_CERTIFICATE_WRITE_RETIRED), sin EXECUTE para nadie.';

-- ── 4. RETIRO: escritura cliente de estado_conexion ─────────────────────────
-- El estado lo escribe server-side afip-wsaa (éxito y error autorizado).
CREATE OR REPLACE FUNCTION public.set_arca_estado_conexion(p_business_id uuid, p_estado text, p_error text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'ARCA_CLIENT_CONNECTION_STATE_WRITE_RETIRED'
    USING ERRCODE = '42501',
          HINT = 'El estado de conexión ARCA lo registra el servidor.';
END
$function$;

ALTER FUNCTION public.set_arca_estado_conexion(uuid, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_arca_estado_conexion(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_arca_estado_conexion(uuid, text, text) FROM anon, authenticated, service_role;

COMMENT ON FUNCTION public.set_arca_estado_conexion(uuid, text, text) IS
  'ARCA Phase 0: RETIRADA. El navegador ya no escribe estado_conexion; lo registra '
  'afip-wsaa server-side. Stub fail-closed, sin EXECUTE para nadie.';

-- ── 5. save_arca_config_legacy: sólo configuración NO credencial ────────────
-- Firma idéntica (compatibilidad con el frontend en ambos sentidos del rollout).
--
-- Campos y reglas:
--   razon_social  → editable (dato del negocio, no forma parte del subject).
--   punto_venta   → editable, 1..99998. Cada intento de emisión snapshotea su PV
--                   al reclamar (arca_emission_attempts.punto_venta), así que un
--                   cambio no re-apunta intentos en curso; ARCA rechaza un PV no
--                   habilitado server-side.
--   cuit, alias,
--   ambiente      → editables SOLO sin identidad fiscal vigente (sin credencial
--                   activa y sin certificado). Con identidad vigente se aceptan
--                   únicamente iguales al valor guardado: cambiarlos invalidaría
--                   el certificado activo (subject CN=alias, serialNumber=CUIT)
--                   o el endpoint WSAA/WSFE.
--   web_service   → no editable: la emisión usa 'wsfe'. Solo se acepta NULL o
--                   el valor guardado.
--   expires_at    → nunca autoridad del cliente: se deriva del X.509 activo
--                   (finalización de rotación). Solo NULL o el valor guardado.
--
-- El tenant se resuelve por identidad (get_my_profile): un p_business_id
-- distinto del tenant del actor es FORBIDDEN aunque el actor sea miembro.
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

COMMENT ON FUNCTION public.save_arca_config_legacy(uuid, text, text, text, integer, text, text, timestamptz) IS
  'ARCA Phase 0: configuración NO credencial. Autoridad canónica (owner/admin + '
  'settings_sensitive, tenant por identidad). razon_social y punto_venta editables; '
  'cuit/alias/ambiente solo sin identidad fiscal vigente; web_service y expires_at nunca.';

-- ── 6. arca_config: cero escritura directa de roles cliente ─────────────────
-- Legítimos que siguen escribiendo (todos fuera de estos roles):
--   · afip-wsaa (cliente service_role): cache WSAA + estado_conexion;
--   · RPC SECURITY DEFINER de postgres: rotación activate/finalize/rollback,
--     save_arca_config_legacy;
--   · postgres (seeds/fixtures locales).
-- SELECT de cliente ya estaba revocado en AFIP-S1B-B; la lectura es por
-- get_arca_config_safe.
REVOKE ALL ON TABLE public.arca_config FROM PUBLIC;
REVOKE ALL ON TABLE public.arca_config FROM anon, authenticated;

DROP POLICY IF EXISTS arca_config_plan_write ON public.arca_config;

-- ── 7. Post-condiciones duras (abortan la transacción) ──────────────────────
DO $postcheck$
DECLARE
  v_bad  text[] := '{}';
  v_role text;
  v_priv text;
  v_col  text;
  v_pol  record;
  v_fn   text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(v_role, 'public.arca_config', v_priv) THEN
        v_bad := v_bad || format('%s:%s', v_role, v_priv);
      END IF;
    END LOOP;
    FOR v_col IN
      SELECT a.attname FROM pg_attribute a
       WHERE a.attrelid = 'public.arca_config'::regclass AND a.attnum > 0 AND NOT a.attisdropped
    LOOP
      IF has_column_privilege(v_role, 'public.arca_config', v_col, 'INSERT')
         OR has_column_privilege(v_role, 'public.arca_config', v_col, 'UPDATE')
         OR has_column_privilege(v_role, 'public.arca_config', v_col, 'SELECT') THEN
        v_bad := v_bad || format('%s:column:%s', v_role, v_col);
      END IF;
    END LOOP;
  END LOOP;

  -- Toda policy restante tiene que ser exclusivamente de service_role.
  FOR v_pol IN
    SELECT policyname, qual, with_check FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'arca_config'
  LOOP
    IF coalesce(v_pol.qual, '') !~ '^\(auth\.role\(\) = ''service_role''::text\)$' THEN
      v_bad := v_bad || format('policy_no_service_role:%s', v_pol.policyname);
    END IF;
  END LOOP;

  -- Los escritores legítimos de servidor conservan su acceso.
  IF NOT has_table_privilege('service_role', 'public.arca_config', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.arca_config', 'SELECT') THEN
    v_bad := v_bad || 'service_role_perdio_acceso';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.arca_get_credential_for_signing(uuid)', 'EXECUTE') THEN
    v_bad := v_bad || 'vault_signing_read_perdido';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_arca_config_safe(uuid)', 'EXECUTE') THEN
    v_bad := v_bad || 'read_model_perdido';
  END IF;

  -- RPC retiradas: nadie las ejecuta.
  FOREACH v_fn IN ARRAY ARRAY[
      'public.save_arca_certificate_legacy(uuid,text)',
      'public.set_arca_estado_conexion(uuid,text,text)'] LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        v_bad := v_bad || format('%s:%s', v_role, v_fn);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                WHERE p.oid = v_fn::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
      v_bad := v_bad || format('PUBLIC:%s', v_fn);
    END IF;
    IF (SELECT prosecdef FROM pg_proc WHERE oid = v_fn::regprocedure) THEN
      v_bad := v_bad || format('stub_secdef:%s', v_fn);
    END IF;
  END LOOP;

  -- Config: authenticated sí, anon/service_role/PUBLIC no.
  v_fn := 'public.save_arca_config_legacy(uuid,text,text,text,integer,text,text,timestamptz)';
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN v_bad := v_bad || 'config_sin_authenticated'; END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN v_bad := v_bad || 'config_anon'; END IF;
  IF has_function_privilege('service_role', v_fn, 'EXECUTE') THEN v_bad := v_bad || 'config_service_role'; END IF;

  -- Autoridad canónica: sin EXECUTE para roles cliente ni service_role.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_role, 'private.arca_actor_can_manage(uuid,uuid)', 'EXECUTE') THEN
      v_bad := v_bad || format('%s:arca_actor_can_manage', v_role);
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public.is_business_owner_or_admin(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.is_business_owner_or_admin(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.is_business_owner_or_admin(uuid,uuid)', 'EXECUTE') THEN
    v_bad := v_bad || 'is_business_owner_or_admin_grants';
  END IF;

  IF array_length(v_bad, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'ARCA Phase 0 post-condición falló → %', array_to_string(v_bad, ', ');
  END IF;
  RAISE NOTICE 'ARCA Phase 0: autoridad canónica, legacy retirado y arca_config sin escritura cliente.';
END
$postcheck$;

COMMIT;

NOTIFY pgrst, 'reload schema';
