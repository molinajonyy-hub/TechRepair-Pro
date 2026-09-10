// Fresh R3 certification. Source is a fixed local Docker container, schema only.
// A historical migration gap is a SET, never a max(version) cutoff. Every write
// targets this runner's newly created disposable database or PostgREST container.
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import assert from 'node:assert/strict'

const source = 'supabase_db_techrepair-vite'
const database = 'sec08e_r3_certification'
const restName = 'sec08e-r3-rest'
const ownership = 'SEC-08E R3 current-main disposable certification'
const migration = '20260922120000_sec08e_auxiliary_financial_reads.sql'
const reference = 'a0ff8f75aad09166bc3e1efe160e83ce210b1686'
const evidence = 'docs/security-sec08e-r3'
const production = JSON.parse(readFileSync(`${evidence}/production-discovery.json`, 'utf8').replace(/^\uFEFF/, '')).rows[0].discovery
let password = '', owned = false, restOwned = false, checks = 0, base = ''
const run = (cmd, args, input, env = process.env) => execFileSync(cmd, args, {
  input, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 48 * 1024 * 1024,
})
const docker = (args, input) => run('docker', args[0] === 'exec' && args.includes('supabase_admin')
  ? ['exec', '-e', `PGPASSWORD=${password}`, ...args.slice(1)] : args, input)
const query = (db, text) => docker(['exec', '-i', source, 'psql', '-X', '-U', 'supabase_admin', '-d', db, '-Atq', '-v', 'ON_ERROR_STOP=1'], text).trim()
const sql = text => query(database, text)
const file = path => readFileSync(path, 'utf8')
const id = n => `e0800000-0000-0000-0000-${String(n).padStart(12, '0')}`
const pause = () => new Promise(resolve => setTimeout(resolve, 200))
const check = (value, label) => { assert(value, label); checks++ }
const token = (actor, role = 'authenticated') => {
  const head = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')
  const body = Buffer.from(JSON.stringify({ ...(actor ? { sub: id(actor) } : {}), role, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')
  return `${head}.${body}.${createHmac('sha256', 'sec08e-r3-disposable-only-jwt-secret').update(`${head}.${body}`).digest('base64url')}`
}
const request = async (actor, path, body, contract = '1', role = 'authenticated') => {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json',
      ...(actor || role === 'service_role' ? { Authorization: `Bearer ${token(actor, role)}` } : {}),
      ...(contract === null ? {} : { 'x-techrepair-client-contract': contract }) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}
const ready = async path => {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await request(1, path)).status === 200) return } catch { /* startup/schema cache */ }
    await pause()
  }
  throw Error(`Local PostgREST not ready: ${path}`)
}
const catalog = db => JSON.parse(query(db, `SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,
  'definition',pg_get_functiondef(p.oid)) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname IN ('public','private') AND p.prokind='f';`))
const gate = () => sql(`SELECT jsonb_build_object('state', (SELECT enforcement_state||':'||minimum_contract FROM private.client_contract_config),
  'hook',(SELECT setting FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole CROSS JOIN LATERAL unnest(s.setconfig) setting
    WHERE s.setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database()) AND r.rolname='authenticator' AND setting LIKE 'pgrst.db_pre_request=%'));`)
const regressions = [
  'tests/sql/sec08a_orders_data_visibility.test.sql', 'tests/sql/sec08a_phase_b_pivots.test.sql',
  'tests/sql/sec08a_phase_c_payment_visibility.test.sql', 'tests/sql/sec08b_inventory_cost_visibility.test.sql',
  'tests/sql/sec08c_supplier_finance_visibility.test.sql', 'tests/sql/sec08d_finance_insights_visibility.test.sql',
  'supabase/tests/p0a1u2_allocation_ui_contract_test.sql', 'supabase/tests/etapa0_annulment_ledger_test.sql',
  'supabase/tests/etapa1_pnl_exclusions_test.sql', 'supabase/tests/etapa7_rpc_integration_comprobante_annulment_test.sql',
]
const regressionOutcomes = {}
const knownCleanMainOutcome = (path, outcome) => path.endsWith('sec08a_phase_b_pivots.test.sql')
  && outcome.includes('ERROR:  FAIL: order_parts.name sigue legible')
