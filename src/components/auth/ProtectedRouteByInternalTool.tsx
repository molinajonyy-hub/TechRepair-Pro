import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { useInternalToolAccess, type InternalToolKey } from '../../hooks/useInternalToolAccess'
import { colors } from '../../lib/tokens'

/**
 * PRE-BETA-3A-2S — Guard de herramientas INTERNAS (Portal Clic).
 *
 * La autoridad es server-side (public.current_user_has_internal_tool_access) y
 * es la misma que usan el menu y la pagina. No depende de plan, rol del
 * tenant, `wholesale`, system_admins ni wholesale_portal_enabled: quien no es
 * el principal de la herramienta vuelve al dashboard, sin paywall (no hay nada
 * que comprar).
 */
export function ProtectedRouteByInternalTool({ tool }: { tool: InternalToolKey }) {
  const { loading, allowed } = useInternalToolAccess(tool)
  const location = useLocation()

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
        <RefreshCw size={24} className="animate-spin" style={{ color: colors.indigoBright }} />
      </div>
    )
  }
  if (!allowed) return <Navigate to="/dashboard" state={{ from: location }} replace />
  return <Outlet />
}
