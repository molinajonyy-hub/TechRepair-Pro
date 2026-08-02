/**
 * P0-A.1U1 — Resumen financiero de la orden, SOLO LECTURA.
 *
 * Todos los importes y el estado vienen del servidor. Este componente no suma,
 * no resta y no decide nada.
 *
 * Hay DOS ejes independientes, y confundirlos fue un bug real:
 *
 *   1. El ESTADO de cobro (`v_order_payment_state`) — sin importes, visible
 *      para cualquier rol del negocio.
 *   2. Los IMPORTES (`get_order_financial_amounts`) — requieren capacidad.
 *
 * El estado puede cargar bien y los importes fallar. Por eso los importes
 * tienen su propia fase explícita (`FaseImportes`) en vez de un `boolean | null`
 * que significaba a la vez "cargando", "sin permiso" y "falló": con esa
 * ambigüedad el componente caía en la rama de éxito con datos sin montos y
 * renderizaba `$NaN`.
 *
 * Ninguna fase de error se convierte nunca en `$0`, en "Cobrado" ni en los
 * importes de la orden anterior.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { FileText, AlertCircle, Wallet } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { logger } from '../../lib/logger'
import { colors } from '../../lib/tokens'
import { OrderFinancialBadge } from './OrderFinancialBadge'
import { AllocationModal } from '../finance/AllocationModal'
import { AllocationHistory } from '../finance/AllocationHistory'
import type { OrderFinancialStatus } from '../../hooks/useOrders'

interface Props {
  orderId: string
  /** Opcional: si no se pasa, se toma del contexto de autenticación. */
  businessId?: string | null
  /** Cliente de la orden, para el enlace a su cuenta corriente. */
  customerId?: string | null
}

/** Fase del bloque de importes. Cada valor tiene UN solo significado. */
type FaseImportes =
  | 'loading'      // la respuesta todavía no llegó
  | 'available'    // llegaron importes completos y verificados
  | 'restricted'   // el servidor decidió que este rol no los ve
  | 'unavailable'  // error HTTP, de red, ok:false o payload inservible

/** Fase del estado de cobro, que es lo que alimenta el badge. */
type FaseEstado = 'loading' | 'ok' | 'unavailable'

interface RespuestaImportes {
  ok?: boolean
  authorized?: boolean
  rows?: OrderFinancialStatus[]
}

/** Campos sin los cuales el bloque de importes no se puede pintar. */
const CAMPOS_MONETARIOS = ['total_comprobado', 'cobrado_directo', 'saldo_pendiente'] as const

/**
 * Un payload incompleto es tan inservible como un error: si falta cualquier
 * importe, la fila entera se descarta. `Number(null)` es 0 y `Number('')` es 0,
 * así que el chequeo excluye vacíos ANTES de convertir — si no, un campo
 * ausente pasaría por "cero" y mentiría.
 */
const importesUtilizables = (fila: unknown): fila is OrderFinancialStatus => {
  if (!fila || typeof fila !== 'object') return false
  const r = fila as Record<string, unknown>
  return CAMPOS_MONETARIOS.every(k => {
    const v = r[k]
    return v != null && v !== '' && Number.isFinite(Number(v))
  })
}

/**
 * Formateo monetario con red de seguridad. La protección principal es la fase
 * explícita: acá no debería llegar nunca un valor no finito. Si llega, es un
 * defecto — se muestra un guion y se deja señal, nunca `$NaN`, `$Infinity` ni
 * un `$0` que aparentaría un saldo saldado.
 */
const money = (n: unknown): string => {
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v)) {
    logger.error('FINANCE', 'OrderFinancialSummary: importe no finito en la rama de éxito; se muestra placeholder')
    return '—'
  }
  return '$' + Math.round(v).toLocaleString('es-AR')
}

const Skeleton = ({ ancho }: { ancho: string }) => (
  <div aria-hidden="true" style={{
    height: 12, width: ancho, borderRadius: 6, background: colors.bg.card, margin: '0.45rem 0',
  }} />
)

