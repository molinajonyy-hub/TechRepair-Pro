/**
 * PaymentPending.tsx
 *
 * Shown after returning from MP checkout.
 * Never activates account here — waits for webhook to update status.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, CheckCircle, Clock } from 'lucide-react'
import { useSubscription } from '../hooks/useSubscription'
import { syncSubscriptionStatus } from '../services/subscriptionService'
import { useAuth } from '../contexts/AuthContext'

export function PaymentPending() {
  const navigate = useNavigate()
  const { businessId } = useAuth()
  const { isActive, refresh } = useSubscription()

  // Use the sync function which also queries MP live
  const doCheck = async () => {
    if (businessId) await syncSubscriptionStatus(businessId)
    await refresh()
  }
  const [checks, setChecks] = useState(0)
  const MAX_CHECKS = 12 // ~60 seconds

  // Poll every 5 seconds for webhook to arrive
  useEffect(() => {
    if (isActive) return // Already activated by webhook
    if (checks >= MAX_CHECKS) return

    const timer = setTimeout(async () => {
      await doCheck()
      setChecks(c => c + 1)
    }, 5000)

    return () => clearTimeout(timer)
  }, [checks, isActive, refresh])

  useEffect(() => {
    if (isActive) {
      setTimeout(() => navigate('/'), 2500)
    }
  }, [isActive, navigate])

  const isTimeout = checks >= MAX_CHECKS && !isActive

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: '60vh', flexDirection: 'column', gap: '1.5rem', textAlign: 'center', padding: '2rem',
    }}>
      {isActive ? (
        <>
          <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'rgba(52,211,153,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <CheckCircle size={36} color="#34d399" />
          </div>
          <h2 style={{ color: '#34d399', margin: 0 }}>¡Pago confirmado!</h2>
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>Tu cuenta está activa. Redirigiendo...</p>
        </>
      ) : isTimeout ? (
        <>
          <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'rgba(251,191,36,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Clock size={36} color="#fbbf24" />
          </div>
          <h2 style={{ color: 'var(--text-primary)', margin: 0 }}>Verificando pago</h2>
          <p style={{ color: 'var(--text-muted)', margin: 0, maxWidth: 420 }}>
            El pago puede tardar unos minutos en confirmar. Tu cuenta se activará automáticamente cuando Mercado Pago procese el pago. Podés cerrar esta pantalla.
          </p>
          <div style={{ display: 'flex', gap: '1rem' }}>
            <button onClick={doCheck} style={btnStyle}>Verificar ahora</button>
            <button onClick={() => navigate('/')} style={{ ...btnStyle, background: 'transparent', borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>
              Ir al inicio
            </button>
          </div>
        </>
      ) : (
        <>
          <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'rgba(99,102,241,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Loader2 size={36} color="#6366f1" style={{ animation: 'spin 1s linear infinite' }} />
          </div>
          <h2 style={{ color: 'var(--text-primary)', margin: 0 }}>Verificando tu pago...</h2>
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>
            Estamos esperando confirmación de Mercado Pago. Esto puede tomar unos segundos.
          </p>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: 0 }}>
            Verificación {checks + 1}/{MAX_CHECKS}
          </p>
        </>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

const btnStyle: React.CSSProperties = {
  padding: '0.625rem 1.25rem', borderRadius: '0.625rem',
  background: '#6366f1', color: '#fff', border: '1px solid #6366f1',
  fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer',
}
