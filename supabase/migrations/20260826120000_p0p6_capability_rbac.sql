-- ═══════════════════════════════════════════════════════════════════════════
-- P0-P6 — Autorización por CAPACIDAD, no sólo por tenant.
--
-- ───────────────────────────────────────────────────────────────────────────
-- EL DEFECTO
-- ───────────────────────────────────────────────────────────────────────────
-- Todas las policies de lectura de las tablas financieras filtran ÚNICAMENTE
-- por negocio:
--
--     business_id = current_user_business_id()
--
-- Eso resuelve el AISLAMIENTO DE TENANT —un tech del negocio A no ve al
-- negocio B— pero NO resuelve el AISLAMIENTO DE CAPACIDAD: ese mismo tech SÍ
-- puede leer toda la información financiera de SU negocio (ganancia, caja,
-- costos, márgenes) llamando a PostgREST directamente desde DevTools, aunque la
-- interfaz no se la muestre.
--
-- Son dos dimensiones distintas y hasta ahora sólo estaba cerrada una:
--
--     tenant      ✓ cerrado
--     capability  ✗ abierto   <- lo que cierra esta migración
--
-- El incidente que disparó el lote fue visual (un tech vio tarjetas de
-- ganancia y caja), pero esconder la tarjeta no habría cerrado nada: el dato
-- seguía siendo accesible. La seguridad no puede vivir en el frontend.
--
-- ───────────────────────────────────────────────────────────────────────────
-- POR QUÉ UN HELPER Y NO `role IN (...)` EN CADA POLICY
-- ───────────────────────────────────────────────────────────────────────────
-- El repo YA tiene un modelo de permisos con overrides por usuario
-- (`src/config/permissions.ts` + `profiles.permissions`): defaults por rol que
-- el owner puede ajustar por persona. Escribir `role IN ('owner','admin')` en
-- las policies crearía un SEGUNDO modelo que ignora esos overrides, y las dos
-- fuentes divergirían al primer cambio.
--
-- `current_user_can()` es el espejo server-side de ese modelo: mismos defaults,
-- mismos overrides, misma precedencia. Un solo contrato, comprobable desde los
-- dos lados.
--
-- NO se tocan el ledger contable ni ningún cálculo: esta migración sólo decide
-- QUIÉN PUEDE LEER. Ninguna fila cambia.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. HELPER CANÓNICO — current_user_can(key)
-- ───────────────────────────────────────────────────────────────────────────
-- Espejo EXACTO de `effectivePermissions()` en src/hooks/usePermissions.ts:
--
--   owner                      -> todo true (superusuario del tenant)
--   resto                      -> defaults del rol + overrides de profiles.permissions
--   perfil inactivo / ausente  -> false (fail-closed)
--   clave desconocida          -> false (fail-closed)
--
-- La identidad es la CANÓNICA del sistema —`COALESCE(user_id, id) = auth.uid()`—
-- y no la columna cruda `user_id`. Importa: `provision_my_business` y
-- `accept_business_invitation` crean el perfil con `id = auth.uid()` y dejan
-- `user_id` en NULL, así que un helper que mire sólo `user_id` le da false a
-- todos los usuarios nuevos. Ese defecto ya existe en producción en
-- `user_can_view_order_amounts` (queda anotado como handoff; acá no se toca
-- para no ampliar el lote).
CREATE OR REPLACE FUNCTION public.current_user_can(p_key text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
-- `pg_temp` explícito y AL FINAL: omitirlo no lo saca del path, lo pone PRIMERO.
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid       uuid;
  v_role      text;
  v_perms     jsonb;
  v_override  jsonb;
  v_default   boolean;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL OR p_key IS NULL THEN
    RETURN false;
  END IF;

  SELECT p.role, p.permissions
    INTO v_role, v_perms
    FROM public.profiles p
   WHERE COALESCE(p.user_id, p.id) = v_uid
     AND COALESCE(p.is_active, true) = true
   ORDER BY (p.business_id IS NOT NULL) DESC,
            COALESCE(p.updated_at, p.created_at, now()) DESC
   LIMIT 1;

  -- Sin perfil activo no hay capacidad alguna.
  IF v_role IS NULL THEN
    RETURN false;
  END IF;

  -- `personal_finance` (Mi Guita) se resuelve ANTES del atajo de owner: durante
  -- la beta está cerrado para TODOS los roles del negocio, incluido el owner.
  -- Su acceso interno se decide por `system_admins`, que es un privilegio del
  -- SaaS y no del tenant. Si esto fuera después del atajo, todo owner de
  -- cualquier taller tendría Mi Guita, que es justo lo que se descartó.
  IF p_key = 'personal_finance' THEN
    RETURN false;
  END IF;

  -- El owner es el superusuario del tenant y NO admite overrides. Mismo
  -- contrato que `effectivePermissions()`: `if (isOwner) return owner defaults`.
  IF v_role = 'owner' THEN
    RETURN true;
  END IF;

  -- Defaults por rol. Espejo literal de ROLE_DEFAULT_PERMISSIONS.
  v_default := CASE p_key
    WHEN 'orders' THEN
      v_role IN ('admin','manager','tech','sales','cashier','viewer')
    WHEN 'orders_change_status' THEN
      v_role IN ('admin','manager','tech','sales')
    WHEN 'orders_view_financials' THEN
      v_role IN ('admin','manager','sales','cashier')
    WHEN 'inventory' THEN
      v_role IN ('admin','manager','sales')
    WHEN 'inventory_view_costs' THEN
      v_role IN ('admin','manager')
    WHEN 'customers' THEN
      v_role IN ('admin','manager','sales','cashier')
    WHEN 'finance' THEN
      v_role IN ('admin','cashier')
    WHEN 'comprobantes' THEN
      v_role IN ('admin','manager','sales','cashier')
    WHEN 'reports' THEN
      v_role IN ('admin','manager','cashier')
    WHEN 'settings' THEN
      v_role IN ('admin')
    WHEN 'settings_sensitive' THEN
      v_role IN ('admin')
    WHEN 'subscription' THEN
      false
    WHEN 'users' THEN
      v_role IN ('admin')
    -- P0-P6: capacidades nuevas. Ambas cerradas por defecto para todos los
    -- roles que no sean owner; el owner ya salió por el early-return de arriba.
    WHEN 'wholesale' THEN
      v_role IN ('admin','manager','sales')
    WHEN 'personal_finance' THEN
      false
    ELSE
      NULL          -- clave desconocida
  END;

  IF v_default IS NULL THEN
    RETURN false;   -- fail-closed ante una clave que este contrato no conoce
  END IF;

  -- Overrides explícitos por usuario. Sólo se respetan si el valor es un
  -- boolean de verdad: un payload roto no puede AMPLIAR privilegios.
  IF v_perms IS NOT NULL AND jsonb_typeof(v_perms) = 'object' THEN
    v_override := v_perms -> p_key;
    IF v_override IS NOT NULL AND jsonb_typeof(v_override) = 'boolean' THEN
      RETURN (v_override)::text::boolean;
    END IF;
  END IF;

  RETURN v_default;
END;
$$;

COMMENT ON FUNCTION public.current_user_can(text) IS
  'P0-P6. Espejo server-side de src/config/permissions.ts: defaults por rol + '
  'overrides de profiles.permissions. Fail-closed. Identidad canónica '
  'COALESCE(user_id, id) = auth.uid().';

REVOKE ALL ON FUNCTION public.current_user_can(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_can(text) TO authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. LECTURA FINANCIERA — tenant AND capacidad
-- ───────────────────────────────────────────────────────────────────────────
-- `financial_movements` tenía DOS policies PERMISSIVE de SELECT. Las permissive
-- se combinan con OR, así que agregar una tercera más estricta no habría
-- cerrado nada: hay que REEMPLAZAR las dos. Es el error clásico al endurecer
-- RLS y por eso se dejan nombradas de forma explícita.
DROP POLICY IF EXISTS financial_movements_business_select ON public.financial_movements;
DROP POLICY IF EXISTS fm_select                           ON public.financial_movements;

CREATE POLICY fm_select_finance_capability
  ON public.financial_movements FOR SELECT TO authenticated
  USING (
    business_id = public.current_user_business_id()
    AND public.current_user_can('finance')
  );

-- El ledger devengado. Alimenta ganancia, resultados y el resumen financiero
-- del dashboard.
DROP POLICY IF EXISTS bfe_select ON public.business_finance_entries;

CREATE POLICY bfe_select_finance_capability
  ON public.business_finance_entries FOR SELECT TO authenticated
  USING (
    business_id = public.current_user_business_id()
    AND public.current_user_can('finance')
  );

-- Los cobros de comprobantes se gatean con `comprobantes`, NO con `finance`:
-- un `sales` necesita leerlos para operar el POS (y ya los puede insertar),
-- mientras que `tech` y `viewer` quedan afuera. Gatearlos con `finance` habría
-- roto la venta para sales y manager.
DROP POLICY IF EXISTS cp_select ON public.comprobante_payments;

CREATE POLICY cp_select_comprobantes_capability
  ON public.comprobante_payments FOR SELECT TO authenticated
  USING (
    business_id = public.current_user_business_id()
    AND public.current_user_can('comprobantes')
  );

-- NOTA sobre las vistas financieras: `v_finance_pnl`, `v_finance_position` y
-- `v_finance_product_margin` son `security_invoker = true`, así que ejecutan
-- con los permisos de quien consulta y heredan la RLS de las tablas de arriba.
-- No hace falta (ni conviene) gatearlas por separado: duplicar el chequeo
-- crearía dos contratos que pueden divergir.

-- ───────────────────────────────────────────────────────────────────────────
-- 3. POSTCONDICIONES
-- ───────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_n   int;
  v_def text;
BEGIN
  -- P1. El helper existe, es SECDEF, STABLE y con search_path endurecido.
  IF to_regprocedure('public.current_user_can(text)') IS NULL THEN
    RAISE EXCEPTION 'POSTCOND P1: falta current_user_can';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='current_user_can'
     AND (p.prosecdef = false
          OR p.proconfig IS NULL
          OR NOT (p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']));
  IF v_n > 0 THEN
    RAISE EXCEPTION 'POSTCOND P1b: current_user_can sin SECDEF o sin search_path endurecido';
  END IF;

  -- P2. ACL: PUBLIC y anon fuera, authenticated dentro.
  IF has_function_privilege('public','public.current_user_can(text)','EXECUTE')
     OR has_function_privilege('anon','public.current_user_can(text)','EXECUTE') THEN
    RAISE EXCEPTION 'POSTCOND P2: PUBLIC/anon pueden ejecutar current_user_can';
  END IF;
  IF NOT has_function_privilege('authenticated','public.current_user_can(text)','EXECUTE') THEN
    RAISE EXCEPTION 'POSTCOND P2b: authenticated no puede ejecutar current_user_can';
  END IF;

  -- P3. LA INVARIANTE DEL LOTE: ninguna policy de SELECT sobre las tres tablas
  --     financieras puede quedar filtrando SÓLO por tenant. Si alguien agrega
  --     una permissive sin capacidad, el OR reabre el agujero entero.
  FOR v_def IN
    SELECT tablename || '.' || policyname || ' :: ' || coalesce(qual,'')
      FROM pg_policies
     WHERE schemaname='public'
       AND tablename IN ('financial_movements','business_finance_entries','comprobante_payments')
       AND cmd = 'SELECT'
  LOOP
    IF v_def NOT LIKE '%current_user_can%' THEN
      RAISE EXCEPTION 'POSTCOND P3: policy de SELECT sin chequeo de capacidad -> %', v_def;
    END IF;
  END LOOP;

  -- P4. Y tiene que haber EXACTAMENTE una por tabla: dos permissive se combinan
  --     con OR y la más laxa gana.
  FOR v_def IN SELECT unnest(ARRAY['financial_movements','business_finance_entries','comprobante_payments'])
  LOOP
    SELECT count(*) INTO v_n FROM pg_policies
     WHERE schemaname='public' AND tablename = v_def AND cmd='SELECT';
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'POSTCOND P4: % tiene % policies de SELECT, se esperaba 1', v_def, v_n;
    END IF;
  END LOOP;

  -- P5. Las vistas financieras siguen siendo security_invoker: si alguna
  --     perdiera la opción, ejecutaría como su owner (postgres) y saltearía la
  --     RLS que acabamos de endurecer.
  SELECT count(*) INTO v_n
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname='public'
     AND c.relname IN ('v_finance_pnl','v_finance_position','v_finance_product_margin')
     AND NOT (coalesce(array_to_string(c.reloptions,','),'') LIKE '%security_invoker=true%');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'POSTCOND P5: % vista(s) financiera(s) sin security_invoker', v_n;
  END IF;

  -- P6. El cliente sigue SIN DML estructural sobre profiles/businesses
  --     (invariante de P0-P1/P0-P2/P0-P5; este lote no la puede aflojar).
  SELECT count(*) INTO v_n
    FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name IN ('profiles','businesses')
     AND grantee IN ('anon','authenticated')
     AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'POSTCOND P6: se repusieron % grants de DML sobre profiles/businesses', v_n;
  END IF;

  -- P7. La autoridad de provisioning sigue intacta.
  IF to_regprocedure('public.provision_my_business(text)') IS NULL
     OR pg_get_functiondef(to_regprocedure('public.provision_my_business(text)')) NOT LIKE '%INVITATION_PENDING%' THEN
    RAISE EXCEPTION 'POSTCOND P7: provision_my_business alterada';
  END IF;

  -- P8. `system_admins` sigue siendo la única fuente del privilegio SaaS y NO
  --     es escribible por el cliente: si lo fuera, cualquiera se auto-otorgaría
  --     el panel de administración del SaaS.
  SELECT count(*) INTO v_n
    FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='system_admins'
     AND grantee IN ('anon','authenticated')
     AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'POSTCOND P8: el cliente puede escribir system_admins (% grants)', v_n;
  END IF;

  RAISE NOTICE 'P0-P6: 8 postcondiciones OK';
END;
$post$;

COMMIT;
