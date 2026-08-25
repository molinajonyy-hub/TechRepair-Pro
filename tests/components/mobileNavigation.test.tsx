import { describe, expect, it, vi } from 'vitest'
import { resolveMobilePrimaryNavigation } from '../../src/config/mobileNavigation'
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
      wholesale: { canView: false, canManageClicPortal: false },
    } as NavigationAccess

    expect(isNavigationItemAuthorized({ systemOwnerOnly: true }, access)).toBe(false)
    expect(isNavigationItemAuthorized({ permission: 'personal_finance', systemOwnerAlso: true }, access)).toBe(false)

    // Mutación negativa equivalente: si el gate se redujera a "return true",
    // ambas rutas reaparecerían. Esta aserción hace explícita esa condición.
    const brokenGate = vi.fn(() => true)
    expect(brokenGate()).toBe(true)
    expect(isNavigationItemAuthorized({ systemOwnerOnly: true }, access)).not.toBe(brokenGate())
  })

  it('system_admin puede ver SaaS Admin sin convertirlo en destino primario', () => {
    const access = {
      can: () => false,
      hasFeature: () => false,
      isSystemOwner: true,
      mayoristaEnabled: false,
      wholesale: { canView: false, canManageClicPortal: false },
    } as NavigationAccess

    expect(isNavigationItemAuthorized({ systemOwnerOnly: true }, access)).toBe(true)
    expect(labelsFor(ROLE_DEFAULT_PERMISSIONS.viewer, false)).not.toContain('SaaS Admin')
  })
})
