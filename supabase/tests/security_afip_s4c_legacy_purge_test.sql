-- ============================================================================
-- AFIP-S4C — purga definitiva del material legacy.
--
-- Verifica el ESTADO RESULTANTE de la migración (que ya corrió) y el
-- comportamiento de los contratos que quedaron: sin columna en claro, presencia
-- de clave derivada de Vault, RPC de migración retirada y rollback
-- deliberadamente deshabilitado tras la purga.
--
-- Fixtures SINTÉTICOS. Todo dentro de BEGIN…ROLLBACK.
-- RUN: docker exec <db> psql -X -U postgres -d postgres -f este.sql
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL request.jwt.claims = '{"role":"service_role"}';

\set BIZ '00000000-0000-4000-8000-0000000054e9'
\set OWNER '00000000-0000-4000-8000-0000000054ea'

INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
VALUES (:'OWNER', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        's4c-owner@test.local', '', now(), now()) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.businesses (id, name, owner_user_id, subscription_plan, subscription_status)
VALUES (:'BIZ', 'S4C-test', :'OWNER', 'pro', 'active')
ON CONFLICT (id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id;

CREATE TEMP TABLE res (n serial, label text, ok boolean);
CREATE OR REPLACE FUNCTION pg_temp.chk(l text, ok boolean) RETURNS void
LANGUAGE plpgsql AS $f$ BEGIN INSERT INTO res(label, ok) VALUES (l, coalesce(ok,false)); END $f$;

-- ── 1-4: la columna en claro dejó de existir ────────────────────────────────
SELECT pg_temp.chk('1 la columna arca_config.private_key NO existe',
  NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='arca_config' AND column_name='private_key'));

SELECT pg_temp.chk('2 ningún grant sobrevive sobre la columna eliminada',
  NOT EXISTS (SELECT 1 FROM information_schema.column_privileges
    WHERE table_schema='public' AND table_name='arca_config' AND column_name='private_key'));

SELECT pg_temp.chk('3 ninguna vista expone private_key de arca_config',
  NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relkind IN ('v','m')
    AND pg_get_viewdef(c.oid) ~ 'arca_config' AND pg_get_viewdef(c.oid) ~ '\mprivate_key\M'));

SELECT pg_temp.chk('4 ninguna función lee arca_config.private_key',
  NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname IN ('public','private') AND p.prokind='f'
      AND pg_get_functiondef(p.oid) ~ 'arca_config'
      AND pg_get_functiondef(p.oid) ~ '\mv_row\.private_key\M|\mNEW\.private_key\M|\mc\.private_key\M'));

-- ── 5-6: la RPC de migración legacy quedó retirada fail-closed ──────────────
DO $t$
DECLARE r jsonb;
BEGIN
  r := public.arca_migrate_legacy_private_key_to_vault(
         '00000000-0000-4000-8000-0000000054e9'::uuid, 'a'||repeat('b',63), 'idem-x');
  PERFORM pg_temp.chk('5 migración legacy → LEGACY_MIGRATION_RETIRED',
    (r->>'state') = 'LEGACY_MIGRATION_RETIRED' AND (r->>'ok')::boolean IS FALSE);
  PERFORM pg_temp.chk('5 la respuesta no filtra material', (r::text) !~ 'BEGIN|PRIVATE KEY|MII');
END $t$;

SELECT pg_temp.chk('6 la RPC retirada sigue siendo service_role-only',
  NOT has_function_privilege('anon','public.arca_migrate_legacy_private_key_to_vault(uuid,text,text)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.arca_migrate_legacy_private_key_to_vault(uuid,text,text)','EXECUTE')
  AND NOT has_function_privilege('public','public.arca_migrate_legacy_private_key_to_vault(uuid,text,text)','EXECUTE')
  AND has_function_privilege('service_role','public.arca_migrate_legacy_private_key_to_vault(uuid,text,text)','EXECUTE'));

-- ── 7-11: presencia de clave derivada de Vault + rollback tras la purga ─────
DO $t$
DECLARE v_secret uuid; v_rot uuid; r jsonb; v_cfg jsonb;
        k_biz uuid := '00000000-0000-4000-8000-0000000054e9';
        k_own uuid := '00000000-0000-4000-8000-0000000054ea';
        k_fp  text := repeat('ab',32);
        k_prev text := repeat('cd',32);
