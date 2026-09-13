/**
 * ARCA Self-Service Phase 2A — Edge arca-selfservice-setup (handler puro + crypto + WSAA).
 *
 * Sin red ni base: autoridad, RPC, generación de clave y WSAA se inyectan. Lo que se prueba acá
 * es el contrato del borde:
 *   · CORS canónico, método, autoridad canónica, allowlist estricta de campos, tenant por
 *     identidad, plan, defensa en profundidad SQL — antes de tocar cualquier RPC de datos;
 *   · prepare: el probe evita generar claves en un replay; la clave va sólo a la RPC;
 *   · certificate: PEM/DER normalizado, clave privada rechazada sin RPC;
 *   · verify: WSAA con el material exacto, fallas acotadas (faults reales vía HTTP 500),
 *     reintento del registro del ticket, activación reintentable, ninguna respuesta con material;
 *   · crypto real (node-forge, mismo runtime que producción).
 *
 * RUN: deno test -A --node-modules-dir=auto tests/deno/arcaSelfServiceSetup.test.ts
 */
import { assert, assertEquals, assertFalse, assertMatch } from 'jsr:@std/assert@1'
// @ts-ignore: node-forge en Deno via npm
import forge from 'npm:node-forge@1.3.1'
import { ArcaAuthorizationError } from '../../supabase/functions/_shared/arcaAuthorization.ts'
import { createCors, computeAllowedOrigins } from '../../supabase/functions/_shared/scopedCors.ts'
import { handleSetupRequest, type SetupDeps } from '../../supabase/functions/arca-selfservice-setup/handler.ts'
import {
  generateSetupKeyAndCsr, isAuthorizedSubject, normalizeCertificateInput, spkiFingerprint,
} from '../../supabase/functions/arca-selfservice-setup/crypto.ts'
import {
  classifyWsaaFailure, WsaaLoginError, wsaaLoginWithPendingPair,
} from '../../supabase/functions/arca-selfservice-setup/wsaa.ts'

const BIZ = '00000000-0000-4000-8000-0000000a2a01'
const OTHER = '00000000-0000-4000-8000-0000000a2a02'
const USER = '00000000-0000-4000-8000-0000000a2a03'
const ORIGIN = 'https://www.techrepairpro.app'
const FP = 'a'.repeat(64)
const SHA = 'b'.repeat(64)
const KEY_SENTINEL = '-----BEGIN RSA PRIVATE KEY-----\nSENTINEL-KEY\n-----END RSA PRIVATE KEY-----'
const TOKEN_SENTINEL = 'TOKEN-SENTINEL-P2A'
const SIGN_SENTINEL = 'SIGN-SENTINEL-P2A'

type Call = { name: string; args: Record<string, unknown> }

function makeDeps(opts: {
  rpc?: (name: string, args: Record<string, unknown>, n: number) => { data: unknown; error: unknown }
  authorize?: () => Promise<{ userId: string; businessId: string }>
  feature?: boolean | 'throw'
  wsaa?: () => Promise<{ token: string; sign: string; expirationTime: string }>
} = {}) {
  const calls: Call[] = []
  const keygen: unknown[] = []
  const wsaaCalls: unknown[] = []
  const deps: SetupDeps = {
    cors: createCors(computeAllowedOrigins([])),
    authorize: opts.authorize ?? (async () => ({ userId: USER, businessId: BIZ })),
    hasArcaFeature: async () => {
      if (opts.feature === 'throw') throw new Error('x')
      return opts.feature ?? true
    },
    rpc: async (name, args) => {
      calls.push({ name, args })
      if (name === 'is_business_owner_or_admin') return { data: true, error: null }
      return opts.rpc ? opts.rpc(name, args, calls.filter((c) => c.name === name).length) : { data: null, error: { message: 'unexpected' } }
    },
    generateKeyAndCsr: async (subject) => {
      keygen.push(subject)
      return { keyPem: KEY_SENTINEL, csrPem: '-----BEGIN CERTIFICATE REQUEST-----\nCSR\n-----END CERTIFICATE REQUEST-----', fingerprint: FP }
    },
    wsaaLogin: async (input) => {
      wsaaCalls.push(input)
      return opts.wsaa ? opts.wsaa() : { token: TOKEN_SENTINEL, sign: SIGN_SENTINEL, expirationTime: new Date(Date.now() + 11 * 3600_000).toISOString() }
    },
    sleep: async () => {},
    now: () => Date.now(),
  }
  return { deps, calls, keygen, wsaaCalls }
}

