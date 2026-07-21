-- ============================================================================
-- AFIP-S1A — Contrato de lectura seguro para el frontend.
--
-- public.get_arca_config_safe(p_business_id) devuelve SOLO columnas NO secretas de
-- arca_config + indicadores booleanos. NUNCA private_key, cert PEM, pfx, passwords,
-- wsaa_token/sign ni el secret_id de Vault. Reemplaza el `select('*')` del frontend.
--
-- SECURITY DEFINER con autorización interna explícita (auth.uid() + membresía +
-- feature ARCA), fail-closed, para que S1B pueda revocar el SELECT directo sobre
-- arca_config sin romper el frontend nuevo. EXECUTE solo a authenticated.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_arca_config_safe(p_business_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_row public.arca_config%ROWTYPE;
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
    'has_private_key_configured', (v_row.private_key IS NOT NULL AND btrim(v_row.private_key) <> '')
                               OR (v_row.pfx_file IS NOT NULL AND btrim(v_row.pfx_file) <> ''),
    'wsaa_token_valid',        (v_row.wsaa_token IS NOT NULL AND v_row.wsaa_token_expires IS NOT NULL
                                AND v_row.wsaa_token_expires > now())
  );
END; $$;
ALTER FUNCTION public.get_arca_config_safe(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_arca_config_safe(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_arca_config_safe(uuid) TO authenticated;

COMMENT ON FUNCTION public.get_arca_config_safe(uuid) IS
  'AFIP-S1A: contrato de lectura seguro de arca_config. Solo columnas no secretas '
  '+ booleanos (has_certificate, has_private_key_configured). NUNCA devuelve '
  'private_key, cert PEM, pfx, passwords, wsaa token/sign ni secret_id de Vault. '
  'Fail-closed: anon o negocio ajeno → NULL. Reemplaza select(*) del frontend.';

-- Post-condición
DO $$
DECLARE v_oid oid := to_regprocedure('public.get_arca_config_safe(uuid)');
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'S1A: falta get_arca_config_safe'; END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid=v_oid AND a.grantee=0 AND a.privilege_type='EXECUTE') THEN
    RAISE EXCEPTION 'S1A: get_arca_config_safe no debe ser ejecutable por anon/PUBLIC';
  END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'S1A: authenticated debe poder ejecutar get_arca_config_safe';
  END IF;
  RAISE NOTICE 'AFIP-S1A: get_arca_config_safe OK (authenticated-only, sin secretos).';
END $$;
