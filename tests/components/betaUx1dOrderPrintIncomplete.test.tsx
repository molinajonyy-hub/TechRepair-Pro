// ─────────────────────────────────────────────────────────────────────────────
// BETA-UX-1D (microfix) · imprimir una orden con información incompleta.
//
// `OrderListItem` modela `customer` y `device` como `| null`, pero la hoja
// (`ServiceOrderPrint`) leía `order.customer.name` y `order.device.brand` sin
// guarda. Imprimir desde la lista una orden sin cliente o sin equipo lanzaba en
// el render y caía en el error boundary global: «Algo salió mal». El defecto era
// anterior, pero 1D puso «Imprimir» en el menú de cada tarjeta mobile.
//
// La orden se sigue pudiendo imprimir. Lo que se fija acá:
//   · la hoja renderiza con cliente nulo, equipo nulo, los dos nulos, o con la
//     propiedad directamente ausente;
//   · dice «Sin cliente» / «Sin dispositivo» en las DOS copias, y no inventa
//     ninguna otra fila (ni teléfono, ni DNI, ni tipo);
//   · con datos parciales imprime los que hay y omite los que no;
//   · nunca aparece «undefined» ni «null» en el papel;
//   · desde Órdenes, con la hoja REAL montada, «Imprimir» del menú de la tarjeta
//     no rompe la pantalla;
//   · la vista previa del detalle usa el mismo texto en vez de un guion.
// ─────────────────────────────────────────────────────────────────────────────
import { Component, type ReactNode } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrderListItem } from '../../src/hooks/useOrders'
import type { OrderDetailSimple } from '../../src/hooks/useOrderSimple'

const state = vi.hoisted(() => ({ orders: [] as unknown[] }))

vi.mock('../../src/contexts/AuthContext', () => ({ useAuth: () => ({ businessId: 'biz-1' }) }))
vi.mock('../../src/hooks/useOrders', () => ({
  useOrders: () => ({
    orders: state.orders, loading: false, error: null, total: state.orders.length,
    financial: {}, financialError: false, amountsAuthorized: true, refresh: vi.fn(),
  }),
}))
// La configuración de impresión es la de fábrica: lo que se mide es la orden.
vi.mock('../../src/hooks/useOrderPrintSettings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/hooks/useOrderPrintSettings')>()
  return { ...actual, useOrderPrintSettings: () => ({ settings: actual.DEFAULT_PRINT_SETTINGS }) }
})
vi.mock('../../src/lib/orderLineAmounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/orderLineAmounts')>()
  return { ...actual, fetchOrderLineAmounts: async () => ({ authorized: false, rows: [] }) }
})
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }),
      delete: () => ({ eq: async () => ({ error: null }) }),
    }),
  },
}))

import { ServiceOrderPrint, type ServiceOrderData } from '../../src/components/print/ServiceOrderPrint'
import { OrderPrintPreviewModal } from '../../src/components/print/OrderPrintPreviewModal'
import { DEFAULT_PRINT_SETTINGS } from '../../src/hooks/useOrderPrintSettings'
import { Orders } from '../../src/pages/Orders'

const BASE = {
  id: 'abc12345-0000-0000-0000-000000000000',
  created_at: '2026-10-08T15:00:00Z',
  status: 'new',
}
const CUSTOMER = { name: 'Cliente Demo', phone: '3512345678' }
const DEVICE = { type: 'smartphone', brand: 'Samsung', model: 'A04e' }

function renderSheet(order: Partial<ServiceOrderData>) {
  // Si el render lanzara, `render` propagaría el error y el test fallaría acá.
  return render(<ServiceOrderPrint order={{ ...BASE, ...order } as ServiceOrderData} printSettings={DEFAULT_PRINT_SETTINGS} />).container
}

const copia = (container: HTMLElement, cual: 'client' | 'local') =>
  container.querySelector(`[data-testid="service-order-${cual}-copy"]`) as HTMLElement

/** Nada con forma de valor ausente llega al papel. */
function sinValoresFantasma(container: HTMLElement) {
  expect(container.textContent).not.toMatch(/undefined/)
  expect(container.textContent).not.toMatch(/\bnull\b/)
  expect(container.textContent).not.toMatch(/\[object Object\]/)
  expect(container.textContent).not.toMatch(/NaN/)
}

/** La hoja está entera: las dos copias, con su encabezado. */
function hojaCompleta(container: HTMLElement) {
  expect(container.querySelector('[data-testid="service-order-print-root"]')).not.toBeNull()
  expect(container.textContent).toContain('COPIA CLIENTE')
  expect(container.textContent).toContain('USO INTERNO')
  expect(container.textContent).toContain('N° ABC12345')
}

