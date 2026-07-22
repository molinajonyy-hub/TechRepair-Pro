#!/usr/bin/env node
// ============================================================================
// Guard AFIP-S1B-B — la lectura directa cliente de arca_config queda cerrada.
//
// Estático sobre supabase/migrations + src. Falla (exit 1) si:
//  · la migración S1B-B no contiene los REVOKE SELECT (PUBLIC/anon/authenticated)
//    o el DROP POLICY arca_config_plan_read;
//  · la migración S1B-B usa CASCADE, hace DML sobre arca_config, revoca
//    privilegios de service_role o deshabilita RLS;
//  · CUALQUIER migración posterior (o cualquiera, para grants) reabre el acceso:
//      - GRANT SELECT ... ON ... arca_config ... TO anon/authenticated/PUBLIC
//        (incluye grants POR COLUMNA: GRANT SELECT (col, ...));
//      - recrea arca_config_plan_read o crea una policy FOR SELECT sobre la tabla;
//      - ALTER TABLE ... arca_config DISABLE ROW LEVEL SECURITY;
//  · el frontend reintroduce from('arca_config').
//
//   node scripts/finance/guard-afip-s1b-b.mjs [--self-test]
// ============================================================================
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

const DIR = 'supabase/migrations'
const S1BB_MARK = 'afip_s1b_b_close_direct_config_read'
const S1BB_VERSION = '20260722170000'

function stripComments(sql) {
  let out = '', i = 0
  while (i < sql.length) {
    if (sql.slice(i, i + 2) === '--') { const f = sql.indexOf('\n', i); const e = f === -1 ? sql.length : f; out += ' '.repeat(e - i); i = e; continue }
    if (sql.slice(i, i + 2) === '/*') { const f = sql.indexOf('*/', i + 2); const e = f === -1 ? sql.length : f + 2; out += ' '.repeat(e - i); i = e; continue }
    out += sql[i]; i++
  }
  return out
}

// Hallazgos sobre LA migración S1B-B (contenido obligatorio + prohibiciones).
export function s1bbFindings(sql) {
  const out = []
  const c = stripComments(sql)
  if (!/REVOKE\s+SELECT\s+ON\s+(TABLE\s+)?public\.arca_config\s+FROM\s+PUBLIC/i.test(c)) out.push('falta REVOKE SELECT FROM PUBLIC')
  if (!/REVOKE\s+SELECT\s+ON\s+(TABLE\s+)?public\.arca_config\s+FROM\s+anon/i.test(c)) out.push('falta REVOKE SELECT FROM anon')
  if (!/REVOKE\s+SELECT\s+ON\s+(TABLE\s+)?public\.arca_config\s+FROM\s+authenticated/i.test(c)) out.push('falta REVOKE SELECT FROM authenticated')
  if (!/DROP\s+POLICY\s+arca_config_plan_read\s+ON\s+public\.arca_config/i.test(c)) out.push('falta DROP POLICY arca_config_plan_read')
  if (/DROP\s+POLICY[^;]*CASCADE/i.test(c)) out.push('DROP POLICY con CASCADE prohibido')
  if (/\b(INSERT\s+INTO|DELETE\s+FROM)\s+public\.arca_config\b/i.test(c)) out.push('DML sobre arca_config en la migración')
  if (/\bUPDATE\s+public\.arca_config\s+SET\b/i.test(c)) out.push('UPDATE sobre arca_config en la migración')
  if (/REVOKE\s+[^;]*ON\s+(TABLE\s+)?public\.arca_config\s+FROM\s+[^;]*service_role/i.test(c)) out.push('revoca privilegios de service_role')
  if (/ALTER\s+TABLE\s+public\.arca_config\s+DISABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(c)) out.push('deshabilita RLS')
  return out
}

// Hallazgos de REAPERTURA en cualquier migración (se aplica a las >= S1B-B;
// los GRANT reabiertos se detectan en cualquier archivo por si se backportean).
export function reopenFindings(sql) {
  const out = []
  const c = stripComments(sql)
  if (s1bbFindings === undefined) return out // (guardia de import circular; no ocurre)
  // GRANT SELECT de tabla o POR COLUMNA a roles cliente / PUBLIC
  const grantRe = /GRANT\s+[^;]*SELECT[^;]*ON\s+(TABLE\s+)?("?public"?\.)?"?arca_config"?\s+TO\s+([^;]+);/gi
  let m
  while ((m = grantRe.exec(c)) !== null) {
    if (/\b(anon|authenticated|public)\b/i.test(m[3])) out.push('GRANT SELECT sobre arca_config a rol cliente/PUBLIC')
  }
  if (/CREATE\s+POLICY\s+"?arca_config_plan_read"?/i.test(c)) out.push('recrea arca_config_plan_read')
  const polRe = /CREATE\s+POLICY\s+"?[\w]+"?\s+ON\s+("?public"?\.)?"?arca_config"?[^;]*FOR\s+SELECT/gi
  if (polRe.test(c)) out.push('crea una policy FOR SELECT sobre arca_config')
  if (/ALTER\s+TABLE\s+("?public"?\.)?"?arca_config"?\s+DISABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(c)) out.push('deshabilita RLS de arca_config')
  return out
}

