/**
 * ARCA Self-Service Phase 2B — Edge LOCAL para los E2E del asistente.
 *
 *   deno run -A --node-modules-dir=auto scripts/e2e/arca-setup-edge-harness.ts
 *
 * El job E2E no levanta el edge-runtime de Supabase. Este proceso sirve el handler REAL de
 * `arca-selfservice-setup` con dependencias reales del stack local:
 *   · autoridad: authorizeArcaManager con el JWT del navegador (get_my_profile + current_user_can);
 *   · plan: business_has_feature('arca') con ese mismo JWT;
 *   · datos: las RPC service_role `arca_selfservice_*` vía PostgREST local;
 *   · clave + CSR con node-forge (crypto.ts real), firma PKCS#7 real (wsaa.ts real).
 * Sólo WSAA es simulado (`fetch` a *.afip.gov.ar), con modos controlables:
 *   ta             → loginTicketResponse con la forma real (ms + -03:00), si el CMS lleva un
 *                    certificado emitido por la CA sintética;
 *   gateway        → 502 HTML sin fault (resultado AMBIGUO);
 *   not_authorized → fault coe.notAuthorized (definitivo).
 *
 * Nunca habla con ARCA ni con producción: se niega a arrancar si SUPABASE_URL no es local y
 * escucha sólo en 127.0.0.1. Control (sólo E2E): /__e2e/{reset,mode,stats,sign,foreign}.
 */
// @ts-ignore: node-forge en Deno via npm
import forge from 'npm:node-forge@1.3.1'
import { authorizeArcaManager } from '../../supabase/functions/_shared/arcaManagementAuthority.ts'
import { userDataApiHeaders } from '../../supabase/functions/_shared/clientContract.ts'
import { computeAllowedOrigins, createCors } from '../../supabase/functions/_shared/scopedCors.ts'
import { generateSetupKeyAndCsr } from '../../supabase/functions/arca-selfservice-setup/crypto.ts'
import { handleSetupRequest } from '../../supabase/functions/arca-selfservice-setup/handler.ts'
import { wsaaLoginWithPendingPair } from '../../supabase/functions/arca-selfservice-setup/wsaa.ts'

const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '')
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const PORT = Number(Deno.env.get('ARCA_E2E_HARNESS_PORT') ?? '5199')
const APP_ORIGIN = Deno.env.get('ARCA_E2E_APP_ORIGIN') ?? 'http://localhost:5174'

const host = (() => { try { return new URL(SUPABASE_URL).hostname } catch { return '' } })()
if (!['127.0.0.1', 'localhost', '::1'].includes(host) || !ANON_KEY || !SERVICE_KEY) {
  console.error('arca-setup-edge-harness: SUPABASE_URL debe ser el stack LOCAL y hacen falta las claves locales.')
  Deno.exit(2)
}

// ── CA sintética (hace de ARCA homologación) ───────────────────────────────
const caKeys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 })
const CA_ISSUER = [{ name: 'countryName', value: 'AR' }, { name: 'organizationName', value: 'AFIP' }, { name: 'commonName', value: 'Computadores Test' }]

function issue(publicKey: unknown, subject: unknown[]): string {
  const cert = forge.pki.createCertificate()
  cert.publicKey = publicKey
  cert.serialNumber = '0a' + crypto.randomUUID().replace(/-/g, '').slice(0, 14)
  cert.validity.notBefore = new Date(Date.now() - 86_400_000)
  cert.validity.notAfter = new Date(Date.now() + 2 * 365 * 86_400_000)
  cert.setSubject(subject)
  cert.setIssuer(CA_ISSUER)
  cert.sign(caKeys.privateKey, forge.md.sha256.create())
  return forge.pki.certificateToPem(cert).trim()
}

// ── Estado de control ─────────────────────────────────────────────────────
type WsaaMode = 'ta' | 'gateway' | 'not_authorized'
let wsaaMode: WsaaMode = 'ta'
let loginCms = 0
let failRpc = new Map<string, number>()
const actions: Record<string, number> = {}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  if (!/afip\.gov\.ar/.test(url)) return realFetch(input, init)
  if (!url.endsWith('/ws/services/LoginCms')) return new Response('no permitido en E2E', { status: 599 })
  loginCms++
  if (wsaaMode === 'gateway') return new Response('<html><body>502 Bad Gateway</body></html>', { status: 502 })
  if (wsaaMode === 'not_authorized') {
    return new Response('<soapenv:Envelope><soapenv:Body><soapenv:Fault><faultcode>ns1:coe.notAuthorized</faultcode><faultstring>Computador no autorizado a acceder al servicio</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>', { status: 500 })
  }
  const cms = String(init?.body ?? '').match(/<ser:in0>([^<]+)<\/ser:in0>/)?.[1] ?? ''
  let trusted = false
  try {
    const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.decode64(cms)))
    trusted = caKeys.publicKey.verify(
      forge.md.sha256.create().update(forge.asn1.toDer(p7.certificates[0].tbsCertificate).getBytes()).digest().bytes(),
      p7.certificates[0].signature,
    )
  } catch { trusted = false }
  if (!trusted) {
    return new Response('<soapenv:Envelope><soapenv:Body><soapenv:Fault><faultcode>ns1:cms.cert.untrusted</faultcode><faultstring>x</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>', { status: 500 })
  }
  const t = new Date(Date.now() + 12 * 3_600_000 - 3 * 3_600_000)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const exp = `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}.${p(t.getUTCMilliseconds(), 3)}-03:00`
  const ta = `&lt;loginTicketResponse&gt;&lt;header&gt;&lt;expirationTime&gt;${exp}&lt;/expirationTime&gt;&lt;/header&gt;&lt;credentials&gt;&lt;token&gt;LOCAL-E2E-TOKEN&lt;/token&gt;&lt;sign&gt;LOCAL-E2E-SIGN&lt;/sign&gt;&lt;/credentials&gt;&lt;/loginTicketResponse&gt;`
  return new Response(`<soapenv:Envelope><soapenv:Body><loginCmsResponse><loginCmsReturn>${ta}</loginCmsReturn></loginCmsResponse></soapenv:Body></soapenv:Envelope>`, { status: 200 })
}) as typeof fetch

