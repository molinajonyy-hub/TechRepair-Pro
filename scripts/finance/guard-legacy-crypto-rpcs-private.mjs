#!/usr/bin/env node
// ============================================================================
// Guard — encrypt_data / decrypt_data no vuelven a la API pública ni reabren el
// oráculo cripto legacy.
//
// La migración 20260721120000 neutralizó ambos cuerpos (stubs fail-closed) y
// revocó EXECUTE de PUBLIC/anon/authenticated/service_role. Este guard, estático
// sobre las migraciones, FALLA si un cambio futuro:
//   · vuelve a otorgar EXECUTE a PUBLIC/anon/authenticated/service_role;
//   · crea una nueva función pública o una sobrecarga con esos nombres sin cerrar;
//   · reintroduce pgp_sym_encrypt/pgp_sym_decrypt en el cuerpo EFECTIVO (último);
//   · reintroduce la clave legacy (detectada por fingerprint irreversible) en el
//     cuerpo efectivo o en cualquier migración nueva.
//
// PERMITE:
//   · los stubs fail-closed aprobados (RAISE LEGACY_CRYPTO_RPC_RETIRED);
//   · CREATE OR REPLACE de la misma firma (cuerpo nuevo que no reabre nada);
//   · funciones cripto NUEVAS en OTRO esquema (solo se inspecciona public.*).
//
// SEMÁNTICA PG (igual que el guard de register_order_payment): el EXECUTE por
// default a PUBLIC se otorga al CREAR una función NUEVA (firma inexistente / tras
// DROP / sobrecarga). CREATE OR REPLACE de una firma existente PRESERVA la ACL.
//
//   node scripts/finance/guard-legacy-crypto-rpcs-private.mjs [dir]
//   node scripts/finance/guard-legacy-crypto-rpcs-private.mjs --self-test
// ============================================================================
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'

const DIR = 'supabase/migrations'
const FNS = ['encrypt_data', 'decrypt_data']
const FORBIDDEN = ['public', 'anon', 'authenticated', 'service_role']
const KEY_FP = '1062de99c033e5b7'                       // hash truncado irreversible de la clave legacy
const BASELINE_ALLOWLIST = new Set(['20260628190324_remote_baseline.sql']) // historia inmutable ya aplicada

const fp16 = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16)

function stripComments(sql) {
  let out = '', i = 0
  while (i < sql.length) {
    if (sql.slice(i, i + 2) === '--') { const f = sql.indexOf('\n', i); const e = f === -1 ? sql.length : f; out += ' '.repeat(e - i); i = e; continue }
    if (sql.slice(i, i + 2) === '/*') { const f = sql.indexOf('*/', i + 2); const e = f === -1 ? sql.length : f + 2; out += ' '.repeat(e - i); i = e; continue }
    out += sql[i]; i++
  }
  return out
}

