-- ============================================================================
-- Etapa 0 — annul_comprobante_atomic: anulación server-side, atómica,
-- idempotente y auditada. Reemplaza comprobanteService.anular() client-side
-- (4 escrituras sin transacción que revertían por total_bruto, caían en la
-- caja de HOY vía trigger y NUNCA revertían cuenta corriente — P0-5).
--
-- MODOS (parámetro cerrado):
--   void_same_session      La venta y la anulación ocurren en la MISMA caja
--                          abierta. Compensación dentro de la sesión, con
--                          trazabilidad (nunca se borra el asiento original).
--   refund_current_session Se devuelve el dinero HOY. El ingreso original (y
--                          su caja, abierta o cerrada) queda INTACTO; el
--                          egreso de devolución se registra en la caja
--                          abierta actual, vinculado al movimiento original.
--   commercial_annulment   No hubo dinero real (venta en CC o pendiente).
--                          Revierte deuda/COGS/stock; no genera egreso de
--                          caja por cobros (no los hubo). Si existieran FM de
--                          ingreso fantasma (rama P0-3 histórica), se
--                          compensan igual para no dejar caja inflada.
--
-- REGLAS:
--   - Comprobantes con CAE / numero_fiscal / estado_fiscal='emitido' NO pasan
--     por acá: requieren Nota de Crédito fiscal (crearNotaCredito). Se
--     devuelve requiere_nota_credito=true.
--   - Reverso EXACTO por asiento: un FM compensatorio por cada FM de ingreso
--     original (mismo método/moneda/importe, reference_id = FM original);
--     espejo negativo por cada BFE de ingreso/comisión/COGS vinculado. NUNCA
--     por total_bruto.
--   - Cajas cerradas: jamás se modifican. La compensación vive en la caja
--     abierta actual.
--   - CC: movimiento compensatorio en el ledger (crédito) — el histórico no
--     se borra; balance_after lo calcula el trigger existente (FOR UPDATE).
--   - Stock: solo si p_restore_stock=true; exactamente una vez por ítem
--     (marcador stock_processed).
--   - Idempotencia: UNIQUE(business_id, idempotency_key) en la tabla de
--     auditoría + lock FOR UPDATE del comprobante. Reintento con la misma
--     key y el mismo payload devuelve el resultado original sin duplicar
--     nada; misma key con payload distinto falla.
-- ============================================================================

-- ── Tabla de auditoría/idempotencia de anulaciones ──────────────────────────
-- (Mínima y específica — el finance_audit_log general es alcance M7.)
CREATE TABLE IF NOT EXISTS "public"."comprobante_annulments" (
  "id"                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id"               uuid NOT NULL REFERENCES "public"."businesses"("id"),
  "comprobante_id"            uuid NOT NULL REFERENCES "public"."comprobantes"("id"),
  "user_id"                   uuid NOT NULL,
  "idempotency_key"           text NOT NULL,
  -- Hash del payload (comprobante+modo+restore_stock): misma key con payload
  -- distinto → rechazo explícito, nunca continuar en silencio.
  "request_hash"              text NOT NULL,
  "mode"                      text NOT NULL CHECK ("mode" IN ('void_same_session', 'refund_current_session', 'commercial_annulment')),
  "motivo"                    text NOT NULL,
  "restore_stock"             boolean NOT NULL,
  "stock_restored_count"      integer NOT NULL DEFAULT 0,
  "original_caja_ids"         uuid[] NOT NULL DEFAULT '{}',
  "refund_caja_id"            uuid,
  "reverted_cash_ars"         numeric NOT NULL DEFAULT 0,
  "reverted_cc_ars"           numeric NOT NULL DEFAULT 0,
  "reverted_commissions_ars"  numeric NOT NULL DEFAULT 0,
  "reverted_cogs_ars"         numeric NOT NULL DEFAULT 0,
  "original_fm_ids"           uuid[] NOT NULL DEFAULT '{}',
  "fm_reversal_ids"           uuid[] NOT NULL DEFAULT '{}',
  "bfe_reversal_ids"          uuid[] NOT NULL DEFAULT '{}',
  "cc_reversal_movement_id"   uuid,
  "status"                    text NOT NULL DEFAULT 'completed' CHECK ("status" IN ('completed')),
  "created_at"                timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE "public"."comprobante_annulments" IS
  'Auditoría + idempotencia de annul_comprobante_atomic. UNIQUE(business_id, '
  'idempotency_key) es el guard de reintentos; UNIQUE parcial por comprobante '
  'garantiza UNA sola anulación completada por comprobante.';

CREATE UNIQUE INDEX IF NOT EXISTS "idx_comprobante_annulments_key"
  ON "public"."comprobante_annulments" ("business_id", "idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_comprobante_annulments_comp"
  ON "public"."comprobante_annulments" ("comprobante_id")
  WHERE "status" = 'completed';

ALTER TABLE "public"."comprobante_annulments" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "comprobante_annulments_select" ON "public"."comprobante_annulments";
CREATE POLICY "comprobante_annulments_select" ON "public"."comprobante_annulments"
  FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM "public"."businesses" WHERE "id" = "comprobante_annulments"."business_id" AND "owner_user_id" = auth.uid())
    OR EXISTS (SELECT 1 FROM "public"."profiles" WHERE "business_id" = "comprobante_annulments"."business_id" AND "user_id" = auth.uid())
  );

