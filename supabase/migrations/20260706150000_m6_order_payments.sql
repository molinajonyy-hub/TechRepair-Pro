-- ============================================================================
-- M6 (Fase 6) — Pagos de órdenes atómicos, idempotentes y reversibles
--
-- ARQUITECTURA (una sola puerta de creación de movimientos = el trigger):
--   - Se CORRIGE trigger_payment_creates_movements (bug USD histórico:
--     amount_ars=amount / exchange_rate=1) → ahora amount_ars = amount * rate,
--     mapea metodo_pago (cash→efectivo, transfer→transferencia, tarjetas→tarjeta,
--     USD→usd), clasifica el BFE espejo como revenue_collection_mirror (EXCLUIDO
--     del P&L: un cobro de orden NO reconoce venta nueva) y enlaza el FM/BFE
--     creados de vuelta en la fila del pago (financial_movement_id/finance_entry_id).
--   - create_order_payment_atomic: puerta validada/idempotente que inserta
--     order_payments (el trigger crea FM+BFE UNA vez, con USD correcto).
--   - reverse_order_payment_atomic: append-only; FM/BFE compensatorios en la caja
--     ABIERTA actual (nunca la caja cerrada del original); marca reversed_at.
-- No duplica: la RPC NO crea FM/BFE explícitos; solo el trigger los crea.
-- ============================================================================

ALTER TABLE "public"."order_payments" ADD COLUMN IF NOT EXISTS "exchange_rate" numeric NOT NULL DEFAULT 1;
ALTER TABLE "public"."order_payments" ADD COLUMN IF NOT EXISTS "amount_ars" numeric;
ALTER TABLE "public"."order_payments" ADD COLUMN IF NOT EXISTS "reversed_at" timestamptz;
ALTER TABLE "public"."order_payments" ADD COLUMN IF NOT EXISTS "reversed_by" uuid;
ALTER TABLE "public"."order_payments" ADD COLUMN IF NOT EXISTS "financial_movement_id" uuid;
ALTER TABLE "public"."order_payments" ADD COLUMN IF NOT EXISTS "finance_entry_id" uuid;

-- ── Trigger corregido (USD + metodo_pago + clasificación + enlace) ──────────
CREATE OR REPLACE FUNCTION "public"."trigger_payment_creates_movements"() RETURNS "trigger"
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_business_id uuid;
  v_date        date;
  v_rate        numeric;
  v_ars         numeric;
  v_metodo      text;
  v_fm          uuid;
  v_bfe         uuid;
BEGIN
  IF NEW.business_id IS NULL THEN
    SELECT o.business_id INTO v_business_id FROM public.orders o WHERE o.id = NEW.order_id;
    NEW.business_id := v_business_id;
  ELSE
    v_business_id := NEW.business_id;
  END IF;
  IF v_business_id IS NULL THEN RETURN NEW; END IF;

  v_date := COALESCE(NEW.payment_date::date, public.ar_today());
  v_rate := COALESCE(NULLIF(NEW.exchange_rate,0), 1);
  -- USD correcto: amount_ars = amount * rate (antes hardcodeaba amount/1).
  v_ars  := COALESCE(NEW.amount_ars, ROUND(NEW.amount * v_rate, 2));
  NEW.amount_ars := v_ars;

  v_metodo := CASE
    WHEN COALESCE(NEW.currency,'ARS')='USD' THEN 'usd'
    WHEN NEW.payment_method='cash'      THEN 'efectivo'
    WHEN NEW.payment_method='transfer'  THEN 'transferencia'
    WHEN NEW.payment_method IN ('credit_card','debit_card') THEN 'tarjeta'
    ELSE 'otro'
  END;

  -- FM income (caja): trig_set_movement_caja asigna la caja abierta.
  INSERT INTO public.financial_movements (
    business_id, type, currency, amount, exchange_rate, amount_ars,
    source, source_id, reference_id, reference_type, metodo_pago, description, date, created_by
  ) VALUES (
    v_business_id, 'income', COALESCE(NEW.currency,'ARS'), NEW.amount, v_rate, v_ars,
    'payment', NEW.id, NEW.order_id, 'order', v_metodo,
    'Cobro orden #' || LEFT(NEW.order_id::text, 8), v_date, NEW.created_by
  ) RETURNING id INTO v_fm;

  -- BFE espejo → revenue_collection_mirror (EXCLUIDO del P&L: no es venta nueva).
  INSERT INTO public.business_finance_entries (
    business_id, date, type, category, description,
    amount, currency, amount_ars, exchange_rate, payment_method, reference_order_id, source, created_by, economic_class
  ) VALUES (
    v_business_id, v_date, 'income', 'servicios_tecnicos', 'Cobro orden #' || LEFT(NEW.order_id::text, 8),
    NEW.amount, COALESCE(NEW.currency,'ARS'), v_ars, v_rate, NEW.payment_method, NEW.order_id, 'payment', NEW.created_by,
    'revenue_collection_mirror'
  ) RETURNING id INTO v_bfe;

  -- Enlace duro para el reverso.
  NEW.financial_movement_id := v_fm;
  NEW.finance_entry_id := v_bfe;
  RETURN NEW;
