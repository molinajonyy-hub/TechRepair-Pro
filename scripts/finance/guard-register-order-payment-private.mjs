#!/usr/bin/env node
// ============================================================================
// HOTFIX P1 (latente) — Guard: `register_order_payment` no vuelve a la API pública.
//
// La migración 20260720140000 le sacó EXECUTE a PUBLIC/anon/authenticated/
// service_role. La función es SECURITY DEFINER, no valida identidad y su cuerpo
// hace INSERT INTO financial_movements. Hoy el INSERT falla (financial_movements
// exige `currency` NOT NULL sin default, que la función legacy no provee), así
// que NO es una inyección explotable — pero es una RPC financiera sin
// autorización publicada, y un cambio de esquema/cuerpo la activaría.
//
// SEMÁNTICA CORRECTA DE POSTGRESQL (esto es lo que este guard modela):
//   · El EXECUTE por default a PUBLIC se otorga al CREAR una función NUEVA
//     (una firma que no existía, o recreada tras DROP).
//   · `CREATE OR REPLACE FUNCTION` sobre una firma EXISTENTE PRESERVA owner y
//     privilegios: NO re-otorga EXECUTE a PUBLIC. Cambiar solo el cuerpo es
//     seguro.
//   · Una firma nueva (otros argumentos / sobrecarga) SÍ es una función nueva
//     → default PUBLIC.
//
// Por eso el guard rastrea POR FIRMA su existencia y su ACL, reproduciendo los
// eventos en orden (CREATE / DROP / GRANT / REVOKE). No se limita a buscar
// REVOKE, y no marca falso-positivo un CREATE OR REPLACE que solo cambia cuerpo.
//
//   node scripts/finance/guard-register-order-payment-private.mjs [dir]
//   node scripts/finance/guard-register-order-payment-private.mjs --self-test
// ============================================================================
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'supabase/migrations'
const FN = 'register_order_payment'
const FORBIDDEN = ['public', 'anon', 'authenticated', 'service_role']

function stripComments(sql) {
  let out = '', i = 0
  while (i < sql.length) {
    if (sql.slice(i, i + 2) === '--') { const f = sql.indexOf('\n', i); const e = f === -1 ? sql.length : f; out += ' '.repeat(e - i); i = e; continue }
    if (sql.slice(i, i + 2) === '/*') { const f = sql.indexOf('*/', i + 2); const e = f === -1 ? sql.length : f + 2; out += ' '.repeat(e - i); i = e; continue }
    out += sql[i]; i++
  }
  return out
}

