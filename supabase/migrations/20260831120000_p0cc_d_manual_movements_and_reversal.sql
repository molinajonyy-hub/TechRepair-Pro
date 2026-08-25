-- ============================================================================
-- P0-CC · CC-D — Movimientos manuales auditados + REVERSA canónica del cobro.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- DEFECTO 1 — Un cobro equivocado era irreversible
-- ─────────────────────────────────────────────────────────────────────────────
-- El modelo de reversa de M7 se construyó POR DOCUMENTO: anular un comprobante,
-- revertir una imputación. El cobro a cuenta —que no es un documento— quedó sin
-- la suya. Y el ledger es append-only para el cliente: `DELETE` da 42501 y
-- `UPDATE` está revocado.
--
-- Resultado: un cobro mal cargado (monto equivocado, cliente equivocado, cobro
-- que nunca ocurrió) no se podía deshacer por ninguna vía de producto. La única
-- salida era un ajuste manual en sentido contrario, que deja el saldo bien pero
-- NO revierte el `financial_movement`: la caja se queda con el ingreso fantasma.
--
-- En una beta con dinero real, equivocarse una vez es inevitable.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- DEFECTO 2 — La deuda manual y el ajuste escribían el ledger a mano
-- ─────────────────────────────────────────────────────────────────────────────
-- `registerDebt` y `addAdjustment` seguían haciendo INSERT directo: sin
-- capacidad server-side, sin idempotencia, sin guard de período y sin auditoría
-- explícita. Mientras ese camino exista no se puede cerrar CC-E.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SEMÁNTICA: por qué NO se inventa un `type` nuevo
-- ─────────────────────────────────────────────────────────────────────────────
-- `account_movements.type` tiene un CHECK cerrado:
--   venta | compra | gasto | pago | ajuste | apertura
--
-- Una deuda cargada a mano NO es una `venta`: no hay comprobante, no hay ítems,
-- no reconoce ingreso. Llamarla `venta` contaminaría el devengado. Y agregar un
-- valor al CHECK de la tabla del ledger obliga a revisar cada vista y cada
-- consumidor que hoy hace `type='venta'`.
--
-- La distinción que el pedido busca —deuda manual vs ajuste— ya está en el
-- modelo, y es la DIRECCIÓN: `debit` sube la deuda, `credit` la baja. Eso es un
-- hecho contable, no una etiqueta. Ambas van como `ajuste`, se distinguen por
-- el signo, y `reference_type` guarda la intención declarada para que la
-- auditoría pueda leerla. Nada queda sin semántica.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- LA REVERSA: contra-movimientos, nunca borrado
-- ─────────────────────────────────────────────────────────────────────────────
-- Se sigue el patrón M7 6F.2 (`reverse_order_payment_atomic`) sin desviarse:
--
--   · la reversa se fecha HOY (`ar_today()`), NUNCA en la fecha del original.
--     Sólo se valida el período de HOY: revertir hoy un cobro de un mes cerrado
--     es válido y no reabre aquel mes;
--   · FM compensatorio `expense` con el MISMO método (no se reclasifica), en la
--     caja abierta actual — `caja_id` NULL y el trigger la asigna;
--   · BFE compensatorio `income` con importe NEGATIVO y
--     `economic_class='revenue_collection_mirror'`: netea a 0 y queda fuera del
--     P&L. La reversa no reconoce ingreso ni genera gasto operativo;
--   · el hash de idempotencia se calcula sobre la INTENCIÓN del caller
--     (op + negocio + movimiento + motivo), sin fecha: un reintento al día
--     siguiente sigue siendo replay y no genera una segunda reversa.
--
-- La garantía de "una sola reversa" NO depende del hash: es un UNIQUE sobre
-- `original_movement_id`. Dos llamadas con claves DISTINTAS compiten por esa
-- fila y la segunda recibe ALREADY_REVERSED.
--
-- El ledger no se toca: no se agrega `reversed_at` a `account_movements`. El
-- estado de reversa vive en su propia tabla; el ledger sigue siendo append-only
-- de verdad.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- COBRO YA IMPUTADO
-- ─────────────────────────────────────────────────────────────────────────────
-- Si el cobro tiene imputaciones activas contra comprobantes, revertirlo las
-- dejaría colgadas apuntando a un cobro que ya no existe. NO se revierten en
-- cascada: se corta con PAYMENT_ALLOCATED y se pide desimputar primero con
-- `reverse_payment_allocation_atomic`, que ya existe. Deshacer en cascada algo
-- que el usuario no pidió es justo lo que no se hace con dinero.
-- ============================================================================

