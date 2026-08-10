/**
 * M8 - presentacion localizada de insights.
 *
 * El motor corre con lc_numeric = en_US en produccion, asi que todo numero
 * formateado en SQL salia como "10,823,941.50". Estos tests fijan que el
 * frontend es la unica autoridad de formato y que produce es-AR siempre.
 *
 * Runner: node:test nativo.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatARS, formatUSD, formatNumber, formatPercent, formatDate, formatDays,
  formatCount, presentInsight, AUSENTE,
} from '../../src/lib/finance/financeInsightPresentation.ts'
import type { FinanceInsight, InsightRuleId } from '../../src/services/insightsService.ts'

/** El separador de miles de es-AR es U+002E y el decimal U+002C. Intl puede
 *  emitir NBSP entre el simbolo y el numero: se normaliza para comparar. */
const norm = (s: string) => s.replace(/ /g, ' ').replace(/ /g, ' ')

// ==========================================================================
// Helpers de formato
// ==========================================================================
test('formatARS: el importe del incidente sale en es-AR, no en en-US', () => {
  const out = norm(formatARS(10823941.50))
  assert.match(out, /10\.823\.941,50/)
  assert.ok(!out.includes('10,823,941.50'), `no debe salir en en-US: ${out}`)
})

test('formatARS: cotizaciones del incidente', () => {
  assert.match(norm(formatARS(1490)), /1\.490,00/)
  assert.match(norm(formatARS(1546)), /1\.546,00/)
})

test('formatARS: cero, negativos y decimales', () => {
  assert.match(norm(formatARS(0)), /0,00/)
  assert.match(norm(formatARS(-5000.25)), /-\s?\$?\s?5\.000,25/)
  assert.match(norm(formatARS(0.5)), /0,5/)
})

test('formatARS: valores no numericos nunca producen NaN', () => {
  for (const v of [null, undefined, NaN, Infinity, 'x', {}]) {
    assert.equal(formatARS(v as unknown), AUSENTE)
  }
})

test('formatUSD: usa es-AR como locale y USD como moneda', () => {
  const out = norm(formatUSD(1490))
  assert.match(out, /1\.490,00/)
  assert.ok(/US\$|USD|\$/.test(out), `debe indicar moneda: ${out}`)
})

test('formatNumber: separadores es-AR sin simbolo de moneda', () => {
  assert.equal(norm(formatNumber(10823941.5)), '10.823.941,5')
  assert.equal(formatNumber(348, 0), '348')
  assert.equal(formatNumber(null), AUSENTE)
})

test('formatPercent: proporcion 0-1 y puntos 0-100', () => {
  assert.equal(formatPercent(0), '0%')
  assert.equal(formatPercent(0.02), '2%')
  assert.equal(formatPercent(0.105), '10,5%')
  assert.equal(formatPercent(1), '100%')
  // ya100: el valor ya viene en puntos porcentuales
  assert.equal(formatPercent(0, { ya100: true }), '0%')
  assert.equal(formatPercent(2, { ya100: true }), '2%')
  assert.equal(formatPercent(10.5, { ya100: true }), '10,5%')
  assert.equal(formatPercent(100, { ya100: true }), '100%')
  assert.equal(formatPercent(undefined), AUSENTE)
})

test('formatDate: TZ Argentina sin corrimiento de dia', () => {
  // Sin anclar al mediodia, un offset -03 devuelve el dia anterior.
  assert.equal(formatDate('2026-08-07'), '7/8/2026')
  assert.equal(formatDate('2026-01-01'), '1/1/2026')
  assert.equal(formatDate('2026-12-31'), '31/12/2026')
  assert.equal(formatDate('no-es-fecha'), AUSENTE)
  assert.equal(formatDate(null), AUSENTE)
})

test('formatDays y formatCount: singular y plural', () => {
  assert.equal(formatDays(90), '90 días')
  assert.equal(formatDays(1), '1 día')
  assert.equal(formatDays(null), AUSENTE)
  assert.equal(formatCount(348, 'producto', 'productos'), '348 productos')
  assert.equal(formatCount(1, 'producto', 'productos'), '1 producto')
  assert.equal(formatCount(1000, 'concepto', 'conceptos'), '1.000 conceptos')
})

// ==========================================================================
// Presentacion por regla
// ==========================================================================
const baseEvidence = {
  metric: 'm', threshold: {}, period_start: '2026-08-01', period_end: '2026-08-07',
  currency: 'ARS', source: 's', calculation_version: 'v1', current_value: 0,
}

