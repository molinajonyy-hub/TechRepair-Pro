/**
 * G2-A · CAMBIO 2 — `remito` se presenta como «Nota de Pedido».
 *
 * El rename es SÓLO de presentación: el dominio de DB
 * (`comprobantes_tipo_check`) sigue siendo remito|factura_a|factura_c|
 * nota_credito y la fiscalidad la sigue decidiendo el TIPO server-side. Este
 * test fija las dos mitades del contrato: que el rótulo cambió y que la clave
 * NO cambió.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPROBANTE_TIPO_LABEL,
  COMPROBANTE_TIPO_LABEL_SHORT,
  COMPROBANTE_TIPO_DOC_LABEL,
  comprobanteTipoLabel,
  comprobanteTipoDocLabel,
} from '../../src/lib/comprobanteTipoLabel.ts'
import { esTipoFiscal } from '../../src/lib/fiscalIdentity.ts'

test('la clave de dominio sigue siendo `remito` — esto NO es un rename de DB', () => {
  assert.ok('remito' in COMPROBANTE_TIPO_LABEL)
  assert.ok(!('nota_pedido' in COMPROBANTE_TIPO_LABEL), 'no se inventó un tipo nuevo')
})

test('`remito` se rotula «Nota de Pedido» en las tres superficies', () => {
  assert.equal(COMPROBANTE_TIPO_LABEL.remito, 'Nota de Pedido')
  assert.equal(COMPROBANTE_TIPO_DOC_LABEL.remito, 'NOTA DE PEDIDO')
  assert.equal(COMPROBANTE_TIPO_LABEL_SHORT.remito, 'NP')
})

test('ningún rótulo de `remito` dice «Remito»', () => {
  for (const mapa of [COMPROBANTE_TIPO_LABEL, COMPROBANTE_TIPO_DOC_LABEL, COMPROBANTE_TIPO_LABEL_SHORT]) {
    assert.doesNotMatch(mapa.remito, /remito/i)
  }
})

test('los demás tipos conservan su rótulo', () => {
  assert.equal(COMPROBANTE_TIPO_LABEL.factura_a, 'Factura A')
  assert.equal(COMPROBANTE_TIPO_LABEL.factura_c, 'Factura C')
  assert.equal(COMPROBANTE_TIPO_LABEL.nota_credito, 'Nota de Crédito')
})

test('el rename NO tocó la semántica fiscal', () => {
  // La Nota de Pedido sigue siendo no fiscal y las facturas siguen siéndolo.
  assert.equal(esTipoFiscal('remito'), false)
  assert.equal(esTipoFiscal('factura_c'), true)
  assert.equal(esTipoFiscal('factura_a'), true)
})

test('los helpers toleran un tipo nulo o desconocido sin romper la pantalla', () => {
  assert.equal(comprobanteTipoLabel(null), 'Comprobante')
  assert.equal(comprobanteTipoLabel('tipo_que_no_existe'), 'Comprobante')
  assert.equal(comprobanteTipoLabel('remito'), 'Nota de Pedido')
  assert.equal(comprobanteTipoDocLabel(undefined), 'COMPROBANTE')
  assert.equal(comprobanteTipoLabel(null, 'Nota de Crédito'), 'Nota de Crédito', 'respeta el fallback del caller')
})
