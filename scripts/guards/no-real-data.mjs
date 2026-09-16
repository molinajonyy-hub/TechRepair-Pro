#!/usr/bin/env node
/**
 * BETA-GATE-1 · Lote D — no real personal/fiscal identifiers in the repository.
 *
 * The GitHub repository is PUBLIC. Lote D removed from HEAD the identifiers of the real production owner
 * that had leaked into development material: their personal email, the ARCA alias (WSASS device name)
 * and the CUIT emisor of their tenant (docs, a tutorial mock and two test fixtures). This guard keeps
 * them from coming back. It is NOT a generic PII or secret scanner, on purpose: it only knows the
 * identifiers that were actually removed, so it has no false positives to triage.
 *
 * Design
 *   · The identifiers are NOT stored in plaintext (that would re-publish them). Each rule is the SHA-256
 *     of a domain-separated, normalized value. Low-entropy values (a DNI) can be brute-forced from a
 *     digest; that is accepted: the values stay in git history by explicit decision (no history
 *     rewrite), so the digest adds no exposure. It only keeps them out of HEAD, search and code review.
 *   · Candidates come from narrow tokenizers per category, are normalized (case, separators, the known
 *     variants) and hashed:
 *       email             exact address, case-insensitive, `+tag` removed; for gmail also dot-insensitive
 *       email-local-part  the email's user part with a separator (`a.b`, `a_b`, `a-b`), any case
 *       alias-arca        the ARCA alias with or without separators, any case
 *       cuit              11 digits, with or without `-`, `.` or space between the 2-8-1 groups
 *       dni               the 8-digit DNI embedded in that CUIT, with or without thousands dots
 *   · Exactly ONE exception: the archived legacy data migration that already ran in production. Git
 *     history is not rewritten, and that file is the evidence of what ran. The exception is pinned by
 *     exact path + SHA-256 of the file + allowed categories (email only). If the file changes, the
 *     exception stops applying and the guard fails.
 *   · Output shows path:line and category. The matched value is never printed.
 *
 * Usage
 *   node scripts/guards/no-real-data.mjs                       scan tracked files (git ls-files)
 *   node scripts/guards/no-real-data.mjs --self-test           planted violations + synthetic data + exception
 *   node scripts/guards/no-real-data.mjs --verify-removed      proves the REAL rules match the values that
 *                                                              were removed, reading them from the pre-Lote-D
 *                                                              commit (git object; needs that commit fetched)
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Last commit that still contained the values in HEAD (the base of Lote D). Used only by --verify-removed. */
export const PRE_SANITIZATION_COMMIT = 'c90a4edf875ac3877f33e297543ff49246a869c0'

export function digest(category, normalized) {
  return createHash('sha256').update(`techrepair:no-real-data:v1:${category}:${normalized}`).digest('hex')
}

/**
 * The removed identifiers, as digests only. `lengths` are the normalized lengths, used to skip hashing
 * every token in the repository (they reveal nothing useful).
 */
export const REAL_RULES = {
  email: {
    label: 'email personal del titular real',
    digests: new Set(['085acf05e77db24b7e0fcc754dea2d974c89074e8f9a3d90c8da069eaca14daf']),
  },
  'email-gmail-canonical': {
    label: 'email personal del titular real (variante gmail)',
    digests: new Set(['91e4b797b446bbe2d116992cfacae2303bec8ede960e27def47c22b8c8838c02']),
  },
  'email-local-part': {
    label: 'usuario del email personal del titular real',
    digests: new Set(['a8802b8934ecc4ce436defc5d8fdaa98e99ccf315e755b59f0beb1ea81e6c135']),
    lengths: new Set([11]),
  },
  'alias-arca': {
    label: 'alias ARCA real (nombre de equipo WSASS) del tenant productivo',
    digests: new Set(['2d7272fc993f22c8ebb9b1b04c861857f27ba84477d5bf1aa12b8ac246f9ce63']),
    lengths: new Set([12]),
  },
  cuit: {
    label: 'CUIT emisor real del tenant productivo',
    digests: new Set(['fb1b02e0c646bcf139cf70f096bd3f422c3c633b0b62b657c7229e2596c642d7']),
  },
  dni: {
    label: 'DNI contenido en el CUIT emisor real',
    digests: new Set(['66806487972c85d17e03fd37a7922bbc63c71158c18b20d2460a0a30cead1900']),
  },
}