END;
$$;

-- ── Idempotencia + auditoría de reversos ────────────────────────────────────
CREATE TABLE IF NOT EXISTS "public"."order_payment_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id" uuid NOT NULL REFERENCES "public"."businesses"("id"),
  "user_id" uuid, "idempotency_key" text NOT NULL, "request_hash" text NOT NULL,
  "order_payment_id" uuid, "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "order_payment_requests_key_uniq" UNIQUE ("business_id","idempotency_key")
);
CREATE TABLE IF NOT EXISTS "public"."order_payment_reversals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id" uuid NOT NULL REFERENCES "public"."businesses"("id"),
  "order_id" uuid, "order_payment_id" uuid NOT NULL,
  "original_financial_movement_id" uuid, "original_finance_entry_id" uuid,
  "reversal_financial_movement_id" uuid, "reversal_finance_entry_id" uuid,
  "amount_ars" numeric NOT NULL, "currency" text, "exchange_rate" numeric,
  "reason" text NOT NULL, "created_by" uuid, "created_at" timestamptz NOT NULL DEFAULT now(),
  "idempotency_key" text, "request_hash" text, "metadata" jsonb,
  CONSTRAINT "order_payment_reversals_key_uniq" UNIQUE ("business_id","idempotency_key")
);
ALTER TABLE "public"."order_payment_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."order_payment_reversals" ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='order_payment_requests' AND policyname='op_req_select') THEN
    CREATE POLICY "op_req_select" ON "public"."order_payment_requests" FOR SELECT USING (
      EXISTS (SELECT 1 FROM businesses WHERE id=order_payment_requests.business_id AND owner_user_id=auth.uid())
      OR EXISTS (SELECT 1 FROM profiles WHERE business_id=order_payment_requests.business_id AND user_id=auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='order_payment_reversals' AND policyname='op_rev_select') THEN
    CREATE POLICY "op_rev_select" ON "public"."order_payment_reversals" FOR SELECT USING (
      EXISTS (SELECT 1 FROM businesses WHERE id=order_payment_reversals.business_id AND owner_user_id=auth.uid())
      OR EXISTS (SELECT 1 FROM profiles WHERE business_id=order_payment_reversals.business_id AND user_id=auth.uid()));
  END IF;
END $$;
GRANT SELECT ON "public"."order_payment_requests","public"."order_payment_reversals" TO "authenticated";

-- ── create_order_payment_atomic ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "public"."create_order_payment_atomic"(
  p_business_id uuid, p_order_id uuid, p_amount numeric, p_payment_method text, p_currency text,
  p_exchange_rate numeric, p_user_id uuid, p_notes text DEFAULT NULL, p_date date DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_user uuid := auth.uid(); v_access boolean := false;
  v_key text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_curr text := UPPER(COALESCE(NULLIF(btrim(p_currency),''),'ARS'));
  v_rate numeric := COALESCE(NULLIF(p_exchange_rate,0), 1);
  v_date date := COALESCE(p_date, public.ar_today());
  v_hash text; v_existing order_payment_requests%ROWTYPE; v_req uuid; v_pay uuid;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'No autenticado'); END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'El monto debe ser mayor a 0'); END IF;
  IF p_payment_method NOT IN ('cash','credit_card','debit_card','transfer','other') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Método de pago inválido'); END IF;
  IF v_curr NOT IN ('ARS','USD') THEN RETURN jsonb_build_object('ok', false, 'error', 'Moneda inválida'); END IF;
  IF v_curr='USD' AND v_rate <= 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'Falta el tipo de cambio para el pago en USD'); END IF;
  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND user_id=v_user AND COALESCE(is_active,true))) INTO v_access;
  IF NOT v_access THEN RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio'); END IF;
  IF NOT EXISTS (SELECT 1 FROM orders WHERE id=p_order_id AND business_id=p_business_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Orden inexistente'); END IF;
  -- Efectivo requiere caja abierta.
  IF p_payment_method='cash' AND NOT EXISTS (SELECT 1 FROM cajas WHERE business_id=p_business_id AND status='abierta') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No hay caja abierta para registrar el pago en efectivo'); END IF;

  IF v_key IS NOT NULL THEN
    v_hash := encode(extensions.digest('op§'||p_business_id::text||'§'||p_order_id::text||'§'||round(p_amount,2)::text||'§'||p_payment_method||'§'||v_curr||'§'||round(v_rate,4)::text||'§'||v_date::text, 'sha256'), 'hex');
    SELECT * INTO v_existing FROM order_payment_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'order_payment_id', v_existing.order_payment_id);
    END IF;
    BEGIN
      INSERT INTO order_payment_requests (business_id, user_id, idempotency_key, request_hash)
        VALUES (p_business_id, v_user, v_key, v_hash) RETURNING id INTO v_req;
    EXCEPTION WHEN unique_violation THEN
      SELECT * INTO v_existing FROM order_payment_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'order_payment_id', v_existing.order_payment_id);
    END;
  END IF;

  -- Insert del pago → el trigger crea FM+BFE (USD correcto) y enlaza los ids.
  INSERT INTO order_payments (order_id, business_id, amount, payment_method, currency, exchange_rate, amount_ars, payment_date, notes, created_by)
    VALUES (p_order_id, p_business_id, p_amount, p_payment_method, v_curr, v_rate, ROUND(p_amount*v_rate,2), v_date, NULLIF(btrim(p_notes),''), p_user_id)
    RETURNING id INTO v_pay;

  IF v_key IS NOT NULL THEN UPDATE order_payment_requests SET order_payment_id=v_pay WHERE id=v_req; END IF;
  RETURN jsonb_build_object('ok', true, 'replay', false, 'order_payment_id', v_pay,
    'financial_movement_id', (SELECT financial_movement_id FROM order_payments WHERE id=v_pay),
    'finance_entry_id', (SELECT finance_entry_id FROM order_payments WHERE id=v_pay));
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- ── reverse_order_payment_atomic ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "public"."reverse_order_payment_atomic"(
  p_business_id uuid, p_order_payment_id uuid, p_reason text, p_user_id uuid,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_user uuid := auth.uid(); v_access boolean := false;
  v_key text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_reason text := NULLIF(btrim(COALESCE(p_reason,'')), '');
  v_hash text; v_existing order_payment_reversals%ROWTYPE;
  v_pay order_payments%ROWTYPE; v_bfe business_finance_entries%ROWTYPE; v_fm financial_movements%ROWTYPE;
  v_metodo text; v_new_fm uuid; v_new_bfe uuid; v_date date := public.ar_today();
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'No autenticado'); END IF;
  IF v_reason IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'El motivo del reverso es obligatorio'); END IF;
  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND user_id=v_user AND COALESCE(is_active,true))) INTO v_access;
  IF NOT v_access THEN RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio'); END IF;

  IF v_key IS NOT NULL THEN
    v_hash := encode(extensions.digest('oprev§'||p_business_id::text||'§'||p_order_payment_id::text||'§'||v_reason, 'sha256'), 'hex');
    SELECT * INTO v_existing FROM order_payment_reversals WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'reversal_financial_movement_id', v_existing.reversal_financial_movement_id);
    END IF;
  END IF;

  SELECT * INTO v_pay FROM order_payments WHERE id=p_order_payment_id AND business_id=p_business_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'Pago inexistente'); END IF;
  IF v_pay.reversed_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'El pago ya fue reversado'); END IF;

  SELECT * INTO v_fm FROM financial_movements WHERE id=v_pay.financial_movement_id;
  SELECT * INTO v_bfe FROM business_finance_entries WHERE id=v_pay.finance_entry_id;
  v_metodo := COALESCE(v_fm.metodo_pago, CASE WHEN v_pay.currency='USD' THEN 'usd' WHEN v_pay.payment_method='cash' THEN 'efectivo' WHEN v_pay.payment_method='transfer' THEN 'transferencia' WHEN v_pay.payment_method IN ('credit_card','debit_card') THEN 'tarjeta' ELSE 'otro' END);

  -- Devolución en efectivo requiere caja abierta actual (nunca la caja cerrada del original).
  IF v_fm.id IS NOT NULL AND v_metodo='efectivo'
     AND NOT EXISTS (SELECT 1 FROM cajas WHERE business_id=p_business_id AND status='abierta') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No hay caja abierta para registrar la devolución en efectivo'); END IF;

  -- FM compensatorio (expense = salida) en caja ABIERTA actual (caja_id NULL → trigger asigna).
  IF v_fm.id IS NOT NULL THEN
    INSERT INTO financial_movements (business_id, date, type, currency, amount, amount_ars, exchange_rate,
      source, description, created_by, metodo_pago, reference_id, reference_type)
      VALUES (p_business_id, v_date, 'expense', v_fm.currency, v_fm.amount, v_fm.amount_ars, v_fm.exchange_rate,
        'reversal', 'REVERSO cobro orden', p_user_id, v_metodo, v_pay.id, 'order_payment_reversal')
      RETURNING id INTO v_new_fm;
  END IF;
  -- BFE compensatorio (revenue_collection_mirror, amount NEGATIVO → net 0).
  IF v_bfe.id IS NOT NULL THEN
    INSERT INTO business_finance_entries (business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate, payment_method, reference_order_id, source, created_by, economic_class)
      VALUES (p_business_id, v_date, 'income', v_bfe.category, 'REVERSO cobro orden — '||v_reason,
        -v_bfe.amount, v_bfe.currency, -v_bfe.amount_ars, v_bfe.exchange_rate, v_bfe.payment_method, v_bfe.reference_order_id, 'reversal', p_user_id, 'revenue_collection_mirror')
      RETURNING id INTO v_new_bfe;
  END IF;

  UPDATE order_payments SET reversed_at=now(), reversed_by=p_user_id WHERE id=p_order_payment_id;

  INSERT INTO order_payment_reversals (business_id, order_id, order_payment_id, original_financial_movement_id, original_finance_entry_id,
    reversal_financial_movement_id, reversal_finance_entry_id, amount_ars, currency, exchange_rate, reason, created_by, idempotency_key, request_hash, metadata)
    VALUES (p_business_id, v_pay.order_id, p_order_payment_id, v_fm.id, v_bfe.id, v_new_fm, v_new_bfe,
      COALESCE(v_pay.amount_ars, v_bfe.amount_ars, 0), v_pay.currency, v_pay.exchange_rate, v_reason, p_user_id, v_key, v_hash,
      jsonb_build_object('method', v_metodo));

  RETURN jsonb_build_object('ok', true, 'replay', false, 'reversal_financial_movement_id', v_new_fm, 'reversal_finance_entry_id', v_new_bfe,
    'original_financial_movement_id', v_fm.id, 'original_finance_entry_id', v_bfe.id);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

