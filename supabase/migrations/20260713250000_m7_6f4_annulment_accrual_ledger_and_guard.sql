-- ============================================================================
-- M7 Lote 6F.4 — annul_comprobante_atomic: fuente contable append-only +
-- integracion M7 completa. Ultima RPC economica de M7.
--
-- HALLAZGO QUE ORIGINA ESTE LOTE (probado empiricamente, ver §4 del informe):
--   v_finance_effective_comprobantes filtra `estado <> 'anulado'`, y v_finance_pnl
--   deriva ventas Y COGS de esa vista con period_date = fecha ORIGINAL. Marcar un
--   comprobante como anulado HOY borraba retroactivamente la venta de su periodo
--   original (junio pasaba de 1000/600/400 a no existir) y el periodo de la
--   anulacion no recibia ninguna compensacion visible. Un periodo cerrado
--   cambiaba de numeros sin que se escribiera un solo asiento en el.
--
-- DECISION (opcion A aprobada por el dueño del producto):
--   Separar SEMANTICAS en vez de borrar el filtro globalmente:
--     · estado operativo actual  -> v_finance_effective_comprobantes (INTACTA)
--     · historia contable        -> v_finance_sales_ledger (NUEVA, append-only)
--   La correccion es DERIVADA: no se toca ni una fila historica, no hay backfill,
--   no hay fecha de corte ni feature flag. Una anulacion de 2025 y una de hoy
--   producen exactamente el mismo par de eventos.
--
-- ┌── FASE A del release (7B.1) ─────────────────────────────────────────────┐
-- │ Este archivo NO cambia la interpretacion historica del P&L. Las vistas   │
-- │ (§B/§C) se movieron a 20260713270000_m7_6f4c_accrual_views.sql = FASE C, │
-- │ que se aplica DESPUES de reconciliar la anulacion legacy (Fase B, script │
-- │ 7B). Asi no existe ninguna ventana con el P&L mostrando un restatement   │
-- │ de +138.574 sin compensacion.                                            │
-- └─────────────────────────────────────────────────────────────────────────┘
--
-- CONTENIDO (Fase A):
--   §A  comprobante_annulments: fecha economica explicita, op, inmutabilidad.
--   §D  bfe_economic_class: source='annulment' con clase explicita (no mas
--       legacy_unclassified) y fuera del P&L.
--   §E  guard server-side contra la anulacion client-side directa.
--   §F  annul_comprobante_atomic: actor canonico, guard de periodo, hash durable,
--       pagos VIVOS unicamente, locks ordenados, audit scope E1, error_code.
-- MOVIDO a Fase C (20260713270000):
--   §B  v_finance_sales_ledger: eventos devengados sale/annulment (append-only).
--   §C  v_finance_pnl + v_finance_product_margin migradas al ledger.
--
-- NO TOCA: ARCA, CAE, numeracion, series, notas de credito, reconciliacion
-- fiscal, el CTE returns, v_finance_receivables_aging, v_finance_position.recv,
-- ni ninguna fila historica.
-- ============================================================================

-- ============================================================================
-- §A — comprobante_annulments: request/audit table endurecida
-- ============================================================================

-- Fecha economica EXPLICITA de la anulacion. NULL en las filas historicas M6:
-- esas quedan resueltas por created_at (misma expresion AR que el resto del
-- modelo). No se rellena ninguna fila: la resolucion es derivada, en la vista.
ALTER TABLE "public"."comprobante_annulments" ADD COLUMN IF NOT EXISTS "annulment_date" date;
COMMENT ON COLUMN "public"."comprobante_annulments"."annulment_date" IS
  'Fecha economica canonica de la anulacion (ar_today() al momento de anular). '
  'NULL = fila anterior a M7 6F.4: su fecha economica se deriva de created_at '
  'con (created_at AT TIME ZONE ''America/Argentina/Cordoba'')::date. No se '
  'rellena por backfill — v_finance_sales_ledger hace el COALESCE.';

ALTER TABLE "public"."comprobante_annulments" ADD COLUMN IF NOT EXISTS "op" text NOT NULL DEFAULT 'comprobante_annulment';

-- Inmutabilidad: el registro de anulacion es el asiento de la compensacion.
CREATE OR REPLACE FUNCTION "public"."comprobante_annulments_immutable"() RETURNS "trigger"
    LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION '% es append-only: DELETE no permitido', TG_TABLE_NAME USING ERRCODE='0A000';
  END IF;
  IF NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.comprobante_id IS DISTINCT FROM OLD.comprobante_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.op IS DISTINCT FROM OLD.op
     OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.annulment_date IS DISTINCT FROM OLD.annulment_date
     OR NEW.reverted_cash_ars IS DISTINCT FROM OLD.reverted_cash_ars
     OR NEW.reverted_cc_ars IS DISTINCT FROM OLD.reverted_cc_ars
     OR NEW.reverted_cogs_ars IS DISTINCT FROM OLD.reverted_cogs_ars
     OR NEW.fm_reversal_ids IS DISTINCT FROM OLD.fm_reversal_ids
     OR NEW.bfe_reversal_ids IS DISTINCT FROM OLD.bfe_reversal_ids
     OR NEW.cc_reversal_movement_id IS DISTINCT FROM OLD.cc_reversal_movement_id
     OR NEW.stock_restored_count IS DISTINCT FROM OLD.stock_restored_count THEN
    RAISE EXCEPTION '%: el registro de anulacion es inmutable', TG_TABLE_NAME USING ERRCODE='0A000';
  END IF;
  RETURN NEW;
