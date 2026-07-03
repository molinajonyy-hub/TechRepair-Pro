-- ============================================================================
-- Etapa 0 — Protección mínima del ledger financiero (adelanto acotado de M6).
--
-- HOY el cliente autenticado puede hacer UPDATE/DELETE directo de:
--   financial_movements (fm_write ALL), comprobante_payments (cp_write ALL),
--   business_finance_entries (bfe_update/bfe_delete) y account_movements
--   (policy ALL, con trigger de balance SOLO en INSERT → un UPDATE/DELETE
--   corrompe accounts.balance sin recálculo). CajaPage además exponía un
--   botón que borraba CUALQUIER movimiento (incluidos los de comprobantes)
--   sin reverso.
--
-- QUÉ CIERRA ESTA MIGRACIÓN:
--   1. account_movements: sin UPDATE/DELETE desde el cliente (grants + fin de
--      la policy ALL). INSERT/SELECT quedan idénticos (cuentasService sigue
--      funcionando).
--   2. financial_movements: sin UPDATE/DELETE desde el cliente. INSERT/SELECT
--      quedan (CajaPage/manuales siguen funcionando). Las correcciones de
--      movimientos MANUALES pasan por reverse_manual_cash_movement (reversa
--      compensatoria con motivo, solo en caja abierta — nunca se borra ni se
--      toca una caja cerrada).
--   3. comprobante_payments: sin UPDATE/DELETE desde el cliente (los flujos
--      legítimos ya pasan por RPCs SECURITY DEFINER: checkout,
--      replace_comprobante_payment, delete_comprobante_with_finance).
--   4. business_finance_entries: UPDATE/DELETE solo para asientos MANUALES
--      (source='manual' y sin vínculo a comprobante) — los generados
--      automáticamente quedan inmutables desde el cliente.
--   5. trigger_comprobante_payment_finance pasa a SECURITY DEFINER con
--      search_path fijo: era SECURITY INVOKER y hace un UPDATE sobre
--      financial_movements (rama de órdenes) que el punto 2 le revocaría al
--      usuario. NUNCA se deja una policy laxa para que un trigger invoker
--      pueda escribir — se eleva el trigger, no se abre la tabla.
--
-- LÍMITES CONOCIDOS (documentados, alcance M6/M7):
--   - Los BFE de costo históricos creados por el checkout ANTES de
--     20260702110000 tienen source='manual' sin referencia → siguen siendo
--     editables como si fueran manuales. Los nuevos ya nacen con
--     source='comprobante' + reference_comprobante_id.
--   - La corrección de BFE manuales por el flujo existente (Panel Financiero)
--     no registra motivo todavía (M6 lo canaliza por RPC).
-- ============================================================================

-- ── 5. Trigger de finanzas de pagos → SECURITY DEFINER (mismo cuerpo) ────────
-- Idéntico al baseline salvo el header: SECURITY DEFINER + search_path.
CREATE OR REPLACE FUNCTION "public"."trigger_comprobante_payment_finance"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_comp_num        TEXT;
  v_order_id        UUID;
  v_existing_income NUMERIC;
  v_caja_method     TEXT;
