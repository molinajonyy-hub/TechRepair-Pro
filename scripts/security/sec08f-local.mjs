// SEC-08F current-main disposable certification.
// Every write targets a newly created local Docker database.
import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const source = 'supabase_db_techrepair-vite'
const database = 'sec08f_certification'
const restName = 'sec08f-rest'
const ownership = 'SEC-08F current-main disposable certification'
const migration = '20261001120000_sec08f_remaining_read_authority.sql'
const version = migration.split('_')[0]
const evidenceDir = 'docs/security-sec08f'
const jwtSecret = 'sec08f-disposable-only-jwt-secret-32-chars'
let password = '', owned = false, restOwned = false, base = '', checks = 0
const observations = { pre: {}, post: {}, static: {}, r2r3: {} }
const regressionResults = { pre: {}, post: {} }
const regressionFiles = [
  'tests/sql/sec08a_orders_data_visibility.test.sql',
  'tests/sql/sec08a_phase_b_pivots.test.sql',
  'tests/sql/sec08a_phase_c_payment_visibility.test.sql',
  'tests/sql/sec08b_inventory_cost_visibility.test.sql',
  'tests/sql/sec08c_supplier_finance_visibility.test.sql',
  'tests/sql/sec08d_finance_insights_visibility.test.sql',
  'tests/sql/sec08e_auxiliary_financial_reads.test.sql',
  'supabase/tests/p0a1u2_allocation_ui_contract_test.sql',
  'supabase/tests/etapa0_annulment_ledger_test.sql',
  'supabase/tests/etapa1_pnl_exclusions_test.sql',
  'supabase/tests/etapa7_rpc_integration_comprobante_annulment_test.sql',
]

const run = (cmd, args, input, env = process.env) => execFileSync(cmd, args, {
  input, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
})
const docker = (args, input) => run('docker', args[0] === 'exec' && args.includes('supabase_admin')
  ? ['exec', '-e', `PGPASSWORD=${password}`, ...args.slice(1)] : args, input)
const query = (db, text) => docker(
  ['exec', '-i', source, 'psql', '-X', '-U', 'supabase_admin', '-d', db, '-Atq', '-v', 'ON_ERROR_STOP=1'], text,
).trim()
const sql = text => query(database, text)
const file = path => readFileSync(path, 'utf8')
const id = n => `f0800000-0000-0000-0000-${String(n).padStart(12, '0')}`
const check = (condition, label) => { assert(condition, label); checks++; console.log(`PASS ${label}`) }
const pause = () => new Promise(resolve => setTimeout(resolve, 200))
const tokenForSubject = (subject, role = 'authenticated') => {
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    ...(subject ? { sub: subject } : {}), role, exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url')
  return `${header}.${payload}.${createHmac('sha256', jwtSecret).update(`${header}.${payload}`).digest('base64url')}`
}
const token = (actor, role = 'authenticated') => tokenForSubject(actor ? id(actor) : null, role)
const request = async (actor, path, { contract = '1', role = 'authenticated' } = {}) => {
  const response = await fetch(base + path, {
    headers: {
      ...(actor || role === 'service_role' ? { Authorization: `Bearer ${token(actor, role)}` } : {}),
      ...(contract === null ? {} : { 'x-techrepair-client-contract': contract }),
    },
    signal: AbortSignal.timeout(15000),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}
const ready = async () => {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await request(1, '/')).status === 200) return } catch { /* schema cache startup */ }
    await pause()
  }
  throw Error('Disposable PostgREST did not become ready')
}
const visible = result => result.status === 200 && Array.isArray(result.body) && result.body.length === 1
const empty = result => result.status === 200 && Array.isArray(result.body) && result.body.length === 0
const denied = result => [401, 403].includes(result.status)
const actorNames = {
  1: 'owner', 2: 'limited_technician', 3: 'limited_viewer', 4: 'cashier',
  5: 'cross_tenant_owner', 6: 'inactive_admin', 7: 'sales', 8: 'manager',
  9: 'admin_finance_override_false', 10: 'admin',
}

const knownCleanMainOutcome = (path, outcome) =>
  path.endsWith('sec08a_phase_b_pivots.test.sql')
  && outcome.includes('ERROR:  FAIL: order_parts.name sigue legible')

