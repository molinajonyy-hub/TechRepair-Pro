import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  amounts: [] as { id: string; unit_price: number; subtotal: number }[],
  error: null as { code?: string; message: string } | null,
  markerError: null as { code?: string; message: string } | null,
  markerCalls: 0,
  authorized: false as unknown,
  capabilityError: null as { code?: string; message: string } | null,
  legacyError: null as { code?: string; message: string } | null,
  rpcCalls: [] as { name: string; args: unknown }[],
  filters: [] as { table: string; field: string; value: unknown }[],
  selects: [] as { table: string; columns: string }[],
  inserts: [] as unknown[],
}))
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      mocks.rpcCalls.push({ name, args })
      if (name === 'current_user_can_in_business') return Promise.resolve({ data: mocks.authorized, error: mocks.capabilityError })
      mocks.markerCalls++
      return Promise.resolve({ data: false, error: mocks.markerError })
    },
    from: (table: string) => {
      let columns = ''
      const operational = { business_id: 'business-1', id: 'part-1', order_id: 'order-1', code: 'SCREEN', description: 'Screen', quantity: 3, created_at: '2026-09-01' }
      const result = () => table === 'v_parts_used_amounts'
        ? { data: mocks.amounts, error: mocks.error }
        : table === 'parts_used' && /unit_price|subtotal/.test(columns)
          ? { data: [{ id:'part-1',unit_price:71,subtotal:213 }], error: mocks.legacyError }
          : { data: table === 'orders' ? { id: 'order-1', business_id: 'business-1', parts_used: [operational] } : [operational], error: null }
      const chain = {
        select: (selection: string) => { columns=selection; mocks.selects.push({ table, columns }); return chain },
        eq: (field: string, value: unknown) => { mocks.filters.push({ table, field, value }); return chain },
        in: (field: string, value: unknown) => { mocks.filters.push({ table, field, value }); return chain },
        maybeSingle: () => Promise.resolve(result()),
        insert: (value: unknown) => { mocks.inserts.push(value); return chain },
        single: () => Promise.resolve(table === 'orders' ? result() : { data: operational, error: null }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
      }
      return chain
    },
  },
}))

import { hydratePartsUsedAmounts, isPreSec08eSchema } from '../../src/services/partsUsedAccess'
import { ordersService, partsService } from '../../src/services/api'

