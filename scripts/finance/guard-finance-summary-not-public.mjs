#!/usr/bin/env node
// ============================================================================
// HOTFIX CRITICO — Guard: `get_finance_summary` no vuelve a la API publica.
//
// La migracion 20260719130000 le saco EXECUTE a PUBLIC/anon/authenticated/
// service_role. La funcion es SECURITY DEFINER, no valida identidad y filtra
// solo por el p_business_id que recibe: con EXECUTE publico, cualquiera con la
// publishable key lee el resumen financiero de cualquier negocio SIN
// autenticarse. Reproducido por HTTP contra el endpoint RPC real.
//
// ALCANCE DELIBERADAMENTE ANGOSTO. Este guard mira UNA funcion. NO marca
// SECURITY DEFINER en general por no contener el literal `auth.uid()`: los
// helpers legitimos (current_platform_admin_role(), checks de membresia,
// funciones intermedias) lo usan por dentro y ese criterio produciria una
// avalancha de falsos positivos. El triage de esa superficie mas amplia es un
// trabajo aparte, con verificacion dinamica caso por caso.
//
// ORDEN, NO ACUMULACION: gana la ultima sentencia. Un REVOKE viejo no protege
// de un GRANT nuevo, y es exactamente asi como reaparecen estos agujeros.
//
//   node scripts/finance/guard-finance-summary-not-public.mjs [dir]
//   node scripts/finance/guard-finance-summary-not-public.mjs --self-test
// ============================================================================
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DIR_POR_DEFECTO = 'supabase/migrations'
const FUNCION = 'get_finance_summary'
// PUBLIC alcanza a todo rol presente y futuro: es la causa raiz de este bug,
// porque `anon` nunca tuvo un grant propio — heredaba EXECUTE de PUBLIC.
const ROLES_PROHIBIDOS = ['public', 'anon', 'authenticated']

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
 * Devuelve los roles de cliente que quedan con EXECUTE sobre get_finance_summary
 * despues de reproducir GRANT/REVOKE en orden.
 */
