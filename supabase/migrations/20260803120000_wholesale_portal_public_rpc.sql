-- ============================================================================
-- P0 Seguridad — Portal mayorista: proyeccion publica minima de `businesses`
-- FASE 1 de 2 — ADITIVA. No revoca nada, no dropea policies, no rompe el
-- frontend actual. Es seguro aplicarla en cualquier momento y por si sola.
--
-- CAUSA / RIESGO (hueco que cierra la FASE 2, habilitado por esta FASE 1):
--   La policy `businesses_portal_public_read` sobre public.businesses se creo
--   en el baseline 20260628190324 SIN clausula TO:
--
--     CREATE POLICY "businesses_portal_public_read" ON "public"."businesses"
--       FOR SELECT USING (("wholesale_portal_enabled" = true));
--
--   Sin TO, polroles queda vacio => la policy aplica a PUBLIC, es decir a
--   `anon` Y a `authenticated`. Y una policy RLS filtra FILAS, nunca COLUMNAS:
--   `anon` tiene GRANT SELECT sobre la tabla entera, asi que la policy expone
--   las 34 columnas de cada negocio con wholesale_portal_enabled = true,
--   incluyendo datos de facturacion de Mercado Pago:
--     mp_preapproval_id, mp_preapproval_plan_id, mp_payer_email,
--     mp_last_modified, last_payment_id, last_payment_status,
--     subscription_plan, subscription_status, owner_user_id, grace_until, ...
--
--   Verificado empiricamente (local, 210 migraciones, paridad con prod):
--     [1] anon         -> lee mp_payer_email / mp_preapproval_id.        LEAK
--     [2] anon         -> ENUMERA todos los negocios con el portal activo
--                         (el plan es Seq Scan + Filter: wholesale_portal_enabled;
--                         no hace falta conocer ningun slug).            LEAK
--     [3] authenticated de OTRO negocio -> lee los mismos campos.        LEAK
--         (las policies se combinan con OR: `businesses_select` da lo propio,
--          `businesses_portal_public_read` agrega lo ajeno)
--
--   El vector [3] es el mas grave y no requiere ser cliente del portal:
--   cualquier usuario logueado de cualquier tenant lee la facturacion ajena.
--
-- QUE NECESITA REALMENTE EL PORTAL PUBLICO:
--   src/portal/services/portalService.ts :: getPortalBusiness(slug) pide
--   exactamente 7 columnas, siempre filtrando por slug, y es el UNICO lector
--   de `businesses` del portal:
--     id, name, logo_url, wholesale_portal_enabled,
--     wholesale_portal_slug, wholesale_whatsapp, wholesale_portal_theme
--   (contrato tipado en src/portal/types.ts :: PortalBusiness)
--
-- POR QUE UNA RPC SECURITY DEFINER Y NO UNA VISTA:
--   1) Una vista `security_invoker` NO alcanza. `getPortalBusiness` corre en
--      CADA carga del portal, tambien con sesion iniciada (PortalContext la
--      llama en el mount; un F5 en /catalogo la ejecuta como `authenticated`),
--      asi que el lector publico puede ser `anon` O `authenticated`. Con
--      invoker, el lector necesita GRANT sobre las columnas base, y los GRANT
--      de columna son POR ROL, no por fila:
--        - `anon`          -> se le pueden dar las 7 columnas.           OK
--        - `authenticated` -> necesita mp_* de SU PROPIO negocio
--                             (src/services/subscriptionService.ts), asi que
--                             no se le puede recortar la columna.        NO
--      Cualquiera que se auto-registre en el portal (registerCustomer es
--      publico: signUp + insert) pasa a ser `authenticated`, y con una policy
--      que lo habilite a ver la fila leeria mp_payer_email salteando la vista.
--      El privilegio de columna no distingue "mi negocio" del "negocio del
--      portal": la proyeccion tiene que resolverse del lado del definidor.
--
--   2) Una vista `security_definer` cerraria el agujero, pero viola una
--      invariante del repo que ya atrapo un leak real en produccion:
--      scripts/finance/guard-view-security-invoker.mjs falla en CI ante
--      cualquier vista GRANTeada a anon/authenticated sin security_invoker.
--      Esa red no se debilita para este caso.
--
--   3) La RPC ademas es ESTRICTAMENTE mas cerrada que cualquiera de las dos
--      vistas: recibe el slug y devuelve a lo sumo una fila, con lo cual cierra
--      tambien el vector [2] (enumeracion del directorio de portales), que ni
--      la policy actual ni una vista publica impiden.
--
-- Idempotente. No modifica datos. No toca P0-A.1 ni finance_health_check_v2.
-- ============================================================================

