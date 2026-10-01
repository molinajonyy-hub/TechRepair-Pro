// FINANZAS · FECHA DE NEGOCIO AR: los presets del dashboard (Hoy, Ayer, Semana,
// Este mes, Mes ant.) se calculan sobre el calendario civil argentino.
//
// Bug original (FinanceDashboard.getDateRange): fechas locales cortadas con
// `toISOString().split('T')[0]`, que pasa a UTC. Entre las 21:00 y las 24:00 AR
// "Hoy" pedia el dia siguiente, "Semana" se corria y el fin de "Este mes" caia
// en el mes que viene.
//
// Los instantes llevan offset explicito (-03:00) y cada vector se corre ademas
// con varias zonas del proceso (TZ), incluida UTC, que es la del runner de CI:
// el resultado no puede depender de la zona del browser ni de la del runner.
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import {
  addCalendarDays,
  businessToday,
  calendarWeekday,
  firstDayOfMonth,
  getBusinessDateRange,
  type BusinessPeriodPreset,
} from '../../src/lib/businessDate'

type Vector = [label: string, instant: string, preset: BusinessPeriodPreset, from: string, to: string]

const VECTORS: Vector[] = [
  // ── antes de medianoche AR (UTC ya es el dia siguiente)
  ['30/09 22:30 · Hoy', '2026-09-30T22:30:00-03:00', 'today', '2026-09-30', '2026-09-30'],
  ['30/09 22:30 · Ayer', '2026-09-30T22:30:00-03:00', 'yesterday', '2026-09-29', '2026-09-29'],
  ['30/09 22:30 · Este mes (ultimo dia del mes)', '2026-09-30T22:30:00-03:00', 'month', '2026-09-01', '2026-09-30'],
  ['30/09 22:30 · Mes anterior', '2026-09-30T22:30:00-03:00', 'last_month', '2026-08-01', '2026-08-31'],
  ['30/09 21:00:00 · Hoy (primer instante con UTC en otro dia)', '2026-09-30T21:00:00-03:00', 'today', '2026-09-30', '2026-09-30'],
  ['30/09 23:59:59 · Hoy', '2026-09-30T23:59:59-03:00', 'today', '2026-09-30', '2026-09-30'],

  // ── cambio de dia / primer dia del mes
  ['01/10 00:00 · Hoy', '2026-10-01T00:00:00-03:00', 'today', '2026-10-01', '2026-10-01'],
  ['01/10 00:00 · Ayer', '2026-10-01T00:00:00-03:00', 'yesterday', '2026-09-30', '2026-09-30'],
  ['01/10 00:30 · Este mes (primer dia del mes)', '2026-10-01T00:30:00-03:00', 'month', '2026-10-01', '2026-10-01'],
  ['01/10 00:30 · Mes anterior', '2026-10-01T00:30:00-03:00', 'last_month', '2026-09-01', '2026-09-30'],
  ['01/10 12:00 · Mes anterior', '2026-10-01T12:00:00-03:00', 'last_month', '2026-09-01', '2026-09-30'],

  // ── semana alrededor de la medianoche AR (la semana arranca el domingo)
  // sabado 03/10 23:30: la semana es dom 27/09 .. sab 03/10
  ['sab 03/10 23:30 · Semana', '2026-10-03T23:30:00-03:00', 'week', '2026-09-27', '2026-10-03'],
  // domingo 04/10 00:00: arranca una semana nueva
  ['dom 04/10 00:00 · Semana', '2026-10-04T00:00:00-03:00', 'week', '2026-10-04', '2026-10-04'],
  ['dom 04/10 22:00 · Semana', '2026-10-04T22:00:00-03:00', 'week', '2026-10-04', '2026-10-04'],
  // semana que cruza el cambio de mes: mie 30/09 22:30 -> dom 27/09
  ['mie 30/09 22:30 · Semana', '2026-09-30T22:30:00-03:00', 'week', '2026-09-27', '2026-09-30'],

  // ── cambio de año
  ['31/12 23:30 · Hoy', '2026-12-31T23:30:00-03:00', 'today', '2026-12-31', '2026-12-31'],
  ['31/12 23:30 · Este mes', '2026-12-31T23:30:00-03:00', 'month', '2026-12-01', '2026-12-31'],
  ['31/12 23:30 · Semana (dom 27/12)', '2026-12-31T23:30:00-03:00', 'week', '2026-12-27', '2026-12-31'],
  ['01/01 00:30 · Ayer', '2027-01-01T00:30:00-03:00', 'yesterday', '2026-12-31', '2026-12-31'],
  ['01/01 00:30 · Mes anterior', '2027-01-01T00:30:00-03:00', 'last_month', '2026-12-01', '2026-12-31'],
  ['01/01 00:30 · Semana (vie: dom 27/12 .. 01/01)', '2027-01-01T00:30:00-03:00', 'week', '2026-12-27', '2027-01-01'],

  // ── febrero / bisiestos
  ['01/03/2028 00:30 · Mes anterior (bisiesto)', '2028-03-01T00:30:00-03:00', 'last_month', '2028-02-01', '2028-02-29'],
  ['29/02/2028 23:30 · Este mes (bisiesto)', '2028-02-29T23:30:00-03:00', 'month', '2028-02-01', '2028-02-29'],
  ['01/03/2028 00:30 · Ayer (bisiesto)', '2028-03-01T00:30:00-03:00', 'yesterday', '2028-02-29', '2028-02-29'],
  ['01/03/2027 00:30 · Mes anterior (no bisiesto)', '2027-03-01T00:30:00-03:00', 'last_month', '2027-02-01', '2027-02-28'],
  ['28/02/2027 22:30 · Este mes (no bisiesto)', '2027-02-28T22:30:00-03:00', 'month', '2027-02-01', '2027-02-28'],
]

