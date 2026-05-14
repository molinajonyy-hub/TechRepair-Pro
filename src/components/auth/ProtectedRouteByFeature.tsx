import { Outlet, useLocation } from 'react-router-dom'
import { useSubscription } from '../../hooks/useSubscription'
import { type PlanFeature } from '../../config/planFeatures'
import { UpgradeRequired } from '../subscription/UpgradeRequired'

interface Props {
  feature: PlanFeature
}

export function ProtectedRouteByFeature({ feature }: Props) {
  const { hasFeature, loading, currentPlan, planFeatures } = useSubscription()
  const location = useLocation()

  // Mientras carga, renderizar optimísticamente (evita flash)
  if (loading) return <Outlet />

  if (!hasFeature(feature)) {
    console.log('[ROUTE_BLOCKED]', {
      path:            location.pathname,
      requiredFeature: feature,
      currentPlan,
      hasFeature:      false,
      planFeatures,
    })
    return <UpgradeRequired feature={feature} />
  }

  return <Outlet />
}
