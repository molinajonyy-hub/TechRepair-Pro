#!/usr/bin/env node
// ============================================================================
// M7 Lote 7C.1a — Guard de CI para funciones SECURITY DEFINER.
//
// Falla (exit 1) cuando una SECURITY DEFINER de una migracion:
//   1. no fija search_path;
//   2. incluye "$user";
//   3. omite pg_temp  -> OJO: omitirlo NO lo excluye, lo pone PRIMERO
//      (doc PostgreSQL 5.9.3). Es el vector de shadowing por tabla temporal.
//   4. pone pg_temp antes de un schema confiable;
//   5. incluye `public` Y ademas tiene referencias sin calificar a objetos de
//      aplicacion. (`public` solo se tolera si TODO esta calificado; el ideal
//      es no incluirlo.)
//
// Inspecciona CREATE [OR REPLACE] FUNCTION y ALTER FUNCTION ... SET search_path,
// respetando overloads (se reporta la firma).
//
//   node scripts/finance/guard-security-definer.mjs [archivo|dir ...]
//   node scripts/finance/guard-security-definer.mjs --self-test
// ============================================================================
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCHEMAS_CONFIABLES = new Set(['pg_catalog', 'extensions'])
// Objetos de aplicacion cuya resolucion no debe depender del search_path.
// Se detectan tras FROM/JOIN/INSERT INTO/UPDATE/DELETE FROM y en %ROWTYPE.
const RE_REL_SIN_CALIFICAR = /\b(?:FROM|JOIN|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?!public\.|pg_catalog\.|auth\.|extensions\.|storage\.|pg_temp\.|\()([a-z_][a-z0-9_]*)/gi
const RE_ROWTYPE_SIN_CALIFICAR = /\b(?!public\.|auth\.)([a-z_][a-z0-9_]*)\s*%\s*ROWTYPE/gi
// Palabras que aparecen tras FROM/UPDATE pero NO son relaciones de aplicacion.
const NO_RELACIONES = new Set([
  'unnest','generate_series','jsonb_array_elements','jsonb_array_elements_text','jsonb_each',
  'json_array_elements','string_to_array','regexp_split_to_table','pg_proc','pg_namespace',
  'pg_class','pg_trigger','pg_constraint','pg_indexes','pg_policies','information_schema',
  'lateral','only','set','values','dual','pg_settings','pg_roles','pg_auth_members',
])

function despojar(s) {
  let out = '', i = 0
  while (i < s.length) {
    if (s.slice(i, i + 2) === '--') { const f = s.indexOf('\n', i); const e = f === -1 ? s.length : f; out += ' '.repeat(e - i); i = e; continue }
    if (s.slice(i, i + 2) === '/*') { const f = s.indexOf('*/', i + 2); const e = f === -1 ? s.length : f + 2; out += ' '.repeat(e - i); i = e; continue }
    if (s[i] === "'") { const st = i; i++; while (i < s.length) { if (s[i] === "'" && s[i+1] === "'") { i += 2; continue } if (s[i] === "'") { i++; break } i++ } out += ' '.repeat(i - st); continue }
    out += s[i]; i++
  }
  return out
}

function troceaPath(txt) {
  // corta en ` AS `, `LANGUAGE`, `;` o fin de linea: si no, se traga el cuerpo.
  const corte = txt.split(/\s+(?:AS|LANGUAGE|STABLE|IMMUTABLE|VOLATILE|SECURITY|RETURNS)\b/i)[0]
  return corte.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
}

function parseSearchPath(decl) {
  const m = decl.match(/SET\s+"?search_path"?\s*(?:TO|=)\s*([^\n;]+)/i)
  if (!m) return null
  return troceaPath(m[1])
}

function revisarPath(path, etiqueta, hallazgos) {
  if (!path) { hallazgos.push(`${etiqueta}: SIN search_path fijo`); return }
  if (path.some(s => s === '$user' || s === '"$user"')) hallazgos.push(`${etiqueta}: incluye "$user"`)
  if (!path.includes('pg_temp')) {
    hallazgos.push(`${etiqueta}: OMITE pg_temp -> se busca PRIMERO (doc PG 5.9.3): shadowing por tabla temporal`)
  } else {
    const iTemp = path.indexOf('pg_temp')
    const indices = path.map((s, i) => (SCHEMAS_CONFIABLES.has(s) || s === 'public') ? i : -1).filter(i => i >= 0)
    const iUltimoConfiable = indices.length ? Math.max(...indices) : -1
    if (iUltimoConfiable >= 0 && iTemp < iUltimoConfiable) {
      hallazgos.push(`${etiqueta}: pg_temp en posicion ${iTemp}, antes de un schema confiable (posicion ${iUltimoConfiable})`)
    }
  }
  return path
}

function revisarArchivo(archivo) {
  const crudo = readFileSync(archivo, 'utf8')
  const limpio = despojar(crudo)
  const hallazgos = []

  // ── CREATE [OR REPLACE] FUNCTION ...
  const reCreate = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+("?[\w]+"?\."?[\w]+"?|"?[\w]+"?)\s*\(([^)]*)\)/gi
  let m
  while ((m = reCreate.exec(limpio)) !== null) {
    const firma = `${m[1]}(${m[2].replace(/\s+/g, ' ').trim().slice(0, 60)})`
    const desde = m.index
    const marca = limpio.indexOf('$', desde)
    const decl = limpio.slice(desde, marca === -1 ? desde + 400 : marca)
    if (!/SECURITY\s+DEFINER/i.test(decl)) continue

    const path = parseSearchPath(decl)
    revisarPath(path, firma, hallazgos)

    // cuerpo: entre los dos delimitadores $...$
    const dm = crudo.slice(desde).match(/\$(\w*)\$/)
    let cuerpo = ''
    if (dm) {
      const delim = dm[0]
      const a = crudo.indexOf(delim, desde) + delim.length
      const b = crudo.indexOf(delim, a)
      cuerpo = b === -1 ? '' : despojar(crudo.slice(a, b))
    }
    if (path && path.includes('public') && cuerpo) {
      const sinCalificar = new Set()
      let r
      RE_REL_SIN_CALIFICAR.lastIndex = 0
      while ((r = RE_REL_SIN_CALIFICAR.exec(cuerpo)) !== null) {
        const n = r[1].toLowerCase()
        if (!NO_RELACIONES.has(n)) sinCalificar.add(n)
      }
      RE_ROWTYPE_SIN_CALIFICAR.lastIndex = 0
      while ((r = RE_ROWTYPE_SIN_CALIFICAR.exec(cuerpo)) !== null) sinCalificar.add(`${r[1].toLowerCase()}%ROWTYPE`)
      if (sinCalificar.size) {
        hallazgos.push(`${firma}: incluye 'public' Y tiene referencias sin calificar (${[...sinCalificar].slice(0, 5).join(', ')})`)
      }
    }
  }

  // ── ALTER FUNCTION ... SET search_path
  const reAlter = /ALTER\s+FUNCTION\s+("?[\w]+"?\."?[\w]+"?|[\w]+)\s*\(([^)]*)\)\s*SET\s+search_path\s*(?:TO|=)\s*([^\n;]+)/gi
  while ((m = reAlter.exec(limpio)) !== null) {
    const firma = `ALTER ${m[1]}(${m[2].replace(/\s+/g, ' ').trim().slice(0, 50)})`
    revisarPath(troceaPath(m[3]), firma, hallazgos)
  }

  return hallazgos
}

