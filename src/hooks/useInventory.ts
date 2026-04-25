import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

// Normaliza cualquier error (Supabase PostgrestError, Error nativo, string, objeto)
// a una instancia de Error que además conserva los metadatos relevantes
// (code, details, hint) como propiedades. Esto es crítico para que el código
// consumidor pueda detectar violaciones de unique constraint (Postgres 23505)
// y hacer retry automático.
function toError(err: unknown): Error {
  if (err instanceof Error) {
    return err
  }
  if (err && typeof err === 'object') {
    const anyErr = err as Record<string, unknown>
    const message = typeof anyErr.message === 'string' && anyErr.message
      ? anyErr.message
      : 'Error desconocido'
    const wrapped = new Error(message)
    if (typeof anyErr.code !== 'undefined') (wrapped as any).code = anyErr.code
    if (typeof anyErr.details !== 'undefined') (wrapped as any).details = anyErr.details
    if (typeof anyErr.hint !== 'undefined') (wrapped as any).hint = anyErr.hint
    return wrapped
  }
  if (typeof err === 'string' && err) {
    return new Error(err)
  }
  return new Error('Error desconocido')
}

export interface InventoryItem {
  id: string
  code: string
  name: string
  description?: string
  category: string
  subcategory?: string
  stock_quantity: number
  reserved_quantity: number
  min_stock: number
  max_stock?: number
  cost_price: number
  sale_price: number
  supplier_id?: string
  supplier_code?: string
  location?: string
  is_active: boolean
  business_id?: string
  created_by?: string
  created_at: string
  updated_at: string
  cost_price_usd?: number
  base_currency?: string
  base_price?: number
  exchange_rate_used?: number
  auto_update_price?: boolean
}

export function useInventory() {
  const { businessId, user } = useAuth()
  const [items, setItems] = useState<InventoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void loadInventory()
  }, [businessId])

  async function loadInventory(options?: { background?: boolean }) {
    const background = options?.background === true
    try {
      if (!background) setLoading(true)
      setError(null)

      let query = supabase
        .from('inventory')
        .select('*')
        .eq('is_active', true)
        .order('name', { ascending: true })
        .limit(5000)

      if (businessId) {
        query = query.eq('business_id', businessId)
      }

      const { data, error: fetchError } = await query

      if (fetchError) throw fetchError
      setItems(data || [])
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al cargar inventario')
    } finally {
      if (!background) setLoading(false)
    }
  }

  async function addItem(
    item: Omit<InventoryItem, 'id' | 'created_at' | 'updated_at'>,
    options?: { skipReload?: boolean }
  ) {
    try {
      const { data, error: insertError } = await supabase
        .from('inventory')
        .insert({
          ...item,
          business_id: businessId,
          created_by: user?.id,
        })
        .select()
        .single()

      if (insertError) throw insertError
      if (!options?.skipReload) {
        await loadInventory({ background: true })
      }
      return data
    } catch (err: unknown) {
      throw toError(err)
    }
  }

  async function updateItem(
    id: string,
    updates: Partial<InventoryItem>,
    options?: { skipReload?: boolean }
  ) {
    try {
      let updateQuery = supabase
        .from('inventory')
        .update(updates)
        .eq('id', id)

      if (businessId) {
        updateQuery = updateQuery.eq('business_id', businessId)
      }

      const { error: updateError } = await updateQuery
      if (updateError) throw updateError
      if (!options?.skipReload) {
        await loadInventory({ background: true })
      }
    } catch (err: unknown) {
      throw toError(err)
    }
  }

  async function deleteItem(id: string) {
    try {
      let deleteQuery = supabase
        .from('inventory')
        .update({ is_active: false })
        .eq('id', id)

      if (businessId) {
        deleteQuery = deleteQuery.eq('business_id', businessId)
      }

      const { error: deleteError } = await deleteQuery
      if (deleteError) throw deleteError
      await loadInventory()
    } catch (err: unknown) {
      throw toError(err)
    }
  }

  async function adjustStock(id: string, newQuantity: number, _reason?: string) {
    try {
      let adjustQuery = supabase
        .from('inventory')
        .update({ stock_quantity: newQuantity })
        .eq('id', id)

      if (businessId) {
        adjustQuery = adjustQuery.eq('business_id', businessId)
      }

      const { error: updateError } = await adjustQuery
      if (updateError) throw updateError
      await loadInventory()
    } catch (err: unknown) {
      throw toError(err)
    }
  }

  const categories = [...new Set(items.map((item) => item.category))].filter(Boolean).sort()
  const lowStockItems = items.filter((item) => item.stock_quantity > 0 && item.stock_quantity <= item.min_stock)
  const outOfStockItems = items.filter((item) => item.stock_quantity === 0)

  return {
    items,
    categories,
    lowStockItems,
    outOfStockItems,
    loading,
    error,
    refresh: loadInventory,
    addItem,
    updateItem,
    deleteItem,
    adjustStock,
  }
}
