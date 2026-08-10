// -----------------------------------------------------------------------------
// M8 - card y drawer muestran el MISMO importe localizado.
//
// El gate visual encontro que la card decia "10,823,941.50" (texto armado en SQL
// con lc_numeric=en_US) mientras el drawer decia "$ 10.823.941,50" (React con
// Intl es-AR). El mismo numero, dos formatos, en la misma tarjeta.
//
// Estos tests montan el panel con evidence realista y exigen que ambas
// superficies coincidan.
// -----------------------------------------------------------------------------
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const estado = vi.hoisted(() => ({
  read: null as null | ((...a: unknown[]) => Promise<unknown>),
  generate: null as null | ((...a: unknown[]) => Promise<unknown>),
}))

vi.mock('../../src/services/insightsService', async () => {
  const real = await vi.importActual<typeof import('../../src/services/insightsService')>(
    '../../src/services/insightsService')
  return {
    ...real,
    insightsService: {
      read: (...a: unknown[]) => estado.read!(...a),
      generate: (...a: unknown[]) => estado.generate!(...a),
    },
  }
})

import { FinanceInsightsPanel } from '../../src/components/finance/FinanceInsightsPanel'

const norm = (s: string) => s.replace(/ /g, ' ').replace(/ /g, ' ')

const base = {
  metric: 'm', threshold: { days: 90 }, period_start: '2026-08-01', period_end: '2026-08-07',
  currency: 'ARS', source: 'inventory', calculation_version: 'v1',
}

const mkInsight = (rule_id: string, evidence: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  id: `${rule_id}-id`, rule_id, rule_version: 'v1',
  period_start: '2026-08-01', period_end: '2026-08-07',
  severity: 'warning', title: 'Tenés capital inmovilizado',
  message: 'FALLBACK CUALITATIVO DEL SERVER',
  evidence: { ...base, ...evidence },
  action: { label: 'Ver inventario', target_type: 'route', target: '/inventory' },
  status: 'active', impact_ars: 0,
  generated_at: new Date().toISOString(), resolved_at: null,
  ...over,
})

// Fixture exacto del incidente productivo.
const DEAD_STOCK = mkInsight('dead_stock', {
  current_value: 0.595, dead_value: 10823941.50, inventory_at_cost: 18179810,
  dead_product_count: 348, total_product_count: 531, days_threshold: 90,
})

const FX = mkInsight('fx_stale_prices', {
  current_value: 1, stale_count: 475, total_usd_products: 475,
  avg_rate_used: 1490, current_rate: 1546, delta_percent: 3.62,
}, { title: 'Precios en dólares desactualizados', action: { label: 'Ver cotización', target_type: 'route', target: '/currency-settings' } })

const montar = () => render(
  <MemoryRouter>
    <FinanceInsightsPanel businessId="biz-1" periodStart="2026-08-01" periodEnd="2026-08-07" />
  </MemoryRouter>)

beforeEach(() => {
  cleanup()
  estado.generate = async () => ({ ok: true, fired: [], skipped: [], generatedAt: null, durationMs: 1 })
  estado.read = async () => ({ kind: 'ok', insights: [DEAD_STOCK], generatedAt: new Date().toISOString() })
})

describe('M8 - localización consistente entre card y drawer', () => {
  it('1. la card muestra el importe en es-AR, nunca en en-US', async () => {
    montar()
    const msg = await screen.findByTestId('insight-message-dead_stock')
    const t = norm(msg.textContent || '')
    expect(t).toContain('10.823.941,50')
    expect(t).not.toContain('10,823,941.50')
  })

  it('2. la card NO usa el message del server como fuente', async () => {
    montar()
    const msg = await screen.findByTestId('insight-message-dead_stock')
    expect(msg.textContent).not.toContain('FALLBACK CUALITATIVO DEL SERVER')
  })

  it('3. card y drawer muestran EXACTAMENTE el mismo importe', async () => {
    montar()
    const card = norm((await screen.findByTestId('insight-message-dead_stock')).textContent || '')
    fireEvent.click(screen.getByTestId('insight-calc-dead_stock'))
    const dlg = await screen.findByRole('dialog')
    const drawer = norm(dlg.textContent || '')

    const importe = '10.823.941,50'
    expect(card).toContain(importe)
    expect(drawer).toContain(importe)
    // y ninguna de las dos superficies cae en en-US
    expect(card + drawer).not.toContain('10,823,941.50')
  })

  it('4. el drawer rotula las cifras, no vuelca claves crudas de evidence', async () => {
    montar()
    fireEvent.click(await screen.findByTestId('insight-calc-dead_stock'))
    const facts = await screen.findByTestId('insight-facts')
    const t = facts.textContent || ''
    expect(t).toContain('Capital inmovilizado')
    expect(t).toContain('Inventario valorizado')
    expect(t).not.toContain('dead_value')
    expect(t).not.toContain('calculation_version')
  })

  it('5. fx_stale_prices: ambas cotizaciones en es-AR', async () => {
    estado.read = async () => ({ kind: 'ok', insights: [FX], generatedAt: new Date().toISOString() })
    montar()
    const msg = await screen.findByTestId('insight-message-fx_stale_prices')
    const t = norm(msg.textContent || '')
    expect(t).toContain('1.490,00')
    expect(t).toContain('1.546,00')
    expect(t).not.toContain('1,490.00')
  })

  it('6. sin NaN ni undefined en ninguna superficie', async () => {
    const { container } = montar()
    fireEvent.click(await screen.findByTestId('insight-calc-dead_stock'))
    const dlg = await screen.findByRole('dialog')
    expect(container.textContent).not.toMatch(/NaN|undefined/)
    expect(dlg.textContent).not.toMatch(/NaN|undefined/)
  })

  it('7. evidence incompleta degrada a guion sin romper', async () => {
    estado.read = async () => ({
      kind: 'ok', generatedAt: new Date().toISOString(),
      insights: [mkInsight('dead_stock', { current_value: null })],
    })
    montar()
    const msg = await screen.findByTestId('insight-message-dead_stock')
    expect(msg.textContent).toContain('—')
    expect(msg.textContent).not.toMatch(/NaN|undefined/)
  })

  it('8. rule_id desconocido cae al texto del server, sin JSON crudo', async () => {
    estado.read = async () => ({
      kind: 'ok', generatedAt: new Date().toISOString(),
      insights: [mkInsight('regla_futura', { current_value: 1 })],
    })
    montar()
    const msg = await screen.findByTestId('insight-message-regla_futura')
    expect(msg.textContent).toContain('FALLBACK CUALITATIVO DEL SERVER')
    expect(msg.textContent).not.toMatch(/[{}[\]]/)
  })

  it('9. textos largos no desbordan la tarjeta', async () => {
    estado.read = async () => ({
      kind: 'ok', generatedAt: new Date().toISOString(),
      insights: [mkInsight('dead_stock', {
        current_value: 0.595, dead_value: 10823941.50, inventory_at_cost: 18179810,
        dead_product_count: 348, total_product_count: 531, days_threshold: 90,
      }, { title: 'T'.repeat(160) })],
    })
    montar()
    const card = await screen.findByTestId('insight-dead_stock')
    // overflowWrap evita que una cadena sin espacios rompa el layout
    expect(getComputedStyle(card.querySelector('p')!).overflowWrap).toBe('anywhere')
  })

  it('10. el período del panel se muestra en formato es-AR', async () => {
    montar()
    const panel = await screen.findByTestId('finance-insights-panel')
    expect(panel.textContent).toContain('1/8/2026')
    expect(panel.textContent).toContain('7/8/2026')
  })
})
