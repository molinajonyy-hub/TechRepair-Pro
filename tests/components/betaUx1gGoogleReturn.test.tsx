// ─────────────────────────────────────────────────────────────────────────────
// HOTFIX BETA-UX-1G — volver de Google al login sin autenticarse.
//
// El defecto (medido en Chrome con back/forward cache, ver
// docs/beta-ux-1/beta-ux-1g-google-oauth-return.md): «Continuar con Google»
// entrega la página al proveedor; si el usuario vuelve con «Atrás», el navegador
// restaura ESTA página desde el historial con el estado de antes de irse —
// «Redirigiendo a Google…» y todo deshabilitado— y nada lo deshacía.
//
// La segunda forma (también medida): la carga hacia el proveedor se detiene antes
// de salir («Detener», Esc, red caída). La página nunca se fue y quedaba igual.
//
// jsdom no tiene bfcache ni Navigation API: cada caso se representa con el
// evento que lo marca —`pageshow` con `persisted: true`, `navigateerror` sobre
// `window.navigation`—, que es exactamente lo que escucha la corrección. Los
// casos REALES se miden en navegador (m7/google-oauth-return.spec.ts y
// docs/beta-ux-1/evidence-1g-oauth/).
//
//   G1  ida a Google → vuelta desde el historial → login usable, sin destino viejo
//   G2  un `pageshow` normal (no restaurado) no toca nada
//   G3  una restauración sin ida a Google no borra un destino ajeno
//   G4  segundo intento de Google después de volver
//   G5  contraseña después de volver: el destino pedido se respeta (por la URL)
//   G6  error al iniciar OAuth: se recupera solo, y una restauración posterior no hace nada
//   G7  cancelar en Google: el callback lo explica, y al volver el login está usable
//       y conserva el destino pedido
//   G8  sin temporizadores: la espera no se corta sola mientras el navegador se va
//   G9  desmontado, el login deja de escuchar la vuelta (las dos señales)
//   G10 la vuelta de Google con sesión sigue igual (cuenta existente y nueva)
//   G11 la carga hacia Google se detiene antes de salir → login usable, sin destino viejo
//   G12 una navegación fallida sin ida a Google no toca nada
//   G13 sin Navigation API el login monta igual y la vuelta del historial sigue cubierta
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation, type InitialEntry } from 'react-router-dom'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const EMAIL = 'qa@example.test'

interface Sesion { user: { id: string; email: string; email_confirmed_at: string | null } }

const estado = vi.hoisted(() => ({
  session: null as Sesion | null,
  listeners: [] as Array<(event: string, session: unknown) => void>,
  oauth: 0,
  oauthError: null as unknown,
  signIns: [] as string[],
  perfil: null as unknown,
}))

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
      // En el navegador real, acá supabase-js hace `window.location.assign(url)` y
      // la página se va; en jsdom no hay navegación, igual que mientras sale.
      signInWithOAuth: async () => { estado.oauth += 1; return { data: { provider: 'google', url: 'https://accounts.google.test' }, error: estado.oauthError } },
      signInWithPassword: async (args: { email: string }) => {
        estado.signIns.push(args.email)
        estado.session = { user: { id: USER_ID, email: args.email, email_confirmed_at: '2026-10-01T00:00:00Z' } }
        return { data: { user: estado.session.user, session: estado.session }, error: null }
      },
      signUp: async () => ({ data: { user: null, session: null }, error: null }),
      resend: async () => ({ data: {}, error: null }),
      resetPasswordForEmail: async () => ({ data: {}, error: null }),
      verifyOtp: async () => ({ data: {}, error: null }),
      signOut: async () => { estado.session = null; return { error: null } },
    },
    rpc: async (nombre: string) => (nombre === 'get_my_profile' ? { data: estado.perfil, error: null } : { data: null, error: null }),
  },
}))

import { AuthProvider } from '../../src/contexts/AuthContext'
import { Login } from '../../src/pages/Login'
import { AuthCallback } from '../../src/pages/AuthCallback'
import { POST_LOGIN_REDIRECT_KEY } from '../../src/lib/postAuthDestination'
import { GOOGLE_START_ERROR_MESSAGE } from '../../src/lib/authErrors'

