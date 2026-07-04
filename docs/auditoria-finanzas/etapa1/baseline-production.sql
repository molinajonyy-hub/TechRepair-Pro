-- ============================================================================
-- Etapa 1 — Baseline productivo (SOLO LECTURA, re-ejecutable)
-- Capturado: 2026-07-04 10:05 (America/Argentina/Cordoba)
-- origin/main: 9aec74728b87cf342f9eec3dcce6c260d304ce06
-- Migración remota más reciente: 20260702140000_ledger_protection
-- Negocio principal (Clic): aa930802-0861-46ce-896c-7f68b181cb39
--
-- Ninguna consulta escribe. Los resultados quedan en baseline-production.md.
-- Alcance de cada número indicado explícitamente (global vs Clic).
-- ============================================================================

-- ── Metadata + volumen global ───────────────────────────────────────────────
SELECT (now() AT TIME ZONE 'America/Argentina/Cordoba')::text AS captured_at_ar,
       (SELECT max(version) FROM supabase_migrations.schema_migrations) AS latest_remote_migration;

SELECT 'comprobantes' t, count(*) n FROM comprobantes
UNION ALL SELECT 'comprobante_items', count(*) FROM comprobante_items
UNION ALL SELECT 'comprobante_payments', count(*) FROM comprobante_payments
UNION ALL SELECT 'financial_movements', count(*) FROM financial_movements
UNION ALL SELECT 'business_finance_entries', count(*) FROM business_finance_entries
UNION ALL SELECT 'cajas', count(*) FROM cajas
UNION ALL SELECT 'supplier_purchases', count(*) FROM supplier_purchases
UNION ALL SELECT 'supplier_payments', count(*) FROM supplier_payments
UNION ALL SELECT 'supplier_account_movements', count(*) FROM supplier_account_movements
UNION ALL SELECT 'accounts', count(*) FROM accounts
UNION ALL SELECT 'account_movements', count(*) FROM account_movements
UNION ALL SELECT 'owner_withdrawals', count(*) FROM owner_withdrawals
UNION ALL SELECT 'expenses', count(*) FROM expenses
UNION ALL SELECT 'purchases_legacy', count(*) FROM purchases
UNION ALL SELECT 'personal_transactions', count(*) FROM personal_transactions
UNION ALL SELECT 'comprobante_annulments', count(*) FROM comprobante_annulments;

-- ── FM sin caja: aclaración global vs Clic (global/negocio/source/mes/etapa0) ─
SELECT count(*) total_global, ROUND(SUM(amount_ars)) monto_global
FROM financial_movements WHERE caja_id IS NULL;

SELECT b.name, fm.business_id, count(*) n, ROUND(SUM(fm.amount_ars)) monto
FROM financial_movements fm JOIN businesses b ON b.id=fm.business_id
WHERE fm.caja_id IS NULL GROUP BY 1,2 ORDER BY n DESC;

SELECT COALESCE(source,'(null)') source, count(*) n, ROUND(SUM(amount_ars)) monto
FROM financial_movements WHERE caja_id IS NULL GROUP BY 1 ORDER BY n DESC;

SELECT to_char(date_trunc('month', COALESCE(date::timestamp, created_at)),'YYYY-MM') mes, count(*) n
FROM financial_movements WHERE caja_id IS NULL GROUP BY 1 ORDER BY 1;

-- Cuántos son anteriores / posteriores a la Etapa 0 (deploy 2026-07-03 ~20:48Z)
SELECT count(*) FILTER (WHERE created_at <  '2026-07-03T20:48:00Z') antes_etapa0,
       count(*) FILTER (WHERE created_at >= '2026-07-03T20:48:00Z') desde_etapa0
FROM financial_movements WHERE caja_id IS NULL;

-- ── Tres libros (Clic) ───────────────────────────────────────────────────────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid id)
SELECT
  (SELECT ROUND(SUM(amount_ars)) FROM comprobante_payments p, biz WHERE p.business_id=biz.id AND payment_method<>'cuenta_corriente') pagos_pos_no_cc,
  (SELECT ROUND(SUM(amount_ars)) FROM financial_movements f, biz WHERE f.business_id=biz.id AND type='income' AND COALESCE(sign,1)=1) fm_income,
  (SELECT ROUND(SUM(amount_ars)) FROM financial_movements f, biz WHERE f.business_id=biz.id AND type='expense') fm_expense,
  (SELECT ROUND(SUM(amount_ars)) FROM business_finance_entries e, biz WHERE e.business_id=biz.id AND type='income') bfe_income,
  (SELECT ROUND(SUM(amount_ars)) FROM business_finance_entries e, biz WHERE e.business_id=biz.id AND type='variable_cost') bfe_varcost,
  (SELECT ROUND(SUM(amount_ars)) FROM business_finance_entries e, biz WHERE e.business_id=biz.id AND type='fixed_cost_local') bfe_fixed_local,
  (SELECT ROUND(SUM(amount_ars)) FROM business_finance_entries e, biz WHERE e.business_id=biz.id AND type='salary') bfe_salary,
  (SELECT ROUND(SUM(amount_ars)) FROM business_finance_entries e, biz WHERE e.business_id=biz.id AND type='fixed_cost_personal') bfe_personal;

-- ── BFE por (type, category, source) con presencia de referencia (Clic) ──────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid id)
SELECT type, category, COALESCE(source,'(null)') source, count(*) n, ROUND(SUM(amount_ars)) monto,
       count(*) FILTER (WHERE reference_comprobante_id IS NOT NULL) con_ref
