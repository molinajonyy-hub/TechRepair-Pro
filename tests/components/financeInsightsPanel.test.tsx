// ─────────────────────────────────────────────────────────────────────────────
// M8 — contrato del panel de insights del lado de la app.
//
// Complementa a supabase/tests/m8_finance_insights_test.sql (esquema, RLS,
// reglas, idempotencia). Aca se prueba lo que vive en React:
//   · un ERROR nunca se muestra como "todo bien";
//   · maximo 3 visibles, ordenados por severidad (orden que fija el server);
//   · "Ver calculo" funciona SIN graficos;
//   · una accion a ruta inexistente NO se renderiza como link;
//   · una respuesta vieja no puede pisar a una nueva (cambio de periodo);
//   · nunca aparece $NaN, undefined, ni PII.
// ─────────────────────────────────────────────────────────────────────────────
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

const EV = (extra: Record<string, unknown> = {}) => ({
  metric: 'm', current_value: 1, threshold: { a: 1 },
  period_start: '2026-08-01', period_end: '2026-08-31',
  currency: 'ARS', source: 'v_finance_pnl', calculation_version: 'v1',
  sample_size: 31, ...extra,
})

const insight = (over: Record<string, unknown> = {}) => ({
  id: String(over.rule_id ?? 'x') + '-id',
  rule_id: 'dead_stock', rule_version: 'v1',
  period_start: '2026-08-01', period_end: '2026-08-31',
  severity: 'warning', title: 'Titulo', message: 'Mensaje',
  evidence: EV(), action: { label: 'Ver inventario', target_type: 'route', target: '/inventory' },
  status: 'active', impact_ars: 1000,
  generated_at: new Date().toISOString(), resolved_at: null,
  ...over,
})

const montar = () => render(
  <MemoryRouter>
    <FinanceInsightsPanel businessId="biz-1" periodStart="2026-08-01" periodEnd="2026-08-31" />
  </MemoryRouter>)

beforeEach(() => {
  cleanup()
  estado.read = async () => ({ kind: 'ok', insights: [], generatedAt: null })
  estado.generate = async () => ({ ok: true, fired: [], skipped: [], generatedAt: null, durationMs: 1 })
})

describe('FinanceInsightsPanel — estados', () => {
  it('1. muestra loading antes de resolver', async () => {
    let liberar: (v: unknown) => void = () => {}
    estado.read = () => new Promise(r => { liberar = r })
    montar()
    expect(screen.getByTestId('insights-loading')).toBeTruthy()
    liberar({ kind: 'ok', insights: [], generatedAt: null })
    await waitFor(() => expect(screen.queryByTestId('insights-loading')).toBeNull())
  })

  it('2. empty real: analizado y sin señales', async () => {
    estado.read = async () => ({ kind: 'ok', insights: [], generatedAt: new Date().toISOString() })
    montar()
    await waitFor(() => expect(screen.getByTestId('insights-empty')).toBeTruthy())
    expect(screen.getByTestId('insights-empty').textContent).toMatch(/no detectamos señales/i)
  })

  it('3. unavailable: un error NO se muestra como "todo bien"', async () => {
    estado.read = async () => ({ kind: 'unavailable', message: 'No pudimos cargar el análisis.' })
    montar()
    await waitFor(() => expect(screen.getByTestId('insights-unavailable')).toBeTruthy())
    expect(screen.queryByTestId('insights-empty')).toBeNull()
    const txt = screen.getByTestId('insights-unavailable').textContent || ''
    expect(txt).toMatch(/no podemos confirmar/i)
    expect(txt).not.toMatch(/todo (está )?(bien|perfecto)/i)
  })

  it('4. restricted: sin permiso, y tampoco dice que esté todo bien', async () => {
    estado.read = async () => ({ kind: 'restricted', message: 'No tenés permiso para ver el análisis financiero.' })
    montar()
    await waitFor(() => expect(screen.getByTestId('insights-restricted')).toBeTruthy())
    expect(screen.queryByTestId('insights-empty')).toBeNull()
  })

  it('12. retry vuelve a pedir y se recupera', async () => {
    let n = 0
    estado.read = async () => {
      n++
      return n === 1
        ? { kind: 'unavailable', message: 'fallo' }
        : { kind: 'ok', insights: [insight()], generatedAt: new Date().toISOString() }
    }
    montar()
    await waitFor(() => expect(screen.getByTestId('insights-retry')).toBeTruthy())
    fireEvent.click(screen.getByTestId('insights-retry'))
    await waitFor(() => expect(screen.getByTestId('insight-dead_stock')).toBeTruthy())
  })
})

