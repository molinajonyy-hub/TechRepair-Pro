-- ============================================================================
-- AFIP-S1A — Fundaciones seguras (schema private, tabla, RPC Vault, auditoría).
--
-- Backward-compatible: NO migra la fila productiva, NO crea secretos productivos,
-- NO revoca el SELECT directo actual de arca_config (eso es S1B), NO toca
-- afip-wsaa / afip-cae / generate-csr / uploadCertificate. Solo agrega la
-- infraestructura privada en estado DORMIDO.
--
-- Modelo de acceso: `private` NO se expone por PostgREST (no está en la lista de
-- schemas de la API). Las RPC son SECURITY DEFINER de `postgres` (rolbypassrls),
-- así funcionan bajo FORCE RLS. service_role tiene rolbypassrls pero NO grants
-- directos sobre la tabla → su único camino son estas RPC. anon/authenticated:
-- sin USAGE en el schema, sin grants, sin EXECUTE.
-- ============================================================================

-- ── 1. Schema privado, no expuesto ──────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
REVOKE ALL ON SCHEMA private FROM anon, authenticated;
GRANT USAGE ON SCHEMA private TO service_role;   -- necesario para EXECUTE de las RPC
-- IMPORTANTE (operacional): NO agregar `private` a la lista de "Exposed schemas"
-- de la API de Supabase. PostgREST no debe verlo.

