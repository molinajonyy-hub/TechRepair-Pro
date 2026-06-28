-- ============================================================
-- Migración: Endurecimiento de seguridad WhatsApp + consolidación
-- Fecha: 2026-06-22
--
-- PREFLIGHT (estado real verificado vía MCP antes de aplicar):
--   · RLS YA estaba habilitado en las 3 tablas y existen políticas correctas
--     que usan las funciones centrales del proyecto: user_business_ids(),
--     current_business_id(), is_staff(), can_manage(). NO se recrean para no
--     duplicar la lógica de membresía.
--   · whatsapp_settings.access_token: la columna existía pero con 0 tokens
--     (0 negocios con credenciales legacy). Eliminarla NO destruye credenciales.
--   · whatsapp_connections: 0 filas (nadie conectó Cloud API todavía).
--   · `anon` todavía tenía GRANT completo sobre whatsapp_settings (hueco real).
--   · Los CHECK de whatsapp_logs seguían siendo los viejos
--     (send_mode IN manual/auto; send_result IN opened/copied/failed/skipped),
--     por lo que los logs de envío por API ('api'/'sent_api') se rechazaban.
--   · Ningún view/función/trigger/índice referencia access_token.
--
-- Esta migración, alineada a ese estado real:
--   1. Elimina la columna secreta access_token de whatsapp_settings.
--   2. Revoca los grants a anon y deja permisos mínimos para authenticated.
--   3. Asegura RLS habilitado (idempotente; ya estaba on).
--   4. Cierra un hueco en la política UPDATE de whatsapp_settings (le faltaba
--      WITH CHECK), reutilizando el helper central user_business_ids().
--   5. Amplía los CHECK de whatsapp_logs para aceptar 'api' / 'sent_api'.
--
-- IDEMPOTENTE: IF EXISTS / DROP POLICY IF EXISTS / drop+add de constraints.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 0. Quitar el secreto de whatsapp_settings (0 tokens presentes)
--    El token de Cloud API vive SÓLO en whatsapp_connections (server-side).
-- ────────────────────────────────────────────────────────────
ALTER TABLE public.whatsapp_settings DROP COLUMN IF EXISTS access_token;

-- ────────────────────────────────────────────────────────────
-- 1. Revocar grants amplios (anon conservaba acceso a whatsapp_settings)
-- ────────────────────────────────────────────────────────────
REVOKE ALL ON public.whatsapp_settings  FROM anon;
REVOKE ALL ON public.whatsapp_templates FROM anon;
REVOKE ALL ON public.whatsapp_logs      FROM anon;

-- Permisos mínimos para el rol autenticado (RLS filtra por negocio). Idempotente.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_settings  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_templates TO authenticated;
GRANT SELECT, INSERT                 ON public.whatsapp_logs       TO authenticated;
-- service_role (Edge Functions) conserva acceso completo a los logs.
GRANT ALL ON public.whatsapp_logs TO service_role;

-- ────────────────────────────────────────────────────────────
-- 2. Asegurar RLS habilitado (ya estaba on; idempotente)
-- ────────────────────────────────────────────────────────────
ALTER TABLE public.whatsapp_settings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_logs      ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────────────────────
-- 3. Cerrar hueco: whatsapp_settings_update no tenía WITH CHECK
--    (permitía, en teoría, mover una fila a otro business_id).
--    Se recrea reutilizando el MISMO helper central, sin nueva lógica.
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS whatsapp_settings_update ON public.whatsapp_settings;
CREATE POLICY whatsapp_settings_update ON public.whatsapp_settings
  FOR UPDATE
  USING (business_id IN (SELECT user_business_ids()))
  WITH CHECK (business_id IN (SELECT user_business_ids()));

-- ────────────────────────────────────────────────────────────
-- 4. Ampliar CHECK de whatsapp_logs para envíos por API
-- ────────────────────────────────────────────────────────────
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.whatsapp_logs'::regclass
      AND contype = 'c'
      AND (pg_get_constraintdef(oid) ILIKE '%send_mode%'
        OR pg_get_constraintdef(oid) ILIKE '%send_result%')
  LOOP
    EXECUTE format('ALTER TABLE public.whatsapp_logs DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.whatsapp_logs
  ADD CONSTRAINT whatsapp_logs_send_mode_check
  CHECK (send_mode IN ('manual', 'auto', 'api'));

ALTER TABLE public.whatsapp_logs
  ADD CONSTRAINT whatsapp_logs_send_result_check
  CHECK (send_result IN ('opened', 'copied', 'failed', 'skipped', 'sent_api'));

-- ────────────────────────────────────────────────────────────
-- 5. Recargar el schema cache de PostgREST
-- ────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
