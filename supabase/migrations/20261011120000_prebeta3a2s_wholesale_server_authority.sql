-- ============================================================================
-- PRE-BETA-3A-2S · Autoridad server-side de Mayorista
--
-- CONTRATO DE PRODUCTO (cerrado)
-- -------------------------------
--   PLAN   Mayorista es Pro+: Basico no, Pro si, Full si. El trial conserva la
--          semantica Pro que ya tiene cada superficie (no se crea una tercera).
--   ACTOR  owner y admin: acceso AUTOMATICO, aunque tengan un override
--          `wholesale: false`. manager/sales/tech/cashier/viewer: solo con la
--          capacidad `wholesale` EFECTIVA; ninguno la trae por defecto.
--   ESCRITURA dentro de Mayorista: owner/admin/manager/sales con acceso.
--          tech/cashier/viewer con acceso: solo lectura.
--
-- POR QUE (discovery PRE-BETA-3A-2, ultima definicion efectiva de cada objeto)
-- ---------------------------------------------------------------------------
--   1. business_has_feature('mayorista') y los RPC de features resolvian Full-only
--      (m7_7c1a / secdef_public_execute_lockdown), mientras el cliente ya es Pro+.
--   2. private.capability_resolve daba `wholesale` por defecto a admin/manager/
--      sales (sec08a_phase_b) y respetaba el override del admin: un admin con
--      `wholesale: false` quedaba afuera; manager/sales entraban sin permiso.
--   3. wc/wo/woi_staff_read (lote3) y las RPC de escritura de G2-C.1 usaban esa
--      capacidad cruda: un tech con override `wholesale: true` podia ESCRIBIR.
--   4. customers: RLS solo tenant + rol en 6 roles, sin trigger. Cualquier
--      miembro podia escribir `customer_type = 'mayorista'` por PostgREST.
--   5. private.create_comprobante_checkout_atomic (G2-C.2) aplicaba precio
--      mayorista con `customer_type = 'mayorista'` y nada mas.
--   6. La conversion portal -> customers era un INSERT directo del navegador,
--      con matching por `ilike(name)` que podia elegir otra persona.
--
-- QUE HACE
-- --------
--   A. Entitlement: una sola regla de plan (private.plan_feature_enabled) que
--      delegan business_has_feature y el nuevo private.business_feature_enabled.
--      `mayorista` pasa a la rama Pro en las tres superficies de features.
--   B. Capacidad: default de `wholesale` = solo admin (owner ya es true por el
--      atajo del nucleo). Autoridad canonica nueva, tenant-bound y fail-closed:
--        public.current_user_has_wholesale_access(p_business_id)
--        public.current_user_can_manage_wholesale(p_business_id)
--   C. wholesale_*: lectura por acceso; escritura (RPC G2-C.1) por gestion.
--   D. customers: trigger central BEFORE INSERT/UPDATE. Sin autoridad no se crea
--      ni se convierte un mayorista, ni se tocan business_name/contact_person de
--      un mayorista; los campos comunes de un mayorista historico se editan.
--   E. Checkout: precio mayorista solo con cliente mayorista Y autoridad del
--      actor. Sin autoridad NO se rechaza la venta: se resuelve precio minorista.
--   F. RPC public.get_or_create_customer_from_wholesale_atomic: la conversion
--      administrativa portal -> customers, idempotente y sin matching ambiguo.
--
-- QUE NO HACE
-- -----------
--   Cero DML sobre customers, comprobantes, stock, saldos o caja: no convierte
--   mayoristas existentes ni recalcula precios historicos (la POSTCONDICION 9
--   lo verifica con una huella de customers). No toca el portal publico
--   (registro/login/pedidos) mas alla del flag `mayorista` de su RPC de features.
--   No toca Portal Clic (migracion siguiente).
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. PRECONDICIONES (fail-closed) ─────────────────────────────────────────
DO $pre$
DECLARE
  v_pin record;
  v_md5 text;
BEGIN
  -- Cada objeto que se redefine tiene que ser EXACTAMENTE el relevado en el
  -- discovery. Una deriva fuera de banda aborta en vez de pisarla a ciegas.
  FOR v_pin IN SELECT * FROM (VALUES
    ('public.business_has_feature(text)',                                              '9a0767b84a5812ca3d91b3ce68adbb2c'),
    ('public.get_business_subscription_features(uuid)',                                '61405d1317b34f334db423854552e6e1'),
    ('public.get_wholesale_portal_features(text)',                                     '2e975d248a0efaa92b8fb25d0b3e62fc'),
    ('private.capability_resolve(text,jsonb,text)',                                    'aabb25e24b7a8f32f5ff1dda85ab5a17'),
    ('public.update_wholesale_order_status_atomic(uuid,uuid,text,text)',               '84b8327a7b610685f7cb20faf57cbc87'),
    ('public.update_wholesale_customer_status_atomic(uuid,uuid,boolean,boolean,text)', '6d6f1daa9a0611e286e698dd58763135'),
    ('public.can_manage_wholesale()',                                                  'b65efc4826fb50a6a95f12c9c44e4365'),
    ('private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)',               '8ef9e4a8e7d15df55d90eb0983996d1f')
  ) AS t(firma, md5)
  LOOP
    IF to_regprocedure(v_pin.firma) IS NULL THEN
      RAISE EXCEPTION 'PRE-BETA-3A-2S PRECONDICION 1: falta %', v_pin.firma;
    END IF;
    SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_pin.firma);
    IF v_md5 IS DISTINCT FROM v_pin.md5 THEN
      RAISE EXCEPTION 'PRE-BETA-3A-2S PRECONDICION 2: % no es la definicion relevada (md5 % <> %)', v_pin.firma, v_md5, v_pin.md5;
    END IF;
  END LOOP;

  -- Helpers de identidad y tenant que se reusan, por firma exacta.
  IF to_regprocedure('public.current_user_business_id()') IS NULL
     OR to_regprocedure('public.current_business_id()') IS NULL
     OR to_regprocedure('public._feat_pro(text,text)') IS NULL THEN
    RAISE EXCEPTION 'PRE-BETA-3A-2S PRECONDICION 3: faltan helpers de tenant/entitlement';
  END IF;

  -- Nada de este lote existe todavia (la migracion no es re-ejecutable a ciegas).
  IF to_regprocedure('private.plan_feature_enabled(text,text,text)') IS NOT NULL
     OR to_regprocedure('private.business_feature_enabled(uuid,text)') IS NOT NULL
     OR to_regprocedure('private.wholesale_access_level(uuid)') IS NOT NULL
     OR to_regprocedure('public.current_user_has_wholesale_access(uuid)') IS NOT NULL
     OR to_regprocedure('public.current_user_can_manage_wholesale(uuid)') IS NOT NULL
     OR to_regprocedure('private.enforce_customer_wholesale_authority()') IS NOT NULL
     OR to_regprocedure('public.get_or_create_customer_from_wholesale_atomic(uuid,uuid)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid = 'public.customers'::regclass
                  AND tgname = 'trig_customers_wholesale_authority') THEN
    RAISE EXCEPTION 'PRE-BETA-3A-2S PRECONDICION 4: el lote ya esta (parcialmente) aplicado';
  END IF;

  -- La columna que el trigger protege tiene el dominio relevado.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'customers'
                    AND column_name = 'customer_type' AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'PRE-BETA-3A-2S PRECONDICION 5: customers.customer_type dejo de ser NOT NULL';
  END IF;

  -- La conversion identifica al cliente del portal por email: tiene que existir.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'wholesale_customers'
                    AND column_name = 'email' AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'PRE-BETA-3A-2S PRECONDICION 6: wholesale_customers.email dejo de ser NOT NULL';
  END IF;
END
$pre$;

-- Snapshot de lo que se redefine con CREATE OR REPLACE: OID, SECURITY DEFINER,
-- owner, search_path y ACL tienen que sobrevivir (POSTCONDICION 1).
DROP TABLE IF EXISTS _p3a2s_snapshot;
CREATE TEMP TABLE _p3a2s_snapshot ON COMMIT DROP AS
SELECT p.oid, p.oid::regprocedure::text AS firma, p.prosecdef, p.proowner, p.proconfig, p.proacl
  FROM pg_catalog.pg_proc p
 WHERE p.oid IN ('public.business_has_feature(text)'::regprocedure,
                 'public.get_business_subscription_features(uuid)'::regprocedure,
                 'public.get_wholesale_portal_features(text)'::regprocedure,
                 'private.capability_resolve(text,jsonb,text)'::regprocedure,
                 'public.update_wholesale_order_status_atomic(uuid,uuid,text,text)'::regprocedure,
                 'public.update_wholesale_customer_status_atomic(uuid,uuid,boolean,boolean,text)'::regprocedure,
                 'public.can_manage_wholesale()'::regprocedure,
                 'private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)'::regprocedure);

-- Matriz del nucleo de capacidades ANTES del cambio: la POSTCONDICION 3 exige
-- que la unica diferencia sea el default de `wholesale` para manager/sales.
DROP TABLE IF EXISTS _p3a2s_capabilities;
CREATE TEMP TABLE _p3a2s_capabilities ON COMMIT DROP AS
SELECT r.role, o.label, o.perms, k.key, private.capability_resolve(r.role, o.perms, k.key) AS allowed
  FROM unnest(ARRAY['owner','admin','manager','sales','tech','cashier','viewer','desconocido', NULL]) AS r(role)
 CROSS JOIN (VALUES ('sin_override', NULL::jsonb),
                    ('todo_true',  '{"orders":true,"orders_create":true,"device_access_secret":true,"orders_change_status":true,"orders_view_financials":true,"inventory":true,"inventory_view_costs":true,"customers":true,"finance":true,"comprobantes":true,"reports":true,"settings":true,"settings_sensitive":true,"subscription":true,"users":true,"wholesale":true,"personal_finance":true}'::jsonb),
                    ('todo_false', '{"orders":false,"orders_create":false,"device_access_secret":false,"orders_change_status":false,"orders_view_financials":false,"inventory":false,"inventory_view_costs":false,"customers":false,"finance":false,"comprobantes":false,"reports":false,"settings":false,"settings_sensitive":false,"subscription":false,"users":false,"wholesale":false,"personal_finance":false}'::jsonb),
                    ('roto',       '{"wholesale":"si","finance":1}'::jsonb)) AS o(label, perms)
 CROSS JOIN unnest(ARRAY['orders','orders_create','device_access_secret','orders_change_status','orders_view_financials',
                         'inventory','inventory_view_costs','customers','finance','comprobantes','reports','settings',
                         'settings_sensitive','subscription','users','wholesale','personal_finance','clave_inexistente']) AS k(key);

-- Huella de customers: la migracion no puede escribir una sola fila.
DROP TABLE IF EXISTS _p3a2s_customers;
CREATE TEMP TABLE _p3a2s_customers ON COMMIT DROP AS
SELECT count(*) AS n,
       md5(COALESCE(string_agg(concat_ws('|', c.id, c.customer_type, c.business_name, c.contact_person, c.updated_at), ',' ORDER BY c.id), '')) AS huella
  FROM public.customers c;

