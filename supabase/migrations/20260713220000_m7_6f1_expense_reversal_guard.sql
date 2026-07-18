-- ============================================================================
-- M7 (Bloque 6F.1) — reverse_operating_expense_atomic: aditivos M7 sobre la
-- reversa de gastos operativos. NO cambia el modelo de compensacion (que ya es
-- append-only y correcto): el asiento ORIGINAL nunca se toca y la compensacion
-- se fecha HOY -> el periodo original permanece inmutable.
--
-- Agrega:
--   §4  ACTOR CANONICO: se ignora p_user_id para atribucion (antes se persistia
--       el user_id del cliente en created_by/reversed_by). Ahora auth.uid().
--   §3  fecha economica de la reversa (ar_today) + guard de periodo (solo el
--       periodo de la REVERSA; el periodo del gasto original nunca se valida).
--   §8  finance_begin_audit_scope + UN evento operating_expense_reversal.
--   §9  error_code ADITIVO (sin exponer SQLERRM; unique_violation -> conflicto).
--   §6  request/reversal table endurecida (fail-closed, op, inmutabilidad).
-- La serializacion anti-doble-reversa YA existia (SELECT expenses FOR UPDATE +
-- reversed_at) y se preserva. UNIQUE(business_id, idempotency_key) ya existia.
-- ============================================================================

-- ── Part A — endurecer operating_expense_reversals ──────────────────────────
ALTER TABLE "public"."operating_expense_reversals" ADD COLUMN IF NOT EXISTS "op" text;
DROP POLICY IF EXISTS "oe_reversals_select" ON "public"."operating_expense_reversals";
REVOKE ALL ON "public"."operating_expense_reversals" FROM PUBLIC, "anon", "authenticated";
REVOKE UPDATE, DELETE, TRUNCATE ON "public"."operating_expense_reversals" FROM "service_role";
GRANT SELECT, INSERT ON "public"."operating_expense_reversals" TO "service_role";

CREATE OR REPLACE FUNCTION "public"."operating_expense_reversals_immutable"() RETURNS "trigger"
    LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION '% es append-only: DELETE no permitido', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  -- Registro de reversa: inmutable una vez creado (es el asiento de la compensacion).
  IF NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.expense_id IS DISTINCT FROM OLD.expense_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.op IS DISTINCT FROM OLD.op OR NEW.amount_ars IS DISTINCT FROM OLD.amount_ars
     OR NEW.reversal_finance_entry_id IS DISTINCT FROM OLD.reversal_finance_entry_id
     OR NEW.reversal_financial_movement_id IS DISTINCT FROM OLD.reversal_financial_movement_id
     OR NEW.original_finance_entry_id IS DISTINCT FROM OLD.original_finance_entry_id THEN
    RAISE EXCEPTION '%: el registro de reversa es inmutable', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  RETURN NEW;
END; $$;
ALTER FUNCTION "public"."operating_expense_reversals_immutable"() OWNER TO "postgres";
DROP TRIGGER IF EXISTS "trg_oe_reversals_immutable" ON "public"."operating_expense_reversals";
CREATE TRIGGER "trg_oe_reversals_immutable"
  BEFORE UPDATE OR DELETE ON "public"."operating_expense_reversals"
  FOR EACH ROW EXECUTE FUNCTION "public"."operating_expense_reversals_immutable"();

