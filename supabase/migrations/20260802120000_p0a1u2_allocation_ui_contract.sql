-- ============================================================================
-- P0-A.1U2 — Contrato server-side de la UI de imputación.
--
-- DOS COSAS, ambas de seguridad:
--
-- 1. AGUJERO QUE SE CIERRA: allocate_account_payment_atomic y
--    reverse_payment_allocation_atomic validaban PERTENENCIA al negocio pero no
--    el ROL. Un `tech` o un `viewer` —que por contrato no tienen acciones
--    financieras— podían imputar y revertir llamando la RPC directamente. La UI
--    que se agrega en este lote haría el agujero trivialmente alcanzable.
--
-- 2. LECTURAS DEL MODAL: el modal necesita los cobros con crédito disponible y
--    los documentos abiertos del cliente. Ambos son IMPORTES, así que se sirven
--    por RPC con permiso, igual que en U1V, y se revoca la lectura directa de
--    v_customer_open_documents.
--
-- Capacidades (contrato de producto aprobado):
--   · imputar  -> owner, admin, manager, cashier, sales
--   · revertir -> owner, admin, manager   (una reversa deshace un hecho
--     económico ya asentado: se mantiene en los roles de administración)
-- Fail-closed: un rol nuevo queda fuera hasta agregarlo explícitamente.
--
-- ROLLBACK documentado al final.
-- ============================================================================

-- ── §1. Capacidades ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "public"."user_can_allocate_payments"(
  "p_business_id" uuid, "p_user_id" uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_business_id IS NOT NULL AND p_user_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.businesses
             WHERE id = p_business_id AND owner_user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.profiles
                WHERE business_id = p_business_id AND user_id = p_user_id
                  AND COALESCE(is_active, true) = true
                  AND role IN ('owner', 'admin', 'manager', 'cashier', 'sales'))
  );
