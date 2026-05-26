import { supabase } from '../../lib/supabase'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PersonalBudget {
  id: string
  user_id: string
  category_id: string
  amount: number
  currency: string
  period: string   // 'YYYY-MM'
  status: 'active' | 'inactive'
  notes: string | null
  created_at: string
  updated_at: string
  // joined
  category?: { name: string; icon: string; color: string } | null
}

/** Lightweight expense entry used for budget calculations. */
export interface BudgetExpense {
  category_id: string | null
  amount: number
  currency: string
}

export type BudgetStatus = 'healthy' | 'warning' | 'exceeded'

export interface BudgetUsage {
  budget: PersonalBudget
  spent: number
  remaining: number
  percentUsed: number
  status: BudgetStatus
}

export interface BudgetSummary {
  totalBudgeted: number
  totalSpent: number
  totalRemaining: number
  percentUsed: number
  exceedCount: number
  warningCount: number
  topAlert: BudgetUsage | null   // highest-priority item to surface
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

export function calculateBudgetUsage(
  budgets: PersonalBudget[],
  expenses: BudgetExpense[]
): BudgetUsage[] {
  return budgets.map(budget => {
    const spent = expenses
      .filter(e => e.category_id === budget.category_id && e.currency === budget.currency)
      .reduce((s, e) => s + Number(e.amount), 0)
    const budgetAmount = Number(budget.amount)
    const remaining   = Math.max(0, budgetAmount - spent)
    const percentUsed = budgetAmount > 0 ? (spent / budgetAmount) * 100 : 0
    const status: BudgetStatus = percentUsed >= 100 ? 'exceeded'
      : percentUsed >= 70 ? 'warning'
      : 'healthy'
    return { budget, spent, remaining, percentUsed, status }
  })
}

export function getBudgetSummaryFromUsages(usages: BudgetUsage[]): BudgetSummary {
  const active = usages.filter(u => u.budget.status === 'active')
  const totalBudgeted  = active.reduce((s, u) => s + Number(u.budget.amount), 0)
  const totalSpent     = active.reduce((s, u) => s + u.spent, 0)
  const totalRemaining = Math.max(0, totalBudgeted - totalSpent)
  const percentUsed    = totalBudgeted > 0 ? (totalSpent / totalBudgeted) * 100 : 0
  const exceedCount    = active.filter(u => u.status === 'exceeded').length
  const warningCount   = active.filter(u => u.status === 'warning').length

  // Top alert: exceeded first, then warning, sorted by percent desc
  const alerts = active
    .filter(u => u.status !== 'healthy')
    .sort((a, b) => {
      if (a.status === 'exceeded' && b.status !== 'exceeded') return -1
      if (a.status !== 'exceeded' && b.status === 'exceeded') return 1
      return b.percentUsed - a.percentUsed
    })

  return {
    totalBudgeted,
    totalSpent,
    totalRemaining,
    percentUsed,
    exceedCount,
    warningCount,
    topAlert: alerts[0] ?? null,
  }
}

export function budgetStatusColor(status: BudgetStatus): string {
  return status === 'exceeded' ? '#f87171' : status === 'warning' ? '#fbbf24' : '#34d399'
}

export function budgetStatusLabel(status: BudgetStatus): string {
  return status === 'exceeded' ? 'Excedido' : status === 'warning' ? 'Cerca del límite' : 'OK'
}

// ── Service ───────────────────────────────────────────────────────────────────

export const budgetService = {

  async getBudgets(userId: string, period: string): Promise<PersonalBudget[]> {
    const { data, error } = await supabase
      .from('personal_budgets')
      .select('*, category:personal_categories(name, icon, color)')
      .eq('user_id', userId)
      .eq('period', period)
      .order('created_at', { ascending: true })
    if (error) throw error
    return (data ?? []) as PersonalBudget[]
  },

  async createBudget(
    userId: string,
    input: {
      category_id: string
      amount: number
      currency: string
      period: string
      notes?: string | null
    }
  ): Promise<PersonalBudget> {
    const { data, error } = await supabase
      .from('personal_budgets')
      .insert({
        user_id:     userId,
        category_id: input.category_id,
        amount:      input.amount,
        currency:    input.currency,
        period:      input.period,
        status:      'active',
        notes:       input.notes ?? null,
      })
      .select('*, category:personal_categories(name, icon, color)')
      .single()
    if (error) throw error
    return data as PersonalBudget
  },

  async updateBudget(
    id: string,
    userId: string,
    input: Partial<Pick<PersonalBudget, 'amount' | 'currency' | 'notes' | 'status'>>
  ): Promise<void> {
    const { error } = await supabase
      .from('personal_budgets')
      .update({ ...input, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)
    if (error) throw error
  },

  async deleteBudget(id: string, userId: string): Promise<void> {
    const { error } = await supabase
      .from('personal_budgets')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)
    if (error) throw error
  },

  /** Lightweight expense fetch for budget calculations — only what's needed. */
  async getExpensesForPeriod(userId: string, period: string): Promise<BudgetExpense[]> {
    const { data, error } = await supabase
      .from('personal_transactions')
      .select('category_id, amount, currency')
      .eq('user_id', userId)
      .eq('type', 'expense')
      .like('date', `${period}%`)
    if (error) throw error
    return (data ?? []) as BudgetExpense[]
  },
}
