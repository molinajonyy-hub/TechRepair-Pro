// ─────────────────────────────────────────────────────────────────────────────
// BETA-UX-3 — Administración más simple + Centro de ayuda.
//
//   N  navegación: Administración = «Configuración» + «Centro de ayuda», nada más
//   P  permisos: cada actor ve y abre sólo lo suyo (menú, lista y guards)
//   H  enlaces históricos: /users, /currency-settings, /subscription, /tutorials,
//      /ayuda y `?tab=` siguen llegando a su pantalla
//   C  Centro de ayuda: Soporte (canal canónico) + Tutoriales (catálogo)
//   M  móvil: drawer «Más», lista → sección → volver, títulos de la barra
//
// `Sidebar`, `SettingsNav`, `SettingsShell`, `Settings`, el guard y el Centro
// de ayuda corren de verdad; el borde mockeado es auth y el cliente de
// Supabase. Las pantallas de Usuarios, Moneda y Suscripción se reemplazan por
// una sonda: acá se mide DÓNDE se dibujan y QUIÉN entra, no su contenido (eso
// lo cubren sus propios tests, que no cambiaron).
//
// jsdom no aplica index.css: lo pintado (44 px, desborde, contraste, foco
// visible) se mide en `tests/e2e/m7/beta-ux-3-admin-help.spec.ts`.
// ─────────────────────────────────────────────────────────────────────────────
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import type { AppPermissions, PermissionKey } from '../../src/config/permissions'

// Número de fantasía: no es un teléfono asignable.
const WHATSAPP_TEST = '5490000000000'

const auth = vi.hoisted(() => ({
  role: 'owner' as string,
  isOwner: true,
  permissions: null as Partial<Record<string, boolean>> | null,
  tablasLeidas: [] as string[],
}))

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({
    authState: 'AUTHENTICATED',
    user: { id: 'u-beta-ux-3' },
    loading: false,
    profileLoading: false,
    businessId: 'b-beta-ux-3',
    role: auth.role,
    isOwner: auth.isOwner,
    profile: { id: 'u-beta-ux-3', role: auth.role, is_active: true, permissions: auth.permissions },
    signOut: async () => undefined,
  }),
}))

// Cualquier lectura queda registrada: así se mide que un dato NO se pidió.
vi.mock('../../src/lib/supabase', () => {
  const cadena = (tabla: string): Record<string, unknown> => {
    const c: Record<string, unknown> = {
      select: () => { auth.tablasLeidas.push(tabla); return c },
      eq: () => c, order: () => c, limit: () => c, in: () => c,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then: (res: (v: { data: unknown[]; error: null }) => unknown) => res({ data: [], error: null }),
    }
    return c
  }
  return {
    supabase: {
      from: (tabla: string) => cadena(tabla),
      rpc: async (nombre: string) => { auth.tablasLeidas.push(`rpc:${nombre}`); return { data: null, error: null } },
    },
  }
})

import { Sidebar } from '../../src/components/layout/Sidebar'
import { useSidebar } from '../../src/hooks/useSidebar'
import { mobilePageTitle } from '../../src/layouts/MainLayout'
import { isNavigationItemAuthorized, type NavigationAccess } from '../../src/hooks/useNavigationAccess'
import { effectivePermissions } from '../../src/hooks/usePermissions'
import { ProtectedRouteByPermission } from '../../src/components/auth/ProtectedRouteByPermission'
import {
  SETTINGS_GROUPS, SETTINGS_PAGE_PATHS, SETTINGS_PERMISSIONS, SETTINGS_ROUTE_PATHS, SETTINGS_SECTIONS,
  SettingsNav, settingsSectionHref, visibleSettingsGroups,
} from '../../src/components/settings/SettingsNav'
import { SettingsPageRoute } from '../../src/components/settings/SettingsShell'
import Settings from '../../src/pages/Settings'
import { Ayuda } from '../../src/pages/Ayuda'
import { TUTORIAL_GUIDES, TutorialPage } from '../../src/pages/Tutorials'
import { TUTORIALS, tutorialHref, tutorialMeta, type VideoTutorial } from '../../src/config/tutorials'
import { canalSoporte } from '../../src/config/contacto'

const leer = (rel: string) => readFileSync(rel, 'utf8')
const sinComentarios = (texto: string) => texto.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const ROLES = ['owner', 'admin', 'manager', 'sales', 'cashier', 'tech', 'viewer'] as const

