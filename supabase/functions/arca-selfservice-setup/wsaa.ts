/**
 * arca-selfservice-setup — verificación NO fiscal contra WSAA (LoginCms) con el par PENDIENTE.
 *
 * Usa los helpers de `_shared/wsaaLogin.ts` (copia verbatim de afip-wsaa, fijada por guard).
 * Sólo LoginCms: nunca WSFE, FECAESolicitar ni FECompConsultar.
 *
 * Dos garantías de este módulo:
 *
 * 1. NUNCA se inventa un vencimiento. Un TA sólo es elegible con token, sign y un expirationTime
 *    EXACTO: `YYYY-MM-DDTHH:MM:SS(.fracción)?(Z|±HH:MM)`, posterior a ahora y dentro de la vida
 *    documentada de un TA (12 h, Especificación Técnica WSAA) + 10 min de tolerancia de reloj.
 *    Cualquier otra cosa es `WSAA_RESPONSE_INVALID`. `parseWSAAResponse` (verbatim) devuelve ''
 *    cuando falta el vencimiento: esa cadena vacía se rechaza acá, sin tocar la copia.
 *
 * 2. Cada falla trae una DISPOSICIÓN que la base convierte en espera durable:
 *    - definitive: WSAA respondió con un fault de validación que ocurre ANTES de emitir un TA
 *      (allowlist EXACTA de la especificación) o el pedido nunca salió (firma).
 *    - ticket_active: `coe.alreadyAuthenticated`. Existe un TA vigente que no tenemos.
 *    - ambiguous: el pedido pudo llegar a ARCA y no sabemos si emitió un TA (timeout después del
 *      envío, transporte, 5xx sin fault, fault desconocido o interno, respuesta ilegible, TA con
 *      vencimiento inválido). Nunca se repite a ciegas.
 *    Los faults reales llegan con HTTP 500 (`callWSAA` lanza "WSAA HTTP 500: <primeros 500 chars>").
 *    El error sólo conserva el faultcode ya validado contra la allowlist de formato: el texto
 *    crudo de ARCA (y cualquier token de una respuesta rota) no se guarda en el error.
 */
import { buildTRA, callWSAA, parseWSAAResponse, signTRAWithPEM } from '../_shared/wsaaLogin.ts'

export type WsaaFailureCode =
  | 'WSAA_TICKET_ALREADY_ISSUED'
  | 'WSAA_SERVICE_NOT_AUTHORIZED'
  | 'WSAA_CERTIFICATE_REJECTED'
  | 'WSAA_REJECTED'
  | 'WSAA_UNAVAILABLE'
  | 'SIGNING_FAILED'
  | 'WSAA_RESULT_UNKNOWN'
  | 'WSAA_RESPONSE_INVALID'

export type WsaaDisposition = 'definitive' | 'ticket_active' | 'ambiguous'

export interface WsaaFailure {
  code: WsaaFailureCode
  disposition: WsaaDisposition
  /** Vencimiento EXACTO de un TA recibido pero no elegible (ISO del instante parseado), si lo hubo. */
  observedExpiresAt: string | null
}

export type WsaaLoginStage = 'signing' | 'transport' | 'http' | 'parse' | 'timeout' | 'response'

export class WsaaLoginError extends Error {
  readonly stage: WsaaLoginStage
  /** faultcode local ya validado (p.ej. `coe.notAuthorized`) o null. No enumerable: nunca se serializa. */
  declare readonly fault: string | null
  /** Instante de un vencimiento parseable de un TA rechazado. No enumerable. */
  declare readonly observedExpiresMs: number | null
  constructor(stage: WsaaLoginStage, rawForClassification = '', observedExpiresMs: number | null = null) {
    super(`WSAA_LOGIN_${stage.toUpperCase()}`)
    this.name = 'WsaaLoginError'
    this.stage = stage
    Object.defineProperty(this, 'fault', { value: wsaaFaultCode(rawForClassification), enumerable: false })
    Object.defineProperty(this, 'observedExpiresMs', { value: observedExpiresMs, enumerable: false })
  }
}

