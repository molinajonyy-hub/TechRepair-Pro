// ─────────────────────────────────────────────────────────────────────────────
// UI-CONSISTENCY-2A · Correcciones de superficie de clientes.
//
// Tres defectos aislados, ninguno de semántica del Customer Core:
//   1. la lista mostraba 0 órdenes y $0 para todos;
//   2. el alta rápida repetía el error de mayorista dos veces;
//   3. el selector DNI/CUIT llevaba colores inline de la época dark-only.
// ─────────────────────────────────────────────────────────────────────────────
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAll: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  ordersQuery: vi.fn(),
  loadProfiles: vi.fn(),
  ordersSelect: vi.fn(),
  // SEC-08A: los importes ya no viajan en la fila de la orden.
  rpc: vi.fn(),
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
    rpc: (name: string, args: unknown) => mocks.rpc(name, args),
  },
}))

import { Customers } from '../../src/pages/Customers'
import { NewCustomer } from '../../src/pages/NewCustomer'
import { NewOrder } from '../../src/pages/NewOrder'

const CUSTOMERS = [
  { id: 'cust-a', name: 'Cliente A DosOrdenes', phone: '3510000001', customer_type: 'minorista' },
  { id: 'cust-b', name: 'Cliente B UnaOrden', phone: '3510000002', customer_type: 'minorista' },
  { id: 'cust-c', name: 'Cliente C SinOrdenes', phone: '3510000003', customer_type: 'minorista' },
]

// SEC-08A — la query de la lista es OPERATIVA: sólo el vínculo orden→cliente.
// Los importes ya no son columnas seleccionables de `orders`.
const ORDERS = [
  { id: 'o1', customer_id: 'cust-a' },
  { id: 'o2', customer_id: 'cust-a' },
  { id: 'o3', customer_id: 'cust-b' },
  { id: 'o4', customer_id: null },   // huérfana: se ignora
]

// "Total" = por orden, `total_cost` si es positivo; si no, `estimated_total`.
// Es la MISMA expresión que ya renderiza CustomerDetail por orden; SEC-08A no
// la reinterpreta, sólo cambia por dónde llegan los números.
const AMOUNTS = [
  { order_id: 'o1', total_cost: 1000, estimated_total: 999 },   // gana total_cost
  { order_id: 'o2', total_cost: null, estimated_total: 500 },   // cae a estimated_total
  { order_id: 'o3', total_cost: 0,    estimated_total: 250 },   // 0 no es positivo -> estimado
  { order_id: 'o4', total_cost: 700,  estimated_total: 700 },   // huérfana: se ignora
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
  mocks.rpc.mockReset().mockResolvedValue({ data: { ok: true, authorized: true, rows: AMOUNTS }, error: null })
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

  // SEC-08A — este test cambió de contrato a propósito. Antes exigía que la
  // query PIDIERA los importes; ahora exige lo contrario: la fila de la orden
  // no puede traerlos, porque la DB no se los concede al browser y el pedido
  // entero respondería 42501.
  it('NO pide columnas financieras en la query de la lista', async () => {
    render(<MemoryRouter><Customers /></MemoryRouter>)
    await waitFor(() => expect(mocks.ordersSelect).toHaveBeenCalled())

    const columns = mocks.ordersSelect.mock.calls[0][0] as string
    expect(columns).toContain('customer_id')
    expect(columns).not.toContain('total_cost')
    expect(columns).not.toContain('estimated_total')
    expect(columns).not.toContain('*')
  })

  it('pide los importes por la ruta autorizada, no por la tabla', async () => {
    render(<MemoryRouter><Customers /></MemoryRouter>)
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalled())

    const [name, args] = mocks.rpc.mock.calls[0] as [string, { p_business_id: string; p_order_ids: string[] }]
    expect(name).toBe('get_order_financial_amounts')
    expect(args.p_business_id).toBe('biz-1')
    expect(args.p_order_ids).toEqual(['o1', 'o2', 'o3', 'o4'])
  })

  it('sin autorización del servidor muestra un guion, nunca $0', async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true, authorized: false, rows: [] }, error: null })
    render(<MemoryRouter><Customers /></MemoryRouter>)
    await screen.findByText('Cliente A DosOrdenes')

    // El conteo de órdenes sigue estando: es operativo, no financiero.
    expect(within(rowOf('Cliente A DosOrdenes')).getByText('2')).toBeInTheDocument()
    // El importe NO: ni el real ni un cero inventado.
    expect(rowOf('Cliente A DosOrdenes').textContent).not.toContain('1.500')
    expect(rowOf('Cliente A DosOrdenes').textContent).not.toMatch(/\$\s?0/)
    expect(within(rowOf('Cliente A DosOrdenes')).getByTestId('customer-total-restricted')).toBeInTheDocument()
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
    const dialog = screen.getByRole('dialog', { name: 'Crear cliente rápido' })
    fireEvent.click(within(dialog).getByTestId('customer-type-mayorista'))
    fireEvent.change(within(dialog).getByLabelText('Nombre completo'), { target: { value: 'QA Contacto' } })
    fireEvent.change(within(dialog).getByLabelText('Teléfono'), { target: { value: '3510000001' } })
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