function Sonda() {
  const l = useLocation()
  return <span data-testid="ruta" data-ruta={l.pathname + l.search} />
}
const Marca = ({ id }: { id: string }) => <div data-testid={`pantalla-${id}`} />

function montar(entrada: InitialEntry) {
  return render(
    <MemoryRouter initialEntries={[entrada]}>
      <AuthProvider>
        <Sonda />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/dashboard" element={<Marca id="dashboard" />} />
          <Route path="/no-business" element={<Marca id="no-business" />} />
          <Route path="/orders" element={<Marca id="orders" />} />
          <Route path="/landing" element={<Marca id="landing" />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

const ruta = () => screen.getByTestId('ruta').getAttribute('data-ruta')
const guardado = () => window.sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY)

/** Lo que dispara el navegador al restaurar la página desde el back/forward cache. */
function volverDelHistorial(persisted = true) {
  const evento = typeof PageTransitionEvent === 'function'
    ? new PageTransitionEvent('pageshow', { persisted })
    : Object.assign(new Event('pageshow'), { persisted })
  act(() => { window.dispatchEvent(evento) })
}

/** Navigation API mínima: jsdom no la trae. Se instala antes de montar. */
function instalarNavigationApi(): EventTarget {
  const navegacion = new EventTarget()
  Object.defineProperty(window, 'navigation', { value: navegacion, configurable: true, writable: true })
  return navegacion
}
function quitarNavigationApi() {
  delete (window as Window & { navigation?: EventTarget }).navigation
}

/** Lo que dispara el navegador cuando la navegación pendiente no termina (p. ej. «Detener»). */
function navegacionInterrumpida(navegacion: EventTarget) {
  act(() => { navegacion.dispatchEvent(new Event('navigateerror')) })
}

async function irAGoogle() {
  fireEvent.click(await screen.findByTestId('login-google'))
  await waitFor(() => expect(screen.getByTestId('login-google').textContent).toBe('Redirigiendo a Google…'))
}

function esperaDeGoogle() {
  expect(screen.getByTestId('login-google').hasAttribute('disabled')).toBe(true)
  expect(screen.getByTestId('login-submit').hasAttribute('disabled')).toBe(true)
  expect(screen.getByTestId('login-email').hasAttribute('disabled')).toBe(true)
}

function loginUsable() {
  expect(screen.getByTestId('login-google').textContent).toBe('Continuar con Google')
  expect(screen.getByTestId('login-google').hasAttribute('disabled')).toBe(false)
  expect(screen.getByTestId('login-submit').hasAttribute('disabled')).toBe(false)
  expect(screen.getByTestId('login-email').hasAttribute('disabled')).toBe(false)
  expect(screen.getByTestId('login-password').hasAttribute('disabled')).toBe(false)
  expect(screen.getByTestId('login-tab-register').hasAttribute('disabled')).toBe(false)
}

beforeEach(() => {
  estado.session = null
  estado.listeners = []
  estado.oauth = 0
  estado.oauthError = null
  estado.signIns = []
  estado.perfil = null
  window.localStorage.clear()
  window.sessionStorage.clear()
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  vi.useRealTimers()
  quitarNavigationApi()
})

describe('HOTFIX · volver de Google al login', () => {
  it('G1. ida a Google y vuelta desde el historial: el login queda usable y sin el destino del intento', async () => {
    montar('/login')
    await irAGoogle()
    esperaDeGoogle()
    expect(guardado()).toBe('/dashboard')
    expect(estado.oauth).toBe(1)

    volverDelHistorial()
    loginUsable()
    expect(guardado()).toBeNull()
    // Sin mensaje de error: volver no es una falla.
    expect(screen.queryByTestId('login-error')).toBeNull()
  })

  it('G2. un `pageshow` de una carga normal (no restaurada) no corta la espera', async () => {
    montar('/login')
    await irAGoogle()
    volverDelHistorial(false)
    esperaDeGoogle()
    expect(screen.getByTestId('login-google').textContent).toBe('Redirigiendo a Google…')
    expect(guardado()).toBe('/dashboard')
  })

  it('G3. una restauración sin ida a Google no borra un destino guardado por otro camino', async () => {
    window.sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, '/orders')
    montar('/login')
    await screen.findByTestId('login-google')
    volverDelHistorial()
    expect(guardado()).toBe('/orders')
    loginUsable()
  })

  it('G4. segundo intento de Google después de volver', async () => {
    montar('/login?redirectTo=%2Forders')
    await irAGoogle()
    volverDelHistorial()
    loginUsable()

    await irAGoogle()
    expect(estado.oauth).toBe(2)
    // El destino vuelve a quedar guardado para ESTE intento.
    expect(guardado()).toBe('/orders')
    volverDelHistorial()
    loginUsable()
    expect(guardado()).toBeNull()
  })

  it('G5. contraseña después de volver: entra y respeta el destino pedido (sale de la URL)', async () => {
    montar('/login?redirectTo=%2Forders')
    await irAGoogle()
    volverDelHistorial()
    loginUsable()

    fireEvent.change(screen.getByTestId('login-email'), { target: { value: EMAIL } })
    fireEvent.change(screen.getByTestId('login-password'), { target: { value: 'segura-123' } })
    fireEvent.click(screen.getByTestId('login-submit'))
    await waitFor(() => expect(ruta()).toBe('/orders'))
    expect(estado.signIns).toEqual([EMAIL])
  })

  it('G6. si OAuth no arranca, se recupera solo; una restauración posterior no hace nada', async () => {
    estado.oauthError = { name: 'AuthApiError', status: 400, message: 'Unsupported provider: provider is not enabled' }
    montar('/login?redirectTo=%2Forders')
    fireEvent.click(await screen.findByTestId('login-google'))
    expect((await screen.findByTestId('login-error')).textContent).toBe(GOOGLE_START_ERROR_MESSAGE)
    loginUsable()
    expect(guardado()).toBeNull()

    window.sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, '/customers')
    volverDelHistorial()
    expect(guardado()).toBe('/customers')
    expect(screen.getByTestId('login-error').textContent).toBe(GOOGLE_START_ERROR_MESSAGE)
  })

  it('G7. cancelar en Google: el callback lo explica; al volver el login está usable y conserva el destino', async () => {
    // El login guarda el destino al ir a Google; Google rechaza y GoTrue vuelve al callback.
    window.sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, '/orders')
    window.history.replaceState({}, '', '/auth/callback?error=access_denied&error_description=The+user+denied')
    montar('/auth/callback?error=access_denied&error_description=The+user+denied')
    const tarjeta = await screen.findByTestId('auth-callback-error')
    expect(tarjeta.querySelector('h1')?.textContent).toBe('No iniciaste sesión')
    expect(tarjeta.textContent).toContain('Cancelaste el inicio de sesión con Google.')

    fireEvent.click(screen.getByTestId('auth-callback-volver'))
    await waitFor(() => expect(ruta()).toBe('/login'))
    loginUsable()

    // El destino del intento cancelado se respeta en el siguiente ingreso.
    fireEvent.change(screen.getByTestId('login-email'), { target: { value: EMAIL } })
    fireEvent.change(screen.getByTestId('login-password'), { target: { value: 'segura-123' } })
    fireEvent.click(screen.getByTestId('login-submit'))
    await waitFor(() => expect(ruta()).toBe('/orders'))
    expect(guardado()).toBeNull()
  })

  it('G8. no hay temporizador: mientras el navegador sale, la espera no se corta sola', async () => {
    montar('/login')
    await irAGoogle()
    vi.useFakeTimers()
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60 * 1000) })
    vi.useRealTimers()
    esperaDeGoogle()
    // Sólo la vuelta real la deshace.
    volverDelHistorial()
    loginUsable()
  })

  it('G9. desmontado, el login deja de escuchar la vuelta (historial y navegación interrumpida)', async () => {
    const navegacion = instalarNavigationApi()
    const quitar = vi.spyOn(window, 'removeEventListener')
    const quitarNav = vi.spyOn(navegacion, 'removeEventListener')
    const vista = montar('/login')
    await irAGoogle()
    vista.unmount()
    expect(quitar.mock.calls.some(([tipo]) => tipo === 'pageshow')).toBe(true)
    expect(quitarNav.mock.calls.some(([tipo]) => tipo === 'navigateerror')).toBe(true)
    quitar.mockRestore()
    quitarNav.mockRestore()
    // Ninguna de las dos señales toca el storage de una pantalla que ya no está.
    window.sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, '/orders')
    volverDelHistorial()
    navegacionInterrumpida(navegacion)
    expect(guardado()).toBe('/orders')
  })

  it.each([
    ['existente', [{ id: USER_ID, user_id: USER_ID, business_id: '22222222-2222-4222-8222-222222222222', role: 'owner', is_active: true, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' }], '/dashboard'],
    ['nueva', null, '/dashboard'],
  ])('G10. la vuelta de Google con sesión no cambia (cuenta %s)', async (_cuenta, perfil, destino) => {
    estado.perfil = perfil
    estado.session = { user: { id: USER_ID, email: EMAIL, email_confirmed_at: '2026-10-01T00:00:00Z' } }
    window.sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, '/dashboard')
    window.history.replaceState({}, '', '/auth/callback')
    montar('/auth/callback')
    // `/dashboard` lo resuelve el guard del producto (con o sin negocio); acá se
    // mide que el callback siga mandando al destino y lo consuma.
    await waitFor(() => expect(ruta()).toBe(destino))
    expect(guardado()).toBeNull()
  })

  it('G11. la carga hacia Google se detiene antes de salir: el login queda usable y sin el destino del intento', async () => {
    const navegacion = instalarNavigationApi()
    montar('/login?redirectTo=%2Forders')
    await irAGoogle()
    esperaDeGoogle()
    expect(guardado()).toBe('/orders')

    navegacionInterrumpida(navegacion)
    loginUsable()
    expect(guardado()).toBeNull()
    expect(screen.queryByTestId('login-error')).toBeNull()
    expect(ruta()).toBe('/login?redirectTo=%2Forders')

    // Y Google se puede volver a intentar, con el destino pedido.
    await irAGoogle()
    expect(estado.oauth).toBe(2)
    expect(guardado()).toBe('/orders')
  })

  it('G12. una navegación fallida sin ida a Google no toca nada', async () => {
    const navegacion = instalarNavigationApi()
    window.sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, '/orders')
    montar('/login')
    await screen.findByTestId('login-google')
    navegacionInterrumpida(navegacion)
    expect(guardado()).toBe('/orders')
    loginUsable()
  })

  it('G13. sin Navigation API el login monta igual y la vuelta del historial sigue cubierta', async () => {
    quitarNavigationApi()
    expect('navigation' in window).toBe(false)
    montar('/login')
    await irAGoogle()
    volverDelHistorial()
    loginUsable()
    expect(guardado()).toBeNull()
  })
})

