import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { useWholesaleAccess } from '../../hooks/useWholesaleAccess'
import { UpgradeRequired } from '../subscription/UpgradeRequired'
import { colors } from '../../lib/tokens'

/**
 * PRE-BETA-3A-2 — Guard de ruta de Mayorista.
 *
 * Reemplaza el par `ProtectedRouteByPermission("wholesale")` +
 * `ProtectedRouteByFeature("mayorista")`, que no podía expresar el contrato:
 * owner/admin entran aunque tengan un override `wholesale: false`.
 *
 * Decide con `useWholesaleAccess`, la misma autoridad que la navegación, la
 * página y el alta de clientes, así que el menú nunca ofrece algo que la ruta
 * rebota (ni al revés).
 *
 *  - cargando       → espera (decidir sobre datos a medio cargar rebota a un
 *                     usuario legítimo, o abre Mayorista a un Básico).
 *  - actor_denied   → dashboard. No se le muestra un upgrade que no puede comprar.
 *  - plan_required  → paywall de la feature.
 */
export function ProtectedRouteByWholesaleAccess() {
  const { loading, decision } = useWholesaleAccess()
  const location = useLocation()

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
        <RefreshCw size={24} className="animate-spin" style={{ color: colors.indigoBright }} />
      </div>
    )
  }

  if (decision === 'actor_denied') {
    return <Navigate to="/dashboard" state={{ from: location, deniedPermission: 'wholesale' }} replace />
  }
  if (decision === 'plan_required') return <UpgradeRequired feature="mayorista" />

  return <Outlet />
}
