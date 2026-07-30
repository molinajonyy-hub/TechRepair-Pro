// ─────────────────────────────────────────────────────────────────────────────
// P0-A.1U1 — Resumen financiero del detalle de orden.
// Casos 9, 10, 14 y 15. Se mockea el LÍMITE (supabase y useAuth), nunca el
// componente bajo prueba.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const estado = {
  order_id: 'o1', payment_status: 'partial',
  total_comprobado: 100000, total_cobrado: 40000, cobrado_directo: 40000,
  imputado_cc: 0, saldo_pendiente: 60000, saldo_en_cc: 60000, deuda_en_cc: true,
  comprobantes_vigentes: 1, comprobante_id: 'c1', comprobante_numero: '0001-00000042',
  completed_at: '2026-07-30T12:00:00Z', paid_at: null, ultimo_pago: '2026-07-30',
}

let respuestaEstado: { data: unknown; error: unknown } = { data: estado, error: null }
let respuestaCredito: { data: unknown; error: unknown } = { data: [], error: null }

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ businessId: 'biz-1', user: { id: 'u1' } }),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (tabla: string) => {
      const q: Record<string, unknown> = {}
      const chain = () => q
      q.select = chain; q.eq = chain
      q.maybeSingle = () => Promise.resolve(respuestaEstado)
      // La consulta de crédito termina en .eq(), así que es "thenable".
      q.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(tabla === 'v_customer_unallocated_credit' ? respuestaCredito : respuestaEstado).then(resolve)
      return q
    },
  },
}))

const { OrderFinancialSummary } = await import('../../src/components/orders/OrderFinancialSummary')

const montar = (customerId: string | null = null) =>
  render(<MemoryRouter><OrderFinancialSummary orderId="o1" customerId={customerId} /></MemoryRouter>)

describe('OrderFinancialSummary', () => {
  beforeEach(() => {
    respuestaEstado = { data: estado, error: null }
    respuestaCredito = { data: [], error: null }
  })

  test('caso 14: muestra total comprobado, cobrado y saldo desde la vista canónica', async () => {
    montar()
    await waitFor(() => expect(screen.queryByTestId('order-financial-loading')).not.toBeInTheDocument())
    const card = screen.getByTestId('order-financial-summary')
    expect(card).toHaveTextContent('Total comprobado')
    expect(card).toHaveTextContent('$100.000')
    expect(card).toHaveTextContent('$40.000')
    expect(card).toHaveTextContent('$60.000')
    expect(screen.getByTestId('order-financial-badge')).toHaveTextContent('Parcial')
  })

  test('caso 10: mientras carga NO muestra ningún estado financiero', () => {
    montar()
    expect(screen.getByTestId('order-financial-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('order-financial-badge')).not.toBeInTheDocument()
    // Ningún importe provisorio en cero.
    expect(screen.getByTestId('order-financial-summary')).not.toHaveTextContent('$0')
  })

  test('caso 9: ante error muestra "No disponible" y ningún importe en cero', async () => {
    respuestaEstado = { data: null, error: { message: 'permission denied' } }
    montar()
    await waitFor(() => expect(screen.getByTestId('order-financial-unavailable')).toBeInTheDocument())
    const card = screen.getByTestId('order-financial-summary')
    expect(card).toHaveTextContent('No disponible')
    expect(card).not.toHaveTextContent('$0')
    expect(card).not.toHaveTextContent('Total comprobado')
    expect(screen.getByTestId('order-financial-badge')).toHaveTextContent('No disponible')
  })

  test('una orden sin fila en la vista tampoco inventa un estado', async () => {
    respuestaEstado = { data: null, error: null }
    montar()
    await waitFor(() => expect(screen.getByTestId('order-financial-unavailable')).toBeInTheDocument())
    expect(screen.getByTestId('order-financial-badge')).not.toHaveTextContent('Cobrado')
  })

  test('caso 15: el crédito no imputado se informa pero NO cambia el estado de la orden', async () => {
    respuestaCredito = { data: [{ unallocated_amount: 25000 }], error: null }
    montar('cli-1')
    await waitFor(() => expect(screen.getByTestId('order-unallocated-credit')).toBeInTheDocument())
    const aviso = screen.getByTestId('order-unallocated-credit')
    expect(aviso).toHaveTextContent('$25.000')
    expect(aviso).toHaveTextContent(/sin imputar/i)
    // El badge sigue siendo el server-side: el crédito no lo mueve a "Cobrado".
    expect(screen.getByTestId('order-financial-badge')).toHaveTextContent('Parcial')
    // Y el saldo tampoco se descuenta.
    expect(screen.getByTestId('order-financial-summary')).toHaveTextContent('$60.000')
  })

  test('no hay acciones de imputación en este lote (solo lectura)', async () => {
    montar('cli-1')
    await waitFor(() => expect(screen.queryByTestId('order-financial-loading')).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /imputar|distribuir|revertir/i })).not.toBeInTheDocument()
  })
})
