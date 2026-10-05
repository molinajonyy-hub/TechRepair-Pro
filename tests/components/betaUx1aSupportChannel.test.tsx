// ─────────────────────────────────────────────────────────────────────────────
// BETA-UX-1A · Ayuda que realmente llega.
//
// En producción el canal de ayuda apuntó a `+594…` (una transposición de
// `+549`), y las pantallas previas al negocio mandaban a una casilla que nadie
// atiende como soporte. Este archivo fija el contrato nuevo:
//
//   N  número: sólo un celular argentino `549` + 10 dígitos es configuración válida
//   C  canal: WhatsApp cuando está configurado; si no, `no_disponible` —
//      nunca la casilla institucional
//   M  mensaje: texto fijo de un conjunto cerrado, bien codificado y sin datos
//      del usuario ni del negocio
//   P  pantallas previas al negocio: usan el canal canónico
//   U  todas las superficies de ayuda terminan en el mismo número, incluidos
//      los correos de Supabase Auth (que lo llevan escrito en la plantilla)
//   G  control de fuente: una sola autoridad, sin teléfonos en el código
//
// El guard de BUILD (que `vite build` falle con un valor inválido) se prueba en
// `scripts/guards/support-contact.mjs --self-test`, contra el vite.config real.
//
// Bordes mockeados: AuthContext (estado de sesión), provisioning y Supabase.
// Las pantallas, `config/contacto.ts` y los componentes de ayuda corren de verdad.
// ─────────────────────────────────────────────────────────────────────────────
import type { ReactElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// Número de soporte confirmado por el owner (2026-10-05). Es público: lo publica
// el pie de la landing. La app lo lee de VITE_CONTACT_WHATSAPP, nunca del código.
const SOPORTE = '5493574404419'
const BASE = `https://wa.me/${SOPORTE}?text=`

const EMAIL_USUARIO = 'titular@example.test'
const EMAIL_PENDIENTE = 'pendiente@example.test'

const auth = vi.hoisted(() => ({
  valor: {} as Record<string, unknown>,
  emailPendiente: null as string | null,
}))

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => auth.valor,
  readPendingConfirmationEmail: () => auth.emailPendiente,
  clearPendingConfirmationEmail: () => undefined,
}))

vi.mock('../../src/services/provisioningService', () => ({
  provisionMyBusiness: async () => ({ status: 'created' }),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
    },
    from: () => ({}),
    rpc: async () => ({ data: null, error: null }),
  },
}))

vi.mock('../../src/lib/analytics', () => ({
  initLandingAnalytics: () => undefined,
  track: () => undefined,
}))

vi.mock('../../src/hooks/useTheme', () => ({
  useTheme: () => ({ resolvedTheme: 'light', setTheme: () => undefined }),
}))

import {
  CONTACTO_SOPORTE,
  MENSAJES_SOPORTE,
  canalSoporte,
  normalizarWhatsApp,
  validarWhatsAppSoporte,
  whatsappSoporte,
  type MotivoSoporte,
} from '../../src/config/contacto'
import { NoBusiness } from '../../src/pages/NoBusiness'
import { VerifyEmail } from '../../src/pages/VerifyEmail'
import { ResetPassword } from '../../src/pages/ResetPassword'
import { Ayuda } from '../../src/pages/Ayuda'
import { LandingPage } from '../../src/pages/LandingPage'
import { PremiumErrorBoundary } from '../../src/components/ui/PremiumErrorBoundary'
import { PLANTILLAS, WHATSAPP_SOPORTE as WHATSAPP_PLANTILLAS, enlaceSoporteDe } from '../../scripts/guards/auth-email-templates.mjs'

const MOTIVOS = Object.keys(MENSAJES_SOPORTE) as MotivoSoporte[]

