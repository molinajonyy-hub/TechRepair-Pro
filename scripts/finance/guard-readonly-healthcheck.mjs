#!/usr/bin/env node
// ============================================================================
// M7 Lote 7C — Guard estatico de SOLO LECTURA del health check.
//
// El guard de 7A (guard-readonly-sql.mjs) escanea archivos .sql enteros; no
// sirve aca porque la migracion del health check contiene, legitimamente, un
// CREATE FUNCTION. Este guard extrae el CUERPO de las funciones del health
// check y verifica que no escriba.
//
// Comprueba dos cosas independientes:
//   1. ESTATICO — el cuerpo no contiene sentencias de escritura.
//   2. DECLARATIVO — la funcion se declara STABLE. Es la garantia FUERTE: una
//      funcion no-VOLATILE no puede ejecutar INSERT/UPDATE/DELETE; Postgres
//      aborta con "INSERT is not allowed in a non-volatile function". El guard
//      estatico es defensa en profundidad sobre esa barrera del motor.
//
//   node scripts/finance/guard-readonly-healthcheck.mjs [archivo.sql]
// ============================================================================
import { readFileSync } from 'node:fs'

const ARCHIVO = process.argv[2]
  ?? 'supabase/migrations/20260713280000_m7_7c_health_check_v2.sql'

const FUNCIONES_ESPERADAS = ['finance_health_check_v2', 'finance_hc_mk']

const sql = readFileSync(ARCHIVO, 'utf8')

// ── Extrae los cuerpos $$ ... $$ de cada CREATE FUNCTION ────────────────────
function cuerpos(texto) {
  const out = []
  const re = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+"?public"?\."?(\w+)"?/gi
  let m
  while ((m = re.exec(texto)) !== null) {
    const nombre = m[1]
    const desde = texto.indexOf('$$', m.index)
    if (desde === -1) continue
    const hasta = texto.indexOf('$$', desde + 2)
    if (hasta === -1) continue
    out.push({ nombre, cuerpo: texto.slice(desde + 2, hasta), decl: texto.slice(m.index, desde) })
  }
  return out
}

// Quita comentarios y literales: un comentario que dice "no inserta nada" no es
// una escritura, y un mensaje de usuario que contiene la palabra UPDATE tampoco.
function despojar(s) {
  let out = '', i = 0
  while (i < s.length) {
    if (s.slice(i, i + 2) === '--') { const f = s.indexOf('\n', i); i = f === -1 ? s.length : f; continue }
    if (s.slice(i, i + 2) === '/*') { const f = s.indexOf('*/', i + 2); i = f === -1 ? s.length : f + 2; continue }
    if (s[i] === "'") {
      i++
      while (i < s.length) {
        if (s[i] === "'" && s[i + 1] === "'") { i += 2; continue }
        if (s[i] === "'") { i++; break }
        i++
      }
      out += " '' "
      continue
    }
    out += s[i]; i++
  }
  return out
}

const PROHIBIDOS = [
  [/\bINSERT\s+INTO\b/i, 'INSERT'],
  [/\bUPDATE\s+\w+\s+SET\b/i, 'UPDATE'],
  [/\bDELETE\s+FROM\b/i, 'DELETE'],
  [/\bMERGE\s+INTO\b/i, 'MERGE'],
  [/\bTRUNCATE\b/i, 'TRUNCATE'],
  [/\bALTER\s+TABLE\b/i, 'ALTER TABLE'],
  [/\bDROP\s+(TABLE|VIEW|INDEX|CONSTRAINT|TRIGGER)\b/i, 'DROP'],
  [/\bGRANT\b/i, 'GRANT'],
  [/\bREVOKE\b/i, 'REVOKE'],
  [/\bCOPY\b[\s\S]{0,200}?\bFROM\b/i, 'COPY ... FROM'],
  [/\bset_config\s*\(/i, 'set_config (mutaria una GUC)'],
  [/\bnextval\s*\(/i, 'nextval (avanza una secuencia)'],
  [/\bassert_period_open\b/i, 'assert_period_open (VOLATILE: toma advisory lock)'],
  [/\bfinance_log_audit\b/i, 'finance_log_audit (escribe auditoria)'],
  [/\bfinance_begin_audit_scope\b/i, 'finance_begin_audit_scope (setea GUC)'],
  [/\bREFRESH\s+MATERIALIZED\b/i, 'REFRESH MATERIALIZED VIEW'],
]

let fallas = 0
const encontradas = []

for (const { nombre, cuerpo, decl } of cuerpos(sql)) {
  if (!FUNCIONES_ESPERADAS.includes(nombre)) continue
  encontradas.push(nombre)
  const limpio = despojar(cuerpo)
  const hallazgos = []
  for (const [re, etiqueta] of PROHIBIDOS) {
    const m = limpio.match(re)
    if (m) hallazgos.push({ etiqueta, fragmento: m[0].replace(/\s+/g, ' ').slice(0, 50) })
  }

  // Garantia declarativa: STABLE o IMMUTABLE (nunca VOLATILE).
  const esNoVolatil = /\b(STABLE|IMMUTABLE)\b/i.test(decl)
  if (!esNoVolatil) {
    hallazgos.push({ etiqueta: 'VOLATILE', fragmento: 'la funcion no se declara STABLE/IMMUTABLE: el motor NO le prohibe escribir' })
  }
  // search_path fijo.
  const tieneSearchPath = /SET\s+"?search_path"?\s+TO/i.test(decl) || nombre === 'finance_hc_mk'
  if (!tieneSearchPath) {
    hallazgos.push({ etiqueta: 'search_path', fragmento: 'SECURITY DEFINER sin search_path fijo' })
  }

  if (hallazgos.length) {
    fallas++
    console.error(`\n❌ ${nombre} — ${hallazgos.length} problema(s):`)
    for (const h of hallazgos) console.error(`   · ${h.etiqueta}: "${h.fragmento}"`)
  } else {
    console.log(`✅ ${nombre} — solo lectura (cuerpo limpio + declarada no-VOLATILE)`)
  }
}

for (const esperada of FUNCIONES_ESPERADAS) {
  if (!encontradas.includes(esperada)) {
    fallas++
    console.error(`\n❌ no se encontró la definición de ${esperada} en ${ARCHIVO}`)
  }
}

if (fallas) {
  console.error(`\n❌ Guard read-only del health check FALLÓ (${fallas}).`)
  process.exit(1)
}
console.log('\n✅ Guard read-only del health check OK: no escribe, y el motor se lo impide (STABLE).')
