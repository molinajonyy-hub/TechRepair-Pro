// ─────────────────────────────────────────────────────────────────────────────
// BETA-GATE-1 · Lote B — recuperación de contraseña, contrato de pantallas.
//
// El borde mockeado es `src/lib/supabase` (auth + rpc). ResetPassword,
// AuthCallback, Login, AuthProvider y `src/lib/passwordRecovery.ts` corren de
// verdad. El flujo contra GoTrue real vive en el E2E
// tests/e2e/m7/password-recovery.spec.ts; acá se fijan los estados y los bordes.
//
//   R1  sesión de recovery marcada        → formulario (nunca el Dashboard)
//   R2  sesión normal sin marca           → «abrí el enlace desde tu correo»
//   R3  sin sesión                        → idem
//   R4  marca de OTRA cuenta              → idem
//   R5  enlace vencido/usado              → estado propio + «Pedir un enlace nuevo»
//   R6  tokens del enlace verificándose   → espera y después formulario
//   R7  tokens que GoTrue rechaza         → «no pudimos validar el enlace»
//   R8  validaciones locales              → no llama a updateUser
//   R9  mostrar/ocultar
//   R10 loading + anti doble envío
//   R11 éxito                             → limpia la marca y sigue a la app
//   R12 same_password                     → mensaje propio, nunca el crudo
//   R13 sesión vencida al guardar         → estado inválido
//   R14 fallo de red al guardar           → error reintentable
//   R15 SIGNED_OUT con el formulario abierto → inválido
//   R16 éxito sin sesión                  → a /login
//   A1  /auth/callback token_hash recovery OK → /reset-password con formulario
//   A2  /auth/callback token_hash recovery rechazado → vencido, no /verificar-email
//   L1  /login?modo=recuperar abre el pedido de enlace
//   L2  200 → mensaje neutro, redirect al callback canónico
//   L3  429 (cuenta existente, pedido repetido) → el MISMO mensaje neutro
//   L4  fallo de red → error reintentable
//
// Sin matchers de jest-dom a propósito: se leen atributos y texto directamente.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { AuthProvider } from '../../src/contexts/AuthContext'
import { ResetPassword } from '../../src/pages/ResetPassword'
import { AuthCallback } from '../../src/pages/AuthCallback'
import { Login } from '../../src/pages/Login'
import {
  captureRecoveryAtBoot,
  completeRecoveryHandoff,
  finishRecovery,
  hasRecoverySession,
  markRecoveryLinkRejected,
  markRecoverySession,
} from '../../src/lib/passwordRecovery'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const OTRO_ID = '22222222-2222-4222-8222-222222222222'

type Listener = (event: string, session: { user: { id: string } } | null) => void

const estado = vi.hoisted(() => ({
  sessionUserId: null as string | null,
  listeners: [] as Array<(event: string, session: unknown) => void>,
  updateUser: null as null | ((args: { password: string }) => Promise<{ data: unknown; error: unknown }>),
  verifyOtp: null as null | (() => Promise<{ data: unknown; error: unknown }>),
  resetPasswordForEmail: null as null | ((email: string, opts: { redirectTo: string }) => Promise<{ data: unknown; error: unknown }>),
  llamadas: [] as string[],
}))

