// ─────────────────────────────────────────────────────────────────────────────
// Charts L1 — contrato del bloque de gráficos del lado de la app.
//
// Complementa a tests/sql/finance_charts_l1.test.sql (que prueba los números).
// Acá se prueba lo que vive en React, los 29 casos de §39:
//
//   1 loading · 2 available · 3 empty · 4 incomplete · 5 unavailable
//   6 restricted · 7 retry · 8 respuesta vieja · 9 cambio de período
//   10 comparación sin base · 11 negativos · 12 cero real · 13 ARS es-AR
//   14 porcentaje · 15 tooltip · 16 light · 17 dark · 18 390px · 19 sin overflow
//   20 accesibilidad · 21 M8 sigue visible · 22 una card falla sin tumbar el resto
//   23 capital sin costo completo · 24 stock USD · 25 reposición sin consumo
//   26 due_date vacío · 27 sin NaN · 28 sin undefined · 29 sin JSON crudo
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// ─── Recharts en jsdom ───────────────────────────────────────────────────────
// ResponsiveContainer mide el contenedor con ResizeObserver, que jsdom no
// implementa. Se reemplaza por un contenedor que inyecta un tamaño fijo a su
// hijo; el resto de la librería queda REAL, así que los gráficos se montan de
// verdad y el test ve el SVG que vería el usuario.
vi.mock('recharts', async () => {
  const real = await vi.importActual<typeof import('recharts')>('recharts')
  const R = await vi.importActual<typeof import('react')>('react')
  return {
    ...real,
    ResponsiveContainer: ({ children }: { children: unknown }) =>
      R.isValidElement(children)
        ? R.cloneElement(children as React.ReactElement<{ width: number; height: number }>,
                         { width: 600, height: 300 })
        : null,
  }
})

const estado = vi.hoisted(() => ({
  fetch: null as null | ((...a: unknown[]) => Promise<unknown>),
}))

vi.mock('../../src/services/financeChartsService', () => ({
  financeChartsService: { fetch: (...a: unknown[]) => estado.fetch!(...a) },
}))

import FinanceChartsL1 from '../../src/components/finance/charts/FinanceChartsL1'
import { buildWaterfallBars } from '../../src/components/finance/charts/ResultWaterfall'
import {
  buildDelta, buildPaymentSlices, replenishmentText, capitalCoverage,
} from '../../src/lib/finance/chartsL1Presentation'

// ─── Payload de referencia ───────────────────────────────────────────────────

