#!/usr/bin/env node
// ============================================================================
// M7 Lote 7A — Guard estatico de SOLO LECTURA para el preflight productivo.
//
// Falla (exit 1) si encuentra una sentencia de escritura fuera de un comentario.
// CREATE/UPDATE/etc. estan permitidos DENTRO de comentarios explicativos, nunca
// como sentencia.
//
//   node scripts/finance/guard-readonly-sql.mjs docs/auditoria-finanzas/m7/*.sql
// ============================================================================
import { readFileSync } from 'node:fs'

const archivos = process.argv.slice(2)
if (archivos.length === 0) {
  console.error('uso: node guard-readonly-sql.mjs <archivo.sql> [...]')
  process.exit(2)
}

// Quita comentarios de linea (--) y de bloque, y el contenido de los literales
// de cadena, para no marcar falsos positivos por texto explicativo.
function despojar(sql) {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const dos = sql.slice(i, i + 2)
    if (dos === '--') {                       // comentario de linea
      const fin = sql.indexOf('\n', i)
      i = fin === -1 ? n : fin
      continue
    }
    if (dos === '/*') {                       // comentario de bloque
      const fin = sql.indexOf('*/', i + 2)
      i = fin === -1 ? n : fin + 2
      continue
    }
    if (sql[i] === "'") {                     // literal de cadena
      i++
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue }
        if (sql[i] === "'") { i++; break }
        i++
      }
      out += " '' "
      continue
    }
    out += sql[i]
    i++
  }
  return out
}

// \b no sirve con `COPY ... FROM`; se usan patrones explicitos por sentencia.
const PROHIBIDOS = [
  [/\bINSERT\s+INTO\b/i,          'INSERT'],
  [/\bUPDATE\s+\w/i,              'UPDATE'],
  [/\bDELETE\s+FROM\b/i,          'DELETE'],
  [/\bMERGE\s+INTO\b/i,           'MERGE'],
  [/\bALTER\s+(TABLE|VIEW|FUNCTION|INDEX|SEQUENCE|TYPE|SCHEMA|DATABASE|ROLE)\b/i, 'ALTER'],
  // CREATE TEMP/TEMPORARY tambien escribe: en una tx read-only fallaria, pero no
  // debe estar en un preflight.
  [/\bCREATE\s+(OR\s+REPLACE\s+)?(TEMP\s+|TEMPORARY\s+|UNLOGGED\s+|MATERIALIZED\s+)?(TABLE|VIEW|FUNCTION|INDEX|TRIGGER|SCHEMA|ROLE|TYPE|SEQUENCE|EXTENSION|POLICY)\b/i, 'CREATE'],
  [/\bDROP\s+(TABLE|VIEW|FUNCTION|INDEX|TRIGGER|SCHEMA|ROLE|TYPE|SEQUENCE|EXTENSION|POLICY|CONSTRAINT)\b/i, 'DROP'],
  [/\bTRUNCATE\b/i,               'TRUNCATE'],
  [/\bGRANT\b/i,                  'GRANT'],
  [/\bREVOKE\b/i,                 'REVOKE'],
  [/\bCOMMENT\s+ON\b/i,           'COMMENT'],
  [/\bCALL\s+\w/i,                'CALL'],
  [/\bDO\s*\$/i,                  'DO'],
  [/\bCOPY\b[\s\S]{0,200}?\bFROM\b/i, 'COPY ... FROM'],
  [/\bPERFORM\b/i,                'PERFORM'],
  [/\bREFRESH\s+MATERIALIZED\b/i, 'REFRESH MATERIALIZED VIEW'],
  [/\bSELECT\b[\s\S]{0,80}?\bINTO\s+(?!STRICT)\w/i, 'SELECT ... INTO (crea tabla)'],
  [/\bdb\s+push\b/i,              'db push'],
  [/\bmigration\s+up\b/i,         'migration up'],
  [/\bsupabase\s+db\b/i,          'supabase db'],
]

let fallas = 0
for (const archivo of archivos) {
  const crudo = readFileSync(archivo, 'utf8')
  const limpio = despojar(crudo)
  const hallazgos = []
  for (const [re, nombre] of PROHIBIDOS) {
    const m = limpio.match(re)
    if (m) {
      // numero de linea aproximado sobre el texto despojado
      const antes = limpio.slice(0, m.index)
      hallazgos.push({ nombre, fragmento: m[0].replace(/\s+/g, ' ').slice(0, 60), linea: antes.split('\n').length })
    }
  }
  if (hallazgos.length) {
    fallas++
    console.error(`\n❌ ${archivo} — ${hallazgos.length} sentencia(s) de escritura:`)
    for (const h of hallazgos) console.error(`   · ${h.nombre} (~linea ${h.linea} del texto sin comentarios): "${h.fragmento}"`)
  } else {
    console.log(`✅ ${archivo} — solo lectura`)
  }
}

if (fallas) {
  console.error(`\n❌ Guard read-only FALLÓ en ${fallas} archivo(s). No ejecutar contra producción.`)
  process.exit(1)
}
console.log('\n✅ Guard read-only OK: ningún archivo contiene sentencias de escritura.')