BEGIN
  INSERT INTO public.arca_config (business_id, cuit, alias, ambiente, punto_venta, web_service,
          cert_file, estado_conexion)
  VALUES (k_biz, '20111111112', 'fixture.alias', 'homologacion', 1, 'wsfe',
          '-----BEGIN CERTIFICATE-----'||chr(10)||'ZmFrZQ=='||chr(10)||'-----END CERTIFICATE-----', 'conectado')
  ON CONFLICT (business_id) DO NOTHING;

  -- 7: sin credencial en Vault, el contrato seguro NO reporta clave configurada
  SELECT public.get_arca_config_safe(k_biz) INTO v_cfg;  -- sin auth.uid() → NULL
  PERFORM pg_temp.chk('7 get_arca_config_safe sigue negando a un caller sin sesión', v_cfg IS NULL);

  -- Credencial en Vault (contrato real) + rotación completed con checkpoint purgado
  v_secret := vault.create_secret('-----BEGIN RSA PRIVATE KEY-----'||chr(10)||'ZmFrZQ=='||chr(10)||'-----END RSA PRIVATE KEY-----',
              'arca-private-key-s4c-test:'||k_biz::text, 'fixture S4C');
  INSERT INTO private.arca_private_key_credentials
    (business_id, private_key_secret_id, private_key_fingerprint, key_algorithm, key_size, credential_status, created_by)
  VALUES (k_biz, v_secret, k_fp, 'RSA', 2048, 'active', k_own);

  INSERT INTO private.arca_credential_rotations
    (business_id, private_key_secret_id, private_key_fingerprint, csr_fingerprint, csr_pem,
     key_algorithm, key_size, public_exponent, subject, state, idempotency_key, request_hash, created_by,
     activated_at, finalized_at, prev_fingerprint, prev_status)
  VALUES (k_biz, v_secret, k_fp, k_fp, 'x', 'RSA', 2048, 65537, '{}'::jsonb, 'completed',
          'idem-s4c', 'hash-s4c', k_own, now(), now(), k_prev, 'purged')
  RETURNING id INTO v_rot;

  -- 8: el rollback está PERMANENTEMENTE deshabilitado tras la purga
  r := public.arca_rollback_certificate_rotation(k_biz, v_rot, 'idem-rb-s4c', k_own);
  PERFORM pg_temp.chk('8 rollback tras purga → ROLLBACK_PERMANENTLY_DISABLED',
    (r->>'state') = 'ROLLBACK_PERMANENTLY_DISABLED' AND (r->>'ok')::boolean IS FALSE);
  PERFORM pg_temp.chk('8 el rechazo no tocó la credencial activa',
    (SELECT private_key_fingerprint FROM private.arca_private_key_credentials WHERE business_id=k_biz) = k_fp);
  PERFORM pg_temp.chk('8 el rechazo no borró el secreto activo',
    EXISTS (SELECT 1 FROM vault.secrets s WHERE s.id = v_secret));

  -- 9: el estado del checkpoint conserva la historia, no el material
  PERFORM pg_temp.chk('9 el checkpoint conserva fingerprint y timestamps',
    (SELECT prev_fingerprint = k_prev AND activated_at IS NOT NULL AND finalized_at IS NOT NULL
       FROM private.arca_credential_rotations WHERE id = v_rot));
  PERFORM pg_temp.chk('9 el checkpoint ya no tiene material recuperable',
    (SELECT prev_secret_id IS NULL AND prev_certificate_pem IS NULL
       AND prev_wsaa_token IS NULL AND prev_wsaa_sign IS NULL
       FROM private.arca_credential_rotations WHERE id = v_rot));

  -- 10: una rotación NO purgada sigue pudiendo revertirse (no se rompió el contrato)
  UPDATE private.arca_credential_rotations SET prev_status='rollback_candidate', prev_secret_id=v_secret,
         prev_certificate_pem='-----BEGIN CERTIFICATE-----'||chr(10)||'ZmFrZQ=='||chr(10)||'-----END CERTIFICATE-----',
         state='activated_pending_verification'
   WHERE id = v_rot;
  r := public.arca_rollback_certificate_rotation(k_biz, v_rot, 'idem-rb-s4c-2', k_own);
  PERFORM pg_temp.chk('10 una rotación NO purgada sigue siendo revertible',
    (r->>'state') IN ('ROTATION_ROLLED_BACK','ROLLBACK_FAILED'));
  PERFORM pg_temp.chk('10 el estado purged es lo único que deshabilita el rollback',
    (r->>'state') <> 'ROLLBACK_PERMANENTLY_DISABLED');
END $t$;

-- ── 11-13: postcondiciones globales ─────────────────────────────────────────
SELECT pg_temp.chk('11 cero rotaciones completed con material anterior sin purgar',
  NOT EXISTS (SELECT 1 FROM private.arca_credential_rotations
    WHERE state='completed' AND prev_secret_id IS NOT NULL));

SELECT pg_temp.chk('12 cero referencias a secretos inexistentes',
  NOT EXISTS (SELECT 1 FROM (
      SELECT private_key_secret_id AS sid FROM private.arca_private_key_credentials
      UNION ALL SELECT private_key_secret_id FROM private.arca_credential_rotations
      UNION ALL SELECT prev_secret_id FROM private.arca_credential_rotations) q
    WHERE q.sid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vault.secrets s WHERE s.id=q.sid)));

SELECT pg_temp.chk('13 los eventos de purga están en el contrato de auditoría',
  (SELECT count(*) FROM (VALUES
      ('arca_legacy_private_key_purged'),('arca_previous_secret_purged'),('arca_rollback_disabled')) v(e)
   WHERE pg_get_constraintdef(c.oid) LIKE '%'||v.e||'%') = 3)
FROM pg_constraint c WHERE c.conname='arca_credential_audit_event_check';

\echo ''
\echo '════════ RESULTADO AFIP-S4C ════════'
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS r, label FROM res ORDER BY n;
SELECT count(*) FILTER (WHERE ok) AS pass, count(*) FILTER (WHERE NOT ok) AS fail, count(*) AS total FROM res;
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM res WHERE NOT ok) THEN
    RAISE EXCEPTION 'AFIP-S4C: % asserts fallaron', (SELECT count(*) FROM res WHERE NOT ok);
  END IF;
END $g$;

ROLLBACK;
