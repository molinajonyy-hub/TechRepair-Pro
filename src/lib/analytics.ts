/**
 * analytics.ts — Medición de la landing/adquisición pública de TechRepair Pro.
 *
 * ── Qué hace ──────────────────────────────────────────────────────────────────
 *  - Contrato interno: cada evento se empuja como objeto `{ event, ...props }` a
 *    `window.dataLayer`. De esto dependen los tests y posibles integraciones.
 *  - GA4 (gtag.js) opcional vía `VITE_GA_MEASUREMENT_ID`. Cuando está activo, cada
 *    evento se envía además como `gtag('event', name, paramsSanitizados)`.
 *  - Microsoft Clarity opcional vía `VITE_CLARITY_PROJECT_ID`.
 *  - Page views SPA sólo para rutas públicas de adquisición (`/landing`,
 *    `/onboarding`), con `send_page_view:false` para no duplicar la vista inicial.
 *  - Sin dependencias nuevas. No-op total si faltan las variables.
 *
 * ── dataLayer: objetos vs comandos gtag ───────────────────────────────────────
 *  En `window.dataLayer` conviven dos cosas distintas:
 *    1) Nuestros objetos `{ event: '...' }`  → CONTRATO INTERNO (lo leen los tests).
 *       gtag.js (GA4 directo) los IGNORA: no son comandos suyos.
 *    2) Los `arguments` que empuja la función `gtag(...)` → COMANDOS de Google.
 *  ⚠️ El stub DEBE usar la semántica oficial `function(){ dataLayer.push(arguments) }`.
 *     gtag.js sólo procesa entries `[object Arguments]`; si se empuja un array (p. ej.
 *     `(...args) => dataLayer.push(args)`) los comandos se ignoran y NO hay /collect.
 *  ⚠️ NO conectar Google Tag Manager para reenviar los objetos `{ event }` a GA4:
 *     duplicaría cada evento (ya los mandamos con `gtag('event', ...)`).
 *  Cada evento externo lleva `send_to: <measurementId>` para hacer explícito el destino.
 *
 * ── Privacidad ────────────────────────────────────────────────────────────────
 *  A GA4/Clarity sólo viajan claves de una allowlist (`GA_ALLOWED_KEYS`). Nunca se
 *  envían identificadores ni datos personales: `business_id`, `user_id`, email,
 *  teléfono, tokens, ids de Supabase, importes, datos de clientes/órdenes, ni la
 *  URL completa del referrer (sólo su dominio).
 *
 * ── Embudo de conversión ──────────────────────────────────────────────────────
 *    landing_view → hero_trial_click → plan_selected → signup_started → signup_completed
 *  `signup_completed` es la conversión principal.
 *
 * ── Validar GA4 tras el deploy ────────────────────────────────────────────────
 *  En /landing, en Network debe cargar `gtag/js?id=...` y verse hits de collect.
 *  GA → Tiempo real / DebugView. Marcar `signup_completed` como evento clave.
 */

// Extensión .ts explícita: la requiere el runner de tests de Node (TS nativo);
// tsconfig tiene allowImportingTsExtensions y Vite la resuelve sin problema.
import { logger } from './logger.ts'

// ─── Taxonomía de eventos ─────────────────────────────────────────────────────

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

// ─── Host inyectable (permite testear sin DOM real ni dependencias) ────────────

interface ScriptEl { id: string; async: boolean; src: string }
interface AnalyticsDoc {
  getElementById(id: string): unknown | null
  createElement(tag: string): ScriptEl
  getElementsByTagName(tag: string): ArrayLike<{ parentNode: { insertBefore(node: unknown, ref: unknown): void } | null }>
  head?: { appendChild(node: unknown): void }
  title?: string
  referrer?: string
}
export interface AnalyticsLocation { pathname: string; search: string; origin: string }
export interface AnalyticsHost {
  dataLayer?: unknown[]
  gtag?: (...args: unknown[]) => void
  clarity?: ((...args: unknown[]) => void) & { q?: unknown[] }
  location: AnalyticsLocation
  document: AnalyticsDoc
  sessionStorage?: Pick<Storage, 'getItem' | 'setItem'>
  innerWidth?: number
}

