import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

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

  async function loadInventory() {
    try {
      setLoading(true)
      setError(null)

      let query = supabase
        .from('inventory')
        .select('*')
        .eq('is_active', true)
        .order('name', { ascending: true })

      if (businessId) {
        query = query.eq('business_id', businessId)
      }

      const { data, error: fetchError } = await query

      if (fetchError) throw fetchError
      setItems(data || [])
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al cargar inventario')
    } finally {
      setLoading(false)
    }
  }

  async function addItem(item: Omit<InventoryItem, 'id' | 'created_at' | 'updated_at'>) {
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
      await loadInventory()
      return data
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error('Error desconocido')
    }
  }

  async function updateItem(id: string, updates: Partial<InventoryItem>) {
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
      await loadInventory()
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error('Error desconocido')
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
      throw err instanceof Error ? err : new Error('Error desconocido')
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
      throw err instanceof Error ? err : new Error('Error desconocido')
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
