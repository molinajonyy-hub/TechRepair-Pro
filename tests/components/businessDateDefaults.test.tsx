// FINANCE BUSINESS DATE 2A · los defaults de fecha que se GRABAN usan la fecha
// de negocio argentina.
//
// Bug: los formularios financieros arrancaban su campo de fecha con
// `new Date().toISOString().split('T')[0]`, que pasa a UTC. Despues de las
// 21:00 AR eso ya es el dia siguiente: el form proponia MAÑANA y, si el
// usuario no lo tocaba, la fecha financiera se grababa corrida.
//
// Superficies (todas escriben esa fecha en la base):
//   · Gastos ▸ General       fecha    -> create_expense_with_finance(p_date)
//   · Gastos ▸ Factura       facFecha -> create_supplier_purchase_atomic(p_purchase_date) + expenses.date
//   · Proveedores ▸ Compra   purchaseDate -> create_supplier_purchase_atomic(p_purchase_date)
//   · Proveedores ▸ Pago     paymentDate  -> pay_supplier_*(p_payment_date)
//   · Retiro del dueño       date         -> create_owner_withdrawal(p_date)
//
// Se montan las pantallas REALES con el reloj fijado en el instante del caso
// (solo se falsea Date) y con la zona del proceso en UTC (la del runner de CI) y
// en Cordoba (la del usuario real). En las dos tiene que aparecer el dia civil
// argentino.
import { readFileSync } from 'node:fs'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ businessId: 'biz-1', user: { id: 'u1' }, role: 'owner', isOwner: true, profile: {} }),
}))
vi.mock('../../src/contexts/CajaContext', () => ({
  useCaja: () => ({ isOpen: true, cajaId: 'caja-1' }),
}))
vi.mock('../../src/hooks/usePermissions', () => ({
  usePermissions: () => ({ can: () => true, permissions: {} }),
  effectivePermissions: () => ({}),
}))
vi.mock('../../src/hooks/useAppWakeUp', () => ({ useRefreshOnWakeUp: () => {} }))
// Cadena de PostgREST inerte: cualquier .from()/.rpc() encadenado resuelve a
// una lista vacia. Las lecturas de las pantallas no importan en este test.
vi.mock('../../src/lib/supabase', () => {
  const vacio = { data: [], error: null }
  const cadena = (): unknown => new Proxy(() => {}, {
    get: (_t, prop) => (prop === 'then'
      ? (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(vacio).then(ok, ko)
      : () => cadena()),
    apply: () => cadena(),
  })
  return { supabase: { from: () => cadena(), rpc: () => cadena() } }
})

import { suppliersService } from '../../src/services/suppliersService'
import { personalService } from '../../src/personal/services/personalService'
import { Expenses } from '../../src/pages/Expenses'
import { Suppliers } from '../../src/pages/Suppliers'
import { OwnerWithdrawalPage } from '../../src/personal/pages/OwnerWithdrawal'

type Caso = [label: string, instant: string, esperado: string]

const CASOS: Caso[] = [
  ['30/09 22:30 AR (UTC ya es 01/10)', '2026-09-30T22:30:00-03:00', '2026-09-30'],
  ['30/09 21:00 AR (primer instante con UTC en otro dia)', '2026-09-30T21:00:00-03:00', '2026-09-30'],
  ['01/10 00:00 AR (cambio de dia)', '2026-10-01T00:00:00-03:00', '2026-10-01'],
  ['31/12 23:30 AR (ultima noche del año)', '2026-12-31T23:30:00-03:00', '2026-12-31'],
  ['01/01 00:00 AR (cambio de año)', '2027-01-01T00:00:00-03:00', '2027-01-01'],
]

const SUPPLIER = {
  id: 'sup-1', business_id: 'biz-1', name: 'Prov-Uno', active: true,
  created_at: '', updated_at: '',
  total_purchases: 1000, total_paid: 0, pending_amount: 1000,
  purchases_count: 1, last_purchase_date: '2026-09-01', finance_authorized: true,
}
const PURCHASE = {
  id: 'pur-1', business_id: 'biz-1', supplier_id: 'sup-1', purchase_date: '2026-09-01',
  total_amount: 1000, paid_amount: 0, pending_amount: 1000,
  payment_status: 'pending' as const, created_at: '', updated_at: '',
}

function fechaDe(contenedor: HTMLElement): string {
  const input = contenedor.querySelector<HTMLInputElement>('input[type="date"]')
  if (!input) throw new Error('la superficie no tiene input de fecha')
  return input.value
}

async function abrirGasto(): Promise<void> {
  render(<MemoryRouter><Expenses /></MemoryRouter>)
  fireEvent.click(await screen.findByTestId('expense-new-button'))
  await screen.findByRole('heading', { name: 'Nuevo Gasto' })
}

/** El campo «Fecha» del modal de gasto (los filtros de la lista son otra cosa). */
function fechaDelModalDeGasto(): string {
  return fechaDe(screen.getByText('Fecha', { selector: 'label' }).parentElement as HTMLElement)
}

async function abrirDetalleProveedor(): Promise<void> {
  vi.spyOn(suppliersService, 'getSuppliersWithStats').mockResolvedValue([SUPPLIER as never])
  vi.spyOn(suppliersService, 'getSupplierDebt').mockResolvedValue({ outstanding: 1000, documents: 1, authorized: true })
  vi.spyOn(suppliersService, 'getPurchases').mockResolvedValue([PURCHASE as never])
  vi.spyOn(suppliersService, 'getPayments').mockResolvedValue([])
  vi.spyOn(suppliersService, 'getAccountMovements').mockResolvedValue([])
  render(<MemoryRouter><Suppliers /></MemoryRouter>)
  await waitFor(() => expect(screen.getByText('Prov-Uno')).toBeInTheDocument())
  fireEvent.click(screen.getByTitle('Ver detalle'))
  await waitFor(() => expect(screen.getByTestId('supplier-summary')).toBeInTheDocument())
}

async function abrirRetiro(): Promise<void> {
  vi.spyOn(personalService, 'getAccounts').mockResolvedValue([
    { id: 'acc-1', name: 'Cuenta personal', current_balance: 0 } as never,
  ])
  render(<MemoryRouter><OwnerWithdrawalPage /></MemoryRouter>)
  await screen.findByTestId('personal-salary-amount')
}

describe.each(['UTC', 'America/Argentina/Cordoba'])('defaults de fecha con TZ del proceso = %s', (tz) => {
  let previo: string | undefined
  beforeAll(() => { previo = process.env.TZ; process.env.TZ = tz })
  afterAll(() => { if (previo === undefined) delete process.env.TZ; else process.env.TZ = previo })
  afterEach(() => { vi.useRealTimers() })

  describe.each(CASOS)('%s', (_label, instant, esperado) => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(instant))
    })

    test('Gastos ▸ General: la fecha del gasto arranca en el dia argentino', async () => {
      await abrirGasto()
      expect(fechaDelModalDeGasto()).toBe(esperado)
    })

    test('Gastos ▸ Factura de proveedor: la fecha de la factura arranca en el dia argentino', async () => {
      await abrirGasto()
      fireEvent.click(screen.getByRole('button', { name: /Factura de proveedor/ }))
      await screen.findByPlaceholderText('A-0001-00012345')
      expect(fechaDelModalDeGasto()).toBe(esperado)
    })

    test('Proveedores ▸ Nueva compra: la fecha de compra arranca en el dia argentino', async () => {
      await abrirDetalleProveedor()
      fireEvent.click(screen.getByTestId('supplier-new-purchase'))
      const modal = await screen.findByTestId('supplier-invoice-modal')
      expect(fechaDe(modal)).toBe(esperado)
    })

    test('Proveedores ▸ Registrar pago: la fecha de pago arranca en el dia argentino y es la que se graba', async () => {
      const crear = vi.spyOn(suppliersService, 'createPayment').mockResolvedValue(undefined as never)
      await abrirDetalleProveedor()
      fireEvent.click(screen.getByTestId('supplier-pay-header'))
      const modal = await screen.findByTestId('supplier-payment-modal')
      expect(fechaDe(modal)).toBe(esperado)

      fireEvent.change(within(modal).getByPlaceholderText('$ 0'), { target: { value: '500' } })
      fireEvent.click(within(modal).getAllByRole('button').find(b => b.className.includes('btn-success'))!)
      await waitFor(() => expect(crear).toHaveBeenCalledTimes(1))
      expect(crear.mock.calls[0][0]).toMatchObject({ payment_date: esperado })
    })

    test('Retiro del dueño: la fecha arranca en el dia argentino y es la que se graba', async () => {
      const registrar = vi.spyOn(personalService, 'registerOwnerWithdrawal').mockResolvedValue(undefined as never)
      await abrirRetiro()
      expect(fechaDe(document.body)).toBe(esperado)

      fireEvent.change(screen.getByTestId('personal-salary-amount'), { target: { value: '1500' } })
      fireEvent.click(screen.getByTestId('personal-salary-confirm'))
      fireEvent.click(screen.getByTestId('personal-salary-submit'))
      await waitFor(() => expect(registrar).toHaveBeenCalledTimes(1))
      expect(registrar.mock.calls[0][0]).toMatchObject({ date: esperado })
    })
  })
})

