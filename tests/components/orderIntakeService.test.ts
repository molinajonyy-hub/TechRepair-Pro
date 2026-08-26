import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks=vi.hoisted(()=>(
  { rpc:vi.fn(),upload:vi.fn(),remove:vi.fn() }
))

vi.mock('../../src/lib/supabase',()=>({
  supabase:{
    rpc:mocks.rpc,
    storage:{from:()=>({upload:mocks.upload,remove:mocks.remove})},
  },
}))

import { uploadIntakePhotos } from '../../src/features/order-intake/service'

describe('MOBILE-2A · ciclo de fotos',()=>{
  beforeEach(()=>{
    mocks.rpc.mockReset().mockImplementation(async(name:string,args?:{p_file_name?:string})=>{
      if(name==='get_my_profile')return {data:{business_id:'biz-a'},error:null}
      if(name==='register_order_intake_document'&&args?.p_file_name==='fallida.png')return {data:null,error:{message:'metadata'}}
      return {data:{id:'doc'},error:null}
    })
    mocks.upload.mockReset().mockResolvedValue({error:null})
    mocks.remove.mockReset().mockResolvedValue({error:null})
  })

  it('reporta fallo parcial, conserva la orden y elimina el objeto sin metadata',async()=>{
    const files=[new File(['ok'],'ok.png',{type:'image/png'}),new File(['bad'],'fallida.png',{type:'image/png'})]
    const result=await uploadIntakePhotos('order-a',files)
    expect(result).toEqual({uploaded:1,failed:['fallida.png']})
    expect(mocks.upload).toHaveBeenCalledTimes(2)
    expect(mocks.remove).toHaveBeenCalledTimes(1)
    expect(mocks.remove.mock.calls[0][0][0]).toMatch(/^business\/biz-a\/orders\/order-a\/intake\//)
  })
})