BEGIN
  SELECT COALESCE(number, numero, id::TEXT), order_id
  INTO v_comp_num, v_order_id
  FROM public.comprobantes WHERE id = NEW.comprobante_id;

  -- ── GUARD ANTI-DUPLICADO ──────────────────────────────────────────────────
  -- Si la orden ya tiene ingresos en financial_movements (registrados por
  -- order_payments), vinculamos el comprobante al movimiento existente.
  IF v_order_id IS NOT NULL THEN
    SELECT COALESCE(SUM(amount_ars), 0) INTO v_existing_income
    FROM public.financial_movements
    WHERE type          = 'income'
      AND reference_type = 'order'
      AND reference_id   = v_order_id
      AND business_id    = NEW.business_id;

    IF v_existing_income > 0 THEN
      UPDATE public.financial_movements
      SET comprobante_id = COALESCE(comprobante_id, NEW.comprobante_id),
          description    = description || ' → comp #' || v_comp_num
      WHERE type          = 'income'
        AND reference_type = 'order'
        AND reference_id   = v_order_id
        AND business_id    = NEW.business_id
        AND comprobante_id IS NULL;

      IF NEW.commission_amount > 0 THEN
        INSERT INTO public.business_finance_entries (
          business_id, date, type, category, description,
          amount, currency, amount_ars, exchange_rate,
          payment_method, reference_comprobante_id, source, created_by
        ) VALUES (
          NEW.business_id, NEW.date, 'variable_cost', 'comisiones_cobro',
          'Comisión ' || COALESCE(NEW.payment_provider, NEW.payment_method)
            || ' - comprobante #' || v_comp_num,
          NEW.commission_amount, 'ARS', NEW.commission_amount, 1,
          NEW.payment_method, NEW.comprobante_id, 'comprobante', NEW.created_by
        );
      END IF;

      RETURN NEW;
    END IF;
  END IF;

  -- ── MAPEAR payment_method → metodo_pago (CajaMethod) ─────────────────────
  v_caja_method := CASE
    WHEN NEW.currency        = 'USD'                                               THEN 'usd'
    WHEN NEW.payment_method  = 'efectivo'                                          THEN 'efectivo'
    WHEN NEW.payment_method  = 'transferencia'                                     THEN 'transferencia'
    WHEN NEW.payment_method IN ('tarjeta_debito','tarjeta_credito','qr',
                                'mercado_pago','otro','mixto')                     THEN 'tarjeta'
    ELSE 'efectivo'
  END;

  -- ── MOVIMIENTO DE CAJA ────────────────────────────────────────────────────
  IF NEW.payment_method != 'cuenta_corriente' THEN
    INSERT INTO public.financial_movements (
      business_id, date, type, currency, amount, exchange_rate, amount_ars,
      source, source_id, comprobante_id, description, created_by, metodo_pago
    ) VALUES (
      NEW.business_id, NEW.date, 'income',
      NEW.currency, NEW.amount, NEW.exchange_rate, NEW.amount_ars,
      'comprobante', NEW.id, NEW.comprobante_id,
      'Cobro comprobante #' || v_comp_num,
      NEW.created_by,
      v_caja_method
    );
  END IF;

  -- ── BFE INCOME ────────────────────────────────────────────────────────────
  IF NEW.payment_method != 'cuenta_corriente' THEN
    INSERT INTO public.business_finance_entries (
      business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate,
      payment_method, reference_comprobante_id, source, created_by
    ) VALUES (
      NEW.business_id, NEW.date, 'income', 'ventas_productos',
      'Cobro comprobante #' || v_comp_num,
      NEW.amount_ars, NEW.currency, NEW.amount_ars, NEW.exchange_rate,
      NEW.payment_method, NEW.comprobante_id, 'comprobante', NEW.created_by
    );
  END IF;

  -- ── COMISIÓN ──────────────────────────────────────────────────────────────
  IF NEW.commission_amount > 0 THEN
    INSERT INTO public.business_finance_entries (
      business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate,
      payment_method, reference_comprobante_id, source, created_by
    ) VALUES (
      NEW.business_id, NEW.date, 'variable_cost', 'comisiones_cobro',
      'Comisión ' || COALESCE(NEW.payment_provider, NEW.payment_method)
        || ' - comprobante #' || v_comp_num,
      NEW.commission_amount, 'ARS', NEW.commission_amount, 1,
      NEW.payment_method, NEW.comprobante_id, 'comprobante', NEW.created_by
    );
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."trigger_comprobante_payment_finance"() OWNER TO "postgres";

-- ── 1. account_movements: fin del UPDATE/DELETE directo ─────────────────────
-- La policy ALL se reemplaza por SELECT + INSERT con LA MISMA expresión
-- original (cero cambio semántico para los caminos permitidos).
DROP POLICY IF EXISTS "account_movements_plan" ON "public"."account_movements";

