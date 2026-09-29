/**
 * PRE-BETA-2F — Edge send-business-invitation (handler puro + transporte Resend).
 *
 * Sin red ni base: identidad, RPC, lecturas RLS, clave y transporte se inyectan. Se prueba el
 * contrato del borde:
 *   · CORS canónico y método; identidad y actor (owner/admin activo) ANTES del body;
 *   · allowlist estricta de campos: el request nunca aporta destinatario ni token;
 *   · create_and_send usa la RPC canónica con {p_email, p_role} y nada más;
 *   · resend sólo sobre una pending vigente del MISMO negocio, leída con el JWT del actor;
 *   · destinatario, token, negocio y rol salen SIEMPRE de la fila de la DB;
 *   · Resend 2xx → sent; 4xx/5xx/red/sin clave → invitación intacta + delivery failed;
 *   · nunca se devuelve ni se loguea texto del proveedor, token, correo ni clave;
 *   · Idempotency-Key estable en create, acotada al minuto en resend.
 *
 * RUN: deno test -A --node-modules-dir=none tests/deno/sendBusinessInvitation.test.ts
 */
import { assert, assertEquals, assertFalse, assertMatch } from 'jsr:@std/assert@1'
import { computeAllowedOrigins, createCors } from '../../supabase/functions/_shared/scopedCors.ts'
import {
  ACTION_FIELDS, classifyCreateError, handleInvitationRequest, parseInvitationRow,
  type DeliveryLogEvent, type InvitationDeps, type ScopedResult, type UserScope,
} from '../../supabase/functions/send-business-invitation/handler.ts'
import {
  buildResendRequest, createIdempotencyKey, deliverViaResend, isDeliverableRecipient,
  RESEND_EMAILS_ENDPOINT, resendIdempotencyKey,
} from '../../supabase/functions/send-business-invitation/delivery.ts'
import { INVITATION_FROM } from '../../supabase/functions/send-business-invitation/email.ts'

const BIZ = '00000000-0000-4000-8000-00000000f201'
const OTHER_BIZ = '00000000-0000-4000-8000-00000000f202'
const USER = '00000000-0000-4000-8000-00000000f203'
const INV = '00000000-0000-4000-8000-00000000f204'
const TOKEN = 'a1b2'.repeat(16)
const ROW_EMAIL = 'invitada@example.com'
const API_KEY = 'invites-key-sentinel-2f'
const PROVIDER_SENTINEL = 'PROVIDER-RAW-BODY-SENTINEL'
const ORIGIN = 'https://www.techrepairpro.app'
const NOW = new Date('2026-09-29T15:04:30.000Z')
const FUTURE = '2026-10-06T15:00:00.000Z'
const PAST = '2026-09-28T15:00:00.000Z'

type Obj = Record<string, unknown>

const row = (over: Obj = {}): Obj => ({
  id: INV, business_id: BIZ, email: ROW_EMAIL, role: 'tech', token: TOKEN,
  status: 'pending', expires_at: FUTURE, invited_by: USER, created_at: '2026-09-29T15:00:00Z', ...over,
})

const ownerProfile = (over: Obj = {}): Obj => ({
  id: USER, user_id: USER, business_id: BIZ, role: 'owner', is_active: true, permissions: null, ...over,
})

interface Fetched {
  url: string
  headers: Record<string, string>
  body: Obj
}

interface Opts {
  userId?: string | null | 'throw'
  profile?: ScopedResult
  create?: ScopedResult
  invitation?: ScopedResult
  businessName?: ScopedResult | 'throw'
  resend?: (f: Fetched) => Response | Promise<Response>
  apiKey?: string | null
  appOrigin?: string | null
  now?: () => Date
}

