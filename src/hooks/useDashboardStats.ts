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
const CACHE_TTL_MS = 2 * 60 * 1000 // 2 minutos — reducido para reflejar cambios más rápido

/** Llamar desde cualquier módulo que registre cobros/pagos para forzar recarga */
export function invalidateStatsCache() {
  statsCache = null
}

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
        recentOrdersResult,
        pendingResult,
        completedOrdersResult,
        partsResult,
        totalCustomers,
        newCustomersThisMonth,
        financeResult,
        compItemsResult,
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

        // 5. 5 órdenes recientes — incluye nombre del cliente y modelo del dispositivo
        supabase
          .from('orders')
          .select('id, status, created_at, customer:customers(name), device:devices(brand, model)')
          .eq('business_id', businessId)
          .order('created_at', { ascending: false })
          .limit(5),

        // 6. Pagos pendientes — órdenes activas con saldo
        supabase
          .from('orders')
          .select('total_cost, amount_paid')
          .eq('business_id', businessId)
          .in('status', ['completed', 'ready_delivery', 'waiting_payment']),

        // 7. Órdenes completadas para métricas de tiempo (LIMIT 100)
        supabase
          .from('orders')
          .select('created_at, updated_at')
          .eq('business_id', businessId)
          .eq('status', 'completed')
          .limit(100),

        // 8. Parts últimos 90 días para margen por item
        supabase
          .from('order_parts')
          .select('internal_cost, sale_price, quantity, name, added_at')
          .eq('business_id', businessId)
          .in('status', ['used', 'sold'])
          .gte('added_at', ninetyDaysAgo),

        // 11b. comprobante_items emitidos últimos 90 días (ventas directas sin orden)
        supabase
          .from('comprobante_items')
          .select('precio_unitario, costo_unitario, cantidad, descripcion, created_at, tipo_linea, comprobante:comprobantes!inner(status, order_id)')
          .eq('business_id', businessId)
          .in('tipo_linea', ['producto', 'repuesto', 'servicio'])
          .gte('created_at', ninetyDaysAgo),

        // 9. Total clientes
        loadCustomerCount(),

        // 10. Nuevos clientes este mes
        loadCustomerCount(monthAgo),

        // 11. Resumen financiero desde business_finance_entries (fuente unificada)
        supabase
          .from('business_finance_entries')
          .select('type, amount_ars, date')
          .eq('business_id', businessId)
          .gte('date', ninetyDaysAgo.split('T')[0])
          .lte('date', today),
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

      // 5 órdenes recientes — con nombre de cliente y modelo de dispositivo
      const recentOrders: RecentOrder[] = (recentOrdersResult.data || []).map((o: any) => ({
        id:            o.id,
        status:        o.status,
        created_at:    o.created_at,
        customer_name: o.customer?.name ?? null,
        device_label:  o.device ? `${o.device.brand} ${o.device.model}`.trim() : null,
      }))

      // ── Ingresos desde business_finance_entries (fuente unificada) ──
      let totalRevenue     = 0
      let revenueToday     = 0
      let revenueThisWeek  = 0
      let revenueThisMonth = 0
      const todayDate    = today                          // 'YYYY-MM-DD'
      const weekAgoDate  = weekAgo.split('T')[0]
      const monthAgoDate = monthAgo.split('T')[0]

      if (!financeResult.error && financeResult.data) {
        const incomeEntries = financeResult.data.filter(e => e.type === 'income')
        totalRevenue     = incomeEntries.reduce((s, e) => s + (e.amount_ars || 0), 0)
        revenueToday     = incomeEntries.filter(e => e.date >= todayDate).reduce((s, e) => s + (e.amount_ars || 0), 0)
        revenueThisWeek  = incomeEntries.filter(e => e.date >= weekAgoDate).reduce((s, e) => s + (e.amount_ars || 0), 0)
        revenueThisMonth = incomeEntries.filter(e => e.date >= monthAgoDate).reduce((s, e) => s + (e.amount_ars || 0), 0)
      }

      // Pagos pendientes (órdenes activas con saldo)
      let pendingPayments = 0
      if (!pendingResult.error && pendingResult.data) {
        pendingPayments = pendingResult.data.reduce((sum, o) => {
          const total = o.total_cost || 0
          const paid  = o.amount_paid || 0
          return paid < total ? sum + (total - paid) : sum
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

      // Ganancia real: order_parts + comprobante_items de ventas directas (sin orden)
      let realProfitToday    = 0
      let realProfitThisWeek = 0
      let realProfitThisMonth = 0
      let averageMarginPct   = 0
      let profitPerOperation = 0
      let topProfitableItems: { name: string; profit: number; margin: number; count: number }[] = []
      const popularDeviceTypes: { type: string; count: number }[] = []

      const itemMap: Record<string, { profit: number; rev: number; count: number }> = {}

      // — Fuente 1: order_parts (repuestos usados en órdenes) —
      if (!partsResult.error && partsResult.data) {
        const parts = partsResult.data
        const accumProfit = (list: typeof parts, dateField: string) =>
          list.reduce((s, p) => s + Math.max(0, (p.sale_price - p.internal_cost)) * p.quantity, 0)

        realProfitToday    += accumProfit(parts.filter(p => p.added_at?.slice(0, 10) >= todayDate), 'added_at')
        realProfitThisWeek  += accumProfit(parts.filter(p => p.added_at?.slice(0, 10) >= weekAgoDate), 'added_at')
        realProfitThisMonth += accumProfit(parts.filter(p => p.added_at?.slice(0, 10) >= monthAgoDate), 'added_at')

        parts.forEach(p => {
          const key    = (p.name || 'Sin nombre').slice(0, 40)
          const profit = Math.max(0, (p.sale_price - p.internal_cost)) * p.quantity
          const rev    = p.sale_price * p.quantity
          if (!itemMap[key]) itemMap[key] = { profit: 0, rev: 0, count: 0 }
          itemMap[key].profit += profit; itemMap[key].rev += rev; itemMap[key].count += 1
        })
      }

      // — Fuente 2: comprobante_items emitidos SIN orden (ventas directas) —
      if (!compItemsResult?.error && compItemsResult?.data) {
        const compItems = (compItemsResult.data as any[]).filter(ci =>
          // Solo comprobantes emitidos y sin orden asociada (los de orden ya están en order_parts)
          ci.comprobante?.status === 'issued' && !ci.comprobante?.order_id
        )
        const calcDate = (ci: any) => (ci.created_at || '').slice(0, 10)

        realProfitToday    += compItems.filter(ci => calcDate(ci) >= todayDate)
          .reduce((s, ci) => s + Math.max(0, (ci.precio_unitario - ci.costo_unitario)) * ci.cantidad, 0)
        realProfitThisWeek  += compItems.filter(ci => calcDate(ci) >= weekAgoDate)
          .reduce((s, ci) => s + Math.max(0, (ci.precio_unitario - ci.costo_unitario)) * ci.cantidad, 0)
        realProfitThisMonth += compItems.filter(ci => calcDate(ci) >= monthAgoDate)
          .reduce((s, ci) => s + Math.max(0, (ci.precio_unitario - ci.costo_unitario)) * ci.cantidad, 0)

        compItems.forEach(ci => {
          const key    = (ci.descripcion || 'Sin nombre').slice(0, 40)
          const profit = Math.max(0, (ci.precio_unitario - ci.costo_unitario)) * ci.cantidad
          const rev    = ci.precio_unitario * ci.cantidad
          if (!itemMap[key]) itemMap[key] = { profit: 0, rev: 0, count: 0 }
          itemMap[key].profit += profit; itemMap[key].rev += rev; itemMap[key].count += 1
        })
      }

      // — Consolidar métricas —
      const totalProfit = Object.values(itemMap).reduce((s, v) => s + v.profit, 0)
      const totalRev    = Object.values(itemMap).reduce((s, v) => s + v.rev, 0)
      averageMarginPct   = totalRev > 0 ? (totalProfit / totalRev) * 100 : 0
      profitPerOperation = totalOrders > 0 ? totalProfit / totalOrders : 0

      topProfitableItems = Object.entries(itemMap)
        .map(([name, { profit, rev, count }]) => ({
          name, profit, count,
          margin: rev > 0 ? (profit / rev) * 100 : 0,
        }))
        .sort((a, b) => b.profit - a.profit)
        .slice(0, 5)

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
