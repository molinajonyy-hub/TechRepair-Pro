-- One exceptional, operator-approved Plan A recovery. DDL only; no case data or DML.
-- The allowlist is a SHA-256 of an exact private identity tuple, never a tenant search.
-- The trusted server must reread MP and run canonical verification before calling.
-- No MP requests, new charges, cancellations, heuristics or arbitrary billing patches here.
BEGIN;
SET LOCAL lock_timeout = '2s';

DO $$
BEGIN
  IF to_regclass('public.uq_scs_mp_preapproval') IS NULL
    OR to_regclass('public.uq_businesses_mp_preapproval_id') IS NULL
    OR to_regclass('public.uq_payments_provider_external_payment') IS NULL
    OR to_regclass('public.uq_payments_mp_payment_id') IS NULL
    OR to_regclass('public.uq_subscription_events_notification') IS NULL
    OR to_regclass('public.uq_scs_pending_business') IS NULL THEN
    RAISE EXCEPTION 'Plan A recovery requires the existing billing identity constraints';
  END IF;
  IF (SELECT count(*) FROM pg_index WHERE indisunique AND indisvalid AND indisready AND indexrelid IN (
    to_regclass('public.uq_scs_mp_preapproval'),to_regclass('public.uq_businesses_mp_preapproval_id'),
    to_regclass('public.uq_payments_provider_external_payment'),to_regclass('public.uq_payments_mp_payment_id'),
    to_regclass('public.uq_subscription_events_notification'),to_regclass('public.uq_scs_pending_business'))) <> 6 THEN
    RAISE EXCEPTION 'Plan A recovery requires valid, ready and unique billing identity indexes';
  END IF;
END $$;

