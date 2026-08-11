// ─────────────────────────────────────────────────────────────────────────────
// Pre-beta P1 — cierre de P1-A (Finanzas → Caja en móvil) y P1-D (semántica de
// la reposición registrada).
//
// P1-A (§10): 1440 desktop · 390x844 · light · dark · las 4 tarjetas visibles ·
//   ninguna fuera del viewport · sin overflow horizontal global · ninguna
//   tarjeta oculta · ningún valor monetario truncado de forma destructiva.
//
//   jsdom no hace layout (todo mide 0x0), así que la verificación geométrica
//   real vive en el gate visual de Playwright
//   (tests/e2e/m7/finance-caja-visual.spec.ts). Acá se verifica lo que jsdom SÍ
//   puede probar y que es exactamente la causa raíz: la grilla declarada y las
//   propiedades que permiten encoger. Un `repeat(N, 1fr)` de vuelta hace fallar
//   este archivo sin necesidad de levantar un navegador.
//
// P1-D (§13): A) % normal · B) 0 % sin acusar · C) 0 % con contexto de
//   proveedor · D) sin base · E) deuda que no era mercadería · F) sin datos.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

// ─── Recharts en jsdom ───────────────────────────────────────────────────────
// ResponsiveContainer mide con ResizeObserver, que jsdom no implementa. Mismo
// reemplazo que financeChartsL1.test.tsx: el resto de la librería queda REAL.
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

import { render, screen, cleanup, within } from '@testing-library/react'
import {
  replenishmentCopy, replenishmentText, REPLENISHMENT_LABEL,
  REPLENISHMENT_SUPPLIER_NOTE,
} from '../../src/lib/finance/chartsL1Presentation'
import {
  InventoryCapitalBlock, inventorySummaryText,
} from '../../src/components/finance/charts/InventoryCapitalBlock'
import type {
  InventoryCapital, InventoryFlows,
} from '../../src/services/financeChartsService'

// ═════════════════════════════════════════════════════════════════════════════
// P1-A — Finanzas → Caja en móvil
// ═════════════════════════════════════════════════════════════════════════════

const FUENTE = readFileSync('src/pages/FinanceDashboard.tsx', 'utf8')

/**
 * Quita comentarios de bloque (incluidos los JSX `{/* … *\/}`) y de línea.
 * Sin esto, el comentario que EXPLICA el defecto —y que cita `repeat(4, 1fr)`
 * textualmente— haría fallar al test que verifica que el defecto no volvió.
 */
const sinComentarios = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