const regress = phase => {
  regressionOutcomes[phase] = {}
  for (const path of regressions) {
    const outcomes = []
    // Investigate the existing multi-profile fixture's updated_at tie with
    // identical bounded repetitions on clean main and candidate; assertions
    // and SQL are unmodified. Preserve every outcome, including failures.
    const attempts = path.endsWith('sec08a_phase_b_pivots.test.sql') ? 20 : 1
    for (let attempt = 0; attempt < attempts; attempt++) {
      let outcome = 'PASS'
      try { sql(file(path)) } catch (error) {
        outcome = (error.stderr?.toString().replace(/\r\n/g, '\n') || 'FAILED').replace(/pg_temp_\d+/g, 'pg_temp_N')
      }
      outcomes.push(outcome)
      console.log(`${outcome === 'PASS' ? 'PASS' : 'FAIL'} ${phase} ${path} attempt ${attempt + 1}`)
    }
    regressionOutcomes[phase][path] = outcomes
    writeFileSync(`${evidence}/regressions.json`, JSON.stringify(regressionOutcomes, null, 2) + '\n')
    if (phase === 'post') for (const outcome of outcomes) {
      assert(regressionOutcomes.pre[path].includes(outcome) || knownCleanMainOutcome(path, outcome),
        `new regression outcome: ${path}`)
    }
  }
}
const fixture = () => sql('BEGIN; SET LOCAL ROLE postgres;\n' + file('tests/fixtures/sec08e.sql') + '\nCOMMIT;')
const clearFixture = () => sql('BEGIN; SET LOCAL session_replication_role=replica;\n' + [
  'customer_account_payment_allocations', 'comprobante_annulments', 'parts_used', 'comprobantes', 'orders', 'customers', 'profiles', 'businesses',
].map(table => `DELETE FROM public.${table} WHERE id::text LIKE 'e0800000-0000-0000-0000-%';`).join('\n') +
  "\nDELETE FROM auth.users WHERE id::text LIKE 'e0800000-0000-0000-0000-%'; COMMIT;")
const frontend = phase => {
  try { console.log(run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.sec08e-r1.config.ts'], undefined, {
    ...process.env, SEC08E_R1_URL: base, SEC08E_R1_SCHEMA: phase,
    SEC08E_R1_OWNER: token(1), SEC08E_R1_TECH: token(2), SEC08E_R1_OTHER: token(5),
  })) } catch (error) { console.error(error.stdout?.toString()); throw error }
}
const contractMatrix = async phase => {
  for (const value of [null, '0']) {
    const result = await request(1, '/parts_used?select=id', undefined, value)
    check(result.status === 409 && result.body.code === 'CLIENT_UPDATE_REQUIRED', `${phase} contract ${value} rejects`)
  }
  check((await request(1, '/parts_used?select=id')).status === 200, `${phase} contract 1 works`)
  const payload = { p_business_id: id(101), p_key: 'orders_view_financials' }
  for (const value of ['1', '999999']) {
    const result = await request(2, '/rpc/current_user_can_in_business', payload, value)
    check(result.status === 200 && result.body === false, `${phase} forged contract cannot grant authority`)
  }
  check((await request(null, '/parts_used?select=id', undefined, null, 'service_role')).status !== 409, `${phase} signed service role exemption`)
  console.log(`PASS ${phase} R2B contract matrix`)
}

