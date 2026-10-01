// FINANCE BUSINESS DATE 2B · filtros, lecturas y KPIs de finanzas del negocio
// sobre la fecha de negocio argentina.
//
// Bug: las lecturas armaban "hoy", "hace 7/30/90 dias" y "este mes" con
// `toISOString()` (UTC) o con getters locales del browser. Entre las 21:00 y las
// 24:00 AR eso ya es el dia (o el mes, o el año) siguiente: «Gastado hoy» daba
// $0, el filtro del mes salia del 02 o saltaba a octubre, «pagado este mes»
// miraba el mes que viene, el snapshot de valuacion se fechaba mañana y el
// historial de cajas «Hoy» arrancaba a las 21:00 del dia anterior.
//
// Se montan las superficies y hooks REALES con el reloj fijado (solo se falsea
// Date), la zona del proceso en UTC (runner de CI) y en Cordoba (usuario real),
// y una cadena de PostgREST que REGISTRA los filtros que se envian.
import { readFileSync } from 'node:fs'
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

type Op = [metodo: string, args: unknown[]]
interface Consulta { tabla: string; ops: Op[] }

const db = vi.hoisted(() => ({
  consultas: [] as Array<{ tabla: string; ops: Array<[string, unknown[]]> }>,
  filas: {} as Record<string, unknown[]>,
}))

vi.mock('../../src/lib/supabase', () => {
  const cadena = (c: { tabla: string; ops: Array<[string, unknown[]]> }): unknown => new Proxy(() => {}, {
    get: (_t, prop) => {
      if (prop === 'then') {
        const data = db.filas[c.tabla] ?? []
        return (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
          Promise.resolve({ data, error: null, count: data.length }).then(ok, ko)
      }
      if (prop === 'maybeSingle' || prop === 'single') {
        return () => { c.ops.push([String(prop), []]); return Promise.resolve({ data: null, error: null }) }
      }
      return (...args: unknown[]) => { c.ops.push([String(prop), args]); return cadena(c) }
    },
  })
  const nueva = (tabla: string, ops: Array<[string, unknown[]]> = []) => {
    const c = { tabla, ops }
    db.consultas.push(c)
    return cadena(c)
  }
  return {
    supabase: {
      from: (tabla: string) => nueva(tabla),
      rpc: (fn: string, args: unknown) => nueva(`rpc:${fn}`, [['rpc', [args]]]),
    },
  }
})
vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({
    businessId: 'biz-1', user: { id: 'u1' }, role: 'owner', isOwner: true, profile: {},
    isAuthenticated: true, hasBusinessAccess: true, loading: false, profileLoading: false,
  }),
}))
vi.mock('../../src/contexts/CajaContext', () => ({
  useCaja: () => ({ isOpen: false, cajaId: null, refresh: () => {} }),
}))
vi.mock('../../src/hooks/usePermissions', () => ({
  usePermissions: () => ({ can: () => true, permissions: {} }),
  effectivePermissions: () => ({}),
}))
vi.mock('../../src/hooks/useAppWakeUp', () => ({ useRefreshOnWakeUp: () => {} }))
vi.mock('../../src/services/currencyService', () => ({
  currencyService: { getCurrentExchangeRate: async () => 1 },
}))
vi.mock('../../src/services/inventoryCostAccess', async (original) => ({
  ...(await original<typeof import('../../src/services/inventoryCostAccess')>()),
  attachInventoryCosts: async (rows: Array<Record<string, unknown>>) =>
    rows.map(r => ({ ...r, cost_price: 100, cost_price_usd: null })),
  hasCogsAuthority: async () => true,
}))

import { Expenses } from '../../src/pages/Expenses'
import { CajaPage } from '../../src/pages/CajaPage'
import { useFinancialDashboard } from '../../src/hooks/useFinancialDashboard'
import { invalidateStatsCache, useDashboardStats } from '../../src/hooks/useDashboardStats'
import { useInventoryFinance } from '../../src/hooks/useInventoryFinance'
import { useRecurringExpenses } from '../../src/hooks/useRecurringExpenses'
import { financeService, getPeriodDates } from '../../src/services/financeService'