const post = (body: unknown, headers: Record<string, string> = {}) => new Request('https://edge.local/arca-selfservice-setup', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Authorization: 'Bearer user-jwt', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
})

const dataRpcs = (calls: Call[]) => calls.filter((c) => c.name !== 'is_business_owner_or_admin')

async function read(res: Response) {
  const text = await res.text()
  return { status: res.status, text, body: JSON.parse(text), cors: res.headers.get('Access-Control-Allow-Origin') }
}

function assertNoMaterial(text: string, label: string) {
  for (const needle of ['PRIVATE KEY', 'SENTINEL-KEY', TOKEN_SENTINEL, SIGN_SENTINEL, FP, SHA, 'signing_key_pem', 'secret', 'faultstring', 'coe.']) {
    assertFalse(text.includes(needle), `${label}: la respuesta contiene ${needle}`)
  }
}

// ── Borde común ─────────────────────────────────────────────────────────────
Deno.test('CORS: preflight de origen canónico sí; origen ajeno sin Allow-Origin; GET 405', async () => {
  const { deps, calls } = makeDeps()
  const ok = await handleSetupRequest(new Request('https://edge.local/x', {
    method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Headers': 'authorization, content-type, x-techrepair-client-contract' },
  }), deps)
  assertEquals(ok.status, 204)
  assertEquals(ok.headers.get('Access-Control-Allow-Origin'), ORIGIN)
  assertMatch(ok.headers.get('Access-Control-Allow-Headers') ?? '', /x-techrepair-client-contract/)
  const evil = await handleSetupRequest(new Request('https://edge.local/x', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), deps)
  assertEquals(evil.headers.get('Access-Control-Allow-Origin'), null)
  const get = await handleSetupRequest(new Request('https://edge.local/x', { method: 'GET', headers: { Origin: ORIGIN } }), deps)
  assertEquals(get.status, 405)
  assertEquals(calls.length, 0)
})

Deno.test('autoridad: errores canónicos pasan tal cual; cualquier otra falla es 503; sin RPC', async () => {
  for (const [err, status] of [
    [new ArcaAuthorizationError(401, 'UNAUTHENTICATED'), 401],
    [new ArcaAuthorizationError(403, 'FORBIDDEN'), 403],
    [new Error('boom'), 503],
  ] as const) {
    const { deps, calls } = makeDeps({ authorize: async () => { throw err } })
    const r = await read(await handleSetupRequest(post({ action: 'csr' }), deps))
    assertEquals(r.status, status)
    assertEquals(calls.length, 0)
  }
})

Deno.test('body: JSON inválido, acción desconocida, campo inesperado y tamaño → rechazo sin RPC', async () => {
  const cases: Array<[unknown, number, string]> = [
    ['no-json', 400, 'BAD_REQUEST'],
    [[1, 2], 400, 'BAD_REQUEST'],
    [{ action: 'activate' }, 400, 'UNKNOWN_ACTION'],
    [{ action: 'rotate' }, 400, 'UNKNOWN_ACTION'],
    [{ action: 'csr', rotation_id: 'x' }, 400, 'UNEXPECTED_FIELD'],
    [{ action: 'certificate', certificate_pem: 'x', expires_at: '2099-01-01' }, 400, 'UNEXPECTED_FIELD'],
    [{ action: 'prepare', idempotency_key: 'k'.repeat(10), cuit: '1', razon_social: 'r', ambiente: 'homologacion', punto_venta: 1, alias: 'abc', web_service: 'wsfe' }, 400, 'UNEXPECTED_FIELD'],
    [{ action: 'verify', idempotency_key: 'k'.repeat(10), wsaa_token: 't' }, 400, 'UNEXPECTED_FIELD'],
    [{ action: 'cancel', estado_conexion: 'conectado' }, 400, 'UNEXPECTED_FIELD'],
    [{ action: 'prepare', idempotency_key: 'k'.repeat(10), cuit: '1', razon_social: 'r', ambiente: 'homologacion', punto_venta: 1, alias: 'abc', ['private' + '_key_pem']: KEY_SENTINEL }, 400, 'UNEXPECTED_FIELD'],
    [{ action: 'verify', idempotency_key: 'k'.repeat(10), signing_key_pem: KEY_SENTINEL }, 400, 'UNEXPECTED_FIELD'],
    [{ action: 'csr', vault_secret_id: 'x' }, 400, 'UNEXPECTED_FIELD'],
    [{ action: 'csr', note: 'x'.repeat(200 * 1024) }, 413, 'TOO_LARGE'],
  ]
  for (const [body, status, error] of cases) {
    const { deps, calls } = makeDeps()
    const r = await read(await handleSetupRequest(post(body), deps))
    assertEquals([r.status, r.body.error], [status, error], JSON.stringify(body).slice(0, 80))
    assertEquals(calls.length, 0)
  }
})

