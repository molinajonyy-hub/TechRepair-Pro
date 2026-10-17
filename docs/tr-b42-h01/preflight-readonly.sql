-- TR-B42 / H01. Catalog inspection only. Never applies the migration.
-- Run only against an explicitly selected, authorized target; this task has
-- authorization for local/isolated QA only. Output contains catalog definitions
-- and aggregate counts, never customer identities or event metadata.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

-- 1. Review every gate. A false value means STOP and investigate the drift.
WITH admin_policy AS (
  SELECT polcmd, polpermissive, polroles,
         replace(lower(regexp_replace(pg_get_expr(polqual, polrelid),
           '["[:space:]()]', '', 'g')), 'public.', '') AS predicate
    FROM pg_catalog.pg_policy
   WHERE polrelid = 'public.customer_events'::regclass AND polname = 'ce_admin'
), gates(gate, ok) AS (
  SELECT 'customer_events has RLS enabled',
    (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.customer_events'::regclass)
  UNION ALL
  SELECT 'ce_admin exact historical read authority, PUBLIC, permissive, ALL or SELECT',
    EXISTS (SELECT 1 FROM admin_policy WHERE polcmd IN ('*', 'r') AND polpermissive
      AND polroles = ARRAY[0::oid]
      AND predicate = 'business_idinselectprofiles.business_idfromprofileswhereprofiles.user_id=auth.uid')
  UNION ALL
  SELECT 'anon and authenticated are neither superusers nor BYPASSRLS roles',
    (SELECT count(*) = 2 AND bool_and(NOT rolsuper AND NOT rolbypassrls)
       FROM pg_catalog.pg_roles WHERE rolname IN ('anon', 'authenticated'))
  UNION ALL
  SELECT 'anon has no effective table or column INSERT',
    NOT has_table_privilege('anon', 'public.customer_events', 'INSERT')
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.customer_events'::regclass AND attnum > 0 AND NOT attisdropped
        AND has_column_privilege('anon', 'public.customer_events', attname, 'INSERT'))
  UNION ALL
  SELECT 'authenticated keeps SELECT and INSERT on customer_events',
    has_table_privilege('authenticated', 'public.customer_events', 'SELECT')
    AND has_table_privilege('authenticated', 'public.customer_events', 'INSERT')
  UNION ALL
  SELECT 'authenticated can SELECT wholesale_customers for the invoker lookup',
    has_table_privilege('authenticated', 'public.wholesale_customers', 'SELECT')
  UNION ALL
  SELECT 'wholesale_customers RLS and own-read policy preserved',
    (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.wholesale_customers'::regclass)
    AND EXISTS (SELECT 1 FROM pg_catalog.pg_policy
      WHERE polrelid = 'public.wholesale_customers'::regclass AND polname = 'wc_own_read'
        AND polcmd = 'r' AND polpermissive
        AND (0::oid = ANY(polroles) OR 'authenticated'::regrole::oid = ANY(polroles))
        AND replace(lower(regexp_replace(pg_get_expr(polqual, polrelid),
          '["[:space:]()]', '', 'g')), 'public.', '') = 'auth_user_id=auth.uid')
  UNION ALL
  SELECT 'no customer_events user-defined trigger requiring separate discovery',
    NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid = 'public.customer_events'::regclass AND NOT tgisinternal)
  UNION ALL
  SELECT 'no unknown INSERT or ALL policy beyond the reviewed ce_insert/ce_admin',
    NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy
      WHERE polrelid = 'public.customer_events'::regclass AND polcmd IN ('a', '*')
        AND polname NOT IN ('ce_insert', 'ce_admin'))
)
SELECT gate, COALESCE(ok, false) AS ok FROM gates ORDER BY gate;

-- 2. Full policy definitions, commands and role applicability on dependencies.
SELECT n.nspname AS schema_name, c.relname AS table_name, p.polname AS policy_name,
       CASE p.polcmd WHEN '*' THEN 'ALL' WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
         WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' END AS command,
       p.polpermissive AS permissive,
       ARRAY(SELECT CASE WHEN x = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x) END
               FROM unnest(p.polroles) AS x) AS roles,
       pg_get_expr(p.polqual, p.polrelid) AS using_expression,
       pg_get_expr(p.polwithcheck, p.polrelid) AS check_expression
  FROM pg_catalog.pg_policy p
  JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname IN ('customer_events', 'wholesale_customers', 'profiles')
 ORDER BY c.relname, p.polname;

