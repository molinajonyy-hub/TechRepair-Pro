-- ============================================================================
-- ARCA SELF-SERVICE · PHASE 0 — PREFLIGHT de producción (SOLO LECTURA)
--
-- Sin DML, sin DDL, sin secretos: catálogo y conteos. Confirma que todo lo que
-- 20260928120000 asume existe, y registra la huella del estado previo para la
-- verificación post-deploy y el rollback.
--   supabase db query --linked --file docs/arca-selfservice-phase0/preflight-readonly.sql
-- ============================================================================
SELECT json_build_object(
  'latest_migration', (SELECT max(version) FROM supabase_migrations.schema_migrations),
  'phase0_already_applied', EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260928120000'),
  'deps', json_build_object(
    'capability_resolve', to_regprocedure('private.capability_resolve(text,jsonb,text)') IS NOT NULL,
    'get_my_profile', to_regprocedure('public.get_my_profile()') IS NOT NULL,
    'arca_norm_cuit', to_regprocedure('private.arca_norm_cuit(text)') IS NOT NULL,
    'arca_audit', to_regprocedure('private.arca_audit(text,uuid,uuid,text,text,text,text)') IS NOT NULL,
    'arca_get_config_safe', to_regprocedure('public.get_arca_config_safe(uuid)') IS NOT NULL,
    'arca_config_business_unique', EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'arca_config_business_id_key'),
    'credentials_table', to_regclass('private.arca_private_key_credentials') IS NOT NULL,
    'arca_config_cols', (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'arca_config'
                          AND column_name IN ('cuit','alias','ambiente','punto_venta','web_service','expires_at','cert_file','pfx_file','razon_social'))
  ),
  'helper_exists_before', to_regprocedure('private.arca_actor_can_manage(uuid,uuid)') IS NOT NULL,
  'fn_fingerprint', (SELECT json_object_agg(p.proname, json_build_object(
        'src', md5(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')),
        'secdef', p.prosecdef, 'acl', coalesce(p.proacl::text, '')))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('is_business_owner_or_admin','save_arca_config_legacy','save_arca_certificate_legacy','set_arca_estado_conexion')),
  'arca_config_acl', (SELECT relacl::text FROM pg_class WHERE oid = 'public.arca_config'::regclass),
  'arca_config_policies', (SELECT json_agg(policyname ORDER BY policyname) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'arca_config'),
  'managers_by_role', (SELECT json_object_agg(role, n) FROM (
      SELECT role, count(*) n FROM public.profiles WHERE is_active IS TRUE AND role IN ('owner','admin') GROUP BY role) x),
  'arca_businesses_manageable', (SELECT count(*) FROM public.arca_config c WHERE EXISTS (
      SELECT 1 FROM public.profiles p WHERE p.business_id = c.business_id AND p.is_active IS TRUE AND p.role IN ('owner','admin')
        AND (p.role = 'owner' OR p.permissions IS NULL OR NOT (p.permissions ? 'settings_sensitive')
             OR p.permissions -> 'settings_sensitive' = 'true'::jsonb))),
  'arca_config_rows', (SELECT count(*) FROM public.arca_config),
  'pending_rotations', (SELECT count(*) FROM private.arca_credential_rotations WHERE state IN ('pending_rotation','activated_pending_verification')),
  'credential_fp16', (SELECT json_agg(left(private_key_fingerprint, 16)) FROM private.arca_private_key_credentials WHERE credential_status = 'active'),
  'expires_at', (SELECT json_agg(expires_at) FROM public.arca_config)
) AS preflight;
