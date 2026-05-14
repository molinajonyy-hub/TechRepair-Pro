/**
 * PaymentPending.tsx
 *
 * Espera la confirmación del webhook de Mercado Pago.
 * Polling sobre subscription_checkout_sessions (fuente de verdad del webhook)
 * + fallback sobre businesses.subscription_status.
 *
 * No activa la suscripción aquí — eso lo hace el webhook.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, CheckCircle, Clock, XCircle } from 'lucide-react'
import { useSubscription } from '../hooks/useSubscription'
import { getLatestCheckoutSession, syncSubscriptionStatus } from '../services/subscriptionService'
import { useAuth } from '../contexts/AuthContext'

const F = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
const MAX_CHECKS = 24  // 2 minutos a intervalos de 5s

export function PaymentPending() {
  const navigate = useNavigate()
  const { businessId } = useAuth()
  const { isActive, refresh } = useSubscription()

  const [checks, setChecks]             = useState(0)
  const [sessionStatus, setSessionStatus] = useState<string | null>(null)
  const [checking, setChecking]         = useState(false)

  const doCheck = async () => {
    if (!businessId || checking) return
    setChecking(true)
    try {
      // 1. Consultar checkout_session (actualizado por el webhook)
      const session = await getLatestCheckoutSession(businessId)
      setSessionStatus(session.status)

      if (session.status === 'paid') {
        await refresh()
        return
      }
      if (session.status === 'failed' || session.status === 'canceled') return

      // 2. Fallback: sincronizar desde MP live
      await syncSubscriptionStatus(businessId)
      await refresh()
    } finally {
      setChecking(false)
      setChecks(c => c + 1)
    }
  }

  // Polling automático cada 5 segundos
  useEffect(() => {
    if (isActive || checks >= MAX_CHECKS) return
    if (sessionStatus === 'failed' || sessionStatus === 'canceled') return
    const t = setTimeout(doCheck, checks === 0 ? 1000 : 5000)
    return () => clearTimeout(t)
  }, [checks, isActive, sessionStatus])

  // Redirigir cuando se activa
  useEffect(() => {
    if (isActive) setTimeout(() => navigate('/subscription/success', { replace: true }), 800)
  }, [isActive, navigate])

  // Estados derivados
  const isPaid     = sessionStatus === 'paid' || isActive
  const isFailed   = sessionStatus === 'failed' || sessionStatus === 'canceled'
  const isTimeout  = checks >= MAX_CHECKS && !isPaid && !isFailed

  if (isPaid) {
    return (
      <StatusScreen
        icon={<CheckCircle size={36} color="#22c55e" />}
        color="rgba(34,197,94,0.12)"
        title="¡Pago confirmado!"
        message="Tu suscripción está activa. Redirigiendo..."
      />
    )
  }

  if (isFailed) {
    return (
      <StatusScreen
        icon={<XCircle size={36} color="#ef4444" />}
        color="rgba(239,68,68,0.1)"
        title="El pago no pudo procesarse"
        message="El pago fue rechazado o cancelado. Podés intentarlo nuevamente."
        actions={[
          { label: 'Intentar nuevamente', primary: true, onClick: () => navigate('/subscription/plans') },
          { label: 'Ir al inicio', primary: false, onClick: () => navigate('/') },
        ]}
      />
    )
  }

  if (isTimeout) {
    return (
      <StatusScreen
        icon={<Clock size={36} color="#fbbf24" />}
        color="rgba(251,191,36,0.1)"
        title="Verificando tu pago"
        message="El pago puede tardar unos minutos. Tu suscripción se activará automáticamente cuando Mercado Pago confirme el cobro."
        actions={[
          { label: 'Verificar ahora', primary: true, onClick: doCheck },
          { label: 'Ir al inicio', primary: false, onClick: () => navigate('/') },
        ]}
      />
    )
  }

  return (
    <StatusScreen
      icon={<Loader2 size={36} color="#6366f1" style={{ animation: 'spin 0.7s linear infinite' }} />}
      color="rgba(99,102,241,0.1)"
      title="Verificando tu pago..."
      message={`Esperando confirmación de Mercado Pago. Verificación ${checks + 1}/${MAX_CHECKS}.`}
    />
  )
}

// ── Sub-componente pantalla de estado ─────────────────────────────────────────

function StatusScreen({ icon, color, title, message, actions }: {
  icon:     React.ReactNode
  color:    string
  title:    string
  message:  string
  actions?: { label: string; primary: boolean; onClick: () => void }[]
}) {
  return (
    <div style={{
      minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: '1.5rem', textAlign: 'center', padding: '2rem', fontFamily: F,
    }}>
      <div style={{ width: 72, height: 72, borderRadius: '50%', background: color, border: '2px solid ' + color.replace('0.1','0.4').replace('0.12','0.4'), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {icon}
      </div>
      <div>
        <h2 style={{ margin: '0 0 0.5rem', color: '#f1f5f9', fontSize: '1.5rem', fontWeight: 800, letterSpacing: '-0.03em' }}>{title}</h2>
        <p style={{ margin: 0, color: '#64748b', fontSize: '0.875rem', maxWidth: 420, lineHeight: 1.6 }}>{message}</p>
      </div>
      {actions && (
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
          {actions.map(a => (
            <button key={a.label} onClick={a.onClick} style={{
              padding: '0.75rem 1.5rem', borderRadius: '0.875rem', fontFamily: F,
              fontWeight: 700, fontSize: '0.875rem', cursor: 'pointer',
              background: a.primary ? 'linear-gradient(135deg, #6366f1, #4f46e5)' : 'rgba(255,255,255,0.05)',
              border: a.primary ? 'none' : '1px solid rgba(255,255,255,0.1)',
              color: a.primary ? '#fff' : '#94a3b8',
              boxShadow: a.primary ? '0 4px 16px rgba(99,102,241,0.3)' : 'none',
            }}>
              {a.label}
            </button>
          ))}
        </div>
      )}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
