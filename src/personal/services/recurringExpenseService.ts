import { supabase } from '../../lib/supabase'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RecurringExpense {
  id: string
  user_id: string
  name: string
  description: string | null
  category_id: string | null
  default_account_id: string | null
  currency: string
  amount: number
  frequency: 'monthly' | 'weekly' | 'yearly' | 'custom'
  due_day: number | null
  next_due_date: string | null
  auto_create_transaction: boolean
  status: 'active' | 'paused' | 'cancelled'
  created_at: string
  updated_at: string
}

export interface RecurringExpensePayment {
  id: string
  user_id: string
  recurring_expense_id: string
  account_id: string | null
  transaction_id: string | null
  currency: string
  amount: number
  paid_date: string
  period_year: number
  period_month: number
  notes: string | null
  created_at: string
}

export type RecurringStatus = 'paid' | 'overdue' | 'pending' | 'upcoming' | 'paused' | 'cancelled'

export interface RecurringSummary {
  monthlyTotalARS: number
  monthlyTotalUSD: number
  pendingARS: number
  pendingUSD: number
  paidCount: number
  pendingCount: number
  nextDueDate: string | null
  nextDueName: string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export const FREQUENCY_LABELS: Record<RecurringExpense['frequency'], string> = {
  monthly: 'Mensual', weekly: 'Semanal', yearly: 'Anual', custom: 'Personalizado',
}

export const STATUS_COLORS: Record<RecurringStatus, string> = {
  paid:      '#34d399',
  overdue:   '#f87171',
  pending:   '#fbbf24',
  upcoming:  '#60a5fa',
  paused:    '#475569',
  cancelled: '#334155',
}

export const STATUS_LABELS: Record<RecurringStatus, string> = {
  paid:      'Pagado',
  overdue:   'Vencido',
  pending:   'Pendiente',
  upcoming:  'Próximo',
  paused:    'Pausado',
  cancelled: 'Cancelado',
}

/** Calculate next due date for a monthly expense from a given month. */
export function calcNextDueDate(dueDay: number, fromDate?: Date): string {
  const base = fromDate ?? new Date()
  const year = base.getFullYear()
  const month = base.getMonth()
  // clamp day to end of current month
  const lastDay = new Date(year, month + 1, 0).getDate()
  const d = Math.min(dueDay, lastDay)
  const candidate = new Date(year, month, d)
  if (candidate < base) {
    // Push to next month
    const nm = month + 1
    const ny = nm > 11 ? year + 1 : year
    const ml = new Date(ny, nm % 12 + 1, 0).getDate()
    return `${ny}-${String((nm % 12) + 1).padStart(2, '0')}-${String(Math.min(dueDay, ml)).padStart(2, '0')}`
  }
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** Returns the recurring status for the current month. */
export function getRecurringStatusForMonth(
  expense: RecurringExpense,
  payments: RecurringExpensePayment[],
  now = new Date()
): RecurringStatus {
  if (expense.status === 'cancelled') return 'cancelled'
  if (expense.status === 'paused') return 'paused'

  const year  = now.getFullYear()
  const month = now.getMonth() + 1 // 1-indexed

  const paid = payments.some(
    p => p.recurring_expense_id === expense.id &&
         p.period_year === year && p.period_month === month
  )
  if (paid) return 'paid'

  if (!expense.due_day) return 'pending'

  // Due day this month
  const lastDay = new Date(year, month, 0).getDate()
  const dueDate = new Date(year, month - 1, Math.min(expense.due_day, lastDay))

  if (dueDate < now) return 'overdue'
  // upcoming = more than 5 days away
  const daysUntil = Math.ceil((dueDate.getTime() - now.getTime()) / 86_400_000)
  return daysUntil <= 5 ? 'pending' : 'upcoming'
}

export function getMonthlyFixedTotal(expenses: RecurringExpense[], currency: string): number {
  return expenses
    .filter(e => e.status === 'active' && e.currency === currency && e.frequency === 'monthly')
    .reduce((s, e) => s + Number(e.amount), 0)
}

export function getPendingFixedTotal(
  expenses: RecurringExpense[],
  payments: RecurringExpensePayment[],
  currency: string,
  now = new Date()
): number {
  return expenses
    .filter(e => {
      const st = getRecurringStatusForMonth(e, payments, now)
      return (st === 'pending' || st === 'overdue') && e.currency === currency
    })
    .reduce((s, e) => s + Number(e.amount), 0)
}

// ── Service ───────────────────────────────────────────────────────────────────

export const recurringExpenseService = {

  async getRecurringExpenses(userId: string): Promise<RecurringExpense[]> {
    const { data, error } = await supabase
      .from('personal_recurring_expenses')
      .select('*')
      .eq('user_id', userId)
      .order('status', { ascending: true })
      .order('due_day', { ascending: true })
      .order('name', { ascending: true })
    if (error) throw error
    return (data ?? []) as RecurringExpense[]
  },

  async createRecurringExpense(
    userId: string,
    input: {
      name: string
      description: string | null
      category_id: string | null
      default_account_id: string | null
      currency: string
      amount: number
      frequency: RecurringExpense['frequency']
      due_day: number | null
    }
  ): Promise<RecurringExpense> {
    const next_due_date = input.due_day && input.frequency === 'monthly'
      ? calcNextDueDate(input.due_day)
      : null
    const { data, error } = await supabase
      .from('personal_recurring_expenses')
      .insert({ ...input, user_id: userId, next_due_date })
      .select()
      .single()
    if (error) throw error
    return data as RecurringExpense
  },

  async updateRecurringExpense(
    id: string,
    userId: string,
    input: Partial<Pick<RecurringExpense,
      'name' | 'description' | 'category_id' | 'default_account_id' |
      'currency' | 'amount' | 'frequency' | 'due_day' | 'status'>>
  ): Promise<void> {
    const updates: Record<string, unknown> = { ...input }
    if (input.due_day && (input.frequency ?? 'monthly') === 'monthly') {
      updates.next_due_date = calcNextDueDate(input.due_day)
    }
    const { error } = await supabase
      .from('personal_recurring_expenses')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
    if (error) throw error
  },

  async deleteRecurringExpense(id: string, userId: string): Promise<void> {
    const { error } = await supabase
      .from('personal_recurring_expenses')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('user_id', userId)
    if (error) throw error
  },

  async getPaymentsForMonth(
    userId: string,
    year: number,
    month: number
  ): Promise<RecurringExpensePayment[]> {
    const { data, error } = await supabase
      .from('personal_recurring_expense_payments')
      .select('*')
      .eq('user_id', userId)
      .eq('period_year', year)
      .eq('period_month', month)
    if (error) throw error
    return (data ?? []) as RecurringExpensePayment[]
  },

  async getPaymentsForExpense(
    expenseId: string,
    userId: string
  ): Promise<RecurringExpensePayment[]> {
    const { data, error } = await supabase
      .from('personal_recurring_expense_payments')
      .select('*')
      .eq('recurring_expense_id', expenseId)
      .eq('user_id', userId)
      .order('paid_date', { ascending: false })
      .limit(12)
    if (error) throw error
    return (data ?? []) as RecurringExpensePayment[]
  },

  async payRecurringExpense(params: {
    expenseId: string
    accountId: string
    amount: number
    paidDate: string
    notes: string | null
  }): Promise<{ payment_id: string; transaction_id: string; next_due_date: string | null }> {
    const { data, error } = await supabase.rpc('pay_recurring_expense', {
      p_expense_id:  params.expenseId,
      p_account_id:  params.accountId,
      p_amount:      params.amount,
      p_paid_date:   params.paidDate,
      p_notes:       params.notes ?? null,
    })
    if (error) throw error
    const result = data as { ok: boolean; error?: string; payment_id?: string; transaction_id?: string; next_due_date?: string }
    if (!result?.ok) throw new Error(result?.error || 'Error al registrar el pago')
    return {
      payment_id:    result.payment_id!,
      transaction_id: result.transaction_id!,
      next_due_date: result.next_due_date ?? null,
    }
  },

  getSummary(
    expenses: RecurringExpense[],
    payments: RecurringExpensePayment[],
    now = new Date()
  ): RecurringSummary {
    const active = expenses.filter(e => e.status === 'active')
    const monthlyTotalARS = getMonthlyFixedTotal(active, 'ARS')
    const monthlyTotalUSD = getMonthlyFixedTotal(active, 'USD')
    const pendingARS      = getPendingFixedTotal(active, payments, 'ARS', now)
    const pendingUSD      = getPendingFixedTotal(active, payments, 'USD', now)

    const paidCount = active.filter(e =>
      getRecurringStatusForMonth(e, payments, now) === 'paid'
    ).length
    const pendingCount = active.filter(e => {
      const st = getRecurringStatusForMonth(e, payments, now)
      return st === 'pending' || st === 'overdue'
    }).length

    const nextDue = active
      .filter(e => e.next_due_date && getRecurringStatusForMonth(e, payments, now) !== 'paid')
      .sort((a, b) => (a.next_due_date! < b.next_due_date! ? -1 : 1))[0]

    return {
      monthlyTotalARS, monthlyTotalUSD,
      pendingARS, pendingUSD,
      paidCount, pendingCount,
      nextDueDate: nextDue?.next_due_date ?? null,
      nextDueName: nextDue?.name ?? null,
    }
  },
}
