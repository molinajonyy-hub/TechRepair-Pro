/**
 * BETA-GATE-1 · Lote C — afip-wsaa: ventana de renovación, force_refresh, dedupe y recuperación.
 *
 * Nada de ARCA real: `loginCms` es un harness que CUENTA cada llamada que llegaría a WSAA. Las aserciones son sobre
 * esos conteos y sobre el estado de la base simulada, nunca sólo sobre un HTTP 200. Reloj fijo e inyectado.
 *
 * El camino completo usa las piezas REALES de producción: `authorizeArcaCaller` → `withWsaaAuthorization` →
 * `createWsaaTicketService().getTicket(...)`, cableadas igual que `supabase/functions/afip-wsaa/index.ts` (un test de
 * fuente al final fija ese cableado).
 *
 *   A reuse >10min → 0          B ≤10min → 1                C vencido/ausente → 1
 *   D force internal → 1        E force usuario → 403 y 0   F cross-tenant → 403 y 0
 *   G 2 normales mismo worker → 1                          H 2 force mismo worker → 1
 *   I falla definitiva → 1, sin TA falso                   J timeout/5xx → 1, sin éxito ni vencimiento inventado
 *   K TA recién renovado → 0    L exactamente 10:00 → 1
 *   M alreadyAuthenticated + TA vigente → recupera, sin error   N alreadyAuthenticated sin TA vigente → falla
 *   O TA recibido sin expirationTime válido → no se persiste
 *
 * RUN: deno test -A --node-modules-dir=auto tests/deno/afipWsaaTicketRefresh.test.ts
 */
import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@1'
import {
  WSAA_DEFINITIVE_FAULTS,
  WSAA_REFRESH_SAFETY_WINDOW_MS,
  WsaaLoginFailure,
  classifyWsaaLoginFailure,
  decideTicketUse,
  parseWsaaInstant,
  shouldRefreshTa,
  validateIssuedTicket,
  wsaaFaultCode,
} from '../../supabase/functions/afip-wsaa/ticketPolicy.ts'
import {
  WSAA_GENERIC_ERROR,
  createWsaaTicketService,
  type LoginOutcome,
  type TicketDeps,
  type TicketLogEvent,
} from '../../supabase/functions/afip-wsaa/ticketService.ts'
import { withWsaaAuthorization } from '../../supabase/functions/afip-wsaa/authorizationBoundary.ts'
import { authorizeArcaCaller, type ArcaUserClient } from '../../supabase/functions/_shared/arcaAuthorization.ts'
import * as setupWsaa from '../../supabase/functions/arca-selfservice-setup/wsaa.ts'

const BUSINESS_A = '00000000-0000-4000-8000-00000000000a'
const BUSINESS_B = '00000000-0000-4000-8000-00000000000b'
const USER = '00000000-0000-4000-8000-000000000011'
const SERVICE = `sb_secret_${'T'.repeat(22)}_abcd1234`
const NOW = Date.UTC(2026, 8, 16, 15, 0, 0)
const MIN = 60_000
const HOUR = 60 * MIN
const iso = (ms: number) => new Date(ms).toISOString()

/** Sobre SOAP real de Axis (los faults de WSAA llegan con HTTP 500). */
const axisFault = (code: string, text = 'fault sintético') =>
  `WSAA HTTP 500: <?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault><faultcode xmlns:ns1="http://xml.apache.org/axis/">ns1:${code}</faultcode><faultstring>${text}</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>`

// ── Harness ───────────────────────────────────────────────────────────────────

interface Row {
  business_id: string
  cert_file: string | null
  wsaa_token: string | null
  wsaa_sign: string | null
  wsaa_token_expires: string | null
  estado_conexion: string
  ultimo_error: string | null
}

type Behavior = () => Promise<LoginOutcome>

