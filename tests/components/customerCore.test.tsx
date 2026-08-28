// ─────────────────────────────────────────────────────────────────────────────
// UI-CONSISTENCY-1 · Customer core canónico.
//
// Lo que se prueba acá NO es cómo se ve cada pantalla — se ven distinto a
// propósito. Se prueba que las tres superficies que escriben clientes
// (alta full page, alta rápida de Nueva Orden, edición desde la lista)
// apliquen LAS MISMAS reglas.
// ─────────────────────────────────────────────────────────────────────────────
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  EMPTY_CUSTOMER_CORE,
  applyCustomerType,
  customerCoreFromRecord,
  documentSearchTokens,
  formatStoredDocument,
  normalizeDocumentInput,
  parseStoredDocument,
  toCreatePayload,
  toUpdatePayload,
  validateCustomerCore,
  type CustomerCoreValues,
} from '../../src/features/customer-core'

const mocks = vi.hoisted(() => ({
  customerCreate: vi.fn(),
  customerUpdate: vi.fn(),
  getAll: vi.fn(),
  loadProfiles: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock('../../src/services/api', () => ({
  customersService: {
    getAll: mocks.getAll,
    create: mocks.customerCreate,
    update: mocks.customerUpdate,
  },
}))
vi.mock('../../src/hooks/usePermissions', () => ({
  usePermissions: () => ({ can: () => true }),
  effectivePermissions: () => ({ orders_create: true }),
}))
vi.mock('../../src/features/order-intake/service', () => ({
  createOrderIntake: vi.fn(),
  uploadIntakePhotos: vi.fn(),
  loadAssignableProfiles: mocks.loadProfiles,
}))
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => mocks.navigate }
})

import { NewCustomer } from '../../src/pages/NewCustomer'
import { NewOrder } from '../../src/pages/NewOrder'

const values = (patch: Partial<CustomerCoreValues> = {}): CustomerCoreValues => ({
  ...EMPTY_CUSTOMER_CORE,
  name: 'Juan Pérez',
  phone: '3512345678',
  ...patch,
})

beforeEach(() => {
  mocks.customerCreate.mockReset().mockImplementation(async (payload) => ({ id: 'new-id', ...payload }))
  mocks.customerUpdate.mockReset().mockResolvedValue({ id: 'c1' })
  mocks.getAll.mockReset().mockResolvedValue([])
  mocks.loadProfiles.mockReset().mockResolvedValue([])
  mocks.navigate.mockReset()
})

// ── Normalización del documento ─────────────────────────────────────────────
describe('documento · formato canónico', () => {
  it('normaliza a `<TIPO> <cuerpo>` sin separadores', () => {
    expect(normalizeDocumentInput('dni', '30.123.456')).toBe('DNI 30123456')
    expect(normalizeDocumentInput('cuit', '20-30123456-7')).toBe('CUIT 20301234567')
  })

  it('devuelve undefined cuando no hay documento que guardar', () => {
    expect(normalizeDocumentInput('dni', '')).toBeUndefined()
    expect(normalizeDocumentInput('dni', '   ')).toBeUndefined()
    expect(normalizeDocumentInput('dni', '-.-')).toBeUndefined()
  })

  it('NO descarta letras: un pasaporte no se convierte en un DNI truncado', () => {
    expect(normalizeDocumentInput('dni', 'AB-123456')).toBe('DNI AB123456')
  })

  it('lee las formas históricas sin migrar ninguna fila', () => {
    // Legacy NewCustomer.
    expect(parseStoredDocument('DNI: 30.123.456')).toEqual({ type: 'dni', body: '30123456', digits: '30123456' })
    // Legacy alta rápida / import de Excel: sin tipo declarado.
    expect(parseStoredDocument('30.123.456')).toEqual({ type: null, body: '30123456', digits: '30123456' })
    // Canónico.
    expect(parseStoredDocument('CUIT 20301234567')).toEqual({ type: 'cuit', body: '20301234567', digits: '20301234567' })
    expect(parseStoredDocument(null)).toEqual({ type: null, body: '', digits: '' })
  })

  it('no le inventa un tipo a una fila que nunca lo declaró', () => {
    expect(formatStoredDocument('30.123.456')).toBe('30123456')
    expect(formatStoredDocument('DNI: 30.123.456')).toBe('DNI 30123456')
    expect(formatStoredDocument('')).toBe('')
  })

  it('expone los dígitos que ARCA necesita como DocNro', () => {
    // comprobanteService todavía manda 99/0 fijo, pero cuando ese lote llegue
    // el dato tiene que ser reconstruible desde la fila.
    expect(parseStoredDocument('CUIT 20-30123456-7').digits).toBe('20301234567')
    expect(parseStoredDocument('DNI: 30.123.456').digits).toBe('30123456')
  })

  it('busca contra todas las representaciones que conviven en la tabla', () => {
    const historic = documentSearchTokens('DNI: 30.123.456')
    const canonical = documentSearchTokens('DNI 30123456')
    // Una fila histórica se encuentra tipeando el número sin puntos…
    expect(historic).toContain('30123456')
    // …y sigue encontrándose tipeándolo como fue guardado.
    expect(historic).toContain('DNI: 30.123.456')
    expect(canonical).toContain('30123456')
    expect(documentSearchTokens('')).toEqual([])
  })
})