vi.mock('../../src/lib/supabase', () => {
  const session = () => (estado.sessionUserId
    ? { user: { id: estado.sessionUserId, email: 'titular@invalid.test', email_confirmed_at: '2026-01-01T00:00:00Z' } }
    : null)
  return {
    supabase: {
      auth: {
        getSession: async () => ({ data: { session: session() }, error: null }),
        getUser: async () => ({ data: { user: session()?.user ?? null }, error: null }),
        refreshSession: async () => ({ data: { session: session() }, error: null }),
        onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
          estado.listeners.push(cb)
          return { data: { subscription: { unsubscribe: () => { estado.listeners = estado.listeners.filter(l => l !== cb) } } } }
        },
        updateUser: async (args: { password: string }) => {
          estado.llamadas.push('updateUser')
          return estado.updateUser ? estado.updateUser(args) : { data: {}, error: null }
        },
        verifyOtp: async () => {
          estado.llamadas.push('verifyOtp')
          return estado.verifyOtp ? estado.verifyOtp() : { data: {}, error: null }
        },
        resetPasswordForEmail: async (email: string, opts: { redirectTo: string }) => {
          estado.llamadas.push(`resetPasswordForEmail:${opts.redirectTo}`)
          return estado.resetPasswordForEmail ? estado.resetPasswordForEmail(email, opts) : { data: {}, error: null }
        },
        signOut: async () => ({ error: null }),
        resend: async () => ({ data: {}, error: null }),
      },
      rpc: async () => ({ data: null, error: null }),
    },
  }
})

function Sonda() {
  const location = useLocation()
  return <span data-testid="ruta">{location.pathname + location.search}</span>
}

