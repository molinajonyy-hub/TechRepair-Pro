import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { OrderStatus, StatusHistoryEntry } from '../types/orderStatus'

/**
 * SEC-08A — columnas de `public.orders` que el browser puede leer. La lista es
 * explícita a propósito: `select('*')` responde 42501 desde que las columnas
 * financieras y `device_password` dejaron de estar concedidas.
 */
// Una sola cadena literal a propósito: si se arma concatenando, TypeScript la
// ensancha a `string` y supabase-js pierde el tipado de la fila.
const ORDER_OPERATIONAL_COLUMNS =
  'id, business_id, customer_id, device_id, technician_id, assigned_profile_id, created_by, comprobante_id, status, priority, notes, access_mode, created_at, updated_at, completed_at'

export interface OrderDetailSimple {
  id: string
  status: OrderStatus
  priority: string
  /**
   * SEC-08A — importes de la orden. Son opcionales porque llegan por la ruta
   * autorizada `get_order_financial_amounts`: sin `orders_view_financials` la
   * DB no los entrega y quedan `undefined`. `undefined` significa "no
   * autorizado", NO "cero".
   */
  estimated_total?: number
  labor_cost?: number
  total_cost?: number
  amount_paid?: number
  balance_pending?: number
  /** ¿El servidor autorizó los importes de esta orden? */
  amountsAuthorized: boolean
  created_at: string
  updated_at: string
  notes?: string
  customer_id: string
  device_id: string
  technician_id?: string | null
  // `checklist` se retiró: era una lectura de `order_checklists` sin ningún
  // consumidor. La única UI que escribe esa tabla (ChecklistCard) no está
  // montada en ninguna pantalla, así que el hook leía algo que nadie mostraba.
  // Ver tests/components/orderChecklistAusente.test.tsx.
  // Historial de estados
  history?: StatusHistoryEntry[]
  // Pagos (con nuevos campos)
  payments?: {
    id: string
    amount: number
    payment_method: string
    payment_date: string
    is_down_payment?: boolean
    payment_status?: string
    receipt_number?: string
    due_date?: string
    notes?: string
  }[]
  // Repuestos usados en la orden
  parts?: {
    id: string
    name: string
    description?: string
    part_number?: string
    internal_cost: number
    sale_price: number
    quantity: number
    margin_amount: number
    margin_percentage: number
    status: string
    deduct_from_inventory: boolean
    /** false = internal/consumed, not billed to customer */
    cliente_paga_repuesto: boolean
    notes?: string
    added_at: string
  }[]
  // Ítems de trabajo (servicios + repuestos) — fuente de verdad para facturación
  orderItems?: {
    id: string
    tipo: 'servicio' | 'repuesto' | string
    descripcion: string
    cantidad: number
    precio_unitario: number
    costo_unitario: number
    /** false = repuesto interno, no se factura al cliente */
    cliente_paga_repuesto: boolean
    product_id?: string | null
  }[]
  // Inspecciones (checklist recepción y final)
  inspections?: {
    reception?: any
    final?: any
  }
  // Datos relacionados (opcionales, se cargan por separado si falla el join)
  customer?: {
    id: string
    name: string
    phone: string
    email?: string
    address?: string
  } | null
  device?: {
    id: string
    type: string
    brand: string
    model: string
    serial?: string
    imei?: string
    issue: string
    diagnosis?: string
  } | null
  technician?: {
    id: string
    name: string
  } | null
}

type AuthorizedAmounts = {
  authorized: boolean
  row?: {
    estimated_total?: number
    labor_cost?: number
    total_cost?: number
    amount_paid?: number
    saldo_pendiente?: number
  }
}

/**
 * SEC-08A — única ruta a los importes de la orden. Nunca devuelve ceros
 * inventados: si el servidor no autoriza, `authorized` es false y no hay fila.
 */
async function fetchAuthorizedAmounts(businessId: string | null | undefined, orderId: string): Promise<AuthorizedAmounts> {
  if (!businessId) return { authorized: false }
  const { data, error } = await supabase.rpc('get_order_financial_amounts', {
    p_business_id: businessId, p_order_ids: [orderId],
  })
  const res = data as { ok?: boolean; authorized?: boolean; rows?: AuthorizedAmounts['row'][] } | null
  if (error || res?.ok === false || res?.authorized !== true) return { authorized: false }
  return { authorized: true, row: res.rows?.[0] }
}