BEGIN;

-- ── 1. Store de reversas de cobro de cuenta corriente ───────────────────────
CREATE TABLE IF NOT EXISTS "public"."account_payment_reversals" (
  "id"                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id"                    uuid NOT NULL REFERENCES "public"."businesses"("id"),
  "account_id"                     uuid NOT NULL,
  -- El cobro original. UNIQUE: es la garantía estructural de una sola reversa.
  "original_movement_id"           uuid NOT NULL,
  "original_financial_movement_id" uuid,
  "original_finance_entry_id"      uuid,
  -- Las tres patas de la compensación.
  "reversal_movement_id"           uuid,
  "reversal_financial_movement_id" uuid,
  "reversal_finance_entry_id"      uuid,
  "amount_ars"                     numeric NOT NULL,
  "reason"                         text    NOT NULL,
  "created_by"                     uuid,
  "idempotency_key"                text,
  "request_hash"                   text,
  "op"                             text NOT NULL DEFAULT 'customer_account_payment_reversal',
  "metadata"                       jsonb,
  "created_at"                     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "apr_one_reversal_per_movement" UNIQUE ("original_movement_id"),
  CONSTRAINT "apr_key_uniq" UNIQUE ("business_id", "idempotency_key")
);

ALTER TABLE "public"."account_payment_reversals" ENABLE ROW LEVEL SECURITY;

-- Append-only e inmutable, igual que `order_payment_reversals`.
CREATE OR REPLACE FUNCTION "public"."account_payment_reversals_immutable"() RETURNS "trigger"
    LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $$
BEGIN
  RAISE EXCEPTION 'account_payment_reversals es append-only: % no permitido', TG_OP USING ERRCODE='0A000';
END; $$;
ALTER FUNCTION "public"."account_payment_reversals_immutable"() OWNER TO "postgres";
DROP TRIGGER IF EXISTS "trg_account_payment_reversals_immutable" ON "public"."account_payment_reversals";
CREATE TRIGGER "trg_account_payment_reversals_immutable"
  BEFORE UPDATE OR DELETE ON "public"."account_payment_reversals"
  FOR EACH ROW EXECUTE FUNCTION "public"."account_payment_reversals_immutable"();

-- Lectura sólo con capacidad financiera; escritura sólo por la RPC (SECDEF).
DROP POLICY IF EXISTS "account_payment_reversals_select" ON "public"."account_payment_reversals";
CREATE POLICY "account_payment_reversals_select" ON "public"."account_payment_reversals"
  FOR SELECT USING (
    "public"."current_business_id"() = "business_id"
    AND "public"."current_user_can"('finance')
    AND "public"."business_has_feature"('currentAccounts')
  );
REVOKE ALL ON "public"."account_payment_reversals" FROM PUBLIC, "anon", "authenticated";
GRANT SELECT ON "public"."account_payment_reversals" TO "authenticated";
GRANT SELECT, INSERT ON "public"."account_payment_reversals" TO "service_role";