// Normaliza la lista de args a firma por tipos: "text". Acepta CREATE
// ("data_to_encrypt text") y GRANT/REVOKE ("text"). null → '*' = todas.
function sigOf(argspec) {
  if (argspec == null) return '*'
  const parts = argspec.replace(/"/g, '').split(',').map(s => s.trim()).filter(Boolean)
  if (!parts.length) return ''
  return parts.map(seg => {
    let t = seg.replace(/\bDEFAULT\b[\s\S]*$/i, '').trim().replace(/^\b(IN|OUT|INOUT|VARIADIC)\b\s+/i, '').trim()
    const toks = t.split(/\s+/)
    if (toks.length >= 2 && /^[a-z_]\w*$/i.test(toks[0]) &&
        !['double', 'character', 'timestamp', 'time', 'bit'].includes(toks[0].toLowerCase())) {
      return toks.slice(1).join(' ').toLowerCase()
    }
    return t.toLowerCase()
  }).join(',')
}

// Extrae el cuerpo dollar-quoted que sigue a `AS` desde la posición `from`.
function extractDollarBody(s, from) {
  const m = /\bAS\s+(\$[A-Za-z0-9_]*\$)/i.exec(s.slice(from))
  if (!m) return ''
  const tag = m[1]
  const start = from + m.index + m[0].length
  const end = s.indexOf(tag, start)
  return end === -1 ? s.slice(start) : s.slice(start, end)
}

// Analiza el corpus por función: estado final de ACL por firma + cuerpo efectivo.
// keyFp es el fingerprint (hash truncado) de la clave a detectar; parametrizado
// para que el self-test use una clave SINTÉTICA y la clave real nunca viva acá.
function analyze(files, keyFp) {
  // fn -> Map(sig -> { exists, roles:Set })
  const acl = new Map(FNS.map(fn => [fn, new Map()]))
  // fn -> Map(sig -> body) cuerpo efectivo (último CREATE)
  const bodies = new Map(FNS.map(fn => [fn, new Map()]))
  const keyInMigrations = []   // ocurrencias de la clave (por fingerprint) fuera del baseline

  const getAcl = (fn, sig) => { const m = acl.get(fn); if (!m.has(sig)) m.set(sig, { exists: false, roles: new Set() }); return m.get(sig) }

  const fnAlt = FNS.join('|')
  const re = new RegExp([
    `(?<drop>\\bDROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?(?:"?public"?\\.)?"?(?<dfn>${fnAlt})"?\\s*(?:\\((?<dargs>[^)]*)\\))?)`,
    `(?<create>\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:"?public"?\\.)?"?(?<cfn>${fnAlt})"?\\s*\\((?<cargs>[^)]*)\\))`,
    `(?<gr>\\b(?<kind>GRANT|REVOKE)\\s+(?<privs>[^;]*?)\\s+ON\\s+FUNCTION\\s+(?:"?public"?\\.)?"?(?<gfn>${fnAlt})"?\\s*(?:\\((?<gargs>[^)]*)\\))?\\s+(?<dir>TO|FROM)\\s+(?<roles>[^;]+);)`,
  ].join('|'), 'gi')

  for (const { name, sql } of files) {
    const isBaseline = BASELINE_ALLOWLIST.has(name)
    const s = stripComments(sql)

    // Escaneo de clave legacy por fingerprint en CUALQUIER literal (salvo baseline).
    if (!isBaseline) {
      const lit = /'([^']+)'/g; let lm
      while ((lm = lit.exec(s)) !== null) { if (fp16(lm[1]) === keyFp) keyInMigrations.push(name) }
    }

    let m
    while ((m = re.exec(s)) !== null) {
      const g = m.groups
      if (g.drop) { const o = getAcl(g.dfn, sigOf(g.dargs)); o.exists = false; o.roles.clear(); bodies.get(g.dfn).delete(sigOf(g.dargs)); continue }
      if (g.create) {
        const sig = sigOf(g.cargs); const o = getAcl(g.cfn, sig)
        if (!o.exists) { o.exists = true; o.roles = new Set(['public']) } else { o.exists = true }
        bodies.get(g.cfn).set(sig, extractDollarBody(s, m.index))     // cuerpo efectivo = último CREATE
        continue
      }
      if (g.gr) {
        const privs = g.privs.toLowerCase()
        if (!/\bexecute\b/.test(privs) && !/\ball\b/.test(privs)) continue
        const rs = g.roles.toLowerCase().split(/[\s,]+/).map(x => x.replace(/"/g, '').trim()).filter(Boolean)
        const sig = sigOf(g.gargs)
        const targets = sig === '*' ? [...acl.get(g.gfn).keys()] : [sig]
        for (const t of targets) {
          const o = getAcl(g.gfn, t)
          for (const rol of FORBIDDEN) {
            if (!rs.includes(rol)) continue
            if (/^GRANT$/i.test(g.kind)) o.roles.add(rol); else o.roles.delete(rol)
          }
        }
      }
    }
  }
  return { acl, bodies, keyInMigrations }
}

// Devuelve lista de hallazgos (strings). Vacío = OK.
// keyFp: fingerprint a detectar (default = clave legacy real). El self-test lo
// sobreescribe con un fingerprint SINTÉTICO para no versionar la clave real.
export function findings(files, keyFp = KEY_FP) {
  const { acl, bodies, keyInMigrations } = analyze(files, keyFp)
  const out = []
  for (const fn of FNS) {
    for (const [sig, o] of acl.get(fn)) {
      if (!o.exists) continue
      const exposed = [...o.roles].filter(r => FORBIDDEN.includes(r)).sort()
      if (exposed.length) out.push(`public.${fn}(${sig}) ejecutable por ${exposed.join(', ')}`)
      const body = bodies.get(fn).get(sig) || ''
      if (/pgp_sym_(en|de)crypt/i.test(body)) out.push(`public.${fn}(${sig}) reintroduce pgp_sym_* en el cuerpo`)
      const lit = /'([^']+)'/g; let lm
      while ((lm = lit.exec(body)) !== null) { if (fp16(lm[1]) === keyFp) out.push(`public.${fn}(${sig}) reintroduce la clave legacy en el cuerpo`) }
    }
  }
  for (const f of [...new Set(keyInMigrations)]) out.push(`clave legacy reintroducida (por fingerprint) en la migración ${f}`)
  return out
}