describe('alta canónica · paridad visual y de interacción', () => {
  async function openQuickDialog() {
    render(<MemoryRouter><NewOrder /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'Crear cliente rápido' }))
    return screen.getByRole('dialog', { name: 'Crear cliente rápido' })
  }

  it('la página completa empieza expandida y persiste email, dirección y notas', async () => {
    render(<MemoryRouter><NewCustomer /></MemoryRouter>)
    expect(screen.getByTestId('customer-additional-toggle')).toHaveAttribute('aria-expanded', 'true')

    fireEvent.change(screen.getByLabelText('Nombre completo'), { target: { value: 'Cliente Completo' } })
    fireEvent.change(screen.getByLabelText('Teléfono'), { target: { value: '3510000001' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'cliente@example.test' } })
    fireEvent.change(screen.getByLabelText('Dirección'), { target: { value: 'Av. Siempre Viva 123' } })
    fireEvent.change(screen.getByLabelText('Notas'), { target: { value: 'Prefiere mensajes.' } })
    fireEvent.click(screen.getByTestId('customer-save-button'))

    await waitFor(() => expect(mocks.create).toHaveBeenCalled())
    expect(mocks.create.mock.calls[0][0]).toMatchObject({
      email: 'cliente@example.test',
      address: 'Av. Siempre Viva 123',
      notes: 'Prefiere mensajes.',
    })
  })

  it('el diálogo empieza colapsado, expone los mismos opcionales y los persiste', async () => {
    const dialog = await openQuickDialog()
    const toggle = within(dialog).getByTestId('customer-additional-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(within(dialog).getByLabelText('Dirección')).not.toBeVisible()

    fireEvent.click(toggle)
    fireEvent.change(within(dialog).getByLabelText('Nombre completo'), { target: { value: 'Cliente Rápido' } })
    fireEvent.change(within(dialog).getByLabelText('Teléfono'), { target: { value: '3510000001' } })
    fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: 'rapido@example.test' } })
    fireEvent.change(within(dialog).getByLabelText('Dirección'), { target: { value: 'San Martín 456' } })
    fireEvent.change(within(dialog).getByLabelText('Notas'), { target: { value: 'Entregar por la tarde.' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Crear cliente' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalled())
    expect(mocks.create.mock.calls[0][0]).toMatchObject({
      email: 'rapido@example.test',
      address: 'San Martín 456',
      notes: 'Entregar por la tarde.',
    })
  })

  it('muestra la misma validación explícita de email en ambos shells', async () => {
    const full = render(<MemoryRouter><NewCustomer /></MemoryRouter>)
    fireEvent.change(screen.getByLabelText('Nombre completo'), { target: { value: 'Cliente' } })
    fireEvent.change(screen.getByLabelText('Teléfono'), { target: { value: '3510000001' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'invalido' } })
    expect(screen.getByText('Ingresá un email válido.')).toBeVisible()
    expect(screen.getByTestId('customer-save-button')).toBeDisabled()
    full.unmount()

    const dialog = await openQuickDialog()
    fireEvent.change(within(dialog).getByLabelText('Nombre completo'), { target: { value: 'Cliente' } })
    fireEvent.change(within(dialog).getByLabelText('Teléfono'), { target: { value: '3510000001' } })
    fireEvent.click(within(dialog).getByTestId('customer-additional-toggle'))
    fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: 'invalido' } })
    expect(within(dialog).getByText('Ingresá un email válido.')).toBeVisible()
    expect(within(dialog).getByRole('button', { name: 'Crear cliente' })).toBeDisabled()
  })

  it('conserva “Nombre completo” al pasar a mayorista', async () => {
    const dialog = await openQuickDialog()
    fireEvent.click(within(dialog).getByTestId('customer-type-mayorista'))
    expect(within(dialog).getByLabelText('Nombre completo')).toBeInTheDocument()
    expect(within(dialog).queryByLabelText('Nombre de contacto')).not.toBeInTheDocument()
  })

  it('el submit del diálogo es un formulario real y bloquea envíos simultáneos', async () => {
    let resolveCreate!: (value: { id: string; name: string; phone: string }) => void
    mocks.create.mockImplementationOnce(() => new Promise((resolve) => { resolveCreate = resolve }))
    const dialog = await openQuickDialog()
    fireEvent.change(within(dialog).getByLabelText('Nombre completo'), { target: { value: 'Sin Duplicar' } })
    fireEvent.change(within(dialog).getByLabelText('Teléfono'), { target: { value: '3510000001' } })

    const submit = within(dialog).getByRole('button', { name: 'Crear cliente' })
    expect(submit).toHaveAttribute('form', 'quick-customer-form')
    const form = document.getElementById('quick-customer-form') as HTMLFormElement
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(mocks.create).toHaveBeenCalledTimes(1)

    await act(async () => resolveCreate({ id: 'nuevo', name: 'Sin Duplicar', phone: '3510000001' }))
  })

  it('cancelar y reabrir vuelve al estado canónico vacío', async () => {
    const dialog = await openQuickDialog()
    fireEvent.change(within(dialog).getByLabelText('Nombre completo'), { target: { value: 'Borrador descartado' } })
    fireEvent.change(within(dialog).getByLabelText('Teléfono'), { target: { value: '3510000001' } })
    fireEvent.click(within(dialog).getByTestId('customer-type-mayorista'))
    fireEvent.change(within(dialog).getByLabelText('Razón social'), { target: { value: 'Descartar SRL' } })
    fireEvent.change(within(dialog).getByLabelText('Persona de contacto'), { target: { value: 'Ana' } })
    fireEvent.click(within(dialog).getByTestId('customer-additional-toggle'))
    fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: 'email-invalido' } })
    fireEvent.change(within(dialog).getByLabelText('Dirección'), { target: { value: 'Dirección vieja' } })
    fireEvent.change(within(dialog).getByLabelText('Notas'), { target: { value: 'Notas viejas' } })
    expect(within(dialog).getByText('Ingresá un email válido.')).toBeVisible()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(mocks.create).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Crear cliente rápido' }))
    const reopened = screen.getByRole('dialog', { name: 'Crear cliente rápido' })
    expect(within(reopened).getByTestId('customer-type-minorista')).toHaveAttribute('aria-pressed', 'true')
    expect(within(reopened).queryByLabelText('Razón social')).not.toBeInTheDocument()
    expect(within(reopened).queryByLabelText('Persona de contacto')).not.toBeInTheDocument()
    expect(within(reopened).getByLabelText('Nombre completo')).toHaveValue('')
    expect(within(reopened).getByLabelText('Teléfono')).toHaveValue('')
    expect(within(reopened).getByLabelText('Email')).toHaveValue('')
    expect(within(reopened).getByLabelText('Dirección')).toHaveValue('')
    expect(within(reopened).getByLabelText('Notas')).toHaveValue('')
    expect(within(reopened).getByTestId('customer-additional-toggle')).toHaveAttribute('aria-expanded', 'false')
    expect(within(reopened).getByLabelText('Email')).not.toBeVisible()
    expect(within(reopened).queryByText('Ingresá un email válido.')).not.toBeInTheDocument()
  })

  it('crear, seleccionar y reabrir limpia formulario y error del servidor', async () => {
    mocks.create
      .mockRejectedValueOnce(new Error('Fallo temporal'))
      .mockResolvedValueOnce({ id: 'nuevo-limpio', name: 'Cliente Seleccionado', phone: '3510000001' })
    const dialog = await openQuickDialog()
    fireEvent.change(within(dialog).getByLabelText('Nombre completo'), { target: { value: 'Cliente Seleccionado' } })
    fireEvent.change(within(dialog).getByLabelText('Teléfono'), { target: { value: '3510000001' } })
    fireEvent.click(within(dialog).getByTestId('customer-additional-toggle'))
    fireEvent.change(within(dialog).getByLabelText('Notas'), { target: { value: 'No debe sobrevivir' } })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Crear cliente' }))
    expect(await within(dialog).findByText('Fallo temporal')).toBeVisible()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Crear cliente' }))

    const selected = await screen.findByRole('button', { name: /Cliente Seleccionado/ })
    expect(selected).toHaveClass('is-selected')
    expect(screen.queryByRole('dialog', { name: 'Crear cliente rápido' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Crear cliente rápido' }))
    const reopened = screen.getByRole('dialog', { name: 'Crear cliente rápido' })
    expect(within(reopened).getByLabelText('Nombre completo')).toHaveValue('')
    expect(within(reopened).getByLabelText('Teléfono')).toHaveValue('')
    expect(within(reopened).getByLabelText('Notas')).toHaveValue('')
    expect(within(reopened).getByTestId('customer-additional-toggle')).toHaveAttribute('aria-expanded', 'false')
    expect(within(reopened).queryByText('Fallo temporal')).not.toBeInTheDocument()
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