function makeDeps(opts: Opts = {}) {
  const scopes: string[] = []
  const rpcCalls: { name: string; args: Obj }[] = []
  const invitationCalls: { id: string; businessId: string }[] = []
  const fetches: Fetched[] = []
  const logs: DeliveryLogEvent[] = []
  const deps: InvitationDeps = {
    cors: createCors(computeAllowedOrigins([])),
    userScope: (_req, jwt): UserScope => {
      scopes.push(jwt)
      return {
        userId: async () => {
          if (opts.userId === 'throw') throw new Error('transport')
          return opts.userId === undefined ? USER : opts.userId
        },
        rpc: async (name, args = {}) => {
          rpcCalls.push({ name, args })
          if (name === 'get_my_profile') return opts.profile ?? { data: [ownerProfile()], error: null }
          if (name === 'create_business_invitation') return opts.create ?? { data: row(), error: null }
          return { data: null, error: { message: 'unexpected rpc' } }
        },
        invitation: async (id, businessId) => {
          invitationCalls.push({ id, businessId })
          return opts.invitation ?? { data: row(), error: null }
        },
        businessName: async () => {
          if (opts.businessName === 'throw') throw new Error('x')
          return opts.businessName ?? { data: { name: 'Taller Clic' }, error: null }
        },
      }
    },
    resendApiKey: () => (opts.apiKey === undefined ? API_KEY : opts.apiKey),
    fetchImpl: async (input, init) => {
      const headers: Record<string, string> = {}
      new Headers(init?.headers).forEach((v, k) => { headers[k] = v })
      const f: Fetched = { url: String(input), headers, body: JSON.parse(String(init?.body ?? '{}')) }
      fetches.push(f)
      return opts.resend ? await opts.resend(f) : new Response(JSON.stringify({ id: 'email-1' }), { status: 200 })
    },
    appOrigin: opts.appOrigin ?? null,
    now: opts.now ?? (() => NOW),
    log: (e) => { logs.push(e) },
  }
  return { deps, scopes, rpcCalls, invitationCalls, fetches, logs }
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://edge.local/functions/v1/send-business-invitation', {
    method: 'POST',
    headers: { Origin: ORIGIN, Authorization: 'Bearer user-jwt', 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

const create = (over: Obj = {}) => post({ action: 'create_and_send', email: 'Invitada@Example.com ', role: 'tech', ...over })
const resend = (over: Obj = {}) => post({ action: 'resend', invitation_id: INV, ...over })

async function run(req: Request, deps: InvitationDeps) {
  const res = await handleInvitationRequest(req, deps)
  const text = await res.text()
  return { res, text, body: (text ? JSON.parse(text) : null) as Obj }
}

const hrefOf = (html: string) => html.match(/href="([^"]+)"/)?.[1] ?? null

// ─── 1. CORS y método ──────────────────────────────────────────────────────
Deno.test('OPTIONS: preflight 204 con el origen canónico, sin tocar identidad', async () => {
  const { deps, scopes } = makeDeps()
  const res = await handleInvitationRequest(new Request('https://edge.local/x', {
    method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Headers': 'authorization, content-type, x-techrepair-client-contract' },
  }), deps)
  assertEquals(res.status, 204)
  assertEquals(res.headers.get('Access-Control-Allow-Origin'), ORIGIN)
  assertEquals(res.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS')
  assertEquals(scopes.length, 0)
})

Deno.test('CORS: apex permitido; un origen ajeno o Clic no reciben Allow-Origin; nunca *', async () => {
  for (const [origin, allowed] of [
    ['https://techrepairpro.app', true],
    ['https://clicmayorista.com.ar', false],
    ['https://tech-repair-pro-git-x.vercel.app', false],
    ['https://evil.example', false],
  ] as const) {
    const { deps } = makeDeps()
    const res = await handleInvitationRequest(new Request('https://edge.local/x', { method: 'OPTIONS', headers: { Origin: origin } }), deps)
    assertEquals(res.headers.get('Access-Control-Allow-Origin'), allowed ? origin : null, origin)
  }
})

Deno.test('sólo POST y OPTIONS', async () => {
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    const { deps, scopes } = makeDeps()
    const { res, body } = await run(new Request('https://edge.local/x', { method, headers: { Origin: ORIGIN, Authorization: 'Bearer x' } }), deps)
    assertEquals(res.status, 405, method)
    assertEquals(body.error, 'METHOD_NOT_ALLOWED')
    assertEquals(scopes.length, 0)
  }
})

// ─── 2. Identidad y actor ──────────────────────────────────────────────────
Deno.test('sin JWT → 401 y ningún acceso a datos', async () => {
  for (const auth of [undefined, '', 'Basic abc', 'Bearer', 'Bearer a b']) {
    const { deps, scopes, fetches } = makeDeps()
    const headers: Record<string, string> = { Origin: ORIGIN, 'Content-Type': 'application/json' }
    if (auth !== undefined) headers.Authorization = auth
    const { res, body } = await run(new Request('https://edge.local/x', {
      method: 'POST', headers, body: JSON.stringify({ action: 'create_and_send', email: 'a@b.co', role: 'tech' }),
    }), deps)
    assertEquals(res.status, 401, String(auth))
    assertEquals(body.error, 'NOT_AUTHENTICATED')
    assertEquals(scopes.length, 0)
    assertEquals(fetches.length, 0)
  }
})

Deno.test('JWT inválido/vencido → 401; GoTrue caído → 503; sin RPC', async () => {
  const bad = makeDeps({ userId: null })
  assertEquals((await run(create(), bad.deps)).res.status, 401)
  assertEquals(bad.rpcCalls.length, 0)

  const down = makeDeps({ userId: 'throw' })
  const r = await run(create(), down.deps)
  assertEquals(r.res.status, 503)
  assertEquals(r.body.error, 'AUTHORIZATION_UNAVAILABLE')
  assertEquals(down.rpcCalls.length, 0)
})

Deno.test('actor no owner/admin, inactivo, sin negocio o de otra identidad → falla antes de crear o enviar', async () => {
  const cases: [string, ScopedResult, number, string][] = [
    ['tech', { data: [ownerProfile({ role: 'tech' })], error: null }, 403, 'FORBIDDEN'],
    ['viewer', { data: [ownerProfile({ role: 'viewer' })], error: null }, 403, 'FORBIDDEN'],
    ['inactivo', { data: [ownerProfile({ is_active: false })], error: null }, 403, 'FORBIDDEN'],
    ['otra identidad', { data: [ownerProfile({ id: OTHER_BIZ, user_id: OTHER_BIZ })], error: null }, 403, 'FORBIDDEN'],
    ['sin negocio', { data: [ownerProfile({ business_id: null })], error: null }, 403, 'NO_BUSINESS'],
    ['sin perfil', { data: [], error: null }, 403, 'FORBIDDEN'],
    ['dos perfiles', { data: [ownerProfile(), ownerProfile()], error: null }, 403, 'FORBIDDEN'],
    ['error de lectura', { data: null, error: { message: 'x' } }, 503, 'AUTHORIZATION_UNAVAILABLE'],
  ]
  for (const [name, profile, status, error] of cases) {
    for (const req of [create(), resend()]) {
      const { deps, rpcCalls, invitationCalls, fetches } = makeDeps({ profile })
      const { res, body } = await run(req, deps)
      assertEquals(res.status, status, name)
      assertEquals(body.error, error, name)
      assertFalse(rpcCalls.some((c) => c.name === 'create_business_invitation'), name)
      assertEquals(invitationCalls.length, 0, name)
      assertEquals(fetches.length, 0, name)
    }
  }
})

Deno.test('admin activo puede crear y reenviar', async () => {
  const profile = { data: [ownerProfile({ role: 'admin' })], error: null }
  assertEquals((await run(create(), makeDeps({ profile }).deps)).res.status, 200)
  assertEquals((await run(resend(), makeDeps({ profile }).deps)).res.status, 200)
})

// ─── 3. Body ───────────────────────────────────────────────────────────────
Deno.test('allowlist estricta: el request nunca aporta destinatario, token ni negocio', async () => {
  const intrusos: Obj[] = [
    { action: 'create_and_send', email: 'a@b.co', role: 'tech', business_id: OTHER_BIZ },
    { action: 'create_and_send', email: 'a@b.co', role: 'tech', token: TOKEN },
    { action: 'create_and_send', email: 'a@b.co', role: 'tech', to: 'x@evil.example' },
    { action: 'resend', invitation_id: INV, email: 'x@evil.example' },
    { action: 'resend', invitation_id: INV, token: TOKEN },
    { action: 'resend', invitation_id: INV, to: 'x@evil.example' },
    { action: 'resend', invitation_id: INV, business_id: OTHER_BIZ },
  ]
  for (const b of intrusos) {
    const { deps, rpcCalls, invitationCalls, fetches } = makeDeps()
    const { res, body } = await run(post(b), deps)
    assertEquals(res.status, 400, JSON.stringify(b))
    assertEquals(body.error, 'UNEXPECTED_FIELD')
    assertFalse(rpcCalls.some((c) => c.name === 'create_business_invitation'))
    assertEquals(invitationCalls.length, 0)
    assertEquals(fetches.length, 0)
  }
  assertEquals(ACTION_FIELDS.resend, ['action', 'invitation_id'])
  assertEquals(ACTION_FIELDS.create_and_send, ['action', 'email', 'role'])
})

Deno.test('body inválido, acción desconocida, id no-uuid y body enorme', async () => {
  assertEquals((await run(post('no-json'), makeDeps().deps)).body.error, 'BAD_REQUEST')
  assertEquals((await run(post([1, 2]), makeDeps().deps)).body.error, 'BAD_REQUEST')
  assertEquals((await run(post({ action: 'invite_everyone' }), makeDeps().deps)).body.error, 'UNKNOWN_ACTION')
  assertEquals((await run(resend({ invitation_id: 'abc' }), makeDeps().deps)).body.error, 'BAD_REQUEST')
  assertEquals((await run(create({ email: 42 }), makeDeps().deps)).body.error, 'INVALID_EMAIL')
  assertEquals((await run(create({ role: '' }), makeDeps().deps)).body.error, 'INVALID_ROLE')
  const big = await run(post({ action: 'create_and_send', email: 'a@b.co', role: 'tech', pad: 'x'.repeat(5000) }), makeDeps().deps)
  assertEquals(big.res.status, 413)
})

// ─── 4. create_and_send ────────────────────────────────────────────────────
Deno.test('create usa la RPC canónica con {p_email, p_role} y nada más', async () => {
  const { deps, rpcCalls } = makeDeps()
  const { res } = await run(create(), deps)
  assertEquals(res.status, 200)
  const call = rpcCalls.find((c) => c.name === 'create_business_invitation')
  assert(call)
  assertEquals(Object.keys(call.args).sort(), ['p_email', 'p_role'])
  assertEquals(call.args.p_email, 'Invitada@Example.com ')
  assertEquals(call.args.p_role, 'tech')
})

Deno.test('create: destinatario, token, rol y negocio salen de la FILA, no del request', async () => {
  // El request pide `manager` para un correo con mayúsculas; la DB devuelve la pending que YA
  // existía (idempotencia) con rol tech y el correo normalizado. Manda la fila.
  const { deps, fetches } = makeDeps({
    create: { data: row({ email: 'otra.persona@example.com', role: 'viewer' }), error: null },
  })
  const { res, body } = await run(create({ email: 'Pedido@Example.com', role: 'manager' }), deps)
  assertEquals(res.status, 200)
  assertEquals(fetches.length, 1)
  assertEquals(fetches[0].body.to, ['otra.persona@example.com'])
  const html = String(fetches[0].body.html)
  assertEquals(hrefOf(html), `${ORIGIN}/accept-invite?token=${TOKEN}`)
  assert(html.includes('Visualizador'))
  assertFalse(html.includes('Gerente'))
  assert(String(fetches[0].body.subject).includes('Taller Clic'))
  assertEquals((body.invitation as Obj).email, 'otra.persona@example.com')
  assertEquals((body.invitation as Obj).role, 'viewer')
})

Deno.test('create: la RPC devuelve una fila de OTRO negocio → no se envía nada', async () => {
  const { deps, fetches } = makeDeps({ create: { data: row({ business_id: OTHER_BIZ }), error: null } })
  const { res, body } = await run(create(), deps)
  assertEquals(res.status, 403)
  assertEquals(body.error, 'FORBIDDEN')
  assertEquals(fetches.length, 0)
})

Deno.test('create: errores de la RPC → códigos controlados, sin texto de la DB', async () => {
  const cases: [ScopedResult['error'], number, string][] = [
    [{ code: 'TRIVE', message: 'INVALID_EMAIL' }, 422, 'INVALID_EMAIL'],
    [{ code: 'TRIVR', message: 'INVALID_ROLE' }, 422, 'INVALID_ROLE'],
    [{ code: 'TRNOB', message: 'NO_BUSINESS' }, 403, 'NO_BUSINESS'],
    [{ code: '42501', message: 'FORBIDDEN' }, 403, 'FORBIDDEN'],
    [{ code: '42501', message: 'NOT_AUTHENTICATED' }, 401, 'NOT_AUTHENTICATED'],
    [{ code: '23505', message: 'duplicate key value violates unique constraint "business_invitations_one_pending_per_email"' }, 409, 'INVITATION_NOT_PENDING'],
    [{ code: 'CLIENT_UPDATE_REQUIRED', message: 'Actualizá la aplicación para continuar.' }, 409, 'CLIENT_UPDATE_REQUIRED'],
    [{ code: '42883', message: 'function gen_random_bytes(integer) does not exist' }, 500, 'UNKNOWN'],
  ]
  for (const [error, status, code] of cases) {
    const { deps, fetches } = makeDeps({ create: { data: null, error } })
    const { res, text, body } = await run(create(), deps)
    assertEquals(res.status, status, code)
    assertEquals(body.error, code)
    assertFalse(text.includes('gen_random_bytes'))
    assertFalse(text.includes('duplicate key'))
    assertEquals(fetches.length, 0)
    assertEquals(classifyCreateError(error!).error, code)
  }
})

Deno.test('create: una fila no pending o vencida no se envía', async () => {
  for (const over of [{ status: 'accepted' }, { expires_at: PAST }]) {
    const { deps, fetches } = makeDeps({ create: { data: row(over), error: null } })
    const { res, body } = await run(create(), deps)
    assertEquals(res.status, 409)
    assertEquals(body.error, 'INVITATION_NOT_PENDING')
    assertEquals(fetches.length, 0)
  }
})

// ─── 5. resend ─────────────────────────────────────────────────────────────
Deno.test('resend: lee la fila con el JWT del actor, acotada a SU negocio, y reenvía el MISMO token', async () => {
  const { deps, invitationCalls, fetches, rpcCalls } = makeDeps()
  const { res, body } = await run(resend({ invitation_id: INV.toUpperCase() }), deps)
  assertEquals(res.status, 200)
  assertEquals(invitationCalls, [{ id: INV, businessId: BIZ }])
  assertFalse(rpcCalls.some((c) => c.name === 'create_business_invitation'))
  assertEquals(fetches[0].body.to, [ROW_EMAIL])
  assertEquals(hrefOf(String(fetches[0].body.html)), `${ORIGIN}/accept-invite?token=${TOKEN}`)
  assertEquals((body.delivery as Obj).status, 'sent')
})

Deno.test('resend: sólo pending y no vencida, y del mismo negocio', async () => {
  const cases: [ScopedResult, number, string][] = [
    [{ data: null, error: null }, 404, 'INVITATION_NOT_FOUND'],
    [{ data: row({ business_id: OTHER_BIZ }), error: null }, 404, 'INVITATION_NOT_FOUND'],
    [{ data: row({ status: 'cancelled' }), error: null }, 409, 'INVITATION_CANCELLED'],
    [{ data: row({ status: 'accepted' }), error: null }, 409, 'INVITATION_ALREADY_USED'],
    [{ data: row({ status: 'expired' }), error: null }, 409, 'INVITATION_EXPIRED'],
    [{ data: row({ expires_at: PAST }), error: null }, 409, 'INVITATION_EXPIRED'],
    [{ data: row({ role: 'owner' }), error: null }, 409, 'INVITATION_NOT_PENDING'],
    [{ data: null, error: { message: 'boom' } }, 503, 'INVITATION_UNAVAILABLE'],
  ]
  for (const [invitation, status, code] of cases) {
    const { deps, fetches } = makeDeps({ invitation })
    const { res, body } = await run(resend(), deps)
    assertEquals(res.status, status, code)
    assertEquals(body.error, code)
    assertEquals(fetches.length, 0, code)
  }
})

// ─── 6. Semántica de fallo del proveedor ──────────────────────────────────
Deno.test('Resend 200 con id → delivery sent', async () => {
  const { deps, fetches } = makeDeps()
  const { res, body } = await run(create(), deps)
  assertEquals(res.status, 200)
  assertEquals(body.ok, true)
  assertEquals(body.delivery, { status: 'sent' })
  assertEquals(fetches[0].url, RESEND_EMAILS_ENDPOINT)
  assertEquals(fetches[0].headers.authorization, `Bearer ${API_KEY}`)
})

Deno.test('Resend 4xx/5xx/red → la invitación queda creada y delivery failed con código controlado', async () => {
  const cases: [(f: Fetched) => Response | Promise<Response>, string][] = [
    [() => new Response(PROVIDER_SENTINEL, { status: 401 }), 'provider_unauthorized'],
    [() => new Response(PROVIDER_SENTINEL, { status: 403 }), 'provider_unauthorized'],
    [() => new Response(JSON.stringify({ name: 'validation_error', message: PROVIDER_SENTINEL }), { status: 422 }), 'provider_rejected'],
    [() => new Response(PROVIDER_SENTINEL, { status: 409 }), 'provider_conflict'],
    [() => new Response(PROVIDER_SENTINEL, { status: 429 }), 'rate_limited'],
    [() => new Response(PROVIDER_SENTINEL, { status: 500 }), 'provider_error'],
    [() => new Response(PROVIDER_SENTINEL, { status: 503, statusText: PROVIDER_SENTINEL }), 'provider_error'],
    [() => new Response(JSON.stringify({ message: PROVIDER_SENTINEL }), { status: 200 }), 'provider_error'],
    [() => { throw new TypeError(PROVIDER_SENTINEL) }, 'network_error'],
  ]
  for (const [resend, code] of cases) {
    const { deps, rpcCalls, logs } = makeDeps({ resend })
    const { res, text, body } = await run(create(), deps)
    assertEquals(res.status, 200, code)
    assertEquals(body.ok, true)
    assertEquals((body.invitation as Obj).id, INV)
    assertEquals(body.delivery, { status: 'failed', code })
    assertFalse(text.includes(PROVIDER_SENTINEL), code)
    assertFalse(JSON.stringify(logs).includes(PROVIDER_SENTINEL), code)
    // No se canceló ni se tocó la invitación: la única RPC de escritura fue la creación.
    assertEquals(rpcCalls.map((c) => c.name), ['get_my_profile', 'create_business_invitation'])
  }
})

Deno.test('sin RESEND_INVITES_API_KEY → delivery failed not_configured, sin llamar al proveedor', async () => {
  for (const apiKey of [null, '', '   ']) {
    const { deps, fetches } = makeDeps({ apiKey })
    const { res, body } = await run(create(), deps)
    assertEquals(res.status, 200)
    assertEquals((body.invitation as Obj).id, INV)
    assertEquals(body.delivery, { status: 'failed', code: 'not_configured' })
    assertEquals(fetches.length, 0)
  }
})

Deno.test('un destinatario que no es un buzón simple no se envía (la fila queda)', async () => {
  for (const email of ['"<a@b.co>"@example.com', 'a@b.co,c@example.com', 'a b@example.com', 'sin-arroba']) {
    const { deps, fetches } = makeDeps({ create: { data: row({ email }), error: null } })
    const { body } = await run(create(), deps)
    assertEquals(body.delivery, { status: 'failed', code: 'invalid_recipient' }, email)
    assertEquals(fetches.length, 0)
  }
  assert(isDeliverableRecipient(ROW_EMAIL))
})

Deno.test('respuestas y logs nunca llevan token, correo ni clave', async () => {
  for (const req of [create(), resend()]) {
    const { deps, logs } = makeDeps()
    const { text } = await run(req, deps)
    assertFalse(text.includes(TOKEN))
    assertFalse(text.includes(API_KEY))
    const logged = JSON.stringify(logs)
    assertEquals(logs.length, 1)
    assertFalse(logged.includes(TOKEN))
    assertFalse(logged.includes(ROW_EMAIL))
    assertFalse(logged.includes(API_KEY))
    assertEquals(logs[0].invitation_id, INV)
    assertEquals(logs[0].provider_status, 200)
  }
})

Deno.test('nombre del negocio ilegible → nombre genérico, el correo igual sale', async () => {
  for (const businessName of ['throw', { data: null, error: { message: 'x' } }, { data: { name: '   ' }, error: null }] as const) {
    const { deps, fetches, logs } = makeDeps({ businessName })
    const { body } = await run(create(), deps)
    assertEquals(body.delivery, { status: 'sent' })
    assertMatch(String(fetches[0].body.subject), /^Te invitaron a un equipo — TechRepair Pro$/)
    assertEquals(logs[0].business_name, 'fallback')
  }
})

Deno.test('el nombre del negocio se escapa en el HTML y se sanea en el asunto', async () => {
  const { deps, fetches } = makeDeps({ businessName: { data: { name: 'Clic <script>alert(1)</script>\r\nBcc: x@evil.example' }, error: null } })
  await run(create(), deps)
  const html = String(fetches[0].body.html)
  const subject = String(fetches[0].body.subject)
  assertFalse(html.includes('<script>'))
  assert(html.includes('&lt;script&gt;'))
  assertFalse(/[\r\n]/.test(subject))
})

// ─── 7. Enlace canónico ────────────────────────────────────────────────────
Deno.test('el Origin del request nunca decide el enlace; sólo un override loopback lo cambia', async () => {
  const apex = makeDeps()
  await run(create({}), apex.deps)
  await run(post({ action: 'create_and_send', email: 'a@b.co', role: 'tech' }, { Origin: 'https://techrepairpro.app' }), apex.deps)
  for (const f of apex.fetches) assertEquals(hrefOf(String(f.body.html)), `${ORIGIN}/accept-invite?token=${TOKEN}`)

  for (const bad of ['https://evil.example', 'https://clicmayorista.com.ar', 'http://localhost.evil.example:5174', 'https://tech-repair-pro-git-x.vercel.app']) {
    const d = makeDeps({ appOrigin: bad })
    await run(create(), d.deps)
    assertEquals(hrefOf(String(d.fetches[0].body.html)), `${ORIGIN}/accept-invite?token=${TOKEN}`, bad)
  }

  const local = makeDeps({ appOrigin: 'http://localhost:5174' })
  await run(create(), local.deps)
  assertEquals(hrefOf(String(local.fetches[0].body.html)), `http://localhost:5174/accept-invite?token=${TOKEN}`)
})

// ─── 8. Idempotencia de envío ─────────────────────────────────────────────
/** Emula la semántica documentada de Resend: misma Idempotency-Key + mismo payload → mismo id, sin reenviar. */
function resendLikeProvider() {
  const seen = new Map<string, string>()
  let delivered = 0
  const handler = (f: Fetched) => {
    const key = f.headers['idempotency-key']
    if (!key) return new Response('{}', { status: 400 })
    if (!seen.has(key)) { delivered++; seen.set(key, `email-${delivered}`) }
    return new Response(JSON.stringify({ id: seen.get(key) }), { status: 200 })
  }
  return { handler, delivered: () => delivered }
}

Deno.test('create_and_send: Idempotency-Key estable por invitación → doble submit = 1 correo', async () => {
  const provider = resendLikeProvider()
  const { deps, fetches } = makeDeps({ resend: provider.handler })
  await run(create(), deps)
  await run(create(), deps)
  assertEquals(fetches.length, 2)
  assertEquals(fetches[0].headers['idempotency-key'], `invite-create-${INV}`)
  assertEquals(fetches[1].headers['idempotency-key'], fetches[0].headers['idempotency-key'])
  assertEquals(provider.delivered(), 1)
  assertEquals(createIdempotencyKey(INV), `invite-create-${INV}`)
})

Deno.test('resend: doble click en el mismo minuto no duplica; un reenvío posterior sí sale', async () => {
  const provider = resendLikeProvider()
  let now = new Date('2026-09-29T15:04:01.000Z')
  const { deps, fetches } = makeDeps({ resend: provider.handler, now: () => now })
  await run(resend(), deps)
  now = new Date('2026-09-29T15:04:59.000Z')
  await run(resend(), deps)
  assertEquals(provider.delivered(), 1)
  assertEquals(fetches[0].headers['idempotency-key'], `invite-resend-${INV}-202609291504`)
  now = new Date('2026-09-29T15:05:00.000Z')
  await run(resend(), deps)
  assertEquals(provider.delivered(), 2)
  assertEquals(resendIdempotencyKey(INV, now), `invite-resend-${INV}-202609291505`)
  // resend y create nunca comparten clave (el payload del proveedor podría diferir).
  assert(resendIdempotencyKey(INV, now) !== createIdempotencyKey(INV))
})

// ─── 9. Transporte ─────────────────────────────────────────────────────────
Deno.test('payload del proveedor: sólo from/to/subject/html/text; sin tracking, Reply-To ni headers extra', () => {
  const { url, init } = buildResendRequest(API_KEY, { to: ROW_EMAIL, subject: 's', html: '<p>h</p>', text: 't' }, 'invite-create-x')
  assertEquals(url, 'https://api.resend.com/emails')
  assertEquals(init.method, 'POST')
  const body = JSON.parse(String(init.body)) as Obj
  assertEquals(Object.keys(body).sort(), ['from', 'html', 'subject', 'text', 'to'])
  assertEquals(body.from, INVITATION_FROM)
  assertEquals(body.from, 'TechRepair Pro <no-reply@techrepairpro.app>')
  const headers = new Headers(init.headers)
  assertEquals(headers.get('Idempotency-Key'), 'invite-create-x')
  assertEquals([...headers.keys()].sort(), ['authorization', 'content-type', 'idempotency-key'])
})

Deno.test('deliverViaResend corta por timeout como network_error', async () => {
  const slow: typeof fetch = (_i, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  })
  const out = await deliverViaResend(slow, API_KEY, { to: ROW_EMAIL, subject: 's', html: 'h', text: 't' }, 'k', 10)
  assertEquals(out, { status: 'failed', code: 'network_error', httpStatus: null })
})

Deno.test('parseInvitationRow acepta objeto o array de 1 y rechaza formas inválidas', () => {
  assert(parseInvitationRow(row()))
  assert(parseInvitationRow([row()]))
  assertEquals(parseInvitationRow([row(), row()]), null)
  assertEquals(parseInvitationRow(row({ token: 'corto' })), null)
  assertEquals(parseInvitationRow(row({ token: `${TOKEN}&x=1` })), null)
  assertEquals(parseInvitationRow(row({ role: 'owner' })), null)
  assertEquals(parseInvitationRow(row({ id: 'no-uuid' })), null)
  assertEquals(parseInvitationRow(null), null)
})
