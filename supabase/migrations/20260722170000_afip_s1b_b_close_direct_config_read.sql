-- ============================================================================
-- AFIP-S1B-B — Cerrar la lectura directa cliente de public.arca_config.
--
-- Contexto: la clave privada AFIP vive (todavía) en claro en arca_config y la
-- policy histórica arca_config_plan_read permitía SELECT a cualquier miembro
-- authenticated del negocio (via select('*') llegaba al navegador). S1A entregó
-- la lectura segura (get_arca_config_safe) y S1B-A1/A2 el contrato de escritura
-- server-side + la migración del frontend. Este lote revoca la capacidad de
-- lectura directa del cliente.
--
-- Qué hace:
--   1. Precondiciones fail-closed (estado esperado exacto; falla ante drift).
--   2. REVOKE SELECT sobre la tabla para PUBLIC, anon y authenticated.
--   3. DROP POLICY arca_config_plan_read (sin CASCADE).
--   4. Post-condiciones duras (privilegios efectivos por tabla y POR COLUMNA).
--
-- Qué NO hace: no toca RLS (queda enabled), no toca service_role/postgres,
-- no toca las policies de escritura existentes, no hace DML, no toca secretos.
--
-- Nota sobre arca_config_plan_write (FOR ALL): su semántica incluye SELECT,
-- pero el chequeo de PRIVILEGIOS precede a RLS — con SELECT revocado a nivel
-- tabla/columna, ninguna policy puede rehabilitar la lectura. La barrera
-- definitiva de este lote es el REVOKE; las post-condiciones lo verifican con
-- has_table_privilege/has_column_privilege (privilegio EFECTIVO, no texto ACL).
--
-- Los consumidores fiscales (afip-wsaa, afip-cae, generate-csr,
-- arca-credentials) usan SERVICE_ROLE_KEY: no dependen de authenticated ni de
-- la policy eliminada. El frontend (S1B-A2) ya no tiene ningún acceso directo.
-- ============================================================================

-- ── 1. Precondiciones fail-closed ───────────────────────────────────────────
DO $$
DECLARE v_bad text[] := '{}'; v_cnt int;
BEGIN
  IF to_regclass('public.arca_config') IS NULL THEN
    RAISE EXCEPTION 'S1B-B: no existe public.arca_config';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.arca_config'::regclass) THEN
    v_bad := v_bad || 'rls_no_habilitada';
  END IF;
  -- La policy histórica debe existir tal como se documentó (SELECT, para todos los roles)
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname='public' AND tablename='arca_config'
                    AND policyname='arca_config_plan_read' AND cmd='SELECT') THEN
    v_bad := v_bad || 'falta_policy_arca_config_plan_read';
  END IF;
  -- Las 4 RPC del contrato seguro deben existir ANTES de cerrar la tabla
  IF to_regprocedure('public.get_arca_config_safe(uuid)') IS NULL THEN v_bad := v_bad || 'falta_get_arca_config_safe'; END IF;
  IF to_regprocedure('public.save_arca_config_legacy(uuid,text,text,text,integer,text,text,timestamptz)') IS NULL THEN v_bad := v_bad || 'falta_save_arca_config_legacy'; END IF;
  IF to_regprocedure('public.save_arca_certificate_legacy(uuid,text)') IS NULL THEN v_bad := v_bad || 'falta_save_arca_certificate_legacy'; END IF;
  IF to_regprocedure('public.set_arca_estado_conexion(uuid,text,text)') IS NULL THEN v_bad := v_bad || 'falta_set_arca_estado_conexion'; END IF;
  -- service_role debe tener hoy los privilegios que este lote promete preservar
  IF NOT has_table_privilege('service_role','public.arca_config','SELECT') THEN v_bad := v_bad || 'service_role_sin_select_previo'; END IF;
  IF NOT has_table_privilege('service_role','public.arca_config','UPDATE') THEN v_bad := v_bad || 'service_role_sin_update_previo'; END IF;
  IF NOT has_table_privilege('service_role','public.arca_config','INSERT') THEN v_bad := v_bad || 'service_role_sin_insert_previo'; END IF;
  -- No deben existir grants de columna EXPLÍCITOS (attacl) de SELECT para
  -- anon/authenticated: el preflight productivo mostró attacl vacío. Si esto
  -- falla, hay drift y la migración debe extenderse con REVOKEs por columna
  -- (preferimos fallar acá antes que ocultarlo).
  SELECT count(*) INTO v_cnt
  FROM pg_attribute a
  CROSS JOIN LATERAL aclexplode(a.attacl) e
  WHERE a.attrelid='public.arca_config'::regclass AND a.attnum>0 AND NOT a.attisdropped
    AND e.privilege_type='SELECT'
    AND e.grantee::regrole::text IN ('anon','authenticated');
  IF v_cnt > 0 THEN v_bad := v_bad || 'grants_de_columna_inesperados'; END IF;

  IF array_length(v_bad,1) IS NOT NULL THEN
    RAISE EXCEPTION 'S1B-B precondición falló → %', array_to_string(v_bad, ', ');
  END IF;
