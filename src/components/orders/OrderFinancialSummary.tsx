/**
 * P0-A.1U1 — Resumen financiero de la orden, SOLO LECTURA.
 *
 * Todos los importes y el estado vienen de `v_order_financial_status`. Este
 * componente no suma, no resta y no decide nada: si el dato no llegó, muestra
 * "No disponible" — nunca $0 ni "Cobrado".
 *
 * Las acciones de imputar / distribuir / revertir NO están en este lote (U2).
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { FileText, AlertCircle, Wallet } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { colors } from '../../lib/tokens'
import { OrderFinancialBadge } from './OrderFinancialBadge'
import type { OrderFinancialStatus } from '../../hooks/useOrders'

interface Props {
  orderId: string
  /** Opcional: si no se pasa, se toma del contexto de autenticación. */
  businessId?: string | null
  /** Cliente de la orden, para el enlace a su cuenta corriente. */
  customerId?: string | null
}

const money = (n: number) => '$' + Math.round(n).toLocaleString('es-AR')

export function OrderFinancialSummary({ orderId, businessId: bizProp, customerId }: Props) {
  const { businessId: bizCtx } = useAuth()
  const businessId = bizProp ?? bizCtx
  const [data, setData]       = useState<OrderFinancialStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed]   = useState(false)
  const [credito, setCredito] = useState<number | null>(null)
  /** true = con permiso · false = rol restringido · null = error/desconocido. */
  const [authorized, setAuthorized] = useState<boolean | null>(null)

  useEffect(() => {
    let vivo = true
    const cargar = async () => {
      if (!businessId) return
      setLoading(true); setFailed(false)
      // 1) Estado (sin importes): accesible para cualquier rol del negocio.
      const { data: row, error } = await supabase
        .from('v_order_payment_state')
        .select('order_id, payment_status, comprobantes_vigentes, comprobante_id, comprobante_numero')
        .eq('business_id', businessId)
        .eq('order_id', orderId)
        .maybeSingle()
      if (!vivo) return
      if (error) { setFailed(true); setData(null); setLoading(false); return }
      if (!row)  { setData(null); setLoading(false); return }

      // 2) Importes: el servidor decide si corresponden. Sin permiso no llegan
      //    y la UI dice "restringidos", nunca cero.
      const { data: amt, error: amtErr } = await supabase.rpc('get_order_financial_amounts', {
        p_business_id: businessId, p_order_ids: [orderId],
      })
      if (!vivo) return
      const res = amt as { ok?: boolean; authorized?: boolean; rows?: OrderFinancialStatus[] } | null
      if (amtErr || res?.ok === false) {
        setAuthorized(null)
        setData(row as unknown as OrderFinancialStatus)
      } else {
        setAuthorized(!!res?.authorized)
        setData({ ...(row as unknown as OrderFinancialStatus), ...(res?.rows?.[0] ?? {}) })
      }

      // 3) Crédito del cliente sin imputar: también es un importe.
      if (customerId) {
        const { data: cr, error: crErr } = await supabase.rpc('get_customer_unallocated_credit', {
          p_business_id: businessId, p_customer_id: customerId,
        })
        const cres = cr as { ok?: boolean; authorized?: boolean; unallocated_amount?: number } | null
        if (vivo && !crErr && cres?.authorized) setCredito(Number(cres.unallocated_amount) || 0)
      }
      setLoading(false)
    }
    cargar()
    return () => { vivo = false }
  }, [orderId, businessId, customerId])

  const noDisponible = failed || (!loading && !data)

  const fila = (label: string, valor: string, destacar = false) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', padding: '0.3rem 0' }}>
      <span className="body-sm" style={{ color: colors.text.subtle }}>{label}</span>
      <span style={{ fontWeight: destacar ? 700 : 600, color: destacar ? colors.text.primary : colors.text.secondary,
                     fontVariantNumeric: 'tabular-nums' }}>{valor}</span>
    </div>
  )

  return (
    <div className="card" data-testid="order-financial-summary">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
        <h3 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Wallet size={18} /> Estado financiero
        </h3>
        {!loading && (
          <OrderFinancialBadge
            status={noDisponible ? null : (data?.payment_status ?? null)}
            unavailable={noDisponible}
          />
        )}
      </div>
      <div className="card-body">
        {loading ? (
          // Mientras carga NO se muestra ningún estado ni importe: un cero
          // provisorio se lee como "no debe nada" y sería mentira.
          <p className="body-sm" data-testid="order-financial-loading" style={{ color: colors.text.subtle }}>
            Cargando estado financiero…
          </p>
        ) : noDisponible ? (
          <div data-testid="order-financial-unavailable"
               style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', color: colors.warning }}>
            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <p className="body-sm" style={{ margin: 0 }}>
              No disponible. No pudimos cargar el estado financiero de esta orden; los importes no se muestran
              para no informar un saldo incorrecto.
            </p>
          </div>
        ) : authorized === false ? (
          // Rol sin capacidad financiera: el badge sí, los importes no. No se
          // muestran ceros — el servidor directamente no los envió.
          <p data-testid="order-amounts-restricted" className="body-sm" style={{ margin: 0, color: colors.text.subtle }}>
            Importes restringidos. Tu rol puede ver el estado de cobro, pero no los montos de la orden.
          </p>
        ) : (
          <>
            {fila('Total comprobado', money(data!.total_comprobado))}
            {fila('Cobrado directo', money(data!.cobrado_directo))}
            {data!.imputado_cc > 0 && fila('Imputado desde cuenta corriente', money(data!.imputado_cc))}
            {fila('Saldo pendiente', money(data!.saldo_pendiente), true)}

            <div style={{ height: 1, background: colors.border.subtle, margin: '0.6rem 0' }} />

            {fila('Completada', data!.completed_at
              ? new Date(data!.completed_at).toLocaleString('es-AR', { timeZone: 'America/Argentina/Cordoba' }) : '—')}
            {fila('Cobro completo', data!.paid_at
              ? new Date(data!.paid_at).toLocaleString('es-AR', { timeZone: 'America/Argentina/Cordoba' }) : '—')}
            {fila('Último pago', data!.ultimo_pago
              ? new Date(data!.ultimo_pago).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Cordoba' }) : '—')}

            {data!.comprobante_id && (
              <div style={{ marginTop: '0.75rem' }}>
                <Link to={`/comprobantes/${data!.comprobante_id}`} className="btn btn-sm btn-ghost"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem', textDecoration: 'none' }}>
                  <FileText size={14} /> Ver comprobante {data!.comprobante_numero ?? ''}
                </Link>
              </div>
            )}

            {/* Crédito sin imputar: se informa, no se descuenta. La orden NO
                queda cobrada por tener el cliente saldo a favor. */}
            {credito != null && credito > 0 && (
              <div data-testid="order-unallocated-credit"
                   style={{ marginTop: '0.75rem', padding: '0.6rem 0.75rem', borderRadius: '0.5rem',
                            background: colors.warningBg, border: `1px solid ${colors.warningBorder}` }}>
                <p className="body-sm" style={{ margin: 0, color: colors.text.secondary }}>
                  Este cliente tiene <strong>{money(credito)}</strong> de crédito sin imputar. La asignación a
                  comprobantes estará disponible desde el flujo de cuenta corriente.
                </p>
                {customerId && (
                  <Link to={`/customers/${customerId}`} className="body-sm"
                        style={{ color: colors.text.primary, fontWeight: 600 }}>
                    Ir a la cuenta corriente →
                  </Link>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
