// Runs ONE real Edge Function handler offline for tests/deno/edgeCorsClientContract.test.ts.
// Loaded with ./import_map.json: `serve` only captures the handler, supabase-js and
// node-forge are inert stubs and fetch is disabled, so nothing listens and nothing
// leaves the process. Prints one marked JSON line with every scenario's response.
import { BROWSER_EDGE_REQUEST_HEADERS } from '../../../../supabase/functions/_shared/clientContract.ts'

const slug = Deno.args[0] ?? ''
if (!/^[a-z0-9-]+$/.test(slug)) throw new Error('usage: harness.ts <function-slug>')

const g = globalThis as {
  __edgeHandler?: (req: Request) => Response | Promise<Response>
  __backendCalls?: string[]
}
const calls: string[] = (g.__backendCalls ??= [])
globalThis.fetch = (input: RequestInfo | URL) => {
  calls.push(`fetch:${String(input instanceof Request ? input.url : input)}`)
  return Promise.reject(new TypeError('network disabled in the CORS harness'))
}

// Structurally valid, fake runtime keys: the handlers need them to reach their auth boundary.
Deno.env.set('SUPABASE_URL', 'http://stub.invalid')
Deno.env.set('SUPABASE_ANON_KEY', `sb_publishable_${'a'.repeat(22)}_${'b'.repeat(8)}`)
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', `sb_secret_${'c'.repeat(22)}_${'d'.repeat(8)}`)
for (const name of ['MP_CORS_ORIGIN', 'APP_URL', 'WHATSAPP_CORS_ORIGIN', 'SUPABASE_SECRET_KEYS']) {
  Deno.env.delete(name)
}

await import(new URL(`../../../../supabase/functions/${slug}/index.ts`, import.meta.url).href)
const handler = g.__edgeHandler
if (!handler) throw new Error(`${slug} did not register a handler`)

const WWW = 'https://www.techrepairpro.app'
const OFFICIAL = BROWSER_EDGE_REQUEST_HEADERS.join(', ')
const url = `https://edge.test/functions/v1/${slug}`
const body = JSON.stringify({
  business_id: '00000000-0000-4000-8000-000000000001',
  service: 'wsfe',
  action: 'create',
  to: '5493510000000',
  message: 'cors harness',
})

const preflight = (origin: string, requested: string) => new Request(url, {
  method: 'OPTIONS',
  headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': requested },
})

const scenarios: Record<string, () => Request> = {
  preflight_official: () => preflight(WWW, OFFICIAL),
  preflight_apex: () => preflight('https://techrepairpro.app', OFFICIAL),
  preflight_hard_reload: () => preflight(WWW, `${OFFICIAL}, cache-control, pragma`),
  preflight_evil_origin: () => preflight('https://evil.example.com', OFFICIAL),
  preflight_unknown_headers: () => preflight(WWW, `${OFFICIAL}, x-evil-header, x-internal-caller`),
  post_metadata_only: () => new Request(url, {
    method: 'POST',
    headers: {
      Origin: WWW,
      'Content-Type': 'application/json',
      'x-techrepair-client-contract': '1',
      'x-techrepair-client-build': 'forged-build',
    },
    body,
  }),
  post_forged_bearer: () => new Request(url, {
    method: 'POST',
    headers: {
      Origin: WWW,
      'Content-Type': 'application/json',
      Authorization: 'Bearer forged.jwt.token',
      apikey: `sb_publishable_${'a'.repeat(22)}_${'b'.repeat(8)}`,
      'x-techrepair-client-contract': '999',
      'x-techrepair-client-build': 'forged-build',
      'x-internal-caller': 'afip-cae',
    },
    body,
  }),
}

const results: Record<string, unknown> = {}
for (const [name, make] of Object.entries(scenarios)) {
  const before = calls.length
  const response = await handler(make())
  const text = await response.text()
  results[name] = {
    status: response.status,
    acao: response.headers.get('access-control-allow-origin'),
    acah: response.headers.get('access-control-allow-headers'),
    acam: response.headers.get('access-control-allow-methods'),
    body: text.slice(0, 200),
    backendCalls: calls.slice(before),
  }
}
console.log(`__EDGE_CORS_RESULT__${JSON.stringify(results)}`)
