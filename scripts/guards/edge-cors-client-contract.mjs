#!/usr/bin/env node
/**
 * P0 EDGE CORS — browser → Edge Function transport contract (static guard).
 *
 * 2026-09-11: SEC-08E made the official web client send `x-techrepair-client-*` on
 * every Supabase request. Six browser-called Edge Functions answered the preflight
 * without those headers, so the browser never sent the POST ("Failed to send a
 * request to the Edge Function"). This guard fails when the frontend's global
 * headers and those functions' CORS allowlists drift apart again.
 *
 *  G1  src/lib/supabase.ts sends exactly TECHREPAIR_CLIENT_HEADERS as global headers.
 *  G2  the Edge list BROWSER_CLIENT_METADATA_HEADERS equals TECHREPAIR_CLIENT_HEADERS' keys.
 *  G3  every Edge Function the frontend calls is classified in REGISTRY, and vice versa.
 *  G4  every SDK-called function builds its CORS allowlist from the shared contract.
 *  G5  raw-fetch callers never send the client metadata headers.
 *  G6  no Allow-Headers wildcard anywhere; no Allow-Origin wildcard beyond recorded debt.
 *
 * CORS is transport only: these headers are metadata and never grant authority.
 * Usage: node scripts/guards/edge-cors-client-contract.mjs [--self-test]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

// Every Edge Function reachable from browser code, classified by how it is called
// and which CORS implementation answers its preflight.
export const REGISTRY = {
  'afip-wsaa': { transport: 'sdk', cors: 'local-allowlist' },
  'afip-cae': { transport: 'sdk', cors: 'local-allowlist' },
  'mp-subscription': { transport: 'sdk', cors: 'local-allowlist' },
  'whatsapp-send': { transport: 'sdk', cors: 'scoped' },
  'whatsapp-send-message': { transport: 'sdk', cors: 'scoped' },
  // Disabled endpoint (always 503). Its Allow-Origin '*' predates this guard: recorded debt.
  'whatsapp-embedded-signup': { transport: 'sdk', cors: 'static-list', wildcardOriginDebt: true },
  // Plain fetch with their own headers; they never carry the client metadata.
  'infodolar-cordoba': { transport: 'fetch' },
  'fetch-dollar-rate': { transport: 'fetch' },
}

const SDK_BASE_HEADERS = ['authorization', 'x-client-info', 'apikey', 'content-type']

function diskTree(root) {
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(join(root, dir), { withFileTypes: true }) } catch { return [] }
    return entries.flatMap((e) => {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) return walk(rel)
      return /\.(ts|tsx)$/.test(e.name) ? [rel] : []
    })
  }
  return {
    read: (rel) => readFileSync(join(root, rel), 'utf8'),
    exists: (rel) => { try { return statSync(join(root, rel)).isFile() } catch { return false } },
    list: (dir) => walk(dir),
  }
}

function overlayTree(base, overrides) {
  return {
    read: (rel) => (overrides.has(rel) ? overrides.get(rel) : base.read(rel)),
    exists: (rel) => overrides.has(rel) || base.exists(rel),
    list: (dir) => [...new Set([...base.list(dir), ...[...overrides.keys()].filter((k) => k.startsWith(`${dir}/`))])],
  }
}

/** Text of the `{...}` or `[...]` block that opens at the first `open` after `from`. */
function block(text, from, open = '{') {
  const close = open === '{' ? '}' : ']'
  const start = from < 0 ? -1 : text.indexOf(open, from)
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++
    else if (text[i] === close && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}

/** Offset of the initializer of `name` (just past its `=`), skipping any type annotation. */
function initializer(text, name) {
  const at = text.search(new RegExp(`\\b${name}\\b[^=]*=`))
  return at < 0 ? -1 : text.indexOf('=', at) + 1
}

const lower = (list) => list.map((h) => h.toLowerCase())
const sameSet = (a, b) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|')

export function check(tree) {
  const errors = []
  const fail = (code, msg) => errors.push(`${code}: ${msg}`)

  // G1 — the global headers of the one official client.
  const supa = tree.read('src/lib/supabase.ts')
  const global = block(supa, supa.indexOf('global:'))
  if (!global) fail('G1', 'src/lib/supabase.ts has no `global: { ... }` client option')
  else {
    if (!/\bheaders\s*:\s*TECHREPAIR_CLIENT_HEADERS\s*,?\s*$/m.test(global)) {
      fail('G1', 'src/lib/supabase.ts must send exactly `headers: TECHREPAIR_CLIENT_HEADERS` (add headers in src/lib/clientContract.ts)')
    }
    if (/['"]x-[a-z0-9-]+['"]/i.test(global)) fail('G1', 'src/lib/supabase.ts declares an inline global header')
  }

  // G2 — frontend global header names == Edge metadata list.
  const front = tree.read('src/lib/clientContract.ts')
  const frontBlock = block(front, initializer(front, 'export const TECHREPAIR_CLIENT_HEADERS'))
  const frontHeaders = frontBlock ? lower([...frontBlock.matchAll(/['"]([A-Za-z0-9-]+)['"]\s*:/g)].map((m) => m[1])) : []
  if (!frontBlock || frontHeaders.length === 0) fail('G2', 'cannot read TECHREPAIR_CLIENT_HEADERS keys in src/lib/clientContract.ts')
  if (frontBlock && /\[[^\]]+\]\s*:/.test(frontBlock)) fail('G2', 'TECHREPAIR_CLIENT_HEADERS must use literal header names')

  const edge = tree.read('supabase/functions/_shared/clientContract.ts')
  const constants = Object.fromEntries([...edge.matchAll(/export const ([A-Z_]+) = '([^']+)'/g)].map((m) => [m[1], m[2]]))
  const resolveList = (name) => {
    const list = block(edge, initializer(edge, `export const ${name}`), '[')
    if (!list) return null
    return lower(list.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean).map((item) => {
      const literal = item.match(/^'([^']+)'$/)
      if (literal) return literal[1]
      if (constants[item]) return constants[item]
      return `<unresolved:${item}>`
    }))
  }
  const metadata = resolveList('BROWSER_CLIENT_METADATA_HEADERS')
  const sdkBase = resolveList('SUPABASE_JS_BROWSER_HEADERS')
  if (!metadata) fail('G2', 'supabase/functions/_shared/clientContract.ts lacks BROWSER_CLIENT_METADATA_HEADERS')
  else if (!sameSet(metadata, frontHeaders)) {
    fail('G2', `Edge metadata [${metadata.join(', ')}] != frontend global headers [${frontHeaders.join(', ')}]; update BROWSER_CLIENT_METADATA_HEADERS`)
  }
  if (!sdkBase || !SDK_BASE_HEADERS.every((h) => sdkBase.includes(h))) {
    fail('G2', `SUPABASE_JS_BROWSER_HEADERS must keep ${SDK_BASE_HEADERS.join(', ')}`)
  }
  if (!/export const BROWSER_EDGE_REQUEST_HEADERS[^=]*=\s*\[\s*\.\.\.SUPABASE_JS_BROWSER_HEADERS,\s*\.\.\.BROWSER_CLIENT_METADATA_HEADERS,?\s*\]/.test(edge)) {
    fail('G2', 'BROWSER_EDGE_REQUEST_HEADERS must be SUPABASE_JS_BROWSER_HEADERS + BROWSER_CLIENT_METADATA_HEADERS')
  }

  // G3 — discovery of browser → Edge calls.
  const found = new Map()
  const note = (slug, transport, file) => {
    if (!found.has(slug)) found.set(slug, new Map())
    found.get(slug).set(transport, file)
  }
  for (const file of tree.list('src')) {
    const text = tree.read(file)
    for (const m of text.matchAll(/functions\.invoke\(\s*(['"`])([^'"`]*)\1/g)) note(m[2], 'sdk', file)
    for (const m of text.matchAll(/functions\.invoke\(\s*([^'"`\s)][^,)]*)/g)) {
      fail('G3', `${file}: functions.invoke(${m[1].trim()}) uses a dynamic name; call Edge Functions with a literal slug`)
    }
    for (const m of text.matchAll(/\/functions\/v1\/([a-z0-9-]+)/g)) note(m[1], 'fetch', file)
  }
  for (const [slug, transports] of found) {
    const entry = REGISTRY[slug]
    if (!entry) { fail('G3', `${slug} is called from ${[...transports.values()].join(', ')} but is not classified in REGISTRY`); continue }
    for (const [transport, file] of transports) {
      if (transport !== entry.transport) fail('G3', `${slug}: called via ${transport} in ${file}, REGISTRY says ${entry.transport}`)
    }
  }
  for (const slug of Object.keys(REGISTRY)) {
    if (!found.has(slug)) fail('G3', `REGISTRY lists ${slug} but no browser code calls it; remove it`)
  }

  // G4 — SDK-called functions take the shared contract.
  const scoped = tree.read('supabase/functions/_shared/scopedCors.ts')
  const spreads = (text) => {
    const set = block(text, initializer(text, 'const ALLOWED_REQUEST_HEADERS'), '[')
    return !!set && /\.\.\.BROWSER_CLIENT_METADATA_HEADERS\b/.test(set)
  }
  const importsFrom = (text, name, path) => new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'${path.replace(/[.]/g, '\\.')}'`).test(text)
  if (!importsFrom(scoped, 'BROWSER_CLIENT_METADATA_HEADERS', './clientContract.ts') || !spreads(scoped)) {
    fail('G4', '_shared/scopedCors.ts must spread BROWSER_CLIENT_METADATA_HEADERS into ALLOWED_REQUEST_HEADERS')
  }
  for (const [slug, entry] of Object.entries(REGISTRY)) {
    if (entry.transport !== 'sdk') continue
    const file = `supabase/functions/${slug}/index.ts`
    if (!tree.exists(file)) { fail('G4', `${file} is missing`); continue }
    const text = tree.read(file)
    if (entry.cors === 'local-allowlist') {
      if (!importsFrom(text, 'BROWSER_CLIENT_METADATA_HEADERS', '../_shared/clientContract.ts') || !spreads(text)) {
        fail('G4', `${file} must spread BROWSER_CLIENT_METADATA_HEADERS into its ALLOWED_REQUEST_HEADERS`)
      }
    } else if (entry.cors === 'scoped') {
      if (!importsFrom(text, 'createCors', '../_shared/scopedCors.ts') || /Access-Control-Allow-Headers/.test(text)) {
        fail('G4', `${file} must answer CORS through _shared/scopedCors.ts only`)
      }
    } else if (entry.cors === 'static-list') {
      if (!importsFrom(text, 'BROWSER_EDGE_REQUEST_HEADERS', '../_shared/clientContract.ts')
        || !/'Access-Control-Allow-Headers':\s*BROWSER_EDGE_REQUEST_HEADERS\.join\(', '\)/.test(text)) {
        fail('G4', `${file} must build Access-Control-Allow-Headers from BROWSER_EDGE_REQUEST_HEADERS`)
      }
    }
  }

  // G5 — raw fetch callers do not carry the metadata (their functions do not allow it).
  for (const [slug, transports] of found) {
    if (REGISTRY[slug]?.transport !== 'fetch') continue
    for (const file of transports.values()) {
      if (/TECHREPAIR_CLIENT_HEADERS|x-techrepair-client-/.test(tree.read(file))) {
        fail('G5', `${file} calls ${slug} with plain fetch and the client metadata headers; move it to supabase.functions.invoke and classify it as sdk`)
      }
    }
  }

  // G6 — wildcards.
  for (const file of tree.list('supabase/functions')) {
    const text = tree.read(file)
    if (/['"]Access-Control-Allow-Headers['"]\s*:\s*['"]\*['"]/.test(text)) fail('G6', `${file} uses Access-Control-Allow-Headers: *`)
  }
  for (const [slug, entry] of Object.entries(REGISTRY)) {
    if (entry.transport !== 'sdk' || entry.wildcardOriginDebt) continue
    const file = `supabase/functions/${slug}/index.ts`
    if (tree.exists(file) && /['"]Access-Control-Allow-Origin['"]\s*:\s*['"]\*['"]/.test(tree.read(file))) {
      fail('G6', `${file} answers Access-Control-Allow-Origin: *`)
    }
  }
  if (/['"]Access-Control-Allow-Origin['"]\s*:\s*['"]\*['"]/.test(scoped)) fail('G6', '_shared/scopedCors.ts answers Access-Control-Allow-Origin: *')

  return { errors, found }
}

function selfTest() {
  const base = diskTree(ROOT)
  const baseline = check(base)
  if (baseline.errors.length) {
    console.error('self-test: the real tree must pass first:\n  ' + baseline.errors.join('\n  '))
    process.exit(1)
  }
  const mutate = (rel, from, to) => {
    const text = base.read(rel)
    if (!text.includes(from)) throw new Error(`self-test mutation did not apply in ${rel}: ${from}`)
    return [rel, text.replace(from, to)]
  }
  const cases = [
    ['frontend adds a global header', 'G2', [mutate('src/lib/clientContract.ts', "'x-techrepair-client-build': __BUILD_COMMIT__,", "'x-techrepair-client-build': __BUILD_COMMIT__,\n  'x-techrepair-client-tenant': 'x',")]],
    ['Edge metadata list drops a header', 'G2', [mutate('supabase/functions/_shared/clientContract.ts', '  CLIENT_BUILD_HEADER,\n]', ']')]],
    ['supabase.ts adds an inline global header', 'G1', [mutate('src/lib/supabase.ts', 'headers: TECHREPAIR_CLIENT_HEADERS,', "headers: { ...TECHREPAIR_CLIENT_HEADERS, 'x-extra': '1' },")]],
    ['afip-cae loses the metadata headers', 'G4', [mutate('supabase/functions/afip-cae/index.ts', '  ...BROWSER_CLIENT_METADATA_HEADERS,\n', '')]],
    ['afip-wsaa loses the metadata headers', 'G4', [mutate('supabase/functions/afip-wsaa/index.ts', '  ...BROWSER_CLIENT_METADATA_HEADERS,\n', '')]],
    ['mp-subscription loses the metadata headers', 'G4', [mutate('supabase/functions/mp-subscription/index.ts', '  ...BROWSER_CLIENT_METADATA_HEADERS,\n', '')]],
    ['scopedCors loses the metadata headers', 'G4', [mutate('supabase/functions/_shared/scopedCors.ts', '  ...BROWSER_CLIENT_METADATA_HEADERS,\n', '')]],
    ['embedded-signup goes back to a literal list', 'G4', [mutate('supabase/functions/whatsapp-embedded-signup/index.ts', "BROWSER_EDGE_REQUEST_HEADERS.join(', ')", "'authorization, x-client-info, apikey, content-type'")]],
    ['a new browser-called function appears', 'G3', [['src/services/__edgeCorsSelfTest.ts', "await supabase.functions.invoke('brand-new-fn', {})\n"]]],
    ['a call uses a dynamic slug', 'G3', [mutate('src/services/subscriptionService.ts', "supabase.functions.invoke('mp-subscription'", 'supabase.functions.invoke(slugFromSomewhere')]],
    ['Allow-Headers wildcard', 'G6', [mutate('supabase/functions/mp-subscription/index.ts', "'Access-Control-Allow-Headers': pickAllowedRequestHeaders(req),", "'Access-Control-Allow-Headers': '*',")]],
    ['Allow-Origin wildcard on an authenticated function', 'G6', [mutate('supabase/functions/afip-wsaa/index.ts', "headers['Access-Control-Allow-Origin'] = origin", "headers['Access-Control-Allow-Origin'] = origin\n  headers['x'] = { 'Access-Control-Allow-Origin': '*' } as never")]],
    ['raw fetch starts sending the metadata', 'G5', [mutate('src/services/dollarRateService.ts', "headers: { 'apikey': key,", "headers: { ...TECHREPAIR_CLIENT_HEADERS, 'apikey': key,")]],
  ]
  let failed = 0
  for (const [name, code, overrides] of cases) {
    const { errors } = check(overlayTree(base, new Map(overrides)))
    const ok = errors.some((e) => e.startsWith(`${code}:`))
    if (!ok) failed++
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} → expected ${code}${ok ? '' : `, got: ${errors.join(' | ') || 'no error'}`}`)
  }
  console.log(`self-test: ${cases.length - failed}/${cases.length} mutations detected`)
  process.exit(failed ? 1 : 0)
}

if (process.argv.includes('--self-test')) selfTest()
else {
  const { errors, found } = check(diskTree(ROOT))
  if (errors.length) {
    console.error('edge-cors-client-contract: FAIL\n  ' + errors.join('\n  '))
    process.exit(1)
  }
  const sdk = [...found.keys()].filter((s) => REGISTRY[s].transport === 'sdk').sort()
  const fetchOnly = [...found.keys()].filter((s) => REGISTRY[s].transport === 'fetch').sort()
  console.log(`edge-cors-client-contract: OK — SDK-called (contract enforced): ${sdk.join(', ')}; plain fetch: ${fetchOnly.join(', ')}`)
}
