/**
 * InlineCashOpenDialog — abrir la caja sin salir del checkout (BETA-UX-1B).
 *
 * El POS exige una caja abierta para registrar un cobro. Hasta este lote lo
 * decía recién al tocar «Cobrar» y no ofrecía salida: había que cerrar la
 * venta, ir a Caja, abrirla y volver a armar todo. Este diálogo abre la caja
 * encima del checkout y devuelve al usuario al mismo lugar.
 *
 * LÍMITES — lo que este componente NO hace:
 *   · No cobra. Abrir la caja es un prerequisito; el cobro sigue necesitando
 *     que el usuario toque «Cobrar».
 *   · No decide permisos. Sin `canUseCaja` no se renderiza y no llama a nada;
 *     y si igual llegara un pedido, el servidor lo rechaza (`FORBIDDEN`).
 *   · No calcula saldos ni escribe en `cajas`: manda los cuatro saldos
 *     iniciales a `open_cash_session_atomic`, que es quien abre.
 *   · No navega. La pantalla Caja sigue siendo la superficie de gestión; acá
 *     sólo se resuelve el prerequisito del cobro.
 *
 * Montaje: debe ir DENTRO de `.cpm-root`. Sus estilos usan los tokens
 * `--pos-*`, que sólo existen bajo esa raíz (ver `index.css`).
 */
import { useEffect, useId, useRef, useState } from 'react'
import {
  AlertCircle, ArrowRightLeft, Banknote, CreditCard, DollarSign, Loader2, Unlock, X,
  type LucideIcon,
} from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useCaja } from '../../contexts/CajaContext'
import { financeErrorMessage } from '../../lib/financeErrors'
import { logger } from '../../lib/logger'
import { resolvePurchaseKey } from '../../utils/purchaseIdempotency'
import {
  cashSessionService, CAJA_OPEN_METHODS, type CajaOpenMethod,
} from '../../services/cashSessionService'

export interface InlineCashOpenDialogProps {
  isOpen: boolean
  /** Cotización USD→ARS que el POS ya tiene cargada. */
  exchangeRate: number
  onClose: () => void
  /**
   * La caja quedó abierta y el checkout puede seguir.
   * `alreadyOpen`: no la abrió este diálogo — otro usuario o pestaña llegó
   * antes, así que los saldos que se tipearon acá NO se aplicaron.
   */
  onOpened: (result: { alreadyOpen: boolean }) => void
}

const EMPTY_FORM: Record<CajaOpenMethod, string> = {
  efectivo: '', transferencia: '', tarjeta: '', usd: '',
}

