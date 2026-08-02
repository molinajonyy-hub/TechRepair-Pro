-- ============================================================================
-- P0-A.1 (cont.) — Imputación EXPLÍCITA de cobros de cuenta corriente.
--
-- POR QUÉ: record_customer_account_payment_atomic registra el cobro con
-- reference_type='manual' y SIN reference_id. La cuenta corriente es un saldo
-- POR CLIENTE, no por documento, así que un cobro de CC no podía bajar el saldo
-- de una orden concreta. Se resuelve con imputación explícita — NUNCA con FIFO,
-- proporcional, ni matching por cliente/fecha/importe (prohibido por contrato).
--
-- MODELO: el pago original NO se duplica. La asignación DISTRIBUYE su efecto.
-- Append-only: una reversa marca reversed_at y, si es parcial, deja una
-- asignación nueva por el remanente. Nunca hay DELETE financiero.
--
-- INVENTARIO PREVIO: no existía ninguna tabla de imputaciones ni de aplicaciones
-- de pago. account_payment_requests es sólo el registro de idempotencia de la
-- RPC de cobro, no una imputación.
--
-- ROLLBACK documentado al final.
-- ============================================================================

-- ── §1. Tabla canónica de asignaciones ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS "public"."customer_account_payment_allocations" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id"         uuid NOT NULL REFERENCES "public"."businesses"("id") ON DELETE CASCADE,
  "customer_id"         uuid NOT NULL REFERENCES "public"."customers"("id")  ON DELETE RESTRICT,
  "account_id"          uuid NOT NULL REFERENCES "public"."accounts"("id")   ON DELETE RESTRICT,
  -- Movimiento de cuenta corriente que ORIGINA el crédito (type='pago').
  "payment_movement_id" uuid NOT NULL REFERENCES "public"."account_movements"("id") ON DELETE RESTRICT,
  "comprobante_id"      uuid NOT NULL REFERENCES "public"."comprobantes"("id") ON DELETE RESTRICT,
  -- order_id NO se persiste: es derivable de comprobantes.order_id y duplicarlo
  -- abriría una segunda fuente que puede divergir. Se valida por trigger.
  "amount"              numeric(14,2) NOT NULL,
  "currency"            text NOT NULL DEFAULT 'ARS',
  "status"              text NOT NULL DEFAULT 'active',
  "idempotency_key"     text NOT NULL,
  "reason"              text,
  "reversed_at"         timestamptz,
  "reversal_of"         uuid REFERENCES "public"."customer_account_payment_allocations"("id"),
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "created_by"          uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  CONSTRAINT "cap_alloc_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "cap_alloc_currency"        CHECK ("currency" = 'ARS'),
  CONSTRAINT "cap_alloc_status"          CHECK ("status" = ANY (ARRAY['active','reversed'])),
  CONSTRAINT "cap_alloc_status_coherent" CHECK (
    ("status" = 'active'   AND "reversed_at" IS NULL) OR
    ("status" = 'reversed' AND "reversed_at" IS NOT NULL)),
  CONSTRAINT "cap_alloc_key_unique"      UNIQUE ("business_id", "idempotency_key")
);

CREATE INDEX IF NOT EXISTS "idx_cap_alloc_payment"     ON "public"."customer_account_payment_allocations" ("payment_movement_id") WHERE "status" = 'active';
CREATE INDEX IF NOT EXISTS "idx_cap_alloc_comprobante" ON "public"."customer_account_payment_allocations" ("comprobante_id")      WHERE "status" = 'active';
CREATE INDEX IF NOT EXISTS "idx_cap_alloc_business"    ON "public"."customer_account_payment_allocations" ("business_id", "created_at" DESC);

COMMENT ON TABLE "public"."customer_account_payment_allocations" IS
  'P0-A.1 — Imputación EXPLÍCITA de un cobro de cuenta corriente a un comprobante. '
  'Nunca se infiere por FIFO, proporción, cliente, fecha ni importe. El pago original '
  'no se duplica: la asignación distribuye su efecto. Append-only: la reversa marca '
  'reversed_at y deja el remanente como asignación nueva.';