// ── Clientes mínimos contra el stack local ────────────────────────────────
async function postgrestRpc(name: string, args: Record<string, unknown>, headers: Record<string, string>) {
  const res = await realFetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY, ...headers },
    body: JSON.stringify(args),
  })
  const text = await res.text()
  let data: unknown = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  return res.ok ? { data, error: null } : { data: null, error: { status: res.status } }
}

function userClient(req: Request, authorization: string) {
  const headers = userDataApiHeaders(req, authorization)
  return {
    auth: {
      getUser: async () => {
        const res = await realFetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: authorization } })
        if (!res.ok) return { data: { user: null }, error: { status: res.status } }
        const user = await res.json() as { id?: string }
        return { data: { user: user.id ? { id: user.id } : null }, error: null }
      },
    },
    rpc: (name: string, args: Record<string, unknown> = {}) => postgrestRpc(name, args, headers),
  }
}

const cors = createCors(computeAllowedOrigins([APP_ORIGIN]))
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

async function control(req: Request, path: string): Promise<Response> {
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) as Record<string, unknown> : {}
  switch (path) {
    case '/__e2e/reset':
      wsaaMode = 'ta'; loginCms = 0; failRpc = new Map(); for (const k of Object.keys(actions)) delete actions[k]
      return json({ ok: true })
    case '/__e2e/mode':
      if (body.wsaa === 'ta' || body.wsaa === 'gateway' || body.wsaa === 'not_authorized') wsaaMode = body.wsaa
      // { failRpc: { arca_selfservice_activate: 2 } } → las próximas N llamadas a esa RPC fallan con 503.
      if (body.failRpc && typeof body.failRpc === 'object') failRpc = new Map(Object.entries(body.failRpc as Record<string, number>).map(([k, v]) => [k, Number(v)]))
      return json({ ok: true, wsaaMode, failRpc: Object.fromEntries(failRpc) })
    case '/__e2e/stats':
      return json({ loginCms, actions, wsaaMode })
    case '/__e2e/sign': {
      // ARCA emite el certificado para el CSR que presentó el usuario.
      const csr = forge.pki.certificationRequestFromPem(String(body.csrPem ?? ''))
      if (!csr.verify()) return json({ ok: false }, 400)
      return json({ ok: true, certificatePem: issue(csr.publicKey, csr.subject.attributes) })
    }
    case '/__e2e/foreign': {
      // Certificado válido de la CA pero para OTRA clave (mismo subject): no corresponde.
      const other = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 })
      const subject = [{ name: 'commonName', value: String(body.cn) }, { name: 'serialNumber', value: String(body.serialnumber) }]
      return json({ ok: true, certificatePem: issue(other.publicKey, subject) })
    }
    default:
      return json({ ok: false }, 404)
  }
}

Deno.serve({ hostname: '127.0.0.1', port: PORT, onListen: () => console.log(`arca-setup-edge-harness listo en http://127.0.0.1:${PORT}`) }, async (req) => {
  const path = new URL(req.url).pathname
  if (path.startsWith('/__e2e/')) return await control(req, path)
  if (!path.endsWith('/functions/v1/arca-selfservice-setup')) return json({ ok: false }, 404)

  if (req.method === 'POST') {
    const action = await req.clone().json().then((b: { action?: unknown }) => String(b.action ?? '?')).catch(() => '?')
    actions[action] = (actions[action] ?? 0) + 1
  }
  return await handleSetupRequest(req, {
    cors,
    authorize: (request) => authorizeArcaManager(request.headers.get('Authorization'), { createUserClient: (authorization) => userClient(request, authorization) }),
    hasArcaFeature: async (request) => {
      const r = await userClient(request, request.headers.get('Authorization') ?? '').rpc('business_has_feature', { p_feature: 'arca' })
      if (r.error) throw new Error('FEATURE_CHECK_FAILED')
      return r.data === true
    },
    rpc: async (name, args) => {
      const pending = failRpc.get(name) ?? 0
      if (pending > 0) { failRpc.set(name, pending - 1); return { data: null, error: { status: 503 } } }
      return await postgrestRpc(name, args, { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY })
    },
    generateKeyAndCsr: generateSetupKeyAndCsr,
    wsaaLogin: (input) => wsaaLoginWithPendingPair(input),
    newAttemptId: () => crypto.randomUUID(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  })
})
