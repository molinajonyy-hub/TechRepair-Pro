import { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

export interface RecentOrder {
  id: string
  status: string
  created_at: string
  customer_name: string | null
  device_label: string | null
}

export interface DashboardStats {
  // Órdenes
  totalOrders: number
  ordersByStatus: Record<string, number>
  newOrdersToday: number
  completedOrdersToday: number
  recentOrders: RecentOrder[]

  // Financiero
  totalRevenue: number
  revenueToday: number
  revenueThisWeek: number
  revenueThisMonth: number
  pendingPayments: number

  // Ganancia real (de order_parts usados/vendidos — últimos 90 días)
  realProfitToday: number
  realProfitThisWeek: number
  realProfitThisMonth: number
  averageMarginPct: number
  profitPerOperation: number
  topProfitableItems: { name: string; profit: number; margin: number; count: number }[]

  // Clientes
  totalCustomers: number
  newCustomersThisMonth: number

  // Dispositivos
  popularDeviceTypes: { type: string; count: number }[]

  // Rendimiento
  averageRepairTime: number
  onTimeDeliveryRate: number
}

interface SupabaseQueryError {
  code?: string
  message?: string
  status?: number
}

// ──────────────────────────────────────────────
// Caché a nivel de módulo — persiste entre navegaciones
// ──────────────────────────────────────────────

interface CacheEntry {
  stats: DashboardStats
  businessId: string
  timestamp: number
}

let statsCache: CacheEntry | null = null
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutos

function isCacheValid(businessId: string | null): boolean {
  return (
    statsCache !== null &&
    statsCache.businessId === businessId &&
    Date.now() - statsCache.timestamp < CACHE_TTL_MS
  )
}

// ──────────────────────────────────────────────
// Helpers de error
// ──────────────────────────────────────────────

const isPermissionError = (error: SupabaseQueryError | null | undefined) => {
  if (!error) return false
  const message = error.message?.toLowerCase() || ''
  return (
    error.status === 401 ||
    error.status === 403 ||
    message.includes('permission denied') ||
    message.includes('row-level security') ||
    message.includes('not allowed')
  )
}

const isMissingColumnError = (error: SupabaseQueryError | null | undefined) => {
  if (!error) return false
  const message = error.message?.toLowerCase() || ''
  return error.code === '42703' || (message.includes('column') && message.includes('does not exist'))
}

// ──────────────────────────────────────────────
// Hook principal
// ──────────────────────────────────────────────

export function useDashboardStats() {
  const { businessId, isAuthenticated, hasBusinessAccess, loading: authLoading, profileLoading } = useAuth()

  const [stats, setStats] = useState<DashboardStats | null>(() =>
    isCacheValid(businessId) ? statsCache!.stats : null
  )
  const [loading, setLoading] = useState<boolean>(() => !isCacheValid(businessId))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (authLoading || profileLoading) {
      if (!isCacheValid(businessId)) setLoading(true)
      return
    }

    if (!isAuthenticated || !hasBusinessAccess) {
      setStats(null)
      setError(null)
      setLoading(false)
      return
    }

    if (isCacheValid(businessId)) {
      setStats(statsCache!.stats)
      setLoading(false)
      return
    }

    void loadStats()
  }, [authLoading, profileLoading, isAuthenticated, hasBusinessAccess, businessId])

  async function loadCustomerCount(createdAfter?: string): Promise<number> {
    const runQuery = async (scopedByBusiness: boolean) => {
      let query = supabase
        .from('customers')
        .select('*', { count: 'exact', head: true })
      if (createdAfter) query = query.gte('created_at', createdAfter)
      if (scopedByBusiness && businessId) query = query.eq('business_id', businessId)
      return await query
    }

    const scopedResult = await runQuery(Boolean(businessId))
    if (!scopedResult.error) return scopedResult.count || 0

    if (businessId && isMissingColumnError(scopedResult.error)) {
      const fallbackResult = await runQuery(false)
      if (!fallbackResult.error) return fallbackResult.count || 0
      if (isPermissionError(fallbackResult.error)) return 0
      throw fallbackResult.error
    }

    if (isPermissionError(scopedResult.error)) return 0
    throw scopedResult.error
  }

  async function loadStats(forceRefresh = false) {
    if (!isAuthenticated || !hasBusinessAccess) {
      setStats(null)
      setError(null)
      setLoading(false)
      return
    }

    if (!forceRefresh && isCacheValid(businessId)) {
      setStats(statsCache!.stats)
      setLoading(false)
      return
    }

    try {
      setLoading(true)
      setError(null)

      const today    = new Date().toISOString().split('T')[0]
      const weekAgo  = new Date(Date.now() -  7 * 24 * 60 * 60 * 1000).toISOString()
      const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      // Para parts y payments usamos ventana de 90 días — evita traer todo el historial
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()

      // ── Todas las queries en paralelo ───────────────────────────────
      const [
        ordersCountResult,
        statusResult,
        newOrdersTodayResult,
        completedOrdersTodayResult,
        recentOrdersResult,   // ← 5 órdenes recientes (sin join pesado)
        paymentsResult,
        pendingResult,
        completedOrdersResult,
        partsResult,
        totalCustomers,
        newCustomersThisMonth,
      ] = await Promise.all([

        // 1. Total órdenes (COUNT, sin datos)
        supabase
          .from('orders')
          .select('*', { count: 'exact', head: true })
          .eq('business_id', businessId),

        // 2. Órdenes por estado — solo el campo status, sin join
        supabase
          .from('orders')
          .select('status')
          .eq('business_id', businessId),

        // 3. Órdenes nuevas hoy (COUNT)
        supabase
          .from('orders')
          .select('*', { count: 'exact', head: true })
          .eq('business_id', businessId)
          .gte('created_at', today),

        // 4. Órdenes completadas hoy (COUNT)
        supabase
          .from('orders')
          .select('*', { count: 'exact', head: true })
          .eq('business_id', businessId)
          .eq('status', 'completed')
          .gte('updated_at', today),

        // 5. 5 órdenes recientes — campos mínimos, sin join
        supabase
          .from('orders')
          .select('id, status, created_at, customer_id, device_id')
          .eq('business_id', businessId)
          .order('created_at', { ascending: false })
          .limit(5),

        // 6. Pagos últimos 90 días (con filtro de fecha para reducir volumen)
        supabase
          .from('order_payments')
          .select('amount, payment_date, orders!inner(business_id)')
          .eq('orders.business_id', businessId)
          .gte('payment_date', ninetyDaysAgo),

        // 7. Pagos pendientes — solo órdenes completadas
        supabase
          .from('orders')
          .select('total_cost, amount_paid')
          .eq('business_id', businessId)
          .eq('status', 'completed'),

        // 8. Órdenes completadas para métricas de tiempo (LIMIT 100)
        supabase
          .from('orders')
          .select('created_at, updated_at')
          .eq('business_id', businessId)
          .eq('status', 'completed')
          .limit(100),

        // 9. Parts últimos 90 días (con filtro de fecha)
        supabase
          .from('order_parts')
          .select('internal_cost, sale_price, quantity, name, added_at, orders!inner(business_id)')
          .eq('orders.business_id', businessId)
          .in('status', ['used', 'sold'])
          .gte('added_at', ninetyDaysAgo),

        // 10. Total clientes
        loadCustomerCount(),

        // 11. Nuevos clientes este mes
        loadCustomerCount(monthAgo),
      ])

      // ── Procesar resultados ─────────────────────────────────────────

      if (ordersCountResult.error)          throw ordersCountResult.error
      if (statusResult.error)               throw statusResult.error
      if (newOrdersTodayResult.error)       throw newOrdersTodayResult.error
      if (completedOrdersTodayResult.error) throw completedOrdersTodayResult.error
      if (completedOrdersResult.error)      throw completedOrdersResult.error

      const totalOrders          = ordersCountResult.count || 0
      const newOrdersToday       = newOrdersTodayResult.count || 0
      const completedOrdersToday = completedOrdersTodayResult.count || 0

      // Órdenes por estado
      const ordersByStatus: Record<string, number> = {}
      statusResult.data?.forEach(o => {
        ordersByStatus[o.status] = (ordersByStatus[o.status] || 0) + 1
      })

      // 5 órdenes recientes — sin join, campos planos
      const recentOrders: RecentOrder[] = (recentOrdersResult.data || []).map(o => ({
        id:           o.id,
        status:       o.status,
        created_at:   o.created_at,
        customer_name: null,  // no hacemos join pesado — mostramos ID corto
        device_label:  null,
      }))

      // Ingresos últimos 90 días (opcional)
      let totalRevenue     = 0
      let revenueToday     = 0
      let revenueThisWeek  = 0
      let revenueThisMonth = 0

      if (!paymentsResult.error && paymentsResult.data) {
        totalRevenue     = paymentsResult.data.reduce((s, p) => s + (p.amount || 0), 0)
        revenueToday     = paymentsResult.data.filter(p => p.payment_date >= today).reduce((s, p) => s + (p.amount || 0), 0)
        revenueThisWeek  = paymentsResult.data.filter(p => p.payment_date >= weekAgo).reduce((s, p) => s + (p.amount || 0), 0)
        revenueThisMonth = paymentsResult.data.filter(p => p.payment_date >= monthAgo).reduce((s, p) => s + (p.amount || 0), 0)
      }

      // Pagos pendientes (opcional)
      let pendingPayments = 0
      if (!pendingResult.error && pendingResult.data) {
        pendingPayments = pendingResult.data.reduce((sum, o) => {
          const total = o.total_cost || 0
          const paid  = o.amount_paid || 0
          return paid < total || !paid ? sum + (total - paid) : sum
        }, 0)
      }

      // Tiempo promedio de reparación
      const completedOrders = completedOrdersResult.data || []
      let averageRepairTime  = 0
      let onTimeDeliveryRate = 0

      if (completedOrders.length > 0) {
        const totalHours = completedOrders.reduce((sum, o) => {
          const hours = (new Date(o.updated_at).getTime() - new Date(o.created_at).getTime()) / (1000 * 60 * 60)
          return sum + hours
        }, 0)
        averageRepairTime = totalHours / completedOrders.length

        const onTimeCount = completedOrders.filter(o => {
          const hours = (new Date(o.updated_at).getTime() - new Date(o.created_at).getTime()) / (1000 * 60 * 60)
          return hours <= 48
        }).length
        onTimeDeliveryRate = (onTimeCount / completedOrders.length) * 100
      }

      // Ganancia real desde order_parts últimos 90 días (opcional)
      let realProfitToday    = 0
      let realProfitThisWeek = 0
      let realProfitThisMonth = 0
      let averageMarginPct   = 0
      let profitPerOperation = 0
      let topProfitableItems: { name: string; profit: number; margin: number; count: number }[] = []
      // Dispositivos populares — sin esta query ya que requiere join pesado
      const popularDeviceTypes: { type: string; count: number }[] = []

      if (!partsResult.error && partsResult.data) {
        const parts = partsResult.data

        const calcProfit  = (list: typeof parts) =>
          list.reduce((s, p) => s + Math.max(0, (p.sale_price - p.internal_cost)) * p.quantity, 0)
        const calcRevenue = (list: typeof parts) =>
          list.reduce((s, p) => s + p.sale_price * p.quantity, 0)

        realProfitToday    = calcProfit(parts.filter(p => p.added_at >= today + 'T00:00:00'))
        realProfitThisWeek = calcProfit(parts.filter(p => p.added_at >= weekAgo))
        realProfitThisMonth = calcProfit(parts.filter(p => p.added_at >= monthAgo))

        const totalRev    = calcRevenue(parts)
        const totalProfit = calcProfit(parts)
        averageMarginPct  = totalRev > 0 ? (totalProfit / totalRev) * 100 : 0
        profitPerOperation = totalOrders > 0 ? totalProfit / totalOrders : 0

        const itemMap: Record<string, { profit: number; rev: number; count: number }> = {}
        parts.forEach(p => {
          const key    = (p.name || 'Sin nombre').slice(0, 40)
          const profit = Math.max(0, (p.sale_price - p.internal_cost)) * p.quantity
          const rev    = p.sale_price * p.quantity
          if (!itemMap[key]) itemMap[key] = { profit: 0, rev: 0, count: 0 }
          itemMap[key].profit += profit
          itemMap[key].rev    += rev
          itemMap[key].count  += 1
        })
        topProfitableItems = Object.entries(itemMap)
          .map(([name, { profit, rev, count }]) => ({
            name, profit, count,
            margin: rev > 0 ? (profit / rev) * 100 : 0,
          }))
          .sort((a, b) => b.profit - a.profit)
          .slice(0, 5)
      }

      const newStats: DashboardStats = {
        totalOrders,
        ordersByStatus,
        newOrdersToday,
        completedOrdersToday,
        recentOrders,
        totalRevenue,
        revenueToday,
        revenueThisWeek,
        revenueThisMonth,
        pendingPayments,
        realProfitToday,
        realProfitThisWeek,
        realProfitThisMonth,
        averageMarginPct,
        profitPerOperation,
        topProfitableItems,
        totalCustomers,
        newCustomersThisMonth,
        popularDeviceTypes,
        averageRepairTime,
        onTimeDeliveryRate,
      }

      statsCache = { stats: newStats, businessId: businessId!, timestamp: Date.now() }
      setStats(newStats)

    } catch (err: unknown) {
      console.error('Error loading dashboard stats:', err)
      setError(err instanceof Error ? err.message : 'Error al cargar estadísticas')
    } finally {
      setLoading(false)
    }
  }

  function refresh() {
    statsCache = null
    void loadStats(true)
  }

  return { stats, loading, error, refresh }
}