ALTER TABLE "public"."customer_account_payment_allocations" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cap_alloc_select" ON "public"."customer_account_payment_allocations";
CREATE POLICY "cap_alloc_select" ON "public"."customer_account_payment_allocations"
  FOR SELECT TO "authenticated"
  USING (EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.business_id = customer_account_payment_allocations.business_id
                    AND p.user_id = auth.uid() AND COALESCE(p.is_active, true))
      OR EXISTS (SELECT 1 FROM public.businesses b
                  WHERE b.id = customer_account_payment_allocations.business_id
                    AND b.owner_user_id = auth.uid()));

-- Escritura fail-closed: sólo por las RPC SECURITY DEFINER.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "public"."customer_account_payment_allocations" FROM "anon";
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "public"."customer_account_payment_allocations" FROM "authenticated";
GRANT SELECT ON "public"."customer_account_payment_allocations" TO "authenticated";
GRANT SELECT, INSERT, UPDATE ON "public"."customer_account_payment_allocations" TO "service_role";

-- ── §2. Guard de integridad: aislamiento, sobreasignación y sobrepago ───────
CREATE OR REPLACE FUNCTION "public"."cap_alloc_integrity_guard"() RETURNS "trigger"
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_mov     public.account_movements%ROWTYPE;
  v_comp    public.comprobantes%ROWTYPE;
  v_acc_biz uuid;
  v_acc_cus uuid;
  v_pago    numeric;
  v_asig    numeric;
  v_saldo   numeric;
  v_aplic   numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'customer_account_payment_allocations es append-only: DELETE no permitido'
      USING ERRCODE = '0A000';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Sólo se permite cerrar una asignación (reversa). Los importes y las
    -- referencias son inmutables.
    IF NEW.business_id IS DISTINCT FROM OLD.business_id
       OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.payment_movement_id IS DISTINCT FROM OLD.payment_movement_id
       OR NEW.comprobante_id IS DISTINCT FROM OLD.comprobante_id
       OR NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
      RAISE EXCEPTION 'La asignación es inmutable: sólo puede pasar a reversed'
        USING ERRCODE = '0A000';
    END IF;
    RETURN NEW;
  END IF;

  -- ── INSERT ────────────────────────────────────────────────────────────────
  SELECT * INTO v_mov FROM public.account_movements WHERE id = NEW.payment_movement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND: el movimiento de pago no existe' USING ERRCODE = '23503';
  END IF;
  SELECT * INTO v_comp FROM public.comprobantes WHERE id = NEW.comprobante_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COMPROBANTE_NOT_FOUND' USING ERRCODE = '23503';
  END IF;
  SELECT a.business_id, a.entity_id INTO v_acc_biz, v_acc_cus
    FROM public.accounts a WHERE a.id = NEW.account_id;

  -- Aislamiento total: negocio y cliente coherentes en las cuatro puntas.
  IF v_mov.business_id IS DISTINCT FROM NEW.business_id
     OR v_comp.business_id IS DISTINCT FROM NEW.business_id
     OR v_acc_biz IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'ALLOCATION_CROSS_BUSINESS: pago, comprobante, cuenta y negocio no coinciden'
      USING ERRCODE = '42501';
  END IF;
  IF v_mov.account_id IS DISTINCT FROM NEW.account_id THEN
    RAISE EXCEPTION 'ALLOCATION_WRONG_ACCOUNT: el pago no pertenece a esa cuenta'
      USING ERRCODE = '42501';
  END IF;
  IF v_acc_cus IS DISTINCT FROM NEW.customer_id
     OR (v_comp.customer_id IS NOT NULL AND v_comp.customer_id IS DISTINCT FROM NEW.customer_id) THEN
    RAISE EXCEPTION 'ALLOCATION_CROSS_CUSTOMER: el comprobante no es del cliente de la cuenta'
      USING ERRCODE = '42501';
  END IF;

  -- El movimiento imputado debe ser un COBRO (credit > 0), no una venta.
  IF COALESCE(v_mov.credit, 0) <= 0 THEN
    RAISE EXCEPTION 'ALLOCATION_NOT_A_PAYMENT: sólo se imputan cobros de cuenta corriente'
      USING ERRCODE = '22023';
  END IF;

  -- Un comprobante anulado no admite imputación.
  IF v_comp.estado = 'anulado' OR v_comp.status = 'cancelled' OR v_comp.estado_comercial = 'anulado' THEN
    RAISE EXCEPTION 'ALLOCATION_ON_ANNULLED: el comprobante está anulado' USING ERRCODE = '22023';
  END IF;

  -- Σ asignaciones activas <= importe del pago.
  v_pago := COALESCE(v_mov.credit, 0);
  SELECT COALESCE(SUM(amount), 0) INTO v_asig
    FROM public.customer_account_payment_allocations
   WHERE payment_movement_id = NEW.payment_movement_id AND status = 'active' AND id <> NEW.id;
  IF v_asig + NEW.amount > v_pago + 0.01 THEN
    RAISE EXCEPTION 'ALLOCATION_EXCEEDS_PAYMENT: el pago tiene % disponible y se intentó imputar %',
      round(v_pago - v_asig, 2), NEW.amount USING ERRCODE = '22023';
  END IF;

  -- Σ aplicado al comprobante <= saldo imputable del documento.
  v_saldo := COALESCE(v_comp.saldo_pendiente, 0);
  SELECT COALESCE(SUM(amount), 0) INTO v_aplic
    FROM public.customer_account_payment_allocations
   WHERE comprobante_id = NEW.comprobante_id AND status = 'active' AND id <> NEW.id;
  IF v_aplic + NEW.amount > v_saldo + 0.01 THEN
    RAISE EXCEPTION 'ALLOCATION_EXCEEDS_BALANCE: el comprobante tiene % imputable y se intentó imputar %',
      round(v_saldo - v_aplic, 2), NEW.amount USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;