function world(ticket: { token?: string | null; expiresMs?: number | null } = {}) {
  const token = ticket.token === undefined ? 'tok-old' : ticket.token
  const db: { row: Row } = {
    row: {
      business_id: BUSINESS_A,
      cert_file: 'certificado-sintetico',
      wsaa_token: token,
      wsaa_sign: token ? `sign-${token}` : null,
      wsaa_token_expires: ticket.expiresMs === null || ticket.expiresMs === undefined ? null : iso(ticket.expiresMs),
      estado_conexion: 'conectado',
      ultimo_error: null,
    },
  }
  const counts = { configReads: 0, loginCms: 0, persists: 0, errorWrites: 0 }
  const logs: TicketLogEvent[] = []
  const plan: Behavior[] = []
  let clock = NOW

  const deps = (): TicketDeps<Row> => ({
    now: () => clock,
    readConfig: async () => {
      counts.configReads++
      return { row: structuredClone(db.row), error: false }
    },
    loginCms: async () => {
      const next = plan.shift()
      if (!next) throw new Error('harness: LoginCms inesperado')
      return await next()
    },
    persistTicket: async (t) => {
      counts.persists++
      db.row.wsaa_token = t.token
      db.row.wsaa_sign = t.sign
      db.row.wsaa_token_expires = t.expiresAtIso
      db.row.estado_conexion = 'conectado'
      db.row.ultimo_error = null
      return true
    },
    markConnectionError: async (message) => {
      counts.errorWrites++
      db.row.estado_conexion = 'error'
      db.row.ultimo_error = message
    },
    log: (event) => logs.push(event),
  })

  // Comportamientos de WSAA. Cada uno cuenta como UN LoginCms real.
  const issue = (tokenValue: string, expirationTime: unknown, gate?: Promise<void>): Behavior => async () => {
    counts.loginCms++
    if (gate) await gate
    return { kind: 'issued', token: tokenValue, sign: `sign-${tokenValue}`, expirationTime }
  }
  const fail = (raw: string, gate?: Promise<void>): Behavior => async () => {
    counts.loginCms++
    if (gate) await gate
    throw new WsaaLoginFailure('http', raw)
  }
  const precondition = (): Behavior => async () => ({ kind: 'precondition', status: 422, error: 'El certificado digital está vencido. Renovalo en AFIP.' })

  return { db, counts, logs, plan, deps, issue, fail, precondition, setClock: (ms: number) => { clock = ms } }
}

type World = ReturnType<typeof world>
type Service = ReturnType<typeof createWsaaTicketService>

function userClient(capability = true): ArcaUserClient {
  return {
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
    rpc: async (name) => {
      if (name === 'get_my_profile') {
        return { error: null, data: [{ id: USER, user_id: USER, business_id: BUSINESS_A, is_active: true, role: 'owner', permissions: null }] }
      }
      return { error: null, data: capability }
    },
  }
}

/** Camino completo, cableado igual que afip-wsaa/index.ts. */
async function invoke(w: World, service: Service, options: { caller: 'internal' | 'user'; body: Record<string, unknown> }) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (options.caller === 'internal') {
    headers.Authorization = `Bearer ${SERVICE}`
    headers.apikey = SERVICE
  } else {
    headers.Authorization = 'Bearer synthetic-user-jwt'
  }
  const req = new Request('https://edge.test/functions/v1/afip-wsaa', { method: 'POST', headers, body: JSON.stringify(options.body) })
  const response = await withWsaaAuthorization(req, {
    authorize: () => authorizeArcaCaller(req.headers.get('Authorization'), {
      capability: 'settings_sensitive',
      serviceCredentials: [SERVICE],
      presentedApiKey: req.headers.get('apikey'),
      createUserClient: () => userClient(),
    }),
    json: (body, status) => Response.json(body, { status }),
    markAuthorizedError: async () => { w.counts.errorWrites++ },
    run: async ({ businessId, forceRefresh }) => {
      const outcome = await service.getTicket(businessId, { forceRefresh }, w.deps())
      return Response.json(outcome.body, { status: outcome.status })
    },
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

const internal = (w: World, s: Service, body: Record<string, unknown> = {}) =>
  invoke(w, s, { caller: 'internal', body: { business_id: BUSINESS_A, service: 'wsfe', ...body } })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

/** Espera real (no el reloj del TA) hasta que el harness llegue a un estado; la autorización usa crypto.subtle (async). */
async function until(predicate: () => boolean, label: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`harness: timeout esperando ${label}`)
    await new Promise<void>((r) => setTimeout(r, 1))
  }
}

// ── Decisión temporal pura ────────────────────────────────────────────────────

Deno.test('ventana: una sola constante de 10 minutos', () => {
  assertEquals(WSAA_REFRESH_SAFETY_WINDOW_MS, 10 * 60 * 1000)
})

