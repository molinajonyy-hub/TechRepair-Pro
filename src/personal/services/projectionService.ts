import type { CreditCard, CardPurchase, PersonalCardPayment } from './creditCardService'
import type { PersonalDebt } from './debtService'
import { getCardStatementTotal, getAllCardsStatementTotal } from '../utils/creditCards'
import { getRecurringStatusForMonth, type RecurringExpense, type RecurringExpensePayment } from './recurringExpenseService'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ProjectionCommitment {
  id: string
  type: 'card' | 'debt' | 'recurring'
  name: string
  amount: number
  currency: string
  dueDate: string | null
  isPaid: boolean
  isOverdue: boolean
  detail: string | null
}

export type AlertLevel = 'danger' | 'warning' | 'info' | 'success'

export interface ProjectionAlert {
  level: AlertLevel
  message: string
}

export interface MonthlyProjection {
  month: string
  // Confirmed (from real transactions)
  incomeConfirmed: number
  expensesConfirmed: number
  // Credit cards
  cardsTotal: number      // installments due this month (ARS)
  cardsPaid: number       // statement payments already made this period
  cardsPending: number    // = cardsTotal - cardsPaid (min 0)
  // Recurring fixed expenses
  recurringTotal: number
  recurringPaid: number
  recurringPending: number
  // Debt installments (expected, ARS)
  debtInstallments: number
  // Totals
  totalCommitments: number   // cardsPending + recurringPending + debtInstallments
  estimatedResult: number    // incomeConfirmed - expensesConfirmed - totalCommitments
  // Breakdown
  commitments: ProjectionCommitment[]
  alerts: ProjectionAlert[]
  smartMessage: string
  hasData: boolean
}

// ── Internal compact formatter (avoids importing from UI layer) ────────────────

function fmtARS(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `$${Math.round(abs / 1_000)}k`
  return `$${Math.round(abs)}`
}

// ── Core computation ──────────────────────────────────────────────────────────

/**
 * Builds a monthly projection from pre-fetched data arrays.
 * Pure function — no DB calls.
 */