ALTER FUNCTION "public"."cap_alloc_integrity_guard"() OWNER TO "postgres";

DROP TRIGGER IF EXISTS "trg_cap_alloc_integrity" ON "public"."customer_account_payment_allocations";
CREATE TRIGGER "trg_cap_alloc_integrity"
  BEFORE INSERT OR UPDATE OR DELETE ON "public"."customer_account_payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION "public"."cap_alloc_integrity_guard"();

-- ── §3. Recompute del estado de la orden ante cambios de imputación ─────────
CREATE OR REPLACE FUNCTION "public"."order_status_on_allocation_change"() RETURNS "trigger"
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_order_id uuid;
BEGIN
  SELECT c.order_id INTO v_order_id FROM public.comprobantes c
   WHERE c.id = COALESCE(NEW.comprobante_id, OLD.comprobante_id);
  IF v_order_id IS NOT NULL THEN
    PERFORM public.recompute_order_payment_status(v_order_id);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
ALTER FUNCTION "public"."order_status_on_allocation_change"() OWNER TO "postgres";

DROP TRIGGER IF EXISTS "trg_order_status_on_allocation" ON "public"."customer_account_payment_allocations";
CREATE TRIGGER "trg_order_status_on_allocation"
  AFTER INSERT OR UPDATE ON "public"."customer_account_payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION "public"."order_status_on_allocation_change"();

-- ── §4. Crédito no imputado por cliente ─────────────────────────────────────
CREATE OR REPLACE VIEW "public"."v_customer_unallocated_credit"
  WITH (security_invoker = true) AS
SELECT
  m.business_id,
  m.account_id,
  a.entity_id AS customer_id,
  m.id                                   AS payment_movement_id,
  m.date                                 AS payment_date,
  ROUND(m.credit, 2)                     AS payment_amount,
  ROUND(COALESCE(al.imputado, 0), 2)     AS allocated_amount,
  ROUND(m.credit - COALESCE(al.imputado, 0), 2) AS unallocated_amount
FROM public.account_movements m
JOIN public.accounts a ON a.id = m.account_id
LEFT JOIN (
  SELECT payment_movement_id, SUM(amount) AS imputado
  FROM public.customer_account_payment_allocations
  WHERE status = 'active'
  GROUP BY 1
) al ON al.payment_movement_id = m.id
WHERE COALESCE(m.credit, 0) > 0
  AND m.type = 'pago';

COMMENT ON VIEW "public"."v_customer_unallocated_credit" IS
  'P0-A.1 — Cobros de cuenta corriente y cuánto de cada uno sigue SIN imputar. '
  'Un pago genérico queda 100 % no imputado y no cambia el estado de ninguna orden.';

ALTER VIEW "public"."v_customer_unallocated_credit" OWNER TO "postgres";
GRANT SELECT ON "public"."v_customer_unallocated_credit" TO "authenticated";
GRANT SELECT ON "public"."v_customer_unallocated_credit" TO "service_role";

