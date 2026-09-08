// ─────────────────────────────────────────────────────────────────────────────
// ORDERS-V2-0.1 — el combobox que reemplaza a <datalist>.
//
// ROOT CAUSE: marca y modelo usaban `<input list>` + `<datalist>`. En WebKit
// móvil la lista no se despliega de forma confiable, así que en el celular el
// campo quedaba pelado — lo que reportó el owner.
//
// `<datalist>` además no tiene API para abrirlo ni estados de carga/vacío: la
// UI la dibuja el navegador. Una función central no puede depender de eso.
// ─────────────────────────────────────────────────────────────────────────────
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { AppCombobox } from '../../src/ui/components/AppCombobox'

const MARCAS = ['Apple', 'Motorola', 'Samsung', 'Xiaomi']

function Controlled(props: Partial<React.ComponentProps<typeof AppCombobox>> = {}) {
  const [value, setValue] = useState(props.value ?? '')
  return (
    <AppCombobox
      label="Marca"
      options={MARCAS}
      {...props}
      value={value}
      onChange={next => { setValue(next); props.onChange?.(next) }}
    />
  )
}

const input = () => screen.getByRole('combobox', { name: /Marca/ })
const options = () => screen.queryAllByRole('option')

describe('ORDERS-V2-0.1 · AppCombobox', () => {
  it('la lista la dibuja la app, no el navegador', () => {
    const { container } = render(<Controlled />)
    // Si quedara un `<datalist>`, el bug de WebKit móvil volvería con él.
    expect(container.querySelector('datalist')).toBeNull()
    expect(input()).toHaveAttribute('role', 'combobox')
    expect(input()).toHaveAttribute('aria-autocomplete', 'list')
  })

  it('abre al enfocar y expone las opciones como listbox', () => {
    render(<Controlled />)
    expect(input()).toHaveAttribute('aria-expanded', 'false')
    fireEvent.focus(input())
    expect(input()).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(options()).toHaveLength(MARCAS.length)
  })

  it('filtra sin distinguir mayúsculas ni acentos', () => {
    render(<Controlled />)
    fireEvent.focus(input())
    fireEvent.change(input(), { target: { value: 'sam' } })
    expect(options().map(node => node.textContent)).toEqual(['Samsung'])
  })

  it('INVARIANTE: el texto libre siempre gana', () => {
    // El taller recibe equipos que el catálogo no conoce. La lista sugiere;
    // nunca restringe.
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)
    fireEvent.focus(input())
    fireEvent.change(input(), { target: { value: 'Marca Rarísima' } })

    expect(onChange).toHaveBeenLastCalledWith('Marca Rarísima')
    expect(input()).toHaveValue('Marca Rarísima')
    expect(screen.getByText(/Podés escribirla igual|Sin sugerencias/)).toBeInTheDocument()
  })

  it('se recorre con flechas y se elige con Enter', () => {
    render(<Controlled />)
    fireEvent.focus(input())
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(input()).toHaveAttribute('aria-activedescendant', expect.stringContaining('option-0') as unknown as string)
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(input()).toHaveValue('Motorola')
    expect(input()).toHaveAttribute('aria-expanded', 'false')
  })

  it('abierto y sin marcar, subir entra por el último', () => {
    // Enfocar ya abre la lista, así que la primera flecha llega con
    // `active === -1`. Subir desde ahí tiene que ir al final, no a un índice
    // arbitrario del medio.
    render(<Controlled />)
    fireEvent.focus(input())
    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(input()).toHaveValue('Xiaomi')
  })

  it('las flechas dan la vuelta en los extremos', () => {
    render(<Controlled />)
    fireEvent.focus(input())
    fireEvent.keyDown(input(), { key: 'ArrowDown' })  // -1 → 0 (Apple)
    fireEvent.keyDown(input(), { key: 'ArrowUp' })    // 0 → último
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(input()).toHaveValue('Xiaomi')
  })

  it('Enter sin sugerencia marcada NO se intercepta', () => {
    // Si se lo tragara, no se podría enviar el formulario desde el campo.
    const onSubmit = vi.fn(event => event.preventDefault())
    render(<form onSubmit={onSubmit}><Controlled /></form>)
    fireEvent.focus(input())
    fireEvent.change(input(), { target: { value: 'Apple' } })
    const event = fireEvent.keyDown(input(), { key: 'Enter' })
    expect(event).toBe(true) // no se llamó preventDefault
  })

  it('Escape cierra sin borrar lo escrito', () => {
    render(<Controlled />)
    fireEvent.focus(input())
    fireEvent.change(input(), { target: { value: 'Sam' } })
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(input()).toHaveAttribute('aria-expanded', 'false')
    expect(input()).toHaveValue('Sam')
  })

  it('elegir con el dedo funciona: pointerdown, no click', () => {
    // Con `click` el blur del input desmontaba la lista y el tap nunca
    // llegaba a la opción — el bug clásico de los desplegables táctiles.
    render(<Controlled />)
    fireEvent.focus(input())
    fireEvent.pointerDown(screen.getByRole('option', { name: /Samsung/ }))
    expect(input()).toHaveValue('Samsung')
  })

  it('muestra que está buscando, cosa que datalist no podía', () => {
    render(<Controlled options={[]} loading />)
    fireEvent.focus(input())
    expect(screen.getByText('Buscando…')).toBeInTheDocument()
  })

  it('la selección no se apoya sólo en el color', () => {
    render(<Controlled value="Samsung" />)
    fireEvent.focus(input())
    const selected = screen.getByRole('option', { name: /Samsung/ })
    expect(selected).toHaveAttribute('aria-selected', 'true')
    expect(selected).toHaveClass('is-selected')
  })

  it('el chevron no es una parada extra del tabulador', () => {
    const { container } = render(<Controlled />)
    expect(container.querySelector('.app-combobox-toggle')).toHaveAttribute('tabindex', '-1')
  })
})