/** The ONLY approved exception. Exact path, pinned content, and only the categories that file really has. */
export const APPROVED_EXCEPTIONS = [
  {
    path: 'supabase/migrations/_legacy/20260626174811_owner_system_owner_activation.sql',
    sha256: '6cae5c33c0387d97df0fcae268a7098fb65051a378d4615069dae888fb0f9905',
    categories: new Set(['email', 'email-gmail-canonical', 'email-local-part']),
    reason: 'migración de datos histórica, ya aplicada en producción; no se reescribe historia (BETA-GATE-1 Lote D)',
  },
]

// ── Tokenizers ──────────────────────────────────────────────────────────────────

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const WORD_RE = /[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?/g
const CUIT_RE = /(?<![0-9])(\d{2})[-. ]?(\d{8})[-. ]?(\d)(?![0-9])/g
const DNI_RE = /(?<![0-9])(\d{2})\.?(\d{3})\.?(\d{3})(?![0-9])/g

const collapse = (s) => s.toLowerCase().replace(/[._-]/g, '')

/** Yields { category, normalized, index } candidates for one line. */
function* candidates(line) {
  for (const m of line.matchAll(EMAIL_RE)) {
    const [rawLocal, rawDomain] = m[0].toLowerCase().split('@')
    const local = rawLocal.split('+')[0]
    yield { category: 'email', normalized: `${local}@${rawDomain}`, index: m.index }
    if (rawDomain === 'gmail.com' || rawDomain === 'googlemail.com') {
      yield { category: 'email-gmail-canonical', normalized: `${local.replace(/\./g, '')}@gmail.com`, index: m.index }
    }
  }
  for (const m of line.matchAll(WORD_RE)) {
    const parts = m[0].split(/[._-]+/).filter(Boolean)
    // Every window of up to 3 consecutive parts: catches the value inside dotted paths or hostnames too.
    for (let i = 0; i < parts.length; i++) {
      for (let size = 1; size <= 3 && i + size <= parts.length; size++) {
        const joined = parts.slice(i, i + size).join('').toLowerCase()
        yield { category: 'alias-arca', normalized: joined, index: m.index }
        if (size > 1) yield { category: 'email-local-part', normalized: joined, index: m.index }
      }
    }
  }
  for (const m of line.matchAll(CUIT_RE)) {
    yield { category: 'cuit', normalized: `${m[1]}${m[2]}${m[3]}`, index: m.index }
  }
  for (const m of line.matchAll(DNI_RE)) {
    yield { category: 'dni', normalized: `${m[1]}${m[2]}${m[3]}`, index: m.index }
  }
}

// ── Engine ────────────────────────────────────────────────────────────────────

/**
 * @param files      Array<{ path: string, text: string, sha256?: string }>
 * @param rules      same shape as REAL_RULES
 * @param exceptions same shape as APPROVED_EXCEPTIONS
 * @returns {{ findings: Array<{path, line, category, label}>, errors: string[] }}
 */
export function check(files, rules = REAL_RULES, exceptions = APPROVED_EXCEPTIONS) {
  const findings = []
  const errors = []
  const cache = new Map()
  const hit = (category, normalized) => {
    const rule = rules[category]
    if (!rule) return false
    if (rule.lengths && !rule.lengths.has(normalized.length)) return false
    const key = `${category}|${normalized}`
    if (!cache.has(key)) cache.set(key, rule.digests.has(digest(category, normalized)))
    return cache.get(key)
  }

  for (const file of files) {
    const exception = exceptions.find((e) => e.path === file.path)
    let allowed = new Set()
    if (exception) {
      const actual = file.sha256 ?? createHash('sha256').update(file.text).digest('hex')
      if (actual === exception.sha256) allowed = exception.categories
      else errors.push(`${file.path}: la excepción aprobada ya no aplica, el archivo cambió (sha256 ${actual.slice(0, 12)}… != ${exception.sha256.slice(0, 12)}…)`)
    }
    const seen = new Set()
    const lines = file.text.split(/\r?\n/)
    for (let n = 0; n < lines.length; n++) {
      for (const c of candidates(lines[n])) {
        if (!hit(c.category, c.normalized) || allowed.has(c.category)) continue
        const key = `${n}:${c.category}`
        if (seen.has(key)) continue
        seen.add(key)
        findings.push({ path: file.path, line: n + 1, category: c.category, label: rules[c.category].label })
      }
    }
  }
  return { findings, errors }
}

/** Never prints the matched value: only where and what kind. */
export function formatReport({ findings, errors }) {
  const out = []
  for (const e of errors) out.push(`  EXCEPCIÓN  ${e}`)
  for (const f of findings) out.push(`  ${f.path}:${f.line}  [${f.category}]  ${f.label} (valor oculto)`)
  return out.join('\n')
}

// ── Repository scan ─────────────────────────────────────────────────────────────

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|wav|p12|pfx|der|keystore|jar|wasm)$/i

