#!/usr/bin/env node
/**
 * PRE-BETA-2F — Invitation email delivery (static guard).
 *
 * The behavioral proof lives in tests/deno/sendBusinessInvitation.test.ts (handler) and
 * tests/components/prebeta2fInvitationDelivery.test.tsx (client). This guard keeps the
 * STRUCTURE those tests rely on from drifting:
 *
 *  I1  no Resend API key literal anywhere; RESEND_INVITES_API_KEY is read ONLY by
 *      send-business-invitation/index.ts via Deno.env.get, and never by the browser.
 *  I2  no invitation link is built from window.location.origin; `accept-invite?token=` is formed
 *      only by supabase/functions/_shared/invitationLink.ts, which src/lib/invitationLink.ts wraps
 *      (tab origin only outside production builds, and only as a loopback candidate).
 *  I3  the shared link module is canonical-only: www origin, loopback override, no env, no
 *      other domains (Clic, Vercel previews, Supabase Site URL).
 *  I4  the Edge Function never uses a request-supplied recipient/token: strict field allowlist,
 *      `to` and the link come from the DB row, create goes through create_business_invitation.
 *  I5  no service_role: not in the Edge Function (all data access is user-scoped/RLS), not in src/.
 *      The function never writes a table directly.
 *  I6  verify_jwt = false is paired with in-function JWT validation BEFORE the body is read.
 *  I7  template/transport hygiene: exact From, no images, tracking, Reply-To or support mailbox;
 *      provider payload is exactly from/to/subject/html/text; Idempotency-Key on every send.
 *  I8  the browser reaches the Edge Function only from src/services/invitationsService.ts.
 *
 * Usage: node scripts/guards/invitation-email-delivery.mjs [--self-test]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

const FN_DIR = 'supabase/functions/send-business-invitation'
const FN_INDEX = `${FN_DIR}/index.ts`
const FN_HANDLER = `${FN_DIR}/handler.ts`
const FN_EMAIL = `${FN_DIR}/email.ts`
const FN_DELIVERY = `${FN_DIR}/delivery.ts`
const SHARED_LINK = 'supabase/functions/_shared/invitationLink.ts'
const WEB_LINK = 'src/lib/invitationLink.ts'
const WEB_SERVICE = 'src/services/invitationsService.ts'
const USERS_PAGE = 'src/pages/UsersManagement.tsx'
const CONFIG = 'supabase/config.toml'
const SELF = 'scripts/guards/invitation-email-delivery.mjs'

const SCAN_DIRS = ['src', 'supabase', 'scripts', 'tests', 'docs', '.github']
const TEXT = /\.(ts|tsx|mjs|cjs|js|md|toml|sql|json|html|ya?ml|sh)$/

// Resend keys look like re_<8>_<24+>. Calibrated: zero matches in the repo before this lot.
const RESEND_KEY = /\bre_[A-Za-z0-9]{4,}_[A-Za-z0-9]{12,}/
const KEY_ASSIGNMENT = /RESEND_INVITES_API_KEY\s*[=:]\s*['"]?[A-Za-z0-9_]{12,}/

function diskTree(root) {
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(join(root, dir), { withFileTypes: true }) } catch { return [] }
    return entries.flatMap((e) => {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) return e.name === 'node_modules' || e.name.startsWith('.temp') ? [] : walk(rel)
      return TEXT.test(e.name) ? [rel] : []
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

/** Code without comments, so documentation that NAMES a forbidden pattern never trips a rule. */
const code = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
  .replace(/^\s*#[^\n]*/gm, '')

export function check(tree) {
  const errors = []
  const fail = (rule, msg) => errors.push(`${rule}: ${msg}`)
  const need = (rel) => {
    if (tree.exists(rel)) return tree.read(rel)
    fail('I0', `${rel} is missing`)
    return ''
  }

  const index = need(FN_INDEX)
  const handler = need(FN_HANDLER)
  const email = need(FN_EMAIL)
  const delivery = need(FN_DELIVERY)
  const shared = need(SHARED_LINK)
  const webLink = need(WEB_LINK)
  const service = need(WEB_SERVICE)
  const page = need(USERS_PAGE)
  const config = need(CONFIG)
  const fnFiles = tree.list(FN_DIR)
  const srcFiles = tree.list('src')

  // ── I1 — secrets ──────────────────────────────────────────────────────────
  for (const dir of SCAN_DIRS) {
    for (const file of tree.list(dir)) {
      if (file === SELF) continue
      const text = tree.read(file)
      if (RESEND_KEY.test(text)) fail('I1', `${file} contains what looks like a Resend API key literal`)
      if (KEY_ASSIGNMENT.test(text)) fail('I1', `${file} assigns a literal value to RESEND_INVITES_API_KEY`)
    }
  }
  for (const file of srcFiles) {
    if (tree.read(file).includes('RESEND_INVITES_API_KEY')) fail('I1', `${file}: the browser must never reference RESEND_INVITES_API_KEY`)
  }
  for (const file of tree.list('supabase/functions')) {
    if (file === FN_INDEX) continue
    if (code(tree.read(file)).includes('RESEND_INVITES_API_KEY')) fail('I1', `${file} reads RESEND_INVITES_API_KEY; only ${FN_INDEX} may`)
  }
  const indexCode = code(index)
  const keyReads = indexCode.split('RESEND_INVITES_API_KEY').length - 1
  if (keyReads !== 1 || !/resendApiKey:\s*\(\)\s*=>\s*Deno\.env\.get\('RESEND_INVITES_API_KEY'\)/.test(indexCode)) {
    fail('I1', `${FN_INDEX} must read RESEND_INVITES_API_KEY exactly once, as resendApiKey: () => Deno.env.get('RESEND_INVITES_API_KEY')`)
  }
  if (/console\.[a-z]+\([^)]*(apiKey|resendApiKey|RESEND_INVITES_API_KEY|token|\.email)\b/.test(code(handler) + indexCode)) {
    fail('I1', 'the Edge Function logs a key, token or email')
  }

  // ── I2 — no productive link from the tab origin ──────────────────────────
  for (const file of srcFiles) {
    const text = code(tree.read(file))
    if (text.includes('accept-invite?token=')) fail('I2', `${file} builds an invitation link by hand; use src/lib/invitationLink.ts`)
    if (file !== WEB_LINK && /window\.location\.origin/.test(text) && /accept-invite|invitationUrl|invitationPath|acceptInviteePath/.test(text)) {
      fail('I2', `${file} mixes window.location.origin with invitation links`)
    }
  }
  const webCode = code(webLink)
  if (!/from '\.\.\/\.\.\/supabase\/functions\/_shared\/invitationLink\.ts'/.test(webCode)) {
    fail('I2', `${WEB_LINK} must wrap ${SHARED_LINK}`)
  }
  if (!/mode === 'production'/.test(webCode) || !/runtime\.mode === 'production' \? null/.test(webCode)) {
    fail('I2', `${WEB_LINK} must ignore the tab origin in production builds`)
  }
  if (/window\.location\.origin/.test(code(page)) || !/invitationUrl\(/.test(code(page))) {
    fail('I2', `${USERS_PAGE} must show and copy links through invitationUrl(), never window.location.origin`)
  }

  // ── I3 — the shared link module ───────────────────────────────────────────
  const sharedCode = code(shared)
  if (!/export const CANONICAL_APP_ORIGIN = 'https:\/\/www\.techrepairpro\.app'/.test(sharedCode)) {
    fail('I3', `${SHARED_LINK} must pin CANONICAL_APP_ORIGIN to https://www.techrepairpro.app`)
  }
  if (/^\s*import\s/m.test(sharedCode) || /Deno\.|window\.|process\.|import\.meta/.test(sharedCode)) {
    fail('I3', `${SHARED_LINK} must stay pure (no imports, env or globals)`)
  }
  if (/clicmayorista|vercel\.app|supabase\.co|SITE_URL|redirect/i.test(sharedCode)) {
    fail('I3', `${SHARED_LINK} references a non-canonical domain or redirect`)
  }
  if (!/encodeURIComponent\(/.test(sharedCode) || !/return loopbackOrigin\(override\) \?\? CANONICAL_APP_ORIGIN/.test(sharedCode)) {
    fail('I3', `${SHARED_LINK} must encode the token and fall back to the canonical origin unless the override is loopback`)
  }

  // ── I4 — recipient and token come from the DB row ────────────────────────
  const handlerCode = code(handler)
  if (!/create_and_send:\s*\['action', 'email', 'role'\]/.test(handlerCode) || !/resend:\s*\['action', 'invitation_id'\]/.test(handlerCode)) {
    fail('I4', `${FN_HANDLER} must keep the strict field allowlist (create: action/email/role; resend: action/invitation_id)`)
  }
  if (/body\.(token|to|recipient|business_id|businessId|link|url)\b/.test(handlerCode)) {
    fail('I4', `${FN_HANDLER} reads a recipient, token, link or business from the request body`)
  }
  if (!/scope\.rpc\('create_business_invitation', \{ p_email: email, p_role: role \}\)/.test(handlerCode)) {
    fail('I4', `${FN_HANDLER} must create through create_business_invitation({ p_email, p_role }) only`)
  }
  if (!/to: row\.email/.test(handlerCode) || !/buildInvitationUrl\(row\.token, deps\.appOrigin\)/.test(handlerCode)) {
    fail('I4', `${FN_HANDLER} must take the recipient (row.email) and the link token (row.token) from the DB row`)
  }
  const recipients = [...handlerCode.matchAll(/\bto:\s*([^,\n}]+)/g)].map((m) => m[1].trim())
  if (recipients.length !== 1 || recipients[0] !== 'row.email') {
    fail('I4', `${FN_HANDLER} must have exactly one recipient, row.email (found: ${recipients.join(' | ') || 'none'})`)
  }

  // ── I5 — no service_role, no direct writes ───────────────────────────────
  for (const file of fnFiles) {
    const text = code(tree.read(file))
    if (/SERVICE_ROLE|service_role|SUPABASE_SECRET_KEYS|sb_secret_/.test(text)) fail('I5', `${file} uses a service credential; this function is user-scoped only`)
    if (/\.(insert|update|upsert|delete)\(/.test(text)) fail('I5', `${file} writes a table directly; the DB authority is the RPC`)
  }
  for (const file of srcFiles) {
    if (/SERVICE_ROLE_KEY|sb_secret_/.test(code(tree.read(file)))) fail('I5', `${file}: service_role never reaches the browser`)
  }

  // ── I6 — verify_jwt=false only with in-function JWT validation ───────────
  const section = config.match(/\[functions\.send-business-invitation\]\s*\n\s*verify_jwt\s*=\s*(true|false)/)
  if (!section || section[1] !== 'false') fail('I6', `${CONFIG} must declare [functions.send-business-invitation] verify_jwt = false`)
  const bearerAt = handlerCode.indexOf("req.headers.get('Authorization')")
  const actorAt = handlerCode.indexOf('await resolveActor(scope)')
  const bodyAt = handlerCode.indexOf('await req.text()')
  if (bearerAt < 0 || actorAt < 0 || bodyAt < 0 || !(bearerAt < actorAt && actorAt < bodyAt)) {
    fail('I6', `${FN_HANDLER} must validate the Bearer JWT and the actor before reading the body`)
  }
  if (!/auth\.getUser\(jwt\)/.test(indexCode) || !/handleInvitationRequest\(req,/.test(indexCode)) {
    fail('I6', `${FN_INDEX} must validate the JWT with GoTrue (auth.getUser(jwt)) and route through the handler`)
  }
  if (!/import \{ computeAllowedOrigins, createCors \} from '\.\.\/_shared\/scopedCors\.ts'/.test(indexCode)
      || !/createCors\(computeAllowedOrigins\(devOrigin \? \[devOrigin\] : \[\]\)\)/.test(indexCode)) {
    fail('I6', `${FN_INDEX} must answer CORS through _shared/scopedCors.ts with the canonical list plus a loopback-only dev origin`)
  }
  if (/APP_URL|clicmayorista|EXTRA_ORIGINS/.test(indexCode)) fail('I6', `${FN_INDEX} widens CORS beyond TechRepair`)

  // ── I7 — template and transport hygiene ──────────────────────────────────
  const emailCode = code(email)
  if (!/export const INVITATION_FROM = 'TechRepair Pro <no-reply@techrepairpro\.app>'/.test(emailCode)) {
    fail('I7', `${FN_EMAIL} must send From "TechRepair Pro <no-reply@techrepairpro.app>"`)
  }
  if (/<img|CONTACTO_SOPORTE|soporte@|reply[-_]to|utm_|pixel|open_track|click_track/i.test(emailCode)) {
    fail('I7', `${FN_EMAIL} adds images, tracking, Reply-To or the support mailbox`)
  }
  if (!/escapeHtml\(name\)/.test(emailCode) || !/escapeHtml\(input\.acceptUrl\)/.test(emailCode)) {
    fail('I7', `${FN_EMAIL} must escape every dynamic value before it enters the HTML`)
  }
  const deliveryCode = code(delivery)
  const payload = deliveryCode.match(/body: JSON\.stringify\(\{([\s\S]*?)\}\)/)?.[1] ?? ''
  const keys = [...payload.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]).sort().join(',')
  if (keys !== 'from,html,subject,text,to') fail('I7', `${FN_DELIVERY} provider payload must be exactly from/to/subject/html/text (found: ${keys || 'none'})`)
  if (!/'Idempotency-Key': idempotencyKey/.test(deliveryCode)) fail('I7', `${FN_DELIVERY} must send an Idempotency-Key`)
  if (!/createIdempotencyKey\(row\.id\)/.test(handlerCode) || !/resendIdempotencyKey\(row\.id, deps\.now\(\)\)/.test(handlerCode)) {
    fail('I7', `${FN_HANDLER} must key create by invitation and resend by invitation + minute`)
  }

  // ── I8 — one browser caller ──────────────────────────────────────────────
  for (const file of srcFiles) {
    if (file === WEB_SERVICE) continue
    if (tree.read(file).includes('send-business-invitation')) fail('I8', `${file} calls send-business-invitation; go through ${WEB_SERVICE}`)
  }
  if ((code(service).match(/functions\.invoke\('send-business-invitation'/g) ?? []).length !== 1) {
    fail('I8', `${WEB_SERVICE} must invoke send-business-invitation from exactly one place`)
  }

  return errors
}

function selfTest() {
  const base = diskTree(ROOT)
  const baseline = check(base)
  if (baseline.length) {
    console.error('self-test: the real tree must pass first:\n  ' + baseline.join('\n  '))
    process.exit(1)
  }
  const mutate = (rel, from, to) => {
    const text = base.read(rel)
    if (!text.includes(from)) throw new Error(`self-test mutation did not apply in ${rel}: ${from}`)
    return [rel, text.replace(from, to)]
  }
  const fakeKey = ['re', 'Abc12345', 'ZyXwVuTsRqPoNmLkJiHgFeDc'].join('_')
  const cases = [
    ['a Resend key literal in a doc', 'I1', [['docs/pre-beta-2/__leak.md', `RESEND key: ${fakeKey}\n`]]],
    ['a literal assigned to the secret', 'I1', [['docs/pre-beta-2/__leak.md', 'supabase secrets set RESEND_INVITES_API_KEY=abcdefghijklmnopqrst\n']]],
    ['the browser reads the secret', 'I1', [['src/lib/__leak.ts', "export const k = import.meta.env.RESEND_INVITES_API_KEY\n"]]],
    ['another function reads the secret', 'I1', [['supabase/functions/__other/index.ts', "const k = Deno.env.get('RESEND_INVITES_API_KEY')\n"]]],
    ['the handler logs the token', 'I1', [mutate(FN_HANDLER, '  try {\n    deps.log({', '  console.log(row.token)\n  try {\n    deps.log({')]],
    ['UsersManagement builds the link from the tab origin', 'I2', [mutate(USERS_PAGE, '{invitationUrl(inv.token)}', '{`${window.location.origin}/accept-invite?token=${inv.token}`}')]],
    ['a page hand-builds accept-invite?token=', 'I2', [['src/pages/__x.tsx', "const u = `/accept-invite?token=${t}`\n"]]],
    ['the web wrapper trusts the tab in production', 'I2', [mutate(WEB_LINK, "runtime.mode === 'production' ? null : runtime.origin", 'runtime.origin')]],
    ['canonical origin changes', 'I3', [mutate(SHARED_LINK, "'https://www.techrepairpro.app'", "'https://techrepairpro.app'")]],
    ['shared link reads env', 'I3', [mutate(SHARED_LINK, 'export function resolveInvitationOrigin', "const X = Deno.env.get('SITE_URL')\nexport function resolveInvitationOrigin")]],
    ['shared link accepts any override', 'I3', [mutate(SHARED_LINK, 'return loopbackOrigin(override) ?? CANONICAL_APP_ORIGIN', 'return override ?? CANONICAL_APP_ORIGIN')]],
    ['resend accepts a recipient field', 'I4', [mutate(FN_HANDLER, "resend: ['action', 'invitation_id'],", "resend: ['action', 'invitation_id', 'email'],")]],
    ['handler sends to the request email', 'I4', [mutate(FN_HANDLER, 'to: row.email,', 'to: String(body.to),')]],
    ['handler uses a request token', 'I4', [mutate(FN_HANDLER, 'buildInvitationUrl(row.token, deps.appOrigin)', 'buildInvitationUrl(String(body.token), deps.appOrigin)')]],
    ['handler inserts the invitation itself', 'I5', [mutate(FN_HANDLER, "created = await scope.rpc('create_business_invitation', { p_email: email, p_role: role })", "created = await scope.from('business_invitations').insert({ email })")]],
    ['index uses service_role', 'I5', [mutate(FN_INDEX, "const anonKey = Deno.env.get('SUPABASE_ANON_KEY')", "const anonKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')")]],
    ['browser gets a service key', 'I5', [['src/lib/__admin.ts', 'export const k = import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY\n']]],
    ['config flips verify_jwt', 'I6', [mutate(CONFIG, '[functions.send-business-invitation]\nverify_jwt = false', '[functions.send-business-invitation]\nverify_jwt = true')]],
    ['body read before the actor', 'I6', [mutate(FN_HANDLER, '  const resolved = await resolveActor(scope)', "  await req.text()\n  const resolved = await resolveActor(scope)")]],
    ['CORS gains APP_URL', 'I6', [mutate(FN_INDEX, 'createCors(computeAllowedOrigins(devOrigin ? [devOrigin] : []))', "createCors(computeAllowedOrigins(devOrigin ? [devOrigin] : [Deno.env.get('APP_URL')]))")]],
    ['From changes', 'I7', [mutate(FN_EMAIL, "'TechRepair Pro <no-reply@techrepairpro.app>'", "'TechRepair <hola@techrepairpro.app>'")]],
    ['template gains a tracking image', 'I7', [mutate(FN_EMAIL, '<p style="margin:0 0 24px 0;', '<img src="https://x.example/p.gif"><p style="margin:0 0 24px 0;')]],
    ['business name unescaped', 'I7', [mutate(FN_EMAIL, 'const nameHtml = escapeHtml(name)', 'const nameHtml = name')]],
    ['payload gains reply_to', 'I7', [mutate(FN_DELIVERY, '        text: email.text,\n', '        text: email.text,\n        reply_to: email.to,\n')]],
    ['no Idempotency-Key', 'I7', [mutate(FN_DELIVERY, "        'Idempotency-Key': idempotencyKey,\n", '')]],
    ['resend keyed like create', 'I7', [mutate(FN_HANDLER, 'resendIdempotencyKey(row.id, deps.now())', 'createIdempotencyKey(row.id)')]],
    ['a page calls the Edge Function directly', 'I8', [mutate(USERS_PAGE, "import { invitationUrl } from '../lib/invitationLink';", "import { invitationUrl } from '../lib/invitationLink';\nvoid supabase.functions.invoke('send-business-invitation', { body: {} });")]],
  ]
  let failed = 0
  for (const [name, rule, overrides] of cases) {
    const errors = check(overlayTree(base, new Map(overrides)))
    const ok = errors.some((e) => e.startsWith(`${rule}:`))
    if (!ok) failed++
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} → expected ${rule}${ok ? '' : `, got: ${errors.join(' | ') || 'no error'}`}`)
  }
  console.log(`self-test: ${cases.length - failed}/${cases.length} mutations detected`)
  process.exit(failed ? 1 : 0)
}

if (process.argv.includes('--self-test')) selfTest()
else {
  const errors = check(diskTree(ROOT))
  if (errors.length) {
    console.error('invitation-email-delivery: FAIL\n  ' + errors.join('\n  '))
    process.exit(1)
  }
  console.log('invitation-email-delivery: OK — key never literal/browser-side, canonical link single-sourced, recipient/token from the DB row, user-scoped only, JWT before body, clean template, Idempotency-Key on every send')
}
