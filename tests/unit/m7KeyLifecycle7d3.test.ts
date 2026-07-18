// ============================================================================
// M7 7D.3 — Lifecycle de las idempotency keys que este lote agregó.
//
// Se testea el COMPORTAMIENTO (resolvePurchaseKey sobre los hashes de intención
// reales), no el texto fuente. Un test que sólo hace grep del archivo pasa
// aunque la lógica esté al revés.
//
// La regla que se prueba en todos los casos:
//   mismo payload  → MISMA key   (un retry es el mismo intento)
//   otro payload   → OTRA key    (es otra operación económica)
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePurchaseKey } from '../../src/utils/purchaseIdempotency.ts'

// Generador determinista: cada llamada devuelve k1, k2, k3… Así se puede
// afirmar "rotó" sin depender de aleatoriedad.
function gen() {
  let n = 0
  return () => `k${++n}`
}

/** Simula un consumidor con refs, como los componentes reales. */
function consumidor() {
  const g = gen()
  let key: string | null = null
  let hash: string | null = null
  return {
    enviar(intent: string) {
      const r = resolvePurchaseKey(key, hash, intent, g)
      key = r.key; hash = r.hash
      return r.key
    },
    exito() { key = null; hash = null },      // éxito terminal
    conflicto() { key = null; hash = null },  // key quemada server-side
    get actual() { return key },
  }
}

// ─── Gasto general (create_expense_with_finance) ─────────────────────────────
// El request_hash server-side cubre: business, amount, currency, category_key,
// caja_id, economic_date, description. El método NO entra — por eso la UI rota
// también por método (superconjunto).
const gasto = (o: Partial<{ amount: string; cat: string; caja: string; fecha: string; desc: string; metodo: string }> = {}) => [
  'operating_expense', 'biz1',
  o.amount ?? '100.00', 'ARS',
  o.cat ?? 'servicios',
  o.caja ?? 'caja1',
  o.fecha ?? '2026-07-18',
  o.desc ?? 'Luz',
  o.metodo ?? 'efectivo',
  'fixed_cost_local', '', 'rec:∅',
].join('§')

test('gasto: doble clic con el mismo payload reusa la MISMA key', () => {
  const c = consumidor()
  assert.equal(c.enviar(gasto()), c.enviar(gasto()))
})

test('gasto: cambiar el importe rota la key', () => {
  const c = consumidor()
  const k1 = c.enviar(gasto())
  assert.notEqual(k1, c.enviar(gasto({ amount: '250.00' })))
})

test('gasto: cambiar el METODO rota la key aunque el server no lo hashee', () => {
  // Este es el caso que justifica el superconjunto. Si la UI NO rotara acá, la
  // misma key + un payload que el server hashea igual devolvería un REPLAY del
  // gasto viejo (con el método anterior) en vez de registrar el nuevo. No sería
  // un conflicto visible: sería una pérdida silenciosa.
  const c = consumidor()
  const k1 = c.enviar(gasto({ metodo: 'efectivo' }))
  assert.notEqual(k1, c.enviar(gasto({ metodo: 'transferencia' })))
})

test('gasto: cambiar fecha, categoría o caja rota la key (todos van al request_hash)', () => {
  for (const patch of [{ fecha: '2026-07-19' }, { cat: 'alquiler' }, { caja: 'caja2' }, { desc: 'Gas' }]) {
    const c = consumidor()
    const k1 = c.enviar(gasto())
    assert.notEqual(k1, c.enviar(gasto(patch)), `${JSON.stringify(patch)} debe rotar la key`)
  }
})

test('gasto: tras éxito, la próxima intención usa una key nueva', () => {
  const c = consumidor()
  const k1 = c.enviar(gasto())
  c.exito()
  assert.notEqual(k1, c.enviar(gasto()))   // mismo payload, pero es otro gasto
})

// ─── Pago a proveedor (pay_supplier_free / pay_supplier_purchase) ────────────
const pago = (o: Partial<{ purchase: string; amount: string; metodo: string; fecha: string; notas: string }> = {}) => [
  o.purchase ? 'supplier_payment' : 'supplier_free_payment',
  'biz1', 'sup1', 'Proveedor SA',
  o.purchase ?? '∅',
  o.amount ?? '500.00', 'ARS', '1.000000',
  o.fecha ?? '2026-07-18',
  o.metodo ?? 'efectivo',
  o.notas ?? '',
].join('§')

