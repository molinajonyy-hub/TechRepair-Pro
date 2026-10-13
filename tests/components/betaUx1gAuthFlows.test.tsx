// ─────────────────────────────────────────────────────────────────────────────
// BETA-UX-1G — embudo de acceso, contrato de pantallas.
//
// El borde mockeado es `src/lib/supabase` (auth + rpc) y la tabla de dominios
// del portal. Login, AuthCallback, ResetPassword, AcceptInvite, VerifyEmail,
// AuthProvider y las librerías de auth corren de verdad. Los flujos contra
// GoTrue real viven en tests/e2e/m7 (job `e2e-local`).
//
//   S   las cuatro pantallas pre-login viven en el shell del embudo
//   L   login: modos, accesibilidad, validación al escribir, Google en los dos
//       modos, reenvío con resultado, destino posterior al ingreso
//   I   login consciente de la invitación
//   C   /auth/callback: error con salida, sesión que no llega, sesión tardía,
//       dominio del portal
//   R   /reset-password: requisito en vivo y aviso al salir del campo
//   A   /accept-invite: reintento, cambio de cuenta, enlace pegado, rechazos
//   V   /verificar-email: nota de cuenta existente
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation, type InitialEntry } from 'react-router-dom'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const TOKEN = 'c'.repeat(64)
const EMAIL = 'qa@example.test'

interface Sesion { user: { id: string; email: string; email_confirmed_at: string | null } }
type Respuesta = { data: unknown; error: { code?: string; message?: string } | null }

const estado = vi.hoisted(() => ({
  session: null as Sesion | null,
  listeners: [] as Array<(event: string, session: unknown) => void>,
  signInArgs: [] as Array<{ email: string; password: string }>,
  signInError: null as unknown,
  signUpArgs: [] as Array<{ email: string }>,
  resendError: null as unknown,
  oauth: [] as Array<{ redirectTo?: string }>,
  rpc: {} as Record<string, () => Respuesta>,
  llamadas: [] as { nombre: string; args: Record<string, unknown> }[],
  signOuts: 0,
  portal: {} as Record<string, string>,
}))

vi.mock('../../src/portal/portalDomains', () => ({ PORTAL_DOMAINS: estado.portal }))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: estado.session }, error: null }),
      getUser: async () => ({ data: { user: estado.session?.user ?? null }, error: null }),
      refreshSession: async () => ({ data: { session: estado.session }, error: null }),
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        estado.listeners.push(cb)
        return { data: { subscription: { unsubscribe: () => { estado.listeners = estado.listeners.filter(l => l !== cb) } } } }
      },
      signInWithPassword: async (args: { email: string; password: string }) => {
        estado.signInArgs.push(args)
        if (estado.signInError) return { data: { user: null, session: null }, error: estado.signInError }
        estado.session = { user: { id: USER_ID, email: args.email, email_confirmed_at: '2026-10-01T00:00:00Z' } }
        return { data: { user: estado.session.user, session: estado.session }, error: null }
      },
      signUp: async (args: { email: string }) => {
        estado.signUpArgs.push(args)
        return { data: { user: { id: USER_ID }, session: null }, error: null }
      },
      signInWithOAuth: async (args: { options?: { redirectTo?: string } }) => {
        estado.oauth.push({ redirectTo: args.options?.redirectTo })
        return { data: {}, error: null }
      },
      resend: async () => ({ data: {}, error: estado.resendError }),
      resetPasswordForEmail: async () => ({ data: {}, error: null }),
      verifyOtp: async () => ({ data: {}, error: null }),
      updateUser: async () => ({ data: {}, error: null }),
      signOut: async () => { estado.signOuts += 1; estado.session = null; return { error: null } },
    },
    rpc: async (nombre: string, args: Record<string, unknown> = {}) => {
      estado.llamadas.push({ nombre, args })
      const handler = estado.rpc[nombre]
      return handler ? handler() : { data: null, error: null }
    },
  },
}))

import { AuthProvider, rememberPendingConfirmationEmail } from '../../src/contexts/AuthContext'
import { Login } from '../../src/pages/Login'
import { AuthCallback } from '../../src/pages/AuthCallback'
import { ResetPassword } from '../../src/pages/ResetPassword'
import { AcceptInvite } from '../../src/pages/AcceptInvite'
import { VerifyEmail } from '../../src/pages/VerifyEmail'
import { RESEND_MESSAGE } from '../../src/lib/authErrors'
import { finishRecovery, markRecoverySession } from '../../src/lib/passwordRecovery'
import { peekInviteToken, stashInviteToken } from '../../src/lib/pendingInvite'
import { invitationPath } from '../../src/lib/invitationLink'
import { POST_LOGIN_REDIRECT_KEY } from '../../src/lib/postAuthDestination'
import { PASSWORD_MATCH_MESSAGE, PASSWORD_REQUIREMENT } from '../../src/lib/passwordPolicy'
import { canalSoporte } from '../../src/config/contacto'

/** La ruta va en un atributo: si fuera texto, se mezclaría con el de la pantalla. */
function Sonda() {
  const l = useLocation()
  return <span data-testid="ruta" data-ruta={l.pathname + l.search} />
}

const Marca = ({ id }: { id: string }) => <div data-testid={`pantalla-${id}`} />

