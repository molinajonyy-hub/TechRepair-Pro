/**
 * M8 — especificación ejecutable de las 10 reglas de insights.
 *
 * El motor vive en SQL (20260806130000_finance_insights.sql). Este archivo NO
 * lo reimplementa para la app: las funciones de abajo son una ESPECIFICACIÓN
 * EJECUTABLE que reproduce la fórmula exacta de cada regla, y viven acá adentro
 * a propósito — si estuvieran en src/ serían un segundo calculador financiero,
 * que es justo lo que M8 prohíbe.
 *
 * Aportan dos cosas que un test de snapshot no da:
 *   1. cobertura de bordes (umbral exacto, justo abajo, justo arriba, cero,
 *      negativo, sin datos, división por cero);
 *   2. un check ANTI-DRIFT real: los umbrales se leen del .sql de la migración
 *      y se comparan contra los que usan estos tests. Si alguien cambia un
 *      umbral en SQL y no acá (o al revés), el suite falla.
 *
 * Runner: node:test nativo.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SQL = readFileSync('supabase/migrations/20260806130000_finance_insights.sql', 'utf8')

// ─── Umbrales leídos de la migración (fuente única de verdad) ────────────────
function umbralSql(regla: string, clave: string): number {
  // finance_insight_thresholds() construye un jsonb literal; se extrae el bloque
  // de la regla y dentro de él el par 'clave', valor.
  const bloque = SQL.match(new RegExp(`'${regla}',\\s*jsonb_build_object\\(([\\s\\S]*?)\\)`))
  assert.ok(bloque, `no se encontró el bloque de umbrales de ${regla} en la migración`)
  const par = bloque[1].match(new RegExp(`'${clave}',\\s*(-?[\\d.]+)`))
  assert.ok(par, `no se encontró el umbral ${regla}.${clave} en la migración`)
  return Number(par[1])
}

const T = {
  marginDropPp:   umbralSql('margin_drop_cost', 'margin_drop_pp'),
  cogsRisePp:     umbralSql('margin_drop_cost', 'cogs_rise_pp'),
  salesUpPct:     umbralSql('cash_down_sales_up', 'sales_up_pct'),
  cashDownPct:    umbralSql('cash_down_sales_up', 'cash_down_pct'),
  deadDays:       umbralSql('dead_stock', 'days'),
  deadShare:      umbralSql('dead_stock', 'share'),
  deadMinProd:    umbralSql('dead_stock', 'min_products'),
  wdWindow:       umbralSql('withdrawals_vs_profit', 'window_days'),
  wdShare:        umbralSql('withdrawals_vs_profit', 'share'),
  fcWarn:         umbralSql('fixed_coverage', 'months_warning'),
  fcCrit:         umbralSql('fixed_coverage', 'months_critical'),
  beMinDays:      umbralSql('breakeven_day', 'min_days_observed'),
  beMaxProj:      umbralSql('breakeven_day', 'max_projection_days'),
  scHorizon:      umbralSql('supplier_crunch', 'horizon_days'),
  scMinMaterial:  umbralSql('supplier_crunch', 'min_material_ars'),
  scCovWarn:      umbralSql('supplier_crunch', 'coverage_warning'),
  fxDiffPct:      umbralSql('fx_stale_prices', 'rate_diff_pct'),
  fxShare:        umbralSql('fx_stale_prices', 'share'),
  fxMaxAge:       umbralSql('fx_stale_prices', 'max_rate_age_days'),
  dqCritMin:      umbralSql('data_quality', 'critical_count_min'),
  ccDays:         umbralSql('cc_aging', 'days'),
  ccShare:        umbralSql('cc_aging', 'share'),
  ccConc:         umbralSql('cc_aging', 'concentration_share'),
}

// ─── Especificación ejecutable ──────────────────────────────────────────────
type Res = { fires: boolean; severity?: 'critical' | 'warning' | 'info'; skipped?: string }
const SKIP = (r: string): Res => ({ fires: false, skipped: r })

/** NULLIF(d,0): división que devuelve null en vez de explotar. */
const div = (n: number, d: number): number | null => (d === 0 ? null : n / d)

