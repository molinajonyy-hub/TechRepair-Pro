import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { useRefreshOnWakeUp } from './useAppWakeUp'
import { INVENTORY_OPERATIONAL_COLUMNS } from '../services/inventoryCostAccess'
import {
  assertNoStockFields,
  inventoryStockAdjustmentService,
  type StockAdjustmentItemResult,
} from '../services/inventoryStockAdjustmentService'

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
  /** SEC-08B: puede faltar. Ausente = RESTRINGIDO o sin cargar, nunca 0. */
  cost_price?: number | null
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

/**
 * G2-C.3A2 — metadata de un producto. NUNCA lleva stock: el INSERT crea el
 * producto en 0 (default de la columna) y el stock inicial / ajuste pasa por la
 * autoridad canónica (`inventoryStockAdjustmentService`).
 */
export type InventoryMetadataInput = Omit<InventoryItem, 'id' | 'created_at' | 'updated_at' | 'stock_quantity'>
export type InventoryMetadataUpdate = Partial<Omit<InventoryItem, 'stock_quantity'>>

export function useInventory() {
  const { businessId, user } = useAuth()
  const [items, setItems] = useState<InventoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void loadInventory()
  }, [businessId])

  useRefreshOnWakeUp(() => { void loadInventory({ background: true }) })

  async function loadInventory(options?: { background?: boolean }) {
    const background = options?.background === true
    if (!businessId) { if (!background) setLoading(false); return }
    try {
      if (!background) setLoading(true)
      setError(null)

      const { data, error: fetchError } = await supabase
        .from('inventory')
        .select(INVENTORY_OPERATIONAL_COLUMNS)
        .eq('business_id', businessId)
        .eq('is_active', true)
        .order('name', { ascending: true })
        .limit(5000)

      if (fetchError) throw fetchError
      setItems(data || [])
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al cargar inventario')
    } finally {
      if (!background) setLoading(false)
    }
  }

  async function addItem(
    item: InventoryMetadataInput,
    options?: { skipReload?: boolean }
  ) {
    try {
      // Fail-closed: un alta no puede fijar saldo. Nace en 0 (default de la
      // columna); el stock inicial lo aplica la RPC canónica después.
      assertNoStockFields(item, 'addItem')
      const { data, error: insertError } = await supabase
        .from('inventory')
        .insert({
          ...item,
          business_id: businessId,
          created_by: user?.id,
        })
        .select(INVENTORY_OPERATIONAL_COLUMNS)
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
    updates: InventoryMetadataUpdate,
    options?: { skipReload?: boolean }
  ) {
    try {
      // Fail-closed: la edición de datos no mueve stock. Un caller que mande
      // stock/stock_quantity recibe un error explícito, no un descarte silencioso.
      assertNoStockFields(updates, 'updateItem')
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

  /**
   * Ajuste manual por la autoridad canónica: target = nuevo stock, expected =
   * stock que vio el usuario. Si cambió entretanto la fila vuelve `stale` y NO
   * se aplica (sin recalcular ni pisar). La clave la da el flujo de UI: una por
   * intención, reusada en el retry.
   */
  async function adjustStock(
    id: string,
    target: number,
    expected: number,
    options: { idempotencyKey: string; reason?: string }
  ): Promise<StockAdjustmentItemResult> {
    try {
      if (!businessId) throw new Error('Negocio no identificado.')
      const result = await inventoryStockAdjustmentService.applyManualTarget({
        businessId,
        inventoryId: id,
        target,
        expected,
        idempotencyKey: options.idempotencyKey,
        reason: options.reason ?? null,
      })
      await loadInventory({ background: true })
      return result
    } catch (err: unknown) {
      throw toError(err)
    }
  }

  const categories = [...new Set(items.map((item) => item.category))].filter(Boolean).sort()
  const lowStockItems = items.filter((item) => item.stock_quantity > 0 && item.stock_quantity <= item.min_stock)
  // Stock negativo (sobreventa, contrato G2-C) también cuenta como agotado.
  const outOfStockItems = items.filter((item) => item.stock_quantity <= 0)

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