describe('HOTFIX · contrato del código', () => {
  it('la recuperación está atada al ciclo de navegación, no a un temporizador', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join } = await import('node:path')
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/pages/Login.tsx'), 'utf8')
    const efecto = src.slice(src.indexOf('const deshacerIdaAGoogle'), src.indexOf('const handleGoogleSignIn'))
    expect(efecto).toContain('if (!googleEnCursoRef.current) return')
    expect(efecto).toContain('clearPostLoginRedirect()')
    expect(efecto).toContain('if (event.persisted) deshacerIdaAGoogle()')
    expect(efecto).toContain("addEventListener('navigateerror', deshacerIdaAGoogle)")
    expect(efecto).toContain("window.removeEventListener('pageshow', alVolverDelHistorial)")
    expect(efecto).toContain("removeEventListener('navigateerror', deshacerIdaAGoogle)")
    const recuperacion = efecto.slice(0, efecto.indexOf('}, [])'))
    expect(recuperacion).not.toMatch(/setTimeout|setInterval/)
    const google = src.slice(src.indexOf('const handleGoogleSignIn'), src.indexOf('const disabled ='))
    expect(google).not.toMatch(/setTimeout|setInterval/)
    // Se marca antes de pedir la redirección.
    expect(google.indexOf('googleEnCursoRef.current = true')).toBeLessThan(google.indexOf('await signInWithGoogle()'))
  })
})
