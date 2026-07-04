-- ============================================================================
-- Etapa 1 — Conciliaciones POR ORIGEN (READ-ONLY, re-ejecutable)
-- Basadas en el contrato canónico. NO exigen igualdades globales inválidas
-- (CP≠BFE≠FM es estructural). Cada bloque devuelve VIOLACIONES: sano = 0 filas.
-- Reemplazar business_id del CTE biz. Las versiones con ASSERT que fallan el
-- build viven en etapa1_canonical_model_test.sql.
-- ============================================================================

-- G1. COGS por comprobante: v_finance_pnl usa comprobante_items (una vez).
--     Pagos a proveedor clasificados como COGS = 0 (deben estar excluidos).
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid id)
SELECT 'G1_pagos_proveedor_en_pnl' AS check_id,
  (SELECT count(*) FROM business_finance_entries e, biz
    WHERE e.business_id=biz.id AND economic_class='supplier_liability_payment'
      AND economic_class IN ('operating_expense','payment_fee','employee_salary')) AS deben_ser_cero;

-- G2. Retiros del dueño incluidos en el resultado operativo = 0.
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid id)
SELECT 'G2_retiros_en_pnl' AS check_id,
  (SELECT count(*) FROM business_finance_entries e, biz
    WHERE e.business_id=biz.id AND economic_class='owner_withdrawal'
      AND economic_class IN ('operating_expense','payment_fee','employee_salary')) AS deben_ser_cero;

-- G3. Compras de inventario / COGS-mirror incluidas en el P&L = 0.
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid id)
SELECT 'G3_compras_cogsmirror_en_pnl' AS check_id,
  (SELECT count(*) FROM business_finance_entries e, biz
    WHERE e.business_id=biz.id AND economic_class IN ('inventory_purchase','cogs_mirror')
      AND economic_class IN ('operating_expense','payment_fee','employee_salary')) AS deben_ser_cero;

-- POS. Cada pago (no CC) tiene EXACTAMENTE un FM income vinculado.
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid id)
SELECT 'POS_pago_sin_fm' AS check_id, cp.id AS pago_id
FROM comprobante_payments cp, biz
WHERE cp.business_id=biz.id AND cp.payment_method<>'cuenta_corriente'
  AND (SELECT count(*) FROM financial_movements fm WHERE fm.source='comprobante' AND fm.source_id=cp.id AND fm.type='income')<>1;

-- CxP. v_finance_position.payables = supplier ledger = supplier pending.
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid id)
SELECT 'CxP_tres_fuentes' AS check_id,
  (SELECT payables FROM v_finance_position WHERE business_id=(SELECT id FROM biz)) AS position_payables,
  (SELECT ROUND(SUM(debit-credit)) FROM supplier_account_movements s, biz WHERE s.business_id=biz.id) AS ledger,
  (SELECT ROUND(SUM(pending_amount)) FROM supplier_purchases sp, biz WHERE sp.business_id=biz.id) AS purchases_pending;

-- CAJA. v_finance_cashflow neto = FM clasificados (por origen/fecha/método/clase).
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid id)
SELECT 'CAJA_cashflow_vs_fm' AS check_id, cf.net_view, fm.net_raw,
  ROUND(cf.net_view - fm.net_raw) AS desvio
FROM biz,
LATERAL (SELECT ROUND(SUM(net_ars)) net_view FROM v_finance_cashflow WHERE business_id=biz.id) cf,
LATERAL (SELECT ROUND(SUM(CASE WHEN type='income' AND COALESCE(sign,1)=1 THEN amount_ars ELSE -amount_ars END)) net_raw
         FROM financial_movements WHERE business_id=biz.id) fm;

-- CALIDAD. legacy_unclassified NO entra al P&L; se expone su monto.
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid id)
SELECT 'CALIDAD_unclassified' AS check_id,
  (SELECT count(*) FROM business_finance_entries e, biz WHERE e.business_id=biz.id AND economic_class='legacy_unclassified') AS n,
  (SELECT ROUND(COALESCE(SUM(amount_ars),0)) FROM business_finance_entries e, biz WHERE e.business_id=biz.id AND economic_class='legacy_unclassified') AS monto;

-- CxC. NO se fuerza igualdad histórica: se usa la fuente canónica y se expone el desvío.
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid id)
SELECT 'CxC_desvio_documentado' AS check_id,
  (SELECT receivables FROM v_finance_position WHERE business_id=(SELECT id FROM biz)) AS canonico_receivables,
  (SELECT ROUND(SUM(saldo_pendiente)) FROM comprobantes c, biz WHERE c.business_id=biz.id AND c.estado NOT IN ('anulado') AND c.tipo<>'nota_credito') AS raw_saldo_pendiente,
  (SELECT ROUND(COALESCE(SUM(balance),0)) FROM accounts a, biz WHERE a.business_id=biz.id AND a.type='cliente') AS ledger_accounts_legacy;