ALTER FUNCTION "public"."create_order_payment_atomic"(uuid,uuid,numeric,text,text,numeric,uuid,text,date,text) OWNER TO "postgres";
ALTER FUNCTION "public"."reverse_order_payment_atomic"(uuid,uuid,text,uuid,text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."create_order_payment_atomic"(uuid,uuid,numeric,text,text,numeric,uuid,text,date,text) FROM PUBLIC, "anon";
REVOKE ALL ON FUNCTION "public"."reverse_order_payment_atomic"(uuid,uuid,text,uuid,text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."create_order_payment_atomic"(uuid,uuid,numeric,text,text,numeric,uuid,text,date,text) TO "authenticated","service_role";
GRANT EXECUTE ON FUNCTION "public"."reverse_order_payment_atomic"(uuid,uuid,text,uuid,text) TO "authenticated","service_role";

-- Bloquear DELETE directo de order_payments (rewire completo → correcciones por
-- reverse_order_payment_atomic append-only). Fortalece RLS (no la debilita).
DROP POLICY IF EXISTS "order_payments_delete" ON "public"."order_payments";

-- ROLLBACK: restaurar trigger viejo; DROP funciones/tablas nuevas; recrear policy
-- order_payments_delete; ALTER order_payments DROP columnas nuevas.
