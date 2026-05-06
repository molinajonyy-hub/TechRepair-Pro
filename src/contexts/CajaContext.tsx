import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ActiveCaja {
  id: string
  business_id: string
  opened_at: string
  opened_by: string | null
  status: 'abierta' | 'cerrada'
}

interface CajaContextValue {
  activeCaja: ActiveCaja | null
  isOpen: boolean
  cajaId: string | null
  loading: boolean
  refresh: () => Promise<void>
}

// ─── Context ──────────────────────────────────────────────────────────────────

const CajaContext = createContext<CajaContextValue>({
  activeCaja: null,
  isOpen: false,
  cajaId: null,
  loading: true,
  refresh: async () => {},
})

// ─── Provider ─────────────────────────────────────────────────────────────────

export function CajaProvider({ children }: { children: ReactNode }) {
  const { businessId } = useAuth()
  const [activeCaja, setActiveCaja] = useState<ActiveCaja | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!businessId) { setActiveCaja(null); setLoading(false); return }
    const { data } = await supabase
      .from('cajas')
      .select('id, business_id, opened_at, opened_by, status')
      .eq('business_id', businessId)
      .eq('status', 'abierta')
      .order('opened_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    setActiveCaja((data as ActiveCaja | null) ?? null)
    setLoading(false)
  }, [businessId])

  useEffect(() => { refresh() }, [refresh])

  return (
    <CajaContext.Provider value={{
      activeCaja,
      isOpen: activeCaja !== null,
      cajaId: activeCaja?.id ?? null,
      loading,
      refresh,
    }}>
      {children}
    </CajaContext.Provider>
  )
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useCaja() {
  return useContext(CajaContext)
}
