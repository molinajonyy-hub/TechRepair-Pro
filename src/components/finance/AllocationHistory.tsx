/**
 * P0-A.1U2 — Historial de imputaciones, con reversa total o parcial.
 *
 * Se monta en cuenta corriente, comprobante y detalle de orden filtrando por
 * `comprobanteId` o `paymentMovementId`. Los datos y el permiso de reversa
 * llegan del servidor (get_payment_allocations); acá no se decide nada.
 *
 * La reversa NUNCA borra: llama a reverse_payment_allocation_atomic, que cierra
 * la asignación y deja el remanente como una nueva. El estado TÉCNICO de la
 * orden no cambia.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Undo2, Loader2 } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { colors } from '../../lib/tokens'
import { aCentavos, fmtCentavos, parseImporte, mensajeDeError } from '../../lib/allocationMath'

export interface AllocationRow {
  id: string
  amount: number
  status: 'active' | 'reversed'
  created_at: string
  reversed_at: string | null
  reason: string | null
  comprobante_id: string
  comprobante_numero: string | null
  payment_movement_id: string
  order_id: string | null
  reversal_of: string | null
  operador: string | null
}

interface Props {
  businessId: string
  comprobanteId?: string | null
  paymentMovementId?: string | null
  /** Se llama tras una reversa exitosa para que el caller refresque. */
  onReversed?: () => void
}