// ─── Constantes ───────────────────────────────────────────────────────────────

const ATTR_KEY = 'trp_attribution'
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const
const GA_SCRIPT_ID = 'trp-ga4'
const CLARITY_SCRIPT_ID = 'trp-clarity'
const GA_ID_RE = /^G-[A-Z0-9]+$/

/** Rutas públicas de adquisición que SÍ se miden (nunca la zona privada del SaaS). */
const PUBLIC_TRACKED_PREFIXES = ['/landing', '/onboarding']

/** Único set de parámetros que pueden viajar a GA4/Clarity. Allowlist explícita. */
const GA_ALLOWED_KEYS = new Set<string>([
  'plan', 'source', 'device', 'section', 'step', 'stage', 'index', 'faq_id',
  'utm_source', 'utm_medium', 'utm_campaign', 'referrer_domain',
  'page_path', 'page_location', 'page_title',
])

/** Parámetros comerciales seguros que se conservan en page_path/page_location. */
const SAFE_QUERY_KEYS = new Set<string>([
  'plan', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
])

// ─── Estado de módulo ─────────────────────────────────────────────────────────

let initialized = false
let context: AttributionContext = {}
let lastPageViewKey: string | null = null
/** Measurement ID validado una vez que GA4 quedó configurado; se adjunta como `send_to`. */
let gaMeasurementId: string | null = null

// ─── Helpers de entorno (con `?.` por si import.meta.env no existe fuera de Vite) ─

function envGA(): string | undefined { return import.meta.env?.VITE_GA_MEASUREMENT_ID }
function envClarity(): string | undefined { return import.meta.env?.VITE_CLARITY_PROJECT_ID }

function host(): AnalyticsHost | null {
  return typeof window === 'undefined' ? null : (window as unknown as AnalyticsHost)
}

function domainOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try { return new URL(url).hostname || undefined } catch { return undefined }
}

// ─── Atribución (UTM + referrer + device), primera visita gana ─────────────────

function detectDevice(h: AnalyticsHost): AttributionContext['device'] {
  const width = h.innerWidth || 1280
  if (width < 768) return 'mobile'
  if (width < 1024) return 'tablet'
  return 'desktop'
}

function readAttribution(h: AnalyticsHost): AttributionContext {
  try {
    const stored = h.sessionStorage?.getItem(ATTR_KEY)
    if (stored) return JSON.parse(stored) as AttributionContext
  } catch { /* sessionStorage bloqueado: seguimos en memoria */ }

  const params = new URLSearchParams(h.location.search || '')
  const captured: AttributionContext = {
    referrer: h.document.referrer || undefined,
    device: detectDevice(h),
    landing_path: h.location.pathname || undefined,
  }
  for (const key of UTM_KEYS) {
    const value = params.get(key)
    if (value) captured[key] = value
  }
  try { h.sessionStorage?.setItem(ATTR_KEY, JSON.stringify(captured)) } catch { /* no-op */ }
  return captured
}

// ─── Sanitización para herramientas externas (GA4 / Clarity) ───────────────────

/** Devuelve sólo las claves de la allowlist con valores primitivos. */
export function sanitizeForExternal(props: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(props)) {
    if (!GA_ALLOWED_KEYS.has(k)) continue
    if (v === null || v === undefined) continue
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v
  }
  return out
}

/** Contexto seguro de atribución para adjuntar a eventos externos. */
function externalContext(): Record<string, string> {
  const out: Record<string, string> = {}
  if (context.device) out.device = context.device
  if (context.utm_source) out.utm_source = context.utm_source
  if (context.utm_medium) out.utm_medium = context.utm_medium
  if (context.utm_campaign) out.utm_campaign = context.utm_campaign
  const dom = domainOf(context.referrer)
  if (dom) out.referrer_domain = dom
  return out
}

// ─── Page views SPA ────────────────────────────────────────────────────────────

