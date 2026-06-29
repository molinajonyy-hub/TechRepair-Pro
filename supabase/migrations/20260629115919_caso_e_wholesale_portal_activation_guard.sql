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
-- SOLUCIÓN (autorización privada adicional):
--   Trigger BEFORE UPDATE que bloquea cualquier CAMBIO de wholesale_portal_enabled
--   salvo que el actor sea:
--     - un backend privilegiado (service_role / postgres / mantenimiento), o
--     - un administrador de plataforma activo (public.current_platform_admin_role()).
--   Los UPDATE de un tenant (rol `authenticated`) que NO sea platform admin son
--   rechazados. Updates que NO tocan la columna pasan sin restricción.
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

    -- Backends privilegiados (service_role, postgres, mantenimiento) pasan.
    -- En requests de PostgREST el rol efectivo es 'authenticated' o 'anon'.
    IF current_user NOT IN ('authenticated', 'anon') THEN
      RETURN NEW;
    END IF;

    -- Dentro de una sesión de usuario final, solo un platform admin activo
    -- puede activar/desactivar el portal privado.
    IF "public"."current_platform_admin_role"() IS NOT NULL THEN
      RETURN NEW;
    END IF;

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
  BEFORE UPDATE ON "public"."businesses"
  FOR EACH ROW
  EXECUTE FUNCTION "public"."enforce_wholesale_portal_activation"();
-- ============================================================================
