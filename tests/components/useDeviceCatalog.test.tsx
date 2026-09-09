// ─────────────────────────────────────────────────────────────────────────────
// ORDERS-V2-0.1 · pre-merge review — carreras del catálogo de equipos.
//
// El hook exponía UN solo `loading` para marcas y modelos. Dos consecuencias:
//
//   1. El combobox de MARCA mostraba el spinner mientras en realidad se
//      estaban buscando MODELOS.
//   2. Al vaciar la marca, el efecto salía por el `return` temprano sin
//      apagarlo, y Marca quedaba girando para siempre.
//
// Y la carrera de fondo: una respuesta vieja no puede pisar los modelos de la
// marca vigente NI apagar el loading de una búsqueda más nueva.
// ─────────────────────────────────────────────────────────────────────────────
import { act, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ loadBrands: vi.fn(), loadModels: vi.fn() }))
vi.mock('../../src/services/deviceCatalogService', () => ({
  DEFAULT_BRANDS: ['Apple', 'Samsung'],
  loadBrandOptions: mocks.loadBrands,
  loadModelOptions: mocks.loadModels,
}))

import { useDeviceCatalog } from '../../src/features/order-intake/useDeviceCatalog'

/** El hook debounce-a la búsqueda de modelos; los timers son falsos. */
const SETTLE_MS = 300

function Probe({ initialBrand = '' }: { initialBrand?: string }) {
  const [brand, setBrand] = useState(initialBrand)
  const catalog = useDeviceCatalog(brand)
  return (
    <div>
      <button type="button" onClick={() => setBrand('Samsung')}>Samsung</button>
      <button type="button" onClick={() => setBrand('Apple')}>Apple</button>
      <button type="button" onClick={() => setBrand('')}>Vaciar</button>
      <span data-testid="brands-loading">{String(catalog.brandsLoading)}</span>
      <span data-testid="models-loading">{String(catalog.modelsLoading)}</span>
      <span data-testid="models">{catalog.models.join(',')}</span>
      <span data-testid="brands">{catalog.brands.join(',')}</span>
    </div>
  )
}

const state = (id: string) => screen.getByTestId(id).textContent

/** Deja pasar el debounce y los microtasks pendientes. */
async function settle() {
  await act(async () => { vi.advanceTimersByTime(SETTLE_MS); await Promise.resolve() })
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.loadBrands.mockReset().mockResolvedValue(['Apple', 'Samsung'])
  mocks.loadModels.mockReset().mockResolvedValue([])
})
afterEach(() => { vi.useRealTimers() })

describe('ORDERS-V2-0.1 · estados de carga separados', () => {
  it('buscar modelos NO enciende el spinner de marcas', async () => {
    let resolveModels!: (v: string[]) => void
    mocks.loadModels.mockReturnValueOnce(new Promise(r => { resolveModels = r }))

    render(<Probe />)
    await act(async () => { await Promise.resolve() })   // marcas resueltas
    expect(state('brands-loading')).toBe('false')

    act(() => { screen.getByRole('button', { name: 'Samsung' }).click() })
    await settle()

    // El spinner de modelos está encendido; el de marcas NO.
    expect(state('models-loading')).toBe('true')
    expect(state('brands-loading')).toBe('false')

    await act(async () => { resolveModels(['Galaxy A04e']); await Promise.resolve() })
    expect(state('models-loading')).toBe('false')
  })

  it('vaciar la marca apaga el loading de modelos y limpia la lista', async () => {
    let resolveModels!: (v: string[]) => void
    mocks.loadModels.mockReturnValueOnce(new Promise(r => { resolveModels = r }))

    render(<Probe />)
    await act(async () => { await Promise.resolve() })

    act(() => { screen.getByRole('button', { name: 'Samsung' }).click() })
    await settle()
    expect(state('models-loading')).toBe('true')

    // Se borra la marca con la búsqueda todavía en vuelo. Antes el `return`
    // temprano dejaba `loading` encendido para siempre.
    act(() => { screen.getByRole('button', { name: 'Vaciar' }).click() })
    expect(state('models-loading')).toBe('false')
    expect(state('models')).toBe('')

    // Y si la respuesta vieja llega después, no revive nada.
    await act(async () => { resolveModels(['Galaxy A04e']); await Promise.resolve() })
    expect(state('models-loading')).toBe('false')
    expect(state('models')).toBe('')
  })

  it('una respuesta vieja no pisa los modelos de la marca nueva', async () => {
    let resolveSamsung!: (v: string[]) => void
    mocks.loadModels
      .mockReturnValueOnce(new Promise(r => { resolveSamsung = r }))
      .mockResolvedValueOnce(['iPhone 15'])

    render(<Probe />)
    await act(async () => { await Promise.resolve() })

    act(() => { screen.getByRole('button', { name: 'Samsung' }).click() })
    await settle()

    // Cambio rápido a Apple: la búsqueda de Samsung sigue pendiente.
    act(() => { screen.getByRole('button', { name: 'Apple' }).click() })
    await settle()
    expect(state('models')).toBe('iPhone 15')
    expect(state('models-loading')).toBe('false')

    // Ahora responde Samsung, tarde. No puede pisar a Apple…
    await act(async () => { resolveSamsung(['Galaxy A04e']); await Promise.resolve() })
    expect(state('models')).toBe('iPhone 15')
    // …ni apagar/encender el loading de una búsqueda que ya no es la vigente.
    expect(state('models-loading')).toBe('false')
  })

  it('degrada a los fallbacks sin dejar el spinner de marcas colgado', async () => {
    mocks.loadBrands.mockRejectedValueOnce(new Error('red caída'))
    render(<Probe />)
    await act(async () => { await Promise.resolve() })
    expect(state('brands-loading')).toBe('false')
    expect(state('brands')).toBe('Apple,Samsung')
  })
})
