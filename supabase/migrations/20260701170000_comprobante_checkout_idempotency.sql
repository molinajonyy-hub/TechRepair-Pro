-- ============================================================================
-- Idempotencia server-side para comprobanteService.crear() (checkout POS)
--
-- CONTEXTO (auditoría ARCA/checkout, fase de idempotencia local, 2026-07-01):
--   El lock atómico de emisión ARCA (arca_emission_attempts, migración
--   20260701150000) protege el paso FISCAL: dos invocaciones no pueden
--   emitir CAE dos veces para el mismo comprobante ni para la misma serie.
--   Pero ESO no protege el paso ANTERIOR: la creación local del comprobante.
--   comprobanteService.crear() hoy hace ~8 escrituras SEPARADAS (insert
--   comprobante, insert items, descontar stock, insert pagos, [ARCA],
--   finanzas x2, cuenta corriente) sin ninguna transacción ni clave de
--   idempotencia server-side. Dos solicitudes concurrentes (doble click,
--   doble pestaña, retry tras timeout) pueden crear DOS comprobantes locales
--   completos, cada uno con su propio descuento de stock, sus propios pagos,
--   sus propios movimientos financieros — y el lock fiscal NO lo detecta,
--   porque serían dos comprobante_id DISTINTOS, cada uno legítimamente
--   elegible para su propia emisión ARCA.
--
--   Esta migración cierra ESE hueco: una tabla de idempotencia
--   (comprobante_checkout_requests) con UNIQUE(business_id, idempotency_key)
--   como lock atómico (mismo patrón que arca_emission_attempts: el índice
--   único ES el mecanismo de exclusión mutua, no un guard en memoria), más
--   una RPC (create_comprobante_checkout_atomic) que hace TODA la creación
--   local — comprobante, ítems, stock, pagos, finanzas, cuenta corriente —
--   en UNA sola transacción PostgreSQL. ARCA se sigue llamando DESPUÉS,
--   desde el cliente, exactamente igual que hoy (_claimYEmitirArca no se
--   toca): esta migración no mezcla el estado comercial (checkout) con el
--   estado fiscal (estado_fiscal) — son dos máquinas de estado distintas.
--
-- ALCANCE EXPLÍCITO — QUÉ NO HACE ESTA MIGRACIÓN:
--   No re-deriva el motor de precios/descuentos/comisiones en SQL. Esos
--   cálculos (calcularLinea, comisiones por medio de pago) siguen viviendo
--   en el cliente, exactamente como hoy — reimplementarlos en PL/pgSQL sería
--   un cambio de alcance mucho mayor (y más riesgoso) que "hacer idempotente
--   la creación". La RPC SÍ valida invariantes de consistencia gruesa
--   (subtotal+tax=total, pagos no exceden el total) como defensa adicional,
--   pero no es una re-derivación completa de la lógica de pricing. Esto se
--   documenta como riesgo residual explícito en el informe final.
--
-- REUTILIZACIÓN — no se reinventa nada que ya funcione:
--   - generar_numero_comprobante(): se sigue llamando tal cual (no se
--     duplica su lógica).
--   - total_cobrado/saldo_pendiente: se insertan en 0/total_bruto y el
--     trigger trig_comprobante_payment_sync (ya existente) los recalcula al
--     insertar comprobante_payments — igual que hoy.
--   - balance_after de cuenta corriente: se sigue calculando por el trigger
--     de account_movements (SELECT FOR UPDATE) — esta RPC solo inserta la
--     fila, no calcula el saldo.
--   - _claimYEmitirArca / claim_comprobante_arca_emission / afip-cae: SIN
--     CAMBIOS. ARCA se llama desde el cliente DESPUÉS de que esta RPC
--     retorna, nunca dentro de la transacción.
--
-- Nunca se almacenan certificados, tokens ni datos fiscales sensibles acá.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "public"."comprobante_checkout_requests" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id"         uuid NOT NULL REFERENCES "public"."businesses"("id"),
  -- user_id SIEMPRE viene de auth.uid() dentro de la RPC — nunca del cliente.
  "user_id"             uuid NOT NULL,
  "idempotency_key"     text NOT NULL,
  -- Hash determinista del contenido comercial relevante, calculado en el
  -- cliente (ver src/lib/checkoutIdempotency.ts) y comparado acá — la RPC
  -- NO recalcula el hash, solo lo compara para detectar reuse de la misma
  -- key con un payload distinto.
  "request_hash"        text NOT NULL,
  "status"              text NOT NULL DEFAULT 'processing' CHECK ("status" IN (
    'processing', 'completed', 'failed_retryable', 'failed_final'
  )),
  "comprobante_id"      uuid REFERENCES "public"."comprobantes"("id") ON DELETE SET NULL,
  "last_error_code"     text,
  "last_error_message"  text,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "completed_at"        timestamptz,
  "updated_at"          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE "public"."comprobante_checkout_requests" IS
  'Idempotencia server-side de comprobanteService.crear(): UNIQUE(business_id, '
  'idempotency_key) es el lock atómico real. status es la máquina de estado del '
  'CHECKOUT (comercial), separada de comprobantes.estado_fiscal (fiscal/ARCA).';

