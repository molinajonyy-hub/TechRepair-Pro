import { useEffect, useState } from 'react'
import type { PermissionKey } from '../config/permissions'
import type { PlanFeature } from '../config/planFeatures'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { usePermissions } from './usePermissions'
import { useSubscription } from './useSubscription'
import { useSystemOwner } from './useSystemOwner'
import { useWholesalePermissions } from './useWholesalePermissions'

export interface NavigationAccess {
  can: (permission: PermissionKey) => boolean
  hasFeature: (feature: PlanFeature) => boolean
  isSystemOwner: boolean
  mayoristaEnabled: boolean
  wholesale: ReturnType<typeof useWholesalePermissions>
}

export interface NavigationGate {
  permission?: PermissionKey
  planFeature?: PlanFeature
  systemOwnerOnly?: boolean
  systemOwnerAlso?: boolean
  wholesaleView?: boolean
  clicPortalManage?: boolean
}

/**
 * Único contrato de autorización visual para Sidebar y navegación móvil.
 * Cada gate es acumulativo (AND), salvo systemOwnerAlso, que habilita sólo el
 * permiso tenant declarado; nunca saltea features ni privilegios SaaS.
 */
export function isNavigationItemAuthorized(
  item: NavigationGate,
  access: NavigationAccess,
): boolean {
  if (item.systemOwnerOnly && !access.isSystemOwner) return false

  // PRE-BETA-3A-2: la MISMA decisión que el guard de `/mayorista`
  // (`useWholesaleAccess`). No se consulta `can('wholesale')` acá: owner/admin
  // entran aunque tengan un override `wholesale: false`. `mayoristaEnabled` es
  // una preferencia de menú del negocio, no una autorización: sólo oculta.
  if (item.wholesaleView) {
    return access.wholesale.canAccess && access.mayoristaEnabled
  }

  // Portal Clic NO es Mayorista: no depende del plan ni de `wholesale`.
  if (item.clicPortalManage) return access.wholesale.canManageClicPortal

  if (item.permission && !access.can(item.permission)) {
    if (!(item.systemOwnerAlso && access.isSystemOwner)) return false
  }
  if (item.planFeature && !access.hasFeature(item.planFeature)) return false
  return true
}

/**
 * Resuelve una sola vez los datos que comparten Sidebar, Más y bottom nav.
 * Así la nueva navegación no agrega otro fetch de subscription/settings.
 */
export function useNavigationAccess(): NavigationAccess {
  const { businessId } = useAuth()
  const { can } = usePermissions()
  const { hasFeature } = useSubscription()
  const { isSystemOwner } = useSystemOwner()
  const wholesale = useWholesalePermissions()
  const [mayoristaEnabled, setMayoristaEnabled] = useState(true)

  useEffect(() => {
    if (!businessId) return
    let active = true

    void supabase
      .from('business_settings')
      .select('mayorista_enabled')
      .eq('business_id', businessId)
      .maybeSingle()
      .then(({ data }) => {
        if (active) setMayoristaEnabled(data?.mayorista_enabled !== false)
      })

    return () => { active = false }
  }, [businessId])

  return { can, hasFeature, isSystemOwner, mayoristaEnabled, wholesale }
}
