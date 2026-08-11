import { formatARS, formatNumber, formatPercent, AUSENTE } from './financeInsightPresentation'
import type {
  ChartGranularity, InventoryCapital, InventoryFlows, PaymentMixSlice,
} from '../../services/financeChartsService'

// ─── Charts L1 — presentación ────────────────────────────────────────────────
//
// Módulo PURO. No recalcula ninguna métrica financiera: recibe números que la
// base ya computó y decide etiqueta, formato y semántica de color.
//
// Los formatters base se reutilizan de `financeInsightPresentation` (M8) a
// propósito: es-AR y ARS tienen un solo dueño en el repo.

export { formatARS, formatNumber, formatPercent, AUSENTE }

// ─── Mensajes de error para el usuario ───────────────────────────────────────
//
// El mensaje crudo del backend NUNCA llega a pantalla. PostgREST devuelve cosas
// como "Could not find the function public.get_finance_charts_l1(...) in the
// schema cache": no significa nada para el dueño de un taller y expone la firma
// interna de una función. El detalle técnico va al logger; acá sólo se traduce
// lo que la propia RPC declara como error de contrato.

const ERRORES_CONTRATO: Record<string, string> = {
  missing_params: 'Faltan datos para calcular el período.',
  invalid_period: 'El período seleccionado no es válido: la fecha de inicio es posterior a la de fin.',
}

/**
 * Texto mostrable para un error, o `null` si no hay nada seguro que decir —en
 * cuyo caso la tarjeta muestra sólo su mensaje genérico.
 */
export function mensajeUsuario(raw: string | null | undefined): string | null {
  if (!raw) return null
  return ERRORES_CONTRATO[raw] ?? null
}

// ─── Semántica de variación (§6) ─────────────────────────────────────────────
//
// Un número que sube NO es verde por defecto. Cada métrica declara qué
// significa que se mueva:
//   · positive → más es mejor (resultado, ventas, cobros)
//   · negative → más es peor  (COGS, gastos, deuda)
//   · neutral  → no se puede afirmar sin más evidencia (inventario)

export type DeltaSemantics = 'positive' | 'negative' | 'neutral'
export type DeltaTone = 'good' | 'bad' | 'neutral'

/**
 * Traduce una variación a un tono visual. Para métricas `neutral` devuelve
 * siempre 'neutral': el capital en stock que sube no es una buena noticia ni
 * una mala hasta que se sepa por qué subió.
 */
export function deltaTone(delta: number | null, semantics: DeltaSemantics): DeltaTone {
  if (semantics === 'neutral') return 'neutral'
  if (delta === null || !Number.isFinite(delta) || delta === 0) return 'neutral'
  const mejora = semantics === 'positive' ? delta > 0 : delta < 0
  return mejora ? 'good' : 'bad'
}

export interface DeltaInfo {
  /** Variación porcentual, o null si no hay base contra la cual comparar. */
  percent: number | null
  absolute: number | null
  tone: DeltaTone
  /** Texto ya formateado, listo para pintar. */
  label: string
  available: boolean
}

/**
 * Compara dos valores. Si la base es 0 NO devuelve Infinity ni 100 %: devuelve
 * "sin base", que es la verdad.
 */
export function buildDelta(
  current: number | null | undefined,
  previous: number | null | undefined,
  semantics: DeltaSemantics,
  available: boolean,
): DeltaInfo {
  const cur = typeof current === 'number' && Number.isFinite(current) ? current : null
  const prev = typeof previous === 'number' && Number.isFinite(previous) ? previous : null

  if (!available || cur === null || prev === null || prev === 0) {
    return { percent: null, absolute: null, tone: 'neutral', label: 'Sin base de comparación', available: false }
  }

  const absolute = cur - prev
  const percent = (absolute / Math.abs(prev)) * 100
  const tone = deltaTone(absolute, semantics)
  const signo = absolute > 0 ? '↑' : absolute < 0 ? '↓' : '='
  return {
    percent,
    absolute,
    tone,
    label: `${signo} ${formatPercent(Math.abs(percent), { ya100: true })} vs período anterior`,
    available: true,
  }
}