Deno.test('tenant: business_id ajeno 403; plan sin arca 403; chequeo de plan caído 503; SQL niega 403', async () => {
  let x = makeDeps()
  let r = await read(await handleSetupRequest(post({ action: 'csr', business_id: OTHER }), x.deps))
  assertEquals([r.status, r.body.error], [403, 'FORBIDDEN'])
  assertEquals(x.calls.length, 0)

  x = makeDeps({ feature: false })
  r = await read(await handleSetupRequest(post({ action: 'csr' }), x.deps))
  assertEquals([r.status, r.body.error], [403, 'ARCA_FEATURE_REQUIRED'])
  assertEquals(x.calls.length, 0)

  x = makeDeps({ feature: 'throw' })
  r = await read(await handleSetupRequest(post({ action: 'csr' }), x.deps))
  assertEquals(r.status, 503)

  const denied = makeDeps()
  denied.deps.rpc = async (name, args) => {
    denied.calls.push({ name, args })
    return { data: false, error: null }
  }
  r = await read(await handleSetupRequest(post({ action: 'cancel', business_id: BIZ }), denied.deps))
  assertEquals([r.status, r.body.error], [403, 'FORBIDDEN'])
  assertEquals(denied.calls.map((c) => c.name), ['is_business_owner_or_admin'])
})

// ── prepare ─────────────────────────────────────────────────────────────────
const PREPARE = { action: 'prepare', idempotency_key: 'wizard-session-0001', cuit: '20-11111111-2', razon_social: 'QA', ambiente: 'homologacion', punto_venta: 7, alias: 'qa-initial-setup' }

Deno.test('prepare: replay en el probe → sin generar clave', async () => {
  const x = makeDeps({ rpc: () => ({ data: { ok: true, state: 'SETUP_ALREADY_PREPARED', csr_pem: 'CSR-PEM', subject: { alias: 'qa-initial-setup', cuit: '20111111112' }, ambiente: 'homologacion' }, error: null }) })
  const r = await read(await handleSetupRequest(post(PREPARE), x.deps))
  assertEquals(r.status, 200)
  assertEquals(r.body.csr, { pem: 'CSR-PEM', filename: 'techrepair-arca-20111111112.csr' })
  assertEquals(x.keygen.length, 0)
  assertEquals(dataRpcs(x.calls).length, 1)
  assertEquals(dataRpcs(x.calls)[0].args.p_key_pem, null)
})

Deno.test('prepare: KEY_REQUIRED → genera con el subject del servidor, la clave va SÓLO a la RPC', async () => {
  const subject = { cn: 'qa-initial-setup', serialnumber: 'CUIT 20111111112' }
  const x = makeDeps({ rpc: (_n, args) => args.p_key_pem === null
    ? { data: { ok: false, state: 'KEY_REQUIRED', subject }, error: null }
    : { data: { ok: true, state: 'SETUP_PREPARED', csr_pem: args.p_csr_pem, subject: { alias: 'qa-initial-setup', cuit: '20111111112' }, ambiente: 'homologacion', fingerprint_leak: FP }, error: null } })
  const r = await read(await handleSetupRequest(post(PREPARE), x.deps))
  assertEquals([r.status, r.body.state], [200, 'SETUP_PREPARED'])
  assertEquals(x.keygen, [subject])
  const stored = dataRpcs(x.calls)[1]
  assertEquals([stored.args.p_key_pem, stored.args.p_fingerprint, stored.args.p_actor, stored.args.p_business_id], [KEY_SENTINEL, FP, USER, BIZ])
  assertNoMaterial(r.text, 'prepare')
})

