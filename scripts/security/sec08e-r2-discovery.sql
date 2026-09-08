-- SEC-08E R2 supplemental discovery. READ ONLY and aggregate-only: this file
-- never returns row values from public.users, profiles, or auth.users.
BEGIN TRANSACTION READ ONLY;

SELECT jsonb_build_object(
  'production_latest_migration', (SELECT max(version) FROM supabase_migrations.schema_migrations),
  'postgres_version', version(),
  'pgrst_role_settings', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'database', coalesce(d.datname, '*'), 'role', r.rolname, 'setting', setting
    ) ORDER BY coalesce(d.datname, '*'), r.rolname, setting)
    FROM pg_db_role_setting s
    LEFT JOIN pg_database d ON d.oid = s.setdatabase
    LEFT JOIN pg_roles r ON r.oid = s.setrole
    CROSS JOIN LATERAL unnest(s.setconfig) setting
    WHERE setting LIKE 'pgrst.%'
  ), '[]'::jsonb),
  'legacy_users_exists', to_regclass('public.users') IS NOT NULL,
  'legacy_users_rows', (SELECT count(*) FROM public.users),
  'legacy_users_columns', (
    SELECT jsonb_agg(jsonb_build_object('name', column_name, 'type', data_type) ORDER BY ordinal_position)
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users'
  ),
  'profiles_columns', (
    SELECT jsonb_agg(column_name ORDER BY ordinal_position)
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'profiles'
  ),
  'users_policies', (
    SELECT jsonb_agg(jsonb_build_object('name', policyname, 'roles', roles, 'command', cmd, 'using', qual))
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'users'
  ),
  'users_referencing_constraints', (
    SELECT jsonb_agg(jsonb_build_object('name', conname, 'definition', pg_get_constraintdef(oid)))
    FROM pg_constraint WHERE confrelid = 'public.users'::regclass
  ),
  'orders_with_legacy_technician', (SELECT count(*) FROM public.orders WHERE technician_id IS NOT NULL),
  'orders_with_profile', (SELECT count(*) FROM public.orders WHERE assigned_profile_id IS NOT NULL),
  'legacy_rows_without_profile_id', (
    SELECT count(*) FROM public.users u WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id)
  ),
  'database_functions_reading_users', coalesce((
    SELECT jsonb_agg(format('%I.%I', n.nspname, p.proname) ORDER BY n.nspname, p.proname)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'private') AND p.prokind = 'f'
      AND p.prosrc ~* '(public[.]users|join[[:space:]]+users|from[[:space:]]+users)'
  ), '[]'::jsonb),
  'database_views_reading_users', coalesce((
    SELECT jsonb_agg(format('%I.%I', schemaname, viewname) ORDER BY schemaname, viewname)
    FROM pg_views WHERE schemaname IN ('public', 'private')
      AND definition ~* '(public[.]users|join[[:space:]]+users|from[[:space:]]+users)'
  ), '[]'::jsonb),
  'anon_public_select_policies', coalesce((
    SELECT jsonb_agg(jsonb_build_object('table', tablename, 'policy', policyname, 'roles', roles, 'using', qual)
      ORDER BY tablename, policyname)
    FROM pg_policies WHERE schemaname = 'public' AND cmd = 'SELECT'
      AND ('anon' = ANY(roles) OR 'public' = ANY(roles))
  ), '[]'::jsonb)
) AS discovery;

ROLLBACK;
