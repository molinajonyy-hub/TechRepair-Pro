// Real local PostgREST boundary with locally signed JWTs.
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
const actorNames=['owner','admin','manager','tech','sales','cashier','viewer','inactive','ownerB']
const ids = Object.fromEntries([
  'A','B',...actorNames,'supplier','inventory','purchaseBlocked','purchaseSafe','purchaseItemBlocked',
  'purchaseItemSafe','compForge','compDraft','compPayment','compDeleteOk','compForged',
  'paymentTransaction','categoryPositive','inventoryPositive','caja',
].map(name => [name,randomUUID()]))

// Phase C: a browser-crafted comprobante carrying forged fiscal identity and
// forged collection truth. No actor may persist this shape.
const forgedComprobante = businessId => ({
  business_id:businessId, tipo:'factura_c', estado:'emitido', status:'completed',
  estado_comercial:'pagado', estado_fiscal:'emitido', es_fiscal:true,
  cae:'75123456789012', numero_fiscal:'00001-00099999',
  total:999999, total_cobrado:999999, saldo_pendiente:0, payment_status:'paid',
})

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
  const token = (actor,role='authenticated') => {
    const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')
    const claims={role,aud:'authenticated',exp:Math.floor(Date.now()/1000)+600}
    if (actor) claims.sub=ids[actor]
    const c=Buffer.from(JSON.stringify(claims)).toString('base64url')
    const p=`${h}.${c}`
    return `${p}.${createHmac('sha256',signingKey).update(p).digest('base64url')}`
  }
  const request = async (actor,path,{method='GET',body,role='authenticated'}={}) => {
    requests++
    const response = await fetch(api+path,{
      method,
      headers:{'Content-Type':'application/json','Prefer':'return=representation',...(actor||role==='service_role'?{Authorization:`Bearer ${token(actor,role)}`}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
      signal:AbortSignal.timeout(10000),
    })
    const text=await response.text();let parsed=text
    try{parsed=text?JSON.parse(text):null}catch{}
    return {status:response.status,body:parsed}
  }
  const fingerprint = () => sql(`SELECT md5(jsonb_build_object(
    'purchases',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.supplier_purchases x WHERE business_id='${ids.A}'),
    'items',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.supplier_purchase_items x WHERE business_id='${ids.A}'),
    'deletions',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.supplier_purchase_deletions x WHERE business_id='${ids.A}'),
    'inventory',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.inventory x WHERE business_id='${ids.A}'),
    'comprobantes',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.comprobantes x WHERE business_id='${ids.A}'),
    'payments',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.comprobante_payments x WHERE business_id='${ids.A}'),
    'pt',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.payment_transactions x WHERE business_id='${ids.A}'),
    'fm',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.financial_movements x WHERE business_id='${ids.A}'),
    'bfe',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.business_finance_entries x WHERE business_id='${ids.A}')
  )::text)`)
  const deny = async (actor,path,options,label) => {
    const before=fingerprint()
    const result=await request(actor,path,options)
    assert([401,403,404].includes(result.status),`${label}: ${JSON.stringify(result)}`)
    assert.equal(fingerprint(),before,`${label} changed data`)
    return result
  }

  const users=actorNames.map(name=>`('${ids[name]}','${name}@lote3-http.invalid',now())`).join(',')
  const profiles=actorNames.map(name=>`('${ids[name]}','${ids[name]}','${name==='ownerB'?ids.B:ids.A}','${name==='ownerB'||name==='inactive'?'owner':name}',${name==='inactive'?'false':'true'},'${name}@lote3-http.invalid')`).join(',')
  sql(`
    BEGIN;
    SET session_replication_role=replica;
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES ${users};
    INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status) VALUES
      ('${ids.A}','Synthetic Lote3 HTTP A','${ids.owner}','full','active'),
      ('${ids.B}','Synthetic Lote3 HTTP B','${ids.ownerB}','full','active');
    INSERT INTO public.profiles(id,user_id,business_id,role,is_active,email) VALUES ${profiles};
    INSERT INTO public.suppliers(id,business_id,name) VALUES('${ids.supplier}','${ids.A}','Lote3 HTTP supplier');
    INSERT INTO public.inventory(id,business_id,code,name,category,cost_price,sale_price,stock,stock_quantity) VALUES
      ('${ids.inventory}','${ids.A}','L3-HTTP-STOCK','Lote3 stock','fixture',1,2,10,10);
    INSERT INTO public.supplier_purchases(id,business_id,supplier_id,total_amount,paid_amount,pending_amount,payment_status,created_by) VALUES
      ('${ids.purchaseBlocked}','${ids.A}','${ids.supplier}',100,25,75,'partial','${ids.owner}'),
      ('${ids.purchaseSafe}','${ids.A}','${ids.supplier}',20,0,20,'pending','${ids.owner}');
    INSERT INTO public.supplier_purchase_items(id,business_id,purchase_id,supplier_id,inventory_id,product_name,quantity,unit_cost,subtotal) VALUES
      ('${ids.purchaseItemBlocked}','${ids.A}','${ids.purchaseBlocked}','${ids.supplier}','${ids.inventory}','Blocked item',3,10,30),
      ('${ids.purchaseItemSafe}','${ids.A}','${ids.purchaseSafe}','${ids.supplier}','${ids.inventory}','Safe item',2,10,20);
    INSERT INTO public.supplier_account_movements(business_id,supplier_id,purchase_id,type,description,debit,credit,balance_after) VALUES
      ('${ids.A}','${ids.supplier}','${ids.purchaseBlocked}','purchase','Blocked debt',100,0,75),
      ('${ids.A}','${ids.supplier}','${ids.purchaseSafe}','purchase','Safe debt',20,0,20);
    INSERT INTO public.comprobantes(id,business_id,tipo,estado,status,estado_comercial,total,total_cobrado,saldo_pendiente,payment_status) VALUES
      ('${ids.compForge}','${ids.A}','remito','emitido','completed','pendiente',100,0,100,'pending'),
      ('${ids.compDraft}','${ids.A}','remito','borrador','draft','pendiente',100,0,100,'pending'),
      ('${ids.compPayment}','${ids.A}','remito','emitido','completed','pendiente',100,0,100,'pending'),
      ('${ids.compDeleteOk}','${ids.A}','remito','borrador','draft','pendiente',0,0,0,'pending');
    INSERT INTO public.payment_transactions(id,business_id,comprobante_id,status,transaction_amount,net_amount_estimated,currency)
      VALUES('${ids.paymentTransaction}','${ids.A}','${ids.compForge}','pending',100,100,'ARS');
    INSERT INTO public.cajas(id,business_id,status,opened_by,opened_at)
      VALUES('${ids.caja}','${ids.A}','abierta','${ids.owner}',now());
    SET session_replication_role=origin;
    COMMIT;
  `);seeded=true

  const positive=await request('owner','/rpc/finance_dashboard_summary',{method:'POST',body:{p_business_id:ids.A,p_date_from:'2026-08-01',p_date_to:'2026-08-31'}})
  assert.equal(positive.status,200,`positive signed-JWT control failed: ${JSON.stringify(positive)}`)

  for (const actor of actorNames) {
    await deny(actor,`/supplier_purchases?id=eq.${ids.purchaseBlocked}`,{method:'DELETE'},`${actor} supplier parent DELETE`)
    await deny(actor,`/supplier_purchase_items?id=eq.${ids.purchaseItemBlocked}`,{method:'DELETE'},`${actor} supplier item DELETE`)
    await deny(actor,`/comprobantes?id=eq.${ids.compForge}`,{method:'PATCH',body:{total:1,total_cobrado:1000,saldo_pendiente:0,payment_status:'paid',cae:'FORGED',numero_fiscal:'X-1'}},`${actor} protected comprobante PATCH`)
    await deny(actor,'/comprobante_payments',{method:'POST',body:{comprobante_id:ids.compPayment,business_id:ids.A,amount:100,amount_ars:100,payment_method:'efectivo',created_by:ids[actor]}},`${actor} direct payment INSERT`)
    await deny(actor,`/payment_transactions?business_id=eq.${ids.A}`,{},`${actor} payment transaction SELECT`)
    await deny(actor,'/comprobantes',{method:'POST',body:{id:ids.compForged,...forgedComprobante(ids.A)}},`${actor} forged comprobante INSERT`)
    await deny(actor,`/comprobantes?id=eq.${ids.compForge}`,{method:'DELETE'},`${actor} comprobante direct DELETE`)
  }
  await deny(null,`/supplier_purchases?id=eq.${ids.purchaseBlocked}`,{method:'DELETE'},'anonymous supplier parent DELETE')
  await deny(null,`/comprobantes?id=eq.${ids.compForge}`,{method:'PATCH',body:{total:1}},'anonymous protected comprobante PATCH')
  await deny(null,'/comprobante_payments',{method:'POST',body:{comprobante_id:ids.compPayment,business_id:ids.A,amount:100,amount_ars:100,payment_method:'efectivo'}},'anonymous payment INSERT')
  await deny(null,`/payment_transactions?business_id=eq.${ids.A}`,{},'anonymous payment transaction SELECT')
  await deny(null,'/comprobantes',{method:'POST',body:{id:ids.compForged,...forgedComprobante(ids.A)}},'anonymous forged comprobante INSERT')
  await deny(null,`/comprobantes?id=eq.${ids.compForge}`,{method:'DELETE'},'anonymous comprobante DELETE')
  assert.equal(sql(`SELECT count(*) FROM public.comprobantes WHERE id='${ids.compForged}'`),'0','a forged comprobante was persisted')
  assert.equal(sql(`SELECT count(*) FROM public.comprobantes WHERE id='${ids.compForge}'`),'1','a comprobante was destroyed by direct DELETE')

  const observations=await request('sales',`/comprobantes?id=eq.${ids.compForge}`,{method:'PATCH',body:{observaciones:'safe-http-note'}})
  assert.equal(observations.status,200,`safe comprobante observation failed: ${JSON.stringify(observations)}`)

  const safeDelete=await request('manager','/rpc/delete_supplier_purchase_safe',{method:'POST',body:{p_business_id:ids.A,p_purchase_id:ids.purchaseSafe,p_user_id:ids.manager}})
  assert.equal(safeDelete.status,200,`safe supplier delete failed: ${JSON.stringify(safeDelete)}`)
  assert.equal(safeDelete.body?.ok,true,'safe supplier delete did not report ok')
  assert.equal(sql(`SELECT stock_quantity FROM public.inventory WHERE id='${ids.inventory}'`),'8','safe supplier delete did not reverse stock')
  assert.equal(sql(`SELECT count(*) FROM public.supplier_purchase_deletions WHERE purchase_id='${ids.purchaseSafe}'`),'1','safe supplier delete tombstone missing')

  const remito=await request('cashier','/rpc/issue_remito_atomic',{method:'POST',body:{p_comprobante_id:ids.compDraft,p_business_id:ids.A}})
  assert.equal(remito.status,200,`canonical remito issue failed: ${JSON.stringify(remito)}`)
  assert.equal(remito.body?.ok,true,'canonical remito issue did not report ok')

  // Phase C canonical delete: an inert draft is still removable through the RPC,
  // and the RPC still refuses what it is supposed to protect.
  const canonicalDelete=await request('manager','/rpc/delete_comprobante_with_finance',{method:'POST',body:{p_comprobante_id:ids.compDeleteOk}})
  assert.equal(canonicalDelete.status,200,`canonical comprobante delete failed: ${JSON.stringify(canonicalDelete)}`)
  assert.equal(canonicalDelete.body?.success,true,'canonical comprobante delete did not report success')
  assert.equal(sql(`SELECT count(*) FROM public.comprobantes WHERE id='${ids.compDeleteOk}'`),'0','canonical delete did not remove the draft')

  const guardedDelete=await request('manager','/rpc/delete_comprobante_with_finance',{method:'POST',body:{p_comprobante_id:ids.compForge}})
  assert.equal(guardedDelete.status,200,`canonical guarded delete errored: ${JSON.stringify(guardedDelete)}`)
  assert.equal(guardedDelete.body?.success,false,'canonical delete should refuse a non-draft comprobante')
  assert.equal(sql(`SELECT count(*) FROM public.comprobantes WHERE id='${ids.compForge}'`),'1','guarded comprobante was removed anyway')

  const viewerDelete=await request('viewer','/rpc/delete_comprobante_with_finance',{method:'POST',body:{p_comprobante_id:ids.compPayment}})
  assert.ok([401,403,404].includes(viewerDelete.status),`viewer canonical delete unexpectedly allowed: ${JSON.stringify(viewerDelete)}`)

  const payment=await request('cashier','/rpc/replace_comprobante_payment',{method:'POST',body:{
    p_comprobante_id:ids.compPayment,p_business_id:ids.A,p_payment_method:'efectivo',p_amount:100,p_amount_ars:100,
    p_currency:'ARS',p_exchange_rate:1,p_notes:'canonical HTTP positive',p_user_id:ids.cashier,p_commission_amount:0,
    p_payment_provider:null,p_idempotency_key:`l3b-http-${ids.compPayment}`,
  }})
  assert.equal(payment.status,200,`canonical payment failed: ${JSON.stringify(payment)}`)
  assert.equal(payment.body?.ok,true,'canonical payment did not report ok')
  assert.equal(sql(`SELECT (estado_comercial='pagado' AND total_cobrado=100 AND saldo_pendiente=0)::text FROM public.comprobantes WHERE id='${ids.compPayment}'`),'true','canonical payment did not reconcile receipt')
  assert.equal(sql(`SELECT (EXISTS(SELECT 1 FROM public.financial_movements WHERE comprobante_id='${ids.compPayment}') AND EXISTS(SELECT 1 FROM public.business_finance_entries WHERE reference_comprobante_id='${ids.compPayment}'))::text`),'true','canonical payment ledger effects missing')

  for (const actor of actorNames) {
    const result=await request(actor,'/rpc/finance_pending_historicals',{method:'POST',body:{p_business_id:ids.A}})
    if (actor==='owner'||actor==='admin') assert.equal(result.status,200,`${actor} pending historicals positive failed: ${JSON.stringify(result)}`)
    else assert([401,403,404].includes(result.status),`${actor} pending historicals unexpectedly allowed: ${JSON.stringify(result)}`)
  }
  const serviceRead=await request(null,`/payment_transactions?business_id=eq.${ids.A}`,{role:'service_role'})
  assert.equal(serviceRead.status,200,`effective service role payment read failed: ${JSON.stringify(serviceRead)}`)
  const servicePending=await request(null,'/rpc/finance_pending_historicals',{method:'POST',role:'service_role',body:{p_business_id:ids.A}})
  assert.equal(servicePending.status,200,`effective service role RPC bypass failed: ${JSON.stringify(servicePending)}`)

  console.log(`PASS Lote 3 Phase C real PostgREST: ${requests} requests; all browser-role direct exploits denied with zero effects; canonical supplier, comprobante create/delete, remito, payment and service-role controls passed`)
} catch (error) {
  console.error(error.message)
  process.exitCode=1
} finally {
  if (seeded) {
    try { sql(`
      SET session_replication_role=replica;
      DELETE FROM public.finance_audit_log WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.supplier_purchase_deletions WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.supplier_account_movements WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.supplier_payments WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.supplier_purchase_items WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.supplier_purchases WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.account_movements WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.accounts WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.financial_movements WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.business_finance_entries WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.comprobante_payments WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.payment_transactions WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.comprobantes WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.cajas WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.inventory WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.suppliers WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.profiles WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.businesses WHERE id IN ('${ids.A}','${ids.B}');
      DELETE FROM auth.users WHERE id IN (${actorNames.map(n=>`'${ids[n]}'`).join(',')});
      SET session_replication_role=origin;
    `) }
    catch (error) { console.error(`Local fixture cleanup failed: ${error.stderr?.toString() || error.message}`); process.exitCode=1 }
  }
}
