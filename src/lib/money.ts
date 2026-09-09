/**
 * ORDERS-V2-0.1 — autoridad de PRESENTACIÓN de importes.
 *
 * Esto es formato, no aritmética. No calcula, no convierte, no toca balances,
 * ledgers, RPCs ni cotizaciones. Recibe un número y una moneda y devuelve un
 * string.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────
 * El owner reportó que en Presupuesto, 85000 en ARS y 85000 en USD "se ven
 * como el mismo número genérico". La causa está en `utils/priceCalculator.ts`:
 *
 *     export function formatPrice(price, currency = 'ARS') {
 *       if (currency === 'USD') return `$${price.toLocaleString('en-US', …)}`
 *       return `$${price.toLocaleString('es-AR', …)}`
 *     }
 *
 * Las dos ramas emiten `$`. Lo único que cambia son los separadores:
 * `$85.000,00` contra `$85,000.00`. En Argentina `$` ya significa pesos, así
 * que usarlo también para dólares no es ambiguo: es engañoso.
 *
 * ── Por qué no es "un cuarto helper" ──────────────────────────────────────
 * El repo ya tenía varias implementaciones, y una de ellas ya era correcta:
 * `lib/finance/financeInsightPresentation.ts` usa `Intl.NumberFormat` con
 * `style: 'currency'`, que en `es-AR` rinde `$ 85.000,00` y `US$ 85.000,00`.
 * Este módulo PROMUEVE ese criterio ya probado a un lugar neutral que la UI
 * puede importar sin depender de finanzas. Los demás helpers quedan
 * inventariados en `docs/orders-v2-0-1-money-audit.md`.
 */

export type MoneyCurrency = 'ARS' | 'USD'

export const MONEY_LOCALE = 'es-AR'

/**
 * Prefijo visible del campo de carga. `Intl` lo emite igual, pero el input
 * necesita el símbolo por separado para dibujarlo como adorno fijo.
 */
export const CURRENCY_PREFIX: Record<MoneyCurrency, string> = {
  ARS: '$',
  USD: 'US$',
}

export const CURRENCY_LABEL: Record<MoneyCurrency, string> = {
  ARS: 'ARS — Pesos',
  USD: 'USD — Dólares',
}

function formatter(currency: MoneyCurrency, decimals: number): Intl.NumberFormat {
  return new Intl.NumberFormat(MONEY_LOCALE, {
    style: 'currency',
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

/**
 * Importe con su moneda, para DISPLAY. En `es-AR`:
 *   formatMoney(85000, 'ARS') → "$ 85.000,00"
 *   formatMoney(85000, 'USD') → "US$ 85.000,00"
 *
 * `decimals: 0` para tarjetas y listados donde los centavos son ruido.
 */
export function formatMoney(
  value: number | null | undefined,
  currency: MoneyCurrency = 'ARS',
  options: { decimals?: number; fallback?: string } = {},
): string {
  const { decimals = 2, fallback = '—' } = options
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return formatter(currency, decimals).format(value)
}

/**
 * Sólo los dígitos agrupados, sin símbolo — para cuando la moneda ya está
 * indicada al lado (el caso del input, que dibuja su propio prefijo).
 */
export function formatAmount(
  value: number | null | undefined,
  options: { decimals?: number; fallback?: string } = {},
): string {
  const { decimals = 2, fallback = '' } = options
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return new Intl.NumberFormat(MONEY_LOCALE, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value)
}

/** Agrupa la parte entera de lo que se está tipeando, sin tocar los decimales. */
export function groupIntegerDigits(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (!digits) return ''
  return new Intl.NumberFormat(MONEY_LOCALE).format(BigInt(digits))
}

/**
 * Formato mientras se escribe. Conserva la coma decimal y los ceros que el
 * usuario está tipeando (`1000,50`, `1000,` y `1000,0` son estados válidos
 * intermedios que un `Number()` destruiría).
 *
 * NO parsea a número: para eso está `parseLocalizedAmount`, que sigue siendo
 * la autoridad de conversión y no se toca.
 */
export function formatMoneyInput(raw: string): string {
  const clean = raw.replace(/[^\d.,]/g, '')
  if (!clean) return ''

  // La última coma manda como separador decimal (convención es-AR). Los
  // puntos que el usuario escriba se leen como separadores de miles.
  const comma = clean.lastIndexOf(',')
  const integerPart = comma >= 0 ? clean.slice(0, comma) : clean
  const decimalPart = comma >= 0 ? clean.slice(comma + 1).replace(/\D/g, '').slice(0, 2) : null

  const grouped = groupIntegerDigits(integerPart)
  if (decimalPart === null) return grouped
  return `${grouped || '0'},${decimalPart}`
}
