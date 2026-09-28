// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-2B · BLK-1 — el login del portal mayorista es un login NORMAL.
//
// Antes traía el email y la contraseña de una cuenta demo real de producción,
// con un botón «Ingresar como demo» detrás de `import.meta.env.DEV`. Vitest
// corre con DEV = true, así que acá ese botón se vería si alguien lo repone.
//
// Se mockean los bordes (contexto del portal y portalService): lo que se afirma
// es el contrato de la pantalla, no la red.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'

const BIZ = '77777777-7777-4777-8777-777777777777'

const estado = vi.hoisted(() => ({
  bizLoading: false,
  business: { id: '77777777-7777-4777-8777-777777777777', logo_url: null } as null | { id: string; logo_url: string | null },
  respuesta: { customer: null, error: null } as { customer: null | Record<string, unknown>; error: string | null },
  llamadas: [] as unknown[][],
  setCustomer: vi.fn(),
}))

vi.mock('../../src/portal/contexts/PortalContext', () => ({
  usePortal: () => ({
    business: estado.business,
    bizLoading: estado.bizLoading,
    setCustomer: estado.setCustomer,
    basePath: '/mayorista/clic',
  }),
}))

vi.mock('../../src/portal/services/portalService', () => ({
  loginCustomer: async (...args: unknown[]) => {
    estado.llamadas.push(args)
    return estado.respuesta
  },
}))

vi.mock('../../src/portal/components/WholesaleBrandHeader', () => ({
  WholesaleBrandHeader: () => null,
}))

import { PortalLogin } from '../../src/portal/pages/PortalLogin'

function Ruta() {
  return <div data-testid="ruta">{useLocation().pathname}</div>
}

function montar() {
  return render(
    <MemoryRouter initialEntries={['/mayorista/clic/login']}>
      <Routes>
        <Route path="/mayorista/clic/login" element={<PortalLogin />} />
        <Route path="*" element={<Ruta />} />
      </Routes>
    </MemoryRouter>,
  )
}

function enviar(email: string, password: string) {
  fireEvent.change(document.querySelector('input[type="email"]')!, { target: { value: email } })
  fireEvent.change(document.querySelector('input[autocomplete="current-password"]')!, { target: { value: password } })
  fireEvent.submit(document.querySelector('form')!)
}

beforeEach(() => {
  estado.bizLoading = false
  estado.business = { id: BIZ, logo_url: null }
  estado.respuesta = { customer: null, error: null }
  estado.llamadas = []
  estado.setCustomer.mockReset()
})

describe('PortalLogin sin cuenta demo', () => {
  it('B1. con DEV = true no hay atajo de demo ni cuenta hardcodeada en la pantalla', () => {
    expect(import.meta.env.DEV).toBe(true)
    montar()
    const texto = document.body.textContent ?? ''
    expect(texto).not.toMatch(/demo/i)
    expect(texto).not.toMatch(/Modo Dev/i)
    expect(document.body.innerHTML).not.toMatch(/@clicmayorista/i)
    // Un solo botón de acción: el submit del formulario (el otro es mostrar/ocultar contraseña).
    const botones = [...document.querySelectorAll('button')].map(b => b.getAttribute('type'))
    expect(botones.filter(t => t === 'submit')).toHaveLength(1)
  })

  it('B2. el login usa EXACTAMENTE lo que tipea el usuario y el negocio del portal', async () => {
    estado.respuesta = { customer: { id: 'wc-1', approved: true, suspended: false }, error: null }
    montar()
    enviar('qa@example.test', 'lo-que-tipea')
    await waitFor(() => expect(screen.getByTestId('ruta').textContent).toBe('/mayorista/clic/catalogo'))
    expect(estado.llamadas).toEqual([['qa@example.test', 'lo-que-tipea', BIZ]])
    expect(estado.setCustomer).toHaveBeenCalledTimes(1)
  })

  it('B3. cliente pendiente de aprobación → /pendiente; suspendido → /suspendido', async () => {
    estado.respuesta = { customer: { id: 'wc-1', approved: false, suspended: false }, error: null }
    const { unmount } = montar()
    enviar('qa@example.test', 'x')
    await waitFor(() => expect(screen.getByTestId('ruta').textContent).toBe('/mayorista/clic/pendiente'))
    unmount()

    estado.respuesta = { customer: { id: 'wc-1', approved: true, suspended: true }, error: null }
    montar()
    enviar('qa@example.test', 'x')
    await waitFor(() => expect(screen.getByTestId('ruta').textContent).toBe('/mayorista/clic/suspendido'))
  })

  it('B4. un error del servicio se muestra y no navega', async () => {
    estado.respuesta = { customer: null, error: 'Email o contraseña incorrectos' }
    montar()
    enviar('qa@example.test', 'mala')
    await screen.findByText('Email o contraseña incorrectos')
    expect(screen.queryByTestId('ruta')).toBeNull()
  })

  it('B5. mientras el portal carga, el formulario no envía', () => {
    estado.bizLoading = true
    montar()
    const submit = document.querySelector('button[type="submit"]') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(submit.textContent).toMatch(/Cargando/)
  })
})