export function rolesConEjecucion(sqlCorpus) {
  const limpio = despojarComentarios(sqlCorpus)
  const estado = new Set()

  // GRANT/REVOKE ... ON FUNCTION <algo>get_finance_summary<args> TO/FROM <roles>;
  // Se exige que la sentencia nombre la funcion: asi no hay que parsear firmas
  // con tipos, que es donde estos regex se rompen.
  const re = /\b(GRANT|REVOKE)\s+([^;]*?)\s+ON\s+FUNCTION\s+([^;]*?)\s+(TO|FROM)\s+([^;]+);/gi
  let m
  while ((m = re.exec(limpio)) !== null) {
    const [, kind, privs, objeto, , rolesRaw] = m
    if (!objeto.toLowerCase().includes(FUNCION)) continue
    const p = privs.toLowerCase()
    if (!/\bexecute\b/.test(p) && !/\ball\b/.test(p)) continue

    const roles = rolesRaw.toLowerCase()
      .split(/[\s,]+/).map(x => x.replace(/"/g, '').trim()).filter(Boolean)
    for (const rol of ROLES_PROHIBIDOS) {
      if (!roles.includes(rol)) continue
      if (/^GRANT$/i.test(kind)) estado.add(rol)
      else estado.delete(rol)
    }
  }
  return [...estado].sort()
}

function selfTest() {
  const casos = [
    { n: 'estado VULNERABLE: GRANT a authenticated', esperado: ['authenticated'],
      sql: 'GRANT ALL ON FUNCTION public.get_finance_summary(uuid,date,date) TO authenticated;' },
    { n: 'estado VULNERABLE: GRANT a PUBLIC (anon hereda)', esperado: ['public'],
      sql: 'GRANT EXECUTE ON FUNCTION public.get_finance_summary(uuid,date,date) TO PUBLIC;' },
    { n: 'estado CORREGIDO: GRANT y despues REVOKE', esperado: [],
      sql: 'GRANT ALL ON FUNCTION public.get_finance_summary(uuid,date,date) TO authenticated;'
         + 'REVOKE ALL ON FUNCTION public.get_finance_summary(uuid,date,date) FROM authenticated;' },
    { n: 'REGRESION: REVOKE y despues GRANT (gana el ultimo)', esperado: ['anon'],
      sql: 'REVOKE ALL ON FUNCTION public.get_finance_summary(uuid,date,date) FROM anon;'
         + 'GRANT EXECUTE ON FUNCTION public.get_finance_summary(uuid,date,date) TO anon;' },
    { n: 'los 3 roles revocados', esperado: [],
      sql: 'GRANT ALL ON FUNCTION public.get_finance_summary(uuid,date,date) TO PUBLIC, anon, authenticated;'
         + 'REVOKE ALL ON FUNCTION public.get_finance_summary(uuid,date,date) FROM PUBLIC;'
         + 'REVOKE ALL ON FUNCTION public.get_finance_summary(uuid,date,date) FROM anon;'
         + 'REVOKE ALL ON FUNCTION public.get_finance_summary(uuid,date,date) FROM authenticated;' },
    { n: 'service_role no es rol prohibido (se evalua aparte)', esperado: [],
      sql: 'GRANT EXECUTE ON FUNCTION public.get_finance_summary(uuid,date,date) TO service_role;' },
    { n: 'otra funcion no cuenta', esperado: [],
      sql: 'GRANT EXECUTE ON FUNCTION public.finance_dashboard_summary(uuid,date,date) TO authenticated;' },
    { n: 'comentado no cuenta', esperado: [],
      sql: '-- GRANT EXECUTE ON FUNCTION public.get_finance_summary(uuid,date,date) TO anon;\nSELECT 1;' },
    { n: 'identificadores entrecomillados', esperado: ['authenticated'],
      sql: 'GRANT ALL ON FUNCTION "public"."get_finance_summary"("p_business_id" uuid, "p_from" date, "p_to" date) TO "authenticated";' },
    { n: 'GRANT USAGE (no EXECUTE) no cuenta', esperado: [],
      sql: 'GRANT USAGE ON FUNCTION public.get_finance_summary(uuid,date,date) TO anon;' },
    { n: 'lista de roles en un solo GRANT', esperado: ['anon','authenticated','public'],
      sql: 'GRANT EXECUTE ON FUNCTION public.get_finance_summary(uuid,date,date) TO PUBLIC, anon, authenticated;' },
  ]
  let fallos = 0
  for (const c of casos) {
    const got = rolesConEjecucion(c.sql)
    const ok = JSON.stringify(got) === JSON.stringify(c.esperado)
    if (!ok) fallos++
    console.log(`${ok ? '✅' : '❌'} fixture "${c.n}": esperaba [${c.esperado}], obtuvo [${got}]`)
  }
  if (fallos) { console.error(`\n❌ self-test: ${fallos} fixture(s) fallaron`); process.exit(1) }
  console.log(`\n✅ self-test: las ${casos.length} fixtures se clasifican correctamente`)
}

const esCLI = process.argv[1] && process.argv[1].endsWith('guard-finance-summary-not-public.mjs')
if (esCLI && process.argv.includes('--self-test')) { selfTest(); process.exit(0) }

if (esCLI) {
  const dir = process.argv[2] || DIR_POR_DEFECTO
  const archivos = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
    .map(f => join(dir, f)).filter(f => statSync(f).isFile())
  const corpus = archivos.map(f => readFileSync(f, 'utf8')).join('\n;\n')
  const malos = rolesConEjecucion(corpus)

  if (malos.length) {
    console.error(`❌ Guard get_finance_summary: vuelve a ser ejecutable por ${malos.join(', ')}.\n`)
    console.error(`public.${FUNCION} es SECURITY DEFINER, no valida identidad y filtra solo por el
p_business_id que recibe. Con EXECUTE para PUBLIC/anon/authenticated, cualquiera
con la publishable key lee el resumen financiero de CUALQUIER negocio sin
autenticarse.

Si hace falta esta metrica, no se re-otorga: se reescribe la funcion con
auth.uid() y filtro de membresia server-side, como finance_dashboard_summary.
`)
    process.exit(1)
  }
  console.log(`✅ Guard get_finance_summary OK (${archivos.length} migraciones): fuera de la API publica.`)
}