-- 3. Owner/RLS flags and explicit ACL entries, including PUBLIC and columns.
SELECT c.relname AS table_name, pg_get_userbyid(c.relowner) AS owner,
       c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS force_rls
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname IN ('customer_events', 'wholesale_customers', 'profiles')
 ORDER BY c.relname;
SELECT c.relname AS table_name, NULL::text AS column_name,
       CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
       pg_get_userbyid(a.grantor) AS grantor, a.privilege_type, a.is_grantable
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
 WHERE n.nspname = 'public' AND c.relname IN ('customer_events', 'wholesale_customers', 'profiles')
UNION ALL
SELECT c.relname, att.attname,
       CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
       pg_get_userbyid(a.grantor), a.privilege_type, a.is_grantable
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_attribute att ON att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped
  CROSS JOIN LATERAL aclexplode(att.attacl) a
 WHERE n.nspname = 'public' AND c.relname IN ('customer_events', 'wholesale_customers', 'profiles')
 ORDER BY table_name, column_name NULLS FIRST, grantee, privilege_type;

-- Effective privileges include inherited/PUBLIC grants, unlike explicit ACLs.
SELECT r.rolname AS role_name, t.table_name, p.privilege,
       has_table_privilege(r.oid, 'public.' || t.table_name, p.privilege) AS effective
  FROM pg_catalog.pg_roles r
  CROSS JOIN (VALUES ('customer_events'), ('wholesale_customers'), ('profiles')) t(table_name)
  CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(privilege)
 WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
 ORDER BY r.rolname, t.table_name, p.privilege;
SELECT r.rolname AS role_name, c.relname AS table_name, att.attname AS column_name,
       p.privilege, has_column_privilege(r.oid, c.oid, att.attnum, p.privilege) AS effective
  FROM pg_catalog.pg_roles r
  CROSS JOIN pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_attribute att ON att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped
  CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) p(privilege)
 WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
   AND n.nspname = 'public' AND c.relname IN ('customer_events', 'wholesale_customers', 'profiles')
 ORDER BY r.rolname, c.relname, att.attnum, p.privilege;

-- Membership and BYPASSRLS are shown separately: bypass does not itself grant
-- table access. USAGE models privileges inherited without SET ROLE.
SELECT r.rolname AS api_role, parent.rolname AS inherited_role,
       parent.rolsuper, parent.rolbypassrls,
       pg_has_role(r.oid, parent.oid, 'USAGE') AS effective_without_set_role
  FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_roles parent
 WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
   AND (r.oid = parent.oid OR pg_has_role(r.oid, parent.oid, 'MEMBER'))
 ORDER BY r.rolname, parent.rolname;

-- 4. Triggers and constraints are definitions only; no row data is disclosed.
SELECT tgname, tgisinternal, pg_get_triggerdef(oid) AS definition
  FROM pg_catalog.pg_trigger WHERE tgrelid = 'public.customer_events'::regclass
 ORDER BY tgname;
SELECT conname, contype, pg_get_constraintdef(oid) AS definition
  FROM pg_catalog.pg_constraint WHERE conrelid = 'public.customer_events'::regclass
 ORDER BY conname;

-- 5. Counts only. Historical NULLs and tenant mismatches must be investigated,
-- never rewritten or deleted by H01. Existence of consumers outside this
-- checkout cannot be inferred from these counts or the repository discovery.
SELECT count(*) AS total_events,
       count(*) FILTER (WHERE ce.customer_id IS NULL) AS null_customer_events,
       count(*) FILTER (WHERE ce.customer_id IS NOT NULL AND wc.id IS NULL) AS missing_customer_events,
       count(*) FILTER (WHERE wc.id IS NOT NULL AND ce.business_id <> wc.business_id) AS cross_business_events
  FROM public.customer_events ce LEFT JOIN public.wholesale_customers wc ON wc.id = ce.customer_id;

ROLLBACK;
