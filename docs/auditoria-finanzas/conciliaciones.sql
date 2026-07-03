-- ============================================================================
-- Conciliaciones financieras TechRepair Pro — batería re-ejecutable (READ-ONLY)
-- Ejecutadas por primera vez: 2026-07-02 (negocio "Clic").
-- Uso: reemplazar :business_id o editar el CTE biz. Cada bloque es independiente.
-- Resultado esperado de cada query: 0 filas / diff = 0, salvo indicación.
-- ============================================================================

-- Parámetro
-- \set business_id 'aa930802-0861-46ce-896c-7f68b181cb39'

-- ────────────────────────────────────────────────────────────────────────────
-- C1. CAJA: inicial + ingresos − egresos = cierre contado (por sesión y método)
--     Estado 2026-07-02: PASA (0 desvíos > $1 en 38 sesiones)
-- ────────────────────────────────────────────────────────────────────────────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid AS id)
SELECT cj.id, cj.opened_at::date,
       cj.efectivo_inicial + m.inc - m.outc AS esperado_efectivo,
       cj.efectivo_cierre,
       (cj.efectivo_inicial + m.inc - m.outc) - cj.efectivo_cierre AS desvio
FROM cajas cj, biz,
LATERAL (
  SELECT COALESCE(SUM(CASE WHEN fm.type='income'  THEN fm.amount_ars END),0) inc,
         COALESCE(SUM(CASE WHEN fm.type='expense' THEN fm.amount_ars END),0) outc
  FROM financial_movements fm
  WHERE fm.caja_id = cj.id AND COALESCE(fm.metodo_pago,'efectivo')='efectivo'
) m
WHERE cj.business_id=biz.id AND cj.status='cerrada' AND cj.efectivo_cierre IS NOT NULL
  AND abs((cj.efectivo_inicial + m.inc - m.outc) - cj.efectivo_cierre) > 1;

-- ────────────────────────────────────────────────────────────────────────────
-- C2. DEUDA DE CLIENTES: Σ saldo_pendiente (comprobantes) = Σ ledger CC clientes
--     Estado: FALLA ($25.100 vs $0 — ledger no alimentado por ventas pendientes)
-- ────────────────────────────────────────────────────────────────────────────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid AS id)
SELECT
  (SELECT COALESCE(SUM(saldo_pendiente),0) FROM comprobantes c, biz
    WHERE c.business_id=biz.id AND c.estado NOT IN ('anulado') AND c.tipo!='nota_credito') AS deuda_por_comprobantes,
  (SELECT COALESCE(SUM(balance),0) FROM accounts a, biz
    WHERE a.business_id=biz.id AND a.type='cliente') AS deuda_por_ledger_cc;

-- ────────────────────────────────────────────────────────────────────────────
-- C3. DEUDA PROVEEDORES: Σ pending (compras) = Σ ledger proveedor
--     Estado: PASA ($4.562.420 = $4.562.420). C3b: el Dashboard lee `accounts` → $0.
-- ────────────────────────────────────────────────────────────────────────────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid AS id)
SELECT s.name,
  (SELECT COALESCE(SUM(pending_amount),0) FROM supplier_purchases sp
    WHERE sp.supplier_id=s.id AND sp.business_id=s.business_id) AS pending_compras,
  (SELECT COALESCE(SUM(debit-credit),0) FROM supplier_account_movements sam
    WHERE sam.supplier_id=s.id AND sam.business_id=s.business_id) AS balance_ledger
FROM suppliers s, biz WHERE s.business_id=biz.id
  AND (SELECT COALESCE(SUM(pending_amount),0) FROM supplier_purchases sp WHERE sp.supplier_id=s.id AND sp.business_id=s.business_id)
   <> (SELECT COALESCE(SUM(debit-credit),0) FROM supplier_account_movements sam WHERE sam.supplier_id=s.id AND sam.business_id=s.business_id);

