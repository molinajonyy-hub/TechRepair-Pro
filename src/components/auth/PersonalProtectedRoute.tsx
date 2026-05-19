import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
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

/**
 * ProtectedRoute variant for /personal/* routes.
 * Only requires authentication — does NOT require hasBusinessAccess.
 * This lets users without an active business still use Mi Guita.
 *
 * Loading behavior mirrors ProtectedRoute to prevent redirect race conditions
 * when the PWA cold-starts and the session is being restored from localStorage.
 */
export function PersonalProtectedRoute() {
  const { isAuthenticated, loading, profileLoading, profile, profileError } = useAuth()
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

  return <Outlet />
}