Deno.test('decisión: >10 min reuse · ≤10 min refresh · vencido/ausente refresh · force siempre intenta', () => {
  const at = (remainingMs: number) => ({ token: 't', sign: 's', expiresMs: NOW + remainingMs })
  const d = (remainingMs: number | null, forceRefresh = false) =>
    decideTicketUse({ nowMs: NOW, cached: remainingMs === null ? null : at(remainingMs), forceRefresh })

  assertEquals(d(10 * MIN + 1), { decision: 'reuse', reason: 'fresh', remainingMs: 10 * MIN + 1 })
  assertEquals(d(10 * MIN), { decision: 'refresh', reason: 'within_window', remainingMs: 10 * MIN }) // L: frontera exacta
  assertEquals(d(1), { decision: 'refresh', reason: 'within_window', remainingMs: 1 })
  assertEquals(d(0), { decision: 'refresh', reason: 'expired', remainingMs: 0 })
  assertEquals(d(-1), { decision: 'refresh', reason: 'expired', remainingMs: -1 })
  assertEquals(d(null), { decision: 'refresh', reason: 'missing', remainingMs: null })
  assertEquals(d(11 * HOUR, true), { decision: 'force_refresh', reason: 'fresh', remainingMs: 11 * HOUR })
  assertEquals(shouldRefreshTa({ nowMs: NOW, cached: at(10 * MIN + 1), forceRefresh: false }), false)
  assertEquals(shouldRefreshTa({ nowMs: NOW, cached: at(10 * MIN), forceRefresh: false }), true)
})

// ── Matriz A–O sobre el camino completo ───────────────────────────────────────

Deno.test('A · TA con más de 10 min, llamada normal → 0 LoginCms', async () => {
  const w = world({ expiresMs: NOW + 11 * MIN })
  const r = await internal(w, createWsaaTicketService())
  assertEquals(r.status, 200)
  assertEquals(r.body, { success: true, token: 'tok-old', sign: 'sign-tok-old', cached: true })
  assertEquals(w.counts, { configReads: 1, loginCms: 0, persists: 0, errorWrites: 0 })
})

Deno.test('B · TA con ≤10 min → 1 LoginCms y se persiste el TA nuevo', async () => {
  const w = world({ expiresMs: NOW + 9 * MIN })
  w.plan.push(w.issue('tok-new', iso(NOW + 12 * HOUR)))
  const r = await internal(w, createWsaaTicketService())
  assertEquals(r.body.success, true)
  assertEquals(r.body.token, 'tok-new')
  assertEquals(r.body.cached, false)
  assertEquals(r.body.expires_at, iso(NOW + 12 * HOUR))
  assertEquals(w.counts, { configReads: 1, loginCms: 1, persists: 1, errorWrites: 0 })
  assertEquals(w.db.row.wsaa_token_expires, iso(NOW + 12 * HOUR))
})

Deno.test('C · TA vencido o ausente → 1 LoginCms', async () => {
  for (const ticket of [{ expiresMs: NOW - MIN }, { token: null, expiresMs: null }]) {
    const w = world(ticket)
    w.plan.push(w.issue('tok-new', iso(NOW + 12 * HOUR)))
    const r = await internal(w, createWsaaTicketService())
    assertEquals(r.body.token, 'tok-new')
    assertEquals(w.counts.loginCms, 1)
    assertEquals(w.counts.persists, 1)
  }
})

Deno.test('D · force_refresh de un caller internal con TA reutilizable → 1 intento', async () => {
  const w = world({ expiresMs: NOW + 11 * HOUR })
  w.plan.push(w.issue('tok-forced', iso(NOW + 12 * HOUR)))
  const r = await internal(w, createWsaaTicketService(), { force_refresh: true })
  assertEquals(r.body.token, 'tok-forced')
  assertEquals(w.counts, { configReads: 1, loginCms: 1, persists: 1, errorWrites: 0 })
  assertEquals(w.logs.at(-1)?.decision, 'force_refresh')
})

Deno.test('E · force_refresh de un usuario (owner con settings_sensitive) → 403 antes de config, WSAA o estado', async () => {
  const w = world({ expiresMs: NOW + 11 * HOUR })
  const before = structuredClone(w.db.row)
  const r = await invoke(w, createWsaaTicketService(), { caller: 'user', body: { business_id: BUSINESS_A, force_refresh: true } })
  assertEquals(r.status, 403)
  assertEquals(r.body, { success: false, error: 'FORCE_REFRESH_FORBIDDEN' })
  assertEquals(w.counts, { configReads: 0, loginCms: 0, persists: 0, errorWrites: 0 })
  assertEquals(w.db.row, before)

  // El mismo usuario SIN force sigue pudiendo consultar (reuse, sólo flags).
  const normal = await invoke(w, createWsaaTicketService(), { caller: 'user', body: { business_id: BUSINESS_A } })
  assertEquals(normal.status, 200)
  assertEquals(normal.body, { success: true, tokenOk: true, signOk: true, cached: true })
  assertEquals(w.counts.loginCms, 0)
})

