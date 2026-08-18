-- ============================================================================
-- PRIVILEGIOS REALES DE snapshot_arca_comprobante_identity / _original_identity
--
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < tests/sql/arca_comprobante_identity_rpc.test.sql
--
-- POR QUÉ EXISTE
--
-- El incidente del 2026-08-18 lo ocultó un doble de Supabase: los mocks
-- devuelven filas, PostgreSQL devuelve 42501. `service_role` no tiene grants
-- sobre public.comprobantes y la lectura directa que agregó afip-cae v16 moría
-- antes de WSAA. Ningún test con mocks podía verlo.
--
-- Por eso estas comprobaciones se hacen contra el motor: privilegios efectivos
-- con has_*_privilege, no ACL textual. Todo dentro de una transacción que
-- termina en ROLLBACK.
-- ============================================================================
BEGIN;

SET LOCAL client_min_messages = notice;

-- ── A. El lockdown que motivó el arreglo sigue en pie ───────────────────────
DO $$
BEGIN
  IF has_table_privilege('service_role', 'public.comprobantes', 'SELECT') THEN
    RAISE EXCEPTION 'A: service_role recupero SELECT sobre comprobantes; el arreglo era NO abrir la tabla.';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.arca_emission_attempts', 'SELECT') THEN
    RAISE EXCEPTION 'A: service_role perdio SELECT sobre arca_emission_attempts (lo necesita fetchAttempt).';
  END IF;
  RAISE NOTICE 'A OK - comprobantes cerrada a service_role; arca_emission_attempts legible.';
END
$$;

-- ── E/F/G/H. Privilegios EFECTIVOS de ejecución ─────────────────────────────
DO $$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.snapshot_arca_comprobante_identity(uuid, uuid)',
    'public.snapshot_arca_original_identity(uuid, uuid)'
  ] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'E: anon no puede ejecutar %.', v_fn;
    END IF;
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'F: authenticated no puede ejecutar %.', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'H: service_role necesita EXECUTE sobre %.', v_fn;
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
       AND a.grantee = 0
       AND a.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'G: PUBLIC no puede tener EXECUTE efectivo.';
  END IF;

  RAISE NOTICE 'E/F/G/H OK - service_role-only en ambas RPC (anon/authenticated/PUBLIC sin EXECUTE).';
END
$$;

-- ── Ambas deben ser SECURITY DEFINER con search_path endurecido ─────────────
DO $$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('snapshot_arca_comprobante_identity','snapshot_arca_original_identity')
     AND (NOT p.prosecdef
          OR p.proconfig IS NULL
          OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%pg_temp'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Las RPC deben ser SECURITY DEFINER con search_path terminado en pg_temp: %', v_bad;
  END IF;
  RAISE NOTICE 'OK - SECURITY DEFINER con search_path ... pg_temp en ambas.';
END
$$;

-- ── B/C/D + multitenant, con datos descartables ─────────────────────────────
DO $$
DECLARE
  v_biz_a uuid := '00000000-0000-0000-0000-0000000000aa';
  v_biz_b uuid := '00000000-0000-0000-0000-0000000000bb';
  v_comp  uuid := '00000000-0000-0000-0000-0000000000c1';
  r jsonb;
BEGIN
  INSERT INTO public.businesses (id, name) VALUES (v_biz_a, 'Negocio A RPC test')
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.businesses (id, name) VALUES (v_biz_b, 'Negocio B RPC test')
    ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.comprobantes
    (id, business_id, tipo, status, estado, estado_fiscal, fecha, total,
     numero, punto_venta, tipo_comprobante_fiscal, comprobante_original_id, numero_fiscal)
  VALUES
    (v_comp, v_biz_a, 'factura_c', 'issued', 'borrador', 'pendiente_emision',
     now(), 36000, '0010-00000999', '0010', NULL, NULL, NULL);

  -- B/C: devuelve el snapshot y EXACTAMENTE tres campos.
  r := public.snapshot_arca_comprobante_identity(v_comp, v_biz_a);
  IF r IS NULL THEN
    RAISE EXCEPTION 'B: la RPC no devolvio el comprobante de su propio negocio.';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(r)) <> 3 THEN
    RAISE EXCEPTION 'C: la RPC debe exponer exactamente 3 campos, devolvio %.',
      (SELECT string_agg(k, ',') FROM jsonb_object_keys(r) k);
  END IF;
  IF NOT (r ? 'tipo' AND r ? 'tipo_comprobante_fiscal' AND r ? 'comprobante_original_id') THEN
    RAISE EXCEPTION 'C: campos inesperados: %', r;
  END IF;
  IF r->>'tipo' <> 'factura_c' THEN
    RAISE EXCEPTION 'B: tipo incorrecto: %', r->>'tipo';
  END IF;

  -- C: no puede filtrar numeración fiscal ni datos economicos.
  IF r ? 'numero_fiscal' OR r ? 'total' OR r ? 'cae' OR r ? 'customer_id' THEN
    RAISE EXCEPTION 'C: la RPC filtro columnas que no le corresponden: %', r;
  END IF;

  -- D + multitenant: el mismo id con OTRO negocio no devuelve nada.
  IF public.snapshot_arca_comprobante_identity(v_comp, v_biz_b) IS NOT NULL THEN
    RAISE EXCEPTION 'D: lectura cross-tenant — el negocio B resolvio un comprobante de A.';
  END IF;

  -- business_id NULL nunca degenera en lookup global por id.
  IF public.snapshot_arca_comprobante_identity(v_comp, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'D: business_id NULL no puede resolver nada.';
  END IF;

  -- La RPC del original: mismo scope, y sí expone numero_fiscal (lo necesita
  -- fiscalIdentity para probar la terna de CbtesAsoc).
  r := public.snapshot_arca_original_identity(v_comp, v_biz_a);
  IF r IS NULL OR NOT (r ? 'numero_fiscal') THEN
    RAISE EXCEPTION 'La RPC del original debe exponer numero_fiscal: %', r;
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(r)) <> 3 THEN
    RAISE EXCEPTION 'La RPC del original debe exponer exactamente 3 campos: %', r;
  END IF;
  IF public.snapshot_arca_original_identity(v_comp, v_biz_b) IS NOT NULL THEN
    RAISE EXCEPTION 'Lectura cross-tenant en la RPC del original.';
  END IF;

  RAISE NOTICE 'B/C/D OK - snapshot correcto, 3 campos, sin cross-tenant y sin business_id NULL.';
END
$$;

ROLLBACK;