-- ── El índice único ES el lock — mismo patrón que arca_emission_attempts ───
CREATE UNIQUE INDEX IF NOT EXISTS "idx_checkout_requests_business_key"
  ON "public"."comprobante_checkout_requests" ("business_id", "idempotency_key");

CREATE INDEX IF NOT EXISTS "idx_checkout_requests_business_created"
  ON "public"."comprobante_checkout_requests" ("business_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_checkout_requests_comprobante"
  ON "public"."comprobante_checkout_requests" ("comprobante_id");

ALTER TABLE "public"."comprobante_checkout_requests" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "checkout_requests_select" ON "public"."comprobante_checkout_requests";
CREATE POLICY "checkout_requests_select" ON "public"."comprobante_checkout_requests"
  FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM "public"."businesses" WHERE "id" = "comprobante_checkout_requests"."business_id" AND "owner_user_id" = auth.uid())
    OR EXISTS (SELECT 1 FROM "public"."profiles" WHERE "business_id" = "comprobante_checkout_requests"."business_id" AND "user_id" = auth.uid())
  );

-- Ninguna policy de INSERT/UPDATE/DELETE para authenticated/anon — la única
-- vía de escritura es la función SECURITY DEFINER de abajo.
REVOKE ALL ON "public"."comprobante_checkout_requests" FROM PUBLIC;
REVOKE ALL ON "public"."comprobante_checkout_requests" FROM "anon";
GRANT SELECT ON "public"."comprobante_checkout_requests" TO "authenticated";
GRANT ALL ON "public"."comprobante_checkout_requests" TO "service_role";

