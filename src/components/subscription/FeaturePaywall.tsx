/**
 * FeaturePaywall — bloque de upgrade amable para features bloqueadas por plan.
 *
 * Usarlo en línea dentro de una página/sección, no como pantalla completa.
 * Para pantalla completa ver UpgradeRequired.
 */
import { useNavigate } from 'react-router-dom'
import { type PlanId, PLAN_DISPLAY } from '../../config/planFeatures'

export interface FeaturePaywallProps {
  /** Nombre de la feature a mostrar al usuario */
  featureName: string
  /** Plan mínimo requerido */
  requiredPlan: PlanId
  /** Descripción adicional de qué incluye la feature */
  description?: string
  /** Texto del botón primario (default: "Mejorar a Pro") */
  ctaLabel?: string
  /** Callback del botón primario — default navega a /subscription/plans */
  onUpgradeClick?: () => void
  /** Tamaño del bloque: full = full-height, compact = inline card */
  variant?: 'full' | 'compact'
}

export function FeaturePaywall({
  featureName,
  requiredPlan,
  description,
  ctaLabel,
  onUpgradeClick,
  variant = 'full',
}: FeaturePaywallProps) {
  const navigate    = useNavigate()
  const planStyle   = PLAN_DISPLAY[requiredPlan]
  const defaultCta  = `Mejorar a ${planStyle.label}`
  const handleClick = onUpgradeClick ?? (() => navigate('/subscription/plans'))

  if (variant === 'compact') {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: '0.875rem',
        padding: '0.875rem 1.125rem',
        background: 'rgba(99,102,241,0.06)',
        border: '1px solid rgba(99,102,241,0.18)',
        borderRadius: '0.75rem',
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: '0.5rem',
          background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="1.75">
            <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
          </svg>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: '0.82rem', fontWeight: 600, color: '#f1f5f9' }}>
            {featureName}
            <span style={{ marginLeft: '0.375rem', fontSize: '0.7rem', fontWeight: 700, color: planStyle.color,
              background: `${planStyle.color}20`, padding: '0.1rem 0.4rem', borderRadius: '0.25rem' }}>
              {planStyle.label}
            </span>
          </p>
          {description && (
            <p style={{ margin: '0.125rem 0 0', fontSize: '0.75rem', color: '#64748b', lineHeight: 1.4 }}>
              {description}
            </p>
          )}
        </div>
        <button
          onClick={handleClick}
          style={{
            flexShrink: 0, padding: '0.5rem 0.875rem',
            background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
            border: 'none', borderRadius: '0.5rem',
            color: '#fff', fontWeight: 700, fontSize: '0.78rem',
            cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >
          {ctaLabel ?? defaultCta}
        </button>
      </div>
    )
  }

  return (
    <div style={{
      minHeight: '60vh',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '3rem 1.5rem',
    }}>
      <div style={{
        maxWidth: 460, width: '100%',
        background: 'var(--bg-card, #0f1829)',
        border: '1px solid rgba(255,255,255,0.07)',
        borderRadius: '1.25rem', padding: '2.5rem',
        textAlign: 'center',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.25rem',
      }}>
        <div style={{
          width: 64, height: 64, borderRadius: '1rem',
          background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="1.75">
            <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
          </svg>
        </div>

        <div>
          <p style={{ margin: '0 0 0.375rem', fontWeight: 700, color: '#f1f5f9', fontSize: '1.1rem' }}>
            {featureName}
          </p>
          <p style={{ margin: 0, color: '#64748b', fontSize: '0.875rem', lineHeight: 1.65 }}>
            Disponible desde el plan{' '}
            <strong style={{ color: planStyle.color }}>{planStyle.label}</strong>.
            {description ? ` ${description}` : ''}
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
          <button
            onClick={handleClick}
            data-testid="feature-paywall-cta"
            style={{
              padding: '0.75rem 1.5rem',
              background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
              border: 'none', borderRadius: '0.75rem',
              color: '#fff', fontWeight: 700, fontSize: '0.875rem',
              cursor: 'pointer', boxShadow: '0 4px 16px rgba(99,102,241,0.3)',
            }}
          >
            {ctaLabel ?? defaultCta}
          </button>
          <button
            onClick={() => navigate(-1)}
            style={{
              padding: '0.75rem 1.5rem',
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '0.75rem',
              color: '#94a3b8', fontWeight: 600, fontSize: '0.875rem',
              cursor: 'pointer',
            }}
          >
            Volver
          </button>
        </div>
      </div>
    </div>
  )
}
