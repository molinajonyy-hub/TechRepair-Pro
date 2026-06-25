/**
 * Behavioral tests for the shared scoped-CORS helper
 * (`supabase/functions/_shared/scopedCors.ts`).
 *
 * Pure module (web globals only) → driven directly with node's global Request/
 * Response. Proves: apex & www allowed, malicious origin gets no ACAO, never '*',
 * header intersection (incl. cache-control/pragma), single-value ACAO, Vary,
 * methods/max-age, CORS on error responses, and OPTIONS does no business logic.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createCors,
  computeAllowedOrigins,
  parseOriginList,
} from '../../supabase/functions/_shared/scopedCors.ts'

const WWW = 'https://www.techrepairpro.app'
const APEX = 'https://techrepairpro.app'
const EVIL = 'https://evil.example.com'

// Includes an explicitly-configured extra origin via env, to prove env support.
const ALLOWED = computeAllowedOrigins(['https://staging.techrepairpro.app', undefined])
const cors = createCors(ALLOWED)

function preflight(origin: string, requestHeaders?: string): Request {
  const headers: Record<string, string> = {
    Origin: origin,
    'Access-Control-Request-Method': 'POST',
  }
  if (requestHeaders) headers['Access-Control-Request-Headers'] = requestHeaders
  return new Request('https://fn.supabase.co/whatsapp-send', { method: 'OPTIONS', headers })
}

// 1 & 2) apex and www are allowed → ACAO echoes the exact origin.
test('apex permitido → ACAO apex', () => {
  const res = cors.preflight(preflight(APEX))
  assert.equal(res.headers.get('access-control-allow-origin'), APEX)
})
test('www permitido → ACAO www', () => {
  const res = cors.preflight(preflight(WWW))
  assert.equal(res.headers.get('access-control-allow-origin'), WWW)
})

// 3) malicious origin → no ACAO header at all.
test('origen malicioso → sin ACAO', () => {
  const res = cors.preflight(preflight(EVIL))
  assert.equal(res.headers.get('access-control-allow-origin'), null)
})

// 4) never '*' (allowed nor disallowed).
test('nunca comodín', () => {
  assert.notEqual(cors.preflight(preflight(WWW)).headers.get('access-control-allow-origin'), '*')
  assert.notEqual(cors.preflight(preflight(EVIL)).headers.get('access-control-allow-origin'), '*')
})

// 5) hard reload: cache-control + pragma requested → reflected in allow-headers.
test('hard reload con cache-control y pragma → reflejados', () => {
  const res = cors.preflight(preflight(WWW, 'authorization, content-type, cache-control, pragma'))
  const allow = res.headers.get('access-control-allow-headers') ?? ''
  for (const h of ['authorization', 'content-type', 'cache-control', 'pragma']) {
    assert.ok(allow.split(',').map((s) => s.trim()).includes(h), `falta ${h}`)
  }
})

// 6) unknown requested header is NOT reflected (intersection, not blind echo).
test('header desconocido no se refleja', () => {
  const res = cors.preflight(preflight(WWW, 'authorization, x-evil-header'))
  const allow = res.headers.get('access-control-allow-headers') ?? ''
  assert.ok(allow.includes('authorization'))
  assert.ok(!allow.toLowerCase().includes('x-evil-header'))
})

// 7) ACAO is a single value, not a comma list.
test('ACAO contiene un único valor', () => {
  const acao = cors.preflight(preflight(WWW)).headers.get('access-control-allow-origin') ?? ''
  assert.ok(!acao.includes(','))
  assert.equal(acao, WWW)
})

// 8) Vary is correct.
test('Vary correcto', () => {
  const res = cors.preflight(preflight(WWW))
  assert.equal(res.headers.get('vary'), 'Origin, Access-Control-Request-Headers')
})

// methods + max-age present on the preflight.
test('métodos POST, OPTIONS y Max-Age 86400', () => {
  const res = cors.preflight(preflight(WWW))
  assert.equal(res.headers.get('access-control-allow-methods'), 'POST, OPTIONS')
  assert.equal(res.headers.get('access-control-max-age'), '86400')
})

// 9) error responses (401/403/500) keep CORS.
test('respuestas 401/403/500 conservan CORS', () => {
  for (const status of [401, 403, 500]) {
    const req = new Request('https://fn/whatsapp-send', { method: 'POST', headers: { Origin: WWW } })
    const res = cors.json(req, { success: false, error: 'x' }, status)
    assert.equal(res.status, status)
    assert.equal(res.headers.get('access-control-allow-origin'), WWW)
    assert.equal(res.headers.get('content-type'), 'application/json')
  }
  // disallowed origin on an error response → still no ACAO
  const reqEvil = new Request('https://fn/whatsapp-send', { method: 'POST', headers: { Origin: EVIL } })
  assert.equal(cors.json(reqEvil, { success: false }, 403).headers.get('access-control-allow-origin'), null)
})

// 10) OPTIONS preflight runs no business logic: 204, empty body.
test('OPTIONS → 204 sin cuerpo (no dispara lógica)', async () => {
  const res = cors.preflight(preflight(WWW))
  assert.equal(res.status, 204)
  const body = await res.text()
  assert.equal(body, '')
})

// computeAllowedOrigins: canonical always present, env merged + de-duplicated.
test('computeAllowedOrigins: incluye canónicos y dedup', () => {
  const list = computeAllowedOrigins([WWW, 'https://extra.app, https://extra.app'])
  assert.ok(list.includes(WWW))
  assert.ok(list.includes(APEX))
  assert.ok(list.includes('https://extra.app'))
  assert.equal(list.filter((o) => o === WWW).length, 1) // no duplicate
  assert.equal(list.filter((o) => o === 'https://extra.app').length, 1)
})

test('parseOriginList separa por coma y limpia barras finales', () => {
  assert.deepEqual(parseOriginList('https://a.app/, https://b.app'), ['https://a.app', 'https://b.app'])
  assert.deepEqual(parseOriginList(undefined), [])
})
