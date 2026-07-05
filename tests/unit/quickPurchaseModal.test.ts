// ─────────────────────────────────────────────────────────────────────────
// Deuda técnica Etapa 1 — ModalCrearGasto usa la RPC atómica de compra rápida.
// Tests estructurales (mismo estilo que arcaEmission.test.ts): verifican que
// el modal hace UNA llamada RPC y ya no realiza escrituras financieras/stock
// directas, con idempotencia estable.
// ─────────────────────────────────────────────────────────────────────────
import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../')
const modal = readFileSync(resolve(REPO_ROOT, 'src/components/expenses/ModalCrearGasto.tsx'), 'utf-8')

test('compra rápida hace UNA sola llamada a create_quick_inventory_purchase_atomic', () => {
  const calls = modal.match(/create_quick_inventory_purchase_atomic/g) || []
  // aparece en el comentario y en la llamada rpc: la llamada real es exactamente una
  const rpcCalls = modal.match(/supabase\.rpc\('create_quick_inventory_purchase_atomic'/g) || []
  assert.strictEqual(rpcCalls.length, 1, 'debe haber exactamente una llamada rpc')
  assert.ok(calls.length >= 1)
})

test('el modal ya NO realiza escrituras directas de stock ni finanzas', () => {
  assert.ok(!/inventoryMovementsService/.test(modal), 'no debe usar inventoryMovementsService')
  assert.ok(!/\.from\('purchases'\)[\s\S]{0,60}\.insert/.test(modal), 'no debe insertar en purchases')
  assert.ok(!/\.from\('purchase_items'\)[\s\S]{0,60}\.insert/.test(modal), 'no debe insertar en purchase_items')
  assert.ok(!/\.from\('business_finance_entries'\)[\s\S]{0,60}\.insert/.test(modal), 'no debe insertar en BFE')
  assert.ok(!/\.from\('expenses'\)[\s\S]{0,60}\.insert/.test(modal), 'no debe insertar en expenses')
  assert.ok(!/\.from\('financial_movements'\)[\s\S]{0,60}\.insert/.test(modal), 'no debe insertar en financial_movements')
  assert.ok(!/\.from\('inventory'\)[\s\S]{0,60}\.update/.test(modal), 'no debe actualizar stock/cost directo')
})

test('idempotency key ligada al payload: ref + hash local determinístico', () => {
  assert.match(modal, /purchaseKeyRef\s*=\s*useRef/)
  assert.match(modal, /payloadHashRef\s*=\s*useRef/)
  // helper de hash local canónico (sólo decide en UI si renovar la key)
  assert.match(modal, /function localPurchaseHash\(/)
  // decisión determinística: renovar key si no hay key O si el payload cambió
  assert.match(modal, /if\s*\(!purchaseKeyRef\.current\s*\|\|\s*payloadHashRef\.current\s*!==\s*localHash\)/)
  assert.match(modal, /payloadHashRef\.current\s*=\s*localHash/)
})

test('retry sin cambios conserva la key; cambio de payload la renueva (Gate 5/6)', () => {
  // La key sólo se regenera cuando el hash local difiere del último intento.
  // Si el payload es idéntico (retry/doble click), la condición es falsa → misma key.
  assert.match(modal, /if\s*\(!purchaseKeyRef\.current\s*\|\|\s*payloadHashRef\.current\s*!==\s*localHash\)\s*\{\s*purchaseKeyRef\.current\s*=\s*crypto\.randomUUID\(\)/)
  // el hash local cubre todos los campos económicos (incluye items + paid)
  assert.match(modal, /localPurchaseHash\(\{[\s\S]{0,400}items:\s*resolved/)
})

test('conflicto de idempotencia: NO muestra éxito, no cierra, prepara nueva operación (Gate 4)', () => {
  assert.match(modal, /result\?\.error === 'IDEMPOTENCY_CONFLICT'/)
  // el bloque de conflicto invalida la key y muestra el mensaje, sin setSubmitSuccess ni handleClose
  const conflictBlock = modal.match(/if \(result\?\.error === 'IDEMPOTENCY_CONFLICT'\) \{[\s\S]*?\n      \}/)?.[0] || ''
  assert.ok(conflictBlock.length > 0, 'debe existir el bloque de conflicto')
  assert.match(conflictBlock, /purchaseKeyRef\.current\s*=\s*null/)
  assert.match(conflictBlock, /setSubmitError\(/)
  assert.ok(!/setSubmitSuccess\(true\)/.test(conflictBlock), 'el conflicto NO debe marcar éxito')
  assert.ok(!/handleClose\(\)/.test(conflictBlock), 'el conflicto NO debe cerrar el modal')
  assert.match(conflictBlock, /return/)
})

test('replay/éxito limpia la key y el hash; reset manual = nueva operación', () => {
  // en éxito (created o replay) se limpian ambas refs → la próxima compra usa otra key
  const successClears = modal.match(/purchaseKeyRef\.current\s*=\s*null[\s\S]{0,80}payloadHashRef\.current\s*=\s*null/g) || []
  assert.ok(successClears.length >= 1, 'éxito debe limpiar key y hash')
  // resetAll limpia la key (form limpio = nueva operación)
  const resetBlock = modal.match(/const resetAll = \(\) => \{[\s\S]*?\n  \}/)?.[0] || ''
  assert.match(resetBlock, /purchaseKeyRef\.current\s*=\s*null/)
})

test('producto creado antes de la RPC se persiste al ítem (no se recrea en retry — Gate 7)', () => {
  // tras createProduct, el inventory_id se guarda en el estado del ítem para que
  // un reintento del mismo formulario no vuelva a crear el producto.
  assert.match(modal, /invId\s*=\s*product\.id/)
  assert.match(modal, /updateItem\(it\._key,\s*\{\s*inventoryId:\s*invId,\s*esNuevo:\s*false\s*\}\)/)
})

test('compra al contado requiere caja abierta y convierte USD con TC explícito', () => {
  assert.match(modal, /useCaja\(\)/)
  assert.match(modal, /!cajaIsOpen/)
  assert.match(modal, /No hay caja abierta/)
  // costo del usuario convertido a ARS con el TC ingresado
  assert.match(modal, /unit_cost_ars:\s*it\.costoUnitario\s*\*\s*rate/)
  assert.match(modal, /currency === 'USD'[\s\S]{0,80}Ingresá el tipo de cambio/)
})

test('envía al contado (paid = total) y muestra errores funcionales, no SQL crudo', () => {
  assert.match(modal, /p_paid_ars:\s*totalARS/)
  assert.match(modal, /friendlyPurchaseError/)
  assert.match(modal, /SQLSTATE\|violates\|null value\|relation\|column\|syntax\|permission denied/)
})

test('éxito invalida las cachés de finanzas y refresca', () => {
  assert.match(modal, /invalidateStatsCache\(\)/)
  assert.match(modal, /invalidateFinancialDashboardCache\(\)/)
  assert.match(modal, /onSuccess\?\.\(\)/)
})
