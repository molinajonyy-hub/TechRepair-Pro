import { supabase } from '../lib/supabase'
import { logger } from '../lib/logger'

// ─── Charts L1 — cliente del contrato canónico ───────────────────────────────
//
// Este módulo es la ÚNICA puerta de entrada del frontend a las métricas de los
// gráficos L1. No calcula nada: pide `get_finance_charts_l1` y devuelve lo que
// la base ya computó.
//
// Regla del lote: React no reconstruye P&L, COGS, stock financiero, reposición
// ni deuda. Si un número no viene en este payload, no existe para la UI.

// ─── Tipos del payload ───────────────────────────────────────────────────────

export type ChartGranularity = 'day' | 'week' | 'month'

export interface ChartsPeriod {
  start: string
  end: string
  days: number
  granularity: ChartGranularity
  timezone: string
}

export interface ChartsComparisonPeriod {
  start: string
  end: string
  days: number
}

export interface ChartsSummary {
  net_sales: number
  cogs: number
  operating_expenses: number
  gross_profit: number
  operating_result: number
  /** null cuando no hay base de ventas. Nunca 0 por defecto. */
  margin_pct: number | null
  collections: number
  owner_withdrawals: number
}

export interface ChartsComparison extends Omit<ChartsSummary, 'owner_withdrawals'> {
  /** false cuando el período anterior no tiene ningún movimiento. */
  available: boolean
}

export interface PnlPoint {
  bucket: string
  net_sales: number
  cogs: number
  operating_expenses: number
  operating_result: number
}

export interface BillingVsCollectionsPoint {
  bucket: string
  billed: number
  collected: number
}

export interface PaymentMixSlice {
  method: string
  amount: number
  operations: number
}

export interface AgingBucket {
  bucket: string
  amount: number
  documents: number
}

/**
 * SEC-08C fase B — `total`/`documents` son `null` cuando el actor NO tiene
 * autoridad para conocer la cartera. `null` NO es 0: 0 afirma que no hay deuda
 * (o no hay saldo por cobrar) y es verdad del negocio; `null` dice que no se
 * puede saber. La RPC devuelve además `is_authorized` para que la UI no tenga
 * que deducirlo de un número ausente.
 *
 * Hoy sólo `payables_aging` puede venir restringido; `receivables_aging` viaja
 * siempre con números. Comparten tipo a propósito: si mañana se gatea la
 * cartera de clientes, el compilador va a exigir el mismo tratamiento en vez de
 * dejar pasar un cero falso.
 */
export interface AgingSection {
  total: number | null
  documents: number | null
  buckets: AgingBucket[]
  is_authorized?: boolean
}

export interface PayablesDue {
  due_soon_amount: number | null
  overdue_amount: number | null
  undated_amount: number | null
  undated_count: number | null
  /** false = todavía no se cargó ninguna fecha de vencimiento. NO es un error. */
  has_due_dates: boolean
  is_authorized?: boolean
}

export interface InventoryCapital {
  inventory_at_cost: number
  /** Universo stock>0 y costo>0 — mismo denominador que `dead_stock` de M8. */
  inventory_at_cost_valued: number
  products_total: number
  products_valued: number
  products_missing_cost: number
  units_missing_cost: number
  products_negative_stock: number
  coverage_pct: number | null
  usd_based_products: number
  usd_rate_min_applied: number | null
  usd_rate_max_applied: number | null
  /** Siempre false en L1: no hay base de costo histórico. */
  history_available: boolean
  history_blocked_reason: string
}

