import { useState, useRef } from 'react'
import { X, CreditCard, CheckCircle2, AlertCircle } from 'lucide-react'
import { cuentasService, type Account } from '../../services/cuentasService'
import { resolvePurchaseKey } from '../../utils/purchaseIdempotency'
import { formatDisplayMessage } from '../../utils/formatMessage'
import { useCaja } from '../../contexts/CajaContext'

/**
 * P0-CC · CC-A — Métodos de cobro de cuenta corriente.
 *
 * Los `id` son los valores del catálogo de negocio (`MedioPago`), NO etiquetas.
 * Antes se mandaban `debito` / `credito`, que no pertenecen a ningún catálogo:
 * la RPC los persistía crudos en `financial_movements.metodo_pago` y el arqueo
 * —que sólo entiende efectivo/transferencia/tarjeta/usd— los ignoraba. Esa
 * plata quedaba fuera del cierre de caja.
 *
 * El server igual normaliza y rechaza lo que no reconoce (fail-closed), así que
 * esta lista es la capa de producto, no la de seguridad.
 *
 * No hay opción USD: la cuenta corriente es ARS-only (`account_movements` no
 * tiene moneda ni cotización). Ver handoff CC-MULTICURRENCY.
 */
const METODOS = [
  { id: 'efectivo',        label: 'Efectivo',      color: '#34d399' },
  { id: 'transferencia',   label: 'Transferencia', color: '#60a5fa' },
  { id: 'tarjeta_debito',  label: 'Débito',        color: '#818cf8' },
  { id: 'tarjeta_credito', label: 'Crédito',       color: '#f59e0b' },
  { id: 'otro',            label: 'Otro',          color: '#94a3b8' },
]

interface Props {
  isOpen:     boolean
  onClose:    () => void
  onPagado:   () => void
  account:    Account
  businessId: string
  userId:     string
}

