import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

/**
 * P0-A.1U2 — Saldo CANÓNICO de una orden, server-side.
 *
 * Existe para sacarle el cálculo de saldo a los componentes que lo derivaban
 * restando en React (`total - pagos`). Esa resta ignora las imputaciones de
 * cuenta corriente, así que después de imputar un crédito mostraba un saldo
 * que ya no era real.
 *
 * `disponible` es false cuando la orden no tiene comprobante vinculado (no hay
 * saldo canónico que mostrar) o cuando el rol no puede ver importes. En ese caso
 * el consumidor decide qué hacer — nunca se devuelve 0 como si fuera un saldo.
 *
 * W1: además del saldo se exponen `total` y `cobrado` de la MISMA respuesta de
 * `get_order_financial_amounts`, para que las variables económicas de WhatsApp
 * salgan de esta única fuente y no de `orders.total_cost` (que es el COGS que
 * escribe `recalculate_order_total`, no el precio al cliente).
 */
export function useOrderCanonicalBalance(orderId: string | undefined | null) {
  const { businessId } = useAuth()
  const [saldo, setSaldo] = useState(0)
  const [total, setTotal] = useState(0)
  const [cobrado, setCobrado] = useState(0)
  const [disponible, setDisponible] = useState(false)
  const [cargando, setCargando] = useState(true)

  useEffect(() => {
    let vivo = true
    const cargar = async () => {
      if (!orderId || !businessId) { setDisponible(false); setCargando(false); return }
      setCargando(true)
      const { data, error } = await supabase.rpc('get_order_financial_amounts', {
        p_business_id: businessId, p_order_ids: [orderId],
      })
      if (!vivo) return
      const r = data as {
        ok?: boolean
        authorized?: boolean
        rows?: { saldo_pendiente?: number; total_comprobado?: number; cobrado_directo?: number }[]
      } | null
      if (error || r?.ok === false || r?.authorized !== true || !r?.rows?.length) {
        setDisponible(false)
      } else {
        setSaldo(Number(r.rows[0].saldo_pendiente) || 0)
        setTotal(Number(r.rows[0].total_comprobado) || 0)
        setCobrado(Number(r.rows[0].cobrado_directo) || 0)
        setDisponible(true)
      }
      setCargando(false)
    }
    cargar()
    return () => { vivo = false }
  }, [orderId, businessId])

  return { saldo, total, cobrado, disponible, cargando }
}
