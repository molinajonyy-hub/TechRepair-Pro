import type { PersonalTransaction } from './personalService'
import type { CreditCard, CardPurchase, PersonalCardPayment } from './creditCardService'
import type { PersonalDebt } from './debtService'
import type { RecurringExpense, RecurringExpensePayment } from './recurringExpenseService'
import type { BudgetUsage } from './budgetService'
import { isOverdue, getDebtPaidPercent } from './debtService'
import {
  getNextDueDate, getAllCardsStatementTotal, getFutureInstallmentsTotal,
  getCardStatementTotal, addMonths,
} from '../utils/creditCards'
import { getRecurringStatusForMonth } from './recurringExpenseService'

// ── Types ──────────────────────────────────────────────────────────────────────

export type InsightSeverity = 'success' | 'info' | 'warning' | 'danger'
export type InsightCategory = 'alert' | 'opportunity' | 'health'

export interface PersonalInsight {
  id: string
  type: string
  category: InsightCategory
  severity: InsightSeverity
  title: string
  message: string
  hiddenMessage: string
  amount?: number
  currency?: 'ARS' | 'USD'
  actionLabel?: string
  actionRoute?: string
  priority: number
}

export interface InsightInput {
  month: string
  summary: { totalIncome: number; totalExpense: number }
  prevSummary: { totalIncome: number; totalExpense: number } | null
  budgetUsages: BudgetUsage[]
  cards: CreditCard[]
  cardPurchases: CardPurchase[]
  cardPayments: PersonalCardPayment[]
  debts: PersonalDebt[]
  recurringExpenses: RecurringExpense[]
  recurringPayments: RecurringExpensePayment[]
  transactions: PersonalTransaction[]
}

// ── Internal formatter ────────────────────────────────────────────────────────

function fmtARS(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `$${Math.round(abs / 1_000)}k`
  return `$${Math.round(abs)}`
}

// ── Exported helpers ──────────────────────────────────────────────────────────

export function getInsightSeverity(insight: PersonalInsight): InsightSeverity {
  return insight.severity
}

export function getInsightIcon(insight: PersonalInsight): string {
  const ICONS: Record<string, string> = {
    budget_exceeded:           'TrendingDown',
    budget_warning:            'AlertTriangle',
    budget_healthy:            'CheckCircle',
    card_due_soon:             'CreditCard',
    card_heavy:                'CreditCard',
    card_future_high:          'BarChart3',
    debt_overdue:              'AlertCircle',
    debt_due_soon:             'Clock',
    debt_receivable:           'Wallet',
    debt_almost_paid:          'CheckCircle',
    projection_negative:       'TrendingDown',
    commitments_ratio_high:    'BarChart3',
    top_expense_category:      'Tag',
    spending_ratio_high:       'TrendingDown',
    spending_vs_prev_increase: 'TrendingUp',
    savings_possible:          'TrendingUp',
    recurring_overdue:         'RepeatIcon',
  }
  return ICONS[insight.type] ?? 'Info'
}

export function getInsightPriority(insight: PersonalInsight): number {
  return insight.priority
}

export function getTopInsights(insights: PersonalInsight[], n = 3): PersonalInsight[] {
  return [...insights].sort((a, b) => b.priority - a.priority).slice(0, n)
}

// ── Core computation ──────────────────────────────────────────────────────────

