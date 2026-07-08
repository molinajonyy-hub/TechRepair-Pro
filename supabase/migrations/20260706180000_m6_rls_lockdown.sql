-- ============================================================================
-- M6 (Fase 9) — RLS/grants lockdown final + cierre de INSERT client-side
--
-- Cierra los últimos dos writes directos client-side a tablas canónicas
-- migrándolos a RPC atómica SECURITY DEFINER:
--   (1) movimiento manual de caja (CajaPage) -> create_manual_cash_movement_atomic
--   (2) pago libre a proveedor (suppliersService) -> pay_supplier_free_atomic
-- Con eso, financial_movements y business_finance_entries quedan SIN INSERT
-- client-side -> se dropean sus policies INSERT (solo triggers/RPCs escriben).
--
-- Además endurece RLS en las tablas económicas: bloquea UPDATE/DELETE por defecto
-- (dropeando policies heredadas ALL/manual que ya no usa ninguna UI viva) y
-- reemplaza la policy ALL de cajas por SELECT (open/close/movimientos van por RPC).
--
-- EXCEPCIONES temporales documentadas (INSERT directo permitido, acotado por
-- business_id, sin UPDATE/DELETE): comprobante_payments (registrarPago inicial,
-- POS/checkout — no arriesgar) y account_movements (CC manual pago/deuda/ajuste;
-- ledger aislado, sin impacto FM/BFE/caja). Ver docs/.../m6/rls-lockdown.md.
--
-- Reglas: toda RPC valida auth.uid() + pertenencia al business; SECURITY DEFINER
-- con SET search_path=public; correcciones append-only; caja cerrada inmutable.
-- No se debilita ninguna RLS existente ni se crea policy ALL TO authenticated.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- (1) create_manual_cash_movement_atomic — reemplaza el INSERT directo de
--     financial_movements en CajaPage.handleAddMovement. Resuelve la caja ABIERTA
--     server-side (ignora caja_id del cliente, evitando escribir a caja stale/cerrada).
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "public"."manual_cash_movement_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id" uuid NOT NULL REFERENCES "public"."businesses"("id"),
  "user_id" uuid, "idempotency_key" text NOT NULL, "request_hash" text NOT NULL,
  "financial_movement_id" uuid, "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "manual_cash_movement_requests_key_uniq" UNIQUE ("business_id","idempotency_key")
);
ALTER TABLE "public"."manual_cash_movement_requests" ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='manual_cash_movement_requests' AND policyname='mcm_req_select') THEN
    CREATE POLICY "mcm_req_select" ON "public"."manual_cash_movement_requests" FOR SELECT USING (
      EXISTS (SELECT 1 FROM businesses WHERE id=manual_cash_movement_requests.business_id AND owner_user_id=auth.uid())
      OR EXISTS (SELECT 1 FROM profiles WHERE business_id=manual_cash_movement_requests.business_id AND user_id=auth.uid()));
  END IF;
END $$;
GRANT SELECT ON "public"."manual_cash_movement_requests" TO "authenticated";

CREATE OR REPLACE FUNCTION "public"."create_manual_cash_movement_atomic"(
  p_business_id uuid, p_type text, p_method text, p_amount numeric,
  p_description text, p_user_id uuid, p_exchange_rate numeric DEFAULT 1,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_user uuid := auth.uid(); v_access boolean := false; v_caja uuid;
  v_key text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), ''); v_hash text;
  v_existing manual_cash_movement_requests%ROWTYPE;
  v_currency text := CASE WHEN p_method='usd' THEN 'USD' ELSE 'ARS' END;
  v_rate numeric := CASE WHEN p_method='usd' THEN COALESCE(NULLIF(p_exchange_rate,0),1) ELSE 1 END;
  v_amount_ars numeric; v_fm uuid;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'No autenticado'); END IF;
  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND user_id=v_user AND COALESCE(is_active,true))) INTO v_access;
  IF NOT v_access THEN RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio'); END IF;
  IF p_type NOT IN ('income','expense') THEN RETURN jsonb_build_object('ok', false, 'error', 'Tipo inválido (income|expense)'); END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'El monto debe ser mayor a 0'); END IF;

  SELECT id INTO v_caja FROM cajas WHERE business_id=p_business_id AND status='abierta' ORDER BY opened_at DESC LIMIT 1;
  IF v_caja IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'No hay caja abierta para registrar el movimiento'); END IF;

  v_amount_ars := round(p_amount * v_rate, 2);

  IF v_key IS NOT NULL THEN
    v_hash := encode(extensions.digest('mcm§'||p_business_id::text||'§'||p_type||'§'||p_method||'§'||round(v_amount_ars,2)::text, 'sha256'), 'hex');
    SELECT * INTO v_existing FROM manual_cash_movement_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'financial_movement_id', v_existing.financial_movement_id);
    END IF;
  END IF;

  INSERT INTO financial_movements (business_id, caja_id, date, type, currency, amount, exchange_rate,
    amount_ars, source, description, created_by, metodo_pago)
  VALUES (p_business_id, v_caja, public.ar_today(), p_type, v_currency, p_amount, v_rate,
    v_amount_ars, 'manual', NULLIF(btrim(COALESCE(p_description,'')),''), p_user_id, p_method)
  RETURNING id INTO v_fm;

  IF v_key IS NOT NULL THEN
    INSERT INTO manual_cash_movement_requests (business_id, user_id, idempotency_key, request_hash, financial_movement_id)
      VALUES (p_business_id, v_user, v_key, v_hash, v_fm);
  END IF;

  RETURN jsonb_build_object('ok', true, 'replay', false, 'financial_movement_id', v_fm);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;
