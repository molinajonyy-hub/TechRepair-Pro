// ─────────────────────────────────────────────────────────────────────────────
// UI-CONSISTENCY-1 · Edición de cliente conectada al core.
//
// Antes esta pantalla no conocía razón social, persona de contacto ni documento.
// Se podía marcar a un cliente como mayorista y guardarlo SIN razón social —
// dato que ninguna de las dos altas permitía crear. Estos tests prueban el
// cableado real de la superficie, no sólo el core.
// ─────────────────────────────────────────────────────────────────────────────
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAll: vi.fn(),
  update: vi.fn(),
  ordersQuery: vi.fn(),
}))

vi.mock('../../src/services/api', () => ({
  customersService: { getAll: mocks.getAll, update: mocks.update },
}))
vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ businessId: 'biz-1' }),
}))
vi.mock('../../src/contexts/LoadingContext', () => ({
  useLoading: () => ({ showLoading: vi.fn(), hideLoading: vi.fn() }),
}))
vi.mock('../../src/hooks/useAppWakeUp', () => ({ useRefreshOnWakeUp: () => {} }))
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ limit: () => mocks.ordersQuery() }) }),
    }),
  },
}))

import { Customers } from '../../src/pages/Customers'

const WHOLESALE_ROW = {
  id: 'c1',
  name: 'Comercio Demo',
  phone: '3512345678',
  email: 'demo@demo.com',
  address: 'Av. Corrientes 1234',
  notes: 'Cliente viejo',
  document: 'CUIT 20301234567',
  customer_type: 'mayorista',
  business_name: 'Demo SRL',
  contact_person: 'Ana',
}

const RETAIL_ROW = { id: 'c2', name: 'Juan Pérez', phone: '351', customer_type: 'minorista' }

async function openEditor(row: Record<string, unknown> = WHOLESALE_ROW) {
  mocks.getAll.mockResolvedValue([row])
  render(<MemoryRouter><Customers /></MemoryRouter>)
  fireEvent.click(await screen.findByTitle('Editar cliente'))
  await screen.findByText('Editar Cliente')
}

const saveButton = () => screen.getByTestId('customer-edit-save-button')

beforeEach(() => {
  mocks.getAll.mockReset()
  mocks.update.mockReset().mockResolvedValue({ id: 'c1' })
  mocks.ordersQuery.mockReset().mockResolvedValue({ data: [] })
})

describe('UI-CONSISTENCY-1 · edición de cliente', () => {
  it('hidrata los campos que la pantalla antes ni conocía', async () => {
    await openEditor()

    expect(screen.getByTestId('customer-edit-business-name-input')).toHaveValue('Demo SRL')
    expect(screen.getByTestId('customer-edit-contact-person-input')).toHaveValue('Ana')
    expect(screen.getByTestId('customer-edit-document-input')).toHaveValue('20301234567')
    expect(screen.getByTestId('customer-edit-document-type-cuit')).toHaveAttribute('aria-pressed', 'true')
    // Y no pierde lo que ya mostraba.
    expect(screen.getByTestId('customer-edit-address-input')).toHaveValue('Av. Corrientes 1234')
    expect(screen.getByTestId('customer-edit-notes-input')).toHaveValue('Cliente viejo')
  })

  it('NO deja guardar un mayorista sin razón social', async () => {
    await openEditor()

    fireEvent.change(screen.getByTestId('customer-edit-business-name-input'), { target: { value: '' } })

    expect(screen.getByRole('alert')).toHaveTextContent('Un cliente mayorista necesita razón social.')
    expect(saveButton()).toBeDisabled()

    fireEvent.click(saveButton())
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('tampoco deja convertir un minorista en mayorista sin razón social', async () => {
    // El camino exacto del bug reportado: la pantalla ofrecía el botón
    // "Mayorista" y no tenía dónde cargar la razón social.
    await openEditor(RETAIL_ROW)

    fireEvent.click(screen.getByTestId('customer-edit-type-mayorista'))

    expect(screen.getByRole('alert')).toHaveTextContent('Un cliente mayorista necesita razón social.')
    expect(saveButton()).toBeDisabled()

    fireEvent.click(saveButton())
    expect(mocks.update).not.toHaveBeenCalled()

    // Y con razón social vuelve a poder guardarse.
    fireEvent.change(screen.getByTestId('customer-edit-business-name-input'), { target: { value: 'Demo SRL' } })
    expect(saveButton()).not.toBeDisabled()
  })

  it('un minorista NO necesita razón social', async () => {
    await openEditor(RETAIL_ROW)

    expect(saveButton()).not.toBeDisabled()
    fireEvent.click(saveButton())

    await waitFor(() => expect(mocks.update).toHaveBeenCalled())
    expect(mocks.update.mock.calls[0][1]).toMatchObject({ customer_type: 'minorista', business_name: null })
  })

  it('pasar de mayorista a minorista BORRA la razón social en la fila', async () => {
    await openEditor()

    fireEvent.click(screen.getByTestId('customer-edit-type-minorista'))
    fireEvent.click(saveButton())

    await waitFor(() => expect(mocks.update).toHaveBeenCalled())
    const [id, payload] = mocks.update.mock.calls[0]
    expect(id).toBe('c1')
    // null explícito, no undefined: con undefined PostgREST omite la clave y
    // la razón social vieja sobrevive pegada a un cliente que ya es minorista.
    expect(payload.business_name).toBeNull()
    expect(payload.contact_person).toBeNull()
    expect(payload.customer_type).toBe('minorista')
  })

  it('normaliza el documento igual que las dos altas', async () => {
    await openEditor()

    fireEvent.change(screen.getByTestId('customer-edit-document-input'), { target: { value: '20-30123456-7' } })
    fireEvent.click(saveButton())

    await waitFor(() => expect(mocks.update).toHaveBeenCalled())
    expect(mocks.update.mock.calls[0][1].document).toBe('CUIT 20301234567')
  })

  it('conserva dirección y notas al guardar', async () => {
    await openEditor()

    fireEvent.click(saveButton())

    await waitFor(() => expect(mocks.update).toHaveBeenCalled())
    expect(mocks.update.mock.calls[0][1]).toMatchObject({
      address: 'Av. Corrientes 1234',
      notes: 'Cliente viejo',
    })
  })

  it('no escribe nada financiero ni de tenant', async () => {
    await openEditor()
    fireEvent.click(saveButton())

    await waitFor(() => expect(mocks.update).toHaveBeenCalled())
    const payload = mocks.update.mock.calls[0][1]
    for (const forbidden of ['business_id', 'created_by', 'id', 'active', 'balance', 'total_cost']) {
      expect(payload).not.toHaveProperty(forbidden)
    }
  })
})
