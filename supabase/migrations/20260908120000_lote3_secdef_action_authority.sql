-- Lote 3A: action authority for the 25 tenant-bound SECDEF RPCs deferred by Lote 2.
-- The existing implementations move to private unchanged. Public wrappers keep
-- their signatures/defaults/return contracts and authorize before locks/effects.

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
DECLARE
  v_actor_business_id uuid;
BEGIN
  -- Service-role is a trusted upstream writer, never a browser actor. Execute is
  -- still granted only on the same public signatures that had it at baseline.
  IF auth.role() = 'service_role' THEN
    RETURN;
  END IF;

  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT p.business_id
    INTO v_actor_business_id
    FROM public.profiles p
   WHERE COALESCE(p.user_id, p.id) = auth.uid()
     AND COALESCE(p.is_active, true)
   ORDER BY (p.user_id = auth.uid()) DESC, p.created_at DESC NULLS LAST
   LIMIT 1;

  IF v_actor_business_id IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF p_business_id IS NOT NULL
     AND v_actor_business_id IS DISTINCT FROM p_business_id THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF p_required_feature IS NOT NULL
     AND public.business_has_feature(p_required_feature) IS NOT TRUE THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF public.current_user_can(p_capability) IS NOT TRUE
     OR (p_additional_capability IS NOT NULL
         AND public.current_user_can(p_additional_capability) IS NOT TRUE) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
END;
$function$;

