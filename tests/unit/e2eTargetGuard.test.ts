// ============================================================================
// M7 7D.2 — Guard de destino E2E. Es lo único que separa una corrida de tests
// de escribir datos reales en producción, así que se prueba a conciencia.
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { motivoDeRechazo, verificarMarker, enmascarar, MENSAJE_ABORTO }
  from '../e2e/setup/assertLocalTarget.ts'

const PROD = 'https://vrdxxmjzxhfgqlnxmbwx.supabase.co'

// ─── destino ────────────────────────────────────────────────────────────────
test('el Supabase PRODUCTIVO se rechaza', () => {
  const m = motivoDeRechazo(PROD)
  assert.ok(m)
  assert.match(m!, /Supabase gestionado/)
})

test('CUALQUIER *.supabase.co se rechaza, no sólo el ref conocido', () => {
  for (const u of [
    'https://otroproyecto.supabase.co',
    'https://staging.supabase.co',
    'https://algo.supabase.in',
  ]) {
    const m = motivoDeRechazo(u)
    assert.ok(m, `debería rechazar ${u}`)
    assert.match(m!, /Supabase gestionado/)
  }
})

test('cualquier host remoto se rechaza', () => {
  for (const u of ['https://api.miempresa.com', 'http://192.168.1.50:54321', 'http://10.0.0.5:8000']) {
    assert.ok(motivoDeRechazo(u), `debería rechazar ${u}`)
  }
})

test('los hosts locales en puertos permitidos se aceptan', () => {
  for (const u of [
    'http://127.0.0.1:54321',
    'http://127.0.0.1:54421',   // el puerto real de este stack
    'http://localhost:54321',
    'http://[::1]:54321',
    'http://localhost:8000',
  ]) {
    assert.equal(motivoDeRechazo(u), null, `debería aceptar ${u}`)
  }
})

test('un host local en puerto NO permitido se rechaza', () => {
  const m = motivoDeRechazo('http://127.0.0.1:9999')
  assert.ok(m)
  assert.match(m!, /puerto/)
})

// ─── FAIL-CLOSED ────────────────────────────────────────────────────────────
test('sin URL aborta: no asume local', () => {
  for (const v of [undefined, '', '   ']) {
    const m = motivoDeRechazo(v as string | undefined)
    assert.ok(m, `debería abortar con ${JSON.stringify(v)}`)
    assert.match(m!, /Fail-closed/)
  }
})

test('URL inválida aborta', () => {
  assert.ok(motivoDeRechazo('no-es-url'))
  assert.ok(motivoDeRechazo('://roto'))
})

test('el mensaje de rechazo explica cómo arreglarlo', () => {
  assert.match(motivoDeRechazo(PROD)!, /npx supabase status|local/)
})

test('NO existe ningún escape tipo ALLOW_PRODUCTION_E2E', () => {
  process.env.ALLOW_PRODUCTION_E2E = 'true'
  try {
    assert.ok(motivoDeRechazo(PROD), 'ninguna variable debe habilitar producción')
  } finally {
    delete process.env.ALLOW_PRODUCTION_E2E
  }
})

// ─── marker ─────────────────────────────────────────────────────────────────
test('sin service role no se puede verificar el marker: aborta', async () => {
  const m = await verificarMarker('http://127.0.0.1:54421', '')
  assert.ok(m)
  assert.match(m!, /Fail-closed/)
})

test('si el backend no responde, aborta', async () => {
  // puerto local cerrado: simula stack apagado
  const m = await verificarMarker('http://127.0.0.1:1', 'fake-key')
  assert.ok(m)
  assert.match(m!, /No se pudo consultar el marker|supabase start/)
})

// ─── higiene de logs ────────────────────────────────────────────────────────
test('enmascarar no filtra el valor completo', () => {
  const s = enmascarar('vrdxxmjzxhfgqlnxmbwx.supabase.co')
  assert.ok(!s.includes('vrdxxmjzxhfgqlnxmbwx'))
  assert.ok(s.includes('…'))
})

test('el mensaje de aborto es el acordado', () => {
  assert.equal(MENSAJE_ABORTO, 'E2E ABORTADO: el destino Supabase no es local y seguro')
})