END; $$;
ALTER FUNCTION "public"."comprobante_annulments_immutable"() OWNER TO "postgres";
DROP TRIGGER IF EXISTS "trg_comprobante_annulments_immutable" ON "public"."comprobante_annulments";
CREATE TRIGGER "trg_comprobante_annulments_immutable"
  BEFORE UPDATE OR DELETE ON "public"."comprobante_annulments"
  FOR EACH ROW EXECUTE FUNCTION "public"."comprobante_annulments_immutable"();

-- Escritura fail-closed: la unica via es la RPC SECURITY DEFINER.
-- (SELECT para authenticated se PRESERVA: existe desde M6 con policy propia y
--  §9 exige conservar exactamente los permisos actuales.)
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "public"."comprobante_annulments" FROM "anon";
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "public"."comprobante_annulments" FROM "authenticated";
REVOKE UPDATE, DELETE, TRUNCATE ON "public"."comprobante_annulments" FROM "service_role";


-- ============================================================================
-- §D — bfe_economic_class: source='annulment' explicito
-- ============================================================================
-- Los BFE espejo de la anulacion quedaban en 'legacy_unclassified' (el CASE solo
-- reconocia p_source='comprobante' para el mirror de ingreso). Ahora se clasifican
-- explicitamente como revenue_collection_mirror: simetrico con el asiento original
-- y, como aquel, EXCLUIDO del P&L — la reversion devengada la deriva el ledger,
-- no el BFE (§11: no duplicar la compensacion).
-- economic_class se setea por trigger SOLO cuando es NULL: las filas existentes
-- conservan su clase. Sin backfill.
CREATE OR REPLACE FUNCTION "public"."bfe_economic_class"(p_type text, p_category text, p_source text, p_ref_comp uuid)
 RETURNS text LANGUAGE sql IMMUTABLE
AS $function$
  SELECT CASE
    WHEN p_type='income' AND (
           p_source='comprobante'
        OR p_source='annulment'
        OR p_category='cobro_cuenta_corriente'
        OR (p_source='manual' AND p_category='ventas_productos')
    ) THEN 'revenue_collection_mirror'
    WHEN p_category='comisiones_cobro' THEN 'payment_fee'
    WHEN p_category='mercaderia' THEN 'cogs_mirror'
    WHEN p_category IN ('inventario','repuestos','insumos','mercaderia_compra') THEN 'inventory_purchase'
    WHEN p_category='compras_proveedor' OR p_source='pago_proveedor' THEN 'supplier_liability_payment'
    WHEN p_type='salary' AND p_category IN ('sueldo_dueno','retiros') THEN 'owner_withdrawal'
    WHEN p_type='salary' AND p_category IN ('sueldo_empleados','adelantos','bonos','comisiones') THEN 'employee_salary'
    WHEN p_type='salary' THEN 'owner_withdrawal'
    WHEN p_type='fixed_cost_personal' THEN 'owner_withdrawal'
    -- R10: TODO fixed_cost_local es gasto operativo del local (catch-all por tipo).
    WHEN p_type='fixed_cost_local' THEN 'operating_expense'
    WHEN p_type='variable_cost' AND p_category IN ('envios','reparaciones_tercerizadas','otros_variables') THEN 'operating_expense'
    WHEN p_type='income' AND p_source='manual' THEN 'manual_adjustment'
    ELSE 'legacy_unclassified'
  END;
$function$;

-- ============================================================================
-- §E — Guard contra la anulacion client-side directa
-- ============================================================================
-- El modelo devengado depende de que TODA anulacion tenga registro canonico y
-- compensaciones. facturacionService.anularComprobante() hace
-- `UPDATE comprobantes SET estado='anulado'` sin pasar por la RPC (hoy sin
-- consumidor activo, pero alcanzable). La base debe impedirlo.
--
-- Doble condicion, NO una GUC sola:
--   1. current_user = 'postgres' — la funcion del trigger es SECURITY INVOKER, asi
--      que current_user refleja el contexto real: 'authenticated' via PostgREST,
--      'postgres' dentro de una SECURITY DEFINER de postgres. Un cliente NO puede
--      SET ROLE postgres: es un limite de privilegio real, no un flag.
--   2. GUC m7.annulment_scope — acota a la RPC canonica. Falsificable por si sola,
--      por eso NUNCA es la unica proteccion.
-- El resto de los UPDATE del comprobante siguen permitidos sin excepcion alguna.
CREATE OR REPLACE FUNCTION "public"."comprobante_annulment_transition_guard"() RETURNS "trigger"
    LANGUAGE plpgsql AS $$
