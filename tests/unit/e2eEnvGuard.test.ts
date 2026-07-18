// ============================================================================
// M7 7D.1 — Guard de entorno E2E: nunca contra producción.
//
// `.env` del repo apunta a la instancia productiva, así que este guard es lo
// único que separa una corrida de E2E de escribir datos reales.
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { motivoDeRechazo } from '../../src/../tests/e2e/helpers/assertLocalEnv.ts'

const PROD = 'https://vrdxxmjzxhfgqlnxmbwx.supabase.co'

test('la instancia PRODUCTIVA se rechaza por ref explícito', () => {
  const m = motivoDeRechazo(PROD)
  assert.ok(m, 'debe rechazar producción')
  assert.match(m!, /PRODUCTIVA/)
  assert.match(m!, /vrdxxmjzxhfgqlnxmbwx/)
})

test('cualquier host remoto se rechaza, aunque no sea el ref conocido', () => {
  for (const url of [
    'https://otroproyecto.supabase.co',
    'https://db.staging.supabase.co',
    'https://api.miempresa.com',
    'http://192.168.1.50:54321',
  ]) {
    assert.ok(motivoDeRechazo(url), `debería rechazar ${url}`)
  }
})

test('los hosts locales se aceptan', () => {
  for (const url of [
    'http://127.0.0.1:54321',
    'http://localhost:54321',
    'http://localhost',
    'http://[::1]:54321',
    'http://host.docker.internal:54321',
    'http://kong:8000',
  ]) {
    assert.equal(motivoDeRechazo(url), null, `debería aceptar ${url}`)
  }
})

test('FAIL-CLOSED: sin URL aborta en vez de asumir local', () => {
  for (const v of ['', '   ']) {
    const m = motivoDeRechazo(v)
    assert.ok(m, 'una URL vacía debe abortar')
    assert.match(m!, /Fail-closed/)
  }
})

test('una URL inválida aborta', () => {
  assert.ok(motivoDeRechazo('no-es-una-url'))
})

test('el rechazo explica cómo arreglarlo', () => {
  assert.match(motivoDeRechazo(PROD)!, /E2E_SUPABASE_URL/)
  assert.match(motivoDeRechazo('https://otro.supabase.co')!, /E2E_SUPABASE_URL/)
})
