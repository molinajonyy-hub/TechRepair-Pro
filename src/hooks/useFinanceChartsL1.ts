import { useCallback, useEffect, useRef, useState } from 'react'
import {
  financeChartsService,
  type ChartGranularity,
  type FinanceChartsL1,
} from '../services/financeChartsService'
import { logger } from '../lib/logger'
import { mensajeUsuario } from '../lib/finance/chartsL1Presentation'

// ─── Charts L1 — ciclo de vida del request (§29) ─────────────────────────────
//
// Garantías de este hook:
//   · una sola llamada por cambio de período (no una por render);
//   · la respuesta de un período abandonado se DESCARTA, nunca pisa a la nueva;
//   · el request viejo se aborta al cambiar de período;
//   · un error no se convierte en $0: el estado se distingue de los datos;
//   · sin localStorage como autoridad, sin polling, sin realtime.

export type ChartsStatus =
  | 'idle'
  | 'loading'
  | 'available'
  | 'empty'
  | 'unavailable'
  | 'restricted'

export interface UseFinanceChartsL1Params {
  businessId?: string | null
  periodStart: string
  periodEnd: string
  granularity?: ChartGranularity | 'auto'
}

export interface UseFinanceChartsL1Return {
  data: FinanceChartsL1 | null
  status: ChartsStatus
  error: string | null
  /** true mientras se recarga teniendo datos viejos en pantalla. */
  stale: boolean
  refresh: () => void
}

/** Un período sin ningún movimiento ni cartera ni stock es realmente vacío. */
function isEmptyPayload(d: FinanceChartsL1): boolean {
  return (
    d.summary.net_sales === 0 &&
    d.summary.cogs === 0 &&
    d.summary.operating_expenses === 0 &&
    d.summary.collections === 0 &&
    d.receivables_aging.total === 0 &&
    // SEC-08C fase B: `null` es RESTRINGIDO, no cero. Un período con deuda que
    // no se puede ver NO es un período vacío, así que no cuenta como tal.
    d.payables_aging.total === 0 &&
    d.inventory_capital.inventory_at_cost === 0
  )
}

/** RLS / grants: se dice como lo que es, no como una falla genérica. */
function isRestricted(message: string): boolean {
  return /42501|permission denied|row-level security|not authorized/i.test(message)
}

export function useFinanceChartsL1({
  businessId,
  periodStart,
  periodEnd,
  granularity = 'auto',
}: UseFinanceChartsL1Params): UseFinanceChartsL1Return {
  const [data, setData] = useState<FinanceChartsL1 | null>(null)
  const [status, setStatus] = useState<ChartsStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)

  // Token monotónico: sólo la respuesta del request MÁS RECIENTE puede escribir
  // estado. Es la barrera contra el race clásico de "período viejo llega tarde".
  const requestId = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  // Espejo de "ya hay algo en pantalla". Se lee dentro del efecto sin meter
  // `data` en las dependencias (que lo haría re-disparar con cada respuesta).
  const hasDataRef = useRef(false)
  const [nonce, setNonce] = useState(0)

  const refresh = useCallback(() => setNonce(n => n + 1), [])

  useEffect(() => {
    if (!businessId || !periodStart || !periodEnd) {
      setStatus('idle')
      return
    }

    const myId = ++requestId.current

    // El request anterior ya no le importa a nadie.
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    // Si ya hay datos en pantalla, se marcan como viejos en vez de vaciarlos:
    // parpadear a "cargando" en cada cambio de período es peor UX que mostrar
    // el dato anterior atenuado.
    setStale(hasDataRef.current)
    setStatus(s => (s === 'available' ? s : 'loading'))
    setError(null)

    let cancelled = false

    void financeChartsService
      .fetch({ businessId, periodStart, periodEnd, granularity, signal: controller.signal })
      .then(payload => {
        if (cancelled || myId !== requestId.current) return   // respuesta obsoleta
        if (!payload.ok) {
          logger.error('FINANCE', 'Charts L1: contrato rechazó los parámetros', { error: payload.error })
          setStatus('unavailable')
          // Sólo se muestra lo que la RPC declara como error de contrato; el
          // código crudo no es texto de interfaz.
          setError(mensajeUsuario(payload.error))
          return
        }
        setData(payload)
        hasDataRef.current = true
        setStatus(isEmptyPayload(payload) ? 'empty' : 'available')
      })
      .catch((e: unknown) => {
        if (cancelled || myId !== requestId.current) return
        if (controller.signal.aborted) return                  // cambio de período
        const msg = e instanceof Error ? e.message : 'Error al cargar los gráficos'
        // El detalle técnico se registra, no se pinta. Un mensaje de PostgREST
        // ("Could not find the function public.… in the schema cache") no le
        // dice nada al usuario y filtra internals.
        logger.error('FINANCE', 'Charts L1: carga fallida', { message: msg })
        setStatus(isRestricted(msg) ? 'restricted' : 'unavailable')
        setError(null)
      })
      .finally(() => {
        if (cancelled || myId !== requestId.current) return
        setStale(false)
      })

    return () => {
      cancelled = true
      controller.abort()
    }
    // `data` queda fuera a propósito: incluirlo re-dispararía el efecto con
    // cada respuesta y entraría en loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId, periodStart, periodEnd, granularity, nonce])

  return { data, status, error, stale, refresh }
}
