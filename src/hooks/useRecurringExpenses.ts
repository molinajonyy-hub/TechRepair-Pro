import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

export interface RecurringExpense {
  id: string
  business_id: string
  name: string
  type: string
  category: string
  subcategory?: string
  amount: number
  currency: 'ARS' | 'USD'
  day_of_month: number
  is_active: boolean
  notes?: string
  created_at: string
  updated_at: string
}

export interface RecurringExpenseWithStatus extends RecurringExpense {
  // Entrada pagada este mes (si existe)
  paid_this_month: boolean
  paid_amount?: number
  paid_entry_id?: string
  paid_date?: string
  // Historial de pagos
  history?: { id: string; date: string; amount: number; amount_ars: number; currency: string }[]
}

export type NewRecurringExpense = Omit<RecurringExpense, 'id' | 'created_at' | 'updated_at'>

export function useRecurringExpenses() {
  const { businessId } = useAuth()
  const [expenses, setExpenses] = useState<RecurringExpenseWithStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!businessId) return
    setLoading(true)
    setError(null)
    try {
      // Cargar plantillas activas
      const { data: templates, error: tErr } = await supabase
        .from('recurring_expenses')
        .select('*')
        .eq('business_id', businessId)
        .eq('is_active', true)
        .order('name')

      if (tErr) throw tErr

      if (!templates || templates.length === 0) {
        setExpenses([])
        return
      }

      // Mes actual
      const now = new Date()
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)
      const monthEnd = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}-01`

      const ids = templates.map(t => t.id)

      // Entradas de este mes vinculadas a estas plantillas
      const { data: thisMonthEntries } = await supabase
        .from('business_finance_entries')
        .select('id, recurring_expense_id, date, amount, amount_ars, currency')
        .in('recurring_expense_id', ids)
        .gte('date', monthStart)
        .lt('date', monthEnd)

      const paidMap: Record<string, { id: string; amount: number; amount_ars: number; date: string }> = {}
      for (const e of thisMonthEntries || []) {
        if (e.recurring_expense_id) {
          paidMap[e.recurring_expense_id] = {
            id: e.id,
            amount: e.amount,
            amount_ars: e.amount_ars,
            date: e.date,
          }
        }
      }

      setExpenses(
        templates.map(t => ({
          ...t,
          paid_this_month: !!paidMap[t.id],
          paid_amount: paidMap[t.id]?.amount_ars,
          paid_entry_id: paidMap[t.id]?.id,
          paid_date: paidMap[t.id]?.date,
        }))
      )
    } catch (e: any) {
      setError(e.message || 'Error al cargar gastos recurrentes')
    } finally {
      setLoading(false)
    }
  }, [businessId])

  useEffect(() => { load() }, [load])

  const loadHistory = async (expenseId: string) => {
    const { data } = await supabase
      .from('business_finance_entries')
      .select('id, date, amount, amount_ars, currency, notes')
      .eq('recurring_expense_id', expenseId)
      .order('date', { ascending: false })
      .limit(24)
    return data || []
  }

  const create = async (data: NewRecurringExpense) => {
    if (!businessId) return null
    const { data: created, error } = await supabase
      .from('recurring_expenses')
      .insert({ ...data, business_id: businessId })
      .select()
      .single()
    if (error) throw error
    await load()
    return created
  }

  const update = async (id: string, updates: Partial<Pick<RecurringExpense, 'name' | 'amount' | 'currency' | 'day_of_month' | 'notes' | 'subcategory'>>) => {
    const { error } = await supabase
      .from('recurring_expenses')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) throw error
    await load()
  }

  const deactivate = async (id: string) => {
    const { error } = await supabase
      .from('recurring_expenses')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) throw error
    await load()
  }

  return { expenses, loading, error, load, create, update, deactivate, loadHistory }
}