export function marginDropCost(i: {
  nsCur: number; gpCur: number; cogsCur: number
  nsPrev: number; gpPrev: number; cogsPrev: number
}): Res {
  if (i.nsCur <= 0 || i.nsPrev <= 0) return SKIP('no_sales_in_one_period')
  const mCur = (i.gpCur / i.nsCur) * 100
  const mPrev = (i.gpPrev / i.nsPrev) * 100
  const cCur = (i.cogsCur / i.nsCur) * 100
  const cPrev = (i.cogsPrev / i.nsPrev) * 100
  const fires = (mCur - mPrev) <= -T.marginDropPp && (cCur - cPrev) >= T.cogsRisePp
  return fires ? { fires, severity: 'warning' } : { fires: false }
}

export function cashDownSalesUp(i: {
  nsCur: number; nsPrev: number; cashCur: number; cashPrev: number
}): Res {
  if (i.nsPrev <= 0 || i.cashPrev === 0) return SKIP('no_comparison_base')
  const sD = ((i.nsCur - i.nsPrev) / Math.abs(i.nsPrev)) * 100
  const cD = ((i.cashCur - i.cashPrev) / Math.abs(i.cashPrev)) * 100
  const fires = sD >= T.salesUpPct && cD <= T.cashDownPct
  return fires ? { fires, severity: 'warning' } : { fires: false }
}

export function deadStock(i: { deadValue: number; totalValue: number; totalCount: number }): Res {
  if (i.totalCount < T.deadMinProd || i.totalValue <= 0) return SKIP('insufficient_inventory')
  const share = div(i.deadValue, i.totalValue)
  if (share === null) return SKIP('insufficient_inventory')
  return share > T.deadShare ? { fires: true, severity: 'warning' } : { fires: false }
}

export function withdrawalsVsProfit(i: { withdrawals: number; result: number }): Res {
  if (i.result <= 0) return SKIP('non_positive_result')
  const share = div(i.withdrawals, i.result)
  if (share === null) return SKIP('non_positive_result')
  return share > T.wdShare ? { fires: true, severity: 'warning' } : { fires: false }
}

export function fixedCoverage(i: { cash: number; fixedMonthly: number; recurringCount: number; missingRate?: boolean }): Res {
  if (i.recurringCount === 0) return SKIP('no_recurring_expenses')
  if (i.missingRate || i.fixedMonthly <= 0) return SKIP('missing_exchange_rate')
  const cov = div(i.cash, i.fixedMonthly)
  if (cov === null) return SKIP('missing_exchange_rate')
  if (cov >= T.fcWarn) return { fires: false }
  return { fires: true, severity: cov < T.fcCrit ? 'critical' : 'warning' }
}

export function breakevenDay(i: {
  recurringCount: number; fixedMonthly: number; daysObserved: number
  mtdSales: number; mtdGrossProfit: number; projectionDays: number
}): Res {
  if (i.recurringCount === 0 || i.fixedMonthly <= 0) return SKIP('no_recurring_expenses')
  if (i.daysObserved < T.beMinDays) return SKIP('insufficient_days_observed')
  const cm = div(i.mtdGrossProfit, i.mtdSales)
  if (cm === null || cm <= 0) return SKIP('non_positive_contribution_margin')
  if (i.projectionDays > T.beMaxProj) return SKIP('projection_out_of_range')
  return { fires: true, severity: 'info' }
}

export function supplierCrunch(i: {
  overdue: number; dueNext14: number; liquidity: number; datedCount: number
}): Res {
  if (i.datedCount === 0) return SKIP('insufficient_due_dates')
  const near = i.overdue + i.dueNext14
  if (near < T.scMinMaterial) return SKIP('below_materiality')
  const cov = near > 0 ? i.liquidity / near : null
  if (near > i.liquidity) return { fires: true, severity: 'critical' }
  if (cov !== null && cov < T.scCovWarn) return { fires: true, severity: 'warning' }
  return { fires: false }
}