export function isPublicTrackedPath(pathname: string): boolean {
  return PUBLIC_TRACKED_PREFIXES.some(p => pathname === p || pathname.startsWith(p + '/'))
}

/** page_path/page_location sin hash y con sólo query params comerciales seguros. */
export function buildPageViewParams(loc: AnalyticsLocation, title: string): { page_path: string; page_location: string; page_title: string } {
  const safe = new URLSearchParams()
  for (const [k, v] of new URLSearchParams(loc.search || '').entries()) {
    if (SAFE_QUERY_KEYS.has(k)) safe.append(k, v)
  }
  const qs = safe.toString()
  const page_path = loc.pathname + (qs ? '?' + qs : '')
  return { page_path, page_location: (loc.origin || '') + page_path, page_title: title || '' }
}

// ─── Loaders idempotentes (guard por id de <script> → resisten StrictMode/HMR) ──

export function isValidGaId(id: string | undefined | null): id is string {
  return !!id && GA_ID_RE.test(id)
}

/** Carga gtag.js una sola vez. Devuelve true si lo instaló en esta llamada. */
export function installGA4(h: AnalyticsHost, measurementId: string | undefined | null): boolean {
  if (!isValidGaId(measurementId)) return false
  if (h.document.getElementById(GA_SCRIPT_ID)) return false // ya instalado

  // Semántica EXACTA del snippet oficial. La cola de gtag DEBE recibir el objeto
  // `arguments` (NO un array de rest params): gtag.js sólo procesa como comandos
  // los entries `[object Arguments]`; con un array no dispara la request /collect.
  // Se opera SIEMPRE sobre la MISMA referencia `h.dataLayer` (en el browser
  // h === window, por lo que es window.dataLayer real; nunca se copia el array).
  h.dataLayer = h.dataLayer || []
  if (typeof h.gtag !== 'function') {
    h.gtag = function gtag() {
      // eslint-disable-next-line prefer-rest-params -- gtag.js requiere `arguments`, no un array
      (h.dataLayer as unknown[]).push(arguments)
    }
  }
  h.gtag('js', new Date())
  h.gtag('config', measurementId, { send_page_view: false })
  gaMeasurementId = measurementId

  const script = h.document.createElement('script')
  script.id = GA_SCRIPT_ID
  script.async = true
  script.src = 'https://www.googletagmanager.com/gtag/js?id=' + measurementId
  const first = h.document.getElementsByTagName('script')[0]
  if (first && first.parentNode) first.parentNode.insertBefore(script, first)
  else h.document.head?.appendChild(script)
  return true
}

/** Carga Microsoft Clarity una sola vez. Devuelve true si lo instaló. */
export function installClarity(h: AnalyticsHost, projectId: string | undefined | null): boolean {
  if (!projectId) return false
  if (h.clarity || h.document.getElementById(CLARITY_SCRIPT_ID)) return false
  try {
    const stub = ((...args: unknown[]) => { (stub.q = stub.q || []).push(args) }) as ((...a: unknown[]) => void) & { q?: unknown[] }
    h.clarity = stub
    const script = h.document.createElement('script')
    script.id = CLARITY_SCRIPT_ID
    script.async = true
    script.src = 'https://www.clarity.ms/tag/' + projectId
    const first = h.document.getElementsByTagName('script')[0]
    if (first && first.parentNode) first.parentNode.insertBefore(script, first)
    else h.document.head?.appendChild(script)
    return true
  } catch (err) {
    logger.warn('UI', 'Clarity bootstrap falló', err)
    return false
  }
}

// ─── Emisión de eventos ────────────────────────────────────────────────────────

/**
 * Empuja el objeto interno a dataLayer y, si GA4/Clarity están activos, emite el
 * comando correspondiente. `externalParams` ya debe venir sanitizado.
 */
