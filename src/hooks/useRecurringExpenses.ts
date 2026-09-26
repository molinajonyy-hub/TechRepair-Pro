import { useState, useEffect, useCallback, useRef } from 'react'
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

export function recurringExpenseError(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error
    ? String(error.message)
    : 'No se pudo completar la operación. Intentá nuevamente.'
}

export function useRecurringExpenses({ includeInactive = false, includePaymentStatus = true } = {}) {
  const { businessId } = useAuth()
  const [expenses, setExpenses] = useState<RecurringExpenseWithStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)
  const invalidateLoad = useCallback(() => { requestId.current++ }, [])

  const load = useCallback(async () => {
    const request = ++requestId.current
    if (!businessId) {
      setExpenses([])
      setError('No hay un negocio seleccionado.')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      let query = supabase
        .from('recurring_expenses')
        .select('*')
        .eq('business_id', businessId)
      if (!includeInactive) query = query.eq('is_active', true)
      const { data: templates, error: tErr } = await query.order('name')

      if (request !== requestId.current) return
      if (tErr) throw tErr

      if (!templates || templates.length === 0) {
        setExpenses([])
        return
      }

      // La gestión de plantillas no necesita consultar movimientos ni pagos.
      if (!includePaymentStatus) {
        setExpenses(templates.map(t => ({ ...t, paid_this_month: false })))
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

      if (request !== requestId.current) return
      setExpenses(
        templates.map(t => ({
          ...t,
          paid_this_month: !!paidMap[t.id],
          paid_amount: paidMap[t.id]?.amount_ars,
          paid_entry_id: paidMap[t.id]?.id,
          paid_date: paidMap[t.id]?.date,
        }))
      )
    } catch (e: unknown) {
      if (request === requestId.current) setError(recurringExpenseError(e))
    } finally {
      if (request === requestId.current) setLoading(false)
    }
  }, [businessId, includeInactive, includePaymentStatus])

  useEffect(() => {
    setExpenses([])
    void load()
    return invalidateLoad
  }, [load, invalidateLoad])

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
    if (!businessId) throw new Error('No hay un negocio seleccionado.')
    const { data: created, error } = await supabase
      .from('recurring_expenses')
      .insert({ ...data, business_id: businessId })
      .select()
      .single()
    if (error) throw error
    if (!created) throw new Error('No se pudo confirmar la creación del gasto recurrente.')
    await load()
    return created
  }

  const update = async (id: string, updates: Partial<Pick<RecurringExpense, 'name' | 'amount' | 'currency' | 'day_of_month' | 'notes' | 'subcategory' | 'is_active'>>) => {
    if (!businessId) throw new Error('No hay un negocio seleccionado.')
    const { data: updated, error } = await supabase
      .from('recurring_expenses')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('business_id', businessId)
      .select()
      .single()
    if (error) throw error
    if (!updated) throw new Error('No se pudo confirmar la actualización del gasto recurrente.')
    await load()
    return updated
  }

  const deactivate = async (id: string) => {
    return update(id, { is_active: false })
  }

  return { expenses, loading, error, load, create, update, deactivate, loadHistory }
}
