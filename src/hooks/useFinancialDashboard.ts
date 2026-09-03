/**
 * useFinancialDashboard — snapshot financiero del Dashboard.
 *
 * Dos grupos de carga INDEPENDIENTES, cada uno con su propio effect:
 *
 *   A. General  — depende solo de `businessId`: ventas semana/mes, stock bajo.
 *   B. Caja     — depende de `businessId` + `cajaKey`: movimientos de la caja
 *                 abierta, cobrado del día y desglose por método.
 *
 * Están separados porque `activeCaja` arranca en `null` y se resuelve async: al
 * pasar a UUID cambiaba la identidad del loader único y se refetcheaba TODO,
 * incluidas consultas que no dependen de la caja. Ahora ese cambio solo vuelve a
 * pedir el grupo B.
 *
 * `null` en un valor significa NO DISPONIBLE, no cero. Un error jamás se
 * convierte en $0: ver `financialDashboardLoaders.ts`.
 *
 * React StrictMode se mantiene. En desarrollo puede haber doble montaje
 * intencional; eso no es un retry de red y no se evade con flags globales.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { logger } from '../lib/logger'
import {
  loadGeneral,
  loadCaja,
  type FinanceDashboardPort,
  type GeneralSnapshot,
  type CajaSnapshot,
  type FinanceLoadError,
  type PaymentMethodStat,
  type CajaDayBreakdown,
} from './financialDashboardLoaders'

export type { PaymentMethodStat, CajaDayBreakdown, FinanceLoadError }

// ─── Tipos ────────────────────────────────────────────────────────────────────

/**
 * `null` = no disponible (falló la consulta o todavía no cargó).
 * `0`    = cero informado por la base.
 */
export interface FinancialDashboardData {
  // Grupo caja
  ventasHoy:      number | null
  paymentMethods: PaymentMethodStat[]
  caja:           CajaDayBreakdown | null
  cajaAbierta:    boolean
  // Grupo general
  ventasSemana:   number | null
  ventasMes:      number | null
  stockBajoCount: number | null
}

// ─── Adaptador Supabase del puerto de datos ───────────────────────────────────

const supabasePort: FinanceDashboardPort = {
  ventasDesde: async (businessId, sinceISO) => {
    const { data, error } = await supabase
      .from('comprobante_payments')
      .select('amount_ars')
      .eq('business_id', businessId)
      .gte('date', sinceISO)
      .neq('payment_method', 'cuenta_corriente')
    return { data, error }
  },

  stockBajo: async (businessId) => {
    const { count, error } = await supabase
      .from('inventory')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', businessId)
      .eq('is_active', true)
      .lte('stock_quantity', 5)
      .gt('stock_quantity', 0)
      .eq('tipo', 'product')
    return { data: count ?? null, error }
  },

  movimientosCaja: async (businessId, cajaId) => {
    const { data, error } = await supabase
      .from('financial_movements')
      .select('type, amount_ars, metodo_pago')
      .eq('business_id', businessId)
      .eq('caja_id', cajaId)
    return { data, error }
  },
}

// ─── Cache (una por grupo: se invalidan por separado) ─────────────────────────

const CACHE_TTL = 90_000  // 90s — se invalida rápido para mostrar caja en tiempo real

interface GeneralCache { businessId: string; data: GeneralSnapshot; timestamp: number }
interface CajaCache    { businessId: string; cajaKey: string | null; data: CajaSnapshot; timestamp: number }

let generalCache: GeneralCache | null = null
let cajaCache:    CajaCache    | null = null

export function invalidateFinancialDashboardCache() {
  generalCache = null
  cajaCache = null
}

