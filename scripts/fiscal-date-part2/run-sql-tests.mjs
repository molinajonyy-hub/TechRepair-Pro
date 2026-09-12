#!/usr/bin/env node
/**
 * Corre la regresión SQL de FISCAL DATE Parte 2 contra el Postgres local de
 * Supabase, sin dejar rastro.
 *
 *   node scripts/fiscal-date-part2/run-sql-tests.mjs [--container <nombre>]
 *
 * Qué hace:
 *   1. Lee la migración candidata y le saca SÓLO las líneas de control de
 *      transacción de nivel superior (`BEGIN;` / `COMMIT;` en columna 0).
 *      Los BEGIN/END de los bloques PL/pgSQL van indentados y no se tocan.
 *   2. Empalma ese cuerpo en el marcador `-- @@MIGRATION@@` del test.
 *   3. Manda todo por stdin a psql con ON_ERROR_STOP=1.
 *
 * El test entero vive en UNA transacción que termina en ROLLBACK: la migración
 * NO queda aplicada y las filas de fixture NO quedan committeadas. Si la
 * migración conservara su propio COMMIT, cerraría la transacción envolvente y
 * ambas cosas quedarían persistidas en la base local.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MIGRATION = join(repoRoot, 'supabase', 'migrations', '20260927120000_fiscal_date_part2.sql')
const TEST = join(repoRoot, 'tests', 'sql', 'fiscal_date_part2.test.sql')
const MARKER = '-- @@MIGRATION@@'

const argv = process.argv.slice(2)
const containerIdx = argv.indexOf('--container')
const container = containerIdx >= 0 ? argv[containerIdx + 1] : 'supabase_db_techrepair-vite'

/**
 * Saca el control de transacción de nivel superior, y sólo ese.
 *
 * OJO: el patrón NO puede incluir `END;` ni `ROLLBACK;`. Los cuerpos PL/pgSQL
 * de esta migración cierran con `END;` en columna 0 (el parser, el trigger y
 * la propia complete_arca_attempt), y comentarlos rompería las funciones.
 * El `BEGIN` de un bloque PL/pgSQL nunca lleva `;`, así que exigir el
 * punto y coma alcanza para distinguirlo del `BEGIN;` de la transacción.
 */
export function stripTopLevelTransactionControl(sql) {
  const lines = sql.split(/\r?\n/)
  const kept = []
  let removed = 0
  for (const line of lines) {
    if (/^(BEGIN|COMMIT|START TRANSACTION)\s*;\s*$/i.test(line)) {
      removed++
      kept.push(`-- [runner] quitado control de transacción: ${line.trim()}`)
      continue
    }
    kept.push(line)
  }
  if (removed === 0) {
    throw new Error('La migración no tiene BEGIN;/COMMIT; de nivel superior — revisar antes de correr el test.')
  }
  return { body: kept.join('\n'), removed }
}

const migration = readFileSync(MIGRATION, 'utf8')
const test = readFileSync(TEST, 'utf8')

if (!test.includes(MARKER)) {
  console.error(`[fdp2] el test no tiene el marcador ${MARKER}`)
  process.exit(2)
}

const { body, removed } = stripTopLevelTransactionControl(migration)

// El reemplazo va con FUNCIÓN, no con string. Con un string, `replace`
// interpreta los `$` del reemplazo: `$$` colapsa a un solo `$` (rompiendo cada
// dollar-quote `AS $$` de la migración) y `$'` inserta todo lo que viene
// DESPUÉS del match — y el parser contiene la regex '^[0-9]{8}$', o sea un
// `$'` literal, que además duplicaba la cola del archivo. Con una función,
// Postgres recibe el cuerpo byte a byte.
const sql = test.replace(MARKER, () => body)

console.log(`[fdp2] migración: ${MIGRATION}`)
console.log(`[fdp2] control de transacción removido: ${removed} línea(s)`)
console.log(`[fdp2] contenedor: ${container}`)
console.log('[fdp2] ────────────────────────────────────────────')

const psql = spawn('docker', [
  'exec', '-i', container,
  'psql', '-U', 'postgres', '-d', 'postgres',
  '-v', 'ON_ERROR_STOP=1', '--no-psqlrc', '-f', '-',
], { stdio: ['pipe', 'inherit', 'inherit'] })

psql.stdin.write(sql)
psql.stdin.end()

psql.on('close', (code) => {
  console.log('[fdp2] ────────────────────────────────────────────')
  if (code === 0) {
    console.log('[fdp2] REGRESIÓN SQL OK (transacción revertida: la base local quedó intacta)')
  } else {
    console.error(`[fdp2] REGRESIÓN SQL FALLÓ (psql exit ${code})`)
  }
  process.exit(code ?? 1)
})
