import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('private offline signature diagnosis verifies a capture without printing its values', () => {
  const secret = 'offline-synthetic-secret'
  const requestId = 'private-synthetic-request'
  const ts = '1790000000'
  const sig = createHmac('sha256', secret).update(`id:abc123;request-id:${requestId};ts:${ts};`).digest('hex')
  const dir = mkdtempSync(join(tmpdir(), 'mp-offline-test-'))
  const capture = join(dir, 'capture.json')
  const script = fileURLToPath(new URL('../../scripts/billing/verify-mp-signature-local.mjs', import.meta.url))
  try {
    writeFileSync(capture, JSON.stringify({
      url: 'https://private-capture.invalid/?data.id=ABC123&type=subscription_preapproval',
      headers: { 'x-signature': `ts=${ts},v1=${sig}`, 'x-request-id': requestId },
      body: { type: 'subscription_preapproval', data: { id: 'abc123' } },
    }))
    for (const candidate of [secret, 'another-synthetic-secret']) {
      const result = spawnSync(process.execPath, [script, capture], {
        encoding: 'utf8', env: { ...process.env, MP_WEBHOOK_SECRET: candidate },
      })
      assert.equal(result.status, 0)
      const output = JSON.parse(result.stdout)
      assert.equal(output.signature_valid, candidate === secret)
      assert.equal(output.signed_id_matches_body, true)
      assert.equal(output.topic_matches, true)
      for (const privateValue of [secret, candidate, requestId, sig, 'private-capture.invalid']) {
        assert.equal((result.stdout + result.stderr).includes(privateValue), false)
      }
    }
    writeFileSync(capture, '{invalid capture')
    const failed = spawnSync(process.execPath, [script, capture], {
      encoding: 'utf8', env: { ...process.env, MP_WEBHOOK_SECRET: secret },
    })
    assert.equal(failed.status, 1)
    assert.equal(failed.stderr.includes(secret), false)
    assert.equal(failed.stderr.includes(capture), false)
  } finally {
    unlinkSync(capture)
    rmdirSync(dir)
  }
})
