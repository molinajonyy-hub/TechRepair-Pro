import { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

export interface DashboardStats {
  // Órdenes
  totalOrders: number
  ordersByStatus: Record<string, number>
  newOrdersToday: number
  completedOrdersToday: number

  // Financiero
  totalRevenue: number
  revenueToday: number
  revenueThisWeek: number
  revenueThisMonth: number
  pendingPayments: number

  // Ganancia real (de order_parts usados/vendidos)
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
  averageRepairTime: number // en horas
  onTimeDeliveryRate: number // porcentaje
}

interface SupabaseQueryError {
  code?: string
  message?: string
  status?: number
}

const isPermissionError = (error: SupabaseQueryError | null | undefined) => {
  if (!error) {
    return false
  }

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
  if (!error) {
    return false
  }

  const message = error.message?.toLowerCase() || ''
  return error.code === '42703' || (message.includes('column') && message.includes('does not exist'))
}

export function useDashboardStats() {
  const { businessId, isAuthenticated, hasBusinessAccess, loading: authLoading, profileLoading } = useAuth()
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (authLoading || profileLoading) {
      setLoading(true)
      return
    }

    if (!isAuthenticated || !hasBusinessAccess) {
      setStats(null)
      setError(null)
      setLoading(false)
      return
    }

    void loadStats()
  }, [authLoading, profileLoading, isAuthenticated, hasBusinessAccess, businessId])

  async function loadCustomerCount(createdAfter?: string) {
    const runQuery = async (scopedByBusiness: boolean) => {
      let query = supabase
        .from('customers')
        .select('*', { count: 'exact', head: true })

      if (createdAfter) {
        query = query.gte('created_at', createdAfter)
      }

      if (scopedByBusiness && businessId) {
        query = query.eq('business_id', businessId)
      }

      return await query
    }

    const scopedResult = await runQuery(Boolean(businessId))

    if (!scopedResult.error) {
      return scopedResult.count || 0
    }

    if (businessId && isMissingColumnError(scopedResult.error)) {
      const fallbackResult = await runQuery(false)

      if (!fallbackResult.error) {
        return fallbackResult.count || 0
      }

      if (isPermissionError(fallbackResult.error)) {
        return 0
      }

      throw fallbackResult.error
    }

    if (isPermissionError(scopedResult.error)) {
      return 0
    }

    throw scopedResult.error
  }

  async function loadStats() {
    if (!isAuthenticated || !hasBusinessAccess) {
      setStats(null)
      setError(null)
      setLoading(false)
      return
    }

    try {
      setLoading(true)
      setError(null)

      const today = new Date().toISOString().split('T')[0]
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

      // 1. Total de órdenes
      const { count: totalOrders, error: ordersError } = await supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('business_id', businessId)

      if (ordersError) throw ordersError

      // 2. Órdenes por estado
      const { data: statusData, error: statusError } = await supabase
        .from('orders')
        .select('status')
        .eq('business_id', businessId)

      if (statusError) throw statusError

      const ordersByStatus: Record<string, number> = {}
      statusData?.forEach(order => {
        ordersByStatus[order.status] = (ordersByStatus[order.status] || 0) + 1
      })

      // 3. Órdenes nuevas hoy
      const { count: newOrdersToday, error: newError } = await supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('business_id', businessId)
        .gte('created_at', today)

      if (newError) throw newError

      // 4. Órdenes completadas hoy
      const { count: completedOrdersToday, error: completedError } = await supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('business_id', businessId)
        .eq('status', 'completed')
        .gte('updated_at', today)

      if (completedError) throw completedError

      // 5. Ingresos totales (de pagos) - filtrar por órdenes del negocio
      let totalRevenue = 0
      let revenueToday = 0
      let revenueThisWeek = 0
      let revenueThisMonth = 0

      try {
        const { data: paymentsData, error: paymentsError } = await supabase
          .from('order_payments')
          .select('amount, payment_date, orders!inner(business_id)')
          .eq('orders.business_id', businessId)

        if (!paymentsError && paymentsData) {
          totalRevenue = paymentsData.reduce((sum, p) => sum + (p.amount || 0), 0)
          revenueToday = paymentsData
            .filter(p => p.payment_date >= today)
            .reduce((sum, p) => sum + (p.amount || 0), 0)
          revenueThisWeek = paymentsData
            .filter(p => p.payment_date >= weekAgo)
            .reduce((sum, p) => sum + (p.amount || 0), 0)
          revenueThisMonth = paymentsData
            .filter(p => p.payment_date >= monthAgo)
            .reduce((sum, p) => sum + (p.amount || 0), 0)
        }
      } catch {
        // order_payments tabla no disponible aún — continuar sin datos de ingresos
      }

      // 6. Pagos pendientes (órdenes completadas sin pago total)
      let pendingPayments = 0

      try {
        const { data: pendingOrders, error: pendingError } = await supabase
          .from('orders')
          .select('total_cost, amount_paid')
          .eq('business_id', businessId)
          .eq('status', 'completed')

        if (!pendingError && pendingOrders) {
          pendingPayments = pendingOrders.reduce((sum, o) => {
            const total = o.total_cost || 0
            const paid = o.amount_paid || 0
            if (paid < total || !paid) {
              return sum + (total - paid)
            }
            return sum
          }, 0)
        }
      } catch {
        // columnas total_cost/amount_paid no disponibles aún
      }

      // 7. Total de clientes
      const totalCustomers = await loadCustomerCount()

      // 8. Nuevos clientes este mes
      const newCustomersThisMonth = await loadCustomerCount(monthAgo)

      // 9. Tipos de dispositivos populares - filtrar por negocio
      let popularDeviceTypes: { type: string; count: number }[] = []

      try {
        const { data: devicesData, error: devicesError } = await supabase
          .from('devices')
          .select('type, customers!inner(business_id)')
          .eq('customers.business_id', businessId)

        if (!devicesError && devicesData) {
          const deviceTypeCount: Record<string, number> = {}
          devicesData.forEach(d => {
            deviceTypeCount[d.type] = (deviceTypeCount[d.type] || 0) + 1
          })
          popularDeviceTypes = Object.entries(deviceTypeCount)
            .map(([type, count]) => ({ type, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 5)
        }
      } catch {
        // devices tabla no disponible aún
      }

      // 10. Tiempo promedio de reparación (órdenes completadas)
      const { data: completedOrders, error: completedOrdersError } = await supabase
        .from('orders')
        .select('created_at, updated_at')
        .eq('business_id', businessId)
        .eq('status', 'completed')
        .limit(100)

      if (completedOrdersError) throw completedOrdersError

      let averageRepairTime = 0
      if (completedOrders && completedOrders.length > 0) {
        const totalHours = completedOrders.reduce((sum, o) => {
          const created = new Date(o.created_at).getTime()
          const completed = new Date(o.updated_at).getTime()
          const hours = (completed - created) / (1000 * 60 * 60)
          return sum + hours
        }, 0)
        averageRepairTime = totalHours / completedOrders.length
      }

      // 11. Tasa de entrega a tiempo (órdenes completadas antes de 48h)
      let onTimeDeliveryRate = 0
      if (completedOrders && completedOrders.length > 0) {
        const onTimeCount = completedOrders.filter(o => {
          const created = new Date(o.created_at).getTime()
          const completed = new Date(o.updated_at).getTime()
          const hours = (completed - created) / (1000 * 60 * 60)
          return hours <= 48
        }).length
        onTimeDeliveryRate = (onTimeCount / completedOrders.length) * 100
      }

      // 12. Ganancia real desde order_parts (repuestos usados/vendidos)
      let realProfitToday = 0
      let realProfitThisWeek = 0
      let realProfitThisMonth = 0
      let averageMarginPct = 0
      let profitPerOperation = 0
      let topProfitableItems: { name: string; profit: number; margin: number; count: number }[] = []

      try {
        const { data: partsData } = await supabase
          .from('order_parts')
          .select('internal_cost, sale_price, quantity, name, added_at, orders!inner(business_id)')
          .eq('orders.business_id', businessId)
          .in('status', ['used', 'sold'])

        const parts = partsData || []
        const calcProfit = (list: typeof parts) =>
          list.reduce((s, p) => s + Math.max(0, (p.sale_price - p.internal_cost)) * p.quantity, 0)
        const calcRevenue = (list: typeof parts) =>
          list.reduce((s, p) => s + p.sale_price * p.quantity, 0)

        realProfitToday = calcProfit(parts.filter(p => p.added_at >= today + 'T00:00:00'))
        realProfitThisWeek = calcProfit(parts.filter(p => p.added_at >= weekAgo))
        realProfitThisMonth = calcProfit(parts.filter(p => p.added_at >= monthAgo))

        const totalRev = calcRevenue(parts)
        const totalProfit = calcProfit(parts)
        averageMarginPct = totalRev > 0 ? (totalProfit / totalRev) * 100 : 0
        profitPerOperation = (totalOrders || 0) > 0 ? totalProfit / (totalOrders || 1) : 0

        const itemMap: Record<string, { profit: number; rev: number; count: number }> = {}
        parts.forEach(p => {
          const key = (p.name || 'Sin nombre').slice(0, 40)
          const profit = Math.max(0, (p.sale_price - p.internal_cost)) * p.quantity
          const rev = p.sale_price * p.quantity
          if (!itemMap[key]) itemMap[key] = { profit: 0, rev: 0, count: 0 }
          itemMap[key].profit += profit
          itemMap[key].rev += rev
          itemMap[key].count += 1
        })
        topProfitableItems = Object.entries(itemMap)
          .map(([name, { profit, rev, count }]) => ({
            name, profit, count,
            margin: rev > 0 ? (profit / rev) * 100 : 0,
          }))
          .sort((a, b) => b.profit - a.profit)
          .slice(0, 5)
      } catch {
        // order_parts tabla no disponible aún — continuar sin datos de ganancia
      }

      setStats({
        totalOrders: totalOrders || 0,
        ordersByStatus,
        newOrdersToday: newOrdersToday || 0,
        completedOrdersToday: completedOrdersToday || 0,
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
      })

    } catch (err: unknown) {
      console.error('Error loading dashboard stats:', err)
      setError(err instanceof Error ? err.message : 'Error al cargar estadísticas')
    } finally {
      setLoading(false)
    }
  }

  return { stats, loading, error, refresh: loadStats }
}
