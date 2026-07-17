/**
 * isComprobanteAnnulled — señal canónica de anulación que gobierna las
 * afordancias de cobro/anulación en la UI (EstadoCobroWidget, botón Anular,
 * estado mostrado, clasificación borrador/emitido).
 *
 * Contrato: hace match EXACTO contra los literales canónicos que escribe
 * `annul_comprobante_atomic` (estado='anulado', status='cancelled',
 * estado_comercial='anulado') más `estado_fiscal='anulado_fiscal'`. No
 * normaliza mayúsculas ni espacios: los valores en DB son minúsculas
 * canónicas (enum/CHECK + literales de la RPC), así que normalizar solo
 * enmascararía datos corruptos.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isComprobanteAnnulled } from '../../src/utils/comprobanteStatus.ts'

// Base "vigente": ninguna señal de anulación activa. Sirve para probar que
// cada señal positiva gana por sí sola, sin depender del orden de evaluación.
const VIGENTE = {
  estado: 'emitido',
  status: 'issued',
  estado_comercial: 'pagado',
  estado_fiscal: 'emitido',
} as const

test('positivo: cada señal de anulación gana por separado (independiente del orden)', () => {
  assert.equal(isComprobanteAnnulled({ ...VIGENTE, estado: 'anulado' }), true)
  assert.equal(isComprobanteAnnulled({ ...VIGENTE, estado: 'cancelled' }), true)
  assert.equal(isComprobanteAnnulled({ ...VIGENTE, status: 'cancelled' }), true)
  assert.equal(isComprobanteAnnulled({ ...VIGENTE, estado_comercial: 'anulado' }), true)
  assert.equal(isComprobanteAnnulled({ ...VIGENTE, estado_fiscal: 'anulado_fiscal' }), true)
})

test('positivo: señal aislada (resto ausente) también gana', () => {
  assert.equal(isComprobanteAnnulled({ estado: 'anulado' }), true)
  assert.equal(isComprobanteAnnulled({ estado: 'cancelled' }), true)
  assert.equal(isComprobanteAnnulled({ status: 'cancelled' }), true)
  assert.equal(isComprobanteAnnulled({ estado_comercial: 'anulado' }), true)
  assert.equal(isComprobanteAnnulled({ estado_fiscal: 'anulado_fiscal' }), true)
})

test('negativo: comprobante vigente / borrador / vacío no está anulado', () => {
  assert.equal(isComprobanteAnnulled(VIGENTE), false)
  assert.equal(isComprobanteAnnulled({ estado: 'borrador' }), false)
  assert.equal(isComprobanteAnnulled({ estado: 'emitido' }), false)
  assert.equal(isComprobanteAnnulled({}), false)
})

test('negativo: null / undefined no rompen y devuelven false', () => {
  assert.equal(isComprobanteAnnulled(null), false)
  assert.equal(isComprobanteAnnulled(undefined), false)
})

test('negativo: campos null explícitos no cuentan como anulación', () => {
  assert.equal(
    isComprobanteAnnulled({ estado: null, status: null, estado_comercial: null, estado_fiscal: null }),
    false,
  )
})

test('mixto: cualquier señal de anulación gana aunque estado siga vigente', () => {
  assert.equal(isComprobanteAnnulled({ estado: 'emitido', status: 'cancelled' }), true)
  assert.equal(isComprobanteAnnulled({ estado: 'emitido', estado_comercial: 'anulado' }), true)
  assert.equal(isComprobanteAnnulled({ estado: 'emitido', estado_fiscal: 'anulado_fiscal' }), true)
  assert.equal(isComprobanteAnnulled({ estado: 'borrador', status: 'cancelled' }), true)
})

test('contrato: match exacto — no normaliza mayúsculas ni espacios', () => {
  assert.equal(isComprobanteAnnulled({ estado: 'ANULADO' }), false)
  assert.equal(isComprobanteAnnulled({ estado: ' anulado ' }), false)
  assert.equal(isComprobanteAnnulled({ status: 'CANCELLED' }), false)
  assert.equal(isComprobanteAnnulled({ estado_fiscal: 'Anulado_Fiscal' }), false)
})
