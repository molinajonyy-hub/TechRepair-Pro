/**
 * ARCA Self-Service Phase 2A — Edge arca-selfservice-setup (handler puro + crypto + WSAA).
 *
 * Sin red ni base: autoridad, RPC, generación de clave y WSAA se inyectan. Lo que se prueba acá
 * es el contrato del borde:
 *   · CORS canónico, método, autoridad canónica, allowlist estricta de campos, tenant por
 *     identidad, plan, defensa en profundidad SQL — antes de tocar cualquier RPC de datos;
 *   · prepare: el probe evita generar claves en un replay; la clave va sólo a la RPC;
 *   · certificate: PEM/DER normalizado, clave privada rechazada sin RPC;
 *   · verify: WSAA con el material exacto y un nonce de intento; NUNCA un vencimiento inventado;
 *     un resultado ambiguo (timeout, transporte, TA sin registro confirmado) deja la espera a la
 *     base y el verify inmediato NO vuelve a WSAA; faults Axis reales clasificados por allowlist
 *     exacta; ninguna respuesta con material, nonce ni texto crudo de ARCA;
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
  classifyWsaaFailure, parseWsaaInstant, validateWsaaTicket, WsaaLoginError, wsaaFaultCode, wsaaLoginWithPendingPair,
} from '../../supabase/functions/arca-selfservice-setup/wsaa.ts'

const BIZ = '00000000-0000-4000-8000-0000000a2a01'
const OTHER = '00000000-0000-4000-8000-0000000a2a02'
const USER = '00000000-0000-4000-8000-0000000a2a03'
const ATTEMPT = '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0a2a'
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
    newAttemptId: () => ATTEMPT,
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
const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString()
const HOLD_UNKNOWN = { state: 'WSAA_RESULT_UNKNOWN', hold: 'result_unknown', retry_after_seconds: 44990 }
const HOLD_TICKET = { state: 'WSAA_TICKET_ALREADY_ISSUED', hold: 'ticket_active', retry_after_seconds: 45000 }
const FAULT_SENTINEL = 'FAULT-TEXT-SENTINEL-P2A'
const axisFault = (code: string, text: string) => `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault><faultcode xmlns:ns1="http://xml.apache.org/axis/">ns1:${code}</faultcode><faultstring>${text}</faultstring><detail><ns2:hostname xmlns:ns2="http://xml.apache.org/axis/">wsaahomo</ns2:hostname></detail></soapenv:Fault></soapenv:Body></soapenv:Envelope>`

/**
 * Base simulada con la semántica de espera de la migración: el material deja una espera
 * pesimista; un reporte definitivo del MISMO intento la libera; uno ambiguo la extiende;
 * un registro la borra. Sirve para probar "el segundo verify inmediato NO llama a WSAA".
 */
function fakeDb(opts: { recordFails?: number; recordState?: string; activate?: () => { data: unknown; error: unknown }; materialError?: boolean; reportFails?: boolean } = {}) {
  const db = { hold: null as null | { reason: string }, attempt: null as string | null, verified: false, recordCalls: 0, reports: [] as Array<Record<string, unknown>> }
  const rpc = (name: string, args: Record<string, unknown>) => {
    if (name === 'arca_selfservice_verification_material') {
      if (opts.materialError) return { data: null, error: { message: 'lost' } }
      if (db.verified) return { data: { ok: true, state: 'ALREADY_VERIFIED', fingerprint: FP, certificate_sha256: SHA }, error: null }
      if (db.hold) return { data: { ok: false, state: db.hold.reason === 'ticket_active' ? HOLD_TICKET.state : HOLD_UNKNOWN.state, retry_after_seconds: 44990 }, error: null }
      db.hold = { reason: 'in_flight' }
      db.attempt = String(args.p_attempt_id)
      return { data: MATERIAL, error: null }
    }
    if (name === 'arca_selfservice_record_verification_failure') {
      db.reports.push(args)
      if (opts.reportFails) return { data: null, error: { message: 'down' } }
      if (db.verified) return { data: { ok: true, state: 'ALREADY_VERIFIED', code: args.p_code }, error: null }
      if (args.p_attempt_id !== db.attempt) return { data: { ok: false, state: 'ATTEMPT_NOT_FOUND' }, error: null }
      const code = String(args.p_code)
      if (['VERIFICATION_NOT_DISPATCHED'].includes(code)) db.hold = null
      else if (['WSAA_SERVICE_NOT_AUTHORIZED', 'WSAA_CERTIFICATE_REJECTED', 'WSAA_REJECTED', 'WSAA_UNAVAILABLE', 'SIGNING_FAILED'].includes(code)) db.hold = { reason: 'cooldown' }
      else if (code === 'WSAA_TICKET_ALREADY_ISSUED') db.hold = { reason: 'ticket_active' }
      else db.hold = { reason: 'result_unknown' }
      const hold = db.hold === null ? null : db.hold.reason === 'ticket_active' ? HOLD_TICKET : db.hold.reason === 'cooldown' ? { state: 'VERIFICATION_COOLDOWN', hold: 'cooldown', retry_after_seconds: 60 } : HOLD_UNKNOWN
      return { data: { ok: true, state: 'FAILURE_RECORDED', code, hold }, error: null }
    }
    if (name === 'arca_selfservice_record_verification') {
      db.recordCalls++
      if (opts.recordFails && db.recordCalls <= opts.recordFails) return { data: null, error: { message: 'transport' } }
      if (opts.recordState) return { data: { ok: false, state: opts.recordState }, error: null }
      db.verified = true
      db.hold = null
      return { data: { ok: true, state: 'VERIFIED' }, error: null }
    }
    if (name === 'arca_selfservice_activate') {
      return opts.activate ? opts.activate() : { data: { ok: true, state: 'ACTIVATED', connection: 'connected', expires_at: '2035-01-01T00:00:00Z' }, error: null }
    }
    return { data: null, error: { message: 'unexpected' } }
  }
  return {
    db, rpc,
    get reports(): Array<Record<string, unknown>> { return db.reports },
    get recordCalls(): number { return db.recordCalls },
  }
}