function montar(ruta: string) {
  return render(
    <MemoryRouter initialEntries={[ruta]}>
      <AuthProvider>
        <Sonda />
        <Routes>
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/login" element={<Login />} />
          <Route path="/dashboard" element={<div data-testid="dashboard">DASHBOARD</div>} />
          <Route path="/verificar-email" element={<div data-testid="verificar">VERIFICAR</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

const ruta = () => screen.getByTestId('ruta').textContent
const estadoPantalla = () => screen.getByTestId('reset-password-page').getAttribute('data-estado')

function emitir(event: string, userId: string | null) {
  act(() => {
    for (const l of [...estado.listeners]) (l as Listener)(event, userId ? { user: { id: userId } } : null)
  })
}

async function llenar(password: string, confirm: string) {
  fireEvent.change(await screen.findByTestId('reset-password-new'), { target: { value: password } })
  fireEvent.change(screen.getByTestId('reset-password-confirm'), { target: { value: confirm } })
}

beforeEach(() => {
  finishRecovery()
  window.sessionStorage.clear()
  estado.sessionUserId = null
  estado.listeners = []
  estado.updateUser = null
  estado.verifyOtp = null
  estado.resetPasswordForEmail = null
  estado.llamadas = []
})

describe('BETA-GATE-1 · /reset-password', () => {
  it('R1. sesión de recovery marcada → formulario, sin pasar por el Dashboard', async () => {
    estado.sessionUserId = USER_ID
    markRecoverySession(USER_ID)
    montar('/reset-password')
    await waitFor(() => expect(estadoPantalla()).toBe('formulario'))
    expect(screen.getByTestId('reset-password-new').getAttribute('autocomplete')).toBe('new-password')
    expect(screen.queryByTestId('dashboard')).toBeNull()
    expect(ruta()).toBe('/reset-password')
  })

  it('R2. una sesión normal (sin marca) NO ve el formulario', async () => {
    estado.sessionUserId = USER_ID
    montar('/reset-password')
    await waitFor(() => expect(estadoPantalla()).toBe('invalido:sin_sesion'))
    expect(screen.queryByTestId('reset-password-new')).toBeNull()
  })

  it('R3. sin sesión → inválido', async () => {
    montar('/reset-password')
    await waitFor(() => expect(estadoPantalla()).toBe('invalido:sin_sesion'))
  })

  it('R4. la marca de OTRA cuenta no habilita el formulario', async () => {
    estado.sessionUserId = USER_ID
    markRecoverySession(OTRO_ID)
    montar('/reset-password')
    await waitFor(() => expect(estadoPantalla()).toBe('invalido:sin_sesion'))
  })

  it('R5. enlace vencido/usado → estado propio y «Pedir un enlace nuevo» abre el pedido', async () => {
    estado.sessionUserId = USER_ID
    markRecoverySession(USER_ID) // aun con sesión, el enlace rechazado manda
    markRecoveryLinkRejected()
    montar('/reset-password')
    await waitFor(() => expect(estadoPantalla()).toBe('invalido:vencido'))
    expect(screen.getByTestId('reset-password-invalid').textContent).toMatch(/Venció o ya se usó/)
    fireEvent.click(screen.getByTestId('reset-password-request-new'))
    await waitFor(() => expect(ruta()).toBe('/login?modo=recuperar'))
    expect(await screen.findByTestId('login-forgot-form')).toBeTruthy()
  })

  it('R6. mientras se valida el enlace muestra la espera y después el formulario', async () => {
    captureRecoveryAtBoot(
      { pathname: '/auth/callback', hash: '#access_token=a&refresh_token=r&type=recovery' },
      { state: null, replaceState: () => {} },
      { isPortalHost: false },
    )
    montar('/reset-password')
    expect(estadoPantalla()).toBe('verificando')

    estado.sessionUserId = USER_ID
    await act(async () => {
      await completeRecoveryHandoff({ setSession: async () => ({ data: { session: { user: { id: USER_ID } } }, error: null }) })
    })
    await waitFor(() => expect(estadoPantalla()).toBe('formulario'))
  })

  it('R7. tokens rechazados por GoTrue → «no pudimos validar el enlace»', async () => {
    captureRecoveryAtBoot(
      { pathname: '/auth/callback', hash: '#access_token=a&refresh_token=r&type=recovery' },
      { state: null, replaceState: () => {} },
      { isPortalHost: false },
    )
    montar('/reset-password')
    await act(async () => {
      await completeRecoveryHandoff({ setSession: async () => ({ data: { session: null }, error: { status: 403 } }) })
    })
    await waitFor(() => expect(estadoPantalla()).toBe('invalido:invalido'))
  })

  it('R8. validaciones locales: corta y no coincide, sin llamar a updateUser', async () => {
    estado.sessionUserId = USER_ID
    markRecoverySession(USER_ID)
    montar('/reset-password')

    await llenar('corta', 'corta')
    fireEvent.click(screen.getByTestId('reset-password-submit'))
    expect((await screen.findByTestId('reset-password-new-error')).textContent).toMatch(/al menos 8/)
    expect(screen.getByTestId('reset-password-new').getAttribute('aria-invalid')).toBe('true')

    await llenar('segura-123', 'segura-124')
    fireEvent.click(screen.getByTestId('reset-password-submit'))
    expect((await screen.findByTestId('reset-password-confirm-error')).textContent).toMatch(/no coinciden/)
    expect(estado.llamadas).not.toContain('updateUser')
  })

  it('R9. mostrar/ocultar cambia el tipo del campo', async () => {
    estado.sessionUserId = USER_ID
    markRecoverySession(USER_ID)
    montar('/reset-password')
    const campo = await screen.findByTestId('reset-password-new')
    expect(campo.getAttribute('type')).toBe('password')
    fireEvent.click(screen.getByTestId('reset-password-toggle-new'))
    expect(campo.getAttribute('type')).toBe('text')
    expect(screen.getByTestId('reset-password-toggle-new').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('reset-password-confirm').getAttribute('type')).toBe('password')
  })

  it('R10. guardando: botón deshabilitado y un solo updateUser aunque se envíe dos veces', async () => {
    estado.sessionUserId = USER_ID
    markRecoverySession(USER_ID)
    let liberar: (v: { data: unknown; error: unknown }) => void = () => {}
    estado.updateUser = () => new Promise(res => { liberar = res })
    montar('/reset-password')

    await llenar('segura-123', 'segura-123')
    fireEvent.click(screen.getByTestId('reset-password-submit'))
    fireEvent.submit(screen.getByTestId('reset-password-submit').closest('form')!)
    await waitFor(() => expect(screen.getByTestId('reset-password-submit').hasAttribute('disabled')).toBe(true))
    expect(screen.getByTestId('reset-password-submit').textContent).toMatch(/Guardando/)
    expect(estado.llamadas.filter(c => c === 'updateUser')).toHaveLength(1)

    await act(async () => { liberar({ data: {}, error: null }) })
    await waitFor(() => expect(estadoPantalla()).toBe('listo'))
  })

  it('R11. éxito: limpia la marca, muestra la confirmación y sigue a la app', async () => {
    estado.sessionUserId = USER_ID
    markRecoverySession(USER_ID)
    montar('/reset-password')

    await llenar('segura-123', 'segura-123')
    fireEvent.click(screen.getByTestId('reset-password-submit'))
    await waitFor(() => expect(estadoPantalla()).toBe('listo'))
    expect(hasRecoverySession(USER_ID)).toBe(false)
    expect(window.sessionStorage.length).toBe(0)
    fireEvent.click(screen.getByTestId('reset-password-continue'))
    await waitFor(() => expect(ruta()).toBe('/dashboard'))
  })

  it('R12. same_password → mensaje propio, nunca el texto crudo del servidor', async () => {
    estado.sessionUserId = USER_ID
    markRecoverySession(USER_ID)
    estado.updateUser = async () => ({ data: null, error: { code: 'same_password', status: 422, message: 'New password should be different from the old password.' } })
    montar('/reset-password')

    await llenar('segura-123', 'segura-123')
    fireEvent.click(screen.getByTestId('reset-password-submit'))
    const msg = await screen.findByTestId('reset-password-new-error')
    expect(msg.textContent).toMatch(/distinta de la anterior/)
    expect(document.body.textContent).not.toContain('should be different')
    expect(estadoPantalla()).toBe('formulario')
  })

  it('R13. sesión vencida al guardar → inválido', async () => {
    estado.sessionUserId = USER_ID
    markRecoverySession(USER_ID)
    estado.updateUser = async () => ({ data: null, error: { name: 'AuthSessionMissingError', status: 400, message: 'Auth session missing!' } })
    montar('/reset-password')

    await llenar('segura-123', 'segura-123')
    fireEvent.click(screen.getByTestId('reset-password-submit'))
    await waitFor(() => expect(estadoPantalla()).toBe('invalido:invalido'))
  })

  it('R14. fallo de red al guardar → error reintentable y el formulario sigue', async () => {
    estado.sessionUserId = USER_ID
    markRecoverySession(USER_ID)
    estado.updateUser = async () => { throw new TypeError('Failed to fetch') }
    montar('/reset-password')

    await llenar('segura-123', 'segura-123')
    fireEvent.click(screen.getByTestId('reset-password-submit'))
    expect((await screen.findByTestId('reset-password-error')).textContent).toMatch(/Revisá tu conexión/)
    expect(screen.getByTestId('reset-password-submit').hasAttribute('disabled')).toBe(false)
    expect(estadoPantalla()).toBe('formulario')
  })

  it('R15. si la sesión se cierra con el formulario abierto → inválido', async () => {
    estado.sessionUserId = USER_ID
    markRecoverySession(USER_ID)
    montar('/reset-password')
    await waitFor(() => expect(estadoPantalla()).toBe('formulario'))

    estado.sessionUserId = null
    emitir('SIGNED_OUT', null)
    await waitFor(() => expect(estadoPantalla()).toBe('invalido:sin_sesion'))
  })

  it('R16. éxito sin sesión posterior → a /login', async () => {
    estado.sessionUserId = USER_ID
    markRecoverySession(USER_ID)
    estado.updateUser = async () => { estado.sessionUserId = null; return { data: {}, error: null } }
    montar('/reset-password')

    await llenar('segura-123', 'segura-123')
    fireEvent.click(screen.getByTestId('reset-password-submit'))
    await waitFor(() => expect(estadoPantalla()).toBe('listo'))
    expect(screen.getByTestId('reset-password-continue').textContent).toMatch(/iniciar sesión/)
    // Sin sesión, el AuthProvider también se entera (así llega en la app real).
    emitir('SIGNED_OUT', null)
    fireEvent.click(screen.getByTestId('reset-password-continue'))
    await waitFor(() => expect(ruta()).toBe('/login'))
  })
})

describe('BETA-GATE-1 · /auth/callback con token_hash de recovery', () => {
  it('A1. verifyOtp OK → /reset-password con formulario, sin Dashboard', async () => {
    window.history.replaceState({}, '', '/auth/callback?token_hash=sintetico&type=recovery')
    estado.verifyOtp = async () => {
      estado.sessionUserId = USER_ID
      return { data: { user: { id: USER_ID }, session: { user: { id: USER_ID } } }, error: null }
    }
    montar('/auth/callback?token_hash=sintetico&type=recovery')

    await waitFor(() => expect(ruta()).toBe('/reset-password'))
    await waitFor(() => expect(estadoPantalla()).toBe('formulario'))
    expect(window.location.search).toBe('')
    expect(screen.queryByTestId('dashboard')).toBeNull()
  })

  it('A2. verifyOtp rechazado → enlace vencido en /reset-password, no /verificar-email', async () => {
    window.history.replaceState({}, '', '/auth/callback?token_hash=usado&type=recovery')
    estado.verifyOtp = async () => ({ data: { user: null, session: null }, error: { message: 'Token has expired or is invalid', status: 403 } })
    montar('/auth/callback?token_hash=usado&type=recovery')

    await waitFor(() => expect(ruta()).toBe('/reset-password'))
    await waitFor(() => expect(estadoPantalla()).toBe('invalido:vencido'))
    expect(screen.queryByTestId('verificar')).toBeNull()
  })
})

describe('BETA-GATE-1 · Login «¿Olvidaste tu contraseña?»', () => {
  const NEUTRO = /Si existe una cuenta asociada a ese correo, te enviamos instrucciones/

  async function pedir(email: string) {
    fireEvent.change(await screen.findByTestId('login-forgot-email'), { target: { value: email } })
    fireEvent.click(screen.getByTestId('login-forgot-submit'))
  }

  it('L1. /login?modo=recuperar abre directo el pedido de enlace', async () => {
    montar('/login?modo=recuperar')
    expect(await screen.findByTestId('login-forgot-form')).toBeTruthy()
  })

  it('L1b. el link «¿Olvidaste tu contraseña?» abre el mismo formulario', async () => {
    montar('/login')
    fireEvent.click(await screen.findByTestId('login-forgot-link'))
    expect(await screen.findByTestId('login-forgot-form')).toBeTruthy()
  })

  it('L2. 200 → mensaje neutro, y el enlace vuelve al callback canónico', async () => {
    montar('/login?modo=recuperar')
    await pedir('titular@invalid.test')
    expect((await screen.findByTestId('login-success')).textContent).toMatch(NEUTRO)
    expect(estado.llamadas.some(c => /^resetPasswordForEmail:https?:\/\/[^/]+\/auth\/callback$/.test(c))).toBe(true)
  })

  it('L3. 429 de un pedido repetido → el MISMO mensaje neutro, sin el texto del servidor', async () => {
    estado.resetPasswordForEmail = async () => ({
      data: null,
      error: { name: 'AuthApiError', status: 429, code: 'over_email_send_rate_limit', message: 'For security purposes, you can only request this after 42 seconds.' },
    })
    montar('/login?modo=recuperar')
    await pedir('titular@invalid.test')
    expect((await screen.findByTestId('login-success')).textContent).toMatch(NEUTRO)
    expect(document.body.textContent).not.toContain('security purposes')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('L5. con sesión, /login sigue mandando a la app (el modo recuperar es la única excepción)', async () => {
    estado.sessionUserId = USER_ID
    montar('/login')
    await waitFor(() => expect(ruta()).toBe('/dashboard'))
  })

  it('L4. fallo de red → error reintentable (no dice que se envió)', async () => {
    estado.resetPasswordForEmail = async () => ({ data: null, error: { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' } })
    montar('/login?modo=recuperar')
    await pedir('titular@invalid.test')
    expect((await screen.findByRole('alert')).textContent).toMatch(/Revisá tu conexión/)
    expect(screen.queryByTestId('login-success')).toBeNull()
  })
})
