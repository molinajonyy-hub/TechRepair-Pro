// ─────────────────────────────────────────────────────────────────────────────
// ORDERS-V2-0.1 — la moneda tiene que leerse, no adivinarse.
//
// El owner reportó que 85000 ARS y 85000 USD "se ven como el mismo número".
// La causa está en `utils/priceCalculator.formatPrice`, que emite `$` para las
// dos monedas y sólo cambia los separadores. Estos tests fijan el criterio
// correcto y dejan el bug documentado como control.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, expect, it } from 'vitest'
import {
  CURRENCY_PREFIX,
  formatAmount,
  formatMoney,
  formatMoneyInput,
  groupIntegerDigits,
} from '../../src/lib/money'
import { formatPrice } from '../../src/utils/priceCalculator'
import { parseLocalizedAmount } from '../../src/features/order-intake/model'

/** `Intl` usa espacios duros y no-rompibles; normalizarlos para poder aseverar. */
const flat = (value: string) => value.replace(/ | /g, ' ')

describe('ORDERS-V2-0.1 · formato de importes', () => {
  it('distingue ARS de USD por el símbolo, no sólo por los separadores', () => {
    const ars = flat(formatMoney(85000, 'ARS'))
    const usd = flat(formatMoney(85000, 'USD'))

    expect(ars).toContain('$')
    expect(usd).toContain('US$')
    expect(ars).not.toContain('US$')
    expect(ars).not.toBe(usd)
  })

  it('agrupa a la argentina: punto para miles, coma para decimales', () => {
    expect(flat(formatMoney(85000, 'ARS'))).toBe('$ 85.000,00')
    expect(flat(formatMoney(1234567.5, 'ARS'))).toBe('$ 1.234.567,50')
  })

  it('el mismo número en USD conserva la agrupación local', () => {
    // Lo que cambia es la unidad, no la forma de leer el número: el usuario es
    // argentino en las dos monedas.
    expect(flat(formatMoney(85000, 'USD'))).toBe('US$ 85.000,00')
  })

  it('permite ocultar centavos donde son ruido', () => {
    expect(flat(formatMoney(85000, 'ARS', { decimals: 0 }))).toBe('$ 85.000')
  })

  it('un importe ausente no se muestra como cero', () => {
    // Mostrar "$ 0,00" donde no hay dato afirma algo falso.
    expect(formatMoney(null)).toBe('—')
    expect(formatMoney(undefined)).toBe('—')
    expect(formatMoney(Number.NaN)).toBe('—')
    expect(formatMoney(null, 'ARS', { fallback: 'Sin presupuesto' })).toBe('Sin presupuesto')
  })

  it('formatAmount omite el símbolo para cuando la moneda ya está al lado', () => {
    expect(flat(formatAmount(85000))).toBe('85.000,00')
    expect(formatAmount(null)).toBe('')
  })

  it('CONTROL — `formatPrice` sigue siendo ambiguo; por eso existe formatMoney', () => {
    // Este test NO afirma que esté bien: documenta el bug que motivó el lote y
    // falla el día que alguien arregle `formatPrice`, momento en que hay que
    // borrarlo. Ver docs/orders-v2-0-1-money-audit.md.
    expect(formatPrice(85000, 'ARS').startsWith('$')).toBe(true)
    expect(formatPrice(85000, 'USD').startsWith('$')).toBe(true)
    expect(formatPrice(85000, 'USD').startsWith('US$')).toBe(false)
  })
})

describe('ORDERS-V2-0.1 · formato mientras se escribe', () => {
  it('agrupa la parte entera a medida que se tipea', () => {
    expect(groupIntegerDigits('85000')).toBe('85.000')
    expect(groupIntegerDigits('1234567')).toBe('1.234.567')
    expect(groupIntegerDigits('')).toBe('')
  })

  it('conserva estados intermedios que un Number() destruiría', () => {
    // `1000,` y `1000,0` son lo que hay en pantalla mientras se escribe
    // "1000,50". Si el formateo los colapsa, no se puede tipear un decimal.
    expect(formatMoneyInput('1000,')).toBe('1.000,')
    expect(formatMoneyInput('1000,0')).toBe('1.000,0')
    expect(formatMoneyInput('1000,50')).toBe('1.000,50')
  })

  it('acepta las cuatro formas del pedido', () => {
    expect(formatMoneyInput('1000')).toBe('1.000')
    expect(formatMoneyInput('1.000')).toBe('1.000')
    expect(formatMoneyInput('1000,50')).toBe('1.000,50')
    expect(formatMoneyInput('1.000,50')).toBe('1.000,50')
  })

  it('descarta lo que no es número y acota a dos decimales', () => {
    expect(formatMoneyInput('a1b0c0d0')).toBe('1.000')
    expect(formatMoneyInput('1000,999')).toBe('1.000,99')
    expect(formatMoneyInput('')).toBe('')
  })

  it('lo que sale del input lo entiende el parser canónico, sin float bugs', () => {
    // El contrato con el backend no cambia: sigue pasando por
    // `parseLocalizedAmount`, que es la autoridad de conversión.
    for (const raw of ['1000', '1.000', '1000,50', '1.000,50', '85000', '1234567,89']) {
      const shown = formatMoneyInput(raw)
      const parsed = parseLocalizedAmount(shown)
      expect(parsed, `«${raw}» → «${shown}»`).not.toBeNull()
      expect(Number.isFinite(parsed as number)).toBe(true)
    }
    expect(parseLocalizedAmount(formatMoneyInput('1.000,50'))).toBe(1000.5)
    expect(parseLocalizedAmount(formatMoneyInput('85000'))).toBe(85000)
  })

  it('el prefijo por moneda es el que ve el usuario en el campo', () => {
    expect(CURRENCY_PREFIX.ARS).toBe('$')
    expect(CURRENCY_PREFIX.USD).toBe('US$')
  })
})
