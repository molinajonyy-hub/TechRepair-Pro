// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-2D — Auth UX hardening, contrato de pantallas.
//
// El borde mockeado es `src/lib/supabase`. Login, AuthCallback, VerifyEmail y
// AuthProvider corren de verdad. Los errores son sintéticos con la forma real
// de supabase-js/GoTrue; lo que se afirma es que el texto del servidor (o de la
// URL) NUNCA aparece en pantalla.
//
//   L1  ?modo=registro abre «Crear cuenta»; /login abre «Iniciar sesión»
//   L2  registro: 7 caracteres → rechazo del formulario, sin signUp
//   L3  registro: 73 bytes → rechazo
//   L4  registro: confirmación distinta → rechazo
//   L5  registro: 8 caracteres → signUp → /verificar-email
//   L6  weak_password (Leaked Password Protection) → copy propio
//   L6b cuenta existente → copy neutro (no confirma que la cuenta exista)
//   L7  429 del alta → copy propio, nunca «Email rate limit exceeded»
//   L8  error desconocido → genérico, sin texto de GoTrue
//   L9  login: una contraseña vieja de 6 caracteres igual se intenta
//   L10 login sin confirmar → mensaje + reenvío
//   L11 ?error_description arbitrario → jamás reflejado
//   L12 ?error=access_denied (Google cancelado) → copy conocido
//   L13 ?motivo=enlace_vencido → pantalla neutra; motivo desconocido → nada
//   L14 falla al abrir Google → copy propio
//   L15 plan de la landing → post_login_redirect + localStorage (otra pestaña)
//   L16 «olvidé mi contraseña» deja la evidencia local (sólo la hora)
//   C1  /auth/callback con error_description arbitrario → jamás reflejado
//   C2  /auth/callback access_denied → copy conocido
//   V1  /verificar-email: reenvío fallido → estado propio + soporte canónico
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { AuthProvider, rememberPendingConfirmationEmail } from '../../src/contexts/AuthContext'
import { Login } from '../../src/pages/Login'
import { AuthCallback } from '../../src/pages/AuthCallback'
import { VerifyEmail } from '../../src/pages/VerifyEmail'
import { COMPROMISED_PASSWORD_MESSAGE } from '../../src/lib/passwordPolicy'
import { GOOGLE_START_ERROR_MESSAGE } from '../../src/lib/authErrors'
import { RECOVERY_REQUEST_MARKER_KEY } from '../../src/lib/passwordRecovery'
import { CONTACTO_SOPORTE } from '../../src/config/contacto'

const estado = vi.hoisted(() => ({
  signUpError: null as unknown,
  signInError: null as unknown,
  oauthError: null as unknown,
  resendError: null as unknown,
  llamadas: [] as string[],
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      getUser: async () => ({ data: { user: null }, error: { message: 'no session' } }),
      refreshSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signUp: async () => {
        estado.llamadas.push('signUp')
        return estado.signUpError
          ? { data: { user: null, session: null }, error: estado.signUpError }
          : { data: { user: { id: 'u-1' }, session: null }, error: null }
      },
      signInWithPassword: async () => {
        estado.llamadas.push('signInWithPassword')
        return estado.signInError
          ? { data: { user: null, session: null }, error: estado.signInError }
          : { data: { user: { id: 'u-1' }, session: null }, error: null }
      },
      signInWithOAuth: async () => {
        estado.llamadas.push('signInWithOAuth')
        return { data: {}, error: estado.oauthError }
      },
      resend: async () => {
        estado.llamadas.push('resend')
        return { data: {}, error: estado.resendError }
      },
      resetPasswordForEmail: async () => {
        estado.llamadas.push('resetPasswordForEmail')
        return { data: {}, error: null }
      },
      verifyOtp: async () => ({ data: {}, error: null }),
      signOut: async () => ({ error: null }),
    },
    rpc: async () => ({ data: null, error: null }),
  },
}))

/** La ruta va en un atributo: si fuera texto, la URL atacante «aparecería» en la página. */
function Sonda() {
  const l = useLocation()
  return <span data-testid="ruta" data-ruta={l.pathname + l.search} />
}