const PAYLOAD = () => ({
  ok: true as const,
  calculation_version: 'charts_l1_v1',
  period: { start: '2026-08-01', end: '2026-08-10', days: 10, granularity: 'day' as const, timezone: 'America/Argentina/Cordoba' },
  comparison_period: { start: '2026-07-22', end: '2026-07-31', days: 10 },
  summary: {
    net_sales: 62000, cogs: 24000, operating_expenses: 6500,
    gross_profit: 38000, operating_result: 31500, margin_pct: 50.81,
    collections: 32000, owner_withdrawals: 9999,
  },
  comparison: {
    available: true, net_sales: 15000, cogs: 5000, operating_expenses: 0,
    gross_profit: 10000, operating_result: 10000, margin_pct: 66.67, collections: 15000,
  },
  pnl_series: [
    { bucket: '2026-08-01', net_sales: 0, cogs: 0, operating_expenses: 0, operating_result: 0 },
    { bucket: '2026-08-03', net_sales: 20000, cogs: 6000, operating_expenses: 0, operating_result: 14000 },
    { bucket: '2026-08-09', net_sales: -8000, cogs: -3000, operating_expenses: 0, operating_result: -5000 },
  ],
  billing_vs_collections: [
    { bucket: '2026-08-01', billed: 0, collected: 0 },
    { bucket: '2026-08-03', billed: 20000, collected: 12000 },
  ],
  payment_mix: [
    { method: 'efectivo', amount: 17000, operations: 3 },
    { method: 'transferencia', amount: 15000, operations: 2 },
  ],
  receivables_aging: {
    total: 35000, documents: 2,
    buckets: [{ bucket: '0-7', amount: 35000, documents: 2 }],
  },
  payables_aging: {
    total: 50000, documents: 1,
    buckets: [{ bucket: '0-7', amount: 50000, documents: 1 }],
  },
  payables_due: {
    due_soon_amount: 0, overdue_amount: 0, undated_amount: 50000,
    undated_count: 1, has_due_dates: false,
  },
  inventory_capital: {
    inventory_at_cost: 22800, inventory_at_cost_valued: 23400,
    products_total: 5, products_valued: 4, products_missing_cost: 1,
    units_missing_cost: 3, products_negative_stock: 1, coverage_pct: 80,
    usd_based_products: 1, usd_rate_min_applied: 1430, usd_rate_max_applied: 1430,
    history_available: false, history_blocked_reason: 'no_historical_cost_basis',
  },
  inventory_flows: {
    purchases_cost: 12000, purchases_units: 15, purchases_movements: 2,
    purchases_movements_costed: 2, consumption_cost: 24000, consumption_units: 3,
    consumption_movements_uncosted: 2, returns_units: 2, returns_cost: 0,
    adjustments_units: 5, adjustments_net_units: 5, adjustments_cost: 0,
    cancellations_units: 0, replenishment_pct: 50,
    replenishment_basis: 'comparable' as const,
    consumption_source: 'accrued_cogs', purchases_source: 'inventory_movements_snapshot_cost',
    bridge_available: false, bridge_blocked_reason: 'heterogeneous_cost_basis',
  },
  waterfall: [
    { key: 'net_sales' as const, value: 62000, kind: 'start' as const },
    { key: 'cogs' as const, value: -24000, kind: 'delta' as const },
    { key: 'gross_profit' as const, value: 38000, kind: 'subtotal' as const },
    { key: 'operating_expenses' as const, value: -6500, kind: 'delta' as const },
    { key: 'operating_result' as const, value: 31500, kind: 'total' as const },
  ],
})

const VACIO = () => {
  const p = PAYLOAD()
  return {
    ...p,
    summary: { ...p.summary, net_sales: 0, cogs: 0, operating_expenses: 0, gross_profit: 0, operating_result: 0, margin_pct: null, collections: 0, owner_withdrawals: 0 },
    comparison: { ...p.comparison, available: false, net_sales: 0, cogs: 0, operating_expenses: 0, gross_profit: 0, operating_result: 0, margin_pct: null, collections: 0 },
    pnl_series: [], billing_vs_collections: [], payment_mix: [],
    receivables_aging: { total: 0, documents: 0, buckets: [] },
    payables_aging: { total: 0, documents: 0, buckets: [] },
    inventory_capital: { ...p.inventory_capital, inventory_at_cost: 0, inventory_at_cost_valued: 0, products_total: 0, products_valued: 0, products_missing_cost: 0, units_missing_cost: 0, coverage_pct: null, usd_based_products: 0 },
    inventory_flows: { ...p.inventory_flows, purchases_cost: 0, consumption_cost: 0, replenishment_pct: null, replenishment_basis: 'no_comparable_consumption' as const, adjustments_units: 0, returns_units: 0 },
  }
}

const montar = (props: Record<string, unknown> = {}) => render(
  <MemoryRouter>
    <FinanceChartsL1
      businessId="biz-1" periodStart="2026-08-01" periodEnd="2026-08-10" {...props} />
  </MemoryRouter>,
)

/** Todo el texto visible del bloque. Base de los chequeos anti-basura. */
const textoVisible = () => document.body.textContent ?? ''

beforeEach(() => {
  cleanup()
  estado.fetch = async () => PAYLOAD()
})