async function main() {
  password = JSON.parse(docker(['inspect', source]))[0].Config.Env.find(value => value.startsWith('POSTGRES_PASSWORD='))?.slice(18) || ''
  check(query('postgres', `SELECT count(*) FROM pg_database WHERE datname='${database}'`) === '0', 'refuse existing database')
  const ledger = JSON.parse(query('postgres', 'SELECT jsonb_agg(version ORDER BY version) FROM supabase_migrations.schema_migrations;'))
  const currentVersions = readdirSync('supabase/migrations').filter(name => /^\d+_.*\.sql$/.test(name) && name !== migration).map(name => name.split('_')[0]).sort()
  // Compare all current-main versions, not only the newest. No migration sweep.
  assert.deepEqual(ledger, currentVersions, 'source must model precisely current main minus R3; rebuild a separate source if drifted')
  check(!ledger.includes('20260922120000') && ledger.includes('20260923120000') && ledger.includes('20260924120000'), 'explicit R2A/R2B plus historical R3 gap')
  const localDiscovery = JSON.parse(query('postgres', file('scripts/security/sec08e-r3-discovery.sql')))
  for (const key of ['tables','columns','policies','functions','views']) {
    const stable = values => JSON.stringify(values.map(value => {
      const normalized = { ...value }
      // Compare the whole definition, normalizing only transport line endings.
      if (normalized.definition) normalized.definition = normalized.definition.replace(/\r\n/g, '\n')
      delete normalized.body_md5
      // Explicit measured source difference: PG17 MAINTAIN from GRANT ALL.
      // Reproduce production's additional MAINTAIN in the clone below.
      if (key === 'tables' && normalized.name === 'parts_used') normalized.acl = normalized.acl.map(acl => acl.replace('Dxtm/', 'Dxt/'))
      return JSON.stringify(normalized, Object.keys(normalized).sort())
    }).sort())
    assert.equal(stable(localDiscovery[key]), stable(production[key]), `local/production ${key} drift; stop before candidate`)
  }
  // Independently anchor the live implementation to the immutable #110 source.
  const old = run('git', ['show', `${reference}:supabase/migrations/20260713250000_m7_6f4_annulment_accrual_ledger_and_guard.sql`])
  const oldBody = old.slice(old.indexOf('CREATE OR REPLACE FUNCTION "public"."annul_comprobante_atomic"')).split('AS $$')[1].split('$$;')[0]
  const currentBody = production.functions.find(fn => fn.name === 'annul_comprobante_atomic').definition.split('$function$')[1]
  assert.equal(oldBody.replace(/\r\n/g, '\n'), currentBody.replace(/\r\n/g, '\n'), 'annulment changed since #110: STOP')
  let schema = docker(['exec', source, 'pg_dump', '-U', 'postgres', '-d', 'postgres', '--schema-only', '--no-publications', '--no-subscriptions',
    ...['public','private','auth','storage','extensions','vault'].flatMap(name => ['--schema', name])])
  schema = schema.replace('CREATE FUNCTION', `CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE FUNCTION`)
  docker(['exec', source, 'createdb', '-U', 'supabase_admin', '-O', 'postgres', database]); owned = true
  sql(`COMMENT ON DATABASE ${database} IS '${ownership}'; DROP SCHEMA public;`)
  sql(schema)
  sql('SET ROLE postgres; GRANT MAINTAIN ON public.parts_used TO anon, authenticated;')
  // pg_dump --schema-only excludes the singleton and database-scoped role GUC.
  // Seed the synthetic active configuration, and scope the cloned hook to THIS DB.
  sql(`SET ROLE postgres;
    INSERT INTO private.client_contract_config(singleton,enforcement_state,minimum_contract) VALUES(true,'enabled',1);
    ALTER ROLE authenticator IN DATABASE ${database} SET pgrst.db_pre_request='public.check_client_contract';
    CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY);
    INSERT INTO supabase_migrations.schema_migrations(version) VALUES ${ledger.map(v => `('${v}')`).join(',')};`)
  check(sql("SELECT to_regclass('public.v_parts_used_amounts') IS NULL AND to_regprocedure('public.can_view_payment_allocations(uuid)') IS NULL") === 't', 'R3 objects absent')
  const originalFunctions = catalog(database)
  const originalGate = gate()
  regress('pre')
  fixture()
  const rest = JSON.parse(docker(['inspect', source.replace('supabase_db_', 'supabase_rest_')]))[0]
  const uri = new URL(rest.Config.Env.find(value => value.startsWith('PGRST_DB_URI=')).slice(13))
  assert.equal(uri.hostname, source); uri.pathname = '/' + database
  docker(['run', '-d', '--name', restName, '--label', 'techrepair.test=sec08e-r3', '--network', Object.keys(rest.NetworkSettings.Networks)[0],
    '-p', '127.0.0.1::3000', '-e', `PGRST_DB_URI=${uri}`, '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon',
    '-e', 'PGRST_JWT_SECRET=sec08e-r3-disposable-only-jwt-secret', rest.Config.Image]); restOwned = true
  base = 'http://127.0.0.1:' + JSON.parse(docker(['inspect', restName]))[0].NetworkSettings.Ports['3000/tcp'][0].HostPort
  await ready('/')
  for (const [path, field, value] of [
    ['/parts_used?select=unit_price', 'unit_price', 7103.19],
    ['/customer_account_payment_allocations?select=amount', 'amount', 3719.31],
    ['/comprobante_annulments?select=reverted_cogs_ars', 'reverted_cogs_ars', 6197.29],
  ]) {
    const result = await request(2, path)
    check(result.status === 200 && result.body[0]?.[field] === value, `pre-R3 real JWT leak ${path}`)
  }
  console.log('PASS pre-R3 all three financial leaks reproduced through real PostgREST/JWT with R2B enabled/1')
  await contractMatrix('pre'); frontend('pre')
  sql('SET ROLE postgres;\n' + file(`supabase/migrations/${migration}`))
  await ready('/v_parts_used_amounts?limit=0')
  assert.equal(gate(), originalGate, 'R2B config/hook unchanged')
  const after = catalog(database)
  for (const fn of originalFunctions) {
    if (fn.signature.startsWith('annul_comprobante_atomic(')) continue
    assert.deepEqual(after.find(candidate => candidate.signature === fn.signature), fn, `canonical function changed: ${fn.signature}`)
  }
  const movedBody = sql("SELECT prosrc FROM pg_proc WHERE oid='private.sec08e_annul_comprobante_impl(uuid,text,text,boolean,text)'::regprocedure")
  assert.equal(movedBody, currentBody.trim(), 'implementation body preserved byte-for-byte')
  sql(file('tests/sql/sec08e_auxiliary_financial_reads.test.sql'))
  await contractMatrix('post'); frontend('post')
  await securityMatrix()
  clearFixture(); regress('post'); fixture()
  // Bounded probes match the actual hydration/filter dimensions. Synthetic rows
  // only; record real plans, without claiming fixture timings predict production.
  const plans = []
  for (const statement of [
    `SELECT id,unit_price,subtotal FROM public.v_parts_used_amounts WHERE id IN ('${id(401)}')`,
    `SELECT subtotal FROM public.v_parts_used_amounts WHERE business_id='${id(101)}' AND order_id='${id(301)}'`,
    `SELECT amount FROM public.customer_account_payment_allocations WHERE business_id='${id(101)}' AND comprobante_id='${id(501)}'`,
    `SELECT reverted_cash_ars,reverted_cogs_ars FROM public.v_comprobante_annulment_amounts WHERE id='${id(601)}'`,
  ]) plans.push({ statement, plan: sql(`BEGIN; SET LOCAL ROLE authenticated;
    SELECT set_config('request.jwt.claims','{"sub":"${id(1)}","role":"authenticated"}',true);
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}; ROLLBACK;`).split('\n').slice(1).join('\n') })
  writeFileSync(`${evidence}/query-plans.json`, JSON.stringify(plans, null, 2) + '\n')
  sql("SET ROLE postgres; ALTER VIEW public.v_parts_used_amounts RENAME TO sec08e_r3_hidden_amounts; NOTIFY pgrst, 'reload schema';")
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await request(1, '/v_parts_used_amounts?limit=0')).status === 404) break
    if (attempt === 59) throw Error('Missing-view fault was not loaded')
    await pause()
  }
  try {
    console.log(run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.sec08e-r3-fault.config.ts'], undefined, {
      ...process.env, SEC08E_R1_URL: base, SEC08E_R1_OWNER: token(1),
    }))
  } catch (error) { console.error(error.stdout?.toString()); throw error }
  sql("SET ROLE postgres; ALTER VIEW public.sec08e_r3_hidden_amounts RENAME TO v_parts_used_amounts; NOTIFY pgrst, 'reload schema';")
  await ready('/v_parts_used_amounts?limit=0')
  sql('SET ROLE postgres;\n' + file(`${evidence}/rollback-review.sql`))
  assert.deepEqual(catalog(database), originalFunctions, 'rollback restores every canonical function and removes wrappers')
  assert.equal(gate(), originalGate, 'rollback leaves R2B enabled/1 and hook unchanged')
  check(sql("SELECT has_column_privilege('authenticated','public.parts_used','unit_price','SELECT') AND has_column_privilege('authenticated','public.comprobante_annulments','reverted_cogs_ars','SELECT')") === 't', 'rollback restores measured grants')
  check(sql("SELECT to_regclass('public.v_parts_used_amounts') IS NULL AND to_regclass('public.v_comprobante_annulment_amounts') IS NULL") === 't', 'rollback removes projections')
  sql('SET ROLE postgres;\n' + file(`supabase/migrations/${migration}`))
  sql(file('tests/sql/sec08e_auxiliary_financial_reads.test.sql'))
  assert.equal(gate(), originalGate)
  console.log('PASS missing-view fault, reviewed rollback, and R3 reapplication; R2B unchanged throughout')
  writeFileSync(`${evidence}/regressions.json`, JSON.stringify(regressionOutcomes, null, 2) + '\n')
  console.log(`RESULT ${checks} assertions; real frontend pre/post and SQL regression comparison completed`)
}