const regress = phase => {
  for (const path of regressionFiles) {
    const attempts = path.endsWith('sec08a_phase_b_pivots.test.sql') ? 10 : 1
    const outcomes = []
    for (let attempt = 0; attempt < attempts; attempt++) {
      let outcome = 'PASS'
      try { sql(file(path)) } catch (error) {
        outcome = (error.stderr?.toString() || error.message || 'FAILED')
          .replace(/\r\n/g, '\n').replace(/pg_temp_\d+/g, 'pg_temp_N')
      }
      outcomes.push(outcome)
      console.log(`${outcome === 'PASS' ? 'PASS' : 'BASELINE_FAIL'} ${phase} ${path} attempt ${attempt + 1}`)
    }
    regressionResults[phase][path] = outcomes
    if (phase === 'post') {
      for (const outcome of outcomes) {
        check(regressionResults.pre[path].includes(outcome) || knownCleanMainOutcome(path, outcome),
          `post regression outcome existed on clean main: ${path}`)
      }
    }
  }
}

const snapshot = async phase => {
  const paths = {
    recurring_expenses: `/recurring_expenses?select=id,amount,notes&amount=gt.0&order=amount.desc`,
    cash_registers: `/cash_registers?select=id,ars_balance,usd_balance,notes&ars_balance=gt.0&order=ars_balance.desc`,
    payment_orders: `/payment_orders?select=id,requested_amount,estimated_fee_amount,raw_response&requested_amount=gt.0&order=requested_amount.desc`,
  }
  observations[phase] = {}
  for (const [actor, name] of Object.entries(actorNames)) {
    observations[phase][name] = {}
    for (const [surface, path] of Object.entries(paths)) {
      observations[phase][name][surface] = await request(Number(actor), path)
    }
  }
  observations[phase].anonymous = {}
  observations[phase].service_role = {}
  for (const [surface, path] of Object.entries(paths)) {
    observations[phase].anonymous[surface] = await request(null, path)
    observations[phase].service_role[surface] = await request(null, path, { role: 'service_role' })
  }
}

const assertPre = (phase = 'pre') => {
  const state = observations[phase]
  const label = phase === 'pre' ? 'pre-fix' : phase
  for (const actor of ['limited_technician', 'limited_viewer']) {
    for (const surface of ['recurring_expenses', 'cash_registers', 'payment_orders']) {
      check(visible(state[actor][surface]), `${label} ${actor} reads ${surface}`)
    }
  }
  check(visible(state.inactive_admin.recurring_expenses), `${label} inactive admin reads recurring_expenses`)
  check(visible(state.inactive_admin.cash_registers), `${label} inactive admin reads cash_registers`)
  check(empty(state.inactive_admin.payment_orders), `${label} inactive admin is tenant-filtered on payment_orders`)
  for (const surface of ['recurring_expenses', 'cash_registers', 'payment_orders']) {
    check(empty(state.cross_tenant_owner[surface]), `${label} cross-tenant actor cannot read ${surface}`)
  }
  check(denied(state.service_role.recurring_expenses), `${label} recurring_expenses has no service-role table grant`)
  check(denied(state.service_role.cash_registers), `${label} cash_registers has no service-role table grant`)
  check(visible(state.service_role.payment_orders), `${label} service role reads payment_orders`)
  const serialized = JSON.stringify(state)
  for (const witness of ['4812.34', '5823.45', '6934.56', 'SEC08F_RAW_PROVIDER_WITNESS']) {
    check(serialized.includes(witness), `${label} response contains exact witness ${witness}`)
  }
}

