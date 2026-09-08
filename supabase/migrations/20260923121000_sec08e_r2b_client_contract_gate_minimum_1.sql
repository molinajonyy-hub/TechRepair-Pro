-- SEC-08E R2B: activate minimum compatible browser contract 1.
-- Apply only after every supported browser build carries R1 contract headers.
BEGIN;

DO $$
DECLARE
  v_state text;
  v_minimum bigint;
BEGIN
  SELECT enforcement_state, minimum_contract INTO v_state, v_minimum
    FROM private.client_contract_config WHERE singleton IS TRUE FOR UPDATE;
  IF NOT FOUND OR v_state <> 'disabled' OR v_minimum IS NOT NULL THEN
    RAISE EXCEPTION 'SEC-08E R2B expected the explicit R2A disabled state';
  END IF;

  UPDATE private.client_contract_config
     SET enforcement_state = 'enabled', minimum_contract = 1, updated_at = now()
   WHERE singleton IS TRUE;
END $$;

NOTIFY pgrst, 'reload config';
COMMIT;
