-- ============================================================================
-- M1 — finance_hardening_base (Etapa 0, auditoría finanzas 2026-07-02)
--
-- Cierra los riesgos de base SIN cambiar el modelo contable (eso es M3+):
--   1. ar_today(): fecha oficial Argentina para RPCs financieras (los
--      CURRENT_DATE en UTC corren ventas nocturnas al día siguiente — 8 pagos
--      reales ya corridos, ver docs/auditoria-finanzas/06-seguridad-calidad.md).
--   2. create_owner_withdrawal: cierra el cross-tenant write (P0-8 — la RPC
--      aceptaba cualquier business_id) + corrige la actualización de saldos
--      personales multi-moneda (personal_account_balances quedaba divergente
--      de personal_accounts.current_balance).
--   3. SET search_path en las RPC SECURITY DEFINER de proveedores que no lo
--      fijaban (hardening clásico de search-path hijacking; sin cambio de
--      comportamiento — el doble costo contable de estas RPC es alcance M3).
--   4. Caja abierta única por negocio (índice único parcial). Sin esto, dos
--      pestañas pueden abrir dos cajas y trigger_set_movement_caja reparte
--      movimientos entre ambas.
--   5. Numeración local: SIN CAMBIOS — ya resuelta por 20260701180000
--      (comprobante_number_sequences + UNIQUE parcial (business_id, tipo,
--      numero_secuencial)). La serie local real es (business_id, tipo);
--      punto_venta es solo formato de presentación. NO se agrega un UNIQUE
--      sobre `numero` crudo: los históricos tienen formatos mixtos
--      ('NNNN-NNNNNNNN' y enteros planos) y un constraint sobre ese campo
--      podría bloquear series legítimas. Documentado en
--      docs/auditoria-finanzas/etapa0/DIAGNOSTICO.md §8.7.
--   6. Índices: solo UNO nuevo (BFE por reference_comprobante_id, que la
--      nueva RPC de anulación consulta). FM(comprobante_id), account_movements
--      (reference_id) y comprobante_payments(comprobante_id) YA tienen índice
--      en el baseline (idx_financial_movements_comprobante, idx_acctmov_ref,
--      cp_comprobante_idx) — no se duplican.
-- ============================================================================

-- ── 1. Fecha oficial Argentina ───────────────────────────────────────────────
-- STABLE (no IMMUTABLE: depende de now()). Único punto de verdad para "hoy"
-- en RPCs financieras. El corte de día es 00:00 de América/Argentina/Córdoba
-- (UTC-3, sin DST vigente).
CREATE OR REPLACE FUNCTION "public"."ar_today"() RETURNS date
    LANGUAGE "sql" STABLE
    AS $$
  SELECT (now() AT TIME ZONE 'America/Argentina/Cordoba')::date
$$;

COMMENT ON FUNCTION "public"."ar_today"() IS
  'Día calendario argentino (America/Argentina/Cordoba). Usar en TODA fecha '
  'financiera server-side en lugar de CURRENT_DATE (que es UTC: una venta de '
  'las 21:30 de Córdoba caía en el día siguiente).';

ALTER FUNCTION "public"."ar_today"() OWNER TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."ar_today"() TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."ar_today"() TO "service_role";