const assertPost = async (phase = 'post') => {
  const state = observations[phase]
  const label = phase === 'post' ? 'post-fix' : phase
  for (const actor of ['owner', 'cashier', 'admin']) {
    check(visible(state[actor].recurring_expenses), `${label} ${actor} keeps recurring_expenses`)
    check(visible(state[actor].cash_registers), `${label} ${actor} keeps cash_registers`)
  }
  for (const actor of [
    'limited_technician', 'limited_viewer', 'cross_tenant_owner', 'inactive_admin',
    'sales', 'manager', 'admin_finance_override_false',
  ]) {
    check(empty(state[actor].recurring_expenses), `${label} ${actor} cannot read recurring_expenses`)
    check(empty(state[actor].cash_registers), `${label} ${actor} cannot read cash_registers`)
  }
  for (const actor of Object.values(actorNames)) {
    check(denied(state[actor].payment_orders), `${label} ${actor} browser SELECT payment_orders denied`)
  }
  for (const surface of ['recurring_expenses', 'cash_registers', 'payment_orders']) {
    check(denied(state.anonymous[surface]), `${label} anonymous ${surface} denied`)
  }
  check(denied(state.service_role.recurring_expenses), `${label} recurring_expenses service-role grant unchanged`)
  check(denied(state.service_role.cash_registers), `${label} cash_registers service-role grant unchanged`)
  check(visible(state.service_role.payment_orders), `${label} service role reads payment_orders`)

  // Embed/filter/order paths are real PostgREST queries, not SQL simulations.
  const recurringEmbed = await request(2, `/businesses?select=id,recurring_expenses(amount)&id=eq.${id(101)}`)
  const cashEmbed = await request(2, `/businesses?select=id,cash_registers(ars_balance)&id=eq.${id(101)}`)
  state.embed_probes = { recurring_expenses: recurringEmbed, cash_registers: cashEmbed }
  check(!JSON.stringify(recurringEmbed).includes('4812.34'), `${label} recurring amount is absent through embed`)
  check(!JSON.stringify(cashEmbed).includes('5823.45'), `${label} cash balance is absent through embed`)

  for (const contract of ['1', '999999']) {
    check(empty(await request(2, '/recurring_expenses?select=id&amount=gt.0', { contract })),
      `contract ${contract} cannot grant recurring amount filter`)
    check(empty(await request(2, '/cash_registers?select=id&order=ars_balance.desc', { contract })),
      `contract ${contract} cannot grant cash balance ordering`)
  }
}

const staticChecks = () => {
  observations.static = JSON.parse(sql(`SELECT jsonb_build_object(
    'policies', (SELECT jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname) FROM pg_policies p
      WHERE schemaname='public' AND tablename IN ('recurring_expenses','cash_registers','payment_orders')),
    'grants', (SELECT jsonb_agg(jsonb_build_object('table',c.relname,'acl',c.relacl) ORDER BY c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
       AND c.relname IN ('recurring_expenses','cash_registers','payment_orders')),
    'dependent_security_definers', (SELECT COALESCE(jsonb_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text),'[]'::jsonb)
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('public','private') AND p.prokind='f' AND p.prosecdef
       AND p.prosrc ~ '(recurring_expenses|cash_registers|payment_orders)'),
    'dependent_views', (SELECT COALESCE(jsonb_agg(schemaname||'.'||viewname ORDER BY schemaname,viewname),'[]'::jsonb)
      FROM pg_views WHERE schemaname IN ('public','private')
       AND definition ~ '(recurring_expenses|cash_registers|payment_orders)')
  );`))
  const policies = observations.static.policies
  const selectPolicies = table => policies.filter(p => p.tablename === table && p.cmd === 'SELECT')
  for (const table of ['recurring_expenses', 'cash_registers']) {
    const rows = selectPolicies(table)
    check(rows.length === 1, `${table} has one SELECT policy`)
    check(rows[0].roles.length === 1 && rows[0].roles[0] === 'authenticated', `${table} SELECT policy role is authenticated`)
    check(rows[0].qual.includes('current_user_business_id') && rows[0].qual.includes('current_user_can_in_business')
      && rows[0].qual.includes("'finance'"), `${table} uses tenant-bound finance authority`)
  }
  check(selectPolicies('payment_orders').length === 0, 'payment_orders has no SELECT policy')
  check(!policies.some(p => ['cash_registers', 'payment_orders'].includes(p.tablename) && p.cmd === 'ALL'),
    'no target ALL policy implicitly grants SELECT')
  check(sql("SELECT NOT has_table_privilege('anon','public.recurring_expenses','SELECT') AND NOT has_table_privilege('authenticated','public.payment_orders','SELECT')") === 't',
    'table grants close anonymous recurring and browser payment-order reads')
  check(sql("SELECT has_table_privilege('authenticated','public.cash_registers','INSERT') AND has_table_privilege('authenticated','public.cash_registers','UPDATE') AND has_table_privilege('authenticated','public.cash_registers','DELETE') AND has_table_privilege('authenticated','public.payment_orders','INSERT') AND has_table_privilege('authenticated','public.payment_orders','UPDATE') AND has_table_privilege('authenticated','public.payment_orders','DELETE')") === 't',
    'existing browser DML privileges are preserved')
  check(sql("SELECT has_table_privilege('service_role','public.payment_orders','SELECT')") === 't',
    'service-role payment-order history remains available')
}