function montar(entrada: InitialEntry, { invitacionReal = true } = {}) {
  return render(
    <MemoryRouter initialEntries={[entrada]}>
      <AuthProvider>
        <Sonda />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/accept-invite" element={invitacionReal ? <AcceptInvite /> : <Marca id="accept-invite" />} />
          <Route path="/verificar-email" element={<VerifyEmail />} />
          <Route path="/dashboard" element={<Marca id="dashboard" />} />
          <Route path="/no-business" element={<Marca id="no-business" />} />
          <Route path="/landing" element={<Marca id="landing" />} />
          <Route path="/orders" element={<Marca id="orders" />} />
          <Route path="/onboarding" element={<Marca id="onboarding" />} />
          <Route path="/" element={<Marca id="raiz" />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

const ruta = () => screen.getByTestId('ruta').getAttribute('data-ruta')
const texto = () => document.body.textContent ?? ''
const sesion = (email = EMAIL): Sesion => ({ user: { id: USER_ID, email, email_confirmed_at: '2026-10-01T00:00:00Z' } })
const llamadasA = (nombre: string) => estado.llamadas.filter(l => l.nombre === nombre)

function emitir(event: string, s: Sesion | null) {
  act(() => { for (const l of [...estado.listeners]) l(event, s) })
}

async function escribir(testId: string, valor: string) {
  fireEvent.change(await screen.findByTestId(testId), { target: { value: valor } })
}

async function loguear(password = 'segura-123', email = EMAIL) {
  await escribir('login-email', email)
  await escribir('login-password', password)
  fireEvent.click(screen.getByTestId('login-submit'))
}

beforeEach(() => {
  estado.session = null
  estado.listeners = []
  estado.signInArgs = []
  estado.signInError = null
  estado.signUpArgs = []
  estado.resendError = null
  estado.oauth = []
  estado.rpc = {}
  estado.llamadas = []
  estado.signOuts = 0
  for (const k of Object.keys(estado.portal)) delete estado.portal[k]
  finishRecovery()
  window.localStorage.clear()
  window.sessionStorage.clear()
  window.history.replaceState({}, '', '/')
  // Número de fantasía (no asignable) con el formato productivo.
  vi.stubEnv('VITE_CONTACT_WHATSAPP', '5490000000000')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

// ═══════════════════════════════════════════════════════════════════════════
describe('S · un solo shell', () => {
  it('S1. /login es el shell, con la marca como título y los modos como pestañas', async () => {
    montar('/login')
    const pagina = await screen.findByTestId('login-page')
    expect(pagina.hasAttribute('data-auth-flow-shell')).toBe(true)
    expect(pagina.getAttribute('data-estado')).toBe('login')
    expect(screen.getByRole('heading', { level: 1, name: 'TechRepair Pro' })).toBeTruthy()

    const pestañas = screen.getAllByRole('tab')
    expect(pestañas.map(t => t.textContent)).toEqual(['Iniciar sesión', 'Crear cuenta'])
    expect(pestañas.map(t => t.getAttribute('aria-selected'))).toEqual(['true', 'false'])
    // Una sola parada de Tab para el grupo.
    expect(pestañas.map(t => t.getAttribute('tabindex'))).toEqual(['0', '-1'])
    expect(screen.getByRole('tabpanel', { name: 'Iniciar sesión' })).toBeTruthy()
    // El envío del formulario es el botón primario del sistema.
    const enviar = screen.getByTestId('login-submit')
    expect(enviar.className).toContain('btn-fill-indigo')
    expect(enviar.getAttribute('type')).toBe('submit')
    expect(enviar.getAttribute('style')).toBeNull()
  })

  it('S2. /reset-password, /auth/callback y /accept-invite también, en cada estado', async () => {
    const a = montar('/reset-password')
    await waitFor(() => expect(screen.getByTestId('reset-password-page').getAttribute('data-estado')).toBe('invalido:sin_sesion'))
    expect(screen.getByTestId('reset-password-page').hasAttribute('data-auth-flow-shell')).toBe(true)
    expect(screen.getByRole('img', { name: 'TechRepair Pro' })).toBeTruthy()
    a.unmount()

    window.history.replaceState({}, '', '/auth/callback?error=access_denied')
    const b = montar('/auth/callback?error=access_denied')
    const callback = await screen.findByTestId('auth-callback-page')
    expect(callback.hasAttribute('data-auth-flow-shell')).toBe(true)
    expect(callback.getAttribute('data-estado')).toBe('error:oauth_cancelled')
    b.unmount()

    montar('/accept-invite')
    await waitFor(() => expect(screen.getByTestId('accept-invite-page').getAttribute('data-estado')).toBe('sin-token'))
    expect(screen.getByTestId('accept-invite-page').hasAttribute('data-auth-flow-shell')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('L · login', () => {
  it('L1. las flechas cambian de modo y el foco se queda en el selector', async () => {
    montar('/login')
    const [ingreso] = await screen.findAllByRole('tab')
    ingreso.focus()
    fireEvent.keyDown(ingreso, { key: 'ArrowRight' })
    await waitFor(() => expect(screen.getByTestId('login-page').getAttribute('data-estado')).toBe('register'))
    expect(screen.getByTestId('login-confirm-password')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByTestId('login-tab-register'))
    fireEvent.keyDown(screen.getByTestId('login-tab-register'), { key: 'Home' })
    await waitFor(() => expect(screen.getByTestId('login-page').getAttribute('data-estado')).toBe('login'))
    expect(document.activeElement).toBe(screen.getByTestId('login-tab-login'))
  })

  it('L2. el email se conserva al cambiar de modo; las contraseñas no', async () => {
    montar('/login')
    await escribir('login-email', EMAIL)
    await escribir('login-password', 'una-clave')

    fireEvent.click(screen.getByTestId('login-forgot-link'))
    const recuperar = await screen.findByTestId('login-forgot-email') as HTMLInputElement
    expect(recuperar.value).toBe(EMAIL)
    // El control que se tocó desapareció: el foco va al email, no se pierde.
    expect(document.activeElement).toBe(recuperar)

    fireEvent.click(screen.getByTestId('login-forgot-back'))
    expect((await screen.findByTestId('login-email') as HTMLInputElement).value).toBe(EMAIL)
    expect((screen.getByTestId('login-password') as HTMLInputElement).value).toBe('')

    fireEvent.click(screen.getByTestId('login-tab-register'))
    expect((await screen.findByTestId('login-email') as HTMLInputElement).value).toBe(EMAIL)
  })

  it('L3. cada error queda asociado a su control, y el foco va al primero que falla', async () => {
    montar('/login?modo=registro')
    await screen.findByTestId('login-confirm-password')
    fireEvent.click(screen.getByTestId('login-submit'))

    const email = screen.getByTestId('login-email')
    const errorEmail = await screen.findByTestId('login-email-error')
    expect(errorEmail.textContent).toBe('Ingresá tu email.')
    expect(email.getAttribute('aria-invalid')).toBe('true')
    expect(email.getAttribute('aria-describedby')).toBe(errorEmail.id)
    expect(document.activeElement).toBe(email)

    await escribir('login-email', EMAIL)
    expect(screen.getByTestId('login-email').getAttribute('aria-invalid')).toBe('false')
    fireEvent.click(screen.getByTestId('login-submit'))
    const password = screen.getByTestId('login-password')
    expect((await screen.findByTestId('login-password-error')).textContent).toBe('Ingresá tu contraseña.')
    expect(password.getAttribute('aria-describedby')).toBe('password-error')
    expect(document.activeElement).toBe(password)

    await escribir('login-password', 'segura-123')
    fireEvent.click(screen.getByTestId('login-submit'))
    const confirmar = screen.getByTestId('login-confirm-password')
    expect((await screen.findByTestId('login-confirm-password-error')).textContent).toBe('Repetí la contraseña.')
    expect(document.activeElement).toBe(confirmar)
    // Los errores de campo no son `alert`: no compiten con el mensaje de la pantalla.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(estado.signUpArgs).toHaveLength(0)
  })

  it('L4. al salir de un campo se avisa de lo YA escrito; un campo vacío no es un error', async () => {
    montar('/login?modo=registro')
    const email = await screen.findByTestId('login-email')
    fireEvent.blur(email)
    expect(screen.queryByTestId('login-email-error')).toBeNull()

    fireEvent.change(email, { target: { value: 'no-es-un-correo' } })
    fireEvent.blur(email)
    expect((await screen.findByTestId('login-email-error')).textContent).toMatch(/no parece una dirección válida/)

    const password = screen.getByTestId('login-password')
    fireEvent.change(password, { target: { value: 'corta' } })
    // Requisito en vivo, sin error todavía.
    expect(screen.getByText(PASSWORD_REQUIREMENT).closest('[data-met]')?.getAttribute('data-met')).toBe('false')
    expect(screen.queryByTestId('login-password-error')).toBeNull()
    fireEvent.blur(password)
    expect((await screen.findByTestId('login-password-error')).textContent).toBe('Usá al menos 8 caracteres.')

    fireEvent.change(password, { target: { value: 'segura-123' } })
    expect(screen.queryByTestId('login-password-error')).toBeNull()
    expect(screen.getByText(PASSWORD_REQUIREMENT).closest('[data-met]')?.getAttribute('data-met')).toBe('true')

    const confirmar = screen.getByTestId('login-confirm-password')
    fireEvent.change(confirmar, { target: { value: 'segura-124' } })
    fireEvent.blur(confirmar)
    expect((await screen.findByTestId('login-confirm-password-error')).textContent).toBe('Las contraseñas no coinciden.')
    fireEvent.change(confirmar, { target: { value: 'segura-123' } })
    expect(screen.getByText(PASSWORD_MATCH_MESSAGE)).toBeTruthy()
  })

  it('L5. en «Iniciar sesión» la contraseña no se valida contra la política (cuentas viejas)', async () => {
    montar('/login')
    const password = await screen.findByTestId('login-password')
    fireEvent.change(password, { target: { value: '123456' } })
    fireEvent.blur(password)
    expect(screen.queryByTestId('login-password-error')).toBeNull()
    expect(screen.queryByText(PASSWORD_REQUIREMENT)).toBeNull()
  })

  it('L6. mostrar la contraseña: interruptor con nombre fijo, y mirar no dispara la validación', async () => {
    montar('/login?modo=registro')
    const password = await screen.findByTestId('login-password')
    const ojo = screen.getByTestId('login-toggle-password')
    expect(ojo.getAttribute('aria-label')).toBe('Mostrar contraseña')
    expect(ojo.getAttribute('aria-pressed')).toBe('false')
    expect(ojo.getAttribute('type')).toBe('button')

    fireEvent.change(password, { target: { value: 'corta' } })
    // El foco pasa del campo a SU botón: todavía no se salió del campo.
    fireEvent.blur(password, { relatedTarget: ojo })
    expect(screen.queryByTestId('login-password-error')).toBeNull()

    fireEvent.click(ojo)
    expect(password.getAttribute('type')).toBe('text')
    expect(ojo.getAttribute('aria-pressed')).toBe('true')
    expect(ojo.getAttribute('aria-label')).toBe('Mostrar contraseña')
    // Cada campo tiene su propio interruptor.
    expect(screen.getByTestId('login-confirm-password').getAttribute('type')).toBe('password')
  })

  it('L7. Google se ofrece en «Iniciar sesión» y en «Crear cuenta», no en el pedido de recuperación', async () => {
    const alta = montar('/login?modo=registro&redirectTo=%2Fonboarding%3Fplan%3Dpro')
    const google = await screen.findByTestId('login-google')
    expect(google.className).toContain('btn-secondary')
    fireEvent.click(google)
    await waitFor(() => expect(estado.oauth).toHaveLength(1))
    expect(estado.oauth[0].redirectTo).toMatch(/\/auth\/callback$/)
    // El destino y el plan viajan igual que en el alta por email.
    expect(window.sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY)).toBe('/onboarding?plan=pro')
    expect(JSON.parse(window.localStorage.getItem('trp_signup_plan') ?? '{}').plan).toBe('pro')
    // El navegador se está yendo a Google: la pantalla queda bloqueada, con su texto.
    await waitFor(() => expect(screen.getByTestId('login-google').textContent).toMatch(/Redirigiendo a Google/))
    expect(screen.getByTestId('login-submit').hasAttribute('disabled')).toBe(true)
    alta.unmount()

    montar('/login')
    expect(await screen.findByTestId('login-google')).toBeTruthy()
    fireEvent.click(screen.getByTestId('login-forgot-link'))
    await screen.findByTestId('login-forgot-form')
    expect(screen.queryByTestId('login-google')).toBeNull()
  })

  it('L8. mientras se envía: botón deshabilitado, con su texto, y el resto bloqueado', async () => {
    let liberar: () => void = () => {}
    estado.signInError = null
    const original = estado.rpc
    montar('/login')
    await escribir('login-email', EMAIL)
    await escribir('login-password', 'segura-123')
    // El login queda en vuelo hasta que se libere.
    const sb = (await import('../../src/lib/supabase')).supabase as unknown as { auth: { signInWithPassword: (a: unknown) => Promise<unknown> } }
    const real = sb.auth.signInWithPassword
    sb.auth.signInWithPassword = () => new Promise(res => { liberar = () => res({ data: { user: null, session: null }, error: { code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' } }) })
    try {
      fireEvent.click(screen.getByTestId('login-submit'))
      await waitFor(() => expect(screen.getByTestId('login-submit').hasAttribute('disabled')).toBe(true))
      expect(screen.getByTestId('login-submit').textContent).toMatch(/Iniciando sesión/)
      expect(screen.getByTestId('login-google').hasAttribute('disabled')).toBe(true)
      expect(screen.getByTestId('login-tab-register').hasAttribute('disabled')).toBe(true)
      expect(screen.getByTestId('login-email').hasAttribute('disabled')).toBe(true)
      await act(async () => { liberar() })
      expect((await screen.findByTestId('login-error')).textContent).toMatch(/Email o contraseña incorrectos/)
      expect(screen.getByTestId('login-submit').hasAttribute('disabled')).toBe(false)
      expect(texto()).not.toMatch(/Invalid login credentials/)
    } finally {
      sb.auth.signInWithPassword = real
      estado.rpc = original
    }
  })

  describe('reenvío de confirmación', () => {
    async function llegarAlReenvio() {
      estado.signInError = { name: 'AuthApiError', status: 400, code: 'email_not_confirmed', message: 'Email not confirmed' }
      montar('/login')
      await loguear()
      return screen.findByTestId('login-resend-confirmation')
    }

    it('L9. enviado → un solo mensaje, de éxito, y el botón deja de ofrecerse', async () => {
      fireEvent.click(await llegarAlReenvio())
      const ok = await screen.findByTestId('login-resend-sent')
      expect(ok.textContent).toBe(RESEND_MESSAGE.sent)
      expect(ok.getAttribute('role')).toBe('status')
      expect(screen.queryByTestId('login-error')).toBeNull()
      expect(screen.queryByTestId('login-resend-confirmation')).toBeNull()
    })

    it('L10. límite de envíos → aviso propio, sin el texto del servidor', async () => {
      const boton = await llegarAlReenvio()
      estado.resendError = { name: 'AuthApiError', status: 429, code: 'over_email_send_rate_limit', message: 'For security purposes, you can only request this after 42 seconds.' }
      fireEvent.click(boton)
      expect((await screen.findByTestId('login-resend-limited')).textContent).toBe(RESEND_MESSAGE.rate_limited)
      expect(texto()).not.toMatch(/security purposes/)
    })

    it('L11. si el reenvío falla, la pantalla lo dice y ofrece ayuda (antes no pasaba nada)', async () => {
      const boton = await llegarAlReenvio()
      estado.resendError = { name: 'AuthApiError', status: 500, code: 'unexpected_failure', message: 'Error sending confirmation email' }
      fireEvent.click(boton)
      await waitFor(() => expect(screen.getByTestId('login-error').textContent).toContain(RESEND_MESSAGE.error))
      expect(screen.getByTestId('login-error-soporte').getAttribute('href')).toBe(canalSoporte('correoNoLlega').url)
      // Se puede volver a intentar.
      expect(screen.getByTestId('login-resend-confirmation').hasAttribute('disabled')).toBe(false)
      expect(texto()).not.toMatch(/Error sending/)
    })
  })

  describe('destino después de ingresar', () => {
    it('L12. sin nada pedido → /dashboard', async () => {
      montar('/login')
      await loguear()
      await waitFor(() => expect(ruta()).toBe('/dashboard'))
      expect(estado.signInArgs[0]).toEqual({ email: EMAIL, password: 'segura-123' })
    })

    it('L13. `?redirectTo=` interno se respeta; uno externo cae a /dashboard', async () => {
      const a = montar('/login?redirectTo=%2Forders')
      await loguear()
      await waitFor(() => expect(ruta()).toBe('/orders'))
      a.unmount()

      estado.session = null
      montar('/login?redirectTo=%2F%2Fevil.example%2Fx')
      await loguear()
      await waitFor(() => expect(ruta()).toBe('/dashboard'))
    })

    it('L14. el destino guardado por la pestaña se respeta y se consume', async () => {
      window.sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, '/orders')
      montar('/login')
      await loguear()
      await waitFor(() => expect(ruta()).toBe('/orders'))
      expect(window.sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY)).toBeNull()
    })

    it('L15. con una invitación pendiente, el ingreso lleva a aceptarla (no a «Creá tu taller»)', async () => {
      stashInviteToken(TOKEN)
      montar('/login', { invitacionReal: false })
      await loguear()
      await waitFor(() => expect(ruta()).toBe(invitationPath(TOKEN)))
      expect(screen.getByTestId('pantalla-accept-invite')).toBeTruthy()
    })

    it('L16. el destino que dejó el guard conserva su query', async () => {
      montar({ pathname: '/login', state: { from: { pathname: '/orders', search: '?estado=listas' } } })
      await loguear()
      await waitFor(() => expect(ruta()).toBe('/orders?estado=listas'))
    })

    it('L17. ya con sesión, /login sale solo y una sola vez', async () => {
      estado.session = sesion()
      window.sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, '/orders')
      montar('/login')
      await waitFor(() => expect(ruta()).toBe('/orders'))
    })
  })

  it('L18. `?motivo=sesion_no_iniciada` explica por qué se volvió al login', async () => {
    montar('/login?motivo=sesion_no_iniciada')
    expect((await screen.findByTestId('login-error')).textContent).toBe('No pudimos completar el inicio de sesión. Intentá nuevamente.')
  })

  it('L19. la alerta de la pantalla lleva ícono y texto (no un emoji) y el tono va en la clase', async () => {
    montar('/login?error=access_denied')
    const alerta = await screen.findByTestId('login-error')
    expect(alerta.getAttribute('role')).toBe('alert')
    expect(alerta.className).toContain('alert-error')
    expect(alerta.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
    expect(alerta.textContent).toBe('Cancelaste el inicio de sesión con Google.')
  })

  it('L20. el acceso al alta bajo la tarjeta abre «Crear cuenta» y deja el foco en el formulario', async () => {
    montar('/login')
    fireEvent.click(await screen.findByTestId('login-trial-cta'))
    await waitFor(() => expect(screen.getByTestId('login-page').getAttribute('data-estado')).toBe('register'))
    expect(document.activeElement).toBe(screen.getByTestId('login-email'))
    expect(screen.queryByTestId('login-trial-cta')).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('I · login consciente de la invitación', () => {
  const desdeInvitacion = `/login?redirectTo=${encodeURIComponent(invitationPath(TOKEN))}`

  it('I1. quien llega desde una invitación lo ve dicho y arranca en «Crear cuenta»', async () => {
    montar(desdeInvitacion)
    const aviso = await screen.findByTestId('login-invite-context')
    expect(aviso.textContent).toMatch(/Te invitaron a un equipo en TechRepair Pro\./)
    expect(aviso.textContent).toMatch(/el correo en el que recibiste la invitación/)
    expect(aviso.getAttribute('role')).toBe('note')
    expect(screen.getByTestId('login-page').getAttribute('data-estado')).toBe('register')
    expect(screen.getByTestId('login-confirm-password')).toBeTruthy()
    // No se le ofrece una prueba gratis: se suma a un equipo que ya existe.
    expect(texto()).not.toMatch(/cuenta gratuita/)
    expect(screen.queryByTestId('login-trial-cta')).toBeNull()
  })

  it('I2. si ya tiene cuenta, «Iniciar sesión» lo lleva directo a aceptar', async () => {
    montar(desdeInvitacion, { invitacionReal: false })
    fireEvent.click(await screen.findByTestId('login-tab-login'))
    expect((await screen.findByTestId('login-invite-context')).textContent).toMatch(/Iniciá sesión con el correo/)
    await loguear()
    await waitFor(() => expect(ruta()).toBe(invitationPath(TOKEN)))
  })

  it('I3. `?modo=` explícito gana, y un destino cualquiera no activa el aviso', async () => {
    const a = montar(`${desdeInvitacion}&modo=recuperar`)
    await screen.findByTestId('login-forgot-form')
    expect(screen.queryByTestId('login-invite-context')).toBeNull()
    a.unmount()

    montar('/login?redirectTo=%2Forders%3Fnext%3D%2Faccept-invite')
    await screen.findByTestId('login-email')
    expect(screen.queryByTestId('login-invite-context')).toBeNull()
    expect(screen.getByTestId('login-page').getAttribute('data-estado')).toBe('login')
  })

  it('I4. el alta desde la invitación conserva el destino a través de la confirmación', async () => {
    montar(desdeInvitacion)
    await escribir('login-email', EMAIL)
    await escribir('login-password', 'segura-123')
    await escribir('login-confirm-password', 'segura-123')
    fireEvent.click(screen.getByTestId('login-submit'))
    await waitFor(() => expect(ruta()).toBe('/verificar-email'))
    expect(window.sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY)).toBe(invitationPath(TOKEN))
    // El aviso no creó una prueba ni un negocio: sólo cambió el texto y el modo.
    expect(llamadasA('provision_my_business')).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
function enCallback(query: string) {
  window.history.replaceState({}, '', `/auth/callback${query}`)
  return montar(`/auth/callback${query}`)
}

describe('C · /auth/callback', () => {
  it('C1. un error se queda en pantalla con su salida: no salta solo al login', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    enCallback('?error=access_denied&error_description=The+user+denied')
    const tarjeta = await screen.findByTestId('auth-callback-error')
    expect(within(tarjeta).getByRole('heading', { level: 1 }).textContent).toBe('No iniciaste sesión')
    expect(tarjeta.textContent).toContain('Cancelaste el inicio de sesión con Google.')
    expect(texto()).not.toMatch(/denied|Error al iniciar/i)
    // Los parámetros del error no quedan en la barra.
    expect(window.location.search).toBe('')

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(ruta()).toBe('/auth/callback?error=access_denied&error_description=The+user+denied')
    expect(screen.getByTestId('auth-callback-error')).toBeTruthy()

    fireEvent.click(screen.getByTestId('auth-callback-volver'))
    await waitFor(() => expect(ruta()).toBe('/login'))
  })

  it('C2. sin sesión vuelve al login CON el motivo, y el login lo explica', async () => {
    enCallback('')
    expect((await screen.findByTestId('auth-callback-loading')).textContent).toBe('Iniciando sesión…')
    await waitFor(() => expect(ruta()).toBe('/login?motivo=sesion_no_iniciada'), { timeout: 4000 })
    expect((await screen.findByTestId('login-error')).textContent).toMatch(/No pudimos completar el inicio de sesión/)
  })

  it('C3. si la sesión llega durante la espera, sigue a la app y NO pasa por el login', async () => {
    enCallback('')
    await screen.findByTestId('auth-callback-loading')
    estado.session = sesion()
    emitir('SIGNED_IN', estado.session)
    await waitFor(() => expect(ruta()).toBe('/dashboard'))
    // Pasado el margen, el temporizador viejo no pisa la navegación.
    await new Promise(r => setTimeout(r, 1700))
    expect(ruta()).toBe('/dashboard')
  })

  it('C4. con sesión consume el destino guardado; sin él, la invitación pendiente', async () => {
    estado.session = sesion()
    window.sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, '/onboarding?plan=pro')
    const a = enCallback('')
    await waitFor(() => expect(ruta()).toBe('/onboarding?plan=pro'))
    expect(window.sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY)).toBeNull()
    a.unmount()

    stashInviteToken(TOKEN)
    enCallback('')
    await waitFor(() => expect(ruta()).toBe(invitationPath(TOKEN)))
  })

  it('C5. en el dominio del portal va a la raíz y no muestra la marca de TechRepair Pro', async () => {
    estado.portal[window.location.hostname] = 'clic'
    estado.session = sesion()
    window.sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, '/orders')
    const a = enCallback('')
    await waitFor(() => expect(ruta()).toBe('/'))
    a.unmount()

    estado.session = null
    enCallback('?error=x')
    await screen.findByTestId('auth-callback-error')
    expect(screen.queryByRole('img', { name: 'TechRepair Pro' })).toBeNull()
    expect(texto()).not.toMatch(/TechRepair/)
  })

  it('C6. un enlace de correo se anuncia como tal mientras se valida', async () => {
    const sb = (await import('../../src/lib/supabase')).supabase as unknown as { auth: { verifyOtp: () => Promise<unknown> } }
    const real = sb.auth.verifyOtp
    sb.auth.verifyOtp = () => new Promise(() => {})
    try {
      enCallback('?token_hash=sintetico&type=signup')
      expect((await screen.findByTestId('auth-callback-loading')).textContent).toBe('Verificando tu enlace…')
      expect(screen.getByTestId('auth-callback-loading').getAttribute('role')).toBe('status')
      // El token no queda en la barra mientras se valida.
      expect(window.location.search).toBe('')
    } finally {
      sb.auth.verifyOtp = real
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('R · /reset-password', () => {
  it('R1. requisito en vivo y aviso al salir del campo, con la política de siempre', async () => {
    estado.session = sesion()
    markRecoverySession(USER_ID)
    montar('/reset-password')
    const nueva = await screen.findByTestId('reset-password-new')
    expect(screen.getByRole('heading', { level: 1, name: 'Nueva contraseña' })).toBeTruthy()
    // (La tarjeta también se llama «Nueva contraseña»: se acota al control.)
    expect(screen.getByLabelText('Nueva contraseña', { selector: 'input' })).toBe(nueva)

    fireEvent.change(nueva, { target: { value: 'corta' } })
    expect(screen.getByText(PASSWORD_REQUIREMENT).closest('[data-met]')?.getAttribute('data-met')).toBe('false')
    fireEvent.blur(nueva, { relatedTarget: screen.getByTestId('reset-password-toggle-new') })
    expect(screen.queryByTestId('reset-password-new-error')).toBeNull()
    fireEvent.blur(nueva)
    const error = await screen.findByTestId('reset-password-new-error')
    expect(error.textContent).toBe('Usá al menos 8 caracteres.')
    expect(nueva.getAttribute('aria-describedby')).toBe(error.id)

    fireEvent.change(nueva, { target: { value: 'segura-123' } })
    fireEvent.change(screen.getByTestId('reset-password-confirm'), { target: { value: 'segura-123' } })
    expect(screen.getByText(PASSWORD_MATCH_MESSAGE)).toBeTruthy()
    expect(screen.getByTestId('reset-password-submit').className).toContain('btn-fill-indigo')
  })

  it('R2. cada estado tiene título propio, y el inválido ofrece sus dos salidas', async () => {
    montar('/reset-password')
    const tarjeta = await screen.findByTestId('reset-password-invalid')
    expect(within(tarjeta).getByRole('heading', { level: 1 }).textContent).toBe('Abrí el enlace desde tu correo')
    expect(screen.getByTestId('reset-password-request-new').className).toContain('btn-fill-indigo')
    fireEvent.click(screen.getByTestId('reset-password-back-login'))
    await waitFor(() => expect(ruta()).toBe('/login'))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
const aceptada = (): Respuesta => ({ data: { business_id: 'b', role: 'tech', created: true, status: 'ACCEPTED' }, error: null })
const rechazo = (code: string, message: string) => (): Respuesta => ({ data: null, error: { code, message } })

describe('A · /accept-invite', () => {
  it('A1. un fallo que no es del enlace ofrece REINTENTAR con el mismo enlace', async () => {
    estado.session = sesion()
    estado.rpc['accept_business_invitation'] = () => ({ data: null, error: { code: '08006', message: 'connection failure' } })
    montar(`/accept-invite?token=${TOKEN}`)

    const tarjeta = await screen.findByTestId('accept-invite-error')
    expect(within(tarjeta).getByRole('heading', { level: 1 }).textContent).toBe('No pudimos sumarte al equipo')
    expect(texto()).not.toMatch(/connection failure|08006/)
    // Ya no pide pegar un «token»: está dentro del enlace que el invitado abrió.
    expect(screen.queryByTestId('accept-invite-link')).toBeNull()
    expect(texto()).not.toMatch(/token/i)
    // El enlace sigue guardado: recargar también funciona.
    expect(peekInviteToken()).toBe(TOKEN)

    estado.rpc['accept_business_invitation'] = aceptada
    fireEvent.click(screen.getByTestId('accept-invite-retry'))
    await waitFor(() => expect(screen.getByText('Invitación aceptada')).toBeTruthy())
    const intentos = llamadasA('accept_business_invitation')
    expect(intentos).toHaveLength(2)
    expect(intentos.map(l => l.args)).toEqual([{ p_token: TOKEN }, { p_token: TOKEN }])
    expect(llamadasA('provision_my_business')).toHaveLength(0)
  })

  it('A2. «es para otro correo» dice con qué cuenta se entró y deja cambiarla sin perder el enlace', async () => {
    estado.session = sesion('otro@example.test')
    estado.rpc['accept_business_invitation'] = rechazo('TRIEM', 'INVITATION_EMAIL_MISMATCH')
    montar(`/accept-invite?token=${TOKEN}`)

    const tarjeta = await screen.findByTestId('accept-invite-error')
    expect(within(tarjeta).getByRole('heading', { level: 1 }).textContent).toBe('Esta invitación es para otro correo')
    expect(screen.getByTestId('accept-invite-current-account').textContent).toBe('Entraste con otro@example.test.')
    // Rechazo definitivo: sin «Reintentar», y el enlace guardado se limpia.
    expect(screen.queryByTestId('accept-invite-retry')).toBeNull()
    expect(peekInviteToken()).toBeNull()

    fireEvent.click(screen.getByTestId('accept-invite-switch-account'))
    await waitFor(() => expect(ruta()).toBe(`/login?redirectTo=${encodeURIComponent(invitationPath(TOKEN))}`))
    expect(estado.signOuts).toBe(1)
    // El login recibe al invitado sabiendo de dónde viene.
    expect(await screen.findByTestId('login-invite-context')).toBeTruthy()
    expect(llamadasA('accept_business_invitation')).toHaveLength(1)
  })

  it.each([
    ['TRIEX', 'INVITATION_EXPIRED', 'La invitación venció', /Pedile al administrador/],
    ['TRICA', 'INVITATION_CANCELLED', 'La invitación fue cancelada', /fue cancelada/],
    ['TRINF', 'INVITATION_NOT_FOUND', 'No encontramos la invitación', /Revisá el enlace/],
    ['TRIAU', 'INVITATION_ALREADY_USED', 'Esta invitación ya se usó', /ya fue utilizada/],
    ['TRIAM', 'ALREADY_MEMBER_OF_ANOTHER_BUSINESS', 'Tu cuenta ya está en otro negocio', /ya pertenece a otro negocio/],
  ])('A3. %s → título y detalle propios, una sola salida y nada del servidor en pantalla', async (sqlstate, marca, titulo, detalle) => {
    estado.session = sesion()
    estado.rpc['accept_business_invitation'] = rechazo(sqlstate, marca)
    montar(`/accept-invite?token=${TOKEN}`)

    const tarjeta = await screen.findByTestId('accept-invite-error')
    expect(within(tarjeta).getByRole('heading', { level: 1 }).textContent).toBe(titulo)
    expect(screen.getByTestId('accept-invite-error-message').textContent).toMatch(detalle)
    expect(texto()).not.toContain(marca)
    expect(texto()).not.toContain(sqlstate)
    expect(screen.queryByTestId('accept-invite-retry')).toBeNull()
    expect(screen.queryByTestId('accept-invite-switch-account')).toBeNull()
    expect(peekInviteToken()).toBeNull()

    fireEvent.click(screen.getByTestId('accept-invite-home'))
    await waitFor(() => expect(ruta()).toBe('/dashboard'))
  })

  it('A4. sin enlace pide el ENLACE del correo; pegado entero, acepta con su token', async () => {
    estado.session = sesion()
    estado.rpc['accept_business_invitation'] = aceptada
    montar('/accept-invite')

    const campo = await screen.findByTestId('accept-invite-link')
    expect(screen.getByLabelText('Enlace de la invitación')).toBe(campo)
    expect(texto()).not.toMatch(/token/i)

    fireEvent.click(screen.getByTestId('accept-invite-submit'))
    const error = await screen.findByTestId('accept-invite-link-error')
    expect(error.textContent).toBe('Pegá el enlace completo del correo de invitación.')
    expect(campo.getAttribute('aria-invalid')).toBe('true')
    expect(llamadasA('accept_business_invitation')).toHaveLength(0)

    fireEvent.change(campo, { target: { value: 'https://www.techrepairpro.app/accept-invite' } })
    fireEvent.click(screen.getByTestId('accept-invite-submit'))
    expect(await screen.findByTestId('accept-invite-link-error')).toBeTruthy()
    expect(llamadasA('accept_business_invitation')).toHaveLength(0)

    fireEvent.change(campo, { target: { value: `  https://www.techrepairpro.app/accept-invite?token=${TOKEN} ` } })
    fireEvent.click(screen.getByTestId('accept-invite-submit'))
    await waitFor(() => expect(screen.getByText('Invitación aceptada')).toBeTruthy())
    expect(llamadasA('accept_business_invitation').map(l => l.args)).toEqual([{ p_token: TOKEN }])
  })

  it('A5. sin sesión, el enlace pegado sigue al login conservando la invitación', async () => {
    montar('/accept-invite')
    const campo = await screen.findByTestId('accept-invite-link')
    fireEvent.change(campo, { target: { value: `https://www.techrepairpro.app/accept-invite?token=${TOKEN}` } })
    fireEvent.click(screen.getByTestId('accept-invite-submit'))
    await waitFor(() => expect(ruta()).toBe(`/login?redirectTo=${encodeURIComponent(invitationPath(TOKEN))}`))
    expect(peekInviteToken()).toBe(TOKEN)
    expect(llamadasA('accept_business_invitation')).toHaveLength(0)
  })

  it('A6. aceptada: título, salida inmediata y entrada sola al inicio', async () => {
    estado.session = sesion()
    estado.rpc['accept_business_invitation'] = () => ({ data: { business_id: 'b', role: 'tech', created: false, status: 'ALREADY_MEMBER' }, error: null })
    montar(`/accept-invite?token=${TOKEN}`)
    const tarjeta = await screen.findByTestId('accept-invite-ok')
    expect(within(tarjeta).getByRole('heading', { level: 1 }).textContent).toBe('Ya sos parte del equipo')
    expect(peekInviteToken()).toBeNull()
    fireEvent.click(screen.getByTestId('accept-invite-continuar'))
    await waitFor(() => expect(ruta()).toBe('/dashboard'))
  })

  it('A7. mientras acepta muestra la espera del embudo (nunca el formulario del enlace)', async () => {
    estado.session = sesion()
    let liberar: (r: Respuesta) => void = () => {}
    const pendiente = new Promise<Respuesta>(res => { liberar = res })
    const sb = (await import('../../src/lib/supabase')).supabase as unknown as { rpc: (n: string, a?: Record<string, unknown>) => Promise<Respuesta> }
    const real = sb.rpc
    sb.rpc = (nombre, args = {}) => (nombre === 'accept_business_invitation' ? pendiente : real(nombre, args))
    try {
      montar(`/accept-invite?token=${TOKEN}`)
      const espera = await screen.findByTestId('accept-invite-loading')
      await waitFor(() => expect(espera.textContent).toBe('Sumándote al equipo…'))
      expect(screen.queryByTestId('accept-invite-link')).toBeNull()
      await act(async () => { liberar(aceptada()) })
      await waitFor(() => expect(screen.getByText('Invitación aceptada')).toBeTruthy())
    } finally {
      sb.rpc = real
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('V · /verificar-email', () => {
  it('V1. sin sesión, la pantalla orienta a quien ya tenía cuenta — exista o no la cuenta', async () => {
    rememberPendingConfirmationEmail(EMAIL)
    montar('/verificar-email')
    const nota = await screen.findByTestId('verify-email-existing-account')
    expect(nota.textContent).toMatch(/Si ya tenías una cuenta con este correo/)
    expect(nota.textContent).toMatch(/iniciá sesión con tu contraseña o recuperala/)
    // No afirma nada sobre ESTE correo: el texto es condicional y siempre el mismo.
    expect(nota.textContent).not.toMatch(/ya existe|ya está registrad/i)
    expect(nota.textContent).not.toContain(EMAIL)
  })

  it('V2. con sesión sin confirmar (cuenta propia) la nota no aparece', async () => {
    estado.session = { user: { id: USER_ID, email: EMAIL, email_confirmed_at: null } }
    montar('/verificar-email')
    await screen.findByTestId('verify-email-reenviar')
    expect(screen.queryByTestId('verify-email-existing-account')).toBeNull()
  })
})
