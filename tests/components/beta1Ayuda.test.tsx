// ─────────────────────────────────────────────────────────────────────────────
// BETA-1 · Entrada «Ayuda».
//
//   A1  sidebar desktop muestra Ayuda
//   A2  el drawer «Más» de mobile muestra Ayuda
//   A3  es para cualquier miembro: no depende de capacidades ni del plan
//   A4  la página usa el canal canónico de `config/contacto.ts`
//   A5  la pantalla global de error ofrece el mismo canal
//   A6  la ruta existe, fuera de los guards de capacidad
//
// `Sidebar` y `useSidebar` corren de verdad; el borde mockeado es auth.
// ─────────────────────────────────────────────────────────────────────────────
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { readFileSync } from 'node:fs'

// Número de fantasía: no es un teléfono asignable.
const WHATSAPP_TEST = '5490000000000'

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ signOut: async () => undefined }),
}))

// `MainLayout` (sólo se usa su función pura de títulos) arrastra el cliente.
vi.mock('../../src/lib/supabase', () => ({
  supabase: { from: () => ({}), rpc: async () => ({ data: null, error: null }) },
}))

import { Sidebar } from '../../src/components/layout/Sidebar'
import { Ayuda } from '../../src/pages/Ayuda'
import { PremiumErrorBoundary } from '../../src/components/ui/PremiumErrorBoundary'
import { useSidebar } from '../../src/hooks/useSidebar'
import { mobilePageTitle } from '../../src/layouts/MainLayout'
import { isNavigationItemAuthorized, type NavigationAccess } from '../../src/hooks/useNavigationAccess'
import { effectivePermissions } from '../../src/hooks/usePermissions'
import { CONTACTO_SOPORTE, MENSAJE_SOPORTE_DEFAULT, canalSoporte } from '../../src/config/contacto'

const accessPara = (rol: string): NavigationAccess => {
  const perms = effectivePermissions(rol, rol === 'owner', null)
  return {
    can: k => perms[k],
    hasFeature: () => true,
    isSystemOwner: false,
    mayoristaEnabled: true,
    wholesale: { canAccess: false } as NavigationAccess['wholesale'],
    portalClic: false,
  }
}

/** Sin NINGUNA capacidad ni feature: el peor caso para un item de menú. */
const SIN_NADA: NavigationAccess = {
  can: () => false,
  hasFeature: () => false,
  isSystemOwner: false,
  mayoristaEnabled: false,
  wholesale: { canAccess: false } as NavigationAccess['wholesale'],
  portalClic: false,
}

function Ruta() {
  return <span data-testid="ruta">{useLocation().pathname}</span>
}

/** Botón «Más» de la barra móvil: abre el mismo drawer que usa la app. */
function AbrirMas() {
  const { toggleMobileSidebar } = useSidebar()
  return <button type="button" onClick={toggleMobileSidebar}>abrir-mas</button>
}

