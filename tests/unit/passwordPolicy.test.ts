// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-2D — política de contraseña canónica (src/lib/passwordPolicy.ts).
//
// Una sola regla para registro principal, portal mayorista y ResetPassword:
// mínimo 8 caracteres, máximo 72 BYTES UTF-8, confirmación coincidente.
// Además: `weak_password` (Leaked Password Protection) con copy propio.
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as p from '../../src/lib/passwordPolicy.ts'
import * as recovery from '../../src/lib/passwordRecovery.ts'

test('P1. 7 caracteres se rechaza; 8 pasa', () => {
  assert.equal(p.checkPasswordPolicy('1234567'), 'too_short')
  assert.equal(p.checkPasswordPolicy('12345678'), null)
  assert.equal(p.PASSWORD_POLICY_MESSAGE.too_short, 'Usá al menos 8 caracteres.')
})

test('P2. 72 bytes pasa; 73 bytes se rechaza (bcrypt), también en multibyte', () => {
  assert.equal(p.checkPasswordPolicy('a'.repeat(72)), null)
  assert.equal(p.checkPasswordPolicy('a'.repeat(73)), 'too_long')
  // «ñ» = 2 bytes: 36 → 72 bytes (pasa), 37 → 74 bytes (no pasa) aunque sean 37 caracteres.
  assert.equal(p.checkPasswordPolicy('ñ'.repeat(36)), null)
  assert.equal(p.checkPasswordPolicy('ñ'.repeat(37)), 'too_long')
  assert.equal(p.passwordByteLength('ñ'), 2)
})

test('P3. el mínimo cuenta caracteres, no unidades UTF-16: 4 emojis no son 8 caracteres', () => {
  assert.equal(p.checkPasswordPolicy('😀😀😀😀'), 'too_short')
  assert.equal(p.checkPasswordPolicy('😀'.repeat(8)), null)
})

test('P4. sólo espacios no es una contraseña', () => {
  assert.equal(p.checkPasswordPolicy('        '), 'blank')
})

test('P5. par: confirmación faltante o distinta', () => {
  assert.deepEqual(p.validatePasswordPair('segura-123', 'segura-123'), {})
  assert.equal(p.validatePasswordPair('segura-123', '').confirm, 'Repetí la contraseña.')
  assert.equal(p.validatePasswordPair('segura-123', 'segura-124').confirm, 'Las contraseñas no coinciden.')
  assert.equal(p.validatePasswordPair('corta', 'corta').password, 'Usá al menos 8 caracteres.')
})

test('P6. placeholder canónico', () => {
  assert.equal(p.PASSWORD_PLACEHOLDER, 'Mínimo 8 caracteres')
})

test('P7. weak_password: detección cerrada y copy propio según motivos', () => {
  const pwned = { name: 'AuthWeakPasswordError', code: 'weak_password', status: 422, reasons: ['pwned'], message: 'Password is known to be weak and easy to guess' }
  assert.equal(p.isWeakPasswordError(pwned), true)
  assert.equal(p.isWeakPasswordError({ code: 'weak_password' }), true)
  assert.equal(p.isWeakPasswordError({ name: 'AuthWeakPasswordError' }), true)
  assert.equal(p.isWeakPasswordError({ code: 'same_password' }), false)
  assert.equal(p.isWeakPasswordError(null), false)

  assert.equal(p.weakPasswordMessage(pwned), p.COMPROMISED_PASSWORD_MESSAGE)
  assert.equal(p.COMPROMISED_PASSWORD_MESSAGE, 'Esta contraseña no es segura. Elegí otra que no hayas usado en otros servicios.')
  assert.equal(p.weakPasswordMessage({ code: 'weak_password', reasons: [] }), p.COMPROMISED_PASSWORD_MESSAGE)
  assert.equal(p.weakPasswordMessage({ code: 'weak_password', reasons: ['length'] }), 'Usá una contraseña más larga.')
  assert.match(p.weakPasswordMessage({ code: 'weak_password', reasons: ['characters'] }), /letras, números/)
  assert.doesNotMatch(p.weakPasswordMessage(pwned), /known to be weak|easy to guess/i)
})

test('P8. passwordRecovery reexporta la política, sin duplicarla', () => {
  assert.equal(recovery.PASSWORD_MIN_LENGTH, p.PASSWORD_MIN_LENGTH)
  assert.equal(recovery.PASSWORD_MAX_BYTES, p.PASSWORD_MAX_BYTES)
  assert.deepEqual(recovery.validateNewPassword('corta', 'corta'), p.validatePasswordPair('corta', 'corta'))
  const src = readFileSync(new URL('../../src/lib/passwordRecovery.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /PASSWORD_MIN_LENGTH\s*=\s*\d/, 'no redefine el mínimo')
  assert.doesNotMatch(src, /PASSWORD_MAX_BYTES\s*=\s*\d/, 'no redefine el máximo')
})

test('P9. ninguna superficie de alta o cambio de contraseña conserva el mínimo 6 ni números mágicos', () => {
  for (const archivo of ['src/pages/Login.tsx', 'src/portal/pages/PortalRegister.tsx', 'src/pages/ResetPassword.tsx']) {
    const src = readFileSync(new URL(`../../${archivo}`, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /\.length\s*(<|>=)\s*\d/, `${archivo}: largo de contraseña con número mágico`)
    assert.doesNotMatch(src, /(al menos|Mínimo) 6/, `${archivo}: copy del mínimo viejo`)
    assert.doesNotMatch(src, /\b72\b/, `${archivo}: límite de bytes repetido`)
  }
})

test('P10. ResetPassword mapea weak_password al copy propio (nunca al del servidor)', () => {
  const r = recovery.classifyPasswordUpdateError({ name: 'AuthWeakPasswordError', code: 'weak_password', status: 422, reasons: ['pwned'], message: 'Password is known to be weak' })
  assert.deepEqual(r, { kind: 'field', message: p.COMPROMISED_PASSWORD_MESSAGE })
})
