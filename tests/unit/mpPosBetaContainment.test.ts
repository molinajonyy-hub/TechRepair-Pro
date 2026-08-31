import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mpPosBetaDisabled } from '../../supabase/functions/_shared/mpPosBetaDisabled.ts'

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const body = { success: false, error: 'FEATURE_NOT_AVAILABLE' }

test('both real entrypoints register only the data-free fail-closed handler', async () => {
  const registered: unknown[] = []
  let environmentReads = 0
  Object.defineProperty(globalThis, 'Deno', { configurable: true, value: {
    serve: (handler: unknown) => registered.push(handler),
    env: { get: () => { environmentReads++; throw new Error('No secrets allowed') } },
  } })
  try {
    await import('../../supabase/functions/mp-oauth/index.ts')
    await import('../../supabase/functions/mp-payments/index.ts')
    assert.deepEqual(registered, [mpPosBetaDisabled, mpPosBetaDisabled])
    assert.equal(environmentReads, 0)
  } finally { Reflect.deleteProperty(globalThis, 'Deno') }
})

test('all caller identities/actions/callbacks fail before parsing, DB access or outbound requests', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Outbound request forbidden (DB and Mercado Pago)')
  })
  const identities = ['', 'owner', 'admin', 'foreign-tenant', 'known-business-uuid']
  const actions = ['connect', 'status', 'refresh', 'disconnect', 'callback', 'create_qr',
    'create_point', 'create_checkout', 'create_manual', 'lookup', 'refund', 'sync_report', 'webhook', 'unknown']
  const states = ['forged-state', btoa(JSON.stringify({ business_id: '00000000-0000-4000-8000-000000000001', ts: 1 }))]
  for (const identity of identities) for (const action of actions) for (const state of states) {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      const payload = { action, code: 'valid-looking-old-code', state, business_id: '00000000-0000-4000-8000-000000000001' }
      const req = new Request(`https://edge.invalid/mp-oauth?${new URLSearchParams(payload)}`, {
        method,
        headers: { ...(identity ? { authorization: `Bearer ${identity}` } : {}), 'x-signature': 'ts=1,v1=forged' },
        ...(['GET', 'HEAD'].includes(method) ? {} : { body: JSON.stringify(payload) }),
      })
      const response = mpPosBetaDisabled(req)
      assert.equal(response.status, 410)
      assert.deepEqual(await response.json(), body)
      assert.equal(req.bodyUsed, false)
      assert.equal(response.headers.get('location'), null)
    }
  }
  for (const malformed of ['{', '', 'not-json']) {
    assert.equal(mpPosBetaDisabled(new Request('https://edge.invalid', { method: 'POST', body: malformed })).status, 410)
  }
  assert.equal(fetchMock.mock.callCount(), 0, 'zero DB reads/writes, token exchange and MP API calls')
})

test('preflight is inert; CORS is not authorization', async () => {
  const res = mpPosBetaDisabled(new Request('https://edge.invalid', { method: 'OPTIONS' }))
  assert.equal(res.status, 204)
  assert.equal(await res.text(), '')
  assert.equal(mpPosBetaDisabled(new Request('https://edge.invalid', { headers: { origin: 'https://untrusted.invalid' } })).status, 410)
})

test('no hidden privileged dependency; Billing and manual POS remain separate', () => {
  for (const file of ['mp-oauth/index.ts', 'mp-payments/index.ts', '_shared/mpPosBetaDisabled.ts']) {
    const src = read(`supabase/functions/${file}`)
    assert.doesNotMatch(src, /createClient|Deno\.env|fetch\s*\(|\.from\s*\(|\.rpc\s*\(/)
  }
  for (const fn of ['mp-subscription', 'mp-webhook']) {
    const src = read(`supabase/functions/${fn}/index.ts`)
    assert.doesNotMatch(src, /mp_accounts|mpPosBetaDisabled|mp-oauth|mp-payments/)
    assert.match(src, /MP_ACCESS_TOKEN/)
  }
  for (const file of ['src/services/comprobanteService.ts', 'src/components/comprobantes/ComprobanteProModal.tsx', 'src/hooks/usePaymentCommissions.ts']) {
    assert.doesNotMatch(read(file), /functions\.invoke\(['"]mp-(oauth|payments)/)
  }
  assert.match(read('src/App.tsx'), /path="\/mp\/\*" element=\{<Navigate to="\/landing" replace/)
  for (const route of ['/subscription', '/subscription/plans', '/subscription/pending', '/subscription/success']) {
    assert.ok(read('src/App.tsx').includes(`path="${route}"`))
  }
  for (const fn of ['mp-oauth', 'mp-payments']) {
    assert.ok(read('supabase/config.toml').includes(`[functions.${fn}]\nverify_jwt = false`))
  }
})
