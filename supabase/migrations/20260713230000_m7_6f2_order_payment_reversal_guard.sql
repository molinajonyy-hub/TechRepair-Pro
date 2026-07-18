-- ============================================================================
-- M7 (Bloque 6F.2) — reverse_order_payment_atomic: aditivos M7 sobre la reversa
-- de cobros de ordenes. El modelo de compensacion YA era append-only y correcto:
-- el cobro original nunca se toca y la compensacion se fecha HOY -> el periodo
-- original permanece inmutable. NO se cambia semantica comercial/contable.
--
-- Agrega:
--   §6  ACTOR CANONICO: se ignora p_user_id para atribucion (antes se persistia
--       el user_id del cliente en created_by/reversed_by). Ahora auth.uid().
--   §5  fecha economica de la reversa (ar_today) DIFERIDA (solo key nueva) +
--       guard de periodo SOLO sobre la fecha de la compensacion.
--   §8  hash canonico jsonb con SOLO la intencion del caller (op+negocio+pago+
--       motivo) -> idempotencia DURABLE (retry al dia siguiente = replay).
--   §10 finance_begin_audit_scope + UN evento order_payment_reversal.
--   §16 error_code ADITIVO (sin exponer SQLERRM).
--   §8  reversal table endurecida (fail-closed, op, inmutabilidad).
--
-- Hallazgos del audit (no requieren cambio):
--   · Entidad canonica = order_payments (se bloquea FOR UPDATE). NO se usa ni se
--     mantiene orders.amount_paid (cache legacy) en ningun momento.
--   · La RPC NO escribe account_movements ni comprobante_payments -> NO toca
--     tablas del backstop E1 (create_order_payment_atomic tampoco crea CC, asi que
--     no hay deuda que restaurar: no se inventa un account movement).
--   · trig_payment_movements en order_payments es BEFORE **INSERT** -> el UPDATE
--     de reversed_at NO dispara movimientos espurios.
--   · Ninguna vista referencia order_payments -> marcar reversed_at no excluye
--     retrospectivamente el cobro original.
--   · BFE compensatorio clase revenue_collection_mirror (NO esta en v_finance_pnl)
--     -> la reversa no altera el P&L; solo neutraliza cashflow.
-- ============================================================================

-- ── Part A — endurecer order_payment_reversals ──────────────────────────────
ALTER TABLE "public"."order_payment_reversals" ADD COLUMN IF NOT EXISTS "op" text;
DROP POLICY IF EXISTS "op_reversals_select" ON "public"."order_payment_reversals";
DROP POLICY IF EXISTS "order_payment_reversals_select" ON "public"."order_payment_reversals";
REVOKE ALL ON "public"."order_payment_reversals" FROM PUBLIC, "anon", "authenticated";
REVOKE UPDATE, DELETE, TRUNCATE ON "public"."order_payment_reversals" FROM "service_role";
GRANT SELECT, INSERT ON "public"."order_payment_reversals" TO "service_role";

CREATE OR REPLACE FUNCTION "public"."order_payment_reversals_immutable"() RETURNS "trigger"
    LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION '% es append-only: DELETE no permitido', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  IF NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.order_payment_id IS DISTINCT FROM OLD.order_payment_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.op IS DISTINCT FROM OLD.op OR NEW.amount_ars IS DISTINCT FROM OLD.amount_ars
     OR NEW.reversal_financial_movement_id IS DISTINCT FROM OLD.reversal_financial_movement_id
     OR NEW.reversal_finance_entry_id IS DISTINCT FROM OLD.reversal_finance_entry_id
     OR NEW.original_financial_movement_id IS DISTINCT FROM OLD.original_financial_movement_id THEN
    RAISE EXCEPTION '%: el registro de reversa es inmutable', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  RETURN NEW;
END; $$;
ALTER FUNCTION "public"."order_payment_reversals_immutable"() OWNER TO "postgres";
DROP TRIGGER IF EXISTS "trg_op_reversals_immutable" ON "public"."order_payment_reversals";
CREATE TRIGGER "trg_op_reversals_immutable"
  BEFORE UPDATE OR DELETE ON "public"."order_payment_reversals"
  FOR EACH ROW EXECUTE FUNCTION "public"."order_payment_reversals_immutable"();