-- ── §5. v_order_financial_status: ahora considera las imputaciones ──────────
-- DROP + CREATE (no REPLACE): se agregan columnas intermedias y CREATE OR REPLACE
-- no admite cambiar el orden ni el nombre de las columnas existentes.
DROP VIEW IF EXISTS "public"."v_order_financial_status";
CREATE VIEW "public"."v_order_financial_status"
  WITH (security_invoker = true) AS
WITH comps AS (
  SELECT
    c.order_id,
    c.business_id,
    SUM(COALESCE(c.total_bruto, c.total_ars, c.total, 0))        AS total_comprobado,
    SUM(COALESCE(c.total_cobrado, 0))                            AS cobrado_directo,
    SUM(COALESCE(c.saldo_pendiente, 0))                          AS saldo_documento,
    count(*)                                                     AS comprobantes_vigentes,
    (array_agg(c.id ORDER BY COALESCE(c.fecha, c.date, c.created_at) DESC))[1] AS comprobante_id,
    (array_agg(COALESCE(c.numero_fiscal, c.numero, c.number)
               ORDER BY COALESCE(c.fecha, c.date, c.created_at) DESC))[1]      AS comprobante_numero,
    MAX((COALESCE(c.fecha, c.date, c.created_at) AT TIME ZONE 'America/Argentina/Cordoba')::date) AS fecha_comprobante,
    SUM(COALESCE((SELECT SUM(am.debit - am.credit) FROM public.account_movements am
                   WHERE am.reference_type = 'comprobante' AND am.reference_id = c.id
                     AND am.type = 'venta'), 0))                 AS saldo_en_cc,
    -- Imputaciones EXPLÍCITAS activas de cobros de cuenta corriente.
    SUM(COALESCE((SELECT SUM(al.amount) FROM public.customer_account_payment_allocations al
                   WHERE al.comprobante_id = c.id AND al.status = 'active'), 0)) AS imputado_cc
  FROM public.comprobantes c
  WHERE c.order_id IS NOT NULL
    AND c.estado <> 'anulado'
    AND COALESCE(c.estado_comercial, '') <> 'anulado'
    AND COALESCE(c.status, '') <> 'cancelled'
    AND COALESCE(c.tipo, c.type) <> 'nota_credito'
  GROUP BY 1, 2
),
pagos AS (
  SELECT c.order_id, MAX(p.date) AS ultimo_pago
  FROM public.comprobantes c
  JOIN public.comprobante_payments p ON p.comprobante_id = c.id AND p.replaced_at IS NULL
  WHERE c.order_id IS NOT NULL
  GROUP BY 1
)
SELECT
  o.id                                   AS order_id,
  o.business_id,
  o.status                               AS estado_tecnico,
  o.completed_at,
  o.paid_at,
  ROUND(COALESCE(k.total_comprobado, 0), 2) AS total_comprobado,
  -- Cobrado real = pagos directos del documento + imputaciones explícitas de CC.
  ROUND(COALESCE(k.cobrado_directo, 0) + COALESCE(k.imputado_cc, 0), 2) AS total_cobrado,
  ROUND(COALESCE(k.cobrado_directo, 0), 2)  AS cobrado_directo,
  ROUND(COALESCE(k.imputado_cc, 0), 2)      AS imputado_cc,
  GREATEST(ROUND(COALESCE(k.saldo_documento, 0) - COALESCE(k.imputado_cc, 0), 2), 0) AS saldo_pendiente,
  ROUND(GREATEST(COALESCE(k.saldo_en_cc, 0) - COALESCE(k.imputado_cc, 0), 0), 2)     AS saldo_en_cc,
  (GREATEST(COALESCE(k.saldo_en_cc, 0) - COALESCE(k.imputado_cc, 0), 0) > 0.01)      AS deuda_en_cc,
  COALESCE(k.comprobantes_vigentes, 0)      AS comprobantes_vigentes,
  k.comprobante_id,
  k.comprobante_numero,
  k.fecha_comprobante,
  pg.ultimo_pago,
  CASE
    WHEN COALESCE(k.comprobantes_vigentes, 0) = 0 THEN 'sin_facturar'
    WHEN COALESCE(k.saldo_documento, 0) - COALESCE(k.imputado_cc, 0) <= 1.00 THEN 'paid'
    WHEN COALESCE(k.cobrado_directo, 0) + COALESCE(k.imputado_cc, 0) > 0     THEN 'partial'
    ELSE 'pending'
  END AS payment_status