-- ============================================================================
-- create_comprobante_checkout_atomic — única puerta de entrada para crear un
-- comprobante + sus efectos comerciales (ítems, stock, pagos, finanzas, CC).
-- Llamable desde el cliente (authenticated). Ownership vía auth.uid() (nunca
-- confía en business_id/user_id por parámetro sin validar). TODO el trabajo
-- ocurre en UNA transacción — si algo falla, PostgreSQL revierte todo excepto
-- el registro de la request (marcado failed_retryable vía SAVEPOINT
-- implícito del bloque EXCEPTION), permitiendo un retry seguro con la misma
-- key. ARCA NUNCA se llama acá.
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
  v_subtotal_ars      numeric;
  v_tax               numeric;
  v_total             numeric;
  v_total_usd         numeric;
  v_descuento_total   numeric;
  v_costo_total_ars   numeric;
  v_total_comisiones  numeric;
  v_total_neto        numeric;
  v_total_bruto       numeric;
  v_cc_total          numeric;
  v_cash_total        numeric := 0;
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
BEGIN
  -- ── Ownership: resolver y validar acceso real al negocio (nunca confiar
  --    en p_business_id "porque el cliente lo mandó") ────────────────────────
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

  -- ── Idempotencia: intentar registrar la request — ESTE INSERT ES EL LOCK.
  --    lock_timeout acotado: si otra transacción con la MISMA key está
  --    procesando, esperamos hasta 8s (Postgres real, no un sleep
  --    coordinado) antes de devolver already_processing en vez de colgar la
  --    conexión HTTP indefinidamente. ────────────────────────────────────────
  SET LOCAL lock_timeout = '8s';
  BEGIN
    INSERT INTO comprobante_checkout_requests (business_id, user_id, idempotency_key, request_hash, status)
    VALUES (p_business_id, auth.uid(), p_idempotency_key, p_request_hash, 'processing')
    RETURNING id INTO v_request_id;
  EXCEPTION
    WHEN lock_not_available THEN
      RETURN jsonb_build_object('status', 'already_processing');
    WHEN unique_violation THEN
      SELECT * INTO v_existing FROM comprobante_checkout_requests
        WHERE business_id = p_business_id AND idempotency_key = p_idempotency_key;

      IF v_existing.request_hash IS DISTINCT FROM p_request_hash THEN
        -- Misma key, payload distinto: NUNCA seguir silenciosamente.
        RETURN jsonb_build_object('status', 'idempotency_conflict');
      END IF;

      IF v_existing.status = 'completed' THEN
        RETURN jsonb_build_object('status', 'existing', 'comprobante_id', v_existing.comprobante_id);
      ELSIF v_existing.status = 'failed_final' THEN
        RETURN jsonb_build_object('status', 'failed_final', 'error', v_existing.last_error_message);
      ELSIF v_existing.status = 'processing' THEN
        RETURN jsonb_build_object('status', 'already_processing');
      ELSE -- 'failed_retryable': recuperar la MISMA fila y reintentar la creación.
        UPDATE comprobante_checkout_requests
          SET status = 'processing', updated_at = now()
          WHERE id = v_existing.id AND status = 'failed_retryable';
        IF NOT FOUND THEN
          -- Otro proceso ganó la recuperación en el medio.
          RETURN jsonb_build_object('status', 'already_processing');
        END IF;
        v_request_id := v_existing.id;
      END IF;
  END;

  -- ── A partir de acá somos dueños exclusivos de v_request_id ('processing').
  --    Todo lo que sigue es UN bloque con su propio manejo de excepción: si
  --    algo falla, este bloque se revierte (savepoint implícito) pero la fila
  --    de comprobante_checkout_requests (ya comiteable) queda marcada
  --    failed_retryable — nunca queda "completed" con datos parciales, y
  --    nunca queda un comprobante huérfano sin su request. ───────────────────
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

    v_subtotal_ars     := COALESCE((p_payload->>'subtotal_ars')::numeric, 0);
    v_tax              := COALESCE((p_payload->>'tax')::numeric, 0);
    v_total            := COALESCE((p_payload->>'total')::numeric, 0);
    v_total_usd        := COALESCE((p_payload->>'total_usd')::numeric, 0);
    v_descuento_total  := COALESCE((p_payload->>'descuento_total')::numeric, 0);
    v_costo_total_ars  := COALESCE((p_payload->>'costo_total_ars')::numeric, 0);
    v_total_comisiones := COALESCE((p_payload->>'total_comisiones')::numeric, 0);
    v_total_neto       := COALESCE((p_payload->>'total_neto')::numeric, 0);
    v_total_bruto      := COALESCE((p_payload->>'total_bruto')::numeric, 0);
    v_cc_total         := COALESCE((p_payload->>'cc_total')::numeric, 0);

    -- ── Guardas de consistencia server-side (defensa en profundidad — NO es
    --    una re-derivación completa del motor de pricing, ver nota de
    --    alcance al inicio del archivo) ──────────────────────────────────────
    IF v_tipo NOT IN ('remito', 'factura_a', 'factura_c', 'nota_credito') THEN
      RAISE EXCEPTION 'tipo de comprobante invalido: %', v_tipo;
    END IF;
    IF v_total_bruto < 0 THEN
      RAISE EXCEPTION 'total_bruto no puede ser negativo';
    END IF;
    IF abs((v_subtotal_ars + v_tax) - v_total) > 1 THEN
      RAISE EXCEPTION 'totales inconsistentes: subtotal + tax != total';
    END IF;

    SELECT COALESCE(SUM((p->>'amount_ars')::numeric), 0) INTO v_cash_total
      FROM jsonb_array_elements(COALESCE(p_payload->'pagos', '[]'::jsonb)) p;

    IF (v_cash_total + v_cc_total) > (v_total_bruto + 1) THEN
      RAISE EXCEPTION 'los pagos (caja + cuenta corriente) exceden el total del comprobante';
    END IF;

    v_estado_comercial := CASE
      WHEN v_cash_total >= v_total_bruto - 1 THEN 'pagado'
      WHEN v_cash_total > 0 OR v_cc_total > 0 THEN 'parcial'
      ELSE 'pendiente'
    END;

    -- ── Número local — se reutiliza la RPC existente, no se reinventa ───────
    v_numero := public.generar_numero_comprobante(v_tipo, p_business_id, v_punto_venta);

    -- ── 1. Comprobante ───────────────────────────────────────────────────────
    -- total_cobrado/saldo_pendiente arrancan "honestos" (0 / total_bruto) —
    -- el trigger trig_comprobante_payment_sync (ya existente) los recalcula
    -- al insertar comprobante_payments más abajo. Nunca se confía en un
    -- saldo/balance que hubiera mandado el cliente.
    INSERT INTO comprobantes (
      business_id, created_by, customer_id, order_id, tipo, type, punto_venta,
      numero, number, fecha, date, condicion_fiscal, observaciones, currency,
      exchange_rate, subtotal, impuestos, tax, total, total_ars, total_usd,
      descuento_total, recargo_total, total_bruto, total_cobrado, saldo_pendiente,
      total_comisiones, total_neto, estado, status, estado_comercial, estado_fiscal,
      es_fiscal, emitir_en_arca, cae, cae_vencimiento, numero_fiscal
    ) VALUES (
      p_business_id, auth.uid(), v_customer_id, v_order_id, v_tipo, v_tipo, v_punto_venta,
      v_numero, v_numero, now(), now(), v_condicion_fiscal, v_observaciones, 'ARS',
      v_exchange_rate, v_subtotal_ars, v_tax, v_tax, v_total, v_total, v_total_usd,
      v_descuento_total, 0, v_total_bruto, 0, v_total_bruto,
      v_total_comisiones, v_total_neto,
      CASE WHEN v_es_fiscal THEN 'borrador' ELSE 'emitido' END,
      CASE WHEN v_es_fiscal THEN 'draft' ELSE 'issued' END,
      v_estado_comercial,
      CASE WHEN v_es_fiscal THEN 'pendiente_emision' ELSE 'no_fiscal' END,
      v_es_fiscal, v_emitir_en_arca, NULL, NULL, NULL
    ) RETURNING id INTO v_comp_id;

    -- ── 2. Ítems + 3. Stock (uno por uno, mismo orden que el JS original) ────
    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'items', '[]'::jsonb))
    LOOP
      INSERT INTO comprobante_items (
        comprobante_id, business_id, created_by, descripcion, tipo_linea, cantidad,
        precio_unitario, descuento_linea, subtotal, costo_unitario, costo_total,
        currency, exchange_rate, inventory_id, applied_price_type, orden
      ) VALUES (
        v_comp_id, p_business_id, auth.uid(),
        v_item->>'descripcion',
        COALESCE(v_item->>'tipo_linea', 'producto'),
        (v_item->>'cantidad')::numeric,
        (v_item->>'precio_unitario')::numeric,
        COALESCE((v_item->>'descuento_linea')::numeric, 0),
        (v_item->>'subtotal')::numeric,
        COALESCE((v_item->>'costo_unitario')::numeric, 0),
        COALESCE((v_item->>'costo_total')::numeric, 0),
        COALESCE(v_item->>'currency', 'ARS'),
        COALESCE((v_item->>'exchange_rate')::numeric, v_exchange_rate),
        NULLIF(v_item->>'inventory_id', '')::uuid,
        v_item->>'applied_price_type',
        COALESCE((v_item->>'orden')::integer, 0)
      ) RETURNING id INTO v_item_id;

      IF NULLIF(v_item->>'inventory_id', '') IS NOT NULL
         AND COALESCE(v_item->>'tipo_linea', 'producto') IN ('producto', 'repuesto') THEN

        -- SELECT ... FOR UPDATE: lock de fila real (mejora sobre el JS
        -- original, que hacía SELECT+UPDATE sin lock — ver informe final).
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

    -- ── 4. Pagos de caja (NO cuenta corriente) ───────────────────────────────
    FOR v_pago IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'pagos', '[]'::jsonb))
    LOOP
      INSERT INTO comprobante_payments (
        comprobante_id, business_id, amount, currency, amount_ars, exchange_rate,
        payment_method, payment_provider, commission_rate, commission_amount,
        net_amount, date, created_by
      ) VALUES (
        v_comp_id, p_business_id,
        (v_pago->>'amount')::numeric, COALESCE(v_pago->>'currency', 'ARS'),
        (v_pago->>'amount_ars')::numeric,
        COALESCE((v_pago->>'exchange_rate')::numeric, v_exchange_rate),
        v_pago->>'payment_method', v_pago->>'payment_provider',
        COALESCE((v_pago->>'commission_rate')::numeric, 0),
        COALESCE((v_pago->>'commission_amount')::numeric, 0),
        COALESCE((v_pago->>'net_amount')::numeric, (v_pago->>'amount_ars')::numeric),
        CURRENT_DATE, auth.uid()
      );
    END LOOP;

    -- ── 5. Movimientos financieros (costo/ingreso) — independientes de ARCA,
    --    igual que hoy (auditoría fase 4, 2026-07-01) ─────────────────────────
    IF v_costo_total_ars > 0 AND NOT v_skip_finance THEN
      INSERT INTO business_finance_entries (
        business_id, date, type, category, description, amount, currency,
        amount_ars, exchange_rate, created_by
      ) VALUES (
        p_business_id, CURRENT_DATE, 'variable_cost', 'mercaderia',
        'Costo de productos - Comprobante #' || v_numero, v_costo_total_ars,
        'ARS', v_costo_total_ars, 1, auth.uid()
      );
    END IF;

    IF NOT v_skip_finance AND v_cash_total = 0 AND v_cc_total = 0 THEN
      INSERT INTO business_finance_entries (
        business_id, date, type, category, description, amount, currency,
        amount_ars, exchange_rate, created_by
      ) VALUES (
        p_business_id, CURRENT_DATE, 'income', 'ventas_productos',
        'Comprobante #' || v_numero, v_total, 'ARS', v_total, v_exchange_rate, auth.uid()
      );

      INSERT INTO financial_movements (
        business_id, date, type, currency, amount, amount_ars, exchange_rate,
        source, description, created_by, caja_id
      ) VALUES (
        p_business_id, CURRENT_DATE, 'income', 'ARS', v_total, v_total,
        v_exchange_rate, 'comprobante', 'Comprobante #' || v_numero, auth.uid(), v_caja_id
      );
    END IF;

    -- ── 6. Cuenta corriente: registrar deuda si hay saldo sin efectivo ───────
    IF v_cc_total > 0.01 AND v_customer_id IS NOT NULL THEN
      SELECT name, phone INTO v_customer_name, v_customer_phone
        FROM customers WHERE id = v_customer_id AND business_id = p_business_id;

      SELECT id INTO v_account_id FROM accounts
        WHERE business_id = p_business_id AND entity_id = v_customer_id;

      IF v_account_id IS NULL THEN
        INSERT INTO accounts (business_id, type, entity_id, entity_name, entity_phone, balance)
          VALUES (p_business_id, 'cliente', v_customer_id, COALESCE(v_customer_name, 'Cliente'), v_customer_phone, 0)
          RETURNING id INTO v_account_id;
      END IF;

      -- balance_after lo calcula el trigger existente (SELECT FOR UPDATE) —
      -- acá solo insertamos el movimiento, igual que cuentasService.registerSale.
      INSERT INTO account_movements (
        business_id, account_id, date, type, description, debit, credit,
        reference_type, reference_id, created_by
      ) VALUES (
        p_business_id, v_account_id, CURRENT_DATE, 'venta',
        'Comprobante #' || v_numero, v_cc_total, 0,
        'comprobante', v_comp_id, auth.uid()
      );
    END IF;

    -- ── Completar la request — exactamente una vez ───────────────────────────
    UPDATE comprobante_checkout_requests
      SET status = 'completed', comprobante_id = v_comp_id, completed_at = now(), updated_at = now()
      WHERE id = v_request_id;

    RETURN jsonb_build_object('status', 'created', 'comprobante_id', v_comp_id);

  EXCEPTION WHEN OTHERS THEN
    -- El bloque anterior se revierte (savepoint implícito) — nada de lo de
    -- arriba persiste. Pero ESTA escritura sí, porque ocurre DESPUÉS de que
    -- el error ya se atrapó: el request queda failed_retryable, nunca
    -- "completed" con datos a medio insertar, y nunca sin registro.
    UPDATE comprobante_checkout_requests
      SET status = 'failed_retryable', last_error_code = SQLSTATE, last_error_message = SQLERRM,
          completed_at = now(), updated_at = now()
      WHERE id = v_request_id;
    RETURN jsonb_build_object('status', 'failed_retryable', 'error', SQLERRM);
  END;