Deno.test('verify: material (con nonce) → WSAA con el par exacto → registro con el vencimiento EXACTO → activación', async () => {
  const exp = new Date(Date.now() + 11 * 3600_000 + 123).toISOString().replace('Z', '+00:00')
  const f = fakeDb()
  const x = makeDeps({ rpc: (name, args) => f.rpc(name, args), wsaa: async () => ({ token: TOKEN_SENTINEL, sign: SIGN_SENTINEL, expirationTime: exp }) })
  const r = await read(await handleSetupRequest(post(VERIFY), x.deps))
  assertEquals([r.status, r.body], [200, { ok: true, state: 'ACTIVATED', connection: 'connected', expires_at: '2035-01-01T00:00:00Z' }])
  assertEquals(x.wsaaCalls, [{ certificatePem: 'CERT-PEM', signingKeyPem: KEY_SENTINEL, ambiente: 'homologacion', service: 'wsfe' }])
  const material = dataRpcs(x.calls).find((c) => c.name === 'arca_selfservice_verification_material')!
  assertEquals(material.args.p_attempt_id, ATTEMPT)
  const record = dataRpcs(x.calls).find((c) => c.name === 'arca_selfservice_record_verification')!
  assertEquals([record.args.p_expected_fingerprint, record.args.p_expected_certificate_sha256, record.args.p_token, record.args.p_expires_at], [FP, SHA, TOKEN_SENTINEL, exp])
  const activate = dataRpcs(x.calls).find((c) => c.name === 'arca_selfservice_activate')!
  assertEquals([activate.args.p_idempotency_key, activate.args.p_expected_certificate_sha256], ['wizard-verify-0001', SHA])
  assertNoMaterial(r.text, 'verify')
  for (const c of dataRpcs(x.calls)) {
    if (c.name !== 'arca_selfservice_record_verification') assertFalse(JSON.stringify(c.args).includes('SENTINEL'), `${c.name} recibió material`)
  }
})

Deno.test('B1: vencimiento vacío, malformado, sin zona, pasado o fuera de cota → fail-closed: sin registro, sin activación, espera durable', async () => {
  const bad: Array<[string, string | undefined, boolean]> = [
    ['vacío', '', false],
    ['ausente', undefined, false],
    ['sin zona horaria (ambiguo)', '2030-01-01T10:00:00', false],
    ['formato libre', 'mañana 10hs', false],
    ['fecha imposible', '2030-02-30T10:00:00-03:00', false],
    ['espacio en vez de T', inHours(6).replace('T', ' '), false],
    ['ya vencido', inHours(-1), true],
    ['más allá de 12 h 10 min', inHours(13), true],
  ]
  for (const [label, expirationTime, parseable] of bad) {
    const f = fakeDb()
    const x = makeDeps({ rpc: (name, args) => f.rpc(name, args), wsaa: async () => ({ token: TOKEN_SENTINEL, sign: SIGN_SENTINEL, expirationTime: expirationTime as string }) })
    const r = await read(await handleSetupRequest(post(VERIFY), x.deps))
    assertEquals([r.status, r.body.state, r.body.retry_after_seconds], [409, 'WSAA_RESULT_UNKNOWN', 44990], label)
    const names = dataRpcs(x.calls).map((c) => c.name)
    assertFalse(names.includes('arca_selfservice_record_verification'), `${label}: no registra`)
    assertFalse(names.includes('arca_selfservice_activate'), `${label}: no activa`)
    assertEquals(f.reports.length === 0 ? null : f.reports[0].p_code, 'WSAA_RESPONSE_INVALID', label)
    assertEquals(f.reports[0].p_attempt_id, ATTEMPT)
    assertEquals(typeof f.reports[0].p_observed_expires === 'string', parseable, `${label}: vencimiento observado sólo si era un instante`)
    assertNoMaterial(r.text, label)
    // Segundo verify inmediato: la base mantiene la espera → sin WSAA.
    const again = await read(await handleSetupRequest(post(VERIFY), x.deps))
    assertEquals([again.status, again.body.state], [409, 'WSAA_RESULT_UNKNOWN'], `${label}: segundo intento`)
    assertEquals(x.wsaaCalls.length, 1, `${label}: un solo LoginCms`)
  }
})

