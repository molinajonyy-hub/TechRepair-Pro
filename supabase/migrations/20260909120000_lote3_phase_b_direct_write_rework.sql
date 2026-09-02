-- Lote 3 Phase B: minimal rework after independent adversarial review.
-- Close direct browser paths that bypass canonical supplier/comprobante flows,
-- restore the diagnostic role contract, and make the service bypass depend on
-- the effective PostgreSQL role rather than a caller-controlled JWT GUC.

BEGIN;

-- Canonical actor resolution. get_my_profile() is the existing canonical
-- identity resolver (including duplicate/legacy ordering). Explicit inactive
-- profiles fail closed; legacy NULL remains active by that helper's contract.
--
-- Keep the decision as a predicate so each public wrapper can raise its own
-- 42501. The local PostgreSQL runtime can terminate a backend while propagating
-- a nested PL/pgSQL exception through some pre-existing, same-named wrappers.
CREATE OR REPLACE FUNCTION private.has_action_authority(
  p_business_id uuid,
  p_capability text,
  p_additional_capability text DEFAULT NULL::text,
  p_required_feature text DEFAULT NULL::text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_actor_business_id uuid;
  v_actor_active boolean;
  v_actor_subject text;
  v_actor_id uuid;
BEGIN
  -- In SECURITY DEFINER current_user is the function owner. PostgreSQL's role
  -- setting retains the invoker selected by PostgREST and cannot be forged by
  -- changing request.jwt.claims inside an authenticated DB role.
  IF current_setting('role', true) = 'service_role' THEN
    RETURN true;
  END IF;

  -- auth.uid() casts request.jwt.claim.sub directly to uuid. The local anon
  -- role carries an empty legacy claim GUC, so reject it before invoking the
  -- canonical profile helper (which correctly uses auth.uid for real actors).
  v_actor_subject := NULLIF(current_setting('request.jwt.claim.sub', true), '');
  IF v_actor_subject IS NULL THEN
    v_actor_subject := NULLIF(
      current_setting('request.jwt.claims', true)::jsonb ->> 'sub',
      ''
    );
  END IF;
  IF v_actor_subject IS NULL THEN
    RETURN false;
  END IF;
  v_actor_id := v_actor_subject::uuid;

  SELECT p.business_id, p.is_active
    INTO v_actor_business_id, v_actor_active
    FROM public.get_my_profile() p;

  IF v_actor_business_id IS NULL OR v_actor_active IS NOT TRUE THEN
    RETURN false;
  END IF;

  IF p_business_id IS NOT NULL
     AND v_actor_business_id IS DISTINCT FROM p_business_id THEN
    RETURN false;
  END IF;

  IF p_required_feature IS NOT NULL
     AND public.business_has_feature(p_required_feature) IS NOT TRUE THEN
    RETURN false;
  END IF;

  RETURN public.current_user_can(p_capability) IS TRUE
     AND (p_additional_capability IS NULL
          OR public.current_user_can(p_additional_capability) IS TRUE);
EXCEPTION WHEN OTHERS THEN
  -- Authority infrastructure errors deny; callers never receive a bypass.
  RETURN false;
END;
$function$;

ALTER FUNCTION private.has_action_authority(uuid, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.has_action_authority(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.require_action_authority(
  p_business_id uuid,
  p_capability text,
  p_additional_capability text DEFAULT NULL::text,
  p_required_feature text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF private.has_action_authority(
       p_business_id, p_capability, p_additional_capability, p_required_feature
     ) IS NOT TRUE THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
END;
$function$;

ALTER FUNCTION private.require_action_authority(uuid, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.require_action_authority(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- This unwired dry-run diagnostic was historically owner/admin-only. Finance
-- capability remains additive; custom permission overrides do not broaden it.
CREATE OR REPLACE FUNCTION public.finance_pending_historicals(p_business_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_role text;
BEGIN
  IF private.has_action_authority(p_business_id, 'finance', NULL, NULL) IS NOT TRUE THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF current_setting('role', true) <> 'service_role' THEN
    SELECT p.role INTO v_role FROM public.get_my_profile() p;
    IF v_role IS NULL OR v_role NOT IN ('owner','admin') THEN
      RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN private.finance_pending_historicals(p_business_id);
END;
$function$;

ALTER FUNCTION public.finance_pending_historicals(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.finance_pending_historicals(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finance_pending_historicals(uuid)
  TO authenticated, service_role;

-- Supplier purchase deletion is RPC-only. Separate policies preserve the
-- existing inventory-authorized SELECT/INSERT/UPDATE contract without DELETE.
REVOKE DELETE ON TABLE public.supplier_purchases FROM authenticated;
REVOKE DELETE ON TABLE public.supplier_purchase_items FROM authenticated;

DROP POLICY IF EXISTS rls_supplier_purchases ON public.supplier_purchases;
CREATE POLICY supplier_purchases_inventory_select
  ON public.supplier_purchases FOR SELECT TO authenticated
  USING (business_id = public.current_business_id()
    AND public.current_user_can('inventory'));
CREATE POLICY supplier_purchases_inventory_insert
  ON public.supplier_purchases FOR INSERT TO authenticated
  WITH CHECK (business_id = public.current_business_id()
    AND public.current_user_can('inventory'));
CREATE POLICY supplier_purchases_inventory_update
  ON public.supplier_purchases FOR UPDATE TO authenticated
  USING (business_id = public.current_business_id()
    AND public.current_user_can('inventory'))
  WITH CHECK (business_id = public.current_business_id()
    AND public.current_user_can('inventory'));

DROP POLICY IF EXISTS rls_supplier_purchase_items ON public.supplier_purchase_items;
CREATE POLICY supplier_purchase_items_inventory_select
  ON public.supplier_purchase_items FOR SELECT TO authenticated
  USING (business_id = public.current_business_id()
    AND public.current_user_can('inventory'));
CREATE POLICY supplier_purchase_items_inventory_insert
  ON public.supplier_purchase_items FOR INSERT TO authenticated
  WITH CHECK (business_id = public.current_business_id()
    AND public.current_user_can('inventory'));
CREATE POLICY supplier_purchase_items_inventory_update
  ON public.supplier_purchase_items FOR UPDATE TO authenticated
  USING (business_id = public.current_business_id()
    AND public.current_user_can('inventory'))
  WITH CHECK (business_id = public.current_business_id()
    AND public.current_user_can('inventory'));

-- Browser UPDATE is an explicit descriptive-field allowlist. All economic,
-- payment, fiscal, numbering, linkage, issuance and annulment columns are owned
-- by canonical SECDEF functions/triggers and have no authenticated UPDATE grant.
REVOKE UPDATE ON TABLE public.comprobantes FROM authenticated;
GRANT UPDATE (observaciones, updated_at) ON TABLE public.comprobantes TO authenticated;

-- The one reachable legitimate direct state update is remito issuance. Move it
-- behind a narrow RPC so browser column grants stay fail-closed.
CREATE OR REPLACE FUNCTION public.issue_remito_atomic(
  p_comprobante_id uuid,
  p_business_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_tipo text;
  v_estado text;
  v_status text;
BEGIN
  IF private.has_action_authority(p_business_id, 'comprobantes', NULL, NULL) IS NOT TRUE THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT c.tipo, c.estado, c.status
    INTO v_tipo, v_estado, v_status
    FROM public.comprobantes c
   WHERE c.id = p_comprobante_id
     AND c.business_id = p_business_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND');
  END IF;
  IF v_tipo IS DISTINCT FROM 'remito' THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'NOT_REMITO');
  END IF;
  IF lower(COALESCE(v_estado, '')) IN ('anulado','cancelled')
     OR lower(COALESCE(v_status, '')) IN ('annulled','cancelled') THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'ALREADY_ANNULLED');
  END IF;
  IF v_estado = 'emitido' AND v_status = 'issued' THEN
    RETURN jsonb_build_object('ok', true, 'replay', true,
      'comprobante_id', p_comprobante_id);
  END IF;

  UPDATE public.comprobantes
     SET estado = 'emitido',
         status = 'issued',
         estado_fiscal = 'no_fiscal',
         updated_at = now()
   WHERE id = p_comprobante_id
     AND business_id = p_business_id;

  RETURN jsonb_build_object('ok', true, 'replay', false,
    'comprobante_id', p_comprobante_id);
END;
$function$;

ALTER FUNCTION public.issue_remito_atomic(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.issue_remito_atomic(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.issue_remito_atomic(uuid, uuid) TO authenticated;

-- Canonical payment rows can only be created by checkout/replacement SECDEF
-- paths. Read access remains capability-gated for the receipt UI/history.
DROP POLICY IF EXISTS cp_insert ON public.comprobante_payments;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.comprobante_payments FROM authenticated;

-- No Beta browser reader exists for provider transaction history.
DROP POLICY IF EXISTS pt_select ON public.payment_transactions;
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.payment_transactions FROM authenticated;

-- Migration-time assertions: fail rather than silently leave a parallel path.
DO $postcondition$
BEGIN
  IF has_table_privilege('authenticated','public.supplier_purchases','DELETE')
     OR has_table_privilege('authenticated','public.supplier_purchase_items','DELETE') THEN
    RAISE EXCEPTION 'L3B_POSTCONDITION: supplier purchase browser DELETE remains';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid IN ('public.supplier_purchases'::regclass,
                        'public.supplier_purchase_items'::regclass)
       AND polcmd IN ('d','*')
  ) THEN
    RAISE EXCEPTION 'L3B_POSTCONDITION: supplier purchase DELETE policy remains';
  END IF;
  IF has_table_privilege('authenticated','public.comprobantes','UPDATE')
     OR has_column_privilege('authenticated','public.comprobantes','total','UPDATE')
     OR has_column_privilege('authenticated','public.comprobantes','cae','UPDATE')
     OR has_column_privilege('authenticated','public.comprobantes','payment_status','UPDATE')
     OR NOT has_column_privilege('authenticated','public.comprobantes','observaciones','UPDATE') THEN
    RAISE EXCEPTION 'L3B_POSTCONDITION: comprobantes column boundary invalid';
  END IF;
  IF has_table_privilege('authenticated','public.comprobante_payments','INSERT')
     OR EXISTS (SELECT 1 FROM pg_policy
                 WHERE polrelid='public.comprobante_payments'::regclass
                   AND polcmd IN ('a','*')) THEN
    RAISE EXCEPTION 'L3B_POSTCONDITION: comprobante_payments browser INSERT remains';
  END IF;
  IF has_table_privilege('authenticated','public.payment_transactions','SELECT')
     OR EXISTS (SELECT 1 FROM pg_policy
                 WHERE polrelid='public.payment_transactions'::regclass
                   AND polcmd IN ('r','*')) THEN
    RAISE EXCEPTION 'L3B_POSTCONDITION: payment_transactions browser SELECT remains';
  END IF;
END;
$postcondition$;

COMMIT;