// ─── Etiquetas ───────────────────────────────────────────────────────────────

/** Medios de cobro reales del modelo. Sin inventar categorías que no existen. */
const METODO_LABELS: Record<string, string> = {
  efectivo: 'Efectivo',
  transferencia: 'Transferencia',
  tarjeta: 'Tarjeta',
  tarjeta_debito: 'Débito',
  tarjeta_credito: 'Crédito',
  debito: 'Débito',
  credito: 'Crédito',
  mercadopago: 'Mercado Pago',
  mercado_pago: 'Mercado Pago',
  qr: 'QR',
  cheque: 'Cheque',
  otro: 'Otros',
}

export function metodoLabel(method: string): string {
  return METODO_LABELS[method] ?? method.charAt(0).toUpperCase() + method.slice(1).replace(/_/g, ' ')
}

/** Buckets canónicos de aging. No se inventa "vencido": esto es antigüedad. */
const BUCKET_LABELS: Record<string, string> = {
  '0-7': 'Hasta 7 días',
  '8-30': '8 a 30 días',
  '31-60': '31 a 60 días',
  '60+': 'Más de 60 días',
}

export function bucketLabel(bucket: string): string {
  return BUCKET_LABELS[bucket] ?? bucket
}

export const WATERFALL_LABELS: Record<string, string> = {
  net_sales: 'Ingresos netos',
  cogs: 'Costo de mercadería',
  gross_profit: 'Margen bruto',
  operating_expenses: 'Gastos operativos',
  operating_result: 'Resultado operativo',
}

export const SERIE_LABELS = {
  net_sales: 'Ingresos netos',
  cogs: 'Costo de mercadería',
  operating_expenses: 'Gastos operativos',
  operating_result: 'Resultado operativo',
  billed: 'Facturación devengada',
  collected: 'Cobros efectivos',
} as const

// ─── Formato de fechas de bucket ─────────────────────────────────────────────

/**
 * Etiqueta corta del eje. Las fechas 'YYYY-MM-DD' se anclan al mediodía para
 * que el offset AR no las corra un día hacia atrás.
 */
export function bucketLabelFor(bucket: string, granularity: ChartGranularity): string {
  if (typeof bucket !== 'string' || bucket.length < 10) return AUSENTE
  const d = new Date(`${bucket.slice(0, 10)}T12:00:00`)
  if (Number.isNaN(d.getTime())) return AUSENTE
  if (granularity === 'month') {
    return d.toLocaleDateString('es-AR', { month: 'short', year: '2-digit' })
  }
  if (granularity === 'week') {
    return `Sem. ${d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })}`
  }
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })
}

