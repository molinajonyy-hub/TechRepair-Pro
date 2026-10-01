// ============================================================================
// FECHA DE NEGOCIO — rangos YYYY-MM-DD sobre el calendario civil argentino.
//
// Los filtros de Finanzas mandan fechas de calendario (DATE) a la base, que fecha
// el negocio con `public.ar_today()`, o sea en hora argentina. El camino
// habitual del browser rompe ese contrato:
//
//     const d = new Date(2026, 8, 30, 22, 30)  // 30/09 22:30 en Argentina
//     d.toISOString().split('T')[0]            // -> '2026-10-01'
//
// `toISOString()` pasa a UTC antes de cortar la fecha y, entre las 21:00 y las
// 24:00 AR, eso ya es el dia siguiente. Ademas, los getters locales (getDate,
// getMonth, getDay) dependen de la zona del browser, no de la del negocio.
//
// La regla:
//   · "hoy" sale SOLO de `argentinaCivilDate` (src/lib/fiscalCalendar.ts), la
//     autoridad canonica que ya usa ARCA para CbteFch;
//   · el resto (ayer, semana, mes) es aritmetica de almanaque sobre ese
//     YYYY-MM-DD. `Date.UTC` se usa solo como calculadora de calendario: entra y
//     sale por getters UTC, asi que no hay instante ni zona que convertir.
//
// America/Argentina/Buenos_Aires (fiscalCalendar) y America/Argentina/Cordoba
// (`ar_today()`) tienen la misma regla vigente: UTC-3 todo el año, sin horario
// de verano. Devuelven el mismo dia civil.
// ============================================================================
import { argentinaCivilDate } from './fiscalCalendar'

export type BusinessPeriodPreset = 'today' | 'yesterday' | 'week' | 'month' | 'last_month'

export interface BusinessDateRange { from: string; to: string }

const FECHA_CIVIL = /^(\d{4})-(\d{2})-(\d{2})$/

function partes(fecha: string): [number, number, number] {
  const m = FECHA_CIVIL.exec(fecha)
  if (!m) throw new RangeError(`fecha de negocio invalida: ${fecha}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function desdeUTC(d: Date): string {
  const y = String(d.getUTCFullYear()).padStart(4, '0')
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Dia civil argentino de `now` (por defecto, ahora), como YYYY-MM-DD. */
export function businessToday(now: Date = new Date()): string {
  return argentinaCivilDate(now)
}

/** `fecha` corrida `dias` dias de calendario (negativo = hacia atras). */
export function addCalendarDays(fecha: string, dias: number): string {
  const [y, m, d] = partes(fecha)
  return desdeUTC(new Date(Date.UTC(y, m - 1, d + dias)))
}

/** Dia de la semana de `fecha`: 0 = domingo … 6 = sabado. */
export function calendarWeekday(fecha: string): number {
  const [y, m, d] = partes(fecha)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** Primer dia del mes de `fecha`. */
export function firstDayOfMonth(fecha: string): string {
  const [y, m] = partes(fecha)
  return desdeUTC(new Date(Date.UTC(y, m - 1, 1)))
}

/**
 * Rango [from, to] de un preset de Finanzas, en fecha de negocio argentina.
 *
 *   today       hoy..hoy
 *   yesterday   ayer..ayer
 *   week        domingo de esta semana..hoy
 *   month       primer dia del mes..hoy
 *   last_month  primer..ultimo dia del mes anterior
 */
export function getBusinessDateRange(preset: BusinessPeriodPreset, now: Date = new Date()): BusinessDateRange {
  const hoy = businessToday(now)
  switch (preset) {
    case 'today':
      return { from: hoy, to: hoy }
    case 'yesterday': {
      const ayer = addCalendarDays(hoy, -1)
      return { from: ayer, to: ayer }
    }
    case 'week':
      return { from: addCalendarDays(hoy, -calendarWeekday(hoy)), to: hoy }
    case 'month':
      return { from: firstDayOfMonth(hoy), to: hoy }
    case 'last_month': {
      const fin = addCalendarDays(firstDayOfMonth(hoy), -1)
      return { from: firstDayOfMonth(fin), to: fin }
    }
  }
}