describe('BETA-UX-1D · la hoja de la orden tolera cliente y equipo ausentes', () => {
  it('A · sin cliente, con equipo: «Sin cliente» en las dos copias y el equipo impreso', () => {
    const container = renderSheet({ customer: null, device: DEVICE })

    hojaCompleta(container)
    sinValoresFantasma(container)
    expect(within(container).getAllByTestId('service-order-no-customer')).toHaveLength(2)
    for (const cual of ['client', 'local'] as const) {
      const c = copia(container, cual)
      expect(within(c).getByTestId('service-order-no-customer')).toHaveTextContent('Sin cliente')
      // No se inventa ninguna otra fila del cliente.
      expect(c.textContent).not.toMatch(/Teléfono:|DNI:|Email:|Dirección:/)
      // El equipo, que sí existe, sale completo.
      expect(c.textContent).toContain('Samsung A04e')
      expect(c.textContent).toContain('Celular')
    }
    expect(within(container).queryByTestId('service-order-no-device')).toBeNull()
  })

  it('B · con cliente, sin equipo: «Sin dispositivo» en las dos copias y el cliente impreso', () => {
    const container = renderSheet({ customer: CUSTOMER, device: null })

    hojaCompleta(container)
    sinValoresFantasma(container)
    expect(within(container).getAllByTestId('service-order-no-device')).toHaveLength(2)
    for (const cual of ['client', 'local'] as const) {
      const c = copia(container, cual)
      expect(within(c).getByTestId('service-order-no-device')).toHaveTextContent('Sin dispositivo')
      // Ningún dato del equipo fabricado.
      expect(c.textContent).not.toMatch(/Tipo:|Color:|IMEI:|Serie:|Accesorios:|Estado estético:/)
      expect(c.textContent).toContain('Cliente Demo')
      expect(c.textContent).toContain('3512345678')
    }
    expect(within(container).queryByTestId('service-order-no-customer')).toBeNull()
  })

  it('C · sin cliente y sin equipo: la hoja se imprime igual, con los dos avisos', () => {
    const container = renderSheet({ customer: null, device: null })

    hojaCompleta(container)
    sinValoresFantasma(container)
    expect(within(container).getAllByTestId('service-order-no-customer')).toHaveLength(2)
    expect(within(container).getAllByTestId('service-order-no-device')).toHaveLength(2)
    // El resto de la hoja sigue en su lugar.
    expect(container.textContent).toContain('Falla Reportada')
    expect(container.textContent).toContain('Sin descripción')
    expect(container.textContent).toContain('Checklist técnico')
    expect(container.textContent).toContain('Firma del cliente')
  })

  it('con las propiedades directamente AUSENTES se comporta igual que con null', () => {
    const container = renderSheet({})

    hojaCompleta(container)
    sinValoresFantasma(container)
    expect(within(container).getAllByTestId('service-order-no-customer')).toHaveLength(2)
    expect(within(container).getAllByTestId('service-order-no-device')).toHaveLength(2)
  })

  it.each([
    ['objetos vacíos', {}, {}],
    ['campos en null', { name: null, phone: null, dni: null, email: null, address: null }, { type: null, brand: null, model: null, imei: null }],
    ['cadenas vacías', { name: '', phone: '' }, { brand: '', model: '', type: '' }],
  ])('un cliente y un equipo sin nada imprimible (%s) también dicen «Sin …»', (_caso, customer, device) => {
    const container = renderSheet({ customer, device } as Partial<ServiceOrderData>)

    sinValoresFantasma(container)
    expect(within(container).getAllByTestId('service-order-no-customer')).toHaveLength(2)
    expect(within(container).getAllByTestId('service-order-no-device')).toHaveLength(2)
  })
})