-- ── 1. Proyeccion publica del portal mayorista ──────────────────────────────
-- SECURITY DEFINER acotado y auditable: sin SQL dinamico, lista de columnas
-- fija, un unico parametro de entrada y dos predicados. El unico privilegio que
-- presta es leer 7 columnas de un negocio con el portal ENCENDIDO.
--
-- search_path = pg_catalog, pg_temp  (idiom del repo, exigido por
-- scripts/finance/guard-security-definer.mjs): sin `public` y con TODAS las
-- referencias calificadas. `pg_temp` va explicito y ULTIMO — omitirlo no lo
-- excluye, lo pone PRIMERO (doc PG 5.9.3), que es el vector de shadowing por
-- tabla temporal.
CREATE OR REPLACE FUNCTION "public"."get_wholesale_portal_public"("p_slug" "text")
RETURNS TABLE (
  "id"                       "uuid",
  "name"                     "text",
  "logo_url"                 "text",
  "wholesale_portal_enabled" boolean,
  "wholesale_portal_slug"    "text",
  "wholesale_whatsapp"       "text",
  "wholesale_portal_theme"   "jsonb"
)
LANGUAGE "sql" STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT
    b."id",
    b."name",
    b."logo_url",
    b."wholesale_portal_enabled",
    b."wholesale_portal_slug",
    b."wholesale_whatsapp",
    b."wholesale_portal_theme"
  FROM "public"."businesses" b
  WHERE b."wholesale_portal_enabled" = true
    AND b."wholesale_portal_slug" = "p_slug"
  LIMIT 1;
$$;

ALTER FUNCTION "public"."get_wholesale_portal_public"("text") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."get_wholesale_portal_public"("text") IS
  'Proyeccion publica del portal mayorista: devuelve SOLO las 7 columnas que '
  'consume src/portal/services/portalService.ts::getPortalBusiness, y solo de '
  'un negocio con wholesale_portal_enabled = true que coincida con el slug. '
  'SECURITY DEFINER deliberado: los GRANT de columna son por rol y '
  '`authenticated` necesita mp_* de su propio negocio, asi que la proyeccion no '
  'se puede resolver con privilegios del invocador. NO agregar columnas sin '
  'revisar: es la unica superficie de `businesses` expuesta a anon.';

-- ── 2. Privilegios explicitos (fail-closed) ─────────────────────────────────
-- EXECUTE a PUBLIC es el default de PostgreSQL al crear una funcion: sin este
-- REVOKE, la RPC nace abierta a cualquier rol.
REVOKE ALL ON FUNCTION "public"."get_wholesale_portal_public"("text") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."get_wholesale_portal_public"("text") TO "anon";
GRANT EXECUTE ON FUNCTION "public"."get_wholesale_portal_public"("text") TO "authenticated";
-- service_role NO la necesita: tiene BYPASSRLS y SELECT directo sobre
-- public.businesses (comportamiento preservado, ver CASO 8 de
-- tests/sql/owner_portal_isolation.test.sql).

-- ── 3. Refrescar el schema cache de PostgREST ───────────────────────────────
-- En Supabase gestionado el event trigger ya lo hace; explicito por si la
-- migracion corre en un stack local o en una branch.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- FASE 2 (archivo aparte): 20260803130000_wholesale_portal_public_read_lockdown.sql
--   dropea la policy PUBLIC y revoca el SELECT de `anon` sobre businesses.
--   NO aplicar la FASE 2 hasta que el frontend que consume esta RPC este
--   publicado (ver cabecera de ese archivo para el orden de despliegue).
-- ============================================================================