-- ── 2. Movimiento manual auditado (deuda / ajuste) ──────────────────────────
CREATE OR REPLACE FUNCTION "public"."record_customer_account_adjustment_atomic"(
  p_business_id uuid,
  p_account_id  uuid,
  p_amount      numeric,
  p_direction   text,          -- 'debit' sube la deuda | 'credit' la baja
  p_reason      text,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  c_key_max       constant int := 200;
  v_user          uuid := auth.uid();
  v_is_member     boolean := false;
  v_account       accounts%ROWTYPE;
  v_dir           text := lower(btrim(COALESCE(p_direction,'')));
  v_reason        text := NULLIF(btrim(COALESCE(p_reason,'')), '');
  v_key           text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_hash          text;
  v_existing      account_payment_requests%ROWTYPE;
  v_req_id        uuid;
  v_mov_id        uuid;
  v_new_balance   numeric;
  v_economic_date date;
  v_stage         text := 'init';
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','UNAUTHORIZED', 'error', 'No autenticado'); END IF;
  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND COALESCE(user_id,id)=v_user AND COALESCE(is_active,true))) INTO v_is_member;
  IF NOT v_is_member THEN RETURN jsonb_build_object('ok', false, 'error_code','FORBIDDEN', 'error', 'Sin acceso a este negocio'); END IF;
  IF NOT public.current_user_can('finance') THEN
    RETURN jsonb_build_object('ok', false, 'error_code','FORBIDDEN', 'error', 'Sin permiso para operaciones financieras'); END IF;

  IF v_dir NOT IN ('debit','credit') THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La dirección del movimiento debe ser debit o credit'); END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El monto debe ser mayor a 0'); END IF;
  IF v_reason IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El motivo del movimiento es obligatorio'); END IF;
  IF v_key IS NOT NULL AND length(v_key) > c_key_max THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La clave de idempotencia es demasiado larga'); END IF;

  SELECT * INTO v_account FROM accounts WHERE id=p_account_id AND business_id=p_business_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error_code','ACCOUNT_NOT_FOUND', 'error', 'Cuenta inexistente'); END IF;

  v_economic_date := public.ar_today();

  -- Idempotencia sobre el store existente de requests de cuenta.
  IF v_key IS NOT NULL THEN
    v_hash := encode(extensions.digest(jsonb_build_object(
      'op','customer_account_adjustment', 'business_id',p_business_id, 'account_id',p_account_id,
      'amount',round(p_amount,2), 'direction',v_dir, 'reason',v_reason)::text, 'sha256'), 'hex');
    SELECT * INTO v_existing FROM account_payment_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta clave ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'account_movement_id', v_existing.movement_id);
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
    INSERT INTO account_payment_requests (business_id, user_id, op, idempotency_key, request_hash)
      VALUES (p_business_id, v_user, 'customer_account_adjustment', v_key, v_hash)
      ON CONFLICT (business_id, idempotency_key) DO NOTHING RETURNING id INTO v_req_id;
    IF v_req_id IS NULL THEN
      SELECT * INTO v_existing FROM account_payment_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta clave ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'account_movement_id', v_existing.movement_id);
    END IF;
  END IF;

  PERFORM public.finance_begin_audit_scope();

  -- Un ajuste NO mueve caja ni reconoce ingreso: corrige el saldo de la cuenta.
  -- Por eso escribe SÓLO el ledger. Si moviera caja sería un cobro, y para eso
  -- está `record_customer_account_payment_atomic`.
  v_stage := 'write';
  INSERT INTO account_movements (business_id, account_id, date, type, description, debit, credit, balance_after, reference_type, created_by)
    VALUES (p_business_id, p_account_id, v_economic_date, 'ajuste', v_reason,
            CASE WHEN v_dir='debit'  THEN p_amount ELSE 0 END,
            CASE WHEN v_dir='credit' THEN p_amount ELSE 0 END,
            0,
            CASE WHEN v_dir='debit' THEN 'manual_debt' ELSE 'manual_adjustment' END,
            v_user)
    RETURNING id INTO v_mov_id;

  SELECT balance_after INTO v_new_balance FROM account_movements WHERE id=v_mov_id;
  IF v_key IS NOT NULL THEN UPDATE account_payment_requests SET movement_id=v_mov_id WHERE id=v_req_id; END IF;

  v_stage := 'audit';
  PERFORM finance_log_audit(
    p_business_id, 'customer_account_adjustment', 'account_movements', v_mov_id, 'record_customer_account_adjustment_atomic',
    v_key, v_reason, v_economic_date, 'account', p_account_id,
    NULL, jsonb_build_object('account_id', p_account_id, 'amount', p_amount, 'direction', v_dir,
      'currency','ARS', 'amount_ars', p_amount, 'new_balance', v_new_balance));

  RETURN jsonb_build_object('ok', true, 'replay', false, 'account_movement_id', v_mov_id, 'balance', v_new_balance);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false,
    'error_code', CASE WHEN v_stage='audit' THEN 'AUDIT_FAILED' ELSE 'INTERNAL_ERROR' END,
    'error', CASE WHEN v_stage='audit' THEN 'No se pudo registrar la auditoría de la operación'
                  ELSE 'No se pudo completar la operación' END);
END;
$$;

