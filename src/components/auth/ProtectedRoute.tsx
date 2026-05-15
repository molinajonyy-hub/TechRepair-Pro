import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { RefreshCw } from 'lucide-react'
import { useRef } from 'react'

export function ProtectedRoute() {
  const { isAuthenticated, loading, hasBusinessAccess, profileLoading, profile, profileError } = useAuth()
  const location = useLocation()

  // Una vez que el perfil se cargó exitosamente, jamás lo olvidamos.
  // Esto evita que TOKEN_REFRESHED u otros re-auth temporales desmontenten
  // la página activa (lo que cerraría modales y resetearía estado de UI).
  const profileEverLoadedRef = useRef(false)
  if (profile) profileEverLoadedRef.current = true
  const profileEstablished = profileEverLoadedRef.current

  // Mostrar loading SOLO en la carga inicial (primera vez), nunca en re-auth.
  const isInitialLoad = !profileEstablished
  if (loading || (profileLoading && isInitialLoad) || (isAuthenticated && !profile && !profileError && isInitialLoad)) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        background: 'var(--app-shell-bg)',
      }}>
        <RefreshCw className="animate-spin" size={32} style={{ color: '#6366f1' }} />
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  if (!hasBusinessAccess) {
    return <Navigate to="/no-business" replace />
  }

  return <Outlet />
}