// ── Regla de mayorista ──────────────────────────────────────────────────────
describe('regla de mayorista', () => {
  it('mayorista SIN razón social no valida al crear', () => {
    const errors = validateCustomerCore(values({ customerType: 'mayorista' }), 'create')
    expect(errors.businessName).toBeTruthy()
  })

  it('mayorista SIN razón social no valida al editar', () => {
    // Éste era el agujero: la edición no conocía el campo, así que dejaba
    // mayoristas inválidos que ninguna de las dos altas permitía crear.
    const errors = validateCustomerCore(values({ customerType: 'mayorista' }), 'update')
    expect(errors.businessName).toBeTruthy()
  })

  it('minorista NO exige razón social', () => {
    expect(validateCustomerCore(values(), 'create').businessName).toBeUndefined()
    expect(validateCustomerCore(values(), 'update').businessName).toBeUndefined()
  })

  it('mayorista CON razón social valida en ambos modos', () => {
    const wholesale = values({ customerType: 'mayorista', businessName: 'Comercio Demo' })
    expect(validateCustomerCore(wholesale, 'create')).toEqual({})
    expect(validateCustomerCore(wholesale, 'update')).toEqual({})
  })

  it('el teléfono se exige al crear, no al editar', () => {
    // Preserva el comportamiento actual de cada superficie: las dos altas ya
    // lo pedían; la edición nunca lo pidió y hay filas históricas sin teléfono.
    expect(validateCustomerCore(values({ phone: '' }), 'create').phone).toBeTruthy()
    expect(validateCustomerCore(values({ phone: '' }), 'update').phone).toBeUndefined()
  })

  it('el email es opcional, pero si se informa usa la regla explícita de creación', () => {
    expect(validateCustomerCore(values({ email: '' }), 'create').email).toBeUndefined()
    expect(validateCustomerCore(values({ email: '   ' }), 'create').email).toBeUndefined()
    expect(validateCustomerCore(values({ email: 'cliente@example.com' }), 'create').email).toBeUndefined()
    expect(validateCustomerCore(values({ email: 'email-invalido' }), 'create').email).toBe('Ingresá un email válido.')
  })

  it('no endurece retroactivamente la edición de emails históricos', () => {
    expect(validateCustomerCore(values({ email: 'email-historico' }), 'update').email).toBeUndefined()
  })
})

// ── Limpieza mayorista → minorista ──────────────────────────────────────────
describe('cambio de tipo de cliente', () => {
  it('descarta los campos mayoristas al volver a minorista', () => {
    const wholesale = values({ customerType: 'mayorista', businessName: 'Comercio Demo', contactPerson: 'Ana' })
    const retail = applyCustomerType(wholesale, 'minorista')
    expect(retail.businessName).toBe('')
    expect(retail.contactPerson).toBe('')
  })

  it('el payload de EDICIÓN manda null explícito para borrar la fila', () => {
    // `undefined` no alcanza: PostgREST omite la clave y la razón social vieja
    // sobrevive pegada a un cliente que ya es minorista.
    const retail = applyCustomerType(
      values({ customerType: 'mayorista', businessName: 'Comercio Demo', contactPerson: 'Ana' }),
      'minorista'
    )
    const payload = toUpdatePayload(retail)
    expect(payload.business_name).toBeNull()
    expect(payload.contact_person).toBeNull()
    expect(payload.customer_type).toBe('minorista')
  })

  it('arrastra el tipo de documento al default del tipo de cliente', () => {
    expect(applyCustomerType(values(), 'mayorista').documentType).toBe('cuit')
    expect(applyCustomerType(values({ customerType: 'mayorista' }), 'minorista').documentType).toBe('dni')
  })

  it('un minorista nunca persiste campos mayoristas aunque queden en el formulario', () => {
    const dirty = values({ customerType: 'minorista', businessName: 'Sobra', contactPerson: 'Sobra' })
    expect(toCreatePayload(dirty).business_name).toBeUndefined()
    expect(toUpdatePayload(dirty).business_name).toBeNull()
  })
})