const FIELDS: Record<CajaOpenMethod, { label: string; prefix: string; icon: LucideIcon }> = {
  efectivo:      { label: 'Efectivo',      prefix: '$',   icon: Banknote },
  transferencia: { label: 'Transferencia', prefix: '$',   icon: ArrowRightLeft },
  tarjeta:       { label: 'Tarjeta',       prefix: '$',   icon: CreditCard },
  usd:           { label: 'USD',           prefix: 'US$', icon: DollarSign },
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Inline a propósito: el reset global de inputs (`index.css`, «FORMULARIOS»)
// gana por especificidad a cualquier clase. Mismo recurso que el resto del POS.
const INPUT_STYLE: React.CSSProperties = {
  background: 'var(--pos-faint-bg)',
  border: '1px solid var(--pos-border)',
  boxShadow: 'none',
}

export function InlineCashOpenDialog({ isOpen, exchangeRate, onClose, onOpened }: InlineCashOpenDialogProps) {
  const { businessId, user } = useAuth()
  const { canUseCaja, refresh } = useCaja()

  const [form, setForm] = useState<Record<CajaOpenMethod, string>>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Idempotencia: la key se conserva mientras no cambien los montos (doble
  // toque, reintento tras un timeout) y se renueva si cambian. Mismo criterio
  // que la apertura desde Caja.
  const keyRef = useRef<string | null>(null)
  const hashRef = useRef<string | null>(null)
  const submittingRef = useRef(false)

  const dialogRef = useRef<HTMLDivElement>(null)
  const firstInputRef = useRef<HTMLInputElement>(null)
  const baseId = useId()
  const titleId = `${baseId}-title`
  const descId = `${baseId}-desc`
  const rateId = `${baseId}-rate`

  // El padre pasa `onClose` inline: por ref, para que los efectos dependan sólo
  // de `isOpen` y no se re-ejecuten (y muevan el foco) en cada render.
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  const visible = isOpen && canUseCaja

  // Cada apertura del diálogo es un intento nuevo: formulario y key en blanco.
  useEffect(() => {
    if (!visible) return
    setForm(EMPTY_FORM)
    setError(null)
    setSubmitting(false)
    submittingRef.current = false
    keyRef.current = null
    hashRef.current = null
  }, [visible])

  // Foco al abrir y devolución al cerrar.
  useEffect(() => {
    if (!visible) return
    const opener = document.activeElement as HTMLElement | null
    const raf = window.requestAnimationFrame(() => {
      // Con puntero fino (teclado físico) conviene caer en el primer monto. En
      // táctil eso levantaría el teclado y taparía medio diálogo antes de que
      // el usuario lo haya leído: ahí el foco va al contenedor.
      const finePointer = window.matchMedia?.('(pointer: fine)').matches
      if (finePointer) firstInputRef.current?.focus()
      else dialogRef.current?.focus()
    })
    return () => {
      window.cancelAnimationFrame(raf)
      if (opener?.isConnected) opener.focus()
    }
  }, [visible])

  // Escape y trampa de foco. En captura: el POS tiene sus propios atajos sobre
  // `document` (Escape cierra la venta, F4 cobra) y este diálogo va primero.
  useEffect(() => {
    if (!visible) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (!submittingRef.current) onCloseRef.current()
        return
      }
      if (e.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (focusable.length === 0) { e.preventDefault(); dialogRef.current.focus(); return }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      const outside = !dialogRef.current.contains(active) || active === dialogRef.current
      if (e.shiftKey && (active === first || outside)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && (active === last || outside)) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [visible])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submittingRef.current) return
    // Fail-closed: sin la capacidad no sale ninguna llamada.
    if (!canUseCaja) return
    if (!businessId || !user) {
      setError('No se pudo identificar tu sesión. Actualizá la pantalla y volvé a intentar.')
      return
    }

    const balances = {} as Record<CajaOpenMethod, number>
    for (const m of CAJA_OPEN_METHODS) balances[m] = parseFloat(form[m]) || 0
    if (CAJA_OPEN_METHODS.some(m => balances[m] < 0)) {
      setError('Los saldos iniciales no pueden ser negativos. Dejá en cero lo que no uses.')
      return
    }

    const localHash = CAJA_OPEN_METHODS.map(m => form[m]).join('|')
    const rk = resolvePurchaseKey(keyRef.current, hashRef.current, localHash, () => crypto.randomUUID())
    keyRef.current = rk.key
    hashRef.current = rk.hash

    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      const result = await cashSessionService.open({
        businessId, userId: user.id, balances, usdRate: exchangeRate, idempotencyKey: rk.key,
      })

      if (result.status === 'opened') {
        // Intento resuelto: la próxima apertura no puede reusar esta key.
        keyRef.current = null
        hashRef.current = null
        const caja = await refresh()
        if (!caja && result.replay) {
          // El servidor reconoció un intento anterior cuya caja ya no está
          // abierta. No es «caja abierta»: se dice y se deja reintentar.
          setError('Esa apertura ya se había registrado y la caja volvió a cerrarse. Confirmá de nuevo para abrir una caja nueva.')
          return
        }
        window.dispatchEvent(new Event('cash-session-updated'))
        onOpened({ alreadyOpen: false })
        return
      }

      if (result.status === 'already_open') {
        // Carrera: otro usuario o pestaña abrió la caja mientras este diálogo
        // estaba a la vista. Si efectivamente quedó abierta, el prerequisito
        // está cumplido y no hay nada que mostrar como error.
        const caja = await refresh()
        if (caja) {
          keyRef.current = null
          hashRef.current = null
          window.dispatchEvent(new Event('cash-session-updated'))
          onOpened({ alreadyOpen: true })
          return
        }
        setError('El sistema informa una caja abierta, pero no se pudo confirmar. Actualizá la pantalla y volvé a intentar.')
        return
      }

      if (result.code === 'IDEMPOTENCY_CONFLICT') {
        keyRef.current = null
        hashRef.current = null
      }
      setError(result.message)
    } catch (err) {
      logger.error('FINANCE', 'Apertura de caja desde el POS: fallo inesperado', err)
      setError(financeErrorMessage(null, null, 'FINANCE'))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  if (!visible) return null

  const rateLabel = exchangeRate > 1
    ? `Cotización: $${exchangeRate.toLocaleString('es-AR')}`
    : 'Cotización no disponible'

  return (
    <div className="cpm-caja-overlay" data-testid="pos-open-caja-overlay">
      <div
        ref={dialogRef}
        className="cpm-caja-dialog"
        data-testid="pos-open-caja-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
      >
        <form className="cpm-caja-form" onSubmit={handleSubmit} noValidate>
          <div className="cpm-caja-head">
            <span className="cpm-caja-icon" aria-hidden="true"><Unlock size={18} /></span>
            <div className="cpm-caja-titles">
              <h2 id={titleId}>Abrir caja</h2>
              <p id={descId}>
                Indicá con cuánto arranca cada medio de pago. Tu venta queda como está y volvés al cobro.
              </p>
            </div>
            <button
              type="button" className="cpm-caja-close" data-testid="pos-open-caja-close"
              onClick={onClose} disabled={submitting} aria-label="Cerrar sin abrir la caja"
            >
              <X size={18} />
            </button>
          </div>

          <div className="cpm-caja-body">
            <div className="cpm-caja-grid">
              {CAJA_OPEN_METHODS.map((m, i) => {
                const { label, prefix, icon: Icon } = FIELDS[m]
                const inputId = `${baseId}-${m}`
                return (
                  <div className="cpm-caja-field" key={m}>
                    <label htmlFor={inputId}>
                      <Icon size={14} aria-hidden="true" /> {label}
                    </label>
                    <div className="cpm-caja-input">
                      <span aria-hidden="true">{prefix}</span>
                      <input
                        ref={i === 0 ? firstInputRef : undefined}
                        id={inputId}
                        data-testid={`pos-open-caja-${m}`}
                        className="cpm-input16"
                        style={INPUT_STYLE}
                        type="number" inputMode="decimal" min="0" step="0.01" placeholder="0"
                        autoComplete="off" enterKeyHint="done"
                        value={form[m]}
                        onChange={ev => setForm(prev => ({ ...prev, [m]: ev.target.value }))}
                        disabled={submitting}
                        aria-describedby={m === 'usd' ? rateId : undefined}
                      />
                    </div>
                    {m === 'usd' && (
                      <p id={rateId} className="cpm-caja-hint" data-testid="pos-open-caja-usd-rate">{rateLabel}</p>
                    )}
                  </div>
                )
              })}
            </div>

            {error && (
              <div className="cpm-caja-error" data-testid="pos-open-caja-error" role="alert">
                <AlertCircle size={14} aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}
          </div>

          <div className="cpm-caja-actions">
            <button
              type="button" className="cpm-caja-btn cpm-caja-btn--ghost" data-testid="pos-open-caja-cancel"
              onClick={onClose} disabled={submitting}
            >
              Cancelar
            </button>
            <button
              type="submit" className="cpm-caja-btn cpm-caja-btn--primary" data-testid="pos-open-caja-confirm"
              disabled={submitting} aria-busy={submitting}
            >
              {submitting
                ? <><Loader2 size={16} className="cpm-caja-spin" aria-hidden="true" /> Abriendo…</>
                : <><Unlock size={16} aria-hidden="true" /> Abrir caja</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