-- ── Part B — RPC ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reverse_operating_expense_atomic(p_business_id uuid, p_expense_id uuid, p_reason text, p_user_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  c_key_max constant int := 200;
  -- M7 6F.1: actor CANONICO. p_user_id se ignora para atribucion (compat de firma).
  v_actor_user_id uuid := auth.uid();
  v_access boolean := false;
  v_key text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_reason text := NULLIF(btrim(COALESCE(p_reason,'')), '');
  v_hash text;
  v_existing operating_expense_reversals%ROWTYPE;
  v_exp expenses%ROWTYPE;
  v_bfe business_finance_entries%ROWTYPE;
  v_fm financial_movements%ROWTYPE;
  v_method text;
  v_new_bfe uuid; v_new_fm uuid;
  v_reversal_id uuid;
  v_caja uuid;
  -- 6F.1a: la fecha de la compensacion es un RESULTADO server-side. NO se calcula
  -- en el DECLARE ni entra al hash: se asigna solo cuando la key es NUEVA.
  v_date date;
  v_in_audit boolean := false;
  v_ec text;
BEGIN
  -- 1. Autenticacion
  IF v_actor_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','UNAUTHORIZED', 'error', 'No autenticado'); END IF;
  -- 2. Validacion
  IF v_reason IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El motivo del reverso es obligatorio'); END IF;
  IF v_key IS NOT NULL AND length(v_key) > c_key_max THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La clave de idempotencia es demasiado larga'); END IF;
  -- 3. Ownership/pertenencia (miembro activo — se preserva el modelo previo, sin filtro de rol nuevo)
  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_actor_user_id)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND COALESCE(user_id,id)=v_actor_user_id AND COALESCE(is_active,true))) INTO v_access;
  IF NOT v_access THEN RETURN jsonb_build_object('ok', false, 'error_code','FORBIDDEN', 'error', 'Sin acceso a este negocio'); END IF;

  -- 4. Replay: hash canonico de la INTENCION del caller (op+negocio+gasto+motivo).
  -- 6F.1a: NO incluye ar_today()/fecha/periodo/actor/IDs generados por el servidor
  -- -> idempotencia DURABLE (un retry al dia siguiente con la misma intencion
  -- sigue siendo replay, no conflicto). Retorna ANTES de calcular la fecha
  -- economica, del guard, del lock y de cualquier escritura o auditoria.
  IF v_key IS NOT NULL THEN
    v_hash := encode(extensions.digest(jsonb_build_object('op','operating_expense_reversal','business_id',p_business_id,
      'expense_id',p_expense_id,'reason',v_reason)::text, 'sha256'), 'hex');
    SELECT * INTO v_existing FROM operating_expense_reversals WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.');
      END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'reversal_finance_entry_id', v_existing.reversal_finance_entry_id,
        'reversal_financial_movement_id', v_existing.reversal_financial_movement_id);
    END IF;
  END IF;

  -- 4b. Key NUEVA: recien ahora se resuelve la fecha economica de la compensacion.
  v_date := public.ar_today();

  -- 5. LOCK del gasto original: serializa contra doble reversa (dos claves distintas).
  SELECT * INTO v_exp FROM expenses WHERE id=p_expense_id AND business_id=p_business_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error_code','EXPENSE_NOT_FOUND', 'error', 'Gasto inexistente'); END IF;
  IF v_exp.tipo = 'factura' THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Esta factura pertenece a una compra/proveedor. Corregila desde Proveedores o mediante un reverso específico.');
  END IF;
  -- Re-lectura bajo lock: si otra transaccion ya reverso, aca se ve.
  IF v_exp.reversed_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code','ALREADY_REVERSED', 'error', 'El gasto ya fue reversado');
  END IF;
  IF v_exp.finance_entry_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El gasto no tiene asiento financiero para reversar');
  END IF;

  SELECT * INTO v_bfe FROM business_finance_entries WHERE id=v_exp.finance_entry_id AND business_id=p_business_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Asiento del gasto inexistente'); END IF;
  IF v_bfe.economic_class <> 'operating_expense' THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Solo se pueden reversar gastos operativos por acá (clase: '||COALESCE(v_bfe.economic_class,'?')||')');
  END IF;

  -- FM original (lo creó create_expense_with_finance con reference_id = bfe_id).
  SELECT * INTO v_fm FROM financial_movements
    WHERE business_id=p_business_id AND reference_id=v_bfe.id AND source='expense' LIMIT 1;
  v_method := COALESCE(v_fm.metodo_pago, v_exp.payment_method, 'efectivo');

  -- 6. Guard de periodo: SOLO el periodo de la REVERSA (hoy). El periodo del gasto
  -- original NUNCA se valida ni se reabre: revertir hoy un gasto de un mes cerrado
  -- es valido y no altera aquel mes.
  BEGIN PERFORM public.assert_period_open(p_business_id, v_date);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'PERIOD_CLOSED%' THEN RETURN jsonb_build_object('ok', false, 'error_code','PERIOD_CLOSED', 'error', SQLERRM);
    ELSIF SQLERRM LIKE 'INVALID_FINANCE_CONTEXT%' THEN RETURN jsonb_build_object('ok', false, 'error_code','INVALID_FINANCE_CONTEXT', 'error', SQLERRM);
    ELSE RAISE; END IF; END;

  -- Semántica de caja: si hubo FM y el método es efectivo, la reversa (income)
  -- necesita una caja ABIERTA actual (nunca la caja cerrada del original).
  SELECT id INTO v_caja FROM cajas WHERE business_id=p_business_id AND status='abierta' ORDER BY opened_at DESC LIMIT 1;
  IF v_fm.id IS NOT NULL AND v_method = 'efectivo' AND v_caja IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code','CASH_REGISTER_NOT_OPEN', 'error', 'No hay caja abierta para registrar la reversa en efectivo');
  END IF;

  -- 7. Scope de auditoria (antes de las escrituras compensatorias)
  PERFORM public.finance_begin_audit_scope();

  -- 8. BFE compensatorio (mismo type/category → misma clase operating_expense;
  --    amount NEGATIVO → net 0). Fechado HOY: el periodo original no cambia.
  INSERT INTO business_finance_entries (business_id, date, type, category, description,
    amount, currency, amount_ars, exchange_rate, payment_method, source, created_by)
    VALUES (p_business_id, v_date, v_bfe.type, v_bfe.category,
      'REVERSO: '||COALESCE(v_bfe.description,'')||' — '||v_reason,
      -v_bfe.amount, v_bfe.currency, -v_bfe.amount_ars, v_bfe.exchange_rate, v_bfe.payment_method, 'reversal', v_actor_user_id)
    RETURNING id INTO v_new_bfe;

  -- 9. FM compensatorio income (si el original afectó caja). caja_id NULL →
  --    trigger_set_movement_caja asigna la caja ABIERTA actual (nunca la del original).
  IF v_fm.id IS NOT NULL THEN
    INSERT INTO financial_movements (business_id, date, type, currency, amount, amount_ars, exchange_rate,
      source, description, created_by, metodo_pago, reference_id, reference_type)
      VALUES (p_business_id, v_date, 'income', v_fm.currency, v_fm.amount, v_fm.amount_ars, v_fm.exchange_rate,
        'reversal', 'REVERSO gasto: '||COALESCE(v_fm.description,''), v_actor_user_id, v_method, v_bfe.id, 'expense_reversal')
      RETURNING id INTO v_new_fm;
  END IF;

  -- 10. Metadata operativa del original (append-only: NO se borra ni se altera su
  --     monto/fecha/clase; ninguna vista canonica filtra por reversed_at).
  UPDATE expenses SET reversed_at=now(), reversed_by=v_actor_user_id WHERE id=p_expense_id;

  -- 11. Registro de reversa / store de idempotencia
  INSERT INTO operating_expense_reversals (business_id, expense_id, original_finance_entry_id, original_financial_movement_id,
    reversal_finance_entry_id, reversal_financial_movement_id, amount_ars, reason, created_by, idempotency_key, request_hash, op, metadata)
    VALUES (p_business_id, p_expense_id, v_bfe.id, v_fm.id, v_new_bfe, v_new_fm, v_bfe.amount_ars, v_reason, v_actor_user_id, v_key, v_hash,
      'operating_expense_reversal', jsonb_build_object('economic_class', v_bfe.economic_class, 'method', v_method))
    RETURNING id INTO v_reversal_id;

  -- 12. Auditoria explicita: UN evento de negocio (la reversa)
  v_in_audit := true;
  PERFORM finance_log_audit(
    p_business_id, 'operating_expense_reversal', 'expenses', p_expense_id, 'reverse_operating_expense_atomic',
    v_key, v_reason, v_date, 'expense', p_expense_id,
    NULL, jsonb_build_object(
      'expense_id', p_expense_id, 'reversal_id', v_reversal_id, 'reason', v_reason,
      'original_amount_ars', v_bfe.amount_ars, 'reversal_amount_ars', -v_bfe.amount_ars, 'currency', v_bfe.currency,
      'original_date', v_bfe.date, 'reversal_date', v_date,
      'original_period', to_char(v_bfe.date,'YYYY-MM'), 'reversal_period', to_char(v_date,'YYYY-MM'),
      'original_finance_entry_id', v_bfe.id, 'original_financial_movement_id', v_fm.id,
      'reversal_finance_entry_id', v_new_bfe, 'reversal_financial_movement_id', v_new_fm,
      'economic_class', v_bfe.economic_class, 'method', v_method, 'caja_id', v_caja));
  v_in_audit := false;

  RETURN jsonb_build_object('ok', true, 'replay', false,
    'reversal_finance_entry_id', v_new_bfe, 'reversal_financial_movement_id', v_new_fm,
    'original_finance_entry_id', v_bfe.id, 'original_financial_movement_id', v_fm.id);
EXCEPTION WHEN OTHERS THEN
  -- M7 6F.1: error_code aditivo, sin exponer SQLERRM. unique_violation (carrera
  -- residual con la misma key) -> contrato de conflicto, con rollback total.
  v_ec := CASE
    WHEN v_in_audit THEN 'AUDIT_FAILED'
    WHEN SQLSTATE = '23505' THEN 'IDEMPOTENCY_CONFLICT'
    ELSE 'INTERNAL_ERROR' END;
  IF v_ec = 'IDEMPOTENCY_CONFLICT' THEN
    RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.');
  END IF;
  RETURN jsonb_build_object('ok', false, 'error_code', v_ec,
    'error', CASE WHEN v_ec='AUDIT_FAILED' THEN 'No se pudo registrar la auditoria de la operacion'
                  ELSE 'No se pudo completar la operacion' END);
END;
$function$;

-- ============================================================================
-- ROLLBACK (documentado): recrear la version M6 (20260706140000) sin actor
-- canonico/guard/audit/error_code; DROP trigger + funcion
-- operating_expense_reversals_immutable; ALTER DROP COLUMN op; restaurar policy
-- oe_reversals_select + GRANT SELECT a authenticated.
-- ============================================================================
