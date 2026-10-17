// H01: servicio y carrito reales; Supabase y contexto del cliente son los bordes.
// No usa red ni datos reales. Los importes canónicos sólo salen de la RPC.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { CartItem, PortalBusiness, WholesaleCustomer } from '../../src/portal/types'

const BIZ = '11111111-1111-4111-8111-111111111111'
const CUSTOMER = '22222222-2222-4222-8222-222222222222'
const ORDER = '33333333-3333-4333-8333-333333333333'
const PRODUCT = '44444444-4444-4444-8444-444444444444'
const PRIVATE = 'private-customer@example.test confidential-payload'

interface DbError { code: string; message: string; details?: string; hint?: string }
interface DbResponse { data: unknown; error: DbError | null }

const mocks = vi.hoisted(() => ({
  from: vi.fn(), insert: vi.fn<() => Promise<DbResponse>>(),
  rpc: vi.fn<(name: string, args?: Record<string, unknown>) => Promise<DbResponse>>(),
  warn: vi.fn(), clearCart: vi.fn(),
  items: [] as CartItem[],
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: { from: mocks.from, rpc: mocks.rpc },
}))
vi.mock('../../src/lib/logger', () => ({ logger: { warn: mocks.warn } }))
vi.mock('../../src/portal/contexts/PortalContext', () => ({
  usePortal: () => ({
    business, customer, basePath: '/mayorista/h01',
    authLoading: false, bizLoading: false, setCustomer: vi.fn(),
  }),
}))
vi.mock('../../src/portal/hooks/usePortalCart', () => ({
  usePortalCart: () => ({
    items: mocks.items, total: 1, itemCount: mocks.items.length,
    updateQty: vi.fn(), removeItem: vi.fn(), clearCart: mocks.clearCart,
  }),
}))

import { trackEvent } from '../../src/portal/services/portalService'
import { PortalCart } from '../../src/portal/pages/PortalCart'

const business: PortalBusiness = {
  id: BIZ, name: 'Negocio sintético H01', logo_url: null,
  wholesale_portal_enabled: true, wholesale_portal_slug: 'h01',
  wholesale_whatsapp: '+54 11 5555 0000', wholesale_portal_theme: null,
}
const customer: WholesaleCustomer = {
  id: CUSTOMER, business_id: BIZ, auth_user_id: '55555555-5555-4555-8555-555555555555',
  name: 'Cliente sintético H01', business_name: 'Taller sintético', email: 'h01@example.test',
  whatsapp: '1155550001', whatsapp_verified: true, province: null, city: null, instagram: null,
  approved: true, suspended: false, notes: null, tags: null, last_login: null,
  last_order_at: null, total_orders: 0, total_spent: 0, created_at: '', updated_at: '',
}
const confirmedOrder = {
  ok: true, order_id: ORDER, order_number: 'PW-H01', business_id: BIZ, customer_id: CUSTOMER,
  status: 'pending_whatsapp', subtotal: 8400, total: 8400, notes: null,
  created_at: '2026-10-17T00:00:00Z',
  items: [{
    inventory_item_id: PRODUCT, product_name: 'Producto canónico H01', product_code: 'H01',
    quantity: 2, unit_price: 4200, subtotal: 8400,
  }],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  mocks.from.mockReset().mockReturnValue({ insert: mocks.insert })
  mocks.insert.mockReset().mockResolvedValue({ data: null, error: null })
  mocks.warn.mockReset()
  mocks.clearCart.mockReset().mockImplementation(() => { mocks.items = [] })
  mocks.items = [{
    inventoryItemId: PRODUCT, productName: 'Precio orientativo H01', productCode: 'H01',
    unitPrice: 1, quantity: 2, stock: 10,
  }]
  mocks.rpc.mockReset().mockImplementation(async name => ({
    data: name === 'get_wholesale_portal_features'
      ? { active: true, mayorista: true } : confirmedOrder,
    error: null,
  }))
  vi.spyOn(window, 'open').mockReturnValue(null)
})

describe('H01 · trackEvent', () => {
  it('conserva el INSERT legítimo y el contrato Promise<void> sin consultas adicionales', async () => {
    await expect(trackEvent(BIZ, 'whatsapp_order', CUSTOMER, { order_id: ORDER, total: 8400 }))
      .resolves.toBeUndefined()
    expect(mocks.from.mock.calls).toEqual([['customer_events']])
    expect(mocks.insert.mock.calls).toEqual([[{
      business_id: BIZ, event_type: 'whatsapp_order', customer_id: CUSTOMER,
      metadata: { order_id: ORDER, total: 8400 },
    }]])
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.warn).not.toHaveBeenCalled()
  })

  it.each([
    ['42501', 'denied'], ['23514', 'invalid-event'], [PRIVATE, 'insert-failed'],
  ])('registra el rechazo %s mediante un código cerrado, sin PII', async (dbCode, safeCode) => {
    mocks.insert.mockResolvedValue({
      data: null, error: { code: dbCode, message: PRIVATE, details: PRIVATE, hint: PRIVATE },
    })
    await expect(trackEvent(BIZ, PRIVATE, CUSTOMER, { secret: PRIVATE })).resolves.toBeUndefined()
    expect(mocks.warn.mock.calls).toEqual([[
      'SUPABASE', 'portal: no se pudo registrar el evento', { code: safeCode },
    ]])
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(PRIVATE)
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toMatch(new RegExp(`${BIZ}|${CUSTOMER}`))
  })

  it.each(['promise-rejection', 'synchronous-throw'])('absorbe %s sin registrar su contenido', async mode => {
    if (mode === 'promise-rejection') mocks.insert.mockRejectedValue(new Error(PRIVATE))
    else mocks.from.mockImplementation(() => { throw new Error(PRIVATE) })
    await expect(trackEvent(BIZ, 'whatsapp_order', CUSTOMER, { secret: PRIVATE })).resolves.toBeUndefined()
    expect(mocks.warn.mock.calls).toEqual([[
      'SUPABASE', 'portal: no se pudo registrar el evento', { code: 'unexpected-failure' },
    ]])
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(PRIVATE)
  })

  it('un logger fallido tampoco rechaza el servicio', async () => {
    mocks.insert.mockRejectedValue(new Error(PRIVATE))
    mocks.warn.mockImplementation(() => { throw new Error(PRIVATE) })
    await expect(trackEvent(BIZ, 'whatsapp_order', CUSTOMER)).resolves.toBeUndefined()
  })
})

