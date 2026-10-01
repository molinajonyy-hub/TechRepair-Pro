// FINANCE BUSINESS DATE 2C · Reportes sobre la fecha de negocio argentina.
//
// Bugs de main:
//   · Los períodos se armaban con getters locales del browser
//     (startOfDay/startOfMonth/... con getFullYear/getMonth/setDate): con el
//     browser fuera de Argentina, o en UTC, los cortes eran otros.
//   · order_payments.payment_date es un DATE, pero se filtraba con instantes
//     (`toISOString()`) y se agrupaba con `new Date('YYYY-MM-DD')`, que es la
//     medianoche UTC = 21:00 AR del dia ANTERIOR. Con el browser en Argentina,
//     todo cobro caia en el dia previo: «Ingresos hoy» quedaba en $0, el cobro
//     de hoy aparecia como «ayer» y el dia 1 del mes se contaba en el mes
//     anterior.
//
// Contrato nuevo: todo limite es una fecha de calendario y todo rango es
// [desde, hasta). DATE se filtra con 'YYYY-MM-DD'; timestamptz con las 00:00 AR
// explicitas ('YYYY-MM-DDT00:00:00-03:00'), nunca con fechas peladas ni con
// <= 23:59:59.
//
// Se monta la pantalla REAL, con el reloj fijado (solo se falsea Date), la zona
// del proceso en UTC y en Cordoba, y una cadena PostgREST que registra los
// filtros. La serie de ingresos se lee de las props reales del grafico.
import { readFileSync } from 'node:fs'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

type Op = [metodo: string, args: unknown[]]
interface Consulta { tabla: string; ops: Op[] }
interface Punto { label: string; value: number }

const db = vi.hoisted(() => ({
  consultas: [] as Array<{ tabla: string; ops: Array<[string, unknown[]]> }>,
  filas: {} as Record<string, unknown[]>,
  graficos: [] as Array<Array<{ label: string; value: number }>>,
}))

vi.mock('../../src/lib/supabase', () => {
  const cadena = (c: { tabla: string; ops: Array<[string, unknown[]]> }): unknown => new Proxy(() => {}, {
    get: (_t, prop) => {
      if (prop === 'then') {
        const data = db.filas[c.tabla] ?? []
        return (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
          Promise.resolve({ data, error: null, count: data.length }).then(ok, ko)
      }
      return (...args: unknown[]) => { c.ops.push([String(prop), args]); return cadena(c) }
    },
  })
  return {
    supabase: {
      from: (tabla: string) => { const c = { tabla, ops: [] }; db.consultas.push(c); return cadena(c) },
    },
  }
})
vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ businessId: 'biz-1', isAuthenticated: true, hasBusinessAccess: true, loading: false, profileLoading: false }),
}))
const STATS = { ordersByStatus: {}, popularDeviceTypes: [] }
vi.mock('../../src/hooks/useDashboardStats', () => ({
  useDashboardStats: () => ({ stats: STATS, loading: false, error: null }),
}))
vi.mock('../../src/services/inventoryService', () => ({
  inventoryService: { getLowStockItems: async () => [], getOutOfStockItems: async () => [] },
}))
vi.mock('../../src/services/inventoryReportsService', () => ({
  inventoryReportsService: { calculateTotalValue: async () => 0 },
}))
vi.mock('../../src/components/charts/SimpleBarChart', () => ({
  SimpleBarChart: ({ data }: { data: Array<{ label: string; value: number }> }) => {
    db.graficos.push(data.map(({ label, value }) => ({ label, value })))
    return null
  },
}))
vi.mock('../../src/components/charts/SimplePieChart', () => ({ SimplePieChart: () => null }))

import { Reports } from '../../src/pages/Reports'

const inicio = (fecha: string) => `${fecha}T00:00:00-03:00`

function filtros(tabla: string, columna: string): Array<{ gte: unknown; lt: unknown }> {
  return (db.consultas as Consulta[])
    .filter(c => c.tabla === tabla)
    .map(c => ({
      gte: c.ops.find(([m, a]) => m === 'gte' && a[0] === columna)?.[1][1],
      lt: c.ops.find(([m, a]) => m === 'lt' && a[0] === columna)?.[1][1],
    }))
    .filter(f => f.gte !== undefined || f.lt !== undefined)
}

