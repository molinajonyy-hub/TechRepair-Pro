// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-3A-2 · Autoridad central de Mayorista (contrato de producto).
//
//   acceso = feature `mayorista` (Pro+, trial incluido)
//            Y (owner | admin | capacidad `wholesale` efectiva)
//
// Corren de verdad: `useWholesaleAccess`, `usePermissions` (defaults del rol +
// overrides), `resolveEntitlement`, `useNavigationAccess` (+ `useSystemOwner`),
// el guard `ProtectedRouteByWholesaleAccess` y la matriz de `UsersManagement`.
// Se simulan la sesión (`useAuth`), el snapshot de suscripción y el borde
// `src/lib/supabase`.
//
//   A. Hook: plan, roles, overrides y fail-closed.
//   B. Ruta y navegación deciden LO MISMO (misma autoridad).
//   C. Portal Clic: autoridad interna server-side (PRE-BETA-3A-2S); no se
//      concede por owner / Full / wholesale / system_admin / portal encendido.
//   D. Matriz de permisos: `wholesale` bloqueado para admin, editable para el resto.
// ─────────────────────────────────────────────────────────────────────────────
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Plan = { subscription_status: string; subscription_plan: string | null }
type Actor = {
  user: { id: string }
  businessId: string
  role: string
  isOwner: boolean
  isAdmin: boolean
  hasBusinessAccess: boolean
  loading: boolean
  profileLoading: boolean
  profile: { id: string; permissions: unknown }
}

const USER_ID = '11111111-1111-4111-8111-111111111111'

const state = vi.hoisted(() => ({
  actor: null as unknown as Actor,
  /** `null` = suscripción sin confirmar (falló la lectura). */
  plan: null as Plan | null,
  subLoading: false,
  /** Fila de `businesses` (owner / flag del portal): NO debe decidir Portal Clic. */
  biz: { owner_user_id: null as string | null, wholesale_portal_enabled: false },
  /** Respuesta de la autoridad interna (public.current_user_has_internal_tool_access); null = error. */
  principal: false as boolean | null,
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  mayoristaEnabled: true,
  systemAdmin: false,
  users: [] as Record<string, unknown>[],
  updatePermissions: vi.fn(),
}))

vi.mock('../../src/contexts/AuthContext', () => ({ useAuth: () => state.actor }))
vi.mock('../../src/hooks/useSubscription', async () => {
  const { resolveEntitlement } = await vi.importActual<typeof import('../../src/lib/entitlements')>('../../src/lib/entitlements')
  type Input = Parameters<typeof resolveEntitlement>[0]
  return {
    useSubscription: () => {
      const r = resolveEntitlement((state.plan ?? { subscription_status: null, subscription_plan: null }) as Input)
      return {
        hasFeature: r.hasFeature,
        subscription: state.plan,
        loading: state.subLoading,
        currentPlan: r.currentPlan,
        isTrial: r.effectiveStatus === 'trialing',
      }
    },
  }
})
vi.mock('../../src/lib/supabase', () => {
  const chain = (table: string): Record<string, unknown> => {
    const c: Record<string, unknown> = {
      select: () => c, eq: () => c, gt: () => c, in: () => c, limit: () => c,
      order: async () => ({ data: [], error: null }),
      maybeSingle: async () => {
        if (table === 'businesses') return { data: state.biz, error: null }
        if (table === 'business_settings') return { data: { mayorista_enabled: state.mayoristaEnabled }, error: null }
        if (table === 'system_admins') return { data: state.systemAdmin ? { user_id: USER_ID, is_active: true } : null, error: null }
        return { data: null, error: null }
      },
    }
    return c
  }
  return {
    supabase: {
      from: (table: string) => chain(table),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        state.rpcs.push({ fn, args })
        if (fn === 'current_user_has_internal_tool_access') {
          return state.principal === null
            ? { data: null, error: { message: 'network down' } }
            : { data: state.principal, error: null }
        }
        return { data: null, error: null }
      },
    },
  }
})
vi.mock('../../src/services/usersService', () => ({
  usersService: {
    getBusinessUsers: async () => state.users,
    changeUserRole: async () => {},
    setUserActiveStatus: async () => {},
    updateUserPermissions: state.updatePermissions,
  },
}))

