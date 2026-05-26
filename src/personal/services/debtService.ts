import { supabase } from '../../lib/supabase'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PersonalDebt {
  id: string
  user_id: string
  type: 'debt' | 'receivable'   // debt = I owe, receivable = owed to me
  name: string
  lender_name: string | null
  description: string | null
  currency: string
  initial_amount: number
  current_balance: number
  installment_amount: number | null
  due_day: number | null
  next_due_date: string | null
  start_date: string
  status: 'active' | 'paid' | 'paused' | 'cancelled'
  created_at: string
  updated_at: string
}

export interface PersonalDebtPayment {
  id: string
  user_id: string
  debt_id: string
  account_id: string | null
  currency: string
  amount: number
  payment_date: string
  notes: string | null
  transaction_id: string | null
  created_at: string
}

export interface DebtSummary {
  activeCount: number
  totalOwed: number          // what I owe (type='debt'), in ARS
  totalOwedUSD: number
  totalReceivable: number    // what others owe me (type='receivable'), in ARS
  totalReceivableUSD: number
  nextDueDate: string | null
  nextDueName: string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns the next calendar date for a given due_day (1–31). */
export function calcNextDueDate(dueDay: number): string {
  const today = new Date()
  const year  = today.getFullYear()
  const month = today.getMonth()
  const day   = Math.min(dueDay, new Date(year, month + 1, 0).getDate())
  const candidate = new Date(year, month, day)
  if (candidate < today) {
    const nextMonth = month + 1
    const nextYear  = nextMonth > 11 ? year + 1 : year
    const nm        = nextMonth % 12
    const maxDay    = new Date(nextYear, nm + 1, 0).getDate()
    return `${nextYear}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(dueDay, maxDay)).padStart(2, '0')}`
  }
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function isOverdue(debt: PersonalDebt): boolean {
  if (debt.status !== 'active' || !debt.next_due_date) return false
  return debt.next_due_date < new Date().toISOString().split('T')[0]
}

export function getDebtPaidPercent(debt: PersonalDebt): number {
  if (debt.initial_amount <= 0) return 0
  const paid = Number(debt.initial_amount) - Number(debt.current_balance)
  return Math.min(100, Math.max(0, (paid / Number(debt.initial_amount)) * 100))
}

export function debtStatusLabel(debt: PersonalDebt): string {
  if (debt.status === 'active' && isOverdue(debt)) return 'Vencida'
  return { active: 'Activa', paid: 'Pagada', paused: 'Pausada', cancelled: 'Cancelada' }[debt.status] ?? debt.status
}

export function debtStatusColor(debt: PersonalDebt): string {
  if (debt.status === 'active' && isOverdue(debt)) return '#f87171'
  return {
    active:    '#34d399',
    paid:      '#818cf8',
    paused:    '#fbbf24',
    cancelled: '#475569',
  }[debt.status] ?? '#475569'
}

// ── Service ───────────────────────────────────────────────────────────────────

export const debtService = {

  // ── CRUD ────────────────────────────────────────────────────────────────────

  async getDebts(userId: string): Promise<PersonalDebt[]> {
    const { data, error } = await supabase
      .from('personal_debts')
      .select('*')
      .eq('user_id', userId)
      .order('status',        { ascending: true })
      .order('next_due_date', { ascending: true, nullsFirst: false })
      .order('created_at',    { ascending: false })
    if (error) throw error
    return (data ?? []) as PersonalDebt[]
  },

  async createDebt(
    userId: string,
    input: {
      type: 'debt' | 'receivable'
      name: string
      lender_name: string | null
      description: string | null
      currency: string
      initial_amount: number
      installment_amount: number | null
      due_day: number | null
      start_date?: string
    }
  ): Promise<PersonalDebt> {
    const next_due_date = input.due_day ? calcNextDueDate(input.due_day) : null
    const { data, error } = await supabase
      .from('personal_debts')
      .insert({
        user_id:            userId,
        type:               input.type,
        name:               input.name,
        lender_name:        input.lender_name,
        description:        input.description,
        currency:           input.currency,
        initial_amount:     input.initial_amount,
        current_balance:    input.initial_amount,
        installment_amount: input.installment_amount,
        due_day:            input.due_day,
        next_due_date,
        start_date:         input.start_date ?? new Date().toISOString().split('T')[0],
      })
      .select()
      .single()
    if (error) throw error
    return data as PersonalDebt
  },

  async updateDebt(
    id: string,
    userId: string,
    input: Pick<PersonalDebt, 'name' | 'lender_name' | 'description' | 'installment_amount' | 'due_day' | 'status'>
  ): Promise<void> {
    const next_due_date = input.due_day ? calcNextDueDate(input.due_day) : null
    const { error } = await supabase
      .from('personal_debts')
      .update({ ...input, next_due_date, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)
    if (error) throw error
  },

  async deleteDebt(id: string, userId: string): Promise<void> {
    const { error } = await supabase
      .from('personal_debts')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)
    if (error) throw error
  },

  // ── Payments ────────────────────────────────────────────────────────────────

  async getPayments(debtId: string, userId: string): Promise<PersonalDebtPayment[]> {
    const { data, error } = await supabase
      .from('personal_debt_payments')
      .select('*')
      .eq('debt_id',  debtId)
      .eq('user_id', userId)
      .order('payment_date', { ascending: false })
    if (error) throw error
    return (data ?? []) as PersonalDebtPayment[]
  },

  async payDebt(params: {
    debtId: string
    accountId: string
    amount: number
    date: string
    notes: string | null
  }): Promise<{ payment_id: string; transaction_id: string; new_balance: number; paid_off: boolean }> {
    const { data, error } = await supabase.rpc('pay_personal_debt', {
      p_debt_id:    params.debtId,
      p_account_id: params.accountId,
      p_amount:     params.amount,
      p_date:       params.date,
      p_notes:      params.notes ?? null,
    })
    if (error) throw error
    const result = data as { ok: boolean; error?: string; payment_id?: string; transaction_id?: string; new_balance?: number; paid_off?: boolean }
    if (!result?.ok) throw new Error(result?.error || 'Error al registrar el pago')
    return {
      payment_id:     result.payment_id!,
      transaction_id: result.transaction_id!,
      new_balance:    result.new_balance!,
      paid_off:       result.paid_off ?? false,
    }
  },

  // ── Summary ─────────────────────────────────────────────────────────────────

  getDebtSummary(debts: PersonalDebt[]): DebtSummary {
    const active = debts.filter(d => d.status === 'active')

    const totalOwed         = active.filter(d => d.type === 'debt'       && d.currency === 'ARS').reduce((s, d) => s + Number(d.current_balance), 0)
    const totalOwedUSD      = active.filter(d => d.type === 'debt'       && d.currency === 'USD').reduce((s, d) => s + Number(d.current_balance), 0)
    const totalReceivable    = active.filter(d => d.type === 'receivable' && d.currency === 'ARS').reduce((s, d) => s + Number(d.current_balance), 0)
    const totalReceivableUSD = active.filter(d => d.type === 'receivable' && d.currency === 'USD').reduce((s, d) => s + Number(d.current_balance), 0)

    const withDue = active
      .filter(d => d.next_due_date)
      .sort((a, b) => (a.next_due_date! < b.next_due_date! ? -1 : 1))

    return {
      activeCount:       active.length,
      totalOwed,
      totalOwedUSD,
      totalReceivable,
      totalReceivableUSD,
      nextDueDate: withDue[0]?.next_due_date ?? null,
      nextDueName: withDue[0]?.name          ?? null,
    }
  },
}
