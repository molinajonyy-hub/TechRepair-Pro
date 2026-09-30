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
//   C. Portal Clic no se concede por Full / Mayorista / wholesale + GAP.
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
  /** Fila de `businesses` que ve `useWholesalePermissions` (Portal Clic). */
  biz: { owner_user_id: null as string | null, wholesale_portal_enabled: false },
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
      rpc: async () => ({ data: null, error: null }),
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

  it('App.tsx: /mayorista va SOLO por el guard central y /portal-clic NO cuelga de él', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const app = readFileSync(join(here, '../../src/App.tsx'), 'utf8')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    const bloqueMayorista = app.match(/<Route element=\{<ProtectedRouteByWholesaleAccess \/>\}>([\s\S]*?)<\/Route>/)
    expect(bloqueMayorista?.[1]).toContain('path="/mayorista"')
    expect(bloqueMayorista?.[1]).not.toContain('/portal-clic')
    // El par viejo ya no gobierna /mayorista.
    const viejo = app.match(/<Route element=\{<ProtectedRouteByPermission permission="wholesale" \/>\}>([\s\S]*?)<\/Route>\s*<\/Route>/)
    expect(viejo?.[1] ?? '').not.toContain('path="/mayorista"')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('C · Portal Clic no es Mayorista', () => {
  let nav: NavigationAccess | null = null
  function NavProbe() { nav = useNavigationAccess(); return null }

  async function portalVisible(): Promise<boolean> {
    nav = null
    render(<NavProbe />)
    await waitFor(() => expect(nav?.wholesale.loading).toBe(false))
    return isNavigationItemAuthorized({ clicPortalManage: true }, nav!)
  }

  it('owner Full con acceso Mayorista completo, sin portal habilitado → NO', async () => {
    as(actor('owner'), FULL)
    state.biz = { owner_user_id: USER_ID, wholesale_portal_enabled: false }
    expect(await portalVisible()).toBe(false)
    expect(nav!.wholesale.canAccess).toBe(true)
  })

  it('manager con wholesale en un negocio Full CON portal habilitado → NO (no es el owner real)', async () => {
    as(actor('manager', { wholesale: true }), FULL)
    state.biz = { owner_user_id: '99999999-9999-4999-8999-999999999999', wholesale_portal_enabled: true }
    expect(await portalVisible()).toBe(false)
    expect(nav!.wholesale.canAccess).toBe(true)
  })

  it('admin con acceso automático, portal habilitado → NO (no es el owner real)', async () => {
    as(actor('admin'), FULL)
    state.biz = { owner_user_id: '99999999-9999-4999-8999-999999999999', wholesale_portal_enabled: true }
    expect(await portalVisible()).toBe(false)
  })

  // GAP (reportado, no resuelto en PRE-BETA-3A-2): hoy NO existe una autoridad
  // server-backed que identifique UNA cuenta interna. Estos dos tests prueban el
  // gap tal cual está; se reemplazan cuando exista esa autoridad.
  it('GAP: cualquier owner real con el portal habilitado lo ve — no hay identidad interna', async () => {
    as(actor('owner'), BASICO) // ni siquiera depende del plan
    state.biz = { owner_user_id: USER_ID, wholesale_portal_enabled: true }
    expect(await portalVisible()).toBe(true)
  })

  it('GAP: `system_admins` no es "sólo mi cuenta" — admite varios usuarios y roles, y cualquier fila activa es system owner', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const hook = readFileSync(join(here, '../../src/hooks/useSystemOwner.ts'), 'utf8')
    const baseline = readFileSync(join(here, '../../supabase/migrations/20260628190324_remote_baseline.sql'), 'utf8')
    // El hook sólo mira user_id + is_active: no filtra rol ni identidad.
    expect(hook).toMatch(/\.from\('system_admins'\)/)
    expect(hook).toMatch(/\.eq\('is_active', true\)/)
    expect(hook).not.toMatch(/\.eq\('role'/)
    // La tabla modela VARIOS administradores con TRES roles y una RPC para sumar más.
    expect(baseline).toMatch(/"system_admins_role_chk" CHECK \(\("role" = ANY \(ARRAY\['super_admin'::"text", 'billing_admin'::"text", 'support_readonly'::"text"\]\)\)\)/)
    expect(baseline).toMatch(/CREATE OR REPLACE FUNCTION "public"\."admin_grant_role"/)
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