// ── Hidratación desde una fila existente ────────────────────────────────────
describe('hidratación para edición', () => {
  it('no pierde razón social, documento ni persona de contacto', () => {
    const hydrated = customerCoreFromRecord({
      name: 'Comercio Demo', phone: '351', customer_type: 'mayorista',
      business_name: 'Demo SRL', contact_person: 'Ana', document: 'CUIT 20301234567',
      address: 'Av. Corrientes 1234', notes: 'Cliente viejo',
    })
    expect(hydrated).toMatchObject({
      customerType: 'mayorista', businessName: 'Demo SRL', contactPerson: 'Ana',
      documentType: 'cuit', document: '20301234567',
      address: 'Av. Corrientes 1234', notes: 'Cliente viejo',
    })
  })

  it('una fila sin tipo declarado cae al default del tipo de cliente', () => {
    expect(customerCoreFromRecord({ document: '30123456', customer_type: 'minorista' }).documentType).toBe('dni')
    expect(customerCoreFromRecord({ document: '20301234567', customer_type: 'mayorista' }).documentType).toBe('cuit')
  })
})

// ── Paridad real entre las dos superficies de alta ──────────────────────────
describe('paridad full page ↔ alta rápida', () => {
  const DOCUMENT_INPUT = '30.123.456'

  async function createFromFullPage() {
    const view = render(<MemoryRouter><NewCustomer /></MemoryRouter>)
    fireEvent.change(screen.getByTestId('customer-name-input'), { target: { value: 'Juan Pérez' } })
    fireEvent.change(screen.getByTestId('customer-phone-input'), { target: { value: '3512345678' } })
    fireEvent.change(screen.getByTestId('customer-document-input'), { target: { value: DOCUMENT_INPUT } })
    fireEvent.change(screen.getByTestId('customer-address-input'), { target: { value: 'Av. Corrientes 1234' } })
    fireEvent.click(screen.getByTestId('customer-save-button'))
    await waitFor(() => expect(mocks.customerCreate).toHaveBeenCalled())
    const payload = mocks.customerCreate.mock.calls[0][0]
    view.unmount()
    return payload
  }

  async function createFromQuickDialog() {
    const view = render(<MemoryRouter><NewOrder /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'Crear cliente rápido' }))
    fireEvent.change(screen.getByLabelText('Nombre completo'), { target: { value: 'Juan Pérez' } })
    fireEvent.change(screen.getByLabelText('Teléfono'), { target: { value: '3512345678' } })
    fireEvent.change(screen.getByLabelText('DNI'), { target: { value: DOCUMENT_INPUT } })
    fireEvent.click(screen.getByRole('button', { name: 'Crear cliente' }))
    await waitFor(() => expect(mocks.customerCreate).toHaveBeenCalled())
    const payload = mocks.customerCreate.mock.calls[0][0]
    view.unmount()
    return payload
  }

  it('las dos altas normalizan el MISMO documento al mismo valor', async () => {
    const full = await createFromFullPage()
    mocks.customerCreate.mockClear()
    const quick = await createFromQuickDialog()

    // Antes: NewCustomer guardaba "DNI: 30.123.456" y el alta rápida "30.123.456".
    expect(full.document).toBe('DNI 30123456')
    expect(quick.document).toBe('DNI 30123456')
  })

  it('los campos compartidos quedan semánticamente idénticos', async () => {
    const full = await createFromFullPage()
    mocks.customerCreate.mockClear()
    const quick = await createFromQuickDialog()

    for (const field of ['name', 'phone', 'document', 'customer_type'] as const) {
      expect(quick[field]).toEqual(full[field])
    }
  })

  it('la dirección sobrevive al alta full page', async () => {
    const full = await createFromFullPage()
    expect(full.address).toBe('Av. Corrientes 1234')
  })

  it('el alta rápida devuelve el Customer creado al wizard', async () => {
    render(<MemoryRouter><NewOrder /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'Crear cliente rápido' }))
    fireEvent.change(screen.getByLabelText('Nombre completo'), { target: { value: 'Cliente Rápido' } })
    fireEvent.change(screen.getByLabelText('Teléfono'), { target: { value: '3512345678' } })
    fireEvent.click(screen.getByRole('button', { name: 'Crear cliente' }))

    // Vuelve seleccionado en el paso Cliente, que es el contrato con NewOrder.
    expect(await screen.findByText('Cliente Rápido')).toBeInTheDocument()
  })

  it('el alta full page conserva sus data-testid', () => {
    render(<MemoryRouter><NewCustomer /></MemoryRouter>)
    expect(screen.getByTestId('customer-name-input')).toBeInTheDocument()
    expect(screen.getByTestId('customer-phone-input')).toBeInTheDocument()
    expect(screen.getByTestId('customer-save-button')).toBeInTheDocument()
  })

  it('el alta full page bloquea el guardado de un mayorista sin razón social', async () => {
    render(<MemoryRouter><NewCustomer /></MemoryRouter>)
    fireEvent.change(screen.getByTestId('customer-name-input'), { target: { value: 'Comercio Demo' } })
    fireEvent.change(screen.getByTestId('customer-phone-input'), { target: { value: '3512345678' } })
    fireEvent.click(screen.getByTestId('customer-type-mayorista'))

    expect(screen.getByTestId('customer-save-button')).toBeDisabled()

    fireEvent.change(screen.getByTestId('customer-business-name-input'), { target: { value: 'Demo SRL' } })
    expect(screen.getByTestId('customer-save-button')).not.toBeDisabled()
  })

  it('elegir mayorista pasa el documento a CUIT en las dos superficies', async () => {
    const fullPage = render(<MemoryRouter><NewCustomer /></MemoryRouter>)
    fireEvent.click(screen.getByTestId('customer-type-mayorista'))
    expect(screen.getByTestId('customer-document-type-cuit')).toHaveAttribute('aria-pressed', 'true')
    fullPage.unmount()

    render(<MemoryRouter><NewOrder /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'Crear cliente rápido' }))
    fireEvent.click(screen.getByTestId('customer-type-mayorista'))
    expect(screen.getByTestId('customer-document-type-cuit')).toHaveAttribute('aria-pressed', 'true')
  })
})

