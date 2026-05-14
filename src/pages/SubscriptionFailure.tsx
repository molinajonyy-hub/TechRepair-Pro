import { useNavigate } from 'react-router-dom'

const F = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"

export function SubscriptionFailure() {
  const navigate = useNavigate()

  return (
    <div style={{
      minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: '1.5rem', textAlign: 'center', padding: '2rem', fontFamily: F,
    }}>
      <div style={{
        width: 72, height: 72, borderRadius: '50%',
        background: 'rgba(239,68,68,0.1)', border: '2px solid rgba(239,68,68,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round">
          <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
      </div>

      <div>
        <h1 style={{ margin: '0 0 0.5rem', color: '#f1f5f9', fontSize: '1.6rem', fontWeight: 800, letterSpacing: '-0.04em' }}>
          No pudimos completar el pago
        </h1>
        <p style={{ margin: 0, color: '#64748b', fontSize: '0.875rem', maxWidth: 380, lineHeight: 1.6 }}>
          El pago fue rechazado o cancelado. Tu suscripción Trial sigue activa. Podés intentarlo nuevamente cuando quieras.
        </p>
      </div>

      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
        <button
          onClick={() => navigate('/subscription/plans')}
          style={{
            padding: '0.75rem 1.5rem',
            background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
            border: 'none', borderRadius: '0.875rem',
            color: '#fff', fontWeight: 700, fontSize: '0.875rem',
            cursor: 'pointer', fontFamily: F,
            boxShadow: '0 4px 16px rgba(99,102,241,0.3)',
          }}
        >
          Intentar nuevamente
        </button>
        <button
          onClick={() => navigate('/dashboard')}
          style={{
            padding: '0.75rem 1.5rem',
            background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '0.875rem', color: '#94a3b8',
            fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', fontFamily: F,
          }}
        >
          Volver al inicio
        </button>
      </div>
    </div>
  )
}