CREATE FUNCTION public.recover_plan_a_paid_case(
  p_case jsonb,
  p_expected_business jsonb,
  p_expected_session jsonb,
  p_ledger jsonb,
  p_provider_last_modified timestamptz,
  p_next_payment_date timestamptz,
  p_evidence_digest text,
  p_approval_ref text,
  p_operator_ref text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s'
SET statement_timeout = '10s'
AS $function$
DECLARE
  v_case_keys constant text[] := ARRAY['business_id','session_id','preapproval_id','preapproval_plan_id','invoice_id','payment_id'];
  v_business_keys constant text[] := ARRAY['id','subscription_status','subscription_plan','subscription_provider','access_source',
    'mp_preapproval_id','mp_preapproval_plan_id','mp_last_modified','current_period_start','current_period_end','grace_until',
    'last_payment_id','last_payment_status','trial_ends_at','override_reason','override_created_by','override_created_at',
    'override_expires_at','updated_at'];
  v_session_keys constant text[] := ARRAY['id','business_id','user_id','plan_id','billing_cycle','amount','currency',
    'mp_preference_id','external_reference','status','created_at','updated_at','mp_preapproval_plan_id','mp_preapproval_id','confirmed_at'];
  v_ledger_keys constant text[] := ARRAY['business_id','external_payment_id','type','amount','currency','status','subscription_plan','paid_at','raw_payload'];
  v_raw_keys constant text[] := ARRAY['authorized_payment_id','preapproval_id','payment_id','invoice_status','payment_status','payment_status_detail','debit_date'];
  v_case_hash text;
  v_business_id uuid;
  v_session_id uuid;
  v_business public.businesses%ROWTYPE;
  v_expected_business public.businesses%ROWTYPE;
  v_session public.subscription_checkout_sessions%ROWTYPE;
  v_expected_session public.subscription_checkout_sessions%ROWTYPE;
  v_existing public.payments%ROWTYPE;
  v_audit public.subscription_events%ROWTYPE;
  v_raw jsonb;
  v_paid_at timestamptz;
  v_now timestamptz := clock_timestamp();
  v_count integer;
  v_item record;
BEGIN
  -- DB role is the trust boundary. A browser's GUC/JWT metadata is not authority.
  IF current_user <> 'service_role' THEN
    RAISE EXCEPTION 'plan_a_recovery_service_role_required' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_case) IS DISTINCT FROM 'object'
    OR NOT (p_case ?& v_case_keys) OR p_case - v_case_keys <> '{}'::jsonb THEN
    RAISE EXCEPTION 'plan_a_recovery_invalid_case' USING ERRCODE = '22023';
  END IF;
  FOR v_item IN SELECT key, value FROM jsonb_each(p_case) LOOP
    IF jsonb_typeof(v_item.value) IS DISTINCT FROM 'string'
      OR (v_item.value #>> '{}') !~ '^[A-Za-z0-9_-]{1,128}$' THEN
      RAISE EXCEPTION 'plan_a_recovery_invalid_identity' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  v_business_id := (p_case->>'business_id')::uuid;
  v_session_id := (p_case->>'session_id')::uuid;
  IF v_business_id::text <> p_case->>'business_id' OR v_session_id::text <> p_case->>'session_id' THEN
    RAISE EXCEPTION 'plan_a_recovery_noncanonical_identity' USING ERRCODE = '22023';
  END IF;
  v_case_hash := encode(sha256(convert_to(concat_ws(E'\n', p_case->>'business_id', p_case->>'session_id',
    p_case->>'preapproval_id', p_case->>'preapproval_plan_id', p_case->>'invoice_id', p_case->>'payment_id'), 'UTF8')), 'hex');
  IF v_case_hash <> 'cf128e8c4ec6fa425e002286f4db8c9df5d6b884abdf138c50b21bcddfff6c7a' THEN
    RAISE EXCEPTION 'plan_a_recovery_case_not_allowlisted' USING ERRCODE = '42501';
  END IF;
  -- PLAN_A_HISTORICAL_APPLICATION_UNRESOLVED_GATE: removal needs a separately reviewed PR.
  -- Being able to read the contract with the current token does not prove its creator application.
  RAISE EXCEPTION 'plan_a_recovery_historical_application_unresolved' USING ERRCODE = '42501';
  IF p_evidence_digest IS NULL OR p_evidence_digest !~ '^[0-9a-f]{64}$'
    OR p_approval_ref IS NULL OR length(btrim(p_approval_ref)) NOT BETWEEN 4 AND 256
    OR p_operator_ref IS NULL OR length(btrim(p_operator_ref)) NOT BETWEEN 4 AND 256
    OR p_approval_ref ~ '[[:cntrl:]]' OR p_operator_ref ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'plan_a_recovery_receipt_required' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_expected_business) IS DISTINCT FROM 'object'
    OR NOT (p_expected_business ?& v_business_keys) OR p_expected_business - v_business_keys <> '{}'::jsonb
    OR jsonb_typeof(p_expected_session) IS DISTINCT FROM 'object'
    OR NOT (p_expected_session ?& v_session_keys) OR p_expected_session - v_session_keys <> '{}'::jsonb
    OR jsonb_typeof(p_ledger) IS DISTINCT FROM 'object'
    OR NOT (p_ledger ?& v_ledger_keys) OR p_ledger - v_ledger_keys <> '{}'::jsonb THEN
    RAISE EXCEPTION 'plan_a_recovery_fixed_schema_required' USING ERRCODE = '22023';
  END IF;
  v_raw := p_ledger->'raw_payload';
  IF jsonb_typeof(v_raw) IS DISTINCT FROM 'object'
    OR NOT (v_raw ?& v_raw_keys) OR v_raw - v_raw_keys <> '{}'::jsonb
    OR p_ledger->>'business_id' IS DISTINCT FROM p_case->>'business_id'
    OR p_ledger->>'external_payment_id' IS DISTINCT FROM p_case->>'invoice_id'
    OR p_ledger->>'type' IS DISTINCT FROM 'recurring'
    OR p_ledger->>'currency' IS DISTINCT FROM 'ARS'
    OR p_ledger->>'status' IS DISTINCT FROM 'approved'
    OR p_ledger->>'subscription_plan' IS DISTINCT FROM 'basico'
    OR (p_ledger->>'amount') IS NULL OR (p_ledger->>'amount') !~ '^[0-9]+([.][0-9]{1,2})?$'
    OR (p_ledger->>'amount')::numeric <> 15000
    OR v_raw->>'authorized_payment_id' IS DISTINCT FROM p_case->>'invoice_id'
    OR v_raw->>'preapproval_id' IS DISTINCT FROM p_case->>'preapproval_id'
    OR v_raw->>'payment_id' IS DISTINCT FROM p_case->>'payment_id'
    OR jsonb_typeof(v_raw->'authorized_payment_id') IS DISTINCT FROM 'string'
    OR jsonb_typeof(v_raw->'preapproval_id') IS DISTINCT FROM 'string'
    OR jsonb_typeof(v_raw->'payment_id') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_ledger->'external_payment_id') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_ledger->'paid_at') IS DISTINCT FROM 'string'
    OR v_raw->>'invoice_status' IS DISTINCT FROM 'processed'
    OR v_raw->>'payment_status' IS DISTINCT FROM 'approved'
    OR jsonb_typeof(v_raw->'payment_status_detail') NOT IN ('null','string')
    OR jsonb_typeof(v_raw->'debit_date') NOT IN ('null','string') THEN
    RAISE EXCEPTION 'plan_a_recovery_canonical_approved_payment_required' USING ERRCODE = '22023';
  END IF;
  v_paid_at := (p_ledger->>'paid_at')::timestamptz;
  IF v_paid_at IS NULL OR NOT isfinite(v_paid_at) OR v_paid_at > v_now
    OR p_provider_last_modified IS NULL OR NOT isfinite(p_provider_last_modified) OR p_provider_last_modified > v_now
    OR p_next_payment_date IS NULL OR NOT isfinite(p_next_payment_date)
    OR p_next_payment_date <= v_paid_at OR p_provider_last_modified < v_paid_at
    OR v_paid_at < '2026-10-02T00:00:00Z'::timestamptz OR v_paid_at >= '2026-10-03T00:00:00Z'::timestamptz
    OR p_next_payment_date < '2026-11-02T00:00:00Z'::timestamptz OR p_next_payment_date >= '2026-11-03T00:00:00Z'::timestamptz THEN
    RAISE EXCEPTION 'plan_a_recovery_verified_period_required' USING ERRCODE = '22023';
  END IF;

  -- Existing writers do not share advisory locks. These brief, global table locks
  -- close absence checks against concurrent inserts/upserts. NOWAIT aborts on
  -- contention; no provider call or human wait occurs inside this transaction.
  LOCK TABLE public.subscription_checkout_sessions, public.payments, public.subscription_events
    IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  SELECT * INTO v_business FROM public.businesses WHERE id = v_business_id FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan_a_recovery_business_missing' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_session FROM public.subscription_checkout_sessions WHERE id = v_session_id FOR UPDATE NOWAIT;
  IF NOT FOUND OR v_session.business_id <> v_business_id THEN
    RAISE EXCEPTION 'plan_a_recovery_session_mismatch' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_audit FROM public.subscription_events
    WHERE provider = 'mercadopago' AND event_type = 'plan_a_paid_case_recovered'
      AND external_id = v_case_hash AND notification_id = 'case:' || v_case_hash;
  IF FOUND THEN
    SELECT * INTO v_existing FROM public.payments
      WHERE provider = 'mercadopago' AND external_payment_id = p_case->>'invoice_id';
    IF v_audit.business_id IS DISTINCT FROM v_business_id OR NOT v_audit.processed
      OR v_audit.raw_payload->>'case_hash' IS DISTINCT FROM v_case_hash
      OR v_audit.raw_payload->>'evidence_digest' IS DISTINCT FROM p_evidence_digest
      OR v_audit.raw_payload->>'session_id' IS DISTINCT FROM p_case->>'session_id'
      OR v_audit.raw_payload->>'preapproval_id' IS DISTINCT FROM p_case->>'preapproval_id'
      OR v_audit.raw_payload->>'invoice_id' IS DISTINCT FROM p_case->>'invoice_id'
      OR v_audit.raw_payload->>'payment_id' IS DISTINCT FROM p_case->>'payment_id'
      OR v_existing.business_id IS DISTINCT FROM v_business_id
      OR v_existing.raw_payload->>'authorized_payment_id' IS DISTINCT FROM p_case->>'invoice_id'
      OR v_existing.raw_payload->>'preapproval_id' IS DISTINCT FROM p_case->>'preapproval_id'
      OR v_existing.raw_payload->>'payment_id' IS DISTINCT FROM p_case->>'payment_id'
      OR v_session.mp_preapproval_id IS DISTINCT FROM p_case->>'preapproval_id' THEN
      RAISE EXCEPTION 'plan_a_recovery_receipt_identity_conflict' USING ERRCODE = '23505';
    END IF;
    -- Never regrant access on replay: subsequent refunds/overrides/replacements win.
    RETURN jsonb_build_object('outcome','already_applied','case_hash',v_case_hash,'audit_id',v_audit.id);
  END IF;

  SELECT * INTO v_expected_business FROM jsonb_populate_record(NULL::public.businesses, p_expected_business);
  SELECT * INTO v_expected_session FROM jsonb_populate_record(NULL::public.subscription_checkout_sessions, p_expected_session);
  IF ROW(v_business.id,v_business.subscription_status,v_business.subscription_plan,v_business.subscription_provider,v_business.access_source,
      v_business.mp_preapproval_id,v_business.mp_preapproval_plan_id,v_business.mp_last_modified,v_business.current_period_start,
      v_business.current_period_end,v_business.grace_until,v_business.last_payment_id,v_business.last_payment_status,v_business.trial_ends_at,
      v_business.override_reason,v_business.override_created_by,v_business.override_created_at,v_business.override_expires_at,v_business.updated_at)
    IS DISTINCT FROM ROW(v_expected_business.id,v_expected_business.subscription_status,v_expected_business.subscription_plan,
      v_expected_business.subscription_provider,v_expected_business.access_source,v_expected_business.mp_preapproval_id,
      v_expected_business.mp_preapproval_plan_id,v_expected_business.mp_last_modified,v_expected_business.current_period_start,
      v_expected_business.current_period_end,v_expected_business.grace_until,v_expected_business.last_payment_id,v_expected_business.last_payment_status,
      v_expected_business.trial_ends_at,v_expected_business.override_reason,v_expected_business.override_created_by,
      v_expected_business.override_created_at,v_expected_business.override_expires_at,v_expected_business.updated_at)
    OR ROW(v_session.id,v_session.business_id,v_session.user_id,v_session.plan_id,v_session.billing_cycle,v_session.amount,v_session.currency,
      v_session.mp_preference_id,v_session.external_reference,v_session.status,v_session.created_at,v_session.updated_at,
      v_session.mp_preapproval_plan_id,v_session.mp_preapproval_id,v_session.confirmed_at)
    IS DISTINCT FROM ROW(v_expected_session.id,v_expected_session.business_id,v_expected_session.user_id,v_expected_session.plan_id,
      v_expected_session.billing_cycle,v_expected_session.amount,v_expected_session.currency,v_expected_session.mp_preference_id,
      v_expected_session.external_reference,v_expected_session.status,v_expected_session.created_at,v_expected_session.updated_at,
      v_expected_session.mp_preapproval_plan_id,v_expected_session.mp_preapproval_id,v_expected_session.confirmed_at) THEN
    RAISE EXCEPTION 'plan_a_recovery_snapshot_changed' USING ERRCODE = '40001';
  END IF;
  IF v_business.subscription_status <> 'trialing' OR v_business.subscription_plan IS NOT NULL
    OR p_next_payment_date <= v_now
    OR (v_business.subscription_provider IS NOT NULL AND v_business.subscription_provider <> 'mercadopago')
    OR (v_business.access_source IS NOT NULL AND v_business.access_source <> 'trial') OR v_business.mp_preapproval_id IS NOT NULL
    OR v_business.mp_preapproval_plan_id IS NOT NULL OR v_business.mp_last_modified IS NOT NULL
    OR v_business.last_payment_id IS NOT NULL OR v_business.last_payment_status IS NOT NULL
    OR v_business.current_period_start IS NOT NULL OR v_business.current_period_end IS NOT NULL OR v_business.grace_until IS NOT NULL
    OR v_business.override_reason IS NOT NULL OR v_business.override_created_by IS NOT NULL
    OR v_business.override_created_at IS NOT NULL OR v_business.override_expires_at IS NOT NULL
    OR v_session.status <> 'pending' OR v_session.mp_preapproval_id IS NOT NULL OR v_session.mp_preference_id IS NOT NULL
    OR v_session.confirmed_at IS NOT NULL OR v_session.mp_preapproval_plan_id IS DISTINCT FROM p_case->>'preapproval_plan_id'
    OR v_session.plan_id <> 'basico' OR v_session.billing_cycle <> 'monthly' OR v_session.amount <> 15000 OR v_session.currency <> 'ARS'
    OR v_session.external_reference IS NULL OR v_session.external_reference !~ '^trpcs_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR v_paid_at < v_session.created_at OR p_provider_last_modified < v_session.created_at THEN
    RAISE EXCEPTION 'plan_a_recovery_initial_state_conflict' USING ERRCODE = '23505';
  END IF;
  IF EXISTS (SELECT 1 FROM public.subscription_checkout_sessions WHERE business_id = v_business_id AND id <> v_session_id)
    OR EXISTS (SELECT 1 FROM public.subscription_checkout_sessions WHERE mp_preapproval_id = p_case->>'preapproval_id')
    OR EXISTS (SELECT 1 FROM public.businesses WHERE mp_preapproval_id = p_case->>'preapproval_id')
    OR EXISTS (SELECT 1 FROM public.payments WHERE provider = 'mercadopago' AND (business_id = v_business_id
      OR external_payment_id = p_case->>'invoice_id' OR raw_payload->>'payment_id' = p_case->>'payment_id'
      OR raw_payload->>'preapproval_id' = p_case->>'preapproval_id')) THEN
    RAISE EXCEPTION 'plan_a_recovery_existing_contract_or_ledger' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.payments(business_id,provider,external_payment_id,type,amount,currency,status,subscription_plan,paid_at,raw_payload)
  VALUES (v_business_id,'mercadopago',p_case->>'invoice_id','recurring',15000,'ARS','approved','basico',v_paid_at,v_raw);
  UPDATE public.subscription_checkout_sessions
    SET mp_preapproval_id = p_case->>'preapproval_id', status = 'paid', confirmed_at = v_now, updated_at = v_now
    WHERE id = v_session_id AND business_id = v_business_id AND status = 'pending' AND mp_preapproval_id IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN RAISE EXCEPTION 'plan_a_recovery_session_cas_failed' USING ERRCODE = '40001'; END IF;
  UPDATE public.businesses SET subscription_status = 'active', subscription_plan = 'basico', subscription_provider = 'mercadopago',
    access_source = 'mercado_pago', mp_preapproval_id = p_case->>'preapproval_id',
    mp_preapproval_plan_id = p_case->>'preapproval_plan_id', mp_last_modified = p_provider_last_modified,
    current_period_start = v_paid_at, current_period_end = p_next_payment_date, grace_until = NULL,
    last_payment_id = p_case->>'payment_id', last_payment_status = 'approved', updated_at = v_now
    WHERE id = v_business_id AND mp_preapproval_id IS NULL AND (access_source IS NULL OR access_source = 'trial')
      AND subscription_status = 'trialing';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN RAISE EXCEPTION 'plan_a_recovery_business_cas_failed' USING ERRCODE = '40001'; END IF;
  INSERT INTO public.subscription_events(business_id,provider,event_type,external_id,notification_id,raw_payload,processed,processed_at)
  VALUES (v_business_id,'mercadopago','plan_a_paid_case_recovered',v_case_hash,'case:' || v_case_hash,
    jsonb_build_object('case_hash',v_case_hash,'session_id',v_session_id,'preapproval_id',p_case->>'preapproval_id',
      'invoice_id',p_case->>'invoice_id','payment_id',p_case->>'payment_id','evidence_digest',p_evidence_digest,
      'approval_ref',btrim(p_approval_ref),'operator_ref',btrim(p_operator_ref),'source','operator_verified_plan_a_exception',
      'previous_business',p_expected_business,'previous_session',p_expected_session,
      'payment_status','approved','plan','basico','billing_cycle','monthly'),true,v_now)
    RETURNING * INTO v_audit;
  RETURN jsonb_build_object('outcome','applied','case_hash',v_case_hash,'audit_id',v_audit.id);
END;
$function$;

REVOKE ALL ON FUNCTION public.recover_plan_a_paid_case(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_plan_a_paid_case(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz,text,text,text)
  TO service_role;
COMMENT ON FUNCTION public.recover_plan_a_paid_case(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz,text,text,text) IS
  'One allowlisted Plan A paid recovery; verified server evidence + independent operator approval required. '
  'Atomic ledger/bind/access/audit, no provider calls. Brief global billing table locks; contention aborts. '
  'SECURITY INVOKER, service_role only. Does not broaden automatic webhook/reconcile attribution.';

COMMIT;
-- Separately authorized rollback removes only this RPC, never recovered business/payment data.
