import { useNavigate } from 'react-router-dom'
import { type PlanFeature, FEATURE_REQUIRED_PLAN, PLAN_DISPLAY } from '../../config/planFeatures'
import { useSubscription } from '../../hooks/useSubscription'

interface UpgradeRequiredProps {
  feature: PlanFeature
}

const FEATURE_LABELS: Record<PlanFeature, string> = {
  arca:            'Facturación electrónica ARCA',
  currentAccounts: 'Cuentas corrientes',
  reports:         'Reportes avanzados',
  advancedFinance: 'Finanzas Pro',
  tasks:           'Módulo de tareas',
  advancedRoles:   'Permisos granulares',
  audit:           'Auditoría del sistema',
  multisucursal:   'Multi-sucursal',
  mayorista:       'Módulo mayorista',
}

export function UpgradeRequired({ feature }: UpgradeRequiredProps) {
  const navigate  = useNavigate()
  const { currentPlan, isTrial } = useSubscription()
  const reqPlan   = FEATURE_REQUIRED_PLAN[feature]
  const planStyle = PLAN_DISPLAY[reqPlan]

  return (
    <div style={{
      minHeight: '60vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '3rem 1.5rem',
    }}>
      <div style={{
        maxWidth: 480,
        width: '100%',
        background: '#0f1829',
        border: '1px solid rgba(255,255,255,0.07)',
        borderRadius: '1.25rem',
        padding: '2.5rem',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '1.25rem',
      }}>
        {/* Icon */}
        <div style={{
          width: 64, height: 64,
          borderRadius: '1rem',
          background: 'rgba(99,102,241,0.1)',
          border: '1px solid rgba(99,102,241,0.2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="1.75">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0110 0v4"/>
          </svg>
        </div>

        {/* Copy */}
        <div>
          <p style={{ margin: '0 0 0.5rem', fontWeight: 700, color: '#f1f5f9', fontSize: '1.1rem' }}>
            {FEATURE_LABELS[feature]}
          </p>
          <p style={{ margin: 0, color: '#64748b', fontSize: '0.875rem', lineHeight: 1.6 }}>
            Esta función está disponible en el plan{' '}
            <strong style={{ color: planStyle.color }}>{planStyle.label}</strong>.{' '}
            {currentPlan
              ? `Tu plan actual es ${PLAN_DISPLAY[currentPlan].label}.`
              : isTrial
                ? 'Estás en período de prueba.'
                : 'Actualizá tu plan para desbloquearlo.'}
          </p>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
          <button
            onClick={() => navigate('/subscription/plans')}
            style={{
              padding: '0.75rem 1.5rem',
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
          <button
            onClick={() => navigate(-1)}
            style={{
              padding: '0.75rem 1.5rem',
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '0.75rem',
              color: '#94a3b8',
              fontWeight: 600,
              fontSize: '0.875rem',
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
