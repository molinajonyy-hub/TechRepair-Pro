// ─────────────────────────────────────────────────────────────────────────────
// P0 FIRST-STEPS-1 — tests de componente del checklist derivado.
//
// El mock va en el límite del SERVICIO (`firstStepsService`), nunca del
// componente bajo prueba: así se ejercita de verdad el hook, el contrato de
// dismiss y el render.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// `vi.mock` se iza al tope del archivo, así que las factories no pueden cerrar
// sobre `const` de módulo. `vi.hoisted` sube el estado compartido con ellas.
const h = vi.hoisted(() => ({
  get:        vi.fn(),
  navigate:   vi.fn(),
  businessId: 'biz-1' as string | null,
}))
const mockGet = h.get
const mockNavigate = h.navigate

vi.mock('../../src/services/firstStepsService', async (orig) => {
  const actual = await orig<typeof import('../../src/services/firstStepsService')>()
  return { ...actual, firstStepsService: { get: h.get } }
})

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ businessId: h.businessId }),
}))

vi.mock('react-router-dom', async (orig) => {
  const actual = await orig<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => h.navigate }
})

import { FirstStepsChecklist } from '../../src/components/onboarding/FirstStepsChecklist'
import { dismissKey } from '../../src/hooks/useFirstSteps'

const NOTHING = {
  has_customer: false, has_order: false, has_inventory: false,
  has_cobro: false, has_logo: false,
}

const renderCard = () =>
  render(<MemoryRouter><FirstStepsChecklist /></MemoryRouter>)

/** Lee el estado que el DOM realmente expone para cada paso. */
const stepDone = (id: string) =>
  screen.getByTestId(`setup-step-${id}`).getAttribute('data-done') === 'true'

beforeEach(() => {
  h.businessId = 'biz-1'
  localStorage.clear()
  mockGet.mockReset()
  mockNavigate.mockReset()
})
afterEach(() => { localStorage.clear() })

describe('FirstStepsChecklist — estado derivado del servidor', () => {
  it('tenant nuevo con localStorage limpio muestra 0 de 5', async () => {
    mockGet.mockResolvedValue({ ...NOTHING })
    renderCard()
    await waitFor(() => expect(screen.getByTestId('setup-checklist')).toBeTruthy())

    expect(screen.getByTestId('setup-checklist-progress').textContent).toBe('0/5')
    for (const id of ['customer', 'order', 'inventory', 'cobro', 'logo']) {
      expect(stepDone(id)).toBe(false)
    }
  })

  // ── TEST DISTINTIVO (§17) ──────────────────────────────────────────────────
  // Con SÓLO un cliente creado y el localStorage limpio, el resultado debe ser
  // 1 de 5. La implementación vieja leía el progreso de
  // `onboarding_done_{businessId}`, así que sin tildar nada devolvía 0 de 5 y
  // fallaba exactamente acá.
  it('crear SOLO un customer da 1 de 5, con las otras 4 pendientes', async () => {
    mockGet.mockResolvedValue({ ...NOTHING, has_customer: true })
    renderCard()
    await waitFor(() => expect(screen.getByTestId('setup-checklist')).toBeTruthy())

    expect(screen.getByTestId('setup-checklist-progress').textContent).toBe('1/5')
    expect(stepDone('customer')).toBe(true)
    expect(stepDone('order')).toBe(false)
    expect(stepDone('inventory')).toBe(false)
    expect(stepDone('cobro')).toBe(false)
    expect(stepDone('logo')).toBe(false)
  })

  it('un segundo navegador con localStorage vacío ve el MISMO progreso', async () => {
    mockGet.mockResolvedValue({ ...NOTHING, has_customer: true, has_order: true })

    const first = renderCard()
    await waitFor(() => expect(screen.getByTestId('setup-checklist-progress').textContent).toBe('2/5'))
    first.unmount()

    // "Otro navegador": storage vacío, misma respuesta del servidor.
    localStorage.clear()
    renderCard()
    await waitFor(() => expect(screen.getByTestId('setup-checklist-progress').textContent).toBe('2/5'))
  })

  it('5/5 muestra el estado de éxito y deja cerrarlo', async () => {
    mockGet.mockResolvedValue({
      has_customer: true, has_order: true, has_inventory: true,
      has_cobro: true, has_logo: true,
    })
    renderCard()
    await waitFor(() => expect(screen.getByTestId('setup-checklist-progress').textContent).toBe('5/5'))
    expect(screen.getByText('Configuración completa')).toBeTruthy()
    expect(screen.getByText('Listo, ocultar')).toBeTruthy()
  })

  it('no dibuja nada si la lectura falla (nunca un 0/5 falso)', async () => {
    mockGet.mockResolvedValue(null)
    renderCard()
    await waitFor(() => expect(mockGet).toHaveBeenCalled())
    expect(screen.queryByTestId('setup-checklist')).toBeNull()
  })
})