Deno.test('F · usuario contra otro negocio → 403, 0 lecturas y 0 LoginCms (con y sin force)', async () => {
  for (const force of [false, true]) {
    const w = world({ expiresMs: NOW - MIN })
    const r = await invoke(w, createWsaaTicketService(), { caller: 'user', body: { business_id: BUSINESS_B, force_refresh: force } })
    assertEquals(r.status, 403)
    assertEquals(r.body.error, 'FORBIDDEN')
    assertEquals(w.counts, { configReads: 0, loginCms: 0, persists: 0, errorWrites: 0 })
  }
})

Deno.test('G · dos llamadas normales concurrentes en el mismo worker → exactamente 1 LoginCms compartido', async () => {
  const w = world({ expiresMs: NOW + 5 * MIN })
  const gate = deferred()
  w.plan.push(w.issue('tok-shared', iso(NOW + 12 * HOUR), gate.promise))
  const service = createWsaaTicketService()

  const first = internal(w, service)
  const second = internal(w, service)
  await until(() => w.counts.configReads === 2 && w.counts.loginCms === 1, 'las dos decidieron con 1 intento en curso')
  // Margen extra: si la segunda fuera a lanzar su propio LoginCms, ya lo habría hecho.
  await new Promise<void>((r) => setTimeout(r, 20))
  assertEquals(w.counts.loginCms, 1, 'la segunda se sumó al intento en curso')
  gate.resolve()

  const [a, b] = await Promise.all([first, second])
  assertEquals(a.body.token, 'tok-shared')
  assertEquals(b.body.token, 'tok-shared')
  assertEquals(w.counts, { configReads: 2, loginCms: 1, persists: 1, errorWrites: 0 })
})

Deno.test('H · dos force_refresh concurrentes en el mismo worker → exactamente 1 intento compartido', async () => {
  const w = world({ expiresMs: NOW + 11 * HOUR })
  const gate = deferred()
  w.plan.push(w.issue('tok-forced', iso(NOW + 12 * HOUR), gate.promise))
  const service = createWsaaTicketService()

  const first = internal(w, service, { force_refresh: true })
  const second = internal(w, service, { force_refresh: true })
  await until(() => w.counts.configReads === 2 && w.counts.loginCms === 1, 'los dos force decidieron con 1 intento en curso')
  await new Promise<void>((r) => setTimeout(r, 20))
  assertEquals(w.counts.loginCms, 1)
  gate.resolve()

  const [a, b] = await Promise.all([first, second])
  assertEquals([a.body.token, b.body.token], ['tok-forced', 'tok-forced'])
  assertEquals(w.counts, { configReads: 2, loginCms: 1, persists: 1, errorWrites: 0 })
})

Deno.test('I · falla definitiva sin TA vigente → 1 LoginCms, no se guarda TA, error sanitizado', async () => {
  const w = world({ expiresMs: NOW - MIN })
  const before = { token: w.db.row.wsaa_token, sign: w.db.row.wsaa_sign, expires: w.db.row.wsaa_token_expires }
  w.plan.push(w.fail(axisFault('coe.notAuthorized', 'Computador no autorizado a acceder al servicio')))
  const r = await internal(w, createWsaaTicketService())
  assertEquals(r.body, { success: false, error: WSAA_GENERIC_ERROR, error_code: 'WSAA_SERVICE_NOT_AUTHORIZED' })
  assertEquals(w.counts, { configReads: 2, loginCms: 1, persists: 0, errorWrites: 1 })
  assertEquals({ token: w.db.row.wsaa_token, sign: w.db.row.wsaa_sign, expires: w.db.row.wsaa_token_expires }, before)
  assert(!JSON.stringify(r.body).includes('Computador'), 'el texto crudo de ARCA no se devuelve')
})