describe('BETA-UX-1D · con datos parciales imprime los que hay y omite los que no', () => {
  it('cliente con nombre y sin teléfono: no aparece la etiqueta «Teléfono»', () => {
    const container = renderSheet({ customer: { name: 'Solo Nombre' }, device: DEVICE })

    sinValoresFantasma(container)
    const cliente = copia(container, 'client')
    expect(cliente.textContent).toContain('Solo Nombre')
    expect(cliente.textContent).not.toMatch(/Teléfono:|Email:|Dirección:/)
    expect(within(container).queryByTestId('service-order-no-customer')).toBeNull()
  })

  it('cliente con teléfono y sin nombre: imprime el teléfono y NO dice «Sin cliente»', () => {
    const container = renderSheet({ customer: { name: null, phone: '3519998877' }, device: DEVICE })

    sinValoresFantasma(container)
    expect(copia(container, 'client').textContent).toContain('3519998877')
    expect(copia(container, 'client').textContent).not.toMatch(/Nombre:/)
    expect(within(container).queryByTestId('service-order-no-customer')).toBeNull()
  })

  it('equipo con marca y sin modelo: imprime la marca, sin «undefined» pegado', () => {
    const container = renderSheet({ customer: CUSTOMER, device: { brand: 'Motorola' } })

    sinValoresFantasma(container)
    for (const cual of ['client', 'local'] as const) {
      expect(copia(container, cual).textContent).toContain('Dispositivo:Motorola')
      expect(copia(container, cual).textContent).not.toMatch(/Tipo:|IMEI:/)
    }
    expect(within(container).queryByTestId('service-order-no-device')).toBeNull()
  })

  it('equipo sin marca ni modelo pero con IMEI: imprime el IMEI y NO dice «Sin dispositivo»', () => {
    const container = renderSheet({ customer: CUSTOMER, device: { imei: '490154203237518', type: 'tablet' } })

    sinValoresFantasma(container)
    const local = copia(container, 'local')
    expect(local.textContent).toContain('490154203237518')
    expect(local.textContent).toContain('Tablet')
    expect(local.textContent).not.toMatch(/Dispositivo:/)
    expect(within(container).queryByTestId('service-order-no-device')).toBeNull()
  })

  it('una orden completa se imprime como antes', () => {
    const container = renderSheet({
      customer: { name: 'Cliente Demo', phone: '3512345678', dni: '30123456', email: 'demo@example.test', address: 'Calle 123' },
      device: { type: 'smartphone', brand: 'Samsung', model: 'A04e', imei: '490154203237518', serial: 'SER-1', color: 'Negro', accessories: 'Funda', aesthetic_condition: 'Rayado' },
      reported_issue: 'No carga',
    })

    sinValoresFantasma(container)
    const cliente = copia(container, 'client')
    for (const texto of ['Nombre:Cliente Demo', 'Teléfono:3512345678', 'DNI:30123456', 'Email:demo@example.test', 'Dirección:Calle 123',
      'Dispositivo:Samsung A04e', 'Tipo:Celular', 'Color:Negro', 'IMEI:490154203237518', 'Serie:SER-1', 'Accesorios:Funda', 'No carga']) {
      expect(cliente.textContent, texto).toContain(texto)
    }
    // El estado estético es sólo de la copia interna, como antes.
    expect(cliente.textContent).not.toContain('Estado estético')
    expect(copia(container, 'local').textContent).toContain('Estado estético:Rayado')
    expect(within(container).queryByTestId('service-order-no-customer')).toBeNull()
    expect(within(container).queryByTestId('service-order-no-device')).toBeNull()
  })

  it('la copia interna conserva «DNI: —» para un cliente que existe pero no lo tiene', () => {
    const container = renderSheet({ customer: CUSTOMER, device: DEVICE })

    expect(copia(container, 'local').textContent).toContain('DNI:—')
    // En la copia del cliente esa fila nunca se imprimió vacía.
    expect(copia(container, 'client').textContent).not.toMatch(/DNI:/)
  })
})

// ── Desde Órdenes, con la hoja REAL ─────────────────────────────────────────
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    return this.state.error ? <div role="alert" data-testid="crash">{this.state.error.message}</div> : this.props.children
  }
}

const orden = (id: string, over: Partial<OrderListItem>): OrderListItem => ({
  id, status: 'new', priority: 'low', created_at: '2026-10-08T15:00:00Z',
  customer: { id: 'c1', name: 'Cliente Uno', phone: '3510000001' },
  device: { id: 'd1', brand: 'Samsung', model: 'A04e', type: 'smartphone' },
  ...over,
})

const SIN_EQUIPO = orden('aaaaaaaa-0000-0000-0000-000000000001', { device: null })
const SIN_CLIENTE = orden('bbbbbbbb-0000-0000-0000-000000000002', { customer: null })
const SIN_NADA = orden('cccccccc-0000-0000-0000-000000000003', { customer: null, device: null })