-- ── Part B — RPC ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reverse_order_payment_atomic(p_business_id uuid, p_order_payment_id uuid, p_reason text, p_user_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  c_key_max constant int := 200;
  -- M7 6F.2: actor CANONICO. p_user_id se ignora para atribucion (compat de firma).
  v_actor_user_id uuid := auth.uid();
  v_access boolean := false;
  v_key text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_reason text := NULLIF(btrim(COALESCE(p_reason,'')), '');
  v_hash text; v_existing order_payment_reversals%ROWTYPE;
  v_pay order_payments%ROWTYPE; v_bfe business_finance_entries%ROWTYPE; v_fm financial_movements%ROWTYPE;
  v_metodo text; v_new_fm uuid; v_new_bfe uuid; v_reversal_id uuid; v_caja uuid;
  -- La fecha de la compensacion es un RESULTADO server-side: NO entra al hash y
  -- solo se resuelve cuando la key es NUEVA (idempotencia durable).
  v_date date;
  v_in_audit boolean := false;
  v_ec text;
BEGIN
  -- 1. Autenticacion
  IF v_actor_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','UNAUTHORIZED', 'error', 'No autenticado'); END IF;
  -- 2. Validacion
  IF v_reason IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El motivo del reverso es obligatorio'); END IF;
  IF v_key IS NOT NULL AND length(v_key) > c_key_max THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La clave de idempotencia es demasiado larga'); END IF;
  -- 3. Ownership/pertenencia (miembro activo — modelo previo preservado, sin filtro de rol nuevo)
  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_actor_user_id)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND COALESCE(user_id,id)=v_actor_user_id AND COALESCE(is_active,true))) INTO v_access;
  IF NOT v_access THEN RETURN jsonb_build_object('ok', false, 'error_code','FORBIDDEN', 'error', 'Sin acceso a este negocio'); END IF;

  -- 4. Replay: hash canonico de la INTENCION del caller (op+negocio+pago+motivo).
  -- NO incluye ar_today()/fecha/actor/IDs generados por el servidor -> un retry al
  -- dia siguiente sigue siendo replay. Retorna ANTES de resolver la fecha, del
  -- guard, del lock y de cualquier escritura o auditoria.
  IF v_key IS NOT NULL THEN
    v_hash := encode(extensions.digest(jsonb_build_object('op','order_payment_reversal','business_id',p_business_id,
      'order_payment_id',p_order_payment_id,'reason',v_reason)::text, 'sha256'), 'hex');
    SELECT * INTO v_existing FROM order_payment_reversals WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'reversal_financial_movement_id', v_existing.reversal_financial_movement_id,
        'reversal_finance_entry_id', v_existing.reversal_finance_entry_id);
    END IF;
  END IF;

  -- 4b. Key NUEVA: recien ahora se resuelve la fecha economica de la compensacion.
  v_date := public.ar_today();

  -- 5. LOCK del cobro original: serializa contra doble reversa (claves distintas).
  SELECT * INTO v_pay FROM order_payments WHERE id=p_order_payment_id AND business_id=p_business_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error_code','PAYMENT_NOT_FOUND', 'error', 'Pago inexistente'); END IF;
  -- Re-lectura bajo lock: si otra transaccion ya reverso, aca se ve.
  IF v_pay.reversed_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','ALREADY_REVERSED', 'error', 'El pago ya fue reversado'); END IF;
  -- Aislamiento: la orden del cobro debe ser del mismo negocio
  IF v_pay.order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM orders WHERE id=v_pay.order_id AND business_id=p_business_id) THEN
    RETURN jsonb_build_object('ok', false, 'error_code','ORDER_NOT_FOUND', 'error', 'La orden del pago no pertenece a este negocio'); END IF;

  SELECT * INTO v_fm FROM financial_movements WHERE id=v_pay.financial_movement_id AND business_id=p_business_id;
  SELECT * INTO v_bfe FROM business_finance_entries WHERE id=v_pay.finance_entry_id AND business_id=p_business_id;
  v_metodo := COALESCE(v_fm.metodo_pago, CASE WHEN v_pay.currency='USD' THEN 'usd' WHEN v_pay.payment_method='cash' THEN 'efectivo' WHEN v_pay.payment_method='transfer' THEN 'transferencia' WHEN v_pay.payment_method IN ('credit_card','debit_card') THEN 'tarjeta' ELSE 'otro' END);

  -- 6. Guard de periodo: SOLO el periodo de la REVERSA (hoy). El periodo del cobro
  -- original NUNCA se valida ni se reabre: revertir hoy un cobro de un mes cerrado
  -- es valido y no altera aquel mes.
  BEGIN PERFORM public.assert_period_open(p_business_id, v_date);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'PERIOD_CLOSED%' THEN RETURN jsonb_build_object('ok', false, 'error_code','PERIOD_CLOSED', 'error', SQLERRM);
    ELSIF SQLERRM LIKE 'INVALID_FINANCE_CONTEXT%' THEN RETURN jsonb_build_object('ok', false, 'error_code','INVALID_FINANCE_CONTEXT', 'error', SQLERRM);
    ELSE RAISE; END IF; END;

  -- Devolución en efectivo requiere caja abierta actual (nunca la caja cerrada del
  -- original). Politica PREEXISTENTE: se preserva tal cual.
  SELECT id INTO v_caja FROM cajas WHERE business_id=p_business_id AND status='abierta' ORDER BY opened_at DESC LIMIT 1;
  IF v_fm.id IS NOT NULL AND v_metodo='efectivo' AND v_caja IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code','CASH_REGISTER_NOT_OPEN', 'error', 'No hay caja abierta para registrar la devolución en efectivo'); END IF;

  -- 7. Scope de auditoria (antes de las escrituras compensatorias). Esta RPC no
  -- escribe tablas E1 (account_movements/comprobante_payments), pero se mantiene
  -- el orden canonico M7 y protege ante futuros triggers.
  PERFORM public.finance_begin_audit_scope();

  -- 8. FM compensatorio (expense = salida) en caja ABIERTA actual (caja_id NULL →
  --    trigger asigna). Conserva el metodo real (no lo reclasifica). Fechado HOY.
  IF v_fm.id IS NOT NULL THEN
    INSERT INTO financial_movements (business_id, date, type, currency, amount, amount_ars, exchange_rate,
      source, description, created_by, metodo_pago, reference_id, reference_type)
      VALUES (p_business_id, v_date, 'expense', v_fm.currency, v_fm.amount, v_fm.amount_ars, v_fm.exchange_rate,
        'reversal', 'REVERSO cobro orden', v_actor_user_id, v_metodo, v_pay.id, 'order_payment_reversal')
      RETURNING id INTO v_new_fm;
  END IF;
  -- 9. BFE compensatorio (revenue_collection_mirror, amount NEGATIVO → net 0).
  --    Fuera del P&L: la reversa no reconoce ingreso ni genera gasto operativo.
  IF v_bfe.id IS NOT NULL THEN
    INSERT INTO business_finance_entries (business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate, payment_method, reference_order_id, source, created_by, economic_class)
      VALUES (p_business_id, v_date, 'income', v_bfe.category, 'REVERSO cobro orden — '||v_reason,
        -v_bfe.amount, v_bfe.currency, -v_bfe.amount_ars, v_bfe.exchange_rate, v_bfe.payment_method, v_bfe.reference_order_id, 'reversal', v_actor_user_id, 'revenue_collection_mirror')
      RETURNING id INTO v_new_bfe;
  END IF;

  -- 10. Metadata operativa del original (append-only: no se borra ni se altera su
  --     monto/fecha/metodo/signo). trig_payment_movements es BEFORE INSERT -> este
  --     UPDATE no dispara movimientos.
  UPDATE order_payments SET reversed_at=now(), reversed_by=v_actor_user_id WHERE id=p_order_payment_id;

  -- 11. Registro de reversa / store de idempotencia
  INSERT INTO order_payment_reversals (business_id, order_id, order_payment_id, original_financial_movement_id, original_finance_entry_id,
    reversal_financial_movement_id, reversal_finance_entry_id, amount_ars, currency, exchange_rate, reason, created_by, idempotency_key, request_hash, op, metadata)
    VALUES (p_business_id, v_pay.order_id, p_order_payment_id, v_fm.id, v_bfe.id, v_new_fm, v_new_bfe,
      COALESCE(v_pay.amount_ars, v_bfe.amount_ars, 0), v_pay.currency, v_pay.exchange_rate, v_reason, v_actor_user_id, v_key, v_hash,
      'order_payment_reversal', jsonb_build_object('method', v_metodo))
    RETURNING id INTO v_reversal_id;

  -- 12. Auditoria explicita: UN evento de negocio (la reversa del cobro)
  v_in_audit := true;
  PERFORM finance_log_audit(
    p_business_id, 'order_payment_reversal', 'order_payments', p_order_payment_id, 'reverse_order_payment_atomic',
    v_key, v_reason, v_date, 'order', v_pay.order_id,
    NULL, jsonb_build_object(
      'order_payment_id', p_order_payment_id, 'reversal_id', v_reversal_id, 'order_id', v_pay.order_id, 'reason', v_reason,
      'original_amount', v_pay.amount, 'original_amount_ars', COALESCE(v_pay.amount_ars, v_bfe.amount_ars, 0),
      'reversal_amount_ars', -COALESCE(v_pay.amount_ars, v_bfe.amount_ars, 0),
      'currency', v_pay.currency, 'exchange_rate', v_pay.exchange_rate, 'method', v_metodo,
      'original_date', v_pay.payment_date, 'reversal_date', v_date,
      'original_period', to_char(COALESCE(v_fm.date, v_pay.payment_date::date), 'YYYY-MM'), 'reversal_period', to_char(v_date,'YYYY-MM'),
      'original_financial_movement_id', v_fm.id, 'reversal_financial_movement_id', v_new_fm,
      'original_finance_entry_id', v_bfe.id, 'reversal_finance_entry_id', v_new_bfe,
      'caja_id', v_caja, 'account_movement_id', NULL));
  v_in_audit := false;

  RETURN jsonb_build_object('ok', true, 'replay', false, 'reversal_financial_movement_id', v_new_fm, 'reversal_finance_entry_id', v_new_bfe,
    'original_financial_movement_id', v_fm.id, 'original_finance_entry_id', v_bfe.id);
EXCEPTION WHEN OTHERS THEN
  -- error_code aditivo, sin exponer SQLERRM. unique_violation (carrera residual con
  -- la misma key) -> contrato de conflicto, con rollback total.
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
-- ROLLBACK (documentado): recrear la version M6 (20260706150000) sin actor
-- canonico/guard/audit/error_code; DROP trigger + funcion
-- order_payment_reversals_immutable; ALTER DROP COLUMN op; restaurar policy/GRANT
-- SELECT a authenticated.
-- ============================================================================