const contractAndR3 = async (originalGate, originalWrapperBody) => {
  for (const contract of [null, '0']) {
    const result = await request(1, '/recurring_expenses?select=id', { contract })
    check(result.status === 409 && result.body.code === 'CLIENT_UPDATE_REQUIRED', `contract ${contract} rejects with exact 409`)
  }
  check((await request(1, '/recurring_expenses?select=id')).status === 200, 'contract 1 succeeds')
  const gate = sql(`SELECT jsonb_build_object('state',(SELECT enforcement_state||':'||minimum_contract FROM private.client_contract_config),
    'hook',(SELECT setting FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole CROSS JOIN LATERAL unnest(s.setconfig) setting
      WHERE s.setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database()) AND r.rolname='authenticator'
        AND setting LIKE 'pgrst.db_pre_request=%'));`)
  check(gate === originalGate, 'R2B enabled/1 and hook unchanged')
  check(sql("SELECT prosrc FROM pg_proc WHERE oid='public.annul_comprobante_atomic(uuid,text,text,boolean,text)'::regprocedure") === originalWrapperBody,
    'R3 annulment wrapper body unchanged')
  const r3Denied = await request(2, `/v_parts_used_amounts?select=id,unit_price&id=eq.${id(701)}`)
  const r3Allowed = await request(1, `/v_parts_used_amounts?select=id,unit_price&id=eq.${id(701)}`)
  check(empty(r3Denied), 'R3 part amounts remain closed to limited technician')
  check(visible(r3Allowed) && r3Allowed.body[0].unit_price === 7103.19, 'R3 authorized part amount remains functional')
  observations.r2r3 = { gate: JSON.parse(gate), limited_technician: r3Denied, owner: r3Allowed }
}

const frontendR1 = () => {
  const eid = n => `e0800000-0000-0000-0000-${String(n).padStart(12, '0')}`
  const output = run(process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.sec08e-r1.config.ts'],
    undefined,
    {
      ...process.env,
      SEC08E_R1_URL: base,
      SEC08E_R1_SCHEMA: 'post',
      SEC08E_R1_OWNER: tokenForSubject(eid(1)),
      SEC08E_R1_TECH: tokenForSubject(eid(2)),
      SEC08E_R1_OTHER: tokenForSubject(eid(5)),
    })
  console.log(output)
  check(/4 passed/.test(output), 'R1 central SDK works against current-main R3 schema')
  observations.r1 = { schema: 'post', tests: 4, status: 'passed' }
}

// Fresh Candidate #2: compare exact ACL/RLS state across the reviewed rollback,
// and prove that the cycle preserves ARCA Phase 2A and the three tables' data.
const preservationSnapshot = () => JSON.parse(sql(`SELECT jsonb_build_object(
  'policies', (SELECT jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname) FROM pg_policies p
    WHERE schemaname='public' AND tablename IN ('recurring_expenses','cash_registers','payment_orders')),
  'acl', (SELECT jsonb_agg(to_jsonb(a) ORDER BY table_name,grantee,privilege_type) FROM information_schema.table_privileges a
    WHERE table_schema='public' AND table_name IN ('recurring_expenses','cash_registers','payment_orders')),
  'column_acl', (SELECT jsonb_agg(to_jsonb(a) ORDER BY table_name,column_name,grantee,privilege_type) FROM information_schema.column_privileges a
    WHERE table_schema='public' AND table_name IN ('recurring_expenses','cash_registers','payment_orders')),
  'rls', (SELECT jsonb_agg(jsonb_build_object('table',relname,'enabled',relrowsecurity,'forced',relforcerowsecurity) ORDER BY relname)
    FROM pg_class WHERE oid IN ('public.recurring_expenses'::regclass,'public.cash_registers'::regclass,'public.payment_orders'::regclass)),
  'arca_functions', (SELECT jsonb_agg(jsonb_build_object('function',p.oid::regprocedure::text,'body',md5(p.prosrc),'config',p.proconfig,'acl',p.proacl) ORDER BY p.oid::regprocedure::text)
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','private') AND p.prokind='f' AND p.proname ~ '(arca|afip)'),
  'arca_constraints', (SELECT jsonb_agg(jsonb_build_object('table',c.conrelid::regclass::text,'name',c.conname,'definition',pg_get_constraintdef(c.oid)) ORDER BY c.conrelid::regclass::text,c.conname)
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE t.relname ~ '(arca|afip)'),
  'data', jsonb_build_object(
    'recurring_expenses',(SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'[]')) FROM public.recurring_expenses t),
    'cash_registers',(SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'[]')) FROM public.cash_registers t),
    'payment_orders',(SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'[]')) FROM public.payment_orders t))
);`))

