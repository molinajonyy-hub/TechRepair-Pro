import { useCallback, useEffect, useRef, useState } from 'react'
import { ArcaService } from '../services/arcaService'
import { logger } from '../lib/logger'
import type { ArcaSelfServiceStatus } from '../lib/arcaStatus'
import { nextArcaStatusRefreshMs } from '../lib/arcaSetupWizard'

/**
 * ARCA Self-Service Phase 2B — lectura viva del estado canónico (Phase 1).
 *
 * Es la ÚNICA fuente del paso del asistente y de las esperas. No guarda progreso propio.
 * Relee el estado:
 *   · al montar y cuando cambia el negocio;
 *   · al volver el foco a la ventana o la pestaña a primer plano;
 *   · al recuperar la conexión;
 *   · cuando vence `retry_not_before` (o cada 10 s si hay un intento en vuelo);
 *   · cuando el llamador lo pide (después de cada mutación).
 *
 * Una respuesta vieja nunca pisa a una más nueva. Un fallo no deja un estado viejo pintado
 * como actual: la UI muestra "no se pudo leer" y no ofrece acciones.
 */
export interface UseArcaSelfServiceStatusReturn {
  status: ArcaSelfServiceStatus | null
  loading: boolean
  failed: boolean
  /** Relee el estado y devuelve el resultado (null si falló). */
  refresh: () => Promise<ArcaSelfServiceStatus | null>
}

/** Evita ráfagas de relectura (focus + visibilitychange llegan juntos). */
const MIN_EVENT_REFRESH_GAP_MS = 1_500
/** Reintento de una lectura fallida (lectura barata, sin ARCA). */
export const ARCA_STATUS_RETRY_AFTER_FAILURE_MS = 30_000

export function useArcaSelfServiceStatus(businessId: string | null | undefined): UseArcaSelfServiceStatusReturn {
  const [status, setStatus] = useState<ArcaSelfServiceStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const requestSeq = useRef(0)
  const lastRefreshAt = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const refresh = useCallback(async (): Promise<ArcaSelfServiceStatus | null> => {
    if (!businessId) return null
    const seq = ++requestSeq.current
    lastRefreshAt.current = Date.now()
    setLoading(true)
    let next: ArcaSelfServiceStatus | null = null
    let error = false
    try {
      next = await ArcaService.getSelfServiceStatus(businessId)
      error = next === null
    } catch (err) {
      logger.error('GENERAL', 'No se pudo leer el estado de ARCA', err)
      error = true
    }
    // Sólo la última lectura pedida se aplica.
    if (mounted.current && seq === requestSeq.current) {
      setStatus(next)
      setFailed(error)
      setLoading(false)
    }
    return next
  }, [businessId])

  // Montaje y cambio de negocio.
  useEffect(() => {
    setStatus(null)
    setFailed(false)
    void refresh()
  }, [refresh])

  // Foco, visibilidad y red.
  useEffect(() => {
    if (!businessId) return
    const onEvent = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (Date.now() - lastRefreshAt.current < MIN_EVENT_REFRESH_GAP_MS) return
      void refresh()
    }
    window.addEventListener('focus', onEvent)
    window.addEventListener('online', onEvent)
    document.addEventListener('visibilitychange', onEvent)
    return () => {
      window.removeEventListener('focus', onEvent)
      window.removeEventListener('online', onEvent)
      document.removeEventListener('visibilitychange', onEvent)
    }
  }, [businessId, refresh])

  // Vencimiento de la espera: se relee; la base decide si terminó. Cada lectura nueva (objeto
  // nuevo) vuelve a armar el temporizador, así un intento en vuelo se sigue consultando.
  // Una lectura fallida se reintenta sola más tarde (nunca se asume que la espera terminó).
  useEffect(() => {
    if (!businessId) return
    const delay = failed ? ARCA_STATUS_RETRY_AFTER_FAILURE_MS : nextArcaStatusRefreshMs(status, Date.now())
    if (delay === null) return
    const timer = window.setTimeout(() => { void refresh() }, delay)
    return () => window.clearTimeout(timer)
  }, [businessId, status, failed, refresh])

  return { status, loading, failed, refresh }
}
