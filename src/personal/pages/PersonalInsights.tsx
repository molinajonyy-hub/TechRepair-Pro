import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'
import {
  TrendingDown, TrendingUp, AlertTriangle, AlertCircle, CheckCircle,
  CreditCard, Clock, Tag, BarChart3, RepeatIcon, Eye, EyeOff,
  Wallet, Info, ChevronRight, Sparkles,
} from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { personalService } from '../services/personalService'
import { creditCardService } from '../services/creditCardService'
import { debtService } from '../services/debtService'
import { recurringExpenseService } from '../services/recurringExpenseService'
import { budgetService, calculateBudgetUsage } from '../services/budgetService'
import {
  buildPersonalInsights, getInsightIcon,
  type PersonalInsight, type InsightSeverity, type InsightCategory,
} from '../services/insightService'
import { currentYearMonth, addMonths } from '../utils/creditCards'
import { PageContainer, fmtMoneyCompact } from '../components/ui'
import { logger } from '../../lib/logger'

const HIDE_KEY = 'miGuitaHideAmounts'

// ── Severity config ────────────────────────────────────────────────────────────

const SEV: Record<InsightSeverity, { text: string; bg: string; border: string; label: string }> = {
  danger:  { text: '#f87171', bg: 'rgba(248,113,113,0.08)', border: 'rgba(248,113,113,0.2)',  label: 'Alerta'   },
  warning: { text: '#fbbf24', bg: 'rgba(251,191,36,0.08)',  border: 'rgba(251,191,36,0.2)',   label: 'Atención' },
  info:    { text: '#60a5fa', bg: 'rgba(96,165,250,0.08)',  border: 'rgba(96,165,250,0.2)',   label: 'Info'     },
  success: { text: '#34d399', bg: 'rgba(52,211,153,0.08)',  border: 'rgba(52,211,153,0.2)',   label: 'Positivo' },
}

// ── Icon map ──────────────────────────────────────────────────────────────────

const ICON_MAP: Record<string, LucideIcon> = {
  TrendingDown:  TrendingDown,
  TrendingUp:    TrendingUp,
  AlertTriangle: AlertTriangle,
  AlertCircle:   AlertCircle,
  CheckCircle:   CheckCircle,
  CreditCard:    CreditCard,
  Clock:         Clock,
  Tag:           Tag,
  BarChart3:     BarChart3,
  RepeatIcon:    RepeatIcon,
  Wallet:        Wallet,
  Info:          Info,
  Sparkles:      Sparkles,
}

function InsightIcon({ type, size = 16, color }: { type: string; size?: number; color?: string }) {
  const name = getInsightIcon({ type } as PersonalInsight)
  const Comp = ICON_MAP[name] ?? Info
  return <Comp size={size} color={color} />
}

// ── Filter tabs ───────────────────────────────────────────────────────────────

type FilterKey = 'all' | InsightCategory

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all',         label: 'Todos'         },
  { key: 'alert',       label: 'Alertas'       },
  { key: 'opportunity', label: 'Oportunidades' },
  { key: 'health',      label: 'Salud'         },
]

// ── InsightCard ───────────────────────────────────────────────────────────────