ALTER FUNCTION "public"."record_customer_account_adjustment_atomic"(uuid,uuid,numeric,text,text,text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."record_customer_account_adjustment_atomic"(uuid,uuid,numeric,text,text,text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."record_customer_account_adjustment_atomic"(uuid,uuid,numeric,text,text,text) TO "authenticated","service_role";

-- ── 3. REVERSA del cobro ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "public"."reverse_customer_account_payment_atomic"(
  p_business_id uuid,
  p_movement_id uuid,          -- el account_movement del cobro original
  p_reason      text,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  c_key_max       constant int := 200;
  v_user          uuid := auth.uid();
  v_is_member     boolean := false;
  v_reason        text := NULLIF(btrim(COALESCE(p_reason,'')), '');
  v_key           text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_hash          text;
  v_existing      account_payment_reversals%ROWTYPE;
  v_orig          account_movements%ROWTYPE;
  v_fm            financial_movements%ROWTYPE;
  v_bfe           business_finance_entries%ROWTYPE;
  v_alloc_n       int;
  v_date          date;
  v_new_mov       uuid;
  v_new_fm        uuid;
  v_new_bfe       uuid;
  v_rev_id        uuid;
  v_new_balance   numeric;
  v_stage         text := 'init';
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','UNAUTHORIZED', 'error', 'No autenticado'); END IF;
  IF v_reason IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El motivo de la reversa es obligatorio'); END IF;
  IF v_key IS NOT NULL AND length(v_key) > c_key_max THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La clave de idempotencia es demasiado larga'); END IF;

  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND COALESCE(user_id,id)=v_user AND COALESCE(is_active,true))) INTO v_is_member;
  IF NOT v_is_member THEN RETURN jsonb_build_object('ok', false, 'error_code','FORBIDDEN', 'error', 'Sin acceso a este negocio'); END IF;
  IF NOT public.current_user_can('finance') THEN
    RETURN jsonb_build_object('ok', false, 'error_code','FORBIDDEN', 'error', 'Sin permiso para operaciones financieras'); END IF;

  -- Replay por clave: se responde ANTES de resolver fecha, guards y escrituras.
  -- El hash NO incluye la fecha: un reintento al día siguiente sigue siendo replay.
  IF v_key IS NOT NULL THEN
    v_hash := encode(extensions.digest(jsonb_build_object(
      'op','customer_account_payment_reversal', 'business_id',p_business_id,
      'movement_id',p_movement_id, 'reason',v_reason)::text, 'sha256'), 'hex');
    SELECT * INTO v_existing FROM account_payment_reversals WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta clave ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true,
        'reversal_movement_id', v_existing.reversal_movement_id,
        'reversal_financial_movement_id', v_existing.reversal_financial_movement_id);
    END IF;
  END IF;

  -- LOCK del cobro original: serializa contra dos reversas con claves DISTINTAS.
  SELECT * INTO v_orig FROM account_movements
    WHERE id=p_movement_id AND business_id=p_business_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error_code','NOT_FOUND', 'error', 'El cobro no existe en este negocio'); END IF;
  IF v_orig.type <> 'pago' OR v_orig.credit <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El movimiento indicado no es un cobro de cuenta corriente'); END IF;

  -- Ya reversado: lo dice el UNIQUE, no el hash. Se lee bajo el lock.
  IF EXISTS (SELECT 1 FROM account_payment_reversals WHERE original_movement_id=p_movement_id) THEN
    RETURN jsonb_build_object('ok', false, 'error_code','ALREADY_REVERSED', 'error', 'Este cobro ya fue reversado'); END IF;

  -- Este movimiento NO puede ser, a su vez, la reversa de otro cobro.
  IF v_orig.reference_type = 'account_payment_reversal' THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'No se puede reversar una reversa'); END IF;

  -- Imputado: no se deshace en cascada algo que el usuario no pidió.
  SELECT count(*) INTO v_alloc_n FROM customer_account_payment_allocations
    WHERE payment_movement_id = p_movement_id AND status = 'active';
  IF v_alloc_n > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error_code','PAYMENT_ALLOCATED',
      'error', 'Este cobro está imputado a comprobantes. Revertí primero la imputación y después el cobro.'); END IF;

  -- Las patas financieras del cobro original, por su enlace canónico.
  SELECT * INTO v_fm FROM financial_movements
    WHERE business_id=p_business_id AND reference_type='account_movement' AND reference_id=p_movement_id
    ORDER BY created_at LIMIT 1;
  SELECT * INTO v_bfe FROM business_finance_entries
    WHERE business_id=p_business_id AND category='cobro_cuenta_corriente'
      AND date=v_orig.date AND amount_ars=v_orig.credit AND source='cobro_cc'
    ORDER BY created_at LIMIT 1;

  -- La reversa se fecha HOY. Sólo se valida el período de HOY: el mes del cobro
  -- original nunca se reabre.
  v_date := public.ar_today();
  BEGIN
    PERFORM public.assert_period_open(p_business_id, v_date);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'PERIOD_CLOSED%' THEN RETURN jsonb_build_object('ok', false, 'error_code','PERIOD_CLOSED', 'error', SQLERRM);
    ELSIF SQLERRM LIKE 'INVALID_FINANCE_CONTEXT%' THEN RETURN jsonb_build_object('ok', false, 'error_code','INVALID_FINANCE_CONTEXT', 'error', SQLERRM);
    ELSE RAISE; END IF;
  END;

  PERFORM public.finance_begin_audit_scope();
  v_stage := 'write';

  -- (a) Ledger: contra-movimiento que devuelve la deuda. No se borra el cobro.
  INSERT INTO account_movements (business_id, account_id, date, type, description, debit, credit, balance_after, reference_type, reference_id, created_by)
    VALUES (p_business_id, v_orig.account_id, v_date, 'ajuste',
      'REVERSO cobro — ' || v_reason, v_orig.credit, 0, 0,
      'account_payment_reversal', p_movement_id, v_user)
    RETURNING id INTO v_new_mov;

  -- (b) Caja: FM compensatorio `expense`, mismo método (no se reclasifica),
  --     en la caja abierta actual (caja_id NULL -> el trigger la asigna).
  IF v_fm.id IS NOT NULL THEN
    INSERT INTO financial_movements (business_id, date, type, currency, amount, amount_ars, exchange_rate,
      source, description, created_by, metodo_pago, reference_id, reference_type)
      VALUES (p_business_id, v_date, 'expense', v_fm.currency, v_fm.amount, v_fm.amount_ars, v_fm.exchange_rate,
        'reversal', 'REVERSO cobro de cuenta corriente', v_user, v_fm.metodo_pago,
        p_movement_id, 'account_payment_reversal')
      RETURNING id INTO v_new_fm;
  END IF;

  -- (c) BFE compensatorio: income NEGATIVO, espejo, fuera del P&L.
  IF v_bfe.id IS NOT NULL THEN
    INSERT INTO business_finance_entries (business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate, payment_method, source, created_by, economic_class)
      VALUES (p_business_id, v_date, 'income', v_bfe.category, 'REVERSO cobro de cuenta corriente — ' || v_reason,
        -v_bfe.amount, v_bfe.currency, -v_bfe.amount_ars, v_bfe.exchange_rate, v_bfe.payment_method,
        'reversal', v_user, 'revenue_collection_mirror')
      RETURNING id INTO v_new_bfe;
  END IF;

  SELECT balance_after INTO v_new_balance FROM account_movements WHERE id=v_new_mov;

  -- (d) Registro de la reversa. El UNIQUE sobre original_movement_id es lo que
  --     hace imposible la doble reversa aun con claves distintas.
  INSERT INTO account_payment_reversals (business_id, account_id, original_movement_id,
    original_financial_movement_id, original_finance_entry_id,
    reversal_movement_id, reversal_financial_movement_id, reversal_finance_entry_id,
    amount_ars, reason, created_by, idempotency_key, request_hash, op, metadata)
    VALUES (p_business_id, v_orig.account_id, p_movement_id, v_fm.id, v_bfe.id,
      v_new_mov, v_new_fm, v_new_bfe, v_orig.credit, v_reason, v_user, v_key, v_hash,
      'customer_account_payment_reversal',
      jsonb_build_object('method', v_fm.metodo_pago, 'original_date', v_orig.date, 'reversal_date', v_date))
    RETURNING id INTO v_rev_id;

  v_stage := 'audit';
  PERFORM finance_log_audit(
    p_business_id, 'customer_account_payment_reversal', 'account_movements', p_movement_id,
    'reverse_customer_account_payment_atomic',
    v_key, v_reason, v_date, 'account', v_orig.account_id,
    NULL, jsonb_build_object('reversal_id', v_rev_id, 'original_movement_id', p_movement_id,
      'reversal_movement_id', v_new_mov, 'amount_ars', v_orig.credit,
      'original_financial_movement_id', v_fm.id, 'reversal_financial_movement_id', v_new_fm,
      'original_finance_entry_id', v_bfe.id, 'reversal_finance_entry_id', v_new_bfe,
      'method', v_fm.metodo_pago, 'original_date', v_orig.date, 'reversal_date', v_date,
      'original_period', to_char(v_orig.date,'YYYY-MM'), 'reversal_period', to_char(v_date,'YYYY-MM'),
      'new_balance', v_new_balance, 'reason', v_reason));

  RETURN jsonb_build_object('ok', true, 'replay', false,
    'reversal_id', v_rev_id, 'reversal_movement_id', v_new_mov,
    'reversal_financial_movement_id', v_new_fm, 'reversal_finance_entry_id', v_new_bfe,
    'balance', v_new_balance);
