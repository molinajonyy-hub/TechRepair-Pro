-- ============================================================================
-- ARCA SELF-SERVICE · PHASE 1 — verificación post-deploy (SOLO LECTURA)
--
-- 1) catálogo; 2) estado de Clic por la derivación y por la RPC (claims del owner
-- dentro de una transacción READ ONLY que termina en ROLLBACK); 3) huella del
-- material idéntica a la del preflight.
--
-- :clic_business  = aa930802-… (UUID completo, NO pegarlo en el PR)
-- :clic_owner     = user_id del owner activo de Clic
-- ============================================================================
BEGIN READ ONLY;

-- 1. Catálogo
SELECT 'rpc authenticated'   AS check, has_function_privilege('authenticated', 'public.get_arca_selfservice_status(uuid)', 'EXECUTE') AS ok
UNION ALL SELECT 'rpc NO anon',         NOT has_function_privilege('anon', 'public.get_arca_selfservice_status(uuid)', 'EXECUTE')
UNION ALL SELECT 'rpc NO service_role', NOT has_function_privilege('service_role', 'public.get_arca_selfservice_status(uuid)', 'EXECUTE')
UNION ALL SELECT 'derivación NO authenticated', NOT has_function_privilege('authenticated', 'private.arca_selfservice_status(uuid,uuid,timestamptz)', 'EXECUTE')
UNION ALL SELECT 'rpc STABLE + SECDEF', (SELECT provolatile = 's' AND prosecdef FROM pg_proc WHERE oid = 'public.get_arca_selfservice_status(uuid)'::regprocedure)
UNION ALL SELECT 'tip = 20260929120000', (SELECT max(version) FROM supabase_migrations.schema_migrations) = '20260929120000';

-- 2a. Derivación directa (postgres). Esperado para Clic:
--     status=connected, configured=true, environment=produccion, punto_venta=10,
--     certificate.renewal_state=healthy, certificate.expires_at=2028-07-25T23:58:12+00,
--     credential.active=true, setup.state=completed, attention=[], next_action=none, can_manage=true
SELECT private.arca_selfservice_status(:'clic_business'::uuid, :'clic_owner'::uuid, now()) - 'cuit' - 'razon_social' - 'alias' AS clic_status;

-- 2b. Misma respuesta por la RPC pública con la identidad del owner.
SELECT set_config('request.jwt.claims', json_build_object('sub', :'clic_owner', 'role', 'authenticated')::text, true);
SELECT public.get_arca_selfservice_status(:'clic_business'::uuid) - 'cuit' - 'razon_social' - 'alias' AS clic_status_rpc;

-- 3. Huella: debe coincidir con la del preflight.
SELECT left(c.business_id::text, 8) AS biz, c.estado_conexion, c.ultima_sincronizacion,
       md5(coalesce(c.cert_file, '')) AS cert_md5, k.credential_status, left(k.private_key_fingerprint, 8) AS cred_fp8,
       (SELECT count(*) FROM private.arca_credential_rotations r WHERE r.business_id = c.business_id) AS rotations,
       (SELECT max(id) FROM private.arca_credential_audit) AS audit_max_id,
       (SELECT count(*) FROM vault.secrets) AS vault_secrets
  FROM public.arca_config c
  LEFT JOIN private.arca_private_key_credentials k ON k.business_id = c.business_id;

ROLLBACK;