FROM public.orders o
LEFT JOIN comps k  ON k.order_id = o.id
LEFT JOIN pagos pg ON pg.order_id = o.id;

ALTER VIEW "public"."v_order_financial_status" OWNER TO "postgres";
GRANT SELECT ON "public"."v_order_financial_status" TO "authenticated";
GRANT SELECT ON "public"."v_order_financial_status" TO "service_role";

-- ── §6. RPC: imputar un cobro a uno o varios comprobantes (contrato C) ──────
CREATE OR REPLACE FUNCTION "public"."allocate_account_payment_atomic"(
  "p_business_id"        uuid,
  "p_payment_movement_id" uuid,
  "p_allocations"        jsonb,     -- [{"comprobante_id": uuid, "amount": numeric}, ...]
  "p_reason"             text,
  "p_idempotency_key"    text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_key      text := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_mov      public.account_movements%ROWTYPE;
  v_acc_cus  uuid;
  v_has      boolean := false;
  v_item     jsonb;
  v_ids      uuid[] := '{}';
  v_total    numeric := 0;
  v_new_id   uuid;
  v_i        integer := 0;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'UNAUTHORIZED', 'error', 'No autenticado');
  END IF;
  IF v_key IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR', 'error', 'idempotency_key requerida');
  END IF;
  IF p_allocations IS NULL OR jsonb_array_length(p_allocations) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR', 'error', 'Sin asignaciones');
  END IF;

  SELECT (EXISTS (SELECT 1 FROM public.businesses WHERE id = p_business_id AND owner_user_id = v_actor)
       OR EXISTS (SELECT 1 FROM public.profiles WHERE business_id = p_business_id AND user_id = v_actor
                    AND COALESCE(is_active, true))) INTO v_has;
  IF NOT v_has THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'FORBIDDEN', 'error', 'Sin acceso a este negocio');
  END IF;

  -- Replay: la misma key devuelve el mismo resultado sin imputar de nuevo.
  -- Cada ítem se guarda con la key derivada '<key>:<n>', así que la detección es
  -- por PREFIJO exacto (no LIKE: la key puede contener % o _).
  IF EXISTS (SELECT 1 FROM public.customer_account_payment_allocations
              WHERE business_id = p_business_id
                AND left(idempotency_key, length(v_key) + 1) = v_key || ':') THEN
    SELECT COALESCE(array_agg(id ORDER BY created_at), '{}'), COALESCE(SUM(amount), 0)
      INTO v_ids, v_total
      FROM public.customer_account_payment_allocations
     WHERE business_id = p_business_id
       AND left(idempotency_key, length(v_key) + 1) = v_key || ':'
       AND status = 'active';
    RETURN jsonb_build_object('ok', true, 'replay', true,
      'allocation_ids', to_jsonb(v_ids), 'allocated_total', v_total);
  END IF;

  -- Lock del pago: dos imputaciones concurrentes sobre el MISMO cobro se serializan.
  SELECT * INTO v_mov FROM public.account_movements
   WHERE id = p_payment_movement_id AND business_id = p_business_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'PAYMENT_NOT_FOUND', 'error', 'Cobro no encontrado');
  END IF;
  SELECT entity_id INTO v_acc_cus FROM public.accounts WHERE id = v_mov.account_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_allocations)
  LOOP
    v_i := v_i + 1;
    INSERT INTO public.customer_account_payment_allocations (
      business_id, customer_id, account_id, payment_movement_id, comprobante_id,
      amount, currency, status, idempotency_key, reason, created_by
    ) VALUES (
      p_business_id, v_acc_cus, v_mov.account_id, p_payment_movement_id,
      (v_item->>'comprobante_id')::uuid,
      ROUND((v_item->>'amount')::numeric, 2), 'ARS', 'active',
      v_key || ':' || v_i, NULLIF(btrim(COALESCE(p_reason, '')), ''), v_actor
    ) RETURNING id INTO v_new_id;
    v_ids   := v_ids || v_new_id;
    v_total := v_total + ROUND((v_item->>'amount')::numeric, 2);
  END LOOP;

  PERFORM public.finance_log_audit(
    p_business_id, 'account_payment_allocated', 'account_movements', p_payment_movement_id,
    'allocate_account_payment_atomic', v_key, p_reason, public.ar_today(),
    'account_movement', p_payment_movement_id, NULL,
    jsonb_build_object('payment_movement_id', p_payment_movement_id,
      'allocation_ids', to_jsonb(v_ids), 'allocated_total', v_total, 'items', p_allocations));

  RETURN jsonb_build_object('ok', true, 'replay', false,
    'allocation_ids', to_jsonb(v_ids), 'allocated_total', v_total);

