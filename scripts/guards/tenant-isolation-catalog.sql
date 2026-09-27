-- ============================================================================
-- Guard global de aislamiento de tenants — snapshot de catalogo (READ-ONLY).
--
-- Una sola consulta SELECT: no escribe, no toma locks de escritura, no lee
-- filas de datos. La usa scripts/guards/tenant-isolation.mjs contra la base
-- local (y sirve igual para un snapshot read-only de produccion).
--
-- Devuelve un JSON con, por cada tabla de `public` (r/p/f):
--   · rls / force_rls / has_business_id / fk_cols / fk_refs (columna -> tabla
--     referenciada, FKs de una columna) / business_id_write (INSERT/UPDATE de
--     la columna business_id para anon y authenticated)
--   · acceso efectivo de anon y authenticated (tabla o columna; incluye
--     herencia de roles: has_*_privilege)
--   · policies: comando, permissive, roles, USING, WITH CHECK, las columnas
--     PROPIAS que referencian y las funciones que llaman (ambas de pg_depend,
--     no de parsear texto).
-- Y el contrato PRE-BETA-1 de public.users (anon/authenticated/service_role).
-- Y `helpers`: la huella (md5 de cuerpo normalizado + SECURITY DEFINER +
-- proconfig) de los helpers de identidad/tenant REVISADOS (la allowlist de
-- scripts/guards/tenant-isolation.mjs) y de las funciones de las que dependen
-- para su autoridad. Si un helper cambia, el guard falla hasta re-revisarlo.
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
        coalesce((
          SELECT json_object_agg(a.attname, r.relname)
          FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.conkey[1]
               JOIN pg_class r ON r.oid = k.confrelid
          WHERE k.conrelid = c.oid AND k.contype = 'f' AND cardinality(k.conkey) = 1
        ), '{}'::json) AS fk_refs,
        -- Quien puede ESCRIBIR business_id (verifica autoridades declaradas en la
        -- allowlist de policies, p. ej. "business_id no es actualizable").
        CASE WHEN EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'business_id' AND NOT a.attisdropped)
          THEN (SELECT json_object_agg(r, json_build_object(
                  'I', has_column_privilege(r, c.oid, 'business_id', 'INSERT'),
                  'U', has_column_privilege(r, c.oid, 'business_id', 'UPDATE')))
                FROM unnest(ARRAY['anon', 'authenticated']) AS r)
        END AS business_id_write,
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
  ),
  'helpers', (
    SELECT json_object_agg(sig, (
      SELECT md5(replace(p.prosrc, E'\r', '') || '|' || p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), ''))
      FROM pg_proc p WHERE p.oid = to_regprocedure(sig)))
    FROM unnest(ARRAY[
      'public.current_business_id()',
      'public.current_user_business_id()',
      'public.user_business_ids()',
      'public.current_user_can_in_business(uuid,text)',
      'public.can_view_inventory_cost(uuid)',
      'public.can_view_supplier_finance(uuid)',
      'public.can_view_payment_allocations(uuid)',
      'public.user_can_view_order_amounts(uuid,uuid)'
    ]) AS sig
  )
)::jsonb AS catalog;  -- jsonb: una sola linea canonica
