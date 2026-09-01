// Real local PostgREST boundary with locally signed authenticated JWTs.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHmac, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const project = readFileSync('supabase/config.toml','utf8').match(/^project_id = "([a-z0-9-]+)"/m)?.[1]
if (!project) throw new Error('Cannot identify local Supabase project')
const dbContainer = process.env.LOTE3_DB_CONTAINER || `supabase_db_${project}`
const restContainer = `supabase_rest_${project}`
const kongContainer = `supabase_kong_${project}`
if (!/^supabase_db_[a-z0-9-]+$/.test(dbContainer)) throw new Error('Local DB container required')

const docker = (args,input) => execFileSync('docker',args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:16*1024*1024})
const sql = query => docker(['exec','-i',dbContainer,'psql','-X','-U','postgres','-d','postgres','-Atq','-v','ON_ERROR_STOP=1'],query).trim()
const ids = Object.fromEntries([
  'A','B','owner','viewer','inactive','ownerB','adminFalse','techTrue','customerOnly',
  'customerA','compA','ptA','categoryPositive','inventoryPositive',
].map(name => [name,randomUUID()]))

let seeded = false
let requests = 0
try {
  const config = JSON.parse(docker(['inspect',restContainer]))[0]
  const kong = JSON.parse(docker(['inspect',kongContainer]))[0]
  const vars = Object.fromEntries(config.Config.Env.map(s => { const i=s.indexOf('='); return [s.slice(0,i),s.slice(i+1)] }))
  const hostPort = kong.NetworkSettings.Ports?.['8000/tcp']?.[0]?.HostPort
  assert(vars.PGRST_JWT_SECRET && hostPort,'Local PostgREST configuration missing')
  const api = `http://127.0.0.1:${hostPort}/rest/v1`
  let signingKey = Buffer.from(vars.PGRST_JWT_SECRET)
  if (vars.PGRST_JWT_SECRET.trim().startsWith('{')) {
    const key = JSON.parse(vars.PGRST_JWT_SECRET).keys.find(k => k.kty === 'oct')
    assert(key?.k,'Local HS256 JWK missing')
    signingKey = Buffer.from(key.k,'base64url')
  }
  const token = actor => {
    const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')
    const c=Buffer.from(JSON.stringify({role:'authenticated',sub:ids[actor],aud:'authenticated',exp:Math.floor(Date.now()/1000)+600})).toString('base64url')
    const p=`${h}.${c}`
    return `${p}.${createHmac('sha256',signingKey).update(p).digest('base64url')}`
  }
  const request = async (actor,path,{method='GET',body}={}) => {
    requests++
    const response = await fetch(api+path,{
      method,
      headers:{'Content-Type':'application/json','Prefer':'return=representation',...(actor?{Authorization:`Bearer ${token(actor)}`}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
      signal:AbortSignal.timeout(10000),
    })
    const text=await response.text();let parsed=text
    try{parsed=text?JSON.parse(text):null}catch{}
    return {status:response.status,body:parsed}
  }
  const deny = async (actor,path,options,label) => {
    const before=sql("SELECT md5(jsonb_build_object('pt',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.payment_transactions x),'fm',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.financial_movements x),'bfe',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.business_finance_entries x),'ec',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.expense_categories x),'inventory',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.inventory x))::text)")
    const result=await request(actor,path,options)
    assert([401,403,404].includes(result.status),`${label}: ${JSON.stringify(result)}`)
    assert.equal(sql("SELECT md5(jsonb_build_object('pt',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.payment_transactions x),'fm',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.financial_movements x),'bfe',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.business_finance_entries x),'ec',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.expense_categories x),'inventory',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.inventory x))::text)"),before,`${label} changed data`)
    return result
  }

  sql(`
    BEGIN;
    SET session_replication_role=replica;
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
      ('${ids.owner}','owner@lote3-http.invalid',now()),('${ids.viewer}','viewer@lote3-http.invalid',now()),
      ('${ids.inactive}','inactive@lote3-http.invalid',now()),('${ids.ownerB}','ownerb@lote3-http.invalid',now()),
      ('${ids.adminFalse}','adminfalse@lote3-http.invalid',now()),('${ids.techTrue}','techtrue@lote3-http.invalid',now()),
      ('${ids.customerOnly}','customeronly@lote3-http.invalid',now());
    INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status) VALUES
      ('${ids.A}','Synthetic Lote3 HTTP A','${ids.owner}','full','active'),
      ('${ids.B}','Synthetic Lote3 HTTP B','${ids.ownerB}','full','active');
    INSERT INTO public.profiles(id,user_id,business_id,role,is_active,email,permissions) VALUES
      ('${ids.owner}','${ids.owner}','${ids.A}','owner',true,'owner@lote3-http.invalid',NULL),
      ('${ids.viewer}','${ids.viewer}','${ids.A}','viewer',true,'viewer@lote3-http.invalid',NULL),
      ('${ids.inactive}','${ids.inactive}','${ids.A}','owner',false,'inactive@lote3-http.invalid',NULL),
      ('${ids.ownerB}','${ids.ownerB}','${ids.B}','owner',true,'ownerb@lote3-http.invalid',NULL),
      ('${ids.adminFalse}','${ids.adminFalse}','${ids.A}','admin',true,'adminfalse@lote3-http.invalid','{"finance":false,"customers":false,"orders_view_financials":false}'),
      ('${ids.techTrue}','${ids.techTrue}','${ids.A}','tech',true,'techtrue@lote3-http.invalid','{"finance":true,"customers":true,"orders_view_financials":true}'),
      ('${ids.customerOnly}','${ids.customerOnly}','${ids.A}','tech',true,'customeronly@lote3-http.invalid','{"customers":true,"orders_view_financials":false}');
    INSERT INTO public.customers(id,business_id,name,phone) VALUES('${ids.customerA}','${ids.A}','Synthetic','000');
    INSERT INTO public.comprobantes(id,business_id,customer_id,tipo,estado,status,estado_comercial,total,saldo_pendiente)
      VALUES('${ids.compA}','${ids.A}','${ids.customerA}','remito','emitido','completed','pendiente',100,100);
    INSERT INTO public.payment_transactions(id,business_id,comprobante_id,status,transaction_amount,net_amount_estimated,currency)
      VALUES('${ids.ptA}','${ids.A}','${ids.compA}','pending',100,100,'ARS');
    SET session_replication_role=origin;
    COMMIT;
  `);seeded=true

  // A 200 response proves the JWT is valid and PostgREST resolved auth.uid().
  const positive=await request('owner','/rpc/finance_dashboard_summary',{method:'POST',body:{p_business_id:ids.A,p_date_from:'2026-08-01',p_date_to:'2026-08-31'}})
  assert.equal(positive.status,200,`positive signed-JWT control failed: ${JSON.stringify(positive)}`)
  assert.equal((await request('techTrue','/rpc/finance_dashboard_summary',{method:'POST',body:{p_business_id:ids.A,p_date_from:'2026-08-01',p_date_to:'2026-08-31'}})).status,200,'explicit false-default -> true override must allow')

  await deny(null,'/rpc/finance_dashboard_summary',{method:'POST',body:{p_business_id:ids.A,p_date_from:'2026-08-01',p_date_to:'2026-08-31'}},'anonymous finance RPC')
  await deny('viewer','/rpc/finance_dashboard_summary',{method:'POST',body:{p_business_id:ids.A,p_date_from:'2026-08-01',p_date_to:'2026-08-31'}},'viewer finance RPC')
  await deny('inactive','/rpc/finance_dashboard_summary',{method:'POST',body:{p_business_id:ids.A,p_date_from:'2026-08-01',p_date_to:'2026-08-31'}},'inactive finance RPC')
  await deny('ownerB','/rpc/finance_dashboard_summary',{method:'POST',body:{p_business_id:ids.A,p_date_from:'2026-08-01',p_date_to:'2026-08-31'}},'foreign finance RPC')
  await deny('adminFalse','/rpc/finance_dashboard_summary',{method:'POST',body:{p_business_id:ids.A,p_date_from:'2026-08-01',p_date_to:'2026-08-31'}},'true-default explicit false override')

  assert.equal((await request('techTrue','/rpc/customer_purchase_history',{method:'POST',body:{p_customer_id:ids.customerA,p_business_id:ids.A}})).status,200,'combined capability positive')
  await deny('customerOnly','/rpc/customer_purchase_history',{method:'POST',body:{p_customer_id:ids.customerA,p_business_id:ids.A}},'combined capability missing financial half')

  assert.equal((await request('viewer',`/payment_transactions?business_id=eq.${ids.A}`)).status,200,'payment history remains readable')
  await deny('owner','/payment_transactions',{method:'POST',body:{business_id:ids.A,status:'approved',transaction_amount:100,net_amount_estimated:100,currency:'ARS'}},'payment INSERT')
  await deny('owner',`/payment_transactions?id=eq.${ids.ptA}`,{method:'PATCH',body:{status:'approved'}},'payment approved UPDATE')

  await deny('viewer','/expense_categories',{method:'POST',body:{business_id:ids.A,name:'viewer-forged'}},'is_staff finance write')
  const directPositive=await request('owner','/expense_categories',{method:'POST',body:{id:ids.categoryPositive,business_id:ids.A,name:'owner-authorized'}})
  assert.equal(directPositive.status,201,`capability RLS positive failed: ${JSON.stringify(directPositive)}`)
  const inventoryBody={business_id:ids.A,code:'L3-HTTP',name:'Lote3 HTTP item',category:'fixture',cost_price:1,sale_price:2}
  await deny('viewer','/inventory',{method:'POST',body:inventoryBody},'parallel inventory tenant-only policy')
  const inventoryPositive=await request('owner','/inventory',{method:'POST',body:{...inventoryBody,id:ids.inventoryPositive,code:'L3-HTTP-OK'}})
  assert.equal(inventoryPositive.status,201,`inventory capability RLS positive failed: ${JSON.stringify(inventoryPositive)}`)

  console.log(`PASS Lote 3 real PostgREST: ${requests} requests, valid signed JWT positive controls, overrides, combined capability, RLS and payment zero-effect rejects`)
} catch (error) {
  console.error(error.message)
  process.exitCode=1
} finally {
  if (seeded) {
    try { sql(`DELETE FROM public.businesses WHERE id IN ('${ids.A}','${ids.B}'); DELETE FROM auth.users WHERE id IN ('${ids.owner}','${ids.viewer}','${ids.inactive}','${ids.ownerB}','${ids.adminFalse}','${ids.techTrue}','${ids.customerOnly}');`) }
    catch (error) { console.error(`Local fixture cleanup failed: ${error.stderr?.toString() || error.message}`); process.exitCode=1 }
  }
}