$$;
ALTER FUNCTION "public"."user_can_allocate_payments"(uuid, uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."user_can_allocate_payments"(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."user_can_allocate_payments"(uuid, uuid) FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."user_can_allocate_payments"(uuid, uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."user_can_allocate_payments"(uuid, uuid) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."user_can_reverse_allocations"(
  "p_business_id" uuid, "p_user_id" uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_business_id IS NOT NULL AND p_user_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.businesses
             WHERE id = p_business_id AND owner_user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.profiles
                WHERE business_id = p_business_id AND user_id = p_user_id
                  AND COALESCE(is_active, true) = true
                  AND role IN ('owner', 'admin', 'manager'))
  );
$$;
ALTER FUNCTION "public"."user_can_reverse_allocations"(uuid, uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."user_can_reverse_allocations"(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."user_can_reverse_allocations"(uuid, uuid) FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."user_can_reverse_allocations"(uuid, uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."user_can_reverse_allocations"(uuid, uuid) TO "service_role";

-- ── §2. Se cierra el agujero de rol en las dos RPC de escritura ─────────────
-- Se reemplaza SOLO el bloque de autorización; el resto del cuerpo es idéntico
-- al de 20260731130000.
CREATE OR REPLACE FUNCTION "public"."allocate_account_payment_atomic"(
  "p_business_id"        uuid,
  "p_payment_movement_id" uuid,
  "p_allocations"        jsonb,
  "p_reason"             text,
  "p_idempotency_key"    text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_key      text := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_mov      public.account_movements%ROWTYPE;
  v_acc_cus  uuid;
  v_item     jsonb;
  v_ids      uuid[] := '{}';
  v_total    numeric := 0;
  v_new_id   uuid;
  v_i        integer := 0;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'UNAUTHORIZED', 'error', 'No autenticado');
  END IF;
  IF v_key IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR', 'error', 'idempotency_key requerida');
  END IF;
  IF p_allocations IS NULL OR jsonb_array_length(p_allocations) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR', 'error', 'Sin asignaciones');
  END IF;

  -- CAPACIDAD, no sólo pertenencia: tech y viewer no imputan.
  IF NOT public.user_can_allocate_payments(p_business_id, v_actor) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'FORBIDDEN',
      'error', 'Tu rol no puede imputar cobros');
  END IF;

  IF EXISTS (SELECT 1 FROM public.customer_account_payment_allocations
              WHERE business_id = p_business_id
                AND left(idempotency_key, length(v_key) + 1) = v_key || ':') THEN
    SELECT COALESCE(array_agg(id ORDER BY created_at), '{}'), COALESCE(SUM(amount), 0)
      INTO v_ids, v_total
      FROM public.customer_account_payment_allocations
     WHERE business_id = p_business_id
       AND left(idempotency_key, length(v_key) + 1) = v_key || ':'
       AND status = 'active';
    RETURN jsonb_build_object('ok', true, 'replay', true,
      'allocation_ids', to_jsonb(v_ids), 'allocated_total', v_total);
  END IF;

  SELECT * INTO v_mov FROM public.account_movements
   WHERE id = p_payment_movement_id AND business_id = p_business_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'PAYMENT_NOT_FOUND', 'error', 'Cobro no encontrado');
  END IF;
  SELECT entity_id INTO v_acc_cus FROM public.accounts WHERE id = v_mov.account_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_allocations)
  LOOP
    v_i := v_i + 1;
    INSERT INTO public.customer_account_payment_allocations (
      business_id, customer_id, account_id, payment_movement_id, comprobante_id,
      amount, currency, status, idempotency_key, reason, created_by
    ) VALUES (
      p_business_id, v_acc_cus, v_mov.account_id, p_payment_movement_id,
      (v_item->>'comprobante_id')::uuid,
      ROUND((v_item->>'amount')::numeric, 2), 'ARS', 'active',
      v_key || ':' || v_i, NULLIF(btrim(COALESCE(p_reason, '')), ''), v_actor
    ) RETURNING id INTO v_new_id;
    v_ids   := v_ids || v_new_id;
    v_total := v_total + ROUND((v_item->>'amount')::numeric, 2);
  END LOOP;

  PERFORM public.finance_log_audit(
    p_business_id, 'account_payment_allocated', 'account_movements', p_payment_movement_id,
    'allocate_account_payment_atomic', v_key, p_reason, public.ar_today(),
    'account_movement', p_payment_movement_id, NULL,
    jsonb_build_object('payment_movement_id', p_payment_movement_id,
      'allocation_ids', to_jsonb(v_ids), 'allocated_total', v_total, 'items', p_allocations));

  RETURN jsonb_build_object('ok', true, 'replay', false,
    'allocation_ids', to_jsonb(v_ids), 'allocated_total', v_total);

EXCEPTION
  WHEN sqlstate '22023' OR sqlstate '42501' OR sqlstate '23503' THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR', 'error', SQLERRM);
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'INTERNAL_ERROR',
      'error', 'No se pudo completar la imputación');
END;
$$;
ALTER FUNCTION "public"."allocate_account_payment_atomic"(uuid, uuid, jsonb, text, text) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."reverse_payment_allocation_atomic"(
  "p_business_id"     uuid,
  "p_allocation_id"   uuid,
  "p_amount"          numeric,
  "p_reason"          text,
  "p_idempotency_key" text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_key    text := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_al     public.customer_account_payment_allocations%ROWTYPE;
  v_rev    numeric;
  v_rem    numeric;
  v_new    uuid;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'UNAUTHORIZED', 'error', 'No autenticado');
  END IF;
  IF v_key IS NULL OR v_reason IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
      'error', 'idempotency_key y motivo son obligatorios');
  END IF;

  -- Revertir es más restrictivo que imputar: deshace un hecho ya asentado.
  IF NOT public.user_can_reverse_allocations(p_business_id, v_actor) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'FORBIDDEN',
      'error', 'Tu rol no puede revertir imputaciones');
  END IF;

  IF EXISTS (SELECT 1 FROM public.customer_account_payment_allocations
              WHERE business_id = p_business_id AND idempotency_key = v_key) THEN
    RETURN jsonb_build_object('ok', true, 'replay', true);
  END IF;

  SELECT * INTO v_al FROM public.customer_account_payment_allocations
   WHERE id = p_allocation_id AND business_id = p_business_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'ALLOCATION_NOT_FOUND', 'error', 'Imputación no encontrada');
  END IF;
  IF v_al.status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'ALREADY_REVERSED', 'error', 'La imputación ya fue revertida');
  END IF;

  v_rev := COALESCE(ROUND(p_amount, 2), v_al.amount);
  IF v_rev <= 0 OR v_rev > v_al.amount + 0.01 THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
      'error', 'El importe a revertir debe estar entre 0 y el importe imputado');
  END IF;

  UPDATE public.customer_account_payment_allocations
     SET status = 'reversed', reversed_at = now()
   WHERE id = v_al.id;

  v_rem := ROUND(v_al.amount - v_rev, 2);
  IF v_rem > 0 THEN
    INSERT INTO public.customer_account_payment_allocations (
      business_id, customer_id, account_id, payment_movement_id, comprobante_id,
      amount, currency, status, idempotency_key, reason, reversal_of, created_by
    ) VALUES (
      v_al.business_id, v_al.customer_id, v_al.account_id, v_al.payment_movement_id,
      v_al.comprobante_id, v_rem, 'ARS', 'active', v_key || ':rem',
      'Remanente tras reversa parcial', v_al.id, v_actor
    ) RETURNING id INTO v_new;
  END IF;

  INSERT INTO public.customer_account_payment_allocations (
    business_id, customer_id, account_id, payment_movement_id, comprobante_id,
    amount, currency, status, idempotency_key, reason, reversal_of, reversed_at, created_by
  ) VALUES (
    v_al.business_id, v_al.customer_id, v_al.account_id, v_al.payment_movement_id,
    v_al.comprobante_id, v_rev, 'ARS', 'reversed', v_key, v_reason, v_al.id, now(), v_actor);

  PERFORM public.finance_log_audit(
    p_business_id, 'account_payment_allocation_reversed', 'customer_account_payment_allocations',
    v_al.id, 'reverse_payment_allocation_atomic', v_key, v_reason, public.ar_today(),
    'allocation', v_al.id, NULL,
    jsonb_build_object('allocation_id', v_al.id, 'comprobante_id', v_al.comprobante_id,
      'reversed_amount', v_rev, 'remaining_allocation_id', v_new, 'remaining_amount', v_rem));

  PERFORM public.recompute_order_payment_status(
    (SELECT order_id FROM public.comprobantes WHERE id = v_al.comprobante_id));

  RETURN jsonb_build_object('ok', true, 'replay', false,
    'reversed_amount', v_rev, 'remaining_amount', v_rem, 'remaining_allocation_id', v_new);

