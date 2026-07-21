-- ============================================================================
-- M7 (Bloque 6F.3) — replace_comprobante_payment APPEND-ONLY.
--
-- ANTES: la RPC hacia `DELETE FROM comprobante_payments` -> destruia la fila
-- original (metodo/provider/comision/fecha) y `v_comprobantes_full.medios_de_pago`
-- pasaba a mostrar solo el metodo nuevo, como si siempre se hubiera cobrado asi.
-- (El ledger FM/BFE ya era append-only y el periodo original ya quedaba intacto.)
--
-- AHORA: las filas originales se CONSERVAN y se marcan como reemplazadas; solo
-- las vivas (replaced_at IS NULL) cuentan para el estado actual. La cadena de
-- reemplazos queda auditable (cada fila apunta a su sustituta inmediata).
--
-- Incluye ademas los aditivos M7 del lote: actor canonico, guard del periodo de
-- la operacion nueva, idempotencia durable server-side, snapshot del conjunto de
-- pagos vivos (PAYMENT_SET_CHANGED), locks deterministas, audit scope E1 + evento
-- unico payment_replacement, error_code aditivo y rollback total.
--
-- ⚠️ EXCEPCION DE ALCANCE (informada): el barrido del §3 encontro que
-- annul_comprobante_atomic SUMA los pagos sin filtrar ("lo REALMENTE registrado").
-- Con filas reemplazadas conservadas, anular DUPLICARIA la reversa. Se aplica el
-- filtro MINIMO (`AND replaced_at IS NULL`) de forma quirurgica. NO es la
-- integracion M7 de annul (eso sigue siendo el Lote 6F.4).
-- ============================================================================

-- ── Part A — esquema append-only (aditivo, sin backfill) ────────────────────
ALTER TABLE "public"."comprobante_payments" ADD COLUMN IF NOT EXISTS "replaced_at" timestamptz;
ALTER TABLE "public"."comprobante_payments" ADD COLUMN IF NOT EXISTS "replaced_by" uuid;
ALTER TABLE "public"."comprobante_payments" ADD COLUMN IF NOT EXISTS "replacement_payment_id" uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='comprobante_payments_replacement_fk') THEN
    ALTER TABLE "public"."comprobante_payments"
      ADD CONSTRAINT "comprobante_payments_replacement_fk"
      FOREIGN KEY ("replacement_payment_id") REFERENCES "public"."comprobante_payments"("id");
  END IF;
  -- no puede apuntar a la propia fila
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='comprobante_payments_replacement_not_self') THEN
    ALTER TABLE "public"."comprobante_payments"
      ADD CONSTRAINT "comprobante_payments_replacement_not_self"
      CHECK ("replacement_payment_id" IS DISTINCT FROM "id");
  END IF;
  -- invariante de estado final: viva (los 3 NULL) o reemplazada (los 3 NOT NULL)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='comprobante_payments_replacement_consistency') THEN
    ALTER TABLE "public"."comprobante_payments"
      ADD CONSTRAINT "comprobante_payments_replacement_consistency"
      CHECK ( ("replaced_at" IS NULL     AND "replaced_by" IS NULL     AND "replacement_payment_id" IS NULL)
           OR ("replaced_at" IS NOT NULL AND "replaced_by" IS NOT NULL AND "replacement_payment_id" IS NOT NULL) );
  END IF;
END $$;
-- indice parcial de pagos VIVOS (sin UNIQUE sobre replacement_payment_id: varias
-- filas de un cobro mixto apuntan al MISMO pago sustituto).
CREATE INDEX IF NOT EXISTS "idx_comprobante_payments_live" ON "public"."comprobante_payments" ("comprobante_id") WHERE "replaced_at" IS NULL;

-- ── Part B — guard de inmutabilidad / validacion de la cadena ───────────────
CREATE OR REPLACE FUNCTION "public"."comprobante_payments_replacement_guard"() RETURNS "trigger"
    LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.replaced_at IS NOT NULL THEN
      RAISE EXCEPTION 'comprobante_payments: un pago reemplazado no se puede eliminar' USING ERRCODE='0A000';
    END IF;
    RETURN OLD;  -- los pagos VIVOS conservan la semantica previa (annul/delete flows)
  END IF;
  -- metadata de reemplazo: se fija UNA sola vez
  IF OLD.replaced_at IS NOT NULL
     AND (NEW.replaced_at IS DISTINCT FROM OLD.replaced_at
       OR NEW.replaced_by IS DISTINCT FROM OLD.replaced_by
       OR NEW.replacement_payment_id IS DISTINCT FROM OLD.replacement_payment_id) THEN
    RAISE EXCEPTION 'comprobante_payments: la metadata de reemplazo es inmutable' USING ERRCODE='0A000';
  END IF;
  -- una fila reemplazada es inmutable en sus campos economicos
  IF OLD.replaced_at IS NOT NULL
     AND (NEW.amount IS DISTINCT FROM OLD.amount OR NEW.amount_ars IS DISTINCT FROM OLD.amount_ars
       OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate
       OR NEW.payment_method IS DISTINCT FROM OLD.payment_method OR NEW.date IS DISTINCT FROM OLD.date
       OR NEW.comprobante_id IS DISTINCT FROM OLD.comprobante_id OR NEW.business_id IS DISTINCT FROM OLD.business_id) THEN
    RAISE EXCEPTION 'comprobante_payments: un pago reemplazado es inmutable' USING ERRCODE='0A000';
  END IF;
  -- la fila sustituta debe ser del MISMO negocio y del MISMO comprobante
  IF NEW.replacement_payment_id IS NOT NULL
     AND NEW.replacement_payment_id IS DISTINCT FROM OLD.replacement_payment_id THEN
    IF NOT EXISTS (SELECT 1 FROM comprobante_payments r WHERE r.id=NEW.replacement_payment_id
                     AND r.business_id=NEW.business_id AND r.comprobante_id=NEW.comprobante_id) THEN
      RAISE EXCEPTION 'comprobante_payments: el pago sustituto debe pertenecer al mismo negocio y comprobante' USING ERRCODE='0A000';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
ALTER FUNCTION "public"."comprobante_payments_replacement_guard"() OWNER TO "postgres";
DROP TRIGGER IF EXISTS "trg_cp_replacement_guard" ON "public"."comprobante_payments";
CREATE TRIGGER "trg_cp_replacement_guard"
  BEFORE UPDATE OR DELETE ON "public"."comprobante_payments"
  FOR EACH ROW EXECUTE FUNCTION "public"."comprobante_payments_replacement_guard"();