Deno.test('prepare: subject del servidor malformado → no genera clave', async () => {
  const x = makeDeps({ rpc: () => ({ data: { ok: false, state: 'KEY_REQUIRED', subject: { cn: 'qa', serialnumber: 'CUIT 1', o: 'x' } }, error: null }) })
  const r = await read(await handleSetupRequest(post(PREPARE), x.deps))
  assertEquals(r.status, 503)
  assertEquals(x.keygen.length, 0)
})

Deno.test('prepare: estados de negocio acotados (422/409/403), tipos inválidos 400, RPC caída 503', async () => {
  for (const [state, status] of [['INVALID_CUIT', 422], ['CUIT_TENANT_MISMATCH', 422], ['ARCA_ALREADY_CONFIGURED', 409], ['SETUP_IN_PROGRESS', 409], ['IDEMPOTENCY_KEY_CONSUMED', 409], ['UNAUTHORIZED', 403]] as const) {
    const x = makeDeps({ rpc: () => ({ data: { ok: false, state, detail: 'SQLSTATE 42P01 relation "private.arca_x"' }, error: null }) })
    const r = await read(await handleSetupRequest(post(PREPARE), x.deps))
    assertEquals([r.status, r.body], [status, { ok: false, state }])
  }
  let x = makeDeps()
  let r = await read(await handleSetupRequest(post({ ...PREPARE, punto_venta: '7' }), x.deps))
  assertEquals(r.status, 400)
  r = await read(await handleSetupRequest(post({ ...PREPARE, idempotency_key: 'x' }), x.deps))
  assertEquals(r.status, 400)
  x = makeDeps({ rpc: () => ({ data: null, error: { message: 'connection refused' } }) })
  r = await read(await handleSetupRequest(post(PREPARE), x.deps))
  assertEquals([r.status, r.body.error], [503, 'SETUP_UNAVAILABLE'])
  assertFalse(r.text.includes('refused'))
})

// ── certificate ─────────────────────────────────────────────────────────────
function selfSigned(cn = 'qa-initial-setup') {
  const kp = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 })
  const cert = forge.pki.createCertificate()
  cert.publicKey = kp.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date(Date.UTC(2020, 0, 1))
  cert.validity.notAfter = new Date(Date.UTC(2035, 0, 1))
  cert.setSubject([{ name: 'commonName', value: cn }, { name: 'serialNumber', value: 'CUIT 20111111112' }])
  cert.setIssuer([{ name: 'commonName', value: 'Computadores Test' }])
  cert.sign(kp.privateKey, forge.md.sha256.create())
  return { cert, kp, pem: forge.pki.certificateToPem(cert).trim(), keyPem: forge.pki.privateKeyToPem(kp.privateKey).trim() }
}

Deno.test('certificate: clave privada 400 y certificado inválido 409 sin RPC; DER base64 llega como PEM canónico', async () => {
  const sc = selfSigned()
  let x = makeDeps()
  let r = await read(await handleSetupRequest(post({ action: 'certificate', certificate_pem: sc.pem + '\n' + sc.keyPem }), x.deps))
  assertEquals([r.status, r.body.error], [400, 'KEY_MATERIAL_NOT_ACCEPTED'])
  r = await read(await handleSetupRequest(post({ action: 'certificate', certificate_pem: 'basura' }), x.deps))
  assertEquals([r.status, r.body.state], [409, 'CERTIFICATE_INVALID'])
  r = await read(await handleSetupRequest(post({ action: 'certificate', certificate_pem: sc.pem, certificate_der_base64: 'AAAA' }), x.deps))
  assertEquals(r.status, 400)
  assertEquals(dataRpcs(x.calls).length, 0)

  x = makeDeps({ rpc: () => ({ data: { ok: true, state: 'CERTIFICATE_ATTACHED', expires_at: '2035-01-01T00:00:00Z' }, error: null }) })
  const der = forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(sc.cert)).getBytes())
  r = await read(await handleSetupRequest(post({ action: 'certificate', certificate_der_base64: der }), x.deps))
  assertEquals([r.status, r.body.state], [200, 'CERTIFICATE_ATTACHED'])
  assertEquals(dataRpcs(x.calls)[0].args.p_certificate_pem, sc.pem)

  x = makeDeps({ rpc: () => ({ data: { ok: false, state: 'CERTIFICATE_CUIT_MISMATCH' }, error: null }) })
  r = await read(await handleSetupRequest(post({ action: 'certificate', certificate_pem: `\n  ${sc.pem}  \n` }), x.deps))
  assertEquals([r.status, r.body], [409, { ok: false, state: 'CERTIFICATE_CUIT_MISMATCH' }])
})

