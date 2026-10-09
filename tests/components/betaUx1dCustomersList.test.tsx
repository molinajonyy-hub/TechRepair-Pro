// ─────────────────────────────────────────────────────────────────────────────
// BETA-UX-1D · Clientes como lista mobile + encabezado con una primaria.
//
// Igual que en Órdenes: tabla y tarjetas son dos presentaciones del mismo
// `filteredCustomers` y del mismo `customerStats`. jsdom no aplica el CSS, así
// que conviven; acá se mide que:
//   · las tarjetas muestren lo mismo que la tabla (nombre, mayorista, contacto,
//     cantidad de órdenes) y el total SÓLO con autorización del servidor;
//   · tocar la tarjeta abra la ficha y el menú use los flujos de siempre (el
//     mismo diálogo de edición, la misma confirmación de borrado);
//   · Plantilla / Exportar / Importar sigan existiendo en escritorio y estén,
//     con los mismos handlers, en el menú de mobile;
//   · el estado vacío viva fuera de la tabla y ofrezca «Nuevo Cliente».
// La geometría a 375 px vive en `tests/e2e/m7/mobile-orders.spec.ts`.
// ─────────────────────────────────────────────────────────────────────────────
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAll: vi.fn(),
  update: vi.fn(),
  ordersQuery: vi.fn(),
  rpc: vi.fn(),
  deleted: [] as Array<Record<string, string>>,
  createTemplate: vi.fn(),
  exportToExcel: vi.fn(),
  exportRows: vi.fn(),
}))

vi.mock('../../src/services/api', () => ({
  customersService: { getAll: mocks.getAll, update: mocks.update },
}))
vi.mock('../../src/services/excelService', () => ({
  ExcelService: { createTemplate: mocks.createTemplate, exportToExcel: mocks.exportToExcel },
}))
vi.mock('../../src/components/ModalImportExcel', () => ({
  ModalImportExcel: ({ isOpen, title }: { isOpen: boolean; title: string }) =>
    (isOpen ? <div role="dialog" aria-label={title} data-testid="import-modal-probe" /> : null),
}))
vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ businessId: 'biz-1', role: 'owner', isOwner: true, hasBusinessAccess: true, profile: { permissions: null } }),
}))
vi.mock('../../src/contexts/LoadingContext', () => ({
  useLoading: () => ({ showLoading: vi.fn(), hideLoading: vi.fn() }),
}))
vi.mock('../../src/hooks/useAppWakeUp', () => ({ useRefreshOnWakeUp: () => {} }))
vi.mock('../../src/hooks/useSubscription', async () => {
  const { resolveEntitlement } = await vi.importActual<typeof import('../../src/lib/entitlements')>('../../src/lib/entitlements')
  const subscription = { subscription_status: 'active', subscription_plan: 'full' } as const
  const { hasFeature } = resolveEntitlement(subscription)
  return { useSubscription: () => ({ hasFeature, subscription, loading: false }) }
})
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        eq: () => (table === 'orders'
          ? { limit: () => mocks.ordersQuery() }
          : mocks.exportRows()),
      }),
      delete: () => ({
        eq: (c1: string, v1: string) => ({
          eq: async (c2: string, v2: string) => { mocks.deleted.push({ [c1]: v1, [c2]: v2 }); return { error: null } },
        }),
      }),
    }),
    rpc: (name: string, args: unknown) => mocks.rpc(name, args),
  },
}))

import { Customers } from '../../src/pages/Customers'

const CUSTOMERS = [
  { id: 'cust-a', name: 'Ana Dos Ordenes', phone: '3510000001', email: 'ana@example.test', customer_type: 'minorista' },
  { id: 'cust-b', name: 'Mayorista Uno', phone: '3510000002', email: null, customer_type: 'mayorista', business_name: 'Mayorista Uno SRL' },
  { id: 'cust-c', name: 'Sin Contacto', phone: '', email: null, customer_type: 'minorista' },
]
const ORDERS = [
  { id: 'o1', customer_id: 'cust-a' },
  { id: 'o2', customer_id: 'cust-a' },
  { id: 'o3', customer_id: 'cust-b' },
]
const AMOUNTS = [
  { order_id: 'o1', total_cost: 1000, estimated_total: 999 },
  { order_id: 'o2', total_cost: null, estimated_total: 500 },
  { order_id: 'o3', total_cost: 0, estimated_total: 250 },
]

