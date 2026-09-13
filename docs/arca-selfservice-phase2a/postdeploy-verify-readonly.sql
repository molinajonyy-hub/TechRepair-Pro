-- ============================================================================
-- ARCA SELF-SERVICE · PHASE 2A — verificación post-deploy (SOLO LECTURA + probes que siempre revierten)
--
-- 1) catálogo; 2) Phase 1 de Clic idéntico; 3) Clic excluido por construcción (probe dentro de un
-- DO que SIEMPRE termina en RAISE: nada se compromete); 4) huella idéntica a la del preflight.
-- NUNCA ejecutar prepare/attach/verify/activate/cancel reales sobre Clic.
-- ============================================================================

-- 1. Catálogo
SELECT jsonb_build_object(
  'tip', (SELECT max(version) FROM supabase_migrations.schema_migrations),
  'rpcs', (SELECT jsonb_agg(jsonb_build_object('fn', p.oid::regprocedure::text, 'secdef', p.prosecdef,
             'service_role', has_function_privilege('service_role', p.oid, 'EXECUTE'),
             'authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
             'anon', has_function_privilege('anon', p.oid, 'EXECUTE'),
             'config', p.proconfig) ORDER BY p.proname)
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname LIKE 'arca_selfservice_%'),
  'phase1_rpc_authenticated', has_function_privilege('authenticated', 'public.get_arca_selfservice_status(uuid)', 'EXECUTE'),
  'derivation_private', NOT has_function_privilege('service_role', 'private.arca_selfservice_status(uuid,uuid,timestamptz)', 'EXECUTE')
) AS catalog;

-- 2. Clic sigue connected/completed/none (sin tocar nada).
SELECT private.arca_selfservice_status(c.business_id, p.uid, now()) - 'cuit' - 'razon_social' - 'alias' AS clic_status
  FROM public.arca_config c
  JOIN LATERAL (SELECT coalesce(pr.user_id, pr.id) AS uid FROM public.profiles pr
                 WHERE pr.business_id = c.business_id AND pr.role = 'owner' AND pr.is_active LIMIT 1) p ON true
 WHERE c.business_id::text LIKE 'aa930802%';

-- 3. Probe: el motor rechaza a Clic ANTES de escribir. El DO siempre termina en RAISE (rollback).
DO $probe$
DECLARE v_biz uuid; v_owner uuid; v_r jsonb;
BEGIN
  SELECT c.business_id INTO v_biz FROM public.arca_config c WHERE c.business_id::text LIKE 'aa930802%';
  SELECT coalesce(pr.user_id, pr.id) INTO v_owner FROM public.profiles pr
   WHERE pr.business_id = v_biz AND pr.role = 'owner' AND pr.is_active LIMIT 1;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_r := public.arca_selfservice_prepare_initial(v_biz, v_owner, 'postdeploy-probe-0001', '20-11111111-2', 'probe',
           'homologacion', 1, 'probe-alias');
  RAISE EXCEPTION 'PROBE_RESULT(rolled back): prepare=% is_configured=%', v_r ->> 'state', private.arca_selfservice_is_configured(v_biz);
END
$probe$;

-- 4. Huella: debe coincidir con la del preflight (salvo audit_max_id si el probe auditó: se revierte igual).
SELECT jsonb_build_object(
  'arca_config_rows', (SELECT count(*) FROM public.arca_config),
  'arca_config_md5', (SELECT md5(string_agg(to_jsonb(c)::text, ',' ORDER BY c.business_id)) FROM public.arca_config c),
  'credentials_md5', (SELECT md5(string_agg(to_jsonb(k)::text, ',' ORDER BY k.business_id)) FROM private.arca_private_key_credentials k),
  'rotations_md5', (SELECT md5(string_agg((to_jsonb(r) - 'setup_kind' - 'fiscal_snapshot' - 'certificate_der_sha256' - 'certificate_issuer'
                                            - 'verification_started_at' - 'verified_wsaa_token' - 'verified_wsaa_sign'
                                            - 'verified_wsaa_token_expires')::text, ',' ORDER BY r.id)) FROM private.arca_credential_rotations r),
  'vault_count', (SELECT count(*) FROM vault.secrets),
  'vault_meta_md5', (SELECT md5(string_agg(concat_ws('|', id, name, created_at, updated_at), ',' ORDER BY id)) FROM vault.secrets),
  'audit_max_id', (SELECT max(id) FROM private.arca_credential_audit),
  'emission_attempts', (SELECT count(*) FROM public.arca_emission_attempts),
  'comprobantes_with_cae', (SELECT count(*) FROM public.comprobantes WHERE cae IS NOT NULL)
) AS fingerprint;
