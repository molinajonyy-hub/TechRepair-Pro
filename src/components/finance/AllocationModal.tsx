/**
 * P0-A.1U2 — Modal ÚNICO de imputación de cobros de cuenta corriente.
 *
 * Se usa desde los tres puntos de entrada (cuenta corriente, comprobante y
 * orden) para que no existan tres implementaciones que puedan divergir.
 *
 * INVARIANTES:
 *  · La imputación NO crea un pago: distribuye el efecto de uno ya existente.
 *  · Nada se calcula acá salvo la aritmética del reparto que el operador tipea,
 *    y esa va en centavos enteros (src/lib/allocationMath.ts).
 *  · Los importes disponibles, los saldos y los permisos llegan del servidor
 *    (get_allocation_workspace). La RPC sigue siendo la autoridad.
 *  · Nunca hay FIFO, prorrateo ni selección inferida: el operador elige.
 *  · Ante conflicto NO se reintenta: se refresca y se pide confirmar de nuevo.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, AlertTriangle, Loader2, Info } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { colors } from '../../lib/tokens'
import {
  aCentavos, fmtCentavos, parseImporte, validarReparto, saldoEsperado, mensajeDeError,
  type CreditoDisponible, type DocumentoAbierto, type Reparto,
} from '../../lib/allocationMath'

interface Props {
  isOpen: boolean
  businessId: string
  customerId: string
  customerName?: string
  /** Cobro preseleccionado (entrada desde cuenta corriente). */
  paymentMovementId?: string | null
  /** Documento preseleccionado (entrada desde comprobante u orden). */
  comprobanteId?: string | null
  onClose: () => void
  /** Se llama tras una imputación exitosa, para que el caller refresque. */
  onAllocated: () => void
}

type Fase = 'cargando' | 'listo' | 'confirmando' | 'enviando' | 'sin_permiso' | 'error'

