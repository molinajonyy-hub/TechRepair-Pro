/**
 * Contrato fiscal del POS: identidad canónica, presentación y punto de venta.
 *
 * Runner: node:test nativo. Ejecutar: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import {
  esTipoFiscal,
  fiscalIdentity,
  parseNumeroFiscal,
  TIPOS_FISCALES,
} from '../../src/lib/fiscalIdentity.ts'
import {
  formatearNumeroComprobante,
  muestraIdentidadFiscal,
  muestraNumeroInternoFiscal,
  padPuntoVenta,
  puntoVentaVisibleComprobante,
} from '../../src/lib/fiscalDisplay.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf-8')

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

test('parseNumeroFiscal devuelve los dos componentes canónicos', () => {
  assert.deepEqual(parseNumeroFiscal('0003-00000012'), { puntoVenta: 3, numero: 12 })
  assert.equal(parseNumeroFiscal('0003-00000012')?.puntoVenta, 3,
    'el PV fiscal no puede caer al PV local del POS')
})

test('parseNumeroFiscal falla cerrado ante formatos o ceros no fiscales', () => {
  for (const v of [null, undefined, '', '   ', 'pendiente', '0003', '-', '0003-',
                   '-00000012', 'abcd-00000012', '0003-00000012-9',
                   '0000-00000012', '0003-00000000']) {
    assert.equal(parseNumeroFiscal(v as string | null), null,
      `debería rechazar ${JSON.stringify(v)}`)
  }
})

test('la fiscalidad del tipo proviene del contrato canónico', () => {
  assert.deepEqual([...TIPOS_FISCALES], ['factura_a', 'factura_c', 'nota_credito'])
  assert.equal(esTipoFiscal('factura_a'), true)
  assert.equal(esTipoFiscal('factura_c'), true)
  assert.equal(esTipoFiscal('nota_credito'), true)
  assert.equal(esTipoFiscal('remito'), false)
})

test('fiscal emitido: numero_fiscal prevalece sobre número y PV locales', () => {
  const comprobante = {
    tipo: 'factura_c', numero: '0007-00000014',
    numero_fiscal: '0003-00000009', punto_venta: '0007',
  }
  assert.equal(formatearNumeroComprobante(comprobante), '0003-00000009')
  assert.equal(muestraIdentidadFiscal(comprobante), true)
  assert.equal(puntoVentaVisibleComprobante(comprobante), '0003')
  assert.equal(muestraNumeroInternoFiscal(comprobante), false)
})

test('fiscal interno: conserva su número pero no adquiere identidad fiscal', () => {
  const comprobante = {
    tipo: 'factura_c', numero: '0007-00000014',
    numero_fiscal: null, punto_venta: '0007',
  }
  assert.equal(formatearNumeroComprobante(comprobante), '0007-00000014')
  assert.equal(muestraIdentidadFiscal(comprobante), false)
  assert.equal(puntoVentaVisibleComprobante(comprobante), null)
  assert.equal(muestraNumeroInternoFiscal(comprobante), true)
  assert.equal(fiscalIdentity(comprobante), null)
})

test('remito: el número y el PV locales siguen siendo válidos para display', () => {
  const comprobante = {
    tipo: 'remito', numero: '0007-00000015',
    numero_fiscal: null, punto_venta: '0007',
  }
  assert.equal(formatearNumeroComprobante(comprobante), '0007-00000015')
  assert.equal(padPuntoVenta(comprobante.punto_venta), '0007')
  assert.equal(puntoVentaVisibleComprobante(comprobante), '0007')
  assert.equal(muestraNumeroInternoFiscal(comprobante), false)
  assert.equal(esTipoFiscal(comprobante.tipo), false)
})

test('Factura C #1 y NC C #1 conservan identidades distintas', () => {
  const factura = fiscalIdentity({
    tipo: 'factura_c', numero_fiscal: '0010-00000001', tipo_comprobante_fiscal: 11,
  })
  const nota = fiscalIdentity({
    tipo: 'nota_credito', numero_fiscal: '0010-00000001', tipo_comprobante_fiscal: 13,
  })
  assert.deepEqual(factura, { puntoVenta: 10, cbteTipo: 11, numero: 1 })
  assert.deepEqual(nota, { puntoVenta: 10, cbteTipo: 13, numero: 1 })
  assert.notDeepEqual(factura, nota)
})

test('una NC sin tipo_comprobante_fiscal no obtiene identidad inventada', () => {
  assert.equal(fiscalIdentity({
    tipo: 'nota_credito', numero_fiscal: '0010-00000001',
  }), null)
})

const servicio = () => stripComments(read('../../src/services/comprobanteService.ts'))

test('CbtesAsoc usa la terna canónica y nunca el punto de venta local', () => {
  const src = servicio()
  assert.match(src, /fiscalIdentity\(original\)/)
  assert.match(src, /cbte_asoc_tipo:\s*identidadOriginalNotaCredito\.cbteTipo/)
  assert.match(src, /cbte_asoc_pto_vta:\s*identidadOriginalNotaCredito\.puntoVenta/)
  assert.match(src, /cbte_asoc_nro:\s*identidadOriginalNotaCredito\.numero/)
  assert.doesNotMatch(src, /parseInt\(\s*original\.punto_venta/)
  assert.doesNotMatch(src, /tipo_comprobante_fiscal\s*\?\?\s*11/)
})

test('la identidad completa se valida antes de crear el borrador de NC', () => {
  const src = servicio()
  const identidad = src.indexOf('fiscalIdentity(original)')
  const rpc = src.indexOf("'create_credit_note_from_comprobante'")
  assert.ok(identidad >= 0, 'falta la validación de FiscalIdentity')
  assert.ok(rpc >= 0, 'no se encontró la RPC de creación de NC')
  assert.ok(identidad < rpc, 'la validación debe ocurrir antes de crear el borrador')
})

const SUPERFICIES = [
  '../../src/components/comprobantes/ComprobantePrintLayout.tsx',
  '../../src/components/comprobantes/ComprobanteDocumento.tsx',
  '../../src/components/comprobantes/ComprobanteHeader.tsx',
  '../../src/components/comprobantes/ComprobantesTable.tsx',
  '../../src/pages/Comprobante.tsx',
]

test('todas las superficies reutilizan el formateador fiscal de main', () => {
  for (const ruta of SUPERFICIES) {
    const src = stripComments(read(ruta))
    assert.match(src, /formatearNumeroComprobante\(/,
      `${ruta}: debe usar el formateador canónico`)
    assert.doesNotMatch(src, /identidadVisible\(/,
      `${ruta}: volvió el helper fiscal duplicado del PR`)
    assert.doesNotMatch(src, /formatNumero\(/,
      `${ruta}: volvió la concatenación local de PV + número`)
  }
})

test('el helper fiscal duplicado fue eliminado', () => {
  assert.equal(
    existsSync(new URL('../../src/lib/comprobanteFiscalIdentity.ts', import.meta.url)),
    false,
  )
})

test('el listado prioriza y permite buscar numero_fiscal', () => {
  const src = stripComments(read('../../src/components/comprobantes/ComprobantesTable.tsx'))
  assert.match(src, /getValue:\s*\(c\)\s*=>\s*c\.numero_fiscal/)
  assert.doesNotMatch(src, /numero\s*\|\|\s*\w*\.?numero_fiscal/)
})

test('las superficies reutilizan el resolvedor canónico del PV visible', () => {
  for (const ruta of [
    '../../src/components/comprobantes/ComprobanteHeader.tsx',
    '../../src/components/comprobantes/ComprobantePrintLayout.tsx',
    '../../src/pages/Comprobante.tsx',
  ]) {
    const src = stripComments(read(ruta))
    assert.match(src, /puntoVentaVisibleComprobante\(/,
      `${ruta}: el PV visible debe usar el contrato compartido`)
    assert.doesNotMatch(src, /parseNumeroFiscal\(/,
      `${ruta}: no debe volver a resolver localmente el PV fiscal`)
  }
})

test('el POS muestra PV fiscal read-only y reserva el local al remito', () => {
  const src = stripComments(read('../../src/components/comprobantes/ComprobanteProModal.tsx'))
  assert.match(src, /tipoEsFiscal\s*=\s*esTipoFiscal\(tipo\)/)
  assert.match(src, /getPuntoVentaFiscal\(/)
  assert.match(src, /data-testid="comprobante-pv-fiscal"/)
  assert.match(src, /data-testid="comprobante-pv-local"/)
  assert.doesNotMatch(src, /TIPO_CONFIG\[tipo\]\.fiscal/)
})

test('la migración nueva resuelve el PV fiscal server-side y falla cerrado', () => {
  const sql = read('../../supabase/migrations/20260814150000_fiscal_sales_point_canonical_contract.sql')
  assert.match(sql, /SELECT punto_venta INTO v_arca_pv\s*\n?\s*FROM arca_config/)
  assert.match(sql, /ARCA_NOT_CONFIGURED/)
  assert.match(sql, /v_tipo_es_fiscal := \(v_tipo IN \('factura_a', 'factura_c'\)\)/)
  assert.match(sql, /IF v_tipo = 'nota_credito' THEN[\s\S]*CREDIT_NOTE_REQUIRES_ORIGINAL/)
})
