-- ============================================================
-- Migration: WhatsApp Cloud API — controlled admin provisioning (Camino C)
-- Date: 2026-06-26
--
-- Backend-only administrative tooling to connect a SINGLE business's WhatsApp
-- Cloud API connection for a controlled functional test — WITHOUT any frontend
-- bypass. Access tokens live ONLY in Vault (reuses whatsapp_credential_store
-- from 20260622_whatsapp_vault_credentials.sql). These RPCs are executable ONLY
-- by service_role and must be invoked from a privileged backend (operator
-- script), never from the browser or an authenticated session.
--
-- Contents:
--   A. public.whatsapp_connection_events            — append-only audit (no secrets)
--   B. UNIQUE partial index                         — one 'connected' per business
--   C. whatsapp_admin_record_event(...)             — durable event recorder
--   D. whatsapp_admin_provision_connection(...)     — provision/reconnect
--   E. whatsapp_admin_revoke_connection(...)        — revoke (idempotent)
--
-- PREFLIGHT (read-only via MCP, 2026-06-26 on prod vrdxxmjzxhfgqlnxmbwx):
--   total_connections=1, total_connected=0, max_connected_per_business=0
--   → the partial unique index is safe to create (no duplicates to resolve).
--   Helpers public.user_business_ids() and public.is_staff() exist.
--
-- IDEMPOTENT: CREATE ... IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS.
-- Rollback SQL is documented at the bottom (commented; not executed).
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- A. Audit table — append-only, no secrets
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.whatsapp_connection_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  connection_id   uuid REFERENCES public.whatsapp_connections(id) ON DELETE SET NULL,
  event_type      text NOT NULL CHECK (event_type IN (
                    'provisioned','reconnected','disconnected',
                    'credential_rotated','credential_revoked','provision_failed')),
  actor_type      text NOT NULL DEFAULT 'service_role'
                    CHECK (actor_type IN ('service_role','system')),
  actor_user_id   uuid,
  previous_status text,
  new_status      text,
  reason          text NOT NULL,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.whatsapp_connection_events IS
  'Append-only audit of WhatsApp connection lifecycle. Never stores tokens, secrets, full phone numbers or credentials. Written ONLY by service_role SECURITY DEFINER RPCs.';

CREATE INDEX IF NOT EXISTS idx_wce_business_id   ON public.whatsapp_connection_events (business_id);
CREATE INDEX IF NOT EXISTS idx_wce_connection_id ON public.whatsapp_connection_events (connection_id);
CREATE INDEX IF NOT EXISTS idx_wce_created_at    ON public.whatsapp_connection_events (created_at DESC);

-- Append-only: block UPDATE/DELETE for EVERYONE (incl. table owner / service_role).
CREATE OR REPLACE FUNCTION public.whatsapp_connection_events_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'whatsapp_connection_events is append-only (% not allowed)', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_wce_block_mutation ON public.whatsapp_connection_events;
CREATE TRIGGER trg_wce_block_mutation
  BEFORE UPDATE OR DELETE ON public.whatsapp_connection_events
  FOR EACH ROW EXECUTE FUNCTION public.whatsapp_connection_events_block_mutation();

-- RLS: deny-all by default; restricted SELECT for staff of the SAME business.
ALTER TABLE public.whatsapp_connection_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_connection_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.whatsapp_connection_events TO authenticated;   -- scoped by RLS
DROP POLICY IF EXISTS whatsapp_connection_events_select ON public.whatsapp_connection_events;
CREATE POLICY whatsapp_connection_events_select
  ON public.whatsapp_connection_events
  FOR SELECT
  USING (business_id IN (SELECT user_business_ids()));
-- No INSERT/UPDATE/DELETE policies → authenticated/anon cannot write at all.
-- service_role (BYPASSRLS) writes only through the SECURITY DEFINER RPCs below.

-- ────────────────────────────────────────────────────────────
-- B. One ACTIVE connection per business (partial unique index)
--    Preflight confirmed 0 'connected' rows → safe. No rows are deleted.
-- ────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_connections_one_active_per_business
  ON public.whatsapp_connections (business_id)
  WHERE status = 'connected';