-- ────────────────────────────────────────────────────────────────────────────
-- C4. STOCK: último movimiento vs stock actual (por producto con movimientos)
--     + drafts con stock descontado (72 el 2026-07-02)
-- ────────────────────────────────────────────────────────────────────────────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid AS id),
last_mov AS (
  SELECT DISTINCT ON (inventory_item_id) inventory_item_id, new_stock, created_at
  FROM inventory_movements m, biz WHERE m.business_id=biz.id
  ORDER BY inventory_item_id, created_at DESC
)
SELECT i.id, i.name, i.stock_quantity, lm.new_stock AS stock_segun_ultimo_movimiento
FROM inventory i JOIN last_mov lm ON lm.inventory_item_id=i.id, biz
WHERE i.business_id=biz.id AND i.stock_quantity <> lm.new_stock;

WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid AS id)
SELECT count(DISTINCT c.id) AS drafts_con_stock_descontado
FROM comprobantes c JOIN comprobante_items ci ON ci.comprobante_id=c.id, biz
WHERE c.business_id=biz.id AND c.status='draft' AND ci.stock_processed=true;

-- ────────────────────────────────────────────────────────────────────────────
-- C5. COGS: costo de ítems vendidos (emitidos) vs costos registrados en BFE
--     Estado: FALLA — BFE(mercaderia+inventario+compras_proveedor+repuestos)=$2,93M
--             vs COGS real $2,26M (doble conteo compras/COGS)
-- ────────────────────────────────────────────────────────────────────────────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid AS id)
SELECT
  (SELECT ROUND(COALESCE(SUM(ci.costo_total),0)) FROM comprobante_items ci
     JOIN comprobantes c ON c.id=ci.comprobante_id, biz
   WHERE ci.business_id=biz.id AND c.status='issued') AS cogs_real_items,
  (SELECT ROUND(COALESCE(SUM(amount_ars),0)) FROM business_finance_entries e, biz
   WHERE e.business_id=biz.id AND e.type='variable_cost'
     AND e.category IN ('mercaderia','inventario','compras_proveedor','repuestos')) AS costos_bfe;

-- ────────────────────────────────────────────────────────────────────────────
-- C6. ANULADOS/NC: todo comprobante anulado con ingresos debe tener reverso
--     Estado: FALLA (1 caso: $13.050 sin reversa)
-- ────────────────────────────────────────────────────────────────────────────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid AS id)
SELECT c.id, COALESCE(c.numero_fiscal,c.numero) AS numero, c.total,
       fmi.s AS fm_income, fmr.s AS fm_reversa, bp.s AS bfe_pos, bn.s AS bfe_neg
FROM comprobantes c, biz,
LATERAL (SELECT COALESCE(SUM(amount_ars),0) s FROM financial_movements f WHERE f.comprobante_id=c.id AND f.type='income') fmi,
LATERAL (SELECT COALESCE(SUM(amount_ars),0) s FROM financial_movements f WHERE f.comprobante_id=c.id AND f.sign=-1) fmr,
LATERAL (SELECT COALESCE(SUM(amount_ars),0) s FROM business_finance_entries b WHERE b.reference_comprobante_id=c.id AND b.amount_ars>0 AND b.type='income') bp,
LATERAL (SELECT COALESCE(SUM(amount_ars),0) s FROM business_finance_entries b WHERE b.reference_comprobante_id=c.id AND b.amount_ars<0) bn
WHERE c.business_id=biz.id AND (c.estado='anulado' OR c.estado_comercial='anulado')
  AND ((fmi.s>0 AND fmr.s=0) OR (bp.s>0 AND bn.s=0));

-- ────────────────────────────────────────────────────────────────────────────
-- C7. total_cobrado materializado = Σ pagos reales (invariante del sync trigger)
--     Estado: 2 filas legacy (abril, pre-RPC)
-- ────────────────────────────────────────────────────────────────────────────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid AS id)
SELECT c.id, COALESCE(c.numero_fiscal,c.numero) AS numero, c.estado_comercial,
       c.total_cobrado, p.s AS suma_pagos
FROM comprobantes c, biz,
LATERAL (SELECT COALESCE(SUM(amount_ars),0) s FROM comprobante_payments cp WHERE cp.comprobante_id=c.id) p
WHERE c.business_id=biz.id AND abs(COALESCE(c.total_cobrado,0) - p.s) > 1;

