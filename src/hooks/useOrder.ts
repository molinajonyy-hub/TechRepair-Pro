import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export interface OrderDetail {
  id: string
  status: string
  priority: string
  estimated_total: number
  labor_cost: number
  total_cost: number
  created_at: string
  updated_at: string
  notes?: string
  customer: {
    id: string
    name: string
    phone: string
    email?: string
    address?: string
  }
  device: {
    id: string
    type: string
    brand: string
    model: string
    serial?: string
    imei?: string
    issue: string
    diagnosis?: string
  }
  technician?: {
    id: string
    name: string
  } | null
}

const ORDER_SELECT = `
  *,
  customer:customers(id, name, phone, email, address),
  device:devices(id, type, brand, model, serial, imei, issue, diagnosis),
  technician:users(id, name)
`

export function useOrder(orderId: string | undefined) {
  const [order, setOrder] = useState<OrderDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchOrder = async () => {
    if (!orderId) {
      setLoading(false)
      return
    }

    try {
      setLoading(true)
      setError(null)

      const { data, error: orderError } = await supabase
        .from('orders')
        .select(ORDER_SELECT)
        .eq('id', orderId)
        .single()

      if (orderError) throw orderError
      if (!data) { setError('Orden no encontrada'); return }

      setOrder(data as OrderDetail)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error al cargar la orden'
      console.error('❌ Error fetching order:', err)
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchOrder()
  }, [orderId])

  return { order, loading, error, refresh: fetchOrder }
}