DECLARE
  v_was boolean;
  v_now boolean;
BEGIN
  v_was := (OLD.estado = 'anulado' OR OLD.status = 'cancelled' OR OLD.estado_comercial = 'anulado');
  v_now := (NEW.estado = 'anulado' OR NEW.status = 'cancelled' OR NEW.estado_comercial = 'anulado');
  IF v_now AND NOT COALESCE(v_was, false) THEN
    IF current_user <> 'postgres'
       OR COALESCE(current_setting('m7.annulment_scope', true), '') <> '1' THEN
      RAISE EXCEPTION 'La anulacion de un comprobante debe realizarse mediante annul_comprobante_atomic'
        USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
ALTER FUNCTION "public"."comprobante_annulment_transition_guard"() OWNER TO "postgres";
DROP TRIGGER IF EXISTS "trg_comprobante_annulment_transition" ON "public"."comprobantes";
CREATE TRIGGER "trg_comprobante_annulment_transition"
  BEFORE UPDATE ON "public"."comprobantes"
  FOR EACH ROW EXECUTE FUNCTION "public"."comprobante_annulment_transition_guard"();

-- ============================================================================
-- §F — annul_comprobante_atomic (M7)
-- ============================================================================
CREATE OR REPLACE FUNCTION "public"."annul_comprobante_atomic"(
  "p_comprobante_id"  uuid,
  "p_mode"            text,
  "p_motivo"          text,
  "p_restore_stock"   boolean,
  "p_idempotency_key" text
) RETURNS jsonb
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  c_tolerance_ars   constant numeric := 1.00;  -- misma tolerancia que el checkout
  c_key_max         constant integer := 200;
  v_actor           uuid := auth.uid();
  v_reason          text := NULLIF(btrim(COALESCE(p_motivo, '')), '');
  v_key             text := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_comp            comprobantes%ROWTYPE;
  v_has_access      boolean := false;
  v_request_hash    text;
  v_prev            comprobante_annulments%ROWTYPE;
  v_numero          text;
  v_open_caja_id    uuid;
  v_cobrado         numeric := 0;
  v_commissions     numeric := 0;
  v_cc_net          numeric := 0;
  v_fm_income_total numeric := 0;
  v_account_id      uuid;
  v_fm              record;
  v_item            record;
  v_bfe             record;
  v_new_fm_id       uuid;
  v_new_bfe_id      uuid;
  v_cc_mov_id       uuid;
  v_prev_stock      integer;
  v_new_stock       integer;
  v_mov_id          uuid;
  v_original_fm_ids uuid[] := '{}';
  v_original_cajas  uuid[] := '{}';
  v_fm_reversals    uuid[] := '{}';
  v_bfe_reversals   uuid[] := '{}';
  v_live_pay_ids    uuid[] := '{}';
  v_inv_movs        uuid[] := '{}';
  v_stock_json      jsonb := '[]'::jsonb;
  v_stock_count     integer := 0;
  v_reverted_cogs   numeric := 0;
  v_annulment_id    uuid;
  -- La fecha de la anulacion es un RESULTADO server-side: no se calcula en el
  -- DECLARE ni entra al hash. Solo se asigna cuando la key es NUEVA.
  v_date            date;
  v_in_audit        boolean := false;
  v_ec              text;
