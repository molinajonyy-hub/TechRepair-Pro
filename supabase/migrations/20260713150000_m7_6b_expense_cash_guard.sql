-- ============================================================================
-- M7 (Bloque 6B) — Integración guard+auditoría en create_expense_with_finance y
-- create_manual_cash_movement_atomic + rediseño del scope de auditoría.
--
-- Ninguna de estas RPC toca account_movements/comprobante_payments (E1/E2). La
-- infraestructura de scope se implementa igual (para las RPC futuras que sí las
-- tocan) y se prueba, pero NO se modifican otras RPC.
--
-- PARTE A — scope de auditoría explícito (reemplaza la GUC ambigua m7.audited_tx):
--   finance_begin_audit_scope() marca m7.audit_managed='1' TEMPRANO (tras
--   auth/ownership/validación, antes de escrituras). El backstop E1/E2 se omite
--   sólo si m7.audit_managed='1'. finance_log_audit() ya NO marca nada (marcar
--   scope ≠ auditar; auditar ≠ marcar scope). m7.audited_tx queda OBSOLETA.
-- PARTE B — create_expense_with_finance (idempotencia nueva + ownership faltante).
-- PARTE C — create_manual_cash_movement_atomic (idempotencia endurecida).
-- ============================================================================

-- ═══════════════ PARTE A — scope de auditoría ══════════════════════════════
-- Marca de scope: una RPC gestionada la activa antes de escribir. Interna.
CREATE OR REPLACE FUNCTION "public"."finance_begin_audit_scope"() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  PERFORM set_config('m7.audit_managed', '1', true);  -- transaccional; se descarta al terminar la tx
END;
$$;
ALTER FUNCTION "public"."finance_begin_audit_scope"() OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."finance_begin_audit_scope"() FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."finance_begin_audit_scope"() TO "service_role";

-- Backstop: ahora consulta m7.audit_managed (no la vieja m7.audited_tx). Si una
-- RPC gestionada está activa, NO registra (ella emitirá eventos explícitos).
CREATE OR REPLACE FUNCTION "public"."finance_audit_backstop"() RETURNS "trigger"
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_j    jsonb := to_jsonb(NEW);
  v_econ date  := NULLIF(v_j->>'date','')::date;
BEGIN
  IF COALESCE(current_setting('m7.audit_managed', true), '0') = '1' THEN
    RETURN NEW;  -- dentro de un scope gestionado: la RPC audita explícitamente
  END IF;
  INSERT INTO finance_audit_log (
    business_id, actor_user_id, action, entity_table, entity_id, source_rpc,
    economic_date, period_start, reference_type, reference_id, new_data
  ) VALUES (
    (v_j->>'business_id')::uuid, auth.uid(), 'insert', TG_TABLE_NAME, (v_j->>'id')::uuid, 'trigger_backstop',
    v_econ,
    CASE WHEN v_econ IS NULL THEN NULL ELSE date_trunc('month', v_econ)::date END,
    v_j->>'reference_type', NULLIF(v_j->>'reference_id','')::uuid,
    v_j - 'created_at'
  );
  RETURN NEW;
EXCEPTION
  WHEN unique_violation THEN RETURN NEW;  -- único caso tolerado (dedup); el resto propaga
END;
$$;
ALTER FUNCTION "public"."finance_audit_backstop"() OWNER TO "postgres";