import { useWholesaleAccess, type WholesaleAccess } from '../../src/hooks/useWholesaleAccess'
import { useNavigationAccess, isNavigationItemAuthorized, type NavigationAccess } from '../../src/hooks/useNavigationAccess'
import { ProtectedRouteByWholesaleAccess } from '../../src/components/auth/ProtectedRouteByWholesaleAccess'
import { ProtectedRouteByInternalTool } from '../../src/components/auth/ProtectedRouteByInternalTool'
import { __resetInternalToolAccessCache } from '../../src/hooks/useInternalToolAccess'
import { UsersManagement } from '../../src/pages/UsersManagement'

const FULL: Plan = { subscription_status: 'active', subscription_plan: 'full' }
const PRO: Plan = { subscription_status: 'active', subscription_plan: 'pro' }
const BASICO: Plan = { subscription_status: 'active', subscription_plan: 'basico' }
const TRIAL: Plan = { subscription_status: 'trialing', subscription_plan: null }

function actor(role: string, permissions: unknown = null, over: Partial<Actor> = {}): Actor {
  return {
    user: { id: USER_ID },
    businessId: 'biz-1',
    role,
    isOwner: role === 'owner',
    isAdmin: role === 'admin',
    hasBusinessAccess: true,
    loading: false,
    profileLoading: false,
    profile: { id: USER_ID, permissions },
    ...over,
  }
}

function as(a: Actor, plan: Plan | null) {
  state.actor = a
  state.plan = plan
}

beforeEach(() => {
  as(actor('owner'), FULL)
  state.subLoading = false
  state.biz = { owner_user_id: null, wholesale_portal_enabled: false }
  state.principal = false
  state.rpcs = []
  __resetInternalToolAccessCache()
  state.mayoristaEnabled = true
  state.systemAdmin = false
  state.users = []
  state.updatePermissions.mockReset().mockResolvedValue(undefined)
})

function readAccess(): WholesaleAccess {
  let captured: WholesaleAccess | null = null
  function Probe() { captured = useWholesaleAccess(); return null }
  render(<Probe />)
  return captured!
}

