-- ============================================================================
-- ARCA SELF-SERVICE · PHASE 1 — rollback (manual, transaccional)
--
-- Phase 1 es SOLO lectura y aditiva: retirar las dos funciones no toca filas,
-- Vault, credenciales, rotaciones ni get_arca_config_safe. No reabre ninguna
-- exposición.
--
-- Orden recomendado: primero redeploy del frontend anterior (la UI nueva sin la
-- RPC muestra "No se pudo leer el estado de ARCA" y conserva el formulario por
-- los flags de get_arca_config_safe: seguro, pero degradado). Después:
--
--   psql ... -f docs/arca-selfservice-phase1/rollback.sql
--   supabase migration repair --status reverted 20260929120000
-- ============================================================================
BEGIN;

DROP FUNCTION IF EXISTS public.get_arca_selfservice_status(uuid);
DROP FUNCTION IF EXISTS private.arca_selfservice_status(uuid, uuid, timestamptz);

DO $post$
BEGIN
  IF to_regprocedure('public.get_arca_selfservice_status(uuid)') IS NOT NULL
     OR to_regprocedure('private.arca_selfservice_status(uuid,uuid,timestamptz)') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback Phase 1 incompleto';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_arca_config_safe(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'rollback Phase 1: get_arca_config_safe no debería haber cambiado';
  END IF;
END
$post$;

COMMIT;

NOTIFY pgrst, 'reload schema';