Deno.test('B1: token o sign vacíos con vencimiento válido → WSAA_RESPONSE_INVALID, sin registro', async () => {
  for (const ticket of [{ token: '', sign: SIGN_SENTINEL }, { token: TOKEN_SENTINEL, sign: '  ' }]) {
    const f = fakeDb()
    const x = makeDeps({ rpc: (name, args) => f.rpc(name, args), wsaa: async () => ({ ...ticket, expirationTime: inHours(11) }) })
    const r = await read(await handleSetupRequest(post(VERIFY), x.deps))
    assertEquals([r.status, r.body.state], [409, 'WSAA_RESULT_UNKNOWN'])
    assertEquals(f.recordCalls, 0)
    assertEquals(f.reports[0].p_code, 'WSAA_RESPONSE_INVALID')
  }
})

Deno.test('B2: timeout y transporte después del envío son ambiguos: espera durable y el verify inmediato NO llama a WSAA', async () => {
  for (const err of [new WsaaLoginError('timeout'), new WsaaLoginError('transport'), new Error('algo inesperado'),
    new WsaaLoginError('http', 'WSAA HTTP 502: <html>Bad Gateway</html>'),
    new WsaaLoginError('http', `WSAA HTTP 500: ${axisFault('wsaa.internalError', FAULT_SENTINEL)}`),
    new WsaaLoginError('http', `WSAA HTTP 500: ${axisFault('coe.somethingNew', FAULT_SENTINEL)}`)]) {
    const f = fakeDb()
    const x = makeDeps({ rpc: (name, args) => f.rpc(name, args), wsaa: async () => { throw err } })
    const r = await read(await handleSetupRequest(post(VERIFY), x.deps))
    assertEquals([r.status, r.body], [409, { ok: false, state: 'WSAA_RESULT_UNKNOWN', retry_after_seconds: 44990 }], String(err))
    assertEquals(f.reports.map((p) => p.p_code), ['WSAA_RESULT_UNKNOWN'])
    assertFalse(dataRpcs(x.calls).some((c) => c.name === 'arca_selfservice_record_verification' || c.name === 'arca_selfservice_activate'))
    const again = await read(await handleSetupRequest(post({ ...VERIFY, idempotency_key: 'wizard-verify-0002' }), x.deps))
    assertEquals([again.status, again.body.state], [409, 'WSAA_RESULT_UNKNOWN'])
    assertEquals(x.wsaaCalls.length, 1, 'nunca un segundo LoginCms a ciegas')
    assertFalse(r.text.includes(FAULT_SENTINEL) || again.text.includes(FAULT_SENTINEL), 'texto crudo de ARCA')
  }
})

Deno.test('B2: TA recibido y los 3 registros fallan → ambiguo, sin activación, y el verify inmediato NO llama a WSAA', async () => {
  const f = fakeDb({ recordFails: 3 })
  const x = makeDeps({ rpc: (name, args) => f.rpc(name, args) })
  const r = await read(await handleSetupRequest(post(VERIFY), x.deps))
  assertEquals([r.status, r.body.state, r.body.retry_after_seconds], [409, 'WSAA_RESULT_UNKNOWN', 44990])
  assertEquals(f.recordCalls, 3)
  assertEquals(f.reports.map((p) => p.p_code), ['VERIFICATION_RECORD_FAILED'])
  assertFalse(dataRpcs(x.calls).some((c) => c.name === 'arca_selfservice_activate'))
  assertNoMaterial(r.text, 'record ambiguo')
  const again = await read(await handleSetupRequest(post(VERIFY), x.deps))
  assertEquals([again.status, again.body.state], [409, 'WSAA_RESULT_UNKNOWN'])
  assertEquals(x.wsaaCalls.length, 1)
})