/** Ultima serie de ingresos que recibio el grafico (la de técnicos se distingue por su label). */
function serieIngresos(): Punto[] {
  const series = (db.graficos as Punto[][]).filter(s => !(s.length === 1 && s[0].label === 'Sin asignar'))
  return series[series.length - 1] ?? []
}

function kpi(label: string): string {
  const card = screen.getByText(label).closest('.stat-card')
  return (card?.querySelector('.stat-card-value')?.textContent ?? '').replace(/\s/g, '')
}

async function elegir(preset: string): Promise<void> {
  db.consultas.length = 0
  db.graficos.length = 0
  fireEvent.change(screen.getByRole('combobox'), { target: { value: preset } })
  await waitFor(() => expect(filtros('order_payments', 'payment_date').length).toBeGreaterThan(0))
}

// Valores esperados calculados a mano, no con el helper bajo prueba.
interface Caso {
  label: string; instant: string
  hoy: string; ayer: string; manana: string; hace6: string
  mes: { desde: string; hasta: string; anterior: string; semanas: number; actual: number; previo: number }
  anio: { desde: string; hasta: string; anterior: string }
}
const CASOS: Caso[] = [
  {
    label: '30/09/2026 22:30 AR', instant: '2026-09-30T22:30:00-03:00',
    hoy: '2026-09-30', ayer: '2026-09-29', manana: '2026-10-01', hace6: '2026-09-24',
    mes: { desde: '2026-09-01', hasta: '2026-10-01', anterior: '2026-08-01', semanas: 5, actual: 145, previo: 0 },
    anio: { desde: '2026-01-01', hasta: '2027-01-01', anterior: '2025-01-01' },
  },
  {
    label: '01/10/2026 00:00 AR', instant: '2026-10-01T00:00:00-03:00',
    hoy: '2026-10-01', ayer: '2026-09-30', manana: '2026-10-02', hace6: '2026-09-25',
    mes: { desde: '2026-10-01', hasta: '2026-11-01', anterior: '2026-09-01', semanas: 5, actual: 105, previo: 40 },
    anio: { desde: '2026-01-01', hasta: '2027-01-01', anterior: '2025-01-01' },
  },
  {
    label: '31/12/2026 23:30 AR', instant: '2026-12-31T23:30:00-03:00',
    hoy: '2026-12-31', ayer: '2026-12-30', manana: '2027-01-01', hace6: '2026-12-25',
    mes: { desde: '2026-12-01', hasta: '2027-01-01', anterior: '2026-11-01', semanas: 5, actual: 145, previo: 0 },
    anio: { desde: '2026-01-01', hasta: '2027-01-01', anterior: '2025-01-01' },
  },
  {
    label: '01/01/2027 00:00 AR', instant: '2027-01-01T00:00:00-03:00',
    hoy: '2027-01-01', ayer: '2026-12-31', manana: '2027-01-02', hace6: '2026-12-26',
    mes: { desde: '2027-01-01', hasta: '2027-02-01', anterior: '2026-12-01', semanas: 5, actual: 105, previo: 40 },
    anio: { desde: '2027-01-01', hasta: '2028-01-01', anterior: '2026-01-01' },
  },
  {
    label: '29/02/2028 22:30 AR (bisiesto)', instant: '2028-02-29T22:30:00-03:00',
    hoy: '2028-02-29', ayer: '2028-02-28', manana: '2028-03-01', hace6: '2028-02-23',
    mes: { desde: '2028-02-01', hasta: '2028-03-01', anterior: '2028-01-01', semanas: 5, actual: 145, previo: 0 },
    anio: { desde: '2028-01-01', hasta: '2029-01-01', anterior: '2027-01-01' },
  },
  {
    label: '28/02/2027 23:30 AR (no bisiesto)', instant: '2027-02-28T23:30:00-03:00',
    hoy: '2027-02-28', ayer: '2027-02-27', manana: '2027-03-01', hace6: '2027-02-22',
    mes: { desde: '2027-02-01', hasta: '2027-03-01', anterior: '2027-01-01', semanas: 4, actual: 145, previo: 0 },
    anio: { desde: '2027-01-01', hasta: '2028-01-01', anterior: '2026-01-01' },
  },
]

