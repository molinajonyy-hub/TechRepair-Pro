// ─────────────────────────────────────────────────────────────────────────────
// UI-CONSISTENCY-2A · Correcciones de superficie de clientes.
//
// Tres defectos aislados, ninguno de semántica del Customer Core:
//   1. la lista mostraba 0 órdenes y $0 para todos;
//   2. el alta rápida repetía el error de mayorista dos veces;
//   3. el selector DNI/CUIT llevaba colores inline de la época dark-only.
// ─────────────────────────────────────────────────────────────────────────────
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAll: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  ordersQuery: vi.fn(),
  loadProfiles: vi.fn(),
  ordersSelect: vi.fn(),
}))

vi.mock('../../src/services/api', () => ({
  customersService: { getAll: mocks.getAll, update: mocks.update, create: mocks.create },
}))
vi.mock('../../src/contexts/AuthContext', () => ({ useAuth: () => ({ businessId: 'biz-1' }) }))
vi.mock('../../src/contexts/LoadingContext', () => ({
  useLoading: () => ({ showLoading: vi.fn(), hideLoading: vi.fn() }),
}))
vi.mock('../../src/hooks/useAppWakeUp', () => ({ useRefreshOnWakeUp: () => {} }))
vi.mock('../../src/hooks/usePermissions', () => ({
  usePermissions: () => ({ can: () => true }),
  effectivePermissions: () => ({ orders_create: true }),
}))
vi.mock('../../src/features/order-intake/service', () => ({
  createOrderIntake: vi.fn(), uploadIntakePhotos: vi.fn(), loadAssignableProfiles: mocks.loadProfiles,
}))
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: (columns: string) => {
        mocks.ordersSelect(columns)
        return { eq: () => ({ limit: () => mocks.ordersQuery() }) }
      },
    }),
  },
}))

import { Customers } from '../../src/pages/Customers'
import { NewOrder } from '../../src/pages/NewOrder'

const CUSTOMERS = [
  { id: 'cust-a', name: 'Cliente A DosOrdenes', phone: '3510000001', customer_type: 'minorista' },
  { id: 'cust-b', name: 'Cliente B UnaOrden', phone: '3510000002', customer_type: 'minorista' },
  { id: 'cust-c', name: 'Cliente C SinOrdenes', phone: '3510000003', customer_type: 'minorista' },
]

// "Total" = por orden, `total_cost` si es positivo; si no, `estimated_total`.
// Es la MISMA expresión que ya renderiza CustomerDetail por orden; este lote
// no la reinterpreta, sólo hace que la lista la calcule de verdad.
const ORDERS = [
  { id: 'o1', customer_id: 'cust-a', total_cost: 1000, estimated_total: 999 },   // gana total_cost
  { id: 'o2', customer_id: 'cust-a', total_cost: null, estimated_total: 500 },   // cae a estimated_total
  { id: 'o3', customer_id: 'cust-b', total_cost: 0,    estimated_total: 250 },   // 0 no es positivo -> estimado
  { id: 'o4', customer_id: null,     total_cost: 700,  estimated_total: 700 },   // huérfana: se ignora
]

function rowOf(name: string) {
  return screen.getAllByRole('row').find((r) => r.textContent?.includes(name))!
}

beforeEach(() => {
  mocks.getAll.mockReset().mockResolvedValue(CUSTOMERS)
  mocks.update.mockReset().mockResolvedValue({ id: 'cust-a' })
  mocks.create.mockReset().mockImplementation(async (p) => ({ id: 'nuevo', ...p }))
  mocks.ordersQuery.mockReset().mockResolvedValue({ data: ORDERS })
  mocks.ordersSelect.mockReset()
  mocks.loadProfiles.mockReset().mockResolvedValue([])
})

