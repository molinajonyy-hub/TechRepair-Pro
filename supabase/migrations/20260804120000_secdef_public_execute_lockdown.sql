-- ============================================================================
-- P0 Seguridad — EXECUTE a PUBLIC sobre funciones SECURITY DEFINER
--
-- Migracion CANONICA. Reemplaza a las dos ramas rivales que colisionaban en el
-- timestamp 20260803140000 (ninguna de las dos se aplico nunca). No se copia
-- ningun archivo rival completo: se toma la contencion quirurgica de una y el
-- inventario con postcondiciones de la otra.
--
-- ── CAUSA ───────────────────────────────────────────────────────────────────
-- `GRANT EXECUTE ... TO PUBLIC` es el DEFAULT de PostgreSQL al crear una
-- funcion. Una SECURITY DEFINER nace, por lo tanto, ejecutable por `anon`
-- salvo REVOKE explicito. Medido contra produccion (211 migraciones, head
-- 20260803120000) con has_function_privilege, que es la unica fuente de verdad:
-- `proacl IS NULL` NO significa "sin permisos", significa "default = PUBLIC".
--
--   173  SECURITY DEFINER en `public`
--    78  ejecutables por anon
--    51  de esas, invocables como RPC via PostgREST (no-trigger)
--    20  de esas, SIN ninguna barrera de autorizacion   <-- lo que cierra esto
--
-- ── LOS 5 P0 CONFIRMADOS LEYENDO EL CUERPO (no por heuristica) ──────────────
--   [1] bootstrap_owner_profile   ESCRIBE. anon usa el email como oraculo,
--       promueve un perfil a `owner`, fuerza is_active=true y ademas BORRA
--       perfiles que compartan ese email. Escalada de privilegios completa.
--   [2] recalculate_product_prices ESCRIBE cost_price y sale_price de TODO un
--       negocio ajeno. Corrompe COGS y por lo tanto v_finance_pnl.
--   [3] pay_card_statement_atomic  ESCRIBE finanzas personales (Mi Guita).
--       Valida la propiedad contra `p_user_id`, un parametro que ELIGE el
--       llamador: la identidad se afirma, no se prueba. Ninguno de los dos
--       informes rivales lo habia marcado.
--   [4] get_business_subscription  LEE mp_payer_email / mp_preapproval_id de
--       cualquier negocio. PII de facturacion + enumeracion.
--   [5] get_active_sales_point     LEE mp_store_id / mp_pos_id / mp_terminal_id
--       y la configuracion de comisiones de cualquier negocio.
--
-- ── POR QUE NO SE REVOCAN LAS 78 ────────────────────────────────────────────
-- 1) 27 de las 78 son trigger-only (prorettype = trigger). PostgREST no las
--    expone: no son invocables como RPC. Se documentan y se dejan intactas;
--    tocarles los grants no cierra nada y arriesga los triggers financieros.
-- 2) 7 son helpers de RLS. `current_business_id()` aparece en 95 policies e
--    `is_staff()` en 81, y 135 policies de `public` apuntan a `{public}` —o sea
--    que `anon` las evalua—. Revocarle esos helpers a anon no devuelve 0 filas:
--    devuelve 42501 y rompe la app. Todos derivan de auth.uid(), asi que para
--    anon son INERTES (NULL/false). Quedan en la allowlist.
-- 3) Reponer `authenticated` con un loop general escalaba de 109 a 142 y
--    reabria AFIP/WhatsApp/crypto. Aca cada GRANT va enumerado por firma exacta.
--
-- ── EFECTO SOBRE authenticated ──────────────────────────────────────────────
-- Baseline 135 -> 129. Pierde 7 (funciones muertas o de cron a las que solo
-- llegaba via PUBLIC) y gana 1: `get_wholesale_portal_features`, la unica
-- excepcion, explicita y documentada (seccion 4).
--
-- NO toca: FASE 2 del portal, Realtime, finance_health_check_v2, backfills.
-- Idempotente. No modifica datos de negocio.
-- ============================================================================

