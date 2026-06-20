/**
 * analytics.ts — Capa de medición liviana para la landing pública.
 *
 * Objetivos de diseño:
 *  - Sin dependencias nuevas. Funciona aunque no haya ninguna herramienta cargada.
 *  - No-op seguro: si no hay `dataLayer`, `clarity` ni `gtag`, igual no rompe.
 *  - Microsoft Clarity opcional vía `VITE_CLARITY_PROJECT_ID` (no se hardcodea ningún id).
 *  - Captura de atribución (UTM + referrer + device) persistida en sessionStorage
 *    para que todos los eventos de la sesión la lleven.
 *
 * Eventos preparados (taxonomía de conversión de la landing):
 *   landing_view, hero_trial_click, hero_product_demo_click,
 *   journey_section_reached, journey_step_interaction,
 *   pricing_section_reached, plan_selected, faq_opened,
 *   signup_started, signup_completed
 *
 * Integración: la landing llama `initLandingAnalytics()` una vez y luego `track(...)`.
 * Si en el futuro se agrega GA4 / PostHog, este módulo ya empuja a `window.dataLayer`
 * y a `gtag`, por lo que no requiere cambios en los componentes.
 */

import { logger } from './logger'

// ─── Tipos ──────────────────────────────────────────────────────────────────

export type LandingEvent =
  | 'landing_view'
  | 'hero_trial_click'
  | 'hero_product_demo_click'
  | 'journey_section_reached'
  | 'journey_step_interaction'
  | 'pricing_section_reached'
  | 'plan_selected'
  | 'faq_opened'
  | 'signup_started'
  | 'signup_completed'

export type AnalyticsProps = Record<string, string | number | boolean | null | undefined>

interface AttributionContext {
  utm_source?: string
  utm_medium?: string
  utm_campaign?: string
  utm_term?: string
  utm_content?: string
  referrer?: string
  device?: 'mobile' | 'tablet' | 'desktop'
  landing_path?: string
}

// Acceso laxo a globals opcionales sin augmentar el tipo `Window` global del proyecto.
interface AnalyticsWindow {
  dataLayer?: unknown[]
  clarity?: (...args: unknown[]) => void
  gtag?: (...args: unknown[]) => void
}

const ATTR_KEY = 'trp_attribution'
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const

let initialized = false
let context: AttributionContext = {}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getWindow(): (Window & AnalyticsWindow) | null {
  return typeof window === 'undefined' ? null : (window as Window & AnalyticsWindow)
}

function detectDevice(): AttributionContext['device'] {
  const w = getWindow()
  if (!w) return undefined
  const width = w.innerWidth || 1280
  if (width < 768) return 'mobile'
  if (width < 1024) return 'tablet'
  return 'desktop'
}

function readAttribution(): AttributionContext {
  const w = getWindow()
  if (!w) return {}

  // Reutiliza la atribución ya capturada en esta sesión (primera visita gana).
  try {
    const stored = w.sessionStorage?.getItem(ATTR_KEY)
    if (stored) return JSON.parse(stored) as AttributionContext
  } catch {
    /* sessionStorage puede estar bloqueado — seguimos con captura en memoria */
  }

  const params = new URLSearchParams(w.location.search)
  const captured: AttributionContext = {
    referrer: w.document.referrer || undefined,
    device: detectDevice(),
    landing_path: w.location.pathname || undefined,
  }
  for (const key of UTM_KEYS) {
    const value = params.get(key)
    if (value) captured[key] = value
  }

  try {
    w.sessionStorage?.setItem(ATTR_KEY, JSON.stringify(captured))
  } catch {
    /* no-op */
  }
  return captured
}

/**
 * Carga Microsoft Clarity sólo si hay project id en el entorno.
 * No-op completo cuando `VITE_CLARITY_PROJECT_ID` no está definido.
 */
function bootstrapClarity(): void {
  const projectId = import.meta.env.VITE_CLARITY_PROJECT_ID as string | undefined
  const w = getWindow()
  if (!projectId || !w || w.clarity) return

  try {
    // Snippet oficial de Clarity, parametrizado por env (sin id hardcodeado).
    type ClarityFn = ((...args: unknown[]) => void) & { q?: unknown[] }
    const win = w as unknown as { clarity?: ClarityFn }
    const stub = ((...args: unknown[]) => {
      (stub.q = stub.q || []).push(args)
    }) as ClarityFn
    win.clarity = stub

    const doc = w.document
    const script = doc.createElement('script')
    script.async = true
    script.src = 'https://www.clarity.ms/tag/' + projectId
    const firstScript = doc.getElementsByTagName('script')[0]
    firstScript?.parentNode?.insertBefore(script, firstScript)
  } catch (err) {
    logger.warn('UI', 'Clarity bootstrap falló', err)
  }
}

// ─── API pública ────────────────────────────────────────────────────────────

/** Inicializa atribución + Clarity. Idempotente. Llamar una vez al montar la landing. */
export function initLandingAnalytics(): void {
  if (initialized) return
  initialized = true
  context = readAttribution()
  bootstrapClarity()
}

/**
 * Registra un evento. Empuja a `dataLayer`, a `gtag` y a `clarity` si existen.
 * Siempre seguro: si no hay nada configurado, sólo loguea en desarrollo.
 */
export function track(event: LandingEvent, props: AnalyticsProps = {}): void {
  if (!initialized) initLandingAnalytics()

  const payload = { event, ...context, ...props }
  const w = getWindow()

  if (w) {
    try {
      w.dataLayer = w.dataLayer || []
      w.dataLayer.push(payload)
      if (typeof w.gtag === 'function') w.gtag('event', event, props)
      if (typeof w.clarity === 'function') w.clarity('event', event)
    } catch (err) {
      logger.warn('UI', `analytics track "${event}" falló`, err)
    }
  }

  logger.info('UI', `analytics: ${event}`, props)
}

/** Devuelve la atribución capturada (UTM/referrer/device). Útil para depurar. */
export function getAttribution(): AttributionContext {
  if (!initialized) initLandingAnalytics()
  return { ...context }
}