// ── 1. Estadísticas de la lista ─────────────────────────────────────────────
describe('estadísticas de la lista de clientes', () => {
  it('cuenta las órdenes contra customer_id, no contra una relación inexistente', async () => {
    render(<MemoryRouter><Customers /></MemoryRouter>)
    await screen.findByText('Cliente A DosOrdenes')

    // Antes: la query traía `customer_id` plano y el reduce leía
    // `order.customer?.id` -> undefined -> TODAS las órdenes descartadas.
    expect(within(rowOf('Cliente A DosOrdenes')).getByText('2')).toBeInTheDocument()
    expect(within(rowOf('Cliente B UnaOrden')).getByText('1')).toBeInTheDocument()
    expect(within(rowOf('Cliente C SinOrdenes')).getByText('0')).toBeInTheDocument()
  })

  it('suma el total con la semántica existente: total_cost si es positivo, si no el estimado', async () => {
    render(<MemoryRouter><Customers /></MemoryRouter>)
    await screen.findByText('Cliente A DosOrdenes')

    // A: 1000 (total_cost) + 500 (estimated_total) = 1500
    expect(rowOf('Cliente A DosOrdenes').textContent).toContain('1.500')
    // B: total_cost 0 NO es positivo -> usa el estimado 250
    expect(rowOf('Cliente B UnaOrden').textContent).toContain('250')
    // C: sin órdenes -> 0
    expect(rowOf('Cliente C SinOrdenes').textContent).toMatch(/\$\s?0/)
  })

  it('pide estimated_total en la query: sin ese campo el total caía a 0', async () => {
    render(<MemoryRouter><Customers /></MemoryRouter>)
    await waitFor(() => expect(mocks.ordersSelect).toHaveBeenCalled())

    const columns = mocks.ordersSelect.mock.calls[0][0] as string
    expect(columns).toContain('customer_id')
    expect(columns).toContain('total_cost')
    expect(columns).toContain('estimated_total')
  })

  it('ignora órdenes sin cliente en vez de agruparlas juntas', async () => {
    render(<MemoryRouter><Customers /></MemoryRouter>)
    await screen.findByText('Cliente A DosOrdenes')
    // La orden huérfana (700) no debe aparecer sumada en ninguna fila.
    for (const name of ['Cliente A DosOrdenes', 'Cliente B UnaOrden', 'Cliente C SinOrdenes']) {
      expect(rowOf(name).textContent).not.toContain('700')
    }
  })

  it('mantiene el aislamiento por negocio y no escribe nada al listar', async () => {
    render(<MemoryRouter><Customers /></MemoryRouter>)
    await screen.findByText('Cliente A DosOrdenes')
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })
})

