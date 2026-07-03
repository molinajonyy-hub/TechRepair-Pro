-- ============================================================================
-- Etapa 0 — delete_comprobante_with_finance: política transitoria segura.
--
-- La versión anterior borraba pagos/FM/BFE/ítems y el comprobante, pero NO
-- reponía stock ni revertía cuenta corriente (P0-6): borrar cualquiera de los
-- 72 borradores con stock descontado destruía ese stock para siempre, y
-- borrar una venta en CC dejaba al cliente debiendo una venta inexistente.
--
-- NUEVA POLÍTICA (transitoria hasta M6): solo se puede borrar un borrador
-- REALMENTE VACÍO — sin stock procesado, sin pagos, sin movimientos de caja,
-- sin asientos financieros, sin cuenta corriente, sin emisión fiscal, sin
-- nota de crédito asociada y sin checkout request completada (borrar un
-- comprobante creado por el checkout idempotente rompería el replay:
-- 'existing' devolvería un comprobante_id inexistente). Todo lo demás se
-- rechaza con el motivo exacto y la recomendación de ANULAR (flujo
-- annul_comprobante_atomic) o generar NC si es fiscal.
--
-- Misma firma — el frontend existente (comprobanteService.eliminar) sigue
-- funcionando y muestra el nuevo mensaje.
-- ============================================================================

CREATE OR REPLACE FUNCTION "public"."delete_comprobante_with_finance"("p_comprobante_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_comp        comprobantes%ROWTYPE;
  v_has_access  boolean := false;
  v_blockers    text[] := '{}';
  v_del_items   integer := 0;
BEGIN
  -- ── 1. Obtener y bloquear el comprobante ───────────────────────────────────
  SELECT * INTO v_comp FROM comprobantes WHERE id = p_comprobante_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Comprobante no encontrado');
  END IF;

  -- ── 2. Acceso al negocio ───────────────────────────────────────────────────
  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id = v_comp.business_id AND owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id = v_comp.business_id AND user_id = auth.uid())
  ) INTO v_has_access;
  IF NOT v_has_access THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a este negocio');
  END IF;

  -- ── 3. Fiscal: mismo bloqueo (y flag) que la versión anterior ──────────────
  IF v_comp.estado_fiscal = 'emitido' OR v_comp.cae IS NOT NULL OR v_comp.numero_fiscal IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', false, 'arca_blocked', true,
      'error', 'Este comprobante ya fue emitido fiscalmente. Para anularlo, generá una Nota de Crédito.'
    );
  END IF;

  -- ── 4. Solo borradores inocuos: recolectar TODOS los bloqueos ──────────────
  -- array_append (NUNCA `text[] || text`: Postgres resuelve ese operador como
  -- concatenación de arrays e intenta parsear el string como array literal).
  IF NOT (v_comp.estado = 'borrador' OR v_comp.status = 'draft') THEN
    v_blockers := array_append(v_blockers, 'no es un borrador (estado: ' || COALESCE(v_comp.estado, v_comp.status, '?') || ')');
  END IF;
  IF EXISTS (SELECT 1 FROM comprobante_items WHERE comprobante_id = v_comp.id AND stock_processed = true) THEN
    v_blockers := array_append(v_blockers, 'tiene stock ya descontado');
  END IF;
  IF EXISTS (SELECT 1 FROM comprobante_payments WHERE comprobante_id = v_comp.id) THEN
    v_blockers := array_append(v_blockers, 'tiene pagos registrados');
  END IF;
  IF EXISTS (SELECT 1 FROM financial_movements WHERE comprobante_id = v_comp.id AND business_id = v_comp.business_id) THEN
    v_blockers := array_append(v_blockers, 'tiene movimientos de caja');
  END IF;
  IF EXISTS (SELECT 1 FROM business_finance_entries WHERE reference_comprobante_id = v_comp.id AND business_id = v_comp.business_id) THEN
    v_blockers := array_append(v_blockers, 'tiene asientos financieros');
  END IF;
  IF EXISTS (
    SELECT 1 FROM account_movements
    WHERE business_id = v_comp.business_id
      AND reference_type = 'comprobante' AND reference_id = v_comp.id
  ) THEN
    v_blockers := array_append(v_blockers, 'tiene movimientos de cuenta corriente');
  END IF;
  IF EXISTS (SELECT 1 FROM comprobantes WHERE comprobante_original_id = v_comp.id) THEN
    v_blockers := array_append(v_blockers, 'tiene una nota de crédito asociada');
  END IF;
  IF EXISTS (
    SELECT 1 FROM comprobante_checkout_requests
    WHERE comprobante_id = v_comp.id AND status = 'completed'
  ) THEN
    -- Borrarlo rompería el replay idempotente del checkout (la request
    -- devolvería un comprobante_id inexistente en un reintento).
    v_blockers := array_append(v_blockers, 'fue creado por un checkout confirmado');
  END IF;

  IF array_length(v_blockers, 1) IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'blocked', true,
      'reasons', to_jsonb(v_blockers),
      'error',
        'No se puede eliminar: ' || array_to_string(v_blockers, '; ')
        || '. Usá la anulación (revierte caja, cuenta corriente y stock de forma controlada)'
        || CASE WHEN v_comp.es_fiscal THEN ' o generá una Nota de Crédito si corresponde.' ELSE '.' END
    );
  END IF;

  -- ── 5. Borrador vacío: borrar ítems (sin efectos) y el comprobante ─────────
  DELETE FROM comprobante_items WHERE comprobante_id = v_comp.id;
  GET DIAGNOSTICS v_del_items = ROW_COUNT;

  DELETE FROM comprobantes WHERE id = v_comp.id AND business_id = v_comp.business_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'No se pudo eliminar el comprobante');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'deleted', jsonb_build_object(
      'items', v_del_items,
      'financial_movements', 0,
      'financial_movements_unlinked', 0,
      'business_finance_entries', 0,
      'payments', 0
    )
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

ALTER FUNCTION "public"."delete_comprobante_with_finance"("uuid") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."delete_comprobante_with_finance"("uuid") FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."delete_comprobante_with_finance"("uuid") FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."delete_comprobante_with_finance"("uuid") TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."delete_comprobante_with_finance"("uuid") TO "service_role";

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado):
--   CREATE OR REPLACE FUNCTION delete_comprobante_with_finance(uuid)
--     -- volver a la versión del baseline 20260628190324 (borrado con limpieza
--     -- financiera pero SIN reposición de stock/CC — el motivo de este guard)
-- ============================================================================
