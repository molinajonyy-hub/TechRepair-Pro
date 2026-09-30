// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-3A-0 · Beta guardrails.
//
// Cubre los P0 de la discovery 3A que se cierran en este lote:
//   A1  CTAs del embudo ilegibles en light  → token --text-on-accent
//   C1  permiso denegado = rebote silencioso → PermissionNotice
//   C2  «Nuevo Comprobante» sin permiso      → header del Dashboard por capacidad
//   C4  banner de suscripción a cualquier rol → capacidad `subscription`
//   +   Ctrl+K filtrado con el contrato canónico de navegación
//
// Los mocks van en el BORDE (auth, servicios, hooks de datos). `usePermissions`
// e `isNavigationItemAuthorized` corren de verdad: son la regla bajo prueba.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation, useNavigationType } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const h = vi.hoisted(() => ({
  role: 'owner' as string,
  permissions: null as unknown,
  navigate: vi.fn(),
  realNavigate: false,
  sub: {
    isTrial: true,
    isPastDue: false,
    daysUntilTrialEnd: 6 as number | null,
    daysUntilGraceEnd: null as number | null,
    daysUntilPeriodEnd: null as number | null,
    isActive: false,
    loading: false,
  },
}))

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({
    businessId: null,
    role: h.role,
    isOwner: h.role === 'owner',
    profile: { permissions: h.permissions },
  }),
}))

vi.mock('../../src/lib/supabase', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'order', 'limit', 'in', 'gte', 'lte', 'or', 'ilike']) chain[m] = () => chain
  chain.maybeSingle = async () => ({ data: null, error: null })
  chain.single = async () => ({ data: null, error: null })
  chain.then = (res: (v: { data: unknown[]; error: null }) => unknown) => res({ data: [], error: null })
  return { supabase: { from: () => chain, rpc: async () => ({ data: null, error: null }) } }
})

vi.mock('react-router-dom', async (orig) => {
  const actual = await orig<typeof import('react-router-dom')>()
  return {
    ...actual,
    // `realNavigate` deja correr el navigate verdadero (PermissionNotice
    // necesita reescribir el state del MemoryRouter de verdad).
    useNavigate: () => (h.realNavigate ? actual.useNavigate() : h.navigate),
  }
})

vi.mock('../../src/hooks/useSubscription', () => ({ useSubscription: () => h.sub }))

// ── Dependencias de datos del Dashboard (borde) ─────────────────────────────
vi.mock('../../src/hooks/useDashboardStats', () => ({
  useDashboardStats: () => ({
    stats: {
      totalOrders: 0, totalCustomers: 0, ordersByStatus: {}, newOrdersToday: 0,
      newCustomersThisMonth: 0, realProfitToday: null, averageMarginPct: null, recentOrders: [],
    },
    loading: false, error: null, refresh: vi.fn(),
  }),
}))
vi.mock('../../src/hooks/useFinancialDashboard', () => ({
  useFinancialDashboard: () => ({ data: null, loading: false, cajaError: null }),
}))
vi.mock('../../src/hooks/useComprobantes', () => ({
  useComprobantes: () => ({ comprobantes: [], listarComprobantes: vi.fn() }),
}))
vi.mock('../../src/services/dollarRateService', () => ({
  refreshDollarRate: vi.fn(async () => null),
  refreshInventoryDollarPrices: vi.fn(async () => undefined),
}))
vi.mock('../../src/contexts/CajaContext', () => ({
  useCaja: () => ({ isOpen: false, cajaId: null, loading: false, activeCaja: null, canUseCaja: false }),
}))
vi.mock('../../src/components/ui/DollarRateBadge', () => ({ DollarRateBadge: () => null }))
vi.mock('../../src/components/tasks/DashboardTasks', () => ({ DashboardTasks: () => null }))
vi.mock('../../src/components/onboarding/FirstStepsChecklist', () => ({ FirstStepsChecklist: () => null }))

import { SubscriptionBanner } from '../../src/components/subscription/SubscriptionBanner'
import { Dashboard } from '../../src/pages/Dashboard'
import {
  CommandPalette,
  QUICK_ACTIONS,
  authorizedQuickActions,
} from '../../src/components/ui/CommandPalette'
import {
  PermissionNotice,
  permissionNoticeMessage,
  readDeniedPermission,
} from '../../src/components/auth/PermissionNotice'
import type { NavigationAccess } from '../../src/hooks/useNavigationAccess'
import { effectivePermissions } from '../../src/hooks/usePermissions'
import { ALL_PERMISSIONS } from '../../src/config/permissions'
import { PLAN_FEATURES, TRIAL_FEATURES, type PlanFeature, type PlanFeatureSet } from '../../src/config/planFeatures'
import { S as authStyles } from '../../src/components/auth/authCardStyles'
import { AuthFlowPrimaryButton } from '../../src/components/auth/AuthFlowShell'

