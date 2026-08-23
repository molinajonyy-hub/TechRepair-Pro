// ─────────────────────────────────────────────────────────────────────────────
// EMAIL VERIFICATION P0 — contrato del frontend
//
// Contraparte de tests/sql/email_verification_provisioning.test.sql. Allá se
// verifica que el servidor no provisione hasta confirmar; acá, que la app
// TAMPOCO deje operar hasta entonces, y que el camino de vuelta funcione.
//
//   A. signup sin sesión                 -> /verificar-email (no un error)
//   B. no confirmado + URL interna       -> /verificar-email (anti-bypass)
//   C. confirmado                        -> entra al producto
//   D. Google (confirmado)               -> NO ve la pantalla de verificación
//   E. resend OK
//   F. resend 429                        -> mensaje de rate limit, no error
//   G. «Ya confirmé» con null            -> permanece en la pantalla
//   H. «Ya confirmé» confirmado          -> continúa
//   I. callback con token_hash válido    -> verifyOtp y sigue
//   J. callback con token_hash inválido  -> estado recuperable
//   K. callback con link YA USADO        -> continúa (no es un error)
//   L. callback OAuth ?code              -> sigue funcionando, sin verifyOtp
//   M. sin redirect externo
//   N. sin loop entre el guard y la pantalla
//
// El borde mockeado es `src/lib/supabase`. AuthContext, ProtectedRoute,
// VerifyEmail y AuthCallback corren de verdad: son el código bajo prueba.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { AuthProvider } from '../../src/contexts/AuthContext'
import { ProtectedRoute } from '../../src/components/auth/ProtectedRoute'
import { RequireEmailConfirmed } from '../../src/components/auth/RequireEmailConfirmed'
import { VerifyEmail } from '../../src/pages/VerifyEmail'
import { AuthCallback } from '../../src/pages/AuthCallback'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const BIZ_ID = '33333333-3333-4333-8333-333333333333'

type FakeUser = { id: string; email: string; email_confirmed_at: string | null }

const estado = vi.hoisted(() => ({
  /** Usuario de la sesión guardada. `null` = sin sesión. */
  sessionUser: null as null | { id: string; email: string; email_confirmed_at: string | null },
  /** Lo que devuelve `auth.getUser()` — puede diferir de la sesión guardada. */
  serverUser: null as null | { id: string; email: string; email_confirmed_at: string | null },
  profile: null as unknown,
  resendError: null as null | { message: string; status?: number },
  verifyOtpError: null as null | { message: string },
  llamadas: [] as string[],
}))

const perfil = {
  id: USER_ID,
  user_id: USER_ID,
  business_id: BIZ_ID,
  role: 'owner',
  is_active: true,
  full_name: 'Titular',
  email: 'titular@invalid.test',
  phone: null,
  permissions: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: estado.sessionUser ? { user: estado.sessionUser } : null },
        error: null,
      }),
      getUser: async () => {
        estado.llamadas.push('getUser')
        return { data: { user: estado.serverUser }, error: estado.serverUser ? null : { message: 'no session' } }
      },
      refreshSession: async () => {
        estado.llamadas.push('refreshSession')
        return { data: { session: estado.serverUser ? { user: estado.serverUser } : null }, error: null }
      },
      resend: async () => {
        estado.llamadas.push('resend')
        return { data: {}, error: estado.resendError }
      },
      verifyOtp: async () => {
        estado.llamadas.push('verifyOtp')
        return { data: {}, error: estado.verifyOtpError }
      },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signOut: async () => {
        estado.llamadas.push('signOut')
        estado.sessionUser = null
        return { error: null }
      },
    },
    rpc: async (nombre: string) => {
      estado.llamadas.push(nombre)
      if (nombre === 'get_my_profile') return { data: estado.profile, error: null }
      return { data: null, error: null }
    },
  },
}))

/** Muestra la ruta activa: es como se afirma «a dónde fue a parar». */
function Sonda() {
  const location = useLocation()
  return <span data-testid="ruta">{location.pathname}</span>
}