export function recordEvent(
  h: AnalyticsHost,
  event: string,
  internalPayload: Record<string, unknown>,
  externalParams: Record<string, string | number | boolean>,
  opts: { clarity?: boolean; debug?: boolean } = {},
): void {
  // Contrato interno: objeto `{ event }` (sin send_to/debug_mode).
  h.dataLayer = h.dataLayer || []
  h.dataLayer.push({ event, ...internalPayload })

  // Comando GA4: `send_to` explícito (destino) + `debug_mode` sólo en pruebas.
  if (typeof h.gtag === 'function') {
    const gaParams: Record<string, string | number | boolean> = { ...externalParams }
    if (gaMeasurementId) gaParams.send_to = gaMeasurementId
    if (opts.debug) gaParams.debug_mode = true
    h.gtag('event', event, gaParams)
  }

  if (opts.clarity !== false && typeof h.clarity === 'function') h.clarity('event', event)
}

// ─── API pública ───────────────────────────────────────────────────────────────

/** Inicializa atribución + Clarity + GA4. Idempotente. Sólo en rutas públicas. */
export function initLandingAnalytics(): void {
  if (initialized) return
  initialized = true
  const h = host()
  if (!h) return
  context = readAttribution(h)
  installClarity(h, envClarity())
  installGA4(h, envGA())
  attachDiagnostics(h)
}

/** Registra un evento de conversión: objeto interno + `gtag('event')` sanitizado. */
export function track(event: LandingEvent, props: AnalyticsProps = {}, opts: { debug?: boolean } = {}): void {
  if (!initialized) initLandingAnalytics()
  const h = host()
  if (h) {
    try {
      const internal = { ...context, ...props }
      const external = sanitizeForExternal({ ...externalContext(), ...props })
      recordEvent(h, event, internal, external, { debug: opts.debug })
    } catch (err) {
      logger.warn('UI', `analytics track "${event}" falló`, err)
    }
  }
  logger.info('UI', `analytics: ${event}`, props)
}

/**
 * Diagnóstico GA4 (dev o llamada explícita). Pide el client_id a gtag.js:
 *  - si el callback nunca corre → `config` no se procesó (revisar el stub/cola);
 *  - si devuelve un id → la config corrió y hay que mirar el transporte.
 * No imprime ni persiste el client_id, ni lo envía a ningún servicio propio.
 */
export function getGaClientId(callback: (clientId: string) => void): void {
  const h = host()
  if (!h || !gaMeasurementId || typeof h.gtag !== 'function') return
  h.gtag('get', gaMeasurementId, 'client_id', callback)
}

/** Expone una superficie mínima de diagnóstico para validar el transporte en prod. */
function attachDiagnostics(h: AnalyticsHost): void {
  const target = h as unknown as { __trpAnalytics?: unknown }
  target.__trpAnalytics = {
    clientId: getGaClientId,
    // Dispara un evento puntual con debug_mode:true (visible en GA DebugView) sin
    // dejar toda la producción en modo debug.
    debugEvent: (name: string, params: AnalyticsProps = {}) => track(name as LandingEvent, params, { debug: true }),
  }
}

/**
 * Mide una page view SPA. Sólo en rutas públicas. Dedup contra la última ruta
 * pública enviada (resiste StrictMode/HMR y navegación repetida a la misma ruta).
 * No emite evento de Clarity (Clarity ya rastrea navegación por sí solo).
 */
export function trackPageView(h: AnalyticsHost | null = host(), loc?: AnalyticsLocation, title?: string): void {
  if (!h) return
  const location = loc || h.location
  if (!location || !isPublicTrackedPath(location.pathname)) return

  const params = buildPageViewParams(location, title ?? h.document.title ?? '')
  if (lastPageViewKey === params.page_path) return
  lastPageViewKey = params.page_path

  if (!initialized) initLandingAnalytics()
  recordEvent(h, 'page_view', params, params, { clarity: false })
}

/** Atribución capturada (UTM/referrer/device). Para depuración. */
export function getAttribution(): AttributionContext {
  if (!initialized) initLandingAnalytics()
  return { ...context }
}

/** Resetea el estado de módulo. SÓLO para tests. */
export function resetAnalyticsForTest(): void {
  initialized = false
  context = {}
  lastPageViewKey = null
  gaMeasurementId = null
}