export function trackedTextFiles(root = ROOT) {
  const list = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 64 << 20 }).toString('utf8').split('\0').filter(Boolean)
  const files = []
  for (const path of list) {
    if (BINARY_EXT.test(path)) continue
    let bytes
    try { bytes = readFileSync(join(root, path)) } catch { continue } // deleted in the working tree
    if (bytes.subarray(0, 8000).includes(0)) continue
    files.push({ path, text: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  return files
}

// ── Self-test ─────────────────────────────────────────────────────────────────

/**
 * Synthetic stand-ins for the engine tests. Clearly fake: `example`-style names, CUIT type prefix 99
 * (does not exist) and a DNI of zeros. They exercise exactly the same normalization as the real rules.
 */
const FAKE = {
  email: 'persona.ficticia@gmail.com',
  alias: 'alias.ficticio7',
  cuit: '99-00000042-7',
}

function fakeRules() {
  const [local, domain] = FAKE.email.split('@')
  const cuitDigits = FAKE.cuit.replace(/\D/g, '')
  return {
    email: { label: 'fake email', digests: new Set([digest('email', `${local}@${domain}`)]) },
    'email-gmail-canonical': { label: 'fake email gmail', digests: new Set([digest('email-gmail-canonical', `${local.replace(/\./g, '')}@gmail.com`)]) },
    'email-local-part': { label: 'fake local part', digests: new Set([digest('email-local-part', collapse(local))]), lengths: new Set([collapse(local).length]) },
    'alias-arca': { label: 'fake alias', digests: new Set([digest('alias-arca', collapse(FAKE.alias))]), lengths: new Set([collapse(FAKE.alias).length]) },
    cuit: { label: 'fake cuit', digests: new Set([digest('cuit', cuitDigits)]) },
    dni: { label: 'fake dni', digests: new Set([digest('dni', cuitDigits.slice(2, 10))]) },
  }
}

const sha = (text) => createHash('sha256').update(text).digest('hex')
const cats = (result) => [...new Set(result.findings.map((f) => f.category))].sort()

function selfTest() {
  const rules = fakeRules()
  const EXEMPT = 'supabase/migrations/_legacy/00000000000000_fixture.sql'
  const exemptText = `-- fixture\nv_email text := '${FAKE.email}';\n`
  const exceptions = [{ path: EXEMPT, sha256: sha(exemptText), categories: new Set(['email', 'email-gmail-canonical', 'email-local-part']) }]
  const run = (path, text, ex = exceptions) => check([{ path, text }], rules, ex)

  const cases = [
    // 1–2. email + variants
    ['email exacto bloqueado', () => run('docs/a.md', `owner: ${FAKE.email}`), (r) => cats(r).includes('email')],
    ['email en MAYÚSCULAS bloqueado', () => run('docs/a.md', FAKE.email.toUpperCase()), (r) => cats(r).includes('email')],
    ['email con +tag bloqueado', () => run('docs/a.md', 'persona.ficticia+beta@gmail.com'), (r) => cats(r).includes('email')],
    ['email gmail sin puntos bloqueado', () => run('docs/a.md', 'personaficticia@gmail.com'), (r) => cats(r).includes('email-gmail-canonical')],
    ['usuario del email con otro separador bloqueado', () => run('src/a.ts', "const u = 'Persona_Ficticia'"), (r) => cats(r).includes('email-local-part')],
    // 3–4. alias + variants
    ['alias exacto bloqueado', () => run('src/pages/X.tsx', `value: '${FAKE.alias}'`), (r) => cats(r).includes('alias-arca')],
    ['alias en MAYÚSCULAS bloqueado', () => run('tests/a.sql', FAKE.alias.toUpperCase()), (r) => cats(r).includes('alias-arca')],
    ['alias sin separador bloqueado', () => run('tests/a.sql', 'aliasficticio7'), (r) => cats(r).includes('alias-arca')],
    ['alias con guion bajo bloqueado', () => run('tests/a.sql', 'alias_ficticio7'), (r) => cats(r).includes('alias-arca')],
    ['alias dentro de una ruta con puntos bloqueado', () => run('docs/a.md', 'docs/alias.ficticio7.md'), (r) => cats(r).includes('alias-arca')],
    // 5. CUIT + variants
    ['CUIT con guiones bloqueado', () => run('src/a.tsx', FAKE.cuit), (r) => cats(r).includes('cuit')],
    ['CUIT sin guiones bloqueado', () => run('src/a.tsx', 'cuit 99000000427'), (r) => cats(r).includes('cuit')],
    ['CUIT con espacios o puntos bloqueado', () => run('docs/a.md', '99 00000042 7 / 99.00000042.7'), (r) => cats(r).includes('cuit')],
    ['DNI del CUIT bloqueado', () => run('docs/a.md', 'DNI 00.000.042'), (r) => cats(r).includes('dni')],
    // 6. synthetic data allowed / no false positives
    ['datos sintéticos permitidos', () => run('docs/a.md', 'usuario.qa@example.com aliasdemohomo techrepairdemo 20-00000000-0 Empresa Demo Usuario Demo'), (r) => r.findings.length === 0],
    ['handle con sufijo distinto permitido', () => run('docs/a.md', 'https://github.com/personaficticia-hub/repo'), (r) => r.findings.length === 0],
    ['el usuario sin separador no se confunde con el handle', () => run('docs/a.md', 'personaficticia'), (r) => r.findings.length === 0],
    ['CUIT dentro de una tira de dígitos más larga permitido', () => run('docs/a.md', 'id 1990000004271'), (r) => !cats(r).includes('cuit')],
    // 7. exception
    ['excepción exacta permitida', () => run(EXEMPT, exemptText), (r) => r.findings.length === 0 && r.errors.length === 0],
    ['mismo contenido en otra ruta de _legacy falla', () => run('supabase/migrations/_legacy/00000000000001_other.sql', exemptText), (r) => cats(r).includes('email')],
    ['mismo contenido en una ruta parecida falla', () => run(`${EXEMPT}.bak`, exemptText), (r) => cats(r).includes('email')],
    ['la excepción no aplica si el archivo cambia', () => run(EXEMPT, `${exemptText}-- editado\n`), (r) => r.errors.length === 1 && cats(r).includes('email')],
    ['la excepción no cubre categorías que ese archivo no tenía', () => {
      const text = `${exemptText}-- ${FAKE.cuit}\n`
      return run(EXEMPT, text, [{ ...exceptions[0], sha256: sha(text) }])
    }, (r) => cats(r).includes('cuit') && !cats(r).includes('email')],
    // 8. output never prints the value
    ['el reporte nunca imprime el valor', () => run('docs/a.md', `${FAKE.email} ${FAKE.alias} ${FAKE.cuit}`), (r) => {
      const report = formatReport(r)
      return r.findings.length >= 3 && ![FAKE.email, FAKE.alias, FAKE.cuit, '99000000427', 'persona.ficticia'].some((v) => report.toLowerCase().includes(v))
    }],
  ]

  let failed = 0
  for (const [name, act, ok] of cases) {
    let pass = false
    try { pass = ok(act()) } catch (e) { pass = false; console.log(`     error: ${e.message}`) }
    if (!pass) failed++
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`)
  }

  // REAL rules, in CI, with no plaintext in the repo: the approved legacy file is the one in-tree source
  // of the real email. Its content must pass at its exact path and fail anywhere else.
  const legacy = APPROVED_EXCEPTIONS[0]
  let legacyText = null
  try { legacyText = readFileSync(join(ROOT, legacy.path)) } catch { /* reported below */ }
  const realCases = [
    ['REAL: la migración _legacy aprobada existe y está intacta', () => legacyText !== null && sha(legacyText) === legacy.sha256],
    ['REAL: su contenido pasa en la ruta exacta aprobada', () => {
      const r = check([{ path: legacy.path, text: legacyText.toString('utf8') }])
      return r.findings.length === 0 && r.errors.length === 0
    }],
    ['REAL: el mismo contenido fuera de la excepción falla por el email real', () => {
      const r = check([{ path: 'docs/reintroducido.md', text: legacyText.toString('utf8') }])
      return cats(r).includes('email') && !formatReport(r).includes('@gmail')
    }],
  ]
  for (const [name, ok] of realCases) {
    let pass = false
    try { pass = ok() } catch { pass = false }
    if (!pass) failed++
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`)
  }

  // Zero false positives on the sanitized HEAD.
  const head = check(trackedTextFiles())
  const clean = head.findings.length === 0 && head.errors.length === 0
  if (!clean) { failed++; console.log(formatReport(head)) }
  console.log(`${clean ? 'ok  ' : 'FAIL'} HEAD saneado: cero coincidencias fuera de la excepción`)

  const total = cases.length + realCases.length + 1
  console.log(`self-test: ${total - failed}/${total}`)
  process.exit(failed ? 1 : 0)
}

// ── --verify-removed ──────────────────────────────────────────────────────────

/**
 * Reads the removed values from the pre-sanitization commit (git object, in memory, never printed) and
 * proves the REAL rules block each of them, plus their variants, anywhere outside the exception.
 * Exit 2 if the commit is not available locally (shallow clone): fetch it first.
 */
function verifyRemoved(commit = PRE_SANITIZATION_COMMIT) {
  const show = (path) => execFileSync('git', ['show', `${commit}:${path}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] })
  let tutorial, invitations
  try {
    tutorial = show('src/pages/Tutorials.tsx')
    invitations = show('docs/p0-p2-invitations.md')
  } catch {
    console.error(`verify-removed: el commit ${commit.slice(0, 12)} no está disponible. Traelo con: git fetch --no-tags --depth=1 origin ${commit}`)
    process.exit(2)
  }
  const alias = tutorial.match(/label: 'Representante \(alias\)', value: '([^']+)'/)?.[1]
  const cuit = tutorial.match(/label: 'Representado \(CUIT\)', value: '([^']+)'/)?.[1]
  const email = invitations.match(/\*\*Owner\*\*: `([^`]+@[^`]+)`/)?.[1]
  const checks = [
    ['alias ARCA real', alias, 'alias-arca', (v) => [v, v.toUpperCase(), v.replace(/\./g, ''), v.replace(/\./g, '_')]],
    ['CUIT real', cuit, 'cuit', (v) => [v, v.replace(/\D/g, ''), v.replace(/-/g, ' '), v.replace(/-/g, '.')]],
    ['DNI del CUIT real', cuit, 'dni', (v) => [v.replace(/\D/g, '').slice(2, 10)]],
    ['email real', email, 'email', (v) => [v, v.toUpperCase(), v.replace('@', '+qa@')]],
    ['usuario del email real', email, 'email-local-part', (v) => [v.split('@')[0], v.split('@')[0].replace(/\./g, '_')]],
  ]
  let failed = 0
  for (const [name, value, category, variants] of checks) {
    let pass = Boolean(value)
    if (pass) {
      for (const variant of variants(value)) {
        const r = check([{ path: 'docs/reintroducido.md', text: `texto ${variant} texto` }])
        const leaked = formatReport(r).toLowerCase().includes(variant.toLowerCase())
        if (!cats(r).includes(category) || leaked) pass = false
      }
    }
    if (!pass) failed++
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}: bloqueado con sus variantes (leído de ${commit.slice(0, 12)}, no se imprime)`)
  }
  console.log(`verify-removed: ${checks.length - failed}/${checks.length}`)
  process.exit(failed ? 1 : 0)
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--self-test')) selfTest()
  else if (process.argv.includes('--verify-removed')) verifyRemoved()
  else {
    const files = trackedTextFiles()
    const result = check(files)
    if (result.findings.length || result.errors.length) {
      console.error(
        'no-real-data: FAIL — datos reales del titular/tenant productivo en el repositorio (público).\n' +
        formatReport(result) + '\n' +
        'Reemplazalos por datos sintéticos (p. ej. usuario.qa@example.com, aliasdemohomo, 20-00000000-0).\n' +
        'La única excepción aprobada es la migración _legacy histórica, por ruta exacta y contenido fijado.',
      )
      process.exit(1)
    }
    console.log(`no-real-data: OK — ${files.length} archivos de texto versionados, 0 coincidencias; excepción aprobada: ${APPROVED_EXCEPTIONS.map((e) => e.path).join(', ')}`)
  }
}