// UTC = runner de CI. Cordoba = el usuario real. Las otras, lo bastante lejos
// como para que cualquier getter local o conversion a UTC cambie el dia.
const PROCESS_TIME_ZONES = ['UTC', 'America/Argentina/Cordoba', 'Asia/Tokyo', 'Pacific/Kiritimati', 'America/Los_Angeles']

describe.each(PROCESS_TIME_ZONES)('rangos de Finanzas con TZ del proceso = %s', (tz) => {
  let previo: string | undefined
  beforeAll(() => { previo = process.env.TZ; process.env.TZ = tz })
  afterAll(() => { if (previo === undefined) delete process.env.TZ; else process.env.TZ = previo })

  test('la zona del proceso realmente cambio (el control no es vacio)', () => {
    const offsetEsperado: Record<string, number> = {
      UTC: 0, 'America/Argentina/Cordoba': 180, 'Asia/Tokyo': -540, 'Pacific/Kiritimati': -840,
    }
    if (tz in offsetEsperado) {
      expect(new Date('2026-09-30T12:00:00Z').getTimezoneOffset()).toBe(offsetEsperado[tz])
    }
  })

  test.each(VECTORS)('%s', (_label, instant, preset, from, to) => {
    expect(getBusinessDateRange(preset, new Date(instant))).toEqual({ from, to })
  })
})

describe('aritmetica de calendario (sin zona)', () => {
  test('businessToday usa el dia civil argentino', () => {
    expect(businessToday(new Date('2026-09-30T22:30:00-03:00'))).toBe('2026-09-30')
    expect(businessToday(new Date('2026-10-01T01:30:00Z'))).toBe('2026-09-30')
    expect(businessToday(new Date('2026-10-01T03:00:00Z'))).toBe('2026-10-01')
  })

  test('addCalendarDays cruza meses, años y febrero', () => {
    expect(addCalendarDays('2026-09-30', 1)).toBe('2026-10-01')
    expect(addCalendarDays('2026-10-01', -1)).toBe('2026-09-30')
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addCalendarDays('2027-01-01', -1)).toBe('2026-12-31')
    expect(addCalendarDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addCalendarDays('2027-02-28', 1)).toBe('2027-03-01')
    expect(addCalendarDays('2026-09-15', 0)).toBe('2026-09-15')
  })

  test('calendarWeekday: 0 = domingo', () => {
    expect(calendarWeekday('2026-10-04')).toBe(0)
    expect(calendarWeekday('2026-10-03')).toBe(6)
    expect(calendarWeekday('2026-09-30')).toBe(3)
  })

  test('firstDayOfMonth', () => {
    expect(firstDayOfMonth('2026-09-30')).toBe('2026-09-01')
    expect(firstDayOfMonth('2028-02-29')).toBe('2028-02-01')
  })

  test('rechaza lo que no es una fecha YYYY-MM-DD', () => {
    expect(() => addCalendarDays('30/09/2026', 1)).toThrow(RangeError)
    expect(() => calendarWeekday('2026-9-30')).toThrow(RangeError)
  })
})

describe('FinanceDashboard usa la fecha de negocio canonica', () => {
  const FUENTE = readFileSync('src/pages/FinanceDashboard.tsx', 'utf8')

  test('los presets salen de getBusinessDateRange', () => {
    expect(FUENTE).toMatch(/import \{ getBusinessDateRange[^}]*\} from '\.\.\/lib\/businessDate'/)
    expect(FUENTE).toContain('getBusinessDateRange(preset)')
  })

  test('no vuelve a cortar fechas pasando por UTC ni por getters locales', () => {
    expect(FUENTE).not.toMatch(/toISOString\(\)/)
    expect(FUENTE).not.toMatch(/function getDateRange/)
    expect(FUENTE).not.toMatch(/\.get(Date|Day|Month|FullYear)\(\)/)
  })
})
