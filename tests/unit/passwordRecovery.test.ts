// ─────────────────────────────────────────────────────────────────────────────
// BETA-GATE-1 · Lote B — contrato puro de la recuperación de contraseña.
//
// Corre con `node --test`, sin DOM. Cada caso que toca el estado del módulo lo
// importa con una query distinta: Node lo evalúa como una instancia nueva, así
// que ningún caso hereda la fase, los tokens o la marca de otro.
//
// Las URLs de los fixtures reproducen la forma MEDIDA contra GoTrue v2.192
// local (ver el encabezado de src/lib/passwordRecovery.ts). Los tokens son
// strings sintéticos.
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

type Recovery = typeof import('../../src/lib/passwordRecovery.ts')

let instance = 0
async function fresh(): Promise<Recovery> {
  instance += 1
  return import(`../../src/lib/passwordRecovery.ts?instance=${instance}`) as Promise<Recovery>
}

// sessionStorage mínimo, reemplazable por caso.
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null }
  setItem(k: string, v: string) { this.map.set(k, String(v)) }
  removeItem(k: string) { this.map.delete(k) }
  dump() { return [...this.map.values()].join('\n') }
}
function useStorage(storage: unknown) {
  Object.defineProperty(globalThis, 'sessionStorage', { value: storage, configurable: true, writable: true })
}

const ACCESS = 'synthetic-access-token-aaaa'
const REFRESH = 'synthetic-refresh-token-bbbb'
const RECOVERY_HASH = `#access_token=${ACCESS}&expires_at=1789566637&expires_in=3600&refresh_token=${REFRESH}&sb=&token_type=bearer&type=recovery`
const USED_HASH = '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb='
const USER = '11111111-1111-4111-8111-111111111111'

function fakeHistory() {
  const calls: Array<{ state: unknown; url: unknown }> = []
  return {
    state: { from: 'boot' } as unknown,
    replaceState(state: unknown, _unused: string, url?: unknown) { calls.push({ state, url }) },
    calls,
  }
}

// ── parseRecoveryFragment ─────────────────────────────────────────────────────

test('parse: el fragmento real de recovery trae los dos tokens', async () => {
  const r = await fresh()
  const parsed = r.parseRecoveryFragment(RECOVERY_HASH, '/auth/callback')
  assert.equal(parsed.kind, 'tokens')
  assert.deepEqual(parsed.kind === 'tokens' && parsed.tokens, { access_token: ACCESS, refresh_token: REFRESH })
})

test('parse: type=recovery sin tokens es un enlace inválido, no se ignora', async () => {
  const r = await fresh()
  assert.equal(r.parseRecoveryFragment('#type=recovery&access_token=x', '/auth/callback').kind, 'invalid')
  assert.equal(r.parseRecoveryFragment('#type=recovery', '/').kind, 'invalid')
})

test('parse: el error real de un enlace usado/vencido en /auth/callback', async () => {
  const r = await fresh()
  assert.equal(r.parseRecoveryFragment(USED_HASH, '/auth/callback').kind, 'expired')
})

test('parse: NO intercepta OAuth implícito, errores de OAuth ni anclas', async () => {
  const r = await fresh()
  // Google por flow implícito: tokens sin type=recovery.
  assert.equal(r.parseRecoveryFragment(`#access_token=${ACCESS}&provider_token=p&refresh_token=${REFRESH}&token_type=bearer`, '/auth/callback').kind, 'none')
  assert.equal(r.parseRecoveryFragment(`#access_token=${ACCESS}&refresh_token=${REFRESH}&type=signup`, '/auth/callback').kind, 'none')
  // Un error de OAuth cualquiera sigue su camino de siempre.
  assert.equal(r.parseRecoveryFragment('#error=access_denied&error_description=cancelled', '/auth/callback').kind, 'none')
  // otp_expired fuera del callback no se reinterpreta.
  assert.equal(r.parseRecoveryFragment(USED_HASH, '/dashboard').kind, 'none')
  assert.equal(r.parseRecoveryFragment('#quick-expense', '/personal').kind, 'none')
  assert.equal(r.parseRecoveryFragment('', '/auth/callback').kind, 'none')
  assert.equal(r.parseRecoveryFragment('#', '/auth/callback').kind, 'none')
})

// ── captureRecoveryAtBoot ─────────────────────────────────────────────────────