EXCEPTION
  WHEN sqlstate '22023' OR sqlstate '42501' OR sqlstate '0A000' THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR', 'error', SQLERRM);
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'INTERNAL_ERROR',
      'error', 'No se pudo completar la reversa');
END;
$$;
ALTER FUNCTION "public"."reverse_payment_allocation_atomic"(uuid, uuid, numeric, text, text) OWNER TO "postgres";

-- ── §3. Datos del modal: créditos y documentos, con permiso ────────────────
-- v_customer_open_documents expone saldos: se cierra la lectura directa, igual
-- que se hizo con v_order_financial_status en U1V.
REVOKE SELECT ON "public"."v_customer_open_documents" FROM "authenticated";

CREATE OR REPLACE FUNCTION "public"."get_allocation_workspace"(
  "p_business_id" uuid, "p_customer_id" uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_creditos jsonb;
  v_docs jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'UNAUTHORIZED');
  END IF;
  -- Ver el workspace ya es ver importes.
  IF NOT public.user_can_view_order_amounts(p_business_id, v_actor) THEN
    RETURN jsonb_build_object('ok', true, 'authorized', false);
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.payment_date DESC), '[]'::jsonb) INTO v_creditos
  FROM (
    SELECT u.payment_movement_id, u.payment_date, u.payment_amount,
           u.allocated_amount, u.unallocated_amount
    FROM public.v_customer_unallocated_credit u
    WHERE u.business_id = p_business_id AND u.customer_id = p_customer_id
      AND u.unallocated_amount > 0.01
  ) c;

  SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.fecha), '[]'::jsonb) INTO v_docs
  FROM (
    SELECT o.comprobante_id, o.numero, o.order_id, o.fecha, o.total,
           o.saldo_documento, o.imputado, o.saldo_imputable
    FROM public.v_customer_open_documents o
    WHERE o.business_id = p_business_id AND o.customer_id = p_customer_id
  ) d;

  RETURN jsonb_build_object(
    'ok', true, 'authorized', true,
    'can_allocate', public.user_can_allocate_payments(p_business_id, v_actor),
    'can_reverse',  public.user_can_reverse_allocations(p_business_id, v_actor),
    'credits', v_creditos, 'documents', v_docs);