/** Título completo para el tooltip (§27: se muestra el período, no la clave). */
export function bucketTitleFor(bucket: string, granularity: ChartGranularity): string {
  if (typeof bucket !== 'string' || bucket.length < 10) return AUSENTE
  const d = new Date(`${bucket.slice(0, 10)}T12:00:00`)
  if (Number.isNaN(d.getTime())) return AUSENTE
  if (granularity === 'month') {
    return d.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' })
  }
  if (granularity === 'week') {
    return `Semana del ${d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })}`
  }
  return d.toLocaleDateString('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })
}

/** Eje monetario compacto. Sólo para ticks: el tooltip siempre da el valor exacto. */
export function formatAxisARS(v: number): string {
  if (!Number.isFinite(v)) return ''
  const abs = Math.abs(v)
  const signo = v < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${signo}$${formatNumber(abs / 1_000_000, 1)}M`
  if (abs >= 1_000) return `${signo}$${formatNumber(abs / 1_000, 0)}k`
  return `${signo}$${formatNumber(abs, 0)}`
}

// ─── Cobertura de costos (§25) ───────────────────────────────────────────────

/** Bajo este umbral la valuación se marca `incomplete` en vez de mostrarse lisa. */
export const COVERAGE_WARNING_THRESHOLD = 95

export interface CapitalCoverage {
  incomplete: boolean
  /** Frase declarativa lista para mostrar. */
  text: string | null
}

export function capitalCoverage(cap: InventoryCapital | null | undefined): CapitalCoverage {
  if (!cap || cap.products_total === 0) return { incomplete: false, text: null }
  if (cap.products_missing_cost === 0) return { incomplete: false, text: null }

  const pct = cap.coverage_pct
  const incomplete = typeof pct === 'number' && pct < COVERAGE_WARNING_THRESHOLD
  // El detalle de unidades va acá y no en el bloque: la nota se muestra UNA vez,
  // en la carcasa de la tarjeta (estado `incomplete`).
  const unidades = cap.units_missing_cost > 0
    ? ` ${formatNumber(cap.units_missing_cost, 0)} unidades quedan sin valuar.`
    : ''
  return {
    incomplete,
    text:
      `Valor estimado sobre ${formatNumber(cap.products_valued, 0)} de ` +
      `${formatNumber(cap.products_total, 0)} productos con costo cargado.${unidades}`,
  }
}

// ─── Reposición (§16) ────────────────────────────────────────────────────────
//
// Sin lenguaje alarmista. Menos compras que consumo NO significa
// "descapitalización": reducir inventario puede ser una decisión correcta.

/**
 * Denominación canónica de la métrica (P1-D).
 *
 * El numerador SIEMPRE fue "entradas de inventario registradas": nunca midió
 * todo lo que el negocio compró. Llamarla "Reposición del período" prometía más
 * de lo que el número puede sostener — un 0 % se leía como "no compré
 * mercadería" cuando significa "no hay entradas de inventario registradas".
 * El nombre ahora dice exactamente qué se midió.
 */
export const REPLENISHMENT_LABEL = 'Reposición registrada'

/**
 * Aviso de contexto. Se muestra SÓLO cuando el período no tiene entradas de
 * inventario Y sí hay compras a proveedores cargadas.
 *
 * Está redactado en condicional a propósito: una compra a proveedor puede ser
 * mercadería, un servicio o un gasto, y el sistema no lo distingue. Afirmar que
 * hubo mercadería recibida sería inventar un dato.
 */
export const REPLENISHMENT_SUPPLIER_NOTE =
  'Hay compras a proveedores registradas. Si corresponden a mercadería recibida, ' +
  'revisá que se haya ingresado al inventario.'

export interface ReplenishmentCopy {
  /** Frase principal. */
  text: string
  /** Aviso adicional, o null. Nunca es una alerta ni un diagnóstico. */
  supplierNote: string | null
}

/**
 * Semántica de la reposición registrada (§16 + P1-D).
 *
 * NO recalcula nada: `replenishment_pct` viene del servidor y esta función sólo
 * decide qué se puede afirmar con honestidad para cada caso.
 *
 * Casos:
 *   · sin datos                      → texto ausente, sin diagnóstico.
 *   · sin consumo comparable         → se dice eso, sin porcentaje.
 *   · CERO entradas de inventario    → se nombra el hecho, no la conclusión;
 *     + compras a proveedores        → se agrega el aviso condicional.
 *   · con entradas registradas       → los tres tramos de siempre.
 */
export function replenishmentCopy(flows: InventoryFlows | null | undefined): ReplenishmentCopy {
  if (!flows) return { text: AUSENTE, supplierNote: null }
  if (flows.replenishment_pct === null) {
    return { text: 'Sin consumo comparable en el período.', supplierNote: null }
  }

  // Cero entradas de mercadería registradas. Se exigen las DOS condiciones: un
  // movimiento de entrada sin costo cargado sí es una entrada, y decir que no
  // hubo ninguna sería falso.
  if (flows.purchases_movements === 0 && flows.purchases_cost === 0) {
    const hayCompras = (flows.supplier_purchases_count ?? 0) > 0
    return {
      text: 'No se registraron entradas de mercadería en inventario durante este período.',
      supplierNote: hayCompras ? REPLENISHMENT_SUPPLIER_NOTE : null,
    }
  }

  const pct = flows.replenishment_pct
  if (pct < 95) {
    return {
      text: 'En este período las compras repusieron menos inventario del que salió por operación.',
      supplierNote: null,
    }
  }
  if (pct <= 105) {
    return { text: 'La reposición acompañó aproximadamente el consumo del período.', supplierNote: null }
  }
  return { text: 'Las compras del período superaron el consumo de inventario.', supplierNote: null }
}

/** Sólo la frase principal. Conserva la firma previa a P1-D. */
export function replenishmentText(flows: InventoryFlows | null | undefined): string {
  return replenishmentCopy(flows).text
}

// ─── Semántica de Capital en stock ───────────────────────────────────────────
//
// La métrica es `stock_quantity × cost_price`: el valor de la mercadería según
// los costos que HOY están cargados en cada producto. No es —y no puede
// afirmarse como— valor de reposición, costo de reposición vigente ni valuación
// ajustada al dólar del día: no existe una fuente de cotización server-side que
// pueda respaldar esa promesa. Ver
// docs/auditoria-finanzas/charts-l1/24-inventario-source-of-truth.md §7.
//
// Estas dos constantes son el texto canónico. Cualquier variante que insinúe
// reposición o revaluación FX está prohibida por guard-charts-l1 R19.

export const CAPITAL_DESCRIPCION =
  'Valor de la mercadería disponible según los costos registrados actualmente en TechRepair Pro.'

/** Versión corta para la banda KPI, donde no entra la frase completa. */
export const CAPITAL_DESCRIPCION_CORTA = 'Según los costos registrados actualmente'

/**
 * Nota de costos dolarizados (§21). Sólo aparece cuando hay productos con base
 * USD que la justifiquen. Deliberadamente no alarmista: informa que el número
 * puede moverse, sin prometer que ya refleja la cotización de hoy.
 */
export function fxNote(cap: InventoryCapital | null | undefined): string | null {
  if (!cap || cap.usd_based_products <= 0) return null
  return 'Algunos costos pueden variar al actualizarse su cotización.'
}

// ─── Medios de cobro ─────────────────────────────────────────────────────────

export interface PaymentSlice extends PaymentMixSlice {
  label: string
  share: number
}

/**
 * Prepara el mix para el donut: sólo importes positivos (una compensación por
 * anulación puede dejar un método en negativo, y un sector negativo no existe).
 * Agrupa la cola en "Otros" para no pasar de ~6 categorías visibles.
 */
export function buildPaymentSlices(mix: PaymentMixSlice[], maxSlices = 6): PaymentSlice[] {
  const positivos = (mix ?? []).filter(m => Number.isFinite(m.amount) && m.amount > 0)
  const total = positivos.reduce((s, m) => s + m.amount, 0)
  if (total <= 0) return []

  const ordenado = [...positivos].sort((a, b) => b.amount - a.amount)
  const visibles = ordenado.slice(0, maxSlices - 1)
  const cola = ordenado.slice(maxSlices - 1)

  const slices: PaymentSlice[] = visibles.map(m => ({
    ...m,
    label: metodoLabel(m.method),
    share: (m.amount / total) * 100,
  }))

  if (cola.length > 0) {
    const amount = cola.reduce((s, m) => s + m.amount, 0)
    slices.push({
      method: '__otros__',
      amount,
      operations: cola.reduce((s, m) => s + (m.operations ?? 0), 0),
      label: 'Otros',
      share: (amount / total) * 100,
    })
  }
  return slices
}

// ─── Paleta ──────────────────────────────────────────────────────────────────
//
// Sobria y acotada. El color NUNCA es la única diferencia entre series: cada
// gráfico agrega trazo, relleno o forma distinta (§45).

export const CHART_COLORS = {
  revenue: '#6366f1',
  cogs: '#f59e0b',
  expenses: '#f97316',
  result: '#10b981',
  resultNegative: '#ef4444',
  billed: '#6366f1',
  collected: '#10b981',
  neutral: '#94a3b8',
} as const

/** Serie de sectores del donut, en orden de uso. */
export const MIX_COLORS = [
  '#6366f1', '#10b981', '#f59e0b', '#38bdf8', '#a78bfa', '#94a3b8',
] as const

/** Buckets de aging: de más nuevo a más antiguo, intensidad creciente. */
export const AGING_COLORS: Record<string, string> = {
  '0-7': '#10b981',
  '8-30': '#38bdf8',
  '31-60': '#f59e0b',
  '60+': '#ef4444',
}
