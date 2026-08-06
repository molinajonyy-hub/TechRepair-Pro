import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertCircle, AlertTriangle, Info, RefreshCw, ChevronRight, X, Lock, CloudOff, CheckCircle2,
} from 'lucide-react'
import {
  insightsService, isActionNavigable,
  type FinanceInsight, type InsightsResult, type InsightSeverity,
} from '../../services/insightsService'
import { colors, radius, transitions } from '../../lib/tokens'

// ─── M8 — panel de insights financieros ──────────────────────────────────────
// Este componente NO calcula nada financiero: sólo renderiza lo que el motor
// server-side ya decidió. Toda cifra viene de `evidence`.

const MAX_VISIBLE = 3
/** A partir de acá el análisis se marca viejo y se ofrece regenerar. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000

type PanelState =
  | { s: 'loading' }
  | { s: 'available'; insights: FinanceInsight[]; generatedAt: string | null }
  | { s: 'empty'; generatedAt: string | null }
  | { s: 'restricted'; message: string }
  | { s: 'unavailable'; message: string }

const SEVERITY_CFG: Record<InsightSeverity, { bg: string; border: string; fg: string; Icon: typeof AlertCircle; label: string }> = {
  critical: { bg: colors.errorBg,   border: colors.errorBorder,   fg: colors.error,   Icon: AlertCircle,   label: 'Crítico' },
  warning:  { bg: colors.warningBg, border: colors.warningBorder, fg: colors.warning, Icon: AlertTriangle, label: 'Atención' },
  info:     { bg: colors.infoBg,    border: colors.indigoBorder,  fg: colors.info,    Icon: Info,          label: 'Información' },
}

function fmtDate(d: string): string {
  // Fechas 'YYYY-MM-DD' se anclan al mediodía para que el offset AR no las corra un día.
  const iso = d.length === 10 ? `${d}T12:00:00` : d
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleDateString('es-AR')
}

function fmtAgo(iso: string | null): string {
  if (!iso) return 'nunca'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return 'nunca'
  const mins = Math.floor((Date.now() - t) / 60000)
  if (mins < 1) return 'recién'
  if (mins < 60) return `hace ${mins} min`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `hace ${hrs} h`
  return `hace ${Math.floor(hrs / 24)} d`
}

/** Formatea sólo si es un número real. Nunca produce `$NaN` ni `undefined`. */
function fmtValue(v: unknown, currency = 'ARS'): string {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency', currency, maximumFractionDigits: 2,
    }).format(v)
  }
  if (typeof v === 'string' && v.length > 0) return v
  return '—'
}

function fmtPlain(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 }).format(v)
  }
  if (typeof v === 'string' && v.length > 0) return v
  if (typeof v === 'boolean') return v ? 'sí' : 'no'
  return '—'
}

/** Claves de evidence que son montos en pesos. El resto se muestra plano: un
 *  porcentaje formateado como moneda sería una mentira visual. */
const MONEY_KEYS = new Set([
  'dead_value', 'inventory_at_cost', 'net_sales_current', 'net_sales_previous',
  'accrued_revenue', 'accrued_revenue_previous', 'collected_cash', 'accounts_receivable_delta',
  'withdrawals_total', 'operating_result', 'cash_total', 'fixed_monthly',
  'breakeven_sales', 'daily_avg_sales', 'month_to_date_sales',
  'overdue_amount', 'due_next_14_days', 'total_near_term_commitments',
  'available_liquidity', 'dated_pending_amount', 'undated_pending_amount',
  'overdue_30plus', 'receivables_total', 'bucket_31_60', 'bucket_60plus',
  'amount_at_risk',
])

/** Claves internas que no aportan al lector. */
const HIDDEN_KEYS = new Set(['metric', 'threshold', 'calculation_version', 'source', 'currency'])

// ─────────────────────────────────────────────────────────────────────────────

