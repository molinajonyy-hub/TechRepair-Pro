#!/usr/bin/env node
// ============================================================================
// Guard AFIP-S1A — fundaciones seguras de credenciales ARCA.
//
// Falla (exit 1) si:
//  · una RPC privada de credenciales (arca_store/get/replace/delete_private_key_secret)
//    o el wrapper/safe (arca_store_credential, get_arca_config_safe, is_business_owner_or_admin)
//    recibe GRANT EXECUTE a PUBLIC/anon/authenticated en alguna migración;
//  · el frontend hace select('*') sobre arca_config;
//  · el frontend accede a `.private_key` (la clave nunca vuelve al navegador);
//  · aparece un header de CLAVE PRIVADA PEM en migraciones/fixtures/src (nunca en repo).
//
// NO imprime la clave si la encuentra (solo archivo + offset). El guard de "no
// nuevos plaintext en arca_config.private_key" queda para S3 (writers legacy activos).
//
//   node scripts/finance/guard-afip-s1a.mjs [--self-test]
// ============================================================================
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

const MIG = 'supabase/migrations'
const SRC = 'src'
// STRICT: service_role-only. Ningún rol cliente (public/anon/authenticated).
const STRICT_FNS = ['arca_store_private_key_secret','arca_get_private_key_for_signing',
  'arca_replace_private_key_secret','arca_delete_private_key_secret',
  'arca_store_credential','is_business_owner_or_admin']