export function OrderFinancialSummary({ orderId, businessId: bizProp, customerId }: Props) {
  const { businessId: bizCtx } = useAuth()
  const businessId = bizProp ?? bizCtx

  const [faseEstado, setFaseEstado]     = useState<FaseEstado>('loading')
  const [estado, setEstado]             = useState<OrderFinancialStatus | null>(null)
  const [faseImportes, setFaseImportes] = useState<FaseImportes>('loading')
  const [montos, setMontos]             = useState<OrderFinancialStatus | null>(null)
  const [credito, setCredito]           = useState<number | null>(null)
  const [imputando, setImputando]       = useState(false)
  /** Fuerza una recarga tras imputar o revertir. */
  const [version, setVersion] = useState(0)
  const recargar = useCallback(() => setVersion(v => v + 1), [])

  /**
   * Secuencia de la petición en curso. Una respuesta vieja que llega tarde
   * —porque cambió `orderId` mientras estaba en vuelo— ya no coincide y se
   * descarta: no puede pisar el estado de la orden nueva.
   */
  const pedidoRef = useRef(0)

  useEffect(() => {
    const miPedido = ++pedidoRef.current
    const vigente = () => pedidoRef.current === miPedido

    // Cambió la orden: se descarta TODO lo anterior antes de pedir nada. Ningún
    // importe de la orden previa puede sobrevivir al cambio.
    setFaseEstado('loading'); setEstado(null)
    setFaseImportes('loading'); setMontos(null); setCredito(null)

    const cargar = async () => {
      if (!businessId) return

      // 1) Estado sin importes: accesible para cualquier rol del negocio.
      const { data: row, error } = await supabase
        .from('v_order_payment_state')
        .select('order_id, payment_status, comprobantes_vigentes, comprobante_id, comprobante_numero')
        .eq('business_id', businessId)
        .eq('order_id', orderId)
        .maybeSingle()
      if (!vigente()) return
      if (error || !row) {
        // Sin estado no hay nada que mostrar: ni badge ni importes.
        setFaseEstado('unavailable'); setFaseImportes('unavailable')
        return
      }
      const base = row as unknown as OrderFinancialStatus
      setEstado(base); setFaseEstado('ok')

      // 2) Importes: el servidor decide si corresponden. Los tres desenlaces
      //    —falló, sin permiso, llegó— son estados distintos y se distinguen.
      const { data: amt, error: amtErr } = await supabase.rpc('get_order_financial_amounts', {
        p_business_id: businessId, p_order_ids: [orderId],
      })
      if (!vigente()) return
      const res = amt as RespuestaImportes | null

      if (amtErr || !res || res.ok === false) {
        // Error HTTP, de red o de la RPC. NO es falta de permiso.
        setFaseImportes('unavailable')
        return
      }
      if (res.authorized === false) {
        setFaseImportes('restricted')
        return
      }
      const fila = res.rows?.[0]
      if (!importesUtilizables(fila)) {
        setFaseImportes('unavailable')
        return
      }
      setMontos({ ...base, ...fila })
      setFaseImportes('available')

      // 3) Crédito del cliente sin imputar: también es un importe.
      if (customerId) {
        const { data: cr, error: crErr } = await supabase.rpc('get_customer_unallocated_credit', {
          p_business_id: businessId, p_customer_id: customerId,
        })
        if (!vigente()) return
        const cres = cr as { ok?: boolean; authorized?: boolean; unallocated_amount?: number } | null
        if (!crErr && cres?.authorized) {
          const monto = Number(cres.unallocated_amount)
          setCredito(Number.isFinite(monto) ? monto : null)
        }
      }
    }

    cargar()
    // El contador ya invalida las respuestas viejas; esto sólo evita trabajo.
    return () => { pedidoRef.current++ }
  }, [orderId, businessId, customerId, version])

  const fila = (label: string, valor: string, destacar = false) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', padding: '0.3rem 0' }}>
      <span className="body-sm" style={{ color: colors.text.subtle }}>{label}</span>
      <span style={{ fontWeight: destacar ? 700 : 600, color: destacar ? colors.text.primary : colors.text.secondary,
                     fontVariantNumeric: 'tabular-nums' }}>{valor}</span>
    </div>
  )

  const cuerpo = () => {
    // D — loading: ni estado ni importes. Un cero provisorio se lee como "no
    // debe nada" y sería mentira.
    if (faseEstado === 'loading') {
      return (
        <div data-testid="order-financial-loading" aria-busy="true">
          <p className="body-sm" style={{ color: colors.text.subtle, margin: '0 0 0.3rem' }}>
            Cargando estado financiero…
          </p>
          <Skeleton ancho="70%" /><Skeleton ancho="55%" /><Skeleton ancho="40%" />
        </div>
      )
    }

    // El estado mismo no cargó: no hay badge real ni importes.
    if (faseEstado === 'unavailable') {
      return (
        <div data-testid="order-financial-unavailable"
             style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', color: colors.warning }}>
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <p className="body-sm" style={{ margin: 0 }}>
            No disponible. No pudimos cargar el estado financiero de esta orden; los importes no se muestran
            para no informar un saldo incorrecto.
          </p>
        </div>
      )
    }

    // El estado sí cargó; el badge ya se está mostrando arriba.
    if (faseImportes === 'loading') {
      return (
        <div data-testid="order-amounts-loading" aria-busy="true">
          <Skeleton ancho="70%" /><Skeleton ancho="55%" /><Skeleton ancho="40%" />
        </div>
      )
    }

    // B — restringido: es una decisión de permisos, no una falla.
    if (faseImportes === 'restricted') {
      return (
        <p data-testid="order-amounts-restricted" className="body-sm" style={{ margin: 0, color: colors.text.subtle }}>
          Importes restringidos. Tu rol puede ver el estado de cobro, pero no los montos de la orden.
        </p>
      )
    }

    // C — indisponible: el badge queda, los importes no. Mensaje sanitizado:
    // nada de códigos, SQL ni detalles del transporte.
    if (faseImportes === 'unavailable' || !montos) {
      return (
        <div data-testid="order-amounts-unavailable"
             style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', color: colors.warning }}>
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <p className="body-sm" style={{ margin: 0 }}>
            No disponible. No pudimos cargar los importes de esta orden. Reintentá en unos segundos.
          </p>
        </div>
      )
    }

    // A — disponible.
    return (
      <>
        {fila('Total comprobado', money(montos.total_comprobado))}
        {fila('Cobrado directo', money(montos.cobrado_directo))}
        {montos.imputado_cc > 0 && fila('Imputado desde cuenta corriente', money(montos.imputado_cc))}
        {fila('Saldo pendiente', money(montos.saldo_pendiente), true)}

        <div style={{ height: 1, background: colors.border.subtle, margin: '0.6rem 0' }} />

        {fila('Completada', montos.completed_at
          ? new Date(montos.completed_at).toLocaleString('es-AR', { timeZone: 'America/Argentina/Cordoba' }) : '—')}
        {fila('Cobro completo', montos.paid_at
          ? new Date(montos.paid_at).toLocaleString('es-AR', { timeZone: 'America/Argentina/Cordoba' }) : '—')}
        {fila('Último pago', montos.ultimo_pago
          ? new Date(montos.ultimo_pago).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Cordoba' }) : '—')}

        {montos.comprobante_id && (
          <div style={{ marginTop: '0.75rem' }}>
            <Link to={`/comprobantes/${montos.comprobante_id}`} className="btn btn-sm btn-ghost"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem', textDecoration: 'none' }}>
              <FileText size={14} /> Ver comprobante {montos.comprobante_numero ?? ''}
            </Link>
          </div>
        )}

        {/* Crédito sin imputar: se informa, no se descuenta. La orden NO queda
            cobrada por tener el cliente saldo a favor: hay que imputarlo. */}
        {credito != null && credito > 0 && (
          <div data-testid="order-unallocated-credit"
               style={{ marginTop: '0.75rem', padding: '0.6rem 0.75rem', borderRadius: '0.5rem',
                        background: colors.warningBg, border: `1px solid ${colors.warningBorder}` }}>
            <p className="body-sm" style={{ margin: 0, color: colors.text.secondary }}>
              Este cliente tiene <strong>{money(credito)}</strong> de crédito sin imputar.
            </p>
            {customerId && montos.saldo_pendiente > 0 && (
              <button data-testid="order-allocate-button" className="btn btn-primary btn-sm"
                      style={{ marginTop: '0.5rem' }} onClick={() => setImputando(true)}>
                Imputar crédito
              </button>
            )}
          </div>
        )}

        {/* Historial de imputaciones de este comprobante. */}
        {montos.comprobante_id && businessId && (
          <div style={{ marginTop: '1rem' }}>
            <h4 className="body-sm" style={{ margin: '0 0 0.4rem', fontWeight: 700, color: colors.text.subtle }}>
              Imputaciones
            </h4>
            <AllocationHistory
              businessId={businessId}
              comprobanteId={montos.comprobante_id}
              onReversed={recargar}
            />
          </div>
        )}
      </>
    )
  }

  return (
    <div className="card" data-testid="order-financial-summary">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
        <h3 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Wallet size={18} /> Estado financiero
        </h3>
        {/* El badge depende del ESTADO, no de los importes: que los montos
            fallen no borra lo que sí sabemos del cobro. */}
        {faseEstado !== 'loading' && (
          <OrderFinancialBadge
            status={faseEstado === 'ok' ? (estado?.payment_status ?? null) : null}
            unavailable={faseEstado === 'unavailable'}
          />
        )}
      </div>
      <div className="card-body">{cuerpo()}</div>

      {/* Punto de entrada C: imputar crédito desde la orden. */}
      {imputando && businessId && customerId && (
        <AllocationModal
          isOpen={imputando}
          businessId={businessId}
          customerId={customerId}
          comprobanteId={montos?.comprobante_id ?? null}
          onClose={() => setImputando(false)}
          onAllocated={recargar}
        />
      )}
    </div>
  )
}
