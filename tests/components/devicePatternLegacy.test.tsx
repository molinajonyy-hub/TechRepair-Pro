// ─────────────────────────────────────────────────────────────────────────────
// BETA-UX-2 · hotfix — «Acceso del equipo»: patrones de formato anterior y vista
// en mini grilla.
//
// Hubo un cambio de contrato: la grilla numera 1–9 y el servidor guarda 0–8. Los
// patrones guardados por el frontend de MOBILE-2A quedaron en 1–9 y los migrados
// del frontend viejo en 0–8, los dos como arreglo de NÚMEROS; sin un 0 o un 9 no
// hay forma de saber cuál es. Desde este hotfix el patrón se guarda como arreglo
// de STRINGS (el servidor lo acepta igual: valida cada punto con `^[0-8]$` sobre
// `jsonb_array_elements_text`), y ese tipo es la marca de «formato actual».
//
// Lo que se fija acá: la tarjeta nunca muestra como confiable un patrón que no
// puede leerse con certeza; lo que sí puede leerse se ve como grilla 3×3, no
// como texto «1 → 4 → 7». Todos los valores son SINTÉTICOS.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DeviceLockCard } from '../../src/components/order/DeviceLockCard'
import { PatternPreview, describePattern } from '../../src/features/order-intake/PatternPreview'

const mocks = vi.hoisted(() => ({ reveal: vi.fn(), set: vi.fn(), remove: vi.fn() }))
vi.mock('../../src/hooks/usePermissions', () => ({ usePermissions: () => ({ can: () => true }) }))
vi.mock('../../src/features/order-intake/service', () => ({
  revealDeviceAccess: mocks.reveal, setDeviceAccess: mocks.set, deleteDeviceAccess: mocks.remove,
}))

beforeEach(() => {
  mocks.reveal.mockReset(); mocks.set.mockReset().mockResolvedValue(undefined); mocks.remove.mockReset()
})

async function revelar(secret: string, accessMode: 'pattern' | 'pin' = 'pattern') {
  mocks.reveal.mockResolvedValue(secret)
  render(<DeviceLockCard orderId="o1" accessMode={accessMode} />)
  fireEvent.click(screen.getByRole('button', { name: 'Revelar' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Ocultar' })).toBeInTheDocument())
}

describe('PatternPreview · mini grilla 3×3', () => {
  it('marca los puntos en orden, los une y dice la secuencia en palabras', () => {
    const { container } = render(<PatternPreview points={[1, 2, 5, 8]} />)
    const img = screen.getByRole('img')
    expect(img).toHaveAccessibleName(describePattern([1, 2, 5, 8]))
    expect(img.getAttribute('aria-label')).toMatch(/4 puntos, en orden: 1, 2, 5, 8/)
    // Nueve posiciones: cuatro marcadas con su número de orden y cinco libres.
    expect(container.querySelectorAll('.pattern-preview__node')).toHaveLength(4)
    expect(container.querySelectorAll('.pattern-preview__dot')).toHaveLength(5)
    expect([...container.querySelectorAll('.pattern-preview__order')].map(t => t.textContent)).toEqual(['1', '2', '3', '4'])
    // El trazo pasa por los centros en el orden dibujado (fila por fila).
    expect(container.querySelector('.pattern-preview__line')?.getAttribute('points')).toBe('20,20 60,20 60,60 60,100')
    // El inicio no depende sólo del número: lleva un aro.
    const inicio = container.querySelector('.pattern-preview__start')!
    expect([inicio.getAttribute('cx'), inicio.getAttribute('cy')]).toEqual(['20', '20'])
  })
})

describe('Acceso del equipo · lo que se puede leer con certeza se ve como grilla', () => {
  it.each([
    ['formato actual (strings 0–8)', '["0","1","4","7"]'],
    ['migrado del frontend viejo (números con un 0)', '[0,1,4,7]'],
  ])('%s → grilla, sin texto «→»', async (_caso, secreto) => {
    await revelar(secreto)
    expect(screen.getByRole('img', { name: /en orden: 1, 2, 5, 8/ })).toBeInTheDocument()
    expect(screen.queryByTestId('device-lock-legacy')).toBeNull()
    expect(screen.getByTestId('device-lock-reveal').textContent).not.toMatch(/→/)
  })

  it('un PIN se sigue mostrando como texto', async () => {
    await revelar('4826', 'pin')
    expect(screen.getByTestId('device-lock-reveal')).toHaveTextContent('4826')
    expect(screen.queryByRole('img')).toBeNull()
  })
})

describe('Acceso del equipo · formato anterior sin certeza: aviso, no una secuencia', () => {
  it('no muestra grilla ni números; avisa y ofrece reconfigurar', async () => {
    await revelar('[1,2,5,8]')
    const aviso = screen.getByTestId('device-lock-legacy')
    expect(aviso).toHaveTextContent('Patrón guardado con formato anterior')
    expect(aviso).toHaveTextContent(/Recomendamos reconfigurarlo/)
    expect(screen.queryByRole('img')).toBeNull()
    // Ninguna lectura posible del secreto llega a la pantalla.
    for (const digito of ['1', '2', '5', '8']) expect(aviso.textContent).not.toContain(digito)
    // Ocultar, configurar y eliminar siguen ahí.
    for (const accion of ['Ocultar', 'Configurar', 'Eliminar']) expect(screen.getByRole('button', { name: accion })).toBeInTheDocument()
  })

  it('«Reconfigurar patrón» abre la edición con Patrón elegido y guarda en el formato actual', async () => {
    await revelar('[1,2,5,8]')
    fireEvent.click(within(screen.getByTestId('device-lock-legacy')).getByRole('button', { name: 'Reconfigurar patrón' }))
    expect(screen.getByLabelText('Tipo')).toHaveValue('pattern')
    expect(screen.queryByTestId('device-lock-legacy')).toBeNull()
    for (const punto of [1, 5, 9]) fireEvent.click(screen.getByRole('button', { name: `Punto ${punto}` }))
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    await waitFor(() => expect(mocks.set).toHaveBeenCalledWith('o1', 'pattern', '["0","4","8"]'))
  })

  it('un valor que no es un patrón legible tampoco se dibuja', async () => {
    await revelar('1-5-9')
    expect(screen.getByTestId('device-lock-legacy')).toHaveTextContent(/No pudimos leer el patrón guardado/)
    expect(screen.queryByRole('img')).toBeNull()
  })
})
