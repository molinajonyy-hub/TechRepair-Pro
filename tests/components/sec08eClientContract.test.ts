import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createClientContractFetch, TECHREPAIR_CLIENT_CONTRACT, TECHREPAIR_CLIENT_HEADERS } from '../../src/lib/clientContract'

const base = 'http://localhost:54321'

describe('SEC-08E R1 central transport', () => {
  afterEach(() => { vi.unstubAllEnvs() })
  beforeEach(() => { localStorage.clear() })

  it('uses the compiled protocol and bundle commit despite mutable client data', () => {
    localStorage.setItem('TECHREPAIR_CLIENT_CONTRACT', '999')
    window.history.replaceState({}, '', '?x-techrepair-client-contract=999')
    expect(TECHREPAIR_CLIENT_CONTRACT).toBe(1)
    expect(Number.isInteger(TECHREPAIR_CLIENT_CONTRACT)).toBe(true)
    expect(TECHREPAIR_CLIENT_HEADERS).toEqual({
      'x-techrepair-client-contract': '1', 'x-techrepair-client-build': 'testsha',
    })
    expect(fetch).not.toHaveBeenCalled()
    window.history.replaceState({}, '', '/')
  })

  it.each(['/rest/v1/parts_used', '/rest/v1/rpc/get_my_profile', '/graphql/v1'])(
    'recognizes only the signature while leaving the body readable: %s', async path => {
      const body = { code: 'CLIENT_UPDATE_REQUIRED', message: 'Actualizá la aplicación para continuar.' }
      const response = new Response(JSON.stringify(body), { status: 409 })
      const notify = vi.fn()
      const transport = createClientContractFetch(base, vi.fn().mockResolvedValue(response), notify)
      expect(await transport(new Request(base + path))).toBe(response)
      expect(notify).toHaveBeenCalledOnce()
      expect(await response.json()).toEqual(body)
    },
  )

  it.each([
    [409, '{"code":"23505"}'],
    [401, '{"code":"CLIENT_UPDATE_REQUIRED"}'],
    [403, '{"code":"42501"}'],
    [409, '{"code":"42501"}'],
    [500, '{"code":"CLIENT_UPDATE_REQUIRED"}'],
    [409, '{broken'], [409, 'null'], [409, '"CLIENT_UPDATE_REQUIRED"'],
  ])('preserves status %s / %s without an update notification', async (status, body) => {
    const response = new Response(body as string, { status: status as number })
    const notify = vi.fn()
    const transport = createClientContractFetch(base, vi.fn().mockResolvedValue(response), notify)
    expect(await transport(base + '/rest/v1/orders')).toBe(response)
    expect(await response.text()).toBe(body)
    expect(notify).not.toHaveBeenCalled()
  })

  it('propagates the same network error', async () => {
    const error = new TypeError('Failed to fetch')
    const notify = vi.fn()
    await expect(createClientContractFetch(base, vi.fn().mockRejectedValue(error), notify)(base + '/rest/v1/orders')).rejects.toBe(error)
    expect(notify).not.toHaveBeenCalled()
  })

  it.each(['/functions/v1/example', '/storage/v1/object', '/auth/v1/user', 'https://other.test/rest/v1/orders'])(
    'does not interpret non-Data-API responses: %s', async path => {
      const notify = vi.fn()
      const response = new Response('{"code":"CLIENT_UPDATE_REQUIRED"}', { status: 409 })
      await createClientContractFetch(base, vi.fn().mockResolvedValue(response), notify)(path.startsWith('http') ? path : base + path)
      expect(notify).not.toHaveBeenCalled()
    },
  )

  it('the actual central SDK sends both headers on REST, RPC, Functions and Storage', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', base)
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'local-test-key')
    const requests: { url: string; headers: Headers }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) })
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    const { supabase } = await import('../../src/lib/supabase')
    await supabase.from('parts_used').select('id')
    await supabase.rpc('get_my_profile')
    await supabase.functions.invoke('r1-test')
    await supabase.storage.from('r1-test').list()
    expect(requests.map(request => new URL(request.url).pathname)).toEqual([
      '/rest/v1/parts_used', '/rest/v1/rpc/get_my_profile', '/functions/v1/r1-test', '/storage/v1/object/list/r1-test',
    ])
    for (const { headers } of requests) {
      expect(headers.get('x-techrepair-client-contract')).toBe('1')
      expect(headers.get('x-techrepair-client-build')).toBe('testsha')
    }
    const signOut = vi.spyOn(supabase.auth, 'signOut')
    const body = { code: 'CLIENT_UPDATE_REQUIRED', message: 'Actualizá la aplicación para continuar.' }
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 409 }))
    const result = await supabase.from('orders').select('id')
    expect(result.status).toBe(409)
    expect(result.error).toEqual(body)
    expect(signOut).not.toHaveBeenCalled()
    const { clientUpdateSignal } = await import('../../src/lib/clientUpdateSignal')
    expect(clientUpdateSignal.getSnapshot()).toBe(true)
  })
})
