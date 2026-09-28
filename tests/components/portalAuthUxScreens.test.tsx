// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-2D — portal mayorista: PANTALLAS de login y registro.
//
// Se mockean los bordes (portalService, contexto y layout del portal): lo que
// se afirma es el contrato de cada pantalla.
//   U1  sin confirmar → mensaje + «Reenviar correo de confirmación» → enviado
//   U2  reenvío con rate limit → estado propio, sin botón
//   U3  credenciales inválidas → sin oferta de reenvío
//   U4  registro: 7 caracteres, 73 bytes y confirmación distinta no se envían;
//       8 caracteres sí; placeholder canónico
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import type { ReactNode } from 'react'

const BIZ = '77777777-7777-4777-8777-777777777777'

const estado = vi.hoisted(() => ({
  login: { customer: null, error: null } as { customer: null | Record<string, unknown>; error: string | null; reason?: string },
  resend: 'sent' as 'sent' | 'rate_limited' | 'error',
  resendEmails: [] as string[],
  registros: [] as unknown[],
}))

vi.mock('../../src/portal/services/portalService', () => ({
  loginCustomer: async () => estado.login,
  resendWholesaleConfirmation: async (email: string) => {
    estado.resendEmails.push(email)
    return estado.resend
  },
  registerCustomer: async (input: unknown) => {
    estado.registros.push(input)
    return { status: 'pending_confirmation' }
  },
}))

vi.mock('../../src/portal/contexts/PortalContext', () => ({
  usePortal: () => ({
    business: { id: '77777777-7777-4777-8777-777777777777', logo_url: null },
    bizLoading: false,
    setCustomer: () => {},
    basePath: '/mayorista/clic',
    slug: 'clic',
  }),
}))

vi.mock('../../src/portal/components/WholesaleBrandHeader', () => ({ WholesaleBrandHeader: () => null }))

vi.mock('../../src/portal/components/PortalLayout', () => ({
  PT: new Proxy({}, { get: () => '#000' }),
  PortalLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PortalCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PortalButton: ({ children, type = 'button' }: { children: ReactNode; type?: 'button' | 'submit' }) => (
    <button type={type} data-testid={type === 'submit' ? 'portal-submit' : undefined}>{children}</button>
  ),
  PortalInput: ({ label, value, onChange, type = 'text', placeholder }: { label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string }) => (
    <input aria-label={label} type={type} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} />
  ),
}))

import { PortalLogin } from '../../src/portal/pages/PortalLogin'
import { PortalRegister } from '../../src/portal/pages/PortalRegister'

function montarLogin() {
  return render(
    <MemoryRouter initialEntries={['/mayorista/clic/login']}>
      <Routes>
        <Route path="/mayorista/clic/login" element={<PortalLogin />} />
        <Route path="*" element={<div data-testid="otra-ruta" />} />
      </Routes>
    </MemoryRouter>,
  )
}

function enviarLogin(email: string, password: string) {
  fireEvent.change(document.querySelector('input[type="email"]')!, { target: { value: email } })
  fireEvent.change(document.querySelector('input[autocomplete="current-password"]')!, { target: { value: password } })
  fireEvent.submit(document.querySelector('form')!)
}

beforeEach(() => {
  estado.login = { customer: null, error: null }
  estado.resend = 'sent'
  estado.resendEmails = []
  estado.registros = []
})

describe('PRE-BETA-2D · PortalLogin', () => {
  it('U1. sin confirmar → mensaje propio + reenvío al email tipeado', async () => {
    estado.login = { customer: null, error: 'Tu correo todavía no está confirmado. Revisá el email que te enviamos.', reason: 'email_not_confirmed' }
    montarLogin()
    enviarLogin('mayorista-qa@example.test', 'segura-123')
    expect((await screen.findByTestId('portal-login-error')).textContent).toMatch(/todavía no está confirmado/)
    fireEvent.click(screen.getByTestId('portal-login-resend'))
    expect(await screen.findByTestId('portal-login-resend-sent')).toBeTruthy()
    expect(estado.resendEmails).toEqual(['mayorista-qa@example.test'])
    expect(screen.queryByTestId('portal-login-resend')).toBeNull()
  })

  it('U2. reenvío con rate limit → estado propio, sin botón', async () => {
    estado.login = { customer: null, error: 'Tu correo todavía no está confirmado. Revisá el email que te enviamos.', reason: 'email_not_confirmed' }
    estado.resend = 'rate_limited'
    montarLogin()
    enviarLogin('mayorista-qa@example.test', 'segura-123')
    fireEvent.click(await screen.findByTestId('portal-login-resend'))
    expect((await screen.findByTestId('portal-login-resend-limited')).textContent).toMatch(/Esperá unos minutos/)
    expect(screen.queryByTestId('portal-login-resend')).toBeNull()
  })

  it('U2b. reenvío que falla → mensaje propio y se puede reintentar', async () => {
    estado.login = { customer: null, error: 'x', reason: 'email_not_confirmed' }
    estado.resend = 'error'
    montarLogin()
    enviarLogin('mayorista-qa@example.test', 'segura-123')
    fireEvent.click(await screen.findByTestId('portal-login-resend'))
    expect(await screen.findByTestId('portal-login-resend-error')).toBeTruthy()
    expect(screen.getByTestId('portal-login-resend')).toBeTruthy()
  })

  it('U3. credenciales inválidas → sin oferta de reenvío', async () => {
    estado.login = { customer: null, error: 'Email o contraseña incorrectos', reason: 'invalid_credentials' }
    montarLogin()
    enviarLogin('mayorista-qa@example.test', 'mala-123')
    expect((await screen.findByTestId('portal-login-error')).textContent).toBe('Email o contraseña incorrectos')
    expect(screen.queryByTestId('portal-login-resend')).toBeNull()
  })
})

describe('PRE-BETA-2D · PortalRegister', () => {
  function montarRegistro() {
    return render(
      <MemoryRouter initialEntries={['/mayorista/clic/registro']}>
        <Routes>
          <Route path="/mayorista/clic/registro" element={<PortalRegister />} />
          <Route path="*" element={<div data-testid="otra-ruta" />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  function llenar(password: string, confirm = password) {
    fireEvent.change(screen.getByLabelText('Nombre completo'), { target: { value: 'Cliente QA' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'mayorista-qa@example.test' } })
    fireEvent.change(screen.getByLabelText('Contraseña'), { target: { value: password } })
    fireEvent.change(screen.getByLabelText('Repetir contraseña'), { target: { value: confirm } })
    fireEvent.submit(document.querySelector('form')!)
  }

  it('U4. política 8 / 72 bytes / confirmación, y placeholder canónico', async () => {
    montarRegistro()
    expect(screen.getByLabelText('Contraseña').getAttribute('placeholder')).toBe('Mínimo 8 caracteres')

    llenar('1234567')
    expect((await screen.findByTestId('portal-register-error')).textContent).toBe('Usá al menos 8 caracteres.')
    llenar('ñ'.repeat(37))
    await waitFor(() => expect(screen.getByTestId('portal-register-error').textContent).toBe('Usá una contraseña más corta.'))
    llenar('segura-123', 'segura-124')
    await waitFor(() => expect(screen.getByTestId('portal-register-error').textContent).toBe('Las contraseñas no coinciden.'))
    expect(estado.registros).toHaveLength(0)

    llenar('12345678')
    await waitFor(() => expect(estado.registros).toHaveLength(1))
    expect((estado.registros[0] as { businessId: string }).businessId).toBe(BIZ)
  })
})