test('boot: un enlace válido reescribe la MISMA entrada a /reset-password y queda verificando', async () => {
  const r = await fresh()
  const history = fakeHistory()
  const kind = r.captureRecoveryAtBoot({ pathname: '/auth/callback', hash: RECOVERY_HASH }, history, { isPortalHost: false })
  assert.equal(kind, 'tokens')
  assert.equal(history.calls.length, 1, 'una sola reescritura, sin pushState')
  assert.equal(history.calls[0].url, '/reset-password', 'la URL nueva no lleva fragmento ni query')
  assert.deepEqual(history.calls[0].state, { from: 'boot' }, 'conserva el state del historial')
  assert.equal(r.getRecoveryPhase(), 'verifying')
  assert.equal(r.hasPendingRecoveryTokens(), true)
})

test('boot: aunque GoTrue caiga al Site URL, el recovery igual termina en /reset-password', async () => {
  const r = await fresh()
  const history = fakeHistory()
  assert.equal(r.captureRecoveryAtBoot({ pathname: '/', hash: RECOVERY_HASH }, history, { isPortalHost: false }), 'tokens')
  assert.equal(history.calls[0].url, '/reset-password')
})

test('boot: enlace usado → expired_link, sin tokens en memoria', async () => {
  const r = await fresh()
  const history = fakeHistory()
  assert.equal(r.captureRecoveryAtBoot({ pathname: '/auth/callback', hash: USED_HASH }, history, { isPortalHost: false }), 'expired')
  assert.equal(history.calls[0].url, '/reset-password')
  assert.equal(r.getRecoveryPhase(), 'expired_link')
  assert.equal(r.hasPendingRecoveryTokens(), false)
})

test('boot: fragmento malformado → invalid_link', async () => {
  const r = await fresh()
  const history = fakeHistory()
  assert.equal(r.captureRecoveryAtBoot({ pathname: '/auth/callback', hash: '#type=recovery' }, history, { isPortalHost: false }), 'invalid')
  assert.equal(r.getRecoveryPhase(), 'invalid_link')
})

test('boot: en el dominio del portal no toca nada (comportamiento previo)', async () => {
  const r = await fresh()
  const history = fakeHistory()
  assert.equal(r.captureRecoveryAtBoot({ pathname: '/auth/callback', hash: RECOVERY_HASH }, history, { isPortalHost: true }), 'none')
  assert.equal(history.calls.length, 0)
  assert.equal(r.getRecoveryPhase(), 'idle')
  assert.equal(r.hasPendingRecoveryTokens(), false)
})

test('boot: una URL normal no reescribe el historial', async () => {
  const r = await fresh()
  const history = fakeHistory()
  assert.equal(r.captureRecoveryAtBoot({ pathname: '/dashboard', hash: '' }, history, { isPortalHost: false }), 'none')
  assert.equal(history.calls.length, 0)
  assert.equal(r.getRecoveryPhase(), 'idle')
})

// ── completeRecoveryHandoff ───────────────────────────────────────────────────

test('handoff OK: setSession con los tokens, marca al usuario, borra los tokens y queda ready', async () => {
  const r = await fresh()
  const storage = new MemoryStorage()
  useStorage(storage)
  r.captureRecoveryAtBoot({ pathname: '/auth/callback', hash: RECOVERY_HASH }, fakeHistory(), { isPortalHost: false })

  const seen: unknown[] = []
  const fases: string[] = []
  r.subscribeRecoveryPhase(() => fases.push(r.getRecoveryPhase()))
  await r.completeRecoveryHandoff({
    setSession: async (tokens) => { seen.push(tokens); return { data: { session: { user: { id: USER } } }, error: null } },
  }, () => 1_000)

  assert.deepEqual(seen, [{ access_token: ACCESS, refresh_token: REFRESH }])
  assert.equal(r.getRecoveryPhase(), 'ready')
  assert.deepEqual(fases, ['ready'])
  assert.equal(r.hasPendingRecoveryTokens(), false, 'la copia en memoria de los tokens del fragmento se borra tras el handoff')
  assert.equal(r.hasRecoverySession(USER, 1_000), true)
  // La sesión la persiste supabase-js (acá, el fake de setSession); el módulo nunca escribe los tokens.
  assert.ok(!storage.dump().includes(ACCESS) && !storage.dump().includes(REFRESH), 'el módulo nunca guarda tokens en sessionStorage')

  // Idempotente: una segunda llamada no vuelve a crear sesión.
  await r.completeRecoveryHandoff({ setSession: async () => { throw new Error('no debería llamarse') } })
  assert.equal(seen.length, 1)
})

test('handoff con error de GoTrue → invalid_link y sin marca', async () => {
  const r = await fresh()
  useStorage(new MemoryStorage())
  r.captureRecoveryAtBoot({ pathname: '/auth/callback', hash: RECOVERY_HASH }, fakeHistory(), { isPortalHost: false })
  await r.completeRecoveryHandoff({ setSession: async () => ({ data: { session: null }, error: { message: 'User not found', status: 403 } }) })
  assert.equal(r.getRecoveryPhase(), 'invalid_link')
  assert.equal(r.hasRecoverySession(USER), false)
  assert.equal(r.hasPendingRecoveryTokens(), false)
})

