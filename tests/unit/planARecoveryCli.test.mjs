import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename, isAbsolute } from 'node:path'

const run = args => spawnSync(process.execPath, ['scripts/billing/plan-a-recovery.mjs', ...args], {
  encoding: 'utf8', timeout: 15000,
  env: { ...process.env, BETA_MP_RECOVERY_SUPABASE_URL: '', BETA_MP_RECOVERY_SERVICE_ROLE_KEY: '',
    BETA_MP_RECOVERY_ACCESS_TOKEN: '', BETA_MP_RECOVERY_APPLICATION_ID: '', BETA_MP_RECOVERY_COLLECTOR_ID: '' },
})
test('help needs no credentials or network configuration', () => {
  const result = run(['--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /--dry-run\|--execute/)
})
for (const args of [[], ['--execute'], ['--execute', '--dry-run'], ['--dry-run', '--execute-anyway'], ['--dry-run', '--dry-run']]) {
  test(`invalid operation arguments are rejected: ${args.join(' ') || 'empty'}`, () => {
    const result = run(args)
    assert.equal(result.status, 1)
    assert.equal(result.stderr.trim(), 'invalid_arguments')
    assert.equal(result.stdout, '')
  })
}
test('case files inside the repository are never opened as operator manifests', () => {
  const result = run(['--dry-run', '--case-file', join(process.cwd(), 'package.json'), '--receipt-file', join(tmpdir(), 'unused-receipt.json')])
  assert.equal(result.status, 1)
  assert.equal(result.stderr.trim(), 'artifact_must_be_outside_repository')
})
test('unknown identity stops before credentials/network and does not echo native IDs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beta-mp-cli-fixture-'))
  try {
    const identity = { business_id: '11111111-1111-4111-8111-111111111111', session_id: '22222222-2222-4222-8222-222222222222',
      preapproval_id: 'fixture-contract', preapproval_plan_id: 'fixture-plan', invoice_id: '123001', payment_id: '123002' }
    const file = join(dir, 'case.json')
    writeFileSync(file, JSON.stringify(identity))
    const result = run(['--dry-run', '--case-file', file, '--receipt-file', join(dir, 'receipt.json')])
    assert.equal(result.status, 1)
    assert.equal(result.stderr.trim(), 'owner_attested_identity')
    assert.equal(result.stdout, '')
    for (const id of Object.values(identity)) assert(!result.stderr.includes(id))
  } finally {
    assert(isAbsolute(dir) && dirname(resolve(dir)) === resolve(tmpdir()) && basename(dir).startsWith('beta-mp-cli-fixture-'))
    rmSync(dir, { recursive: true, force: true })
  }
})
test('receipt and approval must be independent private files before any credential or provider use', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beta-mp-cli-fixture-'))
  try {
    const file = join(dir, 'case.json'), shared = join(dir, 'combined.json')
    writeFileSync(file, JSON.stringify({ business_id: 'fixture-business', session_id: 'fixture-session', preapproval_id: 'fixture-contract',
      preapproval_plan_id: 'fixture-plan', invoice_id: '123001', payment_id: '123002' }))
    writeFileSync(shared, '{}')
    const result = run(['--execute', '--case-file', file, '--receipt-file', shared, '--approval-file', shared])
    assert.equal(result.status, 1)
    assert.equal(result.stderr.trim(), 'independent_private_artifacts_required')
    assert.equal(result.stdout, '')
  } finally {
    assert(isAbsolute(dir) && dirname(resolve(dir)) === resolve(tmpdir()) && basename(dir).startsWith('beta-mp-cli-fixture-'))
    rmSync(dir, { recursive: true, force: true })
  }
})
