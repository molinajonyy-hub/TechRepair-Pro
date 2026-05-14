import { Navigate, Outlet } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { useSystemOwner } from '../../hooks/useSystemOwner'

export function ProtectedRouteBySystemOwner() {
  const { isSystemOwner, loading } = useSystemOwner()

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
        <RefreshCw size={24} className="animate-spin" style={{ color: '#6366f1' }} />
      </div>
    )
  }

  if (!isSystemOwner) {
    return <Navigate to="/dashboard" replace />
  }

  return <Outlet />
}