EXCEPTION
  -- Carrera real: dos reversas simultáneas con claves distintas. El UNIQUE gana.
  WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'error_code','ALREADY_REVERSED', 'error', 'Este cobro ya fue reversado');
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false,
      'error_code', CASE WHEN v_stage='audit' THEN 'AUDIT_FAILED' ELSE 'INTERNAL_ERROR' END,
      'error', CASE WHEN v_stage='audit' THEN 'No se pudo registrar la auditoría de la operación'
                    ELSE 'No se pudo completar la operación' END);
END;
$$;

ALTER FUNCTION "public"."reverse_customer_account_payment_atomic"(uuid,uuid,text,text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."reverse_customer_account_payment_atomic"(uuid,uuid,text,text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."reverse_customer_account_payment_atomic"(uuid,uuid,text,text) TO "authenticated","service_role";

-- ── 4. Postcondiciones ──────────────────────────────────────────────────────
DO $post$
DECLARE v_n int;
BEGIN
  -- 4.1 Ambas RPC existen, son SECDEF, con search_path fijado y pg_temp al final.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.proname IN ('record_customer_account_adjustment_atomic','reverse_customer_account_payment_atomic')
     AND p.prosecdef
     AND p.proconfig @> ARRAY['search_path=public, pg_temp'];
  IF v_n <> 2 THEN RAISE EXCEPTION 'CC-D: faltan RPC SECDEF con search_path endurecido (%)', v_n; END IF;

  -- 4.2 Las dos exigen capacidad financiera.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.proname IN ('record_customer_account_adjustment_atomic','reverse_customer_account_payment_atomic')
     AND p.prosrc LIKE '%current_user_can(''finance'')%';
  IF v_n <> 2 THEN RAISE EXCEPTION 'CC-D: alguna RPC no exige current_user_can(finance)'; END IF;

  -- 4.3 anon no ejecuta ninguna.
  IF has_function_privilege('anon','public.reverse_customer_account_payment_atomic(uuid,uuid,text,text)','EXECUTE')
  OR has_function_privilege('anon','public.record_customer_account_adjustment_atomic(uuid,uuid,numeric,text,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'CC-D: anon conserva EXECUTE'; END IF;

  -- 4.4 El UNIQUE que hace imposible la doble reversa.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='public.account_payment_reversals'::regclass AND conname='apr_one_reversal_per_movement' AND contype='u') THEN
    RAISE EXCEPTION 'CC-D: falta el UNIQUE sobre original_movement_id'; END IF;

  -- 4.5 El store de reversas es append-only y no lo escribe el cliente.
  IF has_table_privilege('authenticated','public.account_payment_reversals','INSERT')
  OR has_table_privilege('authenticated','public.account_payment_reversals','UPDATE')
  OR has_table_privilege('authenticated','public.account_payment_reversals','DELETE') THEN
    RAISE EXCEPTION 'CC-D: authenticated puede escribir account_payment_reversals'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.account_payment_reversals'::regclass
                   AND tgname='trg_account_payment_reversals_immutable' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'CC-D: falta el trigger de inmutabilidad'; END IF;

  RAISE NOTICE 'CC-D OK: ajustes auditados y reversa canónica del cobro.';
END $post$;

COMMIT;

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado):
--   DROP FUNCTION IF EXISTS public.reverse_customer_account_payment_atomic(uuid,uuid,text,text);
--   DROP FUNCTION IF EXISTS public.record_customer_account_adjustment_atomic(uuid,uuid,numeric,text,text,text);
--   DROP TRIGGER IF EXISTS trg_account_payment_reversals_immutable ON public.account_payment_reversals;
--   DROP FUNCTION IF EXISTS public.account_payment_reversals_immutable();
--   DROP TABLE IF EXISTS public.account_payment_reversals;   -- pierde el historial de reversas
-- ============================================================================
