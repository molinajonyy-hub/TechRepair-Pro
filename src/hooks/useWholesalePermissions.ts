// Hook integrador de la pantalla Mayorista y de Portal Clic.
//
// El acceso a Mayorista NO se decide acá: sale de `useWholesaleAccess` (autoridad
// central, PRE-BETA-3A-2). Este hook sólo le suma el dato de owner real / portal
// habilitado del negocio actual, que es lo que gobierna Portal Clic.

import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { canManageClicPortal } from '../lib/permissions/wholesalePermissions'
import { useWholesaleAccess, type WholesaleAccess } from './useWholesaleAccess'

export interface WholesalePermissions extends WholesaleAccess {
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
  const { user, businessId } = useAuth()
  const access = useWholesaleAccess()

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

  const isBusinessOwner =
    !!user?.id && !!biz?.owner_user_id && user.id === biz.owner_user_id
  const wholesalePortalEnabled = biz?.wholesale_portal_enabled === true

  return {
    ...access,
    loading: access.loading || bizLoading,
    canManageClicPortal: canManageClicPortal({ isBusinessOwner, wholesalePortalEnabled }),
    isBusinessOwner,
    wholesalePortalEnabled,
  }
}