-- ────────────────────────────────────────────────────────────────────────────
-- C8. HUÉRFANOS y movimientos fuera de sesión de caja
--     Estado: 0 huérfanos FK ✅ · 24 FM sin caja_id ($3,6M) ❌
-- ────────────────────────────────────────────────────────────────────────────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid AS id)
SELECT
  (SELECT count(*) FROM financial_movements f, biz WHERE f.business_id=biz.id
     AND f.comprobante_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM comprobantes c WHERE c.id=f.comprobante_id)) AS fm_huerfanos,
  (SELECT count(*) FROM business_finance_entries e, biz WHERE e.business_id=biz.id
     AND e.reference_comprobante_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM comprobantes c WHERE c.id=e.reference_comprobante_id)) AS bfe_huerfanos,
  (SELECT count(*) FROM financial_movements f, biz WHERE f.business_id=biz.id AND f.caja_id IS NULL) AS fm_sin_caja,
  (SELECT ROUND(COALESCE(SUM(amount_ars),0)) FROM financial_movements f, biz WHERE f.business_id=biz.id AND f.caja_id IS NULL) AS fm_sin_caja_monto;

-- ────────────────────────────────────────────────────────────────────────────
-- C9. Duplicados de FM por pago de orden (trigger + insert manual de la UI)
-- ────────────────────────────────────────────────────────────────────────────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid AS id)
SELECT source_id, count(*) n, SUM(amount_ars) total
FROM financial_movements fm, biz
WHERE fm.business_id=biz.id AND fm.source='payment' AND fm.source_id IS NOT NULL
GROUP BY source_id HAVING count(*) > 1;

-- ────────────────────────────────────────────────────────────────────────────
-- C10. Los tres libros deben contar la misma plata cobrada
--      Estado: FALLA — pagos $10.694.159 · BFE income $10.565.057 · FM income $9.030.927
-- ────────────────────────────────────────────────────────────────────────────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid AS id)
SELECT
  (SELECT ROUND(COALESCE(SUM(amount_ars),0)) FROM comprobante_payments p, biz
     WHERE p.business_id=biz.id AND p.payment_method!='cuenta_corriente') AS cobrado_pagos,
  (SELECT ROUND(COALESCE(SUM(amount_ars),0)) FROM business_finance_entries e, biz
     WHERE e.business_id=biz.id AND e.type='income') AS cobrado_bfe,
  (SELECT ROUND(COALESCE(SUM(amount_ars),0)) FROM financial_movements f, biz
     WHERE f.business_id=biz.id AND f.type='income' AND COALESCE(f.sign,1)=1) AS cobrado_fm;

-- ────────────────────────────────────────────────────────────────────────────
-- C11. TIMEZONE: pagos cuya fecha (UTC) difiere del día argentino real
--      Estado: 8 filas
-- ────────────────────────────────────────────────────────────────────────────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid AS id)
SELECT p.id, p.date AS fecha_guardada,
       (p.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date AS dia_argentino,
       p.amount_ars
FROM comprobante_payments p, biz
WHERE p.business_id=biz.id
  AND p.date <> (p.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date;

-- ────────────────────────────────────────────────────────────────────────────
-- C12. MONEDA: TC congelado por producto vs TC vigente + ítems vendidos sin costo
--      Estado: 475 productos a 1490 (TC hoy 1541) · 5 ítems sin costo ($71.190)
-- ────────────────────────────────────────────────────────────────────────────
WITH biz AS (SELECT 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid AS id)
SELECT
  (SELECT count(*) FROM inventory i, biz WHERE i.business_id=biz.id AND i.base_currency='USD' AND i.is_active
     AND i.exchange_rate_used < (SELECT rate FROM exchange_rates e WHERE e.business_id=biz.id AND base_currency='USD' ORDER BY updated_at DESC LIMIT 1) * 0.98) AS productos_usd_tc_viejo,
  (SELECT count(*) FROM comprobante_items ci JOIN comprobantes c ON c.id=ci.comprobante_id, biz
     WHERE ci.business_id=biz.id AND c.status='issued' AND ci.inventory_id IS NOT NULL
       AND COALESCE(ci.costo_unitario,0)=0 AND ci.tipo_linea IN ('producto','repuesto')) AS items_vendidos_sin_costo;