// ── Barreras de seguridad ───────────────────────────────────────────────────
describe('límites del lote', () => {
  it('el payload sólo toca columnas de `customers`', () => {
    const keys = new Set([
      ...Object.keys(toCreatePayload(values())),
      ...Object.keys(toUpdatePayload(values())),
    ])
    // Ni negocio, ni autoría, ni nada financiero: eso lo pone el servicio o la DB.
    for (const forbidden of ['business_id', 'created_by', 'id', 'created_at', 'updated_at', 'active', 'city']) {
      expect(keys.has(forbidden)).toBe(false)
    }
    expect([...keys].sort()).toEqual([
      'address', 'business_name', 'contact_person', 'customer_type',
      'document', 'email', 'name', 'notes', 'phone',
    ])
  })

  it('customer_type sólo emite valores que acepta el CHECK de la DB', () => {
    // customers_customer_type_check = minorista | mayorista.
    expect(toCreatePayload(values({ customerType: 'mayorista', businessName: 'X' })).customer_type).toBe('mayorista')
    expect(toCreatePayload(values()).customer_type).toBe('minorista')
    expect(customerCoreFromRecord({ customer_type: 'basura-inesperada' }).customerType).toBe('minorista')
  })

  it('el core es puro: no escribe nada por su cuenta', () => {
    toCreatePayload(values())
    toUpdatePayload(values())
    expect(mocks.customerCreate).not.toHaveBeenCalled()
    expect(mocks.customerUpdate).not.toHaveBeenCalled()
  })
})