export function ModalPagarCC({ isOpen, onClose, onPagado, account, businessId, userId }: Props) {
  const { cajaId } = useCaja()
  const [amount,  setAmount]  = useState(String(Math.round(Math.max(0, account.balance))))
  const [method,  setMethod]  = useState('efectivo')
  // P0-CC: arranca VACÍA y es opcional. Cuando la descripción era obligatoria y
  // no había selector de método, el operador la usaba para anotar cómo le
  // pagaron — en producción quedó un cobro cuya descripción es, literalmente,
  // "efectivo". El método ahora tiene su propio campo; esto es una nota.
  const [desc,    setDesc]    = useState('')
  const [saving,  setSaving]  = useState(false)
  const [success, setSuccess] = useState(false)
  const [err,     setErr]     = useState('')
  // Idempotency key estable por intento: se renueva sólo si cambia el payload
  // (monto/método/descripción); conserva ante doble-click; server valida.
  const keyRef  = useRef<string | null>(null)
  const hashRef = useRef<string | null>(null)

  if (!isOpen) return null

  const maxAmount = Math.max(0, account.balance)
  const fmtARS = (n: number) => '$' + Math.abs(Math.round(n)).toLocaleString('es-AR')

  const handleSave = async () => {
    // Guard de reentrada: el botón ya está disabled, pero un Enter repetido o un
    // doble click muy rápido pueden disparar dos veces antes del re-render.
    // La idempotencia del server lo cubre igual; esto evita el ida y vuelta.
    if (saving || success) return
    const amt = parseFloat(amount.replace(',', '.'))
    if (!amt || amt <= 0) { setErr('El monto debe ser mayor a 0'); return }
    if (amt > maxAmount + 0.01) { setErr(`El monto no puede superar la deuda (${fmtARS(maxAmount)})`); return }
    setSaving(true); setErr('')
    // key ligada al payload: cambia si cambia monto/método/descripción.
    const localHash = `${amt}|${method}|${desc.trim()}`
    const resolved = resolvePurchaseKey(keyRef.current, hashRef.current, localHash, () => crypto.randomUUID())
    keyRef.current = resolved.key; hashRef.current = resolved.hash
    try {
      await cuentasService.registrarPagoCC(businessId, account.id, amt, desc.trim(), userId, cajaId, method, keyRef.current)
      keyRef.current = null; hashRef.current = null   // éxito → próxima cobro, otra key
      setSuccess(true)
      setTimeout(() => { onPagado(); onClose() }, 1400)
    } catch (e: any) {
      // Conflicto de idempotencia: invalidar la key para un próximo intento explícito.
      if ((e as { code?: string })?.code === 'IDEMPOTENCY_CONFLICT') { keyRef.current = null; hashRef.current = null }
      setErr(e.message || 'Error al registrar el pago')
    } finally {
      setSaving(false)
    }
  }

  const inputS: React.CSSProperties = {
    width: '100%', padding: '0.5625rem 0.875rem',
    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '0.5rem', color: '#f0f4ff', fontSize: '0.875rem',
    outline: 'none', boxSizing: 'border-box',
  }
  const labelS: React.CSSProperties = {
    display: 'block', fontSize: '0.72rem', fontWeight: 600, color: '#94a3b8',
    marginBottom: '0.35rem', textTransform: 'uppercase', letterSpacing: '0.05em',
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: '1rem' }}
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose() }}
    >
      <div style={{ background: '#0d1a30', border: '1px solid rgba(99,102,241,0.25)', borderRadius: '1.25rem', width: '100%', maxWidth: 440, boxShadow: '0 32px 64px rgba(0,0,0,0.6)' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.25rem 1.5rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
            <div style={{ width: 36, height: 36, borderRadius: '0.625rem', background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <CreditCard size={16} style={{ color: '#818cf8' }} />
            </div>
            <div>
              {/* Desde el negocio la plata ENTRA: es un COBRO. «Pago» describe
                  al cliente, y el modal se abría desde un botón que dice
                  «Registrar cobro»: dos palabras para el mismo acto. */}
              <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: '#f0f4ff' }}>Registrar cobro</h2>
              <p style={{ margin: '0.1rem 0 0', fontSize: '0.75rem', color: '#475569' }}>{account.entity_name}</p>
            </div>
          </div>
          <button onClick={onClose} disabled={saving} style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', padding: '0.25rem' }}>
            <X size={16} />
          </button>
        </div>

        {/* Deuda actual */}
        <div style={{ margin: '1.25rem 1.5rem 0', padding: '0.75rem 1rem', background: 'rgba(248,113,113,0.07)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: '0.625rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>Deuda actual</span>
          <span style={{ fontFamily: 'monospace', fontSize: '1.25rem', fontWeight: 800, color: '#f87171' }}>{fmtARS(maxAmount)}</span>
        </div>

        {/* Form */}
        <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Monto — la moneda se dice explícitamente: la CC es ARS-only. */}
          <div>
            <label style={labelS}>
              Monto a cobrar *
              <span style={{ float: 'right', color: '#64748b', letterSpacing: 0, textTransform: 'none' }}>
                en pesos (ARS)
              </span>
            </label>
            <input
              data-testid="cc-pay-amount"
              style={{ ...inputS, fontSize: '1.5rem', fontWeight: 800, textAlign: 'right', color: '#34d399' }}
              type="number" min="0.01" step="1" max={maxAmount}
              value={amount} onChange={e => setAmount(e.target.value)} autoFocus
            />
          </div>

          {/* Método */}
          <div>
            <label style={labelS}>Método de cobro *</label>
            <div data-testid="cc-pay-methods"
                 style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(92px, 1fr))', gap: '0.375rem' }}>
              {METODOS.map(m => {
                const active = method === m.id
                return (
                  <button
                    key={m.id} type="button" onClick={() => setMethod(m.id)}
                    data-testid={`cc-pay-method-${m.id}`}
                    aria-pressed={active}
                    style={{
                      padding: '0.5rem 0.375rem', borderRadius: '0.5rem',
                      border: `2px solid ${active ? m.color : 'rgba(255,255,255,0.07)'}`,
                      background: active ? `${m.color}18` : 'transparent',
                      color: active ? m.color : '#475569',
                      fontSize: '0.75rem', fontWeight: 700, cursor: 'pointer',
                    }}
                  >
                    {m.label}
                  </button>
                )
              })}
            </div>
            {/* La RPC exige caja abierta para cobrar en efectivo. Avisarlo acá
                evita que el operador cargue todo y recién falle al confirmar. */}
            {method === 'efectivo' && !cajaId && (
              <p style={{ margin: '0.45rem 0 0', fontSize: '0.72rem', color: '#fbbf24' }}>
                No hay una caja abierta. Abrí la caja para poder cobrar en efectivo.
              </p>
            )}
          </div>

          {/* Observación — NUNCA sustituye al método de pago. */}
          <div>
            <label style={labelS}>
              Observación
              <span style={{ float: 'right', color: '#64748b', letterSpacing: 0, textTransform: 'none' }}>
                opcional
              </span>
            </label>
            <input data-testid="cc-pay-note" style={inputS} type="text" value={desc}
                   onChange={e => setDesc(e.target.value)} placeholder="Referencia o comentario…" />
          </div>

          {err && (
            <div data-testid="cc-pay-error" role="alert"
                 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.625rem 0.875rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '0.5rem' }}>
              <AlertCircle size={14} style={{ color: '#f87171', flexShrink: 0 }} />
              <span style={{ color: '#fca5a5', fontSize: '0.8rem' }}>{formatDisplayMessage(err)}</span>
            </div>
          )}

          {success && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.625rem 0.875rem', background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.3)', borderRadius: '0.5rem' }}>
              <CheckCircle2 size={14} style={{ color: '#34d399' }} />
              <span style={{ color: '#34d399', fontSize: '0.8rem', fontWeight: 600 }}>Cobro registrado. Impacta en caja y finanzas.</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '1rem 1.5rem', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={saving} style={{ padding: '0.625rem 1.125rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.5rem', color: '#94a3b8', fontSize: '0.875rem', cursor: 'pointer', fontWeight: 600 }}>
            Cancelar
          </button>
          <button
            data-testid="cc-pay-confirm"
            onClick={handleSave} disabled={saving || success}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.625rem 1.25rem', background: success ? 'linear-gradient(135deg,#10b981,#059669)' : 'linear-gradient(135deg,#6366f1,#8b5cf6)', border: 'none', borderRadius: '0.5rem', color: '#fff', fontSize: '0.875rem', fontWeight: 600, cursor: saving || success ? 'not-allowed' : 'pointer', opacity: saving ? 0.75 : 1 }}
          >
            {saving ? 'Registrando...' : success ? <><CheckCircle2 size={14} /> Registrado</> : 'Confirmar cobro'}
          </button>
        </div>
      </div>
    </div>
  )
}
