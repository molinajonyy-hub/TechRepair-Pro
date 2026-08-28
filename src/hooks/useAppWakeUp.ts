import { useEffect, useRef, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { probeSession } from '../lib/sessionSignal'

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
  onStatusChange?: (s: AppStatus) => void
}

export type AppStatus =
  | 'online'
  | 'updating'
  | 'offline'
  | 'reconnecting'
  /**
   * MOBILE-SESSION-1A — Estado TERMINAL, nunca inferido de la conectividad.
   *
   * Se emite ÚNICAMENTE cuando auth-js confirma que no hay sesión guardada
   * (`probeSession` → `absent`). Es informativo: para entonces auth-js ya emitió
   * `SIGNED_OUT` y `ProtectedRoute` está navegando por su cuenta. Este hook NO
   * navega ni cierra sesión — hacerlo lo convertiría en una segunda autoridad
   * de auth compitiendo con AuthContext.
   */
  | 'session_expired'

export function useAppWakeUp({ onWakeUp, onStatusChange }: UseAppWakeUpOptions = {}) {
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

    // MOBILE-SESSION-1A — Una sola sonda, sin `refreshSession()` extra.
    //
    // `getSession()` YA renueva por dentro cuando el access token está vencido
    // (auth-js `__loadSession` → `_callRefreshToken`). El `refreshSession()` que
    // había acá sólo corría DESPUÉS de que esa renovación fallara, reintentando
    // exactamente lo mismo que acababa de fallar, y su error era lo que se
    // interpretaba como «la sesión venció». Era un segundo bucle de refresh
    // sobre el que ya tiene la librería.
    const probe = await probeSession(() => supabase.auth.getSession())

    // Sesión intacta pero inalcanzable: es un problema de CONEXIÓN. La sesión
    // local no se toca —auth-js la conserva a propósito ante errores
    // reintentables— y no se navega a ningún lado.
    if (probe.kind === 'unreachable') {
      setStatus('reconnecting')
      wakeTimerRef.current = setTimeout(() => handleWakeUp(true), 10_000)
      return
    }

    // Terminal y confirmado por auth-js. Sólo se informa: la navegación es de
    // ProtectedRoute, vía el `SIGNED_OUT` que auth-js ya emitió.
    if (probe.kind === 'absent') {
      setStatus('session_expired')
      return
    }

    setStatus('online')
    lastActivityRef.current = Date.now()

    // Los consumidores del wake-up no pueden degradar el estado de conexión: si
    // un refresco de datos falla, la sesión sigue estando bien y la app sigue
    // `online`. Antes esto vivía dentro del mismo `catch` que la sonda, así que
    // un consumidor roto se reportaba como problema de red.
    try {
      emitWakeUp()
      onWakeUp?.()
      if (import.meta.env.DEV) console.log('[WakeUp] Session OK — data refresh triggered')
    } catch (err) {
      if (import.meta.env.DEV) console.warn('[WakeUp] Un consumidor del wake-up falló', err)
    }
  }, [onWakeUp, setStatus])

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

    // ── Revalidación cada 4 min mientras está visible ──────────────────────────
    //
    // MOBILE-SESSION-1A — Misma clasificación que el wake-up, y por la misma
    // razón: `getSession()` devuelve `session: null` TANTO cuando no hay nada
    // guardado COMO cuando la renovación falló por red, y este intervalo trataba
    // los dos casos como «sesión vencida». Bastaban 4 minutos en una zona sin
    // señal para expulsar a un usuario válido, sin que hubiera tocado nada.
    autoRefreshTimer.current = setInterval(() => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return

      void probeSession(() => supabase.auth.getSession()).then((probe) => {
        // `unreachable` no cambia el estado: es una revalidación de fondo y no
        // hay nada que informar todavía. El wake-up —con su reintento— es el
        // que se ocupa de la reconexión.
        if (probe.kind === 'absent') {
          setStatus('session_expired')
        }
      })
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
  }, [handleWakeUp, recordActivity, setStatus])

  return {
    triggerRefresh: () => handleWakeUp(true),
  }
}
