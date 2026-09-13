-- ============================================================================
-- ARCA SELF-SERVICE · PHASE 1 — preflight de producción (SOLO LECTURA)
--
-- No escribe, no descifra Vault, no devuelve PEM/token/sign/secret_id/fingerprints.
-- Correr antes de `supabase db push --linked`. Todas las filas deben decir ok=true.
-- ============================================================================
BEGIN READ ONLY;

WITH checks(name, ok) AS (VALUES
  ('tip = 20260928120000',
     (SELECT max(version) FROM supabase_migrations.schema_migrations) = '20260928120000'),
  ('Phase 1 todavía no instalada',
     to_regprocedure('public.get_arca_selfservice_status(uuid)') IS NULL
     AND to_regprocedure('private.arca_selfservice_status(uuid,uuid,timestamptz)') IS NULL),
  ('helpers requeridos presentes',
     to_regprocedure('public.get_my_profile()') IS NOT NULL
     AND to_regprocedure('public.user_business_ids()') IS NOT NULL
     AND to_regprocedure('public.business_has_feature(text)') IS NOT NULL
     AND to_regprocedure('private.arca_actor_can_manage(uuid,uuid)') IS NOT NULL
     AND to_regprocedure('private.arca_pem_to_der(text)') IS NOT NULL
     AND to_regprocedure('private.arca_cert_validity(bytea)') IS NOT NULL
     AND to_regprocedure('private.arca_rsa_pubkey_from_cert(bytea)') IS NOT NULL
     AND to_regprocedure('private.arca_rsa_public_key_fingerprint_sha256(bytea,bytea)') IS NOT NULL
     AND to_regprocedure('private.arca_norm_cuit(text)') IS NOT NULL),
  ('get_arca_config_safe sigue siendo de authenticated',
     has_function_privilege('authenticated', 'public.get_arca_config_safe(uuid)', 'EXECUTE')),
  ('estados de rotación conocidos',
     NOT EXISTS (SELECT 1 FROM private.arca_credential_rotations
                  WHERE state NOT IN ('pending_rotation','activated_pending_verification','completed',
                                      'rolled_back','activation_failed','cancelled','failed'))),
  ('ninguna rotación en curso (esperado hoy)',
     NOT EXISTS (SELECT 1 FROM private.arca_credential_rotations
                  WHERE state IN ('pending_rotation','activated_pending_verification')))
)
SELECT name, ok FROM checks;

-- Huella NO sensible del estado a preservar (comparar con postdeploy-verify-readonly.sql).
SELECT left(c.business_id::text, 8)                                         AS biz,
       c.ambiente, c.punto_venta, c.estado_conexion,
       c.ultima_sincronizacion,
       (private.arca_cert_validity(private.arca_pem_to_der(c.cert_file))).not_after AS cert_not_after,
       md5(coalesce(c.cert_file, ''))                                        AS cert_md5,
       k.credential_status,
       left(k.private_key_fingerprint, 8)                                    AS cred_fp8,
       (SELECT count(*) FROM private.arca_credential_rotations r WHERE r.business_id = c.business_id) AS rotations,
       (SELECT max(id) FROM private.arca_credential_audit)                   AS audit_max_id,
       (SELECT count(*) FROM vault.secrets)                                  AS vault_secrets
  FROM public.arca_config c
  LEFT JOIN private.arca_private_key_credentials k ON k.business_id = c.business_id
 ORDER BY c.updated_at DESC;

ROLLBACK;
