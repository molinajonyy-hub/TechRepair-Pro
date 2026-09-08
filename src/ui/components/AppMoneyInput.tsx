import { useId } from 'react'
import {
  CURRENCY_LABEL,
  CURRENCY_PREFIX,
  formatMoneyInput,
  type MoneyCurrency,
} from '../../lib/money'

/**
 * ORDERS-V2-0.1 — autoridad global para cargar importes.
 *
 * Moneda y monto son UNA unidad visual: el prefijo (`$` / `US$`) vive dentro
 * del campo y cambia con el selector, así que en todo momento se ve qué se
 * está cargando. Antes eran dos controles sueltos y `85000` se veía idéntico
 * en pesos y en dólares.
 *
 * ── Contrato ──────────────────────────────────────────────────────────────
 * PRESENTACIÓN + ENTRADA. No convierte, no aplica cotización, no toca
 * balances ni RPCs. Cambiar ARS → USD cambia el rótulo, **nunca el número**:
 * 85.000 pesos no se transforman en 85.000 dólares ni al revés.
 *
 * `value` viaja como el string que el usuario escribió, igual que antes. La
 * conversión a número la sigue haciendo `parseLocalizedAmount`, que continúa
 * siendo la autoridad y no se modifica: así el payload al backend no cambia.
 *
 * Regla para adelante: no crear inputs de plata nuevos con `AppInput
 * semantic="decimal"`. Se usa este.
 */

export interface AppMoneyInputProps {
  label: string
  /** Texto tal como se escribe: `1000`, `1.000`, `1000,50`, `1.000,50`. */
  value: string
  onValueChange: (value: string) => void
  currency: MoneyCurrency
  onCurrencyChange: (currency: MoneyCurrency) => void
  currencies?: readonly MoneyCurrency[]
  error?: string
  hint?: string
  placeholder?: string
  disabled?: boolean
  id?: string
  'data-testid'?: string
}

const DEFAULT_CURRENCIES: readonly MoneyCurrency[] = ['ARS', 'USD']

export function AppMoneyInput({
  label, value, onValueChange, currency, onCurrencyChange,
  currencies = DEFAULT_CURRENCIES, error, hint, placeholder = '0',
  disabled = false, id, 'data-testid': testId,
}: AppMoneyInputProps) {
  const reactId = useId()
  const inputId = id ?? `money-${reactId}`
  const currencyId = `${inputId}-currency`
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined

  return (
    <div className="app-money" data-currency={currency}>
      <label htmlFor={inputId} className="form-label">{label}</label>

      {/* `role="group"` da el contexto: el lector anuncia «Presupuesto
          estimado» al entrar y después «Moneda». Si el select se llamara
          «Moneda de Presupuesto estimado», su nombre CONTENDRÍA el del monto y
          toda consulta por etiqueta resolvería a dos elementos. */}
      <div className="app-money-field" role="group" aria-label={label}>
        <label className="sr-only" htmlFor={currencyId}>Moneda</label>
        <select
          id={currencyId}
          className="app-money-currency"
          value={currency}
          disabled={disabled}
          data-testid={testId ? `${testId}-currency` : undefined}
          onChange={event => onCurrencyChange(event.target.value as MoneyCurrency)}
        >
          {currencies.map(option => (
            <option key={option} value={option}>{CURRENCY_LABEL[option]}</option>
          ))}
        </select>

        <div className="app-money-amount">
          {/* Adorno, no contenido: el lector de pantalla ya tiene la moneda
              por el `<select>` etiquetado, y repetirla acá sería redundante. */}
          <span className="app-money-prefix" aria-hidden="true">{CURRENCY_PREFIX[currency]}</span>
          <input
            id={inputId}
            className="form-control"
            type="text"
            // `inputMode="decimal"` y no `type="number"`: en es-AR el teclado
            // numérico de iOS no ofrece coma, y `type=number` además rechaza
            // los separadores de miles que el usuario ve mientras escribe.
            inputMode="decimal"
            autoComplete="off"
            placeholder={placeholder}
            disabled={disabled}
            value={value}
            aria-invalid={Boolean(error)}
            aria-describedby={describedBy}
            data-testid={testId}
            onChange={event => onValueChange(formatMoneyInput(event.target.value))}
          />
        </div>
      </div>

      {error && <p id={`${inputId}-error`} className="form-error">{error}</p>}
      {hint && !error && <p id={`${inputId}-hint`} className="form-hint">{hint}</p>}
    </div>
  )
}