export interface InventoryFlows {
  purchases_cost: number
  purchases_units: number
  purchases_movements: number
  purchases_movements_costed: number
  consumption_cost: number
  consumption_units: number
  consumption_movements_uncosted: number
  returns_units: number
  returns_cost: number
  adjustments_units: number
  adjustments_net_units: number
  adjustments_cost: number
  cancellations_units: number
  /** null cuando no hay consumo comparable. NUNCA Infinity. */
  replenishment_pct: number | null
  replenishment_basis: 'comparable' | 'no_comparable_consumption'
  consumption_source: string
  purchases_source: string
  /**
   * P1-D — CONTEXTO, no reposición. Compras a proveedores REGISTRADAS en el
   * período: el comprobante de compra cargado, que puede corresponder a
   * mercadería, a un servicio o a un gasto. El sistema no lo distingue, así que
   * nada de esto puede afirmarse como mercadería recibida.
   *
   * No entra —ni puede entrar— en el numerador ni en el denominador de
   * `replenishment_pct`. Sirve sólo para explicar un 0 % sin acusar al usuario
   * de no haber comprado.
   *
   * Opcionales: un backend anterior a la migración 20260810150000 no las envía,
   * y la UI debe seguir funcionando sin ellas.
   */
  supplier_purchases_count?: number
  supplier_purchases_amount?: number
  supplier_purchases_source?: string
  /** Siempre false en L1: las bases de costo no son homogéneas. */
  bridge_available: boolean
  bridge_blocked_reason: string
}

export type WaterfallKind = 'start' | 'delta' | 'subtotal' | 'total'

export interface WaterfallStep {
  key: 'net_sales' | 'cogs' | 'gross_profit' | 'operating_expenses' | 'operating_result'
  value: number
  kind: WaterfallKind
}

export interface FinanceChartsL1 {
  ok: true
  calculation_version: string
  period: ChartsPeriod
  comparison_period: ChartsComparisonPeriod
  summary: ChartsSummary
  comparison: ChartsComparison
  pnl_series: PnlPoint[]
  billing_vs_collections: BillingVsCollectionsPoint[]
  payment_mix: PaymentMixSlice[]
  receivables_aging: AgingSection
  payables_aging: AgingSection
  payables_due: PayablesDue
  inventory_capital: InventoryCapital
  inventory_flows: InventoryFlows
  waterfall: WaterfallStep[]
}

export interface FinanceChartsError {
  ok: false
  error: string
}

// ─── Servicio ────────────────────────────────────────────────────────────────

export interface FetchChartsParams {
  businessId: string
  periodStart: string
  periodEnd: string
  granularity?: ChartGranularity | 'auto'
  /** Permite abortar una respuesta vieja al cambiar de período. */
  signal?: AbortSignal
}

export const financeChartsService = {
  /**
   * Una sola llamada para todo el bloque L1. Devuelve el payload tal cual lo
   * emitió la base, sin transformarlo.
   *
   * Lanza si la RPC falla; devuelve `FinanceChartsError` si la base rechazó los
   * parámetros (período inválido, etc.).
   */
  async fetch(params: FetchChartsParams): Promise<FinanceChartsL1 | FinanceChartsError> {
    const { businessId, periodStart, periodEnd, granularity = 'auto', signal } = params

    const query = supabase.rpc('get_finance_charts_l1', {
      p_business_id: businessId,
      p_period_start: periodStart,
      p_period_end: periodEnd,
      p_granularity: granularity,
    })

    // El builder de supabase-js expone abortSignal(); se usa cuando el caller
    // provee uno para descartar respuestas de un período ya abandonado.
    const { data, error } = await (signal ? query.abortSignal(signal) : query)

    if (error) {
      // PostgREST representa un fetch abortado como `{ error }`, igual que una
      // falla real. El signal del caller es la autoridad para distinguirlos:
      // abandonar el período o desmontar Charts es control de flujo esperado,
      // no un ERROR de aplicación ni una entrada para el buffer de diagnóstico.
      if (signal?.aborted) {
        throw new DOMException('La solicitud fue cancelada.', 'AbortError')
      }
      logger.error('FINANCE', 'get_finance_charts_l1 falló', error)
      throw new Error(error.message)
    }
    if (!data || typeof data !== 'object') {
      throw new Error('Respuesta vacía de get_finance_charts_l1')
    }
    return data as FinanceChartsL1 | FinanceChartsError
  },
}
