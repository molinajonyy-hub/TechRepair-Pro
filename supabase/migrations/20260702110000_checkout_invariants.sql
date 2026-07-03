-- ============================================================================
-- Etapa 0 — Invariantes del checkout (create_comprobante_checkout_atomic)
--
-- Base: versión vigente de 20260701180000 (pricing server-side + numeración
-- atómica + split de hash). Esta migración NO toca: idempotencia, hash de
-- payload, recuperación post-timeout, locks de stock, resolución de precios,
-- reserva de número, ni el flujo ARCA posterior. Diff funcional exacto:
--
--   A. INVARIANTE DE COBRO (tolerancia monetaria ±$1,00 ARS — la misma que ya
--      usaba el guard superior preexistente):
--        pagos de caja + cuenta corriente = total del comprobante
--      Estados permitidos: cobro total / parcial+CC / CC total / total $0.
--      ESTADO PROHIBIDO (eliminado): total>0 sin pagos ni CC. Antes esa rama
--      creaba BFE income + FM income por el TOTAL sin que entrara dinero
--      (P0-3 de la auditoría). El faltante NUNCA se convierte en CC
--      silenciosamente: el cliente debe enviarlo explícito; si no, error
--      funcional con total/pagos/cc/diferencia.
--   B. cc_total > 0 exige customer_id (antes la deuda se evaporaba en
--      silencio si faltaba el cliente).
--   C. nota_credito por POS: exenta del invariante (es un documento de
--      reversión, no una venta) pero NO admite pagos ni CC, NO genera BFE de
--      costo y NO descuenta stock (antes una NC manual podía descontar stock
--      y generar income positivo por el total — ambos sin sentido).
--   D. Pagos de $0: no se insertan (ni generan FM/BFE vía trigger). Pagos o
--      amount_ars negativos: rechazados.
--   E. Fechas financieras: ar_today() (Córdoba) en vez de CURRENT_DATE (UTC)
--      para comprobante_payments.date, BFE.date y account_movements.date.
--   F. El BFE de costo (COGS) queda trazable: source='comprobante' +
--      reference_comprobante_id (antes: source default 'manual' sin
--      referencia — indistinguible de un asiento manual e imposible de
--      espejar en una anulación).
--
-- La rama income-sin-pagos se ELIMINA (no se condiciona): con el invariante A
-- es inalcanzable para ventas y era dañina para NC.
-- ============================================================================

