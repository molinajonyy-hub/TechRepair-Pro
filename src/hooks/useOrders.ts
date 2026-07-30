import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useRefreshOnWakeUp } from './useAppWakeUp'
import type { OrderPaymentStatus } from '../components/orders/OrderFinancialBadge'

/**
 * P0-A.1U1 — Estado financiero de la orden, tal cual lo devuelve
 * `v_order_financial_status`. La UI NO lo calcula: ni el estado, ni el saldo,
 * ni el total cobrado. Se leen y se muestran.
 */
export interface OrderFinancialStatus {
  order_id: string
  payment_status: OrderPaymentStatus
  total_comprobado: number
  total_cobrado: number
  cobrado_directo: number
  imputado_cc: number
  saldo_pendiente: number
  saldo_en_cc: number
  deuda_en_cc: boolean
  comprobantes_vigentes: number
  comprobante_id: string | null
  comprobante_numero: string | null
  completed_at: string | null
  paid_at: string | null
  ultimo_pago: string | null
}

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

export interface UseOrdersFilters {
  /** Estado TÉCNICO (orders.status). '' = todos. */
  status?: string
  /** Estado FINANCIERO (v_order_financial_status.payment_status). '' = todos. */
  payment?: '' | OrderPaymentStatus
}

const PAGE_SIZE = 50

export function useOrders(filters: UseOrdersFilters = {}) {
  const { businessId } = useAuth()
  const { status: statusFilter = '', payment: paymentFilter = '' } = filters
  const [orders, setOrders]   = useState<OrderListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [total, setTotal]     = useState(0)
  /** Mapa order_id → estado financiero. Vacío mientras carga o si falló. */
  const [financial, setFinancial] = useState<Record<string, OrderFinancialStatus>>({})
  /**
   * El bloque financiero falló. Se expone APARTE del error general: la orden
   * sigue siendo utilizable, pero sus importes se muestran como "No disponible".
   * Nunca se degrada a 0 ni a un estado inventado.
   */
  const [financialError, setFinancialError] = useState(false)

  const fetchOrders = async () => {
    if (!businessId) return
    try {
      setLoading(true)
      setError(null)
      setFinancialError(false)

      const { count } = await supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('business_id', businessId)
      setTotal(count ?? 0)

      // ── Filtro FINANCIERO server-side ─────────────────────────────────────
      // Cuando hay filtro de cobro, la vista canónica es la que filtra y
      // pagina: nunca se descargan todas las órdenes para filtrarlas en React.
      let idsFiltrados: string[] | null = null
      if (paymentFilter) {
        let q = supabase
          .from('v_order_financial_status')
          .select('order_id')
          .eq('business_id', businessId)
          .eq('payment_status', paymentFilter)
        if (statusFilter) q = q.eq('estado_tecnico', statusFilter)
        const { data: fdata, error: ferr } = await q.limit(PAGE_SIZE)
        if (ferr) throw ferr
        idsFiltrados = (fdata ?? []).map((r: { order_id: string }) => r.order_id)
        if (idsFiltrados.length === 0) {
          setOrders([]); setFinancial({}); return
        }
      }

      let oq = supabase
        .from('orders')
        .select(`
          id, status, priority, estimated_total, labor_cost, created_at,
          customer:customers(id, name, phone),
          device:devices(id, brand, model, type),
          order_items(tipo, precio_unitario, cantidad, cliente_paga_repuesto)
        `)
        .eq('business_id', businessId)
      if (statusFilter) oq = oq.eq('status', statusFilter)
      if (idsFiltrados) oq = oq.in('id', idsFiltrados)

      const { data, error: ordersError } = await oq
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE)

      if (ordersError) throw ordersError
      const lista = (data as unknown as OrderListItem[]) ?? []
      setOrders(lista)

      // ── Estado financiero: UNA sola consulta para toda la página ──────────
      // Nunca una consulta por fila (N+1).
      if (lista.length > 0) {
        const { data: fs, error: fsErr } = await supabase
          .from('v_order_financial_status')
          .select('*')
          .eq('business_id', businessId)
          .in('order_id', lista.map(o => o.id))
        if (fsErr) {
          // El error financiero NO tumba la lista, pero tampoco se disfraza.
          setFinancialError(true)
          setFinancial({})
        } else {
          const mapa: Record<string, OrderFinancialStatus> = {}
          for (const row of (fs ?? []) as OrderFinancialStatus[]) mapa[row.order_id] = row
          setFinancial(mapa)
        }
      } else {
        setFinancial({})
      }
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
  }, [businessId, statusFilter, paymentFilter])

  useRefreshOnWakeUp(fetchOrders)

  return { orders, loading, error, total, financial, financialError, refresh: fetchOrders }
}