/** Ultimo valor enviado en `.metodo(columna, valor)` a `tabla`. */
function filtro(tabla: string, metodo: string, columna: string): unknown {
  for (const c of [...db.consultas].reverse() as Consulta[]) {
    if (c.tabla !== tabla) continue
    const op = [...c.ops].reverse().find(([m, a]) => m === metodo && a[0] === columna)
    if (op) return op[1][1]
  }
  return undefined
}
/** Todos los valores enviados en `.metodo(columna, valor)` a `tabla`. */
function filtros(tabla: string, metodo: string, columna: string): unknown[] {
  return (db.consultas as Consulta[])
    .filter(c => c.tabla === tabla)
    .flatMap(c => c.ops.filter(([m, a]) => m === metodo && a[0] === columna).map(([, a]) => a[1]))
}
function upserts(tabla: string): unknown[] {
  return (db.consultas as Consulta[])
    .filter(c => c.tabla === tabla)
    .flatMap(c => c.ops.filter(([m]) => m === 'upsert').map(([, a]) => a[0]))
}

// Valores esperados calculados a mano (no con el helper bajo prueba).
interface Caso {
  label: string; instant: string
  hoy: string; mes: string; mesSiguiente: string
  hace7: string; hace30: string; hace90: string; unMesAtras: string
  lunes: string; anio: string
}
const CASOS: Caso[] = [
  {
    label: '30/09 22:30 AR (UTC ya es 01/10)', instant: '2026-09-30T22:30:00-03:00',
    hoy: '2026-09-30', mes: '2026-09-01', mesSiguiente: '2026-10-01',
    hace7: '2026-09-23', hace30: '2026-08-31', hace90: '2026-07-02', unMesAtras: '2026-08-30',
    lunes: '2026-09-28', anio: '2026-01-01',
  },
  {
    label: '01/10 00:00 AR (mes nuevo)', instant: '2026-10-01T00:00:00-03:00',
    hoy: '2026-10-01', mes: '2026-10-01', mesSiguiente: '2026-11-01',
    hace7: '2026-09-24', hace30: '2026-09-01', hace90: '2026-07-03', unMesAtras: '2026-09-01',
    lunes: '2026-09-28', anio: '2026-01-01',
  },
  {
    label: '31/12 23:30 AR (ultima noche del año)', instant: '2026-12-31T23:30:00-03:00',
    hoy: '2026-12-31', mes: '2026-12-01', mesSiguiente: '2027-01-01',
    hace7: '2026-12-24', hace30: '2026-12-01', hace90: '2026-10-02', unMesAtras: '2026-11-30',
    lunes: '2026-12-28', anio: '2026-01-01',
  },
  {
    label: '01/01/2027 00:00 AR (cambio de año)', instant: '2027-01-01T00:00:00-03:00',
    hoy: '2027-01-01', mes: '2027-01-01', mesSiguiente: '2027-02-01',
    hace7: '2026-12-25', hace30: '2026-12-02', hace90: '2026-10-03', unMesAtras: '2026-12-01',
    lunes: '2026-12-28', anio: '2027-01-01',
  },
]

let bizSeq = 0

