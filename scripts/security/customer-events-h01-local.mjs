#!/usr/bin/env node
// Runs only docker-exec against one of two explicitly local Supabase containers.
// Never reads connection strings or hosted credentials. Every test rolls back.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const container = process.env.H01_DB_CONTAINER || 'supabase_db_techrepair-h01'
assert.ok(['supabase_db_techrepair-h01', 'supabase_db_techrepair-vite'].includes(container), 'H01 requires an explicitly local Supabase container')
const suite = readFileSync('tests/sql/tr_b42_h01_customer_events.test.sql', 'utf8')
mkdirSync('.h01-local/sql-results', { recursive: true })
function run(sql) {
  return spawnSync('docker', ['exec', '-i', container, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120_000 })
}
const result = run(suite)
writeFileSync('.h01-local/sql-results/h01.log', `${result.stdout || ''}\n${result.stderr || ''}`)
if (result.status !== 0) {
  process.stderr.write(result.stderr || String(result.error || 'SQL failed'))
  process.exit(1)
}

if (process.argv.includes('--self-test')) {
  const mutations = [
    ['INSERT true under a new name', 'CREATE POLICY h01_bad ON public.customer_events FOR INSERT TO authenticated WITH CHECK (true);'],
    ['implicit FOR ALL', 'CREATE POLICY h01_bad ON public.customer_events USING (true);'],
    ['extra self-only INSERT', 'CREATE POLICY h01_bad ON public.customer_events FOR INSERT TO authenticated WITH CHECK (customer_id IS NOT NULL);'],
    ['anon INSERT privilege', 'GRANT INSERT ON public.customer_events TO anon;'],
    ['anon column INSERT privilege', 'GRANT INSERT (business_id) ON public.customer_events TO anon;'],
    ['authenticated UPDATE privilege', 'GRANT UPDATE ON public.customer_events TO authenticated;'],
    ['RLS disabled', 'ALTER TABLE public.customer_events DISABLE ROW LEVEL SECURITY;'],
  ]
  for (const [name, sql] of mutations) {
    // Injection is inside the suite transaction; psql disconnect rolls back on failure.
    const mutated = suite.replace(/\bBEGIN\s*;/i, `BEGIN;\n${sql}\n`)
    assert.notEqual(mutated, suite, 'test suite must start a rollback transaction')
    const negative = run(mutated)
    assert.equal(negative.error, undefined, 'negative control must reach PostgreSQL')
    assert.notEqual(negative.status, 0, `H01 SQL failed to detect ${name}`)
    assert.match(negative.stderr || '', /H01|customer_events/i, 'must fail in the security assertions')
    console.log(`H01 SQL negative control OK: ${name}`)
  }
}
console.log(`H01 SQL suite OK (${container}); all fixtures and controls rolled back`)

if (process.argv.includes('--related')) {
  for (const path of [
    'tests/sql/g2c1_wholesale_stock_authority.test.sql',
    'tests/sql/prebeta3a2s_wholesale_authority.test.sql',
    'tests/sql/prebeta3a2s_portal_clic_authority.test.sql',
    'tests/sql/prebeta1_public_users_isolation.test.sql',
    'tests/sql/wholesale_portal_public_rpc.test.sql',
    'tests/sql/wholesale_portal_public_read.test.sql',
    'tests/sql/auth_profile_linking.test.sql',
    'tests/sql/permissions_hydration.test.sql',
  ]) {
    const related = run(readFileSync(path, 'utf8'))
    writeFileSync(`.h01-local/sql-results/${path.split('/').pop()}.log`, `${related.stdout || ''}\n${related.stderr || ''}`)
    if (related.status !== 0) process.stderr.write(related.stderr || String(related.error || 'SQL failed'))
    assert.equal(related.status, 0, `related SQL suite failed: ${path}`)
    console.log(`H01 related SQL OK: ${path}`)
  }
}
