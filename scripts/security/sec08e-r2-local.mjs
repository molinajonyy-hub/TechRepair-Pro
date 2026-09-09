// SEC-08E R2 certification against disposable PostgreSQL + PostgREST v14.
// No URL or credential input is accepted. Source rows, secrets, and cron are
// never copied; every write is confined to a newly-created local database.
import { createHmac } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import net from 'node:net'
import assert from 'node:assert/strict'

const source = 'supabase_db_techrepair-vite'
const database = 'sec08e_r2_certification'
const restName = 'sec08e-r2-rest'
const ownership = 'SEC-08E R2 disposable PostgreSQL/PostgREST certification'
const r2a = '20260923120000_sec08e_r2a_client_contract_gate_disabled.sql'
const r2b = '20260924120000_sec08e_r2b_client_contract_gate_minimum_1.sql'
const fixtureRef = 'a0ff8f75aad09166bc3e1efe160e83ce210b1686'
let password = ''
let owned = false
let restOwned = false
let passed = 0

const run = (cmd, args, input, env = process.env) => execFileSync(cmd, args, {
  input, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
})
const docker = (args, input) => run('docker', args[0] === 'exec' && args.includes('supabase_admin')
  ? ['exec', '-e', `PGPASSWORD=${password}`, ...args.slice(1)] : args, input)
const sql = query => docker(['exec', '-i', source, 'psql', '-X', '-U', 'supabase_admin', '-d', database,
  '-Atq', '-v', 'ON_ERROR_STOP=1'], query).trim()