const sesion = (over: Record<string, unknown> = {}) => ({
  user: { id: 'u-1', email: EMAIL_USUARIO },
  authState: 'AUTHENTICATED_WITHOUT_BUSINESS',
  profileErrorKind: null,
  isAuthenticated: true,
  loading: false,
  emailConfirmed: true,
  refreshProfile: async () => undefined,
  refreshUser: async () => false,
  resendConfirmation: async () => ({ status: 'error' }),
  signOut: async () => undefined,
  ...over,
})

const enRouter = (ui: ReactElement, ruta = '/') => render(<MemoryRouter initialEntries={[ruta]}>{ui}</MemoryRouter>)

/** El texto precargado tal como lo recibe WhatsApp. */
const textoDe = (href: string | null | undefined) => new URL(href ?? '').searchParams.get('text')

beforeAll(() => {
  class IO {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return [] }
  }
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IO
  if (!window.matchMedia) {
    ;(window as unknown as { matchMedia: unknown }).matchMedia = () => ({
      matches: true, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
    })
  }
})

beforeEach(() => {
  auth.valor = sesion()
  auth.emailPendiente = null
  window.localStorage.clear()
  window.sessionStorage.clear()
  vi.stubEnv('VITE_CONTACT_WHATSAPP', SOPORTE)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// ═══════════════════════════════════════════════════════════════════════════
describe('N · formato del número de soporte', () => {
  it('el número productivo es válido y queda tal cual', () => {
    expect(validarWhatsAppSoporte(SOPORTE)).toEqual({ ok: true, numero: SOPORTE })
    expect(SOPORTE).toMatch(/^549\d{10}$/)
    expect(SOPORTE).toHaveLength(13)
  })

  it.each([
    ['+54 9 3574 404419'],
    ['+54 9 (3574) 40-4419'],
    ['  5493574404419  '],
  ])('el formato legible %j se normaliza al canónico', (valor) => {
    expect(validarWhatsAppSoporte(valor)).toEqual({ ok: true, numero: SOPORTE })
  })

  it('rechaza la transposición 594 que estuvo en producción, y dice por qué', () => {
    for (const malo of ['5943574404419', '+5943574404419', '+594 3574 404419']) {
      const r = validarWhatsAppSoporte(malo)
      expect(r.ok, malo).toBe(false)
      expect(r.ok ? '' : r.motivo, malo).toMatch(/594/)
    }
    // La regla genérica de antes («10 a 15 dígitos») lo dejaba pasar: por eso se publicó.
    expect(normalizarWhatsApp('+5943574404419')).toBe('5943574404419')
  })

  it('rechaza un celular argentino sin el 9', () => {
    const r = validarWhatsAppSoporte('543574404419')
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.motivo).toMatch(/falta el 9/)
  })

  it.each([
    ['vacío', ''],
    ['sólo espacios', '   '],
    ['undefined', undefined],
    ['null', null],
    ['número local sin país', '3574404419'],
    ['truncado', '549357440441'],
    ['un dígito de más', '54935744044190'],
    ['otro país', '5511987654321'],
    ['letras', 'pendiente'],
    ['basura pegada al número', `${SOPORTE}x`],
    ['una URL', `https://wa.me/${SOPORTE}`],
    ['un + en el medio', '549+3574404419'],
  ])('rechaza %s', (_etiqueta, valor) => {
    const r = validarWhatsAppSoporte(valor as string | null | undefined)
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.motivo).not.toBe('')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('C · canal de soporte', () => {
  it('con el número configurado el canal es WhatsApp a ese número', () => {
    expect(whatsappSoporte()).toBe(SOPORTE)
    const canal = canalSoporte()
    expect(canal).toEqual({
      tipo: 'whatsapp',
      url: `${BASE}${encodeURIComponent(MENSAJES_SOPORTE.general)}`,
      etiqueta: 'Hablar por WhatsApp',
    })
  })

  it('la variable en formato legible publica el mismo enlace, sin + ni espacios', () => {
    vi.stubEnv('VITE_CONTACT_WHATSAPP', '+54 9 3574 404419')
    expect(canalSoporte().url).toBe(`${BASE}${encodeURIComponent(MENSAJES_SOPORTE.general)}`)
  })

  it.each([
    ['ausente', ''],
    ['transposición 594', '+5943574404419'],
    ['sin el 9', '543574404419'],
    ['basura', 'pendiente'],
  ])('configuración %s: no hay enlace y NO cae a la casilla institucional', (_etiqueta, valor) => {
    vi.stubEnv('VITE_CONTACT_WHATSAPP', valor)
    expect(whatsappSoporte()).toBeNull()
    for (const motivo of MOTIVOS) {
      const canal = canalSoporte(motivo)
      expect(canal.tipo).toBe('no_disponible')
      expect(canal.url).toBeNull()
      expect(JSON.stringify(canal)).not.toMatch(/mailto|@|wa\.me/)
      expect(JSON.stringify(canal)).not.toContain(CONTACTO_SOPORTE)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('M · mensaje precargado', () => {
  it.each(MOTIVOS)('%s: va URL-encoded y WhatsApp recibe exactamente el texto fijo', (motivo) => {
    const { url } = canalSoporte(motivo)
    expect(url).toBe(`${BASE}${encodeURIComponent(MENSAJES_SOPORTE[motivo])}`)
    // Nada sin codificar después de `?text=`: ni espacios, ni acentos, ni `&`/`#`/`?`.
    expect((url ?? '').slice(BASE.length)).toMatch(/^[A-Za-z0-9%.,_~!*'()-]+$/)
    expect(textoDe(url)).toBe(MENSAJES_SOPORTE[motivo])
    expect([...new URL(url ?? '').searchParams.keys()]).toEqual(['text'])
  })

  it('los textos son fijos: sin emails, ids, números ni marcadores para interpolar', () => {
    for (const [motivo, texto] of Object.entries(MENSAJES_SOPORTE)) {
      expect(texto, motivo).toMatch(/^Hola, [^@\d{}$<>]+\.$/)
      expect(texto, motivo).toContain('TechRepair Pro')
    }
  })

  it('el default es el mensaje general', () => {
    expect(textoDe(canalSoporte().url)).toBe(MENSAJES_SOPORTE.general)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('P · pantallas previas al negocio', () => {
  /** Lo que tiene que cumplir CUALQUIER salida de ayuda de estas pantallas. */
  function esperarCanalCanonico(enlace: Element | null | undefined, motivo: MotivoSoporte) {
    expect(enlace, 'falta el enlace de ayuda').toBeTruthy()
    const href = enlace?.getAttribute('href')
    expect(href).toBe(canalSoporte(motivo).url)
    expect(href?.startsWith(BASE)).toBe(true)
    expect(enlace?.getAttribute('target')).toBe('_blank')
    expect(enlace?.getAttribute('rel')).toBe('noopener noreferrer')
    // Sin datos del usuario en la URL.
    const texto = textoDe(href) ?? ''
    expect(texto).not.toContain(EMAIL_USUARIO)
    expect(texto).not.toContain(EMAIL_PENDIENTE)
    expect(texto).not.toMatch(/@/)
    // Y la casilla institucional no aparece en la pantalla, ni como texto ni como enlace.
    expect(document.body.textContent).not.toContain(CONTACTO_SOPORTE)
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull()
  }

  it('usuario desactivado → WhatsApp', () => {
    auth.valor = sesion({ authState: 'AUTH_ERROR', profileErrorKind: 'inactive' })
    enRouter(<NoBusiness />)
    expect(screen.getByTestId('no-business-inactive')).toHaveTextContent('Tu acceso a este negocio está desactivado')
    const linea = screen.getByTestId('no-business-inactive-soporte')
    expect(linea).toHaveTextContent('Si sos el titular del negocio, escribinos por WhatsApp.')
    esperarCanalCanonico(linea.querySelector('a'), 'accesoDesactivado')
    // La salida que ya existía sigue estando.
    expect(screen.getByTestId('no-business-inactive-salir')).toBeInTheDocument()
  })

  it('link_failed → WhatsApp (antes decía «Escribinos» sin ningún enlace)', () => {
    auth.valor = sesion({ authState: 'AUTH_ERROR', profileErrorKind: 'link_failed' })
    enRouter(<NoBusiness />)
    expect(screen.getByTestId('no-business-error')).toHaveTextContent('Tu cuenta existe pero no pudimos vincularla a su negocio.')
    const linea = screen.getByTestId('no-business-error-soporte')
    expect(linea).toHaveTextContent('Para resolverlo, escribinos por WhatsApp.')
    esperarCanalCanonico(linea.querySelector('a'), 'negocioNoCarga')
    // Sigue sin ofrecer crear un negocio: no sabemos si ya tiene uno.
    expect(screen.getByTestId('no-business-reintentar')).toBeInTheDocument()
    expect(screen.queryByTestId('no-business-crear')).toBeNull()
  })

  it('error al cargar el negocio (transitorio) → Reintentar + WhatsApp si sigue igual', () => {
    auth.valor = sesion({ authState: 'AUTH_ERROR', profileErrorKind: 'transient' })
    enRouter(<NoBusiness />)
    expect(screen.getByTestId('no-business-error')).toHaveTextContent('Puede ser un problema de conexión.')
    const linea = screen.getByTestId('no-business-error-soporte')
    expect(linea).toHaveTextContent('Si sigue igual, escribinos por WhatsApp.')
    esperarCanalCanonico(linea.querySelector('a'), 'negocioNoCarga')
    expect(screen.getByTestId('no-business-reintentar')).toBeInTheDocument()
  })

  it('verificación de email: reenvío fallido → WhatsApp', async () => {
    auth.valor = sesion({ user: null, isAuthenticated: false, emailConfirmed: false })
    auth.emailPendiente = EMAIL_PENDIENTE
    enRouter(<VerifyEmail />, '/verificar-email')
    // Antes de fallar no se ofrece soporte: la pantalla no cambió su criterio.
    expect(screen.queryByTestId('verify-email-soporte')).toBeNull()
    fireEvent.click(screen.getByTestId('verify-email-reenviar'))
    await waitFor(() => expect(screen.getByTestId('verify-email-estado')).toHaveAttribute('data-estado', 'RESEND_FAILED'))
    const linea = screen.getByTestId('verify-email-soporte')
    expect(linea).toHaveTextContent('Si sigue sin llegar, escribinos por WhatsApp.')
    esperarCanalCanonico(linea.querySelector('a'), 'correoNoLlega')
  })

  it('recuperación de contraseña: enlace inválido → WhatsApp', async () => {
    enRouter(<ResetPassword />, '/reset-password')
    await waitFor(() => expect(screen.getByTestId('reset-password-invalid')).toBeInTheDocument())
    const linea = screen.getByTestId('reset-password-soporte')
    expect(linea).toHaveTextContent('¿No te llega el correo? Escribinos por WhatsApp.')
    esperarCanalCanonico(linea.querySelector('a'), 'recuperarContrasena')
    expect(screen.getByTestId('reset-password-request-new')).toBeInTheDocument()
  })

  it('sin canal configurado ninguna de estas pantallas inventa un contacto', async () => {
    vi.stubEnv('VITE_CONTACT_WHATSAPP', '+5943574404419')

    auth.valor = sesion({ authState: 'AUTH_ERROR', profileErrorKind: 'link_failed' })
    const a = enRouter(<NoBusiness />)
    expect(screen.queryByTestId('no-business-error-soporte')).toBeNull()
    expect(screen.getByTestId('no-business-reintentar')).toBeInTheDocument()
    a.unmount()

    const b = enRouter(<ResetPassword />, '/reset-password')
    await waitFor(() => expect(screen.getByTestId('reset-password-invalid')).toBeInTheDocument())
    expect(screen.queryByTestId('reset-password-soporte')).toBeNull()
    b.unmount()

    expect(document.querySelector('a[href^="mailto:"], a[href*="wa.me"]')).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('U · todas las superficies de ayuda terminan en el mismo número', () => {
  it('Ayuda', () => {
    enRouter(<Ayuda />)
    expect(screen.getByTestId('support-contact-cta').getAttribute('href')).toBe(`${BASE}${encodeURIComponent(MENSAJES_SOPORTE.general)}`)
  })

  it('pantalla global de error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    function Rompe(): never { throw new Error('boom de prueba') }
    render(<PremiumErrorBoundary context="App"><Rompe /></PremiumErrorBoundary>)
    expect(screen.getByTestId('error-boundary-help').getAttribute('href')).toBe(`${BASE}${encodeURIComponent(MENSAJES_SOPORTE.error)}`)
  })

  it('pantalla global de error sin canal: no muestra la línea de ayuda (ni un correo)', () => {
    vi.stubEnv('VITE_CONTACT_WHATSAPP', '')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    function Rompe(): never { throw new Error('boom de prueba') }
    render(<PremiumErrorBoundary context="App"><Rompe /></PremiumErrorBoundary>)
    expect(screen.getByText('Algo salió mal')).toBeInTheDocument()
    expect(screen.queryByTestId('error-boundary-help')).toBeNull()
    expect(document.querySelector('a')).toBeNull()
  })

  it('pie de la landing: el mismo número, normalizado (antes publicaba el valor crudo)', () => {
    vi.stubEnv('VITE_CONTACT_WHATSAPP', '+54 9 3574 404419')
    enRouter(<LandingPage />, '/landing')
    const enlace = screen.getByTestId('landing-whatsapp')
    expect(enlace.getAttribute('href')).toBe(`${BASE}${encodeURIComponent(MENSAJES_SOPORTE.landing)}`)
    expect(enlace.getAttribute('href')).not.toMatch(/wa\.me\/\+|%2B|\s/)
    expect(enlace).toHaveAttribute('aria-label', 'WhatsApp de TechRepair Pro')
  })

  it('pie de la landing con la variable inválida: no publica ningún WhatsApp', () => {
    vi.stubEnv('VITE_CONTACT_WHATSAPP', '+5943574404419')
    enRouter(<LandingPage />, '/landing')
    expect(screen.queryByTestId('landing-whatsapp')).toBeNull()
    expect(document.querySelector('a[href*="wa.me"]')).toBeNull()
  })

  it('correos de Auth (confirmación y recovery): el mismo número, escrito en la plantilla', () => {
    // Supabase Auth renderiza un HTML estático y no lee VITE_CONTACT_WHATSAPP:
    // el número está versionado en las plantillas y en su guard. Si este test
    // falla, la variable y los correos dejaron de apuntar al mismo WhatsApp.
    expect(WHATSAPP_PLANTILLAS).toBe(SOPORTE)
    for (const { archivo, tipo, ayuda } of Object.values(PLANTILLAS)) {
      const html = readFileSync(archivo, 'utf8')
      expect(enlaceSoporteDe(tipo), archivo).toBe(`${BASE}${encodeURIComponent(ayuda)}`)
      expect(html, archivo).toContain(`href="${BASE}${encodeURIComponent(ayuda)}"`)
      expect(html, archivo).not.toMatch(/mailto:/i)
      expect(html, archivo).not.toContain(CONTACTO_SOPORTE)
    }
  })

  it('el muro de suscripción sale por /ayuda, que usa el mismo canal', () => {
    const src = readFileSync('src/pages/SubscriptionSuspended.tsx', 'utf8')
    expect(src).toMatch(/to="\/ayuda"/)
    expect(src).not.toMatch(/mailto:|wa\.me|CONTACTO_SOPORTE/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('G · control de fuente', () => {
  const leer = (p: string) => readFileSync(p, 'utf8')
  const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const fuentes = archivos('src')

  it('sólo config/contacto.ts lee VITE_CONTACT_WHATSAPP', () => {
    const lectores = fuentes.filter(p => /VITE_CONTACT_WHATSAPP/.test(sinComentarios(leer(p)))).map(rel)
    // vite-env.d.ts sólo declara el tipo de la variable.
    expect(lectores.sort()).toEqual(['src/config/contacto.ts', 'src/vite-env.d.ts'])
  })

  it('el número de soporte no está escrito en src/: sale de la variable', () => {
    expect(fuentes.filter(p => leer(p).includes(SOPORTE) || leer(p).includes(SOPORTE.slice(3))).map(rel)).toEqual([])
  })

  it('la casilla institucional sólo la usan la política de privacidad y el pie de la landing', () => {
    const usan = fuentes
      .filter(p => rel(p) !== 'src/config/contacto.ts')
      .filter(p => /CONTACTO_SOPORTE|techrepairpro\.soporte/.test(sinComentarios(leer(p))))
      .map(rel)
    expect(usan.sort()).toEqual(['src/pages/LandingPage.tsx', 'src/pages/Privacidad.tsx'])
  })

  it('las superficies de ayuda del producto no tienen mailto ni arman wa.me', () => {
    for (const p of [
      'src/pages/NoBusiness.tsx',
      'src/pages/VerifyEmail.tsx',
      'src/pages/ResetPassword.tsx',
      'src/pages/Login.tsx',
      'src/pages/Ayuda.tsx',
      'src/pages/SubscriptionSuspended.tsx',
      'src/lib/authErrors.ts',
      'src/components/ui/SupportContactButton.tsx',
      'src/components/ui/PremiumErrorBoundary.tsx',
    ]) {
      const src = sinComentarios(leer(p))
      expect(src, p).not.toMatch(/mailto:/)
      expect(src, p).not.toMatch(/wa\.me|api\.whatsapp\.com/)
      expect(src, p).not.toMatch(/\d{10,}/)
    }
    // La landing conserva el mailto institucional, pero el WhatsApp sale de contacto.ts.
    expect(sinComentarios(leer('src/pages/LandingPage.tsx'))).not.toMatch(/wa\.me/)
  })

  it('canalSoporte se llama con una clave literal (o sin argumentos): nada interpolado', () => {
    const claves = new Set<string>(MOTIVOS)
    const llamadas = fuentes
      .filter(p => rel(p) !== 'src/config/contacto.ts')
      .flatMap(p => [...sinComentarios(leer(p)).matchAll(/canalSoporte\(([^)]*)\)/g)].map(m => ({ archivo: rel(p), arg: m[1].trim() })))
    expect(llamadas.length).toBeGreaterThanOrEqual(7)
    for (const { archivo, arg } of llamadas) {
      const clave = arg.match(/^'([A-Za-z]+)'$/)?.[1]
      expect(arg === '' || (clave !== undefined && claves.has(clave)), `${archivo}: canalSoporte(${arg})`).toBe(true)
    }
  })

  it('el build está cableado al guard del canal de soporte', () => {
    const config = leer('vite.config.ts')
    expect(config).toMatch(/import \{ supportContactGuard \} from '\.\/scripts\/guards\/support-contact-build\.mjs'/)
    expect(sinComentarios(config)).toMatch(/plugins:\s*\[[^\]]*supportContactGuard\(\)/)
    const pkg = JSON.parse(leer('package.json')) as { scripts: Record<string, string> }
    // Vercel corre `npm run build`: tiene que seguir pasando por Vite.
    expect(pkg.scripts.build).toBe('vite build')
    expect(JSON.parse(leer('vercel.json')).buildCommand).toBe('npm run build')
  })
})

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap(e => {
    const p = join(dir, e)
    return statSync(p).isDirectory() ? archivos(p) : /\.(ts|tsx)$/.test(p) ? [p] : []
  })
}

function rel(p: string): string {
  return relative('.', p).split(sep).join('/')
}