-- ── Part C — guard de periodo en UPDATE (excepcion estricta para metadata) ──
-- trg_finance_period_guard_cp es BEFORE **INSERT**: los UPDATE no estaban guardados.
-- Marcar replaced_* en un pago viejo NO es una escritura economica nueva -> permitido.
-- Cualquier cambio ECONOMICO exige que el periodo del pago siga abierto.
CREATE OR REPLACE FUNCTION "public"."finance_period_guard_cp_update"() RETURNS "trigger"
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  -- 6F.3a: WHITELIST ESTRICTA. Solo la metadata de reemplazo puede cambiar sin
  -- guard. Se compara la fila COMPLETA menos esas 3 columnas: cualquier otra
  -- columna -- presente o FUTURA, incluidas las `notes` (historia documental) --
  -- exige que el periodo del pago siga abierto. No depende de enumerar campos
  -- economicos (una columna nueva no se cuela como "metadata" por omision).
  IF to_jsonb(NEW) - 'replaced_at' - 'replaced_by' - 'replacement_payment_id'
     IS NOT DISTINCT FROM
     to_jsonb(OLD) - 'replaced_at' - 'replaced_by' - 'replacement_payment_id' THEN
    RETURN NEW;
  END IF;
  -- Cambio ECONOMICO: el periodo del asiento ORIGINAL debe seguir abierto (no se
  -- puede editar un pago que ya cerro) Y, si se mueve de fecha/negocio, el destino
  -- tampoco puede caer en un periodo cerrado.
  PERFORM public.assert_period_open(OLD.business_id, COALESCE(OLD.date, public.ar_today()));
  IF NEW.date IS DISTINCT FROM OLD.date OR NEW.business_id IS DISTINCT FROM OLD.business_id THEN
    PERFORM public.assert_period_open(NEW.business_id, COALESCE(NEW.date, public.ar_today()));
  END IF;
  RETURN NEW;
END; $$;
ALTER FUNCTION "public"."finance_period_guard_cp_update"() OWNER TO "postgres";
DROP TRIGGER IF EXISTS "trg_finance_period_guard_cp_upd" ON "public"."comprobante_payments";
CREATE TRIGGER "trg_finance_period_guard_cp_upd"
  BEFORE UPDATE ON "public"."comprobante_payments"
  FOR EACH ROW EXECUTE FUNCTION "public"."finance_period_guard_cp_update"();


-- ── Part D/E/F — REPARACIÓN DE REPRODUCIBILIDAD (6F.3, historia) ─────────────
-- El bloque original aplicaba el filtro `AND replaced_at IS NULL` con
-- replace(pg_get_functiondef(...)) contra un fragmento hardcodeado. Ese texto
-- dependía del formato EXACTO (incl. indentación) que pg_get_functiondef/prosrc
-- preserva del cuerpo definido por la migración previa. En un `db reset` limpio
-- el cuerpo vivo tenía distinta indentación → replace() no-op → `v_new=v_def`
-- → RAISE P0001, y el reset abortaba en esta migración.
--
-- Reparación (misma intención, determinista): CREATE OR REPLACE explícito de la
-- definición CANÓNICA de cada objeto (idéntica al contrato productivo post-6F.3).
-- Sin replace(), sin pg_get_functiondef, sin coincidencia textual frágil. Los 5
-- objetos que 6F.3 dejaba en su estado final se fijan a esa forma; annul recibe
-- el filtro mínimo de la "excepción de alcance" (el Lote 6F.4, migración
-- inmediata siguiente, lo redefine por completo). CREATE OR REPLACE preserva
-- owner, ACL y comentarios. La vista no tiene reloptions (no reintroduce ningún
-- security_invoker). NO cambia datos ni el resultado lógico pretendido.
--
-- NOTA de reproducibilidad histórica: esta migración YA está aplicada en
-- producción; producción no la reejecuta. Sólo cambia CÓMO se alcanza el mismo
-- estado en un reset limpio.

-- D. trigger_comprobante_payment_sync (total_cobrado solo de pagos VIVOS)
CREATE OR REPLACE FUNCTION "public"."trigger_comprobante_payment_sync"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET search_path TO public, pg_temp
    AS $$
DECLARE
  v_comp_id      UUID;
  v_total        NUMERIC;
  v_total_cobrado NUMERIC;
  v_saldo        NUMERIC;
  v_estado_com   TEXT;
BEGIN
  v_comp_id := COALESCE(NEW.comprobante_id, OLD.comprobante_id);

  SELECT
    COALESCE(total_bruto, total_ars, total, 0),
    COALESCE(
      (SELECT SUM(amount_ars) FROM public.comprobante_payments
       WHERE comprobante_id = v_comp_id AND replaced_at IS NULL), 0)
  INTO v_total, v_total_cobrado
  FROM public.comprobantes
  WHERE id = v_comp_id;

  v_saldo := GREATEST(0, v_total - v_total_cobrado);

  v_estado_com := CASE
    WHEN v_total_cobrado <= 0             THEN 'pendiente'
    WHEN v_saldo <= 0.01                  THEN 'pagado'
    ELSE 'parcial'
  END;

  UPDATE public.comprobantes
  SET total_cobrado    = v_total_cobrado,
      saldo_pendiente  = v_saldo,
      estado_comercial = v_estado_com,
      updated_at       = NOW()
  WHERE id = v_comp_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- F2. finance_dashboard_summary (desync sin falso positivo)
CREATE OR REPLACE FUNCTION "public"."finance_dashboard_summary"("p_business_id" "uuid", "p_date_from" "date", "p_date_to" "date") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET search_path TO public, pg_temp
    AS $$
DECLARE
  v_has_access boolean := false;
  v_prev_from  date;
  v_prev_to    date;
  v_span       integer;
  v_prof       jsonb;
  v_prof_prev  jsonb;
  v_cash       jsonb;
  v_pos        jsonb;
  v_quality    jsonb;
