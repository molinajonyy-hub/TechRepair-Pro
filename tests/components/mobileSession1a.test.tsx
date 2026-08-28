// ─────────────────────────────────────────────────────────────────────────────
// MOBILE-SESSION-1A — Una falla de conectividad NO vence una sesión válida.
//
// EL DEFECTO: al despertar, `getSession()` fallaba por red, el `refreshSession()`
// de rescate fallaba también, y eso se reportaba como «Tu sesión venció» + un
// `navigate('/login')`. Como AuthContext seguía teniendo usuario, /login rebotaba
// de vuelta al dashboard: un rebote visible, con la sesión intacta, justo en el
// escenario diario de un técnico moviéndose por señal débil.
//
// Los casos B/C/D/E de abajo fallan contra el código anterior. Los A/F/G son el
// contrato que NO se puede romper al arreglarlo: la sesión persistida sigue
// funcionando y la pérdida real de auth sigue siendo de AuthContext.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { useEffect } from 'react'

// ── Dobles ───────────────────────────────────────────────────────────────────

const estado = vi.hoisted(() => ({
  getSession: null as unknown as ReturnType<typeof vi.fn>,
  refreshSession: null as unknown as ReturnType<typeof vi.fn>,
  signOut: null as unknown as ReturnType<typeof vi.fn>,
  removeItem: null as unknown as ReturnType<typeof vi.fn>,
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: (...a: unknown[]) => estado.getSession(...a),
      refreshSession: (...a: unknown[]) => estado.refreshSession(...a),
      signOut: (...a: unknown[]) => estado.signOut(...a),
    },
  },
}))

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ businessId: 'biz-de-prueba' }),
}))

vi.mock('../../src/services/refreshCriticalData', () => ({
  forcePrefetch: vi.fn(),
}))

import { useAppWakeUp, type AppStatus } from '../../src/hooks/useAppWakeUp'
import { SystemStatusProvider, useSystemStatus } from '../../src/contexts/SystemStatusContext'

// ── Helpers ──────────────────────────────────────────────────────────────────

const SESION = {
  access_token: 'access-de-prueba',
  refresh_token: 'refresh-de-prueba',
  user: { id: 'u1' },
}

/** `getSession()` OK. */
const conSesion = () => ({ data: { session: SESION }, error: null })
/** `getSession()` tras un refresh que falló por red: null CON error. */
const sinRed = () => ({
  data: { session: null },
  error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 },
})
/** `getSession()` sin nada en storage: null SIN error. Único caso terminal. */
const sinSesion = () => ({ data: { session: null }, error: null })

const setOnline = (valor: boolean) => {
  Object.defineProperty(window.navigator, 'onLine', { value: valor, configurable: true })
}

/** Arnés que expone el `triggerRefresh` del hook y acumula los estados vistos. */
const arnes = { trigger: (() => {}) as () => void, estados: [] as AppStatus[] }

function Harness() {
  const { triggerRefresh } = useAppWakeUp({
    onStatusChange: (s) => { arnes.estados.push(s) },
  })
  useEffect(() => { arnes.trigger = triggerRefresh })
  return null
}

/**
 * Lee el CÓDIGO de un archivo del repo, sin comentarios.
 *
 * Los comentarios de estos archivos explican justamente qué se retiró y por
 * qué, así que nombran `refreshSession`, `navigate` y la copia vieja:
 * analizarlos daría un falso positivo y obligaría a borrar la documentación del
 * fix para que el test pase.
 */
async function leerCodigo(rel: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  const { resolve } = await import('node:path')
  const src = await readFile(resolve(process.cwd(), rel), 'utf8')
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
}

/** Registra la ruta actual para probar que nadie navega a /login. */
const ruta = { actual: '/dashboard' }
function LocationProbe() {
  const loc = useLocation()
  ruta.actual = loc.pathname
  return null
}

function StatusProbe() {
  const { status, triggerRefresh } = useSystemStatus()
  useEffect(() => { arnes.trigger = triggerRefresh })
  return <span data-testid="estado">{status}</span>
}

const renderProvider = () =>
  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <LocationProbe />
      <Routes>
        <Route path="/login" element={<span data-testid="pantalla-login">login</span>} />
        <Route
          path="/dashboard"
          element={<SystemStatusProvider><StatusProbe /></SystemStatusProvider>}
        />
      </Routes>
    </MemoryRouter>,
  )

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  arnes.estados = []
  ruta.actual = '/dashboard'
  setOnline(true)
  estado.getSession = vi.fn(async () => conSesion())
  estado.refreshSession = vi.fn(async () => ({ data: { session: SESION }, error: null }))
  estado.signOut = vi.fn(async () => ({ error: null }))
})

