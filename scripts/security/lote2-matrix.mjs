// Reviewed classifications, joined to live catalog metadata. No regex is used
// to declare an unreviewed reachable function safe: unknown names remain G.
import { readFileSync, writeFileSync } from 'node:fs'
const catalog=JSON.parse(readFileSync('docs/security-lote2/catalog-before.json','utf8'))
const set=s=>new Set(s.split(/\s+/).filter(Boolean))
const fixed=set(`repair_missing_stock_movements preview_missing_stock_movements delete_supplier_purchase_safe backfill_remito_fm check_user_limit_before_invite pay_comprobante_from_account_atomic user_can_allocate_payments user_can_reverse_allocations user_can_view_order_amounts`)
const actionDebt=set(`create_comprobante_checkout_atomic get_checkout_request_status create_credit_note_finance_reversal create_credit_note_from_comprobante delete_comprobante_with_finance customer_purchase_history finance_dashboard_summary finance_health_check finance_health_check_v2 finance_pending_historicals generate_finance_insights create_expense_with_finance create_manual_cash_movement_atomic create_order_payment_atomic create_quick_inventory_purchase_atomic create_supplier_purchase_atomic open_cash_session_atomic close_cash_session_atomic pay_supplier_free_atomic pay_supplier_purchase_atomic replace_comprobante_payment reverse_manual_cash_movement reverse_operating_expense_atomic reverse_order_payment_atomic update_inventory_dollar_prices`)
const actorDerived=set(`current_business_id current_user_business_id current_user_role current_user_can current_platform_admin_role get_my_profile get_my_business_profile get_my_first_steps get_business_settings get_current_exchange_rate is_owner_or_admin business_has_feature get_my_business_onboarding`)
const lifecycle=set(`accept_business_invitation cancel_business_invitation change_user_role create_business_invitation link_profile_to_auth_user provision_my_business set_user_active_status update_my_business_onboarding update_my_business_profile`)
const explicitAuthority=set(`_require_business_member allocate_account_payment_atomic annul_comprobante_atomic claim_comprobante_arca_emission close_period create_order_intake create_owner_contribution create_owner_withdrawal delete_order_device_access_secret ensure_brand_and_model finance_hc_can_see_global generar_numero_comprobante generar_numero_garantia get_allocation_workspace get_arca_config_safe get_business_subscription_features get_customer_unallocated_credit get_or_create_brand get_or_create_model get_order_financial_amounts get_payment_allocations is_platform_admin pay_personal_debt pay_recurring_expense personal_savings_goal_operation personal_update_currency_balance recalcular_totales_comprobante recalculate_product_prices reconcile_ledger_record record_customer_account_adjustment_atomic record_customer_account_payment_atomic register_order_intake_document reopen_period reveal_order_device_access reverse_customer_account_payment_atomic reverse_payment_allocation_atomic save_arca_certificate_legacy save_arca_config_legacy set_arca_estado_conexion set_order_device_access_secret upsert_business_settings upsert_exchange_rate`)
const retired=set(`encrypt_data decrypt_data register_order_payment get_finance_summary`)
const rows=catalog.functions.map(f=>{
 let classification='G',action='INVESTIGATE',guard='Not yet classified'
 const reachable=(f.anon_execute&&f.anon_schema_usage)||(f.authenticated_execute&&f.authenticated_schema_usage)
 if(/^(trigger|event_trigger)$/.test(f.return_type)){classification='D';action='INTERNAL / NO CHANGE';guard='PostgreSQL trigger/event context required; direct RPC unavailable'}
 else if(!reachable){classification=retired.has(f.name)?'F':f.sql_parents.length?'E':'C';action=retired.has(f.name)?'SAFE / NO CHANGE':'INTERNAL / NO CHANGE';guard=f.schema==='private'&&!f.authenticated_schema_usage?'private schema USAGE denied; parent-only/internal': 'No effective anon/authenticated EXECUTE; owner/service as catalogued'}
 else if(fixed.has(f.name)){classification='A';action='FIXED IN LOTE 2';guard=f.name==='pay_comprobante_from_account_atomic'?'Child write guard existed, but privileged document read preceded it':f.name.startsWith('user_can_')?'Arbitrary actor permission probe; every SQL parent passes auth.uid()':'No actor/tenant guard in production definition'}
 else if(actionDebt.has(f.name)){classification='A';action='NEEDS FUTURE LOT';guard='Tenant bound to auth.uid; action capability and/or active canonical membership incomplete — KNOWN LOTE 3 ACTION AUTHORITY'}
 else if(['is_staff','can_manage','user_business_ids'].includes(f.name)){classification='B';action='NEEDS FUTURE LOT';guard='Actor-derived RLS helper, no caller tenant/entity; global membership/action policy is LOTE 3'}
 else if(f.name.startsWith('admin_')){classification='B';action='SAFE / NO CHANGE';guard='_require_platform_admin action-specific role before privileged operation'}
 else if(actorDerived.has(f.name)){classification='B';action='SAFE / NO CHANGE';guard='Actor-derived identity/tenant; no arbitrary tenant parameter; read/predicate projection'}
 else if(lifecycle.has(f.name)){classification='B';action='SAFE / NO CHANGE';guard='Authenticated canonical identity, role/owner or confirmed invitation-email contract'}
 else if(explicitAuthority.has(f.name)){classification='B';action='SAFE / NO CHANGE';guard='Explicit actor/tenant/resource + existing role/capability or personal ownership guard; see source migration'}
 else if(f.name.startsWith('get_wholesale_portal_')){classification='B';action='SAFE / NO CHANGE';guard='Intentional public slug projection; enabled portal contract, no privileged tenant action'}
 if(/personal|subscription|create_owner_(contribution|withdrawal)/.test(f.name)&&!fixed.has(f.name))action='OUT OF SCOPE'
 const callers=[...f.callers.filter(c=>c.file.startsWith('src/')||c.file.startsWith('supabase/functions/')).map(c=>`${c.file}:${c.lines[0]}`),...f.sql_parents.map(p=>p.signature),...(f.triggers||[]).map(t=>`${t.table}.${t.name}`)]
 return {...f,classification,action,guard,caller_summary:callers.join('; ')||'No runtime caller found; see migration/test/script occurrences in catalog',caller_controlled:/\b(?:\w*_id|\w*_ids|tenant|organization|company|branch)\b/.test(f.identity_arguments)}
})
const summary={}
for(const r of rows)summary[r.classification]=(summary[r.classification]||0)+1
writeFileSync('docs/security-lote2/exploitability-matrix.md',`# Lote 2 — complete production SECURITY DEFINER matrix

Measured ${catalog.captured_at}. ${rows.length} functions; classification totals: ${JSON.stringify(summary)}.
Counts of ACL EXECUTE include trigger returns and private-schema functions; they are not counts of exploitable RPCs.
Every row links logically to the full exact-signature metadata, effective grants, source migration history, hash and callers in catalog-before.json.

A with NEEDS FUTURE LOT means tenant binding exists but action/active-membership debt belongs to the explicitly excluded Lote 3; it is NOT certified safe. B reflects the existing explicit contract, not a global RBAC certification. C/E/F are cleared as direct human RPC findings, not as proofs that every upstream write is safe. D does not clear the payment_transactions forged-income route.

| Function | SECDEF | User EXECUTE | Caller-controlled tenant/entity | Guard | Caller | Classification | Action |
| --- | ---: | --- | ---: | --- | --- | --- | --- |
${rows.map(f=>`| \`${f.schema}.${f.signature.replace(/^private\./,'')}\` | yes | ${f.anon_execute?'anon ':''}${f.authenticated_execute?'authenticated':''}${!f.anon_execute&&!f.authenticated_execute?'none':''}${!f.authenticated_schema_usage?' (no schema USAGE)':''} | ${f.caller_controlled?'yes':'no'} | ${f.guard} | ${f.caller_summary.replaceAll('|','/')} | ${f.classification} | ${f.action} |`).join('\n')}

## Migration provenance

| Exact function signature | Latest source definition migration |
| --- | --- |
${rows.map(f=>`| \`${f.schema}.${f.signature.replace(/^private\./,'')}\` | ${f.source_migration||'No matching repository definition — catalog is authority'} |`).join('\n')}
`)
console.log(JSON.stringify(summary))
for(const r of rows.filter(r=>r.classification==='G'))console.log('INVESTIGATE',r.signature)
if(rows.some(r=>r.classification==='G'))process.exitCode=1
