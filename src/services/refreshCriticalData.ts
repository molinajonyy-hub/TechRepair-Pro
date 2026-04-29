/**
 * refreshCriticalData — precarga datos esenciales para el mostrador
 *
 * Se ejecuta:
 * - Al iniciar la app
 * - Cuando useAppWakeUp detecta que la app volvió de inactividad
 * - Al presionar "Reconectar" manualmente
 *
 * Almacena en AppCache para que los buscadores sean instantáneos.
 */
import { supabase } from '../lib/supabase'

// ─── Cache simple en memoria ──────────────────────────────────────────────────

const STALE_TIME_MS  = 5  * 60 * 1000  // 5 min → dato fresco
const GC_TIME_MS     = 30 * 60 * 1000  // 30 min → dato descartado

interface CacheEntry<T> { data: T; ts: number }
const store = new Map<string, CacheEntry<unknown>>()

export const AppCache = {
  get<T>(key: string): T | null {
    const entry = store.get(key) as CacheEntry<T> | undefined
    if (!entry) return null
    if (Date.now() - entry.ts > GC_TIME_MS) { store.delete(key); return null }
    return entry.data
  },
  getStale<T>(key: string): T | null {
    return (store.get(key) as CacheEntry<T> | undefined)?.data ?? null
  },
  isStale(key: string): boolean {
    const entry = store.get(key)
    if (!entry) return true
    return Date.now() - entry.ts > STALE_TIME_MS
  },
  set<T>(key: string, data: T): void {
    store.set(key, { data, ts: Date.now() })
  },
  invalidate(key: string): void { store.delete(key) },
  clear(): void { store.clear() },
}

// ─── Claves de caché ─────────────────────────────────────────────────────────

export const CACHE_KEYS = {
  customers:  (bId: string) => `customers:${bId}`,
  inventory:  (bId: string) => `inventory:${bId}`,
  orders:     (bId: string) => `orders:${bId}`,
}

// ─── Tipos ligeros ────────────────────────────────────────────────────────────

export interface LightCustomer {
  id: string
  name: string
  phone?: string
  email?: string
  customer_type?: string
}

export interface LightInventoryItem {
  id: string
  name: string
  variant_name?: string
  code?: string
  category?: string
  stock_quantity: number
  sale_price: number
  cost_price?: number
  precio_mayorista?: number
}

// ─── Refresh functions ────────────────────────────────────────────────────────

export async function prefetchCustomers(businessId: string): Promise<LightCustomer[]> {
  if (!AppCache.isStale(CACHE_KEYS.customers(businessId))) {
    return AppCache.get<LightCustomer[]>(CACHE_KEYS.customers(businessId)) || []
  }
  const { data } = await supabase
    .from('customers')
    .select('id, name, phone, email, customer_type')
    .eq('business_id', businessId)
    .order('updated_at', { ascending: false })
    .limit(200)
  const result = (data || []) as LightCustomer[]
  AppCache.set(CACHE_KEYS.customers(businessId), result)
  return result
}

export async function prefetchInventory(businessId: string): Promise<LightInventoryItem[]> {
  if (!AppCache.isStale(CACHE_KEYS.inventory(businessId))) {
    return AppCache.get<LightInventoryItem[]>(CACHE_KEYS.inventory(businessId)) || []
  }
  const { data } = await supabase
    .from('inventory')
    .select('id, name, variant_name, code, category, stock_quantity, sale_price, cost_price, precio_mayorista')
    .eq('business_id', businessId)
    .eq('is_active', true)
    .not('has_variants', 'is', true)
    .gt('stock_quantity', 0)
    .order('name')
    .limit(500)
  const result = (data || []) as LightInventoryItem[]
  AppCache.set(CACHE_KEYS.inventory(businessId), result)
  return result
}

/** Precarga en segundo plano — no bloquea la UI */
export function backgroundPrefetch(businessId: string): void {
  if (!businessId || !navigator.onLine) return
  // Pequeño delay para no competir con la carga inicial de la página
  setTimeout(() => {
    prefetchCustomers(businessId).catch(() => {})
    prefetchInventory(businessId).catch(() => {})
  }, 800)
}
