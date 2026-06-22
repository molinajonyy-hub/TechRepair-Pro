-- ============================================================
-- Migración: Credenciales de WhatsApp Cloud API en Supabase Vault
-- Fecha: 2026-06-22
--
-- PREFLIGHT (verificado vía MCP antes de aplicar):
--   · Extensión `supabase_vault` v0.3.1 habilitada; existen vault.secrets,
--     vault.decrypted_secrets, vault.create_secret(), vault.update_secret().
--   · whatsapp_connections tiene 0 filas → eliminar access_token no destruye nada.
--
-- Objetivo: que el access_token NUNCA viva en texto plano en una tabla. Se guarda
-- cifrado en Vault; una tabla privada relaciona la conexión con el secret_id. El
-- token sólo se recupera dentro de Edge Functions (service_role) vía RPC seguro.
--
-- IDEMPOTENTE: IF EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 0. Quitar el secreto en texto plano de whatsapp_connections
--    (0 conexiones activas; el token pasa a Vault)
-- ────────────────────────────────────────────────────────────
ALTER TABLE public.whatsapp_connections DROP COLUMN IF EXISTS access_token;

-- ────────────────────────────────────────────────────────────
-- 1. Tabla privada: relaciona conexión ↔ secreto en Vault
--    NO contiene el token; sólo el id del secreto cifrado + metadatos.
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.whatsapp_connection_credentials (
  connection_id    uuid PRIMARY KEY
                     REFERENCES public.whatsapp_connections(id) ON DELETE CASCADE,
  vault_secret_id  uuid NOT NULL,
  token_expires_at timestamptz,
  rotated_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.whatsapp_connection_credentials IS
  'Vincula whatsapp_connections con su token cifrado en Vault. Sin grants a anon/authenticated. Solo service_role / Edge Functions vía RPC.';

-- ── Permisos: tabla totalmente privada ──
REVOKE ALL ON public.whatsapp_connection_credentials FROM PUBLIC, anon, authenticated;
-- service_role tiene BYPASSRLS y se usa sólo desde Edge Functions / RPC SECURITY DEFINER.

-- ── RLS deny-all (defensa adicional; sin policies = sin acceso para roles sin BYPASSRLS) ──
ALTER TABLE public.whatsapp_connection_credentials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS whatsapp_connection_credentials_deny_all ON public.whatsapp_connection_credentials;
CREATE POLICY whatsapp_connection_credentials_deny_all
  ON public.whatsapp_connection_credentials
  FOR ALL
  USING (false)
  WITH CHECK (false);

-- ────────────────────────────────────────────────────────────
-- 2. Trigger: al borrar la fila de credencial, purga el secreto en Vault
--    Cubre tanto el DELETE explícito como el CASCADE desde whatsapp_connections.
--    Evita secretos huérfanos.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.whatsapp_credential_purge_vault()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, vault
AS $$
BEGIN
  IF OLD.vault_secret_id IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = OLD.vault_secret_id;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_whatsapp_credential_purge_vault ON public.whatsapp_connection_credentials;
CREATE TRIGGER trg_whatsapp_credential_purge_vault
  BEFORE DELETE ON public.whatsapp_connection_credentials
  FOR EACH ROW EXECUTE FUNCTION public.whatsapp_credential_purge_vault();

-- ────────────────────────────────────────────────────────────
-- 3. RPCs seguros (SECURITY DEFINER, search_path fijo, nombres calificados,
--    validación de parámetros, sin SQL dinámico). EXECUTE sólo service_role.
-- ────────────────────────────────────────────────────────────

-- STORE / ROTATE (upsert): guarda o rota el token cifrado en Vault.
CREATE OR REPLACE FUNCTION public.whatsapp_credential_store(
  p_connection_id uuid,
  p_token         text,
  p_expires_at    timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, vault
AS $$
DECLARE
  v_existing  uuid;
  v_secret_id uuid;
  v_name      text;
BEGIN
  IF p_connection_id IS NULL THEN
    RAISE EXCEPTION 'connection_id requerido';
  END IF;
  IF p_token IS NULL OR length(btrim(p_token)) = 0 THEN
    RAISE EXCEPTION 'token vacío';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.whatsapp_connections c WHERE c.id = p_connection_id) THEN
    RAISE EXCEPTION 'conexión inexistente';
  END IF;

  v_name := 'whatsapp_token_' || p_connection_id::text;

  SELECT cred.vault_secret_id INTO v_existing
  FROM public.whatsapp_connection_credentials cred
  WHERE cred.connection_id = p_connection_id;

  IF v_existing IS NULL THEN
    v_secret_id := vault.create_secret(p_token, v_name, 'WhatsApp Cloud API token');
    INSERT INTO public.whatsapp_connection_credentials
      (connection_id, vault_secret_id, token_expires_at, created_at, updated_at)
    VALUES
      (p_connection_id, v_secret_id, p_expires_at, now(), now());
  ELSE
    PERFORM vault.update_secret(v_existing, p_token, v_name, 'WhatsApp Cloud API token (rotated)');
    UPDATE public.whatsapp_connection_credentials
    SET token_expires_at = p_expires_at,
        rotated_at       = now(),
        updated_at       = now()
    WHERE connection_id = p_connection_id;
  END IF;
END;
$$;

-- GET TOKEN: devuelve el token descifrado. Sólo para uso server-side en Edge Functions.
CREATE OR REPLACE FUNCTION public.whatsapp_credential_get_token(p_connection_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, vault
AS $$
DECLARE
  v_secret_id uuid;
  v_token     text;
BEGIN
  IF p_connection_id IS NULL THEN
    RAISE EXCEPTION 'connection_id requerido';
  END IF;
  SELECT cred.vault_secret_id INTO v_secret_id
  FROM public.whatsapp_connection_credentials cred
  WHERE cred.connection_id = p_connection_id;
  IF v_secret_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT ds.decrypted_secret INTO v_token
  FROM vault.decrypted_secrets ds
  WHERE ds.id = v_secret_id;
  RETURN v_token;
END;
$$;

-- DELETE: borra la credencial (el trigger purga el secreto en Vault).
CREATE OR REPLACE FUNCTION public.whatsapp_credential_delete(p_connection_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, vault
AS $$
BEGIN
  IF p_connection_id IS NULL THEN
    RAISE EXCEPTION 'connection_id requerido';
  END IF;
  DELETE FROM public.whatsapp_connection_credentials
  WHERE connection_id = p_connection_id;
END;
$$;

-- ── Grants de ejecución: revocar a todos, conceder sólo a service_role ──
REVOKE ALL ON FUNCTION public.whatsapp_credential_store(uuid, text, timestamptz)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.whatsapp_credential_get_token(uuid)                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.whatsapp_credential_delete(uuid)                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.whatsapp_credential_purge_vault()                   FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.whatsapp_credential_store(uuid, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.whatsapp_credential_get_token(uuid)                TO service_role;
GRANT EXECUTE ON FUNCTION public.whatsapp_credential_delete(uuid)                   TO service_role;

NOTIFY pgrst, 'reload schema';