export function fxStalePrices(i: {
  rate: number | null; rateAgeDays: number; usdTotal: number; staleCount: number
}): Res {
  if (i.rate === null || i.rate <= 0) return SKIP('no_reference_rate')
  if (i.rateAgeDays > T.fxMaxAge) return SKIP('stale_reference_rate')
  if (i.usdTotal === 0) return SKIP('no_usd_products')
  const share = div(i.staleCount, i.usdTotal)
  if (share === null) return SKIP('no_usd_products')
  return i.staleCount >= 1 && share >= T.fxShare ? { fires: true, severity: 'warning' } : { fires: false }
}

export function dataQuality(i: { ok: boolean; criticalCount: number; amountAtRisk: number }): Res {
  if (!i.ok) return SKIP('health_check_unavailable')
  if (i.criticalCount < T.dqCritMin) return SKIP('no_critical_issues')
  return { fires: true, severity: i.amountAtRisk > 0 ? 'critical' : 'warning' }
}

export function ccAging(i: { overdue30plus: number; receivablesTotal: number }): Res {
  if (i.receivablesTotal <= 0) return SKIP('no_receivables')
  const share = div(i.overdue30plus, i.receivablesTotal)
  if (share === null) return SKIP('no_receivables')
  return i.overdue30plus > 0 && share >= T.ccShare
    ? { fires: true, severity: 'warning' }
    : { fires: false, skipped: 'below_threshold' }
}

// ════════════════════════════════════════════════════════════════════════════
// ANTI-DRIFT — los umbrales del SQL son exactamente los documentados
// ════════════════════════════════════════════════════════════════════════════
test('anti-drift: los umbrales v1 del SQL son los documentados', () => {
  assert.equal(T.marginDropPp, 3.0)
  assert.equal(T.cogsRisePp, 1.0)
  assert.equal(T.salesUpPct, 10.0)
  assert.equal(T.cashDownPct, -5.0)
  assert.equal(T.deadDays, 90)
  assert.equal(T.deadShare, 0.20)
  assert.equal(T.wdShare, 0.70)
  assert.equal(T.wdWindow, 90)
  assert.equal(T.fcWarn, 1.0)
  assert.equal(T.fcCrit, 0.5)
  assert.equal(T.beMinDays, 10)
  assert.equal(T.scHorizon, 14)
  assert.equal(T.scMinMaterial, 50000)
  assert.equal(T.fxDiffPct, 2.0)
  assert.equal(T.fxShare, 0.10)
  assert.equal(T.fxMaxAge, 7)
  assert.equal(T.dqCritMin, 1)
  assert.equal(T.ccDays, 30)
  assert.equal(T.ccShare, 0.30)
  assert.equal(T.ccConc, 0.60)
})

test('anti-drift: el catálogo del SQL tiene exactamente 10 reglas', () => {
  const m = SQL.match(/rule_id IN \(([\s\S]*?)\)\)/)
  assert.ok(m)
  const reglas = [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map(x => x[1])
  assert.equal(reglas.length, 10, `se esperaban 10 reglas, hay ${reglas.length}: ${reglas}`)
  assert.deepEqual([...reglas].sort(), [
    'breakeven_day', 'cash_down_sales_up', 'cc_aging', 'data_quality', 'dead_stock',
    'fixed_coverage', 'fx_stale_prices', 'margin_drop_cost', 'supplier_crunch', 'withdrawals_vs_profit',
  ])
})

// ════════════════════════════════════════════════════════════════════════════
// R1 margin_drop_cost
// ════════════════════════════════════════════════════════════════════════════
test('margin_drop_cost: dispara cuando cae el margen Y sube el COGS relativo', () => {
  // margen 40% -> 36% (-4pp); cogs 60% -> 64% (+4pp)
  const r = marginDropCost({ nsCur: 100, gpCur: 36, cogsCur: 64, nsPrev: 100, gpPrev: 40, cogsPrev: 60 })
  assert.equal(r.fires, true)
  assert.equal(r.severity, 'warning')
})