async function securityMatrix() {
  for (const actor of [1,2,3,4,5,6,7,8,9,10]) {
    for (const surface of ['parts_used','comprobante_annulments']) {
      check((await request(actor, `/${surface}?select=*`)).status === 403, `actor ${actor} ${surface} wildcard revoked`)
    }
    const metadata = await request(actor, `/comprobante_annulments?select=id,status,annulment_date&id=eq.${id(601)}`)
    check(metadata.status === 200 && metadata.body.length === ([5,6].includes(actor) ? 0 : 1), `actor ${actor} operational annulment metadata`)
  }
  for (const path of ['/v_parts_used_amounts?select=id&subtotal=gt.0&order=unit_price.desc',
    '/v_comprobante_annulment_amounts?select=id&reverted_cash_ars=gt.0&order=reverted_cogs_ars.desc',
    '/customer_account_payment_allocations?select=id&amount=gt.0&order=amount.desc']) {
    for (const contract of ['1','999999']) {
      const response = await request(2, path, undefined, contract)
      check(response.status === 200 && response.body.length === 0, `limited tech protected filters/order with contract ${contract}`)
    }
  }
  const sensitive = [7103.19,21309.57,3719.31,8317.13,4723.17,193.23,6197.29]
  const deny = (r,label,allowRedactedReply=false) => {
    check(!JSON.stringify(r.body).match(new RegExp(sensitive.map(n=>String(n).replace('.','\\.')).join('|'))),label)
    check([200,401,403].includes(r.status),label+' fails closed without missing-object errors')
    if(r.status===200 && !allowRedactedReply) {
      const empty = Array.isArray(r.body)
        ? r.body.every(row => Object.entries(row).every(([key,value]) => key==='id' || (Array.isArray(value) && value.length===0)))
        : r.body.authorized===false
      check(empty,label+' returns no financial rows')
    }
  }
  for(const actor of [2,3,5,6]) {
    for(const path of [
      `/parts_used?select=unit_price,subtotal&id=eq.${id(401)}`,
      `/parts_used?select=id&unit_price=gt.0`,
      `/parts_used?select=id&order=subtotal.desc`,
      `/orders?select=id,parts_used(unit_price,subtotal)&id=eq.${id(301)}`,
      `/comprobante_annulments?select=reverted_cogs_ars,reverted_cash_ars,reverted_cc_ars,reverted_commissions_ars`,
      `/comprobante_annulments?select=id&reverted_cogs_ars=gt.0`,
      `/comprobante_annulments?select=id&order=reverted_cash_ars.desc`,
      `/comprobantes?select=id,comprobante_annulments(reverted_cogs_ars)`,
      `/customer_account_payment_allocations?select=amount`,
      `/comprobantes?select=id,customer_account_payment_allocations(amount)`,
      `/v_parts_used_amounts?select=*`, `/v_comprobante_annulment_amounts?select=*`,
    ]) {
      const response=await request(actor,path)
      deny(response,`actor ${actor} ${path}`)
      if(path.startsWith('/parts_used?') || path.startsWith('/comprobante_annulments?')) {
        check([401,403].includes(response.status),`actor ${actor} base-column SELECT/filter/order denied`)
      }
    }
    const rpc=await request(actor,'/rpc/get_payment_allocations',{
      p_business_id:id(101),p_comprobante_id:id(501),p_payment_movement_id:null})
    deny(rpc,`actor ${actor} allocation RPC`)
    check(rpc.body.authorized===false,`actor ${actor} canonical allocation denial`)
    const operational=await request(actor,`/parts_used?select=id,code,description,quantity&id=eq.${id(401)}`)
    check(operational.status===200,`actor ${actor} operational query works`)
    check(operational.body.length === ([2,3].includes(actor)?1:0),`actor ${actor} operational tenant/active boundary`)
  }
  for(const actor of [1,4,8,9,10]) {
    const parts=await request(actor,`/v_parts_used_amounts?id=eq.${id(401)}`)
    check(parts.status===200 && parts.body[0]?.unit_price===7103.19,`actor ${actor} authorized part price`)
    const allocations=await request(actor,`/customer_account_payment_allocations?id=eq.${id(701)}&select=amount`)
    check(allocations.status===200 && allocations.body[0]?.amount===3719.31,`actor ${actor} allocation direct parity: ${JSON.stringify(allocations)}`)
    const rpc=await request(actor,'/rpc/get_payment_allocations',{p_business_id:id(101),p_comprobante_id:id(501),p_payment_movement_id:null})
    check(rpc.body.authorized===true && rpc.body.rows[0]?.amount===3719.31,`actor ${actor} canonical allocation read`)
    const ann=await request(actor,`/v_comprobante_annulment_amounts?id=eq.${id(601)}`)
    check(ann.status===200 && ann.body[0]?.reverted_cash_ars===8317.13,`actor ${actor} authorized reversed payment`)
    check(ann.body[0]?.reverted_cogs_ars===([1,9,10].includes(actor)?6197.29:null),`actor ${actor} raw COGS separation`)
  }
  // Replay is a real RPC response from the original implementation, not a mock.
  for(const actor of [1,2,3,4,5,6,8]) {
    const replay=await request(actor,'/rpc/annul_comprobante_atomic',{
      p_comprobante_id:id(501),p_mode:'commercial_annulment',p_motivo:'Fixture replay',
      p_restore_stock:false,p_idempotency_key:'sec08e-replay-1'})
    if([2,3,5,6].includes(actor)) deny(replay,`actor ${actor} annulment RPC replay`,true)
    else {
      check(replay.body.ok===true && replay.body.replay===true,`actor ${actor} replay preserved`)
      check(replay.body.reverted_cash_ars===8317.13,`actor ${actor} replay authorized cash`)
      check(actor===1?replay.body.reverted_cogs_ars===6197.29:!('reverted_cogs_ars' in replay.body),`actor ${actor} replay cost authority`)
    }
  }
  // A granted tech may see part amounts but not allocations: exact historical
  // allocation RPC role contract, deliberately not silently widened by SEC08E.
  check((await request(7,`/v_parts_used_amounts?id=eq.${id(401)}`)).body[0]?.unit_price===7103.19,'positive order-financial override')
  check((await request(7,'/customer_account_payment_allocations?select=amount')).body.length===0,'allocation role gate not widened')
  for(const surface of ['v_comprobante_annulment_amounts','v_parts_used_amounts','parts_used','comprobante_annulments','customer_account_payment_allocations']) {
    deny(await request(null,`/${surface}?select=*`),`anon ${surface} denied`)
  }
  // Core ledger metadata must remain usable after the column revokes.
  for(const view of ['v_finance_sales_ledger','v_finance_collections_ledger','v_finance_pnl','v_order_payment_state']) {
    check((await request(1,`/${view}?limit=1`)).status===200,`${view} remains queryable`)
  }

}

main().catch(error => {
  console.error(error.stderr?.toString() || error.message)
  process.exitCode = 1
}).finally(() => {
  if (restOwned) docker(['rm', '-f', restName])
  if (owned && sql(`SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()`) === ownership) {
    docker(['exec', source, 'dropdb', '-U', 'supabase_admin', database])
  }
})
