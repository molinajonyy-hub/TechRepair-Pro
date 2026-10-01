-- ============================================================================
-- PRE-BETA-3A-2S · Portal Clic: autoridad interna dedicada
--
-- CONTRATO
-- --------
--   `/portal-clic` es una herramienta INTERNA. Pertenece a exactamente UNA
--   identidad, en UN negocio, para UNA herramienta (`portal_clic`). No se
--   concede por plan (Pro/Full), por rol del tenant (owner/admin), por la
--   capacidad `wholesale`, por ser system_admin generico ni por
--   `wholesale_portal_enabled`.
--
-- DISCOVERY (ultima definicion efectiva)
-- --------------------------------------
--   · clic_wholesale_product_settings: policy cwps_owner_manage (Caso E,
--     20260629115920) = owner REAL del negocio + wholesale_portal_enabled. Es la
--     unica superficie de datos privada de AdminPortalClic (ninguna funcion de
--     la base la lee; el portal publico no la usa).
--   · storage bucket `clic-wholesale-products` (publico, imagenes): NINGUNA
--     policy de storage.objects en las migraciones. La escritura queda cerrada
--     por RLS a menos que exista una policy fuera de banda: la PRECONDICION 3
--     aborta si la hay, para no dejar una segunda autoridad permisiva.
--   · system_admins admite VARIOS usuarios y tres roles (super_admin,
--     billing_admin, support_readonly; admin_grant_role agrega mas):
--     no identifica una sola cuenta.
--   · wholesale_portal_enabled: estado del portal, lo cambia solo un platform
--     admin (trig_enforce_wholesale_portal_activation). Es ACTIVACION, no
--     AUTORIZACION: el administrador de Portal Clic tiene que poder configurarlo
--     aunque este apagado.
--
-- QUE HACE
-- --------
--   1. private.internal_tool_principals: PK tool_key (a lo sumo UN principal por
--      herramienta), user_id + business_id, active, metadata de auditoria.
--      Fuera de la API: sin grants para anon/authenticated/service_role y en el
--      schema `private` (sin USAGE para la API). user_id NO es UNIQUE: la misma
--      identidad podria administrar otra herramienta en el futuro.
--   2. private.internal_tool_principal_audit: historial append-only de altas,
--      cambios y bajas del principal (trigger).
--   3. public.current_user_has_internal_tool_access(tool_key, business_id):
--      auth.uid() = principal activo de ESA herramienta en ESE negocio, y el
--      usuario sigue siendo miembro activo (u owner registrado) del negocio.
--   4. clic_wholesale_product_settings: la policy pasa a la autoridad interna
--      (lectura Y escritura), anclada al negocio del actor.
--   5. storage `clic-wholesale-products`: SELECT/INSERT/UPDATE/DELETE para la
--      misma autoridad, sobre la carpeta del negocio. La lectura publica de las
--      imagenes (bucket publico) no cambia: el portal publico las muestra.
--
-- QUE NO HACE
-- -----------
--   · NO bindea a nadie. La tabla nace VACIA: hasta el paso de binding
--     (docs/prebeta3a2s/portal-clic-binding.sql, ejecutado por un operador con
--     postgres/service_role), Portal Clic queda cerrado para todos. No hay RPC
--     authenticated que permita auto-asignarse la herramienta.
--   · No toca el portal publico (/mayorista/:slug/*, dominio dedicado,
--     registro/login de clientes), ni wholesale_portal_enabled ni su trigger.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. PRECONDICIONES (fail-closed) ─────────────────────────────────────────
DO $pre$
DECLARE
  v_bad text;
BEGIN
  IF to_regclass('private.internal_tool_principals') IS NOT NULL
     OR to_regclass('private.internal_tool_principal_audit') IS NOT NULL
     OR to_regprocedure('public.current_user_has_internal_tool_access(text,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'PORTAL CLIC PRECONDICION 1: la autoridad interna ya existe (parcialmente)';
  END IF;

  -- La policy relevada sigue siendo la unica de la tabla.
  SELECT string_agg(policyname, ', ') INTO v_bad FROM pg_catalog.pg_policies
   WHERE schemaname = 'public' AND tablename = 'clic_wholesale_product_settings'
     AND policyname <> 'cwps_owner_manage';
  IF v_bad IS NOT NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies
      WHERE schemaname = 'public' AND tablename = 'clic_wholesale_product_settings'
        AND policyname = 'cwps_owner_manage') THEN
    RAISE EXCEPTION 'PORTAL CLIC PRECONDICION 2: policies de clic_wholesale_product_settings distintas de las relevadas (%)', v_bad;
  END IF;

  -- Ninguna policy de storage fuera de banda sobre el bucket de Portal Clic:
  -- una policy PERMISSIVE extra reabriria la escritura por OR.
  SELECT string_agg(policyname, ', ') INTO v_bad FROM pg_catalog.pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND (COALESCE(qual, '') || COALESCE(with_check, '')) LIKE '%clic-wholesale-products%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PORTAL CLIC PRECONDICION 3: storage.objects ya tiene policies sobre clic-wholesale-products (%): revisarlas a mano', v_bad;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'clic-wholesale-products') THEN
    RAISE EXCEPTION 'PORTAL CLIC PRECONDICION 4: falta el bucket clic-wholesale-products';
  END IF;

  IF to_regprocedure('public.current_user_business_id()') IS NULL THEN
    RAISE EXCEPTION 'PORTAL CLIC PRECONDICION 5: falta public.current_user_business_id()';
  END IF;
END
$pre$;

-- ── 1. Principal de herramientas internas ───────────────────────────────────
CREATE TABLE private.internal_tool_principals (
  tool_key       text        PRIMARY KEY
                             CHECK (tool_key IN ('portal_clic')),
  user_id        uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  business_id    uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  active         boolean     NOT NULL DEFAULT true,
  granted_reason text        NOT NULL CHECK (length(btrim(granted_reason)) >= 10),
  granted_by     text        NOT NULL DEFAULT current_user,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE private.internal_tool_principals OWNER TO postgres;
ALTER TABLE private.internal_tool_principals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.internal_tool_principals FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE private.internal_tool_principals IS
  'PRE-BETA-3A-2S — a lo sumo UN principal (user_id + business_id) por herramienta '
  'interna. Fuera de la API. Alta/baja solo por un operador (postgres/SQL controlado): '
  'docs/prebeta3a2s/portal-clic-binding.sql.';

CREATE TABLE private.internal_tool_principal_audit (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tool_key    text        NOT NULL,
  operation   text        NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
  old_row     jsonb,
  new_row     jsonb,
  db_user     text        NOT NULL DEFAULT current_user,
  at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE private.internal_tool_principal_audit OWNER TO postgres;
ALTER TABLE private.internal_tool_principal_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.internal_tool_principal_audit FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.internal_tool_principal_audit_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := now();
  END IF;
  INSERT INTO private.internal_tool_principal_audit(tool_key, operation, old_row, new_row)
  VALUES (COALESCE(NEW.tool_key, OLD.tool_key), TG_OP,
          CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
          CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END);
  RETURN COALESCE(NEW, OLD);
END;
$$;

ALTER FUNCTION private.internal_tool_principal_audit_write() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.internal_tool_principal_audit_write() FROM PUBLIC;

CREATE TRIGGER trig_internal_tool_principal_audit
  BEFORE INSERT OR UPDATE OR DELETE ON private.internal_tool_principals
  FOR EACH ROW EXECUTE FUNCTION private.internal_tool_principal_audit_write();

-- El historial es append-only.
CREATE FUNCTION private.internal_tool_principal_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'internal_tool_principal_audit es append-only' USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION private.internal_tool_principal_audit_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.internal_tool_principal_audit_immutable() FROM PUBLIC;

CREATE TRIGGER trig_internal_tool_principal_audit_immutable
  BEFORE UPDATE OR DELETE ON private.internal_tool_principal_audit
  FOR EACH ROW EXECUTE FUNCTION private.internal_tool_principal_audit_immutable();

-- ── 2. Helper de autoridad ──────────────────────────────────────────────────
-- Solo responde por el ACTOR (auth.uid()): no permite enumerar principales.
CREATE FUNCTION public.current_user_has_internal_tool_access(p_tool_key text, p_business_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT auth.uid() IS NOT NULL
     AND p_tool_key IS NOT NULL
     AND p_business_id IS NOT NULL
     AND EXISTS (
           SELECT 1 FROM private.internal_tool_principals t
            WHERE t.tool_key    = p_tool_key
              AND t.business_id = p_business_id
              AND t.user_id     = auth.uid()
              AND t.active)
     AND (EXISTS (SELECT 1 FROM public.businesses b
                   WHERE b.id = p_business_id AND b.owner_user_id = auth.uid())
          OR EXISTS (SELECT 1 FROM public.profiles p
                      WHERE p.business_id = p_business_id
                        AND COALESCE(p.user_id, p.id) = auth.uid()
                        AND COALESCE(p.is_active, true)));
$$;

ALTER FUNCTION public.current_user_has_internal_tool_access(text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.current_user_has_internal_tool_access(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.current_user_has_internal_tool_access(text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.current_user_has_internal_tool_access(text, uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.current_user_has_internal_tool_access(text, uuid) TO authenticated;

COMMENT ON FUNCTION public.current_user_has_internal_tool_access(text, uuid) IS
  'PRE-BETA-3A-2S — el actor es el principal ACTIVO de p_tool_key en p_business_id '
  '(private.internal_tool_principals) y sigue siendo miembro activo u owner del '
  'negocio. No depende de plan, rol del tenant, wholesale, system_admins ni '
  'wholesale_portal_enabled. Autoridad de /portal-clic (ruta, menu y datos).';

-- ── 3. Datos privados de Portal Clic ────────────────────────────────────────
DROP POLICY IF EXISTS "cwps_owner_manage" ON "public"."clic_wholesale_product_settings";
CREATE POLICY cwps_internal_tool ON public.clic_wholesale_product_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING (business_id = public.current_user_business_id()
         AND public.current_user_has_internal_tool_access('portal_clic', business_id))
  WITH CHECK (business_id = public.current_user_business_id()
              AND public.current_user_has_internal_tool_access('portal_clic', business_id));

-- ── 4. Storage de Portal Clic ───────────────────────────────────────────────
-- Ruta que escribe portalAdminService: `${businessId}/${inventoryId}/${ts}.${ext}`.
-- La carpeta raiz tiene que ser el negocio del actor y el actor el principal.
CREATE POLICY portal_clic_objects_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'clic-wholesale-products'
         AND (storage.foldername(name))[1] = (public.current_user_business_id())::text
         AND public.current_user_has_internal_tool_access('portal_clic', public.current_user_business_id()));
CREATE POLICY portal_clic_objects_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'clic-wholesale-products'
              AND (storage.foldername(name))[1] = (public.current_user_business_id())::text
              AND public.current_user_has_internal_tool_access('portal_clic', public.current_user_business_id()));
CREATE POLICY portal_clic_objects_update ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'clic-wholesale-products'
         AND (storage.foldername(name))[1] = (public.current_user_business_id())::text
         AND public.current_user_has_internal_tool_access('portal_clic', public.current_user_business_id()))
  WITH CHECK (bucket_id = 'clic-wholesale-products'
              AND (storage.foldername(name))[1] = (public.current_user_business_id())::text
              AND public.current_user_has_internal_tool_access('portal_clic', public.current_user_business_id()));
CREATE POLICY portal_clic_objects_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'clic-wholesale-products'
         AND (storage.foldername(name))[1] = (public.current_user_business_id())::text
         AND public.current_user_has_internal_tool_access('portal_clic', public.current_user_business_id()));

-- ── POSTCONDICIONES ─────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_n   bigint;
  v_cfg text[];
BEGIN
  IF has_table_privilege('anon', 'private.internal_tool_principals', 'SELECT')
     OR has_table_privilege('authenticated', 'private.internal_tool_principals', 'SELECT')
     OR has_table_privilege('authenticated', 'private.internal_tool_principals', 'INSERT')
     OR has_table_privilege('authenticated', 'private.internal_tool_principals', 'UPDATE')
     OR has_table_privilege('service_role', 'private.internal_tool_principals', 'INSERT')
     OR has_table_privilege('authenticated', 'private.internal_tool_principal_audit', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDICION 1: la API puede leer o escribir la autoridad interna';
  END IF;
  IF has_schema_privilege('authenticated', 'private', 'USAGE') OR has_schema_privilege('anon', 'private', 'USAGE') THEN
    RAISE EXCEPTION 'POSTCONDICION 1b: la API tiene USAGE sobre el schema private';
  END IF;

  SELECT count(*) INTO v_n FROM private.internal_tool_principals;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDICION 2: la migracion no debe bindear a nadie (% filas)', v_n;
  END IF;

  SELECT p.proconfig INTO v_cfg FROM pg_catalog.pg_proc p
   WHERE p.oid = 'public.current_user_has_internal_tool_access(text,uuid)'::regprocedure AND p.prosecdef;
  IF v_cfg IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
     OR has_function_privilege('anon', 'public.current_user_has_internal_tool_access(text,uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.current_user_has_internal_tool_access(text,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.current_user_has_internal_tool_access(text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION 3: helper interno sin SECDEF/search_path o con grants indebidos';
  END IF;

  -- La configuracion privada ya no depende de owner ni de wholesale_portal_enabled.
  SELECT count(*) INTO v_n FROM pg_catalog.pg_policies
   WHERE schemaname = 'public' AND tablename = 'clic_wholesale_product_settings';
  IF v_n <> 1 OR EXISTS (SELECT 1 FROM pg_catalog.pg_policies
                          WHERE schemaname = 'public' AND tablename = 'clic_wholesale_product_settings'
                            AND (policyname <> 'cwps_internal_tool'
                                 OR (COALESCE(qual, '') || COALESCE(with_check, '')) ~ '(owner_user_id|wholesale_portal_enabled)'
                                 OR COALESCE(qual, '') !~ 'current_user_has_internal_tool_access'
                                 OR COALESCE(with_check, '') !~ 'current_user_has_internal_tool_access')) THEN
    RAISE EXCEPTION 'POSTCONDICION 4: clic_wholesale_product_settings no quedo bajo la autoridad interna';
  END IF;

  SELECT count(*) INTO v_n FROM pg_catalog.pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND (COALESCE(qual, '') || COALESCE(with_check, '')) LIKE '%clic-wholesale-products%';
  IF v_n <> 4 OR EXISTS (SELECT 1 FROM pg_catalog.pg_policies
                          WHERE schemaname = 'storage' AND tablename = 'objects'
                            AND (COALESCE(qual, '') || COALESCE(with_check, '')) LIKE '%clic-wholesale-products%'
                            AND (COALESCE(qual, '') || COALESCE(with_check, '')) !~ 'current_user_has_internal_tool_access') THEN
    RAISE EXCEPTION 'POSTCONDICION 5: storage de Portal Clic sin la autoridad interna (% policies)', v_n;
  END IF;

  RAISE NOTICE 'PORTAL CLIC OK · autoridad interna dedicada · 0 principales (binding pendiente, paso manual)';
END
$post$;

COMMIT;
