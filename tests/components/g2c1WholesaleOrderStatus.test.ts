// ─────────────────────────────────────────────────────────────────────────────
// G2-C.1 — portalService.updateOrderStatus es SOLO una llamada a la RPC.
//
//   PEDIDO MAYORISTA = ESTADO COMERCIAL. COMPROBANTE = MOVIMIENTO DE STOCK.
//
// El guard estático (scripts/guards/g2c1-wholesale-authority.mjs) mira el
// texto; este test mira el COMPORTAMIENTO del servicio en runtime:
//
//   · llama a `update_wholesale_order_status_atomic` con el tenant, el pedido,
//     el estado y las notas — y a nada más;
//   · no toca ninguna tabla (ni wholesale_orders, ni inventory, ni
//     inventory_movements, ni los marcadores de stock);
//   · sin businessId no llama a nada: falla antes;
//   · el error de la RPC se propaga (antes se tragaba).
//
// El borde mockeado es `src/lib/supabase`: cualquier `.from()` queda registrado.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'

const BIZ = '77777777-7777-4777-8777-777777777777'
const ORDER = '88888888-8888-4888-8888-888888888888'

const estado = vi.hoisted(() => ({
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  tablas: [] as string[],
  rpcError: null as null | { message: string; code: string },
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      estado.rpcs.push({ fn, args })
      if (estado.rpcError) return { data: null, error: estado.rpcError }
      return {
        data: {
          ok: true, order_id: args.p_order_id, business_id: args.p_business_id,
          status: args.p_status, previous_status: 'pending_whatsapp',
          admin_notes: args.p_admin_notes ?? null, changed: true, updated_at: '2026-09-22T00:00:00Z',
        },
        error: null,
      }
    },
    from: (tabla: string) => {
      estado.tablas.push(tabla)
      throw new Error(`updateOrderStatus no puede tocar tablas (tocó ${tabla})`)
    },
    auth: { getSession: async () => ({ data: { session: null }, error: null }) },
  },
}))

import { updateOrderStatus, WHOLESALE_ORDER_STATUS_RPC } from '../../src/portal/services/portalService'

beforeEach(() => {
  estado.rpcs = []
  estado.tablas = []
  estado.rpcError = null
})

describe('G2-C.1 · updateOrderStatus', () => {
  it('llama SOLO a la RPC canónica, con el tenant y sin tocar tablas', async () => {
    const res = await updateOrderStatus(BIZ, ORDER, 'approved')

    expect(WHOLESALE_ORDER_STATUS_RPC).toBe('update_wholesale_order_status_atomic')
    expect(estado.rpcs).toEqual([{
      fn: 'update_wholesale_order_status_atomic',
      args: { p_business_id: BIZ, p_order_id: ORDER, p_status: 'approved', p_admin_notes: null },
    }])
    expect(estado.tablas).toEqual([])
    expect(res.status).toBe('approved')
    expect(res.changed).toBe(true)
  })

  it('ningún estado toca inventario: approved, cancelled, rejected, invoiced y delivered son la misma RPC', async () => {
    for (const st of ['approved', 'cancelled', 'rejected', 'invoiced', 'delivered'] as const) {
      await updateOrderStatus(BIZ, ORDER, st)
    }
    expect(estado.rpcs.map(r => r.fn)).toEqual(Array(5).fill('update_wholesale_order_status_atomic'))
    expect(estado.rpcs.map(r => r.args.p_status)).toEqual(['approved', 'cancelled', 'rejected', 'invoiced', 'delivered'])
    // Ni inventory, ni inventory_movements, ni wholesale_order_items.
    expect(estado.tablas).toEqual([])
  })

  it('manda las notas administrativas cuando se dan', async () => {
    await updateOrderStatus(BIZ, ORDER, 'rejected', 'Sin cupo')
    expect(estado.rpcs[0].args.p_admin_notes).toBe('Sin cupo')
  })

  it('sin businessId falla antes de llamar a nada (el bug que dejaba el writer viejo inalcanzable)', async () => {
    await expect(updateOrderStatus('', ORDER, 'approved')).rejects.toThrow(/negocio/)
    expect(estado.rpcs).toEqual([])
    expect(estado.tablas).toEqual([])
  })

  it('propaga el rechazo de la base en vez de tragarlo', async () => {
    estado.rpcError = { message: 'Forbidden', code: '42501' }
    await expect(updateOrderStatus(BIZ, ORDER, 'approved')).rejects.toThrow('Forbidden')
    expect(estado.tablas).toEqual([])
  })
})
