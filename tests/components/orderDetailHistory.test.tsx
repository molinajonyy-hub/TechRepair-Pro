import { Component, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { OrderDetailSimple } from '../../src/hooks/useOrderSimple'

const state = vi.hoisted(() => ({
  order: {} as OrderDetailSimple,
  loadComprobantes: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('../../src/hooks/useOrderSimple', () => ({
  useOrderSimple: () => ({ order: state.order, loading: false, error: null, refresh: state.refresh }),
}))
vi.mock('../../src/hooks/useComprobantes', () => ({
  useComprobantes: () => ({ comprobantes: [], cargarComprobantesByOrder: state.loadComprobantes }),
}))
vi.mock('../../src/hooks/useWarranties', () => ({ useWarranties: () => ({ addWarranty: vi.fn() }) }))
vi.mock('../../src/hooks/useOrderCanonicalBalance', () => ({
  useOrderCanonicalBalance: () => ({ disponible: false }),
}))
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }) }),
  },
}))

// Keep the real OrderDetail and its timeline. Isolate unrelated child features
// (payments, printing, uploads, messaging) from this read-only render test.
vi.mock('../../src/components/order/StatusChange', () => ({ StatusChange: () => null }))
vi.mock('../../src/components/order/DeviceLockCard', () => ({ DeviceLockCard: () => null }))
vi.mock('../../src/components/order/OrderItemsCard', () => ({ OrderItemsCard: () => null }))
vi.mock('../../src/components/orders/OrderFinancialSummary', () => ({ OrderFinancialSummary: () => null }))
vi.mock('../../src/components/order/DocumentUploader', () => ({ DocumentUploader: () => null }))
vi.mock('../../src/components/order/NotificationCard', () => ({ NotificationCard: () => null }))
vi.mock('../../src/components/print/OrderPrintPreviewModal', () => ({ OrderPrintPreviewModal: () => null }))
vi.mock('../../src/components/comprobantes/ComprobanteProModal', () => ({ ComprobanteProModal: () => null }))
vi.mock('../../src/components/warranties/WarrantyFormModal', () => ({ WarrantyFormModal: () => null }))
vi.mock('../../src/components/whatsapp/WhatsAppHistorial', () => ({ WhatsAppHistorial: () => null }))
vi.mock('../../src/components/whatsapp/WhatsAppPreviewModal', () => ({ WhatsAppPreviewModal: () => null }))

import { OrderDetail } from '../../src/pages/OrderDetail'

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    return this.state.error
      ? <div role="alert">{this.state.error.message}</div>
      : this.props.children
  }
}

beforeEach(() => {
  state.order = {
    id: 'synthetic-order', status: 'new', priority: 'medium', amountsAuthorized: false,
    customer_id: 'synthetic-customer', device_id: 'synthetic-device',
    created_at: '2026-09-01T12:00:00Z', updated_at: '2026-09-01T12:00:00Z',
    customer: { id: 'synthetic-customer', name: 'Cliente de prueba', phone: '' },
    device: { id: 'synthetic-device', type: 'phone', brand: 'Equipo', model: 'Sintético', issue: 'Prueba' },
    history: [],
  }
})

async function openHistory(rows: object[]) {
  // Reproduce the JSON returned by PostgREST, including missing fields. The
  // old hook falsely typed these rows as the input to recordStatusChange.
  state.order.history = rows as OrderDetailSimple['history']
  render(
    <MemoryRouter initialEntries={['/orders/synthetic-order']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Boundary><Routes><Route path="/orders/:id" element={<OrderDetail />} /></Routes></Boundary>
    </MemoryRouter>,
  )
  await screen.findByText('Cliente de prueba')
  fireEvent.click(screen.getByRole('button', { name: 'Historial', exact: true }))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  return screen.getByText('Historial de Estados').closest('.card') as HTMLElement
}

describe('OrderDetail — historical status JSON', () => {
  it('renders the production status/note shape without inventing a previous state', async () => {
    const card = await openHistory([{ status: 'diagnosis', note: 'Nota sintética', created_at: null }])
    expect(card).toHaveTextContent('Diagnóstico')
    expect(card).toHaveTextContent('Nota sintética')
    expect(card).not.toHaveTextContent('Nueva')
    expect(card).not.toHaveTextContent('Estado desconocido')
  })

  it.each(['received', 'estado_eliminado', 'constructor', '__proto__'])('preserves unknown/legacy status %s with a neutral fallback', async status => {
    const row = Object.freeze({ status, note: 'Nota conservada' })
    const card = await openHistory([row])
    expect(card).toHaveTextContent(`Estado desconocido (${status})`)
    expect(card).toHaveTextContent('Nota conservada')
    expect(card.querySelector('svg')?.parentElement).toHaveStyle({ color: '#64748b', backgroundColor: '#64748b20' })
    expect(row.status).toBe(status)
  })

  it.each([null, undefined, ''])('renders a safe fallback for missing historical status %s', async status => {
    // Null is not allowed in today's status_history.status, but older/partial
    // client payloads can lack it. Never replace it with a valid current state.
    const card = await openHistory([{ status }])
    expect(card).toHaveTextContent('Estado desconocido')
    expect(card).not.toHaveTextContent('undefined')
    expect(card).not.toHaveTextContent('null')
    expect(card).not.toHaveTextContent('Nueva')
  })

  it('supports explicit transition payloads, including unknown previous and next statuses', async () => {
    const card = await openHistory([
      { from_status: 'new', to_status: 'diagnosis', notes: 'Transición conocida' },
      { from_status: 'received', to_status: 'estado_renombrado', notes: 'Transición histórica' },
      { from_status: null, to_status: undefined },
    ])
    expect(card).toHaveTextContent('Nueva')
    expect(card).toHaveTextContent('Diagnóstico')
    expect(card).toHaveTextContent('Estado desconocido (received)')
    expect(card).toHaveTextContent('Estado desconocido (estado_renombrado)')
    expect(card).toHaveTextContent('Transición histórica')
  })

  it('keeps the entire order usable with mixed history and preserves the original payload', async () => {
    const rows = Object.freeze([
      Object.freeze({ status: 'completed', note: 'Actual' }),
      Object.freeze({ status: 'received', note: 'Legacy' }),
      Object.freeze({ from_status: 'diagnosis', to_status: 'repair', notes: 'Anterior' }),
      Object.freeze({ status: 'estado_desconocido', note: 'Desconocido' }),
      Object.freeze({ status: null }),
    ])
    const original = JSON.stringify(rows)
    const card = await openHistory([...rows])
    for (const text of ['Completada', 'Estado desconocido (received)', 'Diagnóstico', 'En Reparación', 'Estado desconocido (estado_desconocido)']) {
      expect(within(card).getByText(text, { exact: false })).toBeVisible()
    }
    fireEvent.click(screen.getByRole('button', { name: 'General', exact: true }))
    expect(screen.getByText('Cliente de prueba')).toBeVisible()
    expect(screen.getByText('Sintético')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(JSON.stringify(rows)).toBe(original)
    expect(state.refresh).not.toHaveBeenCalled()
  })

  it('preserves the existing empty history state', async () => {
    expect(await openHistory([])).toHaveTextContent('No hay cambios de estado registrados.')
  })
})