/** Aísla el bloque JSX de una pestaña del dashboard, ya sin comentarios. */
function bloqueDePestana(tab: string): string {
  const inicio = FUENTE.indexOf(`activeTab === '${tab}'`)
  expect(inicio, `no se encontró la pestaña ${tab}`).toBeGreaterThan(-1)
  const resto = FUENTE.slice(inicio + 1)
  const siguiente = resto.search(/activeTab === '/)
  return sinComentarios(siguiente === -1 ? resto : resto.slice(0, siguiente))
}

describe('P1-A — Finanzas → Caja es alcanzable en 390px', () => {
  const caja = bloqueDePestana('caja')

  it('1. la pestaña Caja no declara ninguna grilla de columnas fijas', () => {
    // `repeat(N, 1fr)` no baja del min-content de sus tarjetas: en 390px el grid
    // supera el viewport y `body { overflow-x: hidden }` recorta importes sin
    // dejar barra de scroll. Ésta era la causa exacta de P1-A.
    const fijas = [...caja.matchAll(/repeat\(\s*(\d+)\s*,\s*1fr\s*\)/g)]
      .filter(m => Number(m[1]) >= 2)
    expect(fijas.map(m => m[0]), 'volvió una grilla de columnas fijas a Caja').toEqual([])
  })

  it('2. las dos filas monetarias usan auto-fit + minmax', () => {
    for (const testid of ['finance-caja-cash-methods', 'finance-caja-totals']) {
      const i = caja.indexOf(`data-testid="${testid}"`)
      expect(i, `falta ${testid}`).toBeGreaterThan(-1)
      const decl = caja.slice(i, i + 260)
      expect(decl, `${testid} no envuelve en móvil`)
        .toMatch(/repeat\(auto-fit,\s*minmax\(\d+px,\s*1fr\)\)/)
    }
  })

  it('3. NINGUNA tarjeta se oculta ni se recorta por CSS en móvil', () => {
    // Las salidas prohibidas: esconder la tarjeta, o tapar el desborde en vez
    // de resolverlo. La información financiera tiene que seguir estando.
    expect(caja).not.toMatch(/display:\s*['"]none['"]/)
    expect(caja).not.toMatch(/overflowX:\s*['"]hidden['"]/)
    expect(caja).not.toMatch(/visibility:\s*['"]hidden['"]/)
  })

  it('4. las 4 tarjetas de medios de pago se siguen renderizando todas', () => {
    // Nada de `.slice(0, 2)` ni filtros por ancho: se muestran todas.
    const i = caja.indexOf('data-testid="finance-caja-cash-methods"')
    const decl = caja.slice(i, i + 400)
    expect(decl).toContain('cashMethods.map')
    expect(decl).not.toMatch(/cashMethods\s*\.\s*slice/)
  })

  it('5. la tarjeta puede encoger: minWidth 0 y el importe envuelve', () => {
    // Sin esto el min-content de la tarjeta ES el ancho del importe completo, y
    // la pista del grid se ensancha por encima de su parte.
    const card = FUENTE.slice(FUENTE.indexOf('function CashCard'), FUENTE.indexOf('function MovRow'))
    expect(card).toMatch(/minWidth:\s*0/)
    expect(card).toMatch(/overflowWrap:\s*['"]anywhere['"]/)
    // El importe se muestra COMPLETO: nada de ellipsis ni de recorte destructivo
    // sobre el número.
    const importe = card.slice(card.indexOf('fontFamily: \'monospace\''))
    expect(importe).not.toContain('textOverflow')
  })

  it('6. la tabla de movimientos es alcanzable por scroll propio, no recortada', () => {
    // Seis columnas tabulares no entran en 390px y no pueden colapsarse sin
    // esconder datos: el scroll horizontal PROPIO las mantiene alcanzables sin
    // generar scroll en el body.
    const tabla = FUENTE.slice(FUENTE.indexOf('function MovimientosTable'))
    expect(tabla).toMatch(/overflowX:\s*['"]auto['"]/)
    expect(tabla).toContain('data-testid="finance-movements-scroller"')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// P1-D — Reposición registrada
// ═════════════════════════════════════════════════════════════════════════════

const CAPITAL: InventoryCapital = {
  inventory_at_cost: 100000, inventory_at_cost_valued: 100000,
  products_total: 4, products_valued: 4, products_missing_cost: 0,
  units_missing_cost: 0, products_negative_stock: 0, coverage_pct: 100,
  usd_based_products: 0, usd_rate_min_applied: null, usd_rate_max_applied: null,
  history_available: false, history_blocked_reason: 'no_historical_cost_basis',
}

const FLOWS = (over: Partial<InventoryFlows> = {}): InventoryFlows => ({
  purchases_cost: 10000, purchases_units: 10, purchases_movements: 2,
  purchases_movements_costed: 2, consumption_cost: 20000, consumption_units: 5,
  consumption_movements_uncosted: 0, returns_units: 0, returns_cost: 0,
  adjustments_units: 0, adjustments_net_units: 0, adjustments_cost: 0,
  cancellations_units: 0, replenishment_pct: 50,
  replenishment_basis: 'comparable',
  consumption_source: 'accrued_cogs',
  purchases_source: 'inventory_movements_snapshot_cost',
  bridge_available: false, bridge_blocked_reason: 'heterogeneous_cost_basis',
  ...over,
})

/** B) sin entradas, con consumo, sin evidencia de proveedor. */
const SIN_ENTRADAS = FLOWS({
  purchases_cost: 0, purchases_units: 0, purchases_movements: 0,
  purchases_movements_costed: 0, replenishment_pct: 0,
  supplier_purchases_count: 0, supplier_purchases_amount: 0,
})

/** C) sin entradas, con consumo, CON compras a proveedor. */
const SIN_ENTRADAS_CON_PROVEEDOR = FLOWS({
  purchases_cost: 0, purchases_units: 0, purchases_movements: 0,
  purchases_movements_costed: 0, replenishment_pct: 0,
  supplier_purchases_count: 2, supplier_purchases_amount: 75000,
})

const PROHIBIDO = [
  /descapitaliz/i,
  /no repusiste/i,
  /no compraste/i,
  /ten[eé]s un error/i,
  /faltan compras/i,
]

describe('P1-D — semántica de la reposición registrada', () => {
  it('A. compras>0 y consumo>0 → porcentaje normal, sin aviso de proveedor', () => {
    const c = replenishmentCopy(FLOWS())
    expect(c.text).toBe('En este período las compras repusieron menos inventario del que salió por operación.')
    expect(c.supplierNote).toBeNull()
    expect(replenishmentCopy(FLOWS({ replenishment_pct: 100 })).text)
      .toContain('acompañó aproximadamente el consumo')
    expect(replenishmentCopy(FLOWS({ replenishment_pct: 150 })).text)
      .toContain('superaron el consumo')
  })

  it('B. sin entradas + consumo + SIN compras → nombra el hecho, no acusa', () => {
    const c = replenishmentCopy(SIN_ENTRADAS)
    expect(c.text).toBe('No se registraron entradas de mercadería en inventario durante este período.')
    expect(c.supplierNote).toBeNull()
    for (const p of PROHIBIDO) expect(c.text).not.toMatch(p)
  })

  it('C. sin entradas + consumo + CON compras → agrega el contexto condicional', () => {
    const c = replenishmentCopy(SIN_ENTRADAS_CON_PROVEEDOR)
    expect(c.text).toBe('No se registraron entradas de mercadería en inventario durante este período.')
    expect(c.supplierNote).toBe(REPLENISHMENT_SUPPLIER_NOTE)
    // Condicional, nunca afirmación: el sistema no sabe si esa compra era stock.
    expect(c.supplierNote).toContain('Si corresponden a mercadería recibida')
    expect(c.supplierNote).not.toMatch(/se recibió mercadería/i)
    for (const p of PROHIBIDO) expect(c.supplierNote).not.toMatch(p)
  })

  it('D. sin consumo comparable → sin base, sin Infinity, sin porcentaje', () => {
    const c = replenishmentCopy(FLOWS({
      replenishment_pct: null, replenishment_basis: 'no_comparable_consumption',
      consumption_cost: 0, purchases_cost: 0, purchases_movements: 0,
    }))
    expect(c.text).toBe('Sin consumo comparable en el período.')
    expect(c.supplierNote).toBeNull()
    expect(c.text).not.toContain('Infinity')
    expect(c.text).not.toContain('NaN')
  })

  it('E. deuda de proveedor que NO era mercadería: nunca se afirma que lo fue', () => {
    // El mismo payload de C) cubre el caso: el aviso es condicional a propósito,
    // así que sirve igual si la compra era un servicio o un gasto.
    const c = replenishmentCopy(SIN_ENTRADAS_CON_PROVEEDOR)
    const todo = `${c.text} ${c.supplierNote ?? ''}`
    expect(todo).not.toMatch(/hubo mercadería/i)
    expect(todo).not.toMatch(/compraste mercadería/i)
    expect(todo).not.toMatch(/recibiste mercadería/i)
    expect(todo).toMatch(/\bSi\s+corresponden\b/)
  })

  it('F. sin datos → texto ausente, ningún diagnóstico falso', () => {
    const c = replenishmentCopy(null)
    expect(c.supplierNote).toBeNull()
    expect(c.text).not.toContain('entradas de mercadería')
    for (const p of PROHIBIDO) expect(c.text).not.toMatch(p)
    expect(replenishmentCopy(undefined).supplierNote).toBeNull()
  })

  it('G. el contexto NUNCA entra al cálculo: 0 % con $75.000 de compras', () => {
    // Si supplier_purchases_amount se hubiera sumado al numerador, esto daría
    // 375 %. La función de presentación no recalcula nada.
    expect(SIN_ENTRADAS_CON_PROVEEDOR.replenishment_pct).toBe(0)
    const conMas = replenishmentCopy({
      ...SIN_ENTRADAS_CON_PROVEEDOR, supplier_purchases_amount: 999_999_999,
    })
    expect(conMas.text).toBe(replenishmentCopy(SIN_ENTRADAS_CON_PROVEEDOR).text)
  })

  it('H. una entrada SIN costo cargado no se confunde con "no hubo entradas"', () => {
    // purchases_movements > 0 y purchases_cost = 0: hubo entradas, lo que falta
    // es el costo. Decir que no hubo ninguna sería falso.
    const c = replenishmentCopy(FLOWS({
      purchases_cost: 0, purchases_movements: 3, purchases_movements_costed: 0,
      replenishment_pct: 0,
    }))
    expect(c.text).not.toContain('No se registraron entradas')
    expect(c.supplierNote).toBeNull()
  })

  it('I. replenishmentText conserva su firma previa a P1-D', () => {
    expect(replenishmentText(FLOWS())).toBe(replenishmentCopy(FLOWS()).text)
    expect(replenishmentText(null)).toBe(replenishmentCopy(null).text)
  })
})

describe('P1-D — la tarjeta muestra la etiqueta y el contexto correctos', () => {
  it('la etiqueta canónica es "Reposición registrada"', () => {
    expect(REPLENISHMENT_LABEL).toBe('Reposición registrada')
    cleanup()
    render(<InventoryCapitalBlock capital={CAPITAL} flows={FLOWS()} />)
    expect(screen.getByTestId('replenishment-label').textContent).toBe('Reposición registrada')
    // Y ya no promete ser "del período" — lo que mide son entradas registradas.
    expect(screen.queryByText('Reposición del período')).toBeNull()
  })

  it('0 % con compras a proveedor: muestra el porcentaje Y el aviso', () => {
    cleanup()
    render(<InventoryCapitalBlock capital={CAPITAL} flows={SIN_ENTRADAS_CON_PROVEEDOR} />)
    expect(screen.getByTestId('replenishment-value').textContent).toContain('0')
    expect(screen.getByTestId('replenishment-text').textContent)
      .toBe('No se registraron entradas de mercadería en inventario durante este período.')
    const nota = screen.getByTestId('replenishment-supplier-note')
    expect(within(nota).getByText(/Si corresponden a mercadería recibida/)).toBeTruthy()
    // Es una nota, no una alerta crítica.
    expect(nota.getAttribute('role')).toBe('note')
  })

  it('0 % sin compras a proveedor: NO aparece el aviso', () => {
    cleanup()
    render(<InventoryCapitalBlock capital={CAPITAL} flows={SIN_ENTRADAS} />)
    expect(screen.getByTestId('replenishment-text').textContent)
      .toBe('No se registraron entradas de mercadería en inventario durante este período.')
    expect(screen.queryByTestId('replenishment-supplier-note')).toBeNull()
  })

  it('el resumen accesible tampoco dice "las compras fueron $0"', () => {
    const s = inventorySummaryText(CAPITAL, SIN_ENTRADAS_CON_PROVEEDOR)
    expect(s).toContain('No se registraron entradas de mercadería en inventario')
    expect(s).toContain('Si corresponden a mercadería recibida')
    expect(s).not.toMatch(/las compras fueron \$\s?0/)
    for (const p of PROHIBIDO) expect(s).not.toMatch(p)
  })

  it('el resumen normal nombra entradas de inventario, no "compras" a secas', () => {
    const s = inventorySummaryText(CAPITAL, FLOWS())
    expect(s).toContain('entradas de inventario registradas')
    expect(s).toContain('reposición registrada')
  })

  it('Capital en stock queda intacto: la denominación canónica no se movió', () => {
    cleanup()
    render(<InventoryCapitalBlock capital={CAPITAL} flows={SIN_ENTRADAS_CON_PROVEEDOR} />)
    const t = document.body.textContent ?? ''
    expect(t).toContain('Valor de la mercadería disponible según los costos registrados actualmente')
    expect(t.toLowerCase()).not.toContain('capital total')
    expect(t.toLowerCase()).not.toContain('patrimonio')
    expect(t).not.toContain('NaN')
    expect(t).not.toContain('undefined')
    expect(t).not.toContain('Infinity')
  })
})
