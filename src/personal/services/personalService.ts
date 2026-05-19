import { supabase } from '../../lib/supabase'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PersonalAccount {
  id: string
  user_id: string
  business_id: string | null
  name: string
  type: 'cash' | 'bank' | 'digital' | 'savings' | 'dollars' | 'other'
  currency: string
  initial_balance: number
  current_balance: number
  is_active: boolean
  created_at: string
}

export interface PersonalCategory {
  id: string
  user_id: string
  name: string
  type: 'income' | 'expense'
  icon: string
  color: string
  is_default: boolean
  is_active: boolean
}

export interface PersonalTransaction {
  id: string
  user_id: string
  account_id: string
  category_id: string | null
  type: 'income' | 'expense' | 'transfer'
  amount: number
  currency: string
  date: string
  description: string
  notes: string | null
  payment_method: string | null
  linked_owner_withdrawal_id: string | null
  created_at: string
  account?: { name: string; type: string; currency: string }
  category?: { name: string; icon: string; color: string }
}

export interface OwnerWithdrawal {
  id: string
  business_id: string
  user_id: string
  amount: number
  currency: string
  date: string
  destination_account_id: string | null
  notes: string | null
  status: 'completed' | 'reversed'
  created_at: string
}

export interface PersonalSummary {
  totalIncome: number
  totalExpense: number
  balance: number
  available: number
}

// ─── Account helpers ──────────────────────────────────────────────────────────

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  cash: 'Efectivo', bank: 'Banco', digital: 'Billetera digital',
  savings: 'Ahorro', dollars: 'Dólares', other: 'Otra',
}
export const accountTypeLabel = (t: string) => ACCOUNT_TYPE_LABELS[t] ?? t

// ─── Service ──────────────────────────────────────────────────────────────────