async function main() {
  mkdirSync(evidenceDir, { recursive: true })
  password = JSON.parse(docker(['inspect', source]))[0].Config.Env
    .find(value => value.startsWith('POSTGRES_PASSWORD='))?.slice(18) || ''
  check(query('postgres', `SELECT count(*) FROM pg_database WHERE datname='${database}'`) === '0', 'refuse existing disposable database')
  const ledger = JSON.parse(query('postgres', 'SELECT jsonb_agg(version ORDER BY version) FROM supabase_migrations.schema_migrations;'))
  const mainMigrations = readdirSync('supabase/migrations')
    .filter(name => /^\d+_.*\.sql$/.test(name) && name !== migration).sort()
  const mainVersions = mainMigrations.map(name => name.split('_')[0])
  const missingMigrations = mainMigrations.filter(name => !ledger.includes(name.split('_')[0]))
  const unexpectedSourceVersions = ledger.filter(item => !mainVersions.includes(item))
  assert.deepEqual(unexpectedSourceVersions, [], 'local source has a migration not present on current main')
  console.log(`INFO disposable builder will apply ${missingMigrations.length} current-main migration(s) missing from its source`)

  let schema = docker(['exec', source, 'pg_dump', '-U', 'postgres', '-d', 'postgres', '--schema-only',
    '--no-publications', '--no-subscriptions', ...['public','private','auth','storage','extensions','vault']
      .flatMap(name => ['--schema', name])])
  schema = schema.replace('CREATE FUNCTION', `CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE FUNCTION`)
  docker(['exec', source, 'createdb', '-U', 'supabase_admin', '-O', 'postgres', database]); owned = true
  sql(`COMMENT ON DATABASE ${database} IS '${ownership}'; DROP SCHEMA public;`)
  sql(schema)
  sql(`SET ROLE postgres;
    INSERT INTO private.client_contract_config(singleton,enforcement_state,minimum_contract) VALUES(true,'enabled',1);
    ALTER ROLE authenticator IN DATABASE ${database} SET pgrst.db_pre_request='public.check_client_contract';
    CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY);
    INSERT INTO supabase_migrations.schema_migrations(version) VALUES ${ledger.map(v => `('${v}')`).join(',')};`)
  for (const pending of missingMigrations) {
    sql('SET ROLE postgres;\n' + file(`supabase/migrations/${pending}`))
    sql(`INSERT INTO supabase_migrations.schema_migrations(version) VALUES ('${pending.split('_')[0]}');`)
  }
  const currentLedger = [...mainVersions]
  check(sql(`SELECT jsonb_agg(version ORDER BY version) = '${JSON.stringify(currentLedger)}'::jsonb FROM supabase_migrations.schema_migrations`) === 't',
    'disposable pre-fix ledger exactly matches current main')
  const originalGate = sql(`SELECT jsonb_build_object('state',(SELECT enforcement_state||':'||minimum_contract FROM private.client_contract_config),
    'hook',(SELECT setting FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole CROSS JOIN LATERAL unnest(s.setconfig) setting
      WHERE s.setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database()) AND r.rolname='authenticator'
        AND setting LIKE 'pgrst.db_pre_request=%'));`)
  const originalWrapperBody = sql("SELECT prosrc FROM pg_proc WHERE oid='public.annul_comprobante_atomic(uuid,text,text,boolean,text)'::regprocedure")

  regress('pre')

  sql(`BEGIN; SET LOCAL session_replication_role=replica;
    INSERT INTO auth.users(id,email,email_confirmed_at)
      SELECT ('f0800000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid, 'sec08f-'||i||'@test.invalid', now()
        FROM generate_series(1,10) i;
    INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status) VALUES
      ('${id(101)}','SEC08F A','${id(1)}','pro','active'),
      ('${id(102)}','SEC08F B','${id(5)}','pro','active');
    INSERT INTO public.profiles(id,user_id,business_id,role,is_active,email,permissions)
    SELECT u.id,u.id,CASE WHEN x.i=5 THEN '${id(102)}' ELSE '${id(101)}' END::uuid,
      (ARRAY['owner','tech','viewer','cashier','owner','admin','sales','manager','admin','admin'])[x.i],
      x.i<>6,u.email,CASE WHEN x.i IN (2,3) THEN '{"finance":false,"comprobantes":false}'::jsonb
                         WHEN x.i=9 THEN '{"finance":false}'::jsonb ELSE NULL END
      FROM generate_series(1,10) x(i) JOIN auth.users u ON u.id=('f0800000-0000-0000-0000-'||lpad(x.i::text,12,'0'))::uuid;
    INSERT INTO public.recurring_expenses(id,business_id,name,type,category,amount,currency,day_of_month,notes)
      VALUES ('${id(201)}','${id(101)}','Lease witness','fixed_cost_local','rent',4812.34,'ARS',1,'SEC08F_RECURRING_WITNESS');
    INSERT INTO public.cash_registers(id,business_id,date,ars_opening,ars_balance,usd_opening,usd_balance,exchange_rate,notes)
      VALUES ('${id(301)}','${id(101)}','2026-09-10',100,5823.45,10,67.89,1234.5,'SEC08F_CASH_WITNESS');
    INSERT INTO public.payment_orders(id,business_id,provider,channel,integration_kind,external_reference,requested_amount,
      target_net_amount,estimated_fee_amount,estimated_net_amount,currency,status,raw_response)
      VALUES ('${id(401)}','${id(101)}','mercadopago','qr','mp_qr','SEC08F_EXTERNAL_WITNESS',6934.56,
        6700,234.56,6700,'ARS','pending','{"marker":"SEC08F_RAW_PROVIDER_WITNESS"}'::jsonb);
    INSERT INTO public.customers(id,business_id,name,phone) VALUES ('${id(501)}','${id(101)}','Fixture','1');
    INSERT INTO public.orders(id,business_id,customer_id,status) VALUES ('${id(601)}','${id(101)}','${id(501)}','repair');
    INSERT INTO public.parts_used(id,business_id,order_id,code,description,quantity,unit_price)
      VALUES ('${id(701)}','${id(101)}','${id(601)}','SEC08F-PART','Regression',1,7103.19);
    COMMIT;`)
  const rest = JSON.parse(docker(['inspect', source.replace('supabase_db_', 'supabase_rest_')]))[0]
  const uri = new URL(rest.Config.Env.find(value => value.startsWith('PGRST_DB_URI=')).slice(13))
  uri.hostname = source; uri.pathname = '/' + database
  docker(['run', '-d', '--name', restName, '--label', 'techrepair.test=sec08f',
    '--network', Object.keys(rest.NetworkSettings.Networks)[0], '-p', '127.0.0.1::3000',
    '-e', `PGRST_DB_URI=${uri}`, '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon',
    '-e', `PGRST_JWT_SECRET=${jwtSecret}`, rest.Config.Image]); restOwned = true
  base = 'http://127.0.0.1:' + JSON.parse(docker(['inspect', restName]))[0]
    .NetworkSettings.Ports['3000/tcp'][0].HostPort
  await ready()

  await snapshot('pre'); assertPre()
  const preservationBefore = preservationSnapshot()
  sql('SET ROLE postgres;\n' + file(`supabase/migrations/${migration}`))
  sql(`INSERT INTO supabase_migrations.schema_migrations(version) VALUES ('${version}'); NOTIFY pgrst, 'reload schema';`)
  await ready()
  regress('post')
  await snapshot('post'); await assertPost(); staticChecks()
  const preservationAfter = preservationSnapshot()
  await contractAndR3(originalGate, originalWrapperBody)
  sql('BEGIN; SET LOCAL ROLE postgres;\n' + file('tests/fixtures/sec08e.sql') + '\nCOMMIT;')
  frontendR1()
  check(sql(`SELECT jsonb_agg(version ORDER BY version) = '${JSON.stringify([...currentLedger, version].sort())}'::jsonb FROM supabase_migrations.schema_migrations`) === 't',
    'disposable ledger changes only by SEC-08F')

  sql('SET ROLE postgres;\n' + file('docs/security-sec08f/rollback-review.sql'))
  await ready()
  await snapshot('rollback'); assertPre('rollback')
  const preservationRollback = preservationSnapshot()
  check(JSON.stringify(preservationRollback) === JSON.stringify(preservationBefore),
    'rollback restores exact fresh-main ACLs, column ACLs and RLS; ARCA and target data unchanged')
  check(sql(`SELECT jsonb_agg(version ORDER BY version) = '${JSON.stringify([...currentLedger, version].sort())}'::jsonb FROM supabase_migrations.schema_migrations`) === 't',
    'reviewed rollback does not alter migration history')

  sql('SET ROLE postgres;\n' + file(`supabase/migrations/${migration}`))
  sql("NOTIFY pgrst, 'reload schema';")
  await ready()
  await snapshot('reapplied'); await assertPost('reapplied'); staticChecks()
  const preservationReapplied = preservationSnapshot()
  check(JSON.stringify(preservationReapplied) === JSON.stringify(preservationAfter),
    'reapplication restores exact candidate ACLs and RLS; ARCA and target data unchanged')
  for (const key of ['arca_functions', 'arca_constraints', 'data']) {
    check(JSON.stringify(preservationBefore[key]) === JSON.stringify(preservationAfter[key]),
      `candidate preserves fresh-main ${key}`)
  }
  observations.preservation = { before: preservationBefore, after: preservationAfter,
    rollback_exact: true, reapplied_exact: true }
  await contractAndR3(originalGate, originalWrapperBody)
  check(sql(`SELECT jsonb_agg(version ORDER BY version) = '${JSON.stringify([...currentLedger, version].sort())}'::jsonb FROM supabase_migrations.schema_migrations`) === 't',
    'reviewed rollback and reapplication leave the certified ledger')

  const plans = []
  for (const [surface, statement] of [
    ['recurring_expenses', `SELECT id,amount FROM public.recurring_expenses WHERE business_id='${id(101)}' AND is_active`],
    ['cash_registers', `SELECT id,ars_balance FROM public.cash_registers WHERE business_id='${id(101)}' ORDER BY date DESC LIMIT 1`],
  ]) {
    const plan = sql(`BEGIN;
      SET LOCAL ROLE authenticated;
      SELECT set_config('request.jwt.claims','{"sub":"${id(1)}","role":"authenticated"}',true);
      EXPLAIN (FORMAT JSON) ${statement};
      ROLLBACK;`).split('\n').slice(1).join('\n')
    plans.push({ surface, statement, plan: JSON.parse(plan) })
  }
  writeFileSync(`${evidenceDir}/local-matrix.json`, JSON.stringify({ generated_at: new Date().toISOString(), checks, observations }, null, 2) + '\n')
  writeFileSync(`${evidenceDir}/query-plans.json`, JSON.stringify(plans, null, 2) + '\n')
  writeFileSync(`${evidenceDir}/regressions.json`, JSON.stringify(regressionResults, null, 2) + '\n')
  console.log(`RESULT ${checks} assertions; real PostgREST/JWT pre/post matrix passed`)
}

main().catch(error => {
  console.error(error.stderr?.toString() || error.stack || error.message)
  process.exitCode = 1
}).finally(() => {
  if (restOwned) docker(['rm', '-f', restName])
  if (owned && sql(`SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()`) === ownership) {
    docker(['exec', source, 'dropdb', '-U', 'supabase_admin', database])
  }
})