describe('FinanceInsightsPanel — contenido', () => {
  it('5/6. muestra como maximo 3, en el orden que fija el server', async () => {
    const many = [
      insight({ rule_id: 'supplier_crunch', severity: 'critical', title: 'Crit' }),
      insight({ rule_id: 'dead_stock', severity: 'warning', title: 'Warn' }),
      insight({ rule_id: 'cc_aging', severity: 'warning', title: 'Warn2' }),
      insight({ rule_id: 'breakeven_day', severity: 'info', title: 'Info' }),
      insight({ rule_id: 'fx_stale_prices', severity: 'info', title: 'Info2' }),
    ]
    estado.read = async () => ({ kind: 'ok', insights: many, generatedAt: new Date().toISOString() })
    const { container } = montar()
    await waitFor(() => expect(screen.getByTestId('insight-supplier_crunch')).toBeTruthy())

    const cards = container.querySelectorAll('[data-testid^="insight-"][data-severity]')
    expect(cards.length).toBe(3)
    expect(cards[0].getAttribute('data-severity')).toBe('critical')
    // el 4to y 5to quedan fuera pero se anuncian
    expect(screen.getByTestId('insights-hidden-count').textContent).toMatch(/2 señales/)
    expect(screen.queryByTestId('insight-fx_stale_prices')).toBeNull()
  })

  it('7. "Ver cálculo" abre el detalle sin necesitar graficos', async () => {
    estado.read = async () => ({
      kind: 'ok', generatedAt: new Date().toISOString(),
      insights: [insight({ evidence: EV({ dead_value: 12345.5, dead_product_count: 7 }) })],
    })
    montar()
    await waitFor(() => expect(screen.getByTestId('insight-calc-dead_stock')).toBeTruthy())
    fireEvent.click(screen.getByTestId('insight-calc-dead_stock'))

    const dlg = await screen.findByRole('dialog')
    expect(dlg.textContent).toMatch(/Ver cálculo/)
    expect(dlg.textContent).toMatch(/v_finance_pnl/)     // fuente visible
    expect(dlg.textContent).toMatch(/dead_product_count/) // los numeros crudos
  })

  it('8/9. accion valida se linkea; ruta inexistente NO se renderiza', async () => {
    estado.read = async () => ({
      kind: 'ok', generatedAt: new Date().toISOString(),
      insights: [
        insight({ rule_id: 'dead_stock', action: { label: 'Ver inventario', target_type: 'route', target: '/inventory' } }),
        insight({ rule_id: 'cc_aging', severity: 'info',
          action: { label: 'Ver gráfico', target_type: 'route', target: '/finance/charts/waterfall' } }),
      ],
    })
    montar()
    await waitFor(() => expect(screen.getByTestId('insight-action-dead_stock')).toBeTruthy())
    expect(screen.getByTestId('insight-action-dead_stock').getAttribute('href')).toBe('/inventory')
    // la ruta que no existe en el router no produce link
    expect(screen.queryByTestId('insight-action-cc_aging')).toBeNull()
    // pero el insight igual se muestra, con su "ver calculo"
    expect(screen.getByTestId('insight-calc-cc_aging')).toBeTruthy()
  })

  it('17/18/19. importes y porcentajes sin NaN ni undefined', async () => {
    estado.read = async () => ({
      kind: 'ok', generatedAt: new Date().toISOString(),
      insights: [insight({
        evidence: EV({
          dead_value: 1234567.89, dead_pct: 0.2734,
          comparison_value: null, delta: undefined as unknown as number,
        }),
      })],
    })
    const { container } = montar()
    await waitFor(() => expect(screen.getByTestId('insight-calc-dead_stock')).toBeTruthy())
    fireEvent.click(screen.getByTestId('insight-calc-dead_stock'))
    const dlg = await screen.findByRole('dialog')

    expect(dlg.textContent).not.toMatch(/NaN/)
    expect(dlg.textContent).not.toMatch(/undefined/)
    expect(container.textContent).not.toMatch(/NaN|undefined/)
    // el monto se formatea como ARS
    expect(dlg.textContent).toMatch(/1\.234\.567,89/)
  })

  it('20. no filtra datos privados del contrato', async () => {
    estado.read = async () => ({
      kind: 'ok', generatedAt: new Date().toISOString(),
      insights: [insight({ evidence: EV({ top_debtor_count: 2, top_debtor_share: 0.6 }) })],
    })
    const { container } = montar()
    await waitFor(() => expect(screen.getByTestId('insight-calc-dead_stock')).toBeTruthy())
    fireEvent.click(screen.getByTestId('insight-calc-dead_stock'))
    const dlg = await screen.findByRole('dialog')
    // concentracion sin nombres: solo conteo y proporcion
    expect(dlg.textContent).toMatch(/top_debtor_count/)
    expect(container.textContent).not.toMatch(/@|\+54|DNI|CUIT/)
  })
})

