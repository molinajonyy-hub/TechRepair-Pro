import { assert, assertEquals } from 'jsr:@std/assert'
import {
  BROWSER_CLIENT_METADATA_HEADERS,
  BROWSER_EDGE_REQUEST_HEADERS,
} from '../../supabase/functions/_shared/clientContract.ts'

// P0 EDGE CORS: each REAL browser-called handler runs offline through
// fixtures/edge-cors (serve captured, supabase-js inert, fetch disabled) and must
// answer the official client's preflight while granting nothing to its headers.

const WWW = 'https://www.techrepairpro.app'
const APEX = 'https://techrepairpro.app'
const HARNESS = new URL('./fixtures/edge-cors/harness.ts', import.meta.url).href
const IMPORT_MAP = new URL('./fixtures/edge-cors/import_map.json', import.meta.url).href

// Authenticated functions with an exact-origin allowlist.
const SCOPED = ['afip-wsaa', 'afip-cae', 'mp-subscription', 'whatsapp-send', 'whatsapp-send-message']
// Disabled endpoint (always 503) with a pre-existing '*' origin: recorded debt.
const DISABLED = 'whatsapp-embedded-signup'

interface Result {
  status: number
  acao: string | null
  acah: string | null
  acam: string | null
  body: string
  backendCalls: string[]
}

const runs = new Map<string, Promise<Record<string, Result>>>()
function run(slug: string): Promise<Record<string, Result>> {
  if (!runs.has(slug)) {
    runs.set(slug, (async () => {
      const out = await new Deno.Command(Deno.execPath(), {
        args: ['run', '-A', '--no-config', '--import-map', IMPORT_MAP, HARNESS, slug],
        stdout: 'piped',
        stderr: 'piped',
      }).output()
      const marker = '__EDGE_CORS_RESULT__'
      const line = new TextDecoder().decode(out.stdout).split('\n').map((l) => l.trim()).find((l) => l.startsWith(marker))
      if (!out.success || !line) {
        throw new Error(`${slug} harness failed:\n${new TextDecoder().decode(out.stderr)}`)
      }
      return JSON.parse(line.slice(marker.length))
    })())
  }
  return runs.get(slug)!
}

const allowed = (value: string | null) =>
  (value ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)

Deno.test('the browser Edge contract is the SDK set plus the client metadata, with no wildcard', () => {
  for (const h of ['authorization', 'x-client-info', 'apikey', 'content-type', ...BROWSER_CLIENT_METADATA_HEADERS]) {
    assert(BROWSER_EDGE_REQUEST_HEADERS.includes(h), `missing ${h}`)
  }
  assert(!BROWSER_EDGE_REQUEST_HEADERS.includes('*'))
})

for (const slug of [...SCOPED, DISABLED]) {
  Deno.test(`${slug}: answers the official client's preflight`, async () => {
    const r = await run(slug)
    for (const scenario of ['preflight_official', 'preflight_apex', 'preflight_hard_reload']) {
      const res = r[scenario]
      assert(res.status >= 200 && res.status < 300, `${scenario} status ${res.status}`)
      assert(res.acah !== '*', `${scenario} reflects a wildcard`)
      for (const h of BROWSER_EDGE_REQUEST_HEADERS) {
        assert(allowed(res.acah).includes(h), `${scenario} does not allow ${h}: ${res.acah}`)
      }
      assertEquals(res.acam, 'POST, OPTIONS')
      assertEquals(res.backendCalls, [], `${scenario} ran backend work`)
    }
    const unknown = allowed(r.preflight_unknown_headers.acah)
    assert(!unknown.includes('x-evil-header') && !unknown.includes('x-internal-caller'), 'unknown header reflected')
    assertEquals(r.preflight_evil_origin.backendCalls, [])
  })
}

for (const slug of SCOPED) {
  Deno.test(`${slug}: origins stay an exact allowlist`, async () => {
    const r = await run(slug)
    assertEquals(r.preflight_official.acao, WWW)
    assertEquals(r.preflight_apex.acao, APEX)
    assertEquals(r.preflight_evil_origin.acao, null)
    const reload = allowed(r.preflight_hard_reload.acah)
    assert(reload.includes('cache-control') && reload.includes('pragma'), 'hard-reload headers dropped')
  })

  Deno.test(`${slug}: client metadata and forged headers grant nothing`, async () => {
    const r = await run(slug)
    assertEquals(r.post_metadata_only.status, 401, r.post_metadata_only.body)
    assertEquals(r.post_forged_bearer.status, 401, r.post_forged_bearer.body)
    for (const scenario of ['post_metadata_only', 'post_forged_bearer']) {
      for (const call of r[scenario].backendCalls) {
        assert(['createClient', 'auth.getUser'].includes(call), `${scenario} reached ${call} before identity`)
      }
    }
  })
}

Deno.test(`${DISABLED}: stays disabled whatever headers arrive`, async () => {
  const r = await run(DISABLED)
  assertEquals(r.preflight_evil_origin.acao, '*') // pre-existing, recorded as debt
  for (const scenario of ['post_metadata_only', 'post_forged_bearer']) {
    assertEquals(r[scenario].status, 503)
    assert(r[scenario].body.includes('META_EMBEDDED_SIGNUP_NOT_CONFIGURED'))
    assertEquals(r[scenario].backendCalls, [])
  }
})