CREATE POLICY "account_movements_select" ON "public"."account_movements"
  FOR SELECT
  USING ((("public"."current_business_id"() = "business_id") AND "public"."is_staff"() AND "public"."business_has_feature"('currentAccounts'::"text")));

CREATE POLICY "account_movements_insert" ON "public"."account_movements"
  FOR INSERT
  WITH CHECK ((("public"."current_business_id"() = "business_id") AND "public"."is_staff"() AND "public"."business_has_feature"('currentAccounts'::"text")));

REVOKE UPDATE, DELETE ON "public"."account_movements" FROM "authenticated";
REVOKE UPDATE, DELETE ON "public"."account_movements" FROM "anon";

-- ── 2. financial_movements: fin del UPDATE/DELETE directo ───────────────────
-- Se agrega una policy de INSERT/SELECT moderna (current_user_business_id
-- cubre perfiles con user_id) ANTES de tirar fm_write, para no romper los
-- inserts legítimos existentes (CajaPage manual, triggers invoker restantes).
CREATE POLICY "fm_insert" ON "public"."financial_movements"
  FOR INSERT TO "authenticated"
  WITH CHECK (("business_id" = "public"."current_user_business_id"()));

CREATE POLICY "fm_select" ON "public"."financial_movements"
  FOR SELECT TO "authenticated"
  USING (("business_id" = "public"."current_user_business_id"()));

DROP POLICY IF EXISTS "fm_write" ON "public"."financial_movements";
DROP POLICY IF EXISTS "financial_movements_business_update" ON "public"."financial_movements";

REVOKE UPDATE, DELETE ON "public"."financial_movements" FROM "authenticated";
REVOKE UPDATE, DELETE ON "public"."financial_movements" FROM "anon";

-- ── 3. comprobante_payments: fin del UPDATE/DELETE directo ──────────────────
CREATE POLICY "cp_insert" ON "public"."comprobante_payments"
  FOR INSERT TO "authenticated"
  WITH CHECK (("business_id" = "public"."current_user_business_id"()));

DROP POLICY IF EXISTS "cp_write" ON "public"."comprobante_payments";

REVOKE UPDATE, DELETE ON "public"."comprobante_payments" FROM "authenticated";
REVOKE UPDATE, DELETE ON "public"."comprobante_payments" FROM "anon";

-- ── 4. business_finance_entries: UPDATE/DELETE solo de asientos manuales ────
-- Manual = source='manual' (default de la columna) y sin vínculo a
-- comprobante. Los asientos de triggers/RPCs llevan source
-- 'comprobante'/'expense'/'pago_proveedor'/'system' y/o referencia → quedan
-- inmutables desde el cliente.
DROP POLICY IF EXISTS "bfe_update" ON "public"."business_finance_entries";
DROP POLICY IF EXISTS "bfe_delete" ON "public"."business_finance_entries";

CREATE POLICY "bfe_update_manual" ON "public"."business_finance_entries"
  FOR UPDATE TO "authenticated"
  USING (
    "business_id" = "public"."current_user_business_id"()
    AND COALESCE("source", 'manual') = 'manual'
    AND "reference_comprobante_id" IS NULL
  )
  WITH CHECK (
    "business_id" = "public"."current_user_business_id"()
    AND COALESCE("source", 'manual') = 'manual'
    AND "reference_comprobante_id" IS NULL
  );

CREATE POLICY "bfe_delete_manual" ON "public"."business_finance_entries"
  FOR DELETE TO "authenticated"
  USING (
    "business_id" = "public"."current_user_business_id"()
    AND COALESCE("source", 'manual') = 'manual'
    AND "reference_comprobante_id" IS NULL
  );

