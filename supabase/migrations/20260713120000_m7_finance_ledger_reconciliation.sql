-- ============================================================================
-- M7 (Bloque 1c) — finance_ledger_reconciliation: saneamiento seguro de históricos
--
-- Los históricos pendientes (FM sin caja, comprobantes desincronizados) NO se
-- corrigen mutando el ledger protegido ni asignando cajas por proximidad. Se
-- CLASIFICAN mediante metadata explícita en una tabla auxiliar append-only
-- (decisión del owner), sin tocar montos ni fechas económicas originales.
--
-- Piezas:
--   finance_ledger_reconciliation (tabla)  — clasificación por registro legacy.
--   finance_pending_historicals(business)  — DRY-RUN read-only: cuenta y clasifica
--       los pendientes SIN escribir nada. Es la fuente del reporte de Fase 7.
--   reconcile_ledger_record(...) (RPC)     — registra una clasificación (append-only,
--       auditada). NO ejecuta ningún backfill masivo; es de a un registro.
--
-- Estados de reconciliación:
--   corrected            — corregible con evidencia inequívoca (se documenta la corrección).
--   legacy_accepted      — legacy válido anterior a las invariantes actuales (se acepta como histórico).
--   active_inconsistency — inconsistencia real que requiere intervención.
--   indeterminate        — sin evidencia suficiente para clasificar.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "public"."finance_ledger_reconciliation" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id"           uuid NOT NULL REFERENCES "public"."businesses"("id"),
  "entity_table"          text NOT NULL,   -- 'financial_movements' | 'comprobantes'
  "entity_id"             uuid NOT NULL,
  "issue_type"            text NOT NULL,   -- 'fm_sin_caja' | 'comprobante_desync'
  "legacy"                boolean NOT NULL DEFAULT false,
  "reconciliation_status" text NOT NULL CHECK ("reconciliation_status" IN
                            ('corrected','legacy_accepted','active_inconsistency','indeterminate')),
  "reconciliation_reason" text,
  "evidence"              jsonb,
  "reconciled_by"         uuid,
  "reconciled_at"         timestamptz NOT NULL DEFAULT now(),
  "created_at"            timestamptz NOT NULL DEFAULT now()
);

-- La clasificación vigente de un registro es la fila más reciente (append-only:
-- una reclasificación agrega una fila nueva, no muta la anterior).
CREATE INDEX IF NOT EXISTS "idx_finance_reconciliation_entity"
  ON "public"."finance_ledger_reconciliation" ("business_id", "entity_table", "entity_id", "reconciled_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_finance_reconciliation_status"
  ON "public"."finance_ledger_reconciliation" ("business_id", "issue_type", "reconciliation_status");

COMMENT ON TABLE "public"."finance_ledger_reconciliation" IS
  'Saneamiento de históricos financieros por metadata (M7). Append-only, no toca '
  'el ledger. La fila más reciente por (entity_table, entity_id) es la clasificación '
  'vigente. NO se asigna caja ni se recalculan montos/fechas.';

ALTER TABLE "public"."finance_ledger_reconciliation" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "finance_reconciliation_select" ON "public"."finance_ledger_reconciliation";
CREATE POLICY "finance_reconciliation_select" ON "public"."finance_ledger_reconciliation"
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM businesses WHERE id = finance_ledger_reconciliation.business_id AND owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id = finance_ledger_reconciliation.business_id
               AND user_id = auth.uid() AND COALESCE(is_active,true) AND role IN ('owner','admin'))
  );

REVOKE ALL ON "public"."finance_ledger_reconciliation" FROM PUBLIC, "anon";
GRANT SELECT ON "public"."finance_ledger_reconciliation" TO "authenticated";
GRANT ALL ON "public"."finance_ledger_reconciliation" TO "service_role";