export const personalService = {

  // ── Ensure default categories (idempotent) ────────────────────────────────
  async ensureDefaultCategories(userId: string): Promise<void> {
    const { count } = await supabase
      .from('personal_categories')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
    if ((count ?? 0) === 0) {
      await supabase.rpc('insert_personal_default_categories', { p_user_id: userId })
    }
  },

  // ── Accounts ─────────────────────────────────────────────────────────────
  async getAccounts(userId: string): Promise<PersonalAccount[]> {
    const { data, error } = await supabase
      .from('personal_accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: true })
    if (error) throw error
    return (data ?? []) as PersonalAccount[]
  },

  async createAccount(
    userId: string,
    input: Pick<PersonalAccount, 'name' | 'type' | 'currency' | 'initial_balance'>
  ): Promise<PersonalAccount> {
    const { data, error } = await supabase
      .from('personal_accounts')
      .insert({ ...input, user_id: userId, current_balance: input.initial_balance })
      .select()
      .single()
    if (error) throw error
    return data as PersonalAccount
  },

  async updateAccount(id: string, userId: string, updates: Pick<PersonalAccount, 'name' | 'type' | 'currency'>): Promise<void> {
    const { error } = await supabase
      .from('personal_accounts')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)   // extra safety — RLS also enforces this
    if (error) throw error
  },

  async deactivateAccount(id: string): Promise<void> {
    const { error } = await supabase
      .from('personal_accounts')
      .update({ is_active: false })
      .eq('id', id)
    if (error) throw error
  },

  // ── Categories ───────────────────────────────────────────────────────────
  async getCategories(userId: string): Promise<PersonalCategory[]> {
    const { data, error } = await supabase
      .from('personal_categories')
      .select('*')
      .eq('user_id', userId)
      .order('type', { ascending: true })
      .order('name', { ascending: true })
    if (error) throw error
    return (data ?? []) as PersonalCategory[]
  },

  async createCategory(
    userId: string,
    input: Pick<PersonalCategory, 'name' | 'type' | 'icon' | 'color'>
  ): Promise<PersonalCategory> {
    const { data, error } = await supabase
      .from('personal_categories')
      .insert({ ...input, user_id: userId })
      .select()
      .single()
    if (error) throw error
    return data as PersonalCategory
  },

  async updateCategory(id: string, updates: Partial<PersonalCategory>): Promise<void> {
    const { error } = await supabase.from('personal_categories').update(updates).eq('id', id)
    if (error) throw error
  },

  // ── Transactions ─────────────────────────────────────────────────────────
  async getTransactions(
    userId: string,
    opts: { limit?: number; offset?: number; month?: string } = {}
  ): Promise<PersonalTransaction[]> {
    let q = supabase
      .from('personal_transactions')
      .select('*, account:personal_accounts(name,type,currency), category:personal_categories(name,icon,color)')
      .eq('user_id', userId)
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })

    if (opts.month) {
      // Use proper date range — no timezone offset needed since dates are stored as date (no time)
      const [y, m] = opts.month.split('-')
      const lastDay = new Date(Number(y), Number(m), 0).getDate()
      q = q.gte('date', `${y}-${m}-01`).lte('date', `${y}-${m}-${String(lastDay).padStart(2, '0')}`)
    }
    if (opts.limit) q = q.limit(opts.limit)

    const { data, error } = await q
    if (error) throw error
    return (data ?? []) as PersonalTransaction[]
  },

  async createTransaction(
    userId: string,
    input: {
      account_id: string
      category_id: string | null
      type: 'income' | 'expense' | 'transfer'
      amount: number
      currency: string
      date: string
      description: string
      notes: string | null
      payment_method: string | null
      linked_owner_withdrawal_id: string | null
    }
  ): Promise<PersonalTransaction> {
    const { data, error } = await supabase
      .from('personal_transactions')
      .insert({ ...input, user_id: userId })
      .select()
      .single()
    if (error) throw error

    // Update account balance via RPC (server-side, validates user ownership)
    const delta = input.type === 'income' ? input.amount : -input.amount
    const { error: balErr } = await supabase.rpc('personal_update_balance', {
      p_account_id: input.account_id,
      p_delta: delta,
    })
    if (balErr) {
      // Rollback the transaction insert since balance update failed
      await supabase.from('personal_transactions').delete().eq('id', (data as any).id)
      throw balErr
    }

    return data as PersonalTransaction
  },

  async deleteTransaction(id: string, accountId: string, amount: number, type: string): Promise<void> {
    const { error } = await supabase.from('personal_transactions').delete().eq('id', id)
    if (error) throw error
    const delta = type === 'income' ? -amount : amount
    await supabase.rpc('personal_update_balance', {
      p_account_id: accountId,
      p_delta: delta,
    }).maybeSingle()
  },

  // ── Monthly summary ───────────────────────────────────────────────────────
  async getMonthlySummary(userId: string, month: string): Promise<PersonalSummary> {
    const [txs, accounts] = await Promise.all([
      personalService.getTransactions(userId, { month }),
      personalService.getAccounts(userId),
    ])
    const totalIncome  = txs.filter(t => t.type === 'income').reduce((s, t) => s + Number(t.amount), 0)
    const totalExpense = txs.filter(t => t.type === 'expense').reduce((s, t) => s + Number(t.amount), 0)
    const available    = accounts.reduce((s, a) => s + (a.currency === 'ARS' ? Number(a.current_balance) : 0), 0)
    return { totalIncome, totalExpense, balance: totalIncome - totalExpense, available }
  },

  // ── Owner withdrawal (ATOMIC via RPC) ─────────────────────────────────────
  async registerOwnerWithdrawal(params: {
    businessId: string
    amount: number
    date: string
    destinationAccountId: string
    notes: string
  }): Promise<{ withdrawal_id: string; personal_tx_id: string; business_fm_id: string }> {
    const { data, error } = await supabase.rpc('create_owner_withdrawal', {
      p_business_id:  params.businessId,
      p_amount:       params.amount,
      p_date:         params.date,
      p_account_id:   params.destinationAccountId,
      p_notes:        params.notes || null,
    })
    if (error) throw error
    const result = data as { ok: boolean; error?: string; withdrawal_id?: string; personal_tx_id?: string; business_fm_id?: string }
    if (!result?.ok) throw new Error(result?.error || 'Error al registrar el retiro')
    return {
      withdrawal_id:  result.withdrawal_id!,
      personal_tx_id: result.personal_tx_id!,
      business_fm_id: result.business_fm_id!,
    }
  },

  async getWithdrawals(userId: string, limit = 10): Promise<OwnerWithdrawal[]> {
    const { data, error } = await supabase
      .from('owner_withdrawals')
      .select('*')
      .eq('user_id', userId)
      .order('date', { ascending: false })
      .limit(limit)
    if (error) throw error
    return (data ?? []) as OwnerWithdrawal[]
  },
}
