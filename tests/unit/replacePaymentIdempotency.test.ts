// ============================================================================
// M7 7D.1 — Lifecycle de la idempotency key de replace_comprobante_payment.
//
// El boundary de la intención es el modal "Editar cobro" de Comprobante.tsx:
// "reemplazar el cobro de ESTE comprobante por ESTE". Acá se reproduce ese
// lifecycle con el MISMO helper que usa el componente (resolvePurchaseKey) y se
// prueba el comportamiento, no el texto fuente.
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePurchaseKey } from '../../src/utils/purchaseIdempotency.ts'

interface PayloadReemplazo {
  comprobanteId: string
  method: string
  amount: number
  amountArs: number
  currency: string
  rate: number
  provider: string | null
  commission: number
  notes: string
}

/** Mismo string de intención que arma handleSaveEditPago. */
function intentDe(p: PayloadReemplazo): string {
  return [
    'replace_payment', p.comprobanteId, p.method,
    p.amount.toFixed(2), p.amountArs.toFixed(2), p.currency, p.rate.toFixed(6),
    p.provider ?? '∅', p.commission.toFixed(2), p.notes.trim(),
  ].join('§')
}

/** Reproduce el modal: refs + lifecycle por resultado terminal. */
function crearModal(genKey: () => string) {
  let keyRef: string | null = null
  let hashRef: string | null = null
  const descartar = () => { keyRef = null; hashRef = null }
  return {
    abrir: descartar,          // openEditPago: una edición nueva descarta la anterior
    cancelar: descartar,       // closeEditPago
    guardar(p: PayloadReemplazo) {
      const intent = intentDe(p)
      const { key } = resolvePurchaseKey(keyRef, hashRef, intent, genKey)
      keyRef = key
      hashRef = intent
      return key
    },
    exito: descartar,
    paymentSetChanged: descartar,   // la key quedó stale server-side
    conflicto() { /* NO se rota ni se reintenta solo: lo revisa el usuario */ },
    errorDeRed() { /* incierto: se CONSERVA la key */ },
    errorDeValidacion() { /* se conserva; rota sola si el usuario corrige */ },
    get key() { return keyRef },
  }
}

const base: PayloadReemplazo = {
  comprobanteId: 'comp-1', method: 'efectivo', amount: 1000, amountArs: 1000,
  currency: 'ARS', rate: 1, provider: null, commission: 0, notes: 'nota',
}

let n = 0
const gen = () => `key-${++n}`
const reset = () => { n = 0 }

// ─── reuse ──────────────────────────────────────────────────────────────────
test('doble clic con el mismo payload reutiliza la key', () => {
  reset()
  const m = crearModal(gen)
  assert.equal(m.guardar(base), m.guardar(base))
})

test('error de red: la key se CONSERVA y el retry manda la misma', () => {
  reset()
  const m = crearModal(gen)
  const k1 = m.guardar(base)
  m.errorDeRed()                       // no se sabe si el server lo aplicó
  const k2 = m.guardar(base)           // el usuario reintenta igual
  assert.equal(k1, k2, 'un retry incierto debe permitir replay, no una segunda operación')
})

test('error de validación: se conserva mientras el payload no cambie', () => {
  reset()
  const m = crearModal(gen)
  const k1 = m.guardar(base)
  m.errorDeValidacion()
  assert.equal(m.guardar(base), k1)
})

// ─── rotación por cada campo económico ──────────────────────────────────────
const camposQueRotan: [string, Partial<PayloadReemplazo>][] = [
  ['comprobante', { comprobanteId: 'comp-2' }],
  ['método',      { method: 'transferencia' }],
  ['monto',       { amount: 1500, amountArs: 1500 }],
  ['amount_ars',  { amountArs: 1200 }],
  ['moneda',      { currency: 'USD' }],
  ['tipo de cambio', { rate: 1050 }],
  ['provider',    { provider: 'mercadopago' }],
  ['comisión',    { commission: 35 }],
  ['notas',       { notes: 'otra nota' }],
]

for (const [campo, cambio] of camposQueRotan) {
  test(`cambiar ${campo} ROTA la key: es otra intención económica`, () => {
    reset()
    const m = crearModal(gen)
    const k1 = m.guardar(base)
    const k2 = m.guardar({ ...base, ...cambio })
    assert.notEqual(k1, k2, `${campo} debe invalidar la intención`)
  })
}

test('corregir el payload tras un fallo rota la key', () => {
  reset()
  const m = crearModal(gen)
  const k1 = m.guardar(base)
  m.errorDeValidacion()
  const k2 = m.guardar({ ...base, amount: 999, amountArs: 999 })
  assert.notEqual(k1, k2)
})

// ─── resultados terminales ──────────────────────────────────────────────────
test('éxito: la key se limpia; la próxima edición usa una nueva', () => {
  reset()
  const m = crearModal(gen)
  const k1 = m.guardar(base)
  m.exito()
  assert.equal(m.key, null)
  m.abrir()
  assert.notEqual(m.guardar(base), k1)
})

test('PAYMENT_SET_CHANGED: descarta la key stale y exige intención nueva', () => {
  reset()
  const m = crearModal(gen)
  const k1 = m.guardar(base)
  m.paymentSetChanged()
  assert.equal(m.key, null, 'reintentar una key stale devolvería PAYMENT_SET_CHANGED para siempre')
  const k2 = m.guardar(base)
  assert.notEqual(k1, k2, 'el nuevo intento debe llevar otra key')
})

test('IDEMPOTENCY_CONFLICT: NO rota la key automáticamente', () => {
  reset()
  const m = crearModal(gen)
  const k1 = m.guardar(base)
  m.conflicto()
  assert.equal(m.key, k1, 'no se genera otra key ni se reintenta solo: lo revisa el usuario')
})

test('cancelar deliberadamente descarta la intención', () => {
  reset()
  const m = crearModal(gen)
  const k1 = m.guardar(base)
  m.cancelar()
  assert.equal(m.key, null)
  assert.notEqual(m.guardar(base), k1)
})

test('reabrir tras un resultado terminal NO reutiliza la key vieja', () => {
  reset()
  const m = crearModal(gen)
  const k1 = m.guardar(base)
  m.exito()
  m.abrir()                            // openEditPago descarta explícitamente
  assert.equal(m.key, null)
  assert.notEqual(m.guardar(base), k1)
})

test('abrir el modal para OTRO comprobante nunca reusa la key', () => {
  reset()
  const m = crearModal(gen)
  const k1 = m.guardar(base)
  m.abrir()
  const k2 = m.guardar({ ...base, comprobanteId: 'comp-2' })
  assert.notEqual(k1, k2)
})

// ─── el intent en sí ────────────────────────────────────────────────────────
test('el intent incluye los 9 campos económicos del contrato', () => {
  const partes = intentDe(base).split('§')
  assert.equal(partes.length, 10, 'prefijo + 9 campos')
  assert.equal(partes[0], 'replace_payment')
})

test('notas con espacios de más no cuentan como cambio económico', () => {
  reset()
  const m = crearModal(gen)
  const k1 = m.guardar(base)
  const k2 = m.guardar({ ...base, notes: '  nota  ' })
  assert.equal(k1, k2, 'el trim evita rotar la key por espacios accidentales')
})
