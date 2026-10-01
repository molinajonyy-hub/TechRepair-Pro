/**
 * PaymentPending.tsx
 *
 * A dónde vuelve el usuario desde el checkout de Mercado Pago.
 *
 * BETA-MP: esta pantalla NO es autoridad de nada. No activa, no elige plan y no
 * lee parámetros de la URL de retorno. Sólo le pide al servidor que consulte a
 * Mercado Pago (`reconcilePayment`) y muestra lo que el servidor confirmó:
 *
 *   «Pago confirmado»  ⇔  la sesión de ESTE checkout quedó `paid` en el servidor.
 *
 * Que el negocio ya esté `active` no alcanza: puede estarlo por un plan anterior
 * o por un acceso otorgado a mano. Mientras Mercado Pago no confirme, el negocio
 * conserva exactamente el acceso que tenía.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, CheckCircle, Clock, XCircle, Info } from 'lucide-react'
import { useSubscription } from '../hooks/useSubscription'
import { reconcilePayment } from '../services/subscriptionService'
import { useAuth } from '../contexts/AuthContext'
import type { CheckoutSummary } from '../types/subscription'

const POLL_MS    = 8000
const MAX_CHECKS = 15  // ~2 minutos

export function PaymentPending() {
  const navigate = useNavigate()
  const { businessId } = useAuth()
  const { isAllowed, refresh } = useSubscription()

  const [checks, setChecks]     = useState(0)
  // `undefined`: todavía no hay respuesta del servidor. `null`: no hay checkout.
  const [checkout, setCheckout] = useState<CheckoutSummary | null | undefined>(undefined)
  const [message, setMessage]   = useState('')
  const [error, setError]       = useState('')
  const checking = useRef(false)

  const doCheck = useCallback(async () => {
    if (!businessId || checking.current) return
    checking.current = true
    try {
      const result = await reconcilePayment(businessId)
      setError('')
      setCheckout(result.checkout)
      setMessage(result.message)
      if (result.checkout?.status === 'paid') await refresh()
    } catch (e) {
      // Un error de red o del servicio no es «pago rechazado»: se muestra y se sigue.
      setError(e instanceof Error ? e.message : 'No pudimos verificar el pago.')
    } finally {
      checking.current = false
      setChecks(c => c + 1)
    }
  }, [businessId, refresh])

  const status     = checkout?.status
  const isPaid     = status === 'paid'
  const isFailed   = status === 'failed' || status === 'canceled' || status === 'expired'
  const noCheckout = checkout === null
  const isTimeout  = checks >= MAX_CHECKS && !isPaid && !isFailed && !noCheckout

  // Polling: se detiene apenas el servidor da una respuesta definitiva.
  useEffect(() => {
    if (isPaid || isFailed || noCheckout || checks >= MAX_CHECKS) return
    const t = setTimeout(doCheck, checks === 0 ? 1000 : POLL_MS)
    return () => clearTimeout(t)
  }, [checks, isPaid, isFailed, noCheckout, doCheck])

  // Sólo con la confirmación del servidor.
  useEffect(() => {
    if (!isPaid) return
    const t = setTimeout(() => navigate('/subscription/success', { replace: true }), 800)
    return () => clearTimeout(t)
  }, [isPaid, navigate])

  // Mientras no haya confirmación, el acceso es el que ya tenía el negocio.
  const accessNote = isAllowed
    ? 'Mientras tanto seguís usando TechRepair Pro con tu acceso actual.'
    : 'Tu acceso se habilita cuando Mercado Pago confirme el pago.'

  if (isPaid) {
    return (
      <StatusScreen
        testId="payment-confirmed"
        icon={<CheckCircle size={36} color="#22c55e" />}
        color="rgba(34,197,94,0.12)"
        title="¡Pago confirmado!"
        message="Mercado Pago confirmó tu suscripción. Redirigiendo..."
      />
    )
  }

  if (isFailed) {
    return (
      <StatusScreen
        testId="payment-not-completed"
        icon={<XCircle size={36} color="#ef4444" />}
        color="rgba(239,68,68,0.1)"
        title="El pago no se completó"
        message={`${status === 'expired'
          ? 'El checkout venció sin que Mercado Pago confirmara un pago.'
          : 'Mercado Pago informó que la suscripción no se concretó.'} No se cambió nada en tu cuenta. Podés intentarlo de nuevo.`}
        actions={[
          { label: 'Intentar nuevamente', primary: true, onClick: () => navigate('/subscription/plans') },
          { label: 'Ir al inicio', primary: false, onClick: () => navigate('/') },
        ]}
      />
    )
  }

  if (noCheckout) {
    return (
      <StatusScreen
        testId="payment-no-checkout"
        icon={<Info size={36} color="#6366f1" />}
        color="rgba(99,102,241,0.1)"
        title="No hay un pago en curso"
        message={message || 'No encontramos un checkout abierto para este negocio.'}
        actions={[
          { label: 'Ver planes', primary: true, onClick: () => navigate('/subscription/plans') },
          { label: 'Mi suscripción', primary: false, onClick: () => navigate('/subscription') },
        ]}
      />
    )
  }

  if (isTimeout) {
    return (
      <StatusScreen
        testId="payment-unconfirmed"
        icon={<Clock size={36} color="#fbbf24" />}
        color="rgba(251,191,36,0.1)"
        title="Todavía no recibimos la confirmación"
        message={`${error || message || 'Mercado Pago puede tardar unos minutos en confirmar el pago.'} ${accessNote}`}
        actions={[
          { label: 'Verificar ahora', primary: true, onClick: doCheck },
          { label: 'Ir al inicio', primary: false, onClick: () => navigate('/') },
          { label: 'Necesito ayuda', primary: false, onClick: () => navigate('/ayuda') },
        ]}
      />
    )
  }

  return (
    <StatusScreen
      testId="payment-verifying"
      icon={<Loader2 size={36} color="#6366f1" style={{ animation: 'tr-spin 0.7s linear infinite' }} />}
      color="rgba(99,102,241,0.1)"
      title="Verificando tu pago..."
      message={`Esperando la confirmación de Mercado Pago. ${accessNote}`}
    />
  )
}

// ── Sub-componente pantalla de estado ─────────────────────────────────────────

function StatusScreen({ icon, color, title, message, actions, testId }: {
  icon:     React.ReactNode
  color:    string
  title:    string
  message:  string
  actions?: { label: string; primary: boolean; onClick: () => void }[]
  testId:   string
}) {
  return (
    <div data-testid={testId} role="status" style={{
      minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: '1.5rem', textAlign: 'center', padding: '2rem',
    }}>
      <div style={{ width: 72, height: 72, borderRadius: '50%', background: color, border: '2px solid ' + color.replace('0.1','0.4').replace('0.12','0.4'), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {icon}
      </div>
      <div>
        <h2 style={{ margin: '0 0 0.5rem', color: 'var(--text-primary)', fontSize: '1.5rem', fontWeight: 800, letterSpacing: '-0.03em' }}>{title}</h2>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.875rem', maxWidth: 420, lineHeight: 1.6 }}>{message}</p>
      </div>
      {actions && (
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
          {actions.map(a => (
            <button key={a.label} onClick={a.onClick}
              className={a.primary ? 'btn btn-primary btn-lift' : 'btn btn-ghost'}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