-- BEGIN/COMMIT EXPLICITOS, a proposito (ninguna otra migracion del repo los
-- usa). El CLI aplica cada archivo en AUTOCOMMIT —comprobado: sin este bloque
-- los `SET LOCAL` de abajo emiten "SET LOCAL can only be used in transaction
-- blocks" y no tienen efecto—. Sin transaccion, una postcondicion fallida
-- dejaria los REVOKE a medio aplicar en vez de abortar limpio, que es
-- justamente lo que este archivo promete.
BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- ── 0. Baseline, para poder ABORTAR si una postcondicion no se cumple ───────
-- Temp table de SESION (no `ON COMMIT DROP`): asi sobrevive tanto si la
-- migracion corre dentro de la transaccion del CLI como si se aplica con
-- `psql -f` en autocommit, donde cada statement commitea por separado y un
-- ON COMMIT DROP borraria el baseline antes de la seccion 6. Se dropea al final.
DROP TABLE IF EXISTS _secdef_baseline;
CREATE TEMP TABLE _secdef_baseline AS
SELECT p.oid,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authn,
       has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE p.prosecdef AND n.nspname = 'public';


-- ============================================================================
-- 1. Helper de pertenencia — el guard que faltaba
-- ============================================================================
-- Espeja a `_require_platform_admin`, que ya existe y protege las 10 admin_*.
-- Devuelve el actor para que el llamador lo audite. Lanza 42501, nunca "0 filas":
-- un rechazo tiene que ser distinguible de un resultado vacio.
CREATE OR REPLACE FUNCTION "public"."_require_business_member"(
  "p_business_id" "uuid",
  "p_roles"       "text"[] DEFAULT NULL
) RETURNS "uuid"
LANGUAGE "plpgsql" STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := "auth"."uid"();
  v_role  text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF "p_business_id" IS NULL THEN
    RAISE EXCEPTION 'business_id is required' USING ERRCODE = '42501';
  END IF;

  SELECT p."role" INTO v_role
  FROM "public"."profiles" p
  WHERE COALESCE(p."user_id", p."id") = v_actor
    AND COALESCE(p."is_active", TRUE) = TRUE
    AND p."business_id" = "p_business_id"
  ORDER BY COALESCE(p."updated_at", p."created_at", NOW()) DESC
  LIMIT 1;

  IF v_role IS NULL THEN
    -- Mensaje deliberadamente generico: no confirma si el negocio existe.
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  IF "p_roles" IS NOT NULL AND NOT (v_role = ANY ("p_roles")) THEN
    RAISE EXCEPTION 'Forbidden: requires role in %', "p_roles" USING ERRCODE = '42501';
  END IF;

  RETURN v_actor;
END;
$$;