// Normaliza la lista de argumentos a una firma por TIPOS: "uuid,uuid,numeric".
// Acepta la forma de CREATE ("p_order_id uuid, ... DEFAULT x") y la de
// GRANT/REVOKE ("uuid, uuid, numeric"). null/'' (sin paréntesis) → '*' = todas.
function sigOf(argspec) {
  if (argspec == null) return '*'
  // pg_dump/baseline entrecomilla identificadores y tipos: "p_order_id" "uuid".
  // Hay que quitar las comillas para normalizar a la misma firma que un
  // GRANT/REVOKE escrito a mano (uuid, uuid, numeric).
  const parts = argspec.replace(/"/g, '').split(',').map(s => s.trim()).filter(Boolean)
  if (!parts.length) return ''
  const types = parts.map(seg => {
    let t = seg.replace(/\bDEFAULT\b[\s\S]*$/i, '').trim()          // saca DEFAULT ...
    t = t.replace(/^\b(IN|OUT|INOUT|VARIADIC)\b\s+/i, '').trim()    // saca el modo
    const toks = t.split(/\s+/)
    // "nombre tipo" (2+ tokens y el primero es un identificador que no es un
    // keyword de tipo multi-palabra) → el tipo es el resto. "tipo" solo → tipo.
    if (toks.length >= 2 && /^[a-z_]\w*$/i.test(toks[0]) &&
        !['double', 'character', 'timestamp', 'time', 'bit'].includes(toks[0].toLowerCase())) {
      return toks.slice(1).join(' ').toLowerCase()
    }
    return t.toLowerCase()
  })
  return types.join(',')
}

// Estado final de roles con EXECUTE sobre CUALQUIER firma de register_order_payment.
export function rolesWithExecute(sqlCorpus) {
  const s = stripComments(sqlCorpus)
  const sigs = new Map()  // sig -> { exists:bool, roles:Set }
  const get = (sig) => { if (!sigs.has(sig)) sigs.set(sig, { exists: false, roles: new Set() }); return sigs.get(sig) }

  const re = new RegExp([
    `(?<drop>\\bDROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?(?:"?public"?\\.)?"?${FN}"?\\s*(?:\\((?<dargs>[^)]*)\\))?)`,
    `(?<create>\\bCREATE\\s+(?<orrepl>OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:"?public"?\\.)?"?${FN}"?\\s*\\((?<cargs>[^)]*)\\))`,
    `(?<gr>\\b(?<kind>GRANT|REVOKE)\\s+(?<privs>[^;]*?)\\s+ON\\s+FUNCTION\\s+(?:"?public"?\\.)?"?${FN}"?\\s*(?:\\((?<gargs>[^)]*)\\))?\\s+(?<dir>TO|FROM)\\s+(?<roles>[^;]+);)`,
  ].join('|'), 'gi')

  let m
  while ((m = re.exec(s)) !== null) {
    const g = m.groups
    if (g.drop) { const o = get(sigOf(g.dargs)); o.exists = false; o.roles.clear(); continue }
    if (g.create) {
      const sig = sigOf(g.cargs); const o = get(sig)
      if (!o.exists) { o.exists = true; o.roles = new Set(['public']) }  // NUEVA → default PUBLIC
      else { o.exists = true }                                          // REPLACE existente → preserva ACL
      continue
    }
    if (g.gr) {
      const privs = g.privs.toLowerCase()
      if (!/\bexecute\b/.test(privs) && !/\ball\b/.test(privs)) continue
      const rs = g.roles.toLowerCase().split(/[\s,]+/).map(x => x.replace(/"/g, '').trim()).filter(Boolean)
      const sig = sigOf(g.gargs)
      const targets = sig === '*' ? [...sigs.keys()] : [sig]
      for (const t of targets) {
        const o = get(t)
        for (const rol of FORBIDDEN) {
          if (!rs.includes(rol)) continue
          if (/^GRANT$/i.test(g.kind)) o.roles.add(rol)
          else o.roles.delete(rol)
        }
      }
    }
  }

  const exposed = new Set()
  for (const o of sigs.values()) {
    if (!o.exists) continue
    for (const r of o.roles) if (FORBIDDEN.includes(r)) exposed.add(r)
  }
  return [...exposed].sort()
}

function selfTest() {
  const C = (args = 'uuid,uuid,numeric') => `CREATE FUNCTION public.${FN}(${args}) RETURNS void AS $$ $$ LANGUAGE sql;`
  const COR = (args = 'uuid,uuid,numeric') => `CREATE OR REPLACE FUNCTION public.${FN}(${args}) RETURNS void AS $$ $$ LANGUAGE sql;`
  const REV = (role = 'PUBLIC', args = 'uuid,uuid,numeric') => `REVOKE ALL ON FUNCTION public.${FN}(${args}) FROM ${role};`
  const GR = (role, args = 'uuid,uuid,numeric') => `GRANT EXECUTE ON FUNCTION public.${FN}(${args}) TO ${role};`
  const cases = [
    { n: '1 CREATE nuevo sin REVOKE → PUBLIC', esperado: ['public'], sql: C() },
    { n: '2 DROP + CREATE sin REVOKE → PUBLIC', esperado: ['public'], sql: C() + REV() + `DROP FUNCTION public.${FN}(uuid,uuid,numeric);` + C() },
    { n: '3 firma adicional (otros args) sin REVOKE → PUBLIC', esperado: ['public'], sql: C() + REV() + C('uuid,uuid') },
    { n: '4 sobrecarga nueva mismo nombre → PUBLIC', esperado: ['public'], sql: C() + REV() + C('uuid') },
    { n: '5 GRANT a PUBLIC → expuesto', esperado: ['public'], sql: C() + REV() + GR('PUBLIC') },
    { n: '6 GRANT a anon → expuesto', esperado: ['anon'], sql: C() + REV() + GR('anon') },
    { n: '7 GRANT a authenticated → expuesto', esperado: ['authenticated'], sql: C() + REV() + GR('authenticated') },
    { n: '8 GRANT a service_role → expuesto', esperado: ['service_role'], sql: C() + REV() + GR('service_role') },
    { n: '9 CREATE + REVOKE de los 4 → cerrado', esperado: [], sql: C() + REV('PUBLIC') + REV('anon') + REV('authenticated') + REV('service_role') },
    { n: '10 variante legacy bajo otra firma expuesta → PUBLIC', esperado: ['public'], sql: C() + REV() + `CREATE FUNCTION public.${FN}(uuid) RETURNS void AS $$ $$ LANGUAGE sql;` },
    // Debe PERMITIR (no falso positivo):
    { n: 'A CREATE OR REPLACE de la MISMA firma tras revocar → PASS', esperado: [], sql: C() + REV() + COR() },
    { n: 'B cambio de cuerpo (REPLACE) que no reabre → PASS', esperado: [], sql: C() + REV() + COR() + COR() },
    { n: 'C otra funcion no cuenta', esperado: [], sql: `GRANT EXECUTE ON FUNCTION public.create_order_payment_atomic(uuid) TO anon;` },
    { n: 'D GRANT USAGE (no EXECUTE) no cuenta', esperado: [], sql: C() + REV() + `GRANT USAGE ON SCHEMA public TO anon;` },
  ]
  let fail = 0
  for (const c of cases) {
    const got = rolesWithExecute(c.sql)
    const ok = JSON.stringify(got) === JSON.stringify(c.esperado)
    if (!ok) fail++
    console.log(`${ok ? '✅' : '❌'} fixture "${c.n}": esperaba [${c.esperado}], obtuvo [${got}]`)
  }
  if (fail) { console.error(`\n❌ self-test: ${fail} fixture(s) fallaron`); process.exit(1) }
  console.log(`\n✅ self-test: las ${cases.length} fixtures se clasifican correctamente`)
}

const isCLI = process.argv[1] && process.argv[1].endsWith('guard-register-order-payment-private.mjs')
if (isCLI && process.argv.includes('--self-test')) { selfTest(); process.exit(0) }
if (isCLI) {
  const dir = process.argv[2] || DIR
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort().map(f => join(dir, f)).filter(f => statSync(f).isFile())
  const corpus = files.map(f => readFileSync(f, 'utf8')).join('\n;\n')
  const bad = rolesWithExecute(corpus)
  if (bad.length) {
    console.error(`❌ Guard register_order_payment: vuelve a ser ejecutable por ${bad.join(', ')}.\n`)
    console.error(`Es SECURITY DEFINER sin authz y su cuerpo hace INSERT INTO financial_movements.
Reexponerla publica de nuevo una RPC financiera sin autenticar. Recordá: crear una
función NUEVA (o DROP+CREATE, o una sobrecarga) otorga EXECUTE a PUBLIC por default —
seguirlo de un REVOKE. Un CREATE OR REPLACE de la MISMA firma preserva la ACL (seguro).
Si se necesita la RPC, reescribirla con auth.uid() + membresía + idempotencia.\n`)
    process.exit(1)
  }
  console.log(`✅ Guard register_order_payment OK (${files.length} migraciones): fuera de la API pública.`)
}
