import { Outlet } from 'react-router-dom'
import { useSubscription } from '../../hooks/useSubscription'
import { type PlanFeature } from '../../config/planFeatures'
import { UpgradeRequired } from '../subscription/UpgradeRequired'

interface Props {
  feature: PlanFeature
}

/**
 * Wrapper de ruta que bloquea el acceso si el plan activo no incluye la feature.
 * Usar como elemento de <Route> padre en App.tsx:
 *
 *   <Route element={<ProtectedRouteByFeature feature="arca" />}>
 *     <Route path="/arca" element={<ArcaPage />} />
 *   </Route>
 */
export function ProtectedRouteByFeature({ feature }: Props) {
  const { hasFeature, loading } = useSubscription()

  // Mientras carga, renderizar optimísticamente (evita flash)
  if (loading) return <Outlet />

  if (!hasFeature(feature)) return <UpgradeRequired feature={feature} />

  return <Outlet />
}