CREATE OR REPLACE FUNCTION "public"."create_comprobante_checkout_atomic"(
  "p_business_id"      uuid,
  "p_idempotency_key"  text,
  "p_request_hash"     text,
  "p_payload"          jsonb
) RETURNS jsonb
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  -- Tolerancia monetaria única de esta RPC (ARS). Cubre redondeos de línea
  -- (descuentos porcentuales, conversión USD) sin permitir faltantes reales.
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
BEGIN
  -- ── Ownership: resolver y validar acceso real al negocio ────────────────
  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id = p_business_id AND owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id = p_business_id AND user_id = auth.uid())
  ) INTO v_has_access;
  IF NOT v_has_access THEN
    RETURN jsonb_build_object('status', 'failed_final', 'error', 'No autorizado para este negocio');
  END IF;

  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RETURN jsonb_build_object('status', 'failed_final', 'error', 'idempotency_key requerida');
  END IF;
  IF p_request_hash IS NULL OR length(trim(p_request_hash)) = 0 THEN
    RETURN jsonb_build_object('status', 'failed_final', 'error', 'request_hash requerido');
  END IF;

  v_can_override   := user_can_override_price(p_business_id, auth.uid());
  v_can_below_cost := user_can_sell_below_cost(p_business_id, auth.uid());

  -- ── Idempotencia: intentar registrar la request — ESTE INSERT ES EL LOCK ──
  SET LOCAL lock_timeout = '8s';
  BEGIN
    INSERT INTO comprobante_checkout_requests (business_id, user_id, idempotency_key, client_request_hash, status)
    VALUES (p_business_id, auth.uid(), p_idempotency_key, p_request_hash, 'processing')
    RETURNING id INTO v_request_id;
  EXCEPTION
    WHEN lock_not_available THEN
      RETURN jsonb_build_object('status', 'already_processing');
    WHEN unique_violation THEN
      SELECT * INTO v_existing FROM comprobante_checkout_requests
        WHERE business_id = p_business_id AND idempotency_key = p_idempotency_key;

      IF v_existing.client_request_hash IS DISTINCT FROM p_request_hash THEN
        RETURN jsonb_build_object('status', 'idempotency_conflict');
      END IF;

      IF v_existing.status = 'completed' THEN
        RETURN jsonb_build_object('status', 'existing', 'comprobante_id', v_existing.comprobante_id);
      ELSIF v_existing.status = 'failed_final' THEN
        RETURN jsonb_build_object('status', 'failed_final', 'error', v_existing.last_error_message);
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
      v_is_wholesale := COALESCE(v_is_wholesale, false);
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

      -- numeric acepta NaN/Infinity como valores del tipo; NaN > todo, así que
      -- "<= 0" no lo detecta. Se valida por representación de texto.
      IF v_line_qty::text IN ('NaN', 'Infinity', '-Infinity') OR v_line_qty <= 0 THEN
        RAISE EXCEPTION 'cantidad invalida (<=0, NaN o infinita) en item: %', v_item->>'descripcion';
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

      -- Stock: NUNCA para nota_credito (una NC no es una salida de mercadería;
      -- antes descontaba stock igual que una venta — Etapa 0, punto C).
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

    -- ── 6. Pagos de caja: solo montos > 0 (un pago de $0 no existe — no debe
    --      generar filas ni disparar el trigger de finanzas) ───────────────────
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
          v_pago->>'payment_method', v_pago->>'payment_provider',
          COALESCE((v_pago->>'commission_rate')::numeric, 0),
          COALESCE((v_pago->>'commission_amount')::numeric, 0),
          COALESCE((v_pago->>'net_amount')::numeric, v_pago_ars),
          public.ar_today(), auth.uid()
        );
      END IF;
    END LOOP;

    -- ── 7. COGS devengado (BFE de costo) — ahora TRAZABLE y con fecha AR.
    --      Nunca para NC. La rama income-sin-pagos fue ELIMINADA (P0-3):
    --      el ingreso de una venta lo registran exclusivamente los pagos
    --      (trigger trig_comprobante_payment_finance) o, en CC, el cobro
    --      posterior de la deuda. ─────────────────────────────────────────────
    IF v_costo_total_ars > 0 AND NOT v_skip_finance AND v_tipo <> 'nota_credito' THEN
      INSERT INTO business_finance_entries (
        business_id, date, type, category, description, amount, currency,
        amount_ars, exchange_rate, created_by, source, reference_comprobante_id
      ) VALUES (
        p_business_id, public.ar_today(), 'variable_cost', 'mercaderia',
        'Costo de productos - Comprobante #' || v_numero, v_costo_total_ars,
        'ARS', v_costo_total_ars, 1, auth.uid(), 'comprobante', v_comp_id
      );
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
      );
    END IF;

    -- ── Completar la request — con el hash RESUELTO (auditoría) ──────────────
    UPDATE comprobante_checkout_requests
      SET status = 'completed', comprobante_id = v_comp_id, completed_at = now(), updated_at = now(),
          resolved_checkout_hash = encode(extensions.digest(v_resolved_items::text || v_total::text || v_subtotal_ars::text, 'sha256'), 'hex')
      WHERE id = v_request_id;

    RETURN jsonb_build_object('status', 'created', 'comprobante_id', v_comp_id);

  EXCEPTION WHEN OTHERS THEN
    UPDATE comprobante_checkout_requests
      SET status = 'failed_retryable', last_error_code = SQLSTATE, last_error_message = SQLERRM,
          completed_at = now(), updated_at = now()
      WHERE id = v_request_id;
    RETURN jsonb_build_object('status', 'failed_retryable', 'error', SQLERRM);
  END;
END;
$$;

ALTER FUNCTION "public"."create_comprobante_checkout_atomic"(uuid, text, text, jsonb) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."create_comprobante_checkout_atomic"(uuid, text, text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."create_comprobante_checkout_atomic"(uuid, text, text, jsonb) FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."create_comprobante_checkout_atomic"(uuid, text, text, jsonb) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."create_comprobante_checkout_atomic"(uuid, text, text, jsonb) TO "service_role";

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado):
--   CREATE OR REPLACE FUNCTION create_comprobante_checkout_atomic(...)
--     -- volver a la versión de 20260701180000 (idéntica salvo los puntos A-F
--     -- del encabezado; ninguna columna nueva fue agregada por esta migración)
-- ============================================================================