-- Sin policies de escritura: la única vía es la RPC SECURITY DEFINER.
REVOKE ALL ON "public"."comprobante_annulments" FROM PUBLIC;
REVOKE ALL ON "public"."comprobante_annulments" FROM "anon";
GRANT SELECT ON "public"."comprobante_annulments" TO "authenticated";
GRANT ALL ON "public"."comprobante_annulments" TO "service_role";

-- ── RPC ──────────────────────────────────────────────────────────────────────
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
  v_user_id         uuid := auth.uid();
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
  v_stock_count     integer := 0;
  v_reverted_cogs   numeric := 0;
  v_annulment_id    uuid;
BEGIN
  -- ── Validaciones de entrada ────────────────────────────────────────────────
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No autenticado');
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('void_same_session', 'refund_current_session', 'commercial_annulment') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Modo de anulación inválido: ' || COALESCE(p_mode, '(null)'));
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El motivo de la anulación es obligatorio');
  END IF;
  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'idempotency_key requerida');
  END IF;

  -- ── Lock del comprobante ANTES de cualquier verificación de estado ─────────
  -- Dos anulaciones concurrentes se serializan acá: la segunda espera y luego
  -- ve el estado/auditoría que dejó la primera (replay o rechazo, nunca doble).
  SELECT * INTO v_comp FROM comprobantes WHERE id = p_comprobante_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Comprobante no encontrado');
  END IF;

  -- ── Ownership (resuelto desde el comprobante, nunca desde un parámetro) ────
  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id = v_comp.business_id AND owner_user_id = v_user_id)
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id = v_comp.business_id AND user_id = v_user_id AND COALESCE(is_active, true) = true)
  ) INTO v_has_access;
  IF NOT v_has_access THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio');
  END IF;

  v_request_hash := md5(p_comprobante_id::text || '|' || p_mode || '|' || p_restore_stock::text);

  -- ── Idempotencia: reintento con la misma key devuelve el resultado previo ──
  SELECT * INTO v_prev FROM comprobante_annulments
    WHERE business_id = v_comp.business_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_prev.request_hash IS DISTINCT FROM v_request_hash THEN
      RETURN jsonb_build_object('ok', false,
        'error', 'La idempotency_key ya fue usada con parámetros distintos. Generá una key nueva.');
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'replay', true,
      'annulment_id', v_prev.id, 'mode', v_prev.mode,
      'reverted_cash_ars', v_prev.reverted_cash_ars,
      'reverted_cc_ars', v_prev.reverted_cc_ars,
      'reverted_commissions_ars', v_prev.reverted_commissions_ars,
      'reverted_cogs_ars', v_prev.reverted_cogs_ars,
      'stock_restored_count', v_prev.stock_restored_count
    );
  END IF;

  -- ── Estado ─────────────────────────────────────────────────────────────────
  IF v_comp.estado = 'anulado' OR v_comp.status = 'cancelled' OR v_comp.estado_comercial = 'anulado' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El comprobante ya está anulado');
  END IF;
  IF COALESCE(v_comp.tipo, v_comp.type) = 'nota_credito' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Una nota de crédito no se anula por este flujo');
  END IF;
  -- Fiscal: con CAE (o número fiscal, o estado emitido en ARCA) corresponde
  -- Nota de Crédito fiscal, nunca anulación comercial local.
  IF v_comp.cae IS NOT NULL OR v_comp.numero_fiscal IS NOT NULL OR v_comp.estado_fiscal = 'emitido' THEN
    RETURN jsonb_build_object('ok', false,
      'error', 'Este comprobante fue autorizado por ARCA. Generá una Nota de Crédito desde el detalle del comprobante.',
      'requiere_nota_credito', true);
  END IF;

  v_numero := COALESCE(v_comp.numero_fiscal, v_comp.number, v_comp.numero, left(v_comp.id::text, 8));

  -- ── Medir lo REALMENTE registrado (nunca total_bruto) ─────────────────────
  SELECT COALESCE(SUM(amount_ars), 0), COALESCE(SUM(commission_amount), 0)
    INTO v_cobrado, v_commissions
    FROM comprobante_payments
    WHERE comprobante_id = v_comp.id AND business_id = v_comp.business_id;

  SELECT COALESCE(SUM(debit - credit), 0) INTO v_cc_net
    FROM account_movements
    WHERE business_id = v_comp.business_id
      AND reference_type = 'comprobante' AND reference_id = v_comp.id;

  SELECT COALESCE(SUM(amount_ars), 0),
         COALESCE(array_agg(id), '{}'),
         COALESCE(array_agg(DISTINCT caja_id) FILTER (WHERE caja_id IS NOT NULL), '{}')
    INTO v_fm_income_total, v_original_fm_ids, v_original_cajas
    FROM financial_movements
    WHERE comprobante_id = v_comp.id AND business_id = v_comp.business_id
      AND type = 'income' AND COALESCE(sign, 1) = 1;

  -- Caja abierta actual (a lo sumo una, por idx_cajas_unica_abierta_por_negocio)
  SELECT id INTO v_open_caja_id FROM cajas
    WHERE business_id = v_comp.business_id AND status = 'abierta'
    ORDER BY opened_at DESC LIMIT 1;

  -- ── Validaciones por modo ──────────────────────────────────────────────────
  IF p_mode = 'commercial_annulment' THEN
    IF v_cobrado > c_tolerance_ars THEN
      RETURN jsonb_build_object('ok', false,
        'error', format('Este comprobante tiene $%s cobrados. Si devolviste el dinero usá el modo devolución; si no, no corresponde anulación comercial.', round(v_cobrado, 2)));
    END IF;
  ELSE
    IF v_cobrado <= c_tolerance_ars AND v_fm_income_total <= c_tolerance_ars THEN
      RETURN jsonb_build_object('ok', false,
        'error', 'No hay cobros registrados para devolver — usá la anulación comercial (sin devolución de dinero).');
    END IF;
    IF v_open_caja_id IS NULL THEN
      RETURN jsonb_build_object('ok', false,
        'error', 'No hay caja abierta. Abrí una caja para registrar la devolución.');
    END IF;
    IF p_mode = 'void_same_session' THEN
      -- TODOS los ingresos originales deben pertenecer a la caja abierta actual.
      IF EXISTS (
        SELECT 1 FROM financial_movements
        WHERE comprobante_id = v_comp.id AND business_id = v_comp.business_id
          AND type = 'income' AND COALESCE(sign, 1) = 1
          AND (caja_id IS DISTINCT FROM v_open_caja_id)
      ) THEN
        RETURN jsonb_build_object('ok', false,
          'error', 'La venta no pertenece a la caja abierta actual — usá el modo devolución (el egreso se registra en la caja de hoy sin tocar la sesión original).');
      END IF;
    END IF;
  END IF;

  -- ── 1. Compensación de caja: UN egreso espejo por CADA ingreso original ───
  -- (misma moneda/método/importe; la caja original — abierta o cerrada — no
  -- se modifica jamás: la compensación vive en la caja abierta actual).
  FOR v_fm IN
    SELECT * FROM financial_movements
    WHERE comprobante_id = v_comp.id AND business_id = v_comp.business_id
      AND type = 'income' AND COALESCE(sign, 1) = 1
    ORDER BY created_at
  LOOP
    INSERT INTO financial_movements (
      business_id, date, type, currency, amount, amount_ars, exchange_rate,
      source, source_id, comprobante_id, description, created_by, sign,
      metodo_pago, caja_id, reference_type, reference_id, movement_type
    ) VALUES (
      v_comp.business_id, public.ar_today(), 'expense',
      v_fm.currency, v_fm.amount, v_fm.amount_ars, COALESCE(v_fm.exchange_rate, 1),
      'comprobante', v_fm.source_id, v_comp.id,
      'ANULACIÓN Comprobante #' || v_numero || ' — reversa de mov. ' || v_fm.id
        || CASE WHEN trim(p_motivo) <> '' THEN ' · ' || trim(p_motivo) ELSE '' END,
      v_user_id, -1,
      -- movement_type 'refund': único valor del CHECK de la columna que
      -- describe una devolución (income/fee/refund/chargeback/adjustment).
      v_fm.metodo_pago, v_open_caja_id, 'annulment_reversal', v_fm.id, 'refund'
    ) RETURNING id INTO v_new_fm_id;
    v_fm_reversals := v_fm_reversals || v_new_fm_id;
  END LOOP;

  -- ── 2. Espejos negativos de BFE (ingresos, comisiones, COGS) ──────────────
  FOR v_bfe IN
    SELECT * FROM business_finance_entries
    WHERE business_id = v_comp.business_id
      AND reference_comprobante_id = v_comp.id
      AND amount_ars > 0
      AND (
        type = 'income'
        OR (type = 'variable_cost' AND category IN ('comisiones_cobro', 'mercaderia'))
      )
    ORDER BY created_at
  LOOP
    -- source='annulment' (no 'comprobante'): el índice legacy
    -- uniq_bfe_comprobante_reversal permite UNA sola BFE negativa por
    -- comprobante con source='comprobante' (guard del flujo de NC, que se
    -- conserva intacto). La anulación espeja VARIOS asientos por comprobante;
    -- su idempotencia real es comprobante_annulments + el lock del
    -- comprobante. La policy de BFE deja 'annulment' igual de inmutable.
    INSERT INTO business_finance_entries (
      business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate,
      payment_method, reference_comprobante_id, source, created_by
    ) VALUES (
      v_comp.business_id, public.ar_today(), v_bfe.type, v_bfe.category,
      'ANULACIÓN Comprobante #' || v_numero || ' — reversa de asiento ' || v_bfe.id,
      -v_bfe.amount, v_bfe.currency, -v_bfe.amount_ars, COALESCE(v_bfe.exchange_rate, 1),
      v_bfe.payment_method, v_comp.id, 'annulment', v_user_id
    ) RETURNING id INTO v_new_bfe_id;
    v_bfe_reversals := v_bfe_reversals || v_new_bfe_id;
    IF v_bfe.type = 'variable_cost' AND v_bfe.category = 'mercaderia' THEN
      v_reverted_cogs := v_reverted_cogs + v_bfe.amount_ars;
    END IF;
  END LOOP;

  -- COGS histórico sin referencia (BFE creados por la RPC de checkout ANTES de
  -- 20260702110000: source default 'manual', sin reference_comprobante_id).
  -- Se identifican por la descripción determinista que esa RPC siempre usó.
  FOR v_bfe IN
    SELECT * FROM business_finance_entries
    WHERE business_id = v_comp.business_id
      AND reference_comprobante_id IS NULL
      AND type = 'variable_cost' AND category = 'mercaderia'
      AND amount_ars > 0
      AND description = 'Costo de productos - Comprobante #' || v_numero
  LOOP
    INSERT INTO business_finance_entries (
      business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate,
      reference_comprobante_id, source, created_by
    ) VALUES (
      v_comp.business_id, public.ar_today(), 'variable_cost', 'mercaderia',
      'ANULACIÓN Comprobante #' || v_numero || ' — reversa de asiento ' || v_bfe.id,
      -v_bfe.amount, v_bfe.currency, -v_bfe.amount_ars, COALESCE(v_bfe.exchange_rate, 1),
      v_comp.id, 'annulment', v_user_id
    ) RETURNING id INTO v_new_bfe_id;
    v_bfe_reversals := v_bfe_reversals || v_new_bfe_id;
    v_reverted_cogs := v_reverted_cogs + v_bfe.amount_ars;
  END LOOP;

  -- ── 3. Cuenta corriente: movimiento compensatorio (histórico intacto) ─────
  IF v_cc_net > 0.01 THEN
    SELECT account_id INTO v_account_id
      FROM account_movements
      WHERE business_id = v_comp.business_id
        AND reference_type = 'comprobante' AND reference_id = v_comp.id
      ORDER BY created_at LIMIT 1;

    IF v_account_id IS NOT NULL THEN
      -- balance_after y accounts.balance los mantiene el trigger existente
      -- (BEFORE INSERT con SELECT ... FOR UPDATE sobre accounts).
      INSERT INTO account_movements (
        business_id, account_id, date, type, description, debit, credit,
        reference_type, reference_id, created_by
      ) VALUES (
        v_comp.business_id, v_account_id, public.ar_today(), 'ajuste',
        'ANULACIÓN Comprobante #' || v_numero || ' · ' || trim(p_motivo),
        0, v_cc_net,
        'comprobante', v_comp.id, v_user_id
      ) RETURNING id INTO v_cc_mov_id;
    END IF;
  END IF;

  -- ── 4. Stock: solo con devolución física explícita, exactamente una vez ───
  IF p_restore_stock THEN
    FOR v_item IN
      SELECT * FROM comprobante_items
      WHERE comprobante_id = v_comp.id
        AND stock_processed = true
        AND inventory_id IS NOT NULL
        AND COALESCE(tipo_linea, 'producto') IN ('producto', 'repuesto')
    LOOP
      SELECT stock_quantity INTO v_prev_stock FROM inventory
        WHERE id = v_item.inventory_id AND business_id = v_comp.business_id
        FOR UPDATE;

      IF FOUND THEN
        v_prev_stock := COALESCE(v_prev_stock, 0);
        v_new_stock  := v_prev_stock + v_item.cantidad::integer;

        UPDATE inventory SET stock_quantity = v_new_stock, updated_at = now()
          WHERE id = v_item.inventory_id AND business_id = v_comp.business_id;

        INSERT INTO inventory_movements (
          business_id, inventory_item_id, movement_type, quantity, previous_stock,
          new_stock, reference_type, reference_id, note, created_by
        ) VALUES (
          v_comp.business_id, v_item.inventory_id, 'return',
          v_item.cantidad::integer, v_prev_stock, v_new_stock,
          'comprobante', v_comp.id,
          'Devolución por anulación de comprobante #' || v_numero, v_user_id
        ) RETURNING id INTO v_mov_id;

        -- Marcador de exactamente-una-vez: un reintento no vuelve a restaurar.
        UPDATE comprobante_items
          SET stock_processed = false, stock_processed_at = NULL, stock_movement_id = NULL
          WHERE id = v_item.id;

        v_stock_count := v_stock_count + 1;
      END IF;
    END LOOP;
  END IF;

  -- ── 5. Estado del comprobante ──────────────────────────────────────────────
  UPDATE comprobantes SET
    estado           = 'anulado',
    status           = 'cancelled',
    estado_comercial = 'anulado',
    estado_fiscal    = CASE WHEN estado_fiscal = 'no_fiscal' THEN 'no_fiscal' ELSE 'anulado_fiscal' END,
    afip_response    = COALESCE(afip_response, '{}'::jsonb) || jsonb_build_object(
                         'anulacion', jsonb_build_object(
                           'motivo', trim(p_motivo), 'modo', p_mode,
                           'restore_stock', p_restore_stock, 'fecha', now())),
    updated_at       = now()
  WHERE id = v_comp.id;

  -- ── 6. Auditoría (también es el registro de idempotencia) ─────────────────
  INSERT INTO comprobante_annulments (
    business_id, comprobante_id, user_id, idempotency_key, request_hash,
    mode, motivo, restore_stock, stock_restored_count,
    original_caja_ids, refund_caja_id,
    reverted_cash_ars, reverted_cc_ars, reverted_commissions_ars, reverted_cogs_ars,
    original_fm_ids, fm_reversal_ids, bfe_reversal_ids, cc_reversal_movement_id
  ) VALUES (
    v_comp.business_id, v_comp.id, v_user_id, p_idempotency_key, v_request_hash,
    p_mode, trim(p_motivo), p_restore_stock, v_stock_count,
    v_original_cajas, v_open_caja_id,
    GREATEST(v_cobrado, v_fm_income_total), v_cc_net, v_commissions, v_reverted_cogs,
    v_original_fm_ids, v_fm_reversals, v_bfe_reversals, v_cc_mov_id
  ) RETURNING id INTO v_annulment_id;

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
  -- Transacción completa revertida por Postgres: nunca queda una anulación a
  -- medias. El registro de auditoría también se revierte, así el reintento
  -- con la misma key arranca limpio.
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

ALTER FUNCTION "public"."annul_comprobante_atomic"(uuid, text, text, boolean, text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."annul_comprobante_atomic"(uuid, text, text, boolean, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."annul_comprobante_atomic"(uuid, text, text, boolean, text) FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."annul_comprobante_atomic"(uuid, text, text, boolean, text) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."annul_comprobante_atomic"(uuid, text, text, boolean, text) TO "service_role";

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado):
--   DROP FUNCTION IF EXISTS annul_comprobante_atomic(uuid, text, text, boolean, text);
--   DROP TABLE IF EXISTS comprobante_annulments;
--   (comprobanteService.anular() client-side vuelve a ser el camino — requiere
--    revertir también el cambio de frontend de esta etapa)
-- ============================================================================