-- ── DRY-RUN: finance_pending_historicals (read-only, no escribe) ────────────
-- Devuelve, por tipo de issue: total, ya clasificados, pendientes, una muestra
-- de IDs con clasificación PROPUESTA (heurística conservadora) y evidencia. NO
-- modifica datos. El corte de invariantes usa la fecha de M6 (cash sessions):
-- FM sin caja creados ANTES son candidatos a legacy; DESPUÉS, inconsistencia real.
CREATE OR REPLACE FUNCTION "public"."finance_pending_historicals"(p_business_id uuid)
  RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
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
      AND abs(COALESCE(c.total_cobrado,0) - (SELECT COALESCE(SUM(amount_ars),0) FROM comprobante_payments p WHERE p.comprobante_id=c.id)) > 1;
  SELECT count(*) INTO v_desync_pending FROM comprobantes c
    WHERE c.business_id=p_business_id AND c.estado NOT IN ('anulado','cancelled') AND c.total_cobrado IS NOT NULL
      AND abs(COALESCE(c.total_cobrado,0) - (SELECT COALESCE(SUM(amount_ars),0) FROM comprobante_payments p WHERE p.comprobante_id=c.id)) > 1
      AND NOT EXISTS (SELECT 1 FROM finance_ledger_reconciliation r
        WHERE r.business_id=p_business_id AND r.entity_table='comprobantes' AND r.entity_id=c.id);
  SELECT COALESCE(jsonb_agg(row_to_json(x)),'[]') INTO v_desync_rows FROM (
    SELECT c.id AS entity_id, COALESCE(c.fecha,c.date,c.created_at::date) AS economic_date,
      c.total_cobrado, (SELECT COALESCE(SUM(amount_ars),0) FROM comprobante_payments p WHERE p.comprobante_id=c.id) AS sum_payments,
      'indeterminate' AS proposed_status
    FROM comprobantes c
    WHERE c.business_id=p_business_id AND c.estado NOT IN ('anulado','cancelled') AND c.total_cobrado IS NOT NULL
      AND abs(COALESCE(c.total_cobrado,0) - (SELECT COALESCE(SUM(amount_ars),0) FROM comprobante_payments p WHERE p.comprobante_id=c.id)) > 1
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
ALTER FUNCTION "public"."finance_pending_historicals"(uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."finance_pending_historicals"(uuid) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."finance_pending_historicals"(uuid) TO "authenticated","service_role";

-- ── reconcile_ledger_record: clasificar UN registro (append-only, auditado) ──
-- No modifica el ledger. Idempotente por (entity, status): repetir la misma
-- clasificación devuelve replay sin duplicar. Reclasificar (status distinto)
-- agrega una fila nueva y audita.
CREATE OR REPLACE FUNCTION "public"."reconcile_ledger_record"(
  p_business_id uuid, p_entity_table text, p_entity_id uuid, p_issue_type text,
  p_reconciliation_status text, p_reason text, p_evidence jsonb DEFAULT NULL
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_authorized boolean := false;
  v_reason text := NULLIF(btrim(COALESCE(p_reason,'')), '');
  v_latest finance_ledger_reconciliation%ROWTYPE;
  v_legacy boolean := (p_reconciliation_status = 'legacy_accepted');
  v_id uuid;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'No autenticado'); END IF;
  IF p_entity_table NOT IN ('financial_movements','comprobantes') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'entity_table inválida'); END IF;
  IF p_reconciliation_status NOT IN ('corrected','legacy_accepted','active_inconsistency','indeterminate') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'estado de reconciliación inválido'); END IF;
  IF v_reason IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'El motivo de la clasificación es obligatorio'); END IF;

  -- Sólo owner/admin (es una decisión de gestión sobre históricos).
  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND user_id=v_user
                  AND COALESCE(is_active,true) AND role IN ('owner','admin'))) INTO v_authorized;
  IF NOT v_authorized THEN RETURN jsonb_build_object('ok', false, 'error', 'Sin permiso para reconciliar históricos'); END IF;

  -- La fila debe existir y pertenecer al negocio (cross-tenant imposible).
  IF p_entity_table='financial_movements' AND NOT EXISTS
      (SELECT 1 FROM financial_movements WHERE id=p_entity_id AND business_id=p_business_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Movimiento inexistente en este negocio'); END IF;
  IF p_entity_table='comprobantes' AND NOT EXISTS
      (SELECT 1 FROM comprobantes WHERE id=p_entity_id AND business_id=p_business_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Comprobante inexistente en este negocio'); END IF;

  -- Idempotencia: si la clasificación vigente ya es la misma, replay.
  SELECT * INTO v_latest FROM finance_ledger_reconciliation
    WHERE business_id=p_business_id AND entity_table=p_entity_table AND entity_id=p_entity_id
    ORDER BY reconciled_at DESC LIMIT 1;
  IF FOUND AND v_latest.reconciliation_status = p_reconciliation_status THEN
    RETURN jsonb_build_object('ok', true, 'replay', true, 'reconciliation_id', v_latest.id, 'status', p_reconciliation_status);
  END IF;

  INSERT INTO finance_ledger_reconciliation (business_id, entity_table, entity_id, issue_type,
    legacy, reconciliation_status, reconciliation_reason, evidence, reconciled_by)
    VALUES (p_business_id, p_entity_table, p_entity_id, p_issue_type,
      v_legacy, p_reconciliation_status, v_reason, p_evidence, v_user)
    RETURNING id INTO v_id;

  PERFORM finance_log_audit(
    p_business_id, 'reconcile', 'finance_ledger_reconciliation', v_id, 'reconcile_ledger_record',
    NULL, v_reason, NULL, p_entity_table, p_entity_id,
    CASE WHEN v_latest.id IS NULL THEN NULL ELSE jsonb_build_object('status', v_latest.reconciliation_status) END,
    jsonb_build_object('status', p_reconciliation_status, 'issue_type', p_issue_type, 'legacy', v_legacy)
  );

  RETURN jsonb_build_object('ok', true, 'replay', false, 'reconciliation_id', v_id, 'status', p_reconciliation_status);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;
ALTER FUNCTION "public"."reconcile_ledger_record"(uuid,text,uuid,text,text,text,jsonb) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."reconcile_ledger_record"(uuid,text,uuid,text,text,text,jsonb) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."reconcile_ledger_record"(uuid,text,uuid,text,text,text,jsonb) TO "authenticated","service_role";

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado):
--   DROP FUNCTION IF EXISTS reconcile_ledger_record(uuid,text,uuid,text,text,text,jsonb);
--   DROP FUNCTION IF EXISTS finance_pending_historicals(uuid);
--   DROP TABLE IF EXISTS finance_ledger_reconciliation;
-- ============================================================================