-- Helper de auditoría: YA NO marca scope (elimina el set_config de m7.audited_tx).
CREATE OR REPLACE FUNCTION "public"."finance_log_audit"(
  p_business_id uuid, p_action text, p_entity_table text, p_entity_id uuid DEFAULT NULL,
  p_source_rpc text DEFAULT NULL, p_request_id text DEFAULT NULL, p_reason text DEFAULT NULL,
  p_economic_date date DEFAULT NULL, p_reference_type text DEFAULT NULL, p_reference_id uuid DEFAULT NULL,
  p_old_data jsonb DEFAULT NULL, p_new_data jsonb DEFAULT NULL, p_actor uuid DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_id uuid;
BEGIN
  IF p_business_id IS NULL OR p_action IS NULL OR p_entity_table IS NULL THEN RETURN NULL; END IF;
  INSERT INTO finance_audit_log (
    business_id, actor_user_id, action, entity_table, entity_id, source_rpc,
    request_id, reason, economic_date, period_start, reference_type, reference_id, old_data, new_data
  ) VALUES (
    p_business_id, COALESCE(p_actor, auth.uid()), p_action, p_entity_table, p_entity_id, p_source_rpc,
    p_request_id, p_reason, p_economic_date,
    CASE WHEN p_economic_date IS NULL THEN NULL ELSE date_trunc('month', p_economic_date)::date END,
    p_reference_type, p_reference_id, p_old_data, p_new_data
  )
  ON CONFLICT ("business_id","request_id","action","entity_table","entity_id")
    WHERE "request_id" IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL AND p_request_id IS NOT NULL THEN
    SELECT id INTO v_id FROM finance_audit_log
      WHERE business_id=p_business_id AND request_id=p_request_id AND action=p_action
        AND entity_table=p_entity_table AND entity_id IS NOT DISTINCT FROM p_entity_id LIMIT 1;
  END IF;
  RETURN v_id;
END;
$$;
ALTER FUNCTION "public"."finance_log_audit"(uuid,text,text,uuid,text,text,text,date,text,uuid,jsonb,jsonb,uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."finance_log_audit"(uuid,text,text,uuid,text,text,text,date,text,uuid,jsonb,jsonb,uuid) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."finance_log_audit"(uuid,text,text,uuid,text,text,text,date,text,uuid,jsonb,jsonb,uuid) TO "service_role";

-- ═══════════════ PARTE B — expense_requests + create_expense_with_finance ══
CREATE TABLE IF NOT EXISTS "public"."expense_requests" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id"     uuid NOT NULL REFERENCES "public"."businesses"("id"),
  "user_id"         uuid,
  "op"              text NOT NULL DEFAULT 'operating_expense',
  "idempotency_key" text NOT NULL,
  "request_hash"    text NOT NULL,
  "expense_id"      uuid,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "expense_requests_key_uniq" UNIQUE ("business_id","idempotency_key")
);
ALTER TABLE "public"."expense_requests" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."expense_requests" FROM PUBLIC, "anon", "authenticated";
GRANT SELECT, INSERT ON "public"."expense_requests" TO "service_role";

CREATE OR REPLACE FUNCTION "public"."expense_requests_immutable"() RETURNS "trigger"
    LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'expense_requests es append-only: DELETE no permitido' USING ERRCODE='0A000'; END IF;
  IF OLD.expense_id IS NOT NULL THEN RAISE EXCEPTION 'expense_requests: request completada es inmutable' USING ERRCODE='0A000'; END IF;
  IF NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.op IS DISTINCT FROM OLD.op THEN
    RAISE EXCEPTION 'expense_requests: sólo se puede completar expense_id' USING ERRCODE='0A000'; END IF;
  IF NEW.expense_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM expenses WHERE id=NEW.expense_id AND business_id=NEW.business_id) THEN
    RAISE EXCEPTION 'expense_requests: la entidad enlazada no pertenece al negocio' USING ERRCODE='0A000'; END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION "public"."expense_requests_immutable"() OWNER TO "postgres";
DROP TRIGGER IF EXISTS "trg_expense_requests_immutable" ON "public"."expense_requests";
CREATE TRIGGER "trg_expense_requests_immutable"
  BEFORE UPDATE OR DELETE ON "public"."expense_requests"
  FOR EACH ROW EXECUTE FUNCTION "public"."expense_requests_immutable"();

