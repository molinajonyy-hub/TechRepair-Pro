#!/usr/bin/env node
// ============================================================================
// M7 7E.2 §4 — ¿El frontend PRODUCTIVO ANTERIOR sigue funcionando contra la
// base ya migrada a M7?
//
// Importa porque el orden de despliegue es base primero, frontend después. Entre
// una cosa y la otra hay una ventana —minutos u horas— en la que los usuarios
// siguen con el bundle viejo contra el esquema nuevo. Si en esa ventana una RPC
// empieza a exigir un parámetro que el bundle viejo no manda, eso no es un
// detalle: es una caída, y encima intermitente.
//
// El script compara, para cada RPC que llama el frontend de a1791e1:
//   · los argumentos que ESE frontend envía (leídos de su código, no de memoria);
//   · los parámetros que la función M7 exige HOY (sin DEFAULT).
//
// Si una función exige algo que el frontend viejo no manda, es incompatible y
// el despliegue en dos fases no se puede hacer así.
//
//   node scripts/finance/frontend-compat-check.mjs <dir-con-src-viejo>
// ============================================================================
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DIR_VIEJO = process.argv[2]
if (!DIR_VIEJO) { console.error('uso: frontend-compat-check.mjs <dir-src-viejo>'); process.exit(2) }

function cont() {
  const toml = readFileSync('supabase/config.toml', 'utf-8')
  return `supabase_db_${toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)[1]}`
}
function psql(sql) {
  return execFileSync('docker',
    ['exec', '-i', cont(), 'psql', '-X', '-q', '-t', '-A', '-F', '|', '-v', 'ON_ERROR_STOP=1',
     '-U', 'postgres', '-d', 'postgres', '-c', sql], { encoding: 'utf-8' }).trim()
}

function archivos(dir) {
  const out = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...archivos(p))
    else if (/\.(ts|tsx)$/.test(e)) out.push(p)
  }
  return out
}

// ─── 1. Qué manda el frontend viejo ─────────────────────────────────────────
// Se toma el bloque de argumentos que sigue al nombre de la RPC y se extraen las
// claves `p_*`. Si una RPC se llama en varios lugares con distintos argumentos,
// se usa la UNION: basta con que UNA llamada omita un parámetro obligatorio
// para que ese camino se rompa.
const llamadas = new Map()
for (const f of archivos(DIR_VIEJO)) {
  const src = readFileSync(f, 'utf-8')
  const re = /\.rpc\(\s*'([a-z0-9_]+)'\s*,?\s*(\{[\s\S]{0,2000}?\n\s*\}\)|\{[^{}]*\})?/g
  let m
  while ((m = re.exec(src)) !== null) {
    const rpc = m[1]
    const args = new Set(llamadas.get(rpc)?.args ?? [])
    const sitios = (llamadas.get(rpc)?.sitios ?? 0) + 1
    for (const k of (m[2] ?? '').matchAll(/\b(p_[a-z0-9_]+)\s*:/g)) args.add(k[1])
    llamadas.set(rpc, { args, sitios })
  }
}

// ─── 2. Qué exige la base M7 ────────────────────────────────────────────────
const filas = psql(`
  SELECT p.proname,
         COALESCE(array_to_string(p.proargnames, ','), ''),
         p.pronargs, p.pronargdefaults
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'`).split('\n').filter(Boolean)

const fnActual = new Map()
for (const linea of filas) {
  const [nombre, argnames, nargs, ndef] = linea.split('|')
  const nombres = argnames ? argnames.split(',') : []
  // Los parámetros con DEFAULT son SIEMPRE los últimos (regla de PostgreSQL).
  const requeridos = nombres.slice(0, Number(nargs) - Number(ndef)).filter(a => a.startsWith('p_'))
  const previo = fnActual.get(nombre)
  // Si hay overloads, se queda el de MENOS requeridos: es el que el frontend
  // viejo podría estar resolviendo.
  if (!previo || requeridos.length < previo.length) fnActual.set(nombre, requeridos)
}

// ─── 3. Comparar ────────────────────────────────────────────────────────────
const incompatibles = [], ausentes = [], ok = []
for (const [rpc, { args, sitios }] of [...llamadas].sort()) {
  const requeridos = fnActual.get(rpc)
  if (requeridos === undefined) { ausentes.push(rpc); continue }
  const faltan = requeridos.filter(r => !args.has(r))
  if (faltan.length) incompatibles.push({ rpc, faltan, sitios })
  else ok.push(rpc)
}

console.log('── M7 7E.2 §4 · compatibilidad frontend a1791e1 -> base M7 ────\n')
console.log(`RPC llamadas por el frontend viejo : ${llamadas.size}`)
console.log(`compatibles                        : ${ok.length}`)
console.log(`INCOMPATIBLES                      : ${incompatibles.length}`)
console.log(`no existen en la base local        : ${ausentes.length}`)

if (ausentes.length) {
  console.log('\nNo encontradas en public (probablemente viven en otro schema o son de una')
  console.log('feature no instalada localmente; se listan para revisión manual):')
  ausentes.forEach(a => console.log(`   · ${a}`))
}

if (incompatibles.length) {
  console.log('\n❌ ROMPEN el despliegue en dos fases:')
  for (const i of incompatibles) {
    console.log(`   · ${i.rpc} exige ${i.faltan.join(', ')} y el frontend viejo no lo manda (${i.sitios} call site/s)`)
  }
  console.log('\nCon esto, entre el deploy de DB y el de frontend los usuarios con el')
  console.log('bundle viejo recibirían errores. Hay que rediseñar las fases.')
  process.exit(1)
}

console.log('\n✅ Ninguna RPC exige parametros nuevos: el frontend anterior sigue')
console.log('   funcionando contra la base M7. El despliegue DB-primero es seguro.')
