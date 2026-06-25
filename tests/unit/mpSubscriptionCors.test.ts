/**
 * Source-level contract guards for the mp-subscription CORS handling.
 * The function runs in Deno (can't be imported into node:test), so we assert on
 * source text — same approach as billingContracts.test.ts.
 *
 * Guards the 2026-06-25 fix: real production origin is www (apex 307-redirects to
 * www), allow-headers is an explicit allowlist intersection (incl. cache-control /
 * pragma added by Chrome on hard reload), unauthorized origins get NO ACAO, and
 * every response flows through the central buildCorsHeaders + jsonResponse helpers.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf-8')

const fn      = read('../../supabase/functions/mp-subscription/index.ts')
const service = read('../../src/services/subscriptionService.ts')

// ── Origin allowlist: BOTH www and apex are real production origins ──────────
test('allowlist incluye www (origen real) y apex', () => {
  assert.match(fn, /'https:\/\/www\.techrepairpro\.app'/, 'falta el origen www (el que usa el navegador)')
  assert.match(fn, /'https:\/\/techrepairpro\.app'/, 'falta el apex')
  assert.match(fn, /const CANONICAL_ORIGINS\s*=\s*\[/)
})

test('ACAO: un único origen, nunca comodín, sin fallback canónico', () => {
  // never '*'
  assert.doesNotMatch(fn, /'Access-Control-Allow-Origin':\s*'\*'/)
  // ACAO only set when the request origin is allowlisted (no canonical fallback)
  assert.match(fn, /if\s*\(origin\s*&&\s*ALLOWED_ORIGINS\.includes\(origin\)\)/)
  assert.match(fn, /headers\['Access-Control-Allow-Origin'\]\s*=\s*origin/)
  // must NOT fall back to ALLOWED_ORIGINS[0] for the Allow-Origin value
  assert.doesNotMatch(fn, /'Access-Control-Allow-Origin':\s*[^\n]*ALLOWED_ORIGINS\[0\]/)
})

// ── Allow-Headers: explicit allowlist intersection (no blind reflection) ─────
test('allow-headers permite el set base + cache-control y pragma (hard reload)', () => {
  for (const h of ['authorization', 'x-client-info', 'apikey', 'content-type', 'cache-control', 'pragma']) {
    assert.match(fn, new RegExp(`'${h}'`), `falta '${h}' en la allowlist de headers`)
  }
  assert.match(fn, /const ALLOWED_REQUEST_HEADERS\s*=\s*new Set/)
})

test('header desconocido NO se refleja (intersección, no reflejo ciego)', () => {
  // reads the preflight's requested headers...
  assert.match(fn, /Access-Control-Request-Headers/)
  // ...lower-cases and filters by the allowlist (drops anything unknown)
  assert.match(fn, /\.toLowerCase\(\)/)
  assert.match(fn, /ALLOWED_REQUEST_HEADERS\.has\(/)
})

// ── Caching / Vary / methods ────────────────────────────────────────────────
test('Vary correcto y Max-Age 86400', () => {
  assert.match(fn, /'Vary':\s*'Origin, Access-Control-Request-Headers'/)
  assert.match(fn, /'Access-Control-Max-Age':\s*'86400'/)
})

test('métodos permitidos: POST, OPTIONS', () => {
  assert.match(fn, /'Access-Control-Allow-Methods':\s*'POST, OPTIONS'/)
})

// ── Every response goes through the central helpers (incl. errors) ──────────
test('todas las respuestas usan jsonResponse/buildCorsHeaders (sin json( roto)', () => {
  // central helpers exist
  assert.match(fn, /function buildCorsHeaders\(req: Request\)/)
  assert.match(fn, /function jsonResponse\(req: Request,/)
  // OPTIONS preflight uses the CORS builder
  assert.match(fn, /req\.method === 'OPTIONS'[\s\S]*buildCorsHeaders\(req\)/)
  // error paths use the helper
  assert.match(fn, /jsonResponse\(req,\s*\{ error: 'Unauthorized' \},\s*401\)/)
  assert.match(fn, /jsonResponse\(req,\s*\{ error: 'Method not allowed' \},\s*405\)/)
  assert.match(fn, /'Internal server error'[\s\S]*?,\s*500\)/)
  // no dangling references to the old helper name (json( ... ) — but .json() is fine)
  assert.doesNotMatch(fn, /[^.\w]json\(\s*\{/)
})

test('checkout devuelve JSON (init_point), no un redirect HTTP', () => {
  assert.match(fn, /init_point:\s*checkoutUrl/)
  assert.doesNotMatch(fn, /Response\.redirect/)
  assert.doesNotMatch(fn, /status:\s*30[1278]/)
})

// ── verify_jwt stays false → function validates the JWT itself ───────────────
test('la función valida el JWT internamente (gateway verify_jwt=false)', () => {
  assert.match(fn, /getAuthUser\(req\)/)
  assert.match(fn, /if \(!user\) return jsonResponse\(req,\s*\{ error: 'Unauthorized' \},\s*401\)/)
})

// ── Frontend: distinguishes the three Functions error types ─────────────────
test('subscriptionService distingue HTTP / Relay / Fetch errors', () => {
  assert.match(service, /import \{ FunctionsHttpError, FunctionsRelayError, FunctionsFetchError \}/)
  assert.match(service, /error instanceof FunctionsHttpError/)
  assert.match(service, /error instanceof FunctionsRelayError/)
  assert.match(service, /error instanceof FunctionsFetchError/)
})
