// No URL accepted: source is a local Docker schema; all mutations target the
// uniquely named, disposable schema-only database owned by this harness.
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import assert from 'node:assert/strict'

const source = process.env.SEC08E_SOURCE_CONTAINER || 'supabase_db_techrepair-vite'
assert(/^supabase_db_[a-z0-9-]+$/.test(source), 'a local Supabase Docker container is required')
const database = 'sec08e_certification'
const restName = 'sec08e-certification-rest'
const migration = '20260922120000_sec08e_auxiliary_financial_reads.sql'
let localPassword = ''
const docker = (args, input) => execFileSync('docker',
  args[0]==='exec' && localPassword && args.includes('supabase_admin')
    ? [args[0],'-e',`PGPASSWORD=${localPassword}`,...args.slice(1)] : args, {
  input, encoding: 'utf8', stdio: ['pipe','pipe','pipe'], maxBuffer: 32 * 1024 * 1024,
})
const sql = q => docker(['exec','-i',source,'psql','-X','-U','supabase_admin','-d',database,
  '-Atq','-v','ON_ERROR_STOP=1'], q).trim()
const id = n => `e0800000-0000-0000-0000-${String(n).padStart(12,'0')}`
let checks = 0
let legacyBaseline
const legacyOutcome = () => {
  try { sql(readFileSync('supabase/tests/etapa7_rpc_integration_comprobante_annulment_test.sql','utf8')); return 'PASS' }
  catch (error) {
    const detail=error.stderr?.toString() || error.message
    // This historical fixture checks out in a second owner business without
    // its canonical profile. Lote 3 rejects it before any annulment is called.
    if(!detail.includes('ERROR:  FORBIDDEN') || !detail.includes('public.create_comprobante_checkout_atomic')) throw error
    return 'FORBIDDEN at historical second-tenant checkout fixture'
  }
}
const check = (value, label) => { assert(value, label); checks++ }
const signatures = ['public.get_payment_allocations(uuid,uuid,uuid)',
  'public.get_order_financial_amounts(uuid,uuid[])','public.get_order_line_amounts(uuid,uuid[])',
  'public.can_view_inventory_cost(uuid)','public.can_view_supplier_finance(uuid)',
  'public.finance_insights_read(uuid,date,date,text,integer)']
const snapshot = () => sql(`SELECT jsonb_agg(pg_get_functiondef(oid) ORDER BY oid::regprocedure::text)
  FROM pg_proc WHERE oid IN (${signatures.map(s=>`'${s}'::regprocedure`).join(',')});`)
const queryAs = (actor, query) => sql(`BEGIN; SET LOCAL ROLE authenticated;
  SELECT set_config('request.jwt.claims','{"sub":"${id(actor)}","role":"authenticated"}',true);
  ${query}; ROLLBACK;`).split('\n').slice(1).join('\n')