export interface WsaaTicket {
  token: string
  sign: string
  /** El expirationTime EXACTO devuelto por WSAA (validado, sin reescribir). */
  expirationTime: string
}

/** Sin abort posible sobre `callWSAA` (verbatim): un timeout corto no agrega seguridad, sólo ambigüedad. */
export const WSAA_TIMEOUT_MS = 90_000
/** Vida documentada de un TA (12 h) + 10 min de tolerancia de reloj. Igual que la base. */
export const WSAA_TICKET_MAX_LIFETIME_MS = 12 * 60 * 60 * 1000 + 10 * 60 * 1000
export const WSAA_TOKEN_MAX = 16384
export const WSAA_SIGN_MAX = 4096

const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/

/**
 * Instante exacto de un dateTime WSAA. Exige offset explícito (sin zona sería hora local ambigua)
 * y campos de calendario reales. null si no es un instante inequívoco.
 */
export function parseWsaaInstant(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const m = ISO_WITH_OFFSET.exec(value)
  if (!m) return null
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number)
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null
  const millis = m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0
  let offsetMinutes = 0
  if (m[8] !== 'Z') {
    const oh = Number(m[10])
    const om = Number(m[11])
    if (oh > 14 || om > 59) return null
    offsetMinutes = (m[9] === '-' ? -1 : 1) * (oh * 60 + om)
  }
  return Date.UTC(year, month - 1, day, hour, minute, second, millis) - offsetMinutes * 60_000
}

/** Un TA sólo es elegible con token, sign y vencimiento exacto dentro de límites. Nunca completa nada. */
export function validateWsaaTicket(raw: { token?: unknown; sign?: unknown; expirationTime?: unknown }, nowMs: number): WsaaTicket {
  const expiration = parseWsaaInstant(raw.expirationTime)
  const token = typeof raw.token === 'string' ? raw.token.trim() : ''
  const sign = typeof raw.sign === 'string' ? raw.sign.trim() : ''
  if (!token || !sign || token.length > WSAA_TOKEN_MAX || sign.length > WSAA_SIGN_MAX) {
    throw new WsaaLoginError('response', '', expiration)
  }
  if (expiration === null || expiration <= nowMs || expiration > nowMs + WSAA_TICKET_MAX_LIFETIME_MS) {
    throw new WsaaLoginError('response', '', expiration)
  }
  return { token, sign, expirationTime: raw.expirationTime as string }
}

/**
 * faultcode local (sin prefijo de namespace) de un sobre SOAP. Exige etiqueta de cierre y un único
 * elemento: truncado, ausente o duplicado → null (se trata como ambiguo).
 */
export function wsaaFaultCode(text: string): string | null {
  const re = /<(?:[\w.-]+:)?faultcode\b[^>]*>\s*(?:[\w.-]+:)?([A-Za-z][A-Za-z0-9.]{0,100})\s*<\/(?:[\w.-]+:)?faultcode>/gi
  const matches = [...text.matchAll(re)]
  if (matches.length !== 1) return null
  if ((text.match(/<(?:[\w.-]+:)?faultcode\b/gi) ?? []).length !== 1) return null
  return matches[0][1]
}

/** Faults de la Especificación Técnica WSAA que WSAA evalúa ANTES de emitir un TA (coincidencia exacta). */
export const WSAA_DEFINITIVE_FAULTS: Readonly<Record<string, WsaaFailureCode>> = {
  'coe.notAuthorized': 'WSAA_SERVICE_NOT_AUTHORIZED',
  'cms.bad': 'WSAA_CERTIFICATE_REJECTED',
  'cms.bad.base64': 'WSAA_CERTIFICATE_REJECTED',
  'cms.cert.notFound': 'WSAA_CERTIFICATE_REJECTED',
  'cms.cert.expired': 'WSAA_CERTIFICATE_REJECTED',
  'cms.cert.untrusted': 'WSAA_CERTIFICATE_REJECTED',
  'cms.cert.invalid': 'WSAA_CERTIFICATE_REJECTED',
  'cms.sign.invalid': 'WSAA_CERTIFICATE_REJECTED',
  'xml.bad': 'WSAA_REJECTED',
  'xml.source.invalid': 'WSAA_REJECTED',
  'xml.destination.invalid': 'WSAA_REJECTED',
  'xml.version.notSupported': 'WSAA_REJECTED',
  'xml.CEE.notAuthorized': 'WSAA_SERVICE_NOT_AUTHORIZED',
  'xml.generationTime.invalid': 'WSAA_REJECTED',
  'xml.expirationTime.expired': 'WSAA_REJECTED',
  'xml.expirationTime.invalid': 'WSAA_REJECTED',
  'wsn.unavailable': 'WSAA_UNAVAILABLE',
  'wsn.notFound': 'WSAA_REJECTED',
}

