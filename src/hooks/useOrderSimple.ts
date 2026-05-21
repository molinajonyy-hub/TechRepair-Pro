import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { OrderStatus, StatusHistoryEntry } from '../types/orderStatus'

export interface OrderDetailSimple {
  id: string
  status: OrderStatus
  priority: string
  estimated_total: number
  labor_cost: number
  total_cost: number
  amount_paid: number
  balance_pending: number
  created_at: string
  updated_at: string
  notes?: string
  customer_id: string
  device_id: string
  technician_id?: string | null
  checklist_id?: string | null
  // Datos adicionales para validaciones
  checklist?: {
    id: string
    diagnosis_done: boolean
    repair_done: boolean
    final_test_passed: boolean
    cleaning_done: boolean
    quality_control: boolean
    retirement_signature?: string
    retirement_signature_date?: string
  } | null
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
          .select('*')
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


        const result: OrderDetailSimple = {
          ...orderData,
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

        // Cargar checklist
        try {
          const { data: checklistData } = await supabase
            .from('order_checklists')
            .select('*')
            .eq('order_id', orderId)
            .single()
          
          if (checklistData) {
            result.checklist = checklistData
          }
        } catch (err) {
          if (import.meta.env.DEV) console.warn('Could not load checklist:', err)
        }

        // Cargar repuestos
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

        // Cargar pagos
        try {
          const { data: paymentsData } = await supabase
            .from('order_payments')
            .select('*')
            .eq('order_id', orderId)
            .order('payment_date', { ascending: false })
          
          if (paymentsData) {
            result.payments = paymentsData
            // Recalcular balance
            const totalPaid = paymentsData.filter((p: any) => p.payment_status === 'completed').reduce((sum: number, p: any) => sum + (p.amount || 0), 0)
            result.amount_paid = totalPaid
            result.balance_pending = (result.total_cost || 0) - totalPaid
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
        .select('*')
        .eq('id', orderId)
        .single()

      if (orderError) throw orderError
      if (!orderData) {
        setError('Orden no encontrada')
        return
      }

      const result: OrderDetailSimple = {
        ...orderData,
        amount_paid: orderData.amount_paid || 0,
        balance_pending: (orderData.total_cost || 0) - (orderData.amount_paid || 0),
        customer: null,
        device: null,
        technician: null,
        checklist: null,
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

      // Recargar checklist
      try {
        const { data: checklistData } = await supabase
          .from('order_checklists')
          .select('*')
          .eq('order_id', orderId)
          .single()
        if (checklistData) {
          result.checklist = checklistData
        }
      } catch (err) {
        if (import.meta.env.DEV) console.warn('Could not load checklist:', err)
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

      // Recargar pagos
      try {
        const { data: paymentsData } = await supabase
          .from('order_payments')
          .select('*')
          .eq('order_id', orderId)
          .order('payment_date', { ascending: false })
        if (paymentsData) {
          result.payments = paymentsData
          const totalPaid = paymentsData.reduce((sum, p) => sum + (p.amount || 0), 0)
          result.amount_paid = totalPaid
          result.balance_pending = (result.total_cost || 0) - totalPaid
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
