import { ChevronRight } from 'lucide-react'
import type { PersonalInsight } from '../services/insightService'
import type { BudgetSummary } from '../services/budgetService'
import type { DebtSummary } from '../services/debtService'
import { fmtMoneyCompact } from './ui'

// ── Types ──────────────────────────────────────────────────────────────────────

type FinancialState = 'healthy' | 'stable' | 'attention' | 'risk' | 'critical'

export interface FinancialDiagnosisCardProps {
  loading: boolean
  summary: { totalIncome: number; totalExpense: number; balance: number }
  projResult: number
  cardCommitments: number
  debtInstallments: number
  insights: PersonalInsight[]
  budgetSummary: BudgetSummary | null
  debtSummary: DebtSummary | null
  hidden: boolean
  onNavigate: (route: string) => void
}

// ── State config ───────────────────────────────────────────────────────────────

const STATE_CONFIG: Record<FinancialState, {
  label: string; color: string; border: string; gradient: string
}> = {
  healthy:   {
    label: 'Saludable', color: '#34d399',
    border: 'rgba(52,211,153,0.22)',
    gradient: 'linear-gradient(145deg, rgba(52,211,153,0.07) 0%, rgba(4,7,15,0.72) 100%)',
  },
  stable:    {
    label: 'Estable',   color: '#818cf8',
    border: 'rgba(129,140,248,0.22)',
    gradient: 'linear-gradient(145deg, rgba(129,140,248,0.07) 0%, rgba(4,7,15,0.72) 100%)',
  },
  attention: {
    label: 'Atención', color: '#fbbf24',
    border: 'rgba(251,191,36,0.22)',
    gradient: 'linear-gradient(145deg, rgba(251,191,36,0.07) 0%, rgba(4,7,15,0.76) 100%)',
  },
  risk:      {
    label: 'Riesgo',    color: '#f97316',
    border: 'rgba(249,115,22,0.22)',
    gradient: 'linear-gradient(145deg, rgba(249,115,22,0.07) 0%, rgba(4,7,15,0.78) 100%)',
  },
  critical:  {
    label: 'Crítico',  color: '#f87171',
    border: 'rgba(248,113,113,0.25)',
    gradient: 'linear-gradient(145deg, rgba(248,113,113,0.09) 0%, rgba(4,7,15,0.78) 100%)',
  },
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function daysUntil(dateStr: string): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.ceil((new Date(dateStr + 'T12:00:00').getTime() - today.getTime()) / 86400000)
}

function computeState(
  summary:      { totalIncome: number; totalExpense: number; balance: number },
  projResult:   number,
  insights:     PersonalInsight[],
  budgetSummary:BudgetSummary | null,
  debtSummary:  DebtSummary | null,
): FinancialState {
  const hasDanger   = insights.some(i => i.severity === 'danger')
  const hasWarning  = insights.some(i => i.severity === 'warning')
  const budgetOver  = (budgetSummary?.exceedCount ?? 0) > 0
  const debtDueSoon = debtSummary?.nextDueDate ? daysUntil(debtSummary.nextDueDate) <= 5 : false

  if (hasDanger || (projResult < 0 && summary.totalIncome > 0 && Math.abs(projResult) > summary.totalIncome * 0.4))
    return 'critical'
  if (projResult < 0 || debtDueSoon)
    return 'risk'
  if (budgetOver || hasWarning)
    return 'attention'

  const isGreat = summary.balance > 0 && projResult > 0
    && summary.totalIncome > 0 && summary.totalExpense < summary.totalIncome * 0.55
  return isGreat ? 'healthy' : 'stable'
}

function buildText(
  summary:       { totalIncome: number; totalExpense: number; balance: number },
  projResult:    number,
  insights:      PersonalInsight[],
  budgetSummary: BudgetSummary | null,
  debtSummary:   DebtSummary | null,
  state:         FinancialState,
): string {
  const pct = (n: number, of: number) =>
    of > 0 ? `${Math.round((n / of) * 100)}%` : '–'

  if (state === 'critical') {
    if (projResult < 0 && summary.totalIncome > 0) {
      const diff = pct(Math.abs(projResult), summary.totalIncome)
      return `El margen proyectado queda negativo. Tus compromisos superan el balance actual en un ${diff} de tus ingresos registrados.`
    }
    const d = insights.find(i => i.severity === 'danger')
    return d?.hiddenMessage ?? 'Hay situaciones críticas que requieren atención este mes.'
  }

  if (state === 'risk') {
    if (projResult < 0)
      return 'Tu proyección del mes viene ajustada. Conviene revisar los compromisos pendientes antes de asumir nuevos gastos.'
    if (debtSummary?.nextDueDate) {
      const d = daysUntil(debtSummary.nextDueDate)
      return d <= 1
        ? 'Tenés un vencimiento de deuda para hoy o mañana. Revisá antes de que se pase la fecha.'
        : `Tenés un vencimiento de deuda en ${d} días. Conviene tenerlo presente.`
    }
    return 'Hay compromisos próximos que requieren atención.'
  }

  if (state === 'attention') {
    const n = budgetSummary?.exceedCount ?? 0
    if (n > 0)
      return `${n === 1 ? 'Un presupuesto superó' : `${n} presupuestos superaron`} el límite este mes. Conviene revisar los gastos variables.`
    const w = insights.find(i => i.severity === 'warning')
    return w?.hiddenMessage ?? 'Hay puntos de atención en tu situación financiera este mes.'
  }

  if (state === 'healthy') {
    const ratio = pct(summary.totalExpense, summary.totalIncome)
    return `Tu mes cierra con buen margen. Los gastos representan el ${ratio} de tus ingresos y la proyección es positiva.`
  }

  // stable
  if (summary.totalIncome > 0) {
    const ratio = pct(summary.totalExpense, summary.totalIncome)
    return `Tu mes viene estable. Los gastos representan el ${ratio} de tus ingresos registrados hasta ahora.`
  }
  return 'Sin alertas activas. Seguí registrando movimientos para un diagnóstico más completo.'
}

