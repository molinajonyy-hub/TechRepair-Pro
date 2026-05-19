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
  account?: PersonalAccount
  category?: PersonalCategory
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

  // ── Ensure default categories exist ──────────────────────────────────────
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

  async updateAccount(id: string, updates: Partial<PersonalAccount>): Promise<void> {
    const { error } = await supabase.from('personal_accounts').update(updates).eq('id', id)
    if (error) throw error
  },

  async deleteAccount(id: string): Promise<void> {
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
      const [y, m] = opts.month.split('-')
      const from = `${y}-${m}-01`
      const to = new Date(Number(y), Number(m), 0).toISOString().split('T')[0]
      q = q.gte('date', from).lte('date', to)
    }
    if (opts.limit) q = q.limit(opts.limit)
    if (opts.offset) q = q.range(opts.offset, opts.offset + (opts.limit ?? 20) - 1)

    const { data, error } = await q
    if (error) throw error
    return (data ?? []) as PersonalTransaction[]
  },

  async createTransaction(
    userId: string,
    input: Omit<PersonalTransaction, 'id' | 'user_id' | 'created_at' | 'account' | 'category'>
  ): Promise<PersonalTransaction> {
    const { data, error } = await supabase
      .from('personal_transactions')
      .insert({ ...input, user_id: userId })
      .select()
      .single()
    if (error) throw error

    // Update account balance
    const mult = input.type === 'income' ? 1 : -1
    await supabase.rpc('personal_update_balance', {
      p_account_id: input.account_id,
      p_delta: mult * Number(input.amount),
    }).maybeSingle()

    return data as PersonalTransaction
  },

  async deleteTransaction(id: string, accountId: string, amount: number, type: string): Promise<void> {
    const { error } = await supabase.from('personal_transactions').delete().eq('id', id)
    if (error) throw error
    const mult = type === 'income' ? -1 : 1
    await supabase.rpc('personal_update_balance', {
      p_account_id: accountId,
      p_delta: mult * amount,
    }).maybeSingle()
  },

  // ── Summary ───────────────────────────────────────────────────────────────
  async getMonthlySummary(userId: string, month: string): Promise<PersonalSummary> {
    const txs = await personalService.getTransactions(userId, { month })
    const totalIncome = txs.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0)
    const totalExpense = txs.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0)
    const accounts = await personalService.getAccounts(userId)
    const available = accounts.reduce((s, a) => s + (a.currency === 'ARS' ? a.current_balance : 0), 0)
    return { totalIncome, totalExpense, balance: totalIncome - totalExpense, available }
  },

  // ── Owner withdrawal ──────────────────────────────────────────────────────
  async registerOwnerWithdrawal(params: {
    businessId: string
    userId: string
    amount: number
    date: string
    destinationAccountId: string
    notes: string
    businessFinanceTypeKey: string
  }): Promise<OwnerWithdrawal> {
    // 1. Create the personal transaction
    let personalTxId: string | null = null
    if (params.destinationAccountId) {
      const { data: txData, error: txErr } = await supabase
        .from('personal_transactions')
        .insert({
          user_id: params.userId,
          account_id: params.destinationAccountId,
          type: 'income',
          amount: params.amount,
          currency: 'ARS',
          date: params.date,
          description: 'Retiro del negocio',
          notes: params.notes || null,
          category_id: null,
        })
        .select()
        .single()
      if (txErr) throw txErr
      personalTxId = txData.id

      // Update account balance
      await supabase.rpc('personal_update_balance', {
        p_account_id: params.destinationAccountId,
        p_delta: params.amount,
      }).maybeSingle()
    }

    // 2. Create the owner_withdrawal record
    const { data, error } = await supabase
      .from('owner_withdrawals')
      .insert({
        business_id: params.businessId,
        user_id: params.userId,
        amount: params.amount,
        currency: 'ARS',
        date: params.date,
        destination_account_id: params.destinationAccountId || null,
        personal_transaction_id: personalTxId,
        notes: params.notes || null,
        status: 'completed',
      })
      .select()
      .single()
    if (error) throw error

    // 3. Register the business expense via financial_movements
    try {
      await supabase.from('financial_movements').insert({
        business_id: params.businessId,
        user_id: params.userId,
        type: 'egreso',
        amount: params.amount,
        currency: 'ARS',
        finance_type: params.businessFinanceTypeKey || 'salaries',
        description: `Retiro propietario${params.notes ? ': ' + params.notes : ''}`,
        source: 'owner_withdrawal',
        reference_id: data.id,
        date: params.date,
      })
    } catch {
      // non-critical — withdrawal already recorded
    }

    return data as OwnerWithdrawal
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