ALTER FUNCTION private.require_action_authority(uuid, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.require_action_authority(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TEMP TABLE lote3_rpc_authority (
  function_name text PRIMARY KEY,
  identity_args text NOT NULL,
  full_args text NOT NULL,
  call_args text NOT NULL,
  business_expr text NOT NULL,
  capability text NOT NULL,
  additional_capability text,
  volatility text NOT NULL,
  service_execute boolean NOT NULL
) ON COMMIT DROP;

INSERT INTO lote3_rpc_authority VALUES
('close_cash_session_atomic',
 'uuid, uuid, uuid, numeric, numeric, numeric, numeric, numeric, text, text',
 'p_business_id uuid, p_user_id uuid, p_caja_id uuid, p_count_efectivo numeric, p_count_transferencia numeric, p_count_tarjeta numeric, p_count_usd numeric, p_usd_rate numeric DEFAULT NULL::numeric, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text',
 'p_business_id,p_user_id,p_caja_id,p_count_efectivo,p_count_transferencia,p_count_tarjeta,p_count_usd,p_usd_rate,p_notes,p_idempotency_key',
 'p_business_id','finance',NULL,'VOLATILE',true),
('create_comprobante_checkout_atomic','uuid, text, text, jsonb',
 'p_business_id uuid, p_idempotency_key text, p_request_hash text, p_payload jsonb',
 'p_business_id,p_idempotency_key,p_request_hash,p_payload','p_business_id','comprobantes',NULL,'VOLATILE',true),
('create_credit_note_finance_reversal','uuid','p_nc_id uuid','p_nc_id','NULL::uuid','comprobantes',NULL,'VOLATILE',true),
('create_credit_note_from_comprobante','uuid','p_comprobante_id uuid','p_comprobante_id','NULL::uuid','comprobantes',NULL,'VOLATILE',true),
('create_expense_with_finance',
 'uuid, uuid, text, text, text, text, numeric, text, date, boolean, text, text, uuid, text',
 'p_business_id uuid, p_user_id uuid, p_description text, p_category text, p_category_key text, p_finance_type text, p_amount numeric, p_payment_method text, p_date date, p_is_recurring boolean DEFAULT false, p_frequency text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_caja_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text',
 'p_business_id,p_user_id,p_description,p_category,p_category_key,p_finance_type,p_amount,p_payment_method,p_date,p_is_recurring,p_frequency,p_notes,p_caja_id,p_idempotency_key',
 'p_business_id','finance',NULL,'VOLATILE',true),
('create_manual_cash_movement_atomic','uuid, text, text, numeric, text, uuid, numeric, text',
 'p_business_id uuid, p_type text, p_method text, p_amount numeric, p_description text, p_user_id uuid, p_exchange_rate numeric DEFAULT 1, p_idempotency_key text DEFAULT NULL::text',
 'p_business_id,p_type,p_method,p_amount,p_description,p_user_id,p_exchange_rate,p_idempotency_key','p_business_id','finance',NULL,'VOLATILE',true),
('create_order_payment_atomic','uuid, uuid, numeric, text, text, numeric, uuid, text, date, text',
 'p_business_id uuid, p_order_id uuid, p_amount numeric, p_payment_method text, p_currency text, p_exchange_rate numeric, p_user_id uuid, p_notes text DEFAULT NULL::text, p_date date DEFAULT NULL::date, p_idempotency_key text DEFAULT NULL::text',
 'p_business_id,p_order_id,p_amount,p_payment_method,p_currency,p_exchange_rate,p_user_id,p_notes,p_date,p_idempotency_key','p_business_id','comprobantes',NULL,'VOLATILE',true),
('create_quick_inventory_purchase_atomic','uuid, text, uuid, text, text, date, text, numeric, numeric, jsonb',
 'p_business_id uuid, p_idempotency_key text, p_supplier_id uuid, p_supplier_name text, p_invoice text, p_date date, p_payment_method text, p_total_ars numeric, p_paid_ars numeric, p_items jsonb',
 'p_business_id,p_idempotency_key,p_supplier_id,p_supplier_name,p_invoice,p_date,p_payment_method,p_total_ars,p_paid_ars,p_items','p_business_id','inventory',NULL,'VOLATILE',true),
('create_supplier_purchase_atomic','uuid, uuid, uuid, text, date, text, numeric, numeric, text, text, jsonb, text',
 'p_business_id uuid, p_supplier_id uuid, p_user_id uuid, p_supplier_name text, p_purchase_date date, p_invoice_number text, p_total_amount numeric, p_paid_amount numeric, p_payment_method text, p_notes text, p_items jsonb, p_idempotency_key text DEFAULT NULL::text',
 'p_business_id,p_supplier_id,p_user_id,p_supplier_name,p_purchase_date,p_invoice_number,p_total_amount,p_paid_amount,p_payment_method,p_notes,p_items,p_idempotency_key','p_business_id','inventory',NULL,'VOLATILE',true),
('customer_purchase_history','uuid, uuid','p_customer_id uuid, p_business_id uuid','p_customer_id,p_business_id','p_business_id','customers','orders_view_financials','VOLATILE',false),
('delete_comprobante_with_finance','uuid','p_comprobante_id uuid','p_comprobante_id','NULL::uuid','comprobantes',NULL,'VOLATILE',true),
('finance_dashboard_summary','uuid, date, date','p_business_id uuid, p_date_from date, p_date_to date','p_business_id,p_date_from,p_date_to','p_business_id','finance',NULL,'STABLE',true),
('finance_health_check','uuid','p_business_id uuid','p_business_id','p_business_id','finance',NULL,'VOLATILE',false),
('finance_health_check_v2','uuid, boolean','p_business_id uuid DEFAULT NULL::uuid, p_include_global boolean DEFAULT false','p_business_id,p_include_global','p_business_id','finance',NULL,'STABLE',true),
('finance_pending_historicals','uuid','p_business_id uuid','p_business_id','p_business_id','finance',NULL,'STABLE',true),
('generate_finance_insights','uuid, date, date','p_business_id uuid, p_period_start date, p_period_end date','p_business_id,p_period_start,p_period_end','p_business_id','finance',NULL,'VOLATILE',true),
('get_checkout_request_status','uuid, text','p_business_id uuid, p_idempotency_key text','p_business_id,p_idempotency_key','p_business_id','comprobantes',NULL,'STABLE',true),
('open_cash_session_atomic','uuid, uuid, numeric, numeric, numeric, numeric, numeric, text',
 'p_business_id uuid, p_user_id uuid, p_efectivo numeric, p_transferencia numeric, p_tarjeta numeric, p_usd numeric, p_usd_rate numeric DEFAULT NULL::numeric, p_idempotency_key text DEFAULT NULL::text',
 'p_business_id,p_user_id,p_efectivo,p_transferencia,p_tarjeta,p_usd,p_usd_rate,p_idempotency_key','p_business_id','finance',NULL,'VOLATILE',true),
('pay_supplier_free_atomic','uuid, uuid, uuid, text, date, numeric, text, text, text',
 'p_business_id uuid, p_supplier_id uuid, p_user_id uuid, p_supplier_name text, p_payment_date date, p_amount numeric, p_payment_method text, p_notes text, p_idempotency_key text DEFAULT NULL::text',
 'p_business_id,p_supplier_id,p_user_id,p_supplier_name,p_payment_date,p_amount,p_payment_method,p_notes,p_idempotency_key','p_business_id','inventory',NULL,'VOLATILE',true),
('pay_supplier_purchase_atomic','uuid, uuid, uuid, text, uuid, date, numeric, text, text, text',
 'p_business_id uuid, p_supplier_id uuid, p_user_id uuid, p_supplier_name text, p_purchase_id uuid, p_payment_date date, p_amount numeric, p_payment_method text, p_notes text, p_idempotency_key text DEFAULT NULL::text',
 'p_business_id,p_supplier_id,p_user_id,p_supplier_name,p_purchase_id,p_payment_date,p_amount,p_payment_method,p_notes,p_idempotency_key','p_business_id','inventory',NULL,'VOLATILE',true),
('replace_comprobante_payment','uuid, uuid, text, numeric, numeric, text, numeric, text, uuid, numeric, text, text',
 'p_comprobante_id uuid, p_business_id uuid, p_payment_method text, p_amount numeric, p_amount_ars numeric, p_currency text, p_exchange_rate numeric, p_notes text, p_user_id uuid, p_commission_amount numeric DEFAULT 0, p_payment_provider text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text',
 'p_comprobante_id,p_business_id,p_payment_method,p_amount,p_amount_ars,p_currency,p_exchange_rate,p_notes,p_user_id,p_commission_amount,p_payment_provider,p_idempotency_key','p_business_id','comprobantes',NULL,'VOLATILE',true),
('reverse_manual_cash_movement','uuid, text','p_movement_id uuid, p_reason text','p_movement_id,p_reason','NULL::uuid','finance',NULL,'VOLATILE',true),
('reverse_operating_expense_atomic','uuid, uuid, text, uuid, text',
 'p_business_id uuid, p_expense_id uuid, p_reason text, p_user_id uuid, p_idempotency_key text DEFAULT NULL::text',
 'p_business_id,p_expense_id,p_reason,p_user_id,p_idempotency_key','p_business_id','finance',NULL,'VOLATILE',true),
('reverse_order_payment_atomic','uuid, uuid, text, uuid, text',
 'p_business_id uuid, p_order_payment_id uuid, p_reason text, p_user_id uuid, p_idempotency_key text DEFAULT NULL::text',
 'p_business_id,p_order_payment_id,p_reason,p_user_id,p_idempotency_key','p_business_id','comprobantes',NULL,'VOLATILE',true),
('update_inventory_dollar_prices','uuid, numeric','p_business_id uuid, p_new_rate numeric','p_business_id,p_new_rate','p_business_id','settings_sensitive',NULL,'VOLATILE',false);

DO $migration$
DECLARE
  r lote3_rpc_authority%ROWTYPE;
  v_service_grant text;
BEGIN
  FOR r IN SELECT * FROM lote3_rpc_authority ORDER BY function_name LOOP
    EXECUTE format(
      'ALTER FUNCTION public.%I(%s) SET SCHEMA private',
      r.function_name, r.identity_args
    );

    EXECUTE format(
      'REVOKE ALL ON FUNCTION private.%I(%s) FROM PUBLIC, anon, authenticated, service_role',
      r.function_name, r.identity_args
    );

    EXECUTE format($ddl$
      CREATE FUNCTION public.%I(%s)
      RETURNS jsonb
      LANGUAGE plpgsql
      %s SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $wrapper$
      BEGIN
        PERFORM private.require_action_authority(%s, %L, %L, %L);
        RETURN private.%I(%s);
      END;
      $wrapper$
    $ddl$,
      r.function_name, r.full_args, r.volatility,
      r.business_expr, r.capability, r.additional_capability,
      CASE WHEN r.function_name='generate_finance_insights' THEN 'advancedFinance' END,
      r.function_name, r.call_args
    );

    EXECUTE format('ALTER FUNCTION public.%I(%s) OWNER TO postgres', r.function_name, r.identity_args);
    EXECUTE format(
      'REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated, service_role',
      r.function_name, r.identity_args
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION public.%I(%s) TO authenticated',
      r.function_name, r.identity_args
    );
    IF r.service_execute THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION public.%I(%s) TO service_role',
        r.function_name, r.identity_args
      );
    END IF;
  END LOOP;
END;
$migration$;

-- The baseline implementation hardcoded owner/admin after the new wrapper.
-- Removing only that redundant inner role check lets current_user_can('finance')
-- preserve custom overrides. The implementation and result shape are unchanged.
CREATE OR REPLACE FUNCTION private.finance_pending_historicals(p_business_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  c_invariant_cutoff constant timestamptz := '2026-07-06 00:00:00-03';
  v_fm_total int; v_fm_pending int;
  v_desync_total int; v_desync_pending int;
  v_fm_rows jsonb; v_desync_rows jsonb;
BEGIN
  SELECT count(*) INTO v_fm_total
    FROM public.financial_movements fm WHERE fm.business_id=p_business_id AND fm.caja_id IS NULL;
  SELECT count(*) INTO v_fm_pending
    FROM public.financial_movements fm WHERE fm.business_id=p_business_id AND fm.caja_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.finance_ledger_reconciliation r
        WHERE r.business_id=p_business_id AND r.entity_table='financial_movements' AND r.entity_id=fm.id
      );
  SELECT COALESCE(jsonb_agg(row_to_json(x)),'[]') INTO v_fm_rows FROM (
    SELECT fm.id AS entity_id, fm.date AS economic_date, fm.type, fm.metodo_pago, fm.amount_ars, fm.source,
      CASE WHEN fm.created_at < c_invariant_cutoff THEN 'legacy_accepted' ELSE 'active_inconsistency' END AS proposed_status,
      (fm.created_at < c_invariant_cutoff) AS legacy
    FROM public.financial_movements fm
    WHERE fm.business_id=p_business_id AND fm.caja_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.finance_ledger_reconciliation r
        WHERE r.business_id=p_business_id AND r.entity_table='financial_movements' AND r.entity_id=fm.id)
    ORDER BY fm.created_at LIMIT 50
  ) x;

  SELECT count(*) INTO v_desync_total FROM public.comprobantes c
    WHERE c.business_id=p_business_id AND c.estado NOT IN ('anulado','cancelled') AND c.total_cobrado IS NOT NULL
      AND abs(COALESCE(c.total_cobrado,0) - (SELECT COALESCE(SUM(amount_ars),0) FROM public.comprobante_payments p WHERE p.comprobante_id=c.id AND p.replaced_at IS NULL)) > 1;
  SELECT count(*) INTO v_desync_pending FROM public.comprobantes c
    WHERE c.business_id=p_business_id AND c.estado NOT IN ('anulado','cancelled') AND c.total_cobrado IS NOT NULL
      AND abs(COALESCE(c.total_cobrado,0) - (SELECT COALESCE(SUM(amount_ars),0) FROM public.comprobante_payments p WHERE p.comprobante_id=c.id AND p.replaced_at IS NULL)) > 1
      AND NOT EXISTS (SELECT 1 FROM public.finance_ledger_reconciliation r
        WHERE r.business_id=p_business_id AND r.entity_table='comprobantes' AND r.entity_id=c.id);
  SELECT COALESCE(jsonb_agg(row_to_json(x)),'[]') INTO v_desync_rows FROM (
    SELECT c.id AS entity_id, COALESCE(c.fecha,c.date,c.created_at::date) AS economic_date,
      c.total_cobrado, (SELECT COALESCE(SUM(amount_ars),0) FROM public.comprobante_payments p WHERE p.comprobante_id=c.id AND p.replaced_at IS NULL) AS sum_payments,
      'indeterminate' AS proposed_status
    FROM public.comprobantes c
    WHERE c.business_id=p_business_id AND c.estado NOT IN ('anulado','cancelled') AND c.total_cobrado IS NOT NULL
      AND abs(COALESCE(c.total_cobrado,0) - (SELECT COALESCE(SUM(amount_ars),0) FROM public.comprobante_payments p WHERE p.comprobante_id=c.id AND p.replaced_at IS NULL)) > 1
      AND NOT EXISTS (SELECT 1 FROM public.finance_ledger_reconciliation r
        WHERE r.business_id=p_business_id AND r.entity_table='comprobantes' AND r.entity_id=c.id)
    ORDER BY c.created_at DESC LIMIT 50
  ) x;

  RETURN jsonb_build_object(
    'ok', true, 'dry_run', true, 'business_id', p_business_id, 'generated_at', now(),
    'issues', jsonb_build_array(
      jsonb_build_object('issue_type','fm_sin_caja','total',v_fm_total,'pending',v_fm_pending,
        'classified', v_fm_total - v_fm_pending, 'sample', v_fm_rows),
      jsonb_build_object('issue_type','comprobante_desync','total',v_desync_total,'pending',v_desync_pending,
        'classified', v_desync_total - v_desync_pending, 'sample', v_desync_rows)
    )
  );
END;
$function$;

ALTER FUNCTION private.finance_pending_historicals(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.finance_pending_historicals(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION private.require_action_authority(uuid, text, text, text) IS
  'Lote 3 internal gate: valid JWT, active canonical membership, optional tenant equality, optional plan entitlement, and one/two current_user_can capabilities.';