function comoActor(rol: string, overrides: Partial<AppPermissions> | null = null) {
  auth.role = rol
  auth.isOwner = rol === 'owner'
  auth.permissions = overrides
}

const permisos = () => effectivePermissions(auth.role, auth.isOwner, auth.permissions)

const accessDelActor = (): NavigationAccess => {
  const p = permisos()
  return {
    can: (k: PermissionKey) => p[k],
    hasFeature: () => true,
    isSystemOwner: false,
    mayoristaEnabled: true,
    wholesale: { canAccess: false } as NavigationAccess['wholesale'],
    portalClic: false,
  }
}

// jsdom no implementa scroll: se registra a qué elemento se le pidió.
const scrolleados: Element[] = []

beforeEach(() => {
  comoActor('owner')
  auth.tablasLeidas = []
  scrolleados.length = 0
  vi.stubEnv('VITE_CONTACT_WHATSAPP', WHATSAPP_TEST)
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolleados.push(this) }
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function Ruta() {
  const location = useLocation()
  return <span data-testid="ruta">{location.pathname}{location.search}{location.hash}</span>
}

function AbrirMas() {
  const { toggleMobileSidebar } = useSidebar()
  return <button type="button" onClick={toggleMobileSidebar}>abrir-mas</button>
}

function montarSidebar(ruta = '/dashboard', primarios: string[] = []) {
  return render(
    <MemoryRouter initialEntries={[ruta]}>
      <Sidebar access={accessDelActor()} mobilePrimaryPaths={primarios} />
      <AbrirMas />
      <Ruta />
    </MemoryRouter>,
  )
}

const navLateral = () => screen.getByRole('navigation', { name: 'Navegación lateral' })

/** Ítems de una sección del menú lateral, en orden. */
function itemsDeSeccion(nav: HTMLElement, seccion: string): string[] {
  const rotulo = within(nav).getByText(seccion)
  const bloque = rotulo.parentElement as HTMLElement
  return within(bloque).getAllByRole('link').map(a => a.textContent?.trim() ?? '')
}

/** Sonda en lugar de las pantallas reales: el marco es lo que se mide. */
const Sonda = ({ nombre }: { nombre: string }) => <div data-testid={`pantalla-${nombre}`}>{nombre}</div>

/** Espejo de las rutas de App.tsx de este lote (el bloque «H · App.tsx» fija que coincidan). */
function montarApp(ruta: string) {
  return render(
    <MemoryRouter initialEntries={[ruta]}>
      <Ruta />
      <Routes>
        <Route element={<ProtectedRouteByPermission permission={SETTINGS_PERMISSIONS} />}>
          <Route path="/settings" element={<Settings />} />
        </Route>
        <Route element={<ProtectedRouteByPermission permission="settings" />}>
          <Route element={<SettingsPageRoute section="moneda" />}>
            <Route path="/currency-settings" element={<Sonda nombre="moneda" />} />
          </Route>
        </Route>
        <Route element={<ProtectedRouteByPermission permission="users" />}>
          <Route element={<SettingsPageRoute section="usuarios" />}>
            <Route path="/users" element={<Sonda nombre="usuarios" />} />
          </Route>
        </Route>
        <Route element={<ProtectedRouteByPermission permission="subscription" />}>
          <Route element={<SettingsPageRoute section="suscripcion" />}>
            <Route path="/subscription" element={<Sonda nombre="suscripcion" />} />
          </Route>
          <Route path="/subscription/plans" element={<Sonda nombre="planes" />} />
        </Route>
        <Route path="/ayuda" element={<Ayuda />} />
        <Route path="/ayuda/tutoriales/:tutorialId" element={<TutorialPage />} />
        <Route path="/tutorials" element={<Navigate to="/ayuda#tutoriales" replace />} />
        <Route path="/dashboard" element={<div data-testid="dashboard">Inicio</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

const listaConfiguracion = () => screen.getByRole('navigation', { name: 'Secciones de configuración' })
const seccionesVisibles = () => within(listaConfiguracion()).getAllByRole('button').map(b => b.textContent?.trim() ?? '')

// ═══════════════════════════════════════════════════════════════════════════
describe('N · Administración en el menú lateral', () => {
  it('N1. el dueño ve sólo «Configuración» y «Centro de ayuda»', () => {
    montarSidebar()
    expect(itemsDeSeccion(navLateral(), 'Administración')).toEqual(['Configuración', 'Centro de ayuda'])
  })

  it('N2. las entradas sueltas ya no existen en ningún lado del menú', () => {
    montarSidebar()
    for (const viejo of ['Usuarios', 'Moneda', 'Suscripción', 'Tutoriales', 'Ayuda']) {
      expect(within(navLateral()).queryByRole('link', { name: viejo }), viejo).toBeNull()
    }
    const src = sinComentarios(leer('src/components/layout/Sidebar.tsx'))
    for (const ruta of ['/users', '/currency-settings', '/subscription', '/tutorials']) {
      expect(src, ruta).not.toContain(`path: '${ruta}'`)
    }
  })

  it('N3. «Configuración» lleva a /settings y «Centro de ayuda» a /ayuda', () => {
    montarSidebar()
    expect(within(navLateral()).getByRole('link', { name: 'Configuración' })).toHaveAttribute('href', '/settings')
    const ayuda = within(navLateral()).getByRole('link', { name: 'Centro de ayuda' })
    expect(ayuda).toHaveAttribute('href', '/ayuda')
    fireEvent.click(ayuda)
    expect(screen.getByTestId('ruta')).toHaveTextContent('/ayuda')
  })

  it.each(['/settings', '/settings?tab=arca', '/users', '/currency-settings', '/subscription', '/subscription/plans'])(
    'N4. «Configuración» queda marcada en %s (no sólo por color)',
    (ruta) => {
      montarSidebar(ruta)
      const item = within(navLateral()).getByRole('link', { name: 'Configuración' })
      expect(item).toHaveAttribute('aria-current', 'page')
      expect(item).toHaveClass('active')
      expect(item.style.fontWeight).toBe('600')
    },
  )

  it('N4. fuera de Configuración el ítem no está marcado', () => {
    montarSidebar('/dashboard')
    const item = within(navLateral()).getByRole('link', { name: 'Configuración' })
    expect(item).not.toHaveAttribute('aria-current')
    expect(item).not.toHaveClass('active')
  })

  it('N5. «Centro de ayuda» queda marcado también dentro de un tutorial', () => {
    montarSidebar('/ayuda/tutoriales/arca')
    expect(within(navLateral()).getByRole('link', { name: 'Centro de ayuda' })).toHaveAttribute('aria-current', 'page')
  })

  it('N6. la lista de capacidades del ítem es la misma que la de las secciones y la del guard', () => {
    expect([...SETTINGS_PERMISSIONS].sort()).toEqual(['settings', 'subscription', 'users'])
    expect(SETTINGS_PERMISSIONS).toEqual([...new Set(SETTINGS_GROUPS.flatMap(g => g.sections.map(s => s.permission)))])
    const sidebar = sinComentarios(leer('src/components/layout/Sidebar.tsx'))
    expect(sidebar).toMatch(/path: '\/settings', label: 'Configuración'[^\n]*anyPermission: SETTINGS_PERMISSIONS/)
    expect(sinComentarios(leer('src/App.tsx'))).toMatch(/permission=\{SETTINGS_PERMISSIONS\}/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('P · permisos (RBAC)', () => {
  it.each(ROLES)('P1. %s: «Configuración» sólo si tiene alguna capacidad de sus secciones; «Centro de ayuda» siempre', (rol) => {
    comoActor(rol)
    montarSidebar()
    const p = permisos()
    const items = itemsDeSeccion(navLateral(), 'Administración')
    expect(items.includes('Configuración'), rol).toBe(p.settings || p.users || p.subscription)
    expect(items).toContain('Centro de ayuda')
  })

  it('P1. con los defaults, sólo owner y admin ven «Configuración»', () => {
    const conConfiguracion = ROLES.filter(rol => {
      const p = effectivePermissions(rol, rol === 'owner', null)
      return isNavigationItemAuthorized({ anyPermission: SETTINGS_PERMISSIONS }, { ...accessDelActor(), can: k => p[k] })
    })
    expect(conConfiguracion).toEqual(['owner', 'admin'])
  })

  it.each([
    ['users', 'Equipo', 'Usuarios y permisos'],
    ['subscription', 'TechRepair Pro', 'Plan y suscripción'],
  ] as const)('P2. un técnico con el override `%s` ve «Configuración» y adentro sólo su sección', (clave, grupo, seccion) => {
    comoActor('tech', { [clave]: true })
    montarSidebar()
    expect(itemsDeSeccion(navLateral(), 'Administración')).toEqual(['Configuración', 'Centro de ayuda'])

    const grupos = visibleSettingsGroups(k => permisos()[k])
    expect(grupos.map(g => g.label)).toEqual([grupo])
    expect(grupos[0].sections.map(s => s.label)).toEqual([seccion])
  })

  it('P3. la lista de Configuración por rol: owner 13, admin 12 (sin plan), el resto nada', () => {
    const cuantas = (rol: string) => {
      const p = effectivePermissions(rol, rol === 'owner', null)
      return visibleSettingsGroups(k => p[k]).flatMap(g => g.sections).length
    }
    expect(cuantas('owner')).toBe(13)
    expect(cuantas('admin')).toBe(12)
    for (const rol of ['manager', 'sales', 'cashier', 'tech', 'viewer']) expect(cuantas(rol), rol).toBe(0)
    const admin = effectivePermissions('admin', false, null)
    expect(visibleSettingsGroups(k => admin[k]).map(g => g.label)).not.toContain('TechRepair Pro')
  })

  it('P3. ningún grupo queda vacío en la lista', () => {
    comoActor('tech', { users: true })
    render(<MemoryRouter><SettingsNav active={null} onSelect={() => undefined} can={k => permisos()[k]} /></MemoryRouter>)
    expect(within(listaConfiguracion()).getAllByRole('list')).toHaveLength(1)
    expect(seccionesVisibles()).toEqual(['Usuarios y permisos'])
  })

  it.each([
    ['tech', '/settings'], ['tech', '/users'], ['tech', '/currency-settings'], ['tech', '/subscription'],
    ['admin', '/subscription'], ['manager', '/users'], ['viewer', '/settings'],
  ])('P4. %s en %s → rebota a Inicio (la URL a mano tampoco entra)', async (rol, ruta) => {
    comoActor(rol)
    montarApp(ruta)
    await waitFor(() => expect(screen.getByTestId('dashboard')).toBeInTheDocument())
    expect(screen.queryByTestId('settings-content')).toBeNull()
  })

  it('P5. sin `settings`, /settings no lee ni dibuja las secciones del negocio: queda la lista', async () => {
    comoActor('tech', { users: true })
    montarApp('/settings')
    expect(await screen.findByTestId('settings-pick-section')).toBeInTheDocument()
    expect(seccionesVisibles()).toEqual(['Usuarios y permisos'])
    expect(screen.getByRole('heading', { level: 1, name: 'Configuración' })).toBeInTheDocument()
    expect(screen.queryByText('Datos Generales del Negocio')).toBeNull()
    // Ni una lectura de configuración del negocio, ARCA o puntos de venta.
    expect(auth.tablasLeidas).toEqual([])
  })

  it('P5. un `?tab=` del negocio tampoco abre nada sin `settings`', async () => {
    comoActor('tech', { users: true })
    montarApp('/settings?tab=arca')
    expect(await screen.findByTestId('settings-pick-section')).toBeInTheDocument()
    expect(within(listaConfiguracion()).queryByRole('button', { name: 'Integración ARCA' })).toBeNull()
    expect(auth.tablasLeidas).toEqual([])
  })

  it('P6. el guard con una lista: entra con CUALQUIERA; una lista vacía no deja entrar a nadie', async () => {
    comoActor('tech', { subscription: true })
    const { unmount } = render(
      <MemoryRouter initialEntries={['/x']}>
        <Routes>
          <Route element={<ProtectedRouteByPermission permission={['settings', 'subscription']} />}>
            <Route path="/x" element={<div data-testid="permitido" />} />
          </Route>
          <Route path="/dashboard" element={<div data-testid="dashboard" />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByTestId('permitido')).toBeInTheDocument()
    unmount()

    comoActor('owner')
    render(
      <MemoryRouter initialEntries={['/x']}>
        <Routes>
          <Route element={<ProtectedRouteByPermission permission={[]} />}>
            <Route path="/x" element={<div data-testid="permitido" />} />
          </Route>
          <Route path="/dashboard" element={<div data-testid="dashboard" />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByTestId('dashboard')).toBeInTheDocument()
    expect(isNavigationItemAuthorized({ anyPermission: [] }, accessDelActor())).toBe(false)
  })

  it('P7. `anyPermission` se suma a los demás gates: no abre un plan que no está', () => {
    const sinPlan = { ...accessDelActor(), hasFeature: () => false }
    expect(isNavigationItemAuthorized({ anyPermission: SETTINGS_PERMISSIONS, planFeature: 'reports' }, sinPlan)).toBe(false)
    expect(isNavigationItemAuthorized({ anyPermission: SETTINGS_PERMISSIONS }, sinPlan)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('H · enlaces históricos', () => {
  it.each([
    ['/users', 'usuarios', 'Usuarios y permisos'],
    ['/currency-settings', 'moneda', 'Moneda y cotización'],
    ['/subscription', 'suscripcion', 'Plan y suscripción'],
  ])('H1. %s sigue abriendo su pantalla, ahora dentro de Configuración', async (ruta, sonda, seccion) => {
    montarApp(ruta)
    expect(await screen.findByTestId(`pantalla-${sonda}`)).toBeInTheDocument()
    expect(screen.getByTestId('ruta')).toHaveTextContent(ruta)
    // Dentro del marco: encabezado de Configuración, lista y la sección marcada.
    const region = screen.getByRole('region', { name: seccion })
    expect(within(region).getByTestId(`pantalla-${sonda}`)).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Configuración' })).toBeInTheDocument()
    expect(within(listaConfiguracion()).getByRole('button', { name: seccion })).toHaveAttribute('aria-current', 'page')
    expect(within(listaConfiguracion()).getAllByRole('button').filter(b => b.hasAttribute('aria-current'))).toHaveLength(1)
  })

  it('H2. Planes y los retornos de Mercado Pago NO se dibujan dentro del marco', async () => {
    montarApp('/subscription/plans')
    expect(await screen.findByTestId('pantalla-planes')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-nav')).toBeNull()
  })

  it('H3. /tutorials redirige al Centro de ayuda, a la sección de tutoriales', async () => {
    montarApp('/tutorials')
    expect(await screen.findByTestId('ayuda-page')).toBeInTheDocument()
    expect(screen.getByTestId('ruta')).toHaveTextContent('/ayuda#tutoriales')
    const tutoriales = screen.getByRole('region', { name: 'Tutoriales' })
    expect(tutoriales).toHaveAttribute('id', 'tutoriales')
    // Se llega a la sección, no al principio de la página.
    expect(scrolleados).toEqual([tutoriales])
  })

  it('H4. desde la lista se navega entre las pantallas viejas y las secciones de `?tab=`', async () => {
    montarApp('/users')
    await screen.findByTestId('pantalla-usuarios')
    fireEvent.click(within(listaConfiguracion()).getByRole('button', { name: 'Plan y suscripción' }))
    expect(screen.getByTestId('ruta')).toHaveTextContent(/^\/subscription$/)
    expect(await screen.findByTestId('pantalla-suscripcion')).toBeInTheDocument()

    fireEvent.click(within(listaConfiguracion()).getByRole('button', { name: 'Moneda y cotización' }))
    expect(screen.getByTestId('ruta')).toHaveTextContent(/^\/currency-settings$/)
    await screen.findByTestId('pantalla-moneda')

    // Las diez de siempre conservan su `?tab=`.
    fireEvent.click(within(listaConfiguracion()).getByRole('button', { name: 'Cobros y pagos' }))
    expect(screen.getByTestId('ruta')).toHaveTextContent('/settings?tab=pagos')
  })

  it('H4. al terminar de cargar, /settings no vuelve a montar la navegación (mismos nodos)', async () => {
    montarApp('/settings?tab=pagos')
    expect(screen.getByTestId('settings-section-loading')).toBeInTheDocument()
    const durante = within(listaConfiguracion()).getByRole('button', { name: 'Cobros y pagos' })
    await waitFor(() => expect(screen.queryByTestId('settings-section-loading')).toBeNull())
    expect(within(listaConfiguracion()).getByRole('button', { name: 'Cobros y pagos' })).toBe(durante)
    expect(durante.isConnected).toBe(true)
  })

  it('H5. las claves de `?tab=` son las mismas diez y cada pantalla conserva su ruta', () => {
    expect([...SETTINGS_SECTIONS].sort()).toEqual(
      ['arca', 'comisiones', 'comprobante', 'datos', 'orden', 'pagos', 'preferencias', 'puntos', 'seguridad', 'whatsapp'],
    )
    expect(SETTINGS_PAGE_PATHS).toEqual({ moneda: '/currency-settings', usuarios: '/users', suscripcion: '/subscription' })
    expect(settingsSectionHref('usuarios')).toBe('/users')
    expect(settingsSectionHref('pagos')).toBe('/settings?tab=pagos')
    expect(SETTINGS_ROUTE_PATHS).toEqual(['/settings', '/currency-settings', '/users', '/subscription'])
  })

  describe('H6 · App.tsx: cada ruta conserva su guard y se dibuja en el marco', () => {
    const app = sinComentarios(leer('src/App.tsx'))
    /** El bloque `<Route element={<ProtectedRouteByPermission …>}>` que contiene a `path`. */
    function bloqueDe(path: string): string {
      const i = app.indexOf(`path="${path}"`)
      expect(i, path).toBeGreaterThan(-1)
      const guard = app.lastIndexOf('<Route element={<ProtectedRouteBy', i)
      return app.slice(guard, i)
    }

    it.each([
      ['/currency-settings', 'permission="settings"', 'moneda'],
      ['/users', 'permission="users"', 'usuarios'],
      ['/subscription', 'permission="subscription"', 'suscripcion'],
    ])('%s → %s + SettingsPageRoute', (path, guard, seccion) => {
      const bloque = bloqueDe(path)
      expect(bloque.startsWith(`<Route element={<ProtectedRouteByPermission ${guard} />}>`)).toBe(true)
      expect(bloque).toContain(`<SettingsPageRoute section="${seccion}" />`)
      expect(app.match(new RegExp(`path="${path}"`, 'g')), path).toHaveLength(1)
    })

    it('/settings → guard con la lista de capacidades', () => {
      expect(bloqueDe('/settings').startsWith('<Route element={<ProtectedRouteByPermission permission={SETTINGS_PERMISSIONS} />}>')).toBe(true)
    })

    it('/tutorials redirige y los tutoriales quedan fuera de los guards de capacidad', () => {
      expect(app).toMatch(/<Route path="\/tutorials" element=\{<Navigate to="\/ayuda#tutoriales" replace \/>\} \/>/)
      const ayuda = app.indexOf('path="/ayuda"')
      const tutoriales = app.indexOf('path="/ayuda/tutoriales/:tutorialId"')
      expect(tutoriales).toBeGreaterThan(ayuda)
      expect(app.slice(app.indexOf('path="/subscription/suspended"'), tutoriales)).not.toMatch(/<Route element=\{<ProtectedRouteBy/)
    })

    it('SubscriptionGuard sigue eximiendo /subscription, /settings y /ayuda (y no se sumó /users)', () => {
      const guard = leer('src/components/subscription/SubscriptionGuard.tsx')
      expect(guard).toMatch(/ALLOWED_PATHS = \['\/subscription', '\/settings', '\/ayuda'\]/)
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('C · Centro de ayuda', () => {
  const montarAyuda = () => render(<MemoryRouter initialEntries={['/ayuda']}><Ayuda /><Ruta /></MemoryRouter>)

  it('C1. un título y dos accesos con nombre: Soporte y Tutoriales', () => {
    montarAyuda()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Centro de ayuda')
    expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual(['Soporte', 'Tutoriales'])
    expect(screen.getByRole('region', { name: 'Soporte' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Tutoriales' })).toBeInTheDocument()
  })

  it('C2. Soporte usa el canal canónico y nada más (sin tickets, sin correo)', () => {
    montarAyuda()
    const soporte = screen.getByRole('region', { name: 'Soporte' })
    const enlaces = within(soporte).getAllByRole('link')
    expect(enlaces).toHaveLength(1)
    expect(enlaces[0]).toHaveAttribute('href', canalSoporte().url)
    expect(enlaces[0]).toHaveAttribute('data-testid', 'support-contact-cta')
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull()
    expect(sinComentarios(leer('src/pages/Ayuda.tsx'))).not.toMatch(/wa\.me|mailto:|ticket/i)
  })

  it('C3. Tutoriales lista el catálogo; cada guía abre su página', () => {
    montarAyuda()
    const tutoriales = screen.getByRole('region', { name: 'Tutoriales' })
    const filas = within(tutoriales).getAllByRole('link')
    expect(filas).toHaveLength(TUTORIALS.length)
    const arca = within(tutoriales).getByTestId('help-tutorial-arca')
    expect(arca).toHaveAttribute('href', '/ayuda/tutoriales/arca')
    expect(arca).toHaveTextContent('Integración con ARCA (Factura Electrónica)')
    expect(arca).toHaveTextContent('Guía · 20 min · Intermedio')
    fireEvent.click(arca)
    expect(screen.getByTestId('ruta')).toHaveTextContent('/ayuda/tutoriales/arca')
  })

  it('C4. el catálogo está listo para crecer: ids únicos, cada guía tiene contenido, los videos salen aparte', () => {
    const ids = TUTORIALS.map(t => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const t of TUTORIALS) {
      if (t.kind === 'guia') expect(TUTORIAL_GUIDES[t.id], t.id).toBeTypeOf('function')
    }
    const video: VideoTutorial = { kind: 'video', id: 'demo', title: 'Demo', description: 'd', icon: TUTORIALS[0].icon, duration: '3 min', level: 'Inicial', url: 'https://example.test/v' }
    expect(tutorialHref(video)).toBe('https://example.test/v')
    expect(tutorialMeta(video)).toBe('Video · 3 min · Inicial')
  })

  it('C5. la guía se abre con su contenido y un «‹ Centro de ayuda» para volver', async () => {
    montarApp('/ayuda/tutoriales/arca')
    expect(await screen.findByTestId('tutorial-page')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Integración con ARCA (Factura Electrónica)')
    expect(screen.getByText('¿Qué es ARCA?')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('tutorial-back'))
    expect(screen.getByTestId('ruta')).toHaveTextContent(/^\/ayuda$/)
  })

  it('C6. un tutorial que no existe vuelve a la lista en vez de quedar en blanco', async () => {
    montarApp('/ayuda/tutoriales/no-existe')
    expect(await screen.findByTestId('ayuda-page')).toBeInTheDocument()
    expect(screen.getByTestId('ruta')).toHaveTextContent('/ayuda#tutoriales')
  })

  it.each(ROLES)('C7. %s llega al Centro de ayuda (no depende de capacidades)', async (rol) => {
    comoActor(rol)
    montarApp('/ayuda')
    expect(await screen.findByTestId('ayuda-page')).toBeInTheDocument()
  })

  it('C7. el ítem del menú no declara ningún gate', () => {
    const linea = leer('src/components/layout/Sidebar.tsx').split('\n').find(l => l.includes("path: '/ayuda'")) ?? ''
    expect(linea).toContain("label: 'Centro de ayuda'")
    expect(linea).not.toMatch(/permission|anyPermission|planFeature|systemOwner|wholesaleView|clicPortalManage/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('M · móvil', () => {
  function celular() {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query === '(max-width: 1023px)', media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })))
  }

  it('M1. el drawer «Más» tiene los mismos dos ítems de Administración, táctiles', () => {
    montarSidebar('/dashboard', ['/dashboard', '/orders', '/comprobantes', '/customers'])
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'abrir-mas' })) })
    const drawer = screen.getByRole('dialog', { name: 'Más módulos' })
    expect(itemsDeSeccion(within(drawer).getByRole('navigation'), 'Administración')).toEqual(['Configuración', 'Centro de ayuda'])
    for (const nombre of ['Configuración', 'Centro de ayuda']) {
      const item = within(drawer).getByRole('link', { name: nombre })
      expect(item.style.minHeight).toBe('44px')
    }
    fireEvent.click(within(drawer).getByRole('link', { name: 'Configuración' }))
    expect(screen.getByTestId('ruta')).toHaveTextContent(/^\/settings$/)
    expect(screen.queryByRole('dialog', { name: 'Más módulos' })).toBeNull()
  })

  it('M2. lista → pantalla (con el foco en la sección) → «‹ Secciones» vuelve a la lista', async () => {
    celular()
    comoActor('tech', { users: true, subscription: true })
    montarApp('/settings')
    await screen.findByTestId('settings-pick-section')
    expect(document.querySelector('.settings-page')).toHaveAttribute('data-view', 'list')

    fireEvent.click(within(listaConfiguracion()).getByRole('button', { name: 'Usuarios y permisos' }))
    await screen.findByTestId('pantalla-usuarios')
    expect(document.querySelector('.settings-page')).toHaveAttribute('data-view', 'section')
    await waitFor(() => expect(screen.getByTestId('settings-content')).toHaveFocus())

    fireEvent.click(screen.getByTestId('settings-back'))
    expect(screen.getByTestId('ruta')).toHaveTextContent(/^\/settings$/)
    expect(await screen.findByTestId('settings-pick-section')).toBeInTheDocument()
  })

  it('M2. en escritorio el foco del teclado sigue en la lista, en la sección elegida (no cae al body)', async () => {
    // Como en el navegador: el botón toma el foco al tocarlo (fireEvent no lo hace).
    const tocar = (nombre: string) => {
      const boton = within(listaConfiguracion()).getByRole('button', { name: nombre })
      boton.focus()
      fireEvent.click(boton)
    }
    montarApp('/users')
    await screen.findByTestId('pantalla-usuarios')
    tocar('Moneda y cotización')
    await screen.findByTestId('pantalla-moneda')
    const elegida = within(listaConfiguracion()).getByRole('button', { name: 'Moneda y cotización' })
    await waitFor(() => expect(elegida).toHaveFocus())
    expect(elegida).toHaveAttribute('aria-current', 'page')

    // `/settings` y las pantallas con ruta propia son árboles distintos: el marco
    // se vuelve a montar y el botón tocado ya no existe. El foco va al elegido.
    tocar('Seguridad')
    await screen.findByText('Seguridad', { selector: '.settings-content__current' })
    await waitFor(() => expect(within(listaConfiguracion()).getByRole('button', { name: 'Seguridad' })).toHaveFocus())
    tocar('Usuarios y permisos')
    await screen.findByTestId('pantalla-usuarios')
    await waitFor(() => expect(within(listaConfiguracion()).getByRole('button', { name: 'Usuarios y permisos' })).toHaveFocus())
    expect(screen.getByTestId('settings-content')).not.toHaveFocus()
  })

  it('M2. entrar por URL (sin venir de la lista) no mueve el foco', async () => {
    montarApp('/users')
    await screen.findByTestId('pantalla-usuarios')
    expect(document.body).toHaveFocus()
  })

  it('M3. la barra móvil nombra el Centro de ayuda y sus tutoriales', () => {
    expect(mobilePageTitle('/ayuda')).toBe('Centro de ayuda')
    expect(mobilePageTitle('/ayuda/tutoriales/arca')).toBe('Tutoriales')
    expect(mobilePageTitle('/settings')).toBe('Configuración')
    expect(mobilePageTitle('/users')).toBe('Usuarios')
  })

  it('M4. contrato de CSS: Centro de ayuda apilado por debajo de 1024 px; filas táctiles', () => {
    const css = leer('src/index.css').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).toMatch(/\.help-grid \{[^}]*grid-template-columns: minmax\(0, 2fr\) minmax\(0, 3fr\)/)
    const movil = css.slice(css.indexOf('@media (max-width: 1023px) {\n  .help-grid'))
    expect(movil).toMatch(/^@media \(max-width: 1023px\) \{\n {2}\.help-grid \{ grid-template-columns: minmax\(0, 1fr\)/)
    expect(css).toMatch(/\.help-item \{[^}]*min-height: 56px/)
    expect(css).toMatch(/\.help-item:focus-visible \{[^}]*outline: 2px solid var\(--accent-primary\)/)
    // Las pantallas que viven dentro del marco bajan su encabezado un escalón, sólo ahí.
    expect(css).toMatch(/\.settings-content \.page-hdr \{[^}]*--page-header-icon: 40px/)
    expect(css).toMatch(/\.settings-content \.page-hdr-title \{ font-size: 1\.25rem/)
  })

  it('M5. Usuarios, Moneda y Suscripción usan h2: el h1 es «Configuración»', () => {
    for (const [archivo, titulo] of [
      ['src/pages/UsersManagement.tsx', 'Usuarios del Negocio'],
      ['src/pages/CurrencySettings.tsx', 'Configuración de Moneda'],
      ['src/pages/Subscription.tsx', 'Mi Suscripción'],
    ]) {
      const src = leer(archivo)
      expect(src, archivo).toContain(`<h2 className="page-hdr-title">${titulo}</h2>`)
      expect(src, archivo).not.toContain(`<h1 className="page-hdr-title">${titulo}</h1>`)
    }
  })
})
