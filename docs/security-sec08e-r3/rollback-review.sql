-- R3 rollback REVIEW MATERIAL. No production execution authorized.
-- Restores the measured pre-R3 access (including its known read leaks).
-- No migration-history or R2A/R2B changes. Use only the retained contract-1 UI.
BEGIN;
DO $preconditions$
BEGIN
  IF to_regprocedure('private.sec08e_annul_comprobante_impl(uuid,text,text,boolean,text)') IS NULL
     OR to_regclass('public.v_parts_used_amounts') IS NULL
     OR to_regclass('public.v_comprobante_annulment_amounts') IS NULL THEN
    RAISE EXCEPTION 'R3 rollback requires a complete R3 installation';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='private.sec08e_annul_comprobante_impl(uuid,text,text,boolean,text)'::regprocedure)
       IS DISTINCT FROM '72f9a16bec124d6588c23a4ce21685bf' THEN
    RAISE EXCEPTION 'R3 rollback: implementation drift requires new review';
  END IF;
  IF (SELECT enforcement_state = 'enabled' AND minimum_contract = 1 FROM private.client_contract_config WHERE singleton IS TRUE) IS NOT TRUE THEN
    RAISE EXCEPTION 'R3 rollback: client gate drift';
  END IF;
END;
$preconditions$;
DROP VIEW public.v_parts_used_amounts;
DROP VIEW public.v_comprobante_annulment_amounts;
DROP POLICY comprobante_annulments_select ON public.comprobante_annulments;
CREATE POLICY comprobante_annulments_select ON public.comprobante_annulments AS PERMISSIVE FOR SELECT TO public USING (((EXISTS ( SELECT 1
   FROM businesses
  WHERE ((businesses.id = comprobante_annulments.business_id) AND (businesses.owner_user_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.business_id = comprobante_annulments.business_id) AND (profiles.user_id = auth.uid()))))));
DROP POLICY cap_alloc_select ON public.customer_account_payment_allocations;
CREATE POLICY cap_alloc_select ON public.customer_account_payment_allocations AS PERMISSIVE FOR SELECT TO authenticated USING (((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.business_id = customer_account_payment_allocations.business_id) AND (p.user_id = auth.uid()) AND COALESCE(p.is_active, true)))) OR (EXISTS ( SELECT 1
   FROM businesses b
  WHERE ((b.id = customer_account_payment_allocations.business_id) AND (b.owner_user_id = auth.uid()))))));
DROP FUNCTION public.can_view_payment_allocations(uuid);
REVOKE SELECT (id, order_id, code, description, quantity, unit_price, subtotal, created_at, created_by, business_id) ON public.parts_used FROM authenticated;
REVOKE SELECT (id, business_id, comprobante_id, user_id, idempotency_key, request_hash, mode, motivo, restore_stock, stock_restored_count, original_caja_ids, refund_caja_id, reverted_cash_ars, reverted_cc_ars, reverted_commissions_ars, reverted_cogs_ars, original_fm_ids, fm_reversal_ids, bfe_reversal_ids, cc_reversal_movement_id, status, created_at, annulment_date, op) ON public.comprobante_annulments FROM authenticated;
GRANT SELECT ON public.parts_used TO anon, authenticated;
GRANT SELECT ON public.comprobante_annulments TO authenticated;
DROP FUNCTION public.annul_comprobante_atomic(uuid,text,text,boolean,text);
ALTER FUNCTION private.sec08e_annul_comprobante_impl(uuid,text,text,boolean,text) RENAME TO annul_comprobante_atomic;
ALTER FUNCTION private.annul_comprobante_atomic(uuid,text,text,boolean,text) SET SCHEMA public;
REVOKE ALL ON FUNCTION public.annul_comprobante_atomic(uuid,text,text,boolean,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.annul_comprobante_atomic(uuid,text,text,boolean,text) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