-- ── 2. Tabla privada de credenciales ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS private.arca_private_key_credentials (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           uuid NOT NULL UNIQUE REFERENCES public.businesses(id) ON DELETE CASCADE,
  private_key_secret_id uuid NOT NULL,
  private_key_fingerprint text NOT NULL,
  certificate_fingerprint text,
  key_algorithm         text,
  key_size              integer,
  credential_status     text NOT NULL DEFAULT 'active'
                          CHECK (credential_status IN ('active','rotating','revoked')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  migrated_at           timestamptz,
  rotated_at            timestamptz,
  created_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE private.arca_private_key_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.arca_private_key_credentials FORCE ROW LEVEL SECURITY;
-- Sin policies: nadie (salvo roles rolbypassrls vía RPC controlada) accede.
REVOKE ALL ON private.arca_private_key_credentials FROM PUBLIC, anon, authenticated, service_role;

-- Inmutabilidad: business_id / created_at / private_key_secret_id-repunte controlado.
CREATE OR REPLACE FUNCTION private.arca_pkc_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = private, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.business_id IS DISTINCT FROM OLD.business_id THEN
      RAISE EXCEPTION 'arca_private_key_credentials: business_id es inmutable' USING ERRCODE='0A000';
    END IF;
    IF NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION 'arca_private_key_credentials: created_* es inmutable' USING ERRCODE='0A000';
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END; $$;
ALTER FUNCTION private.arca_pkc_immutable() OWNER TO postgres;
DROP TRIGGER IF EXISTS trg_arca_pkc_immutable ON private.arca_private_key_credentials;
CREATE TRIGGER trg_arca_pkc_immutable
  BEFORE UPDATE ON private.arca_private_key_credentials
  FOR EACH ROW EXECUTE FUNCTION private.arca_pkc_immutable();

-- ── 3. Auditoría privada (sin secretos) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS private.arca_credential_audit (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event         text NOT NULL CHECK (event IN (
                  'credential_validation_success','credential_validation_failure',
                  'credential_store_success','credential_store_failure',
                  'credential_replaced','credential_deleted')),
  business_id   uuid,
  actor_user_id uuid,
  environment   text,
  fingerprint_trunc text,      -- fingerprint truncado, nunca la clave
  status        text,
  error_code    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE private.arca_credential_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.arca_credential_audit FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.arca_credential_audit FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.arca_audit(p_event text, p_business_id uuid, p_actor uuid,
  p_env text, p_fp text, p_status text, p_error_code text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = private, pg_temp
AS $$
BEGIN
  INSERT INTO private.arca_credential_audit(event, business_id, actor_user_id, environment,
    fingerprint_trunc, status, error_code)
  VALUES (p_event, p_business_id, p_actor, p_env, left(coalesce(p_fp,''),16), p_status, p_error_code);
END; $$;
ALTER FUNCTION private.arca_audit(text,uuid,uuid,text,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.arca_audit(text,uuid,uuid,text,text,text,text) FROM PUBLIC, anon, authenticated, service_role;

-- ── 4. RPC Vault (SECURITY DEFINER, solo service_role) ──────────────────────
-- 4a. store: crea el secreto en Vault y enlaza la fila. Atómico: si el INSERT
--     falla, el rollback deshace también vault.create_secret (misma tx).
CREATE OR REPLACE FUNCTION private.arca_store_private_key_secret(
  p_business_id uuid, p_pem text, p_fingerprint text,
  p_cert_fingerprint text DEFAULT NULL, p_algorithm text DEFAULT NULL,
  p_key_size integer DEFAULT NULL, p_actor uuid DEFAULT NULL, p_migrated boolean DEFAULT false)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_secret_id uuid;
BEGIN
  IF p_business_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = p_business_id) THEN
    RAISE EXCEPTION 'business_id inválido' USING ERRCODE='23503';
  END IF;
  IF p_pem IS NULL OR length(btrim(p_pem)) = 0 THEN
    RAISE EXCEPTION 'PEM vacío' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM private.arca_private_key_credentials c WHERE c.business_id = p_business_id) THEN
    RAISE EXCEPTION 'ya existe credencial para el negocio (usar replace)' USING ERRCODE='23505';
  END IF;
  -- nombre determinista y sanitizado (sin CUIT/PEM/razón social)
  v_secret_id := vault.create_secret(p_pem, 'arca-private-key:'||p_business_id::text, 'ARCA WSAA private key');
  INSERT INTO private.arca_private_key_credentials(
    business_id, private_key_secret_id, private_key_fingerprint, certificate_fingerprint,
    key_algorithm, key_size, credential_status, created_by, updated_by, migrated_at)
  VALUES (p_business_id, v_secret_id, p_fingerprint, p_cert_fingerprint, p_algorithm, p_key_size,
    'active', p_actor, p_actor, CASE WHEN p_migrated THEN now() ELSE NULL END);
  PERFORM private.arca_audit('credential_store_success', p_business_id, p_actor, NULL, p_fingerprint, 'ok', NULL);
  RETURN v_secret_id;
END; $$;
ALTER FUNCTION private.arca_store_private_key_secret(uuid,text,text,text,text,integer,uuid,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.arca_store_private_key_secret(uuid,text,text,text,text,integer,uuid,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.arca_store_private_key_secret(uuid,text,text,text,text,integer,uuid,boolean) TO service_role;

-- 4b. get para firmar: devuelve el PEM SOLO a service_role. Nunca por PostgREST público.
CREATE OR REPLACE FUNCTION private.arca_get_private_key_for_signing(p_business_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_secret_id uuid; v_pem text;
BEGIN
  SELECT c.private_key_secret_id INTO v_secret_id
    FROM private.arca_private_key_credentials c
    WHERE c.business_id = p_business_id AND c.credential_status = 'active';
  IF v_secret_id IS NULL THEN
    RAISE EXCEPTION 'sin credencial activa para el negocio' USING ERRCODE='no_data_found';
  END IF;
  SELECT ds.decrypted_secret INTO v_pem FROM vault.decrypted_secrets ds WHERE ds.id = v_secret_id;
  IF v_pem IS NULL THEN
    RAISE EXCEPTION 'secreto ausente o corrupto' USING ERRCODE='data_corrupted';
  END IF;
  RETURN v_pem;   -- el caller (Edge/afip-wsaa) lo usa y descarta; NO se audita el PEM
END; $$;
ALTER FUNCTION private.arca_get_private_key_for_signing(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.arca_get_private_key_for_signing(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.arca_get_private_key_for_signing(uuid) TO service_role;

-- 4c. replace: rota. Crea secreto nuevo, reenlaza, borra el viejo. Atómico.
CREATE OR REPLACE FUNCTION private.arca_replace_private_key_secret(
  p_business_id uuid, p_pem text, p_fingerprint text,
  p_cert_fingerprint text DEFAULT NULL, p_algorithm text DEFAULT NULL,
  p_key_size integer DEFAULT NULL, p_actor uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_old uuid; v_new uuid;
BEGIN
  SELECT c.private_key_secret_id INTO v_old
    FROM private.arca_private_key_credentials c WHERE c.business_id = p_business_id FOR UPDATE;
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'sin credencial previa (usar store)' USING ERRCODE='no_data_found';
  END IF;
  IF p_pem IS NULL OR length(btrim(p_pem)) = 0 THEN
    RAISE EXCEPTION 'PEM vacío' USING ERRCODE='22023';
  END IF;
  v_new := vault.create_secret(p_pem, 'arca-private-key:'||p_business_id::text||':'||replace(gen_random_uuid()::text,'-',''), 'ARCA WSAA private key (rotado)');
  UPDATE private.arca_private_key_credentials
     SET private_key_secret_id = v_new, private_key_fingerprint = p_fingerprint,
         certificate_fingerprint = coalesce(p_cert_fingerprint, certificate_fingerprint),
         key_algorithm = coalesce(p_algorithm, key_algorithm), key_size = coalesce(p_key_size, key_size),
         rotated_at = now(), updated_by = p_actor, credential_status = 'active'
   WHERE business_id = p_business_id;
  DELETE FROM vault.secrets WHERE id = v_old;   -- retira el secreto anterior
  PERFORM private.arca_audit('credential_replaced', p_business_id, p_actor, NULL, p_fingerprint, 'ok', NULL);
  RETURN v_new;
END; $$;
ALTER FUNCTION private.arca_replace_private_key_secret(uuid,text,text,text,text,integer,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.arca_replace_private_key_secret(uuid,text,text,text,text,integer,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.arca_replace_private_key_secret(uuid,text,text,text,text,integer,uuid) TO service_role;

-- 4d. delete: idempotente. Borra secreto Vault + fila.
CREATE OR REPLACE FUNCTION private.arca_delete_private_key_secret(p_business_id uuid, p_actor uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_old uuid;
BEGIN
  SELECT c.private_key_secret_id INTO v_old
    FROM private.arca_private_key_credentials c WHERE c.business_id = p_business_id FOR UPDATE;
  IF v_old IS NULL THEN RETURN; END IF;   -- idempotente
  DELETE FROM private.arca_private_key_credentials WHERE business_id = p_business_id;
  DELETE FROM vault.secrets WHERE id = v_old;
  PERFORM private.arca_audit('credential_deleted', p_business_id, p_actor, NULL, NULL, 'ok', NULL);
END; $$;
ALTER FUNCTION private.arca_delete_private_key_secret(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.arca_delete_private_key_secret(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.arca_delete_private_key_secret(uuid,uuid) TO service_role;

-- ── 5. Post-condiciones duras (catálogo) ────────────────────────────────────
DO $$
DECLARE v_fn text; v_oid oid; v_bad text[] := '{}';
BEGIN
  FOR v_fn IN SELECT unnest(ARRAY[
    'private.arca_store_private_key_secret(uuid,text,text,text,text,integer,uuid,boolean)',
    'private.arca_get_private_key_for_signing(uuid)',
    'private.arca_replace_private_key_secret(uuid,text,text,text,text,integer,uuid)',
    'private.arca_delete_private_key_secret(uuid,uuid)'])
  LOOP
    v_oid := to_regprocedure(v_fn);
    IF v_oid IS NULL THEN RAISE EXCEPTION 'S1A: falta %', v_fn; END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE')          THEN v_bad := v_bad || (v_fn||':anon'); END IF;
    IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN v_bad := v_bad || (v_fn||':authenticated'); END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid=v_oid AND a.grantee=0 AND a.privilege_type='EXECUTE') THEN
      v_bad := v_bad || (v_fn||':PUBLIC');
    END IF;
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN v_bad := v_bad || (v_fn||':service_role_MISSING'); END IF;
  END LOOP;
  -- la tabla privada: sin grants para client roles
  IF has_table_privilege('anon','private.arca_private_key_credentials','SELECT')
     OR has_table_privilege('authenticated','private.arca_private_key_credentials','SELECT') THEN
    v_bad := v_bad || 'tabla:client_select';
  END IF;
  IF array_length(v_bad,1) IS NOT NULL THEN
    RAISE EXCEPTION 'S1A post-condición falló → %', array_to_string(v_bad, ', ');
  END IF;
  RAISE NOTICE 'AFIP-S1A: fundaciones privadas OK (schema private, tabla, 4 RPC service_role-only, auditoría).';
END $$;
