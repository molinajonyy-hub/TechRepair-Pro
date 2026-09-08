// ─────────────────────────────────────────────────────────────────────────────
// ORDERS-V2-0.1 — moneda y monto como una sola unidad.
//
// El owner reportó que en Presupuesto, 85000 ARS y 85000 USD se veían como el
// mismo número genérico. Acá se fija que el campo muestra SIEMPRE qué moneda
// se está cargando, y el invariante que no se puede romper: cambiar de moneda
// NO convierte el importe.
// ─────────────────────────────────────────────────────────────────────────────
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { AppMoneyInput } from '../../src/ui/components/AppMoneyInput'
import type { MoneyCurrency } from '../../src/lib/money'

function Controlled({ onValueChange }: { onValueChange?: (v: string) => void } = {}) {
  const [value, setValue] = useState('')
  const [currency, setCurrency] = useState<MoneyCurrency>('ARS')
  return (
    <AppMoneyInput
      label="Presupuesto estimado"
      data-testid="budget"
      value={value}
      onValueChange={next => { setValue(next); onValueChange?.(next) }}
      currency={currency}
      onCurrencyChange={setCurrency}
    />
  )
}

const amount = () => screen.getByTestId('budget')
const currency = () => screen.getByTestId('budget-currency')
const prefix = (container: HTMLElement) => container.querySelector('.app-money-prefix')?.textContent

describe('ORDERS-V2-0.1 · AppMoneyInput', () => {
  it('el prefijo dice qué moneda se está cargando', () => {
    const { container } = render(<Controlled />)
    expect(prefix(container)).toBe('$')
    fireEvent.change(currency(), { target: { value: 'USD' } })
    expect(prefix(container)).toBe('US$')
  })

  it('INVARIANTE: cambiar de moneda NO convierte el importe', () => {
    // 85.000 pesos no se transforman en 85.000 dólares ni al revés. Este
    // componente es presentación: no aplica cotización.
    const { container } = render(<Controlled />)
    fireEvent.change(amount(), { target: { value: '85000' } })
    expect(amount()).toHaveValue('85.000')

    fireEvent.change(currency(), { target: { value: 'USD' } })
    expect(amount()).toHaveValue('85.000')   // el número no se tocó
    expect(prefix(container)).toBe('US$')    // sólo cambió la unidad

    fireEvent.change(currency(), { target: { value: 'ARS' } })
    expect(amount()).toHaveValue('85.000')
  })

  it('agrupa mientras se escribe, a la argentina', () => {
    render(<Controlled />)
    fireEvent.change(amount(), { target: { value: '1000' } })
    expect(amount()).toHaveValue('1.000')
    fireEvent.change(amount(), { target: { value: '1234567' } })
    expect(amount()).toHaveValue('1.234.567')
  })

  it('deja tipear decimales sin colapsar los estados intermedios', () => {
    render(<Controlled />)
    fireEvent.change(amount(), { target: { value: '1000,' } })
    expect(amount()).toHaveValue('1.000,')
    fireEvent.change(amount(), { target: { value: '1000,5' } })
    expect(amount()).toHaveValue('1.000,5')
    fireEvent.change(amount(), { target: { value: '1000,50' } })
    expect(amount()).toHaveValue('1.000,50')
  })

  it('emite hacia arriba el texto ya formateado', () => {
    const onValueChange = vi.fn()
    render(<Controlled onValueChange={onValueChange} />)
    fireEvent.change(amount(), { target: { value: '85000' } })
    expect(onValueChange).toHaveBeenLastCalledWith('85.000')
  })

  it('no usa type=number: en iOS no da coma y rechaza los miles', () => {
    render(<Controlled />)
    expect(amount()).toHaveAttribute('type', 'text')
    expect(amount()).toHaveAttribute('inputmode', 'decimal')
  })

  it('el selector de moneda tiene nombre propio, sin colisionar con el monto', () => {
    // Si se llamara «Moneda de Presupuesto estimado», su nombre CONTENDRÍA el
    // del monto y toda consulta por etiqueta resolvería a dos elementos. El
    // contexto lo da el `role="group"` que envuelve a los dos.
    render(<Controlled />)
    expect(screen.getByLabelText('Moneda')).toBe(currency())
    // El grupo lleva el nombre del campo a propósito: es lo que anuncia el
    // lector al entrar. Por eso el monto se busca por rol, no por etiqueta.
    expect(screen.getByRole('group', { name: 'Presupuesto estimado' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Presupuesto estimado' })).toBe(amount())
  })

  it('el prefijo es decorativo: no se anuncia dos veces', () => {
    // La moneda ya la comunica el `<select>` etiquetado; repetirla en el
    // adorno sería ruido para el lector de pantalla.
    const { container } = render(<Controlled />)
    expect(container.querySelector('.app-money-prefix')).toHaveAttribute('aria-hidden', 'true')
  })
})
