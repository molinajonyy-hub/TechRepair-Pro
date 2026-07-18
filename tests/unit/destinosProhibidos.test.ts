// ============================================================================
// M7 7D.2 — Segunda línea de defensa: el bloqueo de red dentro del browser.
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { motivoDestinoProhibido } from '../e2e/setup/destinosProhibidos.ts'

test('bloquea cualquier Supabase gestionado', () => {
  for (const u of [
    'https://vrdxxmjzxhfgqlnxmbwx.supabase.co/rest/v1/comprobantes',
    'https://otro.supabase.co/auth/v1/token',
    'https://x.supabase.in/rest/v1/rpc/annul_comprobante_atomic',
  ]) {
    assert.match(motivoDestinoProhibido(u) ?? '', /Supabase gestionado/, u)
  }
})

test('deja pasar el stack local', () => {
  for (const u of [
    'http://127.0.0.1:54421/rest/v1/comprobantes',
    'http://localhost:5174/assets/index.js',
    'http://localhost:54421/auth/v1/token',
  ]) {
    assert.equal(motivoDestinoProhibido(u), null, u)
  }
})

test('bloquea analytics', () => {
  for (const u of [
    'https://www.google-analytics.com/collect',
    'https://www.googletagmanager.com/gtag/js',
    'https://o1.ingest.sentry.io/api/1/store/',
  ]) {
    assert.match(motivoDestinoProhibido(u) ?? '', /analytics/, u)
  }
})

test('no confunde dominios que sólo CONTIENEN el nombre', () => {
  // Un host atacante tipo "supabase.co.evil.com" no termina en .supabase.co,
  // pero tampoco es local: que no sea prohibido acá es correcto — el guard de
  // destino ya impide que la app se construya contra él.
  assert.equal(motivoDestinoProhibido('https://mi-supabase.com/x'), null)
  // Y al revés: un subdominio profundo de supabase.co SÍ se bloquea.
  assert.ok(motivoDestinoProhibido('https://db.proj.supabase.co/x'))
})

test('una URL relativa no es un destino: no se bloquea', () => {
  assert.equal(motivoDestinoProhibido('/assets/app.css'), null)
})