ALTER FUNCTION "public"."create_manual_cash_movement_atomic"(uuid,text,text,numeric,text,uuid,numeric,text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."create_manual_cash_movement_atomic"(uuid,text,text,numeric,text,uuid,numeric,text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."create_manual_cash_movement_atomic"(uuid,text,text,numeric,text,uuid,numeric,text) TO "authenticated","service_role";

-- ────────────────────────────────────────────────────────────────────────────
-- (2) pay_supplier_free_atomic — reemplaza el INSERT directo (pago libre sin
--     factura) de suppliersService.createPayment + _recordPaymentInternal.
--     Replica EXACTAMENTE los mismos asientos (supplier_payment + account_movement
--     'payment' + BFE variable_cost/compras_proveedor + FM expense/pago_proveedor
--     si el método es cash-like) — sin cambiar el modelo canónico. Mejora: ahora
--     es atómico (antes, si el FM fallaba, quedaba supplier_payment huérfano).
--     NOTA: se preserva el comportamiento previo de NO setear metodo_pago en el FM.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "public"."supplier_free_payment_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id" uuid NOT NULL REFERENCES "public"."businesses"("id"),
  "user_id" uuid, "idempotency_key" text NOT NULL, "request_hash" text NOT NULL,
  "supplier_payment_id" uuid, "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "supplier_free_payment_requests_key_uniq" UNIQUE ("business_id","idempotency_key")
);
ALTER TABLE "public"."supplier_free_payment_requests" ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='supplier_free_payment_requests' AND policyname='sfp_req_select') THEN
    CREATE POLICY "sfp_req_select" ON "public"."supplier_free_payment_requests" FOR SELECT USING (
      EXISTS (SELECT 1 FROM businesses WHERE id=supplier_free_payment_requests.business_id AND owner_user_id=auth.uid())
      OR EXISTS (SELECT 1 FROM profiles WHERE business_id=supplier_free_payment_requests.business_id AND user_id=auth.uid()));
  END IF;
END $$;
GRANT SELECT ON "public"."supplier_free_payment_requests" TO "authenticated";

CREATE OR REPLACE FUNCTION "public"."pay_supplier_free_atomic"(
  p_business_id uuid, p_supplier_id uuid, p_user_id uuid, p_supplier_name text,
  p_payment_date date, p_amount numeric, p_payment_method text, p_notes text,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_user uuid := auth.uid(); v_access boolean := false;
  v_key text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), ''); v_hash text;
  v_existing supplier_free_payment_requests%ROWTYPE;
  v_notes text := NULLIF(btrim(COALESCE(p_notes,'')), ''); v_desc text; v_pay uuid;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'No autenticado'); END IF;
  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND user_id=v_user AND COALESCE(is_active,true))) INTO v_access;
  IF NOT v_access THEN RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio'); END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'El monto debe ser mayor a 0'); END IF;
  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE id=p_supplier_id AND business_id=p_business_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Proveedor no encontrado'); END IF;

  v_desc := 'Pago a '||COALESCE(p_supplier_name,'')||CASE WHEN v_notes IS NOT NULL THEN ' — '||v_notes ELSE '' END;

  IF v_key IS NOT NULL THEN
    v_hash := encode(extensions.digest('sfp§'||p_business_id::text||'§'||p_supplier_id::text||'§'||round(COALESCE(p_amount,0),2)::text||'§'||COALESCE(p_payment_method,'')||'§'||COALESCE(p_payment_date::text,''), 'sha256'), 'hex');
    SELECT * INTO v_existing FROM supplier_free_payment_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'payment_id', v_existing.supplier_payment_id);
    END IF;
  END IF;

  -- 1. supplier_payments (pago libre, sin factura vinculada)
  INSERT INTO supplier_payments (business_id, supplier_id, purchase_id, payment_date, amount, payment_method, notes, created_by)
    VALUES (p_business_id, p_supplier_id, NULL, p_payment_date, p_amount, p_payment_method, v_notes, p_user_id)
    RETURNING id INTO v_pay;

  -- 2. supplier_account_movements ('payment', credit=amount) — balance_after via trigger
  INSERT INTO supplier_account_movements (business_id, supplier_id, purchase_id, payment_id, movement_date, type, description, debit, credit)
    VALUES (p_business_id, p_supplier_id, NULL, v_pay, p_payment_date, 'payment', v_desc, 0, p_amount);

  -- 3. BFE variable_cost/compras_proveedor — economic_class la asigna trg_set_bfe_economic_class
  INSERT INTO business_finance_entries (business_id, date, type, category, description, amount, currency, amount_ars, exchange_rate, created_by)
    VALUES (p_business_id, p_payment_date, 'variable_cost', 'compras_proveedor', v_desc||' ('||COALESCE(p_supplier_name,'')||')', p_amount, 'ARS', p_amount, 1, p_user_id);

  -- 4. FM expense sólo si el método impacta caja (comportamiento previo idéntico;
  --    caja_id NULL -> trigger_set_movement_caja asigna la caja abierta si existe).
  IF p_payment_method IN ('efectivo','transferencia','tarjeta') THEN
    INSERT INTO financial_movements (business_id, date, type, currency, amount, amount_ars, exchange_rate, source, description, created_by)
      VALUES (p_business_id, p_payment_date, 'expense', 'ARS', p_amount, p_amount, 1, 'pago_proveedor', v_desc, p_user_id);
  END IF;

  IF v_key IS NOT NULL THEN
    INSERT INTO supplier_free_payment_requests (business_id, user_id, idempotency_key, request_hash, supplier_payment_id)
      VALUES (p_business_id, v_user, v_key, v_hash, v_pay);
  END IF;

  RETURN jsonb_build_object('ok', true, 'replay', false, 'payment_id', v_pay);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;
