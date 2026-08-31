import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PaymentButtonsPanel } from '../../src/components/payments/PaymentButtonsPanel'
import { PaymentMethodSettings } from '../../src/components/payments/PaymentMethodSettings'

const state = vi.hoisted(() => ({
  invoke: vi.fn(),
  filters: [] as [string, unknown][],
  saved: vi.fn(),
  rows: [
    { id: 'manual-mp', name: 'Débito (MP)', provider: 'mercadopago', channel: 'manual', integration_kind: 'none', is_active: true, fee_percent: 0, fee_fixed: 0, vat_percent: 0, installments: 1 },
    { id: 'integrated-mp', name: 'QR integrado', provider: 'mercadopago', channel: 'integrated', integration_kind: 'mp_qr', is_active: true },
  ],
}))
vi.mock('../../src/contexts/AuthContext', () => ({ useAuth: () => ({ businessId: 'test-business' }) }))
vi.mock('../../src/lib/supabase', () => ({ supabase: {
  functions: { invoke: state.invoke },
  from: () => {
    const filters: [string, unknown][] = []
    const chain = {
      select: () => chain,
      eq: (key: string, value: unknown) => { filters.push([key, value]); state.filters.push([key, value]); return chain },
      order: async () => ({ data: state.rows.filter(row => filters.every(([key, value]) => key === 'business_id' || row[key as keyof typeof row] === value)) }),
    }
    return chain
  },
} }))
vi.mock('../../src/services/paymentButtonService', () => ({ paymentButtonService: { create: state.saved, update: state.saved } }))

beforeEach(() => { state.filters = []; state.saved.mockResolvedValue({ ...state.rows[0], id: 'new-manual-mp' }) })

describe('MP POS Beta UI boundary', () => {
  it('legacy panel cannot render or make requests even if mounted directly', () => {
    const { container } = render(<PaymentButtonsPanel comprobanteId="fixture" totalBruto={50000} saldoPendiente={50000} />)
    expect(container).toBeEmptyDOMElement()
    expect(state.invoke).not.toHaveBeenCalled()
  })

  it('settings preserve MP manual methods and cannot offer integrated configuration', async () => {
    render(<PaymentMethodSettings />)
    expect(await screen.findByText('Débito (MP)')).toBeVisible()
    expect(screen.queryByText('QR integrado')).not.toBeInTheDocument()
    expect(state.filters).toContainEqual(['channel', 'manual'])
    expect(state.filters).toContainEqual(['integration_kind', 'none'])
    fireEvent.click(screen.getByRole('button', { name: /Nuevo botón/ }))
    expect(screen.getByRole('option', { name: 'Mercado Pago' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Integrado|MP QR|MP Point/ })).not.toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('Ej: Débito bancario'), { target: { value: 'MP manual' } })
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'mercadopago' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    await waitFor(() => expect(state.saved).toHaveBeenCalledWith(expect.objectContaining({ provider: 'mercadopago', channel: 'manual', integration_kind: 'none' })))
    expect(state.invoke).not.toHaveBeenCalled()
  })
})
