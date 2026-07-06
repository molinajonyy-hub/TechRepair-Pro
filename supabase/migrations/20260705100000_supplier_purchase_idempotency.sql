-- ============================================================================
-- Idempotencia server-side ligada al payload para create_supplier_purchase_atomic
--
-- El flujo ACTIVO de compras (NewExpenseModal → suppliersService.createPurchase)
-- no tenía idempotencia: un doble-click / reintento tras timeout podía crear DOS
-- compras (con su stock, ledger, FM y BFE). Se agrega el mismo contrato probado de
-- checkout / compra rápida:
--   misma key + mismo payload    → replay de la compra original (sin re-escribir)
--   misma key + payload distinto → IDEMPOTENCY_CONFLICT (error funcional)
--
-- El hash se reconstruye SERVER-SIDE desde los argumentos recibidos (nunca del
-- cliente). El parámetro p_idempotency_key es OPCIONAL (DEFAULT NULL): si viene
-- NULL, la RPC se comporta como antes (sin idempotencia) — compatibilidad total.
-- ============================================================================

-- ── 1. Tabla de requests (misma forma que quick_purchase_requests) ──────────
CREATE TABLE IF NOT EXISTS "public"."supplier_purchase_requests" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id"     uuid NOT NULL REFERENCES "public"."businesses"("id"),
  "user_id"         uuid,
  "idempotency_key" text NOT NULL,
  "request_hash"    text NOT NULL,
  "purchase_id"     uuid,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "supplier_purchase_requests_key_uniq" UNIQUE ("business_id", "idempotency_key")
);

ALTER TABLE "public"."supplier_purchase_requests" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='supplier_purchase_requests' AND policyname='supplier_purchase_req_select') THEN
    CREATE POLICY "supplier_purchase_req_select" ON "public"."supplier_purchase_requests"
      FOR SELECT USING (
        EXISTS (SELECT 1 FROM businesses WHERE id=supplier_purchase_requests.business_id AND owner_user_id=auth.uid())
        OR EXISTS (SELECT 1 FROM profiles WHERE business_id=supplier_purchase_requests.business_id AND user_id=auth.uid())
      );
  END IF;
END $$;

GRANT SELECT ON "public"."supplier_purchase_requests" TO "authenticated";

-- ── 2. RPC con idempotencia opcional (param nuevo al final) ─────────────────
-- Hay que DROP + CREATE porque agregar un parámetro (aunque tenga DEFAULT) crea
-- una sobrecarga nueva en vez de reemplazar la firma de 11 args.
DROP FUNCTION IF EXISTS "public"."create_supplier_purchase_atomic"(uuid, uuid, uuid, text, date, text, numeric, numeric, text, text, jsonb);