function montarSidebar(access: NavigationAccess, primarios: string[] = []) {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Sidebar access={access} mobilePrimaryPaths={primarios} />
      <AbrirMas />
      <Ruta />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.stubEnv('VITE_CONTACT_WHATSAPP', WHATSAPP_TEST)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// ═══════════════════════════════════════════════════════════════════════════
describe('A1–A3 · Ayuda en la navegación', () => {
  it('A1. el sidebar desktop muestra «Ayuda» y lleva a /ayuda', () => {
    montarSidebar(accessPara('owner'))
    const nav = screen.getByRole('navigation', { name: 'Navegación lateral' })
    const item = within(nav).getByRole('link', { name: 'Ayuda' })
    expect(item).toHaveAttribute('href', '/ayuda')
    fireEvent.click(item)
    expect(screen.getByTestId('ruta')).toHaveTextContent('/ayuda')
  })

  it('A2. el drawer «Más» de mobile muestra «Ayuda»', () => {
    // Con los destinos primarios de un owner fuera del drawer, como en la app.
    montarSidebar(accessPara('owner'), ['/dashboard', '/orders', '/comprobantes', '/customers'])
    // Cerrado, el drawer no expone nada a las tecnologías de asistencia.
    expect(screen.queryByRole('dialog', { name: 'Más módulos' })).toBeNull()

    act(() => { fireEvent.click(screen.getByRole('button', { name: 'abrir-mas' })) })
    const drawer = screen.getByRole('dialog', { name: 'Más módulos' })
    const item = within(drawer).getByRole('link', { name: 'Ayuda' })
    expect(item).toHaveAttribute('href', '/ayuda')
    // Target táctil del drawer móvil.
    expect(item.style.minHeight).toBe('44px')

    fireEvent.click(item)
    expect(screen.getByTestId('ruta')).toHaveTextContent('/ayuda')
    // Navegar cierra el drawer.
    expect(screen.queryByRole('dialog', { name: 'Más módulos' })).toBeNull()
  })

  it.each(['owner', 'admin', 'manager', 'sales', 'cashier', 'tech', 'viewer'])(
    'A3. %s ve «Ayuda» (no depende de capacidades)',
    (rol) => {
      montarSidebar(accessPara(rol))
      const nav = screen.getByRole('navigation', { name: 'Navegación lateral' })
      expect(within(nav).getByRole('link', { name: 'Ayuda' })).toBeInTheDocument()
    },
  )

  it('A3. sin ninguna capacidad ni feature, Ayuda sigue estando', () => {
    montarSidebar(SIN_NADA)
    const nav = screen.getByRole('navigation', { name: 'Navegación lateral' })
    expect(within(nav).getByRole('link', { name: 'Ayuda' })).toBeInTheDocument()
    // Y lo que SÍ tiene gate sigue oculto: Ayuda no abrió nada más.
    expect(within(nav).queryByRole('link', { name: 'Suscripción' })).toBeNull()
    expect(within(nav).queryByRole('link', { name: 'Usuarios' })).toBeNull()
  })

  it('A3. el item no declara ningún gate en el contrato de navegación', () => {
    const src = readFileSync('src/components/layout/Sidebar.tsx', 'utf8')
    const linea = src.split('\n').find(l => l.includes("path: '/ayuda'")) ?? ''
    expect(linea).toContain("label: 'Ayuda'")
    expect(linea).not.toMatch(/permission|planFeature|systemOwner|wholesaleView|clicPortalManage/)
    expect(isNavigationItemAuthorized({}, SIN_NADA)).toBe(true)
  })

  it('la barra móvil titula la pantalla «Ayuda»', () => {
    expect(mobilePageTitle('/ayuda')).toBe('Ayuda')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('A4 · página de Ayuda', () => {
  const montar = () => render(<MemoryRouter><Ayuda /></MemoryRouter>)

  it('título, texto corto y un CTA al canal canónico', () => {
    montar()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Ayuda de TechRepair Pro')
    expect(screen.getByText('Si algo te impide continuar durante la beta, escribinos y te ayudamos.')).toBeInTheDocument()

    const ctas = screen.getAllByRole('link')
    expect(ctas).toHaveLength(1)
    const cta = screen.getByTestId('support-contact-cta')
    expect(cta).toHaveTextContent('Hablar por WhatsApp')
    expect(cta).toHaveAttribute('href', canalSoporte().url)
    expect(cta).toHaveAttribute('href', `https://wa.me/${WHATSAPP_TEST}?text=${encodeURIComponent(MENSAJE_SOPORTE_DEFAULT)}`)
    expect(cta).toHaveAttribute('target', '_blank')
    expect(cta).toHaveAttribute('rel', 'noopener noreferrer')
    expect(cta).toHaveAttribute('data-support-channel', 'whatsapp')
  })

  it('con WhatsApp configurado NO presenta el correo como canal de soporte', () => {
    montar()
    expect(document.body.textContent).not.toContain(CONTACTO_SOPORTE)
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull()
  })

  it('el CTA respeta el target táctil de 44px', () => {
    montar()
    expect(screen.getByTestId('support-contact-cta').style.minHeight).toBe('44px')
  })

  // BETA-UX-1A cambió este contrato: sin WhatsApp la página caía al correo
  // institucional, que nadie atiende como soporte. Ahora lo dice y no enlaza.
  it('sin WhatsApp configurado NO cae al correo: avisa que el canal no está disponible', () => {
    vi.stubEnv('VITE_CONTACT_WHATSAPP', '')
    montar()
    expect(screen.queryByTestId('support-contact-cta')).toBeNull()
    const aviso = screen.getByTestId('support-contact-unavailable')
    expect(aviso).toHaveTextContent('La ayuda por WhatsApp no está disponible en este momento.')
    expect(aviso).toHaveAttribute('data-support-channel', 'no_disponible')
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull()
    expect(document.body.textContent).not.toContain(CONTACTO_SOPORTE)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('A5 · pantalla global de error', () => {
  function Rompe(): never {
    throw new Error('boom de prueba')
  }

  it('ofrece el canal de ayuda canónico con un enlace que no depende del router', () => {
    // React y el logger reportan el crash por consola; es el comportamiento esperado.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<PremiumErrorBoundary context="App"><Rompe /></PremiumErrorBoundary>)

    expect(screen.getByText('Algo salió mal')).toBeInTheDocument()
    const ayuda = screen.getByTestId('error-boundary-help')
    expect(ayuda.tagName).toBe('A')
    expect(ayuda).toHaveTextContent('Hablar por WhatsApp')
    expect(ayuda.getAttribute('href')).toContain(`https://wa.me/${WHATSAPP_TEST}?text=`)
    // Se montó SIN router: el enlace funciona igual.
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument()
  })

  it('el fallback compacto de los modales no cambia', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<PremiumErrorBoundary compact><Rompe /></PremiumErrorBoundary>)
    expect(screen.queryByTestId('error-boundary-help')).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('A6 · ruta', () => {
  const app = readFileSync('src/App.tsx', 'utf8')

  it('/ayuda existe una sola vez, dentro del layout y fuera de los guards de capacidad', () => {
    expect(app.match(/path="\/ayuda"/g)).toHaveLength(1)
    const layout = app.indexOf('<Route element={<MainLayout />}>')
    const personal = app.indexOf('<Route element={<PersonalProtectedRoute />}>')
    const ruta = app.indexOf('path="/ayuda"')
    expect(ruta).toBeGreaterThan(layout)
    expect(ruta).toBeLessThan(personal)
    // Hermana de /tutorials y /subscription/suspended: sin ProtectedRouteBy* encima.
    const desdeSuspended = app.slice(app.indexOf('path="/subscription/suspended"'), ruta)
    expect(desdeSuspended).not.toMatch(/<Route element=\{<ProtectedRouteBy/)
  })

  it('la ruta renderiza la página', () => {
    render(
      <MemoryRouter initialEntries={['/ayuda']}>
        <Routes><Route path="/ayuda" element={<Ayuda />} /></Routes>
      </MemoryRouter>,
    )
    expect(screen.getByTestId('ayuda-page')).toBeInTheDocument()
  })

  it('SubscriptionGuard exime /ayuda', () => {
    const guard = readFileSync('src/components/subscription/SubscriptionGuard.tsx', 'utf8')
    expect(guard).toMatch(/ALLOWED_PATHS = \['\/subscription', '\/settings', '\/ayuda'\]/)
  })
})