Deno.test('B2: si el registro sí quedó (respuesta perdida) el reporte dice ALREADY_VERIFIED y se activa sin volver a ARCA', async () => {
  const f = fakeDb({ recordFails: 3 })
  const x = makeDeps({ rpc: (name, args) => {
    // El 1er registro commiteó pero su respuesta se perdió.
    if (name === 'arca_selfservice_record_verification') { f.db.verified = true; f.db.hold = null; f.db.recordCalls++; return { data: null, error: { message: 'lost' } } }
    return f.rpc(name, args)
  } })
  const r = await read(await handleSetupRequest(post(VERIFY), x.deps))
  assertEquals([r.status, r.body.state], [200, 'ACTIVATED'])
  assertEquals(f.reports.map((p) => p.p_code), ['VERIFICATION_RECORD_FAILED'])
  assertEquals(x.wsaaCalls.length, 1)
})

Deno.test('B2: registro rechazado por la base con un TA en mano → ambiguo (el TA quedó vigente en ARCA), sin activar', async () => {
  for (const state of ['WSAA_TICKET_INVALID', 'CERTIFICATE_CHANGED', 'NO_SETUP_IN_PROGRESS']) {
    const f = fakeDb({ recordState: state })
    const x = makeDeps({ rpc: (name, args) => f.rpc(name, args) })
    const r = await read(await handleSetupRequest(post(VERIFY), x.deps))
    assertEquals([r.status, r.body.state], [409, 'WSAA_RESULT_UNKNOWN'], state)
    assertEquals(f.recordCalls, 1, `${state}: un rechazo de negocio no se reintenta`)
    assertEquals(f.reports.map((p) => p.p_code), ['VERIFICATION_RECORD_FAILED'])
    assertFalse(dataRpcs(x.calls).some((c) => c.name === 'arca_selfservice_activate'))
  }
})

Deno.test('coe.alreadyAuthenticated → espera acotada informada por la base, un solo LoginCms, sin reintento automático', async () => {
  const f = fakeDb()
  const x = makeDeps({ rpc: (name, args) => f.rpc(name, args), wsaa: async () => { throw new WsaaLoginError('http', `WSAA HTTP 500: ${axisFault('coe.alreadyAuthenticated', 'El CEE ya posee un TA valido para el acceso al WSN solicitado')}`) } })
  const r = await read(await handleSetupRequest(post(VERIFY), x.deps))
  assertEquals([r.status, r.body], [409, { ok: false, state: 'WSAA_TICKET_ALREADY_ISSUED', retry_after_seconds: 45000 }])
  assertEquals(x.wsaaCalls.length, 1)
  assertEquals(f.reports.map((p) => p.p_code), ['WSAA_TICKET_ALREADY_ISSUED'])
  const again = await read(await handleSetupRequest(post(VERIFY), x.deps))
  assertEquals([again.status, again.body.state], [409, 'WSAA_TICKET_ALREADY_ISSUED'])
  assertEquals(x.wsaaCalls.length, 1)
  assertFalse(r.text.includes('TA valido'))
})

Deno.test('fallas definitivas (faults de validación exactos, firma) → código acotado y espera corta de la base; sin texto crudo', async () => {
  const cases: Array<[unknown, string, number]> = [
    [new WsaaLoginError('http', `WSAA HTTP 500: ${axisFault('coe.notAuthorized', FAULT_SENTINEL)}`), 'WSAA_SERVICE_NOT_AUTHORIZED', 409],
    [new WsaaLoginError('http', `WSAA HTTP 500: ${axisFault('cms.cert.untrusted', FAULT_SENTINEL)}`), 'WSAA_CERTIFICATE_REJECTED', 409],
    [new WsaaLoginError('http', `WSAA HTTP 500: ${axisFault('xml.generationTime.invalid', FAULT_SENTINEL)}`), 'WSAA_REJECTED', 409],
    [new WsaaLoginError('http', `WSAA HTTP 500: ${axisFault('wsn.unavailable', FAULT_SENTINEL)}`), 'WSAA_UNAVAILABLE', 503],
    [new WsaaLoginError('signing'), 'SIGNING_FAILED', 409],
  ]
  for (const [err, code, status] of cases) {
    const f = fakeDb()
    const x = makeDeps({ rpc: (name, args) => f.rpc(name, args), wsaa: async () => { throw err } })
    const r = await read(await handleSetupRequest(post(VERIFY), x.deps))
    assertEquals([r.status, r.body], [status, { ok: false, state: code }], code)
    assertEquals(f.reports.map((p) => [p.p_code, p.p_attempt_id]), [[code, ATTEMPT]])
    assertNoMaterial(r.text, code)
    assertFalse(r.text.includes(FAULT_SENTINEL), 'texto crudo de ARCA en la respuesta')
    assertEquals(f.db.hold?.reason, 'cooldown')
  }
})

