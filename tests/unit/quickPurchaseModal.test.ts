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

test('idempotency key estable por intento (ref), se limpia en éxito y reset', () => {
  assert.match(modal, /purchaseKeyRef\s*=\s*useRef/)
  assert.match(modal, /if\s*\(!purchaseKeyRef\.current\)\s*purchaseKeyRef\.current\s*=\s*crypto\.randomUUID\(\)/)
  // se limpia en éxito (nueva operación → otra key) y en resetAll
  const clears = modal.match(/purchaseKeyRef\.current\s*=\s*null/g) || []
  assert.ok(clears.length >= 2, 'debe limpiarse en éxito y en resetAll')
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