describe.each(['UTC', 'America/Argentina/Cordoba'])('Reportes con TZ del proceso = %s', (tz) => {
  let previo: string | undefined
  beforeAll(() => { previo = process.env.TZ; process.env.TZ = tz })
  afterAll(() => { if (previo === undefined) delete process.env.TZ; else process.env.TZ = previo })
  afterEach(() => { vi.useRealTimers() })

  describe.each(CASOS)('$label', (c) => {
    beforeEach(() => {
      db.consultas.length = 0
      db.graficos.length = 0
      for (const k of Object.keys(db.filas)) delete db.filas[k]
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(c.instant))
      db.filas.order_payments = [
        { amount: 100, payment_date: c.hoy },
        { amount: 40, payment_date: c.ayer },
        { amount: 5, payment_date: c.mes.desde },
      ]
      db.filas.orders = [
        { updated_at: `${c.hoy}T00:30:00-03:00` },
        // 23:30 AR de ayer: en UTC ya es hoy. Tiene que contar como ayer.
        { updated_at: `${c.ayer}T23:30:00-03:00` },
      ]
    })

    test('Este mes (default): DATE por fecha, timestamptz desde las 00:00 AR, sin saltar de mes', async () => {
      render(<Reports />)
      await waitFor(() => expect(filtros('order_payments', 'payment_date').length).toBeGreaterThan(0))
      expect(filtros('order_payments', 'payment_date')).toEqual([{ gte: c.mes.anterior, lt: c.mes.hasta }])
      expect(filtros('orders', 'updated_at')).toEqual([{ gte: inicio(c.mes.anterior), lt: inicio(c.mes.hasta) }])
      expect(filtros('devices', 'created_at')).toEqual([{ gte: inicio(c.mes.desde), lt: inicio(c.mes.hasta) }])
      expect(filtros('customers', 'created_at')).toEqual(expect.arrayContaining([
        { gte: inicio(c.mes.desde), lt: inicio(c.mes.hasta) },
        { gte: inicio(c.mes.anterior), lt: inicio(c.mes.desde) },
      ]))
      await waitFor(() => expect(kpi('Ingresos este mes')).toBe(`$${c.mes.actual}`))
      const serie = serieIngresos()
      expect(serie.map(p => p.label)).toEqual(Array.from({ length: c.mes.semanas }, (_, i) => `Sem ${i + 1}`))
      expect(serie.reduce((s, p) => s + p.value, 0)).toBe(c.mes.actual)
      // El cobro de hoy cae en la semana del mes que contiene el dia de hoy.
      expect(serie[Math.floor((Number(c.hoy.slice(8)) - 1) / 7)].value).toBeGreaterThanOrEqual(100)
    })

    test('Hoy: hoy sigue siendo el dia argentino, con limite timestamptz [00:00 AR, 00:00 AR del dia siguiente)', async () => {
      render(<Reports />)
      await waitFor(() => expect(filtros('order_payments', 'payment_date').length).toBeGreaterThan(0))
      await elegir('today')
      expect(filtros('order_payments', 'payment_date')).toEqual([{ gte: c.hace6, lt: c.manana }])
      expect(filtros('orders', 'updated_at')).toEqual([{ gte: inicio(c.ayer), lt: inicio(c.manana) }])
      expect(filtros('devices', 'created_at')).toEqual([{ gte: inicio(c.hoy), lt: inicio(c.manana) }])
      expect(filtros('customers', 'created_at')).toEqual(expect.arrayContaining([
        { gte: inicio(c.hoy), lt: inicio(c.manana) },
        { gte: inicio(c.ayer), lt: inicio(c.hoy) },
      ]))
      // Si hoy es dia 1, el cobro del dia 1 del mes tambien es de hoy.
      const ingresosHoy = 100 + (c.mes.desde === c.hoy ? 5 : 0)
      await waitFor(() => expect(kpi('Ingresos hoy')).toBe(`$${ingresosHoy}`))
      expect(kpi('Ordenes completadas')).toBe('1')
      const serie = serieIngresos()
      expect(serie).toHaveLength(7)
      expect(serie[6].value).toBe(ingresosHoy)
      expect(serie[5].value).toBe(40)
    })

    test('Este año: el año del dia de negocio y el anterior', async () => {
      render(<Reports />)
      await waitFor(() => expect(filtros('order_payments', 'payment_date').length).toBeGreaterThan(0))
      await elegir('year')
      expect(filtros('order_payments', 'payment_date')).toEqual([{ gte: c.anio.anterior, lt: c.anio.hasta }])
      expect(filtros('devices', 'created_at')).toEqual([{ gte: inicio(c.anio.desde), lt: inicio(c.anio.hasta) }])
      await waitFor(() => expect(serieIngresos()).toHaveLength(12))
    })
  })

  describe('semana de lunes a domingo y trimestre', () => {
    beforeEach(() => {
      db.consultas.length = 0
      db.graficos.length = 0
      for (const k of Object.keys(db.filas)) delete db.filas[k]
      vi.useFakeTimers({ toFake: ['Date'] })
    })

    test('Esta semana (mié 30/09/2026 22:30 AR): lunes 28/09 .. lunes 05/10, semana anterior desde el 21/09', async () => {
      vi.setSystemTime(new Date('2026-09-30T22:30:00-03:00'))
      db.filas.order_payments = [{ amount: 100, payment_date: '2026-09-30' }]
      render(<Reports />)
      await waitFor(() => expect(filtros('order_payments', 'payment_date').length).toBeGreaterThan(0))
      await elegir('week')
      expect(filtros('order_payments', 'payment_date')).toEqual([{ gte: '2026-09-21', lt: '2026-10-05' }])
      expect(filtros('devices', 'created_at')).toEqual([{ gte: inicio('2026-09-28'), lt: inicio('2026-10-05') }])
      await waitFor(() => expect(serieIngresos()).toHaveLength(7))
      const serie = serieIngresos()
      expect(serie[0].label).toMatch(/^lun/)
      expect(serie[2].value).toBe(100) // miércoles
    })

    test('Esta semana en domingo 28/02/2027 23:30 AR: arranca el lunes 22/02', async () => {
      vi.setSystemTime(new Date('2027-02-28T23:30:00-03:00'))
      render(<Reports />)
      await waitFor(() => expect(filtros('order_payments', 'payment_date').length).toBeGreaterThan(0))
      await elegir('week')
      expect(filtros('order_payments', 'payment_date')).toEqual([{ gte: '2027-02-15', lt: '2027-03-01' }])
    })

    test('Este trimestre (29/02/2028 22:30 AR): Q1 2028, trimestre anterior desde 01/10/2027', async () => {
      vi.setSystemTime(new Date('2028-02-29T22:30:00-03:00'))
      db.filas.order_payments = [{ amount: 10, payment_date: '2028-02-29' }]
      render(<Reports />)
      await waitFor(() => expect(filtros('order_payments', 'payment_date').length).toBeGreaterThan(0))
      await elegir('quarter')
      expect(filtros('order_payments', 'payment_date')).toEqual([{ gte: '2027-10-01', lt: '2028-04-01' }])
      await waitFor(() => expect(serieIngresos()).toHaveLength(3))
      expect(serieIngresos().map(p => p.value)).toEqual([0, 10, 0])
    })
  })
})

describe('control de fuente: Reportes no arma períodos con la zona del browser', () => {
  const fuente = readFileSync('src/pages/Reports.tsx', 'utf8')

  test('sin getters/setters locales ni Date() para los períodos', () => {
    expect(fuente).not.toMatch(/\.(get|set)(FullYear|Month|Date|Day)\(/)
    expect(fuente).not.toMatch(/new Date\(payment\.payment_date\)/)
  })

  test('los filtros no mandan toISOString() (solo queda el nombre del PDF)', () => {
    const usos = fuente.match(/toISOString\(\)/g) ?? []
    expect(usos).toHaveLength(1)
    expect(fuente).toMatch(/doc\.save\(`reporte-\$\{selectedPeriod\}-\$\{generatedAt\.toISOString\(\)\.slice\(0, 10\)\}\.pdf`\)/)
  })
})
