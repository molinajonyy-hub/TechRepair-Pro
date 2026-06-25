/**
 * Source-level contract guards for the two WhatsApp-sending edge functions.
 * They run in Deno (their `serve()`/esm.sh imports can't load under node:test),
 * so — like mpSubscriptionCors.test.ts — we assert on source text to lock in the
 * security wiring: scoped CORS (no '*'), shared tenant authorization, the actor
 * taken only from the JWT, and authorization running BEFORE any credential read
 * or Meta call. The behavioral guarantees themselves live in whatsappAuth.test.ts
 * and whatsappScopedCors.test.ts against the shared modules.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf-8')
const send    = read('../../supabase/functions/whatsapp-send/index.ts')
const sendMsg = read('../../supabase/functions/whatsapp-send-message/index.ts')
const FUNCS: Array<[string, string]> = [['whatsapp-send', send], ['whatsapp-send-message', sendMsg]]

// ── CORS: scoped, never wildcard, central helpers ────────────────────────────
for (const [name, src] of FUNCS) {
  test(`${name}: usa scopedCors compartido y nunca '*'`, () => {
    assert.match(src, /from '\.\.\/_shared\/scopedCors\.ts'/, 'debe importar scopedCors')
    assert.match(src, /createCors\(\s*computeAllowedOrigins\(/, 'debe construir CORS con la allowlist')
    // Never assign '*' to Allow-Origin (precise: targets assignment, not the
    // "(sin '*')" explanatory comment).
    assert.doesNotMatch(src, /Allow-Origin['"]?\s*[:=]\s*['"]\*['"]/i, "ACAO no debe ser '*'")
  })

  test(`${name}: OPTIONS usa preflight central y respuestas usan cors.json`, () => {
    assert.match(src, /req\.method === 'OPTIONS'[\s\S]{0,80}cors\.preflight\(req\)/)
    assert.match(src, /cors\.json\(req,/, 'las respuestas deben fluir por cors.json')
    // no leftover ad-hoc helpers / 'ok' preflight bodies
    assert.doesNotMatch(src, /new Response\('ok'/)
    assert.doesNotMatch(src, /const corsHeaders\s*=/)
  })
}

// ── Authorization: shared module, actor from JWT only, membership + role ──────
for (const [name, src] of FUNCS) {
  test(`${name}: autoriza con el módulo compartido (membresía + rol)`, () => {
    assert.match(src, /from '\.\.\/_shared\/whatsappAuth\.ts'/)
    assert.match(src, /authorizeWhatsAppSender\(/)
    assert.match(src, /if \(!authz\.ok\)/)
    assert.match(src, /authz\.status/, 'debe responder con el status de la autz (400/401/403)')
  })

  test(`${name}: el actor sale del JWT, nunca del body`, () => {
    assert.match(src, /req\.headers\.get\('Authorization'\)/)
    assert.match(src, /auth\.getUser\(\)/)
    // membership check is scoped by the authenticated user + requested business
    assert.match(src, /\.from\('profiles'\)/)
    assert.match(src, /\.eq\('is_active', true\)/)
    assert.match(src, /\.eq\('business_id'/)
    // never treat a body-supplied user_id as authority
    assert.doesNotMatch(src, /body\.user_id|payload\.user_id/)
  })
}

// ── Ordering: authorization precedes credential read + Meta ───────────────────
test('whatsapp-send: autz antes de cargar conexión y de llamar a Meta', () => {
  const authz = send.indexOf('authorizeWhatsAppSender(')
  const conn  = send.indexOf("from('whatsapp_connections')")
  const meta  = send.indexOf('graph.facebook.com')
  assert.ok(authz > -1 && conn > -1 && meta > -1)
  assert.ok(authz < conn, 'autz debe preceder la carga de conexión')
  assert.ok(authz < meta, 'autz debe preceder la llamada a Meta')
})

test('whatsapp-send-message: autz dentro de serve(), antes del dispatch de acciones', () => {
  // loadActiveConnection/Meta live in handlers DEFINED above serve(), so we anchor
  // on the serve() handler and assert authz runs before the action switch.
  const serveStart = sendMsg.indexOf('serve(async')
  assert.ok(serveStart > -1)
  const authz  = sendMsg.indexOf('authorizeWhatsAppSender', serveStart)
  const switchIdx = sendMsg.indexOf('switch (action)', serveStart)
  assert.ok(authz > serveStart, 'autz debe ejecutarse dentro de serve()')
  assert.ok(switchIdx > authz, 'el dispatch de acciones debe ocurrir DESPUÉS de la autz')
  // handlers receive req + an already-built service client (no self-auth inside them)
  assert.match(sendMsg, /function handleTest\(req: Request, supabase: ServiceClient,/)
  assert.match(sendMsg, /function handleTemplate\(req: Request, supabase: ServiceClient,/)
})

// ── Credentials are resolved server-side via Vault RPC, never from the body ──
for (const [name, src] of FUNCS) {
  test(`${name}: credenciales vía RPC de Vault server-side`, () => {
    assert.match(src, /whatsapp_credential_get_token/)
    assert.doesNotMatch(src, /access_token:\s*body|access_token:\s*payload/)
  })
}

// ── Fail-closed: require SUPABASE_ANON_KEY, never fall back to service_role ───
for (const [name, src] of FUNCS) {
  test(`${name}: exige SUPABASE_ANON_KEY (sin fallback a service_role)`, () => {
    assert.match(src, /Deno\.env\.get\('SUPABASE_ANON_KEY'\)/)
    // NO insecure fallback: neither `|| serviceRoleKey` nor `?? serviceRoleKey`
    assert.doesNotMatch(src, /SUPABASE_ANON_KEY'\)\s*(\|\||\?\?)/, 'no debe haber fallback de la anon key')
    assert.doesNotMatch(src, /anonKey\s*=\s*[^\n]*serviceRoleKey/, 'anonKey nunca debe derivar de la service role')
    // Fail closed with a safe technical code (no env values).
    assert.match(src, /if \(!anonKey\)/)
    assert.match(src, /SERVER_MISCONFIGURED/)
    assert.match(src, /\}, 500\)/)
  })

  test(`${name}: no registra ni filtra claves en logs/respuestas`, () => {
    assert.doesNotMatch(src, /console\.(log|error|warn)\([^)]*(anonKey|serviceRoleKey)/, 'no loguear claves')
    // anonKey is only ever consumed to build the user-scoped client.
    assert.match(src, /createClient\(supabaseUrl, anonKey,/)
  })
}

// Guard runs BEFORE authorization (and therefore before connection/Vault/Meta).
test('whatsapp-send: guard de anon key precede autz, conexión y Meta', () => {
  const guard = send.indexOf('if (!anonKey)')
  const authz = send.indexOf('authorizeWhatsAppSender(')
  const conn  = send.indexOf("from('whatsapp_connections')")
  const meta  = send.indexOf('graph.facebook.com')
  assert.ok(guard > -1)
  assert.ok(guard < authz, 'el guard debe preceder la autz')
  assert.ok(guard < conn && guard < meta, 'el guard debe preceder conexión y Meta')
})

test('whatsapp-send-message: guard de anon key precede autz dentro de serve()', () => {
  const serveStart = sendMsg.indexOf('serve(async')
  const guard = sendMsg.indexOf('if (!anonKey)', serveStart)
  const authz = sendMsg.indexOf('authorizeWhatsAppSender', serveStart)
  const switchIdx = sendMsg.indexOf('switch (action)', serveStart)
  assert.ok(guard > serveStart, 'el guard debe estar dentro de serve()')
  assert.ok(guard < authz, 'el guard debe preceder la autz')
  assert.ok(authz < switchIdx, 'la autz debe preceder el dispatch (conexión/Vault/Meta)')
})
