// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-2D — clasificación CERRADA de errores de Auth (src/lib/authErrors.ts).
//
// Errores sintéticos con la forma real de supabase-js (AuthApiError,
// AuthWeakPasswordError, AuthRetryableFetchError) y de GoTrue v2.19x. Lo que se
// afirma: el `kind` y que el texto del servidor NUNCA aparece en el mensaje.
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test'
import assert from 'node:assert/strict'
import * as e from '../../src/lib/authErrors.ts'
import { COMPROMISED_PASSWORD_MESSAGE } from '../../src/lib/passwordPolicy.ts'
import { CONTACTO_SOPORTE } from '../../src/config/contacto.ts'

const api = (status: number, code: string | undefined, message: string) => ({ name: 'AuthApiError', status, code, message })

test('A1. alta: 429 por correo → copy propio, jamás «Email rate limit exceeded»', () => {
  const err = api(429, 'over_email_send_rate_limit', 'email rate limit exceeded')
  assert.equal(e.classifySignUpError(err), 'rate_limited')
  const msg = e.signUpErrorMessage(err)
  assert.equal(msg, 'Hiciste varios intentos seguidos. Esperá unos minutos y volvé a probar.')
  assert.doesNotMatch(msg, /rate limit/i)
  // Versión vieja de GoTrue, sin código.
  assert.equal(e.classifySignUpError(api(429, undefined, 'Email rate limit exceeded')), 'rate_limited')
  assert.equal(e.classifySignUpError(api(429, 'over_request_rate_limit', 'Request rate limit reached')), 'rate_limited')
})

test('A2. alta: weak_password (Leaked Password Protection) → copy propio', () => {
  const err = { name: 'AuthWeakPasswordError', code: 'weak_password', status: 422, reasons: ['pwned'], message: 'Password is known to be weak and easy to guess, please choose a different one.' }
  assert.equal(e.classifySignUpError(err), 'weak_password')
  assert.equal(e.signUpErrorMessage(err), COMPROMISED_PASSWORD_MESSAGE)
})

test('A3. alta: email ya registrado se CLASIFICA igual, pero la UI no confirma que la cuenta exista', () => {
  const senales = [
    api(422, 'user_already_exists', 'User already registered'),
    api(422, 'email_exists', 'Email address already exists'),
    { message: 'User already registered' },                // GoTrue viejo, sin código
    { message: 'A user with this email has already been registered' },
  ]
  const neutro = 'No pudimos completar el registro. Si ya tenés una cuenta, iniciá sesión o recuperá tu contraseña.'
  assert.equal(e.SIGNUP_ERROR_MESSAGE.already_registered, neutro)
  for (const err of senales) {
    // La detección técnica no cambió…
    assert.equal(e.classifySignUpError(err), 'already_registered', JSON.stringify(err))
    // …pero el texto visible es condicional: no afirma que la cuenta exista.
    const msg = e.signUpErrorMessage(err)
    assert.equal(msg, neutro)
    assert.doesNotMatch(msg, /ya tiene una cuenta|ya está registrad|already/i)
  }
})

test('A4. alta: fallo del SMTP → copy propio con el soporte canónico', () => {
  const err = api(500, 'unexpected_failure', 'Error sending confirmation email')
  assert.equal(e.classifySignUpError(err), 'email_send_failed')
  const msg = e.signUpErrorMessage(err)
  assert.ok(msg.includes(CONTACTO_SOPORTE))
  assert.doesNotMatch(msg, /Error sending/)
  assert.equal(e.classifySignUpError(api(400, 'email_address_not_authorized', 'Email address "x" cannot be used as it is not authorized')), 'email_send_failed')
})

