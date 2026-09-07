// Local schema-only compatibility matrix. No production URL or credentials accepted.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import assert from 'node:assert/strict'

const source=process.env.SEC08E_SOURCE_CONTAINER || 'supabase_db_techrepair-vite'
assert(/^supabase_db_[a-z0-9-]+$/.test(source))
const database='sec08e_certification'
const restName='sec08e-rollout-rest'
const generated=['src/services/sec08eRolloutOld.generated.ts','src/services/sec08eRolloutInitial.generated.ts','src/services/sec08eRolloutInitialParts.generated.ts']
for(const path of generated) assert(!existsSync(path),`Refusing to overwrite ${path}`)
const run=(cmd,args,input,env=process.env)=>execFileSync(cmd,args,{input,env,encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:32*1024*1024})
const docker=(args,input)=>run('docker',args,input)
let password=''
let owned=false
const sql=q=>docker(['exec','-i','-e',`PGPASSWORD=${password}`,source,'psql','-X','-U','supabase_admin','-d',database,'-Atq','-v','ON_ERROR_STOP=1'],q)
try {
  run(process.execPath,['scripts/security/sec08e-local.mjs','--setup-pre-only'])
  password=JSON.parse(docker(['inspect',source]))[0].Config.Env.find(v=>v.startsWith('POSTGRES_PASSWORD='))?.slice(18) || ''
  assert(sql("SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()").trim()==='SEC-08E disposable schema-only tests')
  owned=true
  writeFileSync(generated[0],run('git',['show','3f9ac158478069c92f6614798f5d218a6820e6a1:src/services/api.ts']))
  writeFileSync(generated[1],run('git',['show','fe68866c38acf30ec7847c15e11ccf56752f682f:src/services/api.ts']).replace("'./partsUsedAccess'","'./sec08eRolloutInitialParts.generated'"))
  writeFileSync(generated[2],run('git',['show','fe68866c38acf30ec7847c15e11ccf56752f682f:src/services/partsUsedAccess.ts']))
  const rest=JSON.parse(docker(['inspect',source.replace('supabase_db_','supabase_rest_')]))[0]
  const uri=new URL(rest.Config.Env.find(v=>v.startsWith('PGRST_DB_URI=')).slice('PGRST_DB_URI='.length))
  assert(uri.hostname===source)
  uri.pathname='/'+database
  const secret='sec08e-rollout-local-only-signing-secret'
  docker(['run','-d','--name',restName,'--network',Object.keys(rest.NetworkSettings.Networks)[0],'-p','127.0.0.1::3000',
    '-e',`PGRST_DB_URI=${uri}`,'-e','PGRST_DB_SCHEMAS=public','-e','PGRST_DB_ANON_ROLE=anon','-e',`PGRST_JWT_SECRET=${secret}`,rest.Config.Image])
  const port=JSON.parse(docker(['inspect',restName]))[0].NetworkSettings.Ports['3000/tcp'][0].HostPort
  const base=`http://127.0.0.1:${port}`
  const token=actor=>{
    const h=Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')
    const p=Buffer.from(JSON.stringify({sub:`e0800000-0000-0000-0000-${String(actor).padStart(12,'0')}`,role:'authenticated',exp:Math.floor(Date.now()/1000)+900})).toString('base64url')
    return `${h}.${p}.${createHmac('sha256',secret).update(`${h}.${p}`).digest('base64url')}`
  }
  for(let i=0;i<30;i++) {
    try {if((await fetch(base,{headers:{Authorization:`Bearer ${token(1)}`}})).ok) break} catch { /* startup */ }
    if(i===29) throw Error('Local REST startup failed')
    await new Promise(resolve=>setTimeout(resolve,200))
  }
  for(const schema of ['pre','post']) {
    if(schema==='post') {
      sql('SET ROLE postgres;\n'+readFileSync('supabase/migrations/20260922120000_sec08e_auxiliary_financial_reads.sql','utf8'))
      // Readiness, never assume a fixed reload delay.
      for(let i=0;i<30;i++) {
        try {if((await fetch(base+'/v_parts_used_amounts?limit=0',{headers:{Authorization:`Bearer ${token(1)}`}})).ok) break} catch { /* restart */ }
        if(i===29) throw Error('Post-migration REST readiness failed')
        await new Promise(resolve=>setTimeout(resolve,200))
      }
    }
    const env={...process.env,SEC08E_ROLLOUT_URL:base,SEC08E_ROLLOUT_OWNER:token(1),SEC08E_ROLLOUT_TECH:token(2),SEC08E_ROLLOUT_SCHEMA:schema}
    try {
      const output=run(process.execPath,['node_modules/vitest/vitest.mjs','run','--config','vitest.sec08e-rollout.config.ts'],undefined,env)
      console.log(output.split('\n').filter(line=>/MATRIX|Test Files|Tests |✓/.test(line)).join('\n'))
    } catch(error) {console.error(error.stdout?.toString());throw error}
    if(schema==='post') {
      sql("ALTER VIEW public.v_parts_used_amounts RENAME TO sec08e_missing_view_fault; NOTIFY pgrst, 'reload schema';")
      for(let i=0;i<30;i++) {
        const response=await fetch(base+'/v_parts_used_amounts?limit=0',{headers:{Authorization:`Bearer ${token(1)}`}})
        if((await response.json()).code==='PGRST205') break
        if(i===29) throw Error('Missing-view fault not observed')
        await new Promise(resolve=>setTimeout(resolve,200))
      }
      try {
        const output=run(process.execPath,['node_modules/vitest/vitest.mjs','run','--config','vitest.sec08e-rollout.config.ts','-t','propagates a missing-view fault'],undefined,{...env,SEC08E_ROLLOUT_FAULT:'missing-view'})
        console.log('POST-MIGRATION MISSING-VIEW FAULT')
        console.log(output.split('\n').filter(line=>/Test Files|Tests |✓/.test(line)).join('\n'))
      } catch(error) {console.error(error.stdout?.toString());throw error}
    }
  }
} catch(error) {
  console.error(error.stderr?.toString() || (error.status===undefined && error.code!=='ERR_INVALID_URL' ? error.message : 'Local rollout matrix failed'))
  process.exitCode=1
} finally {
  try {docker(['rm','-f',restName])} catch { /* no test container */ }
  for(const path of generated) {if(existsSync(path)) unlinkSync(path)}
  if(owned) docker(['exec','-e',`PGPASSWORD=${password}`,source,'dropdb','-U','supabase_admin',database])
}
