-- ============================================================================
-- W1 SECURITY GATE - Escritura de whatsapp_templates limitada a owner/admin
--
-- CAUSA
-- Las policies de INSERT y UPDATE de public.whatsapp_templates exigian
-- is_staff(), que devuelve true para los SIETE roles del negocio, viewer
-- incluido. El editor de plantillas del frontend niega la edicion con
-- can('settings_sensitive') (owner/admin), pero esa negativa es solo de UI: un
-- viewer del mismo tenant podia reescribir las plantillas de su negocio
-- pegandole directo a PostgREST con su propio JWT.
--
-- Las plantillas son el texto que sale hacia los clientes finales por WhatsApp
-- (importes, estados de orden, datos del negocio), asi que su edicion es una
-- operacion de configuracion sensible, no una accion de uso diario.
--
-- PREDICADO ELEGIDO: public.is_owner_or_admin()
-- No se inventa una lista de roles. Ese helper ya existe, es SECURITY DEFINER,
-- STABLE, tiene search_path endurecido con pg_temp al final, y su semantica
-- -current_user_role() in ('owner','admin')- es el espejo EXACTO de los
-- defaults de `settings_sensitive` en src/config/permissions.ts:
--     owner=true, admin=true, manager=false, tech=false, sales=false,
--     cashier=false, viewer=false.
-- can_manage() (owner/admin/manager) seria mas ancho que el permiso del
-- frontend, e is_staff() es justamente el agujero que se cierra.
--
-- DELETE tambien pasa a is_owner_or_admin(): hoy usa can_manage(), que deja
-- borrar a manager, un rol que en el frontend NO tiene settings_sensitive. Se
-- alinean las tres escrituras con un unico predicado.
--
-- SELECT NO SE TOCA (sigue en is_staff()) A PROPOSITO: cualquier miembro del
-- negocio necesita LEER las plantillas para usar el flujo estandar de WhatsApp
-- desde una orden. Restringir la lectura romperia el vertical W1 para tech,
-- sales, cashier y viewer.
--
-- ALCANCE: exclusivamente las tres policies de escritura de esta tabla.
-- No se tocan whatsapp_settings, whatsapp_logs, whatsapp_connections, Vault,
-- Cloud API ni ninguna otra tabla. No se agrega ni amplia ningun GRANT: el
-- gating es 100% por RLS sobre el grant a `authenticated` que ya existia.
--
-- BLAST RADIUS MEDIDO (prod, read-only, 2026-08-19): los 16 profiles tienen
-- role='owner'. Ningun usuario vivo pierde una capacidad que hoy use; el
-- cambio cierra el hueco ANTES de que existan roles no-owner.
--
-- Forward-only. Corre dentro de BEGIN/COMMIT explicito: las migraciones de
-- Supabase se aplican en AUTOCOMMIT, asi que sin esto las postcondiciones de
-- abajo no revertirian nada al fallar.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '60s';

-- ── INSERT ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "whatsapp_templates_insert" ON public.whatsapp_templates;
CREATE POLICY "whatsapp_templates_insert"
  ON public.whatsapp_templates
  FOR INSERT
  WITH CHECK (
    business_id = public.current_business_id()
    AND public.is_owner_or_admin()
  );

-- ── UPDATE ──────────────────────────────────────────────────────────────────
-- USING y WITH CHECK con el mismo predicado: sin WITH CHECK, un autorizado
-- podria mover la fila a otro business_id.
DROP POLICY IF EXISTS "whatsapp_templates_update" ON public.whatsapp_templates;
CREATE POLICY "whatsapp_templates_update"
  ON public.whatsapp_templates
  FOR UPDATE
  USING (
    business_id = public.current_business_id()
    AND public.is_owner_or_admin()
  )
  WITH CHECK (
    business_id = public.current_business_id()
    AND public.is_owner_or_admin()
  );

-- ── DELETE ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "whatsapp_templates_delete" ON public.whatsapp_templates;
CREATE POLICY "whatsapp_templates_delete"
  ON public.whatsapp_templates
  FOR DELETE
  USING (
    business_id = public.current_business_id()
    AND public.is_owner_or_admin()
  );

-- ============================================================================
-- POSTCONDICIONES
--
-- Se leen de pg_policies / information_schema, o sea la policy EFECTIVA que
-- quedo instalada, no el texto que este archivo acaba de mandar.
-- ============================================================================
DO $$
DECLARE
  v_insert_check text;
  v_update_qual  text;
  v_update_check text;
  v_delete_qual  text;
  v_select_qual  text;
  v_rls_on       boolean;
  v_grants_raros text;
