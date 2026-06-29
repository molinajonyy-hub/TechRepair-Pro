-- ============================================================================
-- Caso E — Endurecimiento RLS: Portal Clic privado + Mayorista operativo
-- Segunda migración "normal" posterior al baseline 20260628190324.
-- Corre DESPUÉS del guard (20260629115919_caso_e_wholesale_portal_activation_guard.sql).
--
-- CAUSA / RIESGO (hueco que cierra):
--   1) public.clic_wholesale_product_settings — la policy `cwps_admin` otorgaba
--      acceso FOR ALL (lectura Y escritura) a CUALQUIER miembro del negocio,
--      incluidos viewer/tech/cashier. La configuración editorial sensible del
--      Portal Clic podía ser leída y modificada por cualquier empleado, sin
--      exigir que el portal estuviera habilitado ni que el actor fuera el
--      propietario real (owner_user_id).
--   2) public.wholesale_customers — la policy `wc_admin` (FOR ALL) daba lectura
--      y escritura a cualquier miembro, SIN exigir la feature mayorista y SIN
--      restricción de rol (tech/cashier/viewer podían escribir).
--   3) public.wholesale_orders / public.wholesale_order_items — `wo_admin_plan`
--      y `woi_admin_plan` (FOR ALL) exigían la feature pero NO restringían la
--      escritura por rol: cualquier miembro podía crear/editar pedidos e ítems.
--
-- SOLUCIÓN:
--   - Helper centralizado e idempotente `public.can_manage_wholesale()`
--     (owner/admin/manager/sales activos) — no duplica lógica de roles.
--   - clic_wholesale_product_settings: acceso SOLO para el owner real del
--     negocio (owner_user_id = auth.uid()) con el portal habilitado
--     (wholesale_portal_enabled = true), para SELECT/INSERT/UPDATE/DELETE.
--   - Mayorista operativo: SELECT para personal legítimo (is_staff) del mismo
--     business_id con feature mayorista; escritura (INSERT/UPDATE) solo para
--     can_manage_wholesale() con feature mayorista. Aislamiento por business_id.
--   - Se preservan INTACTAS las policies cliente-facing autenticadas por
--     auth_user_id (wc_own_*, wo_customer_*, woi_customer_*).
--
-- Idempotente. No modifica datos. No toca Portal Clic de otros negocios.
-- No incluye UUID ni emails hardcodeados.
-- ============================================================================

-- ── 1. Helper centralizado de roles mayoristas ──────────────────────────────
-- owner/admin/manager/sales activos. STABLE + SECURITY INVOKER: no necesita
-- SECURITY DEFINER porque delega en public.current_user_role(), que ya es
-- SECURITY DEFINER y resuelve el rol del perfil activo. search_path fijo.
CREATE OR REPLACE FUNCTION "public"."can_manage_wholesale"() RETURNS boolean
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  SELECT coalesce(
    public.current_user_role() IN ('owner', 'admin', 'manager', 'sales'),
    false
  );
$$;

ALTER FUNCTION "public"."can_manage_wholesale"() OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."can_manage_wholesale"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."can_manage_wholesale"() TO "authenticated", "service_role";


-- ── 2. Portal Clic privado: clic_wholesale_product_settings (solo owner) ─────
DROP POLICY IF EXISTS "cwps_admin"        ON "public"."clic_wholesale_product_settings";
DROP POLICY IF EXISTS "cwps_owner_manage" ON "public"."clic_wholesale_product_settings";

CREATE POLICY "cwps_owner_manage" ON "public"."clic_wholesale_product_settings"
  AS PERMISSIVE FOR ALL TO "authenticated"
  USING (
    EXISTS (
      SELECT 1 FROM "public"."businesses" b
      WHERE b."id" = "clic_wholesale_product_settings"."business_id"
        AND b."owner_user_id" = "auth"."uid"()
        AND b."wholesale_portal_enabled" = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "public"."businesses" b
      WHERE b."id" = "clic_wholesale_product_settings"."business_id"
        AND b."owner_user_id" = "auth"."uid"()
        AND b."wholesale_portal_enabled" = true
    )
  );

-- El storefront público NO lee esta tabla (lee public.inventory). El GRANT
-- SELECT a `anon` quedaba sin ninguna policy que lo habilitara (acceso muerto);
-- se revoca para que "owner únicamente" rija también a nivel de privilegios.
-- Reversible: GRANT SELECT ON public.clic_wholesale_product_settings TO anon;
REVOKE SELECT ON TABLE "public"."clic_wholesale_product_settings" FROM "anon";


-- ── 3. Mayorista operativo ───────────────────────────────────────────────────
-- Se reemplazan las policies FOR ALL por SELECT (staff) + INSERT/UPDATE (manage).
-- Se MANTIENEN intactas las cliente-facing (auth_user_id).

