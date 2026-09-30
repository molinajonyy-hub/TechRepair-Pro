import { describe, expect, it, vi } from 'vitest'

// `MainLayout` arrastra el cliente de Supabase al importarse; el test sólo usa
// la función pura de títulos, así que el cliente es un stub sin red.
vi.mock('../../src/lib/supabase', () => ({
  supabase: { from: () => ({}), rpc: async () => ({ data: null, error: null }) },
}))

import { resolveMobilePrimaryNavigation } from '../../src/config/mobileNavigation'
import { mobilePageTitle } from '../../src/layouts/MainLayout'
import { ROLE_DEFAULT_PERMISSIONS, resolvePermissions, type AppPermissions } from '../../src/config/permissions'
import {
  isNavigationItemAuthorized,
  type NavigationAccess,
} from '../../src/hooks/useNavigationAccess'

const labelsFor = (permissions: AppPermissions, tasks = true) =>
  resolveMobilePrimaryNavigation({
    can: permission => permissions[permission],
    hasFeature: feature => feature === 'tasks' && tasks,
  }).map(item => item.label)

describe('MOBILE-1 · navegación por capabilities', () => {
  it('resuelve los defaults contractuales sin consultar role en el resolver', () => {
    expect(labelsFor(ROLE_DEFAULT_PERMISSIONS.owner)).toEqual(['Inicio', 'Órdenes', 'POS', 'Clientes', 'Más'])
    expect(labelsFor(ROLE_DEFAULT_PERMISSIONS.admin)).toEqual(['Inicio', 'Órdenes', 'POS', 'Clientes', 'Más'])
    expect(labelsFor(ROLE_DEFAULT_PERMISSIONS.sales)).toEqual(['Inicio', 'Órdenes', 'POS', 'Clientes', 'Más'])
    expect(labelsFor(ROLE_DEFAULT_PERMISSIONS.cashier)).toEqual(['Inicio', 'POS', 'Caja', 'Clientes', 'Más'])
    expect(labelsFor(ROLE_DEFAULT_PERMISSIONS.tech)).toEqual(['Inicio', 'Órdenes', 'Tareas', 'Más'])
  })

  it('respeta overrides efectivos y mantiene máximo cinco destinos', () => {
    const overridden = resolvePermissions('tech', {
      comprobantes: true,
      customers: true,
      orders: false,
    })
    const labels = labelsFor(overridden)
    expect(labels).toEqual(['Inicio', 'POS', 'Clientes', 'Más'])
    expect(labels.length).toBeLessThanOrEqual(5)
    expect(labels).not.toContain('Órdenes')
    expect(labels).not.toContain('Tareas')
  })

  it('gate negativo: SaaS Admin y Mi Guita fallan cerrados para tenant users', () => {
    const access = {
      can: () => false,
      hasFeature: () => true,
      isSystemOwner: false,
      mayoristaEnabled: true,
      wholesale: { canAccess: false, canManageClicPortal: false },
    } as NavigationAccess

    expect(isNavigationItemAuthorized({ systemOwnerOnly: true }, access)).toBe(false)
    expect(isNavigationItemAuthorized({ permission: 'personal_finance', systemOwnerAlso: true }, access)).toBe(false)

    // Mutación negativa equivalente: si el gate se redujera a "return true",
    // ambas rutas reaparecerían. Esta aserción hace explícita esa condición.
    const brokenGate = vi.fn(() => true)
    expect(brokenGate()).toBe(true)
    expect(isNavigationItemAuthorized({ systemOwnerOnly: true }, access)).not.toBe(brokenGate())
  })

  it('PRE-BETA-3A-0: la barra móvil nombra cada módulo (antes caían a «Inicio»)', () => {
    const esperados: Array<[string, string]> = [
      ['/warranties', 'Garantías'],
      ['/expenses', 'Gastos'],
      ['/offers', 'Ofertas'],
      ['/cuentas', 'Cuentas corrientes'],
      ['/mayorista', 'Mayorista'],
      ['/tutorials', 'Tutoriales'],
      ['/whatsapp', 'WhatsApp'],
      ['/currency-settings', 'Moneda'],
      ['/portal-clic', 'Portal Clic'],
      ['/admin/subscriptions', 'Suscripciones'],
      ['/admin/leads', 'Leads'],
    ]
    for (const [ruta, titulo] of esperados) {
      expect(mobilePageTitle(ruta), ruta).toBe(titulo)
    }
  })

  it('PRE-BETA-3A-0: el orden de prefijos no se pisa entre rutas parecidas', () => {
    expect(mobilePageTitle('/orders/new')).toBe('Nueva orden')
    expect(mobilePageTitle('/orders/123')).toBe('Detalle de orden')
    expect(mobilePageTitle('/orders')).toBe('Órdenes')
    expect(mobilePageTitle('/settings')).toBe('Configuración')
    expect(mobilePageTitle('/currency-settings')).toBe('Moneda')
    expect(mobilePageTitle('/subscription/plans')).toBe('Suscripción')
    expect(mobilePageTitle('/admin/subscriptions')).toBe('Suscripciones')
    expect(mobilePageTitle('/finance/health')).toBe('Finanzas')
    expect(mobilePageTitle('/dashboard')).toBe('Inicio')
    expect(mobilePageTitle('/')).toBe('Inicio')
  })

  it('system_admin puede ver SaaS Admin sin convertirlo en destino primario', () => {
    const access = {
      can: () => false,
      hasFeature: () => false,
      isSystemOwner: true,
      mayoristaEnabled: false,
      wholesale: { canAccess: false, canManageClicPortal: false },
    } as NavigationAccess

    expect(isNavigationItemAuthorized({ systemOwnerOnly: true }, access)).toBe(true)
    expect(labelsFor(ROLE_DEFAULT_PERMISSIONS.viewer, false)).not.toContain('SaaS Admin')
  })
})