BEGIN
  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=auth.uid())
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND user_id=auth.uid())
  ) INTO v_has_access;
  IF NOT v_has_access THEN RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso al negocio'); END IF;

  v_span    := GREATEST(1, (p_date_to - p_date_from) + 1);
  v_prev_to := p_date_from - 1;
  v_prev_from := v_prev_to - (v_span - 1);

  -- ── Rentabilidad (devengado) ────────────────────────────────────────────
  SELECT jsonb_build_object(
    'gross_sales', COALESCE(SUM(gross_sales),0),
    'discounts', COALESCE(SUM(discounts),0),
    'sales_returns', COALESCE(SUM(sales_returns),0),
    'net_sales', COALESCE(SUM(net_sales),0),
    'cogs', COALESCE(SUM(cogs),0),
    'gross_profit', COALESCE(SUM(gross_profit),0),
    'gross_margin_pct', CASE WHEN COALESCE(SUM(net_sales),0)>0 THEN ROUND(SUM(gross_profit)/SUM(net_sales)*100,2) ELSE 0 END,
    'payment_fees', COALESCE(SUM(payment_fees),0),
    'operating_expenses', COALESCE(SUM(operating_expenses),0),
    'employee_salaries', COALESCE(SUM(employee_salaries),0),
    'operating_result', COALESCE(SUM(operating_result),0)
  ) INTO v_prof
  FROM v_finance_pnl WHERE business_id=p_business_id AND period_date BETWEEN p_date_from AND p_date_to;

  SELECT jsonb_build_object(
    'net_sales', COALESCE(SUM(net_sales),0),
    'gross_profit', COALESCE(SUM(gross_profit),0),
    'operating_result', COALESCE(SUM(operating_result),0)
  ) INTO v_prof_prev
  FROM v_finance_pnl WHERE business_id=p_business_id AND period_date BETWEEN v_prev_from AND v_prev_to;

  -- ── Flujo de caja (percibido) por clase ─────────────────────────────────
  SELECT jsonb_build_object(
    'net_ars', COALESCE(SUM(net_ars),0),
    'income_ars', COALESCE(SUM(income_ars),0),
    'expense_ars', COALESCE(SUM(expense_ars),0),
    'by_class', COALESCE((
      SELECT jsonb_object_agg(cashflow_class, cls_net) FROM (
        SELECT cashflow_class, ROUND(SUM(net_ars),2) cls_net FROM v_finance_cashflow
        WHERE business_id=p_business_id AND movement_date_ar BETWEEN p_date_from AND p_date_to GROUP BY 1
      ) x
    ), '{}'::jsonb),
    'by_method', COALESCE((
      SELECT jsonb_object_agg(COALESCE(payment_method,'otro'), m_net) FROM (
        SELECT payment_method, ROUND(SUM(net_ars),2) m_net FROM v_finance_cashflow
        WHERE business_id=p_business_id AND movement_date_ar BETWEEN p_date_from AND p_date_to GROUP BY 1
      ) y
    ), '{}'::jsonb)
  ) INTO v_cash
  FROM v_finance_cashflow WHERE business_id=p_business_id AND movement_date_ar BETWEEN p_date_from AND p_date_to;

  -- ── Posición (snapshot actual, no depende del período) ──────────────────
  SELECT to_jsonb(p) INTO v_pos FROM (
    SELECT cash_total, cash_by_method, inventory_at_cost, receivables, payables,
           owner_withdrawals_total, owner_contributions_total, owner_net_capital
    FROM v_finance_position WHERE business_id=p_business_id
  ) p;

  -- ── Calidad de datos ────────────────────────────────────────────────────
  SELECT jsonb_build_object(
    'unclassified_amount', COALESCE((SELECT (data_quality_flags->>'unclassified_amount')::numeric FROM v_finance_position WHERE business_id=p_business_id),0),
    'unclassified_count', COALESCE((SELECT (data_quality_flags->>'unclassified_count')::int FROM v_finance_position WHERE business_id=p_business_id),0),
    'missing_cost_items', COALESCE((SELECT SUM((data_quality_flags->>'missing_cost_items')::int) FROM v_finance_pnl WHERE business_id=p_business_id AND period_date BETWEEN p_date_from AND p_date_to),0),
    'fm_sin_caja', COALESCE((SELECT count(*) FROM financial_movements WHERE business_id=p_business_id AND caja_id IS NULL),0),
    'comprobantes_desincronizados', COALESCE((SELECT count(*) FROM comprobantes c WHERE c.business_id=p_business_id AND abs(COALESCE(c.total_cobrado,0)-(SELECT COALESCE(SUM(amount_ars),0) FROM comprobante_payments p WHERE p.comprobante_id=c.id AND p.replaced_at IS NULL))>1),0)
  ) INTO v_quality;

  RETURN jsonb_build_object(
    'ok', true,
    'finance_model_version', 2,
    'generated_at', now(),
    'timezone', 'America/Argentina/Cordoba',
    'period', jsonb_build_object('from', p_date_from, 'to', p_date_to),
    'profitability', v_prof,
    'cashflow', v_cash,
    'position', COALESCE(v_pos, '{}'::jsonb),
    'data_quality', v_quality,
    'comparison', jsonb_build_object('previous_period', jsonb_build_object('from', v_prev_from, 'to', v_prev_to), 'profitability', v_prof_prev)
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- F3. finance_pending_historicals (mismo desync check)
CREATE OR REPLACE FUNCTION "public"."finance_pending_historicals"("p_business_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET search_path TO public, pg_temp
    AS $$
DECLARE
  c_invariant_cutoff constant timestamptz := '2026-07-06 00:00:00-03';  -- deploy M6 cash sessions
  v_access boolean := false;
  v_fm_total int; v_fm_pending int;
  v_desync_total int; v_desync_pending int;
  v_fm_rows jsonb; v_desync_rows jsonb;
BEGIN
  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=auth.uid())
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND user_id=auth.uid()
                  AND COALESCE(is_active,true) AND role IN ('owner','admin'))) INTO v_access;
  IF NOT v_access THEN RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso al negocio'); END IF;

  -- ── Issue 1: FM sin caja ──────────────────────────────────────────────────
  SELECT count(*) INTO v_fm_total
    FROM financial_movements fm WHERE fm.business_id=p_business_id AND fm.caja_id IS NULL;
  SELECT count(*) INTO v_fm_pending
    FROM financial_movements fm WHERE fm.business_id=p_business_id AND fm.caja_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM finance_ledger_reconciliation r
        WHERE r.business_id=p_business_id AND r.entity_table='financial_movements' AND r.entity_id=fm.id
      );
  SELECT COALESCE(jsonb_agg(row_to_json(x)),'[]') INTO v_fm_rows FROM (
    SELECT fm.id AS entity_id, fm.date AS economic_date, fm.type, fm.metodo_pago, fm.amount_ars, fm.source,
      CASE WHEN fm.created_at < c_invariant_cutoff THEN 'legacy_accepted' ELSE 'active_inconsistency' END AS proposed_status,
      (fm.created_at < c_invariant_cutoff) AS legacy
    FROM financial_movements fm
    WHERE fm.business_id=p_business_id AND fm.caja_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM finance_ledger_reconciliation r
        WHERE r.business_id=p_business_id AND r.entity_table='financial_movements' AND r.entity_id=fm.id)
    ORDER BY fm.created_at LIMIT 50
  ) x;

  -- ── Issue 2: comprobantes desincronizados (total_cobrado != Σ pagos) ──────
  SELECT count(*) INTO v_desync_total FROM comprobantes c
    WHERE c.business_id=p_business_id AND c.estado NOT IN ('anulado','cancelled') AND c.total_cobrado IS NOT NULL
      AND abs(COALESCE(c.total_cobrado,0) - (SELECT COALESCE(SUM(amount_ars),0) FROM comprobante_payments p WHERE p.comprobante_id=c.id AND p.replaced_at IS NULL)) > 1;
  SELECT count(*) INTO v_desync_pending FROM comprobantes c
    WHERE c.business_id=p_business_id AND c.estado NOT IN ('anulado','cancelled') AND c.total_cobrado IS NOT NULL
      AND abs(COALESCE(c.total_cobrado,0) - (SELECT COALESCE(SUM(amount_ars),0) FROM comprobante_payments p WHERE p.comprobante_id=c.id AND p.replaced_at IS NULL)) > 1
      AND NOT EXISTS (SELECT 1 FROM finance_ledger_reconciliation r
        WHERE r.business_id=p_business_id AND r.entity_table='comprobantes' AND r.entity_id=c.id);
  SELECT COALESCE(jsonb_agg(row_to_json(x)),'[]') INTO v_desync_rows FROM (
    SELECT c.id AS entity_id, COALESCE(c.fecha,c.date,c.created_at::date) AS economic_date,
      c.total_cobrado, (SELECT COALESCE(SUM(amount_ars),0) FROM comprobante_payments p WHERE p.comprobante_id=c.id AND p.replaced_at IS NULL) AS sum_payments,
      'indeterminate' AS proposed_status
    FROM comprobantes c
    WHERE c.business_id=p_business_id AND c.estado NOT IN ('anulado','cancelled') AND c.total_cobrado IS NOT NULL
      AND abs(COALESCE(c.total_cobrado,0) - (SELECT COALESCE(SUM(amount_ars),0) FROM comprobante_payments p WHERE p.comprobante_id=c.id AND p.replaced_at IS NULL)) > 1
      AND NOT EXISTS (SELECT 1 FROM finance_ledger_reconciliation r
        WHERE r.business_id=p_business_id AND r.entity_table='comprobantes' AND r.entity_id=c.id)
    ORDER BY c.created_at DESC LIMIT 50
  ) x;

  RETURN jsonb_build_object(
    'ok', true, 'dry_run', true, 'business_id', p_business_id, 'generated_at', now(),
    'issues', jsonb_build_array(
      jsonb_build_object('issue_type','fm_sin_caja','total',v_fm_total,'pending',v_fm_pending,
        'classified', v_fm_total - v_fm_pending, 'sample', v_fm_rows),
      jsonb_build_object('issue_type','comprobante_desync','total',v_desync_total,'pending',v_desync_pending,
        'classified', v_desync_total - v_desync_pending, 'sample', v_desync_rows)
    )
  );
