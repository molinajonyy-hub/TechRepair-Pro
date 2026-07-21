#!/usr/bin/env node
// ============================================================================
// Guard de reproducibilidad — prohíbe el parche frágil por coincidencia textual.
//
// El patrón `v_new := replace(pg_get_functiondef(...), '<fragmento>', ...)` +
// `IF v_new = v_def THEN RAISE` depende del formato EXACTO (indentación incluida)
// que pg_get_functiondef/prosrc preserva del cuerpo definido por la migración
// previa. En un `db reset` limpio ese fragmento no coincide → replace() no-op →
// RAISE P0001 → el reset aborta. Fue la causa raíz del bloqueo de 6F.3/6F.4a.
//
// Las funciones/vistas se modifican con CREATE OR REPLACE explícito y cuerpo
// canónico completo — nunca parcheando el texto de la definición viva.
//
// Falla (exit 1) si una migración contiene, en CÓDIGO (no en comentarios):
//   · replace( ... pg_get_functiondef( ... ) ... )
//   · replace( ... pg_get_viewdef( ... ) ... )
//   · EXECUTE de una variable derivada de pg_get_functiondef/viewdef vía replace.
//
//   node scripts/finance/guard-no-fragile-functiondef-patch.mjs [dir]
//   node scripts/finance/guard-no-fragile-functiondef-patch.mjs --self-test
// ============================================================================
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

const DIR = 'supabase/migrations'

function stripComments(sql) {
  let out = '', i = 0
  while (i < sql.length) {
    if (sql.slice(i, i + 2) === '--') { const f = sql.indexOf('\n', i); const e = f === -1 ? sql.length : f; out += ' '.repeat(e - i); i = e; continue }
    if (sql.slice(i, i + 2) === '/*') { const f = sql.indexOf('*/', i + 2); const e = f === -1 ? sql.length : f + 2; out += ' '.repeat(e - i); i = e; continue }
    out += sql[i]; i++
  }
  return out
}

// Detecta replace(...) cuyo primer argumento (hasta la coma de tope) contiene
// pg_get_functiondef( o pg_get_viewdef(. Tolerante a espacios/saltos de línea.
export function findings(sql) {
  const s = stripComments(sql)
  const out = []
  const re = /\breplace\s*\(/gi
  let m
  while ((m = re.exec(s)) !== null) {
    // tomar ~200 chars del primer argumento (hasta la primera coma de nivel 0)
    const start = m.index + m[0].length
    const chunk = s.slice(start, start + 400)
    // corta en la primera coma que no esté dentro de paréntesis
    let depth = 0, arg = ''
    for (const ch of chunk) {
      if (ch === '(') depth++
      else if (ch === ')') { if (depth === 0) break; depth-- }
      else if (ch === ',' && depth === 0) break
      arg += ch
    }
    if (/pg_get_functiondef\s*\(|pg_get_viewdef\s*\(/i.test(arg)) {
      out.push('replace() sobre pg_get_functiondef/pg_get_viewdef (parche textual frágil)')
    }
  }
  return out
}

function selfTest() {
  const cases = [
    { n: '1 replace(pg_get_functiondef) → detecta', min: 1, sql: `DO $$ BEGIN v_new := replace(pg_get_functiondef('f'::regproc), 'a', 'b'); END $$;` },
    { n: '2 replace(pg_get_viewdef) → detecta', min: 1, sql: `v_new := replace(pg_get_viewdef('v'::regclass), 'a', 'b');` },
    { n: '3 replace(v_def...) con v_def de functiondef → detecta (misma línea)', min: 1, sql: `x := replace( pg_get_functiondef(o) , 'x','y')` },
    { n: '4 solo en COMENTuario → NO detecta', esperado: 0, sql: `-- usa replace(pg_get_functiondef(...)) en el original\nSELECT 1;` },
    { n: '5 replace normal (no functiondef) → NO detecta', esperado: 0, sql: `SELECT replace(descripcion, 'a', 'b') FROM t;` },
    { n: '6 CREATE OR REPLACE FUNCTION → NO detecta', esperado: 0, sql: `CREATE OR REPLACE FUNCTION public.f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;` },
    { n: '7 pg_get_functiondef sin replace → NO detecta', esperado: 0, sql: `SELECT pg_get_functiondef('f'::regproc);` },
  ]
  let fail = 0
  for (const c of cases) {
    const got = findings(c.sql).length
    const ok = c.esperado !== undefined ? got === c.esperado : got >= c.min
    if (!ok) fail++
    console.log(`${ok ? '✅' : '❌'} fixture "${c.n}": ${got} hallazgo(s)`)
  }
  if (fail) { console.error(`\n❌ self-test: ${fail} fixture(s) fallaron`); process.exit(1) }
  console.log(`\n✅ self-test: las ${cases.length} fixtures se clasifican correctamente`)
}

const isCLI = process.argv[1] && process.argv[1].endsWith('guard-no-fragile-functiondef-patch.mjs')
if (isCLI && process.argv.includes('--self-test')) { selfTest(); process.exit(0) }
if (isCLI) {
  const dir = process.argv[2] || DIR
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort().map(f => join(dir, f)).filter(f => statSync(f).isFile())
  const bad = []
  for (const f of files) { for (const h of findings(readFileSync(f, 'utf8'))) bad.push(`${basename(f)}: ${h}`) }
  if (bad.length) {
    console.error(`❌ Guard reproducibilidad: parche textual frágil sobre definiciones vivas.\n`)
    for (const b of bad) console.error(`  · ${b}`)
    console.error(`\nEste patrón rompe \`db reset\` (P0001) cuando el formato del cuerpo vivo no`)
    console.error(`coincide con el fragmento hardcodeado. Usar CREATE OR REPLACE con el cuerpo`)
    console.error(`canónico completo, nunca replace(pg_get_functiondef()/pg_get_viewdef()).`)
    process.exit(1)
  }
  console.log(`✅ Guard reproducibilidad OK (${files.length} migraciones): ningún parche textual frágil.`)
}