-- ────────────────────────────────────────────────────────────
-- C. Durable event recorder (used out-of-band for 'provision_failed',
--    since a failed provision transaction rolls back its own audit row).
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.whatsapp_admin_record_event(
  p_business_id   uuid,
  p_event_type    text,
  p_reason        text,
  p_connection_id uuid  DEFAULT NULL,
  p_metadata      jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_id uuid;
BEGIN
  IF p_business_id IS NULL THEN RAISE EXCEPTION 'business_id requerido'; END IF;
  IF p_event_type  IS NULL THEN RAISE EXCEPTION 'event_type requerido'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN RAISE EXCEPTION 'reason requerido'; END IF;

  INSERT INTO public.whatsapp_connection_events
    (business_id, connection_id, event_type, actor_type, reason, metadata)
  VALUES
    (p_business_id, p_connection_id, p_event_type, 'service_role', left(p_reason, 500),
     -- strip any key that could carry a secret (defensive)
     coalesce(p_metadata, '{}'::jsonb) - 'token' - 'access_token' - 'p_access_token' - 'secret')
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ────────────────────────────────────────────────────────────
-- D. PROVISION / RECONNECT
--    Order is critical for atomicity (single transaction):
--      validate → resolve/reuse row → store token in Vault → flip 'connected' → audit.
--    Any failure (Vault, connection, audit) rolls the WHOLE thing back.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.whatsapp_admin_provision_connection(
  p_business_id           uuid,
  p_phone_number_id       text,
  p_waba_id               text,
  p_access_token          text,
  p_reason                text,
  p_system_user_id        text        DEFAULT NULL,
  p_token_expires_at      timestamptz DEFAULT NULL,
  p_business_phone_number text        DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, vault
AS $$
DECLARE
  v_conn_id uuid;
  v_prev    text;
  v_user_id uuid;
  v_other   uuid;
  v_event   text;
BEGIN
  -- ── required, non-empty inputs ──
  IF p_business_id IS NULL THEN RAISE EXCEPTION 'business_id requerido'; END IF;
  IF p_phone_number_id IS NULL OR length(btrim(p_phone_number_id)) = 0 THEN RAISE EXCEPTION 'phone_number_id requerido'; END IF;
  IF p_waba_id         IS NULL OR length(btrim(p_waba_id))         = 0 THEN RAISE EXCEPTION 'waba_id requerido'; END IF;
  IF p_access_token    IS NULL OR length(btrim(p_access_token))    = 0 THEN RAISE EXCEPTION 'access_token requerido'; END IF;
  IF p_reason          IS NULL OR length(btrim(p_reason))          = 0 THEN RAISE EXCEPTION 'reason requerido'; END IF;

  -- ── business must exist ──
  IF NOT EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = p_business_id) THEN
    RAISE EXCEPTION 'negocio inexistente';
  END IF;

  -- ── reuse the business's existing connection row (most recent) if any ──
  SELECT c.id, c.status INTO v_conn_id, v_prev
  FROM public.whatsapp_connections c
  WHERE c.business_id = p_business_id
  ORDER BY c.created_at DESC
  LIMIT 1;

  -- ── refuse if a DIFFERENT row is already connected (one active per business) ──
  SELECT c.id INTO v_other
  FROM public.whatsapp_connections c
  WHERE c.business_id = p_business_id AND c.status = 'connected'
  LIMIT 1;
  IF v_other IS NOT NULL AND (v_conn_id IS NULL OR v_other <> v_conn_id) THEN
    RAISE EXCEPTION 'el negocio ya tiene una conexión activa';
  END IF;

  IF v_conn_id IS NULL THEN
    -- whatsapp_connections.user_id is NOT NULL → bind to an active owner/admin.
    SELECT p.user_id INTO v_user_id
    FROM public.profiles p
    WHERE p.business_id = p_business_id AND p.is_active AND p.role IN ('owner','admin')
    ORDER BY CASE p.role WHEN 'owner' THEN 0 ELSE 1 END
    LIMIT 1;
    IF v_user_id IS NULL THEN RAISE EXCEPTION 'no hay owner/admin activo para el negocio'; END IF;

    INSERT INTO public.whatsapp_connections
      (business_id, user_id, waba_id, phone_number_id, business_phone_number,
       system_user_id, status, metadata, created_at, updated_at)
    VALUES
      (p_business_id, v_user_id, p_waba_id, p_phone_number_id, p_business_phone_number,
       p_system_user_id, 'disconnected', '{}'::jsonb, now(), now())
    RETURNING id INTO v_conn_id;
    v_prev := NULL;
  ELSE
    UPDATE public.whatsapp_connections
    SET waba_id               = p_waba_id,
        phone_number_id       = p_phone_number_id,
        business_phone_number = coalesce(p_business_phone_number, business_phone_number),
        system_user_id        = coalesce(p_system_user_id, system_user_id),
        updated_at            = now()
    WHERE id = v_conn_id;
  END IF;

  -- ── store the token in Vault FIRST; 'connected' only if this succeeds ──
  PERFORM public.whatsapp_credential_store(v_conn_id, p_access_token, p_token_expires_at);

  -- ── flip to connected (partial unique index enforces single active) ──
  UPDATE public.whatsapp_connections
  SET status = 'connected', token_expires_at = p_token_expires_at, updated_at = now()
  WHERE id = v_conn_id;

  -- ── audit IN-TRANSACTION (rolls back with everything on any failure) ──
  v_event := CASE WHEN v_prev = 'connected' THEN 'reconnected' ELSE 'provisioned' END;
  INSERT INTO public.whatsapp_connection_events
    (business_id, connection_id, event_type, actor_type, previous_status, new_status, reason, metadata)
  VALUES
    (p_business_id, v_conn_id, v_event, 'service_role', v_prev, 'connected', left(p_reason, 500),
     jsonb_build_object(
       'has_system_user',  (p_system_user_id IS NOT NULL),
       'has_token_expiry', (p_token_expires_at IS NOT NULL),
       'phone_number_id_present', true,
       'waba_id_present', true));

  -- No token, no vault_secret_id, no internal data in the response.
  RETURN jsonb_build_object('connection_id', v_conn_id, 'status', 'connected', 'event', v_event);
END;
$$;

-- ────────────────────────────────────────────────────────────
-- E. REVOKE (idempotent) — remove credential + mark disconnected, keep history
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.whatsapp_admin_revoke_connection(
  p_business_id uuid,
  p_reason      text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, vault
AS $$
DECLARE
  v_conn_id  uuid;
  v_prev     text;
  v_had_cred boolean;
BEGIN
  IF p_business_id IS NULL THEN RAISE EXCEPTION 'business_id requerido'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN RAISE EXCEPTION 'reason requerido'; END IF;

  SELECT c.id, c.status INTO v_conn_id, v_prev
  FROM public.whatsapp_connections c
  WHERE c.business_id = p_business_id
  ORDER BY (c.status = 'connected') DESC, c.created_at DESC
  LIMIT 1;

  IF v_conn_id IS NULL THEN
    RETURN jsonb_build_object('status', 'noop', 'reason', 'no_connection'); -- idempotent
  END IF;

  v_had_cred := EXISTS (
    SELECT 1 FROM public.whatsapp_connection_credentials cc WHERE cc.connection_id = v_conn_id
  );

  -- delete credential (BEFORE DELETE trigger purges the Vault secret); no-op if absent
  IF v_had_cred THEN
    PERFORM public.whatsapp_credential_delete(v_conn_id);
  END IF;

  UPDATE public.whatsapp_connections
  SET status = 'disconnected', updated_at = now()
  WHERE id = v_conn_id AND status <> 'disconnected';

  -- idempotent logging: only record when something actually changed
  IF v_prev = 'connected' OR v_had_cred THEN
    INSERT INTO public.whatsapp_connection_events
      (business_id, connection_id, event_type, actor_type, previous_status, new_status, reason, metadata)
    VALUES
      (p_business_id, v_conn_id, 'credential_revoked', 'service_role', v_prev, 'disconnected', left(p_reason, 500),
       jsonb_build_object('credential_removed', v_had_cred));
  END IF;

  RETURN jsonb_build_object('connection_id', v_conn_id, 'status', 'disconnected', 'credential_removed', v_had_cred);
END;
$$;

-- ────────────────────────────────────────────────────────────
-- Grants: backend-only. Revoke from everyone; execute only by service_role.
-- ────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.whatsapp_admin_provision_connection(uuid,text,text,text,text,text,timestamptz,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.whatsapp_admin_revoke_connection(uuid,text)                                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.whatsapp_admin_record_event(uuid,text,text,uuid,jsonb)                               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.whatsapp_connection_events_block_mutation()                                          FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.whatsapp_admin_provision_connection(uuid,text,text,text,text,text,timestamptz,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.whatsapp_admin_revoke_connection(uuid,text)                                          TO service_role;
GRANT EXECUTE ON FUNCTION public.whatsapp_admin_record_event(uuid,text,text,uuid,jsonb)                               TO service_role;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- ROLLBACK (manual; NOT executed by this migration)
-- ------------------------------------------------------------
-- DROP FUNCTION IF EXISTS public.whatsapp_admin_provision_connection(uuid,text,text,text,text,text,timestamptz,text);
-- DROP FUNCTION IF EXISTS public.whatsapp_admin_revoke_connection(uuid,text);
-- DROP FUNCTION IF EXISTS public.whatsapp_admin_record_event(uuid,text,text,uuid,jsonb);
-- DROP INDEX  IF EXISTS public.uq_whatsapp_connections_one_active_per_business;
-- DROP TRIGGER IF EXISTS trg_wce_block_mutation ON public.whatsapp_connection_events;
-- DROP FUNCTION IF EXISTS public.whatsapp_connection_events_block_mutation();
-- DROP TABLE  IF EXISTS public.whatsapp_connection_events;   -- destroys audit history
-- NOTIFY pgrst, 'reload schema';
-- ============================================================