EXCEPTION
  WHEN sqlstate '22023' OR sqlstate '42501' OR sqlstate '23503' THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR', 'error', SQLERRM);
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'INTERNAL_ERROR',
      'error', 'No se pudo completar la imputación');
END;
$$;
ALTER FUNCTION "public"."allocate_account_payment_atomic"(uuid, uuid, jsonb, text, text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."allocate_account_payment_atomic"(uuid, uuid, jsonb, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."allocate_account_payment_atomic"(uuid, uuid, jsonb, text, text) FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."allocate_account_payment_atomic"(uuid, uuid, jsonb, text, text) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."allocate_account_payment_atomic"(uuid, uuid, jsonb, text, text) TO "service_role";

-- ── §7. RPC: reversa de imputación (total o parcial) ────────────────────────
CREATE OR REPLACE FUNCTION "public"."reverse_payment_allocation_atomic"(
  "p_business_id"     uuid,
  "p_allocation_id"   uuid,
  "p_amount"          numeric,   -- NULL = revertir todo
  "p_reason"          text,
  "p_idempotency_key" text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_key    text := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_al     public.customer_account_payment_allocations%ROWTYPE;
  v_has    boolean := false;
  v_rev    numeric;
  v_rem    numeric;
  v_new    uuid;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'UNAUTHORIZED', 'error', 'No autenticado');
  END IF;
  IF v_key IS NULL OR v_reason IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
      'error', 'idempotency_key y motivo son obligatorios');
  END IF;

  SELECT (EXISTS (SELECT 1 FROM public.businesses WHERE id = p_business_id AND owner_user_id = v_actor)
       OR EXISTS (SELECT 1 FROM public.profiles WHERE business_id = p_business_id AND user_id = v_actor
                    AND COALESCE(is_active, true))) INTO v_has;
  IF NOT v_has THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'FORBIDDEN', 'error', 'Sin acceso a este negocio');
  END IF;

  IF EXISTS (SELECT 1 FROM public.customer_account_payment_allocations
              WHERE business_id = p_business_id AND idempotency_key = v_key) THEN
    RETURN jsonb_build_object('ok', true, 'replay', true);
  END IF;

  SELECT * INTO v_al FROM public.customer_account_payment_allocations
   WHERE id = p_allocation_id AND business_id = p_business_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'ALLOCATION_NOT_FOUND', 'error', 'Imputación no encontrada');
  END IF;
  IF v_al.status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'ALREADY_REVERSED', 'error', 'La imputación ya fue revertida');
  END IF;

  v_rev := COALESCE(ROUND(p_amount, 2), v_al.amount);
  IF v_rev <= 0 OR v_rev > v_al.amount + 0.01 THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
      'error', 'El importe a revertir debe estar entre 0 y el importe imputado');
  END IF;

  -- Append-only: se cierra la asignación original y, si la reversa es parcial,
  -- queda una asignación NUEVA por el remanente. Nunca se edita un importe.
  UPDATE public.customer_account_payment_allocations
     SET status = 'reversed', reversed_at = now()
   WHERE id = v_al.id;

  v_rem := ROUND(v_al.amount - v_rev, 2);
  IF v_rem > 0 THEN
    INSERT INTO public.customer_account_payment_allocations (
      business_id, customer_id, account_id, payment_movement_id, comprobante_id,
      amount, currency, status, idempotency_key, reason, reversal_of, created_by
    ) VALUES (
      v_al.business_id, v_al.customer_id, v_al.account_id, v_al.payment_movement_id,
      v_al.comprobante_id, v_rem, 'ARS', 'active', v_key || ':rem',
      'Remanente tras reversa parcial', v_al.id, v_actor
    ) RETURNING id INTO v_new;
  END IF;

  -- Marca de idempotencia de la reversa (fila cerrada, sin efecto contable).
  INSERT INTO public.customer_account_payment_allocations (
    business_id, customer_id, account_id, payment_movement_id, comprobante_id,
    amount, currency, status, idempotency_key, reason, reversal_of, reversed_at, created_by
  ) VALUES (
    v_al.business_id, v_al.customer_id, v_al.account_id, v_al.payment_movement_id,
    v_al.comprobante_id, v_rev, 'ARS', 'reversed', v_key, v_reason, v_al.id, now(), v_actor);

  PERFORM public.finance_log_audit(
    p_business_id, 'account_payment_allocation_reversed', 'customer_account_payment_allocations',
    v_al.id, 'reverse_payment_allocation_atomic', v_key, v_reason, public.ar_today(),
    'allocation', v_al.id, NULL,
    jsonb_build_object('allocation_id', v_al.id, 'comprobante_id', v_al.comprobante_id,
      'reversed_amount', v_rev, 'remaining_allocation_id', v_new, 'remaining_amount', v_rem));

  PERFORM public.recompute_order_payment_status(
    (SELECT order_id FROM public.comprobantes WHERE id = v_al.comprobante_id));

  RETURN jsonb_build_object('ok', true, 'replay', false,
    'reversed_amount', v_rev, 'remaining_amount', v_rem, 'remaining_allocation_id', v_new);

