import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle, Clock } from 'lucide-react'
import { useSubscription } from '../hooks/useSubscription'
import { PLAN_DISPLAY } from '../config/planFeatures'

export function SubscriptionSuccess() {
  const navigate = useNavigate()
  const { currentPlan, isActive, refresh } = useSubscription()

  useEffect(() => { refresh() }, [refresh])

  const planInfo = currentPlan ? PLAN_DISPLAY[currentPlan] : null

  // NEVER claim activation from a return URL alone. We only show "activada" when
  // our DB (updated by the webhook) confirms the subscription is active.
  const confirmed = isActive

  return (
    <div style={{
      minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: '1.5rem', textAlign: 'center', padding: '2rem',
    }}>
      {/* Icon */}
      <div style={{
        width: 80, height: 80, borderRadius: '50%',
        background: confirmed ? 'rgba(34,197,94,0.12)' : 'rgba(251,191,36,0.12)',
        border: confirmed ? '2px solid #22c55e' : '2px solid #fbbf24',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        animation: 'popIn 0.4s cubic-bezier(0.22,1,0.36,1)',
      }}>
        {confirmed
          ? <CheckCircle size={36} style={{ color: '#22c55e' }} />
          : <Clock size={36} style={{ color: '#fbbf24' }} />}
      </div>

      <div>
        <h1 style={{ margin: '0 0 0.5rem', color: 'var(--text-primary)', fontSize: '1.75rem', fontWeight: 800, letterSpacing: '-0.04em' }}>
          {confirmed ? 'Suscripción activada' : 'Estamos confirmando tu pago'}
        </h1>
        {confirmed && planInfo && (
          <p style={{ margin: '0 0 0.375rem', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            Plan <strong style={{ color: planInfo.color }}>{planInfo.label}</strong> activo
          </p>
        )}
        <p style={{ margin: 0, color: 'var(--text-subtle)', fontSize: '0.875rem' }}>
          {confirmed
            ? 'Gracias por tu confianza. Ya tenés acceso completo al sistema.'
            : 'Mercado Pago está procesando el cobro. Tu plan se activará automáticamente al confirmarse — no cierres sesión.'}
        </p>
      </div>

      <button
        onClick={() => navigate(confirmed ? '/dashboard' : '/subscription', { replace: true })}
        className="btn btn-primary btn-lift"
        style={{ padding: '0.875rem 2rem', fontSize: '0.95rem' }}
      >
        {confirmed ? 'Ir al dashboard' : 'Ver estado de mi suscripción'}
      </button>

      <style>{`@keyframes popIn { from { transform: scale(0.7); opacity: 0; } to { transform: scale(1); opacity: 1; } }`}</style>
    </div>
  )
}