describe('H01 · pedido confirmado en el carrito real', () => {
  it.each(['success', 'returned-error', 'rejected', 'pending', 'late-rejection'])(
    '%s en telemetría conserva éxito, limpieza única y WhatsApp con los datos del servidor', async mode => {
      const telemetry = deferred<DbResponse>()
      if (mode === 'returned-error') mocks.insert.mockResolvedValue({ data: null, error: { code: '42501', message: PRIVATE } })
      if (mode === 'rejected') mocks.insert.mockRejectedValue(new Error(PRIVATE))
      if (mode === 'pending' || mode === 'late-rejection') mocks.insert.mockReturnValue(telemetry.promise)

      // La pantalla sigue esperando únicamente la confirmación canónica del pedido.
      const order = deferred<DbResponse>()
      mocks.rpc.mockImplementation(async name => name === 'get_wholesale_portal_features'
        ? { data: { active: true, mayorista: true }, error: null } : order.promise)
      render(<MemoryRouter><PortalCart /></MemoryRouter>)
      const send = screen.getByRole('button', { name: /Enviar pedido por WhatsApp/ }) as HTMLButtonElement
      fireEvent.change(screen.getByPlaceholderText('Aclaraciones sobre el pedido, envío, etc.'), {
        target: { value: 'Nota sintética H01' },
      })
      fireEvent.click(send)
      await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('create_wholesale_order_atomic', {
        p_portal_slug: 'h01', p_items: [{ inventory_item_id: PRODUCT, quantity: 2 }],
        p_notes: 'Nota sintética H01',
      }))
      expect(send.disabled).toBe(true)
      fireEvent.click(send)
      expect(mocks.insert).not.toHaveBeenCalled()
      expect(mocks.clearCart).not.toHaveBeenCalled()
      expect(window.open).not.toHaveBeenCalled()

      await act(async () => { order.resolve({ data: confirmedOrder, error: null }) })
      expect(await screen.findByRole('heading', { name: '¡Pedido enviado!' })).toBeTruthy()
      expect(screen.getByText('PW-H01')).toBeTruthy()
      expect(screen.queryByRole('button', { name: /Enviar pedido por WhatsApp/ })).toBeNull()
      expect(document.body.textContent).not.toContain(PRIVATE)
      expect(mocks.insert.mock.calls).toEqual([[{
        business_id: BIZ, customer_id: CUSTOMER, event_type: 'whatsapp_order',
        metadata: { order_id: ORDER, total: 8400 },
      }]])
      expect(mocks.clearCart).toHaveBeenCalledTimes(1)
      expect(window.open).toHaveBeenCalledTimes(1)
      const [url, target] = vi.mocked(window.open).mock.calls[0]
      expect(target).toBe('_blank')
      const whatsapp = new URL(String(url))
      expect(whatsapp.origin + whatsapp.pathname).toBe('https://wa.me/541155550000')
      expect(whatsapp.searchParams.get('text')).toContain('Producto canónico H01 — $8.400')
      expect(whatsapp.searchParams.get('text')).toContain('Total estimado: $8.400')
      expect(whatsapp.searchParams.get('text')).toContain('Nota sintética H01')

      if (mode === 'late-rejection') {
        await act(async () => { telemetry.reject(new Error(PRIVATE)) })
        expect(mocks.warn).toHaveBeenCalledWith(
          'SUPABASE', 'portal: no se pudo registrar el evento', { code: 'unexpected-failure' },
        )
      }
      expect(mocks.rpc.mock.calls.filter(([name]) => name === 'create_wholesale_order_atomic')).toHaveLength(1)
      expect(mocks.clearCart).toHaveBeenCalledTimes(1)
      expect(window.open).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('heading', { name: '¡Pedido enviado!' })).toBeTruthy()
    },
  )

  it('un pedido rechazado por el servidor no emite evento ni limpia ni abre WhatsApp', async () => {
    mocks.rpc.mockImplementation(async name => name === 'get_wholesale_portal_features'
      ? { data: { active: true, mayorista: true }, error: null }
      : { data: null, error: { code: '42501', message: `CUSTOMER_NOT_APPROVED ${PRIVATE}` } })
    render(<MemoryRouter><PortalCart /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: /Enviar pedido por WhatsApp/ }))
    expect(await screen.findByText(/Tu cuenta todavía no fue aprobada/)).toBeTruthy()
    expect(document.body.textContent).not.toContain(PRIVATE)
    expect(mocks.insert).not.toHaveBeenCalled()
    expect(mocks.clearCart).not.toHaveBeenCalled()
    expect(window.open).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: /Enviar pedido por WhatsApp/ }) as HTMLButtonElement).disabled).toBe(false)
  })
})