/** Clasificación acotada y fail-closed: lo que no se reconoce con exactitud es ambiguo. */
export function classifyWsaaFailure(error: unknown): WsaaFailure {
  const ambiguous = (code: WsaaFailureCode, observed: number | null = null): WsaaFailure =>
    ({ code, disposition: 'ambiguous', observedExpiresAt: observed === null ? null : new Date(observed).toISOString() })
  if (!(error instanceof WsaaLoginError)) return ambiguous('WSAA_RESULT_UNKNOWN')
  switch (error.stage) {
    case 'signing': return { code: 'SIGNING_FAILED', disposition: 'definitive', observedExpiresAt: null }
    case 'timeout':
    case 'transport': return ambiguous('WSAA_RESULT_UNKNOWN')
    case 'response': return ambiguous('WSAA_RESPONSE_INVALID', error.observedExpiresMs)
  }
  if (error.fault === 'coe.alreadyAuthenticated') return { code: 'WSAA_TICKET_ALREADY_ISSUED', disposition: 'ticket_active', observedExpiresAt: null }
  if (error.fault && Object.hasOwn(WSAA_DEFINITIVE_FAULTS, error.fault)) {
    return { code: WSAA_DEFINITIVE_FAULTS[error.fault], disposition: 'definitive', observedExpiresAt: null }
  }
  // Fault desconocido/interno, 5xx de gateway o HTML, 200 ilegible: pudo haber un TA.
  return ambiguous(error.stage === 'parse' ? 'WSAA_RESPONSE_INVALID' : 'WSAA_RESULT_UNKNOWN')
}

/**
 * LoginCms con el certificado exacto y la clave pendiente. El ambiente selecciona el endpoint
 * (homologación / producción) igual que afip-wsaa. Devuelve sólo un TA validado.
 */
export async function wsaaLoginWithPendingPair(input: {
  certificatePem: string
  signingKeyPem: string
  ambiente: 'homologacion' | 'produccion'
  service: 'wsfe'
}, now: () => number = Date.now): Promise<WsaaTicket> {
  const tra = buildTRA(input.service)
  let cms: string
  try {
    cms = signTRAWithPEM(tra, input.certificatePem, input.signingKeyPem)
  } catch {
    throw new WsaaLoginError('signing')
  }

  // A partir de acá el pedido pudo salir: toda falla sin fault explícito es ambigua.
  let reply: string
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    reply = await Promise.race([
      callWSAA(cms, input.ambiente),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new WsaaLoginError('timeout')), WSAA_TIMEOUT_MS)
      }),
    ])
  } catch (error) {
    if (error instanceof WsaaLoginError) throw error
    const message = error instanceof Error ? error.message : ''
    if (message.startsWith('WSAA HTTP')) throw new WsaaLoginError('http', message)
    throw new WsaaLoginError('transport')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }

  let parsed: { token: string; sign: string; expirationTime: string }
  try {
    parsed = parseWSAAResponse(reply)
  } catch {
    // parseWSAAResponse sólo conserva el faultstring: el faultcode se toma de la respuesta cruda,
    // que no se guarda en el error.
    throw new WsaaLoginError('parse', reply)
  }
  return validateWsaaTicket(parsed, now())
}
