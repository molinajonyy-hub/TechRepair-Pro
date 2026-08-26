/**
 * P0 FIRST-STEPS-1 — estado de "Primeros pasos".
 *
 * REFRESCO (§15): estado fresco al montar el Dashboard, al volver a él, y al
 * volver a la pestaña. Se usa `visibilitychange` con throttle, NO realtime: un
 * checklist de onboarding no justifica una subscription — y menos cinco, una
 * por tabla fuente.
 *
 * DISMISS (§14): `localStorage` sobrevive SÓLO como preferencia local de UI
 * ("no me lo muestres más en este navegador"). Nunca como afirmación de que
 * una acción del negocio ocurrió. Por eso la clave es nueva y distinta de la
 * vieja `onboarding_done_*`, que sí era una (mala) fuente de completitud.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { firstStepsService, type FirstSteps } from '../services/firstStepsService'

/** Preferencia local de UI. NO es estado del negocio. */
export const dismissKey = (businessId: string) => `first_steps_dismissed_${businessId}`

/** Ventana mínima entre refetches disparados por foco, en ms. */
const REFRESH_THROTTLE_MS = 60_000

export interface UseFirstStepsReturn {
  steps:     FirstSteps | null
  loading:   boolean
  /** `true` si el usuario ocultó la tarjeta en este navegador. */
  dismissed: boolean
  dismiss:   () => void
  refresh:   () => void
}

export function useFirstSteps(): UseFirstStepsReturn {
  const { businessId } = useAuth()

  const [steps, setSteps]         = useState<FirstSteps | null>(null)
  const [loading, setLoading]     = useState(true)
  const [dismissed, setDismissed] = useState(false)

  const lastFetchRef = useRef(0)
  const aliveRef     = useRef(true)

  // Lee la preferencia local al cambiar de negocio. El acceso a localStorage se
  // protege: en modo privado o con cookies bloqueadas puede tirar.
  useEffect(() => {
    if (!businessId) { setDismissed(false); return }
    try {
      setDismissed(localStorage.getItem(dismissKey(businessId)) === 'true')
    } catch {
      setDismissed(false)
    }
  }, [businessId])

  const load = useCallback(async () => {
    if (!businessId) { setSteps(null); setLoading(false); return }
    lastFetchRef.current = Date.now()
    const data = await firstStepsService.get()
    if (!aliveRef.current) return
    setSteps(data)
    setLoading(false)
  }, [businessId])

  // Montaje y remontaje (volver al Dashboard, refresh, login, otro dispositivo).
  useEffect(() => {
    aliveRef.current = true
    setLoading(true)
    void load()
    return () => { aliveRef.current = false }
  }, [load])

  // Volver a la pestaña. Throttled: sin esto, alt-tabear dispara una RPC por vez.
  useEffect(() => {
    if (!businessId) return
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastFetchRef.current < REFRESH_THROTTLE_MS) return
      void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [businessId, load])

  const dismiss = useCallback(() => {
    setDismissed(true)
    if (!businessId) return
    try {
      localStorage.setItem(dismissKey(businessId), 'true')
    } catch {
      // Sin storage la tarjeta simplemente reaparece en la próxima visita.
      // Es una preferencia, no un dato que debamos garantizar.
    }
  }, [businessId])

  const refresh = useCallback(() => { void load() }, [load])

  return { steps, loading, dismissed, dismiss, refresh }
}