Deno.test('I2 · falla definitiva con TA todavía vigente → sirve ese TA, sin TA falso, y marca error (es un problema real)', async () => {
  const w = world({ expiresMs: NOW + 5 * MIN })
  w.plan.push(w.fail(axisFault('cms.cert.expired')))
  const r = await internal(w, createWsaaTicketService())
  assertEquals(r.body, { success: true, token: 'tok-old', sign: 'sign-tok-old', cached: true })
  assertEquals(w.counts, { configReads: 2, loginCms: 1, persists: 0, errorWrites: 1 })
})

Deno.test('J · timeout/5xx/red sin TA vigente → 1 LoginCms, sin éxito ni vencimiento inventado, TA previo intacto', async () => {
  const raws = [
    'WSAA HTTP 502: <html><body>Bad Gateway</body></html>',
    'error sending request for url (https://wsaahomo.afip.gov.ar/ws/services/LoginCms): connection closed',
    axisFault('wsaa.internalError'),
  ]
  for (const raw of raws) {
    const w = world({ expiresMs: NOW - MIN })
    const before = structuredClone(w.db.row)
    w.plan.push(w.fail(raw))
    const r = await internal(w, createWsaaTicketService())
    assertEquals(r.body, { success: false, error: WSAA_GENERIC_ERROR, error_code: 'WSAA_RESULT_UNKNOWN' })
    assertEquals(w.counts.loginCms, 1)
    assertEquals(w.counts.persists, 0)
    assertEquals(w.db.row.wsaa_token, before.wsaa_token)
    assertEquals(w.db.row.wsaa_sign, before.wsaa_sign)
    assertEquals(w.db.row.wsaa_token_expires, before.wsaa_token_expires, 'no se fabrica vencimiento')
  }
})

Deno.test('J2 · timeout/5xx con TA todavía vigente → se sirve ese TA y estado_conexion NO pasa a error', async () => {
  const w = world({ expiresMs: NOW + 5 * MIN })
  w.plan.push(w.fail('WSAA HTTP 503: Service Unavailable'))
  const r = await internal(w, createWsaaTicketService())
  assertEquals(r.body, { success: true, token: 'tok-old', sign: 'sign-tok-old', cached: true })
  assertEquals(w.counts, { configReads: 2, loginCms: 1, persists: 0, errorWrites: 0 })
  assertEquals(w.db.row.estado_conexion, 'conectado')
  assertEquals(w.logs.at(-1)?.result, 'cached_after_failure')
})

Deno.test('K · TA recién renovado → la siguiente llamada normal reutiliza (0 LoginCms adicionales)', async () => {
  const w = world({ expiresMs: NOW + 9 * MIN })
  w.plan.push(w.issue('tok-new', iso(NOW + 12 * HOUR)))
  const service = createWsaaTicketService()
  await internal(w, service)
  assertEquals(w.counts.loginCms, 1)
  w.setClock(NOW + 2 * MIN)
  const r = await internal(w, service)
  assertEquals(r.body, { success: true, token: 'tok-new', sign: 'sign-tok-new', cached: true })
  assertEquals(w.counts.loginCms, 1)
})

Deno.test('L · exactamente 10:00 restantes → refresh (1); 10:00.001 → reuse (0)', async () => {
  const boundary = world({ expiresMs: NOW + 10 * MIN })
  boundary.plan.push(boundary.issue('tok-new', iso(NOW + 12 * HOUR)))
  await internal(boundary, createWsaaTicketService())
  assertEquals(boundary.counts.loginCms, 1)

  const outside = world({ expiresMs: NOW + 10 * MIN + 1 })
  await internal(outside, createWsaaTicketService())
  assertEquals(outside.counts.loginCms, 0)
})

Deno.test('M · alreadyAuthenticated + TA vigente en DB → reutiliza, sin estado error, y el worker no reintenta', async () => {
  const w = world({ expiresMs: NOW + 5 * MIN })
  w.plan.push(w.fail(axisFault('coe.alreadyAuthenticated', 'El CEE ya posee un TA valido para el acceso al WSN solicitado')))
  const service = createWsaaTicketService()
  const r = await internal(w, service)
  assertEquals(r.body, { success: true, token: 'tok-old', sign: 'sign-tok-old', cached: true })
  assertEquals(w.counts, { configReads: 2, loginCms: 1, persists: 0, errorWrites: 0 })
  assertEquals(w.db.row.estado_conexion, 'conectado')
  assertEquals(w.logs.at(-1)?.result, 'already_authenticated_recovered')

  // Backoff: mientras siga ese mismo TA, la próxima llamada normal no vuelve a pedir LoginCms…
  w.setClock(NOW + MIN)
  const again = await internal(w, service)
  assertEquals(again.body.token, 'tok-old')
  assertEquals(w.counts.loginCms, 1)
  assertEquals(w.logs.at(-1)?.reason, 'refresh_backoff')

  // …pero force_refresh (internal) sí intenta.
  w.plan.push(w.issue('tok-forced', iso(NOW + 12 * HOUR)))
  const forced = await internal(w, service, { force_refresh: true })
  assertEquals(forced.body.token, 'tok-forced')
  assertEquals(w.counts.loginCms, 2)
})

