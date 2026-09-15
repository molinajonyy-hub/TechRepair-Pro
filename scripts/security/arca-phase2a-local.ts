/**
 * ARCA Self-Service Phase 2A — prueba END-TO-END contra el stack Supabase LOCAL.
 *
 *   deno run -A --node-modules-dir=auto scripts/security/arca-phase2a-local.ts
 *
 * Ejecuta el handler REAL del Edge (`arca-selfservice-setup/handler.ts`) con dependencias reales:
 *   · RPC service_role vía PostgREST local (JWT firmado con el secreto local);
 *   · plan con `business_has_feature('arca')` usando el JWT REAL del owner;
 *   · clave + CSR con node-forge; firma PKCS#7 real con los helpers WSAA compartidos;
 *   · una CA sintética "Computadores Test / AFIP" firma el CSR (hace de ARCA);
 *   · `fetch` a WSAA simulado: comprueba que el CMS lleve el certificado exacto y emite un TA con
 *     la forma real (milisegundos + -03:00); en modo "gateway" responde un 502 sin fault (ambiguo).
 * Más una matriz HTTP de las 8 RPC (anon y authenticated no; service_role sí).
 *
 * Nunca apunta a producción: sólo contenedores supabase_*_<project_id> locales. Siembra negocios
 * sintéticos y los borra al final pase lo que pase.
 */
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1'
// @ts-ignore: node-forge en Deno via npm
import forge from 'npm:node-forge@1.3.1'
import { createCors, computeAllowedOrigins } from '../../supabase/functions/_shared/scopedCors.ts'
import { handleSetupRequest } from '../../supabase/functions/arca-selfservice-setup/handler.ts'
import { generateSetupKeyAndCsr } from '../../supabase/functions/arca-selfservice-setup/crypto.ts'
import { wsaaLoginWithPendingPair } from '../../supabase/functions/arca-selfservice-setup/wsaa.ts'

const project = (await Deno.readTextFile('supabase/config.toml')).match(/^project_id = "([a-z0-9-]+)"/m)?.[1]
if (!project) throw new Error('No se pudo identificar el proyecto Supabase local')

async function docker(args: string[], input?: string): Promise<string> {
  const cmd = new Deno.Command('docker', { args, stdin: input === undefined ? 'null' : 'piped', stdout: 'piped', stderr: 'piped' })
  const child = cmd.spawn()
  if (input !== undefined) {
    const w = child.stdin.getWriter()
    await w.write(new TextEncoder().encode(input))
    await w.close()
  }
  const out = await child.output()
  if (!out.success) throw new Error(`docker ${args[0]} falló: ${new TextDecoder().decode(out.stderr).slice(0, 400)}`)
  return new TextDecoder().decode(out.stdout).trim()
}
const sql = (q: string) => docker(['exec', '-i', `supabase_db_${project}`, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'], q)

const rest = JSON.parse(await docker(['inspect', `supabase_rest_${project}`]))[0]
const kong = JSON.parse(await docker(['inspect', `supabase_kong_${project}`]))[0]
const env = Object.fromEntries(rest.Config.Env.map((s: string) => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)] }))
const port = kong.NetworkSettings.Ports?.['8000/tcp']?.[0]?.HostPort
assert(env.PGRST_JWT_SECRET && port, 'Falta configuración local')
const API = `http://127.0.0.1:${port}/rest/v1`
let secret = new TextEncoder().encode(env.PGRST_JWT_SECRET)
if (env.PGRST_JWT_SECRET.trim().startsWith('{')) {
  const k = JSON.parse(env.PGRST_JWT_SECRET).keys.find((x: any) => x.kty === 'oct')
  secret = Uint8Array.from(atob(k.k.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
}
const hmacKey = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
async function jwt(role: string, sub?: string) {
  const h = b64u(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const claims: Record<string, unknown> = { role, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 900 }
  if (sub) claims.sub = sub
  const c = b64u(new TextEncoder().encode(JSON.stringify(claims)))
  const s = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(`${h}.${c}`)))
  return `${h}.${c}.${b64u(s)}`
}
const ANON = await jwt('anon')
const SERVICE = await jwt('service_role')

async function rpc(name: string, args: Record<string, unknown>, bearer: string) {
  const res = await fetch(`${API}/rpc/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${bearer}`, 'x-techrepair-client-contract': '1' },
    body: JSON.stringify(args),
  })
  const text = await res.text()
  let data: unknown = null
  try { data = text ? JSON.parse(text) : null } catch { /* texto */ }
  return { status: res.status, data, text }
}

