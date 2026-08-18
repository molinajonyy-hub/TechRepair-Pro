// ============================================================================
// OBSERVABILIDAD PRE-WSAA de afip-cae
//
// El 400 del 2026-08-18 no se pudo diagnosticar desde los logos productivos:
// los cuatro gates pre-WSAA respondían sin `error_code` y sin `gate_code`, y
// `fetchAttempt` DESCARTABA el error de PostgREST — de modo que un fallo de
// lectura del servidor salía como "attempt_id inválido o no corresponde a
// comprobante_id", que describe un error del cliente.
//
// Estos tests fijan el contrato de diagnóstico. Son de SOURCE: leen el archivo
// real, porque el handler vive dentro de `serve()` y no se puede importar en
// Node sin el runtime de Deno.
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const INDEX = readFileSync(
  new URL('../../supabase/functions/afip-cae/index.ts', import.meta.url), 'utf-8')
const CBTES = readFileSync(
  new URL('../../supabase/functions/afip-cae/cbtesAsoc.ts', import.meta.url), 'utf-8')

test('fetchAttempt NO puede volver a descartar el error de PostgREST', () => {
  const bloque = INDEX.slice(
    INDEX.indexOf('async function fetchAttempt'),
    INDEX.indexOf('async function fetchAttempt') + 900)

  assert.match(bloque, /const \{ data, error \}/,
    'fetchAttempt tiene que desestructurar `error`, no sólo `data`')
  assert.doesNotMatch(bloque, /const \{ data \}\s*=/,
    'volvió el `const { data } = await ...` que se tragaba el error')
  assert.match(bloque, /error:\s*error\s*\?/,
    'fetchAttempt debe devolver el error al caller')
})

test('un fallo de LECTURA del intento no se reporta como error del cliente', () => {
  assert.match(INDEX, /ATTEMPT_READ_FAILED/,
    'falta el gate que distingue "no pude leer" de "ids inválidos"')
  // 503: el servidor no pudo leer. Un 400 diría que el cliente mandó mal los ids.
  const i = INDEX.indexOf('ATTEMPT_READ_FAILED')
  assert.match(INDEX.slice(i, i + 400), /\}, 503\)/,
    'un fallo de lectura debe ser 5xx, no 400')
})

test('los cuatro gates pre-WSAA responden con error_code', () => {
  for (const code of ['MISSING_IDS', 'ATTEMPT_MISMATCH', 'ATTEMPT_NOT_ACTIVE']) {
    assert.ok(INDEX.includes(`error_code: '${code}'`), `falta error_code ${code}`)
  }
  assert.match(INDEX, /error_code:\s*cbtesAsoc\.gate/,
    'el 400 de CbtesAsoc debe propagar el gate concreto')
})

test('el log pre-WSAA nombra el gate y los códigos fiscales comparados', () => {
  assert.match(INDEX, /gate_code:\s*cbtesAsoc\.gate/)
  assert.match(INDEX, /cbteTipoIntento:\s*tipo_comprobante/)
  assert.match(INDEX, /puntoVentaIntento:\s*punto_venta/)
})

test('el log NO filtra material sensible', () => {
  // Ventana pre-WSAA: desde el handler hasta el invoke de afip-wsaa.
  const preWsaa = INDEX.slice(INDEX.indexOf('serve(async'), INDEX.indexOf("invoke('afip-wsaa'"))
  for (const prohibido of ['Authorization', 'authorization:', 'SERVICE_ROLE_KEY,', 'jwt', 'private_key', 'privateKey']) {
    assert.ok(!preWsaa.includes(`${prohibido}`) || !preWsaa.includes(`logStructured`),
      `no loguear ${prohibido}`)
  }
  // Aserción concreta: ningún logStructured menciona token/authorization/secret.
  for (const m of preWsaa.matchAll(/logStructured\(\{[\s\S]{0,400}?\}\)/g)) {
    assert.doesNotMatch(m[0], /token|authorization|secret|private/i,
      `logStructured con material sensible: ${m[0].slice(0, 120)}`)
  }
})

test('cada rechazo de CbtesAsoc lleva un gate estable', () => {
  const rechazos = [...CBTES.matchAll(/ok:\s*false/g)]
  assert.ok(rechazos.length >= 12, `se esperaban >=12 rechazos, hay ${rechazos.length}`)
  // Ningún `ok: false` puede quedar sin `gate` en las ~6 líneas siguientes.
  for (const m of rechazos) {
    const ventana = CBTES.slice(m.index!, m.index! + 320)
    assert.match(ventana, /gate:\s*'[A-Z_]+'/,
      `rechazo sin gate cerca de: ${ventana.slice(0, 110)}`)
  }
})

test('la lectura fallida y la fila ausente se distinguen en el texto', () => {
  assert.match(CBTES, /No se pudo leer el comprobante local/)
  assert.match(CBTES, /No se encontró el comprobante local/)
})
