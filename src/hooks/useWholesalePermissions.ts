// Hook integrador: cablea el motor PURO de permisos mayoristas
// (src/lib/permissions/wholesalePermissions) con las fuentes de verdad existentes
// (AuthContext + useSubscription) y el dato de owner real / portal habilitado del
// negocio actual. Única fuente de los permisos de UI de Mayorista / Portal Clic.

import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useSubscription } from './useSubscription'
import { supabase } from '../lib/supabase'
import {
  canViewWholesale,
  canManageWholesale,
  isWholesaleReadOnly,
  canManageClicPortal,
} from '../lib/permissions/wholesalePermissions'

export interface WholesalePermissions {
  /** true mientras se resuelven perfil / suscripción / datos del negocio. */
  loading: boolean
  hasMayoristaFeature: boolean
  /** Ve el módulo Mayorista (los 7 roles, con feature + acceso). */
  canView: boolean
  /** Gestiona (escribe) Mayorista (owner/admin/manager/sales). */
  canManage: boolean
  /** Solo lectura (tech/cashier/viewer). */
  isReadOnly: boolean
  /** Administra la config privada de Portal Clic (owner real + portal habilitado). */
  canManageClicPortal: boolean
  isBusinessOwner: boolean
  wholesalePortalEnabled: boolean
}

interface BizRow {
  owner_user_id: string | null
  wholesale_portal_enabled: boolean | null
}

export function useWholesalePermissions(): WholesalePermissions {
  const { user, role, hasBusinessAccess, businessId, profileLoading } = useAuth()
  const { hasFeature, loading: subLoading } = useSubscription()

  const [biz, setBiz] = useState<BizRow | null>(null)
  const [bizLoading, setBizLoading] = useState<boolean>(true)

  useEffect(() => {
    if (!businessId) {
      setBiz(null)
      setBizLoading(false)
      return
    }
    let active = true
    setBizLoading(true)
    supabase
      .from('businesses')
      .select('owner_user_id, wholesale_portal_enabled')
      .eq('id', businessId)
      .maybeSingle()
      .then(({ data }) => {
        if (!active) return
        setBiz((data as BizRow | null) ?? null)
        setBizLoading(false)
      })
    return () => {
      active = false
    }
  }, [businessId])

  const hasMayoristaFeature = hasFeature('mayorista')
  const isBusinessOwner =
    !!user?.id && !!biz?.owner_user_id && user.id === biz.owner_user_id
  const wholesalePortalEnabled = biz?.wholesale_portal_enabled === true
  const loading = profileLoading || subLoading || bizLoading

  return {
    loading,
    hasMayoristaFeature,
    canView: canViewWholesale({ role, hasMayoristaFeature, hasBusinessAccess }),
    canManage: canManageWholesale({ role, hasMayoristaFeature, hasBusinessAccess }),
    isReadOnly: isWholesaleReadOnly({ role, hasMayoristaFeature, hasBusinessAccess }),
    canManageClicPortal: canManageClicPortal({ isBusinessOwner, wholesalePortalEnabled }),
    isBusinessOwner,
    wholesalePortalEnabled,
  }
}