const id = () => crypto.randomUUID()
const T = { A: id(), X: id(), C: id(), owner: id(), ownerX: id(), ownerC: id(), tech: id() }
let checks = 0
let requests = 0
const expect = (cond: unknown, label: string, detail = '') => { checks++; assert(cond, `${label}${detail ? ` — ${detail}` : ''}`) }
const transcript: string[] = []

// ── CA sintética (hace de ARCA) ─────────────────────────────────────────────
const caKeys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 })
function arcaSigns(csrPem: string): string {
  const csr = forge.pki.certificationRequestFromPem(csrPem)
  assert(csr.verify(), 'el CSR generado por el Edge verifica')
  const cert = forge.pki.createCertificate()
  cert.publicKey = csr.publicKey
  cert.serialNumber = '0a' + crypto.randomUUID().replace(/-/g, '').slice(0, 14)
  cert.validity.notBefore = new Date(Date.now() - 86400_000)
  cert.validity.notAfter = new Date(Date.now() + 2 * 365 * 86400_000)
  cert.setSubject(csr.subject.attributes)
  cert.setIssuer([{ name: 'countryName', value: 'AR' }, { name: 'organizationName', value: 'AFIP' }, { name: 'commonName', value: 'Computadores Test' }])
  cert.sign(caKeys.privateKey, forge.md.sha256.create())
  return forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes())
}

// ── WSAA simulado sobre el fetch global ─────────────────────────────────────
const realFetch = globalThis.fetch
let attachedCertPem = ''
let wsaaMode: 'ta' | 'gateway' = 'ta'
const wsaaHits: string[] = []
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (!/afip\.gov\.ar/.test(url)) return realFetch(input, init)
  wsaaHits.push(url)
  if (!url.endsWith('/ws/services/LoginCms')) return new Response('forbidden', { status: 599 })
  if (wsaaMode === 'gateway') return new Response('<html><body>502 Bad Gateway</body></html>', { status: 502 })
  const cms = String(init?.body ?? '').match(/<ser:in0>([^<]+)<\/ser:in0>/)?.[1] ?? ''
  const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.decode64(cms)))
  if (forge.pki.certificateToPem(p7.certificates[0]).trim() !== attachedCertPem) {
    return new Response('<soapenv:Envelope><soapenv:Body><soapenv:Fault><faultcode>ns1:cms.cert.untrusted</faultcode><faultstring>x</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>', { status: 500 })
  }
  const t = new Date(Date.now() + 12 * 3600_000 - 3 * 3600_000)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const exp = `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}.${p(t.getUTCMilliseconds(), 3)}-03:00`
  const ta = `&lt;loginTicketResponse&gt;&lt;header&gt;&lt;expirationTime&gt;${exp}&lt;/expirationTime&gt;&lt;/header&gt;&lt;credentials&gt;&lt;token&gt;LOCAL-E2E-TOKEN&lt;/token&gt;&lt;sign&gt;LOCAL-E2E-SIGN&lt;/sign&gt;&lt;/credentials&gt;&lt;/loginTicketResponse&gt;`
  return new Response(`<soapenv:Envelope><soapenv:Body><loginCmsResponse><loginCmsReturn>${ta}</loginCmsReturn></loginCmsResponse></soapenv:Body></soapenv:Envelope>`, { status: 200 })
}) as typeof fetch