export function AllocationHistory({ businessId, comprobanteId = null, paymentMovementId = null, onReversed }: Props) {
  const [rows, setRows]       = useState<AllocationRow[]>([])
  const [estado, setEstado]   = useState<'cargando' | 'listo' | 'sin_permiso' | 'error'>('cargando')
  const [puedeRevertir, setPuedeRevertir] = useState(false)
  const [revirtiendo, setRevirtiendo]     = useState<AllocationRow | null>(null)
  const [importe, setImporte] = useState('')
  const [motivo, setMotivo]   = useState('')
  const [aviso, setAviso]     = useState<string | null>(null)
  const keyRef      = useRef<string | null>(null)
  const enviandoRef = useRef(false)

  const cargar = useCallback(async () => {
    setEstado('cargando')
    const { data, error } = await supabase.rpc('get_payment_allocations', {
      p_business_id: businessId,
      p_comprobante_id: comprobanteId,
      p_payment_movement_id: paymentMovementId,
    })
    const r = data as { ok?: boolean; authorized?: boolean; can_reverse?: boolean; rows?: AllocationRow[] } | null
    if (error || r?.ok === false) { setEstado('error'); return }
    if (r?.authorized === false) { setEstado('sin_permiso'); return }
    setRows(r?.rows ?? [])
    setPuedeRevertir(!!r?.can_reverse)
    setEstado('listo')
  }, [businessId, comprobanteId, paymentMovementId])

  useEffect(() => { cargar() }, [cargar])

  const abrirReversa = (row: AllocationRow) => {
    setRevirtiendo(row)
    setImporte(String(row.amount))
    setMotivo('')
    setAviso(null)
    keyRef.current = null
  }

  const confirmarReversa = async () => {
    if (!revirtiendo || enviandoRef.current) return
    const centavos = parseImporte(importe)
    if (centavos <= 0 || centavos > aCentavos(revirtiendo.amount)) {
      setAviso('El importe a revertir debe estar entre 0 y el importe imputado.'); return
    }
    if (!motivo.trim()) { setAviso('El motivo es obligatorio.'); return }

    enviandoRef.current = true
    if (!keyRef.current) keyRef.current = crypto.randomUUID()
    const { data, error } = await supabase.rpc('reverse_payment_allocation_atomic', {
      p_business_id: businessId,
      p_allocation_id: revirtiendo.id,
      p_amount: centavos / 100,
      p_reason: motivo.trim(),
      p_idempotency_key: keyRef.current,
    })
    const r = data as { ok?: boolean; error_code?: string; error?: string } | null
    enviandoRef.current = false

    if (error || r?.ok === false) {
      const { texto, esConflicto } = mensajeDeError(r?.error_code, r?.error ?? error?.message)
      setAviso(texto)
      if (esConflicto) { keyRef.current = null; await cargar() }
      return
    }
    keyRef.current = null
    setRevirtiendo(null)
    await cargar()
    onReversed?.()
  }

  if (estado === 'cargando') {
    return <p className="body-sm" data-testid="allocations-loading" style={{ color: colors.text.subtle }}>
      <Loader2 size={13} style={{ display: 'inline', marginRight: 5 }} /> Cargando imputaciones…
    </p>
  }
  if (estado === 'sin_permiso') return null
  if (estado === 'error') {
    return <p className="body-sm" data-testid="allocations-error" style={{ color: colors.warning }}>
      No disponible. No pudimos cargar el historial de imputaciones.
    </p>
  }
  if (rows.length === 0) {
    return <p className="body-sm" data-testid="allocations-empty" style={{ color: colors.text.subtle }}>
      Sin imputaciones registradas.
    </p>
  }

  return (
    <div data-testid="allocation-history">
      {aviso && !revirtiendo && (
        <p className="body-sm" data-testid="allocations-notice" style={{ color: colors.warning }}>{aviso}</p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        {rows.map(r => (
          <div key={r.id} data-testid={`allocation-row-${r.id}`}
               style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap',
                        padding: '0.55rem 0.7rem', borderRadius: '0.5rem',
                        border: `1px solid ${colors.border.subtle}`,
                        opacity: r.status === 'reversed' ? 0.6 : 1 }}>
            <div style={{ flex: 1, minWidth: 170 }}>
              <div style={{ fontSize: '0.84rem', fontWeight: 600, color: colors.text.primary }}>
                {fmtCentavos(aCentavos(r.amount))}
                {' · '}{r.comprobante_numero ?? r.comprobante_id.slice(0, 8)}
                {r.order_id && ' · orden #' + r.order_id.slice(0, 8)}
              </div>
              <div className="body-sm" style={{ fontSize: '0.7rem', color: colors.text.subtle }}>
                {new Date(r.created_at).toLocaleString('es-AR', { timeZone: 'America/Argentina/Cordoba' })}
                {r.operador && ' · ' + r.operador}
                {r.reversal_of && ' · reversa'}
              </div>
            </div>
            <span data-testid={`allocation-status-${r.id}`} className="badge"
                  style={{ fontSize: '0.66rem', fontWeight: 700, padding: '0.1rem 0.45rem', borderRadius: '9999px',
                           color: r.status === 'active' ? colors.orderBadge.paid : colors.orderBadge.neutral,
                           background: r.status === 'active' ? colors.successBg : 'transparent',
                           border: `1px solid ${r.status === 'active' ? colors.successBorder : colors.border.subtle}` }}>
              {r.status === 'active' ? 'Activa' : 'Revertida'}
            </span>
            {puedeRevertir && r.status === 'active' && (
              <button data-testid={`allocation-reverse-${r.id}`} className="btn btn-ghost btn-sm"
                      onClick={() => abrirReversa(r)}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                <Undo2 size={13} /> Revertir
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Confirmación de reversa */}
      {revirtiendo && createPortal(
        <div data-testid="reversal-dialog" role="dialog" aria-label="Revertir imputación"
             style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.6)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}
             onClick={e => { if (e.target === e.currentTarget) setRevirtiendo(null) }}>
          <div style={{ background: colors.bg.surface, borderRadius: '0.85rem', padding: '1.25rem',
                        width: '100%', maxWidth: 420, border: `1px solid ${colors.border.subtle}` }}>
            <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem', color: colors.text.primary }}>
              Revertir imputación
            </h3>
            <p className="body-sm" style={{ color: colors.text.subtle, marginTop: 0 }}>
              Se imputaron {fmtCentavos(aCentavos(revirtiendo.amount))} al comprobante{' '}
              {revirtiendo.comprobante_numero ?? ''}. El importe que revertís vuelve a quedar como
              crédito disponible del cliente.
            </p>
            <label className="body-sm" style={{ display: 'block', marginBottom: '0.25rem', color: colors.text.subtle }}>
              Importe a revertir
            </label>
            <input data-testid="reversal-amount" className="form-control" inputMode="decimal"
                   value={importe} onChange={e => setImporte(e.target.value)}
                   aria-label="Importe a revertir" style={{ width: '100%', marginBottom: '0.6rem' }} />
            <label className="body-sm" style={{ display: 'block', marginBottom: '0.25rem', color: colors.text.subtle }}>
              Motivo (obligatorio)
            </label>
            <input data-testid="reversal-reason" className="form-control"
                   value={motivo} onChange={e => setMotivo(e.target.value)}
                   aria-label="Motivo de la reversa" style={{ width: '100%' }} />
            <p className="body-sm" data-testid="reversal-credit-back" style={{ color: colors.text.subtle, marginBottom: 0 }}>
              Volverá a quedar disponible: {fmtCentavos(parseImporte(importe))}
            </p>
            {aviso && <p className="body-sm" data-testid="reversal-notice" style={{ color: colors.warning }}>{aviso}</p>}
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.85rem' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setRevirtiendo(null)}>Cancelar</button>
              <button data-testid="reversal-confirm" className="btn btn-primary btn-sm" onClick={confirmarReversa}>
                Confirmar reversa
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