function selfTest() {
  // Clave SINTÉTICA (no es la real). Se prueba el MECANISMO de detección por
  // fingerprint contra SU propio fingerprint — la clave real NUNCA se versiona.
  const SYN_KEY = 'synthetic-legacy-key-for-self-test'
  const SYN_FP = fp16(SYN_KEY)
  const F = (fn, args = 'text', orrepl = false, body = 'BEGIN RETURN 1; END;') =>
    `CREATE ${orrepl ? 'OR REPLACE ' : ''}FUNCTION public.${fn}(${args === 'text' ? 'x text' : args}) RETURNS text LANGUAGE plpgsql AS $$ ${body} $$;`
  const REV = (fn, role = 'PUBLIC', args = 'text') => `REVOKE ALL PRIVILEGES ON FUNCTION public.${fn}(${args}) FROM ${role};`
  const GR = (fn, role, args = 'text') => `GRANT EXECUTE ON FUNCTION public.${fn}(${args}) TO ${role};`
  const revAll = (fn) => FORBIDDEN.map(r => REV(fn, r)).join('\n')
  const stub = 'BEGIN RAISE EXCEPTION \'LEGACY_CRYPTO_RPC_RETIRED\'; END;'
  // Baseline sintético (allowlisted): pgp + clave SINTÉTICA → no debe contar.
  const BASELINE = { name: '20260628190324_remote_baseline.sql', sql:
    F('encrypt_data', 'data_to_encrypt text', false, `BEGIN RETURN encode(pgp_sym_encrypt(data_to_encrypt, '${SYN_KEY}'),'base64'); END;`) +
    GR('encrypt_data', 'authenticated') +
    F('decrypt_data', 'encrypted_data text', false, `BEGIN RETURN pgp_sym_decrypt(decode(encrypted_data,'base64'), '${SYN_KEY}'); END;`) +
    GR('decrypt_data', 'authenticated') }
  const HOTFIX = { name: '20260721120000_x.sql', sql:
    F('encrypt_data', 'data_to_encrypt text', true, stub) + F('decrypt_data', 'encrypted_data text', true, stub) +
    revAll('encrypt_data') + revAll('decrypt_data') }

  const cases = [
    { n: '1 baseline+hotfix → cerrado', esperado: 0, files: [BASELINE, HOTFIX] },
    { n: '2 sin hotfix (solo baseline) → expuesto (public+authenticated)', min: 1, files: [BASELINE] },
    { n: '3 re-GRANT anon tras hotfix → hallazgo', min: 1, files: [BASELINE, HOTFIX, { name: '99.sql', sql: GR('decrypt_data', 'anon') }] },
    { n: '4 re-GRANT authenticated tras hotfix → hallazgo', min: 1, files: [BASELINE, HOTFIX, { name: '99.sql', sql: GR('encrypt_data', 'authenticated') }] },
    { n: '5 DROP+CREATE sin revoke → PUBLIC', min: 1, files: [BASELINE, HOTFIX, { name: '99.sql', sql: `DROP FUNCTION public.encrypt_data(text);` + F('encrypt_data', 'data_to_encrypt text', false, stub) }] },
    { n: '6 sobrecarga nueva sin cerrar → PUBLIC', min: 1, files: [BASELINE, HOTFIX, { name: '99.sql', sql: F('encrypt_data', 'a text, b text', false, stub) }] },
    { n: '7 reintroduce pgp_sym en cuerpo → hallazgo', min: 1, files: [BASELINE, HOTFIX, { name: '99.sql', sql: F('decrypt_data', 'encrypted_data text', true, "BEGIN RETURN pgp_sym_decrypt(decode(encrypted_data,'base64'),'k'); END;") }] },
    { n: '8 reintroduce la clave (sintética) en cuerpo → hallazgo', min: 1, files: [BASELINE, HOTFIX, { name: '99.sql', sql: F('encrypt_data', 'data_to_encrypt text', true, `BEGIN RETURN '${SYN_KEY}'; END;`) }] },
    { n: '9 clave (sintética) en una migración nueva (no baseline) → hallazgo', min: 1, files: [BASELINE, HOTFIX, { name: '99.sql', sql: `SELECT '${SYN_KEY}';` }] },
    { n: '10 CREATE OR REPLACE de la misma firma (cuerpo nuevo inocuo) → PASS', esperado: 0, files: [BASELINE, HOTFIX, { name: '99.sql', sql: F('encrypt_data', 'data_to_encrypt text', true, stub) }] },
    { n: '11 cripto nueva en OTRO esquema → PASS', esperado: 0, files: [BASELINE, HOTFIX, { name: '99.sql', sql: `CREATE FUNCTION private_crypto.encrypt_data(x text) RETURNS text LANGUAGE sql AS $$ SELECT $1 $$;` }] },
  ]
  let fail = 0
  for (const c of cases) {
    const got = findings(c.files, SYN_FP)   // mecanismo probado contra el fingerprint SINTÉTICO
    const ok = c.esperado !== undefined ? got.length === c.esperado : got.length >= c.min
    if (!ok) fail++
    console.log(`${ok ? '✅' : '❌'} fixture "${c.n}": ${got.length} hallazgo(s)${ok ? '' : ` (esperaba ${c.esperado !== undefined ? '=' + c.esperado : '>=' + c.min})`}`)
  }
  if (fail) { console.error(`\n❌ self-test: ${fail} fixture(s) fallaron`); process.exit(1) }
  console.log(`\n✅ self-test: las ${cases.length} fixtures se clasifican correctamente`)
}

const isCLI = process.argv[1] && process.argv[1].endsWith('guard-legacy-crypto-rpcs-private.mjs')
if (isCLI && process.argv.includes('--self-test')) { selfTest(); process.exit(0) }
if (isCLI) {
  const dir = process.argv[2] || DIR
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
    .map(f => join(dir, f)).filter(f => statSync(f).isFile())
    .map(f => ({ name: basename(f), sql: readFileSync(f, 'utf8') }))
  const bad = findings(files)
  if (bad.length) {
    console.error(`❌ Guard legacy-crypto: encrypt_data/decrypt_data reabren superficie o reintroducen la clave.\n`)
    for (const b of bad) console.error(`  · ${b}`)
    console.error(`\nSon oráculos SECDEF bajo clave comprometida. No re-otorgar EXECUTE a PUBLIC/anon/`)
    console.error(`authenticated/service_role, no reintroducir pgp_sym_* ni la clave. Cripto nueva → Edge/Vault.`)
    process.exit(1)
  }
  console.log(`✅ Guard legacy-crypto OK (${files.length} migraciones): encrypt_data/decrypt_data retiradas y neutralizadas.`)
}
