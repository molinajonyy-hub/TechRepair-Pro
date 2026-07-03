-- ============================================================================
-- Conciliaciones financieras POR ORIGEN — Etapa 0 (adaptación de
-- docs/auditoria-finanzas/conciliaciones.sql para uso recurrente).
--
-- READ-ONLY. Ejecutable contra local o (solo lectura) contra un dump real.
-- Cada bloque devuelve las VIOLACIONES: el resultado sano es 0 filas.
-- Reemplazar el business_id del CTE `biz` según el ambiente.
--
-- A diferencia del archivo original de la auditoría, acá NO se comparan
-- totales globales que mezclan universos (BFE histórico vs FM vs pagos):
-- cada check concilia por IDENTIFICADOR (pago, comprobante, sesión).
--
-- Las versiones con ASSERT (que fallan el build) viven en
-- etapa0_annulment_ledger_test.sql / etapa0_checkout_invariants_test.sql.
-- ============================================================================

-- \set business_id 'aa930802-0861-46ce-896c-7f68b181cb39'

-- ────────────────────────────────────────────────────────────────────────────
-- P1. PAGOS POS ↔ CAJA: cada pago (no CC) debe tener EXACTAMENTE un FM income
--     vinculado por source_id. Detecta faltantes Y duplicados.
--     NOTA histórica: pagos anteriores al trigger actual pueden no tener
--     source_id — aparecen acá y se resuelven en la normalización de M7.
-- ────────────────────────────────────────────────────────────────────────────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid AS id)
SELECT 'P1' AS check_id, cp.id AS pago_id, cp.comprobante_id, cp.amount_ars,
       (SELECT count(*) FROM financial_movements fm
         WHERE fm.source = 'comprobante' AND fm.source_id = cp.id AND fm.type = 'income') AS fm_vinculados
FROM comprobante_payments cp, biz
WHERE cp.business_id = biz.id AND cp.payment_method <> 'cuenta_corriente'
  AND (SELECT count(*) FROM financial_movements fm
        WHERE fm.source = 'comprobante' AND fm.source_id = cp.id AND fm.type = 'income') <> 1;

-- ────────────────────────────────────────────────────────────────────────────
-- P2. PAGOS POS ↔ BFE espejo: por comprobante, count(BFE income +) debe
--     igualar count(pagos no-CC) mientras exista el espejo BFE (pre-M3).
-- ────────────────────────────────────────────────────────────────────────────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid AS id)
SELECT 'P2' AS check_id, c.id AS comprobante_id, COALESCE(c.numero_fiscal, c.numero) AS numero,
       (SELECT count(*) FROM business_finance_entries b
         WHERE b.reference_comprobante_id = c.id AND b.type = 'income' AND b.amount_ars > 0) AS bfe_income,
       (SELECT count(*) FROM comprobante_payments cp
         WHERE cp.comprobante_id = c.id AND cp.payment_method <> 'cuenta_corriente') AS pagos
FROM comprobantes c, biz
WHERE c.business_id = biz.id
  AND (SELECT count(*) FROM business_finance_entries b
        WHERE b.reference_comprobante_id = c.id AND b.type = 'income' AND b.amount_ars > 0)
   <> (SELECT count(*) FROM comprobante_payments cp
        WHERE cp.comprobante_id = c.id AND cp.payment_method <> 'cuenta_corriente');

-- ────────────────────────────────────────────────────────────────────────────
-- CC1. CUENTA CORRIENTE por comprobante, separando débito de venta / crédito
--      de cobro / reverso de anulación. Violación: comp ANULADO con neto ≠ 0.
-- ────────────────────────────────────────────────────────────────────────────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid AS id)
SELECT 'CC1' AS check_id, c.id AS comprobante_id,
       SUM(am.debit) FILTER (WHERE am.type = 'venta')  AS debito_venta,
       SUM(am.credit) FILTER (WHERE am.type = 'pago')   AS credito_cobro,
       SUM(am.credit) FILTER (WHERE am.type = 'ajuste') AS reverso_anulacion,
       SUM(am.debit - am.credit) AS neto