async function main() {
  const sourceConfig = JSON.parse(docker(['inspect',source]))[0]
  localPassword = sourceConfig.Config.Env.find(s=>s.startsWith('POSTGRES_PASSWORD='))?.slice('POSTGRES_PASSWORD='.length) || ''
  if (!process.argv.includes('--test-only')) {
    const sourceVersion = docker(['exec',source,'psql','-X','-U','postgres','-d','postgres','-Atq',
      '-c','SELECT max(version) FROM supabase_migrations.schema_migrations']).trim()
    assert(/^\d{14}$/.test(sourceVersion) && sourceVersion >= '20260903120000' && sourceVersion < migration.slice(0,14),
      'source must be a pre-SEC08E local baseline, at least Mobile2A')
    const schemas = ['public','private','auth','storage','extensions','vault']
    let schema = docker(['exec',source,'pg_dump','-U','postgres','-d','postgres',
      '--schema-only','--no-publications','--no-subscriptions',...schemas.flatMap(s=>['--schema',s])])
    schema = schema.replace('CREATE FUNCTION', `CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE FUNCTION`)
    try { docker(['rm','-f',restName]) } catch { /* no previous harness container */ }
    const existing = docker(['exec',source,'psql','-X','-U','supabase_admin','-d','postgres','-Atq','-c',
      `SELECT coalesce(shobj_description(oid,'pg_database'),'UNOWNED') FROM pg_database WHERE datname='${database}'`]).trim()
    assert(!existing || existing === 'SEC-08E disposable schema-only tests', 'refusing to replace an unowned database')
    docker(['exec',source,'dropdb','-U','supabase_admin','--if-exists',database])
    docker(['exec',source,'createdb','-U','supabase_admin',database])
    sql(`COMMENT ON DATABASE ${database} IS 'SEC-08E disposable schema-only tests';`)
    sql('DROP SCHEMA public;')
    sql(schema)
    for (const file of readdirSync('supabase/migrations').sort().filter(f=>f.slice(0,14)>sourceVersion && f<migration)) {
      sql('BEGIN; SET LOCAL ROLE postgres;\n'+readFileSync(`supabase/migrations/${file}`,'utf8').replace(/^(BEGIN|COMMIT);\s*$/gm,'')+'\nCOMMIT;')
    }
    console.log('PASS isolated schema-only baseline through SEC-08D; no data, cron or secrets copied')
    legacyBaseline=legacyOutcome()
    const before = snapshot()
    const originalAnnulmentBody=sql("SELECT prosrc FROM pg_proc WHERE oid='public.annul_comprobante_atomic(uuid,text,text,boolean,text)'::regprocedure")
    sql('BEGIN;\n'+readFileSync('tests/fixtures/sec08e.sql','utf8')+'\nCOMMIT;')
    check(queryAs(2,`SELECT unit_price FROM public.parts_used WHERE id='${id(401)}'`) === '7103.19', 'baseline parts leak reproduced')
    check(queryAs(2,`SELECT amount FROM public.customer_account_payment_allocations WHERE id='${id(701)}'`) === '3719.31', 'baseline allocation leak reproduced')
    check(queryAs(2,`SELECT reverted_cogs_ars FROM public.comprobante_annulments WHERE id='${id(601)}'`) === '6197.29', 'baseline annulment leak reproduced')
    if (process.argv.includes('--setup-pre-only')) return
    sql('SET ROLE postgres;\n'+readFileSync(`supabase/migrations/${migration}`,'utf8'))
    const after = snapshot()
    check(before === after, 'SEC-08A/B/C/D canonical RPC definitions unchanged')
    check(originalAnnulmentBody===sql("SELECT prosrc FROM pg_proc WHERE oid='private.sec08e_annul_comprobante_impl(uuid,text,text,boolean,text)'::regprocedure"),
      'annulment implementation body preserved byte-for-byte')
    sql('SET ROLE postgres;\n'+readFileSync(`supabase/migrations/${migration}`,'utf8'))
    check(after === snapshot(), 'reapply preserves canonical functions')
    console.log('PASS three baseline leaks reproduced; migration applied twice')
  }
  if (process.argv.includes('--setup-only')) return
  assert(sql(`SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()`)
    === 'SEC-08E disposable schema-only tests', 'refusing fixture mutations in an unowned database')

  // Older regression suites assert global empty-ledger counts. Remove ONLY
  // this harness's synthetic IDs, run their rolled-back fixtures, then restore
  // our witnesses for HTTP. No regression assertions are weakened or skipped.
  sql('BEGIN; SET LOCAL session_replication_role=replica;\n'+[
    'public.customer_account_payment_allocations','public.comprobante_annulments',
    'public.parts_used','public.comprobantes','public.orders','public.customers',
    'public.profiles','public.businesses','auth.users',
  ].map(table=>`DELETE FROM ${table} WHERE id::text LIKE 'e0800000-0000-0000-0000-%';`).join('\n')+'\nCOMMIT;')
  for (const file of [
    'tests/sql/sec08a_orders_data_visibility.test.sql',
    'tests/sql/sec08a_phase_b_pivots.test.sql',
    'tests/sql/sec08a_phase_c_payment_visibility.test.sql',
    'tests/sql/sec08b_inventory_cost_visibility.test.sql',
    'tests/sql/sec08c_supplier_finance_visibility.test.sql',
    'tests/sql/sec08d_finance_insights_visibility.test.sql',
    'tests/sql/sec08e_auxiliary_financial_reads.test.sql',
    'supabase/tests/p0a1u2_allocation_ui_contract_test.sql',
    'supabase/tests/etapa0_annulment_ledger_test.sql',
  ]) {
    sql(readFileSync(file,'utf8'))
    console.log(`PASS regression ${file.split('/').at(-1)}`)
  }
  if(legacyBaseline) {
    check(legacyOutcome()===legacyBaseline,'historical M7 outcome unchanged from baseline')
    console.log(`Historical M7 baseline/candidate: ${legacyBaseline}`)
  }
  sql('BEGIN;\n'+readFileSync('tests/fixtures/sec08e.sql','utf8')+'\nCOMMIT;')

  const rest = JSON.parse(docker(['inspect',source.replace('supabase_db_','supabase_rest_')]))[0]
  const vars = Object.fromEntries(rest.Config.Env.map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1)]}))
  const dbUrl = new URL(vars.PGRST_DB_URI)
  assert(dbUrl.hostname.startsWith('supabase_db_'), 'must use local Docker DB')
  dbUrl.pathname = '/' + database
  const secret = 'sec08e-local-only-jwt-secret-at-least-32-characters'
  try { docker(['rm','-f',restName]) } catch { /* no prior test container */ }
  docker(['run','-d','--name',restName,'--network',Object.keys(rest.NetworkSettings.Networks)[0],
    '-p','127.0.0.1::3000','-e',`PGRST_DB_URI=${dbUrl}`,'-e','PGRST_DB_SCHEMAS=public',
    '-e','PGRST_DB_ANON_ROLE=anon','-e',`PGRST_JWT_SECRET=${secret}`,rest.Config.Image])
  const port = JSON.parse(docker(['inspect',restName]))[0].NetworkSettings.Ports['3000/tcp'][0].HostPort
  const base = `http://127.0.0.1:${port}`
  const token = actor => {
    const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')
    const p=Buffer.from(JSON.stringify({sub:id(actor),role:'authenticated',exp:Math.floor(Date.now()/1000)+900})).toString('base64url')
    return `${h}.${p}.${createHmac('sha256',secret).update(`${h}.${p}`).digest('base64url')}`
  }
  const request = async (actor,path,body) => {
    const response=await fetch(base+path,{method:body?'POST':'GET',
      headers:{'Content-Type':'application/json',...(actor?{Authorization:`Bearer ${token(actor)}`}:{})},
      body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)})
    return {status:response.status,body:await response.json()}
  }
  for(let i=0;i<30;i++) {
    try { const r=await request(1,'/'); if(r.status===200) break } catch { /* startup */ }
    if(i===29) throw new Error('Local PostgREST did not start')
    await new Promise(r=>setTimeout(r,300))
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
  for(const actor of [1,4,8,9]) {
    const parts=await request(actor,`/v_parts_used_amounts?id=eq.${id(401)}`)
    check(parts.status===200 && parts.body[0]?.unit_price===7103.19,`actor ${actor} authorized part price`)
    const allocations=await request(actor,`/customer_account_payment_allocations?id=eq.${id(701)}&select=amount`)
    check(allocations.status===200 && allocations.body[0]?.amount===3719.31,`actor ${actor} allocation direct parity: ${JSON.stringify(allocations)}`)
    const rpc=await request(actor,'/rpc/get_payment_allocations',{p_business_id:id(101),p_comprobante_id:id(501),p_payment_movement_id:null})
    check(rpc.body.authorized===true && rpc.body.rows[0]?.amount===3719.31,`actor ${actor} canonical allocation read`)
    const ann=await request(actor,`/v_comprobante_annulment_amounts?id=eq.${id(601)}`)
    check(ann.status===200 && ann.body[0]?.reverted_cash_ars===8317.13,`actor ${actor} authorized reversed payment`)
    check(ann.body[0]?.reverted_cogs_ars===([1,9].includes(actor)?6197.29:null),`actor ${actor} raw COGS separation`)
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
  console.log(`PASS SEC-08E: ${checks} assertions, direct SELECT + filters + views + RPC + PostgREST embeds`)
}
main().catch(error=>{
  console.error(error.stderr?.toString() || error.message)
  process.exitCode=1
}).finally(()=>{
  if(!process.argv.includes('--setup-only') && !process.argv.includes('--setup-pre-only')) {
    try { docker(['rm','-f',restName]) } catch { /* already stopped */ }
    if(process.exitCode!==1) docker(['exec',source,'dropdb','-U','supabase_admin',database])
  }
})