BEGIN
  -- ── 1. Autenticacion / validacion de entrada ──────────────────────────────
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code','UNAUTHORIZED', 'error', 'No autenticado');
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('void_same_session', 'refund_current_session', 'commercial_annulment') THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR',
      'error', 'Modo de anulación inválido: ' || COALESCE(p_mode, '(null)'));
  END IF;
  IF v_reason IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR',
      'error', 'El motivo de la anulación es obligatorio');
  END IF;
  IF v_key IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'idempotency_key requerida');
  END IF;
  IF length(v_key) > c_key_max THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR',
      'error', 'La clave de idempotencia es demasiado larga');
  END IF;

  -- ── 2. Comprobante + ownership (business_id SIEMPRE del comprobante) ──────
  SELECT * INTO v_comp FROM comprobantes WHERE id = p_comprobante_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code','COMPROBANTE_NOT_FOUND', 'error', 'Comprobante no encontrado');
  END IF;
  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id = v_comp.business_id AND owner_user_id = v_actor)
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id = v_comp.business_id AND user_id = v_actor AND COALESCE(is_active, true) = true)
  ) INTO v_has_access;
  IF NOT v_has_access THEN
    RETURN jsonb_build_object('ok', false, 'error_code','FORBIDDEN', 'error', 'Sin acceso a este negocio');
  END IF;

  -- ── 3. Hash canonico: SOLO intencion del caller ───────────────────────────
  -- op + negocio + comprobante + modo + restore_stock + motivo normalizado.
  -- NO incluye ar_today()/fecha/actor/estado/saldos/IDs generados -> idempotencia
  -- DURABLE (un retry al dia siguiente con la misma intencion sigue siendo replay).
  v_request_hash := encode(extensions.digest(jsonb_build_object(
    'op','comprobante_annulment', 'business_id', v_comp.business_id, 'comprobante_id', p_comprobante_id,
    'mode', p_mode, 'restore_stock', COALESCE(p_restore_stock, false), 'reason', v_reason)::text, 'sha256'), 'hex');

  -- ── 4. Replay/conflicto ANTES de la fecha y del guard ─────────────────────
  SELECT * INTO v_prev FROM comprobante_annulments
    WHERE business_id = v_comp.business_id AND idempotency_key = v_key;
  IF FOUND THEN
    IF v_prev.request_hash IS DISTINCT FROM v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT',
        'error', 'La idempotency_key ya fue usada con parámetros distintos. Generá una key nueva.');
    END IF;
    RETURN jsonb_build_object('ok', true, 'replay', true,
      'annulment_id', v_prev.id, 'mode', v_prev.mode,
      'reverted_cash_ars', v_prev.reverted_cash_ars, 'reverted_cc_ars', v_prev.reverted_cc_ars,
      'reverted_commissions_ars', v_prev.reverted_commissions_ars, 'reverted_cogs_ars', v_prev.reverted_cogs_ars,
      'stock_restored_count', v_prev.stock_restored_count, 'refund_caja_id', v_prev.refund_caja_id);
  END IF;

  -- ── 5. Fecha economica de la anulacion + guard SOLO de ese periodo ────────
  -- El periodo del comprobante original, sus pagos, su stock y su CC NUNCA se
  -- validan ni se reabren: anular hoy una venta de un mes cerrado es valido.
  v_date := public.ar_today();
  BEGIN PERFORM public.assert_period_open(v_comp.business_id, v_date);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'PERIOD_CLOSED%' THEN RETURN jsonb_build_object('ok', false, 'error_code','PERIOD_CLOSED', 'error', SQLERRM);
    ELSIF SQLERRM LIKE 'INVALID_FINANCE_CONTEXT%' THEN RETURN jsonb_build_object('ok', false, 'error_code','INVALID_FINANCE_CONTEXT', 'error', SQLERRM);
    ELSE RAISE; END IF; END;

  -- ── 6. LOCK del comprobante: punto de serializacion de TODA la operacion ──
  SELECT * INTO v_comp FROM comprobantes WHERE id = p_comprobante_id FOR UPDATE;

  -- ── 7. Relectura de la request YA con el lock tomado ──────────────────────
  -- Una sesion concurrente con la MISMA key pudo completar mientras esperabamos:
  -- se releee ANTES de mirar el estado para devolver replay y no ALREADY_ANNULLED.
  SELECT * INTO v_prev FROM comprobante_annulments
    WHERE business_id = v_comp.business_id AND idempotency_key = v_key;
  IF FOUND THEN
    IF v_prev.request_hash IS DISTINCT FROM v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT',
        'error', 'La idempotency_key ya fue usada con parámetros distintos. Generá una key nueva.');
    END IF;
    RETURN jsonb_build_object('ok', true, 'replay', true,
      'annulment_id', v_prev.id, 'mode', v_prev.mode,
      'reverted_cash_ars', v_prev.reverted_cash_ars, 'reverted_cc_ars', v_prev.reverted_cc_ars,
      'reverted_commissions_ars', v_prev.reverted_commissions_ars, 'reverted_cogs_ars', v_prev.reverted_cogs_ars,
      'stock_restored_count', v_prev.stock_restored_count, 'refund_caja_id', v_prev.refund_caja_id);
  END IF;

  -- ── 8. Estado (con el estado FRESCO del lock) ─────────────────────────────
  IF v_comp.estado = 'anulado' OR v_comp.status = 'cancelled' OR v_comp.estado_comercial = 'anulado'
     OR EXISTS (SELECT 1 FROM comprobante_annulments WHERE comprobante_id = v_comp.id AND status = 'completed') THEN
    RETURN jsonb_build_object('ok', false, 'error_code','ALREADY_ANNULLED', 'error', 'El comprobante ya está anulado');
  END IF;
  IF COALESCE(v_comp.tipo, v_comp.type) = 'nota_credito' THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR',
      'error', 'Una nota de crédito no se anula por este flujo');
  END IF;
  -- Fiscal: con CAE corresponde Nota de Credito. Politica PRESERVADA tal cual.
  IF v_comp.cae IS NOT NULL OR v_comp.numero_fiscal IS NOT NULL OR v_comp.estado_fiscal = 'emitido' THEN
    RETURN jsonb_build_object('ok', false, 'error_code','REQUIRES_CREDIT_NOTE',
      'error', 'Este comprobante fue autorizado por ARCA. Generá una Nota de Crédito desde el detalle del comprobante.',
      'requiere_nota_credito', true);
  END IF;

  v_numero := COALESCE(v_comp.numero_fiscal, v_comp.number, v_comp.numero, left(v_comp.id::text, 8));

  -- ── 9. Locks deterministas de las filas que vamos a compensar ─────────────
  -- Pagos VIVOS por id (los reemplazados ya fueron compensados por 6F.3).
  PERFORM 1 FROM comprobante_payments
    WHERE comprobante_id = v_comp.id AND business_id = v_comp.business_id AND replaced_at IS NULL
    ORDER BY id FOR UPDATE;
  -- Movimientos de CC originales de esta venta, por id.
  PERFORM 1 FROM account_movements
    WHERE business_id = v_comp.business_id AND reference_type = 'comprobante' AND reference_id = v_comp.id
    ORDER BY id FOR UPDATE;
  -- Inventarios AGRUPADOS por inventory_id y bloqueados por id (nunca en el orden
  -- de los items): dos anulaciones concurrentes no pueden deadlockear.
  IF COALESCE(p_restore_stock, false) THEN
    PERFORM 1 FROM inventory
      WHERE business_id = v_comp.business_id
        AND id IN (SELECT DISTINCT ci.inventory_id FROM comprobante_items ci
                    WHERE ci.comprobante_id = v_comp.id AND ci.stock_processed = true
                      AND ci.inventory_id IS NOT NULL
                      AND COALESCE(ci.tipo_linea,'producto') IN ('producto','repuesto'))
      ORDER BY id FOR UPDATE;
  END IF;

  -- ── 10. Medir lo REALMENTE registrado y VIGENTE (nunca total_bruto) ───────
  SELECT COALESCE(SUM(amount_ars), 0), COALESCE(SUM(commission_amount), 0), COALESCE(array_agg(id ORDER BY id), '{}')
    INTO v_cobrado, v_commissions, v_live_pay_ids
    FROM comprobante_payments
    WHERE comprobante_id = v_comp.id AND business_id = v_comp.business_id AND replaced_at IS NULL;

  SELECT COALESCE(SUM(debit - credit), 0) INTO v_cc_net
    FROM account_movements
    WHERE business_id = v_comp.business_id
      AND reference_type = 'comprobante' AND reference_id = v_comp.id;

  -- FM de ingreso VIGENTES: reversed_at IS NULL excluye los ingresos ya
  -- compensados por un reemplazo de cobro previo (6F.3). Sin este filtro la
  -- anulacion devolvia el eslabon viejo Y el nuevo -> caja negativa.
  SELECT COALESCE(SUM(amount_ars), 0),
         COALESCE(array_agg(id ORDER BY id), '{}'),
         COALESCE(array_agg(DISTINCT caja_id) FILTER (WHERE caja_id IS NOT NULL), '{}')
    INTO v_fm_income_total, v_original_fm_ids, v_original_cajas
    FROM financial_movements
    WHERE comprobante_id = v_comp.id AND business_id = v_comp.business_id
      AND type = 'income' AND COALESCE(sign, 1) = 1 AND reversed_at IS NULL;

  SELECT id INTO v_open_caja_id FROM cajas
    WHERE business_id = v_comp.business_id AND status = 'abierta'
    ORDER BY opened_at DESC LIMIT 1;

  -- ── 11. Validaciones por modo (politica comercial PRESERVADA) ─────────────
  IF p_mode = 'commercial_annulment' THEN
    IF v_cobrado > c_tolerance_ars THEN
      RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR',
        'error', format('Este comprobante tiene $%s cobrados. Si devolviste el dinero usá el modo devolución; si no, no corresponde anulación comercial.', round(v_cobrado, 2)));
    END IF;
  ELSE
    IF v_cobrado <= c_tolerance_ars AND v_fm_income_total <= c_tolerance_ars THEN
      RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR',
        'error', 'No hay cobros registrados para devolver — usá la anulación comercial (sin devolución de dinero).');
    END IF;
    IF v_open_caja_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR',
        'error', 'No hay caja abierta. Abrí una caja para registrar la devolución.');
    END IF;
    IF p_mode = 'void_same_session' THEN
      IF EXISTS (
        SELECT 1 FROM financial_movements
        WHERE comprobante_id = v_comp.id AND business_id = v_comp.business_id
          AND type = 'income' AND COALESCE(sign, 1) = 1 AND reversed_at IS NULL
          AND (caja_id IS DISTINCT FROM v_open_caja_id)
      ) THEN
        RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR',
          'error', 'La venta no pertenece a la caja abierta actual — usá el modo devolución (el egreso se registra en la caja de hoy sin tocar la sesión original).');
      END IF;
    END IF;
  END IF;

  -- ── 12. Audit scope E1: a partir de aca escribimos tablas con backstop ────
  PERFORM public.finance_begin_audit_scope();

  -- ── 13. Compensacion de caja: UN egreso espejo por CADA ingreso VIGENTE ───
  FOR v_fm IN
    SELECT * FROM financial_movements
    WHERE comprobante_id = v_comp.id AND business_id = v_comp.business_id
      AND type = 'income' AND COALESCE(sign, 1) = 1 AND reversed_at IS NULL
    ORDER BY id
  LOOP
    INSERT INTO financial_movements (
      business_id, date, type, currency, amount, amount_ars, exchange_rate,
      source, source_id, comprobante_id, description, created_by, sign,
      metodo_pago, caja_id, reference_type, reference_id, movement_type
    ) VALUES (
      v_comp.business_id, v_date, 'expense',
      v_fm.currency, v_fm.amount, v_fm.amount_ars, COALESCE(v_fm.exchange_rate, 1),
      'comprobante', v_fm.source_id, v_comp.id,
      'ANULACIÓN Comprobante #' || v_numero || ' — reversa de mov. ' || v_fm.id || ' · ' || v_reason,
      v_actor, -1,
      v_fm.metodo_pago, v_open_caja_id, 'annulment_reversal', v_fm.id, 'refund'
    ) RETURNING id INTO v_new_fm_id;
    v_fm_reversals := v_fm_reversals || v_new_fm_id;
  END LOOP;

  -- ── 14. Espejos negativos de BFE (trazabilidad; el P&L NO los lee) ────────
  -- La reversion devengada de venta/COGS la DERIVA v_finance_sales_ledger desde
  -- comprobante_annulments. Estos espejos se conservan como trazabilidad y para
  -- la comision (payment_fee), que si es un gasto real del P&L y debe revertirse.
  FOR v_bfe IN
    SELECT * FROM business_finance_entries
    WHERE business_id = v_comp.business_id
      AND reference_comprobante_id = v_comp.id
      AND amount_ars > 0
      AND (type = 'income' OR (type = 'variable_cost' AND category IN ('comisiones_cobro', 'mercaderia')))
    ORDER BY created_at
  LOOP
    INSERT INTO business_finance_entries (
      business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate,
      payment_method, reference_comprobante_id, source, created_by
    ) VALUES (
      v_comp.business_id, v_date, v_bfe.type, v_bfe.category,
      'ANULACIÓN Comprobante #' || v_numero || ' — reversa de asiento ' || v_bfe.id,
      -v_bfe.amount, v_bfe.currency, -v_bfe.amount_ars, COALESCE(v_bfe.exchange_rate, 1),
      v_bfe.payment_method, v_comp.id, 'annulment', v_actor
    ) RETURNING id INTO v_new_bfe_id;
    v_bfe_reversals := v_bfe_reversals || v_new_bfe_id;
    IF v_bfe.type = 'variable_cost' AND v_bfe.category = 'mercaderia' THEN
      v_reverted_cogs := v_reverted_cogs + v_bfe.amount_ars;
    END IF;
  END LOOP;

  -- COGS historico sin referencia (BFE de checkouts anteriores a 20260702110000).
  FOR v_bfe IN
    SELECT * FROM business_finance_entries
    WHERE business_id = v_comp.business_id
      AND reference_comprobante_id IS NULL
      AND type = 'variable_cost' AND category = 'mercaderia'
      AND amount_ars > 0
      AND description = 'Costo de productos - Comprobante #' || v_numero
    ORDER BY created_at
  LOOP
    INSERT INTO business_finance_entries (
      business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate,
      reference_comprobante_id, source, created_by
    ) VALUES (
      v_comp.business_id, v_date, 'variable_cost', 'mercaderia',
      'ANULACIÓN Comprobante #' || v_numero || ' — reversa de asiento ' || v_bfe.id,
      -v_bfe.amount, v_bfe.currency, -v_bfe.amount_ars, COALESCE(v_bfe.exchange_rate, 1),
      v_comp.id, 'annulment', v_actor
    ) RETURNING id INTO v_new_bfe_id;
    v_bfe_reversals := v_bfe_reversals || v_new_bfe_id;
    v_reverted_cogs := v_reverted_cogs + v_bfe.amount_ars;
  END LOOP;

  -- ── 15. Cuenta corriente: movimiento contrario HOY (historico intacto) ────
  IF v_cc_net > 0.01 THEN
    SELECT account_id INTO v_account_id
      FROM account_movements
      WHERE business_id = v_comp.business_id
        AND reference_type = 'comprobante' AND reference_id = v_comp.id
      ORDER BY created_at LIMIT 1;
    IF v_account_id IS NOT NULL THEN
      INSERT INTO account_movements (
        business_id, account_id, date, type, description, debit, credit,
        reference_type, reference_id, created_by
      ) VALUES (
        v_comp.business_id, v_account_id, v_date, 'ajuste',
        'ANULACIÓN Comprobante #' || v_numero || ' · ' || v_reason,
        0, v_cc_net, 'comprobante', v_comp.id, v_actor
      ) RETURNING id INTO v_cc_mov_id;
    END IF;
  END IF;

  -- ── 16. Stock: append-only, agrupado por inventory_id, cantidades enteras ─
  IF COALESCE(p_restore_stock, false) THEN
    FOR v_item IN
      SELECT ci.inventory_id, SUM(ci.cantidad)::integer AS cantidad
      FROM comprobante_items ci
      WHERE ci.comprobante_id = v_comp.id
        AND ci.stock_processed = true
        AND ci.inventory_id IS NOT NULL
        AND COALESCE(ci.tipo_linea, 'producto') IN ('producto', 'repuesto')
      GROUP BY ci.inventory_id
      ORDER BY ci.inventory_id
    LOOP
      SELECT stock_quantity INTO v_prev_stock FROM inventory
        WHERE id = v_item.inventory_id AND business_id = v_comp.business_id;
      IF FOUND THEN
        v_prev_stock := COALESCE(v_prev_stock, 0);
        v_new_stock  := v_prev_stock + v_item.cantidad;
        UPDATE inventory SET stock_quantity = v_new_stock, updated_at = now()
          WHERE id = v_item.inventory_id AND business_id = v_comp.business_id;
        INSERT INTO inventory_movements (
          business_id, inventory_item_id, movement_type, quantity, previous_stock,
          new_stock, reference_type, reference_id, note, created_by
        ) VALUES (
          v_comp.business_id, v_item.inventory_id, 'return',
          v_item.cantidad, v_prev_stock, v_new_stock,
          'comprobante', v_comp.id,
          'Devolución por anulación de comprobante #' || v_numero, v_actor
        ) RETURNING id INTO v_mov_id;
        v_inv_movs   := v_inv_movs || v_mov_id;
        v_stock_json := v_stock_json || jsonb_build_object(
          'inventory_id', v_item.inventory_id, 'qty', v_item.cantidad,
          'prev_stock', v_prev_stock, 'new_stock', v_new_stock, 'movement_id', v_mov_id);
        v_stock_count := v_stock_count + 1;
      END IF;
    END LOOP;
    -- Marcador exactamente-una-vez sobre TODAS las lineas procesadas.
    UPDATE comprobante_items
      SET stock_processed = false, stock_processed_at = NULL, stock_movement_id = NULL
      WHERE comprobante_id = v_comp.id AND stock_processed = true;
  END IF;

  -- ── 17. Metadata OPERATIVA del comprobante ───────────────────────────────
  -- Solo estado + rastro de anulacion. Fecha, numero, punto de venta, tipo,
  -- moneda, totales, cliente, orden, condicion fiscal, CAE y su vencimiento
  -- NO se tocan: el comprobante sigue siendo el mismo documento.
  PERFORM set_config('m7.annulment_scope', '1', true);
  UPDATE comprobantes SET
    estado           = 'anulado',
    status           = 'cancelled',
    estado_comercial = 'anulado',
    estado_fiscal    = CASE WHEN estado_fiscal = 'no_fiscal' THEN 'no_fiscal' ELSE 'anulado_fiscal' END,
    afip_response    = COALESCE(afip_response, '{}'::jsonb) || jsonb_build_object(
                         'anulacion', jsonb_build_object(
                           'motivo', v_reason, 'modo', p_mode,
                           'restore_stock', COALESCE(p_restore_stock, false), 'fecha', v_date)),
    updated_at       = now()
  WHERE id = v_comp.id;

  -- ── 18. Registro canonico (idempotencia + fuente del evento devengado) ────
  INSERT INTO comprobante_annulments (
    business_id, comprobante_id, user_id, idempotency_key, request_hash, op,
    mode, motivo, restore_stock, stock_restored_count, annulment_date,
    original_caja_ids, refund_caja_id,
    reverted_cash_ars, reverted_cc_ars, reverted_commissions_ars, reverted_cogs_ars,
    original_fm_ids, fm_reversal_ids, bfe_reversal_ids, cc_reversal_movement_id
  ) VALUES (
    v_comp.business_id, v_comp.id, v_actor, v_key, v_request_hash, 'comprobante_annulment',
    p_mode, v_reason, COALESCE(p_restore_stock, false), v_stock_count, v_date,
    v_original_cajas, v_open_caja_id,
    GREATEST(v_cobrado, v_fm_income_total), v_cc_net, v_commissions, v_reverted_cogs,
    v_original_fm_ids, v_fm_reversals, v_bfe_reversals, v_cc_mov_id
  ) RETURNING id INTO v_annulment_id;

  -- ── 19. UN unico evento de auditoria ─────────────────────────────────────
  v_in_audit := true;
  PERFORM finance_log_audit(
    v_comp.business_id, 'comprobante_annulment', 'comprobantes', v_comp.id, 'annul_comprobante_atomic',
    v_key, v_reason, v_date, 'comprobante', v_comp.id,
    NULL, jsonb_build_object(
      'comprobante_id', v_comp.id, 'annulment_id', v_annulment_id, 'numero', v_numero,
      'reason', v_reason, 'mode', p_mode,
      'original_date', (COALESCE(v_comp.fecha, v_comp.date, v_comp.created_at) AT TIME ZONE 'America/Argentina/Cordoba')::date,
      'annulment_date', v_date,
      'original_period', to_char((COALESCE(v_comp.fecha, v_comp.date, v_comp.created_at) AT TIME ZONE 'America/Argentina/Cordoba')::date, 'YYYY-MM'),
      'annulment_period', to_char(v_date, 'YYYY-MM'),
      'customer_id', v_comp.customer_id, 'order_id', v_comp.order_id, 'sale_total', v_comp.total,
      'reverted_cash_ars', GREATEST(v_cobrado, v_fm_income_total), 'reverted_cc_ars', v_cc_net,
      'reverted_commissions_ars', v_commissions, 'reverted_cogs_ars', v_reverted_cogs,
      'live_payment_ids', to_jsonb(v_live_pay_ids),
      'original_fm_ids', to_jsonb(v_original_fm_ids), 'fm_reversal_ids', to_jsonb(v_fm_reversals),
      'bfe_reversal_ids', to_jsonb(v_bfe_reversals), 'cc_reversal_movement_id', v_cc_mov_id,
      'stock_restored', v_stock_json, 'inventory_movement_ids', to_jsonb(v_inv_movs),
      'original_caja_ids', to_jsonb(v_original_cajas), 'refund_caja_id', v_open_caja_id,
      'actor', v_actor, 'request_hash', v_request_hash));
  v_in_audit := false;

  RETURN jsonb_build_object(
    'ok', true, 'replay', false,
    'annulment_id', v_annulment_id, 'mode', p_mode,
    'reverted_cash_ars', GREATEST(v_cobrado, v_fm_income_total),
    'reverted_cc_ars', v_cc_net,
    'reverted_commissions_ars', v_commissions,
    'reverted_cogs_ars', v_reverted_cogs,
    'stock_restored_count', v_stock_count,
    'refund_caja_id', v_open_caja_id
  );