-- ── 2. create_owner_withdrawal — ownership + rol + multi-moneda ─────────────
-- Misma firma (el frontend no cambia). Diferencias con la versión anterior:
--   a. Valida que auth.uid() pertenezca al negocio p_business_id con rol
--      autorizado (dueño real del negocio, o perfil owner/admin activo).
--      Antes: CUALQUIER usuario autenticado podía insertar egresos de caja
--      en cualquier negocio (cross-tenant write, P0-8).
--   b. La cuenta personal se bloquea (FOR UPDATE) y debe pertenecer al
--      usuario autenticado y estar activa (ya se validaba; se conserva).
--   c. La cuenta debe operar en ARS (fila ARS en personal_account_balances o
--      moneda primaria ARS). El retiro es SIEMPRE ARS — no se inventa
--      conversión (regla de la auditoría de monedas).
--   d. El saldo se actualiza vía personal_update_currency_balance(), que
--      mantiene sincronizados personal_account_balances (fuente multi-moneda)
--      y personal_accounts.current_balance (legacy). Antes solo se tocaba el
--      legacy y Mi Guita no veía el ingreso.
--   e. Fecha default = ar_today() si p_date viene NULL.
--   f. financial_movements.movement_type: la versión anterior escribía
--      'income' (metadato contradictorio con type='expense'). El CHECK de la
--      columna solo admite income/fee/refund/chargeback/adjustment (dominio
--      de payment_transactions) — un retiro no es ninguno de esos: se deja
--      NULL, como los movimientos de checkout.
-- Sin BFE: el retiro NO es gasto operativo (regla ratificada por la
-- auditoría) — afecta caja y patrimonio, no P&L.
CREATE OR REPLACE FUNCTION "public"."create_owner_withdrawal"("p_business_id" "uuid", "p_amount" numeric, "p_date" "date", "p_account_id" "uuid", "p_notes" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user_id       uuid := auth.uid();
  v_date          date := COALESCE(p_date, public.ar_today());
  v_is_authorized boolean := false;
  v_acc           personal_accounts%ROWTYPE;
  v_has_ars_row   boolean := false;
  v_tx_id         uuid;
  v_fm_id         uuid;
  v_wd_id         uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No autenticado');
  END IF;
  IF p_amount IS NULL OR p_amount::text IN ('NaN', 'Infinity', '-Infinity') OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El monto debe ser mayor a cero');
  END IF;

  -- Ownership + rol: dueño del negocio, o perfil owner/admin activo del
  -- negocio. NUNCA se confía en p_business_id "porque el cliente lo mandó".
  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id = p_business_id AND owner_user_id = v_user_id)
    OR EXISTS (
      SELECT 1 FROM profiles
      WHERE business_id = p_business_id
        AND COALESCE(user_id, id) = v_user_id
        AND COALESCE(is_active, true) = true
        AND role IN ('owner', 'admin')
    )
  ) INTO v_is_authorized;
  IF NOT v_is_authorized THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sin permiso para registrar retiros en este negocio');
  END IF;

  -- Cuenta personal del PROPIO usuario, activa. FOR UPDATE: serializa dos
  -- retiros concurrentes hacia la misma cuenta.
  SELECT * INTO v_acc
  FROM personal_accounts
  WHERE id = p_account_id AND user_id = v_user_id AND is_active = true
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Cuenta personal no encontrada o no activa');
  END IF;

  -- La operación es en ARS: la cuenta debe soportar ARS (fila multi-moneda o
  -- moneda primaria). No se convierte a otra moneda implícitamente.
  SELECT EXISTS (
    SELECT 1 FROM personal_account_balances
    WHERE account_id = p_account_id AND user_id = v_user_id AND currency = 'ARS'
  ) INTO v_has_ars_row;
  IF NOT v_has_ars_row AND COALESCE(v_acc.currency, 'ARS') <> 'ARS' THEN
    RETURN jsonb_build_object('ok', false, 'error',
      'La cuenta destino no opera en ARS. Agregá ARS a la cuenta o elegí otra.');
  END IF;

  -- 1. Pata personal (ingreso)
  INSERT INTO personal_transactions (
    user_id, account_id, type, amount, currency, date, description, notes
  ) VALUES (
    v_user_id, p_account_id, 'income', p_amount, 'ARS',
    v_date, 'Retiro del negocio', p_notes
  ) RETURNING id INTO v_tx_id;

  -- 2. Saldo personal: fuente canónica multi-moneda + legacy sincronizado.
  PERFORM personal_update_currency_balance(p_account_id, 'ARS', p_amount);

  -- 3. Pata negocio (egreso de caja; caja la asigna trigger_set_movement_caja)
  INSERT INTO financial_movements (
    business_id, type, amount, amount_ars, currency, exchange_rate,
    source, source_id, description, date, created_by,
    reference_type, sign, movement_type
  ) VALUES (
    p_business_id, 'expense', p_amount, p_amount, 'ARS', 1,
    'owner_withdrawal', NULL,
    'Retiro propietario' || CASE WHEN p_notes IS NOT NULL THEN ': ' || p_notes ELSE '' END,
    v_date, v_user_id,
    -- movement_type NULL EXPLÍCITO: la columna tiene DEFAULT 'income' (dominio
    -- payment_transactions) y un retiro no es ninguno de sus valores.
    'owner_withdrawal', 1, NULL
  ) RETURNING id INTO v_fm_id;

  -- 4. Vínculo auditable de las dos patas
  INSERT INTO owner_withdrawals (
    business_id, user_id, amount, currency, date,
    business_financial_movement_id, personal_transaction_id,
    destination_account_id, notes, status
  ) VALUES (
    p_business_id, v_user_id, p_amount, 'ARS', v_date,
    v_fm_id, v_tx_id, p_account_id, p_notes, 'completed'
  ) RETURNING id INTO v_wd_id;

  UPDATE financial_movements SET source_id = v_wd_id WHERE id = v_fm_id;

  RETURN jsonb_build_object(
    'ok', true,
    'withdrawal_id', v_wd_id,
    'personal_tx_id', v_tx_id,
    'business_fm_id', v_fm_id
  );