export function useOrderSimple(orderId: string | undefined) {
  const [order, setOrder] = useState<OrderDetailSimple | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!orderId) {
      setLoading(false)
      return
    }

    async function fetchOrder() {
      try {
        setLoading(true)
        setError(null)

        // Primero, intentar cargar solo la orden (sin joins)
        const { data: orderData, error: orderError } = await supabase
          .from('orders')
          .select(ORDER_OPERATIONAL_COLUMNS)
          .eq('id', orderId)
          .single()

        if (orderError) {
          if (import.meta.env.DEV) if (import.meta.env.DEV) console.warn('Error loading order:', orderError)
          throw new Error('No se pudo cargar la orden: ' + orderError.message)
        }

        if (!orderData) {
          setError('Orden no encontrada')
          return
        }

        const montos = await fetchAuthorizedAmounts(orderData.business_id, orderId!)

        const result: OrderDetailSimple = {
          ...orderData,
          amountsAuthorized: montos.authorized,
          estimated_total: montos.row?.estimated_total,
          labor_cost: montos.row?.labor_cost,
          total_cost: montos.row?.total_cost,
          amount_paid: montos.row?.amount_paid,
          // Se conserva la fórmula histórica (`total_cost - amount_paid`). El
          // saldo CANÓNICO de la orden no es éste: vive en
          // `useOrderCanonicalBalance`, que ya sale de la misma RPC.
          balance_pending: montos.authorized
            ? (montos.row?.total_cost || 0) - (montos.row?.amount_paid || 0)
            : undefined,
          customer: null,
          device: null,
          technician: null,
          inspections: {}
        }

        // Cargar customer por separado
        if (orderData.customer_id) {
          try {
            const { data: customerData } = await supabase
              .from('customers')
              .select('id, name, phone, email, address')
              .eq('id', orderData.customer_id)
              .single()
            if (customerData) {
              result.customer = customerData
            }
          } catch (err) {
            if (import.meta.env.DEV) console.warn('Could not load customer:', err)
          }
        }

        // Cargar device por separado
        if (orderData.device_id) {
          try {
            const { data: deviceData } = await supabase
              .from('devices')
              .select('id, type, brand, model, serial, imei, issue, diagnosis')
              .eq('id', orderData.device_id)
              .single()
            if (deviceData) {
              result.device = deviceData
            }
          } catch (err) {
            if (import.meta.env.DEV) console.warn('Could not load device:', err)
          }
        }

        // Cargar technician por separado
        if (orderData.technician_id) {
          try {
            const { data } = await supabase
              .from('users')
              .select('id, name')
              .eq('id', orderData.technician_id)
              .single()
            if (data) {
              result.technician = data
            }
          } catch (err) {
            if (import.meta.env.DEV) console.warn('Could not load technician:', err)
          }
        }

        // Cargar repuestos (order_parts — métricas de costo/margen)
        try {
          const { data: partsData } = await supabase
            .from('order_parts')
            .select('*')
            .eq('order_id', orderId)
            .order('added_at', { ascending: false })

          if (partsData) {
            result.parts = partsData
          }
        } catch (err) {
          if (import.meta.env.DEV) console.warn('Could not load parts:', err)
        }

        // Cargar ítems de trabajo (order_items — fuente autoritativa para facturación)
        try {
          const { data: itemsData } = await supabase
            .from('order_items')
            .select('id, tipo, descripcion, cantidad, precio_unitario, costo_unitario, cliente_paga_repuesto, product_id')
            .eq('order_id', orderId)
            .order('created_at', { ascending: true })

          if (itemsData) {
            result.orderItems = itemsData as OrderDetailSimple['orderItems']
          }
        } catch (err) {
          if (import.meta.env.DEV) console.warn('Could not load order items:', err)
        }

        // Cargar pagos
        try {
          const { data: paymentsData } = await supabase
            .from('order_payments')
            .select('*')
            .eq('order_id', orderId)
            .order('payment_date', { ascending: false })
          
          if (paymentsData) {
            result.payments = paymentsData
            // SEC-08A: `order_payments` ya está gateado por
            // `orders_view_financials` en su RLS, así que un rol sin permiso
            // recibe CERO filas. Sin este guard, ese conjunto vacío se
            // convertía en `amount_paid = 0`: un importe inventado.
            if (montos.authorized) {
              const totalPaid = paymentsData.filter((p: any) => p.payment_status === 'completed').reduce((sum: number, p: any) => sum + (p.amount || 0), 0)
              result.amount_paid = totalPaid
              result.balance_pending = (result.total_cost || 0) - totalPaid
            }
          }
        } catch (err) {
          if (import.meta.env.DEV) console.warn('Could not load payments:', err)
        }

        // Cargar historial de estados
        try {
          const { data: historyData } = await supabase
            .from('status_history')
            .select('*')
            .eq('order_id', orderId)
            .order('created_at', { ascending: false })
          
          if (historyData) {
            result.history = historyData
          }
        } catch (err) {
          if (import.meta.env.DEV) console.warn('Could not load status history:', err)
        }

        // Cargar inspecciones (checklist recepción y final)
        try {
          const { data: inspectionsData } = await supabase
            .from('device_inspections')
            .select('*')
            .eq('order_id', orderId)
          
          if (inspectionsData && inspectionsData.length > 0) {
            result.inspections = {
              reception: inspectionsData.find((i: any) => i.type === 'reception'),
              final: inspectionsData.find((i: any) => i.type === 'final')
            }
          }
        } catch (err) {
          if (import.meta.env.DEV) console.warn('Could not load inspections:', err)
        }

        setOrder(result)
      } catch (err: unknown) {
        if (import.meta.env.DEV) if (import.meta.env.DEV) console.warn('❌ Error in fetchOrder:', err)
        setError(err instanceof Error ? err.message : 'Error al cargar la orden')
      } finally {
        setLoading(false)
      }
    }

    fetchOrder()
  }, [orderId])

  // Función para recargar datos manualmente
  const refresh = async () => {
    if (!orderId) return
    
    setLoading(true)
    setError(null)
    
    try {
      // Recargar orden
      const { data: orderData, error: orderError } = await supabase
        .from('orders')
        .select(ORDER_OPERATIONAL_COLUMNS)
        .eq('id', orderId)
        .single()

      if (orderError) throw orderError
      if (!orderData) {
        setError('Orden no encontrada')
        return
      }

      const montos = await fetchAuthorizedAmounts(orderData.business_id, orderId)

      const result: OrderDetailSimple = {
        ...orderData,
        amountsAuthorized: montos.authorized,
        estimated_total: montos.row?.estimated_total,
        labor_cost: montos.row?.labor_cost,
        total_cost: montos.row?.total_cost,
        amount_paid: montos.row?.amount_paid,
        balance_pending: montos.authorized
          ? (montos.row?.total_cost || 0) - (montos.row?.amount_paid || 0)
          : undefined,
        customer: null,
        device: null,
        technician: null,
        history: [],
        payments: [],
        parts: [],
        inspections: {}
      }

      // Recargar relaciones
      if (orderData.customer_id) {
        const { data } = await supabase.from('customers').select('id, name, phone, email, address').eq('id', orderData.customer_id).single()
        result.customer = data || null
      }
      if (orderData.device_id) {
        const { data } = await supabase.from('devices').select('*').eq('id', orderData.device_id).single()
        result.device = data || null
      }
      if (orderData.technician_id) {
        const { data } = await supabase.from('users').select('id, name').eq('id', orderData.technician_id).single()
        result.technician = data || null
      }

      // Recargar repuestos
      try {
        const { data: partsData } = await supabase
          .from('order_parts')
          .select('*')
          .eq('order_id', orderId)
          .order('added_at', { ascending: false })
        if (partsData) {
          result.parts = partsData
        }
      } catch (err) {
        if (import.meta.env.DEV) console.warn('Could not load parts:', err)
      }

      // Recargar ítems de trabajo
      try {
        const { data: itemsData } = await supabase
          .from('order_items')
          .select('id, tipo, descripcion, cantidad, precio_unitario, costo_unitario, cliente_paga_repuesto, product_id')
          .eq('order_id', orderId)
          .order('created_at', { ascending: true })
        if (itemsData) {
          result.orderItems = itemsData as OrderDetailSimple['orderItems']
        }
      } catch (err) {
        if (import.meta.env.DEV) console.warn('Could not load order items:', err)
      }

      // Recargar pagos
      try {
        const { data: paymentsData } = await supabase
          .from('order_payments')
          .select('*')
          .eq('order_id', orderId)
          .order('payment_date', { ascending: false })
        if (paymentsData) {
          result.payments = paymentsData
          // SEC-08A: mismo guard que en la carga inicial — sin autorización,
          // un conjunto vacío no se convierte en `amount_paid = 0`.
          if (montos.authorized) {
            const totalPaid = paymentsData.reduce((sum, p) => sum + (p.amount || 0), 0)
            result.amount_paid = totalPaid
            result.balance_pending = (result.total_cost || 0) - totalPaid
          }
        }
      } catch (err) {
        if (import.meta.env.DEV) console.warn('Could not load payments:', err)
      }

      // Recargar historial
      try {
        const { data: historyData } = await supabase
          .from('status_history')
          .select('*')
          .eq('order_id', orderId)
          .order('created_at', { ascending: false })
        
        if (historyData) {
          result.history = historyData
        }
      } catch (err) {
        if (import.meta.env.DEV) console.warn('Could not load status history:', err)
      }

      // Recargar inspecciones
      try {
        const { data: inspectionsData } = await supabase
          .from('device_inspections')
          .select('*')
          .eq('order_id', orderId)
        
        if (inspectionsData && inspectionsData.length > 0) {
          result.inspections = {
            reception: inspectionsData.find((i: any) => i.type === 'reception'),
            final: inspectionsData.find((i: any) => i.type === 'final')
          }
        }
      } catch (err) {
        if (import.meta.env.DEV) console.warn('Could not load inspections:', err)
      }

      setOrder(result)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al cargar la orden')
    } finally {
      setLoading(false)
    }
  }

  return { order, loading, error, refresh }
}