export function buildPersonalInsights(input: InsightInput): PersonalInsight[] {
  const insights: PersonalInsight[] = []
  const now         = new Date()
  const income      = Math.max(0, Number(input.summary.totalIncome))
  const expense     = Math.max(0, Number(input.summary.totalExpense))
  const [yearNum, monthNum] = input.month.split('-').map(Number)
  const monthMidpoint = new Date(yearNum, monthNum - 1, 15)

  // ── Budget insights ──────────────────────────────────────────────────────────

  const activeBudgetUsages = input.budgetUsages.filter(u => u.budget.status === 'active')

  for (const u of activeBudgetUsages.filter(u => u.status === 'exceeded')) {
    const cat = u.budget.category?.name ?? 'esta categoría'
    insights.push({
      id:            `budget_exceeded_${u.budget.id}`,
      type:          'budget_exceeded',
      category:      'alert',
      severity:      'danger',
      title:         `Presupuesto de ${cat} excedido`,
      message:       `Gastaste ${fmtARS(u.spent)} de un límite de ${fmtARS(Number(u.budget.amount))} (${Math.round(u.percentUsed)}%).`,
      hiddenMessage: `Superaste el límite de ${cat} este mes.`,
      amount:        u.spent,
      currency:      u.budget.currency as 'ARS' | 'USD',
      actionLabel:   'Ver presupuestos',
      actionRoute:   '/personal/presupuestos',
      priority:      10,
    })
  }

  for (const u of activeBudgetUsages.filter(u => u.status === 'warning')) {
    const cat = u.budget.category?.name ?? 'esta categoría'
    insights.push({
      id:            `budget_warning_${u.budget.id}`,
      type:          'budget_warning',
      category:      'alert',
      severity:      'warning',
      title:         `Cerca del límite en ${cat}`,
      message:       `Usaste el ${Math.round(u.percentUsed)}% del presupuesto de ${cat}. Quedan ${fmtARS(u.remaining)}.`,
      hiddenMessage: `Estás cerca del límite en ${cat} este mes.`,
      actionLabel:   'Ver presupuestos',
      actionRoute:   '/personal/presupuestos',
      priority:      7,
    })
  }

  if (activeBudgetUsages.length > 0 && activeBudgetUsages.every(u => u.status === 'healthy')) {
    insights.push({
      id:            'budget_healthy',
      type:          'budget_healthy',
      category:      'health',
      severity:      'success',
      title:         'Presupuestos bajo control',
      message:       `Todos tus ${activeBudgetUsages.length} presupuesto${activeBudgetUsages.length > 1 ? 's' : ''} están en verde.`,
      hiddenMessage: 'Todos tus presupuestos están en verde. ¡Bien ahí!',
      actionLabel:   'Ver presupuestos',
      actionRoute:   '/personal/presupuestos',
      priority:      2,
    })
  }

  // ── Debt insights ─────────────────────────────────────────────────────────────

  const activeDebts = input.debts.filter(d => d.status === 'active')

  const overdueDebts = activeDebts.filter(d => d.type === 'debt' && isOverdue(d))
  if (overdueDebts.length > 0) {
    const totalOverdue = overdueDebts
      .filter(d => d.currency === 'ARS')
      .reduce((s, d) => s + Number(d.current_balance), 0)
    insights.push({
      id:            'debt_overdue',
      type:          'debt_overdue',
      category:      'alert',
      severity:      'danger',
      title:         `${overdueDebts.length} deuda${overdueDebts.length > 1 ? 's' : ''} vencida${overdueDebts.length > 1 ? 's' : ''}`,
      message:       overdueDebts.length === 1
        ? `"${overdueDebts[0].name}" venció y tiene un saldo de ${fmtARS(Number(overdueDebts[0].current_balance))}.`
        : `Tenés ${overdueDebts.length} deudas vencidas${totalOverdue > 0 ? ` por ${fmtARS(totalOverdue)}` : ''}.`,
      hiddenMessage: overdueDebts.length === 1
        ? `"${overdueDebts[0].name}" venció. Revisá la deuda.`
        : `Tenés ${overdueDebts.length} deudas vencidas.`,
      amount:        totalOverdue > 0 ? totalOverdue : undefined,
      currency:      totalOverdue > 0 ? 'ARS' : undefined,
      actionLabel:   'Ver deudas',
      actionRoute:   '/personal/deudas',
      priority:      10,
    })
  }

  const dueSoonDebts = activeDebts.filter(d => {
    if (d.type !== 'debt' || isOverdue(d) || !d.next_due_date) return false
    const ms   = new Date(d.next_due_date + 'T12:00:00').getTime() - now.getTime()
    const days = Math.ceil(ms / 86_400_000)
    return days >= 0 && days <= 7
  })
  if (dueSoonDebts.length > 0) {
    const d    = dueSoonDebts[0]
    const days = Math.ceil((new Date(d.next_due_date! + 'T12:00:00').getTime() - now.getTime()) / 86_400_000)
    insights.push({
      id:            `debt_due_soon_${d.id}`,
      type:          'debt_due_soon',
      category:      'alert',
      severity:      'warning',
      title:         'Deuda próxima a vencer',
      message:       `"${d.name}" vence en ${days} día${days !== 1 ? 's' : ''}${d.installment_amount ? ` — cuota de ${fmtARS(Number(d.installment_amount))}` : ''}.`,
      hiddenMessage: `"${d.name}" vence próximamente. No te olvides.`,
      actionLabel:   'Ver deudas',
      actionRoute:   '/personal/deudas',
      priority:      9,
    })
  }

  const activeReceivables      = activeDebts.filter(d => d.type === 'receivable')
  const totalReceivableARS     = activeReceivables.filter(d => d.currency === 'ARS').reduce((s, d) => s + Number(d.current_balance), 0)
  if (totalReceivableARS > 0) {
    insights.push({
      id:            'debt_receivable',
      type:          'debt_receivable',
      category:      'opportunity',
      severity:      'info',
      title:         'Plata pendiente de cobrar',
      message:       `Te deben ${fmtARS(totalReceivableARS)} en ${activeReceivables.length} préstamo${activeReceivables.length > 1 ? 's' : ''} activo${activeReceivables.length > 1 ? 's' : ''}.`,
      hiddenMessage: 'Tenés préstamos activos pendientes de cobrar.',
      amount:        totalReceivableARS,
      currency:      'ARS',
      actionLabel:   'Ver deudas',
      actionRoute:   '/personal/deudas',
      priority:      3,
    })
  }

  const almostPaid = activeDebts.filter(d => d.type === 'debt' && getDebtPaidPercent(d) >= 80)
  for (const d of almostPaid) {
    const pct = Math.round(getDebtPaidPercent(d))
    insights.push({
      id:            `debt_almost_paid_${d.id}`,
      type:          'debt_almost_paid',
      category:      'opportunity',
      severity:      'success',
      title:         `"${d.name}" casi cancelada`,
      message:       `Pagaste el ${pct}% de esta deuda. Quedan ${fmtARS(Number(d.current_balance))}.`,
      hiddenMessage: `Pagaste el ${pct}% de "${d.name}". ¡Casi terminás!`,
      actionLabel:   'Ver deudas',
      actionRoute:   '/personal/deudas',
      priority:      2,
    })
  }

  // ── Card insights ─────────────────────────────────────────────────────────────

  const activeCards  = input.cards.filter(c => c.is_active)
  const cardsTotal   = getAllCardsStatementTotal(input.cardPurchases, input.month)
  const paidCardIds  = new Set(
    input.cardPayments.filter(p => p.period === input.month).map(p => p.credit_card_id)
  )

  if (income > 0 && cardsTotal > income * 0.35) {
    const pct = Math.round((cardsTotal / income) * 100)
    insights.push({
      id:            'card_heavy',
      type:          'card_heavy',
      category:      'alert',
      severity:      'warning',
      title:         'Tarjetas pesan fuerte este mes',
      message:       `Tus tarjetas representan el ${pct}% de tus ingresos (${fmtARS(cardsTotal)}).`,
      hiddenMessage: 'Tus tarjetas representan una parte importante de tus ingresos este mes.',
      amount:        cardsTotal,
      currency:      'ARS',
      actionLabel:   'Ver tarjetas',
      actionRoute:   '/personal/tarjetas',
      priority:      8,
    })
  }

  for (const card of activeCards) {
    if (paidCardIds.has(card.id)) continue
    const dueDate  = getNextDueDate(card)
    const daysUntil = Math.ceil((dueDate.getTime() - now.getTime()) / 86_400_000)
    if (daysUntil < 0 || daysUntil > 5) continue
    const cardTotal = getCardStatementTotal(card.id, input.cardPurchases, input.month)
    if (cardTotal <= 0) continue
    insights.push({
      id:            `card_due_soon_${card.id}`,
      type:          'card_due_soon',
      category:      'alert',
      severity:      daysUntil <= 2 ? 'danger' : 'warning',
      title:         daysUntil === 0 ? `${card.name} vence hoy` : `${card.name} vence en ${daysUntil} día${daysUntil > 1 ? 's' : ''}`,
      message:       `Resumen de ${card.name}: ${fmtARS(cardTotal)} vence el ${dueDate.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })}.`,
      hiddenMessage: `El resumen de ${card.name} vence pronto.`,
      amount:        cardTotal,
      currency:      'ARS',
      actionLabel:   'Ver tarjetas',
      actionRoute:   '/personal/tarjetas',
      priority:      daysUntil <= 2 ? 10 : 9,
    })
  }

  const futureMonth = addMonths(input.month, 1)
  const futureTotal = getFutureInstallmentsTotal(input.cardPurchases, futureMonth)
  if (futureTotal > 0 && income > 0 && futureTotal > income * 1.5) {
    insights.push({
      id:            'card_future_high',
      type:          'card_future_high',
      category:      'health',
      severity:      'info',
      title:         'Cuotas futuras a tener en cuenta',
      message:       `Tenés ${fmtARS(futureTotal)} en cuotas pendientes a partir del mes que viene.`,
      hiddenMessage: 'Tenés cuotas significativas pendientes en los próximos meses.',
      amount:        futureTotal,
      currency:      'ARS',
      actionLabel:   'Ver tarjetas',
      actionRoute:   '/personal/tarjetas',
      priority:      4,
    })
  }

  // ── Recurring overdue ────────────────────────────────────────────────────────

  const activeMonthlyRec = input.recurringExpenses.filter(
    e => e.status === 'active' && e.frequency === 'monthly'
  )
  const overdueRec = activeMonthlyRec.filter(
    e => getRecurringStatusForMonth(e, input.recurringPayments, monthMidpoint) === 'overdue'
  )
  if (overdueRec.length > 0) {
    const totalRec = overdueRec.filter(e => e.currency === 'ARS').reduce((s, e) => s + Number(e.amount), 0)
    insights.push({
      id:            'recurring_overdue',
      type:          'recurring_overdue',
      category:      'alert',
      severity:      'warning',
      title:         `${overdueRec.length} gasto${overdueRec.length > 1 ? 's' : ''} fijo${overdueRec.length > 1 ? 's' : ''} vencido${overdueRec.length > 1 ? 's' : ''}`,
      message:       overdueRec.length === 1
        ? `"${overdueRec[0].name}" vencido sin registrar este mes.`
        : `${overdueRec.length} gastos fijos vencidos${totalRec > 0 ? ` por ${fmtARS(totalRec)}` : ''}.`,
      hiddenMessage: 'Tenés gastos fijos vencidos sin registrar.',
      actionLabel:   'Ver gastos fijos',
      actionRoute:   '/personal/gastos-fijos',
      priority:      8,
    })
  }

  // ── Projection/commitment insights ────────────────────────────────────────────

  const recurringTotal    = activeMonthlyRec.reduce((s, e) => s + Number(e.amount), 0)
  const debtInstallments  = input.debts
    .filter(d => d.status === 'active' && d.type === 'debt')
    .reduce((s, d) => s + Number(d.installment_amount ?? 0), 0)
  const totalCommitments  = cardsTotal + recurringTotal + debtInstallments

  if (income > 0 && (expense + totalCommitments) > income) {
    const deficit = (expense + totalCommitments) - income
    insights.push({
      id:            'projection_negative',
      type:          'projection_negative',
      category:      'alert',
      severity:      'danger',
      title:         'Compromisos superan ingresos',
      message:       `Con tus compromisos del mes, estarías ${fmtARS(deficit)} en negativo.`,
      hiddenMessage: 'Tus compromisos superan tus ingresos proyectados este mes.',
      amount:        deficit,
      currency:      'ARS',
      actionLabel:   'Ver proyección',
      actionRoute:   '/personal/proyecciones',
      priority:      10,
    })
  }

  if (income > 0 && totalCommitments > 0) {
    const ratio = (totalCommitments / income) * 100
    if (ratio >= 60) {
      insights.push({
        id:            'commitments_ratio_high',
        type:          'commitments_ratio_high',
        category:      'health',
        severity:      ratio >= 80 ? 'warning' : 'info',
        title:         'Compromisos fijos significativos',
        message:       `Tus compromisos representan el ${Math.round(ratio)}% de tus ingresos (${fmtARS(totalCommitments)}).`,
        hiddenMessage: 'Tus compromisos representan una parte importante de tus ingresos este mes.',
        actionLabel:   'Ver proyección',
        actionRoute:   '/personal/proyecciones',
        priority:      ratio >= 80 ? 7 : 4,
      })
    }
  }

  if (income > 0) {
    const estimatedSavings = income - expense - totalCommitments
    if (estimatedSavings > income * 0.1) {
      insights.push({
        id:            'savings_possible',
        type:          'savings_possible',
        category:      'opportunity',
        severity:      'success',
        title:         'Oportunidad de ahorro',
        message:       `Este mes podrías ahorrar aproximadamente ${fmtARS(estimatedSavings)}.`,
        hiddenMessage: 'Este mes tenés margen para ahorrar una parte interesante.',
        amount:        estimatedSavings,
        currency:      'ARS',
        priority:      2,
      })
    }
  }

  // ── Habit insights (from transactions) ───────────────────────────────────────

  const monthExpenses = input.transactions.filter(t => t.type === 'expense' && t.currency === 'ARS')

  if (income > 0 && expense > income * 0.8) {
    const pct = Math.round((expense / income) * 100)
    insights.push({
      id:            'spending_ratio_high',
      type:          'spending_ratio_high',
      category:      'alert',
      severity:      expense > income ? 'danger' : 'warning',
      title:         `Gasto elevado este mes`,
      message:       `Gastaste el ${pct}% de tus ingresos (${fmtARS(expense)} de ${fmtARS(income)}).`,
      hiddenMessage: `Gastaste el ${pct}% de tus ingresos este mes.`,
      priority:      expense > income ? 9 : 6,
    })
  }

  if (monthExpenses.length > 0) {
    const catTotals = new Map<string, { name: string; icon: string; total: number }>()
    for (const tx of monthExpenses) {
      if (!tx.category_id || !tx.category) continue
      const existing = catTotals.get(tx.category_id)
      if (existing) {
        existing.total += Number(tx.amount)
      } else {
        catTotals.set(tx.category_id, { name: tx.category.name, icon: tx.category.icon, total: Number(tx.amount) })
      }
    }
    const topCat = [...catTotals.values()].sort((a, b) => b.total - a.total)[0]
    if (topCat && topCat.total > 0) {
      insights.push({
        id:            'top_expense_category',
        type:          'top_expense_category',
        category:      'health',
        severity:      'info',
        title:         `${topCat.icon} ${topCat.name} es tu mayor gasto`,
        message:       `Gastaste ${fmtARS(topCat.total)} en ${topCat.name} este mes.`,
        hiddenMessage: `${topCat.name} es tu categoría con más gasto este mes.`,
        amount:        topCat.total,
        currency:      'ARS',
        priority:      3,
      })
    }
  }

  if (input.prevSummary) {
    const prevExpense   = Number(input.prevSummary.totalExpense)
    if (prevExpense > 0 && expense > 0) {
      const changeRatio = (expense - prevExpense) / prevExpense
      if (changeRatio >= 0.2) {
        const pctChange = Math.round(changeRatio * 100)
        insights.push({
          id:            'spending_vs_prev_increase',
          type:          'spending_vs_prev_increase',
          category:      'health',
          severity:      changeRatio >= 0.4 ? 'warning' : 'info',
          title:         `Gastos subieron un ${pctChange}% vs mes anterior`,
          message:       `Gastaste ${fmtARS(expense)} este mes vs ${fmtARS(prevExpense)} el mes anterior.`,
          hiddenMessage: 'Tus gastos aumentaron respecto al mes anterior.',
          priority:      changeRatio >= 0.4 ? 6 : 3,
        })
      }
    }
  }

  return insights.sort((a, b) => b.priority - a.priority)
}