export function AllocationModal({
  isOpen, businessId, customerId, customerName,
  paymentMovementId = null, comprobanteId = null, onClose, onAllocated,
}: Props) {
  const [fase, setFase]         = useState<Fase>('cargando')
  const [creditos, setCreditos] = useState<CreditoDisponible[]>([])
  const [docs, setDocs]         = useState<DocumentoAbierto[]>([])
  const [pagoId, setPagoId]     = useState<string | null>(paymentMovementId)
  const [reparto, setReparto]   = useState<Reparto>({})
  const [aviso, setAviso]       = useState<string | null>(null)
  const [puedeImputar, setPuedeImputar] = useState(false)
  // Key durable por INTENCIÓN: un reintento del mismo reparto es replay, no una
  // segunda imputación. Se descarta al cerrar o tras el éxito.
  const keyRef      = useRef<string | null>(null)
  const enviandoRef = useRef(false)

  const cargar = useCallback(async () => {
    setFase('cargando'); setAviso(null)
    const { data, error } = await supabase.rpc('get_allocation_workspace', {
      p_business_id: businessId, p_customer_id: customerId,
    })
    const r = data as {
      ok?: boolean; authorized?: boolean; can_allocate?: boolean
      credits?: CreditoDisponible[]; documents?: DocumentoAbierto[]
    } | null
    if (error || r?.ok === false) { setFase('error'); return }
    if (r?.authorized === false) { setFase('sin_permiso'); return }

    setCreditos(r?.credits ?? [])
    setDocs(r?.documents ?? [])
    setPuedeImputar(!!r?.can_allocate)
    setPagoId(prev => prev ?? (r?.credits?.[0]?.payment_movement_id ?? null))
    setFase('listo')
  }, [businessId, customerId])

  useEffect(() => {
    if (!isOpen) return
    setReparto({}); keyRef.current = null; enviandoRef.current = false
    setPagoId(paymentMovementId)
    cargar()
  }, [isOpen, cargar, paymentMovementId])

  const pago = useMemo(
    () => creditos.find(c => c.payment_movement_id === pagoId) ?? null,
    [creditos, pagoId],
  )
  const disponible = pago ? aCentavos(pago.unallocated_amount) : 0
  const validacion = useMemo(
    () => validarReparto(reparto, disponible, docs),
    [reparto, disponible, docs],
  )

  // El documento que originó la entrada se muestra primero, pero NO se
  // preselecciona con un importe: elegir el monto es del operador.
  const docsOrdenados = useMemo(() => {
    if (!comprobanteId) return docs
    return [...docs].sort((a, b) =>
      a.comprobante_id === comprobanteId ? -1 : b.comprobante_id === comprobanteId ? 1 : 0)
  }, [docs, comprobanteId])

  const setImporte = (id: string, texto: string) =>
    setReparto(prev => ({ ...prev, [id]: parseImporte(texto) }))

  const confirmar = async () => {
    if (enviandoRef.current || !pago || validacion.bloqueo) return
    enviandoRef.current = true
    setFase('enviando'); setAviso(null)

    if (!keyRef.current) keyRef.current = crypto.randomUUID()
    const items = Object.entries(reparto)
      .filter(([, c]) => c > 0)
      .map(([comprobante_id, c]) => ({ comprobante_id, amount: c / 100 }))

    const { data, error } = await supabase.rpc('allocate_account_payment_atomic', {
      p_business_id: businessId,
      p_payment_movement_id: pago.payment_movement_id,
      p_allocations: items,
      p_reason: 'Imputación desde la interfaz',
      p_idempotency_key: keyRef.current,
    })
    const r = data as { ok?: boolean; error_code?: string; error?: string } | null

    if (error || r?.ok === false) {
      const { texto, esConflicto } = mensajeDeError(r?.error_code, r?.error ?? error?.message)
      enviandoRef.current = false
      if (esConflicto) {
        // Se descarta la key: los importes cambiaron, así que la próxima
        // confirmación es una intención NUEVA. Nunca se reintenta solo.
        keyRef.current = null
        setReparto({})
        // El aviso se setea DESPUÉS de recargar: `cargar()` limpia el aviso al
        // empezar, así que ponerlo antes lo borraba y el conflicto pasaba mudo.
        await cargar()
        setAviso(texto)
      } else {
        setAviso(texto)
        setFase('listo')
      }
      return
    }

    keyRef.current = null
    enviandoRef.current = false
    onAllocated()
    onClose()
  }

  if (!isOpen) return null

  const overlay: React.CSSProperties = {
    position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.6)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem',
  }
  const panel: React.CSSProperties = {
    background: colors.bg.surface, border: `1px solid ${colors.border.subtle}`,
    borderRadius: '1rem', width: '100%', maxWidth: 640, maxHeight: '90vh',
    overflowY: 'auto', boxShadow: 'var(--pos-shadow-pop, 0 24px 48px rgba(0,0,0,0.4))',
  }

  // El modal va en un PORTAL a document.body. Sin esto queda dentro del layout
  // del caller y, si algún ancestro tiene transform/filter/contain, ese ancestro
  // pasa a ser el bloque contenedor de `position: fixed`: en mobile el overlay
  // medía 95 px en vez de 375 y el panel aparecía encajonado en una columna.
  // Detectado en el recorrido visual, no en los tests.
  return createPortal(
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={panel} role="dialog" aria-modal="true" aria-label="Imputar cobro"
           data-testid="allocation-modal">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '1rem 1.25rem', borderBottom: `1px solid ${colors.border.subtle}` }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: colors.text.primary }}>
              Imputar cobro
            </h2>
            {customerName && (
              <p style={{ margin: '0.15rem 0 0', fontSize: '0.78rem', color: colors.text.subtle }}>
                {customerName}
              </p>
            )}
          </div>
          <button onClick={onClose} aria-label="Cerrar" className="icon-btn"><X size={16} /></button>
        </div>

        <div style={{ padding: '1.25rem' }}>
          {fase === 'cargando' && (
            <p data-testid="allocation-loading" className="body-sm" style={{ color: colors.text.subtle }}>
              <Loader2 size={14} style={{ display: 'inline', marginRight: 6 }} /> Cargando crédito disponible…
            </p>
          )}

          {fase === 'sin_permiso' && (
            <p data-testid="allocation-restricted" className="body-sm" style={{ color: colors.text.subtle }}>
              Importes restringidos. Tu rol no tiene acceso a los cobros de este cliente.
            </p>
          )}

          {fase === 'error' && (
            <p data-testid="allocation-error" className="body-sm" style={{ color: colors.warning }}>
              No disponible. No pudimos cargar el crédito del cliente; no se muestran importes para no
              informar un saldo incorrecto.
            </p>
          )}

          {(fase === 'listo' || fase === 'confirmando' || fase === 'enviando') && (
            <>
              {aviso && (
                <div data-testid="allocation-notice"
                     style={{ display: 'flex', gap: '0.5rem', padding: '0.7rem 0.85rem', marginBottom: '1rem',
                              borderRadius: '0.5rem', background: colors.warningBg,
                              border: `1px solid ${colors.warningBorder}` }}>
                  <AlertTriangle size={16} style={{ flexShrink: 0, color: colors.warning }} />
                  <span className="body-sm" style={{ color: colors.text.secondary }}>{aviso}</span>
                </div>
              )}

              {creditos.length === 0 ? (
                <p data-testid="allocation-no-credit" className="body-sm" style={{ color: colors.text.subtle }}>
                  Este cliente no tiene cobros con crédito sin imputar.
                </p>
              ) : (
                <>
                  {/* ── Cobro ── */}
                  <label className="body-sm" style={{ display: 'block', marginBottom: '0.3rem', color: colors.text.subtle }}>
                    Cobro a imputar
                  </label>
                  <select
                    data-testid="allocation-payment-select"
                    className="form-select"
                    value={pagoId ?? ''}
                    onChange={e => { setPagoId(e.target.value); setReparto({}); keyRef.current = null }}
                    style={{ width: '100%', marginBottom: '0.85rem' }}
                  >
                    {creditos.map(c => (
                      <option key={c.payment_movement_id} value={c.payment_movement_id}>
                        {new Date(c.payment_date).toLocaleDateString('es-AR')} ·
                        {' '}cobro {fmtCentavos(aCentavos(c.payment_amount))} ·
                        {' '}disponible {fmtCentavos(aCentavos(c.unallocated_amount))}
                      </option>
                    ))}
                  </select>

                  {pago && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem',
                                  marginBottom: '1rem' }}>
                      {[
                        ['Importe del cobro', aCentavos(pago.payment_amount)],
                        ['Ya imputado', aCentavos(pago.allocated_amount)],
                        ['Disponible', disponible],
                      ].map(([label, val]) => (
                        <div key={label as string} style={{ padding: '0.55rem 0.65rem', borderRadius: '0.5rem',
                                     background: colors.bg.card }}>
                          {/* secondary, no subtle: sobre bg.card en light, --text-tertiary da 4.42. */}
                          <div className="body-sm" style={{ fontSize: '0.68rem', color: colors.text.secondary }}>{label}</div>
                          <div style={{ fontWeight: 700, color: colors.text.primary, fontVariantNumeric: 'tabular-nums' }}>
                            {fmtCentavos(val as number)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* ── Documentos ── */}
                  <label className="body-sm" style={{ display: 'block', marginBottom: '0.3rem', color: colors.text.subtle }}>
                    Comprobantes con saldo
                  </label>
                  {docsOrdenados.length === 0 ? (
                    <p data-testid="allocation-no-docs" className="body-sm" style={{ color: colors.text.subtle }}>
                      Este cliente no tiene comprobantes con saldo pendiente.
                    </p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      {docsOrdenados.map(d => {
                        const asignado = reparto[d.comprobante_id] ?? 0
                        const excedido = validacion.excedidos.includes(d.comprobante_id)
                        return (
                          <div key={d.comprobante_id} data-testid={`allocation-doc-${d.comprobante_id}`}
                               style={{ display: 'flex', gap: '0.65rem', alignItems: 'center', flexWrap: 'wrap',
                                        padding: '0.6rem 0.7rem', borderRadius: '0.5rem',
                                        border: `1px solid ${excedido ? colors.errorBorder : colors.border.subtle}`,
                                        background: excedido ? colors.errorBg : 'transparent' }}>
                            <div style={{ flex: 1, minWidth: 150 }}>
                              <div style={{ fontWeight: 600, color: colors.text.primary, fontSize: '0.85rem' }}>
                                {d.numero ?? d.comprobante_id.slice(0, 8)}
                              </div>
                              <div className="body-sm" style={{ fontSize: '0.7rem', color: colors.text.subtle }}>
                                Total {fmtCentavos(aCentavos(d.total))} · Saldo {fmtCentavos(aCentavos(d.saldo_imputable))}
                                {d.order_id && ' · orden #' + d.order_id.slice(0, 8)}
                              </div>
                            </div>
                            <input
                              data-testid={`allocation-input-${d.comprobante_id}`}
                              aria-label={`Importe a imputar al comprobante ${d.numero ?? ''}`}
                              className="form-control"
                              inputMode="decimal"
                              placeholder="0"
                              onChange={e => setImporte(d.comprobante_id, e.target.value)}
                              style={{ width: 130, textAlign: 'right' }}
                            />
                            {asignado > 0 && (
                              <div className="body-sm" data-testid={`allocation-after-${d.comprobante_id}`}
                                   style={{ fontSize: '0.68rem', color: colors.text.subtle, width: '100%' }}>
                                Saldo después: {fmtCentavos(saldoEsperado(d, reparto))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* ── Resumen ── */}
                  <div style={{ marginTop: '1rem', padding: '0.75rem 0.85rem', borderRadius: '0.5rem',
                                background: colors.bg.card }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span className="body-sm" style={{ color: colors.text.secondary }}>Total a imputar</span>
                      <strong data-testid="allocation-total" style={{ color: colors.text.primary }}>
                        {fmtCentavos(validacion.totalAsignado)}
                      </strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.25rem' }}>
                      <span className="body-sm" style={{ color: colors.text.secondary }}>Quedará sin imputar</span>
                      <strong data-testid="allocation-remainder" style={{ color: colors.text.secondary }}>
                        {fmtCentavos(validacion.remanente)}
                      </strong>
                    </div>
                  </div>

                  <p className="body-sm" data-testid="allocation-disclaimer"
                     style={{ marginTop: '0.75rem', display: 'flex', gap: '0.4rem', color: colors.text.subtle }}>
                    <Info size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                    Esta acción asignará un cobro existente a los comprobantes seleccionados. No registrará
                    un nuevo ingreso.
                  </p>

                  {validacion.bloqueo && (
                    <p data-testid="allocation-blocked" className="body-sm"
                       style={{ marginTop: '0.5rem', color: colors.error }}>
                      {validacion.bloqueo}
                    </p>
                  )}

                  <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
                    <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancelar</button>
                    <button
                      data-testid="allocation-confirm"
                      className="btn btn-primary btn-sm"
                      disabled={!puedeImputar || !!validacion.bloqueo || fase === 'enviando'}
                      onClick={confirmar}
                    >
                      {fase === 'enviando' ? 'Imputando…' : 'Confirmar imputación'}
                    </button>
                  </div>

                  {!puedeImputar && (
                    <p data-testid="allocation-no-permission" className="body-sm"
                       style={{ marginTop: '0.5rem', color: colors.text.subtle }}>
                      Tu rol puede ver los importes pero no imputar cobros.
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