function walkSrc(dir) {
  const files = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) files.push(...walkSrc(p))
    else if (/\.(ts|tsx)$/.test(name)) files.push(p)
  }
  return files
}

function selfTest() {
  const OK = readFileSync(join(DIR, `${S1BB_VERSION}_afip_s1b_b_close_direct_config_read.sql`), 'utf8')
  const cases = [
    { n: '1 migración S1B-B real → 0', fn: s1bbFindings, exp: 0, sql: OK },
    { n: '2 GRANT SELECT a authenticated → falla', fn: reopenFindings, min: 1, sql: 'GRANT SELECT ON public.arca_config TO authenticated;' },
    { n: '3 grant de private_key POR COLUMNA → falla', fn: reopenFindings, min: 1, sql: 'GRANT SELECT (private_key) ON public.arca_config TO authenticated;' },
    { n: '4 recrear la policy → falla', fn: reopenFindings, min: 1, sql: "CREATE POLICY arca_config_plan_read ON public.arca_config FOR SELECT USING (true);" },
    { n: '5 revocar service_role → falla', fn: s1bbFindings, min: 1, sql: OK + '\nREVOKE SELECT ON public.arca_config FROM service_role;' },
    { n: '6 quitar RLS → falla', fn: reopenFindings, min: 1, sql: 'ALTER TABLE public.arca_config DISABLE ROW LEVEL SECURITY;' },
    { n: '7 sin DROP POLICY → falla', fn: s1bbFindings, min: 1, sql: OK.replace(/DROP POLICY arca_config_plan_read ON public\.arca_config;/, '') },
    { n: '8 migración ajena → 0 reaperturas', fn: reopenFindings, exp: 0, sql: 'CREATE TABLE x(); GRANT SELECT ON public.otra_tabla TO authenticated;' },
  ]
  let fail = 0
  for (const c of cases) {
    const got = c.fn(c.sql).length
    const ok = c.exp !== undefined ? got === c.exp : got >= c.min
    if (!ok) fail++
    console.log(`${ok ? '✅' : '❌'} fixture "${c.n}": ${got}${ok ? '' : ` (${c.fn(c.sql).slice(0, 2).join(' | ')})`}`)
  }
  if (fail) { console.error(`\n❌ self-test: ${fail} fallo(s)`); process.exit(1) }
  console.log(`\n✅ self-test: las ${cases.length} fixtures OK`)
}

const isCLI = process.argv[1] && process.argv[1].endsWith('guard-afip-s1b-b.mjs')
if (isCLI && process.argv.includes('--self-test')) { selfTest(); process.exit(0) }
if (isCLI) {
  const bad = []
  const files = readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()
  const s1bbFile = files.find(f => f.includes(S1BB_MARK))
  if (!s1bbFile) {
    console.error('❌ Guard AFIP-S1B-B: no existe la migración de cierre (' + S1BB_MARK + ')')
    process.exit(1)
  }
  for (const h of s1bbFindings(readFileSync(join(DIR, s1bbFile), 'utf8'))) bad.push(`${s1bbFile}: ${h}`)
  // Reaperturas: SOLO en migraciones POSTERIORES al cierre (orden de cadena).
  // Las anteriores (baseline incluida) crearon legítimamente el estado que
  // S1B-B revoca; una migración nueva con timestamp anterior no corre en prod.
  for (const f of files.filter(f => f > s1bbFile)) {
    for (const h of reopenFindings(readFileSync(join(DIR, f), 'utf8'))) bad.push(`${basename(f)}: ${h}`)
  }
  // Frontend: from('arca_config') no puede reaparecer (redundante con guard A2; barato)
  for (const f of walkSrc('src')) {
    const code = stripComments(readFileSync(f, 'utf8'))
    if (/from\(\s*['"]arca_config['"]\s*\)/.test(code)) bad.push(`${f.replace(/\\/g, '/')}: from('arca_config') reintroducido en el frontend`)
  }
  if (bad.length) {
    console.error('❌ Guard AFIP-S1B-B:\n')
    for (const b of bad) console.error('  · ' + b)
    process.exit(1)
  }
  console.log('✅ Guard AFIP-S1B-B OK: REVOKE+DROP POLICY presentes, sin CASCADE/DML/servicerole-revoke, sin reaperturas de SELECT cliente, frontend limpio.')
}
