// Tests de COMPORTAMIENTO real (no de texto fuente) de la lógica de idempotency
// key local usada por NewExpenseModal (flujo activo de compras).
import { test } from 'node:test'
import assert from 'node:assert'
import { purchasePayloadHash, resolvePurchaseKey, type PurchaseHashInput } from '../../src/utils/purchaseIdempotency.ts'

const base: PurchaseHashInput = {
  businessId: 'biz-1', supplierId: 'sup-1', supplierName: 'Prov', invoice: 'FC-1',
  date: '2026-06-20', paymentMethod: 'efectivo', totalArs: 5000, paidArs: 5000,
  items: [
    { inventory_id: 'inv-1', product_name: 'A', quantity: 2, unit_cost: 1000 },
    { inventory_id: 'inv-2', product_name: 'B', quantity: 3, unit_cost: 1000 },
  ],
}

test('mismo payload → mismo hash (determinístico)', () => {
  assert.strictEqual(purchasePayloadHash(base), purchasePayloadHash({ ...base }))
})

test('orden de ítems irrelevante → mismo hash', () => {
  const reordered = { ...base, items: [base.items[1], base.items[0]] }
  assert.strictEqual(purchasePayloadHash(base), purchasePayloadHash(reordered))
})

test('cada campo económico cambia el hash', () => {
  const h = purchasePayloadHash(base)
  assert.notStrictEqual(h, purchasePayloadHash({ ...base, totalArs: 5001 }), 'total')
  assert.notStrictEqual(h, purchasePayloadHash({ ...base, paidArs: 4000 }), 'paid')
  assert.notStrictEqual(h, purchasePayloadHash({ ...base, supplierId: 'sup-2' }), 'supplier')
  assert.notStrictEqual(h, purchasePayloadHash({ ...base, paymentMethod: 'transferencia' }), 'metodo')
  assert.notStrictEqual(h, purchasePayloadHash({ ...base, date: '2026-06-21' }), 'fecha')
  assert.notStrictEqual(h, purchasePayloadHash({ ...base, invoice: 'FC-2' }), 'invoice')
  assert.notStrictEqual(h, purchasePayloadHash({ ...base, items: [{ ...base.items[0], quantity: 9 }, base.items[1]] }), 'cantidad')
  assert.notStrictEqual(h, purchasePayloadHash({ ...base, items: [{ ...base.items[0], unit_cost: 1200 }, base.items[1]] }), 'costo')
})

test('redondeo: 1000 y 1000.004 colisionan (money 2 decimales); 1000 y 1000.01 no', () => {
  const a = purchasePayloadHash({ ...base, totalArs: 1000 })
  assert.strictEqual(a, purchasePayloadHash({ ...base, totalArs: 1000.004 }))
  assert.notStrictEqual(a, purchasePayloadHash({ ...base, totalArs: 1000.01 }))
})

test('resolvePurchaseKey: sin key previa → key nueva', () => {
  let calls = 0
  const r = resolvePurchaseKey(null, null, 'h1', () => `k${++calls}`)
  assert.strictEqual(r.key, 'k1')
  assert.strictEqual(r.hash, 'h1')
  assert.strictEqual(calls, 1)
})

test('resolvePurchaseKey: mismo hash → conserva la key (retry / doble click)', () => {
  let calls = 0
  const r = resolvePurchaseKey('existing-key', 'h1', 'h1', () => `k${++calls}`)
  assert.strictEqual(r.key, 'existing-key')
  assert.strictEqual(calls, 0, 'no debe generar key nueva')
})

test('resolvePurchaseKey: hash distinto → renueva la key (cambió el payload)', () => {
  let calls = 0
  const r = resolvePurchaseKey('existing-key', 'h1', 'h2', () => `new-${++calls}`)
  assert.strictEqual(r.key, 'new-1')
  assert.strictEqual(r.hash, 'h2')
  assert.strictEqual(calls, 1)
})

test('flujo doble-click: dos resoluciones con el mismo payload dan la MISMA key', () => {
  const gen = () => 'random-uuid-once'
  const h = purchasePayloadHash(base)
  const first = resolvePurchaseKey(null, null, h, gen)
  // segundo submit idéntico, reusando el estado del primero
  const second = resolvePurchaseKey(first.key, first.hash, purchasePayloadHash(base), () => 'random-uuid-two')
  assert.strictEqual(second.key, first.key, 'doble click con payload idéntico conserva la key')
})