BEGIN
  SELECT with_check INTO v_insert_check FROM pg_policies
   WHERE schemaname='public' AND tablename='whatsapp_templates' AND policyname='whatsapp_templates_insert';
  SELECT qual, with_check INTO v_update_qual, v_update_check FROM pg_policies
   WHERE schemaname='public' AND tablename='whatsapp_templates' AND policyname='whatsapp_templates_update';
  SELECT qual INTO v_delete_qual FROM pg_policies
   WHERE schemaname='public' AND tablename='whatsapp_templates' AND policyname='whatsapp_templates_delete';
  SELECT qual INTO v_select_qual FROM pg_policies
   WHERE schemaname='public' AND tablename='whatsapp_templates' AND policyname='whatsapp_templates_select';

  -- 1. Las tres escrituras exigen is_owner_or_admin().
  IF v_insert_check IS NULL OR v_insert_check NOT LIKE '%is_owner_or_admin()%' THEN
    RAISE EXCEPTION 'POSTCONDICION: el INSERT de whatsapp_templates no exige is_owner_or_admin(). Quedo: %', v_insert_check;
  END IF;
  IF v_update_qual IS NULL OR v_update_qual NOT LIKE '%is_owner_or_admin()%'
     OR v_update_check IS NULL OR v_update_check NOT LIKE '%is_owner_or_admin()%' THEN
    RAISE EXCEPTION 'POSTCONDICION: el UPDATE de whatsapp_templates no exige is_owner_or_admin() en USING y WITH CHECK. Quedo: using=% check=%', v_update_qual, v_update_check;
  END IF;
  IF v_delete_qual IS NULL OR v_delete_qual NOT LIKE '%is_owner_or_admin()%' THEN
    RAISE EXCEPTION 'POSTCONDICION: el DELETE de whatsapp_templates no exige is_owner_or_admin(). Quedo: %', v_delete_qual;
  END IF;

  -- 2. Ninguna escritura puede seguir aceptando is_staff() (el agujero original).
  IF v_insert_check LIKE '%is_staff()%'
     OR v_update_qual LIKE '%is_staff()%' OR v_update_check LIKE '%is_staff()%'
     OR v_delete_qual LIKE '%is_staff()%' THEN
    RAISE EXCEPTION 'POSTCONDICION: alguna escritura de whatsapp_templates todavia acepta is_staff(), que incluye a viewer.';
  END IF;

  -- 3. Las tres escrituras siguen acotadas por negocio.
  IF v_insert_check NOT LIKE '%current_business_id()%'
     OR v_update_qual NOT LIKE '%current_business_id()%'
     OR v_update_check NOT LIKE '%current_business_id()%'
     OR v_delete_qual NOT LIKE '%current_business_id()%' THEN
    RAISE EXCEPTION 'POSTCONDICION: una escritura de whatsapp_templates perdio el acotado por business_id.';
  END IF;

  -- 4. La LECTURA no se toco: el vertical W1 la necesita para todos los roles.
  IF v_select_qual IS NULL OR v_select_qual NOT LIKE '%is_staff()%'
     OR v_select_qual NOT LIKE '%current_business_id()%' THEN
    RAISE EXCEPTION 'POSTCONDICION: cambio el SELECT de whatsapp_templates. Debia quedar intacto (current_business_id + is_staff). Quedo: %', v_select_qual;
  END IF;

  -- 5. RLS sigue activa: sin esto las policies son decorativas.
  SELECT c.relrowsecurity INTO v_rls_on
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relname='whatsapp_templates';
  IF NOT COALESCE(v_rls_on, false) THEN
    RAISE EXCEPTION 'POSTCONDICION: RLS quedo deshabilitada en whatsapp_templates.';
  END IF;

  -- 6. No se abrieron grants: solo authenticated y los roles internos de PG.
  SELECT string_agg(DISTINCT grantee, ',' ORDER BY grantee) INTO v_grants_raros
    FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='whatsapp_templates'
     AND grantee NOT IN ('authenticated', 'postgres', 'service_role', 'supabase_admin');
  IF v_grants_raros IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDICION: aparecieron grants inesperados sobre whatsapp_templates: %', v_grants_raros;
  END IF;

  RAISE NOTICE 'W1 security gate OK: whatsapp_templates escribe solo owner/admin; lectura y grants intactos.';
END $$;

COMMIT;
