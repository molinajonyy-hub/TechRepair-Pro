-- SEC-08E: auxiliary copies must not bypass canonical financial reads.
BEGIN;

-- Exact get_payment_allocations authority: active canonical/legacy profile,
-- financial role or registered owner. Preserve this existing role contract.
-- The two-argument helper is internal since Lote 2. A self-only wrapper lets
-- RLS call it without exposing authorization probes for arbitrary users.
CREATE OR REPLACE FUNCTION public.can_view_payment_allocations(p_business_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT public.user_can_view_order_amounts(p_business_id, auth.uid());
$$;
ALTER FUNCTION public.can_view_payment_allocations(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.can_view_payment_allocations(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_payment_allocations(uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS cap_alloc_select ON public.customer_account_payment_allocations;
CREATE POLICY cap_alloc_select ON public.customer_account_payment_allocations
  FOR SELECT TO authenticated
  USING (public.can_view_payment_allocations(business_id));

-- Keep descriptions/quantities operational; also block SELECT *, embeds and
-- filter/order oracles on prices. Write privileges are unchanged.
REVOKE SELECT ON public.parts_used FROM PUBLIC, anon, authenticated;
REVOKE SELECT (unit_price, subtotal) ON public.parts_used FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, order_id, code, description, quantity, created_at, created_by, business_id)
  ON public.parts_used TO authenticated;
CREATE OR REPLACE VIEW public.v_parts_used_amounts WITH (security_barrier = true) AS
SELECT p.id, p.order_id, p.business_id, p.unit_price, p.subtotal
FROM public.parts_used p
WHERE p.business_id = public.current_user_business_id()
  AND public.is_staff()
  AND public.current_user_can_in_business(p.business_id, 'orders_view_financials');
ALTER VIEW public.v_parts_used_amounts OWNER TO postgres;
REVOKE ALL ON public.v_parts_used_amounts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_parts_used_amounts TO authenticated, service_role;
COMMENT ON VIEW public.v_parts_used_amounts IS
  'SEC-08E: definer projection required by revoked base columns; restores '
  'tenant, operational membership and orders_view_financials explicitly.';

-- Ledgers need annulment identity/status/date regardless of cost authority.
-- Hiding these rows would incorrectly undo annulments in existing P&L views.
DROP POLICY IF EXISTS comprobante_annulments_select ON public.comprobante_annulments;
CREATE POLICY comprobante_annulments_select ON public.comprobante_annulments
  FOR SELECT TO authenticated
  USING (business_id = public.current_user_business_id());
REVOKE SELECT ON public.comprobante_annulments FROM PUBLIC, anon, authenticated;
REVOKE SELECT (reverted_cash_ars, reverted_cc_ars, reverted_commissions_ars, reverted_cogs_ars)
  ON public.comprobante_annulments FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, business_id, comprobante_id, user_id, idempotency_key,
  request_hash, mode, motivo, restore_stock, stock_restored_count,
  original_caja_ids, refund_caja_id, original_fm_ids, fm_reversal_ids,
  bfe_reversal_ids, cc_reversal_movement_id, status, created_at, annulment_date, op)
  ON public.comprobante_annulments TO authenticated;

-- Payment copies follow comprobante_payments, including linked orders.
-- Per-document COGS follows v_comprobante_item_costs, NOT period-level COGS:
-- finance alone must not become an enumerable product-cost oracle.
CREATE OR REPLACE VIEW public.v_comprobante_annulment_amounts WITH (security_barrier = true) AS
SELECT a.id, a.business_id, a.comprobante_id,
  CASE WHEN public.current_user_can_in_business(a.business_id, 'comprobantes')
       THEN a.reverted_cash_ars END AS reverted_cash_ars,
  CASE WHEN public.current_user_can_in_business(a.business_id, 'comprobantes')
       THEN a.reverted_cc_ars END AS reverted_cc_ars,
  CASE WHEN public.current_user_can_in_business(a.business_id, 'comprobantes')
       THEN a.reverted_commissions_ars END AS reverted_commissions_ars,
  CASE WHEN public.can_view_inventory_cost(a.business_id)
       THEN a.reverted_cogs_ars END AS reverted_cogs_ars
FROM public.comprobante_annulments a
WHERE a.business_id = public.current_user_business_id()
  AND (NOT public.comprobante_is_order_linked(a.comprobante_id)
       OR public.current_user_can_in_business(a.business_id, 'orders_view_financials'))
  AND (public.current_user_can_in_business(a.business_id, 'comprobantes')
       OR public.can_view_inventory_cost(a.business_id));
ALTER VIEW public.v_comprobante_annulment_amounts OWNER TO postgres;
REVOKE ALL ON public.v_comprobante_annulment_amounts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_comprobante_annulment_amounts TO authenticated, service_role;

-- Idempotent mutation replies also return the protected copies. Preserve the
-- original implementation, calculations and action authority; redact only its
-- response. No fiscal logic or stored application data changes.
DO $move$
BEGIN
  IF to_regprocedure('private.sec08e_annul_comprobante_impl(uuid,text,text,boolean,text)') IS NULL THEN
    ALTER FUNCTION public.annul_comprobante_atomic(uuid,text,text,boolean,text) SET SCHEMA private;
    ALTER FUNCTION private.annul_comprobante_atomic(uuid,text,text,boolean,text) RENAME TO sec08e_annul_comprobante_impl;
  END IF;
END;
$move$;
REVOKE ALL ON FUNCTION private.sec08e_annul_comprobante_impl(uuid,text,text,boolean,text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION public.annul_comprobante_atomic(
  p_comprobante_id uuid, p_mode text, p_motivo text,
  p_restore_stock boolean, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_result jsonb;
  v_business uuid;
  v_order_allowed boolean;
BEGIN
  v_result := private.sec08e_annul_comprobante_impl(
    p_comprobante_id, p_mode, p_motivo, p_restore_stock, p_idempotency_key);
  IF current_setting('role', true) = 'service_role' THEN RETURN v_result; END IF;
  SELECT c.business_id INTO v_business FROM public.comprobantes c
    WHERE c.id = p_comprobante_id;
  v_order_allowed := v_business = public.current_user_business_id()
    AND (NOT public.comprobante_is_order_linked(p_comprobante_id)
         OR public.current_user_can_in_business(v_business, 'orders_view_financials'));
  IF (v_order_allowed AND public.current_user_can_in_business(v_business, 'comprobantes')) IS NOT TRUE THEN
    v_result := v_result - ARRAY['reverted_cash_ars','reverted_cc_ars','reverted_commissions_ars'];
  END IF;
  IF (v_order_allowed AND public.can_view_inventory_cost(v_business)) IS NOT TRUE THEN
    v_result := v_result - 'reverted_cogs_ars';
  END IF;
  RETURN v_result;
END;
$$;
ALTER FUNCTION public.annul_comprobante_atomic(uuid,text,text,boolean,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.annul_comprobante_atomic(uuid,text,text,boolean,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.annul_comprobante_atomic(uuid,text,text,boolean,text)
  TO authenticated, service_role;

DO $postconditions$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('parts_used','unit_price'), ('parts_used','subtotal'),
    ('comprobante_annulments','reverted_cash_ars'),
    ('comprobante_annulments','reverted_cc_ars'),
    ('comprobante_annulments','reverted_commissions_ars'),
    ('comprobante_annulments','reverted_cogs_ars')) AS cols(tbl,col)
  LOOP
    IF has_column_privilege('authenticated', 'public.' || r.tbl, r.col, 'SELECT')
       OR has_column_privilege('anon', 'public.' || r.tbl, r.col, 'SELECT') THEN
      RAISE EXCEPTION 'SEC-08E: readable financial column %.%', r.tbl, r.col;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public'
      AND tablename='customer_account_payment_allocations' AND cmd IN ('SELECT','ALL')) <> 1 THEN
    RAISE EXCEPTION 'SEC-08E: concurrent allocations read policy';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid IN
      ('public.customer_account_payment_allocations'::regclass,
       'public.parts_used'::regclass, 'public.comprobante_annulments'::regclass)
      AND NOT relrowsecurity) THEN
    RAISE EXCEPTION 'SEC-08E: RLS must remain enabled';
  END IF;
END;
$postconditions$;
NOTIFY pgrst, 'reload schema';
COMMIT;
