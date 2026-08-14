/**
 * Presentación fiscal: número canónico, fecha de calendario y gate de emisión.
 *
 * Runner: node:test nativo. Ejecutar: npm run test:unit
 *
 * Los cuatro casos que se prueban acá salieron del smoke productivo del
 * 2026-08-14, después de aplicar la reparación histórica. No son hipotéticos:
 *
 *   · El comprobante 0010-00000045 —autorizado por ARCA— se mostraba como
 *     '0010-000100759033', porque el formateador anteponía el punto de venta al
 *     número interno, que ya traía su propio prefijo.
 *   · Su badge decía "Borrador" con el CAE impreso al lado.
 *   · Se le ofrecía "Emitir en ARCA" a un comprobante que ya tenía CAE.
 *   · Su vencimiento, un DATE 2026-06-26, se mostraba como 25/06/2026.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  formatearNumeroComprobante,
  muestraIdentidadFiscal,
  padPuntoVenta,
} from '../../src/lib/fiscalDisplay.ts'
import { formatearFechaCalendario } from '../../src/lib/fechaCalendario.ts'
import {
  getComprobanteDisplayStatus,
  permiteAccionesDeEmision,
} from '../../src/utils/comprobanteStatus.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf-8')

// ── Los dos comprobantes reales ─────────────────────────────────────────────

/** #45: reconciliado con ARCA. Comercialmente sigue en borrador. */
const C45 = {
  tipo: 'factura_c',
  estado: 'borrador',
  estado_fiscal: 'emitido',
  cae: '86249909766646',
  numero: '0001-00759033',
  numero_fiscal: '0010-00000045',
  punto_venta: '0010',
  tipo_comprobante_fiscal: '11',
  cae_vencimiento: '2026-06-26',
}

/** Uno de los 53: la venta ocurrió y se cobró, ARCA nunca la autorizó. */
const LEGACY = {
  tipo: 'factura_c',
  estado: 'emitido',
  estado_fiscal: 'sin_autorizacion_fiscal',
  cae: null,
  numero: '0001-00672017',
  numero_fiscal: null,
  punto_venta: '0001',
  cae_vencimiento: null,
  total_cobrado: 244960.8,
}

// ── 1. Número canónico ──────────────────────────────────────────────────────

test('el numero_fiscal gana sobre el número interno', () => {
  assert.equal(formatearNumeroComprobante(C45), '0010-00000045')
  assert.equal(muestraIdentidadFiscal(C45), true)
})

test('el bug exacto no puede volver: nunca se concatena pv + número interno', () => {
  const salida = formatearNumeroComprobante(C45)
  assert.notEqual(salida, '0010-000100759033')
  assert.ok(!/\d{4}-\d{9,}/.test(salida), `número sobre-prefijado: ${salida}`)
})

test('sin identidad fiscal se respeta el número interno tal como es', () => {
  // '0001-00672017' ya trae su prefijo: no se le antepone otro.
  assert.equal(formatearNumeroComprobante(LEGACY), '0001-00672017')
  assert.equal(muestraIdentidadFiscal(LEGACY), false)
})

test('un número suelto sí se prefija con el punto de venta', () => {
  assert.equal(
    formatearNumeroComprobante({ numero: '45', numero_fiscal: null, punto_venta: '10' }),
    '0010-00000045',
  )
})

test('sin número no se inventa uno', () => {
  const s = formatearNumeroComprobante({ numero: null, numero_fiscal: null, punto_venta: '1' })
  assert.ok(s.startsWith('0001-'))
  assert.ok(!/\d{4}-\d/.test(s), 'no debe aparentar un número real')
})

test('un numero_fiscal con ceros no se toma como identidad', () => {
  // En AFIP el 0 significa "no emitido". Cae al número interno.
  assert.equal(
    formatearNumeroComprobante({ numero: '0001-00000007', numero_fiscal: '0000-00000000', punto_venta: '1' }),
    '0001-00000007',
  )
})

test('padPuntoVenta normaliza a 4 dígitos', () => {
  assert.equal(padPuntoVenta('10'), '0010')
  assert.equal(padPuntoVenta('0001'), '0001')
  assert.equal(padPuntoVenta(null), '0000')
})

// ── 2. Fecha de calendario ──────────────────────────────────────────────────

test('un DATE no retrocede un día', () => {
  assert.equal(formatearFechaCalendario('2026-06-26'), '26/06/2026')
})

test('el timestamp que arma PostgREST para un DATE tampoco retrocede', () => {
  assert.equal(formatearFechaCalendario('2026-06-26T00:00:00+00:00'), '26/06/2026')
  assert.equal(formatearFechaCalendario('2026-06-26 00:00:00+00'), '26/06/2026')
})

test('el borde de mes es el caso que delata el bug', () => {
  // Con new Date(...).toLocaleDateString('es-AR') esto daba 31/07/2026.
  assert.equal(formatearFechaCalendario('2026-08-01'), '01/08/2026')
  assert.equal(formatearFechaCalendario('2026-01-01'), '01/01/2026')
  assert.equal(formatearFechaCalendario('2026-03-01'), '01/03/2026')
})

