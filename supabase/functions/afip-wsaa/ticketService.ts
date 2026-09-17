/**
 * afip-wsaa — orquestación del Ticket de Acceso. BETA-GATE-1 · Lote C.
 *
 * Todas las dependencias se inyectan (lectura de `arca_config`, LoginCms, persistencia, marca de error, reloj, log),
 * así que `tests/deno/afipWsaaTicketRefresh.test.ts` cuenta operaciones reales en vez de mirar HTTP 200.
 *
 * Contrato
 *   · reuse     TA con más de `WSAA_REFRESH_SAFETY_WINDOW_MS` restante → 0 LoginCms.
 *   · refresh   TA dentro de la ventana, vencido o ausente → 1 intento de LoginCms.
 *   · force     `force_refresh` (sólo caller internal, validado en authorizationBoundary.ts) → 1 intento aunque el TA
 *               sea reutilizable. No promete un TA nuevo.
 *   · dedupe    pedidos concurrentes del MISMO negocio en el MISMO worker comparten un único intento.
 *               Entre workers distintos puede haber más de uno: aceptado en BETA-GATE-1 (sin lease distribuido; ver
 *               docs/beta-gate-1/lote-c-wsaa-refresh.md). El perdedor se recupera por la regla siguiente.
 *   · alreadyAuthenticated (clasificado inequívocamente) → relee `arca_config`; si hay un TA válido lo reutiliza, sin
 *               marcar error ni hacer fallar la emisión. Si no hay TA válido, falla y marca error. Nunca inventa uno.
 *   · falla definitiva / ambigua → nunca guarda un TA, nunca inventa vencimiento, nunca pisa token/sign. Si todavía
 *               existe un TA válido, se sirve ése: una falla ambigua (timeout, 5xx) NO cambia `estado_conexion`,
 *               una definitiva (certificado/autorización rechazados) sí, porque es un problema real que va a
 *               cortar la emisión cuando ese TA venza. Sin TA válido: falla y marca error.
 *   · backoff   después de servir el TA vigente por una renovación fallida o rechazada, este worker no vuelve a pedir
 *               LoginCms por la ventana hasta que ese MISMO TA venza (evita un LoginCms por emisión en los últimos
 *               minutos). `force_refresh` no respeta el backoff.
 *   · log       business_id, decisión, motivo, resultado, clase de falla, código y minutos restantes. Nunca token,
 *               sign, clave, certificado ni el TRA.
 */
import {
  cachedTicketFromRow,
  classifyWsaaLoginFailure,
  decideTicketUse,
  usableCachedTicket,
  validateIssuedTicket,
  type CachedTicket,
  type LoginFailureClass,
  type TicketDecision,
} from './ticketPolicy.ts'

export const WSAA_GENERIC_ERROR = 'No se pudo completar la autenticación WSAA.'
export const ARCA_CONFIG_NOT_FOUND = 'Configuración ARCA no encontrada para este negocio'

export interface TicketRow {
  wsaa_token?: unknown
  wsaa_sign?: unknown
  wsaa_token_expires?: unknown
}

export type LoginOutcome =
  | { kind: 'issued'; token: unknown; sign: unknown; expirationTime: unknown }
  /** No se intentó LoginCms (sin certificado, certificado vencido, clave Vault no disponible). Contrato previo intacto. */
  | { kind: 'precondition'; status: number; error: string }

export interface TicketLogEvent {
  business_id: string
  decision: TicketDecision['decision']
  reason: TicketDecision['reason'] | 'refresh_backoff'
  result: 'success' | 'already_authenticated_recovered' | 'cached_after_failure' | 'precondition' | 'error'
  failure?: LoginFailureClass['kind']
  code?: string
  shared_attempt?: boolean
  remaining_min: number | null
}

export interface TicketDeps<Row extends TicketRow> {
  now(): number
  readConfig(): Promise<{ row: Row | null; error: boolean }>
  /** Un intento real de LoginCms. Lanza `WsaaLoginFailure` en firma/HTTP/parseo. */
  loginCms(row: Row): Promise<LoginOutcome>
  /** true si quedó guardado. */
  persistTicket(ticket: { token: string; sign: string; expiresAtIso: string }): Promise<boolean>
  /** Sólo escribe estado_conexion/ultimo_error; nunca toca token/sign/vencimiento. */
  markConnectionError(message: string): Promise<void>
  log(event: TicketLogEvent): void
}

export interface TicketResponse {
  status: number
  body: Record<string, unknown>
}

const toMinutes = (ms: number | null): number | null => (ms === null ? null : Math.round(ms / 60_000))

const cachedResponse = (ticket: CachedTicket): TicketResponse =>
  ({ status: 200, body: { success: true, token: ticket.token, sign: ticket.sign, cached: true } })

