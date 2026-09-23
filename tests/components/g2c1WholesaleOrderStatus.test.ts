// ─────────────────────────────────────────────────────────────────────────────
// G2-C.1 — el portal mayorista sólo PIDE; la base decide.
//
//   PEDIDO MAYORISTA = ESTADO COMERCIAL. COMPROBANTE = MOVIMIENTO DE STOCK.
//
// El guard estático (scripts/guards/g2c1-wholesale-authority.mjs) mira el
// texto; este test mira el COMPORTAMIENTO de portalService en runtime:
//
//   · updateOrderStatus / updateCustomerStatus: sólo su RPC, con el tenant; sin
//     tocar tablas; sin businessId fallan antes; propagan el rechazo.
//   · createOrder: sólo la RPC de alta, con el slug y, por línea, producto +
//     cantidad. NO manda precio, subtotal, total, nombre, código, estado,
//     negocio ni cliente. Devuelve el pedido canónico del servidor. Traduce el
//     rechazo con un mapa cerrado (el texto del servidor no llega a pantalla).
//
// El borde mockeado es `src/lib/supabase`: cualquier `.from()` queda registrado.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'

const BIZ = '77777777-7777-4777-8777-777777777777'
const ORDER = '88888888-8888-4888-8888-888888888888'
const CUSTOMER = '99999999-9999-4999-8999-999999999999'
const INV_1 = '11111111-1111-4111-8111-111111111111'
const INV_2 = '22222222-2222-4222-8222-222222222222'

const estado = vi.hoisted(() => ({
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  tablas: [] as string[],
  rpcError: null as null | { message: string; code: string },
  portalAbierto: true,
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      estado.rpcs.push({ fn, args })
      if (fn === 'get_wholesale_portal_features') {
        return { data: estado.portalAbierto ? { mayorista: true, active: true } : null, error: null }
      }
      if (estado.rpcError) return { data: null, error: estado.rpcError }
      if (fn === 'create_wholesale_order_atomic') {
        return {
          data: {
            ok: true, order_id: ORDER, order_number: 'PW-0A1B2C3D4E', business_id: BIZ, customer_id: CUSTOMER,
            status: 'pending_whatsapp', subtotal: 8400, total: 8400, notes: null, created_at: '2026-09-23T00:00:00Z',
            items: [
              { inventory_item_id: INV_1, product_name: 'Canónico 1', product_code: 'C-1', quantity: 5, unit_price: 700, subtotal: 3500 },
              { inventory_item_id: INV_2, product_name: 'Canónico 2', product_code: 'C-2', quantity: 4, unit_price: 1225, subtotal: 4900 },
            ],
          },
          error: null,
        }
      }
      if (fn === 'update_wholesale_customer_status_atomic') {
        return {
          data: { ok: true, customer_id: args.p_customer_id, business_id: args.p_business_id,
                  approved: args.p_approved ?? false, suspended: args.p_suspended ?? false,
                  notes: args.p_notes ?? null, changed: true, updated_at: '2026-09-23T00:00:00Z' },
          error: null,
        }
      }
      return {
        data: {
          ok: true, order_id: args.p_order_id, business_id: args.p_business_id,
          status: args.p_status, previous_status: 'pending_whatsapp',
          admin_notes: args.p_admin_notes ?? null, changed: true, updated_at: '2026-09-23T00:00:00Z',
        },
        error: null,
      }
    },
    from: (tabla: string) => {
      estado.tablas.push(tabla)
      throw new Error(`portalService no puede tocar tablas en este flujo (tocó ${tabla})`)
    },
    auth: { getSession: async () => ({ data: { session: null }, error: null }) },
  },
}))

import {
  updateOrderStatus, updateCustomerStatus, createOrder,
  WHOLESALE_ORDER_STATUS_RPC, WHOLESALE_CREATE_ORDER_RPC, WHOLESALE_CUSTOMER_STATUS_RPC,
} from '../../src/portal/services/portalService'