test('handoff que lanza (red) → invalid_link, nunca propaga', async () => {
  const r = await fresh()
  r.captureRecoveryAtBoot({ pathname: '/auth/callback', hash: RECOVERY_HASH }, fakeHistory(), { isPortalHost: false })
  await r.completeRecoveryHandoff({ setSession: async () => { throw new TypeError('Failed to fetch') } })
  assert.equal(r.getRecoveryPhase(), 'invalid_link')
})

test('handoff sin tokens capturados no llama a setSession', async () => {
  const r = await fresh()
  let called = false
  await r.completeRecoveryHandoff({ setSession: async () => { called = true; return { data: null, error: null } } })
  assert.equal(called, false)
  assert.equal(r.getRecoveryPhase(), 'idle')
})

// ── Marca de recovery ─────────────────────────────────────────────────────────

test('marca: sólo vale para el MISMO usuario y dentro del TTL', async () => {
  const r = await fresh()
  useStorage(new MemoryStorage())
  r.markRecoverySession(USER, 10_000)
  assert.equal(r.hasRecoverySession(USER, 10_000), true)
  assert.equal(r.hasRecoverySession('22222222-2222-4222-8222-222222222222', 10_000), false, 'otra cuenta no hereda la marca')
  assert.equal(r.hasRecoverySession(USER, 10_000 + r.RECOVERY_MARKER_TTL_MS), true)
  assert.equal(r.hasRecoverySession(USER, 10_000 + r.RECOVERY_MARKER_TTL_MS + 1), false, 'vence')
  assert.equal(r.hasRecoverySession(USER, 9_999), false, 'un reloj hacia atrás no la valida')
})

test('marca: sobrevive a un reload de la pestaña (sessionStorage) y se limpia al terminar', async () => {
  const storage = new MemoryStorage()
  useStorage(storage)
  const antes = await fresh()
  antes.markRecoverySession(USER, 5)
  const despues = await fresh() // otra instancia = la página recargada
  assert.equal(despues.hasRecoverySession(USER, 5), true)
  despues.finishRecovery()
  assert.equal((await fresh()).hasRecoverySession(USER, 5), false)
})

test('marca: si el storage tira, la copia en memoria alcanza para esta carga', async () => {
  const r = await fresh()
  useStorage({
    getItem() { throw new Error('SecurityError') },
    setItem() { throw new Error('QuotaExceededError') },
    removeItem() { throw new Error('SecurityError') },
  })
  r.markRecoverySession(USER, 1)
  assert.equal(r.hasRecoverySession(USER, 1), true)
  r.clearRecoverySession()
  assert.equal(r.hasRecoverySession(USER, 1), false)
  useStorage(new MemoryStorage())
})

test('marca: JSON corrupto en storage no rompe ni valida', async () => {
  const r = await fresh()
  const storage = new MemoryStorage()
  storage.setItem('techrepair.auth.password-recovery', '{no-json')
  useStorage(storage)
  assert.equal(r.hasRecoverySession(USER), false)
})

test('listener: PASSWORD_RECOVERY marca, SIGNED_OUT limpia, el resto no toca', async () => {
  const r = await fresh()
  useStorage(new MemoryStorage())
  let cb: ((event: string, session: { user: { id: string } } | null) => void) | null = null
  r.installRecoveryAuthListener({ onAuthStateChange: (fn) => { cb = fn; return {} } })
  assert.ok(cb)
  cb!('SIGNED_IN', { user: { id: USER } })
  assert.equal(r.hasRecoverySession(USER), false, 'un login normal no habilita el formulario')
  cb!('PASSWORD_RECOVERY', { user: { id: USER } })
  assert.equal(r.hasRecoverySession(USER), true)
  cb!('TOKEN_REFRESHED', { user: { id: USER } })
  assert.equal(r.hasRecoverySession(USER), true)
  cb!('SIGNED_OUT', null)
  assert.equal(r.hasRecoverySession(USER), false)
})

test('markRecoveryLinkRejected y finishRecovery mueven la fase', async () => {
  const r = await fresh()
  r.markRecoveryLinkRejected()
  assert.equal(r.getRecoveryPhase(), 'expired_link')
  r.finishRecovery()
  assert.equal(r.getRecoveryPhase(), 'idle')
})

// ── Validación y mensajes ─────────────────────────────────────────────────────

