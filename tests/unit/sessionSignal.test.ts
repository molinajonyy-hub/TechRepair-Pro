// ─────────────────────────────────────────────────────────────────────────────
// MOBILE-SESSION-1A — Clasificación de la sonda de sesión.
//
// EL CONTRATO QUE SE FIJA ACÁ: un fallo reintentable de conectividad NUNCA se
// puede clasificar como pérdida de sesión. Antes de este lote, `getSession()`
// devolviendo `session: null` se leía como «venció» sin mirar `error`, y con eso
// alcanzaba un rato sin señal para expulsar a un usuario válido.
//
// Los casos están escritos contra las ramas REALES de
// `GoTrueClient.__loadSession` en @supabase/auth-js 2.103.3, no contra una idea
// de cómo debería comportarse la librería.
//
// Deliberadamente NO se testea ningún mapeo de status HTTP: un 401 cualquiera y
// un rechazo terminal del refresh token no son la misma cosa, y codificar esa
// equivalencia es exactamente el error que este lote elimina.
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test'
import assert from 'node:assert/strict'

const { classifySessionProbe, probeSession } = await import(
  '../../src/lib/sessionSignal.ts'
)

/** Sesión mínima con la forma que mira el clasificador. */
const sesion = (accessToken = 'token-de-prueba') =>
  ({ access_token: accessToken, refresh_token: 'refresh-de-prueba', user: { id: 'u1' } }) as never

/** Error con la forma de un AuthError, sin depender de la clase real. */
const authError = (message: string, status?: number) =>
  ({ name: 'AuthApiError', message, status }) as never

const ok = (session: unknown) => ({ data: { session }, error: null }) as never
const conError = (error: unknown) => ({ data: { session: null }, error }) as never

// ── A · sesión utilizable ────────────────────────────────────────────────────

test('A1. hay sesión -> active', () => {
  const probe = classifySessionProbe(ok(sesion()))
  assert.equal(probe.kind, 'active')
})

test('A2. hay sesión Y error -> active (una sesión utilizable gana)', () => {
  const probe = classifySessionProbe({
    data: { session: sesion() },
    error: authError('warning raro'),
  } as never)
  assert.equal(probe.kind, 'active')
})

// ── B · lo inalcanzable NO es lo vencido ─────────────────────────────────────
//
// Estas son LAS pruebas del lote. Cada una fallaba antes del fix: la regla vieja
// era `!session -> session_expired`, sin mirar `error`.

test('B1. fallo de red al renovar -> unreachable, NUNCA absent', () => {
  const probe = classifySessionProbe(conError(authError('Failed to fetch')))
  assert.equal(probe.kind, 'unreachable')
  assert.notEqual(probe.kind, 'absent')
})

test('B2. timeout de request -> unreachable', () => {
  assert.equal(
    classifySessionProbe(conError(authError('signal timed out'))).kind,
    'unreachable',
  )
})

test('B3. fallo de DNS -> unreachable', () => {
  assert.equal(
    classifySessionProbe(conError(authError('getaddrinfo ENOTFOUND'))).kind,
    'unreachable',
  )
})

test('B4. Supabase caído (502) -> unreachable, no pérdida de sesión', () => {
  assert.equal(
    classifySessionProbe(conError(authError('Bad Gateway', 502))).kind,
    'unreachable',
  )
})

test('B5. un 401 NO se traduce a "sesión vencida"', () => {
  // Un rechazo terminal del refresh token lo resuelve auth-js por su cuenta:
  // `_removeSession()` + `SIGNED_OUT`. La sonda siguiente ya cae en `absent`.
  // Inferir "vencida" desde el status sería adivinar.
  assert.equal(
    classifySessionProbe(conError(authError('Unauthorized', 401))).kind,
    'unreachable',
  )
})

test('B6. getSession que TIRA excepción -> unreachable', async () => {
  const probe = await probeSession(async () => {
    throw new TypeError('Failed to fetch')
  })
  assert.equal(probe.kind, 'unreachable')
})

// ── C · el único caso terminal ───────────────────────────────────────────────

test('C1. sin sesión y sin error -> absent (auth-js miró el storage: no hay)', () => {
  assert.equal(classifySessionProbe(ok(null)).kind, 'absent')
})

test('C2. absent exige AUSENCIA de error; con error nunca es absent', () => {
  const conFallo = classifySessionProbe(conError(authError('Failed to fetch')))
  const sinFallo = classifySessionProbe(ok(null))
  assert.equal(sinFallo.kind, 'absent')
  assert.notEqual(conFallo.kind, sinFallo.kind)
})

// ── D · robustez de la sonda ─────────────────────────────────────────────────

test('D1. probeSession envuelve el camino feliz', async () => {
  const probe = await probeSession(async () => ok(sesion()) as never)
  assert.equal(probe.kind, 'active')
})

test('D2. una respuesta sin forma no explota y no inventa una sesión', () => {
  assert.equal(classifySessionProbe({} as never).kind, 'absent')
  assert.equal(classifySessionProbe({ data: {} } as never).kind, 'absent')
})

test('D3. la sesión clasificada es la misma que entró (no se reconstruye)', () => {
  const s = sesion('token-especifico')
  const probe = classifySessionProbe(ok(s))
  assert.equal(probe.kind, 'active')
  if (probe.kind === 'active') assert.equal(probe.session, s)
})

// ── E · estructura: el módulo no puede convertirse en autoridad de auth ──────

test('E1. sessionSignal no importa supabase, ni navega, ni toca storage', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(
    new URL('../../src/lib/sessionSignal.ts', import.meta.url),
    'utf8',
  )

  // Es un clasificador puro: recibe el resultado, no lo va a buscar. Si algún
  // día importa el cliente, deja de ser testeable sin red y puede empezar a
  // decidir cosas que no le corresponden.
  assert.ok(!/from '\.\.\/lib\/supabase'|from '\.\/supabase'/.test(src),
    'sessionSignal no debe importar el cliente de Supabase')
  for (const prohibido of ['signOut', 'navigate', 'localStorage', 'removeItem', 'refreshSession']) {
    assert.ok(!src.includes(`${prohibido}(`),
      `sessionSignal no debe llamar a ${prohibido}()`)
  }
})
