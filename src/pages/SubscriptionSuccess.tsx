import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle } from 'lucide-react'
import { useSubscription } from '../hooks/useSubscription'
import { PLAN_DISPLAY } from '../config/planFeatures'

export function SubscriptionSuccess() {
  const navigate = useNavigate()
  const { currentPlan, refresh } = useSubscription()

  useEffect(() => { refresh() }, [refresh])

  const planInfo = currentPlan ? PLAN_DISPLAY[currentPlan] : null

  return (
    <div style={{
      minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: '1.5rem', textAlign: 'center', padding: '2rem',
    }}>
      {/* Check animado */}
      <div style={{
        width: 80, height: 80, borderRadius: '50%',
        background: 'rgba(34,197,94,0.12)', border: '2px solid #22c55e',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        animation: 'popIn 0.4s cubic-bezier(0.22,1,0.36,1)',
      }}>
        <CheckCircle size={36} style={{ color: '#22c55e' }} />
      </div>

      <div>
        <h1 style={{ margin: '0 0 0.5rem', color: 'var(--text-primary)', fontSize: '1.75rem', fontWeight: 800, letterSpacing: '-0.04em' }}>
          Suscripción activada
        </h1>
        {planInfo && (
          <p style={{ margin: '0 0 0.375rem', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            Plan <strong style={{ color: planInfo.color }}>{planInfo.label}</strong> activo
          </p>
        )}
        <p style={{ margin: 0, color: 'var(--text-subtle)', fontSize: '0.875rem' }}>
          Gracias por tu confianza. Ya tenés acceso completo al sistema.
        </p>
      </div>

      <button
        onClick={() => navigate('/dashboard', { replace: true })}
        className="btn btn-primary btn-lift"
        style={{ padding: '0.875rem 2rem', fontSize: '0.95rem' }}
      >
        Ir al dashboard
      </button>

      <style>{`@keyframes popIn { from { transform: scale(0.7); opacity: 0; } to { transform: scale(1); opacity: 1; } }`}</style>
    </div>
  )
}