Deno.test('M2 · carrera entre workers: el segundo recibe alreadyAuthenticated, relee el TA del primero, sin error ni pérdida', async () => {
  const w = world({ expiresMs: NOW + 5 * MIN })
  const gateA = deferred()
  const gateB = deferred()
  w.plan.push(w.issue('tok-worker-a', iso(NOW + 12 * HOUR), gateA.promise))
  w.plan.push(w.fail(axisFault('coe.alreadyAuthenticated'), gateB.promise))
  const workerA = createWsaaTicketService()
  const workerB = createWsaaTicketService()

  const a = internal(w, workerA)
  const b = internal(w, workerB)
  await until(() => w.counts.loginCms === 2, 'los dos workers intentaron')
  assertEquals(w.counts.loginCms, 2, 'sin lease distribuido pueden coexistir 2 intentos (aceptado)')
  gateA.resolve()
  const ra = await a
  gateB.resolve()
  const rb = await b

  assertEquals(ra.body.token, 'tok-worker-a')
  assertEquals(rb.body, { success: true, token: 'tok-worker-a', sign: 'sign-tok-worker-a', cached: true })
  assertEquals(w.counts.persists, 1)
  assertEquals(w.counts.errorWrites, 0)
  assertEquals(w.db.row.estado_conexion, 'conectado')
  assertEquals(w.db.row.wsaa_token, 'tok-worker-a', 'el TA del primero no se pierde ni se pisa')
})

Deno.test('N · alreadyAuthenticated sin TA vigente (vencido o inexistente) → falla, sin recuperación inventada', async () => {
  for (const ticket of [{ expiresMs: NOW - MIN }, { token: null, expiresMs: null }]) {
    const w = world(ticket)
    w.plan.push(w.fail(axisFault('coe.alreadyAuthenticated')))
    const r = await internal(w, createWsaaTicketService())
    assertEquals(r.body, { success: false, error: WSAA_GENERIC_ERROR, error_code: 'WSAA_TICKET_ALREADY_ISSUED' })
    assertEquals(w.counts.loginCms, 1)
    assertEquals(w.counts.persists, 0)
    assertEquals(w.counts.errorWrites, 1)
  }
})

Deno.test('O · WSAA responde 200 con TA sin expirationTime válido → no se persiste ni se inventa vencimiento', async () => {
  const invalid: unknown[] = [
    '', undefined, 'mañana', '2026-09-17T03:00:00', // sin offset: hora local ambigua
    iso(NOW - MIN), iso(NOW + 12 * HOUR + 11 * MIN), '2026-02-30T10:00:00-03:00',
  ]
  for (const expirationTime of invalid) {
    const w = world({ expiresMs: NOW - MIN })
    const before = structuredClone(w.db.row)
    w.plan.push(w.issue('tok-sin-vencimiento', expirationTime))
    const r = await internal(w, createWsaaTicketService())
    assertEquals(r.body, { success: false, error: WSAA_GENERIC_ERROR, error_code: 'WSAA_RESPONSE_INVALID' }, String(expirationTime))
    assertEquals(w.counts.loginCms, 1)
    assertEquals(w.counts.persists, 0)
    assertEquals(w.db.row.wsaa_token, before.wsaa_token)
    assertEquals(w.db.row.wsaa_token_expires, before.wsaa_token_expires)
  }
  // Con un TA todavía vigente, esa respuesta rota no hace fallar la emisión ni cambia el estado.
  const w = world({ expiresMs: NOW + 5 * MIN })
  w.plan.push(w.issue('tok-sin-vencimiento', ''))
  const r = await internal(w, createWsaaTicketService())
  assertEquals(r.body.token, 'tok-old')
  assertEquals(w.counts, { configReads: 2, loginCms: 1, persists: 0, errorWrites: 0 })
})

