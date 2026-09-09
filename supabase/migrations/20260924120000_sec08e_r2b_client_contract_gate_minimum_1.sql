-- SEC-08E R2B: atomically activate minimum compatible client contract 1.
-- The contract marker remains compatibility metadata only. RLS and
-- capabilities continue to own every authorization decision.
BEGIN;

DO $$
DECLARE
  v_state text;
  v_minimum bigint;
  v_rows bigint;
BEGIN
  SELECT enforcement_state, minimum_contract
    INTO v_state, v_minimum
    FROM private.client_contract_config
   WHERE singleton IS TRUE
   FOR UPDATE;

  IF NOT FOUND OR v_state <> 'disabled' OR v_minimum IS NOT NULL THEN
    RAISE EXCEPTION 'SEC-08E R2B requires the exact R2A disabled/NULL state';
  END IF;

  UPDATE private.client_contract_config
     SET enforcement_state = 'enabled',
         minimum_contract = 1,
         updated_at = now()
   WHERE singleton IS TRUE;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'SEC-08E R2B expected to update exactly one configuration row';
  END IF;
END;
$$;

COMMIT;
