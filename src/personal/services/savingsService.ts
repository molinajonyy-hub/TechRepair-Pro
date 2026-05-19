import { supabase } from '../../lib/supabase'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SavingsGoal {
  id: string
  user_id: string
  account_id: string | null
  name: string
  target_amount: number
  current_amount: number
  currency: string
  target_date: string | null   // 'YYYY-MM-DD'
  status: 'active' | 'completed' | 'paused' | 'cancelled'
  created_at: string
  updated_at: string
  // joined
  account?: { name: string; type: string; currency: string } | null
}

// ─── Service ──────────────────────────────────────────────────────────────────

export const savingsService = {

  // ── Goals ─────────────────────────────────────────────────────────────────
  async getSavingsGoals(userId: string): Promise<SavingsGoal[]> {
    const { data, error } = await supabase
      .from('personal_savings_goals')
      .select('*, account:personal_accounts(name,type,currency)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return (data ?? []) as SavingsGoal[]
  },

  async createSavingsGoal(
    userId: string,
    input: {
      name: string
      target_amount: number
      current_amount: number
      currency: string
      target_date: string | null
      account_id: string | null
    }
  ): Promise<SavingsGoal> {
    const { data, error } = await supabase
      .from('personal_savings_goals')
      .insert({ ...input, user_id: userId, status: 'active' })
      .select('*, account:personal_accounts(name,type,currency)')
      .single()
    if (error) throw error
    return data as SavingsGoal
  },

  async updateSavingsGoal(
    id: string,
    userId: string,
    updates: Partial<Pick<SavingsGoal, 'name' | 'target_amount' | 'currency' | 'target_date' | 'account_id' | 'status'>>
  ): Promise<void> {
    const { error } = await supabase
      .from('personal_savings_goals')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)
    if (error) throw error
  },

  async pauseSavingsGoal(id: string, userId: string): Promise<void> {
    await savingsService.updateSavingsGoal(id, userId, { status: 'paused' })
  },

  async resumeSavingsGoal(id: string, userId: string): Promise<void> {
    await savingsService.updateSavingsGoal(id, userId, { status: 'active' })
  },

  async completeSavingsGoal(id: string, userId: string): Promise<void> {
    await savingsService.updateSavingsGoal(id, userId, { status: 'completed' })
  },

  async cancelSavingsGoal(id: string, userId: string): Promise<void> {
    await savingsService.updateSavingsGoal(id, userId, { status: 'cancelled' })
  },

  async deleteSavingsGoal(id: string, userId: string): Promise<void> {
    const { error } = await supabase
      .from('personal_savings_goals')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)
    if (error) throw error
  },

  // ── Atomic operations via RPC ──────────────────────────────────────────────
  // The RPC validates auth, ownership, balance constraints, updates goal
  // current_amount AND creates a personal_transaction in a single DB transaction.
  async goalOperation(params: {
    goalId: string
    accountId: string
    amount: number
    operation: 'contribute' | 'withdraw'
    date: string
    notes: string | null
  }): Promise<{ newAmount: number; txId: string }> {
    const { data, error } = await supabase.rpc('personal_savings_goal_operation', {
      p_goal_id:    params.goalId,
      p_account_id: params.accountId,
      p_amount:     params.amount,
      p_operation:  params.operation,
      p_date:       params.date,
      p_notes:      params.notes,
    })
    if (error) throw error
    const result = data as { ok: boolean; error?: string; new_amount?: number; tx_id?: string }
    if (!result?.ok) throw new Error(result?.error || 'Error en la operación')
    return {
      newAmount: result.new_amount!,
      txId:      result.tx_id!,
    }
  },

  async contributeToGoal(params: {
    goalId: string; accountId: string; amount: number; date: string; notes: string | null
  }) {
    return savingsService.goalOperation({ ...params, operation: 'contribute' })
  },

  async withdrawFromGoal(params: {
    goalId: string; accountId: string; amount: number; date: string; notes: string | null
  }) {
    return savingsService.goalOperation({ ...params, operation: 'withdraw' })
  },
}