FROM business_finance_entries e, biz WHERE e.business_id=biz.id
GROUP BY 1,2,3 ORDER BY monto DESC;

-- ── Doble costo (Clic): COGS real vs categorías BFE de "costo" ───────────────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid id)
SELECT
  (SELECT ROUND(SUM(ci.costo_total)) FROM comprobante_items ci JOIN comprobantes c ON c.id=ci.comprobante_id, biz
     WHERE ci.business_id=biz.id AND c.status='issued' AND c.estado<>'anulado' AND c.tipo<>'nota_credito') cogs_real_issued,
  (SELECT ROUND(SUM(amount_ars)) FROM business_finance_entries e, biz WHERE e.business_id=biz.id AND category='mercaderia') bfe_mercaderia,
  (SELECT ROUND(SUM(amount_ars)) FROM business_finance_entries e, biz WHERE e.business_id=biz.id AND category='inventario') bfe_inventario,
  (SELECT ROUND(SUM(amount_ars)) FROM business_finance_entries e, biz WHERE e.business_id=biz.id AND category='compras_proveedor') bfe_compras_proveedor,
  (SELECT ROUND(SUM(amount_ars)) FROM business_finance_entries e, biz WHERE e.business_id=biz.id AND category='repuestos') bfe_repuestos;

-- ── Conjunto EFECTIVO (issued OR draft con pagos/stock/CC), no anulado, no NC ─
-- Base devengada canónica (incluye los drafts legacy con efectos reales).
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid id),
efectivos AS (
  SELECT c.id FROM comprobantes c, biz
  WHERE c.business_id=biz.id AND c.estado NOT IN ('anulado')
    AND COALESCE(c.estado_comercial,'')<>'anulado' AND c.tipo<>'nota_credito'
    AND (c.status='issued'
         OR EXISTS (SELECT 1 FROM comprobante_payments p WHERE p.comprobante_id=c.id)
         OR EXISTS (SELECT 1 FROM comprobante_items ci WHERE ci.comprobante_id=c.id AND ci.stock_processed=true)
         OR EXISTS (SELECT 1 FROM account_movements am WHERE am.reference_type='comprobante' AND am.reference_id=c.id AND am.type='venta'))
)
SELECT (SELECT count(*) FROM efectivos) n_comprobantes,
       (SELECT ROUND(SUM(ci.subtotal)) FROM comprobante_items ci WHERE ci.comprobante_id IN (SELECT id FROM efectivos)) net_sales,
       (SELECT ROUND(SUM(ci.costo_total)) FROM comprobante_items ci WHERE ci.comprobante_id IN (SELECT id FROM efectivos)) cogs,
       (SELECT ROUND(SUM(c.total)) FROM comprobantes c, biz WHERE c.business_id=biz.id AND c.tipo='nota_credito' AND c.estado NOT IN ('anulado')) nc_total;

-- ── Flujos del propietario (Clic) ────────────────────────────────────────────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid id)
SELECT type, category, count(*) n, ROUND(SUM(amount_ars)) monto, (array_agg(DISTINCT left(description,40)))[1:3] ejemplos
FROM business_finance_entries e, biz
WHERE e.business_id=biz.id AND (type IN ('salary','fixed_cost_personal') OR category IN ('retiros'))
GROUP BY 1,2 ORDER BY monto DESC;

-- ── Deuda (Clic): CxC y CxP por cada fuente ──────────────────────────────────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid id)
SELECT
  (SELECT ROUND(SUM(saldo_pendiente)) FROM comprobantes c, biz WHERE c.business_id=biz.id AND c.estado NOT IN ('anulado') AND c.tipo<>'nota_credito') cxc_saldo_pendiente,
  (SELECT ROUND(SUM(balance)) FROM accounts a, biz WHERE a.business_id=biz.id AND a.type='cliente') cxc_ledger,
  (SELECT ROUND(SUM(pending_amount)) FROM supplier_purchases sp, biz WHERE sp.business_id=biz.id) cxp_supplier_pending,
  (SELECT ROUND(SUM(debit-credit)) FROM supplier_account_movements sam, biz WHERE sam.business_id=biz.id) cxp_supplier_ledger,
  (SELECT ROUND(COALESCE(SUM(balance),0)) FROM accounts a, biz WHERE a.business_id=biz.id AND a.type='proveedor') cxp_accounts_dashboard;

-- ── Calidad de datos (Clic) ──────────────────────────────────────────────────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid id)
SELECT
  (SELECT count(*) FROM comprobante_items ci JOIN comprobantes c ON c.id=ci.comprobante_id, biz
     WHERE ci.business_id=biz.id AND c.status='issued' AND ci.inventory_id IS NOT NULL AND COALESCE(ci.costo_unitario,0)=0 AND ci.tipo_linea IN ('producto','repuesto')) items_costo_cero,
  (SELECT count(DISTINCT c.id) FROM comprobantes c JOIN comprobante_items ci ON ci.comprobante_id=c.id, biz
     WHERE c.business_id=biz.id AND c.status='draft' AND ci.stock_processed=true) drafts_con_stock,
  (SELECT count(*) FROM comprobantes c, biz WHERE c.business_id=biz.id
     AND abs(COALESCE(c.total_cobrado,0)-(SELECT COALESCE(SUM(amount_ars),0) FROM comprobante_payments p WHERE p.comprobante_id=c.id))>1) comps_desincronizados,
  (SELECT count(*) FROM business_finance_entries e, biz WHERE e.business_id=biz.id AND source IS NULL AND reference_comprobante_id IS NULL) bfe_sin_source_ni_ref;
