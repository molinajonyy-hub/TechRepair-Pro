/**
 * G2-A · CAMBIO 5 — Autoridad para mostrar «autorizado por ARCA».
 *
 * Defecto medido en el discovery (G2-P1-A): `getComprobanteDisplayStatus`
 * clasificaba como `emitido_arca` cualquier comprobante con `estado='emitido'`.
 * Pero `estado` es el estado DOCUMENTAL/COMERCIAL, no el fiscal: el checkout
 * crea toda Nota de Pedido (`tipo='remito'`) con `estado='emitido'` +
 * `estado_fiscal='no_fiscal'`. Resultado: la ficha mostraba escudo verde,
 * «Emitido y válido» y «Autorizado por ARCA» sobre un documento que nunca fue
 * a ARCA y no tiene CAE.
 *
 * Contrato que fija este test: la autorización fiscal SÓLO la prueban `cae` o
 * `estado_fiscal='emitido'`. Nunca `estado`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getComprobanteDisplayStatus,
  esComprobanteNoFiscal,
  permiteAccionesDeEmision,
} from '../../src/utils/comprobanteStatus.ts'

/** Nota de Pedido tal como la crea `create_comprobante_checkout_atomic`. */
const NOTA_DE_PEDIDO = {
  tipo: 'remito',
  estado: 'emitido',
  status: 'issued',
  estado_comercial: 'pagado',
  estado_fiscal: 'no_fiscal',
  es_fiscal: false,
  cae: null,
  numero_fiscal: null,
  total_cobrado: 1000,
} as const

/** Factura C efectivamente autorizada por ARCA. */
const FACTURA_C_CON_CAE = {
  tipo: 'factura_c',
  estado: 'emitido',
  status: 'issued',
  estado_comercial: 'pagado',
  estado_fiscal: 'emitido',
  es_fiscal: true,
  cae: '75123456789012',
  numero_fiscal: '0001-00000001',
  total_cobrado: 1000,
} as const

/** Factura C cobrada, todavía sin CAE. */
const FACTURA_C_PENDIENTE = {
  tipo: 'factura_c',
  estado: 'borrador',
  status: 'draft',
  estado_comercial: 'pagado',
  estado_fiscal: 'pendiente_emision',
  es_fiscal: true,
  cae: null,
  numero_fiscal: null,
  total_cobrado: 1000,
} as const

// ── CASO 1 — Nota de Pedido: nunca ARCA ──────────────────────────────────────

test('CASO 1 · Nota de Pedido emitida y no fiscal NUNCA se presenta como ARCA', () => {
  const s = getComprobanteDisplayStatus(NOTA_DE_PEDIDO)
  assert.equal(s.key, 'no_fiscal')
  assert.equal(s.fiscalmenteEmitido, false, 'un documento sin CAE no está fiscalmente emitido')
  assert.notEqual(s.key, 'emitido_arca')
  assert.doesNotMatch(s.label, /ARCA/i, 'el rótulo no puede nombrar a ARCA')
})

test('CASO 1 · el defecto exacto: `estado=emitido` por sí solo NO prueba autorización fiscal', () => {
  // Esta es la regresión concreta que se está cerrando. Si alguien vuelve a
  // agregar `|| c.estado === 'emitido'` al branch de emitido_arca, esto rompe.
  const soloEstadoEmitido = { estado: 'emitido', estado_fiscal: 'no_fiscal' }
  assert.notEqual(getComprobanteDisplayStatus(soloEstadoEmitido).key, 'emitido_arca')
})

test('CASO 1 · la Nota de Pedido no habilita acciones de emisión', () => {
  // El servidor ya rechaza `remito` + `emitir_en_arca`; ofrecer el botón sería
  // ofrecer algo que sólo puede fallar.
  assert.equal(permiteAccionesDeEmision('no_fiscal'), false)
  assert.equal(getComprobanteDisplayStatus(NOTA_DE_PEDIDO).permiteEmision, false)
})

test('CASO 1 · cada señal de «no fiscal» alcanza por separado', () => {
  assert.equal(esComprobanteNoFiscal({ estado_fiscal: 'no_fiscal' }), true, 'por estado_fiscal')
  assert.equal(esComprobanteNoFiscal({ es_fiscal: false }), true, 'por es_fiscal')
  assert.equal(esComprobanteNoFiscal({ tipo: 'remito' }), true, 'por tipo')
  // Y no dispara sobre un comprobante fiscal legítimo.
  assert.equal(esComprobanteNoFiscal({ tipo: 'factura_c' }), false)
  assert.equal(esComprobanteNoFiscal({}), false, 'sin señales no se asume nada')
})

// ── CASO 2 — Factura C con CAE: sí es ARCA ───────────────────────────────────

test('CASO 2 · Factura C con CAE se presenta como emitida en ARCA', () => {
  const s = getComprobanteDisplayStatus(FACTURA_C_CON_CAE)
  assert.equal(s.key, 'emitido_arca')
  assert.equal(s.fiscalmenteEmitido, true)
})

test('CASO 2 · `estado_fiscal=emitido` sin CAE también cuenta como autorizado', () => {
  // Es la otra evidencia fiscal legítima del modelo: no se puede endurecer al
  // punto de exigir SIEMPRE el CAE, o se rompe la reconciliación.
  const s = getComprobanteDisplayStatus({ ...FACTURA_C_CON_CAE, cae: null })
  assert.equal(s.key, 'emitido_arca')
})

// ── CASO 3 — Factura C pendiente: nunca «autorizado» ─────────────────────────

test('CASO 3 · Factura C pendiente de CAE no se presenta como autorizada', () => {
  const s = getComprobanteDisplayStatus(FACTURA_C_PENDIENTE)
  assert.notEqual(s.key, 'emitido_arca')
  assert.equal(s.fiscalmenteEmitido, false)
  assert.equal(s.key, 'cobrado_pendiente_arca')
  assert.equal(s.permiteEmision, true, 'sí puede reintentarse la emisión')
})

// ── Prioridades que no se pueden invertir ────────────────────────────────────

test('la anulación gana sobre todo lo demás, incluso en una Nota de Pedido', () => {
  const s = getComprobanteDisplayStatus({ ...NOTA_DE_PEDIDO, estado: 'anulado' })
  assert.equal(s.key, 'anulado')
})

test('`sin_autorizacion_fiscal` sigue ganando sobre la inferencia por tipo', () => {
  const s = getComprobanteDisplayStatus({
    tipo: 'factura_c', estado: 'emitido', estado_fiscal: 'sin_autorizacion_fiscal', cae: null,
  })
  assert.equal(s.key, 'sin_autorizacion_fiscal')
  assert.equal(s.fiscalmenteEmitido, false)
})

test('un comprobante fiscal histórico no se degrada a no_fiscal por falta de datos', () => {
  // Sin `tipo` ni `es_fiscal` y con estado_fiscal fiscal: no debe caer en la
  // rama no_fiscal (sería ocultar un documento fiscal real).
  const s = getComprobanteDisplayStatus({ estado: 'emitido', estado_fiscal: 'emitido' })
  assert.equal(s.key, 'emitido_arca')
})
