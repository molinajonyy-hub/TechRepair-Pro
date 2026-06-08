import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, CalendarDays, CheckCircle2, Clock, AlertCircle, TrendingUp } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { personalService } from '../services/personalService'
import { creditCardService } from '../services/creditCardService'
import { debtService } from '../services/debtService'
import { recurringExpenseService } from '../services/recurringExpenseService'
import { budgetService, calculateBudgetUsage } from '../services/budgetService'
import { buildProjection } from '../services/projectionService'
import { buildPersonalInsights } from '../services/insightService'
import { buildMonthlyPlan, type MonthlyPlan } from '../services/monthlyPlanService'
import { addMonths, getAllCardsStatementTotal, currentYearMonth } from '../utils/creditCards'
import { PageContainer, fmtMoneyCompact, SkeletonCard } from '../components/ui'

const HIDE_KEY = 'miGuitaHideAmounts'
const MASK     = '••••'

export function PersonalMonthlyPlan() {
  const { user }   = useAuth()
  const navigate   = useNavigate()
  const [month, setMonth]     = useState(currentYearMonth())
  const [plan,  setPlan]      = useState<MonthlyPlan | null>(null)
  const [loading, setLoading] = useState(true)
  const [hidden, setHidden]   = useState(() => localStorage.getItem(HIDE_KEY) === 'true')

  const load = async () => {
    if (!user) return
    setLoading(true)
    try {
      const [cmYear, cmMon] = month.split('-').map(Number)
      const [sum, cards, cpurchases, cpayments, debts, recurring, recPayments, budgets, budgetExpenses, txs] = await Promise.all([
        personalService.getMonthlySummary(user.id, month),
        creditCardService.getCreditCards(user.id),
        creditCardService.getCardPurchases(user.id),
        creditCardService.getCardPayments(user.id),
        debtService.getDebts(user.id),
        recurringExpenseService.getRecurringExpenses(user.id),
        recurringExpenseService.getPaymentsForMonth(user.id, cmYear, cmMon),
        budgetService.getBudgets(user.id, month),
        budgetService.getExpensesForPeriod(user.id, month),
        personalService.getTransactions(user.id, { month, limit: 50 }),
      ])
      let prevSummary = null
      try { prevSummary = await personalService.getMonthlySummary(user.id, addMonths(month, -1)) } catch { /* ok */ }

      const activeCards   = cards.filter(c => c.is_active)
      const cardTotal     = getAllCardsStatementTotal(cpurchases, month)
      const budgetUsages  = calculateBudgetUsage(budgets, budgetExpenses)
      const projection    = buildProjection(month, sum, activeCards, cpurchases, cpayments, recurring, recPayments, debts)
      const insights      = buildPersonalInsights({
        month, summary: sum, prevSummary, budgetUsages,
        cards: activeCards, cardPurchases: cpurchases, cardPayments: cpayments,
        debts, recurringExpenses: recurring, recurringPayments: recPayments, transactions: txs,
      })
      // cardTotal used only to detect if cards contributed — projection already includes it
      void cardTotal
      setPlan(buildMonthlyPlan({ month, projection, insights }))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [user, month]) // eslint-disable-line react-hooks/exhaustive-deps

  const amt = (n: number) => hidden ? MASK : fmtMoneyCompact(n)

  const monthLabel = new Date(month + '-15').toLocaleDateString('es-AR', { month: 'long', year: 'numeric' })

  // Month navigation
  const prevMonth = () => setMonth(m => addMonths(m, -1))
  const nextMonth = () => {
    const next = addMonths(month, 1)
    if (next <= currentYearMonth()) setMonth(next)
  }
  const isCurrentMonth = month === currentYearMonth()

  const kindIcon = (kind: string) => {
    if (kind === 'overdue') return <AlertCircle size={13} color="#f87171" />
    if (kind === 'urgent')  return <Clock size={13} color="#f97316" />
    if (kind === 'paid')    return <CheckCircle2 size={13} color="#34d399" />
    return <CalendarDays size={13} color="#60a5fa" />
  }
  const kindColor = (kind: string) => {
    if (kind === 'overdue') return '#f87171'
    if (kind === 'urgent')  return '#f97316'
    if (kind === 'paid')    return '#34d399'
    return '#60a5fa'
  }

  return (
    <PageContainer>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.25rem 0' }}>
        <span style={{ fontWeight: 800, fontSize: '1.125rem', color: '#f0f4ff' }}>Plan del mes</span>
        <button
          onClick={() => setHidden(h => { const n = !h; localStorage.setItem(HIDE_KEY, String(n)); return n })}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', fontSize: '0.72rem', fontWeight: 600 }}
        >
          {hidden ? 'Mostrar' : 'Ocultar'}
        </button>
      </div>

      {/* Month selector */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '1rem' }}>
        <button onClick={prevMonth} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.5rem', padding: '0.375rem 0.75rem', color: '#94a3b8', cursor: 'pointer', fontSize: '0.9rem' }}>‹</button>
        <span style={{ fontSize: '0.875rem', fontWeight: 700, color: '#e2e8f0', textTransform: 'capitalize', minWidth: 140, textAlign: 'center' }}>{monthLabel}</span>
        <button onClick={nextMonth} disabled={isCurrentMonth} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.5rem', padding: '0.375rem 0.75rem', color: isCurrentMonth ? '#1e3a5f' : '#94a3b8', cursor: isCurrentMonth ? 'default' : 'pointer', fontSize: '0.9rem' }}>›</button>
      </div>

      {loading && <SkeletonCard rows={5} />}

      {!loading && plan && !plan.hasData && (
        <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '1.25rem', padding: '1.5rem 1.125rem', textAlign: 'center' }}>
          <CalendarDays size={28} color="#334155" style={{ marginBottom: '0.75rem' }} />
          <p style={{ fontSize: '0.875rem', color: '#475569', margin: '0 0 1rem', lineHeight: 1.5 }}>
            No hay datos para este mes. Cargá movimientos e ingresos para ver el plan.
          </p>
          <button
            onClick={() => navigate('/personal/movimientos')}
            style={{ background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)', borderRadius: '0.5rem', padding: '0.5rem 1rem', fontSize: '0.8rem', fontWeight: 700, color: '#34d399', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
          >
            Cargar movimientos <ChevronRight size={12} />
          </button>
        </div>
      )}

      {!loading && plan && plan.hasData && (
        <>
          {/* Status card */}
          <div style={{
            background: `linear-gradient(145deg, ${plan.statusColor}10 0%, rgba(4,7,15,0.72) 100%)`,
            border: `1px solid ${plan.statusColor}30`,
            borderRadius: '1.25rem',
            padding: '1rem 1.125rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
              <span style={{ fontSize: '0.68rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Estado del mes</span>
              <span style={{
                fontSize: '0.65rem', fontWeight: 700, color: plan.statusColor,
                background: `${plan.statusColor}18`, border: `1px solid ${plan.statusColor}30`,
                borderRadius: 99, padding: '0.15rem 0.6rem',
                textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>
                {plan.statusLabel}
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '0.875rem' }}>
              {[
                { label: 'Ingresos confirmados', value: amt(plan.totalIncome),      color: '#34d399' },
                { label: 'Gastos confirmados',   value: amt(plan.totalExpense),     color: '#f87171' },
                { label: 'Compromisos',          value: amt(plan.totalCommitments), color: '#fbbf24' },
                { label: 'Margen estimado',      value: (plan.estimatedResult >= 0 ? '+' : '') + amt(plan.estimatedResult), color: plan.estimatedResult >= 0 ? '#818cf8' : '#f87171' },
              ].map(item => (
                <div key={item.label}>
                  <div style={{ fontSize: '0.6rem', color: '#334155', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.15rem' }}>{item.label}</div>
                  <div style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '0.9rem', color: item.color }}>{item.value}</div>
                </div>
              ))}
            </div>

            {/* Spendable margin highlight */}
            <div style={{ background: `${plan.statusColor}0c`, border: `1px solid ${plan.statusColor}20`, borderRadius: '0.75rem', padding: '0.625rem 0.875rem' }}>
              <div style={{ fontSize: '0.6rem', color: '#334155', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.2rem' }}>
                Puedo gastar libremente
              </div>
              <div style={{ fontFamily: 'monospace', fontWeight: 900, fontSize: '1.375rem', color: plan.spendableMargin > 0 ? plan.statusColor : '#f87171' }}>
                {amt(plan.spendableMargin)}
              </div>
              {plan.spendableMargin === 0 && (
                <div style={{ fontSize: '0.72rem', color: '#475569', marginTop: '0.2rem' }}>
                  No hay margen libre este mes. Priorizá los compromisos pendientes.
                </div>
              )}
            </div>
          </div>

          {/* Priorities */}
          {plan.priorities.length > 0 && (
            <div>
              <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.5rem' }}>
                Qué pagar primero
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                {plan.priorities.filter(p => p.kind !== 'paid').map(p => (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', background: 'rgba(255,255,255,0.025)', border: `1px solid ${kindColor(p.kind)}18`, borderRadius: '0.75rem', padding: '0.625rem 0.875rem' }}>
                    <div style={{ flexShrink: 0 }}>{kindIcon(p.kind)}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: '0.8125rem', color: '#e2e8f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.label}</div>
                      {p.dueDate && (
                        <div style={{ fontSize: '0.68rem', color: '#475569' }}>
                          Vence: {new Date(p.dueDate + 'T12:00:00').toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })}
                          {p.kind === 'overdue' && <span style={{ color: '#f87171', marginLeft: '0.375rem' }}>Vencido</span>}
                        </div>
                      )}
                    </div>
                    <div style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '0.9rem', color: kindColor(p.kind), flexShrink: 0 }}>
                      {hidden ? MASK : fmtMoneyCompact(p.amount)}{p.currency !== 'ARS' ? ` ${p.currency}` : ''}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recommendations */}
          <div>
            <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.5rem' }}>
              Qué conviene hacer
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
              {plan.recommendations.map(rec => (
                <div key={rec.id} style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.75rem', padding: '0.75rem 0.875rem' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <TrendingUp size={14} color="#818cf8" style={{ flexShrink: 0, marginTop: '0.1rem' }} />
                    <p style={{ margin: 0, fontSize: '0.8125rem', color: '#cbd5e1', lineHeight: 1.5, flex: 1 }}>{rec.text}</p>
                  </div>
                  {rec.actionLabel && rec.actionRoute && (
                    <button
                      onClick={() => navigate(rec.actionRoute!)}
                      style={{ marginTop: '0.5rem', background: 'rgba(129,140,248,0.1)', border: '1px solid rgba(129,140,248,0.2)', borderRadius: '0.5rem', padding: '0.25rem 0.75rem', fontSize: '0.72rem', fontWeight: 700, color: '#818cf8', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
                    >
                      {rec.actionLabel} <ChevronRight size={11} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Avoidances */}
          {plan.avoidances.length > 0 && (
            <div>
              <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.5rem' }}>
                Qué evitar este mes
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                {plan.avoidances.map(av => (
                  <div key={av.id} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.625rem', background: 'rgba(248,113,113,0.04)', border: '1px solid rgba(248,113,113,0.12)', borderRadius: '0.75rem', padding: '0.625rem 0.875rem' }}>
                    <AlertCircle size={14} color="#f87171" style={{ flexShrink: 0, marginTop: '0.1rem' }} />
                    <p style={{ margin: 0, fontSize: '0.8125rem', color: '#cbd5e1', lineHeight: 1.5 }}>{av.text}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Upcoming commitments */}
          {plan.upcomingCommitments.length > 0 && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                  Calendario de compromisos
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                {plan.upcomingCommitments
                  .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))
                  .map(c => (
                    <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.5rem 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <div style={{ flexShrink: 0 }}>
                        {c.isPaid
                          ? <CheckCircle2 size={14} color="#34d399" />
                          : c.isOverdue
                            ? <AlertCircle size={14} color="#f87171" />
                            : <CalendarDays size={14} color="#60a5fa" />
                        }
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: '0.78rem', color: c.isPaid ? '#475569' : '#e2e8f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textDecoration: c.isPaid ? 'line-through' : 'none' }}>
                          {c.label}
                        </div>
                        {c.dueDate && (
                          <div style={{ fontSize: '0.65rem', color: '#334155' }}>
                            {new Date(c.dueDate + 'T12:00:00').toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })}
                          </div>
                        )}
                      </div>
                      <div style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '0.8125rem', color: c.isPaid ? '#334155' : c.isOverdue ? '#f87171' : '#94a3b8', flexShrink: 0 }}>
                        {hidden ? MASK : fmtMoneyCompact(c.amount)}{c.currency !== 'ARS' ? ` ${c.currency}` : ''}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Diagnóstico link */}
          <button
            onClick={() => navigate('/personal/insights')}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.875rem', padding: '0.875rem 1rem', cursor: 'pointer' }}
          >
            <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#94a3b8' }}>Ver diagnóstico completo</span>
            <ChevronRight size={14} color="#334155" />
          </button>
        </>
      )}

    </PageContainer>
  )
}
