-- ============================================================================
-- P0 - CONTRATO CANONICO DEL PUNTO DE VENTA FISCAL
--
-- Causa: create_comprobante_checkout_atomic tomaba p_payload->>'punto_venta'
-- tal cual y lo persistia en comprobantes.punto_venta y en el prefijo de
-- comprobantes.numero. Ese valor sale de sales_points.numero (lo que muestra el
-- POS), mientras que el CAE se solicita SIEMPRE con arca_config.punto_venta
-- (claim_comprobante_arca_emission lo lee server-side y falla cerrado si falta).
-- Con sales_points.numero=7 y arca_config.punto_venta=3 el comprobante quedaba
-- persistido e impreso como PV 0007 mientras AFIP lo autorizaba bajo el PV 3.
--
-- Contrato que fija esta migracion:
--   * factura FISCAL (factura_a / factura_c)
--       -> PV = arca_config.punto_venta, resuelto server-side. El payload del
--          cliente se descarta por completo.
--       -> arca_config solo es valida con punto_venta > 0.
--       -> si se pidio emitir en ARCA y no hay configuracion valida: fail-closed
--          (ARCA_NOT_CONFIGURED), nunca un PV inventado.
--       -> si NO se pide ARCA y no hay configuracion: '0001', que es el DEFAULT
--          declarado por arca_config.punto_venta, no el PV local del cliente.
--   * comprobante NO FISCAL (remito)
--       -> PV del payload (sales_points.numero). Sin cambios.
--   * nota_credito
--       -> no entra por este checkout generico: requiere comprobante original,
--          FiscalIdentity completa y CbtesAsoc; se crea exclusivamente por
--          create_credit_note_from_comprobante.
--
-- La fiscalidad se deriva del TIPO server-side: el flag es_fiscal del payload
-- ya no decide que fuente gana.
--
-- Forward-only. Cuerpo canonico COMPLETO via CREATE OR REPLACE: no se parchea
-- la definicion viva (ver guard-no-fragile-functiondef-patch).
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '120s';

-- Defensa server-side para emisiones diferidas y filas legacy. NOT VALID evita
-- que una fila historica invalida bloquee el deploy, pero PostgreSQL igual lo
-- exige para todo INSERT/UPDATE nuevo: claim_comprobante_arca_emission no puede
-- dejar un attempt con PV 0/negativo aunque arca_config haya derivado.
ALTER TABLE public.arca_emission_attempts
  ADD CONSTRAINT arca_emission_attempts_positive_punto_venta
  CHECK (punto_venta > 0) NOT VALID;

-- CbtesAsoc debe quedar ligado al attempt ANTES de cualquier llamada externa.
-- Las cuatro columnas forman un unico snapshot: una fila historica/factura no
-- tiene ninguna; una NC-C nueva tiene original_id + terna completa. NOT VALID
-- evita auditar filas historicas durante este deploy, pero protege de inmediato
-- todo INSERT/UPDATE nuevo.
ALTER TABLE public.arca_emission_attempts
  ADD COLUMN cbte_asoc_original_id uuid,
  ADD COLUMN cbte_asoc_tipo integer,
  ADD COLUMN cbte_asoc_punto_venta integer,
  ADD COLUMN cbte_asoc_numero integer;

ALTER TABLE public.arca_emission_attempts
  ADD CONSTRAINT arca_emission_attempts_cbtes_asoc_all_or_none
    CHECK (
      num_nonnulls(
        cbte_asoc_original_id,
        cbte_asoc_tipo,
        cbte_asoc_punto_venta,
        cbte_asoc_numero
      ) IN (0, 4)
    ) NOT VALID,
  ADD CONSTRAINT arca_emission_attempts_cbtes_asoc_positive
    CHECK (
      (cbte_asoc_tipo IS NULL OR cbte_asoc_tipo > 0)
      AND (cbte_asoc_punto_venta IS NULL OR cbte_asoc_punto_venta > 0)
      AND (cbte_asoc_numero IS NULL OR cbte_asoc_numero > 0)
    ) NOT VALID,
  ADD CONSTRAINT arca_emission_attempts_cbtes_asoc_original_fk
    FOREIGN KEY (cbte_asoc_original_id)
    REFERENCES public.comprobantes(id)
    NOT VALID;

COMMENT ON COLUMN public.arca_emission_attempts.cbte_asoc_original_id IS
  'Snapshot server-side del comprobante original asociado a una NC-C.';
COMMENT ON COLUMN public.arca_emission_attempts.cbte_asoc_tipo IS
  'Snapshot server-side de CbtesAsoc.CbteTipo; all-or-none con original/PV/numero.';
COMMENT ON COLUMN public.arca_emission_attempts.cbte_asoc_punto_venta IS
  'Snapshot server-side de CbtesAsoc.PtoVta; entero positivo.';
