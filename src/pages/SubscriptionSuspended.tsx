/**
 * SubscriptionSuspended.tsx
 *
 * Full-screen wall shown when subscription_status = suspended | canceled.
 * Blocks access to the rest of the app.
 */
import { useNavigate } from 'react-router-dom'
import { Lock, Zap, LogOut } from 'lucide-react'
import { useSubscription } from '../hooks/useSubscription'
import { useAuth } from '../contexts/AuthContext'
import { STATUS_LABELS, type SubscriptionStatus } from '../types/subscription'

export function SubscriptionSuspended() {
  const navigate = useNavigate()
  const { signOut } = useAuth()
  const { subscription } = useSubscription()
  const status = (subscription?.subscription_status as SubscriptionStatus) || 'suspended'

  const isCanceled = status === 'canceled'

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: '100vh', background: 'var(--app-shell-bg)',
      flexDirection: 'column', gap: '2rem', padding: '2rem', textAlign: 'center',
    }}>
      {/* Icon */}
      <div style={{
        width: 96, height: 96, borderRadius: '50%',
        background: isCanceled ? 'rgba(148,163,184,0.12)' : 'rgba(248,113,113,0.12)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Lock size={44} color={isCanceled ? '#94a3b8' : '#f87171'} />
      </div>

      {/* Title */}
      <div style={{ maxWidth: 500 }}>
        <h1 style={{ color: 'var(--text-primary)', margin: '0 0 1rem', fontSize: '1.75rem', fontWeight: 700 }}>
          {isCanceled ? 'Suscripción cancelada' : 'Cuenta suspendida'}
        </h1>
        <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: '1rem', lineHeight: 1.6 }}>
          {isCanceled
            ? 'Tu suscripción fue cancelada. Para volver a usar TechRepair Pro, reactivá tu plan.'
            : 'Tu suscripción fue suspendida por falta de pago. Para restaurar el acceso, actualizá tu método de pago o elegí un nuevo plan.'}
        </p>
      </div>

      {/* Status badge */}
      <span className={isCanceled ? 'badge badge-neutral' : 'badge badge-error'} style={{ fontSize: '0.875rem', padding: '0.375rem 0.875rem' }}>
        {STATUS_LABELS[status]}
      </span>

      {/* Actions */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem', width: '100%', maxWidth: 320 }}>
        <button
          onClick={() => navigate('/subscription/plans')}
          className="btn btn-primary btn-lift"
          style={{ justifyContent: 'center', padding: '0.875rem', fontSize: '1rem' }}
        >
          <Zap size={18} />
          {isCanceled ? 'Reactivar mi cuenta' : 'Ver planes y reactivar'}
        </button>

        <button
          onClick={() => signOut()}
          className="btn btn-ghost"
          style={{ justifyContent: 'center', padding: '0.75rem' }}
        >
          <LogOut size={16} />
          Cerrar sesión
        </button>
      </div>

      <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', maxWidth: 400 }}>
        ¿Necesitás ayuda? Contactanos en soporte@techrepairpro.com
      </p>
    </div>
  )
}