END;
$$;
ALTER FUNCTION "public"."get_allocation_workspace"(uuid, uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."get_allocation_workspace"(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."get_allocation_workspace"(uuid, uuid) FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."get_allocation_workspace"(uuid, uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."get_allocation_workspace"(uuid, uuid) TO "service_role";

-- ── §4. Historial de imputaciones (§7) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION "public"."get_payment_allocations"(
  "p_business_id" uuid, "p_comprobante_id" uuid, "p_payment_movement_id" uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'UNAUTHORIZED');
  END IF;
  IF NOT public.user_can_view_order_amounts(p_business_id, v_actor) THEN
    RETURN jsonb_build_object('ok', true, 'authorized', false);
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT a.id, a.amount, a.status, a.created_at, a.reversed_at, a.reason,
           a.comprobante_id, a.payment_movement_id, a.reversal_of,
           c.order_id,
           COALESCE(c.numero_fiscal, c.numero, c.number) AS comprobante_numero,
           COALESCE(p.full_name, p.email) AS operador
    FROM public.customer_account_payment_allocations a
    JOIN public.comprobantes c ON c.id = a.comprobante_id
    LEFT JOIN public.profiles p ON p.user_id = a.created_by AND p.business_id = a.business_id
    WHERE a.business_id = p_business_id
      AND (p_comprobante_id IS NULL OR a.comprobante_id = p_comprobante_id)
      AND (p_payment_movement_id IS NULL OR a.payment_movement_id = p_payment_movement_id)
  ) x;

  RETURN jsonb_build_object('ok', true, 'authorized', true,
    'can_reverse', public.user_can_reverse_allocations(p_business_id, v_actor),
    'rows', v_rows);
END;
$$;
ALTER FUNCTION "public"."get_payment_allocations"(uuid, uuid, uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."get_payment_allocations"(uuid, uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."get_payment_allocations"(uuid, uuid, uuid) FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."get_payment_allocations"(uuid, uuid, uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."get_payment_allocations"(uuid, uuid, uuid) TO "service_role";

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado):
--   GRANT SELECT ON v_customer_open_documents TO authenticated;
--   DROP FUNCTION get_payment_allocations(uuid, uuid, uuid);
--   DROP FUNCTION get_allocation_workspace(uuid, uuid);
--   Recrear allocate_account_payment_atomic y reverse_payment_allocation_atomic
--     con las definiciones de 20260731130000 (sin el check de capacidad);
--   DROP FUNCTION user_can_reverse_allocations(uuid, uuid);
--   DROP FUNCTION user_can_allocate_payments(uuid, uuid);
-- ============================================================================