test('margin_drop_cost: NO confunde caída de volumen con caída de margen', () => {
  // vendió la mitad, pero los ratios son idénticos
  const r = marginDropCost({ nsCur: 50, gpCur: 20, cogsCur: 30, nsPrev: 100, gpPrev: 40, cogsPrev: 60 })
  assert.equal(r.fires, false)
})

test('margin_drop_cost: umbral exacto (-3pp y +1pp) dispara', () => {
  const r = marginDropCost({ nsCur: 100, gpCur: 37, cogsCur: 63, nsPrev: 100, gpPrev: 40, cogsPrev: 62 })
  assert.equal(r.fires, true)
})

test('margin_drop_cost: justo por debajo del umbral NO dispara', () => {
  // -2.9pp de margen
  const r = marginDropCost({ nsCur: 100, gpCur: 37.1, cogsCur: 62.9, nsPrev: 100, gpPrev: 40, cogsPrev: 60 })
  assert.equal(r.fires, false)
})

test('margin_drop_cost: margen cae pero el COGS relativo NO sube -> no dispara', () => {
  // el margen cae por gastos, no por costo de mercadería
  const r = marginDropCost({ nsCur: 100, gpCur: 30, cogsCur: 59, nsPrev: 100, gpPrev: 40, cogsPrev: 60 })
  assert.equal(r.fires, false)
})

test('margin_drop_cost: sin ventas en algún período se omite (no divide por cero)', () => {
  assert.equal(marginDropCost({ nsCur: 0, gpCur: 0, cogsCur: 0, nsPrev: 100, gpPrev: 40, cogsPrev: 60 }).skipped, 'no_sales_in_one_period')
  assert.equal(marginDropCost({ nsCur: 100, gpCur: 40, cogsCur: 60, nsPrev: 0, gpPrev: 0, cogsPrev: 0 }).skipped, 'no_sales_in_one_period')
})

test('margin_drop_cost: ventas negativas (devoluciones netas) se omiten', () => {
  assert.equal(marginDropCost({ nsCur: -50, gpCur: -10, cogsCur: 5, nsPrev: 100, gpPrev: 40, cogsPrev: 60 }).skipped, 'no_sales_in_one_period')
})

// ════════════════════════════════════════════════════════════════════════════
// R2 cash_down_sales_up
// ════════════════════════════════════════════════════════════════════════════
test('cash_down_sales_up: ventas +18% y caja -10% dispara', () => {
  const r = cashDownSalesUp({ nsCur: 118, nsPrev: 100, cashCur: 90, cashPrev: 100 })
  assert.equal(r.fires, true)
})

test('cash_down_sales_up: umbral exacto (+10% / -5%) dispara', () => {
  const r = cashDownSalesUp({ nsCur: 110, nsPrev: 100, cashCur: 95, cashPrev: 100 })
  assert.equal(r.fires, true)
})

test('cash_down_sales_up: justo por debajo NO dispara', () => {
  assert.equal(cashDownSalesUp({ nsCur: 109.9, nsPrev: 100, cashCur: 95, cashPrev: 100 }).fires, false)
  assert.equal(cashDownSalesUp({ nsCur: 110, nsPrev: 100, cashCur: 95.1, cashPrev: 100 }).fires, false)
})

test('cash_down_sales_up: ambas suben -> no dispara', () => {
  assert.equal(cashDownSalesUp({ nsCur: 130, nsPrev: 100, cashCur: 120, cashPrev: 100 }).fires, false)
})

test('cash_down_sales_up: sin base de comparación se omite', () => {
  assert.equal(cashDownSalesUp({ nsCur: 100, nsPrev: 0, cashCur: 10, cashPrev: 10 }).skipped, 'no_comparison_base')
  assert.equal(cashDownSalesUp({ nsCur: 100, nsPrev: 100, cashCur: 10, cashPrev: 0 }).skipped, 'no_comparison_base')
})

