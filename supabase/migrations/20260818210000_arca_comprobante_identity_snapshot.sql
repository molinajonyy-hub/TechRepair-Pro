-- ============================================================================
-- LECTURA ACOTADA DE LA IDENTIDAD FISCAL DE UN COMPROBANTE PARA afip-cae
--
-- INCIDENTE 2026-08-18. afip-cae v16 agregó, dentro de resolverCbtesAsocCanonico,
-- una lectura DIRECTA de public.comprobantes con el cliente service_role:
--
--   .from('comprobantes')
--   .select('tipo, tipo_comprobante_fiscal, comprobante_original_id')
--
-- Pero `service_role` NO tiene ningún grant sobre public.comprobantes — sólo
-- `authenticated` y `postgres` los tienen. La consulta devolvía 42501
-- (permission denied), no un set vacío, y la emisión abortaba ANTES de WSAA.
-- v15 no fallaba porque leía una sola tabla, arca_emission_attempts, donde
-- service_role SÍ tiene SELECT.
--
-- Ese lockdown es DELIBERADO: service_role tampoco puede leer accounts, cajas,
-- customers, inventory, financial_movements, comprobante_items/payments… Por eso
-- el arreglo NO es `GRANT SELECT ON comprobantes TO service_role`, que abriría
-- lectura cross-tenant de todos los comprobantes a la Edge Function.
--
-- En su lugar, una RPC SECURITY DEFINER mínima — mismo patrón que
-- snapshot_arca_nc_cbtes_asoc — que expone EXCLUSIVAMENTE las tres columnas que
-- el gate necesita, para UNA fila acotada por (comprobante_id, business_id).
--
-- Aditiva: no toca datos, ni Migration B, ni ninguna migración histórica.
-- ============================================================================
BEGIN;

SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.snapshot_arca_comprobante_identity(
  p_comprobante_id uuid,
  p_business_id    uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_row record;
BEGIN
  -- El scope de negocio es OBLIGATORIO. Sin esto la función degeneraría en un
  -- lookup global por id y sería un canal de lectura cross-tenant.
  IF p_comprobante_id IS NULL OR p_business_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT c.tipo,
         c.tipo_comprobante_fiscal,
         c.comprobante_original_id
    INTO v_row
    FROM public.comprobantes c
   WHERE c.id = p_comprobante_id
     AND c.business_id = p_business_id;

  IF NOT FOUND THEN
    -- Fila inexistente o de otro negocio: el caller lo distingue de un error de
    -- lectura porque la RPC responde sin error y con NULL.
    RETURN NULL;
  END IF;

  -- Exactamente tres campos. Nada de cliente, totales, ítems, pagos, CAE,
  -- numeración fiscal ni cualquier otra columna.
  RETURN jsonb_build_object(
    'tipo',                    v_row.tipo,
    'tipo_comprobante_fiscal', v_row.tipo_comprobante_fiscal,
    'comprobante_original_id', v_row.comprobante_original_id
  );
END;
$$;

COMMENT ON FUNCTION public.snapshot_arca_comprobante_identity(uuid, uuid) IS
  'Identidad fiscal mínima de un comprobante (tipo, tipo_comprobante_fiscal, comprobante_original_id) acotada por negocio. Sólo para afip-cae; service_role-only. No otorga SELECT sobre comprobantes.';

-- Sólo el rol de servicio del backend. La Edge Function es el único caller.
REVOKE ALL     ON FUNCTION public.snapshot_arca_comprobante_identity(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.snapshot_arca_comprobante_identity(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.snapshot_arca_comprobante_identity(uuid, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.snapshot_arca_comprobante_identity(uuid, uuid) TO service_role;

-- ============================================================================
-- IDENTIDAD FISCAL DEL COMPROBANTE ORIGINAL DE UNA NOTA DE CRÉDITO
--
-- La misma pared de permisos afecta a la segunda lectura de cbtesAsoc.ts: la del
-- comprobante ORIGINAL, necesaria para probar la terna (PtoVta, CbteTipo,
-- CbteNro) que viaja en CbtesAsoc. Esa prueba EXIGE `numero_fiscal`, así que no
-- puede salir de la RPC de arriba — va en una función propia, igual de acotada.
--
-- Sigue siendo fail-closed: devolver estas columnas no decide nada por sí mismo,
-- la identidad la resuelve el helper canónico (fiscalIdentity) en la Edge
-- Function, que exige numero_fiscal válido + CbteTipo persistido.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.snapshot_arca_original_identity(
  p_original_id uuid,
  p_business_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_row record;
BEGIN
  IF p_original_id IS NULL OR p_business_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT c.tipo,
         c.numero_fiscal,
         c.tipo_comprobante_fiscal
    INTO v_row
    FROM public.comprobantes c
   WHERE c.id = p_original_id
     AND c.business_id = p_business_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'tipo',                    v_row.tipo,
    'numero_fiscal',           v_row.numero_fiscal,
    'tipo_comprobante_fiscal', v_row.tipo_comprobante_fiscal
  );
END;
$$;

COMMENT ON FUNCTION public.snapshot_arca_original_identity(uuid, uuid) IS
  'Identidad fiscal del comprobante original de una NC (tipo, numero_fiscal, tipo_comprobante_fiscal) acotada por negocio. Sólo para afip-cae; service_role-only.';

REVOKE ALL     ON FUNCTION public.snapshot_arca_original_identity(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.snapshot_arca_original_identity(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.snapshot_arca_original_identity(uuid, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.snapshot_arca_original_identity(uuid, uuid) TO service_role;

-- ── Postcondiciones: dentro de la transacción, para que un grant mal aplicado
--    aborte el deploy en vez de dejar la RPC abierta. ─────────────────────────
DO $post$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.snapshot_arca_comprobante_identity(uuid, uuid)',
    'public.snapshot_arca_original_identity(uuid, uuid)'
  ] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDICION: anon no puede tener EXECUTE sobre %.', v_fn;
    END IF;

    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDICION: authenticated no puede tener EXECUTE sobre %.', v_fn;
    END IF;

    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDICION: service_role necesita EXECUTE sobre %.', v_fn;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace,
           aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE n.nspname = 'public'
       AND p.proname IN ('snapshot_arca_comprobante_identity',
                         'snapshot_arca_original_identity')
       AND a.grantee = 0                    -- 0 = PUBLIC
       AND a.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION: PUBLIC no puede tener EXECUTE.';
  END IF;

  -- El lockdown que motivó todo esto tiene que seguir en pie: la RPC existe
  -- justamente para NO tener que abrir la tabla.
  IF has_table_privilege('service_role', 'public.comprobantes', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDICION: service_role no debe recuperar SELECT sobre comprobantes.';
  END IF;

  RAISE NOTICE 'OK - snapshot_arca_comprobante_identity: service_role-only, comprobantes sigue cerrada.';
END
$post$;

COMMIT;
