BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
SELECT jsonb_build_object(
  'captured_at', now(),
  'database', current_database(),
  'functions', (
    SELECT jsonb_agg(jsonb_build_object(
      'schema', n.nspname,
      'name', p.proname,
      'identity_arguments', pg_get_function_identity_arguments(p.oid),
      'signature', p.oid::regprocedure::text,
      'return_type', pg_get_function_result(p.oid),
      'owner', r.rolname,
      'security_definer', p.prosecdef,
      'proconfig', p.proconfig,
      'proacl', p.proacl::text,
      'execute_acl', (SELECT jsonb_agg(jsonb_build_object('grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, 'grantor', pg_get_userbyid(a.grantor), 'grantable', a.is_grantable)) FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.privilege_type = 'EXECUTE'),
      'public_execute', EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'),
      'anon_execute', has_function_privilege('anon', p.oid, 'EXECUTE'),
      'authenticated_execute', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
      'service_role_execute', has_function_privilege('service_role', p.oid, 'EXECUTE'),
      'anon_schema_usage', has_schema_privilege('anon', n.oid, 'USAGE'),
      'authenticated_schema_usage', has_schema_privilege('authenticated', n.oid, 'USAGE'),
      'definition', pg_get_functiondef(p.oid),
      'triggers', (SELECT jsonb_agg(jsonb_build_object('table', t.tgrelid::regclass::text, 'name', t.tgname, 'enabled', t.tgenabled)) FROM pg_trigger t WHERE t.tgfoid = p.oid AND NOT t.tgisinternal)
    ) ORDER BY n.nspname, p.proname, p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner
    WHERE n.nspname IN ('public', 'private') AND p.prokind = 'f'
  ),
  'migrations', (SELECT jsonb_agg(jsonb_build_object('version', version, 'name', name) ORDER BY version) FROM supabase_migrations.schema_migrations)
) AS catalog;
ROLLBACK;
