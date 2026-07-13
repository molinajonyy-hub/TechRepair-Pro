// ─────────────────────────────────────────────────────────────────────────
// Bug "Ganancia Real Hoy": el dashboard reconocía margen al AGREGAR un repuesto
// a una orden abierta (order_parts.status='used', added_at=hoy), sin entrega ni
// comprobante. Estos tests fijan la corrección:
//   1) useDashboardStats ya NO calcula ganancia desde order_parts.
//   2) hoy/semana/mes salen de la fuente canónica (getFinancialSummary →
//      finance_dashboard_summary → v_finance_pnl), que solo reconoce
//      comprobantes efectivos.
//   3) el corte diario usa zona horaria Argentina (todayAR / daysAgoAR).
//
// Mezcla dos estilos: contrato sobre el código fuente (como etapa1Finance.test)
// para el hook — que importa import.meta.env vía supabase y no corre en Node —
// y una prueba de comportamiento REAL sobre dateUtils, que es puro.
// ─────────────────────────────────────────────────────────────────────────
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { todayAR, daysAgoAR } from '../../src/utils/dateUtils.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../')
const read = (p: string) => readFileSync(resolve(REPO_ROOT, p), 'utf-8')

// ── Contrato: el hook del dashboard ──────────────────────────────────────────

test('useDashboardStats NO deriva ninguna ganancia desde order_parts', () => {
  const s = read('src/hooks/useDashboardStats.ts')
  // No debe existir ninguna query a order_parts (era la fuente prematura).
  assert.ok(!/\.from\('order_parts'\)/.test(s),
    'el dashboard no debe leer order_parts para ninguna métrica de ganancia')
  // Ni la fórmula de margen a add-time sobre sale_price/internal_cost.
  assert.ok(!/sale_price\s*-\s*internal_cost/.test(s),
    'no debe quedar la fórmula (sale_price - internal_cost) del cálculo prematuro')
})

test('realProfitToday/Week/Month se toman de getFinancialSummary (.opProfit), no de un cálculo cliente', () => {
  const s = read('src/hooks/useDashboardStats.ts')
  // Las tres ventanas usan el servicio canónico.
  assert.match(s, /realProfitToday\s*=\s*todaySummary\.opProfit/)
  assert.match(s, /realProfitThisWeek\s*=\s*weekSummary\.opProfit/)
  assert.match(s, /realProfitThisMonth\s*=\s*monthSummary\.opProfit/)
  // Exactamente tres llamadas a la fuente canónica (hoy, semana, mes).
  const calls = s.match(/getFinancialSummary\(/g) || []
  assert.equal(calls.length, 3, 'debe llamar getFinancialSummary una vez por ventana (hoy/semana/mes)')
})

test('el corte diario de la ganancia usa zona horaria Argentina (todayAR / daysAgoAR)', () => {
  const s = read('src/hooks/useDashboardStats.ts')
  assert.match(s, /import \{ todayAR, daysAgoAR \} from '\.\.\/utils\/dateUtils'/)
  // La ventana de hoy y de semana se anclan en fechas AR, no en toISOString() UTC.
  assert.match(s, /getFinancialSummary\(businessId!, todayStr,\s*todayStr\)/)
  assert.match(s, /daysAgoAR\(6\)/)
})

test('topProfitableItems se lee del margen devengado (v_finance_product_margin), no de order_parts', () => {
  const s = read('src/hooks/useDashboardStats.ts')
  assert.match(s, /\.from\('v_finance_product_margin'\)/)
  assert.match(s, /topProfitableItems/)
})

// ── Comportamiento: dateUtils.daysAgoAR (puro, corre en Node) ─────────────────

test('daysAgoAR(0) === todayAR() y el formato es YYYY-MM-DD', () => {
  assert.equal(daysAgoAR(0), todayAR())
  assert.match(daysAgoAR(0), /^\d{4}-\d{2}-\d{2}$/)
})

test('daysAgoAR retrocede exactamente N días de calendario AR', () => {
  // 6 días atrás debe ser estrictamente anterior a hoy y a 5 días atrás.
  assert.ok(daysAgoAR(6) < daysAgoAR(0), '6 días atrás < hoy')
  assert.ok(daysAgoAR(6) < daysAgoAR(5), '6 días atrás < 5 días atrás')

  // Diferencia real de 30 días entre hoy y daysAgoAR(30), medida en UTC-noon AR.
  const a = new Date(daysAgoAR(0) + 'T12:00:00-03:00').getTime()
  const b = new Date(daysAgoAR(30) + 'T12:00:00-03:00').getTime()
  assert.equal(Math.round((a - b) / 86400000), 30, 'daysAgoAR(30) cae 30 días antes que hoy')
})

test('daysAgoAR cruza correctamente el fin de mes (no colapsa al día 1)', () => {
  // Encadenar 40 días hacia atrás produce 40 fechas estrictamente decrecientes
  // y sin huecos — descarta bugs de setDate/monthstart alrededor de límites.
  const seq = Array.from({ length: 40 }, (_, i) => daysAgoAR(i))
  for (let i = 1; i < seq.length; i++) {
    assert.ok(seq[i] < seq[i - 1], `día ${i} debe ser anterior al día ${i - 1}`)
    const d0 = new Date(seq[i - 1] + 'T12:00:00-03:00').getTime()
    const d1 = new Date(seq[i]     + 'T12:00:00-03:00').getTime()
    assert.equal(Math.round((d0 - d1) / 86400000), 1, `paso ${i} debe ser exactamente 1 día`)
  }
})