ALTER FUNCTION "public"."_require_business_member"("uuid", "text"[]) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."_require_business_member"("uuid", "text"[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."_require_business_member"("uuid", "text"[]) TO "authenticated";

COMMENT ON FUNCTION "public"."_require_business_member"("uuid", "text"[]) IS
  'Exige que auth.uid() sea miembro ACTIVO de p_business_id (y opcionalmente '
  'con uno de p_roles). Lanza 42501. Contraparte de _require_platform_admin '
  'para el scope de negocio. anon NO lo puede ejecutar.';


-- ============================================================================
-- 2. bootstrap_owner_profile — P0 [1]
-- ============================================================================
-- CONTRATO NUEVO: el actor solo puede bootstrapearse A SI MISMO.
--   · anon y PUBLIC bloqueados (grants, abajo);
--   · el email deja de ser un selector: se resuelve desde auth.uid() y
--     `p_user_email` pasa a ser una ASERCION que debe coincidir. Un email ajeno
--     ya no es un oraculo ni un vector de promocion: es un 42501;
--   · el DELETE queda acotado al propio usuario;
--   · rechazo => cero cambios (la excepcion aborta la transaccion);
--   · idempotente: la 2da llamada devuelve el mismo business_id.
-- Se conserva la firma exacta (incluido el DEFAULT) para no romper
-- src/pages/Onboarding.tsx ni src/pages/NoBusiness.tsx, que ya mandan el email
-- de la propia sesion.
CREATE OR REPLACE FUNCTION "public"."bootstrap_owner_profile"(
  "p_user_email"    "text",
  "p_business_name" "text",
  "p_full_name"     "text" DEFAULT NULL::"text"
) RETURNS "uuid"
LANGUAGE "plpgsql" SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user_id     uuid := "auth"."uid"();
  v_actor_email text;
  v_profile_id  uuid;
  v_business_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT lower(u."email") INTO v_actor_email
  FROM "auth"."users" u WHERE u."id" = v_user_id;

  IF v_actor_email IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  -- La identidad se PRUEBA con el JWT; el parametro solo se verifica.
  IF lower(btrim(COALESCE("p_user_email", ''))) <> v_actor_email THEN
    RAISE EXCEPTION 'Forbidden: solo podes inicializar tu propio perfil'
      USING ERRCODE = '42501';
  END IF;

  IF btrim(COALESCE("p_business_name", '')) = '' THEN
    RAISE EXCEPTION 'El nombre del negocio es obligatorio' USING ERRCODE = '22023';
  END IF;

  SELECT p."id", p."business_id" INTO v_profile_id, v_business_id
  FROM "public"."profiles" p
  WHERE COALESCE(p."user_id", p."id") = v_user_id
     OR lower(COALESCE(p."email", '')) = v_actor_email
  ORDER BY (p."business_id" IS NOT NULL) DESC,
           COALESCE(p."updated_at", p."created_at", NOW()) DESC
  LIMIT 1;

  IF v_business_id IS NULL THEN
    INSERT INTO "public"."businesses" ("name", "owner_user_id")
    VALUES (btrim("p_business_name"), v_user_id)
    RETURNING "id" INTO v_business_id;
  END IF;

  IF v_profile_id IS NULL THEN
    INSERT INTO "public"."profiles"
      ("user_id", "business_id", "role", "is_active", "full_name", "email")
    VALUES (v_user_id, v_business_id, 'owner', TRUE,
            NULLIF(btrim("p_full_name"), ''), v_actor_email);
  ELSE
    UPDATE "public"."profiles"
    SET "user_id"    = COALESCE("user_id", v_user_id),
        "business_id"= v_business_id,
        "role"       = 'owner',
        "is_active"  = TRUE,
        "full_name"  = COALESCE(NULLIF(btrim("p_full_name"), ''), "full_name"),
        "email"      = v_actor_email,
        "updated_at" = NOW()
    WHERE "id" = v_profile_id;
  END IF;

  -- Antes borraba tambien por email. Ahora SOLO perfiles del propio usuario:
  -- un tercero que comparta email jamas puede ser alcanzado por este DELETE.
  DELETE FROM "public"."profiles"
  WHERE "id" IS DISTINCT FROM v_profile_id
    AND COALESCE("user_id", "id") = v_user_id;

  UPDATE "public"."businesses"
  SET "owner_user_id" = COALESCE("owner_user_id", v_user_id),
      "updated_at"    = NOW()
  WHERE "id" = v_business_id;

  RETURN v_business_id;
END;
$$;

ALTER FUNCTION "public"."bootstrap_owner_profile"("text", "text", "text") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."bootstrap_owner_profile"("text", "text", "text") IS
  'Inicializa el negocio y el perfil owner DEL PROPIO auth.uid(). p_user_email '
  'es una asercion verificada contra auth.users, no un selector: un email ajeno '
  'da 42501. Idempotente. NO ejecutable por anon.';


-- ============================================================================
-- 3. recalculate_product_prices — P0 [2]
-- ============================================================================
-- Sin consumidores en el repo (el frontend usa update_inventory_dollar_prices),
-- pero se endurece igual: la regla del repo es que una funcion critica NO puede
-- depender solo del REVOKE. Ademas de la pertenencia se exige rol de gestion y
-- se validan los limites del multiplicador, que antes no se validaban.
CREATE OR REPLACE FUNCTION "public"."recalculate_product_prices"(
  "p_business_id" "uuid",
  "p_new_rate"    numeric
) RETURNS integer
LANGUAGE "plpgsql" SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  updated_count int;
BEGIN
  PERFORM "public"."_require_business_member"("p_business_id",
                                              ARRAY['owner', 'admin', 'manager']);

  IF "p_new_rate" IS NULL OR "p_new_rate" <= 0 THEN
    RAISE EXCEPTION 'El tipo de cambio debe ser mayor a 0' USING ERRCODE = '22023';
  END IF;
  IF "p_new_rate" > 1000000 THEN
    RAISE EXCEPTION 'Tipo de cambio fuera de rango' USING ERRCODE = '22023';
  END IF;

  UPDATE "public"."inventory"
  SET "sale_price"         = round("base_price" * "p_new_rate", 2),
      "cost_price"         = round("cost_price" * "p_new_rate", 2),
      "exchange_rate_used" = "p_new_rate",
      "updated_at"         = NOW()
  WHERE "business_id"        = "p_business_id"
    AND "base_currency"      = 'USD'
    AND "auto_update_price"  = TRUE
    AND "exchange_rate_used" IS NOT NULL;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

ALTER FUNCTION "public"."recalculate_product_prices"("uuid", numeric) OWNER TO "postgres";

COMMENT ON FUNCTION "public"."recalculate_product_prices"("uuid", numeric) IS
  'Recalcula precios en USD del negocio. Exige pertenencia + rol de gestion y '
  'valida el rango del multiplicador. Escribe cost_price, o sea que alimenta '
  'COGS y v_finance_pnl: cross-tenant aca corrompe el P&L. NO ejecutable por anon.';


-- ============================================================================
-- 4. Suscripcion y features — P0 [4] y separacion de contratos del portal
-- ============================================================================
-- get_business_subscription: expone facturacion de Mercado Pago. No tiene NI UN
-- consumidor en el repo (se verifico sobre src/ y supabase/functions/). Se le
-- pone guard de owner/admin ademas de cerrarle los grants a todo el mundo salvo
-- service_role: si alguna vez vuelve a exponerse, ya nace cerrada.
CREATE OR REPLACE FUNCTION "public"."get_business_subscription"("p_business_id" "uuid")
RETURNS "jsonb"
LANGUAGE "plpgsql" SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  result jsonb;
BEGIN
  PERFORM "public"."_require_business_member"("p_business_id", ARRAY['owner', 'admin']);

  SELECT "jsonb_build_object"(
    'subscription_status',  b."subscription_status",
    'subscription_plan',    b."subscription_plan",
    'mp_preapproval_id',    b."mp_preapproval_id",
    'mp_payer_email',       b."mp_payer_email",
    'current_period_start', b."current_period_start",
    'current_period_end',   b."current_period_end",
    'grace_until',          b."grace_until",
    'last_payment_status',  b."last_payment_status",
    'trial_ends_at',        b."trial_ends_at"
  ) INTO result
  FROM "public"."businesses" b
  WHERE b."id" = "p_business_id";

  RETURN result;
END;
$$;

ALTER FUNCTION "public"."get_business_subscription"("uuid") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."get_business_subscription"("uuid") IS
  'Snapshot de facturacion (incluye mp_payer_email / mp_preapproval_id). Solo '
  'owner/admin del propio negocio. Sin consumidores en el repo al 2026-08-04.';

-- ── 4.b get_business_subscription_features: contrato INTERNO ────────────────
-- El paywall del comercio. Se le agrega pertenencia. Esto SOLO es posible
-- porque el portal mayorista deja de usarla (4.c): un cliente del portal es
-- `authenticated` pero NO es miembro del negocio, asi que un guard de
-- pertenencia lo romperia y un guard de "solo sesion" no cerraria nada
-- (cualquier registrado consultaria features de cualquier tenant por
-- business_id). Las dos soluciones parciales se descartan a proposito.
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
    'mayorista',        "public"."_feat_full"(b."subscription_status", b."subscription_plan")
  ) INTO result
  FROM "public"."businesses" b
  WHERE b."id" = "p_business_id";

  RETURN result;
END;
$$;

ALTER FUNCTION "public"."get_business_subscription_features"("uuid") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."get_business_subscription_features"("uuid") IS
  'Contrato INTERNO del paywall: solo miembros activos del negocio. El portal '
  'mayorista NO debe usar esta funcion (sus clientes no son miembros): tiene su '
  'propia superficie, get_wholesale_portal_features(p_slug).';

-- ── 4.c Superficie del portal: por SLUG, minima, sin business_id arbitrario ─
-- Devuelve SOLO los dos flags que el portal necesita para decidir si puede
-- tomar un pedido. Nada de plan, estado, fechas ni metadata interna. Exige slug
-- exacto (no enumera) y solo responde por negocios con el portal ENCENDIDO.
-- Esta es la UNICA excepcion documentada al principio de "authenticated no gana
-- funciones": la gana porque reemplaza un acceso mas amplio que pierde en 4.b.
CREATE OR REPLACE FUNCTION "public"."get_wholesale_portal_features"("p_slug" "text")
RETURNS "jsonb"
LANGUAGE "sql" STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT "jsonb_build_object"(
    'mayorista', "public"."_feat_full"(b."subscription_status", b."subscription_plan"),
    'active',    COALESCE(b."subscription_status", 'trialing')
                   NOT IN ('suspended', 'canceled')
  )
  FROM "public"."businesses" b
  WHERE b."wholesale_portal_enabled" = true
    AND b."wholesale_portal_slug"    = "p_slug"
  LIMIT 1;
$$;

ALTER FUNCTION "public"."get_wholesale_portal_features"("text") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."get_wholesale_portal_features"("text") IS
  'Superficie de features del portal mayorista. Dos booleanos y nada mas: ni '
  'plan, ni estado crudo, ni fechas, ni access_source. Se resuelve por slug '
  'exacto y solo para portales encendidos, asi que no acepta business_id '
  'arbitrario ni permite enumerar. Consumidor: src/portal/services/portalService.ts.';


-- ============================================================================
-- 5. Privilegios — enumerados por firma exacta, sin loops
-- ============================================================================
-- REVOKE ... FROM PUBLIC es lo que efectivamente cierra: mientras exista el
-- grant a PUBLIC, revocarle a `anon` no alcanza (hereda por PUBLIC).

-- ── 5.a Los 5 P0 ────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION "public"."bootstrap_owner_profile"("text", "text", "text") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."bootstrap_owner_profile"("text", "text", "text") FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."bootstrap_owner_profile"("text", "text", "text") TO "authenticated";

REVOKE ALL ON FUNCTION "public"."recalculate_product_prices"("uuid", numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."recalculate_product_prices"("uuid", numeric) FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."recalculate_product_prices"("uuid", numeric) TO "authenticated";

-- Sin consumidor y con cuerpo financiero grande: se cierra por grants en vez de
-- reescribirlo. Reescribir a ciegas una funcion de dinero que nadie llama es
-- riesgo sin contraparte. Queda solo para service_role.
REVOKE ALL ON FUNCTION "public"."pay_card_statement_atomic"(
  "uuid", "uuid", "uuid", "text", numeric, "text", "date", "text", "text") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."pay_card_statement_atomic"(
  "uuid", "uuid", "uuid", "text", numeric, "text", "date", "text", "text") FROM "anon";
REVOKE ALL ON FUNCTION "public"."pay_card_statement_atomic"(
  "uuid", "uuid", "uuid", "text", numeric, "text", "date", "text", "text") FROM "authenticated";

REVOKE ALL ON FUNCTION "public"."get_business_subscription"("uuid") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."get_business_subscription"("uuid") FROM "anon";
REVOKE ALL ON FUNCTION "public"."get_business_subscription"("uuid") FROM "authenticated";

REVOKE ALL ON FUNCTION "public"."get_active_sales_point"("uuid") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."get_active_sales_point"("uuid") FROM "anon";
REVOKE ALL ON FUNCTION "public"."get_active_sales_point"("uuid") FROM "authenticated";

-- ── 5.b Paywall y portal ────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION "public"."get_business_subscription_features"("uuid") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."get_business_subscription_features"("uuid") FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."get_business_subscription_features"("uuid") TO "authenticated";

REVOKE ALL ON FUNCTION "public"."get_wholesale_portal_features"("text") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."get_wholesale_portal_features"("text") TO "anon";
GRANT EXECUTE ON FUNCTION "public"."get_wholesale_portal_features"("text") TO "authenticated";

-- ── 5.c Resto de las no-guardadas invocables: cierre a PUBLIC/anon ──────────
-- Con consumidor autenticado real => se repone `authenticated` (preservacion,
-- no ampliacion: ya llegaban via PUBLIC).
REVOKE ALL ON FUNCTION "public"."generar_numero_comprobante"("text", "uuid", "text") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."generar_numero_comprobante"("text", "uuid", "text") FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."generar_numero_comprobante"("text", "uuid", "text") TO "authenticated";

REVOKE ALL ON FUNCTION "public"."generar_numero_garantia"("uuid") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."generar_numero_garantia"("uuid") FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."generar_numero_garantia"("uuid") TO "authenticated";

REVOKE ALL ON FUNCTION "public"."recalcular_totales_comprobante"("uuid") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."recalcular_totales_comprobante"("uuid") FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."recalcular_totales_comprobante"("uuid") TO "authenticated";

REVOKE ALL ON FUNCTION "public"."get_or_create_brand"("text", "uuid") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."get_or_create_brand"("text", "uuid") FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."get_or_create_brand"("text", "uuid") TO "authenticated";

REVOKE ALL ON FUNCTION "public"."get_or_create_model"("text", "uuid", "uuid") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."get_or_create_model"("text", "uuid", "uuid") FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."get_or_create_model"("text", "uuid", "uuid") TO "authenticated";

REVOKE ALL ON FUNCTION "public"."ensure_brand_and_model"("text", "text", "uuid") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."ensure_brand_and_model"("text", "text", "uuid") FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."ensure_brand_and_model"("text", "text", "uuid") TO "authenticated";

REVOKE ALL ON FUNCTION "public"."is_comprobante_annulled"("uuid") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."is_comprobante_annulled"("uuid") FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."is_comprobante_annulled"("uuid") TO "authenticated";

REVOKE ALL ON FUNCTION "public"."is_platform_admin"("uuid", "text") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."is_platform_admin"("uuid", "text") FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."is_platform_admin"("uuid", "text") TO "authenticated";

REVOKE ALL ON FUNCTION "public"."is_owner_or_admin"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."is_owner_or_admin"() FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."is_owner_or_admin"() TO "authenticated";

-- Sin consumidor: no se repone nada.
REVOKE ALL ON FUNCTION "public"."inventory_product_history"("uuid", "uuid") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."inventory_product_history"("uuid", "uuid") FROM "anon";
REVOKE ALL ON FUNCTION "public"."inventory_product_history"("uuid", "uuid") FROM "authenticated";

REVOKE ALL ON FUNCTION "public"."create_default_payment_buttons"("uuid") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."create_default_payment_buttons"("uuid") FROM "anon";
REVOKE ALL ON FUNCTION "public"."create_default_payment_buttons"("uuid") FROM "authenticated";

-- ── 5.d Mantenimiento / cron: solo service_role ─────────────────────────────
REVOKE ALL ON FUNCTION "public"."enforce_grace_period"()   FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."enforce_grace_period"()   FROM "anon";
REVOKE ALL ON FUNCTION "public"."enforce_grace_period"()   FROM "authenticated";
GRANT EXECUTE ON FUNCTION "public"."enforce_grace_period"() TO "service_role";

REVOKE ALL ON FUNCTION "public"."expire_trials"()   FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."expire_trials"()   FROM "anon";
REVOKE ALL ON FUNCTION "public"."expire_trials"()   FROM "authenticated";
GRANT EXECUTE ON FUNCTION "public"."expire_trials"() TO "service_role";

REVOKE ALL ON FUNCTION "public"."expire_old_invitations"()   FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."expire_old_invitations"()   FROM "anon";
REVOKE ALL ON FUNCTION "public"."expire_old_invitations"()   FROM "authenticated";
GRANT EXECUTE ON FUNCTION "public"."expire_old_invitations"() TO "service_role";

-- ── 5.e Event trigger: no la invoca nadie por RPC ───────────────────────────
REVOKE ALL ON FUNCTION "public"."rls_auto_enable"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."rls_auto_enable"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."rls_auto_enable"() FROM "authenticated";

-- ── 5.g Funciones de sesion: inertes para anon, pero anon no las necesita ───
-- Todas derivan de auth.uid() (o exigen pertenencia), asi que hoy para anon
-- devuelven NULL/false o lanzan. Igual se les saca anon: "inerte" no es lo
-- mismo que "inalcanzable", y ninguna aparece en policies {public} (se
-- verificaron las 9 funciones referenciadas por policies; estas no estan).
-- Sin esto, la superficie anon queda con 14 RPC que nadie fuera de una sesion
-- deberia poder ni siquiera enumerar.
REVOKE ALL ON FUNCTION "public"."accept_business_invitation"("text") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."accept_business_invitation"("text") FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."accept_business_invitation"("text") TO "authenticated";

REVOKE ALL ON FUNCTION "public"."cancel_business_invitation"("uuid") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."cancel_business_invitation"("uuid") FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."cancel_business_invitation"("uuid") TO "authenticated";

REVOKE ALL ON FUNCTION "public"."create_business_invitation"("text", "text") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."create_business_invitation"("text", "text") FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."create_business_invitation"("text", "text") TO "authenticated";

REVOKE ALL ON FUNCTION "public"."create_business_invitation"("text", "text", "uuid") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."create_business_invitation"("text", "text", "uuid") FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."create_business_invitation"("text", "text", "uuid") TO "authenticated";

REVOKE ALL ON FUNCTION "public"."change_user_role"("uuid", "text") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."change_user_role"("uuid", "text") FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."change_user_role"("uuid", "text") TO "authenticated";

REVOKE ALL ON FUNCTION "public"."set_user_active_status"("uuid", boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."set_user_active_status"("uuid", boolean) FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."set_user_active_status"("uuid", boolean) TO "authenticated";

REVOKE ALL ON FUNCTION "public"."current_platform_admin_role"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."current_platform_admin_role"() FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."current_platform_admin_role"() TO "authenticated";

REVOKE ALL ON FUNCTION "public"."get_my_profile"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."get_my_profile"() FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."get_my_profile"() TO "authenticated";

REVOKE ALL ON FUNCTION "public"."link_profile_to_auth_user"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."link_profile_to_auth_user"() FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."link_profile_to_auth_user"() TO "authenticated";

REVOKE ALL ON FUNCTION "public"."get_business_settings"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."get_business_settings"() FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."get_business_settings"() TO "authenticated";

REVOKE ALL ON FUNCTION "public"."get_current_exchange_rate"("text", "text") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."get_current_exchange_rate"("text", "text") FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."get_current_exchange_rate"("text", "text") TO "authenticated";

REVOKE ALL ON FUNCTION "public"."upsert_business_settings"(
  "uuid", "text", boolean, boolean, "text", integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."upsert_business_settings"(
  "uuid", "text", boolean, boolean, "text", integer) FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."upsert_business_settings"(
  "uuid", "text", boolean, boolean, "text", integer) TO "authenticated";

REVOKE ALL ON FUNCTION "public"."upsert_exchange_rate"(
  "uuid", "text", "text", numeric, boolean, "text") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."upsert_exchange_rate"(
  "uuid", "text", "text", numeric, boolean, "text") FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."upsert_exchange_rate"(
  "uuid", "text", "text", numeric, boolean, "text") TO "authenticated";

-- ── 5.f admin_*: tienen _require_platform_admin, pero PUBLIC sobra ──────────
-- Defensa en profundidad: el guard ya las cierra, el REVOKE las saca de la
-- superficie enumerable de PostgREST. `authenticated` se preserva porque el
-- panel de plataforma corre con sesion normal y el guard decide adentro.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND p.proname LIKE 'admin\_%'
      AND p.prosrc LIKE '%_require_platform_admin%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', r.sig, 'anon');
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', r.sig, 'authenticated');
  END LOOP;
END;
$$;


-- ============================================================================
-- 6. POSTCONDICIONES — la migracion ABORTA si alguna falla
-- ============================================================================
DO $$
DECLARE
  -- Allowlist anon: unica lista autoritativa. get_wholesale_portal_* son las
  -- superficies publicas intencionales; el resto son helpers de RLS derivados
  -- de auth.uid(), INERTES para anon y exigidos por policies {public}.
  v_allow CONSTANT text[] := ARRAY[
    'get_wholesale_portal_public(text)',
    'get_wholesale_portal_features(text)',
    'current_business_id()',
    'current_user_business_id()',
    'current_user_role()',
    'user_business_ids()',
    'is_staff()',
    'can_manage()'
  ];
  v_bad         text;
  v_authn_ini   int;
  v_authn_fin   int;
  v_sensible    text;
BEGIN
  -- [1] Ninguna SECDEF invocable como RPC queda accesible a anon fuera de la allowlist.
  -- Se compara por OID, no por texto: pg_get_function_identity_arguments incluye
  -- los NOMBRES de los parametros ("p_slug text"), asi que cualquier comparacion
  -- textual contra firmas por tipo da falsos positivos.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_bad
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND p.prorettype <> 'pg_catalog.trigger'::regtype
    AND has_function_privilege('anon', p.oid, 'EXECUTE')
    AND p.oid <> ALL (SELECT ('public.' || a)::regprocedure::oid FROM unnest(v_allow) a);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDICION 1: anon conserva SECDEF fuera de la allowlist: %', v_bad;
  END IF;

  -- [2] Toda la allowlist sigue siendo ejecutable (si no, rompimos RLS).
  SELECT string_agg(a, ', ') INTO v_bad
  FROM unnest(v_allow) a
  WHERE NOT has_function_privilege('anon', ('public.' || a)::regprocedure, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDICION 2: la allowlist perdio EXECUTE para anon: %', v_bad;
  END IF;

  -- [3] authenticated no crece (salvo la excepcion documentada de 4.c).
  SELECT count(*) FILTER (WHERE authn) INTO v_authn_ini FROM _secdef_baseline;
  SELECT count(*) INTO v_authn_fin
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_authn_fin > v_authn_ini + 1 THEN
    RAISE EXCEPTION 'POSTCONDICION 3: authenticated paso de % a % (max permitido %)',
      v_authn_ini, v_authn_fin, v_authn_ini + 1;
  END IF;

  -- [4] Las funciones de secretos/credenciales siguen cerradas.
  SELECT string_agg(p.proname, ', ') INTO v_sensible
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND (p.proname ~ '^(arca_|whatsapp_)' OR p.proname IN ('encrypt_data', 'decrypt_data'))
    AND (has_function_privilege('anon', p.oid, 'EXECUTE')
      OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_sensible IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDICION 4: funcion de credenciales expuesta: %', v_sensible;
  END IF;

  -- [5] Los 5 P0 quedaron efectivamente fuera del alcance de anon.
  SELECT string_agg(f, ', ') INTO v_bad
  FROM unnest(ARRAY[
    'public.bootstrap_owner_profile(text,text,text)',
    'public.recalculate_product_prices(uuid,numeric)',
    'public.get_business_subscription(uuid)',
    'public.get_active_sales_point(uuid)',
    'public.pay_card_statement_atomic(uuid,uuid,uuid,text,numeric,text,date,text,text)'
  ]) f
  WHERE has_function_privilege('anon', f::regprocedure, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDICION 5: P0 sigue alcanzable por anon: %', v_bad;
  END IF;

  RAISE NOTICE 'SECDEF lockdown OK · authenticated % -> % · allowlist anon: % funciones',
    v_authn_ini, v_authn_fin, array_length(v_allow, 1);
END;
$$;

DROP TABLE IF EXISTS _secdef_baseline;

COMMIT;

-- Fuera de la transaccion: NOTIFY no debe viajar en un rollback.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- FUERA DE ALCANCE (deliberado)
--   · 27 SECDEF trigger-only siguen ejecutables por anon. PostgREST no expone
--     funciones que devuelven `trigger`: no son invocables como RPC. Tocarles
--     los grants no cierra superficie y arriesga los triggers financieros.
--     Inventario completo en docs/p0-secdef-public-execute/informe.md.
--   · FASE 2 del portal (drop de businesses_portal_public_read) — rama aparte.
--   · Los 10 admin_* conservan `authenticated`: su guard es _require_platform_admin.
-- ============================================================================
