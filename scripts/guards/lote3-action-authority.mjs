#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'

const rpcPath = 'supabase/migrations/20260908120000_lote3_secdef_action_authority.sql'
const paymentPath = 'supabase/migrations/20260908130000_lote3_payment_transactions_containment.sql'
const rlsPath = 'supabase/migrations/20260908140000_lote3_is_staff_action_policies.sql'
const reworkPath = 'supabase/migrations/20260909120000_lote3_phase_b_direct_write_rework.sql'
const uiPath = 'src/pages/CustomerDetail.tsx'
const servicePath = 'src/services/comprobanteService.ts'
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

function inspect({ rpc, payment, rls, rework, ui, service, tests, afterRework = '' }) {
  const failures = []
  const predicate = rework.match(/CREATE OR REPLACE FUNCTION private\.has_action_authority[\s\S]*?\$function\$;/)?.[0] || ''
  const compatibilityGate = rework.match(/CREATE OR REPLACE FUNCTION private\.require_action_authority[\s\S]*?\$function\$;/)?.[0] || ''
  if (!rpc.includes('CREATE OR REPLACE FUNCTION private.require_action_authority')) failures.push('missing canonical internal gate')
  for (const name of expected) if (!rpc.includes(`('${name}'`)) failures.push(`missing RPC mapping: ${name}`)
  const mapped = [...rpc.matchAll(/^\('([a-z0-9_]+)'/gm)].map(m => m[1]).filter(n => expected.includes(n))
  if (new Set(mapped).size !== 25) failures.push(`expected 25 distinct RPC mappings, got ${new Set(mapped).size}`)
  if (!rpc.includes("'customers','orders_view_financials'")) failures.push('customer history must require both capabilities')
  if (!rpc.includes("r.function_name='generate_finance_insights' THEN 'advancedFinance'")) failures.push('finance insights plan entitlement missing')
  if (!rpc.includes("'update_inventory_dollar_prices','uuid, numeric'") || !rpc.includes("'settings_sensitive'")) failures.push('dollar-price authority missing')

  if (!payment.includes('DROP POLICY IF EXISTS pt_write') || !payment.match(/REVOKE INSERT, UPDATE, DELETE[\s\S]*payment_transactions[\s\S]*FROM authenticated/)) failures.push('Phase A payment transaction DML containment missing')
  if (/CREATE\s+POLICY[\s\S]*?is_staff\s*\(\s*\)/i.test(rls)) failures.push('candidate write policy still uses is_staff')
  if (!rls.includes("current_user_can('orders_change_status')") || !rls.includes("current_user_can('settings_sensitive')") || !rls.includes("current_user_can('finance')")) failures.push('RLS capability families incomplete')
  if (!rls.includes('DROP POLICY IF EXISTS tenant_isolation ON public.inventory')) failures.push('parallel inventory tenant-only policy not closed')
  if (!ui.includes("can('orders_view_financials')") || !ui.includes("activeTab !== 'compras' || !canViewPurchaseFinancials")) failures.push('CustomerDetail financial-history guard missing')

  if (!predicate.includes("current_setting('role', true) = 'service_role'") || /auth\.role\(\)\s*=\s*'service_role'/.test(predicate)) failures.push('service bypass is not bound to effective PostgreSQL role')
  if (!predicate.match(/SELECT p\.business_id, p\.is_active[\s\S]*FROM public\.get_my_profile\(\) p/) || !predicate.includes('v_actor_active IS NOT TRUE')) failures.push('canonical identity resolver missing from action gate')
  if (!compatibilityGate.includes('private.has_action_authority')) failures.push('compatibility gate is not wired to canonical predicate')
  if (!rework.match(/finance_pending_historicals[\s\S]*get_my_profile\(\)[\s\S]*NOT IN \('owner','admin'\)/)) failures.push('pending historicals owner/admin role contract missing')
  if (!rework.match(/REVOKE DELETE ON TABLE public\.supplier_purchases FROM authenticated/) || !rework.match(/REVOKE DELETE ON TABLE public\.supplier_purchase_items FROM authenticated/)) failures.push('supplier direct DELETE grants not closed')
  if (!rework.includes('DROP POLICY IF EXISTS rls_supplier_purchases') || !rework.includes('DROP POLICY IF EXISTS rls_supplier_purchase_items') || /CREATE POLICY[^;]+(?:supplier_purchases|supplier_purchase_items)[^;]+FOR DELETE/is.test(rework)) failures.push('supplier DELETE policy path remains')
  if (!rework.includes('REVOKE UPDATE ON TABLE public.comprobantes FROM authenticated') || !rework.includes('GRANT UPDATE (observaciones, updated_at) ON TABLE public.comprobantes TO authenticated')) failures.push('comprobantes exact safe column allowlist missing')
  if (!rework.includes('CREATE OR REPLACE FUNCTION public.issue_remito_atomic') || !rework.includes("private.has_action_authority(p_business_id, 'comprobantes'")) failures.push('canonical remito transition missing')
  if (!rework.includes('DROP POLICY IF EXISTS cp_insert ON public.comprobante_payments') || !rework.match(/REVOKE INSERT, UPDATE, DELETE ON TABLE public\.comprobante_payments FROM authenticated/)) failures.push('direct comprobante payment writes not closed')
  if (!rework.includes('DROP POLICY IF EXISTS pt_select ON public.payment_transactions') || !rework.match(/REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public\.payment_transactions FROM authenticated/)) failures.push('payment transaction browser surface not fully closed')

  if (!service.includes("supabase.rpc('issue_remito_atomic'") || /\.from\(['"]comprobantes['"]\)[\s\S]{0,300}\.update\(\{[\s\S]{0,160}(?:estado_fiscal|status\s*:|estado\s*:)/.test(service)) failures.push('remito client still owns canonical state transition')
  if (/\.from\(['"]comprobante_payments['"]\)[\s\S]{0,300}\.insert\s*\(/.test(service)) failures.push('client direct comprobante payment INSERT remains')

  const evidenceMarkers=['pt_write_old_control','before_old_supplier_delete','before_old_comprobante_update','before_old_cp_insert','call_with_claim','anonymous execute revoked','protected comprobantes UPDATE ZERO EFFECTS','canonical supplier safe delete succeeds','canonical payment produces reconciled comprobante state','canonical duplicate/legacy profile selects newest business B','comprobantes exact safe UPDATE column allowlist']
  for (const marker of evidenceMarkers) if (!tests.includes(marker)) failures.push(`missing Phase B SQL evidence: ${marker}`)

  if (/GRANT\s+DELETE[^;]*(?:supplier_purchases|supplier_purchase_items)[^;]*authenticated/i.test(afterRework)) failures.push('later migration reopens supplier DELETE')
  if (/GRANT\s+UPDATE\s+ON[^;]*comprobantes[^;]*authenticated/i.test(afterRework)) failures.push('later migration reopens comprobantes table UPDATE')
  if (/GRANT\s+(?:INSERT|UPDATE|DELETE)[^;]*comprobante_payments[^;]*authenticated/i.test(afterRework)) failures.push('later migration reopens direct comprobante payments')
  if (/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[^;]*payment_transactions[^;]*authenticated/i.test(afterRework)) failures.push('later migration reopens payment transactions')
  return failures
}

const load = () => {
  const migrations = readdirSync('supabase/migrations').filter(n => n.endsWith('.sql')).sort()
  const afterRework = migrations.filter(n => n > reworkPath.split('/').at(-1))
    .map(n => readFileSync(`supabase/migrations/${n}`,'utf8')).join('\n')
  return {
    rpc:readFileSync(rpcPath,'utf8'), payment:readFileSync(paymentPath,'utf8'),
    rls:readFileSync(rlsPath,'utf8'), rework:readFileSync(reworkPath,'utf8'),
    ui:readFileSync(uiPath,'utf8'), service:readFileSync(servicePath,'utf8'),
    tests:readFileSync(testPath,'utf8'), afterRework,
  }
}

if (process.argv.includes('--self-test')) {
  const source=load()
  const mutations=[
    [{...source,rpc:source.rpc.replace("('close_cash_session_atomic'","('removed_rpc'")},'missing RPC mapping'],
    [{...source,rpc:source.rpc.replace("r.function_name='generate_finance_insights' THEN 'advancedFinance'","r.function_name='removed' THEN 'advancedFinance'")},'plan entitlement'],
    [{...source,rework:source.rework.replace("current_setting('role', true) = 'service_role'","auth.role() = 'service_role'")},'effective PostgreSQL role'],
    [{...source,rework:source.rework.replace('FROM public.get_my_profile() p','FROM public.profiles p')},'canonical identity'],
    [{...source,rework:source.rework.replace("NOT IN ('owner','admin')","NOT IN ('owner','admin','manager')")},'owner/admin'],
    [{...source,rework:source.rework.replace('REVOKE DELETE ON TABLE public.supplier_purchases FROM authenticated','-- removed supplier revoke')},'supplier direct DELETE'],
    [{...source,rework:source.rework.replace('GRANT UPDATE (observaciones, updated_at) ON TABLE public.comprobantes TO authenticated','GRANT UPDATE ON TABLE public.comprobantes TO authenticated')},'safe column allowlist'],
    [{...source,rework:source.rework.replace('DROP POLICY IF EXISTS cp_insert ON public.comprobante_payments','-- insert policy retained')},'comprobante payment writes'],
    [{...source,rework:source.rework.replace('DROP POLICY IF EXISTS pt_select ON public.payment_transactions','-- select policy retained')},'payment transaction browser'],
    [{...source,service:source.service.replace("supabase.rpc('issue_remito_atomic'","supabase.rpc('removed_remito_rpc'")},'remito client'],
    [{...source,service:source.service+"\nawait supabase.from('comprobante_payments').insert({ amount: 1 })"},'client direct comprobante'],
    [{...source,tests:source.tests.replace('canonical duplicate/legacy profile selects newest business B','canonical identity evidence removed')},'Phase B SQL evidence'],
    [{...source,afterRework:source.afterRework+'\nGRANT SELECT ON public.payment_transactions TO authenticated;'},'reopens payment transactions'],
  ]
  for (const [mutated,label] of mutations) if (!inspect(mutated).some(f=>f.includes(label))) throw new Error(`self-test did not detect ${label}`)
  console.log(`Lote 3 authority guard self-test OK: ${mutations.length} authority mutations detected`)
  process.exit(0)
}

const failures=inspect(load())
if (failures.length) {
  console.error(`Lote 3 authority guard FAIL:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('Lote 3 authority guard OK: 25 gated RPCs; Phase B direct supplier/comprobante/payment paths closed; canonical identity, effective service role and regression evidence present')