// ── 2. Error duplicado en el alta rápida ────────────────────────────────────
describe('alta rápida · el error de mayorista se muestra UNA sola vez', () => {
  const MESSAGE = 'Un cliente mayorista necesita razón social.'

  async function openWholesaleDialog() {
    render(<MemoryRouter><NewOrder /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'Crear cliente rápido' }))
    fireEvent.change(screen.getByLabelText('Tipo de cliente'), { target: { value: 'mayorista' } })
    fireEvent.change(screen.getByLabelText('Nombre de contacto'), { target: { value: 'QA Contacto' } })
    fireEvent.change(screen.getByLabelText('Teléfono'), { target: { value: '3510000001' } })
  }

  it('renderiza exactamente un mensaje visible para el error de razón social', async () => {
    await openWholesaleDialog()

    // Antes: el resumen (setError) + el inline del AppInput daban DOS nodos.
    expect(screen.getAllByText(MESSAGE)).toHaveLength(1)
  })

  it('el mensaje es del CAMPO, no un resumen: cuelga del aria-describedby del input', async () => {
    await openWholesaleDialog()

    // Gate independiente del botón deshabilitado. El resumen del diálogo se
    // renderiza con role="alert" y sin id; el inline de AppInput lleva id y es
    // el destino de aria-describedby. Si alguien reintroduce el setError de
    // validación, aparecería un role="alert" con este texto.
    const input = screen.getByLabelText('Razón social')
    const describedBy = input.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)).toHaveTextContent(MESSAGE)
    expect(input).toHaveAttribute('aria-invalid', 'true')

    const alerts = screen.queryAllByRole('alert').filter((n) => n.textContent?.includes(MESSAGE))
    expect(alerts).toHaveLength(0)
  })

  it('bloquea el guardado y no persiste ningún cliente', async () => {
    await openWholesaleDialog()

    const cta = screen.getByRole('button', { name: 'Crear cliente' })
    expect(cta).toBeDisabled()

    fireEvent.click(cta)
    expect(mocks.create).not.toHaveBeenCalled()
    expect(screen.getAllByText(MESSAGE)).toHaveLength(1)
  })

  it('con razón social válida vuelve a poder crearse, y sigue sin duplicar mensajes', async () => {
    await openWholesaleDialog()
    fireEvent.change(screen.getByLabelText('Razón social'), { target: { value: 'Demo SRL' } })

    expect(screen.queryByText(MESSAGE)).not.toBeInTheDocument()
    const cta = screen.getByRole('button', { name: 'Crear cliente' })
    expect(cta).not.toBeDisabled()

    fireEvent.click(cta)
    await waitFor(() => expect(mocks.create).toHaveBeenCalled())
    expect(mocks.create.mock.calls[0][0]).toMatchObject({
      customer_type: 'mayorista', business_name: 'Demo SRL',
    })
  })

  it('la alerta de resumen queda libre para errores del servidor', async () => {
    await openWholesaleDialog()
    fireEvent.change(screen.getByLabelText('Razón social'), { target: { value: 'Demo SRL' } })
    mocks.create.mockRejectedValueOnce(new Error('Fallo del servidor'))

    fireEvent.click(screen.getByRole('button', { name: 'Crear cliente' }))

    expect(await screen.findByText('Fallo del servidor')).toBeInTheDocument()
  })
})

// ── 3. Selector DNI/CUIT sin colores inline ─────────────────────────────────
describe('selector DNI/CUIT · semántica de tema', () => {
  // jsdom no aplica index.css, así que acá se prueba que el control resuelva
  // por CLASE canónica y no lleve el par de colores medido en 1.44:1. El ratio
  // real se mide en el navegador, en el gate E2E @customer-core.
  const LEGACY_BG = 'rgba(99,102,241,0.25)'
  const LEGACY_FG = '#a5b4fc'

  it('el alta full page usa la clase canónica y no estilos de color inline', async () => {
    const { NewCustomer } = await import('../../src/pages/NewCustomer')
    render(<MemoryRouter><NewCustomer /></MemoryRouter>)

    for (const t of ['dni', 'cuit']) {
      const chip = screen.getByTestId(`customer-document-type-${t}`)
      expect(chip).toHaveClass('seg-field-option')
      const inline = chip.getAttribute('style') || ''
      expect(inline).not.toContain('background')
      expect(inline).not.toContain('color')
      expect(inline.replace(/\s/g, '')).not.toContain(LEGACY_BG)
      expect(inline.toLowerCase()).not.toContain(LEGACY_FG)
    }
    // El estado seleccionado sigue siendo programáticamente distinguible.
    expect(screen.getByTestId('customer-document-type-dni')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('customer-document-type-cuit')).toHaveAttribute('aria-pressed', 'false')
  })

  it('la edición usa la misma clase canónica, no una copia divergente', async () => {
    mocks.getAll.mockResolvedValue([{ ...CUSTOMERS[0], document: 'CUIT 20301234567', customer_type: 'mayorista', business_name: 'Demo SRL' }])
    render(<MemoryRouter><Customers /></MemoryRouter>)
    fireEvent.click(await screen.findByTitle('Editar cliente'))
    await screen.findByText('Editar Cliente')

    for (const t of ['dni', 'cuit']) {
      const chip = screen.getByTestId(`customer-edit-document-type-${t}`)
      expect(chip).toHaveClass('seg-field-option')
      const inline = chip.getAttribute('style') || ''
      expect(inline).not.toContain('background')
      expect(inline).not.toContain('color')
    }
  })
})