EXCEPTION WHEN OTHERS THEN
  -- Rollback TOTAL al savepoint implicito: nunca queda una anulacion a medias
  -- (ni compensacion parcial, ni request huerfana, ni auditoria parcial).
  v_ec := CASE
    WHEN v_in_audit THEN 'AUDIT_FAILED'
    WHEN SQLSTATE = '23505' THEN 'IDEMPOTENCY_CONFLICT'
    ELSE 'INTERNAL_ERROR' END;
  IF v_ec = 'IDEMPOTENCY_CONFLICT' THEN
    RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT',
      'error', 'La idempotency_key ya fue usada con parámetros distintos. Generá una key nueva.');
  END IF;
  RETURN jsonb_build_object('ok', false, 'error_code', v_ec,
    'error', CASE WHEN v_ec='AUDIT_FAILED' THEN 'No se pudo registrar la auditoria de la operacion'
                  ELSE 'No se pudo completar la operacion' END);
END;
$$;

ALTER FUNCTION "public"."annul_comprobante_atomic"(uuid, text, text, boolean, text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."annul_comprobante_atomic"(uuid, text, text, boolean, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."annul_comprobante_atomic"(uuid, text, text, boolean, text) FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."annul_comprobante_atomic"(uuid, text, text, boolean, text) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."annul_comprobante_atomic"(uuid, text, text, boolean, text) TO "service_role";

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado):
--   DROP TRIGGER trg_comprobante_annulment_transition ON comprobantes;
--   DROP FUNCTION comprobante_annulment_transition_guard();
--   DROP TRIGGER trg_comprobante_annulments_immutable ON comprobante_annulments;
--   DROP FUNCTION comprobante_annulments_immutable();
--   ALTER TABLE comprobante_annulments DROP COLUMN annulment_date, DROP COLUMN op;
--   Recrear v_finance_pnl / v_finance_product_margin sobre
--     v_finance_effective_comprobantes (20260704120000) y DROP VIEW
--     v_finance_sales_ledger;  -- vuelve la exclusion retroactiva
--   Recrear bfe_economic_class sin la rama p_source='annulment';
--   Recrear annul_comprobante_atomic de 20260702120000.
-- ============================================================================

