import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { RefreshCw } from 'lucide-react'

export function ProtectedRoute() {
  const { isAuthenticated, loading, hasBusinessAccess, profileLoading, profileError } = useAuth()
  const location = useLocation()

  if (loading || (isAuthenticated && profileLoading && !hasBusinessAccess && !profileError)) {
    return (
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center', 
        height: '100vh',
        background: 'var(--app-shell-bg)'
      }}>
        <RefreshCw className="animate-spin" size={32} style={{ color: '#6366f1' }} />
      </div>
    )
  }

  if (!isAuthenticated) {
    // Redirect to login, but save the location they were trying to access
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  if (!hasBusinessAccess) {
    // User is authenticated but has no business access
    return <Navigate to="/no-business" replace />
  }

  return <Outlet />
}
