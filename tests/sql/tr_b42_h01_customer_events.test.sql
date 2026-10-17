-- TR-B42 / H01. Local/isolated QA only; synthetic fixtures, real API roles.
-- Run with psql -X -v ON_ERROR_STOP=1. Everything, including negative
-- controls and temporary policy/privilege mutations, ends in ROLLBACK.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL client_min_messages = notice;

CREATE OR REPLACE FUNCTION pg_temp.h01_assert(p_ok boolean, p_label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'H01 FAIL: %', p_label; END IF;
  RAISE NOTICE 'H01 PASS: %', p_label;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.h01_catalog()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_role text; v_col record;
BEGIN
  PERFORM pg_temp.h01_assert(
    (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.customer_events'::regclass),
    'RLS enabled');
  PERFORM pg_temp.h01_assert(
    (SELECT count(*) = 1 FROM pg_catalog.pg_policy
      WHERE polrelid = 'public.customer_events'::regclass AND polcmd IN ('a', '*'))
    AND EXISTS (SELECT 1 FROM pg_catalog.pg_policy
      WHERE polrelid = 'public.customer_events'::regclass AND polname = 'ce_insert'
        AND polcmd = 'a' AND polpermissive AND polroles = ARRAY['authenticated'::regrole::oid]
        AND polwithcheck IS NOT NULL),
    'exactly one authenticated INSERT policy, no alternative INSERT or ALL');
  PERFORM pg_temp.h01_assert(
    EXISTS (SELECT 1 FROM pg_catalog.pg_policy
      WHERE polrelid = 'public.customer_events'::regclass AND polname = 'ce_admin'
        AND polcmd = 'r' AND polpermissive AND polroles = ARRAY[0::oid]
        AND polwithcheck IS NULL
        AND replace(lower(regexp_replace(pg_get_expr(polqual, polrelid),
          '["[:space:]()]', '', 'g')), 'public.', '') =
          'business_idinselectprofiles.business_idfromprofileswhereprofiles.user_id=auth.uid'),
    'ce_admin is SELECT with the exact historical profiles.user_id authority');
  PERFORM pg_temp.h01_assert(
    has_table_privilege('authenticated', 'public.customer_events', 'SELECT')
    AND has_table_privilege('authenticated', 'public.customer_events', 'INSERT')
    AND has_table_privilege('authenticated', 'public.wholesale_customers', 'SELECT'),
    'authenticated SELECT/INSERT and invoker ownership lookup privileges preserved');
  PERFORM pg_temp.h01_assert(
    NOT has_table_privilege('anon', 'public.customer_events', 'INSERT'),
    'anon has no table INSERT, including inherited/PUBLIC privileges');
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    PERFORM pg_temp.h01_assert(
      NOT has_table_privilege(v_role, 'public.customer_events', 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
      v_role || ' has no extra table mutation privilege');
    FOR v_col IN SELECT attname FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.customer_events'::regclass AND attnum > 0 AND NOT attisdropped
    LOOP
      PERFORM pg_temp.h01_assert(
        NOT has_column_privilege(v_role, 'public.customer_events', v_col.attname, 'UPDATE,REFERENCES')
        AND (v_role <> 'anon' OR NOT has_column_privilege(v_role, 'public.customer_events', v_col.attname, 'INSERT')),
        v_role || ' has no unexpected column grant on ' || v_col.attname);
    END LOOP;
  END LOOP;
END;
$$;

-- No SECURITY DEFINER test helper: postgres explicitly assumes the real
-- anon/authenticated role before executing each API statement.
CREATE OR REPLACE FUNCTION pg_temp.h01_as(p_role text, p_actor uuid, p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_state text;
BEGIN
  IF p_role NOT IN ('anon', 'authenticated') THEN RAISE EXCEPTION 'invalid test role'; END IF;
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_actor::text, ''), true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', p_actor, 'role', p_role)::text, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql;
    v_state := 'OK';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE;
  END;
  RESET ROLE;
  RETURN v_state;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.h01_value(p_actor uuid, p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_value text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_actor::text, ''), true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', p_actor, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    EXECUTE p_sql INTO v_value;
  EXCEPTION WHEN OTHERS THEN v_value := 'ERROR ' || SQLSTATE;
  END;
  RESET ROLE;
  RETURN v_value;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.h01_expect(p_role text, p_actor uuid, p_sql text, p_state text, p_label text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_state text := pg_temp.h01_as(p_role, p_actor, p_sql);
BEGIN
  PERFORM pg_temp.h01_assert(v_state = p_state, p_label || ' (expected ' || p_state || ', got ' || v_state || ')');
END;
$$;

-- This runs before fixtures/negative controls: a later migration that restores
-- permissive INSERT/ALL, broad grants or disables RLS must fail the suite.
SELECT pg_temp.h01_catalog();

CREATE TEMP TABLE h01_ids(k text PRIMARY KEY, v uuid NOT NULL) ON COMMIT DROP;
INSERT INTO h01_ids(k, v)
  SELECT k, gen_random_uuid() FROM unnest(ARRAY[
    'business_a','business_b','staff_a','staff_b','staff_legacy_a',
    'actor_a','actor_b','actor_without_customer','customer_a','customer_b',
    'customer_same_business_other','event_a','historical_null','missing_customer'
  ]) AS k;
CREATE OR REPLACE FUNCTION pg_temp.h01_id(p_key text)
RETURNS uuid LANGUAGE sql AS $$ SELECT v FROM h01_ids WHERE k = p_key $$;

-- Isolate fixture creation from unrelated provisioning/business triggers.
-- All RLS, FK/check constraints and normal triggers are restored for API tests.
SET LOCAL session_replication_role = 'replica';
INSERT INTO auth.users(id, email)
  SELECT v, 'h01-' || v::text || '@example.invalid' FROM h01_ids
   WHERE k IN ('staff_a','staff_b','staff_legacy_a','actor_a','actor_b','actor_without_customer');
INSERT INTO public.businesses(id, name, owner_user_id, subscription_plan, subscription_status,
                              wholesale_portal_enabled, wholesale_portal_slug)
VALUES
  (pg_temp.h01_id('business_a'), 'H01 synthetic A', pg_temp.h01_id('staff_a'), 'pro', 'active', true,
   'h01-a-' || pg_temp.h01_id('business_a')::text),
  (pg_temp.h01_id('business_b'), 'H01 synthetic B', pg_temp.h01_id('staff_b'), 'pro', 'active', true,
   'h01-b-' || pg_temp.h01_id('business_b')::text);
INSERT INTO public.profiles(id, user_id, business_id, role, is_active)
VALUES
  (pg_temp.h01_id('staff_a'), pg_temp.h01_id('staff_a'), pg_temp.h01_id('business_a'), 'owner', true),
  (pg_temp.h01_id('staff_b'), pg_temp.h01_id('staff_b'), pg_temp.h01_id('business_b'), 'owner', true),
  (pg_temp.h01_id('staff_legacy_a'), NULL, pg_temp.h01_id('business_a'), 'viewer', true);
INSERT INTO public.wholesale_customers(id, business_id, auth_user_id, name, email, approved)
VALUES
  (pg_temp.h01_id('customer_a'), pg_temp.h01_id('business_a'), pg_temp.h01_id('actor_a'), 'H01 A', 'h01-a@example.invalid', true),
  (pg_temp.h01_id('customer_b'), pg_temp.h01_id('business_b'), pg_temp.h01_id('actor_b'), 'H01 B', 'h01-b@example.invalid', true),
  (pg_temp.h01_id('customer_same_business_other'), pg_temp.h01_id('business_a'), pg_temp.h01_id('actor_b'), 'H01 other A', 'h01-other-a@example.invalid', true);
INSERT INTO public.customer_events(id, business_id, customer_id, event_type)
VALUES (pg_temp.h01_id('historical_null'), pg_temp.h01_id('business_a'), NULL, 'login');
SET LOCAL session_replication_role = 'origin';

-- Reproduce the exact historical defect in a savepoint, then restore the
-- candidate policies. No unsafe policy or cross-tenant event survives.
SAVEPOINT historical_defect;
DROP POLICY ce_insert ON public.customer_events;
DROP POLICY ce_admin ON public.customer_events;
CREATE POLICY ce_admin ON public.customer_events USING (business_id IN (
  SELECT profiles.business_id FROM public.profiles WHERE profiles.user_id = auth.uid()
));
CREATE POLICY ce_insert ON public.customer_events FOR INSERT WITH CHECK (true);
SELECT pg_temp.h01_expect('authenticated', pg_temp.h01_id('actor_a'), format(
  'INSERT INTO public.customer_events(business_id, customer_id, event_type) VALUES (%L, %L, %L)',
  pg_temp.h01_id('business_b'), pg_temp.h01_id('customer_a'), 'whatsapp_order'), 'OK',
  'historical negative control: A could attribute its customer event to business B');
ROLLBACK TO SAVEPOINT historical_defect;
RELEASE SAVEPOINT historical_defect;

DO $matrix$
DECLARE
  v_a uuid := pg_temp.h01_id('actor_a');
  v_b uuid := pg_temp.h01_id('business_a');
  v_other uuid := pg_temp.h01_id('business_b');
  v_customer uuid := pg_temp.h01_id('customer_a');
  v_insert text := 'INSERT INTO public.customer_events(business_id, customer_id, event_type) VALUES (%L, %L, %L)';
  v_type text;
BEGIN
  PERFORM pg_temp.h01_expect('authenticated', v_a, format(
    'INSERT INTO public.customer_events(id, business_id, customer_id, event_type, metadata) VALUES (%L, %L, %L, %L, %L::jsonb)',
    pg_temp.h01_id('event_a'), v_b, v_customer, 'whatsapp_order', '{"synthetic":true}'), 'OK',
    'client A inserts its own whatsapp_order in A');
  PERFORM pg_temp.h01_expect('authenticated', v_a, format(v_insert, v_other, v_customer, 'whatsapp_order'), '42501',
    'A cannot attribute its customer event to business B (historical defect fixed)');
  PERFORM pg_temp.h01_expect('authenticated', v_a, format(v_insert, v_b, pg_temp.h01_id('customer_b'), 'login'), '42501',
    'A cannot use customer B while declaring business A');
  PERFORM pg_temp.h01_expect('authenticated', v_a, format(v_insert, v_other, pg_temp.h01_id('customer_b'), 'login'), '42501',
    'A cannot impersonate the consistent customer B/business B pair');
  PERFORM pg_temp.h01_expect('authenticated', v_a, format(v_insert, v_b, pg_temp.h01_id('customer_same_business_other'), 'login'), '42501',
    'A cannot impersonate another customer within business A');
  PERFORM pg_temp.h01_expect('authenticated', v_a, format(v_insert, v_b, pg_temp.h01_id('missing_customer'), 'login'), '42501',
    'nonexistent customer rejected by RLS before FK validation');
  PERFORM pg_temp.h01_expect('authenticated', v_a, format(v_insert, v_b, NULL, 'login'), '42501',
    'NULL customer rejected');
  PERFORM pg_temp.h01_expect('authenticated', pg_temp.h01_id('actor_without_customer'),
    format(v_insert, v_b, v_customer, 'login'), '42501', 'authenticated actor without wholesale customer rejected');
  PERFORM pg_temp.h01_expect('authenticated', NULL, format(v_insert, v_b, v_customer, 'login'), '42501',
    'authenticated session without auth.uid rejected');
  PERFORM pg_temp.h01_expect('anon', NULL, format(v_insert, v_b, v_customer, 'login'), '42501',
    'anon INSERT denied by privileges');
  PERFORM pg_temp.h01_assert(
    pg_temp.h01_value(pg_temp.h01_id('staff_a'), format('SELECT count(*)::text FROM public.customer_events WHERE id = %L', pg_temp.h01_id('event_a'))) = '1',
    'authorized staff A reads event A');
  PERFORM pg_temp.h01_assert(
    pg_temp.h01_value(pg_temp.h01_id('staff_b'), format('SELECT count(*)::text FROM public.customer_events WHERE id = %L', pg_temp.h01_id('event_a'))) = '0',
    'staff B sees no event A');
  PERFORM pg_temp.h01_assert(
    pg_temp.h01_value(v_a, format('SELECT count(*)::text FROM public.customer_events WHERE business_id = %L', v_b)) = '0',
    'wholesale customer cannot read administrative event records');
  PERFORM pg_temp.h01_assert(
    pg_temp.h01_value(pg_temp.h01_id('staff_a'), format('SELECT count(*)::text FROM public.customer_events WHERE id = %L', pg_temp.h01_id('historical_null'))) = '1',
    'administrative reads preserve historical NULL-customer rows');
  PERFORM pg_temp.h01_assert(
    pg_temp.h01_value(pg_temp.h01_id('staff_legacy_a'), format('SELECT count(*)::text FROM public.customer_events WHERE business_id = %L', v_b)) = '0',
    'historical ce_admin authority is preserved, not expanded to profiles.id');
  PERFORM pg_temp.h01_expect('authenticated', pg_temp.h01_id('staff_a'), format(v_insert, v_b, v_customer, 'login'), '42501',
    'administrative SELECT does not indirectly authorize INSERT');
  PERFORM pg_temp.h01_expect('authenticated', pg_temp.h01_id('staff_a'), format(
    'UPDATE public.customer_events SET event_type = %L WHERE id = %L', 'login', pg_temp.h01_id('event_a')), '42501',
    'authenticated UPDATE denied by privileges even for staff');
  PERFORM pg_temp.h01_expect('authenticated', pg_temp.h01_id('staff_a'), format(
    'DELETE FROM public.customer_events WHERE id = %L', pg_temp.h01_id('event_a')), '42501',
    'authenticated DELETE denied by privileges even for staff');
  FOREACH v_type IN ARRAY ARRAY['login','product_view','add_to_cart','abandoned_cart','whatsapp_order','purchase_completed','register'] LOOP
    PERFORM pg_temp.h01_expect('authenticated', v_a, format(v_insert, v_b, v_customer, v_type), 'OK',
      'existing allowed event type preserved: ' || v_type);
  END LOOP;
  PERFORM pg_temp.h01_expect('authenticated', v_a, format(v_insert, v_b, v_customer, 'h01_not_a_valid_type'), '23514',
    'unsupported event type rejected by existing CHECK constraint');
END;
$matrix$;

-- Negative self-tests prove catalog checks catch future unknown policy names,
-- PUBLIC/column grants, and disabled RLS. These mutations all roll back.
CREATE OR REPLACE FUNCTION pg_temp.h01_catalog_rejects()
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.h01_catalog();
  RETURN false;
EXCEPTION WHEN raise_exception THEN RETURN true;
END;
$$;
SAVEPOINT later_insert;
CREATE POLICY h01_future_insert ON public.customer_events FOR INSERT TO authenticated WITH CHECK (true);
SELECT pg_temp.h01_assert(pg_temp.h01_catalog_rejects(), 'negative self-test: later permissive INSERT detected');
ROLLBACK TO SAVEPOINT later_insert;
RELEASE SAVEPOINT later_insert;

SAVEPOINT later_all;
CREATE POLICY h01_future_all ON public.customer_events FOR ALL TO authenticated USING (true) WITH CHECK (true);
SELECT pg_temp.h01_assert(pg_temp.h01_catalog_rejects(), 'negative self-test: later FOR ALL detected');
ROLLBACK TO SAVEPOINT later_all;
RELEASE SAVEPOINT later_all;

SAVEPOINT public_grant;
GRANT INSERT ON public.customer_events TO PUBLIC;
SELECT pg_temp.h01_assert(pg_temp.h01_catalog_rejects(), 'negative self-test: PUBLIC INSERT grant detected');
ROLLBACK TO SAVEPOINT public_grant;
RELEASE SAVEPOINT public_grant;

SAVEPOINT column_grant;
GRANT INSERT (event_type) ON public.customer_events TO anon;
SELECT pg_temp.h01_assert(pg_temp.h01_catalog_rejects(), 'negative self-test: anon column INSERT grant detected');
ROLLBACK TO SAVEPOINT column_grant;
RELEASE SAVEPOINT column_grant;

SAVEPOINT disabled_rls;
ALTER TABLE public.customer_events DISABLE ROW LEVEL SECURITY;
SELECT pg_temp.h01_assert(pg_temp.h01_catalog_rejects(), 'negative self-test: RLS disable detected');
ROLLBACK TO SAVEPOINT disabled_rls;
RELEASE SAVEPOINT disabled_rls;

SELECT pg_temp.h01_catalog();
ROLLBACK;
