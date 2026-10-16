// ─────────────────────────────────────────────────────────────────────────────
// CLIENTES-UX-1A · Edición de clientes desde el listado y desde la ficha.
//
// Diagnóstico (ver docs/clientes-ux-1/README.md): el owner no podía editar
// correctamente porque
//   1. la ficha individual no tenía ninguna forma de editar;
//   2. un mayorista histórico sin razón social (los que crea el portal) no se
//      podía guardar con acceso Mayorista —sí sin él— ni para corregir el
//      teléfono;
//   3. guardar no confirmaba nada y la ficha no mostraba documento ni notas;
//   4. los errores del servidor llegaban crudos.
// ─────────────────────────────────────────────────────────────────────────────
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAll: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  ordersQuery: vi.fn(),
}))

vi.mock('../../src/services/api', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/api')>('../../src/services/api')
  return {
    getCustomerErrorMessage: actual.getCustomerErrorMessage,
    customersService: { getAll: mocks.getAll, getById: mocks.getById, update: mocks.update },
  }
})
vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({
    businessId: 'biz-1', user: { id: 'u-1' }, role: 'owner', isOwner: true,
    hasBusinessAccess: true, profile: { permissions: null },
  }),
}))
// Owner en un negocio Full: el gate Mayorista está abierto (acceso `full`).
vi.mock('../../src/hooks/useSubscription', async () => {
  const { resolveEntitlement } = await vi.importActual<typeof import('../../src/lib/entitlements')>('../../src/lib/entitlements')
  const subscription = { subscription_status: 'active', subscription_plan: 'full' } as const
  const { hasFeature } = resolveEntitlement(subscription)
  return { useSubscription: () => ({ hasFeature, subscription, loading: false }) }
})
vi.mock('../../src/contexts/LoadingContext', () => ({
  useLoading: () => ({ showLoading: vi.fn(), hideLoading: vi.fn() }),
}))
vi.mock('../../src/hooks/useAppWakeUp', () => ({ useRefreshOnWakeUp: () => {} }))
vi.mock('../../src/services/cuentasService', () => ({
  cuentasService: { getAccounts: async () => [] },
  getAccountStatus: () => 'al_dia',
}))
vi.mock('../../src/components/whatsapp/WhatsAppActionButton', () => ({
  WhatsAppActionButton: () => <button type="button">WhatsApp</button>,
}))
vi.mock('../../src/components/comprobantes/ModalPagarCC', () => ({ ModalPagarCC: () => null }))
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ limit: () => mocks.ordersQuery() }) }),
    }),
    rpc: async () => ({ data: null, error: null }),
  },
}))

import { getCustomerErrorMessage } from '../../src/services/api'
import { validateCustomerCore, EMPTY_CUSTOMER_CORE } from '../../src/features/customer-core'
import { Customers } from '../../src/pages/Customers'
import { CustomerDetail } from '../../src/pages/CustomerDetail'

const RETAIL = {
  id: 'c-retail',
  name: 'Juan Pérez',
  phone: '3511234567',
  email: null,
  address: 'Av. Colón 100',
  notes: null,
  document: 'DNI 30111222',
  customer_type: 'minorista',
  business_name: null,
  contact_person: null,
  orders: [],
  devices: [],
}

// Como lo crea `get_or_create_customer_from_wholesale_atomic`: mayorista con
// `business_name` NULL cuando el cliente del portal no la cargó.
const PORTAL_WHOLESALE = {
  id: 'c-portal',
  name: 'Mayorista Portal',
  phone: '',
  email: 'portal@example.test',
  address: null,
  notes: null,
  document: null,
  customer_type: 'mayorista',
  business_name: null,
  contact_person: null,
}

function renderDetail(row: Record<string, unknown> = RETAIL) {
  mocks.getById.mockResolvedValue(row)
  return render(
    <MemoryRouter initialEntries={[`/customers/${String(row.id)}`]}>
      <Routes><Route path="/customers/:id" element={<CustomerDetail />} /></Routes>
    </MemoryRouter>
  )
}

async function openDetailEditor(row: Record<string, unknown> = RETAIL) {
  renderDetail(row)
  fireEvent.click(await screen.findByRole('button', { name: 'Editar cliente' }))
  return screen.findByRole('dialog', { name: 'Editar Cliente' })
}

beforeEach(() => {
  mocks.getAll.mockReset()
  mocks.getById.mockReset()
  mocks.update.mockReset()
  mocks.ordersQuery.mockReset().mockResolvedValue({ data: [] })
})