// ── Bordes complementarios ────────────────────────────────────────────────────

Deno.test('precondición (certificado vencido, sin clave) → contrato previo: 422, 0 LoginCms, sin escribir estado', async () => {
  const w = world({ expiresMs: NOW - MIN })
  w.plan.push(w.precondition())
  const r = await internal(w, createWsaaTicketService())
  assertEquals(r.status, 422)
  assertEquals(w.counts, { configReads: 1, loginCms: 0, persists: 0, errorWrites: 0 })
})

Deno.test('clasificación estricta: sólo un faultcode inequívoco habilita la recuperación', () => {
  assertEquals(classifyWsaaLoginFailure(new WsaaLoginFailure('http', axisFault('coe.alreadyAuthenticated'))).kind, 'already_authenticated')
  // Un Error cualquiera que mencione el código NO es alreadyAuthenticated.
  assertEquals(classifyWsaaLoginFailure(new Error('coe.alreadyAuthenticated')).kind, 'ambiguous')
  // El faultstring lo menciona pero el faultcode es otro.
  assertEquals(classifyWsaaLoginFailure(new WsaaLoginFailure('http', axisFault('coe.notAuthorized', 'no es coe.alreadyAuthenticated'))).kind, 'definitive')
  // Dos faultcodes, faultcode truncado, o fuera de la etapa HTTP → ambiguo.
  const doubled = `${axisFault('coe.alreadyAuthenticated')}${axisFault('coe.alreadyAuthenticated')}`
  assertEquals(classifyWsaaLoginFailure(new WsaaLoginFailure('http', doubled)).kind, 'ambiguous')
  const truncated = axisFault('coe.alreadyAuthenticated').replace('</faultcode>', '')
  assertEquals(classifyWsaaLoginFailure(new WsaaLoginFailure('http', truncated)).kind, 'ambiguous')
  assertEquals(classifyWsaaLoginFailure(new WsaaLoginFailure('parse', axisFault('coe.alreadyAuthenticated'))).kind, 'ambiguous')
  assertEquals(classifyWsaaLoginFailure(new WsaaLoginFailure('signing')).kind, 'definitive')
  // El texto crudo no queda en el error.
  const failure = new WsaaLoginFailure('http', axisFault('coe.alreadyAuthenticated', 'texto crudo'))
  assert(!JSON.stringify(failure).includes('texto crudo'))
  assert(!failure.message.includes('texto crudo'))
})

Deno.test('logs sin secretos: nunca token, sign ni texto de ARCA', async () => {
  const service = createWsaaTicketService()
  const w = world({ expiresMs: NOW + 5 * MIN })
  w.plan.push(w.fail(axisFault('coe.alreadyAuthenticated', 'faultstring-que-no-se-loguea')))
  await internal(w, service)
  w.plan.push(w.issue('tok-secreto-nuevo', iso(NOW + 12 * HOUR)))
  await internal(w, service, { force_refresh: true })
  const text = JSON.stringify(w.logs)
  for (const secret of ['tok-old', 'sign-tok-old', 'tok-secreto-nuevo', 'faultstring-que-no-se-loguea', 'soapenv']) {
    assert(!text.includes(secret), secret)
  }
  for (const event of w.logs) {
    assertEquals(Object.keys(event).every((k) => ['business_id', 'decision', 'reason', 'result', 'failure', 'code', 'shared_attempt', 'remaining_min'].includes(k)), true)
  }
})

// ── Paridad con Phase 2A (arca-selfservice-setup/wsaa.ts) ──────────────────────

Deno.test('paridad Phase 2A: wsaaFaultCode, parseWsaaInstant y allowlist definitiva', () => {
  const faults = [
    axisFault('coe.alreadyAuthenticated'), axisFault('cms.cert.expired'), axisFault('xml.CEE.notAuthorized'),
    `${axisFault('a.b')}${axisFault('c.d')}`, axisFault('coe.alreadyAuthenticated').replace('</faultcode>', ''),
    '<faultcode>coe.x</faultcode>', '<ns9:faultcode>ns9:cms.bad</ns9:faultcode>', 'WSAA HTTP 502: <html/>', '',
  ]
  for (const raw of faults) assertEquals(wsaaFaultCode(raw), setupWsaa.wsaaFaultCode(raw), raw.slice(0, 80))
  const instants = ['2026-09-17T03:00:00-03:00', '2026-09-17T06:00:00.123Z', '2026-09-17T03:00:00', '2026-02-30T00:00:00Z', 'x', '', null]
  for (const value of instants) assertEquals(parseWsaaInstant(value), setupWsaa.parseWsaaInstant(value), String(value))
  assertEquals(Object.keys(WSAA_DEFINITIVE_FAULTS).sort(), Object.keys(setupWsaa.WSAA_DEFINITIVE_FAULTS).sort())
})

