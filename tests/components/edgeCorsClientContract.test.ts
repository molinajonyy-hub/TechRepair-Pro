import { afterEach, describe, expect, it, vi } from 'vitest'
import { TECHREPAIR_CLIENT_HEADERS } from '../../src/lib/clientContract'
import {
  BROWSER_CLIENT_METADATA_HEADERS,
  BROWSER_EDGE_REQUEST_HEADERS,
} from '../../supabase/functions/_shared/clientContract'

const base = 'http://localhost:54321'

// P0 EDGE CORS: every header the official client really puts on an Edge Function
// call must be in the contract the browser-called functions allow in their preflight.
describe('P0 edge CORS — browser Edge transport contract', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('the Edge metadata list is exactly the frontend global header set', () => {
    expect([...BROWSER_CLIENT_METADATA_HEADERS].sort())
      .toEqual(Object.keys(TECHREPAIR_CLIENT_HEADERS).map((h) => h.toLowerCase()).sort())
  })

  it('every header of a real functions.invoke is covered by the Edge CORS contract', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', base)
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'local-test-key')
    const sent: { url: string; headers: Headers }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(input), headers: new Headers(init?.headers) })
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    const { supabase } = await import('../../src/lib/supabase')

    await supabase.functions.invoke('edge-cors-contract-probe', { body: { probe: true } })

    expect(sent.map((r) => new URL(r.url).pathname)).toEqual(['/functions/v1/edge-cors-contract-probe'])
    const names = [...sent[0].headers.keys()]
    for (const name of names) expect(BROWSER_EDGE_REQUEST_HEADERS).toContain(name)
    for (const name of BROWSER_CLIENT_METADATA_HEADERS) expect(names).toContain(name)
  })
})