describe('A · ficha individual: «Editar cliente»', () => {
  it('A1 · el botón está a la vista y abre el diálogo hidratado con la ficha', async () => {
    const dialog = await openDetailEditor()

    expect(within(dialog).getByTestId('customer-name-input')).toHaveValue('Juan Pérez')
    expect(within(dialog).getByTestId('customer-phone-input')).toHaveValue('3511234567')
    expect(within(dialog).getByTestId('customer-document-input')).toHaveValue('30111222')
    expect(within(dialog).getByTestId('customer-address-input')).toHaveValue('Av. Colón 100')
  })

  it('A2 · guarda, confirma y la ficha muestra lo guardado sin recargar', async () => {
    mocks.update.mockImplementation(async (id: string, payload: Record<string, unknown>) => ({ ...RETAIL, id, ...payload }))
    const dialog = await openDetailEditor()

    fireEvent.change(within(dialog).getByTestId('customer-phone-input'), { target: { value: '3517654321' } })
    fireEvent.change(within(dialog).getByTestId('customer-notes-input'), { target: { value: 'Prefiere WhatsApp' } })
    fireEvent.click(within(dialog).getByTestId('customer-edit-save-button'))

    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1))
    expect(mocks.update.mock.calls[0][0]).toBe('c-retail')
    expect(mocks.update.mock.calls[0][1]).toMatchObject({ phone: '3517654321', notes: 'Prefiere WhatsApp', document: 'DNI 30111222' })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByTestId('customer-saved-notice')).toHaveTextContent('Cambios guardados.')
    expect(screen.getByText('3517654321')).toBeInTheDocument()
    expect(screen.getByTestId('customer-detail-notes')).toHaveTextContent('Prefiere WhatsApp')
    expect(screen.getByTestId('customer-detail-document')).toHaveTextContent('DNI 30111222')
  })

  it('A3 · un error del servidor se explica en el diálogo, que sigue abierto', async () => {
    mocks.update.mockRejectedValue(new Error(getCustomerErrorMessage({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }, 'actualizar')))
    const dialog = await openDetailEditor()

    fireEvent.click(within(dialog).getByTestId('customer-edit-save-button'))

    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent('el cliente ya no existe o no tenés permiso para editarlo')
    expect(alert.textContent).not.toMatch(/JSON object|PGRST/)
    expect(screen.getByRole('dialog', { name: 'Editar Cliente' })).toBeInTheDocument()
    expect(screen.getByTestId('customer-saved-notice')).toBeEmptyDOMElement()
    // Reintentar vuelve a llamar al servicio: el bloqueo de doble envío se libera.
    fireEvent.click(within(dialog).getByTestId('customer-edit-save-button'))
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2))
  })

  it('A4 · Cancelar no escribe y la ficha queda como estaba', async () => {
    const dialog = await openDetailEditor()
    fireEvent.change(within(dialog).getByTestId('customer-phone-input'), { target: { value: '000' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(mocks.update).not.toHaveBeenCalled()
    expect(screen.getByText('3511234567')).toBeInTheDocument()
  })

  it('A5 · la ficha de un mayorista muestra razón social y contacto', async () => {
    renderDetail({ ...RETAIL, customer_type: 'mayorista', business_name: 'Demo SRL', contact_person: 'Ana' })
    expect(await screen.findByTestId('customer-detail-wholesale')).toHaveTextContent('Demo SRL')
    expect(screen.getByTestId('customer-detail-wholesale')).toHaveTextContent('Contacto: Ana')
  })
})

describe('B · listado: confirmación visible', () => {
  it('B1 · guardar cierra el diálogo, confirma con el nombre y recarga la lista', async () => {
    mocks.getAll.mockResolvedValueOnce([RETAIL]).mockResolvedValue([{ ...RETAIL, phone: '3519999999' }])
    mocks.update.mockImplementation(async (id: string, payload: Record<string, unknown>) => ({ ...RETAIL, id, ...payload }))
    render(<MemoryRouter><Customers /></MemoryRouter>)

    fireEvent.click(await screen.findByTitle('Editar cliente'))
    const dialog = await screen.findByRole('dialog', { name: 'Editar Cliente' })
    fireEvent.change(within(dialog).getByTestId('customer-phone-input'), { target: { value: '3519999999' } })
    fireEvent.click(within(dialog).getByTestId('customer-edit-save-button'))

    await waitFor(() => expect(screen.getByTestId('customer-saved-notice')).toHaveTextContent('Cambios guardados en Juan Pérez.'))
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(mocks.getAll).toHaveBeenCalledTimes(2))
    expect(await screen.findAllByText('3519999999')).not.toHaveLength(0)
  })
})