function InsightCard({
  insight, hidden, onAction,
}: {
  insight: PersonalInsight
  hidden: boolean
  onAction: (route: string) => void
}) {
  const s   = SEV[insight.severity]
  const msg = hidden ? insight.hiddenMessage : insight.message

  return (
    <div
      data-testid="personal-insight-card"
      style={{
        background:   s.bg,
        border:       `1px solid ${s.border}`,
        borderRadius: '1rem',
        padding:      '1rem',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.625rem', marginBottom: '0.5rem' }}>
        <div style={{
          width: 32, height: 32, borderRadius: '0.625rem',
          background: `${s.text}18`, border: `1px solid ${s.text}30`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <InsightIcon type={insight.type} size={15} color={s.text} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
            <span style={{ fontWeight: 700, fontSize: '0.875rem', color: '#f0f4ff', lineHeight: 1.3, flex: 1 }}>
              {insight.title}
            </span>
            <span style={{
              fontSize: '0.6rem', fontWeight: 700, color: s.text,
              background: `${s.text}15`, border: `1px solid ${s.text}30`,
              borderRadius: 99, padding: '0.15rem 0.5rem', textTransform: 'uppercase',
              letterSpacing: '0.06em', whiteSpace: 'nowrap',
            }}>
              {s.label}
            </span>
          </div>
        </div>
      </div>

      {/* Message */}
      <p style={{ fontSize: '0.8125rem', color: '#94a3b8', lineHeight: 1.5, margin: 0, paddingLeft: '2.625rem' }}>
        {msg}
      </p>

      {/* Footer: amount + CTA */}
      {(insight.amount !== undefined || insight.actionRoute) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.625rem', paddingLeft: '2.625rem' }}>
          {insight.amount !== undefined && !hidden ? (
            <span style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '0.9375rem', color: s.text }}>
              {fmtMoneyCompact(insight.amount)}
            </span>
          ) : <span />}
          {insight.actionRoute && insight.actionLabel && (
            <button
              onClick={() => onAction(insight.actionRoute!)}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.25rem',
                background: `${s.text}15`, border: `1px solid ${s.text}25`,
                borderRadius: '0.5rem', padding: '0.25rem 0.625rem',
                cursor: 'pointer', color: s.text, fontSize: '0.75rem', fontWeight: 700,
              }}
            >
              {insight.actionLabel} <ChevronRight size={11} />
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Summary bar ───────────────────────────────────────────────────────────────

function SummaryBar({ insights }: { insights: PersonalInsight[] }) {
  const danger  = insights.filter(i => i.severity === 'danger').length
  const warning = insights.filter(i => i.severity === 'warning').length
  const success = insights.filter(i => i.severity === 'success').length

  if (insights.length === 0) return null

  return (
    <div data-testid="personal-insights-summary" style={{ display: 'flex', gap: '0.5rem' }}>
      {danger > 0 && (
        <div style={{ flex: 1, background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: '0.75rem', padding: '0.625rem 0.75rem', textAlign: 'center' }}>
          <div style={{ fontWeight: 900, fontSize: '1.25rem', color: '#f87171', fontFamily: 'monospace' }}>{danger}</div>
          <div style={{ fontSize: '0.6rem', color: '#f87171', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Alertas</div>
        </div>
      )}
      {warning > 0 && (
        <div style={{ flex: 1, background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: '0.75rem', padding: '0.625rem 0.75rem', textAlign: 'center' }}>
          <div style={{ fontWeight: 900, fontSize: '1.25rem', color: '#fbbf24', fontFamily: 'monospace' }}>{warning}</div>
          <div style={{ fontSize: '0.6rem', color: '#fbbf24', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Atención</div>
        </div>
      )}
      <div style={{ flex: 1, background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.2)', borderRadius: '0.75rem', padding: '0.625rem 0.75rem', textAlign: 'center' }}>
        <div style={{ fontWeight: 900, fontSize: '1.25rem', color: '#60a5fa', fontFamily: 'monospace' }}>{insights.length}</div>
        <div style={{ fontSize: '0.6rem', color: '#60a5fa', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Total</div>
      </div>
      {success > 0 && (
        <div style={{ flex: 1, background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)', borderRadius: '0.75rem', padding: '0.625rem 0.75rem', textAlign: 'center' }}>
          <div style={{ fontWeight: 900, fontSize: '1.25rem', color: '#34d399', fontFamily: 'monospace' }}>{success}</div>
          <div style={{ fontSize: '0.6rem', color: '#34d399', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Positivo</div>
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function PersonalInsights() {
  const { user }   = useAuth()
  const navigate   = useNavigate()

  const [loading,  setLoading]  = useState(true)
  const [insights, setInsights] = useState<PersonalInsight[]>([])
  const [filter,   setFilter]   = useState<FilterKey>('all')
  const [hidden,   setHidden]   = useState(() => localStorage.getItem(HIDE_KEY) === 'true')

  const toggleHidden = () => {
    const next = !hidden
    setHidden(next)
    localStorage.setItem(HIDE_KEY, String(next))
  }

  const load = async () => {
    if (!user) return
    setLoading(true)
    try {
      const month        = currentYearMonth()
      const prevMonth    = addMonths(month, -1)
      const [yNum, mNum] = month.split('-').map(Number)

      const [txs, sum, cards, cpurchases, cpayments, debts, recurring, recPayments, budgets, budgetExpenses] = await Promise.all([
        personalService.getTransactions(user.id, { month, limit: 50 }),
        personalService.getMonthlySummary(user.id, month),
        creditCardService.getCreditCards(user.id),
        creditCardService.getCardPurchases(user.id),
        creditCardService.getCardPayments(user.id),
        debtService.getDebts(user.id),
        recurringExpenseService.getRecurringExpenses(user.id),
        recurringExpenseService.getPaymentsForMonth(user.id, yNum, mNum),
        budgetService.getBudgets(user.id, month),
        budgetService.getExpensesForPeriod(user.id, month),
      ])

      let prevSummary = null
      try { prevSummary = await personalService.getMonthlySummary(user.id, prevMonth) } catch { /* ok */ }

      const budgetUsages = calculateBudgetUsage(budgets, budgetExpenses)
      const result = buildPersonalInsights({
        month,
        summary:           sum,
        prevSummary,
        budgetUsages,
        cards:             cards.filter(c => c.is_active),
        cardPurchases:     cpurchases,
        cardPayments:      cpayments,
        debts,
        recurringExpenses: recurring,
        recurringPayments: recPayments,
        transactions:      txs,
      })
      setInsights(result)
    } catch (err) {
      logger.error('PERSONAL', 'insights load error', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = filter === 'all'
    ? insights
    : insights.filter(i => i.category === filter)

  const alertCount       = insights.filter(i => i.category === 'alert').length
  const opportunityCount = insights.filter(i => i.category === 'opportunity').length
  const healthCount      = insights.filter(i => i.category === 'health').length

  const countFor = (key: FilterKey) => {
    if (key === 'all')         return insights.length
    if (key === 'alert')       return alertCount
    if (key === 'opportunity') return opportunityCount
    return healthCount
  }

  const hasData = insights.length > 0

  return (
    <PageContainer testId="personal-insights-page">

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Mi Guita</div>
          <div style={{ fontWeight: 800, fontSize: '1.25rem', color: '#f0f4ff', lineHeight: 1.2 }}>Insights</div>
        </div>
        <button
          data-testid="personal-insights-toggle-hide"
          onClick={toggleHidden}
          aria-label={hidden ? 'Mostrar importes' : 'Ocultar importes'}
          style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '99px', padding: '0.375rem 0.75rem', cursor: 'pointer', color: '#60a5fa', display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.72rem', fontWeight: 600 }}
        >
          {hidden ? <Eye size={13} /> : <EyeOff size={13} />}
          {hidden ? 'Mostrar' : 'Ocultar'}
        </button>
      </div>

      {/* ── Summary bar ── */}
      {!loading && <SummaryBar insights={insights} />}

      {/* ── Filter tabs ── */}
      <div
        data-testid="personal-insights-filters"
        style={{ display: 'flex', gap: '0.375rem', overflowX: 'auto', paddingBottom: '0.125rem' }}
      >
        {FILTERS.map(f => {
          const active = filter === f.key
          const cnt    = countFor(f.key)
          return (
            <button
              key={f.key}
              data-testid={`personal-insights-filter-${f.key}`}
              onClick={() => setFilter(f.key)}
              style={{
                flexShrink:   0,
                padding:      '0.375rem 0.875rem',
                borderRadius: 99,
                border:       `1px solid ${active ? 'rgba(96,165,250,0.4)' : 'rgba(255,255,255,0.08)'}`,
                background:   active ? 'rgba(96,165,250,0.12)' : 'rgba(255,255,255,0.025)',
                color:        active ? '#60a5fa' : '#475569',
                fontSize:     '0.8rem',
                fontWeight:   active ? 700 : 600,
                cursor:       'pointer',
                whiteSpace:   'nowrap',
                display:      'flex',
                alignItems:   'center',
                gap:          '0.3rem',
              }}
            >
              {f.label}
              {cnt > 0 && (
                <span style={{
                  fontSize: '0.65rem', fontWeight: 800,
                  background: active ? 'rgba(96,165,250,0.25)' : 'rgba(255,255,255,0.06)',
                  borderRadius: 99, padding: '0.05rem 0.375rem',
                  color: active ? '#60a5fa' : '#334155',
                }}>
                  {cnt}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* ── Content ── */}
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
          {[1, 2, 3].map(i => (
            <div key={i} style={{ height: 88, borderRadius: '1rem', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }} />
          ))}
        </div>
      ) : !hasData ? (
        <div
          data-testid="personal-insights-empty"
          style={{ textAlign: 'center', padding: '2.5rem 1rem' }}
        >
          <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>🧘</div>
          <div style={{ fontWeight: 800, fontSize: '1rem', color: '#f0f4ff', marginBottom: '0.375rem' }}>
            No hay suficientes datos aún
          </div>
          <p style={{ fontSize: '0.8125rem', color: '#475569', lineHeight: 1.5, margin: 0 }}>
            Registrá movimientos, presupuestos o tarjetas para que Mi Guita pueda interpretar tu situación financiera.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div
          data-testid="personal-insights-empty-filter"
          style={{ textAlign: 'center', padding: '2rem 1rem' }}
        >
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>✅</div>
          <div style={{ fontWeight: 700, fontSize: '0.9375rem', color: '#f0f4ff', marginBottom: '0.25rem' }}>
            {filter === 'alert'       ? 'Sin alertas activas' :
             filter === 'opportunity' ? 'Sin oportunidades detectadas' :
                                        'Sin indicadores de salud'}
          </div>
          <p style={{ fontSize: '0.8125rem', color: '#475569', margin: 0 }}>
            {filter === 'alert' ? 'Todo tranquilo por acá. ¡Bien ahí!' : 'Seguí cargando datos para más insights.'}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
          {filtered.map(insight => (
            <InsightCard
              key={insight.id}
              insight={insight}
              hidden={hidden}
              onAction={navigate}
            />
          ))}
        </div>
      )}

      {/* ── Quick links ── */}
      {!loading && hasData && (
        <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '1rem', padding: '0.875rem 1rem' }}>
          <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.625rem' }}>
            Módulos relacionados
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
            {[
              { label: 'Presupuestos', route: '/personal/presupuestos', color: '#fbbf24' },
              { label: 'Tarjetas',     route: '/personal/tarjetas',     color: '#818cf8' },
              { label: 'Deudas',       route: '/personal/deudas',       color: '#f87171' },
              { label: 'Proyecciones', route: '/personal/proyecciones', color: '#60a5fa' },
            ].map(({ label, route, color }) => (
              <button
                key={route}
                data-testid={`personal-insights-link-${label.toLowerCase()}`}
                onClick={() => navigate(route)}
                style={{
                  padding: '0.625rem 0.75rem',
                  borderRadius: '0.75rem',
                  background: `${color}0f`,
                  border: `1px solid ${color}25`,
                  color,
                  fontWeight: 700,
                  fontSize: '0.8125rem',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                {label} <ChevronRight size={13} />
              </button>
            ))}
          </div>
        </div>
      )}

    </PageContainer>
  )
}