// ── fixtures de auto-verificacion ───────────────────────────────────────────
const FIXTURES = [
  { nombre: 'segura (calificada, sin public)', debeFallar: false, sql:
`CREATE FUNCTION public.f1(a uuid) RETURNS int LANGUAGE sql SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp AS $$ SELECT count(*) FROM public.businesses WHERE id=a $$;` },
  { nombre: 'sin search_path', debeFallar: true, sql:
`CREATE FUNCTION public.f2(a uuid) RETURNS int LANGUAGE sql SECURITY DEFINER
 AS $$ SELECT count(*) FROM public.businesses WHERE id=a $$;` },
  { nombre: 'public incluido + tabla sin calificar', debeFallar: true, sql:
`CREATE FUNCTION public.f3(a uuid) RETURNS int LANGUAGE sql SECURITY DEFINER
 SET search_path = pg_catalog, public, pg_temp AS $$ SELECT count(*) FROM businesses WHERE id=a $$;` },
  { nombre: 'public incluido pero TODO calificado', debeFallar: false, sql:
`CREATE FUNCTION public.f4(a uuid) RETURNS int LANGUAGE sql SECURITY DEFINER
 SET search_path = pg_catalog, public, pg_temp AS $$ SELECT count(*) FROM public.businesses WHERE id=a $$;` },
  { nombre: 'pg_temp primero', debeFallar: true, sql:
`CREATE FUNCTION public.f5(a uuid) RETURNS int LANGUAGE sql SECURITY DEFINER
 SET search_path = pg_temp, pg_catalog AS $$ SELECT 1 $$;` },
  { nombre: 'omite pg_temp', debeFallar: true, sql:
`CREATE FUNCTION public.f6(a uuid) RETURNS int LANGUAGE sql SECURITY DEFINER
 SET search_path = pg_catalog AS $$ SELECT 1 $$;` },
  { nombre: '"$user" en el path', debeFallar: true, sql:
`CREATE FUNCTION public.f7(a uuid) RETURNS int LANGUAGE sql SECURITY DEFINER
 SET search_path = "$user", pg_catalog, pg_temp AS $$ SELECT 1 $$;` },
  { nombre: 'ROWTYPE sin calificar', debeFallar: true, sql:
`CREATE FUNCTION public.f8(a uuid) RETURNS int LANGUAGE plpgsql SECURITY DEFINER
 SET search_path = pg_catalog, public, pg_temp AS $$ DECLARE v businesses%ROWTYPE; BEGIN RETURN 1; END $$;` },
  { nombre: 'SECURITY INVOKER: no aplica', debeFallar: false, sql:
`CREATE FUNCTION public.f9(a uuid) RETURNS int LANGUAGE sql AS $$ SELECT count(*) FROM businesses $$;` },
  { nombre: 'ALTER con public y sin pg_temp', debeFallar: true, sql:
`ALTER FUNCTION public.f10(uuid) SET search_path = public;` },
]

