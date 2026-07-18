#!/usr/bin/env node
// ============================================================================
// M7 7E.1 — Guard: nadie vuelve a otorgar CREATE sobre `public`.
//
// La migración 20260714100000 le sacó CREATE al pseudo-rol PUBLIC (y por lo
// tanto a anon/authenticated/service_role). Ese permiso es la PRECONDICION que
// vuelve atacable el `public` que aparece en el search_path de 120 funciones
// SECURITY DEFINER: sin poder escribir en el esquema, no hay objeto que plantar
// para secuestrar una resolución de nombres.
//
// El riesgo real no es que alguien lo re-otorgue a propósito: es que se cuele
// en una migración copiada de un template de Supabase (los suyos traen
// `GRANT ALL ON SCHEMA public TO ...`). Por eso el guard mira el texto de las
// migraciones y no sólo el estado de la base: una base puede estar bien hoy y
// la próxima migración romperlo.
//
//   node scripts/finance/guard-public-create-grant.mjs [dir]
//   node scripts/finance/guard-public-create-grant.mjs --self-test
// ============================================================================
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DIR_POR_DEFECTO = 'supabase/migrations'
// La migración que hace el REVOKE necesita nombrar el permiso para revocarlo.
const EXENTAS = new Set(['20260714100000_m7_7e1_revoke_create_on_public.sql'])

const ROLES_CLIENTE = ['public', 'anon', 'authenticated', 'service_role']

/** Quita comentarios para no marcar un GRANT que sólo se menciona en prosa. */
function despojarComentarios(sql) {
  let out = '', i = 0
  while (i < sql.length) {
    if (sql.slice(i, i + 2) === '--') { const f = sql.indexOf('\n', i); const e = f === -1 ? sql.length : f; out += ' '.repeat(e - i); i = e; continue }
    if (sql.slice(i, i + 2) === '/*') { const f = sql.indexOf('*/', i + 2); const e = f === -1 ? sql.length : f + 2; out += ' '.repeat(e - i); i = e; continue }
    out += sql[i]; i++
  }
  return out
}

/**
 * Predicado puro y testeable: ¿este SQL otorga CREATE sobre public a un rol de
 * cliente? Cubre `GRANT CREATE`, `GRANT ALL` y las listas de varios roles.
 */
export function grantsInseguros(sql) {
  const limpio = despojarComentarios(sql)
  const hallazgos = []
  // GRANT <privs> ON SCHEMA public TO <roles>
  const re = /\bGRANT\s+([\s\S]*?)\s+ON\s+SCHEMA\s+public\s+TO\s+([^;]+);/gi
  let m
  while ((m = re.exec(limpio)) !== null) {
    const privs = m[1].toLowerCase()
    const roles = m[2].toLowerCase()
    const otorgaCreate = /\bcreate\b/.test(privs) || /\ball\b/.test(privs)
    if (!otorgaCreate) continue
    for (const rol of ROLES_CLIENTE) {
      // \b no sirve para "public" dentro de "public_x"; se compara por tokens.
      const tokens = roles.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
      if (tokens.includes(rol)) {
        hallazgos.push({ privs: m[1].trim().replace(/\s+/g, ' '), rol })
      }
    }
  }
  return hallazgos
}

function selfTest() {
  const casos = [
    { n: 'sin grants', sql: 'SELECT 1;', esperado: 0 },
    { n: 'GRANT CREATE a PUBLIC', sql: 'GRANT CREATE ON SCHEMA public TO PUBLIC;', esperado: 1 },
    { n: 'GRANT ALL a authenticated', sql: 'GRANT ALL ON SCHEMA public TO authenticated;', esperado: 1 },
    { n: 'GRANT USAGE solo (legitimo)', sql: 'GRANT USAGE ON SCHEMA public TO anon;', esperado: 0 },
    { n: 'GRANT CREATE a postgres (legitimo)', sql: 'GRANT CREATE ON SCHEMA public TO postgres;', esperado: 0 },
    { n: 'lista de roles', sql: 'GRANT ALL ON SCHEMA public TO anon, authenticated, service_role;', esperado: 3 },
    { n: 'comentado no cuenta', sql: '-- GRANT CREATE ON SCHEMA public TO PUBLIC;\nSELECT 1;', esperado: 0 },
    { n: 'REVOKE no cuenta', sql: 'REVOKE CREATE ON SCHEMA public FROM PUBLIC;', esperado: 0 },
    { n: 'USAGE+CREATE juntos', sql: 'GRANT USAGE, CREATE ON SCHEMA public TO authenticated;', esperado: 1 },
    { n: 'otro esquema no cuenta', sql: 'GRANT ALL ON SCHEMA extensions TO authenticated;', esperado: 0 },
  ]
  let fallos = 0
  for (const c of casos) {
    const got = grantsInseguros(c.sql).length
    const ok = got === c.esperado
    if (!ok) fallos++
    console.log(`${ok ? '✅' : '❌'} fixture "${c.n}": esperaba ${c.esperado}, obtuvo ${got}`)
  }
  if (fallos) { console.error(`\n❌ self-test: ${fallos} fixture(s) fallaron`); process.exit(1) }
  console.log(`\n✅ self-test: las ${casos.length} fixtures se clasifican correctamente`)
}

if (process.argv.includes('--self-test')) { selfTest(); process.exit(0) }

const dir = process.argv[2] || DIR_POR_DEFECTO
const archivos = readdirSync(dir)
  .filter(f => f.endsWith('.sql'))
  .filter(f => !EXENTAS.has(f))
  .map(f => join(dir, f))
  .filter(f => statSync(f).isFile())

let total = 0
for (const f of archivos) {
  const hallazgos = grantsInseguros(readFileSync(f, 'utf8'))
  for (const h of hallazgos) {
    if (total === 0) console.error('❌ Guard CREATE-sobre-public: se re-otorga un permiso que 7E.1 revocó.\n')
    console.error(`   ${f}\n     GRANT ${h.privs} ON SCHEMA public TO ${h.rol}`)
    total++
  }
}

if (total) {
  console.error(`
CREATE sobre public le permite a un rol de cliente plantar objetos dentro del
esquema, que es lo que hace atacable el \`public\` del search_path de las
funciones SECURITY DEFINER.

Los roles de cliente sólo necesitan USAGE:

    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
`)
  process.exit(1)
}

console.log(`✅ Guard CREATE-sobre-public OK (${archivos.length} migraciones): nadie re-otorga CREATE.`)
