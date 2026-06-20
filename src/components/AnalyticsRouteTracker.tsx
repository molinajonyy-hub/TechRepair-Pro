/**
 * AnalyticsRouteTracker — mide page views SPA SÓLO en rutas públicas de
 * adquisición (`/landing`, `/onboarding`). Nunca inicializa GA4/Clarity ni envía
 * vistas en la zona privada del SaaS. La deduplicación (misma ruta, StrictMode,
 * HMR) vive en `analytics.trackPageView`.
 */
import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { initLandingAnalytics, isPublicTrackedPath, trackPageView } from '../lib/analytics'

export function AnalyticsRouteTracker() {
  const { pathname, search } = useLocation()

  useEffect(() => {
    if (!isPublicTrackedPath(pathname)) return
    // En rutas públicas: asegura GA4/Clarity cargados y mide la vista.
    initLandingAnalytics()
    trackPageView()
  }, [pathname, search])

  return null
}
