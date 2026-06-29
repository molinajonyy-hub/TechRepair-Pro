-- ============================================================================
-- Caso E — autorización privada de wholesale_portal_enabled (guard)
-- Primera migración "normal" posterior al baseline 20260628190324.
-- Corre ANTES del hardening RLS (20260629115920_caso_e_wholesale_rls_hardening.sql):
-- si este guard falla en el despliegue, el hardening RLS no debe ejecutarse.
--
-- CAUSA / RIESGO:
--   La policy `businesses_update` permite a owner Y admin de CUALQUIER negocio
--   actualizar la fila de su negocio, incluida la columna `wholesale_portal_enabled`.
--   El frontend (Mayorista.tsx) NO envía esa columna por convención, pero a nivel
--   de RLS nada lo impide: vía PostgREST directo, un owner/admin podría ejecutar
--   `UPDATE businesses SET wholesale_portal_enabled = true` y AUTO-ACTIVARSE el
--   Portal Clic privado — que además queda expuesto a `anon` por la policy
--   `businesses_portal_public_read`.
--
-- SOLUCIÓN (autorización privada, ALLOWLIST fail-closed):
--   Trigger BEFORE UPDATE OF wholesale_portal_enabled. Ante un CAMBIO efectivo
--   del flag (IS DISTINCT FROM), solo se PERMITE si el actor es:
--     - un backend técnico autorizado:
--         current_user IN ('postgres','supabase_admin','service_role'); o
--     - administración de plataforma SOLO vía rol authenticated con platform admin
--         activo: current_user = 'authenticated'
--                  AND public.current_platform_admin_role() IS NOT NULL.
--   Todo lo demás queda DENEGADO por defecto: anon, authenticated no-admin,
--   authenticator, dashboard_user, pgbouncer, supabase_*_admin no listados, y
--   cualquier rol arbitrario o futuro. (No se deja current_platform_admin_role()
--   abierto a cualquier current_user.)
--
-- Idempotente. No modifica datos. SECURITY INVOKER en el trigger (necesita ver el
-- rol real del llamador vía current_user); la verificación de platform admin se
-- delega en public.current_platform_admin_role() (ya SECURITY DEFINER).
-- ============================================================================

CREATE OR REPLACE FUNCTION "public"."enforce_wholesale_portal_activation"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  -- Solo controlamos el CAMBIO efectivo del flag privado.
  IF NEW."wholesale_portal_enabled" IS DISTINCT FROM OLD."wholesale_portal_enabled" THEN

    -- Allowlist explícita de backends técnicos autorizados (fail-closed).
    IF current_user IN ('postgres', 'supabase_admin', 'service_role') THEN
      RETURN NEW;
    END IF;

    -- Administración de plataforma: SOLO mediante el rol authenticated y con
    -- platform admin activo. No se habilita current_platform_admin_role() para
    -- cualquier current_user.
    IF current_user = 'authenticated'
       AND "public"."current_platform_admin_role"() IS NOT NULL THEN
      RETURN NEW;
    END IF;

    -- Cualquier otro rol (anon, authenticated no-admin, authenticator,
    -- dashboard_user, pgbouncer, supabase_*_admin no listados, roles arbitrarios
    -- o futuros) queda denegado por defecto.
    RAISE EXCEPTION
      'wholesale_portal_enabled solo puede ser modificado por la administración de la plataforma'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."enforce_wholesale_portal_activation"() OWNER TO "postgres";
-- Función de trigger: la invoca el trigger, no se llama directamente. Sin EXECUTE a PUBLIC.
REVOKE ALL ON FUNCTION "public"."enforce_wholesale_portal_activation"() FROM PUBLIC;

DROP TRIGGER IF EXISTS "trig_enforce_wholesale_portal_activation" ON "public"."businesses";
CREATE TRIGGER "trig_enforce_wholesale_portal_activation"
  BEFORE UPDATE OF "wholesale_portal_enabled" ON "public"."businesses"
  FOR EACH ROW
  EXECUTE FUNCTION "public"."enforce_wholesale_portal_activation"();
-- ============================================================================
