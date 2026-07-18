-- ============================================================================
-- M7 (Bloque 6A.1) — Cierre de idempotencia y seguridad de los flujos de capital
--
--   1. owner_flow_requests: RLS fail-closed, SIN acceso de anon/authenticated
--      (tabla interna de idempotencia), service_role sólo SELECT/INSERT, trigger
--      de inmutabilidad (una request completada no se altera ni se borra).
--   2. create_owner_withdrawal / create_owner_contribution reescritas:
--      - normalización + tope de longitud de la idempotency key;
--      - hash de idempotencia = op + negocio + monto + moneda + cuenta + fecha
--        económica persistida;
--      - reserva race-safe con INSERT ... ON CONFLICT DO NOTHING + relectura
--        (dos llamadas simultáneas → una original, otra replay; nunca dos
--        operaciones económicas; nunca unique_violation al cliente);
--      - contrato de error estructurado {ok,error_code,error} sin filtrar
--        detalles internos de PostgreSQL; el campo `error` se conserva para
--        compatibilidad del frontend actual.
-- Aditiva y reversible. NO toca otras RPC económicas.
-- ============================================================================

-- ── 1. Endurecer owner_flow_requests ────────────────────────────────────────
-- Tabla interna: el frontend NUNCA la lee/escribe directo. Fail-closed.
DROP POLICY IF EXISTS "owner_flow_req_select" ON "public"."owner_flow_requests";
REVOKE ALL ON "public"."owner_flow_requests" FROM PUBLIC, "anon", "authenticated";
REVOKE UPDATE, DELETE, TRUNCATE ON "public"."owner_flow_requests" FROM "service_role";
GRANT SELECT, INSERT ON "public"."owner_flow_requests" TO "service_role";
-- (RLS ya activa; sin policies → deny total para no-superusuario/no-bypassrls.
--  Las RPC escriben como owner=postgres, ajenas a policies del invocador.)

-- Índice de idempotencia ya existe (constraint UNIQUE (business_id, idempotency_key)).
-- Inmutabilidad: una request completada (withdrawal_id no nulo) no se modifica;
-- sólo se admite el enlace withdrawal_id NULL→valor. DELETE prohibido.
CREATE OR REPLACE FUNCTION "public"."owner_flow_requests_immutable"() RETURNS "trigger"
    LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'owner_flow_requests es append-only: DELETE no permitido' USING ERRCODE='0A000';
  END IF;
  IF OLD.withdrawal_id IS NOT NULL THEN
    RAISE EXCEPTION 'owner_flow_requests: request completada es inmutable' USING ERRCODE='0A000';
  END IF;
  IF NEW.business_id   IS DISTINCT FROM OLD.business_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.op          IS DISTINCT FROM OLD.op THEN
    RAISE EXCEPTION 'owner_flow_requests: sólo se puede completar withdrawal_id' USING ERRCODE='0A000';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION "public"."owner_flow_requests_immutable"() OWNER TO "postgres";
DROP TRIGGER IF EXISTS "trg_owner_flow_requests_immutable" ON "public"."owner_flow_requests";
CREATE TRIGGER "trg_owner_flow_requests_immutable"
  BEFORE UPDATE OR DELETE ON "public"."owner_flow_requests"
  FOR EACH ROW EXECUTE FUNCTION "public"."owner_flow_requests_immutable"();

