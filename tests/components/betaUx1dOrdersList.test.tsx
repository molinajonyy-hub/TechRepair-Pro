// ─────────────────────────────────────────────────────────────────────────────
// BETA-UX-1D · Órdenes como lista mobile.
//
// La tabla de escritorio y las tarjetas de mobile son DOS PRESENTACIONES del
// mismo dato. jsdom no aplica `index.css`, así que acá conviven las dos y se
// mide lo que no depende del CSS:
//   · que las tarjetas salgan del mismo dataset filtrado y del mismo mapa
//     financiero que la tabla (misma orden → mismos textos, mismo badge);
//   · que los importes sólo aparezcan con `amountsAuthorized === true`, y que ni
//     un mapa `financial` incoherente pueda hacerlos aparecer;
//   · que tocar la tarjeta abra el detalle y que el menú lleve los flujos de
//     siempre (misma impresión, misma confirmación de borrado);
//   · que el estado vacío viva FUERA de la tabla y que «Limpiar filtros» limpie
//     los cuatro filtros, incluido el de cobro.
// Qué se ve a 375 px (tabla oculta, lista visible, 44 px, sin desborde) lo mide
// el navegador: `tests/e2e/m7/mobile-orders.spec.ts`.
// ─────────────────────────────────────────────────────────────────────────────
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrderFinancialStatus, OrderListItem, UseOrdersFilters } from '../../src/hooks/useOrders'

const state = vi.hoisted(() => ({
  orders: [] as unknown[],
  financial: {} as Record<string, unknown>,
  amountsAuthorized: true as boolean | null,
  financialError: false,
  /** Si se define, el filtro de cobro devuelve estas órdenes (o ninguna). */
  ordersByPayment: null as Record<string, unknown[]> | null,
  filters: [] as unknown[],
  refresh: vi.fn(),
  deleted: [] as string[],
}))

vi.mock('../../src/hooks/useOrders', () => ({
  useOrders: (filters: UseOrdersFilters = {}) => {
    state.filters.push({ status: filters.status ?? '', payment: filters.payment ?? '' })
    const porCobro = filters.payment && state.ordersByPayment ? (state.ordersByPayment[filters.payment] ?? []) : null
    return {
      orders: porCobro ?? state.orders,
      loading: false,
      error: null,
      total: state.orders.length,
      financial: state.financial,
      financialError: state.financialError,
      amountsAuthorized: state.amountsAuthorized,
      refresh: state.refresh,
    }
  },
}))
vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ businessId: 'biz-1' }),
}))
vi.mock('../../src/hooks/useOrderPrintSettings', () => ({
  useOrderPrintSettings: () => ({ settings: { nombre_comercial: 'Taller de prueba', razon_social: null } }),
}))
vi.mock('../../src/components/print/ServiceOrderPrint', () => ({
  ServiceOrderPrint: ({ order }: { order: { id: string; estimated_total?: number } }) => (
    <div data-testid="print-probe" data-order={order.id} data-estimated={String(order.estimated_total)} />
  ),
}))
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      delete: () => ({ eq: async (_col: string, id: string) => { state.deleted.push(id); return { error: null } } }),
    }),
  },
}))

import { Orders } from '../../src/pages/Orders'

const ORDER_A: OrderListItem = {
  id: 'aaaaaaaa-0000-0000-0000-000000000001', status: 'repair', priority: 'urgent',
  created_at: '2026-10-08T15:00:00Z',
  customer: { id: 'c1', name: 'Cliente Uno', phone: '3510000001' },
  device: { id: 'd1', brand: 'Samsung', model: 'Galaxy S24 Ultra 5G 512GB', type: 'smartphone' },
}
const ORDER_B: OrderListItem = {
  id: 'bbbbbbbb-0000-0000-0000-000000000002', status: 'new', priority: 'low',
  created_at: '2026-10-07T15:00:00Z',
  customer: null,
  device: null,
}

