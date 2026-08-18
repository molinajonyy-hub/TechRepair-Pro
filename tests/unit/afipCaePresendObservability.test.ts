// ============================================================================
// OBSERVABILIDAD PRE-WSAA de afip-cae
//
// El 400 del 2026-08-18 no se pudo diagnosticar desde los logs productivos: los
// gates pre-WSAA respondían sin `error_code` ni `gate_code`, y `fetchAttempt`
// DESCARTABA el error de PostgREST — de modo que un fallo de lectura del
// servidor salía como "attempt_id inválido o no corresponde a comprobante_id",
// que describe un error del cliente.
//
// El comportamiento de los gates se prueba de verdad en
// tests/deno/afipCaePreSend.test.ts, que los EJECUTA. Acá sólo se fija lo que
// no se puede observar ejecutando: que no se filtre material sensible y que la
// instrumentación no se borre por descuido.
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const INDEX = readFileSync(
  new URL('../../supabase/functions/afip-cae/index.ts', import.meta.url), 'utf-8')
const PRESEND = readFileSync(
  new URL('../../supabase/functions/afip-cae/preSend.ts', import.meta.url), 'utf-8')
const CBTES = readFileSync(
  new URL('../../supabase/functions/afip-cae/cbtesAsoc.ts', import.meta.url), 'utf-8')

test('fetchAttempt NO puede volver a descartar el error de PostgREST', () => {
  const i = PRESEND.indexOf('export async function fetchAttempt')
  assert.ok(i > 0, 'fetchAttempt debe vivir en preSend.ts para poder testearlo')
  const bloque = PRESEND.slice(i, i + 900)

  assert.match(bloque, /const \{ data, error \}/,
    'fetchAttempt tiene que desestructurar `error`, no sólo `data`')
  assert.doesNotMatch(bloque, /const \{ data \}\s*=/,
    'volvió el `const { data } = await ...` que se tragaba el error')
})

test('un fallo de LECTURA no se reporta como error del cliente', () => {
  // El return, no la union de tipos.
  const i = PRESEND.indexOf("gate: 'ATTEMPT_READ_FAILED'")
  assert.ok(i > 0, 'falta el gate que distingue "no pude leer" de "ids inválidos"')
  // 503: el servidor no pudo leer. Un 400 diría que el cliente mandó mal los ids.
  assert.match(PRESEND.slice(Math.max(0, i - 200), i + 200), /status:\s*503/,
    'un fallo de lectura debe ser 5xx, no 400')
})

test('el handler propaga gate_code y error_code al log y a la respuesta', () => {
  assert.match(INDEX, /gate_code:\s*pre\.gate/)
  assert.match(INDEX, /error_code:\s*pre\.detalle\s*\?\?\s*pre\.gate/,
    'la respuesta debe nombrar el gate fino cuando existe')
  assert.match(INDEX, /gate_detalle/)
})

test('los gates pre-envío tienen códigos estables', () => {
  for (const code of ['MISSING_IDS', 'ATTEMPT_READ_FAILED', 'ATTEMPT_MISMATCH',
                      'ATTEMPT_NOT_ACTIVE', 'CBTES_ASOC_INVALID', 'NC_IDENTITY_UNPROVEN']) {
    assert.ok(PRESEND.includes(`'${code}'`), `falta el gate ${code}`)
  }
})

test('cada rechazo de CbtesAsoc lleva un gate estable', () => {
  const rechazos = [...CBTES.matchAll(/ok:\s*false/g)]
  assert.ok(rechazos.length >= 12, `se esperaban >=12 rechazos, hay ${rechazos.length}`)
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

test('el log pre-WSAA NO filtra material sensible', () => {
  const preWsaa = INDEX.slice(INDEX.indexOf('serve(async'), INDEX.indexOf("invoke('afip-wsaa'"))
  for (const m of preWsaa.matchAll(/logStructured\(\{[\s\S]{0,500}?\}\)/g)) {
    assert.doesNotMatch(m[0], /token|authorization|secret|private|apikey|jwt/i,
      `logStructured con material sensible: ${m[0].slice(0, 140)}`)
  }
  assert.doesNotMatch(PRESEND, /console\.(log|error|warn)/,
    'los gates no deben loguear por su cuenta: el contexto lo pone el handler')
})

test('los gates pre-envío no llaman a ningún servicio externo', () => {
  assert.doesNotMatch(PRESEND, /functions\.invoke|fetch\(/,
    'nada en preSend.ts puede tocar WSAA/WSFE: corre antes del boundary')
})