Deno.test('material perdido o malformado: sin clave en memoria → VERIFICATION_NOT_DISPATCHED con el nonce; si el reporte no llega, espera', async () => {
  let f = fakeDb({ materialError: true })
  let x = makeDeps({ rpc: (name, args) => f.rpc(name, args) })
  let r = await read(await handleSetupRequest(post(VERIFY), x.deps))
  assertEquals([r.status, r.body.error], [503, 'SETUP_UNAVAILABLE'])
  assertEquals(f.reports.map((p) => [p.p_code, p.p_attempt_id]), [['VERIFICATION_NOT_DISPATCHED', ATTEMPT]])
  assertEquals(x.wsaaCalls.length, 0)

  // Un cliente que LANZA en vez de devolver error recibe el mismo trato (nunca un 500 sin reporte).
  f = fakeDb()
  x = makeDeps({ rpc: (name, args) => { if (name === 'arca_selfservice_verification_material') throw new Error('socket hang up'); return f.rpc(name, args) } })
  x.deps.rpc = async (name, args) => {
    x.calls.push({ name, args })
    if (name === 'is_business_owner_or_admin') return { data: true, error: null }
    if (name === 'arca_selfservice_verification_material') throw new Error('socket hang up')
    return f.rpc(name, args)
  }
  r = await read(await handleSetupRequest(post(VERIFY), x.deps))
  assertEquals([r.status, r.body.error], [503, 'SETUP_UNAVAILABLE'])
  assertEquals(f.reports.map((p) => p.p_code), ['VERIFICATION_NOT_DISPATCHED'])
  assertEquals(x.wsaaCalls.length, 0)

  f = fakeDb({ materialError: true, reportFails: true })
  x = makeDeps({ rpc: (name, args) => f.rpc(name, args) })
  r = await read(await handleSetupRequest(post(VERIFY), x.deps))
  assertEquals([r.status, r.body], [409, { ok: false, state: 'WSAA_RESULT_UNKNOWN', retry_after_seconds: 45000 }])
  assertEquals(f.reports.length, 3, 'el reporte se reintenta ante transporte')

  for (const broken of [{ ...MATERIAL, ambiente: 'staging' }, { ...MATERIAL, signing_key_pem: null }, { ...MATERIAL, fingerprint: 'x' }]) {
    const g = fakeDb()
    const y = makeDeps({ rpc: (name, args) => name === 'arca_selfservice_verification_material' ? { data: broken, error: null } : g.rpc(name, args) })
    r = await read(await handleSetupRequest(post(VERIFY), y.deps))
    assertEquals(r.status, 503)
    assertEquals(y.wsaaCalls.length, 0)
    assertEquals(g.reports.map((p) => p.p_code), ['VERIFICATION_NOT_DISPATCHED'])
  }
})

Deno.test('esperas de la base: el material rechazado no llama a WSAA y la respuesta lleva sólo estado + retry acotado', async () => {
  for (const [state, retry, want] of [
    ['VERIFICATION_IN_PROGRESS', 30, 30], ['WSAA_RESULT_UNKNOWN', 44000, 44000], ['WSAA_TICKET_ALREADY_ISSUED', 45000, 45000],
    ['VERIFICATION_EXPIRED', 600, 600], ['VERIFICATION_COOLDOWN', 60, 60], ['WSAA_RESULT_UNKNOWN', -1, 45000], ['WSAA_RESULT_UNKNOWN', 'x', 45000],
  ] as const) {
    const x = makeDeps({ rpc: () => ({ data: { ok: false, state, retry_after_seconds: retry, hold: 'in_flight', attempt_id: ATTEMPT }, error: null }) })
    const r = await read(await handleSetupRequest(post(VERIFY), x.deps))
    assertEquals([r.status, r.body], [409, { ok: false, state, retry_after_seconds: want }], `${state} ${retry}`)
    assertEquals(x.wsaaCalls.length, 0)
  }
})

