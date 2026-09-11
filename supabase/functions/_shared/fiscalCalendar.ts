/**
 * Fiscal calendar for ARCA — the only way to turn an instant into the civil day
 * ARCA receives as CbteFch.
 *
 * The day is Argentina's civil date, resolved with an explicit IANA zone. Never
 * derive it from `toISOString()`, UTC getters, the host or browser timezone, or
 * by parsing a locale string: between 21:00 and 23:59 ART those all land on the
 * next day.
 *
 * Pure (Intl only), so Vite bundles it through `src/lib/fiscalCalendar.ts` and
 * the afip-cae Edge Function imports it directly.
 */

export const ARCA_FISCAL_TIME_ZONE = 'America/Argentina/Buenos_Aires'

/** Shape of a CbteFch value (YYYYMMDD). */
export const ARCA_FISCAL_DATE_SHAPE = /^\d{8}$/

// Gregorian calendar and latin digits are fixed in the locale so formatToParts
// always yields plain numeric year/month/day parts.
const CIVIL_DAY = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
  timeZone: ARCA_FISCAL_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function civilPart(parts: Intl.DateTimeFormatPart[], type: 'year' | 'month' | 'day'): string {
  const value = parts.find((part) => part.type === type)?.value
  if (!value) throw new RangeError(`fiscal calendar: missing ${type}`)
  return value
}

/** Argentina civil date of `instant`, as YYYY-MM-DD. */
export function argentinaCivilDate(instant: Date): string {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw new RangeError('fiscal calendar: invalid instant')
  }
  const parts = CIVIL_DAY.formatToParts(instant)
  const year = civilPart(parts, 'year')
  const month = civilPart(parts, 'month')
  const day = civilPart(parts, 'day')
  if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month) || !/^\d{2}$/.test(day)) {
    throw new RangeError('fiscal calendar: unexpected date parts')
  }
  return `${year}-${month}-${day}`
}

/** ARCA CbteFch (YYYYMMDD) for the Argentina civil day of `instant`. */
export function arcaFiscalDate(instant: Date): string {
  return argentinaCivilDate(instant).replace(/-/g, '')
}

/**
 * CbteFch-shaped date `days` whole days after `instant`. Argentina has no
 * daylight saving time, so adding 24-hour days keeps the same civil offset.
 */
export function arcaFiscalDatePlusDays(instant: Date, days: number): string {
  return arcaFiscalDate(new Date(instant.getTime() + days * 86_400_000))
}

/** Argentina civil date of `instant` for display, as DD/MM/YYYY. */
export function formatArgentinaCivilDate(instant: Date): string {
  const [year, month, day] = argentinaCivilDate(instant).split('-')
  return `${day}/${month}/${year}`
}
