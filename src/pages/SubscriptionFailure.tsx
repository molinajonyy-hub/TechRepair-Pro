import { useNavigate } from 'react-router-dom'
import { XCircle } from 'lucide-react'

export function SubscriptionFailure() {
  const navigate = useNavigate()

  return (
    <div style={{
      minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: '1.5rem', textAlign: 'center', padding: '2rem',
    }}>
      <div style={{
        width: 72, height: 72, borderRadius: '50%',
        background: 'rgba(239,68,68,0.1)', border: '2px solid rgba(239,68,68,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <XCircle size={32} style={{ color: '#ef4444' }} />
      </div>

      <div>
        <h1 style={{ margin: '0 0 0.5rem', color: 'var(--text-primary)', fontSize: '1.6rem', fontWeight: 800, letterSpacing: '-0.04em' }}>
          No pudimos completar el pago
        </h1>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.875rem', maxWidth: 380, lineHeight: 1.6 }}>
          El pago fue rechazado o cancelado. Tu suscripción Trial sigue activa. Podés intentarlo nuevamente cuando quieras.
        </p>
      </div>

      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
        <button onClick={() => navigate('/subscription/plans')} className="btn btn-primary btn-lift">
          Intentar nuevamente
        </button>
        <button onClick={() => navigate('/dashboard')} className="btn btn-ghost">
          Volver al inicio
        </button>
      </div>
    </div>
  )
}