test('A5. alta: red y gateway → copy de conexión', () => {
  assert.equal(e.classifySignUpError({ name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' }), 'network')
  assert.equal(e.classifySignUpError({ name: 'AuthRetryableFetchError', status: 503, message: 'Service Unavailable' }), 'network')
})

test('A6. alta: error desconocido → genérico, sin texto de GoTrue', () => {
  const raros = [
    api(500, 'unexpected_failure', 'Database error saving new user'),
    api(400, 'validation_failed', 'Something weird happened at 10.0.0.3'),
    { message: 'TechRepair fue hackeado' },
    null,
    'string suelto',
  ]
  for (const err of raros) {
    const msg = e.signUpErrorMessage(err)
    assert.equal(msg, e.SIGNUP_ERROR_MESSAGE.unknown, JSON.stringify(err))
    assert.doesNotMatch(msg, /Database|weird|hackeado|10\.0\.0\.3/)
  }
})

test('A7. alta: overrides cambian el copy, no el contrato', () => {
  const err = api(422, 'user_already_exists', 'User already registered')
  assert.equal(e.signUpErrorMessage(err, { already_registered: 'otro copy' }), 'otro copy')
  assert.equal(e.signUpErrorMessage(api(429, undefined, 'x'), { already_registered: 'otro copy' }), e.SIGNUP_ERROR_MESSAGE.rate_limited)
})

test('A8. login: sin confirmar, credenciales, rate limit, red, desconocido', () => {
  assert.equal(e.classifySignInError(api(400, 'email_not_confirmed', 'Email not confirmed')), 'email_not_confirmed')
  assert.equal(e.classifySignInError({ message: 'Email not confirmed' }), 'email_not_confirmed')
  assert.equal(e.classifySignInError(api(400, 'invalid_credentials', 'Invalid login credentials')), 'invalid_credentials')
  assert.equal(e.classifySignInError({ message: 'Invalid login credentials' }), 'invalid_credentials')
  assert.equal(e.classifySignInError(api(429, 'over_request_rate_limit', 'Request rate limit reached')), 'rate_limited')
  assert.equal(e.classifySignInError({ name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' }), 'network')
  assert.equal(e.classifySignInError(api(400, 'user_banned', 'User is banned')), 'unknown')
})

test('A9. reenvío: enviado, 429 y error', () => {
  assert.equal(e.classifyResendResult(null), 'sent')
  assert.equal(e.classifyResendResult(api(429, 'over_email_send_rate_limit', 'x')), 'rate_limited')
  assert.equal(e.classifyResendResult({ message: 'For security purposes, you can only request this after 42 seconds.', status: 429 }), 'rate_limited')
  assert.equal(e.classifyResendResult(api(500, 'unexpected_failure', 'Error sending confirmation email')), 'error')
})

test('A10. URL: error_description NUNCA se refleja; sólo error/error_code contra un mapa', () => {
  const q = (s: string) => new URLSearchParams(s)
  assert.equal(e.classifyAuthUrlError(q('')), null)
  assert.equal(e.classifyAuthUrlError(q('motivo=link_invalido')), null)
  assert.equal(e.classifyAuthUrlError(q('error=access_denied&error_description=The+user+denied')), 'oauth_cancelled')
  assert.equal(e.classifyAuthUrlError(q('error=access_denied&error_code=otp_expired&error_description=Email+link')), 'link_expired')
  assert.equal(e.classifyAuthUrlError(q('error=access_denied&error_code=signup_disabled')), 'failed')
  assert.equal(e.classifyAuthUrlError(q('error=server_error&error_description=Unable+to+exchange')), 'failed')

  const ataque = q('error=x&error_description=TechRepair+fue+hackeado')
  const kind = e.classifyAuthUrlError(ataque)
  assert.equal(kind, 'failed')
  assert.equal(e.AUTH_URL_ERROR_MESSAGE[kind!], 'No pudimos completar el inicio de sesión. Intentá nuevamente.')
  for (const msg of Object.values(e.AUTH_URL_ERROR_MESSAGE)) assert.doesNotMatch(msg, /hackeado/)
})

test('A11. ningún copy del contrato está en inglés ni menciona internals', () => {
  const todos = [...Object.values(e.SIGNUP_ERROR_MESSAGE), ...Object.values(e.AUTH_URL_ERROR_MESSAGE), e.GOOGLE_START_ERROR_MESSAGE]
  for (const msg of todos) assert.doesNotMatch(msg, /\b(error|exceeded|invalid|failed|GoTrue|Supabase|SMTP)\b/i, msg)
})