// ── Component ──────────────────────────────────────────────────────────────────

const MASK = '••••'

export function FinancialDiagnosisCard({
  loading,
  summary,
  projResult,
  cardCommitments,
  debtInstallments,
  insights,
  budgetSummary,
  debtSummary,
  hidden,
  onNavigate,
}: FinancialDiagnosisCardProps) {
  const hasData = summary.totalIncome > 0 || summary.totalExpense > 0

  if (loading) {
    return (
      <div
        data-testid="personal-diagnosis-card"
        style={{
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '1.25rem',
          padding: '1rem 1.125rem',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.625rem' }}>
          <div style={{ height: 10, width: '32%', borderRadius: 4, background: 'rgba(255,255,255,0.04)' }} />
          <div style={{ height: 18, width: '17%', borderRadius: 99, background: 'rgba(255,255,255,0.04)' }} />
        </div>
        <div style={{ height: 13, width: '96%', borderRadius: 4, background: 'rgba(255,255,255,0.04)', marginBottom: '0.4rem' }} />
        <div style={{ height: 13, width: '72%', borderRadius: 4, background: 'rgba(255,255,255,0.04)', marginBottom: '0.875rem' }} />
        <div style={{ height: 28, width: '48%', borderRadius: 6, background: 'rgba(255,255,255,0.03)' }} />
      </div>
    )
  }

  if (!hasData) {
    return (
      <div
        data-testid="personal-diagnosis-card"
        style={{
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '1.25rem',
          padding: '1rem 1.125rem',
        }}
      >
        <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.5rem' }}>
          Diagnóstico del mes
        </div>
        <p style={{ margin: '0 0 0.75rem', fontSize: '0.8125rem', color: '#475569', lineHeight: 1.5 }}>
          Cargá movimientos para ver el diagnóstico financiero de tu mes.
        </p>
        <button
          onClick={() => onNavigate('/personal/movimientos')}
          style={{
            background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)',
            borderRadius: '0.5rem', padding: '0.375rem 0.875rem',
            fontSize: '0.78rem', fontWeight: 700, color: '#34d399',
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem',
          }}
        >
          Cargar movimiento <ChevronRight size={12} />
        </button>
      </div>
    )
  }

  const state              = computeState(summary, projResult, insights, budgetSummary, debtSummary)
  const cfg                = STATE_CONFIG[state]
  const text               = buildText(summary, projResult, insights, budgetSummary, debtSummary, state)
  const totalCommitments   = cardCommitments + debtInstallments

  return (
    <div
      data-testid="personal-diagnosis-card"
      style={{
        background:   cfg.gradient,
        border:       `1px solid ${cfg.border}`,
        borderRadius: '1.25rem',
        padding:      '1rem 1.125rem',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.625rem' }}>
        <span style={{ fontSize: '0.68rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
          Diagnóstico del mes
        </span>
        <span style={{
          fontSize: '0.65rem', fontWeight: 700, color: cfg.color,
          background: `${cfg.color}18`, border: `1px solid ${cfg.color}30`,
          borderRadius: 99, padding: '0.15rem 0.6rem',
          textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>
          {cfg.label}
        </span>
      </div>

      {/* Diagnosis text */}
      <p style={{ margin: '0 0 0.75rem', fontSize: '0.8125rem', color: '#cbd5e1', lineHeight: 1.55 }}>
        {text}
      </p>

      {/* Key metrics */}
      {summary.totalIncome > 0 && (
        <div style={{ display: 'flex', gap: '1.25rem', marginBottom: '0.875rem', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: '0.6rem', color: '#334155', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.1rem' }}>
              Ingresos
            </div>
            <div style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '0.875rem', color: '#34d399' }}>
              {hidden ? MASK : fmtMoneyCompact(summary.totalIncome)}
            </div>
          </div>
          {totalCommitments > 0 && (
            <div>
              <div style={{ fontSize: '0.6rem', color: '#334155', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.1rem' }}>
                Compromisos
              </div>
              <div style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '0.875rem', color: '#fbbf24' }}>
                {hidden ? MASK : fmtMoneyCompact(totalCommitments)}
              </div>
            </div>
          )}
          <div>
            <div style={{ fontSize: '0.6rem', color: '#334155', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.1rem' }}>
              Margen est.
            </div>
            <div style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '0.875rem', color: projResult >= 0 ? '#818cf8' : '#f87171' }}>
              {hidden ? MASK : ((projResult >= 0 ? '+' : '') + fmtMoneyCompact(projResult))}
            </div>
          </div>
        </div>
      )}

      {/* CTA */}
      <button
        data-testid="personal-diagnosis-cta"
        onClick={() => onNavigate('/personal/insights')}
        style={{
          background: `${cfg.color}12`, border: `1px solid ${cfg.color}28`,
          borderRadius: '0.5rem', padding: '0.375rem 0.875rem',
          fontSize: '0.78rem', fontWeight: 700, color: cfg.color,
          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem',
        }}
      >
        Ver diagnóstico completo <ChevronRight size={12} />
      </button>
    </div>
  )
}
