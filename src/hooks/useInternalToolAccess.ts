// PRE-BETA-3A-2S — Autoridad de herramientas INTERNAS (hoy: Portal Clic).
//
// No se decide en el cliente: se le pregunta a la base
// (public.current_user_has_internal_tool_access), que compara auth.uid() con el
// UNICO principal activo de la herramienta en el negocio actual. No depende de
// plan, rol del tenant, capacidad `wholesale`, system_admins ni
// wholesale_portal_enabled, y no hay ningun email/UUID/slug en el frontend.
//
// Ruta, menu y pagina de Portal Clic consumen ESTE hook: los tres deciden lo
// mismo. Fail-closed: sin sesion, sin negocio, cargando o ante un error de red,
// la respuesta es "no".

import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { logger } from '../lib/logger'

export type InternalToolKey = 'portal_clic'

export interface InternalToolAccess {
  loading: boolean
  allowed: boolean
}

// Una consulta por (usuario, negocio, herramienta) mientras dure la sesion.
const cache = new Map<string, boolean>()

export function useInternalToolAccess(tool: InternalToolKey): InternalToolAccess {
  const { user, businessId, loading: authLoading, profileLoading } = useAuth()
  const userId = user?.id ?? null
  const ready = authLoading !== true && profileLoading !== true
  const key = userId && businessId ? `${userId}:${businessId}:${tool}` : null

  const [state, setState] = useState<InternalToolAccess>(() =>
    key && cache.has(key) ? { loading: false, allowed: cache.get(key) === true } : { loading: true, allowed: false },
  )

  useEffect(() => {
    if (!ready) { setState({ loading: true, allowed: false }); return }
    if (!key || !businessId) { setState({ loading: false, allowed: false }); return }
    if (cache.has(key)) { setState({ loading: false, allowed: cache.get(key) === true }); return }

    let active = true
    setState({ loading: true, allowed: false })
    void supabase
      .rpc('current_user_has_internal_tool_access', { p_tool_key: tool, p_business_id: businessId })
      .then(({ data, error }) => {
        if (!active) return
        if (error) {
          logger.error('AUTH', 'useInternalToolAccess: la autoridad interna no respondio', error.message)
          setState({ loading: false, allowed: false })
          return
        }
        const allowed = data === true
        cache.set(key, allowed)
        setState({ loading: false, allowed })
      })
    return () => { active = false }
  }, [ready, key, businessId, tool])

  return state
}

/** Solo para tests: la cache vive a nivel de modulo. */
export function __resetInternalToolAccessCache(): void {
  cache.clear()
}
