-- Lote 3 Phase C: close the two direct comprobante write paths reported by the
-- second independent adversarial review of the Phase B head.
--
--   P1-N1  A browser INSERT could persist a comprobante whose fiscal identity
--          (cae, numero_fiscal, estado_fiscal, es_fiscal) and collection truth
--          (total_cobrado, estado_comercial, payment_status) were entirely
--          caller-supplied. Phase B revoked UPDATE only, so the same forged
--          outcome remained reachable through creation.
--
--   P1-N2  A browser DELETE removed the comprobante row outright, bypassing
--          delete_comprobante_with_finance and its canonical reversal.
--
-- Creation and deletion are already RPC-only in the product. comprobanteService
-- creates through create_comprobante_checkout_atomic (POS/checkout) and
-- create_credit_note_from_comprobante (credit notes), issues remitos through
-- issue_remito_atomic, annuls through annul_comprobante_atomic and deletes
-- through delete_comprobante_with_finance. Every one of those is a public
-- authority-gated wrapper over a private SECURITY DEFINER implementation owned
-- by postgres, so none of them depends on the table grants revoked here.
--
-- The only direct browser INSERTs left were facturacionService.crearComprobante
-- and crearComprobanteIndependiente: legacy non-fiscal draft builders with no
-- reachable caller, removed in the same commit.

BEGIN;

-- Browser comprobante creation and destruction are RPC-only from here on.
REVOKE INSERT, DELETE ON TABLE public.comprobantes FROM authenticated;
DROP POLICY IF EXISTS comprobantes_insert ON public.comprobantes;
DROP POLICY IF EXISTS comprobantes_delete ON public.comprobantes;

-- Migration-time assertions: fail rather than silently leave a parallel path.
DO $postcondition$
DECLARE
  v_col text;
BEGIN
  -- P1-N1: no creation surface, table-wide or per-column.
  IF has_table_privilege('authenticated', 'public.comprobantes', 'INSERT') THEN
    RAISE EXCEPTION 'L3C_POSTCONDITION: comprobantes browser INSERT remains';
  END IF;
  FOREACH v_col IN ARRAY ARRAY[
    'cae','numero_fiscal','estado_fiscal','es_fiscal','payment_status',
    'total_cobrado','estado_comercial','total','saldo_pendiente','business_id'
  ] LOOP
    IF has_column_privilege('authenticated', 'public.comprobantes', v_col, 'INSERT') THEN
      RAISE EXCEPTION 'L3C_POSTCONDITION: comprobantes column INSERT remains on %', v_col;
    END IF;
  END LOOP;

  -- P1-N2: no destruction surface.
  IF has_table_privilege('authenticated', 'public.comprobantes', 'DELETE') THEN
    RAISE EXCEPTION 'L3C_POSTCONDITION: comprobantes browser DELETE remains';
  END IF;

  -- No parallel permissive policy may reintroduce either command.
  IF EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'public.comprobantes'::regclass
       AND polcmd IN ('a','d','*')
  ) THEN
    RAISE EXCEPTION 'L3C_POSTCONDITION: comprobantes INSERT/DELETE policy remains';
  END IF;

  -- anon never had either; assert it stayed that way.
  IF has_table_privilege('anon', 'public.comprobantes', 'INSERT')
     OR has_table_privilege('anon', 'public.comprobantes', 'DELETE') THEN
    RAISE EXCEPTION 'L3C_POSTCONDITION: anon comprobantes write surface present';
  END IF;

  -- Phase B boundary must survive untouched: reads plus the descriptive
  -- allowlist stay, every protected column stays non-updatable.
  IF NOT has_table_privilege('authenticated', 'public.comprobantes', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.comprobantes', 'observaciones', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.comprobantes', 'updated_at', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.comprobantes', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.comprobantes', 'total', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.comprobantes', 'cae', 'UPDATE') THEN
    RAISE EXCEPTION 'L3C_POSTCONDITION: Phase B comprobantes boundary altered';
  END IF;

  -- Canonical create/delete authority must remain reachable and definer-owned.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('create_comprobante_checkout_atomic',
                         'create_credit_note_from_comprobante',
                         'delete_comprobante_with_finance',
                         'issue_remito_atomic',
                         'annul_comprobante_atomic')
       AND p.prosecdef
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
    HAVING count(*) = 5
  ) THEN
    RAISE EXCEPTION 'L3C_POSTCONDITION: canonical comprobante authority incomplete';
  END IF;
END;
$postcondition$;

COMMIT;