END;
$$;

ALTER FUNCTION "public"."create_comprobante_checkout_atomic"(uuid, text, text, jsonb) OWNER TO "postgres";
-- REVOKE ALL FROM PUBLIC no alcanza (Supabase otorga EXECUTE explícito a
-- anon/authenticated/service_role vía ALTER DEFAULT PRIVILEGES en cada
-- CREATE FUNCTION del rol postgres) — lección de la migración ARCA anterior.
REVOKE ALL ON FUNCTION "public"."create_comprobante_checkout_atomic"(uuid, text, text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."create_comprobante_checkout_atomic"(uuid, text, text, jsonb) FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."create_comprobante_checkout_atomic"(uuid, text, text, jsonb) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."create_comprobante_checkout_atomic"(uuid, text, text, jsonb) TO "service_role";

-- ============================================================================
-- get_checkout_request_status — consulta de recuperación (fase 9). Read-only,
-- para resolver timeout/refresh/cierre accidental del modal sin crear una
-- venta nueva. Nunca expone secretos ni CMS/tokens fiscales.
-- ============================================================================
CREATE OR REPLACE FUNCTION "public"."get_checkout_request_status"(
  "p_business_id"      uuid,
  "p_idempotency_key"  text
) RETURNS jsonb
    LANGUAGE "plpgsql" SECURITY DEFINER STABLE
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_has_access boolean := false;
  v_req        comprobante_checkout_requests%ROWTYPE;
  v_comp       comprobantes%ROWTYPE;
BEGIN
  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id = p_business_id AND owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id = p_business_id AND user_id = auth.uid())
  ) INTO v_has_access;
  IF NOT v_has_access THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT * INTO v_req FROM comprobante_checkout_requests
    WHERE business_id = p_business_id AND idempotency_key = p_idempotency_key;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  IF v_req.comprobante_id IS NOT NULL THEN
    SELECT * INTO v_comp FROM comprobantes WHERE id = v_req.comprobante_id;
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'checkout_status', v_req.status,
    'comprobante_id', v_req.comprobante_id,
    'estado_fiscal', v_comp.estado_fiscal,
    'cae', v_comp.cae,
    'error', v_req.last_error_message
  );
END;
$$;

ALTER FUNCTION "public"."get_checkout_request_status"(uuid, text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."get_checkout_request_status"(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."get_checkout_request_status"(uuid, text) FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."get_checkout_request_status"(uuid, text) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."get_checkout_request_status"(uuid, text) TO "service_role";

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado por esta migración):
--   DROP FUNCTION IF EXISTS "public"."get_checkout_request_status"(uuid, text);
--   DROP FUNCTION IF EXISTS "public"."create_comprobante_checkout_atomic"(uuid, text, text, jsonb);
--   DROP TABLE IF EXISTS "public"."comprobante_checkout_requests";
--   (no afecta `comprobantes`/`comprobante_items`/`comprobante_payments`/
--    `business_finance_entries`/`financial_movements`/`accounts`/
--    `account_movements`/`inventory`/`inventory_movements`: esta RPC solo
--    escribe columnas que ya existían antes de esta migración)
-- ============================================================================
