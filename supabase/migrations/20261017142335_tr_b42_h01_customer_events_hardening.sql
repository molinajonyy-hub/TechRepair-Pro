-- TR-B42 / H01: customer_events is untrusted portal telemetry, not a sales ledger.
-- The only discovered client writer is trackEvent -> PortalCart.whatsapp_order.
-- No administrative or NULL-customer event writer exists in the repository.
-- No row, foreign key, event-type constraint, order or financial data changes.
BEGIN;

-- Fail closed on an unexpected administrative-read contract. Keep the exact
-- historical profiles.user_id predicate: no new capability, active flag or
-- COALESCE(user_id, id) authority is introduced by this security fix.
DO $preflight$
DECLARE
  v_admin record;
BEGIN
  SELECT p.polcmd, p.polpermissive, p.polroles,
         replace(lower(regexp_replace(pg_get_expr(p.polqual, p.polrelid),
           '["[:space:]()]', '', 'g')), 'public.', '') AS predicate
    INTO v_admin
    FROM pg_catalog.pg_policy p
   WHERE p.polrelid = 'public.customer_events'::regclass AND p.polname = 'ce_admin';
  IF NOT FOUND OR v_admin.polcmd NOT IN ('*', 'r') OR NOT v_admin.polpermissive
     OR v_admin.polroles <> ARRAY[0::oid]
     OR v_admin.predicate IS DISTINCT FROM
       'business_idinselectprofiles.business_idfromprofileswhereprofiles.user_id=auth.uid' THEN
    RAISE EXCEPTION 'H01 preflight: unexpected ce_admin read authority; review before applying';
  END IF;
END;
$preflight$;

ALTER TABLE public.customer_events ENABLE ROW LEVEL SECURITY;

-- Permissive policies are ORed. Remove every INSERT/ALL policy by catalog,
-- including unfamiliar names, rather than trusting only the ce_insert name.
-- Reapplication also replaces the SELECT-only ce_admin created below.
DO $policies$
DECLARE
  v_policy record;
BEGIN
  FOR v_policy IN
    SELECT polname FROM pg_catalog.pg_policy
     WHERE polrelid = 'public.customer_events'::regclass
       AND (polcmd IN ('a', '*') OR polname IN ('ce_insert', 'ce_admin'))
  LOOP
    EXECUTE format('DROP POLICY %I ON public.customer_events', v_policy.polname);
  END LOOP;
END;
$policies$;

CREATE POLICY ce_admin ON public.customer_events
  FOR SELECT TO PUBLIC
  USING (business_id IN (
    SELECT profiles.business_id FROM public.profiles
     WHERE profiles.user_id = auth.uid()
  ));

CREATE POLICY ce_insert ON public.customer_events
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND customer_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.wholesale_customers AS wc
       WHERE wc.id = customer_events.customer_id
         AND wc.business_id = customer_events.business_id
         AND wc.auth_user_id = auth.uid()
    )
  );

-- PUBLIC grants and column ACLs can also confer privileges. Remove both;
-- keep the existing authenticated SELECT + INSERT contract only.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.customer_events FROM PUBLIC, anon, authenticated;
DO $column_acl$
DECLARE
  v_column record;
BEGIN
  FOR v_column IN
    SELECT attname FROM pg_catalog.pg_attribute
     WHERE attrelid = 'public.customer_events'::regclass
       AND attnum > 0 AND NOT attisdropped
  LOOP
    EXECUTE format(
      'REVOKE INSERT (%1$I), UPDATE (%1$I), REFERENCES (%1$I) ON TABLE public.customer_events FROM PUBLIC, anon, authenticated',
      v_column.attname
    );
  END LOOP;
END;
$column_acl$;
GRANT SELECT, INSERT ON TABLE public.customer_events TO authenticated;

-- Catalog postconditions protect against policy OR bypasses, inherited grants
-- and column grants. Any failure rolls the entire migration back.
DO $postflight$
DECLARE
  v_authenticated oid := 'authenticated'::regrole;
  v_column record;
  v_role text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class
           WHERE oid = 'public.customer_events'::regclass) THEN
    RAISE EXCEPTION 'H01 postflight: customer_events RLS is disabled';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_policy
       WHERE polrelid = 'public.customer_events'::regclass AND polcmd IN ('a', '*')) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy
        WHERE polrelid = 'public.customer_events'::regclass
          AND polname = 'ce_insert' AND polcmd = 'a' AND polpermissive
          AND polroles = ARRAY[v_authenticated] AND polwithcheck IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'H01 postflight: customer_events must have exactly one authenticated INSERT policy and no ALL policy';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy
     WHERE polrelid = 'public.customer_events'::regclass
       AND polname = 'ce_admin' AND polcmd = 'r' AND polpermissive
       AND polroles = ARRAY[0::oid] AND polwithcheck IS NULL
  ) OR NOT has_table_privilege('authenticated', 'public.customer_events', 'SELECT')
    OR NOT has_table_privilege('authenticated', 'public.customer_events', 'INSERT') THEN
    RAISE EXCEPTION 'H01 postflight: administrative SELECT or authenticated telemetry access changed';
  END IF;
  IF has_table_privilege('anon', 'public.customer_events', 'INSERT') THEN
    RAISE EXCEPTION 'H01 postflight: anon inherited customer_events INSERT';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(v_role, 'public.customer_events', 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION 'H01 postflight: % has unexpected customer_events mutation privileges', v_role;
    END IF;
    FOR v_column IN
      SELECT attname FROM pg_catalog.pg_attribute
       WHERE attrelid = 'public.customer_events'::regclass
         AND attnum > 0 AND NOT attisdropped
    LOOP
      IF (v_role = 'anon' AND has_column_privilege(v_role, 'public.customer_events', v_column.attname, 'INSERT'))
         OR has_column_privilege(v_role, 'public.customer_events', v_column.attname, 'UPDATE,REFERENCES') THEN
        RAISE EXCEPTION 'H01 postflight: % has unexpected customer_events.% column privileges', v_role, v_column.attname;
      END IF;
    END LOOP;
  END LOOP;
END;
$postflight$;

COMMIT;