describe('FirstStepsChecklist — las tareas NO son checkboxes', () => {
  it('el indicador no es interactivo: tocar la fila NAVEGA, no marca', async () => {
    mockGet.mockResolvedValue({ ...NOTHING })
    renderCard()
    await waitFor(() => expect(screen.getByTestId('setup-checklist')).toBeTruthy())

    fireEvent.click(screen.getByTestId('setup-step-customer'))

    expect(mockNavigate).toHaveBeenCalledWith('/customers/new')
    // El estado NO cambió por tocar: sigue viniendo del servidor.
    expect(stepDone('customer')).toBe(false)
    expect(screen.getByTestId('setup-checklist-progress').textContent).toBe('0/5')
  })

  it('no existe ningún checkbox ni input en la tarjeta', async () => {
    mockGet.mockResolvedValue({ ...NOTHING })
    renderCard()
    await waitFor(() => expect(screen.getByTestId('setup-checklist')).toBeTruthy())

    const card = screen.getByTestId('setup-checklist')
    expect(card.querySelectorAll('input').length).toBe(0)
    expect(card.querySelectorAll('[role="checkbox"]').length).toBe(0)
  })

  it('cada fila es un button accesible que anuncia su estado', async () => {
    mockGet.mockResolvedValue({ ...NOTHING, has_customer: true })
    renderCard()
    await waitFor(() => expect(screen.getByTestId('setup-checklist')).toBeTruthy())

    const done = screen.getByTestId('setup-step-customer')
    expect(done.tagName).toBe('BUTTON')
    expect(done.getAttribute('aria-label')).toContain('Completado')

    const pending = screen.getByTestId('setup-step-order')
    expect(pending.getAttribute('aria-label')).toContain('Pendiente')
  })
})

describe('FirstStepsChecklist — dismiss es preferencia de UI, no estado', () => {
  it('descartar oculta la tarjeta y guarda la clave NUEVA', async () => {
    mockGet.mockResolvedValue({ ...NOTHING })
    renderCard()
    await waitFor(() => expect(screen.getByTestId('setup-checklist')).toBeTruthy())

    const dismiss = screen.getByLabelText('Ocultar primeros pasos')
    expect(dismiss).toHaveClass('mobile-touch-target')
    fireEvent.click(dismiss)

    await waitFor(() => expect(screen.queryByTestId('setup-checklist')).toBeNull())
    expect(localStorage.getItem(dismissKey('biz-1'))).toBe('true')
  })

  it('descartar NO altera el estado server-side: la RPC sigue diciendo lo mismo', async () => {
    mockGet.mockResolvedValue({ ...NOTHING, has_customer: true })
    const view = renderCard()
    await waitFor(() => expect(screen.getByTestId('setup-checklist')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Ocultar primeros pasos'))
    await waitFor(() => expect(screen.queryByTestId('setup-checklist')).toBeNull())
    view.unmount()

    // Se limpia SÓLO la preferencia local: el progreso vuelve intacto.
    localStorage.clear()
    renderCard()
    await waitFor(() => expect(screen.getByTestId('setup-checklist-progress').textContent).toBe('1/5'))
    expect(stepDone('customer')).toBe(true)
  })

  it('la clave vieja onboarding_done_* NO se lee ni se escribe', async () => {
    // Un navegador con la clave vieja marcando TODO como hecho.
    localStorage.setItem(
      'onboarding_done_biz-1',
      JSON.stringify(['customer', 'order', 'inventory', 'cobro', 'logo']),
    )
    mockGet.mockResolvedValue({ ...NOTHING })

    renderCard()
    await waitFor(() => expect(screen.getByTestId('setup-checklist')).toBeTruthy())

    // El servidor manda: 0/5 pese a la clave vieja llena.
    expect(screen.getByTestId('setup-checklist-progress').textContent).toBe('0/5')

    fireEvent.click(screen.getByLabelText('Ocultar primeros pasos'))
    await waitFor(() => expect(screen.queryByTestId('setup-checklist')).toBeNull())

    // Y el dismiss no reescribe la clave vieja.
    expect(localStorage.getItem('onboarding_done_biz-1')).toBe(
      JSON.stringify(['customer', 'order', 'inventory', 'cobro', 'logo']),
    )
  })

  it('el dismiss es por negocio: otro tenant no queda oculto', async () => {
    mockGet.mockResolvedValue({ ...NOTHING })
    const view = renderCard()
    await waitFor(() => expect(screen.getByTestId('setup-checklist')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Ocultar primeros pasos'))
    await waitFor(() => expect(screen.queryByTestId('setup-checklist')).toBeNull())
    view.unmount()

    h.businessId = 'biz-2'
    renderCard()
    await waitFor(() => expect(screen.getByTestId('setup-checklist')).toBeTruthy())
  })
})

describe('FirstStepsChecklist — lectura', () => {
  it('la RPC se invoca SIN argumentos (el tenant se deriva server-side)', async () => {
    mockGet.mockResolvedValue({ ...NOTHING })
    renderCard()
    await waitFor(() => expect(mockGet).toHaveBeenCalled())
    expect(mockGet.mock.calls[0].length).toBe(0)
  })

  it('un solo round-trip por montaje', async () => {
    mockGet.mockResolvedValue({ ...NOTHING })
    renderCard()
    await waitFor(() => expect(screen.getByTestId('setup-checklist')).toBeTruthy())
    expect(mockGet).toHaveBeenCalledTimes(1)
  })
})