const sqlAsync = query => new Promise((resolve, reject) => {
  const child = spawn('docker', ['exec', '-i', '-e', `PGPASSWORD=${password}`, source,
    'psql', '-X', '-U', 'supabase_admin', '-d', database, '-Atq', '-v', 'ON_ERROR_STOP=1'],
  { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk })
  child.on('error', reject)
  child.on('close', code => resolve({ code, stdout, stderr }))
  child.stdin.end(query)
})
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const scenario = async (name, test) => {
  await test()
  passed++
  console.log(`PASS ${String(passed).padStart(2, '0')} ${name}`)
}
const token = (actor, role = 'authenticated') => {
  const secret = 'sec08e-r2-disposable-local-only-jwt-secret'
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')
  const claims = { role, exp: Math.floor(Date.now() / 1000) + 900 }
  if (actor) claims.sub = `e0800000-0000-0000-0000-${String(actor).padStart(12, '0')}`
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`
}

try {
  const sourceConfig = JSON.parse(docker(['inspect', source]))[0]
  password = sourceConfig.Config.Env.find(value => value.startsWith('POSTGRES_PASSWORD='))?.slice('POSTGRES_PASSWORD='.length) || ''
  const version = docker(['exec', source, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atq', '-c',
    'SELECT max(version) FROM supabase_migrations.schema_migrations']).trim()
  assert(version >= '20260920120000' && version < r2a.slice(0, 14), `unexpected source ledger ${version}`)
  assert.equal(docker(['exec', source, 'psql', '-X', '-U', 'supabase_admin', '-d', 'postgres', '-Atq', '-c',
    `SELECT count(*) FROM pg_database WHERE datname='${database}'`]).trim(), '0', 'refusing to replace leftover database')

  let schema = docker(['exec', source, 'pg_dump', '-U', 'postgres', '-d', 'postgres', '--schema-only',
    '--no-publications', '--no-subscriptions', ...['public', 'private', 'auth', 'storage', 'extensions', 'vault', 'graphql', 'graphql_public']
      .flatMap(name => ['--schema', name])])
  schema = schema.replace('CREATE FUNCTION', `CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_graphql WITH SCHEMA graphql;
CREATE FUNCTION`)
  docker(['exec', source, 'createdb', '-U', 'supabase_admin', database])
  owned = true
  sql(`COMMENT ON DATABASE ${database} IS '${ownership}'; DROP SCHEMA public;`)
  sql(schema)
  for (const file of readdirSync('supabase/migrations').sort()
    .filter(file => file.slice(0, 14) > version && file < r2a)) {
    sql('BEGIN; SET LOCAL ROLE postgres;\n' + readFileSync(`supabase/migrations/${file}`, 'utf8')
      .replace(/^(BEGIN|COMMIT);\s*$/gm, '') + '\nCOMMIT;')
  }
  const fixture = run('git', ['show', `${fixtureRef}:tests/fixtures/sec08e.sql`])
  sql('BEGIN; SET LOCAL ROLE postgres;\n' + fixture + '\nCOMMIT;')
  sql(`SET ROLE postgres;
    CREATE OR REPLACE FUNCTION public.sec08e_r2_test_identity() RETURNS jsonb LANGUAGE sql AS $$
      SELECT jsonb_build_object('current_user', current_user, 'request_role', current_setting('role', true),
        'claim_role', coalesce(current_setting('request.jwt.claims', true), '{}')::jsonb->>'role') $$;
    CREATE OR REPLACE FUNCTION public.sec08e_r2_test_sleep(p_seconds numeric) RETURNS text LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(p_seconds); RETURN current_user; END $$;
    CREATE OR REPLACE FUNCTION public.sec08e_r2_test_header() RETURNS text LANGUAGE sql AS $$
      SELECT coalesce(current_setting('request.headers', true), '{}')::jsonb->>'x-techrepair-client-contract' $$;
    SET ROLE supabase_admin;
    CREATE OR REPLACE FUNCTION graphql_public.graphql(
      "operationName" text DEFAULT NULL, query text DEFAULT NULL, variables jsonb DEFAULT NULL, extensions jsonb DEFAULT NULL
    ) RETURNS jsonb LANGUAGE sql AS $$
      SELECT graphql.resolve(query := query, variables := coalesce(variables, '{}'),
        "operationName" := "operationName", extensions := extensions) $$;
    GRANT USAGE ON SCHEMA graphql TO anon, authenticated, service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA graphql TO anon, authenticated, service_role;
    GRANT USAGE ON SCHEMA graphql_public TO anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION graphql_public.graphql(text,text,jsonb,jsonb) TO anon, authenticated, service_role;
    SET ROLE postgres;
    GRANT EXECUTE ON FUNCTION public.sec08e_r2_test_identity() TO anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.sec08e_r2_test_sleep(numeric) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.sec08e_r2_test_header() TO authenticated;`)
  let migrationA = readFileSync(`supabase/migrations/${r2a}`, 'utf8')
    .replace('IN DATABASE postgres', `IN DATABASE ${database}`)
  sql('SET ROLE postgres;\n' + migrationA)
  assert.equal(sql("SELECT enforcement_state||':'||coalesce(minimum_contract::text,'null') FROM private.client_contract_config"), 'disabled:null')
  assert.equal(sql(`SELECT setting FROM pg_db_role_setting s
    JOIN pg_database d ON d.oid=s.setdatabase JOIN pg_roles r ON r.oid=s.setrole,
    unnest(s.setconfig) setting WHERE d.datname='${database}' AND r.rolname='authenticator'
      AND setting LIKE 'pgrst.db_pre_request=%'`).replace('pgrst.db_pre_request=', ''), 'public.check_client_contract')

  const rest = JSON.parse(docker(['inspect', source.replace('supabase_db_', 'supabase_rest_')]))[0]
  const uri = new URL(rest.Config.Env.find(value => value.startsWith('PGRST_DB_URI=')).slice('PGRST_DB_URI='.length))
  assert.equal(uri.hostname, source)
  uri.pathname = '/' + database
  docker(['run', '-d', '--name', restName, '--label', 'techrepair.test=sec08e-r2',
    '--network', Object.keys(rest.NetworkSettings.Networks)[0], '-p', '127.0.0.1::3000',
    '-e', `PGRST_DB_URI=${uri}`, '-e', 'PGRST_DB_SCHEMAS=public,graphql_public',
    '-e', 'PGRST_DB_EXTRA_SEARCH_PATH=public,extensions', '-e', 'PGRST_DB_ANON_ROLE=anon',
    '-e', 'PGRST_JWT_SECRET=sec08e-r2-disposable-local-only-jwt-secret', rest.Config.Image])
  restOwned = true
  const port = JSON.parse(docker(['inspect', restName]))[0].NetworkSettings.Ports['3000/tcp'][0].HostPort
  const base = `http://127.0.0.1:${port}`
  const auth = (actor, contract, extras = {}) => ({
    Authorization: `Bearer ${token(actor)}`, ...(contract === undefined ? {} : { 'x-techrepair-client-contract': contract }), ...extras,
  })
  const request = async (path, options = {}) => {
    const response = await fetch(base + path, { ...options, signal: AbortSignal.timeout(10000) })
    const text = options.method === 'HEAD' ? '' : await response.text()
    let body = text
    try { body = text ? JSON.parse(text) : null } catch { /* retain text */ }
    return { status: response.status, body, headers: response.headers }
  }
  const updateRequired = result => {
    assert.equal(result.status, 409, JSON.stringify(result.body))
    assert.deepEqual(result.body, {
      code: 'CLIENT_UPDATE_REQUIRED', message: 'Actualizá la aplicación para continuar.', details: null, hint: null,
    })
    assert(!JSON.stringify(result.body).match(/check_client|schema|claim|SQL|private/i))
  }
  let readiness
  for (let attempt = 0; attempt < 60; attempt++) {
    try { readiness = await request('/'); if (readiness.status === 200) break } catch { /* startup */ }
    if (attempt === 59) throw Error(`disposable PostgREST did not become ready: ${JSON.stringify(readiness)}`)
    await pause(200)
  }

  const anonBaseline = await request('/businesses?select=id&limit=0')
  const migrationB = readFileSync(`supabase/migrations/${r2b}`, 'utf8')
  const contractState = () => sql("SELECT enforcement_state||':'||coalesce(minimum_contract::text,'null') FROM private.client_contract_config")
  await scenario('STATE BEFORE is exactly disabled/NULL', async () => assert.equal(contractState(), 'disabled:null'))
  await scenario('authenticated / gate OFF / header absent passes', async () =>
    assert.equal((await request('/orders?select=id&limit=0', { headers: auth(1) })).status, 200))
  await scenario('authenticated / gate OFF / contract 1 passes', async () =>
    assert.equal((await request('/orders?select=id&limit=0', { headers: auth(1, '1') })).status, 200))
  await scenario('real PostgREST request role and signed authenticated claim agree', async () => {
    const r = await request('/rpc/sec08e_r2_test_identity', { method: 'POST', headers: { ...auth(1), 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(r.status, 200); assert.deepEqual(r.body, { current_user: 'authenticated', request_role: 'authenticated', claim_role: 'authenticated' })
  })

  const admitted = request('/rpc/sec08e_r2_test_sleep', {
    method: 'POST', headers: { ...auth(1), 'Content-Type': 'application/json' }, body: '{"p_seconds":2}',
  })
  // Let undici dispatch the request before the synchronous SQL observations.
  await pause(50)
  for (let attempt = 0; attempt < 80; attempt++) {
    if (sql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND query LIKE '%sec08e_r2_test_sleep%' AND query NOT LIKE 'SELECT count(*) FROM pg_stat_activity%' AND state='active'") !== '0') break
    if (attempt === 79) throw Error('slow admitted request was not observed')
    await pause(50)
  }
  await scenario('R2B exact migration applies from disabled/NULL', async () => {
    sql('SET ROLE postgres;\n' + migrationB)
    assert.equal(contractState(), 'enabled:1')
  })
  await scenario('request admitted before activation may finish', async () => assert.equal((await admitted).status, 200))
  await scenario('STATE AFTER is exactly enabled/1', async () => assert.equal(contractState(), 'enabled:1'))
  await scenario('R2B reapply fails and preserves enabled/1', async () => {
    assert.throws(() => sql('SET ROLE postgres;\n' + migrationB))
    assert.equal(contractState(), 'enabled:1')
  })
  sql("SET ROLE postgres; UPDATE private.client_contract_config SET minimum_contract=2 WHERE singleton IS TRUE;")
  await scenario('R2B rejects a wrong initial state without changing it', async () => {
    assert.equal(contractState(), 'enabled:2')
    assert.throws(() => sql('SET ROLE postgres;\n' + migrationB))
    assert.equal(contractState(), 'enabled:2')
  })
  sql('SET ROLE postgres; DELETE FROM private.client_contract_config;')
  await scenario('R2B rejects a missing configuration row', async () => {
    assert.throws(() => sql('SET ROLE postgres;\n' + migrationB))
    assert.equal(sql('SELECT count(*) FROM private.client_contract_config'), '0')
  })
  sql("SET ROLE postgres; INSERT INTO private.client_contract_config(singleton,enforcement_state,minimum_contract) VALUES(true,'disabled',NULL);")
  sql(`SET ROLE postgres;
    CREATE FUNCTION private.sec08e_r2_test_activation_delay() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$;
    CREATE TRIGGER sec08e_r2_test_activation_delay
      BEFORE UPDATE ON private.client_contract_config
      FOR EACH ROW EXECUTE FUNCTION private.sec08e_r2_test_activation_delay();`)
  await scenario('two concurrent R2B activations allow exactly one transition', async () => {
    const attempts = await Promise.all([
      sqlAsync('SET ROLE postgres;\n' + migrationB),
      sqlAsync('SET ROLE postgres;\n' + migrationB),
    ])
    assert.equal(attempts.filter(result => result.code === 0).length, 1, JSON.stringify(attempts))
    assert.equal(attempts.filter(result => result.code !== 0).length, 1, JSON.stringify(attempts))
    assert.equal(contractState(), 'enabled:1')
  })
  sql(`SET ROLE postgres;
    DROP TRIGGER sec08e_r2_test_activation_delay ON private.client_contract_config;
    DROP FUNCTION private.sec08e_r2_test_activation_delay();`)
  await scenario('authenticated / gate ON / header absent rejects', async () => updateRequired(await request('/orders?select=id', { headers: auth(1) })))
  for (const [label, value] of [['zero', '0'], ['alphabetic', 'abc'], ['empty', ''], ['negative', '-1'],
    ['decimal', '1.5'], ['internal whitespace', '1 2'], ['leading zero', '01']]) {
    await scenario(`gate ON rejects ${label} contract`, async () => updateRequired(await request('/orders?select=id', { headers: auth(1, value) })))
  }
  await scenario('gate ON accepts minimum contract 1 then RLS runs', async () =>
    assert.equal((await request('/orders?select=id', { headers: auth(1, '1') })).status, 200))
  await scenario('gate ON accepts future contract 2', async () =>
    assert.equal((await request('/orders?select=id', { headers: auth(1, '2') })).status, 200))
  await scenario('HTTP-normalized surrounding OWS is canonical contract 1', async () =>
    assert.equal((await request('/orders?select=id', { headers: auth(1, ' 1 ') })).status, 200))

  const rawDuplicate = await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) })
    let raw = ''
    socket.setEncoding('utf8'); socket.on('data', chunk => { raw += chunk }); socket.on('error', reject)
    socket.on('end', () => {
      const [head, body = ''] = raw.split('\r\n\r\n')
      resolve({ status: Number(head.match(/^HTTP\/1\.1 (\d+)/)?.[1]), body: JSON.parse(body) })
    })
    socket.write(`POST /rpc/sec08e_r2_test_header HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token(1)}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nx-techrepair-client-contract: 1\r\nx-techrepair-client-contract: 2\r\nConnection: close\r\n\r\n{}`)
  })
  await scenario('PostgREST v14 collapses duplicate headers before db_pre_request', async () => {
    assert.equal(rawDuplicate.status, 200); assert.equal(rawDuplicate.body, '2')
  })
  await scenario('comma-ambiguous exposed contract rejects fail-closed', async () =>
    updateRequired(await request('/orders?select=id', { headers: auth(1, '1,2') })))
  await scenario('browser headers cannot simulate service_role', async () => updateRequired(await request('/orders?select=id', {
    headers: auth(1, undefined, { 'x-role': 'service_role', 'x-service-role': 'true', 'x-user': 'internal' }),
  })))
  await scenario('anon remains on existing public/RLS behavior without contract', async () => {
    const r = await request('/businesses?select=id&limit=0')
    assert.equal(r.status, anonBaseline.status); assert.deepEqual(r.body, anonBaseline.body); assert.notEqual(r.status, 409)
  })
  await scenario('signed service_role is exempt without contract', async () => {
    const r = await request('/rpc/sec08e_r2_test_identity', { method: 'POST', headers: {
      Authorization: `Bearer ${token(null, 'service_role')}`, 'Content-Type': 'application/json',
    }, body: '{}' })
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.current_user, 'service_role')
  })
  await scenario('RPC POST rejects a headerless authenticated request', async () =>
    updateRequired(await request('/rpc/current_user_can_in_business', { method: 'POST', headers: {
      ...auth(1), 'Content-Type': 'application/json',
    }, body: '{"p_business_id":"e0800000-0000-0000-0000-000000000101","p_key":"orders_view_financials"}' })))
  await scenario('RPC POST is gated and compatible request reaches capability logic', async () => {
    const r = await request('/rpc/current_user_can_in_business', { method: 'POST', headers: { ...auth(1, '1'), 'Content-Type': 'application/json' },
      body: '{"p_business_id":"e0800000-0000-0000-0000-000000000101","p_key":"orders_view_financials"}' })
    assert.equal(r.status, 200); assert.equal(r.body, true)
  })
  await scenario('HEAD rejects a headerless authenticated request', async () =>
    assert.equal((await request('/orders?select=id', { method: 'HEAD', headers: auth(1) })).status, 409))
  await scenario('HEAD is gated and compatible request continues', async () =>
    assert.equal((await request('/orders?select=id', { method: 'HEAD', headers: auth(1, '1') })).status, 200))
  await scenario('relationship embed rejects a headerless authenticated request', async () =>
    updateRequired(await request('/orders?select=id,customer:customers(id)&limit=1', { headers: auth(1) })))
  await scenario('relationship embed is gated and compatible request continues', async () => {
    const r = await request('/orders?select=id,customer:customers(id)&limit=1', { headers: auth(1, '1') })
    assert.equal(r.status, 200); assert.equal(r.body.length, 1); assert(r.body[0].customer)
  })
  const partId = 'e0800000-0000-0000-0000-000000000499'
  const rejectedPartId = 'e0800000-0000-0000-0000-000000000498'
  await scenario('REST POST rejects before DML when the contract is missing', async () => {
    const r = await request('/parts_used?select=id', { method: 'POST', headers: {
      ...auth(1), 'Content-Type': 'application/json', Prefer: 'return=representation',
    }, body: JSON.stringify({ id: rejectedPartId, order_id: 'e0800000-0000-0000-0000-000000000301', business_id: 'e0800000-0000-0000-0000-000000000101', code: 'R2-REJECT', description: 'R2 rejected', quantity: 1, unit_price: 1 }) })
    updateRequired(r)
    assert.equal(sql(`SELECT count(*) FROM public.parts_used WHERE id='${rejectedPartId}'`), '0')
  })
  await scenario('REST POST with returning is gated', async () => {
    const r = await request('/parts_used?select=id,description', { method: 'POST', headers: { ...auth(1, '1'), 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ id: partId, order_id: 'e0800000-0000-0000-0000-000000000301', business_id: 'e0800000-0000-0000-0000-000000000101', code: 'R2', description: 'R2 gate', quantity: 1, unit_price: 1 }) })
    assert.equal(r.status, 201); assert.equal(r.body[0].id, partId)
  })
  await scenario('REST PATCH rejects before DML when the contract is missing', async () => {
    updateRequired(await request(`/parts_used?id=eq.${partId}&select=id`, { method: 'PATCH', headers: {
      ...auth(1), 'Content-Type': 'application/json', Prefer: 'return=representation',
    }, body: '{"description":"must not persist"}' }))
    assert.equal(sql(`SELECT description FROM public.parts_used WHERE id='${partId}'`), 'R2 gate')
  })
  await scenario('REST PATCH with returning is gated', async () => {
    const r = await request(`/parts_used?id=eq.${partId}&select=id,description`, { method: 'PATCH', headers: { ...auth(1, '1'), 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: '{"description":"R2 patched"}' })
    assert.equal(r.status, 200); assert.equal(r.body[0].description, 'R2 patched')
  })
  await scenario('REST DELETE rejects before DML when the contract is missing', async () => {
    updateRequired(await request(`/parts_used?id=eq.${partId}&select=id`, { method: 'DELETE', headers: {
      ...auth(1), Prefer: 'return=representation',
    } }))
    assert.equal(sql(`SELECT count(*) FROM public.parts_used WHERE id='${partId}'`), '1')
  })
  await scenario('REST DELETE with returning is gated', async () => {
    const r = await request(`/parts_used?id=eq.${partId}&select=id`, { method: 'DELETE', headers: { ...auth(1, '1'), Prefer: 'return=representation' } })
    assert.equal(r.status, 200); assert.equal(r.body[0].id, partId)
  })
  await scenario('limited tech contract 1 remains denied by capability', async () => {
    const r = await request('/rpc/current_user_can_in_business', { method: 'POST', headers: { ...auth(2, '1'), 'Content-Type': 'application/json' },
      body: '{"p_business_id":"e0800000-0000-0000-0000-000000000101","p_key":"orders_view_financials"}' })
    assert.equal(r.status, 200); assert.equal(r.body, false)
  })
  await scenario('cross-tenant contract 1 remains denied by RLS', async () => {
    const r = await request('/orders?id=eq.e0800000-0000-0000-0000-000000000301&select=id', { headers: auth(5, '1') })
    assert.equal(r.status, 200); assert.deepEqual(r.body, [])
  })
  await scenario('forged high contract grants no authority', async () => {
    const r = await request('/rpc/current_user_can_in_business', { method: 'POST', headers: { ...auth(2, '999999'), 'Content-Type': 'application/json' },
      body: '{"p_business_id":"e0800000-0000-0000-0000-000000000101","p_key":"orders_view_financials"}' })
    assert.equal(r.status, 200); assert.equal(r.body, false)
  })
  await scenario('owner contract 1 retains normal authority', async () => {
    const r = await request('/orders?id=eq.e0800000-0000-0000-0000-000000000301&select=id', { headers: auth(1, '1') })
    assert.equal(r.status, 200); assert.equal(r.body.length, 1)
  })
  assert.equal(sql("SELECT to_regprocedure('graphql_public.graphql(text,text,jsonb,jsonb)') IS NOT NULL"), 't')
  assert.equal(sql("SELECT has_schema_privilege('authenticated','graphql_public','USAGE') AND has_function_privilege('authenticated','graphql_public.graphql(text,text,jsonb,jsonb)','EXECUTE')"), 't')
  await scenario('GraphQL RPC path rejects incompatible authenticated request', async () =>
    updateRequired(await request('/rpc/graphql', { method: 'POST', headers: { ...auth(1), 'Content-Type': 'application/json', 'Content-Profile': 'graphql_public' }, body: '{"query":"query { __typename }"}' })))
  await scenario('GraphQL RPC path accepts compatible authenticated request', async () => {
    const r = await request('/rpc/graphql', { method: 'POST', headers: { ...auth(1, '1'), 'Content-Type': 'application/json', 'Content-Profile': 'graphql_public' }, body: '{"query":"query { __typename }"}' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
  })
  sql('SET ROLE postgres; DELETE FROM private.client_contract_config;')
  await scenario('missing configuration fails authenticated traffic safely', async () => {
    const r = await request('/orders?select=id', { headers: auth(1, '1') })
    assert.equal(r.status, 503); assert.equal(r.body.code, 'CLIENT_CONTRACT_CONFIGURATION_ERROR')
    assert(!JSON.stringify(r.body).match(/check_client|schema|claim|SQL|private/i))
  })
  sql("SET ROLE postgres; INSERT INTO private.client_contract_config(singleton,enforcement_state,minimum_contract) VALUES(true,'enabled',1);")

  console.log(`RESULT ${passed}/${passed} SEC-08E R2B real PostgreSQL/PostgREST scenarios passed`)
  console.log(`VERSIONS PostgreSQL=${sql('SHOW server_version')} PostgREST=${docker(['exec', restName, 'postgrest', '--version']).trim()}`)
} catch (error) {
  console.error(error.stderr?.toString() || error.message)
  if (restOwned) {
    try { console.error(docker(['logs', restName])) } catch { /* best-effort diagnostics */ }
  }
  process.exitCode = 1
} finally {
  if (restOwned) docker(['rm', '-f', restName])
  if (owned && sql(`SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()`) === ownership) {
    docker(['exec', source, 'dropdb', '-U', 'supabase_admin', database])
  }
}