// ── verify ──────────────────────────────────────────────────────────────────
const MATERIAL = { ok: true, state: 'VERIFICATION_MATERIAL', ambiente: 'homologacion', service: 'wsfe', fingerprint: FP, certificate_sha256: SHA, certificate_pem: 'CERT-PEM', signing_key_pem: KEY_SENTINEL }
const VERIFY = { action: 'verify', idempotency_key: 'wizard-verify-0001' }

Deno.test('verify: material → WSAA con el par exacto → registro → activación; respuesta sin material', async () => {
  const x = makeDeps({ rpc: (name) => {
    if (name === 'arca_selfservice_verification_material') return { data: MATERIAL, error: null }
    if (name === 'arca_selfservice_record_verification') return { data: { ok: true, state: 'VERIFIED' }, error: null }
    if (name === 'arca_selfservice_activate') return { data: { ok: true, state: 'ACTIVATED', connection: 'connected', expires_at: '2035-01-01T00:00:00Z' }, error: null }
    return { data: null, error: { message: 'unexpected' } }
  } })
  const r = await read(await handleSetupRequest(post(VERIFY), x.deps))
  assertEquals([r.status, r.body], [200, { ok: true, state: 'ACTIVATED', connection: 'connected', expires_at: '2035-01-01T00:00:00Z' }])
  assertEquals(x.wsaaCalls, [{ certificatePem: 'CERT-PEM', signingKeyPem: KEY_SENTINEL, ambiente: 'homologacion', service: 'wsfe' }])
  const record = dataRpcs(x.calls).find((c) => c.name === 'arca_selfservice_record_verification')!
  assertEquals([record.args.p_expected_fingerprint, record.args.p_expected_certificate_sha256, record.args.p_token], [FP, SHA, TOKEN_SENTINEL])
  const activate = dataRpcs(x.calls).find((c) => c.name === 'arca_selfservice_activate')!
  assertEquals([activate.args.p_idempotency_key, activate.args.p_expected_certificate_sha256], ['wizard-verify-0001', SHA])
  assertNoMaterial(r.text, 'verify')
  for (const c of dataRpcs(x.calls)) {
    if (c.name !== 'arca_selfservice_record_verification') assertFalse(JSON.stringify(c.args).includes('SENTINEL'), `${c.name} recibió material`)
  }
})

Deno.test('verify: ALREADY_VERIFIED no vuelve a ARCA; SETUP_ALREADY_COMPLETED responde sin tocar nada', async () => {
  let x = makeDeps({ rpc: (name) => name === 'arca_selfservice_verification_material'
    ? { data: { ok: true, state: 'ALREADY_VERIFIED', fingerprint: FP, certificate_sha256: SHA }, error: null }
    : { data: { ok: true, state: 'ALREADY_ACTIVATED', connection: 'connected' }, error: null } })
  let r = await read(await handleSetupRequest(post(VERIFY), x.deps))
  assertEquals([r.status, r.body.state], [200, 'ALREADY_ACTIVATED'])
  assertEquals(x.wsaaCalls.length, 0)

  x = makeDeps({ rpc: () => ({ data: { ok: true, state: 'SETUP_ALREADY_COMPLETED' }, error: null }) })
  r = await read(await handleSetupRequest(post(VERIFY), x.deps))
  assertEquals([r.status, r.body.state], [200, 'SETUP_ALREADY_COMPLETED'])
  assertEquals(x.wsaaCalls.length, 0)
  assertEquals(dataRpcs(x.calls).map((c) => c.name), ['arca_selfservice_verification_material'])
})

const axisFault = (code: string, text: string) => `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault><faultcode xmlns:ns1="http://xml.apache.org/axis/">ns1:${code}</faultcode><faultstring>${text}</faultstring><detail><ns2:hostname xmlns:ns2="http://xml.apache.org/axis/">wsaahomo</ns2:hostname></detail></soapenv:Fault></soapenv:Body></soapenv:Envelope>`