test('pago proveedor: doble clic reusa la misma key', () => {
  const c = consumidor()
  assert.equal(c.enviar(pago()), c.enviar(pago()))
})

test('pago proveedor: cambiar la FACTURA destino rota la key', () => {
  // Pagar la factura A y pagar la factura B son dos operaciones económicas
  // distintas aunque coincidan importe, método y fecha.
  const c = consumidor()
  const k1 = c.enviar(pago({ purchase: 'compraA' }))
  assert.notEqual(k1, c.enviar(pago({ purchase: 'compraB' })))
})

test('pago proveedor: pasar de pago libre a pago contra factura rota la key', () => {
  // Son RPC distintas (free vs purchase) con tablas de request distintas:
  // reusar la key entre las dos no tendría ningún sentido.
  const c = consumidor()
  const k1 = c.enviar(pago())
  assert.notEqual(k1, c.enviar(pago({ purchase: 'compraA' })))
})

test('pago proveedor: importe, método, fecha y notas rotan la key', () => {
  for (const patch of [{ amount: '999.00' }, { metodo: 'transferencia' }, { fecha: '2026-07-20' }, { notas: 'x' }]) {
    const c = consumidor()
    const k1 = c.enviar(pago())
    assert.notEqual(k1, c.enviar(pago(patch)), `${JSON.stringify(patch)} debe rotar la key`)
  }
})

test('pago proveedor: tras un CONFLICTO la key se descarta y el retry es una intención nueva', () => {
  const c = consumidor()
  const k1 = c.enviar(pago())
  c.conflicto()
  const k2 = c.enviar(pago())
  assert.notEqual(k1, k2, 'reintentar con la key quemada quedaría en conflicto para siempre')
})

// ─── Anulación de comprobante (annul_comprobante_atomic) ─────────────────────
// request_hash server-side: op, business_id, comprobante_id, mode,
// restore_stock, reason. El MOTIVO entra: por eso tiene que rotar.
const anul = (o: Partial<{ motivo: string; refund: boolean; stock: boolean }> = {}) => [
  'comprobante_annulment', 'biz1', 'comp1',
  o.motivo ?? 'Error de carga',
  (o.refund ?? true) ? 'refund' : 'void',
  (o.stock ?? true) ? 'stock:1' : 'stock:0',
].join('§')

test('anulación: doble clic con el mismo motivo reusa la misma key', () => {
  const c = consumidor()
  assert.equal(c.enviar(anul()), c.enviar(anul()))
})

test('anulación: corregir el MOTIVO rota la key (era el callejón sin salida de 7E.0)', () => {
  // Antes la key se generaba una sola vez al abrir el diálogo. Como el motivo
  // integra el request_hash, corregirlo y reenviar mandaba la misma key con
  // otro payload → IDEMPOTENCY_CONFLICT permanente: el usuario no podía anular
  // sin recargar la página.
  const c = consumidor()
  const k1 = c.enviar(anul({ motivo: 'Error de carga' }))
  assert.notEqual(k1, c.enviar(anul({ motivo: 'Cliente devolvió la mercadería' })))
})

test('anulación: cambiar devolver-dinero o reponer-stock rota la key (definen mode/restore_stock)', () => {
  for (const patch of [{ refund: false }, { stock: false }]) {
    const c = consumidor()
    const k1 = c.enviar(anul())
    assert.notEqual(k1, c.enviar(anul(patch)), `${JSON.stringify(patch)} debe rotar la key`)
  }
})

test('anulación: tras éxito la siguiente anulación arranca con key nueva', () => {
  const c = consumidor()
  const k1 = c.enviar(anul())
  c.exito()
  assert.notEqual(k1, c.enviar(anul()))
})

// ─── Invariante transversal ──────────────────────────────────────────────────
test('INVARIANTE: la key nunca se regenera si el payload no cambió, por más retries que haya', () => {
  const c = consumidor()
  const primera = c.enviar(gasto())
  for (let i = 0; i < 25; i++) {
    assert.equal(c.enviar(gasto()), primera, `retry #${i + 1} generó una key nueva`)
  }
})