// ════════════════════════════════════════════════════════════════════════════
// R3 dead_stock
// ════════════════════════════════════════════════════════════════════════════
test('dead_stock: 27% inmovilizado dispara', () => {
  assert.equal(deadStock({ deadValue: 27, totalValue: 100, totalCount: 10 }).fires, true)
})

test('dead_stock: umbral exacto 20% NO dispara (es > estricto)', () => {
  assert.equal(deadStock({ deadValue: 20, totalValue: 100, totalCount: 10 }).fires, false)
})

test('dead_stock: apenas por encima del 20% dispara', () => {
  assert.equal(deadStock({ deadValue: 20.01, totalValue: 100, totalCount: 10 }).fires, true)
})

test('dead_stock: con pocos productos se omite (muestra insuficiente)', () => {
  assert.equal(deadStock({ deadValue: 90, totalValue: 100, totalCount: 4 }).skipped, 'insufficient_inventory')
})

test('dead_stock: inventario valorizado en cero se omite (no divide por cero)', () => {
  assert.equal(deadStock({ deadValue: 0, totalValue: 0, totalCount: 10 }).skipped, 'insufficient_inventory')
})

test('dead_stock: cero inmovilizado no dispara', () => {
  assert.equal(deadStock({ deadValue: 0, totalValue: 100, totalCount: 10 }).fires, false)
})

// ════════════════════════════════════════════════════════════════════════════
// R4 withdrawals_vs_profit
// ════════════════════════════════════════════════════════════════════════════
test('withdrawals_vs_profit: 88% del resultado dispara', () => {
  assert.equal(withdrawalsVsProfit({ withdrawals: 88, result: 100 }).fires, true)
})

test('withdrawals_vs_profit: umbral exacto 70% NO dispara', () => {
  assert.equal(withdrawalsVsProfit({ withdrawals: 70, result: 100 }).fires, false)
})

test('withdrawals_vs_profit: apenas por encima dispara', () => {
  assert.equal(withdrawalsVsProfit({ withdrawals: 70.01, result: 100 }).fires, true)
})

test('withdrawals_vs_profit: resultado negativo o cero se omite (ratio sin sentido)', () => {
  assert.equal(withdrawalsVsProfit({ withdrawals: 100, result: 0 }).skipped, 'non_positive_result')
  assert.equal(withdrawalsVsProfit({ withdrawals: 100, result: -500 }).skipped, 'non_positive_result')
})

test('withdrawals_vs_profit: sin retiros no dispara', () => {
  assert.equal(withdrawalsVsProfit({ withdrawals: 0, result: 100 }).fires, false)
})

// ════════════════════════════════════════════════════════════════════════════
// R5 fixed_coverage
// ════════════════════════════════════════════════════════════════════════════
test('fixed_coverage: 0.8 meses dispara warning', () => {
  const r = fixedCoverage({ cash: 80, fixedMonthly: 100, recurringCount: 3 })
  assert.equal(r.fires, true); assert.equal(r.severity, 'warning')
})

test('fixed_coverage: por debajo de 0.5 escala a critical', () => {
  const r = fixedCoverage({ cash: 40, fixedMonthly: 100, recurringCount: 3 })
  assert.equal(r.severity, 'critical')
})

test('fixed_coverage: umbral exacto 1.0 mes NO dispara', () => {
  assert.equal(fixedCoverage({ cash: 100, fixedMonthly: 100, recurringCount: 3 }).fires, false)
})

test('fixed_coverage: 0.5 exacto es warning, no critical (es < estricto)', () => {
  assert.equal(fixedCoverage({ cash: 50, fixedMonthly: 100, recurringCount: 3 }).severity, 'warning')
})

test('fixed_coverage: SIN recurrentes cargados se omite — no se estima desde el P&L', () => {
  assert.equal(fixedCoverage({ cash: 0, fixedMonthly: 0, recurringCount: 0 }).skipped, 'no_recurring_expenses')
})

