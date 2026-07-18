// ============================================================================
// M7 7D — Ciclo de vida de las idempotency keys de los flujos M7.
//
// Los consumidores de anulación, reemplazo y reversas pasaron de "una UUID por
// clic" a "una UUID por INTENCIÓN", reutilizando resolvePurchaseKey (el patrón
// ya existente y testeado). Acá se prueba el comportamiento del ciclo de vida
// con el MISMO helper que usan los componentes.
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePurchaseKey } from '../../src/utils/purchaseIdempotency.ts'

/** Reproduce el patrón de los componentes: refs + intent string. */
function crearFlujo(genKey: () => string) {
  let keyRef: string | null = null
  let hashRef: string | null = null
  return {
    intentar(intent: string) {
      const { key } = resolvePurchaseKey(keyRef, hashRef, intent, genKey)
      keyRef = key
      hashRef = intent
      return key
    },
    completar() { keyRef = null; hashRef = null },   // éxito terminal
    cancelar() { keyRef = null; hashRef = null },    // cancelación deliberada
    get key() { return keyRef },
  }
}

let n = 0
const genSecuencial = () => `key-${++n}`
const reset = () => { n = 0 }

// ─── reuse en retry ─────────────────────────────────────────────────────────
test('retry de red con la MISMA intención reutiliza la key', () => {
  reset()
  const f = crearFlujo(genSecuencial)
  const intent = 'annul§biz§comp§se cargó mal'
  const k1 = f.intentar(intent)
  const k2 = f.intentar(intent)   // timeout -> el usuario reintenta
  const k3 = f.intentar(intent)
  assert.equal(k1, 'key-1')
  assert.equal(k2, 'key-1')
  assert.equal(k3, 'key-1')
})

test('doble clic no genera dos operaciones', () => {
  reset()
  const f = crearFlujo(genSecuencial)
  const intent = 'reverse_expense§biz§exp§duplicado'
  assert.equal(f.intentar(intent), f.intentar(intent))
})

// ─── rotación por cambio de intención ───────────────────────────────────────
test('cambiar el motivo ROTA la key: es otra intención económica', () => {
  reset()
  const f = crearFlujo(genSecuencial)
  const k1 = f.intentar('reverse_expense§biz§exp§motivo A')
  const k2 = f.intentar('reverse_expense§biz§exp§motivo B')
  assert.notEqual(k1, k2)
  assert.equal(k2, 'key-2')
})

test('cambiar la entidad ROTA la key', () => {
  reset()
  const f = crearFlujo(genSecuencial)
  const k1 = f.intentar('reverse_order_payment§biz§pago-1§x')
  const k2 = f.intentar('reverse_order_payment§biz§pago-2§x')
  assert.notEqual(k1, k2)
})

test('cambiar de negocio ROTA la key (nunca se cruza entre negocios)', () => {
  reset()
  const f = crearFlujo(genSecuencial)
  const k1 = f.intentar('annul§biz-A§comp§m')
  const k2 = f.intentar('annul§biz-B§comp§m')
  assert.notEqual(k1, k2)
})

// ─── descarte ───────────────────────────────────────────────────────────────
test('tras completar con éxito, la key se descarta: la próxima es nueva', () => {
  reset()
  const f = crearFlujo(genSecuencial)
  const intent = 'annul§biz§comp§m'
  const k1 = f.intentar(intent)
  f.completar()
  assert.equal(f.key, null)
  const k2 = f.intentar(intent)   // misma intención, pero es otra operación
  assert.notEqual(k1, k2)
})

test('al cancelar deliberadamente también se descarta', () => {
  reset()
  const f = crearFlujo(genSecuencial)
  const intent = 'reverse_expense§biz§exp§m'
  const k1 = f.intentar(intent)
  f.cancelar()
  assert.equal(f.key, null)
  assert.notEqual(k1, f.intentar(intent))
})

test('la key no persiste indefinidamente: vive en un ref, no en storage', () => {
  reset()
  const f = crearFlujo(genSecuencial)
  f.intentar('annul§biz§comp§m')
  f.completar()
  assert.equal(f.key, null)   // nada que sobreviva al ciclo de la operación
})

// ─── el helper en sí ────────────────────────────────────────────────────────
test('resolvePurchaseKey: sin key previa siempre genera una', () => {
  reset()
  const { key, hash } = resolvePurchaseKey(null, null, 'intent-x', genSecuencial)
  assert.equal(key, 'key-1')
  assert.equal(hash, 'intent-x')
})

test('resolvePurchaseKey: hash igual conserva, hash distinto rota', () => {
  reset()
  assert.equal(resolvePurchaseKey('vieja', 'h1', 'h1', genSecuencial).key, 'vieja')
  assert.equal(resolvePurchaseKey('vieja', 'h1', 'h2', genSecuencial).key, 'key-1')
})

// ─── las 4 intenciones prioritarias del lote ────────────────────────────────
test('las intenciones de los 4 flujos prioritarios son distinguibles entre sí', () => {
  reset()
  const f = crearFlujo(genSecuencial)
  const intents = [
    'annul§biz§comp§m',                    // annul_comprobante_atomic
    'reverse_expense§biz§exp§m',           // reverse_operating_expense_atomic
    'reverse_order_payment§biz§pago§m',    // reverse_order_payment_atomic
    'replace_payment§biz§comp§efectivo§1000', // replace_comprobante_payment
  ]
  const keys = intents.map(i => f.intentar(i))
  assert.equal(new Set(keys).size, 4, 'cada intención debe tener su propia key')
})
