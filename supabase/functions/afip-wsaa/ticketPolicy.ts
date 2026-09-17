/**
 * afip-wsaa — política PURA del Ticket de Acceso (TA). BETA-GATE-1 · Lote C.
 *
 * Sin Deno, sin Supabase, sin node-forge: se testea bajo `deno test` contando operaciones reales de un harness.
 *
 * Qué decide este módulo (y nada más):
 *   1. Si el TA cacheado se reutiliza o hay que intentar renovarlo (`decideTicketUse`). El margen vive en UN lugar:
 *      `WSAA_REFRESH_SAFETY_WINDOW_MS`.
 *   2. Si un TA recibido de WSAA es elegible (`validateIssuedTicket`): mismas reglas que Phase 2A
 *      (`arca-selfservice-setup/wsaa.ts#validateWsaaTicket`). Nunca se inventa un vencimiento.
 *   3. Cómo se clasifica una falla de LoginCms (`classifyWsaaLoginFailure`): `coe.alreadyAuthenticated` sólo cuando
 *      el faultcode SOAP lo dice inequívocamente; definitiva sólo con la allowlist exacta de la especificación; todo lo
 *      demás es ambiguo.
 *
 * Paridad con Phase 2A: `wsaaFaultCode`, `parseWsaaInstant` y `validateIssuedTicket` son copias de la lógica de
 * `arca-selfservice-setup/wsaa.ts`. No se importan de ahí para no acoplar la emisión fiscal al asistente de
 * configuración; `tests/deno/afipWsaaTicketRefresh.test.ts` compara las dos implementaciones sobre un corpus y falla
 * si divergen.
 */

/**
 * Margen de seguridad antes del vencimiento del TA.
 *
 *   remaining >  10 min → reutilizar
 *   remaining <= 10 min → intentar renovar (frontera exacta: 10:00 renueva)
 *   vencido o ausente   → renovar
 *
 * Por qué 10 min: el TA se usa dentro de la MISMA invocación que lo pidió (afip-cae / afip-fe-query), acotada por el
 * techo de pared de una Edge Function (150 s en el plan actual, 400 s en planes pagos), más tolerancia de reloj.
 * La ventana anterior (30 min) pedía LoginCms mientras ARCA todavía consideraba vigente el TA, y ARCA responde
 * `coe.alreadyAuthenticated` a eso.
 */
export const WSAA_REFRESH_SAFETY_WINDOW_MS = 10 * 60 * 1000

/** Vida documentada de un TA (12 h) + 10 min de tolerancia de reloj. Igual que Phase 2A y la base. */
export const WSAA_TICKET_MAX_LIFETIME_MS = 12 * 60 * 60 * 1000 + 10 * 60 * 1000
export const WSAA_TOKEN_MAX = 16384
export const WSAA_SIGN_MAX = 4096

export interface CachedTicket {
  token: string
  sign: string
  expiresMs: number
}

/** TA cacheado en `arca_config`, o null si falta alguna pieza o el vencimiento no es un instante. */
export function cachedTicketFromRow(row: {
  wsaa_token?: unknown
  wsaa_sign?: unknown
  wsaa_token_expires?: unknown
} | null | undefined): CachedTicket | null {
  if (!row) return null
  const token = typeof row.wsaa_token === 'string' ? row.wsaa_token.trim() : ''
  const sign = typeof row.wsaa_sign === 'string' ? row.wsaa_sign.trim() : ''
  const expiresMs = typeof row.wsaa_token_expires === 'string' ? Date.parse(row.wsaa_token_expires) : Number.NaN
  if (!token || !sign || !Number.isFinite(expiresMs)) return null
  return { token, sign, expiresMs }
}

export type TicketState = 'fresh' | 'within_window' | 'expired' | 'missing'

export interface TicketDecision {
  decision: 'reuse' | 'refresh' | 'force_refresh'
  reason: TicketState
  /** ms restantes del TA cacheado; null si no hay TA. */
  remainingMs: number | null
}

export function ticketState(cached: CachedTicket | null, nowMs: number): { state: TicketState; remainingMs: number | null } {
  if (!cached) return { state: 'missing', remainingMs: null }
  const remainingMs = cached.expiresMs - nowMs
  if (remainingMs <= 0) return { state: 'expired', remainingMs }
  if (remainingMs <= WSAA_REFRESH_SAFETY_WINDOW_MS) return { state: 'within_window', remainingMs }
  return { state: 'fresh', remainingMs }
}

/**
 * Decisión temporal. `force_refresh` significa "intentar una renovación aunque el TA sea reutilizable": no promete
 * un TA nuevo (ARCA puede responder `coe.alreadyAuthenticated`).
 */
export function decideTicketUse(input: { nowMs: number; cached: CachedTicket | null; forceRefresh: boolean }): TicketDecision {
  const { state, remainingMs } = ticketState(input.cached, input.nowMs)
  if (input.forceRefresh) return { decision: 'force_refresh', reason: state, remainingMs }
  return { decision: state === 'fresh' ? 'reuse' : 'refresh', reason: state, remainingMs }
}

/** Atajo booleano de la misma regla. */
export function shouldRefreshTa(input: { nowMs: number; cached: CachedTicket | null; forceRefresh: boolean }): boolean {
  return decideTicketUse(input).decision !== 'reuse'
}