function insight(rule_id: InsightRuleId, evidence: Record<string, unknown>): FinanceInsight {
  return {
    id: 'x', rule_id, rule_version: 'v1',
    period_start: '2026-08-01', period_end: '2026-08-07',
    severity: 'warning', title: 'T',
    message: 'FALLBACK DEL SERVER',
    evidence: { ...baseEvidence, ...evidence } as FinanceInsight['evidence'],
    action: { label: 'a', target_type: 'none', target: '' },
    status: 'active', impact_ars: 0,
    generated_at: '2026-08-07T12:00:00Z', resolved_at: null,
  }
}

const FIXTURES: Record<InsightRuleId, Record<string, unknown>> = {
  margin_drop_cost: { current_value: 70.02, comparison_value: 83.53, cogs_ratio_current: 29.98, cogs_ratio_previous: 16.47, net_sales_current: 474345.12 },
  cash_down_sales_up: { sales_delta_percent: 18.4, delta_percent: -12.7, accrued_revenue: 519000, collected_cash: 449000, comparison_value: 514000, accounts_receivable_delta: 25100 },
  dead_stock: { current_value: 0.595, dead_value: 10823941.50, inventory_at_cost: 18179810, dead_product_count: 348, total_product_count: 531, days_threshold: 90 },
  withdrawals_vs_profit: { current_value: 0.88, withdrawals_total: 880000, operating_result: 1000000, window_days: 90 },
  fixed_coverage: { current_value: 0.8, cash_total: 480000, fixed_monthly: 600000, recurring_count: 12 },
  breakeven_day: { current_value: '2026-08-21', days_observed: 15, fixed_monthly: 600000, breakeven_sales: 1200000, daily_avg_sales: 80000, contribution_margin_pct: 50 },
  supplier_crunch: { current_value: 0.28, overdue_amount: 200000, due_next_14_days: 150000, total_near_term_commitments: 350000, available_liquidity: 100000, coverage_ratio: 0.2857, dated_purchase_count: 3, undated_pending_amount: 700000, horizon_days: 14 },
  fx_stale_prices: { current_value: 1, stale_count: 475, total_usd_products: 475, avg_rate_used: 1490, current_rate: 1546, delta_percent: 3.62 },
  data_quality: { current_value: 2, critical_count: 2, amount_at_risk: 149438, warning_count: 5, low_count: 2, checks_total: 74, pass_count: 67 },
  cc_aging: { current_value: 0.42, overdue_30plus: 25100, receivables_total: 59761, bucket_31_60: 10000, bucket_60plus: 15100, top_debtor_count: 2, days_threshold: 30 },
}

const RULES = Object.keys(FIXTURES) as InsightRuleId[]

test('las 10 reglas tienen presentador tipado (no caen al fallback)', () => {
  assert.equal(RULES.length, 10)
  for (const r of RULES) {
    const p = presentInsight(insight(r, FIXTURES[r]))
    assert.equal(p.fallback, false, `${r} cayo al fallback`)
    assert.notEqual(p.message, 'FALLBACK DEL SERVER', `${r} uso el message del server`)
    assert.ok(p.facts.length > 0, `${r} no expone cifras`)
  }
})

