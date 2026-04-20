import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export interface OrderListItem {
  id: string
  status: string
  priority: string
  estimated_total: number
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
}

export function useOrders() {
  const [orders, setOrders] = useState<OrderListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchOrders = async () => {
    try {
      setLoading(true)
      setError(null)

      const { data, error: ordersError } = await supabase
        .from('orders')
        .select(`
          id, status, priority, estimated_total, created_at,
          customer:customers(id, name, phone),
          device:devices(id, brand, model, type)
        `)
        .order('created_at', { ascending: false })
        .limit(50)

      if (ordersError) throw ordersError

      setOrders((data as OrderListItem[]) ?? [])
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error al cargar órdenes'
      console.error('❌ Error loading orders:', err)
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchOrders()
  }, [])

  return { orders, loading, error, refresh: fetchOrders }
}
