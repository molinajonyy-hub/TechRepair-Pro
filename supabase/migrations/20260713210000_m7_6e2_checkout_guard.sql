-- ============================================================================
-- M7 (Bloque 6E.2) — create_comprobante_checkout_atomic: aditivos M7 sobre el
-- checkout de venta (E1). NO cambia politica comercial (sobrepago, vuelto,
-- descuentos, CC, stock floor-0, precios ARS/USD, redondeos: intactos) ni la
-- emision fiscal/ARCA. Preserva el CONTRATO status: created/existing/
-- idempotency_conflict/already_processing/failed_retryable/failed_final.
--
-- Agrega:
--   §5  fecha economica canonica (ar_today) + guard de periodo defensivo;
--   §6  finance_begin_audit_scope -> el backstop E1 NO registra por-pago; se emite
--       UN unico evento sale_checkout (la venta completa, no un evento por pago);
--   §9  cantidades ENTERAS (>=1, sin fraccion) — sin FLOOR/truncado silencioso;
--   §11 lock DETERMINISTA de inventario (ORDER BY id FOR UPDATE) contra deadlocks;
--   §16 error_code ADITIVO (no expone SQLERRM inesperado);
--   §7/§17 request table endurecida (fail-closed, op, inmutabilidad).
-- La idempotencia ya era race-safe (idx UNIQUE business_id,idempotency_key existente).
-- ============================================================================

-- ── Part A — endurecer comprobante_checkout_requests ────────────────────────
ALTER TABLE "public"."comprobante_checkout_requests" ADD COLUMN IF NOT EXISTS "op" text;
-- 6E.2a: hash canonico calculado en SERVIDOR (autoridad de idempotencia). No NOT NULL:
-- filas legacy productivas no lo tienen -> fallback documentado a client_request_hash.
ALTER TABLE "public"."comprobante_checkout_requests" ADD COLUMN IF NOT EXISTS "server_request_hash" text;
DROP POLICY IF EXISTS "checkout_requests_select" ON "public"."comprobante_checkout_requests";
REVOKE ALL ON "public"."comprobante_checkout_requests" FROM PUBLIC, "anon", "authenticated";
REVOKE UPDATE, DELETE, TRUNCATE ON "public"."comprobante_checkout_requests" FROM "service_role";
GRANT SELECT, INSERT ON "public"."comprobante_checkout_requests" TO "service_role";  -- la RPC (definer/postgres) hace los UPDATE de estado

CREATE OR REPLACE FUNCTION "public"."comprobante_checkout_requests_immutable"() RETURNS "trigger"
    LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION '% es append-only: DELETE no permitido', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  -- Inmutables: negocio, key, hash del cliente. El estado (status/comprobante_id/errores/
  -- timestamps/op/resolved_hash) SI puede transicionar (maquina de estados del checkout).
  IF NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.client_request_hash IS DISTINCT FROM OLD.client_request_hash THEN
    RAISE EXCEPTION '%: business_id/idempotency_key/client_request_hash son inmutables', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  -- 6E.2a: server_request_hash es inmutable una vez fijado (autoridad de idempotencia).
  IF OLD.server_request_hash IS NOT NULL AND NEW.server_request_hash IS DISTINCT FROM OLD.server_request_hash THEN
    RAISE EXCEPTION '%: server_request_hash ya fijado es inmutable', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  -- comprobante_id: solo se puede fijar una vez y al comprobante del MISMO negocio.
  IF OLD.comprobante_id IS NOT NULL AND NEW.comprobante_id IS DISTINCT FROM OLD.comprobante_id THEN
    RAISE EXCEPTION '%: comprobante_id ya fijado es inmutable', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  IF NEW.comprobante_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM comprobantes WHERE id=NEW.comprobante_id AND business_id=NEW.business_id) THEN
    RAISE EXCEPTION '%: el comprobante enlazado no pertenece al negocio', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  RETURN NEW;
END; $$;
ALTER FUNCTION "public"."comprobante_checkout_requests_immutable"() OWNER TO "postgres";
DROP TRIGGER IF EXISTS "trg_checkout_requests_immutable" ON "public"."comprobante_checkout_requests";
CREATE TRIGGER "trg_checkout_requests_immutable"
  BEFORE UPDATE OR DELETE ON "public"."comprobante_checkout_requests"
  FOR EACH ROW EXECUTE FUNCTION "public"."comprobante_checkout_requests_immutable"();