END;
$$;

-- F4. customer_purchase_history (métodos VIGENTES por compra)
CREATE OR REPLACE FUNCTION "public"."customer_purchase_history"("p_customer_id" "uuid", "p_business_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET search_path TO public, pg_temp
    AS $$
DECLARE
  v_has_access  BOOLEAN := FALSE;
  v_customer    JSONB;
  v_summary     JSONB;
  v_purchases   JSONB;
BEGIN
  -- ── 1. Validar acceso al negocio ────────────────────────────────────────────
  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id = p_business_id AND owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id = p_business_id AND user_id = auth.uid())
  ) INTO v_has_access;
  IF NOT v_has_access THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso al negocio');
  END IF;

  -- ── 2. Validar que el cliente pertenece al negocio ──────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM customers WHERE id = p_customer_id AND business_id = p_business_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Cliente no encontrado en este negocio');
  END IF;

  -- ── 3. Datos del cliente ────────────────────────────────────────────────────
  SELECT jsonb_build_object(
    'id',    id,
    'name',  name,
    'phone', phone,
    'email', email
  ) INTO v_customer
  FROM customers
  WHERE id = p_customer_id AND business_id = p_business_id;

  -- ── 4. Resumen financiero ────────────────────────────────────────────────────
  SELECT jsonb_build_object(
    'total_purchases',    COUNT(*) FILTER (WHERE tipo != 'nota_credito'),
    'total_spent',        COALESCE(SUM(total) FILTER (WHERE tipo != 'nota_credito'), 0),
    'total_refunded',     COALESCE(SUM(total) FILTER (WHERE tipo = 'nota_credito'), 0),
    'net_spent',          COALESCE(SUM(total) FILTER (WHERE tipo != 'nota_credito'), 0)
                          - COALESCE(SUM(total) FILTER (WHERE tipo = 'nota_credito'), 0),
    'pending_balance',    COALESCE(SUM(saldo_pendiente) FILTER (WHERE tipo != 'nota_credito' AND estado NOT IN ('anulado')), 0),
    'last_purchase_at',   MAX(COALESCE(fecha, created_at)::date) FILTER (WHERE tipo != 'nota_credito')
  ) INTO v_summary
  FROM comprobantes
  WHERE customer_id = p_customer_id
    AND business_id = p_business_id
    AND estado NOT IN ('anulado', 'cancelled')
    AND COALESCE(estado_comercial, '') != 'anulado';

  -- ── 5. Lista de compras con ítems y métodos de pago ─────────────────────────
  SELECT COALESCE(jsonb_agg(purchase ORDER BY purchase_date DESC), '[]'::JSONB)
  INTO v_purchases
  FROM (
    SELECT jsonb_build_object(
      'id',                      c.id,
      'date',                    COALESCE(c.fecha, c.date, c.created_at)::date,
      'created_at',              c.created_at,
      'tipo',                    c.tipo,
      'numero',                  COALESCE(c.numero_fiscal, c.numero, c.number),
      'numero_local',            COALESCE(c.numero, c.number),
      'numero_fiscal',           c.numero_fiscal,
      'cae',                     c.cae,
      'estado',                  COALESCE(c.estado, c.status),
      'estado_fiscal',           c.estado_fiscal,
      'estado_comercial',        COALESCE(c.estado_comercial, 'pendiente'),
      'emitido_arca',            (c.cae IS NOT NULL AND c.estado_fiscal = 'emitido'),
      'total',                   c.total,
      'total_cobrado',           COALESCE(c.total_cobrado, 0),
      'saldo_pendiente',         COALESCE(c.saldo_pendiente, 0),
      'order_id',                c.order_id,
      'comprobante_original_id', c.comprobante_original_id,
      'is_credit_note',          (c.tipo = 'nota_credito'),
      'observaciones',           c.observaciones,
      -- Métodos de pago como array (hasta 3)
      'payment_methods',         COALESCE((
        SELECT jsonb_agg(DISTINCT cp.payment_method)
        FROM comprobante_payments cp
        WHERE cp.comprobante_id = c.id AND cp.replaced_at IS NULL
        LIMIT 3
      ), '[]'::JSONB),
      -- Ítems resumidos (hasta 20 por comprobante)
      'items', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id',             ci.id,
            'descripcion',    ci.descripcion,
            'tipo_linea',     ci.tipo_linea,
            'cantidad',       ci.cantidad,
            'precio_unitario',ci.precio_unitario,
            'subtotal',       ci.subtotal
          )
          ORDER BY ci.orden NULLS LAST
        )
        FROM (
          SELECT * FROM comprobante_items
          WHERE comprobante_id = c.id
          ORDER BY COALESCE(orden, 0)
          LIMIT 20
        ) ci
      ), '[]'::JSONB)
    ) AS purchase,
    COALESCE(c.fecha, c.date, c.created_at) AS purchase_date
    FROM comprobantes c
    WHERE c.customer_id  = p_customer_id
      AND c.business_id  = p_business_id
      AND c.estado       NOT IN ('anulado', 'cancelled')
      AND COALESCE(c.estado_comercial, '') != 'anulado'
    ORDER BY COALESCE(c.fecha, c.date, c.created_at) DESC
    LIMIT 300
  ) t;

  RETURN jsonb_build_object(
    'ok',        true,
    'customer',  v_customer,
    'summary',   v_summary,
    'purchases', v_purchases
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- E. v_comprobantes_full (medios_de_pago / total_pagado_calc solo de pagos VIVOS)
CREATE OR REPLACE VIEW "public"."v_comprobantes_full" AS
 SELECT "c"."id",
    "c"."order_id",
    "c"."customer_id",
    "c"."tipo",
    "c"."numero",
    "c"."punto_venta",
    "c"."fecha",
    "c"."subtotal",
    "c"."impuestos",
    "c"."total",
    "c"."estado",
    "c"."cae",
    "c"."cae_vencimiento",
    "c"."afip_response",
    "c"."condicion_fiscal",
    "c"."created_at",
    "c"."updated_at",
    "c"."business_id",
    "c"."created_by",
    "c"."estado_fiscal",
    "c"."tipo_comprobante_fiscal",
    "c"."numero_comprobante",
    "c"."resultado_fiscal",
    "c"."observaciones_fiscales",
    "c"."error_codigo",
    "c"."error_mensaje",
    "c"."request_data",
    "c"."response_data",
    "c"."fecha_emision_fiscal",
    "c"."currency",
    "c"."total_ars",
    "c"."total_usd",
    "c"."exchange_rate",
    "c"."type",
    "c"."number",
    "c"."date",
    "c"."tax",
    "c"."status",
    "c"."estado_comercial",
    "c"."es_fiscal",
    "c"."emitir_en_arca",
    "c"."numero_fiscal",
    "c"."observaciones",
    "c"."descuento_total",
    "c"."recargo_total",
    "c"."total_bruto",
    "c"."total_cobrado",
    "c"."saldo_pendiente",
    "c"."total_comisiones",
    "c"."total_neto",
    "cust"."name" AS "customer_name",
    "cust"."phone" AS "customer_phone",
    "cust"."email" AS "customer_email",
    COALESCE("pay"."total_pagado", (0)::numeric) AS "total_pagado_calc",
    GREATEST((0)::numeric, (COALESCE("c"."total_bruto", "c"."total_ars", "c"."total", (0)::numeric) - COALESCE("pay"."total_pagado", (0)::numeric))) AS "saldo_calc",
    "pay"."medios_de_pago"
   FROM (("public"."comprobantes" "c"
     LEFT JOIN "public"."customers" "cust" ON (("c"."customer_id" = "cust"."id")))
     LEFT JOIN ( SELECT "comprobante_payments"."comprobante_id",
            "sum"("comprobante_payments"."amount_ars") AS "total_pagado",
            "string_agg"(DISTINCT "comprobante_payments"."payment_method", ', '::"text") AS "medios_de_pago"
           FROM "public"."comprobante_payments"
          WHERE ("comprobante_payments"."replaced_at" IS NULL)
          GROUP BY "comprobante_payments"."comprobante_id") "pay" ON (("c"."id" = "pay"."comprobante_id")));

-- F1. annul_comprobante_atomic — EXCEPCIÓN DE ALCANCE (filtro mínimo). Cuerpo
--     pre-6F.3 + `AND replaced_at IS NULL` en la medición de lo cobrado. El Lote
--     6F.4 (20260713250000) lo redefine íntegro con este filtro ya incorporado.
CREATE OR REPLACE FUNCTION public.annul_comprobante_atomic(p_comprobante_id uuid, p_mode text, p_motivo text, p_restore_stock boolean, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO public, pg_temp
AS $function$
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
    WHERE comprobante_id = v_comp.id AND business_id = v_comp.business_id AND replaced_at IS NULL;

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
$function$;

-- NOTA (decisiones "historia/ledger", SIN filtro): v_finance_effective_comprobantes
-- (EXISTS de liveness: evidencia de venta real), finance_health_check CHECK 5
-- (payments huerfanos: cuenta, no suma), delete_comprobante_with_finance (EXISTS
-- como blocker: si tuvo pagos sigue bloqueado), backfill_remito_fm (script legacy).

-- ── Part G — endurecer comprobante_payment_replace_requests ─────────────────
ALTER TABLE "public"."comprobante_payment_replace_requests" ADD COLUMN IF NOT EXISTS "op" text;
ALTER TABLE "public"."comprobante_payment_replace_requests" ADD COLUMN IF NOT EXISTS "source_payment_set_hash" text;
ALTER TABLE "public"."comprobante_payment_replace_requests" ADD COLUMN IF NOT EXISTS "new_payment_id" uuid;
-- 6F.3a: maquina de estados explicita del INTENTO.
--   processing    = reservado, sin resultado aun
--   completed     = reemplazo aplicado (new_payment_id fijado)
--   stale_source  = rechazado por concurrencia (el conjunto vivo cambio) -> NO es
--                   una request huerfana: es evidencia de un intento rechazado.
-- status NULL = fila LEGACY (M6, ya desplegado): reemplazo completado con la
-- semantica previa. Sin backfill.
ALTER TABLE "public"."comprobante_payment_replace_requests" ADD COLUMN IF NOT EXISTS "status" text;
ALTER TABLE "public"."comprobante_payment_replace_requests" ADD COLUMN IF NOT EXISTS "error_code" text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='cpr_requests_status_check') THEN
    ALTER TABLE "public"."comprobante_payment_replace_requests" ADD CONSTRAINT "cpr_requests_status_check"
      CHECK (
        "status" IS NULL                                                                            -- legacy M6
        OR ("status"='processing'   AND "new_payment_id" IS NULL     AND "error_code" IS NULL)
        OR ("status"='completed'    AND "new_payment_id" IS NOT NULL AND "error_code" IS NULL)
        OR ("status"='stale_source' AND "new_payment_id" IS NULL     AND "error_code"='PAYMENT_SET_CHANGED')
      );
  END IF;
END $$;
DROP POLICY IF EXISTS "cpr_requests_select" ON "public"."comprobante_payment_replace_requests";
DROP POLICY IF EXISTS "comprobante_payment_replace_requests_select" ON "public"."comprobante_payment_replace_requests";
REVOKE ALL ON "public"."comprobante_payment_replace_requests" FROM PUBLIC, "anon", "authenticated";
REVOKE UPDATE, DELETE, TRUNCATE ON "public"."comprobante_payment_replace_requests" FROM "service_role";
GRANT SELECT, INSERT ON "public"."comprobante_payment_replace_requests" TO "service_role";

CREATE OR REPLACE FUNCTION "public"."comprobante_payment_replace_requests_immutable"() RETURNS "trigger"
    LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION '% es append-only: DELETE no permitido', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  IF NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.op IS DISTINCT FROM OLD.op
     OR NEW.comprobante_id IS DISTINCT FROM OLD.comprobante_id
     OR NEW.source_payment_set_hash IS DISTINCT FROM OLD.source_payment_set_hash THEN
    RAISE EXCEPTION '%: el registro de reemplazo es inmutable', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  IF OLD.new_payment_id IS NOT NULL AND NEW.new_payment_id IS DISTINCT FROM OLD.new_payment_id THEN
    RAISE EXCEPTION '%: new_payment_id ya fijado es inmutable', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  IF NEW.new_payment_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM comprobante_payments p WHERE p.id=NEW.new_payment_id
        AND p.business_id=NEW.business_id AND p.comprobante_id=NEW.comprobante_id) THEN
    RAISE EXCEPTION '%: el pago sustituto no pertenece al negocio/comprobante', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  -- 6F.3a: transiciones permitidas. Terminal = completed / stale_source / legacy(NULL).
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status IS NULL THEN
      RAISE EXCEPTION '%: una request legacy es terminal', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
    IF OLD.status IN ('completed','stale_source') THEN
      RAISE EXCEPTION '%: % es un estado terminal (no admite transiciones)', TG_TABLE_NAME, OLD.status USING ERRCODE='0A000'; END IF;
    IF NOT (OLD.status='processing' AND NEW.status IN ('completed','stale_source')) THEN
      RAISE EXCEPTION '%: transicion de estado no permitida (% -> %)', TG_TABLE_NAME, OLD.status, NEW.status USING ERRCODE='0A000'; END IF;
  END IF;
  IF OLD.error_code IS NOT NULL AND NEW.error_code IS DISTINCT FROM OLD.error_code THEN
    RAISE EXCEPTION '%: error_code ya fijado es inmutable', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  RETURN NEW;