test('fixed_coverage: recurrente en USD sin cotización se omite', () => {
  assert.equal(fixedCoverage({ cash: 100, fixedMonthly: 0, recurringCount: 2, missingRate: true }).skipped, 'missing_exchange_rate')
})

test('fixed_coverage: caja en cero con fijos > 0 es critical, no un error', () => {
  const r = fixedCoverage({ cash: 0, fixedMonthly: 100, recurringCount: 1 })
  assert.equal(r.fires, true); assert.equal(r.severity, 'critical')
})

// ════════════════════════════════════════════════════════════════════════════
// R6 breakeven_day
// ════════════════════════════════════════════════════════════════════════════
test('breakeven_day: con datos suficientes emite info (estimación)', () => {
  const r = breakevenDay({ recurringCount: 2, fixedMonthly: 100, daysObserved: 15, mtdSales: 500, mtdGrossProfit: 200, projectionDays: 20 })
  assert.equal(r.fires, true); assert.equal(r.severity, 'info')
})

test('breakeven_day: umbral exacto de días observados (10) alcanza', () => {
  assert.equal(breakevenDay({ recurringCount: 2, fixedMonthly: 100, daysObserved: 10, mtdSales: 500, mtdGrossProfit: 200, projectionDays: 20 }).fires, true)
})

test('breakeven_day: con 9 días observados se omite', () => {
  assert.equal(breakevenDay({ recurringCount: 2, fixedMonthly: 100, daysObserved: 9, mtdSales: 500, mtdGrossProfit: 200, projectionDays: 20 }).skipped, 'insufficient_days_observed')
})

test('breakeven_day: margen de contribución <= 0 se omite (no proyecta)', () => {
  assert.equal(breakevenDay({ recurringCount: 2, fixedMonthly: 100, daysObserved: 20, mtdSales: 500, mtdGrossProfit: -50, projectionDays: 20 }).skipped, 'non_positive_contribution_margin')
  assert.equal(breakevenDay({ recurringCount: 2, fixedMonthly: 100, daysObserved: 20, mtdSales: 500, mtdGrossProfit: 0, projectionDays: 20 }).skipped, 'non_positive_contribution_margin')
})

test('breakeven_day: sin ventas no divide por cero, se omite', () => {
  assert.equal(breakevenDay({ recurringCount: 2, fixedMonthly: 100, daysObserved: 20, mtdSales: 0, mtdGrossProfit: 0, projectionDays: 20 }).skipped, 'non_positive_contribution_margin')
})

test('breakeven_day: proyección fuera de rango se omite', () => {
  assert.equal(breakevenDay({ recurringCount: 2, fixedMonthly: 100, daysObserved: 20, mtdSales: 500, mtdGrossProfit: 200, projectionDays: 121 }).skipped, 'projection_out_of_range')
})

test('breakeven_day: sin recurrentes se omite', () => {
  assert.equal(breakevenDay({ recurringCount: 0, fixedMonthly: 0, daysObserved: 20, mtdSales: 500, mtdGrossProfit: 200, projectionDays: 20 }).skipped, 'no_recurring_expenses')
})

// ════════════════════════════════════════════════════════════════════════════
// R7 supplier_crunch
// ════════════════════════════════════════════════════════════════════════════
test('supplier_crunch: compromisos > liquidez dispara critical', () => {
  const r = supplierCrunch({ overdue: 200000, dueNext14: 150000, liquidity: 100000, datedCount: 3 })
  assert.equal(r.fires, true); assert.equal(r.severity, 'critical')
})

test('supplier_crunch: cubierto pero con poco margen dispara warning', () => {
  const r = supplierCrunch({ overdue: 0, dueNext14: 100000, liquidity: 140000, datedCount: 1 })
  assert.equal(r.fires, true); assert.equal(r.severity, 'warning')
})