Deno.test('verify: fallas WSAA → código acotado, auditoría acotada, sin registro ni activación, sin texto crudo', async () => {
  const cases: Array<[unknown, string, number]> = [
    [new WsaaLoginError('http', `WSAA HTTP 500: ${axisFault('coe.alreadyAuthenticated', 'El CEE ya posee un TA valido para el acceso al WSN solicitado')}`), 'WSAA_TICKET_ALREADY_ISSUED', 409],
    [new WsaaLoginError('http', `WSAA HTTP 500: ${axisFault('coe.notAuthorized', 'Computador no autorizado a acceder al servicio')}`), 'WSAA_SERVICE_NOT_AUTHORIZED', 409],
    [new WsaaLoginError('http', `WSAA HTTP 500: ${axisFault('cms.cert.untrusted', 'Certificado no emitido por AC de confianza')}`), 'WSAA_CERTIFICATE_REJECTED', 409],
    [new WsaaLoginError('http', `WSAA HTTP 500: ${axisFault('xml.bad', 'No se pudo interpretar el XML')}`), 'WSAA_REJECTED', 409],
    [new WsaaLoginError('http', `WSAA HTTP 500: ${axisFault('wsn.unavailable', 'El servicio no está disponible')}`), 'WSAA_UNAVAILABLE', 503],
    [new WsaaLoginError('http', 'WSAA HTTP 502: <html>Bad Gateway</html>'), 'WSAA_UNAVAILABLE', 503],
    [new WsaaLoginError('transport'), 'WSAA_UNAVAILABLE', 503],
    [new WsaaLoginError('timeout'), 'WSAA_UNAVAILABLE', 503],
    [new WsaaLoginError('signing'), 'SIGNING_FAILED', 409],
    [new Error('algo inesperado'), 'WSAA_UNAVAILABLE', 503],
  ]
  for (const [err, code, status] of cases) {
    const x = makeDeps({
      wsaa: async () => { throw err },
      rpc: (name) => name === 'arca_selfservice_verification_material' ? { data: MATERIAL, error: null } : { data: { ok: true, state: 'FAILURE_RECORDED' }, error: null },
    })
    const r = await read(await handleSetupRequest(post(VERIFY), x.deps))
    assertEquals([r.status, r.body.state], [status, code], code)
    const names = dataRpcs(x.calls).map((c) => c.name)
    assertEquals(names, ['arca_selfservice_verification_material', 'arca_selfservice_record_verification_failure'])
    assertEquals(dataRpcs(x.calls)[1].args.p_code, code)
    assertNoMaterial(r.text, code)
    assertFalse(r.text.includes('TA valido') || r.text.includes('Computador'), 'texto crudo de ARCA en la respuesta')
    if (code === 'WSAA_TICKET_ALREADY_ISSUED') assertEquals(r.body.retry_after_seconds, 43200)
  }
})

Deno.test('verify: el registro del ticket se reintenta ante errores de transporte; un rechazo de negocio no se reintenta', async () => {
  let x = makeDeps({ rpc: (name, _a, n) => {
    if (name === 'arca_selfservice_verification_material') return { data: MATERIAL, error: null }
    if (name === 'arca_selfservice_record_verification') return n < 3 ? { data: null, error: { message: 'timeout' } } : { data: { ok: true, state: 'VERIFIED' }, error: null }
    return { data: { ok: true, state: 'ACTIVATED', connection: 'connected' }, error: null }
  } })
  let r = await read(await handleSetupRequest(post(VERIFY), x.deps))
  assertEquals([r.status, r.body.state], [200, 'ACTIVATED'])
  assertEquals(dataRpcs(x.calls).filter((c) => c.name === 'arca_selfservice_record_verification').length, 3)

  x = makeDeps({ rpc: (name) => {
    if (name === 'arca_selfservice_verification_material') return { data: MATERIAL, error: null }
    if (name === 'arca_selfservice_record_verification') return { data: null, error: { message: 'down' } }
    return { data: { ok: true, state: 'FAILURE_RECORDED' }, error: null }
  } })
  r = await read(await handleSetupRequest(post(VERIFY), x.deps))
  assertEquals([r.status, r.body.state], [503, 'VERIFICATION_RECORD_FAILED'])
  assertFalse(dataRpcs(x.calls).some((c) => c.name === 'arca_selfservice_activate'))

  x = makeDeps({ rpc: (name) => {
    if (name === 'arca_selfservice_verification_material') return { data: MATERIAL, error: null }
    if (name === 'arca_selfservice_record_verification') return { data: { ok: false, state: 'CERTIFICATE_CHANGED' }, error: null }
    return { data: null, error: { message: 'unexpected' } }
  } })
  r = await read(await handleSetupRequest(post(VERIFY), x.deps))
  assertEquals([r.status, r.body.state], [409, 'CERTIFICATE_CHANGED'])
  assertEquals(dataRpcs(x.calls).filter((c) => c.name === 'arca_selfservice_record_verification').length, 1)
  assertFalse(dataRpcs(x.calls).some((c) => c.name === 'arca_selfservice_activate'))
})

