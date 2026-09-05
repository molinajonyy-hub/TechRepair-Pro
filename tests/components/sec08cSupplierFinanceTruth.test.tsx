// ─────────────────────────────────────────────────────────────────────────────
// SEC-08C · LA LEY DEL CERO FALSO.
//
// El defecto no era sólo que un actor sin autoridad viera la deuda ajena: era
// que, cuando NO podía verla, el producto afirmaba «$0» y lo pintaba de verde.
// Esa es la lectura más tranquilizadora posible de un dato que no se pudo leer.
//
// Estos tests exigen que el contrato distinga TRES estados, no dos:
//   · deuda real distinta de cero  → el número real
//   · deuda real cero              → 0, que es una afirmación legítima
//   · restringido                  → null, y en pantalla "—", nunca "$0"
//                                    ni "Al día" ni "Sin deuda"
// ─────────────────────────────────────────────────────────────────────────────
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  debtRow: null as Record<string, unknown> | null,
  debtError: null as { message: string } | null,
  suppliers: [] as Record<string, unknown>[],
  statsRows: [] as Record<string, unknown>[],
}))

// Mock de supabase que despacha por tabla. Devuelve exactamente las formas que
// consume el service, para que el test mida el MAPEO y no el cliente HTTP.
vi.mock('../../src/lib/supabase', () => {
  const chain = (result: unknown) => {
    const thenable = {
      select: () => thenable,
      eq: () => thenable,
      order: () => Promise.resolve(result),
      maybeSingle: () => Promise.resolve(result),
      then: (r: (v: unknown) => unknown) => Promise.resolve(result).then(r),
    }
    return thenable
  }
  return {
    supabase: {
      from: (table: string) => {
        if (table === 'v_finance_supplier_debt') {
          return chain({ data: mocks.debtRow, error: mocks.debtError })
        }
        if (table === 'v_finance_supplier_stats') {
          return chain({ data: mocks.statsRows, error: null })
        }
        return chain({ data: mocks.suppliers, error: null })
      },
    },
  }
})
vi.mock('../../src/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

import { suppliersService } from '../../src/services/suppliersService'

const DEBT = 82395

beforeEach(() => {
  mocks.debtRow = null
  mocks.debtError = null
  mocks.suppliers = []
  mocks.statsRows = []
})

describe('SEC-08C · getSupplierDebt distingue tres estados', () => {
  it('actor autorizado con deuda real: devuelve el importe exacto', async () => {
    mocks.debtRow = { outstanding_ars: DEBT, documents: 2, is_authorized: true }
    const r = await suppliersService.getSupplierDebt('biz-1')
    expect(r.outstanding).toBe(DEBT)
    expect(r.authorized).toBe(true)
  })

  it('actor autorizado SIN deuda: devuelve 0, que es verdad del negocio', async () => {
    mocks.debtRow = { outstanding_ars: 0, documents: 0, is_authorized: true }
    const r = await suppliersService.getSupplierDebt('biz-1')
    expect(r.outstanding).toBe(0)
    expect(r.authorized).toBe(true)
  })

  it('actor RESTRINGIDO: devuelve null, jamás 0', async () => {
    mocks.debtRow = { outstanding_ars: null, documents: null, is_authorized: false }
    const r = await suppliersService.getSupplierDebt('biz-1')
    expect(r.outstanding).toBeNull()
    expect(r.outstanding).not.toBe(0)
    expect(r.authorized).toBe(false)
  })

  it('un ERROR de lectura tampoco puede convertirse en «no hay deuda»', async () => {
    mocks.debtRow = null
    mocks.debtError = { message: 'permission denied for table supplier_purchases' }
    const r = await suppliersService.getSupplierDebt('biz-1')
    expect(r.outstanding).toBeNull()
    expect(r.outstanding).not.toBe(0)
    expect(r.authorized).toBe(false)
  })
})

describe('SEC-08C · getSuppliersWithStats no inventa ceros', () => {
  const supplier = { id: 'sup-1', business_id: 'biz-1', name: 'Prov-Uno', active: true }

  it('con autoridad: los importes del servidor llegan tal cual', async () => {
    mocks.suppliers = [supplier]
    mocks.statsRows = [{
      supplier_id: 'sup-1', total_purchases: 73191, total_paid: 21203,
      pending_amount: 51988, purchases_count: 2, last_purchase_date: '2026-09-01',
      is_authorized: true,
    }]
    const [s] = await suppliersService.getSuppliersWithStats('biz-1')
    expect(s.pending_amount).toBe(51988)
    expect(s.total_purchases).toBe(73191)
    expect(s.finance_authorized).toBe(true)
  })

  it('sin autoridad: los importes son null y el proveedor sigue listándose', async () => {
    mocks.suppliers = [supplier]
    mocks.statsRows = [{
      supplier_id: 'sup-1', total_purchases: null, total_paid: null,
      pending_amount: null, purchases_count: null, last_purchase_date: null,
      is_authorized: false,
    }]
    const [s] = await suppliersService.getSuppliersWithStats('biz-1')
    expect(s.name).toBe('Prov-Uno')          // el dato OPERATIVO no se pierde
    expect(s.pending_amount).toBeNull()
    expect(s.total_purchases).toBeNull()
    expect(s.purchases_count).toBeNull()
    expect(s.finance_authorized).toBe(false)
  })

  it('si la vista de stats no devuelve fila, tampoco se asume 0', async () => {
    mocks.suppliers = [supplier]
    mocks.statsRows = []
    const [s] = await suppliersService.getSuppliersWithStats('biz-1')
    expect(s.pending_amount).toBeNull()
    expect(s.finance_authorized).toBe(false)
  })
})

// ── La pantalla ──────────────────────────────────────────────────────────────
vi.mock('../../src/contexts/AuthContext', () => ({ useAuth: () => ({ businessId: 'biz-1', user: { id: 'u1' } }) }))
vi.mock('../../src/hooks/usePermissions', () => ({
  usePermissions: () => ({ can: () => true }),
  effectivePermissions: () => ({ inventory: true }),
}))
vi.mock('../../src/hooks/useAppWakeUp', () => ({ useRefreshOnWakeUp: () => {} }))

describe('SEC-08C · la lista de proveedores no dice «Al día» sin poder saberlo', () => {
  it('restringido se muestra como "—" y NUNCA como $0 ni "Al día"', async () => {
    const { Suppliers } = await import('../../src/pages/Suppliers')
    vi.spyOn(suppliersService, 'getSuppliersWithStats').mockResolvedValue([{
      id: 'sup-1', business_id: 'biz-1', name: 'Prov-Restringido', active: true,
      created_at: '', updated_at: '',
      total_purchases: null, total_paid: null, pending_amount: null,
      purchases_count: null, last_purchase_date: null, finance_authorized: false,
    } as never])
    vi.spyOn(suppliersService, 'getSupplierDebt').mockResolvedValue({
      outstanding: null, documents: null, authorized: false,
    })

    render(<MemoryRouter><Suppliers /></MemoryRouter>)

    await waitFor(() => expect(screen.getByText('Prov-Restringido')).toBeInTheDocument())
    // El marcador explícito de restringido está…
    expect(await screen.findByTestId('supplier-debt-restricted')).toBeInTheDocument()

    // …y ninguna afirmación tranquilizadora DENTRO DE LA FILA del proveedor.
    // Se acota a la fila a propósito: «Sin deuda» también es la etiqueta del
    // filtro del listado, y prohibirla en todo el documento haría fallar el
    // test por un botón que no afirma nada sobre este proveedor.
    const row = screen.getByText('Prov-Restringido').closest('tr') as HTMLElement
    expect(row).not.toBeNull()
    expect(within(row).queryByText('Al día')).not.toBeInTheDocument()
    expect(within(row).queryByText(/Sin deuda/)).not.toBeInTheDocument()
    expect(within(row).queryByText('$0')).not.toBeInTheDocument()
    expect(row.textContent).not.toMatch(/\$\s*0(\D|$)/)
    expect(within(row).getByTestId('supplier-debt-restricted').textContent).toBe('—')
  })
})
