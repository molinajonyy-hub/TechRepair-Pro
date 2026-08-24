import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'
import { usePermissions } from '../hooks/usePermissions'

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
  /**
   * P0-P6 — ¿Este actor puede operar caja?
   *
   * Fuente ÚNICA para esconder toda la superficie de caja. Sin esto cada
   * pantalla repetía su propio criterio (o ninguno) y quedaban botones que
   * llevaban a un `/caja` que después rebotaba.
   *
   * Es la capacidad canónica `finance`, la MISMA que gatea la ruta `/caja` y
   * las policies de lectura financiera. No se deriva del rol: un `tech` con
   * override explícito la tiene, y un `cashier` la tiene por default.
   */
  canUseCaja: boolean
}

// ─── Context ──────────────────────────────────────────────────────────────────

const CajaContext = createContext<CajaContextValue>({
  activeCaja: null,
  isOpen: false,
  cajaId: null,
  loading: true,
  refresh: async () => {},
  canUseCaja: false,
})

// ─── Provider ─────────────────────────────────────────────────────────────────

export function CajaProvider({ children }: { children: ReactNode }) {
  const { businessId } = useAuth()
  const { can } = usePermissions()
  const [activeCaja, setActiveCaja] = useState<ActiveCaja | null>(null)
  const [loading, setLoading] = useState(true)

  // Capacidad canónica para OPERAR caja, la misma que gatea la ruta `/caja`.
  // NO se mira el rol.
  const canUseCaja = can('finance')

  /**
   * Quién necesita CONOCER la caja abierta — que NO es lo mismo que poder
   * operarla.
   *
   * El POS (`ComprobanteProModal`) manda `caja_id` al crear un comprobante,
   * para que la venta quede atada a la sesión de caja abierta. Un `sales` tiene
   * `comprobantes` pero no `finance`: si le cortáramos el fetch, seguiría
   * vendiendo pero sus ventas se registrarían con `caja_id: null` y quedarían
   * fuera del arqueo. Eso sería cambiar el comportamiento CONTABLE, que es
   * justo lo que este hotfix no debe tocar.
   *
   * Así que la lectura se habilita para los dos, y la INTERFAZ de caja se
   * esconde sólo con `canUseCaja`. Son dos preguntas distintas.
   */
  const necesitaConocerCaja = canUseCaja || can('comprobantes')

  const refresh = useCallback(async () => {
    // P0-P6: sin ninguna de las dos capacidades NO se consulta.
    //
    // Este provider envuelve TODA la app y hacía la query en el montaje, en
    // cada `focus` de la ventana y en cada `cash-session-updated`. Para un
    // técnico eso era una consulta permanente a una tabla que no le
    // corresponde, y además alimentaba la UI de caja que este hotfix esconde.
    //
    // Cortar acá es lo que hace que el gate sea real: si sólo escondiéramos los
    // botones, la request seguiría saliendo y el dato seguiría llegando.
    if (!businessId || !necesitaConocerCaja) { setActiveCaja(null); setLoading(false); return }
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
  }, [businessId, necesitaConocerCaja])

  useEffect(() => { refresh() }, [refresh])

  // Re-sync cuando el usuario vuelve al tab (caja abierta en otro tab o ventana)
  useEffect(() => {
    // Sin capacidad no se suscribe a nada: `refresh` ya sería un no-op, pero
    // tampoco tiene sentido dejar listeners colgados por una superficie que
    // este actor no tiene.
    if (!necesitaConocerCaja) return
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    window.addEventListener('cash-session-updated', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('cash-session-updated', onFocus)
    }
  }, [refresh, necesitaConocerCaja])

  return (
    <CajaContext.Provider value={{
      activeCaja,
      isOpen: activeCaja !== null,
      cajaId: activeCaja?.id ?? null,
      loading,
      refresh,
      canUseCaja,
    }}>
      {children}
    </CajaContext.Provider>
  )
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useCaja() {
  return useContext(CajaContext)
}
