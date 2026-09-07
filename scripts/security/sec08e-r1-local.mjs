// R1 compatibility only. No external URL accepted. All DDL/DML is confined to
// a new, disposable schema-only database; source data/secrets are never copied.
// Future schema/fixtures are read from the immutable #110 Git object, NOT
// shipped as R1 migrations or executed against the source database.
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import assert from 'node:assert/strict'

const source = 'supabase_db_techrepair-vite'
const database = 'sec08e_r1_certification'
const restName = 'sec08e-r1-rest'
const reference = 'a0ff8f75aad09166bc3e1efe160e83ce210b1686'
const migration = '20260922120000_sec08e_auxiliary_financial_reads.sql'
const ownership = 'SEC-08E R1 disposable schema-only tests'
let password = ''
let owned = false
let restOwned = false
const run = (cmd, args, input, env = process.env) => execFileSync(cmd, args, {
  input, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
})
const docker = (args, input) => run('docker', args[0] === 'exec' && args.includes('supabase_admin')
  ? ['exec', '-e', `PGPASSWORD=${password}`, ...args.slice(1)] : args, input)
const sql = query => docker(['exec', '-i', source, 'psql', '-X', '-U', 'supabase_admin', '-d', database, '-Atq', '-v', 'ON_ERROR_STOP=1'], query).trim()
const blob = path => run('git', ['show', `${reference}:${path}`])
const pause = () => new Promise(resolve => setTimeout(resolve, 200))

try {
  const futureSchema = blob(`supabase/migrations/${migration}`)
  const fixture = blob('tests/fixtures/sec08e.sql')
  const sourceConfig = JSON.parse(docker(['inspect', source]))[0]
  password = sourceConfig.Config.Env.find(value => value.startsWith('POSTGRES_PASSWORD='))?.slice('POSTGRES_PASSWORD='.length) || ''
  const version = docker(['exec', source, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atq', '-c', 'SELECT max(version) FROM supabase_migrations.schema_migrations']).trim()
  assert(/^\d{14}$/.test(version) && version >= '20260903120000' && version < migration.slice(0, 14), 'pre-SEC08E local source required')
  const existing = docker(['exec', source, 'psql', '-X', '-U', 'supabase_admin', '-d', 'postgres', '-Atq', '-c', `SELECT count(*) FROM pg_database WHERE datname='${database}'`]).trim()
  assert(existing === '0', 'Refusing to replace an existing database; inspect any leftover R1 database first')
  let schema = docker(['exec', source, 'pg_dump', '-U', 'postgres', '-d', 'postgres', '--schema-only', '--no-publications', '--no-subscriptions',
    ...['public', 'private', 'auth', 'storage', 'extensions', 'vault'].flatMap(name => ['--schema', name])])
  schema = schema.replace('CREATE FUNCTION', `CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE FUNCTION`)
  docker(['exec', source, 'createdb', '-U', 'supabase_admin', database])
  owned = true
  sql(`COMMENT ON DATABASE ${database} IS '${ownership}';`)
  sql('DROP SCHEMA public;')
  sql(schema)
  for (const file of readdirSync('supabase/migrations').sort().filter(file => file.slice(0, 14) > version && file < migration)) {
    sql('BEGIN; SET LOCAL ROLE postgres;\n' + readFileSync(`supabase/migrations/${file}`, 'utf8').replace(/^(BEGIN|COMMIT);\s*$/gm, '') + '\nCOMMIT;')
  }
  assert(sql("SELECT to_regclass('public.v_parts_used_amounts') IS NULL AND to_regprocedure('public.can_view_payment_allocations(uuid)') IS NULL") === 't')
  sql('BEGIN;\n' + fixture + '\nCOMMIT;')
  console.log('PASS R1 isolated baseline through SEC-08D; source ledger', version, '; no source data, cron or secrets copied')

  const rest = JSON.parse(docker(['inspect', source.replace('supabase_db_', 'supabase_rest_')]))[0]
  const uri = new URL(rest.Config.Env.find(value => value.startsWith('PGRST_DB_URI=')).slice('PGRST_DB_URI='.length))
  assert(uri.hostname === source, 'Only the local Docker source host is allowed')
  uri.pathname = '/' + database
  const secret = 'sec08e-r1-disposable-local-only-jwt-secret'
  docker(['run', '-d', '--name', restName, '--label', 'techrepair.test=sec08e-r1', '--network', Object.keys(rest.NetworkSettings.Networks)[0], '-p', '127.0.0.1::3000',
    '-e', `PGRST_DB_URI=${uri}`, '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${secret}`, rest.Config.Image])
  restOwned = true
  const port = JSON.parse(docker(['inspect', restName]))[0].NetworkSettings.Ports['3000/tcp'][0].HostPort
  const base = `http://127.0.0.1:${port}`
  const token = actor => {
    const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')
    const payload = Buffer.from(JSON.stringify({ sub: `e0800000-0000-0000-0000-${String(actor).padStart(12, '0')}`, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url')
    return `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`
  }
  for (const phase of ['pre', 'post']) {
    if (phase === 'post') {
      assert(sql("SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()") === ownership)
      sql('SET ROLE postgres;\n' + futureSchema)
    }
    const path = phase === 'pre' ? '/' : '/v_parts_used_amounts?limit=0'
    for (let attempt = 0; attempt < 50; attempt++) {
      try { if ((await fetch(base + path, { headers: { Authorization: `Bearer ${token(1)}` }, signal: AbortSignal.timeout(1000) })).ok) break } catch { /* local startup/schema cache */ }
      if (attempt === 49) throw Error('Local PostgREST readiness failed')
      await pause()
    }
    try {
      const output = run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.sec08e-r1.config.ts'], undefined, {
        ...process.env, SEC08E_R1_URL: base, SEC08E_R1_SCHEMA: phase,
        SEC08E_R1_OWNER: token(1), SEC08E_R1_TECH: token(2), SEC08E_R1_OTHER: token(5),
      })
      console.log(output)
    } catch (error) { console.error(error.stdout?.toString()); throw error }
  }
} catch (error) {
  // Avoid dumping child-process arguments, which may contain local credentials.
  console.error(error.stderr?.toString() || (error.status === undefined && error.code !== 'ERR_INVALID_URL' ? error.message : 'R1 local matrix failed'))
  process.exitCode = 1
} finally {
  if (restOwned) docker(['rm', '-f', restName])
  if (owned) docker(['exec', source, 'dropdb', '-U', 'supabase_admin', database])
}