function FichaProbe() {
  const { id } = useParams()
  return <div data-testid="customer-detail-probe">{id}</div>
}

function renderCustomers() {
  return render(
    <MemoryRouter initialEntries={['/customers']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/customers" element={<Customers />} />
        <Route path="/customers/new" element={<div data-testid="new-customer-probe" />} />
        <Route path="/customers/:id" element={<FichaProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

const desktop = () => within(screen.getByTestId('customers-desktop-table'))
const mobile = () => within(screen.getByTestId('customers-mobile-list'))
const cards = () => mobile().getAllByTestId('customers-mobile-item')
const cardOf = (name: string) => cards().find(card => card.textContent?.includes(name))!
const filaDe = (name: string) => desktop().getAllByRole('row').find(row => row.textContent?.includes(name))!
const cargado = () => screen.findByTestId('customers-mobile-list')

beforeEach(() => {
  mocks.getAll.mockReset().mockResolvedValue(CUSTOMERS)
  mocks.update.mockReset().mockResolvedValue({ id: 'cust-a' })
  mocks.ordersQuery.mockReset().mockResolvedValue({ data: ORDERS })
  mocks.rpc.mockReset().mockResolvedValue({ data: { ok: true, authorized: true, rows: AMOUNTS }, error: null })
  mocks.createTemplate.mockReset().mockResolvedValue(undefined)
  mocks.exportToExcel.mockReset().mockResolvedValue(undefined)
  mocks.exportRows.mockReset().mockResolvedValue({ data: CUSTOMERS })
  mocks.deleted = []
  vi.stubGlobal('alert', vi.fn())
})

describe('BETA-UX-1D · Clientes · la lista mobile es otra presentación del mismo dato', () => {
  it('monta la tabla y la lista con los mismos clientes', async () => {
    renderCustomers()
    await cargado()

    expect(desktop().getAllByRole('row')).toHaveLength(1 + 3)
    expect(cards().map(card => card.querySelector('.customer-card__title')?.textContent)).toEqual([
      'Ana Dos Ordenes', 'Mayorista UnoMAYORISTA', 'Sin Contacto',
    ])
    expect(mobile().getByRole('list', { name: 'Clientes' })).toBeInTheDocument()
    // Una sola carga: la lista mobile no dispara otra consulta ni otro pedido de importes.
    expect(mocks.getAll).toHaveBeenCalledTimes(1)
    expect(mocks.ordersQuery).toHaveBeenCalledTimes(1)
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })

  it('cada tarjeta trae nombre, contacto y cantidad de órdenes; el mayorista conserva su marca', async () => {
    renderCustomers()
    await cargado()

    const a = cardOf('Ana Dos Ordenes')
    expect(a).toHaveTextContent('3510000001')
    expect(a).toHaveTextContent('ana@example.test')
    expect(a).toHaveTextContent('2 órdenes')
    expect(within(a).queryByText('MAYORISTA')).not.toBeInTheDocument()

    const b = cardOf('Mayorista Uno')
    expect(within(b).getByText('MAYORISTA')).toHaveClass('badge')
    expect(b).toHaveTextContent('3510000002')
    expect(b).toHaveTextContent('1 orden')
    expect(b).not.toHaveTextContent('1 órdenes')

    const c = cardOf('Sin Contacto')
    expect(c).toHaveTextContent('Sin datos de contacto')
    expect(c).toHaveTextContent('0 órdenes')
  })

  it('el total sale del mismo `customerStats` que la tabla', async () => {
    renderCustomers()
    await cargado()

    // A: 1000 (total_cost) + 500 (estimated_total) = 1500 — misma regla que la tabla.
    expect(within(cardOf('Ana Dos Ordenes')).getByTestId('customers-mobile-total')).toHaveTextContent('1.500')
    expect(filaDe('Ana Dos Ordenes')).toHaveTextContent('1.500')
    expect(within(cardOf('Mayorista Uno')).getByTestId('customers-mobile-total')).toHaveTextContent('250')
  })

  it('sin autorización del servidor no muestra ningún total, ni $0', async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true, authorized: false, rows: [] }, error: null })
    renderCustomers()
    await cargado()

    for (const card of cards()) {
      expect(card.textContent).not.toMatch(/\$/)
      expect(within(card).queryByTestId('customers-mobile-total')).not.toBeInTheDocument()
      expect(within(card).getByTestId('customers-mobile-total-restricted')).toHaveTextContent('Importe restringido')
    }
    // El dato operativo sí: contar órdenes no es financiero.
    expect(cardOf('Ana Dos Ordenes')).toHaveTextContent('2 órdenes')
    // La tabla conserva su señal.
    expect(desktop().getAllByTestId('customer-total-restricted')).toHaveLength(3)
  })

  it('si el pedido de importes FALLA tampoco muestra un total', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } })
    renderCustomers()
    await cargado()

    for (const card of cards()) {
      expect(card.textContent).not.toMatch(/\$/)
      expect(within(card).getByTestId('customers-mobile-total-restricted')).toBeInTheDocument()
    }
  })

  it('tocar la tarjeta abre la ficha del cliente', async () => {
    renderCustomers()
    await cargado()

    fireEvent.click(mobile().getByRole('link', { name: 'Abrir la ficha de Mayorista Uno' }))
    expect(screen.getByTestId('customer-detail-probe')).toHaveTextContent('cust-b')
  })
})