Deno.test('activación: VERIFICATION_EXPIRED con espera acotada; ALREADY_VERIFIED no vuelve a ARCA; activación caída → ACTIVATION_PENDING', async () => {
  let x = makeDeps({ rpc: (name) => name === 'arca_selfservice_verification_material'
    ? { data: { ok: true, state: 'ALREADY_VERIFIED', fingerprint: FP, certificate_sha256: SHA }, error: null }
    : { data: { ok: false, state: 'VERIFICATION_EXPIRED', retry_after_seconds: 600 }, error: null } })
  let r = await read(await handleSetupRequest(post(VERIFY), x.deps))
  assertEquals([r.status, r.body], [409, { ok: false, state: 'VERIFICATION_EXPIRED', retry_after_seconds: 600 }])
  assertEquals(x.wsaaCalls.length, 0)

  x = makeDeps({ rpc: (name) => name === 'arca_selfservice_verification_material'
    ? { data: { ok: true, state: 'ALREADY_VERIFIED', fingerprint: FP, certificate_sha256: SHA }, error: null }
    : { data: { ok: true, state: 'ALREADY_ACTIVATED', connection: 'connected' }, error: null } })
  r = await read(await handleSetupRequest(post(VERIFY), x.deps))
  assertEquals([r.status, r.body.state], [200, 'ALREADY_ACTIVATED'])
  assertEquals(x.wsaaCalls.length, 0)

  x = makeDeps({ rpc: () => ({ data: { ok: true, state: 'SETUP_ALREADY_COMPLETED' }, error: null }) })
  r = await read(await handleSetupRequest(post(VERIFY), x.deps))
  assertEquals([r.status, r.body.state], [200, 'SETUP_ALREADY_COMPLETED'])
  assertEquals(dataRpcs(x.calls).map((c) => c.name), ['arca_selfservice_verification_material'])

  x = makeDeps({ rpc: (name) => name === 'arca_selfservice_verification_material'
    ? { data: { ok: true, state: 'ALREADY_VERIFIED', fingerprint: FP, certificate_sha256: SHA }, error: null }
    : { data: null, error: { message: 'down' } } })
  r = await read(await handleSetupRequest(post(VERIFY), x.deps))
  assertEquals([r.status, r.body.state], [503, 'ACTIVATION_PENDING'])
})

Deno.test('cancel: informa remote_ticket_possible acotado, nunca dice que se revocó nada; en vuelo → espera', async () => {
  for (const flag of [true, false, 'yes']) {
    const x = makeDeps({ rpc: () => ({ data: { ok: true, state: 'SETUP_CANCELLED', remote_ticket_possible: flag, secret_id: 'x' }, error: null }) })
    const r = await read(await handleSetupRequest(post({ action: 'cancel' }), x.deps))
    assertEquals([r.status, r.body], [200, { ok: true, state: 'SETUP_CANCELLED', remote_ticket_possible: flag === true }])
    assertFalse(/revoc/i.test(r.text))
  }
  const x = makeDeps({ rpc: () => ({ data: { ok: false, state: 'VERIFICATION_IN_PROGRESS', retry_after_seconds: 300 }, error: null }) })
  const r = await read(await handleSetupRequest(post({ action: 'cancel' }), x.deps))
  assertEquals([r.status, r.body], [409, { ok: false, state: 'VERIFICATION_IN_PROGRESS', retry_after_seconds: 300 }])
})

Deno.test('nonce del intento: nunca en respuestas; un nonce inválido no llega a la base', async () => {
  const f = fakeDb()
  const x = makeDeps({ rpc: (name, args) => f.rpc(name, args), wsaa: async () => { throw new WsaaLoginError('timeout') } })
  const r = await read(await handleSetupRequest(post(VERIFY), x.deps))
  assertFalse(r.text.includes(ATTEMPT))
  const y = makeDeps()
  y.deps.newAttemptId = () => 'not-a-uuid'
  const s = await read(await handleSetupRequest(post(VERIFY), y.deps))
  assertEquals(s.status, 503)
  assertEquals(dataRpcs(y.calls).length, 0)
})

// ── WSAA: vencimiento y clasificación (unidad) ──────────────────────────────
Deno.test('parseWsaaInstant: formato real de WSAA (milisegundos + -03:00), Z, fracciones largas; rechaza lo ambiguo', () => {
  assertEquals(parseWsaaInstant('2026-09-14T22:10:54.622-03:00'), Date.UTC(2026, 8, 15, 1, 10, 54, 622))
  assertEquals(parseWsaaInstant('2026-09-15T01:10:54Z'), Date.UTC(2026, 8, 15, 1, 10, 54))
  assertEquals(parseWsaaInstant('2026-09-15T01:10:54.123456789+00:00'), Date.UTC(2026, 8, 15, 1, 10, 54, 123))
  for (const bad of ['', '2026-09-15T01:10:54', '2026-09-15 01:10:54-03:00', '2026-13-01T00:00:00Z', '2026-02-29T00:00:00Z',
    '2026-09-15T24:00:00Z', '2026-09-15T01:10:54-15:00', '15/09/2026', null, 1789355560760]) {
    assertEquals(parseWsaaInstant(bad), null, String(bad))
  }
})