-- Firma nueva: +p_idempotency_key (14º, DEFAULT NULL). Una sola firma resoluble.
DROP FUNCTION IF EXISTS "public"."create_expense_with_finance"(uuid,uuid,text,text,text,text,numeric,text,date,boolean,text,text,uuid);
CREATE OR REPLACE FUNCTION "public"."create_expense_with_finance"(
  "p_business_id" uuid, "p_user_id" uuid, "p_description" text, "p_category" text, "p_category_key" text,
  "p_finance_type" text, "p_amount" numeric, "p_payment_method" text, "p_date" date,
  "p_is_recurring" boolean DEFAULT false, "p_frequency" text DEFAULT NULL, "p_notes" text DEFAULT NULL,
  "p_caja_id" uuid DEFAULT NULL, "p_idempotency_key" text DEFAULT NULL
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  c_key_max       constant int := 200;
  v_user          uuid := auth.uid();
  v_is_member     boolean := false;
  v_economic_date date;
  v_key           text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_hash          text;
  v_existing      expense_requests%ROWTYPE;
  v_req_id        uuid;
  v_bfe_id        uuid;
  v_exp_id        uuid;
  v_fm_id         uuid;
  v_stage         text := 'init';
BEGIN
  -- 1. Autenticación
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','UNAUTHORIZED', 'error', 'No autenticado'); END IF;

  -- 2/3. Pertenencia al negocio + rol según comportamiento previo. El gasto NO
  -- tenía restricción de rol en DB (sólo confiaba en p_business_id): se AGREGA la
  -- pertenencia faltante (cierra cross-tenant) SIN filtro de rol, para no quitarle
  -- acceso a ningún rol que ya lo tuviera. No amplía permisos.
  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user)
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND COALESCE(user_id,id)=v_user AND COALESCE(is_active,true))
  ) INTO v_is_member;
  IF NOT v_is_member THEN RETURN jsonb_build_object('ok', false, 'error_code','FORBIDDEN', 'error', 'Sin acceso a este negocio'); END IF;

  -- 4. Validación del gasto
  IF v_key IS NOT NULL AND length(v_key) > c_key_max THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La clave de idempotencia es demasiado larga'); END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El monto debe ser mayor a 0'); END IF;
  IF p_description IS NULL OR btrim(p_description)='' THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La descripción es obligatoria'); END IF;

  -- 5. Fecha económica única
  v_economic_date := COALESCE(p_date, public.ar_today());

  -- 6. Replay previo (canónico jsonb)
  IF v_key IS NOT NULL THEN
    v_hash := encode(extensions.digest(jsonb_build_object(
      'op','operating_expense', 'business_id',p_business_id, 'amount',round(p_amount,2),
      'currency','ARS', 'category',NULLIF(btrim(p_category_key),''), 'account',p_caja_id,
      'economic_date',v_economic_date, 'description',NULLIF(btrim(p_description),''))::text, 'sha256'), 'hex');
    SELECT * INTO v_existing FROM expense_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta clave ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'expense_id', v_existing.expense_id);
    END IF;
  END IF;

  -- 7. Guard de período
  BEGIN
    PERFORM public.assert_period_open(p_business_id, v_economic_date);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'PERIOD_CLOSED%' THEN RETURN jsonb_build_object('ok', false, 'error_code','PERIOD_CLOSED', 'error', SQLERRM);
    ELSIF SQLERRM LIKE 'INVALID_FINANCE_CONTEXT%' THEN RETURN jsonb_build_object('ok', false, 'error_code','INVALID_FINANCE_CONTEXT', 'error', SQLERRM);
    ELSE RAISE; END IF;
  END;

  -- 8. Reserva idempotente race-safe
  IF v_key IS NOT NULL THEN
    INSERT INTO expense_requests (business_id, user_id, op, idempotency_key, request_hash)
      VALUES (p_business_id, v_user, 'operating_expense', v_key, v_hash)
      ON CONFLICT (business_id, idempotency_key) DO NOTHING RETURNING id INTO v_req_id;
    IF v_req_id IS NULL THEN
      SELECT * INTO v_existing FROM expense_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta clave ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'expense_id', v_existing.expense_id);
    END IF;
  END IF;

  -- 9. Scope de auditoría (infra; este flujo no toca E1/E2 pero declara gestión)
  PERFORM public.finance_begin_audit_scope();

  -- 10. Escrituras económicas (persisten v_economic_date). El expense lleva
  -- finance_entry_id = v_bfe_id → trig_expense_finance no re-crea BFE (no duplica).
  v_stage := 'write';
  INSERT INTO business_finance_entries (business_id, date, type, category, description,
    amount, currency, amount_ars, exchange_rate, payment_method, source, created_by)
    VALUES (p_business_id, v_economic_date, p_finance_type, p_category_key, p_description,
      p_amount, 'ARS', p_amount, 1, p_payment_method, 'expense', v_user)
    RETURNING id INTO v_bfe_id;
  INSERT INTO expenses (description, category, amount, amount_ars, date, business_id, payment_method,
    currency, exchange_rate, is_recurring, frequency, notes, finance_entry_id, created_by, tipo)
    VALUES (p_description, p_category, p_amount, p_amount, v_economic_date, p_business_id, p_payment_method,
      'ARS', 1, COALESCE(p_is_recurring,false), p_frequency, p_notes, v_bfe_id, v_user, 'general')
    RETURNING id INTO v_exp_id;
  INSERT INTO financial_movements (business_id, date, type, currency, amount, amount_ars, exchange_rate,
    description, source, reference_id, created_by, caja_id, metodo_pago)
    VALUES (p_business_id, v_economic_date, 'expense', 'ARS', p_amount, p_amount, 1,
      p_description, 'expense', v_bfe_id, v_user, p_caja_id, p_payment_method)
    RETURNING id INTO v_fm_id;

  -- 11/12. Enlace del request
  IF v_key IS NOT NULL THEN UPDATE expense_requests SET expense_id=v_exp_id WHERE id=v_req_id; END IF;

  -- 13. Auditoría explícita (un evento)
  v_stage := 'audit';
  PERFORM finance_log_audit(
    p_business_id, 'operating_expense_create', 'expenses', v_exp_id, 'create_expense_with_finance',
    v_key, p_notes, v_economic_date, 'expense', v_exp_id,
    NULL, jsonb_build_object('amount', p_amount, 'currency','ARS', 'category', p_category_key,
      'finance_type', p_finance_type, 'payment_method', p_payment_method, 'caja_id', p_caja_id,
      'bfe_id', v_bfe_id, 'fm_id', v_fm_id));

  -- 14. Retorno
  RETURN jsonb_build_object('ok', true, 'replay', false, 'bfe_id', v_bfe_id, 'expense_id', v_exp_id, 'fm_id', v_fm_id);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false,
    'error_code', CASE WHEN v_stage='audit' THEN 'AUDIT_FAILED' ELSE 'INTERNAL_ERROR' END,
    'error', CASE WHEN v_stage='audit' THEN 'No se pudo registrar la auditoría de la operación'
                  ELSE 'No se pudo completar la operación' END);