describe('BETA-UX-1D · Clientes · acciones de la tarjeta', () => {
  it('Editar abre el MISMO diálogo de edición que la tabla, hidratado con ese cliente', async () => {
    renderCustomers()
    await cargado()

    fireEvent.click(mobile().getByRole('button', { name: 'Acciones de Mayorista Uno' }))
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Editar', 'Eliminar'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Editar' }))

    const dialogo = await screen.findByRole('dialog', { name: 'Editar Cliente' })
    expect(screen.getAllByRole('dialog', { name: 'Editar Cliente' })).toHaveLength(1)
    expect(within(dialogo).getByTestId('customer-business-name-input')).toHaveValue('Mayorista Uno SRL')
    expect(within(dialogo).getByTestId('customer-edit-save-button')).toBeInTheDocument()
    // Abrir el menú o editar no navega a la ficha.
    expect(screen.queryByTestId('customer-detail-probe')).not.toBeInTheDocument()
  })

  it('Eliminar abre la confirmación de siempre y borra filtrando por negocio', async () => {
    renderCustomers()
    await cargado()

    fireEvent.click(mobile().getByRole('button', { name: 'Acciones de Sin Contacto' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Eliminar' }))

    expect(screen.getAllByRole('heading', { name: 'Eliminar cliente' })).toHaveLength(1)
    const modal = screen.getByRole('heading', { name: 'Eliminar cliente' }).closest('.modal-card') as HTMLElement
    expect(modal).toHaveTextContent('Sin Contacto')
    expect(mocks.deleted).toEqual([])

    fireEvent.click(within(modal).getByRole('button', { name: /Sí, eliminar/ }))
    await waitFor(() => expect(mocks.deleted).toEqual([{ id: 'cust-c', business_id: 'biz-1' }]))
  })
})

describe('BETA-UX-1D · Clientes · encabezado: una primaria, secundarias agrupadas (P2-2)', () => {
  it('escritorio conserva Plantilla, Exportar, Importar y Nuevo Cliente', async () => {
    renderCustomers()
    await cargado()

    const secundarias = document.querySelector('.list-hdr-secondary') as HTMLElement
    expect(within(secundarias).getAllByRole('button').map(b => b.textContent)).toEqual(['Plantilla', 'Exportar', 'Importar'])
    const nuevo = screen.getByTestId('customers-new-button')
    expect(nuevo).toHaveTextContent('Nuevo Cliente')
    expect(nuevo).toHaveAttribute('href', '/customers/new')
    // La primaria NO está dentro del grupo que mobile oculta.
    expect(secundarias.contains(nuevo)).toBe(false)
  })

  it('el menú de mobile lleva las mismas tres, y cada una hace lo mismo que su botón', async () => {
    renderCustomers()
    await cargado()
    const abrirMenu = () => fireEvent.click(screen.getByTestId('customers-mobile-header-menu'))

    abrirMenu()
    const menu = screen.getByRole('menu', { name: 'Más acciones de clientes' })
    expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Plantilla', 'Exportar', 'Importar'])

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Plantilla' }))
    await waitFor(() => expect(mocks.createTemplate).toHaveBeenCalledTimes(1))
    expect(mocks.createTemplate.mock.calls[0][1]).toBe('plantilla_clientes')

    abrirMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Exportar' }))
    await waitFor(() => expect(mocks.exportToExcel).toHaveBeenCalledTimes(1))
    expect(mocks.exportToExcel.mock.calls[0].slice(1)).toEqual(['clientes', 'Clientes'])

    expect(screen.queryByTestId('import-modal-probe')).not.toBeInTheDocument()
    abrirMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Importar' }))
    expect(screen.getByRole('dialog', { name: 'Importar Clientes' })).toBeInTheDocument()
  })

  it('el botón de escritorio y el ítem del menú llaman al mismo handler', async () => {
    renderCustomers()
    await cargado()

    fireEvent.click(within(document.querySelector('.list-hdr-secondary') as HTMLElement).getByRole('button', { name: 'Plantilla' }))
    await waitFor(() => expect(mocks.createTemplate).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByTestId('customers-mobile-header-menu'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Plantilla' }))
    await waitFor(() => expect(mocks.createTemplate).toHaveBeenCalledTimes(2))
    expect(mocks.createTemplate.mock.calls[1]).toEqual(mocks.createTemplate.mock.calls[0])
  })
})

describe('BETA-UX-1D · Clientes · el estado vacío vive fuera de la tabla', () => {
  it('sin clientes: no hay tabla ni lista, y «Nuevo Cliente» lleva al alta', async () => {
    mocks.getAll.mockResolvedValue([])
    mocks.ordersQuery.mockResolvedValue({ data: [] })
    renderCustomers()

    const vacio = await screen.findByTestId('customers-empty-state')
    await waitFor(() => expect(mocks.getAll).toHaveBeenCalled())
    expect(vacio).toHaveAttribute('data-empty-kind', 'no-data')
    expect(vacio).toHaveTextContent('Todavía no tenés clientes')
    expect(vacio.closest('table')).toBeNull()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByTestId('customers-mobile-list')).not.toBeInTheDocument()

    fireEvent.click(within(vacio).getByRole('button', { name: 'Nuevo Cliente' }))
    expect(screen.getByTestId('new-customer-probe')).toBeInTheDocument()
  })

  it('una búsqueda sin coincidencias ofrece «Limpiar búsqueda» y vuelve a la lista', async () => {
    renderCustomers()
    await cargado()

    const busqueda = screen.getByTestId('customers-search-input')
    fireEvent.change(busqueda, { target: { value: 'zzz no existe' } })

    const vacio = await screen.findByTestId('customers-empty-state', {}, { timeout: 2000 })
    expect(vacio).toHaveAttribute('data-empty-kind', 'no-results')
    expect(vacio).toHaveTextContent('Sin resultados para "zzz no existe"')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()

    fireEvent.click(within(vacio).getByRole('button', { name: 'Limpiar búsqueda' }))
    expect(busqueda).toHaveValue('')
    expect(await screen.findByTestId('customers-mobile-list', {}, { timeout: 2000 })).toBeInTheDocument()
    expect(cards()).toHaveLength(3)
  })
})
