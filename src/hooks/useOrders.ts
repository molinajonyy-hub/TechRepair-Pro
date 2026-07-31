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
  /**
   * ¿El servidor autorizó a este usuario a ver IMPORTES?
   *   true  → hay montos;
   *   false → rol sin capacidad: se muestran "Importes restringidos", no ceros;
   *   null  → todavía no se sabe o hubo error: "No disponible".
   * La decisión la toma la DB (user_can_view_order_amounts); acá sólo se refleja.
   */
  const [amountsAuthorized, setAmountsAuthorized] = useState<boolean | null>(null)

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
        // v_order_payment_state NO tiene importes: el filtro y el badge
        // funcionan para cualquier rol, incluidos los que no ven montos.
        let q = supabase
          .from('v_order_payment_state')
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

      // ── Estado + importes: DOS consultas por página, nunca una por fila ───
      if (lista.length > 0) {
        const ids = lista.map(o => o.id)

        // 1) Estado de cobro (sin importes): lo ve cualquier rol del negocio.
        const { data: st, error: stErr } = await supabase
          .from('v_order_payment_state')
          .select('order_id, payment_status, comprobantes_vigentes, comprobante_id, comprobante_numero')
          .eq('business_id', businessId)
          .in('order_id', ids)
        if (stErr) {
          // El error financiero NO tumba la lista, pero tampoco se disfraza.
          setFinancialError(true); setFinancial({}); setAmountsAuthorized(null)
        } else {
          const mapa: Record<string, OrderFinancialStatus> = {}
          for (const row of (st ?? []) as Partial<OrderFinancialStatus>[]) {
            mapa[row.order_id as string] = row as OrderFinancialStatus
          }

          // 2) Importes: sólo si el rol tiene la capacidad. El servidor decide;
          //    sin permiso no devuelve filas y acá no se inventa ningún cero.
          const { data: amt, error: amtErr } = await supabase.rpc('get_order_financial_amounts', {
            p_business_id: businessId, p_order_ids: ids,
          })
          const res = amt as { ok?: boolean; authorized?: boolean; rows?: OrderFinancialStatus[] } | null
          if (amtErr || res?.ok === false) {
            setAmountsAuthorized(null)   // error: "No disponible", no "$0"
          } else {
            setAmountsAuthorized(!!res?.authorized)
            for (const row of (res?.rows ?? [])) {
              mapa[row.order_id] = { ...(mapa[row.order_id] ?? {}), ...row } as OrderFinancialStatus
            }
          }
          setFinancial(mapa)
        }
      } else {
        setFinancial({}); setAmountsAuthorized(null)
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

  return { orders, loading, error, total, financial, financialError, amountsAuthorized, refresh: fetchOrders }
}
