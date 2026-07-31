// ─────────────────────────────────────────────────────────────────────────────
// P0-A.1U1V — Resumen financiero: importes según PERMISO server-side.
// Casos 1-6 y 12 del contrato de permisos, más 9/10/14/15 de U1.
// Se mockea el LÍMITE (supabase y useAuth), nunca el componente bajo prueba.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Estado SIN importes: lo que devuelve v_order_payment_state a cualquier rol.
const estadoBase = {
  order_id: 'o1', payment_status: 'partial',
  comprobantes_vigentes: 1, comprobante_id: 'c1', comprobante_numero: '0001-00000042',
}
// Importes: sólo llegan si la RPC autoriza.
const importes = {
  order_id: 'o1', total_comprobado: 100000, total_cobrado: 40000, cobrado_directo: 40000,
  imputado_cc: 0, saldo_pendiente: 60000, saldo_en_cc: 60000, deuda_en_cc: true,
  completed_at: '2026-07-30T12:00:00Z', paid_at: null, ultimo_pago: '2026-07-30',
}

let respEstado: { data: unknown; error: unknown } = { data: estadoBase, error: null }
let respMontos: { data: unknown; error: unknown } = { data: { ok: true, authorized: true, rows: [importes] }, error: null }
let respCredito: { data: unknown; error: unknown } = { data: { ok: true, authorized: true, unallocated_amount: 0 }, error: null }

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ businessId: 'biz-1', user: { id: 'u1' } }),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => {
      const q: Record<string, unknown> = {}
      const chain = () => q
      q.select = chain; q.eq = chain
      q.maybeSingle = () => Promise.resolve(respEstado)
      return q
    },
    rpc: (nombre: string) => {
      if (nombre === 'get_customer_unallocated_credit') return Promise.resolve(respCredito)
      // El resumen monta el historial de imputaciones: sin permiso no renderiza
      // nada, que es lo que estos tests necesitan para aislar el resumen.
      if (nombre === 'get_payment_allocations') {
        return Promise.resolve({ data: { ok: true, authorized: false }, error: null })
      }
      return Promise.resolve(respMontos)
    },
  },
}))

const { OrderFinancialSummary } = await import('../../src/components/orders/OrderFinancialSummary')

const montar = (customerId: string | null = null) =>
  render(<MemoryRouter><OrderFinancialSummary orderId="o1" customerId={customerId} /></MemoryRouter>)

const yaCargo = async () =>
  waitFor(() => expect(screen.queryByTestId('order-financial-loading')).not.toBeInTheDocument())

describe('OrderFinancialSummary — permisos e importes', () => {
  beforeEach(() => {
    respEstado  = { data: estadoBase, error: null }
    respMontos  = { data: { ok: true, authorized: true, rows: [importes] }, error: null }
    respCredito = { data: { ok: true, authorized: true, unallocated_amount: 0 }, error: null }
  })

  test('casos 1-2: un rol autorizado (owner/cashier) ve badge E importes', async () => {
    montar(); await yaCargo()
    const card = screen.getByTestId('order-financial-summary')
    expect(screen.getByTestId('order-financial-badge')).toHaveTextContent('Parcial')
    expect(card).toHaveTextContent('$100.000')
    expect(card).toHaveTextContent('$60.000')
    expect(screen.queryByTestId('order-amounts-restricted')).not.toBeInTheDocument()
  })

  test('casos 3-4: tech/viewer ven el badge pero NO los importes', async () => {
    respMontos = { data: { ok: true, authorized: false, rows: [] }, error: null }
    montar(); await yaCargo()
    // El estado de cobro sigue visible: es lo que el contrato permite.
    expect(screen.getByTestId('order-financial-badge')).toHaveTextContent('Parcial')
    expect(screen.getByTestId('order-amounts-restricted')).toBeInTheDocument()
    const card = screen.getByTestId('order-financial-summary')
    expect(card).not.toHaveTextContent('Total comprobado')
    expect(card).not.toHaveTextContent('100.000')
    expect(card).not.toHaveTextContent('60.000')
  })

  test('caso 5: sin permiso NO aparece ningún importe en cero', async () => {
    respMontos = { data: { ok: true, authorized: false, rows: [] }, error: null }
    montar(); await yaCargo()
    expect(screen.getByTestId('order-financial-summary')).not.toHaveTextContent('$0')
  })

  test('caso 6: error financiero muestra "No disponible", no "restringido" ni $0', async () => {
    respEstado = { data: null, error: { message: 'permission denied' } }
    montar(); await yaCargo()
    expect(screen.getByTestId('order-financial-unavailable')).toBeInTheDocument()
    const card = screen.getByTestId('order-financial-summary')
    expect(card).toHaveTextContent('No disponible')
    expect(card).not.toHaveTextContent('$0')
    expect(screen.queryByTestId('order-amounts-restricted')).not.toBeInTheDocument()
  })

  test('un error en la RPC de importes tampoco inventa ceros', async () => {
    respMontos = { data: { ok: false, error_code: 'FORBIDDEN' }, error: null }
    montar(); await yaCargo()
    expect(screen.getByTestId('order-financial-summary')).not.toHaveTextContent('$0')
  })

  test('caso 10: mientras carga no se muestra ningún estado ni importe', () => {
    montar()
    expect(screen.getByTestId('order-financial-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('order-financial-badge')).not.toBeInTheDocument()
    expect(screen.getByTestId('order-financial-summary')).not.toHaveTextContent('$0')
  })

  test('caso 12: el crédito no imputado sólo aparece con permiso', async () => {
    respCredito = { data: { ok: true, authorized: true, unallocated_amount: 25000 }, error: null }
    montar('cli-1')
    await waitFor(() => expect(screen.getByTestId('order-unallocated-credit')).toBeInTheDocument())
    expect(screen.getByTestId('order-unallocated-credit')).toHaveTextContent('$25.000')
    // Y no cambia el estado de la orden.
    expect(screen.getByTestId('order-financial-badge')).toHaveTextContent('Parcial')
  })

  test('caso 12b: sin permiso el crédito no se muestra en absoluto', async () => {
    respMontos  = { data: { ok: true, authorized: false, rows: [] }, error: null }
    respCredito = { data: { ok: true, authorized: false }, error: null }
    montar('cli-1'); await yaCargo()
    expect(screen.queryByTestId('order-unallocated-credit')).not.toBeInTheDocument()
  })

  test('la orden sin fila en la vista no inventa un estado', async () => {
    respEstado = { data: null, error: null }
    montar(); await yaCargo()
    expect(screen.getByTestId('order-financial-unavailable')).toBeInTheDocument()
    expect(screen.getByTestId('order-financial-badge')).not.toHaveTextContent('Cobrado')
  })

  test('no hay acciones de escritura en este lote', async () => {
    montar('cli-1'); await yaCargo()
    expect(screen.queryByRole('button', { name: /imputar|distribuir|revertir/i })).not.toBeInTheDocument()
  })
})