END; $$;
ALTER FUNCTION "public"."comprobante_payment_replace_requests_immutable"() OWNER TO "postgres";
DROP TRIGGER IF EXISTS "trg_cpr_requests_immutable" ON "public"."comprobante_payment_replace_requests";
CREATE TRIGGER "trg_cpr_requests_immutable"
  BEFORE UPDATE OR DELETE ON "public"."comprobante_payment_replace_requests"
  FOR EACH ROW EXECUTE FUNCTION "public"."comprobante_payment_replace_requests_immutable"();

-- ── Part H — RPC append-only ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.replace_comprobante_payment(p_comprobante_id uuid, p_business_id uuid, p_payment_method text, p_amount numeric, p_amount_ars numeric, p_currency text, p_exchange_rate numeric, p_notes text, p_user_id uuid, p_commission_amount numeric DEFAULT 0, p_payment_provider text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  c_key_max constant int := 200;
  v_actor_user_id uuid := auth.uid();   -- p_user_id NO atribuye (compat de firma)
  v_access boolean := false; v_tipo text;
  v_key text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_method text; v_notes text := NULLIF(btrim(COALESCE(p_notes,'')), '');
  v_provider text := NULLIF(btrim(COALESCE(p_payment_provider,'')), '');
  v_hash text; v_set_hash_before text; v_set_hash_after text;
  v_existing comprobante_payment_replace_requests%ROWTYPE;
  v_needs_caja boolean; v_caja uuid;
  v_date date;                          -- resultado server-side: NO entra al hash
  v_live_ids uuid[]; v_new_pay uuid; v_req_id uuid;
  v_orig_summary jsonb; v_comp_fm_ids uuid[]; v_comp_bfe_ids uuid[];
  v_new_fm uuid; v_new_bfe uuid;
  v_in_audit boolean := false; v_ec text;
BEGIN
  -- 1/2. Auth + ownership
  IF v_actor_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','UNAUTHORIZED', 'error', 'No autenticado'); END IF;
  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_actor_user_id)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND COALESCE(user_id,id)=v_actor_user_id AND COALESCE(is_active,true))) INTO v_access;
  IF NOT v_access THEN RETURN jsonb_build_object('ok', false, 'error_code','FORBIDDEN', 'error', 'Sin acceso a este negocio'); END IF;

  -- 3. Validacion (politica comercial preexistente intacta)
  SELECT tipo INTO v_tipo FROM comprobantes WHERE id=p_comprobante_id AND business_id=p_business_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error_code','COMPROBANTE_NOT_FOUND', 'error', 'Comprobante no encontrado'); END IF;
  IF v_tipo = 'nota_credito' THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Las notas de credito no tienen cobro editable'); END IF;
  IF p_payment_method = 'cuenta_corriente' THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Para cuenta corriente usa el flujo de cobro normal'); END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El monto debe ser mayor a 0'); END IF;
  IF v_key IS NOT NULL AND length(v_key) > c_key_max THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La clave de idempotencia es demasiado larga'); END IF;

  -- 4. Normalizacion del metodo (helper canonico del checkout)
  BEGIN
    v_method := public.normalize_checkout_payment_method(p_payment_method);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'INVALID_CHECKOUT_METHOD%' THEN
      RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Método de pago inválido');
    ELSE RAISE; END IF;
  END;

  -- 5. Replay: hash de la INTENCION del caller (sin ar_today/actor/IDs/saldos).
  IF v_key IS NOT NULL THEN
    v_hash := encode(extensions.digest(jsonb_build_object('op','payment_replacement','business_id',p_business_id,
      'comprobante_id',p_comprobante_id,'method',v_method,'amount',round(COALESCE(p_amount,0),2),
      'amount_ars',round(COALESCE(p_amount_ars,0),2),'currency',UPPER(COALESCE(p_currency,'ARS')),
      'exchange_rate',round(COALESCE(p_exchange_rate,1),6),'notes',v_notes,
      'commission_amount',round(COALESCE(p_commission_amount,0),2),'provider',v_provider)::text, 'sha256'), 'hex');
    SELECT * INTO v_existing FROM comprobante_payment_replace_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.'); END IF;
      -- 6F.3a: un intento que quedo STALE es TERMINAL. Un retry (p.ej. de red) NO
      -- puede convertirse en un segundo reemplazo no confirmado: no recalcula el
      -- conjunto, no toma locks, no ejecuta el guard y no audita. Para editar el
      -- conjunto vigente hay que refrescar y usar una key nueva.
      IF v_existing.status IN ('stale_source','processing') THEN
        RETURN jsonb_build_object('ok', false, 'error_code','PAYMENT_SET_CHANGED', 'error', 'El cobro cambió mientras se procesaba. Volvé a intentarlo'); END IF;
      -- completed | legacy(status NULL, M6) -> replay
      RETURN jsonb_build_object('ok', true, 'replay', true, 'new_payment_id', v_existing.new_payment_id);
    END IF;
  END IF;

  -- 6. Snapshot del conjunto de pagos VIVOS que este intento observo (pre-lock).
  SELECT encode(extensions.digest(COALESCE(jsonb_agg(e ORDER BY e->>'id')::text,'[]'), 'sha256'),'hex')
    INTO v_set_hash_before
    FROM (SELECT jsonb_build_object('id',id,'amount',round(COALESCE(amount,0),2),'amount_ars',round(COALESCE(amount_ars,0),2),
                 'method',payment_method,'currency',currency,'exchange_rate',round(COALESCE(exchange_rate,1),6),
                 'provider',payment_provider,'commission',round(COALESCE(commission_amount,0),2),'date',date) AS e
            FROM comprobante_payments WHERE comprobante_id=p_comprobante_id AND business_id=p_business_id AND replaced_at IS NULL) s;

  -- 7. Key NUEVA: recien ahora se resuelve la fecha economica.
  v_date := public.ar_today();

  -- 8. Guard: SOLO el periodo de la operacion NUEVA (compensaciones + pago nuevo).
  BEGIN PERFORM public.assert_period_open(p_business_id, v_date);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'PERIOD_CLOSED%' THEN RETURN jsonb_build_object('ok', false, 'error_code','PERIOD_CLOSED', 'error', SQLERRM);
    ELSIF SQLERRM LIKE 'INVALID_FINANCE_CONTEXT%' THEN RETURN jsonb_build_object('ok', false, 'error_code','INVALID_FINANCE_CONTEXT', 'error', SQLERRM);
    ELSE RAISE; END IF; END;

  -- 8.5 RESERVA (ANTES de los locks): es el punto de serializacion de la MISMA key.
  -- Si otra sesion con la misma key esta en curso, este INSERT espera en el indice
  -- UNIQUE; al liberarse se RELEE su resultado (replay/stale/conflict) en vez de
  -- comparar el source set -- que esa misma sesion acaba de cambiar (§5).
  IF v_key IS NOT NULL THEN
    INSERT INTO comprobante_payment_replace_requests (business_id, user_id, op, idempotency_key, request_hash, comprobante_id, source_payment_set_hash, status)
      VALUES (p_business_id, v_actor_user_id, 'payment_replacement', v_key, v_hash, p_comprobante_id, v_set_hash_before, 'processing')
      ON CONFLICT (business_id, idempotency_key) DO NOTHING RETURNING id INTO v_req_id;
    IF v_req_id IS NULL THEN
      SELECT * INTO v_existing FROM comprobante_payment_replace_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.'); END IF;
      IF v_existing.status IN ('stale_source','processing') THEN
        RETURN jsonb_build_object('ok', false, 'error_code','PAYMENT_SET_CHANGED', 'error', 'El cobro cambió mientras se procesaba. Volvé a intentarlo'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'new_payment_id', v_existing.new_payment_id);
    END IF;
  END IF;

  -- 9. LOCKS: comprobante y TODOS los pagos vivos, en orden determinista.
  PERFORM 1 FROM comprobantes WHERE id=p_comprobante_id AND business_id=p_business_id FOR UPDATE;
  PERFORM 1 FROM comprobante_payments WHERE comprobante_id=p_comprobante_id AND business_id=p_business_id AND replaced_at IS NULL
    ORDER BY id FOR UPDATE;

  -- 10. Recalcular el conjunto vivo bajo lock: si cambio, abortar sin escribir.
  SELECT encode(extensions.digest(COALESCE(jsonb_agg(e ORDER BY e->>'id')::text,'[]'), 'sha256'),'hex')
    INTO v_set_hash_after
    FROM (SELECT jsonb_build_object('id',id,'amount',round(COALESCE(amount,0),2),'amount_ars',round(COALESCE(amount_ars,0),2),
                 'method',payment_method,'currency',currency,'exchange_rate',round(COALESCE(exchange_rate,1),6),
                 'provider',payment_provider,'commission',round(COALESCE(commission_amount,0),2),'date',date) AS e
            FROM comprobante_payments WHERE comprobante_id=p_comprobante_id AND business_id=p_business_id AND replaced_at IS NULL) s;
  IF v_set_hash_after IS DISTINCT FROM v_set_hash_before THEN
    -- 6F.3a: se deja EVIDENCIA terminal del intento rechazado por concurrencia
    -- (no es una request huerfana). Se retorna (no se RAISE) para que la fila
    -- stale_source persista y un retry de la misma key no vuelva a reemplazar.
    IF v_req_id IS NOT NULL THEN
      UPDATE comprobante_payment_replace_requests
         SET status='stale_source', error_code='PAYMENT_SET_CHANGED'
       WHERE id=v_req_id;
    END IF;
    RETURN jsonb_build_object('ok', false, 'error_code','PAYMENT_SET_CHANGED', 'error', 'El cobro cambió mientras se procesaba. Volvé a intentarlo');
  END IF;

  -- 11. Caja: politica PREEXISTENTE (nuevo pago efectivo o algun cobro vivo efectivo).
  v_needs_caja := (v_method='efectivo')
    OR EXISTS (SELECT 1 FROM financial_movements WHERE comprobante_id=p_comprobante_id AND business_id=p_business_id
               AND type='income' AND source='comprobante' AND reversed_at IS NULL AND metodo_pago='efectivo');
  SELECT id INTO v_caja FROM cajas WHERE business_id=p_business_id AND status='abierta' ORDER BY opened_at DESC LIMIT 1;
  IF v_needs_caja AND v_caja IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code','CASH_REGISTER_NOT_OPEN', 'error', 'No hay caja abierta para registrar el reemplazo en efectivo'); END IF;

  -- 12. Audit scope E1 (antes de tocar comprobante_payments / movimientos).
  PERFORM public.finance_begin_audit_scope();

  -- 13. Conjunto vivo original (IDs + resumen compacto para auditoria).
  SELECT array_agg(id ORDER BY id),
         jsonb_agg(jsonb_build_object('id',id,'method',payment_method,'amount_ars',round(COALESCE(amount_ars,0),2),'date',date) ORDER BY id)
    INTO v_live_ids, v_orig_summary
    FROM comprobante_payments WHERE comprobante_id=p_comprobante_id AND business_id=p_business_id AND replaced_at IS NULL;
  v_live_ids := COALESCE(v_live_ids, '{}');

  -- 14. Compensar FM income vivos (expense HOY, caja abierta actual) y marcarlos.
  WITH ins AS (
    INSERT INTO financial_movements (business_id, date, type, currency, amount, amount_ars, exchange_rate,
      source, description, created_by, metodo_pago, comprobante_id, reference_id, reference_type)
    SELECT business_id, v_date, 'expense', currency, amount, amount_ars, exchange_rate,
      'reversal', 'REVERSO cobro (reemplazo)', v_actor_user_id, metodo_pago, comprobante_id, id, 'comprobante_payment_replace'
    FROM financial_movements
    WHERE comprobante_id=p_comprobante_id AND business_id=p_business_id AND type='income' AND source='comprobante' AND reversed_at IS NULL
    RETURNING id)
  SELECT array_agg(id) INTO v_comp_fm_ids FROM ins;
  UPDATE financial_movements SET reversed_at=now()
  WHERE comprobante_id=p_comprobante_id AND business_id=p_business_id AND type='income' AND source='comprobante' AND reversed_at IS NULL;

  -- 15. Compensar BFE vivos (income-mirror y comision) conservando economic_class.
  WITH insb AS (
    INSERT INTO business_finance_entries (business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate, payment_method, reference_comprobante_id, source, created_by, economic_class)
    SELECT business_id, v_date, type, category, 'REVERSO: '||COALESCE(description,''),
      -amount, currency, -amount_ars, exchange_rate, payment_method, reference_comprobante_id, 'reversal', v_actor_user_id, economic_class
    FROM business_finance_entries
    WHERE reference_comprobante_id=p_comprobante_id AND business_id=p_business_id AND source='comprobante' AND reversed_at IS NULL
    RETURNING id)
  SELECT array_agg(id) INTO v_comp_bfe_ids FROM insb;
  UPDATE business_finance_entries SET reversed_at=now()
  WHERE reference_comprobante_id=p_comprobante_id AND business_id=p_business_id AND source='comprobante' AND reversed_at IS NULL;

  -- 16. Pago sustituto (UNO). trig_comprobante_payment_finance crea su FM/BFE.
  INSERT INTO comprobante_payments (
    comprobante_id, business_id, amount, currency, amount_ars, exchange_rate,
    payment_method, payment_provider, commission_amount, notes, date, created_by
  ) VALUES (
    p_comprobante_id, p_business_id, p_amount, UPPER(COALESCE(p_currency,'ARS')), p_amount_ars, COALESCE(p_exchange_rate,1),
    v_method, v_provider, COALESCE(p_commission_amount,0), v_notes, v_date, v_actor_user_id
  ) RETURNING id INTO v_new_pay;

  -- 17. APPEND-ONLY: marcar los pagos originales (NO se borran) y enlazarlos al
  --     sustituto. El sync trigger recalcula total_cobrado solo con los vivos.
  IF array_length(v_live_ids,1) > 0 THEN
    UPDATE comprobante_payments
      SET replaced_at=now(), replaced_by=v_actor_user_id, replacement_payment_id=v_new_pay
      WHERE id = ANY(v_live_ids);
  END IF;

  -- 18. Cerrar el intento: processing -> completed (transicion unica permitida)
  IF v_key IS NOT NULL THEN
    UPDATE comprobante_payment_replace_requests
       SET status='completed', new_payment_id=v_new_pay
     WHERE id=v_req_id;
  END IF;

  SELECT id INTO v_new_fm  FROM financial_movements WHERE comprobante_id=p_comprobante_id AND business_id=p_business_id AND source='comprobante' AND reversed_at IS NULL LIMIT 1;
  SELECT id INTO v_new_bfe FROM business_finance_entries WHERE reference_comprobante_id=p_comprobante_id AND business_id=p_business_id AND source='comprobante' AND reversed_at IS NULL LIMIT 1;

  -- 19. UN evento explicito (la operacion, no una fila: puede reemplazar varios pagos)
  v_in_audit := true;
  PERFORM finance_log_audit(
    p_business_id, 'payment_replacement', 'comprobantes', p_comprobante_id, 'replace_comprobante_payment',
    v_key, v_notes, v_date, 'comprobante', p_comprobante_id,
    NULL, jsonb_build_object(
      'comprobante_id', p_comprobante_id, 'request_id', v_req_id,
      'original_payment_ids', to_jsonb(v_live_ids), 'original_payments', COALESCE(v_orig_summary,'[]'::jsonb),
      'original_date_min', (SELECT min(date) FROM comprobante_payments WHERE id=ANY(v_live_ids)),
      'original_date_max', (SELECT max(date) FROM comprobante_payments WHERE id=ANY(v_live_ids)),
      'compensating_fm_ids', to_jsonb(COALESCE(v_comp_fm_ids,'{}'::uuid[])),
      'compensating_bfe_ids', to_jsonb(COALESCE(v_comp_bfe_ids,'{}'::uuid[])),
      'new_payment_id', v_new_pay, 'new_financial_movement_id', v_new_fm, 'new_bfe_id', v_new_bfe,
      'new_method', v_method, 'new_amount', round(COALESCE(p_amount,0),2), 'new_amount_ars', round(COALESCE(p_amount_ars,0),2),
      'currency', UPPER(COALESCE(p_currency,'ARS')), 'exchange_rate', round(COALESCE(p_exchange_rate,1),6),
      'provider', v_provider, 'commission_amount', round(COALESCE(p_commission_amount,0),2),
      'replacement_date', v_date, 'replacement_period', to_char(v_date,'YYYY-MM'),
      'caja_id', v_caja, 'request_hash', v_hash, 'source_payment_set_hash', v_set_hash_before));
  v_in_audit := false;

  RETURN jsonb_build_object('ok', true, 'replay', false, 'new_payment_id', v_new_pay);
