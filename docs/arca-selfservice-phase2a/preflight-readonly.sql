-- ============================================================================
-- ARCA SELF-SERVICE · PHASE 2A — preflight de producción (SOLO LECTURA)
-- Correr antes de `supabase db push --linked`. Todas las filas deben decir ok=true.
-- No escribe, no descifra Vault, no devuelve PEM/token/sign/secret_id/fingerprints/CUIT.
-- ============================================================================
BEGIN READ ONLY;

WITH checks(name, ok) AS (VALUES
  ('tip = 20260929120000',
     (SELECT max(version) FROM supabase_migrations.schema_migrations) = '20260929120000'),
  ('Phase 2A todavía no instalada',
     to_regprocedure('public.arca_selfservice_prepare_initial(uuid,uuid,text,text,text,text,integer,text,text,text,text)') IS NULL
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'private' AND table_name = 'arca_credential_rotations' AND column_name = 'setup_kind')),
  ('Phase 1 instalada',
     has_function_privilege('authenticated', 'public.get_arca_selfservice_status(uuid)', 'EXECUTE')),
  ('ninguna rotación viva (la redefinición de kind no cambia estados existentes)',
     NOT EXISTS (SELECT 1 FROM private.arca_credential_rotations WHERE state IN ('pending_rotation', 'activated_pending_verification'))),
  ('helpers S3A/S4A/S4B presentes',
     to_regprocedure('private.arca_validate_rotation_certificate(text,text,jsonb,text)') IS NOT NULL
     AND to_regprocedure('private.arca_x500_name(bytea,integer)') IS NOT NULL
     AND to_regprocedure('private.arca_rsa_pubkey_from_csr(bytea)') IS NOT NULL
     AND to_regprocedure('private.arca_key_matches_certificate(text,text)') IS NOT NULL
     AND to_regprocedure('private.arca_get_private_key_for_signing(uuid)') IS NOT NULL),
  ('arca_config.cuit_emisor NOT NULL default vacío',
     EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'arca_config'
              AND column_name = 'cuit_emisor' AND is_nullable = 'NO')),
  ('sin filas con private_key_secret_id nulo',
     NOT EXISTS (SELECT 1 FROM private.arca_credential_rotations WHERE private_key_secret_id IS NULL))
)
SELECT name, ok FROM checks;

-- Huella NO sensible a preservar (comparar con postdeploy-verify-readonly.sql).
SELECT jsonb_build_object(
  'arca_config_rows', (SELECT count(*) FROM public.arca_config),
  'arca_config_md5', (SELECT md5(string_agg(to_jsonb(c)::text, ',' ORDER BY c.business_id)) FROM public.arca_config c),
  'credentials_md5', (SELECT md5(string_agg(to_jsonb(k)::text, ',' ORDER BY k.business_id)) FROM private.arca_private_key_credentials k),
  'rotations_md5', (SELECT md5(string_agg(to_jsonb(r)::text, ',' ORDER BY r.id)) FROM private.arca_credential_rotations r),
  'vault_count', (SELECT count(*) FROM vault.secrets),
  'vault_meta_md5', (SELECT md5(string_agg(concat_ws('|', id, name, created_at, updated_at), ',' ORDER BY id)) FROM vault.secrets),
  'audit_max_id', (SELECT max(id) FROM private.arca_credential_audit),
  'emission_attempts', (SELECT count(*) FROM public.arca_emission_attempts),
  'comprobantes_with_cae', (SELECT count(*) FROM public.comprobantes WHERE cae IS NOT NULL)
) AS fingerprint;

ROLLBACK;
