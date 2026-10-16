import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  auth: { businessId: 'a' as string | null, user: { id: 'u' }, profile: { role: 'owner', permissions: {} as Record<string, boolean> } },
  allowed: true,
  fail: false,
  rows: [{ id: 'simple', sale_price: 90 }, { id: 'variant', parent_id: 'parent', sale_price: 70 }],
  calls: [] as { table: string; columns: string; filters: Record<string, unknown> }[],
  pending: null as null | Promise<{ data: unknown[]; error: null }>,
}))
vi.mock('../../src/contexts/AuthContext', () => ({ useAuth: () => h.auth }))
vi.mock('../../src/lib/supabase', () => ({ supabase: {
  rpc: async () => ({ data: h.allowed, error: null }),
  from: (table: string) => {
    const call = { table, columns: '', filters: {} as Record<string, unknown> }
    h.calls.push(call)
    const query = {
      select: (columns: string) => { call.columns = columns; return query },
      eq: (key: string, value: unknown) => { call.filters[key] = value; return query },
      in: (key: string, value: unknown) => { call.filters[key] = value; return query },
      or: () => query, order: () => query, limit: () => query,
      then: (resolve: (value: unknown) => unknown) => {
        if (table === 'inventory') return Promise.resolve({ data: h.rows, error: null }).then(resolve)
        if (h.pending) return h.pending.then(resolve)
        return Promise.resolve({
          data: h.allowed ? [{ inventory_id: 'simple', cost_price: 40, cost_price_usd: 2 }, { inventory_id: 'variant', cost_price: 0, cost_price_usd: null }] : [],
          error: h.fail ? { message: 'offline' } : null,
        }).then(resolve)
      },
    }
    return query
  },
} }))
import { useInventory } from '../../src/hooks/useInventory'

beforeEach(() => {
  h.auth = { businessId: 'a', user: { id: 'u' }, profile: { role: 'owner', permissions: {} } }
  h.allowed = true; h.fail = false; h.pending = null; h.calls = []
})

describe('SEC-08B inventory hydration through server authority', () => {
  it.each([
    ['owner', true], ['admin', true], ['manager', true], ['sales', false],
    ['sales with cost permission', true], ['manager with cost permission revoked', false],
  ])('%s consumes only costs returned by the server', async (role, allowed) => {
    h.auth.profile.role = role
    h.allowed = allowed
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.costStatus).toBe(allowed ? 'ready' : 'restricted'))
    expect(result.current.items[0].cost_price).toBe(allowed ? 40 : null)
    expect(result.current.items[0].cost_price_usd).toBe(allowed ? 2 : null)
    expect(result.current.items[1].cost_price).toBe(allowed ? 0 : null)
    expect(result.current.items[1].cost_price_usd).toBeNull()
    expect(h.calls.find(c => c.table === 'inventory')?.columns).not.toMatch(/cost_price/)
    expect(h.calls.find(c => c.table === 'v_inventory_costs')?.filters.business_id).toBe('a')
  })

  it('clears costs on permission changes and wake-up revalidation', async () => {
    const { result, rerender } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.costStatus).toBe('ready'))
    h.allowed = false
    h.auth.profile.permissions = { inventory_view_costs: false }
    rerender()
    expect(result.current.items.every(i => i.cost_price == null)).toBe(true)
    await waitFor(() => expect(result.current.costStatus).toBe('restricted'))
    h.allowed = true
    await act(async () => { window.dispatchEvent(new Event('app:wake-up')) })
    await waitFor(() => expect(result.current.items[0].cost_price).toBe(40))
  })

  it('keeps operational rows on a cost query error; refresh recovers', async () => {
    h.fail = true
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.costStatus).toBe('error'))
    expect(result.current.items).toHaveLength(2)
    expect(result.current.items[0].cost_price).toBeNull()
    h.fail = false
    await act(async () => { await result.current.refresh() })
    expect(result.current.costStatus).toBe('ready')
  })

  it('does not expose pending old-business costs after a switch or logout', async () => {
    let finish!: (value: { data: unknown[]; error: null }) => void
    h.pending = new Promise(resolve => { finish = resolve })
    const { result, rerender } = renderHook(() => useInventory())
    await waitFor(() => expect(h.calls.some(c => c.table === 'v_inventory_costs')).toBe(true))
    expect(result.current.costStatus).toBe('loading')
    expect(result.current.items[0].cost_price).toBeNull()
    h.pending = null; h.allowed = false; h.auth.businessId = 'b'
    rerender()
    await waitFor(() => expect(result.current.costStatus).toBe('restricted'))
    await act(async () => { finish({ data: [{ inventory_id: 'simple', cost_price: 999, cost_price_usd: 10 }], error: null }) })
    expect(result.current.items[0].cost_price).toBeNull()
    h.auth.businessId = null
    rerender()
    expect(result.current.items).toEqual([])
  })
})
