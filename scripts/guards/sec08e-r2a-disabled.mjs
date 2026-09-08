#!/usr/bin/env node
// SEC-08E R2A rollout guard.
//
// Source mode rejects any executable migration after R2A that can alter the
// client-contract configuration. Runtime mode verifies the resulting database
// state after the complete candidate migration tree has run. The runtime
// postcondition is syntax-independent: renamed files, UPDATE, INSERT/UPSERT,
// DO/EXECUTE, or any other equivalent activation still fail if the final state
// is not exactly disabled/NULL.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'

const migrationDir = 'supabase/migrations'
const r2a = '20260923120000_sec08e_r2a_client_contract_gate_disabled.sql'

function withoutComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
}

export function inspectCandidate(files) {
  const failures = []
  const r2aSql = files.get(r2a)
  if (!r2aSql) return [`missing required R2A migration ${r2a}`]

  const normalized = withoutComments(r2aSql).replace(/\s+/g, ' ').toLowerCase()
  if (!/insert into private\.client_contract_config\s*\(\s*singleton\s*,\s*enforcement_state\s*,\s*minimum_contract\s*\)\s*values\s*\(\s*true\s*,\s*'disabled'\s*,\s*null\s*\)\s*on conflict\s*\(\s*singleton\s*\)\s*do nothing/.test(normalized)) {
    failures.push('R2A does not install the canonical explicit disabled/NULL row')
  }
  if (/insert into private\.client_contract_config[\s\S]*on conflict[\s\S]*do update/.test(normalized)) {
    failures.push('R2A may update an existing config row instead of preserving fail-safe installation')
  }
  if ((normalized.match(/insert into private\.client_contract_config/g) || []).length !== 1) {
    failures.push('R2A must contain exactly one client-contract config insert')
  }
  if (/update private\.client_contract_config/.test(normalized)) {
    failures.push('R2A contains an activation-capable config update')
  }
  if (!/alter role authenticator in database postgres set pgrst\.db_pre_request\s*=\s*'public\.check_client_contract'/.test(normalized)) {
    failures.push('R2A does not install the expected PostgREST pre-request hook')
  }

  for (const [name, sql] of files) {
    if (name <= r2a || !name.endsWith('.sql')) continue
    if (/client_contract_config|check_client_contract|pgrst\.db_pre_request/i.test(withoutComments(sql))) {
      failures.push(`${name} changes client-contract execution after R2A; activation requires a separate reviewed PR`)
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
  if (failures.length) throw new Error(`SEC-08E R2A rollout guard failed:\n- ${failures.join('\n- ')}`)
  console.log('PASS SEC-08E R2A candidate contains no executable activation after explicit disabled/NULL install')
}

function runRuntimeGuard() {
  const container = process.env.SUPABASE_DB_CONTAINER || 'supabase_db_techrepair-vite'
  const query = `
    SELECT jsonb_build_object(
      'rows', count(*),
      'state', min(enforcement_state),
      'minimum', min(minimum_contract),
      'all_disabled', bool_and(enforcement_state = 'disabled' AND minimum_contract IS NULL)
    )::text
    FROM private.client_contract_config;
  `
  const output = execFileSync('docker', ['exec', container, 'psql', '-X', '-U', 'postgres', '-d', 'postgres',
    '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8' }).trim()
  const state = JSON.parse(output)
  assert.deepEqual(state, { rows: 1, state: 'disabled', minimum: null, all_disabled: true },
    `candidate database is not R2A disabled/NULL: ${output}`)

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
  assert.equal(hook, 't', 'candidate database does not have the exact R2A PostgREST hook')
  console.log('PASS SEC-08E R2A runtime state is exactly disabled/NULL with hook installed')
}

function runSelfTest() {
  const base = candidateFiles()
  assert.deepEqual(inspectCandidate(base), [])

  const variants = [
    `UPDATE private.client_contract_config SET enforcement_state = 'enabled', minimum_contract = 1;`,
    `INSERT INTO private.client_contract_config(singleton,enforcement_state,minimum_contract)
       VALUES(true,'enabled',1) ON CONFLICT(singleton) DO UPDATE
       SET enforcement_state=excluded.enforcement_state, minimum_contract=excluded.minimum_contract;`,
    `DO $$ BEGIN EXECUTE 'UPDATE private.client_contract_config SET enforcement_state = ''enabled'', minimum_contract = 1'; END $$;`,
  ]
  for (const sql of variants) {
    const files = new Map(base)
    files.set('20990101000000_renamed_future_migration.sql', sql)
    assert(inspectCandidate(files).length > 0, `guard accepted activation variant: ${sql}`)
  }

  const changedR2a = new Map(base)
  changedR2a.set(r2a, base.get(r2a).replace("VALUES (true, 'disabled', NULL)", "VALUES (true, 'enabled', 1)"))
  assert(inspectCandidate(changedR2a).length > 0, 'guard accepted activation embedded inside R2A')
  const appendedR2a = new Map(base)
  appendedR2a.set(r2a, `${base.get(r2a)}\nUPDATE private.client_contract_config SET enforcement_state='enabled', minimum_contract=1;`)
  assert(inspectCandidate(appendedR2a).length > 0, 'guard accepted an activation update appended inside R2A')
  console.log('PASS SEC-08E R2A rollout guard self-test rejects renamed UPDATE, UPSERT, dynamic activation, R2A default activation, and appended activation')
}

if (process.argv.includes('--self-test')) runSelfTest()
else if (process.argv.includes('--runtime')) runRuntimeGuard()
else runSourceGuard()