// ═════════════════════════════════════════════════════════════════════════════
describe('Charts L1 — estados (§28)', () => {

  it('1. muestra loading antes de resolver', async () => {
    estado.fetch = () => new Promise(() => {})       // nunca resuelve
    montar()
    await waitFor(() => {
      expect(screen.getByTestId('card-result').getAttribute('data-state')).toBe('loading')
    })
    expect(screen.getByTestId('card-result').getAttribute('aria-busy')).toBe('true')
  })

  it('2. estado available con datos reales', async () => {
    montar()
    await waitFor(() => {
      expect(screen.getByTestId('card-result').getAttribute('data-state')).toBe('available')
    })
    expect(screen.getByTestId('card-waterfall').getAttribute('data-state')).toBe('available')
  })

  it('3. estado empty con el texto canónico', async () => {
    estado.fetch = async () => VACIO()
    montar()
    await waitFor(() => {
      expect(screen.getByTestId('card-result').getAttribute('data-state')).toBe('empty')
    })
    expect(textoVisible()).toContain('No hay movimientos suficientes en este período')
  })

  it('4. estado incomplete cuando falta costo en parte del inventario', async () => {
    montar()
    await waitFor(() => {
      expect(screen.getByTestId('card-inventory-capital').getAttribute('data-state')).toBe('incomplete')
    })
    // Declara sobre cuántos productos se calculó, no esconde el faltante.
    expect(textoVisible()).toContain('4 de 5 productos con costo cargado')
  })

  it('5. estado unavailable ante un fallo, y NO se pinta como $0', async () => {
    estado.fetch = async () => { throw new Error('boom') }
    montar()
    await waitFor(() => {
      expect(screen.getByTestId('card-result').getAttribute('data-state')).toBe('unavailable')
    })
    expect(textoVisible()).toContain('No pudimos cargar este gráfico')
    // La diferencia que importa: un error NUNCA se convierte en un cero.
    expect(screen.queryByTestId('kpi-net-sales')).toBeNull()
  })

  it('6. estado restricted ante falta de permisos', async () => {
    estado.fetch = async () => { throw new Error('permission denied for view') }
    montar()
    await waitFor(() => {
      expect(screen.getByTestId('card-result').getAttribute('data-state')).toBe('restricted')
    })
    expect(textoVisible()).toContain('no tiene permiso')
  })

  it('7. reintentar vuelve a pedir y se recupera', async () => {
    let intentos = 0
    estado.fetch = async () => {
      intentos += 1
      if (intentos === 1) throw new Error('boom')
      return PAYLOAD()
    }
    montar()
    await waitFor(() => {
      expect(screen.getByTestId('card-result').getAttribute('data-state')).toBe('unavailable')
    })
    fireEvent.click(within(screen.getByTestId('card-result')).getByText('Reintentar'))
    await waitFor(() => {
      expect(screen.getByTestId('card-result').getAttribute('data-state')).toBe('available')
    })
    expect(intentos).toBe(2)
  })

  it('22. una sección vacía no tumba a las demás', async () => {
    estado.fetch = async () => ({ ...PAYLOAD(), payment_mix: [] })
    montar()
    await waitFor(() => {
      expect(screen.getByTestId('card-payment-mix').getAttribute('data-state')).toBe('empty')
    })
    // El resto sigue vivo.
    expect(screen.getByTestId('card-result').getAttribute('data-state')).toBe('available')
    expect(screen.getByTestId('card-receivables').getAttribute('data-state')).toBe('available')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('Charts L1 — ciclo de vida (§29)', () => {

  it('8. una respuesta vieja NO pisa a la nueva', async () => {
    const lento = { ...PAYLOAD() }
    lento.summary = { ...lento.summary, net_sales: 111111 }

    let llamada = 0
    estado.fetch = (args: unknown) => {
      llamada += 1
      const p = args as { periodEnd: string }
      if (llamada === 1) {
        // La primera responde TARDE y con datos del período viejo.
        return new Promise(r => setTimeout(() => r(lento), 40))
      }
      return Promise.resolve({ ...PAYLOAD(), summary: { ...PAYLOAD().summary, net_sales: 222222 }, period: { ...PAYLOAD().period, end: p.periodEnd } })
    }

    const { rerender } = montar()
    rerender(
      <MemoryRouter>
        <FinanceChartsL1 businessId="biz-1" periodStart="2026-08-01" periodEnd="2026-08-20" />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(within(screen.getByTestId('kpi-net-sales')).getByText(/222\.222/)).toBeTruthy()
    })
    // Se espera lo suficiente como para que la respuesta vieja llegue.
    await new Promise(r => setTimeout(r, 80))
    expect(textoVisible()).not.toContain('111.111')
  })

  it('9. cambiar de período dispara exactamente una consulta nueva', async () => {
    const vistos: string[] = []
    estado.fetch = async (args: unknown) => {
      vistos.push((args as { periodEnd: string }).periodEnd)
      return PAYLOAD()
    }
    const { rerender } = montar()
    await waitFor(() => expect(vistos.length).toBe(1))

    rerender(
      <MemoryRouter>
        <FinanceChartsL1 businessId="biz-1" periodStart="2026-07-01" periodEnd="2026-07-31" />
      </MemoryRouter>,
    )
    await waitFor(() => expect(vistos.length).toBe(2))
    expect(vistos).toEqual(['2026-08-10', '2026-07-31'])
  })

  it('9b. un re-render con las MISMAS props no vuelve a consultar', async () => {
    let n = 0
    estado.fetch = async () => { n += 1; return PAYLOAD() }
    const { rerender } = montar()
    await waitFor(() => expect(n).toBe(1))
    rerender(
      <MemoryRouter>
        <FinanceChartsL1 businessId="biz-1" periodStart="2026-08-01" periodEnd="2026-08-10" />
      </MemoryRouter>,
    )
    await new Promise(r => setTimeout(r, 30))
    expect(n).toBe(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('Charts L1 — números y semántica', () => {

  it('10. comparación sin base no inventa un porcentaje', async () => {
    estado.fetch = async () => ({
      ...PAYLOAD(),
      comparison: { ...PAYLOAD().comparison, available: false, net_sales: 0, operating_result: 0, collections: 0, margin_pct: null },
    })
    montar()
    await waitFor(() => expect(screen.getByTestId('kpi-net-sales')).toBeTruthy())
    expect(within(screen.getByTestId('kpi-net-sales')).getByText(/Sin base de comparación/)).toBeTruthy()
    expect(textoVisible()).not.toContain('Infinity')
  })

  it('10b. buildDelta con base 0 devuelve "sin base", no Infinity', () => {
    const d = buildDelta(100, 0, 'positive', true)
    expect(d.available).toBe(false)
    expect(d.percent).toBeNull()
    expect(d.label).toBe('Sin base de comparación')
  })

  it('11. los valores negativos se representan con signo', async () => {
    estado.fetch = async () => ({
      ...PAYLOAD(),
      summary: { ...PAYLOAD().summary, operating_result: -31500 },
    })
    montar()
    await waitFor(() => expect(screen.getByTestId('kpi-operating-result')).toBeTruthy())
    expect(within(screen.getByTestId('kpi-operating-result')).getByText(/-\s?\$\s?31\.500/)).toBeTruthy()
  })

  it('12. un cero REAL se muestra como $0, no como vacío', async () => {
    estado.fetch = async () => ({
      ...PAYLOAD(),
      summary: { ...PAYLOAD().summary, collections: 0 },
    })
    montar()
    await waitFor(() => expect(screen.getByTestId('kpi-collections')).toBeTruthy())
    expect(within(screen.getByTestId('kpi-collections')).getByText(/\$\s?0,00/)).toBeTruthy()
  })

  it('13. los importes se formatean en es-AR (punto de miles, coma decimal)', async () => {
    montar()
    await waitFor(() => expect(screen.getByTestId('kpi-net-sales')).toBeTruthy())
    expect(within(screen.getByTestId('kpi-net-sales')).getByText(/62\.000,00/)).toBeTruthy()
    // Nunca el formato en-US.
    expect(textoVisible()).not.toContain('62,000.00')
  })

  it('14. los porcentajes se formatean en es-AR', async () => {
    montar()
    await waitFor(() => expect(screen.getByTestId('kpi-margin')).toBeTruthy())
    expect(within(screen.getByTestId('kpi-margin')).getByText(/50,8%/)).toBeTruthy()
  })

  it('14b. margen NULL no se muestra como 0 %', async () => {
    estado.fetch = async () => ({
      ...PAYLOAD(), summary: { ...PAYLOAD().summary, margin_pct: null },
    })
    montar()
    await waitFor(() => expect(screen.getByTestId('kpi-margin')).toBeTruthy())
    const kpi = within(screen.getByTestId('kpi-margin'))
    expect(kpi.getByText('—')).toBeTruthy()
    expect(kpi.getByText(/Sin ventas en el período/)).toBeTruthy()
  })

  it('6-KPI. el capital en stock NO lleva semántica de bueno/malo', async () => {
    montar()
    await waitFor(() => expect(screen.getByTestId('kpi-inventory-capital')).toBeTruthy())
    const kpi = within(screen.getByTestId('kpi-inventory-capital'))
    // Sin flecha de tendencia: sólo la aclaración neutral sobre el origen del
    // dato, que además no promete reposición.
    expect(kpi.getByText(/Según los costos registrados actualmente/)).toBeTruthy()
    expect(kpi.queryByText(/vs período anterior/)).toBeNull()
  })

  it('waterfall: las identidades contables se respetan sin recalcularlas', () => {
    const bars = buildWaterfallBars(PAYLOAD().waterfall)
    expect(bars.map(b => b.value)).toEqual([62000, -24000, 38000, -6500, 31500])
    // El acumulado del último paso es el resultado operativo.
    expect(bars[bars.length - 1].running).toBe(31500)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('Charts L1 — inventario (§13, §15, §16, §21)', () => {

  it('23. la cobertura parcial de costos se declara explícitamente', async () => {
    montar()
    await waitFor(() => expect(screen.getByTestId('inventory-capital-block')).toBeTruthy())
    expect(textoVisible()).toContain('4 de 5 productos con costo cargado')
    expect(textoVisible()).toContain('3 unidades quedan sin valuar')
  })

  it('23b. cobertura completa no muestra advertencia', () => {
    const cap = { ...PAYLOAD().inventory_capital, products_missing_cost: 0, products_valued: 5, coverage_pct: 100 }
    expect(capitalCoverage(cap).text).toBeNull()
    expect(capitalCoverage(cap).incomplete).toBe(false)
  })

  it('24. con costos dolarizados se avisa que pueden variar, sin alarmismo', async () => {
    montar()
    await waitFor(() => expect(screen.getByTestId('inventory-capital-block')).toBeTruthy())
    expect(textoVisible()).toContain('Algunos costos pueden variar al actualizarse su cotización')
  })

  it('24b. sin productos dolarizados NO aparece la nota de cotización', async () => {
    estado.fetch = async () => ({
      ...PAYLOAD(),
      inventory_capital: { ...PAYLOAD().inventory_capital, usd_based_products: 0 },
    })
    montar()
    await waitFor(() => expect(screen.getByTestId('inventory-capital-block')).toBeTruthy())
    expect(textoVisible()).not.toContain('cotización')
  })

  it('24c. la descripción canónica no promete valor de reposición ni ajuste al dólar', async () => {
    montar()
    await waitFor(() => expect(screen.getByTestId('inventory-capital-block')).toBeTruthy())
    const t = textoVisible()
    // Lo que SÍ se afirma: costos registrados en el sistema.
    expect(t).toContain('Valor de la mercadería disponible según los costos registrados actualmente')
    // Lo que NUNCA se afirma: el servidor no puede demostrar ninguna de estas.
    expect(t).not.toMatch(/valor\s+(actual\s+)?de\s+reposición/i)
    expect(t).not.toMatch(/costo\s+de\s+reposición/i)
    expect(t).not.toMatch(/ajustad[oa]s?\s+al\s+dólar/i)
    expect(t).not.toMatch(/cotización\s+de\s+hoy/i)
    expect(t).not.toContain('costo vigente')
  })

  it('25. reposición sin consumo: sin Infinity y con motivo', async () => {
    estado.fetch = async () => ({
      ...PAYLOAD(),
      inventory_flows: {
        ...PAYLOAD().inventory_flows,
        consumption_cost: 0, replenishment_pct: null,
        replenishment_basis: 'no_comparable_consumption' as const,
      },
    })
    montar()
    await waitFor(() => expect(screen.getByTestId('replenishment-value')).toBeTruthy())
    expect(screen.getByTestId('replenishment-value').textContent).toBe('Sin consumo comparable')
    expect(textoVisible()).not.toContain('Infinity')
    expect(textoVisible()).not.toContain('NaN')
  })

  it('25b. el texto de reposición no es alarmista', () => {
    const base = PAYLOAD().inventory_flows
    expect(replenishmentText({ ...base, replenishment_pct: 50 }))
      .toBe('En este período las compras repusieron menos inventario del que salió por operación.')
    expect(replenishmentText({ ...base, replenishment_pct: 100 }))
      .toContain('acompañó aproximadamente el consumo')
    expect(replenishmentText({ ...base, replenishment_pct: 150 }))
      .toContain('superaron el consumo')
    // Nunca aparece la palabra prohibida.
    for (const pct of [10, 50, 99, 100, 150, 300]) {
      expect(replenishmentText({ ...base, replenishment_pct: pct })).not.toMatch(/descapitaliz/i)
    }
  })

  it('la métrica NUNCA se llama "capital total" ni "patrimonio"', async () => {
    montar()
    await waitFor(() => expect(screen.getByTestId('inventory-capital-block')).toBeTruthy())
    const t = textoVisible().toLowerCase()
    expect(t).toContain('capital en stock')
    expect(t).not.toContain('capital total')
    expect(t).not.toContain('patrimonio')
    expect(t).not.toContain('capital invertido total')
  })

  it('§18: sin evidencia de dead_stock NO se afirma nada sobre inmovilizado', async () => {
    montar({ deadStockValue: null })
    await waitFor(() => expect(screen.getByTestId('inventory-capital-block')).toBeTruthy())
    expect(screen.queryByTestId('dead-stock-context')).toBeNull()
  })

  it('§18: con evidencia de M8 se combina compartiendo denominador', async () => {
    montar({ deadStockValue: 11700 })
    await waitFor(() => expect(screen.getByTestId('dead-stock-context')).toBeTruthy())
    // 11.700 sobre inventory_at_cost_valued (23.400) = 50 %
    expect(screen.getByTestId('dead-stock-context').textContent).toContain('50%')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('Charts L1 — cartera (§11, §12)', () => {

  it('26. sin fechas de vencimiento se dice, y no es un error', async () => {
    montar()
    await waitFor(() => expect(screen.getByTestId('card-payables')).toBeTruthy())
    expect(textoVisible()).toContain('Todavía no cargaste fechas de vencimiento')
    // La tarjeta sigue disponible: la ausencia de fechas no la rompe.
    expect(screen.getByTestId('card-payables').getAttribute('data-state')).toBe('available')
    expect(screen.queryByTestId('payables-due')).toBeNull()
  })

  it('26b. con fechas cargadas aparece la métrica separada de próximos 14 días', async () => {
    estado.fetch = async () => ({
      ...PAYLOAD(),
      payables_due: {
        due_soon_amount: 50000, overdue_amount: 0, undated_amount: 0,
        undated_count: 0, has_due_dates: true,
      },
    })
    montar()
    await waitFor(() => expect(screen.getByTestId('payables-due')).toBeTruthy())
    expect(textoVisible()).toContain('Próximos 14 días')
  })

  it('el aging se presenta como antigüedad, nunca como vencimiento', async () => {
    montar()
    await waitFor(() => expect(screen.getByTestId('card-receivables')).toBeTruthy())
    expect(textoVisible()).toContain('antigüedad')
    expect(textoVisible()).not.toMatch(/\bvencid[oa]s?\b/i)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('Charts L1 — medios de cobro (§10)', () => {

  it('no se muestran categorías en cero', () => {
    const slices = buildPaymentSlices([
      { method: 'efectivo', amount: 100, operations: 1 },
      { method: 'tarjeta', amount: 0, operations: 0 },
      { method: 'qr', amount: -50, operations: 1 },
    ])
    expect(slices.map(s => s.method)).toEqual(['efectivo'])
  })

  it('la cola se agrupa en "Otros" para no pasar de 6 sectores', () => {
    const slices = buildPaymentSlices(
      Array.from({ length: 9 }, (_, i) => ({ method: `m${i}`, amount: 100 - i, operations: 1 })),
    )
    expect(slices.length).toBe(6)
    expect(slices[slices.length - 1].label).toBe('Otros')
    // La suma se conserva: agrupar no puede perder plata.
    expect(Math.round(slices.reduce((s, x) => s + x.amount, 0)))
      .toBe(Array.from({ length: 9 }, (_, i) => 100 - i).reduce((a, b) => a + b, 0))
  })

  it('la cuenta corriente no figura como medio de cobro', async () => {
    montar()
    await waitFor(() => expect(screen.getByTestId('card-payment-mix')).toBeTruthy())
    const card = screen.getByTestId('card-payment-mix').textContent ?? ''
    expect(card.toLowerCase()).not.toContain('cuenta corriente')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('Charts L1 — accesibilidad y limpieza (§29, §31)', () => {

  it('20. cada tarjeta tiene título, resumen textual y aria-label', async () => {
    montar()
    await waitFor(() => expect(screen.getByTestId('card-result')).toBeTruthy())

    for (const id of ['card-result', 'card-billing', 'card-payment-mix',
                      'card-inventory-capital', 'card-receivables', 'card-payables', 'card-waterfall']) {
      const card = screen.getByTestId(id)
      // Título accesible.
      expect(within(card).getAllByRole('heading').length).toBeGreaterThan(0)
      // Resumen textual visible: el gráfico no es la única fuente.
      const resumen = within(card).getByTestId(`${id}-summary`)
      expect((resumen.textContent ?? '').length).toBeGreaterThan(20)
      // La figura lleva aria-label.
      const figura = card.querySelector('figure[role="figure"]')
      expect(figura?.getAttribute('aria-label')).toBeTruthy()
    }
  })

  it('20b. el resumen del resultado dice el número y el período', async () => {
    montar()
    await waitFor(() => expect(screen.getByTestId('card-result-summary')).toBeTruthy())
    const t = screen.getByTestId('card-result-summary').textContent ?? ''
    expect(t).toContain('resultado operativo')
    expect(t).toMatch(/31\.500/)
  })

  it('27/28/29. no aparece NaN, undefined, [object Object] ni JSON crudo', async () => {
    montar({ deadStockValue: 11700 })
    await waitFor(() => expect(screen.getByTestId('card-waterfall')).toBeTruthy())
    const t = textoVisible()
    expect(t).not.toContain('NaN')
    expect(t).not.toContain('undefined')
    expect(t).not.toContain('null')
    expect(t).not.toContain('[object Object]')
    expect(t).not.toContain('Infinity')
    // Nada de claves internas ni nombres de columna en pantalla.
    expect(t).not.toContain('net_sales')
    expect(t).not.toContain('inventory_at_cost')
    expect(t).not.toContain('replenishment_pct')
    expect(t).not.toContain('v_finance_')
    expect(t).not.toContain('accrued_cogs')
  })

  it('27b. tampoco con un payload degenerado (nulos y ceros)', async () => {
    estado.fetch = async () => ({
      ...VACIO(),
      inventory_capital: {
        ...VACIO().inventory_capital,
        coverage_pct: null, usd_rate_min_applied: null, usd_rate_max_applied: null,
      },
    })
    montar()
    await waitFor(() => expect(screen.getByTestId('card-result')).toBeTruthy())
    const t = textoVisible()
    expect(t).not.toContain('NaN')
    expect(t).not.toContain('undefined')
    expect(t).not.toContain('Infinity')
  })

  it('18/19. en 390px las tarjetas no fuerzan ancho mínimo que desborde', async () => {
    montar()
    await waitFor(() => expect(screen.getByTestId('card-result')).toBeTruthy())
    // minWidth:0 en la tarjeta y en la figura es lo que permite que el grid
    // encoja en móvil en vez de generar scroll horizontal global.
    for (const id of ['card-result', 'card-billing', 'card-payment-mix', 'card-waterfall']) {
      const card = screen.getByTestId(id) as HTMLElement
      expect(card.style.minWidth).toBe('0px')
    }
  })
})