Deno.test('verify: lease ocupado, material malformado y activación caída → acotados', async () => {
  let x = makeDeps({ rpc: () => ({ data: { ok: false, state: 'VERIFICATION_IN_PROGRESS' }, error: null }) })
  let r = await read(await handleSetupRequest(post(VERIFY), x.deps))
  assertEquals([r.status, r.body.state], [409, 'VERIFICATION_IN_PROGRESS'])
  assertEquals(x.wsaaCalls.length, 0)

  x = makeDeps({ rpc: () => ({ data: { ...MATERIAL, ambiente: 'staging' }, error: null }) })
  r = await read(await handleSetupRequest(post(VERIFY), x.deps))
  assertEquals(r.status, 503)
  assertEquals(x.wsaaCalls.length, 0)

  x = makeDeps({ rpc: (name) => name === 'arca_selfservice_verification_material'
    ? { data: { ok: true, state: 'ALREADY_VERIFIED', fingerprint: FP, certificate_sha256: SHA }, error: null }
    : { data: null, error: { message: 'down' } } })
  r = await read(await handleSetupRequest(post(VERIFY), x.deps))
  assertEquals([r.status, r.body.state], [503, 'ACTIVATION_PENDING'])
})

// ── crypto real ─────────────────────────────────────────────────────────────
Deno.test('crypto: clave 2048/e=65537 y CSR con EXACTAMENTE CN + serialNumber, firmado, fingerprint SPKI', async () => {
  const subject = { cn: 'qa-initial-setup', serialnumber: 'CUIT 20111111112' }
  const g = await generateSetupKeyAndCsr(subject)
  const csr = forge.pki.certificationRequestFromPem(g.csrPem)
  assert(csr.verify(), 'firma del CSR')
  assertEquals(csr.subject.attributes.map((a: any) => [a.name, a.value]), [['commonName', 'qa-initial-setup'], ['serialNumber', 'CUIT 20111111112']])
  const key = forge.pki.privateKeyFromPem(g.keyPem)
  assertEquals(key.n.bitLength(), 2048)
  assertEquals(key.e.toString(10), '65537')
  assertEquals(g.fingerprint, await spkiFingerprint(csr.publicKey))
  assertFalse(g.csrPem.includes('PRIVATE KEY'))
})

Deno.test('crypto: subject autorizado estricto', () => {
  assert(isAuthorizedSubject({ cn: 'qa-initial-setup', serialnumber: 'CUIT 20111111112' }))
  for (const bad of [null, {}, { cn: 'qa', serialnumber: 'CUIT 20111111112' }, { cn: 'qa_setup', serialnumber: 'CUIT 20111111112' },
    { cn: 'qa-initial-setup', serialnumber: '20111111112' }, { cn: 'qa-initial-setup', serialnumber: 'CUIT 20111111112', o: 'X' }]) {
    assertFalse(isAuthorizedSubject(bad), JSON.stringify(bad))
  }
})

