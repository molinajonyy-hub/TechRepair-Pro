import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ search: vi.fn() }))
vi.mock('../../src/services/posCustomerSearchService', () => ({
  searchPosCustomers: mocks.search,
}))

import { CustomerPicker } from '../../src/features/customer-core/CustomerPicker'

function ok(items: unknown[], truncated = false) {
  return { status: 'ok', items, truncated }
}

const CLIENTE = { id: 'c1', name: 'Ana Gómez', phone: '3512345678', document: 'DNI 30123456' }

function renderPicker(props: Partial<React.ComponentProps<typeof CustomerPicker>> = {}) {
  return render(
    <CustomerPicker
      businessId="biz-a"
      selectedId=""
      onSelect={props.onSelect ?? vi.fn()}
      {...props}
    />,
  )
}

describe('ORDERS-V2-0 · CustomerPicker', () => {
  beforeEach(() => {
    mocks.search.mockReset().mockResolvedValue(ok([CLIENTE]))
  })

  it('busca server-side acotado al negocio y muestra teléfono y documento', async () => {
    renderPicker()
    expect(await screen.findByRole('button', { name: /Ana Gómez/ })).toBeInTheDocument()
    expect(screen.getByText('3512345678 · DNI 30123456')).toBeInTheDocument()
    expect(mocks.search).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'biz-a' }))
  })

  it('no dispara una búsqueda por tecla: agrupa el tipeo en una sola', async () => {
    renderPicker()
    await screen.findByRole('button', { name: /Ana Gómez/ })
    const input = screen.getByTestId('customer-picker-search')

    fireEvent.change(input, { target: { value: 'A' } })
    fireEvent.change(input, { target: { value: 'An' } })
    fireEvent.change(input, { target: { value: 'Ana' } })

    await waitFor(() => expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'Ana' }),
    ))
    // La inicial + la del término final. Nunca una por carácter.
    expect(mocks.search.mock.calls.filter(call => call[0].query !== '')).toHaveLength(1)
  })

  it('cancela la búsqueda anterior al cambiar el término', async () => {
    renderPicker()
    await screen.findByRole('button', { name: /Ana Gómez/ })
    fireEvent.change(screen.getByTestId('customer-picker-search'), { target: { value: 'Ana' } })
    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(2))

    const primeraSignal = mocks.search.mock.calls[0][0].signal as AbortSignal
    expect(primeraSignal.aborted).toBe(true)
  })

  it('avisa que faltan caracteres en vez de mostrar «sin resultados»', async () => {
    mocks.search.mockResolvedValue(ok([]))
    renderPicker()
    fireEvent.change(screen.getByTestId('customer-picker-search'), { target: { value: 'a' } })
    expect(await screen.findByText('Escribí al menos 2 caracteres.')).toBeInTheDocument()
    expect(screen.queryByText('No encontramos coincidencias.')).not.toBeInTheDocument()
  })

  it('distingue «sin clientes cargados» de «sin coincidencias»', async () => {
    mocks.search.mockResolvedValue(ok([]))
    renderPicker()
    expect(await screen.findByText('Todavía no hay clientes cargados.')).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('customer-picker-search'), { target: { value: 'Zzz' } })
    expect(await screen.findByText('No encontramos coincidencias.')).toBeInTheDocument()
  })

  it('reporta el error del servidor y no lo disfraza de lista vacía', async () => {
    mocks.search.mockResolvedValue({ status: 'error', items: [], truncated: false, error: '42501' })
    renderPicker()
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudieron buscar clientes')
    expect(screen.queryByText('Todavía no hay clientes cargados.')).not.toBeInTheDocument()
  })

  it('avisa cuando hay más resultados que el límite', async () => {
    mocks.search.mockResolvedValue(ok([CLIENTE], true))
    renderPicker()
    expect(await screen.findByText(/Afiná la búsqueda/)).toBeInTheDocument()
  })

  it('antepone los clientes fijados sin duplicarlos con los del servidor', async () => {
    mocks.search.mockResolvedValue(ok([CLIENTE, { id: 'c2', name: 'Beto Ruiz' }]))
    renderPicker({ pinned: [{ id: 'c1', name: 'Ana Gómez' }] })
    await screen.findByRole('button', { name: /Beto Ruiz/ })
    expect(screen.getAllByRole('button', { name: /Ana Gómez/ })).toHaveLength(1)
    expect(screen.getAllByRole('button').map(node => node.textContent?.slice(0, 4)))
      .toEqual(['Ana ', 'Beto'])
  })

  it('marca la selección con aria-pressed, no sólo con color', async () => {
    renderPicker({ selectedId: 'c1' })
    const option = await screen.findByRole('button', { name: /Ana Gómez/ })
    expect(option).toHaveAttribute('aria-pressed', 'true')
    expect(option).toHaveClass('is-selected')
  })

  it('emite el cliente elegido', async () => {
    const onSelect = vi.fn()
    renderPicker({ onSelect })
    fireEvent.click(await screen.findByRole('button', { name: /Ana Gómez/ }))
    expect(onSelect).toHaveBeenCalledWith(CLIENTE)
  })

  it('sin onCreateNew no ofrece el alta', async () => {
    renderPicker()
    await screen.findByRole('button', { name: /Ana Gómez/ })
    expect(screen.queryByRole('button', { name: 'Crear cliente rápido' })).not.toBeInTheDocument()
  })
})