COMMENT ON COLUMN public.arca_emission_attempts.cbte_asoc_numero IS
  'Snapshot server-side de CbtesAsoc.CbteNro; entero positivo.';


-- ============================================================================
-- SNAPSHOT FAIL-CLOSED DE CbtesAsoc PARA NC-C
--
-- La Edge resuelve la identidad canonica del original y llama esta RPC antes
-- de WSAA/numeracion. La RPC no confia en esos argumentos: vuelve a validar el
-- attempt, la NC, el negocio y la FiscalIdentity del original bajo lock. Solo
-- admite NC-C (13 -> Factura C 11). Un replay debe ser bit-a-bit identico.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.snapshot_arca_nc_cbtes_asoc(
  p_attempt_id uuid,
  p_nc_id uuid,
  p_original_id uuid,
  p_cbte_tipo integer,
  p_punto_venta integer,
  p_numero integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_attempt public.arca_emission_attempts%ROWTYPE;
  v_nc public.comprobantes%ROWTYPE;
  v_original public.comprobantes%ROWTYPE;
  v_original_tipo integer;
  v_original_pv integer;
  v_original_numero integer;
  v_updated integer;
BEGIN
  IF p_attempt_id IS NULL
     OR p_nc_id IS NULL
     OR p_original_id IS NULL
     OR p_cbte_tipo IS NULL OR p_cbte_tipo <= 0
     OR p_punto_venta IS NULL OR p_punto_venta <= 0
     OR p_numero IS NULL OR p_numero <= 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'CBTES_ASOC_INVALID',
      'error', 'CbtesAsoc requiere original y una terna de enteros positivos');
  END IF;

  SELECT * INTO v_attempt
    FROM public.arca_emission_attempts
   WHERE id = p_attempt_id
   FOR UPDATE;

  IF NOT FOUND
     OR v_attempt.comprobante_id IS DISTINCT FROM p_nc_id
     OR v_attempt.status NOT IN ('claimed', 'number_reserved', 'sent') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'ATTEMPT_NOT_ACTIVE',
      'error', 'El attempt de la Nota de Credito no existe, no corresponde o no esta activo');
  END IF;

  IF v_attempt.tipo_comprobante IS DISTINCT FROM 13
     OR v_attempt.punto_venta IS NULL
     OR v_attempt.punto_venta <= 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'ATTEMPT_NOT_NC_C',
      'error', 'El attempt no representa una Nota de Credito C valida');
  END IF;

  SELECT * INTO v_nc
    FROM public.comprobantes
   WHERE id = p_nc_id
     AND business_id = v_attempt.business_id
   FOR UPDATE;

  IF NOT FOUND
     OR v_nc.tipo IS DISTINCT FROM 'nota_credito'
     OR v_nc.tipo_comprobante_fiscal IS NULL
     OR btrim(v_nc.tipo_comprobante_fiscal) !~ '^[0-9]+$'
     OR btrim(v_nc.tipo_comprobante_fiscal)::integer IS DISTINCT FROM 13
     OR v_nc.comprobante_original_id IS DISTINCT FROM p_original_id
     OR v_nc.punto_venta IS NULL
     OR btrim(v_nc.punto_venta) !~ '^[0-9]+$'
     OR btrim(v_nc.punto_venta)::integer IS DISTINCT FROM v_attempt.punto_venta THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'NC_IDENTITY_MISMATCH',
      'error', 'La fila local no es una NC-C del mismo negocio/serie/original');
  END IF;

  SELECT * INTO v_original
    FROM public.comprobantes
   WHERE id = p_original_id
     AND business_id = v_attempt.business_id
   FOR UPDATE;

  IF NOT FOUND
     OR v_original.tipo IS DISTINCT FROM 'factura_c'
     OR v_original.estado_fiscal IS DISTINCT FROM 'emitido'
     OR v_original.cae IS NULL
     OR v_original.tipo_comprobante_fiscal IS NULL
     OR btrim(v_original.tipo_comprobante_fiscal) !~ '^[0-9]+$'
     OR v_original.numero_fiscal IS NULL
     OR btrim(v_original.numero_fiscal) !~ '^[0-9]{1,5}-[0-9]{1,12}$' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'ORIGINAL_IDENTITY_INCOMPLETE',
      'error', 'El original no es una Factura C autorizada con FiscalIdentity completa');
  END IF;

  v_original_tipo := btrim(v_original.tipo_comprobante_fiscal)::integer;
  v_original_pv := split_part(btrim(v_original.numero_fiscal), '-', 1)::integer;
  v_original_numero := split_part(btrim(v_original.numero_fiscal), '-', 2)::integer;

  IF v_original_tipo IS DISTINCT FROM 11
     OR v_original_pv <= 0
     OR v_original_numero <= 0
     OR p_cbte_tipo IS DISTINCT FROM v_original_tipo
     OR p_punto_venta IS DISTINCT FROM v_original_pv
     OR p_numero IS DISTINCT FROM v_original_numero THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'CBTES_ASOC_IDENTITY_MISMATCH',
      'error', 'CbtesAsoc no coincide exactamente con la FiscalIdentity del original');
  END IF;

  IF num_nonnulls(
       v_attempt.cbte_asoc_original_id,
       v_attempt.cbte_asoc_tipo,
       v_attempt.cbte_asoc_punto_venta,
       v_attempt.cbte_asoc_numero
     ) > 0 THEN
    IF v_attempt.cbte_asoc_original_id IS NOT DISTINCT FROM p_original_id
       AND v_attempt.cbte_asoc_tipo IS NOT DISTINCT FROM p_cbte_tipo
       AND v_attempt.cbte_asoc_punto_venta IS NOT DISTINCT FROM p_punto_venta
       AND v_attempt.cbte_asoc_numero IS NOT DISTINCT FROM p_numero THEN
      RETURN jsonb_build_object('success', true, 'replay', true);
    END IF;

    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'CBTES_ASOC_SNAPSHOT_CONFLICT',
      'error', 'El attempt ya tiene otro snapshot de CbtesAsoc');
  END IF;

  UPDATE public.arca_emission_attempts
     SET cbte_asoc_original_id = p_original_id,
         cbte_asoc_tipo = p_cbte_tipo,
         cbte_asoc_punto_venta = p_punto_venta,
         cbte_asoc_numero = p_numero,
         updated_at = now()
   WHERE id = p_attempt_id
     AND status IN ('claimed', 'number_reserved', 'sent')
     AND cbte_asoc_original_id IS NULL
     AND cbte_asoc_tipo IS NULL
     AND cbte_asoc_punto_venta IS NULL
     AND cbte_asoc_numero IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated <> 1 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'CBTES_ASOC_SNAPSHOT_FAILED',
      'error', 'No se pudo fijar CbtesAsoc en el attempt activo');
  END IF;

  RETURN jsonb_build_object('success', true, 'replay', false);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'success', false,
    'error_code', 'INTERNAL_ERROR',
    'error', 'No se pudo validar y fijar CbtesAsoc');