function Dashboard() {
  return <div data-testid="dashboard">DASHBOARD</div>
}

function Onboarding() {
  return <div data-testid="onboarding">ONBOARDING</div>
}

function Login() {
  return <div data-testid="login">LOGIN</div>
}

const confirmado = (): FakeUser => ({
  id: USER_ID,
  email: 'titular@invalid.test',
  email_confirmed_at: '2026-08-23T10:00:00Z',
})

const sinConfirmar = (): FakeUser => ({
  id: USER_ID,
  email: 'titular@invalid.test',
  email_confirmed_at: null,
})

/** App mínima con las rutas reales que participan del contrato. */
function montarApp(rutaInicial: string) {
  return render(
    <MemoryRouter initialEntries={[rutaInicial]}>
      <AuthProvider>
        <Sonda />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/verificar-email" element={<VerifyEmail />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route
            path="/onboarding"
            element={<RequireEmailConfirmed><Onboarding /></RequireEmailConfirmed>}
          />
          <Route element={<ProtectedRoute />}>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/inventory" element={<div data-testid="inventory">INVENTARIO</div>} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

const rutaActual = () => screen.getByTestId('ruta').textContent

beforeEach(() => {
  estado.sessionUser = null
  estado.serverUser = null
  estado.profile = [perfil]
  estado.resendError = null
  estado.verifyOtpError = null
  estado.llamadas = []
  window.localStorage.clear()
  window.sessionStorage.clear()
  window.history.replaceState({}, '', '/')
})

describe('EMAIL VERIFICATION P0 — guard central', () => {
  it('B. sin confirmar, una URL interna NO entra: va a /verificar-email', async () => {
    estado.sessionUser = sinConfirmar()

    montarApp('/inventory')

    await waitFor(() => expect(rutaActual()).toBe('/verificar-email'))
    expect(screen.queryByTestId('inventory')).toBeNull()
  })

  it('B2. el bypass por URL a /onboarding también está cerrado', async () => {
    // /onboarding vive FUERA de ProtectedRoute: sin el wrapper, escribirla a
    // mano dejaba a un usuario sin confirmar creando su negocio.
    estado.sessionUser = sinConfirmar()

    montarApp('/onboarding')

    await waitFor(() => expect(rutaActual()).toBe('/verificar-email'))
    expect(screen.queryByTestId('onboarding')).toBeNull()
  })

  it('C. confirmado y con perfil, entra al producto', async () => {
    estado.sessionUser = confirmado()

    montarApp('/dashboard')

    await waitFor(() => expect(screen.getByTestId('dashboard')).toBeInTheDocument())
    expect(rutaActual()).toBe('/dashboard')
  })

  it('D. Google llega confirmado y NO ve la pantalla de verificación', async () => {
    // Google devuelve el usuario ya confirmado vía GoTrue. No hay ninguna rama
    // `provider === google` en el código: entra por la misma señal que todos.
    estado.sessionUser = {
      id: USER_ID,
      email: 'google@invalid.test',
      email_confirmed_at: '2026-08-23T09:00:00Z',
    }

    montarApp('/dashboard')

    await waitFor(() => expect(screen.getByTestId('dashboard')).toBeInTheDocument())
    expect(screen.queryByTestId('verify-email-page')).toBeNull()
  })

  it('sin sesión sigue yendo a /login, no a /verificar-email', async () => {
    estado.sessionUser = null

    montarApp('/dashboard')

    await waitFor(() => expect(rutaActual()).toBe('/login'))
  })

  it('N. no hay loop: el guard manda a la pantalla y la pantalla no rebota', async () => {
    estado.sessionUser = sinConfirmar()

    montarApp('/dashboard')

    await waitFor(() => expect(rutaActual()).toBe('/verificar-email'))
    // Margen para que un rebote se manifieste.
    await act(async () => { await new Promise(r => setTimeout(r, 120)) })
    expect(rutaActual()).toBe('/verificar-email')
    expect(screen.getByTestId('verify-email-page')).toBeInTheDocument()
  })

  it('N2. sin confirmar NO se piden RPCs de perfil', async () => {
    // Sin provisioning server-side, get_my_profile daría 0 filas y dispararía
    // un link_profile_to_auth_user inútil en cada carga, dejando además un
    // profileError que manda a diagnosticar al lugar equivocado.
    estado.sessionUser = sinConfirmar()

    montarApp('/dashboard')

    await waitFor(() => expect(rutaActual()).toBe('/verificar-email'))
    expect(estado.llamadas).not.toContain('get_my_profile')
    expect(estado.llamadas).not.toContain('link_profile_to_auth_user')
  })
})

describe('EMAIL VERIFICATION P0 — pantalla /verificar-email', () => {
  it('A. tras el signup sin sesión, muestra el estado pendiente y el email redactado', async () => {
    estado.sessionUser = sinConfirmar()

    montarApp('/verificar-email')

    await waitFor(() => expect(screen.getByTestId('verify-email-page')).toBeInTheDocument())
    expect(screen.getByTestId('verify-email-estado')).toHaveAttribute(
      'data-estado', 'SIGNUP_SUBMITTED_UNCONFIRMED',
    )
    // El correo no se muestra entero.
    const mostrado = screen.getByTestId('verify-email-address').textContent ?? ''
    expect(mostrado).not.toBe('titular@invalid.test')
    expect(mostrado).toContain('@invalid.test')
    expect(mostrado).toContain('•')
  })

  // ── El caso PRINCIPAL: signup con Confirm Email ON no deja sesión ─────────
  //
  // `signUp` devuelve `session: null`, así que `user` es null. Si la pantalla
  // exigiera sesión, rebotaría a /login y el usuario quedaría sin forma de
  // reenviarse el correo: justo el callejón sin salida que esta P0 elimina.

  it('A2. sin sesión pero con registro pendiente, la pantalla FUNCIONA', async () => {
    estado.sessionUser = null
    window.sessionStorage.setItem('trp_pending_confirmation_email', 'nuevo@invalid.test')

    montarApp('/verificar-email')

    await waitFor(() => expect(screen.getByTestId('verify-email-page')).toBeInTheDocument())
    expect(rutaActual()).toBe('/verificar-email')
    // Y sabe a quién reenviarle.
    expect(screen.getByTestId('verify-email-address').textContent).toContain('@invalid.test')
    expect(screen.getByTestId('verify-email-reenviar')).not.toBeDisabled()
  })

  it('A3. sin sesión, el reenvío usa el email pendiente', async () => {
    estado.sessionUser = null
    window.sessionStorage.setItem('trp_pending_confirmation_email', 'nuevo@invalid.test')

    montarApp('/verificar-email')
    await waitFor(() => expect(screen.getByTestId('verify-email-page')).toBeInTheDocument())

    await userEvent.click(screen.getByTestId('verify-email-reenviar'))

    await waitFor(() => {
      expect(screen.getByTestId('verify-email-estado')).toHaveAttribute('data-estado', 'RESEND_SUCCESS')
    })
    expect(estado.llamadas.filter(n => n === 'resend')).toHaveLength(1)
  })

  it('A4. sin sesión NI registro pendiente, la URL no es alcanzable', async () => {
    estado.sessionUser = null

    montarApp('/verificar-email')

    await waitFor(() => expect(rutaActual()).toBe('/login'))
  })

  it('A5. sin sesión, «Ya confirmé» deriva al login (confirmó en otro dispositivo)', async () => {
    estado.sessionUser = null
    window.sessionStorage.setItem('trp_pending_confirmation_email', 'nuevo@invalid.test')

    montarApp('/verificar-email')
    await waitFor(() => expect(screen.getByTestId('verify-email-page')).toBeInTheDocument())

    await userEvent.click(screen.getByTestId('verify-email-ya-confirme'))

    await waitFor(() => expect(rutaActual()).toBe('/login'))
    // Y el rastro del registro pendiente se limpia.
    expect(window.sessionStorage.getItem('trp_pending_confirmation_email')).toBeNull()
  })

  it('E. reenviar con éxito muestra confirmación y arranca el cooldown', async () => {
    estado.sessionUser = sinConfirmar()
    montarApp('/verificar-email')
    await waitFor(() => expect(screen.getByTestId('verify-email-page')).toBeInTheDocument())

    await userEvent.click(screen.getByTestId('verify-email-reenviar'))

    await waitFor(() => {
      expect(screen.getByTestId('verify-email-estado')).toHaveAttribute('data-estado', 'RESEND_SUCCESS')
    })
    expect(estado.llamadas.filter(n => n === 'resend')).toHaveLength(1)
    // El botón queda deshabilitado durante el cooldown.
    expect(screen.getByTestId('verify-email-reenviar')).toBeDisabled()
  })

  it('F. un 429 se muestra como rate limit, no como error genérico', async () => {
    estado.sessionUser = sinConfirmar()
    estado.resendError = { message: 'Email rate limit exceeded', status: 429 }
    montarApp('/verificar-email')
    await waitFor(() => expect(screen.getByTestId('verify-email-page')).toBeInTheDocument())

    await userEvent.click(screen.getByTestId('verify-email-reenviar'))

    await waitFor(() => {
      expect(screen.getByTestId('verify-email-estado')).toHaveAttribute('data-estado', 'RESEND_RATE_LIMITED')
    })
    // Y no se filtra el texto crudo de Supabase.
    expect(screen.queryByText(/rate limit exceeded/i)).toBeNull()
  })

  it('G. «Ya confirmé» con el correo aún sin confirmar: PERMANECE en la pantalla', async () => {
    estado.sessionUser = sinConfirmar()
    estado.serverUser = sinConfirmar()   // el servidor tampoco lo ve confirmado
    montarApp('/verificar-email')
    await waitFor(() => expect(screen.getByTestId('verify-email-page')).toBeInTheDocument())

    await userEvent.click(screen.getByTestId('verify-email-ya-confirme'))

    await waitFor(() => expect(estado.llamadas).toContain('getUser'))
    await act(async () => { await new Promise(r => setTimeout(r, 80)) })

    expect(rutaActual()).toBe('/verificar-email')
    expect(screen.getByTestId('verify-email-page')).toBeInTheDocument()
  })

  it('H. «Ya confirmé» ya confirmado: consulta el servidor y continúa', async () => {
    estado.sessionUser = sinConfirmar()
    // El usuario confirmó en otro dispositivo: la sesión local sigue vieja,
    // pero el servidor ya lo sabe. Ese delta es el punto del botón.
    estado.serverUser = confirmado()
    montarApp('/verificar-email')
    await waitFor(() => expect(screen.getByTestId('verify-email-page')).toBeInTheDocument())

    await userEvent.click(screen.getByTestId('verify-email-ya-confirme'))

    await waitFor(() => expect(rutaActual()).toBe('/dashboard'))
    // La decisión se tomó contra el servidor, no con una bandera local.
    expect(estado.llamadas).toContain('getUser')
  })

  it('G2. el estado de confirmado NO sale de localStorage', async () => {
    estado.sessionUser = sinConfirmar()
    estado.serverUser = sinConfirmar()
    // Un atacante (o un caché viejo) escribe la bandera a mano.
    window.localStorage.setItem('email_confirmed', 'true')
    window.localStorage.setItem(`trp_profile_${USER_ID}`, JSON.stringify(perfil))

    montarApp('/dashboard')

    await waitFor(() => expect(rutaActual()).toBe('/verificar-email'))
  })
})

describe('EMAIL VERIFICATION P0 — /auth/callback', () => {
  it('I. token_hash válido: verifica el OTP y sigue al producto', async () => {
    window.history.replaceState({}, '', '/auth/callback?token_hash=abc123&type=signup')
    // Tras verificar, la sesión ya está confirmada.
    estado.sessionUser = confirmado()

    montarApp('/auth/callback?token_hash=abc123&type=signup')

    await waitFor(() => expect(estado.llamadas).toContain('verifyOtp'))
    await waitFor(() => expect(rutaActual()).toBe('/dashboard'))
  })

  it('I2. el token_hash se saca de la URL para que no quede en el historial', async () => {
    window.history.replaceState({}, '', '/auth/callback?token_hash=secreto&type=signup')
    estado.sessionUser = confirmado()

    montarApp('/auth/callback?token_hash=secreto&type=signup')

    await waitFor(() => expect(estado.llamadas).toContain('verifyOtp'))
    expect(window.location.search).toBe('')
    expect(window.location.href).not.toContain('secreto')
  })

  it('J. token_hash inválido con sesión sin confirmar: estado recuperable', async () => {
    window.history.replaceState({}, '', '/auth/callback?token_hash=vencido&type=signup')
    estado.verifyOtpError = { message: 'Token has expired or is invalid' }
    estado.sessionUser = sinConfirmar()
    estado.serverUser = sinConfirmar()

    montarApp('/auth/callback?token_hash=vencido&type=signup')

    await waitFor(() => expect(rutaActual()).toBe('/verificar-email'))
    await waitFor(() => {
      expect(screen.getByTestId('verify-email-estado'))
        .toHaveAttribute('data-estado', 'LINK_EXPIRED_OR_INVALID')
    })
  })

  it('K. link YA USADO pero cuenta confirmada: continúa, no es un error', async () => {
    // Pasa seguido: doble click en el correo, o un cliente de mail que
    // pre-visita los links. El estado real manda, no el error del verifyOtp.
    window.history.replaceState({}, '', '/auth/callback?token_hash=usado&type=signup')
    estado.verifyOtpError = { message: 'Token has expired or is invalid' }
    estado.sessionUser = confirmado()
    estado.serverUser = confirmado()

    montarApp('/auth/callback?token_hash=usado&type=signup')

    await waitFor(() => expect(rutaActual()).toBe('/dashboard'))
    expect(screen.queryByTestId('verify-email-page')).toBeNull()
  })

  it('L. el camino OAuth ?code sigue intacto y NO llama a verifyOtp', async () => {
    window.history.replaceState({}, '', '/auth/callback?code=pkce-code')
    estado.sessionUser = confirmado()

    montarApp('/auth/callback?code=pkce-code')

    await waitFor(() => expect(rutaActual()).toBe('/dashboard'))
    expect(estado.llamadas).not.toContain('verifyOtp')
  })

  it('M. un post_login_redirect externo NO se sigue', async () => {
    window.history.replaceState({}, '', '/auth/callback?code=pkce-code')
    estado.sessionUser = confirmado()
    window.sessionStorage.setItem('post_login_redirect', '//evil.com/pwned')

    montarApp('/auth/callback?code=pkce-code')

    await waitFor(() => expect(rutaActual()).toBe('/dashboard'))
    expect(rutaActual()).not.toContain('evil.com')
  })

  it('M2. un destino interno legítimo SÍ se respeta', async () => {
    window.history.replaceState({}, '', '/auth/callback?code=pkce-code')
    estado.sessionUser = confirmado()
    window.sessionStorage.setItem('post_login_redirect', '/inventory')

    montarApp('/auth/callback?code=pkce-code')

    await waitFor(() => expect(rutaActual()).toBe('/inventory'))
  })

  it('un type desconocido no se manda a verifyOtp', async () => {
    window.history.replaceState({}, '', '/auth/callback?token_hash=x&type=inventado')
    estado.sessionUser = sinConfirmar()

    montarApp('/auth/callback?token_hash=x&type=inventado')

    await waitFor(() => expect(rutaActual()).toBe('/verificar-email'))
    expect(estado.llamadas).not.toContain('verifyOtp')
  })
})
