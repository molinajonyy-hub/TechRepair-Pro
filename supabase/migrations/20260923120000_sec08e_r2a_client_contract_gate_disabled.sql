-- SEC-08E R2A: install the Data API compatibility gate explicitly DISABLED.
-- The marker is forgeable compatibility metadata. It never grants tenant,
-- role, capability, or row authority; normal RLS continues after this hook.
BEGIN;

CREATE TABLE private.client_contract_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enforcement_state text NOT NULL CHECK (enforcement_state IN ('disabled', 'enabled')),
  minimum_contract bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_contract_config_state_check CHECK (
    (enforcement_state = 'disabled' AND minimum_contract IS NULL)
    OR (enforcement_state = 'enabled' AND minimum_contract IS NOT NULL AND minimum_contract >= 0)
  )
);

REVOKE ALL ON TABLE private.client_contract_config FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO private.client_contract_config(singleton, enforcement_state, minimum_contract)
VALUES (true, 'disabled', NULL)
ON CONFLICT (singleton) DO NOTHING;

CREATE FUNCTION public.check_client_contract()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, private
AS $$
DECLARE
  v_request_role text := current_setting('role', true);
  v_claims jsonb;
  v_claim_role text;
  v_state text;
  v_minimum bigint;
  v_header text;
BEGIN
  BEGIN
    v_claims := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    v_claims := '{}'::jsonb;
  END;
  v_claim_role := v_claims ->> 'role';

  IF v_request_role = 'anon' AND (v_claim_role = 'anon' OR v_claim_role IS NULL) THEN
    RETURN;
  END IF;

  IF v_request_role = 'service_role' AND v_claim_role = 'service_role' THEN
    RETURN;
  END IF;

  IF v_request_role <> 'authenticated' OR v_claim_role <> 'authenticated' THEN
    RAISE SQLSTATE 'PGRST' USING
      MESSAGE = '{"code":"CLIENT_CONTRACT_IDENTITY_ERROR","message":"No se pudo validar el cliente."}',
      DETAIL = '{"status":403,"headers":{}}';
  END IF;

  SELECT enforcement_state, minimum_contract
    INTO v_state, v_minimum
    FROM private.client_contract_config
   WHERE singleton IS TRUE;

  IF NOT FOUND OR v_state NOT IN ('disabled', 'enabled')
     OR (v_state = 'disabled' AND v_minimum IS NOT NULL)
     OR (v_state = 'enabled' AND (v_minimum IS NULL OR v_minimum < 0)) THEN
    RAISE SQLSTATE 'PGRST' USING
      MESSAGE = '{"code":"CLIENT_CONTRACT_CONFIGURATION_ERROR","message":"Servicio temporalmente no disponible."}',
      DETAIL = '{"status":503,"headers":{}}';
  END IF;

  IF v_state = 'disabled' THEN
    RETURN;
  END IF;

  BEGIN
    v_header := coalesce(current_setting('request.headers', true), '{}')::jsonb
      ->> 'x-techrepair-client-contract';
  EXCEPTION WHEN invalid_text_representation THEN
    v_header := NULL;
  END;

  IF v_header IS NULL OR v_header !~ '^(0|[1-9][0-9]*)$' THEN
    RAISE SQLSTATE 'PGRST' USING
      MESSAGE = '{"code":"CLIENT_UPDATE_REQUIRED","message":"Actualizá la aplicación para continuar."}',
      DETAIL = '{"status":409,"headers":{}}';
  END IF;

  IF v_header::numeric < v_minimum THEN
    RAISE SQLSTATE 'PGRST' USING
      MESSAGE = '{"code":"CLIENT_UPDATE_REQUIRED","message":"Actualizá la aplicación para continuar."}',
      DETAIL = '{"status":409,"headers":{}}';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.check_client_contract() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_client_contract() TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.check_client_contract() IS
  'SEC-08E R2 Data API compatibility gate. Forgeable client contract metadata '
  'never grants authority; RLS and capabilities remain authoritative.';

ALTER ROLE authenticator IN DATABASE postgres
  SET pgrst.db_pre_request = 'public.check_client_contract';
NOTIFY pgrst, 'reload config';

COMMIT;