// SAFE: get_arca_config_safe — authenticated ES su rol correcto; solo prohíbe anon/PUBLIC.
const SAFE_FN = 'get_arca_config_safe'
const PEM_HDR = /-----BEGIN (RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/

function stripComments(sql) {
  let out = '', i = 0
  while (i < sql.length) {
    if (sql.slice(i, i + 2) === '--') { const f = sql.indexOf('\n', i); const e = f === -1 ? sql.length : f; out += ' '.repeat(e - i); i = e; continue }
    if (sql.slice(i, i + 2) === '/*') { const f = sql.indexOf('*/', i + 2); const e = f === -1 ? sql.length : f + 2; out += ' '.repeat(e - i); i = e; continue }
    out += sql[i]; i++
  }
  return out
}

// GRANT EXECUTE a un rol cliente sobre una de las funciones sensibles.
export function migrationFindings(name, sql) {
  const s = stripComments(sql)
  const out = []
  const re = /\bGRANT\s+(?<privs>[^;]*?)\s+ON\s+FUNCTION\s+(?:"?(?:public|private)"?\.)?"?(?<fn>\w+)"?\s*\([^)]*\)\s+TO\s+(?<roles>[^;]+);/gi
  let m
  while ((m = re.exec(s)) !== null) {
    const g = m.groups
    if (!/\bexecute\b|\ball\b/i.test(g.privs)) continue
    const roles = g.roles.toLowerCase().split(/[\s,]+/).map(x => x.replace(/"/g, '').trim()).filter(Boolean)
    const forbidden = STRICT_FNS.includes(g.fn) ? ['public', 'anon', 'authenticated']
                    : g.fn === SAFE_FN ? ['public', 'anon'] : null
    if (!forbidden) continue
    for (const r of forbidden) {
      if (roles.includes(r)) out.push(`${name}: GRANT EXECUTE ${g.fn} → ${r} (rol no permitido)`)
    }
  }
  return out
}

// Escaneo del frontend: select('*') sobre arca_config y accesos a .private_key.
export function srcFindings(name, code) {
  const out = []
  // .from('arca_config') ... .select('*')  (tolerante a saltos de línea/encadenado)
  const fromRe = /\.from\(\s*['"]arca_config['"]\s*\)/g
  let m
  while ((m = fromRe.exec(code)) !== null) {
    const win = code.slice(m.index, m.index + 300)
    if (/\.select\(\s*['"]\*['"]\s*\)/.test(win)) out.push(`${name}: select('*') sobre arca_config (usar get_arca_config_safe)`)
  }
  // acceso a la propiedad private_key (config.private_key / arcaConfig.private_key / ?.private_key)
  if (/\.\s*private_key\b/.test(code)) out.push(`${name}: acceso a .private_key en el frontend (la clave no debe volver al navegador)`)
  return out
}

function scanPem(name, text) {
  const m = PEM_HDR.exec(text)
  return m ? [`${name}: header de CLAVE PRIVADA PEM detectado (offset ${m.index}) — nunca versionar claves`] : []
}

function walk(dir, exts) {
  const acc = []
  for (const f of readdirSync(dir)) {
    const p = join(dir, f); const st = statSync(p)
    if (st.isDirectory()) { if (!/node_modules|dist|\.git/.test(p)) acc.push(...walk(p, exts)) }
    else if (exts.some(e => f.endsWith(e))) acc.push(p)
  }
  return acc
}

function selfTest() {
  const cases = [
    { n: '1 GRANT get_private_key a authenticated → falla', min: 1, fn: () => migrationFindings('x.sql', 'GRANT EXECUTE ON FUNCTION private.arca_get_private_key_for_signing(uuid) TO authenticated;') },
    { n: '2 GRANT store a service_role → OK', exp: 0, fn: () => migrationFindings('x.sql', 'GRANT EXECUTE ON FUNCTION private.arca_store_private_key_secret(uuid,text,text,text,text,integer,uuid,boolean) TO service_role;') },
    { n: '3 GRANT safe a authenticated → OK (rol correcto)', exp: 0, fn: () => migrationFindings('x.sql', 'GRANT EXECUTE ON FUNCTION public.get_arca_config_safe(uuid) TO authenticated;') },
    { n: '3b GRANT safe a anon → falla', min: 1, fn: () => migrationFindings('x.sql', 'GRANT EXECUTE ON FUNCTION public.get_arca_config_safe(uuid) TO anon;') },
    { n: '4 select(*) arca_config → falla', min: 1, fn: () => srcFindings('a.ts', "await supabase.from('arca_config').select('*').eq('business_id', b)") },
    { n: '5 rpc get_arca_config_safe → OK', exp: 0, fn: () => srcFindings('a.ts', "await supabase.rpc('get_arca_config_safe', { p_business_id: b })") },
    { n: '6 acceso .private_key → falla', min: 1, fn: () => srcFindings('a.ts', 'if (config.private_key) doThing()') },
    { n: '7 PEM privado → falla', min: 1, fn: () => scanPem('a.sql', 'x -----BEGIN PRIVATE KEY-----\\nAAA') },
  ]
  // El caso 3 es un matiz: safe→authenticated ES correcto; el guard NO debe marcarlo.
  let fail = 0
  for (const c of cases) {
    const got = c.fn().length
    const ok = c.exp !== undefined ? got === c.exp : got >= c.min
    if (!ok) fail++
    console.log(`${ok ? '✅' : '❌'} fixture "${c.n}": ${got}`)
  }
  if (fail) { console.error(`\n❌ self-test: ${fail} fallo(s)`); process.exit(1) }
  console.log(`\n✅ self-test: las ${cases.length} fixtures OK`)
}

const isCLI = process.argv[1] && process.argv[1].endsWith('guard-afip-s1a.mjs')
if (isCLI && process.argv.includes('--self-test')) { selfTest(); process.exit(0) }
if (isCLI) {
  const bad = []
  for (const f of readdirSync(MIG).filter(f => f.endsWith('.sql')).sort()) {
    bad.push(...migrationFindings(basename(f), readFileSync(join(MIG, f), 'utf8')))
    bad.push(...scanPem('migrations/' + basename(f), readFileSync(join(MIG, f), 'utf8')))
  }
  for (const f of walk(SRC, ['.ts', '.tsx'])) {
    const code = readFileSync(f, 'utf8')
    bad.push(...srcFindings(f.replace(/\\/g, '/'), code))
    bad.push(...scanPem(f.replace(/\\/g, '/'), code))
  }
  if (bad.length) {
    console.error('❌ Guard AFIP-S1A:\n')
    for (const b of bad) console.error('  · ' + b)
    process.exit(1)
  }
  console.log('✅ Guard AFIP-S1A OK: RPC sensibles service_role-only, sin select(*) ni .private_key en frontend, sin PEM privado versionado.')
}