-- ── 6. Corrección controlada de movimientos MANUALES de caja ────────────────
-- Reemplaza el DELETE libre de CajaPage: nunca se borra un movimiento — se
-- inserta la reversa compensatoria (ledger append-only), con motivo, solo
-- para movimientos manuales de la caja ABIERTA. Cajas cerradas: intocables.
CREATE OR REPLACE FUNCTION "public"."reverse_manual_cash_movement"(
  "p_movement_id" uuid,
  "p_reason"      text
) RETURNS jsonb
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user_id    uuid := auth.uid();
  v_mov        financial_movements%ROWTYPE;
  v_has_access boolean := false;
  v_caja       cajas%ROWTYPE;
  v_new_id     uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No autenticado');
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El motivo de la corrección es obligatorio');
  END IF;

  SELECT * INTO v_mov FROM financial_movements WHERE id = p_movement_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Movimiento no encontrado');
  END IF;

  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id = v_mov.business_id AND owner_user_id = v_user_id)
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id = v_mov.business_id AND user_id = v_user_id AND COALESCE(is_active, true) = true)
  ) INTO v_has_access;
  IF NOT v_has_access THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio');
  END IF;

  IF v_mov.source IS DISTINCT FROM 'manual' THEN
    RETURN jsonb_build_object('ok', false,
      'error', 'Solo se corrigen movimientos manuales. Los movimientos de comprobantes, proveedores, retiros u órdenes se revierten desde su módulo de origen.');
  END IF;
  IF v_mov.reference_type = 'manual_correction' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Una corrección no se puede volver a corregir');
  END IF;
  IF EXISTS (
    SELECT 1 FROM financial_movements
    WHERE reference_type = 'manual_correction' AND reference_id = v_mov.id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Este movimiento ya fue corregido');
  END IF;

  -- Solo dentro de la caja ABIERTA (nunca se toca una sesión cerrada).
  IF v_mov.caja_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El movimiento no pertenece a ninguna sesión de caja');
  END IF;
  SELECT * INTO v_caja FROM cajas WHERE id = v_mov.caja_id;
  IF NOT FOUND OR v_caja.status <> 'abierta' THEN
    RETURN jsonb_build_object('ok', false,
      'error', 'La caja de este movimiento ya está cerrada — las sesiones cerradas no se modifican');
  END IF;

  INSERT INTO financial_movements (
    business_id, date, type, currency, amount, amount_ars, exchange_rate,
    source, description, created_by, metodo_pago, caja_id,
    reference_type, reference_id, sign
  ) VALUES (
    v_mov.business_id, public.ar_today(),
    CASE WHEN v_mov.type = 'income' THEN 'expense' ELSE 'income' END,
    v_mov.currency, v_mov.amount, v_mov.amount_ars, COALESCE(v_mov.exchange_rate, 1),
    'manual',
    'CORRECCIÓN: ' || trim(p_reason) || ' (reversa de ' || COALESCE(v_mov.description, v_mov.id::text) || ')',
    v_user_id, v_mov.metodo_pago, v_mov.caja_id,
    'manual_correction', v_mov.id, 1
  ) RETURNING id INTO v_new_id;

  RETURN jsonb_build_object('ok', true, 'reversal_id', v_new_id);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

ALTER FUNCTION "public"."reverse_manual_cash_movement"(uuid, text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."reverse_manual_cash_movement"(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."reverse_manual_cash_movement"(uuid, text) FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."reverse_manual_cash_movement"(uuid, text) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."reverse_manual_cash_movement"(uuid, text) TO "service_role";

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado):
--   DROP FUNCTION IF EXISTS reverse_manual_cash_movement(uuid, text);
--   -- BFE: recrear bfe_update/bfe_delete originales (baseline) y dropear
--   --      bfe_update_manual / bfe_delete_manual
--   -- comprobante_payments: GRANT UPDATE, DELETE ... TO authenticated;
--   --      recrear cp_write; DROP POLICY cp_insert;
--   -- financial_movements: GRANT UPDATE, DELETE ... TO authenticated;
--   --      recrear fm_write y financial_movements_business_update;
--   --      DROP POLICY fm_insert; DROP POLICY fm_select;
--   -- account_movements: GRANT UPDATE, DELETE ... TO authenticated;
--   --      recrear account_movements_plan (ALL); DROP las select/insert
--   -- trigger_comprobante_payment_finance: recrear como SECURITY INVOKER
-- ============================================================================