FROM comprobantes c
JOIN account_movements am ON am.reference_type = 'comprobante' AND am.reference_id = c.id, biz
WHERE c.business_id = biz.id AND c.estado = 'anulado'
GROUP BY c.id
HAVING abs(SUM(am.debit - am.credit)) > 0.01;

-- ────────────────────────────────────────────────────────────────────────────
-- CC2. accounts.balance = Σ ledger por cuenta (invariante del trigger).
-- ────────────────────────────────────────────────────────────────────────────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid AS id)
SELECT 'CC2' AS check_id, a.id AS account_id, a.entity_name, a.balance,
       (SELECT COALESCE(SUM(debit - credit), 0) FROM account_movements am WHERE am.account_id = a.id) AS ledger
FROM accounts a, biz
WHERE a.business_id = biz.id
  AND abs(a.balance - (SELECT COALESCE(SUM(debit - credit), 0) FROM account_movements am WHERE am.account_id = a.id)) > 0.01;

-- ────────────────────────────────────────────────────────────────────────────
-- G1. COGS por comprobante: BFE 'mercaderia' vinculado = Σ costo_total de los
--     ítems (comprobantes NO anulados, creados desde 20260702110000 — los
--     anteriores no tienen reference y se identifican por descripción).
-- ────────────────────────────────────────────────────────────────────────────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid AS id)
SELECT 'G1' AS check_id, c.id AS comprobante_id, COALESCE(c.numero_fiscal, c.numero) AS numero,
       (SELECT ROUND(COALESCE(SUM(ci.costo_total), 0), 2) FROM comprobante_items ci WHERE ci.comprobante_id = c.id) AS cogs_items,
       (SELECT ROUND(COALESCE(SUM(b.amount_ars), 0), 2) FROM business_finance_entries b
         WHERE b.reference_comprobante_id = c.id AND b.type = 'variable_cost' AND b.category = 'mercaderia') AS cogs_bfe
FROM comprobantes c, biz
WHERE c.business_id = biz.id AND c.estado <> 'anulado' AND c.tipo <> 'nota_credito'
  AND EXISTS (SELECT 1 FROM business_finance_entries b
              WHERE b.reference_comprobante_id = c.id AND b.category = 'mercaderia')
  AND abs(
    (SELECT COALESCE(SUM(ci.costo_total), 0) FROM comprobante_items ci WHERE ci.comprobante_id = c.id)
    - (SELECT COALESCE(SUM(b.amount_ars), 0) FROM business_finance_entries b
        WHERE b.reference_comprobante_id = c.id AND b.type = 'variable_cost' AND b.category = 'mercaderia')
  ) > 1;

-- ────────────────────────────────────────────────────────────────────────────
-- G2. ⚠️ EXPECTED FAILURE hasta M3 — pagos a proveedores clasificados como
--     costo variable. El modelo correcto: pagar deuda NO es costo del período
--     (el costo real es el COGS al vender). Este check DOCUMENTA la deuda
--     técnica de M3; NO es gate de Etapa 0. Sano futuro: 0 filas.
-- ────────────────────────────────────────────────────────────────────────────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid AS id)
SELECT 'G2-expected-red-hasta-M3' AS check_id, count(*) AS asientos,
       ROUND(COALESCE(SUM(amount_ars), 0)) AS total_clasificado_como_costo
FROM business_finance_entries e, biz
WHERE e.business_id = biz.id AND e.type = 'variable_cost'
  AND e.category IN ('compras_proveedor', 'repuestos', 'inventario')
HAVING count(*) > 0;

-- ────────────────────────────────────────────────────────────────────────────
-- S1. CAJA POR SESIÓN (cerradas, con conteo): inicial + Σin − Σout = cierre
--     por método, incluyendo sign (las reversas son type=expense sign=-1 y
--     restan como cualquier egreso).
-- ────────────────────────────────────────────────────────────────────────────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid AS id)
SELECT 'S1' AS check_id, cj.id AS caja_id, cj.opened_at::date, m.metodo,
       m.esperado, m.contado, ROUND(m.esperado - m.contado, 2) AS desvio