afterEach(() => {
  vi.useRealTimers()
  setOnline(true)
})

// ═══════════════════════════════════════════════════════════════════════════
// A · sesión válida — el comportamiento que YA funciona y no se puede romper
// ═══════════════════════════════════════════════════════════════════════════

describe('A · wake-up con sesión válida', () => {
  it('A1. termina online y NUNCA reporta session_expired', async () => {
    render(<Harness />)
    await act(async () => { arnes.trigger() })

    expect(arnes.estados.at(-1)).toBe('online')
    expect(arnes.estados).not.toContain('session_expired')
  })

  it('A2. NO dispara un segundo refresh: getSession ya renueva por dentro', async () => {
    render(<Harness />)
    await act(async () => { arnes.trigger() })

    expect(estado.getSession).toHaveBeenCalledTimes(1)
    // El `refreshSession()` de rescate era el segundo bucle de renovación y la
    // fuente del falso vencimiento. No debe existir más en este camino.
    expect(estado.refreshSession).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// B · sin conexión declarada por el navegador
// ═══════════════════════════════════════════════════════════════════════════

describe('B · navigator.onLine === false', () => {
  it('B1. queda offline, sin session_expired y sin ir al login', async () => {
    setOnline(false)
    render(<Harness />)
    await act(async () => { arnes.trigger() })

    expect(arnes.estados.at(-1)).toBe('offline')
    expect(arnes.estados).not.toContain('session_expired')
    expect(ruta.actual).toBe('/dashboard')
  })

  it('B2. ni siquiera consulta la sesión estando offline', async () => {
    setOnline(false)
    render(<Harness />)
    await act(async () => { arnes.trigger() })

    expect(estado.getSession).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// C · EL BUG — fallo reintentable de red
// ═══════════════════════════════════════════════════════════════════════════

describe('C · getSession falla por red (reintentable)', () => {
  it('C1. reporta reconnecting, JAMÁS session_expired', async () => {
    estado.getSession = vi.fn(async () => sinRed())
    render(<Harness />)
    await act(async () => { arnes.trigger() })

    expect(arnes.estados).toContain('reconnecting')
    expect(arnes.estados).not.toContain('session_expired')
  })

  it('C2. no cierra sesión ni toca el storage de auth', async () => {
    estado.getSession = vi.fn(async () => sinRed())
    render(<Harness />)
    await act(async () => { arnes.trigger() })

    // auth-js conserva la sesión local a propósito ante errores reintentables.
    // Este camino no puede deshacer esa decisión por su cuenta.
    expect(estado.signOut).not.toHaveBeenCalled()
    expect(estado.refreshSession).not.toHaveBeenCalled()
  })

  it('C3. una excepción cruda de fetch tampoco vence la sesión', async () => {
    estado.getSession = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    render(<Harness />)
    await act(async () => { arnes.trigger() })

    expect(arnes.estados).toContain('reconnecting')
    expect(arnes.estados).not.toContain('session_expired')
    expect(estado.signOut).not.toHaveBeenCalled()
  })

  it('C4. la revalidación periódica tampoco infiere vencimiento por red', async () => {
    estado.getSession = vi.fn(async () => sinRed())
    render(<Harness />)

    // 4 min = un tick del intervalo de revalidación.
    await act(async () => { await vi.advanceTimersByTimeAsync(4 * 60 * 1000) })

    expect(estado.getSession).toHaveBeenCalled()
    expect(arnes.estados).not.toContain('session_expired')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// D · recuperación al volver la señal
// ═══════════════════════════════════════════════════════════════════════════

describe('D · vuelve la conectividad', () => {
  it('D1. el reintento propio recupera a online, sin logout', async () => {
    estado.getSession = vi.fn(async () => sinRed())
    render(<Harness />)
    await act(async () => { arnes.trigger() })
    expect(arnes.estados).toContain('reconnecting')

    // Vuelve la señal; el reintento de 10 s ya está programado.
    estado.getSession = vi.fn(async () => conSesion())
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })

    expect(arnes.estados.at(-1)).toBe('online')
    expect(arnes.estados).not.toContain('session_expired')
    expect(estado.signOut).not.toHaveBeenCalled()
  })

  it('D2. el evento `online` del navegador redispara la revalidación', async () => {
    estado.getSession = vi.fn(async () => sinRed())
    render(<Harness />)
    await act(async () => { arnes.trigger() })

    estado.getSession = vi.fn(async () => conSesion())
    setOnline(true)
    // El debounce de wake son 4 s; se pasa el reloj antes de reconectar.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    await act(async () => { window.dispatchEvent(new Event('online')) })

    expect(arnes.estados.at(-1)).toBe('online')
    expect(arnes.estados).not.toContain('session_expired')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// E · el único caso terminal se preserva
// ═══════════════════════════════════════════════════════════════════════════

describe('E · auth-js confirma que no hay sesión guardada', () => {
  it('E1. sí reporta session_expired cuando NO hay error de red', async () => {
    estado.getSession = vi.fn(async () => sinSesion())
    render(<Harness />)
    await act(async () => { arnes.trigger() })

    expect(arnes.estados).toContain('session_expired')
  })

  it('E2. aun así NO navega: eso es de ProtectedRoute, no de este hook', async () => {
    estado.getSession = vi.fn(async () => sinSesion())
    renderProvider()
    await act(async () => { arnes.trigger() })

    expect(ruta.actual).toBe('/dashboard')
    expect(screen.queryByTestId('pantalla-login')).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// F · SystemStatusProvider — el botón «Reconectar» y la copia al usuario
// ═══════════════════════════════════════════════════════════════════════════

describe('F · reconexión manual', () => {
  it('F1. sin señal NO manda al login y habla de conexión, no de sesión', async () => {
    estado.getSession = vi.fn(async () => sinRed())
    renderProvider()
    await act(async () => { arnes.trigger() })

    expect(ruta.actual).toBe('/dashboard')
    expect(screen.queryByTestId('pantalla-login')).toBeNull()
    expect(screen.getByTestId('estado')).toHaveTextContent('reconnecting')
    expect(screen.queryByText(/sesión venció/i)).toBeNull()
    expect(screen.getByText(/Sin conexión/i)).toBeInTheDocument()
  })

  it('F2. con señal reconecta normalmente', async () => {
    renderProvider()
    await act(async () => { arnes.trigger() })

    expect(screen.getByTestId('estado')).toHaveTextContent('online')
    expect(ruta.actual).toBe('/dashboard')
  })

  it('F3. la copia «Tu sesión venció» ya no la puede emitir el provider', async () => {
    const codigo = await leerCodigo('src/contexts/SystemStatusContext.tsx')
    expect(codigo).not.toMatch(/sesión venció/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// G · estructura — una sola autoridad de auth
// ═══════════════════════════════════════════════════════════════════════════

describe('G · autoridad de autenticación', () => {
  const leer = leerCodigo

  it('G1. useAppWakeUp no navega ni cierra sesión', async () => {
    const src = await leer('src/hooks/useAppWakeUp.ts')
    expect(src).not.toMatch(/react-router/)
    expect(src).not.toMatch(/useNavigate|navigate\(/)
    expect(src).not.toMatch(/signOut\(/)
    // El segundo bucle de renovación no vuelve.
    expect(src).not.toMatch(/refreshSession\(/)
  })

  it('G2. SystemStatusContext no redirige a /login', async () => {
    const src = await leer('src/contexts/SystemStatusContext.tsx')
    expect(src).not.toMatch(/useNavigate/)
    expect(src).not.toMatch(/navigate\(\s*['"]\/login/)
  })

  it('G3. el hook ya no expone un callback de sesión vencida', async () => {
    const src = await leer('src/hooks/useAppWakeUp.ts')
    // `onSessionExpired` sólo tenía un consumidor y era el redirect especulativo.
    expect(src).not.toMatch(/onSessionExpired/)
  })

  it('G4. ProtectedRoute sigue siendo el que decide por authState', async () => {
    const src = await leer('src/components/auth/ProtectedRoute.tsx')
    expect(src).toMatch(/authState/)
    expect(src).toMatch(/case 'UNAUTHENTICATED':/)
    expect(src).toMatch(/Navigate to="\/login"/)
  })

  it('G5. la config del cliente Supabase queda intacta', async () => {
    const src = await leer('src/lib/supabase.ts')
    expect(src).toMatch(/persistSession:\s*true/)
    expect(src).toMatch(/autoRefreshToken:\s*true/)
    expect(src).toMatch(/detectSessionInUrl:\s*true/)
    // Sin storage propio, sin storageKey, sin persistencia manual.
    expect(src).not.toMatch(/storageKey/)
    expect(src).not.toMatch(/storage:/)
  })
})