END $$;

-- ── 2. Revocar la lectura directa cliente ───────────────────────────────────
-- (PUBLIC no tiene grant hoy; se incluye como salvaguarda idempotente.)
REVOKE SELECT ON TABLE public.arca_config FROM PUBLIC;
REVOKE SELECT ON TABLE public.arca_config FROM anon;
REVOKE SELECT ON TABLE public.arca_config FROM authenticated;

-- ── 3. Eliminar la policy histórica de lectura ──────────────────────────────
DROP POLICY arca_config_plan_read ON public.arca_config;

-- ── 4. Post-condiciones duras ───────────────────────────────────────────────
DO $$
DECLARE v_bad text[] := '{}'; r record;
BEGIN
  -- La policy ya no existe y no queda ninguna policy SOLO-SELECT en la tabla
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='arca_config'
               AND policyname='arca_config_plan_read') THEN
    v_bad := v_bad || 'policy_plan_read_sigue_existiendo';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='arca_config' AND cmd='SELECT') THEN
    v_bad := v_bad || 'queda_una_policy_SELECT';
  END IF;
  -- RLS sigue habilitada
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.arca_config'::regclass) THEN
    v_bad := v_bad || 'rls_quedo_deshabilitada';
  END IF;
  -- Privilegio EFECTIVO de tabla: cerrado para cliente, intacto server-side
  IF has_table_privilege('anon','public.arca_config','SELECT') THEN v_bad := v_bad || 'anon_conserva_select'; END IF;
  IF has_table_privilege('authenticated','public.arca_config','SELECT') THEN v_bad := v_bad || 'authenticated_conserva_select'; END IF;
  IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) e
              WHERE c.oid='public.arca_config'::regclass AND e.grantee=0 AND e.privilege_type='SELECT') THEN
    v_bad := v_bad || 'PUBLIC_conserva_select';
  END IF;
  IF NOT has_table_privilege('service_role','public.arca_config','SELECT') THEN v_bad := v_bad || 'service_role_perdio_select'; END IF;
  IF NOT has_table_privilege('service_role','public.arca_config','UPDATE') THEN v_bad := v_bad || 'service_role_perdio_update'; END IF;
  IF NOT has_table_privilege('service_role','public.arca_config','INSERT') THEN v_bad := v_bad || 'service_role_perdio_insert'; END IF;
  IF NOT has_table_privilege('postgres','public.arca_config','SELECT') THEN v_bad := v_bad || 'postgres_perdio_select'; END IF;
  -- POR COLUMNA (dinámico: cubre también columnas futuras): ninguna columna
  -- puede quedar legible para anon/authenticated.
  FOR r IN SELECT a.attname FROM pg_attribute a
            WHERE a.attrelid='public.arca_config'::regclass AND a.attnum>0 AND NOT a.attisdropped
  LOOP
    IF has_column_privilege('anon','public.arca_config',r.attname,'SELECT') THEN
      v_bad := v_bad || ('anon_col_'||r.attname);
    END IF;
    IF has_column_privilege('authenticated','public.arca_config',r.attname,'SELECT') THEN
      v_bad := v_bad || ('authenticated_col_'||r.attname);
    END IF;
  END LOOP;
  -- Las 4 RPC del contrato siguen existiendo con sus grants
  IF NOT has_function_privilege('authenticated','public.get_arca_config_safe(uuid)','EXECUTE') THEN v_bad := v_bad || 'safe_read_sin_execute'; END IF;
  IF NOT has_function_privilege('authenticated','public.save_arca_config_legacy(uuid,text,text,text,integer,text,text,timestamptz)','EXECUTE') THEN v_bad := v_bad || 'save_config_sin_execute'; END IF;
  IF NOT has_function_privilege('authenticated','public.save_arca_certificate_legacy(uuid,text)','EXECUTE') THEN v_bad := v_bad || 'save_cert_sin_execute'; END IF;
  IF NOT has_function_privilege('authenticated','public.set_arca_estado_conexion(uuid,text,text)','EXECUTE') THEN v_bad := v_bad || 'set_estado_sin_execute'; END IF;

  IF array_length(v_bad,1) IS NOT NULL THEN
    RAISE EXCEPTION 'S1B-B post-condición falló → %', array_to_string(v_bad, ', ');
  END IF;
  RAISE NOTICE 'AFIP-S1B-B: lectura directa cliente de arca_config CERRADA (tabla+columnas); service_role/postgres intactos; RPC seguras operativas.';
END $$;