describe.each(['UTC', 'America/Argentina/Cordoba'])('lecturas financieras con TZ del proceso = %s', (tz) => {
  let previo: string | undefined
  beforeAll(() => { previo = process.env.TZ; process.env.TZ = tz })
  afterAll(() => { if (previo === undefined) delete process.env.TZ; else process.env.TZ = previo })
  afterEach(() => { vi.useRealTimers() })

  describe.each(CASOS)('$label', (c) => {
    beforeEach(() => {
      db.consultas.length = 0
      for (const k of Object.keys(db.filas)) delete db.filas[k]
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(c.instant))
      invalidateStatsCache()
    })

    test('Gastos: el filtro de lista es el mes de negocio y «Gastado hoy» suma el dia argentino', async () => {
      db.filas.expenses = [
        { id: 'e1', description: 'Luz', category: 'Servicios', amount: 100, amount_ars: 100, currency: 'ARS', date: c.hoy, payment_method: 'efectivo', tipo: 'general' },
        { id: 'e2', description: 'Agua', category: 'Servicios', amount: 40, amount_ars: 40, currency: 'ARS', date: c.hace7, payment_method: 'efectivo', tipo: 'general' },
      ]
      render(<MemoryRouter><Expenses /></MemoryRouter>)
      await waitFor(() => expect(filtro('expenses', 'gte', 'date')).toBeDefined())
      expect(filtro('expenses', 'gte', 'date')).toBe(c.mes)
      expect(filtro('expenses', 'lte', 'date')).toBe(c.hoy)
      const valor = () => screen.getByText('Gastado hoy').closest('.stat-card')!.querySelector('.stat-card-value')!.textContent
      await waitFor(() => expect(valor()).toBe('$100'))
    })

    test('Caja: el historial «Hoy» arranca a las 00:00 del dia de negocio argentino', async () => {
      render(<MemoryRouter><CajaPage /></MemoryRouter>)
      fireEvent.click(await screen.findByRole('button', { name: 'Hoy' }))
      await waitFor(() => expect(filtros('cajas', 'gte', 'opened_at')).toContain(`${c.hoy}T00:00:00-03:00`))
      // Ese limite es exactamente la medianoche argentina.
      expect(new Date(`${c.hoy}T00:00:00-03:00`).getTime()).toBe(Date.parse(`${c.hoy}T03:00:00Z`))
    })

    test('Dashboard financiero: ventas semana/mes se piden desde hace 7/30 dias de negocio', async () => {
      const biz = `biz-fd-${++bizSeq}`
      renderHook(() => useFinancialDashboard(biz, null))
      await waitFor(() => expect(filtros('comprobante_payments', 'gte', 'date')).toHaveLength(2))
      expect(filtros('comprobante_payments', 'gte', 'date').sort()).toEqual([c.hace30, c.hace7].sort())
    })

    test('Stats del dashboard: BFE de 90 dias hasta hoy y revenue de hoy/semana/mes en dias de negocio', async () => {
      db.filas.business_finance_entries = [
        { type: 'income', amount_ars: 100, date: c.hoy },
        { type: 'income', amount_ars: 50, date: c.hace7 },
        { type: 'income', amount_ars: 7, date: c.hace30 },
        { type: 'income', amount_ars: 3, date: c.hace90 },
      ]
      const { result } = renderHook(() => useDashboardStats())
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(filtro('business_finance_entries', 'gte', 'date')).toBe(c.hace90)
      expect(filtro('business_finance_entries', 'lte', 'date')).toBe(c.hoy)
      expect(result.current.stats).toMatchObject({
        revenueToday: 100,
        revenueThisWeek: 150,
        revenueThisMonth: 157,
      })
    })

    test('Inventario: el snapshot de valuacion se fecha con el dia de negocio', async () => {
      db.filas.inventory = [{ id: 'i1', code: 'P1', name: 'Pantalla', category: 'Repuestos', stock_quantity: 2, sale_price: 300, supplier_code: null }]
      const { result } = renderHook(() => useInventoryFinance('biz-1'))
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(upserts('inventory_valuation_history')).toEqual([
        expect.objectContaining({ business_id: 'biz-1', fecha: c.hoy, capital_invertido: 200 }),
      ])
    })

    test('Inventario: si ya hay snapshot del dia de negocio, no se escribe otro', async () => {
      db.filas.inventory = [{ id: 'i1', code: 'P1', name: 'Pantalla', category: 'Repuestos', stock_quantity: 2, sale_price: 300, supplier_code: null }]
      db.filas.inventory_valuation_history = [{ fecha: c.hoy, capital_invertido: 200, valor_venta: 600, ganancia_potencial: 400, cantidad_total_items: 1 }]
      const { result } = renderHook(() => useInventoryFinance('biz-1'))
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(upserts('inventory_valuation_history')).toEqual([])
    })

    test('Gastos recurrentes: «pagado este mes» mira el mes de negocio', async () => {
      db.filas.recurring_expenses = [{ id: 'r1', name: 'Alquiler', amount: 1000, currency: 'ARS', day_of_month: 1, is_active: true }]
      db.filas.business_finance_entries = [{ id: 'b1', recurring_expense_id: 'r1', date: c.hoy, amount: 1000, amount_ars: 1000, currency: 'ARS' }]
      const { result } = renderHook(() => useRecurringExpenses())
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(filtro('business_finance_entries', 'gte', 'date')).toBe(c.mes)
      expect(filtro('business_finance_entries', 'lt', 'date')).toBe(c.mesSiguiente)
      expect(result.current.expenses[0]).toMatchObject({ paid_this_month: true, paid_date: c.hoy })
    })

    test('financeService: getLastMonths y getPeriodDates en fecha de negocio', async () => {
      await financeService.getLastMonths('biz-1', 1)
      expect(filtro('business_finance_entries', 'gte', 'date')).toBe(c.unMesAtras)
      expect(filtro('business_finance_entries', 'lte', 'date')).toBe(c.hoy)
      expect(getPeriodDates('today')).toEqual({ from: c.hoy, to: c.hoy })
      expect(getPeriodDates('month')).toEqual({ from: c.mes, to: c.hoy })
      expect(getPeriodDates('week')).toEqual({ from: c.lunes, to: c.hoy })
      expect(getPeriodDates('year')).toEqual({ from: c.anio, to: c.hoy })
    })
  })
})