END;
$$;

REVOKE ALL ON FUNCTION public.snapshot_arca_nc_cbtes_asoc(uuid, uuid, uuid, integer, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.snapshot_arca_nc_cbtes_asoc(uuid, uuid, uuid, integer, integer, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.snapshot_arca_nc_cbtes_asoc(uuid, uuid, uuid, integer, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.snapshot_arca_nc_cbtes_asoc(uuid, uuid, uuid, integer, integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.create_comprobante_checkout_atomic(
  p_business_id     uuid,
  p_idempotency_key text,
  p_request_hash    text,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
  v_arca_pv           integer;
  v_tipo_es_fiscal    boolean;
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

  -- Una Nota de Credito no es una venta generica. Necesita un comprobante
  -- original autorizado para resolver CbtesAsoc y su CbteTipo (A->3, B->8,
  -- C->13). Cortar ANTES del hash y del INSERT idempotente evita tanto una NC
  -- sin original como cualquier escritura residual de un intento invalido.
  v_tipo := p_payload->>'tipo';
  IF v_tipo = 'nota_credito' THEN
    RETURN jsonb_build_object(
      'status', 'failed_final',
      'error_code', 'CREDIT_NOTE_REQUIRES_ORIGINAL',
      'error', 'La Nota de Credito debe crearse desde un comprobante fiscal original');
  END IF;
  IF v_tipo IS NULL OR v_tipo NOT IN ('remito', 'factura_a', 'factura_c') THEN
    RETURN jsonb_build_object(
      'status', 'failed_final',
      'error_code', 'VALIDATION_ERROR',
      'error', format('tipo de comprobante invalido: %s', COALESCE(v_tipo, 'NULL')));
  END IF;
  v_emitir_en_arca := COALESCE((p_payload->>'emitir_en_arca')::boolean, false);
  IF v_tipo = 'remito' AND v_emitir_en_arca THEN
    RETURN jsonb_build_object(
      'status', 'failed_final',
      'error_code', 'NON_FISCAL_ARCA_NOT_ALLOWED',
      'error', 'Un remito no fiscal no puede solicitar emision en ARCA');
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

    v_emitir_en_arca   := COALESCE((p_payload->>'emitir_en_arca')::boolean, false);
    v_skip_finance     := COALESCE((p_payload->>'skip_finance_entry')::boolean, false);
    v_exchange_rate    := COALESCE((p_payload->>'exchange_rate')::numeric, 1);
    v_customer_id      := NULLIF(p_payload->>'customer_id', '')::uuid;
    v_caja_id          := NULLIF(p_payload->>'caja_id', '')::uuid;
    -- == P0 · PUNTO DE VENTA FISCAL: lo resuelve el SERVIDOR ==================
    -- El cliente manda el PV que muestra el POS (sales_points.numero). Eso es
    -- legitimo para un remito, pero NO puede definir la identidad fiscal de una
    -- factura: el CAE se pide SIEMPRE con arca_config.punto_venta
    -- (ver claim_comprobante_arca_emission), asi que confiar en el payload
    -- dejaba comprobantes fiscales persistidos con un PV inexistente en AFIP.
    --
    -- La fiscalidad se deriva del TIPO, no del payload: si se leyera es_fiscal
    -- del cliente, mandar es_fiscal=false junto a tipo=factura_c alcanzaria
    -- para quedarse con el PV local.
    v_tipo_es_fiscal := (v_tipo IN ('factura_a', 'factura_c'));

    -- Fuente unica de fiscalidad persistida: el tipo validado. El cliente no
    -- puede degradar una factura a no_fiscal mandando es_fiscal=false, ni puede
    -- marcar un remito para emision ARCA.
    v_es_fiscal      := v_tipo_es_fiscal;
    v_emitir_en_arca := v_emitir_en_arca AND v_tipo_es_fiscal;

    IF v_tipo_es_fiscal THEN
      SELECT punto_venta INTO v_arca_pv
        FROM arca_config
       WHERE business_id = p_business_id
         AND punto_venta > 0;

      IF v_arca_pv IS NOT NULL THEN
        -- Fuente canonica. El payload se descarta.
        v_punto_venta := lpad(v_arca_pv::text, 4, '0');
      ELSIF v_emitir_en_arca THEN
        -- Se pidio CAE y no hay configuracion: fail-closed explicito. Jamas
        -- inventar un PV para un documento que va a pedir autorizacion a AFIP.
        RAISE EXCEPTION 'ARCA_NOT_CONFIGURED: falta el punto de venta de ARCA para emitir un comprobante fiscal';
      ELSE
        -- Fiscal SIN integracion ARCA - hoy el caso por defecto. No hay fuente
        -- canonica todavia, asi que se usa el mismo DEFAULT que declara
        -- arca_config.punto_venta (1) y NUNCA el PV local del cliente. El
        -- comprobante queda en estado_fiscal='pendiente_emision' y la impresion
        -- lo rotula como numero interno, asi que este valor no se presenta como
        -- identidad fiscal emitida.
        v_punto_venta := '0001';
      END IF;
    ELSE
      -- No fiscal (remito): el PV local de sales_points es legitimo.
      v_punto_venta := COALESCE(p_payload->>'punto_venta', '0001');
    END IF;
    v_condicion_fiscal := COALESCE(p_payload->>'condicion_fiscal', 'Consumidor Final');
    v_observaciones    := p_payload->>'observaciones';
    v_order_id         := NULLIF(p_payload->>'order_id', '')::uuid;

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
      WHEN SQLERRM LIKE 'ARCA_NOT_CONFIGURED%' THEN 'ARCA_NOT_CONFIGURED'
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
      WHEN v_ec = 'ARCA_NOT_CONFIGURED' THEN 'Configura el punto de venta de ARCA antes de emitir un comprobante fiscal'
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
$$;


-- ── Exposición EXPLÍCITA ────────────────────────────────────────────────────
-- CREATE OR REPLACE conserva los privilegios existentes, pero un CREATE sobre
-- una base limpia nace con EXECUTE para PUBLIC (default de PostgreSQL), y eso
-- alcanzaría a anon. Se redeclara el mismo ACL que ya tenía la función:
-- authenticated + service_role, anon fuera. Es idempotente y deja el contrato
-- escrito en la migración en vez de depender del estado previo.
REVOKE ALL ON FUNCTION public.create_comprobante_checkout_atomic(uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_comprobante_checkout_atomic(uuid, text, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_comprobante_checkout_atomic(uuid, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_comprobante_checkout_atomic(uuid, text, text, jsonb) TO service_role;


-- ============================================================================
-- NOTA DE CREDITO: LA IDENTIDAD DEL ORIGINAL ES UNA TERNA, SIN DEFAULTS
--
-- La definicion historica convertia NULL a Factura C (11) y cualquier codigo
-- no reconocido a NC-C (13). Eso permitia crear una NC con una clase fiscal
-- inventada. La RPC queda fail-closed antes de insertar la NC si no puede
-- demostrar la identidad completa (PtoVta, CbteTipo, CbteNro) del original.
-- `numero_fiscal` sigue sin ser una clave unica: Factura C y NC-C tienen series
-- distintas por CbteTipo y pueden compartir el mismo texto PV-numero.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_credit_note_from_comprobante(
  p_comprobante_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_comp                comprobantes%ROWTYPE;
  v_business_id         uuid;
  v_has_access          boolean := false;
  v_existing_nc_id      uuid;
  v_arca_pv             integer;
  v_original_cbte_tipo  numeric;
  v_nc_tipo_fiscal      integer;
  v_nc_id               uuid;
BEGIN
  -- 1. Obtener comprobante original.
  SELECT * INTO v_comp
    FROM comprobantes
   WHERE id = p_comprobante_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'NOT_FOUND',
      'error', 'Comprobante no encontrado');
  END IF;
  v_business_id := v_comp.business_id;

  -- 2. Verificar acceso antes de revelar o mutar datos del negocio.
  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id = v_business_id AND owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id = v_business_id AND user_id = auth.uid())
  ) INTO v_has_access;

  IF NOT v_has_access THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'FORBIDDEN',
      'error', 'Sin acceso al negocio');
  END IF;

  -- Recién después de autorizar se serializan las NC del mismo original. La
  -- segunda sesión espera este lock y luego ve la NC creada por la primera;
  -- un usuario ajeno nunca puede bloquear filas de otro negocio por UUID.
  SELECT * INTO v_comp
    FROM comprobantes
   WHERE id = p_comprobante_id
     AND business_id = v_business_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'NOT_FOUND',
      'error', 'Comprobante no encontrado');
  END IF;

  -- 3. Solo un comprobante realmente autorizado puede ser asociado.
  IF v_comp.estado_fiscal IS DISTINCT FROM 'emitido' OR v_comp.cae IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'VALIDATION_ERROR',
      'error', 'Solo se puede generar NC sobre comprobantes emitidos en ARCA');
  END IF;

  -- 4. Identidad fiscal completa y valida del original.
  --    numero_fiscal aporta (PtoVta, CbteNro); tipo_comprobante_fiscal aporta
  --    CbteTipo. Ninguna pata se deriva de punto_venta/numero locales.
  IF v_comp.numero_fiscal IS NULL
     OR btrim(v_comp.numero_fiscal) !~ '^[0-9]{1,5}-[0-9]{1,12}$'
     OR split_part(btrim(v_comp.numero_fiscal), '-', 1)::numeric <= 0
     OR split_part(btrim(v_comp.numero_fiscal), '-', 2)::numeric <= 0
     OR v_comp.tipo_comprobante_fiscal IS NULL
     OR btrim(v_comp.tipo_comprobante_fiscal) !~ '^[0-9]+$' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'FISCAL_IDENTITY_INCOMPLETE',
      'error', 'El comprobante original no tiene una identidad fiscal completa');
  END IF;

  v_original_cbte_tipo := btrim(v_comp.tipo_comprobante_fiscal)::numeric;

  -- El payload actual de emision de NC modela correctamente NC-C
  -- (receptor consumidor final, IVA 0). No se inventa soporte A/B: hasta que
  -- sus importes y receptor tengan contrato propio, cualquier otra clase o un
  -- tipo comercial incoherente falla cerrado.
  IF v_comp.tipo IS DISTINCT FROM 'factura_c'
     OR v_original_cbte_tipo IS DISTINCT FROM 11 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'UNSUPPORTED_ORIGINAL_CBTE_TYPE',
      'error', 'Solo una Factura C con CbteTipo 11 puede generar una Nota de Credito C');
  END IF;
  v_nc_tipo_fiscal := 13;

  -- 5. La NC se va a emitir en ARCA: su PV se resuelve ahora desde la misma
  --    configuracion server-side que usa el claim. Sin una configuracion valida
  --    no se crea siquiera el borrador con emitir_en_arca=true.
  SELECT punto_venta INTO v_arca_pv
    FROM arca_config
   WHERE business_id = v_business_id
     AND punto_venta > 0;

  IF v_arca_pv IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'ARCA_NOT_CONFIGURED',
      'error', 'Falta el punto de venta de ARCA para crear la Nota de Credito');
  END IF;

  -- 6. Bloquear doble anulacion.
  IF v_comp.estado IN ('anulado') OR v_comp.estado_comercial = 'anulado' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'VALIDATION_ERROR',
      'error', 'El comprobante ya fue anulado');
  END IF;

  -- 7. Verificar que no existe otra NC activa para el original.
  SELECT id INTO v_existing_nc_id
    FROM comprobantes
   WHERE comprobante_original_id = p_comprobante_id
     AND business_id = v_business_id
     AND estado_fiscal NOT IN ('anulado_fiscal', 'error_emision')
     AND estado NOT IN ('anulado')
   LIMIT 1;

  IF v_existing_nc_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'CREDIT_NOTE_ALREADY_EXISTS',
      'error', 'Ya existe una Nota de Credito para este comprobante',
      'nc_id', v_existing_nc_id);
  END IF;

  -- 8. Crear la NC en pendiente_emision con identidad de serie server-side.
  INSERT INTO comprobantes (
    id, business_id, customer_id, order_id,
    tipo, type, punto_venta, fecha, date,
    subtotal, impuestos, tax, total, total_ars, total_usd,
    currency, exchange_rate,
    estado, status, estado_comercial, estado_fiscal,
    es_fiscal, emitir_en_arca,
    tipo_comprobante_fiscal,
    condicion_fiscal, observaciones,
    descuento_total, recargo_total,
    total_bruto, saldo_pendiente, total_cobrado,
    comprobante_original_id,
    created_by
  ) VALUES (
    gen_random_uuid(),
    v_business_id, v_comp.customer_id, v_comp.order_id,
    'nota_credito', 'nota_credito', lpad(v_arca_pv::text, 4, '0'),
    now(), now(),
    v_comp.subtotal, v_comp.impuestos, COALESCE(v_comp.tax, 0),
    v_comp.total, v_comp.total_ars, v_comp.total_usd,
    COALESCE(v_comp.currency, 'ARS'), COALESCE(v_comp.exchange_rate, 1),
    'borrador', 'draft', 'pendiente', 'pendiente_emision',
    true, true,
    v_nc_tipo_fiscal::text,
    v_comp.condicion_fiscal,
    'Nota de Credito - anula comprobante #' || COALESCE(v_comp.numero_fiscal, v_comp.numero, v_comp.id::text),
    COALESCE(v_comp.descuento_total, 0),
    COALESCE(v_comp.recargo_total, 0),
    COALESCE(v_comp.total_bruto, v_comp.total, 0),
    0, 0,
    p_comprobante_id,
    auth.uid()
  )
  RETURNING id INTO v_nc_id;

  -- 9. Copiar items del original sin movimiento de stock.
  INSERT INTO comprobante_items (
    id, comprobante_id, business_id, created_by,
    descripcion, tipo_linea,
    cantidad, precio_unitario, descuento_linea, subtotal,
    costo_unitario, costo_total,
    currency, exchange_rate, inventory_id, orden
  )
  SELECT
    gen_random_uuid(), v_nc_id, v_business_id, auth.uid(),
    'NC: ' || descripcion, tipo_linea,
    cantidad, precio_unitario, descuento_linea, subtotal,
    0, 0,
    currency, exchange_rate,
    NULL,
    orden
  FROM comprobante_items
  WHERE comprobante_id = p_comprobante_id;

  RETURN jsonb_build_object(
    'success', true,
    'nc_id', v_nc_id,
    'nc_tipo_fiscal', v_nc_tipo_fiscal,
    'original_numero', v_comp.numero_fiscal,
    'total', v_comp.total);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.create_credit_note_from_comprobante(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_credit_note_from_comprobante(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_credit_note_from_comprobante(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_credit_note_from_comprobante(uuid) TO service_role;


-- ============================================================================
-- FINALIZACION DE NC AUTORIZADA: ORIGINAL + REVERSA EN UNA TRANSACCION
--
-- La version previa creaba FM/BFE, mientras el cliente anulaba el original con
-- un UPDATE separado. Una caida entre ambas operaciones dejaba una NC con CAE
-- pero el original/economia a medio cerrar. Esta redefinicion conserva la
-- idempotencia natural de la RPC y suma la transicion del original dentro del
-- mismo bloque transaccional. Tambien admite service_role para que afip-cae la
-- ejecute inmediatamente despues de persistir un CAE; el cliente la reintenta
-- como segunda defensa y los replays no duplican libros.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_credit_note_finance_reversal(p_nc_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_nc           public.comprobantes%ROWTYPE;
  v_original     public.comprobantes%ROWTYPE;
  v_attempt      public.arca_emission_attempts%ROWTYPE;
  v_business_id  uuid;
  v_actor_id     uuid;
  v_has_access   boolean := false;
  v_nc_tipo      integer;
  v_nc_pv        integer;
  v_nc_numero    integer;
  v_original_tipo integer;
  v_original_pv  integer;
  v_original_numero integer;
  v_total        numeric;
  v_numero       text;
  v_orig_numero  text;
  v_today        date := public.ar_today();
  v_existing_fm  uuid;
  v_existing_bfe uuid;
  v_created_fm   boolean := false;
  v_created_bfe  boolean := false;
BEGIN
  -- Resolver el negocio sin lock para poder autorizar primero. Una sesión
  -- authenticated que conozca un UUID ajeno no debe poder retener una fila de
  -- otro tenant hasta el fin de su transacción.
  SELECT * INTO v_nc
    FROM public.comprobantes
   WHERE id = p_nc_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'ok', false,
      'error_code', 'NOT_FOUND', 'error', 'NC no encontrada');
  END IF;
  v_business_id := v_nc.business_id;

  -- El service_role solo entra desde la Edge Function; usuarios normales
  -- conservan exactamente el control owner/staff del contrato previo.
  SELECT (
    auth.role() = 'service_role'
    OR EXISTS (SELECT 1 FROM public.businesses
                WHERE id = v_business_id AND owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.profiles
                WHERE business_id = v_business_id AND user_id = auth.uid())
  ) INTO v_has_access;
  IF NOT v_has_access THEN
    RETURN jsonb_build_object('success', false, 'ok', false,
      'error_code', 'FORBIDDEN', 'error', 'Sin acceso al negocio');
  END IF;

  -- Recién después de autorizar se serializa la finalización de esta NC.
  SELECT * INTO v_nc
    FROM public.comprobantes
   WHERE id = p_nc_id
     AND business_id = v_business_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'ok', false,
      'error_code', 'NOT_FOUND', 'error', 'NC no encontrada');
  END IF;
  v_actor_id := COALESCE(auth.uid(), v_nc.created_by);

  -- Una fila con CAE no basta: primero debe demostrar una FiscalIdentity NC-C.
  IF v_nc.tipo IS DISTINCT FROM 'nota_credito'
     OR v_nc.estado_fiscal IS DISTINCT FROM 'emitido'
     OR v_nc.cae IS NULL
     OR btrim(v_nc.cae) = ''
     OR v_nc.tipo_comprobante_fiscal IS NULL
     OR btrim(v_nc.tipo_comprobante_fiscal) !~ '^[0-9]+$'
     OR v_nc.numero_fiscal IS NULL
     OR btrim(v_nc.numero_fiscal) !~ '^[0-9]{1,5}-[0-9]{1,12}$' THEN
    RETURN jsonb_build_object('success', false, 'ok', false,
      'error_code', 'NC_FISCAL_IDENTITY_INCOMPLETE',
      'error', 'La NC debe estar autorizada y tener una FiscalIdentity NC-C completa');
  END IF;

  v_nc_tipo := btrim(v_nc.tipo_comprobante_fiscal)::integer;
  v_nc_pv := split_part(btrim(v_nc.numero_fiscal), '-', 1)::integer;
  v_nc_numero := split_part(btrim(v_nc.numero_fiscal), '-', 2)::integer;
  IF v_nc_tipo IS DISTINCT FROM 13 OR v_nc_pv <= 0 OR v_nc_numero <= 0 THEN
    RETURN jsonb_build_object('success', false, 'ok', false,
      'error_code', 'NC_FISCAL_IDENTITY_INVALID',
      'error', 'La fila autorizada no es una Nota de Credito C con identidad valida');
  END IF;

  IF v_nc.comprobante_original_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'ok', false,
      'error_code', 'VALIDATION_ERROR',
      'error', 'La NC no tiene comprobante original asociado');
  END IF;

  SELECT * INTO v_original
    FROM public.comprobantes
   WHERE id = v_nc.comprobante_original_id
     AND business_id = v_business_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'ok', false,
      'error_code', 'ORIGINAL_NOT_FOUND',
      'error', 'El comprobante original de la NC no existe en el mismo negocio');
  END IF;

  IF v_original.tipo IS DISTINCT FROM 'factura_c'
     OR v_original.cae IS NULL
     OR btrim(v_original.cae) = ''
     OR v_original.tipo_comprobante_fiscal IS NULL
     OR btrim(v_original.tipo_comprobante_fiscal) !~ '^[0-9]+$'
     OR v_original.numero_fiscal IS NULL
     OR btrim(v_original.numero_fiscal) !~ '^[0-9]{1,5}-[0-9]{1,12}$' THEN
    RETURN jsonb_build_object('success', false, 'ok', false,
      'error_code', 'ORIGINAL_FISCAL_IDENTITY_INCOMPLETE',
      'error', 'El original no es una Factura C con FiscalIdentity completa');
  END IF;

  v_original_tipo := btrim(v_original.tipo_comprobante_fiscal)::integer;
  v_original_pv := split_part(btrim(v_original.numero_fiscal), '-', 1)::integer;
  v_original_numero := split_part(btrim(v_original.numero_fiscal), '-', 2)::integer;
  IF v_original_tipo IS DISTINCT FROM 11
     OR v_original_pv <= 0
     OR v_original_numero <= 0 THEN
    RETURN jsonb_build_object('success', false, 'ok', false,
      'error_code', 'ORIGINAL_FISCAL_IDENTITY_INVALID',
      'error', 'El original no tiene identidad de Factura C valida');
  END IF;

  -- La prueba de autorizacion vive en el attempt, no en un UPDATE suelto de la
  -- fila. Debe coincidir a la vez con el CAE/identidad de la NC y con el
  -- snapshot exacto del original asociado que se fijo antes de contactar ARCA.
  SELECT * INTO v_attempt
    FROM public.arca_emission_attempts
   WHERE comprobante_id = p_nc_id
     AND business_id = v_business_id
     AND status IN ('authorized', 'authorized_reconciled')
     AND tipo_comprobante = 13
     AND punto_venta = v_nc_pv
     AND numero_intentado = v_nc_numero
     AND cae IS NOT NULL
     AND cae = v_nc.cae
     AND cbte_asoc_original_id = v_original.id
     AND cbte_asoc_tipo = v_original_tipo
     AND cbte_asoc_punto_venta = v_original_pv
     AND cbte_asoc_numero = v_original_numero
   ORDER BY completed_at DESC NULLS LAST, started_at DESC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'ok', false,
      'error_code', 'ARCA_ATTEMPT_PROOF_MISSING',
      'error', 'No existe un attempt ARCA autorizado con CAE, numero y CbtesAsoc exactos');
  END IF;

  v_total       := COALESCE(v_nc.total_bruto, v_nc.total_ars, v_nc.total, 0);
  v_numero      := COALESCE(v_nc.numero_fiscal, v_nc.numero, p_nc_id::text);
  v_orig_numero := COALESCE(v_original.numero_fiscal, v_original.numero, v_original.id::text);

  SELECT id INTO v_existing_fm
    FROM public.financial_movements
   WHERE comprobante_id = p_nc_id
     AND business_id = v_business_id
     AND sign = -1
   LIMIT 1;

  IF v_existing_fm IS NULL THEN
    INSERT INTO public.financial_movements (
      business_id, date, type, currency, amount, exchange_rate, amount_ars,
      source, comprobante_id, description, created_by, sign, metodo_pago
    ) VALUES (
      v_business_id, v_today, 'expense',
      COALESCE(v_nc.currency, 'ARS'), v_total, COALESCE(v_nc.exchange_rate, 1), v_total,
      'comprobante', p_nc_id,
      'NOTA DE CRÉDITO #' || v_numero || ' — anula ' || v_orig_numero,
      v_actor_id, -1, NULL
    );
    v_created_fm := true;
  END IF;

  SELECT id INTO v_existing_bfe
    FROM public.business_finance_entries
   WHERE reference_comprobante_id = p_nc_id
     AND business_id = v_business_id
     AND amount_ars < 0
     AND source = 'comprobante'
   LIMIT 1;

  IF v_existing_bfe IS NULL THEN
    INSERT INTO public.business_finance_entries (
      business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate,
      reference_comprobante_id, source, created_by
    ) VALUES (
      v_business_id, v_today, 'income', 'ventas_productos',
      'NOTA DE CRÉDITO #' || v_numero || ' — anula ' || v_orig_numero,
      -v_total, COALESCE(v_nc.currency, 'ARS'), -v_total, COALESCE(v_nc.exchange_rate, 1),
      p_nc_id, 'comprobante', v_actor_id
    );
    v_created_bfe := true;
  END IF;

  -- El guard canónico de main exige simultáneamente current_user=postgres
  -- (aportado por esta SECURITY DEFINER) y el scope explícito de anulación.
  -- Sin esta marca el UPDATE falla cerrado y deja la NC autorizada sin cerrar.
  PERFORM pg_catalog.set_config('m7.annulment_scope', '1', true);

  UPDATE public.comprobantes
     SET estado = 'anulado',
         status = 'cancelled',
         estado_comercial = 'anulado',
         estado_fiscal = 'anulado_fiscal'
   WHERE id = v_original.id
     AND business_id = v_business_id
     AND (
       estado IS DISTINCT FROM 'anulado'
       OR status IS DISTINCT FROM 'cancelled'
       OR estado_comercial IS DISTINCT FROM 'anulado'
       OR estado_fiscal IS DISTINCT FROM 'anulado_fiscal'
     );

  RETURN jsonb_build_object(
    'success', true, 'ok', true,
    'replay', NOT (v_created_fm OR v_created_bfe),
    'fm_created', v_created_fm,
    'bfe_created', v_created_bfe,
    'original_finalized', true);

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'ok', false,
      'error_code', 'INTERNAL_ERROR',
      'error', 'No se pudo finalizar la Nota de Credito autorizada');
END;
$$;

REVOKE ALL ON FUNCTION public.create_credit_note_finance_reversal(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_credit_note_finance_reversal(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_credit_note_finance_reversal(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_credit_note_finance_reversal(uuid) TO service_role;

COMMIT;
