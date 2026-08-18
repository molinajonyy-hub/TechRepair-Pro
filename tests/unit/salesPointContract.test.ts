/**
 * POS PRE-BETA — contrato de lectura del punto de venta.
 *
 * Runner: node:test nativo. Ejecutar: npm run test:unit
 *
 * Dos capas (mismo patrón que arcaConfigWriteContract.test.ts):
 *  1) unidad pura de src/lib/salesPointFormat.ts (no importa Vite/Supabase);
 *  2) contrato de FUENTE sobre salesPointService.ts y los tres modales —
 *     el servicio importa src/lib/supabase.ts, que lanza sin VITE_SUPABASE_URL
 *     bajo `node --test`, así que se verifica por texto fuente.
 *
 * Contexto: los tres modales pedían a `sales_points` dos columnas que no
 * existen. PostgREST devolvía 400, el `.then(({ data }) => …)` descartaba el
 * error y el POS mostraba siempre '0001'. Las columnas reales son `numero` y
 * `activo`; el desempate correcto es `predeterminado`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  formatearPuntoVenta,
  interpretarRespuestaPuntoVenta,
  ANCHO_PUNTO_VENTA,
  PUNTO_VENTA_POR_DEFECTO,
} from '../../src/lib/salesPointFormat.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf-8')

/** Asertar sobre CÓDIGO, no sobre comentarios: los comentarios de estos
 *  archivos nombran a propósito las columnas viejas para explicar el bug. */
function stripComments(src: string): string {
  let out = '', i = 0
  while (i < src.length) {
    if (src.slice(i, i + 2) === '//') {
      const f = src.indexOf('\n', i); const e = f === -1 ? src.length : f
      out += ' '.repeat(e - i); i = e; continue
    }
    if (src.slice(i, i + 2) === '/*') {
      const f = src.indexOf('*/', i + 2); const e = f === -1 ? src.length : f + 2
      out += ' '.repeat(e - i); i = e; continue
    }
    out += src[i]; i++
  }
  return out
}

const servicio = () => stripComments(read('../../src/services/salesPointService.ts'))

const MODALES = [
  '../../src/components/comprobantes/ComprobanteProModal.tsx',
  '../../src/components/comprobantes/ModalCrearComprobante.tsx',
  '../../src/components/comprobantes/ModalGenerarComprobante.tsx',
]

// ─── 1. Unidad pura: formato ────────────────────────────────────────────────

test('formatea el número de PV al ancho fiscal', () => {
  assert.equal(formatearPuntoVenta(7), '0007')
  assert.equal(formatearPuntoVenta(1), '0001')
  assert.equal(formatearPuntoVenta(23), '0023')
  assert.equal(formatearPuntoVenta(1234), '1234')
  assert.equal(ANCHO_PUNTO_VENTA, 4)
})

test('no trunca un PV más largo que el ancho fiscal', () => {
  // Preferible un número raro visible a uno recortado que parezca válido.
  assert.equal(formatearPuntoVenta(12345), '12345')
})

test('el default declarado coincide con el que usan los modales', () => {
  assert.equal(PUNTO_VENTA_POR_DEFECTO, '0001')
  for (const m of MODALES) {
    assert.match(stripComments(read(m)), /useState\((?:puntoVentaInicial \?\? )?'0001'\)/,
      `${m}: el default del estado dejó de ser '0001'`)
  }
})

// ─── 2. Unidad pura: error ≠ ausencia ───────────────────────────────────────

test('un PV encontrado se devuelve sin marcar fallo', () => {
  const fila = { id: 'x', numero: 7, nombre: 'Casa Central', activo: true, predeterminado: true }
  const r = interpretarRespuestaPuntoVenta({ data: fila, error: null })
  assert.equal(r.fallo, false)
  assert.equal(r.salesPoint?.numero, 7)
})

test('sin filas NO es un fallo: el negocio simplemente no configuró PV', () => {
  const r = interpretarRespuestaPuntoVenta({ data: null, error: null })
  assert.equal(r.fallo, false)
  assert.equal(r.salesPoint, null)
})

test('un error NO se puede leer como "no hay punto de venta"', () => {
  // El bug original en una línea: 400 indistinguible de lista vacía.
  const err = { code: '42703', message: 'column sales_points.punto_venta does not exist' }
  const r = interpretarRespuestaPuntoVenta({ data: null, error: err })
  assert.equal(r.fallo, true, 'un error debe marcarse como fallo')
  assert.equal(r.salesPoint, null)
})

test('un error con data no nula tampoco se toma como éxito', () => {
  const r = interpretarRespuestaPuntoVenta({ data: { numero: 9 }, error: { message: 'boom' } })
  assert.equal(r.fallo, true)
  assert.equal(r.salesPoint, null)
})

// ─── 3. Contrato de fuente: el servicio usa las columnas REALES ─────────────

test('el servicio consulta las columnas que existen', () => {
  const s = servicio()
  assert.match(s, /\.from\('sales_points'\)/, 'debe consultar sales_points')
  assert.match(s, /\.select\('[^']*\bnumero\b[^']*'\)/, "debe pedir 'numero'")
  assert.match(s, /\.eq\('activo',\s*true\)/, "debe filtrar por 'activo'")
})

test('el servicio NO usa las columnas inexistentes', () => {
  const s = servicio()
  assert.doesNotMatch(s, /'punto_venta'/,
    "'punto_venta' no existe en sales_points (es de comprobantes/arca_config)")
  assert.doesNotMatch(s, /'is_active'/,
    "'is_active' no existe en sales_points (la columna es 'activo')")
})

test('el desempate respeta el PV predeterminado, no el más antiguo', () => {
  const s = servicio()
  assert.match(s, /\.order\('predeterminado',\s*\{\s*ascending:\s*false\s*\}\)/,
    'el predeterminado tiene que ganar')
  assert.match(s, /\.order\('numero',\s*\{\s*ascending:\s*true\s*\}\)/,
    'a igual predeterminado, gana el número más chico')
  assert.doesNotMatch(s, /\.order\('created_at'/,
    'ordenar por created_at ignora el default que eligió el comercio')
})

test('el servicio registra el error en vez de descartarlo', () => {
  assert.match(servicio(), /logger\.error\(/,
    'un fallo mudo es indistinguible del caso normal')
})

// ─── 4. Contrato de fuente: los modales ya no consultan la tabla ────────────

test('ningún modal de comprobantes consulta sales_points directo', () => {
  for (const m of MODALES) {
    const src = stripComments(read(m))
    assert.doesNotMatch(src, /from\(\s*'sales_points'\s*\)/,
      `${m}: volvió a consultar sales_points a mano en vez de usar salesPointService`)
    assert.match(src, /salesPointService/,
      `${m}: debe leer el punto de venta por el servicio canónico`)
  }
})

test('los modales no nombran las columnas viejas de sales_points', () => {
  for (const m of MODALES) {
    const src = stripComments(read(m))
    assert.doesNotMatch(src, /data\?\.punto_venta/,
      `${m}: quedó la lectura de la columna inexistente`)
  }
})

// ─── 5. El gate E2E ya no tolera el 400 ─────────────────────────────────────

test('el gate de búsqueda dejó de whitelistear el 400 de sales_points', () => {
  const spec = read('../../tests/e2e/m7/search-pos-visual.spec.ts')
  const codigo = stripComments(spec)
  assert.doesNotMatch(codigo, /FALLOS_PREEXISTENTES\s*=\s*\[[^\]]*sales_points/,
    'el 400 de sales_points se arregló: si vuelve, el gate tiene que ponerse en rojo')
})
