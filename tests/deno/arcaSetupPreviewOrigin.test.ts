import { assert, assertEquals } from 'jsr:@std/assert'

// ARCA self-service: a scoped, temporary QA origin for the Phase 2B homologación smoke.
//
// `ARCA_SETUP_EXTRA_ORIGINS` is read ONLY by arca-selfservice-setup and adds exact origins to its CORS
// allowlist (the same exact-match helper as always: no wildcard, no regex, no *.vercel.app).
// Each scenario runs the REAL index.ts offline through fixtures/edge-cors (serve captured,
// supabase-js inert, fetch disabled). CORS is transport only: nothing here grants authority.

const WWW = 'https://www.techrepairpro.app'
const APEX = 'https://techrepairpro.app'
const PREVIEW = 'https://tech-repair-pro-git-claude-arc-a20d96-molinajonyy-hubs-projects.vercel.app'
const HARNESS = new URL('./fixtures/edge-cors/harness.ts', import.meta.url).href
const IMPORT_MAP = new URL('./fixtures/edge-cors/import_map.json', import.meta.url).href

interface Result { status: number; acao: string | null; body: string; backendCalls: string[] }

async function run(slug: string, extra?: string): Promise<Record<string, Result>> {
  const args = ['run', '-A', '--no-config', '--import-map', IMPORT_MAP, HARNESS, slug]
  if (extra !== undefined) args.push(extra)
  const out = await new Deno.Command(Deno.execPath(), { args, stdout: 'piped', stderr: 'piped' }).output()
  const marker = '__EDGE_CORS_RESULT__'
  const line = new TextDecoder().decode(out.stdout).split('\n').map((l) => l.trim()).find((l) => l.startsWith(marker))
  if (!out.success || !line) throw new Error(`${slug} harness failed:\n${new TextDecoder().decode(out.stderr)}`)
  return JSON.parse(line.slice(marker.length))
}

const REJECTED_LOOKALIKES = [
  'preflight_preview_other_vercel',
  'preflight_preview_lookalike_subdomain',
  'preflight_preview_prefix',
  'preflight_preview_suffix',
  'preflight_preview_http',
  'preflight_preview_port',
  'preflight_evil_plain',
  'preflight_evil_origin',
]

const neverWildcard = (r: Record<string, Result>) => {
  for (const [name, res] of Object.entries(r)) assert(res.acao !== '*', `${name} answered Access-Control-Allow-Origin: *`)
}

Deno.test('A. without ARCA_SETUP_EXTRA_ORIGINS: canonical only (current production behaviour)', async () => {
  const r = await run('arca-selfservice-setup')
  assertEquals(r.preflight_official.acao, WWW)
  assertEquals(r.preflight_apex.acao, APEX)
  assertEquals(r.preflight_preview_exact.acao, null, 'the Preview must stay blocked without the variable')
  for (const name of REJECTED_LOOKALIKES) assertEquals(r[name].acao, null, name)
  neverWildcard(r)
})

Deno.test('A. an empty ARCA_SETUP_EXTRA_ORIGINS is the same as unset', async () => {
  const r = await run('arca-selfservice-setup', '')
  assertEquals(r.preflight_official.acao, WWW)
  assertEquals(r.preflight_apex.acao, APEX)
  assertEquals(r.preflight_preview_exact.acao, null)
  neverWildcard(r)
})

Deno.test('B. with the exact Preview: that origin only, echoed exactly; canonical kept; look-alikes rejected', async () => {
  const r = await run('arca-selfservice-setup', PREVIEW)
  assertEquals(r.preflight_preview_exact.acao, PREVIEW)
  assertEquals(r.preflight_preview_exact.status, 204)
  // index.ts builds the (inert) admin client for every request, OPTIONS included — pre-existing and
  // network-free. A preflight must never authenticate, call an RPC or fetch.
  for (const call of r.preflight_preview_exact.backendCalls) {
    assertEquals(call, 'createClient', `a preflight reached ${call}`)
  }
  assertEquals(r.preflight_official.acao, WWW)
  assertEquals(r.preflight_apex.acao, APEX)
  for (const name of REJECTED_LOOKALIKES) assertEquals(r[name].acao, null, name)
  neverWildcard(r)
})

Deno.test('B. a trailing slash in the configured value still matches only the exact origin', async () => {
  const r = await run('arca-selfservice-setup', `${PREVIEW}/`)
  assertEquals(r.preflight_preview_exact.acao, PREVIEW)
  for (const name of REJECTED_LOOKALIKES) assertEquals(r[name].acao, null, name)
  neverWildcard(r)
})

Deno.test('CORS is not authority: a POST from the allowed Preview without a JWT is still 401', async () => {
  const r = await run('arca-selfservice-setup', PREVIEW)
  assertEquals(r.post_preview_without_auth.status, 401, r.post_preview_without_auth.body)
  assertEquals(r.post_preview_without_auth.acao, PREVIEW)
  for (const call of r.post_preview_without_auth.backendCalls) {
    assert(['createClient', 'auth.getUser'].includes(call), `reached ${call} before identity`)
  }
})

for (const slug of ['afip-wsaa', 'afip-cae', 'mp-subscription', 'whatsapp-send', 'whatsapp-send-message']) {
  Deno.test(`C. ${slug} ignores ARCA_SETUP_EXTRA_ORIGINS`, async () => {
    const r = await run(slug, PREVIEW)
    assertEquals(r.preflight_preview_exact.acao, null, `${slug} must not allow the ARCA QA origin`)
    assertEquals(r.preflight_official.acao, WWW)
    neverWildcard(r)
  })
}
