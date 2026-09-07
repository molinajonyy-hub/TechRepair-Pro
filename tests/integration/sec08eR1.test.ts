import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const id = (n: number) => `e0800000-0000-0000-0000-${String(n).padStart(12, '0')}`
const base = process.env.SEC08E_R1_URL || ''
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw Error('Use the disposable Docker R1 runner')
let actor = 1
const requests: { url: URL; headers: Headers }[] = []
type Services = typeof import('../../src/services/api')
let services: Services
let client: typeof import('../../src/lib/supabase')['supabase']

describe('R1 actual central SDK + real PostgREST', () => {
  beforeAll(async () => {
    const nativeFetch = globalThis.fetch
    vi.stubEnv('VITE_SUPABASE_URL', base)
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'synthetic-r1-key')
    // Only emulate the gateway path/auth session. The real central client,
    // headers, interceptor, services and every table/RPC query are exercised.
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin !== base || !url.pathname.startsWith('/rest/v1/')) throw Error('Non-local Data API request rejected')
      const headers = new Headers(init?.headers)
      requests.push({ url: new URL(url), headers: new Headers(headers) })
      const tokens = { 1: process.env.SEC08E_R1_OWNER, 2: process.env.SEC08E_R1_TECH, 5: process.env.SEC08E_R1_OTHER }
      headers.set('Authorization', `Bearer ${tokens[actor as keyof typeof tokens]}`)
      url.pathname = url.pathname.replace('/rest/v1', '')
      return nativeFetch(url, { ...init, headers, signal: AbortSignal.timeout(10000) })
    })
    client = (await import('../../src/lib/supabase')).supabase
    vi.spyOn(client.auth, 'getUser').mockImplementation(async () => ({ data: { user: { id: id(actor) } }, error: null }) as Awaited<ReturnType<typeof client.auth.getUser>>)
    services = await import('../../src/services/api')
  })
  afterEach(async () => {
    actor = 1
    const { error } = await client.from('parts_used').delete().eq('code', 'R1-MATRIX')
    if (error) throw error
    for (const { url, headers } of requests) {
      expect(headers.get('x-techrepair-client-contract')).toBe('1')
      expect(headers.get('x-techrepair-client-build')).toBe('r1-testsha')
      const select = url.searchParams.get('select') || ''
      if (url.pathname.endsWith('/parts_used')) expect(select).not.toMatch(/unit_price|subtotal|\*/)
      if (url.pathname.endsWith('/orders')) expect(select.match(/parts_used\(([^)]+)\)/)?.[1]).not.toMatch(/unit_price|subtotal|\*/)
    }
    requests.length = 0
  })
  afterAll(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

  for (const role of [1, 2]) it(`schema ${process.env.SEC08E_R1_SCHEMA}, actor ${role}: detail/list/create/total`, async () => {
    actor = role
    const financial = role === 1 && process.env.SEC08E_R1_SCHEMA === 'post'
    const { ordersService, partsService } = services
    const detail = await ordersService.getById(id(301))
    const parts = await partsService.getByOrder(id(301))
    expect(detail.id).toBe(id(301))
    for (const part of [detail.parts_used[0], parts[0]]) {
      expect(part).toMatchObject({ id: id(401), quantity: 3 })
      if (financial) expect(part).toMatchObject({ unit_price: 7103.19, subtotal: 21309.57 })
      else { expect(part).not.toHaveProperty('unit_price'); expect(part).not.toHaveProperty('subtotal') }
    }
    const payload = { order_id: id(301), business_id: id(101), created_by: id(actor), code: 'R1-MATRIX', description: 'Synthetic R1 part', quantity: 2, unit_price: 17.25 }
    const created = await partsService.create(payload)
    expect(created).toMatchObject({ code: 'R1-MATRIX', quantity: 2 })
    if (financial) expect(created).toMatchObject({ unit_price: 17.25, subtotal: 34.5 })
    else { expect(created).not.toHaveProperty('unit_price'); expect(created).not.toHaveProperty('subtotal') }
    expect(await partsService.calculateTotal(id(301))).toBe(financial ? 21344.07 : null)
    console.log('MATRIX', process.env.SEC08E_R1_SCHEMA, role === 1 ? 'owner' : 'tech', 'operational PASS; amounts', financial ? 'projected; total=21344.07 (includes synthetic insert)' : 'absent; total=null')
  })

  it('denies cross-tenant operational and projected data', async () => {
    actor = 5
    expect(await services.partsService.getByOrder(id(301))).toEqual([])
    await expect(services.ordersService.getById(id(301))).rejects.toMatchObject({ code: 'PGRST116' })
    if (process.env.SEC08E_R1_SCHEMA === 'post') {
      const { data, error } = await client.from('v_parts_used_amounts').select('id,unit_price').eq('order_id', id(301))
      expect(error).toBeNull()
      expect(data).toEqual([])
    }
  })

  it.skipIf(process.env.SEC08E_R1_SCHEMA !== 'post')('propagates an actual PostgreSQL authorization failure through the affected service', async () => {
    actor = 5
    const payload = { order_id: id(301), business_id: id(101), created_by: id(5), code: 'R1-MATRIX', description: 'Forbidden tenant', quantity: 1, unit_price: 1 }
    await expect(services.partsService.create(payload)).rejects.toMatchObject({ code: '42501' })
  })
})