beforeEach(() => {
  estado.rpcs = []
  estado.tablas = []
  estado.rpcError = null
  estado.portalAbierto = true
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

describe('G2-C.1 · createOrder', () => {
  const carrito = [
    // El carrito trae precio, nombre y código: NADA de eso puede viajar.
    { inventoryItemId: INV_1, productName: 'REGALO', productCode: 'FAKE', unitPrice: 1, quantity: 5, stock: 2 },
    { inventoryItemId: INV_2, productName: 'Otro', productCode: 'X', unitPrice: 1, quantity: 4, stock: 10 },
  ]

  it('manda SOLO slug + (producto, cantidad) + notas a la RPC de alta, sin tocar tablas', async () => {
    const { order, error } = await createOrder({ portalSlug: 'clic', items: carrito, notes: '  martes  ' })

    expect(error).toBeNull()
    expect(WHOLESALE_CREATE_ORDER_RPC).toBe('create_wholesale_order_atomic')
    const alta = estado.rpcs.find(r => r.fn === 'create_wholesale_order_atomic')
    expect(alta?.args).toEqual({
      p_portal_slug: 'clic',
      p_items: [
        { inventory_item_id: INV_1, quantity: 5 },
        { inventory_item_id: INV_2, quantity: 4 },
      ],
      p_notes: 'martes',
    })
    expect(JSON.stringify(alta?.args)).not.toMatch(/unit_?[pP]rice|subtotal|total|product_?[nN]ame|product_?[cC]ode|status|business|customer/)
    expect(estado.tablas).toEqual([])

    // Lo que vale es lo que devolvió el servidor, no el carrito.
    expect(order?.total).toBe(8400)
    expect(order?.items.map(i => i.unit_price)).toEqual([700, 1225])
    expect(order?.items[0].product_name).toBe('Canónico 1')
  })

  it('con el portal cerrado no llama al alta', async () => {
    estado.portalAbierto = false
    const { order, error } = await createOrder({ portalSlug: 'clic', items: carrito })
    expect(order).toBeNull()
    expect(error).toMatch(/no está disponible/)
    expect(estado.rpcs.map(r => r.fn)).toEqual(['get_wholesale_portal_features'])
  })

  it('traduce el rechazo con un mapa cerrado: el texto del servidor no llega a la pantalla', async () => {
    estado.rpcError = { message: 'CUSTOMER_NOT_APPROVED', code: '42501' }
    expect((await createOrder({ portalSlug: 'clic', items: carrito })).error).toMatch(/todavía no fue aprobada/)

    estado.rpcError = { message: 'PRODUCT_NOT_AVAILABLE: 1111', code: 'P0002' }
    expect((await createOrder({ portalSlug: 'clic', items: carrito })).error).toMatch(/ya no está disponible/)

    estado.rpcError = { message: 'relation "public.x" violates something at line 3', code: 'XX000' }
    const { error } = await createOrder({ portalSlug: 'clic', items: carrito })
    expect(error).toBe('No se pudo crear el pedido. Intentá de nuevo.')
    expect(estado.tablas).toEqual([])
  })
})

describe('G2-C.1 · updateCustomerStatus', () => {
  it('aprueba por la RPC canónica, con el tenant, sin tocar tablas', async () => {
    const res = await updateCustomerStatus(BIZ, CUSTOMER, { approved: true })
    expect(WHOLESALE_CUSTOMER_STATUS_RPC).toBe('update_wholesale_customer_status_atomic')
    expect(estado.rpcs).toEqual([{
      fn: 'update_wholesale_customer_status_atomic',
      args: { p_business_id: BIZ, p_customer_id: CUSTOMER, p_approved: true, p_suspended: null, p_notes: null },
    }])
    expect(estado.tablas).toEqual([])
    expect(res.approved).toBe(true)
  })

  it('sin businessId falla antes; el rechazo se propaga', async () => {
    await expect(updateCustomerStatus('', CUSTOMER, { suspended: true })).rejects.toThrow(/negocio/)
    expect(estado.rpcs).toEqual([])
    estado.rpcError = { message: 'Forbidden', code: '42501' }
    await expect(updateCustomerStatus(BIZ, CUSTOMER, { suspended: true })).rejects.toThrow('Forbidden')
    expect(estado.tablas).toEqual([])
  })
})
