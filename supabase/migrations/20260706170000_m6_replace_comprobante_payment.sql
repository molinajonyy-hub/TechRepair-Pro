-- ============================================================================
-- M6 (Fase 8) — replace_comprobante_payment: compensación append-only + comisiones
--
-- BUGS del original: (1) borraba sólo BFE type='income' → la BFE de COMISIÓN
-- (variable_cost/comisiones_cobro → payment_fee) quedaba HUÉRFANA (doble comisión
-- al reemplazar); (2) borraba el financial_movement income aunque estuviera en una
-- CAJA CERRADA (modificación retroactiva); (3) sin idempotencia.
--
-- ESTRATEGIA (append-only): los FM/BFE del/los pago(s) anterior(es) NO se borran;
-- se crean asientos COMPENSATORIOS (FM expense en la caja ABIERTA actual; BFE
-- income-mirror y BFE comisión con amount NEGATIVO → netos 0) y se marca
-- reversed_at en los originales (metadata, no cambia el monto/caja → la caja
-- cerrada conserva su total). comprobante_payments SÍ se borra (caja-neutral;
-- el sync trigger recalcula total_cobrado). El nuevo pago (con su comisión) lo
-- crea el trigger existente UNA vez. Idempotente. No toca COGS ni venta devengada.
-- ============================================================================

ALTER TABLE "public"."financial_movements"     ADD COLUMN IF NOT EXISTS "reversed_at" timestamptz;
ALTER TABLE "public"."business_finance_entries" ADD COLUMN IF NOT EXISTS "reversed_at" timestamptz;

CREATE TABLE IF NOT EXISTS "public"."comprobante_payment_replace_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id" uuid NOT NULL REFERENCES "public"."businesses"("id"),
  "user_id" uuid, "idempotency_key" text NOT NULL, "request_hash" text NOT NULL,
  "comprobante_id" uuid, "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "comprobante_payment_replace_requests_key_uniq" UNIQUE ("business_id","idempotency_key")
);
ALTER TABLE "public"."comprobante_payment_replace_requests" ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='comprobante_payment_replace_requests' AND policyname='cpr_req_select') THEN
    CREATE POLICY "cpr_req_select" ON "public"."comprobante_payment_replace_requests" FOR SELECT USING (
      EXISTS (SELECT 1 FROM businesses WHERE id=comprobante_payment_replace_requests.business_id AND owner_user_id=auth.uid())
      OR EXISTS (SELECT 1 FROM profiles WHERE business_id=comprobante_payment_replace_requests.business_id AND user_id=auth.uid()));
  END IF;
END $$;
GRANT SELECT ON "public"."comprobante_payment_replace_requests" TO "authenticated";

DROP FUNCTION IF EXISTS "public"."replace_comprobante_payment"(uuid, uuid, text, numeric, numeric, text, numeric, text, uuid);