describe('control de fuente: los defaults que se graban no vuelven a pasar por UTC', () => {
  const SUPERFICIES: Array<[archivo: string, estados: string[]]> = [
    ['src/pages/Expenses.tsx', ['fecha, setFecha', 'facFecha, setFacFecha']],
    ['src/pages/Suppliers.tsx', ['purchaseDate, setPurchaseDate', 'paymentDate, setPaymentDate']],
    ['src/personal/pages/OwnerWithdrawal.tsx', ['date, setDate']],
  ]

  test.each(SUPERFICIES)('%s inicializa sus fechas con businessToday()', (archivo, estados) => {
    const fuente = readFileSync(archivo, 'utf8')
    expect(fuente).toMatch(/import \{[^}]*\bbusinessToday\b[^}]*\} from '(\.\.\/)+lib\/businessDate'/)
    for (const estado of estados) {
      const declaracion = new RegExp(`const \\[${estado}\\]\\s*=\\s*useState\\(([^\\n]*)\\)`)
      const m = declaracion.exec(fuente)
      expect(m, `${archivo}: no se encontro el estado [${estado}]`).not.toBeNull()
      expect(m![1], `${archivo}: [${estado}]`).toBe('() => businessToday()')
    }
  })

  test('Proveedores y Retiro no cortan fechas con toISOString()', () => {
    for (const archivo of ['src/pages/Suppliers.tsx', 'src/personal/pages/OwnerWithdrawal.tsx']) {
      expect(readFileSync(archivo, 'utf8'), archivo).not.toMatch(/toISOString\(\)\.(split|slice|substring)\(/)
    }
  })
})
