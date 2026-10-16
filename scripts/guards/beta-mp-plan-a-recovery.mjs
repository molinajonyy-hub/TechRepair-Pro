/** Structural tripwires for the single historical exception; behavioral/SQL tests remain authoritative. */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const root = 'supabase/functions/_shared/billing'
const migration = 'supabase/migrations/20261016130620_beta_mp_plan_a_paid_case_recovery.sql'
const read = path => readFileSync(path, 'utf8')
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '')
function inspect(sql, core, cli) {
  const failures = []
  const require = (condition, name) => { if (!condition) failures.push(name) }
  require(/SECURITY INVOKER/i.test(sql) && !/SECURITY DEFINER/i.test(code(sql)), 'invoker_only')
  require(/current_user <> 'service_role'/.test(sql), 'server_role_required')
  require(/FROM PUBLIC, anon, authenticated/i.test(sql) && /TO service_role/i.test(sql), 'private_execute_acl')
  require(/cf128e8c4ec6fa425e002286f4db8c9df5d6b884abdf138c50b21bcddfff6c7a/.test(sql), 'one_case_allowlist')
  require(/PLAN_A_HISTORICAL_APPLICATION_VERIFIED = false/.test(core), 'unresolved_application_gate_closed')
  require(/RAISE EXCEPTION 'plan_a_recovery_historical_application_unresolved'/.test(sql), 'database_application_gate_closed')
  require(/LOCK TABLE public\.subscription_checkout_sessions, public\.payments, public\.subscription_events\s+IN SHARE ROW EXCLUSIVE MODE NOWAIT/i.test(sql), 'absence_checks_locked')
  require((sql.match(/FOR UPDATE NOWAIT/g) ?? []).length >= 2, 'exact_row_locks')
  require(!/\bDELETE\s+FROM|\bUPDATE\s+public\.payments/i.test(code(sql)), 'ledger_no_repair_or_delete')
  require(/p_ledger->>'status' IS DISTINCT FROM 'approved'/.test(sql), 'approved_payment_required')
  require(/p_expected_business/.test(sql) && /p_expected_session/.test(sql) && /snapshot_changed/.test(sql), 'snapshot_cas_required')
  require(/applyPreapprovalEvidence\(shadow\.ctx/.test(core) && /readOnlyMpClient\(deps\.mp\)/.test(core), 'canonical_shadow_only')
  require(!/\.store\.(?:upsertPayment|updateBusinessBilling|updateCheckoutSession)\(/.test(core), 'no_real_store_mutations')
  require(/fresh\.evidenceDigest === receipt\.evidenceDigest/.test(core) && /independent_execution_approval_required/.test(core), 'fresh_receipt_and_approval')
  require(/method !== 'GET'/.test(cli) && /global: \{ fetch: getOnly \}/.test(cli), 'readonly_transport')
  require(/writer\.rpc\('recover_plan_a_paid_case'/.test(cli) && !/\.from\([^)]*\)\.(?:update|insert|upsert|delete)\(/.test(cli), 'atomic_rpc_only')
  require(!/dotenv|Deno\.env|\.env\.local/.test(code(cli).replace(/\/\*[\s\S]*?\*\//g, '')), 'no_implicit_credentials')
  return failures
}
const sql = read(migration), core = read(`${root}/planARecovery.ts`), cli = read('scripts/billing/plan-a-recovery.mjs')
if (process.argv.includes('--self-test')) {
  for (const [source, find, replace, expected] of [
    ['sql', 'SECURITY INVOKER', 'SECURITY DEFINER', 'invoker_only'],
    ['sql', "current_user <> 'service_role'", 'false', 'server_role_required'],
    ['sql', 'IN SHARE ROW EXCLUSIVE MODE NOWAIT', 'IN ACCESS SHARE MODE', 'absence_checks_locked'],
    ['sql', "p_ledger->>'status' IS DISTINCT FROM 'approved'", 'false', 'approved_payment_required'],
    ['core', 'fresh.evidenceDigest === receipt.evidenceDigest', 'true', 'fresh_receipt_and_approval'],
    ['core', 'PLAN_A_HISTORICAL_APPLICATION_VERIFIED = false', 'PLAN_A_HISTORICAL_APPLICATION_VERIFIED = true', 'unresolved_application_gate_closed'],
    ['sql', "RAISE EXCEPTION 'plan_a_recovery_historical_application_unresolved'", 'NULL', 'database_application_gate_closed'],
    ['cli', "method !== 'GET'", 'false', 'readonly_transport'],
  ]) {
    const sources = { sql, core, cli }; sources[source] = sources[source].replace(find, replace)
    assert(inspect(sources.sql, sources.core, sources.cli).includes(expected), `self-test ${expected}`)
  }
  console.log('Plan A recovery guard: 8 negative controls passed')
} else {
  const failures = inspect(sql, core, cli)
  const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)])
  for (const path of [...files('src'), ...files('supabase/functions')]) {
    if (!/\.(ts|tsx)$/.test(path) || path.replaceAll('\\', '/') === `${root}/planARecovery.ts`) continue
    if (/from\s+['"][^'"]*planARecovery(?:\.ts)?['"]/.test(read(path))) failures.push('exception_imported_by_application')
  }
  assert.deepEqual(failures, [], failures.join(', '))
  console.log('Plan A recovery guard: operator-only, pinned identity, canonical shadow, atomic server commit')
}