const fresh = (ts: number) => Date.now() - ts < CACHE_TTL

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useFinancialDashboard(businessId: string | null | undefined, openCajaId?: string | null) {
  const [general,        setGeneral]        = useState<GeneralSnapshot | null>(null)
  const [generalError,   setGeneralError]   = useState<FinanceLoadError | null>(null)
  const [generalLoading, setGeneralLoading] = useState(true)

  const [caja,        setCaja]        = useState<CajaSnapshot | null>(null)
  const [cajaError,   setCajaError]   = useState<FinanceLoadError | null>(null)
  const [cajaLoading, setCajaLoading] = useState(true)

  const cajaKey = openCajaId ?? null

  const mountedRef = useRef(true)
  // Contadores de request: al resolver, solo gana la carga más reciente. Protege
  // contra respuestas obsoletas cuando businessId o cajaKey cambian a mitad de
  // vuelo, y contra el doble montaje de StrictMode.
  const generalReq = useRef(0)
  const cajaReq    = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // ── Grupo A: general (businessId) ──────────────────────────────────────────
  const runGeneral = useCallback(async (force = false) => {
    if (!businessId) { setGeneral(null); setGeneralError(null); setGeneralLoading(false); return }

    if (!force && generalCache && generalCache.businessId === businessId && fresh(generalCache.timestamp)) {
      setGeneral(generalCache.data); setGeneralError(null); setGeneralLoading(false)
      return
    }

    const req = ++generalReq.current
    setGeneralLoading(true)

    const weekAgoISO  = new Date(Date.now() - 7  * 86_400_000).toISOString().slice(0, 10)
    const monthAgoISO = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)

    const res = await loadGeneral(supabasePort, businessId, weekAgoISO, monthAgoISO)

    // Descartar si el componente murió o si ya salió una carga más nueva.
    if (!mountedRef.current || req !== generalReq.current) return

    if (res.error) {
      logger.error('FINANCE', 'No se pudo cargar el resumen general del Dashboard', {
        code: res.error.code, kind: res.error.kind,
      })
      setGeneral(null)
      setGeneralError(res.error)
    } else {
      if (res.data) generalCache = { businessId, data: res.data, timestamp: Date.now() }
      setGeneral(res.data)
      setGeneralError(null)
    }
    setGeneralLoading(false)
  }, [businessId])

  // ── Grupo B: caja (businessId + cajaKey) ───────────────────────────────────
  const runCaja = useCallback(async (force = false) => {
    if (!businessId) { setCaja(null); setCajaError(null); setCajaLoading(false); return }

    if (!force && cajaCache && cajaCache.businessId === businessId && cajaCache.cajaKey === cajaKey && fresh(cajaCache.timestamp)) {
      setCaja(cajaCache.data); setCajaError(null); setCajaLoading(false)
      return
    }

    const req = ++cajaReq.current
    setCajaLoading(true)

    const res = await loadCaja(supabasePort, businessId, cajaKey)

    if (!mountedRef.current || req !== cajaReq.current) return

    if (res.error) {
      logger.error('FINANCE', 'No se pudo cargar la caja del Dashboard', {
        code: res.error.code, kind: res.error.kind,
      })
      setCaja(null)
      setCajaError(res.error)
    } else {
      if (res.data) cajaCache = { businessId, cajaKey, data: res.data, timestamp: Date.now() }
      setCaja(res.data)
      setCajaError(null)
    }
    setCajaLoading(false)
  }, [businessId, cajaKey])

  // Dos effects separados: cajaKey no puede arrastrar al grupo general.
  useEffect(() => { void runGeneral() }, [runGeneral])
  useEffect(() => { void runCaja() },    [runCaja])

  const data: FinancialDashboardData | null = useMemo(() => {
    if (!general && !caja) return null
    return {
      ventasHoy:      caja?.ventasHoy      ?? null,
      paymentMethods: caja?.paymentMethods ?? [],
      caja:           caja?.caja           ?? null,
      cajaAbierta:    caja?.cajaAbierta    ?? (cajaKey !== null),
      ventasSemana:   general?.ventasSemana   ?? null,
      ventasMes:      general?.ventasMes      ?? null,
      stockBajoCount: general?.stockBajoCount ?? null,
    }
  }, [general, caja, cajaKey])

  const refresh = useCallback(() => {
    invalidateFinancialDashboardCache()
    void runGeneral(true)
    void runCaja(true)
  }, [runGeneral, runCaja])

  return {
    data,
    loading: generalLoading || cajaLoading,
    /** Error del grupo de caja (cobrado hoy / caja neta). */
    cajaError,
    /** Error del grupo general (ventas semana-mes / stock bajo). */
    generalError,
    refresh,
  }
}