function montar(ruta: string) {
  return render(
    <MemoryRouter initialEntries={[ruta]}>
      <AuthProvider>
        <Sonda />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/verificar-email" element={<VerifyEmail />} />
          <Route path="/dashboard" element={<div data-testid="dashboard">DASHBOARD</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

const ruta = () => screen.getByTestId('ruta').getAttribute('data-ruta')
const texto = () => document.body.textContent ?? ''

async function registrar(password: string, confirm = password) {
  fireEvent.change(await screen.findByTestId('login-email'), { target: { value: 'qa@example.test' } })
  fireEvent.change(screen.getByTestId('login-password'), { target: { value: password } })
  fireEvent.change(screen.getByTestId('login-confirm-password'), { target: { value: confirm } })
  fireEvent.click(screen.getByTestId('login-submit'))
}

async function loguear(password: string) {
  fireEvent.change(await screen.findByTestId('login-email'), { target: { value: 'qa@example.test' } })
  fireEvent.change(screen.getByTestId('login-password'), { target: { value: password } })
  fireEvent.click(screen.getByTestId('login-submit'))
}

beforeEach(() => {
  estado.signUpError = null
  estado.signInError = null
  estado.oauthError = null
  estado.resendError = null
  estado.llamadas = []
  window.localStorage.clear()
  window.sessionStorage.clear()
  window.history.replaceState({}, '', '/')
})

describe('PRE-BETA-2D · Login — registro', () => {
  it('L1. ?modo=registro abre «Crear cuenta»; /login abre «Iniciar sesión»', async () => {
    const { unmount } = montar('/login?modo=registro')
    expect(await screen.findByTestId('login-confirm-password')).toBeTruthy()
    expect(screen.getByTestId('login-password').getAttribute('placeholder')).toBe('Mínimo 8 caracteres')
    unmount()
    montar('/login')
    await screen.findByTestId('login-email')
    expect(screen.queryByTestId('login-confirm-password')).toBeNull()
  })

  it('L2. 7 caracteres: el formulario lo rechaza y no llama a signUp', async () => {
    montar('/login?modo=registro')
    await registrar('1234567')
    expect(await screen.findByText('Usá al menos 8 caracteres.')).toBeTruthy()
    expect(estado.llamadas).not.toContain('signUp')
  })

  it('L3. más de 72 bytes: rechazo, sin signUp', async () => {
    montar('/login?modo=registro')
    await registrar('ñ'.repeat(37))
    expect(await screen.findByText('Usá una contraseña más corta.')).toBeTruthy()
    expect(estado.llamadas).not.toContain('signUp')
  })

  it('L4. confirmación distinta: rechazo, sin signUp', async () => {
    montar('/login?modo=registro')
    await registrar('segura-123', 'segura-124')
    expect(await screen.findByText('Las contraseñas no coinciden.')).toBeTruthy()
    expect(estado.llamadas).not.toContain('signUp')
  })

  it('L5. 8 caracteres: signUp y a /verificar-email', async () => {
    montar('/login?modo=registro')
    await registrar('12345678')
    await waitFor(() => expect(ruta()).toBe('/verificar-email'))
    expect(estado.llamadas).toContain('signUp')
  })

  it('L6. weak_password (contraseña filtrada) → copy propio', async () => {
    estado.signUpError = { name: 'AuthWeakPasswordError', code: 'weak_password', status: 422, reasons: ['pwned'], message: 'Password is known to be weak and easy to guess, please choose a different one.' }
    montar('/login?modo=registro')
    await registrar('segura-123')
    expect((await screen.findByTestId('login-error')).textContent).toContain(COMPROMISED_PASSWORD_MESSAGE)
    expect(texto()).not.toMatch(/known to be weak/i)
  })

  it('L6b. cuenta existente → copy neutro que NO confirma que la cuenta exista', async () => {
    estado.signUpError = { name: 'AuthApiError', status: 422, code: 'user_already_exists', message: 'User already registered' }
    montar('/login?modo=registro')
    await registrar('segura-123')
    const alerta = (await screen.findByTestId('login-error')).textContent ?? ''
    expect(alerta).toContain('No pudimos completar el registro. Si ya tenés una cuenta, iniciá sesión o recuperá tu contraseña.')
    expect(texto()).not.toMatch(/ya tiene una cuenta|already registered/i)
  })

  it('L7. 429 del alta → copy propio, nunca «Email rate limit exceeded»', async () => {
    estado.signUpError = { name: 'AuthApiError', status: 429, code: 'over_email_send_rate_limit', message: 'Email rate limit exceeded' }
    montar('/login?modo=registro')
    await registrar('segura-123')
    expect((await screen.findByTestId('login-error')).textContent).toContain('Hiciste varios intentos seguidos')
    expect(texto()).not.toMatch(/rate limit/i)
  })

  it('L8. error desconocido → genérico, sin el texto de GoTrue', async () => {
    estado.signUpError = { name: 'AuthApiError', status: 500, code: 'unexpected_failure', message: 'Database error saving new user' }
    montar('/login?modo=registro')
    await registrar('segura-123')
    expect((await screen.findByTestId('login-error')).textContent).toContain('No pudimos crear la cuenta')
    expect(texto()).not.toMatch(/Database error/i)
  })

  it('L15. el plan de la landing sobrevive: post_login_redirect y localStorage para otra pestaña', async () => {
    montar('/login?modo=registro&redirectTo=%2Fonboarding%3Fplan%3Dpro')
    await registrar('segura-123')
    await waitFor(() => expect(ruta()).toBe('/verificar-email'))
    expect(window.sessionStorage.getItem('post_login_redirect')).toBe('/onboarding?plan=pro')
    expect(JSON.parse(window.localStorage.getItem('trp_signup_plan') ?? '{}').plan).toBe('pro')
  })
})

describe('PRE-BETA-2D · Login — ingreso y URL', () => {
  it('L9. login: una contraseña de 6 caracteres (cuenta vieja) igual se intenta', async () => {
    montar('/login')
    await loguear('123456')
    await waitFor(() => expect(estado.llamadas).toContain('signInWithPassword'))
  })

  it('L10. login sin confirmar → mensaje y reenvío', async () => {
    estado.signInError = { name: 'AuthApiError', status: 400, code: 'email_not_confirmed', message: 'Email not confirmed' }
    montar('/login')
    await loguear('segura-123')
    expect((await screen.findByTestId('login-error')).textContent).toMatch(/todavía no está confirmada/)
    expect(screen.getByTestId('login-resend-confirmation')).toBeTruthy()
    expect(texto()).not.toMatch(/Email not confirmed/)
  })

  it('L11. ?error_description arbitrario NUNCA se pinta', async () => {
    montar('/login?error=x&error_description=TechRepair+fue+hackeado')
    expect((await screen.findByTestId('login-error')).textContent).toContain('No pudimos completar el inicio de sesión. Intentá nuevamente.')
    expect(texto()).not.toMatch(/hackeado/i)
  })

  it('L12. Google cancelado (access_denied) → copy conocido', async () => {
    montar('/login?error=access_denied&error_description=The+user+denied+the+request')
    expect((await screen.findByTestId('login-error')).textContent).toContain('Cancelaste el inicio de sesión con Google.')
    expect(texto()).not.toMatch(/denied/i)
  })

  it('L13. ?motivo=enlace_vencido → pantalla neutra; un motivo desconocido no pinta nada', async () => {
    const { unmount } = montar('/login?motivo=enlace_vencido')
    const alerta = (await screen.findByTestId('login-error')).textContent ?? ''
    expect(alerta).toContain('venció o ya se usó')
    expect(alerta).toContain('¿Olvidaste tu contraseña?')
    expect(alerta).toContain('confirmando tu correo')
    unmount()
    montar('/login?motivo=%3Cb%3Ehola%3C%2Fb%3E')
    await screen.findByTestId('login-email')
    expect(screen.queryByTestId('login-error')).toBeNull()
  })

  it('L14. falla al abrir Google → copy propio', async () => {
    estado.oauthError = { name: 'AuthApiError', status: 400, message: 'Unsupported provider: provider is not enabled' }
    montar('/login')
    await screen.findByTestId('login-email')
    fireEvent.click(screen.getByText('Continuar con Google'))
    expect((await screen.findByTestId('login-error')).textContent).toContain(GOOGLE_START_ERROR_MESSAGE)
    expect(texto()).not.toMatch(/Unsupported provider/)
  })

  it('L16. «olvidé mi contraseña» deja sólo la hora como evidencia local', async () => {
    montar('/login?modo=recuperar')
    fireEvent.change(await screen.findByTestId('login-forgot-email'), { target: { value: 'qa@example.test' } })
    fireEvent.click(screen.getByTestId('login-forgot-submit'))
    await screen.findByTestId('login-success')
    const marca = JSON.parse(window.localStorage.getItem(RECOVERY_REQUEST_MARKER_KEY) ?? 'null') as { v: number; at: number } | null
    expect(marca?.v).toBe(1)
    expect(typeof marca?.at).toBe('number')
    expect(window.localStorage.getItem(RECOVERY_REQUEST_MARKER_KEY)).not.toContain('qa@example.test')
  })
})

// AuthCallback lee `window.location.search` (no la del router): se fija la URL real.
function enCallback(query: string) {
  window.history.replaceState({}, '', `/auth/callback${query}`)
  return montar(`/auth/callback${query}`)
}

describe('PRE-BETA-2D · /auth/callback', () => {
  it('C1. error_description arbitrario NUNCA se pinta', async () => {
    enCallback('?error=x&error_description=TechRepair+fue+hackeado')
    await waitFor(() => expect(texto()).toContain('No pudimos completar el inicio de sesión. Intentá nuevamente.'))
    expect(texto()).not.toMatch(/hackeado/i)
  })

  it('C2. access_denied → «Cancelaste el inicio de sesión con Google.»', async () => {
    enCallback('?error=access_denied&error_description=The+user+denied')
    await waitFor(() => expect(texto()).toContain('Cancelaste el inicio de sesión con Google.'))
    expect(texto()).not.toMatch(/denied/i)
  })
})

describe('PRE-BETA-2D · /verificar-email', () => {
  it('V1. reenvío fallido → estado propio y soporte canónico visible', async () => {
    rememberPendingConfirmationEmail('qa@example.test')
    estado.resendError = { name: 'AuthApiError', status: 500, code: 'unexpected_failure', message: 'Error sending confirmation email' }
    montar('/verificar-email')
    fireEvent.click(await screen.findByTestId('verify-email-reenviar'))
    await waitFor(() => expect(screen.getByTestId('verify-email-estado').getAttribute('data-estado')).toBe('RESEND_FAILED'))
    const soporte = screen.getByTestId('verify-email-soporte')
    expect(soporte.textContent).toContain(CONTACTO_SOPORTE)
    expect(soporte.querySelector('a')?.getAttribute('href')).toBe(`mailto:${CONTACTO_SOPORTE}`)
    expect(texto()).not.toMatch(/Error sending/)
  })
})