-- ── 2. create_owner_withdrawal (reescrita: key normalizada + errores) ───────
CREATE OR REPLACE FUNCTION "public"."create_owner_withdrawal"(
  "p_business_id" uuid, "p_amount" numeric, "p_date" date, "p_account_id" uuid,
  "p_notes" text DEFAULT NULL, "p_idempotency_key" text DEFAULT NULL
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  c_key_max       constant int := 200;
  v_user_id       uuid := auth.uid();
  v_is_authorized boolean := false;
  v_acc           personal_accounts%ROWTYPE;
  v_has_ars_row   boolean := false;
  v_economic_date date;
  v_key           text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_hash          text;
  v_existing      owner_flow_requests%ROWTYPE;
  v_req_id        uuid;
  v_tx_id         uuid;
  v_fm_id         uuid;
  v_wd_id         uuid;
  v_stage         text := 'init';
BEGIN
  -- 1. Autenticación
  IF v_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','UNAUTHORIZED', 'error', 'No autenticado'); END IF;

  -- 2. Ownership + autorización por rol (SIN cambios: owner o owner/admin)
  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user_id)
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND COALESCE(user_id,id)=v_user_id
               AND COALESCE(is_active,true) AND role IN ('owner','admin'))
  ) INTO v_is_authorized;
  IF NOT v_is_authorized THEN RETURN jsonb_build_object('ok', false, 'error_code','FORBIDDEN', 'error', 'Sin permiso para registrar retiros en este negocio'); END IF;

  -- 3. Validaciones del payload (incl. tope de la key)
  IF v_key IS NOT NULL AND length(v_key) > c_key_max THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La clave de idempotencia es demasiado larga'); END IF;
  IF p_amount IS NULL OR p_amount::text IN ('NaN','Infinity','-Infinity') OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El monto debe ser mayor a cero'); END IF;
  SELECT * INTO v_acc FROM personal_accounts WHERE id=p_account_id AND user_id=v_user_id AND is_active=true FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Cuenta personal no encontrada o no activa'); END IF;
  SELECT EXISTS (SELECT 1 FROM personal_account_balances WHERE account_id=p_account_id AND user_id=v_user_id AND currency='ARS') INTO v_has_ars_row;
  IF NOT v_has_ars_row AND COALESCE(v_acc.currency,'ARS')<>'ARS' THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La cuenta destino no opera en ARS. Agregá ARS a la cuenta o elegí otra.'); END IF;

  -- 4. Fecha económica única
  v_economic_date := COALESCE(p_date, public.ar_today());

  -- Hash = op + negocio + monto + moneda + cuenta + fecha económica persistida
  IF v_key IS NOT NULL THEN
    v_hash := encode(extensions.digest('withdrawal§'||p_business_id::text||'§'||round(p_amount,2)::text||'§ARS§'||p_account_id::text||'§'||v_economic_date::text, 'sha256'), 'hex');
    -- (4b) short-circuit de replay ANTES del guard (no re-evaluar período ya confirmado)
    SELECT * INTO v_existing FROM owner_flow_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta clave ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'withdrawal_id', v_existing.withdrawal_id);
    END IF;
  END IF;

  -- 5. Guard de período (errores estructurados; no filtra internos)
  BEGIN
    PERFORM public.assert_period_open(p_business_id, v_economic_date);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'PERIOD_CLOSED%' THEN RETURN jsonb_build_object('ok', false, 'error_code','PERIOD_CLOSED', 'error', SQLERRM);
    ELSIF SQLERRM LIKE 'INVALID_FINANCE_CONTEXT%' THEN RETURN jsonb_build_object('ok', false, 'error_code','INVALID_FINANCE_CONTEXT', 'error', SQLERRM);
    ELSE RAISE; END IF;
  END;

  -- (5b) Reserva race-safe: ON CONFLICT DO NOTHING bloquea contra la request
  -- concurrente; si no reservamos, releemos (la otra ya la confirmó) → replay/conflict.
  IF v_key IS NOT NULL THEN
    INSERT INTO owner_flow_requests (business_id, user_id, op, idempotency_key, request_hash)
      VALUES (p_business_id, v_user_id, 'withdrawal', v_key, v_hash)
      ON CONFLICT (business_id, idempotency_key) DO NOTHING
      RETURNING id INTO v_req_id;
    IF v_req_id IS NULL THEN
      SELECT * INTO v_existing FROM owner_flow_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta clave ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'withdrawal_id', v_existing.withdrawal_id);
    END IF;
  END IF;

  -- 6. Escrituras económicas (persisten v_economic_date)
  v_stage := 'write';
  INSERT INTO personal_transactions (user_id, account_id, type, amount, currency, date, description, notes)
    VALUES (v_user_id, p_account_id, 'income', p_amount, 'ARS', v_economic_date, 'Retiro del negocio', p_notes)
    RETURNING id INTO v_tx_id;
  PERFORM personal_update_currency_balance(p_account_id, 'ARS', p_amount);
  INSERT INTO financial_movements (business_id, type, amount, amount_ars, currency, exchange_rate,
    source, source_id, description, date, created_by, reference_type, sign, movement_type)
    VALUES (p_business_id, 'expense', p_amount, p_amount, 'ARS', 1, 'owner_withdrawal', NULL,
      'Retiro propietario' || CASE WHEN p_notes IS NOT NULL THEN ': '||p_notes ELSE '' END,
      v_economic_date, v_user_id, 'owner_withdrawal', 1, NULL)
    RETURNING id INTO v_fm_id;
  INSERT INTO owner_withdrawals (business_id, user_id, amount, currency, date,
    business_financial_movement_id, personal_transaction_id, destination_account_id, notes, status, flow_type)
    VALUES (p_business_id, v_user_id, p_amount, 'ARS', v_economic_date, v_fm_id, v_tx_id, p_account_id, p_notes, 'completed', 'withdrawal')
    RETURNING id INTO v_wd_id;
  UPDATE financial_movements SET source_id=v_wd_id WHERE id=v_fm_id;

  -- 7. Enlace de la request
  IF v_key IS NOT NULL THEN UPDATE owner_flow_requests SET withdrawal_id=v_wd_id WHERE id=v_req_id; END IF;

  -- 8. Auditoría (un evento; si falla, el WHEN OTHERS revierte TODO)
  v_stage := 'audit';
  PERFORM finance_log_audit(
    p_business_id, 'owner_withdrawal', 'owner_withdrawals', v_wd_id, 'create_owner_withdrawal',
    v_key, p_notes, v_economic_date, 'owner_flow', v_wd_id,
    NULL, jsonb_build_object('amount', p_amount, 'currency','ARS', 'flow_type','withdrawal',
      'business_fm_id', v_fm_id, 'personal_tx_id', v_tx_id));

  -- 9. Retorno
  RETURN jsonb_build_object('ok', true, 'replay', false, 'withdrawal_id', v_wd_id, 'personal_tx_id', v_tx_id, 'business_fm_id', v_fm_id);
