import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useRefreshOnWakeUp } from './useAppWakeUp'

export interface OrderListItem {
  id: string
  status: string
  priority: string
  estimated_total: number
  labor_cost: number
  created_at: string
  customer: {
    id: string
    name: string
    phone: string
  } | null
  device: {
    id: string
    brand: string
    model: string
    type: string
  } | null
  order_items?: {
    tipo: string
    precio_unitario: number
    cantidad: number
    cliente_paga_repuesto: boolean
  }[]
}

export function useOrders() {
  const { businessId } = useAuth()
  const [orders, setOrders]   = useState<OrderListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [total, setTotal]     = useState(0)

  const fetchOrders = async () => {
    if (!businessId) return
    try {
      setLoading(true)
      setError(null)

      // COUNT total para mostrar "Mostrando 50 de X"
      const { count } = await supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('business_id', businessId)
      setTotal(count ?? 0)

      const { data, error: ordersError } = await supabase
        .from('orders')
        .select(`
          id, status, priority, estimated_total, labor_cost, created_at,
          customer:customers(id, name, phone),
          device:devices(id, brand, model, type),
          order_items(tipo, precio_unitario, cantidad, cliente_paga_repuesto)
        `)
        .eq('business_id', businessId)
        .order('created_at', { ascending: false })
        .limit(50)

      if (ordersError) throw ordersError

      setOrders((data as unknown as OrderListItem[]) ?? [])
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error al cargar órdenes'
      console.error('Error loading orders:', err)
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchOrders()
  }, [businessId])

  useRefreshOnWakeUp(fetchOrders)

  return { orders, loading, error, total, refresh: fetchOrders }
}