describe('C · mayorista histórico sin razón social', () => {
  it('C1 · el owner (acceso Mayorista) corrige el teléfono sin inventar una razón social', async () => {
    mocks.update.mockImplementation(async (id: string, payload: Record<string, unknown>) => ({ ...PORTAL_WHOLESALE, id, ...payload }))
    const dialog = await openDetailEditor(PORTAL_WHOLESALE)

    fireEvent.change(within(dialog).getByTestId('customer-phone-input'), { target: { value: '3515550000' } })
    fireEvent.click(within(dialog).getByTestId('customer-edit-save-button'))

    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1))
    // Sigue mayorista y sin razón social: nada se convierte ni se inventa.
    expect(mocks.update.mock.calls[0][1]).toMatchObject({
      phone: '3515550000', customer_type: 'mayorista', business_name: null, contact_person: null,
    })
  })

  it('C2 · si se le carga razón social, se guarda', async () => {
    mocks.update.mockImplementation(async (id: string, payload: Record<string, unknown>) => ({ ...PORTAL_WHOLESALE, id, ...payload }))
    const dialog = await openDetailEditor(PORTAL_WHOLESALE)

    fireEvent.change(within(dialog).getByTestId('customer-business-name-input'), { target: { value: 'Portal SRL' } })
    fireEvent.click(within(dialog).getByTestId('customer-edit-save-button'))

    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1))
    expect(mocks.update.mock.calls[0][1]).toMatchObject({ business_name: 'Portal SRL' })
  })

  it('C3 · la regla del core: sólo exime al mayorista que YA no tenía razón social', () => {
    const wholesale = { ...EMPTY_CUSTOMER_CORE, name: 'X', customerType: 'mayorista' as const }
    // Histórico sin razón social: editable.
    expect(validateCustomerCore(wholesale, 'update', 'full', { customerType: 'mayorista', businessName: '' })).toEqual({})
    // Borrar una razón social guardada: bloqueado.
    expect(validateCustomerCore(wholesale, 'update', 'full', { customerType: 'mayorista', businessName: 'Demo SRL' }).businessName)
      .toBe('Un cliente mayorista necesita razón social.')
    // Convertir un minorista en mayorista sin razón social: bloqueado.
    expect(validateCustomerCore(wholesale, 'update', 'full', { customerType: 'minorista', businessName: '' }).businessName)
      .toBe('Un cliente mayorista necesita razón social.')
    // Un alta mayorista sigue exigiéndola siempre.
    expect(validateCustomerCore(wholesale, 'create', 'full').businessName).toBe('Un cliente mayorista necesita razón social.')
  })
})

describe('D · errores comprensibles', () => {
  it.each([
    [{ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }, 'actualizar', 'No se pudo guardar: el cliente ya no existe o no tenés permiso para editarlo.'],
    [{ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }, 'obtener', 'No encontramos este cliente en tu negocio.'],
    [{ code: '42501', message: 'new row violates row-level security policy for table "customers"' }, 'actualizar', 'No tenés permiso para editar clientes en este negocio.'],
    [{ code: '42501', message: 'WHOLESALE_AUTHORITY_REQUIRED: cambiar la clasificacion mayorista requiere acceso Mayorista' }, 'actualizar', 'Cambiar el tipo de cliente o sus datos mayoristas requiere acceso a Mayorista.'],
    [{ code: '23502', message: 'null value in column "name" violates not-null constraint' }, 'actualizar', 'Faltan datos obligatorios del cliente.'],
    [new TypeError('Failed to fetch'), 'actualizar', 'No pudimos conectar con el servidor.'],
  ])('D · %o (%s)', (error, action, expected) => {
    const message = getCustomerErrorMessage(error, action)
    expect(message).toContain(expected)
    expect(message).not.toMatch(/PGRST|JSON object|row-level|WHOLESALE_AUTHORITY|políticas de customers/)
  })

  it('D · un mensaje ya legible pasa tal cual', () => {
    expect(getCustomerErrorMessage({ code: 'CLIENT_UPDATE_REQUIRED', message: 'Actualizá la aplicación para continuar.' }, 'actualizar'))
      .toBe('Actualizá la aplicación para continuar.')
  })
})