EXCEPTION WHEN OTHERS THEN
  -- Rollback total del bloque. Sin exponer detalles internos de PostgreSQL.
  RETURN jsonb_build_object('ok', false,
    'error_code', CASE WHEN v_stage='audit' THEN 'AUDIT_FAILED' ELSE 'INTERNAL_ERROR' END,
    'error', CASE WHEN v_stage='audit' THEN 'No se pudo registrar la auditoría de la operación'
                  ELSE 'No se pudo completar la operación' END);
END;
$$;
ALTER FUNCTION "public"."create_owner_withdrawal"(uuid, numeric, date, uuid, text, text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."create_owner_withdrawal"(uuid, numeric, date, uuid, text, text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."create_owner_withdrawal"(uuid, numeric, date, uuid, text, text) TO "authenticated", "service_role";

-- ── 2b. create_owner_contribution (reescrita, espejo) ───────────────────────
CREATE OR REPLACE FUNCTION "public"."create_owner_contribution"(
  "p_business_id" uuid, "p_amount" numeric, "p_date" date, "p_account_id" uuid,
  "p_notes" text DEFAULT NULL, "p_idempotency_key" text DEFAULT NULL
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  c_key_max       constant int := 200;
  v_user_id       uuid := auth.uid();
  v_is_authorized boolean := false;
  v_acc           personal_accounts%ROWTYPE;
  v_has_ars_row   boolean := false;
  v_economic_date date;
  v_key           text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_hash          text;
  v_existing      owner_flow_requests%ROWTYPE;
  v_req_id        uuid;
  v_tx_id         uuid;
  v_fm_id         uuid;
  v_wd_id         uuid;
  v_stage         text := 'init';
BEGIN
  IF v_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','UNAUTHORIZED', 'error', 'No autenticado'); END IF;

  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user_id)
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND COALESCE(user_id,id)=v_user_id
               AND COALESCE(is_active,true) AND role IN ('owner','admin'))
  ) INTO v_is_authorized;
  IF NOT v_is_authorized THEN RETURN jsonb_build_object('ok', false, 'error_code','FORBIDDEN', 'error', 'Sin permiso para registrar aportes en este negocio'); END IF;

  IF v_key IS NOT NULL AND length(v_key) > c_key_max THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La clave de idempotencia es demasiado larga'); END IF;
  IF p_amount IS NULL OR p_amount::text IN ('NaN','Infinity','-Infinity') OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El monto debe ser mayor a cero'); END IF;
  SELECT * INTO v_acc FROM personal_accounts WHERE id=p_account_id AND user_id=v_user_id AND is_active=true FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Cuenta personal no encontrada o no activa'); END IF;
  SELECT EXISTS (SELECT 1 FROM personal_account_balances WHERE account_id=p_account_id AND user_id=v_user_id AND currency='ARS') INTO v_has_ars_row;
  IF NOT v_has_ars_row AND COALESCE(v_acc.currency,'ARS')<>'ARS' THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La cuenta origen no opera en ARS.'); END IF;

  v_economic_date := COALESCE(p_date, public.ar_today());

  IF v_key IS NOT NULL THEN
    v_hash := encode(extensions.digest('contribution§'||p_business_id::text||'§'||round(p_amount,2)::text||'§ARS§'||p_account_id::text||'§'||v_economic_date::text, 'sha256'), 'hex');
    SELECT * INTO v_existing FROM owner_flow_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta clave ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'contribution_id', v_existing.withdrawal_id);
    END IF;
  END IF;

  BEGIN
    PERFORM public.assert_period_open(p_business_id, v_economic_date);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'PERIOD_CLOSED%' THEN RETURN jsonb_build_object('ok', false, 'error_code','PERIOD_CLOSED', 'error', SQLERRM);
    ELSIF SQLERRM LIKE 'INVALID_FINANCE_CONTEXT%' THEN RETURN jsonb_build_object('ok', false, 'error_code','INVALID_FINANCE_CONTEXT', 'error', SQLERRM);
    ELSE RAISE; END IF;
  END;

  IF v_key IS NOT NULL THEN
    INSERT INTO owner_flow_requests (business_id, user_id, op, idempotency_key, request_hash)
      VALUES (p_business_id, v_user_id, 'contribution', v_key, v_hash)
      ON CONFLICT (business_id, idempotency_key) DO NOTHING
      RETURNING id INTO v_req_id;
    IF v_req_id IS NULL THEN
      SELECT * INTO v_existing FROM owner_flow_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta clave ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'contribution_id', v_existing.withdrawal_id);
    END IF;
  END IF;

  v_stage := 'write';
  INSERT INTO personal_transactions (user_id, account_id, type, amount, currency, date, description, notes)
    VALUES (v_user_id, p_account_id, 'expense', p_amount, 'ARS', v_economic_date, 'Aporte al negocio', p_notes)
    RETURNING id INTO v_tx_id;
  PERFORM personal_update_currency_balance(p_account_id, 'ARS', -p_amount);
  INSERT INTO financial_movements (business_id, type, amount, amount_ars, currency, exchange_rate,
    source, source_id, description, date, created_by, reference_type, sign, movement_type)
    VALUES (p_business_id, 'income', p_amount, p_amount, 'ARS', 1, 'owner_contribution', NULL,
      'Aporte del propietario' || CASE WHEN p_notes IS NOT NULL THEN ': '||p_notes ELSE '' END,
      v_economic_date, v_user_id, 'owner_contribution', 1, 'income')
    RETURNING id INTO v_fm_id;
  INSERT INTO owner_withdrawals (business_id, user_id, amount, currency, date,
    business_financial_movement_id, personal_transaction_id, destination_account_id, notes, status, flow_type)
    VALUES (p_business_id, v_user_id, p_amount, 'ARS', v_economic_date, v_fm_id, v_tx_id, p_account_id, p_notes, 'completed', 'contribution')
    RETURNING id INTO v_wd_id;
  UPDATE financial_movements SET source_id=v_wd_id WHERE id=v_fm_id;

  IF v_key IS NOT NULL THEN UPDATE owner_flow_requests SET withdrawal_id=v_wd_id WHERE id=v_req_id; END IF;

  v_stage := 'audit';
  PERFORM finance_log_audit(
    p_business_id, 'owner_contribution', 'owner_withdrawals', v_wd_id, 'create_owner_contribution',
    v_key, p_notes, v_economic_date, 'owner_flow', v_wd_id,
    NULL, jsonb_build_object('amount', p_amount, 'currency','ARS', 'flow_type','contribution',
      'business_fm_id', v_fm_id, 'personal_tx_id', v_tx_id));

  RETURN jsonb_build_object('ok', true, 'replay', false, 'contribution_id', v_wd_id, 'personal_tx_id', v_tx_id, 'business_fm_id', v_fm_id);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false,
    'error_code', CASE WHEN v_stage='audit' THEN 'AUDIT_FAILED' ELSE 'INTERNAL_ERROR' END,
    'error', CASE WHEN v_stage='audit' THEN 'No se pudo registrar la auditoría de la operación'
                  ELSE 'No se pudo completar la operación' END);
END;
$$;
ALTER FUNCTION "public"."create_owner_contribution"(uuid, numeric, date, uuid, text, text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."create_owner_contribution"(uuid, numeric, date, uuid, text, text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."create_owner_contribution"(uuid, numeric, date, uuid, text, text) TO "authenticated", "service_role";

-- ============================================================================
-- ROLLBACK (documentado): recrear las versiones 6A de ambas RPC; DROP TRIGGER
-- trg_owner_flow_requests_immutable; DROP FUNCTION owner_flow_requests_immutable();
-- restaurar grants previos de owner_flow_requests.
-- ============================================================================