Deno.test('paridad Phase 2A: validateIssuedTicket acepta y rechaza lo mismo que validateWsaaTicket', () => {
  const cases: Array<{ token?: unknown; sign?: unknown; expirationTime?: unknown }> = [
    { token: 't', sign: 's', expirationTime: iso(NOW + 12 * HOUR) },
    { token: 't', sign: 's', expirationTime: iso(NOW + 12 * HOUR + 10 * MIN) },
    { token: 't', sign: 's', expirationTime: iso(NOW + 12 * HOUR + 10 * MIN + 1000) },
    { token: 't', sign: 's', expirationTime: iso(NOW) },
    { token: 't', sign: 's', expirationTime: '' },
    { token: '', sign: 's', expirationTime: iso(NOW + HOUR) },
    { token: 't', sign: ' ', expirationTime: iso(NOW + HOUR) },
    { token: 'x'.repeat(16385), sign: 's', expirationTime: iso(NOW + HOUR) },
    { token: 't', sign: 's'.repeat(4097), expirationTime: iso(NOW + HOUR) },
    { token: 't', sign: 's', expirationTime: '2026-09-17T03:00:00' },
  ]
  for (const raw of cases) {
    let setupOk = true
    try { setupWsaa.validateWsaaTicket(raw, NOW) } catch { setupOk = false }
    assertEquals(validateIssuedTicket(raw, NOW).ok, setupOk, JSON.stringify(raw).slice(0, 80))
  }
})

// ── Fuente: el cableado desplegado es el que se testea ────────────────────────

Deno.test('fuente: index.ts usa ticketService, sin ventana de 30 min ni vencimiento inventado; force sólo internal', async () => {
  const read = (path: string) => Deno.readTextFile(new URL(path, import.meta.url))
  const index = await read('../../supabase/functions/afip-wsaa/index.ts')
  const boundary = await read('../../supabase/functions/afip-wsaa/authorizationBoundary.ts')

  assert(index.includes('const ticketService = createWsaaTicketService()'))
  assert(index.includes('ticketService.getTicket(business_id, { forceRefresh: force_refresh }'))
  assert(index.indexOf('return withWsaaAuthorization(req,') < index.indexOf('ticketService.getTicket('))
  assert(!/30\s*\*\s*60\s*\*\s*1000/.test(index), 'la ventana de 30 min no puede volver')
  assert(!/Date\.now\(\)\s*\+\s*12\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(index), 'no se inventa vencimiento del TA')
  assert(!/force_refresh\s*&&|!force_refresh/.test(index), 'la decisión temporal vive sólo en ticketPolicy.ts')
  assert(!/config\.wsaa_token/.test(index), 'index.ts no decide reuse/refresh leyendo el TA directo')

  const forceCheck = boundary.indexOf("input.force_refresh === true && caller.kind !== 'internal'")
  assertNotEquals(forceCheck, -1, 'force_refresh sólo internal')
  assert(forceCheck < boundary.indexOf('context = {'), 'el rechazo va antes de fijar contexto (sin escritura de error)')
  assert(forceCheck < boundary.indexOf('deps.run('), 'el rechazo va antes de leer config o tocar WSAA')
})

Deno.test('fuente: WSAA_REFRESH_SAFETY_WINDOW_MS se define en un único lugar', async () => {
  const root = new URL('../../supabase/functions/', import.meta.url)
  const definitions: string[] = []
  async function walk(dir: URL) {
    for await (const entry of Deno.readDir(dir)) {
      const child = new URL(entry.name + (entry.isDirectory ? '/' : ''), dir)
      if (entry.isDirectory) await walk(child)
      else if (entry.name.endsWith('.ts') && /WSAA_REFRESH_SAFETY_WINDOW_MS\s*=/.test(await Deno.readTextFile(child))) {
        definitions.push(child.pathname.split('/supabase/functions/')[1])
      }
    }
  }
  await walk(root)
  assertEquals(definitions, ['afip-wsaa/ticketPolicy.ts'])
})
