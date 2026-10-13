/** LOCAL ONLY: schema clone, isolated database/PostgREST, real constraints + billing matrix.
 * Reuses installed Docker images; never resets the user's local database or accesses production.
 */
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'

const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id = "([a-z0-9-]+)"/m)?.[1]
assert(project && /^[a-z0-9-]+$/.test(project))
const sourceDb = `supabase_db_${project}`
const sourceRest = JSON.parse(docker(['inspect', `supabase_rest_${project}`]))[0]
const env = Object.fromEntries(sourceRest.Config.Env.map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)] }))
const dbUri = new URL(env.PGRST_DB_URI)
assert(dbUri.hostname === sourceDb && dbUri.pathname === '/postgres', 'Source must be the configured LOCAL Docker database')
const suffix = randomBytes(6).toString('hex')
const database = `beta_mp_recovery_${suffix}`
const restName = `supabase_rest_beta-mp-recovery-${suffix}`
const dir = mkdtempSync(join(tmpdir(), 'beta-mp-local-'))
const envFile = join(dir, 'rest.env')
const pgEnvFile = join(dir, 'postgres.env')
const dbConfig = JSON.parse(docker(['inspect', sourceDb]))[0]
const localPassword = dbConfig.Config.Env.find(entry => entry.startsWith('POSTGRES_PASSWORD='))?.slice('POSTGRES_PASSWORD='.length)
assert(localPassword && !/[\r\n]/.test(localPassword), 'Local database password is unavailable')
writeFileSync(pgEnvFile, `PGPASSWORD=${localPassword}`, { mode: 0o600 })
let created = false, started = false
let proxy
let phase = 'schema clone'
const sql = q => docker(['exec', '--env-file', pgEnvFile, '-i', sourceDb, 'psql', '-X', '-U', 'supabase_admin', '-d', database, '-v', 'ON_ERROR_STOP=1'], q)
try {
  // pg_cron is cluster-bound to postgres. It is irrelevant to this isolated billing matrix.
  const schema = docker(['exec', sourceDb, 'pg_dump', '-U', 'postgres', '-d', 'postgres', '--schema-only',
    '--exclude-extension=pg_cron', '--exclude-schema=cron', '--exclude-extension=pg_graphql',
    '--exclude-schema=graphql', '--exclude-schema=graphql_public', '--no-publications', '--no-subscriptions'])
  docker(['exec', sourceDb, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${database}`])
  created = true
  phase = 'schema restore'
  sql(schema)
  for (const file of ['20261012120000_beta_mp_checkout_session_server_authority.sql',
    '20261013120000_beta_mp_plan_b_session_preapproval_unique.sql', '20261015120000_beta_mp_recovery_payment_identity.sql']) {
    phase = file
    sql(readFileSync(`supabase/migrations/${file}`, 'utf8'))
    const version = file.slice(0, 14)
    assert(/^\d{14}$/.test(version))
    sql(`INSERT INTO supabase_migrations.schema_migrations(version) VALUES ('${version}')`)
  }
  phase = 'SQL authority matrix'
  sql(readFileSync('tests/sql/beta_mp_checkout_authority.test.sql', 'utf8'))
  phase = 'SQL payment identity'
  sql(readFileSync('tests/sql/beta_mp_recovery_payment_identity.test.sql', 'utf8'))
  dbUri.pathname = `/${database}`
  const configured = { ...env, PGRST_DB_URI: dbUri.href, PGRST_SERVER_PORT: '3000', PGRST_DB_SCHEMAS: 'public' }
  const entries = Object.entries(configured).filter(([key]) => key.startsWith('PGRST_'))
  assert(entries.every(([, value]) => !/[\r\n]/.test(value)))
  writeFileSync(envFile, entries.map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 })
  const network = Object.keys(sourceRest.NetworkSettings.Networks)[0]
  phase = 'isolated PostgREST startup'
  docker(['run', '--pull=never', '-d', '--name', restName, '--network', network,
    '--env-file', envFile, '-p', '127.0.0.1::3000', sourceRest.Image])
  started = true
  const inspect = JSON.parse(docker(['inspect', restName]))[0]
  const port = inspect.NetworkSettings.Ports['3000/tcp'][0].HostPort
  const apiUrl = `http://127.0.0.1:${port}`
  let healthy = false
  for (let n = 0; n < 300; n++) {
    try { const r = await fetch(apiUrl); if (r.status < 500) { healthy = true; break } } catch { /* local startup */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!healthy) {
    const log = execFileSync('docker', ['logs', restName], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    console.error(log.split('\n').filter(line => /error|failed|fatal/i.test(line)).slice(-4)
      .map(line => line.replace(/postgres(?:ql)?:\/\/\S+/g, '[local database URI]')).join('\n'))
  }
  assert(healthy, 'Isolated PostgREST did not become ready')
  phase = 'isolated billing integration'
  // supabase-js uses /rest/v1, normally routed by Kong. Keep that exact contract
  // with a localhost-only prefix proxy; all authorization stays in real PostgREST.
  proxy = createServer(async (req, res) => {
    if (!/^\/rest\/v1(?:\/|\?|$)/.test(req.url ?? '')) { res.writeHead(404).end(); return }
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined && !['host', 'connection', 'content-length'].includes(key)) headers.set(key, String(value))
      }
      const response = await fetch(apiUrl + (req.url.slice('/rest/v1'.length) || '/'), {
        method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
      })
      const out = new Headers(response.headers)
      for (const key of ['content-encoding', 'content-length', 'transfer-encoding']) out.delete(key)
      res.writeHead(response.status, Object.fromEntries(out))
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch { res.writeHead(503).end('Local proxy unavailable') }
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const clientUrl = `http://127.0.0.1:${proxy.address().port}`
  console.log('Isolated LOCAL PostgreSQL/PostgREST: migration + SQL constraints passed')
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/billing/beta-mp-local.mjs'], {
      stdio: 'inherit', env: { ...process.env, BETA_MP_DB_CONTAINER: sourceDb, BETA_MP_DB_NAME: database,
        BETA_MP_REST_CONTAINER: restName, BETA_MP_LOCAL_API_URL: clientUrl },
    })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Local matrix exit ${code}`)))
  })
} catch (error) {
  // Child-process diagnostics can contain private local configuration. Print no raw stdout/stderr.
  console.error(`Isolated billing verification failed at ${phase} (${error?.status ?? error?.name ?? 'unknown'}).`)
  const sqlError = String(error?.stderr ?? '').split('\n').find(line => /^ERROR:|FATAL:/.test(line))
  if (sqlError) console.error(sqlError.slice(0, 300))
  if (error instanceof assert.AssertionError) console.error(error.message)
  process.exitCode = 1
} finally {
  if (proxy) await new Promise(resolve => proxy.close(resolve))
  if (started) docker(['rm', '-f', restName])
  if (created) {
    assert(/^beta_mp_recovery_[a-f0-9]{12}$/.test(database))
    docker(['exec', sourceDb, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-c', `DROP DATABASE ${database} WITH (FORCE)`])
  }
  try { unlinkSync(envFile) } catch { /* creation may have failed before the env file */ }
  unlinkSync(pgEnvFile)
  rmdirSync(dir)
}
