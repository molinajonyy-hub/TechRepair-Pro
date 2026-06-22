/**
 * Guarda de regresión: la edge function legacy `whatsapp-embedded-signup`
 * debe permanecer DESHABILITADA (no puede iniciar onboarding) hasta que se
 * reemplace por la implementación v4 con coexistencia, validada y aprobada.
 *
 * Es un test a nivel de fuente porque la función corre en Deno y no se importa
 * en el runner de node:test. Verifica el contrato observable del endpoint.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(
  join(here, '../../supabase/functions/whatsapp-embedded-signup/index.ts'),
  'utf8',
)

test('responde deshabilitado: 503 + código sanitizado', () => {
  assert.match(src, /META_EMBEDDED_SIGNUP_NOT_CONFIGURED/)
  assert.match(src, /\b503\b/)
})

test('el flujo OAuth legacy fue retirado (no puede iniciar onboarding)', () => {
  assert.doesNotMatch(src, /oauth\/access_token/, 'no debe intercambiar código OAuth')
  assert.doesNotMatch(src, /handleCallback/, 'no debe procesar callback de onboarding')
  assert.doesNotMatch(src, /exchangeCodeForToken/, 'no debe intercambiar el código por token')
  assert.doesNotMatch(src, /graph\.facebook\.com/, 'no debe llamar a Graph API')
  assert.doesNotMatch(src, /whatsapp_credential_store/, 'no debe almacenar credenciales')
})

test('no expone secretos internos en la respuesta pública', () => {
  assert.doesNotMatch(src, /META_APP_SECRET/, 'no debe referenciar el app secret')
})