-- ============================================================================
-- A. ENTITLEMENT — una sola regla de plan
-- ============================================================================
-- La MISMA regla que ya tenia business_has_feature (estado active/trialing y la
-- rama de cada feature), extraida a una funcion pura para poder (1) reusarla
-- para un negocio indicado y (2) verificar la matriz en las postcondiciones.
-- Unico cambio de semantica: `mayorista` pasa a la rama Pro.
CREATE FUNCTION private.plan_feature_enabled(p_status text, p_plan text, p_feature text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(
    p_status IN ('active', 'trialing')
    AND CASE p_feature
          WHEN 'arca'            THEN p_plan IN ('pro','full') OR p_status = 'trialing'
          WHEN 'currentAccounts' THEN p_plan IN ('pro','full') OR p_status = 'trialing'
          WHEN 'tasks'           THEN p_plan IN ('pro','full') OR p_status = 'trialing'
          WHEN 'advancedFinance' THEN p_plan IN ('pro','full') OR p_status = 'trialing'
          WHEN 'reports'         THEN p_plan IN ('pro','full') OR p_status = 'trialing'
          WHEN 'mayorista'       THEN p_plan IN ('pro','full') OR p_status = 'trialing'
          WHEN 'advancedRoles'   THEN p_plan = 'full'
          WHEN 'audit'           THEN p_plan = 'full'
          WHEN 'multisucursal'   THEN p_plan = 'full'
          ELSE true
        END,
    false);
$$;

ALTER FUNCTION private.plan_feature_enabled(text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.plan_feature_enabled(text, text, text) FROM PUBLIC;

COMMENT ON FUNCTION private.plan_feature_enabled(text, text, text) IS
  'PRE-BETA-3A-2S — unica regla de plan de business_has_feature. Pura: estado + '
  'plan + feature. mayorista es Pro+ (trial incluido). Espejo de '
  'src/config/planFeatures.ts.';

-- La misma regla, para un negocio INDICADO (no el del actor).
CREATE FUNCTION private.business_feature_enabled(p_business_id uuid, p_feature text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.businesses b
     WHERE b.id = p_business_id
       AND private.plan_feature_enabled(b.subscription_status, b.subscription_plan, p_feature)
  );
$$;

ALTER FUNCTION private.business_feature_enabled(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.business_feature_enabled(uuid, text) FROM PUBLIC;

COMMENT ON FUNCTION private.business_feature_enabled(uuid, text) IS
  'PRE-BETA-3A-2S — business_has_feature para un negocio indicado. Misma regla '
  '(private.plan_feature_enabled). Solo la llaman helpers SECURITY DEFINER.';

-- Contrato EXACTO previo (firma, SQL, STABLE SECURITY DEFINER, search_path):
-- sigue resolviendo el negocio del actor; solo delega la regla.
CREATE OR REPLACE FUNCTION public.business_has_feature(p_feature text)
  RETURNS boolean
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $function$
   SELECT private.business_feature_enabled(public.current_user_business_id(), p_feature);
 $function$;

REVOKE ALL ON FUNCTION public.business_has_feature(text) FROM PUBLIC;

-- Paywall interno del comercio: mismo cuerpo, `mayorista` a la rama Pro.
CREATE OR REPLACE FUNCTION "public"."get_business_subscription_features"("p_business_id" "uuid")
RETURNS "jsonb"
LANGUAGE "plpgsql" STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  result jsonb;
BEGIN
  PERFORM "public"."_require_business_member"("p_business_id");

  SELECT "jsonb_build_object"(
    'plan_id',       COALESCE(b."subscription_plan", 'basico'),
    'status',        COALESCE(b."subscription_status", 'trialing'),
    'access_source', b."access_source",
    'max_users',     CASE
                       WHEN b."subscription_status" = 'trialing' THEN 3
                       WHEN b."subscription_plan"   = 'full'     THEN 10
                       WHEN b."subscription_plan"   = 'pro'      THEN 3
                       ELSE 1
                     END,
    'arca',             "public"."_feat_pro"(b."subscription_status", b."subscription_plan"),
    'currentAccounts',  "public"."_feat_pro"(b."subscription_status", b."subscription_plan"),
    'reports',          "public"."_feat_pro"(b."subscription_status", b."subscription_plan"),
    'advancedFinance',  "public"."_feat_pro"(b."subscription_status", b."subscription_plan"),
    'tasks',            "public"."_feat_pro"(b."subscription_status", b."subscription_plan"),
    'personal_finance', "public"."_feat_pro"(b."subscription_status", b."subscription_plan"),
    'advancedRoles',    "public"."_feat_full"(b."subscription_status", b."subscription_plan"),
    'audit',            "public"."_feat_full"(b."subscription_status", b."subscription_plan"),
    'multisucursal',    "public"."_feat_full"(b."subscription_status", b."subscription_plan"),
    'mayorista',        "public"."_feat_pro"(b."subscription_status", b."subscription_plan")
  ) INTO result
  FROM "public"."businesses" b
  WHERE b."id" = "p_business_id";

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION "public"."get_business_subscription_features"("uuid") FROM PUBLIC;

-- Superficie del portal publico: mismo cuerpo, `mayorista` a la rama Pro. Sigue
-- respondiendo SOLO por slug exacto y portales encendidos (el flag lo cambia
-- unicamente un platform admin: trig_enforce_wholesale_portal_activation).
CREATE OR REPLACE FUNCTION "public"."get_wholesale_portal_features"("p_slug" "text")
RETURNS "jsonb"
LANGUAGE "sql" STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT "jsonb_build_object"(
    'mayorista', "public"."_feat_pro"(b."subscription_status", b."subscription_plan"),
    'active',    COALESCE(b."subscription_status", 'trialing')
                   NOT IN ('suspended', 'canceled')
  )
  FROM "public"."businesses" b
  WHERE b."wholesale_portal_enabled" = true
    AND b."wholesale_portal_slug"    = "p_slug"
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION "public"."get_wholesale_portal_features"("text") FROM PUBLIC;

-- ============================================================================
-- B. CAPACIDAD — default de `wholesale` y autoridad canonica
-- ============================================================================
-- Nucleo de capacidades: cuerpo EXACTO de SEC-08A Fase B salvo el default de
-- `wholesale` (antes admin/manager/sales; ahora solo admin, espejo de
-- ROLE_DEFAULT_PERMISSIONS). El resto de las claves no cambia (POSTCONDICION 3).
CREATE OR REPLACE FUNCTION private.capability_resolve(
  p_role text,
  p_perms jsonb,
  p_key text
) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_default boolean;
  v_override jsonb;
BEGIN
  IF p_role IS NULL OR p_key IS NULL THEN RETURN false; END IF;
  IF p_key = 'personal_finance' THEN RETURN false; END IF;

  v_default := CASE p_key
    WHEN 'orders' THEN p_role IN ('admin','manager','tech','sales','cashier','viewer')
    WHEN 'orders_create' THEN p_role IN ('admin','manager','tech','sales','cashier')
    WHEN 'device_access_secret' THEN p_role IN ('admin','manager','tech')
    WHEN 'orders_change_status' THEN p_role IN ('admin','manager','tech','sales')
    WHEN 'orders_view_financials' THEN p_role IN ('admin','manager','sales','cashier')
    WHEN 'inventory' THEN p_role IN ('admin','manager','sales')
    WHEN 'inventory_view_costs' THEN p_role IN ('admin','manager')
    WHEN 'customers' THEN p_role IN ('admin','manager','sales','cashier')
    WHEN 'finance' THEN p_role IN ('admin','cashier')
    WHEN 'comprobantes' THEN p_role IN ('admin','manager','sales','cashier')
    WHEN 'reports' THEN p_role IN ('admin','manager','cashier')
    WHEN 'settings' THEN p_role IN ('admin')
    WHEN 'settings_sensitive' THEN p_role IN ('admin')
    WHEN 'subscription' THEN false
    WHEN 'users' THEN p_role IN ('admin')
    WHEN 'personal_finance' THEN false
    WHEN 'wholesale' THEN p_role IN ('admin')
    ELSE NULL
  END;

  IF v_default IS NULL THEN RETURN false; END IF;
  IF p_role = 'owner' THEN RETURN true; END IF;

  IF p_perms IS NOT NULL AND jsonb_typeof(p_perms) = 'object' THEN
    v_override := p_perms -> p_key;
    IF v_override IS NOT NULL AND jsonb_typeof(v_override) = 'boolean' THEN
      RETURN (v_override)::text::boolean;
    END IF;
  END IF;

  RETURN v_default;
END;
$$;

REVOKE ALL ON FUNCTION private.capability_resolve(text, jsonb, text) FROM PUBLIC;

-- Nivel de acceso a Mayorista del actor EN un negocio indicado.
--   'none'   · sin sesion, negocio nulo, sin la feature, sin perfil activo o
--              sin la capacidad.
--   'manage' · con acceso y rol que escribe (owner/admin/manager/sales).
--   'read'   · con acceso y rol de solo lectura (tech/cashier/viewer).
-- owner (rol o dueno registrado) y admin: acceso automatico, NO consultan la
-- capacidad, asi que un override `wholesale: false` no los saca. Identidad
-- canonica COALESCE(user_id, id) = auth.uid(), perfil ACTIVO de ESE negocio
-- (mismo patron que current_user_can_in_business): nunca toma el rol de otro
-- tenant.
CREATE FUNCTION private.wholesale_access_level(p_business_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_role  text;
  v_perms jsonb;
BEGIN
  IF v_uid IS NULL OR p_business_id IS NULL THEN RETURN 'none'; END IF;
  IF NOT private.business_feature_enabled(p_business_id, 'mayorista') THEN RETURN 'none'; END IF;

  IF EXISTS (SELECT 1 FROM public.businesses b
              WHERE b.id = p_business_id AND b.owner_user_id = v_uid) THEN
    RETURN 'manage';
  END IF;

  SELECT p.role, p.permissions INTO v_role, v_perms
    FROM public.profiles p
   WHERE p.business_id = p_business_id
     AND COALESCE(p.user_id, p.id) = v_uid
     AND COALESCE(p.is_active, true)
   ORDER BY COALESCE(p.updated_at, p.created_at, now()) DESC
   LIMIT 1;

  IF v_role IS NULL THEN RETURN 'none'; END IF;

  IF v_role NOT IN ('owner', 'admin')
     AND NOT private.capability_resolve(v_role, v_perms, 'wholesale') THEN
    RETURN 'none';
  END IF;

  IF v_role IN ('owner', 'admin', 'manager', 'sales') THEN RETURN 'manage'; END IF;
  IF v_role IN ('tech', 'cashier', 'viewer') THEN RETURN 'read'; END IF;
  RETURN 'none';
END;
$$;

ALTER FUNCTION private.wholesale_access_level(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.wholesale_access_level(uuid) FROM PUBLIC;

COMMENT ON FUNCTION private.wholesale_access_level(uuid) IS
  'PRE-BETA-3A-2S — nucleo de la autoridad Mayorista: none | read | manage. '
  'Feature Pro+ del negocio indicado + owner/admin automatico o capacidad '
  '`wholesale` efectiva; escritura solo owner/admin/manager/sales.';

CREATE FUNCTION public.current_user_has_wholesale_access(p_business_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT private.wholesale_access_level(p_business_id) IN ('read', 'manage');
$$;

ALTER FUNCTION public.current_user_has_wholesale_access(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.current_user_has_wholesale_access(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.current_user_has_wholesale_access(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.current_user_has_wholesale_access(uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.current_user_has_wholesale_access(uuid) TO authenticated;

COMMENT ON FUNCTION public.current_user_has_wholesale_access(uuid) IS
  'PRE-BETA-3A-2S — autoridad canonica de ACCESO a Mayorista del actor en '
  'p_business_id: feature mayorista (Pro+) Y (owner | admin | capacidad '
  'wholesale efectiva). Fail-closed. Espejo de canAccessWholesale() en '
  'src/lib/permissions/wholesalePermissions.ts.';

CREATE FUNCTION public.current_user_can_manage_wholesale(p_business_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT private.wholesale_access_level(p_business_id) = 'manage';
$$;

ALTER FUNCTION public.current_user_can_manage_wholesale(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.current_user_can_manage_wholesale(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.current_user_can_manage_wholesale(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.current_user_can_manage_wholesale(uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.current_user_can_manage_wholesale(uuid) TO authenticated;

COMMENT ON FUNCTION public.current_user_can_manage_wholesale(uuid) IS
  'PRE-BETA-3A-2S — autoridad canonica de ESCRITURA en Mayorista: acceso (ver '
  'current_user_has_wholesale_access) Y rol owner/admin/manager/sales. Espejo '
  'de canManageWholesale().';

-- El helper por ROL de Caso E ya no lo usa ninguna policy ni funcion (relevado);
-- se lo alinea para que nadie lo vuelva a usar como una segunda matriz.
CREATE OR REPLACE FUNCTION "public"."can_manage_wholesale"() RETURNS boolean
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  SELECT public.current_user_can_manage_wholesale(public.current_user_business_id());
$$;

-- ============================================================================
-- C. wholesale_* — lectura por acceso, escritura por gestion
-- ============================================================================
DROP POLICY IF EXISTS wc_staff_read ON public.wholesale_customers;
CREATE POLICY wc_staff_read ON public.wholesale_customers FOR SELECT TO authenticated
  USING (business_id = public.current_business_id()
    AND public.current_user_has_wholesale_access(business_id));
DROP POLICY IF EXISTS wo_staff_read ON public.wholesale_orders;
CREATE POLICY wo_staff_read ON public.wholesale_orders FOR SELECT TO authenticated
  USING (business_id = public.current_business_id()
    AND public.current_user_has_wholesale_access(business_id));
DROP POLICY IF EXISTS woi_staff_read ON public.wholesale_order_items;
CREATE POLICY woi_staff_read ON public.wholesale_order_items FOR SELECT TO authenticated
  USING (business_id = public.current_business_id()
    AND public.current_user_has_wholesale_access(business_id));

-- Las dos escrituras administrativas de G2-C.1: mismo cuerpo, autoridad nueva.
-- Antes: current_user_can_in_business(p_business_id, 'wholesale'), que dejaba
-- escribir a un tech con override y afuera a un admin con override false.
CREATE OR REPLACE FUNCTION public.update_wholesale_order_status_atomic(
  p_business_id uuid,
  p_order_id    uuid,
  p_status      text,
  p_admin_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor   uuid := auth.uid();
  v_order   record;
  v_notes   text;
  v_changed boolean;
  v_updated timestamptz;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_business_id IS NULL OR p_order_id IS NULL THEN
    RAISE EXCEPTION 'business_id y order_id son obligatorios' USING ERRCODE = '22023';
  END IF;

  IF public.current_user_business_id() IS DISTINCT FROM p_business_id THEN
    -- Generico a proposito: no confirma si el negocio o el pedido existen.
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  IF NOT private.business_feature_enabled(p_business_id, 'mayorista') THEN
    RAISE EXCEPTION 'Forbidden: el plan del negocio no incluye el modulo mayorista'
      USING ERRCODE = '42501';
  END IF;
  IF NOT public.current_user_can_manage_wholesale(p_business_id) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_status IS NULL OR p_status NOT IN (
       'pending_whatsapp', 'pending_review', 'approved', 'rejected',
       'invoiced', 'delivered', 'cancelled') THEN
    RAISE EXCEPTION 'INVALID_STATUS: %', COALESCE(p_status, '(null)') USING ERRCODE = '22023';
  END IF;

  -- El pedido, de ESTE negocio, bloqueado hasta el COMMIT. Un pedido de otro
  -- tenant es indistinguible de uno inexistente.
  SELECT o.id, o.status, o.admin_notes, o.updated_at
    INTO v_order
    FROM public.wholesale_orders o
   WHERE o.id = p_order_id
     AND o.business_id = p_business_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WHOLESALE_ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  v_notes := CASE
               WHEN p_admin_notes IS NULL THEN v_order.admin_notes
               ELSE NULLIF(btrim(p_admin_notes), '')
             END;
  v_changed := v_order.status IS DISTINCT FROM p_status
            OR v_order.admin_notes IS DISTINCT FROM v_notes;

  IF v_changed THEN
    UPDATE public.wholesale_orders
       SET status      = p_status,
           admin_notes = v_notes,
           updated_at  = now()
     WHERE id = v_order.id
    RETURNING updated_at INTO v_updated;
  ELSE
    v_updated := v_order.updated_at;
  END IF;

  RETURN jsonb_build_object(
    'ok',              true,
    'order_id',        v_order.id,
    'business_id',     p_business_id,
    'status',          p_status,
    'previous_status', v_order.status,
    'admin_notes',     v_notes,
    'changed',         v_changed,
    'updated_at',      v_updated
  );
END;
$$;

REVOKE ALL ON FUNCTION public.update_wholesale_order_status_atomic(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_wholesale_order_status_atomic(uuid, uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.update_wholesale_order_status_atomic(uuid, uuid, text, text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.update_wholesale_order_status_atomic(uuid, uuid, text, text) TO authenticated;

COMMENT ON FUNCTION public.update_wholesale_order_status_atomic(uuid, uuid, text, text) IS
  'G2-C.1 / PRE-BETA-3A-2S — unica escritura administrativa de '
  'wholesale_orders.status/admin_notes. Autoridad: negocio del actor + feature '
  'mayorista + current_user_can_manage_wholesale(p_business_id). Bloquea el pedido '
  '(FOR UPDATE). NO mueve stock. Idempotente ante el mismo estado.';

CREATE OR REPLACE FUNCTION public.update_wholesale_customer_status_atomic(
  p_business_id uuid,
  p_customer_id uuid,
  p_approved    boolean DEFAULT NULL,
  p_suspended   boolean DEFAULT NULL,
  p_notes       text    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor     uuid := auth.uid();
  v_c         record;
  v_approved  boolean;
  v_suspended boolean;
  v_notes     text;
  v_changed   boolean;
  v_updated   timestamptz;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_business_id IS NULL OR p_customer_id IS NULL THEN
    RAISE EXCEPTION 'business_id y customer_id son obligatorios' USING ERRCODE = '22023';
  END IF;

  -- Misma autoridad que el cambio de estado de pedidos.
  IF public.current_user_business_id() IS DISTINCT FROM p_business_id THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  IF NOT private.business_feature_enabled(p_business_id, 'mayorista') THEN
    RAISE EXCEPTION 'Forbidden: el plan del negocio no incluye el modulo mayorista'
      USING ERRCODE = '42501';
  END IF;
  IF NOT public.current_user_can_manage_wholesale(p_business_id) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT wc.id, wc.approved, wc.suspended, wc.notes, wc.updated_at
    INTO v_c
    FROM public.wholesale_customers wc
   WHERE wc.id = p_customer_id
     AND wc.business_id = p_business_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WHOLESALE_CUSTOMER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- NULL conserva; notas en blanco se borran.
  v_approved  := COALESCE(p_approved,  v_c.approved);
  v_suspended := COALESCE(p_suspended, v_c.suspended);
  v_notes     := CASE WHEN p_notes IS NULL THEN v_c.notes ELSE NULLIF(btrim(p_notes), '') END;
  v_changed   := v_approved  IS DISTINCT FROM v_c.approved
              OR v_suspended IS DISTINCT FROM v_c.suspended
              OR v_notes     IS DISTINCT FROM v_c.notes;

  IF v_changed THEN
    UPDATE public.wholesale_customers
       SET approved   = v_approved,
           suspended  = v_suspended,
           notes      = v_notes,
           updated_at = now()
     WHERE id = v_c.id
    RETURNING updated_at INTO v_updated;
  ELSE
    v_updated := v_c.updated_at;
  END IF;

  RETURN jsonb_build_object(
    'ok',          true,
    'customer_id', v_c.id,
    'business_id', p_business_id,
    'approved',    v_approved,
    'suspended',   v_suspended,
    'notes',       v_notes,
    'changed',     v_changed,
    'updated_at',  v_updated
  );
END;
$$;

REVOKE ALL ON FUNCTION public.update_wholesale_customer_status_atomic(uuid, uuid, boolean, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_wholesale_customer_status_atomic(uuid, uuid, boolean, boolean, text) FROM anon;
REVOKE ALL ON FUNCTION public.update_wholesale_customer_status_atomic(uuid, uuid, boolean, boolean, text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.update_wholesale_customer_status_atomic(uuid, uuid, boolean, boolean, text) TO authenticated;

COMMENT ON FUNCTION public.update_wholesale_customer_status_atomic(uuid, uuid, boolean, boolean, text) IS
  'G2-C.1 / PRE-BETA-3A-2S — unica escritura administrativa de wholesale_customers '
  '(approved, suspended, notes). Autoridad: negocio del actor + feature mayorista + '
  'current_user_can_manage_wholesale(p_business_id). Bloquea la fila. Idempotente.';

-- ============================================================================
-- D. customers — autoridad central de la clasificacion mayorista
-- ============================================================================
-- Un trigger, no una policy: la regla compara OLD con NEW (preservacion de un
-- mayorista historico), y tiene que valer para PostgREST, para cualquier RPC y
-- para cualquier cliente futuro. La RLS de customers (tenant + rol) no cambia.
--
-- Sin autoridad Mayorista del actor en el negocio de la fila:
--   INSERT  customer_type = 'mayorista'                  -> 42501
--   UPDATE  cambia customer_type (en cualquier sentido)  -> 42501
--   UPDATE  de un mayorista que cambia business_name o
--           contact_person                               -> 42501
--   UPDATE  de campos comunes (de minorista o de un mayorista historico): pasa.
-- Nunca convierte ni borra nada: rechaza o deja pasar la fila tal cual vino.
--
-- Backend confiable sin identidad de usuario final (migraciones, SQL editor,
-- service_role): sin auth.uid() no hay actor que autorizar. Mismo allowlist
-- explicito que trig_enforce_wholesale_portal_activation.
CREATE FUNCTION private.enforce_customer_wholesale_authority()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL AND current_user IN ('postgres', 'supabase_admin', 'service_role') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.customer_type = 'mayorista'
       AND NOT public.current_user_has_wholesale_access(NEW.business_id) THEN
      RAISE EXCEPTION 'WHOLESALE_AUTHORITY_REQUIRED: crear un cliente mayorista requiere acceso Mayorista'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE que no toca la clasificacion ni los datos de un mayorista: comun.
  IF NEW.customer_type IS NOT DISTINCT FROM OLD.customer_type
     AND NEW.business_id IS NOT DISTINCT FROM OLD.business_id
     AND (OLD.customer_type IS DISTINCT FROM 'mayorista'
          OR (NEW.business_name  IS NOT DISTINCT FROM OLD.business_name
              AND NEW.contact_person IS NOT DISTINCT FROM OLD.contact_person)) THEN
    RETURN NEW;
  END IF;

  IF public.current_user_has_wholesale_access(OLD.business_id)
     AND public.current_user_has_wholesale_access(NEW.business_id) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'WHOLESALE_AUTHORITY_REQUIRED: cambiar la clasificacion mayorista o los datos mayoristas de un cliente requiere acceso Mayorista'
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION private.enforce_customer_wholesale_authority() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.enforce_customer_wholesale_authority() FROM PUBLIC;

COMMENT ON FUNCTION private.enforce_customer_wholesale_authority() IS
  'PRE-BETA-3A-2S — trigger de customers. Sin current_user_has_wholesale_access: '
  'no crea mayoristas, no cambia customer_type, no toca business_name/contact_person '
  'de un mayorista. Los campos comunes de un mayorista historico siguen editables. '
  'Nunca convierte filas.';

CREATE TRIGGER trig_customers_wholesale_authority
  BEFORE INSERT OR UPDATE OF customer_type, business_name, contact_person, business_id
  ON public.customers
  FOR EACH ROW
  EXECUTE FUNCTION private.enforce_customer_wholesale_authority();

-- ============================================================================
-- E. CHECKOUT — precio mayorista solo con autoridad del actor
-- ============================================================================
-- Cuerpo EXACTO de G2-C.2R W1 (20261006120000) con UN cambio en la seccion del
-- cliente: v_is_wholesale exige ademas la autoridad Mayorista del actor en el
-- negocio. Sin ella la venta NO se rechaza: los items se resuelven a precio
-- minorista. Idempotencia, hash de intencion, locks de inventario, stock, caja,
-- pagos y validaciones fiscales no cambian (POSTCONDICION 5 lo verifica contra
-- la huella del cuerpo relevado).
CREATE OR REPLACE FUNCTION private.create_comprobante_checkout_atomic(p_business_id uuid, p_idempotency_key text, p_request_hash text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  c_tolerance_ars     constant numeric := 1.00;
  v_has_access        boolean := false;
  v_existing          comprobante_checkout_requests%ROWTYPE;
  v_request_id        uuid;
  v_comp_id           uuid;
  v_tipo              text;
  v_es_fiscal         boolean;
  v_emitir_en_arca    boolean;
  v_skip_finance      boolean;
  v_exchange_rate     numeric;
  v_customer_id       uuid;
  v_caja_id           uuid;
  v_punto_venta       text;
  v_arca_pv           integer;
  v_tipo_es_fiscal    boolean;
  v_condicion_fiscal  text;
  v_observaciones     text;
  v_order_id          uuid;
  v_estado_comercial  text;
  v_subtotal_ars      numeric := 0;
  v_tax               numeric := 0;
  v_total             numeric := 0;
  v_total_usd         numeric := 0;
  v_descuento_total   numeric := 0;
  v_costo_total_ars   numeric := 0;
  v_total_comisiones  numeric;
  v_total_neto        numeric;
  v_total_bruto       numeric;
  v_cc_total          numeric;
  v_cash_total        numeric := 0;
  v_numero_int        integer;
  v_numero            text;
  v_item              jsonb;
  v_pago              jsonb;
  v_item_id           uuid;
  v_prev_stock        integer;
  v_new_stock         integer;
  v_mov_id            uuid;
  v_account_id        uuid;
  v_customer_name     text;
  v_customer_phone    text;
  v_is_wholesale      boolean;
  v_dollar_rate       numeric := 1;
  v_can_override      boolean;
  v_can_below_cost    boolean;
  v_inv               inventory%ROWTYPE;
  v_line_qty          numeric;
  v_line_desc_pct     numeric;
  v_line_price_client numeric;
  v_line_price_final  numeric;
  v_line_cost_final   numeric;
  v_line_mayorista    numeric;
  v_price_source      text;
  v_is_override       boolean;
  v_line_subtotal     numeric;
  v_line_cost_total   numeric;
  v_resolved_items    jsonb := '[]'::jsonb;
  v_pago_ars          numeric;
  -- M7 6E.2
  v_economic_date     date;
  v_n_products        int := 0;
  v_n_payments        int := 0;
  v_in_audit          boolean := false;
  v_ec                text;
  v_ret_msg           text;
  -- M7 6E.2a
  v_server_hash       text;
  v_hashes_match      boolean;
  v_pay_id            uuid;
  v_pay_ids           uuid[] := '{}';
  v_pay_methods       text[] := '{}';
  v_pay_summary       jsonb := '[]'::jsonb;
  v_fm_ids            uuid[];
  v_cogs_bfe_id       uuid;
  v_am_id             uuid;
BEGIN
  -- ── Ownership: resolver y validar acceso real al negocio ────────────────
  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id = p_business_id AND owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id = p_business_id AND user_id = auth.uid())
  ) INTO v_has_access;
  IF NOT v_has_access THEN
    RETURN jsonb_build_object('status', 'failed_final', 'error', 'No autorizado para este negocio', 'error_code', 'FORBIDDEN');
  END IF;

  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RETURN jsonb_build_object('status', 'failed_final', 'error', 'idempotency_key requerida', 'error_code', 'VALIDATION_ERROR');
  END IF;
  IF p_request_hash IS NULL OR length(trim(p_request_hash)) = 0 THEN
    RETURN jsonb_build_object('status', 'failed_final', 'error', 'request_hash requerido', 'error_code', 'VALIDATION_ERROR');
  END IF;

  -- Una Nota de Credito no es una venta generica. Necesita un comprobante
  -- original autorizado para resolver CbtesAsoc y su CbteTipo (A->3, B->8,
  -- C->13). Cortar ANTES del hash y del INSERT idempotente evita tanto una NC
  -- sin original como cualquier escritura residual de un intento invalido.
  v_tipo := p_payload->>'tipo';
  IF v_tipo = 'nota_credito' THEN
    RETURN jsonb_build_object(
      'status', 'failed_final',
      'error_code', 'CREDIT_NOTE_REQUIRES_ORIGINAL',
      'error', 'La Nota de Credito debe crearse desde un comprobante fiscal original');
  END IF;
  IF v_tipo IS NULL OR v_tipo NOT IN ('remito', 'factura_a', 'factura_c') THEN
    RETURN jsonb_build_object(
      'status', 'failed_final',
      'error_code', 'VALIDATION_ERROR',
      'error', format('tipo de comprobante invalido: %s', COALESCE(v_tipo, 'NULL')));
  END IF;
  v_emitir_en_arca := COALESCE((p_payload->>'emitir_en_arca')::boolean, false);
  IF v_tipo = 'remito' AND v_emitir_en_arca THEN
    RETURN jsonb_build_object(
      'status', 'failed_final',
      'error_code', 'NON_FISCAL_ARCA_NOT_ALLOWED',
      'error', 'Un remito no fiscal no puede solicitar emision en ARCA');
  END IF;

  v_can_override   := user_can_override_price(p_business_id, auth.uid());
  v_can_below_cost := user_can_sell_below_cost(p_business_id, auth.uid());

  -- ── M7 6E.2a: hash canonico SERVER-SIDE (autoridad de idempotencia) ANTES de
  -- reservar. El cliente NO es fuente de verdad. Valida metodos de pago (rechazo
  -- antes de reservar). p_request_hash se conserva para compat/diagnostico.
  BEGIN
    v_server_hash := public.compute_checkout_intent_hash(p_business_id, p_payload);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'INVALID_CHECKOUT_METHOD%' THEN
      RETURN jsonb_build_object('status','failed_final','error','Método de pago inválido','error_code','VALIDATION_ERROR');
    ELSE RAISE; END IF;
  END;
  v_hashes_match := (p_request_hash IS NOT DISTINCT FROM v_server_hash);

  -- ── Idempotencia: intentar registrar la request — ESTE INSERT ES EL LOCK ──
  -- (idx UNIQUE business_id,idempotency_key). Replay/conflict retornan ANTES de
  -- cualquier escritura economica y del guard de periodo (no crean una venta nueva).
  SET LOCAL lock_timeout = '8s';
  BEGIN
    INSERT INTO comprobante_checkout_requests (business_id, user_id, op, idempotency_key, client_request_hash, server_request_hash, status)
    VALUES (p_business_id, auth.uid(), 'sale_checkout', p_idempotency_key, p_request_hash, v_server_hash, 'processing')
    RETURNING id INTO v_request_id;
  EXCEPTION
    WHEN lock_not_available THEN
      RETURN jsonb_build_object('status', 'already_processing');
    WHEN unique_violation THEN
      SELECT * INTO v_existing FROM comprobante_checkout_requests
        WHERE business_id = p_business_id AND idempotency_key = p_idempotency_key;

      -- Replay/conflicto por server_request_hash (autoridad). Fallback legacy:
      -- filas antiguas sin server hash usan client_request_hash (comportamiento previo).
      IF (v_existing.server_request_hash IS NOT NULL AND v_existing.server_request_hash IS DISTINCT FROM v_server_hash)
         OR (v_existing.server_request_hash IS NULL AND v_existing.client_request_hash IS DISTINCT FROM p_request_hash) THEN
        RETURN jsonb_build_object('status', 'idempotency_conflict', 'error_code', 'IDEMPOTENCY_CONFLICT');
      END IF;

      IF v_existing.status = 'completed' THEN
        RETURN jsonb_build_object('status', 'existing', 'comprobante_id', v_existing.comprobante_id);
      ELSIF v_existing.status = 'failed_final' THEN
        RETURN jsonb_build_object('status', 'failed_final', 'error', v_existing.last_error_message, 'error_code', COALESCE(v_existing.last_error_code,'INTERNAL_ERROR'));
      ELSIF v_existing.status = 'processing' THEN
        RETURN jsonb_build_object('status', 'already_processing');
      ELSE -- 'failed_retryable'
        UPDATE comprobante_checkout_requests
          SET status = 'processing', updated_at = now()
          WHERE id = v_existing.id AND status = 'failed_retryable';
        IF NOT FOUND THEN
          RETURN jsonb_build_object('status', 'already_processing');
        END IF;
        v_request_id := v_existing.id;
      END IF;
  END;

  -- ── Bloque de trabajo (savepoint implícito vía EXCEPTION) ────────────────
  BEGIN
    -- M7 §5: fecha economica canonica (el checkout siempre crea ventas actuales).
    v_economic_date := public.ar_today();
    -- M7 §5: guard de periodo defensivo ANTES de cualquier escritura economica.
    -- (el mes actual no puede cerrarse via close_period; casi siempre no-op.)
    PERFORM public.assert_period_open(p_business_id, v_economic_date);
    -- M7 §6: scope de auditoria -> el backstop E1 de comprobante_payments/account_movements
    -- NO registra por-linea; al final se emite UN unico evento sale_checkout.
    PERFORM public.finance_begin_audit_scope();

    v_emitir_en_arca   := COALESCE((p_payload->>'emitir_en_arca')::boolean, false);
    v_skip_finance     := COALESCE((p_payload->>'skip_finance_entry')::boolean, false);
    v_exchange_rate    := COALESCE((p_payload->>'exchange_rate')::numeric, 1);
    v_customer_id      := NULLIF(p_payload->>'customer_id', '')::uuid;
    v_caja_id          := NULLIF(p_payload->>'caja_id', '')::uuid;
    -- == P0 · PUNTO DE VENTA FISCAL: lo resuelve el SERVIDOR ==================
    -- El cliente manda el PV que muestra el POS (sales_points.numero). Eso es
    -- legitimo para un remito, pero NO puede definir la identidad fiscal de una
    -- factura: el CAE se pide SIEMPRE con arca_config.punto_venta
    -- (ver claim_comprobante_arca_emission), asi que confiar en el payload
    -- dejaba comprobantes fiscales persistidos con un PV inexistente en AFIP.
    --
    -- La fiscalidad se deriva del TIPO, no del payload: si se leyera es_fiscal
    -- del cliente, mandar es_fiscal=false junto a tipo=factura_c alcanzaria
    -- para quedarse con el PV local.
    v_tipo_es_fiscal := (v_tipo IN ('factura_a', 'factura_c'));

    -- Fuente unica de fiscalidad persistida: el tipo validado. El cliente no
    -- puede degradar una factura a no_fiscal mandando es_fiscal=false, ni puede
    -- marcar un remito para emision ARCA.
    v_es_fiscal      := v_tipo_es_fiscal;
    v_emitir_en_arca := v_emitir_en_arca AND v_tipo_es_fiscal;

    IF v_tipo_es_fiscal THEN
      SELECT punto_venta INTO v_arca_pv
        FROM arca_config
       WHERE business_id = p_business_id
         AND punto_venta > 0;

      IF v_arca_pv IS NOT NULL THEN
        -- Fuente canonica. El payload se descarta.
        v_punto_venta := lpad(v_arca_pv::text, 4, '0');
      ELSIF v_emitir_en_arca THEN
        -- Se pidio CAE y no hay configuracion: fail-closed explicito. Jamas
        -- inventar un PV para un documento que va a pedir autorizacion a AFIP.
        RAISE EXCEPTION 'ARCA_NOT_CONFIGURED: falta el punto de venta de ARCA para emitir un comprobante fiscal';
      ELSE
        -- Fiscal SIN integracion ARCA - hoy el caso por defecto. No hay fuente
        -- canonica todavia, asi que se usa el mismo DEFAULT que declara
        -- arca_config.punto_venta (1) y NUNCA el PV local del cliente. El
        -- comprobante queda en estado_fiscal='pendiente_emision' y la impresion
        -- lo rotula como numero interno, asi que este valor no se presenta como
        -- identidad fiscal emitida.
        v_punto_venta := '0001';
      END IF;
    ELSE
      -- No fiscal (remito): el PV local de sales_points es legitimo.
      v_punto_venta := COALESCE(p_payload->>'punto_venta', '0001');
    END IF;
    v_condicion_fiscal := COALESCE(p_payload->>'condicion_fiscal', 'Consumidor Final');
    v_observaciones    := p_payload->>'observaciones';
    v_order_id         := NULLIF(p_payload->>'order_id', '')::uuid;

    -- ── Cliente mayorista/minorista (server-side, nunca confiado del payload) ──
    v_is_wholesale := false;
    IF v_customer_id IS NOT NULL THEN
      SELECT (customer_type = 'mayorista'), name, phone
        INTO v_is_wholesale, v_customer_name, v_customer_phone
        FROM customers WHERE id = v_customer_id AND business_id = p_business_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'CUSTOMER_NOT_FOUND: el cliente no pertenece a este negocio';
      END IF;
      v_is_wholesale := COALESCE(v_is_wholesale, false);
      -- PRE-BETA-3A-2S: la tarifa mayorista exige cliente mayorista Y autoridad
      -- Mayorista del actor en ESTE negocio. Sin autoridad la venta NO se
      -- rechaza: los items se resuelven a precio minorista.
      v_is_wholesale := v_is_wholesale AND public.current_user_has_wholesale_access(p_business_id);
    END IF;

    -- M7 §4: orden del MISMO negocio (si viene)
    IF v_order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM orders WHERE id = v_order_id AND business_id = p_business_id) THEN
      RAISE EXCEPTION 'ORDER_NOT_FOUND: la orden no pertenece a este negocio';
    END IF;

    -- ── Cotización vigente del negocio (server-side) ─────────────────────────
    SELECT rate INTO v_dollar_rate FROM exchange_rates
      WHERE business_id = p_business_id AND base_currency = 'USD' AND target_currency = 'ARS'
      ORDER BY updated_at DESC LIMIT 1;
    v_dollar_rate := COALESCE(v_dollar_rate, 1);

    -- ── 1-2. Ítems: resolver precio/costo server-side, validar overrides ─────
    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'items', '[]'::jsonb))
    LOOP
      v_line_qty          := COALESCE((v_item->>'cantidad')::numeric, 0);
      v_line_desc_pct     := LEAST(GREATEST(COALESCE((v_item->>'descuento_linea')::numeric, 0), 0), 100);
      v_line_price_client := COALESCE((v_item->>'precio_unitario')::numeric, 0);

      -- M7 §9: cantidades ENTERAS positivas (TechRepair maneja solo unidades enteras).
      -- Sin FLOOR/truncado silencioso: 1.5/0.5/2.0001/0/negativos/NaN/Infinity -> rechazo.
      IF v_line_qty::text IN ('NaN', 'Infinity', '-Infinity')
         OR v_line_qty < 1 OR v_line_qty <> trunc(v_line_qty) OR v_line_qty > 1000000 THEN
        RAISE EXCEPTION 'QTY_NOT_INTEGER: cantidad entera >=1 requerida (item: %)', v_item->>'descripcion';
      END IF;
      IF v_line_price_client::text IN ('NaN', 'Infinity', '-Infinity') OR v_line_price_client < 0 THEN
        RAISE EXCEPTION 'precio_unitario invalido (negativo, NaN o infinito) en item: %', v_item->>'descripcion';
      END IF;

      IF NULLIF(v_item->>'inventory_id', '') IS NOT NULL THEN
        -- ── Ítem de PRODUCTO: resolver desde inventory, nunca confiar en el payload ──
        SELECT * INTO v_inv FROM inventory
          WHERE id = (v_item->>'inventory_id')::uuid AND business_id = p_business_id;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'inventory_id % no pertenece a este negocio o no existe', v_item->>'inventory_id';
        END IF;

        SELECT sale_ars, cost_ars, mayorista_ars INTO v_line_price_final, v_line_cost_final, v_line_mayorista
          FROM resolve_product_pricing(
            v_inv.sale_price, v_inv.precio_mayorista, v_inv.cost_price, v_inv.cost_price_usd,
            v_inv.base_currency, v_inv.base_price, v_inv.auto_update_price, v_inv.exchange_rate_used,
            v_dollar_rate
          );
        v_line_desc_pct := LEAST(GREATEST(COALESCE((v_item->>'descuento_linea')::numeric, 0), 0), 100);

        IF v_is_wholesale AND v_line_mayorista IS NOT NULL AND v_line_mayorista > 0 THEN
          v_line_price_final := v_line_mayorista;
          v_price_source := 'resolved_mayorista';
        ELSE
          v_price_source := 'resolved_minorista';
        END IF;

        -- ── Override: el cliente mandó un precio o descuento distinto del resuelto ──
        v_is_override := (abs(v_line_price_client - v_line_price_final) > 0.01) OR (v_line_desc_pct > 0);
        IF v_is_override THEN
          IF NOT v_can_override THEN
            RAISE EXCEPTION 'usuario sin permiso para modificar el precio/descuento del item: %', v_item->>'descripcion';
          END IF;
          v_price_source := 'manual_override';
        ELSE
          v_line_price_client := v_line_price_final;
        END IF;

        IF v_line_price_client < v_line_cost_final AND NOT v_can_below_cost THEN
          RAISE EXCEPTION 'usuario sin permiso para vender por debajo del costo en item: %', v_item->>'descripcion';
        END IF;
      ELSE
        -- ── Ítem de SERVICIO/MANUAL ──
        v_line_price_final := v_line_price_client;
        v_line_cost_final  := COALESCE((v_item->>'costo_unitario')::numeric, 0);
        v_price_source      := 'manual_service';
        v_is_override       := false;
      END IF;

      v_line_subtotal   := v_line_price_client * v_line_qty * (1 - v_line_desc_pct / 100.0);
      v_line_cost_total := v_line_cost_final * v_line_qty;

      v_subtotal_ars    := v_subtotal_ars + v_line_subtotal;
      v_costo_total_ars := v_costo_total_ars + v_line_cost_total;
      v_descuento_total := v_descuento_total + (v_line_price_client * v_line_qty * (v_line_desc_pct / 100.0));

      v_item := v_item
        || jsonb_build_object('_resolved_precio', v_line_price_client)
        || jsonb_build_object('_resolved_costo', v_line_cost_final)
        || jsonb_build_object('_resolved_subtotal', v_line_subtotal)
        || jsonb_build_object('_resolved_descuento', v_line_desc_pct)
        || jsonb_build_object('_price_source', v_price_source)
        || jsonb_build_object('_price_override', v_is_override)
        || jsonb_build_object('_list_price', v_line_price_final);

      v_resolved_items := v_resolved_items || jsonb_build_array(v_item);
    END LOOP;

    v_tax   := CASE WHEN v_tipo = 'factura_a' THEN v_subtotal_ars * 0.21 ELSE 0 END;
    v_total := v_subtotal_ars + v_tax;
    v_total_usd := CASE WHEN v_dollar_rate > 0 THEN v_total / v_dollar_rate ELSE 0 END;
    v_total_bruto := v_total;

    -- ── Pagos: sumar server-side (nunca confiar en un total de pagos del cliente) ──
    SELECT COALESCE(SUM((p->>'amount_ars')::numeric), 0) INTO v_cash_total
      FROM jsonb_array_elements(COALESCE(p_payload->'pagos', '[]'::jsonb)) p;
    v_cc_total := COALESCE((p_payload->>'cc_total')::numeric, 0);

    FOR v_pago IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'pagos', '[]'::jsonb))
    LOOP
      IF COALESCE((v_pago->>'amount')::numeric, -1) < 0
         OR COALESCE((v_pago->>'amount_ars')::numeric, -1) < 0
         OR COALESCE((v_pago->>'amount_ars')::numeric, 0)::text IN ('NaN', 'Infinity', '-Infinity') THEN
        RAISE EXCEPTION 'pago con monto negativo o invalido no permitido';
      END IF;
    END LOOP;
    IF v_cc_total < 0 OR v_cc_total::text IN ('NaN', 'Infinity', '-Infinity') THEN
      RAISE EXCEPTION 'cc_total invalido';
    END IF;

    -- ── INVARIANTE DE COBRO (Etapa 0) ─────────────────────────────────────────
    IF v_cc_total > 0.01 AND v_customer_id IS NULL THEN
      RAISE EXCEPTION 'la cuenta corriente requiere un cliente asignado (cc=% sin customer_id)', v_cc_total;
    END IF;

    IF v_tipo = 'nota_credito' THEN
      -- Una NC es un documento de reversión: no lleva cobros ni genera deuda.
      IF v_cash_total > 0.01 OR v_cc_total > 0.01 THEN
        RAISE EXCEPTION 'una nota de credito no lleva pagos ni cuenta corriente (pagos=%, cc=%)', v_cash_total, v_cc_total;
      END IF;
    ELSE
      IF (v_cash_total + v_cc_total) > (v_total_bruto + c_tolerance_ars) THEN
        RAISE EXCEPTION 'los pagos (caja + cuenta corriente) exceden el total: total=% pagos=% cuenta_corriente=% diferencia=%',
          round(v_total_bruto, 2), round(v_cash_total, 2), round(v_cc_total, 2),
          round((v_cash_total + v_cc_total) - v_total_bruto, 2);
      END IF;
      IF (v_cash_total + v_cc_total) < (v_total_bruto - c_tolerance_ars) THEN
        RAISE EXCEPTION 'el cobro no cubre el total del comprobante: total=% pagos=% cuenta_corriente=% diferencia=% — completá el pago o registrá el saldo explícitamente como cuenta corriente',
          round(v_total_bruto, 2), round(v_cash_total, 2), round(v_cc_total, 2),
          round(v_total_bruto - (v_cash_total + v_cc_total), 2);
      END IF;
    END IF;

    v_total_comisiones := COALESCE((p_payload->>'total_comisiones')::numeric, 0);
    v_total_neto       := v_total_bruto - v_total_comisiones;

    v_estado_comercial := CASE
      WHEN v_cash_total >= v_total_bruto - c_tolerance_ars THEN 'pagado'
      WHEN v_cash_total > 0 OR v_cc_total > 0 THEN 'parcial'
      ELSE 'pendiente'
    END;

    -- ── Número local: reserva ATÓMICA ─────────────────────────────────────────
    v_numero_int := reserve_comprobante_number(p_business_id, v_tipo);
    IF v_punto_venta IS NULL OR trim(v_punto_venta) = '' THEN
      v_numero := lpad(v_numero_int::text, 8, '0');
    ELSE
      v_numero := lpad(v_punto_venta, 4, '0') || '-' || lpad(v_numero_int::text, 8, '0');
    END IF;

    -- ── 3. Comprobante ────────────────────────────────────────────────────────
    INSERT INTO comprobantes (
      business_id, created_by, customer_id, order_id, tipo, type, punto_venta,
      numero, number, numero_secuencial, fecha, date, condicion_fiscal, observaciones, currency,
      exchange_rate, subtotal, impuestos, tax, total, total_ars, total_usd,
      descuento_total, recargo_total, total_bruto, total_cobrado, saldo_pendiente,
      total_comisiones, total_neto, estado, status, estado_comercial, estado_fiscal,
      es_fiscal, emitir_en_arca, cae, cae_vencimiento, numero_fiscal
    ) VALUES (
      p_business_id, auth.uid(), v_customer_id, v_order_id, v_tipo, v_tipo, v_punto_venta,
      v_numero, v_numero, v_numero_int, now(), now(), v_condicion_fiscal, v_observaciones, 'ARS',
      v_exchange_rate, v_subtotal_ars, v_tax, v_tax, v_total, v_total, v_total_usd,
      v_descuento_total, 0, v_total_bruto, 0, v_total_bruto,
      v_total_comisiones, v_total_neto,
      CASE WHEN v_es_fiscal THEN 'borrador' ELSE 'emitido' END,
      CASE WHEN v_es_fiscal THEN 'draft' ELSE 'issued' END,
      v_estado_comercial,
      CASE WHEN v_es_fiscal THEN 'pendiente_emision' ELSE 'no_fiscal' END,
      v_es_fiscal, v_emitir_en_arca, NULL, NULL, NULL
    ) RETURNING id INTO v_comp_id;

    -- M7 §11: lock DETERMINISTA de todas las filas de inventario a descontar, en orden
    -- global por id, ANTES de tocar la primera -> evita deadlocks con lineas en distinto
    -- orden. Se permiten lineas repetidas del mismo producto (semantica POS): cada id se
    -- bloquea una vez; el descuento de stock sigue siendo por-linea mas abajo.
    IF v_tipo <> 'nota_credito' THEN
      PERFORM 1 FROM inventory
        WHERE business_id = p_business_id
          AND id IN (SELECT (it->>'inventory_id')::uuid FROM jsonb_array_elements(v_resolved_items) it
                     WHERE NULLIF(it->>'inventory_id','') IS NOT NULL
                       AND COALESCE(it->>'tipo_linea','producto') IN ('producto','repuesto'))
        ORDER BY id FOR NO KEY UPDATE;
    END IF;

    -- ── 4-5. Ítems + stock (con precio/costo YA resueltos server-side) ───────
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_resolved_items)
    LOOP
      INSERT INTO comprobante_items (
        comprobante_id, business_id, created_by, descripcion, tipo_linea, cantidad,
        precio_unitario, descuento_linea, subtotal, costo_unitario, costo_total,
        currency, exchange_rate, inventory_id, applied_price_type, orden,
        list_price_ars, price_override, applied_price_source
      ) VALUES (
        v_comp_id, p_business_id, auth.uid(),
        v_item->>'descripcion',
        COALESCE(v_item->>'tipo_linea', 'producto'),
        (v_item->>'cantidad')::numeric,
        (v_item->>'_resolved_precio')::numeric,
        (v_item->>'_resolved_descuento')::numeric,
        (v_item->>'_resolved_subtotal')::numeric,
        (v_item->>'_resolved_costo')::numeric,
        (v_item->>'_resolved_costo')::numeric * (v_item->>'cantidad')::numeric,
        COALESCE(v_item->>'currency', 'ARS'),
        COALESCE((v_item->>'exchange_rate')::numeric, v_exchange_rate),
        NULLIF(v_item->>'inventory_id', '')::uuid,
        v_item->>'applied_price_type',
        COALESCE((v_item->>'orden')::integer, 0),
        (v_item->>'_list_price')::numeric,
        (v_item->>'_price_override')::boolean,
        v_item->>'_price_source'
      ) RETURNING id INTO v_item_id;

      -- Stock: NUNCA para nota_credito (una NC no es una salida de mercadería).
      IF v_tipo <> 'nota_credito'
         AND NULLIF(v_item->>'inventory_id', '') IS NOT NULL
         AND COALESCE(v_item->>'tipo_linea', 'producto') IN ('producto', 'repuesto') THEN

        SELECT stock_quantity INTO v_prev_stock FROM inventory
          WHERE id = (v_item->>'inventory_id')::uuid AND business_id = p_business_id
          FOR NO KEY UPDATE;

        IF FOUND THEN
          v_prev_stock := COALESCE(v_prev_stock, 0);
          v_new_stock  := (v_prev_stock - (v_item->>'cantidad')::numeric)::integer;

          UPDATE inventory SET stock_quantity = v_new_stock, updated_at = now()
            WHERE id = (v_item->>'inventory_id')::uuid AND business_id = p_business_id;

          INSERT INTO inventory_movements (
            business_id, inventory_item_id, movement_type, quantity, previous_stock,
            new_stock, reference_type, reference_id, note, created_by
          ) VALUES (
            p_business_id, (v_item->>'inventory_id')::uuid, 'sale',
            -((v_item->>'cantidad')::numeric)::integer, v_prev_stock, v_new_stock,
            'comprobante', v_comp_id, 'Salida por venta en comprobante', auth.uid()
          ) RETURNING id INTO v_mov_id;

          UPDATE comprobante_items
            SET stock_processed = true, stock_processed_at = now(), stock_movement_id = v_mov_id
            WHERE id = v_item_id;
        END IF;
      END IF;
    END LOOP;

    -- ── 6. Pagos de caja: solo montos > 0 (un pago de $0 no existe) ────────────
    FOR v_pago IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'pagos', '[]'::jsonb))
    LOOP
      v_pago_ars := COALESCE((v_pago->>'amount_ars')::numeric, 0);
      IF v_pago_ars > 0 THEN
        INSERT INTO comprobante_payments (
          comprobante_id, business_id, amount, currency, amount_ars, exchange_rate,
          payment_method, payment_provider, commission_rate, commission_amount,
          net_amount, date, created_by
        ) VALUES (
          v_comp_id, p_business_id,
          (v_pago->>'amount')::numeric, COALESCE(v_pago->>'currency', 'ARS'),
          v_pago_ars,
          COALESCE((v_pago->>'exchange_rate')::numeric, v_exchange_rate),
          public.normalize_checkout_payment_method(v_pago->>'payment_method'), v_pago->>'payment_provider',
          COALESCE((v_pago->>'commission_rate')::numeric, 0),
          COALESCE((v_pago->>'commission_amount')::numeric, 0),
          COALESCE((v_pago->>'net_amount')::numeric, v_pago_ars),
          public.ar_today(), auth.uid()
        ) RETURNING id INTO v_pay_id;
        -- M7 6E.2a: referencias compactas para la auditoria (sin datos sensibles).
        v_pay_ids     := v_pay_ids || v_pay_id;
        v_pay_methods := v_pay_methods || public.normalize_checkout_payment_method(v_pago->>'payment_method');
        v_pay_summary := v_pay_summary || jsonb_build_array(jsonb_build_object(
          'id', v_pay_id, 'method', public.normalize_checkout_payment_method(v_pago->>'payment_method'),
          'amount_ars', round(v_pago_ars,2), 'currency', COALESCE(v_pago->>'currency','ARS')));
      END IF;
    END LOOP;

    -- ── 7. COGS devengado (BFE de costo) — trazable, fecha AR. Nunca para NC. ──
    IF v_costo_total_ars > 0 AND NOT v_skip_finance AND v_tipo <> 'nota_credito' THEN
      INSERT INTO business_finance_entries (
        business_id, date, type, category, description, amount, currency,
        amount_ars, exchange_rate, created_by, source, reference_comprobante_id
      ) VALUES (
        p_business_id, public.ar_today(), 'variable_cost', 'mercaderia',
        'Costo de productos - Comprobante #' || v_numero, v_costo_total_ars,
        'ARS', v_costo_total_ars, 1, auth.uid(), 'comprobante', v_comp_id
      ) RETURNING id INTO v_cogs_bfe_id;
    END IF;

    -- ── 8. Cuenta corriente ───────────────────────────────────────────────────
    IF v_cc_total > 0.01 AND v_customer_id IS NOT NULL THEN
      SELECT id INTO v_account_id FROM accounts
        WHERE business_id = p_business_id AND entity_id = v_customer_id;

      IF v_account_id IS NULL THEN
        INSERT INTO accounts (business_id, type, entity_id, entity_name, entity_phone, balance)
          VALUES (p_business_id, 'cliente', v_customer_id, COALESCE(v_customer_name, 'Cliente'), v_customer_phone, 0)
          RETURNING id INTO v_account_id;
      END IF;

      INSERT INTO account_movements (
        business_id, account_id, date, type, description, debit, credit,
        reference_type, reference_id, created_by
      ) VALUES (
        p_business_id, v_account_id, public.ar_today(), 'venta',
        'Comprobante #' || v_numero, v_cc_total, 0,
        'comprobante', v_comp_id, auth.uid()
      ) RETURNING id INTO v_am_id;
    END IF;

    -- ── M7 §6/§15: UN unico evento de negocio (la venta completa), server-side. ──
    v_n_products := (SELECT count(*) FROM jsonb_array_elements(v_resolved_items) it WHERE NULLIF(it->>'inventory_id','') IS NOT NULL);
    v_n_payments := (SELECT count(*) FROM jsonb_array_elements(COALESCE(p_payload->'pagos','[]'::jsonb)) p WHERE COALESCE((p->>'amount_ars')::numeric,0) > 0);
    -- FM creados por trig_comprobante_payment_finance para este comprobante
    SELECT array_agg(id) INTO v_fm_ids FROM financial_movements WHERE business_id=p_business_id AND comprobante_id=v_comp_id;
    v_in_audit := true;
    PERFORM finance_log_audit(
      p_business_id, 'sale_checkout', 'comprobantes', v_comp_id, 'create_comprobante_checkout_atomic',
      p_idempotency_key, v_observaciones, v_economic_date, 'comprobante', v_comp_id,
      NULL, jsonb_build_object(
        'comprobante_id', v_comp_id, 'tipo', v_tipo, 'numero', v_numero, 'customer_id', v_customer_id,
        'order_id', v_order_id, 'currency', 'ARS', 'exchange_rate', v_exchange_rate,
        'subtotal', round(v_subtotal_ars,2), 'descuento_total', round(v_descuento_total,2), 'tax', round(v_tax,2),
        'total', round(v_total_bruto,2), 'total_percibido', round(v_cash_total,2), 'total_financiado', round(v_cc_total,2),
        'costo_total', round(v_costo_total_ars,2), 'item_count', COALESCE(jsonb_array_length(v_resolved_items),0),
        'product_count', v_n_products, 'payment_count', v_n_payments, 'estado_comercial', v_estado_comercial,
        'account_id', v_account_id, 'es_fiscal', v_es_fiscal,
        -- 6E.2a: metodos normalizados + referencias financieras compactas + ambos hashes
        'payment_methods', to_jsonb(v_pay_methods), 'payments', v_pay_summary,
        'comprobante_payment_ids', to_jsonb(v_pay_ids), 'financial_movement_ids', to_jsonb(COALESCE(v_fm_ids, '{}'::uuid[])),
        'cogs_bfe_id', v_cogs_bfe_id, 'account_movement_id', v_am_id,
        'client_request_hash', p_request_hash, 'server_request_hash', v_server_hash,
        'hash_algorithm', 'checkout_intent_v1', 'hashes_match', v_hashes_match));
    v_in_audit := false;

    -- ── Completar la request — con el hash RESUELTO (auditoría) ──────────────
    UPDATE comprobante_checkout_requests
      SET status = 'completed', comprobante_id = v_comp_id, completed_at = now(), updated_at = now(),
          resolved_checkout_hash = encode(extensions.digest(v_resolved_items::text || v_total::text || v_subtotal_ars::text, 'sha256'), 'hex')
      WHERE id = v_request_id;

    RETURN jsonb_build_object('status', 'created', 'comprobante_id', v_comp_id);

  EXCEPTION WHEN OTHERS THEN
    -- M7 §16: error_code ADITIVO. status se mantiene 'failed_retryable' (contrato POS
    -- intacto: la maquina de estados no cambia). No se expone SQLERRM inesperado.
    v_ec := CASE
      WHEN v_in_audit THEN 'AUDIT_FAILED'
      WHEN SQLERRM LIKE 'PERIOD_CLOSED%' THEN 'PERIOD_CLOSED'
      WHEN SQLERRM LIKE 'INVALID_FINANCE_CONTEXT%' THEN 'INVALID_FINANCE_CONTEXT'
      WHEN SQLERRM LIKE 'QTY_NOT_INTEGER%' THEN 'VALIDATION_ERROR'
      WHEN SQLERRM LIKE 'CUSTOMER_NOT_FOUND%' THEN 'CUSTOMER_NOT_FOUND'
      WHEN SQLERRM LIKE 'ORDER_NOT_FOUND%' THEN 'ORDER_NOT_FOUND'
      WHEN SQLERRM LIKE 'ARCA_NOT_CONFIGURED%' THEN 'ARCA_NOT_CONFIGURED'
      WHEN SQLERRM LIKE '%no pertenece a este negocio o no existe%' THEN 'INVENTORY_NOT_FOUND'
      WHEN SQLERRM LIKE 'tipo de comprobante invalido%' OR SQLERRM LIKE 'cantidad invalida%'
        OR SQLERRM LIKE 'precio_unitario invalido%' OR SQLERRM LIKE 'pago con monto%'
        OR SQLERRM LIKE 'cc_total invalido%' OR SQLERRM LIKE '%exceden el total%'
        OR SQLERRM LIKE '%no cubre el total%' OR SQLERRM LIKE '%cuenta corriente requiere%'
        OR SQLERRM LIKE '%nota de credito no lleva%' OR SQLERRM LIKE '%sin permiso%' THEN 'VALIDATION_ERROR'
      ELSE 'INTERNAL_ERROR'
    END;
    v_ret_msg := CASE
      WHEN v_ec = 'QTY_NOT_INTEGER' OR SQLERRM LIKE 'QTY_NOT_INTEGER%' THEN 'La cantidad debe ser un número entero mayor o igual a 1'
      WHEN v_ec = 'CUSTOMER_NOT_FOUND' THEN 'El cliente no pertenece a este negocio'
      WHEN v_ec = 'ORDER_NOT_FOUND' THEN 'La orden no pertenece a este negocio'
      WHEN v_ec = 'ARCA_NOT_CONFIGURED' THEN 'Configura el punto de venta de ARCA antes de emitir un comprobante fiscal'
      WHEN v_ec = 'AUDIT_FAILED' THEN 'No se pudo registrar la auditoria de la operacion'
      WHEN v_ec = 'INTERNAL_ERROR' THEN 'No se pudo completar la operacion'
      ELSE SQLERRM
    END;
    UPDATE comprobante_checkout_requests
      SET status = 'failed_retryable', last_error_code = v_ec, last_error_message = SQLERRM,
          completed_at = now(), updated_at = now()
      WHERE id = v_request_id;
    RETURN jsonb_build_object('status', 'failed_retryable', 'error', v_ret_msg, 'error_code', v_ec);
  END;
END;
$function$;

REVOKE ALL ON FUNCTION private.create_comprobante_checkout_atomic(uuid, text, text, jsonb) FROM PUBLIC;

-- ============================================================================
-- F. Conversion administrativa portal -> customers
-- ============================================================================
-- Reemplaza el INSERT directo del navegador (portalService.getOrCreateCustomerFromPortal).
-- Es una accion de GESTION de Mayorista (convierte un pedido en venta), asi que
-- exige current_user_can_manage_wholesale. Identifica al cliente del portal por
-- id (tenant-bound) y lo busca en customers por email exacto normalizado:
--   0 coincidencias -> crea el cliente mayorista (created = true)
--   1 coincidencia  -> lo devuelve TAL CUAL: no lo reclasifica
--   2+              -> CUSTOMER_MATCH_AMBIGUOUS (el operador elige; no se adivina)
-- Sin `ilike` por nombre. Idempotente: la fila del cliente del portal se bloquea
-- (FOR UPDATE), asi que dos conversiones concurrentes no duplican el cliente.
CREATE FUNCTION public.get_or_create_customer_from_wholesale_atomic(
  p_business_id           uuid,
  p_wholesale_customer_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor   uuid := auth.uid();
  v_wc      record;
  v_email   text;
  v_n       bigint;
  v_id      uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_business_id IS NULL OR p_wholesale_customer_id IS NULL THEN
    RAISE EXCEPTION 'business_id y wholesale_customer_id son obligatorios' USING ERRCODE = '22023';
  END IF;
  IF public.current_user_business_id() IS DISTINCT FROM p_business_id THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  IF NOT private.business_feature_enabled(p_business_id, 'mayorista') THEN
    RAISE EXCEPTION 'Forbidden: el plan del negocio no incluye el modulo mayorista'
      USING ERRCODE = '42501';
  END IF;
  IF NOT public.current_user_can_manage_wholesale(p_business_id) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT wc.id, wc.name, wc.email, wc.whatsapp, wc.business_name
    INTO v_wc
    FROM public.wholesale_customers wc
   WHERE wc.id = p_wholesale_customer_id
     AND wc.business_id = p_business_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WHOLESALE_CUSTOMER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  v_email := lower(btrim(v_wc.email));
  IF v_email IS NULL OR v_email = '' THEN
    RAISE EXCEPTION 'WHOLESALE_CUSTOMER_WITHOUT_EMAIL' USING ERRCODE = '22023';
  END IF;

  SELECT count(*), (array_agg(c.id ORDER BY c.created_at, c.id))[1]
    INTO v_n, v_id
    FROM public.customers c
   WHERE c.business_id = p_business_id
     AND lower(btrim(c.email)) = v_email;

  IF v_n > 1 THEN
    RAISE EXCEPTION 'CUSTOMER_MATCH_AMBIGUOUS: % clientes del negocio tienen el email del cliente mayorista', v_n
      USING ERRCODE = 'P0001';
  END IF;

  IF v_n = 1 THEN
    RETURN jsonb_build_object('ok', true, 'customer_id', v_id, 'created', false, 'matched_by', 'email');
  END IF;

  -- El INSERT pasa por trig_customers_wholesale_authority con la identidad del
  -- actor (auth.uid() sigue siendo el suyo): la autoridad se verifica dos veces.
  INSERT INTO public.customers (business_id, name, email, phone, customer_type, business_name, created_by)
  VALUES (p_business_id, v_wc.name, v_wc.email, COALESCE(v_wc.whatsapp, ''), 'mayorista',
          NULLIF(btrim(v_wc.business_name), ''), v_actor)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'customer_id', v_id, 'created', true, 'matched_by', NULL);
END;
$$;

ALTER FUNCTION public.get_or_create_customer_from_wholesale_atomic(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_or_create_customer_from_wholesale_atomic(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_or_create_customer_from_wholesale_atomic(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_or_create_customer_from_wholesale_atomic(uuid, uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.get_or_create_customer_from_wholesale_atomic(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.get_or_create_customer_from_wholesale_atomic(uuid, uuid) IS
  'PRE-BETA-3A-2S — conversion administrativa de un cliente del portal a customers. '
  'Autoridad: negocio del actor + feature mayorista + current_user_can_manage_wholesale. '
  'Matching por email exacto; ambiguo -> error; no reclasifica clientes existentes. '
  'Idempotente (FOR UPDATE sobre wholesale_customers).';

-- ============================================================================
-- POSTCONDICIONES (sobre el catalogo resultante; cualquier falla revierte todo)
-- ============================================================================
DO $post$
DECLARE
  s        record;
  v_now    record;
  v_bad    text;
  v_n      bigint;
  v_src    text;
  v_status text;
  v_plan   text;
  v_feat   text;
  v_old    boolean;
BEGIN
  -- POSTCONDICION 1 · lo redefinido conserva OID, SECURITY DEFINER, owner,
  -- search_path y ACL.
  FOR s IN SELECT * FROM _p3a2s_snapshot LOOP
    SELECT p.prosecdef, p.proowner, p.proconfig, p.proacl INTO v_now FROM pg_catalog.pg_proc p WHERE p.oid = s.oid;
    IF NOT FOUND THEN RAISE EXCEPTION 'POSTCONDICION 1: % cambio de OID', s.firma; END IF;
    IF v_now.prosecdef IS DISTINCT FROM s.prosecdef OR v_now.proowner IS DISTINCT FROM s.proowner
       OR v_now.proconfig IS DISTINCT FROM s.proconfig OR v_now.proacl IS DISTINCT FROM s.proacl THEN
      RAISE EXCEPTION 'POSTCONDICION 1: % cambio definer/owner/search_path/ACL', s.firma;
    END IF;
  END LOOP;

  -- POSTCONDICION 2 · regla de plan: identica a la previa para toda feature salvo
  -- mayorista, que ahora es Pro+ (trial incluido) y nunca Basico.
  FOR v_status IN SELECT unnest(ARRAY['active','trialing','past_due','suspended','canceled','pending_activation', NULL]) LOOP
    FOR v_plan IN SELECT unnest(ARRAY['basico','pro','full', NULL]) LOOP
      FOR v_feat IN SELECT unnest(ARRAY['arca','currentAccounts','tasks','advancedFinance','reports','mayorista',
                                        'advancedRoles','audit','multisucursal','personal_finance','otra']) LOOP
        v_old := COALESCE(v_status IN ('active', 'trialing') AND CASE v_feat
                   WHEN 'arca'            THEN v_plan IN ('pro','full') OR v_status = 'trialing'
                   WHEN 'currentAccounts' THEN v_plan IN ('pro','full') OR v_status = 'trialing'
                   WHEN 'tasks'           THEN v_plan IN ('pro','full') OR v_status = 'trialing'
                   WHEN 'advancedFinance' THEN v_plan IN ('pro','full') OR v_status = 'trialing'
                   WHEN 'reports'         THEN v_plan IN ('pro','full') OR v_status = 'trialing'
                   WHEN 'mayorista'       THEN v_plan = 'full'
                   WHEN 'advancedRoles'   THEN v_plan = 'full'
                   WHEN 'audit'           THEN v_plan = 'full'
                   WHEN 'multisucursal'   THEN v_plan = 'full'
                   ELSE true END, false);
        IF v_feat = 'mayorista' THEN
          v_old := COALESCE(v_status IN ('active', 'trialing') AND (v_plan IN ('pro','full') OR v_status = 'trialing'), false);
        END IF;
        IF private.plan_feature_enabled(v_status, v_plan, v_feat) IS DISTINCT FROM v_old THEN
          RAISE EXCEPTION 'POSTCONDICION 2: plan_feature_enabled(%, %, %) = %, esperado %',
            v_status, v_plan, v_feat, private.plan_feature_enabled(v_status, v_plan, v_feat), v_old;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  IF private.plan_feature_enabled('active', 'basico', 'mayorista')
     OR NOT private.plan_feature_enabled('active', 'pro', 'mayorista')
     OR NOT private.plan_feature_enabled('active', 'full', 'mayorista')
     OR NOT private.plan_feature_enabled('trialing', NULL, 'mayorista') THEN
    RAISE EXCEPTION 'POSTCONDICION 2b: matriz Mayorista Basico/Pro/Full/trial incorrecta';
  END IF;
  FOR v_src IN SELECT p.prosrc FROM pg_catalog.pg_proc p
                WHERE p.oid IN ('public.get_business_subscription_features(uuid)'::regprocedure,
                                'public.get_wholesale_portal_features(text)'::regprocedure) LOOP
    IF v_src !~ '''mayorista'',\s+"public"\."_feat_pro"\(' THEN
      RAISE EXCEPTION 'POSTCONDICION 2c: una superficie de features sigue sin resolver mayorista como Pro';
    END IF;
  END LOOP;

  -- POSTCONDICION 3 · el nucleo de capacidades solo cambia `wholesale` para
  -- manager/sales sin override (antes true, ahora false).
  SELECT string_agg(format('%s/%s/%s', c.role, c.label, c.key), ', ') INTO v_bad
    FROM _p3a2s_capabilities c
   WHERE private.capability_resolve(c.role, c.perms, c.key) IS DISTINCT FROM c.allowed
     AND NOT (c.key = 'wholesale' AND c.role IN ('manager', 'sales') AND c.label IN ('sin_override', 'roto')
              AND c.allowed AND NOT private.capability_resolve(c.role, c.perms, c.key));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDICION 3: capability_resolve cambio fuera de wholesale manager/sales: %', v_bad;
  END IF;
  IF private.capability_resolve('manager', NULL, 'wholesale') OR private.capability_resolve('sales', NULL, 'wholesale')
     OR NOT private.capability_resolve('admin', NULL, 'wholesale') OR NOT private.capability_resolve('owner', NULL, 'wholesale')
     OR NOT private.capability_resolve('manager', '{"wholesale":true}'::jsonb, 'wholesale') THEN
    RAISE EXCEPTION 'POSTCONDICION 3b: defaults/overrides de wholesale incorrectos';
  END IF;

  -- POSTCONDICION 4 · helpers: SECURITY DEFINER donde corresponde, search_path
  -- endurecido, sin EXECUTE para PUBLIC/anon/service_role, authenticated si.
  FOR s IN SELECT unnest(ARRAY['public.current_user_has_wholesale_access(uuid)',
                               'public.current_user_can_manage_wholesale(uuid)',
                               'public.get_or_create_customer_from_wholesale_atomic(uuid,uuid)']) AS firma LOOP
    SELECT p.prosecdef, p.proconfig INTO v_now FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(s.firma);
    IF NOT v_now.prosecdef OR v_now.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp'] THEN
      RAISE EXCEPTION 'POSTCONDICION 4: % sin SECURITY DEFINER o search_path endurecido', s.firma;
    END IF;
    IF has_function_privilege('anon', to_regprocedure(s.firma), 'EXECUTE')
       OR has_function_privilege('service_role', to_regprocedure(s.firma), 'EXECUTE')
       OR NOT has_function_privilege('authenticated', to_regprocedure(s.firma), 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDICION 4: grants de % incorrectos', s.firma;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                WHERE p.oid = to_regprocedure(s.firma) AND a.grantee = 0) THEN
      RAISE EXCEPTION 'POSTCONDICION 4: % ejecutable por PUBLIC', s.firma;
    END IF;
  END LOOP;
  FOR s IN SELECT unnest(ARRAY['private.plan_feature_enabled(text,text,text)', 'private.business_feature_enabled(uuid,text)',
                               'private.wholesale_access_level(uuid)', 'private.enforce_customer_wholesale_authority()']) AS firma LOOP
    IF has_function_privilege('anon', to_regprocedure(s.firma), 'EXECUTE')
       OR has_function_privilege('authenticated', to_regprocedure(s.firma), 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDICION 4b: % ejecutable por la API', s.firma;
    END IF;
  END LOOP;

  -- POSTCONDICION 5 · checkout: el cuerpo es el relevado MAS la linea de autoridad.
  SELECT replace(p.prosrc, E'\r', '') INTO v_src FROM pg_catalog.pg_proc p
   WHERE p.oid = 'private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)'::regprocedure;
  IF position('v_is_wholesale := v_is_wholesale AND public.current_user_has_wholesale_access(p_business_id);' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTCONDICION 5: el checkout no exige la autoridad Mayorista';
  END IF;
  IF md5(replace(v_src, $ins$
      -- PRE-BETA-3A-2S: la tarifa mayorista exige cliente mayorista Y autoridad
      -- Mayorista del actor en ESTE negocio. Sin autoridad la venta NO se
      -- rechaza: los items se resuelven a precio minorista.
      v_is_wholesale := v_is_wholesale AND public.current_user_has_wholesale_access(p_business_id);$ins$, '')) <> '8ef9e4a8e7d15df55d90eb0983996d1f' THEN
    RAISE EXCEPTION 'POSTCONDICION 5b: el checkout cambio algo mas que la autoridad Mayorista';
  END IF;

  -- POSTCONDICION 6 · wholesale_*: ninguna policy usa la capacidad cruda ni el
  -- helper por rol; las tres de lectura usan el helper canonico.
  SELECT string_agg(tablename || '.' || policyname, ', ') INTO v_bad
    FROM pg_catalog.pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('wholesale_customers', 'wholesale_orders', 'wholesale_order_items')
     AND (COALESCE(qual, '') || COALESCE(with_check, '')) ~ '(current_user_can\(''wholesale''|can_manage_wholesale\(\)|current_user_can_in_business)';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDICION 6: policies mayoristas con autoridad vieja: %', v_bad;
  END IF;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_policies
   WHERE schemaname = 'public' AND policyname IN ('wc_staff_read', 'wo_staff_read', 'woi_staff_read')
     AND qual ~ 'current_user_has_wholesale_access\(business_id\)';
  IF v_n <> 3 THEN RAISE EXCEPTION 'POSTCONDICION 6b: faltan las policies de lectura canonicas (%)', v_n; END IF;

  -- POSTCONDICION 7 · las RPC de escritura usan la autoridad de gestion.
  FOR v_src IN SELECT p.prosrc FROM pg_catalog.pg_proc p
                WHERE p.oid IN ('public.update_wholesale_order_status_atomic(uuid,uuid,text,text)'::regprocedure,
                                'public.update_wholesale_customer_status_atomic(uuid,uuid,boolean,boolean,text)'::regprocedure) LOOP
    IF position('public.current_user_can_manage_wholesale(p_business_id)' IN v_src) = 0
       OR v_src ~ 'current_user_can_in_business' THEN
      RAISE EXCEPTION 'POSTCONDICION 7: una RPC mayorista no usa la autoridad de gestion';
    END IF;
  END LOOP;

  -- POSTCONDICION 8 · el trigger de customers existe, esta habilitado y cubre
  -- INSERT y UPDATE de las columnas protegidas.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                  WHERE t.tgrelid = 'public.customers'::regclass
                    AND t.tgname = 'trig_customers_wholesale_authority'
                    AND t.tgenabled = 'O'
                    AND t.tgfoid = 'private.enforce_customer_wholesale_authority()'::regprocedure) THEN
    RAISE EXCEPTION 'POSTCONDICION 8: falta el trigger de autoridad de customers';
  END IF;

  -- POSTCONDICION 9 · cero DML sobre customers.
  IF (SELECT row(n, huella) FROM _p3a2s_customers) IS DISTINCT FROM
     (SELECT row(count(*), md5(COALESCE(string_agg(concat_ws('|', c.id, c.customer_type, c.business_name, c.contact_person, c.updated_at), ',' ORDER BY c.id), '')))
        FROM public.customers c) THEN
    RAISE EXCEPTION 'POSTCONDICION 9: la migracion modifico filas de customers';
  END IF;

  RAISE NOTICE 'PRE-BETA-3A-2S OK · mayorista Pro+ · wholesale owner/admin automatico · customers/checkout/conversion con autoridad server-side';
END
$post$;

COMMIT;