-- 3.a wholesale_customers ----------------------------------------------------
DROP POLICY IF EXISTS "wc_admin"        ON "public"."wholesale_customers";
DROP POLICY IF EXISTS "wc_staff_read"   ON "public"."wholesale_customers";
DROP POLICY IF EXISTS "wc_staff_insert" ON "public"."wholesale_customers";
DROP POLICY IF EXISTS "wc_staff_update" ON "public"."wholesale_customers";

CREATE POLICY "wc_staff_read" ON "public"."wholesale_customers"
  AS PERMISSIVE FOR SELECT TO "authenticated"
  USING (
    "business_id" = "public"."current_user_business_id"()
    AND "public"."is_staff"()
    AND "public"."business_has_feature"('mayorista')
  );

CREATE POLICY "wc_staff_insert" ON "public"."wholesale_customers"
  AS PERMISSIVE FOR INSERT TO "authenticated"
  WITH CHECK (
    "business_id" = "public"."current_user_business_id"()
    AND "public"."business_has_feature"('mayorista')
    AND "public"."can_manage_wholesale"()
  );

CREATE POLICY "wc_staff_update" ON "public"."wholesale_customers"
  AS PERMISSIVE FOR UPDATE TO "authenticated"
  USING (
    "business_id" = "public"."current_user_business_id"()
    AND "public"."business_has_feature"('mayorista')
    AND "public"."can_manage_wholesale"()
  )
  WITH CHECK (
    "business_id" = "public"."current_user_business_id"()
    AND "public"."business_has_feature"('mayorista')
    AND "public"."can_manage_wholesale"()
  );

-- 3.b wholesale_orders -------------------------------------------------------
DROP POLICY IF EXISTS "wo_admin_plan"   ON "public"."wholesale_orders";
DROP POLICY IF EXISTS "wo_staff_read"   ON "public"."wholesale_orders";
DROP POLICY IF EXISTS "wo_staff_insert" ON "public"."wholesale_orders";
DROP POLICY IF EXISTS "wo_staff_update" ON "public"."wholesale_orders";

CREATE POLICY "wo_staff_read" ON "public"."wholesale_orders"
  AS PERMISSIVE FOR SELECT TO "authenticated"
  USING (
    "business_id" = "public"."current_user_business_id"()
    AND "public"."is_staff"()
    AND "public"."business_has_feature"('mayorista')
  );

CREATE POLICY "wo_staff_insert" ON "public"."wholesale_orders"
  AS PERMISSIVE FOR INSERT TO "authenticated"
  WITH CHECK (
    "business_id" = "public"."current_user_business_id"()
    AND "public"."business_has_feature"('mayorista')
    AND "public"."can_manage_wholesale"()
  );

CREATE POLICY "wo_staff_update" ON "public"."wholesale_orders"
  AS PERMISSIVE FOR UPDATE TO "authenticated"
  USING (
    "business_id" = "public"."current_user_business_id"()
    AND "public"."business_has_feature"('mayorista')
    AND "public"."can_manage_wholesale"()
  )
  WITH CHECK (
    "business_id" = "public"."current_user_business_id"()
    AND "public"."business_has_feature"('mayorista')
    AND "public"."can_manage_wholesale"()
  );

-- 3.c wholesale_order_items --------------------------------------------------
DROP POLICY IF EXISTS "woi_admin_plan"   ON "public"."wholesale_order_items";
DROP POLICY IF EXISTS "woi_staff_read"   ON "public"."wholesale_order_items";
DROP POLICY IF EXISTS "woi_staff_insert" ON "public"."wholesale_order_items";
DROP POLICY IF EXISTS "woi_staff_update" ON "public"."wholesale_order_items";

CREATE POLICY "woi_staff_read" ON "public"."wholesale_order_items"
  AS PERMISSIVE FOR SELECT TO "authenticated"
  USING (
    "business_id" = "public"."current_user_business_id"()
    AND "public"."is_staff"()
    AND "public"."business_has_feature"('mayorista')
  );

CREATE POLICY "woi_staff_insert" ON "public"."wholesale_order_items"
  AS PERMISSIVE FOR INSERT TO "authenticated"
  WITH CHECK (
    "business_id" = "public"."current_user_business_id"()
    AND "public"."business_has_feature"('mayorista')
    AND "public"."can_manage_wholesale"()
  );

CREATE POLICY "woi_staff_update" ON "public"."wholesale_order_items"
  AS PERMISSIVE FOR UPDATE TO "authenticated"
  USING (
    "business_id" = "public"."current_user_business_id"()
    AND "public"."business_has_feature"('mayorista')
    AND "public"."can_manage_wholesale"()
  )
  WITH CHECK (
    "business_id" = "public"."current_user_business_id"()
    AND "public"."business_has_feature"('mayorista')
    AND "public"."can_manage_wholesale"()
  );

-- Nota: DELETE permanece bloqueado a nivel de GRANT (authenticated solo tiene
-- SELECT/INSERT/UPDATE sobre estas tres tablas), por lo que NO se crean policies
-- DELETE (fail-closed). El comportamiento de service_role no cambia (BYPASSRLS).
-- ============================================================================
