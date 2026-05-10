import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { supabase } from '../../lib/supabase'
import { getPortalBusiness, getCustomerByAuthId } from '../services/portalService'
import type { PortalBusiness, WholesaleCustomer } from '../types'

interface PortalContextValue {
  business:    PortalBusiness | null
  customer:    WholesaleCustomer | null
  authLoading: boolean
  bizLoading:  boolean
  notFound:    boolean
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

  // Load business config
  useEffect(() => {
    setBizLoading(true)
    getPortalBusiness(slug).then(biz => {
      if (!biz) { setNotFound(true) }
      else { setBusiness(biz) }
      setBizLoading(false)
    })
  }, [slug])

  // Load current auth session → customer profile
  const refresh = useCallback(async () => {
    if (!business) return
    setAuthLoading(true)
    try {
      const c = await getCustomerByAuthId(business.id)
      setCustomer(c)
    } finally {
      setAuthLoading(false)
    }
  }, [business])

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
      business, customer, authLoading, bizLoading, notFound, slug, basePath, refresh, setCustomer,
    }}>
      {children}
    </PortalContext.Provider>
  )
}
