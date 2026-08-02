// ─────────────────────────────────────────────────────────────────────────────
// P0-A.1 — Historial de imputaciones: estados y contraste de sus badges.
//
// El gate visual encontró que los foregrounds semánticos globales no alcanzan
// 4.5:1 en light sobre su propio `*-subtle` (--success daba 3.51). Estos tests
// fijan que los badges del historial usan los foregrounds calibrados por tema.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

type Resp = { data: unknown; error: unknown }
let respHistorial: Resp

vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: () => Promise.resolve(respHistorial) },
}))

const { AllocationHistory } = await import('../../src/components/finance/AllocationHistory')

const filaBase = {
  id: 'a1', amount: 60000, status: 'active' as const,
  created_at: '2026-07-31T09:15:00Z', reversed_at: null, reason: null,
  comprobante_id: 'c1', comprobante_numero: '0001-00000042',
  payment_movement_id: 'm1', order_id: 'o1', reversal_of: null, operador: 'Dueño Local',
}

const montar = () => render(<AllocationHistory businessId="biz-1" comprobanteId="c1" />)

const colorDe = (el: Element) =>
  (el.getAttribute('style') ?? '').match(/(?:^|;)\s*color:\s*([^;]+)/)?.[1]?.trim() ?? ''

describe('AllocationHistory', () => {
  beforeEach(() => {
    respHistorial = { data: { ok: true, authorized: true, can_reverse: true, rows: [filaBase] }, error: null }
  })

  test('muestra la imputación con su importe, comprobante y operador', async () => {
    montar()
    await waitFor(() => expect(screen.getByTestId('allocation-history')).toBeInTheDocument())
    const fila = screen.getByTestId('allocation-row-a1')
    expect(fila).toHaveTextContent('$60.000')
    expect(fila).toHaveTextContent('0001-00000042')
    expect(fila).toHaveTextContent('Dueño Local')
  })

  test('el badge "Activa" usa el foreground calibrado, no --success', async () => {
    montar()
    await waitFor(() => expect(screen.getByTestId('allocation-status-a1')).toBeInTheDocument())
    const badge = screen.getByTestId('allocation-status-a1')
    expect(badge).toHaveTextContent('Activa')
    expect(colorDe(badge)).toBe('var(--order-badge-paid-fg)')
    expect(colorDe(badge)).not.toBe('var(--success)')
  })

  test('el badge "Revertida" usa el neutro calibrado, no --text-subtle', async () => {
    respHistorial = {
      data: { ok: true, authorized: true, can_reverse: true,
              rows: [{ ...filaBase, status: 'reversed', reversed_at: '2026-07-31T10:00:00Z' }] },
      error: null,
    }
    montar()
    await waitFor(() => expect(screen.getByTestId('allocation-status-a1')).toBeInTheDocument())
    const badge = screen.getByTestId('allocation-status-a1')
    expect(badge).toHaveTextContent('Revertida')
    expect(colorDe(badge)).toBe('var(--order-badge-neutral-fg)')
    for (const prohibido of ['var(--text-subtle)', 'var(--text-tertiary)']) {
      expect(colorDe(badge)).not.toBe(prohibido)
    }
  })

  test('el estado se lee por texto, no sólo por color', async () => {
    montar()
    await waitFor(() => expect(screen.getByTestId('allocation-status-a1')).toBeInTheDocument())
    expect(screen.getByTestId('allocation-status-a1').textContent?.trim()).toBeTruthy()
  })

  test('una reversión ya hecha no ofrece volver a revertir', async () => {
    respHistorial = {
      data: { ok: true, authorized: true, can_reverse: true, rows: [{ ...filaBase, status: 'reversed' }] },
      error: null,
    }
    montar()
    await waitFor(() => expect(screen.getByTestId('allocation-row-a1')).toBeInTheDocument())
    expect(screen.queryByTestId('allocation-reverse-a1')).not.toBeInTheDocument()
  })

  test('sin permiso de reversa no aparece la acción', async () => {
    respHistorial = { data: { ok: true, authorized: true, can_reverse: false, rows: [filaBase] }, error: null }
    montar()
    await waitFor(() => expect(screen.getByTestId('allocation-row-a1')).toBeInTheDocument())
    expect(screen.queryByTestId('allocation-reverse-a1')).not.toBeInTheDocument()
  })

  test('un error no se muestra como historial vacío', async () => {
    respHistorial = { data: { ok: false, error: 'boom' }, error: null }
    montar()
    await waitFor(() => expect(screen.getByTestId('allocations-error')).toBeInTheDocument())
    expect(screen.queryByTestId('allocations-empty')).not.toBeInTheDocument()
  })
})