// ═══════════════════════════════════════════════════════════════════════════
describe('A · autoridad central (hook real)', () => {
  const CASES: Array<{ name: string; actor: Actor; plan: Plan | null; allowed: boolean }> = [
    // PLAN
    { name: 'Básico + owner', actor: actor('owner'), plan: BASICO, allowed: false },
    { name: 'Pro + owner', actor: actor('owner'), plan: PRO, allowed: true },
    { name: 'Full + owner', actor: actor('owner'), plan: FULL, allowed: true },
    { name: 'trial + owner (hereda Pro)', actor: actor('owner'), plan: TRIAL, allowed: true },
    // ROLES
    { name: 'Pro + admin', actor: actor('admin'), plan: PRO, allowed: true },
    { name: 'Pro + manager sin permiso', actor: actor('manager'), plan: PRO, allowed: false },
    { name: 'Pro + manager con wholesale', actor: actor('manager', { wholesale: true }), plan: PRO, allowed: true },
    { name: 'Pro + sales sin permiso', actor: actor('sales'), plan: PRO, allowed: false },
    { name: 'Pro + sales con wholesale', actor: actor('sales', { wholesale: true }), plan: PRO, allowed: true },
    { name: 'Pro + tech sin permiso', actor: actor('tech'), plan: PRO, allowed: false },
    { name: 'Pro + cashier sin permiso', actor: actor('cashier'), plan: PRO, allowed: false },
    { name: 'Pro + viewer sin permiso', actor: actor('viewer'), plan: PRO, allowed: false },
    { name: 'Pro + viewer con wholesale', actor: actor('viewer', { wholesale: true }), plan: PRO, allowed: true },
    // OVERRIDE
    { name: 'Pro + owner con wholesale=false', actor: actor('owner', { wholesale: false }), plan: PRO, allowed: true },
    { name: 'Pro + admin con wholesale=false', actor: actor('admin', { wholesale: false }), plan: PRO, allowed: true },
    { name: 'Full + manager con wholesale=false', actor: actor('manager', { wholesale: false }), plan: FULL, allowed: false },
    { name: 'Full + tech con wholesale=false', actor: actor('tech', { wholesale: false }), plan: FULL, allowed: false },
  ]

  for (const c of CASES) {
    it(`${c.name} → ${c.allowed ? 'accede' : 'NO accede'}`, () => {
      as(c.actor, c.plan)
      expect(readAccess().canAccess).toBe(c.allowed)
    })
  }

  it('fail-closed mientras la suscripción carga (el trial optimista ya trae Mayorista)', () => {
    as(actor('owner'), null)
    state.subLoading = true
    const access = readAccess()
    expect(access.loading).toBe(true)
    expect(access.hasMayoristaFeature).toBe(false)
    expect(access.canAccess).toBe(false)
  })

  it('fail-closed si la suscripción no se pudo leer (sin datos confirmados)', () => {
    as(actor('owner'), null)
    const access = readAccess()
    expect(access.loading).toBe(false)
    expect(access.canAccess).toBe(false)
  })

  it('fail-closed mientras el perfil carga', () => {
    as(actor('owner', null, { profileLoading: true }), PRO)
    expect(readAccess().canAccess).toBe(false)
  })

  it('escritura vs. lectura dentro del acceso sigue el rol (espeja can_manage_wholesale)', () => {
    as(actor('manager', { wholesale: true }), PRO)
    expect(readAccess()).toMatchObject({ canAccess: true, canManage: true, isReadOnly: false })
    as(actor('tech', { wholesale: true }), PRO)
    expect(readAccess()).toMatchObject({ canAccess: true, canManage: false, isReadOnly: true })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('B · ruta y navegación usan el MISMO contrato', () => {
  let nav: NavigationAccess | null = null
  function NavProbe() { nav = useNavigationAccess(); return null }

  async function outcome(): Promise<{ route: 'allowed' | 'paywall' | 'denied'; menu: boolean }> {
    nav = null
    render(
      <MemoryRouter initialEntries={['/mayorista']}>
        <NavProbe />
        <Routes>
          <Route element={<ProtectedRouteByWholesaleAccess />}>
            <Route path="/mayorista" element={<div data-testid="mayorista">MAYORISTA</div>} />
          </Route>
          <Route path="/dashboard" element={<div data-testid="dashboard">DASHBOARD</div>} />
        </Routes>
      </MemoryRouter>,
    )
    // El menú espera la carga de Portal Clic/negocio; la ruta no depende de eso.
    await waitFor(() => expect(nav?.wholesale.loading).toBe(false))
    const route = screen.queryByTestId('mayorista')
      ? 'allowed'
      : screen.queryByTestId('dashboard') ? 'denied' : 'paywall'
    return { route, menu: isNavigationItemAuthorized({ wholesaleView: true }, nav!) }
  }

  const MATRIX: Array<{ name: string; actor: Actor; plan: Plan; route: 'allowed' | 'paywall' | 'denied' }> = [
    { name: 'Pro + owner', actor: actor('owner'), plan: PRO, route: 'allowed' },
    { name: 'Pro + admin con wholesale=false', actor: actor('admin', { wholesale: false }), plan: PRO, route: 'allowed' },
    { name: 'Pro + manager sin permiso', actor: actor('manager'), plan: PRO, route: 'denied' },
    { name: 'Pro + sales con wholesale', actor: actor('sales', { wholesale: true }), plan: PRO, route: 'allowed' },
    { name: 'Full + tech sin permiso', actor: actor('tech'), plan: FULL, route: 'denied' },
    { name: 'trial + owner', actor: actor('owner'), plan: TRIAL, route: 'allowed' },
    { name: 'Básico + owner', actor: actor('owner'), plan: BASICO, route: 'paywall' },
    // Sin la capacidad, ni paywall: no se le ofrece un upgrade que no puede comprar.
    { name: 'Básico + manager sin permiso', actor: actor('manager'), plan: BASICO, route: 'denied' },
  ]

  for (const c of MATRIX) {
    it(`${c.name}: ruta ${c.route} ⇔ menú ${c.route === 'allowed' ? 'visible' : 'oculto'}`, async () => {
      as(c.actor, c.plan)
      const got = await outcome()
      expect(got.route).toBe(c.route)
      expect(got.menu).toBe(c.route === 'allowed')
      if (c.route === 'paywall') {
        expect(screen.getByText('Módulo mayorista')).toBeInTheDocument()
        // El copy del upgrade refleja Pro+ (FEATURE_REQUIRED_PLAN).
        expect(screen.getByText('Pro')).toBeInTheDocument()
      }
    })
  }

  it('`mayorista_enabled` sólo oculta el menú: es preferencia, no autorización', async () => {
    as(actor('owner'), PRO)
    state.mayoristaEnabled = false
    const got = await outcome()
    expect(got.route).toBe('allowed')
    await waitFor(() => expect(nav?.mayoristaEnabled).toBe(false))
    expect(isNavigationItemAuthorized({ wholesaleView: true }, nav!)).toBe(false)
  })

  it('App.tsx: /mayorista va SOLO por el guard central y /portal-clic por la autoridad interna', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const app = readFileSync(join(here, '../../src/App.tsx'), 'utf8')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    const bloqueMayorista = app.match(/<Route element=\{<ProtectedRouteByWholesaleAccess \/>\}>([\s\S]*?)<\/Route>/)
    expect(bloqueMayorista?.[1]).toContain('path="/mayorista"')
    expect(bloqueMayorista?.[1]).not.toContain('/portal-clic')
    const bloqueClic = app.match(/<Route element=\{<ProtectedRouteByInternalTool tool="portal_clic" \/>\}>([\s\S]*?)<\/Route>/)
    expect(bloqueClic?.[1]).toContain('path="/portal-clic"')
    // Ningún guard de permiso/feature/system owner gobierna /mayorista ni /portal-clic.
    expect(app).not.toMatch(/ProtectedRouteByPermission permission="wholesale"/)
    expect(app).not.toMatch(/ProtectedRouteByFeature feature="mayorista"/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('C · Portal Clic: autoridad interna server-side', () => {
  let nav: NavigationAccess | null = null
  function NavProbe() { nav = useNavigationAccess(); return null }

  async function portal(): Promise<{ menu: boolean; ruta: boolean }> {
    nav = null
    render(
      <MemoryRouter initialEntries={['/portal-clic']}>
        <NavProbe />
        <Routes>
          <Route element={<ProtectedRouteByInternalTool tool="portal_clic" />}>
            <Route path="/portal-clic" element={<div data-testid="portal-clic">PORTAL CLIC</div>} />
          </Route>
          <Route path="/dashboard" element={<div data-testid="dashboard">DASHBOARD</div>} />
        </Routes>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.queryByTestId('portal-clic') ?? screen.queryByTestId('dashboard')).not.toBeNull())
    await waitFor(() => expect(nav?.wholesale.loading).toBe(false))
    return { menu: isNavigationItemAuthorized({ clicPortalManage: true }, nav!), ruta: !!screen.queryByTestId('portal-clic') }
  }

  const NEGATIVOS: Array<{ name: string; actor: Actor; plan: Plan; biz: { owner_user_id: string | null; wholesale_portal_enabled: boolean }; sys?: boolean }> = [
    { name: 'owner Full, dueño real, portal encendido', actor: actor('owner'), plan: FULL, biz: { owner_user_id: USER_ID, wholesale_portal_enabled: true } },
    { name: 'owner Pro con Mayorista', actor: actor('owner'), plan: PRO, biz: { owner_user_id: USER_ID, wholesale_portal_enabled: true } },
    { name: 'admin con acceso automático', actor: actor('admin'), plan: FULL, biz: { owner_user_id: null, wholesale_portal_enabled: true } },
    { name: 'manager con wholesale', actor: actor('manager', { wholesale: true }), plan: FULL, biz: { owner_user_id: null, wholesale_portal_enabled: true } },
    { name: 'system_admin (super_admin) owner de un Full', actor: actor('owner'), plan: FULL, biz: { owner_user_id: USER_ID, wholesale_portal_enabled: true }, sys: true },
  ]

  for (const c of NEGATIVOS) {
    it(`${c.name}, sin ser el principal → ni menú ni ruta`, async () => {
      as(c.actor, c.plan)
      state.biz = c.biz
      state.systemAdmin = c.sys === true
      state.principal = false
      const got = await portal()
      expect(got).toEqual({ menu: false, ruta: false })
    })
  }

  it('el principal (según la base) entra por menú y ruta aunque el portal esté apagado y el plan sea Básico', async () => {
    as(actor('owner'), BASICO)
    state.biz = { owner_user_id: USER_ID, wholesale_portal_enabled: false }
    state.principal = true
    const got = await portal()
    expect(got).toEqual({ menu: true, ruta: true })
    // La pregunta viaja con la herramienta y el negocio actual, no con identidad hardcodeada.
    const call = state.rpcs.find(r => r.fn === 'current_user_has_internal_tool_access')
    expect(call?.args).toEqual({ p_tool_key: 'portal_clic', p_business_id: 'biz-1' })
  })

  it('si la autoridad interna falla (error de red) → cerrado', async () => {
    as(actor('owner'), FULL)
    state.biz = { owner_user_id: USER_ID, wholesale_portal_enabled: true }
    state.principal = null
    const got = await portal()
    expect(got).toEqual({ menu: false, ruta: false })
  })

  it('el frontend no hardcodea identidad ni slug para Portal Clic', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    // En el menú, la rama de Portal Clic devuelve SOLO la autoridad interna.
    const navSrc = readFileSync(join(here, '../../src/hooks/useNavigationAccess.ts'), 'utf8')
    expect(navSrc).toMatch(/if \(item\.clicPortalManage\) return access\.portalClic\n/)
    for (const rel of ['src/hooks/useInternalToolAccess.ts', 'src/components/auth/ProtectedRouteByInternalTool.tsx',
                       'src/pages/AdminPortalClic.tsx']) {
      // Sin comentarios: los comentarios SÍ nombran lo que ya no decide.
      const src = readFileSync(join(here, '../../', rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      expect(src, rel).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
      expect(src, rel).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i)
      expect(src, rel).not.toMatch(/owner_user_id|wholesale_portal_enabled|system_admins|isSystemOwner/)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('D · matriz de permisos: `wholesale` es automático para admin', () => {
  const member = (id: string, role: string, permissions: Record<string, boolean> | null = null) => ({
    id, user_id: id, business_id: 'biz-1', role, is_active: true,
    full_name: `Usuario ${role}`, email: `${role}@invalid.test`, permissions, created_at: '2026-01-01T00:00:00Z',
  })

  /** El control de la fila es el checkbox (primer hijo del label), no el texto. */
  const checkboxOf = (modal: HTMLElement, label: string) =>
    within(modal).getByText(label).closest('label')!.firstElementChild as HTMLElement

  async function openPermissions(user: ReturnType<typeof member>) {
    state.users = [user]
    render(<MemoryRouter><UsersManagement /></MemoryRouter>)
    fireEvent.click(await screen.findByTitle('Editar permisos'))
    return screen.getByText(`Permisos — ${user.full_name}`).closest('.modal-card') as HTMLElement
  }

  it('admin: Mayorista bloqueado en «sí», y un override viejo `false` se descarta al guardar', async () => {
    as(actor('owner'), PRO)
    const modal = await openPermissions(member('u-admin', 'admin', { wholesale: false }))
    const lock = within(modal).getByTestId('permission-locked-wholesale')
    expect(lock).toHaveTextContent('automático para este rol')

    // Click en el control bloqueado: no cambia nada.
    fireEvent.click(checkboxOf(modal, 'Mayorista'))
    await act(async () => { fireEvent.click(within(modal).getByRole('button', { name: /Guardar/ })) })
    await waitFor(() => expect(state.updatePermissions).toHaveBeenCalledTimes(1))
    const [, diff] = state.updatePermissions.mock.calls[0]
    expect(diff === null || !('wholesale' in diff)).toBe(true)
  })

  it('manager: Mayorista NO viene por defecto y el owner puede habilitarlo', async () => {
    as(actor('owner'), PRO)
    const modal = await openPermissions(member('u-manager', 'manager'))
    expect(within(modal).queryByTestId('permission-locked-wholesale')).not.toBeInTheDocument()

    fireEvent.click(checkboxOf(modal, 'Mayorista'))
    await act(async () => { fireEvent.click(within(modal).getByRole('button', { name: /Guardar/ })) })
    await waitFor(() => expect(state.updatePermissions).toHaveBeenCalledTimes(1))
    expect(state.updatePermissions.mock.calls[0][1]).toEqual({ wholesale: true })
  })
})