function autoTest() {
  const dir = mkdtempSync(join(tmpdir(), 'sdguard-'))
  let fallas = 0
  for (const f of FIXTURES) {
    const p = join(dir, 'fx.sql')
    writeFileSync(p, f.sql)
    const h = revisarArchivo(p)
    const fallo = h.length > 0
    const ok = fallo === f.debeFallar
    if (!ok) fallas++
    console.log(`${ok ? '✅' : '❌'} fixture "${f.nombre}": esperaba ${f.debeFallar ? 'FALLA' : 'OK'}, obtuvo ${fallo ? 'FALLA' : 'OK'}${fallo ? ` (${h[0]})` : ''}`)
  }
  if (fallas) { console.error(`\n❌ self-test: ${fallas} fixture(s) mal clasificadas`); process.exit(1) }
  console.log('\n✅ self-test: las 10 fixtures se clasifican correctamente')
}

// ── Baseline de deuda legacy ────────────────────────────────────────────────
// Migraciones históricas del repo declaran funciones con `search_path=public` y
// referencias sin calificar. Endurecerlas todas excede el alcance aprobado (ver
// informe 7C.1a §10.1); el vector de tabla temporal YA está cerrado por la
// barrera pg_temp de 20260713310000. El baseline registra esos archivos
// conocidos para que el gate no bloquee el repo entero, sin dejar pasar nada
// nuevo.
//
// Reglas:
//   · archivo NUEVO con hallazgos      -> bloquea siempre;
//   · archivo del baseline que EMPEORA -> bloquea (regresión);
//   · archivo del baseline que MEJORA  -> avisa para actualizar;
//   · nunca se agrega un archivo al baseline automáticamente: sólo con
//     --update-baseline, que es explícito y queda visible en el diff.
const BASELINE_PATH = 'scripts/finance/secdef-baseline.json'

function cargarBaseline() {
  try { return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) }
  catch { return { archivos: {} } }
}

// ── main ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
if (args[0] === '--self-test') { autoTest(); process.exit(0) }

const actualizar = args.includes('--update-baseline')
const rutas = args.filter(a => !a.startsWith('--'))
const objetivos = rutas.length ? rutas : ['supabase/migrations']
const archivos = []
for (const t of objetivos) {
  if (statSync(t).isDirectory()) for (const f of readdirSync(t)) { if (f.endsWith('.sql')) archivos.push(join(t, f)) }
  else archivos.push(t)
}

const baseline = cargarBaseline()
const conteos = {}
let bloqueantes = 0
let regresiones = 0
const desactualizados = []

for (const a of archivos) {
  const h = revisarArchivo(a)
  if (!h.length) continue
  const clave = a.replace(/\\/g, '/')
  conteos[clave] = h.length

  const permitido = baseline.archivos[clave]
  if (permitido === undefined) {
    bloqueantes += h.length
    console.error(`\n[BLOQUEA] ${clave} - fuera del baseline (${h.length} hallazgo(s)):`)
    for (const x of h) console.error(`   . ${x}`)
  } else if (h.length > permitido) {
    regresiones++
    console.error(`\n[REGRESION] ${clave} - ${h.length} hallazgos, el baseline permite ${permitido}:`)
    for (const x of h) console.error(`   . ${x}`)
  } else if (h.length < permitido) {
    desactualizados.push(`${clave}: ${h.length} (baseline dice ${permitido})`)
  }
}

if (actualizar) {
  writeFileSync(BASELINE_PATH, JSON.stringify({
    nota: 'Deuda legacy conocida de SECURITY DEFINER (informe 7C.1a). El vector pg_temp ya esta cerrado por 20260713310000; falta calificar referencias y sacar public del path. Ningun archivo entra aca automaticamente.',
    generado_con: 'npm run guard:secdef -- --update-baseline',
    archivos: conteos,
  }, null, 2) + '\n')
  console.log(`baseline actualizado: ${Object.keys(conteos).length} archivo(s) con deuda conocida.`)
  process.exit(0)
}

if (desactualizados.length) {
  console.warn('\n[AVISO] el baseline quedo desactualizado (mejoro). Actualizalo con: npm run guard:secdef -- --update-baseline')
  for (const d of desactualizados) console.warn(`   . ${d}`)
}

if (bloqueantes || regresiones) {
  console.error(`\nGuard SECURITY DEFINER FALLO: ${bloqueantes} hallazgo(s) fuera del baseline, ${regresiones} regresion(es).`)
  process.exit(1)
}
const conDeuda = Object.keys(conteos).length
console.log(`Guard SECURITY DEFINER OK (${archivos.length} archivos): sin hallazgos nuevos.` +
  (conDeuda ? ` ${conDeuda} archivo(s) con deuda legacy registrada en el baseline.` : ''))
