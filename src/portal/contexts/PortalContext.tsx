import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { supabase } from '../../lib/supabase'
import { getPortalBusiness, getCustomerByAuthId, completePendingWholesaleRegistration } from '../services/portalService'
import type { PortalLoadErrorReason } from '../portalPublicContract'
import type { PortalBusiness, WholesaleCustomer } from '../types'

interface PortalContextValue {
  business:    PortalBusiness | null
  customer:    WholesaleCustomer | null
  authLoading: boolean
  bizLoading:  boolean
  /** El slug no existe o el portal está apagado. NO es un error: es una respuesta. */
  notFound:    boolean
  /**
   * Fallo TERMINAL al resolver el portal (permisos, red, 5xx). Distinto de
   * `notFound`: acá el portal probablemente exista y lo que falló es el acceso,
   * así que la pantalla ofrece reintentar en vez de decir «no disponible».
   */
  loadError:   PortalLoadErrorReason | null
  /** Vuelve a consultar la RPC. No recarga la página. */
  retryBusiness: () => void
  slug:        string
  basePath:    string   // '' on portal domain, '/mayorista/:slug' on main domain
  refresh:     () => Promise<void>
  setCustomer: (c: WholesaleCustomer | null) => void
}

const PortalContext = createContext<PortalContextValue | null>(null)

export function usePortal() {
  const ctx = useContext(PortalContext)
  if (!ctx) throw new Error('usePortal must be used inside PortalProvider')
  return ctx
}

interface Props {
  slug:     string
  basePath: string
  children: ReactNode
}

export function PortalProvider({ slug, basePath, children }: Props) {
  const [business,    setBusiness]    = useState<PortalBusiness | null>(null)
  const [customer,    setCustomer]    = useState<WholesaleCustomer | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [bizLoading,  setBizLoading]  = useState(true)
  const [notFound,    setNotFound]    = useState(false)
  const [loadError,   setLoadError]   = useState<PortalLoadErrorReason | null>(null)
  const [retryToken,  setRetryToken]  = useState(0)

  // Load business config
  //
  // `activo` cierra dos agujeros a la vez:
  //   · una respuesta vieja no puede pisar un slug nuevo (el usuario navega de
  //     /mayorista/a a /mayorista/b y la de `a` llega después);
  //   · un reintento en curso no deja el estado del anterior.
  // Y el `finally` garantiza que bizLoading SIEMPRE termina: sin él, un rechazo
  // deja el spinner girando para siempre, que es justamente lo que un 42501
  // provocaría en cada carga con un bundle viejo.
  useEffect(() => {
    let activo = true
    setBizLoading(true)
    setNotFound(false)
    setLoadError(null)

    getPortalBusiness(slug)
      .then(res => {
        if (!activo) return
        if (res.status === 'ok') {
          setBusiness(res.business)
        } else if (res.status === 'unavailable') {
          setBusiness(null)
          setNotFound(true)
        } else {
          // No se guarda ni se muestra `error.message`: el motivo es un enum y
          // el texto sale de un mapa cerrado (PORTAL_ERROR_MESSAGE).
          setBusiness(null)
          setLoadError(res.reason)
        }
      })
      .finally(() => { if (activo) setBizLoading(false) })

    return () => { activo = false }
  }, [slug, retryToken])

  const retryBusiness = useCallback(() => { setRetryToken(t => t + 1) }, [])

  // Load current auth session → customer profile
  const refresh = useCallback(async () => {
    if (!business) return
    setAuthLoading(true)
    try {
      const c = await getCustomerByAuthId(business.id)
      if (c) {
        setCustomer(c)
        return
      }

      // EMAIL VERIFICATION P0 — hay sesión pero no hay fila de cliente.
      //
      // Es el estado en que queda un registro mayorista hecho con Confirm
      // Email ON: el auth user existe desde el signup, pero el alta se
      // posterga hasta tener sesión autenticada. Este es el punto donde eso
      // ocurre, y corre una sola vez porque en el siguiente refresh
      // `getCustomerByAuthId` ya devuelve la fila.
      //
      // `business.id` se resolvió server-side desde el slug; la metadata del
      // usuario sólo aporta el slug y los datos del formulario.
      const completado = await completePendingWholesaleRegistration(business.id, slug)
      setCustomer(completado)
    } finally {
      setAuthLoading(false)
    }
  }, [business, slug])

  useEffect(() => {
    if (!business) return
    void refresh()

    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => {
      void refresh()
    })
    return () => subscription.unsubscribe()
  }, [business, refresh])

  return (
    <PortalContext.Provider value={{
      business, customer, authLoading, bizLoading, notFound, loadError, retryBusiness,
      slug, basePath, refresh, setCustomer,
    }}>
      {children}
    </PortalContext.Provider>
  )
}
