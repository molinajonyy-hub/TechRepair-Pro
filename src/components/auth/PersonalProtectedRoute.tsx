import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useSubscription } from '../../hooks/useSubscription'
import { Wallet } from 'lucide-react'
import { useRef } from 'react'

/** Mi Guita loading screen — shown while auth resolves on PWA cold-start. */
function PersonalLoadingScreen() {
  return (
    <div style={{
      minHeight: '100dvh',
      background: '#071018',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '1rem',
    }}>
      <div style={{
        width: 64, height: 64, borderRadius: '1.25rem',
        background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.25)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        animation: 'personal-pulse 1.5s ease infinite',
      }}>
        <Wallet size={28} color="#34d399" />
      </div>
      <span style={{ color: '#34d399', fontWeight: 600, fontSize: '0.875rem', letterSpacing: '0.01em' }}>
        Abriendo Mi Guita…
      </span>
      <style>{`@keyframes personal-pulse { 0%,100%{opacity:.6} 50%{opacity:1} }`}</style>
    </div>
  )
}

/** Paywall de Mi Guita para usuarios en plan Básico. */
function MiGuitaPaywall() {
  const navigate = useNavigate()
  return (
    <div style={{
      minHeight: '100dvh',
      background: '#071018',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '2rem 1.25rem',
    }}>
      <div style={{
        maxWidth: 420, width: '100%',
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(52,211,153,0.15)',
        borderRadius: '1.5rem', padding: '2.5rem',
        textAlign: 'center',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.375rem',
      }}>
        {/* Icon */}
        <div style={{
          width: 72, height: 72, borderRadius: '1.25rem',
          background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Wallet size={32} color="#34d399" />
        </div>

        {/* Copy */}
        <div>
          <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.2rem', fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.02em' }}>
            Mi Guita
          </h2>
          <p style={{ margin: '0 0 0.25rem', fontSize: '0.875rem', color: '#64748b', lineHeight: 1.65 }}>
            Disponible desde el plan{' '}
            <strong style={{ color: '#6366f1' }}>Pro</strong>.
          </p>
          <p style={{ margin: 0, fontSize: '0.82rem', color: '#475569', lineHeight: 1.6 }}>
            Gestioná tus finanzas personales, cuentas, tarjetas, ahorros, deudas y sueldo desde una app separada.
          </p>
        </div>

        {/* Tus datos siguen seguros */}
        <div style={{
          width: '100%', padding: '0.75rem 1rem',
          background: 'rgba(52,211,153,0.05)', border: '1px solid rgba(52,211,153,0.1)',
          borderRadius: '0.75rem',
          fontSize: '0.78rem', color: '#4ade80', textAlign: 'left', lineHeight: 1.5,
        }}>
          Tus datos existentes están seguros y se restauran automáticamente al activar Pro.
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem', width: '100%' }}>
          <button
            onClick={() => navigate('/subscription/plans')}
            data-testid="mi-guita-paywall-upgrade"
            style={{
              width: '100%', padding: '0.875rem',
              background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
              border: 'none', borderRadius: '0.875rem',
              color: '#fff', fontWeight: 700, fontSize: '0.9rem',
              cursor: 'pointer', boxShadow: '0 4px 16px rgba(99,102,241,0.35)',
            }}
          >
            Mejorar a Pro
          </button>
          <button
            onClick={() => navigate('/dashboard')}
            style={{
              width: '100%', padding: '0.75rem',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '0.875rem',
              color: '#64748b', fontWeight: 600, fontSize: '0.875rem',
              cursor: 'pointer',
            }}
          >
            Volver al inicio
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * ProtectedRoute variant for /personal/* routes.
 * - Requires authentication (redirects to /login if not).
 * - If user has a business on plan Básico → shows Mi Guita paywall.
 * - Users without a business (no businessId) can always access Mi Guita.
 * - While subscription is loading → renders optimistically to avoid flashes.
 */
export function PersonalProtectedRoute() {
  const { isAuthenticated, loading, profileLoading, profile, profileError, businessId } = useAuth()
  const { hasFeature, loading: subLoading } = useSubscription()
  const location = useLocation()

  // Once profile loaded once, never show loading screen again (same pattern as ProtectedRoute).
  const profileEverLoadedRef = useRef(false)
  if (profile) profileEverLoadedRef.current = true
  const profileEstablished = profileEverLoadedRef.current
  const isInitialLoad = !profileEstablished

  if (loading || (profileLoading && isInitialLoad) || (isAuthenticated && !profile && !profileError && isInitialLoad)) {
    return <PersonalLoadingScreen />
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  // Gate: only check plan when the user has a business AND subscription is resolved.
  // No businessId = allow (standalone PWA user or during onboarding).
  // subLoading = allow optimistically.
  if (businessId && !subLoading && !hasFeature('personal_finance')) {
    return <MiGuitaPaywall />
  }

  return <Outlet />
}