export function buildProjection(
  month: string,
  summary: { totalIncome: number; totalExpense: number },
  cards: CreditCard[],
  cardPurchases: CardPurchase[],
  cardPayments: PersonalCardPayment[],
  recurringExpenses: RecurringExpense[],
  recurringPaymentsForMonth: RecurringExpensePayment[],
  debts: PersonalDebt[]
): MonthlyProjection {
  const incomeConfirmed   = Number(summary.totalIncome)
  const expensesConfirmed = Number(summary.totalExpense)

  const [year, monthNum] = month.split('-').map(Number)
  const monthMidpoint    = new Date(year, monthNum - 1, 15)
  const today            = new Date().toISOString().split('T')[0]

  // ── Credit cards ────────────────────────────────────────────────────────────

  const cardsTotal          = getAllCardsStatementTotal(cardPurchases, month)
  const paymentsThisPeriod  = cardPayments.filter(p => p.period === month)
  const cardsPaid           = paymentsThisPeriod.reduce((s, p) => s + Number(p.amount), 0)
  const cardsPending        = Math.max(0, cardsTotal - cardsPaid)

  const cardCommitments: ProjectionCommitment[] = []
  for (const card of cards) {
    const total = getCardStatementTotal(card.id, cardPurchases, month)
    if (total <= 0) continue
    const payment = paymentsThisPeriod.find(p => p.credit_card_id === card.id)
    cardCommitments.push({
      id:        card.id,
      type:      'card',
      name:      card.name,
      amount:    total,
      currency:  card.currency ?? 'ARS',
      dueDate:   null,
      isPaid:    !!payment,
      isOverdue: false,
      detail:    card.issuer ?? null,
    })
  }

  // ── Recurring fixed expenses (monthly only) ─────────────────────────────────

  const activeMonthly = recurringExpenses.filter(
    e => e.status === 'active' && e.frequency === 'monthly'
  )
  let recurringTotal = 0
  let recurringPaid  = 0
  const recurringCommitments: ProjectionCommitment[] = []

  for (const expense of activeMonthly) {
    const amount  = Number(expense.amount)
    recurringTotal += amount
    const status   = getRecurringStatusForMonth(expense, recurringPaymentsForMonth, monthMidpoint)
    const isPaid   = status === 'paid'
    const isOverdue = status === 'overdue'
    if (isPaid) recurringPaid += amount

    let dueDate: string | null = null
    if (expense.due_day) {
      const lastDay = new Date(year, monthNum, 0).getDate()
      const d = Math.min(expense.due_day, lastDay)
      dueDate = `${year}-${String(monthNum).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    }

    recurringCommitments.push({
      id: expense.id, type: 'recurring', name: expense.name,
      amount, currency: expense.currency, dueDate,
      isPaid, isOverdue, detail: null,
    })
  }
  const recurringPending = Math.max(0, recurringTotal - recurringPaid)

  // ── Debt installments ───────────────────────────────────────────────────────

  const activeDebts = debts.filter(d => d.status === 'active' && d.type === 'debt')
  let debtInstallments = 0
  const debtCommitments: ProjectionCommitment[] = []

  for (const debt of activeDebts) {
    const installment = Number(debt.installment_amount ?? 0)
    if (installment <= 0) continue
    debtInstallments += installment

    let dueDate: string | null = null
    if (debt.due_day) {
      const lastDay = new Date(year, monthNum, 0).getDate()
      const d = Math.min(debt.due_day, lastDay)
      dueDate = `${year}-${String(monthNum).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    }
    const isOverdue = !!debt.next_due_date && debt.next_due_date < today

    debtCommitments.push({
      id: debt.id, type: 'debt', name: debt.name,
      amount: installment, currency: debt.currency,
      dueDate: dueDate ?? debt.next_due_date,
      isPaid: false, isOverdue,
      detail: debt.lender_name,
    })
  }

  // ── Totals ──────────────────────────────────────────────────────────────────

  const totalCommitments = cardsPending + recurringPending + debtInstallments
  const estimatedResult  = incomeConfirmed - expensesConfirmed - totalCommitments

  // ── Sorted commitments ──────────────────────────────────────────────────────

  const commitments: ProjectionCommitment[] = [
    ...cardCommitments,
    ...recurringCommitments,
    ...debtCommitments,
  ].sort((a, b) => {
    if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1
    if (!a.isPaid && b.isPaid) return -1
    if (a.isPaid && !b.isPaid) return 1
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate)
    if (a.dueDate) return -1
    if (b.dueDate) return 1
    return b.amount - a.amount
  })

  // ── Alerts ──────────────────────────────────────────────────────────────────

  const alerts: ProjectionAlert[] = []

  if (estimatedResult < 0 && incomeConfirmed > 0) {
    alerts.push({ level: 'danger', message: 'Ojo, tus compromisos superan tus ingresos este mes.' })
  }

  const overdueDebtCount = activeDebts.filter(
    d => d.next_due_date && d.next_due_date < today
  ).length
  if (overdueDebtCount > 0) {
    alerts.push({
      level: 'warning',
      message: `Tenés ${overdueDebtCount} deuda${overdueDebtCount > 1 ? 's' : ''} vencida${overdueDebtCount > 1 ? 's' : ''}.`,
    })
  }

  const overdueRecurringCount = activeMonthly.filter(
    e => getRecurringStatusForMonth(e, recurringPaymentsForMonth, monthMidpoint) === 'overdue'
  ).length
  if (overdueRecurringCount > 0) {
    alerts.push({
      level: 'warning',
      message: `${overdueRecurringCount} gasto${overdueRecurringCount > 1 ? 's' : ''} fijo${overdueRecurringCount > 1 ? 's' : ''} vencido${overdueRecurringCount > 1 ? 's' : ''}.`,
    })
  }

  if (incomeConfirmed > 0 && cardsTotal > 0 && cardsTotal > incomeConfirmed * 0.35) {
    alerts.push({ level: 'warning', message: 'Tus tarjetas pesan fuerte este mes.' })
  }

  // ── Smart message ────────────────────────────────────────────────────────────

  const hasData = incomeConfirmed > 0 || expensesConfirmed > 0 ||
    cardsTotal > 0 || recurringTotal > 0 || debtInstallments > 0

  let smartMessage: string
  if (!hasData) {
    smartMessage = 'Registrá movimientos, tarjetas o deudas para ver tu proyección.'
  } else if (estimatedResult < 0) {
    smartMessage = 'Ojo, tus compromisos superan tus ingresos proyectados.'
  } else if (incomeConfirmed > 0 && estimatedResult > incomeConfirmed * 0.15) {
    smartMessage = `Este mes venís cómodo. Podrías ahorrar aproximadamente ${fmtARS(estimatedResult)}.`
  } else {
    smartMessage = 'Tu mes está equilibrado.'
  }

  return {
    month,
    incomeConfirmed,
    expensesConfirmed,
    cardsTotal,
    cardsPaid,
    cardsPending,
    recurringTotal,
    recurringPaid,
    recurringPending,
    debtInstallments,
    totalCommitments,
    estimatedResult,
    commitments,
    alerts,
    smartMessage,
    hasData,
  }
}
