#!/usr/bin/env node
// SEC-08E R2B activation guard.
//
// Source mode permits exactly one reviewed transition after R2A: the canonical
// R2B migration from disabled/NULL to enabled/1. Runtime mode verifies the
// resulting state without depending on the migration's spelling.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'

const migrationDir = 'supabase/migrations'
const r2a = '20260923120000_sec08e_r2a_client_contract_gate_disabled.sql'
const retiredR2b = '20260923121000_sec08e_r2b_client_contract_gate_minimum_1.sql'
const r2b = '20260924120000_sec08e_r2b_client_contract_gate_minimum_1.sql'

function withoutComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
}

function normalize(sql) {
  return withoutComments(sql).replace(/\s+/g, ' ').trim().toLowerCase()
}

export function inspectCandidate(files) {
  const failures = []
  const r2aSql = files.get(r2a)
  const r2bSql = files.get(r2b)

  if (!r2aSql) failures.push(`missing required R2A migration ${r2a}`)
  if (!r2bSql) failures.push(`missing required R2B migration ${r2b}`)
  if (files.has(retiredR2b)) failures.push(`retired R2B timestamp must remain absent: ${retiredR2b}`)

  if (r2aSql) {
    const sql = normalize(r2aSql)
    if (!/values\s*\(\s*true\s*,\s*'disabled'\s*,\s*null\s*\)\s*on conflict\s*\(\s*singleton\s*\)\s*do nothing/.test(sql)) {
      failures.push('R2A no longer installs the canonical disabled/NULL state')
    }
    if (/update private\.client_contract_config/.test(sql)) {
      failures.push('R2A contains an activation-capable update')
    }
    if (!/alter role authenticator in database postgres set pgrst\.db_pre_request\s*=\s*'public\.check_client_contract'/.test(sql)) {
      failures.push('R2A no longer installs the canonical PostgREST hook')
    }
  }

  if (r2bSql) {
    const sql = normalize(r2bSql)
    if (!sql.startsWith('begin;') || !sql.endsWith('commit;')) {
      failures.push('R2B must be enclosed by BEGIN/COMMIT')
    }
    if ((sql.match(/select enforcement_state\s*,\s*minimum_contract/g) || []).length !== 1
        || !/from private\.client_contract_config where singleton is true for update/.test(sql)) {
      failures.push('R2B must lock the singleton configuration row with SELECT FOR UPDATE')
    }
    if (!/if not found or v_state <> 'disabled' or v_minimum is not null then raise exception/.test(sql)) {
      failures.push('R2B must require the exact disabled/NULL precondition')
    }
    if ((sql.match(/update private\.client_contract_config/g) || []).length !== 1
        || !/update private\.client_contract_config set enforcement_state = 'enabled', minimum_contract = 1, updated_at = now\(\) where singleton is true/.test(sql)) {
      failures.push('R2B must perform exactly one canonical enabled/1 transition')
    }
    if (!/get diagnostics v_rows = row_count; if v_rows <> 1 then raise exception/.test(sql)) {
      failures.push('R2B must verify that exactly one row changed')
    }
    if (/\b(?:create|alter|drop|truncate|grant|revoke|insert|delete|execute)\b/.test(sql)) {
      failures.push('R2B contains operations outside the configuration transition')
    }
    if (/check_client_contract|pgrst\.db_pre_request/.test(sql)) {
      failures.push('R2B must not replace the gate function or hook')
    }
  }

  for (const [name, source] of files) {
    if (name <= r2a || name === r2b || !name.endsWith('.sql')) continue
    if (/client_contract_config|check_client_contract|pgrst\.db_pre_request/i.test(withoutComments(source))) {
      failures.push(`${name} changes client-contract execution outside canonical R2B`)
    }
  }
  return failures
}

function candidateFiles() {
  return new Map(readdirSync(migrationDir).sort()
    .filter(name => name >= r2a && name.endsWith('.sql'))
    .map(name => [name, readFileSync(`${migrationDir}/${name}`, 'utf8')]))
}

function runSourceGuard() {
  const failures = inspectCandidate(candidateFiles())
  if (failures.length) throw new Error(`SEC-08E R2B activation guard failed:\n- ${failures.join('\n- ')}`)
  console.log('PASS SEC-08E R2B candidate contains exactly one locked disabled/NULL to enabled/1 transition')
}

function runRuntimeGuard() {
  const container = process.env.SUPABASE_DB_CONTAINER || 'supabase_db_techrepair-vite'
  const stateOutput = execFileSync('docker', ['exec', container, 'psql', '-X', '-U', 'postgres', '-d', 'postgres',
    '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', `
      SELECT jsonb_build_object(
        'rows', count(*),
        'state', min(enforcement_state),
        'minimum', min(minimum_contract),
        'all_enabled_one', bool_and(enforcement_state = 'enabled' AND minimum_contract = 1)
      )::text
      FROM private.client_contract_config;
    `], { encoding: 'utf8' }).trim()
  const state = JSON.parse(stateOutput)
  assert.deepEqual(state, { rows: 1, state: 'enabled', minimum: 1, all_enabled_one: true },
    `candidate database is not R2B enabled/1: ${stateOutput}`)

  const hook = execFileSync('docker', ['exec', container, 'psql', '-X', '-U', 'postgres', '-d', 'postgres',
    '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', `
      SELECT count(*) = 1
        AND min(split_part(setting, '=', 2)) = 'public.check_client_contract'
      FROM pg_db_role_setting s
      JOIN pg_database d ON d.oid = s.setdatabase
      JOIN pg_roles r ON r.oid = s.setrole
      CROSS JOIN LATERAL unnest(s.setconfig) setting
      WHERE d.datname = 'postgres' AND r.rolname = 'authenticator'
        AND setting LIKE 'pgrst.db_pre_request=%';
    `], { encoding: 'utf8' }).trim()
  assert.equal(hook, 't', 'candidate database does not retain the canonical PostgREST hook')
  console.log('PASS SEC-08E R2B runtime state is exactly enabled/1 with the existing hook')
}

function runSelfTest() {
  const base = candidateFiles()
  assert.deepEqual(inspectCandidate(base), [])

  const variants = [
    source => source.replace('FOR UPDATE;', ';'),
    source => source.replace("v_state <> 'disabled'", "v_state <> 'enabled'"),
    source => source.replace('minimum_contract = 1', 'minimum_contract = 2'),
    source => source.replace('GET DIAGNOSTICS v_rows = ROW_COUNT;', ''),
  ]
  for (const mutate of variants) {
    const files = new Map(base)
    files.set(r2b, mutate(base.get(r2b)))
    assert(inspectCandidate(files).length > 0, 'guard accepted an unsafe R2B variant')
  }

  const missing = new Map(base)
  missing.delete(r2b)
  assert(inspectCandidate(missing).length > 0, 'guard accepted a missing R2B migration')

  const retired = new Map(base)
  retired.set(retiredR2b, base.get(r2b))
  assert(inspectCandidate(retired).length > 0, 'guard accepted the retired R2B timestamp')

  const extra = new Map(base)
  extra.set('20990101000000_unreviewed_activation.sql', "UPDATE private.client_contract_config SET minimum_contract = 2;")
  assert(inspectCandidate(extra).length > 0, 'guard accepted an additional client-contract mutation')

  console.log('PASS SEC-08E R2B guard self-test rejects unlocked, wrong-state, wrong-minimum, unchecked, missing, retired, and additional transitions')
}

if (process.argv.includes('--self-test')) runSelfTest()
else if (process.argv.includes('--runtime')) runRuntimeGuard()
else runSourceGuard()