CREATE OR REPLACE FUNCTION "public"."replace_comprobante_payment"(
  p_comprobante_id uuid, p_business_id uuid, p_payment_method text, p_amount numeric, p_amount_ars numeric,
  p_currency text, p_exchange_rate numeric, p_notes text, p_user_id uuid,
  p_commission_amount numeric DEFAULT 0, p_payment_provider text DEFAULT NULL, p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_user uuid := auth.uid(); v_access boolean := false; v_tipo text;
  v_key text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_hash text; v_existing comprobante_payment_replace_requests%ROWTYPE; v_needs_caja boolean;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'No autenticado'); END IF;
  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND user_id=v_user AND COALESCE(is_active,true))) INTO v_access;
  IF NOT v_access THEN RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio'); END IF;

  SELECT tipo INTO v_tipo FROM comprobantes WHERE id=p_comprobante_id AND business_id=p_business_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'Comprobante no encontrado'); END IF;
  IF v_tipo = 'nota_credito' THEN RETURN jsonb_build_object('ok', false, 'error', 'Las notas de credito no tienen cobro editable'); END IF;
  IF p_payment_method = 'cuenta_corriente' THEN RETURN jsonb_build_object('ok', false, 'error', 'Para cuenta corriente usa el flujo de cobro normal'); END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'El monto debe ser mayor a 0'); END IF;

  -- Idempotencia
  IF v_key IS NOT NULL THEN
    v_hash := encode(extensions.digest('cpr§'||p_comprobante_id::text||'§'||p_payment_method||'§'||round(COALESCE(p_amount_ars,0),2)::text||'§'||UPPER(COALESCE(p_currency,'ARS'))||'§'||round(COALESCE(p_commission_amount,0),2)::text, 'sha256'), 'hex');
    SELECT * INTO v_existing FROM comprobante_payment_replace_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true);
    END IF;
  END IF;

  -- Caja: si el nuevo pago o algún cobro previo vivo es efectivo, exigir caja abierta.
  v_needs_caja := (p_payment_method='efectivo')
    OR EXISTS (SELECT 1 FROM financial_movements WHERE comprobante_id=p_comprobante_id AND business_id=p_business_id
               AND type='income' AND source='comprobante' AND reversed_at IS NULL AND metodo_pago='efectivo');
  IF v_needs_caja AND NOT EXISTS (SELECT 1 FROM cajas WHERE business_id=p_business_id AND status='abierta') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No hay caja abierta para registrar el reemplazo en efectivo'); END IF;

  -- 1. Compensar FM income vivos (expense en caja ABIERTA actual; caja_id NULL → trigger asigna).
  INSERT INTO financial_movements (business_id, date, type, currency, amount, amount_ars, exchange_rate,
    source, description, created_by, metodo_pago, comprobante_id, reference_id, reference_type)
  SELECT business_id, public.ar_today(), 'expense', currency, amount, amount_ars, exchange_rate,
    'reversal', 'REVERSO cobro (reemplazo)', p_user_id, metodo_pago, comprobante_id, id, 'comprobante_payment_replace'
  FROM financial_movements
  WHERE comprobante_id=p_comprobante_id AND business_id=p_business_id AND type='income' AND source='comprobante' AND reversed_at IS NULL;
  UPDATE financial_movements SET reversed_at=now()
  WHERE comprobante_id=p_comprobante_id AND business_id=p_business_id AND type='income' AND source='comprobante' AND reversed_at IS NULL;

  -- 2. Compensar BFE vivos del comprobante (income-mirror Y comisión) con amount NEGATIVO,
  --    conservando su economic_class (revenue_collection_mirror / payment_fee) → netos 0.
  INSERT INTO business_finance_entries (business_id, date, type, category, description,
    amount, currency, amount_ars, exchange_rate, payment_method, reference_comprobante_id, source, created_by, economic_class)
  SELECT business_id, public.ar_today(), type, category, 'REVERSO: '||COALESCE(description,''),
    -amount, currency, -amount_ars, exchange_rate, payment_method, reference_comprobante_id, 'reversal', p_user_id, economic_class
  FROM business_finance_entries
  WHERE reference_comprobante_id=p_comprobante_id AND business_id=p_business_id AND source='comprobante' AND reversed_at IS NULL;
  UPDATE business_finance_entries SET reversed_at=now()
  WHERE reference_comprobante_id=p_comprobante_id AND business_id=p_business_id AND source='comprobante' AND reversed_at IS NULL;

  -- 3. Borrar comprobante_payments (caja-neutral; sync trigger resetea total_cobrado).
  DELETE FROM comprobante_payments WHERE comprobante_id=p_comprobante_id AND business_id=p_business_id;

  -- 4. Nuevo pago único → trig_comprobante_payment_finance crea FM income + BFE income-mirror
  --    + BFE comisión (si commission_amount>0), todo UNA vez y en la caja actual.
  INSERT INTO comprobante_payments (
    comprobante_id, business_id, amount, currency, amount_ars, exchange_rate,
    payment_method, payment_provider, commission_amount, notes, date, created_by
  ) VALUES (
    p_comprobante_id, p_business_id, p_amount, COALESCE(p_currency,'ARS'), p_amount_ars, COALESCE(p_exchange_rate,1),
    p_payment_method, p_payment_provider, COALESCE(p_commission_amount,0), p_notes, public.ar_today(), p_user_id
  );

  IF v_key IS NOT NULL THEN
    INSERT INTO comprobante_payment_replace_requests (business_id, user_id, idempotency_key, request_hash, comprobante_id)
      VALUES (p_business_id, v_user, v_key, v_hash, p_comprobante_id);
  END IF;

  RETURN jsonb_build_object('ok', true, 'replay', false);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

ALTER FUNCTION "public"."replace_comprobante_payment"(uuid,uuid,text,numeric,numeric,text,numeric,text,uuid,numeric,text,text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."replace_comprobante_payment"(uuid,uuid,text,numeric,numeric,text,numeric,text,uuid,numeric,text,text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."replace_comprobante_payment"(uuid,uuid,text,numeric,numeric,text,numeric,text,uuid,numeric,text,text) TO "authenticated","service_role";

-- ROLLBACK: recrear la firma vieja (9 args) con el cuerpo previo; DROP tabla/columnas nuevas.