describe('FinanceInsightsPanel — carreras y periodo', () => {
  it('10. una respuesta vieja no pisa a la nueva', async () => {
    const lentaVieja = new Promise(r => setTimeout(
      () => r({ kind: 'ok', insights: [insight({ rule_id: 'dead_stock', title: 'VIEJA' })], generatedAt: new Date().toISOString() }), 60))
    const rapidaNueva = Promise.resolve(
      { kind: 'ok', insights: [insight({ rule_id: 'cc_aging', title: 'NUEVA' })], generatedAt: new Date().toISOString() })

    let n = 0
    estado.read = () => { n++; return (n === 1 ? lentaVieja : rapidaNueva) as Promise<never> }

    const { rerender } = render(
      <MemoryRouter>
        <FinanceInsightsPanel businessId="biz-1" periodStart="2026-08-01" periodEnd="2026-08-31" />
      </MemoryRouter>)
    // cambio de periodo antes de que resuelva la primera
    rerender(
      <MemoryRouter>
        <FinanceInsightsPanel businessId="biz-1" periodStart="2026-07-01" periodEnd="2026-07-31" />
      </MemoryRouter>)

    await waitFor(() => expect(screen.getByTestId('insight-cc_aging')).toBeTruthy())
    await new Promise(r => setTimeout(r, 120))   // deja resolver a la vieja
    expect(screen.queryByTestId('insight-dead_stock')).toBeNull()
    expect(screen.getByTestId('insight-cc_aging')).toBeTruthy()
  })

  it('11. cambiar de periodo vuelve a consultar con las fechas nuevas', async () => {
    const llamadas: unknown[][] = []
    estado.read = async (...a: unknown[]) => { llamadas.push(a); return { kind: 'ok', insights: [], generatedAt: null } }

    const { rerender } = render(
      <MemoryRouter>
        <FinanceInsightsPanel businessId="biz-1" periodStart="2026-08-01" periodEnd="2026-08-31" />
      </MemoryRouter>)
    await waitFor(() => expect(llamadas.length).toBe(1))

    rerender(
      <MemoryRouter>
        <FinanceInsightsPanel businessId="biz-1" periodStart="2026-07-01" periodEnd="2026-07-31" />
      </MemoryRouter>)
    await waitFor(() => expect(llamadas.length).toBe(2))
    expect(llamadas[1][1]).toBe('2026-07-01')
    expect(llamadas[1][2]).toBe('2026-07-31')
  })

  it('13. "Actualizar análisis" genera UNA vez y relee', async () => {
    let gens = 0
    estado.generate = async () => { gens++; return { ok: true, fired: ['dead_stock'], skipped: [], generatedAt: new Date().toISOString(), durationMs: 5 } }
    estado.read = async () => ({ kind: 'ok', insights: [insight()], generatedAt: new Date().toISOString() })
    montar()
    await waitFor(() => expect(screen.getByTestId('insights-refresh')).toBeTruthy())
    fireEvent.click(screen.getByTestId('insights-refresh'))
    await waitFor(() => expect(gens).toBe(1))
    // no se dispara una RPC por regla
    expect(gens).toBe(1)
  })

  it('14. un fallo al generar NO se muestra como "sin insights"', async () => {
    estado.generate = async () => ({ ok: false, fired: [], skipped: [], generatedAt: null, durationMs: null, error: 'No se pudo generar el análisis' })
    montar()
    await waitFor(() => expect(screen.getByTestId('insights-refresh')).toBeTruthy())
    fireEvent.click(screen.getByTestId('insights-refresh'))
    await waitFor(() => expect(screen.getByTestId('insights-unavailable')).toBeTruthy())
    expect(screen.queryByTestId('insights-empty')).toBeNull()
  })

  it('15. marca el análisis como desactualizado cuando es viejo', async () => {
    const viejo = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString()
    estado.read = async () => ({ kind: 'ok', insights: [insight()], generatedAt: viejo })
    montar()
    await waitFor(() => expect(screen.getByTestId('insights-generated-at')).toBeTruthy())
    expect(screen.getByTestId('insights-generated-at').textContent).toMatch(/desactualizado/i)
  })

  it('16. el panel muestra el período analizado', async () => {
    estado.read = async () => ({ kind: 'ok', insights: [], generatedAt: null })
    montar()
    await waitFor(() => expect(screen.getByTestId('finance-insights-panel')).toBeTruthy())
    expect(screen.getByTestId('finance-insights-panel').textContent).toMatch(/1\/8\/2026.*31\/8\/2026/)
  })
})
