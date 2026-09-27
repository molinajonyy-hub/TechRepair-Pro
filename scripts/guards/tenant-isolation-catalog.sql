-- ============================================================================
-- Guard global de aislamiento de tenants — snapshot de catalogo (READ-ONLY).
--
-- Una sola consulta SELECT: no escribe, no toma locks de escritura, no lee
-- filas de datos. La usa scripts/guards/tenant-isolation.mjs contra la base
-- local (y sirve igual para un snapshot read-only de produccion).
--
-- Devuelve un JSON con, por cada tabla de `public` (r/p/f):
--   · rls / force_rls / has_business_id / fk_cols
--   · acceso efectivo de anon y authenticated (tabla o columna; incluye
--     herencia de roles: has_*_privilege)
--   · policies: comando, permissive, roles, USING, WITH CHECK, las columnas
--     PROPIAS que referencian y las funciones que llaman (ambas de pg_depend,
--     no de parsear texto).
-- Y el contrato PRE-BETA-1 de public.users (anon/authenticated/service_role).
-- ============================================================================
SELECT json_build_object(
  'tables', coalesce((
    SELECT json_agg(t ORDER BY t.name)
    FROM (
      SELECT
        c.relname AS name,
        c.relrowsecurity AS rls,
        c.relforcerowsecurity AS force_rls,
        EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'business_id' AND NOT a.attisdropped) AS has_business_id,
        coalesce((
          SELECT json_agg(DISTINCT a.attname)
          FROM pg_constraint k, unnest(k.conkey) AS col(n), pg_attribute a
          WHERE k.conrelid = c.oid AND k.contype = 'f' AND a.attrelid = c.oid AND a.attnum = col.n
        ), '[]'::json) AS fk_cols,
        (SELECT json_object_agg(r, json_build_object(
            'S', has_table_privilege(r, c.oid, 'SELECT') OR has_any_column_privilege(r, c.oid, 'SELECT'),
            'I', has_table_privilege(r, c.oid, 'INSERT') OR has_any_column_privilege(r, c.oid, 'INSERT'),
            'U', has_table_privilege(r, c.oid, 'UPDATE') OR has_any_column_privilege(r, c.oid, 'UPDATE'),
            'D', has_table_privilege(r, c.oid, 'DELETE')))
         FROM unnest(ARRAY['anon', 'authenticated']) AS r) AS access,
        coalesce((
          SELECT json_agg(json_build_object(
            'name', p.polname,
            'cmd', p.polcmd::text,
            'permissive', p.polpermissive,
            'roles', (SELECT json_agg(CASE WHEN x = 0 THEN 'public' ELSE pg_get_userbyid(x)::text END) FROM unnest(p.polroles) AS x),
            'using', pg_get_expr(p.polqual, p.polrelid),
            'check', pg_get_expr(p.polwithcheck, p.polrelid),
            'own_cols', coalesce((
              SELECT json_agg(DISTINCT a.attname)
              FROM pg_depend d JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
              WHERE d.classid = 'pg_policy'::regclass AND d.objid = p.oid
                AND d.refclassid = 'pg_class'::regclass AND d.refobjid = p.polrelid AND d.refobjsubid > 0
            ), '[]'::json),
            'functions', coalesce((
              SELECT json_agg(DISTINCT n2.nspname || '.' || f.proname)
              FROM pg_depend d JOIN pg_proc f ON f.oid = d.refobjid JOIN pg_namespace n2 ON n2.oid = f.pronamespace
              WHERE d.classid = 'pg_policy'::regclass AND d.objid = p.oid AND d.refclassid = 'pg_proc'::regclass
            ), '[]'::json)
          ) ORDER BY p.polname)
          FROM pg_policy p WHERE p.polrelid = c.oid
        ), '[]'::json) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'f')
    ) AS t
  ), '[]'::json),
  'legacy_users', (
    SELECT json_build_object(
      'exists', true,
      'policies', (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid),
      'grantees', coalesce((SELECT json_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END)
                             FROM aclexplode(c.relacl) a WHERE a.grantee <> c.relowner), '[]'::json),
      'column_acl', EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL),
      'access', (SELECT json_object_agg(r,
                   has_table_privilege(r, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                   OR has_any_column_privilege(r, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES'))
                 FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r))
    FROM pg_class c WHERE c.oid = to_regclass('public.users')
  )
)::jsonb AS catalog;  -- jsonb: una sola linea canonica