EXCEPTION WHEN OTHERS THEN
  v_ec := CASE
    WHEN v_in_audit THEN 'AUDIT_FAILED'
    WHEN SQLSTATE = '23505' THEN 'IDEMPOTENCY_CONFLICT'
    WHEN SQLERRM LIKE 'PERIOD_CLOSED%' THEN 'PERIOD_CLOSED'
    ELSE 'INTERNAL_ERROR' END;
  IF v_ec = 'IDEMPOTENCY_CONFLICT' THEN
    RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.');
  END IF;
  RETURN jsonb_build_object('ok', false, 'error_code', v_ec,
    'error', CASE WHEN v_ec='AUDIT_FAILED' THEN 'No se pudo registrar la auditoria de la operacion'
                  WHEN v_ec='PERIOD_CLOSED' THEN SQLERRM
                  ELSE 'No se pudo completar la operacion' END);
END;
$function$;

-- ============================================================================
-- ROLLBACK (documentado): revertir las 6 funciones/vista parcheadas a su version
-- previa (quitar 'AND replaced_at IS NULL'); DROP triggers trg_cp_replacement_guard,
-- trg_finance_period_guard_cp_upd, trg_cpr_requests_immutable + sus funciones;
-- ALTER comprobante_payments DROP COLUMN replaced_at/replaced_by/replacement_payment_id
-- (+ constraints e indice parcial); recrear replace_comprobante_payment M6 (con DELETE);
-- ALTER comprobante_payment_replace_requests DROP COLUMN op/source_payment_set_hash/
-- new_payment_id; restaurar policy/GRANT SELECT a authenticated.
-- ============================================================================

