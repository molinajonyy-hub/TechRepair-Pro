// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-2D — fallback de la raíz para enlaces `token_hash` (src/lib/authEmailLink.ts).
//
// Si GoTrue degrada `.RedirectTo` al Site URL, el enlace queda en
// `/?token_hash=…&type=signup`. Sólo ESE contrato se lleva a /auth/callback:
// la raíz no se convierte en un parser de redirects.
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as l from '../../src/lib/authEmailLink.ts'

const HASH = 'a3f1c0d9e8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5'
const loc = (search: string, pathname = '/', hash = '') => ({ pathname, search, hash })

test('R1. signup, email y recovery en la raíz → /auth/callback con los mismos dos parámetros', () => {
  for (const type of ['signup', 'email', 'recovery']) {
    assert.equal(
      l.rootEmailLinkTarget(loc(`?token_hash=${HASH}&type=${type}`)),
      `/auth/callback?token_hash=${HASH}&type=${type}`,
    )
  }
  // El orden de los parámetros no importa; el prefijo PKCE es válido.
  assert.equal(l.rootEmailLinkTarget(loc(`?type=signup&token_hash=pkce_${HASH}`)), `/auth/callback?token_hash=pkce_${HASH}&type=signup`)
})

test('R2. fuera del contrato exacto no hace nada', () => {
  const rechazos = [
    loc(`?token_hash=${HASH}&type=signup`, '/dashboard'),            // no es la raíz
    loc(`?token_hash=${HASH}&type=signup`, '/landing'),
    loc(`?token_hash=${HASH}&type=signup`, '/', '#x'),               // con fragmento
    loc(`?token_hash=${HASH}&type=invite`),                          // tipo fuera del enum
    loc(`?token_hash=${HASH}&type=magiclink`),
    loc(`?token_hash=${HASH}&type=email_change`),
    loc(`?token_hash=${HASH}`),                                       // falta type
    loc('?type=signup'),                                              // falta token
    loc(`?token_hash=${HASH}&type=signup&redirectTo=//evil.com`),    // parámetro extra
    loc(`?token_hash=${HASH}&type=signup&next=/x`),
    loc(`?token_hash=${HASH}&token_hash=${HASH}&type=signup`),        // duplicado
    loc(`?token_hash=${HASH}&type=signup&type=recovery`),
    loc('?token_hash=corto&type=signup'),                             // no tiene forma de hash
    loc('?token_hash=%3Cscript%3Ealert(1)%3C%2Fscript%3Eaaaaaaaaaaaa&type=signup'),
    loc('?token_hash=https%3A%2F%2Fevil.com%2Faaaaaaaaaaaa&type=signup'),
    loc(''),
    loc('?utm_source=ig'),
  ]
  for (const r of rechazos) assert.equal(l.rootEmailLinkTarget(r), null, JSON.stringify(r))
})

test('R3. el destino es fijo: nunca sale del path /auth/callback', () => {
  const t = l.rootEmailLinkTarget(loc(`?token_hash=${HASH}&type=recovery`))!
  assert.ok(t.startsWith('/auth/callback?'))
  assert.ok(!t.includes('//'))
})

test('R4. al arrancar reescribe la MISMA entrada del historial, conservando el state', () => {
  const calls: Array<{ state: unknown; url: unknown }> = []
  const history = { state: { k: 1 }, replaceState(state: unknown, _u: string, url?: unknown) { calls.push({ state, url }) } }
  assert.equal(l.redirectRootEmailLinkAtBoot(loc(`?token_hash=${HASH}&type=signup`), history), true)
  assert.deepEqual(calls, [{ state: { k: 1 }, url: `/auth/callback?token_hash=${HASH}&type=signup` }])

  const nada: unknown[] = []
  const h2 = { state: null, replaceState(...a: unknown[]) { nada.push(a) } }
  assert.equal(l.redirectRootEmailLinkAtBoot(loc('?utm_source=ig'), h2), false)
  assert.equal(nada.length, 0)
})

test('R5. AuthCallback y el fallback comparten el enum de tipos (una sola fuente)', () => {
  assert.deepEqual([...l.EMAIL_LINK_TYPES], ['signup', 'email', 'recovery'])
  const callback = readFileSync(new URL('../../src/pages/AuthCallback.tsx', import.meta.url), 'utf8')
  assert.match(callback, /isEmailLinkType\(tipo\)/)
  assert.doesNotMatch(callback, /TIPOS_OTP\s*=/)
  const boot = readFileSync(new URL('../../src/lib/supabase.ts', import.meta.url), 'utf8')
  const fallback = boot.indexOf('redirectRootEmailLinkAtBoot(window.location')
  const cliente = boot.indexOf('createClient(')
  assert.ok(fallback > 0 && fallback < cliente, 'el fallback corre antes de crear el cliente')
})
