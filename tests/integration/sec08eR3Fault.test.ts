import { afterAll, beforeAll, expect, it, vi } from 'vitest'

const base = process.env.SEC08E_R1_URL || ''
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw Error('Use the disposable R3 runner')
const order = 'e0800000-0000-0000-0000-000000000301'
let services: typeof import('../../src/services/api')
beforeAll(async () => {
  const nativeFetch = globalThis.fetch
  vi.stubEnv('VITE_SUPABASE_URL', base)
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'synthetic-r3-key')
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== base || !url.pathname.startsWith('/rest/v1/')) throw Error('Non-local request refused')
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${process.env.SEC08E_R1_OWNER}`)
    url.pathname = url.pathname.replace('/rest/v1', '')
    return nativeFetch(url, { ...init, headers, signal: AbortSignal.timeout(10000) })
  })
  services = await import('../../src/services/api')
})
afterAll(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

it('current contract-1 services propagate the missing migrated projection', async () => {
  const { supabase } = await import('../../src/lib/supabase')
  const marker = await supabase.rpc('can_view_payment_allocations', { p_business_id: null })
  expect(marker.error).toBeNull()
  await expect(services.partsService.getByOrder(order)).rejects.toMatchObject({ code: 'PGRST205' })
  await expect(services.partsService.calculateTotal(order)).rejects.toMatchObject({ code: 'PGRST205' })
  await expect(services.ordersService.getById(order)).rejects.toMatchObject({ code: 'PGRST205' })
})