Deno.test('validateWsaaTicket: nunca completa; cotas (ahora, ahora + 12 h 10 min]; vencimiento observado en el error', () => {
  const now = Date.UTC(2026, 8, 14, 12, 0, 0)
  const ok = validateWsaaTicket({ token: ' T ', sign: 'S', expirationTime: '2026-09-14T21:00:00.000-03:00' }, now)
  assertEquals(ok, { token: 'T', sign: 'S', expirationTime: '2026-09-14T21:00:00.000-03:00' })
  const edge = new Date(now + 12 * 3600_000 + 10 * 60_000).toISOString()
  assertEquals(validateWsaaTicket({ token: 'T', sign: 'S', expirationTime: edge }, now).expirationTime, edge)
  for (const [raw, observed] of [
    [{ token: 'T', sign: 'S', expirationTime: '' }, null],
    [{ token: 'T', sign: 'S' }, null],
    [{ token: 'T', sign: 'S', expirationTime: new Date(now).toISOString() }, now],
    [{ token: 'T', sign: 'S', expirationTime: new Date(now + 12 * 3600_000 + 10 * 60_000 + 1).toISOString() }, now + 12 * 3600_000 + 10 * 60_000 + 1],
    [{ token: '', sign: 'S', expirationTime: new Date(now + 3600_000).toISOString() }, now + 3600_000],
  ] as const) {
    let caught: unknown = null
    try { validateWsaaTicket(raw as never, now) } catch (e) { caught = e }
    assert(caught instanceof WsaaLoginError, JSON.stringify(raw))
    const f = classifyWsaaFailure(caught)
    assertEquals([f.code, f.disposition, f.observedExpiresAt], ['WSAA_RESPONSE_INVALID', 'ambiguous', observed === null ? null : new Date(observed).toISOString()])
  }
})