/** Un TA cacheado "sigue siendo válido" para recuperar: token, sign y vencimiento posterior a ahora. */
export function usableCachedTicket(cached: CachedTicket | null, nowMs: number): CachedTicket | null {
  return cached && cached.expiresMs > nowMs ? cached : null
}

// ── TA recibido de WSAA ─────────────────────────────────────────────────────────

const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/

/** Instante exacto de un dateTime WSAA (offset explícito, calendario real). Paridad con Phase 2A. */
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

export type IssuedTicketCheck =
  | { ok: true; token: string; sign: string; expiresMs: number }
  | { ok: false }

/**
 * Un TA recibido sólo es elegible con token, sign y un expirationTime EXACTO, posterior a ahora y dentro de la vida
 * documentada. Paridad con `validateWsaaTicket` de Phase 2A. Si no, NO se persiste y NO se inventa vencimiento.
 */
export function validateIssuedTicket(raw: { token?: unknown; sign?: unknown; expirationTime?: unknown }, nowMs: number): IssuedTicketCheck {
  const expiration = parseWsaaInstant(raw.expirationTime)
  const token = typeof raw.token === 'string' ? raw.token.trim() : ''
  const sign = typeof raw.sign === 'string' ? raw.sign.trim() : ''
  if (!token || !sign || token.length > WSAA_TOKEN_MAX || sign.length > WSAA_SIGN_MAX) return { ok: false }
  if (expiration === null || expiration <= nowMs || expiration > nowMs + WSAA_TICKET_MAX_LIFETIME_MS) return { ok: false }
  return { ok: true, token, sign, expiresMs: expiration }
}

// ── Fallas de LoginCms ──────────────────────────────────────────────────────────

/**
 * faultcode local de un sobre SOAP. Exige etiqueta de cierre y un único elemento: truncado, ausente o duplicado →
 * null. Paridad con Phase 2A.
 */
export function wsaaFaultCode(text: string): string | null {
  const re = /<(?:[\w.-]+:)?faultcode\b[^>]*>\s*(?:[\w.-]+:)?([A-Za-z][A-Za-z0-9.]{0,100})\s*<\/(?:[\w.-]+:)?faultcode>/gi
  const matches = [...text.matchAll(re)]
  if (matches.length !== 1) return null
  if ((text.match(/<(?:[\w.-]+:)?faultcode\b/gi) ?? []).length !== 1) return null
  return matches[0][1]
}

export type WsaaLoginStage = 'signing' | 'http' | 'parse'

/**
 * Falla de una etapa de LoginCms. Sólo conserva el faultcode ya validado (no enumerable): el texto crudo de ARCA
 * nunca se guarda, ni se serializa, ni se loguea.
 */
export class WsaaLoginFailure extends Error {
  readonly stage: WsaaLoginStage
  declare readonly fault: string | null
  constructor(stage: WsaaLoginStage, rawForClassification = '') {
    super(`WSAA_LOGIN_${stage.toUpperCase()}`)
    this.name = 'WsaaLoginFailure'
    this.stage = stage
    Object.defineProperty(this, 'fault', { value: stage === 'http' ? wsaaFaultCode(rawForClassification) : null, enumerable: false })
  }
}

/**
 * Faults que WSAA evalúa ANTES de emitir un TA (coincidencia exacta). Misma allowlist que Phase 2A salvo UNA
 * divergencia deliberada: `wsn.unavailable` NO está acá. La especificación de ARCA lo define como servicio
 * momentáneamente fuera de servicio (grupo transitorio, junto con `wsaa.*`), así que es ambiguo: con un TA vigente se
 * sigue sirviendo sin marcar `estado_conexion='error'`. No volver a agregarlo "por paridad" con Phase 2A.
 */
export const WSAA_DEFINITIVE_FAULTS: Readonly<Record<string, string>> = {
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
  'wsn.notFound': 'WSAA_REJECTED',
}

export type LoginFailureClass =
  | { kind: 'already_authenticated'; code: 'WSAA_TICKET_ALREADY_ISSUED' }
  | { kind: 'definitive'; code: string }
  | { kind: 'ambiguous'; code: 'WSAA_RESULT_UNKNOWN' | 'WSAA_RESPONSE_INVALID' }

/**
 * Clasificación fail-closed. `already_authenticated` SÓLO con un `WsaaLoginFailure` de la etapa HTTP cuyo faultcode
 * validado es exactamente `coe.alreadyAuthenticated`. Cualquier otro error —aunque su texto mencione ese código— no
 * habilita la recuperación.
 */
export function classifyWsaaLoginFailure(error: unknown): LoginFailureClass {
  if (!(error instanceof WsaaLoginFailure)) return { kind: 'ambiguous', code: 'WSAA_RESULT_UNKNOWN' }
  if (error.stage === 'signing') return { kind: 'definitive', code: 'SIGNING_FAILED' }
  if (error.stage === 'parse') return { kind: 'ambiguous', code: 'WSAA_RESPONSE_INVALID' }
  if (error.fault === 'coe.alreadyAuthenticated') return { kind: 'already_authenticated', code: 'WSAA_TICKET_ALREADY_ISSUED' }
  if (error.fault && Object.hasOwn(WSAA_DEFINITIVE_FAULTS, error.fault)) {
    return { kind: 'definitive', code: WSAA_DEFINITIVE_FAULTS[error.fault] }
  }
  return { kind: 'ambiguous', code: 'WSAA_RESULT_UNKNOWN' }
}
