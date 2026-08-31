// Real PostgREST JWT boundary + simultaneous PostgreSQL sessions. LOCAL ONLY.
// Uses installed Docker images. Clones ONLY the empty synthetic certification DB.
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHmac, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
const container=process.env.LOTE2_DB_CONTAINER||'supabase_db_techrepair-mobile2a-expand'
if(!/^supabase_db_[a-z0-9-]+$/.test(container)) throw new Error('Local container required')
const db='lote2_boundary', rest='lote2_postgrest', api='http://127.0.0.1:55498'
const docker=(args,input,env)=>execFileSync('docker',args,{input,encoding:'utf8',env,maxBuffer:16*1024*1024,stdio:['pipe','pipe','pipe']})
const sql=q=>docker(['exec','-i',container,'psql','-X','-U','supabase_admin','-d',db,'-Atq','-v','ON_ERROR_STOP=1'],q).trim()
const tables=['inventory','inventory_movements','supplier_purchases','supplier_purchase_items','supplier_account_movements','supplier_purchase_deletions','financial_movements','business_finance_entries','comprobantes','comprobante_items','wholesale_order_items','accounts','account_movements','customer_account_payment_allocations','finance_audit_log']
const fingerprint=()=>sql(`SELECT jsonb_build_object(${tables.map(t=>`'${t}',(SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text)::text,'[]')) FROM public.${t} r)`).join(',')});`)
let requests=0, denies=0, started=false, created=false
const sessions=[]
class Session {
  constructor(name){
    this.name=name;this.buffer='';this.pending=null
    this.child=spawn('docker',['exec','-i',container,'psql','-X','-U','postgres','-d',db,'-Atq','-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe'],windowsHide:true})
    let errors=''
    this.child.stderr.on('data',d=>{errors+=d.toString()})
    this.child.stdout.on('data',d=>{this.buffer+=d.toString();if(this.pending&&this.buffer.includes(this.pending.marker+'\n')){const p=this.pending;const [result,...rest]=this.buffer.split(p.marker+'\n');this.buffer=rest.join(p.marker+'\n');this.pending=null;clearTimeout(p.timer);p.resolve(result.trim())}})
    this.child.on('exit',code=>{if(this.pending)this.pending.reject(new Error(`${name} exited ${code}: ${errors}`))})
    sessions.push(this)
  }
  run(query){if(this.pending)throw new Error('Concurrent command on same session');return new Promise((resolve,reject)=>{const marker='done_'+randomUUID().replaceAll('-','');const timer=setTimeout(()=>reject(new Error(`${this.name}: query timed out`)),15000);this.pending={resolve,reject,marker,timer};this.child.stdin.write(query+'\n\\echo '+marker+'\n')})}
  close(){this.child.stdin.end('ROLLBACK;\n\\q\n')}
}
try {
  docker(['exec',container,'dropdb','-U','supabase_admin','--if-exists',db])
  docker(['exec',container,'createdb','-U','supabase_admin','-T','lote2_certification',db]);created=true
  const fixture=readFileSync('tests/sql/lote2_secdef_tenant_authority.test.sql','utf8').split('CREATE FUNCTION pg_temp.rpc_queries')[0]
  const ids=JSON.parse(sql(fixture+"\nSELECT jsonb_object_agg(name,id) FROM pg_temp.ids;\nCOMMIT;"))
  const sourceRest=container.replace('supabase_db_','supabase_rest_')
  const config=JSON.parse(docker(['inspect',sourceRest]))[0]
  const vars=Object.fromEntries(config.Config.Env.map(s=>{const i=s.indexOf('=');return[s.slice(0,i),s.slice(i+1)]}))
  const uri=new URL(vars.PGRST_DB_URI);uri.pathname='/'+db
  const network=Object.keys(config.NetworkSettings.Networks)[0]
  assert(vars.PGRST_JWT_SECRET && network,'Local PostgREST configuration missing')
  const env={...process.env,PGRST_DB_URI:uri.href,PGRST_JWT_SECRET:vars.PGRST_JWT_SECRET,PGRST_DB_SCHEMAS:'public',PGRST_DB_ANON_ROLE:'anon'}
  docker(['run','--rm','-d','--name',rest,'--network',network,'-p','127.0.0.1:55498:3000',...['PGRST_DB_URI','PGRST_JWT_SECRET','PGRST_DB_SCHEMAS','PGRST_DB_ANON_ROLE'].flatMap(k=>['-e',k]),config.Config.Image],undefined,env);started=true
  let ready=false
  for(let i=0;i<60;i++){try{ready=(await fetch(api,{signal:AbortSignal.timeout(1000)})).ok}catch{}if(ready)break;await new Promise(r=>setTimeout(r,200))}
  assert(ready,'Isolated local PostgREST did not become ready')
  let signingKey=Buffer.from(vars.PGRST_JWT_SECRET)
  if(vars.PGRST_JWT_SECRET.trim().startsWith('{')){const key=JSON.parse(vars.PGRST_JWT_SECRET).keys.find(k=>k.kty==='oct');assert(key?.k,'Local HS256 JWK missing');signingKey=Buffer.from(key.k,'base64url')}
  const token=actor=>{const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');const claims=Buffer.from(JSON.stringify({role:'authenticated',sub:ids[actor],aud:'authenticated',exp:Math.floor(Date.now()/1000)+600})).toString('base64url');const payload=header+'.'+claims;return payload+'.'+createHmac('sha256',signingKey).update(payload).digest('base64url')}
  const rpc=async(actor,name,body)=>{requests++;const response=await fetch(`${api}/rpc/${name}`,{method:'POST',headers:{'Content-Type':'application/json',...(actor?{Authorization:'Bearer '+token(actor)}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});return{status:response.status,body:await response.json()}}
  const authenticatedProbe=await rpc('owner','preview_missing_stock_movements',{p_business_id:ids.A})
  assert.equal(authenticatedProbe.status,200,`Positive JWT control failed: ${JSON.stringify(authenticatedProbe)}`)
  const cases=[
    ['repair_missing_stock_movements',{p_business_id:ids.B,p_allow_negative:true}],
    ['preview_missing_stock_movements',{p_business_id:ids.B}],
    ['delete_supplier_purchase_safe',{p_business_id:ids.B,p_purchase_id:ids.purchaseB,p_user_id:ids.ownerB}],
    ['backfill_remito_fm',{p_remito_ids:[ids.remitoB]}],
    ['check_user_limit_before_invite',{p_business_id:ids.B}],
    ['pay_comprobante_from_account_atomic',{p_business_id:ids.B,p_account_id:ids.accountB,p_comprobante_id:ids.compB,p_amount:10,p_description:'L2',p_payment_method:'transferencia',p_date:'2026-08-31',p_caja_id:null,p_user_id:ids.ownerB,p_idempotency_key:'http-deny'}],
    ...['user_can_allocate_payments','user_can_reverse_allocations','user_can_view_order_amounts'].map(n=>[n,{p_business_id:ids.B,p_user_id:ids.ownerB}])
  ]
  for(const actor of [null,'owner','admin','manager','tech','sales','cashier','viewer','inactive','outsider','denied_admin','override_tech','linked_actor'])for(const[name,body]of cases){const before=fingerprint();const r=await rpc(actor,name,body);assert((actor?[403,404]:[401,403,404]).includes(r.status),`${actor} ${name}: ${JSON.stringify(r)}`);assert(['42501','PGRST202'].includes(r.body.code),'Reject must be authority/schema-cache, never invalid JWT');assert.equal(fingerprint(),before,'HTTP reject changed data');denies++}
  for(const name of ['repair_missing_stock_movements','preview_missing_stock_movements','check_user_limit_before_invite']){const before=fingerprint();const r=await rpc('denied_admin',name,{p_business_id:ids.A});assert.equal(r.status,403);assert.equal(fingerprint(),before);denies++}
  const foreign={p_business_id:ids.A,p_purchase_id:ids.purchaseB,p_user_id:ids.owner}
  const beforeEntity=fingerprint();const foreignResult=await rpc('owner','delete_supplier_purchase_safe',foreign);assert.equal(foreignResult.body.error_code,'NOT_FOUND');assert.equal(fingerprint(),beforeEntity);denies++
  assert.equal((await rpc('admin','preview_missing_stock_movements',{p_business_id:ids.A})).body.length,3)
  // SKIP LOCKED and replay with actual simultaneous transactions.
  const a=new Session('lote2_session_a'),b=new Session('lote2_session_b')
  const asOwner=`SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims='${JSON.stringify({role:'authenticated',sub:ids.owner})}';`
  await a.run(`BEGIN; SET LOCAL application_name='lote2_session_a'; SELECT id FROM public.comprobante_items WHERE comprobante_id='${ids.compA}' FOR UPDATE;`)
  await b.run(`BEGIN; SET LOCAL application_name='lote2_session_b'; ${asOwner}`)
  const locked=JSON.parse(await b.run(`SELECT public.repair_missing_stock_movements('${ids.A}',false);`))
  assert.equal(locked.comprobantes_procesados,0,'locked comprobante skipped');assert.equal(locked.pedidos_mayoristas_procesados,1)
  await b.run('COMMIT;');await a.run('ROLLBACK;')
  await a.run(`BEGIN; ${asOwner}`)
  const repaired=JSON.parse(await a.run(`SELECT public.repair_missing_stock_movements('${ids.A}',false);`));assert.equal(repaired.comprobantes_procesados,1)
  await b.run(`BEGIN; ${asOwner}`)
  const concurrent=JSON.parse(await b.run(`SELECT public.repair_missing_stock_movements('${ids.A}',false);`));assert.equal(concurrent.comprobantes_procesados,0)
  await b.run('COMMIT;');await a.run('COMMIT;')
  assert.equal(sql(`SELECT count(*) FROM public.inventory_movements WHERE reference_id='${ids.compA}'`),'1')
  // Supplier deletion second caller MUST block, then replay exactly once.
  await a.run(`BEGIN; ${asOwner}`)
  const deleted=JSON.parse(await a.run(`SELECT public.delete_supplier_purchase_safe('${ids.A}','${ids.purchaseA}','${ids.ownerB}');`));assert.equal(deleted.ok,true)
  await b.run(`BEGIN; SET LOCAL application_name='lote2_session_b'; ${asOwner}`)
  const pending=b.run(`SELECT public.delete_supplier_purchase_safe('${ids.A}','${ids.purchaseA}','${ids.ownerB}');`)
  let blocked=false
  for(let i=0;i<20;i++){blocked=sql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname='lote2_boundary' AND application_name='lote2_session_b' AND cardinality(pg_blocking_pids(pid))>0)")==='t';if(blocked)break;await new Promise(r=>setTimeout(r,50))}
  assert(blocked,'second delete did not wait on first transaction')
  await a.run('COMMIT;');const replay=JSON.parse(await pending);assert.equal(replay.replay,true);assert.equal(replay.error_code,'ALREADY_DELETED');await b.run('COMMIT;')
  assert.equal(sql(`SELECT count(*) FROM public.inventory_movements WHERE reference_id='${ids.purchaseA}'`),'1')
  assert.equal(sql(`SELECT user_id FROM public.supplier_purchase_deletions WHERE purchase_id='${ids.purchaseA}'`),ids.owner)
  assert.equal(sql(`SELECT stock_quantity FROM public.inventory WHERE id='${ids.invA}'`),'14')
  const httpReplay=await rpc('owner','delete_supplier_purchase_safe',{p_business_id:ids.A,p_purchase_id:ids.purchaseA,p_user_id:ids.ownerB});assert.equal(httpReplay.body.replay,true)
  const negative=await rpc('admin','repair_missing_stock_movements',{p_business_id:ids.A,p_allow_negative:true});assert.equal(negative.body.comprobantes_procesados,1)
  console.log(`PASS ${requests} real HTTP/PostgREST requests (${denies} fingerprinted rejects); signed local authenticated JWTs; authorized preview/repair/replay`)
  console.log('PASS concurrent SKIP LOCKED + single stock deduction + blocking supplier deletion + exactly-one tombstone/movement + forged actor ignored')
} catch(error){console.error(error.stderr?.toString()||error.message);process.exitCode=1}
finally{
  for(const s of sessions)s.close()
  if(started)docker(['stop',rest])
  if(created)docker(['exec',container,'dropdb','-U','supabase_admin','--force',db])
}
