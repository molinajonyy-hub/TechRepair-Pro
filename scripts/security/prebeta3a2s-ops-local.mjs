// PRE-BETA-3A-2S · LOCAL Docker only. Corre los SQL operativos de
// docs/prebeta3a2s contra el Supabase LOCAL (el contenedor supabase_db_*;
// nunca un remoto):
//
//   --preflight  preflight-readonly.sql: todos los GATES tienen que dar true.
//                Se corre con las dos migraciones 3A-2S apartadas (estado previo).
//   --ops        postdeploy-verify-readonly.sql: todos los CHECKS true; despues
//                smoke-rollback.sql completo (BEGIN ... ROLLBACK, sin FAIL).
//
// El binding de Portal Clic (portal-clic-binding.sql) NO se ejecuta aca: es un
// paso manual de un operador.
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const mode = process.argv[2]
if (mode !== '--preflight' && mode !== '--ops') {
  console.error('uso: node scripts/security/prebeta3a2s-ops-local.mjs --preflight|--ops')
  process.exit(2)
}

const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id = "([a-z0-9-]+)"/m)?.[1]
if (!project) throw new Error('Cannot identify local Supabase project')
const container = process.env.PREBETA3A2S_DB_CONTAINER || `supabase_db_${project}`
if (!/^supabase_db_[a-z0-9-]+$/.test(container)) throw new Error('A local Supabase DB container is required')

function psql(file, extra = []) {
  const r = spawnSync('docker', [
    'exec', '-i', container, 'psql', '-X', '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-P', 'pager=off', ...extra,
  ], { input: readFileSync(file, 'utf8'), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (r.error) throw r.error
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

// Filas `n|nombre|ok|detalle` del primer bloque de un -At; exige la fila 99 en true.
function requireAllTrue(file, label) {
  const r = psql(file, ['-A', '-t'])
  const rows = r.stdout.split('\n').filter((l) => /^\d+\|/.test(l))
  for (const row of rows) console.log(row)
  const total = rows.find((l) => l.startsWith('99|'))
  if (r.status !== 0 || total !== `99|${label}|t|`) {
    console.error(r.stderr)
    console.error(`FAIL ${file}: ${total ?? 'sin fila 99'} (exit ${r.status})`)
    process.exit(1)
  }
  console.log(`PASS ${file}`)
}

if (mode === '--preflight') {
  requireAllTrue('docs/prebeta3a2s/preflight-readonly.sql', 'TODOS LOS GATES')
} else {
  requireAllTrue('docs/prebeta3a2s/postdeploy-verify-readonly.sql', 'TODOS LOS CHECKS')
  const smoke = psql('docs/prebeta3a2s/smoke-rollback.sql')
  const passes = smoke.stderr.split('\n').filter((l) => l.includes('NOTICE:  PASS:')).length
  const skips = smoke.stderr.split('\n').filter((l) => l.includes('NOTICE:  SKIP:'))
  for (const s of skips) console.log(s)
  if (smoke.status !== 0 || !smoke.stderr.includes('SMOKE 3A-2S OK') || !/\nROLLBACK\s*$/.test(smoke.stdout)) {
    console.error(smoke.stderr.split('\n').filter((l) => /ERROR|FAIL/.test(l)).join('\n'))
    console.error(`FAIL smoke-rollback.sql (exit ${smoke.status}, ${passes} PASS)`)
    process.exit(1)
  }
  console.log(`PASS smoke-rollback.sql (${passes} PASS, ROLLBACK)`)
}