EXCEPTION WHEN OTHERS THEN
  -- Transacción completa revertida por Postgres.
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

ALTER FUNCTION "public"."create_owner_withdrawal"("uuid", numeric, "date", "uuid", "text") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."create_owner_withdrawal"("uuid", numeric, "date", "uuid", "text") FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."create_owner_withdrawal"("uuid", numeric, "date", "uuid", "text") FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."create_owner_withdrawal"("uuid", numeric, "date", "uuid", "text") TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."create_owner_withdrawal"("uuid", numeric, "date", "uuid", "text") TO "service_role";

-- ── 3. search_path en RPCs proveedor (solo hardening, sin cambio contable) ──
ALTER FUNCTION "public"."create_supplier_purchase_atomic"("uuid", "uuid", "uuid", "text", "date", "text", numeric, numeric, "text", "text", "jsonb")
  SET "search_path" TO 'public';
ALTER FUNCTION "public"."pay_supplier_purchase_atomic"("uuid", "uuid", "uuid", "text", "uuid", "date", numeric, "text", "text")
  SET "search_path" TO 'public';

-- ── 4. Caja abierta única por negocio ────────────────────────────────────────
-- Pre-check: si ya existieran dos cajas abiertas para el mismo negocio, la
-- migración FALLA con detalle (decisión humana requerida — NUNCA se cierran
-- cajas automáticamente).
DO $$
DECLARE
  v_dup record;
BEGIN
  SELECT business_id, count(*) AS n INTO v_dup
  FROM public.cajas
  WHERE status = 'abierta'
  GROUP BY business_id
  HAVING count(*) > 1
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'finance_hardening_base: el negocio % tiene % cajas abiertas simultáneas. '
      'Cerrá manualmente las duplicadas antes de aplicar esta migración '
      '(no se cierran cajas automáticamente).',
      v_dup.business_id, v_dup.n;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_cajas_unica_abierta_por_negocio"
  ON "public"."cajas" ("business_id")
  WHERE "status" = 'abierta';

COMMENT ON INDEX "public"."idx_cajas_unica_abierta_por_negocio" IS
  'Máximo UNA caja abierta por negocio. El índice único parcial ES el lock '
  '(mismo patrón que arca_emission_attempts): dos aperturas concurrentes → '
  'la segunda recibe unique_violation.';

-- ── 6. Índice nuevo (único justificado por esta etapa) ──────────────────────
-- annul_comprobante_atomic (migración 20260702120000) busca los BFE a
-- espejar por reference_comprobante_id; hoy esa columna no tiene índice.
CREATE INDEX IF NOT EXISTS "idx_bfe_reference_comprobante"
  ON "public"."business_finance_entries" ("reference_comprobante_id")
  WHERE "reference_comprobante_id" IS NOT NULL;

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado):
--   DROP INDEX IF EXISTS idx_bfe_reference_comprobante;
--   DROP INDEX IF EXISTS idx_cajas_unica_abierta_por_negocio;
--   ALTER FUNCTION create_supplier_purchase_atomic(...) RESET search_path;
--   ALTER FUNCTION pay_supplier_purchase_atomic(...) RESET search_path;
--   CREATE OR REPLACE FUNCTION create_owner_withdrawal(...) -- versión baseline 20260628190324
--   DROP FUNCTION IF EXISTS ar_today();
-- ============================================================================
