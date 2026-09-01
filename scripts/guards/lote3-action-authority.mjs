#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'

const rpcPath = 'supabase/migrations/20260908120000_lote3_secdef_action_authority.sql'
const paymentPath = 'supabase/migrations/20260908130000_lote3_payment_transactions_containment.sql'
const rlsPath = 'supabase/migrations/20260908140000_lote3_is_staff_action_policies.sql'
const uiPath = 'src/pages/CustomerDetail.tsx'
const testPath = 'tests/sql/lote3_action_write_authority.test.sql'

const expected = [
  'close_cash_session_atomic','create_comprobante_checkout_atomic',
  'create_credit_note_finance_reversal','create_credit_note_from_comprobante',
  'create_expense_with_finance','create_manual_cash_movement_atomic',
  'create_order_payment_atomic','create_quick_inventory_purchase_atomic',
  'create_supplier_purchase_atomic','customer_purchase_history',
  'delete_comprobante_with_finance','finance_dashboard_summary',
  'finance_health_check','finance_health_check_v2','finance_pending_historicals',
  'generate_finance_insights','get_checkout_request_status',
  'open_cash_session_atomic','pay_supplier_free_atomic',
  'pay_supplier_purchase_atomic','replace_comprobante_payment',
  'reverse_manual_cash_movement','reverse_operating_expense_atomic',
  'reverse_order_payment_atomic','update_inventory_dollar_prices',
]

function inspect({ rpc, payment, rls, ui, tests, later = '' }) {
  const failures = []
  if (!rpc.includes('CREATE OR REPLACE FUNCTION private.require_action_authority')) failures.push('missing canonical internal gate')
  if (!rpc.includes("COALESCE(p.user_id, p.id) = auth.uid()") || !rpc.includes('COALESCE(p.is_active, true)')) failures.push('missing canonical active membership')
  for (const name of expected) if (!rpc.includes(`('${name}'`)) failures.push(`missing RPC mapping: ${name}`)
  const mapped = [...rpc.matchAll(/^\('([a-z0-9_]+)'/gm)].map(m => m[1]).filter(n => expected.includes(n))
  if (new Set(mapped).size !== 25) failures.push(`expected 25 distinct RPC mappings, got ${new Set(mapped).size}`)
  if (!rpc.includes("'customers','orders_view_financials'")) failures.push('customer history must require both capabilities')
  if (!rpc.includes("r.function_name='generate_finance_insights' THEN 'advancedFinance'")) failures.push('finance insights plan entitlement missing')
  if (!rpc.includes("'update_inventory_dollar_prices','uuid, numeric'") || !rpc.includes("'settings_sensitive'")) failures.push('dollar-price authority missing')
  if (!payment.includes('DROP POLICY IF EXISTS pt_write') || !payment.match(/REVOKE INSERT, UPDATE, DELETE[\s\S]*payment_transactions[\s\S]*FROM authenticated/)) failures.push('payment_transactions browser DML not closed')
  if (!payment.includes('GRANT SELECT ON TABLE public.payment_transactions TO authenticated')) failures.push('payment history SELECT contract missing')
  if (/GRANT\s+(?:INSERT|UPDATE|DELETE)[^;]*payment_transactions[^;]*authenticated/i.test(later) || /CREATE\s+POLICY\s+\w+\s+ON\s+public\.payment_transactions(?![\s\S]{0,80}FOR\s+SELECT)/i.test(later)) failures.push('later migration reopens payment_transactions')
  if (/CREATE\s+POLICY[\s\S]*?is_staff\s*\(\s*\)/i.test(rls)) failures.push('candidate write policy still uses is_staff')
  if (!rls.includes("current_user_can('orders_change_status')") || !rls.includes("current_user_can('settings_sensitive')") || !rls.includes("current_user_can('finance')")) failures.push('RLS capability families incomplete')
  if (!rls.includes('DROP POLICY IF EXISTS tenant_isolation ON public.inventory')) failures.push('parallel inventory tenant-only policy not closed')
  if (!ui.includes("can('orders_view_financials')") || !ui.includes("activeTab !== 'compras' || !canViewPurchaseFinancials")) failures.push('CustomerDetail financial-history guard missing')
  if (!tests.includes('pt_write_old_control') || !tests.includes('negative control produces financial_movements') || !tests.includes('exact 25 RPC cases') || !tests.includes('old_sensitive_reads') || !tests.includes('old_tasks_policy')) failures.push('negative-control/25-RPC SQL evidence missing')
  return failures
}

const load = () => {
  const migrations = readdirSync('supabase/migrations').filter(n => n.endsWith('.sql')).sort()
  const later = migrations.filter(n => n > '20260908130000_lote3_payment_transactions_containment.sql')
    .map(n => readFileSync(`supabase/migrations/${n}`,'utf8')).join('\n')
  return {
    rpc: readFileSync(rpcPath,'utf8'), payment: readFileSync(paymentPath,'utf8'),
    rls: readFileSync(rlsPath,'utf8'), ui: readFileSync(uiPath,'utf8'),
    tests: readFileSync(testPath,'utf8'), later,
  }
}

if (process.argv.includes('--self-test')) {
  const source = load()
  const mutations = [
    [{...source,rpc:source.rpc.replace("('close_cash_session_atomic'","('removed_rpc'")},'missing RPC mapping'],
    [{...source,rpc:source.rpc.replace("r.function_name='generate_finance_insights' THEN 'advancedFinance'","r.function_name='removed' THEN 'advancedFinance'")},'plan entitlement'],
    [{...source,payment:source.payment.replace('REVOKE INSERT, UPDATE, DELETE','-- removed revoke')},'browser DML'],
    [{...source,later:source.later+'\nGRANT UPDATE ON public.payment_transactions TO authenticated;'},'reopens'],
    [{...source,rls:source.rls.replace('DROP POLICY IF EXISTS tenant_isolation ON public.inventory','-- bypass retained')},'parallel inventory'],
    [{...source,ui:source.ui.replace("can('orders_view_financials')","can('customers')")},'financial-history guard'],
    [{...source,tests:source.tests.replace('pt_write_old_control','pt_control_removed')},'negative-control'],
  ]
  for (const [mutated,label] of mutations) {
    if (!inspect(mutated).some(f => f.includes(label))) throw new Error(`self-test did not detect ${label}`)
  }
  console.log('Lote 3 authority guard self-test OK: RPC, payment, UI, and negative-control mutations detected')
  process.exit(0)
}

const failures = inspect(load())
if (failures.length) {
  console.error(`Lote 3 authority guard FAIL:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('Lote 3 authority guard OK: 25 gated RPCs, payment browser DML closed, capability RLS and regression evidence present')