function CalculationDrawer({ insight, onClose }: { insight: FinanceInsight; onClose: () => void }) {
  const ev = insight.evidence
  const rows = Object.entries(ev).filter(([k, v]) =>
    !HIDDEN_KEYS.has(k) && v !== null && v !== undefined && typeof v !== 'object')

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Cálculo de ${insight.title}`}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999, background: colors.bg.overlay,
        display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end',
      }}
    >
      <div style={{
        background: 'var(--bg-modal)', borderLeft: `1px solid ${colors.border.default}`,
        width: '100%', maxWidth: 460, display: 'flex', flexDirection: 'column',
        boxShadow: '0 0 60px rgba(0,0,0,0.5)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '1rem 1.25rem', borderBottom: `1px solid ${colors.border.default}`,
        }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.95rem', color: colors.text.primary }}>Ver cálculo</div>
            <div style={{ fontSize: '0.75rem', color: colors.text.muted, marginTop: 2 }}>{insight.title}</div>
          </div>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="btn btn-ghost btn-sm"
            style={{ flexShrink: 0 }}
          ><X size={16} /></button>
        </div>

        <div style={{ overflow: 'auto', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <section>
            <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.text.subtle }}>Qué se midió</h4>
            <p style={{ margin: 0, fontSize: '0.85rem', lineHeight: 1.55, color: colors.text.secondary }}>{insight.message}</p>
          </section>

          <section>
            <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.text.subtle }}>Período</h4>
            <p style={{ margin: 0, fontSize: '0.85rem', color: colors.text.secondary }}>
              {fmtDate(insight.period_start)} — {fmtDate(insight.period_end)}
              {ev.comparison_period_start && ev.comparison_period_end && (
                <><br /><span style={{ color: colors.text.muted }}>
                  Comparado contra {fmtDate(String(ev.comparison_period_start))} — {fmtDate(String(ev.comparison_period_end))}
                </span></>
              )}
            </p>
          </section>

          <section>
            <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.text.subtle }}>Los números</h4>
            <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {rows.map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', fontSize: '0.8rem' }}>
                  <dt style={{ color: colors.text.muted }}>{k}</dt>
                  <dd style={{ margin: 0, fontFamily: 'monospace', fontWeight: 600, color: colors.text.primary, textAlign: 'right', wordBreak: 'break-word' }}>
                    {MONEY_KEYS.has(k) ? fmtValue(v, String(ev.currency || 'ARS')) : fmtPlain(v)}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <section>
            <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.text.subtle }}>Umbral aplicado</h4>
            <pre style={{
              margin: 0, padding: '0.625rem 0.75rem', background: colors.bg.card,
              border: `1px solid ${colors.border.subtle}`, borderRadius: radius.sm,
              fontSize: '0.72rem', color: colors.text.secondary, overflow: 'auto', whiteSpace: 'pre-wrap',
            }}>{Object.entries(ev.threshold || {}).map(([k, v]) => `${k}: ${String(v)}`).join('\n') || '—'}</pre>
          </section>

          <section>
            <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.text.subtle }}>Fuente</h4>
            <p style={{ margin: 0, fontSize: '0.78rem', color: colors.text.muted, fontFamily: 'monospace', wordBreak: 'break-word' }}>
              {String(ev.source || '—')} · {String(ev.calculation_version || '')} · regla {insight.rule_id}
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function InsightCard({ insight, onOpenCalc }: { insight: FinanceInsight; onOpenCalc: () => void }) {
  const cfg = SEVERITY_CFG[insight.severity] ?? SEVERITY_CFG.info
  const { Icon } = cfg
  const navigable = isActionNavigable(insight.action)
  const isRoute = navigable && insight.action.target_type === 'route'

  return (
    <article
      data-testid={`insight-${insight.rule_id}`}
      data-severity={insight.severity}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: '0.75rem',
        padding: '0.875rem 1rem', borderRadius: radius.md,
        background: cfg.bg, border: `1px solid ${cfg.border}`,
      }}
    >
      <Icon size={16} style={{ color: cfg.fg, flexShrink: 0, marginTop: '0.15rem' }} aria-hidden />
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* El estado no se transmite sólo por color: hay ícono + etiqueta. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.2rem' }}>
          <span style={{ fontSize: '0.65rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: cfg.fg }}>
            {cfg.label}
          </span>
          <h3 style={{ margin: 0, fontSize: '0.875rem', fontWeight: 700, color: colors.text.primary }}>
            {insight.title}
          </h3>
        </div>
        <p style={{ margin: 0, fontSize: '0.82rem', lineHeight: 1.5, color: colors.text.secondary, overflowWrap: 'anywhere' }}>
          {insight.message}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
          <button
            onClick={onOpenCalc}
            data-testid={`insight-calc-${insight.rule_id}`}
            className="btn btn-ghost btn-sm"
            style={{ color: colors.text.secondary, transition: transitions.fast }}
          >Ver cálculo</button>
          {isRoute && (
            <Link
              to={insight.action.target}
              data-testid={`insight-action-${insight.rule_id}`}
              className="btn btn-ghost btn-sm"
              style={{ color: cfg.fg }}
            >{insight.action.label} <ChevronRight size={12} /></Link>
          )}
        </div>
      </div>
    </article>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

export interface FinanceInsightsPanelProps {
  businessId: string
  periodStart: string
  periodEnd: string
}

export function FinanceInsightsPanel({ businessId, periodStart, periodEnd }: FinanceInsightsPanelProps) {
  const [state, setState] = useState<PanelState>({ s: 'loading' })
  const [busy, setBusy] = useState(false)
  const [calcFor, setCalcFor] = useState<FinanceInsight | null>(null)

  // Protección contra respuesta vieja: sólo el pedido más reciente puede
  // escribir el estado. Sin esto, cambiar de período rápido pinta datos del
  // período anterior.
  const reqRef = useRef(0)

  const apply = useCallback((res: InsightsResult, token: number) => {
    if (token !== reqRef.current) return
    if (res.kind === 'restricted')   { setState({ s: 'restricted', message: res.message }); return }
    if (res.kind === 'unavailable')  { setState({ s: 'unavailable', message: res.message }); return }
    setState(res.insights.length === 0
      ? { s: 'empty', generatedAt: res.generatedAt }
      : { s: 'available', insights: res.insights, generatedAt: res.generatedAt })
  }, [])

  const load = useCallback(async () => {
    if (!businessId || !periodStart || !periodEnd) return
    const token = ++reqRef.current
    setState({ s: 'loading' })
    const res = await insightsService.read(businessId, periodStart, periodEnd, MAX_VISIBLE * 4)
    apply(res, token)
  }, [businessId, periodStart, periodEnd, apply])

  const regenerate = useCallback(async () => {
    if (!businessId || busy) return
    setBusy(true)
    const token = ++reqRef.current
    const gen = await insightsService.generate(businessId, periodStart, periodEnd)
    if (token !== reqRef.current) { setBusy(false); return }
    if (!gen.ok) {
      setState({ s: 'unavailable', message: gen.error || 'No pudimos actualizar el análisis.' })
      setBusy(false)
      return
    }
    const res = await insightsService.read(businessId, periodStart, periodEnd, MAX_VISIBLE * 4)
    apply(res, token)
    setBusy(false)
  }, [businessId, periodStart, periodEnd, busy, apply])

  // Una sola carga por período. No se genera en cada render.
  useEffect(() => { void load() }, [load])

  const generatedAt = state.s === 'available' || state.s === 'empty' ? state.generatedAt : null
  const isStale = generatedAt !== null && (Date.now() - new Date(generatedAt).getTime()) > STALE_AFTER_MS
  const visible = state.s === 'available' ? state.insights.slice(0, MAX_VISIBLE) : []
  const hidden = state.s === 'available' ? Math.max(0, state.insights.length - MAX_VISIBLE) : 0

  return (
    <section
      data-testid="finance-insights-panel"
      data-state={state.s}
      aria-label="Análisis financiero"
      style={{
        background: 'var(--bg-card-solid)', border: `1px solid ${colors.border.default}`,
        borderRadius: radius.lg, padding: '1rem 1.125rem', marginBottom: '1.25rem',
      }}
    >
      {/* Encabezado */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', flexWrap: 'wrap', marginBottom: visible.length || state.s !== 'available' ? '0.875rem' : 0 }}>
        <h2 style={{ margin: 0, fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: colors.text.secondary }}>
          Análisis
        </h2>
        <span style={{ fontSize: '0.72rem', color: colors.text.muted }}>
          {fmtDate(periodStart)} — {fmtDate(periodEnd)}
        </span>
        <div style={{ flex: 1 }} />
        {generatedAt && (
          <span
            data-testid="insights-generated-at"
            style={{ fontSize: '0.7rem', color: isStale ? colors.warning : colors.text.muted }}
          >
            {isStale ? 'Análisis desactualizado · ' : ''}Analizado {fmtAgo(generatedAt)}
          </span>
        )}
        <button
          onClick={() => void regenerate()}
          disabled={busy || state.s === 'loading'}
          data-testid="insights-refresh"
          className="btn btn-ghost btn-sm"
          style={{ flexShrink: 0, color: colors.text.secondary }}
        >
          <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
          <span style={{ marginLeft: '0.3rem' }}>Actualizar análisis</span>
        </button>
      </div>

      {/* Estados */}
      {state.s === 'loading' && (
        <div data-testid="insights-loading" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: colors.text.muted, fontSize: '0.82rem', padding: '0.5rem 0' }}>
          <RefreshCw size={14} className="animate-spin" aria-hidden />
          Analizando…
        </div>
      )}

      {state.s === 'restricted' && (
        <div data-testid="insights-restricted" style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', color: colors.text.secondary, fontSize: '0.82rem', padding: '0.5rem 0' }}>
          <Lock size={14} style={{ color: colors.text.muted, flexShrink: 0 }} aria-hidden />
          {state.message}
        </div>
      )}

      {/* Un error NUNCA se muestra como "todo bien". */}
      {state.s === 'unavailable' && (
        <div data-testid="insights-unavailable" style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', flexWrap: 'wrap', fontSize: '0.82rem', color: colors.text.secondary, padding: '0.5rem 0' }}>
          <CloudOff size={14} style={{ color: colors.warning, flexShrink: 0 }} aria-hidden />
          <span style={{ flex: 1, minWidth: 180 }}>{state.message} No podemos confirmar el estado de tus finanzas.</span>
          <button onClick={() => void load()} className="btn btn-ghost btn-sm" data-testid="insights-retry" style={{ color: colors.indigo }}>
            Reintentar
          </button>
        </div>
      )}

      {state.s === 'empty' && (
        <div data-testid="insights-empty" style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', fontSize: '0.82rem', color: colors.text.secondary, padding: '0.5rem 0' }}>
          <CheckCircle2 size={14} style={{ color: colors.success, flexShrink: 0 }} aria-hidden />
          {generatedAt
            ? 'No detectamos señales que requieran tu atención en este período.'
            : 'Todavía no analizamos este período. Tocá “Actualizar análisis”.'}
        </div>
      )}

      {state.s === 'available' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
          {visible.map(i => (
            <InsightCard key={i.id} insight={i} onOpenCalc={() => setCalcFor(i)} />
          ))}
          {hidden > 0 && (
            <p data-testid="insights-hidden-count" style={{ margin: 0, fontSize: '0.72rem', color: colors.text.muted }}>
              {hidden} señal{hidden > 1 ? 'es' : ''} más de menor prioridad.
            </p>
          )}
        </div>
      )}

      {calcFor && <CalculationDrawer insight={calcFor} onClose={() => setCalcFor(null)} />}
    </section>
  )
}

export default FinanceInsightsPanel
