import { useEffect, useRef, useCallback } from 'react'
import { supabase } from '../lib/supabase'

const IDLE_THRESHOLD_MS  = 5 * 60 * 1000  // 5 min sin actividad = "dormido"
const WAKE_DEBOUNCE_MS   = 4_000           // evitar múltiples disparos seguidos
const AUTO_REFRESH_MS    = 4 * 60 * 1000   // revalidar sesión cada 4 min si está visible

/** Evento global que las páginas escuchan para refrescar su data */
export const APP_WAKE_EVENT = 'app:wake-up'

/** Emite el evento global de wake-up */
export function emitWakeUp() {
  window.dispatchEvent(new CustomEvent(APP_WAKE_EVENT, { detail: { ts: Date.now() } }))
}

/** Suscribirse al wake-up en cualquier componente */
export function useRefreshOnWakeUp(callback: () => void) {
  const cb = useRef(callback)
  cb.current = callback
  useEffect(() => {
    const h = () => cb.current()
    window.addEventListener(APP_WAKE_EVENT, h)
    return () => window.removeEventListener(APP_WAKE_EVENT, h)
  }, [])
}

interface UseAppWakeUpOptions {
  onWakeUp?: () => void
  onSessionExpired?: () => void
  onStatusChange?: (s: AppStatus) => void
}

export type AppStatus =
  | 'online'
  | 'updating'
  | 'offline'
  | 'reconnecting'
  | 'session_expired'

export function useAppWakeUp({ onWakeUp, onSessionExpired, onStatusChange }: UseAppWakeUpOptions = {}) {
  const lastActivityRef  = useRef(Date.now())
  const lastWakeRef      = useRef(0)
  const wakeTimerRef     = useRef<ReturnType<typeof setTimeout>>()
  const autoRefreshTimer = useRef<ReturnType<typeof setInterval>>()
  const statusRef        = useRef<AppStatus>('online')

  const setStatus = useCallback((s: AppStatus) => {
    if (statusRef.current === s) return
    statusRef.current = s
    onStatusChange?.(s)
  }, [onStatusChange])

  /** Valida sesión y refresca datos si la app estuvo inactiva */
  const handleWakeUp = useCallback(async (force = false) => {
    const now = Date.now()
    const idleTime = now - lastActivityRef.current
    const timeSinceLastWake = now - lastWakeRef.current

    if (!force && idleTime < IDLE_THRESHOLD_MS) return
    if (timeSinceLastWake < WAKE_DEBOUNCE_MS) return

    lastWakeRef.current = now

    if (!navigator.onLine) {
      setStatus('offline')
      return
    }

    setStatus('updating')
    if (import.meta.env.DEV) console.log('[WakeUp] App woke up — refreshing session')

    try {
      const { data: { session }, error } = await supabase.auth.getSession()

      if (error || !session) {
        // Intentar renovar token
        const { error: refreshErr } = await supabase.auth.refreshSession()
        if (refreshErr) {
          setStatus('session_expired')
          onSessionExpired?.()
          return
        }
      }

      setStatus('online')
      lastActivityRef.current = Date.now()
      emitWakeUp()
      onWakeUp?.()
      if (import.meta.env.DEV) console.log('[WakeUp] Session OK — data refresh triggered')
    } catch {
      setStatus('reconnecting')
      // Reintentar en 10s
      wakeTimerRef.current = setTimeout(() => handleWakeUp(true), 10_000)
    }
  }, [onWakeUp, onSessionExpired, setStatus])

  /** Actualiza el timestamp de última actividad */
  const recordActivity = useCallback(() => {
    lastActivityRef.current = Date.now()
    if (statusRef.current === 'offline' || statusRef.current === 'reconnecting') {
      handleWakeUp(true)
    }
  }, [handleWakeUp])

  useEffect(() => {
    // ── Eventos de visibilidad y foco ──────────────────────────────────────────
    const onVisible = () => {
      if (document.visibilityState === 'visible') handleWakeUp()
    }
    const onFocus = () => handleWakeUp()
    const onOnline = () => {
      setStatus('reconnecting')
      handleWakeUp(true)
    }
    const onOffline = () => setStatus('offline')

    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)

    // ── Actividad del usuario (debounced) ──────────────────────────────────────
    let activityDebounce: ReturnType<typeof setTimeout>
    const onActivity = () => {
      clearTimeout(activityDebounce)
      activityDebounce = setTimeout(recordActivity, 500)
    }
    window.addEventListener('mousemove', onActivity, { passive: true })
    window.addEventListener('keydown', onActivity, { passive: true })
    window.addEventListener('touchstart', onActivity, { passive: true })

    // ── Auto-refresh cada 4 min mientras está visible ──────────────────────────
    autoRefreshTimer.current = setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        supabase.auth.getSession().then(({ data: { session } }) => {
          if (!session) {
            setStatus('session_expired')
            onSessionExpired?.()
          }
        })
      }
    }, AUTO_REFRESH_MS)

    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('mousemove', onActivity)
      window.removeEventListener('keydown', onActivity)
      window.removeEventListener('touchstart', onActivity)
      clearTimeout(activityDebounce)
      clearTimeout(wakeTimerRef.current)
      clearInterval(autoRefreshTimer.current)
    }
  }, [handleWakeUp, recordActivity, onSessionExpired, setStatus])

  return {
    triggerRefresh: () => handleWakeUp(true),
  }
}