function renderOrders() {
  return render(
    <MemoryRouter initialEntries={['/orders']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Boundary><Orders /></Boundary>
    </MemoryRouter>,
  )
}

describe('BETA-UX-1D · «Imprimir» de la tarjeta mobile no rompe la pantalla', () => {
  beforeEach(() => {
    state.orders = [SIN_EQUIPO, SIN_CLIENTE, SIN_NADA]
    vi.stubGlobal('open', vi.fn(() => null))
  })

  it.each([
    ['sin dispositivo', SIN_EQUIPO, { cliente: 'Cliente Uno', sinCliente: 0, sinEquipo: 2 }],
    ['sin cliente', SIN_CLIENTE, { cliente: null, sinCliente: 2, sinEquipo: 0 }],
    ['sin cliente ni dispositivo', SIN_NADA, { cliente: null, sinCliente: 2, sinEquipo: 2 }],
  ])('una orden %s se imprime desde el menú de su tarjeta', (_caso, order, esperado) => {
    renderOrders()
    const lista = within(screen.getByTestId('orders-mobile-list'))

    fireEvent.click(lista.getByRole('button', { name: `Acciones de la orden #${order.id.slice(0, 8)}` }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Imprimir' }))

    // No hubo error de render: la pantalla sigue ahí.
    expect(screen.queryByTestId('crash')).not.toBeInTheDocument()
    expect(screen.getByTestId('orders-mobile-list')).toBeInTheDocument()

    const hoja = within(screen.getByTestId('order-print-hidden-root'))
    expect(hoja.getByTestId('service-order-print-root')).toBeInTheDocument()
    expect(hoja.queryAllByTestId('service-order-no-customer')).toHaveLength(esperado.sinCliente)
    expect(hoja.queryAllByTestId('service-order-no-device')).toHaveLength(esperado.sinEquipo)
    const texto = screen.getByTestId('order-print-hidden-root').textContent ?? ''
    expect(texto).toContain(`N° ${order.id.slice(0, 8).toUpperCase()}`)
    expect(texto).not.toMatch(/undefined|\bnull\b/)
    if (esperado.cliente) expect(texto).toContain(esperado.cliente)
  })

  it('el botón de imprimir de la tabla de escritorio tampoco rompe con esas órdenes', () => {
    renderOrders()
    const tabla = within(screen.getByTestId('orders-desktop-table'))
    const fila = tabla.getAllByRole('row').find(row => row.textContent?.includes('#cccccccc'))!

    fireEvent.click(within(fila).getByTestId('order-print-button'))

    expect(screen.queryByTestId('crash')).not.toBeInTheDocument()
    const hoja = within(screen.getByTestId('order-print-hidden-root'))
    expect(hoja.getAllByTestId('service-order-no-customer')).toHaveLength(2)
    expect(hoja.getAllByTestId('service-order-no-device')).toHaveLength(2)
  })
})

// ── La vista previa del detalle ─────────────────────────────────────────────
describe('BETA-UX-1D · la vista previa del detalle usa el mismo texto', () => {
  const detalle = (over: Partial<OrderDetailSimple>): OrderDetailSimple => ({
    ...BASE, priority: 'medium', amountsAuthorized: false,
    customer_id: null, device_id: null, updated_at: BASE.created_at, history: [],
    ...over,
  } as unknown as OrderDetailSimple)

  it('sin cliente ni equipo dice «Sin cliente» / «Sin dispositivo», no un guion de relleno', async () => {
    render(<OrderPrintPreviewModal isOpen onClose={vi.fn()} order={detalle({})} />)

    const hoja = await screen.findByTestId('service-order-print-root')
    expect(within(hoja).getAllByTestId('service-order-no-customer')).toHaveLength(2)
    expect(within(hoja).getAllByTestId('service-order-no-device')).toHaveLength(2)
    expect(hoja.textContent).not.toContain('Nombre:—')
    expect(hoja.textContent).not.toMatch(/undefined|\bnull\b/)
  })

  it('con cliente y equipo los imprime', async () => {
    render(<OrderPrintPreviewModal isOpen onClose={vi.fn()} order={detalle({
      customer: { id: 'c1', name: 'Cliente Demo', phone: '3512345678' },
      device: { id: 'd1', type: 'smartphone', brand: 'Samsung', model: 'A04e', issue: 'No carga' },
    } as Partial<OrderDetailSimple>)} />)

    const hoja = await screen.findByTestId('service-order-print-root')
    expect(hoja.textContent).toContain('Cliente Demo')
    expect(hoja.textContent).toContain('Samsung A04e')
    expect(hoja.textContent).toContain('No carga')
    expect(within(hoja).queryByTestId('service-order-no-customer')).toBeNull()
    expect(within(hoja).queryByTestId('service-order-no-device')).toBeNull()
  })
})
