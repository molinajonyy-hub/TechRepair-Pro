/**
 * useOperationalDashboardStats — lo que Inicio necesita saber de la operación.
 *
 * BETA-UX-1F: Inicio es el centro operativo del taller; el dinero vive en
 * Finanzas y en Caja. Este hook existe para que esa frontera sea de RED y no
 * sólo de pantalla: lee `orders` (con el nombre del cliente y el modelo del
 * equipo de las cinco últimas) y nada más.
 *
 * NO lee, y no debe volver a leer: business_finance_entries,
 * v_finance_product_margin, comprobante_items, accounts, la RPC
 * get_order_financial_amounts ni el resumen financiero. Eso sigue en
 * `useDashboardStats`, que conserva a sus consumidores (Reportes) intacto.
 *
 * CONTEOS EXACTOS. Cada número es un `count: 'exact'` con `head: true`: no baja
 * filas. Contar en el cliente sobre `select('status')` se trunca en el máximo
 * de filas de la API (1.000) y, pasado ese punto, «activas = total − cerradas»
 * resta de un total exacto una cantidad truncada.
 *
 * FRESCURA. Guarda el último resultado en memoria para que volver a Inicio no
 * muestre un esqueleto, pero SIEMPRE revalida al montar: una orden recién
 * creada tiene que estar cuando el usuario vuelve.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { logger } from '../lib/logger'
import { businessDayStartInstant, businessToday } from '../lib/businessDate'
import type { OrderStatus } from '../types/orderStatus'

export interface RecentOrder {
  id: string
  status: string
  created_at: string
  customer_name: string | null
  device_label: string | null
}

export interface OperationalDashboardStats {
  /** total − completadas − canceladas. */
  activeOrders: number
  readyForDelivery: number
  waitingApproval: number
  /** Creadas desde las 00:00 de hoy en Argentina. */
  newOrdersToday: number
  recentOrders: RecentOrder[]
}

/** Cuántas órdenes recientes muestra Inicio. */
export const RECENT_ORDERS_LIMIT = 5

// Estados canónicos (`types/orderStatus.ts`). Tipados para que un alias legacy
// —`ready`, `delivered`— no compile.
const COMPLETED: OrderStatus = 'completed'
const CANCELLED: OrderStatus = 'cancelled'
const READY_DELIVERY: OrderStatus = 'ready_delivery'
const WAITING_APPROVAL: OrderStatus = 'waiting_approval'

const LOAD_ERROR = 'No pudimos cargar las órdenes. Probá de nuevo en unos segundos.'

interface RecentOrderRow {
  id: string
  status: string
  created_at: string
  customer: { name: string | null } | null
  device: { brand: string | null; model: string | null } | null
}

// ─── Último resultado, por negocio ────────────────────────────────────────────

let lastResult: { businessId: string; stats: OperationalDashboardStats } | null = null

const cachedFor = (businessId: string | null) =>
  lastResult && lastResult.businessId === businessId ? lastResult.stats : null

/** Descarta el último resultado guardado (cambio de sesión, tests). */
export function invalidateOperationalDashboardStats(): void {
  lastResult = null
}

// ─── Lectura ──────────────────────────────────────────────────────────────────

/** `select('id')`: contar no pide columnas, y `*` sobre `orders` es 42501 (SEC-08A). */
const countOrders = (businessId: string) =>
  supabase.from('orders').select('id', { count: 'exact', head: true }).eq('business_id', businessId)

async function fetchOperationalStats(businessId: string): Promise<OperationalDashboardStats> {
  const [total, completed, cancelled, ready, waiting, newToday, recent] = await Promise.all([
    countOrders(businessId),
    countOrders(businessId).eq('status', COMPLETED),
    countOrders(businessId).eq('status', CANCELLED),
    countOrders(businessId).eq('status', READY_DELIVERY),
    countOrders(businessId).eq('status', WAITING_APPROVAL),
    countOrders(businessId).gte('created_at', businessDayStartInstant(businessToday())),
    supabase
      .from('orders')
      .select('id, status, created_at, customer:customers(name), device:devices(brand, model)')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false })
      .limit(RECENT_ORDERS_LIMIT),
  ])

  // Un conteo fallido no se convierte en cero: «0 listas para entregar» es una
  // afirmación sobre el taller, y sería falsa.
  for (const result of [total, completed, cancelled, ready, waiting, newToday, recent]) {
    if (result.error) throw result.error
  }

  const rows = (recent.data ?? []) as unknown as RecentOrderRow[]

  return {
    activeOrders: Math.max(0, (total.count ?? 0) - (completed.count ?? 0) - (cancelled.count ?? 0)),
    readyForDelivery: ready.count ?? 0,
    waitingApproval: waiting.count ?? 0,
    newOrdersToday: newToday.count ?? 0,
    recentOrders: rows.map(row => ({
      id: row.id,
      status: row.status,
      created_at: row.created_at,
      customer_name: row.customer?.name ?? null,
      device_label: [row.device?.brand, row.device?.model].filter(Boolean).join(' ') || null,
    })),
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useOperationalDashboardStats() {
  const { businessId, isAuthenticated, hasBusinessAccess, loading: authLoading, profileLoading } = useAuth()

  const [stats, setStats] = useState<OperationalDashboardStats | null>(() => cachedFor(businessId))
  const [loading, setLoading] = useState<boolean>(() => cachedFor(businessId) === null)
  const [error, setError] = useState<string | null>(null)

  // Sólo gana la lectura más reciente: protege contra una respuesta vieja que
  // llega después de un cambio de negocio o de un «Actualizar».
  const requestRef = useRef(0)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  const ready = !authLoading && !profileLoading
  const allowed = Boolean(isAuthenticated && hasBusinessAccess && businessId)

  const load = useCallback(async () => {
    if (!businessId) return
    const request = ++requestRef.current
    try {
      const next = await fetchOperationalStats(businessId)
      if (!aliveRef.current || request !== requestRef.current) return
      lastResult = { businessId, stats: next }
      setStats(next)
      setError(null)
    } catch (err: unknown) {
      if (!aliveRef.current || request !== requestRef.current) return
      // El detalle técnico va al logger; el usuario recibe un mensaje fijo.
      logger.error('SUPABASE', 'No se pudieron cargar las estadísticas operativas de Inicio', err)
      setStats(null)
      setError(LOAD_ERROR)
    } finally {
      if (aliveRef.current && request === requestRef.current) setLoading(false)
    }
  }, [businessId])

  useEffect(() => {
    if (!ready) return
    if (!allowed) {
      setStats(null)
      setError(null)
      setLoading(false)
      return
    }
    const cached = cachedFor(businessId)
    setStats(cached)
    setLoading(cached === null)
    void load()
  }, [ready, allowed, businessId, load])

  const refresh = useCallback(() => {
    if (!ready || !allowed) return
    setLoading(true)
    setError(null)
    void load()
  }, [ready, allowed, load])

  return { stats, loading, error, refresh }
}