FROM cajas cj, biz,
LATERAL (
  SELECT x.metodo,
    CASE x.metodo
      WHEN 'efectivo'      THEN cj.efectivo_inicial
      WHEN 'transferencia' THEN cj.transferencia_inicial
      WHEN 'tarjeta'       THEN cj.tarjeta_inicial
      WHEN 'usd'           THEN cj.usd_inicial
    END + x.neto AS esperado,
    CASE x.metodo
      WHEN 'efectivo'      THEN cj.efectivo_cierre
      WHEN 'transferencia' THEN cj.transferencia_cierre
      WHEN 'tarjeta'       THEN cj.tarjeta_cierre
      WHEN 'usd'           THEN cj.usd_cierre
    END AS contado
  FROM (
    SELECT COALESCE(fm.metodo_pago, 'efectivo') AS metodo,
           SUM(CASE WHEN fm.type = 'income' THEN
                 CASE WHEN COALESCE(fm.metodo_pago,'') = 'usd' THEN fm.amount ELSE fm.amount_ars END
               ELSE
                 -(CASE WHEN COALESCE(fm.metodo_pago,'') = 'usd' THEN fm.amount ELSE fm.amount_ars END)
               END) AS neto
    FROM financial_movements fm
    WHERE fm.caja_id = cj.id
    GROUP BY 1
  ) x
) m
WHERE cj.business_id = biz.id AND cj.status = 'cerrada'
  AND m.contado IS NOT NULL
  AND abs(m.esperado - m.contado) > 1;

-- ────────────────────────────────────────────────────────────────────────────
-- AN1. ANULACIONES (nueva RPC): por cada comprobante anulado con registro en
--      comprobante_annulments — una sola anulación, pagos/comisiones/COGS/CC
--      compensados, stock restaurado a lo sumo una vez.
-- ────────────────────────────────────────────────────────────────────────────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid AS id)
SELECT 'AN1' AS check_id, an.comprobante_id, an.mode,
       fm_net.v AS caja_neta, bfe_inc.v AS bfe_income_neto,
       cogs.v AS cogs_neto, cc.v AS cc_neta, ret.v AS retornos_stock
FROM comprobante_annulments an, biz,
LATERAL (SELECT COALESCE(SUM(CASE WHEN COALESCE(sign,1)=1 AND type='income' THEN amount_ars
                                  WHEN sign=-1 THEN -amount_ars ELSE 0 END),0) v
         FROM financial_movements WHERE comprobante_id = an.comprobante_id) fm_net,
LATERAL (SELECT COALESCE(SUM(amount_ars),0) v FROM business_finance_entries
         WHERE reference_comprobante_id = an.comprobante_id AND type='income') bfe_inc,
LATERAL (SELECT COALESCE(SUM(amount_ars),0) v FROM business_finance_entries
         WHERE reference_comprobante_id = an.comprobante_id AND category='mercaderia') cogs,
LATERAL (SELECT COALESCE(SUM(debit-credit),0) v FROM account_movements
         WHERE reference_type='comprobante' AND reference_id = an.comprobante_id) cc,
LATERAL (SELECT count(*) v FROM inventory_movements
         WHERE reference_id = an.comprobante_id AND movement_type = 'return') ret
WHERE an.business_id = biz.id
  AND (abs(fm_net.v) > 0.01 OR abs(bfe_inc.v) > 0.01 OR abs(cogs.v) > 0.01 OR abs(cc.v) > 0.01
       OR (an.restore_stock AND ret.v <> an.stock_restored_count)
       OR (NOT an.restore_stock AND ret.v > 0));

-- ────────────────────────────────────────────────────────────────────────────
-- H1. HUÉRFANOS (sin cambios respecto de la auditoría — siguen siendo gate).
-- ────────────────────────────────────────────────────────────────────────────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid AS id)
SELECT 'H1' AS check_id,
  (SELECT count(*) FROM financial_movements f, biz WHERE f.business_id = biz.id
    AND f.comprobante_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM comprobantes c WHERE c.id = f.comprobante_id)) AS fm_huerfanos,
  (SELECT count(*) FROM business_finance_entries e, biz WHERE e.business_id = biz.id
    AND e.reference_comprobante_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM comprobantes c WHERE c.id = e.reference_comprobante_id)) AS bfe_huerfanos;