test('validación de la nueva contraseña', async () => {
  const r = await fresh()
  assert.deepEqual(r.validateNewPassword('segura-123', 'segura-123'), {})
  assert.match(r.validateNewPassword('corta', 'corta').password ?? '', /al menos 8/)
  assert.match(r.validateNewPassword('        ', '        ').password ?? '', /espacios/)
  // El límite es de 72 BYTES UTF-8: el mensaje no puede hablar de caracteres ni dar un número.
  assert.equal(r.validateNewPassword('a'.repeat(73), 'a'.repeat(73)).password, 'Usá una contraseña más corta.')
  // 72 bytes exactos es válido; 37 «ñ» son sólo 37 caracteres pero 74 bytes.
  assert.deepEqual(r.validateNewPassword('a'.repeat(72), 'a'.repeat(72)), {})
  const multibyte = r.validateNewPassword('ñ'.repeat(37), 'ñ'.repeat(37)).password ?? ''
  assert.equal(multibyte, 'Usá una contraseña más corta.')
  assert.doesNotMatch(multibyte, /caracter|72/)
  assert.match(r.validateNewPassword('segura-123', 'segura-124').confirm ?? '', /no coinciden/)
  assert.match(r.validateNewPassword('segura-123', '').confirm ?? '', /Repetí/)
})

test('errores de updateUser: nunca el texto crudo del servidor', async () => {
  const r = await fresh()
  const raw = 'New password should be different from the old password.'
  const same = r.classifyPasswordUpdateError({ code: 'same_password', status: 422, message: raw })
  assert.equal(same.kind, 'field')
  assert.ok(same.kind === 'field' && !same.message.includes(raw))
  assert.equal(r.classifyPasswordUpdateError({ code: 'weak_password', status: 422 }).kind, 'field')
  for (const e of [
    { name: 'AuthSessionMissingError', status: 400 },
    { code: 'session_not_found', status: 403 },
    { code: 'bad_jwt', status: 403 },
    { status: 401 },
  ]) {
    assert.equal(r.classifyPasswordUpdateError(e).kind, 'session', JSON.stringify(e))
  }
  assert.equal(r.classifyPasswordUpdateError({ code: 'over_request_rate_limit', status: 429 }).kind, 'retry')
  const unknown = r.classifyPasswordUpdateError({ status: 500, message: 'db exploded at 10.0.0.3' })
  assert.ok(unknown.kind === 'retry' && !unknown.message.includes('10.0.0.3'))
  assert.equal(r.classifyPasswordUpdateError(null).kind, 'retry')
})

test('pedido de enlace: sólo la red es error; 429/500/otros son neutros (la UI no revela si la cuenta existe)', async () => {
  const r = await fresh()
  assert.equal(r.classifyRecoveryRequestError(null), 'neutral')
  assert.equal(r.classifyRecoveryRequestError({ name: 'AuthRetryableFetchError', status: 0 }), 'network')
  assert.equal(r.classifyRecoveryRequestError({ name: 'AuthRetryableFetchError', status: 503 }), 'network')
  // MEDIDO: el mismo email existente dos veces seguidas → 429.
  assert.equal(r.classifyRecoveryRequestError({ name: 'AuthApiError', status: 429, code: 'over_email_send_rate_limit' }), 'neutral')
  assert.equal(r.classifyRecoveryRequestError({ name: 'AuthApiError', status: 500, code: 'unexpected_failure' }), 'neutral')
  assert.match(r.RECOVERY_REQUEST_SENT_MESSAGE, /^Si existe una cuenta/)
})

// ── El orden en el cliente ────────────────────────────────────────────────────

test('src/lib/supabase.ts captura ANTES de createClient y entrega DESPUÉS', () => {
  const src = readFileSync(new URL('../../src/lib/supabase.ts', import.meta.url), 'utf8')
  const capture = src.indexOf('captureRecoveryAtBoot(window.location')
  const create = src.indexOf('createClient(supabaseUrl')
  const listener = src.indexOf('installRecoveryAuthListener(supabase.auth)')
  const handoff = src.indexOf('completeRecoveryHandoff(supabase.auth)')
  assert.ok(capture > 0 && create > 0 && listener > 0 && handoff > 0, 'faltan llamadas del recovery en supabase.ts')
  assert.ok(capture < create, 'la captura tiene que correr antes de crear el cliente')
  assert.ok(create < listener && listener < handoff, 'listener y entrega van después de crear el cliente')
  assert.doesNotMatch(src, /flowType/, 'el recovery está medido con el flow implicit; cambiarlo exige revisar este lote')
})

test('el módulo de recovery no loguea ni importa el cliente', () => {
  const src = readFileSync(new URL('../../src/lib/passwordRecovery.ts', import.meta.url), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /console\.|logger\./)
  assert.doesNotMatch(code, /from ['"]\.\/supabase['"]/)
})
