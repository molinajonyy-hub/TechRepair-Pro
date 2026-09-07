import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const state=vi.hoisted(()=>({actor:1,requests:[] as string[]}))
const id=(n:number)=>`e0800000-0000-0000-0000-${String(n).padStart(12,'0')}`
vi.mock('../../src/lib/supabase',async()=>{
  const {createClient}=await import('@supabase/supabase-js')
  const base=process.env.SEC08E_ROLLOUT_URL || 'http://127.0.0.1:1'
  if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw Error('Local Docker REST only')
  const client=createClient(base,'synthetic-local-key',{
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
    global:{fetch:async(input,init)=>{
      const url=String(input).replace('/rest/v1','')
      if(!url.startsWith(base+'/')) throw Error('Non-local request rejected')
      state.requests.push(url)
      const headers=new Headers(init?.headers)
      headers.set('Authorization',`Bearer ${state.actor===1?process.env.SEC08E_ROLLOUT_OWNER:process.env.SEC08E_ROLLOUT_TECH}`)
      return fetch(url,{...init,headers})
    }},
  })
  // Authentication identity only is supplied locally; every table/RPC request
  // below executes against real PostgreSQL with that actor's signed JWT.
  client.auth.getUser=vi.fn(async()=>({data:{user:{id:`e0800000-0000-0000-0000-${String(state.actor).padStart(12,'0')}`}},error:null})) as typeof client.auth.getUser
  return {supabase:client}
})

describe.skipIf(!process.env.SEC08E_ROLLOUT_SCHEMA)('SEC-08E real frontend/schema matrix',()=>{
  type Services=typeof import('../../src/services/api')
  const versions:Record<string,Services>={}
  beforeAll(async()=>{
    for(const [label,file] of Object.entries({old:'sec08eRolloutOld.generated',initial:'sec08eRolloutInitial.generated',final:'api'})) {
      versions[label]=await import(`../../src/services/${file}.ts`) as Services
    }
  })
  afterEach(async()=>{
    // A legacy INSERT can succeed before hydration throws. Clean its witness
    // as the fixture owner, including actors without delete authority.
    state.actor=1
    const {supabase}=await import('../../src/lib/supabase')
    const {error}=await supabase.from('parts_used').delete().eq('code','ROLLOUT')
    if(error) throw error
  })
  for(const actor of [1,2]) for(const version of ['old','initial','final']) {
    it(`${version}, actor ${actor}, schema ${process.env.SEC08E_ROLLOUT_SCHEMA}`,async()=>{
      state.actor=actor
      state.requests=[]
      const {ordersService,partsService}=versions[version]
      const outcomes:Record<string,unknown>={}
      for(const [name,fn] of Object.entries({
        detail:()=>ordersService.getById(id(301)),
        list:()=>partsService.getByOrder(id(301)),
        create:()=>partsService.create({order_id:id(301),business_id:id(101),created_by:id(actor),code:'ROLLOUT',description:'Synthetic rollout part',quantity:2,unit_price:17.25} as Parameters<Services['partsService']['create']>[0]),
        total:()=>partsService.calculateTotal(id(301)),
      })) {
        try {
          const value=await fn()
          const part=name==='detail'?(value as Awaited<ReturnType<Services['ordersService']['getById']>>).parts_used[0]
            :name==='list'?(value as Awaited<ReturnType<Services['partsService']['getByOrder']>>)[0]:value
          outcomes[name]=name==='total'?value:{ok:true,price:part && typeof part==='object' && 'unit_price' in part?part.unit_price:'absent'}
          if(name==='create' && value && typeof value==='object' && 'id' in value) await partsService.delete(String(value.id))
        } catch(error) {outcomes[name]={error:(error as {code?:string}).code || String(error),message:(error as {message?:string}).message}}
      }
      console.log('MATRIX',process.env.SEC08E_ROLLOUT_SCHEMA,version,actor,JSON.stringify(outcomes))
      const pre=process.env.SEC08E_ROLLOUT_SCHEMA==='pre'
      if(version==='old') {
        expect(outcomes.create).toMatchObject({error:'428C9'}) // Existing generated-column bug.
        if(pre) {
          expect(outcomes.detail).toEqual({ok:true,price:7103.19})
          expect(outcomes.list).toEqual({ok:true,price:7103.19})
          expect(outcomes.total).toBe(21309.57) // Includes the original limited-role leak.
        } else for(const flow of ['detail','list','total']) expect(outcomes[flow]).toMatchObject({error:'42501'})
      } else if(version==='initial' && pre) {
        for(const flow of ['detail','list','create']) expect(outcomes[flow]).toMatchObject({error:'PGRST205'})
        if(actor===1) expect(outcomes.total).toMatchObject({error:'PGRST205'})
        else expect(outcomes.total).toBeNull()
      } else {
        const financial=!pre && actor===1
        expect(outcomes.detail).toEqual({ok:true,price:financial?7103.19:'absent'})
        expect(outcomes.list).toEqual({ok:true,price:financial?7103.19:'absent'})
        expect(outcomes.create).toEqual({ok:true,price:financial?17.25:'absent'})
        if(financial) expect(outcomes.total).toBe(21309.57)
        else expect(outcomes.total).toBeNull()
        for(const path of state.requests.filter(url=>url.includes('/parts_used?') && url.includes('select='))) {
          expect(decodeURIComponent(path)).not.toMatch(/select=[^&]*(?:unit_price|subtotal|\*)/)
        }
      }
    })
  }
  it.skipIf(process.env.SEC08E_ROLLOUT_FAULT!=='missing-view')('propagates a missing-view fault on a migrated schema',async()=>{
    // The runner temporarily renames ONLY the view in its disposable database,
    // after the post matrix, and runs this case explicitly.
    state.actor=1
    await expect(versions.final.partsService.getByOrder(id(301))).rejects.toMatchObject({code:'PGRST205'})
    await expect(versions.final.partsService.calculateTotal(id(301))).rejects.toMatchObject({code:'PGRST205'})
  })
})