const fin = (over: Partial<OrderFinancialStatus>): OrderFinancialStatus => ({
  order_id: '', payment_status: 'sin_facturar', total_comprobado: 0, total_cobrado: 0, cobrado_directo: 0,
  imputado_cc: 0, saldo_pendiente: 0, saldo_en_cc: 0, deuda_en_cc: false, comprobantes_vigentes: 0,
  comprobante_id: null, comprobante_numero: null, completed_at: null, paid_at: null, ultimo_pago: null,
  ...over,
})

function LocationProbe() {
  const { id } = useParams()
  return <div data-testid="order-detail-probe">{id}</div>
}

function renderOrders() {
  return render(
    <MemoryRouter initialEntries={['/orders']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/orders" element={<Orders />} />
        <Route path="/orders/new" element={<div data-testid="new-order-probe" />} />
        <Route path="/orders/:id" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

const desktop = () => within(screen.getByTestId('orders-desktop-table'))
const mobile = () => within(screen.getByTestId('orders-mobile-list'))
const cards = () => mobile().getAllByTestId('orders-mobile-item')
const cardOf = (text: string) => cards().find(card => card.textContent?.includes(text))!

beforeEach(() => {
  state.orders = [ORDER_A, ORDER_B]
  state.financial = {
    [ORDER_A.id]: fin({ order_id: ORDER_A.id, payment_status: 'partial', saldo_pendiente: 100000, estimated_total: 185000, labor_cost: 0, comprobantes_vigentes: 1 }),
    [ORDER_B.id]: fin({ order_id: ORDER_B.id, payment_status: 'sin_facturar', estimated_total: 0, labor_cost: 0 }),
  }
  state.amountsAuthorized = true
  state.financialError = false
  state.ordersByPayment = null
  state.filters = []
  state.deleted = []
  state.refresh.mockReset()
})

describe('BETA-UX-1D · Órdenes · la lista mobile es otra presentación del mismo dato', () => {
  it('monta la tabla y la lista con las mismas órdenes, en el mismo orden', () => {
    renderOrders()

    expect(desktop().getAllByRole('row')).toHaveLength(1 + 2)   // encabezado + 2 órdenes
    expect(cards()).toHaveLength(2)
    expect(cards()[0]).toHaveTextContent('Cliente Uno')
    expect(cards()[1]).toHaveTextContent('Sin cliente')
    // La lista es una lista: `ul` con nombre accesible.
    expect(mobile().getByRole('list', { name: 'Órdenes de trabajo' })).toBeInTheDocument()
    // Una sola lectura de datos: el hook se usa una vez, con los mismos filtros.
    expect(new Set(state.filters.map(f => JSON.stringify(f)))).toEqual(new Set([JSON.stringify({ status: '', payment: '' })]))
  })

  it('cada tarjeta identifica la orden: cliente, #id corto, equipo, fecha y prioridad sólo si importa', () => {
    renderOrders()

    const a = cardOf('Cliente Uno')
    expect(a).toHaveTextContent('#aaaaaaaa')
    expect(a).toHaveTextContent('Samsung Galaxy S24 Ultra 5G 512GB')
    expect(a).toHaveTextContent('Prioridad urgente')
    expect(a).toHaveTextContent(/08 de oct de 2026|08 oct 2026/)

    const b = cardOf('Sin cliente')
    expect(b).toHaveTextContent('#bbbbbbbb')
    expect(b).toHaveTextContent('Sin dispositivo')
    // La prioridad baja no se nombra: no cambia qué orden se atiende primero.
    expect(b).not.toHaveTextContent(/prioridad/i)
  })

  it('el estado técnico y el de cobro son los mismos que en la tabla', () => {
    renderOrders()

    const a = cardOf('Cliente Uno')
    expect(a).toHaveTextContent('En Reparación')
    expect(within(a).getByTestId('order-financial-badge')).toHaveAttribute('data-status', 'partial')
    // Mismo valor canónico en la fila de escritorio de esa orden.
    const fila = desktop().getAllByRole('row').find(row => row.textContent?.includes('#aaaaaaaa'))!
    expect(within(fila).getByTestId('order-financial-badge')).toHaveAttribute('data-status', 'partial')

    expect(within(cardOf('Sin cliente')).getByTestId('order-financial-badge')).toHaveAttribute('data-status', 'sin_facturar')
  })

  it('con importes autorizados muestra el total y el saldo que entregó el servidor', () => {
    renderOrders()

    const a = cardOf('Cliente Uno')
    expect(within(a).getByTestId('orders-mobile-total')).toHaveTextContent('$185.000')
    expect(within(a).getByTestId('orders-mobile-balance')).toHaveTextContent('Saldo $100.000')
    // Igual que la tabla, con la misma regla de presentación.
    const fila = desktop().getAllByRole('row').find(row => row.textContent?.includes('#aaaaaaaa'))!
    expect(fila).toHaveTextContent('$185.000')
    expect(fila).toHaveTextContent('Saldo $100.000')

    // Sin saldo no se inventa una línea de saldo.
    expect(within(cardOf('Sin cliente')).queryByTestId('orders-mobile-balance')).not.toBeInTheDocument()
  })

  it('tocar la tarjeta abre el detalle, también con teclado', () => {
    const first = renderOrders()
    fireEvent.click(mobile().getByRole('link', { name: 'Abrir la orden #aaaaaaaa de Cliente Uno' }))
    expect(screen.getByTestId('order-detail-probe')).toHaveTextContent(ORDER_A.id)
    first.unmount()

    renderOrders()
    fireEvent.keyDown(mobile().getByRole('link', { name: 'Abrir la orden #bbbbbbbb de Sin cliente' }), { key: 'Enter' })
    expect(screen.getByTestId('order-detail-probe')).toHaveTextContent(ORDER_B.id)
  })
})

describe('BETA-UX-1D · Órdenes · acciones de la tarjeta', () => {
  it('el menú lleva Imprimir y Eliminar; ver y editar los resuelve la tarjeta', () => {
    renderOrders()

    fireEvent.click(mobile().getByRole('button', { name: 'Acciones de la orden #aaaaaaaa' }))
    const menu = screen.getByRole('menu', { name: 'Acciones de la orden #aaaaaaaa' })
    expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Imprimir', 'Eliminar'])
    // Abrir el menú NO navega: el menú no es parte de la zona que abre el detalle.
    expect(screen.queryByTestId('order-detail-probe')).not.toBeInTheDocument()
  })

  it('al abrirse, el menú se trae a la vista: no queda debajo de la barra de navegación', () => {
    // jsdom no implementa `scrollIntoView`; el navegador sí. Lo que se mide acá
    // es que el menú lo pida sobre SU popover y sin forzar un salto si ya entra.
    const scrollIntoView = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scrollIntoView })
    try {
      renderOrders()
      fireEvent.click(mobile().getByRole('button', { name: 'Acciones de la orden #aaaaaaaa' }))

      expect(scrollIntoView).toHaveBeenCalledTimes(1)
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
      expect(scrollIntoView.mock.instances[0]).toBe(screen.getByRole('menu'))
    } finally {
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    }
  })

  it('Imprimir usa la misma impresión que la tabla, con el presupuesto de la ruta autorizada', () => {
    renderOrders()

    fireEvent.click(mobile().getByRole('button', { name: 'Acciones de la orden #aaaaaaaa' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Imprimir' }))

    const probe = within(screen.getByTestId('order-print-hidden-root')).getByTestId('print-probe')
    expect(probe).toHaveAttribute('data-order', ORDER_A.id)
    expect(probe).toHaveAttribute('data-estimated', '185000')
  })

  it('Eliminar abre la confirmación de siempre: una sola, y cancelar no borra', () => {
    renderOrders()

    fireEvent.click(mobile().getByRole('button', { name: 'Acciones de la orden #aaaaaaaa' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Eliminar' }))

    expect(screen.getAllByRole('heading', { name: 'Eliminar Orden' })).toHaveLength(1)
    const modal = screen.getByRole('heading', { name: 'Eliminar Orden' }).closest('.modal-card') as HTMLElement
    expect(modal).toHaveTextContent('#aaaaaaaa')
    expect(modal).toHaveTextContent('de Cliente Uno')

    fireEvent.click(within(modal).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('heading', { name: 'Eliminar Orden' })).not.toBeInTheDocument()
    expect(state.deleted).toEqual([])
  })

  it('las acciones de escritorio siguen las cuatro de siempre', () => {
    renderOrders()

    const fila = desktop().getAllByRole('row').find(row => row.textContent?.includes('#aaaaaaaa'))!
    expect(within(fila).getByTestId('order-print-button')).toHaveAttribute('title', 'Imprimir Orden')
    for (const titulo of ['Ver detalle', 'Editar', 'Eliminar']) {
      expect(within(fila).getByTitle(titulo)).toBeInTheDocument()
    }
  })
})

describe('BETA-UX-1D · Órdenes · importes restringidos (SEC-08A) en la lista mobile', () => {
  const sinImporte = (card: HTMLElement) => {
    expect(card.textContent).not.toMatch(/\$/)
    expect(card.textContent).not.toMatch(/\d{2,3}\.\d{3}/)
    expect(within(card).queryByTestId('orders-mobile-total')).not.toBeInTheDocument()
    expect(within(card).queryByTestId('orders-mobile-balance')).not.toBeInTheDocument()
  }

  it('rol sin la capacidad: «Importes restringidos», ningún monto y ningún $0', () => {
    state.amountsAuthorized = false
    // Sin la capacidad el servidor tampoco entrega el estado de cobro.
    state.financial = {}
    renderOrders()

    for (const card of cards()) {
      sinImporte(card)
      expect(within(card).getByTestId('orders-mobile-amounts-restricted')).toHaveTextContent('Importes restringidos')
      expect(within(card).getByTestId('order-financial-badge')).toHaveAttribute('data-status', 'unavailable')
    }
  })

  it('aunque el mapa traiga importes, sin autorización NO se muestran', () => {
    // Defensa en profundidad: la presentación mobile no puede ser una vía
    // lateral. La decisión es `amountsAuthorized`, no «hay un número a mano».
    state.amountsAuthorized = false
    renderOrders()

    for (const card of cards()) {
      sinImporte(card)
      expect(within(card).getByTestId('orders-mobile-amounts-restricted')).toBeInTheDocument()
    }
    // La tabla de escritorio tampoco, con su señal de siempre.
    expect(desktop().getAllByTestId('order-total-restricted')).toHaveLength(2)
    expect(screen.getByTestId('orders-desktop-table').textContent).not.toContain('185.000')
  })

  it('autorización desconocida (todavía no llegó o falló): guion con contexto, nunca un monto', () => {
    state.amountsAuthorized = null
    renderOrders()

    for (const card of cards()) {
      sinImporte(card)
      const aviso = within(card).getByTestId('orders-mobile-amounts-unavailable')
      expect(aviso).toHaveTextContent('Importe no disponible')
      expect(within(card).queryByTestId('orders-mobile-amounts-restricted')).not.toBeInTheDocument()
    }
  })

  it('con el bloque financiero caído no muestra importes aunque estuviera autorizado', () => {
    state.financialError = true
    renderOrders()

    for (const card of cards()) {
      sinImporte(card)
      expect(within(card).getByTestId('order-financial-badge')).toHaveAttribute('data-status', 'unavailable')
    }
  })

  it('imprimir sin autorización no manda ningún presupuesto a la impresión', () => {
    state.amountsAuthorized = false
    renderOrders()

    fireEvent.click(mobile().getByRole('button', { name: 'Acciones de la orden #aaaaaaaa' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Imprimir' }))
    expect(screen.getByTestId('print-probe')).toHaveAttribute('data-estimated', 'undefined')
  })
})

describe('BETA-UX-1D · Órdenes · el estado vacío vive fuera de la tabla', () => {
  it('sin órdenes: no hay tabla ni lista, y «Nueva Orden» lleva al alta', () => {
    state.orders = []
    state.financial = {}
    renderOrders()

    const vacio = screen.getByTestId('orders-empty-state')
    expect(vacio).toHaveAttribute('data-empty-kind', 'no-data')
    expect(vacio).toHaveTextContent('Todavía no tenés órdenes')
    // El mensaje no cuelga de ninguna tabla, y no se montó ninguna vacía.
    expect(vacio.closest('table')).toBeNull()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByTestId('orders-desktop-table')).not.toBeInTheDocument()
    expect(screen.queryByTestId('orders-mobile-list')).not.toBeInTheDocument()

    fireEvent.click(within(vacio).getByRole('button', { name: 'Nueva Orden' }))
    expect(screen.getByTestId('new-order-probe')).toBeInTheDocument()
  })

  it('sólo con el filtro de COBRO y sin coincidencias dice «Sin resultados», no «no tenés órdenes»', () => {
    // El bug: la rama del estado vacío miraba búsqueda, estado y prioridad pero
    // no el filtro de cobro, así que filtrar «Pendientes» sin coincidencias
    // decía «Todavía no tenés órdenes» a un taller que sí las tiene.
    state.ordersByPayment = { pending: [] }
    renderOrders()

    fireEvent.change(screen.getByTestId('orders-payment-filter'), { target: { value: 'pending' } })

    const vacio = screen.getByTestId('orders-empty-state')
    expect(vacio).toHaveAttribute('data-empty-kind', 'no-results')
    expect(vacio).toHaveTextContent('Sin resultados')
    expect(vacio).not.toHaveTextContent('Todavía no tenés órdenes')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('«Limpiar filtros» del estado vacío limpia búsqueda, estado, cobro y prioridad', async () => {
    state.ordersByPayment = { pending: [] }
    renderOrders()

    const busqueda = screen.getByTestId('orders-search-input')
    const estado = screen.getByTestId('orders-status-filter')
    const cobro = screen.getByTestId('orders-payment-filter')
    const prioridad = screen.getByTestId('orders-priority-filter')
    fireEvent.change(busqueda, { target: { value: 'algo que no existe' } })
    fireEvent.change(estado, { target: { value: 'repair' } })
    fireEvent.change(cobro, { target: { value: 'pending' } })
    fireEvent.change(prioridad, { target: { value: 'urgent' } })

    fireEvent.click(within(screen.getByTestId('orders-empty-state')).getByRole('button', { name: 'Limpiar filtros' }))

    expect(busqueda).toHaveValue('')
    expect(estado).toHaveValue('')
    expect(cobro).toHaveValue('')
    expect(prioridad).toHaveValue('')
    // El filtro de cobro es server-side: el hook vuelve a pedirse sin él.
    expect(state.filters.at(-1)).toEqual({ status: '', payment: '' })
    // Con los filtros limpios vuelven las órdenes (la búsqueda aplica con debounce).
    expect(await screen.findByTestId('orders-mobile-list', {}, { timeout: 2000 })).toBeInTheDocument()
    expect(cards()).toHaveLength(2)
  })

  it('«Limpiar filtros» de la barra hace lo mismo que el del estado vacío', () => {
    renderOrders()

    fireEvent.change(screen.getByTestId('orders-payment-filter'), { target: { value: 'paid' } })
    fireEvent.change(screen.getByTestId('orders-priority-filter'), { target: { value: 'low' } })
    fireEvent.click(screen.getByTestId('orders-clear-filters'))

    expect(screen.getByTestId('orders-payment-filter')).toHaveValue('')
    expect(screen.getByTestId('orders-priority-filter')).toHaveValue('')
    expect(screen.queryByTestId('orders-clear-filters')).not.toBeInTheDocument()
  })

  it('el filtro de prioridad aplica igual a la tabla y a las tarjetas', () => {
    renderOrders()

    fireEvent.change(screen.getByTestId('orders-priority-filter'), { target: { value: 'urgent' } })

    expect(cards()).toHaveLength(1)
    expect(cards()[0]).toHaveTextContent('Cliente Uno')
    expect(desktop().getAllByRole('row')).toHaveLength(1 + 1)
  })
})