EXCEPTION
  WHEN sqlstate '22023' OR sqlstate '42501' OR sqlstate '0A000' THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR', 'error', SQLERRM);
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'INTERNAL_ERROR',
      'error', 'No se pudo completar la reversa');
END;
$$;
ALTER FUNCTION "public"."reverse_payment_allocation_atomic"(uuid, uuid, numeric, text, text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."reverse_payment_allocation_atomic"(uuid, uuid, numeric, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."reverse_payment_allocation_atomic"(uuid, uuid, numeric, text, text) FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."reverse_payment_allocation_atomic"(uuid, uuid, numeric, text, text) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."reverse_payment_allocation_atomic"(uuid, uuid, numeric, text, text) TO "service_role";

-- ── §8. Contrato A: cobrar DESDE un comprobante e imputar en el mismo acto ──
-- Compone las dos RPC canónicas dentro de UNA transacción. No duplica la lógica
-- financiera del cobro: la delega en record_customer_account_payment_atomic.
CREATE OR REPLACE FUNCTION "public"."pay_comprobante_from_account_atomic"(
  "p_business_id"     uuid,
  "p_account_id"      uuid,
  "p_comprobante_id"  uuid,
  "p_amount"          numeric,
  "p_description"     text,
  "p_payment_method"  text,
  "p_date"            date,
  "p_caja_id"         uuid,
  "p_user_id"         uuid,
  "p_idempotency_key" text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_key   text := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_pay   jsonb;
  v_alloc jsonb;
  v_mov   uuid;
  v_saldo numeric;
  v_imp   numeric;
BEGIN
  IF v_key IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR', 'error', 'idempotency_key requerida');
  END IF;

  -- Saldo imputable del documento: el excedente NO se imputa, queda como crédito.
  SELECT GREATEST(COALESCE(c.saldo_pendiente, 0)
         - COALESCE((SELECT SUM(al.amount) FROM public.customer_account_payment_allocations al
                      WHERE al.comprobante_id = c.id AND al.status = 'active'), 0), 0)
    INTO v_saldo
    FROM public.comprobantes c
   WHERE c.id = p_comprobante_id AND c.business_id = p_business_id;
  IF v_saldo IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'COMPROBANTE_NOT_FOUND', 'error', 'Comprobante no encontrado');
  END IF;

  v_pay := public.record_customer_account_payment_atomic(
    p_business_id, p_account_id, p_amount, p_description, p_user_id,
    p_payment_method, p_date, p_caja_id, v_key);
  IF COALESCE((v_pay->>'ok')::boolean, false) IS NOT TRUE THEN
    RETURN v_pay;
  END IF;
  v_mov := (v_pay->>'account_movement_id')::uuid;

  v_imp := LEAST(ROUND(p_amount, 2), v_saldo);
  IF v_imp > 0 THEN
    v_alloc := public.allocate_account_payment_atomic(
      p_business_id, v_mov,
      jsonb_build_array(jsonb_build_object('comprobante_id', p_comprobante_id, 'amount', v_imp)),
      'Cobro imputado desde el comprobante', v_key || ':auto');
    IF COALESCE((v_alloc->>'ok')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'ALLOCATION_FAILED: %', COALESCE(v_alloc->>'error', 'sin detalle');
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true,
    'account_movement_id', v_mov,
    'allocated_amount', v_imp,
    'unallocated_amount', ROUND(p_amount, 2) - v_imp,
    'payment', v_pay, 'allocation', v_alloc);
END;
$$;
ALTER FUNCTION "public"."pay_comprobante_from_account_atomic"(uuid, uuid, uuid, numeric, text, text, date, uuid, uuid, text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."pay_comprobante_from_account_atomic"(uuid, uuid, uuid, numeric, text, text, date, uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."pay_comprobante_from_account_atomic"(uuid, uuid, uuid, numeric, text, text, date, uuid, uuid, text) FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."pay_comprobante_from_account_atomic"(uuid, uuid, uuid, numeric, text, text, date, uuid, uuid, text) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."pay_comprobante_from_account_atomic"(uuid, uuid, uuid, numeric, text, text, date, uuid, uuid, text) TO "service_role";

-- ── §9. Documentos abiertos imputables (insumo de la UI) ────────────────────
CREATE OR REPLACE VIEW "public"."v_customer_open_documents"
  WITH (security_invoker = true) AS
SELECT
  c.business_id,
  c.customer_id,
  c.id                                    AS comprobante_id,
  COALESCE(c.numero_fiscal, c.numero, c.number) AS numero,
  c.order_id,
  (COALESCE(c.fecha, c.date, c.created_at) AT TIME ZONE 'America/Argentina/Cordoba')::date AS fecha,
  ROUND(COALESCE(c.total_bruto, c.total_ars, c.total, 0), 2) AS total,
  ROUND(COALESCE(c.saldo_pendiente, 0), 2)                   AS saldo_documento,
  ROUND(COALESCE(al.imputado, 0), 2)                         AS imputado,
  GREATEST(ROUND(COALESCE(c.saldo_pendiente, 0) - COALESCE(al.imputado, 0), 2), 0) AS saldo_imputable
FROM public.comprobantes c
LEFT JOIN (
  SELECT comprobante_id, SUM(amount) AS imputado
  FROM public.customer_account_payment_allocations
  WHERE status = 'active' GROUP BY 1
) al ON al.comprobante_id = c.id
WHERE c.customer_id IS NOT NULL
  AND c.estado <> 'anulado'
  AND COALESCE(c.estado_comercial, '') <> 'anulado'
  AND COALESCE(c.status, '') <> 'cancelled'
  AND COALESCE(c.tipo, c.type) <> 'nota_credito'
  AND COALESCE(c.saldo_pendiente, 0) - COALESCE(al.imputado, 0) > 0.01;

COMMENT ON VIEW "public"."v_customer_open_documents" IS
  'P0-A.1 — Documentos con saldo imputable por cliente. Insumo de la UI de '
  'imputación: nunca se elige el documento por heurística, lo elige el operador.';

ALTER VIEW "public"."v_customer_open_documents" OWNER TO "postgres";
GRANT SELECT ON "public"."v_customer_open_documents" TO "authenticated";
GRANT SELECT ON "public"."v_customer_open_documents" TO "service_role";

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado):
--   DROP VIEW v_customer_open_documents, v_customer_unallocated_credit;
--   DROP FUNCTION pay_comprobante_from_account_atomic(...);
--   DROP FUNCTION reverse_payment_allocation_atomic(...);
--   DROP FUNCTION allocate_account_payment_atomic(...);
--   DROP TRIGGER trg_order_status_on_allocation ON customer_account_payment_allocations;
--   DROP FUNCTION order_status_on_allocation_change();
--   DROP TRIGGER trg_cap_alloc_integrity ON customer_account_payment_allocations;
--   DROP FUNCTION cap_alloc_integrity_guard();
--   DROP TABLE customer_account_payment_allocations;
--   Recrear v_order_financial_status con la definición de 20260731120000.
-- ============================================================================