ALTER FUNCTION "public"."pay_supplier_free_atomic"(uuid,uuid,uuid,text,date,numeric,text,text,text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."pay_supplier_free_atomic"(uuid,uuid,uuid,text,date,numeric,text,text,text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."pay_supplier_free_atomic"(uuid,uuid,uuid,text,date,numeric,text,text,text) TO "authenticated","service_role";

-- ────────────────────────────────────────────────────────────────────────────
-- (3) LOCKDOWN de policies. Bloqueo por defecto = ausencia de policy para el cmd.
--     SECURITY DEFINER (triggers/RPCs, owner=postgres) NO depende de estas policies.
-- ────────────────────────────────────────────────────────────────────────────

-- financial_movements: SELECT permitido; INSERT sólo triggers/RPCs (drop client INSERT);
-- UPDATE/DELETE ya bloqueados (sin policy). reversed_at lo setean sólo las RPC de reverso.
DROP POLICY IF EXISTS "fm_insert" ON "public"."financial_movements";
DROP POLICY IF EXISTS "financial_movements_business_insert" ON "public"."financial_movements";

-- business_finance_entries: SELECT permitido; INSERT/UPDATE/DELETE sólo triggers/RPCs.
-- Se dropean bfe_insert + las policies manuales heredadas (UPDATE/DELETE) del ex-Finance.tsx.
DROP POLICY IF EXISTS "bfe_insert" ON "public"."business_finance_entries";
DROP POLICY IF EXISTS "bfe_update_manual" ON "public"."business_finance_entries";
DROP POLICY IF EXISTS "bfe_delete_manual" ON "public"."business_finance_entries";

-- supplier_payments / supplier_account_movements: pago (compra y libre) va por RPC;
-- ya no hay INSERT client-side. SELECT permitido; INSERT/UPDATE/DELETE sólo RPC.
DROP POLICY IF EXISTS "supplier_payments_insert" ON "public"."supplier_payments";
DROP POLICY IF EXISTS "supplier_account_movements_insert" ON "public"."supplier_account_movements";

-- order_payments: creación/reverso por RPC. SELECT permitido; INSERT/UPDATE/DELETE sólo RPC.
-- (DELETE ya fue dropeada en Fase 6.)
DROP POLICY IF EXISTS "order_payments_insert" ON "public"."order_payments";
DROP POLICY IF EXISTS "order_payments_update" ON "public"."order_payments";

-- expenses: alta por RPC create_expense_with_finance o factura documental (INSERT acotado,
-- se conserva). UPDATE/DELETE directo bloqueado (reverso operativo append-only por RPC;
-- reversed_at sólo lo setea la RPC).
DROP POLICY IF EXISTS "expenses_update" ON "public"."expenses";
DROP POLICY IF EXISTS "expenses_delete" ON "public"."expenses";

-- cajas: reemplazar la policy ALL (INSERT/UPDATE/DELETE amplios) por SELECT. Apertura,
-- cierre y movimientos van por RPC (open/close_cash_session_atomic,
-- create_manual_cash_movement_atomic). Caja cerrada inmutable (sin UPDATE directo).
DROP POLICY IF EXISTS "cajas_staff" ON "public"."cajas";
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='cajas' AND policyname='cajas_select') THEN
    CREATE POLICY "cajas_select" ON "public"."cajas" FOR SELECT USING (
      (current_business_id() = business_id) AND is_staff());
  END IF;
END $$;

-- ============================================================================
-- ROLLBACK (manual): recrear las policies dropeadas y DROP de RPCs/tablas nuevas.
-- Ninguna de las policies dropeadas era necesaria para flujos vivos (todos migrados
-- a RPC SECURITY DEFINER, que no dependen de policies del invoker).
-- ============================================================================
