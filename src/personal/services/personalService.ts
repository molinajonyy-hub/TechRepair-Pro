import { supabase } from '../../lib/supabase'

// ─── Types ────────────────────────────────────────────────────────────────────

/** Saldo de una cuenta para una moneda específica. */
export interface PersonalAccountBalance {
  id: string
  user_id: string
  account_id: string
  currency: string
  initial_balance: number
  current_balance: number
  created_at: string
  updated_at: string
}

export interface PersonalAccount {
  id: string
  user_id: string
  business_id: string | null
  name: string
  type: 'cash' | 'bank' | 'digital' | 'savings' | 'dollars' | 'other'
  // Moneda primaria (backward compat con RPCs existentes)
  currency: string
  initial_balance: number
  current_balance: number
  is_active: boolean
  created_at: string
  updated_at?: string
  // Saldos multi-moneda (joined de personal_account_balances)
  balances?: PersonalAccountBalance[]
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
  available: number     // ARS (backward compat)
  availableARS: number  // Saldo ARS explícito
  availableUSD: number  // Saldo USD explícito
}

// ─── Account helpers ──────────────────────────────────────────────────────────

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  cash: 'Efectivo', bank: 'Banco', digital: 'Billetera digital',
  savings: 'Ahorro', dollars: 'Dólares', other: 'Otra',
}
export const accountTypeLabel = (t: string) => ACCOUNT_TYPE_LABELS[t] ?? t

/**
 * Obtiene el saldo de una cuenta para una moneda específica.
 * Prioriza personal_account_balances; fallback a personal_accounts.current_balance.
 */
export function getAccountBalanceForCurrency(account: PersonalAccount, currency: string): number {
  if (account.balances && account.balances.length > 0) {
    const entry = account.balances.find(b => b.currency === currency)
    if (entry) return Number(entry.current_balance)
    return 0
  }
  // Fallback: usar campos legacy solo si coincide la moneda primaria
  if (account.currency === currency) return Number(account.current_balance)
  return 0
}

/** Lista de monedas disponibles en una cuenta. */
export function getAccountCurrencies(account: PersonalAccount): string[] {
  if (account.balances && account.balances.length > 0) {
    return account.balances.map(b => b.currency)
  }
  return [account.currency]
}

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
      .select('*, balances:personal_account_balances(*)')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: true })
    if (error) throw error
    return (data ?? []) as PersonalAccount[]
  },

  /**
   * Crea una cuenta con soporte multi-moneda.
   * Crea registro en personal_accounts (moneda primaria) y entradas
   * en personal_account_balances para cada moneda seleccionada.
   */
  async createAccount(
    userId: string,
    input: {
      name: string
      type: PersonalAccount['type']
      currencies: { currency: string; initial_balance: number }[]
    }
  ): Promise<PersonalAccount> {
    if (!input.currencies.length) throw new Error('Seleccioná al menos una moneda')
    const primary = input.currencies[0]

    // Crear cuenta principal (backward compat con RPCs existentes)
    const { data, error } = await supabase
      .from('personal_accounts')
      .insert({
        user_id:         userId,
        name:            input.name,
        type:            input.type,
        currency:        primary.currency,
        initial_balance: primary.initial_balance,
        current_balance: primary.initial_balance,
      })
      .select()
      .single()
    if (error) throw error

    const account = data as PersonalAccount

    // Crear saldos por moneda en personal_account_balances
    const balanceRows = input.currencies.map(c => ({
      user_id:         userId,
      account_id:      account.id,
      currency:        c.currency,
      initial_balance: c.initial_balance,
      current_balance: c.initial_balance,
    }))
    const { error: balErr } = await supabase
      .from('personal_account_balances')
      .insert(balanceRows)
    if (balErr) {
      // Rollback account si falla crear balances
      await supabase.from('personal_accounts').delete().eq('id', account.id)
      throw balErr
    }

    return account
  },

  /** Agregar una moneda adicional a una cuenta existente. */
  async addCurrencyToAccount(
    accountId: string,
    userId: string,
    currency: string,
    initialBalance: number
  ): Promise<void> {
    const { error } = await supabase
      .from('personal_account_balances')
      .insert({ account_id: accountId, user_id: userId, currency, initial_balance: initialBalance, current_balance: initialBalance })
    if (error) throw error
  },

  async updateAccount(id: string, userId: string, updates: Pick<PersonalAccount, 'name' | 'type'>): Promise<void> {
    const { error } = await supabase
      .from('personal_accounts')
      .update({ name: updates.name, type: updates.type, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)
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

    const delta = input.type === 'income' ? input.amount : -input.amount

    // Usar la nueva RPC multi-moneda que maneja tanto personal_account_balances
    // como personal_accounts.current_balance (backward compat)
    const { error: balErr } = await supabase.rpc('personal_update_currency_balance', {
      p_account_id: input.account_id,
      p_currency:   input.currency,
      p_delta:      delta,
    })
    if (balErr) {
      await supabase.from('personal_transactions').delete().eq('id', (data as any).id)
      throw balErr
    }

    return data as PersonalTransaction
  },

  async deleteTransaction(id: string, accountId: string, amount: number, type: string, currency = 'ARS'): Promise<void> {
    const { error } = await supabase.from('personal_transactions').delete().eq('id', id)
    if (error) throw error
    const delta = type === 'income' ? -amount : amount
    await supabase.rpc('personal_update_currency_balance', {
      p_account_id: accountId,
      p_currency:   currency,
      p_delta:      delta,
    }).maybeSingle()
  },

  // ── Monthly summary ───────────────────────────────────────────────────────
  async getMonthlySummary(userId: string, month: string): Promise<PersonalSummary> {
    const [txs, accounts] = await Promise.all([
      personalService.getTransactions(userId, { month }),
      personalService.getAccounts(userId),
    ])
    const arsOnly   = txs.filter(t => t.currency === 'ARS')
    const totalIncome  = arsOnly.filter(t => t.type === 'income').reduce((s, t) => s + Number(t.amount), 0)
    const totalExpense = arsOnly.filter(t => t.type === 'expense').reduce((s, t) => s + Number(t.amount), 0)

    // Saldos desde personal_account_balances (fuente de verdad multi-moneda)
    const allBalances = accounts.flatMap(a => a.balances ?? [])
    const availableARS = allBalances
      .filter(b => b.currency === 'ARS')
      .reduce((s, b) => s + Number(b.current_balance), 0)
    const availableUSD = allBalances
      .filter(b => b.currency === 'USD')
      .reduce((s, b) => s + Number(b.current_balance), 0)

    // Fallback: si no hay balances (cuenta legacy sin multi-moneda), usar campo viejo
    const legacyARS = allBalances.length === 0
      ? accounts.reduce((s, a) => s + (a.currency === 'ARS' ? Number(a.current_balance) : 0), 0)
      : 0

    const available = availableARS || legacyARS

    return {
      totalIncome,
      totalExpense,
      balance: totalIncome - totalExpense,
      available,
      availableARS: available,
      availableUSD,
    }
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

  // ── getCurrentExchangeRate placeholder (used by CajaPage) ─────────────────
  async getCurrentExchangeRate(base: string, target: string): Promise<number> {
    const { data } = await supabase
      .from('exchange_rates')
      .select('rate')
      .eq('base_currency', base)
      .eq('target_currency', target)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    return Number(data?.rate) || 1
  },
}
