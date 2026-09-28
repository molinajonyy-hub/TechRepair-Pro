// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-2D — `[inbucket]` → `[local_smtp]` y config LOCAL de Auth.
//
// El helper de Mailpit de los E2E lee el puerto de `[local_smtp]` (canónico) y
// acepta `[inbucket]` sólo como compatibilidad. Y el config.toml commiteado
// declara exactamente lo que 2D promete: local_smtp, mínimo 8, plantillas
// token_hash versionadas. Nada de esto toca producción.
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mailpitPortFromToml } from '../e2e/setup/mailpit.ts'

const TOML = readFileSync(new URL('../../supabase/config.toml', import.meta.url), 'utf8')

test('M1. [local_smtp] es canónico; [inbucket] sólo compatibilidad; gana local_smtp', () => {
  assert.equal(mailpitPortFromToml('[local_smtp]\nenabled = true\nport = 54424\n'), '54424')
  assert.equal(mailpitPortFromToml('[inbucket]\nenabled = true\nport = 55424\n'), '55424')
  assert.equal(mailpitPortFromToml('[inbucket]\nport = 1\n\n[local_smtp]\nport = 2\n'), '2')
  assert.equal(mailpitPortFromToml('[storage]\nport = 9\n'), null)
  // El `port` de OTRA sección posterior no se confunde con el de local_smtp.
  assert.equal(mailpitPortFromToml('[local_smtp]\nenabled = true\n\n[storage]\nport = 9\n'), null)
})

test('M2. el config commiteado usa [local_smtp] y no [inbucket]', () => {
  assert.match(TOML, /^\[local_smtp\]\s*$/m)
  assert.doesNotMatch(TOML, /^\[inbucket\]\s*$/m)
  assert.equal(mailpitPortFromToml(TOML), '54424')
})

test('M3. stack local: mínimo 8, sin requisitos extra, secure_password_change OFF', () => {
  assert.match(TOML, /^minimum_password_length = 8$/m)
  assert.match(TOML, /^password_requirements = ""$/m)
  assert.match(TOML, /^secure_password_change = false$/m)
  assert.match(TOML, /^enable_confirmations = true$/m)
})

test('M4. plantillas token_hash cableadas a archivos que existen', () => {
  for (const [nombre, archivo] of [['confirmation', 'confirmation.html'], ['recovery', 'recovery.html']]) {
    const bloque = TOML.split(new RegExp(`^\\[auth\\.email\\.template\\.${nombre}\\]\\s*$`, 'm'))[1]?.split(/^\[/m)[0] ?? ''
    assert.match(bloque, new RegExp(`content_path = "\\./supabase/templates/${archivo}"`), nombre)
    assert.match(bloque, /subject = ".+TechRepair Pro"/, nombre)
    assert.ok(existsSync(new URL(`../../supabase/templates/${archivo}`, import.meta.url)), archivo)
  }
})

test('M5. el config no afirma que producción tenga Confirm Email apagado', () => {
  assert.doesNotMatch(TOML, /Confirm Email\s*\n?#?\s*APAGADO/)
  assert.doesNotMatch(TOML, /Producción sigue con Confirm Email/)
})
