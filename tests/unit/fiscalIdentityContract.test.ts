/**
 * P0 — identidad fiscal del comprobante.
 *
 * Runner: node:test nativo. Ejecutar: npm run test:unit
 *
 * Dos capas (patrón de arcaConfigWriteContract.test.ts):
 *  1) unidad pura de src/lib/comprobanteFiscalIdentity.ts;
 *  2) contrato de FUENTE sobre comprobanteService y las superficies que
 *     presentan número/PV — esos módulos importan Supabase y no cargan bajo
 *     `node --test`.
 *
 * Contexto: el POS persistía en comprobantes.punto_venta el PV LOCAL
 * (sales_points.numero) mientras el CAE se pedía con arca_config.punto_venta.
 * La impresión mostraba el local como si fuera el fiscal, y el CbtesAsoc de una
 * NC caía al local cuando faltaba numero_fiscal.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  parseNumeroFiscal,
  identidadVisible,
  esTipoFiscal,
  padPuntoVenta,
  TIPOS_FISCALES,
} from '../../src/lib/comprobanteFiscalIdentity.ts'

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

// ─── 1. parseNumeroFiscal ───────────────────────────────────────────────────

test('parsea un numero fiscal bien formado', () => {
  const r = parseNumeroFiscal('0003-00000012')
  assert.equal(r?.puntoVenta, '0003')
  assert.equal(r?.numero, '00000012')
  assert.equal(r?.completo, '0003-00000012')
})

test('el PV del numero fiscal es el de AFIP, no el local', () => {
  // El caso adversarial del lote: local 7, fiscal 3.
  assert.equal(parseNumeroFiscal('0003-00000012')?.puntoVenta, '0003')
})

test('devuelve null ante cualquier forma no fiscal', () => {
  for (const v of [null, undefined, '', '   ', 'pendiente', '0003', '-', '0003-',
                   '-00000012', 'abcd-00000012', '0003-00000012-9']) {
    assert.equal(parseNumeroFiscal(v as string | null), null, `deberia rechazar ${JSON.stringify(v)}`)
  }
})

test('un numero o PV en cero NO es identidad fiscal', () => {
  // AFIP numera desde 1: un 0 significa "no emitido", no "comprobante 0".
  assert.equal(parseNumeroFiscal('0000-00000012'), null)
  assert.equal(parseNumeroFiscal('0003-00000000'), null)
})

// ─── 2. esTipoFiscal / padPuntoVenta ────────────────────────────────────────

test('el remito no es fiscal; factura A/C y NC si', () => {
  assert.equal(esTipoFiscal('remito'), false)
  assert.equal(esTipoFiscal('factura_a'), true)
  assert.equal(esTipoFiscal('factura_c'), true)
  assert.equal(esTipoFiscal('nota_credito'), true)
  assert.equal(esTipoFiscal(null), false)
  assert.deepEqual([...TIPOS_FISCALES], ['factura_a', 'factura_c', 'nota_credito'])
})

test('padPuntoVenta normaliza a 4 digitos', () => {
  assert.equal(padPuntoVenta('7'), '0007')
  assert.equal(padPuntoVenta('0007'), '0007')
  assert.equal(padPuntoVenta(null), null)
  assert.equal(padPuntoVenta('abc'), null)
})

// ─── 3. identidadVisible ────────────────────────────────────────────────────

test('fiscal CON numero_fiscal: manda el fiscal', () => {
  const v = identidadVisible({
    tipo: 'factura_c', numero: '0007-00000014',
    numero_fiscal: '0003-00000009', punto_venta: '0007',
  })
  assert.equal(v.texto, '0003-00000009', 'debe mostrarse el numero de AFIP')
  assert.equal(v.puntoVenta, '0003', 'el PV visible es el de AFIP')
  assert.equal(v.esFiscalEmitido, true)
  assert.equal(v.pendienteDeEmision, false)
})

test('fiscal SIN numero_fiscal: no se presenta PV ni se finge emitido', () => {
  const v = identidadVisible({
    tipo: 'factura_c', numero: '0007-00000014',
    numero_fiscal: null, punto_venta: '0007',
  })
  assert.equal(v.esFiscalEmitido, false)
  assert.equal(v.pendienteDeEmision, true, 'la UI debe rotularlo como pendiente')
  assert.equal(v.puntoVenta, null,
    'un fiscal sin CAE no tiene punto de venta que mostrar')
  assert.equal(v.texto, '0007-00000014', 'se muestra el numero interno, rotulado')
})

test('no fiscal: el numero y el PV locales son su identidad legitima', () => {
  const v = identidadVisible({
    tipo: 'remito', numero: '0007-00000015',
    numero_fiscal: null, punto_venta: '0007',
  })
  assert.equal(v.texto, '0007-00000015')
  assert.equal(v.puntoVenta, '0007', 'el remito si muestra su PV local')
  assert.equal(v.esFiscalEmitido, false)
  assert.equal(v.pendienteDeEmision, false, 'un remito no esta pendiente de nada')
})

test('numero_fiscal gana aunque el local sea distinto', () => {
  // Exactamente la divergencia 7 vs 3 que bloqueo el lote.
  const v = identidadVisible({
    tipo: 'factura_c', numero: '0007-00000014',
    numero_fiscal: '0003-00000009', punto_venta: '0007',
  })
  assert.ok(!v.texto.startsWith('0007'), 'no puede mostrarse el PV local como fiscal')
})

// ─── 4. Contrato de fuente: NC sin fallback al PV local ─────────────────────

const servicio = () => stripComments(read('../../src/services/comprobanteService.ts'))

test('el CbtesAsoc de la NC ya no cae al punto_venta local', () => {
  const s = servicio()
  assert.doesNotMatch(s, /parseInt\(\s*original\.punto_venta/,
    'volvio el fallback que mandaba a AFIP el PV local dentro del CbtesAsoc')
  assert.doesNotMatch(s, /nroParts\[0\]\s*\?/,
    'volvio el parseo posicional con fallback de numero_fiscal')
})

test('el CbtesAsoc sale de numero_fiscal parseado con el contrato canonico', () => {
  const s = servicio()
  assert.match(s, /parseNumeroFiscal\(original\.numero_fiscal\)/,
    'el CbtesAsoc debe construirse desde numero_fiscal')
  assert.match(s, /cbteAsocPtoVta\s*=\s*parseInt\(identidadOriginal\.puntoVenta/,
    'el PV del CbtesAsoc sale de la identidad fiscal parseada')
})

test('la NC falla cerrado antes de crear el borrador si el original no tiene CAE', () => {
  const s = servicio()
  assert.match(s, /if \(params\.emitirEnArca\)[\s\S]{0,600}parseNumeroFiscal\(originalPrevio\.numero_fiscal\)/,
    'debe validarse la identidad fiscal ANTES de create_credit_note_from_comprobante')
})

// ─── 5. Contrato de fuente: las superficies muestran numero_fiscal ──────────

const SUPERFICIES = [
  '../../src/components/comprobantes/ComprobantePrintLayout.tsx',
  '../../src/components/comprobantes/ComprobanteDocumento.tsx',
  '../../src/components/comprobantes/ComprobanteHeader.tsx',
  '../../src/components/comprobantes/ComprobantesTable.tsx',
]

test('ninguna superficie arma el numero concatenando el PV local', () => {
  for (const s of SUPERFICIES) {
    const src = stripComments(read(s))
    assert.match(src, /identidadVisible\(/,
      `${s}: debe resolver la identidad con identidadVisible`)
    assert.doesNotMatch(src, /formatNumero\(/,
      `${s}: volvio el helper que concatena el PV local con el numero`)
  }
})

test('el listado ya no prioriza el numero local sobre el fiscal', () => {
  const src = stripComments(read('../../src/components/comprobantes/ComprobantesTable.tsx'))
  assert.doesNotMatch(src, /numero\s*\|\|\s*\w*\.?numero_fiscal/,
    'con `numero || numero_fiscal` el fiscal no se ve nunca: el local jamas es nulo')
})

// ─── 6. Contrato de fuente: el POS no ofrece el PV local en un fiscal ───────

test('el POS muestra el PV fiscal en modo lectura para un tipo fiscal', () => {
  const src = stripComments(read('../../src/components/comprobantes/ComprobanteProModal.tsx'))
  assert.match(src, /tipoEsFiscal\s*\?/,
    'el header debe ramificar por fiscalidad del tipo')
  assert.match(src, /getPuntoVentaFiscal\(/,
    'el PV fiscal se lee por el contrato seguro de ARCA')
  assert.match(src, /data-testid="comprobante-pv-fiscal"/)
  assert.match(src, /data-testid="comprobante-pv-local"/)
})

// ─── 7. La migracion fija el contrato server-side ───────────────────────────

test('la migracion resuelve el PV fiscal desde arca_config y falla cerrado', () => {
  const sql = read('../../supabase/migrations/20260813120000_fiscal_sales_point_canonical_contract.sql')
  assert.match(sql, /SELECT punto_venta INTO v_arca_pv\s*\n?\s*FROM arca_config/,
    'el PV fiscal debe salir de arca_config')
  assert.match(sql, /ARCA_NOT_CONFIGURED/,
    'debe existir el fail-closed explicito')
  assert.match(sql, /v_tipo_es_fiscal := \(v_tipo IN \('factura_a', 'factura_c', 'nota_credito'\)\)/,
    'la fiscalidad se deriva del tipo server-side')
})