CREATE OR REPLACE FUNCTION "public"."create_supplier_purchase_atomic"(
  p_business_id uuid, p_supplier_id uuid, p_user_id uuid, p_supplier_name text,
  p_purchase_date date, p_invoice_number text, p_total_amount numeric, p_paid_amount numeric,
  p_payment_method text, p_notes text, p_items jsonb, p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_pending  numeric;
  v_status   text;
  v_purchase record;
  v_item     jsonb;
  v_payment  record;
  v_fm       record;
  v_prev_stk integer;
  v_new_stk  integer;
  v_inv_num  text;
  v_desc_sfx text;
  v_key      text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_existing supplier_purchase_requests%ROWTYPE;
  v_req_id   uuid;
  v_items_canon text;
  v_request_hash text;
BEGIN
  IF p_total_amount IS NULL OR p_total_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'total_amount debe ser mayor a 0');
  END IF;

  -- ── Idempotencia (solo si viene key) ──────────────────────────────────────
  IF v_key IS NOT NULL THEN
    SELECT string_agg(line, '|' ORDER BY line) INTO v_items_canon
    FROM (
      SELECT COALESCE(NULLIF(it->>'inventory_id',''),'∅') || ':' ||
             COALESCE(NULLIF(btrim(it->>'product_name'),''),'∅') || ':' ||
             round(COALESCE((it->>'quantity')::numeric,0),4)::text || ':' ||
             round(COALESCE((it->>'unit_cost')::numeric,0),2)::text AS line
      FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) it
    ) s;

    v_request_hash := encode(extensions.digest(
      p_business_id::text || '§' ||
      COALESCE(p_supplier_id::text,'∅') || '§' ||
      COALESCE(NULLIF(btrim(p_supplier_name),''),'∅') || '§' ||
      COALESCE(p_purchase_date::text,'∅') || '§' ||
      COALESCE(NULLIF(btrim(p_invoice_number),''),'∅') || '§' ||
      round(COALESCE(p_total_amount,0),2)::text || '§' ||
      round(COALESCE(p_paid_amount,0),2)::text || '§' ||
      COALESCE(NULLIF(btrim(p_payment_method),''),'∅') || '§' ||
      COALESCE(v_items_canon,'∅')
    , 'sha256'), 'hex');

    SELECT * INTO v_existing FROM supplier_purchase_requests
      WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_request_hash THEN
        RETURN jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_CONFLICT',
          'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.');
      END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'purchase_id', v_existing.purchase_id);
    END IF;

    -- El INSERT es el lock: dos conexiones con la misma key se serializan acá.
    BEGIN
      INSERT INTO supplier_purchase_requests (business_id, user_id, idempotency_key, request_hash)
        VALUES (p_business_id, p_user_id, v_key, v_request_hash) RETURNING id INTO v_req_id;
    EXCEPTION WHEN unique_violation THEN
      SELECT * INTO v_existing FROM supplier_purchase_requests
        WHERE business_id=p_business_id AND idempotency_key=v_key;
      IF v_existing.request_hash IS DISTINCT FROM v_request_hash THEN
        RETURN jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_CONFLICT',
          'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.');
      END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'purchase_id', v_existing.purchase_id);
    END;
  END IF;

  v_inv_num  := NULLIF(trim(COALESCE(p_invoice_number, '')), '');
  v_desc_sfx := COALESCE(' #' || v_inv_num, '');

  v_pending := GREATEST(0, p_total_amount - COALESCE(p_paid_amount, 0));
  IF COALESCE(p_paid_amount, 0) <= 0            THEN v_status := 'pending';
  ELSIF p_paid_amount >= p_total_amount - 0.01  THEN v_status := 'paid';
  ELSE v_status := 'partial';
  END IF;

  -- 1. Purchase header
  INSERT INTO public.supplier_purchases (
    business_id, supplier_id, purchase_date, invoice_number,
    total_amount, paid_amount, pending_amount, payment_status,
    payment_method, notes, created_by
  ) VALUES (
    p_business_id, p_supplier_id, p_purchase_date, v_inv_num,
    p_total_amount, COALESCE(p_paid_amount, 0), v_pending, v_status,
    NULLIF(trim(COALESCE(p_payment_method, '')), ''),
    NULLIF(trim(COALESCE(p_notes, '')), ''),
    p_user_id
  ) RETURNING * INTO v_purchase;

  -- 2. Items + stock
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    INSERT INTO public.supplier_purchase_items (
      business_id, purchase_id, supplier_id, inventory_id,
      product_name, quantity, unit_cost, subtotal
    ) VALUES (
      p_business_id, v_purchase.id, p_supplier_id,
      NULLIF(trim(COALESCE(v_item->>'inventory_id', '')), '')::uuid,
      v_item->>'product_name',
      (v_item->>'quantity')::numeric,
      (v_item->>'unit_cost')::numeric,
      (v_item->>'quantity')::numeric * (v_item->>'unit_cost')::numeric
    );

    IF (v_item->>'inventory_id') IS NOT NULL AND trim(COALESCE(v_item->>'inventory_id','')) <> '' THEN
      SELECT stock_quantity INTO v_prev_stk
      FROM public.inventory
      WHERE id = (v_item->>'inventory_id')::uuid AND business_id = p_business_id;

      IF FOUND THEN
        v_new_stk := COALESCE(v_prev_stk, 0) + FLOOR((v_item->>'quantity')::numeric)::integer;

        UPDATE public.inventory
           SET stock_quantity = v_new_stk,
               stock          = v_new_stk,
               cost_price     = (v_item->>'unit_cost')::numeric,
               updated_at     = now()
         WHERE id = (v_item->>'inventory_id')::uuid AND business_id = p_business_id;

        INSERT INTO public.inventory_movements (
          inventory_item_id, movement_type, quantity,
          previous_stock, new_stock, reference_type, reference_id,
          note, business_id, created_by, supplier_id,
          unit_cost, currency, exchange_rate
        ) VALUES (
          (v_item->>'inventory_id')::uuid, 'purchase',
          FLOOR((v_item->>'quantity')::numeric)::integer,
          COALESCE(v_prev_stk, 0), v_new_stk,
          'supplier_purchase', v_purchase.id,
          'Compra a ' || p_supplier_name || v_desc_sfx,
          p_business_id, p_user_id, p_supplier_id,
          (v_item->>'unit_cost')::numeric, 'ARS', 1
        );
      END IF;
    END IF;
  END LOOP;

  -- 3. CC debit
  INSERT INTO public.supplier_account_movements (
    business_id, supplier_id, purchase_id, payment_id,
    movement_date, type, description, debit, credit, balance_after
  ) VALUES (
    p_business_id, p_supplier_id, v_purchase.id, NULL,
    p_purchase_date, 'purchase',
    'Compra' || v_desc_sfx,
    p_total_amount, 0, 0
  );

  -- 4. Initial payment (only when paid_amount > 0)
  IF COALESCE(p_paid_amount, 0) > 0 THEN
    INSERT INTO public.financial_movements (
      business_id, date, type, currency, amount, amount_ars, exchange_rate,
      source, description, created_by, metodo_pago,
      sign, reference_id, reference_type
    ) VALUES (
      p_business_id, p_purchase_date, 'expense', 'ARS',
      p_paid_amount, p_paid_amount, 1,
      'pago_proveedor',
      'Compra a ' || p_supplier_name || v_desc_sfx,
      p_user_id,
      NULLIF(trim(COALESCE(p_payment_method, '')), ''),
      1, v_purchase.id, 'supplier_purchase'
    ) RETURNING * INTO v_fm;

    -- variable_cost / compras_proveedor → economic_class supplier_liability_payment (fuera del P&L)
    INSERT INTO public.business_finance_entries (
      business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate,
      payment_method, created_by, source
    ) VALUES (
      p_business_id, p_purchase_date, 'variable_cost', 'compras_proveedor',
      'Compra a ' || p_supplier_name || v_desc_sfx,
      p_paid_amount, 'ARS', p_paid_amount, 1,
      NULLIF(trim(COALESCE(p_payment_method, '')), ''),
      p_user_id, 'pago_proveedor'
    );

    INSERT INTO public.supplier_payments (
      business_id, supplier_id, purchase_id, payment_date,
      amount, payment_method, notes, created_by, financial_movement_id
    ) VALUES (
      p_business_id, p_supplier_id, v_purchase.id, p_purchase_date,
      p_paid_amount,
      COALESCE(NULLIF(trim(COALESCE(p_payment_method,'')), ''), 'efectivo'),
      'Pago inicial al crear compra' || v_desc_sfx,
      p_user_id, v_fm.id
    ) RETURNING * INTO v_payment;

    INSERT INTO public.supplier_account_movements (
      business_id, supplier_id, purchase_id, payment_id,
      movement_date, type, description, debit, credit, balance_after
    ) VALUES (
      p_business_id, p_supplier_id, v_purchase.id, v_payment.id,
      p_purchase_date, 'payment',
      'Pago inicial compra' || v_desc_sfx,
      0, p_paid_amount, 0
    );
  END IF;

  IF v_key IS NOT NULL THEN
    UPDATE supplier_purchase_requests SET purchase_id=v_purchase.id WHERE id=v_req_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'replay', false, 'purchase_id', v_purchase.id);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

ALTER FUNCTION "public"."create_supplier_purchase_atomic"(uuid, uuid, uuid, text, date, text, numeric, numeric, text, text, jsonb, text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."create_supplier_purchase_atomic"(uuid, uuid, uuid, text, date, text, numeric, numeric, text, text, jsonb, text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."create_supplier_purchase_atomic"(uuid, uuid, uuid, text, date, text, numeric, numeric, text, text, jsonb, text) TO "authenticated", "service_role";

-- ============================================================================
-- ROLLBACK (documentado): DROP la firma de 12 args + recrear la de 11 (cuerpo
-- previo, sin idempotencia) + DROP TABLE supplier_purchase_requests.
-- ============================================================================
