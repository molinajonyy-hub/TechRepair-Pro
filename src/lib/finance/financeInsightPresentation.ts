import type {
  FinanceInsight, InsightEvidence, InsightRuleId,
} from '../../services/insightsService'

// ─── M8 — presentación de insights ───────────────────────────────────────────
// Módulo PURO. No recalcula ninguna métrica: toda cifra sale de `evidence`, que
// la DB ya computó. Acá sólo se selecciona, se formatea en es-AR y se interpola
// en texto.
//
// Por qué existe: el motor corre con lc_numeric = en_US en producción, así que
// cualquier número formateado en SQL salía como "10,823,941.50". La DB es
// autoridad sobre las métricas; el frontend lo es sobre separadores, moneda,
// porcentajes y fechas. Ver migración 20260807120000.

// ─── Helpers de formato ──────────────────────────────────────────────────────
// Convención del producto, repetida en ~20 archivos del repo: es-AR + ARS.

/** Sólo formatea números reales. Nunca produce "$NaN" ni "undefined". */
function esNumero(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

export const AUSENTE = '—'

export function formatARS(v: unknown, maximumFractionDigits = 2): string {
  if (!esNumero(v)) return AUSENTE
  return new Intl.NumberFormat('es-AR', {
    style: 'currency', currency: 'ARS', maximumFractionDigits,
  }).format(v)
}

export function formatUSD(v: unknown, maximumFractionDigits = 2): string {
  if (!esNumero(v)) return AUSENTE
  return new Intl.NumberFormat('es-AR', {
    style: 'currency', currency: 'USD', maximumFractionDigits,
  }).format(v)
}

export function formatNumber(v: unknown, maximumFractionDigits = 2): string {
  if (!esNumero(v)) return AUSENTE
  return new Intl.NumberFormat('es-AR', { maximumFractionDigits }).format(v)
}

/** `ya100` distingue 0-1 (proporción) de 0-100 (puntos porcentuales). */
export function formatPercent(v: unknown, opts: { ya100?: boolean; decimals?: number } = {}): string {
  if (!esNumero(v)) return AUSENTE
  const n = opts.ya100 ? v : v * 100
  return new Intl.NumberFormat('es-AR', {
    maximumFractionDigits: opts.decimals ?? 1,
  }).format(n) + '%'
}

/** Fechas 'YYYY-MM-DD' se anclan al mediodía: el offset AR no puede correrlas
 *  un día hacia atrás. */
export function formatDate(v: unknown): string {
  if (typeof v !== 'string' || v.length < 10) return AUSENTE
  const iso = v.length === 10 ? `${v}T12:00:00` : v
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return AUSENTE
  return d.toLocaleDateString('es-AR')
}

export function formatDays(v: unknown): string {
  if (!esNumero(v)) return AUSENTE
  const n = Math.round(v)
  return `${new Intl.NumberFormat('es-AR').format(n)} ${n === 1 ? 'día' : 'días'}`
}

export function formatCount(v: unknown, singular: string, plural: string): string {
  if (!esNumero(v)) return AUSENTE
  const n = Math.round(v)
  return `${new Intl.NumberFormat('es-AR').format(n)} ${n === 1 ? singular : plural}`
}

// ─── Contrato de presentación ────────────────────────────────────────────────

export interface PresentedFact {
  /** Etiqueta legible, no la clave cruda de evidence. */
  label: string
  value: string
}

export interface PresentedInsight {
  title: string
  message: string
  /** Cifras destacadas, ya formateadas. */
  facts: PresentedFact[]
  /** true cuando se cayó al fallback server-side (rule_id desconocido). */
  fallback: boolean
}

type Presenter = (e: InsightEvidence) => { message: string; facts: PresentedFact[] }

const f = (label: string, value: string): PresentedFact => ({ label, value })

// ─── Un presentador explícito por regla ──────────────────────────────────────
// Nada de imprimir evidence arbitrario: cada regla declara qué muestra, con qué
// unidad y con qué moneda.

const PRESENTERS: Record<InsightRuleId, Presenter> = {

  margin_drop_cost: (e) => ({
    message:
      `El margen bruto pasó de ${formatPercent(e.comparison_value, { ya100: true })} ` +
      `a ${formatPercent(e.current_value, { ya100: true })}. No es por vender menos: el costo de mercadería ` +
      `subió de ${formatPercent(e.cogs_ratio_previous, { ya100: true })} a ` +
      `${formatPercent(e.cogs_ratio_current, { ya100: true })} de cada venta.`,
    facts: [
      f('Margen actual', formatPercent(e.current_value, { ya100: true })),
      f('Margen anterior', formatPercent(e.comparison_value, { ya100: true })),
      f('Costo sobre venta actual', formatPercent(e.cogs_ratio_current, { ya100: true })),
      f('Costo sobre venta anterior', formatPercent(e.cogs_ratio_previous, { ya100: true })),
      f('Ventas netas del período', formatARS(e.net_sales_current)),
    ],
  }),

  cash_down_sales_up: (e) => ({
    message:
      `Facturaste ${formatPercent(e.sales_delta_percent, { ya100: true })} más que el período anterior, ` +
      `pero los cobros operativos cayeron ${formatPercent(Math.abs(Number(e.delta_percent ?? 0)), { ya100: true })}. ` +
      `Quedaron ${formatARS(e.accounts_receivable_delta)} sin cobrar de las ventas de este período.`,
    facts: [
      f('Facturación devengada', formatARS(e.accrued_revenue)),
      f('Cobros operativos', formatARS(e.collected_cash)),
      f('Cobros del período anterior', formatARS(e.comparison_value)),
      f('Quedó sin cobrar', formatARS(e.accounts_receivable_delta)),
    ],
  }),

  dead_stock: (e) => ({
    message:
      `${formatCount(e.dead_product_count, 'producto', 'productos')}, por un valor de ` +
      `${formatARS(e.dead_value)}, no registraron ventas ni consumo en los últimos ` +
      `${formatDays(e.days_threshold)}. Es el ${formatPercent(e.current_value)} de tu inventario valorizado.`,
    facts: [
      f('Capital inmovilizado', formatARS(e.dead_value)),
      f('Inventario valorizado', formatARS(e.inventory_at_cost)),
      f('Proporción inmovilizada', formatPercent(e.current_value)),
      f('Productos sin movimiento', formatNumber(e.dead_product_count, 0)),
      f('Productos evaluados', formatNumber(e.total_product_count, 0)),
      f('Plazo sin movimiento', formatDays(e.days_threshold)),
    ],
  }),

  withdrawals_vs_profit: (e) => ({
    message:
      `En los últimos ${formatDays(e.window_days)} retiraste ${formatARS(e.withdrawals_total)}, ` +
      `el ${formatPercent(e.current_value)} del resultado operativo (${formatARS(e.operating_result)}).`,
    facts: [
      f('Retiros del período', formatARS(e.withdrawals_total)),
      f('Resultado operativo', formatARS(e.operating_result)),
      f('Proporción retirada', formatPercent(e.current_value)),
      f('Ventana observada', formatDays(e.window_days)),
    ],
  }),

  fixed_coverage: (e) => ({
    message:
      `Tu caja cubre ${formatNumber(e.current_value)} meses de los gastos recurrentes que cargaste ` +
      `(${formatARS(e.fixed_monthly)} por mes, ` +
      `${formatCount(e.recurring_count, 'concepto', 'conceptos')}).`,
    facts: [
      f('Caja disponible', formatARS(e.cash_total)),
      f('Gastos recurrentes mensuales', formatARS(e.fixed_monthly)),
      f('Meses de cobertura', formatNumber(e.current_value)),
      f('Conceptos recurrentes', formatNumber(e.recurring_count, 0)),
    ],
  }),

  breakeven_day: (e) => ({
    message:
      `Estimación: según el ritmo actual, alcanzarías a cubrir los gastos recurrentes cargados ` +
      `alrededor del ${formatDate(e.current_value)}. Basado en ${formatDays(e.days_observed)} observados, ` +
      `${formatARS(e.fixed_monthly)} de gastos recurrentes y ${formatARS(e.daily_avg_sales)} de venta diaria promedio.`,
    facts: [
      f('Fecha estimada', formatDate(e.current_value)),
      f('Días observados', formatDays(e.days_observed)),
      f('Gastos recurrentes', formatARS(e.fixed_monthly)),
      f('Venta necesaria', formatARS(e.breakeven_sales)),
      f('Venta diaria promedio', formatARS(e.daily_avg_sales)),
      f('Margen de contribución', formatPercent(e.contribution_margin_pct, { ya100: true })),
    ],
  }),

  supplier_crunch: (e) => ({
    message:
      `Tenés ${formatARS(e.total_near_term_commitments)} en compromisos con proveedores vencidos o ` +
      `próximos a vencer durante los próximos ${formatDays(e.horizon_days)}. ` +
      `La liquidez disponible cubre ${formatPercent(e.coverage_ratio)}.`,
    facts: [
      f('Vencido', formatARS(e.overdue_amount)),
      f('Vence en el horizonte', formatARS(e.due_next_14_days)),
      f('Compromiso próximo total', formatARS(e.total_near_term_commitments)),
      f('Liquidez disponible', formatARS(e.available_liquidity)),
      f('Cobertura', formatPercent(e.coverage_ratio)),
      f('Compras con fecha acordada', formatNumber(e.dated_purchase_count, 0)),
      f('Deuda sin fecha acordada', formatARS(e.undated_pending_amount)),
    ],
  }),

  fx_stale_prices: (e) => ({
    message:
      `${formatNumber(e.stale_count, 0)} de ${formatNumber(e.total_usd_products, 0)} productos en dólares ` +
      `tienen precios calculados a una cotización promedio de ${formatARS(e.avg_rate_used)}, ` +
      `y hoy la cotización cargada es ${formatARS(e.current_rate)}.`,
    facts: [
      f('Productos desactualizados', formatNumber(e.stale_count, 0)),
      f('Productos en dólares', formatNumber(e.total_usd_products, 0)),
      f('Cotización usada (promedio)', formatARS(e.avg_rate_used)),
      f('Cotización cargada hoy', formatARS(e.current_rate)),
      f('Diferencia', formatPercent(e.delta_percent, { ya100: true })),
    ],
  }),

  data_quality: (e) => ({
    message:
      `El chequeo de salud encontró ${formatCount(e.critical_count, 'inconsistencia crítica', 'inconsistencias críticas')}` +
      (esNumeroPositivo(e.amount_at_risk) ? ` que comprometen ${formatARS(e.amount_at_risk)}` : '') +
      `. Mientras existan, los demás números de este panel pueden estar distorsionados.`,
    facts: [
      f('Inconsistencias críticas', formatNumber(e.critical_count, 0)),
      f('Monto comprometido', formatARS(e.amount_at_risk)),
      f('Advertencias', formatNumber(e.warning_count, 0)),
      f('Chequeos ejecutados', formatNumber(e.checks_total, 0)),
      f('Chequeos en orden', formatNumber(e.pass_count, 0)),
    ],
  }),

  cc_aging: (e) => ({
    message:
      `Tenés ${formatARS(e.overdue_30plus)} en saldos de cuenta corriente con más de ` +
      `${formatDays(e.days_threshold)} de antigüedad. Es el ${formatPercent(e.current_value)} de lo que te deben.`,
    facts: [
      f('Saldo con antigüedad', formatARS(e.overdue_30plus)),
      f('Total por cobrar', formatARS(e.receivables_total)),
      f('Proporción antigua', formatPercent(e.current_value)),
      f('Entre 31 y 60 días', formatARS(e.bucket_31_60)),
      f('Más de 60 días', formatARS(e.bucket_60plus)),
      f('Deudores concentrados', formatNumber(e.top_debtor_count, 0)),
    ],
  }),
}

function esNumeroPositivo(v: unknown): boolean {
  return esNumero(v) && v > 0
}

/**
 * Presenta un insight. Para los 10 rule_id conocidos usa el presentador tipado;
 * para uno desconocido cae al texto server-side tal cual, como texto plano.
 */
export function presentInsight(insight: FinanceInsight): PresentedInsight {
  const presenter = PRESENTERS[insight.rule_id]
  if (!presenter) {
    // Fallback: nunca se parsea el string ni se intenta extraer números de él.
    return { title: insight.title, message: insight.message, facts: [], fallback: true }
  }
  const { message, facts } = presenter(insight.evidence || ({} as InsightEvidence))
  return { title: insight.title, message, facts, fallback: false }
}
