-- ============================================================================
-- ARCA SELF-SERVICE · PHASE 0 — ROLLBACK (manual, NO es una migración)
--
-- Restaura EXACTAMENTE el contrato previo a 20260928120000:
--   · is_business_owner_or_admin con su semántica original (S1A);
--   · save_arca_certificate_legacy / set_arca_estado_conexion operativas y con
--     EXECUTE a authenticated (S1B-A1);
--   · save_arca_config_legacy permisiva (S1B-A1);
--   · privilegios de tabla de anon/authenticated sobre arca_config y la policy
--     arca_config_plan_write (baseline);
--   · elimina private.arca_actor_can_manage.
--
-- ⚠️ REABRE las exposiciones que Phase 0 cerró (carga de certificado sin validar,
-- INSERT de miembro sin rol, estado escrito por el navegador). Usar solo si Phase 0
-- rompe un flujo productivo verificado y no hay un fix hacia adelante más chico.
-- Preferir rollback PARCIAL: la sección 1 (autoridad) y la 4 (tabla) son
-- independientes; revertir solo la que causa el problema.
--
-- No toca credenciales, Vault, rotaciones, cert_file ni el cache WSAA.
-- Ejecutar como postgres:  psql -v ON_ERROR_STOP=1 -f rollback.sql
-- Después: marcar la migración como revertida en el historial
--   supabase migration repair --status reverted 20260928120000
-- y redeployar el frontend anterior si el panel ARCA nuevo ya no aplica.
-- ============================================================================

BEGIN;

-- ── 1. Autoridad histórica (S1A) ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_business_owner_or_admin(p_business_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE(
    EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = p_business_id AND b.owner_user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.profiles pr
                WHERE pr.business_id = p_business_id
                  AND COALESCE(pr.user_id, pr.id) = p_user_id
                  AND COALESCE(pr.is_active, true)
                  AND pr.role IN ('owner','admin')),
    false);
$function$;
ALTER FUNCTION public.is_business_owner_or_admin(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_business_owner_or_admin(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_business_owner_or_admin(uuid, uuid) TO service_role;

-- ── 2. RPC legacy de escritura (S1B-A1) ─────────────────────────────────────
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

  PERFORM private.arca_audit('arca_config_legacy_saved', p_business_id, v_actor, p_ambiente, NULL, 'ok', NULL);
  RETURN jsonb_build_object('success', true, 'updated_at', now());
END;
$function$;
ALTER FUNCTION public.save_arca_config_legacy(uuid,text,text,text,integer,text,text,timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.save_arca_config_legacy(uuid,text,text,text,integer,text,text,timestamptz) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.save_arca_config_legacy(uuid,text,text,text,integer,text,text,timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION public.save_arca_certificate_legacy(p_business_id uuid, p_cert_file text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE v_actor uuid := auth.uid();
BEGIN
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

  PERFORM private.arca_audit('arca_certificate_legacy_saved', p_business_id, v_actor, NULL, NULL, 'ok', NULL);
  RETURN jsonb_build_object('success', true, 'updated_at', now());
END;
$function$;
ALTER FUNCTION public.save_arca_certificate_legacy(uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.save_arca_certificate_legacy(uuid,text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.save_arca_certificate_legacy(uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_arca_estado_conexion(
  p_business_id uuid, p_estado text, p_error text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
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
END;
$function$;
ALTER FUNCTION public.set_arca_estado_conexion(uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_arca_estado_conexion(uuid,text,text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.set_arca_estado_conexion(uuid,text,text) TO authenticated;

-- ── 3. Autoridad canónica: ya sin consumidores ──────────────────────────────
DROP FUNCTION IF EXISTS private.arca_actor_can_manage(uuid, uuid);

-- ── 4. Privilegios de tabla y policy de miembro (baseline) ──────────────────
-- ACL productiva medida 2026-09-12: anon=awdDxtm, authenticated=awdDxtm (m = MAINTAIN, PG17).
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.arca_config TO anon, authenticated;
DROP POLICY IF EXISTS arca_config_plan_write ON public.arca_config;
CREATE POLICY arca_config_plan_write ON public.arca_config
  USING ((business_id IN (SELECT public.user_business_ids() AS user_business_ids)) AND public.business_has_feature('arca'::text))
  WITH CHECK ((business_id IN (SELECT public.user_business_ids() AS user_business_ids)) AND public.business_has_feature('arca'::text));

COMMIT;

NOTIFY pgrst, 'reload schema';
