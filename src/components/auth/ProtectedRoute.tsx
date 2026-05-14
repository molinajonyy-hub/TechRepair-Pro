import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { RefreshCw } from 'lucide-react'

export function ProtectedRoute() {
  const { isAuthenticated, loading, hasBusinessAccess, profileLoading, profile, profileError } = useAuth()
  const location = useLocation()

  // Wait for BOTH auth and profile to finish loading before any redirect decision.
  // Belt-and-suspenders: also wait if user exists but profile hasn't resolved yet,
  // covering any race window where profileLoading is briefly false before loadProfile starts.
  if (loading || profileLoading || (isAuthenticated && !profile && !profileError)) {
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