test('la vía rota efectivamente corría un día — el test valdría poco si no', () => {
  // Ancla el motivo del helper. Si algún día Node/ICU cambiara esto, queremos
  // enterarnos acá y no por un vencimiento fiscal mal impreso.
  const roto = new Date('2026-06-26').toLocaleDateString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Argentina/Buenos_Aires',
  })
  assert.equal(roto, '25/06/2026')
  assert.notEqual(formatearFechaCalendario('2026-06-26'), roto)
})

test('vacío e inválido no imprimen "Invalid Date"', () => {
  for (const v of [null, undefined, '', 'no es fecha', '2026-13-40']) {
    assert.equal(formatearFechaCalendario(v as never), '')
  }
})

// ── 3. Estado y gate de emisión ─────────────────────────────────────────────

test('#45 es fiscalmente emitido aunque comercialmente sea borrador', () => {
  const s = getComprobanteDisplayStatus(C45)
  assert.equal(s.key, 'emitido_arca')
  assert.equal(s.fiscalmenteEmitido, true)
})

test('a un comprobante ya autorizado no se le ofrece emitir ni reintentar', () => {
  const s = getComprobanteDisplayStatus(C45)
  assert.equal(s.permiteEmision, false, 'pedir un segundo CAE para la misma venta')
  assert.equal(s.permiteReintento, false)
  assert.equal(permiteAccionesDeEmision('emitido_arca'), false)
})

test('los estados que sí esperan un reintento no se tocaron', () => {
  assert.equal(permiteAccionesDeEmision('error_arca'), true)
  assert.equal(permiteAccionesDeEmision('cobrado_pendiente_arca'), true)
  assert.equal(permiteAccionesDeEmision('borrador'), true)
  assert.equal(permiteAccionesDeEmision('sin_autorizacion_fiscal'), false)
  assert.equal(permiteAccionesDeEmision('anulado'), false)
})

test('el legacy sigue siendo terminal', () => {
  const s = getComprobanteDisplayStatus(LEGACY)
  assert.equal(s.key, 'sin_autorizacion_fiscal')
  assert.equal(s.fiscalmenteEmitido, false)
  assert.equal(s.permiteEmision, false)
})

// ── 4. Que las superficies vivas lo usen de verdad ──────────────────────────
//
// Un helper correcto que nadie llama no arregla nada: así se coló el bug del
// print layout, que tenía su propia copia del formateador.

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

const SUPERFICIES = [
  ['ComprobanteDocumento',  '../../src/components/comprobantes/ComprobanteDocumento.tsx'],
  ['ComprobantePrintLayout','../../src/components/comprobantes/ComprobantePrintLayout.tsx'],
  ['Comprobante.tsx',       '../../src/pages/Comprobante.tsx'],
] as const

for (const [nombre, ruta] of SUPERFICIES) {
  test(`${nombre} usa el formateador canónico de número`, () => {
    const src = stripComments(read(ruta))
    assert.match(src, /formatearNumeroComprobante\(/,
      `${nombre} debe formatear el número con el helper compartido`)
  })

  test(`${nombre} no conserva una copia propia del formateador roto`, () => {
    const src = stripComments(read(ruta))
    assert.doesNotMatch(src, /function\s+formatNumero\s*\(/,
      `${nombre} tiene su propia copia: es como volvió el bug la vez pasada`)
    assert.doesNotMatch(src, /\.replace\(\/\\D\/g,\s*''\)\.padStart\(8/,
      `${nombre} vuelve a concatenar pv + dígitos del número interno`)
  })
}

test('el vencimiento del CAE no se formatea con new Date en las superficies fiscales', () => {
  for (const [nombre, ruta] of SUPERFICIES) {
    const src = stripComments(read(ruta))
    assert.doesNotMatch(src, /new Date\([^)]*cae_vencimiento[^)]*\)/,
      `${nombre} formatea un DATE como instante y le resta un día`)
  }
})

test('el badge del documento no vuelve a caer al estado comercial', () => {
  const src = stripComments(read('../../src/components/comprobantes/ComprobanteDocumento.tsx'))
  assert.match(src, /CLAVE_VISUAL\s*:\s*Record<DisplayStatusKey/,
    'la traducción debe ser total sobre DisplayStatusKey')
  assert.doesNotMatch(src, /return\s+c\.estado\s*\?\?\s*'borrador'/,
    'el fallback al estado comercial es exactamente lo que mostraba "Borrador" con CAE')
})

test('el sello de la hoja impresa no se decide por el estado comercial', () => {
  const src = stripComments(read('../../src/components/comprobantes/ComprobantePrintLayout.tsx'))
  assert.match(src, /getComprobanteDisplayStatus\(comprobante\)/,
    'el papel debe usar la misma resolución semántica que la pantalla')
  assert.doesNotMatch(src, /comprobante\.estado\s*===\s*'emitido'/,
    'imprimía "● Emitido" en los 53 sin autorización fiscal')
})

test('el panel Información exige CAE para mostrar su vencimiento', () => {
  const src = stripComments(read('../../src/pages/Comprobante.tsx'))
  assert.match(src, /comprobanteActual\.cae\s*&&\s*comprobanteActual\.cae_vencimiento/,
    'sin CAE no hay vencimiento que anunciar')
})
