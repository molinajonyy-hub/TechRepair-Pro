import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export interface OrderDetail {
  id: string
  status: string
  priority: string
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

// SEC-08A — sólo columnas operativas. `*` sobre `orders` responde 42501; los
// importes salen de `get_order_financial_amounts`.
const ORDER_SELECT = `
  id, business_id, customer_id, device_id, technician_id, assigned_profile_id,
  created_by, comprobante_id, status, priority, notes, access_mode,
  created_at, updated_at, completed_at,
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

      // `as unknown` porque supabase-js tipa las relaciones embebidas como
      // arrays; en runtime `customer`/`device` son objetos.
      setOrder(data as unknown as OrderDetail)
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
