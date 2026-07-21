-- ============================================================================
-- AFIP-S1A — Wrapper público de ALTA de credencial, SOLO service_role.
--
-- La Edge Function `arca-credentials` (service_role) necesita un punto de entrada
-- vía PostgREST para guardar la credencial (las RPC `private.*` no están expuestas).
-- Este wrapper vive en `public` (expuesto por PostgREST) PERO con EXECUTE únicamente
-- para service_role: anon/authenticated reciben 401/403. NO lee ni devuelve la
-- clave (eso queda en `private.arca_get_private_key_for_signing`, fuera de public).
-- Delega en la RPC privada, que crea el secreto en Vault y enlaza la fila.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.arca_store_credential(
  p_business_id uuid, p_pem text, p_fingerprint text,
  p_cert_fingerprint text DEFAULT NULL, p_algorithm text DEFAULT NULL,
  p_key_size integer DEFAULT NULL, p_actor uuid DEFAULT NULL,
  p_replace boolean DEFAULT false, p_migrated boolean DEFAULT false)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_secret_id uuid;
BEGIN
  -- Doble compuerta: EXECUTE ya está restringido a service_role, pero además se
  -- valida el rol efectivo (fail-closed) por si el grant cambiara.
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'solo service_role' USING ERRCODE='42501';
  END IF;
  IF p_replace THEN
    v_secret_id := private.arca_replace_private_key_secret(p_business_id, p_pem, p_fingerprint,
      p_cert_fingerprint, p_algorithm, p_key_size, p_actor);
  ELSE
    v_secret_id := private.arca_store_private_key_secret(p_business_id, p_pem, p_fingerprint,
      p_cert_fingerprint, p_algorithm, p_key_size, p_actor, p_migrated);
  END IF;
  RETURN v_secret_id;   -- devuelve el secret_id (uuid), NUNCA el PEM
END; $$;
ALTER FUNCTION public.arca_store_credential(uuid,text,text,text,text,integer,uuid,boolean,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.arca_store_credential(uuid,text,text,text,text,integer,uuid,boolean,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arca_store_credential(uuid,text,text,text,text,integer,uuid,boolean,boolean) TO service_role;

COMMENT ON FUNCTION public.arca_store_credential(uuid,text,text,text,text,integer,uuid,boolean,boolean) IS
  'AFIP-S1A: entrada service_role-only para la Edge arca-credentials. Guarda/rota la '
  'clave en Vault vía private.*. No devuelve el PEM. anon/authenticated: sin EXECUTE.';

-- Helper: ¿el usuario es owner o admin del negocio? Lo usa la Edge (service_role)
-- para exigir owner/admin antes de guardar credenciales.
CREATE OR REPLACE FUNCTION public.is_business_owner_or_admin(p_business_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(
    EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = p_business_id AND b.owner_user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.profiles pr
                WHERE pr.business_id = p_business_id
                  AND COALESCE(pr.user_id, pr.id) = p_user_id
                  AND COALESCE(pr.is_active, true)
                  AND pr.role IN ('owner','admin')),
    false);
$$;
ALTER FUNCTION public.is_business_owner_or_admin(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_business_owner_or_admin(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_business_owner_or_admin(uuid,uuid) TO service_role;

DO $$
DECLARE v_oid oid := to_regprocedure('public.arca_store_credential(uuid,text,text,text,text,integer,uuid,boolean,boolean)');
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'S1A: falta arca_store_credential'; END IF;
  IF to_regprocedure('public.is_business_owner_or_admin(uuid,uuid)') IS NULL THEN RAISE EXCEPTION 'S1A: falta is_business_owner_or_admin'; END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid=v_oid AND a.grantee=0 AND a.privilege_type='EXECUTE') THEN
    RAISE EXCEPTION 'S1A: arca_store_credential no debe ser ejecutable por anon/authenticated/PUBLIC';
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'S1A: service_role debe poder ejecutar arca_store_credential';
  END IF;
  RAISE NOTICE 'AFIP-S1A: arca_store_credential OK (service_role-only).';
END $$;