const here = dirname(fileURLToPath(import.meta.url))
const leer = (rel: string) => readFileSync(join(here, '../../', rel), 'utf8')

beforeEach(() => {
  h.role = 'owner'
  h.permissions = null
  h.realNavigate = false
  h.navigate.mockReset()
  Object.assign(h.sub, {
    isTrial: true, isPastDue: false, daysUntilTrialEnd: 6,
    daysUntilGraceEnd: null, daysUntilPeriodEnd: null, isActive: false, loading: false,
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('C4 · banner de suscripción sólo con la capacidad `subscription`', () => {
  const montar = () => render(<MemoryRouter><SubscriptionBanner /></MemoryRouter>)

  it('owner ve el estado del trial y «Ver planes»', () => {
    montar()
    expect(screen.getByText(/Tu período de prueba vence en 6 días/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ver planes' })).toBeInTheDocument()
  })

  it.each(['tech', 'cashier', 'sales', 'manager', 'viewer', 'admin'])(
    '%s (sin `subscription`) no ve estado del trial ni CTA de plan',
    (rol) => {
      h.role = rol
      const { container } = montar()
      expect(container.textContent).toBe('')
      expect(screen.queryByRole('button', { name: 'Ver planes' })).toBeNull()
    },
  )

  it('tech tampoco ve «Regularizar» ni «Gestionar»', () => {
    h.role = 'tech'
    Object.assign(h.sub, { isTrial: false, isPastDue: true, daysUntilGraceEnd: 3 })
    const pastDue = montar()
    expect(screen.queryByRole('button', { name: 'Regularizar' })).toBeNull()
    pastDue.unmount()

    Object.assign(h.sub, { isPastDue: false, isActive: true, daysUntilPeriodEnd: 2 })
    montar()
    expect(screen.queryByRole('button', { name: 'Gestionar' })).toBeNull()
  })

  it('la capacidad es EFECTIVA: un admin con override `subscription` sí lo ve', () => {
    h.role = 'admin'
    h.permissions = { subscription: true }
    montar()
    expect(screen.getByRole('button', { name: 'Ver planes' })).toBeInTheDocument()
  })

  it('los TRES cierres del banner tienen nombre accesible', () => {
    const variantes: Array<Partial<typeof h.sub>> = [
      { isTrial: true, daysUntilTrialEnd: 6 },
      { isTrial: false, isPastDue: true, daysUntilGraceEnd: 3 },
      { isTrial: false, isPastDue: false, isActive: true, daysUntilPeriodEnd: 2 },
    ]
    for (const v of variantes) {
      Object.assign(h.sub, v)
      const vista = montar()
      const cerrar = screen.getByRole('button', { name: 'Cerrar aviso de suscripción' })
      fireEvent.click(cerrar)
      expect(screen.queryByRole('button', { name: 'Cerrar aviso de suscripción' })).toBeNull()
      vista.unmount()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('C2 · header del Dashboard por capacidad', () => {
  const montar = () => render(<MemoryRouter><Dashboard /></MemoryRouter>)

  it('owner conserva «Nueva Orden» y «Nuevo Comprobante»', () => {
    montar()
    expect(screen.getAllByRole('button', { name: /Nueva Orden/ }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: /Nuevo Comprobante/ }).length).toBeGreaterThan(0)
  })

  it('tech NO ve «Nuevo Comprobante» en ningún lugar del Dashboard', () => {
    h.role = 'tech'
    montar()
    expect(screen.queryByRole('button', { name: /Nuevo Comprobante/ })).toBeNull()
    // …pero sí puede recibir equipos: su acción legítima sigue.
    expect(screen.getAllByRole('button', { name: /Nueva Orden/ }).length).toBeGreaterThan(0)
  })

  it('viewer (orders sin orders_create) no recibe ningún CTA de crear orden', () => {
    h.role = 'viewer'
    montar()
    expect(screen.queryByRole('button', { name: /Nueva Orden/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Crear primera orden/i })).toBeNull()
  })

  it('«Nuevo Comprobante» del header abre el alta (state.openNew)', () => {
    montar()
    fireEvent.click(screen.getAllByRole('button', { name: /Nuevo Comprobante/ })[0])
    expect(h.navigate).toHaveBeenCalledWith('/comprobantes', { state: { openNew: true } })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
const accessPara = (rol: string, features: PlanFeatureSet = TRIAL_FEATURES, overrides: unknown = null): NavigationAccess => {
  const perms = effectivePermissions(rol, rol === 'owner', overrides)
  return {
    can: k => perms[k],
    hasFeature: (f: PlanFeature) => Boolean(features[f]),
    isSystemOwner: false,
    mayoristaEnabled: true,
    wholesale: { canAccess: false, canManageClicPortal: false } as NavigationAccess['wholesale'],
  }
}
const ids = (access: NavigationAccess) => authorizedQuickActions(access).map(a => a.id)

describe('Ctrl+K · acciones rápidas con el contrato canónico', () => {
  it('toda acción salvo Inicio declara una capacidad (no hay atajos sin gate)', () => {
    for (const accion of QUICK_ACTIONS) {
      if (accion.id === 'go-dashboard') continue
      expect(accion.permission, `${accion.id} sin permission`).toBeTruthy()
      expect(ALL_PERMISSIONS).toContain(accion.permission!)
    }
  })

  it('owner en trial Pro ve las 14', () => {
    expect(ids(accessPara('owner'))).toHaveLength(QUICK_ACTIONS.length)
  })

  it('tech no ve nada que no pueda ejecutar', () => {
    const tech = ids(accessPara('tech'))
    expect(tech).toEqual(['new-order', 'go-dashboard', 'go-orders', 'go-tasks'])
    for (const prohibida of ['new-comp', 'new-customer', 'new-expense', 'go-inventory', 'go-customers',
      'go-suppliers', 'go-comprobantes', 'go-caja', 'go-cuentas', 'go-finance']) {
      expect(tech).not.toContain(prohibida)
    }
  })

  it('respeta planFeature: owner en Básico no ve Cuentas, Finanzas ni Tareas', () => {
    const basico = ids(accessPara('owner', PLAN_FEATURES.basico))
    expect(basico).not.toContain('go-cuentas')
    expect(basico).not.toContain('go-finance')
    expect(basico).not.toContain('go-tasks')
    expect(basico).toContain('go-caja')
  })

  it('viewer no ve «Nueva Orden» (orders_create) aunque vea Órdenes', () => {
    const viewer = ids(accessPara('viewer'))
    expect(viewer).toContain('go-orders')
    expect(viewer).not.toContain('new-order')
  })

  it('«Nuevo Comprobante» navega con state.openNew = true', async () => {
    render(<MemoryRouter><CommandPalette access={accessPara('owner')} /></MemoryRouter>)
    act(() => { window.dispatchEvent(new Event('tr-open-palette')) })
    // La fila selecciona en mouseDown (preexistente: evita perder el foco del input).
    const item = await screen.findByText('Nuevo Comprobante')
    fireEvent.mouseDown(item)
    expect(h.navigate).toHaveBeenCalledWith('/comprobantes', { state: { openNew: true } })
  })

  it('un técnico no encuentra «Nuevo Comprobante» en la paleta montada', async () => {
    render(<MemoryRouter><CommandPalette access={accessPara('tech')} /></MemoryRouter>)
    act(() => { window.dispatchEvent(new Event('tr-open-palette')) })
    await screen.findByText('Nueva Orden')
    expect(screen.queryByText('Nuevo Comprobante')).toBeNull()
    expect(screen.queryByText('Registrar Gasto')).toBeNull()
    expect(screen.queryByText('Caja')).toBeNull()
  })

  it('las acciones sin state siguen navegando igual que antes', async () => {
    render(<MemoryRouter><CommandPalette access={accessPara('owner')} /></MemoryRouter>)
    act(() => { window.dispatchEvent(new Event('tr-open-palette')) })
    fireEvent.mouseDown(await screen.findByText('Nuevo Cliente'))
    expect(h.navigate).toHaveBeenCalledWith('/customers/new', undefined)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('C1 · PermissionNotice', () => {
  let renders = 0
  function Sonda() {
    renders += 1
    const location = useLocation()
    const tipo = useNavigationType()
    return (
      <>
        <span data-testid="state">{JSON.stringify(location.state ?? null)}</span>
        <span data-testid="nav-type">{tipo}</span>
      </>
    )
  }
  const montar = (state: unknown) => {
    h.realNavigate = true
    renders = 0
    return render(
      <MemoryRouter initialEntries={[{ pathname: '/dashboard', state }]}>
        <Routes>
          <Route path="/dashboard" element={<><PermissionNotice /><Sonda /></>} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('lee sólo capacidades conocidas', () => {
    expect(readDeniedPermission({ deniedPermission: 'finance' })).toBe('finance')
    expect(readDeniedPermission({ deniedPermission: 'root' })).toBeNull()
    expect(readDeniedPermission({ deniedPermission: 42 })).toBeNull()
    expect(readDeniedPermission(null)).toBeNull()
    expect(readDeniedPermission('finance')).toBeNull()
  })

  it('el mensaje es humano y nunca expone la clave interna', () => {
    for (const key of ALL_PERMISSIONS) {
      const msg = permissionNoticeMessage(key)
      expect(msg).toMatch(/^No tenés permiso para entrar a .+\. Pedíselo al dueño del negocio\.$/)
      if (key.includes('_')) expect(msg).not.toContain(key)
    }
    expect(permissionNoticeMessage('finance')).toBe('No tenés permiso para entrar a Finanzas / Caja. Pedíselo al dueño del negocio.')
  })

  it('Mi Guita (oculto en beta) no se nombra', () => {
    expect(permissionNoticeMessage('personal_finance')).not.toMatch(/Mi Guita/i)
  })

  it('muestra un role=status con el módulo y un cierre accesible', () => {
    montar({ deniedPermission: 'comprobantes' })
    const aviso = screen.getByRole('status')
    expect(aviso).toHaveTextContent('No tenés permiso para entrar a Comprobantes. Pedíselo al dueño del negocio.')
    expect(screen.getByRole('button', { name: 'Cerrar aviso de permiso' })).toBeInTheDocument()
  })

  it('no aparece sin deniedPermission o con una clave desconocida', () => {
    const a = montar(null)
    expect(screen.queryByRole('status')).toBeNull()
    a.unmount()
    montar({ deniedPermission: 'no-existe' })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('cerrar limpia SÓLO la marca, con REPLACE y sin loop', async () => {
    montar({ deniedPermission: 'finance', from: { pathname: '/finance' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar aviso de permiso' }))

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    // No agrega historial: la navegación fue un REPLACE sobre la misma ruta.
    expect(screen.getByTestId('nav-type').textContent).toBe('REPLACE')
    // El resto del state sobrevive; `deniedPermission` no.
    const state = JSON.parse(screen.getByTestId('state').textContent || 'null')
    expect(state).toEqual({ from: { pathname: '/finance' } })
    // Un loop de navegación dispararía renders sin fin.
    const tras = renders
    await new Promise(r => setTimeout(r, 50))
    expect(renders).toBe(tras)
    expect(renders).toBeLessThan(10)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('A1 · CTAs del embudo con --text-on-accent (inmunes al remapeo light)', () => {
  // Sin comentarios: el propio comentario que documenta el token cita el
  // selector del remapeo, y el test tiene que leer la REGLA, no su descripción.
  const css = leer('src/index.css').replace(/\/\*[\s\S]*?\*\//g, '')

  // Los patrones REALES de la regla de light mode que convierte texto claro
  // inline en --text-primary. Se leen del CSS: si alguien agrega un patrón,
  // el test lo usa sin cambios.
  const bloqueRemapeo = (() => {
    const i = css.indexOf('[style*="color: rgb(255, 255, 255)"]')
    const inicio = css.lastIndexOf('[data-theme="light"] :is(', i)
    return css.slice(inicio, css.indexOf('{', i))
  })()
  const patrones = [...bloqueRemapeo.matchAll(/\[style\*="(color: [^"]+)"\]/g)].map(m => m[1])

  it('el token vive en un :root INVARIANTE, fuera de los bloques de tema', () => {
    const m = /(^|\n):root\s*\{([^}]*)\}/.exec(css)
    expect(m, 'no hay un bloque `:root {` propio').not.toBeNull()
    expect(m![2]).toMatch(/--text-on-accent:\s*#ffffff;/)
    // Ni el bloque dark ni el light lo redefinen.
    expect(css.match(/--text-on-accent\s*:/g)).toHaveLength(1)
  })

  it('la regla global de remapeo sigue intacta (no se tocó)', () => {
    expect(patrones).toContain('color: rgb(255, 255, 255)')
  })

  it('un `#fff` inline SÍ cae bajo el remapeo; el token NO (mecanismo)', () => {
    const conHex = document.createElement('button')
    conHex.style.color = '#fff'
    const conToken = document.createElement('button')
    conToken.style.color = 'var(--text-on-accent)'
    const cae = (el: HTMLElement) => patrones.some(p => (el.getAttribute('style') || '').includes(p))
    expect(cae(conHex)).toBe(true)
    expect(cae(conToken)).toBe(false)
  })

  it('authCardStyles: CTA primario y tab activa usan el token', () => {
    expect(authStyles.btnPrimary(false).color).toBe('var(--text-on-accent)')
    expect(authStyles.btnPrimary(true).color).toBe('var(--text-on-accent)')
    expect(authStyles.tab(true, false).color).toBe('var(--text-on-accent)')
  })

  // PRE-BETA-3A-1a: VerifyEmail, NoBusiness y Onboarding ya no definen sus CTAs
  // inline: usan AuthFlowPrimaryButton (AppButton `indigo`), cuyo blanco viene
  // de la CLASE `.btn-fill-indigo`. El remapeo de light mode sólo matchea el
  // atributo `style`, así que el contrato («inmune al remapeo») se mide ahora
  // sobre el primitivo compartido y sobre su uso, no sobre un literal por página.
  it.each([
    'src/components/auth/authCardStyles.ts',
    'src/components/auth/AuthFlowShell.tsx',
    'src/pages/VerifyEmail.tsx',
    'src/pages/NoBusiness.tsx',
    'src/pages/Onboarding.tsx',
  ])('%s no vuelve a `#fff` inline', (rel) => {
    const src = leer(rel)
    expect(src).not.toMatch(/color:\s*['"](#fff|#ffffff|white)['"]/i)
  })

  it('authCardStyles conserva el token (Login y /reset-password siguen usándolo)', () => {
    expect(leer('src/components/auth/authCardStyles.ts')).toContain("'var(--text-on-accent)'")
  })

  it('el CTA primario del shell pinta el blanco por CLASE: ningún patrón del remapeo lo alcanza', () => {
    render(<AuthFlowPrimaryButton data-testid="cta">Continuar</AuthFlowPrimaryButton>)
    const cta = screen.getByTestId('cta')
    expect(cta.className).toContain('btn-fill-indigo')
    const estilo = cta.getAttribute('style') ?? ''
    expect(patrones.some(p => estilo.includes(p))).toBe(false)
    // …y la clase declara blanco en una regla que no depende del tema.
    expect(css).toMatch(/\n\.btn-fill-indigo\s*\{[^}]*color:\s*#fff;/)
    expect(css).not.toMatch(/\[data-theme="light"\][^{]*\.btn-fill-indigo/)
  })

  it.each([
    ['src/pages/Onboarding.tsx', ['onboarding-step1-submit', 'onboarding-step2-submit', 'onboarding-step3-submit', 'onboarding-step4-submit', 'onboarding-finish', 'onboarding-ir-dashboard']],
    ['src/pages/NoBusiness.tsx', ['no-business-crear', 'no-business-reintentar', 'no-business-aceptar-invitacion', 'no-business-inactive-salir']],
    ['src/pages/VerifyEmail.tsx', ['verify-email-ya-confirme']],
  ] as const)('%s: cada CTA primario del embudo usa AuthFlowPrimaryButton', (rel, testIds) => {
    const src = leer(rel)
    for (const id of testIds) {
      const i = src.indexOf(`data-testid="${id}"`)
      expect(i, `${id} no está en ${rel}`).toBeGreaterThan(-1)
      // El testid pertenece al elemento abierto más cercano hacia atrás.
      const apertura = src.lastIndexOf('<', i)
      expect(src.slice(apertura, apertura + 22), id).toBe('<AuthFlowPrimaryButton')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('A2 / D2 · Mi Guita no se promete', () => {
  it('el onboarding no menciona Mi Guita (y ya no tiene paso de trial)', () => {
    const src = leer('src/pages/Onboarding.tsx')
    expect(src).not.toMatch(/Mi Guita/i)
    // PRE-BETA-3A-1a sacó el paso del trial del onboarding: con él se fueron
    // la lista de features y su CTA. Lo cubre en detalle prebeta3a1aOnboardingShell.
    expect(src).not.toContain('TRIAL_FEATURES_LIST')
    expect(src).not.toContain('onboarding-step5-submit')
  })

  it('la landing usa el texto aprobado y no nombra Mi Guita en pricing', () => {
    const src = leer('src/pages/LandingPage.tsx')
    expect(src).toContain('La facturación ARCA/CAE y las herramientas avanzadas de gestión están incluidas desde el plan Pro.')
    expect(src).not.toMatch(/Mi Guita \(finanzas personales\)/)
  })
})
