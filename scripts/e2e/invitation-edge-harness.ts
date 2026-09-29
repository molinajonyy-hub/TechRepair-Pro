/**
 * PRE-BETA-2F — Edge LOCAL de invitaciones para los E2E.
 *
 *   deno run -A --node-modules-dir=none scripts/e2e/invitation-edge-harness.ts
 *   (nunca `auto`: instalaría las dependencias de package.json en node_modules ignorando el lockfile)
 *
 * El job E2E no levanta el edge-runtime de Supabase. Este proceso sirve el handler REAL de
 * `send-business-invitation` con dependencias reales del stack local:
 *   · identidad: GoTrue local con el JWT del navegador;
 *   · autoridad: get_my_profile + create_business_invitation con ese mismo JWT (PostgREST local);
 *   · lecturas: business_invitations y businesses bajo RLS, con ese JWT;
 *   · enlace: la fuente única (_shared/invitationLink.ts) con override LOOPBACK del bundle e2e.
 * SÓLO Resend es simulado: el transporte guarda los correos en una bandeja en memoria y emula la
 * semántica documentada de `Idempotency-Key` (misma clave → mismo id, sin reenviar).
 *
 * Nunca habla con Resend ni con producción: se niega a arrancar si SUPABASE_URL no es local y
 * escucha sólo en 127.0.0.1. No usa service_role. Control (sólo E2E): /__e2e/{reset,mode,outbox,stats}.
 */
import { userDataApiHeaders } from '../../supabase/functions/_shared/clientContract.ts'
import { loopbackOrigin } from '../../supabase/functions/_shared/invitationLink.ts'
import { computeAllowedOrigins, createCors } from '../../supabase/functions/_shared/scopedCors.ts'
import { handleInvitationRequest, type ScopedResult, type UserScope } from '../../supabase/functions/send-business-invitation/handler.ts'

const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '')
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const PORT = Number(Deno.env.get('INVITATION_E2E_HARNESS_PORT') ?? '5198')
const APP_ORIGIN = loopbackOrigin(Deno.env.get('INVITATION_E2E_APP_ORIGIN') ?? 'http://localhost:5174')

const host = (() => { try { return new URL(SUPABASE_URL).hostname } catch { return '' } })()
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host) || !ANON_KEY || !APP_ORIGIN) {
  console.error('invitation-edge-harness: SUPABASE_URL debe ser el stack LOCAL, hace falta la anon key y el origen del bundle debe ser loopback.')
  Deno.exit(2)
}

// ── Resend simulado ──────────────────────────────────────────────────────────
type ProviderMode = 'ok' | 'fail'
interface OutboxMessage {
  id: string
  idempotencyKey: string
  from: unknown
  to: unknown
  subject: unknown
  html: unknown
  text: unknown
  bodyKeys: string[]
}
let mode: ProviderMode = 'ok'
let attempts = 0
let outbox: OutboxMessage[] = []
let seen = new Map<string, string>()

const stubResend: typeof fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input)
  if (url !== 'https://api.resend.com/emails') return new Response('no permitido en E2E', { status: 599 })
  attempts++
  if (mode === 'fail') return new Response('{"name":"application_error","message":"E2E simulated failure"}', { status: 500 })
  const headers = new Headers(init?.headers)
  const key = headers.get('Idempotency-Key') ?? ''
  if (!key) return new Response('{"name":"invalid_idempotency_key"}', { status: 400 })
  const previous = seen.get(key)
  if (previous) return new Response(JSON.stringify({ id: previous }), { status: 200 })
  const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
  const id = crypto.randomUUID()
  seen.set(key, id)
  outbox.push({
    id, idempotencyKey: key, from: body.from, to: body.to, subject: body.subject,
    html: body.html, text: body.text, bodyKeys: Object.keys(body).sort(),
  })
  return new Response(JSON.stringify({ id }), { status: 200 })
}

// ── Cliente user-scoped mínimo contra el stack local (sin service_role) ─────
async function rest(path: string, init: RequestInit, headers: Record<string, string>): Promise<ScopedResult> {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY, ...headers },
  })
  const text = await res.text()
  let data: unknown = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  if (res.ok) return { data, error: null }
  const e = (data && typeof data === 'object' ? data : {}) as { code?: unknown; message?: unknown }
  return {
    data: null,
    error: {
      code: typeof e.code === 'string' ? e.code : String(res.status),
      message: typeof e.message === 'string' ? e.message : undefined,
    },
  }
}

function userScope(req: Request, jwt: string): UserScope {
  const headers = userDataApiHeaders(req, `Bearer ${jwt}`)
  const first = (r: ScopedResult): ScopedResult =>
    r.error ? r : { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: null }
  return {
    userId: async () => {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}` } })
      if (res.status >= 400 && res.status < 500) { await res.body?.cancel(); return null }
      if (!res.ok) { await res.body?.cancel(); throw new Error('AUTH_UNAVAILABLE') }
      const user = await res.json() as { id?: string }
      return user.id ?? null
    },
    rpc: (name, args = {}) => rest(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(args) }, headers),
    invitation: async (invitationId, businessId) => first(await rest(
      `/rest/v1/business_invitations?select=id,business_id,email,role,token,status,expires_at&id=eq.${encodeURIComponent(invitationId)}&business_id=eq.${encodeURIComponent(businessId)}`,
      { method: 'GET' }, headers)),
    businessName: async (businessId) => first(await rest(
      `/rest/v1/businesses?select=name&id=eq.${encodeURIComponent(businessId)}`, { method: 'GET' }, headers)),
  }
}

const cors = createCors(computeAllowedOrigins([APP_ORIGIN]))
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

async function control(req: Request, path: string): Promise<Response> {
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) as Record<string, unknown> : {}
  switch (path) {
    case '/__e2e/reset':
      mode = 'ok'; attempts = 0; outbox = []; seen = new Map()
      return json({ ok: true })
    case '/__e2e/mode':
      if (body.provider === 'ok' || body.provider === 'fail') mode = body.provider
      return json({ ok: true, provider: mode })
    case '/__e2e/outbox':
      return json({ ok: true, messages: outbox })
    case '/__e2e/stats':
      return json({ ok: true, attempts, delivered: outbox.length, provider: mode })
    default:
      return json({ ok: false }, 404)
  }
}

Deno.serve({ hostname: '127.0.0.1', port: PORT, onListen: () => console.log(`invitation-edge-harness listo en http://127.0.0.1:${PORT}`) }, async (req) => {
  const path = new URL(req.url).pathname
  if (path.startsWith('/__e2e/')) return await control(req, path)
  if (!path.endsWith('/functions/v1/send-business-invitation')) return json({ ok: false }, 404)
  return await handleInvitationRequest(req, {
    cors,
    userScope,
    resendApiKey: () => 'e2e-stub-invites-key',
    fetchImpl: stubResend,
    appOrigin: APP_ORIGIN,
    now: () => new Date(),
    log: (event) => console.log(JSON.stringify(event)),
  })
})
