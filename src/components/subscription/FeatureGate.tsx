import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSubscription } from '../../hooks/useSubscription'
import { type PlanFeature, FEATURE_REQUIRED_PLAN, PLAN_DISPLAY } from '../../config/planFeatures'

// ─── UpgradeCard ──────────────────────────────────────────────────────────────

interface UpgradeCardProps {
  feature: PlanFeature
  compact?: boolean
}

export function UpgradeCard({ feature, compact = false }: UpgradeCardProps) {
  const navigate  = useNavigate()
  const reqPlan   = FEATURE_REQUIRED_PLAN[feature]
  const planStyle = PLAN_DISPLAY[reqPlan]

  if (compact) {
    return (
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
        padding: '0.4rem 0.875rem',
        background: 'rgba(99,102,241,0.08)',
        border: '1px solid rgba(99,102,241,0.2)',
        borderRadius: '0.625rem',
        fontSize: '0.78rem', color: '#818cf8', fontWeight: 600,
      }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0110 0v4"/>
        </svg>
        Plan {planStyle.label}
        <button
          onClick={() => navigate('/subscription/plans')}
          style={{ background: 'rgba(99,102,241,0.15)', border: 'none', borderRadius: '0.375rem', padding: '0.15rem 0.5rem', color: '#818cf8', fontSize: '0.7rem', fontWeight: 700, cursor: 'pointer' }}
        >
          Actualizar
        </button>
      </div>
    )
  }

  return (
    <div style={{
      padding: '2rem 1.5rem',
      background: 'rgba(99,102,241,0.05)',
      border: '1px solid rgba(99,102,241,0.18)',
      borderRadius: '1rem',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      textAlign: 'center',
      gap: '1rem',
      maxWidth: 420,
      margin: '2rem auto',
    }}>
      {/* Lock icon */}
      <div style={{
        width: 52, height: 52, borderRadius: '0.875rem',
        background: 'rgba(99,102,241,0.1)',
        border: '1px solid rgba(99,102,241,0.2)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="2">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0110 0v4"/>
        </svg>
      </div>

      <div>
        <p style={{ margin: '0 0 0.375rem', fontWeight: 700, color: '#e2e8f0', fontSize: '0.975rem' }}>
          Disponible en Plan{' '}
          <span style={{ color: planStyle.color }}>{planStyle.label}</span>
        </p>
        <p style={{ margin: 0, fontSize: '0.82rem', color: '#64748b', lineHeight: 1.55 }}>
          Actualizá tu plan para acceder a esta función y a muchas más.
        </p>
      </div>

      <button
        onClick={() => navigate('/subscription/plans')}
        style={{
          padding: '0.75rem 1.75rem',
          background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
          border: 'none',
          borderRadius: '0.75rem',
          color: '#fff',
          fontWeight: 700,
          fontSize: '0.875rem',
          cursor: 'pointer',
          boxShadow: '0 4px 16px rgba(99,102,241,0.3)',
          transition: 'opacity 0.15s',
        }}
        onMouseEnter={e => e.currentTarget.style.opacity = '0.88'}
        onMouseLeave={e => e.currentTarget.style.opacity = '1'}
      >
        Ver planes
      </button>
    </div>
  )
}

// ─── FeatureGate ──────────────────────────────────────────────────────────────

interface FeatureGateProps {
  feature:      PlanFeature
  children:     ReactNode
  /** Qué mostrar si no tiene acceso. Default: UpgradeCard */
  fallback?:    ReactNode
  /** Si true, muestra UpgradeCard compacta en lugar de la completa */
  compact?:     boolean
  /** Si true, renderiza null silenciosamente (no muestra nada) */
  silent?:      boolean
}

export function FeatureGate({ feature, children, fallback, compact, silent }: FeatureGateProps) {
  const { hasFeature, loading } = useSubscription()

  // Mientras carga, mostrar los hijos (optimista — evita flashes)
  if (loading) return <>{children}</>

  if (hasFeature(feature)) return <>{children}</>

  if (silent) return null
  if (fallback !== undefined) return <>{fallback}</>
  return <UpgradeCard feature={feature} compact={compact} />
}