test('supplier_crunch: cobertura holgada NO dispara', () => {
  assert.equal(supplierCrunch({ overdue: 0, dueNext14: 100000, liquidity: 200000, datedCount: 1 }).fires, false)
})

test('supplier_crunch: NO dispara sólo porque exista deuda', () => {
  // deuda material y cobertura 2x: no hay crunch
  assert.equal(supplierCrunch({ overdue: 300000, dueNext14: 0, liquidity: 900000, datedCount: 5 }).fires, false)
})

test('supplier_crunch: sin due_dates se omite — NO se asume que lo sin fecha vence ya', () => {
  const r = supplierCrunch({ overdue: 0, dueNext14: 0, liquidity: 0, datedCount: 0 })
  assert.equal(r.fires, false)
  assert.equal(r.skipped, 'insufficient_due_dates')
})

test('supplier_crunch: por debajo de la materialidad se omite', () => {
  assert.equal(supplierCrunch({ overdue: 10000, dueNext14: 5000, liquidity: 0, datedCount: 2 }).skipped, 'below_materiality')
})

test('supplier_crunch: materialidad exacta (50.000) ya evalúa', () => {
  const r = supplierCrunch({ overdue: 50000, dueNext14: 0, liquidity: 0, datedCount: 1 })
  assert.equal(r.fires, true); assert.equal(r.severity, 'critical')
})

// ════════════════════════════════════════════════════════════════════════════
// R8 fx_stale_prices
// ════════════════════════════════════════════════════════════════════════════
test('fx_stale_prices: 20% del catálogo desactualizado dispara', () => {
  assert.equal(fxStalePrices({ rate: 1541, rateAgeDays: 1, usdTotal: 100, staleCount: 20 }).fires, true)
})

test('fx_stale_prices: umbral exacto 10% dispara', () => {
  assert.equal(fxStalePrices({ rate: 1541, rateAgeDays: 1, usdTotal: 100, staleCount: 10 }).fires, true)
})

test('fx_stale_prices: justo por debajo NO dispara', () => {
  assert.equal(fxStalePrices({ rate: 1541, rateAgeDays: 1, usdTotal: 100, staleCount: 9 }).fires, false)
})

test('fx_stale_prices: cotización de referencia vieja se omite (no compara contra basura)', () => {
  assert.equal(fxStalePrices({ rate: 1541, rateAgeDays: 8, usdTotal: 100, staleCount: 50 }).skipped, 'stale_reference_rate')
})

test('fx_stale_prices: sin cotización cargada se omite (nunca llama a una API)', () => {
  assert.equal(fxStalePrices({ rate: null, rateAgeDays: 0, usdTotal: 100, staleCount: 50 }).skipped, 'no_reference_rate')
  assert.equal(fxStalePrices({ rate: 0, rateAgeDays: 0, usdTotal: 100, staleCount: 50 }).skipped, 'no_reference_rate')
})

test('fx_stale_prices: sin productos en dólares se omite (no divide por cero)', () => {
  assert.equal(fxStalePrices({ rate: 1541, rateAgeDays: 1, usdTotal: 0, staleCount: 0 }).skipped, 'no_usd_products')
})

// ════════════════════════════════════════════════════════════════════════════
// R9 data_quality
// ════════════════════════════════════════════════════════════════════════════
test('data_quality: con el baseline productivo (critical=0) NO dispara', () => {
  // ok=true, critical_count=0, amount_at_risk=0, warning=5, low=2, overall=warn
  const r = dataQuality({ ok: true, criticalCount: 0, amountAtRisk: 0 })
  assert.equal(r.fires, false)
  assert.equal(r.skipped, 'no_critical_issues')
})

test('data_quality: critical>0 sin monto en riesgo es warning', () => {
  const r = dataQuality({ ok: true, criticalCount: 2, amountAtRisk: 0 })
  assert.equal(r.fires, true); assert.equal(r.severity, 'warning')
})

test('data_quality: critical>0 CON monto en riesgo escala a critical', () => {
  const r = dataQuality({ ok: true, criticalCount: 1, amountAtRisk: 149438 })
  assert.equal(r.fires, true); assert.equal(r.severity, 'critical')
})

