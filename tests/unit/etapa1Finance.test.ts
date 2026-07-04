// ─────────────────────────────────────────────────────────────────────────
// Etapa 1 — Modelo contable canónico: tests estructurales de la migración
// del frontend a las fuentes canónicas. Mismo estilo que arcaEmission.test.ts
// (lee el código fuente y verifica invariantes), sin requerir un stack.
// ─────────────────────────────────────────────────────────────────────────
import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../')
const read = (p: string) => readFileSync(resolve(REPO_ROOT, p), 'utf-8')

test('financialMetricsService consume la RPC canónica finance_dashboard_summary (no suma BFE)', () => {
  const s = read('src/services/financialMetricsService.ts')
  assert.match(s, /supabase\.rpc\('finance_dashboard_summary'/)
  assert.match(s, /profitability/)
  // Ya NO debe descargar todos los BFE del período ni sumar variable_cost en JS
  assert.ok(!/\.from\('business_finance_entries'\)[\s\S]{0,200}\.select\('type, amount_ars'\)/.test(s),
    'no debe seguir bajando todos los BFE para sumar en JS')
})

test('financialMetricsService: sueldosRetiros mapea a employee_salaries (retiros del dueño fuera)', () => {
  const s = read('src/services/financialMetricsService.ts')
  assert.match(s, /sueldosRetiros\s*=\s*num\(p\.employee_salaries\)/)
  assert.match(s, /costosFijosPersonales\s*=\s*0/)
})

test('useFinancialDashboard lee la deuda de proveedores del ledger canónico, no de accounts', () => {
  const s = read('src/hooks/useFinancialDashboard.ts')
  assert.match(s, /from\('v_finance_position'\)/)
  assert.match(s, /payables/)
  // No debe quedar la lectura vieja de accounts type='proveedor' para la deuda
  assert.ok(!/\.eq\('type',\s*'proveedor'\)/.test(s), 'no debe leer accounts type=proveedor para la deuda')
})

test('useInventoryFinance usa la columna correcta inventory_item_id (rotación ya no da 0)', () => {
  const s = read('src/hooks/useInventoryFinance.ts')
  assert.match(s, /select\('inventory_item_id, quantity'\)/)
  assert.match(s, /\.in\('inventory_item_id'/)
  assert.match(s, /\.in\('movement_type'/)
})

test('financeService bloquea retiros/sueldo-dueño/personal como gasto operativo manual (M4)', () => {
  const s = read('src/services/financeService.ts')
  assert.match(s, /isOwnerCapitalEntry/)
  assert.match(s, /OWNER_CAPITAL_BLOCKED/)
  // El catálogo de gasto ya no ofrece sueldo_dueno / retiros / fixed_cost_personal
  assert.ok(!/value:\s*'sueldo_dueno'/.test(s), 'sueldo_dueno no debe estar en el catálogo de gasto')
  assert.ok(!/value:\s*'retiros'/.test(s), 'retiros no debe estar en el catálogo de gasto')
  assert.ok(!/value:\s*'fixed_cost_personal'/.test(s), 'fixed_cost_personal no debe estar en ENTRY_TYPES')
})

test('FinanceDashboard adapta la RPC v2 y muestra el aviso de cambio de cálculo', () => {
  const s = read('src/pages/FinanceDashboard.tsx')
  assert.match(s, /v2\.profitability/)
  assert.match(s, /v_finance_pnl/)
  assert.match(s, /Actualizamos el cálculo financiero/)
  assert.match(s, /finance_calc_notice_v2_dismissed/)
})

test('las migraciones canónicas existen con el orden esperado', () => {
  const files = [
    'supabase/migrations/20260704100000_fix_cost_double_count.sql',
    'supabase/migrations/20260704101000_quick_inventory_purchase.sql',
    'supabase/migrations/20260704110000_owner_capital_flows.sql',
    'supabase/migrations/20260704120000_canonical_views.sql',
    'supabase/migrations/20260704130000_finance_dashboard_v2.sql',
  ]
  for (const f of files) assert.ok(read(f).length > 0, `${f} debe existir y no estar vacío`)
  // v2 devuelve finance_model_version=2 y NO un net_result que mezcle todo
  const rpc = read('supabase/migrations/20260704130000_finance_dashboard_v2.sql')
  assert.match(rpc, /finance_model_version', 2/)
  assert.match(rpc, /'profitability'/)
  assert.match(rpc, /'cashflow'/)
  assert.match(rpc, /'position'/)
})