describe('control de fuente: las lecturas financieras no vuelven a cortar fechas en UTC ni con la zona del browser', () => {
  const CORTE_UTC = /toISOString\(\)\.(split\(['"]T['"]\)|slice\(0, ?10\)|substring\(0, ?10\))|\.split\(['"]T['"]\)\[0\]/

  test.each([
    'src/pages/Expenses.tsx',
    'src/hooks/useFinancialDashboard.ts',
    'src/hooks/useInventoryFinance.ts',
    'src/hooks/useRecurringExpenses.ts',
    'src/services/financeService.ts',
  ])('%s no corta fechas con toISOString()', (archivo) => {
    expect(readFileSync(archivo, 'utf8')).not.toMatch(CORTE_UTC)
  })

  test('useRecurringExpenses no arma el mes con getters locales', () => {
    expect(readFileSync('src/hooks/useRecurringExpenses.ts', 'utf8')).not.toMatch(/\.get(FullYear|Month|Date|Day)\(\)/)
  })

  test('CajaPage: el filtro «hoy» usa el inicio del dia de negocio', () => {
    const fuente = readFileSync('src/pages/CajaPage.tsx', 'utf8')
    expect(fuente).toContain("q.gte('opened_at', desdeHoy)")
    expect(fuente).toMatch(/const desdeHoy = businessDayStartInstant\(businessToday\(/)
    expect(fuente).not.toMatch(CORTE_UTC)
  })

  test('useDashboardStats: lo financiero (BFE y revenue) va por fecha de negocio', () => {
    const fuente = readFileSync('src/hooks/useDashboardStats.ts', 'utf8')
    expect(fuente).toMatch(/const hoy\s*= businessToday\(\)/)
    expect(fuente).toMatch(/\.gte\('date', addCalendarDays\(hoy, -90\)\)\s*\n\s*\.lte\('date', hoy\)/)
    expect(fuente).toMatch(/const todayDate\s*= hoy\b/)
  })
})