-- ── Part A2 — helpers 6E.2a ─────────────────────────────────────────────────
-- Catalogo de metodos de pago del checkout = CHECK de comprobante_payments
-- (efectivo/transferencia/tarjeta_debito/tarjeta_credito/qr/mixto/otro).
-- NO se reutiliza normalize_supplier_payment_method (catalogo distinto).
-- cuenta_corriente NO es metodo de comprobante_payment (se rutea por cc_total).
CREATE OR REPLACE FUNCTION "public"."normalize_checkout_payment_method"(p_method text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public'
AS $function$
DECLARE v text := lower(btrim(COALESCE(p_method, '')));
BEGIN
  IF v = '' OR v <> ALL (ARRAY['efectivo','transferencia','tarjeta_debito','tarjeta_credito','qr','mixto','otro']) THEN
    RAISE EXCEPTION 'INVALID_CHECKOUT_METHOD' USING ERRCODE = '22023';
  END IF;
  RETURN v;
END; $function$;
ALTER FUNCTION "public"."normalize_checkout_payment_method"(text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."normalize_checkout_payment_method"(text) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."normalize_checkout_payment_method"(text) TO "service_role";

-- Hash canonico de la INTENCION economica del checkout, calculado SERVER-SIDE
-- (autoridad de idempotencia). Reproduce la semantica de checkoutIdempotency.ts
-- (orden de items/pagos NO semantico -> se ordenan canonicamente; numeros a escala
-- fija; nulos/btrim normalizados) y la AMPLIA con campos persistidos que el hash
-- cliente omite (order_id, observaciones, exchange_rate, flags fiscales, punto_venta,
-- amount_ars/provider/comisiones/net por pago). No depende de totales del cliente
-- (los recomputa la RPC) salvo cc_total, que decide el ruteo caja/CC. Valida los
-- metodos (RAISE INVALID_CHECKOUT_METHOD) — la RPC lo mapea a VALIDATION_ERROR.
CREATE OR REPLACE FUNCTION "public"."compute_checkout_intent_hash"(p_business_id uuid, p_payload jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public'
AS $function$
DECLARE v_items jsonb; v_pagos jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(elem ORDER BY elem->>'inventory_id', elem->>'descripcion', elem->>'tipo_linea',
                            elem->>'cantidad', elem->>'precio_unitario', elem->>'descuento_linea', elem->>'currency'), '[]'::jsonb)
  INTO v_items FROM (
    SELECT jsonb_build_object(
      'inventory_id', NULLIF(btrim(it->>'inventory_id'),''),
      'descripcion', NULLIF(btrim(it->>'descripcion'),''),
      'tipo_linea', COALESCE(NULLIF(btrim(it->>'tipo_linea'),''),'producto'),
      'cantidad', round(COALESCE((it->>'cantidad')::numeric,0),2),
      'precio_unitario', round(COALESCE((it->>'precio_unitario')::numeric,0),2),
      'descuento_linea', round(COALESCE((it->>'descuento_linea')::numeric,0),2),
      'currency', COALESCE(NULLIF(btrim(it->>'currency'),''),'ARS')) AS elem
    FROM jsonb_array_elements(COALESCE(p_payload->'items','[]'::jsonb)) it) s;

  SELECT COALESCE(jsonb_agg(elem ORDER BY elem->>'method', elem->>'amount', elem->>'amount_ars',
                            elem->>'currency', elem->>'payment_provider', elem->>'net_amount'), '[]'::jsonb)
  INTO v_pagos FROM (
    SELECT jsonb_build_object(
      'method', public.normalize_checkout_payment_method(pg->>'payment_method'),
      'amount', round(COALESCE((pg->>'amount')::numeric,0),2),
      'amount_ars', round(COALESCE((pg->>'amount_ars')::numeric,0),2),
      'currency', COALESCE(NULLIF(btrim(pg->>'currency'),''),'ARS'),
      'exchange_rate', round(COALESCE((pg->>'exchange_rate')::numeric,1),6),
      'payment_provider', NULLIF(btrim(pg->>'payment_provider'),''),
      'commission_rate', round(COALESCE((pg->>'commission_rate')::numeric,0),4),
      'net_amount', round(COALESCE((pg->>'net_amount')::numeric,0),2)) AS elem
    FROM jsonb_array_elements(COALESCE(p_payload->'pagos','[]'::jsonb)) pg) s;

  RETURN encode(extensions.digest(jsonb_build_object(
    'v','checkout_intent_v1', 'op','sale_checkout', 'business_id',p_business_id,
    'tipo', NULLIF(btrim(p_payload->>'tipo'),''),
    'punto_venta', COALESCE(NULLIF(btrim(p_payload->>'punto_venta'),''),'0001'),
    'condicion_fiscal', COALESCE(NULLIF(btrim(p_payload->>'condicion_fiscal'),''),'Consumidor Final'),
    'customer_id', NULLIF(p_payload->>'customer_id',''),
    'order_id', NULLIF(p_payload->>'order_id',''),
    'observaciones', NULLIF(btrim(p_payload->>'observaciones'),''),
    'currency', COALESCE(NULLIF(btrim(p_payload->>'currency'),''),'ARS'),
    'exchange_rate', round(COALESCE((p_payload->>'exchange_rate')::numeric,1),6),
    'es_fiscal', COALESCE((p_payload->>'es_fiscal')::boolean,false),
    'emitir_en_arca', COALESCE((p_payload->>'emitir_en_arca')::boolean,false),
    'skip_finance_entry', COALESCE((p_payload->>'skip_finance_entry')::boolean,false),
    'cc_total', round(COALESCE((p_payload->>'cc_total')::numeric,0),2),
    'items', v_items, 'pagos', v_pagos)::text, 'sha256'), 'hex');
END; $function$;
ALTER FUNCTION "public"."compute_checkout_intent_hash"(uuid, jsonb) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."compute_checkout_intent_hash"(uuid, jsonb) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."compute_checkout_intent_hash"(uuid, jsonb) TO "service_role";

-- ── Part B — RPC ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_comprobante_checkout_atomic(p_business_id uuid, p_idempotency_key text, p_request_hash text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  c_tolerance_ars     constant numeric := 1.00;
  v_has_access        boolean := false;
  v_existing          comprobante_checkout_requests%ROWTYPE;
  v_request_id        uuid;
  v_comp_id           uuid;
  v_tipo              text;
  v_es_fiscal         boolean;
  v_emitir_en_arca    boolean;
  v_skip_finance      boolean;
  v_exchange_rate     numeric;
  v_customer_id       uuid;
  v_caja_id           uuid;
  v_punto_venta       text;
  v_condicion_fiscal  text;
  v_observaciones     text;
  v_order_id          uuid;
  v_estado_comercial  text;
  v_subtotal_ars      numeric := 0;
  v_tax               numeric := 0;
  v_total             numeric := 0;
  v_total_usd         numeric := 0;
  v_descuento_total   numeric := 0;
  v_costo_total_ars   numeric := 0;
  v_total_comisiones  numeric;
  v_total_neto        numeric;
  v_total_bruto       numeric;
  v_cc_total          numeric;
  v_cash_total        numeric := 0;
  v_numero_int        integer;
  v_numero            text;
  v_item              jsonb;
  v_pago              jsonb;
  v_item_id           uuid;
  v_prev_stock        integer;
  v_new_stock         integer;
  v_mov_id            uuid;
  v_account_id        uuid;
  v_customer_name     text;
  v_customer_phone    text;
  v_is_wholesale      boolean;
  v_dollar_rate       numeric := 1;
  v_can_override      boolean;
  v_can_below_cost    boolean;
  v_inv               inventory%ROWTYPE;
  v_line_qty          numeric;
  v_line_desc_pct     numeric;
  v_line_price_client numeric;
  v_line_price_final  numeric;
  v_line_cost_final   numeric;
  v_line_mayorista    numeric;
  v_price_source      text;
  v_is_override       boolean;
  v_line_subtotal     numeric;
  v_line_cost_total   numeric;
  v_resolved_items    jsonb := '[]'::jsonb;
  v_pago_ars          numeric;
  -- M7 6E.2
  v_economic_date     date;
  v_n_products        int := 0;
  v_n_payments        int := 0;
  v_in_audit          boolean := false;
  v_ec                text;
  v_ret_msg           text;
  -- M7 6E.2a
  v_server_hash       text;
  v_hashes_match      boolean;
  v_pay_id            uuid;
  v_pay_ids           uuid[] := '{}';
  v_pay_methods       text[] := '{}';
  v_pay_summary       jsonb := '[]'::jsonb;
  v_fm_ids            uuid[];
  v_cogs_bfe_id       uuid;
  v_am_id             uuid;
BEGIN
  -- ── Ownership: resolver y validar acceso real al negocio ────────────────
  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id = p_business_id AND owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id = p_business_id AND user_id = auth.uid())
  ) INTO v_has_access;
  IF NOT v_has_access THEN
    RETURN jsonb_build_object('status', 'failed_final', 'error', 'No autorizado para este negocio', 'error_code', 'FORBIDDEN');
  END IF;

  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RETURN jsonb_build_object('status', 'failed_final', 'error', 'idempotency_key requerida', 'error_code', 'VALIDATION_ERROR');
  END IF;
  IF p_request_hash IS NULL OR length(trim(p_request_hash)) = 0 THEN
    RETURN jsonb_build_object('status', 'failed_final', 'error', 'request_hash requerido', 'error_code', 'VALIDATION_ERROR');
  END IF;

  v_can_override   := user_can_override_price(p_business_id, auth.uid());
  v_can_below_cost := user_can_sell_below_cost(p_business_id, auth.uid());

  -- ── M7 6E.2a: hash canonico SERVER-SIDE (autoridad de idempotencia) ANTES de
  -- reservar. El cliente NO es fuente de verdad. Valida metodos de pago (rechazo
  -- antes de reservar). p_request_hash se conserva para compat/diagnostico.
  BEGIN
    v_server_hash := public.compute_checkout_intent_hash(p_business_id, p_payload);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'INVALID_CHECKOUT_METHOD%' THEN
      RETURN jsonb_build_object('status','failed_final','error','Método de pago inválido','error_code','VALIDATION_ERROR');
    ELSE RAISE; END IF;
  END;
  v_hashes_match := (p_request_hash IS NOT DISTINCT FROM v_server_hash);

  -- ── Idempotencia: intentar registrar la request — ESTE INSERT ES EL LOCK ──
  -- (idx UNIQUE business_id,idempotency_key). Replay/conflict retornan ANTES de
  -- cualquier escritura economica y del guard de periodo (no crean una venta nueva).
  SET LOCAL lock_timeout = '8s';
  BEGIN
    INSERT INTO comprobante_checkout_requests (business_id, user_id, op, idempotency_key, client_request_hash, server_request_hash, status)
    VALUES (p_business_id, auth.uid(), 'sale_checkout', p_idempotency_key, p_request_hash, v_server_hash, 'processing')
    RETURNING id INTO v_request_id;
  EXCEPTION
    WHEN lock_not_available THEN
      RETURN jsonb_build_object('status', 'already_processing');
    WHEN unique_violation THEN
      SELECT * INTO v_existing FROM comprobante_checkout_requests
        WHERE business_id = p_business_id AND idempotency_key = p_idempotency_key;

      -- Replay/conflicto por server_request_hash (autoridad). Fallback legacy:
      -- filas antiguas sin server hash usan client_request_hash (comportamiento previo).
      IF (v_existing.server_request_hash IS NOT NULL AND v_existing.server_request_hash IS DISTINCT FROM v_server_hash)
         OR (v_existing.server_request_hash IS NULL AND v_existing.client_request_hash IS DISTINCT FROM p_request_hash) THEN
        RETURN jsonb_build_object('status', 'idempotency_conflict', 'error_code', 'IDEMPOTENCY_CONFLICT');
      END IF;

      IF v_existing.status = 'completed' THEN
        RETURN jsonb_build_object('status', 'existing', 'comprobante_id', v_existing.comprobante_id);
      ELSIF v_existing.status = 'failed_final' THEN
        RETURN jsonb_build_object('status', 'failed_final', 'error', v_existing.last_error_message, 'error_code', COALESCE(v_existing.last_error_code,'INTERNAL_ERROR'));
      ELSIF v_existing.status = 'processing' THEN
        RETURN jsonb_build_object('status', 'already_processing');
      ELSE -- 'failed_retryable'
        UPDATE comprobante_checkout_requests
          SET status = 'processing', updated_at = now()
          WHERE id = v_existing.id AND status = 'failed_retryable';
        IF NOT FOUND THEN
          RETURN jsonb_build_object('status', 'already_processing');
        END IF;
        v_request_id := v_existing.id;
      END IF;
  END;

  -- ── Bloque de trabajo (savepoint implícito vía EXCEPTION) ────────────────
  BEGIN
    -- M7 §5: fecha economica canonica (el checkout siempre crea ventas actuales).
    v_economic_date := public.ar_today();
    -- M7 §5: guard de periodo defensivo ANTES de cualquier escritura economica.
    -- (el mes actual no puede cerrarse via close_period; casi siempre no-op.)
    PERFORM public.assert_period_open(p_business_id, v_economic_date);
    -- M7 §6: scope de auditoria -> el backstop E1 de comprobante_payments/account_movements
    -- NO registra por-linea; al final se emite UN unico evento sale_checkout.
    PERFORM public.finance_begin_audit_scope();

    v_tipo             := p_payload->>'tipo';
    v_es_fiscal        := COALESCE((p_payload->>'es_fiscal')::boolean, false);
    v_emitir_en_arca   := COALESCE((p_payload->>'emitir_en_arca')::boolean, false);
    v_skip_finance     := COALESCE((p_payload->>'skip_finance_entry')::boolean, false);
    v_exchange_rate    := COALESCE((p_payload->>'exchange_rate')::numeric, 1);
    v_customer_id      := NULLIF(p_payload->>'customer_id', '')::uuid;
    v_caja_id          := NULLIF(p_payload->>'caja_id', '')::uuid;
    v_punto_venta      := COALESCE(p_payload->>'punto_venta', '0001');
    v_condicion_fiscal := COALESCE(p_payload->>'condicion_fiscal', 'Consumidor Final');
    v_observaciones    := p_payload->>'observaciones';
    v_order_id         := NULLIF(p_payload->>'order_id', '')::uuid;

    IF v_tipo NOT IN ('remito', 'factura_a', 'factura_c', 'nota_credito') THEN
      RAISE EXCEPTION 'tipo de comprobante invalido: %', v_tipo;
    END IF;

    -- ── Cliente mayorista/minorista (server-side, nunca confiado del payload) ──
    v_is_wholesale := false;
    IF v_customer_id IS NOT NULL THEN
      SELECT (customer_type = 'mayorista'), name, phone
        INTO v_is_wholesale, v_customer_name, v_customer_phone
        FROM customers WHERE id = v_customer_id AND business_id = p_business_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'CUSTOMER_NOT_FOUND: el cliente no pertenece a este negocio';
      END IF;
      v_is_wholesale := COALESCE(v_is_wholesale, false);
    END IF;

    -- M7 §4: orden del MISMO negocio (si viene)
    IF v_order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM orders WHERE id = v_order_id AND business_id = p_business_id) THEN
      RAISE EXCEPTION 'ORDER_NOT_FOUND: la orden no pertenece a este negocio';
    END IF;

    -- ── Cotización vigente del negocio (server-side) ─────────────────────────
    SELECT rate INTO v_dollar_rate FROM exchange_rates
      WHERE business_id = p_business_id AND base_currency = 'USD' AND target_currency = 'ARS'
      ORDER BY updated_at DESC LIMIT 1;
    v_dollar_rate := COALESCE(v_dollar_rate, 1);

    -- ── 1-2. Ítems: resolver precio/costo server-side, validar overrides ─────
    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'items', '[]'::jsonb))
    LOOP
      v_line_qty          := COALESCE((v_item->>'cantidad')::numeric, 0);
      v_line_desc_pct     := LEAST(GREATEST(COALESCE((v_item->>'descuento_linea')::numeric, 0), 0), 100);
      v_line_price_client := COALESCE((v_item->>'precio_unitario')::numeric, 0);

      -- M7 §9: cantidades ENTERAS positivas (TechRepair maneja solo unidades enteras).
      -- Sin FLOOR/truncado silencioso: 1.5/0.5/2.0001/0/negativos/NaN/Infinity -> rechazo.
      IF v_line_qty::text IN ('NaN', 'Infinity', '-Infinity')
         OR v_line_qty < 1 OR v_line_qty <> trunc(v_line_qty) OR v_line_qty > 1000000 THEN
        RAISE EXCEPTION 'QTY_NOT_INTEGER: cantidad entera >=1 requerida (item: %)', v_item->>'descripcion';
      END IF;
      IF v_line_price_client::text IN ('NaN', 'Infinity', '-Infinity') OR v_line_price_client < 0 THEN
        RAISE EXCEPTION 'precio_unitario invalido (negativo, NaN o infinito) en item: %', v_item->>'descripcion';
      END IF;

      IF NULLIF(v_item->>'inventory_id', '') IS NOT NULL THEN
        -- ── Ítem de PRODUCTO: resolver desde inventory, nunca confiar en el payload ──
        SELECT * INTO v_inv FROM inventory
          WHERE id = (v_item->>'inventory_id')::uuid AND business_id = p_business_id;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'inventory_id % no pertenece a este negocio o no existe', v_item->>'inventory_id';
        END IF;

        SELECT sale_ars, cost_ars, mayorista_ars INTO v_line_price_final, v_line_cost_final, v_line_mayorista
          FROM resolve_product_pricing(
            v_inv.sale_price, v_inv.precio_mayorista, v_inv.cost_price, v_inv.cost_price_usd,
            v_inv.base_currency, v_inv.base_price, v_inv.auto_update_price, v_inv.exchange_rate_used,
            v_dollar_rate
          );
        v_line_desc_pct := LEAST(GREATEST(COALESCE((v_item->>'descuento_linea')::numeric, 0), 0), 100);

        IF v_is_wholesale AND v_line_mayorista IS NOT NULL AND v_line_mayorista > 0 THEN
          v_line_price_final := v_line_mayorista;
          v_price_source := 'resolved_mayorista';
        ELSE
          v_price_source := 'resolved_minorista';
        END IF;

        -- ── Override: el cliente mandó un precio o descuento distinto del resuelto ──
        v_is_override := (abs(v_line_price_client - v_line_price_final) > 0.01) OR (v_line_desc_pct > 0);
        IF v_is_override THEN
          IF NOT v_can_override THEN
            RAISE EXCEPTION 'usuario sin permiso para modificar el precio/descuento del item: %', v_item->>'descripcion';
          END IF;
          v_price_source := 'manual_override';
        ELSE
          v_line_price_client := v_line_price_final;
        END IF;

        IF v_line_price_client < v_line_cost_final AND NOT v_can_below_cost THEN
          RAISE EXCEPTION 'usuario sin permiso para vender por debajo del costo en item: %', v_item->>'descripcion';
        END IF;
      ELSE
        -- ── Ítem de SERVICIO/MANUAL ──
        v_line_price_final := v_line_price_client;
        v_line_cost_final  := COALESCE((v_item->>'costo_unitario')::numeric, 0);
        v_price_source      := 'manual_service';
        v_is_override       := false;
      END IF;

      v_line_subtotal   := v_line_price_client * v_line_qty * (1 - v_line_desc_pct / 100.0);
      v_line_cost_total := v_line_cost_final * v_line_qty;

      v_subtotal_ars    := v_subtotal_ars + v_line_subtotal;
      v_costo_total_ars := v_costo_total_ars + v_line_cost_total;
      v_descuento_total := v_descuento_total + (v_line_price_client * v_line_qty * (v_line_desc_pct / 100.0));

      v_item := v_item
        || jsonb_build_object('_resolved_precio', v_line_price_client)
        || jsonb_build_object('_resolved_costo', v_line_cost_final)
        || jsonb_build_object('_resolved_subtotal', v_line_subtotal)
        || jsonb_build_object('_resolved_descuento', v_line_desc_pct)
        || jsonb_build_object('_price_source', v_price_source)
        || jsonb_build_object('_price_override', v_is_override)
        || jsonb_build_object('_list_price', v_line_price_final);

      v_resolved_items := v_resolved_items || jsonb_build_array(v_item);
    END LOOP;

    v_tax   := CASE WHEN v_tipo = 'factura_a' THEN v_subtotal_ars * 0.21 ELSE 0 END;
    v_total := v_subtotal_ars + v_tax;
    v_total_usd := CASE WHEN v_dollar_rate > 0 THEN v_total / v_dollar_rate ELSE 0 END;
    v_total_bruto := v_total;

    -- ── Pagos: sumar server-side (nunca confiar en un total de pagos del cliente) ──
    SELECT COALESCE(SUM((p->>'amount_ars')::numeric), 0) INTO v_cash_total
      FROM jsonb_array_elements(COALESCE(p_payload->'pagos', '[]'::jsonb)) p;
    v_cc_total := COALESCE((p_payload->>'cc_total')::numeric, 0);

    FOR v_pago IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'pagos', '[]'::jsonb))
    LOOP
      IF COALESCE((v_pago->>'amount')::numeric, -1) < 0
         OR COALESCE((v_pago->>'amount_ars')::numeric, -1) < 0
         OR COALESCE((v_pago->>'amount_ars')::numeric, 0)::text IN ('NaN', 'Infinity', '-Infinity') THEN
        RAISE EXCEPTION 'pago con monto negativo o invalido no permitido';
      END IF;
    END LOOP;
    IF v_cc_total < 0 OR v_cc_total::text IN ('NaN', 'Infinity', '-Infinity') THEN
      RAISE EXCEPTION 'cc_total invalido';
    END IF;

    -- ── INVARIANTE DE COBRO (Etapa 0) ─────────────────────────────────────────
    IF v_cc_total > 0.01 AND v_customer_id IS NULL THEN
      RAISE EXCEPTION 'la cuenta corriente requiere un cliente asignado (cc=% sin customer_id)', v_cc_total;
    END IF;

    IF v_tipo = 'nota_credito' THEN
      -- Una NC es un documento de reversión: no lleva cobros ni genera deuda.
      IF v_cash_total > 0.01 OR v_cc_total > 0.01 THEN
        RAISE EXCEPTION 'una nota de credito no lleva pagos ni cuenta corriente (pagos=%, cc=%)', v_cash_total, v_cc_total;
      END IF;
    ELSE
      IF (v_cash_total + v_cc_total) > (v_total_bruto + c_tolerance_ars) THEN
        RAISE EXCEPTION 'los pagos (caja + cuenta corriente) exceden el total: total=% pagos=% cuenta_corriente=% diferencia=%',
          round(v_total_bruto, 2), round(v_cash_total, 2), round(v_cc_total, 2),
          round((v_cash_total + v_cc_total) - v_total_bruto, 2);
      END IF;
      IF (v_cash_total + v_cc_total) < (v_total_bruto - c_tolerance_ars) THEN
        RAISE EXCEPTION 'el cobro no cubre el total del comprobante: total=% pagos=% cuenta_corriente=% diferencia=% — completá el pago o registrá el saldo explícitamente como cuenta corriente',
          round(v_total_bruto, 2), round(v_cash_total, 2), round(v_cc_total, 2),
          round(v_total_bruto - (v_cash_total + v_cc_total), 2);
      END IF;
    END IF;

    v_total_comisiones := COALESCE((p_payload->>'total_comisiones')::numeric, 0);
    v_total_neto       := v_total_bruto - v_total_comisiones;

    v_estado_comercial := CASE
      WHEN v_cash_total >= v_total_bruto - c_tolerance_ars THEN 'pagado'
      WHEN v_cash_total > 0 OR v_cc_total > 0 THEN 'parcial'
      ELSE 'pendiente'
    END;

    -- ── Número local: reserva ATÓMICA ─────────────────────────────────────────
    v_numero_int := reserve_comprobante_number(p_business_id, v_tipo);
    IF v_punto_venta IS NULL OR trim(v_punto_venta) = '' THEN
      v_numero := lpad(v_numero_int::text, 8, '0');
    ELSE
      v_numero := lpad(v_punto_venta, 4, '0') || '-' || lpad(v_numero_int::text, 8, '0');
    END IF;

    -- ── 3. Comprobante ────────────────────────────────────────────────────────
    INSERT INTO comprobantes (
      business_id, created_by, customer_id, order_id, tipo, type, punto_venta,
      numero, number, numero_secuencial, fecha, date, condicion_fiscal, observaciones, currency,
      exchange_rate, subtotal, impuestos, tax, total, total_ars, total_usd,
      descuento_total, recargo_total, total_bruto, total_cobrado, saldo_pendiente,
      total_comisiones, total_neto, estado, status, estado_comercial, estado_fiscal,
      es_fiscal, emitir_en_arca, cae, cae_vencimiento, numero_fiscal
    ) VALUES (
      p_business_id, auth.uid(), v_customer_id, v_order_id, v_tipo, v_tipo, v_punto_venta,
      v_numero, v_numero, v_numero_int, now(), now(), v_condicion_fiscal, v_observaciones, 'ARS',
      v_exchange_rate, v_subtotal_ars, v_tax, v_tax, v_total, v_total, v_total_usd,
      v_descuento_total, 0, v_total_bruto, 0, v_total_bruto,
      v_total_comisiones, v_total_neto,
      CASE WHEN v_es_fiscal THEN 'borrador' ELSE 'emitido' END,
      CASE WHEN v_es_fiscal THEN 'draft' ELSE 'issued' END,
      v_estado_comercial,
      CASE WHEN v_es_fiscal THEN 'pendiente_emision' ELSE 'no_fiscal' END,
      v_es_fiscal, v_emitir_en_arca, NULL, NULL, NULL
    ) RETURNING id INTO v_comp_id;

    -- M7 §11: lock DETERMINISTA de todas las filas de inventario a descontar, en orden
    -- global por id, ANTES de tocar la primera -> evita deadlocks con lineas en distinto
    -- orden. Se permiten lineas repetidas del mismo producto (semantica POS): cada id se
    -- bloquea una vez; el descuento de stock sigue siendo por-linea mas abajo.
    IF v_tipo <> 'nota_credito' THEN
      PERFORM 1 FROM inventory
        WHERE business_id = p_business_id
          AND id IN (SELECT (it->>'inventory_id')::uuid FROM jsonb_array_elements(v_resolved_items) it
                     WHERE NULLIF(it->>'inventory_id','') IS NOT NULL
                       AND COALESCE(it->>'tipo_linea','producto') IN ('producto','repuesto'))
        ORDER BY id FOR UPDATE;
    END IF;

    -- ── 4-5. Ítems + stock (con precio/costo YA resueltos server-side) ───────
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_resolved_items)
    LOOP
      INSERT INTO comprobante_items (
        comprobante_id, business_id, created_by, descripcion, tipo_linea, cantidad,
        precio_unitario, descuento_linea, subtotal, costo_unitario, costo_total,
        currency, exchange_rate, inventory_id, applied_price_type, orden,
        list_price_ars, price_override, applied_price_source
      ) VALUES (
        v_comp_id, p_business_id, auth.uid(),
        v_item->>'descripcion',
        COALESCE(v_item->>'tipo_linea', 'producto'),
        (v_item->>'cantidad')::numeric,
        (v_item->>'_resolved_precio')::numeric,
        (v_item->>'_resolved_descuento')::numeric,
        (v_item->>'_resolved_subtotal')::numeric,
        (v_item->>'_resolved_costo')::numeric,
        (v_item->>'_resolved_costo')::numeric * (v_item->>'cantidad')::numeric,
        COALESCE(v_item->>'currency', 'ARS'),
        COALESCE((v_item->>'exchange_rate')::numeric, v_exchange_rate),
        NULLIF(v_item->>'inventory_id', '')::uuid,
        v_item->>'applied_price_type',
        COALESCE((v_item->>'orden')::integer, 0),
        (v_item->>'_list_price')::numeric,
        (v_item->>'_price_override')::boolean,
        v_item->>'_price_source'
      ) RETURNING id INTO v_item_id;

      -- Stock: NUNCA para nota_credito (una NC no es una salida de mercadería).
      IF v_tipo <> 'nota_credito'
         AND NULLIF(v_item->>'inventory_id', '') IS NOT NULL
         AND COALESCE(v_item->>'tipo_linea', 'producto') IN ('producto', 'repuesto') THEN

        SELECT stock_quantity INTO v_prev_stock FROM inventory
          WHERE id = (v_item->>'inventory_id')::uuid AND business_id = p_business_id
          FOR UPDATE;

        IF FOUND THEN
          v_prev_stock := COALESCE(v_prev_stock, 0);
          v_new_stock  := GREATEST(0, v_prev_stock - (v_item->>'cantidad')::numeric)::integer;

          UPDATE inventory SET stock_quantity = v_new_stock, updated_at = now()
            WHERE id = (v_item->>'inventory_id')::uuid AND business_id = p_business_id;

          INSERT INTO inventory_movements (
            business_id, inventory_item_id, movement_type, quantity, previous_stock,
            new_stock, reference_type, reference_id, note, created_by
          ) VALUES (
            p_business_id, (v_item->>'inventory_id')::uuid, 'sale',
            -((v_item->>'cantidad')::numeric)::integer, v_prev_stock, v_new_stock,
            'comprobante', v_comp_id, 'Salida por venta en comprobante', auth.uid()
          ) RETURNING id INTO v_mov_id;

          UPDATE comprobante_items
            SET stock_processed = true, stock_processed_at = now(), stock_movement_id = v_mov_id
            WHERE id = v_item_id;
        END IF;
      END IF;
    END LOOP;

    -- ── 6. Pagos de caja: solo montos > 0 (un pago de $0 no existe) ────────────
    FOR v_pago IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'pagos', '[]'::jsonb))
    LOOP
      v_pago_ars := COALESCE((v_pago->>'amount_ars')::numeric, 0);
      IF v_pago_ars > 0 THEN
        INSERT INTO comprobante_payments (
          comprobante_id, business_id, amount, currency, amount_ars, exchange_rate,
          payment_method, payment_provider, commission_rate, commission_amount,
          net_amount, date, created_by
        ) VALUES (
          v_comp_id, p_business_id,
          (v_pago->>'amount')::numeric, COALESCE(v_pago->>'currency', 'ARS'),
          v_pago_ars,
          COALESCE((v_pago->>'exchange_rate')::numeric, v_exchange_rate),
          public.normalize_checkout_payment_method(v_pago->>'payment_method'), v_pago->>'payment_provider',
          COALESCE((v_pago->>'commission_rate')::numeric, 0),
          COALESCE((v_pago->>'commission_amount')::numeric, 0),
          COALESCE((v_pago->>'net_amount')::numeric, v_pago_ars),
          public.ar_today(), auth.uid()
        ) RETURNING id INTO v_pay_id;
        -- M7 6E.2a: referencias compactas para la auditoria (sin datos sensibles).
        v_pay_ids     := v_pay_ids || v_pay_id;
        v_pay_methods := v_pay_methods || public.normalize_checkout_payment_method(v_pago->>'payment_method');
        v_pay_summary := v_pay_summary || jsonb_build_array(jsonb_build_object(
          'id', v_pay_id, 'method', public.normalize_checkout_payment_method(v_pago->>'payment_method'),
          'amount_ars', round(v_pago_ars,2), 'currency', COALESCE(v_pago->>'currency','ARS')));
      END IF;
    END LOOP;

    -- ── 7. COGS devengado (BFE de costo) — trazable, fecha AR. Nunca para NC. ──
    IF v_costo_total_ars > 0 AND NOT v_skip_finance AND v_tipo <> 'nota_credito' THEN
      INSERT INTO business_finance_entries (
        business_id, date, type, category, description, amount, currency,
        amount_ars, exchange_rate, created_by, source, reference_comprobante_id
      ) VALUES (
        p_business_id, public.ar_today(), 'variable_cost', 'mercaderia',
        'Costo de productos - Comprobante #' || v_numero, v_costo_total_ars,
        'ARS', v_costo_total_ars, 1, auth.uid(), 'comprobante', v_comp_id
      ) RETURNING id INTO v_cogs_bfe_id;
    END IF;

    -- ── 8. Cuenta corriente ───────────────────────────────────────────────────
    IF v_cc_total > 0.01 AND v_customer_id IS NOT NULL THEN
      SELECT id INTO v_account_id FROM accounts
        WHERE business_id = p_business_id AND entity_id = v_customer_id;

      IF v_account_id IS NULL THEN
        INSERT INTO accounts (business_id, type, entity_id, entity_name, entity_phone, balance)
          VALUES (p_business_id, 'cliente', v_customer_id, COALESCE(v_customer_name, 'Cliente'), v_customer_phone, 0)
          RETURNING id INTO v_account_id;
      END IF;

      INSERT INTO account_movements (
        business_id, account_id, date, type, description, debit, credit,
        reference_type, reference_id, created_by
      ) VALUES (
        p_business_id, v_account_id, public.ar_today(), 'venta',
        'Comprobante #' || v_numero, v_cc_total, 0,
        'comprobante', v_comp_id, auth.uid()
      ) RETURNING id INTO v_am_id;
    END IF;

    -- ── M7 §6/§15: UN unico evento de negocio (la venta completa), server-side. ──
    v_n_products := (SELECT count(*) FROM jsonb_array_elements(v_resolved_items) it WHERE NULLIF(it->>'inventory_id','') IS NOT NULL);
    v_n_payments := (SELECT count(*) FROM jsonb_array_elements(COALESCE(p_payload->'pagos','[]'::jsonb)) p WHERE COALESCE((p->>'amount_ars')::numeric,0) > 0);
    -- FM creados por trig_comprobante_payment_finance para este comprobante
    SELECT array_agg(id) INTO v_fm_ids FROM financial_movements WHERE business_id=p_business_id AND comprobante_id=v_comp_id;
    v_in_audit := true;
    PERFORM finance_log_audit(
      p_business_id, 'sale_checkout', 'comprobantes', v_comp_id, 'create_comprobante_checkout_atomic',
      p_idempotency_key, v_observaciones, v_economic_date, 'comprobante', v_comp_id,
      NULL, jsonb_build_object(
        'comprobante_id', v_comp_id, 'tipo', v_tipo, 'numero', v_numero, 'customer_id', v_customer_id,
        'order_id', v_order_id, 'currency', 'ARS', 'exchange_rate', v_exchange_rate,
        'subtotal', round(v_subtotal_ars,2), 'descuento_total', round(v_descuento_total,2), 'tax', round(v_tax,2),
        'total', round(v_total_bruto,2), 'total_percibido', round(v_cash_total,2), 'total_financiado', round(v_cc_total,2),
        'costo_total', round(v_costo_total_ars,2), 'item_count', COALESCE(jsonb_array_length(v_resolved_items),0),
        'product_count', v_n_products, 'payment_count', v_n_payments, 'estado_comercial', v_estado_comercial,
        'account_id', v_account_id, 'es_fiscal', v_es_fiscal,
        -- 6E.2a: metodos normalizados + referencias financieras compactas + ambos hashes
        'payment_methods', to_jsonb(v_pay_methods), 'payments', v_pay_summary,
        'comprobante_payment_ids', to_jsonb(v_pay_ids), 'financial_movement_ids', to_jsonb(COALESCE(v_fm_ids, '{}'::uuid[])),
        'cogs_bfe_id', v_cogs_bfe_id, 'account_movement_id', v_am_id,
        'client_request_hash', p_request_hash, 'server_request_hash', v_server_hash,
        'hash_algorithm', 'checkout_intent_v1', 'hashes_match', v_hashes_match));
    v_in_audit := false;

    -- ── Completar la request — con el hash RESUELTO (auditoría) ──────────────
    UPDATE comprobante_checkout_requests
      SET status = 'completed', comprobante_id = v_comp_id, completed_at = now(), updated_at = now(),
          resolved_checkout_hash = encode(extensions.digest(v_resolved_items::text || v_total::text || v_subtotal_ars::text, 'sha256'), 'hex')
      WHERE id = v_request_id;

    RETURN jsonb_build_object('status', 'created', 'comprobante_id', v_comp_id);

  EXCEPTION WHEN OTHERS THEN
    -- M7 §16: error_code ADITIVO. status se mantiene 'failed_retryable' (contrato POS
    -- intacto: la maquina de estados no cambia). No se expone SQLERRM inesperado.
    v_ec := CASE
      WHEN v_in_audit THEN 'AUDIT_FAILED'
      WHEN SQLERRM LIKE 'PERIOD_CLOSED%' THEN 'PERIOD_CLOSED'
      WHEN SQLERRM LIKE 'INVALID_FINANCE_CONTEXT%' THEN 'INVALID_FINANCE_CONTEXT'
      WHEN SQLERRM LIKE 'QTY_NOT_INTEGER%' THEN 'VALIDATION_ERROR'
      WHEN SQLERRM LIKE 'CUSTOMER_NOT_FOUND%' THEN 'CUSTOMER_NOT_FOUND'
      WHEN SQLERRM LIKE 'ORDER_NOT_FOUND%' THEN 'ORDER_NOT_FOUND'
      WHEN SQLERRM LIKE '%no pertenece a este negocio o no existe%' THEN 'INVENTORY_NOT_FOUND'
      WHEN SQLERRM LIKE 'tipo de comprobante invalido%' OR SQLERRM LIKE 'cantidad invalida%'
        OR SQLERRM LIKE 'precio_unitario invalido%' OR SQLERRM LIKE 'pago con monto%'
        OR SQLERRM LIKE 'cc_total invalido%' OR SQLERRM LIKE '%exceden el total%'
        OR SQLERRM LIKE '%no cubre el total%' OR SQLERRM LIKE '%cuenta corriente requiere%'
        OR SQLERRM LIKE '%nota de credito no lleva%' OR SQLERRM LIKE '%sin permiso%' THEN 'VALIDATION_ERROR'
      ELSE 'INTERNAL_ERROR'
    END;
    v_ret_msg := CASE
      WHEN v_ec = 'QTY_NOT_INTEGER' OR SQLERRM LIKE 'QTY_NOT_INTEGER%' THEN 'La cantidad debe ser un número entero mayor o igual a 1'
      WHEN v_ec = 'CUSTOMER_NOT_FOUND' THEN 'El cliente no pertenece a este negocio'
      WHEN v_ec = 'ORDER_NOT_FOUND' THEN 'La orden no pertenece a este negocio'
      WHEN v_ec = 'AUDIT_FAILED' THEN 'No se pudo registrar la auditoria de la operacion'
      WHEN v_ec = 'INTERNAL_ERROR' THEN 'No se pudo completar la operacion'
      ELSE SQLERRM
    END;
    UPDATE comprobante_checkout_requests
      SET status = 'failed_retryable', last_error_code = v_ec, last_error_message = SQLERRM,
          completed_at = now(), updated_at = now()
      WHERE id = v_request_id;
    RETURN jsonb_build_object('status', 'failed_retryable', 'error', v_ret_msg, 'error_code', v_ec);
  END;
END;
$function$;

-- ============================================================================
-- ROLLBACK (documentado): recrear la version previa (sin guard/scope/audit/
-- integer-qty/lock-determinista/error_code); DROP trigger + funcion
-- comprobante_checkout_requests_immutable; ALTER DROP COLUMN op; restaurar policy
-- checkout_requests_select + GRANT SELECT a authenticated.
-- ============================================================================
