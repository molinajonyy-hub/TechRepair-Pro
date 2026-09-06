import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  amounts: [] as { id: string; unit_price: number; subtotal: number }[],
  error: null as { message: string } | null,
  selects: [] as { table: string; columns: string }[],
  inserts: [] as unknown[],
}))
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const operational = { id: 'part-1', order_id: 'order-1', code: 'SCREEN', description: 'Screen', quantity: 3, created_at: '2026-09-01' }
      const result = () => table === 'v_parts_used_amounts'
        ? { data: mocks.amounts, error: mocks.error }
        : { data: table === 'orders' ? { id: 'order-1', parts_used: [operational] } : [operational], error: null }
      const chain = {
        select: (columns: string) => { mocks.selects.push({ table, columns }); return chain },
        eq: () => chain,
        in: () => chain,
        insert: (value: unknown) => { mocks.inserts.push(value); return chain },
        single: () => Promise.resolve(table === 'orders' ? result() : { data: operational, error: null }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
      }
      return chain
    },
  },
}))

import { hydratePartsUsedAmounts } from '../../src/services/partsUsedAccess'
import { ordersService, partsService } from '../../src/services/api'

describe('SEC-08E parts data flow', () => {
  beforeEach(() => { mocks.amounts=[]; mocks.error=null; mocks.selects=[]; mocks.inserts=[] })

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
})
