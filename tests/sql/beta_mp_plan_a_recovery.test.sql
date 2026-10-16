-- LOCAL CLONE ONLY. Fixtures and candidate substitutions never leave the disposable clone.
-- Real private identities are never present. The production allowlist stays unchanged.
\set ON_ERROR_STOP on
\if :{?PLAN_A_COMMIT_CANDIDATE}
\else
\set PLAN_A_COMMIT_CANDIDATE false
\endif
BEGIN;
SET LOCAL statement_timeout = '20s';
DO $$
BEGIN
  IF current_database() !~ '^beta_mp_recovery_[a-f0-9]{12}$' THEN
    RAISE EXCEPTION 'This test requires the disposable LOCAL recovery clone';
  END IF;
END $$;

CREATE FUNCTION pg_temp.assert(p_ok boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', p_label; END IF;
  RAISE NOTICE 'PASS: %', p_label;
END $$;
CREATE TEMP TABLE plan_a_fixture(args jsonb);
SET LOCAL session_replication_role = 'replica';
INSERT INTO auth.users(id) VALUES ('10000000-0000-4000-8000-00000000a009'),('10000000-0000-4000-8000-00000000b009');
INSERT INTO public.businesses(id,name,owner_user_id,subscription_status,subscription_plan,subscription_provider,access_source,
  mp_preapproval_id,mp_preapproval_plan_id,last_payment_id,last_payment_status,current_period_start,current_period_end,
  grace_until,override_reason,override_created_by,override_created_at,override_expires_at,mp_last_modified)
VALUES ('10000000-0000-4000-8000-00000000a001','Synthetic Plan A recovery','10000000-0000-4000-8000-00000000a009',
  'trialing',NULL,'mercadopago',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
  ('10000000-0000-4000-8000-00000000b001','Synthetic foreign tenant','10000000-0000-4000-8000-00000000b009',
  'trialing',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
SET LOCAL session_replication_role = 'origin';
INSERT INTO public.subscription_checkout_sessions(id,business_id,user_id,plan_id,billing_cycle,amount,currency,
  external_reference,mp_preapproval_plan_id,created_at,updated_at,status)
VALUES ('10000000-0000-4000-8000-00000000a005','10000000-0000-4000-8000-00000000a001','10000000-0000-4000-8000-00000000a009',
  'basico','monthly',15000,'ARS','trpcs_10000000-0000-4000-8000-00000000a005','fixture_plan',
  '2026-10-02T12:45:00Z','2026-10-02T12:48:00Z','pending');
INSERT INTO plan_a_fixture(args) VALUES (jsonb_build_object(
  'p_case',jsonb_build_object('business_id','10000000-0000-4000-8000-00000000a001','session_id','10000000-0000-4000-8000-00000000a005',
    'preapproval_id','fixture_preapproval','preapproval_plan_id','fixture_plan','invoice_id','fixture_invoice','payment_id','fixture_payment'),
  'p_ledger',jsonb_build_object('business_id','10000000-0000-4000-8000-00000000a001','external_payment_id','fixture_invoice',
    'type','recurring','amount',15000,'currency','ARS','status','approved','subscription_plan','basico','paid_at','2026-10-02T13:00:00Z',
    'raw_payload',jsonb_build_object('authorized_payment_id','fixture_invoice','preapproval_id','fixture_preapproval','payment_id','fixture_payment',
      'invoice_status','processed','payment_status','approved','payment_status_detail','accredited','debit_date','2026-10-02T12:59:00Z')),
  'p_provider_last_modified','2026-10-02T13:01:00Z','p_next_payment_date','2026-11-02T13:00:00Z',
  'p_evidence_digest',repeat('a',64),'p_approval_ref','synthetic-approval','p_operator_ref','synthetic-operator'));

CREATE FUNCTION pg_temp.refresh_snapshots() RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_b jsonb; v_s jsonb;
BEGIN
  SELECT jsonb_object_agg(k,to_jsonb(b)->k) INTO v_b FROM public.businesses b,
    unnest(ARRAY['id','subscription_status','subscription_plan','subscription_provider','access_source','mp_preapproval_id',
      'mp_preapproval_plan_id','mp_last_modified','current_period_start','current_period_end','grace_until','last_payment_id',
      'last_payment_status','trial_ends_at','override_reason','override_created_by','override_created_at','override_expires_at','updated_at']) k
    WHERE b.id='10000000-0000-4000-8000-00000000a001';
  SELECT jsonb_object_agg(k,to_jsonb(s)->k) INTO v_s FROM public.subscription_checkout_sessions s,
    unnest(ARRAY['id','business_id','user_id','plan_id','billing_cycle','amount','currency','mp_preference_id','external_reference',
      'status','created_at','updated_at','mp_preapproval_plan_id','mp_preapproval_id','confirmed_at']) k
    WHERE s.id='10000000-0000-4000-8000-00000000a005';
  UPDATE pg_temp.plan_a_fixture SET args=args || jsonb_build_object('p_expected_business',v_b,'p_expected_session',v_s);
END $$;
SELECT pg_temp.refresh_snapshots();

CREATE FUNCTION pg_temp.invoke(p_override jsonb DEFAULT '{}'::jsonb,p_role text DEFAULT 'service_role')
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE a jsonb; v_result jsonb; v_state text; v_error text;
BEGIN
  SELECT args || p_override INTO a FROM pg_temp.plan_a_fixture;
  EXECUTE format('SET LOCAL ROLE %I',p_role);
  BEGIN
    v_result := public.recover_plan_a_paid_case(a->'p_case',a->'p_expected_business',a->'p_expected_session',a->'p_ledger',
      (a->>'p_provider_last_modified')::timestamptz,(a->>'p_next_payment_date')::timestamptz,
      a->>'p_evidence_digest',a->>'p_approval_ref',a->>'p_operator_ref');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state=RETURNED_SQLSTATE,v_error=MESSAGE_TEXT;
    RESET ROLE;
    RETURN jsonb_build_object('sqlstate',v_state,'error',v_error);
  END;
  RESET ROLE;
  RETURN v_result;
END $$;
CREATE FUNCTION pg_temp.rejected(p_override jsonb,p_state text,p_label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_before jsonb; v_after jsonb; v_result jsonb;
BEGIN
  SELECT jsonb_build_object('business',to_jsonb(b),'session',to_jsonb(s),
    'payments',(SELECT count(*) FROM public.payments),'events',(SELECT count(*) FROM public.subscription_events)) INTO v_before
    FROM public.businesses b,public.subscription_checkout_sessions s
    WHERE b.id='10000000-0000-4000-8000-00000000a001' AND s.id='10000000-0000-4000-8000-00000000a005';
  v_result := pg_temp.invoke(p_override);
  PERFORM pg_temp.assert(v_result->>'sqlstate'=p_state,p_label || ' [' || coalesce(v_result::text,'null') || ']');
  SELECT jsonb_build_object('business',to_jsonb(b),'session',to_jsonb(s),
    'payments',(SELECT count(*) FROM public.payments),'events',(SELECT count(*) FROM public.subscription_events)) INTO v_after
    FROM public.businesses b,public.subscription_checkout_sessions s
    WHERE b.id='10000000-0000-4000-8000-00000000a001' AND s.id='10000000-0000-4000-8000-00000000a005';
  PERFORM pg_temp.assert(v_before=v_after,p_label || ' leaves all state unchanged');
END $$;

SELECT pg_temp.assert(NOT (SELECT prosecdef FROM pg_proc WHERE oid='public.recover_plan_a_paid_case(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz,text,text,text)'::regprocedure),'SECURITY INVOKER');
SELECT pg_temp.assert(NOT has_function_privilege('authenticated','public.recover_plan_a_paid_case(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz,text,text,text)','EXECUTE'),'authenticated cannot execute');
SELECT pg_temp.assert(NOT has_function_privilege('anon','public.recover_plan_a_paid_case(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz,text,text,text)','EXECUTE'),'anon cannot execute');
SELECT pg_temp.assert(has_function_privilege('service_role','public.recover_plan_a_paid_case(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz,text,text,text)','EXECUTE'),'service_role can execute');
SELECT pg_temp.assert(pg_temp.invoke('{}','authenticated')->>'sqlstate'='42501','browser cannot call recovery');
SELECT pg_temp.assert(pg_temp.invoke('{}','anon')->>'sqlstate'='42501','anonymous cannot call recovery');
SELECT pg_temp.rejected('{}','42501','production allowlist denies every synthetic identity');

-- Substitute the exact allowlist hash ONLY in this disposable clone transaction.
DO $$
DECLARE v_definition text; v_fixture_hash text;
BEGIN
  SELECT encode(sha256(convert_to(concat_ws(E'\n',args#>>'{p_case,business_id}',args#>>'{p_case,session_id}',
    args#>>'{p_case,preapproval_id}',args#>>'{p_case,preapproval_plan_id}',args#>>'{p_case,invoice_id}',args#>>'{p_case,payment_id}'),'UTF8')),'hex')
    INTO v_fixture_hash FROM pg_temp.plan_a_fixture;
  v_definition := pg_get_functiondef('public.recover_plan_a_paid_case(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz,text,text,text)'::regprocedure);
  IF position('cf128e8c4ec6fa425e002286f4db8c9df5d6b884abdf138c50b21bcddfff6c7a' IN v_definition)=0 THEN
    RAISE EXCEPTION 'production allowlist missing';
  END IF;
  EXECUTE replace(v_definition,'cf128e8c4ec6fa425e002286f4db8c9df5d6b884abdf138c50b21bcddfff6c7a',v_fixture_hash);
END $$;

SELECT pg_temp.rejected('{}','42501','historical application gate blocks before every write');
SELECT pg_temp.assert(pg_temp.invoke()->>'error'='plan_a_recovery_historical_application_unresolved','historical application failure is explicit');
DO $$
DECLARE v_definition text;
BEGIN
  v_definition := pg_get_functiondef('public.recover_plan_a_paid_case(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz,text,text,text)'::regprocedure);
  IF position('RAISE EXCEPTION ''plan_a_recovery_historical_application_unresolved'' USING ERRCODE = ''42501'';' IN v_definition)=0 THEN
    RAISE EXCEPTION 'unconditional historical application gate missing';
  END IF;
  -- Candidate behavior is exercised only in the guarded, disposable clone transaction.
  EXECUTE replace(v_definition,'RAISE EXCEPTION ''plan_a_recovery_historical_application_unresolved'' USING ERRCODE = ''42501'';',
    'NULL; -- synthetic clone proof only; production gate remains closed');
END $$;

-- PLAN_A_CONCURRENCY_CHECKPOINT

SELECT pg_temp.rejected(jsonb_build_object('p_approval_ref',NULL),'22023','independent approval receipt required');
SELECT pg_temp.rejected(jsonb_build_object('p_evidence_digest','not-a-digest'),'22023','evidence digest required');
SELECT pg_temp.rejected(jsonb_build_object('p_case',(SELECT (args->'p_case') || '{"payment_id":"another_payment"}'::jsonb FROM plan_a_fixture)),'42501','native identity changes fail allowlist');
SELECT pg_temp.rejected(jsonb_build_object('p_expected_business',(SELECT (args->'p_expected_business') || '{"arbitrary_patch":"active"}'::jsonb FROM plan_a_fixture)),'22023','extra snapshot keys denied');
SELECT pg_temp.rejected(jsonb_build_object('p_expected_session',(SELECT (args->'p_expected_session') - 'updated_at' FROM plan_a_fixture)),'22023','missing snapshot keys denied');
SELECT pg_temp.rejected(jsonb_build_object('p_expected_business',(SELECT (args->'p_expected_business') || '{"subscription_status":"active"}'::jsonb FROM plan_a_fixture)),'40001','stale business snapshot denied');
SELECT pg_temp.rejected(jsonb_build_object('p_expected_session',(SELECT (args->'p_expected_session') || '{"updated_at":"2026-10-02T12:49:00Z"}'::jsonb FROM plan_a_fixture)),'40001','stale session snapshot denied');
SELECT pg_temp.rejected(jsonb_build_object('p_ledger',(SELECT (args->'p_ledger') || '{"status":"pending"}'::jsonb FROM plan_a_fixture)),'22023','pending payment does not activate');
SELECT pg_temp.rejected(jsonb_build_object('p_ledger',(SELECT (args->'p_ledger') || '{"amount":14999}'::jsonb FROM plan_a_fixture)),'22023','amount must match exactly');
SELECT pg_temp.rejected(jsonb_build_object('p_ledger',(SELECT jsonb_set(args->'p_ledger','{raw_payload,payment_id}','"foreign_payment"') FROM plan_a_fixture)),'22023','invoice to payment mismatch denied');
SELECT pg_temp.rejected(jsonb_build_object('p_ledger',(SELECT jsonb_set(args->'p_ledger','{raw_payload,invoice_status}','"authorized"') FROM plan_a_fixture)),'22023','unprocessed invoice denied');
SELECT pg_temp.rejected(jsonb_build_object('p_ledger',(SELECT jsonb_set(args->'p_ledger','{raw_payload,extra_field}','true') FROM plan_a_fixture)),'22023','noncanonical raw fields denied');
SELECT pg_temp.rejected(jsonb_build_object('p_ledger',(SELECT (args->'p_ledger') || '{"paid_at":null}'::jsonb FROM plan_a_fixture)),'22023','missing approval timestamp denied');
SELECT pg_temp.rejected(jsonb_build_object('p_provider_last_modified','2026-10-02T12:59:00Z'),'22023','provider state older than approved payment denied');
SELECT pg_temp.rejected(jsonb_build_object('p_next_payment_date','2026-11-03T13:00:00Z'),'22023','unreviewed period extension denied');

SAVEPOINT override_case;
UPDATE public.businesses SET access_source='admin_override',override_reason='synthetic override' WHERE id='10000000-0000-4000-8000-00000000a001';
SELECT pg_temp.refresh_snapshots();
SELECT pg_temp.rejected('{}','23505','admin override blocks even with fresh snapshot');
ROLLBACK TO SAVEPOINT override_case;
SAVEPOINT grandfathered_case;
UPDATE public.businesses SET access_source='manual_grandfathered' WHERE id='10000000-0000-4000-8000-00000000a001';
SELECT pg_temp.refresh_snapshots();
SELECT pg_temp.rejected('{}','23505','grandfathered access blocks even with fresh snapshot');
ROLLBACK TO SAVEPOINT grandfathered_case;
SAVEPOINT existing_mp_access;
UPDATE public.businesses SET access_source='mercado_pago' WHERE id='10000000-0000-4000-8000-00000000a001';
SELECT pg_temp.refresh_snapshots();
SELECT pg_temp.rejected('{}','23505','existing MP access cannot be overwritten');
ROLLBACK TO SAVEPOINT existing_mp_access;
SAVEPOINT prior_contract;
UPDATE public.businesses SET mp_preapproval_id='other_contract' WHERE id='10000000-0000-4000-8000-00000000a001';
SELECT pg_temp.refresh_snapshots();
SELECT pg_temp.rejected('{}','23505','existing business contract blocks');
ROLLBACK TO SAVEPOINT prior_contract;
SAVEPOINT foreign_contract;
UPDATE public.businesses SET mp_preapproval_id='fixture_preapproval' WHERE id='10000000-0000-4000-8000-00000000b001';
SELECT pg_temp.rejected('{}','23505','foreign business contract blocks');
ROLLBACK TO SAVEPOINT foreign_contract;
SAVEPOINT another_checkout;
INSERT INTO public.subscription_checkout_sessions(business_id,plan_id,billing_cycle,amount,currency,external_reference,status)
VALUES ('10000000-0000-4000-8000-00000000a001','pro','monthly',25000,'ARS','trpcs_10000000-0000-4000-8000-00000000a006','failed');
SELECT pg_temp.rejected('{}','23505','any other business checkout requires new review');
ROLLBACK TO SAVEPOINT another_checkout;
SAVEPOINT existing_ledger;
INSERT INTO public.payments(business_id,provider,external_payment_id,type,amount,currency,status,raw_payload)
VALUES ('10000000-0000-4000-8000-00000000a001','mercadopago','other_invoice','recurring',15000,'ARS','pending','{}');
SELECT pg_temp.rejected('{}','23505','any existing MP ledger for business blocks');
ROLLBACK TO SAVEPOINT existing_ledger;
SAVEPOINT foreign_invoice;
INSERT INTO public.payments(business_id,provider,external_payment_id,type,amount,currency,status,raw_payload)
VALUES ('10000000-0000-4000-8000-00000000b001','mercadopago','fixture_invoice','recurring',15000,'ARS','approved',
  '{"authorized_payment_id":"fixture_invoice","payment_id":"other_payment","preapproval_id":"other_preapproval"}');
SELECT pg_temp.rejected('{}','23505','native invoice cannot move tenants');
ROLLBACK TO SAVEPOINT foreign_invoice;
SAVEPOINT foreign_payment;
INSERT INTO public.payments(business_id,provider,external_payment_id,type,amount,currency,status,raw_payload)
VALUES ('10000000-0000-4000-8000-00000000b001','mercadopago','other_invoice','recurring',15000,'ARS','approved',
  '{"authorized_payment_id":"other_invoice","payment_id":"fixture_payment","preapproval_id":"other_preapproval"}');
SELECT pg_temp.rejected('{}','23505','native payment cannot move invoices or tenants');
ROLLBACK TO SAVEPOINT foreign_payment;

CREATE FUNCTION pg_temp.fail_plan_a_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'synthetic write failure'; END $$;
SAVEPOINT ledger_failure;
CREATE TRIGGER plan_a_write_failure BEFORE INSERT ON public.payments
  FOR EACH ROW WHEN (NEW.external_payment_id='fixture_invoice') EXECUTE FUNCTION pg_temp.fail_plan_a_write();
SELECT pg_temp.rejected('{}','P0001','ledger failure leaves every other stage untouched');
ROLLBACK TO SAVEPOINT ledger_failure;
SAVEPOINT session_failure;
CREATE TRIGGER plan_a_write_failure BEFORE UPDATE ON public.subscription_checkout_sessions
  FOR EACH ROW WHEN (NEW.id='10000000-0000-4000-8000-00000000a005'::uuid AND NEW.status='paid') EXECUTE FUNCTION pg_temp.fail_plan_a_write();
SELECT pg_temp.rejected('{}','P0001','session failure rolls back inserted ledger');
ROLLBACK TO SAVEPOINT session_failure;
SAVEPOINT business_failure;
CREATE TRIGGER plan_a_write_failure BEFORE UPDATE ON public.businesses
  FOR EACH ROW WHEN (NEW.id='10000000-0000-4000-8000-00000000a001'::uuid AND NEW.subscription_status='active') EXECUTE FUNCTION pg_temp.fail_plan_a_write();
SELECT pg_temp.rejected('{}','P0001','business failure rolls back ledger and session binding');
ROLLBACK TO SAVEPOINT business_failure;
SAVEPOINT audit_failure;
CREATE FUNCTION pg_temp.fail_plan_a_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_type='plan_a_paid_case_recovered' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_a_audit_failure BEFORE INSERT ON public.subscription_events FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_plan_a_audit();
SELECT pg_temp.rejected('{}','P0001','audit failure rolls back ledger, session and business together');
ROLLBACK TO SAVEPOINT audit_failure;

SAVEPOINT trial_metadata;
UPDATE public.businesses SET access_source='trial',subscription_provider=NULL WHERE id='10000000-0000-4000-8000-00000000a001';
SELECT pg_temp.refresh_snapshots();
SELECT pg_temp.assert(pg_temp.invoke()->>'outcome'='applied','trial source and null provider are nonfinancial metadata');
ROLLBACK TO SAVEPOINT trial_metadata;
SELECT pg_temp.assert(pg_temp.invoke()->>'outcome'='applied','verified paid case applies atomically');
SELECT pg_temp.assert((SELECT count(*)=1 FROM public.payments WHERE business_id='10000000-0000-4000-8000-00000000a001'
  AND provider='mercadopago' AND status='approved' AND external_payment_id='fixture_invoice'
  AND raw_payload->>'payment_id'='fixture_payment'),'exactly one canonical ledger row');
SELECT pg_temp.assert((SELECT status='paid' AND mp_preapproval_id='fixture_preapproval' AND mp_preapproval_plan_id='fixture_plan'
  AND external_reference='trpcs_10000000-0000-4000-8000-00000000a005' AND created_at='2026-10-02T12:45:00Z'::timestamptz
  FROM public.subscription_checkout_sessions WHERE id='10000000-0000-4000-8000-00000000a005'),'session bound and history preserved');
SELECT pg_temp.assert((SELECT subscription_status='active' AND subscription_plan='basico' AND access_source='mercado_pago'
  AND mp_preapproval_id='fixture_preapproval' AND mp_preapproval_plan_id='fixture_plan' AND last_payment_id='fixture_payment'
  AND last_payment_status='approved' AND current_period_start='2026-10-02T13:00:00Z'::timestamptz
  AND current_period_end='2026-11-02T13:00:00Z'::timestamptz
  FROM public.businesses WHERE id='10000000-0000-4000-8000-00000000a001'),'access follows actual payment and provider period');
SELECT pg_temp.assert((SELECT count(*)=1 FROM public.subscription_events WHERE event_type='plan_a_paid_case_recovered'
  AND processed AND raw_payload->>'evidence_digest'=repeat('a',64) AND raw_payload->>'approval_ref'='synthetic-approval'
  AND raw_payload->>'operator_ref'='synthetic-operator'),'one durable approval and evidence audit');
\if :PLAN_A_COMMIT_CANDIDATE
-- The wrapper opts in ONLY for a named disposable clone, then restores production DDL.
COMMIT;
BEGIN;
SELECT pg_temp.assert((SELECT subscription_status='active' FROM public.businesses
  WHERE id='10000000-0000-4000-8000-00000000a001'),'candidate recovery survived a real commit');
\endif
SELECT pg_temp.assert(pg_temp.invoke()->>'outcome'='already_applied','identical retry is a no-op');
SELECT pg_temp.rejected(jsonb_build_object('p_evidence_digest',repeat('b',64)),'23505','same case with different evidence fails');
UPDATE public.businesses SET access_source='admin_override',subscription_status='suspended',override_reason='later administrative change'
  WHERE id='10000000-0000-4000-8000-00000000a001';
SELECT pg_temp.assert(pg_temp.invoke()->>'outcome'='already_applied','retry never regrants after administrative change');
SELECT pg_temp.assert((SELECT subscription_status='suspended' AND access_source='admin_override' FROM public.businesses
  WHERE id='10000000-0000-4000-8000-00000000a001'),'later access decision preserved');
SELECT pg_temp.assert((SELECT count(*)=1 FROM public.payments WHERE business_id='10000000-0000-4000-8000-00000000a001'), 'retry never duplicates ledger');
SELECT pg_temp.assert((SELECT count(*)=1 FROM public.subscription_events WHERE event_type='plan_a_paid_case_recovered'), 'retry never duplicates audit');
ROLLBACK;
