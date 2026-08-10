import { supabase } from '../lib/supabase'
import { logger } from '../lib/logger'

// ===== Contrato M8 ============================================================
// El motor vive ENTERO en la base. Este módulo NO calcula nada financiero:
// sólo transporta y tipa lo que devuelven las RPC canónicas.

export type InsightSeverity = 'critical' | 'warning' | 'info'
export type InsightStatus = 'active' | 'resolved' | 'superseded'
export type InsightTargetType = 'route' | 'drawer' | 'none'

/** Los 10 rule_id del catálogo cerrado. Agregar uno acá sin migración + doc
 *  rompe el guard de M8 a propósito. */
export const INSIGHT_RULE_IDS = [
  'margin_drop_cost', 'cash_down_sales_up', 'dead_stock', 'withdrawals_vs_profit',
  'fixed_coverage', 'breakeven_day', 'supplier_crunch', 'fx_stale_prices',
  'data_quality', 'cc_aging',
] as const
export type InsightRuleId = (typeof INSIGHT_RULE_IDS)[number]

/** Espejo EXACTO del CHECK de finance_insights.action en la migración M8-B.
 *  Si la DB acepta una ruta que esto no, un insight quedaría con link muerto. */
export const INSIGHT_ALLOWED_ROUTES = [
  '/finance', '/finance/reports', '/finance/health', '/finance/dashboard',
  '/inventory', '/suppliers', '/cuentas', '/caja', '/expenses',
  '/comprobantes', '/customers', '/currency-settings',
] as const

export interface InsightAction {
  label: string
  target_type: InsightTargetType
  target: string
  params?: Record<string, unknown>
}

export interface InsightEvidence {
  metric: string
  current_value: number | string | null
  comparison_value?: number | string | null
  delta?: number | null
  delta_percent?: number | null
  threshold: Record<string, unknown>
  period_start: string
  period_end: string
  comparison_period_start?: string | null
  comparison_period_end?: string | null
  sample_size?: number
  currency: string
  source: string
  calculation_version: string
  [k: string]: unknown
}

export interface FinanceInsight {
  id: string
  rule_id: InsightRuleId
  rule_version: string
  period_start: string
  period_end: string
  severity: InsightSeverity
  title: string
  message: string
  evidence: InsightEvidence
  action: InsightAction
  status: InsightStatus
  impact_ars: number
  generated_at: string
  resolved_at: string | null
}

export interface InsightSkip { rule_id: string; reason: string }

/** Resultado explícito. `restricted` y `unavailable` NUNCA deben renderizarse
 *  como "no hay insights": un error no es una buena noticia. */
export type InsightsResult =
  | { kind: 'ok'; insights: FinanceInsight[]; generatedAt: string | null }
  | { kind: 'restricted'; message: string }
  | { kind: 'unavailable'; message: string }

export interface GenerateResult {
  ok: boolean
  fired: string[]
  skipped: InsightSkip[]
  generatedAt: string | null
  durationMs: number | null
  error?: string
}

/** Un insight sólo es accionable si su destino existe de verdad. */
export function isActionNavigable(action: InsightAction | undefined | null): boolean {
  if (!action) return false
  if (action.target_type === 'route') {
    return (INSIGHT_ALLOWED_ROUTES as readonly string[]).includes(action.target)
  }
  if (action.target_type === 'drawer') return action.target === 'calculation'
  return false
}

function isAccessError(msg: string): boolean {
  return /sin acceso|no autenticado|business_id requerido/i.test(msg)
}

export const insightsService = {
  /** Evalúa las 10 reglas y persiste. Una sola llamada por período: nunca una
   *  RPC por regla. */
  async generate(businessId: string, periodStart: string, periodEnd: string): Promise<GenerateResult> {
    const { data, error } = await supabase.rpc('generate_finance_insights', {
      p_business_id: businessId,
      p_period_start: periodStart,
      p_period_end: periodEnd,
    })

    if (error) {
      logger.error('FINANCE', 'generate_finance_insights falló', error)
      return { ok: false, fired: [], skipped: [], generatedAt: null, durationMs: null, error: error.message }
    }
    if (!data?.ok) {
      return {
        ok: false, fired: [], skipped: [], generatedAt: null, durationMs: null,
        error: data?.error || 'No se pudo generar el análisis',
      }
    }
    return {
      ok: true,
      fired: Array.isArray(data.fired) ? data.fired : [],
      skipped: Array.isArray(data.skipped) ? data.skipped : [],
      generatedAt: data.generated_at ?? null,
      durationMs: typeof data.duration_ms === 'number' ? data.duration_ms : null,
    }
  },

  /** Lectura con orden estable server-side (severidad -  impacto -  fecha -  rule_id). */
  async read(
    businessId: string,
    periodStart: string,
    periodEnd: string,
    max = 20,
  ): Promise<InsightsResult> {
    const { data, error } = await supabase.rpc('finance_insights_read', {
      p_business_id: businessId,
      p_period_start: periodStart,
      p_period_end: periodEnd,
      p_status: 'active',
      p_max: max,
    })

    if (error) {
      logger.error('FINANCE', 'finance_insights_read falló', error)
      return isAccessError(error.message)
        ? { kind: 'restricted', message: 'No tenés permiso para ver el análisis financiero.' }
        : { kind: 'unavailable', message: 'No pudimos cargar el análisis.' }
    }
    if (!data?.ok) {
      const msg = data?.error || ''
      return isAccessError(msg)
        ? { kind: 'restricted', message: 'No tenés permiso para ver el análisis financiero.' }
        : { kind: 'unavailable', message: 'No pudimos cargar el análisis.' }
    }

    const raw: unknown = data.insights
    const insights = (Array.isArray(raw) ? raw : []) as FinanceInsight[]
    const generatedAt = insights.length > 0
      ? insights.reduce<string | null>((acc, i) => (!acc || i.generated_at > acc ? i.generated_at : acc), null)
      : null

    return { kind: 'ok', insights, generatedAt }
  },
}
