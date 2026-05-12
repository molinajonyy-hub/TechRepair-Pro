import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSubscription } from '../../hooks/useSubscription'

export function TrialBanner() {
  const { isTrial, daysUntilTrialEnd } = useSubscription()
  const navigate = useNavigate()
  const [dismissed, setDismissed] = useState(
    () => sessionStorage.getItem('trial_banner_dismissed') === '1'
  )

  if (!isTrial || dismissed) return null
  if (daysUntilTrialEnd !== null && daysUntilTrialEnd <= 0) return null

  const days = daysUntilTrialEnd ?? 14
  const isUrgent = days <= 3

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '0.75rem',
      padding: '0.625rem 1.125rem',
      background: isUrgent
        ? 'linear-gradient(90deg, rgba(245,158,11,0.12), rgba(239,68,68,0.08))'
        : 'linear-gradient(90deg, rgba(99,102,241,0.1), rgba(139,92,246,0.08))',
      borderBottom: `1px solid ${isUrgent ? 'rgba(245,158,11,0.25)' : 'rgba(99,102,241,0.2)'}`,
      fontSize: '0.82rem',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif",
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', minWidth: 0 }}>
        <span style={{ fontSize: '0.9rem', flexShrink: 0 }}>{isUrgent ? '⚠️' : '⏱️'}</span>
        <span style={{ color: isUrgent ? '#fbbf24' : '#94a3b8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {isUrgent
            ? `Tu trial vence en ${days} día${days !== 1 ? 's' : ''}. ¡Actualizá para no perder el acceso!`
            : `Período de prueba: ${days} días restantes con acceso completo al Plan Pro`}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
        <button
          onClick={() => navigate('/subscription/plans')}
          style={{
            padding: '0.3rem 0.875rem',
            background: isUrgent ? '#f59e0b' : '#6366f1',
            border: 'none', borderRadius: '0.5rem',
            color: '#fff', fontWeight: 700, fontSize: '0.75rem',
            cursor: 'pointer', whiteSpace: 'nowrap',
            transition: 'opacity 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.opacity = '0.85'}
          onMouseLeave={e => e.currentTarget.style.opacity = '1'}
        >
          Elegir plan
        </button>
        <button
          onClick={() => { setDismissed(true); sessionStorage.setItem('trial_banner_dismissed', '1') }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', padding: '0.25rem', fontSize: '1rem', lineHeight: 1 }}
          aria-label="Cerrar banner"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