END;
$$;
ALTER FUNCTION "public"."create_expense_with_finance"(uuid,uuid,text,text,text,text,numeric,text,date,boolean,text,text,uuid,text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."create_expense_with_finance"(uuid,uuid,text,text,text,text,numeric,text,date,boolean,text,text,uuid,text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."create_expense_with_finance"(uuid,uuid,text,text,text,text,numeric,text,date,boolean,text,text,uuid,text) TO "authenticated","service_role";

-- ═══════════════ PARTE C — create_manual_cash_movement_atomic ══════════════
-- Endurecer la request table (existente): op inmutable, RLS fail-closed, trigger.
ALTER TABLE "public"."manual_cash_movement_requests" ADD COLUMN IF NOT EXISTS "op" text;
DROP POLICY IF EXISTS "mcm_req_select" ON "public"."manual_cash_movement_requests";
REVOKE ALL ON "public"."manual_cash_movement_requests" FROM PUBLIC, "anon", "authenticated";
REVOKE UPDATE, DELETE, TRUNCATE ON "public"."manual_cash_movement_requests" FROM "service_role";
GRANT SELECT, INSERT ON "public"."manual_cash_movement_requests" TO "service_role";

CREATE OR REPLACE FUNCTION "public"."manual_cash_requests_immutable"() RETURNS "trigger"
    LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'manual_cash_movement_requests es append-only: DELETE no permitido' USING ERRCODE='0A000'; END IF;
  IF OLD.financial_movement_id IS NOT NULL THEN RAISE EXCEPTION 'manual_cash_movement_requests: request completada es inmutable' USING ERRCODE='0A000'; END IF;
  IF NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.op IS DISTINCT FROM OLD.op THEN
    RAISE EXCEPTION 'manual_cash_movement_requests: sólo se puede completar financial_movement_id' USING ERRCODE='0A000'; END IF;
  IF NEW.financial_movement_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM financial_movements WHERE id=NEW.financial_movement_id AND business_id=NEW.business_id
         AND (NEW.op IS NULL OR type=NEW.op)) THEN
    RAISE EXCEPTION 'manual_cash_movement_requests: la entidad enlazada no pertenece al negocio o el tipo no coincide' USING ERRCODE='0A000'; END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION "public"."manual_cash_requests_immutable"() OWNER TO "postgres";
DROP TRIGGER IF EXISTS "trg_manual_cash_requests_immutable" ON "public"."manual_cash_movement_requests";
CREATE TRIGGER "trg_manual_cash_requests_immutable"
  BEFORE UPDATE OR DELETE ON "public"."manual_cash_movement_requests"
  FOR EACH ROW EXECUTE FUNCTION "public"."manual_cash_requests_immutable"();

-- Misma firma (8 args). Conserva invariantes M6: caja abierta, tipo, método,
-- moneda/TC. Agrega fecha económica canónica (ar_today, defensiva), guard,
-- idempotencia race-safe, auditoría explícita y contrato de error.
CREATE OR REPLACE FUNCTION "public"."create_manual_cash_movement_atomic"(
  "p_business_id" uuid, "p_type" text, "p_method" text, "p_amount" numeric,
  "p_description" text, "p_user_id" uuid, "p_exchange_rate" numeric DEFAULT 1,
  "p_idempotency_key" text DEFAULT NULL
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  c_key_max       constant int := 200;
  v_user          uuid := auth.uid();
  v_is_member     boolean := false;
  v_caja          uuid;
  v_currency      text := CASE WHEN p_method='usd' THEN 'USD' ELSE 'ARS' END;
  v_rate          numeric := CASE WHEN p_method='usd' THEN COALESCE(NULLIF(p_exchange_rate,0),1) ELSE 1 END;
  v_amount_ars    numeric;
  v_economic_date date := public.ar_today();  -- caja SIEMPRE contabiliza hoy (sin backdating)
  v_key           text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_hash          text;
  v_existing      manual_cash_movement_requests%ROWTYPE;
  v_req_id        uuid;
  v_fm            uuid;
  v_stage         text := 'init';
BEGIN
  -- 1. Autenticación
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','UNAUTHORIZED', 'error', 'No autenticado'); END IF;
  -- 2/3. Pertenencia (roles preservados: cualquier perfil activo, como en M6)
  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND user_id=v_user AND COALESCE(is_active,true))) INTO v_is_member;
  IF NOT v_is_member THEN RETURN jsonb_build_object('ok', false, 'error_code','FORBIDDEN', 'error', 'Sin acceso a este negocio'); END IF;
  -- 4. Validaciones del payload
  IF v_key IS NOT NULL AND length(v_key) > c_key_max THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La clave de idempotencia es demasiado larga'); END IF;
  IF p_type NOT IN ('income','expense') THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Tipo inválido (income|expense)'); END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El monto debe ser mayor a 0'); END IF;
  -- Invariante M6: caja abierta obligatoria
  SELECT id INTO v_caja FROM cajas WHERE business_id=p_business_id AND status='abierta' ORDER BY opened_at DESC LIMIT 1;
  IF v_caja IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','CASH_REGISTER_NOT_OPEN', 'error', 'No hay caja abierta para registrar el movimiento'); END IF;

  v_amount_ars := round(p_amount * v_rate, 2);

  -- 6. Replay previo (hash canónico jsonb; incluye el TIPO income/expense)
  IF v_key IS NOT NULL THEN
    v_hash := encode(extensions.digest(jsonb_build_object(
      'op',p_type, 'business_id',p_business_id, 'amount',round(v_amount_ars,2), 'currency',v_currency,
      'method',p_method, 'economic_date',v_economic_date, 'description',NULLIF(btrim(p_description),''))::text, 'sha256'), 'hex');
    SELECT * INTO v_existing FROM manual_cash_movement_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta clave ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'financial_movement_id', v_existing.financial_movement_id);
    END IF;
  END IF;

  -- 7. Guard de período (defensivo sobre el período actual)
  BEGIN
    PERFORM public.assert_period_open(p_business_id, v_economic_date);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'PERIOD_CLOSED%' THEN RETURN jsonb_build_object('ok', false, 'error_code','PERIOD_CLOSED', 'error', SQLERRM);
    ELSIF SQLERRM LIKE 'INVALID_FINANCE_CONTEXT%' THEN RETURN jsonb_build_object('ok', false, 'error_code','INVALID_FINANCE_CONTEXT', 'error', SQLERRM);
    ELSE RAISE; END IF;
  END;

  -- 8. Reserva idempotente race-safe
  IF v_key IS NOT NULL THEN
    INSERT INTO manual_cash_movement_requests (business_id, user_id, op, idempotency_key, request_hash)
      VALUES (p_business_id, v_user, p_type, v_key, v_hash)
      ON CONFLICT (business_id, idempotency_key) DO NOTHING RETURNING id INTO v_req_id;
    IF v_req_id IS NULL THEN
      SELECT * INTO v_existing FROM manual_cash_movement_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta clave ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'financial_movement_id', v_existing.financial_movement_id);
    END IF;
  END IF;

  -- 9. Scope de auditoría (infra)
  PERFORM public.finance_begin_audit_scope();

  -- 10. Escritura económica (persiste v_economic_date; caja resuelta server-side)
  v_stage := 'write';
  INSERT INTO financial_movements (business_id, caja_id, date, type, currency, amount, exchange_rate,
    amount_ars, source, description, created_by, metodo_pago)
    VALUES (p_business_id, v_caja, v_economic_date, p_type, v_currency, p_amount, v_rate,
      v_amount_ars, 'manual', NULLIF(btrim(COALESCE(p_description,'')),''), v_user, p_method)
    RETURNING id INTO v_fm;

  -- 11/12. Enlace del request
  IF v_key IS NOT NULL THEN UPDATE manual_cash_movement_requests SET financial_movement_id=v_fm WHERE id=v_req_id; END IF;

  -- 13. Auditoría explícita (acción según tipo)
  v_stage := 'audit';
  PERFORM finance_log_audit(
    p_business_id, 'manual_cash_'||p_type, 'financial_movements', v_fm, 'create_manual_cash_movement_atomic',
    v_key, p_description, v_economic_date, 'caja', v_caja,
    NULL, jsonb_build_object('caja_id', v_caja, 'method', p_method, 'type', p_type,
      'amount', p_amount, 'currency', v_currency, 'amount_ars', v_amount_ars, 'date', v_economic_date));

  -- 14. Retorno
  RETURN jsonb_build_object('ok', true, 'replay', false, 'financial_movement_id', v_fm);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false,
    'error_code', CASE WHEN v_stage='audit' THEN 'AUDIT_FAILED' ELSE 'INTERNAL_ERROR' END,
    'error', CASE WHEN v_stage='audit' THEN 'No se pudo registrar la auditoría de la operación'
                  ELSE 'No se pudo completar la operación' END);
END;
$function$;
ALTER FUNCTION "public"."create_manual_cash_movement_atomic"(uuid,text,text,numeric,text,uuid,numeric,text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."create_manual_cash_movement_atomic"(uuid,text,text,numeric,text,uuid,numeric,text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."create_manual_cash_movement_atomic"(uuid,text,text,numeric,text,uuid,numeric,text) TO "authenticated","service_role";

-- ============================================================================
-- ROLLBACK (documentado): recrear finance_log_audit/backstop sin el cambio de GUC;
-- DROP finance_begin_audit_scope; recrear las versiones previas de ambas RPC (13
-- args expense / M6 manual cash); DROP TABLE expense_requests; DROP triggers de
-- inmutabilidad; ALTER manual_cash_movement_requests DROP COLUMN op; restaurar grants.
-- ============================================================================