test('data_quality: los warnings legacy NUNCA se vuelven critical', () => {
  // 5 warnings + 2 low, cero críticos: el overall_status del health check es
  // 'warn', pero la regla no lo mira.
  assert.equal(dataQuality({ ok: true, criticalCount: 0, amountAtRisk: 0 }).fires, false)
})

test('data_quality: health check caído se omite, no se inventa un estado', () => {
  assert.equal(dataQuality({ ok: false, criticalCount: 0, amountAtRisk: 0 }).skipped, 'health_check_unavailable')
})

// ════════════════════════════════════════════════════════════════════════════
// R10 cc_aging
// ════════════════════════════════════════════════════════════════════════════
test('cc_aging: 40% con más de 30 días dispara', () => {
  assert.equal(ccAging({ overdue30plus: 40, receivablesTotal: 100 }).fires, true)
})

test('cc_aging: umbral exacto 30% dispara', () => {
  assert.equal(ccAging({ overdue30plus: 30, receivablesTotal: 100 }).fires, true)
})

test('cc_aging: justo por debajo NO dispara', () => {
  assert.equal(ccAging({ overdue30plus: 29.99, receivablesTotal: 100 }).fires, false)
})

test('cc_aging: sin CxC se omite (no divide por cero)', () => {
  assert.equal(ccAging({ overdue30plus: 0, receivablesTotal: 0 }).skipped, 'no_receivables')
})

test('cc_aging: nada vencido no dispara', () => {
  assert.equal(ccAging({ overdue30plus: 0, receivablesTotal: 100 }).fires, false)
})

// ════════════════════════════════════════════════════════════════════════════
// Textos: contrato de redacción verificable sobre el SQL
// ════════════════════════════════════════════════════════════════════════════
// El motor VIGENTE es 217: 216 quedó como historia aplicada e inmutable, así que
// los contratos de redacción se verifican contra el cuerpo que corre hoy.
const SQL_MOTOR = readFileSync(
  'supabase/migrations/20260807120000_finance_insight_locale_safe_messages.sql', 'utf8')

test('cc_aging no usa la palabra "vencido" en su texto (no hay due_date de CxC)', () => {
  const i = SQL_MOTOR.indexOf("'rule_id','cc_aging'")
  assert.ok(i > 0)
  const bloque = SQL_MOTOR.slice(i, i + 2500)
  assert.ok(!/vencid/i.test(bloque), 'el texto de cc_aging no puede hablar de vencimiento')
  assert.ok(/antigüedad/i.test(bloque), 'debe hablar de antigüedad')
})

test('breakeven_day se rotula siempre como estimación', () => {
  const i = SQL_MOTOR.indexOf("'rule_id','breakeven_day'")
  assert.ok(i > 0)
  assert.ok(/Estimación/i.test(SQL_MOTOR.slice(i, i + 2000)))
})

test('supplier_crunch no afirma que la deuda sin fecha vence pronto', () => {
  const i = SQL_MOTOR.indexOf("'rule_id','supplier_crunch'")
  const bloque = SQL_MOTOR.slice(i, i + 2500)
  assert.ok(/undated_pending_amount/.test(bloque), 'lo sin fecha viaja como contexto separado')
  assert.ok(!/toda la deuda/i.test(bloque))
  assert.ok(/sin fecha acordada no se cuenta/i.test(bloque),
    'debe decir explicitamente que lo sin fecha no es compromiso proximo')
})

test('el motor vigente no formatea ningun numero (los formatea el frontend)', () => {
  const cuerpo = SQL_MOTOR.split('$fn$')[1] || ''
  assert.ok(cuerpo.length > 1000)
  assert.ok(!/to_char/i.test(cuerpo), 'to_char depende de lc_numeric del servidor')
  assert.ok(!/'message',\s*format\(/.test(cuerpo), 'message no puede interpolar valores')
})
