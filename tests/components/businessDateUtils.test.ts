// FINANCE BUSINESS DATE 2C · una sola autoridad para el calendario de negocio.
//
// src/utils/dateUtils.ts tenia su propia implementacion de "hoy en Argentina"
// (todayAR, daysAgoAR, isToday): parseaba el string de toLocaleDateString('es-AR')
// y anclaba con offsets a mano. Daba bien, pero era una segunda fuente de verdad.
// Ahora conservan su API y delegan en src/lib/businessDate.ts.
import { readFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../src/lib/businessDate.ts', async (original) => {
  const real = await original<typeof import('../../src/lib/businessDate.ts')>()
  return {
    ...real,
    businessToday: vi.fn(real.businessToday),
    addCalendarDays: vi.fn(real.addCalendarDays),
    businessDateOfInstant: vi.fn(real.businessDateOfInstant),
  }
})

import * as businessDate from '../../src/lib/businessDate.ts'
import { daysAgoAR, fmtDateCompact, isToday, todayAR } from '../../src/utils/dateUtils'

describe.each(['UTC', 'America/Argentina/Cordoba'])('dateUtils con TZ del proceso = %s', (tz) => {
  let previo: string | undefined
  beforeAll(() => { previo = process.env.TZ; process.env.TZ = tz })
  afterAll(() => { if (previo === undefined) delete process.env.TZ; else process.env.TZ = previo })
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-30T22:30:00-03:00'))  // UTC ya es 01/10
    vi.mocked(businessDate.businessToday).mockClear()
    vi.mocked(businessDate.addCalendarDays).mockClear()
    vi.mocked(businessDate.businessDateOfInstant).mockClear()
  })
  afterEach(() => { vi.useRealTimers() })

  test('todayAR() es businessToday(): 30/09 a las 22:30 AR', () => {
    expect(todayAR()).toBe('2026-09-30')
    expect(businessDate.businessToday).toHaveBeenCalledTimes(1)
  })

  test('daysAgoAR(n) es addCalendarDays(businessToday(), -n), cruzando meses', () => {
    expect(daysAgoAR(0)).toBe('2026-09-30')
    expect(daysAgoAR(6)).toBe('2026-09-24')
    expect(daysAgoAR(30)).toBe('2026-08-31')
    expect(businessDate.addCalendarDays).toHaveBeenLastCalledWith('2026-09-30', -30)
  })

  test('isToday(instante) compara el dia de negocio del instante con el de hoy', () => {
    expect(isToday('2026-10-01T01:30:00Z')).toBe(true)    // 30/09 22:30 AR
    expect(isToday('2026-09-30T03:00:00Z')).toBe(true)    // 30/09 00:00 AR
    expect(isToday('2026-09-30T02:59:59Z')).toBe(false)   // 29/09 23:59 AR
    expect(isToday('2026-10-01T03:00:00Z')).toBe(false)   // 01/10 00:00 AR
    expect(businessDate.businessDateOfInstant).toHaveBeenCalled()
  })

  test('isToday con una fecha de calendario la toma como dia argentino (no medianoche UTC)', () => {
    expect(isToday('2026-09-30')).toBe(true)
    expect(isToday('2026-10-01')).toBe(false)
  })

  test('los formatters siguen mostrando la fecha de calendario tal cual', () => {
    expect(fmtDateCompact('2026-09-30')).toMatch(/^30/)
  })
})

describe('control de fuente: dateUtils no reimplementa el calendario', () => {
  const fuente = readFileSync('src/utils/dateUtils.ts', 'utf8')

  test('importa la autoridad canonica', () => {
    expect(fuente).toMatch(/import \{[^}]*\bbusinessToday\b[^}]*\} from '\.\.\/lib\/businessDate\.ts'/)
  })

  test('todayAR / daysAgoAR / isToday delegan', () => {
    expect(fuente).toMatch(/export const todayAR = \(\): string => businessToday\(\)/)
    expect(fuente).toMatch(/export const daysAgoAR = \(n: number\): string => addCalendarDays\(businessToday\(\), -n\)/)
    expect(fuente).toMatch(/export const isToday = \(d: string\): boolean =>\s*\n\s*businessDateOfInstant\(parse\(d\)\) === businessToday\(\)/)
  })

  test('sin parseo de strings de locale ni offsets a mano para calcular el dia', () => {
    expect(fuente).not.toMatch(/split\(['"]\/['"]\)/)
    expect(fuente).not.toMatch(/-03:00/)
    expect(fuente).not.toMatch(/86400000|86_400_000/)
  })
})
