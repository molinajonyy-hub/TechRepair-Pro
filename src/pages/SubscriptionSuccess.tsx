import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSubscription } from '../hooks/useSubscription'
import { PLAN_DISPLAY } from '../config/planFeatures'

const F = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', sans-serif"

export function SubscriptionSuccess() {
  const navigate = useNavigate()
  const { currentPlan, refresh } = useSubscription()

  useEffect(() => { refresh() }, [refresh])

  const planInfo = currentPlan ? PLAN_DISPLAY[currentPlan] : null

  return (
    <div style={{
      minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: '1.5rem', textAlign: 'center', padding: '2rem', fontFamily: F,
    }}>
      {/* Check animado */}
      <div style={{
        width: 80, height: 80, borderRadius: '50%',
        background: 'rgba(34,197,94,0.12)', border: '2px solid #22c55e',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        animation: 'popIn 0.4s cubic-bezier(0.22,1,0.36,1)',
      }}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </div>

      <div>
        <h1 style={{ margin: '0 0 0.5rem', color: '#f1f5f9', fontSize: '1.75rem', fontWeight: 800, letterSpacing: '-0.04em' }}>
          Suscripción activada
        </h1>
        {planInfo && (
          <p style={{ margin: '0 0 0.375rem', color: '#64748b', fontSize: '0.9rem' }}>
            Plan <strong style={{ color: planInfo.color }}>{planInfo.label}</strong> activo
          </p>
        )}
        <p style={{ margin: 0, color: '#475569', fontSize: '0.875rem' }}>
          Gracias por tu confianza. Ya tenés acceso completo al sistema.
        </p>
      </div>

      <button
        onClick={() => navigate('/dashboard', { replace: true })}
        style={{
          padding: '0.875rem 2rem',
          background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
          border: 'none', borderRadius: '0.875rem',
          color: '#fff', fontWeight: 700, fontSize: '0.95rem',
          cursor: 'pointer', fontFamily: F,
          boxShadow: '0 4px 20px rgba(99,102,241,0.3)',
          transition: 'opacity 0.15s',
        }}
        onMouseEnter={e => e.currentTarget.style.opacity = '0.88'}
        onMouseLeave={e => e.currentTarget.style.opacity = '1'}
      >
        Ir al dashboard
      </button>

      <style>{`@keyframes popIn { from { transform: scale(0.7); opacity: 0; } to { transform: scale(1); opacity: 1; } }`}</style>
    </div>
  )
}