test('ninguna regla emite NaN, undefined, JSON ni formato en-US', () => {
  for (const r of RULES) {
    const p = presentInsight(insight(r, FIXTURES[r]))
    const todo = norm([p.message, ...p.facts.map(x => `${x.label} ${x.value}`)].join(' | '))
    assert.ok(!/NaN/.test(todo), `${r} emite NaN: ${todo}`)
    assert.ok(!/undefined/.test(todo), `${r} emite undefined: ${todo}`)
    assert.ok(!/[{}[\]"]/.test(todo), `${r} emite JSON crudo: ${todo}`)
    // patron en-US: miles con coma y decimales con punto
    assert.ok(!/\d,\d{3}\.\d/.test(todo), `${r} emite formato en-US: ${todo}`)
  }
})

test('REGRESION del incidente: dead_stock nunca muestra 10,823,941.50', () => {
  const p = presentInsight(insight('dead_stock', FIXTURES.dead_stock))
  const todo = norm([p.message, ...p.facts.map(x => x.value)].join(' | '))
  assert.ok(!todo.includes('10,823,941.50'), `formato en-US filtrado: ${todo}`)
  assert.match(todo, /10\.823\.941,50/)
})

test('dead_stock: usa evidence precomputada, no recalcula', () => {
  const p = presentInsight(insight('dead_stock', FIXTURES.dead_stock))
  assert.match(p.message, /348 productos/)
  assert.match(norm(p.message), /10\.823\.941,50/)
  assert.match(p.message, /90 días/)
  assert.match(p.message, /59,5%/)   // viene de current_value, no de dead/total
})

test('fx_stale_prices: ambas cotizaciones en es-AR', () => {
  const p = presentInsight(insight('fx_stale_prices', FIXTURES.fx_stale_prices))
  const todo = norm([p.message, ...p.facts.map(x => x.value)].join(' '))
  assert.match(todo, /1\.490,00/)
  assert.match(todo, /1\.546,00/)
  assert.ok(!todo.includes('1,490.00'))
})

test('data_quality: omite el monto cuando amount_at_risk es 0', () => {
  const conRiesgo = presentInsight(insight('data_quality', FIXTURES.data_quality))
  assert.match(norm(conRiesgo.message), /149\.438,00/)
  const sinRiesgo = presentInsight(insight('data_quality', { ...FIXTURES.data_quality, amount_at_risk: 0 }))
  assert.ok(!/comprometen/.test(sinRiesgo.message), sinRiesgo.message)
})

test('breakeven_day: fecha es-AR sin corrimiento y rotulado como estimacion', () => {
  const p = presentInsight(insight('breakeven_day', FIXTURES.breakeven_day))
  assert.match(p.message, /Estimación/)
  assert.match(p.message, /21\/8\/2026/)
})

test('cc_aging: habla de antiguedad, nunca de vencido', () => {
  const p = presentInsight(insight('cc_aging', FIXTURES.cc_aging))
  assert.match(p.message, /antigüedad/i)
  assert.ok(!/vencid/i.test(p.message), p.message)
})

test('supplier_crunch: la deuda sin fecha se muestra aparte del compromiso', () => {
  const p = presentInsight(insight('supplier_crunch', FIXTURES.supplier_crunch))
  const sinFecha = p.facts.find(x => /sin fecha/i.test(x.label))
  assert.ok(sinFecha, 'debe exponer la deuda sin fecha acordada')
  assert.match(norm(sinFecha.value), /700\.000,00/)
  assert.match(norm(p.message), /350\.000,00/)   // el compromiso NO la incluye
})

test('campo opcional ausente degrada a guion, no rompe', () => {
  for (const r of RULES) {
    const p = presentInsight(insight(r, {}))   // evidence casi vacia
    const todo = [p.message, ...p.facts.map(x => x.value)].join(' | ')
    assert.ok(!/NaN|undefined/.test(todo), `${r} rompe sin evidence: ${todo}`)
    assert.ok(todo.includes(AUSENTE), `${r} deberia mostrar ${AUSENTE}`)
  }
})

test('rule_id desconocido cae al fallback del server, sin parsear numeros', () => {
  const raro = insight('dead_stock', FIXTURES.dead_stock)
  ;(raro as { rule_id: string }).rule_id = 'regla_futura'
  const p = presentInsight(raro)
  assert.equal(p.fallback, true)
  assert.equal(p.message, 'FALLBACK DEL SERVER')
  assert.equal(p.facts.length, 0)
})

// ==========================================================================
// Contrato con la migracion 217
// ==========================================================================
import { readFileSync } from 'node:fs'
const SQL_217 = readFileSync('supabase/migrations/20260807120000_finance_insight_locale_safe_messages.sql', 'utf8')

test('217: el motor no formatea numeros con to_char', () => {
  // El cuerpo de la funcion (todo lo que va entre $fn$) no puede tener to_char.
  const cuerpo = SQL_217.split('$fn$')[1] || ''
  assert.ok(cuerpo.length > 1000, 'no se pudo aislar el cuerpo de la funcion')
  assert.ok(!/to_char/i.test(cuerpo), 'el cuerpo sigue usando to_char')
})

test('217: ningun message interpola valores con format()', () => {
  const cuerpo = SQL_217.split('$fn$')[1] || ''
  assert.ok(!/'message',\s*format\(/.test(cuerpo), 'message sigue usando format()')
})

test('217: rule_version sigue en v1 (el calculo no cambio)', () => {
  assert.match(SQL_217, /v_ver\s+text\s*:=\s*'v1'/)
  assert.ok(!/'v2'/.test(SQL_217), 'no debe aparecer v2')
})

test('217 no hace DML sobre finance_insights fuera de la generacion', () => {
  // Fuera del cuerpo de la funcion no puede haber UPDATE/DELETE/INSERT.
  const partes = SQL_217.split('$fn$')
  const fuera = (partes[0] || '') + (partes[2] || '')
  assert.ok(!/^\s*(UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+public\.finance_insights/im.test(fuera),
    'la migracion 217 hace DML sobre finance_insights')
})
