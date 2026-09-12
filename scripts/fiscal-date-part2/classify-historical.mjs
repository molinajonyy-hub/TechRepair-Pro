#!/usr/bin/env node
// ============================================================================
// FISCAL DATE Parte 2 — runner del CLASIFICADOR (SÓLO LECTURA)
//
//   node scripts/fiscal-date-part2/classify-historical.mjs                 # base local
//   node scripts/fiscal-date-part2/classify-historical.mjs --json out.json # resultado ya exportado
//
// Corre classify-historical.sql (un SELECT) y escribe el manifiesto con su
// SHA-256. No escribe NADA en la base: el runner ni siquiera tiene un camino de
// escritura, y si el SQL dejara de ser un único SELECT, aborta.
//
// Los conteos NUNCA se hardcodean: salen de los datos. Si un número esperado no
// coincide, el que está mal es el número esperado, no la base.
// ============================================================================
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SQL_FILE = join(repoRoot, 'scripts', 'fiscal-date-part2', 'classify-historical.sql')
const OUT_DIR = join(repoRoot, 'docs', 'fiscal-date-part2')
const CLASSES = ['PROVABLE_LOCAL', 'REQUIRES_ARCA_LOOKUP', 'INCONSISTENT']

const argv = process.argv.slice(2)
const jsonIdx = argv.indexOf('--json')
const sql = readFileSync(SQL_FILE, 'utf8')

// Guardia de sólo-lectura: el clasificador no puede mutar nada.
const forbidden = /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|COPY|MERGE)\b/i
const stripped = sql.replace(/--.*$/gm, '')
if (forbidden.test(stripped)) {
  console.error('[clasificador] ABORTA: classify-historical.sql contiene una sentencia de escritura')
  process.exit(2)
}

let rows
if (jsonIdx >= 0) {
  rows = JSON.parse(readFileSync(argv[jsonIdx + 1], 'utf8'))
  console.log(`[clasificador] fuente: ${argv[jsonIdx + 1]} (resultado exportado)`)
} else {
  const project = readFileSync(join(repoRoot, 'supabase', 'config.toml'), 'utf8')
    .match(/^project_id = "([a-z0-9-]+)"/m)?.[1]
  const container = process.env.FDP2_DB_CONTAINER || `supabase_db_${project}`
  if (!/^supabase_db_[a-z0-9-]+$/.test(container)) throw new Error('Se requiere el contenedor LOCAL')
  const out = execFileSync('docker', [
    'exec', '-i', container, 'psql', '-X', '-U', 'postgres', '-d', 'postgres',
    '-Atq', '-v', 'ON_ERROR_STOP=1', '-c',
    `SELECT coalesce(json_agg(t), '[]'::json)::text FROM (${stripped.replace(/;\s*$/, '')}) t;`,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  rows = JSON.parse(out.trim())
  console.log(`[clasificador] fuente: base local (${container})`)
}

if (!Array.isArray(rows)) throw new Error('El resultado del clasificador no es una lista')

// ── Validación: toda fila tiene que caer en una clase conocida ──────────────
const counts = Object.fromEntries(CLASSES.map(c => [c, 0]))
const unknown = []
const lookup = []
const provable = []
for (const r of rows) {
  if (!CLASSES.includes(r.clase)) { unknown.push(r); continue }
  counts[r.clase]++
  if (r.clase === 'REQUIRES_ARCA_LOOKUP') lookup.push(r)
  if (r.clase === 'PROVABLE_LOCAL') {
    provable.push(r)
    // Una fila probable tiene que traer la fecha probada Y la evidencia que la
    // prueba: exactamente un intento autorizado, ventana post-corte y día
    // civil argentino constante. Sin eso, "probable" sería una etiqueta vacía.
    if (!/^\d{8}$/.test(r.cbte_fch_probado ?? '')) {
      unknown.push({ ...r, _problema: 'PROVABLE_LOCAL sin cbte_fch_probado con forma YYYYMMDD' })
    } else if (Number(r.autorizados_n) !== 1) {
      unknown.push({ ...r, _problema: 'PROVABLE_LOCAL sin exactamente un intento autorizado' })
    } else if (r.post_corte !== true || r.ar_constante !== true) {
      unknown.push({ ...r, _problema: 'PROVABLE_LOCAL sin ventana post-corte y día argentino constante' })
    } else if (r.dia_ar_desde !== r.cbte_fch_probado || r.dia_ar_hasta !== r.cbte_fch_probado) {
      unknown.push({ ...r, _problema: 'PROVABLE_LOCAL cuya ventana no coincide con la fecha probada' })
    }
  }
}
if (unknown.length) {
  console.error(`[clasificador] ${unknown.length} fila(s) NO se pueden clasificar de forma segura:`)
  for (const u of unknown.slice(0, 10)) console.error('  ', JSON.stringify(u))
  process.exit(1)
}

// La consulta a ARCA necesita PV + CbteTipo + Nro completos, o no es consultable.
const sinClave = lookup.filter(r => !(r.pv_fiscal > 0 && r.cbte_tipo > 0 && r.nro_fiscal > 0))
if (sinClave.length) {
  console.error(`[clasificador] ${sinClave.length} fila(s) requieren ARCA pero su clave de consulta está incompleta`)
  for (const r of sinClave.slice(0, 10)) console.error('  ', JSON.stringify(r))
  process.exit(1)
}

const manifest = {
  generado_en: new Date().toISOString(),
  sql_sha256: createHash('sha256').update(sql).digest('hex'),
  total: rows.length,
  conteos: counts,
  desglose_lookup: {
    sin_intento_autorizado: lookup.filter(r => !r.authorized_attempt_id).length,
    previa_al_corte_parte1: lookup.filter(r => r.authorized_attempt_id && r.post_corte !== true).length,
    ventana_cruza_dia: lookup.filter(r => r.post_corte === true && r.ar_constante !== true).length,
  },
  consultas_arca_requeridas: lookup.length,
  filas: rows,
}
const json = JSON.stringify(manifest, null, 2)
const sha = createHash('sha256').update(json).digest('hex')

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, 'classification.json'), json)
writeFileSync(join(OUT_DIR, 'classification.json.sha256'), `${sha}  classification.json\n`)

console.log(`[clasificador] total autorizados      : ${manifest.total}`)
for (const c of CLASSES) console.log(`[clasificador] ${c.padEnd(21)}: ${counts[c]}`)
console.log(`[clasificador]   sin intento autorizado : ${manifest.desglose_lookup.sin_intento_autorizado}`)
console.log(`[clasificador]   previa al corte P1     : ${manifest.desglose_lookup.previa_al_corte_parte1}`)
console.log(`[clasificador]   ventana cruza día      : ${manifest.desglose_lookup.ventana_cruza_dia}`)
console.log(`[clasificador] consultas ARCA a hacer : ${manifest.consultas_arca_requeridas}`)
console.log(`[clasificador] sha256(classification.json) = ${sha}`)
console.log(`[clasificador] sha256(classify-historical.sql) = ${manifest.sql_sha256}`)
if (counts.INCONSISTENT > 0) {
  console.error(`[clasificador] hay ${counts.INCONSISTENT} comprobante(s) INCONSISTENT: no avanzar sin revisión humana`)
  process.exit(1)
}
