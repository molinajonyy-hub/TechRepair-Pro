import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { useSystemOwner } from '../../hooks/useSystemOwner'

export function ProtectedRouteBySystemOwner() {
  const { isSystemOwner, loading } = useSystemOwner()
  const location = useLocation()

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
        <RefreshCw size={24} className="animate-spin" style={{ color: '#6366f1' }} />
      </div>
    )
  }

  if (!isSystemOwner) {
    console.log('[ROUTE_BLOCKED]', {
      path: location.pathname,
      reason: 'not_system_owner',
      isSystemOwner,
    })
    return <Navigate to="/dashboard" replace />
  }

  return <Outlet />
}
