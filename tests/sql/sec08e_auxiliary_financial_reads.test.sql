-- Catalog post-fix audit. Behavior is tested with JWT actors by sec08e-local.mjs.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.sec08e_assert(ok boolean, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'SEC08E FAIL: %', label; END IF;
END;
$$;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('parts_used','unit_price'),('parts_used','subtotal'),
    ('comprobante_annulments','reverted_cash_ars'),
    ('comprobante_annulments','reverted_cc_ars'),
    ('comprobante_annulments','reverted_commissions_ars'),
    ('comprobante_annulments','reverted_cogs_ars')) AS x(tbl,col)
  LOOP
    PERFORM pg_temp.sec08e_assert(
      NOT has_column_privilege('authenticated','public.'||r.tbl,r.col,'SELECT')
      AND NOT has_column_privilege('anon','public.'||r.tbl,r.col,'SELECT'),r.tbl||'.'||r.col);
  END LOOP;
  PERFORM pg_temp.sec08e_assert(
    has_column_privilege('authenticated','public.parts_used','description','SELECT')
    AND has_column_privilege('authenticated','public.parts_used','quantity','SELECT'), 'operational parts');
  PERFORM pg_temp.sec08e_assert(
    (SELECT count(*)=1 FROM pg_policies WHERE schemaname='public'
      AND tablename='customer_account_payment_allocations' AND cmd IN ('SELECT','ALL'))
    AND (SELECT qual LIKE '%can_view_payment_allocations(business_id)%' FROM pg_policies
      WHERE schemaname='public' AND tablename='customer_account_payment_allocations' AND cmd='SELECT'),
    'no concurrent permissive allocation policy');
  FOR r IN SELECT c.oid,c.relname,c.reloptions,c.relowner FROM pg_class c
    WHERE c.oid IN ('public.v_parts_used_amounts'::regclass,'public.v_comprobante_annulment_amounts'::regclass)
  LOOP
    PERFORM pg_temp.sec08e_assert(pg_get_userbyid(r.relowner)='postgres'
      AND r.reloptions @> ARRAY['security_barrier=true']
      AND NOT r.reloptions @> ARRAY['security_invoker=true'],r.relname||' deliberate definer barrier');
    PERFORM pg_temp.sec08e_assert(has_table_privilege('authenticated',r.oid,'SELECT')
      AND NOT has_table_privilege('anon',r.oid,'SELECT')
      AND NOT has_table_privilege('authenticated',r.oid,'INSERT,UPDATE,DELETE'),r.relname||' read-only grants');
  END LOOP;
  PERFORM pg_temp.sec08e_assert(NOT has_schema_privilege('authenticated','private','USAGE')
    AND NOT has_function_privilege('authenticated','public.user_can_view_order_amounts(uuid,uuid)','EXECUTE')
    AND NOT has_function_privilege('authenticated','private.sec08e_annul_comprobante_impl(uuid,text,text,boolean,text)','EXECUTE'),
    'internal authority and implementation remain private');
  FOR r IN SELECT p.* FROM pg_proc p WHERE p.oid IN
    ('public.can_view_payment_allocations(uuid)'::regprocedure,
     'public.annul_comprobante_atomic(uuid,text,text,boolean,text)'::regprocedure)
  LOOP
    PERFORM pg_temp.sec08e_assert(r.prosecdef AND pg_get_userbyid(r.proowner)='postgres'
      AND r.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
      AND has_function_privilege('authenticated',r.oid,'EXECUTE')
      AND NOT has_function_privilege('anon',r.oid,'EXECUTE'),r.proname||' authority boundary');
  END LOOP;
END;
$$;
ROLLBACK;