Deno.test('faultcode: sobres Axis reales (xmlns + prefijo), allowlist exacta, truncado/duplicado/desconocido → ambiguo; el error no guarda texto', () => {
  const fault = (code: string) => new WsaaLoginError('http', `WSAA HTTP 500: ${axisFault(code, FAULT_SENTINEL)}`)
  const expect = (err: unknown, code: string, disposition: string) => {
    const f = classifyWsaaFailure(err)
    assertEquals([f.code, f.disposition], [code, disposition], String((err as WsaaLoginError).fault))
  }
  expect(fault('coe.alreadyAuthenticated'), 'WSAA_TICKET_ALREADY_ISSUED', 'ticket_active')
  expect(fault('coe.notAuthorized'), 'WSAA_SERVICE_NOT_AUTHORIZED', 'definitive')
  for (const c of ['cms.bad', 'cms.bad.base64', 'cms.cert.notFound', 'cms.cert.expired', 'cms.cert.untrusted', 'cms.cert.invalid', 'cms.sign.invalid']) expect(fault(c), 'WSAA_CERTIFICATE_REJECTED', 'definitive')
  for (const c of ['xml.bad', 'xml.source.invalid', 'xml.destination.invalid', 'xml.version.notSupported', 'xml.generationTime.invalid', 'xml.expirationTime.expired', 'xml.expirationTime.invalid', 'wsn.notFound']) expect(fault(c), 'WSAA_REJECTED', 'definitive')
  expect(fault('xml.CEE.notAuthorized'), 'WSAA_SERVICE_NOT_AUTHORIZED', 'definitive')
  expect(fault('wsn.unavailable'), 'WSAA_UNAVAILABLE', 'definitive')
  for (const c of ['wsaa.internalError', 'wsaa.unavailable', 'coe.other', 'cms.somethingElse', 'cert.expired', 'Server.userException', 'coe.notAuthorizedX']) expect(fault(c), 'WSAA_RESULT_UNKNOWN', 'ambiguous')
  const full = `WSAA HTTP 500: ${axisFault('coe.alreadyAuthenticated', 'x')}`
  expect(new WsaaLoginError('http', full.slice(0, full.indexOf('alreadyAuth') + 5)), 'WSAA_RESULT_UNKNOWN', 'ambiguous')
  expect(new WsaaLoginError('http', `WSAA HTTP 500: ${axisFault('coe.notAuthorized', 'x')}${axisFault('coe.alreadyAuthenticated', 'x')}`), 'WSAA_RESULT_UNKNOWN', 'ambiguous')
  expect(new WsaaLoginError('http', 'WSAA HTTP 503: <html>maintenance coe.notAuthorized</html>'), 'WSAA_RESULT_UNKNOWN', 'ambiguous')
  expect(new WsaaLoginError('parse', axisFault('coe.notAuthorized', 'x')), 'WSAA_SERVICE_NOT_AUTHORIZED', 'definitive')
  expect(new WsaaLoginError('parse', '<html>200 OK pero sin TA</html>'), 'WSAA_RESPONSE_INVALID', 'ambiguous')
  expect(new WsaaLoginError('parse', '<faultcode>'), 'WSAA_RESPONSE_INVALID', 'ambiguous')
  const err = fault('coe.notAuthorized')
  assertEquals(wsaaFaultCode(`WSAA HTTP 500: ${axisFault('coe.notAuthorized', 'x')}`), 'coe.notAuthorized')
  assertFalse(JSON.stringify(err).includes(FAULT_SENTINEL))
  assertFalse(Deno.inspect(err).includes(FAULT_SENTINEL), 'el error no guarda el texto crudo de ARCA')
  assertFalse(Object.keys(err).includes('fault'))
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

Deno.test('WSAA real (fetch simulado): firma PKCS#7 del par, LoginCms de homologación, fault HTTP 500, TA real validado y TA sin vencimiento rechazado', async () => {
  const sc = selfSigned()
  const originalFetch = globalThis.fetch
  const seen: Array<{ url: string; body: string; signerCertPem: string; hasTra: boolean }> = []
  const beyond = new Date(Date.now() + 13 * 3600_000).toISOString()
  const realShape = (() => {
    const t = new Date(Date.now() + 12 * 3600_000 - 3 * 3600_000)
    const p = (n: number, w = 2) => String(n).padStart(w, '0')
    return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}.${p(t.getUTCMilliseconds(), 3)}-03:00`
  })()
  const replies = [
    () => new Response(axisFault('coe.alreadyAuthenticated', 'El CEE ya posee un TA valido'), { status: 500 }),
    () => new Response(taEnvelope(realShape), { status: 200 }),
    () => new Response(taEnvelope(''), { status: 200 }),
    () => new Response(taEnvelope(beyond), { status: 200 }),
  ]
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
      return replies[seen.length - 1]()
    }) as typeof fetch

    const attempt = async (ambiente: 'homologacion' | 'produccion' = 'homologacion', key = sc.keyPem) => {
      try {
        return { ticket: await wsaaLoginWithPendingPair({ certificatePem: sc.pem, signingKeyPem: key, ambiente, service: 'wsfe' }), error: null }
      } catch (e) { return { ticket: null, error: e } }
    }

    let r = await attempt()
    assertEquals(classifyWsaaFailure(r.error).code, 'WSAA_TICKET_ALREADY_ISSUED')
    assertEquals((r.error as WsaaLoginError).message, 'WSAA_LOGIN_HTTP')

    r = await attempt()
    assertEquals([r.ticket?.token, r.ticket?.sign, r.ticket?.expirationTime], ['TKN', 'SGN', realShape], 'TA con la forma real de WSAA (ms + -03:00)')

    r = await attempt()
    assertEquals(r.ticket, null)
    assertEquals([classifyWsaaFailure(r.error).code, classifyWsaaFailure(r.error).disposition], ['WSAA_RESPONSE_INVALID', 'ambiguous'], 'TA sin expirationTime: nunca se completa')

    r = await attempt()
    assertEquals(r.ticket, null)
    assertEquals([classifyWsaaFailure(r.error).code, classifyWsaaFailure(r.error).observedExpiresAt], ['WSAA_RESPONSE_INVALID', beyond], 'TA fuera de cota: el vencimiento observado viaja a la base')

    assert(seen.every((s) => s.url === 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms'), 'sólo LoginCms de homologación')
    assert(seen.every((s) => s.signerCertPem === sc.pem), 'el CMS lleva el certificado exacto del par')
    assert(seen.every((s) => s.hasTra), 'el CMS firma un TRA de wsfe')
    assertFalse(seen.some((s) => /wsfe\.afip|FECAESolicitar|FECompConsultar/i.test(s.url + s.body)), 'nunca WSFE')

    const other = selfSigned()
    const before = seen.length
    r = await attempt('produccion', other.keyPem)
    assertEquals(classifyWsaaFailure(r.error).code, 'SIGNING_FAILED')
    assertEquals(seen.length, before, 'una clave que no corresponde nunca llega a WSAA')
  } finally {
    globalThis.fetch = originalFetch
  }
})

function taEnvelope(expirationTime: string): string {
  const header = expirationTime === '' ? '' : `&lt;expirationTime&gt;${expirationTime}&lt;/expirationTime&gt;`
  const ta = `&lt;loginTicketResponse version="1.0"&gt;&lt;header&gt;&lt;source&gt;CN=wsaahomo&lt;/source&gt;&lt;generationTime&gt;2026-09-14T10:10:54.622-03:00&lt;/generationTime&gt;${header}&lt;/header&gt;&lt;credentials&gt;&lt;token&gt;TKN&lt;/token&gt;&lt;sign&gt;SGN&lt;/sign&gt;&lt;/credentials&gt;&lt;/loginTicketResponse&gt;`
  return `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><loginCmsResponse><loginCmsReturn>${ta}</loginCmsReturn></loginCmsResponse></soapenv:Body></soapenv:Envelope>`
}
