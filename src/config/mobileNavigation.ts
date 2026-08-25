import type { PermissionKey } from './permissions'
import type { PlanFeature } from './planFeatures'

export type MobileDestinationKey = 'home' | 'orders' | 'pos' | 'customers' | 'tasks' | 'cash' | 'more'

export interface MobileDestination {
  key: MobileDestinationKey
  label: string
  path?: string
}

export interface MobileNavigationCapabilities {
  can: (permission: PermissionKey) => boolean
  hasFeature: (feature: PlanFeature) => boolean
}

const HOME: MobileDestination = { key: 'home', label: 'Inicio', path: '/dashboard' }
const MORE: MobileDestination = { key: 'more', label: 'Más' }

/**
 * Selección contractual para beta. Se priorizan destinos por capacidades
 * efectivas, nunca por role. Se reservan Inicio + Más y como máximo tres
 * módulos operativos, por lo que el resultado nunca supera cinco ítems.
 */
export function resolveMobilePrimaryNavigation(
  capabilities: MobileNavigationCapabilities,
): MobileDestination[] {
  const { can, hasFeature } = capabilities
  const isCashOperationProfile = can('finance') && can('comprobantes') && !can('inventory')

  const candidates: Array<MobileDestination & { priority: number; available: boolean }> = [
    {
      key: 'orders', label: 'Órdenes', path: '/orders',
      priority: isCashOperationProfile ? 70 : 100,
      available: can('orders'),
    },
    {
      key: 'pos', label: 'POS', path: '/comprobantes',
      priority: 95,
      available: can('comprobantes'),
    },
    {
      key: 'cash', label: 'Caja', path: '/caja',
      priority: isCashOperationProfile ? 92 : 50,
      available: can('finance'),
    },
    {
      key: 'tasks', label: 'Tareas', path: '/tasks',
      priority: can('comprobantes') ? 55 : 90,
      // Tasks todavía no tiene capability propia. El contrato vigente de la
      // ruta combina feature del plan con acceso operativo a órdenes.
      available: can('orders') && hasFeature('tasks'),
    },
    {
      key: 'customers', label: 'Clientes', path: '/customers',
      priority: 85,
      available: can('customers'),
    },
  ]

  const primary = candidates
    .filter(item => item.available)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 3)
    .map(({ priority: _priority, available: _available, ...item }) => item)

  return [HOME, ...primary, MORE]
}

export function mobilePrimaryPaths(destinations: MobileDestination[]): string[] {
  return destinations.flatMap(destination => destination.path ? [destination.path] : [])
}
