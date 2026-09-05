// ─────────────────────────────────────────────────────────────────────────────
// SEC-08C fase C · LA UI NO OFRECE LO QUE EL SERVIDOR VA A RECHAZAR.
//
// Desde la fase B, registrar un pago a proveedor exige `finance` server-side, y
// una compra con pago inicial exige `inventory` Y `finance`. La pantalla seguía
// ofreciendo las dos cosas a cualquiera que entrara al módulo: el actor
// recorría el modal entero para chocarse con un 42501 al final.
//
// Estos tests fijan el contrato de UX por CAPACIDAD, no por rol: se mueve
// `can('finance')` —la autoridad canónica del cliente, que ya contempla
// overrides de perfil— y se exige que la pantalla lo siga. Ningún test mira
// `role === 'manager'`, porque hardcodear la matriz sería una segunda fuente de
// verdad que se desincroniza con el primer override.
//
// El servidor sigue siendo la autoridad: esto es alineación, no seguridad.
// ─────────────────────────────────────────────────────────────────────────────
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ canFinance: true }))

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ businessId: 'biz-1', user: { id: 'u1' }, role: 'manager', isOwner: false, profile: {} }),
}))
// Se mockea el HOOK canónico, no el rol: el objetivo es probar que la pantalla
// obedece a la capacidad resuelta, venga de un default o de un override.
vi.mock('../../src/hooks/usePermissions', () => ({
  usePermissions: () => ({
    can: (k: string) => (k === 'finance' ? mocks.canFinance : true),
    permissions: {},
  }),
  effectivePermissions: () => ({}),
}))
vi.mock('../../src/hooks/useAppWakeUp', () => ({ useRefreshOnWakeUp: () => {} }))
vi.mock('../../src/lib/supabase', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }) }) },
}))

import { suppliersService } from '../../src/services/suppliersService'
import { Suppliers } from '../../src/pages/Suppliers'

const SUPPLIER = {
  id: 'sup-1', business_id: 'biz-1', name: 'Prov-Uno', active: true,
  created_at: '', updated_at: '',
  total_purchases: 73191, total_paid: 21203, pending_amount: 51988,
  purchases_count: 2, last_purchase_date: '2026-09-01', finance_authorized: true,
}
const PURCHASE = {
  id: 'pur-1', business_id: 'biz-1', supplier_id: 'sup-1', purchase_date: '2026-09-01',
  total_amount: 73191, paid_amount: 21203, pending_amount: 51988,
  payment_status: 'partial' as const, created_at: '', updated_at: '',
}

/** Abre el detalle del proveedor, que es donde viven las acciones de pago. */
async function renderDetail() {
  vi.spyOn(suppliersService, 'getSuppliersWithStats').mockResolvedValue([SUPPLIER as never])
  vi.spyOn(suppliersService, 'getSupplierDebt').mockResolvedValue({
    outstanding: 51988, documents: 1, authorized: true,
  })
  vi.spyOn(suppliersService, 'getPurchases').mockResolvedValue([PURCHASE as never])
  vi.spyOn(suppliersService, 'getPayments').mockResolvedValue([])
  vi.spyOn(suppliersService, 'getAccountMovements').mockResolvedValue([])

  const utils = render(<MemoryRouter><Suppliers /></MemoryRouter>)
  await waitFor(() => expect(screen.getByText('Prov-Uno')).toBeInTheDocument())
  // El detalle se abre por el boton «Ver detalle», no clickeando el nombre.
  fireEvent.click(screen.getByTitle('Ver detalle'))
  await waitFor(() => expect(screen.getByTestId('supplier-summary')).toBeInTheDocument())
  return utils
}

beforeEach(() => { mocks.canFinance = true; vi.restoreAllMocks() })

describe('SEC-08C fase C · actor de COMPRAS sin finance', () => {
  beforeEach(() => { mocks.canFinance = false })

  it('entra a Proveedores y ve la deuda autorizada', async () => {
    await renderDetail()
    // Leer lo que se debe es una operación de compras: NO se le quita.
    expect(screen.getByTestId('supplier-balance')).toBeInTheDocument()
    expect(screen.getByTestId('supplier-summary').textContent).toMatch(/51\.988/)
  })

  it('NO ve la acción de registrar pago en ninguna de sus tres puertas', async () => {
    await renderDetail()
    expect(screen.queryByTestId('supplier-pay-header')).not.toBeInTheDocument()
    expect(screen.queryByTestId('supplier-pay-row')).not.toBeInTheDocument()
    expect(screen.queryByTestId('supplier-pay-tab')).not.toBeInTheDocument()
  })

  it('el modal de pago NO se monta', async () => {
    await renderDetail()
    expect(screen.queryByTestId('supplier-payment-modal')).not.toBeInTheDocument()
  })

  it('conserva «Nueva compra»: comprar a crédito sigue siendo suyo', async () => {
    await renderDetail()
    expect(screen.getByTestId('supplier-new-purchase')).toBeInTheDocument()
  })

  it('el modal de compra retira los controles de pago y lo explica', async () => {
    await renderDetail()
    fireEvent.click(screen.getByTestId('supplier-new-purchase'))
    await waitFor(() => expect(screen.getByTestId('supplier-invoice-modal')).toBeInTheDocument())
    expect(screen.getByTestId('purchase-no-finance-note')).toBeInTheDocument()
    expect(screen.getByText(/la compra se registrará pendiente/i)).toBeInTheDocument()
    // Sin controles: ni estados de pago, ni método, ni monto.
    expect(screen.queryByText('Estado de pago')).not.toBeInTheDocument()
    expect(screen.queryByText('Método de pago')).not.toBeInTheDocument()
    expect(screen.queryByText('Pagado ahora')).not.toBeInTheDocument()
  })
})

describe('SEC-08C fase C · actor con finance', () => {
  beforeEach(() => { mocks.canFinance = true })

  it('ve las acciones de pago', async () => {
    await renderDetail()
    expect(screen.getByTestId('supplier-pay-header')).toBeInTheDocument()
    expect(screen.getByTestId('supplier-pay-row')).toBeInTheDocument()
  })

  it('el modal de compra ofrece el pago inicial', async () => {
    await renderDetail()
    fireEvent.click(screen.getByTestId('supplier-new-purchase'))
    await waitFor(() => expect(screen.getByTestId('supplier-invoice-modal')).toBeInTheDocument())
    expect(screen.getByText('Estado de pago')).toBeInTheDocument()
    expect(screen.getByText('Método de pago')).toBeInTheDocument()
    expect(screen.queryByTestId('purchase-no-finance-note')).not.toBeInTheDocument()
  })
})

describe('SEC-08C fase C · la UI sigue al OVERRIDE, no al rol', () => {
  it('el mismo rol cambia de comportamiento cuando cambia la capacidad', async () => {
    // El mock de useAuth devuelve SIEMPRE role='manager'. Lo único que se mueve
    // entre las dos mitades es `can('finance')`. Si la pantalla mirara el rol,
    // este test no podría pasar.
    mocks.canFinance = false
    const a = await renderDetail()
    expect(screen.queryByTestId('supplier-pay-header')).not.toBeInTheDocument()
    a.unmount()

    vi.restoreAllMocks()
    mocks.canFinance = true
    await renderDetail()
    expect(screen.getByTestId('supplier-pay-header')).toBeInTheDocument()
  })
})