/** Un servicio por worker: el dedupe y el backoff viven en memoria de ese worker. */
export function createWsaaTicketService() {
  const inflight = new Map<string, Promise<TicketResponse>>()
  const backoffUntil = new Map<string, number>()

  async function getTicket<Row extends TicketRow>(
    businessId: string,
    options: { forceRefresh: boolean },
    deps: TicketDeps<Row>,
  ): Promise<TicketResponse> {
    const read = await deps.readConfig()
    if (read.error || !read.row) return { status: 404, body: { success: false, error: ARCA_CONFIG_NOT_FOUND } }

    const cached = cachedTicketFromRow(read.row)
    const decision = decideTicketUse({ nowMs: deps.now(), cached, forceRefresh: options.forceRefresh })
    const base = { business_id: businessId, decision: decision.decision, remaining_min: toMinutes(decision.remainingMs) }

    if (decision.decision === 'reuse' && cached) {
      deps.log({ ...base, reason: decision.reason, result: 'success' })
      return cachedResponse(cached)
    }

    if (decision.decision === 'refresh' && decision.reason === 'within_window' && cached
      && backoffUntil.get(businessId) === cached.expiresMs) {
      deps.log({ ...base, decision: 'reuse', reason: 'refresh_backoff', result: 'success' })
      return cachedResponse(cached)
    }

    const shared = inflight.get(businessId)
    if (shared) {
      const response = await shared
      deps.log({ ...base, reason: decision.reason, result: response.body.success === true ? 'success' : 'error', shared_attempt: true })
      return response
    }

    const attempt = refresh(businessId, decision, read.row, deps).finally(() => inflight.delete(businessId))
    inflight.set(businessId, attempt)
    return attempt
  }

  async function refresh<Row extends TicketRow>(
    businessId: string,
    decision: TicketDecision,
    row: Row,
    deps: TicketDeps<Row>,
  ): Promise<TicketResponse> {
    const base = {
      business_id: businessId, decision: decision.decision, reason: decision.reason,
      remaining_min: toMinutes(decision.remainingMs),
    }

    let outcome: LoginOutcome
    try {
      outcome = await deps.loginCms(row)
    } catch (error) {
      return recover(businessId, base, classifyWsaaLoginFailure(error), deps)
    }

    if (outcome.kind === 'precondition') {
      deps.log({ ...base, result: 'precondition', code: `HTTP_${outcome.status}` })
      return { status: outcome.status, body: { success: false, error: outcome.error } }
    }

    const ticket = validateIssuedTicket(outcome, deps.now())
    if (!ticket.ok) {
      // WSAA respondió 200 pero el TA no es elegible (sin vencimiento exacto, fuera de la vida documentada, vacío):
      // pudo haberse emitido un TA que no podemos usar. Ambiguo; no se persiste nada.
      return recover(businessId, base, { kind: 'ambiguous', code: 'WSAA_RESPONSE_INVALID' }, deps)
    }

    const expiresAtIso = new Date(ticket.expiresMs).toISOString()
    const stored = await deps.persistTicket({ token: ticket.token, sign: ticket.sign, expiresAtIso })
    backoffUntil.delete(businessId)
    deps.log({ ...base, result: 'success', ...(stored ? {} : { code: 'PERSIST_FAILED' }) })
    return { status: 200, body: { success: true, token: ticket.token, sign: ticket.sign, cached: false, expires_at: expiresAtIso } }
  }

  async function recover<Row extends TicketRow>(
    businessId: string,
    base: Omit<TicketLogEvent, 'result'>,
    failure: LoginFailureClass,
    deps: TicketDeps<Row>,
  ): Promise<TicketResponse> {
    // Releer SIEMPRE: otro worker pudo haber guardado un TA nuevo mientras este intento fallaba.
    let usable: CachedTicket | null = null
    try {
      const again = await deps.readConfig()
      usable = again.error ? null : usableCachedTicket(cachedTicketFromRow(again.row), deps.now())
    } catch {
      usable = null
    }

    if (usable) {
      if (failure.kind === 'definitive') await deps.markConnectionError(WSAA_GENERIC_ERROR)
      backoffUntil.set(businessId, usable.expiresMs)
      deps.log({
        ...base,
        result: failure.kind === 'already_authenticated' ? 'already_authenticated_recovered' : 'cached_after_failure',
        failure: failure.kind, code: failure.code,
      })
      return cachedResponse(usable)
    }

    await deps.markConnectionError(WSAA_GENERIC_ERROR)
    deps.log({ ...base, result: 'error', failure: failure.kind, code: failure.code })
    return { status: 200, body: { success: false, error: WSAA_GENERIC_ERROR, error_code: failure.code } }
  }

  return { getTicket }
}