let seeded = false
try {
  await sql(`
    BEGIN;
    SET session_replication_role = replica;
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
      ('${T.owner}', 'owner@arca-p2a-e2e.invalid', now()), ('${T.ownerX}', 'ownerx@arca-p2a-e2e.invalid', now()),
      ('${T.ownerC}', 'ownerc@arca-p2a-e2e.invalid', now()), ('${T.tech}', 'tech@arca-p2a-e2e.invalid', now());
    INSERT INTO public.businesses (id, name, owner_user_id, subscription_plan, subscription_status) VALUES
      ('${T.A}', 'ARCA P2A E2E A', '${T.owner}', 'pro', 'active'),
      ('${T.X}', 'ARCA P2A E2E X', '${T.ownerX}', 'pro', 'active'),
      ('${T.C}', 'ARCA P2A E2E C', '${T.ownerC}', 'pro', 'active');
    INSERT INTO public.profiles (id, user_id, business_id, role, is_active, email) VALUES
      ('${T.owner}', '${T.owner}', '${T.A}', 'owner', true, 'owner@arca-p2a-e2e.invalid'),
      ('${T.tech}', '${T.tech}', '${T.A}', 'tech', true, 'tech@arca-p2a-e2e.invalid'),
      ('${T.ownerX}', '${T.ownerX}', '${T.X}', 'owner', true, 'ownerx@arca-p2a-e2e.invalid'),
      ('${T.ownerC}', '${T.ownerC}', '${T.C}', 'owner', true, 'ownerc@arca-p2a-e2e.invalid');
    INSERT INTO public.arca_config (business_id, cuit, cuit_emisor, ambiente, punto_venta, alias, cert_file, estado_conexion)
      VALUES ('${T.C}', '20111111112', '20111111112', 'produccion', 10, 'ya-configurado', '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----', 'conectado');
    INSERT INTO private.arca_private_key_credentials (business_id, private_key_secret_id, private_key_fingerprint, credential_status)
      VALUES ('${T.C}', vault.create_secret('E2E-ACTIVE', 'arca-p2a-e2e:${T.C}'), '${'ab'.repeat(32)}', 'active');
    SET session_replication_role = origin;
    COMMIT;`)
  seeded = true

  // ── 1. Matriz HTTP de las 8 RPC ──
  const RPCS: Array<[string, Record<string, unknown>]> = [
    ['arca_selfservice_prepare_initial', { p_business_id: T.A, p_actor: T.owner, p_idempotency_key: 'matrix-0001', p_cuit: '20111111112', p_razon_social: 'x', p_ambiente: 'homologacion', p_punto_venta: 1, p_alias: 'matrixalias' }],
    ['arca_selfservice_get_csr', { p_business_id: T.A, p_actor: T.owner }],
    ['arca_selfservice_attach_certificate', { p_business_id: T.A, p_actor: T.owner, p_certificate_pem: 'x' }],
    ['arca_selfservice_verification_material', { p_business_id: T.A, p_actor: T.owner, p_attempt_id: id() }],
    ['arca_selfservice_record_verification', { p_business_id: T.A, p_actor: T.owner, p_expected_fingerprint: 'x', p_expected_certificate_sha256: 'x', p_token: 't', p_sign: 's', p_expires_at: new Date().toISOString() }],
    ['arca_selfservice_record_verification_failure', { p_business_id: T.A, p_actor: T.owner, p_attempt_id: id(), p_code: 'WSAA_REJECTED' }],
    ['arca_selfservice_activate', { p_business_id: T.A, p_actor: T.owner, p_expected_fingerprint: 'x', p_expected_certificate_sha256: 'x', p_idempotency_key: 'matrix-act-0001' }],
    ['arca_selfservice_cancel', { p_business_id: T.A, p_actor: T.owner }],
  ]
  const ownerJwt = await jwt('authenticated', T.owner)
  for (const [name, args] of RPCS) {
    for (const [who, bearer] of [['anon', ANON], ['authenticated owner', ownerJwt]] as const) {
      requests++
      const r = await rpc(name, args, bearer)
      expect([401, 403].includes(r.status), `${who} no ejecuta ${name}`, `${r.status} ${r.text.slice(0, 120)}`)
    }
  }
  requests++
  const svcProbe = await rpc('arca_selfservice_get_csr', { p_business_id: T.A, p_actor: T.owner }, SERVICE)
  expect(svcProbe.status === 200 && (svcProbe.data as any)?.state === 'NO_SETUP_IN_PROGRESS', 'service_role sí ejecuta (sin configuración viva)', svcProbe.text)
  requests++
  const svcTech = await rpc('arca_selfservice_get_csr', { p_business_id: T.A, p_actor: T.tech }, SERVICE)
  expect((svcTech.data as any)?.state === 'UNAUTHORIZED', 'service_role con actor tech → UNAUTHORIZED', svcTech.text)

  // ── 2. Handler real ──
  const cors = createCors(computeAllowedOrigins([]))
  const makeDeps = (userId: string, businessId: string) => ({
    cors,
    authorize: async () => ({ userId, businessId }),
    hasArcaFeature: async () => {
      requests++
      const r = await rpc('business_has_feature', { p_feature: 'arca' }, await jwt('authenticated', userId))
      if (r.status !== 200) throw new Error('feature')
      return r.data === true
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      requests++
      const r = await rpc(name, args, SERVICE)
      return r.status === 200 ? { data: r.data, error: null } : { data: null, error: { status: r.status } }
    },
    generateKeyAndCsr: generateSetupKeyAndCsr,
    wsaaLogin: (input: Parameters<typeof wsaaLoginWithPendingPair>[0]) => wsaaLoginWithPendingPair(input),
    newAttemptId: () => crypto.randomUUID(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  })
  const call = async (deps: ReturnType<typeof makeDeps>, body: Record<string, unknown>) => {
    const res = await handleSetupRequest(new Request('https://edge.local/arca-selfservice-setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://www.techrepairpro.app', Authorization: 'Bearer x' },
      body: JSON.stringify(body),
    }), deps)
    const text = await res.text()
    transcript.push(text)
    return { status: res.status, body: JSON.parse(text), text }
  }
  const statusOf = async (userId: string, businessId: string) => {
    requests++
    const r = await rpc('get_arca_selfservice_status', { p_business_id: businessId }, await jwt('authenticated', userId))
    const s = r.data as any
    return `${s.status}|${s.configured}|${s.setup.state}|${s.setup.kind ?? '-'}|${s.setup.step ?? '-'}|${s.connection.state}|${s.next_action}`
  }
  const holdOf = async (userId: string, businessId: string) => {
    requests++
    const r = await rpc('get_arca_selfservice_status', { p_business_id: businessId }, await jwt('authenticated', userId))
    const s = r.data as any
    return `${s.setup.step ?? '-'}|${s.setup.verification_hold ?? '-'}|${s.setup.retry_not_before ? 'bound' : '-'}`
  }

  const A = makeDeps(T.owner, T.A)
  expect(await statusOf(T.owner, T.A) === 'not_configured|false|not_started|-|-|unknown|start_setup', 'Phase 1 inicial')

  let r = await call(A, { action: 'prepare', idempotency_key: 'e2e-wizard-0001', cuit: '20-11111111-2', razon_social: 'QA E2E SRL', ambiente: 'homologacion', punto_venta: 3, alias: 'qae2esetup' })
  expect(r.status === 200 && r.body.state === 'SETUP_PREPARED', 'prepare', r.text.slice(0, 200))
  const csrPem = r.body.csr.pem as string
  expect(r.body.csr.filename === 'techrepair-arca-20111111112.csr', 'nombre de archivo')
  r = await call(A, { action: 'prepare', idempotency_key: 'e2e-wizard-0001', cuit: '20-11111111-2', razon_social: 'QA E2E SRL', ambiente: 'homologacion', punto_venta: 3, alias: 'qae2esetup' })
  expect(r.status === 200 && r.body.state === 'SETUP_ALREADY_PREPARED' && r.body.csr.pem === csrPem, 'prepare replay devuelve el mismo CSR')
  expect(await statusOf(T.owner, T.A) === 'setup_in_progress|false|in_progress|initial|certificate|unknown|continue_setup', 'Phase 1 paso certificate')

  r = await call(A, { action: 'csr' })
  expect(r.status === 200 && r.body.csr.pem === csrPem, 'csr recuperable')

  const derB64 = arcaSigns(csrPem)
  attachedCertPem = forge.pki.certificateToPem(forge.pki.certificateFromAsn1(forge.asn1.fromDer(forge.util.decode64(derB64)))).trim()
  r = await call(A, { action: 'certificate', certificate_der_base64: derB64 })
  expect(r.status === 200 && r.body.state === 'CERTIFICATE_ATTACHED', 'certificado emitido por la "CA" adjunto', r.text)
  expect(await statusOf(T.owner, T.A) === 'setup_in_progress|false|in_progress|initial|verification|unknown|continue_setup', 'Phase 1 paso verification')

  // Otro negocio no ve ni toca la configuración de A.
  const X = makeDeps(T.ownerX, T.X)
  r = await call(X, { action: 'csr' })
  expect(r.status === 409 && r.body.state === 'NO_SETUP_IN_PROGRESS', 'X no ve la configuración de A')
  r = await call(X, { action: 'certificate', certificate_der_base64: derB64 })
  expect(r.status === 409 && r.body.state === 'NO_SETUP_IN_PROGRESS', 'X no adjunta a A')

  r = await call(A, { action: 'verify', idempotency_key: 'e2e-verify-0001' })
  expect(r.status === 200 && r.body.state === 'ACTIVATED' && r.body.connection === 'connected', 'verify → activado', r.text)
  expect(wsaaHits.length === 1 && wsaaHits[0] === 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms', 'un solo LoginCms de homologación, nunca WSFE', wsaaHits.join(','))
  expect(await statusOf(T.owner, T.A) === 'connected|true|completed|-|-|connected|none', 'Phase 1 conectado')

  // El certificado se guarda re-codificado desde los bytes validados (PEM canónico LF): se comparan los DER.
  const cfg = (await sql(`SELECT concat_ws('|', private.arca_pem_to_der(cert_file) = decode('${derB64}', 'base64'), cuit_emisor, wsaa_token, estado_conexion, ultima_sincronizacion IS NOT NULL)
                          FROM public.arca_config WHERE business_id = '${T.A}'`))
  expect(cfg === 't|20111111112|LOCAL-E2E-TOKEN|conectado|t', 'arca_config instalado', cfg)
  const signing = await sql(`SELECT private.arca_key_matches_certificate(private.arca_get_private_key_for_signing('${T.A}'), cert_file) FROM public.arca_config WHERE business_id = '${T.A}'`)
  expect(signing === 't', 'la clave de firma activa corresponde al certificado activo')

  r = await call(A, { action: 'verify', idempotency_key: 'e2e-verify-0002' })
  expect(r.status === 200 && r.body.state === 'SETUP_ALREADY_COMPLETED' && wsaaHits.length === 1, 'verify tardío no vuelve a ARCA')
  r = await call(A, { action: 'prepare', idempotency_key: 'e2e-wizard-0002', cuit: '20-11111111-2', razon_social: 'QA', ambiente: 'homologacion', punto_venta: 3, alias: 'qae2esetup' })
  expect(r.status === 409 && r.body.state === 'ARCA_ALREADY_CONFIGURED', 'segundo alta rechazado')

  // ── 3. Negocio ya configurado (el caso Clic): nunca ──
  const C = makeDeps(T.ownerC, T.C)
  const worldC = await sql(`SELECT md5(coalesce((SELECT t::text FROM public.arca_config t WHERE business_id='${T.C}'),'') || coalesce((SELECT t::text FROM private.arca_private_key_credentials t WHERE business_id='${T.C}'),''))`)
  for (const body of [
    { action: 'prepare', idempotency_key: 'e2e-clic-0001', cuit: '20-11111111-2', razon_social: 'QA', ambiente: 'produccion', punto_venta: 10, alias: 'ya-configurado' },
    { action: 'csr' }, { action: 'certificate', certificate_der_base64: derB64 }, { action: 'verify', idempotency_key: 'e2e-clic-verify' },
  ]) {
    r = await call(C, body)
    expect(r.status === 409 && r.body.state === 'ARCA_ALREADY_CONFIGURED', `configurado: ${body.action}`, r.text)
  }
  r = await call(C, { action: 'cancel' })
  expect(r.status === 200 && r.body.state === 'SETUP_NOT_IN_PROGRESS', 'configurado: cancel no hace nada')
  const worldC2 = await sql(`SELECT md5(coalesce((SELECT t::text FROM public.arca_config t WHERE business_id='${T.C}'),'') || coalesce((SELECT t::text FROM private.arca_private_key_credentials t WHERE business_id='${T.C}'),''))`)
  expect(worldC === worldC2, 'el negocio configurado quedó byte-idéntico')
  expect(wsaaHits.length === 1, 'ningún LoginCms para el negocio configurado')

  // ── 4. LoginCms ambiguo en X: espera durable, sin repetir, sobrevive a cancelar ──
  r = await call(X, { action: 'prepare', idempotency_key: 'e2e-cancel-0001', cuit: '20-11111111-2', razon_social: 'X', ambiente: 'homologacion', punto_venta: 1, alias: 'qae2ecancel' })
  expect(r.status === 200, 'prepare X', r.text)
  const derX = arcaSigns(r.body.csr.pem as string)
  attachedCertPem = forge.pki.certificateToPem(forge.pki.certificateFromAsn1(forge.asn1.fromDer(forge.util.decode64(derX)))).trim()
  r = await call(X, { action: 'certificate', certificate_der_base64: derX })
  expect(r.status === 200 && r.body.state === 'CERTIFICATE_ATTACHED', 'certificado X', r.text)
  const hitsBefore = wsaaHits.length
  wsaaMode = 'gateway'
  r = await call(X, { action: 'verify', idempotency_key: 'e2e-ambiguous-0001' })
  expect(r.status === 409 && r.body.state === 'WSAA_RESULT_UNKNOWN' && r.body.retry_after_seconds >= 44900, 'gateway 502 sin fault → resultado desconocido con espera', r.text)
  expect(wsaaHits.length === hitsBefore + 1, 'un solo LoginCms para el intento ambiguo')
  expect(await holdOf(T.ownerX, T.X) === 'verification|result_unknown|bound', 'Phase 1 muestra la espera ambigua')
  wsaaMode = 'ta'
  r = await call(X, { action: 'verify', idempotency_key: 'e2e-ambiguous-0002' })
  expect(r.status === 409 && r.body.state === 'WSAA_RESULT_UNKNOWN', 'verify inmediato rechazado por la base', r.text)
  expect(wsaaHits.length === hitsBefore + 1, 'el verify inmediato NO llama a WSAA')
  const holdRow = await sql(`SELECT concat_ws('|', verification_hold, verification_retry_not_before > now() + interval '12 hours 29 minutes') FROM private.arca_credential_rotations WHERE business_id='${T.X}' AND state='pending_rotation'`)
  expect(holdRow === 'result_unknown|t', 'espera durable de 12 h 30 min', holdRow)
  const secretX = await sql(`SELECT private_key_secret_id FROM private.arca_credential_rotations WHERE business_id='${T.X}' AND state='pending_rotation'`)
  r = await call(X, { action: 'cancel' })
  expect(r.status === 200 && r.body.state === 'SETUP_CANCELLED' && r.body.remote_ticket_possible === true, 'cancel X informa un TA posible', r.text)
  expect(!/revoc/i.test(r.text), 'cancel no dice haber revocado nada')
  expect(await sql(`SELECT count(*) FROM vault.secrets WHERE id='${secretX}'`) === '0', 'secreto pendiente purgado')
  r = await call(X, { action: 'cancel' })
  expect(r.status === 200 && r.body.state === 'SETUP_NOT_IN_PROGRESS', 'cancel idempotente')
  // Mismo equipo (CUIT + alias): la configuración nueva hereda la espera y no llama a WSAA.
  r = await call(X, { action: 'prepare', idempotency_key: 'e2e-cancel-0002', cuit: '20-11111111-2', razon_social: 'X', ambiente: 'homologacion', punto_venta: 1, alias: 'qae2ecancel' })
  expect(r.status === 200 && r.body.state === 'SETUP_PREPARED', 're-prepare X', r.text)
  expect(await holdOf(T.ownerX, T.X) === 'certificate|result_unknown|bound', 'Phase 1 muestra la espera heredada')
  const derX2 = arcaSigns(r.body.csr.pem as string)
  attachedCertPem = forge.pki.certificateToPem(forge.pki.certificateFromAsn1(forge.asn1.fromDer(forge.util.decode64(derX2)))).trim()
  r = await call(X, { action: 'certificate', certificate_der_base64: derX2 })
  expect(r.status === 200 && r.body.state === 'CERTIFICATE_ATTACHED', 'la espera heredada no bloquea subir el certificado', r.text)
  r = await call(X, { action: 'verify', idempotency_key: 'e2e-ambiguous-0003' })
  expect(r.status === 409 && r.body.state === 'WSAA_RESULT_UNKNOWN', 'verify del mismo equipo rechazado durante la ventana', r.text)
  expect(wsaaHits.length === hitsBefore + 1, 'ningún LoginCms a ciegas después de cancelar')
  r = await call(X, { action: 'cancel' })
  // Esta configuración no despachó ningún intento propio; la espera sigue en la fila cancelada original.
  expect(r.status === 200 && r.body.state === 'SETUP_CANCELLED' && r.body.remote_ticket_possible === false, 'cancel X (sin intento propio)', r.text)
  const inherited = await sql(`SELECT count(*) FROM private.arca_credential_rotations WHERE business_id='${T.X}' AND state='cancelled' AND verification_hold = 'result_unknown' AND verification_retry_not_before > now() + interval '12 hours'`)
  expect(inherited === '1', 'la espera original sigue vigente después de ambas cancelaciones', inherited)

  // ── 5. Exposición ──
  const all = transcript.join('\n')
  const secrets = (await sql(`SELECT string_agg(s::text, ',') FROM (SELECT private_key_secret_id s FROM private.arca_private_key_credentials WHERE business_id IN ('${T.A}','${T.C}') UNION ALL SELECT '${secretX}'::uuid) q`)).split(',')
  const attempts = (await sql(`SELECT coalesce(string_agg(verification_attempt_id::text, ','), '') FROM private.arca_credential_rotations WHERE business_id IN ('${T.A}','${T.X}')`)).split(',').filter(Boolean)
  expect(attempts.length >= 2, 'se registraron los nonces de intento')
  for (const needle of ['PRIVATE KEY', 'LOCAL-E2E-TOKEN', 'LOCAL-E2E-SIGN', 'signing_key_pem', 'fingerprint', 'Bad Gateway', 'attempt', ...secrets, ...attempts]) {
    expect(!all.includes(needle), `ninguna respuesta del Edge contiene ${needle.slice(0, 20)}`)
  }
  assertFalse(/[0-9a-f]{64}/.test(all), 'ningún hash de 64 hex en las respuestas')

  console.log(`✅ ARCA Phase 2A local E2E: ${checks} aserciones, ${requests} requests PostgREST, ${wsaaHits.length} LoginCms simulados, 0 fallas.`)
} catch (error) {
  console.error(`❌ ARCA Phase 2A local E2E falló tras ${checks} aserciones:`, error instanceof Error ? error.message : error)
  Deno.exitCode = 1
} finally {
  globalThis.fetch = realFetch
  if (seeded) {
    const biz = `'${T.A}','${T.X}','${T.C}'`
    const users = `'${T.owner}','${T.ownerX}','${T.ownerC}','${T.tech}'`
    await sql(`
      BEGIN;
      SET session_replication_role = replica;
      DELETE FROM vault.secrets WHERE id IN (SELECT private_key_secret_id FROM private.arca_private_key_credentials WHERE business_id IN (${biz}))
         OR id IN (SELECT private_key_secret_id FROM private.arca_credential_rotations WHERE business_id IN (${biz}) AND private_key_secret_id IS NOT NULL);
      DELETE FROM public.arca_emission_attempts WHERE business_id IN (${biz});
      DELETE FROM private.arca_credential_rotations WHERE business_id IN (${biz});
      DELETE FROM private.arca_private_key_credentials WHERE business_id IN (${biz});
      DELETE FROM private.arca_credential_audit WHERE business_id IN (${biz});
      DELETE FROM public.arca_config WHERE business_id IN (${biz});
      DELETE FROM public.profiles WHERE id IN (${users});
      DELETE FROM public.businesses WHERE id IN (${biz});
      DELETE FROM auth.users WHERE id IN (${users});
      SET session_replication_role = origin;
      COMMIT;`)
    const left = await sql(`SELECT (SELECT count(*) FROM auth.users WHERE email LIKE '%@arca-p2a-e2e.invalid') + (SELECT count(*) FROM vault.secrets WHERE name LIKE 'arca-private-key-setup:%' AND name ~ '(${T.A}|${T.X})') + (SELECT count(*) FROM vault.secrets WHERE name = 'arca-p2a-e2e:${T.C}')`)
    if (left !== '0') { console.error(`❌ limpieza incompleta: ${left} residuos`); Deno.exitCode = 1 }
  }
}