describe('SEC-08E parts data flow', () => {
  beforeEach(() => { mocks.amounts=[]; mocks.error=null; mocks.markerError=null; mocks.markerCalls=0; mocks.selects=[]; mocks.inserts=[]; mocks.authorized=false; mocks.capabilityError=null; mocks.legacyError=null; mocks.rpcCalls=[]; mocks.filters=[] })

  const missingView={code:'PGRST205',message:"Could not find the table 'public.v_parts_used_amounts' in the schema cache"}
  const missingMarker={code:'PGRST202',message:'Could not find the function public.can_view_payment_allocations(p_business_id) in the schema cache'}

  it('preserves operational data only when both migration objects are absent', async () => {
    mocks.error=missingView
    mocks.markerError=missingMarker
    const part=(await partsService.getByOrder('order-1'))[0]
    expect(part.quantity).toBe(3)
    expect(part).not.toHaveProperty('unit_price')
    expect(part).not.toHaveProperty('subtotal')
    expect(mocks.markerCalls).toBe(1)
    expect(mocks.selects.filter(s=>s.table==='parts_used').every(s=>!s.columns.match(/unit_price|subtotal|\*/))).toBe(true)
  })

  it('propagates a missing view when the migration helper exists', async () => {
    mocks.error=missingView
    await expect(partsService.getByOrder('order-1')).rejects.toEqual(missingView)
  })

  it.each([
    {code:'42501',message:'permission denied'},
    {code:'PGRST301',message:'JWT expired'},
    {code:'PGRST116',message:'No rows'},
    {code:'500',message:'Internal server error'},
    {code:'57014',message:'statement timeout'},
    {code:'PGRST202',message:'Could not find the function public.can_view_payment_allocations(p_business_id) in the schema cache'},
    {code:'42P01',message:'relation does not exist'},
    {code:'08006',message:'connection failure'},
    {code:'XX000',message:'server failure'},
    {code:'',message:'TypeError: Failed to fetch'},
    {code:'PGRST205',message:"Could not find the table 'public.other_view' in the schema cache"},
  ])('propagates real errors without a compatibility probe: $code', async error => {
    mocks.error=error
    await expect(partsService.getByOrder('order-1')).rejects.toEqual(error)
    expect(mocks.markerCalls).toBe(0)
  })

  it('propagates an authorization failure on the deployment probe', async () => {
    mocks.markerError={code:'42501',message:'permission denied'}
    await expect(isPreSec08eSchema(missingView)).rejects.toEqual(mocks.markerError)
  })

  it('keeps the operational order detail and omits restricted amounts', async () => {
    const order = await ordersService.getById('order-1')
    expect(order.parts_used[0]).toMatchObject({ code: 'SCREEN', quantity: 3 })
    expect(order.parts_used[0]).not.toHaveProperty('unit_price')
    expect(order.parts_used[0]).not.toHaveProperty('subtotal')
    const embed = mocks.selects.find(s => s.table === 'orders')!.columns.match(/parts_used\(([^)]+)\)/)![1]
    expect(embed).not.toMatch(/\*|unit_price|subtotal/)
  })

  it('hydrates authorized real values, including a real zero', async () => {
    mocks.amounts=[{ id:'part-1',unit_price:0,subtotal:0 }]
    expect((await partsService.getByOrder('order-1'))[0]).toMatchObject({ unit_price:0,subtotal:0 })
    expect(mocks.selects.find(s=>s.table==='parts_used')!.columns).not.toMatch(/\*|unit_price|subtotal/)
  })

  it('discards a stale financial value after authority is withdrawn', async () => {
    const [part] = await hydratePartsUsedAmounts([{ id:'part-1',order_id:'order-1',code:'X',description:'Part',quantity:3,unit_price:71,subtotal:213,created_at:'' }])
    expect(part).not.toHaveProperty('unit_price')
    expect(part).not.toHaveProperty('subtotal')
    expect(part.quantity).toBe(3)
  })

  it('does not treat a failed projection as zero cost', async () => {
    mocks.error={message:'projection unavailable'}
    await expect(partsService.getByOrder('order-1')).rejects.toEqual(mocks.error)
  })

  it('preserves insert returning without requesting generated or restricted columns', async () => {
    const created = await partsService.create({order_id:'order-1',code:'SCREEN',description:'Screen',quantity:3,unit_price:71})
    expect(created.code).toBe('SCREEN')
    expect(created).not.toHaveProperty('unit_price')
    expect(mocks.inserts[0]).not.toHaveProperty('subtotal')
    expect(mocks.selects.find(s=>s.table==='parts_used')!.columns).not.toMatch(/\*|unit_price|subtotal/)
  })

  const legacyReads = () => mocks.selects.filter(s => s.table === 'parts_used' && /unit_price|subtotal/.test(s.columns))
  const preSchema = () => { mocks.error=missingView; mocks.markerError=missingMarker }

  it('preserves authorized pre-schema detail/list/create prices and exact total with scoped reads', async () => {
    preSchema()
    mocks.authorized=true
    const detail = await ordersService.getById('order-1')
    const parts = await partsService.getByOrder('order-1')
    const created = await partsService.create({ order_id:'order-1',code:'SCREEN',description:'Screen',quantity:3,unit_price:71 })
    for (const part of [detail.parts_used[0], parts[0], created]) expect(part).toMatchObject({ unit_price:71,subtotal:213 })
    expect(await partsService.calculateTotal('order-1')).toBe(213)
    expect(legacyReads().map(s => s.columns)).toEqual(['id, unit_price, subtotal','id, unit_price, subtotal','id, unit_price, subtotal','subtotal'])
    expect(mocks.rpcCalls.filter(c => c.name === 'current_user_can_in_business')).toEqual(Array(4).fill({
      name:'current_user_can_in_business',args:{p_business_id:'business-1',p_key:'orders_view_financials'},
    }))
    expect(mocks.filters.filter(f => f.table === 'parts_used' && f.field === 'business_id')).toHaveLength(4)
    expect(mocks.filters).toContainEqual({table:'parts_used',field:'id',value:['part-1']})
    expect(mocks.filters).toContainEqual({table:'parts_used',field:'order_id',value:'order-1'})
    expect(mocks.inserts[0]).not.toHaveProperty('subtotal')
  })

  it.each([false, null, undefined, 'true', 1])('requires literal backend true; %s never reads legacy money', async authorized => {
    preSchema()
    mocks.authorized=authorized
    const part = (await partsService.getByOrder('order-1'))[0]
    expect(part).not.toHaveProperty('unit_price')
    expect(part).not.toHaveProperty('subtotal')
    expect(await partsService.calculateTotal('order-1')).toBeNull()
    expect(legacyReads()).toEqual([])
    // Limited total never even selects projected subtotal.
    expect(mocks.selects.filter(s => s.columns === 'subtotal')).toEqual([])
  })

  it('post-schema uses only the projection even if the helper is missing', async () => {
    mocks.authorized=true
    mocks.markerError=missingMarker
    mocks.amounts=[{id:'part-1',unit_price:71,subtotal:213}]
    expect((await partsService.getByOrder('order-1'))[0].unit_price).toBe(71)
    expect(await partsService.calculateTotal('order-1')).toBe(213)
    expect(mocks.markerCalls).toBe(0)
    expect(legacyReads()).toEqual([])
  })

  it.each([
    {code:'42501',message:'permission denied'},
    {code:'PGRST116',message:'No rows'},
    {code:'500',message:'Internal server error'},
    {code:'57014',message:'statement timeout'},
    {code:'',message:'TypeError: Failed to fetch'},
    {code:'PGRST205',message:'A different missing table message'},
  ])('authorized total propagates $code without legacy access', async error => {
    mocks.authorized=true
    mocks.error=error
    mocks.markerError=missingMarker
    await expect(partsService.calculateTotal('order-1')).rejects.toEqual(error)
    expect(legacyReads()).toEqual([])
    expect(mocks.markerCalls).toBe(0)
  })

  it('missing view with an existing helper fails closed for authorized list and total', async () => {
    mocks.authorized=true
    mocks.error=missingView
    await expect(partsService.getByOrder('order-1')).rejects.toEqual(missingView)
    await expect(partsService.calculateTotal('order-1')).rejects.toEqual(missingView)
    expect(legacyReads()).toEqual([])
  })

  it('propagates capability failures instead of treating them as authorization or missing schema', async () => {
    preSchema()
    mocks.capabilityError={code:'42501',message:'permission denied'}
    await expect(partsService.getByOrder('order-1')).rejects.toEqual(mocks.capabilityError)
    await expect(partsService.calculateTotal('order-1')).rejects.toEqual(mocks.capabilityError)
    expect(legacyReads()).toEqual([])
  })

  it('propagates a legacy read failure, including a lockdown racing the read', async () => {
    preSchema()
    mocks.authorized=true
    mocks.legacyError={code:'42501',message:'permission denied'}
    await expect(partsService.getByOrder('order-1')).rejects.toEqual(mocks.legacyError)
    await expect(partsService.calculateTotal('order-1')).rejects.toEqual(mocks.legacyError)
  })

  it('refuses legacy reads without the operational row business', async () => {
    preSchema()
    mocks.authorized=true
    await expect(hydratePartsUsedAmounts([{id:'part-1',order_id:'order-1',code:'X',description:'X',quantity:1,created_at:''}])).rejects.toThrow('Falta el negocio')
    expect(legacyReads()).toEqual([])
  })

  it('checks each business independently rather than reusing one tenant authorization', async () => {
    preSchema()
    await hydratePartsUsedAmounts(['business-1','business-2'].map((business_id, i) => ({business_id,id:`part-${i}`,order_id:'order-1',code:'X',description:'X',quantity:1,created_at:''})))
    expect(mocks.rpcCalls.filter(c => c.name === 'current_user_can_in_business').map(c => c.args)).toEqual([
      {p_business_id:'business-1',p_key:'orders_view_financials'}, {p_business_id:'business-2',p_key:'orders_view_financials'},
    ])
    expect(legacyReads()).toEqual([])
  })
})