Deno.test('crypto: normalización de certificado (PEM con espacios, DER, basura, dos bloques, clave, tamaño)', async () => {
  const sc = selfSigned()
  assertEquals(normalizeCertificateInput({ pem: `\r\n ${sc.pem} \n` }), { ok: true, pem: sc.pem })
  const der = forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(sc.cert)).getBytes())
  assertEquals(normalizeCertificateInput({ derBase64: der.replace(/(.{60})/g, '$1\n') }), { ok: true, pem: sc.pem })
  assertEquals(normalizeCertificateInput({ pem: 'basura' }).ok, false)
  assertEquals(normalizeCertificateInput({ pem: `${sc.pem}\n${sc.pem}` }), { ok: false, state: 'CERTIFICATE_INVALID' })
  assertEquals(normalizeCertificateInput({ pem: sc.keyPem }), { ok: false, state: 'KEY_MATERIAL_NOT_ACCEPTED' })
  assertEquals(normalizeCertificateInput({ derBase64: '%%%' }), { ok: false, state: 'CERTIFICATE_INVALID' })
  assertEquals(normalizeCertificateInput({ pem: 'A'.repeat(70 * 1024) }), { ok: false, state: 'CERTIFICATE_TOO_LARGE' })
})

Deno.test('WSAA real (fetch simulado): firma PKCS#7 del par, LoginCms de homologación, fault HTTP 500 y TA OK', async () => {
  const sc = selfSigned()
  const originalFetch = globalThis.fetch
  const seen: Array<{ url: string; body: string; signerCertPem: string; hasTra: boolean }> = []
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      const cms = body.match(/<ser:in0>([^<]+)<\/ser:in0>/)?.[1] ?? ''
      let signerCertPem = ''
      let hasTra = false
      try {
        const der = forge.util.decode64(cms)
        const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(der))
        signerCertPem = forge.pki.certificateToPem(p7.certificates[0]).trim()
        hasTra = der.includes('<service>wsfe</service>') && der.includes('loginTicketRequest')
      } catch { /* se asierta afuera */ }
      seen.push({ url: String(input), body, signerCertPem, hasTra })
      if (seen.length === 1) return new Response(axisFault('coe.alreadyAuthenticated', 'El CEE ya posee un TA valido'), { status: 500 })
      const ta = `&lt;loginTicketResponse&gt;&lt;header&gt;&lt;expirationTime&gt;2030-01-01T00:00:00-03:00&lt;/expirationTime&gt;&lt;/header&gt;&lt;credentials&gt;&lt;token&gt;TKN&lt;/token&gt;&lt;sign&gt;SGN&lt;/sign&gt;&lt;/credentials&gt;&lt;/loginTicketResponse&gt;`
      return new Response(`<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><loginCmsResponse><loginCmsReturn>${ta}</loginCmsReturn></loginCmsResponse></soapenv:Body></soapenv:Envelope>`, { status: 200 })
    }) as typeof fetch

    let caught: unknown = null
    try {
      await wsaaLoginWithPendingPair({ certificatePem: sc.pem, signingKeyPem: sc.keyPem, ambiente: 'homologacion', service: 'wsfe' })
    } catch (e) { caught = e }
    assertEquals(classifyWsaaFailure(caught), 'WSAA_TICKET_ALREADY_ISSUED')
    assertEquals((caught as WsaaLoginError).message, 'WSAA_LOGIN_HTTP')

    const ticket = await wsaaLoginWithPendingPair({ certificatePem: sc.pem, signingKeyPem: sc.keyPem, ambiente: 'homologacion', service: 'wsfe' })
    assertEquals([ticket.token, ticket.sign, ticket.expirationTime], ['TKN', 'SGN', '2030-01-01T00:00:00-03:00'])
    assert(seen.every((s) => s.url === 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms'), 'sólo LoginCms de homologación')
    assert(seen.every((s) => s.signerCertPem === sc.pem), 'el CMS lleva el certificado exacto del par')
    assert(seen.every((s) => s.hasTra), 'el CMS firma un TRA de wsfe')
    assertFalse(seen.some((s) => /wsfe\.afip|FECAESolicitar|FECompConsultar/i.test(s.url + s.body)), 'nunca WSFE')

    const other = selfSigned()
    let signingError: unknown = null
    try {
      await wsaaLoginWithPendingPair({ certificatePem: sc.pem, signingKeyPem: other.keyPem, ambiente: 'produccion', service: 'wsfe' })
    } catch (e) { signingError = e }
    assertEquals(classifyWsaaFailure(signingError), 'SIGNING_FAILED')
    assertEquals(seen.length, 2, 'una clave que no corresponde nunca llega a WSAA')
  } finally {
    globalThis.fetch = originalFetch
  }
})
